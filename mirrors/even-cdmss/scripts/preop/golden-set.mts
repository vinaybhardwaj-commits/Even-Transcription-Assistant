/**
 * scripts/preop/golden-set.mts — the B8 measurement harness (B7's, rewritten for the mode).
 *
 *   npx tsx --env-file=.env.local scripts/preop/golden-set.mts [--limit N] [--out F] [--no-model]
 *
 * READ-ONLY against production: it never opens lib/preop/store.ts, never writes a finding, a
 * version, a suggestion or a decision. Everything it measures, it measures by running the
 * SAME functions the sweep runs, over an in-memory cache.
 *
 * WHAT IT PRODUCES, in the order B8's gates need it:
 *
 *   B8a  every input the deterministic harvest added, traced to its rule and its span; the
 *        same run twice, to show the harvest is reproducible in a way B7's rail was not;
 *        and the list of tier moves it causes, because a deterministic move is legitimate
 *        ripening and still has to be looked at.
 *   B8b  off vs suggest ⇒ byte-identical scores (the score-equality proof, extended: only a
 *        human Confirm may move one); 3-read stability per field class; the drop table, with
 *        rabeprazole in it; anti-flap (unchanged fingerprints ⇒ zero model calls).
 *
 * `--no-model` runs the B8a half alone — deterministic, ₹0, and enough to gate the harvest.
 */
import { writeFileSync } from 'node:fs';
import {
  fetchCreatinine, fetchHospitalNames, fetchOpdComorbidities, fetchOpdIcd,
  fetchPacCoveredEpisodes, fetchPacReports, type PacRow,
} from '../../lib/preop/db13.ts';
import {
  assembleEpisode, daysBetweenDays, harvestTexts, istDay, pacForEpisode,
  type EpisodeSources,
} from '../../lib/preop/run.ts';
import { preopSuggestFields, preopSuggestModel, suggestOne } from '../../lib/preop/suggest.ts';
import { composeSnapshot, type PreopSnapshot } from '../../lib/preop-assemble-core.ts';
import { diseaseObservations, rxObservations } from '../../lib/preop-harvest-core.ts';
import {
  spanIsMedicationOnly, stabilityByClass, type PreopSuggestionRecord,
} from '../../lib/preop-suggest-core.ts';
import { extractionSourceFingerprint } from '../../lib/preop-extract-core.ts';
import { PREOP_ENGINE_VERSION } from '../../lib/preop/store.ts';

const argv = process.argv.slice(2);
const arg = (k: string, d: number) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d;
};
const LIMIT = arg('--limit', 300);
const OUT = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'preop-b8-golden-set.json';
const NO_MODEL = argv.includes('--no-model');

const now = new Date();
const todayIst = istDay(now);
const computedAt = now.toISOString();

console.log(`B8 golden set · engine ${PREOP_ENGINE_VERSION} · model ${NO_MODEL ? 'SKIPPED (--no-model)' : (preopSuggestModel() ?? 'NONE CONFIGURED')} · ${todayIst} IST`);

// ── population ──────────────────────────────────────────────────────────────────

const eps = await fetchPacCoveredEpisodes(LIMIT);
if (eps.error) throw new Error(eps.error);
const episodes = eps.rows;
const uids = episodes.map((e) => e.individualUid);
const uhids = episodes.map((e) => e.uhid).filter((u): u is string => !!u);
console.log(`episodes ${episodes.length} · patients ${new Set(uids).size}`);

const [creat, icd, pacs, hospitals, comorb] = await Promise.all([
  fetchCreatinine(uids), fetchOpdIcd(uids), fetchPacReports(uhids), fetchHospitalNames(),
  fetchOpdComorbidities(uids),
]);
for (const f of [creat, icd, pacs, hospitals, comorb]) if (f.error) console.warn(`DEGRADED: ${f.error}`);

const byUid = <T extends { individualUid: string }>(rows: T[]) => {
  const m = new Map<string, T[]>();
  for (const r of rows) { const l = m.get(r.individualUid) ?? []; l.push(r); m.set(r.individualUid, l); }
  return m;
};
const creatBy = byUid(creat.rows), icdBy = byUid(icd.rows), comorbBy = byUid(comorb.rows);
const hospitalName = new Map(hospitals.rows.map((h) => [h.uid, h.name]));
const pacBy = new Map<string, PacRow[]>();
for (const r of pacs.rows) { const l = pacBy.get(r.uhid) ?? []; l.push(r); pacBy.set(r.uhid, l); }

