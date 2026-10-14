/**
 * lib/lab-v2/tools/case.ts — `case_ask` and `case_timeline` (§17.11 items 4 and 5,
 * decisions 141 and 146).
 *
 * WHAT THESE TWO ARE. Every other read in this platform starts from something the platform itself
 * minted — a run id, a dataset id, a note uid it already froze. These two start from a PERSON, named
 * by an identifier a clinician's surface would use, and answer "what has this system already
 * concluded about them". That is the one question the Lab could not answer, and it is why both are
 * `identifying_input` and why neither is reachable from the research key.
 *
 * ⚠️ THE IDENTIFIER GOES IN AND NEVER COMES OUT. It is a bind parameter to the statements in
 * `sources/case-readers.ts`, it is hashed once into the salted `member_key` every object in this
 * platform is already keyed by, and the raw value exists in this module for the length of one
 * function call. `document_id` and `ip_uid` reach these handlers from the IPD statement and stop
 * here; the response is built field by field from named columns and never by spreading a row.
 *
 * ⚠️ AND `identifyingKeys()` RUNS OVER THE WHOLE RESPONSE BEFORE IT IS RETURNED (decision 146).
 * That is a CHECK, not the mechanism — the narrow statements are the mechanism. A hit is
 * `CLASSIFICATION_REQUIRED` naming the key and NEVER a partial response with the field removed,
 * for decision 99's reason: a scrub hides the change upstream that put the field there.
 *
 * ⚠️ NOTHING IS STORED. Neither handler writes an object, a dataset or a run. The only durable
 * trace of a call is `callTool`'s own `tool_call` event, which records the tool, a hash of the
 * arguments and the outcome — never the arguments (§3.2.3).
 *
 * ⚠️ ZERO MODEL CALLS. `case_ask` takes a `question` in its schema and REFUSES it `INVALID_INPUT`
 * in D3 (§17.11 item 4): the name is honest about what the tool is for, and the refusal is
 * recorded as an event so a later round can see how often it was asked before deciding what a
 * governed answer would cost. A tool that quietly ignored the field would look like it answered.
 */
import { z } from 'zod';
import type { Db } from '../db';
import { LabError } from '../contracts';
import { recordEvent } from '../store';
import { identifyingKeys } from '../sources/requests';
import { memberKeyOf, memberSalt } from '../sources/opd';
import {
  CASE_ENGINES, ENGINES_BY_KIND, IDENTIFIER_KINDS, KIND_BY_ENGINE,
  opdUidsForIndividual, readEpisodeStates, readIpdDischargeCase, readIpdDischargeTimeline,
  readOpdCase, readOpdTimeline, readPreopCase, readPreopTimeline,
  readReadmissionCase, readReadmissionTimeline,
  type CaseEngine, type CaseReaderDeps, type IdentifierKind, type Row,
} from '../sources/case-readers';

const identifierSchema = z.object({
  kind: z.enum(IDENTIFIER_KINDS),
  value: z.string().min(1).max(128),
});

export const CASE_SCHEMAS = {
  case_ask: {
    input: z.object({
      engine: z.enum(CASE_ENGINES),
      identifier: identifierSchema,
      /** Out of scope in D3 and refused INVALID_INPUT when present — see the header. */
      question: z.string().min(1).max(2000).optional(),
    }),
    output: z.object({
      member_key: z.string(),
      engine: z.enum(CASE_ENGINES),
      engine_version: z.string().nullable(),
      audited_at: z.string().nullable(),
      findings: z.array(z.object({
        subject: z.string(),
        verdict: z.string().nullable(),
        domain: z.string().nullable(),
        citation_ids: z.array(z.union([z.string(), z.number()])),
      })),
      scores: z.record(z.unknown()),
      /** Zero, always, in D3. Stated rather than implied. */
      model_calls: z.number().int(),
    }),
  },
  case_timeline: {
    input: z.object({ identifier: identifierSchema }),
    output: z.object({
      member_key: z.string(),
      kind: z.enum(IDENTIFIER_KINDS),
      engines: z.array(z.string()),
      events: z.array(z.object({
        at: z.string().nullable(),
        engine: z.string(),
        kind: z.enum(['audit', 'finding', 'episode_state']),
        engine_version: z.string().nullable(),
        summary: z.record(z.unknown()),
      })),
      model_calls: z.number().int(),
    }),
  },
} as const;

