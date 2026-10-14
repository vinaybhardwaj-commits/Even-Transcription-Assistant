/**
 * Pure core for the OPD feedback-strip UX (OPD-FEEDBACK-UX-POLISH-PRD §4). No React / DOM / network
 * imports — just the observable logic that must be testable without a browser: the per-pill tap
 * decision (no toggle-off), the failed-POST revert + retry payload, the saved-label timestamp, and
 * the Feature-B progress counter with dedupe-by-findingRef.
 */

// ── per-pill tap state machine (Feature A) ─────────────────────────────────────
export type Verdict = string;

/** The attempted POST, kept so a failure can revert the pill AND a retry can re-post it verbatim. */
export type Attempt = { verdict: Verdict; comment: string | null; prev: Verdict | null };

export type TapPlan =
  | { noop: true }
  | { noop: false; prev: Verdict | null; next: Verdict };

/**
 * Decide what tapping pill `key` does given the currently `selected` verdict.
 * No toggle-off: tapping the already-selected pill is a NO-OP (the append-only store has no
 * retraction; a local deselect used to lie about DB state). Changing your mind = tap another pill.
 */
export function planTap(selected: Verdict | null, key: Verdict): TapPlan {
  if (selected === key) return { noop: true };
  return { noop: false, prev: selected, next: key };
}

/** The payload to POST (and to re-POST on retry), capturing the pre-tap verdict for revert-on-fail. */
export function makeAttempt(prev: Verdict | null, verdict: Verdict, comment: string | null | undefined): Attempt {
  return { verdict, comment: comment ?? null, prev };
}

/** On a failed POST the pill REVERTS to its previous state (PRD §1A). Returns the verdict to restore. */
export function revertOnFail(attempt: Attempt): Verdict | null {
  return attempt.prev;
}

// ── saved-label timestamp (Feature A: "Saved HH:MM · name") ─────────────────────
export function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }

/** 24h IST HH:MM from an epoch Date (client clock is fine per PRD; IST = UTC+5:30, TZ-independent). */
export function formatIstClock(d: Date): string {
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
  return `${pad2(ist.getUTCHours())}:${pad2(ist.getUTCMinutes())}`;
}

/** The persistent saved metadata line: `Saved HH:MM · <name|anon>`. */
export function savedLabel(name: string | null | undefined, d: Date): string {
  const who = (name && name.trim()) ? name.trim() : 'anon';
  return `Saved ${formatIstClock(d)} · ${who}`;
}

// ── sidebar triage progress (Feature B) ────────────────────────────────────────
/**
 * F6 (A10.1): `category` rides the saved event for scope='missed'. Purely informational for the
 * counter — applySaved's dedupe semantics are UNCHANGED (a missed save still bumps `missed` by one,
 * a finding save still dedupes on findingRef). It is carried so a listener can show or group by the
 * classifier without a refetch; nothing in this module branches on it.
 */
export type SavedEvent = { findingRef?: string; verdict?: string; scope?: string; category?: string };
export type ProgressState = { triaged: number; total: number; missed: number; seen: Set<string> };

/**
 * Seed the counter from server-computed current state. `triagedRefs` = the finding_refs already
 * triaged (reused from the page's current-state map), so a live re-verdict of an already-counted
 * finding dedupes correctly across the seed boundary. total = findings WITH a finding_ref.
 */
export function initProgress(seed: { total: number; triagedRefs: string[]; missed: number }): ProgressState {
  const seen = new Set(seed.triagedRefs.filter(Boolean));
  return { total: seed.total, missed: seed.missed, seen, triaged: Math.min(seed.total, seen.size) };
}

/**
 * Fold one `opd-feedback-saved` event into the counter. scope='missed' bumps the missed tally;
 * a finding save bumps `triaged` only for a NEW findingRef (dedupe so re-verdicts don't double-count).
 * Returns a new state (pure).
 */
export function applySaved(state: ProgressState, ev: SavedEvent): ProgressState {
  if (ev && ev.scope === 'missed') return { ...state, missed: state.missed + 1 };
  const ref = ev && ev.findingRef;
  if (!ref || state.seen.has(ref)) return state; // unknown or already-counted → no change
  const seen = new Set(state.seen); seen.add(ref);
  return { ...state, seen, triaged: Math.min(state.total, state.triaged + 1) };
}
