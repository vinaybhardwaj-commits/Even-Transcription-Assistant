/**
 * lib/stay-library/build.ts — the IMPURE half of the stay library
 * (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P2 / §4, O9 / O10).
 *
 * One stay in, one library out: the discharge extract the IPD audit already stored, plus the OT,
 * PAC and progress rows already on db13, each turned into a ClinicalState by the pure builders in
 * ./core and written to `clinical_states`.
 *
 * IT INVENTS NO READS (§4, hard). Every db13 hop here is an EXISTING fetcher in
 * lib/readmission/db13.ts, called read-only and unmodified — `fetchOtNotes`, `fetchPacNotes`,
 * `fetchProgressNotes` — and the discharge document is the stored `ExtractedCase` from
 * `discharge_extracted_cases`. The only tables in play are the three `kx_clinical_template_*`
 * tables plus that extract store. If a fifth table ever looks necessary, the instruction is to STOP
 * and flag, not to add one here.
 *
 * FAIL CLOSED, EVERYWHERE (§4). Each document class is fetched independently and each failure is
 * local: a faulted OT hop costs the OT class and nothing else, and the stay still builds on what
 * exists. The three outcomes are kept apart all the way into storage — a fetch that FAULTED is
 * recorded `unavailable` and must never read as `absent`, because lying about which one happened is
 * how "no OT note" becomes "no operation".
 *
 * PHI. Template `note` / `component_json` are raw KX text and may carry a patient name. Every string
 * that becomes stored state goes through `deidText` bound to THIS stay's identity — the same choke
 * point lib/readmission/assemble.ts uses — and the pure builders take that scrubber as a required
 * argument, so a caller cannot forget it. The identity itself (name, UHID) is read here and stored
 * nowhere.
 */
import { fetchOtNotes, fetchPacNotes, fetchProgressNotes, type TemplateFetchResult } from '../readmission/db13';
import { deidText } from '../readmission/assemble';
import {
  OT_FACT_LABELS, allowlistedOtFacts, flattenTemplateRow, hasUsableText, pacWindow,
  parseComponentJson, type KxTemplateRow,
} from '../readmission-template-core';
import { readExtractedCaseAcrossVersions, DOC_EXTRACT_VERSION } from '../discharge-extract-store';
import { fetchIpdAdmissionHeader } from '../ipd-audit/db13';
import { sql } from '../db';
import { CLINICAL_STATE_VERSION, type ClinicalState } from '../clinical-state/schema';
import {
  absentSourceUid, dischargeState, narrativeDocState, otState, notAuditableState,
  procedureFactsOf, stayDocMetaOf,
  type Deidentifier, type DocKind, type NotAuditableReason, type OtFactInput, type StayDocStatus,
} from './core';
import { contaminationNotice, type ContaminationNotice } from './contamination';
import { readClinicalState, upsertClinicalState, type UpsertOutcome } from './store';

/** One built document, before it is written. */
export interface BuiltDoc {
  docKind: DocKind;
  sourceUid: string;
  status: StayDocStatus;
  reason?: NotAuditableReason;
  state: ClinicalState;
}

/** H4 — the upsert's three outcomes plus the one this file can decide on its own. */
export type BuildWriteOutcome = UpsertOutcome | 'refused_degrade';

export interface StayLibraryResult {
  encounterRef: string | null;
  memberUid: string | null;
  documents: BuiltDoc[];
  /** Per-class outcome in plain words, for the build report. */
  coverage: Record<DocKind, { status: StayDocStatus; reason?: NotAuditableReason; count: number }>;
  /** What was written, when `write` was set. Empty on a dry run. `refused_degrade` is H4's
   *  fourth outcome: the rebuild would have replaced a healthy stored row with a not_auditable
   *  one, and refused. */
  written: Record<string, BuildWriteOutcome>;
  /** Honest notes: a faulted hop, a missing header, a stay with no identity to scrub against. */
  notes: string[];
}

/** The audit row this library is built from. Only these columns are read. */
interface IpdAuditStayRow {
  document_id?: unknown;
  ip_uid?: unknown;
  member_id?: unknown;
}

