/**
 * C2 — A 900 s WINDOW THROUGH THE REAL RUNNER, AGAINST A REAL POSTGRES. ONE /diarize CALL.
 *
 * Three times in this slice a core path shipped inert and every unit test stayed green: the lease
 * made diarize unreachable, the join loaded zero turns, and the stitch matched on a key another
 * statement had already consumed. All three survived because the tests mocked the database and
 * called the step functions directly, so nothing ever exercised the ORDER the job actually runs in
 * or the PREDICATES the database actually applies.
 *
 * This drives `runOneStep` over a real `scribe_job` row — real claims, real leases, real progress
 * — against an ephemeral postgres:16 with the real 0074 and 0085 DDL. Only the outside world is
 * faked: `/diarize` (with the shape captured from a real response) and R2. The database is not
 * faked, and neither is the runner.
 *
 * EVERY COUNTER THIS FEATURE REPORTS IS ASSERTED NON-ZERO on the happy path. A counter that is
 * always zero is how `rows_stitched` stayed at 0 through an entire review round.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, startPg, stopPg, exec, makeSql } from "../support/pg-harness";

const HAVE_DOCKER = dockerAvailable();
/**
 * ─── A PROOF THAT CAN SILENTLY SKIP IS NOT A PROOF ─────────────────────────────────────────────
 *
 * This suite is the only thing in the repo that exercises the diarize path end to end against a
 * real database. `describe.skipIf` made it evaporate on any machine without Docker while `npm test`
 * still printed green — which is precisely the failure mode that let three inert paths ship: the
 * lease that made diarize unreachable, the join that loaded zero turns, and the stitch that matched
 * a key another statement had consumed. Each of those was green in CI the whole time.
 *
 * So a skip is now a FAILURE. Not a warning, not a console line: the run exits non-zero and names
 * the proof that did not run. Local convenience still exists, but it has to be asked for on
 * purpose — ETA_ALLOW_SKIP_E2E=1 — which is a thing a person types, unlike a missing binary.
 */
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";

describe("REQUIRED PROOF — the diarize end-to-end suite", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER) return;
    if (ALLOW_SKIP) return;
    throw new Error(
      "REQUIRED PROOF NOT RUN: tests/unit/c2-e2e-runner.test.ts needs Docker to start an ephemeral " +
      "postgres:16, and Docker is not available here. This suite is the ONLY end-to-end cover for " +
      "the diarize job (real runner, real claims and leases, real 0074/0085 constraints); three " +
      "inert paths have already shipped green without it. Install/start Docker, or set " +
      "ETA_ALLOW_SKIP_E2E=1 to accept that this proof did not run.",
    );
  });
});

const QUERIES: string[] = [];
type PgSql = (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>;
const G = globalThis as unknown as { __pgsql: PgSql };
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => G.__pgsql(s, ...v) }));
vi.mock("@/lib/r2", () => ({ getObjectBytes: async () => new Uint8Array([1, 2, 3, 4]), signGetUrl: async () => "https://r2.example/x" }));
vi.mock("@/lib/bench-join", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  joinServiceConfigured: () => true,
  callJoinService: async () => ({ ok: true, key: "clips/slice.webm" }),
}));

/**
 * The captured /diarize response shape. Two speakers: idx 0 matched to an enrolled clinician
 * (as a real match arrives — clinician_id AND confidence together), idx 1 unmatched.
 * Embeddings are real 192-float vectors so the stitch's cosine has something to work on.
 */
const emb = (seed: number) => {
  const v = new Float32Array(192);
  for (let i = 0; i < 192; i += 1) v[i] = Math.sin((i + 1) * seed) * 0.1;
  return Buffer.from(v.buffer).toString("base64");
};
const DIARIZE_CALLS: string[] = [];
/** Flip to make the service fail, so the harness can prove it notices. */
const SVC = { fail: false };
vi.mock("@/lib/diarize", () => ({
  runDiarize: async (_a: unknown, _c: string, opts: { encounterId: string }) => {
    DIARIZE_CALLS.push(opts.encounterId);
    if (SVC.fail) return { ok: false, error: "service refused", retryable: false, latencyMs: 0 };
    return {
      ok: true, latencyMs: 68_300,
      result: {
        // The captured shape. idx 0 is MATCHED (clinician_id and confidence together, as a real
        // match arrives); idx 1 is not. Speaker 0 holds the first half of the window, 1 the second.
        speakers: [
          { idx: 0, label: "Dr", type: "clinician", source: "auto", clinician_id: "doc_fake0001", confidence: 0.82, embedding_base64: emb(1) },
          { idx: 1, label: "Patient", type: "patient", source: "heuristic", embedding_base64: emb(2) },
        ],
        transcript_segments: [
          { start_ms: 0, end_ms: 450_000, speaker_idx: 0, overlap: false },
          { start_ms: 450_000, end_ms: 900_000, speaker_idx: 1, overlap: false },
        ],
        overlap_windows: [], aggregates: {}, model_versions: {},
      },
    };
  },
}));

