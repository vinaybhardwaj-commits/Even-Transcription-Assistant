/**
 * Overnight translate — the door client. It speaks JSON-RPC to /api/mcp with a bearer, calls exactly two tools,
 * and sorts every failure into fatal / refused / deferred, because the three call for three different actions:
 * stop, skip this window, or try again later. And the token stays in a closure: it is never on a returned value.
 * No network — a fake fetch is injected.
 */
import { describe, it, expect } from "vitest";
import { makeDoor, type RoomWindowSubmit } from "@/lib/overnight-translate/door";

const TOKEN = "TOKEN-SECRET-abc123-do-not-leak";
const BASE = "https://www.evenscribe.app";
const ARGS: RoomWindowSubmit = { window_id: "bw_1", origin: BASE, actor: "overnight-translate", via: "mcp", translate: true };

type Req = { url: string; init: RequestInit };
function fakeFetch(reply: (n: number) => Response | Promise<Response> | Error): { f: typeof fetch; reqs: Req[] } {
  const reqs: Req[] = [];
  const f = (async (url: unknown, init?: RequestInit) => {
    reqs.push({ url: String(url), init: init ?? {} });
    const r = await reply(reqs.length);
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { f, reqs };
}
const rpc = (structured: unknown, status = 200) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "x" }], structuredContent: structured, isError: false } }), { status, headers: { "content-type": "application/json" } });
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const door = (f: typeof fetch, over: Partial<{ baseUrl: string; token: string }> = {}) => makeDoor({ baseUrl: BASE, token: TOKEN, ...over }, f);

describe("the request", () => {
  it("POSTs JSON-RPC tools/call to <base>/api/mcp with the bearer in the Authorization header", async () => {
    const { f, reqs } = fakeFetch(() => rpc({ ok: true, job_id: "job_1", kind: "room_window", status: "queued" }));
    await door(f).submitRoomWindow(ARGS);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.url).toBe("https://www.evenscribe.app/api/mcp");
    expect(reqs[0]!.init.method).toBe("POST");
    const h = reqs[0]!.init.headers as Record<string, string>;
    expect(h.authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(String(reqs[0]!.init.body));
    expect(body).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "scribe_job_submit", arguments: { kind: "room_window", args: ARGS } } });
  });
  it("the token is in the header and NOWHERE else on the wire (not the URL, not the body)", async () => {
    const { f, reqs } = fakeFetch(() => rpc({ ok: true, job_id: "job_1" }));
    await door(f).submitRoomWindow(ARGS);
    await door(f).jobStatus("job_1");
    for (const r of reqs) {
      expect(r.url).not.toContain(TOKEN);
      expect(String(r.init.body)).not.toContain(TOKEN);
    }
  });
  it("a base URL with trailing slashes still yields exactly one /api/mcp", async () => {
    const { f, reqs } = fakeFetch(() => rpc({ ok: true, job_id: "j" }));
    await door(f, { baseUrl: "https://www.evenscribe.app///" }).submitRoomWindow(ARGS);
    expect(reqs[0]!.url).toBe("https://www.evenscribe.app/api/mcp");
  });
  it("submits ONLY scribe_job_submit and reads ONLY scribe_job_status — the two tools the token's scopes are for", async () => {
    const { f, reqs } = fakeFetch(() => rpc({ ok: true, job_id: "job_1", status: "done" }));
    const d = door(f);
    await d.submitRoomWindow(ARGS);
    await d.jobStatus("job_1");
    expect(reqs.map((r) => JSON.parse(String(r.init.body)).params.name)).toEqual(["scribe_job_submit", "scribe_job_status"]);
  });
  it("passes the override through only when the caller put it in the args", async () => {
    const { f, reqs } = fakeFetch(() => rpc({ ok: true, job_id: "j" }));
    await door(f).submitRoomWindow({ ...ARGS, switch_override: true });
    expect(JSON.parse(String(reqs[0]!.init.body)).params.arguments.args.switch_override).toBe(true);
    await door(f).submitRoomWindow(ARGS);
    expect(Object.keys(JSON.parse(String(reqs[1]!.init.body)).params.arguments.args)).not.toContain("switch_override");
  });
});

