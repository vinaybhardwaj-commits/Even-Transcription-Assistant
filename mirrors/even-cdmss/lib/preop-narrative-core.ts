/**
 * lib/preop-narrative-core.ts — the narrative rail's PURE half (PRD v1.1-LOCKED §7 / D4;
 * Build Plan B6). No DB, no fetch, no clock, NO MODEL.
 *
 * THE POSTURE, carried from the readmissions R4 narrative: the model PROPOSES prose and
 * CODE DECIDES whether it is ever rendered. Here that decision has one extra tooth,
 * because a pre-op card is read by an anaesthetist minutes before a list:
 *
 *   EVERY SENTENCE MUST CITE A FACT, and every cited fact must resolve to a row of the
 *   computed factor table. A narrative with one uncited sentence is stored `valid:false`
 *   and NEVER rendered. Fail closed.
 *
 * WHAT THE MODEL IS SHOWN — and this is the D4 boundary in one line — is the COMPUTED
 * SNAPSHOT and nothing else: the factor tables, the instrument bounds, the missing-input
 * list, the tier and its escalations. Not the PAC prose. Not the OPD notes. Not the lab
 * rows. It cannot introduce a fact because it was never given one; it can only restate
 * arithmetic that already happened.
 *
 * THREE THINGS ARE HELD BACK FROM IT ON PURPOSE:
 *   · the patient's NAME and UHID — the prose is about a risk computation, and a model
 *     that never sees an identity cannot leak one;
 *   · the ANAESTHETIST'S VERDICT — the module's standing rule is that the PAC conclusion
 *     is quoted verbatim and never replaced, and the surest way to keep a model from
 *     paraphrasing it is to never show it. The facts record only THAT a conclusion exists;
 *     the page prints it, in the anaesthetist's own words, in its own banner.
 *   · anything not already on the card. If the reader cannot check a sentence against the
 *     table above it, the sentence should not exist.
 */

import type { InstrumentScore, Tri } from './preop-instruments-core';
import type { PreopSnapshot } from './preop-assemble-core';

export const PREOP_NARRATIVE_VERSION = 'preop-narrative/1';

/** R4-11's posture, adopted: Opus 4.6 on Bedrock, no ladder behind it, label read back
 *  off the trace and a disagreement refused rather than corrected. */
export const PREOP_NARRATIVE_MODEL_ID = 'global.anthropic.claude-opus-4-6-v1';
export const PREOP_NARRATIVE_PROVIDER = 'bedrock';
/** One try, ≤ 80 s — the leg owns its own budget (D-1). */
export const PREOP_NARRATIVE_BUDGET_MS = 80_000;
export const PREOP_NARRATIVE_MAX_TRIES = 1;
/** Opus is paced. At most this many narratives per worker tick (the readmit S2 rule). */
export const PREOP_NARRATIVE_MAX_PER_TICK = 3;

// ── the facts ───────────────────────────────────────────────────────────────────

export interface NarrativeFact { id: string; text: string }

const TRI: Record<Tri, string> = { present: 'PRESENT', absent: 'ABSENT', unknown: 'UNKNOWN' };

function bound(s: InstrumentScore): string {
  if (s.kind === 'not_computable') return 'not computable';
  return s.lo === s.hi ? String(s.lo) : `${s.lo} to ${s.hi}`;
}

/**
 * The snapshot, flattened into numbered facts. The ids are what the prose cites and what
 * the validator resolves against; they are positional and stable within one narrative,
 * exactly like the readmit ledger's.
 *
 * Only SCORING factors and UNKNOWN factors are listed. A Charlson category that is absent
 * and worth nothing is not a fact about this patient — it is the shape of the instrument —
 * and nineteen of them would drown the six that matter.
 */
export function buildNarrativeFacts(snap: PreopSnapshot): NarrativeFact[] {
  const out: NarrativeFact[] = [];
  const push = (text: string) => { out.push({ id: `F${out.length + 1}`, text }); };

  const ep = snap.episode;
  push(`Patient: ${ep.age ?? 'age not recorded'}${ep.age != null ? ' years' : ''}, ${ep.sex ?? 'sex not recorded'}.`);
  push(`Planned procedure: ${ep.procedure ?? 'not recorded'}.`);
  push(snap.context.daysToSurgery == null
    ? 'Surgery date: not recorded.'
    : `Surgery is ${snap.context.daysToSurgery} day(s) away.`);

  push(`RCRI (Revised Cardiac Risk Index) scores ${bound(snap.rcri)} of 6.`);
  for (const f of snap.rcri.factors) {
    if (f.status === 'present' || f.status === 'unknown') push(`RCRI factor "${f.label}": ${TRI[f.status]}.`);
  }
  push(`mFI-5 (Modified Frailty Index) scores ${bound(snap.mfi5)} of 5.`);
  for (const f of snap.mfi5.factors) {
    if (f.status === 'present' || f.status === 'unknown') push(`mFI-5 item "${f.label}": ${TRI[f.status]}.`);
  }
  push(`Charlson Comorbidity Index scores ${bound(snap.charlson)}.`);
  for (const f of snap.charlson.factors) {
    if (f.points > 0 || f.status === 'unknown') push(`Charlson category "${f.label}": ${TRI[f.status]}, worth ${f.maxPoints} point(s).`);
  }

  const missing = [...new Set([...snap.rcri.missing, ...snap.mfi5.missing, ...snap.charlson.missing])];
  push(missing.length
    ? `Inputs still unknown, which is why the scores are shown as ranges: ${missing.join(', ')}.`
    : 'No instrument input is unknown; every score is a point score.');

  push(`Composite tier: ${snap.tier.tier}.`);
  if (snap.tier.escalations.length) push(`Tier escalations applied: ${snap.tier.escalations.join('; ')}.`);
  push(snap.pac.onFile
    ? 'A pre-anaesthesia check report is on file and the anaesthetist has recorded a conclusion, which is quoted on the case page.'
    : 'No pre-anaesthesia check report is on file for this episode.');
  if (snap.bookingOnly) push('The booking form is the only document on file for this patient — no outpatient visit, no laboratory result, no PAC.');
  push('mFI-5 and the Charlson index share comorbidity inputs and are two correlated lenses, not independent confirmation.');
  return out;
}

