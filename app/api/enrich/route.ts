/**
 * POST /api/enrich
 * body: { parcel: Parcel, input: SiteProfile["input"] }
 *
 * STAGE 2 → 4. Runs the parallel fan-out, normalizes to a Site Profile, and
 * caches it keyed by parcel ID. Called by the client AFTER /api/parcel has
 * already painted parcel + zoning — so the slow federal services never block
 * the first render.
 *
 * Cache-first: if a fresh profile already exists for this parcel, return it
 * immediately (the second viewer of a parcel costs ~$0).
 */
import { NextRequest, NextResponse } from "next/server";
import { enrich } from "@/lib/enrich";
import { getCachedProfile, putCachedProfile } from "@/lib/cache";
import type { Parcel, SiteProfile } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60; // FEMA/SSURGO can be slow when live.

export async function POST(req: NextRequest) {
  let parcel: Parcel;
  let input: SiteProfile["input"];
  try {
    ({ parcel, input } = await req.json());
  } catch {
    return NextResponse.json({ error: "Bad JSON body." }, { status: 400 });
  }
  if (!parcel?.parcelId) {
    return NextResponse.json({ error: "Missing parcel." }, { status: 400 });
  }

  try {
    const cached = await getCachedProfile(parcel.parcelId);
    if (cached) return NextResponse.json({ profile: cached, cached: true });

    const profile = await enrich(parcel, input);
    await putCachedProfile(profile);
    return NextResponse.json({ profile, cached: false });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Enrichment failed." },
      { status: 500 }
    );
  }
}
