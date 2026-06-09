/**
 * ─────────────────────────────────────────────────────────────────────────
 * LAYER 2 — Feasibility + Site Plan contract.
 * ─────────────────────────────────────────────────────────────────────────
 * Consumes a frozen Site Profile (v1.0.0) + a user goal and produces:
 *   • a buildable ENVELOPE (what zoning + site constraints actually allow),
 *   • a PROGRAM (what fits — unit/key counts, footprints, parking),
 *   • a high-level overhead SITE PLAN (SVG massing).
 *
 * Everything here is DERIVED and deterministic: same Site Profile + same
 * goal + same assumptions → same result. The `assumptions` array makes every
 * number traceable, which matters because this feeds an investment decision.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { z } from "zod";
import { LatLngSchema } from "./types";

export const FEASIBILITY_VERSION = "1.0.0" as const;

/** What the user wants to do with the site. */
export const ProjectTypeEnum = z.enum([
  "retreat",
  "hotel",
  "multifamily",
  "single_family",
  "retail",
  "mixed_use",
]);
export type ProjectType = z.infer<typeof ProjectTypeEnum>;

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  retreat: "Retreat / lodge + cabins",
  hotel: "Hotel",
  multifamily: "Multifamily housing",
  single_family: "Single-family subdivision",
  retail: "Retail / commercial",
  mixed_use: "Mixed use",
};

/** Optional knobs the user can override; otherwise type defaults apply. */
export const ProjectParamsSchema = z.object({
  /** Force a floor count instead of deriving from FAR. */
  floors: z.number().int().min(1).max(40).optional(),
  /** 0–1. Share of net developable land covered by building footprint. */
  coverageRatio: z.number().min(0.02).max(0.9).optional(),
});
export type ProjectParams = z.infer<typeof ProjectParamsSchema>;

/* ── Buildable envelope ─────────────────────────────────────────────────── */
export const EnvelopeSchema = z.object({
  grossAcres: z.number(),
  grossSqft: z.number(),
  /** Land removed by each constraint, in acres, with why. */
  deductions: z.array(
    z.object({
      reason: z.string(),
      acres: z.number(),
      source: z.string(),
    })
  ),
  netDevelopableAcres: z.number(),
  /** Setback-limited footprint envelope (sqft). */
  setbackEnvelopeSqft: z.number(),
  maxFloorAreaByFAR: z.number(),
  footprintCapSqft: z.number(),
  floors: z.number(),
  buildableGsf: z.number(), // gross sq ft the program can use
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

/* ── Program ────────────────────────────────────────────────────────────── */
export const BuildingSchema = z.object({
  label: z.string(),
  count: z.number(),
  footprintSqft: z.number(),
  floors: z.number(),
});
export type Building = z.infer<typeof BuildingSchema>;

export const ProgramSchema = z.object({
  projectType: ProjectTypeEnum,
  /** Headline yield: keys for hotel, units for housing, lots for SFD, etc. */
  yieldLabel: z.string(),
  yieldCount: z.number(),
  buildings: z.array(BuildingSchema),
  parkingStalls: z.number(),
  openSpaceSqft: z.number(),
  /** Every assumption that produced these numbers, in plain language. */
  assumptions: z.array(z.string()),
});
export type Program = z.infer<typeof ProgramSchema>;

/* ── Studio element (Layer 3: editable plan overlay on the aerial photo) ──── */
export const StudioElementKindEnum = z.enum(["building", "parking", "drive", "open"]);
export type StudioElementKind = z.infer<typeof StudioElementKindEnum>;

export const StudioElementSchema = z.object({
  id: z.string(),
  kind: StudioElementKindEnum,
  label: z.string(),
  /** Real-world center; the studio converts to pixels via lib/geo. */
  center: LatLngSchema,
  widthFt: z.number(),
  heightFt: z.number(),
  rotationDeg: z.number().default(0),
  floors: z.number().optional(),
});
export type StudioElement = z.infer<typeof StudioElementSchema>;

/* ── Site plan ──────────────────────────────────────────────────────────── */
export const SitePlanSchema = z.object({
  /** Self-contained SVG string, ready to inject. */
  svg: z.string(),
  /** Real-world width/height of the drawn envelope, feet. */
  widthFt: z.number(),
  heightFt: z.number(),
  centroid: LatLngSchema,
});
export type SitePlan = z.infer<typeof SitePlanSchema>;

/* ── The whole Layer 2 result ───────────────────────────────────────────── */
export const FeasibilityResultSchema = z.object({
  version: z.literal(FEASIBILITY_VERSION),
  parcelId: z.string(),
  siteProfileVersion: z.string(),
  projectType: ProjectTypeEnum,
  createdAt: z.string(),
  envelope: EnvelopeSchema,
  program: ProgramSchema,
  sitePlan: SitePlanSchema,
  /** Hard flags worth surfacing (e.g. "use not permitted in zone"). */
  flags: z.array(
    z.object({
      level: z.enum(["info", "warn", "blocker"]),
      message: z.string(),
    })
  ),
  /** Hook for the next chapter — populated by the cost-to-build engine later. */
  costEstimate: z.null(),
});
export type FeasibilityResult = z.infer<typeof FeasibilityResultSchema>;
