/**
 * LAYER 3 Phase 4 — AI-drafted "how to build it" guide.
 *
 * Claude writes the hand-holding narrative (zoning meaning, which permits are
 * likely needed and why, the step-by-step process, timeline, getting-started
 * checklist), grounded in the real site facts we pass it. It returns structured
 * sections via a forced tool and tags each permit with a `linkKey`; this module
 * resolves those to verified URLs (lib/permitLinks) so no link is invented.
 */
import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env";
import { resolveLink, keyResources, type LinkKey, type ResolvedLink } from "./permitLinks";

const MODEL = "claude-opus-4-8";

export type ReportInput = {
  projectType: string;
  countyName: string | null;
  stateFips: string | null;
  zoningCode: string | null;
  zoningDescription: string | null;
  zoningIsReal: boolean;
  permittedUses: string[] | null;
  acres: number;
  buildingCount: number;
  buildingGrossSqft: number;
  yieldLabel: string | null;
  yieldCount: number | null;
  floodZone: string | null;
  septicSuitability: string | null;
  slopePct: number | null;
  wetlandsOverlap: boolean | null;
  utilities: string; // on_grid | off_grid_partial | off_grid_full
  costLow: number;
  costHigh: number;
  budgetUsd: number | null;
};

export type Permit = { name: string; why: string; whoIssues: string; link: ResolvedLink | null };
export type ReportData = {
  overview: string;
  zoningSummary: string;
  permits: Permit[];
  steps: { step: string; detail: string }[];
  timeline: { phase: string; duration: string; detail: string }[];
  gettingStarted: string[];
  contacts: { who: string; role: string }[];
  resources: ResolvedLink[];
};

const BUILD_TOOL = {
  name: "build_report",
  description:
    "Produce the structured 'how to build it' guide for this specific project and jurisdiction.",
  input_schema: {
    type: "object" as const,
    properties: {
      overview: { type: "string", description: "2-3 plain-English sentences: what the project is and the big picture of getting it built here." },
      zoningSummary: { type: "string", description: "2-4 sentences: what the zoning means for this use, and any obvious entitlement step (e.g. site-plan approval, special-use permit). If zoning is sample data, say so and advise confirming actual zoning." },
      permits: {
        type: "array",
        description: "The permits/approvals this specific project will likely need, tailored to the constraints provided.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "e.g. 'Building permit', 'Floodplain development permit', 'On-site septic permit'." },
            why: { type: "string", description: "One sentence: why THIS project needs it (tie to the data when relevant)." },
            whoIssues: { type: "string", description: "The authority, e.g. 'County building department', 'County health department', 'FEMA-designated local floodplain administrator'." },
            linkKey: { type: "string", enum: ["fema_flood", "state_code", "county_permit", "septic", "none"], description: "Which verified resource to link for this permit." },
          },
          required: ["name", "why", "whoIssues", "linkKey"],
        },
      },
      steps: {
        type: "array",
        description: "The ordered process from raw land to construction (5-8 steps).",
        items: {
          type: "object",
          properties: { step: { type: "string" }, detail: { type: "string", description: "One or two sentences of practical guidance." } },
          required: ["step", "detail"],
        },
      },
      timeline: {
        type: "array",
        description: "Realistic phases with rough durations (e.g. 'Entitlement & design', '3-6 months').",
        items: {
          type: "object",
          properties: { phase: { type: "string" }, duration: { type: "string" }, detail: { type: "string" } },
          required: ["phase", "duration", "detail"],
        },
      },
      gettingStarted: { type: "array", items: { type: "string" }, description: "A short checklist of concrete first actions the owner can take this month." },
      contacts: {
        type: "array",
        description: "Who to call and what for.",
        items: { type: "object", properties: { who: { type: "string" }, role: { type: "string" } }, required: ["who", "role"] },
      },
    },
    required: ["overview", "zoningSummary", "permits", "steps", "timeline", "gettingStarted", "contacts"],
  },
};

