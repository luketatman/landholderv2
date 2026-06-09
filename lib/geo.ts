/**
 * LAYER 3 — shared georeferencing for the aerial photo + the design studio.
 *
 * One coordinate space: a padded, aspect-matched bounding box around the parcel
 * is mapped to a fixed W×H pixel frame. The Esri satellite tile is requested for
 * exactly that bbox, so lat/lng ↔ pixel is a clean linear transform and any
 * overlay (parcel outline, draggable buildings) lines up 1:1 with the imagery.
 *
 * Buildings are stored in real-world units (center lat/lng + size in feet) and
 * converted to pixels here, so the photo overlay, live program stats, and the
 * future cost engine all agree on what a "60 × 40 ft" building is.
 */
import type { LatLng, Parcel } from "./types";

const FT_PER_M = 3.28084;
export const FRAME_W = 800;
export const FRAME_H = 420;

export type BBox = { minLng: number; minLat: number; maxLng: number; maxLat: number };

export type AerialFrame = {
  /** Esri World Imagery export URL framed exactly on `bbox`. */
  url: string;
  /** SVG `points` string for the parcel polygon in frame pixels. */
  parcelPoints: string;
  bbox: BBox;
  W: number;
  H: number;
  /** Feet per pixel — uniform in x and y (bbox aspect is matched to W/H). */
  ftPerPx: number;
  centroid: LatLng;
};

/** Build the aerial frame (image URL + transform) for a parcel. */
export function aerialFrame(parcel: Parcel): AerialFrame {
  const ring: number[][] = (parcel.geometry as any)?.coordinates?.[0] ?? [];
  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity;
  if (ring.length) {
    for (const [lng, lat] of ring) {
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
  } else {
    const c = parcel.centroid;
    minLng = maxLng = c.lng;
    minLat = maxLat = c.lat;
  }
  const cLat = (minLat + maxLat) / 2;
  const cLng = (minLng + maxLng) / 2;
  const mPerLat = 111_320;
  const mPerLng = 111_320 * Math.cos((cLat * Math.PI) / 180);

  // Pad so the parcel fills the center; floor so tiny lots aren't over-zoomed;
  // then match the image aspect ratio so feet→px is uniform on both axes.
  let spanX = Math.max((maxLng - minLng) * mPerLng * 1.9, 180);
  let spanY = Math.max((maxLat - minLat) * mPerLat * 1.9, 180);
  const aspect = FRAME_W / FRAME_H;
  if (spanX / spanY < aspect) spanX = spanY * aspect;
  else spanY = spanX / aspect;

  const dLng = spanX / 2 / mPerLng;
  const dLat = spanY / 2 / mPerLat;
  const bbox: BBox = {
    minLng: cLng - dLng,
    minLat: cLat - dLat,
    maxLng: cLng + dLng,
    maxLat: cLat + dLat,
  };

  const url =
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export" +
    `?bbox=${bbox.minLng},${bbox.minLat},${bbox.maxLng},${bbox.maxLat}` +
    "&bboxSR=4326&imageSR=4326" +
    `&size=${FRAME_W},${FRAME_H}&format=jpg&f=image`;

  const parcelPoints = ring
    .map(([lng, lat]) => {
      const p = lngLatToXY(bbox, FRAME_W, FRAME_H, lng, lat);
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    })
    .join(" ");

  // spanX meters across W pixels (uniform because aspect matched above).
  const ftPerPx = ((spanX / FRAME_W) * FT_PER_M);

  return { url, parcelPoints, bbox, W: FRAME_W, H: FRAME_H, ftPerPx, centroid: { lat: cLat, lng: cLng } };
}

/** lat/lng → frame pixel (origin top-left, north up). */
export function lngLatToXY(bbox: BBox, W: number, H: number, lng: number, lat: number) {
  return {
    x: ((lng - bbox.minLng) / (bbox.maxLng - bbox.minLng)) * W,
    y: ((bbox.maxLat - lat) / (bbox.maxLat - bbox.minLat)) * H,
  };
}

/** frame pixel → lat/lng (inverse of lngLatToXY, for drag). */
export function xyToLngLat(bbox: BBox, W: number, H: number, x: number, y: number): LatLng {
  return {
    lng: bbox.minLng + (x / W) * (bbox.maxLng - bbox.minLng),
    lat: bbox.maxLat - (y / H) * (bbox.maxLat - bbox.minLat),
  };
}

export function feetToPx(ftPerPx: number, ft: number): number {
  return ft / ftPerPx;
}
export function pxToFeet(ftPerPx: number, px: number): number {
  return px * ftPerPx;
}

/**
 * Local feet offsets (east, north) from a centroid ↔ lat/lng. Used by the
 * chatbot so Claude reasons in human-friendly feet ("a cabin 50 ft north of
 * center") and the server converts to the canonical lat/lng StudioElements.
 */
const FT_PER_M_ = 3.28084;
export function ftOffsetToLatLng(centroid: LatLng, eastFt: number, northFt: number): LatLng {
  const mPerLat = 111_320;
  const mPerLng = 111_320 * Math.cos((centroid.lat * Math.PI) / 180);
  return {
    lat: centroid.lat + northFt / FT_PER_M_ / mPerLat,
    lng: centroid.lng + eastFt / FT_PER_M_ / mPerLng,
  };
}
export function latLngToFtOffset(centroid: LatLng, p: LatLng): { eastFt: number; northFt: number } {
  const mPerLat = 111_320;
  const mPerLng = 111_320 * Math.cos((centroid.lat * Math.PI) / 180);
  return {
    eastFt: (p.lng - centroid.lng) * mPerLng * FT_PER_M_,
    northFt: (p.lat - centroid.lat) * mPerLat * FT_PER_M_,
  };
}

/** Whether a lat/lng falls inside the parcel polygon (ray casting). */
export function pointInParcel(parcel: Parcel, lng: number, lat: number): boolean {
  const ring: number[][] = (parcel.geometry as any)?.coordinates?.[0] ?? [];
  if (ring.length < 3) return true; // no polygon (mock) → don't constrain
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
