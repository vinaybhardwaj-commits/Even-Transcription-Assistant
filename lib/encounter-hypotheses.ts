/**
 * lib/encounter-hypotheses.ts — the E-5 store (migration 0114, plan §3C): write one smoother run over a
 * room-day with its encounter intervals, and read a room-day's latest run back.
 *
 * ONE STATEMENT PER RUN. The run row and every interval are inserted by a single statement (the
 * intervals travel as one jsonb array and are unpacked by jsonb_to_recordset), so a run is either
 * whole or absent; there is no moment when a run exists with half its intervals. A run with no
 * intervals is still written: "ran and found nothing" is a row.
 *
 * APPEND-ONLY. Nothing here updates or deletes. A rerun is a new run; readLatestRun picks the newest.
 *
 * THE CLOSE REASONS COME FROM THE SMOOTHER, NOT FROM HERE. `closed_by` is smooth.ts's exported
 * CLOSED_BY array, imported; the validator, the type and the migration's CHECK all answer to that one
 * list, and a drift test compares the CHECK's values against it. This file used to re-declare the
 * union by hand (the encounter-clock branch was not on its base) and fell three values behind, so a
 * room-day whose recorder stopped had its last interval refused (ETA-Refuter, 23 Sep).
 *
 * MATCH_SOURCE IS THE SAME SHAPE OF RULE, TWICE OVER. It is the column that says whether a name came
 * from a voiceprint at all, so it gets a closed vocabulary, a derived type and its own CHECK rather
 * than free text — and that vocabulary is itself derived from voice_centroid's VOICE_DOMAINS rather
 * than written out again, so the two stores cannot fall out of step either.
 *
 * Identity (clinician_id, match_source, centroid_id, doctor_cosine) is optional and belongs to E-3;
 * the migration refuses a clinician_id without its match_source and cosine. No text, no audio.
 * Nothing calls this yet (ENCOUNTER_CLOCK stays off).
 */
import { customAlphabet } from "nanoid";
import { sql } from "@/lib/db";
import { CLOSED_BY, isClosedBy, type ClosedBy } from "@/lib/encounter-clock/smooth";
import { VOICE_DOMAINS } from "@/lib/voice-centroid";

/**
 * Where an E-3 identity came from: which domain's centroid matched, or the single stored voice_print
 * (0007) when the match came from that older store instead of a domain centroid. A heuristic role is
 * never one of these, because a heuristic never writes an identity here at all.
 *
 * DERIVED FROM VOICE_DOMAINS, NOT RETYPED. The domains are voice_centroid.domain's own vocabulary
 * (migration 0113, lib/voice-centroid.ts). Writing them out again here is the drift this file was
 * refuted for once already, one level out: adding a fourth capture domain to 0113 would leave this
 * list behind, and an identity from that domain would be refused. A test pins every VOICE_DOMAINS
 * value as a match source, so the two cannot separate.
 */
export const MATCH_SOURCES = [...VOICE_DOMAINS, "voice_print"] as const;
export type MatchSource = (typeof MATCH_SOURCES)[number];
export const isMatchSource = (v: unknown): v is MatchSource =>
  typeof v === "string" && (MATCH_SOURCES as readonly string[]).includes(v);

export { CLOSED_BY, type ClosedBy };

export type HypothesisInterval = {
  start_ms: number;
  end_ms: number;
  speech_probes: number;
  non_speech_probes: number;
  unjudged_ms: number;
  longest_unjudged_run_ms: number;
  dead_mic_ms: number;
  closed_by: ClosedBy;
  merged_from: number;
  doctor_present: { yes: number; no: number; unknown: number };
  /** E-3 only. A clinician is named only together with the match that named it. */
  identity?: { clinician_id: string | null; match_source: MatchSource; centroid_id: string | null; doctor_cosine: number } | null;
};

export type HypothesisRunInput = {
  room_day_id: string;
  smoother_version: string;
  gate_version: string;
  params?: Record<string, unknown>;
  probes: { total: number; speech: number; non_speech: number; unjudged: number };
  intervals: HypothesisInterval[];
};

export type StoredHypothesis = HypothesisInterval & { id: string; run_id: string; room_day_id: string };

export type StoredRun = {
  id: string;
  room_day_id: string;
  smoother_version: string;
  gate_version: string;
  params: Record<string, unknown>;
  probes: { total: number; speech: number; non_speech: number; unjudged: number };
  n_hypotheses: number;
  created_at: string | null;
  hypotheses: StoredHypothesis[];
};

