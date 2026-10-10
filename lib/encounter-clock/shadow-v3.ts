/**
 * lib/encounter-clock/shadow-v3.ts — the pre-STT TIMELINE shadow run (epic #23, ticket f).
 *
 * One evidence load, ONE run written (source 'timeline'). Inputs: the level log, stored Nemotron turns (+ the identity
 * pass's speaker rows), and Pulse anchors. NO transcript is read and none exists to read: this lane runs before STT.
 * Per anchored consult, Jev reads the speaker-turn TIMELINE (lib/encounter-clock/timeline.ts — relative times, letters
 * and counts, never text, names, ids or clock times) and answers four closed-vocabulary questions
 * (lib/jev/prompts/timeline-v1.ts). Code arbitrates (fusion-timeline.ts): the anchor places the start, ranks place the
 * end, acoustics veto Jev, and every veto is counted.
 *
 * NOTHING INVENTED.
 *   · Jev disabled for the first anchored segment → nothing is written, reason `jev_disabled`.
 *   · Every Jev call failing → nothing is written, reason `jev_failed_all`. A run built on no answers would read as
 *     "the anchor and acoustics alone" under a name that claims Jev looked.
 *   · No anchors → nothing is written (`no_anchors`): this lane places consults from Pulse Starts. Unanchored 15-min
 *     segments are built and COUNTED but not asked and not turned into intervals (scored separately, later).
 *   · A held-out day is refused before any read (anchors.ts).
 *   · doctor_present is true only where the consult doctor's diarized speech reaches DOC_PRESENT_MS in the probe
 *     slot; otherwise null → unknown. Never false by default.
 *
 * Shadow only. Gated by ENCOUNTER_TIMELINE_SHADOW at the caller; `replay` bypasses the flag per call.
 */
import { sql } from "@/lib/db";
import { loadTimelineEvidence, type TimelineEvidence } from "@/lib/room-access/encounter-timeline-io";
import { loadAnchors, type Anchor } from "@/lib/encounter-clock/anchors";
import { scheduleProbes, HOP_SECONDS } from "@/lib/encounter-clock/probe";
import { energyHalf, levelSamplesIn, GATE_VERSION, type GateVerdict } from "@/lib/encounter-clock/gate";
import { gateProbeV2, GATE_V2_VERSION, type DiarEvidence } from "@/lib/encounter-clock/gate-v2";
import { summariseSpan, type ProbeVerdict } from "@/lib/encounter-clock/smooth";
import {
  buildTimeline, ROW_MS, type TimelineInput, type TimelineRow, type BuiltSegment, type SpeakerRole,
} from "@/lib/encounter-clock/timeline";
import {
  fuseSegment, disjoint, FUSION_TIMELINE_VERSION, END_CONTINUES, END_CANNOT_TELL,
  type RowFact, type JevReading, type SegmentFusionCounts, type SegmentFusion,
} from "@/lib/encounter-clock/fusion-timeline";
import { writeHypothesisRun, type HypothesisInterval, type HypothesisRunInput, type WriteRunResult } from "@/lib/encounter-hypotheses";
import { askJev, type JevAsk, type JevAskOutcome } from "@/lib/jev/ask";
import { JevDisabledError } from "@/lib/jev/types";
import {
  registerTimelineQuestions, U10_PROMPT_VERSION, U10_END_ROW_ID, U10_END_SIGNAL_ID, U10_LATE_START_ID, U10_KIND_ID,
  U10_END_SIGNAL_OPTIONS, U10_KIND_OPTIONS,
} from "@/lib/jev/prompts/timeline-v1";

export const SHADOW_V3_VERSION = "encounter-clock-shadow-v3";
/** Diarized speech by the consult doctor in a probe slot that makes the doctor "present". */
export const DOC_PRESENT_MS = 5_000;
export const TIMELINE_CONCURRENCY = 4;

export type TimelineDeps = {
  load: typeof loadTimelineEvidence;
  anchors: (roomId: string, istDate: string) => ReturnType<typeof loadAnchors>;
  ask: typeof askJev;
  write: typeof writeHypothesisRun;
};

