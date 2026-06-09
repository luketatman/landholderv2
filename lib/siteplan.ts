/**
 * LAYER 2 — overhead site plan generator.
 *
 * Deterministic SVG massing from parcel geometry + program. NOT engineering —
 * a high-level "outline the buildings" diagram: parcel boundary, setback line,
 * packed building footprints, a parking field, an access drive, and any
 * no-build constraint band. The SVG viewBox is drawn in FEET so the scale bar
 * is honest.
 */
import type { SiteProfile, LatLng, Geometry } from "./types";
import type { Program, Envelope, SitePlan } from "./feasibilityTypes";

const FT_PER_M = 3.28084;
const MAX_DRAWN = 80; // cap building instances we render

type Rect = { x: number; y: number; w: number; h: number };

export function generateSitePlan(
  profile: SiteProfile,
  program: Program,
  env: Envelope
): SitePlan {
  const centroid = profile.parcel.centroid;
  const ring = polyToFeet(profile.parcel.geometry, centroid);

  // Bounding box in feet (north up).
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const widthFt = Math.max(...xs) - Math.min(...xs) || Math.sqrt(env.grossSqft);
  const heightFt = Math.max(...ys) - Math.min(...ys) || Math.sqrt(env.grossSqft);

  const sb = (profile.parcel.setbacks.value as any) ?? { front: 25, side: 10, rear: 20 };
  const inset: Rect = {
    x: sb.side ?? 10,
    y: sb.front ?? 25,
    w: Math.max(0, widthFt - 2 * (sb.side ?? 10)),
    h: Math.max(0, heightFt - (sb.front ?? 25) - (sb.rear ?? 20)),
  };

  // Zones inside the buildable rect.
  const hasParking = program.parkingStalls > 0;
  const buildZoneH = inset.h * (hasParking ? 0.58 : 0.82);
  const parkZone: Rect = {
    x: inset.x,
    y: inset.y + buildZoneH + 12,
    w: inset.w,
    h: Math.max(0, inset.h - buildZoneH - 12),
  };
  const buildZone: Rect = { x: inset.x, y: inset.y, w: inset.w, h: buildZoneH };

  // Expand program into footprints, capped for drawing.
  const instances: number[] = []; // footprint sqft each
  for (const b of program.buildings) {
    const n = Math.min(b.count, MAX_DRAWN - instances.length);
    for (let i = 0; i < n; i++) instances.push(b.footprintSqft);
    if (instances.length >= MAX_DRAWN) break;
  }
  const rects = packRects(buildZone, instances);

  // No-build constraint share (flood + wetlands + slope) as a corner band.
  const noBuildAcres = env.deductions.reduce((s, d) => s + d.acres, 0);
  const noBuildFrac = env.grossAcres > 0 ? Math.min(0.4, noBuildAcres / env.grossAcres) : 0;

  const svg = render({
    widthFt,
    heightFt,
    ring,
    inset,
    buildRects: rects,
    parkZone: hasParking ? parkZone : null,
    parkingStalls: program.parkingStalls,
    noBuildFrac,
    deductionLabels: env.deductions.map((d) => d.reason),
    projectLabel: program.yieldLabel,
  });

  return { svg, widthFt: round(widthFt), heightFt: round(heightFt), centroid };
}

/* ── geometry → feet (north up) ─────────────────────────────────────────── */
function polyToFeet(geom: Geometry | null, c: LatLng): [number, number][] {
  if (!geom) {
    const s = 200; // fallback square, arbitrary; bbox recomputed by caller
    return [
      [0, 0],
      [s, 0],
      [s, s],
      [0, s],
      [0, 0],
    ];
  }
  let ring = geom.coordinates[0] as [number, number][];
  if (geom.type === "MultiPolygon") ring = (geom.coordinates[0] as any)[0];
  const lats = ring.map((p) => p[1]);
  const lngs = ring.map((p) => p[0]);
  const minLng = Math.min(...lngs);
  const maxLat = Math.max(...lats);
  const cos = Math.cos((c.lat * Math.PI) / 180);
  return ring.map(([lng, lat]) => [
    (lng - minLng) * 111_320 * cos * FT_PER_M,
    (maxLat - lat) * 111_320 * FT_PER_M, // flip so north is up
  ]);
}

/* ── pack footprints left→right, wrapping rows ──────────────────────────── */
function packRects(zone: Rect, footprints: number[]): Rect[] {
  const gap = 10;
  const out: Rect[] = [];
  let cx = zone.x;
  let cy = zone.y;
  let rowH = 0;
  for (const f of footprints) {
    const side = Math.max(12, Math.sqrt(f));
    const w = Math.min(side, zone.w);
    const h = side * (f / (side * side)); // = side, but keep explicit
    if (cx + w > zone.x + zone.w + 0.5) {
      cx = zone.x;
      cy += rowH + gap;
      rowH = 0;
    }
    if (cy + h > zone.y + zone.h + 0.5 && out.length > 0) break; // overflow
    out.push({ x: cx, y: cy, w, h });
    cx += w + gap;
    rowH = Math.max(rowH, h);
  }
  return out;
}

