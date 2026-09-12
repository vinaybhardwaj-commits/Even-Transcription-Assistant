/**
 * C2 ITEM 0 — A 900 s WINDOW THROUGH THE REAL RUNNER, AGAINST A REAL POSTGRES.
 *
 * Three times in this slice a core path shipped inert and every unit test stayed green: the lease
 * made diarize unreachable, the join loaded zero turns, and the stitch matched on a key another
 * statement had already consumed. All three survived because the tests mocked the database and
 * called the step functions directly, so nothing ever exercised the ORDER the job actually runs in
 * or the PREDICATES the database actually applies.
 *
 * This drives `runOneStep` over a real `scribe_job` row — real claims, real leases, real progress
 * — against an ephemeral postgres:16 with the real 0074 and 0085 DDL. Only the outside world is
 * faked: `/diarize` (with the shape captured from a real response), R2 and the join service. The
 * database is not faked, and neither is the runner.
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
vi.mock("@/lib/diarize", () => ({
  runDiarize: async (_a: unknown, _c: string, opts: { encounterId: string }) => {
    DIARIZE_CALLS.push(opts.encounterId);
    return {
      ok: true, latencyMs: 900,
      result: {
        // THE CASE THE STITCH EXISTS FOR. The same voice is RECOGNISED on even slices and not on
        // odd ones — which is what a borderline cosine does in practice. Without cross-slice
        // propagation the doctor is named in half the window and anonymous in the other half.
        speakers: [
          Number(opts.encounterId.split("#")[1]) % 2 === 0
            ? { idx: 0, label: "Dr", type: "clinician", source: "auto", clinician_id: "doc_fake0001", confidence: 0.82, embedding_base64: emb(1) }
            : { idx: 0, label: "Speaker 0", type: "other", source: "heuristic", embedding_base64: emb(1) },
          { idx: 1, label: "Patient", type: "patient", source: "heuristic", embedding_base64: emb(2) },
        ],
        // Speaker 0 holds the first half of each slice, speaker 1 the second.
        transcript_segments: [
          { start_ms: 0, end_ms: 60_000, speaker_idx: 0, overlap: false },
          { start_ms: 60_000, end_ms: 120_000, speaker_idx: 1, overlap: false },
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
  // THE STRADDLE: a turn wholly inside slice 0 that spans the 60 s speaker change.
  rows.push(`('cstr','rd_1','stt_turn','replay','sess_1|55000|65000|w', '{"start_ms":55000,"end_ms":65000,"window":{"start_ms":0,"end_ms":${WINDOW_MS}}}'::jsonb)`);
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

describe.skipIf(!HAVE_DOCKER)("C2 e2e — a 900 s window through runOneStep, real postgres", () => {
  it("runs every slice step then the stitch, writes rows, and stitches some of them", async () => {
    const { insertJob, claimJobs } = await import("@/lib/jobs/store");
    const { runOneStep } = await import("@/lib/jobs/runner");
    const sql = G.__pgsql;

    await insertJob({ id: "job_e2e", kind: "diarize_window", args: { window_id: "bw_e2e" }, actor: "mcp:test" });

    const steps: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const claimed = await claimJobs(1, 240_000, `runner_${i}`);
      if (claimed.length === 0) break;
      const job = claimed[0]!;
      steps.push(String(job.step ?? "(first)"));
      await runOneStep(job, `runner_${i}`);
      // The JOB ROW is the authority on where this got to, not the report the runner handed back.
      const st = (await sql`SELECT status FROM scribe_job WHERE id = 'job_e2e'`) as Array<{ status: string }>;
      if (st[0]?.status === "done" || st[0]?.status === "failed") break;
    }

    // ── THE ORDER ACTUALLY EXECUTED ────────────────────────────────────────────────────────
    // The count is the PLANNER's answer, driven for real — not a number copied into the test.
    const { snappedSliceBounds } = await import("@/lib/stt/diarize-slicing");
    const turns = (await sql`SELECT (payload->>'start_ms')::bigint AS start_ms, (payload->>'end_ms')::bigint AS end_ms FROM cue WHERE type = 'stt_turn'`) as Array<{ start_ms: number; end_ms: number }>;
    const planned = snappedSliceBounds(0, WINDOW_MS, turns.map((t) => ({ start_ms: Number(t.start_ms), end_ms: Number(t.end_ms) })));
    const sliceSteps = steps.filter((s) => s === "slice" || s === "(first)").length;
    expect(planned.length, "a 900 s window must be several slices, not one").toBeGreaterThanOrEqual(8);
    expect(sliceSteps, `every planned slice must run; saw: ${steps.join(",")}`).toBe(planned.length);
    expect(steps[steps.length - 1], "the stitch runs last").toBe("stitch");

    expect(DIARIZE_CALLS.length, "one /diarize call per slice").toBe(planned.length);

    const jobRow = (await sql`SELECT status, result FROM scribe_job WHERE id = 'job_e2e'`) as Array<{ status: string; result: Record<string, unknown> }>;
    const result = jobRow[0]!.result;
    expect(jobRow[0]!.status).toBe("done");
    expect(result.slices, "observed count, not planned").toBe(planned.length);

    // ── ROWS, PER SLICE, COUNTED ───────────────────────────────────────────────────────────
    const rows = (await sql`SELECT source_ref, cluster_id, role, clinician_id, no_role_reason FROM room_turn_speaker WHERE window_id = 'bw_e2e'`) as Array<{ source_ref: string; cluster_id: string; role: string | null; clinician_id: string | null; no_role_reason: string | null }>;
    expect(rows.length, "every turn should have produced a span row").toBeGreaterThan(40);

    // ── EVERY COUNTER NON-ZERO ON THE HAPPY PATH ───────────────────────────────────────────
    expect(Number(result.rows_stitched), "rows_stitched is the whole point of the stitch step").toBeGreaterThan(0);
    expect(Number(result.speakers_seen)).toBeGreaterThan(0);
    expect(Number(result.identities)).toBeGreaterThan(0);
    expect(Number(result.turns_named), "the service matched a clinician on the even slices").toBeGreaterThan(0);
    // The odd slices' speaker 0 rows start unnamed and are filled by the stitch, which is the
    // whole point: a voice recognised in slice 2 is the same person in slice 3.
    const namedNow = rows.filter((r) => r.role === "clinician").length;
    expect(namedNow, "after the stitch, more rows are named than the service named itself").toBeGreaterThan(Number(result.turns_named));
    expect(Number(result.turns_straddled), "the seeded straddle must be counted").toBeGreaterThan(0);

    // ── THE STRUCTURAL REFUSALS SURVIVE THE STITCH ─────────────────────────────────────────
    const straddle = rows.find((r) => r.source_ref === "sess_1|55000|65000|w")!;
    expect(straddle.role, "a turn held by two speakers may never be named").toBeNull();
    expect(straddle.no_role_reason).toBe("straddle");
    expect(straddle.clinician_id).toBeNull();

    // Some row somewhere got a name, and no row carries a name without the claim.
    expect(rows.some((r) => r.role === "clinician" && r.clinician_id === "doc_fake0001")).toBe(true);
    for (const r of rows) {
      if (r.role === "clinician") expect(r.no_role_reason, "a named row states no refusal").toBeNull();
      else expect(r.no_role_reason, "an unnamed row always says why").toBeTruthy();
    }
  }, 300_000);
});

describe.skipIf(!HAVE_DOCKER)("R4 D1 — the legacy writer's rows land, and a rejected write cannot read as success", () => {
  it("the legacy INSERT satisfies 0085 as shipped, and the pre-0085 shape is refused", async () => {
    const sql = G.__pgsql;
    await sql`DELETE FROM room_turn_speaker WHERE window_id = 'bw_legacy'`;

    // THE SHIPPED STATEMENT, copied in shape from lib/stt/diarize-job.ts's bindTurns.
    await sql`
      INSERT INTO room_turn_speaker (window_id, source_ref, speaker_idx, cluster_id, overlap_ms, room_day_id,
                                     role, no_role_reason, created_at)
      VALUES ('bw_legacy', 'sess|0|1000|w', 0, 'sc_abc', 900, 'rd_1', NULL, 'no_match', NOW())
      ON CONFLICT (window_id, source_ref) DO NOTHING
    `;
    const landed = (await sql`SELECT source_ref, role, no_role_reason, clinician_id FROM room_turn_speaker WHERE window_id = 'bw_legacy'`) as Array<Record<string, unknown>>;
    expect(landed, "the legacy path must be able to write at all").toHaveLength(1);
    expect(landed[0]!.role).toBeNull();
    expect(landed[0]!.no_role_reason, "it never attempts identification, so no_match is the honest value").toBe("no_match");
    expect(landed[0]!.clinician_id, "and it may never name anyone").toBeNull();

    // THE PRE-FIX SHAPE: neither column sent. no_role_ck is (role IS NULL) = (reason IS NOT NULL);
    // both NULL makes that FALSE and every row bounced — silently, because the caller caught it.
    let refused = "";
    try {
      await sql`
        INSERT INTO room_turn_speaker (window_id, source_ref, speaker_idx, cluster_id, overlap_ms, room_day_id, created_at)
        VALUES ('bw_legacy', 'sess|0|2000|w', 0, 'sc_abc', 900, 'rd_1', NOW())
      `;
    } catch (e) { refused = String(e); }
    expect(refused, "the old statement must still be rejected by the real constraint").toContain("room_turn_speaker_no_role_ck");
  }, 120_000);

  it("a pass with errors is NOT success-shaped — the route returns a non-2xx", async () => {
    // Drive the real route handler with a pass that reports failures, exactly as a rejected write
    // would. The bug was that `errors` was populated and the route returned 200 with turns_bound: 0
    // — indistinguishable from a healthy quiet pass.
    vi.resetModules();
    vi.doMock("@/lib/stt/diarize-job", () => ({
      DIARIZE_BATCH_LIMIT: 4,
      runRoomDiarizePass: async () => ({
        enabled: true, scanned: 1, diarized: 1, failed: 0,
        clusters_created: 0, clusters_updated: 0, turns_bound: 0, dry: false,
        errors: ["[room-diarize] bw_x: turn binding failed: violates check constraint"],
      }),
    }));
    // The GET door authorises on the cron header alone. The POST door reads an admin cookie,
    // which needs a Next request scope this harness does not have — and the branch under test is
    // the shared `run`, reached identically by both.
    const { GET } = await import("@/app/api/admin/diarize-windows/route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("https://x.test/api/admin/diarize-windows", { headers: { "x-vercel-cron": "1" } });
    const res = await GET(req);
    expect(res.status, "a caught exception must not produce success-shaped output").not.toBe(200);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("PIPELINE_FAILED");
    expect(body.error?.message, "and it must say the zero is not a clean zero").toMatch(/turns_bound=0/);
    vi.doUnmock("@/lib/stt/diarize-job");
    vi.resetModules();
  }, 60_000);
});