const defaultDeps: TimelineDeps = {
  load: loadTimelineEvidence,
  anchors: (roomId, istDate) => loadAnchors(sql as never, roomId, istDate),
  ask: askJev,
  write: writeHypothesisRun,
};

export type TimelineRunSummary = {
  shadow_v3_version: typeof SHADOW_V3_VERSION;
  fusion_version: typeof FUSION_TIMELINE_VERSION;
  prompt_version: string;
  gate_version: string;
  n_blind_excluded: number;
  anchors: { total: number; skipped: number };
  segments: { anchored: number; unanchored: number; too_large: number; dropped: number };
  probes: { total: number; speech: number; non_speech: number; unjudged: number };
  jev: { segments_asked: number; segments_answered: number; segments_failed: number; calls: number; latency_ms_total: number; persisted: number };
  fusion: SegmentFusionCounts & { consults: number; dropped_disjoint: number; by_rank: Record<string, number>; by_origin: Record<string, number> };
};

export type TimelineRunResult =
  | { ok: true; run_id: string; summary: TimelineRunSummary }
  | { ok: false; error: "no_recorded_audio" | "blind_room_day" | "no_anchors" | "jev_disabled" | "jev_failed_all" | "write_refused"; detail?: unknown };

// ── pure helpers ──────────────────────────────────────────────────────────────────────────────────────

type Span = { start_ms: number; end_ms: number };

function mergeSpans(spans: ReadonlyArray<Span>): Span[] {
  const sorted = spans.filter((s) => s.end_ms > s.start_ms).map((s) => ({ ...s })).sort((a, b) => a.start_ms - b.start_ms);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start_ms <= last.end_ms) last.end_ms = Math.max(last.end_ms, s.end_ms);
    else out.push(s);
  }
  return out;
}

const overlapMs = (spans: ReadonlyArray<Span>, a: number, b: number): number =>
  spans.reduce((s, x) => s + Math.max(0, Math.min(x.end_ms, b) - Math.max(x.start_ms, a)), 0);

/** PURE — the Pulse uid DOC matching uses for this anchor (warehouse first, else the extension's), or null. */
export function docUidOf(a: Anchor): string | null {
  return a.doctor_source === "warehouse" ? a.doctor_uid_warehouse : a.doctor_source === "extension" ? a.doctor_uid_ext : null;
}

/** PURE — the DOC rule: a speaker is DOC only where the pulse_room pass matched it to this consult's doctor. */
export function roleFor(ev: Pick<TimelineEvidence, "identity">): TimelineInput["role"] {
  return (windowId, speakerIdx, anchor): SpeakerRole => {
    const uid = anchor ? docUidOf(anchor) : null;
    const id = ev.identity.get(windowId)?.get(speakerIdx);
    return uid !== null && id?.pulse_doctor_uid === uid ? "doc" : "other";
  };
}

/** PURE — the choice of a Jev answer when it is one of `options`. */
function choiceOf(options: readonly string[], a: JevAskOutcome["results"][string] | undefined): { choice: string; confidence: number } | null {
  if (!a || a.answer.type !== "choice") return null;
  const c = (a.answer as { choice?: unknown }).choice;
  return typeof c === "string" && options.includes(c) ? { choice: c, confidence: a.confidence } : null;
}

function noulOf(a: JevAskOutcome["results"][string] | undefined): number | null {
  if (!a || a.answer.type !== "noul") return null;
  const p = (a.answer as { noul?: unknown }).noul;
  return typeof p === "number" && Number.isFinite(p) ? p : null;
}

/** PURE — one built segment's rows as the fusion reads them. Range rows (compressed silence) carry no speech. */
export function rowFacts(built: Extract<BuiltSegment, { ok: true }>): RowFact[] {
  return built.state.rows.map((r, k) => {
    const m = built.meta[k]!;
    const spk = (r as TimelineRow).spk ?? null;
    const doc_s = spk?.DOC ?? 0;
    const other_s = spk ? Object.entries(spk).filter(([l]) => l !== "DOC").reduce((s, [, v]) => s + v, 0) : 0;
    return { start_ms: m.start_ms, end_ms: m.end_ms, sound: r.sound, speech_s: r.speech_s, doc_s, other_s, voices: spk ? Object.keys(spk) : [], voice_s: spk ? { ...spk } : {} };
  });
}

