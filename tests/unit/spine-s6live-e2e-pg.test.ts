/**
 * spine-s6live-e2e-pg.test.ts — S6-live readiness: the whole LIVE path on a REAL postgres:16 with ALL real migrations.
 *
 *   runSpineEnqueue (live) -> POST /api/spine/claim (live) -> the REAL tools/eta-spine/runner.py --live --once (a python3 subprocess over HTTP) -> executors.py
 *   -> POST /api/spine/report -> spine_job / spine_artefact / spine_tick.
 *
 * Only the engines are faked: the cutter and clip_lanes CLIs are tiny python scripts written to a temp dir by this test, producing the files the real tools produce
 * (index.jsonl + consult.flac; tracks/<lane>__<ver>__<cfg8>.json). The routes are the real handlers, served on a loopback port; the runner is the real runner.
 * The python clock is pinned (time.time) and so is Date here, so the K-lane / timer windows never depend on when CI runs. No DELETE anywhere: state moves forward by rows and config upserts only.
 * Synthetic ids only. Needs docker (postgres:16) and python3; ETA_ALLOW_SKIP_E2E=1 accepts a skip.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ tag: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => {
  const run = (text: string, params: unknown[]) => {
    const order: number[] = [];
    const parts = text.split(/\$(\d+)/);
    const strings: string[] = [];
    for (let i = 0; i < parts.length; i += 2) { strings.push(parts[i]); if (i + 1 < parts.length) order.push(Number(parts[i + 1]) - 1); }
    return H.tag!(Object.assign(strings, { raw: strings }) as unknown as TemplateStringsArray, ...order.map((n) => params[n]));
  };
  const sql = (a: unknown, ...rest: unknown[]) => (typeof a === "string" ? run(a, rest[0] as unknown[]) : H.tag!(a as TemplateStringsArray, ...rest));
  return { sql };
});

import { NextRequest } from "next/server";
import { POST as claimPOST } from "@/app/api/spine/claim/route";
import { POST as reportPOST } from "@/app/api/spine/report/route";
import { runSpineEnqueue } from "@/lib/spine/enqueue-store";
import { enqueue } from "@/lib/spine/jobs";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const HAVE_PY = (() => { try { execFileSync("python3", ["--version"], { stdio: "pipe" }); return true; } catch { return false; } })();
const pg = pgContainer("eta-spine-s6live");

describe("REQUIRED PROOF — spine S6-live runs end to end against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if ((HAVE_DOCKER && HAVE_PY) || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/spine-s6live-e2e-pg.test.ts needs Docker (postgres:16) and python3. Set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  }, 120_000);
});

const d = HAVE_DOCKER && HAVE_PY ? describe : describe.skip;

// ---------------------------------------------------------------- the fake engines (what the real tools leave behind)
const FAKE_CUTTER = `
import json, os, sys
uid = sys.argv[sys.argv.index("--only") + 1]
open(os.environ["FAKE_LOG"], "a").write(json.dumps({"tool": "cutter", "argv": sys.argv[1:]}) + "\\n")
mode = os.environ.get("FAKE_MODE", "cut")
if mode == "error":
    print(json.dumps({"eligible": 1, "cut": 0, "skipped": 0, "errors": 1, "deferred_gpu": 0})); sys.exit(0)
data = os.environ["SPINE_DATA_DIR"]
clips = os.path.join(data, "consult", "clips"); rel = "2026-10-24/room_test01/" + uid
os.makedirs(os.path.join(clips, rel), exist_ok=True)
open(os.path.join(clips, rel, "consult.flac"), "wb").write(b"FLAC-" + uid.encode())
open(os.path.join(clips, "index.jsonl"), "a").write(json.dumps({"consult_uid": uid, "status": "cut", "path": rel, "signature": "sig-1"}) + "\\n")
print(json.dumps({"eligible": 1, "cut": 1, "skipped": 0, "errors": 0, "deferred_gpu": 0}))
`;
const FAKE_LANES = `
import json, os, sys
a = sys.argv
lane, uid = a[a.index("--lane") + 1], a[a.index("--consult") + 1]
open(os.environ["FAKE_LOG"], "a").write(json.dumps({"tool": "lanes", "lane": lane, "argv": a[1:]}) + "\\n")
data = os.environ["SPINE_DATA_DIR"]
name = {"acoustics": "acoustics.room_profile_acoustics__v1__0a1b2c3d", "nemotron": "diar.nemotron__abcd1234__0123abcd"}[lane]
d = os.path.join(data, "reb", "2026-10-24", "room_test01", "_consults", uid, "tracks"); os.makedirs(d, exist_ok=True)
open(os.path.join(d, name + ".json"), "w").write(json.dumps({"status": "ok", "segments": []}))
counts = {"clips": 1, "written": 1, "skipped_existing": 0, "errors": 0, "failed": 0, "blind_refused": 0, "deferred_recut": 0, "not_cut_refused": 0, "clip_mismatch": 0}
print(json.dumps({"lane": lane, "write": True, "counts": counts}))
`;
/** The real runner, one live pass, with ONLY the wall clock pinned (the executors read time.time at construction). */
const WRAPPER = `
import os, sys, time
sys.path.insert(0, sys.argv[1])
_t = float(os.environ["FAKE_NOW"])
time.time = lambda: _t
import runner
sys.exit(runner.main(["--live", "--once"]))
`;

