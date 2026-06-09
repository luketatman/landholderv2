/**
 * STAGE 2 — Fan-out enrichment sources.
 *
 * One function per data layer. Each returns its slice of the Site Profile and
 * runs independently so the orchestrator can fire them all in parallel and
 * tolerate individual failures.
 *
 * Every function:
 *   • returns deterministic MOCK data when USE_MOCKS=true (default), so the
 *     whole app runs with zero external calls;
 *   • carries a clearly-marked REAL-ENDPOINT block to wire up when going live.
 *
 * Confirm endpoint URLs against live docs at build time — the federal GIS
 * services move occasionally.
 */
import { env, now } from "./env";
import { hash } from "./geocode";
import type {
  LatLng,
  Parcel,
  Field,
  Source,
  Demographics,
  Amenities,
  Flood,
  Soil,
  Water,
  Wetlands,
  Terrain,
  Access,
  Utilities,
  Poi,
} from "./types";

function f<T>(
  value: T | null,
  source: Source,
  confidence: number,
  unit: string | null = null,
  note: string | null = null
): Field<T> {
  return { value, unit, source, confidence, fetchedAt: now(), note };
}

const MOCK = "mock" as const;
const C = 0.25; // mock confidence

/* ── county population / demographics — US Census Data API (centroid→FIPS) ─
 * FREE, no paid key required, so this is decoupled from USE_MOCKS: real Census
 * data is used whenever USE_CENSUS is on (default), independent of Regrid/Google.
 *
 * Two free calls, no key needed (a CENSUS_API_KEY just raises the rate limit):
 *   1. Census geographies geocoder: real lat/lng → the REAL county FIPS.
 *      (We can't trust the mock parcel's countyFips — it's synthetic.)
 *   2. ACS 5-year (acs5): county FIPS → population / median income / median age.
 * Any failure (offline, no match, bad response) falls back to deterministic mock. */
