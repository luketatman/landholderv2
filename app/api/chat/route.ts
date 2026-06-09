/**
 * POST /api/chat
 * body: { messages: ChatMsg[], site: SiteContext, elements: StudioElement[] }
 *
 * LAYER 3 Phase 2 — the design-studio chatbot. Sends the conversation + the
 * current plan to Claude, which returns edit operations; we apply them and
 * return the updated StudioElements plus a short reply.
 */
import { NextRequest, NextResponse } from "next/server";
import { runPlanChat, type ChatMsg, type SiteContext } from "@/lib/planChat";
import type { StudioElement } from "@/lib/feasibilityTypes";

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
  const site = body?.site as SiteContext | undefined;
  const elements = (body?.elements as StudioElement[] | undefined) ?? [];
  if (!Array.isArray(messages) || !messages.length)
    return NextResponse.json({ error: "No messages." }, { status: 400 });
  if (!site?.centroid)
    return NextResponse.json({ error: "Missing site context." }, { status: 400 });

  try {
    const out = await runPlanChat(messages, site, elements);
    return NextResponse.json(out);
  } catch (err: any) {
    if (err?.code === "NO_KEY") {
      return NextResponse.json(
        {
          error:
            "The chatbot isn't connected yet. Add an Anthropic API key (ANTHROPIC_API_KEY) to enable it.",
          code: "NO_KEY",
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: err?.message ?? "Chat failed." },
      { status: 500 }
    );
  }
}
