/**
 * lib/ipd-episode/checkpoint-core.ts — the PURE half of the blinded checkpoint pass (PRD §3.3):
 * the retrieval query builder, the user-message assembly, and the output parser.
 *
 * NO db, NO model, NO Next.
 *
 * WHAT MAKES A CHECKPOINT BLIND is not this file's prose — it is that its caller hands it a list
 * produced by `eventsBeforeDayStart` / `episodeLevelEvents` in assemble-core. Nothing here can
 * reach the discharge event, the extracted case, `discharge_type`, `los_days` or
 * `discharge_date_time`, because nothing here is given the episode: it is given a filtered list
 * and an admission envelope, and it renders exactly what it is given.
 */

import { extractJsonObject } from '../lvc-value-core';
import { collapseSpaces, PHARMACY_SERVICE_TYPE, type EpisodeEvent } from './assemble-core';
import { MATCHER_KINDS, SUBJECT_CONCEPTS, subjectWords, type MatcherKind } from './resolve-core';

export const RETRIEVAL_TOP_K = 8;
const NOTE_QUERY_CHARS = 400;

// ── retrieval query (PRD §3.3.2, rebuilt 2026-09-02) ────────────────────────────────────────
//
// ⚠️ THE OLD QUERY RETRIEVED STAFFING LITERATURE, AND HERE IS EXACTLY WHY. It was built from
// `treating_department_name`, `admission_type`, `admit_source` and the admission `remarks` — four
// ADMINISTRATIVE fields. A hernia repair produced a query like "General Surgery direct_admission
// OPD", and a corpus asked that question answers it honestly: it returns passages about
// departments, rotations and staffing models. IP-1286 retrieved pediatric rotation and obstetric
// staffing content for a hernia repair, and every downstream symptom — 42 of 42 entries uncited,
// a divergence_index of 100 — descends from a query that never mentioned a clinical fact.
//
// The query is now built from CLINICAL CONTENT ONLY, in the priority below. Ward, doctor,
// facility, admission type and admit source do not appear in it at all, and a test asserts they
// cannot: they describe where care happened and who arranged it, never what was wrong.

/** Cap per contributing source, so one long note cannot crowd out the rest of the query. */
const Q_SURGERY_MAX = 3;
const Q_NARRATIVE_CHARS = 400;
const Q_DRUGS_MAX = 8;
const Q_LABS_MAX = 8;
const Q_TOTAL_CHARS = 1200;

export interface RetrievalQueryInput {
  /**
   * Events ALREADY filtered to this checkpoint's cut-off.
   *
   * ⚠️ THE EXTRACTED CASE IS NOT AN INPUT HERE, and the absence is the point (V, 2026-09-02).
   * An earlier revision fed the discharge summary's `diagnosis` and `procedure` into this query on
   * the grounds that the DB addendum classifies them as "pre-outcome" and that they steer only
   * WHICH PASSAGES ARE FETCHED, never the prompt. Both things were true and the reasoning was still
   * wrong: a discharge summary is written after the fact, so its diagnosis is what the admission
   * turned out to be. Selecting excerpts with it puts hindsight into a blinded pass through the
   * retrieved text — a day 0 checkpoint would be reading passages chosen by knowing the answer,
   * and its "expected course" would quietly become a description of what happened. PRD §3.3.3
   * stands as written: the checkpoint never receives the extracted case, by any route.
   *
   * A thin query is the honest outcome when little is documented before day 0. `retrieval_offtopic`
   * will show it and the checkpoint will have little to work from — which is the true state of the
   * record at that hour, and is not to be backfilled with hindsight.
   */
  eventsBeforeCutoff: EpisodeEvent[];
  /** Author display names to strip out of narrative before it becomes a query term (item 7). */
  authorNames?: string[];
  /**
   * The admission `remarks`, restored 2026-09-02 after an over-strip. It was removed with the four
   * administrative fields, but it does not belong with them: remarks is free text WRITTEN AT
   * ADMISSION, so it is the presenting picture rather than a description of where care happened,
   * and it carries no hindsight. Stripping it left the day 0 query empty on IP-1286 — nine of the
   * eleven uncited findings were day 0 — because at the door there is often nothing else.
   */
  remarks?: string | null;
  /**
   * ⚠️ THE DAY 0 FALLBACK, NOW RESTRICTED TO OT NOTES INSIDE THE CUT-OFF (item 8). The previous
   * revision passed the EPISODE's OT surgery names, and on IP-1286 that meant a note timestamped
   * 11:53 selecting the evidence for a 03:03 cut-off: day 0's excerpts were retrieved with
   * knowledge of an operation that had not happened yet. The caller now passes names taken from
   * the SAME filtered window as everything else.
   *
   * That makes this path a deliberate no-op — an in-window OT note is already picked up by rule 1
   * above, so the fallback can never add anything — and it is kept, tested and stamped precisely
   * so the leak cannot quietly return by someone widening the caller again. A day 0 query with
   * nothing clinical before it stays thin, and retrieval_offtopic reports it.
   */
  episodeSurgeryNames?: string[];
  /** True for the day 0 checkpoint only — the fallback above applies nowhere else. */
  isDayZero?: boolean;
}

/** What `buildRetrievalQuery` returns: the query, and whether it needed the day 0 OT fallback. */
export interface RetrievalQueryResult {
  query: string;
  day0FromOt: boolean;
}

/**
 * ⚠️ AN INVENTORY STRING IS NOT A CLINICAL TERM. The mirror's `ordered_item_name` is a SKU:
 * "ABSTACK 30-.-5MM-COVIDEN-1's", "EMESET 2ML INJ-1's". Fed to a retrieval engine those tokens
 * match nothing clinical and actively pull the query toward packaging and supplier text, which is
 * the same class of failure as querying on department names.
 *
 * The base name is everything before the first token that looks like inventory: a pack size, a
 * dose, a form, a supplier suffix or a bare code. Deliberately conservative — it TRUNCATES at the
 * first inventory token rather than trying to understand the rest, so "PARACETAMOL 1G" yields
 * "PARACETAMOL" and an unrecognised shape yields itself unharmed.
 */
