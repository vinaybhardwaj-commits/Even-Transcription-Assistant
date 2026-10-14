/**
 * Pure core for Review-Mode gamification stats (REVIEW-GAMIFICATION-PRD §3–§4). No db / Next imports:
 * strip-types testable; the route (app/api/care/review-stats/route.ts) fetches rows and delegates
 * every computation here.
 *
 * ONE counting basis (§3.4): a "counted label" = a current-state scope='finding' row (the LATEST row
 * per (author, audit_id, finding_ref)) PLUS every scope='missed' row; scope='impact' NEVER counts;
 * author ∈ roster; all engine versions; IST days; week = IST Monday-start. Team total, week total,
 * personal weekly, and streak all use this basis. Agreement is pairwise on the overlap set.
 *
 * Overlap definition reuses lib/review-queue-core.isOverlap (hash(finding_ref) % 100 < 20) — the PRD
 * calls this `assignBucket`; the shipped export is `isOverlap` (which IS that predicate). See report.
 */
import { isOverlap } from './review-queue-core';

export interface ReviewGoal { target: number; label: string; weekly_target: number; streak_min_per_day: number }
/** §3.1 exact defaults — used on a missing/invalid review_goal key. */
export const DEFAULT_GOAL: ReviewGoal = { target: 1000, label: 'Evaluation set v1', weekly_target: 200, streak_min_per_day: 15 };
export const FALLBACK_ROSTER = ['V', 'Zaki', 'Aravind', 'Binita'];
export const AGREEMENT_MIN_PAIRS = 20;

const posInt = (v: unknown, dflt: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

/** Parse the app_settings review_goal JSON → typed goal; any parse/shape failure → DEFAULT_GOAL exactly. */
export function parseGoal(raw: string | null | undefined): ReviewGoal {
  if (!raw) return { ...DEFAULT_GOAL };
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (!j || typeof j !== 'object') return { ...DEFAULT_GOAL };
    return {
      target: posInt(j.target, DEFAULT_GOAL.target),
      label: (typeof j.label === 'string' && j.label.trim()) ? j.label : DEFAULT_GOAL.label,
      weekly_target: posInt(j.weekly_target, DEFAULT_GOAL.weekly_target),
      streak_min_per_day: posInt(j.streak_min_per_day, DEFAULT_GOAL.streak_min_per_day),
    };
  } catch { return { ...DEFAULT_GOAL }; }
}

export function personalWeeklyTarget(weekly_target: number, rosterLen: number): number {
  return Math.ceil(weekly_target / Math.max(1, rosterLen));
}

// ── IST calendar-date helpers (pure, string-based; input days are already IST calendar dates) ──
const ISODAY = /^\d{4}-\d{2}-\d{2}$/;
function dayToUTC(day: string): number { return new Date(`${day}T00:00:00Z`).getTime(); }
function utcToDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
const DAY_MS = 86400000;

export function prevDay(day: string): string {
  if (!ISODAY.test(day)) return day;
  return utcToDay(dayToUTC(day) - DAY_MS);
}
/** Monday (IST, week start) of the week containing `day`. */
export function istWeekStart(day: string): string {
  if (!ISODAY.test(day)) return day;
  const d = new Date(`${day}T00:00:00Z`);
  const dow = d.getUTCDay();                 // 0=Sun … 6=Sat
  const sinceMonday = (dow + 6) % 7;         // Mon→0 … Sun→6
  return utcToDay(d.getTime() - sinceMonday * DAY_MS);
}

// ── counting basis (§3.4) ──────────────────────────────────────────────────────
export interface LabelRow {
  author: string;
  scope: string;                 // 'finding' | 'missed' | 'impact' | 'audit' | …
  audit_id: string;
  finding_ref: string | null;
  verdict: string | null;
  day: string;                   // IST calendar day 'YYYY-MM-DD' of THIS row
}
/** One counted label (post-basis): a current-state finding, or a missed flag. */
export interface CountedLabel { author: string; day: string; finding_ref: string | null; verdict: string | null; overlap: boolean }

/**
 * Apply the counting basis to raw rows. `rows` MUST be ordered oldest-first (ascending created_at) so
 * "later row wins" holds for the current-state finding dedup. impact/audit rows and non-roster authors
 * are dropped; every missed row is kept; findings collapse to the latest per (author, audit_id, ref).
 */
export function countedLabels(rows: LabelRow[], roster: string[]): CountedLabel[] {
  const inRoster = new Set(roster);
  const findingLatest = new Map<string, CountedLabel>();   // key = author|audit_id|finding_ref
  const missed: CountedLabel[] = [];
  for (const r of rows) {
    if (!inRoster.has(r.author)) continue;
    if (r.scope === 'finding') {
      if (!r.finding_ref) continue;
      const key = `${r.author}|${r.audit_id}|${r.finding_ref}`;
      findingLatest.set(key, { author: r.author, day: r.day, finding_ref: r.finding_ref, verdict: r.verdict, overlap: isOverlap(r.finding_ref) });
    } else if (r.scope === 'missed') {
      missed.push({ author: r.author, day: r.day, finding_ref: null, verdict: null, overlap: false });
    }
    // impact / audit / anything else: never counts (§3.4)
  }
  return [...findingLatest.values(), ...missed];
}

