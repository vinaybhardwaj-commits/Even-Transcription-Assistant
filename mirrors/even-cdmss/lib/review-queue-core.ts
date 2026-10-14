/**
 * lib/review-queue-core.ts — pure core for Review Mode's queue + assignment (Gold-Label Review-Mode
 * PRD §2). No Next / no db imports: strip-types testable, and the route feeds it already-read rows.
 *
 * Three responsibilities, all deterministic (stateless — a reviewer resuming on another machine gets
 * the same worklist):
 *   1. Assignment (§1.7): hash(finding_ref) % 100 → 0–19 OVERLAP (served to EVERY reviewer),
 *      20–99 partitioned evenly across the roster. Same finding → same bucket forever.
 *   2. Priority merge (§2): disagreement items (when the flag is on — route passes [] when off) →
 *      untriaged current-engine findings BALANCED across signal_types, newest first.
 *   3. Exclusions (§2): drop findings already labeled by THIS reviewer, findings not assigned to this
 *      reviewer, informational findings, and anything failing the request filters.
 */

// ── Assignment (deterministic, stateless) ─────────────────────────────────────
const OVERLAP_CEIL = 20;   // buckets 0..19 are the shared inter-rater OVERLAP set (20% of findings)
const BUCKETS = 100;
const PARTITION_SPAN = BUCKETS - OVERLAP_CEIL; // 80 buckets partitioned across the roster

/** Stable string hash → 0..99 (FNV-1a, 32-bit). finding_ref is already a content hash; this just
 *  folds it to a bucket. Deterministic across machines/processes — no Math.random, no Date. */
export function hashBucket(findingRef: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < findingRef.length; i++) {
    h ^= findingRef.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % BUCKETS;
}

/** buckets 0..19 → the overlap set served to all reviewers (kappa is measured on these). */
export function isOverlap(findingRef: string): boolean {
  return hashBucket(findingRef) < OVERLAP_CEIL;
}

/** Which roster slot owns a partitioned (20..99) bucket, evenly. -1 for overlap buckets / empty roster. */
export function partitionIndex(findingRef: string, rosterSize: number): number {
  if (rosterSize <= 0) return -1;
  const b = hashBucket(findingRef);
  if (b < OVERLAP_CEIL) return -1;
  return Math.floor(((b - OVERLAP_CEIL) * rosterSize) / PARTITION_SPAN);
}

/** Is this finding served to `reviewer`? Overlap items go to everyone; partitioned items go to the
 *  one roster slot that owns their bucket. A reviewer not on the roster still sees the overlap set. */
export function assignedToReviewer(findingRef: string, reviewer: string, roster: string[]): boolean {
  if (isOverlap(findingRef)) return true;
  const idx = roster.indexOf(reviewer);
  if (idx < 0) return false;
  return partitionIndex(findingRef, roster.length) === idx;
}

// ── Queue items ───────────────────────────────────────────────────────────────
export type DisagreementType = 'tier_differs' | 'teacher_only' | 'student_only';

export interface QueueFinding {
  audit_id: string;
  finding_ref: string;
  signal_type: string;
  domain: string;
  subject: string;
  rationale: string;
  verdict: string;
  note_date: string;        // 'YYYY-MM-DD' (IST) — used for newest-first ordering
  doctor_uid: string;
  citation_ids?: number[];
  informational?: boolean;
  // PDF-context (Review-Mode v1.1) — OPTIONAL passthrough only; no ordering/assignment logic reads
  // these. `uid` = the note uid; `prescription_url` = its db13 GCS PDF (null when absent → fallback).
  uid?: string;
  prescription_url?: string | null;
}

export interface QueueItem extends QueueFinding {
  queue: 'disagreement' | 'fresh';
  disagreement_type?: DisagreementType;
  disagreement_reason?: string;   // human "student model missed this" / "tier differs" (§4)
}