function buildSystem(i: ReportInput): string {
  const money = (n: number) => "$" + Math.round(n).toLocaleString();
  const constraints: string[] = [];
  if (i.floodZone && !/^X$/i.test(i.floodZone)) constraints.push(`In FEMA flood zone ${i.floodZone} (special flood hazard) — likely needs floodplain review.`);
  else constraints.push(`Flood zone ${i.floodZone ?? "unknown"} (minimal hazard).`);
  if (i.slopePct != null) constraints.push(`Ground slope ~${i.slopePct}%${i.slopePct > 15 ? " — steep; grading/land-disturbance permit likely" : ""}.`);
  if (i.septicSuitability) constraints.push(`Soil septic suitability: ${i.septicSuitability}.`);
  if (i.utilities !== "on_grid") constraints.push(`Off-grid utilities planned (${i.utilities}) — well/septic and possibly solar.`);
  if (i.wetlandsOverlap) constraints.push("Wetlands present on/near the parcel — possible USACE Section 404 review.");

  return [
    "You write practical, encouraging 'how to build it' guides for non-developer landowners using a site-feasibility tool.",
    "Produce a guide for THIS specific project and location. Plain English, concrete, no jargon dumps. Be realistic but motivating.",
    "",
    "PROJECT:",
    `  - Use: ${i.projectType}; ${i.buildingCount} building(s), ~${Math.round(i.buildingGrossSqft).toLocaleString()} gross sq ft on ${i.acres} acres.`,
    i.yieldCount != null ? `  - Program: ${i.yieldCount} ${i.yieldLabel ?? "units"}.` : "",
    `  - Estimated cost to build: ${money(i.costLow)}–${money(i.costHigh)}${i.budgetUsd ? `; owner budget ~${money(i.budgetUsd)}` : ""}.`,
    "",
    "LOCATION & ZONING:",
    `  - ${i.countyName ?? "County unknown"}.`,
    i.zoningIsReal
      ? `  - Zoning: ${i.zoningCode ?? "?"} (${i.zoningDescription ?? "?"}). Permitted uses: ${(i.permittedUses ?? []).join(", ") || "see jurisdiction"}.`
      : `  - Zoning shown in the tool is SAMPLE data for this parcel — tell the owner to confirm the actual zoning with the county before relying on it.`,
    "",
    "SITE CONSTRAINTS (tailor the permit list to these):",
    ...constraints.map((c) => `  - ${c}`),
    "",
    "RULES:",
    "  - Tailor the permit list to the constraints above (e.g. real flood zone AE/VE → floodplain development permit; steep slope → grading/land-disturbance; off-grid/septic → county health-dept septic & well permits; always a building permit; entitlement/site-plan approval per zoning).",
    "  - For each permit set linkKey to the best verified resource (fema_flood for floodplain; septic for septic/well; county_permit for building/zoning/site-plan; state_code for code questions; none if nothing fits). NEVER write a URL yourself.",
    "  - Timeline phases should be realistic for a small project (entitlement/design, permitting, construction); give ranges.",
    "  - Do NOT invent dollar figures — use only the cost range provided if you mention cost.",
    "  - gettingStarted = concrete first actions (call the county planning dept, order a boundary/topographic survey, line up a civil engineer / architect, etc.).",
    "  - Always call build_report exactly once.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function runReport(input: ReportInput): Promise<ReportData> {
  if (!env.anthropicKey) {
    const err: any = new Error("Anthropic API key not set.");
    err.code = "NO_KEY";
    throw err;
  }
  const client = new Anthropic({ apiKey: env.anthropicKey });

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    system: buildSystem(input),
    tools: [BUILD_TOOL],
    tool_choice: { type: "tool", name: "build_report" },
    messages: [{ role: "user", content: "Write the build guide for this project." }],
  });

  const block = res.content.find((b: any) => b.type === "tool_use") as any;
  const raw = (block?.input || {}) as any;
  const ctx = { countyName: input.countyName, stateFips: input.stateFips };

  const permits: Permit[] = Array.isArray(raw.permits)
    ? raw.permits.map((p: any) => ({
        name: String(p?.name ?? "Permit"),
        why: String(p?.why ?? ""),
        whoIssues: String(p?.whoIssues ?? ""),
        link: resolveLink((["fema_flood", "state_code", "county_permit", "septic", "none"].includes(p?.linkKey) ? p.linkKey : "none") as LinkKey, ctx),
      }))
    : [];

  return {
    overview: String(raw.overview ?? ""),
    zoningSummary: String(raw.zoningSummary ?? ""),
    permits,
    steps: arr(raw.steps).map((s: any) => ({ step: String(s?.step ?? ""), detail: String(s?.detail ?? "") })),
    timeline: arr(raw.timeline).map((t: any) => ({ phase: String(t?.phase ?? ""), duration: String(t?.duration ?? ""), detail: String(t?.detail ?? "") })),
    gettingStarted: arr(raw.gettingStarted).map((s: any) => String(s)).filter(Boolean),
    contacts: arr(raw.contacts).map((c: any) => ({ who: String(c?.who ?? ""), role: String(c?.role ?? "") })),
    resources: keyResources(ctx),
  };
}

function arr(v: any): any[] {
  return Array.isArray(v) ? v : [];
}
