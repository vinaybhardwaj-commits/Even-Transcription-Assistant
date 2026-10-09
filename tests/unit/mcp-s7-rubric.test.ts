/**
 * Operator MCP S7-0 — scribe_rubric. sql, the job store and the lab store are mocked; no model, no Sarvam, no production, no Pulse.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const statements: Array<{ text: string; values: unknown[] }> = [];
let answer: (text: string, values: unknown[]) => unknown = () => [];
vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    statements.push({ text, values });
    const out = answer(text, values);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});
const inserted: Row[] = [];
vi.mock("@/lib/jobs/store", async (orig) => ({
  ...((await orig()) as object),
  insertJob: vi.fn(async (i: { id: string; kind: string; args: Row }) => { inserted.push(i); return { id: "job_new1", kind: i.kind, status: "queued" }; }),
  findOpenJob: vi.fn(async () => null),
  insertJobCapped: vi.fn(async (i: { id: string; kind: string; args: Row }) => { inserted.push(i); return { id: "job_new1", kind: i.kind, status: "queued" }; }),
}));

const S = await import("@/lib/mcp/surface");
const P = await import("@/lib/mcp/profile");
const L = await import("@/lib/sarvam-lab");
const tool = () => S.CALLABLE_TOOLS.get("scribe_rubric")!;
const ctxFor = (scopes: string[]) => ({ origin: "https://x", actor: "mcp:test", scopes: new Set(scopes) }) as never;
const run = async (args: Row, scopes = ["read", "invoke"]) => (await tool().handler(args, ctxFor(scopes))) as Row;
const writes = () => statements.filter((s) => /\b(INSERT|UPDATE|DELETE)\b/i.test(s.text));
const mem = new Map<string, string>();

beforeEach(() => {
  statements.length = 0; inserted.length = 0; mem.clear(); answer = () => [];
  L.setLabStoreForTests({ get: async (k) => (mem.has(k) ? { body: mem.get(k)!, etag: "e" } : null), put: async (k, b) => { mem.set(k, b); return "ok"; }, list: async () => [] });
});

describe("registration", () => {
  it("one listed tool, read-scope gate, not read-only, no destructive or open-world hint; the brief fits and says read / write / room / UTC", () => {
    const t = tool();
    expect(t.scope).toBe("read");
    expect(S.LAB_TOOLS.includes(t)).toBe(true);
    expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    const listed = P.listedTools().find((x) => x.name === "scribe_rubric")!;
    expect(listed.description.length).toBeLessThanOrEqual(P.LISTED_PLAIN_MAX_CHARS);
    expect(listed.description).toMatch(/UTC/);
    expect(listed.description).toMatch(/invoke/);
    expect(listed.description).toMatch(/touches no room/);
    expect(Object.keys((t.inputSchema as { properties: Row }).properties).length).toBeLessThanOrEqual(13);
  });
  it("the two job kinds are registered with invoke scope", async () => {
    const { KIND_BY_NAME } = await import("@/lib/jobs/kinds");
    expect(KIND_BY_NAME.get("rubric_run")!.scope).toBe("invoke");
    expect(KIND_BY_NAME.get("rubric_bench")!.scope).toBe("invoke");
  });
});

describe("read actions", () => {
  it("list: every rubric with its status, engine, units, inputs and bench; filter by status; describe returns the file and recent runs; unknown_rubric", async () => {
    const all = await run({ action: "list" }, ["read"]);
    expect((all.rubrics as Row[]).map((r) => r.id)).toEqual(["room_mic_quality", "talk_time", "consult_chair_affect", "consult_surgical_pitch", "ehrc_surgical_outcome", "care_sentiment", "encounter_vs_record"]);
    expect((all.rubrics as Row[])[1]).toMatchObject({ id: "talk_time", units: ["window", "consult"], engine: "code", status: "draft", inputs: ["turns", "consult_span"] });
    expect((await run({ action: "list", status: "production" }, ["read"])).rubrics).toEqual([]);
    answer = (t) => (/FROM rubric_run/.test(t) ? [{ run_id: "rub_1", kind: "bench" }] : []);
    const d = await run({ action: "describe", rubric_id: "room_mic_quality" }, ["read"]);
    expect(d).toMatchObject({ ok: true, rubric: { id: "room_mic_quality", version: "0.1.0" }, recent_runs: [{ run_id: "rub_1" }] });
    expect((d.rubric as Row).definition).toBeDefined();
    expect(await run({ action: "describe", rubric_id: "nope" }, ["read"])).toEqual({ ok: false, error: "unknown_rubric" });
    expect(await run({ action: "describe" }, ["read"])).toEqual({ ok: false, error: "unknown_rubric" });
    expect(await run({ action: "zap" }, ["read"])).toMatchObject({ ok: false, error: "unknown_action" });
    expect(writes()).toEqual([]);
  });
  it("results: bound filters, evidence_key pointers, no evidence unless include_text (and then at most 20 rows)", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ rubric_id: "talk_time", unit_key: `w${i}`, room_id: "r1", ist_date: "2026-10-01", status: "ok", score: { evidence_key: `rubric/talk_time/0.1.0/w${i}.json`, doctor_share: 0.5 }, findings: [] }));
    answer = (t) => (/FROM rubric_result/.test(t) ? rows : []);
    for (let i = 0; i < 25; i++) mem.set(`rubric/talk_time/0.1.0/w${i}.json`, JSON.stringify({ unit_key: `w${i}`, evidence: { turns: i } }));
    const plain = await run({ action: "results", rubric_id: "talk_time", rooms: ["r1"], from: "2026-10-01", to: "2026-10-08", lab: true, status: "ok", limit: 200 }, ["read"]);
    expect(plain.count).toBe(25);
    expect((plain.results as Row[])[0]).toMatchObject({ evidence_key: "rubric/talk_time/0.1.0/w0.json" });
    expect((plain.results as Row[])[0]!.evidence).toBeUndefined();
    const q = statements.find((s) => /FROM rubric_result/.test(s.text))!;
    expect(q.values).toEqual(expect.arrayContaining(["talk_time", "r1", "2026-10-01", "2026-10-08", true, "ok", 200]));
    const full = await run({ action: "results", rubric_id: "talk_time", include_text: true }, ["read"]);
    expect(full).toMatchObject({ evidence_fetched: 20, evidence_cap: 20 });
    expect((full.results as Row[]).filter((r) => r.evidence).length).toBe(20);
    expect(((full.results as Row[])[3]!.evidence as Row).unit_key).toBe("w3");
    expect(await run({ action: "results", from: "10/08/2026" }, ["read"])).toMatchObject({ ok: false, error: "bad_date" });
  });
  it("runs: the history, limited", async () => {
    answer = (t) => (/FROM rubric_run/.test(t) ? [{ run_id: "rub_1" }] : []);
    expect(await run({ action: "runs", rubric_id: "talk_time", limit: 5 }, ["read"])).toMatchObject({ ok: true, runs: [{ run_id: "rub_1" }] });
  });
});

describe("run and bench", () => {
  it("a read-only token cannot queue anything (invoke is enforced by the job kind); the rubric_id is required", async () => {
    await expect(run({ action: "run", rubric_id: "talk_time", lab: true, unit_keys: ["w1"] }, ["read"])).rejects.toThrow();
    await expect(run({ action: "bench", rubric_id: "talk_time" }, ["read"])).rejects.toThrow();
    expect(inserted).toEqual([]);
    expect(await run({ action: "run" })).toEqual({ ok: false, error: "rubric_id_required" });
  });
  it("closed refusals, nothing queued: lab_required, explicit_units_required, engine_not_available, unit_not_supported, unknown_rubric, bad args", async () => {
    expect(await run({ action: "run", rubric_id: "talk_time" })).toMatchObject({ ok: false, error: "lab_required" });
    expect(await run({ action: "run", rubric_id: "talk_time", lab: true })).toMatchObject({ ok: false, error: "explicit_units_required" });
    expect(await run({ action: "run", rubric_id: "care_sentiment", lab: true, unit_keys: ["x"] })).toMatchObject({ ok: false, error: "engine_not_available" });
    expect(await run({ action: "run", rubric_id: "talk_time", lab: true, unit: "room_hour", unit_keys: ["x"] })).toMatchObject({ ok: false, error: "unit_not_supported" });
    expect(await run({ action: "run", rubric_id: "nope", lab: true })).toMatchObject({ ok: false, error: "unknown_rubric" });
    expect(await run({ action: "run", rubric_id: "talk_time", lab: true, unit_keys: [] })).toMatchObject({ ok: false, error: "bad_args" });
    expect(await run({ action: "bench", rubric_id: "care_sentiment" })).toMatchObject({ ok: false, error: "engine_not_available" });
    expect(inserted).toEqual([]);
  });
  it("a lab run of a draft with explicit units queues rubric_run with the parsed args; bench queues rubric_bench; neither writes a result", async () => {
    const r = await run({ action: "run", rubric_id: "room_mic_quality", lab: true, unit_keys: ["r1:2026-10-08:10"] });
    expect(r).toEqual({ ok: true, job_id: "job_new1", kind: "rubric_run", status: "queued" });
    expect(inserted[0]).toMatchObject({ kind: "rubric_run", args: { rubric_id: "room_mic_quality", lab: true, unit: "room_hour", unit_keys: ["r1:2026-10-08:10"], limit: 200 } });
    expect(await run({ action: "bench", rubric_id: "talk_time" })).toMatchObject({ ok: true, kind: "rubric_bench" });
    expect(inserted[1]).toMatchObject({ kind: "rubric_bench", args: { rubric_id: "talk_time" } });
    expect(writes()).toEqual([]);
  });
});

describe("S71-R4 G71 — a cost ceiling for llm_zdr rubrics, refused at submit", () => {
  const keys = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);
  const withEnv = async (env: Record<string, string>, f: () => Promise<void>) => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    try { await f(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  };
  it("per-job ceiling: more units than the cap is llm_job_cap with its numbers; a code rubric is never capped", async () => {
    await withEnv({ RUBRIC_LLM_JOB_CALL_CAP: "5" }, async () => {
      const r = await run({ action: "run", rubric_id: "consult_chair_affect", lab: true, unit_keys: keys(6) });
      expect(r).toMatchObject({ ok: false, error: "llm_job_cap" });
      expect(String(r.detail)).toContain("needs 6 calls, per-job cap 5");
      expect(inserted).toEqual([]);
      expect(await run({ action: "run", rubric_id: "consult_chair_affect", lab: true, unit_keys: keys(5) })).toMatchObject({ ok: true });
      expect(await run({ action: "run", rubric_id: "talk_time", lab: true, unit_keys: keys(30) })).toMatchObject({ ok: true }); // engine code: no model call, no cap
    });
  });
  it("per-day ceiling counts calls already made, runs still open (their reservation) and calls reserved by QUEUED jobs; refused with the three numbers", async () => {
    await withEnv({ RUBRIC_LLM_DAILY_CALL_CAP: "100" }, async () => {
      answer = (t) => (/FROM rubric_run/.test(t) ? [{ n: 60 }] : /FROM scribe_job/.test(t) ? [{ n: 65 }] : []); // the queued reservation is summed in SQL: 25 unit_keys + 40 (the human_v bench worst case); the code rubric counts 0
      // used 60 + queued 65 = 125 already over 100
      let r = await run({ action: "run", rubric_id: "consult_chair_affect", lab: true, unit_keys: keys(1) });
      expect(r).toMatchObject({ ok: false, error: "llm_daily_cap" });
      expect(String(r.detail)).toMatch(/today 60 used \+ 65 queued \+ 1 planned > daily cap 100/);
      answer = (t) => (/FROM rubric_run/.test(t) ? [{ n: 60 }] : []);
      expect(await run({ action: "run", rubric_id: "consult_chair_affect", lab: true, unit_keys: keys(40) })).toMatchObject({ ok: true }); // 60 + 40 = 100: at the cap is allowed
      r = await run({ action: "run", rubric_id: "consult_chair_affect", lab: true, unit_keys: keys(41) });
      expect(r).toMatchObject({ ok: false, error: "llm_daily_cap" });
      expect(r.detail).toMatch(/today 60 used \+ 0 queued \+ 41 planned/);
      expect(await run({ action: "bench", rubric_id: "consult_surgical_pitch", set: "grokbot_agreement" })).toMatchObject({ ok: false, error: "llm_daily_cap" }); // estimate 200 > the day's room
    });
  });
  it("the defaults are 600 per job and 2000 per day, bad env falls back, and the calls a running job may still make exclude its own reservation", async () => {
    const C = await import("@/lib/rubrics/llm-cap");
    expect([C.DEFAULT_JOB_CALL_CAP, C.DEFAULT_DAILY_CALL_CAP]).toEqual([600, 2000]);
    expect([C.jobCallCap({}), C.dailyCallCap({}), C.jobCallCap({ RUBRIC_LLM_JOB_CALL_CAP: "bad" }), C.dailyCallCap({ RUBRIC_LLM_DAILY_CALL_CAP: "-4" })]).toEqual([600, 2000, 600, 2000]);
    answer = (t) => (/FROM rubric_run/.test(t) ? [{ n: 100 }] : []);
    expect(await C.callsLeft(20, 0, { RUBRIC_LLM_DAILY_CALL_CAP: "150" })).toBe(70); // the day shows 100 including this job's own reservation (20): the others used 80
    expect(await C.callsLeft(20, 30, { RUBRIC_LLM_DAILY_CALL_CAP: "150" })).toBe(40); // 30 already made by this job
    expect(await C.callsLeft(100, 590, {})).toBe(10); // the job ceiling binds
  });
});
