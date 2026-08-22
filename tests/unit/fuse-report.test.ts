/**
 * Fuse slice 5 — the scoreboard.
 *
 * The two tests that matter most are the corpus headlines, and both are the reason the report
 * exists at all:
 *
 *   · OPD 7's SIX-HOUR SILENCE, 04:36:59Z → 10:39:35Z, tape running, no warehouse event of any
 *     kind. It is found from the CUE TIMELINE. No visit represents it, so a visit-shaped view
 *     of the day cannot see it, and a report that only counted visits would show a clean day.
 *   · CARDIOLOGY's TWO UNACCOUNTED MARKS — a clinician tapped the kiosk and the warehouse has
 *     no trace of the consult.
 *
 * Everything is read through a fake Postgres. The last test asserts the whole run issues no
 * INSERT, UPDATE or DELETE of any kind.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

const appCalls: Array<{ text: string; values: unknown[] }> = [];
const brainCalls: Array<{ text: string; values: unknown[] }> = [];
let appResponder: (text: string, values: unknown[]) => Row[] = () => [];
let brainResponder: (text: string, values: unknown[]) => Row[] = () => [];

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    appCalls.push({ text, values });
    return Promise.resolve(appResponder(text, values));
  },
}));
vi.mock("@/lib/brain/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    brainLog: () => {},
    query: async (t: string, v?: unknown[]) => {
      brainCalls.push({ text: t, values: v ?? [] });
      const rows = brainResponder(t, v ?? []);
      return { rows, rowCount: rows.length };
    },
    getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
  };
});
vi.mock("@/lib/r2", () => ({ signGetUrl: async () => "", getObjectBytes: async () => new Uint8Array() }));
vi.mock("@/lib/whisper", () => ({ transcribeWithWhisper: async () => ({ ok: true, transcript: "" }) }));
vi.mock("@/lib/bench-timeline", () => ({ renderBenchTimeline: async () => ({ markdown: "" }) }));

import { FUSE_REPORT_TOOLS, SILENCE_THRESHOLD_MS, LOW_CONFIDENCE_BELOW } from "@/lib/mcp/tools/fuse-report";
import { ALL_RULES_REASONS, LAST_MARK_WINDOW_MS, RULES_REASONS } from "@/lib/brain/fuse/rules";
import { SCRATCH_ROOM_PREFIX, realRoomIdFor, scratchRoomIdFor } from "@/lib/brain/scratch";

const tool = FUSE_REPORT_TOOLS.find((t) => t.name === "scribe_fuse_report")!;
const run = (args: Row) => tool.handler(args, { origin: "https://preview.example" }) as Promise<Row>;

// ---------------------------------------------------------------------------
// the world
// ---------------------------------------------------------------------------

const REAL_ROOM = { id: "room_qyzghzaf", slug: "opd-7-k4hz", name: "OPD 7", disabled_at: null };
const SCRATCH_ROOM = scratchRoomIdFor(REAL_ROOM.id);
const DAY = "rd_scratch_qyzghzaf_20260819";
const IST = "2026-08-19";

let n = 0;
const cue = (type: string, at: string, payload: Row | null, source_ref: string | null = null): Row => ({
  id: `cue_r${String(++n).padStart(3, "0")}`, type, at: new Date(at), payload,
  source: source_ref ? "warehouse" : "replay", source_ref,
});
const wh = (type: string, at: string, ref: string, extra: Row = {}) =>
  cue(type, at, { source: "warehouse", source_ref: ref, individual_uid: "ind_secret_0001", in_tape_window: true, ...extra }, ref);
const mark = (at: string) => cue("consult_mark", at, { source: "kiosk" });

let CUES: Row[];
let TURN_COUNTS: Row[];
let VISITS: Row[];
let SESSIONS: Row[];
let CHUNKS: Row[];
let dayRow: Row | null;

function seed() {
  n = 0;
  appCalls.length = 0;
  brainCalls.length = 0;
  dayRow = { id: DAY, room_id: SCRATCH_ROOM, doctor_id: null, ist_date: IST, started_at: new Date(), ended_at: null, scratch: true };
  // tape 04:00 → 11:30, one session
  SESSIONS = [{ id: "bs_1", room_id: REAL_ROOM.id, started_at: new Date(`${IST}T04:00:00Z`), ended_at: new Date(`${IST}T11:00:00Z`), status: "ended", label: null, mic_label: null, notes: null, room_name: REAL_ROOM.name, room_slug: REAL_ROOM.slug }];
  CHUNKS = [{ id: "bc_1", idx: 0, source: "primary", started_at: new Date(`${IST}T04:00:00Z`), ended_at: new Date(`${IST}T11:30:00Z`), duration_ms: 1, size_bytes: 1, upload_state: "verified", gap_before_ms: 0, created_at: new Date(`${IST}T11:30:00Z`), r2_key: "k", content_type: "audio/webm" }];
  TURN_COUNTS = [];
  CUES = [
    mark(`${IST}T04:02:29.995Z`),
    wh("pqm_called", `${IST}T04:36:59.000Z`, "qts_1"),
    wh("pstart", `${IST}T10:39:35.000Z`, "svc_1", { calendar_uid: "cal_1" }),
    wh("pulse_note", `${IST}T10:55:00.000Z`, "pn_1"),
  ];
  VISITS = [
    { id: "vis_a", individual_uid: "ind_secret_0001", state: "ended", confidence: 0.9, end_reason: "pulse_note", ambiguity: null, arm: "rules", opened_by: "svc_1", opened_by_kind: "pstart" },
    { id: "vis_b", individual_uid: null, state: "unknown", confidence: 0.3, end_reason: null, ambiguity: RULES_REASONS.MARK_WITHOUT_WAREHOUSE_EVIDENCE, arm: "rules", opened_by: "cue_r001", opened_by_kind: "mark" },
    { id: "vis_c", individual_uid: "ind_secret_0002", state: "ended", confidence: 0.45, end_reason: "day_rollover", arm: "rules", opened_by: "qts_1", opened_by_kind: "pqm_called",
      ambiguity: `${RULES_REASONS.PQM_CALLED_WITHOUT_PSTART},${RULES_REASONS.INFERRED_ATTRIBUTION_ONLY}` },
    { id: "vis_h", individual_uid: null, state: "ended", confidence: 0.8, end_reason: "day_rollover", ambiguity: null, arm: "hybrid", opened_by: "svc_1", opened_by_kind: "pstart" },
  ];

  appResponder = (text) => {
    if (/^SELECT id, slug, name, disabled_at FROM room WHERE id =/.test(text)) return [REAL_ROOM];
    if (/FROM bench_session s/.test(text)) return SESSIONS;
    if (/FROM bench_chunk/.test(text)) return CHUNKS;
    return [];
  };
  brainResponder = (text, values) => {
    if (/FROM room_day WHERE id = \$1/.test(text)) return dayRow ? [dayRow] : [];
    // slice A's own aggregate, before the general cue read — it is a different question
    if (/COUNT\(\*\)::int AS n FROM cue/.test(text.replace(/\s+/g, " "))) return TURN_COUNTS;
    if (/FROM cue\s+WHERE room_day_id/.test(text.replace(/\s+/g, " "))) return CUES;
    if (/FROM visit WHERE room_day_id = \$1 AND COALESCE\(arm, 'rules'\)/.test(text)) {
      return VISITS.filter((v) => (v.arm ?? "rules") === values[1]);
    }
    return [];
  };
}
beforeEach(seed);

// ===========================================================================

describe("1 — a scratch room-day resolves its real room and reads THAT room's tape", () => {
  it("walks back through the exported inverse, and reads the real room's sessions", async () => {
    const out = await run({ room_day_id: DAY });
    expect(out.ok).toBe(true);
    expect(out.room).toMatchObject({ scratch_room_id: SCRATCH_ROOM, real_room_id: REAL_ROOM.id, real_room_slug: REAL_ROOM.slug, is_scratch: true });
    // the tape came from the REAL room, which is the whole reason this tool exists
    expect(appCalls.some((c) => c.values.includes(REAL_ROOM.id))).toBe(true);
    expect((out.tape as Row).sessions).toHaveLength(1);
    expect(realRoomIdFor(SCRATCH_ROOM)).toBe(REAL_ROOM.id);
    expect(realRoomIdFor(REAL_ROOM.id)).toBeNull(); // not a scratch id — no false recovery
    expect(SCRATCH_ROOM.startsWith(SCRATCH_ROOM_PREFIX)).toBe(true);
  });

  it("a scratch day whose real room is missing degrades to empty tape, not to an error", async () => {
    appResponder = (text) => (/FROM room WHERE id =/.test(text) ? [] : []);
    const out = await run({ room_day_id: DAY });
    expect(out.ok).toBe(true);
    expect((out.tape as Row).sessions).toEqual([]);
    expect((out.room as Row).real_room_slug).toBeNull();
  });
});

describe("2 — a LIVE room-day reports its own tape and works unchanged", () => {
  it("no scratch prefix, no inverse, and an empty visits section is empty rather than broken", async () => {
    dayRow = { id: "rd_live", room_id: REAL_ROOM.id, doctor_id: null, ist_date: IST, started_at: new Date(), ended_at: null, scratch: false };
    VISITS = []; // no arm has ever written a visit on a live day
    const out = await run({ room_day_id: "rd_live" });
    expect(out.ok).toBe(true);
    expect(out.room).toMatchObject({ scratch_room_id: null, real_room_id: REAL_ROOM.id, is_scratch: false });
    expect(out.visits).toEqual([]);
    expect((out.reconciliation as Row).visits_total).toBe(0);
    expect((out.tape as Row).sessions).toHaveLength(1); // tape still read
  });
});

describe("3 — the silence, from the cue timeline and never from a visit", () => {
  it("OPD 7's six-hour hole: 04:36:59Z → 10:39:35Z, tape running", async () => {
    const out = await run({ room_day_id: DAY });
    const silence = (out.reconciliation as Row).silence as Row[];
    expect(silence).toHaveLength(1);
    expect(silence[0]).toMatchObject({
      from: "2026-08-19T04:36:59.000Z",
      to: "2026-08-19T10:39:35.000Z",
      tape_running: true,
    });
    // ~6h 3m
    expect(Number(silence[0]!.duration_ms)).toBe(6 * 3600_000 + 2 * 60_000 + 36_000);
    expect(Number(silence[0]!.duration_ms)).toBeGreaterThan(SILENCE_THRESHOLD_MS);
    // and no visit represents it — the finding is invisible from the visit rows alone
    expect((out.visits as Row[]).some((v) => String(v.opened_by).includes("silence"))).toBe(false);
  });

  it("tape_running is false when nothing was recording across the gap", async () => {
    CHUNKS = [{ ...CHUNKS[0]!, ended_at: new Date(`${IST}T04:10:00Z`) }];
    SESSIONS = [{ ...SESSIONS[0]!, ended_at: new Date(`${IST}T04:10:00Z`) }];
    const silence = ((await run({ room_day_id: DAY })).reconciliation as Row).silence as Row[];
    expect(silence).toHaveLength(1);
    expect(silence[0]!.tape_running).toBe(false);
  });

  it("a 59-minute interior gap is still not a silence", async () => {
    // the tape is bounded to the cues so this isolates the INTERIOR gap: an unbounded tape
    // would now (correctly) produce a trailing silence and hide what is under test
    SESSIONS = [{ ...SESSIONS[0]!, started_at: new Date(`${IST}T04:00:00Z`), ended_at: new Date(`${IST}T04:59:00Z`) }];
    CHUNKS = [{ ...CHUNKS[0]!, started_at: new Date(`${IST}T04:00:00Z`), ended_at: new Date(`${IST}T04:59:00Z`) }];
    CUES = [wh("pqm_called", `${IST}T04:00:00Z`, "q1"), wh("pstart", `${IST}T04:59:00Z`, "s1")];
    const silence = ((await run({ room_day_id: DAY })).reconciliation as Row).silence as Row[];
    expect(silence).toEqual([]);
  });

  it("marks do not create or close a silence — only warehouse cues do (S6)", async () => {
    // a mark sitting in the middle of the hole must not break it into two shorter gaps
    CUES = [
      wh("pqm_called", `${IST}T04:36:59Z`, "q1"),
      mark(`${IST}T07:00:00Z`),
      wh("pstart", `${IST}T10:39:35Z`, "s1"),
    ];
    const silence = ((await run({ room_day_id: DAY })).reconciliation as Row).silence as Row[];
    expect(silence).toHaveLength(1);
    expect(silence[0]!.from).toBe("2026-08-19T04:36:59.000Z");
  });
});

describe("3b — the silence includes the EDGES", () => {
  /** tape from → to, and the warehouse cues to sit inside it */
  const setup = (tape: [string, string] | null, cues: Row[]) => {
    if (tape) {
      SESSIONS = [{ ...SESSIONS[0]!, started_at: new Date(tape[0]), ended_at: new Date(tape[1]) }];
      CHUNKS = [{ ...CHUNKS[0]!, started_at: new Date(tape[0]), ended_at: new Date(tape[1]) }];
    } else {
      SESSIONS = [];
      CHUNKS = [];
    }
    CUES = cues;
  };
  const silenceOf = async () => ((await run({ room_day_id: DAY })).reconciliation as Row).silence as Row[];

  it("1 — a leading gap longer than the threshold is reported as edge 'leading'", async () => {
    // Cardiology's real shape: 2h 14m of tape before the warehouse says anything at all
    setup([`${IST}T04:40:18.757Z`, `${IST}T11:13:47.465Z`], [
      wh("pqm_called", `${IST}T06:54:32Z`, "q1"), wh("pulse_note", `${IST}T07:53:53Z`, "p1"),
    ]);
    const sil = await silenceOf();
    const leading = sil.find((x) => x.edge === "leading")!;
    expect(leading).toMatchObject({ from: `${IST}T04:40:18.757Z`, to: `${IST}T06:54:32.000Z`, tape_running: true });
    expect(leading.duration_ms).toBe(8_053_243); // ~2h 14m
  });

  it("2 — a trailing gap likewise, and the 59m interior gap between them is not one", async () => {
    setup([`${IST}T04:40:18.757Z`, `${IST}T11:13:47.465Z`], [
      wh("pqm_called", `${IST}T06:54:32Z`, "q1"), wh("pulse_note", `${IST}T07:53:53Z`, "p1"),
    ]);
    const sil = await silenceOf();
    expect(sil.map((x) => x.edge)).toEqual(["leading", "trailing"]); // in time order, no 'between'
    const trailing = sil.find((x) => x.edge === "trailing")!;
    expect(trailing).toMatchObject({ from: `${IST}T07:53:53.000Z`, to: `${IST}T11:13:47.465Z`, tape_running: true });
    expect(trailing.duration_ms).toBe(11_994_465); // ~3h 20m
    // 06:54:32 → 07:53:53 is 59m 21s and stays below the threshold
    expect(Date.parse(`${IST}T07:53:53Z`) - Date.parse(`${IST}T06:54:32Z`)).toBeLessThan(SILENCE_THRESHOLD_MS);
  });

  it("3/4 — a first event BEFORE the tape and a last event AFTER it produce no edge silence", async () => {
    // scratch OPD 7: the warehouse starts before the tape and ends after it, so BOTH edges
    // are negative intervals and neither is a finding
    setup([`${IST}T04:01:40Z`, `${IST}T11:12:38Z`], [
      wh("pqm_called", `${IST}T03:45:49Z`, "q1"),   // before tape start
      wh("pstart", `${IST}T04:36:59Z`, "s1"),
      wh("pstart", `${IST}T10:39:35Z`, "s2"),
      // the real day carries 39 warehouse cues and its tail is DENSE. A sparse stand-in would
      // invent a second `between` silence after 10:39 that production does not have.
      ...Array.from({ length: 8 }, (_, i) => wh("pulse_note", `${IST}T${String(11 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}:00Z`, `p${i}`)),
      wh("pulse_note", `${IST}T14:12:39Z`, "pz"),   // after tape end
    ]);
    const sil = await silenceOf();
    expect(sil.some((x) => x.edge === "leading")).toBe(false);
    expect(sil.some((x) => x.edge === "trailing")).toBe(false);
    // and the one real finding is untouched
    expect(sil).toHaveLength(1);
    expect(sil[0]).toMatchObject({ edge: "between", from: `${IST}T04:36:59.000Z`, to: `${IST}T10:39:35.000Z`, duration_ms: 21_756_000, tape_running: true });
  });

  it("5 — zero warehouse events over a long tape is exactly ONE whole_day entry", async () => {
    // live OPD 7: seven hours of recording and no warehouse record whatsoever
    setup([`${IST}T04:01:40.024Z`, `${IST}T11:12:38.498Z`], []);
    const sil = await silenceOf();
    expect(sil).toHaveLength(1);
    expect(sil[0]).toMatchObject({ edge: "whole_day", from: `${IST}T04:01:40.024Z`, to: `${IST}T11:12:38.498Z`, tape_running: true });
    expect(sil[0]!.duration_ms).toBe(25_858_474); // ~7h 11m
    // never alongside the other kinds
    expect(sil.some((x) => x.edge !== "whole_day")).toBe(false);
  });

  it("6 — zero warehouse events over a SHORT tape produces none", async () => {
    setup([`${IST}T04:00:00Z`, `${IST}T04:30:00Z`], []);
    expect(await silenceOf()).toEqual([]);
  });

  it("7 — no tape at all produces none, whatever the warehouse holds", async () => {
    setup(null, [wh("pqm_called", `${IST}T04:00:00Z`, "q1"), wh("pstart", `${IST}T14:00:00Z`, "s1")]);
    expect(await silenceOf()).toEqual([]);
    setup(null, []);
    expect(await silenceOf()).toEqual([]);
  });

  it("9 — every entry carries edge and tape_running, and one threshold governs all four", async () => {
    setup([`${IST}T04:00:00Z`, `${IST}T20:00:00Z`], [
      wh("pqm_called", `${IST}T06:00:00Z`, "q1"), wh("pstart", `${IST}T12:00:00Z`, "s1"),
    ]);
    const sil = await silenceOf();
    expect(sil.map((x) => x.edge)).toEqual(["leading", "between", "trailing"]);
    for (const x of sil) {
      expect(["leading", "between", "trailing", "whole_day"]).toContain(x.edge);
      expect(typeof x.tape_running).toBe("boolean");
      expect(Number(x.duration_ms)).toBeGreaterThan(SILENCE_THRESHOLD_MS);
    }
    // and there is still exactly ONE threshold constant governing them
    const p = (await run({ room_day_id: DAY })).parameters as Row;
    expect(Object.keys(p).filter((k) => /threshold/.test(k))).toEqual(["silence_threshold_ms"]);
  });
});

