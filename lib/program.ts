/**
 * LAYER 2 core — buildable envelope + program.
 *
 * Turns zoning + site constraints into "what can actually go here." All math
 * is high-level / order-of-magnitude by design; every assumption is emitted
 * so a reviewer can challenge any number. Tune the TYPE_DEFAULTS table to
 * match your underwriting standards.
 */
import type { SiteProfile } from "./types";
import type {
  ProjectType,
  ProjectParams,
  Envelope,
  Program,
  Building,
} from "./feasibilityTypes";

const SQFT_PER_ACRE = 43_560;

/** Per-type planning defaults. These are the levers; document any change. */
type TypeDefault = {
  /** Share of NET developable land under building footprint. */
  coverage: number;
  /** Typical floor count when FAR doesn't bind. */
  typFloors: number;
  /** Hard cap on floors for this product. */
  maxFloors: number;
  /** Gross sqft consumed per yield unit (incl. circulation/common). */
  gsfPerUnit: number;
  /** Parking stalls per yield unit. */
  parkPerUnit: number;
  yieldLabel: string;
  unitWordSingular: string;
};

const TYPE_DEFAULTS: Record<ProjectType, TypeDefault> = {
  retreat: { coverage: 0.12, typFloors: 1, maxFloors: 2, gsfPerUnit: 700, parkPerUnit: 1.0, yieldLabel: "cabins", unitWordSingular: "cabin" },
  hotel: { coverage: 0.35, typFloors: 3, maxFloors: 8, gsfPerUnit: 650, parkPerUnit: 1.0, yieldLabel: "keys", unitWordSingular: "key" },
  multifamily: { coverage: 0.35, typFloors: 3, maxFloors: 6, gsfPerUnit: 1000, parkPerUnit: 1.5, yieldLabel: "units", unitWordSingular: "unit" },
  single_family: { coverage: 0.22, typFloors: 2, maxFloors: 2, gsfPerUnit: 2200, parkPerUnit: 2.0, yieldLabel: "lots", unitWordSingular: "lot" },
  retail: { coverage: 0.25, typFloors: 1, maxFloors: 2, gsfPerUnit: 1, parkPerUnit: 0, yieldLabel: "sq ft GLA", unitWordSingular: "sq ft" },
  mixed_use: { coverage: 0.4, typFloors: 4, maxFloors: 10, gsfPerUnit: 1000, parkPerUnit: 1.2, yieldLabel: "units (+ ground retail)", unitWordSingular: "unit" },
};

function val<T>(f: { value: T | null } | undefined, fallback: T): T {
  return f && f.value !== null ? (f.value as T) : fallback;
}

/* ── Envelope ───────────────────────────────────────────────────────────── */
export function computeEnvelope(
  profile: SiteProfile,
  type: ProjectType,
  params: ProjectParams
): Envelope {
  const d = TYPE_DEFAULTS[type];
  const grossAcres = val(profile.parcel.acreage, 0);
  const grossSqft = grossAcres * SQFT_PER_ACRE;

  const deductions: Envelope["deductions"] = [];

  // Flood: special-hazard zones sterilize developable land.
  const floodZone = val(profile.enrichment.flood?.zone, "X");
  const floodFrac = floodZone === "VE" ? 0.6 : floodZone === "AE" || floodZone === "A" ? 0.25 : 0;
  if (floodFrac > 0)
    deductions.push({ reason: `Flood zone ${floodZone}`, acres: round(grossAcres * floodFrac), source: "fema-nfhl" });

  // Wetlands: remove overlap + a regulatory buffer (~1.5×).
  const wetlandAcres = val(profile.enrichment.wetlands?.overlapAcres, 0);
  const wetlandDeduct = Math.min(grossAcres, wetlandAcres * 1.5);
  if (wetlandDeduct > 0)
    deductions.push({ reason: "Wetlands + buffer", acres: round(wetlandDeduct), source: "usfws-nwi" });

  // Slope: steep ground is expensive/undevelopable.
  const slope = val(profile.enrichment.terrain?.slopePct, 0);
  const slopeFrac = slope > 25 ? 0.5 : slope > 15 ? 0.3 : 0;
  if (slopeFrac > 0)
    deductions.push({ reason: `Slope ${slope}% (>15%)`, acres: round(grossAcres * slopeFrac), source: "usgs-3dep" });

  const totalDeductAcres = deductions.reduce((s, x) => s + x.acres, 0);
  const netDevelopableAcres = Math.max(0, round(grossAcres - totalDeductAcres));
  const netDevelopableSqft = netDevelopableAcres * SQFT_PER_ACRE;

  // Setback-limited footprint envelope: approximate the parcel as a square,
  // inset by setbacks on each edge.
  const sb = val(profile.parcel.setbacks, { front: 25, side: 10, rear: 20 }) as {
    front: number | null;
    side: number | null;
    rear: number | null;
  };
  const side = Math.sqrt(grossSqft);
  const usableW = Math.max(0, side - (sb.front ?? 0) - (sb.rear ?? 0));
  const usableD = Math.max(0, side - 2 * (sb.side ?? 0));
  const setbackEnvelopeSqft = round(usableW * usableD);

  // FAR cap (floor-area ratio applies to LOT area).
  const far = val(profile.parcel.far, 0.2);
  const maxFloorAreaByFAR = round(grossSqft * far);

  // Footprint is the tighter of coverage-of-net-developable and setback box.
  const coverage = params.coverageRatio ?? d.coverage;
  const footprintCapSqft = round(Math.min(netDevelopableSqft * coverage, setbackEnvelopeSqft));

  // Floors: enough to realize the FAR over the footprint, capped by product.
  const derivedFloors = footprintCapSqft > 0 ? Math.round(maxFloorAreaByFAR / footprintCapSqft) : 1;
  const floors = clamp(params.floors ?? Math.max(1, Math.min(derivedFloors, d.typFloors === d.maxFloors ? d.typFloors : derivedFloors)), 1, d.maxFloors);

  const buildableGsf = round(Math.min(maxFloorAreaByFAR, footprintCapSqft * floors));

  return {
    grossAcres: round(grossAcres),
    grossSqft: round(grossSqft),
    deductions,
    netDevelopableAcres,
    setbackEnvelopeSqft,
    maxFloorAreaByFAR,
    footprintCapSqft,
    floors,
    buildableGsf,
  };
}

