/**
 * lib/backfill-runs-core.ts — PURE run-state decisions for the backfill experiment runner
 * (Bedrock PRD §4.3, S2, 7 Aug 2026). No db, no Next, no clients.
 *
 * WHAT REPLACED WHAT. The autopilot this supersedes kept its state in `app_settings` strings —
 * enabled/window/cursor/floor/tag/n — and made its decisions inline in the route. That worked while
 * there was exactly one sweep, on one model, forever. A RUN is a different object: it is bounded
 * (a day range), attributed (one model), accounted (tokens, cost), and there may be a history of
 * them. Its decisions are worth stating once, purely, where they can be tested against a table of
 * cases instead of against a cron.
 *
 * THE CONTRACT is PRD §4.3.1–§4.3.9. The pieces that live here are the ones with a decision in
 * them: which run a tick works, where the cursor goes next, when a run is done, and what may be
 * started. Everything requiring a database lives in lib/backfill-runs.ts.
 */

/** 'readmission' (R4-8, CDMSS-READMISSIONS-R4-PRD v1.0, 18 Aug 2026): the readmission-NARRATIVE run
 *  type on these same rails — one run = Opus 4.6 on Bedrock over a range of audited_at (UTC) days,
 *  writing the narrative / ledger / related-LVC artefacts onto audited findings that lack them.
 *  The row, cursor march, accounting, stop-race rule and progress helpers are shared unchanged;
 *  what differs (Bedrock-only, Opus-only, n ≤ 2, the unit is a FINDING not a note) is enforced by
 *  lib/readmission/narrative-backfill.ts on top of planRunCreate. */
/** 'readmission_refresh' (R4.1, CDMSS-READMISSIONS-R4.1-PRD v1.0 R41-4/R41-7, 18 Aug 2026): the
 *  TEMPLATE-REFRESH run — re-analyzes audited findings whose stays now carry final OT / PAC /
 *  progress rows on Opus 4.6 (Bedrock), one case per tick, in place. Same rails; the probe gate,
 *  the exact Opus id and n = 1 are enforced by lib/readmission/refresh.ts. */
export type BackfillWorker = 'opd' | 'ipd' | 'readmission' | 'readmission_refresh';
export const BACKFILL_WORKERS: readonly BackfillWorker[] = ['opd', 'ipd', 'readmission', 'readmission_refresh'] as const;
/** The workers whose runs may name Bedrock ONLY (R4-11 / R41-4). */
export const BEDROCK_ONLY_WORKERS: readonly BackfillWorker[] = ['readmission', 'readmission_refresh'] as const;
export type RunStatus = 'active' | 'paused' | 'done' | 'stopped' | 'error';

/** One row of `backfill_runs`, as the runner reads it. Mirrors the PRD's DDL. */
export interface BackfillRun {
  id: number;
  worker: BackfillWorker;
  /** The full `bedrock:<modelId>` or `vertex:<modelId>` string, as requested. Attribution lives
   *  here, not in the label. */
  model: string;
  /** Oldest day, inclusive. The run is done when the cursor passes BELOW this. */
  day_from: string;
  /** Newest day, inclusive. The cursor STARTS here and marches backwards. */
  day_to: string;
  cursor: string | null;
  n_per_tick: number;
  status: RunStatus;
  source: 'admin' | 'mcp';
  notes_done: number;
  notes_failed: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  last_error: string | null;
  /** ISO-8601 UTC of the last write to this row — every tick touches it (cursor, counters, status).
   *  It is therefore the run's HEARTBEAT, and the only field the stall check reads (S2b C3).
   *  Optional so a fixture or an older reader that never selected it still type-checks. */
  updated_at?: string | null;
}

// ── day arithmetic ──────────────────────────────────────────────────────────────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(s: unknown): s is string {
  const v = String(s ?? '');
  if (!DAY_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}

