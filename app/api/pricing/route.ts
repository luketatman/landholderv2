/**
 * POST /api/pricing
 * body: { messages: ChatMsg[], project: ProjectCostInput, context: PricingContext }
 *
 * LAYER 3 Phase 3 — the pricing intake chatbot. Claude runs a short guided
 * interview; when it has enough, it finalizes a build spec and the server runs
 * the deterministic cost engine. Returns { done, reply, estimate?, spec? }.
 */
import { NextRequest, NextResponse } from "next/server";
import { runPricingChat, type PricingContext } from "@/lib/pricingChat";
import type { ChatMsg } from "@/lib/planChat";
import type { ProjectCostInput } from "@/lib/cost";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON body." }, { status: 400 });
  }

  const messages = body?.messages as ChatMsg[] | undefined;
  const project = body?.project as ProjectCostInput | undefined;
  const context = (body?.context as PricingContext | undefined) ?? {
    slopePct: null,
    floodZone: null,
    locationLabel: null,
  };
  if (!Array.isArray(messages) || !messages.length)
    return NextResponse.json({ error: "No messages." }, { status: 400 });
  if (!project || typeof project.buildingGrossSqft !== "number")
    return NextResponse.json({ error: "Missing project cost input." }, { status: 400 });

  try {
    const out = await runPricingChat(messages, project, context);
    return NextResponse.json(out);
  } catch (err: any) {
    if (err?.code === "NO_KEY") {
      return NextResponse.json(
        { error: "Pricing chat needs an Anthropic API key (ANTHROPIC_API_KEY).", code: "NO_KEY" },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: err?.message ?? "Pricing failed." }, { status: 500 });
  }
}
