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
import { dockerAvailable, startPg, stopPg, exec, makeSql, PG_NAME } from "../support/pg-harness";

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
  // 0088 verbatim: attempts + failure_history, the bounded-retry columns.
  exec(readFileSync("db/migrations/0088_room_diarize_window_retry.sql", "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, ""));
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

/** The cron door as Vercel Cron actually calls it: `Authorization: Bearer ${CRON_SECRET}`. */
async function cronGet(query = ""): Promise<Response> {
  process.env.CRON_SECRET = process.env.CRON_SECRET || "test-cron-secret";
  const { GET } = await import("@/app/api/admin/diarize-windows/route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest(`https://x.test/api/admin/diarize-windows${query}`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
}

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
    process.env.ROOM_DIARIZE_ENABLED = "1";
    await seedWindow("bw_rej", "sess_rej", 4 * WINDOW_MS, true);
    exec(`ALTER TABLE room_turn_speaker ADD CONSTRAINT t_refuse_rej CHECK (window_id <> 'bw_rej');`);
    try {
      // 1. THE ROUTE — the real handler, on the cron door.
      const res = await cronGet();
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
      delete process.env.ROOM_DIARIZE_ENABLED;
    }
  }, 300_000);

  it("a failed ENQUEUE returns a non-2xx — the route never looks like success when it could not queue", async () => {
    const sql = G.__pgsql;
    process.env.ROOM_DIARIZE_ENABLED = "1";
    await seedWindow("bw_enq", "sess_enq", 5 * WINDOW_MS);
    exec(`ALTER TABLE scribe_job ADD CONSTRAINT t_refuse_enq CHECK (args->>'window_id' IS DISTINCT FROM 'bw_enq');`);
    try {
      const res = await cronGet();
      expect(res.status, "a refused enqueue must not be a 200").not.toBe(200);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("PIPELINE_FAILED");
      const rows = (await sql`SELECT count(*)::int AS n FROM scribe_job WHERE args->>'window_id' = 'bw_enq'`) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(0);
    } finally {
      exec(`ALTER TABLE scribe_job DROP CONSTRAINT t_refuse_enq;`);
      delete process.env.ROOM_DIARIZE_ENABLED;
    }
  }, 300_000);
});