/** The previous calendar day. UTC arithmetic on a date-only string — no timezone drift. */
export function prevDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Calendar days from `from` to `to`, both ends INCLUSIVE. 0 when `to` is before `from`. */
export function daysInclusive(from: string, to: string): number {
  if (!isDay(from) || !isDay(to) || to < from) return 0;
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

// ── run creation ────────────────────────────────────────────────────────────────────────────────

/** ⚠️ 1..8 (PRD §4.3), default 4. Junk degrades to the default, never to 0 — a run that quietly
 *  processes no notes per tick looks identical to a stuck one. */
export function clampNPerTick(n: unknown): number {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v) || v < 1) return 4;
  return Math.min(8, v);
}

export interface RunCreateInput {
  worker?: unknown;
  model?: unknown;
  dayFrom?: unknown;
  dayTo?: unknown;
  nPerTick?: unknown;
  source?: unknown;
}

export type RunCreatePlan =
  | { ok: true; worker: BackfillWorker; model: string; dayFrom: string; dayTo: string; nPerTick: number; source: 'admin' | 'mcp'; cursor: string }
  | { ok: false; error: string };

/**
 * The provider prefixes a RUN may name (S2b C2, 8 Aug 2026 — was `bedrock:` alone).
 *
 * ⚠️ WHY VERTEX JOINED, AND WHY THE LIST IS STILL A LIST. The bake-off (BAKEOFF-DESIGN §6 gap 2)
 * grades one cohort four ways: three Bedrock arms and the PRODUCTION grader. The Gemini arm had no
 * driver — 150 one-at-a-time golden A/B calls have no run row, no counters, no cost, and no progress
 * surface, which the standing monitoring rule (§7) forbids. Letting the runner take `vertex:` makes
 * that arm an ordinary fill run and nothing else changes: same fill-only rule, same prod-line label,
 * same per-run accounting.
 *
 * `ollama:` and `openrouter:` remain refused. Qwen is retired from backfill (PRD decision 2), and an
 * OpenRouter backfill would write prod-line rows through the backup tier while the production ladder
 * calls Vertex first — an attribution muddle with no experiment behind it.
 */
export const RUN_MODEL_PREFIXES = ['bedrock:', 'vertex:'] as const;

/**
 * Validate a run request. ERRORS LOUD, NEVER NORMALISES A MISTAKE AWAY.
 *
 * ⚠️ `bedrock:` OR `vertex:` (see RUN_MODEL_PREFIXES). This is checked here rather than at the call
 * site so the reason travels with the refusal: a run is an EXPERIMENT, and an experiment whose model
 * was silently substituted is worthless. Reachability is a separate, impure check the caller makes
 * before insert — a resolvable model that cannot be reached must not become an active run.
 *
 * THE CURSOR STARTS AT day_to and marches BACKWARDS (§4.3.2), so a run always begins with the most
 * recent day in its range — the days most likely to matter if the run is stopped early.
 */
