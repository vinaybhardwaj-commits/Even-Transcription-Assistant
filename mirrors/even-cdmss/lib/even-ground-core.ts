/**
 * lib/even-ground-core.ts — PURE core for the Even LVC grounding worker (Phase 2,
 * CDMSS-EVEN-LVC-GROUNDING-WORKER-PRD-v1.0). No db / Next / LLM imports — strip-types testable.
 *
 * Owns: the finding-embedding cache key, the epoch staleness compare, the retire display-filter
 * (stripRetiredEvenCitations), the batch/status reducers, and the status-shape builder. Every
 * grounding write stays ADDITIVE + score-invariant — that contract lives in normative-grounding-core
 * (attachNormativeCitations), unchanged. Nothing here reads or writes a verdict/score/band/lvc_category.
 */
import { createHash } from 'crypto';
import { normalizeSubject } from './even-lvc-core';
import { EVEN_SOURCE } from './normative-grounding-core';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── finding-embedding cache key (PRD §3, §5.5) ──────────────────────────────────
/** Stable key for a finding's embedding: sha256(uid ':' finding_ref-or-index ':' normalized_subject).
 *  Deterministic + pure. finding_ref (if the finding carries one) else its array index makes it stable
 *  across sweeps even for notes whose findings were never identity-stamped. */
export function findingKey(uid: string, refOrIndex: string | number, subject: string | null | undefined): string {
  return sha256(`${uid}:${String(refOrIndex)}:${normalizeSubject(subject)}`);
}
/** The cache row's subject_hash — subject-sensitive so a re-worded finding misses the cache (re-embeds). */
export function subjectHash(subject: string | null | undefined): string {
  return sha256(normalizeSubject(subject));
}

// ── epoch staleness (PRD §3, §4) ────────────────────────────────────────────────
/** A note is stale (needs (re)grounding) iff it has no watermark OR its watermark epoch < the current
 *  epoch. Pure mirror of the candidate-select predicate `s.uid IS NULL OR s.grounded_epoch < $epoch`. */
export function isNoteStale(groundedEpoch: number | null | undefined, currentEpoch: number): boolean {
  if (groundedEpoch == null) return true;
  return groundedEpoch < currentEpoch;
}

// ── retire = display-time filter (PRD §6) ───────────────────────────────────────
// Structural minimums (NO index signature) so the real OpdFinding / Source interfaces satisfy them and
// the helper returns those exact types unchanged.
export interface CitedFinding { citation_ids?: number[] }
export interface CitedSource { n: number; source?: string | null; item_number?: string | null }

/**
 * Remove, FOR DISPLAY ONLY, every `even-lvc` citation whose assertion id (item_number) is retired:
 * drop those sources, renumber the survivors 1..k, and remap each finding's citation_ids to the new
 * numbering (an id that pointed at a removed source is dropped). CW / guideline / corpus / any other
 * citation is left fully intact — the filter keys on the RESOLVED source identity (source==='even-lvc'
 * AND item_number ∈ retired), never on a raw index. Pure; never mutates its inputs.
 *
 * BYTE-IDENTICAL short-circuit: if no retired ids are given, or no present source is a retired even-lvc
 * one, the ORIGINAL findings + sources are returned unchanged (no gratuitous renumbering). This keeps
 * every non-retire render path exactly as it is today.
 */
export function stripRetiredEvenCitations<
  F extends { citation_ids?: number[] },
  S extends { n: number; source?: string | null; item_number?: string | null },
>(
  findings: F[],
  sources: S[],
  retiredEvenIds: string[] | null | undefined,
): { findings: F[]; sources: S[] } {
  const retired = new Set((retiredEvenIds ?? []).map((s) => String(s).trim()).filter(Boolean));
  if (!retired.size) return { findings, sources };
  const isRetired = (s: S): boolean =>
    String(s.source ?? '').trim() === EVEN_SOURCE && s.item_number != null && retired.has(String(s.item_number).trim());
  if (!sources.some(isRetired)) return { findings, sources };

  const oldNToNew = new Map<number, number>();
  const keptSources: S[] = [];
  for (const s of sources) {
    if (isRetired(s)) continue;
    const newN = keptSources.length + 1;
    oldNToNew.set(s.n, newN);
    keptSources.push({ ...s, n: newN } as S);
  }
  const outFindings = findings.map((f) => {
    if (!Array.isArray(f.citation_ids) || !f.citation_ids.length) return f;
    const ids = f.citation_ids.map((id) => oldNToNew.get(id)).filter((x): x is number => x != null);
    return { ...f, citation_ids: ids } as F;
  });
  return { findings: outFindings, sources: keptSources };
}

