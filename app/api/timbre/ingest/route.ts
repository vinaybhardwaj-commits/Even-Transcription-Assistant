/**
 * POST /api/timbre/ingest — the nightly Timbre job posts one run's payload (Architecture #79; tables #78, migration 0155).
 *
 * Auth: HMAC (lib/timbre/auth.ts, TIMBRE_INGEST_SECRET). The GPU host holds that secret and no database credential.
 * 404 `disabled` while TIMBRE_INGEST is not "1". Body ≤ 4 MB, validated whole before any SQL (lib/timbre/store.ts).
 * Writes through the APP connection (@/lib/db), never brain_svc (#56).
 *
 *   200 { ok, run_id, inserted: 1|0, n_windows, n_consults }   inserted 0 = the same load already exists (idempotent re-post)
 *   400 { ok:false, error }   the first validation failure (a code, never the value)
 *   401 / 503                 auth (unauthorized | stale | not_configured)
 *   503 { ok:false, error: "db:<sqlstate>" }   retry later (a CHECK violation is 23514 and will not succeed on retry)
 */
import { NextRequest, NextResponse } from "next/server";
import { checkTimbreHmac } from "@/lib/timbre/auth";
import { ingestTimbrePayload, validatePayload } from "@/lib/timbre/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY_CHARS = 4_000_000;

export async function POST(req: NextRequest) {
  if (process.env.TIMBRE_INGEST !== "1") return NextResponse.json({ ok: false, error: "disabled" }, { status: 404 });
  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
  const auth = checkTimbreHmac(req.headers, raw);
  if (auth) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const v = validatePayload(body);
  if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });
  try {
    const res = await ingestTimbrePayload(v.payload);
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    const code = (e as { code?: string }).code ?? "unknown";
    return NextResponse.json({ ok: false, error: `db:${code}` }, { status: 503 });
  }
}
