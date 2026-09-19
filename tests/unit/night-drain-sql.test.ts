/**
 * Night drain — the SQL, against a REAL postgres:16 in Docker (skipped, loudly, when Docker is not running).
 * The schema below is copied from the live database as read on 19 Sep 2026: only the columns the drain touches.
 *
 * Every statement is its own `psql` session, so the concurrent claims below are genuinely concurrent and the
 * primary key on diarize_slot does the arbitrating — nothing is faked. What each group would catch:
 *   eligibility   a window offered that the app already handled, is mid-flight, or another writer owns
 *   the race      two workers on one window (a SELECT-then-UPDATE claim fails this)
 *   leases        a crashed worker parking a window for ever, or a stranger releasing someone else's lease
 *   resume        a finished window offered again
 *   the row       a producer that is missing, or a diarize_only flag that is not there to revisit the window by
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import os from "node:os";
import { containerName } from "../support/container-name";
import { dockerAvailable, statementForPsql } from "../support/pg-harness";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));

import { LEASE_SECONDS, PARK_SECONDS, RETRY_COOLDOWN_SECONDS, makeStore, type Sql } from "@/lib/night-drain/store";
import { producerStamp, stampTiming } from "@/lib/night-drain/producer";
import { recordDiarizeWindow } from "@/lib/stt/diarize-window";

const NAME = containerName("eta-night-drain");
const HAVE_DOCKER = dockerAvailable();
if (!HAVE_DOCKER) console.warn("[night-drain-sql] Docker is not running: the SQL tests are SKIPPED. Start Docker and rerun; do not read this as green.");

const DDL = `
CREATE TABLE bench_window (id text PRIMARY KEY, session_id text NOT NULL, room_day_id text, start_ms bigint NOT NULL, end_ms bigint NOT NULL,
  source_mic text NOT NULL, clip_r2_key text, grid_aligned boolean NOT NULL, state text NOT NULL, closed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE bench_chunk (id text PRIMARY KEY, session_id text NOT NULL, idx integer NOT NULL, r2_key text NOT NULL, content_type text NOT NULL,
  started_at timestamptz NOT NULL, ended_at timestamptz NOT NULL, upload_state text, source text);
CREATE TABLE room_diarize_window (window_id text PRIMARY KEY, room_day_id text, state text NOT NULL, speakers_json jsonb, segments_json jsonb, clip_r2_key text,
  error text, timing_json jsonb, diarized_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 1, failure_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_run_id text, segments_run_id text, CONSTRAINT rdw_state CHECK (state IN ('ok','no_speakers','failed','skipped')));
CREATE TABLE diarize_slot (slot text PRIMARY KEY, holder text NOT NULL, acquired_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL);
CREATE TABLE scribe_job (id text PRIMARY KEY, kind text NOT NULL, args jsonb NOT NULL DEFAULT '{}'::jsonb, status text NOT NULL DEFAULT 'queued');
`;

function psql(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("docker", ["exec", "-i", NAME, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"]);
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.slice(0, 400)))));
    p.stdin.end(text);
  });
}
const lit = (v: unknown): string => v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : `'${String(v).replace(/'/g, "''")}'`;
const pg: Sql = async (strings, ...values) => {
  let q = ""; strings.forEach((s, i) => { q += s + (i < values.length ? lit(values[i]) : ""); });
  const plan = statementForPsql(q);
  if (plan.kind === "exec") { await psql(plan.text); return []; }
  const out = (await psql(plan.text)).trim();
  return out ? (JSON.parse(out) as unknown[]) : [];
};
const exec = (s: string) => psql(s);
const one = async (s: string): Promise<Record<string, unknown>> => ((await pg([s] as unknown as TemplateStringsArray))[0] ?? {}) as Record<string, unknown>;

const MAX = 3;
const store = makeStore(pg, MAX);

const win = (id: string, o: { end?: number; state?: string; grid?: boolean; day?: string | null; source?: string } = {}) =>
  `INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, grid_aligned, state, closed_at)
   VALUES ('${id}', 'bs_1', ${o.day === null ? "NULL" : `'${o.day ?? "rd_1"}'`}, ${(o.end ?? 1000) - 900}, ${o.end ?? 1000}, '${o.source ?? "primary"}', ${o.grid ?? true}, '${o.state ?? "closed"}', now());`;
const row = (id: string, state: string, attempts: number, agoSeconds: number) =>
  `INSERT INTO room_diarize_window (window_id, room_day_id, state, attempts, diarized_at) VALUES ('${id}', 'rd_1', '${state}', ${attempts}, now() - interval '${agoSeconds} seconds');`;

/** The matrix of states the drain must sort correctly. */
const MATRIX = [
  win("n1", { end: 1000 }), win("t1", { end: 1500, state: "transcribed" }), win("n2", { end: 2000 }),
  win("ok1", { end: 500 }), row("ok1", "ok", 1, 7200),
  win("ns1", { end: 600 }), row("ns1", "no_speakers", 1, 7200),
  win("f1", { end: 300 }), row("f1", "failed", 1, 2 * 3600),                                  // failed, attempts left, cooled down → retry
  win("f2", { end: 310 }), row("f2", "failed", 1, 300),                                       // failed 5 minutes ago → cooling down
  win("f3", { end: 320 }), row("f3", "failed", 3, 2 * 3600),                                  // used every attempt
  win("open1", { end: 700, state: "open" }), win("sil1", { end: 710, state: "silent" }), win("bfail", { end: 720, state: "failed" }),
  win("ng", { end: 730, grid: false }), win("nrd", { end: 740, day: null }),
  win("job1", { end: 750 }), `INSERT INTO scribe_job (id, kind, args, status) VALUES ('j1', 'diarize_window', '{"window_id":"job1"}', 'queued');`,
  win("jobdone", { end: 3000 }), `INSERT INTO scribe_job (id, kind, args, status) VALUES ('j2', 'diarize_window', '{"window_id":"jobdone"}', 'done');`,
  win("live", { end: 760 }), `INSERT INTO diarize_slot (slot, holder, expires_at) VALUES ('night:live', 'someone-else', now() + interval '5 minutes');`,
  win("dead", { end: 3500 }), `INSERT INTO diarize_slot (slot, holder, expires_at) VALUES ('night:dead', 'crashed', now() - interval '1 second');`,
].join("\n");

