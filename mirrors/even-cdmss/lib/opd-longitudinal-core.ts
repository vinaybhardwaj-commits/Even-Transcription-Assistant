// lib/opd-longitudinal-core.ts — Stage 3 Longitudinal OPD Audit PURE substrate (opd-longitudinal/0.1).
//
// The auditor grades each note against MemberState AS OF the visit date. This core is pure/DB-free/
// LLM-free (loadable under `node --experimental-strip-types`): the D2 knowability cut, the deterministic
// L1–L3 battery, the versioned retest-interval table v0, the de-identified context-block serializer, the
// LLM-finding parser (grounding gate), and the finding builders + stamp. The WIRED sibling
// (lib/opd-longitudinal.ts) resolves the member, fetches the as-of snapshot, calls the LLM, and stores.
//
// INVARIANTS (PRD §2): No hindsight (only evidence passing the D2 cut may be cited). Informational-first
// (D4 — every finding severity 'informational', NEVER touches the 5-domain score). Frozen member-state +
// audit-score cores UNTOUCHED — this only reads their outputs. Deterministic (no Date.now here; `now`/dates
// are passed in). All findings carry provenance (cited encounterRef+date, same as engine 0.7 citations).

import type { MemberStateSnapshot } from './member-state/schema';
import type { MemberStateView } from './member-state/present-core';
import { canonicalAnalyte } from './member-state/lab-reference-ranges';
import { monthLabel } from './member-state/present-augment';
import { stampFindingIdentity, type OpdFinding } from './opd-note-audit-core';
import type { DeidOpdCase, OpdKeys } from './opd-ingest-core';

export const OPD_LONGITUDINAL_VERSION = 'opd-longitudinal/0.1' as const;

/** The 5 coarse signal types (PRD §3.3 — the fragmentation lesson is law). L4+L6 → continuity, L5 →
 *  contradiction. Kept EXACTLY these five; the label-only triage lane partitions on them. */
export const LONGITUDINAL_SIGNAL_TYPES = [
  'longitudinal_repeat_test',
  'longitudinal_med_reconciliation',
  'longitudinal_missed_followup',
  'longitudinal_continuity',
  'longitudinal_contradiction',
] as const;
export type LongitudinalSignalType = (typeof LONGITUDINAL_SIGNAL_TYPES)[number];

// ── Retest-interval table v0 (PRD §3.1 — house defaults, conservative, V-amendable) ─────────────────
// PRD families → days: HbA1c 90 · TSH 42 · lipid profile 365 · CBC 14 · LFT 30 · RFT/KFT 30 · Vit D 90 ·
// Vit B12 90 · urine routine 14. Keyed by the SAME canonical analyte id member-state uses
// (canonicalAnalyte). Families with no canonical id (LFT, urine routine, generic CBC) never match — and
// UNMATCHED ANALYTE → NO FINDING (never guess), so they simply produce nothing (PRD-honest).
export const RETEST_INTERVAL_DAYS: Record<string, number> = {
  hba1c: 90,
  tsh: 42,
  ldl_cholesterol: 365,       // lipid profile
  total_cholesterol: 365,
  hdl_cholesterol: 365,
  triglycerides: 365,
  haemoglobin: 14,            // CBC (the Hb component is what canonicalises)
  creatinine: 30,            // RFT / KFT
  vitamin_d_25oh: 90,         // Vitamin D
  vitamin_b12: 90,           // Vitamin B12
};

// ── D2 knowability cut — applyAsOfCut lives in lib/as-of-core.ts (pure temporal module; moved
//    there in Architecture Governance Slice 1 Part A so the spine never imports this file). ─────────

// ── Note projection carried from auditOpdNote → the longitudinal pass (de-identified) ────────────────
export interface LongitudinalNoteInput {
  uid: string;                       // the audited note (prescription) uid — the audited encounterRef + join key
  doctorUid: string | null;
  noteDate: string;                  // YYYY-MM-DD (the as-of date)
  engineVersion: string;             // the base audit's engine_version — the row key for the longitudinal UPDATE
  investigations: string[];          // ordered tests in THIS note
  medications: { generic?: string; brand?: string; resolvedGeneric?: string }[];
  icdCodes: string[];                // diagnosis + impression ICD codes in THIS note
  impressions: string[];             // free-text impression / diagnosis names
  isTeleconsult: boolean;
  isReferralHandoff: boolean;
  caseDigest: string;                // opdCaseText(oc) — the de-identified case the LLM already sees
}

