/**
 * lib/ipd-audit/stay-material.ts — PURE composition of the STAY PICTURE that the stay-level auditor
 * shows the engine (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P3 / §5, O11).
 *
 * WHAT CHANGES AT P3, AND WHAT DOES NOT. The IPD auditor has read one document since it shipped: the
 * discharge-summary PDF. P3 widens the MATERIAL to the whole stay — the P2 `clinical_states` library
 * — and changes the engine not at all. The block below is threaded through `analyzeCase`'s existing
 * `clinicalStateText` seam, which is optional and additive by construction: omit it and the prompt is
 * byte-identical to the one `ipd-discharge-audit/0.2` sends. The discharge summary becomes one
 * document among several rather than the whole audit (§5), and the PDF path is untouched.
 *
 * THE ONE THING THIS FILE EXISTS TO PREVENT. §5: "The auditor never claims 'clean theatre' from a
 * missing OT note." A model handed a list of documents it CAN see will, unprompted, read the gaps as
 * negatives — that is the single most likely way this slice produces a false clinical claim. So the
 * absence of a class is not silence here: every class is named in the block whether or not it was
 * found, an unavailable class is labelled NOT AVAILABLE with the P2 reason attached, and the block
 * carries an explicit instruction on how to read one. The instruction is not decoration; it is the
 * clinical safety property of P3, and a test asserts every part of it survives composition.
 *
 * The same coverage is returned as structured data so it can be STORED on the audit report and
 * rendered on the case page — "a stay with a missing document class shows not_auditable for that
 * class in the audit output" (§5) is about what the audit says, not only about what the model saw.
 *
 * PURE: no DB, no model, no clock, no I/O.
 */
import type { ClinicalState } from '../clinical-state/schema';
import {
  DOC_KINDS, DOC_KIND_LABEL, DOC_KIND_SOURCE, NOT_AUDITABLE_COPY, STAY_LIBRARY_VERSION,
  procedureFactsOf,
  type DocKind, type NotAuditableReason, type StayDocStatus,
} from '../stay-library/core';

/** The stay auditor's engine version — named, new, and never written onto a 0.2 row (O11). */
export const IPD_STAY_ENGINE_VERSION = 'ipd-stay-audit/0.1';

/** One document as the composer needs it. Satisfied by both a freshly built doc and a stored row. */
export interface StayLibraryDoc {
  docKind: DocKind;
  status: StayDocStatus;
  reason?: NotAuditableReason;
  state: ClinicalState;
}

export interface StayClassCoverage {
  docKind: DocKind;
  label: string;
  status: StayDocStatus;
  reason?: NotAuditableReason;
  /** How many readable documents of this class the audit saw. Zero when not_auditable. */
  count: number;
  /** Plain words, stored and rendered — never a code. */
  copy: string;
}

/** What the audit STORES about its own coverage, so the case page and any later reader can see
 *  which classes were never available rather than inferring it from an absence of findings. */
export interface StayCoverageBlock {
  libraryVersion: string;
  engineVersion: string;
  classes: StayClassCoverage[];
  documentsRead: number;
  /** True when at least one class could not be read. Drives the honest banner on the case page. */
  incomplete: boolean;
}

/**
 * THE INSTRUCTION. Stated once, here, so the prompt and the tests read the same words.
 *
 * It is deliberately specific about the four wrong conclusions rather than a general "be careful":
 * a general caution is easy to satisfy and easy to ignore, whereas "never write that theatre was
 * clean because the OT note is missing" is a sentence a reviewer can check an answer against.
 */
export const STAY_ABSENCE_INSTRUCTION =
  'HOW TO READ A CLASS MARKED NOT AVAILABLE: it means this audit did not see that document. It is NOT evidence that the event did not happen. Never write that theatre was clean, that no operation took place, that no drug was given, or that a check was not done, because its document is missing. Where a judgement depends on a class marked NOT AVAILABLE, say that the record does not show it and do not score it.';

