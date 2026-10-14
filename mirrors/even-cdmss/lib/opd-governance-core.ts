/**
 * lib/opd-governance-core.ts — pure governance-signal engine over PDQI-9 aggregates.
 *
 * Turns a window's per-attribute means (+ prior-window baseline + per-doctor means)
 * into ranked, scope-aware CLINICAL-GOVERNANCE signals: what to do with / say to the
 * OPD doctors — huddle briefings, documentation norms, supportive 1:1s. This is the
 * governance-team counterpart of the (removed) EMR-design "raise it" cues; EMR capture
 * affordances live in the standalone design report, not here.
 *
 * Pure + deterministic: no imports, no I/O. Unit-tested. Consumed by
 * /api/governance/opd-signals (API-first — the view ships in the governance app later).
 */

export type GovAttrStat = { attr: string; mean: number; n: number };
export type GovDoctorStat = { uid: string; name?: string; attrs: Record<string, { mean: number; n: number }> };

export type GovThresholds = {
  signalBelow: number;      // fire a signal when the window mean is below this (default 3.5)
  actNowBelow: number;      // 'act_now' severity below this (default 2.5)
  trendDelta: number;       // |delta| vs prior window to call improving/worsening (default 0.3)
  doctorMinNotes: number;   // a doctor needs ≥ this many assessed notes to count (default 3)
  doctorLowBelow: number;   // a doctor is 'affected' when their attr mean is below this (default 3.0)
  systemicShare: number;    // affected share ≥ this ⇒ systemic (default 0.5)
  concentratedMax: number;  // affected count ≤ this (and share < systemicShare) ⇒ concentrated (default 5)
  minEligibleDoctors: number; // need ≥ this many eligible doctors to judge scope (default 3)
};
export const GOV_DEFAULT_THRESHOLDS: GovThresholds = {
  signalBelow: 3.5, actNowBelow: 2.5, trendDelta: 0.3,
  doctorMinNotes: 3, doctorLowBelow: 3.0, systemicShare: 0.5, concentratedMax: 5, minEligibleDoctors: 3,
};

export type GovScope = 'systemic' | 'concentrated' | 'mixed' | 'insufficient_data';
export type GovSignal = {
  attr: string; label: string; definition: string;
  mean: number; n: number;
  severity: 'act_now' | 'watch';
  trend: 'improving' | 'worsening' | 'flat' | 'no_baseline';
  delta: number | null;
  scope: GovScope;
  eligible_doctors: number;
  affected_share: number | null;       // affected / eligible (null when insufficient data)
  affected: { uid: string; name?: string; mean: number; n: number }[]; // worst first, capped at concentratedMax
  action: string;                       // the governance action, scope-appropriate
};
export type GovReport = {
  signals: GovSignal[];                 // act_now first, then mean ascending
  healthy: { attr: string; label: string; mean: number; n: number }[];
  thresholds: GovThresholds;
};