export type CaseToolName = keyof typeof CASE_SCHEMAS;

const s = (v: unknown): string | null => (v == null ? null : String(v));
const n = (v: unknown): number | null => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const b = (v: unknown): boolean | null => (v == null ? null : Boolean(v));

/** The leading integer of a documented length-of-stay value ("3", "3 days"), or null. */
function leadingInt(v: unknown): number | null {
  const m = /^\s*(\d+)/.exec(v == null ? '' : String(v));
  return m ? Number(m[1]) : null;
}

/**
 * The four keys decision 146 permits out of a findings array, and no fifth. `rationale`,
 * `evidence`, `estimates` and `order` are prose and are not selected by the statements above; this
 * shapes what the statements did return so a column added to the sub-select later cannot ride out.
 */
function shapeFindings(raw: unknown): { subject: string; verdict: string | null; domain: string | null; citation_ids: (string | number)[] }[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? safeParse(raw) : [];
  return list
    .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === 'object')
    .map((f) => ({
      subject: String(f.subject ?? ''),
      verdict: s(f.verdict),
      domain: s(f.domain),
      citation_ids: Array.isArray(f.citation_ids)
        ? (f.citation_ids as unknown[]).map((c) => (typeof c === 'number' ? c : String(c)))
        : [],
    }))
    .filter((f) => f.subject.length > 0);
}

function safeParse(text: string): unknown[] {
  try { const v = JSON.parse(text); return Array.isArray(v) ? v : []; } catch { return []; }
}

export interface CaseToolDeps { db: Db; principal: string; readers?: CaseReaderDeps }

/**
 * Decision 146's check, run over the assembled response. It is deliberately the LAST thing either
 * handler does, after every field has been chosen, because that is the only point at which the
 * whole shape exists.
 */
function refuseIdentifyingResponse(tool: string, body: unknown): void {
  const hits = identifyingKeys(body);
  if (hits.length) {
    throw new LabError('CLASSIFICATION_REQUIRED',
      `'${tool}' assembled a response carrying identifying key(s) ${hits.join(', ')}; refused rather than `
      + 'returned with the field removed (decision 146). The identifier is an argument to these tools '
      + 'and the response is keyed by member_key alone.');
  }
}

/** Decision 141 — the identifier a `case_ask` engine keys on, and a named refusal for any other. */
function assertKind(engine: CaseEngine, kind: IdentifierKind): void {
  const want = KIND_BY_ENGINE[engine];
  if (kind !== want) {
    throw new LabError('INVALID_INPUT',
      `engine '${engine}' keys on '${want}', not '${kind}'. Decision 141 does not resolve one `
      + 'identifier kind into another: that is a db13 survey, not a join this tool may invent.');
  }
}

