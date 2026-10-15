/**
 * lib/jev/worker/catalog-sync.ts — CATALOG-C4-SYNC: copy Jev answers (`jev`) and Clef affect (`clef_affect`) onto existing encounter_catalog rows.
 *
 * IN-PROCESS, a step at the end of the jev-sweep cron. It writes ONLY through validateBatch and ingestCatalogRows (the ingest route's own validator and SQL); it never
 * writes SQL against encounter_catalog. SHIPS DARK: CATALOG_C4_SYNC_ENABLED unset/0 reads NOTHING; an unrecognised value is read as off and counted (`bad_flag`).
 * A row is {consult_uid, jev?, clef_affect?} and nothing else: no generated_at (it belongs to the box feed's stale-write guard), no ist_date. Only consults that already have a
 * catalog row are candidates (the select's inner join), so `inserted` must be 0. Idempotent: a block deep-equal (canonical JSON) to the stored column is not posted.
 * Counts and one class token leave this module; no id, value or error text is logged or returned.
 */
import { FlagValueError } from "@/lib/flags";
import { ConcurrentIngestError, ingestCatalogRows, validateBatch, type CatalogRow } from "@/lib/encounter-catalog/store";
import { QUESTION_SET_FILES } from "@/jev/question-sets";
import { selectC4Candidates, selectClefPicks, selectJevPicks, type ClefPick, type Cursor, type JevPick } from "@/lib/room-access/catalog-c4-select";
import { canonicalJson } from "./canonical";
import { classifyDbError } from "./errors";
import { catalogC4SyncEnabled } from "./flags";
import { validateSetFile, type QuestionSetFile } from "./sets";

/** A noul answer at or above this reads "yes" (the label is a closed enum, never a model string). */
export const NOUL_YES_THRESHOLD = 0.5;
export const BATCH_ROWS = 500;          // store MAX_ROWS
export const MAX_SETS_PER_ROW = 50;     // store MAX_SETS
export const WINDOW_DAYS = 8;
/** CS-2: wall-clock budget for one tick, measured from the step's start; checked before each page select and before the ingest. */
export const CATALOG_SYNC_BUDGET_MS = 20_000;
const PAGE = 500;
const MAX_PAGES = 10;
/** Same shape as store.ts TOKEN (INFERRED: store.ts does not export it, and this slice may not edit it). The final gate is validateBatch either way. */
const TOKEN = /^[A-Za-z0-9_:.-]{1,60}$/;
const BANDS = new Set(["act", "caution", "review", "abstain"]);

export type CatalogCounts = {
  posted: number; updated: number; inserted: number; stale: number; unchanged: number;
  skipped_off_enum: number; skipped_bad_token: number; budget_hit: boolean; capped: number; error_class: string | null;
};
export const zeroCounts = (): CatalogCounts => ({ posted: 0, updated: 0, inserted: 0, stale: 0, unchanged: 0, skipped_off_enum: 0, skipped_bad_token: 0, budget_hit: false, capped: 0, error_class: null });

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

type JevEntry = { set_id: string; set_sha: string; band: string | null; label: string | null; model: string; at: string };

/** The closed label for one answer, or null (off-enum). */
export function labelOf(def: QDef | undefined, answer: unknown): string | null {
  const a = answer as { type?: unknown; choice?: unknown; noul?: unknown; score?: unknown } | null;
  if (!def || !a || typeof a !== "object" || a.type !== def.kind) return null;
  if (def.kind === "choice") return typeof a.choice === "string" && def.options?.has(a.choice) && TOKEN.test(a.choice) ? a.choice : null;
  if (def.kind === "noul") return typeof a.noul === "number" && Number.isFinite(a.noul) ? (a.noul >= NOUL_YES_THRESHOLD ? "yes" : "no") : null;
  return typeof a.score === "number" && Number.isInteger(a.score) && a.score >= 0 && a.score <= def.levels - 1 ? `score_${a.score}` : null;
}

