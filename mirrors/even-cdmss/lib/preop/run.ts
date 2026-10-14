/**
 * lib/preop/run.ts — the deterministic ₹0 sweep: detect episodes, assemble inputs,
 * recompute snapshots, write through the versions rail (PRD §6; Build Plan B2).
 *
 * THERE IS NO MODEL IN THIS FILE, and there is none anywhere below it. Every tick is
 * SQL plus the pure cores. The extraction and narrative rails (PRD §7) attach at B5/B6
 * behind their own flags; with those flags off — which is how Slice 1 ships — this
 * sweep IS the whole engine, degraded in coverage and correct in behaviour.
 *
 * Sweep-is-the-retry, the readmissions posture: nothing is queued and nothing is
 * marked failed. A source that faulted this tick simply did not observe anything, the
 * affected instrument widened to a range and said so on the card, and the next tick
 * tries again. The only thing a fault can cost is an input.
 *
 * The clock enters here, ONCE, and is passed down as arguments — `todayIst` and
 * `computedAt`. Everything below this line is pure.
 */

import {
  bookingComorbidityObservations, composeSnapshot, creatinineObservation,
  icdObservations, procedureObservation, PAC_NONE,
  type EpisodeFacts, type Observation, type PacState, type PreopInputId, type PreopSnapshot,
} from '../preop-assemble-core';
import {
  fetchCreatinine, fetchHospitalNames, fetchOpdComorbidities, fetchOpdIcd, fetchPacReports,
  fetchUpcomingEpisodes,
  type PacRow, type PreopEpisodeRow,
} from './db13';
import {
  diseaseObservations, opdComorbidityObservations, rxObservations,
} from '../preop-harvest-core';
import {
  pacAgeMismatch, pacBodyMetrics, pacObservations, parsePacComponentJson,
  type ParsedPac,
} from '../preop-pac-map-core';
import {
  PREOP_ENGINE_VERSION, readDecisions, readRails, recordSweep, saveExtraction, saveNarrative,
  saveSnapshot, type SaveOutcome,
} from './store';
import {
  preopExtractMode, preopSuggestFields, suggestOne, PREOP_SUGGEST_BUDGET_MS,
  type SuggestCall, type SuggestOneResult,
} from './suggest';
import { narrateOne, preopNarrativeEnabled, type NarrativeCall } from './narrative';
import {
  autoAcceptable, decisionObservations, openSuggestions, redundantSuggestions,
  type PreopDecision, type PreopExtractMode, type PreopSuggestionRecord,
} from '../preop-suggest-core';
import { extractionSourceFingerprint } from '../preop-extract-core';
import {
  PREOP_NARRATIVE_BUDGET_MS, PREOP_NARRATIVE_MAX_PER_TICK, type PreopNarrative,
} from '../preop-narrative-core';

// The rails' switches live beside the rails they gate (lib/preop/suggest.ts,
// lib/preop/narrative.ts) and are re-exported here because the worker route reads them off
// the sweep's own module.
export { preopExtractMode, preopNarrativeEnabled };

/**
 * Which rails run this tick.
 *
 * B8 replaced the extraction BOOLEAN with a MODE — off | suggest | score — and the change is
 * not cosmetic. `suggest` runs the model and shows what it found on the case page WITHOUT
 * touching a single score; only a named human pressing Confirm can turn a suggestion into an
 * input. `score` additionally auto-accepts the field classes that have earned it through
 * B8d, and while PROMOTED_CLASSES is empty it behaves exactly as `suggest`.
 *
 * The OVERRIDE exists for one purpose only — measuring a rail without committing to it — and
 * the worker route refuses to honour it unless the tick is a dry run that writes nothing.
 */
export interface PreopRails { extract: PreopExtractMode; narrative: boolean }

export function preopRailsFromEnv(): PreopRails {
  return { extract: preopExtractMode(), narrative: preopNarrativeEnabled() };
}

/**
 * THE LLM BOX. The worker's maxDuration is 300 s and the deterministic sweep measured
 * 3.4–5.7 s (one 55 s outlier under Metabase contention). This is the ceiling on what the
 * two rails may add on top, checked BEFORE each leg starts rather than after it overruns:
 * a leg is only begun if its own budget still fits inside what is left. 180 s leaves the
 * measured slow tick and the whole deterministic term inside the box with room over.
 * ⚠️ Any change to this, to the per-leg budgets, or to maxDuration moves the others in
 * the same commit — the cron covenant, applied to the model legs.
 */
export const PREOP_LLM_BUDGET_MS = 180_000;
/**
 * Opus is paced (PREOP_NARRATIVE_MAX_PER_TICK); the suggestion leg is paced too, so one
 * sweep after a bulk PAC import cannot spend the whole box on new text.
 *
 * ⚠️ B8 CUT THIS FROM 8 TO 3, and the arithmetic is the reason: the leg is now THREE reads
 * per episode rather than one, so its per-episode ceiling went from 60 s to 135 s. Three
 * episodes × 135 s = 405 s, which the 180 s LLM budget refuses long before the cap does —
 * exactly as designed, the budget binding rather than the cap. A settled board still makes
 * zero calls, because the source-fingerprint rail is unchanged.
 */
