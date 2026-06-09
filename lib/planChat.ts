/**
 * LAYER 3 — Phase 2: design-studio chatbot (Anthropic Claude).
 *
 * Translates a plain-English request ("add 8 cabins along the north edge, put
 * the lodge by the road") into edit operations on the StudioElements drawn on
 * the aerial photo. Claude works in human-friendly FEET offsets from the parcel
 * centroid; this module converts to/from the canonical lat/lng elements.
 *
 * Uses the official Anthropic SDK with a single forced tool (`apply_plan`) so
 * the model returns validated structured ops, not free-form text we'd parse.
 */
import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env";
import { ftOffsetToLatLng, latLngToFtOffset } from "./geo";
import type { LatLng } from "./types";
import type { StudioElement, StudioElementKind } from "./feasibilityTypes";

export type ChatMsg = { role: "user" | "assistant"; text: string };
export type SiteContext = {
  centroid: LatLng;
  acres: number;
  parcelWidthFt: number;
  parcelHeightFt: number;
  zoning: string | null;
  floodZone: string | null;
  slopePct: number | null;
  projectType: string | null;
};

const MODEL = "claude-opus-4-8";
const MAX_ELEMENTS = 120;
const KINDS: StudioElementKind[] = ["building", "parking", "drive", "open"];
const DEFAULT_SIZE: Record<StudioElementKind, { w: number; h: number }> = {
  building: { w: 50, h: 40 },
  parking: { w: 100, h: 60 },
  drive: { w: 20, h: 120 },
  open: { w: 60, h: 60 },
};

/** The one tool Claude must call: a reply plus a list of edit ops. */
const APPLY_TOOL = {
  name: "apply_plan",
  description:
    "Apply edits to the site plan drawn on the aerial photo. Return a short conversational reply plus an ordered list of operations on the buildings/parking/drives.",
  input_schema: {
    type: "object" as const,
    properties: {
      reply: {
        type: "string",
        description: "One or two friendly sentences telling the user what you changed.",
      },
      ops: {
        type: "array",
        description: "Edit operations, applied in order.",
        items: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: ["add", "move", "resize", "delete", "clear"],
              description:
                "add = new shape; move = reposition an existing shape by id; resize = change size by id; delete = remove by id; clear = remove everything.",
            },
            id: { type: "string", description: "Existing element id (for move/resize/delete)." },
            kind: {
              type: "string",
              enum: ["building", "parking", "drive", "open"],
              description: "For add: what kind of shape.",
            },
            label: { type: "string", description: "For add: a short label, e.g. 'Lodge' or 'Cabin 3'." },
            eastFt: {
              type: "number",
              description: "Center east(+)/west(-) of the parcel center, in feet (for add/move).",
            },
            northFt: {
              type: "number",
              description: "Center north(+)/south(-) of the parcel center, in feet (for add/move).",
            },
            widthFt: { type: "number", description: "Width east-west, feet (for add/resize)." },
            heightFt: { type: "number", description: "Depth north-south, feet (for add/resize)." },
          },
          required: ["op"],
        },
      },
    },
    required: ["reply", "ops"],
  },
};

