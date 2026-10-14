/**
 * lib/finding-match-core.ts — pure matcher for the disagreement queue (Gold-Label Review-Mode §4).
 * No Next / no db imports: strip-types testable; the route feeds it teacher (Gemini,
 * opd_note_audits.findings) and student (qwen, lab_analyses.output.findings) findings for ONE shared
 * uid and stores/serves whatever it returns.
 *
 * Pairing rule (§4): exact `finding_ref` when BOTH findings are stamped, else `signal_type` equality
 * + normalized-subject token Jaccard ≥ 0.5, tie-broken by domain. Output per note: matched pairs
 * (with a verdict-tier agreement flag), teacher-only findings, student-only findings.
 *
 * A "disagreement item" (§4) = a matched pair with different verdict tiers, OR a teacher-only, OR a
 * student-only finding — each carrying its type so the queue can tell the reviewer WHY it is queued.
 */

export const JACCARD_THRESHOLD = 0.5;

export interface MatchFinding {
  finding_ref?: string | null;
  signal_type?: string | null;
  subject?: string | null;
  domain?: string | null;
  verdict?: string | null;
}

export type MatchKind = 'ref' | 'fuzzy';

export interface MatchedPair {
  teacher: MatchFinding;
  student: MatchFinding;
  match_kind: MatchKind;
  jaccard: number;            // 1 for exact-ref matches
  tier_agreement: boolean;    // teacher.verdict === student.verdict
}

export interface MatchResult {
  pairs: MatchedPair[];
  teacherOnly: MatchFinding[];
  studentOnly: MatchFinding[];
}

/** Normalized subject → token set. Lowercase, split on non-alphanumerics, drop empties. Pure. */
export function subjectTokens(subject: string | null | undefined): Set<string> {
  const s = (subject ?? '').toLowerCase();
  const toks = s.split(/[^a-z0-9]+/).filter(Boolean);
  return new Set(toks);
}

/** Jaccard similarity of two token sets. Two empty sets → 0 (never match on shared emptiness). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function tier(f: MatchFinding): string | null {
  return f.verdict == null || f.verdict === '' ? null : String(f.verdict);
}
function tierAgreement(t: MatchFinding, s: MatchFinding): boolean {
  const a = tier(t), b = tier(s);
  return a !== null && b !== null && a === b;
}

/**
 * Match one note's teacher + student findings. Two-pass greedy: exact finding_ref first (only when
 * both sides are stamped), then best fuzzy (same signal_type, Jaccard ≥ threshold, tie-break: higher
 * Jaccard, then domain-equal, then earliest index — fully deterministic). Never mutates inputs.
 */
export function matchFindings(teacher: MatchFinding[], student: MatchFinding[]): MatchResult {
  const pairs: MatchedPair[] = [];
  const usedStudent = new Set<number>();
  const usedTeacher = new Set<number>();

  // Pass 1 — exact finding_ref (both stamped). First unused student wins on a ref collision.
  for (let ti = 0; ti < teacher.length; ti++) {
    const t = teacher[ti];
    const tref = t.finding_ref;
    if (!tref) continue;
    for (let si = 0; si < student.length; si++) {
      if (usedStudent.has(si)) continue;
      const s = student[si];
      if (s.finding_ref && s.finding_ref === tref) {
        pairs.push({ teacher: t, student: s, match_kind: 'ref', jaccard: 1, tier_agreement: tierAgreement(t, s) });
        usedTeacher.add(ti); usedStudent.add(si);
        break;
      }
    }
  }

  // Pass 2 — fuzzy (signal_type equality + Jaccard ≥ threshold, tie-break domain then index).
  for (let ti = 0; ti < teacher.length; ti++) {
    if (usedTeacher.has(ti)) continue;
    const t = teacher[ti];
    const tTokens = subjectTokens(t.subject);
    let best = -1, bestJac = -1, bestDomain = false;
    for (let si = 0; si < student.length; si++) {
      if (usedStudent.has(si)) continue;
      const s = student[si];
      if (!t.signal_type || !s.signal_type || t.signal_type !== s.signal_type) continue;
      const jac = jaccard(tTokens, subjectTokens(s.subject));
      if (jac < JACCARD_THRESHOLD) continue;
      const domainEq = !!t.domain && t.domain === s.domain;
      if (jac > bestJac || (jac === bestJac && domainEq && !bestDomain)) {
        best = si; bestJac = jac; bestDomain = domainEq;
      }
    }
    if (best >= 0) {
      const s = student[best];
      pairs.push({ teacher: t, student: s, match_kind: 'fuzzy', jaccard: bestJac, tier_agreement: tierAgreement(t, s) });
      usedTeacher.add(ti); usedStudent.add(best);
    }
  }

  const teacherOnly = teacher.filter((_, ti) => !usedTeacher.has(ti));
  const studentOnly = student.filter((_, si) => !usedStudent.has(si));
  return { pairs, teacherOnly, studentOnly };
}

export type DisagreementType = 'tier_differs' | 'teacher_only' | 'student_only';
export interface Disagreement {
  type: DisagreementType;
  teacher?: MatchFinding;
  student?: MatchFinding;
  reason: string;             // reviewer-facing "why this is queued"
}

const REASONS: Record<DisagreementType, string> = {
  tier_differs: 'tier differs',
  teacher_only: 'student model missed this',
  student_only: 'student flagged this, teacher didn’t',
};

/** Turn a match result into the queue's disagreement items (§4): tier-differing pairs (keyed to the
 *  teacher finding — the one a reviewer labels), teacher-only, and student-only findings. */
export function disagreementsOf(result: MatchResult): Disagreement[] {
  const out: Disagreement[] = [];
  for (const p of result.pairs) {
    if (!p.tier_agreement) out.push({ type: 'tier_differs', teacher: p.teacher, student: p.student, reason: REASONS.tier_differs });
  }
  for (const t of result.teacherOnly) out.push({ type: 'teacher_only', teacher: t, reason: REASONS.teacher_only });
  for (const s of result.studentOnly) out.push({ type: 'student_only', student: s, reason: REASONS.student_only });
  return out;
}
