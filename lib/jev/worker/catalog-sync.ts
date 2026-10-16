/**
 * lib/jev/worker/catalog-sync.ts — CATALOG-C4-SYNC: copy Jev answers (`jev`) and Clef affect (`clef_affect`) onto existing encounter_catalog rows.
 *
 * IN-PROCESS, a step at the end of the jev-sweep cron. It writes ONLY through validateBatch and ingestCatalogRows (the ingest route's own validator and SQL); it never
 * writes SQL against encounter_catalog. SHIPS DARK: CATALOG_C4_SYNC_ENABLED unset/0 reads NOTHING; an unrecognised value is read as off and counted (`bad_flag`).
 * A row is {consult_uid, jev?, clef_affect?} and nothing else: no generated_at (it belongs to the box feed's stale-write guard), no ist_date. Only consults that already have a
 * catalog row are candidates (the select's inner join), so `inserted` must be 0. Idempotent: a block deep-equal (canonical JSON) to the stored column is not posted.
 * Counts and one class token leave this module; no id, value or error text is logged or returned.
 *
 * FU2: the ingest runs updateOnly (a uid with no row is counted `missing`, never inserted). Every posted sets[] entry carries state current|retired; the block posted
 * is built from the STORED block, so an entry whose set left shadow/live or whose sha was superseded is kept with state `retired` and is never removed. The only way an
 * entry leaves is the 50-entry cap (oldest retired first), counted in `capped`. The sync never posts `jev: null`.
 */
import { FlagValueError } from "@/lib/flags";
import { ConcurrentIngestError, ingestCatalogRows, validateBatch, type CatalogRow } from "@/lib/encounter-catalog/store";
import { QUESTION_SET_FILES } from "@/jev/question-sets";
import { selectC4Candidates, selectC4CandidatesBefore, selectClefPicks, selectCurrentSets, selectJevPicks, type Candidate, type ClefPick, type CurrentSet, type Cursor, type JevPick } from "@/lib/room-access/catalog-c4-select";
import { canonicalJson } from "./canonical";
import { classifyDbError } from "./errors";
import { parseBackfillSince } from "./consult-eligible";
import { catalogC4SyncEnabled } from "./flags";
import { validateSetFile, type QuestionSetFile } from "./sets";

/** A noul answer at or above this reads "yes" (the label is a closed enum, never a model string). */
export const NOUL_YES_THRESHOLD = 0.5;
export const BATCH_ROWS = 500;          // store MAX_ROWS
export const MAX_SETS_PER_ROW = 50;     // store MAX_SETS
export const WINDOW_DAYS = 8;
/** CS-2: wall-clock budget for one tick, measured from the step's start; checked before each page select only (FIX1: the collected rows, at most 500, are always posted; one bounded ingest fits the slack under maxDuration). */
export const CATALOG_SYNC_BUDGET_MS = 20_000;
/** FIX1 X1: hard wall-clock limit on the whole step, every statement included, measured from the step's start; inside maxDuration 60. */
export const CATALOG_SYNC_HARD_MS = 35_000;
/** FU2 G3 (FU1-3): wall-clock limit on each of the four selects and the ingest. A Promise race, not SET LOCAL: see withTimeout. */
export const CATALOG_SYNC_STATEMENT_TIMEOUT_MS = 15_000;
const PAGE = 500;
const MAX_PAGES = 10;
/** Same shape as store.ts TOKEN (INFERRED: store.ts does not export it, and this slice may not edit it). The final gate is validateBatch either way. */
const TOKEN = /^[A-Za-z0-9_:.-]{1,60}$/;
const BANDS = new Set(["act", "caution", "review", "abstain"]);

export type CatalogCounts = {
  posted: number; updated: number; inserted: number; stale: number; unchanged: number;
  skipped_off_enum: number; skipped_bad_token: number; budget_hit: boolean; capped: number;
  missing: number; retried: number; retired: number; invariant_dropped: number; error_class: string | null;
  backfill_rows: number;      // rows collected by the CATALOG_C4_BACKFILL_SINCE second scan (0 when OFF)
};
export const zeroCounts = (): CatalogCounts => ({ posted: 0, updated: 0, inserted: 0, stale: 0, unchanged: 0, skipped_off_enum: 0, skipped_bad_token: 0, budget_hit: false, capped: 0, missing: 0, retried: 0, retired: 0, invariant_dropped: 0, error_class: null, backfill_rows: 0 });

