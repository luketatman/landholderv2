# landholder — Layer 1: Site Intelligence

The parcel is the single canonical key. One input (address / pin / `lat,lng`) →
one normalized **Site Profile** object that the render and feasibility layers
both read from.

This is the Layer 1 scaffold: geocode → parcel resolution → parallel
enrichment → normalize → cache. It runs **fully on mock + free data today**
with zero paid API calls, and flips to live data by adding two keys.

## Run it

```bash
cp .env.example .env.local      # defaults are fine — USE_MOCKS=true
npm install
npm run dev                     # http://localhost:3000
```

Type an address, a parcel number, or `lat,lng` and hit Analyze. Parcel +
zoning paint immediately; the enrichment cards fill in after.

## The pipeline

```
input ─▶ Stage 0 geocode ─▶ Stage 1 resolve PARCEL (the anchor)
        ─▶ Stage 2 fan-out enrichment (all sources in parallel)
        ─▶ Stage 3 normalize → Site Profile ─▶ Stage 4 cache by parcel ID
```

Two API routes keep the slow services off the first render:

- `POST /api/parcel` — Stage 0→1. Geocodes + resolves the anchor parcel,
  returns parcel + zoning **fast**.
- `POST /api/enrich` — Stage 2→4. Runs the parallel fan-out, normalizes to a
  Site Profile, caches it. Cache-first: a repeat parcel returns instantly.

## File map

| Path | Role |
|---|---|
| `lib/types.ts` | **The Site Profile contract** — versioned (`1.0.0`), every field carries value/unit/source/confidence. Freeze this; both downstream layers depend on it. |
| `lib/geocode.ts` | Stage 0. Census geocoder (free) → Google fallback. `lat,lng` treated as a pin. |
| `lib/parcel.ts` | Stage 1, the anchor. Regrid point lookup + deterministic mock. |
| `lib/sources.ts` | Stage 2. One function per layer (demographics, amenities, flood, soil, water, wetlands, terrain, access, utilities). Each has a mock + a marked real-endpoint block. |
| `lib/enrich.ts` | Stage 2→3. Parallel fan-out + normalize into one Site Profile; tolerates per-source failure. |
| `lib/cache.ts` | Stage 4. Supabase/PostGIS by parcel ID, in-memory fallback. |
| `supabase/migrations/0001_site_profiles.sql` | PostGIS table + spatial indexes + stubs for in-housing the bulk datasets. |
| `app/page.tsx` | Search UI; parcel first, enrichment streams in. |

## Going live

Everything is gated behind one switch. To turn on real data:

1. Set `USE_MOCKS=false` in `.env.local`.
2. Add the two paid keys: `REGRID_API_TOKEN` (the anchor — nothing resolves
   without it) and `GOOGLE_MAPS_API_KEY` (geocode fallback + Places).
3. Add the free `CENSUS_API_KEY` for real demographics.
4. Each source flips itself: if its key is present it calls the real endpoint,
   otherwise it falls back to mock. So you can light up sources one at a time.

The real federal endpoints (FEMA NFHL, USDA SSURGO, USGS NHD/3DEP, USFWS NWI,
Overpass) are documented inline in `lib/sources.ts` next to each function.
Confirm exact URLs against live docs at build time — the federal GIS services
move occasionally.

### Wiring the cache (production)

Set `DATABASE_URL` (Railway Postgres + PostGIS), run the migration
(`supabase/migrations/0001_site_profiles.sql`), and `lib/cache.ts` switches
from in-memory to Postgres automatically. Cache hard — parcel data barely
changes, so a 30–90 day TTL means the second viewer of a parcel costs ~$0.
That caching is what makes the unit economics work.

**Deploying?** See **[DEPLOYMENT.md](./DEPLOYMENT.md)** — a step-by-step
all-Railway beta runbook (GitHub → app service → PostGIS database → migration →
go-live keys).

## Known gap

**Utilities / power** — no clean free API. Flagged explicitly in the Site
Profile (`enrichment.utilities.status = "gap"`) rather than faked. Wire a
regional LDC/ISO source or a paid provider when ready.

## Layer 2 — Feasibility + Site Plan

Consumes a finished Site Profile + a user goal and returns what can actually go
on the parcel. Pure, deterministic, no external calls.

- `POST /api/feasibility` — body `{ profile, projectType, params? }` →
  `FeasibilityResult` with a buildable **envelope**, a **program**, and an
  overhead **site-plan SVG**.
- Project types: retreat, hotel, multifamily, single-family subdivision,
  retail, mixed use.

How the envelope is derived (all high-level / order-of-magnitude, every
assumption emitted so a reviewer can challenge any number):

1. Gross site → flood / wetlands / slope deductions → **net developable**.
2. Setback-limited footprint envelope (parcel approximated as a square, inset
   by setbacks).
3. **FAR cap** on total floor area (lot area × FAR).
4. Footprint = lesser of coverage-of-net-developable and the setback box;
   floors derived to realize the FAR, capped by product type.
5. Program (keys / units / lots / GLA, parking, open space) from the buildable
   gross sq ft per type.

| Path | Role |
|---|---|
| `lib/feasibilityTypes.ts` | **Layer 2 contract** (`1.0.0`) — envelope, program, site plan, project-type enum. |
| `lib/program.ts` | Envelope + program math. `TYPE_DEFAULTS` is the tuning table (coverage, floors, gsf/unit, parking ratios) — match it to your underwriting. |
| `lib/siteplan.ts` | Deterministic overhead SVG: parcel, setback line, packed footprints, parking field, access drive, no-build constraint band, north arrow + honest (feet) scale bar. |
| `lib/feasibility.ts` | Orchestrator + flags (permitted-use check, flood/wetlands warnings, mock-data notice). |

The result carries a `costEstimate: null` hook — that's where the next chapter
(cost-to-build engine) plugs in.

## What this is and isn't

Layer 1 is a standalone, sellable Site Profile engine. Layer 2 turns it into a
feasibility tool. Both are versioned contracts (`SiteProfile 1.0.0`,
`Feasibility 1.0.0`) so the render and cost layers can be built against them
independently. The site plan is schematic massing — "outline the buildings,"
not engineering. The envelope math is order-of-magnitude screening, not a
substitute for a civil engineer or a zoning attorney.