const sha = (b: string) => createHash("sha256").update(b).digest("hex");
const RUNNER_DIR = join(process.cwd(), "tools", "eta-spine");

// ---------------------------------------------------------------- the clock: 12:10 IST on 24 Oct 2026 (outside the :20-:45 K-lane window and the recut :23-:38 gap)
const IST = 5.5 * 3600e3;
// Each test lives on its OWN IST day (24 Oct + n), so the breaker ticks and encounters an earlier test left behind are old history to it (nothing is deleted to make room).
let dayN = -1;
const istMs = (hh: number, mm: number) => Date.UTC(2026, 9, 24 + dayN, hh, mm) - IST;
const istDate = () => `2026-10-${24 + dayN}`;
let T_1210 = 0;
let nowMs = 0;
const setNow = (ms: number) => { nowMs = ms; vi.setSystemTime(new Date(ms)); };

// ---------------------------------------------------------------- db helpers
const q = async (text: string, ...v: unknown[]) => {
  const parts = text.split("?");
  return (await H.tag!(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...v)) as Array<Record<string, unknown>>;
};
const upsertCfg = async (cfg: Record<string, unknown>) => { for (const [k, v] of Object.entries(cfg)) await q("INSERT INTO spine_config (key, value) VALUES (?, ?::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", k, JSON.stringify(v)); };
const LIVE = { kill_switch: false, jobs: "live", "mode.recut": "live", "mode.acoustics": "live", "mode.nemotron": "live" };
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
let seq = 0;
/** A confirmed encounter that closed 2 h ago (past the 15 min close grace), with an active consult_uid link unless `uid` is null. */
const mkEnc = async (withLink = true) => {
  seq += 1;
  const id = `enc_slivetesttestt${B32[seq % 32]}${B32[Math.floor(seq / 32) % 32]}`;
  const uid = `uid_test_${String(seq).padStart(2, "0")}`;
  await q("INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, boundary_rev, merge_version) VALUES (?, ?::date, 'room_test01', ?::timestamptz, ?::timestamptz, 'confirmed', 0, 'mv1')",
    id, istDate(), new Date(T_1210 - 3 * 3600e3).toISOString(), new Date(T_1210 - 2 * 3600e3).toISOString());
  if (withLink) await q("INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES (?, 'consult_uid', ?, 'exact')", id, uid);
  return { id, uid };
};
const jobs = (id: string) => q("SELECT stage, status, attempts, last_error_code, last_error_class, lease_owner FROM spine_job WHERE encounter_id = ? ORDER BY stage", id);
const job = async (id: string, stage: string) => (await jobs(id)).find((j) => j.stage === stage)!;
const arts = (id: string) => q("SELECT stage, engine, version, cfg8, cut_version, store, bucket, object_key, sha256, status FROM spine_artefact WHERE encounter_id = ? ORDER BY stage", id);
const ticks = async (stage: string) => (await q("SELECT counts->>'failed' AS f FROM spine_tick WHERE kind = ? AND ticked_at >= ?::timestamptz ORDER BY id", `attempt:${stage}`, new Date(T_1210).toISOString())).map((r) => String(r.f));