describe("4/5 — marks_unaccounted", () => {
  it("Cardiology's headline: two marks whose windows hold nothing", async () => {
    CUES = [
      mark(`${IST}T04:41:30.468Z`),   // [04:41, 06:08) — empty
      mark(`${IST}T06:08:12.436Z`),   // [06:08, 09:34) — holds both clocks
      mark(`${IST}T09:34:23.931Z`),   // last: [09:34, +45m) — empty
      wh("pqm_called", `${IST}T06:54:32Z`, "qts_c1"),
      wh("pstart", `${IST}T06:54:33Z`, "svc_c1", { calendar_uid: "cal_c1" }),
    ];
    VISITS = [{ id: "vis_1", individual_uid: "ind_x", state: "ended", confidence: 0.95, end_reason: "day_rollover", ambiguity: null, arm: "rules", opened_by: "svc_c1", opened_by_kind: "pstart" }];
    const out = await run({ room_day_id: DAY });
    const rec = out.reconciliation as Row;
    expect(rec.marks_total).toBe(3);
    expect(rec.marks_unaccounted).toBe(2);
    expect(rec.marks_bound).toBe(1);

    const marks = out.marks as Row[];
    expect(marks.map((m) => m.window_holds)).toEqual([0, 2, 0]);
    // the middle mark's window ends where the next one starts; the last uses the named prior
    expect(marks[0]!.window_to).toBe(marks[1]!.at);
    expect(Date.parse(String(marks[2]!.window_to)) - Date.parse(String(marks[2]!.at))).toBe(LAST_MARK_WINDOW_MS);
    // a bound mark names the visit its clock opened
    expect(marks[1]!.bound_visit_id).toBe("vis_1");
    expect(marks[0]!.bound_visit_id).toBeNull();
  });

  it("a mark whose window holds a clock is not unaccounted", async () => {
    CUES = [mark(`${IST}T06:00:00Z`), wh("pstart", `${IST}T06:10:00Z`, "svc_1", { calendar_uid: "c" })];
    const rec = ((await run({ room_day_id: DAY })).reconciliation as Row);
    expect(rec.marks_unaccounted).toBe(0);
    expect(rec.marks_bound).toBe(1);
  });
});