export interface QueueFilters {
  signal_type?: string | null;
  domain?: string | null;
  doctor_uid?: string | null;
  from?: string | null;         // 'YYYY-MM-DD' inclusive
  to?: string | null;           // 'YYYY-MM-DD' inclusive
}

export interface BuildQueueInput {
  reviewer: string;
  roster: string[];
  fresh: QueueFinding[];
  /** Disagreement items — the route passes [] unless `review_disagreement_enabled=1` (§4 flag). */
  disagreements?: QueueItem[];
  /** `${audit_id}|${finding_ref}` already labeled (scope='finding') by THIS reviewer. */
  labeledKeys?: Iterable<string>;
  limit: number;
  filters?: QueueFilters;
}

export function itemKey(f: { audit_id: string; finding_ref: string }): string {
  return `${f.audit_id}|${f.finding_ref}`;
}

function passesFilters(f: QueueFinding, filt?: QueueFilters): boolean {
  if (!filt) return true;
  if (filt.signal_type && f.signal_type !== filt.signal_type) return false;
  if (filt.domain && f.domain !== filt.domain) return false;
  if (filt.doctor_uid && f.doctor_uid !== filt.doctor_uid) return false;
  if (filt.from && f.note_date < filt.from) return false;
  if (filt.to && f.note_date > filt.to) return false;
  return true;
}

/**
 * Interleave findings so no single signal_type dominates the head of the queue (§2 "balanced across
 * signal_types, newest first"). Each signal_type group is sorted newest-first (finding_ref tie-break
 * for determinism); groups are then visited round-robin. Group order = newest item desc, then
 * signal_type asc — fully deterministic.
 */
export function balanceBySignalType<T extends QueueFinding>(items: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const g = groups.get(it.signal_type);
    if (g) g.push(it); else groups.set(it.signal_type, [it]);
  }
  const byDateDesc = (a: QueueFinding, b: QueueFinding): number =>
    a.note_date === b.note_date ? (a.finding_ref < b.finding_ref ? -1 : a.finding_ref > b.finding_ref ? 1 : 0)
      : (a.note_date < b.note_date ? 1 : -1);
  const ordered = [...groups.values()].map((g) => g.sort(byDateDesc));
  ordered.sort((a, b) => {
    const d = byDateDesc(a[0], b[0]);
    return d !== 0 ? d : (a[0].signal_type < b[0].signal_type ? -1 : 1);
  });
  const out: T[] = [];
  for (let round = 0; ; round++) {
    let progressed = false;
    for (const g of ordered) {
      if (round < g.length) { out.push(g[round]); progressed = true; }
    }
    if (!progressed) break;
  }
  return out;
}

/**
 * Build the next slice of the reviewer's worklist. Priority: disagreement items (already ordered by
 * the route; deduped) → fresh findings balanced across signal_types. Every candidate must pass the
 * filters, be assigned to this reviewer, not already be labeled by this reviewer, and not be
 * informational. Returns at most `limit` items.
 */
export function buildReviewQueue(input: BuildQueueInput): QueueItem[] {
  const { reviewer, roster, limit } = input;
  const labeled = new Set<string>(input.labeledKeys ?? []);
  const seen = new Set<string>();
  const eligible = (f: QueueFinding): boolean =>
    !f.informational
    && passesFilters(f, input.filters)
    && assignedToReviewer(f.finding_ref, reviewer, roster)
    && !labeled.has(itemKey(f));

  const out: QueueItem[] = [];
  const push = (it: QueueItem): void => {
    const k = itemKey(it);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(it);
  };

  // (1) disagreement items first (route supplies them only when the flag is on).
  for (const d of input.disagreements ?? []) {
    if (out.length >= limit) break;
    if (eligible(d)) push({ ...d, queue: 'disagreement' });
  }

  // (2) fresh, balanced across signal_types, newest first.
  const freshEligible = input.fresh.filter(eligible);
  for (const f of balanceBySignalType(freshEligible)) {
    if (out.length >= limit) break;
    push({ ...f, queue: 'fresh' });
  }

  return out.slice(0, limit);
}