export const PREOP_EXTRACT_MAX_PER_TICK = 3;

/** How far ahead the board looks. The mockup's tile counts "surgery date today or later". */
export const PREOP_HORIZON_DAYS = 60;

/** A PAC counts for an episode when it was finalized in this window around the surgery. */
export const PAC_WINDOW_DAYS_BEFORE = 90;
export const PAC_WINDOW_DAYS_AFTER = 1;

// ── date arithmetic, done once, in IST ──────────────────────────────────────────

/** Whole days from `todayIst` to `surgeryDate`, both YYYY-MM-DD. null when unknown. */
export function daysBetweenDays(todayIst: string, surgeryDate: string | null): number | null {
  if (!surgeryDate || !/^\d{4}-\d{2}-\d{2}$/.test(surgeryDate) || !/^\d{4}-\d{2}-\d{2}$/.test(todayIst)) return null;
  const a = Date.parse(`${todayIst}T00:00:00Z`);
  const b = Date.parse(`${surgeryDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** The IST calendar day for an instant — the sweep's own "today". */
export function istDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/**
 * The PAC report that belongs to THIS episode: the latest final report inside the
 * window around the surgery date. The bridge is patient-level (individuals.kx_uhid), so
 * a patient with two episodes would otherwise inherit the same PAC for both — the
 * window is what keeps one anaesthetist's evaluation attached to one operation.
 * With no surgery date, the latest final report stands.
 */
export function pacForEpisode(reports: PacRow[], surgeryDate: string | null): PacRow | null {
  const finals = reports.filter((r) => (r.status ?? '').toLowerCase() === 'final' && r.createdAt);
  if (!finals.length) return null;
  const inWindow = surgeryDate
    ? finals.filter((r) => {
        const d = daysBetweenDays(String(r.createdAt).slice(0, 10), surgeryDate);
        return d != null && d >= -PAC_WINDOW_DAYS_AFTER && d <= PAC_WINDOW_DAYS_BEFORE;
      })
    : finals;
  const pool = inWindow.length ? inWindow : [];
  if (!pool.length) return null;
  return pool.reduce((best, r) => (String(r.createdAt) > String(best.createdAt) ? r : best), pool[0]);
}

// ── one episode's observations ──────────────────────────────────────────────────

export interface EpisodeSources {
  creatinine: Array<{ value: number | null; unit: string | null; at: string | null }>;
  icd: Array<{ codes: string[]; at: string | null; ref: string | null }>;
  /** B8a · the sixth deterministic source: structured OPD comorbidity names */
  comorbidities?: Array<{ names: string[]; at: string | null; ref: string | null }>;
  pac: PacRow | null;
  /** the hospital's NAME, resolved from its uid — the uid itself when the lookup failed */
  hospitalName?: string | null;
}

export interface AssembledEpisode {
  facts: EpisodeFacts;
  observations: Observation[];
  notClosedBy: PreopInputId[];
  bookingEnumerated: boolean;
  bookingOnly: boolean;
  pac: PacState;
  unmappedBookingTerms: string[];
  unmatchedIcd: string[];
  /** B3: the mapped PAC, for the case page. null when no report is attached. */
  parsedPac: ParsedPac | null;
  /** B3: how many instrument inputs the PAC actually supplied */
  pacInputCount: number;
  /** B3: the PAC's own recorded age disagrees with the dob-derived age by this many years */
  pacAgeMismatch: number | null;
  /** B8a: what the deterministic harvest found, for the report and the coverage tally */
  harvest: {
    rx: number;
    disease: number;
    /** disease names that appeared but were governed by a negation — observed NOTHING */
    negationSuppressed: string[];
    /** names in the curated list that reach no instrument (hypothyroidism today) */
    diseaseUnmapped: string[];
    comorbidityMatched: string[];
    comorbidityUnmapped: string[];
  };
}

/**
 * B8a · the PAC boxes the deterministic harvest reads. Every one is a `verbatim` field on
 * the PAC map — the boxes lib/preop-pac-map-core.ts deliberately refuses to interpret. B8a
 * does not interpret them either: it matches a DRUG NAME against a reviewed dictionary and
 * a DISEASE NAME against a curated list, and anything needing a judgement stays for B8b.
 */
export const HARVEST_FIELDS: Array<{ id: string; label: string }> = [
  { id: 'pac_other_history', label: 'PAC · other medical history' },
  { id: 'pac_meds_note', label: 'PAC · medication note' },
  { id: 'pac_cvs_note', label: 'PAC · cardiovascular note' },
  { id: 'pac_endo_note', label: 'PAC · endocrine note' },
  { id: 'pac_pulm_note', label: 'PAC · pulmonary note' },
  { id: 'pac_renal_note', label: 'PAC · renal note' },
  { id: 'pac_examination', label: 'PAC · physical examination' },
];

/** The text of each harvest field that actually has any, keyed by field id. */
export function harvestTexts(parsedPac: ParsedPac | null): Array<{ id: string; label: string; text: string }> {
  const out: Array<{ id: string; label: string; text: string }> = [];
  for (const f of HARVEST_FIELDS) {
    const v = parsedPac?.fields?.[f.id]?.text;
    if (typeof v === 'string' && v.trim()) out.push({ ...f, text: v.trim() });
  }
  return out;
}

/**
 * Turn one episode row plus its sources into the argument list composeSnapshot wants.
 * PURE — every fetch already happened.
 */
export function assembleEpisode(ep: PreopEpisodeRow, src: EpisodeSources): AssembledEpisode {
  const observations: Observation[] = [];

  // 1 · the booking form: the procedure's risk class and the comorbidity enumeration
  const proc = procedureObservation(ep.procedure, ep.docId);
  if (proc) observations.push(proc);
  const booking = bookingComorbidityObservations(ep.comorbidities, ep.docId, ep.createdAt);
  observations.push(...booking.observations);

  // 2 · OPD: structured ICD codes off the member's consults
  const unmatchedIcd: string[] = [];
  for (const row of src.icd) {
    const mapped = icdObservations(row.codes, row.at, row.ref);
    observations.push(...mapped.observations);
    unmatchedIcd.push(...mapped.unmatched);
  }

  // 3 · the lab: the newest creatinine wins (the fetch returns oldest first)
  const newestCreat = src.creatinine.length ? src.creatinine[src.creatinine.length - 1] : null;
  if (newestCreat) {
    const obs = creatinineObservation(newestCreat.value, newestCreat.unit, newestCreat.at, 'eka');
    if (obs) observations.push(obs);
  }

  // 4 · the PAC. B3 maps the template's opaque keys to semantic fields and feeds the
  //     DETERMINISTIC ones — coded review-of-systems values, medication checkboxes and
  //     the investigations creatinine — as PAC-sourced observations, which outrank
  //     BOOKING and OPD. Free text (diagnosis, other history, examination) is carried
  //     for display and read by nobody: inferring a condition from prose is B5.
  const parsedPac = src.pac ? parsePacComponentJson(src.pac.componentJson) : null;
  let pacInputCount = 0;
  if (src.pac && parsedPac) {
    const obs = pacObservations(parsedPac, src.pac.createdAt, src.pac.uid);
    pacInputCount = obs.length;
    observations.push(...obs);
  }
  // 4b · B8a · THE DETERMINISTIC HARVEST over the PAC's verbatim boxes. This is the half of
  //      B7's extraction rail that a TABLE can do: a reviewed drug dictionary whose ban on
  //      medication→diagnosis is a category rather than a blocklist, and a curated
  //      disease-NAME list with a negation guard biased to miss rather than to guess. Both
  //      are deterministic, reproducible and free — which is precisely what B7 measured the
  //      model rail could not promise about these same facts.
  const harvest = {
    rx: 0, disease: 0,
    negationSuppressed: [] as string[],
    diseaseUnmapped: [] as string[],
    comorbidityMatched: [] as string[],
    comorbidityUnmapped: [] as string[],
  };
  for (const f of harvestTexts(parsedPac)) {
    const rx = rxObservations(f.text, f.label, src.pac?.createdAt ?? null, src.pac?.uid ?? null);
    harvest.rx += rx.length;
    observations.push(...rx);
    const dz = diseaseObservations(f.text, f.label, src.pac?.createdAt ?? null, src.pac?.uid ?? null);
    harvest.disease += dz.observations.length;
    harvest.negationSuppressed.push(...dz.suppressedByNegation);
    harvest.diseaseUnmapped.push(...dz.unmapped);
    observations.push(...dz.observations);
  }

  // 5 · B8a · the sixth deterministic source — the OPD comorbidity list. Structured, not
  //     prose; ranked with BOOKING and OPD because it is a record, not a measurement.
  for (const row of src.comorbidities ?? []) {
    const m = opdComorbidityObservations(row.names, row.at, row.ref);
    observations.push(...m.observations);
    harvest.comorbidityMatched.push(...m.matched);
    harvest.comorbidityUnmapped.push(...m.unmapped);
  }

  const pac: PacState = src.pac
    ? {
        onFile: true,
        status: src.pac.status,
        // The anaesthetist's conclusion box when they filled it, the note's closing line
        // otherwise. Quoted verbatim either way, never paraphrased, never replaced.
        verdict: parsedPac?.conclusion ?? src.pac.closingLine,
        reportUid: src.pac.uid,
        finalizedAt: src.pac.createdAt,
        workflowStatus: ep.pacWorkflowStatus,
        workflowLoggedAt: ep.pacWorkflowLoggedAt,
      }
    : { ...PAC_NONE, workflowStatus: ep.pacWorkflowStatus, workflowLoggedAt: ep.pacWorkflowLoggedAt };

  const facts: EpisodeFacts = {
    episodeKey: ep.docId,
    individualUid: ep.individualUid,
    uhid: ep.uhid,
    patientName: ep.patientName,
    age: ep.age,
    sex: ep.sex,
    procedure: ep.procedure,
    hospital: src.hospitalName ?? ep.hospitalUid,
    surgeryDate: ep.surgeryDate,
    surgeon: null,           // treating_doctor_uid is a uid, not a name — B4 resolves it
    department: null,
  };

  return {
    facts,
    observations,
    notClosedBy: booking.notClosedBy,
    bookingEnumerated: booking.enumerated,
    // No OPD consult, no lab, no PAC: the booking form is the only document on file.
    bookingOnly: src.icd.length === 0 && src.creatinine.length === 0 && src.pac === null,
    pac,
    unmappedBookingTerms: booking.unmapped,
    unmatchedIcd,
    parsedPac,
    pacInputCount,
    pacAgeMismatch: parsedPac ? pacAgeMismatch(parsedPac, ep.age) : null,
    harvest,
  };
}

// ── the sweep ───────────────────────────────────────────────────────────────────

export interface PreopRailTally {
  /** the rail ran this tick */
  on: boolean;
  /** episodes where the rail had something to work on */
  eligible: number;
  /** MODEL CALLS ACTUALLY MADE. The number that matters: on a settled board it is 0. */
  called: number;
  /** unchanged source text ⇒ the stored reading answered and no model ran */
  reused: number;
  /** nothing to read / nothing to say */
  skippedNoText: number;
  /** the LLM box or the per-tick cap stopped the leg before it started */
  skippedBudget: number;
  failed: number;
  ms: number;
  /** B8b: MODEL READS made, three per fresh suggestion — `called` counts episodes, this
   *  counts calls, and the two differ by design now. */
  reads: number;
  outcomes: Record<string, number>;
}

export interface PreopCaseTrace {
  episodeKey: string;
  tier: string;
  fingerprint: string;
  rcri: [number | null, number | null];
  mfi5: [number | null, number | null];
  charlson: [number | null, number | null];
  snapshot?: PreopSnapshot;
  suggestions?: PreopSuggestionRecord | null;
  /** suggestions not yet decided AND not already agreed with by the record */
  open?: number;
  /** suggestions the record already answered the same way — counted, never offered */
  redundant?: number;
  decisions?: PreopDecision[];
  narrative?: PreopNarrative | null;
  extractOutcome?: string;
}

export interface PreopSweepResult {
  engine: string;
  todayIst: string;
  episodes: number;
  written: Record<SaveOutcome, number>;
  byTier: Record<string, number>;
  needsReview: number;
  pacLinked: number;
  pacWorkflowCompleteWithoutReport: number;
  bookingOnly: number;
  withCreatinine: number;
  withIcd: number;
  notComputable: number;
  /** sources that FAULTED this tick — every coverage number above is a floor, not a fact,
   *  whenever this is non-empty (the 26 Aug lesson: a 504'd ICD query reported "0") */
  degradedSources: string[];
  unmappedBookingTerms: Record<string, number>;
  unmatchedIcd: Record<string, number>;
  /** B5/B6 — which rails ran and what they cost. Reported on EVERY tick, dark or not. */
  rails: { requested: PreopRails; extraction: PreopRailTally; narrative: PreopRailTally };
  /** B8a — what the deterministic harvest found, by kind */
  harvest: {
    rxObservations: number;
    diseaseObservations: number;
    negationSuppressed: Record<string, number>;
    diseaseUnmapped: Record<string, number>;
    comorbidityMatched: Record<string, number>;
    comorbidityUnmapped: Record<string, number>;
  };
  /** B8b — suggestions MADE, by input id. None of these scored anything. */
  suggestedInputs: Record<string, number>;
  /** B8b — of those, how many a clinician would actually be shown, and how many the record
   *  had already answered the same way (counted, never offered). */
  suggestionsOffered: number;
  suggestionsRedundant: number;
  /** B8b — classes where the three reads did not agree unanimously somewhere on the board */
  splitSuggestions: string[];
  /** B8b — proposals a gate threw away before they were ever offered, by reason.
   *  `medication_inference` is the B7 rabeprazole defect being refused in public. */
  droppedByGate: Record<string, number>;
  /** B8b — inputs a HUMAN confirmed, by input id. The only model-adjacent path to a score. */
  confirmedInputs: Record<string, number>;
  /** B7 — per-episode detail, only when the caller asks for it (the golden-set harness) */
  cases?: PreopCaseTrace[];
  ms: number;
  errors: string[];
}

const emptyTally = (on: boolean): PreopRailTally => ({
  on, eligible: 0, called: 0, reused: 0, skippedNoText: 0, skippedBudget: 0, failed: 0,
  ms: 0, reads: 0, outcomes: {},
});

export interface PreopSweepOptions {
  now?: Date;
  horizonDays?: number;
  dryRun?: boolean;
  /**
   * Force the rails on or off for THIS tick, regardless of the environment. Used to
   * MEASURE a rail without committing to it. The worker route only honours it on a dry
   * run; the golden-set harness uses it directly.
   */
  rails?: Partial<PreopRails>;
  /**
   * An in-memory extraction cache that stands in for the stored one. The B7 anti-flap
   * harness threads the SAME map through two consecutive runs, which is what exercises
   * the reuse path without writing a byte to production.
   */
  extractionCache?: Map<string, PreopSuggestionRecord | null>;
  /** episode keys to sweep INSTEAD of the upcoming window (the golden set) */
  onlyEpisodes?: string[];
  /** collect per-episode detail into result.cases (the validation pack's raw material) */
  collect?: boolean;
  /** the whole snapshot on each collected case — heavy; the pack's hand-check sample only */
  collectSnapshots?: boolean;
  llmBudgetMs?: number;
  /** test seams — production never passes them */
  suggestCall?: SuggestCall;
  narrativeCall?: NarrativeCall;
}

/**
 * One tick. Idempotent on (episode_key, PREOP_ENGINE_VERSION): a second tick over
 * unchanged evidence recomputes the same fingerprint and lib/preop/store.ts writes
 * nothing at all — no finding row, no version row. That is the B2 gate, and B5 does not
 * weaken it: an extraction is keyed on the fingerprint of its SOURCE TEXT, so unchanged
 * text makes no call, produces the same observations, and lands on the same fingerprint.
 */
export async function runPreopSweep(opts: PreopSweepOptions = {}): Promise<PreopSweepResult> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const todayIst = istDay(now);
  const computedAt = now.toISOString();
  const errors: string[] = [];
  const rails: PreopRails = { ...preopRailsFromEnv(), ...(opts.rails ?? {}) };
  const llmBudgetMs = opts.llmBudgetMs ?? PREOP_LLM_BUDGET_MS;
  const spent = () => Date.now() - started;
  /** A leg is only STARTED if its own ceiling still fits in what is left of the box. */
  const roomFor = (legMs: number) => spent() + legMs <= llmBudgetMs;

  const episodeFetch = await fetchUpcomingEpisodes(opts.horizonDays ?? PREOP_HORIZON_DAYS);
  if (episodeFetch.error) errors.push(episodeFetch.error);
  const only = opts.onlyEpisodes?.length ? new Set(opts.onlyEpisodes) : null;
  const episodes = only ? episodeFetch.rows.filter((e) => only.has(e.docId)) : episodeFetch.rows;
  const individualUids = episodes.map((e) => e.individualUid);
  const uhids = episodes.map((e) => e.uhid).filter((u): u is string => !!u);

  const [creat, icd, pacs, hospitals] = await Promise.all([
    fetchCreatinine(individualUids),
    fetchOpdIcd(individualUids),
    fetchPacReports(uhids),
    fetchHospitalNames(),
  ]);
  // B8a · the sixth deterministic source. Unlike the rails it is NOT flag-gated: it is
  // structured data that feeds the score, so it runs on every tick like the ICD codes do.
  const opdComorb = await fetchOpdComorbidities(individualUids);
  const hospitalName = new Map(hospitals.rows.map((h) => [h.uid, h.name]));
  // A source that FAULTED and a source that is genuinely empty produce the same rows and
  // must never produce the same report. Both the error line and the degraded flag ride
  // all the way out to the response and the heartbeat row.
  const degraded: string[] = [];
  for (const f of [creat, icd, pacs, hospitals, opdComorb]) if (f.error) { errors.push(f.error); degraded.push(f.error.split(':')[0]); }
  const creatRows = creat.rows, icdRows = icd.rows, pacRows = pacs.rows;

  const creatByUid = new Map<string, EpisodeSources['creatinine']>();
  for (const r of creatRows) {
    const list = creatByUid.get(r.individualUid) ?? [];
    list.push({ value: r.value, unit: r.unit, at: r.at });
    creatByUid.set(r.individualUid, list);
  }
  const icdByUid = new Map<string, EpisodeSources['icd']>();
  for (const r of icdRows) {
    const list = icdByUid.get(r.individualUid) ?? [];
    list.push({ codes: r.codes, at: r.at, ref: r.ref });
    icdByUid.set(r.individualUid, list);
  }
  const pacByUhid = new Map<string, PacRow[]>();
  for (const r of pacRows) {
    const list = pacByUhid.get(r.uhid) ?? [];
    list.push(r);
    pacByUhid.set(r.uhid, list);
  }
  const comorbByUid = new Map<string, EpisodeSources['comorbidities']>();
  for (const r of opdComorb.rows) {
    const list = comorbByUid.get(r.individualUid) ?? [];
    list.push({ names: r.names, at: r.at, ref: r.ref });
    comorbByUid.set(r.individualUid, list);
  }

  // The stored rail artefacts for exactly these episodes, in one round trip. Read BEFORE
  // any snapshot is composed — that is what makes "unchanged text ⇒ no call" hold ACROSS
  // ticks and not merely within one.
  const railStore = rails.extract !== 'off' || rails.narrative
    ? await readRails(episodes.map((e) => e.docId))
    : { byKey: new Map(), error: null };
  if (railStore.error) { errors.push(railStore.error); degraded.push('preop rails'); }

  // B8b · the decisions are read on EVERY tick, whatever the mode. A confirmation is a fact
  // about a person's judgement, not an output of the rail, and turning the rail off must
  // never silently retract one.
  const decisionStore = await readDecisions(episodes.map((e) => e.docId));
  if (decisionStore.error) { errors.push(decisionStore.error); degraded.push('preop decisions'); }

  const written: Record<SaveOutcome, number> = { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
  const byTier: Record<string, number> = {};
  const unmappedBookingTerms: Record<string, number> = {};
  const unmatchedIcd: Record<string, number> = {};
  const suggestedInputs: Record<string, number> = {};
  const confirmedInputs: Record<string, number> = {};
  const droppedByGate: Record<string, number> = {};
  const splitSuggestions = new Set<string>();
  let redundantSuggestionCount = 0;
  let openSuggestionCount = 0;
  const harvestTally = {
    rxObservations: 0, diseaseObservations: 0,
    negationSuppressed: {} as Record<string, number>,
    diseaseUnmapped: {} as Record<string, number>,
    comorbidityMatched: {} as Record<string, number>,
    comorbidityUnmapped: {} as Record<string, number>,
  };
  const extractTally = emptyTally(rails.extract !== 'off');
  const narrativeTally = emptyTally(rails.narrative);
  const cases: PreopCaseTrace[] = [];
  let needsReview = 0, pacLinked = 0, bookingOnly = 0, withCreatinine = 0, withIcd = 0;
  let notComputable = 0, pacWorkflowCompleteWithoutReport = 0;

  for (const ep of episodes) {
    const src: EpisodeSources = {
      creatinine: creatByUid.get(ep.individualUid) ?? [],
      icd: icdByUid.get(ep.individualUid) ?? [],
      comorbidities: comorbByUid.get(ep.individualUid) ?? [],
      pac: pacForEpisode(ep.uhid ? (pacByUhid.get(ep.uhid) ?? []) : [], ep.surgeryDate),
      hospitalName: ep.hospitalUid ? (hospitalName.get(ep.hospitalUid) ?? null) : null,
    };
    const a = assembleEpisode(ep, src);
    const stored = railStore.byKey.get(ep.docId) ?? null;

    // ── B8b · the suggestion rail ───────────────────────────────────────────────
    // What this DOES NOT do is the point: nothing here reaches an instrument. The rail
    // reads the PAC's prose three times, reconciles the reads, and stores what it found.
    // The score is computed from the record and from HUMAN confirmations, and from nothing
    // else — `suggestObs` below is empty unless a class has been promoted through B8d, and
    // PROMOTED_CLASSES is empty.
    let suggestions: PreopSuggestionRecord | null = opts.extractionCache?.get(ep.docId)
      ?? (stored?.extraction as PreopSuggestionRecord | null | undefined)
      ?? null;
    let extractOutcome: string | undefined;
    const suggestFields = preopSuggestFields(a.parsedPac);
    if (rails.extract !== 'off') {
      const t0 = Date.now();
      let r: SuggestOneResult;
      if (extractTally.called >= PREOP_EXTRACT_MAX_PER_TICK || !roomFor(PREOP_SUGGEST_BUDGET_MS)) {
        // The cap and the box are checked BEFORE the reads, and a leg we decline to start
        // leaves the STORED record in place — a budget skip must never look like a
        // retraction of a suggestion the rail has already made.
        r = { outcome: 'reused', record: suggestions, changed: false, reads: 0, latencyMs: 0 };
        if (Object.keys(suggestFields).length) { extractTally.skippedBudget++; extractOutcome = 'skipped_budget'; }
      } else {
        r = await suggestOne({ episodeKey: ep.docId, fields: suggestFields, stored: suggestions, now, call: opts.suggestCall });
        extractOutcome = r.outcome;
      }
      extractTally.ms += Date.now() - t0;
      extractTally.outcomes[extractOutcome ?? r.outcome] = (extractTally.outcomes[extractOutcome ?? r.outcome] ?? 0) + 1;
      if (Object.keys(suggestFields).length) extractTally.eligible++;
      if (r.reads) extractTally.called++;
      extractTally.reads += r.reads;
      if (r.outcome === 'reused') extractTally.reused++;
      if (r.outcome === 'no_text') extractTally.skippedNoText++;
      if (r.outcome === 'failed') { extractTally.failed++; if (r.error) errors.push(`${ep.docId} suggest: ${r.error}`); }
      else if (r.error) errors.push(`${ep.docId} suggest (partial): ${r.error}`);
      suggestions = r.record;
      opts.extractionCache?.set(ep.docId, suggestions);
      if (r.changed && r.record && !opts.dryRun) {
        const ok = await saveExtraction(ep.docId, { sourceFingerprint: r.record.sourceFingerprint, model: r.record.model, provider: r.record.provider, extractedAt: r.record.generatedAt }, r.record);
        if (!ok && written.inserted + written.updated > 0) errors.push(`${ep.docId}: suggestion write failed`);
      }
      for (const sg of suggestions?.suggestions ?? []) {
        suggestedInputs[sg.inputId] = (suggestedInputs[sg.inputId] ?? 0) + 1;
        if (sg.agreement !== 'unanimous') splitSuggestions.add(sg.inputId);
      }
      for (const d of suggestions?.dropped ?? []) droppedByGate[d.reason] = (droppedByGate[d.reason] ?? 0) + 1;
    }

    // ── the only path from a suggestion to a score ──────────────────────────────
    // A named human, shown the verbatim span, pressed Confirm. That becomes an observation
    // with HUMAN provenance, bound to the fingerprint of the text they were shown.
    const decisions: PreopDecision[] = (decisionStore.byKey.get(ep.docId) ?? []).map((d) => ({
      episodeKey: d.episode_key, inputId: d.input_id as PreopDecision['inputId'],
      status: d.status === 'absent' ? 'absent' : 'present',
      span: d.span ?? '', field: d.field ?? '',
      decision: d.decision === 'dismiss' ? 'dismiss' : 'confirm',
      decidedBy: d.decided_by, decidedAt: d.decided_at,
      sourceFingerprint: d.source_fingerprint,
    }));
    const currentSourceFp = Object.keys(suggestFields).length ? extractionSourceFingerprint(suggestFields) : null;
    const humanObs = decisionObservations(decisions, currentSourceFp);
    for (const o of humanObs) confirmedInputs[o.inputId] = (confirmedInputs[o.inputId] ?? 0) + 1;

    // B8d: auto-accepted classes only. Empty by construction until V ratifies one.
    const suggestObs = (suggestions?.suggestions ?? [])
      .filter((sg) => autoAcceptable(rails.extract, sg.inputId))
      .map((sg) => ({
        inputId: sg.inputId, status: sg.status,
        detail: `${sg.label} — auto-accepted (promoted class) from ${sg.fieldLabel}`,
        source: 'EXTRACTED' as const, confidence: sg.modelConfidence,
        extractedBy: suggestions?.model ? `${suggestions.provider ?? 'unknown'}:${suggestions.model}` : null,
        sourceSpan: sg.span, provenanceRef: sg.field, observedAt: suggestions?.generatedAt ?? null,
      }));
    const extractObs = [...humanObs, ...suggestObs];

    const snap: PreopSnapshot = composeSnapshot({
      engineVersion: PREOP_ENGINE_VERSION,
      episode: a.facts,
      observations: [...a.observations, ...extractObs],
      pac: a.pac,
      daysToSurgery: daysBetweenDays(todayIst, ep.surgeryDate),
      reviewed: false,                       // the store re-reads the stored review state
      // HUMAN observations are not extractions and are never gated by this: a clinician's
      // confirmation is a deterministic fact about a decision that was made. Only the
      // auto-accepted (promoted) EXTRACTED observations need the flag, and there are none.
      includeExtracted: rails.extract !== 'off',
      bookingEnumerated: a.bookingEnumerated,
      notClosedBy: a.notClosedBy,
      bookingOnly: a.bookingOnly,
      computedAt,
    });
    harvestTally.rxObservations += a.harvest.rx;
    harvestTally.diseaseObservations += a.harvest.disease;
    for (const n of a.harvest.negationSuppressed) harvestTally.negationSuppressed[n] = (harvestTally.negationSuppressed[n] ?? 0) + 1;
    for (const n of a.harvest.diseaseUnmapped) harvestTally.diseaseUnmapped[n] = (harvestTally.diseaseUnmapped[n] ?? 0) + 1;
    for (const n of a.harvest.comorbidityMatched) harvestTally.comorbidityMatched[n] = (harvestTally.comorbidityMatched[n] ?? 0) + 1;
    for (const n of a.harvest.comorbidityUnmapped) harvestTally.comorbidityUnmapped[n] = (harvestTally.comorbidityUnmapped[n] ?? 0) + 1;

    byTier[snap.tier.tier] = (byTier[snap.tier.tier] ?? 0) + 1;
    if (snap.tier.needsReview) needsReview++;
    if (a.pac.onFile) pacLinked++;
    else if ((ep.pacWorkflowStatus ?? '').toUpperCase() === 'COMPLETED') pacWorkflowCompleteWithoutReport++;
    if (a.bookingOnly) bookingOnly++;
    if (src.creatinine.length) withCreatinine++;
    if (src.icd.length) withIcd++;
    if (snap.rcri.kind === 'not_computable' || snap.mfi5.kind === 'not_computable' || snap.charlson.kind === 'not_computable') notComputable++;
    for (const t of a.unmappedBookingTerms) unmappedBookingTerms[t] = (unmappedBookingTerms[t] ?? 0) + 1;
    for (const c of a.unmatchedIcd) unmatchedIcd[c] = (unmatchedIcd[c] ?? 0) + 1;

    let saved: SaveOutcome | null = null;
    if (!opts.dryRun) {
      const r = await saveSnapshot(snap);
      saved = r.outcome;
      written[r.outcome]++;
      if (r.error) errors.push(`${ep.docId}: ${r.error}`);
    }

    // ── B6 · the narrative rail ─────────────────────────────────────────────────
    // Regenerated ONLY when the reading has moved: the stored narrative carries the
    // fingerprint it was written for, so "a new snapshot version minted" is a string
    // comparison rather than a guess, and a settled board makes no calls at all.
    let narrative: PreopNarrative | null = (stored?.narrative as PreopNarrative | null | undefined) ?? null;
    if (rails.narrative) {
      const stale = (stored?.narrativeFingerprint ?? null) !== snap.fingerprint;
      if (!stale) { narrativeTally.reused++; narrativeTally.outcomes.reused = (narrativeTally.outcomes.reused ?? 0) + 1; }
      else {
        narrativeTally.eligible++;
        if (narrativeTally.called >= PREOP_NARRATIVE_MAX_PER_TICK || !roomFor(PREOP_NARRATIVE_BUDGET_MS)) {
          narrativeTally.skippedBudget++;
          narrativeTally.outcomes.skipped_budget = (narrativeTally.outcomes.skipped_budget ?? 0) + 1;
        } else {
          const t0 = Date.now();
          const r = await narrateOne({ snapshot: snap, now, call: opts.narrativeCall });
          narrativeTally.ms += Date.now() - t0;
          narrativeTally.called++;
          if (!r.ok || !r.narrative) {
            narrativeTally.failed++;
            narrativeTally.outcomes.failed = (narrativeTally.outcomes.failed ?? 0) + 1;
            if (r.reason) errors.push(`${ep.docId} narrative: ${r.reason}`);
          } else {
            narrative = r.narrative;
            const k = r.narrative.valid ? 'valid' : `invalid_${r.narrative.invalidReason}`;
            narrativeTally.outcomes[k] = (narrativeTally.outcomes[k] ?? 0) + 1;
            if (!opts.dryRun) await saveNarrative(ep.docId, r.narrative, r.narrative);
          }
        }
      }
    }

    // The resolved status per input, so a suggestion that merely agrees with the record can
    // be counted rather than put in front of a clinician (see openSuggestions).
    const resolvedStatus: Record<string, string> = {};
    for (const i of snap.inputs) resolvedStatus[i.inputId] = i.status;
    redundantSuggestionCount += redundantSuggestions(suggestions, resolvedStatus);
    openSuggestionCount += openSuggestions(suggestions, decisions, resolvedStatus).length;

    if (opts.collect) {
      cases.push({
        episodeKey: ep.docId,
        tier: snap.tier.tier,
        fingerprint: snap.fingerprint,
        rcri: [snap.rcri.lo, snap.rcri.hi],
        mfi5: [snap.mfi5.lo, snap.mfi5.hi],
        charlson: [snap.charlson.lo, snap.charlson.hi],
        ...(opts.collectSnapshots ? { snapshot: snap } : {}),
        suggestions,
        open: openSuggestions(suggestions, decisions, resolvedStatus).length,
        redundant: redundantSuggestions(suggestions, resolvedStatus),
        decisions,
        narrative, extractOutcome,
      });
    }
    void saved;
  }

  const ms = Date.now() - started;
  const result: PreopSweepResult = {
    engine: PREOP_ENGINE_VERSION, todayIst, episodes: episodes.length, written, byTier,
    needsReview, pacLinked, pacWorkflowCompleteWithoutReport, bookingOnly,
    withCreatinine, withIcd, notComputable, unmappedBookingTerms, unmatchedIcd, ms,
    degradedSources: degraded,
    rails: { requested: rails, extraction: extractTally, narrative: narrativeTally },
    harvest: harvestTally,
    suggestedInputs,
    suggestionsOffered: openSuggestionCount,
    suggestionsRedundant: redundantSuggestionCount,
    splitSuggestions: [...splitSuggestions].sort(),
    droppedByGate,
    confirmedInputs,
    ...(opts.collect ? { cases } : {}),
    errors: errors.slice(0, 20),
  };
  if (!opts.dryRun) {
    await recordSweep({
      engineVersion: PREOP_ENGINE_VERSION, episodes: episodes.length,
      inserted: written.inserted, updated: written.updated, unchanged: written.unchanged,
      skipped: written.skipped, byTier, pacLinked, ms, degradedSources: degraded,
      notes: errors.length ? `${degraded.length ? `DEGRADED [${degraded.join(', ')}] ` : ''}${errors.slice(0, 3).join(' | ')}`.slice(0, 500) : null,
    });
  }
  return result;
}