const INVENTORY_TOKEN = /^(\d+(\.\d+)?\s*(mg|mcg|g|gm|ml|l|iu|units?|mm|cm|fr|ga)?|\d+'?s|inj|tab|tabs|cap|caps|syp|susp|soln|amp|vial|strip|pack|kit|set|nos?)$/i;
const SUPPLIER_NOISE = /[-.]/;

export function drugBaseName(raw: string): string {
  const words = (raw || '').trim().split(/\s+/);
  const kept: string[] = [];
  for (const w of words) {
    const bare = w.replace(/[(),]/g, '');
    if (!bare) continue;
    if (INVENTORY_TOKEN.test(bare)) break;                 // a pack size ends the clinical name
    if (SUPPLIER_NOISE.test(bare) && /\d/.test(bare)) break; // "30-.-5MM-COVIDEN-1's"
    kept.push(bare);
    if (kept.length >= 3) break;                            // a drug name is not a sentence
  }
  return kept.join(' ').trim();
}

/**
 * Strip identifier-shaped content out of narrative before it becomes a query term. A note's
 * component_json carries `speciality_code`, `department_id`, `subDepartment_id`, `visit_type_id`
 * and friends alongside the actual narrative, and `noteSummaryFrom` concatenates them all — which
 * is right for the STORED summary (it is the record) and wrong for a retrieval query, where a uuid
 * is noise that displaces clinical words under the character cap.
 *
 * Operates on the "name: value" segments the summary is built from, so it removes the id AND its
 * label rather than leaving an orphaned key behind.
 */
const ID_FIELD = /(^|_)(id|ids|code|codes|uid|uuid|guid)$|^(speciality|specialisation|department|subdepartment|visit_type|priority|service_type|module|template|tag|facility|ward|bed)/i;

export function clinicalTextForQuery(summary: string): string {
  const segments = (summary || '').split(' · ');
  const kept: string[] = [];
  for (const seg of segments) {
    const idx = seg.indexOf(': ');
    if (idx > 0) {
      const key = seg.slice(0, idx).trim();
      if (ID_FIELD.test(key)) continue;                    // an identifier and its label, both gone
      const value = seg.slice(idx + 2).trim();
      // a value that is only a code or a uuid carries nothing either
      if (!value || /^[0-9a-f-]{8,}$/i.test(value) || /^\d+$/.test(value)) continue;
      kept.push(value);
      continue;
    }
    if (seg.trim()) kept.push(seg.trim());
  }
  return collapseSpaces(kept.join(' '));
}

/**
 * ⚠️ AN AUTHOR NAME IS NEVER A CLINICAL TERM. The day-1 and episode queries on IP-1286 carried a
 * whole progress note including the RMO's name. A person's name retrieves nothing clinical and
 * displaces words that would — and it should not be travelling to a retrieval service at all.
 *
 * Two passes, because names arrive two ways. The KNOWN names (each event's `finalized_by_username`,
 * already normalised) are removed literally, longest first so a full name goes before its parts.
 * Then the `Dr <Name>` shape catches the rest, since a name that appears only inside narrative text
 * has no field to be read from.
 *
 * Patient names are already gone — the de-identifier ran at assembly. This is staff data, which the
 * repo deliberately retains on the RECORD; it just has no business in a query.
 */
export function stripPersonNames(text: string, knownNames: readonly string[] = []): string {
  let out = text || '';
  const tokens = new Set<string>();
  for (const n of knownNames) {
    const full = (n ?? '').trim();
    if (full.length >= 3) tokens.add(full);
    for (const part of full.split(/\s+/)) if (part.length >= 3 && !/^dr$/i.test(part)) tokens.add(part);
  }
  for (const t of Array.from(tokens).sort((a, b) => b.length - a.length)) {
    out = out.split(t).join(' ');
    const lower = t.toLowerCase();
    if (lower !== t) out = out.split(lower).join(' ');
  }
  // "Dr Testperson Alpha" / "Dr. Testperson" — up to two capitalised words after a Dr title
  out = out.split(/\bDr\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g).join(' ');
  return collapseSpaces(out);
}

/**
 * The last gate before a term reaches retrieval: keep CLINICAL WORDS ONLY. Drops bare numbers,
 * codes, percentages, units and one-to-three character fragments that survive earlier cleaning —
 * the residue that made a query end in "ABSTACK" or "SODIUM" with nothing after it.
 *
 * ⚠️ A KNOWN RESIDUAL LIMIT, STATED RATHER THAN PAPERED OVER. This cannot tell a stapler brand
 * ("ABSTACK") from a drug brand: both are alphabetic proper nouns of the same shape, and the only
 * field that would distinguish them is the `item_category` this engine deliberately does not join
 * (decision 17, which measured that join as repairing 1.9% of blank categories). Consumable brand
 * names will still reach the query. What is fixed here is everything that IS mechanically
 * separable: pack sizes, codes, units, identifiers and names.
 */
export function clinicalWordsOnly(text: string): string {
  const kept: string[] = [];
  for (const raw of (text || '').split(/\s+/)) {
    const w = raw.replace(/[(),;:]/g, '').trim();
    if (!w) continue;
    if (w.length < 4) continue;                    // fragments and units
    if (/^\d/.test(w)) continue;                   // 500ML, 0.9%, 30-5MM
    if (!/[a-zA-Z]{4,}/.test(w)) continue;         // must contain a real word
    if (/^\d+[a-z]*$/i.test(w)) continue;
    kept.push(w);
  }
  return collapseSpaces(kept.join(' '));
}

/** How many progress notes the accumulated problem list may draw on, and the shared character
 *  budget across them. Bounded so a long stay cannot grow the query without limit (item 8). */
export const Q_NOTES_MAX = 6;
export const Q_NARRATIVE_TOTAL_CHARS = 1200;

const detailStr = (e: EpisodeEvent, key: string): string => {
  const v = (e.detail as Record<string, unknown>)?.[key];
  return v == null ? '' : String(v).trim();
};

/**
 * The retrieval query, built ONLY from what the checkpoint may already see:
 *   1. the OT note's `surgery_name`, where that OT note is itself before the cut-off
 *   2. the initial assessment's narrative — the admission-time clinical picture, and often the
 *      only clinical text a day 0 checkpoint has
 *   3. the most recent progress note before the cut-off
 *   4. distinct `ordered_item_name` of the latest documented day's pharmacy orders
 *   5. lab `service_name` values
 *
 * Every part is optional and every part comes off the filtered event list, so the query can never
 * describe something the checkpoint is not allowed to see. An episode with nothing clinical
 * documented before day 0 yields a thin query, and that is the correct answer rather than a
 * problem to solve — see the note on RetrievalQueryInput.
 */
export function buildRetrievalQuery(input: RetrievalQueryInput): RetrievalQueryResult {
  const events = input.eventsBeforeCutoff;
  const parts: string[] = [];
  const push = (v: string | null | undefined) => { const t = (v ?? '').trim(); if (t) parts.push(t); };

  // 1. what was operated on. `events` is already the cut-off window, so an OT note that has not
  //    happened yet is simply not in this list — no separate date check is needed or wanted.
  const surgeries = Array.from(new Set(
    events.filter((e) => e.event_type === 'ot_note').map((e) => detailStr(e, 'surgery_name')).filter(Boolean),
  )).slice(0, Q_SURGERY_MAX);
  for (const sx of surgeries) push(sx);

  // ⚠️ WHITELIST, NOT STRIP (item 7). Narrative now arrives pre-selected on the event as
  // `query_narrative` — only fields whose NAME is on QUERY_NARRATIVE_FIELDS, values only. The
  // strip-based cleaners below still run as a second pass over the admission `remarks`, which is a
  // free-text column with no field structure to whitelist against.
  const names = input.authorNames ?? [];
  const scrub = (t: string) => clinicalWordsOnly(stripPersonNames(clinicalTextForQuery(t), names)).slice(0, Q_NARRATIVE_CHARS);
  const whitelisted = (e: EpisodeEvent) => {
    const v = (e.detail as Record<string, unknown>)?.query_narrative;
    return v == null ? '' : stripPersonNames(String(v), names).slice(0, Q_NARRATIVE_CHARS);
  };

  // 2. the admission remarks — the presenting picture, written at the door
  push(input.remarks ? scrub(input.remarks) : null);

  // 3. the initial assessment — the admission-time picture. Taken SEPARATELY from the progress
  //    notes below rather than competing with them for one slot: at day 0 it is frequently the
  //    only clinical narrative in existence, and losing it to a later note would empty the query
  //    at exactly the checkpoint that can least afford it.
  const assessment = [...events]
    .filter((e) => e.event_type === 'initial_assessment' && e.summary.trim())
    .sort((a, b) => String(a.occurred_at ?? '').localeCompare(String(b.occurred_at ?? '')))[0];
  if (assessment) push(whitelisted(assessment));

  // 4. ROUND 14 ITEM 8 — THE ACCUMULATED PROBLEM LIST, NOT THE LATEST NOTE.
  //
  // ⚠️ THIS IS THE DIRECT CAUSE OF THE DAY-3 STENT CLUSTER. The query used the most recent note
  // alone, and on IPNO-416 day 3 that note read, in full: "Follow-up visit Clinicaly better.
  // Euvolemic Blood pressure stable. Urine output adequate - Continue the same therapeutic
  // measurs". A terse improving-patient note carries no problem list, so the day-3 and
  // episode-level queries were left with the OT surgery name and nothing else. Retrieval returned
  // eight stent-procedure documents, and the checkpoint duly expected stent monitoring — six
  // findings' worth, on a stent that was working.
  //
  // A patient's problems do not disappear because today's note is short. The live problem list is
  // what ACCUMULATED across the notes so far, so the query is built from the most recent notes
  // BACKWARD, oldest content first, until the character budget is spent. Day 3 then still carries
  // "pyelonephritis, hydroureteronephrosis, urosepsis, pancreatitis, acute on CKD, hyperkalaemia"
  // from days 0-2, which is what the admission is actually about.
  //
  // The cut-off still binds absolutely: `events` is the filtered window, so this reaches further
  // back in time, never forward.
  const notes = [...events]
    .filter((e) => e.event_type === 'note' && e.occurred_at && e.summary.trim())
    .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
  const recentFirst = notes.slice(-Q_NOTES_MAX).reverse();
  let narrativeBudget = Q_NARRATIVE_TOTAL_CHARS;
  const noteParts: string[] = [];
  for (const n of recentFirst) {
    if (narrativeBudget <= 0) break;
    const text = whitelisted(n).slice(0, narrativeBudget);
    if (!text.trim()) continue;
    noteParts.push(text);
    narrativeBudget -= text.length;
  }
  // Oldest first within the block, so the query reads as the problem list developed rather than
  // as a reversed transcript.
  for (const t of noteParts.reverse()) push(t);

  // ⚠️ PHARMACY ITEM NAMES ARE NO LONGER IN THE QUERY, and that is the honest end of three
  // attempts. `ordered_item_name` is an inventory string: "ABSTACK 30-.-5MM-COVIDEN-1's" is a
  // surgical stapler, "SODIUM CHLORIDE 0.9%" is a fluid, and neither is distinguishable from a
  // drug brand by any rule that does not know the item category — the one field that would tell
  // them apart is the `kx_medicine_items` join decision 17 measured at 1.9% yield and dropped.
  // Base-name truncation reduced the noise and could not remove it: ABSTACK and SODIUM survived
  // into the day-1 and day-2 queries and were the last two tokens of each.
  //
  // They also bought little. Surgery name, admission remarks and the whitelisted narrative already
  // carry the topical signal — measured: the queries built from those retrieved eight on-topic
  // hernia sources per checkpoint. Drug names are still fully available to the RESOLVER, which
  // matches on them exactly and does not care that they are ugly.

  // 5. what was investigated
  const labs = Array.from(new Set(
    events.filter((e) => e.event_type === 'lab_order').map((e) => clinicalWordsOnly(drugBaseName(detailStr(e, 'service_name')))).filter(Boolean),
  )).slice(0, Q_LABS_MAX);
  for (const l of labs) push(l);

  const query = collapseSpaces(parts.join(' ')).slice(0, Q_TOTAL_CHARS);
  if (query) return { query, day0FromOt: false };

  // ── the day 0 last resort (see episodeSurgeryNames) ──
  if (input.isDayZero && input.episodeSurgeryNames?.length) {
    const fallback = collapseSpaces(
      Array.from(new Set(input.episodeSurgeryNames.filter(Boolean))).slice(0, Q_SURGERY_MAX).join(' '),
    ).slice(0, Q_TOTAL_CHARS);
    if (fallback) return { query: fallback, day0FromOt: true };
  }

  // Nothing clinical was documented before this cut-off and there is no OT note to fall back on.
  // An empty query is the honest answer; retrieval_offtopic and the citation counts will show it.
  return { query: '', day0FromOt: false };
}

// ── topicality (item 3) ─────────────────────────────────────────────────────────────────────
//
// A query can be perfectly clinical and still retrieve nothing about the case. This does NOT block
// generation — a checkpoint with off-topic excerpts still produces an expected course, and the
// uncited cap already limits what a finding built on one may score. It records the fact, so a
// topical failure is a column rather than something someone has to notice.

/** Words that carry no clinical signal. Deliberately short: this is a stopword list, not a
 *  vocabulary — anything not here counts as a clinical term, which errs toward "on topic" and so
 *  toward NOT raising the flag. A false quiet is safer than a false alarm on a scoring surface. */
const Q_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'without',
  'from', 'as', 'is', 'was', 'are', 'were', 'be', 'been', 'this', 'that', 'these', 'those',
  'not', 'no', 'nil', 'per', 'via', 'due', 'has', 'had', 'have', 'day', 'days', 'hour', 'hours',
  'patient', 'patients', 'history', 'given', 'done', 'noted', 'seen', 'plan', 'advice', 'review',
  'normal', 'stable', 'continue', 'continued', 'started', 'admitted', 'admission', 'discharge',
  'mg', 'ml', 'gm', 'iv', 'po', 'bd', 'od', 'tds', 'qid', 'stat', 'inj', 'tab', 'cap', 'syp',
]);

