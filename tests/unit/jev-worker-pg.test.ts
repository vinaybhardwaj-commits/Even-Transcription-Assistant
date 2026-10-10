/**
 * Jev worker P1 on a REAL postgres:16 with EVERY migration applied (0149 applied TWICE). Jev is MOCKED: the client is a script, there is no network and no
 * real call. Window/subject ids only; the one distinctive string below ("ZZ-TEXT-ZZ") stands for transcript text and must never reach a row or `progress`.
 *
 * P1.1 migration, CHECK drift, backfill, the legacy writer.   P1.2 sync, hash, status moves.   P1.3 the jev_ask step machine, replay, no text, mock rows.
 * P1.4 fault injection per class, breaker, budget, the atomic cap (3 concurrent submits, with a CONTROL that must overshoot), slots.
 * P1.5 sweeper and nudges.   P1.6 MCP tools and scribe_usage.   P1.7 the drift job.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

// Many tests here run several docker/psql round trips: a per-FILE timeout (not the global one) keeps them deterministic under load.
vi.setConfig({ testTimeout: 120_000 });
import { execFile, execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({
  pg: null as null | { sql: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>; name: string },
  dropLock: false, dwell: false,
  calls: [] as Array<{ questions: Record<string, { type: string; criteria?: Record<string, string> }>; state: unknown; model?: string }>,
  script: null as null | ((req: { questions: Record<string, { type: string; criteria?: Record<string, string> }>; state: unknown; model?: string }) => unknown),
  sqlCalls: 0,
}));

const quote = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (Array.isArray(v)) return `'{${v.map((e) => `"${String(e).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}'`;
  return `'${(v instanceof Date ? v.toISOString() : String(v)).replace(/'/g, "''")}'`;
};
const render = (text: string, values: unknown[]): string => text.replace(/\$(\d+)/g, (_m, n) => quote(values[Number(n) - 1]));

vi.mock("@/lib/db", () => {
  const lazy = (strings: TemplateStringsArray, values: unknown[]) => {
    let text = "";
    strings.forEach((s, i) => { text += s + (i < values.length ? `$${i + 1}` : ""); });
    return { text, values, then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { H.sqlCalls += 1; return H.pg!.sql(strings, ...values).then(res, rej); } };
  };
  const sql = Object.assign((s: TemplateStringsArray, ...v: unknown[]) => lazy(s, v), {
    transaction: (qs: Array<{ text: string; values: unknown[] }>) => new Promise<unknown[]>((resolve, reject) => {
      H.sqlCalls += 1;
      const parts = qs.map((q) => render(q.text, q.values).trim().replace(/;\s*$/, ""));
      const last = parts.length - 1;
      const returning = /\bRETURNING\b/i.test(parts[last]!);
      const body = parts.map((p, i) => {
        if (i === 0 && H.dropLock && /advisory/i.test(p)) return "SELECT 1";
        if (i === last && returning) return `WITH u AS (${p}) SELECT coalesce(jsonb_agg(u), '[]'::jsonb) FROM u${H.dwell ? ";\nSELECT pg_sleep(0.6)" : ""}`;
        return p;
      }).join(";\n");
      const child = execFile("docker", ["exec", "-i", H.pg!.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        const lines = stdout.trim().split("\n").filter(Boolean);
        const rows = returning ? (JSON.parse(lines[lines.length - 1] ?? "[]") as unknown[]) : [];
        resolve([...parts.slice(0, last).map(() => []), rows]);
      });
      child.stdin!.end(`BEGIN;\n${body};\nCOMMIT;\n`);
    }),
  });
  return { sql };
});
vi.mock("@/lib/jev/client", () => ({
  getJevClient: () => ({
    async systemOne(req: { questions: Record<string, { type: string; criteria?: Record<string, string> }>; state: unknown; model?: string }) {
      H.calls.push(req);
      if (H.script) return H.script(req);
      return defaultResult(req);
    },
  }),
  _resetJevClientForTests: () => undefined,
}));
vi.mock("@/lib/brain/db", () => ({
  query: async (text: string, values: unknown[] = []) => {
    const rendered = render(text, values);
    const out = execFileSync("docker", ["exec", "-i", H.pg!.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
      { input: `SELECT coalesce(jsonb_agg(q), '[]'::jsonb) FROM (${rendered.trim().replace(/;\s*$/, "")}) q;`, encoding: "utf8" });
    return { rows: JSON.parse(out.trim().split("\n").pop()!) };
  },
}));
vi.mock("@/lib/jobs/submit", () => ({ submitJob: vi.fn() }));

function defaultResult(req: { questions: Record<string, { type: string; criteria?: Record<string, string> }> }) {
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(req.questions)) {
    if (q.type === "noul") answers[id] = { type: "noul", noul: 0.8 };
    else if (q.type === "choice") {
      const keys = Object.keys(q.criteria!);
      const probs: Record<string, number> = {};
      keys.forEach((k, i) => { probs[k] = i === 0 ? 0.7 : 0.3 / (keys.length - 1); });
      answers[id] = { type: "choice", choice: keys[0], probabilities: probs, confidence: 0.7 };
    }
  }
  return { model: process.env.ETA_JEV_MOCK ? "jev-mock" : "jev-1.13.0", answers, usage: { input_tokens: 1000, output_tokens: 20 }, latency_ms: 40 };
}

import { askBatch, USE_FLAG } from "@/lib/jev/worker/flags";
import { _clearUsesForTests, registerUse } from "@/lib/jev/worker/uses";
import { syncQuestionSets, moveStatus } from "@/lib/jev/worker/sync";
import { QUESTION_SET_FILES } from "@/jev/question-sets";
import { JEV_SUBJECT_TYPES, JevHttpError } from "@/lib/jev/types";
import { insertJevDecisions } from "@/lib/jev/decision-store";
import { jevAskKind, parseJevAskArgs } from "@/lib/jobs/kinds/jev-ask";
import { jevDriftKind } from "@/lib/jobs/kinds/jev-drift";
import { breakerAdmit, getBreaker, recordOutcome } from "@/lib/jev/worker/breaker";
import { JEV_SUBMIT_LOCK_KEY, submitJevAskCapped } from "@/lib/jev/worker/budget";
import { claimSlot, GLOBAL_SLOTS } from "@/lib/jev/worker/slots";
import { sweepJev, sweepUse } from "@/lib/jev/worker/sweeper";
import { nudgeJev } from "@/lib/jev/worker/nudge";
import { JEV_TOOLS } from "@/lib/mcp/tools/jev";
import { META_TOOLS } from "@/lib/mcp/tools/meta";
import type { StepContext, StepOutcome } from "@/lib/jobs/types";
import type { ToolContext } from "@/lib/mcp/registry";

const HAVE = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-jev-worker");
const SECRET_TEXT = "ZZ-TEXT-ZZ";
const ALL = readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort();
const mig = (f: string) => readFileSync(`db/migrations/${f}`, "utf8");
const rows = async (q: TemplateStringsArray, ...v: unknown[]) => (await H.pg!.sql(q, ...v)) as Array<Record<string, any>>;
const ctx: ToolContext = { origin: "https://preview.example", actor: "test-actor", scopes: new Set(["read"]) };
const tool = (name: string) => [...JEV_TOOLS, ...META_TOOLS].find((t) => t.name === name)!;

const FLAGS = ["JEV_SLOT_WAIT_MS", "ETA_JEV_MODEL", "JEV_WORKER_ENABLED", "ETA_JEV_TEXT_LANE", "ETA_JEV_MOCK", "ETA_JEV_ENABLED", "JEV_STATE_HMAC_KEY", "JEV_DAILY_USD_CAP", "JEV_STT_QUALITY_LIVE", ...Object.values(USE_FLAG)];
const env = (o: Record<string, string>) => Object.assign(process.env, o);
afterEach(() => { for (const k of FLAGS) delete process.env[k]; H.script = null; H.calls.length = 0; H.dropLock = false; H.dwell = false; });
const ON = { JEV_WORKER_ENABLED: "1", ETA_JEV_TEXT_LANE: "1", JEV_USE_STT_QUALITY: "1" };

const SUBJECTS = ["run_a", "run_b", "run_c"];
const argsFor = (mode: string, extra: Record<string, unknown> = {}) => parseJevAskArgs({ use: "stt_quality", mode, set_id: "smoke", version: "v0", ...extra });
let jobN = 0;
const mkCtx = (step: string, args: Record<string, unknown>, progress: Record<string, unknown>): StepContext => ({
  job: { id: `job_t${++jobN}`, kind: "jev_ask", args, status: "running", step, progress, result: null, error: null, actor: "test", created_at: "", started_at: "", updated_at: "", finished_at: null, lease_until: null, lease_owner: null, attempts: 1, failures: 0 },
  step, args, progress,
});
/** Runs the step machine to its end. A throw is returned, not raised, so a test can read the message and the progress_patch. */
async function runJob(args: Record<string, unknown>, jobId?: string): Promise<{ out?: StepOutcome; thrown?: Error & { progress_patch?: Record<string, unknown> }; steps: string[]; lastProgress: Record<string, unknown> }> {
  let step = "plan"; let progress: Record<string, unknown> = {}; const steps: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    steps.push(step);
    const c = mkCtx(step, args, progress);
    if (jobId) c.job.id = jobId;
    let out: StepOutcome;
    try { out = await jevAskKind.run(c); } catch (e) { return { thrown: e as Error & { progress_patch?: Record<string, unknown> }, steps, lastProgress: progress }; }
    if (out.kind !== "next") return { out, steps, lastProgress: progress };
    step = out.step; progress = out.progress;
  }
  throw new Error("job did not finish in 40 steps");
}

