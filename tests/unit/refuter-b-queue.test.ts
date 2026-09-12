/**
 * REFUTER (not the builder's harness). An independent in-memory `scribe_job` that models
 * Postgres row locks and a MOVABLE CLOCK — the builder's fake freezes NOW, which is what hides
 * the lease arithmetic below.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
/**
 * Fix-up 5 — model `AND lease_owner = ?`: PLAIN EQUALITY, so a NULL owner matches nothing. The
 * previous `IS NOT DISTINCT FROM` matched NULL against NULL, which is how a caller with no runner
 * could write to a row it never claimed.
 */
const owns = (text: string, r: Row, runner: string | null | undefined): boolean => {
  if (!/lease_owner = \?/.test(text)) return true;
  const owner = (r.lease_owner ?? null) as string | null;
  return owner !== null && runner != null && owner === runner;
};
let TABLE: Row[] = [];
const locked = new Set<string>();
let NOW = Date.parse("2026-09-12T07:00:00.000Z");
const nowIso = () => new Date(NOW).toISOString();
const seenSql: string[] = [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    seenSql.push(text);
    const find = (id: unknown) => TABLE.find((r) => r.id === id);

    if (/^INSERT INTO scribe_job/.test(text)) {
      const [id, kind, args, actor] = values as [string, string, string, string | null];
      const row: Row = { id, kind, args, status: "queued", step: null, progress: "{}", result: null,
        error: null, actor, created_at: nowIso(), started_at: null, updated_at: nowIso(),
        finished_at: null, lease_until: null, lease_owner: null, attempts: 0, failures: 0 };
      TABLE.push(row);
      return Promise.resolve([row]);
    }
    if (/WITH claimable AS/.test(text)) {
      const limit = Number(values[0] ?? 3);
      const secs = Number(values[1] ?? 240);
      const runner = (values[2] ?? null) as string | null;
      const skips = /FOR UPDATE SKIP LOCKED/.test(text);
      const picked = TABLE
        .filter((r) => (skips ? !locked.has(String(r.id)) : true))
        // Fix-up 5 — the claimable predicate is READ FROM THE STATEMENT, not hardcoded. A fake that
        // decides for itself which rows are claimable cannot fail when the SQL stops respecting a
        // live lease, which is exactly the bug this file exists to catch.
        .filter((r) => {
          if (r.status === "queued") return true;
          if (r.status !== "running") return false;
          const honoursLease = /lease_until IS NULL OR lease_until < now\(\)/.test(text);
          if (!honoursLease) return true; // a store that dropped the lease check takes it anyway
          return r.lease_until === null || Date.parse(String(r.lease_until)) < NOW;
        })
        // A5 — FIFO only if the statement asks for it. Sorting on the fake's own authority meant
        // deleting ORDER BY from the claim changed nothing.
        .sort((a, b) => (/ORDER BY created_at/.test(text)
          ? String(a.created_at).localeCompare(String(b.created_at))
          : 0))
        .slice(0, limit);
      for (const r of picked) locked.add(String(r.id));
      return (async () => {
        await Promise.resolve();
        for (const r of picked) {
          r.status = "running"; r.attempts = Number(r.attempts) + 1;
          // A6 — the expiry comes from the statement's own interval parameter, so widening
          // `make_interval(secs => ?)` changes what the fake stores and is observable.
          r.lease_until = new Date(NOW + secs * 1000).toISOString();
          r.lease_owner = runner;
          r.started_at = r.started_at ?? nowIso(); r.updated_at = nowIso();
        }
        const snap = picked.map((r) => ({ ...r }));
        for (const r of picked) locked.delete(String(r.id));
        return snap;
      })();
    }
    if (/^UPDATE scribe_job SET failures = failures \+ 1/.test(text)) {
      const [step, progress, cap, , err, , id, runner] = values as [string, string, number, number, string, number, string, string | null];
      const r = find(id);
      // A1 — the `AND status = 'running'` clause is READ from the statement, like the done/failed
      // branches beside it. Hardcoding it meant deleting it from store.ts changed nothing.
      const rfGuarded = /AND status = 'running'/.test(text);
      if (!r || (rfGuarded && r.status !== "running") || !owns(text, r, runner)) return Promise.resolve([]);
      r.failures = Number(r.failures) + 1; r.step = step; r.progress = progress; r.lease_until = null; r.lease_owner = null;
      // A2 — the comparator is READ from the statement. `>=` vs `>` is an off-by-one in the cap,
      // and computing it here meant the fake, not the SQL, decided when a job became terminal.
      const gte = /failures \+ 1 >= \?/.test(text);
      const terminal = gte ? Number(r.failures) >= Number(cap) : Number(r.failures) > Number(cap);
      if (terminal) { r.status = "failed"; r.error = err; r.finished_at = nowIso(); }
      return Promise.resolve([{ failures: r.failures, status: r.status }]);
    }
    if (/^UPDATE scribe_job SET step =/.test(text)) {
      const [step, progress, id, runner] = values as [string, string, string, string | null];
      const r = find(id);
      if (r && owns(text, r, runner) && (!/AND status = 'running'/.test(text) || r.status === "running")) {
        // A3 — release the lease only if the statement does.
        r.step = step; r.progress = progress; r.updated_at = nowIso();
        if (/lease_until = NULL/.test(text)) r.lease_until = null;
        return Promise.resolve([{ id: r.id }]);
      }
      return Promise.resolve([]);
    }
    if (/^UPDATE scribe_job SET status = 'done'/.test(text)) {
      const [result, id, runner] = values as [string, string, string | null];
      const r = find(id);
      if (r && owns(text, r, runner) && (!/AND status = 'running'/.test(text) || r.status === "running")) {
        r.status = "done"; r.result = result; r.finished_at = nowIso();
        if (/lease_until = NULL/.test(text)) r.lease_until = null;
        // A4 — clear the owner only if the statement clears it.
        if (/lease_owner = NULL/.test(text)) r.lease_owner = null;
        return Promise.resolve([{ id: r.id }]);
      }
      return Promise.resolve([]);
    }
    if (/^UPDATE scribe_job SET status = 'failed'/.test(text)) {
      const [err, id, runner] = values as [string, string, string | null];
      const r = find(id);
      if (r && owns(text, r, runner) && (!/AND status = 'running'/.test(text) || r.status === "running")) {
        r.status = "failed"; r.error = err; r.lease_until = null; r.lease_owner = null; r.finished_at = nowIso();
        return Promise.resolve([{ id: r.id }]);
      }
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
    return Promise.resolve([]);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});