// ── PDQI-9 attribute meta: label + auditor definition + governance actions ──────
// `systemic` = whole-OPD action (huddle briefing / documentation norm / spot-audit).
// `concentrated` = targeted supportive action; '{doctors}' is replaced with the named list.
// Wording approved by V (2 Jul 2026) — clinical-governance voice, not EMR-design voice.
export const PDQI9_GOV: Record<string, { label: string; def: string; systemic: string; concentrated: string }> = {
  up_to_date: {
    label: 'Up-to-date',
    def: 'Reflects the current picture — today’s medications, latest results and status — not stale content carried forward from a past visit.',
    systemic: 'Huddle brief: reconcile current medications and latest results at every visit; call out copied-forward content as this week’s audit focus and re-measure in a week.',
    concentrated: 'Supportive 1:1s with {doctors} — review two of their own notes showing carried-forward content; agree a reconcile-at-visit habit; re-check in 2 weeks.',
  },
  accurate: {
    label: 'Accurate',
    def: 'Factually correct — values, medications and history match reality, with no contradictions or copy-paste errors.',
    systemic: 'Spot-audit transcription accuracy (vitals/labs vs source) on a sample of notes; brief verify-before-sign in huddle; escalate only if mismatches confirm.',
    concentrated: 'Verify-before-sign conversation with {doctors}, using mismatch examples from their own notes; re-audit their next week of notes.',
  },
  thorough: {
    label: 'Thorough',
    def: 'Covers what’s relevant — the complaint, pertinent history, comorbidities and key positive/negative findings — not just the headline issue.',
    systemic: 'Make pertinent negatives + comorbidities this week’s huddle teaching point; circulate a one-page exemplar HPI from a high-scoring doctor and re-measure next week.',
    concentrated: 'Targeted feedback with {doctors} — walk through one thin HPI of theirs against the exemplar; agree the minimum history set for their common presentations.',
  },
  useful: {
    label: 'Useful',
    def: 'Gives the next clinician what they need to act — a clear plan and the reasoning behind it.',
    systemic: 'Set a minimum actionable-plan norm: working diagnosis, plan and safety-net advice on every note; announce in huddle and audit compliance next week.',
    concentrated: 'Ask {doctors} the next-clinician test on two of their own notes — “could a colleague act on this tomorrow?” — and agree the missing plan elements.',
  },
  organized: {
    label: 'Organized',
    def: 'Logical, consistent structure — information sits where you expect it and the note is easy to scan.',
    systemic: 'Agree a SOAP-style section order as the OPD documentation norm; show a before/after pair in huddle.',
    concentrated: 'Share a well-organised exemplar with {doctors} and agree a consistent section order for their notes.',
  },
  comprehensible: {
    label: 'Comprehensible',
    def: 'Clear and readable to another clinician — minimal ambiguous shorthand or unexplained abbreviations.',
    systemic: 'Publish the top ambiguous abbreviations found in this window’s audits and brief doctors to spell them out.',
    concentrated: 'Show {doctors} their own ambiguous shorthand examples and agree replacements.',
  },
  succinct: {
    label: 'Succinct',
    def: 'Concise — the clinical signal isn’t buried under boilerplate or repetition.',
    systemic: 'Identify boilerplate/template walls-of-text and trim at source; brief in huddle that signal beats volume.',
    concentrated: 'Show {doctors} one of their notes against a succinct exemplar; agree what boilerplate to drop.',
  },
  synthesized: {
    label: 'Synthesized',
    def: 'Pulls the data together into the clinician’s reasoning — a coherent assessment/impression, not just a list of findings.',
    systemic: 'Set a documentation norm: every note carries a one-line assessment linking findings → diagnosis → plan; teach with two examples in huddle and audit next week.',
    concentrated: '1:1 coaching with {doctors} on documenting clinical reasoning — findings → diagnosis → plan in one line, practised on their own recent notes.',
  },
  internally_consistent: {
    label: 'Internally consistent',
    def: 'No internal contradictions — the diagnosis, medications and plan all line up with each other.',
    systemic: 'Brief a final read-through before signing — does diagnosis ↔ drugs ↔ plan line up; audit alignment on a sample of this week’s notes.',
    concentrated: 'Review mismatched examples with {doctors}; check whether it is a template artefact before treating it as a practice gap.',
  },
};
export const PDQI9_GOV_ORDER = [
  'up_to_date', 'accurate', 'thorough', 'useful', 'organized',
  'comprehensible', 'succinct', 'synthesized', 'internally_consistent',
];

const round1 = (x: number) => Math.round(x * 10) / 10;

function fmtDoctors(list: { name?: string; uid: string; mean: number; n: number }[]): string {
  return list.map((d) => `${d.name || 'Dr · ' + d.uid.slice(0, 6)} (${round1(d.mean)}, ${d.n} notes)`).join(', ');
}

/**
 * Compute ranked governance signals for one window.
 * - severity: mean < actNowBelow ⇒ act_now; < signalBelow ⇒ watch; else healthy (no signal).
 * - trend: vs prior-window mean, ±trendDelta.
 * - scope: among doctors with ≥ doctorMinNotes assessed notes, share with attr mean < doctorLowBelow.
 *   ≥ systemicShare ⇒ systemic · (share < systemicShare AND count ≤ concentratedMax) ⇒ concentrated ·
 *   otherwise mixed · fewer than minEligibleDoctors eligible ⇒ insufficient_data (systemic wording).
 */
