/**
 * POST /api/admin/bench/clip-urls — presigned GET URLs for bench window clips.
 *
 * WHY THIS EXISTS. R2 credentials stay server-side by design; an engineering pane on the Mini is
 * handed presigned URLs, never keys (lib/jobs/kinds/emotion-window.ts uses signGetUrl the same
 * way). No route presigned a BENCH WINDOW clip, so a pane that needed the audio for ten windows
 * had no way to get it except a human's browser cookie.
 *
 * { window_ids: string[] }  (1..50, deduplicated)
 *   -> { urls: { [window_id]: string }, missing: number }
 *
 * A window whose clip_r2_key is NULL (or blank) is OMITTED from `urls` and counted in `missing`.
 * A null URL is never returned: a caller must not be able to fetch nothing and think it fetched
 * something. A window id that does not exist is omitted too, and is not an error — it is not
 * counted in `missing` (that field is windows found without a clip), so
 * `Object.keys(urls).length + missing <= unique ids requested`.
 *
 * The response carries ids and URLs only: no transcript text, no clinician or patient name, no
 * room label. URLs expire in 3600 s.
 *
 * Auth is the bench admin's two doors (lib/operator-auth.ts): the admin cookie, or `Authorization:
 * Bearer ${OPERATOR_TOKEN}`. With OPERATOR_TOKEN unset the bearer door does not exist.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { signGetUrl } from "@/lib/r2";
import { respondOk, respondError } from "@/lib/respond";
import { benchAdminPrincipal } from "@/lib/operator-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The most window ids one call may ask for. */
const MAX_WINDOW_IDS = 50;
/** Presign lifetime, seconds. Long enough to cut a couple of dozen clips, short enough not to linger. */
const CLIP_URL_EXPIRY_S = 3600;
/** The longest window id the live table holds is 33 characters; anything past this is not one. */
const MAX_ID_LEN = 100;

export async function POST(req: NextRequest) {
  if ((await benchAdminPrincipal(req)) === null) return respondError("AUTH_REQUIRED", "Sign in required");

  let body: { window_ids?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  const raw = body?.window_ids;
  if (!Array.isArray(raw)) return respondError("VALIDATION_FAILED", "window_ids_required");
  if (raw.length > MAX_WINDOW_IDS) return respondError("VALIDATION_FAILED", `window_ids_max_${MAX_WINDOW_IDS}`);
  const ids: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || v.trim() === "" || v.length > MAX_ID_LEN) {
      return respondError("VALIDATION_FAILED", "window_ids_must_be_ids");
    }
    ids.push(v);
  }
  const unique = [...new Set(ids)];
  if (unique.length === 0) return respondOk({ urls: {}, missing: 0 });

  const rows = (await sql`
    SELECT id, clip_r2_key FROM bench_window WHERE id = ANY(${unique}::text[])
  `) as Array<{ id: string; clip_r2_key: string | null }>;

  const withClip = rows.filter((r) => typeof r.clip_r2_key === "string" && r.clip_r2_key.trim() !== "");
  const missing = rows.length - withClip.length;

  const urls: Record<string, string> = {};
  try {
    const signed = await Promise.all(
      withClip.map(async (r) => [r.id, await signGetUrl({ key: r.clip_r2_key!, expiresInSeconds: CLIP_URL_EXPIRY_S })] as const),
    );
    for (const [id, url] of signed) urls[id] = url;
  } catch (e) {
    // The provider's message can quote a key or a bucket; the log gets the class alone.
    console.error("[bench-clip-urls] presign failed", JSON.stringify({ err: e instanceof Error ? e.name : "unknown", n: withClip.length }));
    return respondError("UPSTREAM_UNAVAILABLE", "presign_failed");
  }

  return respondOk({ urls, missing });
}