describe("6/7 — ambiguity and end_reason counts", () => {
  it("ambiguity splits on the comma and counts exact closed-set tokens", async () => {
    const rec = ((await run({ room_day_id: DAY })).reconciliation as Row);
    const counts = rec.ambiguity_counts as Record<string, number>;
    expect(counts).toEqual({
      [RULES_REASONS.MARK_WITHOUT_WAREHOUSE_EVIDENCE]: 1,
      [RULES_REASONS.PQM_CALLED_WITHOUT_PSTART]: 1,
      [RULES_REASONS.INFERRED_ATTRIBUTION_ONLY]: 1,
    });
    for (const token of Object.keys(counts)) expect(ALL_RULES_REASONS).toContain(token);
    expect(rec.ambiguity_tokens_outside_closed_set).toBeUndefined();
  });

  it("a token outside the closed set is surfaced, not silently folded away", async () => {
    VISITS = [{ ...VISITS[0]!, ambiguity: "not_a_real_reason" }];
    const rec = ((await run({ room_day_id: DAY })).reconciliation as Row);
    expect(rec.ambiguity_tokens_outside_closed_set).toEqual(["not_a_real_reason"]);
  });

  it("end_reason_counts counts ONLY closed visits", async () => {
    const rec = ((await run({ room_day_id: DAY })).reconciliation as Row);
    expect(rec.end_reason_counts).toEqual({ pulse_note: 1, day_rollover: 1 });
    // the unknown visit has no end_reason and contributes nothing
    expect(rec.visits_unknown).toBe(1);
    expect(rec.visits_by_state).toEqual({ ended: 2, unknown: 1 });
    expect(rec.visits_below_confidence_0_6).toBe(2); // 0.3 and 0.45
    expect(LOW_CONFIDENCE_BELOW).toBe(0.6);
  });

  it("an end_reason on a non-ended visit is not counted and not echoed", async () => {
    VISITS = [{ ...VISITS[0]!, state: "unknown", end_reason: "pulse_note" }];
    const out = await run({ room_day_id: DAY });
    expect((out.reconciliation as Row).end_reason_counts).toEqual({});
    expect((out.visits as Row[])[0]!.end_reason).toBeNull();
  });
});

