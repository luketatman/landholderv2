/**
 * STAGE 1 — Resolve point → PARCEL.  ◀── THE ANCHOR
 *
 * point-in-polygon lookup against Regrid. Returns parcel id, geometry,
 * acreage, owner, zoning (FAR / setbacks / permitted uses) and the county
 * FIPS the rest of the pipeline keys off.
 *
 * Until USE_MOCKS=false + REGRID_API_TOKEN is set, returns a deterministic
 * mock parcel so the whole app runs end-to-end with zero paid calls.
 */
import { env, now } from "./env";
import { hash } from "./geocode";
import type { LatLng, Parcel, Field } from "./types";

function f<T>(
  value: T | null,
  source: Field<T>["source"],
  confidence: number,
  unit: string | null = null,
  note: string | null = null
): Field<T> {
  return { value, unit, source, confidence, fetchedAt: now(), note };
}

export async function resolveParcel(point: LatLng, raw: string): Promise<Parcel> {
  // Regrid is the real anchor. It's decoupled from USE_MOCKS: whenever a token
  // is present we try it, and fall back to the deterministic mock parcel when
  // the point is outside the account's licensed coverage (Regrid returns an
  // empty FeatureCollection there) or the call fails. So real parcels paint
  // wherever the subscription covers, and everywhere else still works on mock.
  if (env.regridToken) {
    try {
      const real = await regridParcel(point);
      if (real) return real;
    } catch {
      /* fall through to mock */
    }
  }
  return mockParcel(point, raw);
}

/* ── REAL: Regrid point lookup ─────────────────────────────────────────────
 *   GET https://app.regrid.com/api/v2/parcels/point?lat={}&lon={}&token={}
 * Returns { parcels: GeoJSON FeatureCollection, ... }; parcel attributes live
 * under feature.properties.fields. Returns null when no parcel covers the
 * point (out-of-coverage → empty features), so the caller can fall back.
 */
async function regridParcel(point: LatLng): Promise<Parcel | null> {
  const url =
    "https://app.regrid.com/api/v2/parcels/point" +
    `?lat=${point.lat}&lon=${point.lng}&token=${env.regridToken}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Regrid ${res.status}`);
  const data = await res.json();
  const feat = data?.parcels?.features?.[0] ?? data?.features?.[0];
  if (!feat || !feat.geometry) return null; // no parcel here → fall back to mock

  const p = feat.properties?.fields ?? feat.properties ?? {};
  const centroid = centroidOf(feat.geometry) ?? point;

  // County FIPS: Regrid sometimes omits `fips`; recover it from `geoid`
  // (state+county+… ) when present, else leave null (Census still resolves the
  // county name from the centroid downstream).
  const countyFips =
    (p.fips && String(p.fips).slice(0, 5)) ||
    (p.geoid && String(p.geoid).slice(0, 5)) ||
    null;

  return {
    parcelId: String(p.parcelnumb ?? p.ll_uuid ?? p.geoid ?? "unknown"),
    countyFips,
    geometry: feat.geometry,
    centroid,
    acreage: f(num(p.ll_gisacre ?? p.gisacre ?? p.deededacreage), "regrid", 0.9, "acres"),
    owner: f(p.owner ?? null, "regrid", 0.85),
    zoningCode: f(p.zoning ?? null, "regrid", 0.7),
    zoningDescription: f(p.zoning_description ?? p.zoning_type ?? null, "regrid", 0.6),
    far: f(num(p.zoning_far), "regrid", 0.5),
    setbacks: f(
      {
        front: num(p.zoning_setback_front),
        side: num(p.zoning_setback_side),
        rear: num(p.zoning_setback_rear),
      },
      "regrid",
      0.4
    ),
    permittedUses: f(
      p.zoning_permitted_uses
        ? String(p.zoning_permitted_uses).split(/[;,]/).map((s: string) => s.trim())
        : null,
      "regrid",
      0.4
    ),
  };
}

/* ── MOCK: deterministic parcel keyed off the address ──────────────────── */
const ZONING = [
  { code: "AG-1", desc: "Agricultural", far: 0.1, uses: ["farm", "single-family", "agritourism"] },
  { code: "R-1", desc: "Residential, low density", far: 0.4, uses: ["single-family", "duplex"] },
  { code: "RR", desc: "Rural Residential", far: 0.2, uses: ["single-family", "retreat", "lodging"] },
  { code: "C-2", desc: "General Commercial", far: 1.5, uses: ["retail", "hotel", "office"] },
  { code: "MU", desc: "Mixed Use", far: 2.0, uses: ["multifamily", "retail", "hotel", "office"] },
];

function mockParcel(point: LatLng, raw: string): Parcel {
  const h = hash(raw);
  const z = ZONING[h % ZONING.length];
  const acreage = round(2 + (h % 4800) / 100); // 2 – 50 ac
  const geometry = squarePolygon(point, acreage);
  const C = "mock" as const;
  const conf = 0.25; // mocks ride low-confidence on purpose

  return {
    parcelId: `MOCK-${(h % 9_000_000) + 1_000_000}`,
    countyFips: String(1000 + (h % 56000)).padStart(5, "0"),
    geometry,
    centroid: point,
    acreage: f(acreage, C, conf, "acres", "synthetic"),
    owner: f(`${pick(OWNERS, h)} ${pick(SUFFIX, h >> 3)}`, C, conf),
    zoningCode: f(z.code, C, conf),
    zoningDescription: f(z.desc, C, conf),
    far: f(z.far, C, conf),
    setbacks: f({ front: 25, side: 10, rear: 20 }, C, conf, "ft"),
    permittedUses: f(z.uses, C, conf),
  };
}

const OWNERS = ["Cedar Ridge", "Blue Heron", "Stonegate", "Magnolia", "Highline", "Prairie"];
const SUFFIX = ["Holdings LLC", "Land Co", "Trust", "Partners LP", "Family Trust"];
function pick<T>(arr: T[], h: number): T {
  return arr[h % arr.length];
}

/* ── geometry helpers ──────────────────────────────────────────────────── */
function squarePolygon(c: LatLng, acres: number) {
  const sideMeters = Math.sqrt(acres * 4046.86);
  const dLat = sideMeters / 111_320 / 2;
  const dLng = sideMeters / (111_320 * Math.cos((c.lat * Math.PI) / 180)) / 2;
  const ring = [
    [c.lng - dLng, c.lat - dLat],
    [c.lng + dLng, c.lat - dLat],
    [c.lng + dLng, c.lat + dLat],
    [c.lng - dLng, c.lat + dLat],
    [c.lng - dLng, c.lat - dLat],
  ];
  return { type: "Polygon" as const, coordinates: [ring] };
}

export function centroidOf(geom: any): LatLng | null {
  try {
    const ring = geom.coordinates[0];
    let x = 0,
      y = 0;
    for (const [lng, lat] of ring) {
      x += lng;
      y += lat;
    }
    return { lat: y / ring.length, lng: x / ring.length };
  } catch {
    return null;
  }
}

function num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round(n: number) {
  return Math.round(n * 100) / 100;
}
