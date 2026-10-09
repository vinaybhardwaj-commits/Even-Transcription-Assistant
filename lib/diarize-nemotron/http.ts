/**
 * lib/diarize-nemotron/http.ts — what the three /api/diarize/nemotron routes share: the reply shape, the
 * gate (token, then flag), and a size-capped JSON read. Responses carry codes and counts only.
 */
import { NextResponse } from "next/server";
import { FlagValueError } from "@/lib/flags";
import { nemotronShadowEnabled } from "@/lib/diarize-engine";
import { checkWorkerBearer } from "./auth";

export const reply = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * Token FIRST, flag second: an unauthenticated caller learns nothing about whether shadow is on. Flag off →
 * 404 `disabled`, before any table is touched. A mistyped flag → 500 `bad_flag` (never read as on or off).
 */
export function gate(req: Request): NextResponse | null {
  const auth = checkWorkerBearer(req);
  if (auth) return reply(auth.status, { ok: false, error: auth.error });
  try {
    if (!nemotronShadowEnabled()) return reply(404, { ok: false, error: "disabled" });
  } catch (e) {
    if (e instanceof FlagValueError) return reply(500, { ok: false, error: "bad_flag" });
    throw e;
  }
  return null;
}

/** The body as JSON, or the failure reply. `maxChars` bounds both the declared and the actual length. */
export async function readJson(req: Request, maxChars: number): Promise<{ body: unknown } | { fail: NextResponse }> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxChars) return { fail: reply(413, { ok: false, error: "body_too_large" }) };
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { fail: reply(400, { ok: false, error: "bad_json" }) };
  }
  if (text.length > maxChars) return { fail: reply(413, { ok: false, error: "body_too_large" }) };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { fail: reply(400, { ok: false, error: "bad_json" }) };
  }
}
