/**
 * Tier 2 §3 — the job queue: claim/lease/skip-locked, crash-mid-step resume, cancel at the
 * boundary, the attempts cap, the after() kick, and the cron route's auth.
 *
 * The claim is INTERPRETED, not merely recorded: the fake below implements FOR UPDATE SKIP LOCKED
 * over an in-memory table, so two runners racing the same rows is a real race here and a statement
 * that dropped SKIP LOCKED would let both take the same job and fail this file.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
type Call = { text: string; values: unknown[] };
const calls: Call[] = [];

/** The in-memory scribe_job table. */
let TABLE: Row[] = [];
/** Rows currently locked by an uncommitted claim — what SKIP LOCKED steps over. */
const locked = new Set<string>();
let NOW = Date.parse("2026-09-12T07:00:00.000Z");
const nowIso = () => new Date(NOW).toISOString();

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });

    if (/^INSERT INTO scribe_job/.test(text)) {
      const [id, kind, args, actor] = values as [string, string, string, string | null];
      const row: Row = {
        id, kind, args, status: "queued", step: null, progress: "{}", result: null, error: null,
        actor, created_at: nowIso(), started_at: null, updated_at: nowIso(), finished_at: null,
        lease_until: null, attempts: 0, failures: 0,
      };
      TABLE.push(row);
      return Promise.resolve([row]);
    }

    // THE CLAIM — and this fake is SEMANTIC, not cosmetic (Refuter item 5).
    //
    // Rows chosen by an in-flight claim are held in `locked` ACROSS AN AWAIT, so a second claim
    // that overlaps it really does meet them held. Whether it skips them is read FROM THE
    // STATEMENT: with `FOR UPDATE SKIP LOCKED` present it steps over them, without it it takes
    // them too — which is exactly what Postgres would do (block, then read the committed row and
    // run the same step again). Delete the clause from store.ts and the two-runner test fails.
    if (/WITH claimable AS/.test(text)) {
      const limit = Number(values[0] ?? 3);
      const secs = Number(values[1] ?? 240);
      const skipsLocked = /FOR UPDATE SKIP LOCKED/.test(text);
      const claimable = TABLE
        .filter((r) => (skipsLocked ? !locked.has(String(r.id)) : true))
        .filter((r) => r.status === "queued" || (r.status === "running" && (r.lease_until === null || Date.parse(String(r.lease_until)) < NOW)))
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, limit);
      for (const r of claimable) locked.add(String(r.id));
      return (async () => {
        // The window in which the rows are held but not yet committed.
        await Promise.resolve();
        for (const r of claimable) {
          r.status = "running";
          r.attempts = Number(r.attempts) + 1;
          r.lease_until = new Date(NOW + secs * 1000).toISOString();
          r.started_at = r.started_at ?? nowIso();
          r.updated_at = nowIso();
        }
        const snapshot = claimable.map((r) => ({ ...r }));
        for (const r of claimable) locked.delete(String(r.id));
        return snapshot;
      })();
    }

    const find = (id: unknown) => TABLE.find((r) => r.id === id);

    if (/^UPDATE scribe_job SET failures = failures \+ 1/.test(text)) {
      const [step, progress, id] = values as [string, string, string];
      const r = find(id);
      if (r && r.status === "running") { r.failures = Number(r.failures) + 1; r.step = step; r.progress = progress; r.lease_until = null; }
      return Promise.resolve([]);
    }
    if (/^UPDATE scribe_job SET step =/.test(text)) {
      const [step, progress, id] = values as [string, string, string];
      const r = find(id);
      if (r && r.status === "running") { r.step = step; r.progress = progress; r.lease_until = null; r.updated_at = nowIso(); }
      return Promise.resolve([]);
    }
    if (/^UPDATE scribe_job SET status = 'done'/.test(text)) {
      const [result, id] = values as [string, string];
      const r = find(id);
      // Refuter item 3: the statement carries `AND status = 'running'`, so a cancel that landed
      // mid-step wins — this write matches no row.
      const guarded = /AND status = 'running'/.test(text);
      if (r && (!guarded || r.status === "running")) { r.status = "done"; r.result = result; r.lease_until = null; r.finished_at = nowIso(); }
      return Promise.resolve([]);
    }
    if (/^UPDATE scribe_job SET status = 'failed'/.test(text)) {
      const [err, id] = values as [string, string];
      const r = find(id);
      if (r) { r.status = "failed"; r.error = err; r.lease_until = null; r.finished_at = nowIso(); }
      return Promise.resolve([]);
    }
    if (/^UPDATE scribe_job SET status = 'cancelled'/.test(text)) {
      const r = find(values[0]);
      if (r && (r.status === "queued" || r.status === "running")) {
        r.status = "cancelled"; r.lease_until = null; r.finished_at = nowIso();
        return Promise.resolve([{ ...r }]);
      }
      return Promise.resolve([]);
    }
    if (/FROM scribe_job WHERE id = \?/.test(text)) {
      const r = find(values[0]);
      return Promise.resolve(r ? [{ ...r }] : []);
    }
    if (/FROM scribe_job WHERE \(/.test(text)) {
      const [status, , kind, , limit] = values as [string | null, unknown, string | null, unknown, number];
      const out = TABLE
        .filter((r) => (status === null || r.status === status) && (kind === null || r.kind === kind))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, Number(limit));
      return Promise.resolve(out.map((r) => ({ ...r })));
    }
    return Promise.resolve([]);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});

