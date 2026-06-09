/**
 * POST /api/parcel
 * body: { query: string }
 *
 * STAGE 0 → 1, the fast path. Geocode the input, resolve the anchor parcel,
 * return parcel + zoning IMMEDIATELY. Enrichment is fetched separately by
 * /api/enrich so the UI never blocks on the slow federal services.
 */
import { NextRequest, NextResponse } from "next/server";
import { geocode } from "@/lib/geocode";
import { resolveParcel } from "@/lib/parcel";
import { getCachedProfile } from "@/lib/cache";
import { SITE_PROFILE_VERSION, type ParcelResponse } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  let query = "";
  try {
    ({ query } = await req.json());
  } catch {
    return NextResponse.json({ error: "Bad JSON body." }, { status: 400 });
  }
  if (!query || typeof query !== "string") {
    return NextResponse.json(
      { error: "Provide an address, parcel number, or lat,lng." },
      { status: 400 }
    );
  }

  const kind: "address" | "pin" | "boundary" = /^-?\d+\.\d+\s*,/.test(query)
    ? "pin"
    : "address";

  try {
    const g = await geocode(query);
    const parcel = await resolveParcel(g.latLng, query);

    // Cache hit short-circuit: if we already have a fresh full profile,
    // signal it so the client can skip re-enriching.
    const cached = await getCachedProfile(parcel.parcelId);

    const body: ParcelResponse = {
      version: SITE_PROFILE_VERSION,
      parcelId: parcel.parcelId,
      input: { raw: query, kind, geocoded: g.latLng },
      parcel,
      cached: Boolean(cached),
    };
    return NextResponse.json(body);
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Lookup failed." },
      { status: 422 }
    );
  }
}
