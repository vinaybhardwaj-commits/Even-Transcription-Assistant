/**
 * encounter-hypotheses.test.ts — migration 0114 and lib/encounter-hypotheses.ts (the E-5 store).
 * Unit level: the migration text, the pure checks, the SQL each helper sends (db mocked), and the MCP
 * tool. The real-database proof ran on a Neon test branch (see the build report). All values synthetic.
 */
import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Answer = unknown[] | ((vals: unknown[]) => unknown[]);
const db: { calls: Array<{ q: string; vals: unknown[] }>; queue: Answer[] } = { calls: [], queue: [] };
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => {
    db.calls.push({ q: strings.join("?").replace(/\s+/g, " ").trim(), vals });
    const a = db.queue.shift() ?? [];
    return Promise.resolve(typeof a === "function" ? a(vals) : a);
  },
}));
/** The write's answer as Postgres gives it: the run id it was sent (vals[0]) and a row count. */
const echo = (inserted: number) => (vals: unknown[]) => [{ run_id: vals[0], inserted }];
vi.mock("@/lib/brain/state", async (orig) => ({
  ...(await orig<typeof import("@/lib/brain/state")>()),
  findRoomDay: async (roomId: string, date: string) => (roomId === "room_a" && date === "2026-09-12" ? { id: "rd_test1" } : null),
}));
vi.mock("@/lib/mcp/tools/brain", async (orig) => ({
  ...(await orig<typeof import("@/lib/mcp/tools/brain")>()),
  resolveRoom: async (args: Record<string, unknown>) =>
    args.room_slug === "cardio" ? { id: "room_a", slug: "cardio", name: "x", enabled: true } : null,
}));

import { CLOSED_BY } from "@/lib/encounter-clock/smooth";
import { VOICE_DOMAINS } from "@/lib/voice-centroid";
import { checkValues, stripSqlComments } from "../support/sql-check";
import {
  MATCH_SOURCES,
  checkInterval,
  checkRunInput,
  intervalRows,
  readLatestRun,
  readRun,
  rowToHypothesis,
  writeHypothesisRun,
  type HypothesisInterval,
  type HypothesisRunInput,
} from "@/lib/encounter-hypotheses";
import { VOICE_TOOLS } from "@/lib/mcp/tools/voice";

const T0 = 1_789_500_000_000;
const iv = (over: Partial<HypothesisInterval> = {}): HypothesisInterval => ({
  start_ms: T0, end_ms: T0 + 600_000, speech_probes: 8, non_speech_probes: 3, unjudged_ms: 60_000,
  longest_unjudged_run_ms: 60_000, dead_mic_ms: 0, closed_by: "non_speech", merged_from: 1,
  doctor_present: { yes: 0, no: 0, unknown: 8 }, ...over,
});
const run = (over: Partial<HypothesisRunInput> = {}): HypothesisRunInput => ({
  room_day_id: "rd_test1", smoother_version: "encounter-clock-smooth-v1", gate_version: "encounter-clock-gate-v1",
  params: { enter: 2, exit: 3, merge_gap_ms: 180000 }, probes: { total: 30, speech: 12, non_speech: 14, unjudged: 4 },
  intervals: [iv(), iv({ start_ms: T0 + 900_000, end_ms: T0 + 1_200_000, closed_by: "end_of_input" })], ...over,
});
const runRow = (over: Record<string, unknown> = {}) => ({
  id: "ehr_abc", room_day_id: "rd_test1", smoother_version: "encounter-clock-smooth-v1", gate_version: "encounter-clock-gate-v1",
  params: { enter: 2 }, probes_total: 30, probes_speech: 12, probes_non_speech: 14, probes_unjudged: 4,
  n_hypotheses: 1, created_at: new Date("2026-09-22T17:00:00Z"), runs_for_day: 3, ...over,
});
const hypRow = (over: Record<string, unknown> = {}) => ({
  id: "eh_1", run_id: "ehr_abc", room_day_id: "rd_test1", start_ms: String(T0), end_ms: String(T0 + 600_000),
  speech_probes: 8, non_speech_probes: 3, unjudged_ms: "60000", longest_unjudged_run_ms: "60000", dead_mic_ms: "0",
  closed_by: "non_speech", merged_from: 1, doctor_yes: 0, doctor_no: 0, doctor_unknown: 8,
  clinician_id: null, match_source: null, centroid_id: null, doctor_cosine: null, ...over,
});

beforeEach(() => {
  db.calls.length = 0;
  db.queue = [];
});

