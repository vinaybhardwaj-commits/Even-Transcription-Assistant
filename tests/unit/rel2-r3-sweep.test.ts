/**
 * REL2-R3 SWEEP — (10 Oct 2026: the held-out rule is LIFTED; the former pairs are ordinary days: every read below SERVES them, nothing is refused or excluded.) Every MCP read that serves room-day content, for a formerly held-out pair. sql and the brain query helper are fakes: each call names the held-out pair and the
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

const { FORMER_BLIND_PAIRS } = await import("../support/former-blind-pairs");
const S = await import("@/lib/mcp/surface");
const [BD, BR] = FORMER_BLIND_PAIRS[0]!;
const ROOM = { id: BR, slug: "blind-room", name: "Blind Room", disabled_at: null, enabled: true };
const ctx = { origin: "x", actor: "a", scopes: new Set(["read", "invoke"]) } as never;
const call = async (name: string, args: Row) => (await S.CALLABLE_TOOLS.get(name)!.handler(args, ctx)) as Row;
const content = (re: RegExp) => [...statements.map((s) => s.text), ...brainQueries.map((q) => q.text)].filter((t) => re.test(t));
const PLACE_BLIND_DAY: [RegExp, Row[]] = [/FROM room_day WHERE id/, [{ room_id: BR, ist_date: BD }]];
const ROOM_ROW: [RegExp, Row[]] = [/FROM room\s/, [ROOM]];

beforeEach(() => { statements.length = 0; brainQueries.length = 0; answers = [ROOM_ROW]; });

describe("pair-keyed reads (a room and an IST date, or a room-day id)", () => {
  it("scribe_get_state and scribe_list_cues: a formerly held-out pair is NOT refused (no blind_room_day)", async () => {
    const a = await call("scribe_get_state", { room_id: BR, ist_date: BD });
    const b = await call("scribe_list_cues", { room_id: BR, ist_date: BD });
    expect(a.error).not.toBe("blind_room_day");
    expect(b.error).not.toBe("blind_room_day");
  });
  it("scribe_encounter_hypotheses and scribe_encounter_shadow_run: by room + date, and by a room-day id that resolves to a formerly held-out pair, none is refused", async () => {
    expect((await call("scribe_encounter_hypotheses", { room_id: BR, ist_date: BD })).error).not.toBe("blind_room_day");
    answers = [ROOM_ROW, PLACE_BLIND_DAY];
    expect((await call("scribe_encounter_hypotheses", { room_day_id: "rd_b" })).error).not.toBe("blind_room_day");
    expect((await call("scribe_encounter_shadow_run", { room_id: BR, ist_date: BD })).error).not.toBe("blind_room_day");
    expect((await call("scribe_encounter_shadow_run", { room_id: "r1", ist_date: "2026-10-05", room_day_id: "rd_b" })).error).not.toBe("blind_room_day");
    expect(content(/encounter_hypothesis_run/).length).toBeGreaterThan(0);
  });
  it("scribe_jev_signals serves a formerly held-out room-day id (the signal table is read); scribe_jev_decisions excludes no subject (no held-out clauses, no room tables in its SQL)", async () => {
    answers = [PLACE_BLIND_DAY];
    expect(await call("scribe_jev_signals", { room_day_id: "rd_b" })).toMatchObject({ ok: true, room_day_id: "rd_b" });
    expect(brainQueries.filter((q) => /jev_window_signal/.test(q.text)).length).toBeGreaterThan(0);
    await call("scribe_jev_decisions", {});
    const q = brainQueries.find((x) => /FROM jev_decision/.test(x.text))!;
    expect(q.text).not.toMatch(/unnest|room_day|bench_window|room_diarize_window|NOT EXISTS/);
    expect(q.params).toEqual([null, null, null, null, 100, null, null, null, null, null]);
  });
  it("scribe_fuse_report: a formerly held-out day (and a scratch day replaying it) is served", async () => {
    answers = [[/FROM room_day WHERE id|room_day_by_id|FROM room_day rd/, [{ id: "rd_b", room_id: BR, ist_date: BD, scratch: false }]]];
    expect(await call("scribe_fuse_report", { room_day_id: "rd_b" })).toMatchObject({ ok: true, room_day_id: "rd_b" });
  });
  it("scribe_tape_day: a named formerly held-out room is served and its audio rows are read; the unnamed listing excludes and counts nothing", async () => {
    answers = [ROOM_ROW];
    expect(await call("scribe_tape_day", { ist_date: BD, room: BR })).toMatchObject({ ok: true });
    answers = [[/SELECT count\(\*\)::int AS n FROM room_audio_day/, [{ n: 0 }]], [/FROM room_audio_day\s+WHERE ist_day = /, []]];
    const out = await call("scribe_tape_day", { ist_date: BD });
    expect(out).toMatchObject({ ok: true });
    expect(out.n_blind_excluded ?? 0).toBe(0);
    expect(content(/FROM room_audio_day/).length).toBeGreaterThan(0);
  });
  it("scribe_room_levels: a range on a formerly held-out day is served, and the level table is read", async () => {
    expect((await call("scribe_room_levels", { room_id: BR, ist_date: BD })).error).not.toBe("blind_room_day");
    expect(content(/bench_level_sample/).length).toBeGreaterThan(0);
  });
  it("scribe_reb_index: no held-out (room, date) exclusion is in the SQL any more (the unnest list is empty)", async () => {
    await call("scribe_reb_index", { ist_date: "2026-10-05" });
    const q = statements.find((x) => /FROM reb_track_index/.test(x.text))!;
    expect(q).toBeDefined();
  });
});

describe("window-keyed reads (a window id, or a list of runs / windows)", () => {
  const BLIND_WIN: [RegExp, Row[]] = [/FROM bench_window w\s+LEFT JOIN room_diarize_window dw ON dw\.window_id = w\.id\s+WHERE w\.id = /, [{ blind: true }]];
  it("scribe_stt_windows: a window and a formerly held-out (room, day) listing are served, not refused", async () => {
    answers = [ROOM_ROW];
    expect((await call("scribe_stt_windows", { window_id: "bw_x" })).error).not.toBe("blind_room_day");
    statements.length = 0;
    expect(await call("scribe_stt_windows", { room: BR, ist_date: BD })).toMatchObject({ ok: true });
    expect(content(/FROM bench_window w\s+JOIN bench_session/).length).toBeGreaterThan(0);
  });
  it("scribe_stt_windows (a clean day): every window is listed, none is left out or counted", async () => {
    answers = [[/FROM room\s/, [{ ...ROOM, id: "r1" }]], [/FROM bench_window w\s+JOIN bench_session/, [{ id: "bw_ok", room_day_id: "rd_1", start_ms: 0, end_ms: 900_000, source_mic: "primary", state: "transcribed", closed_at: null }, { id: "bw_bad", room_day_id: "rd_1", start_ms: 900_000, end_ms: 1_800_000, source_mic: "primary", state: "transcribed", closed_at: null }]],
      ];
    const out = await call("scribe_stt_windows", { room: "r1", ist_date: "2026-10-05" }) as { count: number; n_blind_excluded: number; windows: Array<{ id: string }> };
    expect(out).toMatchObject({ ok: true, count: 2 });
    expect(out.n_blind_excluded ?? 0).toBe(0);
    expect(out.windows.map((w) => w.id)).toEqual(["bw_ok", "bw_bad"]);
  });
  it("scribe_stt_runs (the list): every run is listed, none is excluded", async () => {
    answers = [[/FROM transcription_run tr/, [{ subject_type: "bench_window", subject_id: "bw_bad", id: "bw_bad", engines: 1, errored: 0 }, { subject_type: "bench_window", subject_id: "bw_ok", id: "bw_ok", engines: 1, errored: 0 }]]];
    const out = await call("scribe_list_stt_runs", {}) as { runs: Array<{ id?: string; subject_id?: string }>; n_blind_excluded: number };
    expect(out.n_blind_excluded ?? 0).toBe(0);
    expect(out.runs).toHaveLength(2);
  });
  it("scribe_get_stt_run (the detail): a bench window is served (never blind_room_day) and its runs are read", async () => {
    answers = [[/SELECT DISTINCT subject_type/, [{ subject_type: "bench_window" }]], [/FROM bench_window WHERE id/, [{ id: "bw_x", session_id: "s", start_ms: 0, end_ms: 1, source_mic: "primary", state: "closed" }]]];
    const name = [...S.CALLABLE_TOOLS.keys()].find((k) => /stt_run/.test(k) && k !== "scribe_list_stt_runs")!;
    expect((await call(name, { subject_id: "bw_x", include_text: true })).error).not.toBe("blind_room_day");
    expect(content(/FROM transcription_run/).length).toBeGreaterThan(0);
  });
});

describe("K3-3 scratch twins: a scratch room / day of a formerly held-out real room is ordinary too", () => {
  const SCRATCH = `room_scratch_${BR.replace(/^room_/, "")}`;
  it("isBlindRoomDay is false for the real and the scratch id of a former pair; the literal prefixes still equal lib/brain/scratch's", async () => {
    const { isBlindRoomDay } = await import("@/lib/rubrics/blind-room-days");
    const { SCRATCH_ROOM_PREFIX, ROOM_PREFIX, scratchRoomIdFor, realRoomIdFor } = await import("@/lib/brain/scratch");
    expect(SCRATCH_ROOM_PREFIX).toBe("room_scratch_");
    expect(ROOM_PREFIX).toBe("room_");
    expect(scratchRoomIdFor(BR)).toBe(SCRATCH);
    expect(realRoomIdFor(SCRATCH)).toBe(BR);
    expect(isBlindRoomDay(BD, BR)).toBe(false);
    expect(isBlindRoomDay(BD, SCRATCH)).toBe(false);
    expect(isBlindRoomDay("2026-10-05", SCRATCH)).toBe(false);
  });
  it("scribe_get_state and scribe_list_cues with the SCRATCH room id are not refused", async () => {
    answers = [[/FROM room\s/, [{ ...ROOM, id: SCRATCH }]]];
    expect((await call("scribe_get_state", { room_id: SCRATCH, ist_date: BD })).error).not.toBe("blind_room_day");
    expect((await call("scribe_list_cues", { room_id: SCRATCH, ist_date: BD })).error).not.toBe("blind_room_day");
  });
  it("scribe_fuse_run (every arm) on a scratch day of the former pair is not refused with blind_room_day", async () => {
    answers = [[/FROM room_day/, [{ id: "rd_scratch_x", room_id: SCRATCH, ist_date: BD, scratch: true }]]];
    for (const arm of ["rules", "hybrid", "flash", "jev"]) {
      expect((await call("scribe_fuse_run", { room_day_id: "rd_scratch_x", arm, dry_run: true }) as Row).error, arm).not.toBe("blind_room_day");
    }
  });
});
