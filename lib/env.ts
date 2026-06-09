/** Central env access. Keeps `process.env` lookups in one place. */
export const env = {
  useMocks: (process.env.USE_MOCKS ?? "true").toLowerCase() !== "false",
  regridToken: process.env.REGRID_API_TOKEN || "",
  googleKey: process.env.GOOGLE_MAPS_API_KEY || "",
  censusKey: process.env.CENSUS_API_KEY || "",
  // Census demographics are FREE and work even without a key, so they're
  // decoupled from the paid USE_MOCKS switch: real Census data is used whenever
  // possible, regardless of Regrid/Google. Set USE_CENSUS=false to force mocks.
  censusEnabled: (process.env.USE_CENSUS ?? "true").toLowerCase() !== "false",
  // OpenStreetMap (Overpass) is also FREE + keyless — amenities & road access.
  // Decoupled from USE_MOCKS the same way Census is. Set USE_OSM=false to mock.
  osmEnabled: (process.env.USE_OSM ?? "true").toLowerCase() !== "false",
  // Free FEDERAL GIS sources (FEMA flood, USDA soil, USGS water + elevation).
  // Keyless, so also decoupled from USE_MOCKS. Set USE_FED=false to force mocks.
  fedEnabled: (process.env.USE_FED ?? "true").toLowerCase() !== "false",
  // Anthropic Claude — powers the design-studio chatbot (Layer 3 Phase 2).
  // Paid (cheap per message). Empty → chat is disabled with a clear message.
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  // Raw Postgres connection (Railway PostGIS). Empty → in-memory cache fallback.
  databaseUrl: process.env.DATABASE_URL || "",
  // Force TLS on the DB connection (needed for Railway's PUBLIC proxy host;
  // not needed over the private *.railway.internal network).
  databaseSsl: (process.env.DATABASE_SSL ?? "").toLowerCase() === "true",
  ttlDays: Number(process.env.SITE_PROFILE_TTL_DAYS || "60"),
};

/** True only when we have what we need to hit a real source for `name`. */
export function canGoLive(name: "regrid" | "google" | "census"): boolean {
  if (env.useMocks) return false;
  if (name === "regrid") return Boolean(env.regridToken);
  if (name === "google") return Boolean(env.googleKey);
  if (name === "census") return Boolean(env.censusKey);
  return false;
}

export function now(): string {
  return new Date().toISOString();
}
