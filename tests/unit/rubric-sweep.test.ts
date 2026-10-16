/**
 * RUBRIC-SWEEP (16 Oct 2026) — the per-consult rubric runner: route modes and auth, eligibility, done-skip, ordering and the backfill window, one job per rubric,
 * the daily units cap, dry mode, the summary, scribe_rubric sweep_status. Sql, the job submit and the open-job lookup are mocked; the lab store is in memory (the real allowlist runs).
 * Fixtures are id-shaped tokens only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const H = vi.hoisted(() => ({
  rubrics: [] as Array<Record<string, unknown>>,
  sql: [] as Array<{ text: string; values: unknown[] }>,
  fsRows: [] as string[],
  done: {} as Record<string, string[]>,
  doneLab: {} as Record<string, string[]>,
  ran: {} as Record<string, string[]>,
  today: {} as Record<string, number>,
  open: null as Record<string, unknown> | null,
  dbThrows: false,
  submitted: [] as Array<Record<string, unknown>>,
  submitThrow: {} as Record<string, string>,
}));

vi.mock("@/lib/db", () => ({
  sql: Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    H.sql.push({ text, values });
    if (H.dbThrows) return Promise.reject(Object.assign(new Error("down"), { code: "08006" }));
    if (/FROM freescript_latest/.test(text)) return Promise.resolve((values[0] as string[]).filter((u) => H.fsRows.includes(u)).map((u) => ({ consult_uid: u })));
    if (/FROM rubric_result r JOIN rubric_run u/.test(text)) return Promise.resolve([{ n: H.today[String(values[0])] ?? 0 }]);
    if (/FROM scribe_job j/.test(text)) return Promise.resolve((values[3] as string[]).filter((u) => (H.ran[String(values[1])] ?? []).includes(u)).map((u) => ({ unit_key: u })));
    if (/FROM rubric_result WHERE rubric_id/.test(text)) {
      const have = [...(H.done[String(values[0])] ?? []), .../lab = false/.test(text) ? [] : H.doneLab[String(values[0])] ?? []];
      const haveSet = new Set(have);
      return Promise.resolve((values[2] as string[]).filter((u) => haveSet.has(u)).map((u) => ({ unit_key: u })));
    }
    return Promise.resolve([]);
  }, { transaction: async () => [] }),
}));
vi.mock("@/lib/jobs/store", () => ({ findOpenJob: vi.fn(async () => { if (H.dbThrows) throw new Error("down"); return H.open; }) }));
vi.mock("@/lib/jobs/submit", async () => {
  const { JobArgsError } = await vi.importActual<typeof import("@/lib/jobs/types")>("@/lib/jobs/types");
  return {
    JobArgsError,
    UnknownKindError: class extends Error {},
    submitJob: vi.fn(async (input: Record<string, unknown>) => {
      const id = String((input.args as Row).rubric_id);
      H.submitted.push(input);
      if (H.submitThrow[id]) throw new JobArgsError(H.submitThrow[id]!);
      return { id: `job_${id}`, kind: input.kind, status: "queued" };
    }),
  };
});
vi.mock("@/lib/rubrics/registry", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rubrics/registry")>("@/lib/rubrics/registry");
  return { ...actual, RUBRICS: H.rubrics };
});
vi.mock("@/lib/rubrics/blind-room-days", () => ({
  BLIND_ROOM_DAYS: [["2026-10-01", "room_blind"]],
  isBlindRoomDay: (d: string | null, r: string | null) => typeof d === "string" && typeof r === "string" && d.slice(0, 10) === "2026-10-01" && r === "room_blind",
  BlindRoomDayError: class extends Error {},
}));

import { setLabStoreForTests, ENCOUNTER_CATALOG_KEY, type LabStore } from "@/lib/sarvam-lab";
import { resetCatalogCacheForTests } from "@/lib/room-access/readers/catalog-consult";
import { labWritable, labReadable } from "@/lib/sarvam-lab";
import { runRubricSweep, sweepMode, inBackfillWindow, SWEEP_SUMMARY_KEY, SWEEP_ACTOR, SweepReadError, type SweepSummary } from "@/lib/rubrics/sweep";
import { GET } from "@/app/api/cron/rubric-sweep/route";
import { S7_TOOLS } from "@/lib/mcp/tools/s7";
import type { ToolContext } from "@/lib/mcp/registry";
import type { McpScope } from "@/lib/mcp/auth";

const NOW = Date.parse("2026-10-15T08:00:00Z"); // 13:30 IST: outside the backfill window
const HOUR = 3_600_000;
const RB = { id: "rb_alpha", version: "1.0.0", unit: "consult", status: "production" };
const RB2 = { id: "rb_beta", version: "2.1.0", unit: "consult", status: "production" };
const DRAFT = { id: "rb_draft", version: "0.1.0", unit: "consult", status: "draft" };
const WINDOW = { id: "rb_win", version: "1.0.0", unit: "window", status: "production" };

const crow = (uid: string, hoursAgo: number, o: Row = {}, base = NOW): Row => ({
  consult_uid: uid, ist_date: new Date(base - hoursAgo * HOUR + 19_800_000).toISOString().slice(0, 10), room_id: "room_a", t_open: base - hoursAgo * HOUR - 600_000, t_close: base - hoursAgo * HOUR,
  layers: { stt: { r2_key: `k/${uid}/stt.json`, status: "ok" }, translate: { r2_key: `k/${uid}/tr.json`, status: "ok" } }, ...o,
});
const store = new Map<string, { body: string; etag: string | null }>();
const lab: LabStore = { async get(k) { return store.get(k) ?? null; }, async put(k, b) { store.set(k, { body: b, etag: null }); return "ok"; }, async list() { return []; } };
const setCatalog = (rows: Row[]) => store.set(ENCOUNTER_CATALOG_KEY, { body: rows.map((r) => JSON.stringify(r)).join("\n") + "\n", etag: '"e1"' });
const resultsQueries = (id: string) => H.sql.filter((q) => /FROM rubric_result WHERE rubric_id/.test(q.text) && q.values[0] === id);
const keysOf = (i = 0) => (H.submitted[i]!.args as { unit_keys: string[] }).unit_keys;

let logs: string[];
beforeEach(() => {
  H.rubrics.length = 0; H.rubrics.push({ ...RB });
  H.sql = []; H.fsRows = []; H.done = {}; H.doneLab = {}; H.ran = {}; H.today = {}; H.open = null; H.dbThrows = false; H.submitted = []; H.submitThrow = {};
  store.clear(); resetCatalogCacheForTests(); setLabStoreForTests(lab);
  logs = [];
  for (const m of ["log", "warn"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  vi.stubEnv("CRON_SECRET", "cron-secret-for-test");
  vi.stubEnv("RUBRIC_SWEEP_MODE", "");
  vi.stubEnv("RUBRIC_SWEEP_DAILY_UNITS", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); setLabStoreForTests(null); });

const call = (auth: string | null = "Bearer cron-secret-for-test") => GET(new NextRequest("http://localhost/api/cron/rubric-sweep", auth ? { headers: { authorization: auth } } : {}));

describe("the route: auth and mode", () => {
  it("no or wrong bearer is 401, the bare x-vercel-cron header does not authorise, and nothing is read", async () => {
    vi.stubEnv("RUBRIC_SWEEP_MODE", "live");
    expect((await call(null)).status).toBe(401);
    expect((await call("Bearer nope")).status).toBe(401);
    expect((await GET(new NextRequest("http://localhost/x", { headers: { "x-vercel-cron": "1" } }))).status).toBe(401);
    expect(H.sql).toEqual([]);
  });

  it("mode missing, blank or off: skipped sweep_off with NO read (no sql, no catalog, no summary)", async () => {
    setCatalog([crow("CONS000001", 2)]);
    for (const v of ["", "off", "OFF"]) {
      vi.stubEnv("RUBRIC_SWEEP_MODE", v);
      const res = await call();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ skipped: "sweep_off" });
    }
    expect(H.sql).toEqual([]);
    expect(H.submitted).toEqual([]);
    expect(store.has(SWEEP_SUMMARY_KEY)).toBe(false);
  });

  it("an unknown mode is a 500, never off, and reads nothing", async () => {
    for (const v of ["yes", "liv", "1", "true"]) {
      vi.stubEnv("RUBRIC_SWEEP_MODE", v);
      expect((await call()).status).toBe(500);
    }
    expect(() => sweepMode("dryy")).toThrow();
    expect(H.sql).toEqual([]);
  });

  it("dry through the route answers the summary object and submits nothing", async () => {
    vi.stubEnv("RUBRIC_SWEEP_MODE", "dry");
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    setCatalog([crow("CONS000001", 2)]);
    H.fsRows = ["CONS000001"];
    const res = await call();
    vi.useRealTimers();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "dry", backfill_window: false, rubrics: [{ id: "rb_alpha", eligible: 1, done: 0, planned: 1, submitted_job_id: null }] });
    expect(H.submitted).toEqual([]);
  });

  it("a database read failure is PIPELINE_FAILED (500) and nothing is submitted", async () => {
    vi.stubEnv("RUBRIC_SWEEP_MODE", "live");
    setCatalog([crow("CONS000001", 2)]);
    H.dbThrows = true;
    expect((await call()).status).toBe(500);
    expect(H.submitted).toEqual([]);
  });

  it("an unreadable catalog is PIPELINE_FAILED and nothing is submitted", async () => {
    vi.stubEnv("RUBRIC_SWEEP_MODE", "live");
    // no catalog object in the store
    expect((await call()).status).toBe(500);
    expect(H.submitted).toEqual([]);
  });
});

describe("rubrics", () => {
  it("no production consult rubric: skipped no_production_rubric after the registry read only (draft and non-consult rubrics do not count)", async () => {
    H.rubrics.length = 0; H.rubrics.push({ ...DRAFT }, { ...WINDOW });
    setCatalog([crow("CONS000001", 2)]);
    expect(await runRubricSweep("live", { now: NOW })).toEqual({ skipped: "no_production_rubric" });
    expect(H.sql).toEqual([]);
    expect(H.submitted).toEqual([]);
    expect(store.has(SWEEP_SUMMARY_KEY)).toBe(false);
  });
});

const plan = async (mode: "dry" | "live" = "dry", now = NOW) => {
  const out = await runRubricSweep(mode, { now });
  if (!("summary" in out)) throw new Error("no summary");
  return out.summary;
};

describe("eligibility", () => {
  it("blind room-day, before 9 Sep, and no text source are excluded; a translate track or an English-marked stt makes text", async () => {
    setCatalog([
      crow("CONS000001", 2), // ok
      crow("CONS000002", 2, { room_id: "room_blind", ist_date: "2026-10-01" }), // held out (and old: window irrelevant, the rule is the pair)
      crow("CONS000003", 2, { ist_date: "2026-09-08" }), // before the floor
      crow("CONS000004", 2, { layers: { stt: { r2_key: "k/x/stt.json" } } }), // stt only, language unknown: no text
      crow("CONS000005", 2, { layers: { stt: { r2_key: "k/y/stt.json", lang: "en-IN" } } }), // English stt
      crow("CONS000006", 2, { layers: { stt: { r2_key: "k/z/stt.json", lang: "hi-IN" } } }), // native stt only
      crow("CONS000007", 2, { layers: { translate: null, stt: null } }),
    ]);
    H.fsRows = ["CONS000001", "CONS000002", "CONS000003", "CONS000004", "CONS000005", "CONS000006", "CONS000007"];
    const s = await plan();
    expect(s.rubrics[0]!.eligible).toBe(2);
    const live = await runRubricSweep("live", { now: NOW });
    expect("summary" in live).toBe(true);
    expect(keysOf().sort()).toEqual(["CONS000001", "CONS000005"]);
  });

  it("FreeScript settled: a freescript row (any age) makes a recent consult eligible; no row and ended < 24 h ago is not; ended > 24 h ago is, without the row", async () => {
    setCatalog([crow("CONS000011", 2), crow("CONS000012", 3), crow("CONS000013", 30), crow("CONS000014", 23.9)]);
    H.fsRows = ["CONS000011"];
    await runRubricSweep("live", { now: NOW });
    expect(keysOf().sort()).toEqual(["CONS000011", "CONS000013"]);
    // one bounded freescript statement for the whole tick, asked only about consults younger than 24 h
    const fs = H.sql.filter((q) => /FROM freescript_latest/.test(q.text));
    expect(fs).toHaveLength(1);
    expect((fs[0]!.values[0] as string[]).sort()).toEqual(["CONS000011", "CONS000012", "CONS000014"]);
  });

  it("exactly 24 h is not yet settled by age; a consult with no t_close needs the freescript row", async () => {
    setCatalog([crow("CONS000021", 24), crow("CONS000022", 24.01), crow("CONS000023", 2, { t_close: null })]);
    await runRubricSweep("live", { now: NOW });
    expect(keysOf()).toEqual(["CONS000022"]);
  });
});

describe("done-skip", () => {
  it("a consult with a result row for this rubric AND version (any status) is not planned; the other rubric's results do not count", async () => {
    H.rubrics.push({ ...RB2 });
    setCatalog([crow("CONS000031", 30), crow("CONS000032", 31), crow("CONS000033", 32)]);
    H.done = { rb_alpha: ["CONS000031"], rb_beta: ["CONS000032", "CONS000033"] };
    const s = await plan("live");
    expect(keysOf(0).sort()).toEqual(["CONS000032", "CONS000033"]);
    expect(keysOf(1)).toEqual(["CONS000031"]);
    expect(s.rubrics.map((r) => [r.id, r.eligible, r.done, r.planned])).toEqual([["rb_alpha", 3, 1, 2], ["rb_beta", 3, 2, 1]]);
  });

  it("ONE bounded results statement per rubric per tick, never one per consult", async () => {
    H.rubrics.push({ ...RB2 });
    setCatalog(Array.from({ length: 40 }, (_, i) => crow(`CONS0001${String(i).padStart(2, "0")}`, 25 + i / 4)));
    await runRubricSweep("dry", { now: NOW });
    expect(resultsQueries("rb_alpha")).toHaveLength(1);
    expect(resultsQueries("rb_beta")).toHaveLength(1);
    expect((resultsQueries("rb_alpha")[0]!.values[2] as string[]).length).toBe(40);
  });
});

describe("ordering and the backfill window", () => {
  const mixed = () => setCatalog([crow("CONS000041", 60), crow("CONS000042", 5), crow("CONS000043", 47), crow("CONS000044", 1), crow("CONS000045", 49), crow("CONS000046", 100)]);

  it("outside the window only the last 48 h are touched, newest first", async () => {
    mixed();
    H.fsRows = ["CONS000042", "CONS000043", "CONS000044"];
    const s = await plan("live", NOW);
    expect(s.backfill_window).toBe(false);
    expect(keysOf()).toEqual(["CONS000044", "CONS000042", "CONS000043"]);
  });

  it("inside the window the last 48 h come first (newest first), then the backfill newest first", async () => {
    const night = Date.parse("2026-10-15T18:00:00Z"); // 23:30 IST
    setCatalog([crow("CONS000041", 60, {}, night), crow("CONS000042", 5, {}, night), crow("CONS000043", 47, {}, night), crow("CONS000044", 1, {}, night), crow("CONS000045", 49, {}, night), crow("CONS000046", 100, {}, night)]);
    H.fsRows = ["CONS000042", "CONS000044"];
    const s = await runRubricSweep("live", { now: night });
    expect("summary" in s && s.summary.backfill_window).toBe(true);
    expect(keysOf()).toEqual(["CONS000044", "CONS000042", "CONS000043", "CONS000045", "CONS000041", "CONS000046"]);
  });

  it("the window edges in IST: 22:00:00 is in, 21:59:59 is out, 07:00:00 is out, 06:59:59 is in", () => {
    expect(inBackfillWindow(Date.parse("2026-10-15T16:30:00Z"))).toBe(true);  // 22:00:00 IST
    expect(inBackfillWindow(Date.parse("2026-10-15T16:29:59Z"))).toBe(false); // 21:59:59 IST
    expect(inBackfillWindow(Date.parse("2026-10-15T01:30:00Z"))).toBe(false); // 07:00:00 IST
    expect(inBackfillWindow(Date.parse("2026-10-15T01:29:59Z"))).toBe(true);  // 06:59:59 IST
    expect(inBackfillWindow(Date.parse("2026-10-15T18:30:00Z"))).toBe(true);  // 00:00 IST
    expect(inBackfillWindow(Date.parse("2026-10-15T08:00:00Z"))).toBe(false); // 13:30 IST
  });

  it("the backfill is untouched outside the window even when everything recent is done", async () => {
    setCatalog([crow("CONS000051", 60), crow("CONS000052", 70)]);
    const s = await plan("live", NOW);
    expect(s.rubrics[0]).toMatchObject({ eligible: 0, planned: 0, skipped_reason: "nothing_to_do" });
    expect(H.submitted).toEqual([]);
  });
});

describe("one job per rubric, no pile-up, caps", () => {
  it("at most ONE job per rubric per tick with at most 200 explicit unit_keys, lab false, unit consult, actor cron:rubric-sweep, invoke scope", async () => {
    H.rubrics.push({ ...RB2 });
    setCatalog(Array.from({ length: 450 }, (_, i) => crow(`CONS0002${String(i).padStart(3, "0")}`, 30 + i / 100)));
    const s = await plan("live");
    expect(H.submitted).toHaveLength(2);
    for (const j of H.submitted) {
      expect(j).toMatchObject({ kind: "rubric_run", actor: SWEEP_ACTOR });
      expect((j.args as Row).unit_keys).toHaveLength(200);
      expect(j.args).toMatchObject({ unit: "consult", lab: false });
      expect([...(j.scopes as Set<string>)]).toEqual(["invoke"]);
    }
    expect(s.rubrics.map((r) => r.submitted_job_id)).toEqual(["job_rb_alpha", "job_rb_beta"]);
    expect(s.rubrics[0]).toMatchObject({ eligible: 450, planned: 200 });
  });

  it("no pile-up: an open (queued or running) rubric_run for that rubric means no submit for it, the other rubric still goes", async () => {
    H.rubrics.push({ ...RB2 });
    setCatalog([crow("CONS000061", 30)]);
    const { findOpenJob } = await import("@/lib/jobs/store");
    vi.mocked(findOpenJob).mockImplementation(async (_k, match) => (match[0]![1] === "rb_alpha" ? ({ id: "job_open" } as never) : null));
    const s = await plan("live");
    expect(H.submitted.map((j) => (j.args as Row).rubric_id)).toEqual(["rb_beta"]);
    expect(s.rubrics[0]).toMatchObject({ id: "rb_alpha", planned: 0, submitted_job_id: null, skipped_reason: "job_open" });
  });

  it("the daily units cap: today's units count, the job is trimmed to what is left, and at the cap the rubric stops for the day", async () => {
    vi.stubEnv("RUBRIC_SWEEP_DAILY_UNITS", "230");
    H.rubrics.push({ ...RB2 });
    setCatalog(Array.from({ length: 300 }, (_, i) => crow(`CONS0003${String(i).padStart(3, "0")}`, 30 + i / 100)));
    H.today = { rb_alpha: 100, rb_beta: 230 };
    const s = await plan("live");
    expect(keysOf(0)).toHaveLength(130);
    expect(H.submitted).toHaveLength(1);
    expect(s.rubrics[0]).toMatchObject({ planned: 130, today_units: 100 });
    expect(s.rubrics[1]).toMatchObject({ planned: 0, submitted_job_id: null, skipped_reason: "daily_units_cap", today_units: 230 });
    const q = H.sql.find((x) => /FROM rubric_result r JOIN rubric_run u/.test(x.text))!;
    expect(q.values).toContain(SWEEP_ACTOR);
  });

  it("the default daily cap is 1500", async () => {
    setCatalog([crow("CONS000071", 30)]);
    H.today = { rb_alpha: 1500 };
    expect((await plan("live")).rubrics[0]).toMatchObject({ skipped_reason: "daily_units_cap" });
    H.today = { rb_alpha: 1499 };
    expect((await plan("live")).rubrics[0]).toMatchObject({ planned: 1 });
  });

  it("a cap refusal is a counted outcome (llm_cap), not an error, and the other rubric is unaffected; another refusal or a throw is that rubric's reason only", async () => {
    H.rubrics.push({ ...RB2 }, { id: "rb_gamma", version: "1.0.0", unit: "consult", status: "production" });
    setCatalog([crow("CONS000081", 30)]);
    H.submitThrow = { rb_alpha: "llm_daily_cap: today 1 used" };
    H.submitThrow.rb_beta = "explicit_units_required: x";
    const s = await plan("live");
    expect(s.rubrics.map((r) => r.skipped_reason)).toEqual(["llm_cap", "refused:explicit_units_required", null]);
    expect(s.rubrics[2]!.submitted_job_id).toBe("job_rb_gamma");
    expect(JSON.stringify(s)).not.toContain("today 1 used");
  });
});

describe("dry mode and the summary", () => {
  it("dry does every read and count, submits nothing, and writes nothing to the database (only SELECTs)", async () => {
    setCatalog([crow("CONS000091", 30), crow("CONS000092", 31)]);
    H.done = { rb_alpha: ["CONS000092"] };
    const s = await plan("dry");
    expect(H.submitted).toEqual([]);
    expect(H.sql.length).toBeGreaterThan(0);
    for (const q of H.sql) expect(q.text).toMatch(/^SELECT/);
    expect(s.rubrics[0]).toMatchObject({ eligible: 2, done: 1, planned: 1, submitted_job_id: null, skipped_reason: "dry_run" });
  });

  it("the summary has the specified shape, counts and ids only: no consult key, no text", async () => {
    setCatalog([crow("CONS000101", 30), crow("CONS000102", 31)]);
    const out = await runRubricSweep("live", { now: NOW });
    if (!("summary" in out)) throw new Error("no summary");
    const s: SweepSummary = out.summary;
    expect(Object.keys(s).sort()).toEqual(["at", "backfill_window", "mode", "page_capped", "pages", "rubrics"]);
    expect(s.at).toBe(new Date(NOW).toISOString());
    expect(Object.keys(s.rubrics[0]!).sort()).toEqual(["deferred", "done", "eligible", "id", "planned", "skipped_reason", "submitted_job_id", "today_units", "version"]);
    expect(JSON.stringify(s)).not.toMatch(/CONS0001|k\/|room_/);
    expect(logs.join("\n")).not.toMatch(/CONS0001/);
  });

  it("F1: the summary key passes the REAL lab allowlist (read and write), the tick writes it, and sweep_status reads the same constant back", async () => {
    expect(SWEEP_SUMMARY_KEY).toBe("rubric/sweep/1.0.0/last.json");
    expect(labWritable(SWEEP_SUMMARY_KEY)).toBe(true);
    expect(labReadable(SWEEP_SUMMARY_KEY)).toBe(true);
    setCatalog([crow("CONS000111", 30)]);
    const out = await runRubricSweep("dry", { now: NOW });
    expect("summary_written" in out && out.summary_written).toBe(true);
    expect(JSON.parse(store.get(SWEEP_SUMMARY_KEY)!.body)).toEqual("summary" in out ? out.summary : null);
    const tool = S7_TOOLS[0]!;
    const got = (await tool.handler({ action: "sweep_status" }, { actor: "mcp:admin:tester", origin: "https://example.test", scopes: new Set<McpScope>(["read"]) })) as Row;
    expect(got).toEqual({ ok: true, last: "summary" in out ? out.summary : null });
    expect(logs.join("\n")).not.toContain("summary_write_failed");
  });
});

describe("F2: done counts production rows only", () => {
  it("the done statement filters lab = false; a lab row does not make a consult done, a production row does", async () => {
    setCatalog([crow("CONS000131", 30), crow("CONS000132", 31)]);
    H.doneLab = { rb_alpha: ["CONS000131"] };
    H.done = { rb_alpha: ["CONS000132"] };
    const s = await plan("live");
    expect(keysOf()).toEqual(["CONS000131"]);
    expect(s.rubrics[0]).toMatchObject({ eligible: 2, done: 1, planned: 1 });
    expect(resultsQueries("rb_alpha")[0]!.text).toContain("AND lab = false");
  });
});

describe("F3: no starvation, deferred 24 h", () => {
  it("a key from a finished sweep job in the last 24 h that still has no row is deferred (not planned, counted); a key that has its row is done, not deferred; the next keys are reached", async () => {
    setCatalog(Array.from({ length: 5 }, (_, i) => crow(`CONS00014${i}`, 30 + i)));
    H.ran = { rb_alpha: ["CONS000140", "CONS000141", "CONS000142"] };
    H.done = { rb_alpha: ["CONS000141"] };
    const s = await plan("live");
    expect(keysOf()).toEqual(["CONS000143", "CONS000144"]);
    expect(s.rubrics[0]).toMatchObject({ eligible: 5, done: 1, deferred: 2, planned: 2 });
  });

  it("ONE bounded scribe_job statement per rubric per tick: kind rubric_run, actor cron:rubric-sweep, this rubric, done or failed, finished within 24 h, only the page's keys", async () => {
    H.rubrics.push({ ...RB2 });
    setCatalog([crow("CONS000151", 30), crow("CONS000152", 31)]);
    await runRubricSweep("dry", { now: NOW });
    const q = H.sql.filter((x) => /FROM scribe_job j/.test(x.text));
    expect(q).toHaveLength(2);
    expect(q[0]!.text).toContain("j.kind = 'rubric_run'");
    expect(q[0]!.text).toContain("j.status IN ('done', 'failed')");
    expect(q[0]!.text).toContain("j.finished_at > now() - make_interval(hours => ?::int)");
    expect(q.map((x) => x.values.slice(0, 3))).toEqual([[SWEEP_ACTOR, "rb_alpha", 24], [SWEEP_ACTOR, "rb_beta", 24]]);
    expect(q[0]!.values[3]).toEqual(["CONS000151", "CONS000152"]);
  });

  it("when every candidate is deferred nothing is planned and the reason is nothing_to_do", async () => {
    setCatalog([crow("CONS000161", 30)]);
    H.ran = { rb_alpha: ["CONS000161"] };
    const s = await plan("live");
    expect(s.rubrics[0]).toMatchObject({ eligible: 1, deferred: 1, planned: 0, skipped_reason: "nothing_to_do" });
    expect(H.submitted).toEqual([]);
  });
});

describe("R1: paged walk, no starvation of the backfill", () => {
  const night = Date.parse("2026-10-15T18:00:00Z"); // 23:30 IST, backfill window open
  const uidAt = (i: number) => `CONS${String(i).padStart(7, "0")}`;

  it("5,001 consults, the newest 5,000 done, in the backfill window: the oldest is planned, in page 2; every statement stays within one page", async () => {
    setCatalog(Array.from({ length: 5001 }, (_, i) => crow(uidAt(i), 25 + i * 0.01, {}, night)));
    H.done = { rb_alpha: Array.from({ length: 5000 }, (_, i) => uidAt(i)) };
    const out = await runRubricSweep("live", { now: night });
    if (!("summary" in out)) throw new Error("no summary");
    expect(keysOf()).toEqual([uidAt(5000)]);
    expect(out.summary).toMatchObject({ pages: 2, page_capped: false, backfill_window: true });
    expect(out.summary.rubrics[0]).toMatchObject({ eligible: 5001, done: 5000, planned: 1 });
    for (const q of resultsQueries("rb_alpha")) expect((q.values[2] as string[]).length).toBeLessThanOrEqual(5000);
    expect(resultsQueries("rb_alpha")).toHaveLength(2);
  });

  it("a job's worth (200) found on page 1 stops the walk: one page, one statement set, not capped", async () => {
    setCatalog(Array.from({ length: 300 }, (_, i) => crow(uidAt(i), 25 + i * 0.01, {}, night)));
    const out = await runRubricSweep("dry", { now: night, pageSize: 250 });
    if (!("summary" in out)) throw new Error("no summary");
    expect(out.summary).toMatchObject({ pages: 1, page_capped: false });
    expect(out.summary.rubrics[0]).toMatchObject({ planned: 200, eligible: 300 });
  });

  it("page_capped is true when the 4-page limit stops the walk with candidates left and a rubric still short", async () => {
    setCatalog(Array.from({ length: 41 }, (_, i) => crow(uidAt(i), 25 + i * 0.01, {}, night)));
    H.done = { rb_alpha: Array.from({ length: 41 }, (_, i) => uidAt(i)) };
    const out = await runRubricSweep("dry", { now: night, pageSize: 10 });
    if (!("summary" in out)) throw new Error("no summary");
    expect(out.summary).toMatchObject({ pages: 4, page_capped: true });
    expect(out.summary.rubrics[0]).toMatchObject({ eligible: 41, done: 40, planned: 0 });
    expect(resultsQueries("rb_alpha")).toHaveLength(4);
  });

  it("page_capped is false when the list ends inside the limit (exactly 40 candidates, 4 pages of 10)", async () => {
    setCatalog(Array.from({ length: 40 }, (_, i) => crow(uidAt(i), 25 + i * 0.01, {}, night)));
    H.done = { rb_alpha: Array.from({ length: 40 }, (_, i) => uidAt(i)) };
    const out = await runRubricSweep("dry", { now: night, pageSize: 10 });
    if (!("summary" in out)) throw new Error("no summary");
    expect(out.summary).toMatchObject({ pages: 4, page_capped: false });
  });

  it("an open job or a spent day means no walk at all for that rubric (no statements beyond today / open-job)", async () => {
    setCatalog([crow("CONS000999", 30)]);
    H.today = { rb_alpha: 1500 };
    const out = await runRubricSweep("dry", { now: NOW });
    if (!("summary" in out)) throw new Error("no summary");
    expect(out.summary.pages).toBe(0);
    expect(resultsQueries("rb_alpha")).toHaveLength(0);
  });
});

describe("A1: a production rubric whose units include consult is swept as unit consult", () => {
  it("a talk_time-shaped rubric (primary unit window, units [consult]) is swept; a rubric without consult in units is not", async () => {
    H.rubrics.length = 0;
    H.rubrics.push({ id: "rb_tt", version: "1.0.0", unit: "window", units: ["consult"], status: "production" }, { ...WINDOW });
    setCatalog([crow("CONS000171", 30)]);
    const s = await plan("live");
    expect(s.rubrics.map((r) => r.id)).toEqual(["rb_tt"]);
    expect(H.submitted).toHaveLength(1);
    expect(H.submitted[0]!.args).toMatchObject({ rubric_id: "rb_tt", unit: "consult", lab: false, unit_keys: ["CONS000171"] });
  });
});

describe("scribe_rubric sweep_status", () => {
  const ctx: ToolContext = { actor: "mcp:admin:tester", origin: "https://example.test", scopes: new Set<McpScope>(["read"]) };
  const tool = S7_TOOLS[0]!;
  const status = async () => (await tool.handler({ action: "sweep_status" }, ctx)) as Row;

  it("returns last:null when no summary exists", async () => {
    expect(await status()).toEqual({ ok: true, last: null });
  });

  it("returns the stored summary as written", async () => {
    const s: SweepSummary = { at: "2026-10-15T08:00:00.000Z", mode: "live", backfill_window: false, rubrics: [{ id: "rb_alpha", version: "1.0.0", eligible: 3, done: 1, planned: 2, submitted_job_id: "job_x", skipped_reason: null, today_units: 5 }] };
    store.set(SWEEP_SUMMARY_KEY, { body: JSON.stringify(s), etag: null });
    expect(await status()).toEqual({ ok: true, last: s });
  });

  it("is read scope, listed in the enum and the description; a corrupt object is last:null", async () => {
    expect(tool.scope).toBe("read");
    expect((tool.inputSchema as { properties: { action: { enum: string[] } } }).properties.action.enum).toContain("sweep_status");
    expect(tool.description).toContain("sweep_status");
    store.set(SWEEP_SUMMARY_KEY, { body: "{nope", etag: null });
    expect(await status()).toEqual({ ok: true, last: null });
  });
});

describe("misc", () => {
  it("vercel.json schedules it every 10 minutes", async () => {
    const cfg = JSON.parse((await import("node:fs")).readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    expect(cfg.crons.filter((c) => c.path === "/api/cron/rubric-sweep")).toEqual([{ path: "/api/cron/rubric-sweep", schedule: "*/10 * * * *" }]);
  });

  it("a read failure is a SweepReadError and nothing is submitted, even for the first rubric", async () => {
    H.rubrics.push({ ...RB2 });
    setCatalog([crow("CONS000121", 30)]);
    H.dbThrows = true;
    await expect(runRubricSweep("live", { now: NOW })).rejects.toBeInstanceOf(SweepReadError);
    expect(H.submitted).toEqual([]);
  });
});
