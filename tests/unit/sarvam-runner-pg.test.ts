/**
 * tests/unit/sarvam-runner-pg.test.ts — REQUIRED PROOF (G26, G27, G28/G23) on a real postgres:16 with the REAL runner: claimJobs, runOneStep, recordFailure, the
 * 0082 scribe_job table, the real sarvam_transcribe kind. Only the Sarvam gateway and the lab ledger are mocked. audit_log has a CHECK that REJECTS stt.paid_call.
 *   G26  three claims while the audit write fails: the job is NOT failed, the start evidence survives every claim, exactly ONE Sarvam start, the minutes stay reserved,
 *        the ledger line carries the measured audio; when the database accepts the row again it lands exactly once.
 *   G27  nothing releases the lease mid-step: a second runner cannot claim the job while the step runs.
 *   G28  findOpenJob matches fully in SQL (a 61st open job is still found), and mode / english / num_speakers are part of the identity (G23).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({
  sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>),
  onAuditInsert: null as null | (() => Promise<void>),
  gwState: "Pending" as string,
  starts: 0,
  lines: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/db", () => ({
  sql: async (s: TemplateStringsArray, ...v: unknown[]) => {
    if (H.onAuditInsert && /INSERT INTO audit_log/.test(s.join("?"))) await H.onAuditInsert();
    return H.sql!(s, ...v);
  },
}));
vi.mock("@/lib/sarvam-gw", async (orig) => ({
  ...((await orig()) as object),
  gwBatchStatus: async () => ({ ok: true, state: H.gwState, outputs: [] }),
  gwBatchStartJob: async () => { H.starts += 1; H.gwState = "Running"; return { ok: true }; },
}));
vi.mock("@/lib/sarvam-lab", async (orig) => ({
  ...((await orig()) as object),
  appendLedger: async (l: Record<string, unknown>) => { H.lines.push(l); },
  touchLane: async () => undefined,
}));

const HAVE = dockerAvailable();
const pg = pgContainer("eta-sarvam-runner");
const row = async (id: string) => (await pg.sql`SELECT id, status, step, progress, failures, error, lease_owner, lease_until FROM scribe_job WHERE id = ${id}`)[0] as Record<string, any>;
const MIN30 = 30 * 60_000;

beforeAll(async () => {
  if (!HAVE) return;
  pg.start();
  pg.exec(`CREATE TABLE schema_migrations (version text PRIMARY KEY, name text, applied_at timestamptz DEFAULT now());`); // 0082 registers itself here
  pg.exec(readFileSync("db/migrations/0082_scribe_job.sql", "utf8"));
  pg.exec(`
    CREATE TABLE audit_log (id bigserial PRIMARY KEY, actor_type text, actor_id text, action text NOT NULL, target_type text, target_id text, metadata_json jsonb, created_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE audit_log ADD CONSTRAINT audit_rejects_paid_call CHECK (action <> 'stt.paid_call');
  `);
  H.sql = pg.sql as never;
}, 180_000);
afterAll(() => { if (HAVE) pg.stop(); });

describe("REQUIRED PROOF ran, or was skipped deliberately", () => {
  it("needs Docker", () => {
    if (HAVE || process.env.ETA_ALLOW_SKIP_E2E === "1") return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/sarvam-runner-pg.test.ts needs Docker for postgres:16, or set ETA_ALLOW_SKIP_E2E=1.");
  });
});

describe.runIf(HAVE)("sarvam_transcribe through the real runner with an audit_log that rejects stt.paid_call", () => {
  const JOB = "job_g26a";
  const progress = { clip_key: "clip.webm", content_type: "audio/webm", sarvam_job_id: "sj_9", duration_ms: MIN30, scope: "encounter", ref: "enc_1", started_at: "2026-10-08T06:00:00.000Z" };
  let ctxMods: { claimJobs: any; runOneStep: any; reserved: any };

  beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => undefined); });
  beforeAll(async () => {
    if (!HAVE) return;
    const C = await import("@/lib/jobs/kinds/sarvam-common");
    C.auditRetry.delaysMs = [0, 0, 0];
    const T = await import("@/lib/jobs/kinds/sarvam-transcribe");
    T.sarvamTiming.pollStepMs = 0;
    T.sarvamTiming.pollIntervalMs = 0;
    ctxMods = { claimJobs: (await import("@/lib/jobs/store")).claimJobs, runOneStep: (await import("@/lib/jobs/runner")).runOneStep, reserved: C.reservedMinutesEarlier };
    await pg.sql`INSERT INTO scribe_job (id, kind, args, status, step, progress, actor) VALUES (${JOB}, 'sarvam_transcribe', ${JSON.stringify({ source: "encounter", encounter_id: "enc_1", mode: "transcribe", english: true })}::jsonb, 'running', 'start', ${JSON.stringify(progress)}::jsonb, 'mcp:tester')`;
    await pg.sql`UPDATE scribe_job SET lease_until = NULL, lease_owner = NULL WHERE id = ${JOB}`;
  });

  const claimRun = async (runner: string) => {
    const [job] = await ctxMods.claimJobs(1, 240_000, runner);
    expect(job?.id).toBe(JOB);
    return ctxMods.runOneStep(job, runner);
  };

  it("G27: while the start step runs, a second runner cannot claim the job (nothing releases the lease mid-step)", async () => {
    H.gwState = "Pending";
    let secondClaim: unknown[] | null = null;
    H.onAuditInsert = async () => {
      const mid = await row(JOB);
      expect(mid.lease_owner).toBe("runner-1"); // still held, with a live lease
      expect(new Date(mid.lease_until).getTime()).toBeGreaterThan(Date.now());
      if (secondClaim === null) secondClaim = await ctxMods.claimJobs(1, 240_000, "runner-2");
    };
    const rep = await claimRun("runner-1");
    H.onAuditInsert = null;
    expect(secondClaim).toEqual([]);
    expect(rep.outcome).toBe("advanced");
  });

  it("G26: the first claim moved to poll with the start evidence and audit_pending; the job is running, not failed, and Sarvam was started exactly once", async () => {
    const r = await row(JOB);
    expect(r).toMatchObject({ status: "running", step: "poll", failures: 0 });
    expect(r.progress).toMatchObject({ sarvam_job_id: "sj_9", duration_ms: MIN30, audit_pending: true });
    expect(Number(r.progress.sarvam_started_ms)).toBeGreaterThan(0);
    expect(H.starts).toBe(1);
  });

  it("G26: three MORE claims with the audit still failing: never failed, evidence intact every time, still one start; the minutes stay reserved; a different job sees them", async () => {
    for (const runner of ["runner-3", "runner-4", "runner-5"]) {
      const rep = await claimRun(runner);
      expect(rep.outcome).toBe("advanced");
      const r = await row(JOB);
      expect(r).toMatchObject({ status: "running", step: "poll", failures: 0 });
      expect(r.progress).toMatchObject({ audit_pending: true });
      expect(Number(r.progress.sarvam_started_ms)).toBeGreaterThan(0);
    }
    expect(H.starts).toBe(1);
    expect(await pg.sql`SELECT 1 FROM audit_log WHERE action = 'stt.paid_call'`).toHaveLength(0);
    const other = { id: "job_zzz_other", created_at: new Date(Date.now() + 60_000).toISOString() };
    expect(await ctxMods.reserved(other)).toBeCloseTo(30, 5); // the running job in poll with no audit row holds its 30 minutes
  });

  it("G26: the database accepts the row again -> it lands exactly ONCE, audit_pending is dropped, still one start; then the job ends and its ledger line carries the measured audio", async () => {
    pg.exec(`ALTER TABLE audit_log DROP CONSTRAINT audit_rejects_paid_call;`);
    await claimRun("runner-6");
    const r = await row(JOB);
    expect(r.progress).not.toHaveProperty("audit_pending");
    expect(await pg.sql`SELECT metadata_json FROM audit_log WHERE action = 'stt.paid_call' AND metadata_json->>'job_id' = ${JOB}`).toHaveLength(1);
    expect(await ctxMods.reserved({ id: "job_zzz_other", created_at: new Date(Date.now() + 60_000).toISOString() })).toBe(0); // audited now, no longer reserved
    await claimRun("runner-7");
    expect(await pg.sql`SELECT 1 FROM audit_log WHERE action = 'stt.paid_call' AND metadata_json->>'job_id' = ${JOB}`).toHaveLength(1);
    expect(H.starts).toBe(1);
    H.gwState = "Failed"; // Sarvam ends the job
    await claimRun("runner-8");
    expect(await row(JOB)).toMatchObject({ status: "failed" });
    const line = H.lines.at(-1)!;
    expect(line).toMatchObject({ job_id: JOB, request_id: "sj_9", status: "failed", audio_s: 1800 });
  });

  it("G26 (runner kill path): a job that ran out of FAILURES after Sarvam started still ledgers the measured audio and keeps its reservation", async () => {
    const id = "job_g26b";
    const p = { ...progress, sarvam_started_ms: Date.now(), audit_pending: true };
    await pg.sql`INSERT INTO scribe_job (id, kind, args, status, step, progress, failures, actor) VALUES (${id}, 'sarvam_transcribe', ${JSON.stringify({ source: "encounter", encounter_id: "enc_2", mode: "transcribe", english: true })}::jsonb, 'running', 'poll', ${JSON.stringify(p)}::jsonb, 3, 'mcp:tester')`;
    const [job] = await ctxMods.claimJobs(1, 240_000, "runner-9");
    expect(job.id).toBe(id);
    const rep = await ctxMods.runOneStep(job, "runner-9"); // over the failure cap: the runner fails it and the end hook writes the line
    expect(rep.outcome).toBe("failures_exceeded");
    expect(H.lines.at(-1)).toMatchObject({ job_id: id, status: "failed", audio_s: 1800 });
    expect(await ctxMods.reserved({ id: "job_zzz_other", created_at: new Date(Date.now() + 60_000).toISOString() })).toBeCloseTo(30, 5); // failed, started, unaudited: held
  });
});

describe.runIf(HAVE)("findOpenJob in real SQL (G28, G23)", () => {
  const args = (o: Record<string, unknown>) => JSON.stringify({ source: "encounter", encounter_id: "enc_9", mode: "transcribe", english: true, ...o });
  it("no row cap: the match is found behind 60 open jobs that match only in part; options are part of the identity", async () => {
    const { findOpenJob } = await import("@/lib/jobs/store");
    for (let i = 0; i < 60; i++) {
      await pg.sql`INSERT INTO scribe_job (id, kind, args, status) VALUES (${"job_f" + String(i).padStart(3, "0")}, 'sarvam_transcribe', ${args({})}::jsonb, 'queued')`;
    }
    const pairs = (o: { mode?: string; english?: string; num_speakers?: string | null }): Array<[string, string | null]> =>
      [["encounter_id", "enc_9"], ["mode", o.mode ?? "transcribe"], ["english", o.english ?? "true"], ["num_speakers", o.num_speakers ?? null]];
    // the 61st open job differs only in num_speakers (a THIRD/FOURTH pair): the old LIMIT 50 + code filter could not reach it
    await pg.sql`INSERT INTO scribe_job (id, kind, args, status) VALUES ('job_g999', 'sarvam_transcribe', ${args({ num_speakers: 2 })}::jsonb, 'running')`;
    expect((await findOpenJob("sarvam_transcribe", pairs({ num_speakers: "2" })))?.id).toBe("job_g999");
    expect((await findOpenJob("sarvam_transcribe", pairs({})))?.id).toBe("job_f000"); // oldest first, num_speakers absent
    expect(await findOpenJob("sarvam_transcribe", pairs({ mode: "codemix" }))).toBeNull(); // G23
    expect(await findOpenJob("sarvam_transcribe", pairs({ english: "false" }))).toBeNull();
    expect(await findOpenJob("sarvam_transcribe", pairs({ num_speakers: "3" }))).toBeNull();
    expect(await findOpenJob("sarvam_translate", [["encounter_id", "enc_9"]])).toBeNull(); // another kind
    await pg.sql`UPDATE scribe_job SET status = 'done' WHERE id = 'job_g999'`;
    expect(await findOpenJob("sarvam_transcribe", pairs({ num_speakers: "2" }))).toBeNull(); // finished = not open
  });
});
