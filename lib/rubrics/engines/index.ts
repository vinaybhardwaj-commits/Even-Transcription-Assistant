/**
 * lib/rubrics/engines/index.ts — S7-0: evaluate ONE unit of a code-engine rubric (read inputs through the readers, run the pure engine), and resolve which units a run covers.
 * Engines jev and llm_zdr are not wired in this slice (canRun refuses them before a job is queued).
 */
import { sql } from "@/lib/db";
import type { Rubric, RubricUnit } from "../types";
import { listAudioHours, listConsultKeys, parseRoomHourKey, readAudioHour, readConsultSpan, readWindowTurns, windowPair, consultPair, isRefusal, blindRefusal, refuse, isIstDate, isRoomId, type ReadRefusal } from "../readers";
import type { Turn } from "../readers/turns";
import { evaluateRoomMicQuality } from "./room-mic-quality";
import { evaluateTalkTime } from "./talk-time";
import { evaluateConsultAffect, evaluateSurgicalPitch } from "./consult-llm";
import { readBenchText, readConsultText } from "../readers/consult-text";
import type { EngineResult, UnitOutcome } from "./types";
import { BLIND_ROOM_DAYS } from "../blind-room-days";

type Pair = { room_id: string; ist_date: string };
const skip = (reason: string, pair: Pair | null = null): UnitOutcome => ({ status: "skipped", findings: [], reason, room_id: pair?.room_id ?? null, ist_date: pair?.ist_date ?? null });

/** Run the PURE engine; an exception there is an engine fault (a failed unit). Nothing that does I/O is inside this wrapper: a database or R2 error must reach the runner. */
function engine(fn: () => EngineResult, pair: Pair): UnitOutcome {
  try {
    return { ...fn(), room_id: pair.room_id, ist_date: pair.ist_date };
  } catch (e) {
    console.error("[rubric] engine fault", JSON.stringify({ err: String((e as Error)?.name ?? "error") }));
    return { status: "failed", findings: [], reason: "engine_error", room_id: pair.room_id, ist_date: pair.ist_date };
  }
}

/**
 * Evaluate ONE unit. THE ORDER IS THE RULE (S7-0-R3, G53): (1) resolve the unit's room and IST date (a metadata lookup; a failing query THROWS, so the runner retries and nothing is written),
 * (2) refuse a held-out pair (reason blind_room_day, before any content fetch), (3) read the inputs, (4) run the pure engine. A unit whose room or date cannot be resolved comes back with
 * room_id / ist_date null: the caller writes NO row for it (a result row always has a known room and date).
 */
export async function evaluateUnit(r: Rubric, unitKind: RubricUnit, unitKey: string, opts: { bench?: boolean; excerpt?: boolean } = {}): Promise<UnitOutcome> {
  let pair: Pair | ReadRefusal;
  if (r.engine === "llm_zdr") return evaluateLlmUnit(r, unitKind, unitKey, opts);
  if (unitKind === "room_hour") {
    const k = parseRoomHourKey(unitKey);
    pair = k ? { room_id: k.room_id, ist_date: k.ist_date } : refuse("bad_unit_key");
  } else if (unitKind === "window") pair = await windowPair(unitKey);
  else if (unitKind === "consult") pair = await consultPair(unitKey);
  else return skip("unit_not_supported");
  if (isRefusal(pair)) return skip(pair.reason);
  const blind = blindRefusal(pair.room_id, pair.ist_date);
  if (blind) return skip(blind.reason, pair);

  if (r.id === "room_mic_quality" && unitKind === "room_hour") {
    const k = parseRoomHourKey(unitKey)!;
    const got = await readAudioHour(k.room_id, k.ist_date, k.hour);
    if (!got.ok) return skip(got.reason === "no_data" ? "no_audio_state" : got.reason, pair);
    return engine(() => evaluateRoomMicQuality(got.data), pair);
  }
  if (r.id === "talk_time" && unitKind === "window") {
    const got = await readWindowTurns(unitKey);
    if (!got.ok) return skip(got.reason, pair);
    const out = engine(() => evaluateTalkTime(got.data.turns, { start_ms: got.data.start_ms, end_ms: got.data.end_ms }), pair);
    return { ...out, evidence: { window_id: unitKey, turns: got.data.turns.length, attributed: got.data.attributed, diarize_state: got.data.diarize_state } };
  }
  if (r.id === "talk_time" && unitKind === "consult") {
    const span = await readConsultSpan(unitKey);
    if (!span.ok) return skip(span.reason, pair);
    const turns: Turn[] = [];
    let refused = 0;
    for (const w of span.data.windows) {
      const got = await readWindowTurns(w.window_id);
      if (!got.ok) { refused += 1; continue; }
      turns.push(...got.data.turns); // window bounds AND turn times are absolute epoch ms, the clock of t_open / t_close (G56): no offset
    }
    const out = engine(() => evaluateTalkTime(turns, { start_ms: span.data.t_open_ms, end_ms: span.data.t_close_ms }), pair);
    return { ...out, evidence: { consult_key: unitKey, windows: span.data.windows.length, windows_refused: refused, turns: turns.length, quality: span.data.quality } };
  }
  return skip("unit_not_supported", pair);
}

/**
 * S7-1: a consult unit of an llm_zdr rubric. Same order as every unit: resolve the room and date, REFUSE a held-out room-day, then read, then evaluate. A consult key the database does not know is,
 * in a BENCH only, a Meet teleconsult key: its text comes from the lab store (no room, so no room-day to hold out). In a normal run an unknown key is skipped as before. A model outage THROWS
 * (askJson), so the runner retries the step; a bad answer after the one retry is a failed unit with a closed reason.
 */