export type RunProblem =
  | "bad_room_day_id"
  | "bad_version"
  | "bad_params"
  | "bad_probe_counts"
  | "bad_interval"
  | "overlapping_intervals"
  | "bad_identity";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const nano = customAlphabet("23456789abcdefghjkmnpqrstuvwxyz", 12);
export const newRunId = (): string => `ehr_${nano()}`;
export const newHypothesisId = (): string => `eh_${nano()}`;

const nonNegInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0;

/** PURE — every problem with one interval, empty when it can be stored. Mirrors the migration's CHECKs. */
export function checkInterval(h: HypothesisInterval): RunProblem[] {
  const out: RunProblem[] = [];
  const ok =
    Number.isSafeInteger(h.start_ms) && Number.isSafeInteger(h.end_ms) && h.end_ms > h.start_ms &&
    nonNegInt(h.speech_probes) && nonNegInt(h.non_speech_probes) &&
    nonNegInt(h.unjudged_ms) && nonNegInt(h.longest_unjudged_run_ms) && nonNegInt(h.dead_mic_ms) &&
    h.longest_unjudged_run_ms <= h.unjudged_ms && h.dead_mic_ms <= h.unjudged_ms &&
    isClosedBy(h.closed_by) &&
    Number.isInteger(h.merged_from) && h.merged_from >= 1 &&
    !!h.doctor_present && nonNegInt(h.doctor_present.yes) && nonNegInt(h.doctor_present.no) &&
    nonNegInt(h.doctor_present.unknown);
  if (!ok) out.push("bad_interval");
  const id = h.identity;
  if (id) {
    const good =
      isMatchSource(id.match_source) &&
      typeof id.doctor_cosine === "number" && Number.isFinite(id.doctor_cosine) &&
      id.doctor_cosine >= -1 && id.doctor_cosine <= 1 &&
      (id.clinician_id === null || (typeof id.clinician_id === "string" && ID_RE.test(id.clinician_id))) &&
      (id.centroid_id === null || (typeof id.centroid_id === "string" && ID_RE.test(id.centroid_id)));
    if (!good) out.push("bad_identity");
  }
  return out;
}

/** PURE — every problem with a run, empty when it can be written. */
export function checkRunInput(r: HypothesisRunInput): RunProblem[] {
  const out = new Set<RunProblem>();
  if (typeof r.room_day_id !== "string" || !ID_RE.test(r.room_day_id)) out.add("bad_room_day_id");
  if (typeof r.smoother_version !== "string" || !VERSION_RE.test(r.smoother_version) ||
      typeof r.gate_version !== "string" || !VERSION_RE.test(r.gate_version)) out.add("bad_version");
  if (r.params !== undefined && (r.params === null || typeof r.params !== "object" || Array.isArray(r.params))) out.add("bad_params");
  const p = r.probes;
  if (!p || ![p.total, p.speech, p.non_speech, p.unjudged].every(nonNegInt) ||
      p.speech + p.non_speech + p.unjudged !== p.total) out.add("bad_probe_counts");
  if (!Array.isArray(r.intervals)) out.add("bad_interval");
  else {
    for (const h of r.intervals) for (const x of checkInterval(h)) out.add(x);
    // The smoother emits disjoint, ordered intervals; two that overlap are not one run's output.
    const sorted = [...r.intervals].sort((a, b) => a.start_ms - b.start_ms);
    for (let i = 1; i < sorted.length; i++) if (sorted[i]!.start_ms < sorted[i - 1]!.end_ms) out.add("overlapping_intervals");
  }
  return [...out];
}

/** PURE — the jsonb rows the single INSERT unpacks, one per interval, ids assigned, ordered by start. */
export function intervalRows(runId: string, roomDayId: string, intervals: HypothesisInterval[], mkId = newHypothesisId) {
  return [...intervals].sort((a, b) => a.start_ms - b.start_ms).map((h) => ({
    id: mkId(),
    run_id: runId,
    room_day_id: roomDayId,
    start_ms: h.start_ms,
    end_ms: h.end_ms,
    speech_probes: h.speech_probes,
    non_speech_probes: h.non_speech_probes,
    unjudged_ms: h.unjudged_ms,
    longest_unjudged_run_ms: h.longest_unjudged_run_ms,
    dead_mic_ms: h.dead_mic_ms,
    closed_by: h.closed_by,
    merged_from: h.merged_from,
    doctor_yes: h.doctor_present.yes,
    doctor_no: h.doctor_present.no,
    doctor_unknown: h.doctor_present.unknown,
    clinician_id: h.identity?.clinician_id ?? null,
    match_source: h.identity?.match_source ?? null,
    centroid_id: h.identity?.centroid_id ?? null,
    doctor_cosine: h.identity ? h.identity.doctor_cosine : null,
  }));
}

