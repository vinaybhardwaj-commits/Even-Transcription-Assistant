/**
 * POST /api/encounter-catalog/ingest — the lab box posts a batch of catalog rows (migration 0168).
 *
 * Auth: HMAC (lib/encounter-catalog/auth.ts, ENCOUNTER_CATALOG_INGEST_SECRET; an unset secret fails closed with 503).
 * Body ≤ 4 MB, ≤ 500 rows {"rows":[...]}. Field-level upsert by consult_uid. Writes through the APP connection.
 * No transcript text is accepted: any key named text / transcript / note / content (or text_*) at any depth is refused.
 *
 *   200 { ok, updated, inserted }
 *   400 { ok:false, error }      the first validation failure (a code, never the value)
 *   401 / 503                    auth
 *   409 { ok:false, error:"concurrent_insert" }  two posts raced on a new consult_uid and a row was neither updated nor inserted after one rerun: the sender retries
 *   413 too_large
 *   503 { ok:false, error: "db:<sqlstate>" }
 */
import { NextRequest, NextResponse } from "next/server";
import { checkCatalogHmac } from "@/lib/encounter-catalog/auth";
import { ConcurrentIngestError, ingestCatalogRows, MAX_BODY_CHARS, validateBatch } from "@/lib/encounter-catalog/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
  const auth = checkCatalogHmac(req.headers, raw);
  if (auth) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const v = validateBatch(body);
  if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });
  try {
    const res = await ingestCatalogRows(v.rows);
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    if (e instanceof ConcurrentIngestError) return NextResponse.json({ ok: false, error: "concurrent_insert", missing: e.missing }, { status: 409 });
    const code = (e as { code?: string }).code ?? "unknown";
    return NextResponse.json({ ok: false, error: `db:${code}` }, { status: 503 });
  }
}