function sourcesFor(ep: (typeof episodes)[number]): EpisodeSources {
  return {
    creatinine: (creatBy.get(ep.individualUid) ?? []).map((r) => ({ value: r.value, unit: r.unit, at: r.at })),
    icd: (icdBy.get(ep.individualUid) ?? []).map((r) => ({ codes: r.codes, at: r.at, ref: r.ref })),
    comorbidities: (comorbBy.get(ep.individualUid) ?? []).map((r) => ({ names: r.names, at: r.at, ref: r.ref })),
    pac: pacForEpisode(ep.uhid ? (pacBy.get(ep.uhid) ?? []) : [], ep.surgeryDate),
    hospitalName: ep.hospitalUid ? (hospitalName.get(ep.hospitalUid) ?? null) : null,
  };
}

// ── B8a · the harvest, twice ────────────────────────────────────────────────────

interface HarvestCase {
  key: string; who: string; procedure: string | null; surgeryDate: string | null;
  /** the snapshot as B7 shipped it: booking + OPD ICD + lab + mapped PAC, no harvest */
  before: PreopSnapshot;
  /** the same, with B8a's RX / disease-name / OPD-comorbidity observations added */
  after: PreopSnapshot;
  added: Array<{ inputId: string; status: string; source: string; detail: string | null }>;
  negationSuppressed: string[];
}

function composeFor(ep: (typeof episodes)[number], withHarvest: boolean): { snap: PreopSnapshot; added: HarvestCase['added']; suppressed: string[] } {
  const src = sourcesFor(ep);
  const a = assembleEpisode(ep, src);
  const suppressed = a.harvest.negationSuppressed;
  if (withHarvest) {
    const snap = composeSnapshot({
      engineVersion: PREOP_ENGINE_VERSION, episode: a.facts, observations: a.observations,
      pac: a.pac, daysToSurgery: daysBetweenDays(todayIst, ep.surgeryDate), reviewed: false,
      includeExtracted: false, bookingEnumerated: a.bookingEnumerated, notClosedBy: a.notClosedBy,
      bookingOnly: a.bookingOnly, computedAt,
    });
    const added = snap.inputs
      .filter((i) => i.source === 'RX' || (i.detail ?? '').includes('named in') || (i.detail ?? '').includes('OPD comorbidity list'))
      .map((i) => ({ inputId: i.inputId, status: i.status, source: i.source ?? '', detail: i.detail }));
    return { snap, added, suppressed };
  }
  // The "before" arm: strip exactly what B8a adds, and nothing else.
  const harvestObs = new Set<unknown>();
  for (const f of harvestTexts(a.parsedPac)) {
    for (const o of rxObservations(f.text, f.label)) harvestObs.add(`${o.inputId}|RX`);
    for (const o of diseaseObservations(f.text, f.label).observations) harvestObs.add(`${o.inputId}|NAME`);
  }
  const before = a.observations.filter((o) => !(o.source === 'RX' || (o.detail ?? '').includes('named in') || (o.detail ?? '').includes('OPD comorbidity list')));
  const snap = composeSnapshot({
    engineVersion: PREOP_ENGINE_VERSION, episode: a.facts, observations: before,
    pac: a.pac, daysToSurgery: daysBetweenDays(todayIst, ep.surgeryDate), reviewed: false,
    includeExtracted: false, bookingEnumerated: a.bookingEnumerated, notClosedBy: a.notClosedBy,
    bookingOnly: a.bookingOnly, computedAt,
  });
  return { snap, added: [], suppressed };
}

const harvest: HarvestCase[] = episodes.map((ep) => {
  const b = composeFor(ep, false);
  const w = composeFor(ep, true);
  return {
    key: ep.docId, who: `${ep.age ?? '?'} ${ep.sex ?? '?'}`, procedure: ep.procedure,
    surgeryDate: ep.surgeryDate, before: b.snap, after: w.snap, added: w.added,
    negationSuppressed: w.suppressed,
  };
});

// reproducibility: the same computation twice must be byte-identical
const harvestAgain = episodes.map((ep) => composeFor(ep, true).snap.fingerprint);
const harvestDrift = harvest.filter((h, i) => h.after.fingerprint !== harvestAgain[i]).map((h) => h.key);

const band = (s: PreopSnapshot, k: 'rcri' | 'mfi5' | 'charlson') => `${s[k].lo}-${s[k].hi}`;
const harvestMoves = harvest
  .map((h) => ({
    key: h.key, who: h.who, procedure: h.procedure,
    tier: { before: h.before.tier.tier, after: h.after.tier.tier },
    scores: (['rcri', 'mfi5', 'charlson'] as const).filter((k) => band(h.before, k) !== band(h.after, k))
      .map((k) => `${k} ${band(h.before, k)} → ${band(h.after, k)}`),
    added: h.added,
  }))
  .filter((m) => m.scores.length || m.tier.before !== m.tier.after);

const addedByInput: Record<string, number> = {};
for (const h of harvest) for (const a of h.added) addedByInput[`${a.inputId} (${a.source})`] = (addedByInput[`${a.inputId} (${a.source})`] ?? 0) + 1;
const suppressedByName: Record<string, number> = {};
for (const h of harvest) for (const n of h.negationSuppressed) suppressedByName[n] = (suppressedByName[n] ?? 0) + 1;