export function computeGovernanceSignals(input: {
  current: GovAttrStat[];
  prior?: Record<string, number>;
  doctors?: GovDoctorStat[];
  thresholds?: Partial<GovThresholds>;
}): GovReport {
  const t: GovThresholds = { ...GOV_DEFAULT_THRESHOLDS, ...(input.thresholds || {}) };
  const prior = input.prior || {};
  const doctors = input.doctors || [];
  const signals: GovSignal[] = [];
  const healthy: GovReport['healthy'] = [];

  for (const attr of PDQI9_GOV_ORDER) {
    const stat = input.current.find((s) => s.attr === attr);
    if (!stat || stat.n === 0) continue;
    const meta = PDQI9_GOV[attr];
    const mean = round1(stat.mean);

    if (mean >= t.signalBelow) { healthy.push({ attr, label: meta.label, mean, n: stat.n }); continue; }

    const severity: GovSignal['severity'] = mean < t.actNowBelow ? 'act_now' : 'watch';

    const base = prior[attr];
    let trend: GovSignal['trend'] = 'no_baseline';
    let delta: number | null = null;
    if (Number.isFinite(base)) {
      delta = round1(mean - (base as number));
      trend = delta <= -t.trendDelta ? 'worsening' : delta >= t.trendDelta ? 'improving' : 'flat';
    }

    const eligible = doctors.filter((d) => (d.attrs[attr]?.n ?? 0) >= t.doctorMinNotes);
    const affectedAll = eligible
      .filter((d) => d.attrs[attr].mean < t.doctorLowBelow)
      .map((d) => ({ uid: d.uid, name: d.name, mean: round1(d.attrs[attr].mean), n: d.attrs[attr].n }))
      .sort((a, b) => a.mean - b.mean);

    let scope: GovScope;
    let share: number | null = null;
    if (eligible.length < t.minEligibleDoctors) {
      scope = 'insufficient_data';
    } else {
      share = Math.round((affectedAll.length / eligible.length) * 100) / 100;
      scope = share >= t.systemicShare ? 'systemic'
        : affectedAll.length > 0 && affectedAll.length <= t.concentratedMax ? 'concentrated'
          : 'mixed';
    }
    const affected = affectedAll.slice(0, t.concentratedMax);

    const action = scope === 'concentrated'
      ? meta.concentrated.replace('{doctors}', fmtDoctors(affected))
      : scope === 'mixed'
        ? `${meta.systemic} Start with the lowest-scoring doctors: ${fmtDoctors(affected.slice(0, 3))}.`
        : meta.systemic; // systemic + insufficient_data both get the hospital-level action

    signals.push({
      attr, label: meta.label, definition: meta.def, mean, n: stat.n,
      severity, trend, delta, scope,
      eligible_doctors: eligible.length, affected_share: share, affected, action,
    });
  }

  signals.sort((a, b) => (a.severity === b.severity ? a.mean - b.mean : a.severity === 'act_now' ? -1 : 1));
  healthy.sort((a, b) => b.mean - a.mean);
  return { signals, healthy, thresholds: t };
}

// ═══════════════════════════════════════════════════════════════════════════════
// v1.1b — DOMAIN-level signals (documentation completeness, prescribing safety,
// interaction alerts; low-value HELD until LL.3 calibration). Same signal grammar,
// different metrics: each domain declares its unit, direction and thresholds.
// Emitted with `kind: 'domain'` (PDQI signals stay unmarked) — additive for v1.0/1.1
// consumers. Action wording approved by V (2 Jul 2026, v1.1b draft).
// ═══════════════════════════════════════════════════════════════════════════════

export type GovDomainKey = 'documentation_completeness' | 'prescribing_safety' | 'interaction_alerts' | 'low_value_rate';
export type GovDomainMeta = {
  label: string; def: string;
  unit: 'pct' | 'score' | 'per_100_notes';
  direction: 'lower_worse' | 'higher_worse';
  signalAt: number; actNowAt: number; trendDelta: number; doctorAffectedAt: number;
  systemic: string; concentrated: string;
  held?: boolean; // excluded unless includeHeld — ships only as confidence:'estimate'
};

