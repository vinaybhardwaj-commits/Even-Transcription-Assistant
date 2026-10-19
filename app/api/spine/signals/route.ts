/**
 * POST /api/spine/signals — the lab box posts signals (pqm, cutter, caa, ...) into spine_signal (Spine S1, D10: bearer token, the box holds no DB credential).
 *
 * Auth: `Authorization: Bearer $SPINE_INGEST_TOKEN`. Unset or blank token -> 503 (fail closed); wrong or missing bearer -> 401 (scheme exactly "Bearer ", constant-time compare).
 * Body: a JSON array of up to 500 signals, ≤ 1 MB. A signal is {proxy, source_key, source_rev?, room_id?, t_open, t_close?, observed_at, attrs?}; attrs allows only ids / quality / close_reason.
 * A key matching the PHI word list at ANY depth (normalised, see lib/spine/phi-screen.ts), or a value outside the closed rules, is refused 422 (a code, never the value).
 * Idempotent: a repeat of the same (proxy, source_key, source_rev) is counted as duplicate. With no source_rev the server applies the rev rule (new rev only when the span, room or close reason changed).
 * Gated like the cron: spine_config kill_switch / ingest off -> 200 { ok:true, skipped:"off" } and nothing is written (the sender may re-post later).
 *
 *   200 { ok, inserted, duplicate, conflict }   400 { ok:false, error }   401 / 503 auth   413 too_large   422 text_key | too_deep   503 db:<sqlstate>
 */
import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/spine/auth";
import { readIngestMode, storeSignals } from "@/lib/spine/ingest-store";
import { MAX_BODY_CHARS, validateSignals } from "@/lib/spine/signal-validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SPINE_INGEST_TOKEN_ENV = "SPINE_INGEST_TOKEN";
const NO_STORE = { headers: { "cache-control": "no-store" } };
const fail = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status, ...NO_STORE });

export async function POST(req: NextRequest) {
  const want = (process.env[SPINE_INGEST_TOKEN_ENV] ?? "").trim();
  if (!want) return fail(503, "not_configured");
  if (!bearerMatches(req.headers.get("authorization"), want)) return fail(401, "unauthorized");

  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) return fail(413, "too_large");
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return fail(400, "bad_json"); }
  const v = validateSignals(body);
  if (!v.ok) return fail(v.status, v.error);

  try {
    const mode = await readIngestMode();
    if (mode !== "shadow" && mode !== "live") return NextResponse.json({ ok: true, skipped: "off" }, NO_STORE);
    const res = await storeSignals(v.rows);
    return NextResponse.json({ ok: true, ...res }, NO_STORE);
  } catch (e) {
    return fail(503, `db:${(e as { code?: string }).code ?? "unknown"}`);
  }
}