type Kind = "choice" | "noul" | "score";
type QDef = { kind: Kind; options: Set<string> | null; levels: number };

let defs: Map<string, QDef> | null = null;
/** `<set_id>@<version>:<question_id>` -> kind and the closed answer menu, from the question-set FILES the deploy carries. */
function setDefs(): Map<string, QDef> {
  if (defs) return defs;
  const m = new Map<string, QDef>();
  for (const raw of QUESTION_SET_FILES) {
    let f: QuestionSetFile;
    try { f = validateSetFile(raw); } catch { continue; }
    for (const q of f.questions) {
      const crit = (q.body as { criteria?: unknown }).criteria;
      m.set(`${f.id}@${f.version}:${q.question_id}`, {
        kind: q.kind,
        options: q.kind === "choice" && crit && typeof crit === "object" ? new Set(Object.keys(crit as Record<string, unknown>)) : null,
        levels: q.kind === "score" && Array.isArray(crit) ? crit.length : 0,
      });
    }
  }
  defs = m;
  return m;
}
export const _resetDefsForTests = (): void => { defs = null; };

export type JevEntry = { set_id: string; set_sha: string; band: string | null; label: string | null; model: string; at: string; state?: "current" | "retired" };

/** The closed label for one answer, or null (off-enum). */
export function labelOf(def: QDef | undefined, answer: unknown): string | null {
  const a = answer as { type?: unknown; choice?: unknown; noul?: unknown; score?: unknown } | null;
  if (!def || !a || typeof a !== "object" || a.type !== def.kind) return null;
  if (def.kind === "choice") return typeof a.choice === "string" && def.options?.has(a.choice) && TOKEN.test(a.choice) ? a.choice : null;
  if (def.kind === "noul") return typeof a.noul === "number" && Number.isFinite(a.noul) ? (a.noul >= NOUL_YES_THRESHOLD ? "yes" : "no") : null;
  return typeof a.score === "number" && Number.isInteger(a.score) && a.score >= 0 && a.score <= def.levels - 1 ? `score_${a.score}` : null;
}

/** The fresh (current) entries for one consult from its picks. Uncapped: the cap is applied once, on the merged block. */
export function freshEntries(picks: JevPick[], c: CatalogCounts): JevEntry[] {
  const entries: JevEntry[] = [];
  for (const p of picks) {
    const setId = `${p.set_id}:${p.question_id}`;
    if (!TOKEN.test(setId) || !TOKEN.test(p.model)) { c.skipped_bad_token++; continue; }
    const label = labelOf(setDefs().get(`${p.set_id}@${p.set_version}:${p.question_id}`), p.answer);
    if (label === null) c.skipped_off_enum++;
    let band: string | null = null;
    if (p.band !== null && p.band !== undefined) { if (BANDS.has(p.band)) band = p.band; else c.skipped_off_enum++; }
    entries.push({ set_id: setId, set_sha: p.set_sha, band, label, model: p.model, at: p.at, state: "current" });
  }
  return entries;
}

const keyOf = (e: { set_id: string; set_sha: string }): string => `${e.set_id}\u0000${e.set_sha}`;
const byKey = (x: JevEntry, y: JevEntry): number => (keyOf(x) < keyOf(y) ? -1 : keyOf(x) > keyOf(y) ? 1 : 0);
const newestFirst = (x: JevEntry, y: JevEntry): number => (x.at < y.at ? 1 : x.at > y.at ? -1 : keyOf(x) < keyOf(y) ? -1 : 1);

/** The stored sets array, or null when the stored value is not the shape this sync writes (then the row's jev is not touched: we cannot promise to carry what we cannot read). */
export function storedEntries(stored: unknown): JevEntry[] | null {
  if (stored === null || stored === undefined) return [];
  const sets = (stored as { sets?: unknown }).sets;
  if (typeof stored !== "object" || !Array.isArray(sets)) return null;
  for (const e of sets) if (!e || typeof e !== "object" || typeof (e as JevEntry).set_id !== "string" || typeof (e as JevEntry).set_sha !== "string") return null;
  return sets as JevEntry[];
}

