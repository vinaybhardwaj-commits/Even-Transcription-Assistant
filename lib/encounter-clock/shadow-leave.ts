/**
 * lib/encounter-clock/shadow-leave.ts — write the pre-STT consult timeline into its own table.
 *
 * Behind ENCOUNTER_TIMELINE_SHADOW (default off), same gate as shadow-v3. This lane does not write
 * encounter_hypothesis. It writes encounter_timeline_shadow (migration 0156). Jev sees only the
 * word-free timeline state. A consult ends when the patient leaves; endConsult is stored as the
 * encounter end (the note) and does not move the consult. Confidence is calibrated. The model is
 * pinned to jev-1.13.0 and answers are cached by model + question-set hash + state.
 *
 * No transcript is read. A held-out day is refused before any read.
 */
import { sql } from "@/lib/db";
import { loadAnchors, type Anchor } from "@/lib/encounter-clock/anchors";
import { energyHalf, levelSamplesIn } from "@/lib/encounter-clock/gate";
import { GATE_V2_VERSION } from "@/lib/encounter-clock/gate-v2";
import { GATE_VERSION } from "@/lib/encounter-clock/gate";
import { fuseLeave, FUSION_LEAVE_VERSION, LEAVE_REASONS, type LeaveFusion, type LeaveReading } from "@/lib/encounter-clock/fusion-leave";
import { disjoint, type RowFact } from "@/lib/encounter-clock/fusion-timeline";
import { scheduleProbes } from "@/lib/encounter-clock/probe";
import { roleFor, rowFacts } from "@/lib/encounter-clock/shadow-v3";
import { hashOf } from "@/lib/jev/worker/canonical";
import {
  answerCacheKey, memoryCache, timelineQuestionSetSha, TIMELINE_MODEL_PIN, type AnswerCache, type CachedReading,
} from "@/lib/encounter-clock/timeline-cache";
import { emptyCalibration, type Calibration } from "@/lib/encounter-clock/timeline-calibration";
import { buildRowFeatures, featuresAreWordFree, FEATURES_VERSION, type FeatureRow } from "@/lib/encounter-clock/timeline-features";
import { buildTimeline, checkTimelineGrammar, ROW_MS, type BuiltSegment, type TimelineInput, type TimelineRow } from "@/lib/encounter-clock/timeline";
import { loadTimelineEvidence, type TimelineEvidence } from "@/lib/room-access/encounter-timeline-io";
import { askJev, type JevAskOutcome } from "@/lib/jev/ask";
import { JevDisabledError } from "@/lib/jev/types";
import {
  registerTimelineQuestions, U10_END_ROW_ID, U10_END_SIGNAL_ID, U10_END_SIGNAL_OPTIONS, U10_KIND_ID, U10_KIND_OPTIONS,
  U10_LATE_START_ID, U10_PROMPT_VERSION,
} from "@/lib/jev/prompts/timeline-v1";
import { randomBytes } from "node:crypto";

export const SHADOW_LEAVE_VERSION = "encounter-clock-shadow-leave-v1";

const newId = (p: string) => `${p}_${randomBytes(9).toString("hex")}`;

export type LeaveRow = LeaveFusion & {
  consult_key: string;
  cache_key: string;
  cache_hit: boolean;
  features: FeatureRow[];
  /** The Jev reading that produced this row, stored so a later run can reuse it. Null when Jev was not asked or did not answer. */
  end_row: string | null;
  end_signal: string | null;
  late_start_p: number | null;
  kind: string | null;
  kind_conf: number | null;
};

/** A stored reading is a cache hit only when it actually holds an answer. An all-null row is a failed ask, not a miss and not a hit. */
export function answerPresent(c: CachedReading): boolean {
  return c.end_row != null || c.end_signal != null || c.late_start_p != null || c.kind != null || c.end_conf != null;
}

export type LeaveWriteResult = { ok: true; run_id: string; n: number } | { ok: false; error: "invalid_rows" | "write_failed" };

export type LeaveDeps = {
  load: typeof loadTimelineEvidence;
  anchors: (roomId: string, istDate: string) => ReturnType<typeof loadAnchors>;
  ask: (state: unknown, asks: Parameters<typeof askJev>[1]) => Promise<JevAskOutcome>;
  remember: (key: string) => Promise<CachedReading | null>;
  write: (run: LeaveRunInsert) => Promise<LeaveWriteResult>;
  calibration: Calibration;
  cache: AnswerCache;
};

export type LeaveRunInsert = {
  room_day_id: string;
  model: string;
  question_set_sha: string;
  prompt_version: string;
  calibration_sha: string;
  gate_version: string;
  params: Record<string, unknown>;
  rows: LeaveRow[];
};