describe.skipIf(!HAVE_DOCKER)("C2 pre-merge — the cron door needs a secret, the flag refuses to guess, a failed window retries BOUNDED", () => {
  it("AUTH: a bare x-vercel-cron header is 401 and writes nothing; CRON_SECRET and MIGRATION_SECRET are 200", async () => {
    const sql = G.__pgsql;
    process.env.ROOM_DIARIZE_ENABLED = "1";
    process.env.CRON_SECRET = "test-cron-secret";
    process.env.MIGRATION_SECRET = process.env.MIGRATION_SECRET || "test-secret";
    const { GET } = await import("@/app/api/admin/diarize-windows/route");
    const { NextRequest } = await import("next/server");
    const before = (await sql`SELECT count(*)::int AS n FROM scribe_job`) as Array<{ n: number }>;
    try {
      for (const headers of [
        { "x-vercel-cron": "1" },
        { "x-vercel-cron": "1", authorization: "Bearer wrong" },
        { authorization: "Bearer " },
        { authorization: "bearer test-cron-secret" },
        { authorization: "test-cron-secret" },
      ] as Array<Record<string, string>>) {
        const res = await GET(new NextRequest("https://x.test/api/admin/diarize-windows", { headers }));
        expect(res.status, `headers ${JSON.stringify(Object.keys(headers))} must not authorise`).toBe(401);
      }
      const after = (await sql`SELECT count(*)::int AS n FROM scribe_job`) as Array<{ n: number }>;
      expect(after[0]!.n, "a refused call enqueues nothing").toBe(before[0]!.n);

      // An EMPTY CRON_SECRET must not turn "Bearer " into a key.
      process.env.CRON_SECRET = "";
      expect((await GET(new NextRequest("https://x.test/api/admin/diarize-windows", { headers: { authorization: "Bearer " } }))).status).toBe(401);
      process.env.CRON_SECRET = "test-cron-secret";

      expect((await cronGet()).status, "Vercel Cron's own header").toBe(200);
      expect((await GET(new NextRequest("https://x.test/api/admin/diarize-windows", { headers: { authorization: `Bearer ${process.env.MIGRATION_SECRET}` } }))).status).toBe(200);
    } finally {
      delete process.env.ROOM_DIARIZE_ENABLED;
    }
  }, 300_000);

  it("FLAG: an unrecognised ROOM_DIARIZE_ENABLED is a non-2xx through the real route, and enqueues nothing", async () => {
    const sql = G.__pgsql;
    const before = (await sql`SELECT count(*)::int AS n FROM scribe_job`) as Array<{ n: number }>;
    process.env.ROOM_DIARIZE_ENABLED = "enabled";
    try {
      const res = await cronGet();
      expect(res.status, "a value the flag does not understand must never read as off").toBe(500);
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe("PIPELINE_FAILED");
      expect(body.error?.message).toMatch(/unrecognised value/);
      expect(body.error?.message, "the env value itself is not echoed").not.toContain("enabled|");
      const after = (await sql`SELECT count(*)::int AS n FROM scribe_job`) as Array<{ n: number }>;
      expect(after[0]!.n).toBe(before[0]!.n);
      // " 1" and "true" — both read as OFF before — now enable it through the same route.
      for (const v of [" 1", "true"]) {
        process.env.ROOM_DIARIZE_ENABLED = v;
        const ok = (await (await cronGet()).json()) as { enabled?: boolean };
        expect(ok.enabled, `value ${JSON.stringify(v)}`).toBe(true);
      }
    } finally {
      delete process.env.ROOM_DIARIZE_ENABLED;
    }
  }, 300_000);

  it("RETRY: a failed window is re-enqueued until DIARIZE_MAX_ATTEMPTS, every failure is KEPT, and the stuck one is COUNTED", async () => {
    const sql = G.__pgsql;
    const { DIARIZE_MAX_ATTEMPTS } = await import("@/lib/stt/diarize-job");
    expect(DIARIZE_MAX_ATTEMPTS).toBe(3);
    // Only this test's windows are eligible, so every enqueue below is about them.
    await sql`UPDATE bench_window SET grid_aligned = false`;
    await seedWindow("bw_retry", "sess_retry", 7 * WINDOW_MS, true);
    process.env.ROOM_DIARIZE_ENABLED = "1";
    SVC.fail = true;
    try {
      const attemptsSeen: Array<number | null> = [];
      for (let round = 1; round <= DIARIZE_MAX_ATTEMPTS; round += 1) {
        const body = (await (await cronGet()).json()) as { jobs: Array<{ window_id: string; retry_of_attempt: number | null }>; exhausted: number };
        const job = body.jobs.find((j) => j.window_id === "bw_retry");
        expect(job, `round ${round}: a failed window with attempts left must be enqueued`).toBeTruthy();
        attemptsSeen.push(job!.retry_of_attempt);
        await drainQueue(`retry_${round}`);
        const row = (await sql`SELECT state, attempts, failure_history FROM room_diarize_window WHERE window_id = 'bw_retry'`) as Array<{ state: string; attempts: number; failure_history: Array<{ attempt: number; error: string }> }>;
        expect(row[0]!.state).toBe("failed");
        expect(row[0]!.attempts, `round ${round}`).toBe(round);
        // THE FAILURE IS PRESERVED, NOT ERASED: each replaced attempt is in the history, in order.
        expect(row[0]!.failure_history.map((h) => h.attempt)).toEqual(Array.from({ length: round - 1 }, (_, i) => i + 1));
        for (const h of row[0]!.failure_history) expect(h.error).toBe("service refused");
      }
      expect(attemptsSeen, "the response says which attempt each retry follows").toEqual([null, 1, 2]);

      // THE BOUND: attempts used up — not enqueued again, and VISIBLE on the response.
      const DIARIZE_BEFORE = DIARIZE_CALLS.length;
      const done = (await (await cronGet()).json()) as { jobs: Array<{ window_id: string }>; exhausted: number };
      expect(done.jobs.map((j) => j.window_id)).not.toContain("bw_retry");
      expect(done.exhausted, "a window stuck at the bound is counted, never silent").toBe(1);
      await drainQueue("retry_after");
      expect(DIARIZE_CALLS.length, "no fourth /diarize call").toBe(DIARIZE_BEFORE);
    } finally {
      SVC.fail = false;
      delete process.env.ROOM_DIARIZE_ENABLED;
    }
  }, 300_000);

  it("RETRY THAT SUCCEEDS: the window becomes ok, keeps its failure history, and is final", async () => {
    const sql = G.__pgsql;
    await sql`UPDATE bench_window SET grid_aligned = false`;
    await seedWindow("bw_retry_ok", "sess_retry_ok", 8 * WINDOW_MS, true);
    process.env.ROOM_DIARIZE_ENABLED = "1";
    try {
      SVC.fail = true;
      await cronGet(); await drainQueue("rok_1");
      SVC.fail = false;
      const body = (await (await cronGet()).json()) as { jobs: Array<{ window_id: string; retry_of_attempt: number | null }> };
      expect(body.jobs.find((j) => j.window_id === "bw_retry_ok")?.retry_of_attempt).toBe(1);
      await drainQueue("rok_2");
      const row = (await sql`SELECT state, attempts, error, failure_history FROM room_diarize_window WHERE window_id = 'bw_retry_ok'`) as Array<{ state: string; attempts: number; error: string | null; failure_history: Array<{ attempt: number; error: string }> }>;
      expect(row[0]!.state).toBe("ok");
      expect(row[0]!.attempts).toBe(2);
      expect(row[0]!.error).toBeNull();
      expect(row[0]!.failure_history).toHaveLength(1);
      expect(row[0]!.failure_history[0]!.error, "the earlier failure survives the success").toBe("service refused");
      const again = (await (await cronGet()).json()) as { jobs: Array<{ window_id: string }> };
      expect(again.jobs.map((j) => j.window_id), "an ok window is final").not.toContain("bw_retry_ok");
      // And the writer itself refuses to replace a final row.
      const { recordDiarizeWindow } = await import("@/lib/stt/diarize-window");
      await recordDiarizeWindow({ windowId: "bw_retry_ok", roomDayId: "rd_1", state: "failed", error: "late", speakers: null, segments: null, clipR2Key: null, timing: null });
      const still = (await sql`SELECT state, attempts FROM room_diarize_window WHERE window_id = 'bw_retry_ok'`) as Array<{ state: string; attempts: number }>;
      expect(still[0]).toEqual({ state: "ok", attempts: 2 });
    } finally {
      SVC.fail = false;
      delete process.env.ROOM_DIARIZE_ENABLED;
    }
  }, 300_000);
});

