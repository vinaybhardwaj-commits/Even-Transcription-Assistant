/**
 * POST /api/freescript/ingest — the box posts one eta2freescript result (migration 0157).
 *
 * 404 `disabled` when ETA_FREESCRIPT is 0 (unset is on). Auth: HMAC (lib/freescript/auth.ts, FREESCRIPT_INGEST_SECRET).
 * Body ≤ 2 MB. Writes through the APP connection. No transcript text is accepted.
 *
 *   200 { ok, run_id, inserted: 1|0 }     inserted 0 = the same artifact was already stored
 *   400 { ok:false, error }               the first validation failure (a code, never the value)
 *   401 / 503                             auth
 *   503 { ok:false, error: "db:<sqlstate>" }
 */
import { NextRequest, NextResponse } from "next/server";
import { FlagValueError } from "@/lib/flags";
import { checkFreescriptHmac } from "@/lib/freescript/auth";
import { freescriptEnabled } from "@/lib/freescript/flag";
import { ingestFreescriptPayload, validatePayload } from "@/lib/freescript/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY_CHARS = 2_000_000;

export async function POST(req: NextRequest) {
  try {
    if (!freescriptEnabled()) return NextResponse.json({ ok: false, error: "disabled" }, { status: 404 });
  } catch (e) {
    if (e instanceof FlagValueError) return NextResponse.json({ ok: false, error: "freescript_flag" }, { status: 500 });
    throw e;
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
  const auth = checkFreescriptHmac(req.headers, raw);
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
    const res = await ingestFreescriptPayload(v.payload);
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    const code = (e as { code?: string }).code ?? "unknown";
    return NextResponse.json({ ok: false, error: `db:${code}` }, { status: 503 });
  }
}