/* ── Program ────────────────────────────────────────────────────────────── */
export function computeProgram(
  type: ProjectType,
  env: Envelope,
  profile: SiteProfile,
  params: ProjectParams
): Program {
  const d = TYPE_DEFAULTS[type];
  const assumptions: string[] = [];
  const efficiency = 0.85; // share of GSF that's leasable/usable
  const usableGsf = env.buildableGsf * efficiency;
  assumptions.push(`${Math.round(efficiency * 100)}% efficiency on ${fmt(env.buildableGsf)} gross sq ft.`);

  let buildings: Building[] = [];
  let yieldCount = 0;
  let parkingStalls = 0;

  if (type === "single_family") {
    // Subdivision: yield = net developable / min lot, minus 25% for roads.
    const minLotSqft = 10_890; // ~0.25 ac default
    const netForLots = env.netDevelopableAcres * SQFT_PER_ACRE * 0.75;
    yieldCount = Math.floor(netForLots / minLotSqft);
    parkingStalls = yieldCount * d.parkPerUnit;
    buildings = [{ label: "Single-family homes", count: yieldCount, footprintSqft: 2200, floors: 2 }];
    assumptions.push(`Min lot 0.25 ac; 25% of net land for roads/ROW.`);
  } else if (type === "retail") {
    // Single-story box; GLA is the lesser of footprint and FAR-allowed area.
    const gla = Math.round(Math.min(env.footprintCapSqft, env.buildableGsf));
    yieldCount = gla;
    parkingStalls = Math.round((gla / 1000) * 4); // 4 / 1,000 GLA
    buildings = [{ label: "Retail building", count: 1, footprintSqft: gla, floors: 1 }];
    assumptions.push(`GLA = min(footprint cap, FAR floor area); parking 4 stalls / 1,000 sq ft.`);
  } else {
    yieldCount = Math.floor(usableGsf / d.gsfPerUnit);
    parkingStalls = Math.round(yieldCount * d.parkPerUnit);
    assumptions.push(`${fmt(d.gsfPerUnit)} gross sq ft per ${d.unitWordSingular}; ${d.parkPerUnit} stalls per ${d.unitWordSingular}.`);

    if (type === "retreat") {
      const lodge = 6000;
      const cabins = Math.max(0, Math.floor((env.footprintCapSqft - lodge) / 700));
      yieldCount = cabins;
      parkingStalls = Math.round(cabins * d.parkPerUnit) + 6;
      buildings = [
        { label: "Lodge / common", count: 1, footprintSqft: lodge, floors: 1 },
        { label: "Cabins", count: cabins, footprintSqft: 700, floors: 1 },
      ];
      assumptions.push(`6,000 sq ft lodge + 700 sq ft cabins; low ${Math.round(d.coverage * 100)}% coverage.`);
    } else {
      // Distribute footprint into a sensible building count.
      const perBuilding = type === "hotel" ? env.footprintCapSqft : Math.min(env.footprintCapSqft, 14_000);
      const count = Math.max(1, Math.round(env.footprintCapSqft / perBuilding));
      buildings = [
        { label: d.yieldLabel.includes("retail") ? "Mixed-use building" : `${cap(type)} building`, count, footprintSqft: round(env.footprintCapSqft / count), floors: env.floors },
      ];
    }
  }

  const builtFootprint = buildings.reduce((s, b) => s + b.footprintSqft * b.count, 0);
  const parkingSqft = parkingStalls * 320; // stall + aisle
  const openSpaceSqft = Math.max(0, round(env.netDevelopableAcres * SQFT_PER_ACRE - builtFootprint - parkingSqft));

  return {
    projectType: type,
    yieldLabel: d.yieldLabel,
    yieldCount,
    buildings,
    parkingStalls,
    openSpaceSqft,
    assumptions,
  };
}

/* ── helpers ────────────────────────────────────────────────────────────── */
function round(n: number) {
  return Math.round(n);
}
function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
function fmt(n: number) {
  return Math.round(n).toLocaleString();
}
function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).replace("_", "-");
}
