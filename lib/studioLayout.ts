/**
 * LAYER 3 — studio layout.
 *
 * Two jobs:
 *  • seedElements(): turn a deterministic Program (lib/program.ts) into placed,
 *    editable StudioElements on the parcel — the starting point the user then
 *    drags/resizes/adds to.
 *  • programFromElements(): recompute live headline stats as the user edits.
 *
 * Everything is in real-world units (center lat/lng + feet), so it stays honest
 * against the parcel acreage and the future cost engine. Placement mirrors the
 * SVG massing in lib/siteplan.ts (setback box → build zone + parking + drive).
 */
import type { LatLng, Parcel, SiteProfile } from "./types";
import type { Program, Envelope, StudioElement, StudioElementKind } from "./feasibilityTypes";

const FT_PER_M = 3.28084;
const SQFT_PER_ACRE = 43_560;
const MAX_SEEDED = 60; // cap shapes we place so the canvas stays usable

/* ── feet ↔ lat/lng around the parcel centroid ──────────────────────────── */
function makeProjector(centroid: LatLng) {
  const mPerLat = 111_320;
  const mPerLng = 111_320 * Math.cos((centroid.lat * Math.PI) / 180);
  return {
    /** local feet offset (east, north) → lat/lng */
    toLatLng(eastFt: number, northFt: number): LatLng {
      return {
        lat: centroid.lat + northFt / FT_PER_M / mPerLat,
        lng: centroid.lng + eastFt / FT_PER_M / mPerLng,
      };
    },
    /** lat/lng → local feet offset (east, north) */
    toFeet(p: LatLng): { east: number; north: number } {
      return {
        east: (p.lng - centroid.lng) * mPerLng * FT_PER_M,
        north: (p.lat - centroid.lat) * mPerLat * FT_PER_M,
      };
    },
  };
}

/** Parcel extent in local feet (east/north from centroid). */
function parcelExtentFt(parcel: Parcel, proj: ReturnType<typeof makeProjector>) {
  const ring: number[][] = (parcel.geometry as any)?.coordinates?.[0] ?? [];
  if (ring.length < 3) {
    // mock / no polygon → square sized from acreage
    const acres = (parcel.acreage?.value as number) ?? 5;
    const side = Math.sqrt(acres * SQFT_PER_ACRE);
    return { minE: -side / 2, maxE: side / 2, minN: -side / 2, maxN: side / 2 };
  }
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (const [lng, lat] of ring) {
    const { east, north } = proj.toFeet({ lat, lng });
    minE = Math.min(minE, east);
    maxE = Math.max(maxE, east);
    minN = Math.min(minN, north);
    maxN = Math.max(maxN, north);
  }
  return { minE, maxE, minN, maxN };
}

