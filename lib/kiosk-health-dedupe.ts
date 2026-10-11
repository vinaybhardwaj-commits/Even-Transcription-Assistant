/**
 * lib/kiosk-health-dedupe.ts — cross-source de-duplication for POST /api/kiosk-health (TS-H10 #47, the shadow period).
 *
 * Two senders post the same facts for the same Mac: the standalone daemon (source "daemon") and the helper's built-in collectors (source "helper"). ONLY that pair is ever
 * de-duplicated; events of any other source (guard, steward, ...) are never touched. An incoming event is a TWIN of a stored one when machine (same Mac under any spelling) and kind
 * match, the stored one is from the OTHER source of the pair, and the timestamps are within DEDUPE_WINDOW_MS.
 *
 * PAIRING IS ONE-TO-ONE. A stored event absorbs AT MOST ONE incoming event (it is "consumed"); candidate pairs are taken nearest-ts first, so three distinct helper events around one
 * daemon event lose exactly one (the nearest), never all three. Twins already consumed by earlier batches are read back from kiosk_health_dedupe (migration 0154: `twin_ts` names the
 * stored event that absorbed each skipped one). A skipped event is recorded with its identity only; a REPLAY of a skipped event (a spooled batch re-sent after a lost response) is
 * recognised by that identity and skipped again without using up another twin. Events from the SAME source are never twins of each other (a sender may repeat a kind within 2 s).
 * Idempotency on (machine, boot_id, seq) is unchanged and applies first.
 */
import { canonicalMachine, expandKeys, matchKey } from "@/lib/kiosk-health-read";
import { machineKeys } from "@/lib/encounter-windows/machine-keys";
import type { KioskHealthRow } from "@/lib/kiosk-health-ingest";

export const DEDUPE_WINDOW_MS = 2000;
/** most existing rows read to look for twins in one batch */
export const DEDUPE_LOOKUP_LIMIT = 20_000;
/** the only two sources that are ever twins of each other */
export const TWIN_SOURCES = ["daemon", "helper"] as const;
const inPair = (source: string): boolean => (TWIN_SOURCES as readonly string[]).includes(source);

export type StoredRef = { machine: string; kind: string; source: string; ts: string | Date };
/** one row of kiosk_health_dedupe: an incoming event that was skipped, and the stored event (source `twin_source`, ts `twin_ts`) that absorbed it */
export type LedgerRef = { machine: string; kind: string; source: string; ts: string | Date; twin_source: string; twin_ts: string | Date };
export type Dropped = { row: KioskHealthRow; twin_source: string; twin_ts: string };

const keyOf = (machine: string): string => matchKey(canonicalMachine(machine));
const ms = (t: string | Date): number => (t instanceof Date ? t.getTime() : Date.parse(t));

type Slot = { machine: string; kind: string; source: string; t: number; free: number };

/** PURE. Which of `rows` are twins of a still-available stored event, pairing one-to-one, nearest first? */
export function splitTwins(rows: readonly KioskHealthRow[], stored: readonly StoredRef[], ledger: readonly LedgerRef[] = []): { keep: KioskHealthRow[]; dropped: Dropped[] } {
  // consumption already on record: twin identity -> how many incoming events it has absorbed; skipped identity -> its record (for replays)
  const used = new Map<string, number>();
  const skipped = new Map<string, LedgerRef>();
  for (const l of ledger) {
    const tt = ms(l.twin_ts);
    const t = ms(l.ts);
    if (Number.isFinite(tt)) {
      const k = `${keyOf(l.machine)}|${l.kind}|${l.twin_source}|${tt}`;
      used.set(k, (used.get(k) ?? 0) + 1);
    }
    if (Number.isFinite(t)) skipped.set(`${keyOf(l.machine)}|${l.kind}|${l.source}|${t}`, l);
  }
  // the stored events of the pair, with the capacity each still has
  const slots = new Map<string, Slot>();
  for (const s of stored) {
    const t = ms(s.ts);
    if (!inPair(s.source) || !Number.isFinite(t)) continue;
    const k = `${keyOf(s.machine)}|${s.kind}|${s.source}|${t}`;
    const e = slots.get(k);
    if (e) e.free += 1;
    else slots.set(k, { machine: keyOf(s.machine), kind: s.kind, source: s.source, t, free: 1 });
  }
  for (const [k, e] of slots) e.free = Math.max(0, e.free - (used.get(k) ?? 0));

  const dropped = new Map<number, Dropped>();
  const pairs: Array<{ d: number; i: number; e: Slot }> = [];
  rows.forEach((r, i) => {
    const t = ms(r.ts);
    if (!inPair(r.source) || !Number.isFinite(t)) return;
    const again = skipped.get(`${keyOf(r.machine)}|${r.kind}|${r.source}|${t}`);
    if (again) {
      dropped.set(i, { row: r, twin_source: again.twin_source, twin_ts: new Date(ms(again.twin_ts)).toISOString() }); // a replay: skipped again, no second twin used
      return;
    }
    const mk = keyOf(r.machine);
    for (const e of slots.values()) {
      if (e.machine === mk && e.kind === r.kind && e.source !== r.source && e.free > 0 && Math.abs(e.t - t) <= DEDUPE_WINDOW_MS) pairs.push({ d: Math.abs(e.t - t), i, e });
    }
  });
  pairs.sort((a, b) => a.d - b.d || a.i - b.i);
  for (const p of pairs) {
    if (dropped.has(p.i) || p.e.free <= 0) continue;
    p.e.free -= 1;
    dropped.set(p.i, { row: rows[p.i]!, twin_source: p.e.source, twin_ts: new Date(p.e.t).toISOString() });
  }
  const keep: KioskHealthRow[] = [];
  const out: Dropped[] = [];
  rows.forEach((r, i) => {
    const d = dropped.get(i);
    if (d) out.push(d);
    else keep.push(r);
  });
  return { keep, dropped: out };
}

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