// ---------------------------------------------------------------- loopback bridge: the runner's HTTP goes to the real route handlers
const seen = { leasedAtReport: [] as string[] };
let server: Server;
let baseUrl = "";
function startServer(): Promise<void> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      try {
        const body = Buffer.concat(chunks).toString();
        const path = req.url ?? "";
        if (path === "/api/spine/report") {   // the queued -> leased -> done proof: the row is leased at the moment the report arrives
          const jid = (JSON.parse(body) as { job_id: number }).job_id;
          seen.leasedAtReport.push(String((await q("SELECT status FROM spine_job WHERE job_id = ?::bigint", jid))[0]?.status));
        }
        const r = new NextRequest(`http://x${path}`, { method: "POST", headers: { authorization: String(req.headers.authorization ?? ""), "content-type": "application/json" }, body });
        const out = await (path === "/api/spine/claim" ? claimPOST(r) : reportPOST(r));
        res.statusCode = out.status;
        res.setHeader("content-type", "application/json");
        res.end(await out.text());
      } catch { res.statusCode = 500; res.end("{}"); }
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => { baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`; ok(); }));
}

// ---------------------------------------------------------------- the box
let box: { data: string; log: string; cutter: string; lab: string; wrapper: string };
const calls = () => { try { return readFileSync(box.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { tool: string; lane?: string; argv: string[] }); } catch { return []; } };

/** One `runner.py --live --once` pass at the pinned time. Resolves with the exit code and the log lines (codes only: the runner never logs a uid or argv of a live job). */
function runnerPass(opts: { mode?: string; at?: number } = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((ok) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "", HOME: box.data, SPINE_BASE_URL: baseUrl, SPINE_BEARER_TOKEN: "tok", SPINE_RUNNER_OWNER: "e2e-box",
      SPINE_DATA_DIR: join(box.data, "eta-data"), SPINE_GPU_LOCK: join(box.data, "gpu.lock"),
      SPINE_CUTTER_DIR: box.cutter, SPINE_CUTTER_PY: "python3", SPINE_LAB_DIR: box.lab, SPINE_LAB_PY: "python3",
      FAKE_LOG: box.log, FAKE_MODE: opts.mode ?? "cut", FAKE_NOW: String((opts.at ?? nowMs) / 1000),
    };
    execFile("python3", ["-c", readFileSync(box.wrapper, "utf8"), RUNNER_DIR], { env: env as unknown as NodeJS.ProcessEnv, maxBuffer: 8 * 1024 * 1024 }, (err: Error | null, stdout: string, stderr: string) => {
      const c = (err as { code?: unknown } | null)?.code;
      const code = err ? (typeof c === "number" ? c : 1) : 0;
      ok({ code, out: `${stdout}${stderr}` });
    });
  });
}

d("spine S6 live path on postgres:16 (all migrations), real routes, real runner, fake engines", () => {
  beforeAll(async () => {
    pg.start();
    H.tag = pg.sql;
    for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
    process.env.SPINE_BEARER_TOKEN = "tok";
    vi.useFakeTimers({ toFake: ["Date"] });
    const root = mkdtempSync(join(tmpdir(), "spine-s6live-"));
    const data = join(root, "box");
    const cutter = join(root, "cutter"), lab = join(root, "lab");
    mkdirSync(join(data, "eta-data", "consult"), { recursive: true });
    mkdirSync(join(data, "eta-data", "reb"), { recursive: true });
    mkdirSync(join(cutter, "cutter"), { recursive: true });
    mkdirSync(join(lab, "kit", "reb"), { recursive: true });
    for (const f of [join(cutter, "cutter", "__init__.py"), join(lab, "kit", "__init__.py"), join(lab, "kit", "reb", "__init__.py")]) writeFileSync(f, "");
    writeFileSync(join(cutter, "cutter", "run.py"), FAKE_CUTTER);
    writeFileSync(join(lab, "kit", "reb", "clip_lanes.py"), FAKE_LANES);
    writeFileSync(join(root, "wrapper.py"), WRAPPER);
    box = { data, log: join(root, "calls.log"), cutter, lab, wrapper: join(root, "wrapper.py") };
    await startServer();
  }, 300_000);
  afterAll(() => { vi.useRealTimers(); server?.close(); pg.stop(); });
  beforeEach(async () => {
    dayN += 1;
    T_1210 = istMs(12, 10);
    setNow(T_1210);
    // whatever an earlier test left waiting is retired the way the enqueuer retires it (superseded, never deleted), so each test sees only its own jobs
    await q("UPDATE spine_encounter SET status = 'rejected' WHERE status <> 'rejected'");   // an earlier test's encounters are no longer planned (the merger rejects encounters too), or the enqueuer would revive their jobs
    await q("UPDATE spine_job SET status = 'superseded', done_at = now() WHERE status IN ('queued', 'leased', 'shadow')");
    await upsertCfg(LIVE);
    seen.leasedAtReport.length = 0;
  }, 120_000);

  it("enqueue (live) -> claim -> runner -> report: recut then acoustics and nemotron go queued -> leased -> done, one artefact row each, with the sha of the file the tool wrote", async () => {
    const c0 = calls().length;
    const { id, uid } = await mkEnc();
    const c1 = await runSpineEnqueue(nowMs);
    expect(c1).toMatchObject({ jobs: "live" });
    // only recut is queued: acoustics / nemotron wait for recut to be done (STAGE_NEEDS); collector / freescript have no mode (off); no paid stage is planned
    expect((await jobs(id)).map((j) => [j.stage, j.status])).toEqual([["recut", "queued"]]);

    const p1 = await runnerPass();
    expect(p1.code).toBe(0);
    expect(p1.out).toMatch(/stage=recut outcome=done/);
    expect(seen.leasedAtReport).toEqual(["leased"]);
    expect(await job(id, "recut")).toMatchObject({ status: "done", attempts: 1, lease_owner: null });
    expect(await arts(id)).toEqual([{
      stage: "recut", engine: "cutter", version: "v1", cfg8: sha("sig-1").slice(0, 8), cut_version: "r0", store: "box", bucket: null, object_key: "consult.flac",
      sha256: sha(`FLAC-${uid}`), status: "ok",
    }]);
    expect(calls().slice(c0).map((c) => [c.tool, c.argv])).toEqual([["cutter", ["--once", "--only", uid, "--recut"]]]);   // exactly one tool call, for exactly this uid

    // recut is done: the next enqueue pass releases the K lanes
    await runSpineEnqueue(nowMs);
    expect((await jobs(id)).map((j) => [j.stage, j.status])).toEqual([["acoustics", "queued"], ["nemotron", "queued"], ["recut", "done"]]);
    for (let i = 0; i < 2; i += 1) expect((await runnerPass()).code).toBe(0);
    expect((await jobs(id)).map((j) => [j.stage, j.status])).toEqual([["acoustics", "done"], ["nemotron", "done"], ["recut", "done"]]);
    expect(await arts(id)).toEqual([
      expect.objectContaining({ stage: "acoustics", engine: "room_profile_acoustics", version: "v1", cfg8: "0a1b2c3d", store: "box", object_key: "tracks/acoustics.room_profile_acoustics__v1__0a1b2c3d.json", status: "ok" }),
      expect.objectContaining({ stage: "nemotron", engine: "nemotron", version: "abcd1234", cfg8: "0123abcd", store: "box", object_key: "tracks/diar.nemotron__abcd1234__0123abcd.json", status: "ok" }),
      expect.objectContaining({ stage: "recut", engine: "cutter" }),
    ]);
    for (const a of await arts(id)) expect(String(a.sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(await ticks("recut")).toEqual(["0"]);   // a success is a breaker tick of failed 0

    // nothing left to claim: a further pass runs no tool, writes no row
    const before = calls().length;
    expect((await runnerPass()).code).toBe(0);
    expect(calls().length).toBe(before);
    expect((await arts(id)).length).toBe(3);
    expect((await q("SELECT count(*)::int AS n FROM spine_job WHERE encounter_id = ?", id))[0]).toEqual({ n: 3 });   // a re-enqueue adds no second job
    await runSpineEnqueue(nowMs);
    expect((await q("SELECT count(*)::int AS n FROM spine_job WHERE encounter_id = ?", id))[0]).toEqual({ n: 3 });
  }, 120_000);

  it("retries are idempotent: a transient failure backs off and trips the breaker; the retry writes ONE artefact; a repeated report is lease_lost and writes nothing; a crashed runner's lease is re-claimed", async () => {
    const { id } = await mkEnc();
    await runSpineEnqueue(nowMs);

    expect((await runnerPass({ mode: "error" })).code).toBe(0);
    expect(await job(id, "recut")).toMatchObject({ status: "queued", attempts: 1, last_error_class: "transient", last_error_code: "cut_error" });
    expect(await arts(id)).toEqual([]);
    expect(await ticks("recut")).toEqual(["1"]);

    // backoff (>= 1.6 min) AND an open breaker (30 min after a failure with no success): nothing is handed out
    setNow(nowMs + 10 * 60e3);
    const n = calls().length;
    expect((await runnerPass()).code).toBe(0);
    expect(calls().length).toBe(n);
    expect(await job(id, "recut")).toMatchObject({ status: "queued", attempts: 1 });

    // 31 min after the failure the breaker closes by itself (derived at read time) and the retry succeeds
    setNow(nowMs + 21 * 60e3);   // 12:41 IST: past the :38 end of the recut gap
    expect((await runnerPass()).code).toBe(0);
    expect(await job(id, "recut")).toMatchObject({ status: "done", attempts: 2, last_error_code: null });
    expect((await arts(id)).length).toBe(1);

    // the same report arriving again (a lost 200, a retry): 409 lease_lost, nothing written, nothing changed
    const jid = Number((await q("SELECT job_id FROM spine_job WHERE encounter_id = ? AND stage = 'recut'", id))[0]!.job_id);
    const again = await reportPOST(new NextRequest("http://x/api/spine/report", { method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ job_id: jid, owner: "e2e-box:1:aaaaaaaa", outcome: "done", artefact: { engine: "cutter", version: "v1", cfg8: "ffffffff", store: "box", status: "ok", sha256: "f".repeat(64), object_key: "consult.flac" } }) }));
    expect(again.status).toBe(409);
    expect((await arts(id)).length).toBe(1);

    // a runner that claimed and died (no report): after the 15 min lease it is claimed again, attempts count the crash, and the finished job still has ONE artefact row
    await q("UPDATE spine_encounter SET status = 'rejected' WHERE encounter_id = ?", id);   // the first encounter is out of the way (the enqueuer supersedes its waiting jobs)
    const e2 = await mkEnc();
    await runSpineEnqueue(nowMs);
    const dead = await (await claimPOST(new NextRequest("http://x/api/spine/claim", { method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify({ owner: "crashed:1:bbbbbbbb", limit: 1, live: true }) }))).json() as { jobs: Array<{ encounter_id: string }> };
    expect(dead.jobs.map((j) => j.encounter_id)).toEqual([e2.id]);
    expect(await job(e2.id, "recut")).toMatchObject({ status: "leased", attempts: 1, lease_owner: "crashed:1:bbbbbbbb" });
    setNow(nowMs + 16 * 60e3);   // 12:57 IST
    const rp = await runnerPass();
    expect(rp.code).toBe(0);
    expect(await job(e2.id, "recut")).toMatchObject({ status: "done", attempts: 2 });
    expect((await arts(e2.id)).length).toBe(1);
  }, 120_000);

  it("a paid stage is never claimed or run, whatever the config and the queue say", async () => {
    const { id } = await mkEnc();
    await upsertCfg({ "mode.sarvam": "live", "mode.gapfill": "live", "mode.llm-roles": "live" });
    await runSpineEnqueue(nowMs);
    expect((await jobs(id)).map((j) => j.stage)).toEqual(["recut"]);   // the enqueuer plans no paid stage
    // a paid job somebody put in the queue by hand (the exported enqueue()) is still not handed out
    await enqueue({ encounter_id: id, stage: "sarvam", cut_version: "r0", input_key: "paid01" });
    await q("UPDATE spine_job SET status = 'superseded' WHERE encounter_id = ? AND stage = 'recut'", id);   // only the paid row is left waiting
    const n = calls().length;
    expect((await runnerPass()).code).toBe(0);
    expect(calls().length).toBe(n);
    expect(await job(id, "sarvam")).toMatchObject({ status: "queued", attempts: 0 });
  }, 120_000);

  it("a mode flip to off stops new claims at once; flipping back resumes; kill_switch stops everything; jobs=shadow stops a live claim", async () => {
    const { id } = await mkEnc();
    await runSpineEnqueue(nowMs);
    const stopped = async (why: string) => {
      const n = calls().length;
      expect((await runnerPass()).code, why).toBe(0);
      expect(calls().length, why).toBe(n);
      expect(await job(id, "recut"), why).toMatchObject({ status: "queued", attempts: 0 });
    };
    await upsertCfg({ "mode.recut": "off" }); await stopped("mode.recut off");
    await upsertCfg({ "mode.recut": "shadow" }); await stopped("mode.recut shadow");
    await upsertCfg({ "mode.recut": "live", jobs: "shadow" }); await stopped("jobs shadow caps a live claim");
    await upsertCfg({ jobs: "off" }); await stopped("jobs off");
    await upsertCfg({ jobs: "live", kill_switch: true }); await stopped("kill_switch on");
    await upsertCfg({ kill_switch: "yes" }); await stopped("a malformed kill_switch counts as killed");
    await upsertCfg({ kill_switch: false });
    expect((await runnerPass()).code).toBe(0);
    expect(await job(id, "recut")).toMatchObject({ status: "done", attempts: 1 });
  }, 120_000);

  it("recut inside the cutter's :35 timer gap is released: no tool, no attempt spent, no breaker tick", async () => {
    const { id } = await mkEnc();
    await runSpineEnqueue(nowMs);
    const t30 = istMs(12, 30);
    setNow(t30);
    const n = calls().length;
    const t0 = (await ticks("recut")).length;
    const p = await runnerPass({ at: t30 });
    expect(p.code).toBe(0);
    expect(p.out).toMatch(/stage=recut outcome=release code=timer_gap/);
    expect(calls().length).toBe(n);
    expect(await job(id, "recut")).toMatchObject({ status: "queued", attempts: 0, last_error_code: null });
    expect((await ticks("recut")).length).toBe(t0);
    // after the gap (and the 3 min release backoff) the same job runs
    setNow(istMs(12, 41));
    expect((await runnerPass({ at: istMs(12, 41) })).code).toBe(0);
    expect(await job(id, "recut")).toMatchObject({ status: "done", attempts: 1 });
  }, 120_000);

  it("a K lane is not handed out from :20 to :45 IST, and recut still is", async () => {
    const { id } = await mkEnc();
    await runSpineEnqueue(nowMs);
    expect((await runnerPass()).code).toBe(0);   // recut done at 12:10
    await runSpineEnqueue(nowMs);
    const t30 = istMs(12, 30);
    setNow(t30);
    const n = calls().length;
    expect((await runnerPass({ at: t30 })).code).toBe(0);
    expect(calls().length).toBe(n);
    expect((await jobs(id)).filter((j) => j.status === "queued").map((j) => j.stage)).toEqual(["acoustics", "nemotron"]);
    setNow(istMs(13, 5));
    expect((await runnerPass({ at: istMs(13, 5) })).code).toBe(0);
    expect((await jobs(id)).filter((j) => j.status === "done").map((j) => j.stage)).toContain("acoustics");
  }, 120_000);

  it("a recut with no consult_uid link is BLOCKED (no tool, no attempt, no tick) and comes back through the cron's enqueue once the link exists", async () => {
    const { id } = await mkEnc(false);
    await runSpineEnqueue(nowMs);
    const n = calls().length;
    const p = await runnerPass();
    expect(p.code).toBe(0);
    expect(p.out).toMatch(/stage=recut outcome=blocked code=no_consult_uid/);
    expect(calls().length).toBe(n);
    expect(await job(id, "recut")).toMatchObject({ status: "queued", attempts: 0, last_error_code: "no_consult_uid" });
    expect(await ticks("recut")).toEqual([]);
    // held: not handed out again, however many passes run
    setNow(nowMs + 3600e3);
    expect((await runnerPass()).code).toBe(0);
    expect(calls().length).toBe(n);
    // the link appears (a new row, as production writes it); the next cron enqueue pass revives exactly that held row
    const uid = `uid_test_blk${seq}`;
    await q("INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES (?, 'consult_uid', ?, 'exact')", id, uid);
    await runSpineEnqueue(nowMs);
    expect(await job(id, "recut")).toMatchObject({ status: "queued", attempts: 0, last_error_code: null });
    expect((await runnerPass({ at: nowMs })).code).toBe(0);
    expect(await job(id, "recut")).toMatchObject({ status: "done", attempts: 1 });
    expect((await arts(id)).length).toBe(1);
  }, 120_000);
});
