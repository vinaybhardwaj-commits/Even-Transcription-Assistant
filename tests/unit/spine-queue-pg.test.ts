/**
 * spine-queue-pg.test.ts — S5: spine_job claim / report against a REAL postgres:16 with migration 0173. Synthetic ids only.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ tag: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.tag!(s, ...v) }));

import { claimJobs, enqueue, reapExhausted, reportJob, openBreakers, type Notifier } from "@/lib/spine/jobs";
import { BACKOFF_CAP_MS, MAX_ATTEMPTS, nextIstDayStart } from "@/lib/spine/retry";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-spine-queue");
const UP = readFileSync("db/migrations/0173_spine.sql", "utf8");

describe("REQUIRED PROOF — spine queue runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/spine-queue-pg.test.ts needs Docker for postgres:16. Set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const d = HAVE_DOCKER ? describe : describe.skip;
const q = async (text: string, ...v: unknown[]) => {
  const parts = text.split("?");
  return (await H.tag!(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...v)) as Array<Record<string, unknown>>;
};
const T0 = new Date("2026-10-19T06:00:00Z");
const min = (m: number) => new Date(T0.getTime() + m * 60_000);
let seq = 0;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const mkEnc = async (): Promise<string> => {
  seq += 1;
  const id = `enc_testtesttestte${B32[seq % 32]}${B32[Math.floor(seq / 32) % 32]}`;   // enc_ + 16 chars of [a-z2-7]
  await q("INSERT INTO spine_encounter (encounter_id, ist_date, t_open, status, merge_version) VALUES (?, '2026-10-19', now(), 'confirmed', 'mv1')", id);
  return id;
};
const mkJob = async (stage = "recut", cut = "c1", key = "k1") => { const e = await mkEnc(); const id = await enqueue({ encounter_id: e, stage, cut_version: cut, input_key: key }); return { e, id: id! }; };
const row = async (id: number) => (await q("SELECT * FROM spine_job WHERE job_id = ?::bigint", id))[0]!;
const fakeNotifier = () => { const calls: unknown[] = []; const n: Notifier = { dead: async (j) => { calls.push(j); } }; return { n, calls }; };

d("spine queue on postgres:16", () => {
  beforeAll(() => {
    pg.start();
    H.tag = pg.sql;
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);");
    pg.exec(UP);
  });
  afterAll(() => { pg.stop(); });

  it("encounter ids used here are valid (migration CHECK)", async () => { expect((await mkEnc())).toMatch(/^enc_[a-z2-7]{16}$/); });

  it("enqueue is idempotent on (encounter, stage, cut_version, input_key)", async () => {
    const { e, id } = await mkJob("recut", "c1", "idem");
    expect(id).toBeGreaterThan(0);
    expect(await enqueue({ encounter_id: e, stage: "recut", cut_version: "c1", input_key: "idem" })).toBeNull();
    expect(await enqueue({ encounter_id: e, stage: "recut", cut_version: "c2", input_key: "idem" })).not.toBeNull();
  });

  it("claim does not double-claim: each job goes to exactly one claimer", async () => {
    await q("DELETE FROM spine_job");
    const ids = [(await mkJob("claimA")).id, (await mkJob("claimA", "c1", "k2")).id, (await mkJob("claimA", "c1", "k3")).id];
    const a = await claimJobs("runner-a", ["claimA"], 2, T0);
    const b = await claimJobs("runner-b", ["claimA"], 2, T0);
    expect(a.length).toBe(2);
    expect(b.length).toBe(1);
    expect(new Set([...a, ...b].map((j) => j.job_id))).toEqual(new Set(ids));
    expect((await claimJobs("runner-c", ["claimA"], 2, T0)).length).toBe(0);
    expect(await q("SELECT count(*)::int AS n FROM spine_job WHERE lease_owner = 'runner-a'")).toEqual([{ n: 2 }]);
  });

  it("SKIP LOCKED: a claimer does not wait on a row another session holds locked; it takes the next one", async () => {
    await q("DELETE FROM spine_job");
    const first = await mkJob("lockst", "c1", "k1");
    const second = await mkJob("lockst", "c1", "k2");
    // A second, genuinely concurrent session locks the row a claim would take first, and holds it for 4 s.
    const holder = spawn("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { stdio: ["pipe", "pipe", "inherit"] });
    const locked = new Promise<void>((res, rej) => { holder.stdout.on("data", (b) => { if (String(b).includes("locked")) res(); }); holder.on("error", rej); setTimeout(() => rej(new Error("holder did not lock")), 20_000); });
    holder.stdin.write(`BEGIN; SELECT job_id FROM spine_job WHERE job_id = ${first.id} FOR UPDATE; SELECT 'locked'; SELECT pg_sleep(4); ROLLBACK;\n`);
    await locked;
    const t = Date.now();
    const got = await claimJobs("runner-a", ["lockst"], 1, T0);
    const took = Date.now() - t;
    holder.stdin.end();
    expect(got.map((j) => j.job_id)).toEqual([second.id]);
    expect(took).toBeLessThan(2500);
  });

  it("an expired lease is re-claimed; a live lease is not", async () => {
    await q("DELETE FROM spine_job");
    const { id } = await mkJob("lease");
    const [c1] = await claimJobs("runner-a", ["lease"], 1, T0);
    expect(c1!.job_id).toBe(id);
    expect(new Date(c1!.lease_until!).getTime()).toBe(min(15).getTime());
    expect(await claimJobs("runner-b", ["lease"], 1, min(14))).toEqual([]);
    const [c2] = await claimJobs("runner-b", ["lease"], 1, min(16));
    expect(c2!.job_id).toBe(id);
    expect(c2!.attempts).toBe(2);
    expect((await row(id)).lease_owner).toBe("runner-b");
  });

  it("owner mismatch is rejected: a stale runner cannot overwrite the new holder", async () => {
    await q("DELETE FROM spine_job");
    const { id } = await mkJob("owner");
    await claimJobs("runner-a", ["owner"], 1, T0);
    await claimJobs("runner-b", ["owner"], 1, min(16));
    expect(await reportJob({ job_id: id, owner: "runner-a", outcome: "done", now: min(17), rng: () => 0.5 })).toEqual({ ok: false, error: "lease_lost" });
    expect((await row(id)).status).toBe("leased");
    expect(await reportJob({ job_id: id, owner: "runner-b", outcome: "done", now: min(17), rng: () => 0.5 })).toEqual({ ok: true, status: "done" });
    expect(await reportJob({ job_id: id, owner: "runner-b", outcome: "done", now: min(18), rng: () => 0.5 })).toEqual({ ok: false, error: "lease_lost" });
  });

  it("transient: backoff for attempts 1-5 stays inside ±20% and the 6 h cap, attempt 6 is dead", async () => {
    await q("DELETE FROM spine_job");
    const { id } = await mkJob("backoff");
    let now = T0;
    for (let n = 1; n <= 5; n++) {
      const [c] = await claimJobs("r", ["backoff"], 1, now);
      expect(c!.attempts).toBe(n);
      const rng = n % 2 ? () => 0 : () => 0.999999;
      expect(await reportJob({ job_id: id, owner: "r", outcome: "transient", error_code: "http_503", now, rng })).toEqual({ ok: true, status: "queued" });
      const r = await row(id);
      const delay = new Date(r.next_attempt_at as string).getTime() - now.getTime();
      const base = Math.min(BACKOFF_CAP_MS, 2 * 60_000 * 3 ** (n - 1));
      expect(delay).toBeGreaterThanOrEqual(Math.floor(base * 0.8));
      expect(delay).toBeLessThanOrEqual(Math.min(BACKOFF_CAP_MS, Math.ceil(base * 1.2)));
      expect([r.status, r.attempts, r.last_error_class, r.last_error_code]).toEqual(["queued", n, "transient", "http_503"]);
      expect(await claimJobs("r", ["backoff"], 1, new Date(now.getTime() + delay - 1000))).toEqual([]);   // not before next_attempt_at
      now = new Date(now.getTime() + delay + 1000);
    }
    const [c6] = await claimJobs("r", ["backoff"], 1, now);
    expect(c6!.attempts).toBe(MAX_ATTEMPTS);
    expect(await reportJob({ job_id: id, owner: "r", outcome: "transient", error_code: "http_503", now, rng: () => 0.5 })).toEqual({ ok: true, status: "dead" });
    expect((await row(id)).status).toBe("dead");
    expect(await claimJobs("r", ["backoff"], 1, new Date(now.getTime() + 7 * 3_600_000))).toEqual([]);
  });

  it("permanent goes to failed on attempt 1 and is never claimed again", async () => {
    await q("DELETE FROM spine_job");
    const { id } = await mkJob("perm");
    await claimJobs("r", ["perm"], 1, T0);
    expect(await reportJob({ job_id: id, owner: "r", outcome: "permanent", error_code: "http_409", now: T0, rng: () => 0.5 })).toEqual({ ok: true, status: "failed" });
    const r = await row(id);
    expect([r.status, r.attempts, r.last_error_class, r.next_attempt_at !== null]).toEqual(["failed", 1, "permanent", false]);
    expect(await claimJobs("r", ["perm"], 1, min(24 * 60))).toEqual([]);
  });

  it("budget does not increment attempts and holds the job until the next IST day", async () => {
    await q("DELETE FROM spine_job");
    const { id } = await mkJob("budget");
    await claimJobs("r", ["budget"], 1, T0);
    expect(await row(id)).toMatchObject({ attempts: 1 });
    expect(await reportJob({ job_id: id, owner: "r", outcome: "budget", error_code: "cap_90", now: T0, rng: () => 0.5 })).toEqual({ ok: true, status: "queued" });
    const r = await row(id);
    expect([r.attempts, r.status, r.last_error_class]).toEqual([0, "queued", "budget"]);
    const until = nextIstDayStart(T0);
    expect(new Date(r.next_attempt_at as string).getTime()).toBe(until.getTime());
    expect(until.toISOString()).toBe("2026-10-19T18:30:00.000Z");
    expect(await claimJobs("r", ["budget"], 1, new Date(until.getTime() - 1000))).toEqual([]);
    expect((await claimJobs("r", ["budget"], 1, until))[0]!.attempts).toBe(1);
  });

  it("shadow and release give the attempt back; shadow rows are not claimable", async () => {
    await q("DELETE FROM spine_job");
    const a = await mkJob("shad", "c1", "a");
    const b = await mkJob("shad", "c1", "b");
    await claimJobs("r", ["shad"], 2, T0);
    await reportJob({ job_id: a.id, owner: "r", outcome: "shadow", now: T0, rng: () => 0.5 });
    await reportJob({ job_id: b.id, owner: "r", outcome: "release", now: T0, rng: () => 0.5 });
    expect(await row(a.id)).toMatchObject({ status: "shadow", attempts: 0 });
    expect(await row(b.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect((await claimJobs("r", ["shad"], 5, T0)).map((j) => j.job_id)).toEqual([b.id]);
  });

  it("the dead transition fires the sink exactly once, via report or via an expired last lease", async () => {
    await q("DELETE FROM spine_job");
    const { id } = await mkJob("deadsink");
    await q("UPDATE spine_job SET attempts = 5 WHERE job_id = ?::bigint", id);
    const f = fakeNotifier();
    await claimJobs("r", ["deadsink"], 1, T0);
    expect(await reportJob({ job_id: id, owner: "r", outcome: "transient", error_code: "http_503", now: T0, rng: () => 0.5 }, f.n)).toEqual({ ok: true, status: "dead" });
    expect(await reportJob({ job_id: id, owner: "r", outcome: "transient", error_code: "http_503", now: T0, rng: () => 0.5 }, f.n)).toEqual({ ok: false, error: "lease_lost" });
    expect(f.calls).toEqual([{ job_id: id, stage: "deadsink", encounter_id: expect.any(String), error_code: "http_503" }]);
    // A runner dies on its last attempt: the lease expires, nobody can claim it (attempts = max), the reaper kills it once.
    const z = await mkJob("deadsink", "c1", "z");
    await q("UPDATE spine_job SET attempts = 5 WHERE job_id = ?::bigint", z.id);
    await claimJobs("r", ["deadsink"], 1, T0);
    expect(await claimJobs("r2", ["deadsink"], 1, min(16))).toEqual([]);
    const g = fakeNotifier();
    expect(await reapExhausted(min(16), g.n)).toBe(1);
    expect(await reapExhausted(min(17), g.n)).toBe(0);
    expect(g.calls.length).toBe(1);
    expect((await row(z.id)).status).toBe("dead");
  });

  it("breaker: >=30% of the last 20 failed opens it for 30 min, then it closes", async () => {
    await q("DELETE FROM spine_job");
    for (let i = 0; i < 10; i++) {
      const j = await mkJob("brk", "c1", `k${i}`);
      await q("UPDATE spine_job SET status = ?, done_at = ?::timestamptz WHERE job_id = ?::bigint", i < 4 ? "failed" : "done", min(i).toISOString(), j.id);
    }
    expect(await openBreakers(["brk"], min(20))).toEqual(["brk"]);        // 4 failures, last at +3 min
    expect(await openBreakers(["brk"], min(34))).toEqual([]);             // 30 min after +3 has passed
    expect(await openBreakers(["other"], min(20))).toEqual([]);
  });
});
