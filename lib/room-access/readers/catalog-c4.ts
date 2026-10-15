/**
 * Reader catalog_c4 — 23N-2 (15 Oct 2026): the jev, clef_affect and presence columns of encounter_catalog (migration 0169), joined to the R2 catalog rows by consult_uid.
 *
 * Ids, tokens, scores and UTC ms only (the ingest validates strict shapes and refuses text keys; this reader checks again and returns null for a column that holds a text-like key at any depth).
 * The caller returns them to admin callers only, the way the HTTP search route does. Nothing here writes, logs a value, or throws. At most 500 uids per query; the caller chunks.
 * A missing column (0169 not applied) or any SQL error is {status:"error", code} (a SQLSTATE or a fixed word, never a value).
 */
import { sql } from "@/lib/db";

export const C4_CHUNK = 500;
/** The same key rule the ingest applies (lib/encounter-catalog/store.ts): text, transcript, note, content and their _x / plural forms. */
const TEXT_KEY = /^(text|transcript|note|content)(_|s?$)/i;

export type C4Row = { jev: unknown; clef_affect: unknown; presence: unknown };
export type C4Result = { status: "ok"; rows: Map<string, C4Row> } | { status: "error"; code: string };

const hasTextKey = (v: unknown): boolean => {
  if (Array.isArray(v)) return v.some(hasTextKey);
  if (typeof v !== "object" || v === null) return false;
  return Object.entries(v as Record<string, unknown>).some(([k, x]) => TEXT_KEY.test(k) || hasTextKey(x));
};
/** An object column as stored, or null (absent, not an object, or carrying a text-like key). */
const col = (v: unknown): unknown => (typeof v === "object" && v !== null && !Array.isArray(v) && !hasTextKey(v) ? v : null);

export async function c4For(uids: readonly string[]): Promise<C4Result> {
  if (uids.length > C4_CHUNK) return { status: "error", code: "too_many_uids" };
  const rows = new Map<string, C4Row>();
  if (uids.length === 0) return { status: "ok", rows };
  try {
    const got = (await sql`
      SELECT consult_uid, jev, clef_affect, presence FROM encounter_catalog WHERE consult_uid = ANY(${[...uids]}::text[])
    `) as Array<Record<string, unknown>>;
    for (const r of got) if (typeof r.consult_uid === "string") rows.set(r.consult_uid, { jev: col(r.jev), clef_affect: col(r.clef_affect), presence: col(r.presence) });
    return { status: "ok", rows };
  } catch (e) {
    const c = (e as { code?: unknown })?.code;
    return { status: "error", code: typeof c === "string" && /^[0-9A-Z]{5}$/.test(c) ? `db_error:${c}` : "read_failed" };
  }
}

/** The block returned to admin callers. */
export const c4View = (r: C4Row | undefined) => ({ jev: r?.jev ?? null, clef_affect: r?.clef_affect ?? null, presence: r?.presence ?? null });