function buildSystem(site: SiteContext, elements: StudioElement[]): string {
  const halfW = Math.round(site.parcelWidthFt / 2);
  const halfH = Math.round(site.parcelHeightFt / 2);
  const current = elements.length
    ? elements
        .map((e) => {
          const o = latLngToFtOffset(site.centroid, e.center);
          return `  - id="${e.id}" ${e.kind} "${e.label}" center(E${Math.round(o.eastFt)},N${Math.round(
            o.northFt
          )}) size ${e.widthFt}x${e.heightFt}ft`;
        })
        .join("\n")
    : "  (none yet)";

  return [
    "You are the design assistant for a commercial real-estate site-planning tool.",
    "The user is shaping a schematic site plan drawn on an aerial photo of their parcel.",
    "You place and edit simple rectangles: buildings, parking, drives, open space.",
    "",
    "COORDINATE SYSTEM: positions are FEET from the parcel center (0,0).",
    "East is +eastFt, west is negative; north is +northFt, south is negative.",
    `The parcel spans roughly ${site.parcelWidthFt} ft east-west by ${site.parcelHeightFt} ft north-south,`,
    `so keep shape CENTERS within about E/W ±${halfW} ft and N/S ±${halfH} ft, with a margin from the edges for setbacks.`,
    "",
    "SITE FACTS:",
    `  - Size: ${site.acres} acres${site.projectType ? `, intended use: ${site.projectType}` : ""}`,
    `  - Zoning: ${site.zoning ?? "unknown"}`,
    `  - Flood zone: ${site.floodZone ?? "unknown"}${site.slopePct != null ? `, slope ~${site.slopePct}%` : ""}`,
    "",
    "CURRENT ELEMENTS ON THE PLAN:",
    current,
    "",
    "GUIDELINES:",
    "  - Reasonable sizes: cabin ~26x26 ft, house ~50x40, lodge/clubhouse ~80x60, hotel/apartment footprint ~120x70, parking lot sized to need, drive ~20 ft wide.",
    "  - To edit an existing shape, reference its exact id with move/resize/delete. To add, use 'add' with a kind.",
    "  - Lay groups out tidily (rows, clusters) and keep everything inside the parcel.",
    "  - Only change what the user asked for; don't clear unless they ask to start over.",
    "  - Always call apply_plan exactly once with a brief reply and the ops.",
  ].join("\n");
}

function clampSize(n: number | undefined, fallback: number): number {
  const v = typeof n === "number" && isFinite(n) ? n : fallback;
  return Math.max(6, Math.min(3000, Math.round(v)));
}

function applyOps(
  elements: StudioElement[],
  ops: any[],
  centroid: LatLng
): StudioElement[] {
  let out = elements.map((e) => ({ ...e }));
  let added = 0;
  for (const op of Array.isArray(ops) ? ops.slice(0, 200) : []) {
    const kind: string = op?.op;
    if (kind === "clear") {
      out = [];
      continue;
    }
    if (kind === "add") {
      if (out.length >= MAX_ELEMENTS) continue;
      const k: StudioElementKind = KINDS.includes(op?.kind) ? op.kind : "building";
      const d = DEFAULT_SIZE[k];
      out.push({
        id: `chat-${added++}-${Math.floor(Math.random() * 1e6)}`,
        kind: k,
        label: typeof op?.label === "string" && op.label.trim() ? op.label.trim() : capitalize(k),
        center: ftOffsetToLatLng(centroid, num(op?.eastFt), num(op?.northFt)),
        widthFt: clampSize(op?.widthFt, d.w),
        heightFt: clampSize(op?.heightFt, d.h),
        rotationDeg: 0,
        floors: k === "building" ? 1 : undefined,
      });
      continue;
    }
    const idx = out.findIndex((e) => e.id === op?.id);
    if (idx < 0) continue;
    if (kind === "delete") {
      out.splice(idx, 1);
    } else if (kind === "move") {
      out[idx] = { ...out[idx], center: ftOffsetToLatLng(centroid, num(op?.eastFt), num(op?.northFt)) };
    } else if (kind === "resize") {
      out[idx] = {
        ...out[idx],
        widthFt: clampSize(op?.widthFt, out[idx].widthFt),
        heightFt: clampSize(op?.heightFt, out[idx].heightFt),
      };
    }
  }
  return out;
}

export async function runPlanChat(
  messages: ChatMsg[],
  site: SiteContext,
  elements: StudioElement[]
): Promise<{ reply: string; elements: StudioElement[] }> {
  if (!env.anthropicKey) {
    const err: any = new Error("Anthropic API key not set.");
    err.code = "NO_KEY";
    throw err;
  }
  const client = new Anthropic({ apiKey: env.anthropicKey });

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: buildSystem(site, elements),
    tools: [APPLY_TOOL],
    tool_choice: { type: "tool", name: "apply_plan" },
    messages: messages
      .filter((m) => m.text?.trim())
      .map((m) => ({ role: m.role, content: m.text })),
  });

  const toolBlock = res.content.find((b: any) => b.type === "tool_use") as any;
  if (!toolBlock) return { reply: "Sorry — I couldn't update the plan. Try rephrasing?", elements };
  const input = (toolBlock.input || {}) as { reply?: string; ops?: any[] };
  return {
    reply: input.reply?.trim() || "Updated the plan.",
    elements: applyOps(elements, input.ops || [], site.centroid),
  };
}

function num(v: any): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