const suite = HAVE || !ALLOW_SKIP ? describe : describe.skip;

suite("the Jev worker on postgres:16", () => {
  beforeAll(async () => {
    if (!HAVE) throw new Error("docker is required (set ETA_ALLOW_SKIP_E2E=1 to skip)");
    pg.start();
    H.pg = pg as never;
    pg.exec(`CREATE ROLE brain_svc NOLOGIN;`);
    for (const f of ALL) if (!f.startsWith("0149_")) pg.exec(mig(f));
    // legacy rows BEFORE 0149: the backfill and the legacy writer's key
    pg.exec(`INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, answer) VALUES ('jd_legacy1', 'probe', 'pr_1', 'u1_phase', 'u1-phase-w1', 'jev-1.13.0', '{"type":"choice","choice":"history","probabilities":{"history":1},"confidence":1}');`);
    pg.exec(mig("0149_jev_worker.sql"));
    pg.exec(mig("0149_jev_worker.sql"));   // twice, cleanly
    _clearUsesForTests();
    registerUse({
      use: "stt_quality", setId: "smoke", subjectType: "stt_run",
      eligible: async () => SUBJECTS,
      build: async (id) => (id === "run_big" ? { tooLarge: true, bytes: 250_000 } : { state: { text: `${SECRET_TEXT} ${id}` }, evidence: { stt_run_ids: [id] }, lane: "text" }),
    });
  }, 300_000);
  afterAll(() => pg.stop());

  // ── P1.1 ───────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("P1.1 — the migration", () => {
    it("applies twice cleanly and creates every table, view and the worker key", async () => {
      const t = await rows`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'jev\\_%' ORDER BY 1`;
      const names = t.map((r) => r.table_name);
      for (const n of ["jev_question_set", "jev_question", "jev_question_set_event", "jev_call", "jev_gold_label", "jev_breaker", "jev_drift_report", "jev_slot", "jev_decision_current", "jev_cost_day"]) expect(names, n).toContain(n);
      const idx = await rows`SELECT indexname FROM pg_indexes WHERE tablename = 'jev_decision'`;
      expect(idx.map((r) => r.indexname)).toEqual(expect.arrayContaining(["uq_jev_decision_legacy_key", "uq_jev_decision_worker_key"]));
      expect(idx.map((r) => r.indexname)).not.toContain("uq_jev_decision_subject_question_version");
      const g = await rows`SELECT table_name FROM information_schema.role_table_grants WHERE grantee = 'brain_svc' AND table_name LIKE 'jev\\_%' ORDER BY 1`;
      expect(g.map((r) => r.table_name), "only 0144's three tables are granted; 0149 grants nothing").toEqual(["jev_decision", "jev_window_signal", "jev_window_text"]);
    });
    it("the subject_type CHECK is exactly JEV_SUBJECT_TYPES (drift test), pitch included", async () => {
      const c = await rows`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'jev_decision_subject_type_chk'`;
      const inDb = [...String(c[0]!.def).matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
      expect(inDb).toEqual([...JEV_SUBJECT_TYPES].sort());
      expect(inDb).toContain("pitch");
    });
    it("legacy rows are backfilled question_set_id = 'legacy:<prompt_version>' and nothing else changed", async () => {
      const r = await rows`SELECT question_set_id, question_set_sha256, mock FROM jev_decision WHERE id = 'jd_legacy1'`;
      expect(r[0]).toMatchObject({ question_set_id: "legacy:u1-phase-w1", question_set_sha256: null, mock: false });
    });
    it("the existing askJev path still writes: the legacy writer upserts on the PARTIAL key (second write = same row)", async () => {
      const row = { subjectType: "probe" as const, subjectId: "pr_2", questionId: "u1_phase", promptVersion: "u1-phase-w1", model: "jev-1.13.0", answer: { type: "noul", noul: 0.5 }, probabilities: null, confidence: 0.5, latencyMs: 5, inputTokens: 9 };
      expect(await insertJevDecisions([row])).toMatchObject({ ok: true, written: 1 });
      expect(await insertJevDecisions([{ ...row, confidence: 0.6 }])).toMatchObject({ ok: true });
      const r = await rows`SELECT confidence FROM jev_decision WHERE subject_id = 'pr_2'`;
      expect(r.length).toBe(1);
      expect(r[0]!.confidence).toBeCloseTo(0.6, 3);
    });
  });

  // ── P1.2 ───────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("P1.2 — sync and status", () => {
    it("sync is idempotent: inserted, then unchanged; the DB mirror holds the questions", async () => {
      expect((await syncQuestionSets()).map((s) => s.result)).toEqual(["inserted"]);
      expect((await syncQuestionSets()).map((s) => s.result)).toEqual(["unchanged"]);
      const q = await rows`SELECT question_id, kind, option_order FROM jev_question WHERE question_set_id = 'smoke' ORDER BY question_id`;
      expect(q.map((r) => r.question_id)).toEqual(["is_greeting", "tone"]);
      const s = await rows`SELECT status, model_pin FROM jev_question_set WHERE id = 'smoke'`;
      expect(s[0]).toMatchObject({ status: "draft", model_pin: "jev-1.13.0" });
    });
    it("a changed wording under the same version is REFUSED (hash_changed), nothing is rewritten", async () => {
      const f = JSON.parse(JSON.stringify(QUESTION_SET_FILES[0]));
      f.questions[0].body.instructions += "!";
      expect((await syncQuestionSets([f])).map((s) => s.result)).toEqual(["hash_changed"]);
      const q = await rows`SELECT body FROM jev_question WHERE question_id = 'is_greeting'`;
      expect(JSON.stringify(q[0]!.body)).not.toContain("!");
    });
    it("a status move without ratification is refused; backward is refused; live needs its flag; every move is an event", async () => {
      expect(await moveStatus({ id: "smoke", version: "v0", to: "shadow", actor: "test" })).toEqual({ ok: false, error: "unratified" });
      expect(await moveStatus({ id: "smoke", version: "v0", to: "bench", actor: "test", reason: "bench first" })).toMatchObject({ ok: true, from: "draft", to: "bench" });
      expect(await moveStatus({ id: "smoke", version: "v0", to: "draft", actor: "test" })).toEqual({ ok: false, error: "backward" });
      expect(await moveStatus({ id: "smoke", version: "v0", to: "shadow", actor: "test", ratifiedBy: "v" })).toMatchObject({ ok: true, to: "shadow" });
      expect(await moveStatus({ id: "smoke", version: "v0", to: "live", actor: "test", ratifiedBy: "v" })).toEqual({ ok: false, error: "live_flag_off" });
      expect(await moveStatus({ id: "ghost", version: "v0", to: "bench", actor: "test" })).toEqual({ ok: false, error: "not_found" });
      const ev = await rows`SELECT from_status, to_status FROM jev_question_set_event WHERE question_set_id = 'smoke' ORDER BY seq`;
      expect(ev.map((e) => `${e.from_status ?? "-"}>${e.to_status}`)).toEqual(["->draft", "draft>bench", "bench>shadow"]);
      await H.pg!.sql`UPDATE jev_question_set SET status = 'draft', ratified_by = NULL, ratified_at = NULL WHERE id = 'smoke'`;   // back to draft for the runs below
    });
    it("the table itself refuses a shadow/live set with no ratifier", async () => {
      expect(() => pg.exec(`UPDATE jev_question_set SET status = 'shadow', ratified_by = NULL WHERE id = 'smoke';`)).toThrow();
    });
  });

  // ── P1.3 ───────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("P1.3 — the jev_ask step machine", () => {
    it("FLAGS OFF: the job ends skipped with 0 calls and 0 ledger rows (the flag gate)", async () => {
      const r = await runJob(argsFor("bench"));
      expect(r.out).toMatchObject({ kind: "done", result: { skipped: "worker_disabled", calls: 0 } });
      expect(H.calls.length).toBe(0);
      expect((await rows`SELECT count(*)::int AS n FROM jev_call`)[0]!.n).toBe(0);
    });
    it("a use flag off blocks shadow even with the master switch on", async () => {
      env({ JEV_WORKER_ENABLED: "1", ETA_JEV_TEXT_LANE: "1" });
      expect((await runJob(argsFor("shadow"))).out).toMatchObject({ result: { skipped: "use_flag_off" } });
      expect(H.calls.length).toBe(0);
    });
    it("a text set with the text lane off makes no call", async () => {
      env({ JEV_WORKER_ENABLED: "1", JEV_USE_STT_QUALITY: "1" });
      expect((await runJob(argsFor("bench"))).out).toMatchObject({ result: { skipped: "text_lane_off" } });
      expect(H.calls.length).toBe(0);
    });
    it("a DRAFT set runs only in bench: shadow is refused as set_not_allowed", async () => {
      env(ON);
      expect((await runJob(argsFor("shadow"))).out).toMatchObject({ result: { skipped: "set_not_allowed", detail: "status_draft_for_shadow" } });
      expect(H.calls.length).toBe(0);
    });
    it("BENCH: one call per subject per option order, ledger rows with mode=bench, NO decision rows, closed codes in the result, no text anywhere", async () => {
      env(ON);
      const r = await runJob(argsFor("bench", { subject_ids: SUBJECTS }));
      expect(r.out).toMatchObject({ kind: "done", result: { subjects: 3, decisions: 0, calls: 6, failed: 0 } });
      expect(H.calls.length).toBe(6);
      const reversed = H.calls.filter((c) => c.questions.tone && Object.keys(c.questions.tone.criteria!)[0] === "unclear");
      expect(reversed.length, "the reversed order is really sent").toBe(3);
      expect((await rows`SELECT count(*)::int AS n FROM jev_call WHERE mode = 'bench'`)[0]!.n).toBe(6);
      expect((await rows`SELECT count(*)::int AS n FROM jev_decision WHERE mode = 'bench'`)[0]!.n).toBe(0);
      const bench = (r.out as unknown as { result: { bench: Array<{ variant: string }> } }).result.bench;
      expect(bench.some((b) => b.variant === "derived")).toBe(true);
      expect(JSON.stringify(r.out)).not.toContain(SECRET_TEXT);
    });
    it("SHADOW: decisions carry set, hash, prompt_version per order, band, mode; derived is order-averaged and notes the flip", async () => {
      await H.pg!.sql`UPDATE jev_question_set SET status = 'shadow', ratified_by = 'v', ratified_at = now() WHERE id = 'smoke'`;
      env({ ...ON, JEV_STATE_HMAC_KEY: "test-hmac-key" });
      const r = await runJob(argsFor("shadow"));
      expect(r.out).toMatchObject({ kind: "done", result: { subjects: 3, decisions: 15, calls: 6 } });
      const d = await rows`SELECT question_id, order_variant, prompt_version, band, outcome, mode, mock, lane, question_set_id, left(question_set_sha256, 8) AS sha8, state_sha256, evidence FROM jev_decision WHERE mode = 'shadow' AND subject_id = 'run_a' ORDER BY question_id, order_variant`;
      expect(d.map((x) => `${x.question_id}/${x.order_variant}`)).toEqual(["is_greeting/derived", "is_greeting/fwd", "tone/derived", "tone/fwd", "tone/rev"]);
      for (const x of d) { expect(x.prompt_version).toMatch(/^smoke@v0\+(fwd|rev|derived)$/); expect(x.mode).toBe("shadow"); expect(x.mock).toBe(false); expect(x.lane).toBe("text"); expect(x.question_set_id).toBe("smoke"); }
      expect(d.find((x) => x.question_id === "tone" && x.order_variant === "derived")).toMatchObject({ prompt_version: "smoke@v0+derived", band: "review" });
      expect(d.find((x) => x.question_id === "tone" && x.order_variant === "derived")!.evidence).toMatchObject({ order_flip: true, stt_run_ids: ["run_a"] });
      expect(d[0]!.state_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect((await rows`SELECT count(*)::int AS n FROM jev_decision WHERE row_to_json(jev_decision)::text LIKE ${"%" + SECRET_TEXT + "%"}`)[0]!.n).toBe(0);
      expect((await rows`SELECT count(*)::int AS n FROM jev_call WHERE row_to_json(jev_call)::text LIKE ${"%" + SECRET_TEXT + "%"}`)[0]!.n).toBe(0);
    });
    it("REPLAYING a step writes 0 duplicate decisions", async () => {
      env(ON);
      const before = (await rows`SELECT count(*)::int AS n FROM jev_decision WHERE mode = 'shadow'`)[0]!.n;
      const a = argsFor("shadow");
      const first = await jevAskKind.run(mkCtx("plan", a, {}));
      expect(first.kind).toBe("next");
      const prog = (first as { progress: Record<string, unknown> }).progress;
      // pending is empty now (decisions exist), so replay the ask step with explicit subjects instead
      const withSubjects = { ...prog, subjects: SUBJECTS };
      await jevAskKind.run(mkCtx("ask", a, withSubjects));
      await jevAskKind.run(mkCtx("ask", a, withSubjects));
      expect((await rows`SELECT count(*)::int AS n FROM jev_decision WHERE mode = 'shadow'`)[0]!.n).toBe(before);
    });
    it("progress holds ids and counts only (no text)", async () => {
      env(ON);
      const out = await jevAskKind.run(mkCtx("ask", argsFor("shadow"), { subjects: SUBJECTS, i: 0, decisions: 0, calls: 0, tokens: 0, failed: [], bench: [], bench_dropped: 0 }));
      expect(JSON.stringify(out)).not.toContain(SECRET_TEXT);
    });
    it("MOCK rows: mock=true, model jev-mock, band review, cost 0, and jev_decision_current never shows them", async () => {
      env({ ...ON, ETA_JEV_MOCK: "1" });
      await H.pg!.sql`DELETE FROM jev_decision WHERE mode = 'shadow'`;
      await runJob(argsFor("shadow", { subject_ids: ["run_m"] }));
      const m = await rows`SELECT model, mock, band FROM jev_decision WHERE subject_id = 'run_m' AND order_variant = 'derived'`;
      expect(m.length).toBe(2);
      for (const x of m) expect(x).toMatchObject({ model: "jev-mock", mock: true, band: "review" });
      expect(Number((await rows`SELECT cost_usd FROM jev_call WHERE mock = true LIMIT 1`)[0]!.cost_usd)).toBe(0);
      expect((await rows`SELECT count(*)::int AS n FROM jev_decision_current WHERE subject_id = 'run_m'`)[0]!.n).toBe(0);
    });
    it("jev_decision_current reads the LIVE set over the shadow set, real rows only", async () => {
      env(ON);
      await runJob(argsFor("shadow", { subject_ids: ["run_v"] }));
      const cur = await rows`SELECT question_id, mode, order_variant FROM jev_decision_current WHERE subject_id = 'run_v' ORDER BY question_id`;
      expect(cur.map((c) => `${c.question_id}/${c.mode}/${c.order_variant}`)).toEqual(["is_greeting/shadow/derived", "tone/shadow/derived"]);
    });
    it("a state over the size guard is a typed decision row and NO call", async () => {
      env(ON);
      const before = H.calls.length;
      await runJob(argsFor("shadow", { subject_ids: ["run_big"] }));
      expect(H.calls.length).toBe(before);
      const r = await rows`SELECT outcome, band FROM jev_decision WHERE subject_id = 'run_big'`;
      expect(r.length).toBe(2);
      for (const x of r) expect(x).toMatchObject({ outcome: "state_too_large", band: "abstain" });
    });
    it("an off-menu choice and a missing answer are typed rows, not stored answers", async () => {
      env(ON);
      H.script = (req) => ({ model: "jev-1.13.0", usage: { input_tokens: 10, output_tokens: 1 }, latency_ms: 1,
        answers: req.questions.tone ? { tone: { type: "choice", choice: "ZZ-OFF-MENU", probabilities: { friendly: 1 }, confidence: 1 } } : {} });
      await runJob(argsFor("shadow", { subject_ids: ["run_x"] }));
      const r = await rows`SELECT question_id, order_variant, outcome FROM jev_decision WHERE subject_id = 'run_x' ORDER BY question_id, order_variant`;
      expect(r.filter((x) => x.question_id === "tone" && x.order_variant !== "derived").every((x) => x.outcome === "off_menu_rejected")).toBe(true);
      expect(r.find((x) => x.question_id === "is_greeting" && x.order_variant === "fwd")!.outcome).toBe("no_answer");
      expect((await rows`SELECT count(*)::int AS n FROM jev_decision WHERE row_to_json(jev_decision)::text LIKE '%ZZ-OFF-MENU%'`)[0]!.n).toBe(0);
    });
  });

  // ── survivors of the first refute (M2, M6, M10, M14, M18): each is a gate that must be pinned by a test ────────────────
  describe("the gates a refuter's mutants found unpinned", () => {
    const freshAll = async () => { await H.pg!.sql`DELETE FROM jev_breaker`; await H.pg!.sql`DELETE FROM jev_call`; await H.pg!.sql`DELETE FROM jev_slot`; };
    const progress = (subjects: string[]) => ({ subjects, i: 0, decisions: 0, calls: 0, tokens: 0, failed: [], bench: [], bench_dropped: 0 });

    it("M10: the worker sends EXACTLY the set's model pin (jev-1.13.0) to the client, even when ETA_JEV_MODEL says otherwise", async () => {
      await freshAll(); env({ ...ON, ETA_JEV_MODEL: "jev-9.9.9" });
      await runJob(argsFor("shadow", { subject_ids: ["run_pin"] }));
      expect(H.calls.length).toBeGreaterThan(0);
      for (const c of H.calls) expect(c.model, "every call carries the pin").toBe("jev-1.13.0");
    });

    it("M2: a flag switched OFF between steps stops the NEXT step (the gate is re-checked every step)", async () => {
      await freshAll(); env(ON);
      const a = argsFor("shadow", { subject_ids: ["run_g1", "run_g2"] });
      const planned = await jevAskKind.run(mkCtx("plan", a, {}));
      expect(planned.kind).toBe("next");
      delete process.env.JEV_WORKER_ENABLED;
      const out = await jevAskKind.run(mkCtx("ask", a, (planned as { progress: Record<string, unknown> }).progress));
      expect(out).toMatchObject({ kind: "done", result: { skipped: "worker_disabled" } });
      expect(H.calls.length).toBe(0);
    });

    it("M6: a set whose DB mirror no longer equals the deployed file's hash never runs (plan AND ask)", async () => {
      await freshAll(); env(ON);
      const real = String((await rows`SELECT content_sha256 FROM jev_question_set WHERE id = 'smoke'`)[0]!.content_sha256);
      await H.pg!.sql`UPDATE jev_question_set SET content_sha256 = ${"f".repeat(64)} WHERE id = 'smoke'`;
      try {
        expect((await runJob(argsFor("shadow", { subject_ids: ["run_h"] }))).out).toMatchObject({ result: { skipped: "set_not_allowed", detail: "hash_mismatch" } });
        const mid = await jevAskKind.run(mkCtx("ask", argsFor("shadow", { subject_ids: ["run_h"] }), progress(["run_h"])));
        expect(mid).toMatchObject({ kind: "done", result: { skipped: "set_not_allowed", detail: "hash_mismatch" } });
        expect(H.calls.length).toBe(0);
      } finally {
        await H.pg!.sql`UPDATE jev_question_set SET content_sha256 = ${real} WHERE id = 'smoke'`;
      }
    });

    it("M14: the per-STEP budget stop: an ask step over the day's cap defers with no call, even though plan was not run", async () => {
      await freshAll(); env({ ...ON, JEV_DAILY_USD_CAP: "0.0001" });
      await H.pg!.sql`INSERT INTO jev_call (id, use, mode, cost_usd) VALUES ('jc_m14', 'stt_quality', 'shadow', 0.0002)`;
      const out = await jevAskKind.run(mkCtx("ask", argsFor("shadow", { subject_ids: ["run_b1"] }), progress(["run_b1"])));
      expect(out).toMatchObject({ kind: "done", result: { skipped: "budget_exceeded", subjects: 1, asked: 0 } });
      expect(H.calls.length).toBe(0);
    });

    it("M18: live mode needs a set whose status is LIVE (a shadow set is refused even with every flag on)", async () => {
      await freshAll(); env({ ...ON, JEV_STT_QUALITY_LIVE: "1" });
      const r = await runJob(argsFor("live", { subject_ids: ["run_l"] }));
      expect(r.out).toMatchObject({ result: { skipped: "set_not_allowed", detail: "status_shadow_for_live" } });
      expect(H.calls.length).toBe(0);
    });

    it("a shadow run with the set at status 'draft' is refused too, and a RETIRED set runs in no mode", async () => {
      await freshAll(); env(ON);
      await H.pg!.sql`UPDATE jev_question_set SET status = 'retired' WHERE id = 'smoke'`;
      try {
        for (const m of ["bench", "shadow"] as const) expect((await runJob(argsFor(m, { subject_ids: ["run_r"] }))).out).toMatchObject({ result: { skipped: "set_not_allowed", detail: "retired" } });
        expect(H.calls.length).toBe(0);
      } finally {
        await H.pg!.sql`UPDATE jev_question_set SET status = 'shadow' WHERE id = 'smoke'`;
      }
    });
  });

  // ── P1.4 ───────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("P1.4 — fault injection, breaker, budget, cap, slots", () => {
    const fresh = async () => { await H.pg!.sql`DELETE FROM jev_breaker`; await H.pg!.sql`DELETE FROM jev_call`; await H.pg!.sql`DELETE FROM jev_slot`; };
    const throwing = (e: () => unknown) => { H.script = () => { throw e(); }; };

    it.each([
      ["rate_limited", () => new JevHttpError(429, "{}")], ["overloaded", () => new JevHttpError(529, "{}")], ["provider_error", () => new JevHttpError(500, "{}")],
      ["timeout", () => Object.assign(new Error("t"), { name: "AbortError" })],
    ])("%s: the step THROWS (the runner retries), the ledger row names the class, progress is kept", async (cls, mk) => {
      await fresh(); env(ON); throwing(mk);
      const r = await runJob(argsFor("shadow", { subject_ids: ["run_f1", "run_f2"] }));
      expect(r.thrown?.message).toBe(cls);
      expect(r.thrown?.progress_patch).toMatchObject({ i: 0 });
      expect((await rows`SELECT error_class FROM jev_call ORDER BY created_at LIMIT 1`)[0]!.error_class).toBe(cls);
    });
    it("schema_rejected (422): recorded on the subject, NOT retried, the job goes on and the breaker is untouched", async () => {
      await fresh(); env(ON); throwing(() => new JevHttpError(422, "{}"));
      const r = await runJob(argsFor("shadow", { subject_ids: ["run_f1", "run_f2"] }));
      expect(r.out).toMatchObject({ kind: "done", result: { failed: 2, failed_classes: ["schema_rejected"] } });
      expect((await getBreaker("stt_quality")).state).toBe("closed");
    });
    it("auth (401): the job FAILS and the circuit opens at once", async () => {
      await fresh(); env(ON); throwing(() => new JevHttpError(401, "{}"));
      const r = await runJob(argsFor("shadow", { subject_ids: ["run_f1"] }));
      expect(r.out).toEqual({ kind: "fail", error: "jev_ask:auth" });
      expect((await getBreaker("stt_quality")).state).toBe("open");
      // while open, a new job defers and makes no call
      H.calls.length = 0; H.script = null;
      expect((await runJob(argsFor("shadow", { subject_ids: ["run_f1"] }))).out).toMatchObject({ result: { skipped: "circuit_open" } });
      expect(H.calls.length).toBe(0);
    });
    it("5 consecutive timeouts open it; after the wait ONE probe is admitted; a success closes it", async () => {
      await fresh(); env(ON);
      for (let i = 0; i < 5; i += 1) await recordOutcome("stt_quality", { ok: false, counts: true, cls: "timeout" });
      expect((await getBreaker("stt_quality")).state).toBe("open");
      expect((await breakerAdmit("stt_quality")).admit).toBe(false);
      await H.pg!.sql`UPDATE jev_breaker SET opened_at = now() - interval '11 minutes'`;
      expect(await breakerAdmit("stt_quality")).toMatchObject({ admit: true, probe: true, state: "half_open" });
      expect((await breakerAdmit("stt_quality")).admit, "only ONE probe").toBe(false);
      await recordOutcome("stt_quality", { ok: true });
      expect((await getBreaker("stt_quality")).state).toBe("closed");
    });
    it("a failed probe re-opens it with the wait doubled", async () => {
      await fresh();
      for (let i = 0; i < 5; i += 1) await recordOutcome("stt_quality", { ok: false, counts: true, cls: "timeout" });
      await H.pg!.sql`UPDATE jev_breaker SET opened_at = now() - interval '11 minutes'`;
      await breakerAdmit("stt_quality");
      await recordOutcome("stt_quality", { ok: false, counts: true, cls: "timeout" });
      expect(await getBreaker("stt_quality")).toMatchObject({ state: "open", wait_ms: 1_200_000 });
    });
    it("budget: over the day's cap the job ends budget_exceeded and makes no call", async () => {
      await fresh(); env({ ...ON, JEV_DAILY_USD_CAP: "0.0001" });
      await H.pg!.sql`INSERT INTO jev_call (id, use, mode, cost_usd) VALUES ('jc_seed', 'stt_quality', 'shadow', 0.0002)`;
      const r = await runJob(argsFor("shadow", { subject_ids: ["run_f1"] }));
      expect(r.out).toMatchObject({ result: { skipped: "budget_exceeded" } });
      expect(H.calls.length).toBe(0);
    });
    it("slots: with every global slot taken the step waits (next ask), it does not fail and does not call", async () => {
      await fresh(); env({ ...ON, JEV_SLOT_WAIT_MS: "250" });   // the wait is injectable: the step defers in a quarter of a second, not five
      for (let i = 0; i < GLOBAL_SLOTS; i += 1) expect(await claimSlot("job_x")).toMatch(/^slot_/);
      expect(await claimSlot("job_x")).toBeNull();
      const out = await jevAskKind.run(mkCtx("ask", argsFor("shadow", { subject_ids: ["run_f1"] }), { subjects: ["run_f1"], i: 0, decisions: 0, calls: 0, tokens: 0, failed: [], bench: [], bench_dropped: 0 }));
      expect(out).toMatchObject({ kind: "next", step: "ask" });
      expect(H.calls.length).toBe(0);
    });
    it("THE ATOMIC CAP: 3 concurrent submits against room for ONE cannot overshoot; the CONTROL (no lock) does", async () => {
      await fresh(); await H.pg!.sql`DELETE FROM scribe_job`;
      const args = { use: "stt_quality", mode: "shadow", set_id: "smoke", version: "v0", subjects_key: "sweep" };
      H.dwell = true;
      const guarded = await Promise.all([1, 2, 3].map(() => submitJevAskCapped(args, "t", 0.6, 1)));
      expect(guarded.filter(Boolean).length, "locked").toBe(1);
      await H.pg!.sql`DELETE FROM scribe_job`;
      H.dropLock = true;
      const control = await Promise.all([1, 2, 3].map(() => submitJevAskCapped(args, "t", 0.6, 1)));
      expect(control.filter(Boolean).length, "CONTROL must overshoot, proving the test can see the race").toBeGreaterThan(1);
      expect(JEV_SUBMIT_LOCK_KEY).toBeGreaterThan(0);
      await H.pg!.sql`DELETE FROM scribe_job`;
    }, 60_000);
    it("the generic submit path refuses over the cap too (precheck)", async () => {
      await fresh(); env({ ...ON, JEV_DAILY_USD_CAP: "0.0001" });
      await H.pg!.sql`INSERT INTO jev_call (id, use, mode, cost_usd) VALUES ('jc_seed2', 'stt_quality', 'shadow', 0.0002)`;
      await expect(jevAskKind.precheck!({ ...argsFor("shadow"), reserve_usd: 0.01 })).rejects.toThrow(/budget_exceeded/);
    });
  });

  // ── P1.5 ───────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("P1.5 — the sweeper and nudges", () => {
    const reset = async () => { await H.pg!.sql`DELETE FROM scribe_job`; await H.pg!.sql`DELETE FROM jev_decision WHERE mode = 'shadow'`; await H.pg!.sql`DELETE FROM jev_breaker`; await H.pg!.sql`DELETE FROM jev_call`; await H.pg!.sql`DELETE FROM jev_slot`; };
    it("FLAG OFF: 0 jobs, 0 calls, and not one SQL statement", async () => {
      await reset();
      H.sqlCalls = 0;
      const r = await sweepJev();
      expect(r.uses.every((u) => u.skipped === "worker_disabled" && !u.enqueued)).toBe(true);
      expect(H.sqlCalls).toBe(0);
      expect((await rows`SELECT count(*)::int AS n FROM scribe_job`)[0]!.n).toBe(0);
    });
    it("ON: each eligible subject gets exactly one decision per hash; a second sweep sees the open job, then nothing pending", async () => {
      await reset(); env(ON);
      const first = await sweepJev();
      expect(first.uses[0]).toMatchObject({ use: "stt_quality", enqueued: true, mode: "shadow", pending: 3 });
      expect((await sweepJev()).uses[0]).toMatchObject({ enqueued: false, skipped: "open_job" });
      const job = await rows`SELECT id, args, kind FROM scribe_job WHERE kind = 'jev_ask'`;
      expect(job.length).toBe(1);
      expect(job[0]!.kind).toBe("jev_ask");
      // run it
      expect((await runJob(job[0]!.args, job[0]!.id)).out).toMatchObject({ result: { decisions: 15 } });
      await H.pg!.sql`UPDATE scribe_job SET status = 'done'`;
      expect((await sweepJev()).uses[0]).toMatchObject({ enqueued: false, skipped: "nothing_pending" });
      expect((await rows`SELECT count(*)::int AS n FROM jev_decision WHERE subject_id = 'run_a' AND order_variant = 'derived' AND mode = 'shadow'`)[0]!.n).toBe(2);
    });
    it("an open circuit and a spent budget keep the sweeper from enqueueing", async () => {
      await reset(); env(ON);
      for (let i = 0; i < 5; i += 1) await recordOutcome("stt_quality", { ok: false, counts: true, cls: "timeout" });
      expect((await sweepJev()).uses[0]).toMatchObject({ skipped: "circuit_open" });
      await H.pg!.sql`DELETE FROM jev_breaker`;
      env({ JEV_DAILY_USD_CAP: "0.0001" });
      await H.pg!.sql`INSERT INTO jev_call (id, use, mode, cost_usd) VALUES ('jc_seed3', 'stt_quality', 'shadow', 0.01)`;
      expect((await sweepJev()).uses[0]).toMatchObject({ skipped: "budget_paused" });
    });
    it("a nudge that fails NEVER throws into its caller", async () => {
      await reset(); env(ON);
      _clearUsesForTests();
      registerUse({ use: "stt_quality", setId: "smoke", subjectType: "stt_run", eligible: async () => { throw Object.assign(new Error("connection reset"), { code: "08006" }); }, build: async () => null });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await expect(nudgeJev("stt_quality")).resolves.toBeUndefined();
      expect(warn.mock.calls.flat().join(" ")).toContain("db_error:08006");
      expect(warn.mock.calls.flat().join(" ")).not.toContain("connection reset");
      warn.mockRestore();
      _clearUsesForTests();
      registerUse({ use: "stt_quality", setId: "smoke", subjectType: "stt_run", eligible: async () => SUBJECTS, build: async (id) => ({ state: { text: `${SECRET_TEXT} ${id}` }, evidence: { stt_run_ids: [id] }, lane: "text" }) });
    });
    it("a nudge with the flag off does nothing", async () => {
      await reset(); H.sqlCalls = 0;
      await nudgeJev("stt_quality");
      expect(H.sqlCalls).toBe(0);
    });
    it("enqueues yesterday's drift report once per use per IST day", async () => {
      await reset(); env(ON);
      const a = await sweepJev(); const b = await sweepJev();
      expect(a.drift_enqueued).toEqual(["stt_quality"]);
      expect(b.drift_enqueued).toEqual([]);
    });
  });

  // ── P1.6 ───────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("P1.6 — MCP tools", () => {
    beforeAll(async () => {
      env(ON);
      await H.pg!.sql`DELETE FROM jev_decision WHERE mode = 'shadow'`;
      await runJob(argsFor("shadow", { subject_ids: SUBJECTS }));
      for (const k of Object.keys(ON)) delete process.env[k];
    }, 120_000);
    it("scribe_jev_question_sets lists the registry with options and NO subject text", async () => {
      const out = (await tool("scribe_jev_question_sets").handler({}, ctx)) as { ok: boolean; sets: Array<{ id: string; status: string; content_sha256: string; questions: Array<{ question_id: string; options: string[] | null }> }> };
      expect(out.ok).toBe(true);
      const s = out.sets.find((x) => x.id === "smoke")!;
      expect(s).toMatchObject({ status: "shadow" });
      expect(s.questions.find((q) => q.question_id === "tone")!.options).toEqual(["friendly", "neutral", "unclear"]);
      expect(JSON.stringify(out)).not.toContain(SECRET_TEXT);
      expect(((await tool("scribe_jev_question_sets").handler({ status: "live" }, ctx)) as { sets: unknown[] }).sets).toEqual([]);
    });
    it("scribe_jev_health reports every use with booleans and numbers only", async () => {
      env(ON);
      const out = (await tool("scribe_jev_health").handler({}, ctx)) as { ok: boolean; budget: { cap_usd: number }; uses: Array<{ use: string; flags: Record<string, unknown>; breaker: { state: string } }> };
      expect(out.ok).toBe(true);
      expect(out.uses.map((u) => u.use)).toEqual(["encounter_timeline", "stt_quality", "stt_pick", "consult_rubric"]);
      expect(out.uses.find((u) => u.use === "stt_quality")!.flags).toEqual({ worker: true, use: true, text_lane: true, live: false });
      expect(JSON.stringify(out)).not.toMatch(/ZZ-TEXT|key|secret/i);
    });
    it("scribe_jev_decisions filters by set, hash, mode and mock, and returns the new columns", async () => {
      const all = (await tool("scribe_jev_decisions").handler({ limit: 500 }, ctx)) as { ok: boolean; decisions: Array<Record<string, unknown>> };
      expect(all.ok).toBe(true);
      expect(Object.keys(all.decisions[0]!)).toEqual(expect.arrayContaining(["question_set_id", "question_set_sha256", "order_variant", "band", "outcome", "mode", "mock"]));
      const sha = String((await rows`SELECT content_sha256 FROM jev_question_set WHERE id = 'smoke'`)[0]!.content_sha256);
      const bySha = (await tool("scribe_jev_decisions").handler({ question_set_sha256: sha, limit: 500 }, ctx)) as { decisions: Array<Record<string, unknown>> };
      expect(bySha.decisions.length).toBeGreaterThan(0);
      expect(bySha.decisions.every((d) => d.question_set_sha256 === sha)).toBe(true);
      const mock = (await tool("scribe_jev_decisions").handler({ mock: true, limit: 500 }, ctx)) as { decisions: Array<Record<string, unknown>> };
      expect(mock.decisions.every((d) => d.mock === true)).toBe(true);
      const real = (await tool("scribe_jev_decisions").handler({ mock: false, mode: "shadow", question_set_id: "smoke", limit: 500 }, ctx)) as { decisions: Array<Record<string, unknown>> };
      expect(real.decisions.every((d) => d.mock === false && d.mode === "shadow" && d.question_set_id === "smoke")).toBe(true);
      expect(((await tool("scribe_jev_decisions").handler({ mode: "nope" }, ctx)) as { error: string }).error).toBe("mode_invalid");
      expect(((await tool("scribe_jev_decisions").handler({ since: "not-a-date" }, ctx)) as { error: string }).error).toBe("since_invalid");
      expect(JSON.stringify(all)).not.toContain(SECRET_TEXT);
    });
    it("scribe_usage include:'jev' reconciles with jev_call sums; without it the output has no jev key", async () => {
      await H.pg!.sql`DELETE FROM jev_call`;
      await H.pg!.sql`INSERT INTO jev_call (id, use, mode, input_tokens, cost_usd, error_class) VALUES ('jc_u1', 'stt_quality', 'shadow', 1000, 0.000042, NULL), ('jc_u2', 'stt_quality', 'shadow', 2000, 0.000084, 'timeout')`;
      const plain = (await tool("scribe_usage").handler({}, ctx)) as Record<string, unknown>;
      expect("jev" in plain).toBe(false);
      const withJev = (await tool("scribe_usage").handler({ include: "jev" }, ctx)) as { jev: { per_use_day: Array<{ use: string; calls: number; tokens_in: number; usd: number; error_classes: Record<string, number> }>; budget: { spent_usd: number } } };
      const today = withJev.jev.per_use_day.find((d) => d.use === "stt_quality")!;
      expect(today).toMatchObject({ calls: 2, tokens_in: 3000 });
      expect(today.usd).toBeCloseTo(0.000126, 8);
      expect(today.error_classes).toEqual({ timeout: 1 });
      expect(withJev.jev.budget.spent_usd).toBeCloseTo(0.000126, 8);
      expect(((await tool("scribe_usage").handler({ include: "nope" }, ctx)) as { error: string }).error).toBe("include_invalid");
    });
  });

  // ── P1.7 ───────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("P1.7 — the drift job", () => {
    it("writes a report per use and question; a changed model string raises an alert (fixture)", async () => {
      env({ JEV_WORKER_ENABLED: "1" });
      await H.pg!.sql`DELETE FROM jev_call`;
      const sha = String((await rows`SELECT content_sha256 FROM jev_question_set WHERE id = 'smoke'`)[0]!.content_sha256);
      await H.pg!.sql`INSERT INTO jev_call (id, use, mode, question_set_sha256, model_returned, latency_ms, input_tokens, cost_usd, subject_count) VALUES ('jc_d1', 'stt_quality', 'shadow', ${sha}, 'jev-1.14.0', 50, 1000, 0.000042, 1)`;
      const day = (await rows`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)[0]!.d;
      const out = await jevDriftKind.run({ ...mkCtx("report", { use: "stt_quality", ist_date: day }, {}), args: { use: "stt_quality", ist_date: day } });
      expect(out).toMatchObject({ kind: "done", result: { reports: 2 } });
      const rep = await rows`SELECT question_id, alerts, metrics FROM jev_drift_report WHERE use = 'stt_quality' AND ist_date = ${day}::date ORDER BY question_id`;
      expect(rep.map((r) => r.question_id)).toEqual(["is_greeting", "tone"]);
      for (const r of rep) { expect(r.alerts).toContain("model_changed:jev-1.14.0"); expect(r.metrics.n).toBeGreaterThan(0); }
      expect(JSON.stringify(rep)).not.toContain(SECRET_TEXT);
    });
    it("is dark with the worker flag off", async () => {
      const out = await jevDriftKind.run({ ...mkCtx("report", { ist_date: "2026-10-10" }, {}), args: { ist_date: "2026-10-10" } });
      expect(out).toMatchObject({ kind: "done", result: { skipped: "worker_disabled" } });
    });
  });
});
void askBatch;