/* ── SVG render ─────────────────────────────────────────────────────────── */
function render(o: {
  widthFt: number;
  heightFt: number;
  ring: [number, number][];
  inset: Rect;
  buildRects: Rect[];
  parkZone: Rect | null;
  parkingStalls: number;
  noBuildFrac: number;
  deductionLabels: string[];
  projectLabel: string;
}): string {
  const pad = Math.max(o.widthFt, o.heightFt) * 0.06;
  const W = o.widthFt + pad * 2;
  const H = o.heightFt + pad * 2 + 60; // extra for scale bar
  const t = (r: Rect) => `x="${r.x + pad}" y="${r.y + pad}" width="${r.w}" height="${r.h}"`;
  const stroke = Math.max(1.5, o.widthFt / 250);

  const parcelPts = o.ring.map(([x, y]) => `${x + pad},${y + pad}`).join(" ");

  // Access drive: from bottom edge up to the building zone, centered.
  const driveW = Math.max(18, o.widthFt * 0.04);
  const driveX = o.inset.x + o.inset.w / 2 - driveW / 2 + pad;
  const driveTop = (o.parkZone ? o.parkZone.y : o.inset.y + o.inset.h) + pad;
  const driveBottom = o.heightFt + pad;

  // No-build band (lower-left corner), sized by constraint share.
  const nb = o.noBuildFrac;
  const nbRect =
    nb > 0
      ? `<rect x="${pad}" y="${o.heightFt * (1 - nb) + pad}" width="${o.widthFt * Math.min(1, nb * 2.2)}" height="${o.heightFt * nb}" fill="url(#nobuild)" stroke="#d29922" stroke-dasharray="6 5" stroke-width="${stroke}"/>`
      : "";

  // Scale bar: pick a round number ~1/4 of width.
  const target = o.widthFt / 4;
  const barFt = niceRound(target);
  const barY = H - 26;

  const buildings = o.buildRects
    .map(
      (r) =>
        `<rect ${t(r)} rx="2" fill="#4ea1ff" fill-opacity="0.85" stroke="#0b3a66" stroke-width="${Math.max(1, stroke * 0.6)}"/>`
    )
    .join("");

  return `<svg viewBox="0 0 ${round(W)} ${round(H)}" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif">
  <defs>
    <pattern id="park" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="14" height="14" fill="#1c2330"/>
      <line x1="0" y1="0" x2="0" y2="14" stroke="#39424f" stroke-width="2"/>
    </pattern>
    <pattern id="nobuild" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="12" height="12" fill="#3a2a12"/>
      <line x1="0" y1="0" x2="0" y2="12" stroke="#d29922" stroke-width="2"/>
    </pattern>
  </defs>
  <rect x="0" y="0" width="${round(W)}" height="${round(H)}" fill="#0e1116"/>

  <!-- parcel boundary -->
  <polygon points="${parcelPts}" fill="#161b22" stroke="#4ea1ff" stroke-width="${stroke * 1.4}"/>

  <!-- setback envelope -->
  <rect ${t(o.inset)} fill="none" stroke="#8b97a7" stroke-dasharray="${stroke * 4} ${stroke * 3}" stroke-width="${stroke}"/>

  ${nbRect}

  <!-- access drive -->
  <rect x="${round(driveX)}" y="${round(driveTop)}" width="${round(driveW)}" height="${round(driveBottom - driveTop)}" fill="#2a3340"/>

  <!-- parking field -->
  ${o.parkZone ? `<rect ${t(o.parkZone)} fill="url(#park)" stroke="#39424f" stroke-width="${stroke}"/>` : ""}

  <!-- buildings -->
  ${buildings}

  <!-- north arrow -->
  <g transform="translate(${round(W - pad - 16)}, ${round(pad + 40)})">
    <line x1="0" y1="0" x2="0" y2="-26" stroke="#e6edf3" stroke-width="2"/>
    <polygon points="0,-32 -5,-22 5,-22" fill="#e6edf3"/>
    <text x="0" y="14" fill="#8b97a7" font-size="${Math.max(10, o.widthFt / 60)}" text-anchor="middle">N</text>
  </g>

  <!-- scale bar -->
  <g>
    <line x1="${pad}" y1="${barY}" x2="${pad + barFt}" y2="${barY}" stroke="#e6edf3" stroke-width="2"/>
    <line x1="${pad}" y1="${barY - 5}" x2="${pad}" y2="${barY + 5}" stroke="#e6edf3" stroke-width="2"/>
    <line x1="${pad + barFt}" y1="${barY - 5}" x2="${pad + barFt}" y2="${barY + 5}" stroke="#e6edf3" stroke-width="2"/>
    <text x="${pad}" y="${barY - 9}" fill="#8b97a7" font-size="${Math.max(11, o.widthFt / 55)}">${fmt(barFt)} ft</text>
  </g>

  <!-- legend -->
  <g font-size="${Math.max(11, o.widthFt / 55)}" fill="#8b97a7">
    <rect x="${pad + barFt + 40}" y="${barY - 11}" width="14" height="14" fill="#4ea1ff" fill-opacity="0.85"/>
    <text x="${pad + barFt + 60}" y="${barY}">buildings</text>
  </g>
</svg>`;
}

/* ── helpers ────────────────────────────────────────────────────────────── */
function niceRound(n: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const f = n / pow;
  const nice = f >= 5 ? 5 : f >= 2 ? 2 : 1;
  return nice * pow;
}
function round(n: number) {
  return Math.round(n * 10) / 10;
}
function fmt(n: number) {
  return Math.round(n).toLocaleString();
}