/** A set_id is `<set>:<question>`; an entry is current when some shadow/live set's id prefixes it AND that set's current sha is the entry's sha. */
export const isCurrentEntry = (e: { set_id: string; set_sha: string }, cur: CurrentSet[]): boolean => cur.some((s) => e.set_id.startsWith(`${s.id}:`) && s.sha === e.set_sha);

export type Merged = { sets: JevEntry[] };
/** keys of entries dropped by the cap, so the carry-forward assertion can tell them from a bug */
export type MergeResult = { block: Merged | null; capDropped: Set<string>; newlyRetired: number };

/**
 * FU2 G2: the block to post, from the STORED block and this tick's fresh entries.
 * Stored entries are all carried: no longer current -> state `retired`, every other field byte-equal; current and recomputed -> the fresh entry; current with no fresh pick
 * (and legacy, no state) -> the stored fields with state `current`. Fresh entries not stored are added. Then the cap (oldest retired first; if current entries alone exceed the
 * cap, the newest of them). `capped` counts every entry the cap drops.
 */
export function mergeJev(stored: JevEntry[], fresh: JevEntry[], cur: CurrentSet[], c: CatalogCounts): MergeResult {
  const out = new Map<string, JevEntry>();
  let newlyRetired = 0;
  for (const e of stored) {
    if (isCurrentEntry(e, cur)) out.set(keyOf(e), { ...e, state: "current" });
    else { if (e.state !== "retired") newlyRetired++; out.set(keyOf(e), { ...e, state: "retired" }); }
  }
  for (const f of fresh) out.set(keyOf(f), f);
  const all = [...out.values()];
  const capDropped = new Set<string>();
  let kept = all;
  if (all.length > MAX_SETS_PER_ROW) {
    const current = all.filter((e) => e.state !== "retired").sort(newestFirst);
    const retired = all.filter((e) => e.state === "retired").sort(newestFirst);
    kept = [...current.slice(0, MAX_SETS_PER_ROW), ...retired.slice(0, Math.max(0, MAX_SETS_PER_ROW - current.length))];
    const keptKeys = new Set(kept.map(keyOf));
    for (const e of all) if (!keptKeys.has(keyOf(e))) capDropped.add(keyOf(e));
    c.capped += capDropped.size;
  }
  return { block: kept.length ? { sets: kept.sort(byKey) } : null, capDropped, newlyRetired };
}

/** FU2 G2 assertion: a posted jev is never null, and holds every stored (set_id, set_sha) except those the cap dropped. */
export function carriesAllStored(stored: JevEntry[], block: Merged | null, capDropped: Set<string>): boolean {
  if (block === null) return stored.length === 0;
  const have = new Set(block.sets.map(keyOf));
  return stored.every((e) => have.has(keyOf(e)) || capDropped.has(keyOf(e)));
}