/**
 * ⚠️ GENERIC CLINICAL VOCABULARY, EXCLUDED FROM OVERLAP SCORING. These are real clinical words, so
 * `clinicalTerms` still returns them — but they are shared by almost any two medical texts, and
 * matching on one of them is not evidence that an excerpt is about the case.
 *
 * This is what let an ICMR hospital-acquired-pneumonia chunk pass as on-topic for a hernia repair:
 * the query carried CEFAZOLIN and the chunk discussed antimicrobials, so they shared "antibiotic",
 * "infection", "therapy" — and one shared word was enough. Half a slate of pneumonia guidance
 * scored as topical, and the detector reported 1, 0, 1, 0 while three to four excerpts per
 * checkpoint were unrelated.
 */
const Q_GENERIC = new Set([
  'antibiotic', 'antibiotics', 'antimicrobial', 'antimicrobials', 'infection', 'infections',
  'infective', 'therapy', 'treatment', 'treated', 'management', 'clinical', 'care', 'hospital',
  'ward', 'unit', 'risk', 'factors', 'guideline', 'guidelines', 'recommendation', 'recommendations',
  'study', 'studies', 'evidence', 'dose', 'dosing', 'duration', 'prophylaxis', 'empirical',
  'empiric', 'resistance', 'susceptibility', 'culture', 'cultures', 'organism', 'organisms',
  'disease', 'condition', 'symptoms', 'signs', 'diagnosis', 'diagnostic', 'assessment',
  'monitoring', 'surgery', 'surgical', 'operative', 'procedure', 'medication', 'medications',
  'drug', 'drugs', 'adult', 'adults', 'severe', 'acute', 'chronic', 'should', 'shall', 'must',
]);

