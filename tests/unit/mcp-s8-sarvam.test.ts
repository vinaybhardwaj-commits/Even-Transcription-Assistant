/**
 * Operator MCP S8A — scribe_sarvam. sql, the job store, R2 and fetch are mocked; no gateway, no Sarvam, no production.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { generateKeyPairSync } from "node:crypto";

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
const jobs = new Map<string, Row>();
vi.mock("@/lib/jobs/store", async (orig) => ({
  ...((await orig()) as object),
  insertJob: vi.fn(async (i: { id: string; kind: string; args: Row; actor: string | null }) => { inserted.push(i); return { id: "job_new1", kind: i.kind, status: "queued" }; }),
  readJob: vi.fn(async (id: string) => (jobs.get(id) ?? null)),
}));
const store = new Map<string, Uint8Array>();
vi.mock("@/lib/r2", async (orig) => ({ ...((await orig()) as object), getObjectBytes: vi.fn(async (k: string) => store.get(k) ?? null) }));

const S = await import("@/lib/mcp/surface");
const { handleMcpRpc } = await import("@/lib/mcp/handler");
const G = await import("@/lib/sarvam-gateway");

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const ENV = {
  SARVAM_GCP_SA_KEY_JSON: JSON.stringify({ client_email: ["gw-caller", "p.iam.gserviceaccount.com"].join("@"), private_key: privateKey, token_uri: "https://oauth2.example.test/token" }),
  SARVAM_GW_AUDIENCE: "test-audience-000", SARVAM_GW_ROLE_ARN: "arn:aws:iam::1:role/R", SARVAM_GW_BASE_URL: "https://gw.example.test/x", SARVAM_GW_REGION: "ap-south-1",
};
const saved: Record<string, string | undefined> = {};
const ctxFor = (scopes: string[]) => ({ origin: "https://x", actor: "mcp:test", scopes: new Set(scopes) }) as never;
const run = async (args: Row, scopes = ["read", "invoke"]) => (await S.CALLABLE_TOOLS.get("scribe_sarvam")!.handler(args, ctxFor(scopes))) as Row;
const writes = () => statements.filter((s) => /\b(INSERT|UPDATE|DELETE)\b/i.test(s.text));

beforeEach(() => {
  statements.length = 0; inserted.length = 0; jobs.clear(); store.clear();
  answer = () => [];
  for (const k of Object.keys(ENV)) { saved[k] = process.env[k]; process.env[k] = (ENV as Record<string, string>)[k]; }
  G.resetGatewayCredsForTests();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  vi.unstubAllGlobals();
});

const rpc = async (args: Row, scopes: string[], rooms?: string[]) => {
  const req = new NextRequest("https://x/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "scribe_sarvam", arguments: args } }) });
  const res = await handleMcpRpc(req, { token_id: "t", scopes: new Set(scopes), ...(rooms ? { rooms: new Set(rooms) } : {}) } as never);
  return { status: res.status, body: (await res.json()) as Row };
};

describe("registration", () => {
  it("one listed tool, read-scope gate, annotations: not read-only, not destructive, open world", async () => {
    const t = S.CALLABLE_TOOLS.get("scribe_sarvam")!;
    expect(t.scope).toBe("read");
    expect(S.LAB_TOOLS.includes(t)).toBe(true);
    const req = new NextRequest("https://x/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const body = (await (await handleMcpRpc(req, { token_id: "t", scopes: new Set(["read"]) } as never)).json()) as { result: { tools: Array<{ name: string; description: string; annotations: Row }> } };
    expect(body.result.tools.length).toBe(53);
    const listed = body.result.tools.find((x) => x.name === "scribe_sarvam")!;
    expect(listed.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(listed.description.length).toBeLessThanOrEqual(200);
    expect(listed.description).toMatch(/Times UTC/);
  });

  it("room-restricted tokens are refused; unknown action is named", async () => {
    expect((await rpc({ action: "health" }, ["read"], ["room_x"])).status).toBe(403);
    expect(await run({ action: "nope" })).toMatchObject({ ok: false, error: "unknown_action", allowed: ["transcribe", "translate", "status", "result", "usage", "health"] });
    expect(await run({})).toMatchObject({ ok: false, error: "unknown_action" });
  });
});

describe("transcribe / translate", () => {
  const good = { action: "transcribe", encounter_id: "enc_1" };

  it("queues a sarvam_transcribe job for an encounter and returns the id; the stored args are the parsed ones", async () => {
    const out = await run(good);
    expect(out).toEqual({ ok: true, job_id: "job_new1", kind: "sarvam_transcribe", status: "queued" });
    expect(inserted[0]).toMatchObject({ kind: "sarvam_transcribe", actor: "mcp:test", args: { source: "encounter", encounter_id: "enc_1", english: true, mode: "transcribe" } });
  });

  it("A1: room / session / window arguments are scope_consult_only — nothing is queued; the schema no longer lists them", async () => {
    for (const bad of [{ room: "opd-1", from: "2026-10-08 09:00", to: "2026-10-08 09:10" }, { session_id: "bs_1", from_ms: 0, to_ms: 60_000 }, { room: "opd-1" }, { from_ms: 1 }, { bench_window_id: "bw_1" }, { encounter_id: "enc_1", room: "opd-1" }]) {
      expect(await run({ action: "transcribe", ...bad }), JSON.stringify(bad)).toMatchObject({ ok: false, error: "scope_consult_only" });
      expect(await run({ action: "translate", ...bad }), JSON.stringify(bad)).toMatchObject({ ok: false, error: "scope_consult_only" });
    }
    expect(inserted).toEqual([]);
    const props = Object.keys((S.CALLABLE_TOOLS.get("scribe_sarvam")!.inputSchema as { properties: Row }).properties);
    for (const k of ["room", "from", "to", "session_id", "from_ms", "to_ms", "bench_window_id"]) expect(props, k).not.toContain(k);
    expect(props).toEqual(expect.arrayContaining(["encounter_id", "consult_uid", "transcription_run_id"]));
  });

  it("a consult uid answers consult_index_unavailable (no resolver yet) without queueing", async () => {
    expect(await run({ action: "transcribe", consult_uid: "cu_9" })).toEqual({ ok: false, error: "consult_index_unavailable" });
    expect(inserted).toEqual([]);
  });

  it("refuses without the gateway configured, over the daily cap, and on bad args — queueing nothing", async () => {
    process.env.SARVAM_GW_AUDIENCE = "";
    expect(await run(good)).toEqual({ ok: false, error: "sarvam_gateway_not_configured" });
    process.env.SARVAM_GW_AUDIENCE = ENV.SARVAM_GW_AUDIENCE;
    answer = (text) => (/FROM audit_log/.test(text) ? [{ minutes: 250.5 }] : []);
    expect(await run(good)).toEqual({ ok: false, error: "sarvam_daily_cap", minutes_today: 250.5, cap_minutes: 240 });
    answer = () => [{ minutes: 10 }];
    expect(await run({ action: "transcribe" })).toMatchObject({ ok: false, error: "bad_args", kind: "sarvam_transcribe" });
    expect(await run({ action: "transcribe", encounter_id: "e", num_speakers: 9 })).toMatchObject({ ok: false, error: "bad_args" });
    expect(inserted).toEqual([]);
    expect(statements.find((s) => /FROM audit_log/.test(s.text))!.values).toContain("sarvam-gw");
  });

  it("needs invoke scope: a read-only token gets the door's 403 naming invoke; an invoke token passes", async () => {
    const denied = await rpc(good, ["read"]);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({ code: -32001, message: "scope_or_tool_unavailable", data: { tool: "scribe_sarvam", needed: "invoke" } });
    expect(inserted).toEqual([]);
    const ok = await rpc(good, ["read", "invoke"]);
    expect(ok.status).toBe(200);
    expect((ok.body.result as { structuredContent: Row }).structuredContent).toMatchObject({ ok: true, kind: "sarvam_transcribe" });
    expect((await rpc({ action: "usage" }, ["read"])).status).toBe(200);
    expect((await rpc({ action: "health" }, ["read"])).status).toBe(200);
  });

  it("translate: an encounter or an encounter-subject run queues sarvam_translate and needs no gateway at submit", async () => {
    process.env.SARVAM_GW_REGION = "";
    expect(await run({ action: "translate", encounter_id: "enc_1" })).toEqual({ ok: true, job_id: "job_new1", kind: "sarvam_translate", status: "queued" });
    expect(inserted[0]).toMatchObject({ args: { kind: "encounter", id: "enc_1" } });
    answer = (text) => (/FROM transcription_run/.test(text) ? [{ subject_type: "encounter" }] : []);
    expect(await run({ action: "translate", transcription_run_id: "trun_e" })).toMatchObject({ ok: true, kind: "sarvam_translate" });
    expect(await run({ action: "translate", encounter_id: "e", transcription_run_id: "t" })).toMatchObject({ ok: false, error: "bad_args" });
    expect(await run({ action: "translate" })).toMatchObject({ ok: false, error: "bad_args" });
  });

  it("A2: a run whose subject is a bench window is scope_consult_only and is not queued", async () => {
    answer = (text) => (/FROM transcription_run/.test(text) ? [{ subject_type: "bench_window" }] : []);
    const before = inserted.length;
    expect(await run({ action: "translate", transcription_run_id: "trun_w" })).toMatchObject({ ok: false, error: "scope_consult_only" });
    expect(inserted.length).toBe(before);
    expect(statements.find((s) => /FROM transcription_run/.test(s.text))!.values).toContain("trun_w");
  });
});

describe("S4 — one open job per source: the open job's id comes back", () => {
  const openRow = (over: Row = {}) => ({ id: "job_open1", kind: "sarvam_transcribe", args: { encounter_id: "enc_1", mode: "transcribe", english: true }, status: "running", step: "poll", progress: {}, result: null, error: null, actor: "mcp:a", created_at: "2026-10-08T06:00:00.000Z", started_at: null, updated_at: "x", finished_at: null, lease_until: null, lease_owner: null, attempts: 2, failures: 0, ...over });
  const findOpen = () => statements.filter((s) => /FROM scribe_job/.test(s.text) && /status IN \('queued', 'running'\)/.test(s.text) && /args->>/.test(s.text));

  it("transcribe: a second ask for the same encounter returns the open job (deduped), queues nothing, and the lookup is a bound (kind, encounter_id) match", async () => {
    answer = (text) => (/FROM scribe_job/.test(text) && /args->>/.test(text) ? [openRow()] : []);
    expect(await run({ action: "transcribe", encounter_id: "enc_1" })).toEqual({ ok: true, job_id: "job_open1", kind: "sarvam_transcribe", status: "running", deduped: true });
    expect(inserted).toEqual([]);
    const q = findOpen()[0]!;
    expect(q.values).toEqual(["sarvam_transcribe", ["encounter_id", "mode", "english", "num_speakers"], ["enc_1", "transcribe", "true", null]]);
  });
  it("G23: the options are part of the identity — the lookup carries mode, english and num_speakers (a different option is a different key); the real-SQL proof is in sarvam-runner-pg.test.ts", async () => {
    answer = () => [];
    const keysOf = async (a: Row) => { statements.length = 0; await run({ action: "transcribe", encounter_id: "enc_1", ...a }); return findOpen()[0]!.values.slice(1); };
    expect(await keysOf({})).toEqual([["encounter_id", "mode", "english", "num_speakers"], ["enc_1", "transcribe", "true", null]]);
    expect(await keysOf({ mode: "codemix" })).toEqual([["encounter_id", "mode", "english", "num_speakers"], ["enc_1", "codemix", "true", null]]);
    expect(await keysOf({ english: false, num_speakers: 2 })).toEqual([["encounter_id", "mode", "english", "num_speakers"], ["enc_1", "transcribe", "false", "2"]]);
  });

  it("no open job (none, or it already finished) -> a new job; a different encounter -> a new job", async () => {
    answer = () => [];
    expect(await run({ action: "transcribe", encounter_id: "enc_1" })).toEqual({ ok: true, job_id: "job_new1", kind: "sarvam_transcribe", status: "queued" });
    expect(await run({ action: "transcribe", encounter_id: "enc_2" })).toMatchObject({ ok: true, job_id: "job_new1" });
    expect(inserted).toHaveLength(2);
    expect(findOpen()[0]!.text).toMatch(/status IN \('queued', 'running'\)/); // done / failed / cancelled jobs are not "open"
  });
  it("translate: deduped on (source kind, id); an encounter and a run with the same id string are different sources", async () => {
    process.env.SARVAM_GW_REGION = "";
    answer = (text) => (/FROM scribe_job/.test(text) && /args->>/.test(text) ? [openRow({ id: "job_open2", kind: "sarvam_translate", args: { kind: "encounter", id: "enc_1" } })] : /FROM transcription_run/.test(text) ? [{ subject_type: "encounter" }] : []);
    expect(await run({ action: "translate", encounter_id: "enc_1" })).toMatchObject({ ok: true, job_id: "job_open2", deduped: true });
    expect(findOpen()[0]!.values).toEqual(["sarvam_translate", ["kind", "id"], ["encounter", "enc_1"]]);
    statements.length = 0;
    answer = (text) => (/FROM scribe_job/.test(text) && /args->>/.test(text) ? [openRow({ id: "job_open2", kind: "sarvam_translate", args: { kind: "transcription_run", id: "enc_1" } })] : []);
    expect(await run({ action: "translate", transcription_run_id: "enc_1" })).toMatchObject({ deduped: true });
    expect(findOpen()[0]!.values).toEqual(["sarvam_translate", ["kind", "id"], ["transcription_run", "enc_1"]]);
    expect(inserted).toEqual([]);
  });
  it("the generic scribe_job_submit path dedupes too (it goes through submitJob), and says so", async () => {
    answer = (text) => (/FROM scribe_job/.test(text) && /args->>/.test(text) ? [openRow()] : []);
    const out = (await S.CALLABLE_TOOLS.get("scribe_job_submit")!.handler({ kind: "sarvam_transcribe", args: { encounter_id: "enc_1" } }, ctxFor(["read", "invoke"]))) as Row;
    expect(out).toMatchObject({ ok: true, job_id: "job_open1", deduped: true });
    expect(inserted).toEqual([]);
  });
  it("other kinds are untouched: no open-job lookup is made for them", async () => {
    answer = () => [];
    await S.CALLABLE_TOOLS.get("scribe_job_submit")!.handler({ kind: "transcribe_range", args: { room: "opd-1", start: "2026-10-08T03:30:00Z", end: "2026-10-08T03:35:00Z" } }, ctxFor(["read", "invoke"]));
    expect(findOpen()).toEqual([]);
  });
});

describe("status / result", () => {
  const job = (over: Row = {}) => ({
    id: "job_s1", kind: "sarvam_transcribe", status: "done", step: "finish", attempts: 5, failures: 0, error: null, actor: "mcp:a",
    progress: { sarvam_job_id: "SJ_SECRETISH", clip_key: "bench/x.webm", outputs: ["0.json"], duration_ms: 600000, total_entries: 12 },
    result: { r2_key: "mcp-sarvam/job_s1.json", entries: 12, speakers: 2, language_code: "hi-IN", duration_s: 600, english: true, transcript_chars: 100, english_chars: 90 },
    created_at: "2026-10-08T06:00:00.000Z", started_at: "2026-10-08T06:00:05.000Z", updated_at: "x", finished_at: "2026-10-08T06:09:00.000Z", lease_until: null, ...over,
  });

  it("input checks: job_id required, unknown job, a non-Sarvam job", async () => {
    expect(await run({ action: "status" })).toEqual({ ok: false, error: "job_id_required" });
    expect(await run({ action: "status", job_id: "job_nope" })).toEqual({ ok: false, error: "unknown_job", job_id: "job_nope" });
    jobs.set("job_o", job({ id: "job_o", kind: "transcribe_range" }));
    expect(await run({ action: "result", job_id: "job_o" })).toEqual({ ok: false, error: "not_a_sarvam_job", job_id: "job_o", kind: "transcribe_range" });
  });

  it("status: a summary; the Sarvam job id, clip key and output names are left out; only an error CODE shows", async () => {
    jobs.set("job_s1", job({ status: "failed", error: "sarvam_submit_failed: init_502 patient said hello" }));
    const out = await run({ action: "status", job_id: "job_s1" });
    expect(out).toMatchObject({ ok: true, job_id: "job_s1", kind: "sarvam_transcribe", status: "failed", error_code: "sarvam_submit_failed", progress: { duration_ms: 600000, total_entries: 12 } });
    const s = JSON.stringify(out);
    for (const bad of ["SJ_SECRETISH", "bench/x.webm", "0.json", "patient said hello", "init_502"]) expect(s).not.toContain(bad);
  });

  it("result: the counts and the R2 key; include_text returns the stored JSON; not done / missing object are explained", async () => {
    jobs.set("job_s1", job());
    const plain = await run({ action: "result", job_id: "job_s1" });
    expect(plain).toMatchObject({ ok: true, status: "done", result: { r2_key: "mcp-sarvam/job_s1.json", entries: 12 } });
    expect(plain).not.toHaveProperty("content");
    expect(await run({ action: "result", job_id: "job_s1", include_text: true })).toMatchObject({ content: null, content_note: "no_stored_text" });
    store.set("mcp-sarvam/job_s1.json", Buffer.from(JSON.stringify({ transcript: "namaste", entries: [{ speaker_id: "0", text: "namaste", english: "hello" }] })));
    expect(await run({ action: "result", job_id: "job_s1", include_text: true })).toMatchObject({ content: { transcript: "namaste", entries: [{ english: "hello" }] } });
    jobs.set("job_r", job({ id: "job_r", status: "running", result: null }));
    expect(await run({ action: "result", job_id: "job_r", include_text: true })).toMatchObject({ content: null, content_note: "job_not_done" });
    expect(writes()).toEqual([]);
  });
});

describe("usage", () => {
  beforeEach(() => {
    answer = (text) =>
      /FROM audit_log/.test(text) && /GROUP BY 1/.test(text) ? [{ day: "2026-10-08", calls: 3, minutes: 41.5, est_cost_usd: 0.83, priced_calls: 2 }]
      : /FROM audit_log/.test(text) ? [{ minutes: 41.5 }]
      : /FROM scribe_job/.test(text) ? [{ kind: "sarvam_transcribe", status: "done", n: 2 }, { kind: "sarvam_translate", status: "failed", n: 1 }]
      : /FROM transcription_run/.test(text) ? [{ engine: "sarvam", runs: 40, cost_unreported: 40, errors: 1 }]
      : [];
  });

  it("per-day gateway minutes / estimated cost / calls, jobs by kind x status, runs with cost_unreported, today vs the cap", async () => {
    const out = await run({ action: "usage", days: 3 });
    expect(out).toMatchObject({
      ok: true,
      gateway_calls: { ok: true, days: [{ day: "2026-10-08", calls: 3, audio_minutes: 41.5, est_cost_usd: 0.83, unpriced_calls: 1 }] },
      jobs: { by_kind_status: [{ kind: "sarvam_transcribe", status: "done", count: 2 }, { kind: "sarvam_translate", status: "failed", count: 1 }] },
      transcription_runs: { engines: [{ engine: "sarvam", runs: 40, cost_unreported: 40, errors: 1 }] },
      daily_cap: { minutes_today: 41.5, cap_minutes: 240 },
    });
    expect(writes()).toEqual([]);
    expect(statements.every((s) => /^\s*SELECT/i.test(s.text))).toBe(true);
  });

  it("days clamp to 30 and say so; ist_date must be real and binds one IST day", async () => {
    expect(await run({ action: "usage", days: 400 })).toMatchObject({ clamped: true, days_applied: 30 });
    expect(await run({ action: "usage", days: 7 })).not.toHaveProperty("clamped");
    expect(await run({ action: "usage", ist_date: "2026-02-30" })).toEqual({ ok: false, error: "invalid_ist_date" });
    statements.length = 0;
    const out = await run({ action: "usage", ist_date: "2026-10-08" });
    expect(out).toMatchObject({ from: "2026-10-07T18:30:00.000Z", to: "2026-10-08T18:30:00.000Z" });
    const q = statements.find((s) => /GROUP BY 1/.test(s.text))!;
    expect(q.values).toEqual(expect.arrayContaining(["sarvam-gw", "2026-10-07T18:30:00.000Z", "2026-10-08T18:30:00.000Z"]));
  });

  it("not_collected only on SQLSTATE 42P01 / 42703, per section; other failures are ok:false for that section alone", async () => {
    answer = (text) =>
      /FROM scribe_job/.test(text) ? Object.assign(new Error('relation "scribe_job" does not exist'), { code: "42P01" })
      : /FROM transcription_run/.test(text) ? new Error('relation "x" does not exist')
      : /GROUP BY 1/.test(text) ? [] : [{ minutes: 0 }];
    const out = await run({ action: "usage" });
    expect(out.jobs).toMatchObject({ not_collected: true });
    expect(out.transcription_runs).toMatchObject({ ok: false });
    expect(out.transcription_runs).not.toHaveProperty("not_collected");
    expect(out.gateway_calls).toMatchObject({ ok: true, days: [] });
  });
});

describe("health", () => {
  it("names only; with the chain mocked it reports creds_ok and the STS expiry and never calls Sarvam; no secret is returned", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      urls.push(String(u));
      if (String(u).startsWith("https://oauth2.example.test")) return new Response(JSON.stringify({ access_token: "AT_VALUE" }), { status: 200 });
      if (String(u).startsWith("https://iamcredentials")) return new Response(JSON.stringify({ token: "IDT_VALUE" }), { status: 200 });
      return new Response(JSON.stringify({ AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: { AccessKeyId: "ASIAX", SecretAccessKey: "SAK_VALUE", SessionToken: "ST_VALUE", Expiration: exp } } } }), { status: 200 });
    }));
    const out = await run({ action: "health" }, ["read"]);
    expect(out).toMatchObject({ ok: true, lab_store_configured: false, creds_ok: true, sts_expires_at: new Date(exp * 1000).toISOString(), configured: { SARVAM_GCP_SA_KEY_JSON: true, SARVAM_GW_AUDIENCE: true, SARVAM_GW_ROLE_ARN: true, SARVAM_GW_BASE_URL: true, SARVAM_GW_REGION: true } });
    expect(urls.some((u) => u.startsWith("https://gw.example.test"))).toBe(false);
    const s = JSON.stringify(out);
    for (const bad of ["AT_VALUE", "IDT_VALUE", "SAK_VALUE", "ST_VALUE", "BEGIN PRIVATE KEY", "test-audience-000", "arn:aws"]) expect(s).not.toContain(bad);
  });

  it("D3: lab_store_configured reflects the three SCRIBE_LAB_R2_* names (values never shown)", async () => {
    process.env.SCRIBE_LAB_R2_ACCESS_KEY_ID = "x"; process.env.SCRIBE_LAB_R2_SECRET_ACCESS_KEY = "y"; process.env.SCRIBE_LAB_R2_ENDPOINT = "https://lab.example.test";
    process.env.SARVAM_GW_ROLE_ARN = "";
    const out = await run({ action: "health" }, ["read"]);
    expect(out.lab_store_configured).toBe(true);
    expect(JSON.stringify(out)).not.toContain("lab.example.test");
    delete process.env.SCRIBE_LAB_R2_ENDPOINT;
    expect((await run({ action: "health" }, ["read"])).lab_store_configured).toBe(false);
    for (const k of ["SCRIBE_LAB_R2_ACCESS_KEY_ID", "SCRIBE_LAB_R2_SECRET_ACCESS_KEY"]) delete process.env[k];
  });

  it("not configured: configured:false per name, creds_ok false", async () => {
    process.env.SARVAM_GW_ROLE_ARN = "";
    expect(await run({ action: "health" }, ["read"])).toMatchObject({ ok: true, creds_ok: false, error: "sarvam_gateway_not_configured", configured: { SARVAM_GW_ROLE_ARN: false, SARVAM_GW_REGION: true } });
  });

  it("a failing hop is reported as a code, not a body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "SECRET BODY" }), { status: 400 })));
    const out = await run({ action: "health" }, ["read"]);
    expect(out).toMatchObject({ creds_ok: false, error: "sarvam_gateway_google_token: 400 invalid_grant" });
    expect(JSON.stringify(out)).not.toContain("SECRET BODY");
  });
});