const span = (rows: readonly KioskHealthRow[]): { keys: string[]; kinds: string[]; lo: string; hi: string } | null => {
  const times = rows.map((r) => Date.parse(r.ts)).filter(Number.isFinite);
  if (rows.length === 0 || times.length === 0) return null;
  return {
    keys: [...new Set(rows.flatMap((r) => expandKeys(machineKeys(r.machine))))],
    kinds: [...new Set(rows.map((r) => r.kind))],
    lo: new Date(Math.min(...times) - DEDUPE_WINDOW_MS).toISOString(),
    hi: new Date(Math.max(...times) + DEDUPE_WINDOW_MS).toISOString(),
  };
};

/** The stored events that could be twins of `rows`: same machines and kinds, within the batch's time span +- the window. Read-only. */
export async function loadStoredNear(sql: Sql, rows: readonly KioskHealthRow[]): Promise<StoredRef[]> {
  const w = span(rows);
  if (!w) return [];
  return (await sql`
    SELECT machine, kind, source, ts FROM kiosk_health_events
     WHERE machine = ANY(${w.keys}::text[]) AND kind = ANY(${w.kinds}::text[]) AND ts >= ${w.lo}::timestamptz AND ts <= ${w.hi}::timestamptz
     LIMIT ${DEDUPE_LOOKUP_LIMIT}
  `) as StoredRef[];
}

/** The twins already used and the events already skipped in the same span (so pairing stays one-to-one across batches, and a replay is recognised). Read-only. */
export async function loadLedgerNear(sql: Sql, rows: readonly KioskHealthRow[]): Promise<LedgerRef[]> {
  const w = span(rows);
  if (!w) return [];
  return (await sql`
    SELECT machine, kind, source, ts, twin_source, twin_ts FROM kiosk_health_dedupe
     WHERE machine = ANY(${w.keys}::text[]) AND kind = ANY(${w.kinds}::text[]) AND ((twin_ts >= ${w.lo}::timestamptz AND twin_ts <= ${w.hi}::timestamptz) OR (ts >= ${w.lo}::timestamptz AND ts <= ${w.hi}::timestamptz))
     LIMIT ${DEDUPE_LOOKUP_LIMIT}
  `) as LedgerRef[];
}

/** Record what was skipped (identity only, no payload). Best effort: a failure is logged by count and never changes the response. */
export async function recordDropped(sql: Sql, dropped: readonly Dropped[]): Promise<void> {
  if (dropped.length === 0) return;
  try {
    await sql`
      INSERT INTO kiosk_health_dedupe (machine, kind, source, twin_source, ts, twin_ts)
      SELECT * FROM unnest(${dropped.map((d) => d.row.machine)}::text[], ${dropped.map((d) => d.row.kind)}::text[], ${dropped.map((d) => d.row.source)}::text[],
                           ${dropped.map((d) => d.twin_source)}::text[], ${dropped.map((d) => d.row.ts)}::timestamptz[], ${dropped.map((d) => d.twin_ts)}::timestamptz[])
      ON CONFLICT DO NOTHING
    `;
  } catch {
    console.warn(`[kiosk-health] dedupe record failed, rows=${dropped.length}`);
  }
}
