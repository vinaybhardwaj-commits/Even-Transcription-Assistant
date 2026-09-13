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
import { makeFakeClinician } from "../support/fake-identity";
import { repoFiles, textOf } from "../support/repo-files";

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

/** The signed-in doctor and the Mini's /enroll answer, for the voice/identify route. */
const IDENTIFY = vi.hoisted(() => ({ claims: null as null | { doctor_id: string; slug: string }, emb: "", enrollCalls: 0 }));
vi.mock("@/lib/cookie", async (orig) => ({ ...(await orig<Record<string, unknown>>()), readDoctorCookie: async () => (IDENTIFY.claims ? "session" : null) }));
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<Record<string, unknown>>()), verifyDoctorJwt: async () => IDENTIFY.claims }));
vi.mock("@/lib/enroll", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  runEnroll: async () => { IDENTIFY.enrollCalls += 1; return { ok: true, embeddingBase64: IDENTIFY.emb }; },
}));
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
/** The clinician ids offered to /diarize on each call, in call order. */
const CENTROIDS_SENT: string[][] = [];
/** Flip to make the service fail, so the harness can prove it notices. */
const SVC = { fail: false };
vi.mock("@/lib/diarize", () => ({
  runDiarize: async (_a: unknown, _c: string, opts: { encounterId: string; clinicianCentroids?: Array<{ clinician_id: string }> }) => {
    DIARIZE_CALLS.push(opts.encounterId);
    CENTROIDS_SENT.push((opts.clinicianCentroids ?? []).map((c) => c.clinician_id));
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
    CREATE TABLE clinician (id text PRIMARY KEY, full_name text, status text NOT NULL DEFAULT 'active', deleted_at timestamptz);
  `);
  exec(m0082);
  exec(keep("room_turn_speaker"));
  exec(keep("room_diarize_window"));
  exec(m0085);
  // 0088 verbatim: attempts + failure_history, the bounded-retry columns.
  exec(readFileSync("db/migrations/0088_room_diarize_window_retry.sql", "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, ""));
  // 0089 verbatim: the emotion tables.
  exec(readFileSync("db/migrations/0089_room_emotion.sql", "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, ""));
  // 0090 verbatim: run ids, and the service's speaker guess nested.
  exec(readFileSync("db/migrations/0090_diarize_run_id_and_service_guess.sql", "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, ""));
}

/** A 900 s window whose turns leave a clean gap near every 120 s mark, plus one deliberate straddle. */
function seed(): void {
  exec(`
    INSERT INTO bench_window VALUES ('bw_e2e','sess_1','rd_1',0,${WINDOW_MS},'primary','clips/w.webm',true,'transcribed');
    -- The window is epoch 0..900000, so the chunk must cover THAT, not wall-clock now.
    INSERT INTO bench_chunk VALUES ('sess_1',0,'primary','chunks/a.webm','audio/webm', to_timestamp(0), to_timestamp(900), 'uploaded');
    INSERT INTO clinician (id, full_name) VALUES ('${makeFakeClinician(1).id}', '${makeFakeClinician(1).full_name}');
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

  it("P1 JOIN: the job stores the service's speaker guess NESTED and self-describing; 0090 rewrites a legacy row the same way", async () => {
    const sql = G.__pgsql;
    const stored = (await sql`SELECT speakers_json, last_run_id FROM room_diarize_window WHERE window_id = 'bw_cal'`) as Array<{ speakers_json: Array<Record<string, unknown>>; last_run_id: string | null }>;
    expect(stored[0]!.last_run_id, "the run that wrote the turns is recorded").toMatch(/^[0-9a-f-]{36}$/);
    const turnRuns = (await sql`SELECT DISTINCT run_id FROM room_turn_speaker WHERE window_id = 'bw_cal'`) as Array<{ run_id: string | null }>;
    for (const t of turnRuns) expect(t.run_id).toBe(stored[0]!.last_run_id);
    for (const sp of stored[0]!.speakers_json) {
      for (const k of ["type", "label", "source", "role_source"]) expect(sp, `top-level ${k}`).not.toHaveProperty(k);
      expect(sp.unverified_service_guess).toBeTruthy();
      expect(sp.embedding_base64, "the embedding stays where the calibration reader expects it").toBeTruthy();
    }
    // A join on the old key finds nothing to misread.
    const misread = (await sql`SELECT count(*)::int AS n FROM room_diarize_window d, jsonb_array_elements(d.speakers_json) sp WHERE sp->>'type' IS NOT NULL`) as Array<{ n: number }>;
    expect(misread[0]!.n).toBe(0);

    // A row written the OLD way, then 0090 applied (it is idempotent).
    await seedWindow("bw_legacy", "sess_legacy", 12 * WINDOW_MS);
    await sql`INSERT INTO room_diarize_window (window_id, room_day_id, state, speakers_json) VALUES ('bw_legacy', 'rd_1', 'ok', ${JSON.stringify([{ idx: 0, label: "Guess", type: "other", source: "heuristic", embedding_base64: "AAAA" }, { idx: 1, label: "Dr", type: "clinician", source: "auto", clinician_id: makeFakeClinician(1).id, confidence: 0.8 }])}::jsonb)`;
    exec(readFileSync("db/migrations/0090_diarize_run_id_and_service_guess.sql", "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, ""));
    const legacy = (await sql`SELECT speakers_json FROM room_diarize_window WHERE window_id = 'bw_legacy'`) as Array<{ speakers_json: Array<Record<string, unknown>> }>;
    expect(legacy[0]!.speakers_json[0]).toEqual({ idx: 0, embedding_base64: "AAAA", unverified_service_guess: { type: "other", label: "Guess", source: "heuristic", is: "the diarize service's own heuristic guess, not an attribution; a role comes only from a voiceprint match" } });
    expect(legacy[0]!.speakers_json[1]).toMatchObject({ idx: 1, clinician_id: makeFakeClinician(1).id, confidence: 0.8, unverified_service_guess: { type: "clinician", label: "Dr", source: "auto" } });
    await sql`DELETE FROM room_diarize_window WHERE window_id = 'bw_legacy'`;
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
      await recordDiarizeWindow({ windowId: "bw_retry_ok", roomDayId: "rd_1", state: "failed", error: "late", speakers: null, segments: null, clipR2Key: null, timing: null, runId: "run_late" });
      const still = (await sql`SELECT state, attempts FROM room_diarize_window WHERE window_id = 'bw_retry_ok'`) as Array<{ state: string; attempts: number }>;
      expect(still[0]).toEqual({ state: "ok", attempts: 2 });
    } finally {
      SVC.fail = false;
      delete process.env.ROOM_DIARIZE_ENABLED;
    }
  }, 300_000);
});

describe.skipIf(!HAVE_DOCKER)("C2 merge blocker 3 — only ACTIVE clinicians are offered to /diarize", () => {
  it("a DISABLED or DELETED clinician's centroid is not sent to /diarize; an active one is", async () => {
    const sql = G.__pgsql;
    await sql`INSERT INTO clinician (id, full_name, status, deleted_at) VALUES
      (${makeFakeClinician(201).id}, ${makeFakeClinician(201).full_name}, 'active', NULL),
      (${makeFakeClinician(202).id}, ${makeFakeClinician(202).full_name}, 'disabled', NULL),
      (${makeFakeClinician(203).id}, ${makeFakeClinician(203).full_name}, 'active', now())`;
    await sql`INSERT INTO voice_print VALUES ('doc_fake0201', decode(${emb(3)}, 'base64')), ('doc_fake0202', decode(${emb(4)}, 'base64')), ('doc_fake0203', decode(${emb(5)}, 'base64'))`;
    // A voiceprint with no clinician row at all — the old LEFT JOIN offered it under its bare id.
    await sql`INSERT INTO voice_print VALUES ('doc_fake0204', decode(${emb(6)}, 'base64'))`;

    const { loadClinicianCentroids } = await import("@/lib/stt/diarize-window");
    const ids = (await loadClinicianCentroids()).map((c) => c.clinician_id);
    expect(ids).toContain("doc_fake0201");
    expect(ids).not.toContain("doc_fake0202");
    expect(ids).not.toContain("doc_fake0203");
    expect(ids).not.toContain("doc_fake0204");

    // THROUGH THE JOB: what actually reaches the service.
    SVC.fail = false;
    await seedWindow("bw_active", "sess_active", 9 * WINDOW_MS, true);
    CENTROIDS_SENT.length = 0;
    const r = await runJob("job_active", "bw_active");
    expect(r.status, `error=${r.error}`).toBe("done");
    expect(CENTROIDS_SENT).toHaveLength(1);
    expect(CENTROIDS_SENT[0]).toContain("doc_fake0201");
    expect(CENTROIDS_SENT[0], "a disabled clinician's voice must not join room matching").not.toContain("doc_fake0202");
    expect(CENTROIDS_SENT[0], "nor a deleted one's").not.toContain("doc_fake0203");
    expect(CENTROIDS_SENT[0]).not.toContain("doc_fake0204");
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
// CURATED VOICEPRINT ENROL — the route, against real Postgres. SYNTHETIC identities only: this repo
// is public, and a test file is repo content. Every id here carries a 0 or 1, which the app's id
// alphabet never uses, so none can ever collide with a real clinician.
// ---------------------------------------------------------------------------

/** A deterministic, finite, 192-float32 vector as base64 — never a real voice. */
const synthVec = (seed: number, dims = 192) => {
  const v = new Float32Array(dims);
  // Amplitude 20 puts the norm near 200, the scale of real unnormalised ECAPA centroids — above
  // MIN_CENTROID_L2 the way a real voice is.
  for (let i = 0; i < dims; i += 1) v[i] = Math.cos(seed * 0.37 + i * 0.05) * 20;
  return Buffer.from(v.buffer).toString("base64");
};

const FAKE_ACTIVE = ["doc_fake0101", "doc_fake0102", "doc_fake0103", "doc_fake0104", "doc_fake0105"];

function voiceprintSchema(): void {
  const m0017 = readFileSync("db/migrations/0017_voice_sample.sql", "utf8");
  const vs = m0017.slice(m0017.indexOf("CREATE TABLE IF NOT EXISTS voice_sample"), m0017.indexOf(");", m0017.indexOf("CREATE TABLE IF NOT EXISTS voice_sample")) + 2);
  const row = (id: string, n: string, status = "active", deleted = "NULL") => {
    const c = makeFakeClinician(Number(n));
    return `('${c.id}', '${c.full_name}', '${c.email}', '${c.url_slug}', '${c.url_token}', '${status}', ${deleted})`;
  };
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
      deleted_at TIMESTAMPTZ, specialty TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE voice_print (
      doctor_id TEXT PRIMARY KEY REFERENCES clinician(id) ON DELETE CASCADE, centroid BYTEA NOT NULL,
      sample_count INT NOT NULL DEFAULT 0, samples_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_sample_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      match_confidence_30d_avg FLOAT, needs_reenrollment BOOLEAN NOT NULL DEFAULT FALSE);
    ${vs}
    CREATE TABLE IF NOT EXISTS audit_log (actor_type text, actor_id text, action text, target_type text, target_id text, metadata_json jsonb, at timestamptz default now());
    INSERT INTO clinician (id, full_name, email, url_slug, url_token, status, deleted_at) VALUES
      ${row("doc_fake0101", "0101")}, ${row("doc_fake0102", "0102")}, ${row("doc_fake0103", "0103")},
      ${row("doc_fake0104", "0104")}, ${row("doc_fake0105", "0105")},
      ${row("doc_fake0106", "0106", "disabled")}, ${row("doc_fake0107", "0107", "active", "now()")},
      ${row("doc_fake0108", "0108")}, ${row("doc_fake0109", "0109")}, ${row("doc_fake0110", "0110")}, ${row("doc_fake0111", "0111")};
  `);
}

async function postLoad(body: unknown, auth: string | null = process.env.MIGRATION_SECRET ?? null, raw?: string) {
  const { POST } = await import("@/app/api/admin/voiceprints/load/route");
  const { NextRequest } = await import("next/server");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${auth}`;
  const res = await POST(new NextRequest("https://x.test/api/admin/voiceprints/load", { method: "POST", headers, body: raw ?? JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const FIVE = () => ({
  entries: [
    { clinician_id: FAKE_ACTIVE[0]!, centroid_base64: synthVec(1), provenance: { source_file: "synthetic-a.json" } },
    { clinician_id: FAKE_ACTIVE[1]!, centroid_base64: synthVec(2), provenance: { source_file: "synthetic-b.json", centroid_id: "synth-b", enroll_seconds: 121.44, probe_only: true } },
    { clinician_id: FAKE_ACTIVE[2]!, centroid_base64: synthVec(3), provenance: { source_file: "synthetic-c.json" } },
    { clinician_id: FAKE_ACTIVE[3]!, centroid_base64: synthVec(4), provenance: { source_file: "synthetic-d.json" } },
    { clinician_id: FAKE_ACTIVE[4]!, centroid_base64: synthVec(5), provenance: { source_file: "synthetic-e.json" } },
  ],
});

const counts = async () => {
  const r = (await G.__pgsql`SELECT (SELECT count(*) FROM clinician)::int AS c, (SELECT count(*) FROM voice_print)::int AS v,
                                    (SELECT count(*) FROM voice_sample)::int AS s, (SELECT count(*) FROM audit_log)::int AS a`) as Array<{ c: number; v: number; s: number; a: number }>;
  return r[0]!;
};

describe.skipIf(!HAVE_DOCKER)("curated voiceprint enrol — POST /api/admin/voiceprints/load, real postgres", () => {
  beforeAll(() => { if (HAVE_DOCKER) voiceprintSchema(); process.env.MIGRATION_SECRET = process.env.MIGRATION_SECRET || "test-secret"; }, 120_000);

  it("refuses an unauthenticated call, and a wrong secret, and writes nothing", async () => {
    const before = await counts();
    expect((await postLoad(FIVE(), null)).status).toBe(401);
    expect((await postLoad(FIVE(), "not-the-secret")).status).toBe(401);
    expect(await counts()).toEqual(before);
  }, 120_000);

  it("MERGE BLOCKER 2: a well-formed request naming a NON-EXISTENT clinician is a 404 and creates NOTHING", async () => {
    const before = await counts();
    const r = await postLoad({ entries: [{ clinician_id: "doc_fake0999", centroid_base64: synthVec(9), provenance: { source_file: "x.json" } }] });
    expect(r.status).toBe(404);
    expect((r.body.error as { code: string }).code).toBe("NOT_FOUND");
    expect(JSON.stringify(r.body)).toContain("clinician_not_found");
    expect(await counts(), "no clinician, voiceprint, sample or audit row").toEqual(before);
  }, 120_000);

  it("MERGE BLOCKER 2: the old create-a-doctor shape is REFUSED as unknown fields — nothing is minted", async () => {
    const before = await counts();
    for (const entry of [
      { full_name: makeFakeClinician(900).full_name, email: makeFakeClinician(900).email, centroid_base64: synthVec(10), provenance: { source_file: "n.json" } },
      { clinician_id: FAKE_ACTIVE[0]!, full_name: makeFakeClinician(901).full_name, centroid_base64: synthVec(10), provenance: { source_file: "n.json" } },
      { clinician_id: FAKE_ACTIVE[0]!, email: makeFakeClinician(902).email, centroid_base64: synthVec(10), provenance: { source_file: "n.json" } },
      { clinician_id: FAKE_ACTIVE[0]!, specialty: "ENT", centroid_base64: synthVec(10), provenance: { source_file: "n.json" } },
    ]) {
      const r = await postLoad({ entries: [entry] });
      expect(r.status, JSON.stringify(Object.keys(entry))).toBe(400);
      expect(JSON.stringify(r.body)).toMatch(/unknown_field_(full_name|email|specialty)|clinician_id_required/);
    }
    expect(await counts()).toEqual(before);
    const c = (await G.__pgsql`SELECT count(*)::int AS n FROM clinician WHERE email = ${makeFakeClinician(900).email}`) as Array<{ n: number }>;
    expect(c[0]!.n).toBe(0);
  }, 120_000);

  it("MERGE BLOCKER 3: a DISABLED or DELETED clinician is 404 clinician_not_active, and gets no voiceprint", async () => {
    const before = await counts();
    for (const id of ["doc_fake0106", "doc_fake0107"]) {
      const r = await postLoad({ entries: [{ clinician_id: id, centroid_base64: synthVec(11), provenance: { source_file: "x.json" } }] });
      expect(r.status, id).toBe(404);
      expect(JSON.stringify(r.body)).toContain("clinician_not_active");
    }
    expect(await counts()).toEqual(before);
  }, 120_000);

  it("refuses 191- and 193-float payloads, and a one-bad-entry batch writes NOTHING", async () => {
    for (const dims of [191, 193]) {
      const bad = FIVE();
      bad.entries[3]!.centroid_base64 = synthVec(9, dims);
      const r = await postLoad(bad);
      expect(r.status, `${dims} floats must be refused`).toBe(400);
      expect(JSON.stringify(r.body)).toContain(`centroid_dim_${dims}_not_192`);
      expect(JSON.stringify(r.body), "a refusal never echoes the vector").not.toContain(synthVec(9, dims).slice(0, 40));
    }
    // A 404 alongside a 400 is a 400: the batch is refused either way, and the shape error is named.
    const mixed = FIVE();
    mixed.entries[0]!.clinician_id = "doc_fake0999";
    mixed.entries[1]!.centroid_base64 = synthVec(9, 191);
    expect((await postLoad(mixed)).status).toBe(400);
    const c = await counts();
    expect(c.v, "all-or-nothing: the good entries were not written either").toBe(0);
  }, 120_000);

  it("loads five EXISTING clinicians, creates no clinician, and every centroid ROUND-TRIPS from the database", async () => {
    const sql = G.__pgsql;
    const before = await counts();
    const r = await postLoad(FIVE());
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const loaded = r.body.loaded as Array<{ clinician_id: string; sample: string; dim: number; roundtrip: boolean }>;
    expect(loaded.map((x) => x.clinician_id)).toEqual(FAKE_ACTIVE);
    expect(loaded.every((x) => x.sample === "inserted" && x.dim === 192 && x.roundtrip)).toBe(true);
    const after = await counts();
    expect(after.c, "the endpoint never creates a clinician").toBe(before.c);
    expect(after.v - before.v).toBe(5);
    const body = FIVE();
    for (const [i, x] of loaded.entries()) {
      const stored = (await sql`SELECT encode(centroid, 'base64') AS c FROM voice_print WHERE doctor_id = ${x.clinician_id}`) as Array<{ c: string }>;
      expect(stored[0]!.c.replace(/\s+/g, ""), `entry ${i} must be byte-identical to what was sent`).toBe(body.entries[i]!.centroid_base64);
    }
    const probe = (await sql`SELECT session_id, duration_ms FROM voice_sample WHERE clinician_id = ${FAKE_ACTIVE[1]!}`) as Array<{ session_id: string; duration_ms: number }>;
    expect(probe[0]!.session_id).toBe("curated:synth-b:probe_only");
    expect(probe[0]!.duration_ms).toBe(121440);
    const audits = (await sql`SELECT action, metadata_json::text AS m FROM audit_log WHERE actor_id = 'voiceprint_load'`) as Array<{ action: string; m: string }>;
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.some((a) => a.action === "doctor.create"), "no doctor.create is ever written by this endpoint").toBe(false);
    for (const a of audits) expect(a.m, "an audit row must never carry a vector").not.toMatch(/[A-Za-z0-9+/]{40,}/);
  }, 180_000);

  it("IDEMPOTENT: the same body again duplicates no sample and no voiceprint", async () => {
    const before = await counts();
    const r = await postLoad(FIVE());
    expect(r.status).toBe(200);
    expect((r.body.loaded as Array<{ sample: string }>).every((x) => x.sample === "already_present")).toBe(true);
    const after = await counts();
    expect({ c: after.c, v: after.v, s: after.s }).toEqual({ c: before.c, v: before.v, s: before.s });
  }, 180_000);

  it("refuses to AVERAGE: a second, different centroid for a clinician who already has one is refused", async () => {
    const r = await postLoad({ entries: [{ clinician_id: FAKE_ACTIVE[0]!, centroid_base64: synthVec(42), provenance: { source_file: "second-mic.json" } }] });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("clinician_has_other_samples_loading_would_average");
  }, 120_000);

  it("NORM: an ALL-ZERO vector — 192 finite floats, no direction — is refused", async () => {
    const r = await postLoad({ entries: [{ clinician_id: "doc_fake0108", centroid_base64: Buffer.alloc(768).toString("base64"), provenance: { source_file: "z.json" } }] });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("centroid_norm_below_floor");
  }, 120_000);

  it("MERGE BLOCKER 4: wrong types are 400s with a named reason, never a 500", async () => {
    const good = () => ({ clinician_id: "doc_fake0108", centroid_base64: synthVec(12), provenance: { source_file: "t.json" } as Record<string, unknown> });
    const cases: Array<[unknown, string]> = [
      [{ ...good(), clinician_id: 12345 }, "clinician_id_must_be_a_string"],
      [{ ...good(), clinician_id: { $ne: null } }, "clinician_id_must_be_a_string"],
      [{ ...good(), clinician_id: ["doc_fake0108"] }, "clinician_id_must_be_a_string"],
      [{ ...good(), clinician_id: null }, "clinician_id_required"],
      [{ ...good(), clinician_id: "doc_fake0108' OR 1=1 --" }, "clinician_id_has_invalid_characters"],
      [{ ...good(), centroid_base64: 7 }, "centroid_base64_must_be_a_string"],
      [{ ...good(), centroid_base64: [1, 2, 3] }, "centroid_base64_must_be_a_string"],
      [{ ...good(), provenance: "t.json" }, "provenance_must_be_an_object"],
      [{ ...good(), provenance: null }, "provenance_required"],
      [{ ...good(), provenance: { source_file: 99 } }, "provenance.source_file_must_be_a_string"],
      [{ ...good(), provenance: { source_file: "t.json", centroid_id: 5 } }, "provenance.centroid_id_must_be_a_string"],
      [{ ...good(), provenance: { source_file: "t.json", enroll_seconds: "121" } }, "provenance.enroll_seconds_must_be_a_finite_number"],
      [{ ...good(), provenance: { source_file: "t.json", enroll_seconds: -1 } }, "provenance.enroll_seconds_must_be_in_(0,3600]"],
      [{ ...good(), provenance: { source_file: "t.json", probe_only: "yes" } }, "provenance.probe_only_must_be_a_boolean"],
      [{ ...good(), provenance: { source_file: "t.json", room: "opd-3" } }, "unknown_field_provenance.room"],
      [{ ...good(), room: "opd-3" }, "unknown_field_room"],
      ["a string entry", "entry_must_be_an_object"],
      [null, "entry_must_be_an_object"],
    ];
    const before = await counts();
    for (const [entry, reason] of cases) {
      const r = await postLoad({ entries: [entry] });
      expect(r.status, `${JSON.stringify(entry).slice(0, 80)} -> ${JSON.stringify(r.body).slice(0, 200)}`).toBe(400);
      expect(JSON.stringify(r.body)).toContain(reason);
    }
    // The body itself.
    for (const [raw, reason] of [["[]", "body_must_be_an_object"], ["null", "body_must_be_an_object"], ["{\"entries\":\"x\"}", "entries_required"], ["{\"entries\":[],\"x\":1}", "unknown_field_x"], ["not json", "body_not_json"]] as Array<[string, string]>) {
      const r = await postLoad(null, undefined, raw);
      expect(r.status, raw).toBe(400);
      expect(JSON.stringify(r.body)).toContain(reason);
    }
    expect(await counts()).toEqual(before);
  }, 180_000);

  it("MERGE BLOCKER 4: every string is capped — one over the cap is a 400 with a named reason, and nothing is stored", async () => {
    const { LIMITS } = await import("@/lib/voiceprint-load");
    const base = { clinician_id: "doc_fake0108", centroid_base64: synthVec(13), provenance: { source_file: "t.json" } };
    const cases: Array<[unknown, string]> = [
      [{ ...base, clinician_id: "d".repeat(LIMITS.clinician_id + 1) }, `clinician_id_length_must_be_1_to_${LIMITS.clinician_id}`],
      [{ ...base, clinician_id: "" }, `clinician_id_length_must_be_1_to_${LIMITS.clinician_id}`],
      [{ ...base, provenance: { source_file: "f".repeat(LIMITS.source_file + 1) } }, `provenance.source_file_length_must_be_1_to_${LIMITS.source_file}`],
      [{ ...base, provenance: { source_file: "   " } }, `provenance.source_file_length_must_be_1_to_${LIMITS.source_file}`],
      [{ ...base, provenance: { source_file: "t.json", centroid_id: "c".repeat(LIMITS.centroid_id + 1) } }, `provenance.centroid_id_length_must_be_1_to_${LIMITS.centroid_id}`],
      [{ ...base, provenance: { source_file: "t.json", enroll_seconds: LIMITS.enroll_seconds_max + 0.01 } }, `enroll_seconds_must_be_in_(0,${LIMITS.enroll_seconds_max}]`],
      [{ ...base, centroid_base64: "A".repeat(LIMITS.centroid_base64 + 4) }, `centroid_base64_longer_than_${LIMITS.centroid_base64}`],
    ];
    const before = await counts();
    for (const [entry, reason] of cases) {
      const r = await postLoad({ entries: [entry] });
      expect(r.status, reason).toBe(400);
      expect(JSON.stringify(r.body)).toContain(reason);
    }
    // Exactly AT the caps is accepted.
    const atCap = await postLoad({ entries: [{ ...base, provenance: { source_file: "f".repeat(LIMITS.source_file), centroid_id: "c".repeat(LIMITS.centroid_id), enroll_seconds: LIMITS.enroll_seconds_max } }] });
    expect(atCap.status, JSON.stringify(atCap.body).slice(0, 200)).toBe(200);
    // The body cap: a request past 256 KB is refused before it is parsed.
    const huge = JSON.stringify({ entries: [{ ...base, provenance: { source_file: "x".repeat(LIMITS.body_bytes) } }] });
    const r = await postLoad(null, undefined, huge);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain(`body_larger_than_${LIMITS.body_bytes}_bytes`);
    const after = await counts();
    expect(after.c).toBe(before.c);
  }, 180_000);

  it("CONCURRENT, same doctor, same vector: two calls at once give ONE voiceprint and ONE sample, and no 500", async () => {
    const sql = G.__pgsql;
    const body = { entries: [{ clinician_id: "doc_fake0109", centroid_base64: synthVec(31), provenance: { source_file: "race.json" } }] };
    const [a, b] = await Promise.all([postLoad(body), postLoad(body)]);
    expect([a.status, b.status], JSON.stringify([a.body, b.body]).slice(0, 300)).toEqual([200, 200]);
    const vp = (await sql`SELECT count(*)::int AS n FROM voice_print WHERE doctor_id = 'doc_fake0109'`) as Array<{ n: number }>;
    const vs = (await sql`SELECT count(*)::int AS n FROM voice_sample WHERE clinician_id = 'doc_fake0109'`) as Array<{ n: number }>;
    expect([vp[0]!.n, vs[0]!.n]).toEqual([1, 1]);
  }, 180_000);

  // The Neon HTTP driver autocommits every statement, so ANY interleaving of two loads' statements is
  // possible in production. This forces the worst one — both validate, then both write.
  it("FORCED INTERLEAVE, one doctor, DIFFERENT vectors: the second is REFUSED and the stored centroid is the first, never an average", async () => {
    const sql = G.__pgsql;
    const { resolveEntries, writeEntries, WriteRefusal } = await import("@/lib/voiceprint-load");
    const A = await resolveEntries([{ clinician_id: "doc_fake0110", centroid_base64: synthVec(51), provenance: { source_file: "a.json" } }]);
    const B = await resolveEntries([{ clinician_id: "doc_fake0110", centroid_base64: synthVec(52), provenance: { source_file: "b.json" } }]);
    if (!A.ok || !B.ok) throw new Error("both must validate — neither sees the other's sample yet");
    await writeEntries(A.resolved);
    let refused: unknown = null;
    try { await writeEntries(B.resolved); } catch (e) { refused = e; }
    expect(refused).toBeInstanceOf(WriteRefusal);
    expect((refused as InstanceType<typeof WriteRefusal>).reason).toBe("clinician_already_has_a_different_voiceprint_or_samples");
    const vp = (await sql`SELECT encode(centroid, 'base64') AS c, sample_count FROM voice_print WHERE doctor_id = 'doc_fake0110'`) as Array<{ c: string; sample_count: number }>;
    expect(vp[0]!.c.replace(/\s+/g, ""), "the first vector, byte for byte — not the mean of both").toBe(synthVec(51));
    expect(vp[0]!.sample_count).toBe(1);
    const vs = (await sql`SELECT count(*)::int AS n FROM voice_sample WHERE clinician_id = 'doc_fake0110'`) as Array<{ n: number }>;
    expect(vs[0]!.n, "the refused write left no sample to be averaged in later").toBe(1);
    const again = await postLoad({ entries: [{ clinician_id: "doc_fake0110", centroid_base64: synthVec(51), provenance: { source_file: "a.json" } }] });
    expect(again.status).toBe(200);
    expect((again.body.loaded as Array<{ sample: string }>)[0]!.sample).toBe("already_present");
  }, 180_000);

  // TRUE PARALLEL SESSIONS. The harness runs one statement at a time, so the tests above interleave
  // BETWEEN statements — the Neon autocommit model — but never inside one. This runs the app's OWN
  // voiceprint statement (captured verbatim as the loader sent it) in two psql sessions at once, with
  // session A holding its transaction open, so B's statement genuinely meets A's uncommitted row.
  it("TRUE PARALLEL: two sessions, one clinician, different vectors — B waits on A's row lock, then loses; ONE voiceprint, ONE sample", async () => {
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

    // 1. Capture the statement for a TEMPLATE clinician, then derive A's and B's from it.
    const tplId = "doc_fake0108", tplVec = synthVec(90);
    await sql`DELETE FROM voice_sample WHERE clinician_id = ${tplId}`;
    await sql`DELETE FROM voice_print WHERE doctor_id = ${tplId}`;
    const pre = QUERIES.length;
    const r = await resolveEntries([{ clinician_id: tplId, centroid_base64: tplVec, provenance: { source_file: "tpl.json" } }]);
    if (!r.ok) throw new Error(`template must validate: ${JSON.stringify(r.refusals)}`);
    await writeEntries(r.resolved);
    const vStmt = QUERIES.slice(pre).find((q) => q.includes("INSERT INTO voice_print"))!;
    expect(vStmt, "the write statement was captured").toBeTruthy();

    const target = "doc_fake0111";
    const printSql = (vec: string) => vStmt.split(sid(tplId, tplVec)).join(sid(target, vec)).split(tplVec).join(vec).split(tplId).join(target);
    const vecA = synthVec(91), vecB = synthVec(92);

    // 2. A inserts and HOLDS; B must wait on A's row, then get NO row back.
    const aV = psql(`BEGIN; ${printSql(vecA)}; SELECT pg_sleep(1.5); COMMIT;`);
    await new Promise((res) => setTimeout(res, 400));
    const bV = await psql(`${printSql(vecB)};`);
    await aV;
    expect(bV.ms, "B really overlapped A's open transaction and waited on its lock").toBeGreaterThan(700);
    expect(bV.out.trim(), "B's statement returned no centroid, inserted no sample, and wrote no audit row").toBe("|0|0");
    const vp = (await sql`SELECT encode(centroid, 'base64') AS c, sample_count FROM voice_print WHERE doctor_id = ${target}`) as Array<{ c: string; sample_count: number }>;
    expect(vp).toHaveLength(1);
    expect(vp[0]!.c.replace(/\s+/g, ""), "A's vector exactly — never the average").toBe(vecA);
    expect(vp[0]!.sample_count).toBe(1);
    const vs = (await sql`SELECT count(*)::int AS n FROM voice_sample WHERE clinician_id = ${target}`) as Array<{ n: number }>;
    expect(vs[0]!.n, "ONE voiceprint, ONE sample").toBe(1);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// C2 MERGE GATE — control characters, the audit gap, and every voiceprint reader
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_DOCKER)("C2 merge gate 1 — no string the database cannot store, and no voiceprint without its audit row", () => {
  const entry = (over: Record<string, unknown> = {}, prov: Record<string, unknown> = {}) =>
    ({ clinician_id: "doc_fake0108", centroid_base64: synthVec(14), provenance: { source_file: "t.json", ...prov }, ...over });

  it("a NUL, any control character, or a lone surrogate in source_file or centroid_id is a 400 with a named reason — and writes NOTHING", async () => {
    await G.__pgsql`DELETE FROM voice_sample WHERE clinician_id = 'doc_fake0108'`;
    await G.__pgsql`DELETE FROM voice_print WHERE doctor_id = 'doc_fake0108'`;
    const before = await counts();
    const cases: Array<[Record<string, unknown>, string]> = [];
    for (const field of ["source_file", "centroid_id"]) {
      for (const [bad, reason] of [
        ["a\u0000b", "control_character"], ["\u0001", "control_character"], ["tab\there", "control_character"],
        ["new\nline", "control_character"], ["\u001f", "control_character"], ["del\u007f", "control_character"],
        ["c1\u0085", "control_character"], ["c1\u009f", "control_character"],
        ["hi\ud800", "lone_surrogate"], ["\udc00lo", "lone_surrogate"], ["\udc00\ud800", "lone_surrogate"], ["x\udbffy", "lone_surrogate"],
      ] as Array<[string, string]>) {
        cases.push([{ [field]: bad }, `provenance.${field}_contains_a_${reason}`]);
      }
    }
    for (const [prov, reason] of cases) {
      const r = await postLoad({ entries: [entry({}, prov)] });
      expect(r.status, `${JSON.stringify(prov)} -> ${JSON.stringify(r.body).slice(0, 160)}`).toBe(400);
      expect(JSON.stringify(r.body)).toContain(reason);
    }
    // A control character in an unknown FIELD NAME is not echoed back.
    const r = await postLoad({ entries: [{ ...entry(), ["x\u0000y"]: 1 }] });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("unknown_field_(unprintable)");
    expect(await counts(), "no voiceprint, sample or audit row").toEqual(before);
    // A valid non-ASCII name is not a control character: it is accepted, and audited.
    const ok = await postLoad({ entries: [entry({}, { source_file: "enrol-\u00e9t\u00e9-\ud83c\udf99.json" })] });
    expect(ok.status, JSON.stringify(ok.body).slice(0, 200)).toBe(200);
  }, 180_000);

  it("ATOMIC: when the AUDIT row is refused by the database, NO voiceprint and NO sample land", async () => {
    const sql = G.__pgsql;
    const target = "doc_fake0109";
    await sql`DELETE FROM voice_sample WHERE clinician_id = ${target}`;
    await sql`DELETE FROM voice_print WHERE doctor_id = ${target}`;
    const auditBefore = (await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'voiceprint.load' AND target_id = ${target}`) as Array<{ n: number }>;
    // NOT VALID: earlier tests' audit rows stay; every NEW voiceprint.load row is refused.
    exec(`ALTER TABLE audit_log ADD CONSTRAINT t_refuse_audit CHECK (action <> 'voiceprint.load') NOT VALID;`);
    try {
      const r = await postLoad({ entries: [{ clinician_id: target, centroid_base64: synthVec(15), provenance: { source_file: "a.json" } }] });
      expect(r.status, "a refused audit write is a failure, never success-shaped").toBe(500);
      const vp = (await sql`SELECT count(*)::int AS n FROM voice_print WHERE doctor_id = ${target}`) as Array<{ n: number }>;
      const vs = (await sql`SELECT count(*)::int AS n FROM voice_sample WHERE clinician_id = ${target}`) as Array<{ n: number }>;
      expect(vp[0]!.n, "a biometric write with no trail must not exist").toBe(0);
      expect(vs[0]!.n).toBe(0);
      const auditMid = (await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'voiceprint.load' AND target_id = ${target}`) as Array<{ n: number }>;
      expect(auditMid[0]!.n).toBe(auditBefore[0]!.n);
    } finally {
      exec(`ALTER TABLE audit_log DROP CONSTRAINT t_refuse_audit;`);
    }
    // With the audit table accepting again, the same request lands voiceprint AND audit row together.
    const r2 = await postLoad({ entries: [{ clinician_id: target, centroid_base64: synthVec(15), provenance: { source_file: "a.json" } }] });
    expect(r2.status).toBe(200);
    const au = (await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'voiceprint.load' AND target_id = ${target}`) as Array<{ n: number }>;
    expect(au[0]!.n, "exactly one new audit row, in the same statement as the voiceprint").toBe(auditBefore[0]!.n + 1);
  }, 180_000);

  it("500-HUNT: every malformed input and every cap boundary answers 4xx or 200 — never 500", async () => {
    const { LIMITS } = await import("@/lib/voiceprint-load");
    const good = () => entry();
    const bodies: Array<[string, unknown, string?]> = [];
    const add = (label: string, e: unknown) => bodies.push([label, { entries: [e] }]);
    // types, per field
    for (const v of [12345, 1.5, true, false, null, [], ["doc_fake0108"], {}, { $ne: null }]) add(`clinician_id=${JSON.stringify(v)}`, { ...good(), clinician_id: v });
    for (const v of [7, true, null, [], {}, [1, 2, 3]]) add(`centroid=${JSON.stringify(v)}`, { ...good(), centroid_base64: v });
    for (const v of ["t.json", 1, true, [], null]) add(`provenance=${JSON.stringify(v)}`, { ...good(), provenance: v });
    for (const v of [99, true, null, [], {}]) add(`source_file=${JSON.stringify(v)}`, { ...good(), provenance: { source_file: v } });
    for (const v of [5, true, [], {}]) add(`centroid_id=${JSON.stringify(v)}`, { ...good(), provenance: { source_file: "t", centroid_id: v } });
    for (const v of ["121", null, -1, 0, true, [], LIMITS.enroll_seconds_max + 0.01]) add(`enroll_seconds=${JSON.stringify(v)}`, { ...good(), provenance: { source_file: "t", enroll_seconds: v } });
    for (const v of ["yes", 1, null, []]) add(`probe_only=${JSON.stringify(v)}`, { ...good(), provenance: { source_file: "t", probe_only: v } });
    // control characters and surrogates, in every string field
    for (const bad of ["\u0000", "a\u0007b", "\r\n", "\u007f", "\u0080", "\ud800", "\udfff", "z\ud83c"]) {
      add(`id+${JSON.stringify(bad)}`, { ...good(), clinician_id: `doc_fake0108${bad}` });
      add(`centroid+${JSON.stringify(bad)}`, { ...good(), centroid_base64: `${synthVec(14).slice(0, -4)}${bad}AAA` });
      add(`source_file+${JSON.stringify(bad)}`, { ...good(), provenance: { source_file: `f${bad}` } });
      add(`centroid_id+${JSON.stringify(bad)}`, { ...good(), provenance: { source_file: "t", centroid_id: `c${bad}` } });
      add(`key+${JSON.stringify(bad)}`, { ...good(), [`k${bad}`]: 1 });
    }
    // shapes and unknowns
    for (const e of ["a string", 42, null, true, [], { ...good(), room: "opd" }, { ...good(), full_name: makeFakeClinician(903).full_name }, { centroid_base64: synthVec(1), provenance: { source_file: "t" } }]) add(`entry=${JSON.stringify(e).slice(0, 30)}`, e);
    // centroid content
    for (const [label, c] of [["191", synthVec(9, 191)], ["193", synthVec(9, 193)], ["zero", Buffer.alloc(768).toString("base64")], ["nan", Buffer.from(new Float32Array(192).fill(Number.NaN).buffer).toString("base64")], ["urlsafe", synthVec(14).replace(/\+/g, "-").replace(/\//g, "_")], ["newline", `${synthVec(14).slice(0, 500)}\n${synthVec(14).slice(500)}`], ["huge", "A".repeat(LIMITS.centroid_base64 + 4)], ["767b", Buffer.alloc(767, 1).toString("base64")]] as Array<[string, string]>) {
      add(`centroid:${label}`, { ...good(), centroid_base64: c });
    }
    // cap boundaries, one over each
    add("id>cap", { ...good(), clinician_id: "d".repeat(LIMITS.clinician_id + 1) });
    add("source_file>cap", { ...good(), provenance: { source_file: "f".repeat(LIMITS.source_file + 1) } });
    add("centroid_id>cap", { ...good(), provenance: { source_file: "t", centroid_id: "c".repeat(LIMITS.centroid_id + 1) } });
    add("unknown id", { ...good(), clinician_id: "doc_fake0999" });
    add("disabled", { ...good(), clinician_id: "doc_fake0106" });
    add("deleted", { ...good(), clinician_id: "doc_fake0107" });
    // raw bodies
    const raws: Array<[string, string]> = [["not json", "not json"], ["[]", "[]"], ["null", "null"], ["entries str", "{\"entries\":\"x\"}"], ["entries []", "{\"entries\":[]}"], ["51 entries", JSON.stringify({ entries: Array.from({ length: 51 }, () => good()) })], ["extra key", "{\"entries\":[],\"x\":1}"], ["lone surrogate escape in key", "{\"entries\":[],\"\\ud800\":1}"], ["too large", JSON.stringify({ entries: [{ ...good(), provenance: { source_file: "x".repeat(LIMITS.body_bytes) } }] })]];

    let fiveHundreds = 0;
    const statuses: Record<string, number> = {};
    for (const [label, body] of bodies) {
      const r = await postLoad(body);
      statuses[label] = r.status;
      if (r.status >= 500) fiveHundreds += 1;
      expect([400, 404], `${label} -> ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`).toContain(r.status);
    }
    for (const [label, raw] of raws) {
      const r = await postLoad(null, undefined, raw);
      if (r.status >= 500) fiveHundreds += 1;
      expect(r.status, `${label} -> ${JSON.stringify(r.body).slice(0, 160)}`).toBe(400);
    }
    // exactly AT every cap: accepted
    await G.__pgsql`DELETE FROM voice_sample WHERE clinician_id = 'doc_fake0110'`;
    await G.__pgsql`DELETE FROM voice_print WHERE doctor_id = 'doc_fake0110'`;
    const at = await postLoad({ entries: [{ clinician_id: "doc_fake0110", centroid_base64: synthVec(16), provenance: { source_file: "f".repeat(LIMITS.source_file), centroid_id: "c".repeat(LIMITS.centroid_id), enroll_seconds: LIMITS.enroll_seconds_max, probe_only: false } }] });
    if (at.status >= 500) fiveHundreds += 1;
    expect(at.status, JSON.stringify(at.body).slice(0, 200)).toBe(200);
    console.log(`[500-hunt] inputs=${bodies.length + raws.length + 1} five_hundreds=${fiveHundreds}`);
    expect(fiveHundreds).toBe(0);
  }, 300_000);
});

describe.skipIf(!HAVE_DOCKER)("C2 merge gate 4 — every voiceprint reader is accounted for", () => {
  beforeAll(async () => {
    if (!HAVE_DOCKER) return;
    // A disabled and a deleted clinician WITH voiceprints — written directly, as a doctor enrolled
    // before being disabled would have them. (The enrol endpoint refuses both.)
    for (const [id, seed] of [["doc_fake0106", 60], ["doc_fake0107", 61]] as Array<[string, number]>) {
      await G.__pgsql`INSERT INTO voice_print (doctor_id, centroid, sample_count) VALUES (${id}, decode(${synthVec(seed)}, 'base64'), 1) ON CONFLICT (doctor_id) DO NOTHING`;
    }
  }, 120_000);

  it("ENCOUNTER READER: loadActiveClinicianCentroid gives the active doctor's centroid, and nothing for a disabled or deleted one", async () => {
    const { loadActiveClinicianCentroid } = await import("@/lib/stt/diarize-window");
    const active = await loadActiveClinicianCentroid(FAKE_ACTIVE[0]!);
    expect(active?.clinician_id).toBe(FAKE_ACTIVE[0]!);
    expect(active?.centroid_base64.replace(/\s+/g, "")).toBe(synthVec(1));
    expect(await loadActiveClinicianCentroid("doc_fake0106"), "disabled").toBeNull();
    expect(await loadActiveClinicianCentroid("doc_fake0107"), "deleted").toBeNull();
    // The process route reads through it, and reads voice_print nowhere else (a supplement to the above).
    const route = readFileSync("app/[slug]/api/encounters/[id]/process/route.ts", "utf8");
    expect(route).toContain("await loadActiveClinicianCentroid(row.doctor_id)");
    expect(route).not.toMatch(/\b(FROM|JOIN)\s+voice_print\b/);
  }, 120_000);

  it("IDENTIFY: an active doctor identifies; a DISABLED or DELETED doctor with a still-valid login token is refused before any centroid is used", async () => {
    const { POST } = await import("@/app/[slug]/api/voice/identify/route");
    const { NextRequest } = await import("next/server");
    const call = async (doctorId: string) => {
      const slug = `dr-slug-${doctorId}`;
      IDENTIFY.claims = { doctor_id: doctorId, slug };
      const form = new FormData();
      form.append("audio", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), "a.webm");
      const res = await POST(new NextRequest(`https://x.test/${slug}/api/voice/identify`, { method: "POST", body: form }), { params: Promise.resolve({ slug }) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    IDENTIFY.emb = synthVec(1);
    IDENTIFY.enrollCalls = 0;
    const ok = await call(FAKE_ACTIVE[0]!);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ enrolled: true, identified: true });
    expect(IDENTIFY.enrollCalls).toBe(1);

    for (const id of ["doc_fake0106", "doc_fake0107"]) {
      IDENTIFY.enrollCalls = 0;
      const r = await call(id);
      expect(r.status, id).toBe(403);
      expect(JSON.stringify(r.body)).toContain("clinician_not_active");
      expect(IDENTIFY.enrollCalls, "refused before the Mini is even asked").toBe(0);
    }
    // A token for a clinician row that no longer exists is refused the same way.
    expect((await call("doc_fake0999")).status).toBe(403);
    IDENTIFY.claims = null;
  }, 120_000);

  it("OPERATOR VIEW: scribe_list_voiceprints shows disabled and deleted doctors, marks them not matchable, and its summary says so", async () => {
    const { VOICE_TOOLS } = await import("@/lib/mcp/tools/voice");
    const tool = VOICE_TOOLS.find((t) => t.name === "scribe_list_voiceprints")!;
    const out = (await tool.handler({} as never, {} as never)) as { voiceprints: Array<{ clinician_id: string; clinician_status: string | null; deleted: boolean; matchable: boolean }>; summary: { total: number; matchable: number } };
    const byId = new Map(out.voiceprints.map((v) => [v.clinician_id, v]));
    expect(byId.get("doc_fake0106"), "a disabled doctor's voiceprint is SHOWN").toMatchObject({ clinician_status: "disabled", deleted: false, matchable: false });
    expect(byId.get("doc_fake0107"), "and a deleted one's").toMatchObject({ clinician_status: "active", deleted: true, matchable: false });
    expect(byId.get(FAKE_ACTIVE[0]!)).toMatchObject({ clinician_status: "active", deleted: false, matchable: true });
    expect(out.summary.total).toBe(out.voiceprints.length);
    expect(out.summary.matchable, "the count cannot mislead: total and matchable differ when rows are hidden from matching").toBe(out.voiceprints.filter((v) => v.matchable).length);
    expect(out.summary.total).toBeGreaterThan(out.summary.matchable);
    // And the matching reader agrees with `matchable`, row for row.
    const { loadClinicianCentroids } = await import("@/lib/stt/diarize-window");
    const matching = new Set((await loadClinicianCentroids()).map((c) => c.clinician_id));
    for (const v of out.voiceprints) expect(matching.has(v.clinician_id), v.clinician_id).toBe(v.matchable);
  }, 120_000);

  it("THE SWEEP: every file that reads voice_print or a voice_sample embedding is classified; a new reader fails until it is", () => {
    // Tracked AND untracked files, so a new reader is caught before it is committed.
    const READS = /\b(?:FROM|JOIN)\s+voice_print\b|encode\(embedding/;
    const hits = repoFiles()
      .filter((f) => /^(lib|app|scripts)\//.test(f) && /\.[cm]?[jt]sx?$/.test(f))
      .filter((f) => READS.test(textOf(f) ?? ""))
      .sort();
    const MATCHING_FILTERED = ["app/[slug]/api/voice/identify/route.ts", "lib/stt/diarize-window.ts"];
    const OPERATOR_UNFILTERED = [
      "app/api/admin/doctors/[id]/voice-samples/[sampleId]/embedding/route.ts",
      "app/api/admin/doctors/[id]/voice-samples/route.ts",
      "app/api/admin/doctors/[id]/voiceprint/embedding/route.ts",
      "lib/mcp/tools/voice.ts",
    ];
    const PRESENCE_ONLY = ["app/[slug]/page.tsx"]; // SELECT 1 — whether the signed-in doctor is enrolled; no vector
    const WRITER_SIDE = ["lib/voice-samples.ts"]; // recomputeCentroid reads samples to write the centroid
    const known = new Set([...MATCHING_FILTERED, ...OPERATOR_UNFILTERED, ...PRESENCE_ONLY, ...WRITER_SIDE]);
    expect(hits.filter((f) => !known.has(f)), "an unclassified voiceprint reader").toEqual([]);
    for (const f of MATCHING_FILTERED) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain("status = 'active'");
      expect(src, f).toContain("deleted_at IS NULL");
    }
  });
});

// ---------------------------------------------------------------------------
// C3 — EMOTION: the emotion_window job through the real runner, against real Postgres. The Mini's
// emotion service is faked at the fetch boundary with the captured response shape.
// ---------------------------------------------------------------------------

const EMO = {
  cap: 60 as number | undefined,
  /** When set, the scoring call reports this cap instead of `cap`. */
  segmentsCap: undefined as number | undefined,
  healthStatus: 200,
  healthOk: true,
  lastAuth: null as string | null,
  loaded: true as boolean | undefined,
  healthDown: false,
  callsDown: false,
  refuseIndex: -1,
  calls: [] as Array<{ segments: Array<{ start_s: number; end_s: number }> }>,
  onCall: null as null | (() => Promise<void>),
};
const EMO_LABELS = ["anger", "disgust", "enthusiasm", "fear", "happiness", "neutral", "sadness"];
function fakeEmotionFetch(real: typeof fetch) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (!url.includes("emotion.")) return real(input, init);
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/health")) {
      if (EMO.healthDown) throw new TypeError("fetch failed");
      return json({ ok: EMO.healthOk, model: "Aniemore/wavlm-emotion-v1-crosslingual", ...(EMO.cap === undefined ? {} : { max_duration_s: EMO.cap }), ...(EMO.loaded === undefined ? {} : { loaded: EMO.loaded, models: { wavlm: { loaded: EMO.loaded, subfolder: "int8" } } }) }, EMO.healthStatus);
    }
    if (url.endsWith("/inference/wavlm/segments")) {
      if (EMO.callsDown) throw new TypeError("fetch failed");
      const body = JSON.parse(String(init?.body)) as { audio_url: string; segments: Array<{ start_s: number; end_s: number }> };
      EMO.lastAuth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
      if (EMO.lastAuth !== "Bearer test-emotion-secret") return json({ ok: false, error: "unauthorised" }, 401);
      EMO.calls.push({ segments: body.segments });
      if (EMO.onCall) await EMO.onCall();
      return json({
        ok: true, model_key: "wavlm", model: "Aniemore/wavlm-emotion-v1-crosslingual", device: "mps", subfolder: "int8",
        max_duration_s: EMO.segmentsCap ?? EMO.cap ?? 60, max_segments: 16, fetch_s: 0.9, decode_s: 0.8,
        results: body.segments.map((sg, i) => {
          if (i === EMO.refuseIndex) return { index: i, start_s: sg.start_s, end_s: sg.end_s, ok: false, error: "segment_too_short_for_model" };
          if (sg.end_s - sg.start_s > (EMO.cap ?? 60)) return { index: i, ok: false, error: "segment_longer_than_max_duration_s" };
          const raw = EMO_LABELS.map((_, k) => 1 + ((i + k) % 7));
          const sum = raw.reduce((a, x) => a + x, 0);
          return { index: i, start_s: sg.start_s, end_s: sg.end_s, ok: true, labels: Object.fromEntries(EMO_LABELS.map((l, k) => [l, raw[k]! / sum])), top: [], duration_s: sg.end_s - sg.start_s, inference_s: 1.1 };
        }),
      });
    }
    return json({ detail: "Not Found" }, 404);
  };
}

/** A diarized window: an `ok` diarize row and attributed turns — one speaker's long run, a straddle, a second speaker. */
async function seedEmotionWindow(id: string, startMs: number, opts: { longRunS?: number } = {}): Promise<void> {
  const sql = G.__pgsql;
  const doc = makeFakeClinician(1);
  await sql`INSERT INTO bench_window VALUES (${id}, ${`sess_${id}`}, 'rd_emo', ${startMs}, ${startMs + WINDOW_MS}, 'primary', ${`clips/${id}.webm`}, true, 'transcribed')`;
  await sql`INSERT INTO room_diarize_window (window_id, room_day_id, state, speakers_json, segments_json, clip_r2_key, error, timing_json, last_run_id) VALUES (${id}, 'rd_emo', 'ok', '[]'::jsonb, '[]'::jsonb, ${`clips/${id}.webm`}, NULL, NULL, ${`run_seed_${id}`})`;
  const longS = opts.longRunS ?? 70;
  // Speaker 0: turns every 5 s with 1 s gaps for `longS` seconds -> ONE run; speaker 1 after a straddle.
  const turns: Array<[string, number, number, number, string | null, boolean]> = [];
  for (let t = 0; t + 4000 <= longS * 1000; t += 5000) turns.push([`${id}|a${t}`, 0, t, t + 4000, null, true]);
  const after = longS * 1000 + 2000;
  turns.push([`${id}|straddle`, 0, after, after + 3000, "straddle", false]);
  turns.push([`${id}|b1`, 1, after + 4000, after + 9000, "no_match", false]);
  turns.push([`${id}|b2`, 1, after + 9500, after + 12000, "no_match", false]);
  for (const [ref, spk, s, e, reason, named] of turns) {
    await sql`INSERT INTO cue (id, room_day_id, type, source, source_ref, payload) VALUES (${`c_${ref}`}, 'rd_emo', 'stt_turn', 'replay', ${ref}, ${JSON.stringify({ start_ms: startMs + s, end_ms: startMs + e, window: { start_ms: startMs, end_ms: startMs + WINDOW_MS } })}::jsonb)`;
    if (named) {
      await sql`INSERT INTO room_turn_speaker (window_id, source_ref, speaker_idx, cluster_id, overlap_ms, room_day_id, clinician_id, role, match_confidence, no_role_reason, run_id, created_at)
                VALUES (${id}, ${ref}, ${spk}, NULL, 1000, 'rd_emo', ${doc.id}, 'clinician', 0.8, NULL, ${`run_seed_${id}`}, NOW())`;
    } else {
      await sql`INSERT INTO room_turn_speaker (window_id, source_ref, speaker_idx, cluster_id, overlap_ms, room_day_id, clinician_id, role, match_confidence, no_role_reason, run_id, created_at)
                VALUES (${id}, ${ref}, ${spk}, NULL, 1000, 'rd_emo', NULL, NULL, NULL, ${reason}, ${`run_seed_${id}`}, NOW())`;
    }
  }
}

async function runEmotionJob(jobId: string, windowId: string) {
  const { insertJob, claimJobs } = await import("@/lib/jobs/store");
  const { runOneStep } = await import("@/lib/jobs/runner");
  const sql = G.__pgsql;
  await insertJob({ id: jobId, kind: "emotion_window", args: { window_id: windowId }, actor: "mcp:test" });
  const steps: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    const claimed = await claimJobs(1, 240_000, `runner_${jobId}_${i}`);
    const mine = claimed.find((c) => c.id === jobId);
    if (!mine) { if (claimed.length === 0) break; continue; }
    steps.push(String(mine.step ?? "(first)"));
    await runOneStep(mine, `runner_${jobId}_${i}`);
    const st = (await sql`SELECT status FROM scribe_job WHERE id = ${jobId}`) as Array<{ status: string }>;
    if (st[0]?.status === "done" || st[0]?.status === "failed") break;
  }
  const row = (await sql`SELECT status, result, error FROM scribe_job WHERE id = ${jobId}`) as Array<{ status: string; result: Record<string, unknown> | null; error: string | null }>;
  return { steps, ...row[0]! };
}

describe.skipIf(!HAVE_DOCKER)("C3 — emotion_window: one writer, the full distribution, its own failure domain", () => {
  const realFetch = globalThis.fetch;
  beforeAll(() => { globalThis.fetch = fakeEmotionFetch(realFetch) as typeof fetch; });
  afterAll(() => { globalThis.fetch = realFetch; delete process.env.EMOTION_ENABLED; delete process.env.EMOTION_SEGMENTS_SECRET; });
  const reset = () => {
    Object.assign(EMO, { cap: 60, segmentsCap: undefined, healthStatus: 200, healthOk: true, lastAuth: null, loaded: true, healthDown: false, callsDown: false, refuseIndex: -1, calls: [], onCall: null });
    process.env.EMOTION_ENABLED = "1";
    process.env.EMOTION_SEGMENTS_SECRET = "test-emotion-secret";
  };

  it("FLAG OFF: the job fails emotion_disabled and writes nothing; an unrecognised value is not read as off", async () => {
    reset();
    await seedEmotionWindow("bw_emo_off", 20 * WINDOW_MS);
    delete process.env.EMOTION_ENABLED;
    const r = await runEmotionJob("job_emo_off", "bw_emo_off");
    expect(r.status).toBe("failed");
    expect(String(r.error)).toMatch(/^emotion_disabled/);
    process.env.EMOTION_ENABLED = "maybe";
    const r2 = await runEmotionJob("job_emo_bad", "bw_emo_off");
    expect(String(r2.error)).toMatch(/^emotion_disabled: EMOTION_ENABLED has an unrecognised value/);
    const n = (await G.__pgsql`SELECT (SELECT count(*) FROM room_span_emotion WHERE window_id = 'bw_emo_off')::int AS s, (SELECT count(*) FROM room_emotion_window WHERE window_id = 'bw_emo_off')::int AS w`) as Array<{ s: number; w: number }>;
    expect(n[0]).toEqual({ s: 0, w: 0 });
    expect(EMO.calls).toHaveLength(0);
  }, 300_000);

  it("HAPPY PATH: warm-up first, runs merged, long run CHUNKED under the cap, straddle SKIPPED, every row carries all seven scores", async () => {
    reset();
    await seedEmotionWindow("bw_emo", 21 * WINDOW_MS);
    const sql = G.__pgsql;
    const diarizeBefore = (await sql`SELECT (SELECT count(*) FROM room_turn_speaker WHERE window_id = 'bw_emo')::int AS t, (SELECT state FROM room_diarize_window WHERE window_id = 'bw_emo') AS s`) as Array<{ t: number; s: string }>;
    const r = await runEmotionJob("job_emo", "bw_emo");
    expect(r.status, `error=${r.error}`).toBe("done");
    expect(r.steps).toEqual(["(first)", "warm", "score", "finish"]);

    // The warm-up is the FIRST call, a throwaway second of audio.
    expect(EMO.calls[0]!.segments).toEqual([{ start_s: 0, end_s: 1 }]);
    expect(EMO.calls.length, "warm-up + one batch").toBe(2);
    expect(EMO.calls.every((c) => c.segments.length <= 16)).toBe(true);

    const rows = (await sql`SELECT state, reason, speaker_idx, chunk_idx, chunk_count, segment_start_ms, segment_end_ms, clip_start_s, clip_end_s, source_refs,
                                   anger, disgust, enthusiasm, fear, happiness, neutral, sadness, labels_json, top_label, top_score, model, model_key, subfolder, device, cap_s, duration_s, inference_s, clip_r2_key
                              FROM room_span_emotion WHERE window_id = 'bw_emo' ORDER BY segment_start_ms`) as Array<Record<string, unknown>>;
    const scored = rows.filter((x) => x.state === "scored");
    const skipped = rows.filter((x) => x.state === "skipped");
    // Speaker 0's 70 s run -> 3 chunks of <= 30 s; speaker 1's two turns merge into ONE run.
    expect(scored.filter((x) => x.speaker_idx === 0).map((x) => [x.chunk_idx, x.chunk_count])).toEqual([[0, 3], [1, 3], [2, 3]]);
    expect(scored.filter((x) => x.speaker_idx === 1)).toHaveLength(1);
    expect((scored.find((x) => x.speaker_idx === 1)!.source_refs as string[]).length, "the two turns merged into one run").toBe(2);
    for (const x of scored) {
      expect(Number(x.segment_end_ms) - Number(x.segment_start_ms)).toBeLessThanOrEqual(30_000);
      const seven = EMO_LABELS.map((l) => Number(x[l]));
      expect(seven.every((v) => v >= 0 && v <= 1)).toBe(true);
      expect(seven.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 6);
      expect(x.top_label).toBe(EMO_LABELS[seven.indexOf(Math.max(...seven))]);
      expect(x).toMatchObject({ model: "Aniemore/wavlm-emotion-v1-crosslingual", model_key: "wavlm", subfolder: "int8", device: "mps", cap_s: 60, clip_r2_key: "clips/bw_emo.webm" });
      expect(Number(x.clip_end_s)).toBeGreaterThan(Number(x.clip_start_s));
    }
    expect(skipped.map((x) => [x.reason, x.speaker_idx])).toEqual([["straddle", 0]]);
    expect(EMO_LABELS.every((l) => skipped[0]![l] === null)).toBe(true);

    const w = (await sql`SELECT state, diarize_run_id, attempts, segments_planned, segments_scored, segments_skipped, segments_failed, calls, cap_s, warmup_json FROM room_emotion_window WHERE window_id = 'bw_emo'`) as Array<Record<string, unknown>>;
    expect(w[0]).toMatchObject({ state: "ok", diarize_run_id: "run_seed_bw_emo", attempts: 1, segments_planned: 4, segments_scored: 4, segments_skipped: 1, segments_failed: 0, calls: 2, cap_s: 60 });
    expect(EMO.lastAuth, "the shared secret travels on every call").toBe("Bearer test-emotion-secret");
    expect(w[0]!.warmup_json).toMatchObject({ loaded_before: true, ok: true });

    // ITS OWN FAILURE DOMAIN, even on success: the diarize tables are exactly as they were.
    const diarizeAfter = (await sql`SELECT (SELECT count(*) FROM room_turn_speaker WHERE window_id = 'bw_emo')::int AS t, (SELECT state FROM room_diarize_window WHERE window_id = 'bw_emo') AS s`) as Array<{ t: number; s: string }>;
    expect(diarizeAfter[0]).toEqual(diarizeBefore[0]);
  }, 300_000);

  it("IDEMPOTENT: the same job again for the same diarize attempt duplicates no row and does not rewrite the window", async () => {
    const sql = G.__pgsql;
    const before = (await sql`SELECT (SELECT count(*) FROM room_span_emotion WHERE window_id = 'bw_emo')::int AS n, (SELECT scored_at::text FROM room_emotion_window WHERE window_id = 'bw_emo') AS at`) as Array<{ n: number; at: string }>;
    reset();
    const r = await runEmotionJob("job_emo_again", "bw_emo");
    expect(r.status).toBe("done");
    const after = (await sql`SELECT (SELECT count(*) FROM room_span_emotion WHERE window_id = 'bw_emo')::int AS n, (SELECT scored_at::text FROM room_emotion_window WHERE window_id = 'bw_emo') AS at`) as Array<{ n: number; at: string }>;
    expect(after[0]).toEqual(before[0]);
  }, 300_000);

  it("THE CAP IS READ FROM /health: a service reporting 12 s gets chunks of at most 11 s; a /health with no cap fails the window by name", async () => {
    reset();
    EMO.cap = 12;
    await seedEmotionWindow("bw_emo_cap", 22 * WINDOW_MS);
    const r = await runEmotionJob("job_emo_cap", "bw_emo_cap");
    expect(r.status, `error=${r.error}`).toBe("done");
    const lens = (await G.__pgsql`SELECT state, speaker_idx, chunk_count, (segment_end_ms - segment_start_ms)::int AS ms, cap_s FROM room_span_emotion WHERE window_id = 'bw_emo_cap' AND state <> 'skipped'`) as Array<{ state: string; speaker_idx: number; chunk_count: number; ms: number; cap_s: number }>;
    // PLANNED under the cap, not refused by the service for exceeding it: nothing failed.
    expect(lens.map((l) => l.state).filter((x) => x !== "scored"), "a chunk planned past the cap would come back refused").toEqual([]);
    expect(Math.max(...lens.map((l) => l.ms))).toBeLessThanOrEqual(11_000);
    expect(lens.filter((l) => l.speaker_idx === 0).length, "the 70 s run is split for a 12 s cap").toBeGreaterThanOrEqual(7);
    expect(lens.every((l) => l.cap_s === 12)).toBe(true);

    reset();
    EMO.cap = undefined;
    EMO.loaded = undefined;
    await seedEmotionWindow("bw_emo_nocap", 23 * WINDOW_MS);
    const r2 = await runEmotionJob("job_emo_nocap", "bw_emo_nocap");
    expect(r2.status).toBe("failed");
    expect(String(r2.error)).toMatch(/^emotion_unavailable: health_cap_unreadable/);
    const w = (await G.__pgsql`SELECT state, error FROM room_emotion_window WHERE window_id = 'bw_emo_nocap'`) as Array<{ state: string; error: string }>;
    expect(w[0]!.state).toBe("failed");
    expect(EMO.calls, "no audio is sent when the cap is unknown").toHaveLength(0);
  }, 300_000);

  it("A SEGMENT THE SERVICE REFUSES is a failed row with its reason; the rest of the window still lands", async () => {
    reset();
    EMO.refuseIndex = 1;
    await seedEmotionWindow("bw_emo_ref", 24 * WINDOW_MS);
    const r = await runEmotionJob("job_emo_ref", "bw_emo_ref");
    expect(r.status).toBe("done");
    const rows = (await G.__pgsql`SELECT state, reason, top_label FROM room_span_emotion WHERE window_id = 'bw_emo_ref' AND state <> 'skipped' ORDER BY segment_start_ms`) as Array<{ state: string; reason: string | null; top_label: string | null }>;
    expect(rows.map((x) => x.state)).toEqual(["scored", "failed", "scored", "scored"]);
    expect(rows[1]).toEqual({ state: "failed", reason: "segment_too_short_for_model", top_label: null });
  }, 300_000);

  it("SERVICE DOWN: the window is recorded failed, the diarize tables are untouched, and the enqueue retries it to the bound", async () => {
    reset();
    await seedEmotionWindow("bw_emo_down", 25 * WINDOW_MS);
    const sql = G.__pgsql;
    const tsBefore = (await sql`SELECT count(*)::int AS n FROM room_turn_speaker WHERE window_id = 'bw_emo_down'`) as Array<{ n: number }>;
    EMO.callsDown = true;
    const r = await runEmotionJob("job_emo_down", "bw_emo_down");
    expect(r.status).toBe("failed");
    expect(String(r.error)).toMatch(/^emotion_unavailable/);
    const w = (await sql`SELECT state, attempts FROM room_emotion_window WHERE window_id = 'bw_emo_down'`) as Array<{ state: string; attempts: number }>;
    expect(w[0]).toEqual({ state: "failed", attempts: 1 });
    const d = (await sql`SELECT state FROM room_diarize_window WHERE window_id = 'bw_emo_down'`) as Array<{ state: string }>;
    expect(d[0]!.state, "an emotion failure never touches diarize").toBe("ok");
    const tsAfter = (await sql`SELECT count(*)::int AS n FROM room_turn_speaker WHERE window_id = 'bw_emo_down'`) as Array<{ n: number }>;
    expect(tsAfter[0]).toEqual(tsBefore[0]);

    // THE BOUND, through the real enqueue: only this window eligible.
    await sql`UPDATE room_diarize_window SET state = 'failed', error = 'test: out of scope' WHERE window_id <> 'bw_emo_down'`;
    const { enqueueEmotionWindows } = await import("@/lib/emotion/enqueue");
    const quiet = () => {};
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      const e = await enqueueEmotionWindows({ actor: "cron:test", log: quiet });
      expect(e.enqueued.map((x) => x.window_id), `attempt ${attempt}`).toEqual(["bw_emo_down"]);
      const jobId = e.enqueued[0]!.job_id;
      const { claimJobs } = await import("@/lib/jobs/store");
      const { runOneStep } = await import("@/lib/jobs/runner");
      for (let i = 0; i < 6; i += 1) {
        const c = (await claimJobs(1, 240_000, `r_${attempt}_${i}`)).find((x) => x.id === jobId);
        if (!c) break;
        await runOneStep(c, `r_${attempt}_${i}`);
      }
    }
    const w3 = (await sql`SELECT state, attempts, jsonb_array_length(failure_history) AS h FROM room_emotion_window WHERE window_id = 'bw_emo_down'`) as Array<{ state: string; attempts: number; h: number }>;
    expect(w3[0]).toEqual({ state: "failed", attempts: 3, h: 2 });
    const done = await enqueueEmotionWindows({ actor: "cron:test", log: quiet });
    expect(done.enqueued, "no fourth attempt").toEqual([]);
    expect(done.exhausted).toBe(1);
    EMO.callsDown = false;
  }, 300_000);

  it("DIARIZE RE-RAN UNDERNEATH — SUCCESSFULLY: a real diarize job rewrites the turns mid-job; attempts do not move, the run id does, and the job stops", async () => {
    reset();
    await seedEmotionWindow("bw_emo_chg", 26 * WINDOW_MS);
    const sql = G.__pgsql;
    const before = (await sql`SELECT state, attempts, last_run_id FROM room_diarize_window WHERE window_id = 'bw_emo_chg'`) as Array<{ state: string; attempts: number; last_run_id: string }>;
    // Between the warm-up and the first batch, the REAL diarize_window job runs again on this window
    // and succeeds — the case the old attempts-counter guard could not see.
    let n = 0;
    EMO.onCall = async () => {
      n += 1;
      if (n !== 1) return;
      const { insertJob, claimJobs } = await import("@/lib/jobs/store");
      const { runOneStep } = await import("@/lib/jobs/runner");
      SVC.fail = false;
      await insertJob({ id: "job_emo_chg_diarize", kind: "diarize_window", args: { window_id: "bw_emo_chg" }, actor: "mcp:test" });
      for (let i = 0; i < 5; i += 1) {
        const c = (await claimJobs(3, 240_000, `r_chg_${i}`)).find((x) => x.id === "job_emo_chg_diarize");
        if (!c) break;
        await runOneStep(c, `r_chg_${i}`);
      }
    };
    const r = await runEmotionJob("job_emo_chg", "bw_emo_chg");
    const dj = (await sql`SELECT status, error FROM scribe_job WHERE id = 'job_emo_chg_diarize'`) as Array<{ status: string; error: string | null }>;
    expect(dj[0]!.status, `the re-run must succeed; error=${dj[0]!.error}`).toBe("done");
    const after = (await sql`SELECT state, attempts, last_run_id FROM room_diarize_window WHERE window_id = 'bw_emo_chg'`) as Array<{ state: string; attempts: number; last_run_id: string }>;
    expect(after[0]!.state).toBe("ok");
    expect(after[0]!.attempts, "a successful re-run does not move the attempts counter — why the old guard was blind").toBe(before[0]!.attempts);
    expect(after[0]!.last_run_id, "the run id moves on every run that writes turns").not.toBe(before[0]!.last_run_id);
    expect(r.status).toBe("failed");
    expect(String(r.error)).toMatch(/^diarize_changed/);
    const scored = (await sql`SELECT count(*)::int AS n FROM room_span_emotion WHERE window_id = 'bw_emo_chg' AND state = 'scored'`) as Array<{ n: number }>;
    expect(scored[0]!.n).toBe(0);
    // And the enqueue sees it: emotion recorded against the old run, diarize is on a new one.
    const e = (await sql`SELECT diarize_run_id FROM room_emotion_window WHERE window_id = 'bw_emo_chg'`) as Array<{ diarize_run_id: string }>;
    expect(e[0]!.diarize_run_id).toBe(before[0]!.last_run_id);
  }, 300_000);

  it("P1 — AN UNHEALTHY /health FAILS THE WINDOW even when it carries a cap; an implausible cap fails it by name and sends no audio", async () => {
    const sql = G.__pgsql;
    const cases: Array<[string, () => void, RegExp]> = [
      ["bw_emo_h500", () => { EMO.healthStatus = 500; EMO.healthOk = false; EMO.loaded = false; EMO.cap = 60; }, /^emotion_unavailable: health_http_500/],
      ["bw_emo_hnotok", () => { EMO.healthOk = false; EMO.cap = 60; }, /^emotion_unavailable: health_not_ok/],
      ["bw_emo_cap15", () => { EMO.cap = 1.5; }, /^emotion_unavailable: health_cap_out_of_range: 1\.5s/],
      ["bw_emo_cap120", () => { EMO.cap = 120; }, /^emotion_unavailable: health_cap_out_of_range: 120s/],
    ];
    let k = 0;
    for (const [id, setup, want] of cases) {
      reset();
      setup();
      await seedEmotionWindow(id, (30 + k++) * WINDOW_MS);
      const r = await runEmotionJob(`job_${id}`, id);
      expect(r.status, id).toBe("failed");
      expect(String(r.error), id).toMatch(want);
      expect(EMO.calls, `${id}: no audio sent`).toHaveLength(0);
      const w = (await sql`SELECT state FROM room_emotion_window WHERE window_id = ${id}`) as Array<{ state: string }>;
      expect(w[0]?.state, id).toBe("failed");
    }
  }, 300_000);

  it("P1 — THE CAP ACTUALLY USED: if the scoring call reports a different cap than the plan used, the window fails and nothing is scored under it", async () => {
    reset();
    EMO.cap = 30;
    EMO.segmentsCap = 60;
    await seedEmotionWindow("bw_emo_capchg", 40 * WINDOW_MS);
    const r = await runEmotionJob("job_emo_capchg", "bw_emo_capchg");
    expect(r.status).toBe("failed");
    expect(String(r.error)).toMatch(/^emotion_cap_changed: planned under 30s, service now reports 60s/);
    const scored = (await G.__pgsql`SELECT count(*)::int AS n FROM room_span_emotion WHERE window_id = 'bw_emo_capchg' AND state = 'scored'`) as Array<{ n: number }>;
    expect(scored[0]!.n).toBe(0);
  }, 300_000);

  it("P0 — NO SECRET, NO CALL: the job fails emotion_not_configured before touching the service; the enqueue refuses loudly", async () => {
    reset();
    delete process.env.EMOTION_SEGMENTS_SECRET;
    await seedEmotionWindow("bw_emo_nosecret", 41 * WINDOW_MS);
    const r = await runEmotionJob("job_emo_nosecret", "bw_emo_nosecret");
    expect(r.status).toBe("failed");
    expect(String(r.error)).toMatch(/^emotion_not_configured/);
    expect(EMO.calls).toHaveLength(0);
    const { enqueueEmotionWindows } = await import("@/lib/emotion/enqueue");
    await expect(enqueueEmotionWindows({ actor: "cron:test", log: () => {} })).rejects.toThrow(/EMOTION_SEGMENTS_SECRET is not set/);
    process.env.EMOTION_SEGMENTS_SECRET = "test-emotion-secret";
  }, 300_000);

  it("LOADED IS REPORTED, NOT ASSUMED: a /health that does not say records 'unknown'", async () => {
    reset();
    EMO.loaded = undefined;
    await seedEmotionWindow("bw_emo_unk", 27 * WINDOW_MS);
    const r = await runEmotionJob("job_emo_unk", "bw_emo_unk");
    expect(r.status, `error=${r.error}`).toBe("done");
    const w = (await G.__pgsql`SELECT warmup_json FROM room_emotion_window WHERE window_id = 'bw_emo_unk'`) as Array<{ warmup_json: { loaded_before: unknown } }>;
    expect(w[0]!.warmup_json.loaded_before).toBe("unknown");
  }, 300_000);

  it("THE ROUTE: bare cron header is 401; flag off is a clean no-op; an unrecognised flag is a non-2xx", async () => {
    process.env.CRON_SECRET = "test-cron-secret";
    const { GET } = await import("@/app/api/admin/emotion-windows/route");
    const { NextRequest } = await import("next/server");
    const call = (headers: Record<string, string>) => GET(new NextRequest("https://x.test/api/admin/emotion-windows", { headers }));
    expect((await call({ "x-vercel-cron": "1" })).status).toBe(401);
    delete process.env.EMOTION_ENABLED;
    const off = await call({ authorization: "Bearer test-cron-secret" });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ enabled: false, jobs: [] });
    process.env.EMOTION_ENABLED = "sure";
    const bad = await call({ authorization: "Bearer test-cron-secret" });
    expect(bad.status).toBe(500);
    delete process.env.EMOTION_ENABLED;
  }, 120_000);
});