describe.skipIf(!HAVE_DOCKER)("0086 — room routing resolves to `route`, and `route` is not paid", () => {
  it("resolveRouting returns route for room/english AND room/indic against the REAL rows", async () => {
    const sql = G.__pgsql;
    // The engine registry and routing table, from their own migrations — not hand-written shapes.
    const strip = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");
    exec(strip("db/migrations/0018_stt_engine.sql"));
    exec(strip("db/migrations/0021_stt_routing.sql"));
    // The two room rows were created by the admin UI, not a migration (0062 says so). Seed them as
    // they stood before 0084, then apply 0084 and 0086 verbatim, in order.
    await sql`INSERT INTO stt_routing (stage, language_bucket, engine_id) VALUES ('room','english','sarvam'), ('room','indic','sarvam') ON CONFLICT DO NOTHING`;
    exec(strip("db/migrations/0084_stt_routing_room_to_route.sql"));

    const { resolveRouting } = await import("@/lib/stt/routing");
    // BEFORE 0086: the pointer says route, but there is no engine row, so it resolves to nothing.
    expect(await resolveRouting("room", "english"), "the bug 0086 fixes").toBeNull();

    exec(strip("db/migrations/0086_stt_engine_route.sql"));
    const english = await resolveRouting("room", "english");
    const indic = await resolveRouting("room", "indic");
    expect(english, "room/english must resolve to the engine the registry can run").toBe("route");
    expect(indic, "room/indic too").toBe("route");

    // NOT PAID — asserted on is_paid, never on cost_per_min_usd (NULL for every paid engine).
    const { paidEngineInfo } = await import("@/lib/stt/paid-engines");
    const info = await paidEngineInfo(english!);
    expect(info.paid, "the resolved room engine must not bill").toBe(false);
    const row = (await sql`SELECT is_paid, enabled, fanout_enabled, adapter_key FROM stt_engine WHERE id = 'route'`) as Array<{ is_paid: boolean; enabled: boolean; fanout_enabled: boolean; adapter_key: string }>;
    expect(row[0]!.is_paid).toBe(false);
    expect(row[0]!.enabled).toBe(true);
    // Not quietly added to live encounter fan-out, which now runs free engines by default.
    expect(row[0]!.fanout_enabled).toBe(false);
  }, 300_000);

  it("the row's key and capabilities are what the REGISTRY resolves, not a lookalike", async () => {
    const sql = G.__pgsql;
    const { adapterFor } = await import("@/lib/stt/registry");
    const row = (await sql`SELECT id, adapter_key, capabilities_json FROM stt_engine WHERE id = 'route'`) as Array<{ id: string; adapter_key: string; capabilities_json: Record<string, unknown> }>;
    const byId = adapterFor(row[0]!.id);
    const byAdapterKey = adapterFor(row[0]!.adapter_key);
    expect(byId, "resolveRouting's adapterFor(id) must find a real adapter").not.toBeNull();
    expect(byAdapterKey, "fan-out's adapterFor(adapter_key) must find the same one").toBe(byId);
    expect(byId!.key).toBe(row[0]!.id);
    // The table and the code declare the same engine — a drift here is a registry lying about itself.
    expect(row[0]!.capabilities_json).toEqual(byId!.capabilities);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// CURATED VOICEPRINT LOAD — the route, against real Postgres. SYNTHETIC identities only: this repo
// is public, and a test file is repo content.
// ---------------------------------------------------------------------------

/** A deterministic, finite, 192-float32 vector as base64 — never a real voice. */
const synthVec = (seed: number, dims = 192) => {
  const v = new Float32Array(dims);
  // Amplitude 20 puts the norm near 200, the scale of real unnormalised ECAPA centroids — above
  // MIN_CENTROID_L2 the way a real voice is.
  for (let i = 0; i < dims; i += 1) v[i] = Math.cos(seed * 0.37 + i * 0.05) * 20;
  return Buffer.from(v.buffer).toString("base64");
};

function voiceprintSchema(): void {
  const m0017 = readFileSync("db/migrations/0017_voice_sample.sql", "utf8");
  const vs = m0017.slice(m0017.indexOf("CREATE TABLE IF NOT EXISTS voice_sample"), m0017.indexOf(");", m0017.indexOf("CREATE TABLE IF NOT EXISTS voice_sample")) + 2);
  exec(`
    CREATE EXTENSION IF NOT EXISTS citext;
    DO $$ BEGIN CREATE TYPE clinician_type AS ENUM ('physician','dietitian','physiotherapist'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE TYPE doctor_status AS ENUM ('active','disabled','locked'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE TABLE IF NOT EXISTS admin_user (id uuid PRIMARY KEY);
    DROP TABLE IF EXISTS voice_print; DROP TABLE IF EXISTS clinician CASCADE;
    CREATE TABLE clinician (
      id TEXT PRIMARY KEY, legacy_doctor_id TEXT UNIQUE, clinician_type clinician_type NOT NULL DEFAULT 'physician',
      full_name TEXT NOT NULL, email CITEXT NOT NULL UNIQUE, phone TEXT, url_slug TEXT NOT NULL UNIQUE,
      url_token TEXT NOT NULL, pin_hash TEXT, pin_plaintext TEXT, pin_set_at TIMESTAMPTZ,
      status doctor_status NOT NULL DEFAULT 'active', created_by UUID REFERENCES admin_user(id),
      specialty TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE voice_print (
      doctor_id TEXT PRIMARY KEY REFERENCES clinician(id) ON DELETE CASCADE, centroid BYTEA NOT NULL,
      sample_count INT NOT NULL DEFAULT 0, samples_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_sample_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      match_confidence_30d_avg FLOAT, needs_reenrollment BOOLEAN NOT NULL DEFAULT FALSE);
    ${vs}
    CREATE TABLE IF NOT EXISTS audit_log (actor_type text, actor_id text, action text, target_type text, target_id text, metadata_json jsonb, at timestamptz default now());
    INSERT INTO clinician (id, full_name, email, url_slug, url_token) VALUES
      ('doc_testexa1', 'Existing Test One', 'existing.one@example.test', 'dr-existing-test-one-aaaa', 'aaaa'),
      ('doc_testexa2', 'Existing Test Two', 'existing.two@example.test', 'dr-existing-test-two-bbbb', 'bbbb');
  `);
}

async function postLoad(body: unknown, auth: string | null = process.env.MIGRATION_SECRET ?? null) {
  const { POST } = await import("@/app/api/admin/voiceprints/load/route");
  const { NextRequest } = await import("next/server");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${auth}`;
  const res = await POST(new NextRequest("https://x.test/api/admin/voiceprints/load", { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const FIVE = () => ({
  entries: [
    { clinician_id: "doc_testexa1", centroid_base64: synthVec(1), provenance: { source_file: "synthetic-a.json" } },
    { clinician_id: "doc_testexa2", centroid_base64: synthVec(2), provenance: { source_file: "synthetic-b.json", centroid_id: "synth-b", enroll_seconds: 121.44, probe_only: true } },
    { full_name: "New Test Three", email: "new.three@example.test", specialty: "ENT", centroid_base64: synthVec(3), provenance: { source_file: "synthetic-c.json" } },
    { full_name: "New Test Four", email: "new.four@example.test", centroid_base64: synthVec(4), provenance: { source_file: "synthetic-d.json" } },
    { full_name: "New Test Five", email: "new.five@example.test", specialty: "UROLOGY", centroid_base64: synthVec(5), provenance: { source_file: "synthetic-e.json" } },
  ],
});

describe.skipIf(!HAVE_DOCKER)("curated voiceprint load — POST /api/admin/voiceprints/load, real postgres", () => {
  beforeAll(() => { if (HAVE_DOCKER) voiceprintSchema(); process.env.MIGRATION_SECRET = process.env.MIGRATION_SECRET || "test-secret"; }, 120_000);

  it("refuses an unauthenticated call, and a wrong secret, and writes nothing", async () => {
    const sql = G.__pgsql;
    expect((await postLoad(FIVE(), null)).status).toBe(401);
    expect((await postLoad(FIVE(), "not-the-secret")).status).toBe(401);
    const n = (await sql`SELECT count(*)::int AS n FROM voice_print`) as Array<{ n: number }>;
    expect(n[0]!.n).toBe(0);
  }, 120_000);

  it("refuses 191- and 193-float payloads, and a one-bad-entry batch writes NOTHING", async () => {
    const sql = G.__pgsql;
    for (const dims of [191, 193]) {
      const bad = FIVE();
      bad.entries[3]!.centroid_base64 = synthVec(9, dims);
      const r = await postLoad(bad);
      expect(r.status, `${dims} floats must be refused`).toBe(400);
      expect(JSON.stringify(r.body)).toContain(`centroid_dim_${dims}_not_192`);
      expect(JSON.stringify(r.body), "a refusal never echoes the vector").not.toContain(synthVec(9, dims).slice(0, 40));
    }
    const vp = (await sql`SELECT count(*)::int AS n FROM voice_print`) as Array<{ n: number }>;
    const cl = (await sql`SELECT count(*)::int AS n FROM clinician`) as Array<{ n: number }>;
    expect(vp[0]!.n, "all-or-nothing: the four good entries were not written either").toBe(0);
    expect(cl[0]!.n, "and no clinician was minted").toBe(2);
  }, 120_000);

  it("loads five, mints three clinicians with the app's functions, and every centroid ROUND-TRIPS from the database", async () => {
    const sql = G.__pgsql;
    const r = await postLoad(FIVE());
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const loaded = r.body.loaded as Array<{ clinician_id: string; clinician: string; sample: string; dim: number; roundtrip: boolean }>;
    expect(loaded).toHaveLength(5);
    expect(loaded.filter((x) => x.clinician === "created")).toHaveLength(3);

    const created = (await sql`SELECT id, url_slug, url_token, specialty, pin_hash IS NOT NULL AS has_pin FROM clinician WHERE email LIKE 'new.%'`) as Array<{ id: string; url_slug: string; url_token: string; specialty: string | null; has_pin: boolean }>;
    for (const c of created) {
      // THE APP'S OWN FORMAT, from its own minter: doc_ + 8 of the unambiguous alphabet.
      expect(c.id).toMatch(/^doc_[abcdefghjkmnpqrstuvwxyz23456789]{8}$/);
      expect(c.url_slug.endsWith(`-${c.url_token}`), "slug from buildDoctorSlug").toBe(true);
      expect(c.has_pin).toBe(true);
    }
    expect(created.map((c) => c.specialty).sort()).toEqual([null, "ENT", "UROLOGY"].sort());

    const body = FIVE();
    for (const [i, x] of loaded.entries()) {
      const stored = (await sql`SELECT encode(centroid, 'base64') AS c FROM voice_print WHERE doctor_id = ${x.clinician_id}`) as Array<{ c: string }>;
      const back = stored[0]!.c.replace(/\s+/g, "");
      expect(back, `entry ${i} must be byte-identical to what was sent`).toBe(body.entries[i]!.centroid_base64);
      expect(Buffer.from(back, "base64").length / 4).toBe(192);
    }
    // PROVENANCE on the sample, and no vector in any audit row.
    const probe = (await sql`SELECT session_id, duration_ms FROM voice_sample WHERE clinician_id = 'doc_testexa2'`) as Array<{ session_id: string; duration_ms: number }>;
    expect(probe[0]!.session_id).toBe("curated:synth-b:probe_only");
    expect(probe[0]!.duration_ms).toBe(121440);
    const audits = (await sql`SELECT metadata_json::text AS m FROM audit_log WHERE actor_id = 'voiceprint_load'`) as Array<{ m: string }>;
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) expect(a.m, "an audit row must never carry a vector").not.toMatch(/[A-Za-z0-9+/]{40,}/);
  }, 180_000);

  it("IDEMPOTENT: the same body again duplicates no clinician, no sample and no voiceprint", async () => {
    const sql = G.__pgsql;
    const before = (await sql`SELECT (SELECT count(*) FROM clinician)::int AS c, (SELECT count(*) FROM voice_sample)::int AS s, (SELECT count(*) FROM voice_print)::int AS v`) as Array<{ c: number; s: number; v: number }>;
    const r = await postLoad(FIVE());
    expect(r.status).toBe(200);
    const loaded = r.body.loaded as Array<{ clinician: string; sample: string }>;
    expect(loaded.every((x) => x.clinician === "existing"), "a re-run reuses, never re-mints").toBe(true);
    expect(loaded.every((x) => x.sample === "already_present")).toBe(true);
    const after = (await sql`SELECT (SELECT count(*) FROM clinician)::int AS c, (SELECT count(*) FROM voice_sample)::int AS s, (SELECT count(*) FROM voice_print)::int AS v`) as Array<{ c: number; s: number; v: number }>;
    expect(after[0]).toEqual(before[0]);
    expect(after[0]!.v).toBe(5);
  }, 180_000);

  it("NOT A BACKDOOR: an existing email under a DIFFERENT name is rejected, and nothing is written", async () => {
    const sql = G.__pgsql;
    const r = await postLoad({ entries: [
      { full_name: "Someone Else Entirely", email: "existing.one@example.test", centroid_base64: synthVec(11), provenance: { source_file: "x.json" } },
    ] });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("email_exists_with_a_different_name");
    const s = (await sql`SELECT count(*)::int AS n FROM voice_sample WHERE clinician_id = 'doc_testexa1'`) as Array<{ n: number }>;
    expect(s[0]!.n, "the existing clinician's voiceprint was not touched").toBe(1);
  }, 120_000);

  it("refuses to AVERAGE: a second, different centroid for a clinician who already has one is refused", async () => {
    const r = await postLoad({ entries: [
      { clinician_id: "doc_testexa1", centroid_base64: synthVec(42), provenance: { source_file: "second-mic.json" } },
    ] });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("clinician_has_other_samples_loading_would_average");
  }, 120_000);

  it("NORM: an ALL-ZERO vector — 192 finite floats, no direction — is refused, and mints no clinician", async () => {
    const sql = G.__pgsql;
    const zero = Buffer.alloc(768).toString("base64");
    const r = await postLoad({ entries: [{ full_name: "Zero Vector Person", email: "zero@example.test", centroid_base64: zero, provenance: { source_file: "z.json" } }] });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("centroid_norm_below_floor");
    const c = (await sql`SELECT count(*)::int AS n FROM clinician WHERE email = 'zero@example.test'`) as Array<{ n: number }>;
    expect(c[0]!.n).toBe(0);
  }, 120_000);

  it("CONCURRENT, same new doctor, same vector: two calls at once give ONE clinician, ONE voiceprint, ONE sample, and no 500", async () => {
    const sql = G.__pgsql;
    const body = { entries: [{ full_name: "Race Same", email: "race.same@example.test", centroid_base64: synthVec(31), provenance: { source_file: "race.json" } }] };
    const [a, b] = await Promise.all([postLoad(body), postLoad(body)]);
    expect([a.status, b.status], JSON.stringify([a.body, b.body]).slice(0, 300)).toEqual([200, 200]);
    const ids = (await sql`SELECT id FROM clinician WHERE email = 'race.same@example.test'`) as Array<{ id: string }>;
    expect(ids).toHaveLength(1);
    const vp = (await sql`SELECT count(*)::int AS n FROM voice_print WHERE doctor_id = ${ids[0]!.id}`) as Array<{ n: number }>;
    const vs = (await sql`SELECT count(*)::int AS n FROM voice_sample WHERE clinician_id = ${ids[0]!.id}`) as Array<{ n: number }>;
    expect([vp[0]!.n, vs[0]!.n]).toEqual([1, 1]);
    const creates = (await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'doctor.create' AND target_id = ${ids[0]!.id}`) as Array<{ n: number }>;
    expect(creates[0]!.n, "one creation, one doctor.create audit row").toBe(1);
  }, 180_000);

  // The Neon HTTP driver autocommits every statement, so ANY interleaving of two loads' statements
  // is possible in production. These force the worst one — both validate, then both write — rather
  // than hoping the scheduler produces it.
  it("FORCED INTERLEAVE, same new doctor: both validate as 'create', both write — ONE clinician", async () => {
    const sql = G.__pgsql;
    const { resolveEntries, writeEntries } = await import("@/lib/voiceprint-load");
    const entry = { full_name: "Interleave New", email: "inter.new@example.test", centroid_base64: synthVec(41), provenance: { source_file: "i.json" } };
    const A = await resolveEntries([entry]);
    const B = await resolveEntries([entry]);
    if (!A.ok || !B.ok) throw new Error("both must validate");
    expect(A.resolved[0]!.create && B.resolved[0]!.create, "both saw no clinician").toBeTruthy();
    const wa = await writeEntries(A.resolved);
    const wb = await writeEntries(B.resolved);
    expect(wa[0]!.clinician).toBe("created");
    expect(wb[0]!.clinician, "the second write reuses the row the first created").toBe("existing");
    expect(wb[0]!.clinician_id).toBe(wa[0]!.clinician_id);
    expect(wb[0]!.sample).toBe("already_present");
    const n = (await sql`SELECT (SELECT count(*) FROM clinician WHERE email = 'inter.new@example.test')::int AS c,
                                (SELECT count(*) FROM voice_print WHERE doctor_id = ${wa[0]!.clinician_id})::int AS v,
                                (SELECT count(*) FROM voice_sample WHERE clinician_id = ${wa[0]!.clinician_id})::int AS s`) as Array<{ c: number; v: number; s: number }>;
    expect(n[0]).toEqual({ c: 1, v: 1, s: 1 });
  }, 180_000);

  it("FORCED INTERLEAVE, one doctor, DIFFERENT vectors: the second is REFUSED and the stored centroid is the first, never an average", async () => {
    const sql = G.__pgsql;
    const { resolveEntries, writeEntries, WriteRefusal } = await import("@/lib/voiceprint-load");
    await sql`INSERT INTO clinician (id, full_name, email, url_slug, url_token) VALUES ('doc_testexa3', 'Existing Test Three', 'existing.three@example.test', 'dr-existing-test-three-cccc', 'cccc')`;
    const A = await resolveEntries([{ clinician_id: "doc_testexa3", centroid_base64: synthVec(51), provenance: { source_file: "a.json" } }]);
    const B = await resolveEntries([{ clinician_id: "doc_testexa3", centroid_base64: synthVec(52), provenance: { source_file: "b.json" } }]);
    if (!A.ok || !B.ok) throw new Error("both must validate — neither sees the other's sample yet");
    await writeEntries(A.resolved);
    let refused: unknown = null;
    try { await writeEntries(B.resolved); } catch (e) { refused = e; }
    expect(refused).toBeInstanceOf(WriteRefusal);
    expect((refused as InstanceType<typeof WriteRefusal>).reason).toBe("clinician_already_has_a_different_voiceprint_or_samples");
    const vp = (await sql`SELECT encode(centroid, 'base64') AS c, sample_count FROM voice_print WHERE doctor_id = 'doc_testexa3'`) as Array<{ c: string; sample_count: number }>;
    expect(vp[0]!.c.replace(/\s+/g, ""), "the first vector, byte for byte — not the mean of both").toBe(synthVec(51));
    expect(vp[0]!.sample_count).toBe(1);
    const vs = (await sql`SELECT count(*)::int AS n FROM voice_sample WHERE clinician_id = 'doc_testexa3'`) as Array<{ n: number }>;
    expect(vs[0]!.n, "the refused write left no sample to be averaged in later").toBe(1);
    // A re-run of the winner is still a clean no-op — the endpoint is not wedged by the race.
    const again = await postLoad({ entries: [{ clinician_id: "doc_testexa3", centroid_base64: synthVec(51), provenance: { source_file: "a.json" } }] });
    expect(again.status).toBe(200);
    expect((again.body.loaded as Array<{ sample: string }>)[0]!.sample).toBe("already_present");
  }, 180_000);

  it("FORCED INTERLEAVE, one email, two NAMES: the second is refused at write and nothing of it lands", async () => {
    const sql = G.__pgsql;
    const { resolveEntries, writeEntries, WriteRefusal } = await import("@/lib/voiceprint-load");
    const A = await resolveEntries([{ full_name: "Name One", email: "two.names@example.test", centroid_base64: synthVec(61), provenance: { source_file: "a.json" } }]);
    const B = await resolveEntries([{ full_name: "Name Two", email: "two.names@example.test", centroid_base64: synthVec(62), provenance: { source_file: "b.json" } }]);
    if (!A.ok || !B.ok) throw new Error("both must validate");
    await writeEntries(A.resolved);
    await expect(writeEntries(B.resolved)).rejects.toBeInstanceOf(WriteRefusal);
    const rows = (await sql`SELECT full_name FROM clinician WHERE email = 'two.names@example.test'`) as Array<{ full_name: string }>;
    expect(rows.map((r) => r.full_name)).toEqual(["Name One"]);
  }, 180_000);

  it("CONCURRENT through the route, one doctor, DIFFERENT vectors: exactly one 200, one non-2xx, ONE voiceprint equal to the winner", async () => {
    const sql = G.__pgsql;
    await sql`INSERT INTO clinician (id, full_name, email, url_slug, url_token) VALUES ('doc_testexa4', 'Existing Test Four', 'existing.four@example.test', 'dr-existing-test-four-dddd', 'dddd')`;
    const one = (v: number) => ({ entries: [{ clinician_id: "doc_testexa4", centroid_base64: synthVec(v), provenance: { source_file: `v${v}.json` } }] });
    const [a, b] = await Promise.all([postLoad(one(71)), postLoad(one(72))]);
    expect([a.status, b.status].filter((x) => x === 200), JSON.stringify([a.body, b.body]).slice(0, 300)).toHaveLength(1);
    expect([a.status, b.status].filter((x) => x === 400)).toHaveLength(1);
    const winner = a.status === 200 ? synthVec(71) : synthVec(72);
    const vp = (await sql`SELECT encode(centroid, 'base64') AS c, sample_count FROM voice_print WHERE doctor_id = 'doc_testexa4'`) as Array<{ c: string; sample_count: number }>;
    expect(vp).toHaveLength(1);
    expect(vp[0]!.c.replace(/\s+/g, "")).toBe(winner);
    const vs = (await sql`SELECT count(*)::int AS n FROM voice_sample WHERE clinician_id = 'doc_testexa4'`) as Array<{ n: number }>;
    expect(vs[0]!.n).toBe(1);
  }, 180_000);

  // TRUE PARALLEL SESSIONS. The harness runs one statement at a time, so the tests above interleave
  // BETWEEN statements — the Neon autocommit model — but never inside one. This runs the app's OWN
  // write statements (captured verbatim as the loader sent them) in two psql sessions at once, with
  // session A holding its transaction open, so B's statement genuinely meets A's uncommitted row.
  it("TRUE PARALLEL: two sessions, one clinician — B waits on A's row lock, then gets ONE clinician and loses the voiceprint to A", async () => {
    const sql = G.__pgsql;
    const { writeEntries, resolveEntries } = await import("@/lib/voiceprint-load");
    const { createHash } = await import("node:crypto");
    const { spawn } = await import("node:child_process");
    const sid = (c: string, b: string) => `vs_curated_${createHash("sha256").update(`${c}:${b}`).digest("hex").slice(0, 24)}`;
    const psql = (text: string) => new Promise<{ out: string; ms: number }>((resolve, reject) => {
      const t0 = Date.now();
      const p = spawn("docker", ["exec", "-i", PG_NAME, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"]);
      let out = "", err = "";
      p.stdout.on("data", (d) => { out += String(d); });
      p.stderr.on("data", (d) => { err += String(d); });
      p.on("close", (code) => (code === 0 ? resolve({ out, ms: Date.now() - t0 }) : reject(new Error(err))));
      p.stdin.end(text);
    });

    // 1. Capture the two statements for a TEMPLATE doctor, then derive A's and B's from them.
    const tplVec = synthVec(90);
    const pre = QUERIES.length;
    const r = await resolveEntries([{ full_name: "Template Person", email: "tpl@example.test", centroid_base64: tplVec, provenance: { source_file: "tpl.json" } }]);
    if (!r.ok) throw new Error("template must validate");
    const w = await writeEntries(r.resolved);
    const tplId = w[0]!.clinician_id;
    const captured = QUERIES.slice(pre);
    const cStmt = captured.find((q) => q.includes("INSERT INTO clinician"))!;
    const vStmt = captured.find((q) => q.includes("INSERT INTO voice_print"))!;
    expect(cStmt && vStmt, "both write statements were captured").toBeTruthy();
    const tplSlug = /'(dr-template-person-[a-z2-9]{4})'/.exec(cStmt)![1]!;

    const forA = { id: "doc_parallla", email: "par@example.test", slug: "dr-par-aaaa", vec: synthVec(91) };
    const forB = { id: "doc_parallbb", email: "par@example.test", slug: "dr-par-bbbb", vec: synthVec(92) };
    const clinicianSql = (x: typeof forA) => cStmt.split(tplId).join(x.id).split("tpl@example.test").join(x.email).split(tplSlug).join(x.slug);
    const printSql = (x: typeof forA, doctor: string) =>
      vStmt.split(sid(tplId, tplVec)).join(sid(doctor, x.vec)).split(tplVec).join(x.vec).split(tplId).join(doctor);

    // 2. Clinician: A inserts and HOLDS; B's upsert on the same email must wait, then return A's row.
    const aC = psql(`BEGIN; ${clinicianSql(forA)}; SELECT pg_sleep(1.5); COMMIT;`);
    await new Promise((res) => setTimeout(res, 400));
    const bC = await psql(`${clinicianSql(forB)};`);
    await aC;
    expect(bC.ms, "B really overlapped A's open transaction and waited on its lock").toBeGreaterThan(700);
    expect(bC.out.trim(), "B got A's row back, inserted=false").toBe("doc_parallla|Template Person|f");
    const cl = (await sql`SELECT id FROM clinician WHERE email = 'par@example.test'`) as Array<{ id: string }>;
    expect(cl.map((x) => x.id), "ONE clinician").toEqual(["doc_parallla"]);

    // 3. Voiceprint, different vectors: A inserts and HOLDS; B must wait, then get NO row.
    const aV = psql(`BEGIN; ${printSql(forA, "doc_parallla")}; SELECT pg_sleep(1.5); COMMIT;`);
    await new Promise((res) => setTimeout(res, 400));
    const bV = await psql(`${printSql(forB, "doc_parallla")};`);
    await aV;
    expect(bV.ms).toBeGreaterThan(700);
    expect(bV.out.trim(), "B's statement returned no centroid and inserted no sample").toBe("|0");
    const vp = (await sql`SELECT encode(centroid, 'base64') AS c, sample_count FROM voice_print WHERE doctor_id = 'doc_parallla'`) as Array<{ c: string; sample_count: number }>;
    expect(vp).toHaveLength(1);
    expect(vp[0]!.c.replace(/\s+/g, ""), "A's vector exactly — never the average").toBe(forA.vec);
    expect(vp[0]!.sample_count).toBe(1);
    const vs = (await sql`SELECT count(*)::int AS n FROM voice_sample WHERE clinician_id = 'doc_parallla'`) as Array<{ n: number }>;
    expect(vs[0]!.n, "ONE voiceprint, ONE sample").toBe(1);
  }, 180_000);

  it("refuses a room — voiceprints are not room-scoped", async () => {
    const r = await postLoad({ entries: [
      { clinician_id: "doc_testexa1", centroid_base64: synthVec(1), room: "opd-3", provenance: { source_file: "a.json" } },
    ] });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("room_not_accepted");
  }, 120_000);
});