export async function getDemographics(
  centroid: LatLng,
  countyFipsHint: string | null
): Promise<Demographics> {
  if (env.censusEnabled) {
    try {
      // 1. Resolve the REAL county for this point. Prefer a live geocode of the
      //    coordinates; fall back to a real-looking hint from the parcel layer.
      const fips =
        (await countyFipsFromPoint(centroid)) ??
        (isRealFips(countyFipsHint) ? countyFipsHint : null);

      if (fips) {
        const state = fips.slice(0, 2);
        const county = fips.slice(2);
        const keyParam = env.censusKey ? `&key=${env.censusKey}` : "";
        const url =
          "https://api.census.gov/data/2022/acs/acs5" +
          "?get=NAME,B01003_001E,B19013_001E,B01002_001E" +
          `&for=county:${county}&in=state:${state}${keyParam}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const [, row] = await res.json();
          const countyName: string = row[0];
          return {
            county: f(countyName, "census-data", 0.9),
            population: f(Number(row[1]), "census-data", 0.9, "people"),
            medianHouseholdIncome: f(Number(row[2]), "census-data", 0.9, "USD"),
            medianAge: f(Number(row[3]), "census-data", 0.9, "years"),
          };
        }
      }
    } catch {
      /* fall through to mock */
    }
  }
  const h = hash("demo" + centroid.lat + centroid.lng);
  return {
    county: f<string>(null, MOCK, C, null, "synthetic"),
    population: f(8_000 + (h % 1_200_000), MOCK, C, "people", "synthetic"),
    medianHouseholdIncome: f(42_000 + (h % 80_000), MOCK, C, "USD"),
    medianAge: f(31 + (h % 20), MOCK, C, "years"),
  };
}

/** Real lat/lng → 5-digit county FIPS via the free Census geographies geocoder. */
async function countyFipsFromPoint(c: LatLng): Promise<string | null> {
  try {
    const url =
      "https://geocoding.geo.census.gov/geocoder/geographies/coordinates" +
      `?x=${c.lng}&y=${c.lat}` +
      "&benchmark=Public_AR_Current&vintage=Current_Current" +
      "&layers=Counties&format=json";
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const county = data?.result?.geographies?.Counties?.[0];
    if (county?.STATE && county?.COUNTY) {
      return `${county.STATE}${county.COUNTY}`; // 2-digit state + 3-digit county
    }
    return null;
  } catch {
    return null;
  }
}

/** The mock parcel emits a random 5-digit FIPS; a few are not real counties.
 *  Cheap sanity gate so we never query ACS with a bogus county. */
function isRealFips(fips: string | null): fips is string {
  return Boolean(fips && /^\d{5}$/.test(fips) && Number(fips.slice(0, 2)) <= 56);
}

/* ── grocery + POIs — OpenStreetMap / Overpass (FREE, no key) ────────────── */
export async function getAmenities(centroid: LatLng): Promise<Amenities> {
  // FREE real path: OpenStreetMap via Overpass. Decoupled from USE_MOCKS;
  // any failure (network, empty) falls back to deterministic mock below.
  if (env.osmEnabled) {
    const real = await amenitiesFromOSM(centroid);
    if (real) return real;
  }
  // OPTIONAL richer path (paid, future): Google Places Nearby —
  //   https://maps.googleapis.com/maps/api/place/nearbysearch/json
  //   ?location={lat},{lng}&rankby=distance&type=supermarket&key={GOOGLE}
  // OSM already covers this for free, so Google stays an upgrade.

  const h = hash("amen" + centroid.lat + centroid.lng);
  const groceryDist = round(0.4 + (h % 1200) / 100);
  const grocery: Poi = {
    name: pick(["Kroger", "Safeway", "Publix", "H-E-B", "Local IGA"], h),
    category: "supermarket",
    distanceMiles: groceryDist,
    latLng: null,
  };
  const pois: Poi[] = [
    { name: "Elementary School", category: "school", distanceMiles: round(0.8 + (h % 300) / 100), latLng: null },
    { name: "Urgent Care", category: "health", distanceMiles: round(1.5 + (h % 500) / 100), latLng: null },
    { name: "State Park Trailhead", category: "recreation", distanceMiles: round(2.2 + (h % 900) / 100), latLng: null },
    { name: "Highway Interchange", category: "transport", distanceMiles: round(1.0 + (h % 700) / 100), latLng: null },
  ];
  return {
    nearestGrocery: f(grocery, MOCK, C, "mi", "synthetic"),
    pois: f(pois, MOCK, C),
  };
}

/* ── flood zone — FEMA National Flood Hazard Layer (FREE, no key) ────────── */
export async function getFlood(parcel: Parcel): Promise<Flood> {
  if (env.fedEnabled) {
    const real = await floodFromFEMA(parcel.centroid);
    if (real) return real;
  }
  const h = hash("flood" + parcel.parcelId);
  const zones = ["X", "X", "X", "AE", "A", "VE"]; // most land is zone X
  const zone = zones[h % zones.length];
  return {
    zone: f(zone, MOCK, C, null, zone === "X" ? "minimal hazard" : "special flood hazard area"),
    inFloodway: f(zone === "VE" || zone === "AE" ? (h & 1) === 1 : false, MOCK, C),
  };
}

/* ── soil / septic — USDA Soil Data Access (SSURGO) (FREE, no key) ───────── */
export async function getSoil(parcel: Parcel): Promise<Soil> {
  if (env.fedEnabled) {
    const real = await soilFromSSURGO(parcel.centroid);
    if (real) return real;
  }
  const h = hash("soil" + parcel.parcelId);
  const types = ["Cecil sandy loam", "Pacolet clay", "Davidson loam", "Appling sandy loam"];
  const drain = ["well drained", "moderately well drained", "poorly drained"];
  const d = drain[h % drain.length];
  const suit = d === "well drained" ? "well suited" : d === "poorly drained" ? "limited" : "moderate";
  return {
    dominantType: f(types[h % types.length], MOCK, C),
    drainageClass: f(d, MOCK, C),
    septicSuitability: f(suit, MOCK, C, null, "conventional septic"),
  };
}

/* ── nearest water — USGS National Hydrography Dataset (FREE, no key) ─────── */
export async function getWater(parcel: Parcel): Promise<Water> {
  if (env.fedEnabled) {
    const real = await waterFromNHD(parcel.centroid);
    if (real) return real;
  }
  const h = hash("water" + parcel.parcelId);
  const types = ["stream", "creek", "lake", "river", "pond"];
  return {
    nearestFeatureType: f(types[h % types.length], MOCK, C),
    distanceToWaterMiles: f(round(0.1 + (h % 400) / 100), MOCK, C, "mi"),
  };
}

/* ── wetlands — USFWS National Wetlands Inventory (polygon overlap) ──────── */
export async function getWetlands(parcel: Parcel): Promise<Wetlands> {
  // REAL: USFWS NWI MapServer intersect parcel geometry → wetland polygons.
  const h = hash("wet" + parcel.parcelId);
  const overlaps = h % 5 === 0; // ~20% of parcels touch wetlands
  return {
    overlaps: f(overlaps, MOCK, C),
    wetlandType: f(overlaps ? "Freshwater Forested/Shrub" : null, MOCK, C),
    overlapAcres: f(overlaps ? round(0.2 + (h % 200) / 100) : 0, MOCK, C, "acres"),
  };
}

/* ── elevation / slope — USGS 3DEP via EPQS (FREE, no key) ───────────────── */
export async function getTerrain(centroid: LatLng): Promise<Terrain> {
  if (env.fedEnabled) {
    const real = await terrainFromEPQS(centroid);
    if (real) return real;
  }
  const h = hash("terr" + centroid.lat + centroid.lng);
  return {
    elevationFt: f(200 + (h % 5000), MOCK, C, "ft"),
    slopePct: f(round((h % 1800) / 100), MOCK, C, "%", "0–18% range"),
  };
}

/* ── road access / frontage — OpenStreetMap / Overpass (FREE, no key) ────── */
export async function getAccess(parcel: Parcel): Promise<Access> {
  // FREE real path: nearest named road via Overpass, with true point-to-road
  // distance. Falls back to deterministic mock on any failure.
  if (env.osmEnabled) {
    const real = await accessFromOSM(parcel.centroid);
    if (real) return real;
  }
  const h = hash("acc" + parcel.parcelId);
  const roads = ["County Rd 14", "State Hwy 9", "Oak Ridge Rd", "Farm-to-Market 1960"];
  const dist = round((h % 60) / 100); // 0–0.6 mi
  return {
    nearestRoad: f(roads[h % roads.length], MOCK, C),
    roadFrontageFt: f(dist < 0.05 ? 120 + (h % 600) : 0, MOCK, C, "ft", dist < 0.05 ? "direct frontage" : "no direct frontage"),
    distanceToRoadMiles: f(dist, MOCK, C, "mi"),
  };
}

/* ── utilities / power — KNOWN GAP, no clean free API ───────────────────── */
export async function getUtilities(): Promise<Utilities> {
  return {
    status: "gap",
    note: "No clean free API for utility/power proximity. Wire a regional LDC/ISO source or a paid provider here.",
  };
}

/* ── OpenStreetMap / Overpass (shared, FREE, no key) ────────────────────── */

/**
 * Run an Overpass QL query, trying global mirrors in order. Returns the
 * elements[] (possibly empty) from the first mirror that responds, or null if
 * every mirror fails. We use GET with the query in the URL — Overpass rejects
 * the form-POST body that Next.js's patched fetch produces (returns HTTP 406).
 */
async function overpass(ql: string): Promise<any[] | null> {
  const mirrors = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
  ];
  for (const url of mirrors) {
    try {
      const res = await fetch(url + "?data=" + encodeURIComponent(ql), {
        method: "GET",
        headers: {
          Accept: "application/json",
          // Required: Overpass returns HTTP 406 to clients with no User-Agent.
          "User-Agent": "landholder/0.1 (CRE feasibility app)",
        },
        signal: AbortSignal.timeout(20000),
        cache: "no-store",
      });
      if (!res.ok) continue; // 429/406/5xx → try the next mirror
      const data = await res.json();
      if (Array.isArray(data?.elements)) return data.elements;
    } catch {
      /* timeout / network error → try the next mirror */
    }
  }
  return null;
}

/** Center of an OSM element: nodes carry lat/lon; ways/relations carry .center. */
function elCenter(el: any): { lat: number; lng: number } | null {
  if (typeof el.lat === "number") return { lat: el.lat, lng: el.lon };
  if (el.center) return { lat: el.center.lat, lng: el.center.lon };
  return null;
}

/** Great-circle distance in miles. */
function haversineMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3958.8;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Nearest distance (meters) from a point to a road polyline, via local projection. */
function metersPointToWay(
  lat: number,
  lng: number,
  geom: Array<{ lat: number; lon: number }>
): number {
  if (!geom.length) return Infinity;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const mPerLat = 111_320;
  const mPerLng = 111_320 * Math.cos(toRad(lat));
  const proj = (g: { lat: number; lon: number }) => ({
    x: (g.lon - lng) * mPerLng,
    y: (g.lat - lat) * mPerLat,
  });
  if (geom.length === 1) {
    const p = proj(geom[0]);
    return Math.hypot(p.x, p.y);
  }
  let min = Infinity;
  for (let i = 0; i < geom.length - 1; i++) {
    const a = proj(geom[i]);
    const b = proj(geom[i + 1]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? (-a.x * dx + -a.y * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    min = Math.min(min, Math.hypot(cx, cy));
  }
  return min;
}

function defaultPoiName(category: string): string {
  switch (category) {
    case "grocery": return "Grocery store";
    case "school": return "School";
    case "health": return "Hospital / clinic";
    case "recreation": return "Park";
    case "transport": return "Highway interchange";
    default: return "Place";
  }
}

/** Real nearby amenities from OSM. Returns null on network failure → mock. */
async function amenitiesFromOSM(c: LatLng): Promise<Amenities | null> {
  const ql =
    `[out:json][timeout:25];(` +
    `nwr["shop"="supermarket"](around:11000,${c.lat},${c.lng});` +
    `nwr["shop"="grocery"](around:11000,${c.lat},${c.lng});` +
    `nwr["amenity"="school"](around:6000,${c.lat},${c.lng});` +
    `nwr["amenity"="hospital"](around:16000,${c.lat},${c.lng});` +
    `nwr["amenity"="clinic"](around:8000,${c.lat},${c.lng});` +
    `nwr["healthcare"="urgent_care"](around:12000,${c.lat},${c.lng});` +
    `nwr["leisure"="park"](around:6000,${c.lat},${c.lng});` +
    `nwr["highway"="motorway_junction"](around:18000,${c.lat},${c.lng});` +
    `);out center tags;`;
  const els = await overpass(ql);
  if (!els) return null; // network/parse failure → fall back to mock

  type Cand = { name: string; category: string; distanceMiles: number; latLng: { lat: number; lng: number } };
  const cands: Cand[] = [];
  for (const el of els) {
    const ctr = elCenter(el);
    if (!ctr) continue;
    const t = el.tags || {};
    let category: string | null = null;
    if (t.shop === "supermarket" || t.shop === "grocery") category = "grocery";
    else if (t.amenity === "school") category = "school";
    else if (t.amenity === "hospital" || t.amenity === "clinic" || t.healthcare === "urgent_care") category = "health";
    else if (t.leisure === "park") category = "recreation";
    else if (t.highway === "motorway_junction") category = "transport";
    if (!category) continue;
    cands.push({
      name: t.name || defaultPoiName(category),
      category,
      distanceMiles: round(haversineMiles(c.lat, c.lng, ctr.lat, ctr.lng)),
      latLng: ctr,
    });
  }

  const nearestIn = (cat: string) =>
    cands
      .filter((x) => x.category === cat)
      .sort((a, b) => a.distanceMiles - b.distanceMiles)[0] || null;

  const grocery = nearestIn("grocery");
  const pois: Poi[] = [];
  for (const cat of ["school", "health", "recreation", "transport"]) {
    const n = nearestIn(cat);
    if (n) pois.push({ name: n.name, category: n.category, distanceMiles: n.distanceMiles, latLng: n.latLng });
  }

  return {
    nearestGrocery: grocery
      ? f<Poi>(
          { name: grocery.name, category: "supermarket", distanceMiles: grocery.distanceMiles, latLng: grocery.latLng },
          "overpass-osm",
          0.8,
          "mi"
        )
      : f<Poi>(null, "overpass-osm", 0.7, "mi", "no grocery within ~7 mi"),
    pois: f(pois, "overpass-osm", 0.8),
  };
}

/** Real nearest road from OSM. Returns null on network failure → mock. */
async function accessFromOSM(c: LatLng): Promise<Access | null> {
  const ql =
    `[out:json][timeout:25];` +
    `way["highway"]["name"](around:500,${c.lat},${c.lng});` +
    `out geom;`;
  const els = await overpass(ql);
  if (!els) return null; // network/parse failure → fall back to mock

  if (els.length === 0) {
    return {
      nearestRoad: f<string>(null, "overpass-osm", 0.7, null, "no named road within ~0.3 mi"),
      roadFrontageFt: f<number>(null, "overpass-osm", 0.6, "ft", "needs parcel boundary (Regrid) for exact frontage"),
      distanceToRoadMiles: f<number>(null, "overpass-osm", 0.7, "mi"),
    };
  }

  let best: { name: string; meters: number } | null = null;
  for (const w of els) {
    const meters = metersPointToWay(c.lat, c.lng, w.geometry || []);
    if (meters < (best?.meters ?? Infinity)) best = { name: w.tags?.name || "Unnamed road", meters };
  }
  const distMi = round((best!.meters / 1609.34) * 100) / 100;
  return {
    nearestRoad: f(best!.name, "overpass-osm", 0.85),
    // Exact frontage requires the real parcel boundary (Regrid); flagged honestly.
    roadFrontageFt: f<number>(null, "overpass-osm", 0.5, "ft", "needs parcel boundary (Regrid) for exact frontage"),
    distanceToRoadMiles: f(round(distMi), "overpass-osm", 0.85, "mi"),
  };
}

/* ── Federal GIS sources (shared, FREE, no key) ─────────────────────────── */

/** GET an ArcGIS REST endpoint as JSON. Returns parsed object or null. */
async function arcgisQuery(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "landholder/0.1" },
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.error) return null;
    return data;
  } catch {
    return null;
  }
}

/** Nearest distance (miles) from a point to an ArcGIS geometry (paths/rings of [lng,lat]). */
function nearestMilesToArcgis(lat: number, lng: number, geom: any): number {
  const groups: number[][][] = geom?.paths ?? geom?.rings ?? [];
  if (!groups.length) return Infinity;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const mPerLat = 111_320;
  const mPerLng = 111_320 * Math.cos(toRad(lat));
  let min = Infinity;
  for (const line of groups) {
    for (let i = 0; i < line.length; i++) {
      const ax = (line[i][0] - lng) * mPerLng;
      const ay = (line[i][1] - lat) * mPerLat;
      if (i < line.length - 1) {
        const bx = (line[i + 1][0] - lng) * mPerLng;
        const by = (line[i + 1][1] - lat) * mPerLat;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 ? (-ax * dx + -ay * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        min = Math.min(min, Math.hypot(ax + t * dx, ay + t * dy));
      } else {
        min = Math.min(min, Math.hypot(ax, ay));
      }
    }
  }
  return min / 1609.34;
}

/* ── FEMA NFHL flood zone (point intersect) ─────────────────────────────── */
async function floodFromFEMA(c: LatLng): Promise<Flood | null> {
  const url =
    "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query" +
    `?geometry=${c.lng},${c.lat}&geometryType=esriGeometryPoint&inSR=4326` +
    "&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY" +
    "&returnGeometry=false&f=json";
  const data = await arcgisQuery(url);
  if (data === null) return null; // service error → fall back to mock
  const feat = (data.features || [])[0];
  if (!feat) {
    // No NFHL polygon at this point → outside any mapped Special Flood Hazard Area.
    return {
      zone: f("X", "fema-nfhl", 0.75, null, "no Special Flood Hazard Area mapped here"),
      inFloodway: f(false, "fema-nfhl", 0.75),
    };
  }
  const a = feat.attributes || {};
  const zone = String(a.FLD_ZONE || "X");
  const subty = a.ZONE_SUBTY ? String(a.ZONE_SUBTY) : null;
  const minimal = /^(X|D)$/i.test(zone);
  return {
    zone: f(zone, "fema-nfhl", 0.9, null, subty || (minimal ? "minimal hazard" : "special flood hazard area")),
    inFloodway: f(/floodway/i.test(subty || ""), "fema-nfhl", 0.9),
  };
}

/* ── USDA SSURGO soil + drainage (SDA spatial SQL) ──────────────────────── */
async function soilFromSSURGO(c: LatLng): Promise<Soil | null> {
  const sql =
    "SELECT TOP 1 mu.muname, co.drainagecl " +
    "FROM mapunit mu INNER JOIN component co ON co.mukey = mu.mukey " +
    "WHERE mu.mukey IN (SELECT mukey FROM " +
    `SDA_Get_Mukey_from_intersection_with_WktWgs84('point(${c.lng} ${c.lat})')) ` +
    "ORDER BY co.comppct_r DESC";
  let data: any = null;
  try {
    const res = await fetch("https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "landholder/0.1" },
      body: JSON.stringify({ query: sql, format: "JSON+COLUMNNAME" }),
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }
  const rows = data?.Table;
  if (!Array.isArray(rows) || rows.length < 2) return null; // no soil mapped → mock
  const [muname, drainagecl] = rows[1];
  const drain = String(drainagecl || "").toLowerCase();
  const suit =
    drain.includes("well drained") && !drain.includes("moderately")
      ? "well suited"
      : drain.includes("poor") || drain.includes("very poor")
      ? "limited"
      : "moderate";
  return {
    dominantType: f(muname || null, "usda-ssurgo", 0.85),
    drainageClass: f(drainagecl || null, "usda-ssurgo", 0.85),
    septicSuitability: f(suit, "usda-ssurgo", 0.6, null, "derived from soil drainage class"),
  };
}

/* ── USGS NHD nearest stream / waterbody ────────────────────────────────── */
function nhdFlowType(ft: any): string {
  const m: Record<number, string> = {
    460: "river / stream", 558: "stream channel", 336: "canal / ditch",
    334: "connector", 566: "coastline", 420: "underground stream", 350: "siphon",
  };
  return m[Number(ft)] || "stream";
}
function nhdBodyType(ft: any): string {
  const m: Record<number, string> = {
    390: "lake / pond", 436: "reservoir", 361: "playa",
    466: "swamp / marsh", 493: "estuary", 378: "ice mass",
  };
  return m[Number(ft)] || "waterbody";
}
async function waterFromNHD(c: LatLng): Promise<Water | null> {
  const d = 0.04; // ~2.7 mi search box
  const bbox = `${c.lng - d},${c.lat - d},${c.lng + d},${c.lat + d}`;
  const base = "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer";
  const q = (layer: number) =>
    `${base}/${layer}/query?geometry=${bbox}&geometryType=esriGeometryEnvelope` +
    "&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=gnis_name,ftype" +
    // Generalize geometry (~50 m) — full flowline geometry is huge and times the
    // service out; generalized is plenty accurate for a distance-to-water screen.
    "&returnGeometry=true&maxAllowableOffset=0.0005&outSR=4326&resultRecordCount=50&f=json";
  const [flow, body] = await Promise.all([arcgisQuery(q(6)), arcgisQuery(q(12))]);
  if (flow === null && body === null) return null; // both failed → mock

  const cands: Array<{ type: string; miles: number }> = [];
  const collect = (feats: any[], kind: "flow" | "body") => {
    for (const ft of feats || []) {
      const a = ft.attributes || {};
      const name = a.gnis_name || a.GNIS_NAME;
      const code = a.ftype ?? a.FTYPE;
      cands.push({
        type: name || (kind === "flow" ? nhdFlowType(code) : nhdBodyType(code)),
        miles: nearestMilesToArcgis(c.lat, c.lng, ft.geometry),
      });
    }
  };
  collect(flow?.features, "flow");
  collect(body?.features, "body");

  if (!cands.length) {
    return {
      nearestFeatureType: f<string>(null, "usgs-nhd", 0.7, null, "no NHD water within ~2.7 mi"),
      distanceToWaterMiles: f<number>(null, "usgs-nhd", 0.7, "mi"),
    };
  }
  const best = cands.reduce((m, x) => (x.miles < m.miles ? x : m));
  return {
    nearestFeatureType: f(best.type, "usgs-nhd", 0.85),
    distanceToWaterMiles: f(round(best.miles), "usgs-nhd", 0.85, "mi"),
  };
}

/* ── USGS 3DEP elevation + sampled slope (EPQS) ─────────────────────────── */
async function epqsElevationFt(
  lat: number,
  lng: number,
  timeoutMs: number
): Promise<number | null> {
  try {
    const res = await fetch(
      `https://epqs.nationalmap.gov/v1/json?x=${lng}&y=${lat}&units=Feet&wkid=4326`,
      { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" }, cache: "no-store" }
    );
    if (!res.ok) return null;
    const d = await res.json();
    const v = Number(d?.value);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
async function terrainFromEPQS(c: LatLng): Promise<Terrain | null> {
  // Sample center + one point east + one north (~60 m) to estimate slope.
  // EPQS is flaky — give the critical center elevation more headroom than the
  // two slope-neighbour samples, so a slow neighbour drops slope (not elevation)
  // and the card never stalls on the full timeout.
  const run = 60;
  const dN = run / 111_320;
  const dE = run / (111_320 * Math.cos((c.lat * Math.PI) / 180));
  const [zc, ze, zn] = await Promise.all([
    epqsElevationFt(c.lat, c.lng, 9000),
    epqsElevationFt(c.lat, c.lng + dE, 6000),
    epqsElevationFt(c.lat + dN, c.lng, 6000),
  ]);
  if (zc === null) return null; // elevation failed → mock
  let slopePct: number | null = null;
  if (ze !== null && zn !== null) {
    const gx = ((ze - zc) * 0.3048) / run; // rise(m) / run(m)
    const gy = ((zn - zc) * 0.3048) / run;
    slopePct = round(Math.sqrt(gx * gx + gy * gy) * 100);
  }
  return {
    elevationFt: f(round(zc), "usgs-3dep", 0.9, "ft"),
    slopePct: f(slopePct, "usgs-3dep", slopePct === null ? 0.3 : 0.75, "%", "sampled over 60 m"),
  };
}

/* ── helpers ──────────────────────────────────────────────────────────── */
function pick<T>(arr: T[], h: number): T {
  return arr[h % arr.length];
}
function round(n: number) {
  return Math.round(n * 100) / 100;
}