/** Read one string off a state's surfaceExtras without pretending to know the whole shape. */
function extra(state: ClinicalState, key: string): string | null {
  const v = (state.surfaceExtras as Record<string, unknown> | undefined)?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function otFactsOf(state: ClinicalState): Array<{ label: string; value: string }> {
  const v = (state.surfaceExtras as Record<string, unknown> | undefined)?.otFacts;
  if (!Array.isArray(v)) return [];
  return v
    .map((f) => (f && typeof f === 'object' ? f as Record<string, unknown> : {}))
    .map((f) => ({ label: String(f.label ?? f.name ?? ''), value: String(f.value ?? '') }))
    .filter((f) => f.label && f.value);
}

/** Per-class coverage, in a fixed class order so a stored block is comparable across stays. */
export function stayCoverage(documents: readonly StayLibraryDoc[]): StayCoverageBlock {
  const classes: StayClassCoverage[] = DOC_KINDS.map((docKind) => {
    const mine = documents.filter((d) => d.docKind === docKind);
    const ok = mine.filter((d) => d.status === 'ok');
    if (ok.length) {
      return {
        docKind, label: DOC_KIND_LABEL[docKind], status: 'ok' as const, count: ok.length,
        copy: `${ok.length} document${ok.length === 1 ? '' : 's'} read`,
      };
    }
    // No readable document. The REASON is the P2 row's, not a guess — and when the class produced
    // no row at all (a stay built before this class existed), the honest default is `absent`.
    const reason = mine[0]?.reason ?? 'absent';
    return {
      docKind, label: DOC_KIND_LABEL[docKind], status: 'not_auditable' as const, reason, count: 0,
      copy: NOT_AUDITABLE_COPY[reason],
    };
  });
  return {
    libraryVersion: STAY_LIBRARY_VERSION,
    engineVersion: IPD_STAY_ENGINE_VERSION,
    classes,
    documentsRead: classes.reduce((n, c) => n + c.count, 0),
    incomplete: classes.some((c) => c.status === 'not_auditable'),
  };
}

/**
 * The STAY PICTURE block, or `''` when the library holds nothing readable at all.
 *
 * Returning empty on an empty library is deliberate: with no block, `analyzeCase` sends exactly the
 * prompt `ipd-discharge-audit/0.2` sends, so a stay whose library never built degrades to today's
 * discharge-only audit rather than to an audit told it has a stay it does not have.
 */
export function composeStayMaterial(documents: readonly StayLibraryDoc[]): { text: string; coverage: StayCoverageBlock } {
  const coverage = stayCoverage(documents);
  if (!coverage.documentsRead) return { text: '', coverage };

  const lines: string[] = [
    'STAY PICTURE — this audit read the whole admission, not only the discharge summary. Judge the STAY.',
    '',
    'WHAT WAS AVAILABLE, BY DOCUMENT CLASS:',
    ...coverage.classes.map((c) => c.status === 'ok'
      ? `- ${c.label}: ${c.copy}`
      : `- ${c.label}: NOT AVAILABLE — ${c.copy}`),
    '',
    STAY_ABSENCE_INSTRUCTION,
  ];

  for (const docKind of DOC_KINDS) {
    if (docKind === 'discharge') continue;   // the discharge extract is already the EXTRACTED CASE
    const mine = documents.filter((d) => d.docKind === docKind && d.status === 'ok');
    if (!mine.length) continue;
    lines.push('', `${DOC_KIND_LABEL[docKind].toUpperCase()}S ON THIS STAY (${DOC_KIND_SOURCE[docKind]}):`);
    mine.forEach((d, i) => {
      const n = mine.length > 1 ? ` ${i + 1}` : '';
      lines.push(`${DOC_KIND_LABEL[docKind]}${n}:`);
      // Structured first, exactly as the library stored it — a column, not a reading of prose.
      for (const p of procedureFactsOf(d.state)) {
        lines.push(`  - procedure (structured field): ${p.conceptRaw}${p.laterality ? ` — side: ${p.laterality}` : ''}`);
      }
      for (const f of otFactsOf(d.state)) {
        // Already stated on the procedure line above, in canonical form. `side` is skipped for a
        // sharper reason than `surgery` (P2.1 / A6): its stored value is KX's raw multi-select
        // widget — `["on-left"]` — and showing that to the model alongside the canonical `side:
        // left` would put the same fact in front of it twice, once in a shape nothing can read.
        // The verbatim string is kept in the ClinicalState provenance, which is where an auditor
        // looks; it is not prompt material.
        const label = f.label.toLowerCase();
        if (label === 'surgery' || label === 'side') continue;
        lines.push(`  - ${f.label}: ${f.value}`);
      }
      const narrative = extra(d.state, 'narrative');
      if (narrative) lines.push(`  - note: ${narrative}`);
      if (d.state.missingCriticalData.length) lines.push(`  - gaps in this document: ${d.state.missingCriticalData.join('; ')}`);
    });
  }

  return { text: lines.join('\n'), coverage };
}

/**
 * The honest one-liner for the case page and the report. A stay whose classes were all readable says
 * so; one with holes NAMES them, because "the audit found nothing wrong with theatre" and "the audit
 * never saw the theatre record" are different sentences and only one of them is true here.
 */
export function stayCoverageLine(coverage: StayCoverageBlock): string {
  const missing = coverage.classes.filter((c) => c.status === 'not_auditable');
  if (!missing.length) return `Read ${coverage.documentsRead} documents across all four classes.`;
  return `Read ${coverage.documentsRead} document${coverage.documentsRead === 1 ? '' : 's'}. Not available: ${missing.map((c) => c.label).join(', ')} — these were not seen by this audit, which is not evidence they did not happen.`;
}