const choiceOf = (options: readonly string[], a: JevAskOutcome["results"][string] | undefined): { choice: string; confidence: number } | null => {
  if (!a || a.answer.type !== "choice") return null;
  const c = (a.answer as { choice?: unknown }).choice;
  return typeof c === "string" && options.includes(c) ? { choice: c, confidence: a.confidence } : null;
};

const noulOf = (a: JevAskOutcome["results"][string] | undefined): number | null => {
  if (!a || a.answer.type !== "noul") return null;
  const p = (a.answer as { noul?: unknown }).noul;
  return typeof p === "number" && Number.isFinite(p) ? p : null;
};

function readingOf(c: CachedReading): LeaveReading {
  return { end_row: c.end_row, end_signal: c.end_signal, end_conf: c.end_conf, late_start_p: c.late_start_p, kind: c.kind, kind_conf: c.kind_conf };
}

async function defaultRemember(key: string): Promise<CachedReading | null> {
  const rows = (await sql`
    SELECT end_row, end_signal, late_start_p, kind, kind_conf, raw_confidence
      FROM encounter_timeline_shadow
     WHERE cache_key = ${key}
     ORDER BY created_at DESC
     LIMIT 1
  `) as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return null;
  const num = (v: unknown): number | null => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
  const reading: CachedReading = {
    end_row: (r.end_row as string | null) ?? null,
    end_signal: (r.end_signal as string | null) ?? null,
    end_conf: num(r.raw_confidence),
    late_start_p: num(r.late_start_p),
    kind: (r.kind as string | null) ?? null,
    kind_conf: num(r.kind_conf),
  };
  return answerPresent(reading) ? reading : null;
}

export async function writeLeaveRun(run: LeaveRunInsert): Promise<LeaveWriteResult> {
  if (!run.rows.length) return { ok: false, error: "invalid_rows" };
  for (const row of run.rows) {
    if (!(row.end_ms > row.start_ms)) return { ok: false, error: "invalid_rows" };
    if (!featuresAreWordFree(row.features)) return { ok: false, error: "invalid_rows" };
    if (row.reason_codes.some((c) => !LEAVE_REASONS.includes(c))) return { ok: false, error: "invalid_rows" };
  }
  const runId = newId("ets");
  const payload = run.rows.map((row) => ({
    id: newId("et"),
    consult_key: row.consult_key,
    start_ms: row.start_ms,
    end_ms: row.end_ms,
    confidence: row.confidence,
    raw_confidence: row.raw_confidence,
    reason_codes: row.reason_codes,
    closed_by: row.closed_by,
    encounter_end_ms: row.encounter_end_ms,
    jev_used: row.jev_used,
    cache_hit: row.cache_hit,
    cache_key: row.cache_key,
    end_row: row.end_row,
    end_signal: row.end_signal,
    late_start_p: row.late_start_p,
    kind: row.kind,
    kind_conf: row.kind_conf,
    features: row.features,
  }));
  try {
    const res = (await sql`
      WITH run AS (
        INSERT INTO encounter_timeline_shadow_run
          (id, room_day_id, model, question_set_sha, prompt_version, calibration_sha, gate_version, fusion_version, params)
        VALUES (${runId}, ${run.room_day_id}, ${run.model}, ${run.question_set_sha}, ${run.prompt_version},
                ${run.calibration_sha}, ${run.gate_version}, ${FUSION_LEAVE_VERSION}, ${JSON.stringify(run.params)}::jsonb)
        RETURNING id
      ), ins AS (
        INSERT INTO encounter_timeline_shadow
          (id, run_id, room_day_id, consult_key, start_ms, end_ms, confidence, raw_confidence, reason_codes,
           closed_by, encounter_end_ms, jev_used, cache_hit, cache_key, end_row, end_signal, late_start_p, kind, kind_conf, features)
        SELECT x.id, run.id, ${run.room_day_id}, x.consult_key, x.start_ms, x.end_ms, x.confidence, x.raw_confidence,
               ARRAY(SELECT jsonb_array_elements_text(x.reason_codes)), x.closed_by, x.encounter_end_ms, x.jev_used,
               x.cache_hit, x.cache_key, x.end_row, x.end_signal, x.late_start_p, x.kind, x.kind_conf, x.features
          FROM run, jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS x(
            id text, consult_key text, start_ms bigint, end_ms bigint, confidence real, raw_confidence real,
            reason_codes jsonb, closed_by text, encounter_end_ms bigint, jev_used boolean, cache_hit boolean,
            cache_key text, end_row text, end_signal text, late_start_p real, kind text, kind_conf real, features jsonb)
        RETURNING id
      )
      SELECT (SELECT id FROM run) AS run_id, (SELECT count(*) FROM ins)::int AS n
    `) as Array<{ run_id: string; n: number }>;
    const r = res[0];
    if (!r || r.run_id !== runId || Number(r.n) !== payload.length) return { ok: false, error: "write_failed" };
    return { ok: true, run_id: runId, n: payload.length };
  } catch {
    return { ok: false, error: "write_failed" };
  }
}