describe("submitRoomWindow — outcomes", () => {
  it("ok → the job id", async () => {
    const { f } = fakeFetch(() => rpc({ ok: true, job_id: "job_9", kind: "room_window", status: "queued" }));
    expect(await door(f).submitRoomWindow(ARGS)).toEqual({ ok: true, job_id: "job_9" });
  });
  it("401 → FATAL mcp_auth_refused (a refused credential would fail every window in turn)", async () => {
    expect(await door(fakeFetch(() => json(401)).f).submitRoomWindow(ARGS)).toEqual({ ok: false, kind: "fatal", code: "mcp_auth_refused" });
  });
  it("403 (-32001 scope_or_tool_unavailable: the token lacks `invoke`) → FATAL mcp_scope_refused", async () => {
    const r = await door(fakeFetch(() => json(403, { jsonrpc: "2.0", id: 1, error: { code: -32001, message: "scope_or_tool_unavailable" } })).f).submitRoomWindow(ARGS);
    expect(r).toEqual({ ok: false, kind: "fatal", code: "mcp_scope_refused" });
  });
  it("a tool-level refusal (bad_args, unknown_kind) is REFUSED — about this window, not the run", async () => {
    for (const code of ["bad_args", "unknown_kind"]) {
      const r = await door(fakeFetch(() => rpc({ ok: false, error: code, detail: "translate must be a boolean" })).f).submitRoomWindow(ARGS);
      expect(r).toEqual({ ok: false, kind: "refused", code });
    }
  });
  it("an error string that is not a closed code is NOT echoed — it becomes submit_refused", async () => {
    const r = await door(fakeFetch(() => rpc({ ok: false, error: "Something failed for window bw_1: <free text with a name>" })).f).submitRoomWindow(ARGS);
    expect(r).toEqual({ ok: false, kind: "refused", code: "submit_refused" });
  });
  it("network trouble, a timeout, a 5xx, non-JSON and a JSON-RPC error are all DEFERRED, with distinct closed codes", async () => {
    expect(await door(fakeFetch(() => new Error("ECONNRESET")).f).submitRoomWindow(ARGS)).toEqual({ ok: false, kind: "deferred", code: "mcp_unreachable" });
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    expect(await door(fakeFetch(() => timeout).f).submitRoomWindow(ARGS)).toEqual({ ok: false, kind: "deferred", code: "mcp_timeout" });
    expect(await door(fakeFetch(() => json(502)).f).submitRoomWindow(ARGS)).toEqual({ ok: false, kind: "deferred", code: "mcp_http_error" });
    expect(await door(fakeFetch(() => new Response("<html>", { status: 200 })).f).submitRoomWindow(ARGS)).toEqual({ ok: false, kind: "deferred", code: "mcp_http_error" });
    expect(await door(fakeFetch(() => json(200, { jsonrpc: "2.0", id: 1, error: { code: -32603 } })).f).submitRoomWindow(ARGS)).toEqual({ ok: false, kind: "deferred", code: "mcp_rpc_error" });
    expect(await door(fakeFetch(() => json(200, { result: {} })).f).submitRoomWindow(ARGS)).toEqual({ ok: false, kind: "deferred", code: "mcp_http_error" });
  });
  it("ok:true without a job id is not a success", async () => {
    expect((await door(fakeFetch(() => rpc({ ok: true })).f).submitRoomWindow(ARGS)).ok).toBe(false);
    expect((await door(fakeFetch(() => rpc({ ok: true, job_id: "" })).f).submitRoomWindow(ARGS)).ok).toBe(false);
  });
  it("no token or no base URL → FATAL mcp_not_configured, and the network is never touched", async () => {
    const { f, reqs } = fakeFetch(() => rpc({ ok: true, job_id: "j" }));
    expect(await door(f, { token: "" }).submitRoomWindow(ARGS)).toEqual({ ok: false, kind: "fatal", code: "mcp_not_configured" });
    expect(await door(f, { baseUrl: "" }).jobStatus("j")).toEqual({ ok: false, kind: "fatal", code: "mcp_not_configured" });
    expect(reqs).toHaveLength(0);
  });
});

