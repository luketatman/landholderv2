"use client";

/**
 * LAYER 3 — interactive site-plan studio.
 *
 * Editable building/parking/drive shapes overlaid on the real aerial photo.
 * Shapes are stored in real-world units (center lat/lng + feet); this component
 * converts to/from frame pixels via lib/geo so they track the cursor 1:1 on the
 * image and keep honest dimensions. Drag to move, corner handle to resize, the
 * palette to add, ✕ to delete. No server calls — pure client state.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Parcel, SiteProfile } from "@/lib/types";
import type { StudioElement } from "@/lib/feasibilityTypes";
import {
  aerialFrame,
  lngLatToXY,
  xyToLngLat,
  feetToPx,
  pxToFeet,
  type AerialFrame,
} from "@/lib/geo";
import {
  programFromElements,
  defaultElement,
  PALETTE,
  type PaletteKey,
} from "@/lib/studioLayout";

type DragState =
  | { id: string; mode: "move"; off: { x: number; y: number } }
  | { id: string; mode: "resize"; tlFx: number; tlFy: number }
  | null;

export default function SitePlanStudio({
  parcel,
  profile,
  elements,
  onChange,
  approved,
  onApprove,
}: {
  parcel: Parcel;
  profile: SiteProfile;
  elements: StudioElement[];
  onChange: (els: StudioElement[]) => void;
  approved: boolean;
  onApprove: () => void;
}) {
  const frame = useMemo(() => aerialFrame(parcel), [parcel]);
  const { W, H } = frame;
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dragRef = useRef<DragState>(null);
  const addSeed = useRef(0);

  // Latest values for the window drag listeners (bound once).
  const stateRef = useRef({ elements, frame, onChange });
  stateRef.current = { elements, frame, onChange };

  const live = programFromElements(elements, profile);

  /** client px → frame px (0..W, 0..H). */
  function toFrame(clientX: number, clientY: number) {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      fx: ((clientX - rect.left) / rect.width) * W,
      fy: ((clientY - rect.top) / rect.height) * H,
    };
  }

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      e.preventDefault();
      const { elements, frame, onChange } = stateRef.current;
      const rect = containerRef.current!.getBoundingClientRect();
      const fx = ((e.clientX - rect.left) / rect.width) * frame.W;
      const fy = ((e.clientY - rect.top) / rect.height) * frame.H;

      onChange(
        elements.map((el) => {
          if (el.id !== drag.id) return el;
          if (drag.mode === "move") {
            const cx = fx - drag.off.x;
            const cy = fy - drag.off.y;
            return { ...el, center: xyToLngLat(frame.bbox, frame.W, frame.H, cx, cy) };
          }
          // resize: top-left anchored
          const wPx = Math.max(8, fx - drag.tlFx);
          const hPx = Math.max(8, fy - drag.tlFy);
          const center = xyToLngLat(
            frame.bbox,
            frame.W,
            frame.H,
            drag.tlFx + wPx / 2,
            drag.tlFy + hPx / 2
          );
          return {
            ...el,
            widthFt: Math.max(6, Math.round(pxToFeet(frame.ftPerPx, wPx))),
            heightFt: Math.max(6, Math.round(pxToFeet(frame.ftPerPx, hPx))),
            center,
          };
        })
      );
    }
    function onUp() {
      dragRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  function elCenterPx(el: StudioElement) {
    return lngLatToXY(frame.bbox, W, H, el.center.lng, el.center.lat);
  }

  function startMove(e: React.PointerEvent, el: StudioElement) {
    e.stopPropagation();
    e.preventDefault();
    const { fx, fy } = toFrame(e.clientX, e.clientY);
    const c = elCenterPx(el);
    dragRef.current = { id: el.id, mode: "move", off: { x: fx - c.x, y: fy - c.y } };
    setSelectedId(el.id);
  }

  function startResize(e: React.PointerEvent, el: StudioElement) {
    e.stopPropagation();
    e.preventDefault();
    const c = elCenterPx(el);
    const wPx = feetToPx(frame.ftPerPx, el.widthFt);
    const hPx = feetToPx(frame.ftPerPx, el.heightFt);
    dragRef.current = { id: el.id, mode: "resize", tlFx: c.x - wPx / 2, tlFy: c.y - hPx / 2 };
    setSelectedId(el.id);
  }

  function remove(id: string) {
    onChange(elements.filter((e) => e.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  function add(key: PaletteKey) {
    const el = defaultElement(key, frame.centroid, addSeed.current++);
    onChange([...elements, el]);
    setSelectedId(el.id);
  }

  return (
    <div className="card studio-card">
      <div className="flexhead">
        <h2>Site plan studio</h2>
        <span className="sub">Drag to move · corner to resize · click a tool to add</span>
      </div>

      {!approved && (
        <div className="palette">
          {PALETTE.map((k) => (
            <button key={k} className="pal-btn" onClick={() => add(k)} disabled={approved}>
              + {k === "drive" ? "Drive" : k[0].toUpperCase() + k.slice(1)}
            </button>
          ))}
          <span className="pal-hint">click a shape to select, ✕ to delete</span>
        </div>
      )}

      <div
        className={`studio ${approved ? "locked" : ""}`}
        ref={containerRef}
        onPointerDown={() => setSelectedId(null)}
        style={{ aspectRatio: `${W} / ${H}` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={frame.url} alt={`Aerial view of parcel ${parcel.parcelId}`} draggable={false} />

        {/* parcel boundary (non-interactive) */}
        <svg className="studio-parcel" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          {frame.parcelPoints && <polygon points={frame.parcelPoints} />}
        </svg>

        {/* editable elements */}
        {elements.map((el) => {
          const c = elCenterPx(el);
          const wPx = feetToPx(frame.ftPerPx, el.widthFt);
          const hPx = feetToPx(frame.ftPerPx, el.heightFt);
          const sel = el.id === selectedId;
          const style: React.CSSProperties = {
            left: `${((c.x - wPx / 2) / W) * 100}%`,
            top: `${((c.y - hPx / 2) / H) * 100}%`,
            width: `${(wPx / W) * 100}%`,
            height: `${(hPx / H) * 100}%`,
            transform: el.rotationDeg ? `rotate(${el.rotationDeg}deg)` : undefined,
          };
          return (
            <div
              key={el.id}
              className={`studio-el kind-${el.kind} ${sel ? "sel" : ""} ${approved ? "locked" : ""}`}
              style={style}
              onPointerDown={(e) => !approved && startMove(e, el)}
            >
              <span className="el-tag">{el.label}</span>
              {sel && !approved && (
                <>
                  <span className="el-dim">
                    {el.widthFt}×{el.heightFt} ft · {(el.widthFt * el.heightFt).toLocaleString()} sf
                  </span>
                  <button
                    className="el-del"
                    title="Delete"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      remove(el.id);
                    }}
                  >
                    ✕
                  </button>
                  <span className="el-resize" onPointerDown={(e) => startResize(e, el)} />
                </>
              )}
            </div>
          );
        })}

        <span className="maptag">▣ Satellite · Esri World Imagery</span>
      </div>

      {/* live stats */}
      <div className="studio-stats">
        <div className="ss"><div className="n">{live.buildingCount}</div><div className="l">buildings</div></div>
        <div className="ss"><div className="n">{live.footprintSqft.toLocaleString()}</div><div className="l">footprint sq ft</div></div>
        <div className="ss"><div className="n">{live.coveragePct}%</div><div className="l">site coverage</div></div>
        <div className="ss"><div className="n">{live.parkingStalls.toLocaleString()}</div><div className="l">parking stalls</div></div>
      </div>

      <div className="approvebar">
        {approved ? (
          <span className="approved-note">
            ✓ Plan approved — next: pricing &amp; materials (cost-to-build).
          </span>
        ) : (
          <button onClick={onApprove} disabled={elements.length === 0}>
            Approve plan
          </button>
        )}
      </div>
    </div>
  );
}
