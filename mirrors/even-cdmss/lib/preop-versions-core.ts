/**
 * lib/preop-versions-core.ts — PURE logic for the pre-op snapshot versions rail
 * (PRD v1.1-LOCKED §5: "the readmissions R8.1 pattern verbatim"; Build Plan B1).
 *
 * NO database, NO fetch, NO clock. The capture-reason set, the snapshot row shape, and
 * the ONE decision the write path runs:
 *
 *   needsOverwriteSnapshot — should the store snapshot the live row before overwriting
 *   it? Only when a row exists AND its stored fingerprint DIFFERS from the incoming
 *   one. That single comparison buys three properties at once:
 *     · idempotency — a second sweep tick over unchanged evidence produces the same
 *       fingerprint, so it snapshots nothing AND (see lib/preop/store.ts) writes
 *       nothing at all. The B2 double-tick gate is this line.
 *     · the timeline — every change to the evidence or the arithmetic mints exactly one
 *       version, which is the "booking-only range -> labs land -> PAC lands -> score
 *       tightens" story the case page exists to tell (PRD §5).
 *     · honesty under replay — a replay never touches the live row (R8.1 O5), so its
 *       snapshot is the NEW reading, written with capture_reason 'replay'.
 *
 * The R8.1 original compares trace ids, because two LLM readings of the same case are
 * never byte-equal and only the trace can say "this is the same reading". Here there is
 * no model in the loop at all: the same evidence deterministically produces the same
 * numbers, so the fingerprint IS the identity of a reading, and comparing it is
 * strictly stronger than comparing a trace. Deviation from the sibling, deliberate,
 * flagged in the build report.
 */

import type { PreopSnapshot } from './preop-assemble-core';

/** The closed capture-reason set: exactly these two, no others. */
/**
 * The closed capture-reason set. B8b adds `confirm`, deliberately and documented: a
 * clinician pressing Confirm on a suggestion changes an input's STATUS, which changes the
 * score, which mints a version — and that step in the timeline is not an overwrite by a
 * sweep, it is a person deciding something. Calling it 'overwrite' would hide the one
 * capture reason a reader most wants to see.
 */
export const PREOP_CAPTURE_REASONS = ['overwrite', 'replay', 'confirm'] as const;
export type PreopCaptureReason = (typeof PREOP_CAPTURE_REASONS)[number];

export const PREOP_VERSIONS_RULE_VERSION = 'preop-versions/1';

/** A replay is a manual research tool, not a rail: 1 to 3 runs per request, never more. */
export const PREOP_REPLAY_MAX_RUNS = 3;

/** The episode key's shape, validated before it reaches a query. */
export function isEpisodeKeyShape(s: string): boolean {
  return s.length >= 3 && s.length <= 200 && /^[A-Za-z0-9/_:|.-]+$/.test(s);
}

/** What the store reads off the live row before deciding. */
export interface StoredReading {
  snapshot_fingerprint?: unknown;
  version_no?: unknown;
}

/**
 * TRUE ⇔ a row exists and the reading about to replace it is a DIFFERENT reading.
 * A missing/unreadable stored fingerprint snapshots anyway: a duplicate version row is
 * recoverable, a silent hole in the history is the thing this table exists to prevent.
 */
export function needsOverwriteSnapshot(row: StoredReading | null | undefined, incomingFingerprint: string): boolean {
  if (!row) return false;                       // nothing stored yet — the first write is not an overwrite
  const stored = typeof row.snapshot_fingerprint === 'string' && row.snapshot_fingerprint.length > 0
    ? row.snapshot_fingerprint : null;
  if (stored === null) return true;             // unreadable history beats missing history
  return stored !== incomingFingerprint;
}

/** The version number the incoming write should carry. */
export function nextVersionNo(row: StoredReading | null | undefined, willSnapshot: boolean): number {
  const cur = typeof row?.version_no === 'number' && Number.isFinite(row.version_no) ? row.version_no : 0;
  if (!row) return 1;
  return willSnapshot ? cur + 1 : Math.max(cur, 1);
}