describe("migration 0114", () => {
  const code = readFileSync("db/migrations/0114_encounter_hypothesis.sql", "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  it("creates both tables and their indexes idempotently, with the run FK cascading", () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS encounter_hypothesis_run \(/);
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS encounter_hypothesis \(/);
    expect(code).toMatch(/run_id\s+text NOT NULL REFERENCES encounter_hypothesis_run\(id\) ON DELETE CASCADE/);
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS encounter_hypothesis_run_day_idx\s+ON encounter_hypothesis_run \(room_day_id, created_at DESC\)/);
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS encounter_hypothesis_run_start_idx\s+ON encounter_hypothesis \(run_id, start_ms\)/);
  });

  it("carries the CHECKs the writer mirrors", () => {
    expect(code).toMatch(/probes_speech \+ probes_non_speech \+ probes_unjudged = probes_total/);
    expect(code).toMatch(/CHECK \(end_ms > start_ms\)/);
    // The VALUES are asserted by the drift test (value sets, formatting-immune); here we only check the
    // constraint exists. A regex over the list's literal layout would fail on a harmless reformat.
    expect(code).toMatch(/CONSTRAINT encounter_hypothesis_closed_by_chk CHECK/);
    expect(code).toMatch(/CONSTRAINT encounter_hypothesis_match_source_chk CHECK/);
    expect(code).toMatch(/clinician_id IS NULL OR \(match_source IS NOT NULL AND doctor_cosine IS NOT NULL\)/);
  });

  it("records itself as 114, is the only 0114, and touches no existing table", () => {
    expect(code).toMatch(/VALUES \(114, '0114_encounter_hypothesis'\)\s+ON CONFLICT DO NOTHING/);
    expect(readdirSync("db/migrations").filter((f) => f.startsWith("0114_"))).toEqual(["0114_encounter_hypothesis.sql"]);
    expect(code).not.toMatch(/\b(ALTER|DROP|UPDATE|DELETE FROM|TRUNCATE|GRANT)\b/i);
  });

  it("stores no text column", () => {
    expect(code).not.toMatch(/\b(text_|transcript|note|label)\w*\s+text/i);
  });
});

describe("pure checks", () => {
  it("a smoother-shaped run passes", () => {
    expect(checkRunInput(run())).toEqual([]);
    expect(checkRunInput(run({ intervals: [] }))).toEqual([]); // ran, found nothing: still writable
  });

  it("names each problem", () => {
    expect(checkRunInput(run({ room_day_id: "rd x" }))).toEqual(["bad_room_day_id"]);
    expect(checkRunInput(run({ gate_version: "" }))).toEqual(["bad_version"]);
    expect(checkRunInput(run({ params: [] as never }))).toEqual(["bad_params"]);
    expect(checkRunInput(run({ probes: { total: 30, speech: 12, non_speech: 14, unjudged: 5 } }))).toEqual(["bad_probe_counts"]);
    expect(checkRunInput(run({ intervals: [iv({ end_ms: T0 })] }))).toEqual(["bad_interval"]);
    expect(checkRunInput(run({ intervals: [iv(), iv({ start_ms: T0 + 300_000, end_ms: T0 + 700_000 })] }))).toEqual(["overlapping_intervals"]);
  });

  it("interval rules mirror the migration's CHECKs", () => {
    for (const bad of [
      { closed_by: "timeout" as never }, { merged_from: 0 }, { dead_mic_ms: 70_000 }, { longest_unjudged_run_ms: 70_000 },
      { speech_probes: -1 }, { start_ms: 1.5 }, { doctor_present: { yes: -1, no: 0, unknown: 0 } },
    ]) expect(checkInterval(iv(bad)), JSON.stringify(bad)).toEqual(["bad_interval"]);
  });

  it("an identity needs its match source and a cosine in [-1, 1]", () => {
    expect(checkInterval(iv({ identity: { clinician_id: "doc_fake0001", match_source: "room_primary", centroid_id: "vc_x", doctor_cosine: 0.71 } }))).toEqual([]);
    expect(checkInterval(iv({ identity: { clinician_id: null, match_source: "room_primary", centroid_id: null, doctor_cosine: 0.4 } }))).toEqual([]);
    // An empty match_source is now a type error as well as a validation error; the cast is what a
    // caller without the types (a raw JSON payload) would hand in.
    expect(checkInterval(iv({ identity: { clinician_id: "doc_fake0001", match_source: "" as never, centroid_id: null, doctor_cosine: 0.7 } }))).toEqual(["bad_identity"]);
    expect(checkInterval(iv({ identity: { clinician_id: "doc_fake0001", match_source: "room_primary", centroid_id: null, doctor_cosine: 1.2 } }))).toEqual(["bad_identity"]);
  });

  it("rows are ordered by start, carry the run id, and flatten doctor_present", () => {
    let n = 0;
    const rows = intervalRows("ehr_r", "rd_test1", [iv({ start_ms: T0 + 900_000, end_ms: T0 + 1_000_000 }), iv()], () => `eh_${++n}`);
    expect(rows.map((r) => r.start_ms)).toEqual([T0, T0 + 900_000]);
    expect(rows[0]).toMatchObject({ id: "eh_1", run_id: "ehr_r", doctor_unknown: 8, clinician_id: null, doctor_cosine: null });
  });

  it("an unknown closed_by or match_source throws instead of being coerced", () => {
    expect(() => rowToHypothesis(hypRow({ closed_by: "tape_off" }))).not.toThrow();
    expect(() => rowToHypothesis(hypRow({ closed_by: "timeout" }))).toThrow(/unknown closed_by "timeout"/);
    expect(() => rowToHypothesis(hypRow({ closed_by: null }))).toThrow(/unknown closed_by null/);
    expect(() => rowToHypothesis(hypRow({ match_source: "heuristic", clinician_id: "doc_fake0001", doctor_cosine: 0.7 })))
      .toThrow(/unknown match_source "heuristic"/);
    // The five real values all read back as themselves.
    for (const v of CLOSED_BY) expect(rowToHypothesis(hypRow({ closed_by: v })).closed_by).toBe(v);
  });

  it("a stored row reads back as the smoother shape", () => {
    expect(rowToHypothesis(hypRow())).toMatchObject({ start_ms: T0, unjudged_ms: 60_000, identity: null,
      doctor_present: { yes: 0, no: 0, unknown: 8 } });
    expect(rowToHypothesis(hypRow({ clinician_id: "doc_fake0001", match_source: "room_primary", doctor_cosine: 0.7 })).identity)
      .toEqual({ clinician_id: "doc_fake0001", match_source: "room_primary", centroid_id: null, doctor_cosine: 0.7 });
  });
});

