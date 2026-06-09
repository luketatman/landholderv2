/**
 * POST /api/feasibility
 * body: { profile: SiteProfile, projectType: ProjectType, params?: ProjectParams }
 *
 * LAYER 2. Consumes a finished Site Profile + the user's goal and returns a
 * FeasibilityResult: buildable envelope, program, and an overhead site-plan
 * SVG. Pure + deterministic — no external calls, fast.
 */
import { NextRequest, NextResponse } from "next/server";
import { runFeasibility } from "@/lib/feasibility";
import { ProjectTypeEnum, ProjectParamsSchema } from "@/lib/feasibilityTypes";
import type { SiteProfile } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON body." }, { status: 400 });
  }

  const typeParsed = ProjectTypeEnum.safeParse(body?.projectType);
  if (!typeParsed.success)
    return NextResponse.json({ error: "Unknown projectType." }, { status: 400 });

  const profile = body?.profile as SiteProfile | undefined;
  if (!profile?.parcelId || !profile?.parcel)
    return NextResponse.json({ error: "Missing or incomplete Site Profile." }, { status: 400 });

  const params = ProjectParamsSchema.safeParse(body?.params ?? {});
  if (!params.success)
    return NextResponse.json({ error: "Invalid params." }, { status: 400 });

  try {
    const result = runFeasibility(profile, typeParsed.data, params.data);
    return NextResponse.json({ result });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Feasibility failed." },
      { status: 500 }
    );
  }
}