/** One row of preop_finding_versions, as the store inserts it (column order there). */
export interface PreopVersionSnapshot {
  captureReason: PreopCaptureReason;
  episodeKey: string;
  engineVersion: string;
  versionNo: number | null;
  tier: string | null;
  rcriLo: number | null; rcriHi: number | null;
  mfiLo: number | null; mfiHi: number | null;
  cciLo: number | null; cciHi: number | null;
  snapshotFingerprint: string | null;
  /** why this reading differs from the one before it, in the module's own words */
  captureNote: string | null;
  computedAt: string | null;
  rowSnapshot: Record<string, unknown>;
  traceId: string | null;
}

/**
 * The version row for the reading being DESTROYED by an overwrite. Built from what the
 * store read off the live row — never from the incoming snapshot, which has not happened
 * yet at that point in the write.
 */
export function buildOverwriteSnapshot(stored: {
  episodeKey: string; engineVersion: string; versionNo: number | null; tier: string | null;
  snapshot: Record<string, unknown> | null; snapshotFingerprint: string | null;
  computedAt: string | null; traceId: string | null;
}): PreopVersionSnapshot {
  const s = stored.snapshot ?? {};
  const band = (k: 'rcri' | 'mfi5' | 'charlson', b: 'lo' | 'hi'): number | null => {
    const v = (s as Record<string, { lo?: unknown; hi?: unknown }>)[k]?.[b];
    return typeof v === 'number' ? v : null;
  };
  return {
    captureReason: 'overwrite',
    episodeKey: stored.episodeKey,
    engineVersion: stored.engineVersion,
    versionNo: stored.versionNo,
    tier: stored.tier,
    rcriLo: band('rcri', 'lo'), rcriHi: band('rcri', 'hi'),
    mfiLo: band('mfi5', 'lo'), mfiHi: band('mfi5', 'hi'),
    cciLo: band('charlson', 'lo'), cciHi: band('charlson', 'hi'),
    snapshotFingerprint: stored.snapshotFingerprint,
    captureNote: null,
    computedAt: stored.computedAt,
    rowSnapshot: { versions_rule_version: PREOP_VERSIONS_RULE_VERSION, capture_reason: 'overwrite', snapshot: s },
    traceId: stored.traceId,
  };
}

/**
 * The version row for a deliberate replay (R8.1 O5): the snapshot IS the new reading and
 * the live row is never touched. Version number is null — a replay has no place in the
 * live row's numbering.
 */
export function buildReplaySnapshot(snap: PreopSnapshot, traceId: string | null = null): PreopVersionSnapshot {
  return {
    captureReason: 'replay',
    episodeKey: snap.episodeKey,
    engineVersion: snap.engineVersion,
    versionNo: null,
    tier: snap.tier.tier,
    rcriLo: snap.rcri.lo, rcriHi: snap.rcri.hi,
    mfiLo: snap.mfi5.lo, mfiHi: snap.mfi5.hi,
    cciLo: snap.charlson.lo, cciHi: snap.charlson.hi,
    snapshotFingerprint: snap.fingerprint,
    captureNote: null,
    computedAt: snap.computedAt,
    rowSnapshot: { versions_rule_version: PREOP_VERSIONS_RULE_VERSION, capture_reason: 'replay', snapshot: snap as unknown as Record<string, unknown> },
    traceId,
  };
}

/**
 * A one-line, human-readable "what changed" for the timeline step, derived by comparing
 * two readings' resolved inputs. Deterministic text off two computed results — the
 * mockup's "creatinine 1.4 -> renal factor resolved absent" line, and the reason the
 * timeline reads as a story rather than as a list of hashes.
 */
export function describeChange(
  before: Pick<PreopSnapshot, 'inputs'> | null,
  after: Pick<PreopSnapshot, 'inputs'>,
): string {
  if (!before) return 'first snapshot';
  const prev = new Map(before.inputs.map((i) => [i.inputId, i]));
  const moved: string[] = [];
  for (const a of after.inputs) {
    const b = prev.get(a.inputId);
    if (!b || b.status === a.status) continue;
    const value = a.value != null ? `${a.value} → ` : '';
    moved.push(`${a.inputId.replace(/_/g, ' ')}: ${value}${b.status} → ${a.status}`);
  }
  if (!moved.length) return 'recomputed — no input changed status';
  return moved.join(' · ');
}
