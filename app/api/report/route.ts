/**
 * POST /api/report
 * body: ReportInput
 *
 * LAYER 3 Phase 4 — the "how to build it" guide. Claude drafts the structured
 * guidance grounded in the site facts; verified links are attached server-side.
 */
import { NextRequest, NextResponse } from "next/server";
import { runReport, type ReportInput } from "@/lib/report";

export const runtime = "nodejs";
export const maxDuration = 45;

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON body." }, { status: 400 });
  }

  const input = body as ReportInput | undefined;
  if (!input || typeof input.acres !== "number")
    return NextResponse.json({ error: "Missing report input." }, { status: 400 });

  try {
    const report = await runReport(input);
    return NextResponse.json({ report });
  } catch (err: any) {
    if (err?.code === "NO_KEY") {
      return NextResponse.json(
        { error: "The build guide needs an Anthropic API key (ANTHROPIC_API_KEY).", code: "NO_KEY" },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: err?.message ?? "Report failed." }, { status: 500 });
  }
}
