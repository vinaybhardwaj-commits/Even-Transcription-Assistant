/**
 * REL2-R3 SWEEP — every MCP read that serves room-day content refuses (or excludes and counts) a held-out pair. sql and the brain query helper are fakes: each call names the held-out pair and the
 * assertions are what was NOT read.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const statements: Array<{ text: string; values: unknown[] }> = [];
const brainQueries: Array<{ text: string; params: unknown[] }> = [];
let answers: Array<[RegExp, Row[]]> = [];
const reply = (text: string): Row[] => { for (const [re, rows] of answers) if (re.test(text)) return rows; return []; };
vi.mock("@/lib/db", () => ({ sql: Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => { const text = strings.join("?"); statements.push({ text, values }); return Promise.resolve(reply(text)); }, { transaction: async () => [] }) }));
vi.mock("@/lib/brain/db", async (orig) => ({ ...((await orig()) as object), query: async (text: string, params: unknown[]) => { brainQueries.push({ text, params }); return { rows: reply(text) }; }, getPool: () => ({}) }));
vi.mock("@/lib/brain/state", async (orig) => ({ ...((await orig()) as object), roomExists: async () => true, findRoomDay: async () => { throw new Error("findRoomDay must not be reached"); }, readGraph: async () => { throw new Error("readGraph must not be reached"); }, listCuesForDay: async () => { throw new Error("listCuesForDay must not be reached"); } }));

const { BLIND_ROOM_DAYS } = await import("@/lib/rubrics/blind-room-days");
const S = await import("@/lib/mcp/surface");
const [BD, BR] = BLIND_ROOM_DAYS[0]!;
const ROOM = { id: BR, slug: "blind-room", name: "Blind Room", disabled_at: null, enabled: true };
const ctx = { origin: "x", actor: "a", scopes: new Set(["read", "invoke"]) } as never;
const call = async (name: string, args: Row) => (await S.CALLABLE_TOOLS.get(name)!.handler(args, ctx)) as Row;
const content = (re: RegExp) => [...statements.map((s) => s.text), ...brainQueries.map((q) => q.text)].filter((t) => re.test(t));
const PLACE_BLIND_DAY: [RegExp, Row[]] = [/FROM room_day WHERE id/, [{ room_id: BR, ist_date: BD }]];
const ROOM_ROW: [RegExp, Row[]] = [/FROM room\s/, [ROOM]];

beforeEach(() => { statements.length = 0; brainQueries.length = 0; answers = [ROOM_ROW]; });

describe("pair-keyed reads (a room and an IST date, or a room-day id)", () => {
  it("scribe_get_state and scribe_list_cues: blind_room_day, no graph, no cue read", async () => {
    expect(await call("scribe_get_state", { room_id: BR, ist_date: BD })).toMatchObject({ state: null, error: "blind_room_day" });
    expect(await call("scribe_list_cues", { room_id: BR, ist_date: BD })).toMatchObject({ cues: [], error: "blind_room_day" });
    expect(content(/FROM (cue|visit|speaker_cluster|room_day)\b/)).toEqual([]);
  });
  it("scribe_encounter_hypotheses and scribe_encounter_shadow_run: by room + date, and by a room-day id that resolves to a held-out pair", async () => {
    expect(await call("scribe_encounter_hypotheses", { room_id: BR, ist_date: BD })).toMatchObject({ run: null, error: "blind_room_day" });
    answers = [ROOM_ROW, PLACE_BLIND_DAY];
    expect(await call("scribe_encounter_hypotheses", { room_day_id: "rd_b" })).toMatchObject({ run: null, error: "blind_room_day" });
    expect(await call("scribe_encounter_shadow_run", { room_id: BR, ist_date: BD })).toMatchObject({ ok: false, error: "blind_room_day" });
    expect(await call("scribe_encounter_shadow_run", { room_id: "r1", ist_date: "2026-10-05", room_day_id: "rd_b" })).toMatchObject({ ok: false, error: "blind_room_day" });
    expect(content(/encounter_hypothesis_run/)).toEqual([]);
  });
  it("scribe_jev_signals refuses a held-out room-day id before the signal table; scribe_jev_decisions excludes a held-out subject IN SQL (the room-day itself, and a window by any placement)", async () => {
    answers = [PLACE_BLIND_DAY];
    expect(await call("scribe_jev_signals", { room_day_id: "rd_b" })).toMatchObject({ ok: false, error: "blind_room_day", signals: [] });
    expect(brainQueries.filter((q) => /jev_window_signal/.test(q.text))).toEqual([]);
    await call("scribe_jev_decisions", {});
    const q = brainQueries.find((x) => /FROM jev_decision/.test(x.text))!;
    expect(q.text).toMatch(/NOT EXISTS \(SELECT 1 FROM room_day r1, unnest\(\$6::date\[\], \$7::text\[\]\) AS b\(d, r\) WHERE r1\.id = jev_decision\.subject_id/);
    expect(q.text).toMatch(/NOT EXISTS \(SELECT 1 FROM bench_window bw LEFT JOIN room_diarize_window dw ON dw\.window_id = bw\.id, room_day r1, unnest\(\$6::date\[\], \$7::text\[\]\) AS b\(d, r\) WHERE bw\.id = jev_decision\.subject_id AND r1\.id IN \(bw\.room_day_id, dw\.room_day_id\)/);
    expect(q.params.slice(-2)).toEqual([BLIND_ROOM_DAYS.map(([d]) => d), BLIND_ROOM_DAYS.map(([, r]) => r)]);
  });
  it("scribe_fuse_report: a held-out day is refused, and so is a scratch day that replays a held-out real room", async () => {
    answers = [[/FROM room_day WHERE id|room_day_by_id|FROM room_day rd/, [{ id: "rd_b", room_id: BR, ist_date: BD, scratch: false }]]];
    expect(await call("scribe_fuse_report", { room_day_id: "rd_b" })).toMatchObject({ ok: false, error: "blind_room_day" });
    expect(content(/FROM cue/)).toEqual([]);
  });
  it("scribe_tape_day: a named held-out room is refused; an unnamed one lists the others in SQL with the held-out rows excluded and counted; segments are not read for it", async () => {
    answers = [ROOM_ROW];
    expect(await call("scribe_tape_day", { ist_date: BD, room: BR })).toMatchObject({ ok: false, error: "blind_room_day" });
    expect(content(/room_audio_(day|state)/)).toEqual([]);
    answers = [[/SELECT count\(\*\)::int AS n FROM room_audio_day/, [{ n: 3 }]], [/FROM room_audio_day\s+WHERE ist_day = /, []]];
    const out = await call("scribe_tape_day", { ist_date: BD });
    expect(out).toMatchObject({ ok: true, n_blind_excluded: 3 });
    expect(content(/FROM room_audio_day\s+WHERE ist_day[\s\S]*NOT EXISTS \(SELECT 1 FROM unnest/)).toHaveLength(1);
  });
  it("scribe_room_levels: a range that touches a held-out day is refused whole, before any level row", async () => {
    expect(await call("scribe_room_levels", { room_id: BR, ist_date: BD })).toMatchObject({ error: "blind_room_day", samples: [] });
    expect(content(/bench_level_sample/)).toEqual([]);
  });
  it("scribe_reb_index: index rows of a held-out (room, date) are excluded in SQL", async () => {
    await call("scribe_reb_index", { ist_date: "2026-10-05" });
    const q = statements.find((x) => /FROM reb_track_index/.test(x.text))!;
    expect(q.text).toMatch(/NOT EXISTS \(SELECT 1 FROM unnest\(\?::date\[\], \?::text\[\]\) AS b\(d, r\) WHERE b\.d = reb_track_index\.ist_date AND b\.r = reb_track_index\.room_id\)/);
  });
});

describe("window-keyed reads (a window id, or a list of runs / windows)", () => {
  const BLIND_WIN: [RegExp, Row[]] = [/FROM bench_window w\s+LEFT JOIN room_diarize_window dw ON dw\.window_id = w\.id\s+WHERE w\.id = /, [{ blind: true }]];
  it("scribe_stt_windows: one window with ANY held-out placement is blind_room_day before its row, its drain jobs or its runs; a held-out (room, day) listing is refused", async () => {
    answers = [ROOM_ROW, BLIND_WIN];
    expect(await call("scribe_stt_windows", { window_id: "bw_x" })).toMatchObject({ ok: false, error: "blind_room_day" });
    expect(content(/FROM stt_subject_job|FROM transcription_run/)).toEqual([]);
    statements.length = 0;
    expect(await call("scribe_stt_windows", { room: BR, ist_date: BD })).toMatchObject({ ok: false, error: "blind_room_day" });
    expect(content(/FROM bench_window w\s+JOIN bench_session/)).toEqual([]);
  });
  it("scribe_stt_windows (a clean day): windows with a held-out placement are left out and counted", async () => {
    answers = [[/FROM room\s/, [{ ...ROOM, id: "r1" }]], [/FROM bench_window w\s+JOIN bench_session/, [{ id: "bw_ok", room_day_id: "rd_1", start_ms: 0, end_ms: 900_000, source_mic: "primary", state: "transcribed", closed_at: null }, { id: "bw_bad", room_day_id: "rd_1", start_ms: 900_000, end_ms: 1_800_000, source_mic: "primary", state: "transcribed", closed_at: null }]],
      [/SELECT w\.id FROM bench_window w LEFT JOIN room_diarize_window dw/, [{ id: "bw_bad" }]]];
    const out = await call("scribe_stt_windows", { room: "r1", ist_date: "2026-10-05" }) as { count: number; n_blind_excluded: number; windows: Array<{ id: string }> };
    expect(out).toMatchObject({ ok: true, count: 1, n_blind_excluded: 1 });
    expect(out.windows.map((w) => w.id)).toEqual(["bw_ok"]);
  });
  it("scribe_stt_runs (the list): runs on a bench window with a held-out placement are not listed and are counted", async () => {
    answers = [[/FROM transcription_run tr/, [{ subject_type: "bench_window", subject_id: "bw_bad", id: "bw_bad", engines: 1, errored: 0 }, { subject_type: "bench_window", subject_id: "bw_ok", id: "bw_ok", engines: 1, errored: 0 }]], [/SELECT w\.id FROM bench_window w LEFT JOIN room_diarize_window dw/, [{ id: "bw_bad" }]]];
    const out = await call("scribe_list_stt_runs", {}) as { runs: Array<{ id?: string; subject_id?: string }>; n_blind_excluded: number };
    expect(out.n_blind_excluded).toBe(1);
    expect(out.runs).toHaveLength(1);
    expect(JSON.stringify(out.runs)).not.toContain("bw_bad");
  });
  it("scribe_get_stt_run (the detail): a bench window with a held-out placement is blind_room_day, with no run, transcript or gold read", async () => {
    answers = [[/SELECT DISTINCT subject_type/, [{ subject_type: "bench_window" }]], [/FROM bench_window WHERE id/, [{ id: "bw_x", session_id: "s", start_ms: 0, end_ms: 1, source_mic: "primary", state: "closed" }]], BLIND_WIN];
    const name = [...S.CALLABLE_TOOLS.keys()].find((k) => /stt_run/.test(k) && k !== "scribe_list_stt_runs")!;
    expect(await call(name, { subject_id: "bw_x", include_text: true })).toMatchObject({ error: "blind_room_day", runs: [], gold: null });
    expect(content(/transcript_english|FROM stt_gold/)).toEqual([]); // the runs (with transcripts) and the gold; the subject-type probe is metadata
  });
});