async function pool<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────────────

export async function runTimelineShadowForRoomDay(
  input: { room_id: string; room_day_id: string; ist_date: string; now?: Date; gate_diar?: boolean },
  deps: Partial<TimelineDeps> = {},
): Promise<TimelineRunResult> {
  const d: TimelineDeps = { ...defaultDeps, ...deps };
  const ev = await d.load(input.room_id, input.room_day_id, input.ist_date, input.now ?? new Date());
  if (!ev) return { ok: false, error: "no_recorded_audio" };
  const loaded = await d.anchors(input.room_id, input.ist_date);
  if ("refused" in loaded) return { ok: false, error: "blind_room_day" };
  const { anchors, skipped } = loaded;
  if (anchors.length === 0) return { ok: false, error: "no_anchors" };

  // ── probes: energy per probe (the timeline's sound), and a verdict per probe (the run's counts and tallies)
  const hopMs = HOP_SECONDS * 1000;
  const probes = scheduleProbes({ day_start_ms: ev.day_start_ms, day_end_ms: ev.day_end_ms, level_samples: ev.level_samples });
  const diar: DiarEvidence = {
    coverage: ev.windows.map((w) => ({ start_ms: w.origin_ms, end_ms: w.window_end_ms })),
    turns: ev.windows.flatMap((w) => w.turns.map((t) => ({ start_ms: w.origin_ms + t.start_ms, end_ms: w.origin_ms + t.end_ms }))),
  };
  const useDiarGate = input.gate_diar === true;
  const energy = [] as TimelineInput["energy"] extends ReadonlyArray<infer E> ? E[] : never;
  const verdicts: ProbeVerdict[] = [];
  for (const p of probes) {
    const samples = levelSamplesIn(ev.level_samples, p.start_ms, p.end_ms);
    const ee = samples ? { kind: "levels" as const, samples } : null;
    energy.push(energyHalf(ee).state);
    let verdict: GateVerdict = "unjudged";
    let reason: ProbeVerdict["reason"];
    if (useDiarGate) {
      const g = gateProbeV2({ start_ms: p.start_ms, end_ms: p.end_ms, energy: ee, diar });
      verdict = g.verdict;
      reason = g.reason === "dead_mic" ? "dead_mic" : undefined;
    } else {
      // gate v1 with no transcript: active probes come back unjudged (no_transcript_evidence); quiet and dead mic stand
      const e = energyHalf(ee);
      verdict = e.state === "quiet" ? "non_speech" : "unjudged";
      reason = e.state === "dead_mic" ? "dead_mic" : undefined;
    }
    verdicts.push({ t: (p.start_ms + p.end_ms) / 2, verdict, reason });
  }
  const probeCounts = {
    total: verdicts.length,
    speech: verdicts.filter((v) => v.verdict === "speech").length,
    non_speech: verdicts.filter((v) => v.verdict === "non_speech").length,
    unjudged: verdicts.filter((v) => v.verdict === "unjudged").length,
  };

  // ── timeline
  const tlInput: TimelineInput = { grid_origin_ms: ev.day_start_ms, energy, tape_off: ev.tape_off, windows: ev.windows, role: roleFor(ev) };
  const { built, dropped } = buildTimeline(anchors, { start_ms: ev.day_start_ms, end_ms: ev.day_end_ms }, tlInput);
  const anchored = built.filter((b): b is Extract<BuiltSegment, { ok: true }> => b.ok && b.segment.anchor !== null);
  const tooLarge = built.filter((b) => !b.ok && b.segment.anchor !== null).length;
  const unanchored = built.filter((b) => b.segment.anchor === null).length;

  // ── Jev per anchored segment
  registerTimelineQuestions();
  const readings = new Map<string, JevReading>();
  let calls = 0, latency = 0, persisted = 0, failed = 0, answered = 0;
  const askOne = async (b: Extract<BuiltSegment, { ok: true }>): Promise<void> => {
    const a = b.segment.anchor!;
    const subjectId = `tl_${input.room_day_id}_${a.start_ms}`;
    const labels = b.state.rows.map((r) => r.t);
    const base = { subjectType: "encounter" as const, subjectId, promptVersion: U10_PROMPT_VERSION };
    const asks: JevAsk[] = [
      { ...base, answerKey: "end_row", questionId: U10_END_ROW_ID, args: [labels] },
      { ...base, answerKey: "end_signal", questionId: U10_END_SIGNAL_ID },
      { ...base, answerKey: "late_start", questionId: U10_LATE_START_ID },
      { ...base, answerKey: "kind", questionId: U10_KIND_ID },
    ];
    try {
      const o = await d.ask(b.state, asks);
      calls += 1; latency += o.latencyMs; persisted += o.persisted.written;
      const endRow = choiceOf([...labels, END_CONTINUES, END_CANNOT_TELL], o.results.end_row);
      const kind = choiceOf(U10_KIND_OPTIONS, o.results.kind);
      choiceOf(U10_END_SIGNAL_OPTIONS, o.results.end_signal); // stored in jev_decision; the fusion does not consume it
      readings.set(subjectId, {
        end_row: endRow?.choice ?? null, end_conf: endRow?.confidence ?? null,
        late_start_p: noulOf(o.results.late_start),
        kind: kind?.choice ?? null, kind_conf: kind?.confidence ?? null,
      });
      answered++;
    } catch (e) {
      if (e instanceof JevDisabledError) throw e;
      failed++;
    }
  };
  if (anchored.length) {
    try { await askOne(anchored[0]!); } catch (e) {
      if (e instanceof JevDisabledError) return { ok: false, error: "jev_disabled" };
      throw e;
    }
    await pool(anchored.slice(1), TIMELINE_CONCURRENCY, askOne);
  }
  if (anchored.length > 0 && answered === 0) return { ok: false, error: "jev_failed_all", detail: { segments: anchored.length, failed } };

  // ── fuse each consult, then make them disjoint
  const total: SegmentFusionCounts = {
    veto_end_speech_continues: 0, veto_kind_no_speech: 0, veto_end_no_speech: 0, veto_doctor_unknown: 0, contradiction_end_vs_click: 0, click_late: 0,
    late_start_applied: 0, late_start_refused: 0,
  };
  type Fused = SegmentFusion & { segment: Extract<BuiltSegment, { ok: true }> };
  const fused: Fused[] = [];
  for (const b of anchored) {
    const a = b.segment.anchor!;
    const role = tlInput.role!;
    const speech: Span[] = [], doc: Span[] = [];
    for (const w of ev.windows) for (const t of w.turns) {
      const s = { start_ms: w.origin_ms + t.start_ms, end_ms: w.origin_ms + t.end_ms };
      if (s.end_ms <= b.segment.start_ms || s.start_ms >= b.segment.end_ms) continue;
      speech.push(s);
      if (role(w.window_id, t.speaker_idx, a) === "doc") doc.push(s);
    }
    const f = fuseSegment({
      anchor: a, meta: b.meta, rows: rowFacts(b), speech: mergeSpans(speech), doc_speech: mergeSpans(doc),
      jev: readings.get(`tl_${input.room_day_id}_${a.start_ms}`) ?? null,
    });
    for (const k of Object.keys(total) as Array<keyof SegmentFusionCounts>) total[k] += f.counts[k];
    fused.push({ ...f, segment: b });
  }
  const { kept, dropped: droppedDisjoint } = disjoint(fused);

  // ── intervals: the smoother's own tally over the probes inside, doctor_present from DOC speech
  const intervals: HypothesisInterval[] = kept.map((f) => {
    const a = f.segment.segment.anchor!;
    const docSpans: Span[] = [];
    for (const w of ev.windows) for (const t of w.turns) {
      if (tlInput.role!(w.window_id, t.speaker_idx, a) === "doc") docSpans.push({ start_ms: w.origin_ms + t.start_ms, end_ms: w.origin_ms + t.end_ms });
    }
    const merged = mergeSpans(docSpans);
    const idx: number[] = [];
    verdicts.forEach((v, i) => { if (v.t >= f.start_ms && v.t < f.end_ms) idx.push(i); });
    const slice = idx.map((i) => ({ ...verdicts[i]!, doctor_present: overlapMs(merged, verdicts[i]!.t - hopMs / 2, verdicts[i]!.t + hopMs / 2) >= DOC_PRESENT_MS ? true : null }));
    const base = slice.length
      ? summariseSpan(slice, 0, slice.length - 1, hopMs, f.closed_by)
      : null;
    return {
      start_ms: f.start_ms, end_ms: f.end_ms,
      speech_probes: base?.speech_probes ?? 0, non_speech_probes: base?.non_speech_probes ?? 0,
      unjudged_ms: base?.unjudged_ms ?? 0, longest_unjudged_run_ms: base?.longest_unjudged_run_ms ?? 0, dead_mic_ms: base?.dead_mic_ms ?? 0,
      closed_by: f.closed_by, merged_from: 1, origin: f.origin,
      doctor_present: base?.doctor_present ?? { yes: 0, no: 0, unknown: 0 },
      identity: dominantClinician(ev, f.start_ms, f.end_ms),
    };
  });

  const byRank: Record<string, number> = {}, byOrigin: Record<string, number> = {};
  for (const f of kept) { byRank[f.rank] = (byRank[f.rank] ?? 0) + 1; byOrigin[f.origin] = (byOrigin[f.origin] ?? 0) + 1; }

  const gate_version = useDiarGate ? GATE_V2_VERSION : GATE_VERSION;
  const run: HypothesisRunInput = {
    room_day_id: input.room_day_id,
    source: "timeline",
    smoother_version: FUSION_TIMELINE_VERSION,
    gate_version,
    params: {
      shadow_v3_version: SHADOW_V3_VERSION, fusion_version: FUSION_TIMELINE_VERSION, prompt_version: U10_PROMPT_VERSION,
      row_ms: ROW_MS, transcripts: "none_pre_stt", day_complete: ev.day_complete, gate_diar: useDiarGate,
      fusion_counts: total, jev_segments_answered: answered, jev_segments_failed: failed,
    },
    probes: probeCounts,
    intervals,
  };
  const w: WriteRunResult = await d.write(run);
  if (!w.ok) return { ok: false, error: "write_refused", detail: w.problems };

  return {
    ok: true,
    run_id: w.run_id,
    summary: {
      shadow_v3_version: SHADOW_V3_VERSION, fusion_version: FUSION_TIMELINE_VERSION, prompt_version: U10_PROMPT_VERSION, gate_version,
      n_blind_excluded: ev.n_blind_excluded,
      anchors: { total: anchors.length, skipped },
      segments: { anchored: anchored.length, unanchored, too_large: tooLarge, dropped },
      probes: probeCounts,
      jev: { segments_asked: anchored.length, segments_answered: answered, segments_failed: failed, calls, latency_ms_total: latency, persisted },
      fusion: { ...total, consults: kept.length, dropped_disjoint: droppedDisjoint, by_rank: byRank, by_origin: byOrigin },
    },
  };
}

/** PURE — the voice-print-matched clinician with the most diarized speech inside [a, b), or null when none matched. */
export function dominantClinician(ev: Pick<TimelineEvidence, "windows" | "identity">, a: number, b: number): HypothesisInterval["identity"] {
  const by = new Map<string, { ms: number; cos: number }>();
  for (const w of ev.windows) {
    const per = ev.identity.get(w.window_id);
    if (!per) continue;
    for (const t of w.turns) {
      const id = per.get(t.speaker_idx);
      if (!id?.clinician_id || id.match_confidence == null) continue;
      const ms = Math.max(0, Math.min(w.origin_ms + t.end_ms, b) - Math.max(w.origin_ms + t.start_ms, a));
      if (ms <= 0) continue;
      const cur = by.get(id.clinician_id) ?? { ms: 0, cos: id.match_confidence };
      cur.ms += ms; cur.cos = Math.max(cur.cos, id.match_confidence);
      by.set(id.clinician_id, cur);
    }
  }
  let best: [string, { ms: number; cos: number }] | null = null;
  for (const e of by) if (!best || e[1].ms > best[1].ms) best = e;
  return best ? { clinician_id: best[0], match_source: "voice_print", centroid_id: null, doctor_cosine: best[1].cos } : null;
}