const reset = () => exec("TRUNCATE bench_window, bench_chunk, room_diarize_window, diarize_slot, scribe_job;");

describe.skipIf(!HAVE_DOCKER)("night drain SQL (real postgres:16)", () => {
  beforeAll(async () => {
    try { execFileSync("docker", ["rm", "-f", NAME], { stdio: "pipe" }); } catch (e) { console.warn(`[night-drain-sql] no old container to remove (${(e as Error).name})`); }
    execFileSync("docker", ["run", "-d", "--rm", "--name", NAME, "-e", "POSTGRES_PASSWORD=x", "postgres:16"], { stdio: "pipe" });
    const deadline = Date.now() + 90_000;
    for (let ok = 0; ok < 2;) {
      try { await psql("SELECT 1;"); ok += 1; } catch (e) { ok = 0; if (Date.now() > deadline) throw new Error(`postgres did not become ready: ${(e as Error).message}`); await new Promise((r) => setTimeout(r, 500)); }
    }
    await exec(DDL);
    H.sql = pg as unknown as typeof H.sql;
  }, 120_000);
  afterAll(() => { try { execFileSync("docker", ["rm", "-f", NAME], { stdio: "pipe" }); } catch (e) { console.warn(`[night-drain-sql] container already gone (${(e as Error).name})`); } });
  beforeEach(reset);

  describe("who is eligible, and in what order", () => {
    it("offers new closed/transcribed windows oldest first, then retries — and nothing else", async () => {
      await exec(MATRIX);
      const ids = (await store.peek(100)).map((w) => w.id);
      // never handled, oldest end_ms first; then the one retry. `live` (a live lease) and `job1` (a queued app job) are NOT offered.
      expect(ids).toEqual(["n1", "t1", "n2", "jobdone", "dead", "f1"]);
    });

    it("excludes, for the stated reason, each window it must not touch", async () => {
      await exec(MATRIX);
      const ids = new Set((await store.peek(100)).map((w) => w.id));
      const why: Record<string, string> = {
        ok1: "already ok (final)", ns1: "no_speakers (final)", f2: "failed 5 minutes ago (cooldown)", f3: "failed with every attempt used",
        open1: "state open", sil1: "state silent", bfail: "bench_window failed", ng: "not on the grid", nrd: "no room_day",
        job1: "the app already has a queued diarize job", live: "another worker's live lease",
      };
      for (const [id, reason] of Object.entries(why)) expect(ids.has(id), `${id}: ${reason}`).toBe(false);
      expect(ids.has("jobdone")).toBe(true);       // a FINISHED app job with no row is not a reason to skip
      expect(ids.has("dead")).toBe(true);          // an expired lease returns the window to the queue
    });

    it("marks only the retry as a retry", async () => {
      await exec(MATRIX);
      const byId = new Map((await store.peek(100)).map((w) => [w.id, w.is_retry]));
      expect(byId.get("f1")).toBe(true);
      expect(byId.get("n1")).toBe(false);
    });

    it("hands windows out in exactly the order peek showed, and stops when none is left", async () => {
      await exec(MATRIX);
      const peeked = (await store.peek(100)).map((w) => w.id);
      const claimed: string[] = [];
      for (let i = 0; i < 20; i++) { const w = await store.claimNext(`h${i}`); if (!w) break; claimed.push(w.id); }
      expect(claimed).toEqual(peeked);
      expect(await store.claimNext("late")).toBeNull();
    });

    it("returns the window's own fields, with numbers as numbers and the microphone it was recorded on", async () => {
      await exec(win("bk", { end: 5000, source: "backup" }));
      const w = await store.claimNext("h");
      expect(w).toEqual({ id: "bk", session_id: "bs_1", room_day_id: "rd_1", start_ms: 4100, end_ms: 5000, source: "backup", is_retry: false });
    });

    it("re-offers a failed window only after the cooldown, and never after MAX attempts", async () => {
      await exec(win("a") + row("a", "failed", 1, RETRY_COOLDOWN_SECONDS - 60));
      expect(await store.peek(5)).toEqual([]);
      await exec(`UPDATE room_diarize_window SET diarized_at = now() - interval '${RETRY_COOLDOWN_SECONDS + 60} seconds' WHERE window_id = 'a';`);
      expect((await store.peek(5)).map((w) => w.id)).toEqual(["a"]);
      await exec(`UPDATE room_diarize_window SET attempts = ${MAX} WHERE window_id = 'a';`);
      expect(await store.peek(5)).toEqual([]);
    });
  });

  describe("the claim is one atomic statement", () => {
    it("never gives two workers the same window, however hard they race", async () => {
      await exec([1, 2, 3, 4, 5, 6].map((i) => win(`r${i}`, { end: 1000 + i })).join("\n"));
      const claimed: string[] = [];
      let rounds = 0;
      for (; rounds < 30; rounds++) {
        const results = await Promise.all(Array.from({ length: 12 }, (_, i) => store.claimNext(`racer-${rounds}-${i}`)));
        const got = results.filter((w): w is NonNullable<typeof w> => w !== null).map((w) => w.id);
        claimed.push(...got);
        if (got.length === 0) break;
      }
      expect(claimed.length).toBe(6);
      expect(new Set(claimed).size).toBe(6);                                 // no window twice
      expect([...claimed].sort()).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]);   // and none lost
      const leases = await one(`SELECT count(*)::int AS n, count(DISTINCT holder)::int AS d FROM diarize_slot WHERE slot LIKE 'night:%'`);
      expect(leases).toEqual({ n: 6, d: 6 });                                // six leases, six different holders
    }, 120_000);

    it("stamps the holder, a 10-minute expiry and the per-window key", async () => {
      await exec(win("k1"));
      await store.claimNext("me");
      const l = await one(`SELECT slot, holder, round(extract(epoch FROM (expires_at - acquired_at)))::int AS secs FROM diarize_slot`);
      expect(l).toEqual({ slot: "night:k1", holder: "me", secs: LEASE_SECONDS });
      expect(LEASE_SECONDS).toBe(600);
    });

    it("skips a window a live lease covers, and steals only an EXPIRED one", async () => {
      await exec(win("l1", { end: 1 }) + win("l2", { end: 2 }));
      const a = await store.claimNext("A");
      expect(a!.id).toBe("l1");
      expect((await store.claimNext("B"))!.id).toBe("l2");
      expect(await store.claimNext("C")).toBeNull();                       // both leased
      await exec(`UPDATE diarize_slot SET expires_at = now() - interval '1 second' WHERE slot = 'night:l1';`);   // A "crashed"
      const stolen = await store.claimNext("C");
      expect(stolen!.id).toBe("l1");
      expect(await one(`SELECT holder FROM diarize_slot WHERE slot = 'night:l1'`)).toEqual({ holder: "C" });
    });
  });

  describe("leases", () => {
    it("only the holder can release; a stranger cannot", async () => {
      await exec(win("x"));
      await store.claimNext("owner");
      expect(await store.release("x", "stranger")).toBe(false);
      expect(await one(`SELECT count(*)::int AS n FROM diarize_slot`)).toEqual({ n: 1 });
      expect(await store.release("x", "owner")).toBe(true);
      expect(await one(`SELECT count(*)::int AS n FROM diarize_slot`)).toEqual({ n: 0 });
    });

    it("a released window with no row goes straight back to the queue", async () => {
      await exec(win("x"));
      await store.claimNext("owner");
      await store.release("x", "owner");
      expect((await store.claimNext("next"))!.id).toBe("x");
    });

    it("parks a deferred window: our lease stays, its expiry moves out 15 minutes, and it is not handed straight back", async () => {
      await exec(win("p", { end: 1 }) + win("q", { end: 2 }));
      await store.claimNext("me");
      expect(await store.park("p", "stranger", PARK_SECONDS)).toBe(false);
      expect(await store.park("p", "me", PARK_SECONDS)).toBe(true);
      const l = await one(`SELECT round(extract(epoch FROM (expires_at - now())))::int AS left FROM diarize_slot WHERE slot = 'night:p'`);
      expect(Number(l.left)).toBeGreaterThan(PARK_SECONDS - 10);
      expect((await store.claimNext("me"))!.id).toBe("q");                 // the parked one is skipped
      expect(PARK_SECONDS).toBe(900);
    });
  });

  describe("resume: a finished window is never offered again", () => {
    it("a terminal row ends candidacy for ok and no_speakers, with or without a lease", async () => {
      await exec(win("w1", { end: 1 }) + win("w2", { end: 2 }) + win("w3", { end: 3 }));
      const w = await store.claimNext("me");
      expect(w!.id).toBe("w1");
      await recordDiarizeWindow({ windowId: "w1", roomDayId: "rd_1", state: "ok", error: null, speakers: [], segments: [], clipR2Key: null, timing: null, runId: "r1" });
      await store.release("w1", "me");                                     // even with the lease gone …
      const next = await store.claimNext("me");
      expect(next!.id).toBe("w2");                                         // … w1 is not offered again
      await recordDiarizeWindow({ windowId: "w2", roomDayId: "rd_1", state: "no_speakers", error: null, speakers: [], segments: [], clipR2Key: null, timing: null, runId: "r2" });
      await store.release("w2", "me");
      expect((await store.peek(10)).map((x) => x.id)).toEqual(["w3"]);
    });

    it("a NEW store (a restart) sees exactly the same queue", async () => {
      await exec(win("w1", { end: 1 }) + win("w2", { end: 2 }));
      await recordDiarizeWindow({ windowId: "w1", roomDayId: "rd_1", state: "ok", error: null, speakers: [], segments: [], clipR2Key: null, timing: null, runId: "r1" });
      const restarted = makeStore(pg, MAX);
      expect((await restarted.claimNext("after-restart"))!.id).toBe("w2");
      expect(await restarted.claimNext("after-restart")).toBeNull();
    });
  });

  describe("the row the drain writes", () => {
    it("carries the producer from the running host and the diarize_only flag, with no clip and every client timing key kept", async () => {
      await exec(win("s1"));
      const timing = stampTiming({ queue_wait_ms: 2, wall_ms: 70_000, service_ms: 68_500, audio_bytes: 28_800_044 }, producerStamp("mps"),
        { mcp_ms: 800, download_ms: 4200, join_ms: 3100, diarize_ms: 70_000, total_ms: null }, { pieces: 4, bytes: 1_100_000, seconds: 900, source: "primary" });
      await recordDiarizeWindow({ windowId: "s1", roomDayId: "rd_1", state: "ok", error: null, speakers: [{ idx: 0, label: "x", type: "y" }], segments: [{ start_ms: 0, end_ms: 100, speaker_idx: 0, overlap: false }], clipR2Key: null, timing, runId: "run-1" });
      const r = await one(`SELECT state, clip_r2_key IS NULL AS no_clip, timing_json->>'diarize_only' AS flag, timing_json->'producer'->>'host' AS host,
                                  timing_json->'producer'->>'arch' AS arch, timing_json->'producer'->>'service_device' AS dev,
                                  timing_json->>'queue_wait_ms' AS qw, timing_json->>'service_ms' AS sm, timing_json->'night_drain'->>'audio_source' AS src FROM room_diarize_window WHERE window_id = 's1'`);
      expect(r).toEqual({ state: "ok", no_clip: true, flag: "true", host: os.hostname(), arch: os.arch(), dev: "mps", qw: "2", sm: "68500", src: "scribe_mcp_chunks" });
    });

    it("lets a later reader find every diarize-only window with one predicate", async () => {
      await exec(win("a", { end: 1 }) + win("b", { end: 2 }) + win("c", { end: 3 }));
      const stamp = (sec: number) => stampTiming(null, producerStamp(null), { mcp_ms: null, download_ms: null, join_ms: null, diarize_ms: sec, total_ms: null }, null);
      await recordDiarizeWindow({ windowId: "a", roomDayId: "rd_1", state: "ok", error: null, speakers: [], segments: [], clipR2Key: null, timing: stamp(1), runId: "r" });
      await recordDiarizeWindow({ windowId: "b", roomDayId: "rd_1", state: "failed", error: "chunk_gone", speakers: null, segments: null, clipR2Key: null, timing: stamp(2), runId: "r" });
      await recordDiarizeWindow({ windowId: "c", roomDayId: "rd_1", state: "ok", error: null, speakers: [], segments: [], clipR2Key: "clips/x.webm", timing: { wall_ms: 1 }, runId: "r" });   // an app-written row: no flag
      const found = (await pg`SELECT window_id FROM room_diarize_window WHERE timing_json->>'diarize_only' = 'true' ORDER BY window_id` as Array<{ window_id: string }>).map((x) => x.window_id);
      expect(found).toEqual(["a", "b"]);
    });

    it("a second write to an ok row changes nothing, so a double-processed window cannot corrupt the first result", async () => {
      await exec(win("d1"));
      const t1 = stampTiming(null, producerStamp("mps"), { mcp_ms: 1, download_ms: 1, join_ms: 1, diarize_ms: 1, total_ms: null }, null);
      const t2 = stampTiming(null, producerStamp("cpu"), { mcp_ms: 9, download_ms: 9, join_ms: 9, diarize_ms: 9, total_ms: null }, null);
      await recordDiarizeWindow({ windowId: "d1", roomDayId: "rd_1", state: "ok", error: null, speakers: [{ idx: 0, label: "a", type: "b" }], segments: [], clipR2Key: null, timing: t1, runId: "first" });
      await recordDiarizeWindow({ windowId: "d1", roomDayId: "rd_1", state: "ok", error: null, speakers: [{ idx: 7, label: "z", type: "z" }], segments: [], clipR2Key: null, timing: t2, runId: "second" });
      const r = await one(`SELECT state, attempts, speakers_json->0->>'idx' AS idx, timing_json->'producer'->>'service_device' AS dev FROM room_diarize_window WHERE window_id = 'd1'`);
      expect(r).toEqual({ state: "ok", attempts: 1, idx: "0", dev: "mps" });
    });

    it("a failed attempt is kept in failure_history, attempts goes up, and the window is offered again only after the cooldown", async () => {
      await exec(win("e1"));
      const fail = (code: string) => recordDiarizeWindow({ windowId: "e1", roomDayId: "rd_1", state: "failed", error: code, speakers: null, segments: null, clipR2Key: null,
        timing: stampTiming(null, producerStamp(null), { mcp_ms: null, download_ms: null, join_ms: null, diarize_ms: null, total_ms: null }, null), runId: "r" });
      await fail("chunk_gone");
      await fail("audio_corrupt");
      const r = await one(`SELECT state, attempts, error, jsonb_array_length(failure_history) AS hist, timing_json->>'diarize_only' AS flag FROM room_diarize_window WHERE window_id = 'e1'`);
      expect(r).toEqual({ state: "failed", attempts: 2, error: "audio_corrupt", hist: 1, flag: "true" });
      expect(await store.peek(5)).toEqual([]);                             // cooling down
    });
  });

  describe("the convergence numbers", () => {
    it("counts what is left, what is retrying, what has given up, and what closed in the last day", async () => {
      await exec(MATRIX + win("fresh", { end: 4000 }) + `UPDATE bench_window SET closed_at = now() - interval '3 days' WHERE id IN ('n1','n2');`);
      const r = await store.remaining();
      // Never handled = closed/transcribed, on the grid, with a room_day, and NO diarize row — whether or not a lease or a
      // queued app job currently covers it, because it is still outstanding: n1 t1 n2 job1 jobdone live dead fresh.
      expect(r.never_handled).toBe(8);
      expect(r.retry_pending).toBe(2);                                     // f1, f2 (attempts left; a cooldown is not a reason to stop counting)
      expect(r.exhausted).toBe(1);                                         // f3
      expect(r.closed_last_24h).toBeGreaterThan(0);
    });
  });

  describe("the chunks a window's audio is built from", () => {
    it("returns the session's chunks in production's order with a null source read as primary", async () => {
      await exec(`INSERT INTO bench_chunk (id, session_id, idx, r2_key, content_type, started_at, ended_at, upload_state, source) VALUES
        ('c2','bs_1',2,'k2','audio/webm','2026-09-18T06:01:00Z','2026-09-18T06:06:00Z','verified',NULL),
        ('c1','bs_1',1,'k1','audio/webm','2026-09-18T05:56:00Z','2026-09-18T06:01:00Z','verified','primary'),
        ('b1','bs_1',1,'kb1','audio/webm','2026-09-18T05:56:00Z','2026-09-18T06:01:00Z','verified','backup'),
        ('o1','bs_2',1,'ko1','audio/webm','2026-09-18T05:56:00Z','2026-09-18T06:01:00Z','verified','primary');`);
      const c = await store.chunksForSession("bs_1");
      expect(c.map((x) => `${x.source}:${x.idx}`)).toEqual(["backup:1", "primary:1", "primary:2"]);
      expect(c.every((x) => typeof x.r2_key === "string" && x.content_type === "audio/webm")).toBe(true);
    });
  });
});