const s = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/**
 * Build the library for ONE stay, named by its IPD audit row.
 *
 * `write: false` (the default) makes this a pure-read dry run: everything is fetched and built and
 * nothing is stored. That is the mode the orchestrator samples for span-cleanliness before P4's hard
 * human gate, and it is the safe default for a module that nothing consumes yet.
 */
export async function buildStayLibraryForAudit(a: {
  auditId: string;
  write?: boolean;
}): Promise<{ ok: true; result: StayLibraryResult } | { ok: false; status: number; error: string }> {
  let rows: Record<string, unknown>[];
  try {
    rows = (await (sql as unknown as (q: string, p: unknown[]) => Promise<Record<string, unknown>[]>)(
      `SELECT document_id, ip_uid, member_id FROM ipd_discharge_audits WHERE id = $1 LIMIT 1`,
      [a.auditId],
    ));
  } catch {
    return { ok: false, status: 503, error: 'the stay could not be read' };
  }
  const r = rows[0] as IpdAuditStayRow | undefined;
  if (!r) return { ok: false, status: 404, error: 'not found' };

  const documentId = s(r.document_id);
  const ipUid = s(r.ip_uid);
  const memberUid = s(r.member_id);
  if (!documentId) return { ok: false, status: 422, error: 'this audit row carries no document id' };

  return {
    ok: true,
    result: await buildStayLibrary({ documentId, encounterRef: ipUid, memberUid, write: a.write === true }),
  };
}

/**
 * Build the library for one stay from its identifiers. Split out from the row read so it is
 * callable by P3 (which will already hold them) without a second query.
 */