export type WriteRunResult =
  | { ok: true; run_id: string; n_hypotheses: number }
  | { ok: false; error: "invalid_input"; problems: RunProblem[] };

/** Write one run and all its intervals in ONE statement. Throws on a database refusal. */
export async function writeHypothesisRun(input: HypothesisRunInput): Promise<WriteRunResult> {
  const problems = checkRunInput(input);
  if (problems.length) return { ok: false, error: "invalid_input", problems };
  const runId = newRunId();
  const rows = intervalRows(runId, input.room_day_id, input.intervals);
  const res = (await sql`
    WITH run AS (
      INSERT INTO encounter_hypothesis_run
        (id, room_day_id, smoother_version, gate_version, params,
         probes_total, probes_speech, probes_non_speech, probes_unjudged, n_hypotheses)
      VALUES (${runId}, ${input.room_day_id}, ${input.smoother_version}, ${input.gate_version},
              ${JSON.stringify(input.params ?? {})}::jsonb,
              ${input.probes.total}, ${input.probes.speech}, ${input.probes.non_speech}, ${input.probes.unjudged},
              ${rows.length})
      RETURNING id
    ), ins AS (
      INSERT INTO encounter_hypothesis
        (id, run_id, room_day_id, start_ms, end_ms, speech_probes, non_speech_probes, unjudged_ms,
         longest_unjudged_run_ms, dead_mic_ms, closed_by, merged_from, doctor_yes, doctor_no, doctor_unknown,
         clinician_id, match_source, centroid_id, doctor_cosine)
      SELECT x.id, run.id, x.room_day_id, x.start_ms, x.end_ms, x.speech_probes, x.non_speech_probes, x.unjudged_ms,
             x.longest_unjudged_run_ms, x.dead_mic_ms, x.closed_by, x.merged_from, x.doctor_yes, x.doctor_no,
             x.doctor_unknown, x.clinician_id, x.match_source, x.centroid_id, x.doctor_cosine
        FROM run, jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(
          id text, room_day_id text, start_ms bigint, end_ms bigint, speech_probes int, non_speech_probes int,
          unjudged_ms bigint, longest_unjudged_run_ms bigint, dead_mic_ms bigint, closed_by text, merged_from int,
          doctor_yes int, doctor_no int, doctor_unknown int, clinician_id text, match_source text,
          centroid_id text, doctor_cosine real)
      RETURNING id
    )
    SELECT (SELECT id FROM run) AS run_id, (SELECT count(*) FROM ins)::int AS inserted
  `) as Array<{ run_id: string; inserted: number }>;
  const r = res[0];
  if (!r || r.run_id !== runId || Number(r.inserted) !== rows.length) {
    throw new Error(`encounter_hypothesis write returned ${r ? Number(r.inserted) : "no"} rows for ${rows.length} intervals`);
  }
  return { ok: true, run_id: runId, n_hypotheses: rows.length };
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => Number(v);
const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : typeof v === "string" && v ? new Date(v).toISOString() : null;

/**
 * PURE — one stored row. An unknown closed_by or match_source THROWS rather than being coerced: the
 * previous version silently turned anything that was not "non_speech" into "end_of_input", which
 * invents a close reason instead of reporting one it does not know (ETA-Refuter, 23 Sep).
 */
export function rowToHypothesis(r: Row): StoredHypothesis {
  const rawSource = r.match_source;
  const hasIdentity = rawSource !== null && rawSource !== undefined;
  const closedBy = r.closed_by;
  if (!isClosedBy(closedBy)) {
    throw new Error(`encounter_hypothesis ${String(r.id)}: unknown closed_by ${JSON.stringify(closedBy)}`);
  }
  if (hasIdentity && !isMatchSource(rawSource)) {
    throw new Error(`encounter_hypothesis ${String(r.id)}: unknown match_source ${JSON.stringify(rawSource)}`);
  }
  return {
    id: String(r.id),
    run_id: String(r.run_id),
    room_day_id: String(r.room_day_id),
    start_ms: num(r.start_ms),
    end_ms: num(r.end_ms),
    speech_probes: num(r.speech_probes),
    non_speech_probes: num(r.non_speech_probes),
    unjudged_ms: num(r.unjudged_ms),
    longest_unjudged_run_ms: num(r.longest_unjudged_run_ms),
    dead_mic_ms: num(r.dead_mic_ms),
    closed_by: closedBy,
    merged_from: num(r.merged_from),
    doctor_present: { yes: num(r.doctor_yes), no: num(r.doctor_no), unknown: num(r.doctor_unknown) },
    identity: hasIdentity
      ? {
          clinician_id: (r.clinician_id as string | null) ?? null,
          match_source: rawSource as MatchSource,
          centroid_id: (r.centroid_id as string | null) ?? null,
          doctor_cosine: num(r.doctor_cosine),
        }
      : null,
  };
}

/** PURE */
export function rowToRun(r: Row, hypotheses: StoredHypothesis[]): StoredRun {
  const params = r.params;
  return {
    id: String(r.id),
    room_day_id: String(r.room_day_id),
    smoother_version: String(r.smoother_version),
    gate_version: String(r.gate_version),
    params: params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {},
    probes: { total: num(r.probes_total), speech: num(r.probes_speech), non_speech: num(r.probes_non_speech), unjudged: num(r.probes_unjudged) },
    n_hypotheses: num(r.n_hypotheses),
    created_at: iso(r.created_at),
    hypotheses,
  };
}

async function hypothesesOf(runId: string): Promise<StoredHypothesis[]> {
  const rows = (await sql`
    SELECT id, run_id, room_day_id, start_ms, end_ms, speech_probes, non_speech_probes, unjudged_ms,
           longest_unjudged_run_ms, dead_mic_ms, closed_by, merged_from, doctor_yes, doctor_no, doctor_unknown,
           clinician_id, match_source, centroid_id, doctor_cosine
      FROM encounter_hypothesis
     WHERE run_id = ${runId}
     ORDER BY start_ms
  `) as Row[];
  return rows.map(rowToHypothesis);
}

/** One run by id, with its intervals, or null. */
export async function readRun(runId: string): Promise<StoredRun | null> {
  if (!/^ehr_[a-z0-9]{1,32}$/.test(runId)) return null;
  const rows = (await sql`
    SELECT id, room_day_id, smoother_version, gate_version, params, probes_total, probes_speech,
           probes_non_speech, probes_unjudged, n_hypotheses, created_at
      FROM encounter_hypothesis_run WHERE id = ${runId}
  `) as Row[];
  return rows[0] ? rowToRun(rows[0], await hypothesesOf(runId)) : null;
}

/**
 * The newest run for a room-day, with its intervals, plus how many runs match; null run if none.
 *
 * THE ONE READER. The store is append-only, so "the answer for this room-day" is always the LATEST
 * run of a given smoother version, and every reader takes it through this function — nothing else in
 * the codebase queries encounter_hypothesis_run, and a test asserts that. Pass `smootherVersion` to
 * key on (room-day, version), which is what a caller comparing like with like wants; omit it to take
 * the newest run of any version. `runs_for_day` counts the same set the answer was chosen from.
 */
export async function readLatestRun(
  roomDayId: string,
  smootherVersion?: string,
): Promise<{ run: StoredRun | null; runs_for_day: number }> {
  if (!ID_RE.test(roomDayId)) return { run: null, runs_for_day: 0 };
  if (smootherVersion !== undefined && !VERSION_RE.test(smootherVersion)) return { run: null, runs_for_day: 0 };
  const rows = (await sql`
    SELECT id, room_day_id, smoother_version, gate_version, params, probes_total, probes_speech,
           probes_non_speech, probes_unjudged, n_hypotheses, created_at,
           count(*) OVER ()::int AS runs_for_day
      FROM encounter_hypothesis_run
     WHERE room_day_id = ${roomDayId}
       AND (${smootherVersion ?? null}::text IS NULL OR smoother_version = ${smootherVersion ?? null})
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  `) as Row[];
  const r = rows[0];
  if (!r) return { run: null, runs_for_day: 0 };
  return { run: rowToRun(r, await hypothesesOf(String(r.id))), runs_for_day: num(r.runs_for_day) };
}