function defaultDeps(): LeaveDeps {
  return {
    load: loadTimelineEvidence,
    anchors: (roomId, istDate) => loadAnchors(sql as never, roomId, istDate),
    ask: (state, asks) => askJev(state, asks, { model: TIMELINE_MODEL_PIN }),
    remember: defaultRemember,
    write: writeLeaveRun,
    calibration: emptyCalibration(),
    cache: memoryCache(),
  };
}

export type LeaveRunResult =
  | { ok: true; run_id: string; consults: number; cache_hits: number; jev_asked: number; summary: Record<string, unknown> }
  | { ok: false; error: "no_recorded_audio" | "blind_room_day" | "no_anchors" | "cache_read_failed" | "invalid_rows" | "write_failed"; detail?: unknown };

function otherSpans(ev: TimelineEvidence, role: TimelineInput["role"], anchor: Anchor, seg: { start_ms: number; end_ms: number }) {
  const spans: Array<{ start_ms: number; end_ms: number }> = [];
  for (const w of ev.windows) for (const t of w.turns) {
    if (role!(w.window_id, t.speaker_idx, anchor) !== "other") continue;
    const s = { start_ms: w.origin_ms + t.start_ms, end_ms: w.origin_ms + t.end_ms };
    if (s.end_ms <= seg.start_ms || s.start_ms >= seg.end_ms) continue;
    spans.push(s);
  }
  return spans;
}

