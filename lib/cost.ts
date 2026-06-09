/**
 * LAYER 3 — Phase 3: deterministic cost-to-build engine.
 *
 * Takes the approved program (gross sq ft, parking, site) + a normalized
 * build spec (quality tier, structure, site difficulty, utilities, parking
 * type, contingency, budget) gathered by the pricing chatbot, and returns an
 * order-of-magnitude cost estimate: a category breakdown, a total RANGE, $/sq
 * ft, $/unit, a materials list, and every assumption so the numbers are
 * traceable. NOT a contractor bid — a screening estimate.
 */
export type QualityTier = "economy" | "standard" | "premium" | "luxury";

export type BuildSpec = {
  qualityTier: QualityTier;
  /** Free-text structure description, e.g. "wood frame", "steel", "modular". */
  structure: string;
  siteDifficulty: "easy" | "moderate" | "hard";
  utilities: "on_grid" | "off_grid_partial" | "off_grid_full";
  parkingType: "surface" | "structured" | "none";
  /** 0–40. Contingency as a percent of construction subtotal. */
  contingencyPct: number;
  /** The user's target budget, if they gave one. */
  budgetUsd: number | null;
  /** Notable material/finish choices the user mentioned. */
  materials: string[];
  notes: string;
};

export type ProjectCostInput = {
  projectType: string; // ProjectType string
  buildingGrossSqft: number; // Σ footprint × floors over building elements
  buildingCount: number;
  parkingStalls: number;
  siteAcres: number;
  /** 2-digit state FIPS for the regional cost index (from county FIPS). */
  stateFips: string | null;
  unitLabel?: string; // e.g. "cabins", "keys", "units"
};

export type CostLine = { label: string; low: number; high: number; note?: string };

export type CostEstimate = {
  currency: "USD";
  qualityTier: QualityTier;
  lines: CostLine[];
  totalLow: number;
  totalHigh: number;
  perSqftLow: number;
  perSqftHigh: number;
  perUnit: number | null;
  unitLabel: string | null;
  budgetUsd: number | null;
  budget: { status: "under" | "over" | "on"; amount: number } | null;
  materials: string[];
  assumptions: string[];
};

const SQFT_PER_ACRE = 43_560;
const SPREAD = 0.12; // ± range around the point estimate

/** Building hard cost $/sq ft by quality tier (national, mid-2020s order of mag). */
const QUALITY_BASE: Record<QualityTier, number> = {
  economy: 175,
  standard: 245,
  premium: 365,
  luxury: 525,
};

/** Product-type factor on the building $/sq ft (small cabins cost more per ft). */
const TYPE_FACTOR: Record<string, number> = {
  retreat: 1.05,
  hotel: 1.25,
  multifamily: 1.0,
  single_family: 0.85,
  retail: 0.65,
  mixed_use: 1.15,
};

/** Regional cost index by 2-digit state FIPS (1.0 = national average). */
const STATE_INDEX: Record<string, number> = {
  "02": 1.3, "06": 1.25, "08": 1.0, "09": 1.15, "11": 1.18, "15": 1.35,
  "17": 1.1, "23": 1.05, "24": 1.05, "25": 1.2, "26": 0.98, "27": 1.05,
  "33": 1.05, "34": 1.18, "36": 1.3, "41": 1.08, "44": 1.12, "50": 1.05,
  "53": 1.12, "55": 1.0,
  "01": 0.85, "05": 0.85, "12": 0.92, "13": 0.9, "16": 0.92, "18": 0.92,
  "19": 0.92, "20": 0.88, "21": 0.88, "22": 0.9, "28": 0.85, "29": 0.9,
  "30": 0.92, "31": 0.9, "32": 1.02, "35": 0.9, "37": 0.9, "38": 0.95,
  "39": 0.95, "40": 0.86, "45": 0.88, "46": 0.92, "47": 0.88, "48": 0.92,
  "49": 0.95, "51": 0.93, "54": 0.9, "56": 0.95,
};

function regionFactor(stateFips: string | null): number {
  if (stateFips && STATE_INDEX[stateFips] != null) return STATE_INDEX[stateFips];
  return 0.95;
}

const SITE_PCT: Record<BuildSpec["siteDifficulty"], number> = {
  easy: 0.1,
  moderate: 0.16,
  hard: 0.24,
};

function range(point: number): { low: number; high: number } {
  return { low: Math.round(point * (1 - SPREAD)), high: Math.round(point * (1 + SPREAD)) };
}

