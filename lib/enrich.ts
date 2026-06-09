/**
 * STAGE 2 → 3 — fan-out + normalize.
 *
 * Fires every enrichment source in PARALLEL keyed off the parcel centroid /
 * polygon, tolerates individual failures, and assembles one normalized Site
 * Profile. Each layer reports its own status so the UI can render gaps.
 */
import { env, now } from "./env";
import {
  SITE_PROFILE_VERSION,
  type Parcel,
  type SiteProfile,
  type EnrichmentStatus,
} from "./types";
import {
  getDemographics,
  getAmenities,
  getFlood,
  getSoil,
  getWater,
  getWetlands,
  getTerrain,
  getAccess,
  getUtilities,
} from "./sources";

type Input = SiteProfile["input"];

/** Run one source, capturing ok/error status without throwing. */
async function run<T>(
  key: string,
  fn: () => Promise<T>,
  status: Record<string, EnrichmentStatus>
): Promise<T | null> {
  try {
    const v = await fn();
    status[key] = "ok";
    return v;
  } catch (e) {
    status[key] = "error";
    return null;
  }
}

export async function enrich(parcel: Parcel, input: Input): Promise<SiteProfile> {
  const status: Record<string, EnrichmentStatus> = {
    parcel: "ok",
    demographics: "pending",
    amenities: "pending",
    flood: "pending",
    soil: "pending",
    water: "pending",
    wetlands: "pending",
    terrain: "pending",
    access: "pending",
    utilities: "pending",
  };

  const c = parcel.centroid;

  // FAN-OUT — all calls in parallel.
  const [
    demographics,
    amenities,
    flood,
    soil,
    water,
    wetlands,
    terrain,
    access,
    utilities,
  ] = await Promise.all([
    run("demographics", () => getDemographics(c, parcel.countyFips), status),
    run("amenities", () => getAmenities(c), status),
    run("flood", () => getFlood(parcel), status),
    run("soil", () => getSoil(parcel), status),
    run("water", () => getWater(parcel), status),
    run("wetlands", () => getWetlands(parcel), status),
    run("terrain", () => getTerrain(c), status),
    run("access", () => getAccess(parcel), status),
    run("utilities", () => getUtilities(), status),
  ]);

  // Utilities is a known gap, not an error.
  status.utilities = "skipped";

  const createdAt = now();
  const expiresAt = new Date(
    Date.now() + env.ttlDays * 24 * 60 * 60 * 1000
  ).toISOString();

  // NORMALIZE — assemble the single Site Profile contract. Any source that
  // failed is backfilled with an empty (null-valued) field so the shape is
  // always complete and downstream layers never see `undefined`.
  return {
    version: SITE_PROFILE_VERSION,
    parcelId: parcel.parcelId,
    createdAt,
    expiresAt,
    input,
    parcel,
    enrichment: {
      demographics: demographics ?? { county: emptyField(), ...empty3("population", "medianHouseholdIncome", "medianAge") },
      amenities: amenities ?? empty2("nearestGrocery", "pois"),
      flood: flood ?? empty2("zone", "inFloodway"),
      soil: soil ?? empty3("dominantType", "drainageClass", "septicSuitability"),
      water: water ?? empty2("nearestFeatureType", "distanceToWaterMiles"),
      wetlands: wetlands ?? empty3("overlaps", "wetlandType", "overlapAcres"),
      terrain: terrain ?? empty2("elevationFt", "slopePct"),
      access: access ?? empty3("nearestRoad", "roadFrontageFt", "distanceToRoadMiles"),
      utilities: utilities ?? {
        status: "gap",
        note: "Utilities source unavailable.",
      },
    } as SiteProfile["enrichment"],
    status,
  };
}

/* Backfill helpers: produce an object of null-valued fields so a failed
 * source still satisfies the schema shape. */
function emptyField() {
  return {
    value: null,
    unit: null,
    source: "mock" as const,
    confidence: 0,
    fetchedAt: now(),
    note: "unavailable",
  };
}
function empty2(a: string, b: string): any {
  return { [a]: emptyField(), [b]: emptyField() };
}
function empty3(a: string, b: string, c: string): any {
  return { [a]: emptyField(), [b]: emptyField(), [c]: emptyField() };
}