/** How many DISTINCTIVE terms an excerpt must share with the query to count as on topic. Two,
 *  because one distinctive word can still be coincidence and two rarely is. */
export const MIN_SHARED_TERMS = 2;

/**
 * ROUND 14 ITEM 7, HALF TWO — THE THRESHOLD THAT COULD NOT FIRE. THIRD TIME OF ASKING.
 *
 * The test required a strict MAJORITY: `off * 2 > excerpts.length`. With the standard slate of
 * eight excerpts that needs five. On IPNO-416 the day-3 and episode checkpoints each had FOUR off
 * topic and reported `false`; every checkpoint in the episode reported `false`. Round 6 replaced an
 * all-or-nothing test with a majority for exactly this reason and did not go far enough, which is
 * how the same flag has now been raised three times.
 *
 * A QUARTER IS THE THRESHOLD, and the reasoning is about what the flag is FOR. This is not a
 * measure of whether retrieval was mostly good; it is a warning that the expected course was
 * partly built on passages about a different problem. Two of eight excerpts about paediatric
 * oncology in an adult nephrology case is already enough to pull an expectation sideways — which
 * is what item 8 shows actually happened. The flag is advisory, never blocking, so the cost of
 * firing it early is a line in a diagnostic column; the cost of it never firing is three rounds of
 * a signal that does not exist.
 *
 * A minimum of two keeps a single unlucky excerpt on a short slate from raising it.
 */
