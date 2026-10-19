/**
 * lib/spine/ingest-store.ts — Spine S1 writes. The only table written is spine_signal (append-only) plus one spine_tick row per live pass.
 *   ingestSpineSignals(now)  the cron step: copy I2 / I5 / I6 rows from the last 72 h (D7 horizon) into spine_signal, rev on change.
 *   storeSignals(rows)       the POST path: insert box-posted signals; a row with no source_rev gets its rev from the newest stored one.
 *   readIngestMode()         spine_config gate; a read failure means off.
 * Nothing reads spine_signal yet.
 */
import { sql } from "@/lib/db";
import { readHypothesesSince } from "@/lib/encounter-hypotheses";
import { parseIngestMode, type IngestMode } from "./config";
import { hashOfSignal, nextRev, toSignals, type IngestProxy, type Prior, type SignalRow } from "./ingest";
import type { PostedSignal } from "./signal-validate";

type Q = (text: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;
const q = (): Q => sql as unknown as Q;

const HORIZON_MS = 72 * 3_600_000;
const BATCH = 500;
const READ_LIMIT = 5000;

export async function readIngestMode(): Promise<IngestMode> {
  try {
    const rows = await q()("SELECT key, value FROM spine_config WHERE key IN ('kill_switch', 'ingest')", []);
    return parseIngestMode(rows as Array<{ key: string; value: unknown }>);
  } catch {
    return "off";
  }
}

const INSERT_SQL = `
INSERT INTO spine_signal (proxy, source_key, source_rev, room_id, t_open, t_close, observed_at, attrs)
SELECT x.proxy, x.source_key, x.source_rev, x.room_id, x.t_open, x.t_close, x.observed_at, x.attrs
FROM jsonb_to_recordset($1::jsonb) AS x(proxy text, source_key text, source_rev int, room_id text, t_open timestamptz, t_close timestamptz, observed_at timestamptz, attrs jsonb)
ON CONFLICT (proxy, source_key, source_rev) DO NOTHING
RETURNING 1 AS n`;

/** Insert rows that already carry their rev. -> how many were new (the rest were duplicates). */
async function insertRows(rows: ReadonlyArray<SignalRow>): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const res = await q()(INSERT_SQL, [JSON.stringify(rows.slice(i, i + BATCH))]);
    inserted += res.length;
  }
  return inserted;
}

/** Newest stored rev + hash per source_key for one proxy, rebuilt from the stored columns. */
async function loadPrior(proxy: string, keys: ReadonlyArray<string>): Promise<Prior> {
  const prior = new Map<string, { rev: number; hash: string }>();
  for (let i = 0; i < keys.length; i += BATCH) {
    const rows = await q()(
      `SELECT DISTINCT ON (source_key) source_key, source_rev, room_id, t_open, t_close, attrs->>'close_reason' AS close_reason
       FROM spine_signal WHERE proxy = $1 AND source_key IN (SELECT jsonb_array_elements_text($2::jsonb)) ORDER BY source_key, source_rev DESC`,
      [proxy, JSON.stringify(keys.slice(i, i + BATCH))],
    );
    for (const r of rows) {
      prior.set(String(r.source_key), {
        rev: Number(r.source_rev),
        hash: hashOfSignal({ room_id: (r.room_id as string | null) ?? null, t_open: String(r.t_open), t_close: r.t_close ? String(r.t_close) : null, attrs: { close_reason: (r.close_reason as string | null) ?? undefined } }),
      });
    }
  }
  return prior;
}

export type StoreCounts = { inserted: number; duplicate: number };

/** The POST path. A row with an explicit source_rev is inserted as sent; one without gets the rev rule against the newest stored rev. */
export async function storeSignals(rows: ReadonlyArray<PostedSignal>): Promise<StoreCounts> {
  const ready: SignalRow[] = [];
  let duplicate = 0;
  const byProxy = new Map<string, PostedSignal[]>();
  for (const r of rows) {
    if (r.source_rev !== undefined) ready.push({ ...r, source_rev: r.source_rev });
    else byProxy.set(r.proxy, [...(byProxy.get(r.proxy) ?? []), r]);
  }
  for (const [proxy, list] of byProxy) {
    const prior = await loadPrior(proxy, [...new Set(list.map((r) => r.source_key))]);
    const latest = new Map(prior);
    for (const r of list) {
      const hash = hashOfSignal(r);
      const p = latest.get(r.source_key);
      if (p && p.hash === hash) { duplicate += 1; continue; }
      const rev = nextRev(p, hash);
      latest.set(r.source_key, { rev, hash });
      ready.push({ ...r, source_rev: rev });
    }
  }
  const inserted = await insertRows(ready);
  return { inserted, duplicate: duplicate + (ready.length - inserted) };
}

export type IngestCounts = { skipped: "off" } | { mode: "shadow" | "live"; read: Record<IngestProxy, number>; inserted: Record<IngestProxy, number> };

const sinceIso = (now: number) => new Date(now - HORIZON_MS).toISOString();

const SOURCES: Record<IngestProxy, { sql: string; params: (now: number) => unknown[] }> = {
  pulse: {
    sql: `SELECT consult_key, consult_uid, room_id, t_open, t_close, close_reason, quality, computed_at FROM eta_encounter_windows WHERE t_open >= $1::timestamptz ORDER BY t_open DESC LIMIT ${READ_LIMIT}`,
    params: (now) => [sinceIso(now)],
  },
  acoustic: {   // read through the hypothesis store (lib/encounter-hypotheses.ts), which alone queries that table
    sql: "",
    params: () => [],
  },
  timeline: {   // the newest run's row per consult_key
    sql: `SELECT DISTINCT ON (t.consult_key) t.consult_key, t.id, t.run_id, t.room_day_id, d.room_id, t.start_ms, t.end_ms, t.closed_by, t.created_at
          FROM encounter_timeline_shadow t LEFT JOIN room_day d ON d.id = t.room_day_id WHERE t.start_ms >= $1::bigint ORDER BY t.consult_key, t.created_at DESC LIMIT ${READ_LIMIT}`,
    params: (now) => [String(now - HORIZON_MS)],
  },
};

export async function ingestSpineSignals(now: number): Promise<IngestCounts> {
  const mode = await readIngestMode();
  if (mode !== "shadow" && mode !== "live") return { skipped: "off" };
  const read = { pulse: 0, acoustic: 0, timeline: 0 };
  const inserted = { pulse: 0, acoustic: 0, timeline: 0 };
  for (const proxy of ["pulse", "acoustic", "timeline"] as const) {
    const src = SOURCES[proxy];
    const rows = proxy === "acoustic" ? await readHypothesesSince(now - HORIZON_MS, READ_LIMIT) : await q()(src.sql, src.params(now));
    read[proxy] = rows.length;
    const keyOf = (r: Record<string, unknown>) => String(proxy === "acoustic" ? r.id : r.consult_key);
    const prior = await loadPrior(proxy, [...new Set(rows.map(keyOf))]);
    inserted[proxy] = await insertRows(toSignals(rows, proxy, prior));
  }
  const counts = { mode, read, inserted };
  await q()("INSERT INTO spine_tick (kind, counts) VALUES ($1, $2::jsonb)", ["ingest", JSON.stringify(counts)]);
  return counts;
}