export async function caseAsk(
  deps: CaseToolDeps,
  args: { engine: CaseEngine; identifier: { kind: IdentifierKind; value: string }; question?: string },
): Promise<unknown> {
  const engine = args.engine;
  const { kind, value } = args.identifier;

  /**
   * ⚠️ THE REFUSAL IS RECORDED BEFORE IT IS THROWN, and the event carries no question text — only
   * the engine and the fact that one was asked. §17.11 item 4: `case_ask` makes no model call in
   * D3, and the name stays honest because the field exists and is refused rather than absent.
   */
  if (args.question != null && String(args.question).trim().length > 0) {
    await recordEvent(deps.db, deps.principal, 'case_ask', 'question_refused',
      { engine, length: String(args.question).length })
      .catch(() => { /* the record of a refusal must never be what fails the refusal */ });
    throw new LabError('INVALID_INPUT',
      "'question' is out of scope in D3: case_ask makes no model call, so a free-text question "
      + 'would have to be answered by one. Ask for the stored audit and read it.');
  }

  assertKind(engine, kind);
  const readers = deps.readers ?? {};
  const member_key = memberKeyOf(value, memberSalt());

  let row: Row | undefined;
  let findings: ReturnType<typeof shapeFindings> = [];
  let scores: Record<string, unknown> = {};
  let engine_version: string | null = null;
  let audited_at: string | null = null;

  if (engine === 'readmission') {
    row = (await readReadmissionCase(value, readers))[0];
    if (row) {
      engine_version = s(row.engine_version);
      audited_at = s(row.audited_at);
      scores = {
        finding_class: s(row.finding_class), lane: s(row.lane), audit_status: s(row.audit_status),
        gap_days: n(row.gap_days), planned: s(row.planned), same_condition: s(row.same_condition),
        avoidable: s(row.avoidable), lab_tier: s(row.lab_tier), n_omissions: n(row.n_omissions),
        needs_human_review: b(row.needs_human_review), promoted_to_full: b(row.promoted_to_full),
        preventable_injury: s(row.preventable_injury), negligence: s(row.negligence),
      };
      /**
       * ⚠️ EMPTY, AND FOR A REASON WORTH READING. A readmission's findings live in the `finding`
       * jsonb and in `omission_evidence`, which are the engine's PROSE and quoted chart lines
       * respectively. Decision 146 forbids selecting either, and there is no subject list on the
       * row to project instead. So the verdict columns above ARE this engine's answer, and the
       * findings array is honestly empty rather than filled with something adjacent.
       */
      findings = [];
    }
  } else if (engine === 'preop') {
    row = (await readPreopCase(value, readers))[0];
    if (row) {
      engine_version = s(row.engine_version);
      audited_at = s(row.computed_at);
      scores = {
        tier: s(row.tier),
        rcri_lo: n(row.rcri_lo), rcri_hi: n(row.rcri_hi),
        mfi_lo: n(row.mfi_lo), mfi_hi: n(row.mfi_hi),
        cci_lo: n(row.cci_lo), cci_hi: n(row.cci_hi),
        needs_review: b(row.needs_review), booking_only: b(row.booking_only),
        pac_on_file: b(row.pac_on_file), pac_status: s(row.pac_status), pac_verdict: s(row.pac_verdict),
      };
      // The same fact as readmission's: preop's three prose lines are its narrative, and none of
      // them is selected, so this engine has scores and no finding list.
      findings = [];
    }
  } else if (engine === 'opd_note_audit') {
    const uids = await opdUidsForIndividual(value, readers);
    if (uids.length) {
      row = (await readOpdCase(uids, readers))[0];
      if (row) {
        engine_version = s(row.engine_version);
        audited_at = s(row.audited_at);
        findings = shapeFindings(row.findings);
        scores = {
          band: s(row.band), note_quality_index: n(row.note_quality_index),
          completeness_pct: n(row.completeness_pct),
          n_findings: n(row.n_findings), n_low_value: n(row.n_low_value),
          score_documentation: n(row.score_documentation),
          score_appropriateness: n(row.score_appropriateness),
          score_prescribing_safety: n(row.score_prescribing_safety),
          score_patient_centred: n(row.score_patient_centred),
          notes_considered: uids.length,
        };
      }
    }
  } else {
    row = (await readIpdDischargeCase(value, readers))[0];
    if (row) {
      engine_version = s(row.engine_version);
      audited_at = s(row.audited_at);
      findings = shapeFindings(row.findings);
      scores = {
        care_value_index: n(row.care_value_index), band: s(row.band),
        completeness_pct: n(row.completeness_pct),
        n_findings: n(row.n_findings), n_low_value: n(row.n_low_value),
        n_context_dependent: n(row.n_context_dependent),
        score_appropriateness: n(row.score_appropriateness), score_efficiency: n(row.score_efficiency),
        score_safety: n(row.score_safety), score_cost: n(row.score_cost),
        score_documentation: n(row.score_documentation), score_patient_centred: n(row.score_patient_centred),
        los_days: n(row.los_days), discharge_type: s(row.discharge_type), speciality: s(row.speciality),
      };
    }
  }

  if (!row) {
    throw new LabError('NOT_FOUND',
      `no ${engine} audit for that ${kind}. The read succeeded and returned no row, which is a fact `
      + 'about the person and not a fault: this engine has not audited them at any version.');
  }

  const out = { member_key, engine, engine_version, audited_at, findings, scores, model_calls: 0 };
  refuseIdentifyingResponse('case_ask', out);
  return out;
}