// ── batch / status reducers (PRD §7) ────────────────────────────────────────────
export type GroundState = 'draining' | 'idle' | 'paused' | 'disabled';

/** Fully-drained iff every low-value note is grounded at the current epoch. `state`:
 *  disabled (env hard-off) > paused (soft) > draining (grounded_at_epoch < total) > idle. Pure. */
export function deriveGroundState(input: { enabled: boolean; paused: boolean; groundedAtEpoch: number | null; totalLvNotes: number | null }): GroundState {
  if (!input.enabled) return 'disabled';
  if (input.paused) return 'paused';
  const grounded = input.groundedAtEpoch ?? 0;
  const total = input.totalLvNotes ?? 0;
  return total > 0 && grounded < total ? 'draining' : 'idle';
}

/** Drain % at the current epoch (0..100), or null when the total is unknown/zero. Pure. */
export function drainPct(groundedAtEpoch: number | null, totalLvNotes: number | null): number | null {
  if (!totalLvNotes || totalLvNotes <= 0) return null;
  const g = groundedAtEpoch ?? 0;
  return Math.max(0, Math.min(100, Math.round((g / totalLvNotes) * 100)));
}

export interface TickRow { ts: string; status: string; processed: number; citations_added: number; epoch: number | null; note: string | null }

export interface GroundStatusRaw {
  enabled: boolean;
  paused: boolean;
  epoch: number;
  activeAssertions: number | null;
  totalLvNotes: number | null;
  groundedAtEpoch: number | null;
  citationsAddedTotal: number | null;
  lastTick: TickRow | null;
  recentTicks: TickRow[];
}
export interface GroundStatus {
  state: GroundState;
  epoch: number;
  paused: boolean;
  active_assertions: number | null;
  total_lv_notes: number | null;
  grounded_at_epoch: number | null;
  citations_added_total: number | null;
  last_tick: TickRow | null;
  recent_ticks: TickRow[];
  drain_pct: number | null;
}

/** Shape the status endpoint payload from raw aggregates. Pure — every field passes through or is
 *  derived; the impure loader soft-fails each aggregate to null before calling this. */
export function buildGroundStatus(raw: GroundStatusRaw): GroundStatus {
  return {
    state: deriveGroundState(raw),
    epoch: raw.epoch,
    paused: raw.paused,
    active_assertions: raw.activeAssertions,
    total_lv_notes: raw.totalLvNotes,
    grounded_at_epoch: raw.groundedAtEpoch,
    citations_added_total: raw.citationsAddedTotal,
    last_tick: raw.lastTick,
    recent_ticks: raw.recentTicks,
    drain_pct: drainPct(raw.groundedAtEpoch, raw.totalLvNotes),
  };
}

/** ETA (minutes) to drain the remaining notes at the observed citations/tick rate is not meaningful
 *  (a tick grounds up to BATCH notes regardless of citations). ETA uses NOTES-per-tick instead:
 *  remaining / notesPerTick × cadenceMin. Null when rate is unknown/zero. Pure. */
export function drainEtaMinutes(remainingNotes: number | null, notesPerTick: number | null, cadenceMin: number): number | null {
  if (!remainingNotes || remainingNotes <= 0) return 0;
  if (!notesPerTick || notesPerTick <= 0) return null;
  return Math.ceil(remainingNotes / notesPerTick) * cadenceMin;
}

// ── live-heartbeat time helpers (PRD Phase 2.2 — pure, client-clock driven) ───────
/** Compact "time since" label for a tick timestamp, driven by a client clock (updated every 1s so it
 *  visibly moves between polls). The status endpoint emits `to_char(ts,'YYYY-MM-DD"T"HH24:MI:SS')` with
 *  NO timezone — Postgres/Neon store UTC, so a bare ISO is treated as UTC (a 'Z' is appended when absent).
 *  Future/负 deltas clamp to 0s. A malformed/absent timestamp ⇒ '—'. Pure. */
export function formatAgo(tsISO: string | null | undefined, nowMs: number): string {
  const raw = String(tsISO ?? '').trim();
  if (!raw) return '—';
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`;   // assume UTC when no tz present
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Seconds until the next wall-clock cron boundary (default every 10 min, UTC — Vercel cron runs UTC,
 *  and the epoch aligns to 10-min boundaries). Result is in (0, everyMin*60]: exactly ON a boundary
 *  returns a full period (it just fired). An estimate — the panel labels it "~". Pure. */
export function nextTickInSec(nowMs: number, everyMin = 10): number {
  const period = Math.max(1, Math.round(everyMin)) * 60 * 1000;
  const rem = ((nowMs % period) + period) % period;
  const untilMs = rem === 0 ? period : period - rem;
  return Math.ceil(untilMs / 1000);
}