const kicks: string[] = [];
vi.mock("next/server", async (o) => {
  const actual = (await o()) as Record<string, unknown>;
  return { ...actual, after: (fn: () => unknown) => { kicks.push("after"); void fn; } };
});

const store = await import("@/lib/jobs/store");
const runner = await import("@/lib/jobs/runner");
const submitMod = await import("@/lib/jobs/submit");
const T = await import("@/lib/jobs/types");
const { KIND_BY_NAME, JOB_KIND_NAMES } = await import("@/lib/jobs/kinds");
const { planPieces, STITCH_PIECE_MS } = await import("@/lib/jobs/kinds/stitch");

const queue = (over: Partial<Row> = {}): Row => {
  const r: Row = {
    id: `job_${TABLE.length}`, kind: "stitch", args: "{}", status: "queued", step: null,
    progress: "{}", result: null, error: null, actor: "t", created_at: new Date(NOW + TABLE.length).toISOString(),
    started_at: null, updated_at: nowIso(), finished_at: null, lease_until: null, attempts: 0, failures: 0, ...over,
  };
  TABLE.push(r);
  return r;
};

beforeEach(() => {
  calls.length = 0; TABLE = []; locked.clear(); kicks.length = 0;
  NOW = Date.parse("2026-09-12T07:00:00.000Z");
});

// ---------------------------------------------------------------------------
// Claim, lease, SKIP LOCKED
// ---------------------------------------------------------------------------