/** jev block for one consult from its picks, or null when nothing survives. */
export function buildJev(picks: JevPick[], c: CatalogCounts): { sets: JevEntry[] } | null {
  const entries: JevEntry[] = [];
  for (const p of picks) {
    const setId = `${p.set_id}:${p.question_id}`;
    if (!TOKEN.test(setId) || !TOKEN.test(p.model)) { c.skipped_bad_token++; continue; }
    const label = labelOf(setDefs().get(`${p.set_id}@${p.set_version}:${p.question_id}`), p.answer);
    if (label === null) c.skipped_off_enum++;
    let band: string | null = null;
    if (p.band !== null && p.band !== undefined) { if (BANDS.has(p.band)) band = p.band; else c.skipped_off_enum++; }
    entries.push({ set_id: setId, set_sha: p.set_sha, band, label, model: p.model, at: p.at });
  }
  if (entries.length === 0) return null;
  // keep the NEWEST 50 (the drop count goes to c.capped), then a stable order by set_id for the unchanged test
  const kept = entries.length > MAX_SETS_PER_ROW ? [...entries].sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0)).slice(0, MAX_SETS_PER_ROW) : entries;
  c.capped += entries.length - kept.length;
  return { sets: kept.sort((x, y) => (x.set_id < y.set_id ? -1 : x.set_id > y.set_id ? 1 : 0)) };
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

/** One tick. Never throws: any failure comes back as `error_class` (a token). */
export async function runCatalogC4Sync(now: () => number = Date.now): Promise<CatalogCounts> {
  const c = zeroCounts();
  try {
    if (!catalogC4SyncEnabled()) return c;     // off: reads nothing
  } catch (e) {
    if (e instanceof FlagValueError) { c.error_class = "bad_flag"; return c; }
    c.error_class = "step_failed";
    return c;
  }
  const deadline = now() + CATALOG_SYNC_BUDGET_MS;
  const overBudget = (): boolean => now() > deadline;
  try {
    const rows: CatalogRow[] = [];
    let cursor: Cursor = null;
    for (let page = 0; page < MAX_PAGES && rows.length < BATCH_ROWS; page++) {
      if (overBudget()) { c.budget_hit = true; break; }
      const cands = await selectC4Candidates(WINDOW_DAYS, cursor, PAGE);
      if (cands.length === 0) break;
      const uids = cands.map((x) => x.consult_uid);
      const [jevPicks, clefPicks] = await Promise.all([selectJevPicks(uids), selectClefPicks(uids)]);
      const byJev = new Map<string, JevPick[]>();
      for (const p of jevPicks) (byJev.get(p.consult_uid) ?? byJev.set(p.consult_uid, []).get(p.consult_uid)!).push(p);
      const byClef = new Map(clefPicks.map((p) => [p.consult_uid, p]));
      for (const cand of cands) {
        if (rows.length >= BATCH_ROWS) break;
        const row: CatalogRow = { consult_uid: cand.consult_uid };
        const jev = buildJev(byJev.get(cand.consult_uid) ?? [], c);
        if (jev && !same(jev, cand.stored_jev)) row.jev = jev;
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
      if (cands.length < PAGE) break;
    }
    if (c.capped > 0) console.warn(`catalog-c4-sync: jev entries over ${MAX_SETS_PER_ROW} dropped (oldest first): ${c.capped}`);
    if (rows.length === 0) return c;
    if (overBudget()) { c.budget_hit = true; return c; }   // past the deadline before the ingest: post nothing (the next tick redoes the work)
    const v = validateBatch({ rows });
    if (!v.ok) { c.error_class = `validate_${v.error}`; return c; }
    const res = await ingestCatalogRows(v.rows);
    c.posted = v.rows.length; c.updated = res.updated; c.inserted = res.inserted; c.stale = res.stale;
    if (res.inserted > 0) { c.error_class = "unexpected_insert"; console.error(`catalog-c4-sync: unexpected_insert count=${res.inserted}`); }
  } catch (e) {
    c.error_class = e instanceof ConcurrentIngestError ? "concurrent_insert" : classifyDbError(e);
  }
  return c;
}
