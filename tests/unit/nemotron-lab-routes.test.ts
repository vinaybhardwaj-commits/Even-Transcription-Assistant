/**
 * nemotron-lab-routes.test.ts — the LAB lane's two worker routes (/lab/claim, /lab/ingest) and the production routes' probability additions (0143):
 * token first, shadow flag second, lab flag third; production-pending wins over lab; the server's own R2 keys only; allow-list refusals never reach SQL.
 * The stores and R2 are mocked here; the real SQL is proven against postgres:16 in nemotron-lab-pg.test.ts. All ids are fake.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const S = vi.hoisted(() => ({
  productionPendingExists: vi.fn(),
  claimLabItems: vi.fn(),
  releaseLabClaim: vi.fn(),
  readLabItemForIngest: vi.fn(),
  recordLabIngest: vi.fn(),
  claimPending: vi.fn(),
  countExhausted: vi.fn(),
  recordIngest: vi.fn(),
  releaseClaim: vi.fn(),
  needsJob: vi.fn(),
  submitJob: vi.fn(),
  signGetUrl: vi.fn(),
  signPutUrl: vi.fn(),
  headObject: vi.fn(),
}));
vi.mock("@/lib/room-access/nemotron-lab-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/room-access/nemotron-lab-store")>()),
  claimLabItems: S.claimLabItems,
  releaseLabClaim: S.releaseLabClaim,
  readLabItemForIngest: S.readLabItemForIngest,
  recordLabIngest: S.recordLabIngest,
}));
vi.mock("@/lib/room-access/nemotron-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/room-access/nemotron-store")>()),
  productionPendingExists: S.productionPendingExists,
  claimPending: S.claimPending,
  countExhausted: S.countExhausted,
  recordIngest: S.recordIngest,
  releaseClaim: S.releaseClaim,
  windowNeedsDiarizeJob: S.needsJob,
}));
vi.mock("@/lib/jobs/submit", async (orig) => ({ ...(await orig<Record<string, unknown>>()), submitJob: S.submitJob }));
vi.mock("@/lib/r2", () => ({ signGetUrl: S.signGetUrl, signPutUrl: S.signPutUrl, headObject: S.headObject }));
vi.mock("@/lib/db", () => ({ sql: () => { throw new Error("no sql in a route test"); } }));

import { GET as claim } from "@/app/api/diarize/nemotron/lab/claim/route";
import { POST as labIngest } from "@/app/api/diarize/nemotron/lab/ingest/route";
import { GET as pending } from "@/app/api/diarize/nemotron/pending/route";
import { POST as ingest } from "@/app/api/diarize/nemotron/ingest/route";
import { parseLabSpec } from "@/lib/diarize-nemotron/lab";

const TOKEN = "tok-fake-lab";
const ENV = ["NEMOTRON_WORKER_TOKEN", "DIARIZE_NEMOTRON_SHADOW", "NEMOTRON_LAB_ENABLED"] as const;
const saved: Record<string, string | undefined> = {};

const req = (path: string, o: { method?: string; body?: unknown; auth?: string | null } = {}) =>
  new NextRequest(`https://x.test${path}`, {
    method: o.method ?? "POST",
    headers: { ...(o.auth === null ? {} : { authorization: o.auth ?? `Bearer ${TOKEN}` }), "content-type": "application/json" },
    ...(o.body === undefined ? {} : { body: typeof o.body === "string" ? o.body : JSON.stringify(o.body) }),
  });
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const CLAIM_URL = "/api/diarize/nemotron/lab/claim?worker_id=box-1";

const SPEC_PLAIN = parseLabSpec(undefined);
const SPEC_FILES = parseLabSpec({ return_probs: true, return_embeddings: "ecapa" });
const claimed = (spec = SPEC_PLAIN) => ({ run_id: "job_abc", idx: 0, clip_r2_key: "clips/bs_x/a.webm", attempt: 1, spec, spec_hash: "a".repeat(64) });

const labBody = (o: Record<string, unknown> = {}) => ({
  run_id: "job_abc", idx: 0, worker_id: "box-1", status: "ok", error_code: null, model: "nvidia/Nemotron-3-Diarization", model_rev: "rev1", config: { chunk_len: 340 },
  spec_hash: "a".repeat(64), audio_ms: 900000, clip_sha256: "b".repeat(64), turns: [[0, 4000, "spk0"]],
  probs_r2_key: null, embeddings_r2_key: null, embeddings_dims: null, infer_s: 3, ...o,
});

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.NEMOTRON_WORKER_TOKEN = TOKEN;
  process.env.DIARIZE_NEMOTRON_SHADOW = "1";
  process.env.NEMOTRON_LAB_ENABLED = "1";
  for (const f of Object.values(S)) f.mockReset();
  S.signGetUrl.mockImplementation(async ({ key }: { key: string }) => `https://r2.test/get/${key}`);
  S.signPutUrl.mockImplementation(async ({ key }: { key: string }) => `https://r2.test/put/${key}`);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  vi.restoreAllMocks();
});

const LAB_ROUTES = [
  ["lab/claim", () => claim(req(CLAIM_URL, { method: "GET" }))],
  ["lab/ingest", () => labIngest(req("/api/diarize/nemotron/lab/ingest", { body: labBody() }))],
] as const;
const noStore = () => {
  for (const f of [S.productionPendingExists, S.claimLabItems, S.releaseLabClaim, S.readLabItemForIngest, S.recordLabIngest, S.signGetUrl, S.signPutUrl, S.headObject]) expect(f).not.toHaveBeenCalled();
};

describe("the lab gate: token first, shadow flag second, lab flag third", () => {
  it.each(LAB_ROUTES)("%s: 503 with no token configured, 401 with a wrong or missing bearer; nothing is touched", async (_n, call) => {
    delete process.env.NEMOTRON_WORKER_TOKEN;
    expect((await call()).status).toBe(503);
    process.env.NEMOTRON_WORKER_TOKEN = TOKEN;
    const r = await (_n === "lab/claim" ? claim(req(CLAIM_URL, { method: "GET", auth: "Bearer wrong" })) : labIngest(req("/x", { body: labBody(), auth: "Bearer wrong" })));
    expect(r.status).toBe(401);
    const none = await (_n === "lab/claim" ? claim(req(CLAIM_URL, { method: "GET", auth: null })) : labIngest(req("/x", { body: labBody(), auth: null })));
    expect(none.status).toBe(401);
    noStore();
  });
  it.each(LAB_ROUTES)("%s: the token is checked BEFORE the flags (an unauthenticated caller learns nothing)", async (_n, call) => {
    delete process.env.NEMOTRON_LAB_ENABLED;
    delete process.env.DIARIZE_NEMOTRON_SHADOW;
    const r = _n === "lab/claim" ? await claim(req(CLAIM_URL, { method: "GET", auth: "Bearer wrong" })) : await labIngest(req("/x", { body: labBody(), auth: "Bearer wrong" }));
    expect(r.status).toBe(401);
    expect(await call()).toBeInstanceOf(Response);
    noStore();
  });
  it.each(LAB_ROUTES)("%s: shadow off → 404 disabled; lab off → 404 lab_disabled; a typo → 500 bad_flag", async (_n, call) => {
    process.env.DIARIZE_NEMOTRON_SHADOW = "0";
    let r = await call();
    expect([r.status, (await json(r)).error]).toEqual([404, "disabled"]);
    process.env.DIARIZE_NEMOTRON_SHADOW = "1";
    process.env.NEMOTRON_LAB_ENABLED = "0";
    r = await call();
    expect([r.status, (await json(r)).error]).toEqual([404, "lab_disabled"]);
    delete process.env.NEMOTRON_LAB_ENABLED;
    r = await call();
    expect(r.status).toBe(404);
    process.env.NEMOTRON_LAB_ENABLED = "maybe";
    r = await call();
    expect([r.status, (await json(r)).error]).toEqual([500, "bad_flag"]);
    noStore();
  });
});

describe("lab/claim", () => {
  it("answers production_pending and claims NOTHING while the production queue has a window", async () => {
    S.productionPendingExists.mockResolvedValue(true);
    const r = await claim(req(CLAIM_URL, { method: "GET" }));
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ ok: true, items: [], reason: "production_pending" });
    expect(S.claimLabItems).not.toHaveBeenCalled();
  });
  it("hands back the item with a clip URL and no PUT URLs when the spec asks for no files", async () => {
    S.productionPendingExists.mockResolvedValue(false);
    S.claimLabItems.mockResolvedValue([claimed()]);
    const out = await json(await claim(req(CLAIM_URL, { method: "GET" })));
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ run_id: "job_abc", idx: 0, clip_url: "https://r2.test/get/clips/bs_x/a.webm", spec: SPEC_PLAIN, spec_hash: "a".repeat(64) });
    expect(out.items[0]).not.toHaveProperty("probs_put_url");
    expect(out.items[0]).not.toHaveProperty("embeddings_put_url");
    expect(S.signPutUrl).not.toHaveBeenCalled();
  });
  it("signs a PUT only for the files the spec asked for, at keys the SERVER chose", async () => {
    S.productionPendingExists.mockResolvedValue(false);
    S.claimLabItems.mockResolvedValue([claimed(SPEC_FILES)]);
    const out = await json(await claim(req(CLAIM_URL, { method: "GET" })));
    expect(out.items[0]).toMatchObject({
      probs_key: "lab/nemotron/job_abc/0/probs.nlp", probs_put_url: "https://r2.test/put/lab/nemotron/job_abc/0/probs.nlp",
      embeddings_key: "lab/nemotron/job_abc/0/emb.nlp", embeddings_put_url: "https://r2.test/put/lab/nemotron/job_abc/0/emb.nlp",
    });
  });
  it("a signing failure gives every claim back and answers 503 clip_sign", async () => {
    S.productionPendingExists.mockResolvedValue(false);
    S.claimLabItems.mockResolvedValue([claimed(), { ...claimed(), idx: 1 }]);
    S.signGetUrl.mockRejectedValue(new Error("r2 down"));
    const r = await claim(req(CLAIM_URL, { method: "GET" }));
    expect([r.status, (await json(r)).error]).toEqual([503, "clip_sign"]);
    expect(S.releaseLabClaim.mock.calls.map((c) => [c[1], c[2]])).toEqual([["job_abc", 0], ["job_abc", 1]]);
  });
  it("rejects a bad worker id (400) and clamps the limit to 1..4", async () => {
    expect((await claim(req("/api/diarize/nemotron/lab/claim?worker_id=a%20b", { method: "GET" }))).status).toBe(400);
    S.productionPendingExists.mockResolvedValue(false);
    S.claimLabItems.mockResolvedValue([]);
    await claim(req("/api/diarize/nemotron/lab/claim?worker_id=box-1&limit=99", { method: "GET" }));
    await claim(req("/api/diarize/nemotron/lab/claim?worker_id=box-1&limit=0", { method: "GET" }));
    await claim(req("/api/diarize/nemotron/lab/claim?worker_id=box-1", { method: "GET" }));
    expect(S.claimLabItems.mock.calls.map((c) => c[1])).toEqual([4, 1, 1]);
  });
  it("a database failure is 503 db and says nothing else", async () => {
    S.productionPendingExists.mockRejectedValue(new Error("neon: connection string postgres://secret"));
    const r = await claim(req(CLAIM_URL, { method: "GET" }));
    expect(r.status).toBe(503);
    expect(JSON.stringify(await json(r))).not.toContain("secret");
  });
});

describe("lab/ingest", () => {
  const item = (spec = SPEC_FILES) => ({ spec, spec_hash: "a".repeat(64), state: "queued" });
  const post = (b: unknown) => labIngest(req("/api/diarize/nemotron/lab/ingest", { body: b }));

  it("refuses a body that is not the closed shape (400) before any store call", async () => {
    for (const bad of [labBody({ transcript: "x" }), labBody({ status: "nope" }), labBody({ turns: [[0, 1, "Dr Rao"]] }), "not json", labBody({ idx: -1 })]) {
      const r = await post(bad);
      expect(r.status).toBe(400);
    }
    expect(S.readLabItemForIngest).not.toHaveBeenCalled();
    expect(S.recordLabIngest).not.toHaveBeenCalled();
  });
  it("413 on an oversized body", async () => {
    const r = await post(JSON.stringify(labBody({ turns: [] })) + " ".repeat(1_000_001));
    expect(r.status).toBe(413);
  });
  it("404 unknown_item when the run/idx does not exist", async () => {
    S.readLabItemForIngest.mockResolvedValue(null);
    expect((await post(labBody())).status).toBe(404);
    expect(S.recordLabIngest).not.toHaveBeenCalled();
  });
  it("stores a plain ok result", async () => {
    S.readLabItemForIngest.mockResolvedValue(item());
    S.recordLabIngest.mockResolvedValue({ result: "stored", state: "ok" });
    const r = await post(labBody());
    expect([r.status, await json(r)]).toEqual([200, { ok: true, result: "stored", state: "ok" }]);
    expect(S.recordLabIngest).toHaveBeenCalledOnce();
    expect(S.headObject).not.toHaveBeenCalled();
  });
  it("accepts the server's own probs / embeddings keys when the objects exist", async () => {
    S.readLabItemForIngest.mockResolvedValue(item());
    S.recordLabIngest.mockResolvedValue({ result: "stored", state: "ok" });
    S.headObject.mockResolvedValue({ size: 123, content_type: null });
    const r = await post(labBody({ probs_r2_key: "lab/nemotron/job_abc/0/probs.nlp", embeddings_r2_key: "lab/nemotron/job_abc/0/emb.nlp", embeddings_dims: 192 }));
    expect(r.status).toBe(200);
    expect(S.headObject.mock.calls.map((c) => c[0])).toEqual(["lab/nemotron/job_abc/0/probs.nlp", "lab/nemotron/job_abc/0/emb.nlp"]);
  });
  it("422 for a key that is another item's, another run's, or not asked for by the spec", async () => {
    S.readLabItemForIngest.mockResolvedValue(item());
    for (const over of [
      { probs_r2_key: "lab/nemotron/job_other/0/probs.nlp" },
      { probs_r2_key: "lab/nemotron/job_abc/1/probs.nlp" },
      { embeddings_r2_key: "lab/nemotron/job_abc/0/probs.nlp", embeddings_dims: 4 },
    ]) {
      const r = await post(labBody(over));
      expect(r.status).toBe(422);
    }
    S.readLabItemForIngest.mockResolvedValue(item(SPEC_PLAIN)); // spec asked for no files
    expect((await post(labBody({ probs_r2_key: "lab/nemotron/job_abc/0/probs.nlp" }))).status).toBe(422);
    expect(S.recordLabIngest).not.toHaveBeenCalled();
  });
  it("422 file_missing when the object is not in R2", async () => {
    S.readLabItemForIngest.mockResolvedValue(item());
    S.headObject.mockResolvedValue({ size: null, content_type: null });
    const r = await post(labBody({ probs_r2_key: "lab/nemotron/job_abc/0/probs.nlp" }));
    expect([r.status, (await json(r)).error]).toEqual([422, "file_missing"]);
    expect(S.recordLabIngest).not.toHaveBeenCalled();
  });
  it("409 spec_mismatch, and the no-op outcomes are 200", async () => {
    S.readLabItemForIngest.mockResolvedValue(item());
    S.recordLabIngest.mockResolvedValue({ result: "spec_mismatch" });
    expect((await post(labBody())).status).toBe(409);
    for (const result of ["already_done", "no_live_claim"]) {
      S.recordLabIngest.mockResolvedValue({ result });
      expect(await json(await post(labBody()))).toEqual({ ok: true, result });
    }
    S.recordLabIngest.mockResolvedValue({ result: "failure_recorded", attempts: 1 });
    expect(await json(await post(labBody({ status: "failed", error_code: "infer_failed", turns: [], clip_sha256: null, audio_ms: 0 })))).toEqual({ ok: true, result: "failure_recorded", attempts: 1 });
  });
  it("a database failure is 503 db", async () => {
    S.readLabItemForIngest.mockRejectedValue(new Error("down"));
    expect((await post(labBody())).status).toBe(503);
  });
});

describe("production /pending and /ingest: the probability additions", () => {
  const w = { window_id: "bw_fake0001", room_day_id: "rd_fake0001", start_ms: 0, end_ms: 900000, clip_r2_key: "bench/x/y.webm", attempts: 1 };
  it("pending adds probs_key + probs_put_url per window", async () => {
    S.claimPending.mockResolvedValue([w]);
    S.countExhausted.mockResolvedValue(0);
    const out = await json(await pending(req("/api/diarize/nemotron/pending?worker_id=box-1", { method: "GET" })));
    expect(out.windows[0]).toMatchObject({ window_id: "bw_fake0001", probs_key: "lab/nemotron-probs/bw_fake0001.nlp", probs_put_url: "https://r2.test/put/lab/nemotron-probs/bw_fake0001.nlp" });
  });
  it("pending still works when a PUT URL cannot be signed: the fields are simply absent", async () => {
    S.claimPending.mockResolvedValue([w]);
    S.countExhausted.mockResolvedValue(0);
    S.signPutUrl.mockRejectedValue(new Error("r2 put signing down"));
    const r = await pending(req("/api/diarize/nemotron/pending?worker_id=box-1", { method: "GET" }));
    expect(r.status).toBe(200);
    const out = await json(r);
    expect(out.windows[0].clip_url).toBe("https://r2.test/get/bench/x/y.webm");
    expect(out.windows[0]).not.toHaveProperty("probs_put_url");
  });

  const CONFIG = { chunk: 340 };
  const prodBody = (o: Record<string, unknown> = {}) => ({
    window_id: "bw_fake0001", room_day_id: "rd_fake0001", engine: "nemotron", model: "nvidia/Nemotron-3-Diarization", model_rev: "rev0fake", config: CONFIG,
    config_hash: createHash("sha256").update('{"chunk":340}').digest("hex"), worker_id: "box-1", machine: "box", audio_ms: 900000, clip_sha256: "b".repeat(64),
    status: "ok", error_code: null, turns: [[0, 1000, "spk0"]], ...o,
  });
  it("ingest stores the pointer only when the object exists, and says which", async () => {
    S.recordIngest.mockResolvedValue({ result: "stored", id: 1, label: "skipped" });
    S.needsJob.mockResolvedValue(false);
    S.headObject.mockResolvedValue({ size: 10, content_type: null });
    let out = await json(await ingest(req("/api/diarize/nemotron/ingest", { body: prodBody({ probs_r2_key: "lab/nemotron-probs/bw_fake0001.nlp" }) })));
    expect(out.probs).toBe("stored");
    expect(S.recordIngest.mock.calls[0]![0].probs_r2_key).toBe("lab/nemotron-probs/bw_fake0001.nlp");
    S.headObject.mockResolvedValue({ size: null, content_type: null });
    out = await json(await ingest(req("/api/diarize/nemotron/ingest", { body: prodBody({ probs_r2_key: "lab/nemotron-probs/bw_fake0001.nlp" }) })));
    expect(out.probs).toBe("missing");
    expect(S.recordIngest.mock.calls[1]![0].probs_r2_key).toBeNull();
  });
  it("ingest of an old-style body (no pointer) never calls R2", async () => {
    S.recordIngest.mockResolvedValue({ result: "stored", id: 1, label: "skipped" });
    S.needsJob.mockResolvedValue(false);
    const out = await json(await ingest(req("/api/diarize/nemotron/ingest", { body: prodBody() })));
    expect(out).not.toHaveProperty("probs");
    expect(S.headObject).not.toHaveBeenCalled();
  });
  it("a pointer to another window's key is a 400", async () => {
    const r = await ingest(req("/api/diarize/nemotron/ingest", { body: prodBody({ probs_r2_key: "lab/nemotron-probs/bw_other.nlp" }) }));
    expect([r.status, (await json(r)).error]).toEqual([400, "bad_probs_r2_key"]);
    expect(S.recordIngest).not.toHaveBeenCalled();
  });
});