describe("6b — every warehouse event lands in exactly ONE bucket", () => {
  /** the identity that is the entire point of the split */
  const sums = (rec: Row) => {
    const four = [rec.warehouse_opened_a_visit, rec.warehouse_closed_a_visit, rec.warehouse_moved_a_visit, rec.warehouse_unbound].map(Number);
    expect(four.every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
    expect(four.reduce((a, b) => a + b, 0)).toBe(Number(rec.warehouse_total));
    return { opened: four[0]!, closed: four[1]!, moved: four[2]!, unbound: four[3]! };
  };
  const recOf = async (args: Row = {}) => ((await run({ room_day_id: DAY, ...args })).reconciliation as Row);

  it("1 — the four sum to warehouse_total on the seed fixture, in both identity modes", async () => {
    expect(sums(await recOf())).toEqual({ opened: 2, closed: 1, moved: 0, unbound: 0 });
    // the attribution matches on individual_uid INTERNALLY, so it cannot move with include_identity
    expect(sums(await recOf({ include_identity: true }))).toEqual({ opened: 2, closed: 1, moved: 0, unbound: 0 });
    // and on the other arm's visits too
    sums(await recOf({ arm: "hybrid" }));
  });

  it("2 — a pulse_note that closed a visit counts as CLOSED, not unbound", async () => {
    const rec = await recOf();
    expect(rec.warehouse_closed_a_visit).toBe(1);
    // the note is the only closer here, and it is not sitting in unbound
    expect(rec.warehouse_unbound).toBe(0);
    // remove the close from the visit and the same note becomes unbound
    VISITS = VISITS.map((v) => (v.id === "vis_a" ? { ...v, end_reason: "day_rollover" } : v));
    const after = await recOf();
    expect(after.warehouse_closed_a_visit).toBe(0);
    expect(after.warehouse_unbound).toBe(1);
    sums(after);
  });

  it("3 — a dx_event that moved a visit counts as MOVED, not unbound", async () => {
    CUES = [
      wh("pstart", `${IST}T05:00:00Z`, "svc_1", { calendar_uid: "c" }),
      wh("dx_event", `${IST}T06:00:00Z`, "dx_1"),
    ];
    VISITS = [{ id: "vis_a", individual_uid: "ind_secret_0001", state: "ended", confidence: 0.9, end_reason: "day_rollover_at_diagnostics", ambiguity: null, arm: "rules", opened_by: "svc_1", opened_by_kind: "pstart" }];
    const rec = await recOf();
    expect(sums(rec)).toEqual({ opened: 1, closed: 0, moved: 1, unbound: 0 });
  });

  it("4 — an event that both opened and later moved is counted ONCE, as opened", async () => {
    // precedence is opened → closed → moved
    CUES = [wh("dx_event", `${IST}T06:00:00Z`, "dx_1")];
    VISITS = [{ id: "vis_a", individual_uid: "ind_secret_0001", state: "ended", confidence: 0.5, end_reason: "day_rollover_at_diagnostics", ambiguity: null, arm: "rules", opened_by: "dx_1", opened_by_kind: "pstart" }];
    const rec = await recOf();
    expect(sums(rec)).toEqual({ opened: 1, closed: 0, moved: 0, unbound: 0 });
  });

  it("5 — a pulse_note that found no target counts as unbound", async () => {
    // two notes for one person, and only one visit was closed by a note: the second is unbound
    CUES = [
      wh("pstart", `${IST}T05:00:00Z`, "svc_1", { calendar_uid: "c" }),
      wh("pulse_note", `${IST}T06:00:00Z`, "pn_1"),
      wh("pulse_note", `${IST}T07:00:00Z`, "pn_2"),
    ];
    VISITS = [{ id: "vis_a", individual_uid: "ind_secret_0001", state: "ended", confidence: 0.9, end_reason: "pulse_note", ambiguity: null, arm: "rules", opened_by: "svc_1", opened_by_kind: "pstart" }];
    expect(sums(await recOf())).toEqual({ opened: 1, closed: 1, moved: 0, unbound: 1 });
  });

  it("6 — a day with no visits puts EVERY warehouse event in unbound", async () => {
    VISITS = [];
    const rec = await recOf();
    expect(sums(rec)).toEqual({ opened: 0, closed: 0, moved: 0, unbound: Number(rec.warehouse_total) });
    expect(rec.warehouse_total).toBe(3);
  });

  it("7 — a day with no warehouse events reports four zeros", async () => {
    CUES = [mark(`${IST}T04:02:29.995Z`)];
    const rec = await recOf();
    expect(sums(rec)).toEqual({ opened: 0, closed: 0, moved: 0, unbound: 0 });
    expect(rec.warehouse_total).toBe(0);
    expect(rec.marks_total).toBe(1); // marks are unaffected by the split
  });

  it("the old single count is gone", async () => {
    const rec = await recOf();
    expect(rec).not.toHaveProperty("warehouse_bound_to_visit");
    expect(rec).toHaveProperty("warehouse_opened_a_visit");
  });

  it("the OPD 7 and Cardiology shapes reproduce the worked expectations", async () => {
    // Cardiology: one call that corroborated (not an opener), one start, one dx, one note
    CUES = [
      wh("pqm_called", `${IST}T06:54:32Z`, "qts_C"),
      wh("pstart", `${IST}T06:54:33Z`, "svc_C", { calendar_uid: "cal_C" }),
      wh("dx_event", `${IST}T07:30:00Z`, "dx_C"),
      wh("pulse_note", `${IST}T07:53:00Z`, "pn_C"),
    ];
    VISITS = [{ id: "vis_c1", individual_uid: "ind_secret_0001", state: "ended", confidence: 0.95, end_reason: "pulse_note", ambiguity: null, arm: "rules", opened_by: "svc_C", opened_by_kind: "pstart" }];
    expect(sums(await recOf())).toEqual({ opened: 1, closed: 1, moved: 1, unbound: 1 });
  });
});

describe("8 — identity is off by default", () => {
  it("no individual_uid anywhere in the serialised output", async () => {
    const s = JSON.stringify(await run({ room_day_id: DAY }));
    expect(s).not.toContain("ind_secret_0001");
    expect(s).not.toContain("ind_secret_0002");
    expect(s).not.toContain("individual_uid");
  });

  it("include_identity:true returns it, and nothing else changes", async () => {
    const off = await run({ room_day_id: DAY });
    const on = await run({ room_day_id: DAY, include_identity: true });
    expect(JSON.stringify(on)).toContain("ind_secret_0001");
    expect((on.visits as Row[])[0]!.individual_uid).toBe("ind_secret_0001");
    expect(on.reconciliation).toEqual(off.reconciliation);
  });

  it("no token, prompt or GCP value is ever returned", async () => {
    process.env.GCP_SA_KEY = "SA-KEY-SECRET";
    process.env.SCRIBE_MCP_TOKEN = "mcp-secret";
    const s = JSON.stringify(await run({ room_day_id: DAY, include_identity: true }));
    expect(s).not.toContain("SA-KEY-SECRET");
    expect(s).not.toContain("mcp-secret");
    expect(s).not.toContain("GCP_");
  });
});

describe("9 — the report names the arm", () => {
  it("defaults to rules, and a different arm returns that arm's visits only", async () => {
    const dflt = await run({ room_day_id: DAY });
    expect(dflt.arm).toBe("rules");
    expect((dflt.visits as Row[]).map((v) => v.id)).toEqual(["vis_a", "vis_b", "vis_c"]);

    const hy = await run({ room_day_id: DAY, arm: "hybrid" });
    expect(hy.arm).toBe("hybrid");
    expect((hy.visits as Row[]).map((v) => v.id)).toEqual(["vis_h"]);
    // The tape, the mark windows and the silence are properties of the DAY and do not move
    // with the arm. bound_visit_id DOES move, and should: it names the visit THIS arm opened
    // from the clock inside that mark's window, which is exactly the comparison the designer
    // is here to make.
    const dayShape = (m: Row) => ({ cue_id: m.cue_id, at: m.at, in_tape: m.in_tape, window_from: m.window_from, window_to: m.window_to, window_holds: m.window_holds });
    expect((hy.marks as Row[]).map(dayShape)).toEqual((dflt.marks as Row[]).map(dayShape));
    expect((hy.reconciliation as Row).silence).toEqual((dflt.reconciliation as Row).silence);
    expect((hy.reconciliation as Row).marks_unaccounted).toBe((dflt.reconciliation as Row).marks_unaccounted);
    // the arm-dependent half: rules opened a visit from that clock, hybrid did not
    expect((dflt.marks as Row[])[0]!.bound_visit_id).toBe("vis_c");
    expect((hy.marks as Row[])[0]!.bound_visit_id).toBeNull();
  });
});

describe("10 — stored in_tape_window is reported, never recomputed in place", () => {
  it("a disagreement with the tape actually read is named", async () => {
    // the cue claims it was inside the tape; the tape says the clock is hours past the last piece
    CUES = [wh("pstart", `${IST}T23:00:00Z`, "svc_late", { in_tape_window: true, calendar_uid: "c" })];
    const out = await run({ room_day_id: DAY });
    const w = out.warehouse as Row;
    expect(w.in_tape).toBe(1);        // the STORED value still drives the count
    expect(w.outside_tape).toBe(0);
    const dis = w.in_tape_window_disagreements as Row[];
    expect(dis).toHaveLength(1);
    expect(dis[0]).toMatchObject({ stored_in_tape_window: true, observed_in_tape: false, type: "pstart" });
  });

  it("no disagreement key at all when the stored value matches the tape", async () => {
    CUES = [wh("pstart", `${IST}T05:00:00Z`, "svc_1", { in_tape_window: true, calendar_uid: "c" })];
    const w = (await run({ room_day_id: DAY })).warehouse as Row;
    expect(w.in_tape_window_disagreements).toBeUndefined();
  });

  it("by_type counts every warehouse type and never counts the mark", async () => {
    const w = (await run({ room_day_id: DAY })).warehouse as Row;
    expect(w.by_type).toEqual({ pqm_called: 1, pstart: 1, dx_event: 0, pulse_note: 1 });
    expect((await run({ room_day_id: DAY })).reconciliation).toMatchObject({ warehouse_total: 3, marks_total: 1 });
  });
});

describe("11/12 — parameters, and writing nothing at all", () => {
  it("every constant that shaped the result is present and non-null", async () => {
    const p = (await run({ room_day_id: DAY })).parameters as Row;
    for (const [k, v] of Object.entries(p)) expect(v, `parameters.${k} is null`).not.toBeNull();
    expect(p.last_mark_window_ms).toBe(2_700_000);
    expect(p.silence_threshold_ms).toBe(SILENCE_THRESHOLD_MS);
    expect(p.low_confidence_below).toBe(0.6);
    expect(p.default_arm).toBe("rules");
    expect(p.warehouse_cue_types).toEqual(["pqm_called", "pstart", "dx_event", "pulse_note"]);
    // nothing is hardcoded at a call site — the report's window matches the arm's
    expect(p.last_mark_window_ms).toBe(LAST_MARK_WINDOW_MS);
  });

  it("the tool writes NOTHING — no INSERT, UPDATE or DELETE on either handle", async () => {
    await run({ room_day_id: DAY, include_identity: true });
    const all = [...appCalls, ...brainCalls].map((c) => c.text);
    expect(all.length).toBeGreaterThan(0);
    for (const t of all) expect(t, `write issued: ${t}`).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
    expect(tool.scope).toBe("read");
  });

  it("an unknown room-day is refused by name; a read failure degrades rather than throwing", async () => {
    dayRow = null;
    expect(await run({ room_day_id: "rd_nope" })).toMatchObject({ ok: false, error: "room_day_not_found" });
    seed();
    brainResponder = (text, values) => {
      if (/FROM room_day WHERE id = \$1/.test(text)) return [dayRow!];
      if (/FROM visit/.test(text)) throw new Error("relation \"visit\" does not exist");
      if (/FROM cue/.test(text.replace(/\s+/g, " "))) return CUES;
      return [];
    };
    const out = await run({ room_day_id: DAY });
    expect(out.ok).toBe(true);            // degraded, not a 500
    expect(out.visits).toEqual([]);
    expect(out.degraded).toBe(true);
    expect(String((out.degraded_reads as string[]).join())).toContain("visits_read_failed");
    // and the finding survives the visit table being gone entirely
    expect(((out.reconciliation as Row).silence as Row[])).toHaveLength(1);
  });
});


// ===========================================================================
// Speech turns, slice A — the four counters
// ===========================================================================

describe("the four turn counters", () => {
  it("reports the three types and their total, and the three sum to it", async () => {
    TURN_COUNTS = [{ type: "stt_turn", n: 412 }, { type: "stt_silence", n: 7 }];
    const out = await run({ room_day_id: DAY });
    const rec = out.reconciliation as Row;
    expect(rec.turns_total).toBe(412);
    expect(rec.turn_silences).toBe(7);
    expect(rec.speaker_matches).toBe(0); // slice B writes these; a reported zero is not a missing count
    expect(rec.turn_cues_total).toBe(419);
    expect(Number(rec.turns_total) + Number(rec.turn_silences) + Number(rec.speaker_matches)).toBe(rec.turn_cues_total);
  });

  it("a day with no turns reports four zeros, not four absences", async () => {
    TURN_COUNTS = [];
    const rec = (await run({ room_day_id: DAY })).reconciliation as Row;
    expect(rec).toMatchObject({ turns_total: 0, turn_silences: 0, speaker_matches: 0, turn_cues_total: 0 });
  });

  it("slice B's type is already counted — the report does not need changing to see it", async () => {
    TURN_COUNTS = [{ type: "stt_turn", n: 2 }, { type: "speaker_match", n: 5 }];
    const rec = (await run({ room_day_id: DAY })).reconciliation as Row;
    expect(rec).toMatchObject({ turns_total: 2, speaker_matches: 5, turn_cues_total: 7 });
  });

  it("counts arrive as strings from a driver that does not narrow bigint — still numbers here", async () => {
    TURN_COUNTS = [{ type: "stt_turn", n: "412" }];
    const rec = (await run({ room_day_id: DAY })).reconciliation as Row;
    expect(rec.turns_total).toBe(412);
    expect(rec.turn_cues_total).toBe(412);
  });

  it("a failed count degrades to zeros and a NAMED degraded read — never a throw, never a wrong number", async () => {
    brainResponder = (text, values) => {
      if (/COUNT\(\*\)::int AS n FROM cue/.test(text.replace(/\s+/g, " "))) throw new Error("relation cue does not exist");
      if (/FROM room_day WHERE id = \$1/.test(text)) return dayRow ? [dayRow] : [];
      if (/FROM cue\s+WHERE room_day_id/.test(text.replace(/\s+/g, " "))) return CUES;
      if (/FROM visit WHERE room_day_id = \$1 AND COALESCE\(arm, 'rules'\)/.test(text)) return VISITS.filter((v) => (v.arm ?? "rules") === values[1]);
      return [];
    };
    const out = await run({ room_day_id: DAY });
    expect(out.ok).toBe(true);
    expect((out.reconciliation as Row).turn_cues_total).toBe(0);
    expect((out.degraded_reads as string[]).some((d) => d.startsWith("turn_cue_counts_failed"))).toBe(true);
    // and the rest of the report is unharmed
    expect((out.reconciliation as Row).marks_total).toBe(1);
  });

  it("the turn cue types are reported in parameters, from the one place they are named", async () => {
    const out = await run({ room_day_id: DAY });
    expect((out.parameters as Row).turn_cue_types).toEqual(["stt_turn", "stt_silence", "speaker_match"]);
  });
});

// ===========================================================================
// Speech turns, K2 correction 4 — the tape that was LISTENED TO
// ===========================================================================

describe("turn_tape — PRD §10's counters, rolled up from payload.window", () => {
  const MIN = 60_000;
  const W = (fromMin: number, toMin: number) => ({ start_ms: Date.parse(`${IST}T05:00:00Z`) + fromMin * MIN, end_ms: Date.parse(`${IST}T05:00:00Z`) + toMin * MIN });
  /** One turn cue in a given window. `window` and `source_used` are what the rollup reads. */
  const turn = (type: string, w: Row, source_used: string | null, language: string | null = "en") =>
    cue(type, new Date(w.start_ms as number).toISOString(), { text: "x", start_ms: w.start_ms, end_ms: w.end_ms, window: w, source_used, language, session_id: "bs_1" });

  it("minutes asked, with words and silent — a partition, exact in ms", async () => {
    const spoken = W(0, 2);   // 2 minutes, words
    const quiet = W(10, 13);  // 3 minutes, silent
    CUES = [...CUES, turn("stt_turn", spoken, "primary"), turn("stt_turn", spoken, "primary"), turn("stt_silence", quiet, "primary")];
    const t = (await run({ room_day_id: DAY })).turn_tape as Row;
    expect(t).toMatchObject({ windows_total: 2, windows_with_words: 1, windows_silent: 1 });
    expect(t.ms_asked).toBe(5 * MIN);
    expect(t.ms_with_words).toBe(2 * MIN);
    expect(t.ms_silent).toBe(3 * MIN);
    // the identity holds on the MS, which is why the ms are reported at all
    expect(Number(t.ms_with_words) + Number(t.ms_silent)).toBe(t.ms_asked);
    expect(t).toMatchObject({ minutes_asked: 5, minutes_with_words: 2, minutes_silent: 3 });
  });

  it("a window is counted ONCE however many cues it produced", async () => {
    const w = W(0, 4);
    CUES = [...CUES, ...Array.from({ length: 40 }, () => turn("stt_turn", w, "primary"))];
    const t = (await run({ room_day_id: DAY })).turn_tape as Row;
    expect(t.windows_total).toBe(1);
    expect(t.ms_asked).toBe(4 * MIN);
  });

  it("counts the windows the BACKUP microphone answered", async () => {
    CUES = [...CUES, turn("stt_turn", W(0, 1), "backup"), turn("stt_turn", W(5, 6), "primary"), turn("stt_silence", W(9, 10), "backup")];
    const t = (await run({ room_day_id: DAY })).turn_tape as Row;
    expect(t.windows_backup_mic).toBe(2);
    expect(t.windows_total).toBe(3);
  });

  it("a window read from BOTH microphones is one window, and it counts as backup", async () => {
    const w = W(0, 2);
    CUES = [...CUES, turn("stt_silence", w, "primary"), turn("stt_turn", w, "backup")];
    const t = (await run({ room_day_id: DAY })).turn_tape as Row;
    expect(t.windows_total).toBe(1);
    expect(t.windows_backup_mic).toBe(1);
    // and somebody DID speak in it — a second read that heard nothing does not undo that
    expect(t.windows_with_words).toBe(1);
    expect(t.ms_silent).toBe(0);
  });

  it("reports the language whisper.cpp gave, by window, with `unreported` its own bucket", async () => {
    CUES = [...CUES, turn("stt_turn", W(0, 1), "primary", "en"), turn("stt_turn", W(2, 3), "primary", "hi"), turn("stt_turn", W(4, 5), "primary", "en"), turn("stt_turn", W(6, 7), "primary", null)];
    const t = (await run({ room_day_id: DAY })).turn_tape as Row;
    expect(t.languages).toEqual([
      { language: "en", windows: 2 },
      { language: "hi", windows: 1 },
      { language: "unreported", windows: 1 },
    ]);
  });

  it("overlapping asks are two windows and SAY SO rather than being silently merged", async () => {
    CUES = [...CUES, turn("stt_turn", W(0, 3), "primary"), turn("stt_turn", W(2, 5), "primary")];
    const t = (await run({ room_day_id: DAY })).turn_tape as Row;
    expect(t.windows_total).toBe(2);
    expect(t.ms_asked).toBe(6 * MIN); // 3 + 3, not the 5 minutes of wall clock they cover
    expect(t.windows_overlap).toBe(true);
  });

  it("windows that do NOT overlap raise no flag", async () => {
    CUES = [...CUES, turn("stt_turn", W(0, 2), "primary"), turn("stt_turn", W(2, 4), "primary")];
    const t = (await run({ room_day_id: DAY })).turn_tape as Row;
    expect(t.windows_overlap).toBeUndefined();
  });

  it("a turn cue with no window is COUNTED AND NAMED, not assumed to be zero minutes", async () => {
    CUES = [...CUES, cue("stt_turn", `${IST}T05:00:00Z`, { text: "written before K2" }), turn("stt_turn", W(0, 1), "primary")];
    const t = (await run({ room_day_id: DAY })).turn_tape as Row;
    expect(t.turn_cues_without_window).toBe(1);
    expect(t.windows_total).toBe(1);
    expect(t.ms_asked).toBe(1 * MIN);
  });

  it("a day with no turn cues reports zeros over zero windows, not absences", async () => {
    const t = (await run({ room_day_id: DAY })).turn_tape as Row;
    expect(t).toMatchObject({ windows_total: 0, ms_asked: 0, ms_with_words: 0, ms_silent: 0, minutes_asked: 0, windows_backup_mic: 0 });
    expect(t.languages).toEqual([]);
    expect(t.turn_cues_without_window).toBeUndefined();
  });

  it("the four counters keep their OWN aggregate — turn_tape is derived from the cue list", async () => {
    TURN_COUNTS = [{ type: "stt_turn", n: 412 }];
    CUES = [...CUES, turn("stt_turn", W(0, 2), "primary")];
    const out = await run({ room_day_id: DAY });
    expect((out.reconciliation as Row).turns_total).toBe(412); // the aggregate, not the list
    expect((out.turn_tape as Row).windows_total).toBe(1);      // the list, not the aggregate
  });

  // --- K3 §3: completeness is a different question from "was anything said" -------------
  it("a complete window is reported complete, and its marker is NOT counted as evidence", async () => {
    const w = W(0, 2);
    CUES = [...CUES, turn("stt_turn", w, "primary"), cue("stt_window", new Date(w.start_ms as number).toISOString(), { window: w, complete: true, segment_count: 1, session_id: "bs_1" })];
    const out = await run({ room_day_id: DAY });
    const t = out.turn_tape as Row;
    expect(t).toMatchObject({ windows_total: 1, windows_complete: 1, windows_incomplete: 0, windows_without_marker: 0 });
    expect(t.incomplete).toBeUndefined();
    // the marker is not a turn and not a silence — the evidence partition is untouched by it
    expect(t.windows_with_words).toBe(1);
  });

  it("an INCOMPLETE window is named, with why it stopped and what Whisper had returned", async () => {
    const w = W(10, 16);
    CUES = [...CUES, cue("stt_window", new Date(w.start_ms as number).toISOString(), {
      window: w, complete: false, stopped_early: "brain_timeout", segment_count: 162, session_id: "bs_1", language: "en", source_used: "primary",
    })];
    const t = (await run({ room_day_id: DAY })).turn_tape as Row;
    expect(t).toMatchObject({ windows_total: 1, windows_complete: 0, windows_incomplete: 1 });
    expect((t.incomplete as Row[])[0]).toMatchObject({
      start_ms: w.start_ms, end_ms: w.end_ms, stopped_early: "brain_timeout", segment_count: 162,
    });
    // an unfinished window has NO turns by construction, so its emptiness is not silence —
    // it is counted as silent minutes only because nothing was heard, and the marker is what
    // stops a reader believing the tape was quiet
    expect(t.windows_with_words).toBe(0);
  });

  it("a window with NO marker is not reported as complete — saying nothing is the honest answer", async () => {
    CUES = [...CUES, turn("stt_turn", W(0, 1), "primary")];
    const t = (await run({ room_day_id: DAY })).turn_tape as Row;
    expect(t).toMatchObject({ windows_complete: 0, windows_incomplete: 0, windows_without_marker: 1 });
  });

  it("a marker that never SAYS complete is unknown, not failed — silence is not a reported failure", async () => {
    const w = W(0, 2);
    CUES = [...CUES, cue("stt_window", new Date(w.start_ms as number).toISOString(), { window: w, segment_count: 3 })];
    const t = (await run({ room_day_id: DAY })).turn_tape as Row;
    expect(t).toMatchObject({ windows_complete: 0, windows_incomplete: 0, windows_without_marker: 1 });
    expect(t.incomplete).toBeUndefined();
  });

  it("if a window somehow holds two markers, the PESSIMISTIC one wins", async () => {
    const w = W(0, 2);
    CUES = [
      ...CUES,
      cue("stt_window", new Date(w.start_ms as number).toISOString(), { window: w, complete: false, stopped_early: "boom", segment_count: 5 }),
      cue("stt_window", new Date(w.start_ms as number).toISOString(), { window: w, complete: true, segment_count: 5 }),
    ];
    const t = (await run({ room_day_id: DAY })).turn_tape as Row;
    expect(t).toMatchObject({ windows_complete: 0, windows_incomplete: 1 });
  });

  it("the window cue type is reported in parameters, from the one place it is named", async () => {
    expect((await run({ room_day_id: DAY })).parameters).toMatchObject({ window_cue_type: "stt_window" });
  });

  it("a failed cue read degrades to an empty rollup and the read is already named", async () => {
    brainResponder = (text, values) => {
      if (/FROM room_day WHERE id = \$1/.test(text)) return dayRow ? [dayRow] : [];
      if (/COUNT\(\*\)::int AS n FROM cue/.test(text.replace(/\s+/g, " "))) return TURN_COUNTS;
      if (/FROM cue\s+WHERE room_day_id/.test(text.replace(/\s+/g, " "))) throw new Error("relation cue does not exist");
      if (/FROM visit WHERE room_day_id = \$1 AND COALESCE\(arm, 'rules'\)/.test(text)) return VISITS.filter((v) => (v.arm ?? "rules") === values[1]);
      return [];
    };
    const out = await run({ room_day_id: DAY });
    expect(out.ok).toBe(true);
    expect((out.turn_tape as Row).windows_total).toBe(0);
    expect((out.degraded_reads as string[]).some((d) => d.startsWith("cues_read_failed"))).toBe(true);
  });
});