class StatementTimeoutError extends Error { constructor() { super("statement_timeout"); } }
/** FIX1 X1: no time left before a statement, so it is not started. */
class HardDeadlineError extends Error { constructor() { super("hard_deadline"); } }
/**
 * G3: a Promise race, abandoning the await at `ms` (the timer is cleared on settle). SET LOCAL statement_timeout was the first choice but lib/db is the Neon HTTP driver: each
 * statement is its own HTTP request with no interactive transaction, so a SET LOCAL does not reach the next statement, and the one batch form (sql.transaction([...])) would need
 * store.ts (not editable here) to hand the ingest over as a query object. The race does NOT cancel the statement on the server; it frees this function, and the sweep is unaffected.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new StatementTimeoutError()), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
function scoresOf(pairs: Array<[string, unknown]>): Record<string, number> | null {
  const o: Record<string, number> = {};
  for (const [k, v] of pairs) { const n = num(v); if (n !== null) o[k] = n; }
  return Object.keys(o).length ? o : null;
}

/** clef_affect block for one consult, or null (bad model_rev counts skipped_bad_token; no lane at all gives null). */
export function buildClef(r: ClefPick, c: CatalogCounts): { lanes: Array<{ lane: string; scores: Record<string, number>; model_rev: string; at: string }> } | null {
  if (typeof r.pipeline_version !== "string" || !TOKEN.test(r.pipeline_version)) { c.skipped_bad_token++; return null; }
  const trio = (p: "arousal" | "valence") => scoresOf([
    ["median", r[`${p}_median`]], ["open", r[`${p}_open`]], ["mid", r[`${p}_mid`]], ["close", r[`${p}_close`]],
    ["raw_median", r[`${p}_raw_median`]], ["raw_open", r[`${p}_raw_open`]], ["raw_mid", r[`${p}_raw_mid`]], ["raw_close", r[`${p}_raw_close`]],
  ]);
  const lanes: Array<{ lane: string; scores: Record<string, number> | null }> = [
    { lane: "arousal", scores: trio("arousal") }, { lane: "valence", scores: trio("valence") },
    { lane: "coverage", scores: scoresOf([["n_windows", r.n_windows], ["n_scorable", r.n_scorable], ["scorable_pct", r.scorable_pct]]) },
  ];
  const out = lanes.filter((l): l is { lane: string; scores: Record<string, number> } => l.scores !== null).map((l) => ({ lane: l.lane, scores: l.scores, model_rev: r.pipeline_version, at: r.at }));
  return out.length ? { lanes: out } : null;
}

const same = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** CATALOG_C4_BACKFILL_SINCE: the second scan's lower bound (IST date), or null = OFF. */
export const catalogC4BackfillSince = (nowMs: number = Date.now()): string | null => parseBackfillSince(process.env.CATALOG_C4_BACKFILL_SINCE, nowMs);

/** One tick. Never throws: any failure comes back as `error_class` (a token). An ENABLED tick ends with exactly two console.info lines (tick, ceiling): counts and tokens only. */
export async function runCatalogC4Sync(now: () => number = Date.now, stmtTimeoutMs: number = CATALOG_SYNC_STATEMENT_TIMEOUT_MS): Promise<CatalogCounts> {
  const c = zeroCounts();
  try {
    if (!catalogC4SyncEnabled()) return c;     // off: reads nothing, logs nothing
  } catch (e) {
    if (e instanceof FlagValueError) { c.error_class = "bad_flag"; return c; }
    c.error_class = "step_failed";
    return c;
  }
  const t0 = now();
  const deadline = t0 + CATALOG_SYNC_BUDGET_MS;
  const overBudget = (): boolean => now() > deadline;
  const hardDeadline = t0 + CATALOG_SYNC_HARD_MS;
  // FIX1 X1: every statement gets min(per-statement limit, time left to the hard deadline); none starts with <= 0 left
  const limit = (): number => { const left = hardDeadline - now(); if (left <= 0) throw new HardDeadlineError(); return Math.min(stmtTimeoutMs, left); };
  const scan = { pages: 0, candidates_scanned: 0 };
  try {
    await runStep(c, scan, overBudget, limit, catalogC4BackfillSince());
  } catch (e) {
    c.error_class = e instanceof StatementTimeoutError ? "statement_timeout" : e instanceof ConcurrentIngestError ? "concurrent_insert" : classifyDbError(e);
  }
  console.info(`catalog_c4 tick ${JSON.stringify({ ...c, ms: Math.max(0, now() - t0) })}`);
  console.info(`catalog_c4 ceiling ${JSON.stringify({ pages: scan.pages, candidates_scanned: scan.candidates_scanned, max_pages: MAX_PAGES, page_size: PAGE })}`);
  return c;
}