/** Project a de-identified OPD case + keys into the compact input the longitudinal pass needs. Returns
 *  null when there is no uid/noteDate to anchor on (the pass is then skipped). PURE. */
export function buildLongitudinalInput(oc: DeidOpdCase, keys: OpdKeys, engineVersion: string, caseDigest: string): LongitudinalNoteInput | null {
  const uid = keys.uid ? String(keys.uid).trim() : '';
  const noteDate = keys.noteDate ? String(keys.noteDate).slice(0, 10) : '';
  if (!uid || !noteDate) return null;
  return {
    uid, doctorUid: keys.doctorUid ?? null, noteDate, engineVersion,
    investigations: (oc.investigations || []).map((x) => String(x)).filter(Boolean),
    medications: (oc.medications || []).map((m) => ({ generic: m.generic, brand: m.brand, resolvedGeneric: m.resolvedGeneric })),
    icdCodes: [...(oc.diagnosisCodes || []), ...(oc.impressionCodes || [])].map((c) => String(c).trim()).filter(Boolean),
    impressions: (oc.impressions || []).map((x) => String(x)).filter(Boolean),
    isTeleconsult: !!oc.isTeleconsult,
    isReferralHandoff: !!oc.isReferralHandoff,
    caseDigest,
  };
}

// ── date helpers (parse passed-in YYYY-MM-DD strings; never read the clock) ──────────────────────────
const dayOnly = (s: string | null | undefined): string => (typeof s === 'string' ? s.slice(0, 10) : '');
function daysBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  const a = Date.parse(dayOnly(from)); const b = Date.parse(dayOnly(to));
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.floor((b - a) / 86_400_000);
}
/** Normalise a medication line to a comparable primary-molecule token (lowercased, first component). */
function normMedName(raw: string | null | undefined): string {
  return String(raw ?? '').toLowerCase().split(/[+/,(]/)[0].replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Finding builder (OpdFinding shape so triage + suppression machinery apply unchanged) ─────────────
interface BuildFindingArgs {
  signalType: LongitudinalSignalType;
  subject: string;                   // "Category: detail" — the colon feeds the finding_ref detail hash
  rationale: string;
  cited: string;                     // the provenance line ("Cited: …")
  source: 'deterministic' | 'llm';
  confidence?: number;
  domain?: 'appropriateness' | 'prescribing_safety';
}
function mkFinding(a: BuildFindingArgs): OpdFinding & { signal_type: string } {
  return {
    subject: a.subject,
    verdict: 'context-dependent',     // neutral — informational findings never score (stored in the longitudinal column, not `findings`)
    confidence: a.confidence ?? 1,
    domain: a.domain ?? 'appropriateness',
    rationale: a.rationale,
    evidence: [a.cited],
    estimates: [],
    citation_ids: [],
    source: a.source,
    informational: true,              // D4 — ALWAYS informational
    signal_type: a.signalType,        // the exact longitudinal type (restored after stamping — see stampLongitudinal)
  };
}

/** Stamp finding_ref via the shared stampFindingIdentity (deterministic content hash), then RESTORE the
 *  explicit longitudinal signal_type — stampFindingIdentity unconditionally recomputes signal_type from
 *  subject/verdict (it is designed for the scored plane), so we re-apply the 5-type vocabulary after it.
 *  The finding_ref stays deterministic/stable; the final signal_type is the longitudinal one (PRD §3.3). */
export function stampLongitudinal(findings: (OpdFinding & { signal_type: string })[]): OpdFinding[] {
  const intended = findings.map((f) => f.signal_type);
  const stamped = stampFindingIdentity(findings);
  return stamped.map((f, i) => ({ ...f, signal_type: intended[i] }));
}

// ── L1 — Redundant repeat test (deterministic) ───────────────────────────────────────────────────────
/** For each analyte this note re-orders, if a prior result exists within its retest interval → finding
 *  citing the prior value + date + encounterRef. Unmatched analyte (no canonical id / no interval / no
 *  prior series) → NO finding. `snap` is the AS-OF snapshot (already cut). */
export function detectRepeatTests(input: LongitudinalNoteInput, snap: MemberStateSnapshot): (OpdFinding & { signal_type: string })[] {
  const out: (OpdFinding & { signal_type: string })[] = [];
  const seen = new Set<string>();
  for (const invRaw of input.investigations) {
    const aid = canonicalAnalyte(invRaw);
    if (!aid || seen.has(aid)) continue;
    const interval = RETEST_INTERVAL_DAYS[aid];
    if (!interval) continue;                                   // not on the house table → never guess
    const series = snap.investigations.find((iv) => canonicalAnalyte(iv.normalizedAnalyte.raw) === aid);
    if (!series || !series.series.length) continue;
    const prior = series.series[series.series.length - 1];     // date-sorted asc → latest prior
    const gap = daysBetween(prior.date, input.noteDate);
    if (gap === null || gap < 0 || gap > interval) continue;   // outside the interval → repeat is reasonable
    seen.add(aid);
    const abn = prior.abnormal ? String(prior.abnormal) : '';
    const valTxt = `${series.normalizedAnalyte.raw} ${prior.value}${series.unit ? ' ' + series.unit : ''}${abn ? `, ${abn}` : ''}`;
    out.push(mkFinding({
      signalType: 'longitudinal_repeat_test',
      subject: `Redundant repeat test: ${series.normalizedAnalyte.raw}`,
      rationale: `${series.normalizedAnalyte.raw} is re-ordered in this note. A prior result (${prior.value}${series.unit ? ' ' + series.unit : ''}) was on record ${gap} day${gap === 1 ? '' : 's'} ago — inside the ${interval}-day retest interval.`,
      cited: `Cited: ${valTxt} · ${dayOnly(prior.date)} · from ${prior.encounterRef} · retest interval ${aid} = ${interval}d`,
      source: 'deterministic',
    }));
  }
  return out;
}

// ── L2 — Medication reconciliation (deterministic) ───────────────────────────────────────────────────
/** (a) a note med matching a state medication the patient REPORTED STOPPING (stopReason set on any
 *  occurrence) → finding citing the assertion; (b) a note med that is an exact/normalized-name duplicate
 *  of an active prior prescription continued without comment → same type. Exact/normalized-name only —
 *  NO fuzzy class inference. */
export function detectMedReconciliation(input: LongitudinalNoteInput, snap: MemberStateSnapshot): (OpdFinding & { signal_type: string })[] {
  const out: (OpdFinding & { signal_type: string })[] = [];
  const noteNames = new Set(input.medications.map((m) => normMedName(m.resolvedGeneric || m.generic || m.brand)).filter(Boolean));
  if (!noteNames.size) return out;
  const seen = new Set<string>();
  for (const m of snap.medications) {
    const name = normMedName(m.normalizedConcept.raw);
    if (!name || seen.has(name) || !noteNames.has(name)) continue;
    const stopped = m.occurrences.some((o) => !!o.stopReason);
    const active = m.status === 'prescribed' || m.status === 'reported_taking' || m.status === 'administered';
    if (!stopped && !active) continue;
    seen.add(name);
    if (stopped) {
      const stop = m.occurrences.filter((o) => !!o.stopReason).slice(-1)[0];
      out.push(mkFinding({
        signalType: 'longitudinal_med_reconciliation',
        subject: `Medication reconciliation: ${m.normalizedConcept.raw} re-prescribed after reported stop`,
        rationale: `${m.normalizedConcept.raw} is re-prescribed in this note. The member previously reported stopping it, and no reconciliation of that is documented here.`,
        cited: `Cited: patient-reported stop${stop?.stopReason ? ` (${stop.stopReason})` : ''} · ${dayOnly(stop?.date)} · ${stop?.encounterRef ?? m.normalizedConcept.raw}`,
        source: 'deterministic',
        domain: 'prescribing_safety',
      }));
    } else {
      out.push(mkFinding({
        signalType: 'longitudinal_med_reconciliation',
        subject: `Medication reconciliation: ${m.normalizedConcept.raw} continued`,
        rationale: `${m.normalizedConcept.raw} is already an active prior prescription and is continued in this note without a documented reconciliation note.`,
        cited: `Cited: active prior prescription · first seen ${dayOnly(m.firstSeen)}, last ${dayOnly(m.lastSeen)}`,
        source: 'deterministic',
        domain: 'prescribing_safety',
      }));
    }
  }
  return out;
}

// ── L3-det — Unaddressed severe abnormal / open care gap (deterministic) ─────────────────────────────
/** A present-core care gap or SEVERE (critical-band) abnormal lab open as-of the visit, whose analyte is
 *  NOT re-ordered in the note AND not referenced in the note's ICD/impression text → finding. Presence
 *  check only — the acknowledgment JUDGMENT belongs to L4. */
export function detectMissedFollowups(input: LongitudinalNoteInput, view: MemberStateView): (OpdFinding & { signal_type: string })[] {
  const out: (OpdFinding & { signal_type: string })[] = [];
  const noteAnalytes = new Set(input.investigations.map((x) => canonicalAnalyte(x)).filter(Boolean));
  const noteText = [...input.investigations, ...input.impressions, ...input.icdCodes].join(' ').toLowerCase();

  type Cand = { analyteId: string; analyte: string; detail: string; date: string };
  const cands: Cand[] = [
    ...view.careGaps.map((g) => ({ analyteId: g.analyteId, analyte: g.analyte, detail: g.detail, date: g.since })),
    ...view.flaggedLabs.surfaced
      .filter((l) => l.abnormal && l.band === 'critical')
      .map((l) => ({ analyteId: l.analyteId, analyte: l.analyte, detail: `${l.analyte} severely abnormal — ${l.latestValue}${l.unit ? ' ' + l.unit : ''}`, date: l.date })),
  ];
  const seen = new Set<string>();
  for (const c of cands) {
    if (!c.analyteId || seen.has(c.analyteId)) continue;
    if (noteAnalytes.has(c.analyteId)) continue;                       // re-ordered → addressed
    const analyteWord = String(c.analyte || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3)[0] || '';
    if (analyteWord && noteText.includes(analyteWord)) continue;       // named in impression/plan → addressed
    seen.add(c.analyteId);
    out.push(mkFinding({
      signalType: 'longitudinal_missed_followup',
      subject: `Unaddressed follow-up: ${c.analyte}`,
      rationale: `${c.detail} was open as of this visit and is not addressed — no repeat order and no plan in this note.`,
      cited: `Cited: ${c.detail} · ${dayOnly(c.date)} · attention item open as-of visit`,
      source: 'deterministic',
    }));
  }
  return out;
}

/** Run the whole deterministic battery (L1 + L2 + L3-det). PURE. */
export function runDeterministicBattery(input: LongitudinalNoteInput, snap: MemberStateSnapshot, view: MemberStateView): (OpdFinding & { signal_type: string })[] {
  return [
    ...detectRepeatTests(input, snap),
    ...detectMedReconciliation(input, snap),
    ...detectMissedFollowups(input, view),
  ];
}

// ── Context-block serializer (de-identified; PRD §4 order + caps; ~1,800-token / ~7,000-char budget) ──
export interface ContextBlock { text: string; validMonths: Set<string>; encounters: number }
const CTX_CHAR_BUDGET = 7000;   // ≈ 1,800 tokens (chars/4). Truncate TAIL-first (the order below IS the priority).

/** Serialize the as-of MemberState into the de-identified LLM context block. NO member name/contact.
 *  Sections are emitted in priority order and truncated tail-first at the char budget. `validMonths` is the
 *  set of YYYY-MM the model may cite (grounding gate). */
export function serializeContextBlock(snap: MemberStateSnapshot, view: MemberStateView): ContextBlock {
  const validMonths = new Set<string>();
  const noteMonth = (d: string) => { const m = dayOnly(d).slice(0, 7); if (/^\d{4}-\d{2}$/.test(m)) validMonths.add(m); };

  const sections: string[] = [];
  const enc = snap.sourceEncounterRefs.length;

  // header
  sections.push(`AS-OF MEMBER STATE (reconstructed as of ${dayOnly(snap.asOf)}; only evidence dated BEFORE the visit; this visit's own orders excluded).`);
  sections.push(`Picture: ${enc} prior encounter${enc === 1 ? '' : 's'} · last on record ${monthLabel(snap.asOf)} · confidence ${confidenceFor(enc)}.`);

  // attention items
  if (view.attentionFlags.length) {
    sections.push('Attention:');
    for (const a of view.attentionFlags.slice(0, 6)) sections.push(`  - [${a.severity}] ${a.text}`);
  }
  // problems ≤8
  if (view.problems.length) {
    sections.push('Active / documented problems:');
    for (const p of view.problems.slice(0, 8)) { noteMonth(p.last); sections.push(`  - ${p.label}${p.code ? ` (${p.code})` : ''} — ${p.status.label}, ${p.course.label.toLowerCase()}, last ${p.dateLabel}`); }
  }
  // meds ≤10 + stops
  if (view.medications.length) {
    sections.push('Active medications:');
    for (const m of view.medications.slice(0, 10)) { noteMonth(m.last); sections.push(`  - ${m.concept} — ${m.currentness.label}${m.latestDose ? `, ${m.latestDose}` : ''} (last ${dayOnly(m.last)})`); }
  }
  // abnormal / trend labs ≤8
  if (view.flaggedLabs.surfaced.length) {
    sections.push('Abnormal / trending labs:');
    for (const l of view.flaggedLabs.surfaced.slice(0, 8)) { noteMonth(l.date); sections.push(`  - ${l.analyte} ${l.latestValue}${l.unit ? ' ' + l.unit : ''} — ${l.band}${l.direction ? `, ${l.direction}` : ''} (${dayOnly(l.date)})`); }
  }
  // open care gaps
  if (view.careGaps.length) {
    sections.push('Open care gaps:');
    for (const g of view.careGaps.slice(0, 6)) { noteMonth(g.since); sections.push(`  - ${g.analyte}: ${g.detail}`); }
  }
  // PROM baselines (folded scores present as investigations named 'prom:*')
  const proms = snap.investigations.filter((iv) => /^prom:/i.test(iv.normalizedAnalyte.raw));
  if (proms.length) {
    sections.push('PROM baselines:');
    for (const p of proms.slice(0, 4)) { const last = p.series[p.series.length - 1]; noteMonth(last?.date); sections.push(`  - ${p.normalizedAnalyte.raw.replace(/^prom:/i, '')} ${last?.value ?? ''} (${dayOnly(last?.date)})`); }
  }
  // last-3-encounter one-liners (from occurrence dates across the snapshot)
  const byDate = new Map<string, string[]>();
  const push = (d: string, s: string) => { const k = dayOnly(d); if (!k) return; const a = byDate.get(k) ?? []; if (a.length < 4 && !a.includes(s)) a.push(s); byDate.set(k, a); };
  for (const p of snap.problems) for (const o of p.occurrences) push(o.date, view.problems.find((v) => v.concept === p.normalizedConcept.raw)?.label ?? p.normalizedConcept.raw);
  for (const iv of snap.investigations) for (const s of iv.series) push(s.date, `${iv.normalizedAnalyte.raw} ${s.value}`);
  for (const m of snap.medications) for (const o of m.occurrences) push(o.date, m.normalizedConcept.raw);
  const recent = [...byDate.keys()].sort().reverse().slice(0, 3);
  if (recent.length) {
    sections.push('Last encounters:');
    for (const d of recent) { noteMonth(d); sections.push(`  - ${d}: ${(byDate.get(d) ?? []).join(', ')}`); }
  }

  // assemble under budget, truncate tail-first
  let text = '';
  for (const line of sections) {
    if (text.length + line.length + 1 > CTX_CHAR_BUDGET) break;
    text += (text ? '\n' : '') + line;
  }
  return { text, validMonths, encounters: enc };
}

// ── LLM pass (L4/L5/L6) — build the instruction + parse/ground the response ──────────────────────────
/** The focused system prompt for the judged dimensions. Selection of state assertions only — each finding
 *  MUST cite a state-evidence date present in the context or it is DROPPED. Encounter-context aware. */
export const LONGITUDINAL_LLM_SYSTEM = [
  'You are a longitudinal continuity auditor. You are given (1) a de-identified reconstruction of a member\'s',
  'clinical state AS OF a visit date (prior evidence only) and (2) the de-identified note written at that visit.',
  'Judge ONLY three things, and ONLY from the state provided — never invent facts:',
  '  L4 CONTINUITY — does the note acknowledge the active problems relevant to this encounter?',
  '  L5 CONTRADICTION — does the note assert something the record contradicts (e.g. "no known comorbidities"',
  '      vs documented active diabetes)?',
  '  L6 TRAJECTORY — for a repeat presentation of the same problem, is the assessment trajectory-aware?',
  'Encounter-context fairness: a teleconsult or a referral/handoff encounter, and unrelated minor acute visits,',
  'owe LESS continuity — judge them leniently and say so. Do NOT penalise an appropriate focused visit.',
  'Every finding MUST cite at least one specific date (YYYY-MM-DD) that appears in the state context. A finding',
  'you cannot ground in a cited state date will be discarded. If nothing qualifies, return an empty list.',
  'Output STRICT JSON only, no prose, no markdown:',
  '{ "findings": [ { "signal_type": "longitudinal_continuity" | "longitudinal_contradiction",',
  '                 "subject": "<short label>", "rationale": "<one or two sentences>",',
  '                 "cited_dates": ["YYYY-MM-DD", ...], "confidence": <0..1> } ] }',
  '- Use longitudinal_contradiction for L5; use longitudinal_continuity for L4 and L6.',
].join('\n');

/** Build the user message: the state context block + the note digest + the encounter-context reminder. */
export function buildLongitudinalUser(ctx: ContextBlock, input: LongitudinalNoteInput): string {
  const guard = input.isTeleconsult
    ? 'Encounter modality: TELECONSULT (remote) — judge continuity leniently.'
    : input.isReferralHandoff
      ? 'Disposition: REFERRAL / HANDOFF — the plan is the onward referral; judge continuity leniently.'
      : 'Encounter modality: in-person definitive visit.';
  return [
    '=== MEMBER STATE AS OF THE VISIT (prior evidence only) ===',
    ctx.text,
    '',
    '=== THIS NOTE (de-identified) ===',
    guard,
    input.caseDigest,
  ].join('\n');
}

interface RawLlmFinding { signal_type?: unknown; subject?: unknown; rationale?: unknown; cited_dates?: unknown; confidence?: unknown }

/** Parse the LLM JSON and KEEP only findings grounded in a cited state date (YYYY-MM present in the
 *  context). Coerces signal_type into the 2 judged types. Ungrounded / malformed → dropped. PURE. */
export function parseLongitudinalLlm(text: string, validMonths: Set<string>): (OpdFinding & { signal_type: string })[] {
  let obj: Record<string, unknown> | null = null;
  try {
    let s = String(text || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const a = s.indexOf('{'); const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    obj = JSON.parse(s) as Record<string, unknown>;
  } catch { return []; }
  const rawF = obj && Array.isArray(obj.findings) ? (obj.findings as RawLlmFinding[]) : [];
  const out: (OpdFinding & { signal_type: string })[] = [];
  for (const r of rawF) {
    const subject = String(r?.subject ?? '').trim();
    const rationale = String(r?.rationale ?? '').trim();
    if (!subject || !rationale) continue;
    const dates = Array.isArray(r?.cited_dates) ? (r.cited_dates as unknown[]).map((d) => dayOnly(String(d))) : [];
    const grounded = dates.filter((d) => validMonths.has(d.slice(0, 7)));
    if (!grounded.length) continue;                                   // NO-HINDSIGHT / grounding gate — drop ungrounded
    const isContra = String(r?.signal_type ?? '').includes('contradiction');
    const conf = Number(r?.confidence);
    out.push(mkFinding({
      signalType: isContra ? 'longitudinal_contradiction' : 'longitudinal_continuity',
      subject: `${isContra ? 'Note contradicts the record' : 'Continuity of care'}: ${subject}`,
      rationale,
      cited: `Cited: state assertions · ${grounded.join(', ')}`,
      source: 'llm',
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.6,
      domain: 'appropriateness',
    }));
  }
  return out;
}

// ── The stored block ─────────────────────────────────────────────────────────────────────────────────
export type LongitudinalExcludedReason =
  | 'no_prior_history' | 'member_unresolved' | 'context_fetch_failed' | 'low_confidence_state' | 'llm_failed' | null;
export type LongitudinalConfidence = 'established' | 'thin' | 'none';

export interface LongitudinalContextMeta { encounters: number; confidence: LongitudinalConfidence; excluded_reason: LongitudinalExcludedReason }
export interface LongitudinalBlock {
  version: typeof OPD_LONGITUDINAL_VERSION;
  asOf: string;
  contextMeta: LongitudinalContextMeta;
  findings: OpdFinding[];
}

/** An empty block (battery skipped / degraded) — carries the honest excluded_reason, zero findings. */
export function emptyLongitudinalBlock(asOf: string, encounters: number, confidence: LongitudinalConfidence, reason: LongitudinalExcludedReason): LongitudinalBlock {
  return { version: OPD_LONGITUDINAL_VERSION, asOf: dayOnly(asOf), contextMeta: { encounters, confidence, excluded_reason: reason }, findings: [] };
}

/** Encounter-count → the confidence bucket that drives the D5c list indicator and the L4–L6 gate.
 *  (A SIMPLIFICATION vs present-core's full PictureConfidence, which needs vitals/modality unavailable in
 *  the audit pass — flagged in the report. established ⇒ full battery; thin ⇒ deterministic only; none ⇒
 *  no prior history.) */
export function confidenceFor(encounters: number): LongitudinalConfidence {
  return encounters >= 3 ? 'established' : encounters >= 1 ? 'thin' : 'none';
}