const WINDOW_MS = 900_000;

function schema(): void {
  // The job table, verbatim from 0082 — this is what the runner claims and leases against.
  const m0082 = readFileSync("db/migrations/0082_scribe_job.sql", "utf8")
    .replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");
  // room_turn_speaker + room_diarize_window, verbatim from 0074, then 0085 verbatim on top.
  const m0074 = readFileSync("db/migrations/0074_room_diarize.sql", "utf8");
  const keep = (name: string) => {
    const i = m0074.indexOf(`CREATE TABLE IF NOT EXISTS ${name}`);
    return m0074.slice(i, m0074.indexOf(");", i) + 2);
  };
  const m0085 = readFileSync("db/migrations/0085_room_turn_speaker_role.sql", "utf8")
    .replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");
  // ORDER MATTERS: 0074's tables carry REFERENCES bench_window(id), so the app tables come first.
  exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, name text);
    CREATE TABLE bench_window (id text PRIMARY KEY, session_id text, room_day_id text,
      start_ms bigint, end_ms bigint, source_mic text, clip_r2_key text, grid_aligned boolean, state text);
    CREATE TABLE bench_chunk (session_id text, idx int, source text, r2_key text, content_type text,
      started_at timestamptz, ended_at timestamptz, upload_state text);
    CREATE TABLE cue (id text PRIMARY KEY, room_day_id text, type text, source text, source_ref text,
      payload jsonb, at timestamptz DEFAULT now());
    CREATE TABLE voice_print (doctor_id text PRIMARY KEY, centroid bytea);
    CREATE TABLE clinician (id text PRIMARY KEY, full_name text);
  `);
  exec(m0082);
  exec(keep("room_turn_speaker"));
  exec(keep("room_diarize_window"));
  exec(m0085);
}

/** A 900 s window whose turns leave a clean gap near every 120 s mark, plus one deliberate straddle. */
function seed(): void {
  exec(`
    INSERT INTO bench_window VALUES ('bw_e2e','sess_1','rd_1',0,${WINDOW_MS},'primary','clips/w.webm',true,'transcribed');
    -- The window is epoch 0..900000, so the chunk must cover THAT, not wall-clock now.
    INSERT INTO bench_chunk VALUES ('sess_1',0,'primary','chunks/a.webm','audio/webm', to_timestamp(0), to_timestamp(900), 'uploaded');
    INSERT INTO clinician VALUES ('doc_fake0001','Fakedock Fakedocl');
    INSERT INTO voice_print VALUES ('doc_fake0001', decode('${emb(1)}','base64'));
  `);
  const rows: string[] = [];
  let n = 0;
  for (let t = 0; t < WINDOW_MS; t += 20_000) {
    // 15 s turns with 5 s gaps: a clean edge exists near every nominal mark.
    const s = t, e = Math.min(WINDOW_MS, t + 15_000);
    rows.push(`('c${n}','rd_1','stt_turn','replay','sess_1|${s}|${e}|w', '{"start_ms":${s},"end_ms":${e},"window":{"start_ms":0,"end_ms":${WINDOW_MS}}}'::jsonb)`);
    n += 1;
  }
  // THE STRADDLE: a turn spanning the 450 s speaker change.
  rows.push(`('cstr','rd_1','stt_turn','replay','sess_1|445000|455000|w', '{"start_ms":445000,"end_ms":455000,"window":{"start_ms":0,"end_ms":${WINDOW_MS}}}'::jsonb)`);
  exec(`INSERT INTO cue (id, room_day_id, type, source, source_ref, payload) VALUES ${rows.join(",")};`);
}

// ONE CONTAINER FOR THE FILE. Every suite below needs the same schema, and starting a postgres
// per describe would triple the run for no extra proof.
beforeAll(() => {
  if (!HAVE_DOCKER) return;
  startPg();
  G.__pgsql = makeSql((q) => QUERIES.push(q));
  schema();
  seed();
}, 180_000);
afterAll(() => { if (HAVE_DOCKER) stopPg(); });

/** Run the job to a terminal state through the real runner, returning the steps it took. */
async function runJob(id: string, windowId: string): Promise<{ steps: string[]; status: string; result: Record<string, unknown> | null; error: string | null }> {
  const { insertJob, claimJobs } = await import("@/lib/jobs/store");
  const { runOneStep } = await import("@/lib/jobs/runner");
  const sql = G.__pgsql;
  await insertJob({ id, kind: "diarize_window", args: { window_id: windowId }, actor: "mcp:test" });
  const steps: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const claimed = await claimJobs(1, 240_000, `runner_${id}_${i}`);
    if (claimed.length === 0) break;
    steps.push(String(claimed[0]!.step ?? "(first)"));
    await runOneStep(claimed[0]!, `runner_${id}_${i}`);
    const st = (await sql`SELECT status FROM scribe_job WHERE id = ${id}`) as Array<{ status: string }>;
    if (st[0]?.status === "done" || st[0]?.status === "failed") break;
  }
  const row = (await sql`SELECT status, result, error FROM scribe_job WHERE id = ${id}`) as Array<{ status: string; result: Record<string, unknown> | null; error: string | null }>;
  return { steps, ...row[0]! };
}

describe.skipIf(!HAVE_DOCKER)("C2 e2e — a 900 s window through runOneStep, real postgres, ONE call", () => {
  it("one step, one /diarize call, rows written and counted, every counter non-zero", async () => {
    const sql = G.__pgsql;
    DIARIZE_CALLS.length = 0;
    SVC.fail = false;
    const r = await runJob("job_e2e", "bw_e2e");

    // ── THE SHAPE ACTUALLY EXECUTED ────────────────────────────────────────────────────────
    expect(r.steps, "a whole window is ONE step now").toEqual(["(first)"]);
    expect(DIARIZE_CALLS, "ONE /diarize call for the whole 900 s window").toEqual(["bw_e2e"]);
    expect(r.status, `job must reach done; error=${r.error}`).toBe("done");

    // ── ROWS, COUNTED ──────────────────────────────────────────────────────────────────────
    const rows = (await sql`SELECT source_ref, role, clinician_id, match_confidence, no_role_reason FROM room_turn_speaker WHERE window_id = 'bw_e2e'`) as Array<{ source_ref: string; role: string | null; clinician_id: string | null; match_confidence: number | null; no_role_reason: string | null }>;
    const turnCount = (await sql`SELECT count(*)::int AS n FROM cue WHERE type = 'stt_turn'`) as Array<{ n: number }>;
    expect(rows.length, "every turn overlapping a diarize segment must produce a span row").toBe(turnCount[0]!.n);
    expect(Number(r.result!.bound), "and the job must report the same number it wrote").toBe(rows.length);

    // ── EVERY COUNTER NON-ZERO ON THE HAPPY PATH ───────────────────────────────────────────
    // A counter that is always zero is how an inert stitch stayed green for a whole round.
    for (const k of ["spans", "turns", "bound", "named", "straddled", "speakers"]) {
      expect(Number(r.result![k]), `${k} must be non-zero on the happy path`).toBeGreaterThan(0);
    }

    // ── THE STRADDLE IS REFUSED, BY NAME, IN THE DATABASE ──────────────────────────────────
    const straddle = rows.find((x) => x.source_ref === "sess_1|445000|455000|w")!;
    expect(straddle.role, "a turn held by two speakers may never be named").toBeNull();
    expect(straddle.no_role_reason).toBe("straddle");
    expect(straddle.clinician_id).toBeNull();

    // ── NAMES ONLY WHERE A MATCH WAS MADE ──────────────────────────────────────────────────
    const named = rows.filter((x) => x.role === "clinician");
    expect(named.length).toBe(Number(r.result!.named));
    for (const x of named) {
      expect(x.clinician_id).toBe("doc_fake0001");
      expect(x.match_confidence).toBe(0.82);
      expect(x.no_role_reason, "a named row states no refusal").toBeNull();
    }
    // Speaker 1 was never matched: its exclusive turns are unnamed with no_match, never "someone else".
    const unnamed = rows.filter((x) => x.role === null && x.no_role_reason === "no_match");
    expect(unnamed.length, "the unmatched speaker's turns must be recorded as no_match").toBeGreaterThan(0);
  }, 300_000);

  it("FAILS FOR THE RIGHT REASON: a service refusal fails the job and writes nothing", async () => {
    const sql = G.__pgsql;
    await sql`DELETE FROM room_turn_speaker WHERE window_id = 'bw_e2e'`;
    SVC.fail = true;
    const r = await runJob("job_e2e_fail", "bw_e2e");
    SVC.fail = false;
    expect(r.status, "a refused /diarize must never read as done").toBe("failed");
    expect(String(r.error)).toContain("diarize_failed");
    const rows = (await sql`SELECT count(*)::int AS n FROM room_turn_speaker WHERE window_id = 'bw_e2e'`) as Array<{ n: number }>;
    expect(rows[0]!.n, "a failed run writes no spans").toBe(0);
  }, 300_000);
});

/** Claim and run whatever is queued until nothing is claimable. The runner, not a shortcut. */
async function drainQueue(tag: string): Promise<void> {
  const { claimJobs } = await import("@/lib/jobs/store");
  const { runOneStep } = await import("@/lib/jobs/runner");
  for (let i = 0; i < 20; i += 1) {
    const claimed = await claimJobs(1, 240_000, `runner_${tag}_${i}`);
    if (claimed.length === 0) return;
    await runOneStep(claimed[0]!, `runner_${tag}_${i}`);
  }
}

/** An eligible window: closed, grid-aligned, with a room_day and a clip, nothing stored yet. */
async function seedWindow(id: string, session: string, startMs: number, withTurn = false): Promise<void> {
  const sql = G.__pgsql;
  await sql`INSERT INTO bench_window VALUES (${id}, ${session}, 'rd_1', ${startMs}, ${startMs + WINDOW_MS}, 'primary', ${`clips/${id}.webm`}, true, 'closed')`;
  if (withTurn) {
    await sql`INSERT INTO cue (id, room_day_id, type, source, source_ref, payload)
              VALUES (${`c_${id}`}, 'rd_1', 'stt_turn', 'replay', ${`${session}|${startMs + 1000}|${startMs + 5000}|w`},
                      ${JSON.stringify({ start_ms: startMs + 1000, end_ms: startMs + 5000, window: { start_ms: startMs, end_ms: startMs + WINDOW_MS } })}::jsonb)`;
  }
}

describe.skipIf(!HAVE_DOCKER)("C2 Ruling 2 — one writer per table, and the live reader is still fed", () => {
  it("the CALIBRATION READER gets data through its own code path after a job runs", async () => {
    const sql = G.__pgsql;
    SVC.fail = false;
    await seedWindow("bw_cal", "sess_cal", 2 * WINDOW_MS);
    const r = await runJob("job_cal", "bw_cal");
    expect(r.status, `the job must finish; error=${r.error}`).toBe("done");

    // The row the reader depends on, written by the job — the only writer now.
    const stored = (await sql`SELECT state FROM room_diarize_window WHERE window_id = 'bw_cal'`) as Array<{ state: string }>;
    expect(stored.map((x) => x.state)).toEqual(["ok"]);

    // THE READER'S OWN PATH: the real route handler, authorised the way an operator calls it.
    process.env.MIGRATION_SECRET = process.env.MIGRATION_SECRET || "test-secret";
    const { GET } = await import("@/app/api/admin/speaker-calibration/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest("https://x.test/api/admin/speaker-calibration?session_id=sess_cal", {
      headers: { authorization: `Bearer ${process.env.MIGRATION_SECRET}` },
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.windows_with_results, "the reader must SEE the job's row").toBe(1);
    expect(body.speakers_seen, "and the speakers inside it").toBe(2);
    expect(body.embeddings_usable, "with usable embeddings, or calibration cannot run").toBe(2);
    expect(body.note, "a fed reader carries no 'nothing stored' note").toBeNull();
    expect(body.errors).toEqual([]);
  }, 300_000);

  it("ONE WRITER, BEHAVIOURALLY: break the job's write and nothing else writes those tables", async () => {
    const sql = G.__pgsql;
    SVC.fail = false;
    await seedWindow("bw_one", "sess_one", 3 * WINDOW_MS, true);
    // Refuse every row for this window at the DATABASE, on both tables the job owns.
    exec(`ALTER TABLE room_turn_speaker ADD CONSTRAINT t_refuse_one CHECK (window_id <> 'bw_one');
          ALTER TABLE room_diarize_window ADD CONSTRAINT t_refuse_one_d CHECK (window_id <> 'bw_one');`);
    try {
      const r = await runJob("job_one", "bw_one");
      expect(r.status, "a refused write must fail the job, never read as done").toBe("failed");
      // If ANY other code wrote these tables for this window, the CHECK would have refused that
      // too — and the job could not have been the only thing that tried. Drain everything else
      // queued and confirm the tables are still empty for the window.
      await drainQueue("one");
      const t = (await sql`SELECT count(*)::int AS n FROM room_turn_speaker WHERE window_id = 'bw_one'`) as Array<{ n: number }>;
      const d = (await sql`SELECT count(*)::int AS n FROM room_diarize_window WHERE window_id = 'bw_one'`) as Array<{ n: number }>;
      expect(t[0]!.n).toBe(0);
      expect(d[0]!.n).toBe(0);
    } finally {
      exec(`ALTER TABLE room_turn_speaker DROP CONSTRAINT t_refuse_one;
            ALTER TABLE room_diarize_window DROP CONSTRAINT t_refuse_one_d;`);
    }
  }, 300_000);

  it("ONE RUN: the route enqueues, the job's write is REJECTED by postgres, and nothing reads as success", async () => {
    const sql = G.__pgsql;
    SVC.fail = false;
    process.env.SPEAKER_CLUSTERS_ENABLED = "1";
    await seedWindow("bw_rej", "sess_rej", 4 * WINDOW_MS, true);
    exec(`ALTER TABLE room_turn_speaker ADD CONSTRAINT t_refuse_rej CHECK (window_id <> 'bw_rej');`);
    try {
      // 1. THE ROUTE — the real handler, on the cron door.
      const { GET } = await import("@/app/api/admin/diarize-windows/route");
      const { NextRequest } = await import("next/server");
      const res = await GET(new NextRequest("https://x.test/api/admin/diarize-windows", { headers: { "x-vercel-cron": "1" } }));
      expect(res.status, "the enqueue itself succeeded, so the route says so").toBe(200);
      const body = (await res.json()) as { jobs: Array<{ window_id: string; job_id: string }> };
      const ref = body.jobs.find((j) => j.window_id === "bw_rej");
      expect(ref, "the route must return the job ref for the window it queued").toBeTruthy();

      // 2. THE JOB — through the real runner, where the write is refused by a real constraint.
      await drainQueue("rej");
      const job = (await sql`SELECT status, error FROM scribe_job WHERE id = ${ref!.job_id}`) as Array<{ status: string; error: string | null }>;
      expect(job[0]!.status, "the rejected write must surface as a FAILED job").toBe("failed");
      expect(String(job[0]!.error)).toMatch(/step_threw|failed/);

      // 3. NOTHING reads as success: no spans, and no 'ok' state row for the calibration reader.
      const spans = (await sql`SELECT count(*)::int AS n FROM room_turn_speaker WHERE window_id = 'bw_rej'`) as Array<{ n: number }>;
      const okRow = (await sql`SELECT count(*)::int AS n FROM room_diarize_window WHERE window_id = 'bw_rej' AND state = 'ok'`) as Array<{ n: number }>;
      expect(spans[0]!.n).toBe(0);
      expect(okRow[0]!.n, "a window whose spans were refused must not be recorded as diarized").toBe(0);
    } finally {
      exec(`ALTER TABLE room_turn_speaker DROP CONSTRAINT t_refuse_rej;`);
      delete process.env.SPEAKER_CLUSTERS_ENABLED;
    }
  }, 300_000);

  it("a failed ENQUEUE returns a non-2xx — the route never looks like success when it could not queue", async () => {
    const sql = G.__pgsql;
    process.env.SPEAKER_CLUSTERS_ENABLED = "1";
    await seedWindow("bw_enq", "sess_enq", 5 * WINDOW_MS);
    exec(`ALTER TABLE scribe_job ADD CONSTRAINT t_refuse_enq CHECK (args->>'window_id' IS DISTINCT FROM 'bw_enq');`);
    try {
      const { GET } = await import("@/app/api/admin/diarize-windows/route");
      const { NextRequest } = await import("next/server");
      const res = await GET(new NextRequest("https://x.test/api/admin/diarize-windows", { headers: { "x-vercel-cron": "1" } }));
      expect(res.status, "a refused enqueue must not be a 200").not.toBe(200);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("PIPELINE_FAILED");
      const rows = (await sql`SELECT count(*)::int AS n FROM scribe_job WHERE args->>'window_id' = 'bw_enq'`) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(0);
    } finally {
      exec(`ALTER TABLE scribe_job DROP CONSTRAINT t_refuse_enq;`);
      delete process.env.SPEAKER_CLUSTERS_ENABLED;
    }
  }, 300_000);
});