function materialsFor(tier: QualityTier, extra: string[]): string[] {
  const base: Record<QualityTier, string[]> = {
    economy: ["Vinyl siding", "Asphalt-shingle roof", "Laminate / LVT floors", "Fiberglass insulation", "Builder-grade fixtures"],
    standard: ["Fiber-cement or vinyl siding", "Architectural-shingle roof", "Mixed LVT / tile floors", "Mid-grade windows", "Standard fixtures"],
    premium: ["Fiber-cement / wood siding", "Standing-seam metal roof", "Hardwood + tile floors", "Upgraded windows", "Quality fixtures & cabinetry"],
    luxury: ["Stone / timber / steel accents", "Standing-seam metal or slate roof", "Wide-plank hardwood + stone", "High-performance glazing", "Custom millwork & high-end fixtures"],
  };
  const seen = new Set<string>();
  return [...extra, ...base[tier]].map((s) => s.trim()).filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
}

export function computeCost(input: ProjectCostInput, spec: BuildSpec): CostEstimate {
  const region = regionFactor(input.stateFips);
  const tier = spec.qualityTier;
  const typeFac = TYPE_FACTOR[input.projectType] ?? 1.0;
  const gsf = Math.max(0, Math.round(input.buildingGrossSqft));

  // 1. Buildings (hard cost).
  const buildingPoint = gsf * QUALITY_BASE[tier] * typeFac * region;

  // 2. Parking.
  const stalls = Math.max(0, input.parkingStalls);
  const perStall = spec.parkingType === "structured" ? 28_000 : spec.parkingType === "none" ? 0 : 6_000;
  const parkingPoint = stalls * perStall * region;

  // 3. Sitework + utilities.
  const siteworkPoint = buildingPoint * SITE_PCT[spec.siteDifficulty];
  const utilExtra =
    spec.utilities === "off_grid_full"
      ? 110_000 * region
      : spec.utilities === "off_grid_partial"
      ? 38_000 * region
      : 0;
  const siteUtilPoint = siteworkPoint + utilExtra;

  // 4. Soft costs (design, permits, fees) — % of construction so far.
  const hardSubtotal = buildingPoint + parkingPoint + siteUtilPoint;
  const softPoint = hardSubtotal * 0.2;

  // 5. Contingency.
  const contPct = Math.max(0, Math.min(40, spec.contingencyPct || 12)) / 100;
  const contPoint = (hardSubtotal + softPoint) * contPct;

  const lines: CostLine[] = [
    { label: "Buildings (hard cost)", ...range(buildingPoint), note: `${gsf.toLocaleString()} gross sq ft · ${tier}` },
    ...(parkingPoint > 0
      ? [{ label: `Parking (${spec.parkingType})`, ...range(parkingPoint), note: `${stalls} stalls` }]
      : []),
    { label: "Sitework & utilities", ...range(siteUtilPoint), note: `${spec.siteDifficulty} site${spec.utilities !== "on_grid" ? " · off-grid" : ""}` },
    { label: "Soft costs (design, permits, fees)", ...range(softPoint), note: "~20% of construction" },
    { label: "Contingency", ...range(contPoint), note: `${Math.round(contPct * 100)}%` },
  ];

  const totalLow = lines.reduce((s, l) => s + l.low, 0);
  const totalHigh = lines.reduce((s, l) => s + l.high, 0);

  const perUnit = input.buildingCount > 0 ? Math.round((totalLow + totalHigh) / 2 / input.buildingCount) : null;

  let budget: CostEstimate["budget"] = null;
  if (spec.budgetUsd && spec.budgetUsd > 0) {
    const mid = (totalLow + totalHigh) / 2;
    const diff = Math.round(mid - spec.budgetUsd);
    budget =
      Math.abs(diff) <= spec.budgetUsd * 0.05
        ? { status: "on", amount: Math.abs(diff) }
        : diff > 0
        ? { status: "over", amount: diff }
        : { status: "under", amount: -diff };
  }

  const assumptions = [
    `Regional cost index ${region.toFixed(2)}× (national avg = 1.00).`,
    `Building base $${QUALITY_BASE[tier]}/sq ft (${tier}) × ${typeFac.toFixed(2)} product factor.`,
    `Soft costs 20% of construction; contingency ${Math.round(contPct * 100)}%; ± ${Math.round(SPREAD * 100)}% range.`,
    "Order-of-magnitude screening estimate — not a contractor bid. Excludes land, financing, FF&E.",
  ];

  return {
    currency: "USD",
    qualityTier: tier,
    lines,
    totalLow,
    totalHigh,
    perSqftLow: gsf > 0 ? Math.round(totalLow / gsf) : 0,
    perSqftHigh: gsf > 0 ? Math.round(totalHigh / gsf) : 0,
    perUnit,
    unitLabel: input.unitLabel ?? null,
    budgetUsd: spec.budgetUsd ?? null,
    budget,
    materials: materialsFor(tier, spec.materials || []),
    assumptions,
  };
}