export async function buildStayLibrary(a: {
  documentId: string;
  encounterRef: string | null;
  memberUid: string | null;
  write?: boolean;
}): Promise<StayLibraryResult> {
  const notes: string[] = [];

  // The admission header gives the identity to scrub against and the dates the PAC window needs.
  // Best-effort: without it the scrubber falls back to shape-only redaction and PAC loses its
  // pre-admit hop — both are recorded, neither is guessed.
  const header = a.encounterRef ? await fetchIpdAdmissionHeader(a.encounterRef).catch(() => null) : null;
  if (a.encounterRef && !header) notes.push('no admission header for this stay — de-identification falls back to shape-only, and the PAC pre-admit window could not be built');

  const identity = { names: [header?.patientName ?? null], uhids: [header?.uhid ?? null] };
  const deid: Deidentifier = (text: string) => deidText(text, identity);
  const uhid = header?.uhid ?? null;
  const window = pacWindow(header?.admitDate ?? null, header?.dischargeDate ?? null);

  const documents: BuiltDoc[] = [];

  // ── discharge ──────────────────────────────────────────────────────────────────────────
  // H4 — THREE OUTCOMES, KEPT APART, and the version list is deliberate.
  //
  // The library reads diagnosis, procedure, medications, `rawNotes` and `courseSummary`. Every one
  // of those is present in a `doc-extract/1` row, so a `/1` row is fully usable HERE even though
  // R10 bumped the shared constant to `/2` for `verbatim_sections`, which this library never reads
  // (and which H-D12 puts in the DOT ship, not this one). Asking only for the default version made
  // a bump owned by another reader read as "this stay has no discharge summary" — measured on
  // production 29 Aug, deterministic, on 560 of 843 rows in the store. Newest usable version wins.
  const READABLE_EXTRACT_VERSIONS = [DOC_EXTRACT_VERSION, 'doc-extract/1'] as const;
  const read = await readExtractedCaseAcrossVersions(a.documentId, READABLE_EXTRACT_VERSIONS);
  if (read.outcome === 'found') {
    documents.push({
      docKind: 'discharge', sourceUid: a.documentId, status: 'ok',
      state: dischargeState({
        extracted: read.stored.extracted, documentId: a.documentId,
        encounterRef: a.encounterRef, deid, at: read.stored.extractedAt,
        extractionVersion: read.version,
      }),
    });
    if (read.version !== DOC_EXTRACT_VERSION) {
      notes.push(`the discharge summary was read at ${read.version}, not ${DOC_EXTRACT_VERSION} — the library's fields are all present at that version, and a bump made for another reader is not evidence this stay has no discharge summary`);
    }
  } else if (read.outcome === 'fetch_failed') {
    // A FAULT IS NOT AN ABSENCE. `unavailable` says the look failed; `no_document` would claim the
    // extract does not exist, which we have no basis for. The refuse-to-degrade guard below is what
    // stops this row replacing a healthy one.
    documents.push({
      docKind: 'discharge', sourceUid: a.documentId, status: 'not_auditable', reason: 'unavailable',
      state: notAuditableState({ docKind: 'discharge', reason: 'unavailable', encounterRef: a.encounterRef, sourceUid: a.documentId }),
    });
    notes.push(`the discharge extract look FAULTED (${read.error}) — recorded unavailable; this is not evidence the summary was never read`);
  } else {
    // Genuinely no usable row at ANY version the library can read. An honest gap in OUR library,
    // not a claim about the document.
    documents.push({
      docKind: 'discharge', sourceUid: a.documentId, status: 'not_auditable', reason: 'no_document',
      state: notAuditableState({ docKind: 'discharge', reason: 'no_document', encounterRef: a.encounterRef, sourceUid: a.documentId }),
    });
    notes.push(`no stored discharge extract for this document at ${READABLE_EXTRACT_VERSIONS.join(' or ')} — run the IPD audit first`);
  }

  // ── OT / PAC / progress ────────────────────────────────────────────────────────────────
  // All three hops run concurrently and independently: one class faulting must not cost another.
  const enc = a.encounterRef ?? '';
  const [ot, pac, progress] = enc
    ? await Promise.all([
      fetchOtNotes(enc, uhid ? { uhid, ipdNo: enc } : null).catch(() => failed()),
      fetchPacNotes(enc, uhid, window).catch(() => failed()),
      fetchProgressNotes(enc, uhid ? { uhid, ipdNo: enc } : null).catch(() => failed()),
    ])
    : [failed(), failed(), failed()];
  if (!enc) notes.push('this audit row carries no encounter id — the three template classes could not be looked for at all, and are recorded unavailable rather than absent');

  documents.push(...templateDocs('ot', ot, a.encounterRef, deid));
  documents.push(...templateDocs('pac', pac, a.encounterRef, deid));
  documents.push(...templateDocs('progress', progress, a.encounterRef, deid));

  if (ot.outcome === 'fetch_failed') notes.push('the operative-note look FAULTED — recorded unavailable; this is not evidence there was no operation');
  if (pac.outcome === 'fetch_failed') notes.push('the pre-anaesthetic look FAULTED — recorded unavailable');
  if (progress.outcome === 'fetch_failed') notes.push('the progress-note look FAULTED — recorded unavailable');
  if (pac.outcome === 'ok' && !window) notes.push('PAC rested on the encounter hop alone — no admit/discharge dates, so the pre-admit window hop could not run');

  // ── contamination guard (H2) ───────────────────────────────────────────────────────────
  // THE ONLY PLACE IN THE PROGRAMME WHERE BOTH SIDES ARE IN HAND. `dischargeState` and `otState`
  // are built independently and neither can see the other, so the comparison H-D4 asks for cannot
  // live in either. Here it can: the stay's documents are all built and none is written yet, which
  // is also the moment H-D5 requires — the taint must be stamped at WRITE time so it travels with
  // the stored fact and is still true when the OT row is later gone.
  const notice = stampContamination(documents);
  if (notice) {
    notes.push(
      `possible template contamination: the discharge names "${notice.dischargeProcedure}" and this stay's OT note names "${notice.otSurgery}" — they share no substantive term. The discharge-sourced procedure is stamped and will not promote to the spine.`,
    );
  }

  // ── refuse to degrade (H4) ─────────────────────────────────────────────────────────────
  // ONLY THE DISCHARGE LEG NEEDS THIS, and the asymmetry is the reason it went wrong. An OT, PAC or
  // progress absence is written under an `absent:<kind>:<stay>` sentinel, so it lands BESIDE the
  // real rows and can never replace one. A discharge absence is keyed on the DOCUMENT ID — the same
  // key the healthy row uses — so it overwrites in place. That is how a rebuild turned IP-1486's
  // read discharge summary into "no stored extract exists" on 29 Aug, and with MEMBERSTATE_IPD_FOLD
  // on, took the member's discharge-sourced medications off the spine with it.
  //
  // So: a rebuild may improve a discharge row, and may leave it alone, but it may NOT replace a
  // stored `ok` reading with a `not_auditable` one. If today's look cannot do better than what is
  // already stored, the stored row stands and the refusal is reported. Checked on dry runs too, so
  // a dry run predicts what the write would do rather than merely rehearsing the fetch.
  const degrades = documents.find((d) => d.docKind === 'discharge' && d.status === 'not_auditable');
  let refuseDegrade = false;
  if (degrades) {
    const stored = await readClinicalState('discharge', degrades.sourceUid, CLINICAL_STATE_VERSION);
    if (stored?.status === 'ok') {
      refuseDegrade = true;
      notes.push(`REFUSED to overwrite this stay's stored discharge summary with a ${degrades.reason} row — the stored reading is healthier than today's look, so it stands. Nothing about the stored row changed.`);
    }
  }

  // ── write ──────────────────────────────────────────────────────────────────────────────
  const written: Record<string, BuildWriteOutcome> = {};
  if (a.write) {
    for (const d of documents) {
      const key = `${d.docKind}:${d.sourceUid}`;
      if (refuseDegrade && d === degrades) { written[key] = 'refused_degrade'; continue; }
      written[key] = await upsertClinicalState({
        docKind: d.docKind, sourceUid: d.sourceUid, memberUid: a.memberUid,
        encounterRef: a.encounterRef, status: d.status, state: d.state,
        schemaVersion: CLINICAL_STATE_VERSION,
      });
    }
  }

  return { encounterRef: a.encounterRef, memberUid: a.memberUid, documents, coverage: coverageOf(documents), written, notes };
}