console.log(`B8a · harvest added inputs on ${harvest.filter((h) => h.added.length).length}/${harvest.length} episodes · ${harvestMoves.length} score moves · drift ${harvestDrift.length}`);

// ── B8b · the suggestion rail ───────────────────────────────────────────────────

interface SuggestCase { key: string; record: PreopSuggestionRecord | null; outcome: string; reads: number }
const suggestCases: SuggestCase[] = [];
let warmCalls = 0;

if (!NO_MODEL) {
  const cache = new Map<string, PreopSuggestionRecord | null>();
  let n = 0;
  for (const ep of episodes) {
    const fields = preopSuggestFields(assembleEpisode(ep, sourcesFor(ep)).parsedPac);
    const r = await suggestOne({ episodeKey: ep.docId, fields, stored: null, now });
    cache.set(ep.docId, r.record);
    suggestCases.push({ key: ep.docId, record: r.record, outcome: r.outcome, reads: r.reads });
    if (++n % 10 === 0) console.log(`  suggest: ${n}/${episodes.length}`);
  }
  // ANTI-FLAP: the same call with the stored record must make ZERO reads.
  for (const ep of episodes) {
    const fields = preopSuggestFields(assembleEpisode(ep, sourcesFor(ep)).parsedPac);
    const r = await suggestOne({ episodeKey: ep.docId, fields, stored: cache.get(ep.docId) ?? null, now });
    warmCalls += r.reads;
  }
  console.log(`B8b · ${suggestCases.filter((c) => c.reads).length} episodes read · warm reads ${warmCalls}`);
}

// off vs suggest: the scores must be identical, because a suggestion cannot score
const scoreEquality = harvest.map((h) => ({ key: h.key, fingerprint: h.after.fingerprint }));

const droppedByReason: Record<string, number> = {};
const droppedRows: Array<{ key: string; inputId: string; span: string; reason: string; detail?: string }> = [];
for (const c of suggestCases) {
  for (const d of c.record?.dropped ?? []) {
    droppedByReason[d.reason] = (droppedByReason[d.reason] ?? 0) + 1;
    droppedRows.push({ key: c.key, ...d });
  }
}
const suggestedByInput: Record<string, number> = {};
for (const c of suggestCases) for (const s of c.record?.suggestions ?? []) suggestedByInput[s.inputId] = (suggestedByInput[s.inputId] ?? 0) + 1;

// the rabeprazole gate, asserted on the live corpus rather than only in a unit test
const ppiSpans = suggestCases.flatMap((c) => (c.record?.suggestions ?? [])
  .filter((s) => spanIsMedicationOnly(s.span))
  .map((s) => ({ key: c.key, inputId: s.inputId, span: s.span })));

const report = {
  generatedAt: computedAt,
  engine: PREOP_ENGINE_VERSION,
  model: NO_MODEL ? null : (preopSuggestModel() ?? null),
  population: { episodes: episodes.length, patients: new Set(uids).size },
  b8a: {
    episodesWithAddedInputs: harvest.filter((h) => h.added.length).length,
    addedByInput,
    negationSuppressed: suppressedByName,
    reproducibilityDrift: harvestDrift,
    scoreMoves: harvestMoves,
  },
  b8b: NO_MODEL ? null : {
    episodesRead: suggestCases.filter((c) => c.reads).length,
    totalReads: suggestCases.reduce((t, c) => t + c.reads, 0),
    warmReads: warmCalls,
    suggestedByInput,
    stabilityByClass: stabilityByClass(suggestCases.map((c) => c.record)),
    droppedByReason,
    droppedRows,
    medicationOnlySpansThatSurvived: ppiSpans,
    sample: suggestCases.filter((c) => (c.record?.suggestions ?? []).length).slice(0, 12).map((c) => ({
      key: c.key,
      model: c.record?.model ?? null, provider: c.record?.provider ?? null, reads: c.record?.readCount ?? 0,
      suggestions: (c.record?.suggestions ?? []).map((s) => ({
        input: s.inputId, status: s.status, agreement: s.agreement, confidence: s.confidence,
        reads: s.reads, span: s.span, field: s.field,
      })),
      dropped: c.record?.dropped ?? [],
    })),
  },
  scoreEquality,
};

writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\nwrote ${OUT}`);
console.log(JSON.stringify({ ...report, b8a: { ...report.b8a, scoreMoves: `${harvestMoves.length} rows` }, b8b: report.b8b ? { ...report.b8b, droppedRows: droppedRows.length, sample: `${report.b8b.sample.length}` } : null, scoreEquality: `${scoreEquality.length}` }, null, 1).slice(0, 3000));

void extractionSourceFingerprint;