export function planRunCreate(i: RunCreateInput): RunCreatePlan {
  const worker = String(i.worker ?? 'opd').trim().toLowerCase();
  if (!(BACKFILL_WORKERS as readonly string[]).includes(worker)) return { ok: false, error: `unknown worker '${worker}' — expected ${BACKFILL_WORKERS.map((w) => `'${w}'`).join(' or ')}` };

  const model = String(i.model ?? '').trim();
  if (!model) return { ok: false, error: 'model is required — a run must name the model it attributes its rows to' };
  const prefix = RUN_MODEL_PREFIXES.find((p) => model.toLowerCase().startsWith(p));
  if (!prefix) {
    return { ok: false, error: `run model '${model}' names no accepted provider — backfill runs accept ${RUN_MODEL_PREFIXES.map((p) => `'${p}<modelId>'`).join(' or ')} only (qwen is retired from backfill; ollama/openrouter runs are out of scope). Never falls back.` };
  }
  // R4-8 / R4-11: the readmission-narrative run type is TYPED TO BEDROCK — a vertex run here would
  // write a narrative stamped with a model the ruling excludes. The exact Opus id is enforced by
  // the readmission tick module (this core stays free of that constant).
  if ((BEDROCK_ONLY_WORKERS as readonly string[]).includes(worker) && prefix !== 'bedrock:') {
    return { ok: false, error: `worker '${worker}' accepts 'bedrock:<modelId>' only (R4-11 / R41-4: Opus 4.6 on Bedrock, everywhere it is written) — '${model}' refused, never substituted` };
  }
  if (!model.slice(prefix.length).trim()) return { ok: false, error: `model id missing after '${prefix}'` };

  const dayFrom = String(i.dayFrom ?? '').trim();
  const dayTo = String(i.dayTo ?? '').trim();
  if (!isDay(dayFrom)) return { ok: false, error: `dayFrom '${dayFrom}' is not a YYYY-MM-DD calendar day` };
  if (!isDay(dayTo)) return { ok: false, error: `dayTo '${dayTo}' is not a YYYY-MM-DD calendar day` };
  if (dayFrom > dayTo) return { ok: false, error: `dayFrom ${dayFrom} is after dayTo ${dayTo} — the range marches backwards from dayTo to dayFrom` };

  const source = String(i.source ?? 'admin').trim().toLowerCase() === 'mcp' ? 'mcp' : 'admin';
  return { ok: true, worker: worker as BackfillWorker, model, dayFrom, dayTo, nPerTick: clampNPerTick(i.nPerTick), source, cursor: dayTo };
}

/**
 * §4.3.1 — ONE ACTIVE RUN PER WORKER. Starting while one is active is a typed error, never a
 * queue-jump: serial runs are what keep attribution and the console graph readable, and two runs
 * writing prod-line rows over overlapping days would make "which model graded this day" unanswerable
 * from the run table.
 */
export function canStartRun(active: Pick<BackfillRun, 'id' | 'model' | 'status'> | null | undefined): { ok: true } | { ok: false; error: string } {
  if (!active) return { ok: true };
  return {
    ok: false,
    error: `a run is already ${active.status} for this worker (run ${active.id}, model ${active.model}) — stop or pause it first. Runs are serial by design; this is not a queue.`,
  };
}

// ── the tick ────────────────────────────────────────────────────────────────────────────────────

export type TickPlan =
  /** No run to work. The tick logs and exits — NOT an error: an idle worker is the normal state. */
  | { action: 'idle'; reason: string }
  /** The run exists but must not be worked now. */
  | { action: 'skip'; reason: string; status: RunStatus }
  /** Work `day` with `n` notes. */
  | { action: 'work'; day: string; n: number };

/**
 * What should this tick do? Decided from the run row alone.
 *
 * A run with a null cursor is seeded at `day_to` rather than treated as broken — the insert sets it,
 * but a row that lost it (a manual edit, a partial migration) resumes at the top of its range
 * instead of stalling forever.
 */
export function planTick(run: BackfillRun | null | undefined): TickPlan {
  if (!run) return { action: 'idle', reason: 'no active run for this worker' };
  if (run.status !== 'active') return { action: 'skip', reason: `run ${run.id} is ${run.status}`, status: run.status };
  const day = isDay(run.cursor) ? (run.cursor as string) : run.day_to;
  if (day < run.day_from) return { action: 'skip', reason: `cursor ${day} passed day_from ${run.day_from}`, status: 'done' };
  return { action: 'work', day, n: clampNPerTick(run.n_per_tick) };
}

export interface TickOutcome {
  /** Notes actually graded and stored this tick. */
  processed: number;
  /** Notes attempted that threw. They advance `notes_failed`, never stop the run (§4.3). */
  failed: number;
  /** True when the day has no further un-audited notes — the cursor may march. */
  dayComplete: boolean;
}

export type TickAdvance = {
  /** Where the cursor goes. Unchanged when the day still has work. */
  cursor: string;
  /** The run's status after this tick. */
  status: RunStatus;
  /** True when this tick finished the run. */
  finished: boolean;
};