export async function caseTimeline(
  deps: CaseToolDeps,
  args: { identifier: { kind: IdentifierKind; value: string } },
): Promise<unknown> {
  const { kind, value } = args.identifier;
  const readers = deps.readers ?? {};
  const member_key = memberKeyOf(value, memberSalt());
  const engines = ENGINES_BY_KIND[kind];
  const events: { at: string | null; engine: string; kind: 'audit' | 'finding' | 'episode_state'; engine_version: string | null; summary: Record<string, unknown> }[] = [];

  if (kind === 'uhid') {
    for (const r of await readReadmissionTimeline(value, readers)) {
      events.push({
        at: s(r.audited_at), engine: 'readmission', kind: 'finding',
        engine_version: s(r.engine_version),
        summary: {
          verdict: s(r.avoidable), finding_class: s(r.finding_class), lane: s(r.lane),
          audit_status: s(r.audit_status), gap_days: n(r.gap_days),
          n_findings: n(r.n_omissions), preventable_injury: s(r.preventable_injury),
        },
      });
    }
    for (const r of await readPreopTimeline(value, readers)) {
      events.push({
        at: s(r.computed_at), engine: 'preop', kind: 'audit',
        engine_version: s(r.engine_version),
        summary: {
          tier: s(r.tier), needs_review: b(r.needs_review), booking_only: b(r.booking_only),
          pac_on_file: b(r.pac_on_file), pac_status: s(r.pac_status), verdict: s(r.pac_verdict),
        },
      });
    }
  } else if (kind === 'individual_uid') {
    const uids = await opdUidsForIndividual(value, readers);
    if (uids.length) {
      for (const r of await readOpdTimeline(uids, readers)) {
        events.push({
          at: s(r.audited_at), engine: 'opd_note_audit', kind: 'audit',
          engine_version: s(r.engine_version),
          summary: {
            band: s(r.band), scores: { note_quality_index: n(r.note_quality_index), completeness_pct: n(r.completeness_pct) },
            n_findings: n(r.n_findings), n_low_value: n(r.n_low_value),
          },
        });
      }
    }
  } else {
    /**
     * ⚠️ `ip_uid` IS COLLECTED HERE AND RETURNED NOWHERE. It is the only path from a member to
     * their `episode_states` rows (`migrations/0016_episode_states.sql:26` indexes on it), and it
     * lives in this local array for the two statements between the audit read and the state read.
     */
    const ipUids: string[] = [];
    for (const r of await readIpdDischargeTimeline(value, readers)) {
      if (r.ip_uid != null && String(r.ip_uid)) ipUids.push(String(r.ip_uid));
      events.push({
        at: s(r.audited_at), engine: 'ipd_discharge', kind: 'audit',
        engine_version: s(r.engine_version),
        summary: {
          band: s(r.band),
          scores: { care_value_index: n(r.care_value_index), completeness_pct: n(r.completeness_pct) },
          n_findings: n(r.n_findings), n_low_value: n(r.n_low_value), los_days: n(r.los_days),
        },
      });
    }
    if (ipUids.length) {
      for (const r of await readEpisodeStates([...new Set(ipUids)], readers)) {
        events.push({
          at: s(r.updated_at), engine: 'episode_state', kind: 'episode_state',
          engine_version: s(r.version),
          /**
           * Decision 141 — a fact count and a day span, and nothing else. Both were computed by
           * Postgres inside the row; no `rawText` and no `courseSummary` was read to produce them.
           */
          summary: { fact_count: n(r.fact_count) ?? 0, day_span: leadingInt(r.los_value) },
        });
      }
    }
  }

  // Sorted by `at`, newest first; a null time sorts last rather than being dropped — an event with
  // no timestamp is still an event, and dropping it would understate the history.
  events.sort((x, y) => {
    if (x.at == null && y.at == null) return 0;
    if (x.at == null) return 1;
    if (y.at == null) return -1;
    return y.at.localeCompare(x.at);
  });

  const out = { member_key, kind, engines: [...engines], events, model_calls: 0 };
  refuseIdentifyingResponse('case_timeline', out);
  return out;
}

export const CASE_HANDLERS = { caseAsk, caseTimeline };
