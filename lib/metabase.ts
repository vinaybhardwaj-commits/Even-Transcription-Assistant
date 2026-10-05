/**
 * lib/metabase.ts — read the Even warehouse THROUGH the Metabase API.
 *
 * Server-only. Port of the client in Even-CDMSS/lib/metabase.ts, cut down to what ETA needs: one native-SQL call.
 * Uses METABASE_URL + METABASE_API_KEY (header `x-api-key`) against Metabase's /api/dataset native-query endpoint —
 * no `pg` driver, no new credential, no firewall change. Read-only by construction: callers only ever SELECT.
 * The env values are read on each call and never logged or put in an error message.
 *
 * LIMITS. Metabase's /api/dataset caps a native result at about 2000 rows, and the endpoint takes NO bound
 * parameters, so every value that reaches the SQL text is inlined. The only value this module knows how to inline is
 * a uid list, through uidListLiteral(), which accepts [A-Za-z0-9_-] and nothing else and THROWS on anything
 * outside it (never "cleans" it): a quote, a space, a semicolon can never reach the statement.
 */

/** Database id 13 in Metabase = "Firestore to Postgres (prod)", schema public: Pulse's own records, synced from Firestore. */
export const WAREHOUSE_DB_ID = 13;

/** A hung Metabase must not eat the whole 60 s function budget of a cron door. */
export const METABASE_TIMEOUT_MS = 25_000;

/** A uid Pulse could have minted: letters, digits, underscore, hyphen. 1..128 chars. */
const SAFE_UID = /^[A-Za-z0-9_-]{1,128}$/;
export const isSafeUid = (u: unknown): u is string => typeof u === "string" && SAFE_UID.test(u);

/**
 * `'a','b','c'` for an IN (...) list, de-duplicated, in first-seen order. Throws on an empty list or on ANY element
 * outside [A-Za-z0-9_-] — callers filter with isSafeUid first and decide what an unsafe uid means for them.
 */
export function uidListLiteral(uids: readonly string[]): string {
  const seen = new Set<string>();
  for (const u of uids) {
    if (!isSafeUid(u)) throw new Error("uidListLiteral: unsafe uid refused");
    seen.add(u);
  }
  if (seen.size === 0) throw new Error("uidListLiteral: empty list");
  return Array.from(seen, (u) => `'${u}'`).join(",");
}

function baseUrl(): string {
  const u = process.env.METABASE_URL;
  if (!u) throw new Error("METABASE_URL is not set");
  return u.replace(/\/+$/, "");
}
function apiKey(): string {
  const k = process.env.METABASE_API_KEY;
  if (!k) throw new Error("METABASE_API_KEY is not set");
  return k;
}

type DatasetResponse = { status?: string; error?: unknown; data?: { rows?: unknown[][]; cols?: Array<{ name: string }> } };

/** Run a native SQL query against the warehouse via Metabase /api/dataset. Returns rows as objects keyed by column name. */
export async function metabaseQuery(query: string): Promise<Array<Record<string, unknown>>> {
  const url = `${baseUrl()}/api/dataset`;
  const key = apiKey();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), METABASE_TIMEOUT_MS);
  let text: string;
  let ok: boolean;
  let status: number;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ database: WAREHOUSE_DB_ID, type: "native", native: { query } }),
      signal: ctl.signal,
    });
    ok = res.ok;
    status = res.status;
    text = await res.text();
  } catch (e) {
    if (ctl.signal.aborted) throw new Error(`Metabase: timed out after ${METABASE_TIMEOUT_MS} ms`);
    throw new Error(`Metabase: request failed (${String((e as Error)?.name ?? "error")})`);
  } finally {
    clearTimeout(timer);
  }
  if (!ok) throw new Error(`Metabase HTTP ${status}: ${text.slice(0, 200)}`);
  let j: DatasetResponse;
  try {
    j = JSON.parse(text) as DatasetResponse;
  } catch {
    throw new Error("Metabase: non-JSON response");
  }
  if (j?.status === "failed" || j?.error) throw new Error(`Metabase query failed: ${String(j.error ?? "").slice(0, 200)}`);
  const cols = (j?.data?.cols ?? []).map((c) => c.name);
  const rows = j?.data?.rows ?? [];
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    cols.forEach((c, i) => {
      o[c] = r[i];
    });
    return o;
  });
}