/**
 * §4.3.2 — the cursor march. The run is `done` when the cursor passes BELOW `day_from`.
 *
 * ⚠️ THE CURSOR ONLY MOVES ON A COMPLETE DAY. A tick that graded some-but-not-all of a day leaves
 * the cursor where it is, so the next tick finishes it. Marching on a partial day would silently
 * skip the remainder — the note is never revisited, because the cursor never comes back.
 */
export function advanceAfterTick(run: BackfillRun, day: string, outcome: TickOutcome): TickAdvance {
  if (!outcome.dayComplete) return { cursor: day, status: 'active', finished: false };
  const next = prevDay(day);
  if (next < run.day_from) return { cursor: next, status: 'done', finished: true };
  return { cursor: next, status: 'active', finished: false };
}

/**
 * Per-run accounting deltas (§4.3.7). Pure so the arithmetic is testable and so a NaN from a
 * missing usage row can never poison a running total: every input degrades to 0.
 */
export function accumulate(
  run: Pick<BackfillRun, 'notes_done' | 'notes_failed' | 'tokens_in' | 'tokens_out' | 'cost_usd'>,
  d: { processed?: number; failed?: number; tokensIn?: number; tokensOut?: number; costUsd?: number },
): Pick<BackfillRun, 'notes_done' | 'notes_failed' | 'tokens_in' | 'tokens_out' | 'cost_usd'> {
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    notes_done: n(run.notes_done) + Math.max(0, n(d.processed)),
    notes_failed: n(run.notes_failed) + Math.max(0, n(d.failed)),
    tokens_in: n(run.tokens_in) + Math.max(0, n(d.tokensIn)),
    tokens_out: n(run.tokens_out) + Math.max(0, n(d.tokensOut)),
    cost_usd: n(run.cost_usd) + Math.max(0, n(d.costUsd)),
  };
}

/**
 * §4.3 — WHICH FAILURES STOP A RUN.
 *
 * A NOTE that fails is data: one note, counted, recorded in `last_error`, and the run continues.
 * Half the point of a bounded sweep is that a bad note does not cost the other 400.
 *
 * A TICK that fails is infrastructure — the provider is unreachable, the budget is exhausted, the
 * model was withdrawn. Every note in this run would fail the same way, so the run goes to `error`:
 * loud, visible on the console, and resumable once the cause is fixed. Continuing would burn the
 * whole range against a broken provider and fill `notes_failed` with the same message.
 */
export function statusAfterTickFailure(): RunStatus { return 'error'; }

/**
 * §C4 — THE STOP RACE (found in live verification 8 Aug 2026, ratified by V the same day).
 *
 * WHAT HAPPENED. Run 1 was stopped while a tick was in flight. The tick had read the run as `active`
 * before the stop landed, and its end-of-tick write set cursor AND status together — so `status =
 * 'active'` was written back over `'stopped'` and the run resumed on the next cron fire. The operator
 * pressed stop, the console showed stopped, and the run kept spending.
 *
 * THE RULE. A TICK MAY ONLY EVER MOVE A RUN THAT IS STILL ACTIVE. An operator action (stop, pause)
 * is a statement about the future and the tick's status decision was computed from a past that no
 * longer holds; between a stale intention and a fresh instruction, the instruction wins. This applies
 * to EVERY status write a tick makes — the cursor advance, the day/run completion, and the error
 * paths — because each of them is the same stale write.
 *
 * ⚠️ WHAT IS *NOT* CONDITIONAL: the work that actually happened. Progress counters, tokens, cost, the
 * cursor and `last_error` are recorded regardless. Those notes WERE graded and stored; a run that
 * dropped them on being stopped would under-report real spend and could re-grade the same day on
 * resume. Accounting records the past, status records the intent, and only the second is contested.
 *
 * Enforced twice, as one fact in two places: here for the decision, and in the SQL itself
 * (lib/backfill-runs.ts — a CASE guarded on `status = 'active'`), because between this function and
 * that statement lies a network round-trip in which the operator can act again.
 */
