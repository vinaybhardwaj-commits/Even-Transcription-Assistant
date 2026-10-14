/**
 * lib/opd-case-anchor-core.ts — pure anchor matcher for the OPD case-audit screen.
 *
 * Maps each audit finding to the note element it is about (a specific medication
 * line, a specific investigation, or a whole section), so the UI can place a
 * numbered chip on the offending line and link it to the finding card.
 *
 * Pure + deterministic: no imports, no I/O. Unit-tested.
 */

export type AnchorSection =
  | 'complaints' | 'reason' | 'examination' | 'diagnosis'
  | 'medications' | 'investigations' | 'advice' | 'followup' | 'note';

export type NoteAnchor = {
  /** 1-based display number, in findings order. */
  num: number;
  section: AnchorSection;
  /** Index into medications[] or investigations[] when matched to a specific line. */
  itemIndex?: number;
};

export type AnchorInput = {
  subject: string;
  domain: string;   // documentation | note_quality | appropriateness | prescribing_safety | patient_centred
  verdict?: string; // low-value | context-dependent | high-value | uncertain | …
};

export type AnchorNote = {
  medications: string[];    // display names, same order as rendered
  investigations: string[]; // display strings, same order as rendered
};

const STOP = new Set([
  'the', 'and', 'for', 'with', 'without', 'not', 'use', 'used', 'this', 'that',
  'note', 'tab', 'cap', 'syrup', 'oral', 'topical', 'daily', 'dose', 'dosing',
  'incomplete', 'missing', 'concurrent', 'combination',
]);

function tokens(s: string): string[] {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/** Significant-token overlap score between a finding subject and a note line. */
function overlap(subjectToks: string[], line: string): number {
  if (subjectToks.length === 0) return 0;
  const lineToks = new Set(tokens(line));
  if (lineToks.size === 0) return 0;
  let hits = 0;
  for (const t of subjectToks) {
    if (lineToks.has(t)) { hits += t.length >= 5 ? 2 : 1; continue; }
    // prefix match handles brand truncations & plurals (e.g. "nitrofur" / "tablets")
    for (const lt of lineToks) {
      if (lt.length >= 5 && t.length >= 5 && (lt.startsWith(t) || t.startsWith(lt))) { hits += 1; break; }
    }
  }
  return hits;
}

function bestLine(subjectToks: string[], lines: string[]): { index: number; score: number } | null {
  let best: { index: number; score: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const s = overlap(subjectToks, lines[i]);
    if (s > 0 && (!best || s > best.score)) best = { index: i, score: s };
  }
  return best;
}

/** Keyword → section fallback for documentation / patient-centred findings. */
function sectionFromSubject(subject: string): AnchorSection | null {
  const s = subject.toLowerCase();
  if (/examin|vitals|physical/.test(s)) return 'examination';
  if (/follow\s*-?up|review date/.test(s)) return 'followup';
  if (/advice|safety[- ]?net|counsel|instruction/.test(s)) return 'advice';
  if (/diagnos|impression|icd|assessment/.test(s)) return 'diagnosis';
  if (/complaint|history|hpi|symptom/.test(s)) return 'complaints';
  if (/reason/.test(s)) return 'reason';
  if (/investigation|test|imaging|lab\b|labs\b/.test(s)) return 'investigations';
  if (/medication|drug|prescri|dosing|dose\b/.test(s)) return 'medications';
  return null;
}

/**
 * Anchor every finding to a note element. Findings are numbered 1..n in input
 * order (the order the cards render). Matching preference:
 *   1. specific medication line, 2. specific investigation line,
 *   3. keyword section, 4. domain-default section, 5. the note as a whole.
 */
export function anchorFindings(findings: AnchorInput[], note: AnchorNote): NoteAnchor[] {
  return findings.map((f, i) => {
    const num = i + 1;
    const subjectToks = tokens(f.subject);

    const med = bestLine(subjectToks, note.medications);
    const inv = bestLine(subjectToks, note.investigations);
    // Prefer the stronger specific match; meds win ties for prescribing findings,
    // investigations win ties for appropriateness findings.
    if (med || inv) {
      const medScore = med?.score ?? 0;
      const invScore = inv?.score ?? 0;
      const preferMed = f.domain === 'prescribing_safety' ? medScore >= invScore : medScore > invScore;
      if (preferMed && med) return { num, section: 'medications', itemIndex: med.index };
      if (inv) return { num, section: 'investigations', itemIndex: inv.index };
      if (med) return { num, section: 'medications', itemIndex: med.index };
    }

    const byKeyword = sectionFromSubject(f.subject);
    if (byKeyword) return { num, section: byKeyword };

    switch (f.domain) {
      case 'prescribing_safety': return { num, section: 'medications' };
      case 'appropriateness': return { num, section: note.investigations.length ? 'investigations' : 'diagnosis' };
      case 'patient_centred': return { num, section: 'advice' };
      case 'documentation': return { num, section: 'note' };
      default: return { num, section: 'note' }; // note_quality & anything unknown
    }
  });
}

/** Group anchors for the renderer: key = `${section}` or `${section}:${itemIndex}`. */
export function anchorsByTarget(anchors: NoteAnchor[]): Record<string, NoteAnchor[]> {
  const out: Record<string, NoteAnchor[]> = {};
  for (const a of anchors) {
    const key = a.itemIndex == null ? a.section : `${a.section}:${a.itemIndex}`;
    (out[key] ||= []).push(a);
  }
  return out;
}