/* ── seed placed elements from a Program ────────────────────────────────── */
export function seedElements(
  profile: SiteProfile,
  program: Program,
  _env: Envelope
): StudioElement[] {
  const centroid = profile.parcel.centroid;
  const proj = makeProjector(centroid);
  const ext = parcelExtentFt(parcel(profile), proj);

  const sb = (profile.parcel.setbacks?.value as any) ?? { front: 25, side: 10, rear: 20 };
  const side = sb.side ?? 10;
  const front = sb.front ?? 25;
  const rear = sb.rear ?? 20;

  // Buildable box in local feet (inset by setbacks).
  const bx0 = ext.minE + side;
  const bx1 = ext.maxE - side;
  const byTop = ext.maxN - front; // north edge
  const byBot = ext.minN + rear; // south edge
  const bw = Math.max(20, bx1 - bx0);
  const bh = Math.max(20, byTop - byBot);

  const hasParking = program.parkingStalls > 0;
  const buildH = bh * (hasParking ? 0.58 : 0.85);
  const buildTop = byTop;
  const buildBot = byTop - buildH;

  const out: StudioElement[] = [];
  let n = 0;
  const push = (kind: StudioElementKind, label: string, eastFt: number, northFt: number, w: number, h: number, floors?: number) => {
    out.push({
      id: `${kind}-${n++}`,
      kind,
      label,
      center: proj.toLatLng(eastFt, northFt),
      widthFt: Math.round(w),
      heightFt: Math.round(h),
      rotationDeg: 0,
      floors,
    });
  };

  // Pack building footprints left→right, wrapping rows, inside the build zone.
  const gap = 12;
  let cx = bx0;
  let cyTop = buildTop; // we walk downward (north→south)
  let rowH = 0;
  const place = (footprintSqft: number, label: string, floors: number) => {
    if (n >= MAX_SEEDED) return false;
    const s = Math.max(12, Math.sqrt(footprintSqft));
    const w = Math.min(s, bw);
    const h = s;
    if (cx + w > bx0 + bw + 0.5) {
      cx = bx0;
      cyTop -= rowH + gap;
      rowH = 0;
    }
    if (cyTop - h < buildBot - 0.5 && out.some((e) => e.kind === "building")) return false;
    push("building", label, cx + w / 2, cyTop - h / 2, w, h, floors);
    cx += w + gap;
    rowH = Math.max(rowH, h);
    return true;
  };

  for (const b of program.buildings) {
    for (let i = 0; i < b.count; i++) {
      const label = b.count > 1 ? `${b.label} ${i + 1}` : b.label;
      if (!place(b.footprintSqft, label, b.floors)) break;
    }
    if (n >= MAX_SEEDED) break;
  }

  // Parking field: one element across the lower zone, sized to the stalls.
  if (hasParking) {
    const parkSqft = program.parkingStalls * 320;
    const parkW = bw;
    const parkH = Math.max(24, Math.min(buildBot - byBot - gap, parkSqft / parkW));
    const parkCN = buildBot - gap - parkH / 2;
    // Label carries no count — the live stats derive stalls from the drawn area,
    // so the lot stays honest as the user resizes it.
    push("parking", "Parking", (bx0 + bx1) / 2, parkCN, parkW, parkH);
  }

  // Access drive: thin strip from the south edge up to the build zone.
  const driveW = Math.max(16, bw * 0.05);
  const driveTopN = hasParking ? byBot : buildBot;
  const driveH = Math.max(20, byTop - front - driveTopN); // from south up toward buildings
  push("drive", "Access drive", (bx0 + bx1) / 2, byBot + (driveH ? driveH / 2 : 0), driveW, Math.max(20, byBot < buildBot ? buildBot - byBot : 40));

  return out;
}

// tiny accessor so seedElements reads cleanly
function parcel(profile: SiteProfile): Parcel {
  return profile.parcel;
}

/* ── live stats from current elements ───────────────────────────────────── */
export type LiveProgram = {
  buildingCount: number;
  footprintSqft: number;
  parkingStalls: number;
  coveragePct: number; // of gross site area
  driveCount: number;
};

export function programFromElements(elements: StudioElement[], profile: SiteProfile): LiveProgram {
  const buildings = elements.filter((e) => e.kind === "building");
  const footprintSqft = buildings.reduce((s, e) => s + e.widthFt * e.heightFt, 0);
  const parkingSqft = elements
    .filter((e) => e.kind === "parking")
    .reduce((s, e) => s + e.widthFt * e.heightFt, 0);
  const grossSqft = ((profile.parcel.acreage?.value as number) ?? 0) * SQFT_PER_ACRE;
  return {
    buildingCount: buildings.length,
    footprintSqft: Math.round(footprintSqft),
    parkingStalls: Math.round(parkingSqft / 320),
    coveragePct: grossSqft > 0 ? Math.round((footprintSqft / grossSqft) * 1000) / 10 : 0,
    driveCount: elements.filter((e) => e.kind === "drive").length,
  };
}

/* ── palette: default element when the user clicks "+ Add" ──────────────── */
const DEFAULTS: Record<string, { kind: StudioElementKind; label: string; w: number; h: number }> = {
  building: { kind: "building", label: "Building", w: 60, h: 40 },
  cabin: { kind: "building", label: "Cabin", w: 26, h: 26 },
  parking: { kind: "parking", label: "Parking", w: 100, h: 60 },
  drive: { kind: "drive", label: "Access drive", w: 20, h: 120 },
};
export const PALETTE = ["building", "cabin", "parking", "drive"] as const;
export type PaletteKey = (typeof PALETTE)[number];

export function defaultElement(key: PaletteKey, center: LatLng, idSeed: number): StudioElement {
  const d = DEFAULTS[key];
  return {
    id: `${d.kind}-add-${idSeed}`,
    kind: d.kind,
    label: d.label,
    center,
    widthFt: d.w,
    heightFt: d.h,
    rotationDeg: 0,
    floors: d.kind === "building" ? 1 : undefined,
  };
}
