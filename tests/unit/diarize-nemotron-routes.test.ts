/**
 * diarize-nemotron-routes.test.ts — the three worker routes (epic #23 b): token first, flag second, body third, and
 * the store's outcomes mapped to status codes. The store and R2 are mocked here; the real SQL is proven against
 * postgres:16 in diarize-nemotron-pg.test.ts. All ids are fake.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const S = vi.hoisted(() => ({
  claimPending: vi.fn(),
  countExhausted: vi.fn(),
  recordIngest: vi.fn(),
  recordHeartbeat: vi.fn(),
  signGetUrl: vi.fn(),
}));
vi.mock("@/lib/diarize-nemotron/store", async (orig) => ({
  ...(await orig<typeof import("@/lib/diarize-nemotron/store")>()),
  claimPending: S.claimPending,
  countExhausted: S.countExhausted,
  recordIngest: S.recordIngest,
  recordHeartbeat: S.recordHeartbeat,
}));
vi.mock("@/lib/r2", () => ({ signGetUrl: S.signGetUrl }));
vi.mock("@/lib/db", () => ({ sql: () => { throw new Error("no sql in a route test"); } }));

import { GET as pending } from "@/app/api/diarize/nemotron/pending/route";
import { POST as ingest } from "@/app/api/diarize/nemotron/ingest/route";
import { POST as heartbeat } from "@/app/api/diarize/nemotron/heartbeat/route";

const TOKEN = "tok-fake-123";
const ENV = ["NEMOTRON_WORKER_TOKEN", "DIARIZE_NEMOTRON_SHADOW"] as const;
const saved: Record<string, string | undefined> = {};

const CONFIG = { chunk: 340, fifo: 40 };
const CONFIG_HASH = createHash("sha256").update('{"chunk":340,"fifo":40}').digest("hex");
const okBody = {
  window_id: "bw_fake0001", room_day_id: "rd_fake0001", engine: "nemotron", model: "nvidia/Nemotron-3-Diarization",
  model_rev: "rev0fake", config: CONFIG, config_hash: CONFIG_HASH, worker_id: "box-t4-1", machine: "box",
  audio_ms: 900000, clip_sha256: "b".repeat(64), status: "ok", error_code: null, turns: [[0, 1000, "spk0"]],
};

const req = (path: string, o: { method?: string; body?: unknown; auth?: string | null; headers?: Record<string, string> } = {}) =>
  new NextRequest(`https://x.test${path}`, {
    method: o.method ?? "POST",
    headers: {
      ...(o.auth === null ? {} : { authorization: o.auth ?? `Bearer ${TOKEN}` }),
      "content-type": "application/json",
      ...(o.headers ?? {}),
    },
    ...(o.body === undefined ? {} : { body: typeof o.body === "string" ? o.body : JSON.stringify(o.body) }),
  });
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.NEMOTRON_WORKER_TOKEN = TOKEN;
  process.env.DIARIZE_NEMOTRON_SHADOW = "1";
  for (const f of Object.values(S)) f.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  vi.restoreAllMocks();
});

const ROUTES = [
  ["pending", () => pending(req("/api/diarize/nemotron/pending?worker_id=box-t4-1", { method: "GET" }))],
  ["ingest", () => ingest(req("/api/diarize/nemotron/ingest", { body: okBody }))],
  ["heartbeat", () => heartbeat(req("/api/diarize/nemotron/heartbeat", { body: { worker_id: "box-t4-1" } }))],
] as const;

describe("the gate, on every route", () => {
  it.each(ROUTES)("%s: 503 when the token is unset or blank, and nothing is called", async (_n, call) => {
    delete process.env.NEMOTRON_WORKER_TOKEN;
    expect((await call()).status).toBe(503);
    process.env.NEMOTRON_WORKER_TOKEN = "   ";
    const r = await call();
    expect(r.status).toBe(503);
    expect(await json(r)).toEqual({ ok: false, error: "not_configured" });
    for (const f of Object.values(S)) expect(f).not.toHaveBeenCalled();
  });

  it.each(ROUTES)("%s: 401 with no bearer, a wrong one, or a longer one", async (n) => {
    const path = n === "pending" ? "/api/diarize/nemotron/pending?worker_id=w" : `/api/diarize/nemotron/${n}`;
    const handler = n === "pending" ? pending : n === "ingest" ? ingest : heartbeat;
    const method = n === "pending" ? "GET" : "POST";
    const body = n === "pending" ? undefined : {};
    for (const auth of [null, "Bearer nope", `Bearer ${TOKEN}x`, `Basic ${TOKEN}`]) {
      expect((await handler(req(path, { method, body, auth }))).status).toBe(401);
    }
    for (const f of Object.values(S)) expect(f).not.toHaveBeenCalled();
  });

  it("a token saved with a trailing newline still matches", async () => {
    process.env.NEMOTRON_WORKER_TOKEN = `${TOKEN}\n`;
    S.recordHeartbeat.mockResolvedValue(undefined);
    expect((await heartbeat(req("/api/diarize/nemotron/heartbeat", { body: { worker_id: "w" } }))).status).toBe(200);
  });

  it.each(ROUTES)("%s: flag off → 404 disabled, after auth, before any store call", async (_n, call) => {
    delete process.env.DIARIZE_NEMOTRON_SHADOW;
    const r = await call();
    expect(r.status).toBe(404);
    expect(await json(r)).toEqual({ ok: false, error: "disabled" });
    process.env.DIARIZE_NEMOTRON_SHADOW = "0";
    expect((await call()).status).toBe(404);
    for (const f of Object.values(S)) expect(f).not.toHaveBeenCalled();
  });

  it.each(ROUTES)("%s: a mistyped flag is a 500, never read as on or off", async (_n, call) => {
    process.env.DIARIZE_NEMOTRON_SHADOW = "yes please";
    const r = await call();
    expect(r.status).toBe(500);
    expect(await json(r)).toEqual({ ok: false, error: "bad_flag" });
  });

  it("an unauthenticated caller cannot learn the flag: off and on both answer 401", async () => {
    delete process.env.DIARIZE_NEMOTRON_SHADOW;
    expect((await pending(req("/api/diarize/nemotron/pending?worker_id=w", { method: "GET", auth: null }))).status).toBe(401);
  });
});

describe("GET /pending", () => {
  it("400 without a valid worker_id", async () => {
    expect((await pending(req("/api/diarize/nemotron/pending", { method: "GET" }))).status).toBe(400);
    expect((await pending(req("/api/diarize/nemotron/pending?worker_id=a%20b", { method: "GET" }))).status).toBe(400);
    expect(S.claimPending).not.toHaveBeenCalled();
  });

  it("claims with the clamped limit, signs each clip for 30 min, and returns ids, times and URLs only", async () => {
    S.claimPending.mockResolvedValue([
      { window_id: "bw_1", room_day_id: "rd_1", start_ms: 1000, end_ms: 901000, clip_r2_key: "clips/fake1.webm", attempts: 1 },
    ]);
    S.countExhausted.mockResolvedValue(2);
    S.signGetUrl.mockResolvedValue("https://r2.test/signed");
    const r = await pending(req("/api/diarize/nemotron/pending?worker_id=box-t4-1&limit=99", { method: "GET" }));
    expect(r.status).toBe(200);
    expect(S.claimPending).toHaveBeenCalledWith("box-t4-1", 8);
    expect(S.signGetUrl).toHaveBeenCalledWith({ key: "clips/fake1.webm", expiresInSeconds: 1800 });
    expect(await json(r)).toEqual({
      ok: true,
      exhausted: 2,
      windows: [{ window_id: "bw_1", room_day_id: "rd_1", start_ms: 1000, end_ms: 901000, clip_url: "https://r2.test/signed", clip_sha256: null, attempt: 1 }],
    });
  });

  it("503 on a store fault", async () => {
    S.claimPending.mockRejectedValue(new Error("db down"));
    expect((await pending(req("/api/diarize/nemotron/pending?worker_id=w", { method: "GET" }))).status).toBe(503);
  });
});

describe("POST /ingest", () => {
  const post = (body: unknown, headers?: Record<string, string>) => ingest(req("/api/diarize/nemotron/ingest", { body, headers }));

  it("400 on bad JSON or a refused body, with the code and no store call", async () => {
    expect(await json(await post("{nope"))).toEqual({ ok: false, error: "bad_json" });
    const r = await post({ ...okBody, transcript: "x" });
    expect(r.status).toBe(400);
    expect(await json(r)).toEqual({ ok: false, error: "unknown_field" });
    expect(S.recordIngest).not.toHaveBeenCalled();
  });

  it("413 over 1 MB by header and by length", async () => {
    expect((await post(okBody, { "content-length": "1000001" })).status).toBe(413);
    expect((await post({ ...okBody, pad: "x".repeat(1_000_001) })).status).toBe(413);
    expect(S.recordIngest).not.toHaveBeenCalled();
  });

  it("passes the validated body, derived counts and payload hash to the store", async () => {
    S.recordIngest.mockResolvedValue({ result: "stored", id: 7, label: "skipped" });
    const r = await post(okBody);
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ ok: true, result: "stored", id: 7, label: "skipped" });
    const [b, d, h] = S.recordIngest.mock.calls[0]!;
    expect(b).toMatchObject({ window_id: "bw_fake0001", status: "ok" });
    expect(d).toEqual({ speaker_count: 1, turn_count: 1, speech_ms: 1000, overlap_ms: 0 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    [{ result: "duplicate" }, 200],
    [{ result: "failure_recorded", attempts: 2 }, 200],
    [{ result: "no_live_claim" }, 200],
    [{ result: "unknown_window" }, 404],
    [{ result: "conflict" }, 409],
    [{ result: "room_day_mismatch" }, 409],
  ])("store says %j → %i", async (out, status) => {
    S.recordIngest.mockResolvedValue(out);
    expect((await post(okBody)).status).toBe(status);
  });

  it("503 on a store fault", async () => {
    S.recordIngest.mockRejectedValue(new Error("db down"));
    expect(await json(await post(okBody))).toEqual({ ok: false, error: "db" });
  });
});

describe("POST /heartbeat", () => {
  it("stores the allow-listed payload; 400 on a bad one; 503 on a fault", async () => {
    S.recordHeartbeat.mockResolvedValue(undefined);
    const ok = await heartbeat(req("/api/diarize/nemotron/heartbeat", { body: { worker_id: "box-t4-1", queue_depth: 3, extra: "dropped" } }));
    expect(ok.status).toBe(200);
    expect(S.recordHeartbeat).toHaveBeenCalledWith("box-t4-1", { queue_depth: 3 });
    expect((await heartbeat(req("/api/diarize/nemotron/heartbeat", { body: { worker_id: "" } }))).status).toBe(400);
    S.recordHeartbeat.mockRejectedValue(new Error("db down"));
    expect((await heartbeat(req("/api/diarize/nemotron/heartbeat", { body: { worker_id: "w" } }))).status).toBe(503);
  });
});