/** A hop that could not even be attempted reads exactly like one that faulted: we know nothing. */
const failed = (): TemplateFetchResult => ({ outcome: 'fetch_failed', rows: [] });

/**
 * H3 (H-D8) — re-run ONE document class's fetch for ONE stay, and build whatever it finds.
 *
 * WHY IT LIVES HERE AND NOT IN THE ROUTE. This is the same fetch, the same de-identifier and the
 * same pure builders the original build used — `fetchOtNotes` / `fetchPacNotes` /
 * `fetchProgressNotes` from lib/readmission/db13.ts, unmodified, plus the admission header that
 * binds the scrubber to this stay's identity. Re-implementing that in an admin route would
 * duplicate the PHI choke point, and a duplicated choke point is one that can drift open. No new
 * Metabase table is named here and none is reachable from here; a fifth table is a STOP, not an
 * addition (§4).
 *
 * THREE OUTCOMES, KEPT APART, exactly as the original build keeps them:
 *   'found'      — readable documents, already built and ready to store;
 *   'still_absent' — the look ran and there is still nothing (the absence row is re-stamped);
 *   'failed'     — the look FAULTED, so we know nothing. It must never be recorded as absence:
 *                  that is how "the OT hop timed out" becomes "there was no operation". The caller
 *                  counts it `failed`, stores nothing, and the row is walked again next pass.
 *
 * Discharge is not re-lookable here and cannot reach this function: its absence row is keyed on the
 * document id rather than the `absent:` sentinel, so the walk never selects one.
 */
export type RelookOutcome =
  | { outcome: 'found'; documents: BuiltDoc[] }
  | { outcome: 'still_absent' }
  | { outcome: 'failed'; reason: string };