describe("claim", () => {
  it("takes at most CLAIM_BATCH, oldest first, and stamps a lease and an attempt", async () => {
    for (let i = 0; i < 5; i++) queue();
    const got = await store.claimJobs();
    expect(got).toHaveLength(T.CLAIM_BATCH);
    expect(got.map((j) => j.id)).toEqual(["job_0", "job_1", "job_2"]);
    for (const j of got) {
      expect(j.status).toBe("running");
      expect(j.attempts).toBe(1);
      expect(Date.parse(j.lease_until!) - NOW).toBe(T.LEASE_MS);
    }
  });

  it("TWO RUNNERS NEVER DOUBLE-CLAIM — the sets are disjoint and cover each job once", async () => {
    for (let i = 0; i < 6; i++) queue();
    const [a, b] = await Promise.all([store.claimJobs(), store.claimJobs()]);
    const ids = [...a.map((j) => j.id), ...b.map((j) => j.id)];
    expect(new Set(ids).size, "a job was claimed twice").toBe(ids.length);
    expect(ids).toHaveLength(6);
  });

  it("the statement carries FOR UPDATE SKIP LOCKED — without it the race above is a double-run", async () => {
    queue();
    await store.claimJobs();
    const c = calls.find((x) => /WITH claimable AS/.test(x.text))!;
    expect(c.text).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(c.text).toMatch(/status = 'queued' OR \(status = 'running' AND \(lease_until IS NULL OR lease_until < now\(\)\)\)/);
  });

  it("a held lease is NOT reclaimed; an expired one is — this is the crash path", async () => {
    queue({ status: "running", lease_until: new Date(NOW + 60_000).toISOString(), step: "join" });
    expect(await store.claimJobs()).toHaveLength(0);
    NOW += 120_000;
    const again = await store.claimJobs();
    expect(again).toHaveLength(1);
    expect(again[0]!.step, "resumes at the step the row names").toBe("join");
  });

  it("done, failed and cancelled jobs are never claimed", async () => {
    for (const status of ["done", "failed", "cancelled"]) queue({ status });
    expect(await store.claimJobs()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The step machine: resume, cancel boundary, attempts cap
// ---------------------------------------------------------------------------

describe("runOneStep", () => {
  const fakeKind = (impl: () => Promise<T.StepOutcome>) => {
    const k: T.JobKind = { name: "fake", first: "one", scope: "invoke", parseArgs: () => ({}), run: impl };
    KIND_BY_NAME.set("fake", k);
    return k;
  };

  it("CRASH MID-STEP: the job resumes at the same step with failures +1, and finishes", async () => {
    const calledWith: string[] = [];
    fakeKind(async () => { throw new Error("runner died"); });
    queue({ kind: "fake" });
    const first = (await store.claimJobs())[0]!;
    await runner.runOneStep(first);
    let row = await store.readJob(first.id);
    expect(row!.status, "still running — a throw is a counted FAILURE, not a failed job").toBe("running");
    expect(row!.step).toBe("one");
    expect(row!.failures).toBe(1);
    expect(row!.attempts, "the claim still counted").toBe(1);

    // Second claim: same step, failures still 1, attempts 2. Now let it succeed.
    fakeKind(async () => { calledWith.push("two"); return T.doneWith({ ok: true }); });
    const second = (await store.claimJobs())[0]!;
    expect(second.step, "resumed at the step the row named").toBe("one");
    expect(second.attempts).toBe(2);
    expect(second.failures).toBe(1);
    await runner.runOneStep(second);
    row = await store.readJob(first.id);
    expect(row!.status).toBe("done");
    expect(calledWith).toEqual(["two"]);
  });

  it("A LONG JOB IS NOT A FAILING ONE: many claims, zero failures, still running", async () => {
    // The bug this replaces: bounding on `attempts` failed every job longer than three steps.
    let n = 0;
    fakeKind(async () => (++n < 6 ? T.nextStep("one", { n }) : T.doneWith({ n })));
    queue({ kind: "fake" });
    for (let k = 0; k < 6; k++) {
      const claimed = (await store.claimJobs())[0];
      expect(claimed, `claim ${k} found nothing — the job became unclaimable`).toBeTruthy();
      await runner.runOneStep(claimed!);
    }
    const row = await store.readJob("job_0");
    expect(row!.status, "six successful claims must not trip the cap").toBe("done");
    expect(row!.attempts).toBe(6);
    expect(row!.failures).toBe(0);
  });

  it("persists step and progress after EVERY step", async () => {
    fakeKind(async (ctx) => (ctx.step === "one" ? T.nextStep("two", { seen: 1 }) : T.doneWith({ fin: true })));
    queue({ kind: "fake" });
    await runner.runOneStep((await store.claimJobs())[0]!);
    let row = await store.readJob("job_0");
    expect(row!.step).toBe("two");
    expect(row!.progress).toEqual({ seen: 1 });
    expect(row!.lease_until, "the lease is released so the next claim can take it").toBeNull();
    await runner.runOneStep((await store.claimJobs())[0]!);
    row = await store.readJob("job_0");
    expect(row!.status).toBe("done");
    expect(row!.result).toEqual({ fin: true });
  });

  it("CANCEL AT THE BOUNDARY: a cancel during a step discards the outcome, never half-writes", async () => {
    fakeKind(async () => {
      // The cancel lands while this step is in flight.
      await store.cancelJob("job_0");
      return T.nextStep("two", { should_not: "persist" });
    });
    queue({ kind: "fake" });
    await runner.runOneStep((await store.claimJobs())[0]!);
    const row = await store.readJob("job_0");
    expect(row!.status).toBe("cancelled");
    expect(row!.step, "the in-flight step's outcome was discarded").toBeNull();
    expect(row!.progress).toEqual({});
  });

  it("FAILURE CAP: a job that has thrown MAX_FAILURES times is failed, not run again", async () => {
    let ran = 0;
    fakeKind(async () => { ran++; return T.nextStep("one", {}); });
    queue({ kind: "fake", failures: T.MAX_FAILURES });
    const claimed = (await store.claimJobs())[0]!;
    await runner.runOneStep(claimed);
    const row = await store.readJob("job_0");
    expect(row!.status).toBe("failed");
    expect(String(row!.error)).toMatch(/failed 3 times/);
    expect(ran, "the kind was never run on the over-cap claim").toBe(0);
  });

  it("an unknown kind fails the job by name rather than looping", async () => {
    queue({ kind: "no_such_kind" });
    await runner.runOneStep((await store.claimJobs())[0]!);
    const row = await store.readJob("job_0");
    expect(row!.status).toBe("failed");
    expect(String(row!.error)).toMatch(/unknown kind/);
  });
});

// ---------------------------------------------------------------------------
// Submit, kinds, and the stubs
// ---------------------------------------------------------------------------

describe("submit", () => {
  it("validates args through the kind, so a bad job never queues", async () => {
    await expect(submitMod.submitJob({ kind: "stitch", args: { session_id: "s1" }, actor: null })).rejects.toBeInstanceOf(T.JobArgsError);
    expect(TABLE).toHaveLength(0);
  });

  it("an unknown kind is refused, not queued", async () => {
    await expect(submitMod.submitJob({ kind: "nope", args: {}, actor: null })).rejects.toBeInstanceOf(submitMod.UnknownKindError);
    expect(TABLE).toHaveLength(0);
  });

  it("queues with the actor and fires the after() kick when an origin is given", async () => {
    process.env.JOBS_RUNNER_SECRET = "s3cret";
    const job = await submitMod.submitJob({
      kind: "stitch",
      args: { session_id: "bs_1", start: 1000, end: 2000 },
      actor: "mcp:operator-v",
      origin: "https://example",
    });
    expect(job.id).toMatch(/^job_/);
    expect(job.status).toBe("queued");
    expect(job.actor).toBe("mcp:operator-v");
    expect(kicks, "after() was scheduled").toEqual(["after"]);
    delete process.env.JOBS_RUNNER_SECRET;
  });

  it("no kick without a runner secret — and the job still queues, because the cron covers it", async () => {
    delete process.env.JOBS_RUNNER_SECRET;
    await submitMod.submitJob({ kind: "stitch", args: { session_id: "bs_1", start: 1000, end: 2000 }, actor: null, origin: "https://example" });
    expect(kicks).toEqual([]);
    expect(TABLE).toHaveLength(1);
  });
});

describe("the seven kinds", () => {
  it("all seven are registered, and the five stubs fail not_implemented", async () => {
    expect(JOB_KIND_NAMES.sort()).toEqual(
      ["audio_measure", "day_manifest", "diarize_clip", "emotion_clip", "stitch", "stt_fanout", "transcribe_range"].sort(),
    );
    for (const name of ["audio_measure", "emotion_clip", "diarize_clip", "stt_fanout", "day_manifest"]) {
      const k = KIND_BY_NAME.get(name)!;
      const out = await k.run({ job: {} as never, step: "start", args: {}, progress: {} });
      expect(out.kind, name).toBe("fail");
      expect((out as { error: string }).error, name).toMatch(/not_implemented/);
    }
  });

  it("the stubs still validate their args, so Slice C/D replaces a body and nothing else", () => {
    expect(() => KIND_BY_NAME.get("audio_measure")!.parseArgs({})).toThrow(/clip_key/);
    expect(() => KIND_BY_NAME.get("stt_fanout")!.parseArgs({ clip_key: "k" })).toThrow(/engines/);
    expect(KIND_BY_NAME.get("day_manifest")!.parseArgs({ room: "r", ist_date: "2026-09-12" })).toEqual({ room: "r", ist_date: "2026-09-12" });
  });
});

describe("stitch piece maths (§4.3's boundaries)", () => {
  it("29, 30, 31 and 61 minutes", () => {
    const t0 = 1_000_000;
    const min = (n: number) => n * 60_000;
    expect(planPieces(t0, t0 + min(29))).toHaveLength(1);
    expect(planPieces(t0, t0 + min(30)), "30 exactly is ONE piece, not two").toHaveLength(1);
    expect(planPieces(t0, t0 + min(31))).toHaveLength(2);
    const three = planPieces(t0, t0 + min(61));
    expect(three).toHaveLength(3);
    expect(three[0]).toEqual({ start: t0, end: t0 + STITCH_PIECE_MS });
    expect(three[2]).toEqual({ start: t0 + 2 * STITCH_PIECE_MS, end: t0 + min(61) });
    // The pieces tile the range exactly: no gap, no overlap.
    for (let i = 1; i < three.length; i++) expect(three[i]!.start).toBe(three[i - 1]!.end);
  });
});

// ---------------------------------------------------------------------------
// Fix-up 2 — the Refuter's five
// ---------------------------------------------------------------------------

describe("item 1 — a 61-minute stitch completes (3 pieces = 4 claims)", () => {
  it("resolve + three joins, all successful, and the cap never fires", async () => {
    // The kind's own steps, driven through the real runner. Under the old attempts-based cap the
    // fourth claim would have failed this job while it was succeeding.
    const min = (n: number) => n * 60_000;
    const t0 = Date.parse("2026-09-12T03:00:00Z");
    const joined: string[] = [];
    KIND_BY_NAME.set("fake_stitch", {
      name: "fake_stitch", first: "resolve", scope: "invoke", parseArgs: () => ({}),
      run: async (c) => {
        if (c.step === "resolve") return T.nextStep("join", { pieces: planPieces(t0, t0 + min(61)), done: [] });
        const pieces = c.progress.pieces as Array<Record<string, unknown>>;
        const done = c.progress.done as unknown[];
        if (done.length >= pieces.length) return T.doneWith({ piece_count: done.length });
        joined.push(`p${done.length}`);
        return T.nextStep("join", { ...c.progress, done: [...done, { clip_key: `k${done.length}` }] });
      },
    });
    queue({ kind: "fake_stitch" });
    for (let k = 0; k < 8; k++) {
      const c = await store.claimJobs();
      if (!c.length) break;
      await runner.runOneStep(c[0]!);
      if ((await store.readJob("job_0"))!.status !== "running") break;
    }
    const row = await store.readJob("job_0");
    expect(row!.status, `61 minutes must complete; error=${row!.error}`).toBe("done");
    expect(joined, "three pieces were joined, one per claim").toEqual(["p0", "p1", "p2"]);
    expect(row!.attempts).toBeGreaterThan(T.MAX_FAILURES);
    expect(row!.failures).toBe(0);
  });
});

describe("item 3 — a cancel landing mid-step wins at the boundary", () => {
  it("the step's `done` write matches no row, so the job stays cancelled", async () => {
    KIND_BY_NAME.set("fake_done", {
      name: "fake_done", first: "one", scope: "invoke", parseArgs: () => ({}),
      run: async () => {
        await store.cancelJob("job_0"); // the cancel lands while this step is in flight
        return T.doneWith({ should_not: "land" });
      },
    });
    queue({ kind: "fake_done" });
    await runner.runOneStep((await store.claimJobs())[0]!);
    const row = await store.readJob("job_0");
    expect(row!.status, "the last writer must NOT win — the cancel does").toBe("cancelled");
    expect(row!.result).toBeNull();
  });

  it("finishJob and saveStep both carry AND status = 'running'", async () => {
    queue();
    await store.finishJob("job_0", { x: 1 });
    await store.saveStep("job_0", "s", {});
    const fin = calls.find((c) => /SET status = 'done'/.test(c.text))!;
    const step = calls.find((c) => /SET step = \?/.test(c.text))!;
    expect(fin.text).toMatch(/AND status = 'running'/);
    expect(step.text).toMatch(/AND status = 'running'/);
  });
});

describe("item 5 — the two-runner test is semantic", () => {
  it("the fake reads SKIP LOCKED from the statement, so deleting it fails the test", async () => {
    // Guard on the guard: if store.ts loses the clause, the fake stops skipping and the
    // disjointness assertion above breaks. This pins that the fake is reading it at all.
    for (let i = 0; i < 6; i++) queue();
    await store.claimJobs();
    const c = calls.find((x) => /WITH claimable AS/.test(x.text))!;
    expect(c.text).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  it("rows held by an in-flight claim are skipped, not taken twice", async () => {
    for (let i = 0; i < 6; i++) queue();
    const [a, b] = await Promise.all([store.claimJobs(), store.claimJobs()]);
    const ids = [...a.map((j) => j.id), ...b.map((j) => j.id)];
    expect(new Set(ids).size, "a job was claimed twice").toBe(ids.length);
    expect(a.map((j) => j.id)).toEqual(["job_0", "job_1", "job_2"]);
    expect(b.map((j) => j.id)).toEqual(["job_3", "job_4", "job_5"]);
  });
});
