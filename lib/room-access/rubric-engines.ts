/**
 * lib/rubrics/engines/index.ts — S7-0: evaluate ONE unit of a code-engine rubric (read inputs through the readers, run the pure engine), and resolve which units a run covers.
 * Engines jev and llm_zdr are not wired in this slice (canRun refuses them before a job is queued).
 */
import { evaluateEhrc } from "@/lib/rubrics/engines/ehrc";
import { listSurgicalStays, parseStayKey } from "@/lib/rubrics/readers/stay-record";
import { sql } from "@/lib/db";
import type { Rubric, RubricUnit } from "@/lib/rubrics/types";
import { listAudioHours, listConsultKeys, parseRoomHourKey, readAudioHour, readConsultSpan, readWindowTurns, windowPair, consultPair, isRefusal, blindRefusal, refuse, isIstDate, isRoomId, type ReadRefusal } from "@/lib/rubrics/readers";
import type { Turn } from "@/lib/room-access/readers/turns";
import { evaluateRoomMicQuality } from "@/lib/rubrics/engines/room-mic-quality";
import { evaluateTalkTime } from "@/lib/rubrics/engines/talk-time";
import { evaluateConsultAffect, evaluateSurgicalPitch } from "@/lib/rubrics/engines/consult-llm";
import { readBenchText, readConsultText } from "@/lib/rubrics/readers/consult-text";
import { evaluateEncounterVsRecord, evaluateEvrWindow } from "@/lib/rubrics/engines/evr";
import type { PerturbKind, WindowOutcome } from "@/lib/rubrics/evr/perturb";
import type { EngineResult, UnitOutcome } from "@/lib/rubrics/engines/types";
import { BLIND_ROOM_DAYS } from "@/lib/rubrics/blind-room-days";
/** S7-3: the most stays one run covers */
export const STAY_RUN_MAX = 50;


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
export async function evaluateUnit(r: Rubric, unitKind: RubricUnit, unitKey: string, opts: { bench?: boolean; excerpt?: boolean; room_id?: string | null; room_ids?: string[] | null; ist_date?: string | null } = {}): Promise<UnitOutcome> {
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
async function evaluateLlmUnit(r: Rubric, unitKind: RubricUnit, unitKey: string, opts: { bench?: boolean; excerpt?: boolean; room_id?: string | null; room_ids?: string[] | null; ist_date?: string | null }): Promise<UnitOutcome> {
  if (unitKind === "stay" && r.id === "ehrc_surgical_outcome") {
    // S7-3: a stay has no room and no room-day (the held-out set is by room-day, so it cannot apply); its IST date is the admission's. The warehouse read is READ ONLY and PHI-free (stay-record.ts).
    const e = await evaluateEhrc(r, unitKey);
    const { ist_date, ...rest } = e;
    return { ...rest, calls: e.calls ?? 0, room_id: null, ist_date: ist_date ?? null };
  }
  if (unitKind !== "consult") return skip("unit_not_supported");
  let pair: Pair | null = null;
  if (opts.excerpt) {
    // S71-C2: a transcript EXCERPT a labeller saw. Bench only; its text is read from the lab store and nothing else (no consult, no room-day, no database read at all)
    if (!opts.bench || r.id === "encounter_vs_record") return skip("unit_not_supported");
    // S71-R4 G70: an excerpt is PLACED (room + IST date) and meets the same held-out check as a consult BEFORE any lab-store read or model call; unplaced = refused, never scored
    // one room (room_id) or several candidate rooms (room_ids: a token that maps to two room-days): every candidate must be a valid room, and ANY held-out candidate refuses the excerpt
    // Q2: a row carrying BOTH room_id and room_ids is checked against the UNION (neither replaces the other)
    const rooms = [...new Set([...(opts.room_ids ?? []), ...(opts.room_id ? [opts.room_id] : [])])] as string[];
    if (rooms.length === 0 || !opts.ist_date || !isIstDate(opts.ist_date) || !rooms.every((x) => isRoomId(x))) return skip("excerpt_unplaced");
    const exBlindRoom = rooms.find((x) => blindRefusal(x, opts.ist_date!));
    if (exBlindRoom) return skip("blind_room_day", { room_id: exBlindRoom, ist_date: opts.ist_date });
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
  return runLlm(r, got.data, pair, unitKey);
}

async function runLlm(r: Rubric, data: import("@/lib/rubrics/readers/consult-text").ConsultText, pair: Pair | null, unitKey = ""): Promise<UnitOutcome> {
  const got = { data };
  try {
    const res = r.id === "consult_chair_affect" ? await evaluateConsultAffect(r, got.data) : r.id === "consult_surgical_pitch" ? await evaluateSurgicalPitch(r, got.data) : r.id === "encounter_vs_record" ? await evaluateEncounterVsRecord(r, got.data, unitKey) : null;
    if (!res) return skip("unit_not_supported", pair);
    // G75: the engine's own count of its model calls first; attempts in the score / evidence otherwise
    return { ...res, calls: res.calls ?? Number(res.score?.attempts ?? res.evidence?.attempts ?? (res.status === "skipped" ? 0 : 1)), room_id: pair?.room_id ?? null, ist_date: pair?.ist_date ?? null };
  } catch (e) {
    if (String((e as Error)?.message ?? "").startsWith("llm_unavailable")) throw e; // transient: the runner retries
    console.error("[rubric] engine fault", JSON.stringify({ err: String((e as Error)?.name ?? "error") }));
    return { status: "failed", findings: [], reason: "engine_error", room_id: pair?.room_id ?? null, ist_date: pair?.ist_date ?? null };
  }
}

/**
 * S7-2: one window of the evr_perturb bench. Same order as every unit: resolve the pair, REFUSE a held-out room-day, then read (the consult text from the database, the record from the
 * warehouse), then score the original and its perturbed copies. Returns counts only. A model outage THROWS (the runner retries).
 */
export async function evaluateEvrPerturbUnit(r: Rubric, unitKey: string, seed: number, kinds?: readonly PerturbKind[]): Promise<{ ok: true; outcome: WindowOutcome; calls: number } | { ok: false; reason: string; calls: number }> {
  if (r.id !== "encounter_vs_record") return { ok: false, reason: "unit_not_supported", calls: 0 };
  const p = await consultPair(unitKey);
  if (isRefusal(p)) return { ok: false, reason: p.reason, calls: 0 };
  const blind = blindRefusal(p.room_id, p.ist_date);
  if (blind) return { ok: false, reason: blind.reason, calls: 0 };
  const got = await readConsultText(unitKey, {});
  if (!got.ok) return { ok: false, reason: got.reason, calls: 0 };
  return evaluateEvrWindow(r, got.data, unitKey, seed, kinds);
}

export type PlanParams = { unit_keys?: string[]; rooms?: string[]; from?: string; to?: string; limit: number };
export type Plan = { keys: string[]; truncated: boolean; blind_excluded?: number } | { error: string; detail?: string };

/** Which units a run covers: an explicit list, or (for the unit kinds that have a natural listing) a room / date range. Pure of writes. */
export async function resolveUnits(r: Rubric, unitKind: RubricUnit, p: PlanParams): Promise<Plan> {
  if (unitKind === "stay") {
    // S7-3: at most STAY_RUN_MAX stays; explicit keys must be stay:<uid>; or admission dates (IST, span <= 31 days) over SURGICAL stays only
    if (p.unit_keys && p.unit_keys.length > 0) {
      const all = [...new Set(p.unit_keys)];
      const keys = all.filter((k) => parseStayKey(k) !== null).slice(0, Math.min(p.limit, STAY_RUN_MAX));
      if (keys.length === 0) return { error: "bad_unit_key", detail: "stay keys look like stay:<uid>" };
      return { keys, truncated: all.length > keys.length };
    }
    if (!p.from || !p.to || !isIstDate(p.from) || !isIstDate(p.to) || p.from > p.to) return { error: "range_required", detail: "give unit_keys, or from and to (IST admission dates)" };
    // E3-4: 31 dates INCLUSIVE (to - from <= 30 days)
    if ((Date.parse(p.to) - Date.parse(p.from)) / 86_400_000 + 1 > 31) return { error: "range_too_long", detail: "at most 31 days" };
    return listSurgicalStays(p.from, p.to, Math.min(p.limit, STAY_RUN_MAX));
  }
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
