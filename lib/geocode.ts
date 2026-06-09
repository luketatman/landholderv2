/**
 * STAGE 0 — Geocode.
 * address → { lat, lng }.
 *
 * Primary: US Census Geocoder (free, no key). Fallback: Google Geocoding.
 * If the input parses as "lat,lng" we treat it as a dropped pin and skip.
 */
import { env } from "./env";
import type { LatLng } from "./types";

export type GeocodeResult = {
  latLng: LatLng;
  matchedAddress: string | null;
  source: "census-geocoder" | "google-geocoding" | "pin" | "mock";
};

const PIN_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

export async function geocode(raw: string): Promise<GeocodeResult> {
  // Dropped pin / pasted coordinates.
  const pin = raw.match(PIN_RE);
  if (pin) {
    return {
      latLng: { lat: Number(pin[1]), lng: Number(pin[2]) },
      matchedAddress: null,
      source: "pin",
    };
  }

  if (env.useMocks) return mockGeocode(raw);

  // ── Primary: Census Geocoder (free) ───────────────────────────────────
  try {
    const url =
      "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress" +
      `?address=${encodeURIComponent(raw)}` +
      "&benchmark=Public_AR_Current&format=json";
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      const match = data?.result?.addressMatches?.[0];
      if (match) {
        return {
          latLng: { lat: match.coordinates.y, lng: match.coordinates.x },
          matchedAddress: match.matchedAddress ?? null,
          source: "census-geocoder",
        };
      }
    }
  } catch {
    /* fall through to Google */
  }

  // ── Fallback: Google Geocoding ────────────────────────────────────────
  if (env.googleKey) {
    const url =
      "https://maps.googleapis.com/maps/api/geocode/json" +
      `?address=${encodeURIComponent(raw)}&key=${env.googleKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    const r = data?.results?.[0];
    if (r) {
      return {
        latLng: { lat: r.geometry.location.lat, lng: r.geometry.location.lng },
        matchedAddress: r.formatted_address ?? null,
        source: "google-geocoding",
      };
    }
  }

  throw new Error(`Could not geocode "${raw}".`);
}

/** Deterministic pseudo-geocode so the demo is stable per address. */
function mockGeocode(raw: string): GeocodeResult {
  const h = hash(raw);
  // Roughly continental US bounds.
  const lat = 30 + (h % 1500) / 100; // 30.00 – 45.00
  const lng = -110 + ((h >> 4) % 3000) / 100; // -110.00 – -80.00
  return {
    latLng: { lat: round(lat), lng: round(lng) },
    matchedAddress: raw,
    source: "mock",
  };
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
function round(n: number) {
  return Math.round(n * 1e6) / 1e6;
}