export async function runTimelineLeaveForRoomDay(
  input: { room_id: string; room_day_id: string; ist_date: string; now?: Date; gate_diar?: boolean },
  deps: Partial<LeaveDeps> = {},
): Promise<LeaveRunResult> {
  const d: LeaveDeps = { ...defaultDeps(), ...deps };
  const ev = await d.load(input.room_id, input.room_day_id, input.ist_date, input.now ?? new Date());
  if (!ev) return { ok: false, error: "no_recorded_audio" };
  const loaded = await d.anchors(input.room_id, input.ist_date);
  if ("refused" in loaded) return { ok: false, error: "blind_room_day" };
  const { anchors } = loaded;
  if (!anchors.length) return { ok: false, error: "no_anchors" };

  const probes = scheduleProbes({ day_start_ms: ev.day_start_ms, day_end_ms: ev.day_end_ms, level_samples: ev.level_samples });
  const energy: TimelineInput["energy"] = probes.map((p) => {
    const samples = levelSamplesIn(ev.level_samples, p.start_ms, p.end_ms);
    return energyHalf(samples ? { kind: "levels", samples } : null).state;
  });
  const role = roleFor(ev);
  const tl: TimelineInput = { grid_origin_ms: ev.day_start_ms, energy, tape_off: ev.tape_off, windows: ev.windows, role };
  const { built } = buildTimeline(anchors, { start_ms: ev.day_start_ms, end_ms: ev.day_end_ms }, tl);
  const anchored = built.filter((b): b is Extract<BuiltSegment, { ok: true }> => b.ok && b.segment.anchor !== null);
  const setSha = timelineQuestionSetSha();
  registerTimelineQuestions();

  let cacheHits = 0, asked = 0, jevOff = false;
  const readings = new Map<string, { reading: LeaveReading | null; hit: boolean; key: string }>();

  for (const b of anchored) {
    const bad = checkTimelineGrammar(JSON.stringify(b.state));
    if (bad.length) return { ok: false, error: "invalid_rows", detail: { grammar: bad[0] } };
    const key = answerCacheKey(TIMELINE_MODEL_PIN, setSha, b.state);
    const local = d.cache.get(key);
    if (local) { cacheHits++; readings.set(b.segment.anchor!.consult_key, { reading: readingOf(local), hit: true, key }); continue; }
    let stored: CachedReading | null = null;
    try { stored = await d.remember(key); } catch { return { ok: false, error: "cache_read_failed" }; }
    if (stored && answerPresent(stored)) { cacheHits++; d.cache.set(key, stored); readings.set(b.segment.anchor!.consult_key, { reading: readingOf(stored), hit: true, key }); continue; }
    if (jevOff) { readings.set(b.segment.anchor!.consult_key, { reading: null, hit: false, key }); continue; }
    const a = b.segment.anchor!;
    const labels = b.state.rows.map((r) => r.t);
    const subjectId = `tl_${input.room_day_id}_${a.start_ms}`;
    const base = { subjectType: "encounter" as const, subjectId, promptVersion: U10_PROMPT_VERSION };
    try {
      const o = await d.ask(b.state, [
        { ...base, answerKey: "end_row", questionId: U10_END_ROW_ID, args: [labels] },
        { ...base, answerKey: "end_signal", questionId: U10_END_SIGNAL_ID },
        { ...base, answerKey: "late_start", questionId: U10_LATE_START_ID },
        { ...base, answerKey: "kind", questionId: U10_KIND_ID },
      ]);
      asked++;
      const endRow = choiceOf([...labels, "continues_past_segment", "cannot_tell"], o.results.end_row);
      const signal = choiceOf(U10_END_SIGNAL_OPTIONS, o.results.end_signal);
      const kind = choiceOf(U10_KIND_OPTIONS, o.results.kind);
      const cached: CachedReading = {
        end_row: endRow?.choice ?? null, end_conf: endRow?.confidence ?? null, end_signal: signal?.choice ?? null,
        late_start_p: noulOf(o.results.late_start), kind: kind?.choice ?? null, kind_conf: kind?.confidence ?? null,
      };
      d.cache.set(key, cached);
      readings.set(a.consult_key, { reading: readingOf(cached), hit: false, key });
    } catch (e) {
      if (e instanceof JevDisabledError) { jevOff = true; readings.set(a.consult_key, { reading: null, hit: false, key }); continue; }
      readings.set(a.consult_key, { reading: null, hit: false, key });
    }
  }

  const covered = (start: number, end: number) => ev.windows.some((w) => w.origin_ms <= start && w.window_end_ms >= end);
  const turns = ev.windows.flatMap((w) => w.turns.map((t) => ({ start_ms: w.origin_ms + t.start_ms, end_ms: w.origin_ms + t.end_ms })));

  type Fused = LeaveRow & { anchor: Anchor };
  const fused: Fused[] = [];
  for (const b of anchored) {
    const a = b.segment.anchor!;
    const got = readings.get(a.consult_key);
    const reading = got?.reading ?? null;
    const facts: RowFact[] = rowFacts(b);
    const features = buildRowFeatures({
      rows: b.state.rows.map((r, i) => ({
        t: r.t, start_ms: b.meta[i]!.start_ms, end_ms: b.meta[i]!.end_ms,
        who: (r as TimelineRow).spk ? Object.keys((r as TimelineRow).spk!) : [],
        overlap_s: (r as TimelineRow).overlap_s ?? null,
      })),
      turns, levels: ev.level_samples, covered,
    });
    const f = fuseLeave({
      anchor: a, meta: b.meta, rows: facts, other_speech: otherSpans(ev, role, a, b.segment),
      jev: reading, calibration: d.calibration,
    });
    fused.push({
      ...f, consult_key: a.consult_key, cache_key: got?.key ?? "", cache_hit: got?.hit ?? false, features, anchor: a,
      end_row: reading?.end_row ?? null, end_signal: reading?.end_signal ?? null, late_start_p: reading?.late_start_p ?? null,
      kind: reading?.kind ?? null, kind_conf: reading?.kind_conf ?? null,
    });
  }
  const { kept } = disjoint(fused);
  const rows: LeaveRow[] = kept.map(({ anchor: _a, ...row }) => row);
  if (!rows.length) return { ok: false, error: "no_anchors" };

  const gate_version = input.gate_diar ? GATE_V2_VERSION : GATE_VERSION;
  const written = await d.write({
    room_day_id: input.room_day_id,
    model: TIMELINE_MODEL_PIN,
    question_set_sha: setSha,
    prompt_version: U10_PROMPT_VERSION,
    calibration_sha: hashOf(d.calibration),
    gate_version,
    params: {
      shadow_leave_version: SHADOW_LEAVE_VERSION, features_version: FEATURES_VERSION, fusion_version: FUSION_LEAVE_VERSION,
      row_ms: ROW_MS, transcripts: "none_pre_stt", model: TIMELINE_MODEL_PIN, jev_disabled: jevOff,
    },
    rows,
  });
  if (!written.ok) return { ok: false, error: written.error };
  return {
    ok: true, run_id: written.run_id, consults: rows.length, cache_hits: cacheHits, jev_asked: asked,
    summary: { closed_by: rows.map((r) => r.closed_by), jev_used: rows.filter((r) => r.jev_used).length },
  };
}
