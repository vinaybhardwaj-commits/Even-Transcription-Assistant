/**
 * Fuse slice 4 — three arms on scratch.
 *
 * Same harness shape as fuse-scratch-write and warehouse-join: the arms and the runner run
 * against a fake Postgres that models the one thing 0048 actually enforces — the PARTIAL
 * unique index on (arm, opened_by) WHERE both are NOT NULL.
 *
 * The two tests that matter most are 9 and 4. Nine is X4: an arm secretly served by a local
 * model must write NOTHING, because a fuse served by qwen2.5:14b cannot be scored as Flash and
 * nothing else in the system would ever say so. Four is §10.3: a second pstart with a different
 * calendar_uid is a second visit for the same person on the same day — the row that the
 * rejected per-person unique key would have made impossible.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

type Row = Record<string, unknown>;

const brainCalls: Array<{ text: string; values: unknown[] }> = [];
let brainResponder: (text: string, values: unknown[]) => Row[] = () => [];

const runSql = (text: string, values: unknown[] = []) => {
  brainCalls.push({ text, values });
  const rows = brainResponder(text, values);
  return { rows, rowCount: rows.length };
};

vi.mock("@/lib/db", () => ({ sql: () => Promise.resolve([]) }));
vi.mock("@/lib/brain/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    brainLog: () => {},
    // the real pool is BOTH a Queryable (readGraph takes one) and a connection factory
    // (writeVisits takes a client). The fake has to be both or readGraph blows up on q.query.
    getPool: () => ({
      query: async (t: string, v?: unknown[]) => runSql(t, v ?? []),
      connect: async () => ({ query: async (t: string, v?: unknown[]) => runSql(t, v ?? []), release: () => {} }),
    }),
    query: async (t: string, v?: unknown[]) => runSql(t, v ?? []),
  };
});

let rcImpl: () => { ok: boolean; content: string; error?: string; latency_ms: number; provider: string };
const rcCalls: Array<Record<string, unknown>> = [];
vi.mock("@/lib/llm/gemini", () => ({
  routedChat: (p: Record<string, unknown>) => { rcCalls.push(p); return Promise.resolve(rcImpl()); },
  geminiChatIfOn: async () => null,
  geminiConfigured: () => true,
  pickGemini: () => "gemini-3.7-flash",
  GEMINI_MODEL: "gemini-3.1-pro-preview",
  GEMINI_FLASH_MODEL: "gemini-3.7-flash",
}));

import { runRulesArm, RULES_REASONS, ALL_RULES_REASONS, LAST_MARK_WINDOW_MS, END_REASONS, ambiguityOf } from "@/lib/brain/fuse/rules";
import { runFlashArm, runHybridArm } from "@/lib/brain/fuse/gemini-arms";
import { FUSE_TOOLS } from "@/lib/mcp/tools/fuse";
import { DEFAULT_ARM, SQL_VISIT_INSERT, SQL_VISITS_FOR_DAY, readGraph } from "@/lib/brain/state";
import type { FuseCue } from "@/lib/brain/fuse/types";

// ---------------------------------------------------------------------------
// A small corpus, shaped exactly like the loaded one (§4)
// ---------------------------------------------------------------------------

const DAY = "rd_scratch_qyzghzaf_20260819";
const LIVE_DAY = "rd_live_opd7";
const T = (hhmm: string) => `2026-08-19T${hhmm}:00.000Z`;

let n = 0;
const cue = (type: string, at: string, payload: Record<string, unknown> | null, source = "warehouse", source_ref: string | null = null): FuseCue => ({
  id: `cue_t${String(++n).padStart(3, "0")}`,
  type, at, payload, source, source_ref,
});
const wh = (type: string, at: string, ref: string, p: Record<string, unknown>) =>
  cue(type, at, { source: "warehouse", source_ref: ref, ...p }, "warehouse", ref);
const mark = (at: string) => cue("consult_mark", at, { source: "kiosk" }, "replay", null);

beforeEach(() => {
  n = 0;
  brainCalls.length = 0;
  rcCalls.length = 0;
  rcImpl = () => ({ ok: true, content: JSON.stringify({ visits: [], decisions: [] }), latency_ms: 5, provider: "gemini:gemini-3.7-flash" });
});

// ===========================================================================

describe("1 — arm A is deterministic", () => {
  it("the same cue list twice gives deeply equal visits, confidences and reasons included", () => {
    const cues = [
      wh("pqm_called", T("03:30"), "qts_1", { individual_uid: "ind_1", attribution: "direct" }),
      wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" }),
      wh("dx_event", T("05:10"), "svc_dx_1", { individual_uid: "ind_1", attribution: "direct", category: "LAB" }),
      wh("pulse_note", T("06:00"), "pn_1", { individual_uid: "ind_1", attribution: "direct" }),
      mark(T("03:36")),
    ];
    const a = runRulesArm(cues);
    const b = runRulesArm(cues);
    expect(a).toEqual(b);
    // and shuffling the input does not change the output: the arm sorts by clock, then id
    const c = runRulesArm([...cues].reverse());
    expect(c).toEqual(a);
  });

  it("emits no confidence equal to the banned 0.78, and every reason is from the closed set", () => {
    const cues = [
      wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", attribution: "inferred" }),
      wh("pqm_called", T("07:00"), "qts_9", { individual_uid: "ind_9", attribution: "direct" }),
      mark(T("12:00")),
    ];
    const { visits } = runRulesArm(cues);
    for (const v of visits) {
      expect(v.confidence).not.toBe(0.78);
      for (const r of v.reasons) expect(ALL_RULES_REASONS).toContain(r);
    }
    expect(ALL_RULES_REASONS).toHaveLength(8);
  });
});

describe("2 — a pstart with no mark still mints a visit", () => {
  it("official start, strong identity, opened by the pstart — and a fused day has closed it", () => {
    const { visits } = runRulesArm([wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" })]);
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({
      individual_uid: "ind_1", opened_by: "svc_1", opened_by_kind: "pstart", pstart_at: T("03:35"), reasons: [],
    });
    expect(visits[0]!.confidence).toBeGreaterThan(0.8);
    // it opened in_chair and the day-rollover pass closed it: nothing stays open in a fused day
    expect(visits[0]!.state).toBe("ended");
    expect(visits[0]!.end_reason).toBe(END_REASONS.DAY_ROLLOVER);
  });
});

describe("3 — a dx_event opens a hole, never a visit", () => {
  it("sets at_diagnostics on the existing visit and mints nothing new", () => {
    const { visits } = runRulesArm([
      wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" }),
      wh("dx_event", T("05:10"), "svc_dx_1", { individual_uid: "ind_1", attribution: "direct", category: "LAB" }),
    ]);
    expect(visits).toHaveLength(1);
    expect(visits[0]!.opened_by).toBe("svc_1"); // still opened by the pstart, not the dx
    // the hole opened at_diagnostics and, with nothing closing it, day_rollover did
    expect(visits[0]!.state).toBe("ended");
    expect(visits[0]!.end_reason).toBe(END_REASONS.DAY_ROLLOVER);
  });

  it("a dx_event for a person with no visit mints nothing and is reported as unbound", () => {
    const { visits, unbound } = runRulesArm([wh("dx_event", T("05:10"), "svc_dx_9", { individual_uid: "ind_9", attribution: "direct" })]);
    expect(visits).toHaveLength(0);
    expect(unbound).toEqual([{ cue_id: expect.any(String), type: "dx_event", reason: RULES_REASONS.DX_EVENT_WITHOUT_VISIT }]);
  });
});

describe("4 — §10.3: a second pstart with a different calendar_uid is a SECOND visit", () => {
  it("one person, one day, two visits — the row the rejected per-person key would have broken", () => {
    const { visits } = runRulesArm([
      wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" }),
      wh("pstart", T("09:20"), "svc_2", { individual_uid: "ind_1", calendar_uid: "cal_2", attribution: "direct" }),
    ]);
    expect(visits).toHaveLength(2);
    expect(visits.map((v) => v.individual_uid)).toEqual(["ind_1", "ind_1"]);
    expect(visits.map((v) => v.opened_by)).toEqual(["svc_1", "svc_2"]);
    // and the two rows differ in the half of the key that is NOT the person
    expect(new Set(visits.map((v) => v.opened_by)).size).toBe(2);
  });

  it("the SAME calendar_uid twice is one booking reported twice, not two visits", () => {
    const { visits } = runRulesArm([
      wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" }),
      wh("pstart", T("03:36"), "svc_1b", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" }),
    ]);
    expect(visits).toHaveLength(1);
  });
});

describe("5 — an inferred dx_event alone never mints identity", () => {
  it("no visit, and the reason names the inference", () => {
    const { visits, unbound } = runRulesArm([wh("dx_event", T("05:10"), "svc_dx_1", { individual_uid: "ind_1", attribution: "inferred" })]);
    expect(visits).toHaveLength(0);
    expect(unbound[0]!.reason).toBe(RULES_REASONS.INFERRED_ATTRIBUTION_ONLY);
  });
});

describe("6 — in_tape_window is not read at all", () => {
  it("false neither drops the visit nor attaches tape", () => {
    const on = runRulesArm([wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct", in_tape_window: true })]);
    const off = runRulesArm([wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct", in_tape_window: false })]);
    expect(off.visits).toHaveLength(1);
    expect(off).toEqual(on); // byte-for-byte the same answer
    // nothing tape-shaped is on the visit at all
    expect(Object.keys(off.visits[0]!)).not.toContain("session_id");
    expect(readFileSync("lib/brain/fuse/rules.ts", "utf8")).not.toMatch(/payload.*in_tape_window|"in_tape_window"/);
  });
});

describe("7/8 — a pulse_note never OPENS a visit, and closes only its own", () => {
  it("a note with no visit mints nothing", () => {
    const alone = runRulesArm([wh("pulse_note", T("06:00"), "pn_1", { individual_uid: "ind_1", attribution: "direct" })]);
    expect(alone.visits).toHaveLength(0);
    expect(alone.unbound[0]!.reason).toBe(RULES_REASONS.PULSE_NOTE_WITHOUT_VISIT);
  });

  it("A5 — it closes THAT individual's visit with end_reason pulse_note, and nobody else's", () => {
    const { visits } = runRulesArm([
      wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" }),
      wh("pstart", T("04:00"), "svc_2", { individual_uid: "ind_2", calendar_uid: "cal_2", attribution: "direct" }),
      wh("pulse_note", T("06:00"), "pn_1", { individual_uid: "ind_1", attribution: "direct" }),
    ]);
    const one = visits.find((v) => v.individual_uid === "ind_1")!;
    const two = visits.find((v) => v.individual_uid === "ind_2")!;
    expect(one.state).toBe("ended");
    expect(one.end_reason).toBe(END_REASONS.PULSE_NOTE);
    // the other person's visit is closed too — but by the day boundary, not by this note
    expect(two.state).toBe("ended");
    expect(two.end_reason).toBe(END_REASONS.DAY_ROLLOVER);
  });

  it("a note cannot close a mark-only visit — it has no individual_uid to match", () => {
    const { visits } = runRulesArm([
      mark(T("11:00")),
      wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" }),
      wh("pulse_note", T("12:00"), "pn_1", { individual_uid: "ind_1", attribution: "direct" }),
    ]);
    const orphan = visits.find((v) => v.opened_by_kind === "mark")!;
    expect(orphan.state).toBe("unknown");
    expect(orphan.end_reason).toBeNull();
  });
});

describe("8 — arm A says it cannot tell, and the mark windows say when", () => {
  it("A4 — a mark with a later mark uses [this, next); the LAST mark uses [this, this + 45 min)", () => {
    const m1 = T("04:00");
    const m2 = T("06:00");
    // inside window 1 ([04:00, 06:00)), inside window 2 ([06:00, 06:45)), and past both
    const insideW1 = wh("pstart", T("05:59"), "svc_a", { individual_uid: "ind_a", calendar_uid: "cal_a", attribution: "direct" });
    const insideW2 = wh("pstart", T("06:44"), "svc_b", { individual_uid: "ind_b", calendar_uid: "cal_b", attribution: "direct" });
    const outside = wh("pstart", T("06:46"), "svc_c", { individual_uid: "ind_c", calendar_uid: "cal_c", attribution: "direct" });

    const { visits } = runRulesArm([mark(m1), mark(m2), insideW1, insideW2, outside]);
    // both marks bound something, so NEITHER mints; the three pstarts are the three visits
    expect(visits).toHaveLength(3);
    expect(visits.every((v) => v.opened_by_kind === "pstart")).toBe(true);
    expect(visits.map((v) => v.opened_by).sort()).toEqual(["svc_a", "svc_b", "svc_c"]);

    // the 45-minute prior is exactly the boundary, and it is exclusive at the top
    const justInside = new Date(Date.parse(m2) + LAST_MARK_WINDOW_MS - 1000).toISOString();
    const justOutside = new Date(Date.parse(m2) + LAST_MARK_WINDOW_MS).toISOString();
    const a = runRulesArm([mark(m2), wh("pstart", justInside, "svc_x", { individual_uid: "ind_x", calendar_uid: "cal_x", attribution: "direct" })]);
    expect(a.visits.filter((v) => v.opened_by_kind === "mark")).toHaveLength(0); // bound
    const b = runRulesArm([mark(m2), wh("pstart", justOutside, "svc_x", { individual_uid: "ind_x", calendar_uid: "cal_x", attribution: "direct" })]);
    expect(b.visits.filter((v) => v.opened_by_kind === "mark")).toHaveLength(1); // window empty
  });

  it("a warehouse clock INSIDE a mark window makes ONE visit, not two", () => {
    const { visits } = runRulesArm([
      mark(T("04:00")),
      wh("pqm_called", T("04:10"), "qts_1", { individual_uid: "ind_1", attribution: "direct" }),
      wh("pstart", T("04:11"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" }),
    ]);
    // one call + one start + one mark, all the same consult
    expect(visits).toHaveLength(1);
    expect(visits[0]!.opened_by).toBe("svc_1");
    expect(visits[0]!.individual_uid).toBe("ind_1"); // identity from the warehouse, not the mark
  });

  it("a warehouse clock OUTSIDE every mark window still mints its own visit — the OPD 7 afternoon", () => {
    const { visits } = runRulesArm([
      mark(T("04:02")),
      wh("pstart", T("10:39"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" }),
    ]);
    expect(visits).toHaveLength(2);
    expect(visits.some((v) => v.opened_by === "svc_1" && v.opened_by_kind === "pstart")).toBe(true);
    const orphan = visits.find((v) => v.opened_by_kind === "mark")!;
    expect(orphan.state).toBe("unknown");
    expect(orphan.confidence).toBe(0.3);
  });

  it("a mark whose window contains nothing stays unknown at 0.3, with a named reason", () => {
    const { visits } = runRulesArm([
      wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" }),
      mark(T("11:00")),
    ]);
    const orphan = visits.find((v) => v.opened_by_kind === "mark")!;
    expect(orphan.individual_uid).toBeNull();
    expect(orphan.state).toBe("unknown");
    expect(orphan.confidence).toBe(0.3);
    expect(orphan.reasons).toContain(RULES_REASONS.MARK_WITHOUT_WAREHOUSE_EVIDENCE);
  });

  it("a call that never started still says why, and closes by the day boundary", () => {
    const { visits } = runRulesArm([wh("pqm_called", T("07:00"), "qts_9", { individual_uid: "ind_9", attribution: "direct" })]);
    expect(visits[0]).toMatchObject({ opened_by: "qts_9", opened_by_kind: "pqm_called", state: "ended", end_reason: END_REASONS.DAY_ROLLOVER });
    expect(visits[0]!.reasons).toContain(RULES_REASONS.PQM_CALLED_WITHOUT_PSTART);
    expect(visits[0]!.confidence).toBeLessThanOrEqual(0.5);
  });
});

describe("8b — the worked expectations from the kickoff, verbatim", () => {
  it("Cardiology: three marks, one pstart, one call → THREE visits, not four", () => {
    const cues = [
      cue("consult_mark", "2026-08-19T04:41:30.468Z", { source: "kiosk" }, "replay", null),
      cue("consult_mark", "2026-08-19T06:08:12.436Z", { source: "kiosk" }, "replay", null),
      cue("consult_mark", "2026-08-19T09:34:23.931Z", { source: "kiosk" }, "replay", null),
      wh("pqm_called", "2026-08-19T06:54:32.000Z", "qts_c1", { individual_uid: "ind_2", attribution: "direct" }),
      wh("pstart", "2026-08-19T06:54:33.000Z", "svc_c1", { individual_uid: "ind_2", calendar_uid: "cal_c1", attribution: "direct" }),
    ];
    const { visits } = runRulesArm(cues);
    expect(visits).toHaveLength(3);
    // mark 1 [04:41, 06:08) empty, mark 3 [09:34, 10:19) empty, mark 2 bound both clocks
    expect(visits.filter((v) => v.state === "unknown" && v.confidence === 0.3)).toHaveLength(2);
    const bound = visits.find((v) => v.individual_uid === "ind_2")!;
    expect(bound.opened_by).toBe("svc_c1");
  });

  it("OPD 7: one morning mark must not swallow the 10:39Z starts — the gap stays a gap", () => {
    const cues: FuseCue[] = [cue("consult_mark", "2026-08-19T04:02:29.995Z", { source: "kiosk" }, "replay", null)];
    for (let i = 0; i < 9; i++) {
      cues.push(wh("pstart", `2026-08-19T10:${String(39 + i).padStart(2, "0")}:36.000Z`, `svc_${i}`, { individual_uid: `ind_${i}`, calendar_uid: `cal_${i}`, attribution: "direct" }));
      cues.push(wh("pqm_called", `2026-08-19T10:${String(39 + i).padStart(2, "0")}:00.000Z`, `qts_${i}`, { individual_uid: `ind_${i}`, attribution: "direct" }));
    }
    for (let i = 9; i < 13; i++) cues.push(wh("pqm_called", `2026-08-19T11:${String(i).padStart(2, "0")}:00.000Z`, `qts_${i}`, { individual_uid: `ind_${i}`, attribution: "direct" }));

    const { visits } = runRulesArm(cues);
    expect(visits).toHaveLength(14);
    const kinds = visits.reduce((a: Record<string, number>, v) => ((a[v.opened_by_kind] = (a[v.opened_by_kind] ?? 0) + 1), a), {});
    expect(kinds).toEqual({ pstart: 9, pqm_called: 4, mark: 1 });
    expect(visits.filter((v) => v.state === "unknown")).toHaveLength(1);
  });
});

describe("8c — A7: day_rollover closes the open states and leaves `unknown` alone", () => {
  it("called, in_chair and at_diagnostics all close; unknown does not", () => {
    const { visits } = runRulesArm([
      wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" }),       // in_chair
      wh("dx_event", T("05:10"), "svc_dx", { individual_uid: "ind_1", attribution: "direct" }),                            // at_diagnostics
      wh("pqm_called", T("07:00"), "qts_9", { individual_uid: "ind_9", attribution: "direct" }),                           // called
      mark(T("14:00")),                                                                                                    // unknown
    ]);
    const open = visits.filter((v) => ["called", "in_chair", "at_diagnostics"].includes(v.state));
    expect(open).toHaveLength(0);
    for (const v of visits.filter((x) => x.opened_by_kind !== "mark")) {
      expect(v.state).toBe("ended");
      expect(v.end_reason).toBe(END_REASONS.DAY_ROLLOVER);
    }
    const orphan = visits.find((v) => v.opened_by_kind === "mark")!;
    expect(orphan.state).toBe("unknown");
    expect(orphan.end_reason).toBeNull();
    expect(orphan.confidence).toBe(0.3);
  });
});

describe("8d — A6: end_reason answers why it ENDED; ambiguity answers why we are UNSURE", () => {
  it("end_reason is null unless state is ended, and reasons never touch it", () => {
    const { visits } = runRulesArm([
      wh("pqm_called", T("07:00"), "qts_9", { individual_uid: "ind_9", attribution: "inferred" }),
      mark(T("14:00")),
    ]);
    for (const v of visits) {
      if (v.state !== "ended") expect(v.end_reason).toBeNull();
      else expect([END_REASONS.PULSE_NOTE, END_REASONS.DAY_ROLLOVER]).toContain(v.end_reason);
      // an ambiguity reason is never smuggled into end_reason
      for (const r of v.reasons) expect(v.end_reason).not.toBe(r);
    }
  });

  it("several reasons join in CLOSED-SET order, comma separated, never prose", () => {
    const many = runRulesArm([wh("pqm_called", T("07:00"), "qts_9", { individual_uid: "ind_9", attribution: "inferred" })]);
    const v = many.visits[0]!;
    expect(v.reasons.length).toBeGreaterThan(1);
    const joined = ambiguityOf(v.reasons)!;
    expect(joined).toBe(v.reasons.join(","));
    // closed-set order: every token is in the set, and the sequence follows the declaration
    const idx = joined.split(",").map((r) => ALL_RULES_REASONS.indexOf(r));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(ambiguityOf([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the runner + the fake database
// ---------------------------------------------------------------------------

const tool = () => FUSE_TOOLS.find((t) => t.name === "scribe_fuse_run")!;
const call = (args: Row) => tool().handler(args, { origin: "https://preview.example" }) as Promise<Row>;

let visitRows: Map<string, Row>;
let dayScratch: boolean;
let CUES: FuseCue[];

const seedDb = () => {
  visitRows = new Map();
  dayScratch = true;
  CUES = [
    wh("pqm_called", T("03:30"), "qts_1", { individual_uid: "ind_1", attribution: "direct" }),
    wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" }),
    wh("pstart", T("09:20"), "svc_2", { individual_uid: "ind_1", calendar_uid: "cal_2", attribution: "direct" }),
    mark(T("15:00")),
  ];
  brainResponder = (text, values) => {
    if (/FROM room_day WHERE id = \$1/.test(text)) {
      if (String(values[0]) === LIVE_DAY) return [{ id: LIVE_DAY, room_id: "room_q", doctor_id: null, ist_date: "2026-08-19", started_at: new Date(), ended_at: null, scratch: false }];
      return [{ id: String(values[0]), room_id: "room_scratch_q", doctor_id: null, ist_date: "2026-08-19", started_at: new Date(), ended_at: null, scratch: dayScratch }];
    }
    if (/FROM cue\s+WHERE room_day_id = \$1/.test(text.replace(/\s+/g, " "))) {
      return CUES.map((c) => ({ id: c.id, type: c.type, at: new Date(c.at), created_at: new Date(c.at), payload: c.payload, source: c.source, source_ref: c.source_ref }));
    }
    if (/^INSERT INTO visit/.test(text)) {
      // column order follows SQL_VISIT_INSERT exactly; 0049 inserted `ambiguity` at $9
      const [id, roomDayId, uid, consultUid, state, pstartAt, conf, endReason, ambiguity, arm, openedBy, kind] = values as unknown[];
      const key = `${String(arm)}|${String(openedBy)}`; // 0048's partial unique index
      if (arm !== null && openedBy !== null && visitRows.has(key)) return []; // ON CONFLICT DO NOTHING
      visitRows.set(key, { id, room_day_id: roomDayId, individual_uid: uid, consult_uid: consultUid, state, pstart_at: pstartAt, confidence: conf, end_reason: endReason, ambiguity, arm, opened_by: openedBy, opened_by_kind: kind, updated_at: new Date() });
      return [{ id }];
    }
    if (/FROM visit WHERE room_day_id = \$1 AND COALESCE\(arm, 'rules'\)/.test(text)) {
      return [...visitRows.values()].filter((v) => v.room_day_id === values[0] && (v.arm ?? "rules") === values[1]);
    }
    if (/FROM speaker_cluster/.test(text)) return [];
    return [];
  };
};

beforeEach(seedDb);

describe("9 — X4: arms B and C write NOTHING when the provider is not gemini", () => {
  it("flash refuses by name and issues zero inserts", async () => {
    rcImpl = () => ({ ok: true, content: JSON.stringify({ visits: [{ opened_by: "svc_1", state: "in_chair", confidence: 0.9 }] }), latency_ms: 5, provider: "ollama" });
    const out = await call({ room_day_id: DAY, arm: "flash", dry_run: false });
    expect(out).toMatchObject({ ok: false, error: "provider_not_gemini", provider: "ollama", written: 0 });
    expect(brainCalls.filter((c) => /^INSERT INTO visit/.test(c.text))).toHaveLength(0);
    expect(visitRows.size).toBe(0);
  });

  it("hybrid refuses too — a successful ollama answer is exactly the failure being guarded", async () => {
    rcImpl = () => ({ ok: true, content: JSON.stringify({ decisions: [] }), latency_ms: 5, provider: "ollama" });
    const out = await call({ room_day_id: DAY, arm: "hybrid", dry_run: false });
    expect(out).toMatchObject({ ok: false, error: "provider_not_gemini", provider: "ollama" });
    expect(visitRows.size).toBe(0);
  });

  it("'none' and a gemini-lookalike are both refused; only a real gemini: prefix passes", async () => {
    for (const provider of ["none", "unknown", "gemini", "not-gemini:x", "OLLAMA"]) {
      seedDb();
      rcImpl = () => ({ ok: true, content: JSON.stringify({ visits: [] }), latency_ms: 1, provider });
      const out = await call({ room_day_id: DAY, arm: "flash", dry_run: false });
      expect(out.ok, `provider ${provider} must be refused`).toBe(false);
      expect(visitRows.size).toBe(0);
    }
  });

  it("arm A never calls a model and is unaffected", async () => {
    const out = await call({ room_day_id: DAY, arm: "rules", dry_run: false });
    expect(out).toMatchObject({ ok: true, provider: "none" });
    expect(rcCalls).toHaveLength(0);
    expect(Number(out.written)).toBeGreaterThan(0);
  });
});

describe("10 — arm B advises, it never mints or overrides", () => {
  it("a decision naming an unknown visit, or a confident one, is dropped", async () => {
    rcImpl = () => ({
      ok: true,
      provider: "gemini:gemini-3.1-pro-preview",
      latency_ms: 5,
      content: JSON.stringify({ decisions: [
        { opened_by: "svc_1", state: "ended", confidence: 0.99 },        // CONFIDENT — must be ignored
        { opened_by: "does_not_exist", state: "ended", confidence: 0.9 }, // unknown — must be ignored
        { opened_by: "INVENTED", state: "in_chair", confidence: 1 },
      ] }),
    });
    const rules = await call({ room_day_id: DAY, arm: "rules", dry_run: true });
    const hybrid = await call({ room_day_id: DAY, arm: "hybrid", dry_run: true });
    const rv = rules.visits as Row[];
    const hv = hybrid.visits as Row[];
    expect(hv).toHaveLength(rv.length);                                  // never mints
    expect(hv.map((v) => v.opened_by)).toEqual(rv.map((v) => v.opened_by));
    const confident = hv.find((v) => v.opened_by === "svc_1")!;
    const wasConfident = rv.find((v) => v.opened_by === "svc_1")!;
    expect(confident.state).toBe(wasConfident.state);                    // never overrides
    expect(confident.confidence).toBe(wasConfident.confidence);
  });

  it("it may move an ambiguous visit, and never invents an individual_uid", async () => {
    const markKey = CUES.find((c) => c.type === "consult_mark")!.id;
    rcImpl = () => ({
      ok: true, provider: "gemini:gemini-3.1-pro-preview", latency_ms: 5,
      content: JSON.stringify({ decisions: [{ opened_by: markKey, state: "ended", confidence: 0.4, individual_uid: "ind_INVENTED" }] }),
    });
    const out = await call({ room_day_id: DAY, arm: "hybrid", dry_run: true });
    const moved = (out.visits as Row[]).find((v) => v.opened_by === markKey)!;
    expect(moved.state).toBe("ended");
    expect(moved.confidence).toBe(0.4);
    expect(moved.individual_uid).toBeNull(); // the model's uid is never read
    expect(out.advisory_applied).toBe(1);
  });
});

describe("11 — re-running an arm writes nothing that exists", () => {
  it("second run is all already_existed, and adds no row", async () => {
    const first = await call({ room_day_id: DAY, arm: "rules", dry_run: false });
    expect(Number(first.written)).toBeGreaterThan(0);
    expect(first.already_existed).toBe(0);
    const size = visitRows.size;

    const second = await call({ room_day_id: DAY, arm: "rules", dry_run: false });
    expect(second.written).toBe(0);
    expect(Number(second.already_existed)).toBe(Number(first.written));
    expect(second.failed).toBe(0);
    expect(visitRows.size).toBe(size);
  });

  it("a different arm on the same day writes its own rows alongside", async () => {
    await call({ room_day_id: DAY, arm: "rules", dry_run: false });
    const rulesCount = visitRows.size;
    rcImpl = () => ({ ok: true, provider: "gemini:gemini-3.1-pro-preview", latency_ms: 5, content: JSON.stringify({ decisions: [] }) });
    const hybrid = await call({ room_day_id: DAY, arm: "hybrid", dry_run: false });
    expect(Number(hybrid.written)).toBeGreaterThan(0);
    expect(visitRows.size).toBe(rulesCount * 2); // same visits, different arm → different key
    expect([...visitRows.values()].filter((v) => v.arm === "hybrid")).toHaveLength(rulesCount);
  });

  it("dry_run defaults to TRUE and writes nothing", async () => {
    const out = await call({ room_day_id: DAY, arm: "rules" });
    expect(out.dry_run).toBe(true);
    expect(out.written).toBe(0);
    expect((out.visits as Row[]).length).toBeGreaterThan(0);
    expect(visitRows.size).toBe(0);
    expect(brainCalls.some((c) => /^INSERT INTO visit/.test(c.text))).toBe(false);
  });
});

describe("12 — a non-scratch room-day is refused by name, before any read", () => {
  it("refused, with no cue read and no visit written", async () => {
    const out = await call({ room_day_id: LIVE_DAY, arm: "rules", dry_run: false });
    expect(out).toMatchObject({ ok: false, error: "not_a_scratch_day", room_day_id: LIVE_DAY });
    expect(brainCalls.some((c) => /FROM cue/.test(c.text))).toBe(false);
    expect(visitRows.size).toBe(0);
  });

  it("an unknown day, and an unknown arm, are each refused by name", async () => {
    brainResponder = () => [];
    expect(await call({ room_day_id: "rd_nope", arm: "rules" })).toMatchObject({ ok: false, error: "room_day_not_found" });
    seedDb();
    expect(await call({ room_day_id: DAY, arm: "telepathy" })).toMatchObject({ ok: false, error: "unknown_arm" });
  });
});

describe("13 — readGraph is arm-scoped, and NULL reads as rules", () => {
  it("no arm given returns only rules rows; a NULL arm row reads as rules", async () => {
    await call({ room_day_id: DAY, arm: "rules", dry_run: false });
    rcImpl = () => ({ ok: true, provider: "gemini:gemini-3.1-pro-preview", latency_ms: 5, content: JSON.stringify({ decisions: [] }) });
    await call({ room_day_id: DAY, arm: "hybrid", dry_run: false });
    // a legacy row with no arm at all
    visitRows.set("|legacy", { id: "vis_legacy", room_day_id: DAY, individual_uid: null, consult_uid: null, state: "unknown", pstart_at: null, confidence: 0.1, end_reason: null, ambiguity: null, arm: null, opened_by: null, opened_by_kind: null, updated_at: new Date() });

    const pool = (await import("@/lib/brain/db")).getPool();
    const dflt = await readGraph(pool as never, "room_scratch_q", "2026-08-19", DAY);
    expect(dflt.arm).toBe(DEFAULT_ARM);
    expect(dflt.visits.every((v) => v.arm === "rules")).toBe(true);
    expect(dflt.visits.some((v) => v.id === "vis_legacy")).toBe(true); // arm IS NULL reads as rules
    expect(dflt.visits.some((v) => v.arm === "hybrid")).toBe(false);

    const hy = await readGraph(pool as never, "room_scratch_q", "2026-08-19", DAY, "hybrid");
    expect(hy.arm).toBe("hybrid");
    expect(hy.visits.every((v) => v.arm === "hybrid")).toBe(true);
    expect(hy.visits.some((v) => v.id === "vis_legacy")).toBe(false);
  });

  it("after a full fuse, active_visit_id is NULL — nothing is left in the chair", async () => {
    await call({ room_day_id: DAY, arm: "rules", dry_run: false });
    const pool = (await import("@/lib/brain/db")).getPool();
    const g = await readGraph(pool as never, "room_scratch_q", "2026-08-19", DAY);
    expect(g.visits.length).toBeGreaterThan(0);
    expect(g.visits.some((v) => v.state === "in_chair")).toBe(false);
    expect(g.active_visit_id).toBeNull();
  });

  it("the state envelope carries ambiguity, and end_reason only where the visit ended", async () => {
    await call({ room_day_id: DAY, arm: "rules", dry_run: false });
    const pool = (await import("@/lib/brain/db")).getPool();
    const g = await readGraph(pool as never, "room_scratch_q", "2026-08-19", DAY);
    for (const v of g.visits) {
      expect(v).toHaveProperty("ambiguity");
      if (v.state !== "ended") expect(v.end_reason).toBeNull();
      if (v.ambiguity !== null) for (const r of String(v.ambiguity).split(",")) expect(ALL_RULES_REASONS).toContain(r);
    }
    // the mark-only visit is the one that stays unknown, and it carries its reason in ambiguity
    const orphan = g.visits.find((v) => v.state === "unknown")!;
    expect(orphan.ambiguity).toBe(RULES_REASONS.MARK_WITHOUT_WAREHOUSE_EVIDENCE);
    expect(orphan.end_reason).toBeNull();
  });
});

describe("14 — the SQL, the migration, and the duplicate", () => {
  it("the invented 30-minute bind constant is gone", () => {
    const src = readFileSync("lib/brain/fuse/rules.ts", "utf8");
    expect(src).not.toMatch(/MARK_BIND_WINDOW_MS/);
    expect(src).toMatch(/LAST_MARK_WINDOW_MS = 45 \* 60 \* 1000/);
  });

  it("0049 records itself and adds one nullable column, nothing else", () => {
    const sql = readFileSync("db/migrations/0049_visit_ambiguity.sql", "utf8");
    expect(sql).toMatch(/VALUES \(49, '0049_visit_ambiguity'\)/);
    expect(sql).toMatch(/ON CONFLICT DO NOTHING;/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS ambiguity text/);
    // no CHECK, no index, nothing touched — asserted against the STATEMENTS, since the
    // header comment names visit_arm_opened_by_key precisely to say it is left alone
    const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--") && l.trim()).join("\n");
    expect(statements).not.toMatch(/CHECK\s*\(/);
    expect(statements).not.toMatch(/CREATE (UNIQUE )?INDEX/);
    expect(statements).not.toMatch(/visit_arm_opened_by_key/);
    expect(statements).not.toMatch(/^\s*(DROP|ALTER INDEX|TRUNCATE|DELETE|UPDATE)\b/im);
    // exactly one ALTER TABLE, and it is the additive one
    expect(statements.match(/ALTER TABLE/g)).toHaveLength(1);
  });

  it("0048 records itself and is additive + partial", () => {
    const sql = readFileSync("db/migrations/0048_visit_arm.sql", "utf8");
    expect(sql).toMatch(/VALUES \(48, '0048_visit_arm'\)/);
    expect(sql).toMatch(/ON CONFLICT DO NOTHING;/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS arm text/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS opened_by text/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS opened_by_kind text/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS visit_arm_opened_by_key/);
    expect(sql).toMatch(/ON visit \(arm, opened_by\)/);
    expect(sql).toMatch(/WHERE arm IS NOT NULL AND opened_by IS NOT NULL/);
    // the rejected key, and the two forbidden changes
    expect(sql).not.toMatch(/UNIQUE INDEX[^\n]*individual_uid/);
    expect(sql).not.toMatch(/CHECK\s*\(\s*arm/);
    expect(sql).not.toMatch(/^\s*(DROP|ALTER INDEX|TRUNCATE|DELETE|UPDATE)\b/im);
  });

  it("SQL_VISITS_FOR_DAY is byte-identical in lib/brain/state.ts and brain/src/state.ts", () => {
    const grab = (path: string) => {
      const src = readFileSync(path, "utf8");
      const m = /export const SQL_VISITS_FOR_DAY =\s*([\s\S]*?);\n/.exec(src);
      if (!m) throw new Error(`SQL_VISITS_FOR_DAY not found in ${path}`);
      return m[1]!.replace(/\s+/g, " ").trim();
    };
    const a = grab("lib/brain/state.ts");
    const b = grab("brain/src/state.ts");
    expect(a).toBe(b);
    expect(a).toContain("COALESCE(arm, 'rules') = $2::text");
    expect(a).toContain("arm, opened_by, opened_by_kind");
    expect(a).toContain("ambiguity"); // 0049 projected in BOTH copies
  });

  it("the visit insert is idempotent on the arm key and names every 0048 column", () => {
    expect(SQL_VISIT_INSERT).toContain("arm, opened_by, opened_by_kind");
    expect(SQL_VISIT_INSERT).toContain("end_reason, ambiguity");
    expect(SQL_VISIT_INSERT).toContain("$12::text");
    expect(SQL_VISIT_INSERT).toContain("ON CONFLICT DO NOTHING");
    expect(SQL_VISITS_FOR_DAY).toContain("COALESCE(arm, 'rules')");
  });

  it("no arm attaches a speaker_cluster (X5)", async () => {
    await call({ room_day_id: DAY, arm: "rules", dry_run: false });
    expect(brainCalls.some((c) => /UPDATE speaker_cluster|INSERT INTO speaker_cluster/.test(c.text))).toBe(false);
  });
});
