# Deploying landholder to Railway (beta)

This is the all-Railway path: the Next.js app **and** the Postgres/PostGIS
database both live on Railway, in one project, on one bill. The app reads the
database over Railway's private network, so there's no per-request timeout to
worry about (Railway runs a persistent Node server, not serverless functions).

You'll do this once. Budget ~20 minutes.

---

## 0. What you need

- A [GitHub](https://github.com) account.
- A [Railway](https://railway.com) account (sign in with GitHub).
- `git` on your machine. Optional but handy: the
  [Railway CLI](https://docs.railway.com/guides/cli) (`npm i -g @railway/cli`).
- API keys are **not** needed to launch — the app runs on mock + free data
  until you flip `USE_MOCKS=false`. Add Regrid/Google/Census later (step 6).

---

## 1. Push the repo to GitHub

From the project folder:

```bash
git init
git add .
git commit -m "landholder: Layer 1 + Layer 2"
git branch -M main
# create an EMPTY repo on github.com first (no README), then:
git remote add origin https://github.com/<you>/landholder.git
git push -u origin main
```

`.env.local` is git-ignored, so no secrets are pushed. Good.

---

## 2. Create the Railway project + deploy the app

1. Railway dashboard → **New Project** → **Deploy from GitHub repo** → pick your
   `landholder` repo.
2. Railway auto-detects Next.js (via Nixpacks) and runs `npm run build` then
   `npm run start`. No Dockerfile needed.
3. The first deploy will succeed but the app is not reachable until you add a
   domain: open the service → **Settings → Networking → Generate Domain**.
   You'll get a `*.up.railway.app` URL.

At this point the app is live on **mock data** (no DB yet) — the in-memory cache
fallback handles caching within a single instance.

---

## 3. Add the Postgres + PostGIS database

The default Railway Postgres does **not** include PostGIS. Use the dedicated
template instead:

1. In the same project canvas → **+ New** → **Database**, or **+ New →
   Template** and search **"PostgreSQL with PostGIS"** (the PostGIS + H3
   template). Deploy it into this project.
2. This gives you a Postgres service with the `postgis` extension already
   available.

> If you accidentally added a plain Postgres, you can still enable PostGIS by
> connecting (step 5) and running `create extension if not exists postgis;`
> — but the template saves you the trouble.

---

## 4. Wire the app to the database

In the **app** service → **Variables**, add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{ Postgres.DATABASE_URL }}` — a *reference* to the DB service. Replace `Postgres` with that service's actual name if different. |
| `DATABASE_SSL` | `false` — you're connecting over Railway's private network. |
| `USE_MOCKS` | `true` for now (flip to `false` when you add real keys). |
| `SITE_PROFILE_TTL_DAYS` | `60` |

Using the `${{ ... }}` reference (not a pasted string) means the URL stays
correct if Railway rotates the DB credentials.

Save → Railway redeploys the app with the DB connection.

---

## 5. Apply the migration (create the `site_profiles` table)

The table and PostGIS indexes are defined in
`supabase/migrations/0001_site_profiles.sql`. Run it once against the Railway DB.

**Easiest — Railway CLI:**

```bash
railway link                       # pick your project
railway connect Postgres           # opens psql on the DB service
# then in the psql prompt:
\i supabase/migrations/0001_site_profiles.sql
\q
```

**Or pipe it in directly** (grab the DB's *public* connection string from the
Postgres service → **Connect** tab):

```bash
psql "postgresql://postgres:...@<public-host>:<port>/railway" \
  -f supabase/migrations/0001_site_profiles.sql
```

Verify it worked:

```sql
select postgis_version();                       -- extension present
\d site_profiles                                -- table + columns exist
```

The app's cache writes are **best-effort** — if the migration isn't applied yet,
lookups still work, they just don't cache (you'll see `[cache] write failed` in
the logs). Once the table exists, caching kicks in automatically.

---

## 6. Going live with real data (when ready)

Add these to the **app** service Variables, then set `USE_MOCKS=false`:

| Variable | Source | Notes |
|---|---|---|
| `REGRID_API_TOKEN` | [regrid.com/api](https://regrid.com/api) | The anchor — paid. Nothing resolves to a real parcel without it. |
| `GOOGLE_MAPS_API_KEY` | Google Cloud console | Geocode fallback + Places (grocery/POIs). Paid. |
| `CENSUS_API_KEY` | [census.gov key signup](https://api.census.gov/data/key_signup.html) | Real demographics. Free. |

Each source flips itself independently: present its key → real endpoint;
absent → mock. So you can light them up one at a time and watch each card go
from "low confidence / mock" to real.

---

## 7. Smoke-test the live deployment

```bash
# parcel resolution (fast path)
curl -s -X POST https://<your-app>.up.railway.app/api/parcel \
  -H 'Content-Type: application/json' \
  -d '{"query":"123 Cedar Ridge Rd, Asheville NC"}'

# open the site and run a lookup end-to-end
open https://<your-app>.up.railway.app
```

A repeat lookup of the same parcel should return instantly and show the
**cached** badge — that's the DB cache working.

---

## Cost notes for beta

- Railway bills usage-based; a low-traffic beta (app + small Postgres) is cheap.
  Set a **usage limit** in the project settings so there are no surprises.
- Your only *variable* cost once live is Regrid + Google per **unique uncached**
  parcel. The DB cache (30–90 day TTL) is what keeps that bill flat — the second
  viewer of any parcel costs ~$0. Keep `SITE_PROFILE_TTL_DAYS` generous.

---

## Operational checklist

- [ ] Repo on GitHub, `.env.local` not committed
- [ ] App service deployed + domain generated
- [ ] PostGIS database in the same project
- [ ] `DATABASE_URL` referenced (not pasted), `DATABASE_SSL=false`
- [ ] Migration applied; `postgis_version()` returns a value
- [ ] Mock lookup works end-to-end; repeat shows **cached**
- [ ] (Later) real keys added, `USE_MOCKS=false`, cards show real sources
- [ ] Usage limit set on the Railway project