export function statusAfterTickWrite(current: RunStatus, planned: RunStatus): RunStatus {
  return current === 'active' ? planned : current;
}

// ── §C3: pace, ETA and the stall alarm (BAKEOFF-DESIGN §6 gaps 4 + 5) ───────────────────────────

/**
 * A run with no progress for this long is FLAGGED (not touched). 300 s, settled by V on 8 Aug.
 *
 * Sized against the thing being watched: a tick grades up to 8 notes and one Bedrock note measured
 * ~45 s (§C2.3), so a healthy tick lands well inside 300 s at the operational n≤4, and the cron fires
 * every 2 minutes. A run silent for five minutes is not slow, it is wedged — which until now looked
 * exactly like a slow one, the whole reason gap 5 was written.
 */
export const STALL_AFTER_MS = 300_000;

/**
 * Is this worker wedged? PURE, and deliberately shaped for BOTH consumers — the run (heartbeat =
 * `updated_at`) and the lab batch (heartbeat = its last tick summary) — so one threshold and one
 * rule cover the bake-off's Gemini arm and its three Bedrock arms alike.
 *
 * ⚠️ TWO WAYS TO BE NOT-STALLED, AND THEY ARE DIFFERENT. `active: false` (paused, stopped, done, or a
 * batch outside its night window) is DELIBERATE idleness and can never be a stall. A null heartbeat
 * is UNKNOWN idleness — a run that has never ticked — and also returns false: an alarm that fires on
 * every freshly created run is an alarm operators learn to ignore, and the gap this closes is a
 * WEDGED run, which by definition has ticked at least once.
 */
export function isStalled(
  input: { active: boolean; lastProgressMs: number | null },
  nowMs: number,
  thresholdMs: number = STALL_AFTER_MS,
): boolean {
  if (!input.active) return false;
  const last = Number(input.lastProgressMs);
  if (!Number.isFinite(last) || last <= 0) return false;
  return nowMs - last > thresholdMs;
}

/** One tick as the monitor reads it back from `mini_backfill_ticks`. */
export interface TickRow { run_id: number | null; processed: number; avg_ms: number | null }

export interface RunPace {
  /** Notes-weighted mean ms per note over the sampled ticks. Null until a tick has graded one. */
  avgMsPerNote: number | null;
  /** Notes the mean is computed over — the honesty field: a pace from 1 note is not a pace. */
  notes: number;
  ticks: number;
}

/**
 * Rolling pace for one run, from ticks the monitor ALREADY fetches (`getTicks`) — no new query, and
 * no new column: `avg_ms` and `processed` have been logged per tick since the autopilot.
 *
 * WEIGHTED BY NOTES, not by tick. A tick that graded one slow note and a tick that graded eight fast
 * ones are not two equal samples of "ms per note", and averaging their averages would let the small
 * tick swing the ETA. Ticks that graded nothing (idle, locked, skipped, errored) contribute nothing
 * rather than a zero — a paused hour must not read as infinite speed.
 */
export function rollingPace(ticks: readonly TickRow[], runId: number, maxTicks = 10): RunPace {
  const mine = (ticks ?? []).filter(
    (t) => Number(t?.run_id) === runId && Number(t?.processed) > 0 && Number(t?.avg_ms) > 0,
  );
  const sample = mine.slice(-Math.max(1, maxTicks));
  let notes = 0, msTotal = 0;
  for (const t of sample) {
    const n = Number(t.processed), ms = Number(t.avg_ms);
    notes += n; msTotal += n * ms;
  }
  return { avgMsPerNote: notes > 0 ? Math.round(msTotal / notes) : null, notes, ticks: sample.length };
}

