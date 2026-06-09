-- ─────────────────────────────────────────────────────────────────────────
-- landholder.com — Stage 4 cache store
-- Postgres + PostGIS. One row per parcel; the whole Site Profile lives in
-- `profile` (JSONB). Geometry is mirrored into a PostGIS column so we can run
-- spatial intersects in-house later (migrating the hot NHD/SSURGO/Census
-- datasets off per-call external services once volume climbs).
-- ─────────────────────────────────────────────────────────────────────────

create extension if not exists postgis;

create table if not exists site_profiles (
  parcel_id    text primary key,
  county_fips  text,
  version      text not null,
  geom         geometry(MultiPolygon, 4326),   -- parcel boundary, mirrored
  centroid     geometry(Point, 4326),
  profile      jsonb not null,                 -- the full Site Profile contract
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null            -- TTL; cache miss when in the past
);

-- Fast cache freshness checks.
create index if not exists site_profiles_expires_idx
  on site_profiles (expires_at);

-- County rollups for analytics / demographics joins.
create index if not exists site_profiles_county_idx
  on site_profiles (county_fips);

-- Spatial index for in-house intersects against bulk datasets.
create index if not exists site_profiles_geom_idx
  on site_profiles using gist (geom);

create index if not exists site_profiles_centroid_idx
  on site_profiles using gist (centroid);

-- ── Optional: where the bulk in-house datasets will land later ───────────
-- These start empty. Load NHD flowlines, SSURGO map units, and Census TIGER
-- county polygons here, then run spatial intersects locally instead of
-- per-lookup external calls. (Left as a forward-looking stub.)
--
-- create table if not exists nhd_flowlines (id bigserial primary key, geom geometry(LineString,4326));
-- create index if not exists nhd_flowlines_geom_idx on nhd_flowlines using gist (geom);
--
-- create table if not exists ssurgo_mapunits (mukey text primary key, muname text, drainagecl text, geom geometry(MultiPolygon,4326));
-- create index if not exists ssurgo_geom_idx on ssurgo_mapunits using gist (geom);
