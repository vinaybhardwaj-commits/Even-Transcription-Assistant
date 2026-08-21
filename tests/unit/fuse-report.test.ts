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

  it("a gap shorter than the threshold is not a silence", async () => {
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
