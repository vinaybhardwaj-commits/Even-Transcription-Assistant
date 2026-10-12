/**
 * POST /api/consult-index/mirror-run — the index-mirror run reports its own exit.
 *
 * The R2 manifest ETA already ingests (consult/index/manifest.json) has no exit field today.
 * This is that field: { exit_code: integer, reason?: short token }. Authorization: Bearer
 * INDEX_MIRROR_INGEST_TOKEN (constant-time). Unset token → 503 not_configured; wrong token → 401.
 * A non-zero exit stays the latest run until a later report says otherwise.
 * Logs carry a sqlstate only. No consult uid, no room, no free text.
 */
import { NextRequest, NextResponse } from "next/server";
import { bearerMatches, parseMirrorRunBody, sqlState } from "@/lib/consult-index/mirror-staleness";
import { insertIngestMirrorRun } from "@/lib/room-access/consult-index-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 4_096;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(req: NextRequest) {
  const token = process.env.INDEX_MIRROR_INGEST_TOKEN?.trim() ?? "";
  if (!token) return json({ ok: false, error: "not_configured" }, 503);
  if (!bearerMatches(req.headers.get("authorization") ?? "", [token])) return json({ ok: false, error: "unauthorized" }, 401);

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) return json({ ok: false, error: "bad_body" }, 413);
  let text: string;
  try {
    text = await req.text();
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }
  if (text.length > MAX_BODY) return json({ ok: false, error: "bad_body" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }
  const parsed = parseMirrorRunBody(body);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);
  try {
    await insertIngestMirrorRun(parsed.run);
  } catch (e) {
    console.error("[index-mirror] ingest failed", JSON.stringify({ sqlstate: sqlState(e), exit_code: parsed.run.exit_code }));
    return json({ ok: false, error: "db" }, 503);
  }
  return json({ ok: true, exit_code: parsed.run.exit_code });
}