export async function relookClass(a: {
  docKind: 'ot' | 'pac' | 'progress';
  encounterRef: string | null;
}): Promise<RelookOutcome> {
  const enc = a.encounterRef ?? '';
  if (!enc) return { outcome: 'failed', reason: 'this absence row carries no encounter id — there is nothing to look for it with' };

  // The header binds the scrubber to this stay and gives PAC its pre-admit window. A header we
  // cannot read is a look we cannot safely run: without it the de-identifier falls back to
  // shape-only, and the original build recorded that as a NOTE on a stay it was building anyway.
  // Here it would silently store less-scrubbed text than the first pass did, so it fails instead.
  const header = await fetchIpdAdmissionHeader(enc).catch(() => null);
  if (!header) return { outcome: 'failed', reason: 'no admission header for this stay — the de-identifier could not be bound, so nothing was stored' };

  const identity = { names: [header.patientName ?? null], uhids: [header.uhid ?? null] };
  const deid: Deidentifier = (text: string) => deidText(text, identity);
  const uhid = header.uhid ?? null;

  let fetched: TemplateFetchResult;
  try {
    fetched = a.docKind === 'ot'
      ? await fetchOtNotes(enc, uhid ? { uhid, ipdNo: enc } : null)
      : a.docKind === 'progress'
        ? await fetchProgressNotes(enc, uhid ? { uhid, ipdNo: enc } : null)
        : await fetchPacNotes(enc, uhid, pacWindow(header.admitDate ?? null, header.dischargeDate ?? null));
  } catch {
    fetched = failed();
  }
  if (fetched.outcome === 'fetch_failed') {
    return { outcome: 'failed', reason: 'the look FAULTED — this is not evidence the document is missing, and nothing was stored' };
  }

  // `templateDocs` returns ONE absence document when the class is still empty or all-blank; that is
  // not a document to store, it is the row we already have.
  const built = templateDocs(a.docKind, fetched, a.encounterRef, deid);
  const real = built.filter((d) => d.status === 'ok');
  return real.length ? { outcome: 'found', documents: real } : { outcome: 'still_absent' };
}

/**
 * H2 (H-D4 / H-D5 / H-D6) — compare this stay's structured OT `surgery_name` against its discharge
 * `ExtractedCase.procedure` and, if they share no substantive word, stamp the DISCHARGE side.
 *
 * WHAT IT STAMPS, AND WHERE. Two places, both passthrough, neither a new required field:
 *   · the discharge procedure FACT gets `contaminationSuspect: true` plus both token sets, so the
 *     taint travels with the fact into P4's gate (condition 6) wherever that fact is later read;
 *   · the discharge DOCUMENT's `surfaceExtras` gets the notice, so the stay panel can say one
 *     sentence about it.
 * `clinical-state/1.2` does not bump, no schema is forked, no engine version moves, and nothing
 * here reaches a prompt, a finding or the Care-Value Index.
 *
 * ONLY THE DISCHARGE SIDE IS EVER STAMPED. The OT fact is the stay's own structured row — the thing
 * being compared against, and precedence rank 1 anyway. Marking it would be marking the witness.
 *
 * Returns the notice it stamped, or null. Mutates the freshly-built documents in place: they are
 * locals of the caller, nothing has read them yet, and nothing has been written.
 */
function stampContamination(documents: readonly BuiltDoc[]): ContaminationNotice | null {
  const otTitles = documents
    .filter((d) => d.docKind === 'ot' && d.status === 'ok')
    .flatMap((d) => procedureFactsOf(d.state).map((p) => p.conceptRaw));
  const discharge = documents.find((d) => d.docKind === 'discharge' && d.status === 'ok');
  if (!discharge || !otTitles.length) return null;

  const facts = procedureFactsOf(discharge.state);
  const fact = facts[0];
  if (!fact) return null;

  const notice = contaminationNotice(otTitles, fact.conceptRaw);
  if (!notice) return null;

  fact.contaminationSuspect = true;
  fact.contaminationTokens = { ot: notice.otTokens, discharge: notice.dischargeTokens };
  discharge.state.surfaceExtras = { ...(discharge.state.surfaceExtras ?? {}), contamination: notice };
  return notice;
}

/**
 * Turn one class's fetch result into stored documents. The three outcomes stay apart:
 *   rows with usable text        → one 'ok' document each;
 *   fetch faulted                → ONE 'not_auditable' / `unavailable` row for the stay;
 *   looked, no rows              → ONE 'not_auditable' / `absent` row for the stay;
 *   rows present but all blank   → ONE 'not_auditable' / `empty` row for the stay.
 *
 * The empty case is measured, not theoretical: 151 of 811 progress notes carried an empty `note` on
 * the 17 Aug measure. A blank filed note is not a missing note and is not a SOAP entry either.
 */
