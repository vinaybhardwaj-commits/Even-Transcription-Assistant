/**
 * lib/signal-health-core.ts — Tier 0 self-healing: signal-health CORE (pure).
 *
 * Turns the care managers' triage decisions (opd_audit_triage) into a per-signal_type precision
 * view: how often each rule is validated vs flagged as an audit bug, its trend, and the top reason
 * codes. This is the measurement substrate (PRD §7 Tier 0) — nobody can see which rules are noisy
 * today; this makes precision measurable per rule, and is what every later healing tier reads.
 * Pure → unit-testable.
 */

export interface HealthDecision {
  signal_type: string;
  validity: string;                 // valid_signal | audit_bug
  bug_type: string | null;          // process_bug | structural_bug
  routed: boolean;
  reason: string | null;
  created_at: string;               // ISO
}

export interface SignalHealth {
  signal_type: string;
  label: string;
  decided: number;                  // type-level decisions
  valid: number;
  audit_bug: number;
  process_bug: number;
  structural_bug: number;
  routed: number;
  fp_rate: number;                  // audit_bug / decided, 0..1
  recent_fp_rate: number | null;    // last `recentDays`
  prior_fp_rate: number | null;     // before that
  trend: 'improving' | 'worsening' | 'flat' | 'insufficient';
  top_reasons: { reason: string; n: number }[];
  healable: boolean;                // structural bugs present → a suppression could help
}

const LABELS: Record<string, string> = {
  drug_interaction: 'Drug interaction', incomplete_dosing: 'Incomplete dosing',
  duplicate_prescription: 'Duplicate prescription', unverified_brand: 'Unverified brand',
  lasa_pair: 'LASA pair co-prescribed', dose_ceiling_exceeded: 'Daily dose exceeds ceiling',
  dose_ceiling_sos: 'Dose may exceed ceiling if all SOS taken', duplicate_molecule: 'Same molecule in multiple products',
  high_alert_medication: 'High-alert medication', schedule_x: 'Schedule X drug', off_formulary: 'Off-formulary items',
  antibiotic_stewardship: 'Antibiotic stewardship',
  appropriateness_low_value: 'Low-value / inappropriate care', appropriateness_review: 'Appropriateness — needs review',
  appropriateness_high_value: 'High-value care', prescribing_low_value: 'Low-value / unsafe prescribing',
  prescribing_review: 'Prescribing — needs review', prescribing_high_value: 'Sound prescribing',
  appropriateness_general: 'Appropriateness', prescribing_general: 'Prescribing safety',
};
const labelFor = (t: string): string => LABELS[t] || t.replace(/_/g, ' ');

/**
 * Only the LATEST type-level decision per (doctor_uid, signal_type) counts — a re-triage supersedes.
 * (The caller passes type-scope decisions; instance overrides are drill-level, not health-level.)
 * We approximate "latest per doctor×type" by keeping the newest decision per composite key.
 */
export function computeSignalHealth(
  decisions: (HealthDecision & { doctor_uid?: string })[],
  opts: { recentDays?: number; now?: string } = {},
): SignalHealth[] {
  const recentDays = opts.recentDays ?? 14;
  const nowMs = opts.now ? new Date(opts.now).getTime() : Date.now();
  const cutoff = nowMs - recentDays * 86400_000;

  // keep the newest decision per (doctor_uid, signal_type)
  const latest = new Map<string, HealthDecision & { doctor_uid?: string }>();
  for (const d of decisions) {
    const key = `${d.doctor_uid ?? ''}|${d.signal_type}`;
    const prev = latest.get(key);
    if (!prev || d.created_at > prev.created_at) latest.set(key, d);
  }

  const byType = new Map<string, (HealthDecision & { doctor_uid?: string })[]>();
  for (const d of latest.values()) (byType.get(d.signal_type) || byType.set(d.signal_type, []).get(d.signal_type)!).push(d);

  const fpRate = (rows: HealthDecision[]): number | null => {
    if (!rows.length) return null;
    return rows.filter((r) => r.validity === 'audit_bug').length / rows.length;
  };

  const out: SignalHealth[] = [];
  for (const [signal_type, rows] of byType.entries()) {
    const decided = rows.length;
    const valid = rows.filter((r) => r.validity === 'valid_signal').length;
    const audit_bug = rows.filter((r) => r.validity === 'audit_bug').length;
    const process_bug = rows.filter((r) => r.bug_type === 'process_bug').length;
    const structural_bug = rows.filter((r) => r.bug_type === 'structural_bug').length;
    const routed = rows.filter((r) => r.routed).length;

    const recent = rows.filter((r) => new Date(r.created_at).getTime() >= cutoff);
    const prior = rows.filter((r) => new Date(r.created_at).getTime() < cutoff);
    const recent_fp = fpRate(recent);
    const prior_fp = fpRate(prior);
    let trend: SignalHealth['trend'] = 'insufficient';
    if (recent_fp != null && prior_fp != null && recent.length >= 3 && prior.length >= 3) {
      const d = recent_fp - prior_fp;
      trend = Math.abs(d) < 0.1 ? 'flat' : d < 0 ? 'improving' : 'worsening';
    }

    const reasonCounts = new Map<string, number>();
    for (const r of rows) {
      const rr = (r.reason || '').trim();
      if (rr) reasonCounts.set(rr, (reasonCounts.get(rr) || 0) + 1);
    }
    const top_reasons = [...reasonCounts.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n).slice(0, 3);

    out.push({
      signal_type, label: labelFor(signal_type), decided, valid, audit_bug, process_bug, structural_bug, routed,
      fp_rate: decided ? audit_bug / decided : 0, recent_fp_rate: recent_fp, prior_fp_rate: prior_fp, trend,
      top_reasons, healable: structural_bug > 0,
    });
  }

  // noisiest-first: highest audit-bug volume × rate on top
  out.sort((a, b) => (b.audit_bug * b.fp_rate) - (a.audit_bug * a.fp_rate) || b.audit_bug - a.audit_bug || b.decided - a.decided);
  return out;
}