// ── streak (§3.2) ────────────────────────────────────────────────────────────
/** Consecutive IST days with ≥ minPerDay counted labels, ending today OR yesterday (grace); else 0. */
export function computeStreak(days: string[], today: string, minPerDay: number): number {
  const perDay = new Map<string, number>();
  for (const d of days) perDay.set(d, (perDay.get(d) || 0) + 1);
  const qualifies = (d: string): boolean => (perDay.get(d) || 0) >= minPerDay;
  let anchor: string | null = null;
  if (qualifies(today)) anchor = today;
  else if (qualifies(prevDay(today))) anchor = prevDay(today);
  if (!anchor) return 0;
  let streak = 0, cur = anchor;
  while (qualifies(cur)) { streak++; cur = prevDay(cur); }
  return streak;
}

// ── pairwise agreement (§3.3) ────────────────────────────────────────────────
export interface AgreementResult { pairs: number; matches: number; agreement_pct: number | null }
/**
 * Pairwise agreement per reviewer, pooled across co-reviewers, on OVERLAP findings only. `counted` is
 * the current-state counted set (from countedLabels). For each overlap finding labeled by ≥2 roster
 * authors, each ordered (A,B) co-pair contributes to A's tally; matches = same verdict tier.
 */
export function agreementByReviewer(counted: CountedLabel[], roster: string[]): Record<string, AgreementResult> {
  const inRoster = new Set(roster);
  // group overlap-finding verdicts by (audit-less) finding key → author → verdict (current-state already deduped)
  const byFinding = new Map<string, Array<{ author: string; verdict: string }>>();
  for (const c of counted) {
    if (!c.overlap || c.finding_ref == null || c.verdict == null) continue;
    if (!inRoster.has(c.author)) continue;
    const arr = byFinding.get(c.finding_ref) || [];
    arr.push({ author: c.author, verdict: c.verdict });
    byFinding.set(c.finding_ref, arr);
  }
  const out: Record<string, AgreementResult> = {};
  const bump = (a: string, matched: boolean) => {
    const r = out[a] || { pairs: 0, matches: 0, agreement_pct: null };
    r.pairs += 1; if (matched) r.matches += 1;
    out[a] = r;
  };
  for (const [, labels] of byFinding) {
    if (labels.length < 2) continue;
    for (let i = 0; i < labels.length; i++) {
      for (let j = 0; j < labels.length; j++) {
        if (i === j) continue;
        bump(labels[i].author, labels[i].verdict === labels[j].verdict);
      }
    }
  }
  for (const a of Object.keys(out)) {
    const r = out[a];
    r.agreement_pct = r.pairs > 0 ? Math.round((r.matches / r.pairs) * 100) : null;
  }
  return out;
}

// ── top-level assembly ────────────────────────────────────────────────────────
export interface Badge { author: string; streak?: number; agreement_pct?: number; pairs?: number }
export interface ReviewStats {
  goal: { target: number; label: string; weekly_target: number };
  team: { total: number; week: number };
  badges: Badge[];
  personal_weekly_target: number;
  perAuthor: Record<string, { week: number; streak: number; pairs: number; agreement_pct: number | null }>;
}

export function computeReviewStats(input: { rows: LabelRow[]; roster: string[]; today: string; goal: ReviewGoal }): ReviewStats {
  const { rows, roster, today, goal } = input;
  const counted = countedLabels(rows, roster);
  const weekStart = istWeekStart(today);
  const total = counted.length;
  const week = counted.filter((c) => c.day >= weekStart).length;
  const agreement = agreementByReviewer(counted, roster);

  const perAuthor: ReviewStats['perAuthor'] = {};
  for (const author of roster) {
    const mine = counted.filter((c) => c.author === author);
    const streak = computeStreak(mine.map((c) => c.day), today, goal.streak_min_per_day);
    const ag = agreement[author] || { pairs: 0, matches: 0, agreement_pct: null };
    perAuthor[author] = { week: mine.filter((c) => c.day >= weekStart).length, streak, pairs: ag.pairs, agreement_pct: ag.agreement_pct };
  }

  // badges: only members who HAVE one — a live streak (>0) and/or agreement at ≥20 pairs (§2.1/§3.3)
  const badges: Badge[] = [];
  for (const author of roster) {
    const p = perAuthor[author];
    const showStreak = p.streak > 0;
    const showAgreement = p.pairs >= AGREEMENT_MIN_PAIRS && p.agreement_pct != null;
    if (!showStreak && !showAgreement) continue;
    const b: Badge = { author };
    if (showStreak) b.streak = p.streak;
    if (showAgreement) { b.agreement_pct = p.agreement_pct as number; b.pairs = p.pairs; }
    badges.push(b);
  }

  return {
    goal: { target: goal.target, label: goal.label, weekly_target: goal.weekly_target },
    team: { total, week },
    badges,
    personal_weekly_target: personalWeeklyTarget(goal.weekly_target, roster.length),
    perAuthor,
  };
}
