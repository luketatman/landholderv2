/**
 * STAGE 4 — Cache + store, keyed by parcel ID.  (Railway Postgres + PostGIS)
 *
 * Parcel-level data barely changes, so caching is what makes the unit
 * economics work: the second viewer of a parcel costs ~$0.
 *
 * If DATABASE_URL is set we use raw Postgres (node-postgres) against the
 * `site_profiles` table; otherwise we fall back to a process-memory map
 * (dev only — resets on restart and is per-instance).
 *
 * Cache reads/writes are best-effort: a DB hiccup must never break a lookup,
 * so failures here are swallowed and the pipeline carries on uncached.
 */
import { Pool } from "pg";
import { env } from "./env";
import type { SiteProfile } from "./types";

const mem = new Map<string, SiteProfile>();

/* ── lazy singleton pool ────────────────────────────────────────────────── */
let _pool: Pool | null = null;
function pool(): Pool | null {
  if (!env.databaseUrl) return null;
  if (_pool) return _pool;
  const host = env.databaseUrl;
  const local = /localhost|127\.0\.0\.1|\.railway\.internal/.test(host);
  _pool = new Pool({
    connectionString: env.databaseUrl,
    ssl: env.databaseSsl && !local ? { rejectUnauthorized: false } : undefined,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
  });
  return _pool;
}

/* ── read ───────────────────────────────────────────────────────────────── */
export async function getCachedProfile(
  parcelId: string
): Promise<SiteProfile | null> {
  const p = pool();
  if (p) {
    try {
      const { rows } = await p.query(
        `select profile from site_profiles
           where parcel_id = $1 and expires_at > now()
           limit 1`,
        [parcelId]
      );
      return rows[0]?.profile ?? null;
    } catch (e) {
      console.error("[cache] read failed:", (e as Error).message);
      return null;
    }
  }
  const hit = mem.get(parcelId);
  if (hit && new Date(hit.expiresAt) > new Date()) return hit;
  return null;
}

/* ── write (best-effort) ────────────────────────────────────────────────── */
export async function putCachedProfile(profile: SiteProfile): Promise<void> {
  const p = pool();
  if (!p) {
    mem.set(profile.parcelId, profile);
    return;
  }
  try {
    const geojson = profile.parcel.geometry
      ? JSON.stringify(profile.parcel.geometry)
      : null;
    const { lat, lng } = profile.parcel.centroid;

    await p.query(
      `insert into site_profiles
         (parcel_id, county_fips, version, geom, centroid, profile, expires_at)
       values (
         $1, $2, $3,
         case when $4::text is null then null
              else st_multi(st_setsrid(st_geomfromgeojson($4), 4326)) end,
         st_setsrid(st_makepoint($5, $6), 4326),
         $7::jsonb, $8::timestamptz
       )
       on conflict (parcel_id) do update set
         county_fips = excluded.county_fips,
         version     = excluded.version,
         geom        = excluded.geom,
         centroid    = excluded.centroid,
         profile     = excluded.profile,
         expires_at  = excluded.expires_at,
         created_at  = now()`,
      [
        profile.parcelId,
        profile.parcel.countyFips,
        profile.version,
        geojson,
        lng,
        lat,
        JSON.stringify(profile),
        profile.expiresAt,
      ]
    );
  } catch (e) {
    // Non-fatal: log and move on. Common first-run cause: migration not applied.
    console.error("[cache] write failed:", (e as Error).message);
  }
}
