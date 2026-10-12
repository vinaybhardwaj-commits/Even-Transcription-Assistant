/**
 * /api/admin/jev/bench and /bench/subjects — auth, validation, gates, and the bench-writes-no-decision rule. The Jev client, ledger, breaker, budget and slots are mocked;
 * askSubject and runBench are REAL, so "upsertDecisions never called" is the real bench-mode behaviour. The sentinel below stands for state text and must never be echoed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const SENTINEL = "ZZ-STATE-TEXT-ZZ";
const H = vi.hoisted(() => ({ upsert: 0, insertCall: 0, sync: 0, systemOne: 0, breakerOpen: false, budgetOk: true }));

vi.mock("@/lib/db", () => ({ sql: Object.assign(() => Promise.resolve([]), { transaction: async () => [] }) }));
vi.mock("@/lib/jev/worker/sync", () => ({ syncQuestionSets: async () => { H.sync += 1; return []; } }));
vi.mock("@/lib/jev/worker/persist", () => ({
  newCallId: () => "jc_test", newDecisionId: () => "jd_test", stateHmac: () => "h",
  insertCall: async () => { H.insertCall += 1; },
  upsertDecisions: async () => { H.upsert += 1; return 1; },
}));
vi.mock("@/lib/jev/worker/breaker", () => ({
  breakerAdmit: async () => (H.breakerOpen ? { admit: false, state: "open" } : { admit: true, state: "closed" }),
  recordOutcome: async () => undefined,
}));
vi.mock("@/lib/jev/worker/budget", async (orig) => ({
  ...(await orig<typeof import("@/lib/jev/worker/budget")>()),
  budgetCheck: async () => ({ ok: H.budgetOk, spent: 0, cap: 5, soft: 2, soft_exceeded: false, left: 5 }),
}));
vi.mock("@/lib/jev/worker/slots", () => ({ acquireSlot: async () => "slot", releaseSlot: async () => undefined }));
vi.mock("@/lib/jev/client", () => ({
  getJevClient: () => ({
    async systemOne(req: { questions: Record<string, { type: string; criteria?: Record<string, string> }> }) {
      H.systemOne += 1;
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        if (q.type === "choice") { const k = Object.keys(q.criteria!); answers[id] = { type: "choice", choice: k[0], probabilities: Object.fromEntries(k.map((x, i) => [x, i === 0 ? 1 : 0])), confidence: 1 }; }
        else if (q.type === "noul") answers[id] = { type: "noul", noul: 0.7 };
        else answers[id] = { type: "score", score: 3, probabilities: { "3": 1 }, confidence: 1 };
      }
      return { answers, model: "jev-1.13.0", latency_ms: 5, usage: { input_tokens: 10, output_tokens: 2 } };
    },
  }),
}));
vi.mock("@/lib/jobs/kinds/jev-ask", async () => {
  const { QUESTION_SET_FILES } = await import("@/jev/question-sets");
  const { validateSetFile, setSha } = await import("@/lib/jev/worker/sets");
  return {
    loadSetForMode: async (use: string, _mode: string, setId: string, version: string) => {
      const file = QUESTION_SET_FILES.map((f) => { try { return validateSetFile(f); } catch { return null; } }).find((f) => f && f.id === setId && f.version === version);
      if (!file) return { ok: false, reason: "set_not_allowed", detail: "no_file" };
      return { ok: true, set: { id: file.id, version: file.version, sha: setSha(file), modelPin: "jev-1.13.0", use, subjectType: "consult", bands: null }, defs: file.questions };
    },
  };
});

const SECRET = "cron-secret-for-test";
const post = async (body: unknown, auth: string | null = `Bearer ${SECRET}`) => {
  const { POST } = await import("@/app/api/admin/jev/bench/route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/admin/jev/bench", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) } }));
};
const good = { use: "consult_rubric", set: "chair-affect@v0", subjects: ["c_a", "c_b"] };

beforeEach(async () => {
  Object.assign(H, { upsert: 0, insertCall: 0, sync: 0, systemOne: 0, breakerOpen: false, budgetOk: true });
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("ETA_JEV_ENABLED", "1");
  vi.stubEnv("ETA_JEV_TEXT_LANE", "1");
  vi.stubEnv("JEV_WORKER_ENABLED", "");   // OFF: the door must not care
  const { _clearUsesForTests, registerUse } = await import("@/lib/jev/worker/uses");
  await import("@/lib/jev/worker/register");
  _clearUsesForTests();
  registerUse({ use: "consult_rubric", setId: "chair-affect", subjectType: "consult", eligible: async () => ["c_x", "c_y"],
    build: async (id) => (id === "c_short" ? { abstain: "patient_side_speech_lt_3_turns" } : { state: { transcript: SENTINEL }, evidence: { consult_key: id }, lane: "text" as const }) });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("POST /api/admin/jev/bench", () => {
  it("no or wrong bearer is 401, and nothing runs", async () => {
    expect((await post(good, null)).status).toBe(401);
    expect((await post(good, "Bearer nope")).status).toBe(401);
    expect(H.sync + H.systemOne).toBe(0);
  });
  it("21 subjects is 400; 0 subjects, unknown use, unknown set, bad label are closed 400s", async () => {
    const r = await post({ ...good, subjects: Array.from({ length: 21 }, (_, i) => `c${i}`) });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: { code: "bad_subjects" } });
    expect((await post({ ...good, subjects: [] })).status).toBe(400);
    expect(await (await post({ ...good, use: "nope" })).json()).toEqual({ error: { code: "unknown_use" } });
    expect(await (await post({ ...good, set: "nope@v0" })).json()).toEqual({ error: { code: "unknown_set" } });
    expect(await (await post({ ...good, set: "doubt@v0" })).json()).toEqual({ error: { code: "unknown_set" } });   // registered file, but not under this test's use registry
    expect(await (await post({ ...good, labels: { "zzz|q": "a" } })).json()).toEqual({ error: { code: "bad_labels" } });
    expect(await (await post({ ...good, concurrency: 4 })).json()).toEqual({ error: { code: "bad_concurrency" } });
    expect(H.systemOne).toBe(0);
  });
  it("text lane off is 409 text_lane_off, ETA_JEV_ENABLED off is 409 jev_disabled, and no call is made", async () => {
    vi.stubEnv("ETA_JEV_TEXT_LANE", "0");
    const r = await post(good);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: { code: "text_lane_off" } });
    vi.stubEnv("ETA_JEV_TEXT_LANE", "1"); vi.stubEnv("ETA_JEV_ENABLED", "0");
    const r2 = await post(good);
    expect(r2.status).toBe(409);
    expect(await r2.json()).toEqual({ error: { code: "jev_disabled" } });
    expect(H.systemOne + H.sync).toBe(0);
  });
  it("runs with JEV_WORKER_ENABLED off, writes jev_call rows and ZERO decisions, and the response carries no state text", async () => {
    const r = await post({ ...good, subjects: ["c_a", "c_b", "c_short"] });
    expect(r.status).toBe(200);
    const text = await r.text();
    const j = JSON.parse(text);
    expect(j.counts).toMatchObject({ subjects: 3, asked: 2, abstained: 1 });
    expect(H.sync).toBe(1);
    expect(H.systemOne).toBeGreaterThan(0);
    expect(H.insertCall).toBe(H.systemOne);
    expect(H.upsert).toBe(0);   // bench never writes jev_decision
    expect(j.subjects.map((s: { subject_id: string; status: string }) => `${s.subject_id}/${s.status}`)).toEqual(["c_a/asked", "c_b/asked", "c_short/abstained"]);
    expect(j.subjects[0].answers.length).toBeGreaterThan(0);
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toMatch(/TYPESAFE|api[_-]?key/i);
  });
  it("an open breaker or a spent cap with nothing run is 409 with the closed reason", async () => {
    H.breakerOpen = true;
    expect(await (await post(good)).json()).toEqual({ error: { code: "circuit_open" } });
    H.breakerOpen = false; H.budgetOk = false;
    const r = await post(good);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: { code: "budget_exceeded" } });
    expect(H.systemOne).toBe(0);
  });
});

describe("GET /api/admin/jev/bench/subjects", () => {
  const get = async (qs: string, auth: string | null = `Bearer ${SECRET}`) => {
    const { GET } = await import("@/app/api/admin/jev/bench/subjects/route");
    const { NextRequest } = await import("next/server");
    return GET(new NextRequest(`http://localhost/api/admin/jev/bench/subjects${qs}`, { headers: auth ? { authorization: auth } : {} }));
  };
  it("401 without the bearer; ids only with it; bad use/limit are 400", async () => {
    expect((await get("?use=consult_rubric", null)).status).toBe(401);
    expect((await get("?use=consult_rubric", "Bearer nope")).status).toBe(401);
    const r = await get("?use=consult_rubric&limit=20");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ use: "consult_rubric", set: "chair-affect", subject_ids: ["c_x", "c_y"] });
    expect((await get("?use=zzz")).status).toBe(400);
    expect((await get("?use=consult_rubric&limit=0")).status).toBe(400);
  });
});
