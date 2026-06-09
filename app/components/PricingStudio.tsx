"use client";

/**
 * LAYER 3 Phase 3 — pricing & materials studio.
 *
 * Appears after the plan is approved. Runs a short guided interview (Claude via
 * /api/pricing) about how/what to build, then renders the deterministic
 * cost-to-build estimate: category breakdown, total range, $/sq ft, $/unit,
 * budget fit, and a materials list.
 */
import { useEffect, useRef, useState } from "react";
import type { Parcel, SiteProfile } from "@/lib/types";
import type { StudioElement, FeasibilityResult } from "@/lib/feasibilityTypes";
import type { CostEstimate, BuildSpec } from "@/lib/cost";

type Msg = { role: "user" | "assistant"; text: string };

function money(n: number): string {
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (n >= 1e3) return "$" + Math.round(n / 1e3) + "k";
  return "$" + Math.round(n).toLocaleString();
}

export default function PricingStudio({
  parcel,
  profile,
  feas,
  elements,
  onEstimate,
}: {
  parcel: Parcel;
  profile: SiteProfile;
  feas: FeasibilityResult | null;
  elements: StudioElement[];
  onEstimate?: (estimate: CostEstimate, spec: BuildSpec | null) => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const startedRef = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [messages, busy]);

  function projectInput() {
    const buildings = elements.filter((e) => e.kind === "building");
    const gross = buildings.reduce((s, e) => s + e.widthFt * e.heightFt * (e.floors || 1), 0);
    const parkingSqft = elements.filter((e) => e.kind === "parking").reduce((s, e) => s + e.widthFt * e.heightFt, 0);
    return {
      projectType: feas?.projectType ?? "retreat",
      buildingGrossSqft: Math.round(gross),
      buildingCount: buildings.length,
      parkingStalls: Math.round(parkingSqft / 320),
      siteAcres: (parcel.acreage?.value as number) ?? 0,
      stateFips: parcel.countyFips ? String(parcel.countyFips).slice(0, 2) : null,
      unitLabel: feas?.program.yieldLabel,
    };
  }
  function context() {
    const en = profile.enrichment;
    return {
      slopePct: (en?.terrain?.slopePct?.value as number) ?? null,
      floodZone: (en?.flood?.zone?.value as string) ?? null,
      locationLabel: (en?.demographics?.county?.value as string) ?? null,
    };
  }

  async function post(next: Msg[]): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/pricing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, project: projectInput(), context: context() }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || "Pricing failed.");
        return false;
      }
      setMessages([...next, { role: "assistant", text: data.reply }]);
      if (data.done && data.estimate) {
        setEstimate(data.estimate as CostEstimate);
        onEstimate?.(data.estimate as CostEstimate, (data.spec as BuildSpec) ?? null);
      }
      return true;
    } catch (e: any) {
      setError(e?.message || "Network error.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Auto-start the interview once.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const seed: Msg[] = [{ role: "user", text: "I'm ready — let's price out the approved plan." }];
    setMessages(seed);
    post(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const prev = messages;
    const next = [...messages, { role: "user" as const, text }];
    setMessages(next);
    setInput("");
    const ok = await post(next);
    if (!ok) setMessages(prev);
  }

  const e = estimate;
  return (
    <div className="card pricing-card">
      <div className="flexhead">
        <h2>Pricing &amp; materials</h2>
        <span className="sub">a few questions → cost to build</span>
      </div>

      <div className="chat-log" ref={logRef}>
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            {m.text}
          </div>
        ))}
        {busy && <div className="chat-msg assistant pending">Thinking…</div>}
      </div>
      {error && <div className="chat-error">{error}</div>}
      <form className="chat-input" onSubmit={(ev) => { ev.preventDefault(); send(); }}>
        <input
          value={input}
          onChange={(ev) => setInput(ev.target.value)}
          placeholder="Type your answer…"
          disabled={busy}
          autoComplete="off"
        />
        <button type="submit" disabled={busy || !input.trim()}>
          {busy ? "…" : "Send"}
        </button>
      </form>

      {e && (
        <div className="estimate">
          <div className="est-head">
            <div>
              <div className="est-total">{money(e.totalLow)} – {money(e.totalHigh)}</div>
              <div className="est-sub">
                estimated cost to build · {money(e.perSqftLow)}–{money(e.perSqftHigh)}/sq ft
                {e.perUnit ? ` · ${money(e.perUnit)} per ${(e.unitLabel || "unit").replace(/s$/, "")}` : ""}
                <span className="est-tier"> · {e.qualityTier}</span>
              </div>
            </div>
            {e.budget && (
              <div className={`est-budget ${e.budget.status}`}>
                {e.budget.status === "on"
                  ? "On budget"
                  : `${money(e.budget.amount)} ${e.budget.status} budget`}
                {e.budgetUsd ? <span className="est-budget-target">target {money(e.budgetUsd)}</span> : null}
              </div>
            )}
          </div>

          <div className="est-lines">
            {e.lines.map((l) => (
              <div className="est-line" key={l.label}>
                <span className="est-line-label">
                  {l.label}
                  {l.note ? <span className="est-line-note">{l.note}</span> : null}
                </span>
                <span className="est-line-val">{money(l.low)} – {money(l.high)}</span>
              </div>
            ))}
          </div>

          {e.materials.length > 0 && (
            <div className="est-materials">
              <div className="est-materials-h">Materials &amp; finishes</div>
              <div className="est-chips">
                {e.materials.map((m) => (
                  <span className="est-chip" key={m}>{m}</span>
                ))}
              </div>
            </div>
          )}

          <ul className="assume">
            {e.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
          <p className="est-hint">
            Want to compare? Ask me e.g. <em>“what if we go premium?”</em> or{" "}
            <em>“price it with structured parking.”</em>
          </p>
        </div>
      )}
    </div>
  );
}