// ── the prompt ──────────────────────────────────────────────────────────────────

export const PREOP_NARRATIVE_SYSTEM = `You write one short paragraph for an anaesthetist about a pre-operative risk computation that has ALREADY been done.

You are given a numbered list of FACTS. That list is the whole world. You have no other information about this patient and must not act as if you do.

RULES:
1. You do not score. The numbers are computed by validated instruments and are already correct. Never recompute, never adjust, never disagree with them.
2. Every sentence you write must end with at least one fact marker in square brackets, like [F4] or [F4][F7]. A sentence with no marker is thrown away and your whole answer is discarded.
3. A marker must name a fact from the list. Do not invent fact numbers.
4. Say nothing the facts do not say. No advice, no diagnosis, no recommendation, no reassurance, no guess about what a missing value might be.
5. Write 3 to 6 sentences of plain clinical English a doctor would say out loud. No headings, no bullet points, no bold.
6. Lead with what makes this patient different from a routine one. If a score is a range, say plainly which input would tighten it.

Return ONLY this JSON, no prose around it, no markdown fence:
{"narrative":"<your paragraph with [F#] markers>"}`;

export function buildNarrativePrompt(facts: NarrativeFact[]): { system: string; user: string } {
  return {
    system: PREOP_NARRATIVE_SYSTEM,
    user: `FACTS:\n${facts.map((f) => `[${f.id}] ${f.text}`).join('\n')}`,
  };
}

/** Tolerant reader; null when there is nothing usable at all. */
export function parseNarrativeOutput(raw: string): string | null {
  let t = String(raw ?? '').trim();
  if (!t) return null;
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      const o = JSON.parse(t.slice(a, b + 1)) as { narrative?: unknown };
      if (typeof o.narrative === 'string' && o.narrative.trim()) return o.narrative.trim();
    } catch { /* fall through to the raw text */ }
  }
  // A model that answered in plain prose still gets validated; it does not get silently lost.
  return t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim() || null;
}

// ── code decides ────────────────────────────────────────────────────────────────

export type NarrativeInvalidReason =
  | 'none' | 'empty' | 'no_citations' | 'unresolved_ids' | 'uncited_sentence';

export interface PreopNarrative {
  version: string;
  /** the model's prose, stored even when invalid — for review, never for rendering */
  text: string;
  citedIds: string[];
  invalidIds: string[];
  /** sentences carrying no marker at all — the pre-op rail's own extra tooth */
  uncitedSentences: string[];
  valid: boolean;
  invalidReason: NarrativeInvalidReason;
  /** the SNAPSHOT fingerprint this was written for. A narrative whose fingerprint no
   *  longer matches the live row is stale by construction and is not rendered. */
  snapshotFingerprint: string;
  generatedAt: string;
  /** DERIVED from the call, never typed */
  model: string | null;
  provider: string | null;
  traceId: string | null;
  factCount: number;
}

const MARKER_RE = /\[(F\d+)\]/g;

/** Sentence split that keeps the trailing marker with its sentence. Abbreviations are not
 *  a hazard here because the prompt forbids them and the failure mode is a false INVALID,
 *  which is the safe direction. */
export function narrativeSentences(text: string): string[] {
  return String(text ?? '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

export function buildPreopNarrative(a: {
  text: string | null;
  facts: NarrativeFact[];
  snapshotFingerprint: string;
  generatedAt: string;
  model: string | null;
  provider: string | null;
  traceId: string | null;
}): PreopNarrative {
  const known = new Set(a.facts.map((f) => f.id));
  const text = (a.text ?? '').trim();
  const base = {
    version: PREOP_NARRATIVE_VERSION,
    text,
    snapshotFingerprint: a.snapshotFingerprint,
    generatedAt: a.generatedAt,
    model: a.model, provider: a.provider, traceId: a.traceId,
    factCount: a.facts.length,
  };
  if (!text) {
    return { ...base, citedIds: [], invalidIds: [], uncitedSentences: [], valid: false, invalidReason: 'empty' };
  }
  const cited: string[] = [];
  for (const m of text.matchAll(new RegExp(MARKER_RE.source, 'g'))) if (!cited.includes(m[1])) cited.push(m[1]);
  const invalidIds = cited.filter((id) => !known.has(id));
  // NB: a fresh non-global test, never MARKER_RE — a /g regex carries lastIndex between
  // calls and would skip every other sentence.
  const uncited = narrativeSentences(text).filter((s) => !/\[F\d+\]/.test(s));

  const reason: NarrativeInvalidReason =
    !cited.length ? 'no_citations'
      : invalidIds.length ? 'unresolved_ids'
        : uncited.length ? 'uncited_sentence'
          : 'none';
  return {
    ...base,
    citedIds: cited,
    invalidIds,
    uncitedSentences: uncited,
    valid: reason === 'none',
    invalidReason: reason,
  };
}

/** The one predicate the surface may use. A narrative is rendered ONLY when it is valid
 *  AND was written for the reading currently on the row. Both halves, every time. */
export function narrativeRenderable(n: PreopNarrative | null, liveFingerprint: string | null): boolean {
  return !!n && n.valid && !!liveFingerprint && n.snapshotFingerprint === liveFingerprint;
}