async function runStep(c: CatalogCounts, scan: { pages: number; candidates_scanned: number }, overBudget: () => boolean, limit: () => number, since: string | null): Promise<void> {
  const rows: CatalogRow[] = [];
  let cur: CurrentSet[] | null = null;
  // One paged scan over `fetchPage`. True = it ended exhausted (a short page or no candidates); false = stopped by budget, BATCH_ROWS or MAX_PAGES.
  const scanRange = async (fetchPage: (cursor: Cursor) => Promise<Candidate[]>): Promise<boolean> => {
    let cursor: Cursor = null;
    while (scan.pages < MAX_PAGES && rows.length < BATCH_ROWS) {
      if (overBudget()) { c.budget_hit = true; return false; }
      const cands: Candidate[] = await fetchPage(cursor);
      scan.pages++; scan.candidates_scanned += cands.length;
      if (cands.length === 0) return true;
      cur ??= await withTimeout(selectCurrentSets(), limit());
      const uids = cands.map((x) => x.consult_uid);
      const lj = limit();
      const [jevPicks, clefPicks] = await Promise.all([withTimeout(selectJevPicks(uids), lj), withTimeout(selectClefPicks(uids), lj)]);
      const byJev = new Map<string, JevPick[]>();
      for (const p of jevPicks) (byJev.get(p.consult_uid) ?? byJev.set(p.consult_uid, []).get(p.consult_uid)!).push(p);
      const byClef = new Map(clefPicks.map((p) => [p.consult_uid, p]));
      for (const cand of cands) {
        if (rows.length >= BATCH_ROWS) break;
        const row: CatalogRow = { consult_uid: cand.consult_uid };
        const stored = storedEntries(cand.stored_jev);
        if (stored === null) c.invariant_dropped++;      // an unreadable stored block is left exactly as it is
        else {
          const m = mergeJev(stored, freshEntries(byJev.get(cand.consult_uid) ?? [], c), cur, c);
          if (!carriesAllStored(stored, m.block, m.capDropped)) c.invariant_dropped++;   // never post a block that loses a stored entry, nor jev: null
          else if (m.block && !same(m.block, cand.stored_jev)) { row.jev = m.block; c.retired += m.newlyRetired; }
        }
        const cp = byClef.get(cand.consult_uid);
        const clef = cp ? buildClef(cp, c) : null;
        if (clef && !same(clef, cand.stored_clef)) row.clef_affect = clef;
        if (Object.keys(row).length === 1) { c.unchanged++; continue; }
        // a row that fails the ingest's own validator is dropped alone (one bad row must not starve the batch) and counted
        if (!validateBatch({ rows: [row] }).ok) { c.error_class = "row_invalid"; continue; }
        rows.push(row);
      }
      const last = cands[cands.length - 1]!;
      cursor = { t0: last.t0, uid: last.consult_uid };
      if (cands.length < PAGE) return true;
    }
    return false;
  };
  try {
    const exhausted = await scanRange((cursor) => withTimeout(selectC4Candidates(WINDOW_DAYS, cursor, PAGE), limit()));
    // BACKFILL-SINCE: a second scan over the older range, only once the live-window scan ended exhausted and nothing capped it; same rows array, page total, budget and deadline
    if (since !== null && exhausted && !c.budget_hit && rows.length < BATCH_ROWS && scan.pages < MAX_PAGES) {
      const before = rows.length;
      try { await scanRange((cursor) => withTimeout(selectC4CandidatesBefore(WINDOW_DAYS, since, cursor, PAGE), limit())); }
      finally { c.backfill_rows = rows.length - before; }
    }
  } catch (e) {
    if (!(e instanceof HardDeadlineError)) throw e;
    c.budget_hit = true;      // rows from earlier pages are kept; the ingest below runs only if time remains
  }
  if (c.capped > 0) console.warn(`catalog-c4-sync: jev entries over ${MAX_SETS_PER_ROW} dropped (retired first, then oldest): ${c.capped}`);
  if (rows.length === 0) return;
  const v = validateBatch({ rows });
  if (!v.ok) { c.error_class = `validate_${v.error}`; return; }
  let lm: number;
  try { lm = limit(); } catch (e) { if (e instanceof HardDeadlineError) { c.budget_hit = true; return; } throw e; }      // no time to start the ingest: post nothing
  const res = await withTimeout(ingestCatalogRows(v.rows, { updateOnly: true }), lm);
  c.posted = v.rows.length; c.updated = res.updated; c.inserted = res.inserted; c.stale = res.stale;
  c.missing = res.missing ?? 0; c.retried = res.retried ? 1 : 0;      // retried is not an error
}
