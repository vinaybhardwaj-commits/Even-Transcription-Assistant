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
const pg = pgContainer("eta-spine-s6oref");

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
if mode == "usage":
    sys.exit(2)
if mode == "wait":
    import time
    g = os.environ["FAKE_GATE"]
    open(g + ".started", "w").write("1")
    while not os.path.exists(g + ".go"): time.sleep(0.05)
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
const istDate = () => new Date(Date.UTC(2026, 9, 24 + dayN)).toISOString().slice(0, 10);   // OREF: the e2e original overflows past 31 Oct
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
function runnerPass(opts: { mode?: string; at?: number; gate?: string } = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((ok) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "", HOME: box.data, SPINE_BASE_URL: baseUrl, SPINE_BEARER_TOKEN: "tok", SPINE_RUNNER_OWNER: "e2e-box",
      SPINE_DATA_DIR: join(box.data, "eta-data"), SPINE_GPU_LOCK: join(box.data, "gpu.lock"),
      SPINE_CUTTER_DIR: box.cutter, SPINE_CUTTER_PY: "python3", SPINE_LAB_DIR: box.lab, SPINE_LAB_PY: "python3",
      FAKE_LOG: box.log, FAKE_MODE: opts.mode ?? "cut", FAKE_NOW: String((opts.at ?? nowMs) / 1000), FAKE_GATE: opts.gate ?? "",
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

  const claimReq = (owner: string, live: boolean) => new NextRequest("http://x/api/spine/claim", { method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify({ owner, limit: 1, live }) });
  const reportReq = (b: unknown) => new NextRequest("http://x/api/spine/report", { method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify(b) });
  const row = async (id: string, stage = "recut") => (await q("SELECT status, attempts, next_attempt_at::text AS na, lease_owner, last_error_code, done_at::text AS da FROM spine_job WHERE encounter_id = ? AND stage = ?", id, stage))[0];
  const ART = (sha256: string) => ({ engine: "cutter", version: "v1", cfg8: "abcdabcd", store: "box", status: "ok", sha256, object_key: "consult.flac" });

  it("OREF F1 matrix: a claim gets the job iff not killed, jobs != off, and (live ? jobs=live AND mode=live : mode=shadow)", async () => {
    const { id } = await mkEnc();
    await runSpineEnqueue(nowMs);
    expect((await row(id)).status).toBe("queued");
    const JOBS: unknown[] = ["off", "shadow", "live", "LIVE", null];
    const MODE: unknown[] = ["off", "shadow", "live", null];
    const KILL: unknown[] = [false, true, "yes", null];
    const parse = (v: unknown) => (v === "off" || v === "shadow" || v === "live" ? v : "off");
    let n = 0, bad: string[] = [];
    for (const j of JOBS) for (const m of MODE) for (const k of KILL) for (const live of [true, false]) {
      await q("UPDATE spine_config SET value = 'null'::jsonb WHERE key IN ('jobs','mode.recut','kill_switch')");
      await upsertCfg({ ...(j === null ? {} : { jobs: j }), ...(m === null ? {} : { "mode.recut": m }), ...(k === null ? {} : { kill_switch: k }) });
      if (j === null) await upsertCfg({ jobs: { bogus: 1 } });
      const killed = k !== false;   // a kill_switch row that is not exactly false (null here) is malformed = killed
      const J = parse(j), M = parse(m);
      const want = !killed && J !== "off" && (live ? J === "live" && M === "live" : M === "shadow");
      const r = (await (await claimPOST(claimReq("mx", live))).json()) as { jobs: unknown[] };
      const got = r.jobs.length === 1;
      n += 1;
      if (got !== want) bad.push(`jobs=${String(j)} mode=${String(m)} kill=${String(k)} live=${live} got=${got}`);
      if (got) await q("UPDATE spine_job SET status = 'queued', attempts = 0, lease_owner = NULL, lease_until = NULL WHERE encounter_id = ?", id);
    }
    expect(n).toBe(160);
    expect(bad).toEqual([]);
  }, 300_000);

  it("OREF F3: revive touches ONLY a held (queued, infinity) row: done / failed / leased / transient-queued / dead rows with a link are byte-identical after enqueue", async () => {
    await upsertCfg({ "mode.acoustics": "off", "mode.nemotron": "off" });   // only recut rows, so each pass takes the job just made
    const done = await mkEnc(); await runSpineEnqueue(nowMs); expect((await runnerPass()).code).toBe(0);
    const failed = await mkEnc(); await runSpineEnqueue(nowMs); const pf = await runnerPass({ mode: "usage" }); console.log("OREFDBG usage", pf.code, pf.out.replace(/uid_\w+/g, "U"), JSON.stringify(await jobs(failed.id)));
    // breaker is open after the transient; a manual claim does not consult it? it does: use a fresh day-local trick: leased via claimJobs directly
    const leased = await mkEnc(); await runSpineEnqueue(nowMs);
    const { claimJobs } = await import("@/lib/spine/jobs");
    const got = await claimJobs("holder", ["recut"], 1, new Date(nowMs), undefined, true);
    expect(got.map((g) => g.encounter_id)).toContain(leased.id);
    const trans = await mkEnc(); await runSpineEnqueue(nowMs); await runnerPass({ mode: "error" });
    const dead = await mkEnc(); await runSpineEnqueue(nowMs);
    await q("UPDATE spine_job SET status = 'dead', done_at = now(), last_error_code = 'lease_expired' WHERE encounter_id = ?", dead.id);
    const ids = [done.id, failed.id, trans.id, leased.id, dead.id];
    const snap = async () => Promise.all(ids.map((i) => q("SELECT * FROM spine_job WHERE encounter_id = ? ORDER BY job_id", i)));
    const before = JSON.stringify(await snap());
    expect((await row(done.id)).status).toBe("done");
    expect((await row(failed.id)).status).toBe("failed");
    expect((await row(trans.id)).status).toBe("queued");
    await runSpineEnqueue(nowMs); await runSpineEnqueue(nowMs);
    // done row: acoustics/nemotron get added (new rows) — compare only the recut rows
    const recutOnly = (s: string) => (JSON.parse(s) as Array<Array<Record<string, unknown>>>).map((rs) => rs.filter((r) => r.stage === "recut"));
    expect(recutOnly(JSON.stringify(await snap()))).toEqual(recutOnly(before));
  }, 300_000);

  it("OREF F3: idempotent, no duplicate rows; inactive link does not revive; shadow/jobs=shadow does not revive; revive keeps spent attempts", async () => {
    const { id } = await mkEnc(false);
    await runSpineEnqueue(nowMs);
    const pb = await runnerPass(); console.log("OREFDBG blk", pb.out, JSON.stringify(await jobs(id)));
    expect(pb.out).toMatch(/outcome=blocked/);
    expect((await row(id)).na).toBe("infinity");
    // an INACTIVE link does not revive
    await q("INSERT INTO spine_link (encounter_id, key_kind, value, basis, active) VALUES (?, 'consult_uid', ?, 'exact', false)", id, `uid_test_ina${seq}`);
    await runSpineEnqueue(nowMs);
    expect((await row(id)).na).toBe("infinity");
    // mode shadow / jobs shadow: an active link but the stage is not live: no revive
    await q("INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES (?, 'consult_uid', ?, 'exact')", id, `uid_test_act${seq}`);
    await upsertCfg({ "mode.recut": "shadow" }); await runSpineEnqueue(nowMs);
    expect(await row(id)).toMatchObject({ status: "queued", na: "infinity" });
    await upsertCfg({ "mode.recut": "live", jobs: "shadow" }); await runSpineEnqueue(nowMs);
    expect(await row(id)).toMatchObject({ status: "queued", na: "infinity" });
    await upsertCfg({ jobs: "live" });
    const c1 = await runSpineEnqueue(nowMs);
    expect(await row(id)).toMatchObject({ status: "queued", na: null, last_error_code: null });
    expect(c1).toMatchObject({ queued: 1 });
    const c2 = await runSpineEnqueue(nowMs);
    expect(c2).toMatchObject({ queued: 0 });
    console.log("OREFDBG idem", JSON.stringify(await jobs(id)));
    expect((await q("SELECT count(*)::int AS n FROM spine_job WHERE encounter_id = ? AND stage = 'recut'", id))[0]).toEqual({ n: 1 });
  }, 300_000);

  it("OREF F3: attempts budget is kept by a revive (transient, link lost, blocked, link back)", async () => {
    const { id } = await mkEnc();
    await runSpineEnqueue(nowMs);
    await runnerPass({ mode: "error" });
    expect(await row(id)).toMatchObject({ attempts: 1, last_error_code: "cut_error" });
    await q("UPDATE spine_link SET active = false WHERE encounter_id = ?", id);   // a link superseded (mark, never delete)
    setNow(nowMs + 41 * 60e3);   // 12:51: breaker closed, backoff over, outside the gap
    expect((await runnerPass()).out).toMatch(/outcome=blocked/);
    expect(await row(id)).toMatchObject({ attempts: 1, na: "infinity" });
    await q("INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES (?, 'consult_uid', ?, 'exact')", id, `uid_test_rl${seq}`);
    await runSpineEnqueue(nowMs);
    const after = await row(id);
    expect(after.attempts).toBe(1);   // KEPT: the spent attempt still counts against the 6-attempt budget
  }, 300_000);

  it("OREF F3: a confirmed_single_proxy encounter with a link stays shadow (sp:) and is never claimed", async () => {
    const { id } = await mkEnc();
    await q("UPDATE spine_encounter SET status = 'confirmed_single_proxy' WHERE encounter_id = ?", id);
    await runSpineEnqueue(nowMs); await runSpineEnqueue(nowMs);
    const rs = await q("SELECT status, input_key FROM spine_job WHERE encounter_id = ?", id);
    expect(rs.length).toBeGreaterThan(0);
    for (const r of rs) { expect(r.status).toBe("shadow"); expect(String(r.input_key)).toMatch(/^sp:/); }
    const n = calls().length;
    expect((await runnerPass()).code).toBe(0);
    expect(calls().length).toBe(n);
  }, 300_000);

  it("OREF e2e: lease expires mid-run, another owner takes it: the first runner's done is 409 and writes NO artefact; the second's writes one", async () => {
    const { id } = await mkEnc();
    await runSpineEnqueue(nowMs);
    const gate = join(box.data, `gate${seq}`);
    const p = runnerPass({ mode: "wait", gate });
    for (let i = 0; i < 400 && !(() => { try { readFileSync(gate + ".started"); return true; } catch { return false; } })(); i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(await row(id)).toMatchObject({ status: "leased" });
    setNow(nowMs + 16 * 60e3);   // 12:26 IST... recut claim allowed? the gap is the box's concern; the thief claims via the route
    const t = (await (await claimPOST(claimReq("thief", true))).json()) as { jobs: Array<{ job_id: number }> };
    expect(t.jobs.length).toBe(1);
    writeFileSync(gate + ".go", "1");
    const r = await p;
    console.log("OREFDBG lease", JSON.stringify(t), r.out, JSON.stringify(await jobs(id)));
    expect(r.out).toMatch(/report failed .* status=409/);
    expect(await arts(id)).toEqual([]);
    expect(await row(id)).toMatchObject({ status: "leased", lease_owner: "thief" });
    const ok = await reportPOST(reportReq({ job_id: t.jobs[0]!.job_id, owner: "thief", outcome: "done", artefact: ART("a".repeat(64)) }));
    expect(ok.status).toBe(200);
    expect((await arts(id)).length).toBe(1);
  }, 300_000);

  it("OREF e2e: a crash between the artefact INSERT and the job UPDATE: artefact kept, job re-run after lease, ONE artefact, done", async () => {
    const { id } = await mkEnc();
    await runSpineEnqueue(nowMs);
    const real = pg.sql;
    let fails = 0;
    H.tag = (async (s: TemplateStringsArray, ...v: unknown[]) => { if (s.join("?").includes("WITH u AS (") ) { fails += 1; throw Object.assign(new Error("boom"), { code: "57P01" }); } return real(s, ...v); }) as typeof H.tag;
    const r = await runnerPass();
    H.tag = real;
    expect(fails).toBe(2);   // the runner retried once
    expect(r.out).toMatch(/report failed .* status=503/);
    expect((await arts(id)).length).toBe(1);
    expect(await row(id)).toMatchObject({ status: "leased" });
    setNow(nowMs + 16 * 60e3 + 15 * 60e3);   // 12:41: lease expired, outside the gap
    expect((await runnerPass()).code).toBe(0);
    expect(await row(id)).toMatchObject({ status: "done", attempts: 2 });
    expect((await arts(id)).length).toBe(1);
  }, 300_000);

  it("OREF e2e: two identical done reports at once: one 200, one 409, ONE artefact", async () => {
    const { id } = await mkEnc();
    await runSpineEnqueue(nowMs);
    const c = (await (await claimPOST(claimReq("dup", true))).json()) as { jobs: Array<{ job_id: number }> };
    const b = { job_id: c.jobs[0]!.job_id, owner: "dup", outcome: "done", artefact: ART("b".repeat(64)) };
    const [x, y] = await Promise.all([reportPOST(reportReq(b)), reportPOST(reportReq(b))]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect((await arts(id)).length).toBe(1);
    expect((await ticks("recut")).length).toBe(1);
  }, 300_000);
  it("OREF runbook step 1: jobs=shadow + mode.<stage>=shadow, a would_run (non-live) claim gets NOTHING over 30 passes (shadow rows are never claimable)", async () => {
    await upsertCfg({ jobs: "shadow", "mode.recut": "shadow", "mode.acoustics": "shadow", "mode.nemotron": "shadow" });
    const { id } = await mkEnc();
    await runSpineEnqueue(nowMs);
    expect((await jobs(id)).map((j) => j.status)).toEqual(["shadow", "shadow", "shadow"]);
    let got = 0;
    for (let i = 0; i < 30; i += 1) { setNow(nowMs + 60e3); await runSpineEnqueue(nowMs); got += ((await (await claimPOST(claimReq("wr", false))).json()) as { jobs: unknown[] }).jobs.length; }
    expect(got).toBe(0);
  }, 300_000);
});