export const DOMAIN_GOV: Record<GovDomainKey, GovDomainMeta> = {
  documentation_completeness: {
    label: 'Documentation completeness',
    def: 'Share of the NABH-OPD mandatory documentation items present on the note — measured deterministically on every note.',
    unit: 'pct', direction: 'lower_worse', signalAt: 90, actNowAt: 75, trendDelta: 3, doctorAffectedAt: 85,
    systemic: 'Huddle brief on this window’s top documentation gap — {top_gap} — and restate the seven NABH-OPD mandatory items as the documentation floor; re-measure next week.',
    concentrated: 'Supportive 1:1s with {doctors} — walk two of their own notes against the NABH-OPD checklist; agree which fields they’ll close; re-check in 2 weeks.',
  },
  prescribing_safety: {
    label: 'Prescribing safety',
    def: 'Rational, safe prescribing — complete dosing, no same-class duplication, no irrational or unsafe drugs (deterministic rules + AI checks).',
    unit: 'score', direction: 'lower_worse', signalAt: 70, actNowAt: 55, trendDelta: 5, doctorAffectedAt: 60,
    systemic: 'Huddle brief on rational prescribing — complete dosing (dose · frequency · duration · route) and no same-class duplication; publish this window’s top prescribing gap ({top_gap}); pharmacist spot-reviews a sample next week.',
    concentrated: 'Prescribing 1:1s with {doctors} alongside the pharmacist — review their flagged prescriptions together; agree corrections; re-audit in 2 weeks.',
  },
  interaction_alerts: {
    label: 'Interaction alerts',
    def: 'Possible drug–drug interactions flagged per 100 audited notes (deterministic DDI screen over formulary-resolved medications).',
    unit: 'per_100_notes', direction: 'higher_worse', signalAt: 10, actNowAt: 25, trendDelta: 5, doctorAffectedAt: 25,
    systemic: 'Circulate this window’s most frequent flagged pairs ({top_pairs}) to all OPD doctors; ask for documented justification-or-switch when co-prescribing them; re-measure next week.',
    concentrated: 'Case-based review with {doctors} and the pharmacist — confirm true positives among their flagged prescriptions; document rationale or switch; re-check in 2 weeks.',
  },
  low_value_rate: {
    label: 'Low-value care',
    def: 'Share of notes carrying at least one low-value–care flag (Choosing-Wisely / RAND lens). CALIBRATION PENDING (LL.3) — flags over-fire; treat as an estimate.',
    unit: 'per_100_notes', direction: 'higher_worse', signalAt: 50, actNowAt: 75, trendDelta: 5, doctorAffectedAt: 75,
    systemic: 'Choosing-Wisely huddle on this window’s top low-value pattern ({top_pattern}), presented with the audit’s evidence citations; agree a department norm.',
    concentrated: 'Peer-comparison conversation with {doctors} — their low-value rate vs department peers and the specific flagged orders; explore clinical rationale first. Calibration is ongoing: treat flags as prompts, not verdicts.',
    held: true,
  },
};
export const DOMAIN_GOV_ORDER: GovDomainKey[] = ['documentation_completeness', 'prescribing_safety', 'interaction_alerts', 'low_value_rate'];

export type GovDomainSignal = {
  kind: 'domain';
  metric: GovDomainKey; label: string; definition: string;
  value: number; unit: GovDomainMeta['unit']; n: number;
  severity: 'act_now' | 'watch';
  trend: 'improving' | 'worsening' | 'flat' | 'no_baseline';
  delta: number | null;
  scope: GovScope;
  eligible_doctors: number;
  affected_share: number | null;
  affected: { uid: string; name?: string; value: number; n: number }[];
  action: string;
  confidence?: 'estimate'; // present on held metrics shipped early
};
export type GovDomainDoctorStat = { uid: string; name?: string; values: Partial<Record<GovDomainKey, { value: number; n: number }>> };

/** Direction-aware "is this bad enough" comparisons. */
const worseThan = (dir: GovDomainMeta['direction'], value: number, threshold: number) =>
  dir === 'lower_worse' ? value < threshold : value >= threshold;

/**
 * Compute domain-level governance signals. Same scope grammar as PDQI (systemic /
 * concentrated / mixed / insufficient_data over eligible doctors), but severity and
 * trend respect each metric's direction. `placeholders` supplies window-derived
 * strings for {top_gap}/{top_pairs}/{top_pattern}; missing ones get a neutral fallback.
 */