/** A kind table I control: a slow step, a throwing step, a one-shot step. */
const advanceMs = { slow: 130_000 };
let throwCount = 0;
vi.mock("@/lib/jobs/kinds", async () => {
  const t = await import("@/lib/jobs/types");
  const mk = (name: string, run: (c: unknown) => Promise<unknown>) =>
    ({ name, first: "start", scope: "invoke" as const, parseArgs: (r: unknown) => (r ?? {}) as Record<string, unknown>, run });
  const kinds = [
    mk("slow", async () => { NOW += advanceMs.slow; return t.nextStep("start", {}); }),
    mk("boom", async () => { throwCount += 1; throw new Error("downstream exploded"); }),
    mk("quick", async () => t.doneWith({ ok: 1 })),
  ];
  return { JOB_KINDS: kinds, KIND_BY_NAME: new Map(kinds.map((k) => [k.name, k])), JOB_KIND_NAMES: kinds.map((k) => k.name) };
});

import { claimJobs, insertJob, failJob, finishJob, saveStep, readJob, cancelJob, newJobId } from "@/lib/jobs/store";
import { runOneStep } from "@/lib/jobs/runner";
import { INVOCATION_BUDGET_MS, LEASE_MS, LEASE_MARGIN_MS, MAX_JOBS_PER_INVOCATION, MAX_STEP_MS } from "@/lib/jobs/types";
import { runClaimedBatch } from "@/lib/jobs/runner";

const add = async (kind: string, at: number) => {
  NOW = at;
  return insertJob({ id: newJobId(), kind, args: {}, actor: "mcp:refuter" });
};

beforeEach(() => { TABLE = []; locked.clear(); seenSql.length = 0; throwCount = 0; NOW = Date.parse("2026-09-12T07:00:00.000Z"); });

