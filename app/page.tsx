"use client";

import { useState, useRef } from "react";
import type {
  Parcel,
  SiteProfile,
  ParcelResponse,
  Field,
  EnrichmentStatus,
} from "@/lib/types";
import {
  PROJECT_TYPE_LABELS,
  type ProjectType,
  type FeasibilityResult,
  type StudioElement,
} from "@/lib/feasibilityTypes";
import { aerialFrame } from "@/lib/geo";
import { seedElements } from "@/lib/studioLayout";
import SitePlanStudio from "@/app/components/SitePlanStudio";
import PlanChat from "@/app/components/PlanChat";
import PricingStudio from "@/app/components/PricingStudio";
import ReportStudio from "@/app/components/ReportStudio";
import type { CostEstimate, BuildSpec } from "@/lib/cost";

/* ── small presentational helpers ──────────────────────────────────────── */
function fmt(v: unknown, unit?: string | null): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") {
    const s = v % 1 === 0 ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return unit ? `${s} ${unit}` : s;
  }
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

function Row<T>({ k, f }: { k: string; f?: Field<T> }) {
  return (
    <div className="row">
      <span className="k">{k}</span>
      <span className="v">
        {f ? fmt(f.value as any, f.unit) : "—"}
        {f && (
          <span className="prov">
            {f.source}
            {f.confidence < 0.4 ? " · low confidence" : ""}
          </span>
        )}
      </span>
    </div>
  );
}

function StatusPill({ s }: { s: EnrichmentStatus }) {
  return (
    <span className="status">
      <span className={`pill ${s}`} />
      {s}
    </span>
  );
}

type Suggestion = { label: string; lat: number; lng: number };

/** Format a Photon properties object into a one-line US address label. */
function fmtSuggestion(p: any): string {
  const street = [p.housenumber, p.street].filter(Boolean).join(" ");
  const main = street || p.name || p.city || "Unnamed";
  const sub = [p.city, p.state, p.postcode].filter(Boolean).join(", ");
  return [main, sub].filter(Boolean).join(", ");
}

/**
 * Decide whether to fire address autocomplete. We only suggest for things that
 * read like a place/address. A parcel number (digits + dashes, often no spaces)
 * or a raw `lat,lng` pair is meant to be typed and submitted directly, so we
 * skip the dropdown for those instead of showing "no matches".
 */
function looksLikeAddress(v: string): boolean {
  const t = v.trim();
  if (t.length < 3) return false;
  if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(t)) return false; // lat,lng
  if (!/[a-z]/i.test(t)) return false; // pure digits/dashes → parcel number
  // letters + digits, no spaces (e.g. "R0123-456", "APN12345") → parcel id
  if (!/\s/.test(t) && /\d/.test(t)) return false;
  return true;
}

/* ── Overhead satellite imagery (Esri World Imagery — free, no key) ──────── */
function SiteMap({ parcel }: { parcel: Parcel }) {
  const frame = aerialFrame(parcel);
  return (
    <div className="map sitemap">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={frame.url} alt={`Overhead satellite view of parcel ${parcel.parcelId}`} />
      {frame.parcelPoints && (
        <svg
          className="parcel-overlay"
          viewBox={`0 0 ${frame.W} ${frame.H}`}
          preserveAspectRatio="none"
        >
          <polygon points={frame.parcelPoints} />
        </svg>
      )}
      <span className="maptag">▣ Satellite · Esri World Imagery</span>
    </div>
  );
}