async function evaluateLlmUnit(r: Rubric, unitKind: RubricUnit, unitKey: string, opts: { bench?: boolean; excerpt?: boolean }): Promise<UnitOutcome> {
  if (unitKind !== "consult") return skip("unit_not_supported");
  let pair: Pair | null = null;
  if (opts.excerpt) {
    // S71-C2: a transcript EXCERPT a labeller saw. Bench only; its text is read from the lab store and nothing else (no consult, no room-day, no database read at all)
    if (!opts.bench) return skip("unit_not_supported");
    const ex = await readBenchText(unitKey, r.id);
    if (!ex.ok) return skip(ex.reason);
    return runLlm(r, { ...ex.data, partial: true }, null);
  }
  const p = await consultPair(unitKey);
  if (!isRefusal(p)) {
    const blind = blindRefusal(p.room_id, p.ist_date);
    if (blind) return skip(blind.reason, p);
    pair = p;
  } else if (!(opts.bench && p.reason === "not_found")) return skip(p.reason);
  const got = await readConsultText(unitKey, opts.bench ? { rubricId: r.id } : {});
  if (!got.ok) return skip(got.reason, pair);
  return runLlm(r, got.data, pair);
}

async function runLlm(r: Rubric, data: import("../readers/consult-text").ConsultText, pair: Pair | null): Promise<UnitOutcome> {
  const got = { data };
  try {
    const res = r.id === "consult_chair_affect" ? await evaluateConsultAffect(r, got.data) : r.id === "consult_surgical_pitch" ? await evaluateSurgicalPitch(r, got.data) : null;
    if (!res) return skip("unit_not_supported", pair);
    return { ...res, room_id: pair?.room_id ?? null, ist_date: pair?.ist_date ?? null };
  } catch (e) {
    if (String((e as Error)?.message ?? "").startsWith("llm_unavailable")) throw e; // transient: the runner retries
    console.error("[rubric] engine fault", JSON.stringify({ err: String((e as Error)?.name ?? "error") }));
    return { status: "failed", findings: [], reason: "engine_error", room_id: pair?.room_id ?? null, ist_date: pair?.ist_date ?? null };
  }
}

export type PlanParams = { unit_keys?: string[]; rooms?: string[]; from?: string; to?: string; limit: number };
export type Plan = { keys: string[]; truncated: boolean; blind_excluded?: number } | { error: string; detail?: string };

/** Which units a run covers: an explicit list, or (for the unit kinds that have a natural listing) a room / date range. Pure of writes. */
export async function resolveUnits(r: Rubric, unitKind: RubricUnit, p: PlanParams): Promise<Plan> {
  if (p.unit_keys && p.unit_keys.length > 0) {
    const keys = [...new Set(p.unit_keys)].slice(0, p.limit);
    return { keys, truncated: new Set(p.unit_keys).size > keys.length };
  }
  if (!p.from || !p.to || !isIstDate(p.from) || !isIstDate(p.to) || p.from > p.to) return { error: "range_required", detail: "give unit_keys, or from and to (IST dates)" };
  if (Date.parse(p.to) - Date.parse(p.from) > 31 * 86_400_000) return { error: "range_too_long", detail: "at most 31 days" };
  const rooms = (p.rooms ?? []).filter(isRoomId);
  if (unitKind === "room_hour") return listAudioHours({ rooms, from: p.from, to: p.to, limit: p.limit });
  if (unitKind === "consult") return listConsultKeys({ room: rooms[0], from: p.from, to: p.to, limit: p.limit });
  if (unitKind === "window" && r.id === "talk_time") {
    const room = rooms[0] ?? null;
    const days = BLIND_ROOM_DAYS.map(([d]) => d), blindRooms = BLIND_ROOM_DAYS.map(([, rm]) => rm);
    // G52: a held-out room-day's windows are excluded IN THE QUERY (so the limit counts real units) and counted separately
    const rows = (await sql`
      SELECT w.id FROM bench_window w JOIN room_day rd ON rd.id = w.room_day_id JOIN room_diarize_window d ON d.window_id = w.id AND d.state = 'ok'
       WHERE rd.ist_date BETWEEN ${p.from}::date AND ${p.to}::date AND (${room}::text IS NULL OR rd.room_id = ${room}::text)
         AND NOT EXISTS (SELECT 1 FROM unnest(${days}::date[], ${blindRooms}::text[]) AS b(d, r) WHERE b.d = rd.ist_date AND b.r = rd.room_id)
       ORDER BY rd.ist_date, w.start_ms, w.id LIMIT ${p.limit + 1}
    `) as Array<{ id: string }>;
    const ex = (await sql`
      SELECT count(*)::int AS n FROM bench_window w JOIN room_day rd ON rd.id = w.room_day_id JOIN room_diarize_window d ON d.window_id = w.id AND d.state = 'ok'
       WHERE rd.ist_date BETWEEN ${p.from}::date AND ${p.to}::date AND (${room}::text IS NULL OR rd.room_id = ${room}::text)
         AND EXISTS (SELECT 1 FROM unnest(${days}::date[], ${blindRooms}::text[]) AS b(d, r) WHERE b.d = rd.ist_date AND b.r = rd.room_id)
    `) as Array<{ n: number }>;
    return { keys: rows.slice(0, p.limit).map((x) => x.id), truncated: rows.length > p.limit, blind_excluded: Number(ex[0]?.n ?? 0) };
  }
  return { error: "no_listing", detail: `${unitKind} units must be given as unit_keys` };
}