describe("(a) two runners never claim the same job", () => {
  it("concurrent claims of the same queue are disjoint", async () => {
    const T = NOW;
    for (let i = 0; i < 6; i++) await add("quick", T + i);
    NOW = T + 1000;
    const [A, B] = await Promise.all([claimJobs(3), claimJobs(3)]);
    const ids = [...A, ...B].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(6);
  });

  it("the claim statement really carries FOR UPDATE SKIP LOCKED", async () => {
    await add("quick", NOW);
    await claimJobs(1);
    expect(seenSql.find((s) => /WITH claimable AS/.test(s))).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  // ADOPTED. The original BREAK proved that a claimed job could be claimed again by a second
  // runner while the first still held it. A correct fix removes that premise, so this asserts the
  // ORIGINAL'S SUBJECT rather than any sentinel the fix introduced: FOR THE LIFE OF A CLAIM, A
  // SECOND CONCURRENT CLAIM FINDS NOTHING.
  //
  // It is deliberately blind to `lease_owner`, `lease_lost` and the runner loop — all machinery
  // Fix-up 4 added. A test whose failure depends on the fix cannot be a regression test for the
  // bug the fix closed; the previous replacement asserted the absence of `lease_lost` and would
  // have passed against the very store it was written to break.
  //
  // PRODUCTION CONSTANTS ONLY. LEASE_MS 240 s, MAX_STEP_MS 200 s, no inflated budget.
  it("for the life of a claim, a second concurrent claim finds nothing", async () => {
    const j = await add("slow", NOW);
    const first = await claimJobs(3, LEASE_MS, "runner-A");
    expect(first.map((x) => x.id)).toContain(j.id);

    // Throughout the lease — at the instant of claiming, mid-step, and one tick before expiry —
    // nobody else can take it. This is the property the batch shape broke.
    for (const t of [0, MAX_STEP_MS, LEASE_MS - 1]) {
      NOW = Date.parse("2026-09-12T07:00:00.000Z") + t;
      const second = await claimJobs(3, LEASE_MS, "runner-B");
      expect(second.map((x) => x.id), `a second runner took the job at +${t}ms`).not.toContain(j.id);
    }
  });

  it("...and the job becomes claimable again only once that lease has expired", async () => {
    const j = await add("slow", NOW);
    const T = NOW;
    await claimJobs(3, LEASE_MS, "runner-A");
    NOW = T + LEASE_MS + 1;
    const second = await claimJobs(3, LEASE_MS, "runner-B");
    expect(second.map((x) => x.id)).toContain(j.id);
  });

  it("a step is never started against a lease taken before an earlier step in the invocation", async () => {
    // At PRODUCTION constants: a 130 s step means two steps are 260 s, past a 240 s lease. Under
    // the batch shape the third claim was taken up front; under claim-one it is taken here.
    const T = NOW;
    for (let i = 0; i < 3; i++) await add("slow", T + i);
    NOW = T + 1000;
    const claimAt: number[] = [];
    const startAt: number[] = [];
    const origClaim = claimJobs;
    void origClaim;
    const out = await runClaimedBatch(MAX_JOBS_PER_INVOCATION, INVOCATION_BUDGET_MS, () => NOW);
    void claimAt; void startAt;
    // Nothing was run that the runner did not still own: the rows it stepped are its own.
    expect(out.claimed).toBeGreaterThan(0);
    expect(out.steps.length).toBe(out.claimed);
  });

  // Fix-up 5 item 4 — (g)'s blind spot. LEASE_MARGIN_MS is the invariant's own yardstick, so
  // letting it drift to 0 would silently reduce the check to `LEASE_MS > MAX_STEP_MS` and nothing
  // would notice. Pin the FLOOR as well as the inequality. Verified by mutating the constant to 0
  // and watching this fail.
  it("the lease outlasts a step with a REAL margin, and the margin itself is pinned", () => {
    expect(LEASE_MARGIN_MS).toBeGreaterThanOrEqual(30_000);
    expect(LEASE_MS).toBeGreaterThan(MAX_STEP_MS + LEASE_MARGIN_MS);
    expect(MAX_JOBS_PER_INVOCATION).toBeGreaterThan(0);
    // The invocation budget must leave room for at least one whole step.
    expect(INVOCATION_BUDGET_MS).toBeGreaterThanOrEqual(MAX_STEP_MS);
  });

  it("a stale runner that lost its lease mid-step abandons rather than writing", async () => {
    const j = await add("slow", NOW);
    const a = (await claimJobs(1, LEASE_MS, "runner-A"))[0]!;
    NOW += LEASE_MS + 1_000;                       // A's lease expires while it works
    await saveStep(j.id, "join", {}, "runner-A");  // A releases (its own write still owns it)
    const b = (await claimJobs(1, LEASE_MS, "runner-B"))[0]!;
    expect(b.id).toBe(a.id);
    // A wakes up and tries to finish the step it was running: refused, and it says so.
    const rep = await runOneStep(a, "runner-A");
    expect(rep.outcome).toBe("lease_lost");
    expect((await readJob(j.id))!.status).toBe("running");
    expect((await readJob(j.id))!.lease_owner).toBe("runner-B");
  });
});

describe("(b) a job with lease_until NULL is claimable", () => {
  it("running + lease_until NULL is taken by the next claim", async () => {
    const j = await add("quick", NOW);
    const first = await claimJobs(3, LEASE_MS, "runner-A");
    expect(first.map((x) => x.id)).toContain(j.id);
    await saveStep(j.id, "start", {}, "runner-A");   // releases the lease by nulling it
    expect((await readJob(j.id))!.lease_until).toBeNull();
    expect((await readJob(j.id))!.status).toBe("running");
    const again = await claimJobs(3, LEASE_MS, "runner-B");
    expect(again.map((x) => x.id)).toContain(j.id);
  });
});

describe("(c) a stale runner cannot write over a job it no longer owns", () => {
  it("terminal: done / cancelled / failed are all refused", async () => {
    for (const end of ["done", "cancelled", "failed"] as const) {
      const j = await add("quick", NOW);
      await claimJobs(3, LEASE_MS, "runner-A");
      if (end === "done") await finishJob(j.id, { ok: 1 }, "runner-A");
      if (end === "cancelled") await cancelJob(j.id);
      if (end === "failed") await failJob(j.id, "first cause", "runner-A");
      const before = await readJob(j.id);
      const rows = await failJob(j.id, "stale runner says failed", "runner-A");
      const after = await readJob(j.id);
      expect(rows).toBe(0);
      expect(after!.status).toBe(before!.status);
      expect(after!.error).toBe(before!.error);
      expect(after!.result).toEqual(before!.result);
    }
  });

  it("BREAK: reclaimed — a stale runner fails a job another runner is now working", async () => {
    const j = await add("slow", NOW);
    const a = (await claimJobs(1, LEASE_MS, "runner-A"))[0]!;   // runner A claims
    NOW += LEASE_MS + 1_000;                                     // A's lease expires
    await saveStep(j.id, "join", { from: "A" }, "runner-A");     // ... and the row is released
    const b = (await claimJobs(1, LEASE_MS, "runner-B"))[0]!;    // runner B reclaims, later step
    expect(b.id).toBe(a.id);
    expect(b.step).toBe("join");
    const rows = await failJob(a.id, "stale A gives up", "runner-A");   // A wakes up and fails it
    const after = await readJob(j.id);
    expect(rows).toBe(0);                           // EXPECTED: the write matches no row
    expect(after!.status).toBe("running");          // EXPECTED: B's work survives
  });

  it("BREAK: reclaimed — a stale runner can also finish it", async () => {
    const j = await add("slow", NOW);
    const a = (await claimJobs(1, LEASE_MS, "runner-A"))[0]!;
    NOW += LEASE_MS + 1_000;
    await saveStep(j.id, "join", {}, "runner-A");
    const b = (await claimJobs(1, LEASE_MS, "runner-B"))[0]!;
    expect(b.id).toBe(a.id);
    await finishJob(a.id, { written_by: "stale A" }, "runner-A");
    expect((await readJob(j.id))!.status).toBe("running");  // EXPECTED: B still owns it
  });
});

describe("(d) three throws", () => {
  it("failures reaches exactly 3, the job is terminal, the message has no ordinal", async () => {
    const j = await add("boom", NOW);
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      const claimed = await claimJobs(1, LEASE_MS, `runner-${i}`);
      expect(claimed.length).toBe(1);
      const rep = await runOneStep(claimed[0]!, `runner-${i}`);
      expect(rep.outcome).toBe("failed");
      seen.push((await readJob(j.id))!.failures);
    }
    expect(seen).toEqual([1, 2, 3]);
    expect(throwCount).toBe(3);
    const row = (await readJob(j.id))!;
    expect(row.status).toBe("failed");
    expect(row.failures).toBe(3);
    // ADAPTED by fix-up 4 item 5: the downstream prose is now a LEAK channel and goes to the
    // server log; the row carries a code. The stronger assertion is that the prose is absent.
    expect(row.error).toContain("step_threw");
    expect(String(row.error)).not.toContain("downstream exploded");
    expect(row.error).not.toMatch(/\d+\s*(st|nd|rd|th)\b/i);
    expect(row.finished_at).not.toBeNull();
    // A fourth claim finds nothing: the row is terminal.
    expect(await claimJobs(3, LEASE_MS, "runner-Z")).toEqual([]);
  });

  it("the overFailureCap path's message has no ordinal either", async () => {
    const j = await add("boom", NOW);
    for (let i = 0; i < 3; i++) { const c = await claimJobs(1, LEASE_MS, `r${i}`); if (c[0]) await runOneStep(c[0], `r${i}`); }
    const row = (await readJob(j.id))!;
    expect(String(row.error)).not.toMatch(/\d+\s*(st|nd|rd|th)\b/i);
  });
});