function templateDocs(
  docKind: 'ot' | 'pac' | 'progress',
  fetched: TemplateFetchResult,
  encounterRef: string | null,
  deid: Deidentifier,
): BuiltDoc[] {
  if (fetched.outcome === 'fetch_failed') {
    return [oneAbsence(docKind, 'unavailable', encounterRef)];
  }
  const source = docKind === 'ot' ? 'ot_note' : docKind === 'pac' ? 'pac_note' : 'progress_note';
  const usable = fetched.rows.filter((row) => {
    const flat = flattenTemplateRow(row, source, 'index');
    return hasUsableText(flat);
  });
  if (!fetched.rows.length) return [oneAbsence(docKind, 'absent', encounterRef)];
  if (!usable.length) return [oneAbsence(docKind, 'empty', encounterRef)];

  return usable.map((row, i) => {
    const sourceUid = row.uid ?? `${docKind}:${encounterRef ?? 'unknown-stay'}:${i}`;
    const state = docKind === 'ot' ? otDocState(row, sourceUid, encounterRef, deid) : narrativeDocState({
      docKind, sourceUid, encounterRef,
      narrative: flattenTemplateRow(row, source, 'index').narrative,
      templateName: row.templateName, at: row.createdAt, deid,
    });
    return { docKind, sourceUid, status: 'ok' as const, state };
  });
}

/** The OT row's deterministic fields, shaped for the pure builder. */
function otDocState(row: KxTemplateRow, sourceUid: string, encounterRef: string | null, deid: Deidentifier): ClinicalState {
  const facts: OtFactInput[] = allowlistedOtFacts(parseComponentJson(row.componentJson), row.surgeryName)
    .map((f) => ({ name: f.name, label: OT_FACT_LABELS[f.name] ?? f.name, value: f.value }));
  return otState({
    sourceUid, encounterRef,
    surgeryName: row.surgeryName,
    facts,
    narrative: flattenTemplateRow(row, 'ot_note', 'index').narrative,
    templateName: row.templateName,
    at: row.createdAt,
    deid,
  });
}

function oneAbsence(docKind: DocKind, reason: NotAuditableReason, encounterRef: string | null): BuiltDoc {
  return {
    docKind, sourceUid: absentSourceUid(docKind, encounterRef), status: 'not_auditable', reason,
    state: notAuditableState({ docKind, reason, encounterRef }),
  };
}

function coverageOf(documents: readonly BuiltDoc[]): StayLibraryResult['coverage'] {
  const out = {} as StayLibraryResult['coverage'];
  for (const k of ['discharge', 'ot', 'pac', 'progress'] as const) {
    const mine = documents.filter((d) => d.docKind === k);
    const ok = mine.filter((d) => d.status === 'ok');
    out[k] = ok.length
      ? { status: 'ok', count: ok.length }
      : { status: 'not_auditable', reason: mine[0]?.reason ?? 'absent', count: 0 };
  }
  return out;
}

/**
 * The span-cleanliness readout P4's hard human gate needs (§9): across a built library, how many
 * procedure facts verified their span and how many did not, with the unverified ones named.
 *
 * A structured OT `surgery_name` is verified by construction (the column IS the field). An
 * LLM-extracted discharge procedure usually is NOT, because the extractor keeps no span into the
 * PDF — and that is the number the orchestrator has to see before anything is promoted onto the
 * spine, rather than a reassurance that the gate exists.
 */
export function spanReport(documents: readonly BuiltDoc[]): {
  total: number; verified: number; unverified: Array<{ docKind: DocKind; sourceField: string; conceptRaw: string }>;
} {
  const unverified: Array<{ docKind: DocKind; sourceField: string; conceptRaw: string }> = [];
  let total = 0, verified = 0;
  for (const d of documents) {
    for (const p of procedureFactsOf(d.state)) {
      total++;
      if (p.spanVerified) verified++;
      else unverified.push({ docKind: stayDocMetaOf(d.state)?.docKind ?? d.docKind, sourceField: p.provenance.sourceField, conceptRaw: p.conceptRaw });
    }
  }
  return { total, verified, unverified };
}