export default function Home() {
  const [query, setQuery] = useState("");
  // Real-address autocomplete (Photon / Komoot — free, no key).
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSug, setShowSug] = useState(false);
  const [sugLoading, setSugLoading] = useState(false);
  const acTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [head, setHead] = useState<ParcelResponse | null>(null);
  const [profile, setProfile] = useState<SiteProfile | null>(null);
  const [enriching, setEnriching] = useState(false);

  // ── Layer 2 state ──
  const [projectType, setProjectType] = useState<ProjectType | null>(null);
  const [feas, setFeas] = useState<FeasibilityResult | null>(null);
  const [planning, setPlanning] = useState(false);
  const [approved, setApproved] = useState(false);
  // ── Layer 3 state: editable studio elements + cost estimate ──
  const [studioEls, setStudioEls] = useState<StudioElement[]>([]);
  const [costEstimate, setCostEstimate] = useState<CostEstimate | null>(null);
  const [buildSpec, setBuildSpec] = useState<BuildSpec | null>(null);

  function resetLayer2() {
    setProjectType(null);
    setFeas(null);
    setPlanning(false);
    setApproved(false);
    setStudioEls([]);
    setCostEstimate(null);
    setBuildSpec(null);
  }

  async function choose(type: ProjectType) {
    if (!profile) return;
    setProjectType(type);
    setFeas(null);
    setApproved(false);
    setStudioEls([]);
    setCostEstimate(null);
    setBuildSpec(null);
    setPlanning(true);
    try {
      const r = await fetch("/api/feasibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, projectType: type }),
      });
      const data = await r.json();
      if (r.ok) {
        const result = data.result as FeasibilityResult;
        setFeas(result);
        // Seed the editable studio from the deterministic program.
        setStudioEls(seedElements(profile, result.program, result.envelope));
      }
    } finally {
      setPlanning(false);
    }
  }

  // ── Real-address autocomplete (ported from landholder-prototype.html) ──
  function onQueryChange(v: string) {
    setQuery(v);
    if (acTimer.current) clearTimeout(acTimer.current);
    // Only autocomplete address-like input. Parcel numbers and lat,lng are
    // typed and submitted directly — no dropdown for those.
    if (!looksLikeAddress(v)) {
      setSuggestions([]);
      setShowSug(false);
      return;
    }
    acTimer.current = setTimeout(() => fetchSuggestions(v.trim()), 250);
  }

  async function fetchSuggestions(q: string) {
    setSugLoading(true);
    setShowSug(true);
    try {
      const r = await fetch(
        "https://photon.komoot.io/api/?limit=6&lang=en&q=" + encodeURIComponent(q)
      );
      const d = await r.json();
      const items: Suggestion[] = (d.features || [])
        .filter(
          (f: any) =>
            !f.properties.countrycode || f.properties.countrycode === "US"
        )
        .slice(0, 6)
        .map((f: any) => ({
          label: fmtSuggestion(f.properties),
          lat: f.geometry.coordinates[1],
          lng: f.geometry.coordinates[0],
        }));
      setSuggestions(items);
    } catch {
      setSuggestions([]);
    } finally {
      setSugLoading(false);
    }
  }

  function pickSuggestion(s: Suggestion) {
    // Show the human-readable address, but resolve from the EXACT picked
    // coordinates so the parcel + real Census county land on the right spot.
    setQuery(s.label);
    setSuggestions([]);
    setShowSug(false);
    runLookup(`${s.lat},${s.lng}`);
  }

  function lookup(e: React.FormEvent) {
    e.preventDefault();
    setShowSug(false);
    runLookup(query);
  }

  async function runLookup(sendStr: string) {
    if (!sendStr.trim()) return;
    setLoading(true);
    setError(null);
    setHead(null);
    setProfile(null);
    resetLayer2();

    try {
      // STAGE 0→1 — fast: parcel + zoning paints immediately.
      const r = await fetch("/api/parcel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: sendStr }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Lookup failed.");
      setHead(data as ParcelResponse);
      setLoading(false);

      // STAGE 2→4 — enrichment streams in after.
      setEnriching(true);
      const e2 = await fetch("/api/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parcel: data.parcel, input: data.input }),
      });
      const ed = await e2.json();
      if (e2.ok) setProfile(ed.profile as SiteProfile);
      setEnriching(false);
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
      setEnriching(false);
    }
  }

  const p: Parcel | undefined = head?.parcel;
  const en = profile?.enrichment;
  const st = profile?.status ?? {};

  return (
    <div className="wrap">
      <div className="brand">
        <h1>
          landholder<span className="dot">.</span>
        </h1>
        <span className="badge">Layer 1 · Site Intelligence</span>
      </div>
      <p className="tagline">
        One parcel is the key. Type an address, parcel number, or{" "}
        <code>lat,lng</code> — get a feasibility-grade Site Profile.
      </p>

      <form className="searchbar" onSubmit={lookup}>
        <div className="searchfield">
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onFocus={() => {
              if (suggestions.length) setShowSug(true);
            }}
            onBlur={() => setTimeout(() => setShowSug(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && showSug && suggestions.length) {
                e.preventDefault();
                pickSuggestion(suggestions[0]);
              } else if (e.key === "Escape") {
                setShowSug(false);
              }
            }}
            placeholder="Address, parcel number, or  35.59,-82.55"
            autoComplete="off"
            autoFocus
          />
          {showSug && (
            <div className="suggest">
              {sugLoading && suggestions.length === 0 ? (
                <div className="sg empty">Searching…</div>
              ) : suggestions.length === 0 ? (
                <div className="sg empty">No US matches yet — keep typing</div>
              ) : (
                suggestions.map((s, i) => (
                  <div
                    className="sg"
                    key={`${s.lat},${s.lng},${i}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickSuggestion(s);
                    }}
                  >
                    {s.label}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        <button type="submit" disabled={loading}>
          {loading ? "Resolving…" : "Analyze"}
        </button>
      </form>
      <p className="hint">
        Running on mock + free data. Add Regrid &amp; Google keys and set{" "}
        <code>USE_MOCKS=false</code> to go live.
      </p>

      {error && (
        <div className="card error-box results">
          <strong>Couldn&apos;t resolve that.</strong> {error}
        </div>
      )}

      {head && p && (
        <div className="results">
          <div className="layout">
            {/* ── THE ANCHOR ─────────────────────────────────────────── */}
            <div className="card anchor">
              <div className="flexhead">
                <h2>Parcel · the anchor</h2>
                <span>
                  {head.cached ? (
                    <span className="badge cached">cached</span>
                  ) : p.acreage.source === "mock" ? (
                    <span className="badge mock">mock data</span>
                  ) : null}
                </span>
              </div>
              <div className="big">{p.parcelId}</div>
              <div className="rows">
                <Row k="Acreage" f={p.acreage} />
                <Row k="Owner" f={p.owner} />
                <Row k="Zoning" f={p.zoningCode} />
                <Row k="Zoning description" f={p.zoningDescription} />
                <Row k="FAR (floor-area ratio)" f={p.far} />
                <Row k="Permitted uses" f={{ ...p.permittedUses, value: (p.permittedUses.value || []).join(", ") } as any} />
                <div className="row">
                  <span className="k">County FIPS</span>
                  <span className="v">{p.countyFips ?? "—"}</span>
                </div>
              </div>
            </div>

            {/* ── overhead satellite (Esri World Imagery) ─────────────── */}
            <SiteMap parcel={p} />
          </div>

          {/* ── enrichment grid ──────────────────────────────────────── */}
          <h2 style={{ margin: "28px 0 12px", color: "var(--muted)", fontSize: 13, letterSpacing: "0.08em" }}>
            ENRICHMENT {enriching && "· loading…"}
          </h2>
          <div className="grid">
            <Card title="Demographics (county)" status={st.demographics}>
              <Row k="County" f={en?.demographics.county} />
              <Row k="Population" f={en?.demographics.population} />
              <Row k="Median household income" f={en?.demographics.medianHouseholdIncome} />
              <Row k="Median age" f={en?.demographics.medianAge} />
            </Card>

            <Card title="Amenities" status={st.amenities}>
              <Row
                k="Nearest grocery"
                f={
                  en?.amenities.nearestGrocery
                    ? ({
                        ...en.amenities.nearestGrocery,
                        value: en.amenities.nearestGrocery.value
                          ? `${en.amenities.nearestGrocery.value.name} · ${en.amenities.nearestGrocery.value.distanceMiles} mi`
                          : null,
                      } as any)
                    : undefined
                }
              />
              {(en?.amenities.pois.value || []).map((poi) => (
                <div className="row" key={poi.name}>
                  <span className="k">{poi.name}</span>
                  <span className="v">{poi.distanceMiles} mi</span>
                </div>
              ))}
            </Card>

            <Card title="Flood (FEMA NFHL)" status={st.flood}>
              <Row k="Flood zone" f={en?.flood.zone} />
              <Row k="In floodway" f={en?.flood.inFloodway} />
            </Card>

            <Card title="Soil / septic (SSURGO)" status={st.soil}>
              <Row k="Dominant soil" f={en?.soil.dominantType} />
              <Row k="Drainage" f={en?.soil.drainageClass} />
              <Row k="Septic suitability" f={en?.soil.septicSuitability} />
            </Card>

            <Card title="Water (USGS NHD)" status={st.water}>
              <Row k="Nearest feature" f={en?.water.nearestFeatureType} />
              <Row k="Distance to water" f={en?.water.distanceToWaterMiles} />
            </Card>

            <Card title="Wetlands (USFWS NWI)" status={st.wetlands}>
              <Row k="Overlaps wetland" f={en?.wetlands.overlaps} />
              <Row k="Type" f={en?.wetlands.wetlandType} />
              <Row k="Overlap area" f={en?.wetlands.overlapAcres} />
            </Card>

            <Card title="Terrain (USGS 3DEP)" status={st.terrain}>
              <Row k="Elevation" f={en?.terrain.elevationFt} />
              <Row k="Slope" f={en?.terrain.slopePct} />
            </Card>

            <Card title="Road access (OSM)" status={st.access}>
              <Row k="Nearest road" f={en?.access.nearestRoad} />
              <Row k="Road frontage" f={en?.access.roadFrontageFt} />
              <Row k="Distance to road" f={en?.access.distanceToRoadMiles} />
            </Card>

            <Card title="Utilities / power" status={st.utilities}>
              <p className="gap-note">
                {en?.utilities.note ??
                  "Known gap — no clean free API. Wire a regional source here."}
              </p>
            </Card>
          </div>

          {/* ── LAYER 2 — feasibility + site plan ─────────────────────── */}
          {profile && (
            <>
              <div className="section-head">
                <h2>What do you want to build here?</h2>
                <span className="sub">
                  Pick a use — we&apos;ll size the buildable envelope and sketch
                  a site plan.
                </span>
              </div>
              <div className="chips">
                {(Object.keys(PROJECT_TYPE_LABELS) as ProjectType[]).map((t) => (
                  <button
                    key={t}
                    className={`chip ${projectType === t ? "active" : ""}`}
                    onClick={() => choose(t)}
                  >
                    {PROJECT_TYPE_LABELS[t]}
                  </button>
                ))}
              </div>

              {planning && <p className="muted">Sizing envelope &amp; drawing site plan…</p>}

              {feas && (
                <>
                  <div className="plan-layout">
                    {/* program + envelope */}
                    <div className="card">
                      <h2>Program · {PROJECT_TYPE_LABELS[feas.projectType]}</h2>
                      <div className="stat">
                        <div className="b">
                          <div className="n">
                            {feas.program.yieldCount.toLocaleString()}
                          </div>
                          <div className="l">{feas.program.yieldLabel}</div>
                        </div>
                        <div className="b">
                          <div className="n">
                            {feas.envelope.buildableGsf.toLocaleString()}
                          </div>
                          <div className="l">buildable gross sq ft</div>
                        </div>
                        <div className="b">
                          <div className="n">{feas.envelope.floors}</div>
                          <div className="l">floors</div>
                        </div>
                        <div className="b">
                          <div className="n">
                            {feas.program.parkingStalls.toLocaleString()}
                          </div>
                          <div className="l">parking stalls</div>
                        </div>
                      </div>

                      <div className="rows">
                        <div className="row">
                          <span className="k">Gross site</span>
                          <span className="v">{feas.envelope.grossAcres} ac</span>
                        </div>
                        <div className="row">
                          <span className="k">Net developable</span>
                          <span className="v">
                            {feas.envelope.netDevelopableAcres} ac
                          </span>
                        </div>
                        {feas.envelope.deductions.map((d) => (
                          <div className="row" key={d.reason}>
                            <span className="k">– {d.reason}</span>
                            <span className="v">
                              −{d.acres} ac
                              <span className="prov">{d.source}</span>
                            </span>
                          </div>
                        ))}
                        <div className="row">
                          <span className="k">Max floor area (FAR)</span>
                          <span className="v">
                            {feas.envelope.maxFloorAreaByFAR.toLocaleString()} sq ft
                          </span>
                        </div>
                      </div>

                      <ul className="assume">
                        {feas.program.assumptions.map((a, i) => (
                          <li key={i}>{a}</li>
                        ))}
                      </ul>
                    </div>

                  </div>

                  {feas.flags.length > 0 && (
                    <div className="flags">
                      {feas.flags.map((f, i) => (
                        <div className={`flag ${f.level}`} key={i}>
                          <strong>{f.level.toUpperCase()}</strong> · {f.message}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* ── LAYER 3 — chatbot + interactive studio on the aerial photo ── */}
                  {p && (
                    <PlanChat
                      parcel={p}
                      profile={profile}
                      feas={feas}
                      elements={studioEls}
                      onApply={setStudioEls}
                      disabled={approved}
                    />
                  )}
                  {p && (
                    <SitePlanStudio
                      parcel={p}
                      profile={profile}
                      elements={studioEls}
                      onChange={setStudioEls}
                      approved={approved}
                      onApprove={() => setApproved(true)}
                    />
                  )}
                  {!approved && (
                    <div className="approvebar">
                      <button
                        className="ghost"
                        onClick={() =>
                          setStudioEls(seedElements(profile, feas.program, feas.envelope))
                        }
                      >
                        Reset to suggested layout
                      </button>
                    </div>
                  )}

                  {/* ── LAYER 3 Phase 3 — pricing & materials (after approval) ── */}
                  {approved && p && (
                    <PricingStudio
                      parcel={p}
                      profile={profile}
                      feas={feas}
                      elements={studioEls}
                      onEstimate={(est, spec) => {
                        setCostEstimate(est);
                        setBuildSpec(spec);
                      }}
                    />
                  )}

                  {/* ── LAYER 3 Phase 4 — build guide (after a cost estimate) ── */}
                  {approved && p && costEstimate && (
                    <ReportStudio
                      parcel={p}
                      profile={profile}
                      feas={feas}
                      elements={studioEls}
                      estimate={costEstimate}
                      spec={buildSpec}
                    />
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Card({
  title,
  status,
  children,
}: {
  title: string;
  status?: EnrichmentStatus;
  children: React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="flexhead">
        <h2>{title}</h2>
        {status && <StatusPill s={status} />}
      </div>
      <div className="rows">{children}</div>
    </div>
  );
}