export const OFF_TOPIC_FRACTION = 0.25;
export const OFF_TOPIC_MIN = 2;

export function offTopicThreshold(total: number): number {
  return Math.max(OFF_TOPIC_MIN, Math.ceil(total * OFF_TOPIC_FRACTION));
}

/** The canonical clinical concepts a piece of text is about (resolve-core's shared vocabulary). */
function conceptsOf(text: string): Set<string> {
  return new Set(subjectWords(text).filter((w) => SUBJECT_CONCEPTS.has(w)));
}

export function clinicalTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of (text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4) continue;
    if (Q_STOPWORDS.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * Topicality, measured PER EXCERPT.
 *
 * ⚠️ THE ALL-OR-NOTHING VERSION COULD NOT FIRE, AND DIDN'T. It returned true only when EVERY
 * excerpt was unrelated, so a slate that was half hospital-acquired-pneumonia guidance on a clean
 * elective hernia case scored false — "on topic" — because the other half matched. On IP-1286 the
 * flag was false on every checkpoint while twelve of twenty-four excerpts were unrelated. A signal
 * that cannot fire on the case it was built for is not a signal.
 *
 * Each excerpt is now judged on its own, `offTopicCount` is reported alongside, and the boolean
 * fires on a MAJORITY — more than half the slate sharing no clinical term with the query.
 *
 * Still returns zero/false when there is nothing to judge (no query, or no excerpts): an empty
 * retrieval is already recorded by `retrieval_failed` and by the citation counts, and calling it
 * "off topic" would put two different failures in one column.
 */
export function assessTopicality(
  query: string, excerpts: { label: string; text: string }[],
): { offTopic: boolean; offTopicCount: number; total: number } {
  // DISTINCTIVE terms only: generic clinical vocabulary is dropped from BOTH sides, so an overlap
  // has to be on something that actually identifies this case.
  const distinctive = (t: string) => {
    const out = new Set<string>();
    for (const w of clinicalTerms(t)) if (!Q_GENERIC.has(w)) out.add(w);
    return out;
  };
  const q = distinctive(query);
  // ⚠️ CONCEPTS FIRST, RAW WORDS ONLY AS A FALLBACK — and this is the correction that made the
  // flag honest rather than merely loud. Judging titles on raw distinctive words made IP-1483
  // report 52 of 64 excerpts off topic while the day-1 slate was Chronic Kidney Disease,
  // End-Stage Renal Disease, Uraemia, Acute Kidney Injury and diabetes-with-CKD — squarely on
  // topic for a CKD admission. The query said "renal" and "CKD"; the titles said "kidney" and
  // "nephrology"; no raw word matched. That is item 4's defect for the third time in one round:
  // a test asking whether the WORDS agree, about things that plainly do.
  //
  // So the vocabulary that groups expectations by subject also decides topicality. One shared
  // CONCEPT is enough — a title is a compressed topic statement, and agreeing with the query
  // about what the case IS is not a coincidence the way one shared word can be.
  const qConcepts = conceptsOf(query);
  if (q.size === 0 || excerpts.length === 0) return { offTopic: false, offTopicCount: 0, total: excerpts.length };
  let off = 0;
  for (const x of excerpts) {
    if (qConcepts.size) {
      const shared = [...conceptsOf(x.label)].some((c) => qConcepts.has(c));
      if (shared) continue;
    }
    // ⚠️ ROUND 14 ITEM 7, HALF ONE — JUDGE THE TITLE, NOT THE BODY. Topicality is a property of
    // what a passage is ABOUT, and the label says that; a 1,100-character body shares vocabulary
    // with almost anything clinical. On IPNO-416's day-2 checkpoint the slate included
    // "Oncologic Emergencies in Infants and Children", "hyperkalemia in children" and a Weil's
    // syndrome case report — in an adult nephrology admission — and only ONE excerpt was counted
    // off topic, because the long bodies happened to share two distinctive words each.
    const terms = distinctive(x.label);
    let shared = 0;
    for (const t of terms) if (q.has(t)) { shared++; if (shared >= MIN_SHARED_TERMS) break; }
    // A single shared distinctive word is coincidence often enough to be worthless as a signal —
    // and when the query has only one distinctive term of its own, one match IS the whole overlap.
    const need = Math.min(MIN_SHARED_TERMS, q.size);
    if (shared < need) off++;
  }
  return { offTopic: off >= offTopicThreshold(excerpts.length), offTopicCount: off, total: excerpts.length };
}

/** Kept as the boolean-only view for callers that want it. */
export function retrievalIsOffTopic(query: string, excerpts: { label: string; text: string }[]): boolean {
  return assessTopicality(query, excerpts).offTopic;
}

/** First 100 chars of each excerpt, for the checkpoint row's `retrieved_titles` (item 2): what came
 *  back, readable without opening jsonb. */
export const RETRIEVED_TITLE_CHARS = 100;

export function retrievedTitles(excerpts: { label: string; text: string }[]): string[] {
  return excerpts.map((x) => collapseSpaces(`${x.label} — ${x.text}`).slice(0, RETRIEVED_TITLE_CHARS));
}

// ── the user message ─────────────────────────────────────────────────────────────────────────

export interface RetrievedExcerpt { id: number; label: string; text: string }

export interface CheckpointUserInput {
  checkpointId: string;
  checkpointType: 'daily' | 'episode';
  dayIndex: number;
  /** ISO 8601 UTC. For a daily checkpoint this is the day boundary; for the episode-level one it
   *  is the last documented moment. Recorded on the row as `input_cutoff_at` — the blinding proof. */
  cutoffAt: string;
  admissionContext: string;
  events: EpisodeEvent[];
  excerpts: RetrievedExcerpt[];
}

/** One event, rendered for a prompt. Ids and timestamps are copied through verbatim. */
export function renderEvent(e: EpisodeEvent): string {
  const when = e.occurred_at ?? 'time not recorded';
  const who = e.author_name ? ` [author ${e.author_name}${e.author_role ? `, ${e.author_role}` : ''}]` : '';
  const detail = e.detail && Object.keys(e.detail).length ? ` ${JSON.stringify(e.detail)}` : '';
  return `- ${when} · day ${e.day_index} · ${e.event_type} · tier ${e.evidence_tier} · `
    + `[${e.provenance.source_table} ${e.provenance.source_record_id}]${who} ${e.summary}${detail}`;
}

export function buildCheckpointUser(input: CheckpointUserInput): string {
  const head = input.checkpointType === 'episode'
    ? `EPISODE-LEVEL CHECKPOINT (${input.checkpointId}). Everything documented up to the last recorded moment of this admission is below. The admission has not been closed for you: you are not told how it ended.`
    : `DAY ${input.dayIndex} CHECKPOINT (${input.checkpointId}). Everything documented BEFORE ${input.cutoffAt} is below, and nothing after it.`;

  const k = input.excerpts.length;
  // THE RANGE IS STATED AS A NUMBER, not implied by how many blocks follow. 42 of 42 entries came
  // back uncited on the first live episode, and the prompt at the time both invited empty arrays
  // and never said what the legal numbers were. A model cannot cite a range it was not given.
  const excerpts = k
    ? `\nNORMATIVE EXCERPTS — excerpts are numbered 1 to ${k}. Every entry you return must carry at least one of these numbers in its citation_ids.\n${input.excerpts.map((x, i) => `[${i + 1}] ${x.label}\n${x.text}`).join('\n\n')}`
    : `\nNORMATIVE EXCERPTS: none were retrieved for this checkpoint. There are no numbers to cite, so leave citation_ids empty throughout — this is the one case where that is expected.`;

  const closer = k
    ? `State the expected next 24 hours as the JSON object described in your instructions. Every entry must carry at least one citation_ids value between 1 and ${k}.`
    : 'State the expected next 24 hours as the JSON object described in your instructions.';

  return `${head}

ADMISSION CONTEXT
${input.admissionContext}

DOCUMENTED SO FAR (${input.events.length} event${input.events.length === 1 ? '' : 's'})
${input.events.length ? input.events.map(renderEvent).join('\n') : '(nothing beyond the admission itself)'}
${excerpts}

${closer}`;
}

/** The admission context line every checkpoint gets. Carries no outcome field by construction. */
export function admissionContextLine(a: {
  treatingDepartmentName: string | null; admissionType: string | null;
  admitSource: string | null; speciality: string | null; remarks: string | null;
}): string {
  const parts = [
    a.speciality ? `Speciality: ${a.speciality}` : null,
    a.treatingDepartmentName ? `Department: ${a.treatingDepartmentName}` : null,
    a.admissionType ? `Admission type: ${a.admissionType}` : null,
    a.admitSource ? `Admitted from: ${a.admitSource}` : null,
    a.remarks ? `Admission remarks: ${a.remarks}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join('\n') : '(the admission row carries no department, type or source)';
}

// ── output (PRD §3.3.4) ──────────────────────────────────────────────────────────────────────

/** The machine-checkable half of every expectation (decision 33). Null when the model failed to
 *  emit one — the resolver reports that as uncheckable rather than guessing at it. */
export interface EntryMatcher { kind: MatcherKind; terms: string[] }

export interface ExpectedItem {
  item: string; by_day: number | null; rationale: string; citation_ids: number[];
  matcher: EntryMatcher | null;
  /** Chosen at GENERATION time, while the model is still blind to the outcome. */
  proposed_severity: 'minor' | 'moderate' | 'major';
}
export interface ExpectedMonitoring {
  item: string; frequency: string; rationale: string; citation_ids: number[];
  matcher: EntryMatcher | null; proposed_severity: 'minor' | 'moderate' | 'major';
}
export interface EscalationTrigger {
  trigger: string; action: string; citation_ids: number[];
  matcher: EntryMatcher | null; proposed_severity: 'minor' | 'moderate' | 'major';
}

const SEVERITY_VALUES = ['minor', 'moderate', 'major'] as const;

function asMatcher(v: unknown): EntryMatcher | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const kind = String(o.kind ?? '').trim().toLowerCase();
  if (!(MATCHER_KINDS as readonly string[]).includes(kind)) return null;
  const terms = Array.isArray(o.terms)
    ? Array.from(new Set((o.terms as unknown[]).map((t) => collapseSpaces(String(t ?? '')).toLowerCase()).filter((t) => t.length >= 3))).slice(0, 12)
    : [];
  if (!terms.length) return null;
  return { kind: kind as MatcherKind, terms };
}

/** An unreadable proposed severity lands mid-scale — the same reasoning as the judge's fallback:
 *  a repair may neither inflate an expectation into the 8-point band nor bury it in the 1-point one. */
function asProposedSeverity(v: unknown): 'minor' | 'moderate' | 'major' {
  const t = String(v ?? '').trim().toLowerCase();
  return (SEVERITY_VALUES as readonly string[]).includes(t) ? (t as 'minor' | 'moderate' | 'major') : 'moderate';
}

export interface ExpectedCourse {
  expected_diagnostics: ExpectedItem[];
  expected_therapeutics: ExpectedItem[];
  expected_monitoring: ExpectedMonitoring[];
  escalation_triggers: EscalationTrigger[];
  expected_los_days: number | null;
  expected_disposition: string | null;
  uncertainty: string[];
}

const asText = (v: unknown, cap = 600): string => (v == null ? '' : collapseSpaces(String(v)).slice(0, cap));
const asNum = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/**
 * The model cites by ORDINAL — the prompt numbers its excerpts [1]…[k] — and what gets STORED is
 * the real `mksap_chunks` id that ordinal stood for.
 *
 * ⚠️ THIS IS WHY THE TWO citation_ids FIELDS MEAN THE SAME THING. The checkpoint ROW stores the
 * chunk ids retrieval returned; before this mapping, each expected-course ENTRY stored a small
 * integer between 1 and 8. Both were called `citation_ids`, both were `int[]`, and neither the UI
 * nor a validator could tell them apart — entry "3" meant "the third excerpt of this checkpoint"
 * while the row's "3" would have meant chunk 3, a different passage entirely. Mapping here makes
 * one vocabulary: everything downstream of this function speaks chunk ids.
 *
 * An ordinal outside [1..k] is DROPPED, never renumbered and never passed through as if it were
 * already an id — a citation to an excerpt that was never shown is not a citation.
 */
function asCitationIds(v: unknown, chunkIds: readonly number[]): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const raw of v.slice(0, 16)) {
    const ordinal = Number(raw);
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > chunkIds.length) continue;
    const chunkId = chunkIds[ordinal - 1];
    if (Number.isFinite(chunkId) && !out.includes(chunkId)) out.push(chunkId);
  }
  return out;
}

/** The inverse, for rendering: a stored chunk id back to the ordinal the next prompt shows for it.
 *  0 when this checkpoint did not carry that chunk — the caller drops it rather than printing a
 *  number the reader cannot look up. */
export function ordinalForChunkId(chunkId: number, chunkIds: readonly number[]): number {
  return chunkIds.indexOf(chunkId) + 1;
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, 40) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});

/**
 * Parse a checkpoint response. Returns null when nothing usable came back — the caller records
 * `status = 'error'` on the row and carries on, because one failed checkpoint is a gap in the
 * expected course, not a failed episode.
 *
 * `chunkIds` is the ORDERED list of `mksap_chunks` ids the prompt showed as [1]…[k], so a cited
 * ordinal is resolved to the id it stood for and every stored `citation_ids` — on the entry and on
 * the checkpoint row alike — is a chunk id.
 */
export function parseExpectedCourse(text: string, chunkIds: readonly number[]): ExpectedCourse | null {
  const o = extractJsonObject(text);
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;

  const items = (v: unknown): ExpectedItem[] => arr(v).map((raw) => {
    const e = obj(raw);
    return {
      item: asText(e.item), by_day: asNum(e.by_day), rationale: asText(e.rationale),
      citation_ids: asCitationIds(e.citation_ids, chunkIds),
      matcher: asMatcher(e.matcher), proposed_severity: asProposedSeverity(e.proposed_severity),
    };
  }).filter((e) => e.item !== '');

  const monitoring: ExpectedMonitoring[] = arr(r.expected_monitoring).map((raw) => {
    const e = obj(raw);
    return {
      item: asText(e.item), frequency: asText(e.frequency, 200), rationale: asText(e.rationale),
      citation_ids: asCitationIds(e.citation_ids, chunkIds),
      matcher: asMatcher(e.matcher), proposed_severity: asProposedSeverity(e.proposed_severity),
    };
  }).filter((e) => e.item !== '');

  const triggers: EscalationTrigger[] = arr(r.escalation_triggers).map((raw) => {
    const e = obj(raw);
    return {
      trigger: asText(e.trigger), action: asText(e.action),
      citation_ids: asCitationIds(e.citation_ids, chunkIds),
      matcher: asMatcher(e.matcher), proposed_severity: asProposedSeverity(e.proposed_severity),
    };
  }).filter((e) => e.trigger !== '');

  const course: ExpectedCourse = {
    expected_diagnostics: items(r.expected_diagnostics),
    expected_therapeutics: items(r.expected_therapeutics),
    expected_monitoring: monitoring,
    escalation_triggers: triggers,
    expected_los_days: asNum(r.expected_los_days),
    expected_disposition: asText(r.expected_disposition, 200) || null,
    uncertainty: arr(r.uncertainty).map((u) => asText(u, 300)).filter(Boolean),
  };

  const any = course.expected_diagnostics.length || course.expected_therapeutics.length
    || course.expected_monitoring.length || course.escalation_triggers.length
    || course.expected_disposition || course.uncertainty.length;
  return any ? course : null;
}

/**
 * How many entries of an expected course came back with no usable citation, and how many entries
 * there were at all.
 *
 * ⚠️ THIS COUNTS. IT NEVER REPAIRS. The obvious "fix" for an uncited entry is to look for an
 * excerpt whose text overlaps the item and attach it — and that would be fabrication with extra
 * steps: a citation asserts "this expectation was DERIVED FROM that passage", which a string
 * overlap cannot establish. An invented citation is worse than a missing one, because the missing
 * one is caught by the uncited cap and the invented one silently lifts it.
 *
 * So the count is surfaced instead — `uncited_entry_count` on the checkpoint row — which makes the
 * failure visible in a scalar column without anyone reading jsonb, and lets a validator ask "how
 * many entries did this checkpoint ground?" of the whole cohort in one query.
 */
export function countUncitedEntries(course: ExpectedCourse | null): { uncited: number; total: number } {
  if (!course) return { uncited: 0, total: 0 };
  const lists: { citation_ids: number[] }[] = [
    ...course.expected_diagnostics, ...course.expected_therapeutics,
    ...course.expected_monitoring, ...course.escalation_triggers,
  ];
  return { uncited: lists.filter((e) => e.citation_ids.length === 0).length, total: lists.length };
}

/** True when a checkpoint had excerpts to cite, produced entries, and cited NONE of them — the
 *  failure mode measured on IP-1286, and the trigger for the one retry in checkpoint.ts. */
export function everyEntryUncited(course: ExpectedCourse | null, excerptCount: number): boolean {
  if (!course || excerptCount <= 0) return false;
  const { uncited, total } = countUncitedEntries(course);
  return total > 0 && uncited === total;
}

/**
 * ⚠️ AT MOST FOUR PER CATEGORY, AND THE LENGTH ITSELF WAS THE VARIANCE (item 4).
 *
 * Decision 33 took the VERDICT away from the model and the resolver made those verdicts stable —
 * but the model's remaining freedom, HOW MANY THINGS TO EXPECT, became the new variance channel.
 * Across five runs of IP-1286 the day-1 checkpoint produced four distinct expected courses with
 * entry counts swinging 19–24, and the resolver faithfully turned each different list into a
 * different set of findings. A resolver cannot stabilise a score whose inputs move.
 *
 * A short, stable expected course beats a long, unstable one: the fifth-most-consequential
 * expectation on a hernia repair contributes noise, not signal, and it is exactly the entry a
 * model includes or omits at random. The prompt asks for the most consequential first and a hard
 * stop at four; this truncates after parsing, because a prompt is a request and this is the
 * guarantee. `entries_truncated` records how many were cut, so a cap that is biting too hard is
 * visible rather than assumed.
 */
export const MAX_ENTRIES_PER_CATEGORY = 4;

export function capExpectedCourse(course: ExpectedCourse | null): { course: ExpectedCourse | null; truncated: number } {
  if (!course) return { course, truncated: 0 };
  const n = MAX_ENTRIES_PER_CATEGORY;
  const before = course.expected_diagnostics.length + course.expected_therapeutics.length
    + course.expected_monitoring.length + course.escalation_triggers.length;
  const capped: ExpectedCourse = {
    ...course,
    // slice(0, n) keeps the model's own ordering, which the prompt tells it to make
    // most-consequential-first — so truncation drops the least consequential, not an arbitrary tail.
    expected_diagnostics: course.expected_diagnostics.slice(0, n),
    expected_therapeutics: course.expected_therapeutics.slice(0, n),
    expected_monitoring: course.expected_monitoring.slice(0, n),
    escalation_triggers: course.escalation_triggers.slice(0, n),
  };
  const after = capped.expected_diagnostics.length + capped.expected_therapeutics.length
    + capped.expected_monitoring.length + capped.escalation_triggers.length;
  return { course: capped, truncated: before - after };
}

// ── checkpoint entry references (the uncited-entry cap's key, PRD §4.4) ──────────────────────

export interface CheckpointEntryRef { ref: string; citation_ids: number[] }

export const CHECKPOINT_ENTRY_SECTIONS = ['diagnostics', 'therapeutics', 'monitoring', 'escalation'] as const;

/**
 * Every entry of one expected course, addressed as `<checkpoint-id>/<section>/<n>`. This is the
 * reference the diff pass puts in `checkpoint_ref`, and it is what lets §4.4's cap be applied in
 * CODE: a finding built on an entry whose `citation_ids` is empty is capped, whatever the model
 * claimed about it.
 */
export function checkpointEntryRefs(checkpointId: string, course: ExpectedCourse | null): CheckpointEntryRef[] {
  if (!course) return [];
  const out: CheckpointEntryRef[] = [];
  const push = (section: string, list: { citation_ids: number[] }[]) => {
    list.forEach((e, i) => out.push({ ref: `${checkpointId}/${section}/${i + 1}`, citation_ids: e.citation_ids }));
  };
  push('diagnostics', course.expected_diagnostics);
  push('therapeutics', course.expected_therapeutics);
  push('monitoring', course.expected_monitoring);
  push('escalation', course.escalation_triggers);
  return out;
}

/**
 * An expected course, rendered for the diff pass with its entry references attached.
 *
 * CITATIONS ARE RENDERED BACK AS ORDINALS, from the stored chunk ids via this checkpoint's own id
 * list. The diff pass is shown the same [1]…[k] numbering the checkpoint pass was, so it cites the
 * way it is told to; run.ts then resolves those ordinals against THE CHECKPOINT THE FINDING
 * REFERENCES, which is the only list they were ever numbered against. Showing raw chunk ids here
 * would ask a model to copy five-digit numbers exactly, which is a transcription error waiting to
 * become a citation to someone else's passage.
 */
export function renderExpectedCourse(
  checkpointId: string, dayIndex: number, type: 'daily' | 'episode',
  course: ExpectedCourse | null, chunkIds: readonly number[] = [],
): string {
  if (!course) return `${checkpointId} (${type}, day ${dayIndex}): no expected course was produced for this checkpoint.`;
  const lines: string[] = [`${checkpointId} (${type}, day ${dayIndex}) — expected course:`];
  const cite = (ids: number[]) => {
    const ordinals = ids.map((id) => ordinalForChunkId(id, chunkIds)).filter((o) => o > 0);
    return ordinals.length ? ` [citations ${ordinals.join(', ')}]` : ' [no citation]';
  };
  course.expected_diagnostics.forEach((e, i) => lines.push(`  ${checkpointId}/diagnostics/${i + 1} · by day ${e.by_day ?? '?'} · ${e.item} — ${e.rationale}${cite(e.citation_ids)}`));
  course.expected_therapeutics.forEach((e, i) => lines.push(`  ${checkpointId}/therapeutics/${i + 1} · by day ${e.by_day ?? '?'} · ${e.item} — ${e.rationale}${cite(e.citation_ids)}`));
  course.expected_monitoring.forEach((e, i) => lines.push(`  ${checkpointId}/monitoring/${i + 1} · ${e.item} (${e.frequency}) — ${e.rationale}${cite(e.citation_ids)}`));
  course.escalation_triggers.forEach((e, i) => lines.push(`  ${checkpointId}/escalation/${i + 1} · if ${e.trigger} then ${e.action}${cite(e.citation_ids)}`));
  if (course.expected_los_days != null) lines.push(`  expected length of stay: ${course.expected_los_days} day(s)`);
  if (course.expected_disposition) lines.push(`  expected disposition: ${course.expected_disposition}`);
  if (course.uncertainty.length) lines.push(`  uncertainty: ${course.uncertainty.join('; ')}`);
  return lines.join('\n');
}