describe("writes", () => {
  it("an invalid run writes nothing", async () => {
    expect(await writeHypothesisRun(run({ room_day_id: "" }))).toMatchObject({ ok: false, problems: ["bad_room_day_id"] });
    expect(db.calls).toHaveLength(0);
  });

  it("one statement inserts the run and every interval", async () => {
    db.queue = [echo(2)];
    const r = await writeHypothesisRun(run());
    expect(r).toMatchObject({ ok: true, n_hypotheses: 2 });
    expect(r.ok && r.run_id).toMatch(/^ehr_[a-z0-9]{12}$/);
    expect(db.calls).toHaveLength(1);
    const sent = db.calls[0]!;
    expect(sent.q).toMatch(/^WITH run AS \( INSERT INTO encounter_hypothesis_run/);
    expect(sent.q).toMatch(/ins AS \( INSERT INTO encounter_hypothesis .* FROM run, jsonb_to_recordset\(\?::jsonb\)/);
    const payload = JSON.parse(sent.vals.find((v) => typeof v === "string" && v.startsWith("[")) as string);
    expect(payload).toHaveLength(2);
    expect(payload.every((x: { run_id: string }) => r.ok && x.run_id === r.run_id)).toBe(true);
    expect(sent.vals).toContain(2); // n_hypotheses is the rows actually sent
  });

  it("an empty run is written too: ran and found nothing is a row", async () => {
    db.queue = [echo(0)];
    expect(await writeHypothesisRun(run({ intervals: [] }))).toMatchObject({ ok: true, n_hypotheses: 0 });
    expect(db.calls[0]!.vals).toContain("[]");
  });

  it("a short insert is a loud error", async () => {
    db.queue = [echo(1)];
    await expect(writeHypothesisRun(run())).rejects.toThrow(/returned 1 rows for 2 intervals/);
  });

  it("an answer naming another run is a loud error", async () => {
    db.queue = [[{ run_id: "ehr_other", inserted: 2 }]];
    await expect(writeHypothesisRun(run())).rejects.toThrow();
  });
});

describe("reads", () => {
  it("readLatestRun takes the newest run of the day and its intervals, with the day's run count", async () => {
    db.queue = [[runRow()], [hypRow()]];
    const r = await readLatestRun("rd_test1");
    expect(r.runs_for_day).toBe(3);
    expect(r.run).toMatchObject({ id: "ehr_abc", probes: { total: 30, unjudged: 4 }, hypotheses: [{ id: "eh_1" }] });
    expect(db.calls[0]!.q).toMatch(/WHERE room_day_id = \? ORDER BY created_at DESC, id DESC LIMIT 1/);
    expect(db.calls[1]!.q).toMatch(/WHERE run_id = \? ORDER BY start_ms/);
  });

  it("no run is null with a zero count, and a bad id sends no query", async () => {
    expect(await readLatestRun("rd_none")).toEqual({ run: null, runs_for_day: 0 });
    expect(await readLatestRun("rd x")).toEqual({ run: null, runs_for_day: 0 });
    expect(await readRun("nope")).toBeNull();
    expect(db.calls).toHaveLength(1);
  });

  it("no read selects a text column", async () => {
    db.queue = [[runRow()], [hypRow()], [runRow()], [hypRow()]];
    await readLatestRun("rd_test1");
    await readRun("ehr_abc");
    for (const c of db.calls) expect(c.q).not.toMatch(/transcript|note_json|tagged|label/);
  });
});

// The drift guard lives in tests/support/sql-check.ts: it compares VALUE SETS, strips comments first
// (a header quoting a constraint must not answer for it), and throws rather than matching nothing.
describe("vocabulary drift between the code and the migration", () => {
  const sql = readFileSync("db/migrations/0114_encounter_hypothesis.sql", "utf8");


  it("closed_by: the CHECK admits exactly the smoother's CLOSED_BY", () => {
    expect(checkValues(sql, "encounter_hypothesis_closed_by_chk", "closed_by")).toEqual(new Set(CLOSED_BY));
    expect(CLOSED_BY).toHaveLength(5); // a shrunken array must not silently satisfy this
  });

  it("match_source: the CHECK admits exactly MATCH_SOURCES", () => {
    expect(checkValues(sql, "encounter_hypothesis_match_source_chk", "match_source")).toEqual(new Set(MATCH_SOURCES));
  });

  it("match_source covers every voice_centroid domain, and adds only voice_print", () => {
    // MATCH_SOURCES is derived from VOICE_DOMAINS; this pins the relationship so a fourth capture
    // domain added to 0113 cannot leave this store (or its CHECK) behind.
    for (const d of VOICE_DOMAINS) expect(MATCH_SOURCES, d).toContain(d);
    expect(new Set(MATCH_SOURCES)).toEqual(new Set([...VOICE_DOMAINS, "voice_print"]));
    const inCheck = checkValues(sql, "encounter_hypothesis_match_source_chk", "match_source");
    for (const d of VOICE_DOMAINS) expect(inCheck, `${d} missing from the CHECK`).toContain(d);
  });

  it("the validator accepts every value the CHECK admits, and nothing else", () => {
    for (const v of CLOSED_BY) expect(checkInterval(iv({ closed_by: v })), v).toEqual([]);
    for (const v of ["timeout", "non_speech ", "NON_SPEECH", ""]) {
      expect(checkInterval(iv({ closed_by: v as never })), v).toEqual(["bad_interval"]);
    }
    for (const v of MATCH_SOURCES) {
      expect(checkInterval(iv({ identity: { clinician_id: "doc_fake0001", match_source: v, centroid_id: null, doctor_cosine: 0.7 } })), v).toEqual([]);
    }
    for (const v of ["heuristic", "room", "jev", ""]) {
      expect(checkInterval(iv({ identity: { clinician_id: "doc_fake0001", match_source: v as never, centroid_id: null, doctor_cosine: 0.7 } })), v).toEqual(["bad_identity"]);
    }
  });

  it("the parser reads values, not formatting", () => {
    const one = "CONSTRAINT c CHECK (x IN ('a', 'b', 'c'))";
    const reformatted = [
      "CONSTRAINT c CHECK (\n    x IN (\n      'a',\n      'b',\n      'c'\n    )\n  )",
      "CONSTRAINT c CHECK (x IN ('c','b','a'))",
      "CONSTRAINT c CHECK ((y IS NULL) OR x   IN   ( 'a' , 'b' , 'c' ))",
    ];
    for (const v of reformatted) expect(checkValues(v, "c", "x"), v).toEqual(checkValues(one, "c", "x"));
  });

  it("F1: a comment quoting the constraint cannot answer for it", () => {
    // ETA-Refuter's exact mutation: document the five-value clause in a header, narrow the real CHECK
    // to two. Before the fix the parser read the comment and stayed green; the real database refused
    // tape_off, unjudged_gap and dead_mic again — the original FAIL, restored invisibly.
    const mutated = [
      "-- CONSTRAINT encounter_hypothesis_closed_by_chk CHECK (",
      "--   closed_by IN ('non_speech', 'unjudged_gap', 'tape_off', 'dead_mic', 'end_of_input')),",
      "CREATE TABLE x (",
      "  CONSTRAINT encounter_hypothesis_closed_by_chk CHECK (",
      "    closed_by IN ('non_speech', 'end_of_input'))",
      ");",
    ].join("\n");
    expect(checkValues(mutated, "encounter_hypothesis_closed_by_chk", "closed_by")).toEqual(new Set(["non_speech", "end_of_input"]));
    expect(checkValues(mutated, "encounter_hypothesis_closed_by_chk", "closed_by")).not.toEqual(new Set(CLOSED_BY));
  });

  it("F1: a constraint that exists ONLY in a comment is not found at all", () => {
    const commentedOut = "-- CONSTRAINT ghost_chk CHECK (x IN ('a', 'b'))\nCREATE TABLE y (z text);";
    expect(() => checkValues(commentedOut, "ghost_chk", "x")).toThrow(/no CONSTRAINT ghost_chk/);
    // Trailing comments too, not just whole-line ones.
    const trailing = "CREATE TABLE y (\n  z text  -- CONSTRAINT ghost_chk CHECK (x IN ('a'))\n);";
    expect(() => checkValues(trailing, "ghost_chk", "x")).toThrow(/no CONSTRAINT ghost_chk/);
  });

  it("F1: stripping leaves quoted strings alone, comment markers included", () => {
    expect(stripSqlComments("SELECT 'a -- b' -- gone\n")).toBe("SELECT 'a -- b' \n");
    expect(stripSqlComments("SELECT 'it''s -- fine' -- gone")).toBe("SELECT 'it''s -- fine' \n");
    // A value containing a comment marker still parses as that value.
    const odd = "CONSTRAINT c CHECK (x IN ('a--b', 'c'))";
    expect(checkValues(odd, "c", "x")).toEqual(new Set(["a--b", "c"]));
  });

  it("the parser catches a disagreement in EITHER direction, and a missing list loudly", () => {
    const base = new Set(["a", "b", "c"]);
    expect(checkValues("CONSTRAINT c CHECK (x IN ('a', 'b'))", "c", "x")).not.toEqual(base);        // CHECK missing one
    expect(checkValues("CONSTRAINT c CHECK (x IN ('a', 'b', 'c', 'd'))", "c", "x")).not.toEqual(base); // CHECK has an extra
    expect(() => checkValues("CONSTRAINT other CHECK (x IN ('a'))", "c", "x")).toThrow(/no CONSTRAINT c/);
    expect(() => checkValues("CONSTRAINT c CHECK (x = 'a')", "c", "x")).toThrow(/no x IN/);
    expect(() => checkValues("CONSTRAINT c CHECK (x IN ('a',))", "c", "x")).toThrow(/empty value/);
  });
});

describe("MCP scribe_encounter_hypotheses", () => {
  const tool = VOICE_TOOLS.find((t) => t.name === "scribe_encounter_hypotheses")!;
  const ctx = { origin: "https://x", actor: "t", scopes: new Set(["read" as const]) };

  it("is a read tool", () => {
    expect(tool.scope).toBe("read");
  });

  it("room_day_id → latest run", async () => {
    db.queue = [[runRow()], [hypRow()]];
    const r = (await tool.handler({ room_day_id: "rd_test1" }, ctx)) as Record<string, unknown>;
    expect(r).toMatchObject({ room_day_id: "rd_test1", runs_for_day: 3, run: { id: "ehr_abc" } });
  });

  it("room + date resolves the room-day; a day with no row is null, not an error", async () => {
    db.queue = [[runRow()], [hypRow()]];
    expect(await tool.handler({ room_slug: "cardio", ist_date: "2026-09-12" }, ctx)).toMatchObject({ room_day_id: "rd_test1", run: { id: "ehr_abc" } });
    expect(await tool.handler({ room_slug: "cardio", ist_date: "2026-09-13" }, ctx)).toMatchObject({ room_day_id: null, run: null, runs_for_day: 0 });
    expect(await tool.handler({ room_slug: "nowhere" }, ctx)).toMatchObject({ run: null, error: "unknown_room" });
  });

  it("run_id → that run; nothing given → a named error", async () => {
    db.queue = [[runRow()], [hypRow()]];
    expect(await tool.handler({ run_id: "ehr_abc" }, ctx)).toMatchObject({ run: { id: "ehr_abc" } });
    expect(await tool.handler({ run_id: "ehr_none" }, ctx)).toMatchObject({ run: null, error: "run_not_found" });
    expect(await tool.handler({}, ctx)).toMatchObject({ run: null, error: expect.stringMatching(/required/) });
  });
});