export function computeDomainSignals(input: {
  domains: { key: GovDomainKey; value: number; n: number }[];
  prior?: Partial<Record<GovDomainKey, number>>;
  doctors?: GovDomainDoctorStat[];
  placeholders?: Partial<Record<'top_gap_documentation' | 'top_gap_prescribing' | 'top_pairs' | 'top_pattern', string>>;
  includeHeld?: boolean;
  thresholds?: Partial<Pick<GovThresholds, 'doctorMinNotes' | 'systemicShare' | 'concentratedMax' | 'minEligibleDoctors'>>;
}): { signals: GovDomainSignal[]; healthy: { metric: GovDomainKey; label: string; value: number; unit: GovDomainMeta['unit']; n: number }[] } {
  const t = { ...GOV_DEFAULT_THRESHOLDS, ...(input.thresholds || {}) };
  const prior = input.prior || {};
  const doctors = input.doctors || [];
  const ph = input.placeholders || {};
  const signals: GovDomainSignal[] = [];
  const healthy: { metric: GovDomainKey; label: string; value: number; unit: GovDomainMeta['unit']; n: number }[] = [];

  for (const key of DOMAIN_GOV_ORDER) {
    const meta = DOMAIN_GOV[key];
    if (meta.held && !input.includeHeld) continue;
    const stat = input.domains.find((d) => d.key === key);
    if (!stat || stat.n === 0) continue;
    const value = round1(stat.value);

    if (!worseThan(meta.direction, value, meta.signalAt)) { healthy.push({ metric: key, label: meta.label, value, unit: meta.unit, n: stat.n }); continue; }
    const severity: GovDomainSignal['severity'] = worseThan(meta.direction, value, meta.actNowAt) ? 'act_now' : 'watch';

    const base = prior[key];
    let trend: GovDomainSignal['trend'] = 'no_baseline';
    let delta: number | null = null;
    if (Number.isFinite(base)) {
      delta = round1(value - (base as number));
      const gotWorse = meta.direction === 'lower_worse' ? delta <= -meta.trendDelta : delta >= meta.trendDelta;
      const gotBetter = meta.direction === 'lower_worse' ? delta >= meta.trendDelta : delta <= -meta.trendDelta;
      trend = gotWorse ? 'worsening' : gotBetter ? 'improving' : 'flat';
    }

    const eligible = doctors.filter((d) => (d.values[key]?.n ?? 0) >= t.doctorMinNotes);
    const affectedAll = eligible
      .filter((d) => worseThan(meta.direction, d.values[key]!.value, meta.doctorAffectedAt))
      .map((d) => ({ uid: d.uid, name: d.name, value: round1(d.values[key]!.value), n: d.values[key]!.n }))
      .sort((a, b) => (meta.direction === 'lower_worse' ? a.value - b.value : b.value - a.value));

    let scope: GovScope;
    let share: number | null = null;
    if (eligible.length < t.minEligibleDoctors) {
      scope = 'insufficient_data';
    } else {
      share = Math.round((affectedAll.length / eligible.length) * 100) / 100;
      scope = share >= t.systemicShare ? 'systemic'
        : affectedAll.length > 0 && affectedAll.length <= t.concentratedMax ? 'concentrated'
          : 'mixed';
    }
    const affected = affectedAll.slice(0, t.concentratedMax);
    const fmtDocs = affected.map((d) => `${d.name || 'Dr · ' + d.uid.slice(0, 6)} (${d.value}, ${d.n} notes)`).join(', ');

    const topGap = key === 'documentation_completeness' ? (ph.top_gap_documentation || 'the top gap in this window')
      : key === 'prescribing_safety' ? (ph.top_gap_prescribing || 'the top gap in this window') : '';
    let action = scope === 'concentrated'
      ? meta.concentrated.replace('{doctors}', fmtDocs)
      : scope === 'mixed'
        ? `${meta.systemic} Start with the most affected doctors: ${affected.slice(0, 3).map((d) => `${d.name || 'Dr · ' + d.uid.slice(0, 6)} (${d.value}, ${d.n} notes)`).join(', ')}.`
        : meta.systemic;
    action = action
      .replace('{top_gap}', topGap)
      .replace('{top_pairs}', ph.top_pairs || 'the most frequent flagged pairs in this window')
      .replace('{top_pattern}', ph.top_pattern || 'the top flagged pattern in this window');

    signals.push({
      kind: 'domain', metric: key, label: meta.label, definition: meta.def,
      value, unit: meta.unit, n: stat.n,
      severity, trend, delta, scope,
      eligible_doctors: eligible.length, affected_share: share, affected, action,
      ...(meta.held ? { confidence: 'estimate' as const } : {}),
    });
  }

  signals.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'act_now' ? -1 : 1));
  return { signals, healthy };
}
