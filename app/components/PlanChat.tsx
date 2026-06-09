"use client";

/**
 * LAYER 3 Phase 2 — design-studio chat panel.
 *
 * The user describes what to build in plain English; this posts the request +
 * the current StudioElements to /api/chat (Claude), then applies the returned
 * elements to the same editor canvas. No drag math here — it shares state with
 * SitePlanStudio via the parent.
 */
import { useEffect, useRef, useState } from "react";
import type { Parcel, SiteProfile } from "@/lib/types";
import type { StudioElement, FeasibilityResult } from "@/lib/feasibilityTypes";
import { latLngToFtOffset } from "@/lib/geo";

type Msg = { role: "user" | "assistant"; text: string };

export default function PlanChat({
  parcel,
  profile,
  feas,
  elements,
  onApply,
  disabled,
}: {
  parcel: Parcel;
  profile: SiteProfile;
  feas: FeasibilityResult | null;
  elements: StudioElement[];
  onApply: (els: StudioElement[]) => void;
  disabled?: boolean;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [messages, busy]);

  function siteContext() {
    const ring: number[][] = (parcel.geometry as any)?.coordinates?.[0] ?? [];
    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
    for (const [lng, lat] of ring) {
      const o = latLngToFtOffset(parcel.centroid, { lat, lng });
      minE = Math.min(minE, o.eastFt);
      maxE = Math.max(maxE, o.eastFt);
      minN = Math.min(minN, o.northFt);
      maxN = Math.max(maxN, o.northFt);
    }
    const acres = (parcel.acreage?.value as number) ?? 0;
    const widthFt = ring.length ? Math.round(maxE - minE) : Math.round(Math.sqrt(acres * 43560));
    const heightFt = ring.length ? Math.round(maxN - minN) : widthFt;
    const en = profile.enrichment;
    return {
      centroid: parcel.centroid,
      acres,
      parcelWidthFt: widthFt,
      parcelHeightFt: heightFt,
      zoning: (parcel.zoningCode?.value as string) ?? null,
      floodZone: (en?.flood?.zone?.value as string) ?? null,
      slopePct: (en?.terrain?.slopePct?.value as number) ?? null,
      projectType: feas ? feas.projectType : null,
    };
  }

  async function send() {
    const text = input.trim();
    if (!text || busy || disabled) return;
    setError(null);
    const next = [...messages, { role: "user" as const, text }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, site: siteContext(), elements }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || "Chat failed.");
        setMessages(messages); // roll back the optimistic user message
        return;
      }
      setMessages([...next, { role: "assistant", text: data.reply }]);
      if (Array.isArray(data.elements)) onApply(data.elements);
    } catch (e: any) {
      setError(e?.message || "Network error.");
      setMessages(messages);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card chat-card">
      <div className="flexhead">
        <h2>Describe what to build</h2>
        <span className="sub">the assistant draws it on the photo below</span>
      </div>
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && (
          <div className="chat-hint">
            Try: <em>“Add 8 cabins along the north edge and put the lodge near the road.”</em>{" "}
            or <em>“Make the lodge bigger and add a parking lot to the south.”</em>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            {m.text}
          </div>
        ))}
        {busy && <div className="chat-msg assistant pending">Designing…</div>}
      </div>
      {error && <div className="chat-error">{error}</div>}
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={disabled ? "Approve resets editing — unlock to keep chatting" : "Describe a change…"}
          disabled={busy || disabled}
          autoComplete="off"
        />
        <button type="submit" disabled={busy || disabled || !input.trim()}>
          {busy ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}