describe("jobStatus", () => {
  it("reads status, step, the published error_code and the attempt counters", async () => {
    const { f } = fakeFetch(() => rpc({ ok: true, job_id: "job_1", status: "failed", step: "segment", attempts: 2, failures: 1, error_code: "room_window_failed" }));
    expect(await door(f).jobStatus("job_1")).toEqual({ ok: true, status: "failed", step: "segment", error_code: "room_window_failed", attempts: 2, failures: 1, join_contended: false });
  });
  it("every published state parses; an unknown one is 'unknown', never trusted", async () => {
    for (const st of ["queued", "running", "done", "failed", "cancelled"]) {
      expect(await door(fakeFetch(() => rpc({ ok: true, status: st })).f).jobStatus("j")).toMatchObject({ ok: true, status: st });
    }
    expect(await door(fakeFetch(() => rpc({ ok: true, status: "exploded" })).f).jobStatus("j")).toMatchObject({ ok: true, status: "unknown" });
  });
  it("an error_code that is not a closed code is dropped", async () => {
    expect(await door(fakeFetch(() => rpc({ ok: true, status: "failed", error_code: "boom: patient text here!" })).f).jobStatus("j")).toMatchObject({ error_code: null });
  });
  it("unknown_job is REFUSED (about that job), 401/403 are FATAL, 5xx is DEFERRED", async () => {
    expect(await door(fakeFetch(() => rpc({ ok: false, error: "unknown_job", job_id: "j" })).f).jobStatus("j")).toEqual({ ok: false, kind: "refused", code: "unknown_job" });
    expect(await door(fakeFetch(() => json(401)).f).jobStatus("j")).toMatchObject({ kind: "fatal", code: "mcp_auth_refused" });
    expect(await door(fakeFetch(() => json(403)).f).jobStatus("j")).toMatchObject({ kind: "fatal", code: "mcp_scope_refused" });
    expect(await door(fakeFetch(() => json(503)).f).jobStatus("j")).toMatchObject({ kind: "deferred" });
  });
});

describe("join_contended — the ONE place this driver reads the raw (invoke-scope-only) error string (V, 22 Sep 2026 08:20)", () => {
  it("true when the raw error names the join service's own mutex refusal", async () => {
    const r = await door(fakeFetch(() => rpc({ ok: true, status: "failed", error_code: "room_window_failed", error: "room_window_failed: join_failed: join_already_running" })).f).jobStatus("j");
    expect(r).toMatchObject({ ok: true, join_contended: true });
  });
  it("false for every OTHER failure, including a different join_failed reason (e.g. ffmpeg_failed)", async () => {
    for (const err of ["room_window_failed: join_failed: ffmpeg_failed", "room_window_failed: whisper_failed", "", undefined]) {
      const r = await door(fakeFetch(() => rpc({ ok: true, status: "failed", error_code: "room_window_failed", ...(err === undefined ? {} : { error: err }) })).f).jobStatus("j");
      expect(r, JSON.stringify(err)).toMatchObject({ join_contended: false });
    }
  });
  it("false for a done job (no error at all)", async () => {
    const r = await door(fakeFetch(() => rpc({ ok: true, status: "done" })).f).jobStatus("j");
    expect(r).toMatchObject({ ok: true, status: "done", join_contended: false });
  });
  it("the raw error string itself is NEVER on the returned object — only the reduced boolean", async () => {
    const r = await door(fakeFetch(() => rpc({ ok: true, status: "failed", error: "room_window_failed: join_failed: join_already_running — some free text that could quote audio" })).f).jobStatus("j");
    expect(JSON.stringify(r)).not.toContain("free text");
    expect(Object.keys(r)).not.toContain("error");
  });
});

describe("the token never leaves the closure", () => {
  it("no result of any kind contains it", async () => {
    const replies: Array<() => Response | Error> = [
      () => rpc({ ok: true, job_id: "j", status: "done" }), () => json(401), () => json(403), () => json(500), () => new Error(`network ${TOKEN}`),
      () => rpc({ ok: false, error: `bad ${TOKEN}` }), () => new Response(TOKEN, { status: 200 }),
    ];
    for (const r of replies) {
      const d = door(fakeFetch(() => r()).f);
      expect(JSON.stringify(await d.submitRoomWindow(ARGS))).not.toContain(TOKEN);
      expect(JSON.stringify(await d.jobStatus("j"))).not.toContain(TOKEN);
    }
  });
  it("the door object itself carries no token property", () => {
    const d = door(fakeFetch(() => rpc({})).f);
    expect(JSON.stringify(d)).not.toContain(TOKEN);
    expect(Object.keys(d).sort()).toEqual(["jobStatus", "submitRoomWindow"]);
  });
});