/** Seconds to grade `remaining` notes at `avgMsPerNote`. Null when either input is unknown. */
export function etaSeconds(remaining: number | null | undefined, avgMsPerNote: number | null | undefined): number | null {
  const n = Number(remaining), ms = Number(avgMsPerNote);
  if (!Number.isFinite(n) || n < 0 || !Number.isFinite(ms) || ms <= 0) return null;
  return Math.round((n * ms) / 1000);
}

export interface RunEta {
  seconds: number | null;
  /** Estimated notes left in the whole range — see the basis field before quoting it. */
  notesRemaining: number | null;
  notesPerDay: number | null;
  daysRemaining: number;
  avgMsPerNote: number | null;
  /** WHY the number is what it is, in one token. Read this before the number. */
  basis: 'estimated_from_completed_days' | 'no_completed_day_yet' | 'no_pace_yet' | 'not_active';
}

/**
 * ETA for a run (gap 4). ⚠️ READ THE BASIS — THE DENOMINATOR IS AN ESTIMATE, NOT A COUNT.
 *
 * A run knows how many DAYS it has left (cursor → day_from) but not how many NOTES: the note count
 * for an un-reached day lives in db13, and asking Metabase for every remaining day on every monitor
 * poll would put an external round-trip on a 15-second refresh. So notes-per-day is inferred from the
 * days this run has already finished, and the estimate is only offered once at least one day has
 * completed. Before that: `no_completed_day_yet` and a null ETA, never a guess dressed as a number.
 *
 * It is deliberately PESSIMISTIC in one place: the current day counts as whole, though part of it is
 * already graded. Overstating time-to-finish is the safe direction for an operator deciding whether
 * to wait.
 */
export function estimateRunEta(run: BackfillRun, pace: RunPace): RunEta {
  const cursor = isDay(run.cursor) ? (run.cursor as string) : run.day_to;
  const daysLeft = daysInclusive(run.day_from, cursor);
  const base = { seconds: null, notesRemaining: null, notesPerDay: null, daysRemaining: daysLeft, avgMsPerNote: pace.avgMsPerNote };
  if (run.status !== 'active') return { ...base, basis: 'not_active' };
  if (pace.avgMsPerNote == null) return { ...base, basis: 'no_pace_yet' };
  // Days the cursor has fully passed: day_to down to the day AFTER the cursor.
  const daysDone = daysInclusive(cursor, run.day_to) - 1;
  if (daysDone < 1 || run.notes_done < 1) return { ...base, basis: 'no_completed_day_yet' };
  const notesPerDay = run.notes_done / daysDone;
  const notesRemaining = Math.round(notesPerDay * daysLeft);
  return {
    seconds: etaSeconds(notesRemaining, pace.avgMsPerNote),
    notesRemaining,
    notesPerDay: Math.round(notesPerDay * 10) / 10,
    daysRemaining: daysLeft,
    avgMsPerNote: pace.avgMsPerNote,
    basis: 'estimated_from_completed_days',
  };
}

/** A run's terminal states — nothing further will be worked without an operator action. */
export const TERMINAL_STATUSES: readonly RunStatus[] = ['done', 'stopped'] as const;

export function isTerminal(status: RunStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Which status transitions an operator may request. `error` is resumable BY DESIGN — the run is
 * paused at the point of failure, not discarded, so fixing the provider and pressing resume picks
 * up at the same cursor with the counters intact.
 */
export function planStatusChange(current: RunStatus, action: 'pause' | 'resume' | 'stop'): { ok: true; status: RunStatus } | { ok: false; error: string } {
  if (action === 'stop') {
    if (isTerminal(current)) return { ok: false, error: `run is already ${current}` };
    return { ok: true, status: 'stopped' };
  }
  if (action === 'pause') {
    if (current !== 'active') return { ok: false, error: `only an active run can be paused (this one is ${current})` };
    return { ok: true, status: 'paused' };
  }
  // resume
  if (current === 'paused' || current === 'error') return { ok: true, status: 'active' };
  return { ok: false, error: `only a paused or errored run can be resumed (this one is ${current})` };
}
