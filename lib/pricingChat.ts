/**
 * LAYER 3 — Phase 3: pricing intake chatbot (Anthropic Claude).
 *
 * Claude runs a short guided interview (5–10 questions) about HOW and WHAT the
 * user wants to build — quality/finish level, structure, site difficulty,
 * utilities, parking, contingency, budget. When it has enough, it calls the
 * `finalize_spec` tool; the server then runs the deterministic cost engine
 * (lib/cost.ts) so the dollars are reproducible, not invented by the model.
 */
import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env";
import { computeCost, type BuildSpec, type ProjectCostInput, type CostEstimate, type QualityTier } from "./cost";
import type { ChatMsg } from "./planChat";

const MODEL = "claude-opus-4-8";

export type PricingContext = {
  slopePct: number | null;
  floodZone: string | null;
  locationLabel: string | null; // e.g. "Dallas County, Texas"
};

const FINALIZE_TOOL = {
  name: "finalize_spec",
  description:
    "Call this ONCE you have enough answers to price the project. Provide the normalized build spec; the system computes the dollar estimate.",
  input_schema: {
    type: "object" as const,
    properties: {
      qualityTier: {
        type: "string",
        enum: ["economy", "standard", "premium", "luxury"],
        description: "Overall finish / quality level.",
      },
      structure: { type: "string", description: "Structure type, e.g. 'wood frame', 'steel', 'modular', 'ICF'." },
      siteDifficulty: { type: "string", enum: ["easy", "moderate", "hard"], description: "Grading/site work difficulty." },
      utilities: {
        type: "string",
        enum: ["on_grid", "off_grid_partial", "off_grid_full"],
        description: "on_grid = utilities at the site; off_grid_partial = some (e.g. septic/well); off_grid_full = power+water+septic all needed.",
      },
      parkingType: { type: "string", enum: ["surface", "structured", "none"], description: "Parking construction type." },
      contingencyPct: { type: "number", description: "Contingency percent (e.g. 10, 15). Default 12 if unsure." },
      budgetUsd: { type: "number", description: "The user's target budget in dollars, if they gave one. Omit if none." },
      materials: { type: "array", items: { type: "string" }, description: "Notable material/finish choices the user mentioned." },
      notes: { type: "string", description: "Any other relevant detail." },
    },
    required: ["qualityTier", "structure", "siteDifficulty", "utilities", "parkingType"],
  },
};

function buildSystem(project: ProjectCostInput, ctx: PricingContext): string {
  return [
    "You are a friendly construction cost-estimating assistant inside a commercial real-estate site-planning tool.",
    "Your job: run a SHORT guided interview — about 5 to 8 questions — to understand HOW and WHAT the user wants to build, then produce a cost estimate.",
    "",
    "THE APPROVED PLAN you're pricing:",
    `  - Use: ${project.projectType}`,
    `  - ${project.buildingCount} building(s), ~${Math.round(project.buildingGrossSqft).toLocaleString()} gross sq ft total`,
    `  - ${project.parkingStalls} parking stalls, ${project.siteAcres} acre site`,
    `  - Location: ${ctx.locationLabel ?? "unknown"}${ctx.slopePct != null ? `, ground slope ~${ctx.slopePct}%` : ""}, flood zone ${ctx.floodZone ?? "unknown"}`,
    "",
    "WHAT TO FIND OUT (one or two short questions per message, conversational, plain language — not a wall of text):",
    "  1. Quality / finish level (basic & budget → high-end / luxury).",
    "  2. Structure type (wood frame, steel, modular, etc.) — suggest a sensible default for this use.",
    "  3. Site work difficulty — you already know slope is ~" + (ctx.slopePct ?? "?") + "%; confirm if the ground is flat & clear or rocky/wooded/steep.",
    "  4. Utilities — are power/water/sewer at the site, or will they need well/septic/solar (off-grid)?",
    "  5. Parking — surface lot, structured deck, or none.",
    "  6. Standout materials or features they care about (roof, siding, finishes).",
    "  7. Their target budget, if they have one.",
    "  8. How much contingency they want to carry (or you suggest ~12%).",
    "",
    "RULES:",
    "  - Ask ONE topic at a time and keep it brief and friendly. Acknowledge their answer, then ask the next.",
    "  - Infer sensible defaults from the project (e.g. cabins → wood frame) and offer them so the user can just confirm.",
    "  - After ~5-8 answers, or whenever the user says 'just estimate' / 'that's enough', CALL finalize_spec with your best normalized spec. Do not keep asking.",
    "  - Never invent dollar figures yourself — the tool computes them.",
    "  - Open by briefly noting what you're pricing, then ask question 1.",
  ].join("\n");
}

export async function runPricingChat(
  messages: ChatMsg[],
  project: ProjectCostInput,
  ctx: PricingContext
): Promise<{ done: boolean; reply: string; estimate?: CostEstimate; spec?: BuildSpec }> {
  if (!env.anthropicKey) {
    const err: any = new Error("Anthropic API key not set.");
    err.code = "NO_KEY";
    throw err;
  }
  const client = new Anthropic({ apiKey: env.anthropicKey });

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: buildSystem(project, ctx),
    tools: [FINALIZE_TOOL],
    tool_choice: { type: "auto" },
    messages: messages
      .filter((m) => m.text?.trim())
      .map((m) => ({ role: m.role, content: m.text })),
  });

  const textBlock = res.content.find((b: any) => b.type === "text") as any;
  const toolBlock = res.content.find((b: any) => b.type === "tool_use") as any;

  if (toolBlock) {
    const spec = normalizeSpec(toolBlock.input || {});
    const estimate = computeCost(project, spec);
    return {
      done: true,
      reply: textBlock?.text?.trim() || "Here's your cost-to-build estimate.",
      estimate,
      spec,
    };
  }
  return { done: false, reply: textBlock?.text?.trim() || "Tell me a bit about how you want to build it." };
}

function normalizeSpec(raw: any): BuildSpec {
  const tiers: QualityTier[] = ["economy", "standard", "premium", "luxury"];
  const qualityTier = tiers.includes(raw?.qualityTier) ? raw.qualityTier : "standard";
  const siteDifficulty = ["easy", "moderate", "hard"].includes(raw?.siteDifficulty) ? raw.siteDifficulty : "moderate";
  const utilities = ["on_grid", "off_grid_partial", "off_grid_full"].includes(raw?.utilities) ? raw.utilities : "on_grid";
  const parkingType = ["surface", "structured", "none"].includes(raw?.parkingType) ? raw.parkingType : "surface";
  const budget = Number(raw?.budgetUsd);
  return {
    qualityTier,
    structure: typeof raw?.structure === "string" ? raw.structure : "wood frame",
    siteDifficulty,
    utilities,
    parkingType,
    contingencyPct: isFinite(Number(raw?.contingencyPct)) ? Number(raw.contingencyPct) : 12,
    budgetUsd: isFinite(budget) && budget > 0 ? budget : null,
    materials: Array.isArray(raw?.materials) ? raw.materials.filter((s: any) => typeof s === "string") : [],
    notes: typeof raw?.notes === "string" ? raw.notes : "",
  };
}
