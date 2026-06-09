"use client";

/**
 * LAYER 3 Phase 4 — "How to build it" guide.
 *
 * Generates an AI-drafted, data-grounded build guide (via /api/report) and
 * renders it as a print-optimized ~3-page document: cover with the aerial +
 * approved plan, site & zoning, constraints, permits & process (verified
 * links), timeline & cost, a getting-started checklist, and a disclaimer.
 * "Download PDF" uses the browser's print-to-PDF (no extra dependency).
 */
import { useState } from "react";
import type { Parcel, SiteProfile } from "@/lib/types";
import type { StudioElement, FeasibilityResult } from "@/lib/feasibilityTypes";
import type { CostEstimate, BuildSpec } from "@/lib/cost";
import type { ReportData, ReportInput } from "@/lib/report";
import { aerialFrame, lngLatToXY, feetToPx } from "@/lib/geo";

function money(n: number): string {
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (n >= 1e3) return "$" + Math.round(n / 1e3) + "k";
  return "$" + Math.round(n).toLocaleString();
}

export default function ReportStudio({
  parcel,
  profile,
  feas,
  elements,
  estimate,
  spec,
}: {
  parcel: Parcel;
  profile: SiteProfile;
  feas: FeasibilityResult | null;
  elements: StudioElement[];
  estimate: CostEstimate;
  spec: BuildSpec | null;
}) {
  const [report, setReport] = useState<ReportData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const en = profile.enrichment;
  const countyName = (en?.demographics?.county?.value as string) ?? null;
  const acres = Math.round((((parcel.acreage?.value as number) ?? 0) + Number.EPSILON) * 100) / 100;
  const buildings = elements.filter((e) => e.kind === "building");
  const buildingGrossSqft = Math.round(buildings.reduce((s, e) => s + e.widthFt * e.heightFt * (e.floors || 1), 0));

  function reportInput(): ReportInput {
    return {
      projectType: feas?.projectType ?? "retreat",
      countyName,
      stateFips: parcel.countyFips ? String(parcel.countyFips).slice(0, 2) : null,
      zoningCode: (parcel.zoningCode?.value as string) ?? null,
      zoningDescription: (parcel.zoningDescription?.value as string) ?? null,
      zoningIsReal: parcel.zoningCode?.source === "regrid",
      permittedUses: (parcel.permittedUses?.value as string[]) ?? null,
      acres: (parcel.acreage?.value as number) ?? 0,
      buildingCount: buildings.length,
      buildingGrossSqft,
      yieldLabel: feas?.program.yieldLabel ?? null,
      yieldCount: feas?.program.yieldCount ?? null,
      floodZone: (en?.flood?.zone?.value as string) ?? null,
      septicSuitability: (en?.soil?.septicSuitability?.value as string) ?? null,
      slopePct: (en?.terrain?.slopePct?.value as number) ?? null,
      wetlandsOverlap: (en?.wetlands?.overlaps?.value as boolean) ?? null,
      utilities: spec?.utilities ?? "on_grid",
      costLow: estimate.totalLow,
      costHigh: estimate.totalHigh,
      budgetUsd: estimate.budgetUsd ?? spec?.budgetUsd ?? null,
    };
  }

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reportInput()),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || "Couldn't build the guide.");
        return;
      }
      setReport(data.report as ReportData);
    } catch (e: any) {
      setError(e?.message || "Network error.");
    } finally {
      setBusy(false);
    }
  }

  const frame = aerialFrame(parcel);
  const floodReal = en?.flood?.zone?.source === "fema-nfhl";
  const slope = en?.terrain?.slopePct?.value as number | null;

  return (
    <div className="card report-card">
      <div className="flexhead no-print">
        <h2>Your build guide</h2>
        <span className="sub">a step-by-step path to breaking ground</span>
      </div>

      {!report && (
        <div className="report-gen no-print">
          <p className="muted">
            Turn everything above into a plain-English guide: your county &amp; zoning, the permits
            you&apos;ll likely need and where to get them, a realistic timeline, the cost, and the
            first steps to take.
          </p>
          <button onClick={generate} disabled={busy}>
            {busy ? "Writing your guide…" : "Generate build guide"}
          </button>
          {error && <div className="chat-error">{error}</div>}
        </div>
      )}

      {report && (
        <>
          <div className="report-actions no-print">
            <button onClick={() => window.print()}>Download PDF</button>
            <button className="ghost" onClick={generate} disabled={busy}>
              {busy ? "…" : "Regenerate"}
            </button>
            <span className="report-hint">Choose “Save as PDF” in the print dialog.</span>
          </div>

          <div className="report-doc">
            {/* ── Cover ─────────────────────────────────────────── */}
            <header className="rp-cover">
              <div className="rp-kicker">landholder · build guide</div>
              <h1 className="rp-title">
                {(feas?.projectType ?? "Project").replace(/_/g, " ")} — {acres} acres
              </h1>
              <div className="rp-subtitle">
                {countyName ?? "Location"}{parcel.parcelId ? ` · parcel ${parcel.parcelId}` : ""}
              </div>

              <div className="rp-map">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={frame.url} alt="Aerial view with the planned site layout" />
                <svg viewBox={`0 0 ${frame.W} ${frame.H}`} preserveAspectRatio="none">
                  {frame.parcelPoints && <polygon className="rp-parcel" points={frame.parcelPoints} />}
                  {elements.map((el) => {
                    const c = lngLatToXY(frame.bbox, frame.W, frame.H, el.center.lng, el.center.lat);
                    const w = feetToPx(frame.ftPerPx, el.widthFt);
                    const h = feetToPx(frame.ftPerPx, el.heightFt);
                    return <rect key={el.id} x={c.x - w / 2} y={c.y - h / 2} width={w} height={h} className={`rp-el rp-${el.kind}`} />;
                  })}
                </svg>
              </div>

              <div className="rp-headline">
                <div><div className="rp-n">{feas ? feas.program.yieldCount.toLocaleString() : buildings.length}</div><div className="rp-l">{feas?.program.yieldLabel ?? "buildings"}</div></div>
                <div><div className="rp-n">{buildingGrossSqft.toLocaleString()}</div><div className="rp-l">gross sq ft</div></div>
                <div><div className="rp-n">{money(estimate.totalLow)}–{money(estimate.totalHigh)}</div><div className="rp-l">cost to build · {estimate.qualityTier}</div></div>
              </div>
              {report.overview && <p className="rp-overview">{report.overview}</p>}
            </header>

            {/* ── Site & zoning ─────────────────────────────────── */}
            <section className="rp-section">
              <h2>Site &amp; zoning</h2>
              <p>{report.zoningSummary}</p>
              <div className="rp-facts">
                <div><span>County</span><b>{countyName ?? "—"}</b></div>
                <div><span>Zoning</span><b>{(parcel.zoningCode?.value as string) ?? "—"}{parcel.zoningCode?.source !== "regrid" ? " (sample)" : ""}</b></div>
                <div><span>Acreage</span><b>{acres} ac</b></div>
                <div><span>Flood zone</span><b>{(en?.flood?.zone?.value as string) ?? "—"}{floodReal ? "" : " (sample)"}</b></div>
                <div><span>Slope</span><b>{slope != null ? `${slope}%` : "—"}</b></div>
                <div><span>Septic suitability</span><b>{(en?.soil?.septicSuitability?.value as string) ?? "—"}</b></div>
              </div>
            </section>

            {/* ── Permits ──────────────────────────────────────── */}
            <section className="rp-section">
              <h2>Permits you&apos;ll likely need</h2>
              <div className="rp-permits">
                {report.permits.map((p, i) => (
                  <div className="rp-permit" key={i}>
                    <div className="rp-permit-head">
                      <b>{p.name}</b>
                      {p.link && (
                        <a href={p.link.url} target="_blank" rel="noopener noreferrer">{p.link.label} ↗</a>
                      )}
                    </div>
                    <div className="rp-permit-why">{p.why}</div>
                    {p.whoIssues && <div className="rp-permit-who">Issued by: {p.whoIssues}</div>}
                  </div>
                ))}
              </div>
            </section>

            {/* ── Process ──────────────────────────────────────── */}
            <section className="rp-section">
              <h2>The process, step by step</h2>
              <ol className="rp-steps">
                {report.steps.map((s, i) => (
                  <li key={i}><b>{s.step}</b><span>{s.detail}</span></li>
                ))}
              </ol>
            </section>

            {/* ── Timeline & cost ──────────────────────────────── */}
            <section className="rp-section">
              <h2>Timeline &amp; cost</h2>
              <div className="rp-timeline">
                {report.timeline.map((t, i) => (
                  <div className="rp-phase" key={i}>
                    <div className="rp-phase-head"><b>{t.phase}</b><span>{t.duration}</span></div>
                    <div className="rp-phase-detail">{t.detail}</div>
                  </div>
                ))}
              </div>
              <div className="rp-cost">
                <div className="rp-cost-total">{money(estimate.totalLow)} – {money(estimate.totalHigh)}</div>
                <div className="rp-cost-sub">
                  estimated cost to build · {money(estimate.perSqftLow)}–{money(estimate.perSqftHigh)}/sq ft
                  {estimate.perUnit ? ` · ${money(estimate.perUnit)} per ${(estimate.unitLabel || "unit").replace(/s$/, "")}` : ""}
                  {estimate.budget ? ` · ${estimate.budget.status === "on" ? "on budget" : money(estimate.budget.amount) + " " + estimate.budget.status + " budget"}` : ""}
                </div>
              </div>
            </section>

            {/* ── Getting started ──────────────────────────────── */}
            <section className="rp-section">
              <h2>Get started this month</h2>
              <ul className="rp-checklist">
                {report.gettingStarted.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
              {report.contacts.length > 0 && (
                <div className="rp-contacts">
                  {report.contacts.map((c, i) => (
                    <div key={i}><b>{c.who}</b> — {c.role}</div>
                  ))}
                </div>
              )}
            </section>

            {/* ── Resources ────────────────────────────────────── */}
            <section className="rp-section">
              <h2>Key resources</h2>
              <ul className="rp-resources">
                {report.resources.map((r, i) => (
                  <li key={i}><a href={r.url} target="_blank" rel="noopener noreferrer">{r.label} ↗</a></li>
                ))}
              </ul>
            </section>

            <footer className="rp-disclaimer">
              This guide is an <b>informational screening</b> generated from public and sample data —
              not legal, engineering, or permitting advice. Permit lists are &quot;likely needed,&quot; not
              authoritative. Always confirm zoning, required permits, fees, and processes directly with
              your county and a licensed civil engineer / architect before relying on any of it.
            </footer>
          </div>
        </>
      )}
    </div>
  );
}
