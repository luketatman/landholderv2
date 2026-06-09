/**
 * ─────────────────────────────────────────────────────────────────────────
 * THE SITE PROFILE — the contract.
 * ─────────────────────────────────────────────────────────────────────────
 * One parcel resolves to exactly one Site Profile. Both downstream layers
 * (render, feasibility) read from this object and nothing else. It is
 * versioned deliberately: bump SITE_PROFILE_VERSION on any breaking change
 * and migrate cached rows.
 *
 * Every enriched field is wrapped in a Field<T> so each value carries its
 * own unit, source, confidence, and freshness. Downstream code can trust a
 * value or show its provenance without guessing.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { z } from "zod";

export const SITE_PROFILE_VERSION = "1.0.0" as const;

/** Where a field's value came from, for provenance + debugging. */
export const SourceEnum = z.enum([
  "census-geocoder",
  "google-geocoding",
  "regrid",
  "census-data",
  "google-places",
  "overpass-osm",
  "fema-nfhl",
  "usda-ssurgo",
  "usgs-nhd",
  "usfws-nwi",
  "usgs-3dep",
  "openstreetmap",
  "mock",
]);
export type Source = z.infer<typeof SourceEnum>;

/** Wraps a single enriched value with its provenance. */
export function field<T extends z.ZodTypeAny>(inner: T) {
  return z.object({
    value: inner.nullable(),
    unit: z.string().nullable().default(null),
    source: SourceEnum,
    /** 0–1. How much to trust this value. Mocked data should sit low. */
    confidence: z.number().min(0).max(1),
    /** ISO timestamp the value was fetched. */
    fetchedAt: z.string(),
    /** Optional free-text note (e.g. "nearest feature 1.2mi NW"). */
    note: z.string().nullable().default(null),
  });
}

export type Field<T> = {
  value: T | null;
  unit: string | null;
  source: Source;
  confidence: number;
  fetchedAt: string;
  note: string | null;
};

/** GeoJSON-ish geometry kept loose; PostGIS is the source of truth. */
export const GeometrySchema = z.object({
  type: z.literal("Polygon").or(z.literal("MultiPolygon")),
  coordinates: z.array(z.any()),
});
export type Geometry = z.infer<typeof GeometrySchema>;

export const LatLngSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});
export type LatLng = z.infer<typeof LatLngSchema>;

/** Per-enrichment status so the UI can render progressively. */
export const EnrichmentStatusEnum = z.enum([
  "pending",
  "ok",
  "partial",
  "error",
  "skipped",
]);
export type EnrichmentStatus = z.infer<typeof EnrichmentStatusEnum>;

/* ── STAGE 1 — the anchor: parcel + zoning ─────────────────────────────── */
export const ParcelSchema = z.object({
  parcelId: z.string(),
  countyFips: z.string().nullable(),
  geometry: GeometrySchema.nullable(),
  centroid: LatLngSchema,
  acreage: field(z.number()),
  owner: field(z.string()),
  zoningCode: field(z.string()),
  zoningDescription: field(z.string()),
  far: field(z.number()), // floor-area ratio
  setbacks: field(
    z.object({
      front: z.number().nullable(),
      side: z.number().nullable(),
      rear: z.number().nullable(),
    })
  ),
  permittedUses: field(z.array(z.string())),
});
export type Parcel = z.infer<typeof ParcelSchema>;

/* ── STAGE 2 — fan-out enrichment ──────────────────────────────────────── */
export const DemographicsSchema = z.object({
  county: field(z.string()),
  population: field(z.number()),
  medianHouseholdIncome: field(z.number()),
  medianAge: field(z.number()),
});
export type Demographics = z.infer<typeof DemographicsSchema>;

export const PoiSchema = z.object({
  name: z.string(),
  category: z.string(),
  distanceMiles: z.number(),
  latLng: LatLngSchema.nullable(),
});

export type Poi = z.infer<typeof PoiSchema>;

export const AmenitiesSchema = z.object({
  nearestGrocery: field(PoiSchema),
  pois: field(z.array(PoiSchema)),
});
export type Amenities = z.infer<typeof AmenitiesSchema>;

export const FloodSchema = z.object({
  zone: field(z.string()), // e.g. "X", "AE", "VE"
  inFloodway: field(z.boolean()),
});
export type Flood = z.infer<typeof FloodSchema>;

export const SoilSchema = z.object({
  dominantType: field(z.string()),
  drainageClass: field(z.string()),
  septicSuitability: field(z.string()), // e.g. "well suited" | "limited"
});
export type Soil = z.infer<typeof SoilSchema>;

export const WaterSchema = z.object({
  nearestFeatureType: field(z.string()), // stream | lake | river
  distanceToWaterMiles: field(z.number()),
});
export type Water = z.infer<typeof WaterSchema>;

export const WetlandsSchema = z.object({
  overlaps: field(z.boolean()),
  wetlandType: field(z.string()),
  overlapAcres: field(z.number()),
});
export type Wetlands = z.infer<typeof WetlandsSchema>;

export const TerrainSchema = z.object({
  elevationFt: field(z.number()),
  slopePct: field(z.number()),
});
export type Terrain = z.infer<typeof TerrainSchema>;

export const AccessSchema = z.object({
  nearestRoad: field(z.string()),
  roadFrontageFt: field(z.number()),
  distanceToRoadMiles: field(z.number()),
});
export type Access = z.infer<typeof AccessSchema>;

export const UtilitiesSchema = z.object({
  // No clean free API — flagged as a known gap.
  status: z.literal("gap"),
  note: z.string(),
});
export type Utilities = z.infer<typeof UtilitiesSchema>;

/* ── THE WHOLE THING ───────────────────────────────────────────────────── */
export const SiteProfileSchema = z.object({
  version: z.literal(SITE_PROFILE_VERSION),
  parcelId: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  input: z.object({
    raw: z.string(),
    kind: z.enum(["address", "pin", "boundary"]),
    geocoded: LatLngSchema.nullable(),
  }),
  parcel: ParcelSchema,
  enrichment: z.object({
    demographics: DemographicsSchema,
    amenities: AmenitiesSchema,
    flood: FloodSchema,
    soil: SoilSchema,
    water: WaterSchema,
    wetlands: WetlandsSchema,
    terrain: TerrainSchema,
    access: AccessSchema,
    utilities: UtilitiesSchema,
  }),
  /** Per-layer fetch status, so the UI can stream + show gaps. */
  status: z.record(z.string(), EnrichmentStatusEnum),
});
export type SiteProfile = z.infer<typeof SiteProfileSchema>;

/** The fast first response: parcel + zoning only, enrichment still pending. */
export type ParcelResponse = {
  version: typeof SITE_PROFILE_VERSION;
  parcelId: string;
  input: SiteProfile["input"];
  parcel: Parcel;
  cached: boolean;
};
