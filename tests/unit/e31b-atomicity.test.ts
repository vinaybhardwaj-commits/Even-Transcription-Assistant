/**
 * E31 BATCH 1, HALF B — A4, A7, D3, D1 — AGAINST A REAL POSTGRES.
 *
 * THE PRINCIPLE: a write that half-lands must never read as success, and must never read as never-started.
 *
 * THE HAPPY PATH PROVES NOTHING HERE. Every site gets a FAILURE INJECTED INSIDE THE STATEMENT — a trigger that
 * raises on the second half of the work — and the assertion is that the database is in the EARLIER state, not a
 * half-state. A trigger is used rather than a mock because atomicity is a property of the database, not of the
 * driver: a mocked `sql` can show which statements were issued, but only Postgres can show that a data-modifying
 * CTE rolled its first half back when its second half raised.
 *
 * AND EVERY SITE HAS A SPLIT MUTANT (PRD §4.2): the E31 mutation harness re-splits each CTE into the two
 * statements it replaced. If splitting keeps this file green, nothing has been pinned — so each test below is
 * written to fail under its own split, and the report names which test dies for which site.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({
  sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>),
  // R63: the pin route is driven for real; only the two things that need a JWT secret and a request scope are
  // stubbed, and they are spies so a test can ask whether a session was issued.
  signDoctorJwt: vi.fn(async (_c: { doctor_id: string; slug: string }) => "jwt.fixture"),
  setDoctorCookie: vi.fn(async (_jwt: string, _slug: string) => {}),
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), signDoctorJwt: H.signDoctorJwt }));
vi.mock("@/lib/cookie", () => ({ setDoctorCookie: H.setDoctorCookie }));
vi.mock("@/lib/r2", () => ({ getObjectBytes: async () => new Uint8Array([1]), signGetUrl: async () => "https://r2.example/x" }));

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-e31b-atomicity");
const noRecord = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");

describe("REQUIRED PROOF — E31 half B runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/e31b-atomicity.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

/** Raise inside the statement, on the half that must not be able to commit alone. */
const armTrigger = (name: string, table: string, event: string) => pg.exec(`
  CREATE OR REPLACE FUNCTION ${name}_fn() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'E31 injected failure on ${table} ${event}'; END $$;
  DROP TRIGGER IF EXISTS ${name} ON ${table};
  CREATE TRIGGER ${name} BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}_fn();
`);
const disarm = (name: string, table: string) => pg.exec(`DROP TRIGGER IF EXISTS ${name} ON ${table};`);

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  pg.exec(`
    CREATE TABLE schema_migrations (version int PRIMARY KEY, name text);
    CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL, started_at timestamptz, ended_at timestamptz, status text);
    INSERT INTO bench_session VALUES ('sess_1', 'room_1', to_timestamp(0), NULL, 'ended');
    CREATE TABLE stt_subject_job (
      id text PRIMARY KEY, subject_type text NOT NULL, subject_id text NOT NULL, tier text NOT NULL,
      state text NOT NULL, finished_at timestamptz, last_error text, created_at timestamptz DEFAULT NOW());
    CREATE TABLE transcription_run (
      id text PRIMARY KEY, encounter_id text, subject_type text, subject_id text, engine text, stt_engine_id text,
      mode text, tier text, detected_language text, transcript_original text, transcript_english text,
      latency_ms int, cost_usd double precision, error text, metrics_json jsonb, created_at timestamptz,
      initiated_by text, initiated_via text, engine_version_reported text,
      audio_r2_key text, audio_byte_start bigint, audio_byte_end bigint, audio_sha256 text);
    CREATE TABLE clinician (
      id text PRIMARY KEY, failed_pin_count int NOT NULL DEFAULT 0, locked_until timestamptz,
      status text NOT NULL DEFAULT 'active', updated_at timestamptz, last_active_at timestamptz,
      full_name text, url_slug text, pin_hash text, deleted_at timestamptz);
    CREATE TABLE pin_attempt (
      id bigserial PRIMARY KEY, doctor_id text NOT NULL, success boolean NOT NULL, ip inet, user_agent text,
      created_at timestamptz NOT NULL DEFAULT NOW());
    CREATE TABLE audit_log (
      id bigserial PRIMARY KEY, actor_type text, actor_id text, action text, target_type text, target_id text,
      metadata_json jsonb, created_at timestamptz NOT NULL DEFAULT NOW());
  `);
  pg.exec(noRecord("db/migrations/0057_bench_window.sql"));
  // 0101 is on this line (E18 shipped in 64ce357): it is what widens bench_window's state CHECK to admit
  // 'silent', which the A4 statement writes on the silent branch.
  pg.exec(noRecord("db/migrations/0101_bench_window_silence.sql"));
  H.sql = pg.sql;
}, 240_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

/** Each window gets its OWN span: 0057's uq_bench_window_span is (session_id, start_ms, end_ms, source_mic). */
let nextSpan = 0;
const seedWindow = (id: string, state: string) => {
  const start = (nextSpan += 900_000);
  pg.exec(`
    INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, clip_r2_key, grid_aligned, state, closed_at)
    VALUES ('${id}', 'sess_1', 'rd_1', ${start}, ${start + 900_000}, 'primary', 'clips/${id}.webm', TRUE, '${state}', NOW());
    INSERT INTO stt_subject_job (id, subject_type, subject_id, tier, state)
    VALUES ('job_${id}', 'bench_window', '${id}', 'asr', 'running');
  `);
};
const windowState = async (id: string) =>
  ((await pg.sql`SELECT state FROM bench_window WHERE id = ${id}`) as Array<{ state: string }>)[0]?.state;
const jobState = async (id: string) =>
  ((await pg.sql`SELECT state, finished_at::text AS finished_at FROM stt_subject_job WHERE subject_id = ${id}`) as Array<{ state: string; finished_at: string | null }>)[0]!;
const ACTOR = { actor: "admin_1", via: "admin_route" } as never;

describe.runIf(HAVE_DOCKER)("E31 A4 — the window state and the job state land together", () => {
  it("FAILURE INJECTED in the job half: the window is still `transcribing` — the earlier state, not a half-state", async () => {
    const { roomWindowFinish } = await import("@/lib/stt/room-drain");
    seedWindow("bw_a4_fail", "transcribing");
    armTrigger("t_a4", "stt_subject_job", "UPDATE");
    let threw = "";
    try {
      await roomWindowFinish("bw_a4_fail", ACTOR, {}).catch((e: Error) => { threw = String(e.message); });
    } finally {
      disarm("t_a4", "stt_subject_job");
    }
    expect(threw, "the statement failed, and the failure reached the caller").toMatch(/E31 injected failure/);
    // THE WHOLE POINT. Split into two statements, the window would read `transcribed` here — a clean success
    // over a job row still `running`, which nothing can re-claim: fanout re-queues it but only ever claims
    // subject_type='encounter', and the drain's own drainable set without force is closed|transcribing.
    expect(await windowState("bw_a4_fail"), "the window did NOT move").toBe("transcribing");
    expect((await jobState("bw_a4_fail")).state, "and neither did the job").toBe("running");
  }, 300_000);

  it("the happy path still moves both, and the silent branch moves both too", async () => {
    const { roomWindowFinish } = await import("@/lib/stt/room-drain");
    seedWindow("bw_a4_ok", "transcribing");
    expect((await roomWindowFinish("bw_a4_ok", ACTOR, {})).ok).toBe(true);
    expect(await windowState("bw_a4_ok")).toBe("transcribed");
    expect((await jobState("bw_a4_ok")).state).toBe("done");
    expect((await jobState("bw_a4_ok")).finished_at, "and it is stamped").not.toBeNull();

    seedWindow("bw_a4_silent", "transcribing");
    await roomWindowFinish("bw_a4_silent", ACTOR, { silent_window: true });
    expect(await windowState("bw_a4_silent"), "E18's named state is preserved by the CTE").toBe("silent");
    expect((await jobState("bw_a4_silent")).state).toBe("done");
  }, 300_000);

  it("ORDER PIN (D-4): the job is finished ONLY if the window update matched — a window not in `transcribing` leaves its job alone", async () => {
    const { roomWindowFinish } = await import("@/lib/stt/room-drain");
    // The guard `AND state = 'transcribing'` is preserved verbatim, so this window does not move. Split into
    // two statements the job update was unconditional and would have said `done` over a window that never
    // finished; with the order REVERSED (job first, window conditional on it) the same thing happens. Both
    // mutants die here.
    seedWindow("bw_a4_guard", "closed");
    await roomWindowFinish("bw_a4_guard", ACTOR, {});
    expect(await windowState("bw_a4_guard"), "the guard held").toBe("closed");
    expect((await jobState("bw_a4_guard")).state, "and the job was NOT finished over it").toBe("running");
    expect((await jobState("bw_a4_guard")).finished_at).toBeNull();
  }, 300_000);
});

describe.runIf(HAVE_DOCKER)("E31 A7 — a transcript is never deleted before its replacement exists", () => {
  const CTX = { startMs: 0, endMs: 900_000, source: "primary", audioSeconds: 900 } as never;
  const P = { clip_r2_key: "clips/x.webm", decided_language: "en", activity: "speech", probe_language: "en",
    probe_seconds: 30, full_language: "en", segment_count: 4, whisper_probe_ms: 1, whisper_probe_attempts: 1,
    whisper_full_ms: 2, whisper_full_attempts: 1 } as never;
  const ASR = { original: "text", english: "text", language: "en", latencyMs: 10, costUsd: 0.01 } as never;
  const RECEIPT = { audio_r2_key: "clips/x.webm", audio_byte_start: 0, audio_byte_end: 1, audio_sha256: "abc" };
  const runsFor = async (id: string) =>
    (await pg.sql`SELECT id, transcript_original FROM transcription_run WHERE subject_id = ${id} ORDER BY id`) as Array<{ id: string; transcript_original: string }>;

  it("FAILURE INJECTED in the insert half: the PREVIOUS run survives — the window never passes through having none", async () => {
    const { writeRoutedRun } = await import("@/lib/stt/room-drain");
    seedWindow("bw_a7", "transcribing");
    pg.exec(`INSERT INTO transcription_run (id, subject_type, subject_id, engine, mode, tier, transcript_original, created_at)
             VALUES ('run_old', 'bench_window', 'bw_a7', 'sarvam', 'batch', 'asr', 'the previous transcript', NOW())`);
    armTrigger("t_a7", "transcription_run", "INSERT");
    let threw = "";
    try {
      await writeRoutedRun("bw_a7", CTX, P, ACTOR, ASR, RECEIPT, "eng_1", "sarvam", null, "en")
        .catch((e: Error) => { threw = String(e.message); });
    } finally {
      disarm("t_a7", "transcription_run");
    }
    expect(threw).toMatch(/E31 injected failure/);
    // Split into two statements, the DELETE would have committed and this would be []: the previous
    // transcript destroyed, and "no run for this window" reads as "never transcribed".
    const rows = await runsFor("bw_a7");
    expect(rows.map((r) => r.id), "the earlier state, intact").toEqual(["run_old"]);
    expect(rows[0]!.transcript_original).toBe("the previous transcript");
  }, 300_000);

  it("the happy path still REPLACES: exactly one run, and it is the new one", async () => {
    const { writeRoutedRun } = await import("@/lib/stt/room-drain");
    seedWindow("bw_a7_ok", "transcribing");
    pg.exec(`INSERT INTO transcription_run (id, subject_type, subject_id, engine, mode, tier, transcript_original, created_at)
             VALUES ('run_old_ok', 'bench_window', 'bw_a7_ok', 'sarvam', 'batch', 'asr', 'older', NOW())`);
    const id = await writeRoutedRun("bw_a7_ok", CTX, P, ACTOR, ASR, RECEIPT, "eng_1", "sarvam", null, "en");
    const rows = await runsFor("bw_a7_ok");
    expect(rows.map((r) => r.id), "one run per window: the replacement, and only it").toEqual([id]);
    expect(rows[0]!.transcript_original).toBe("text");
  }, 300_000);
});

describe.runIf(HAVE_DOCKER)("E31 D3 — SECURITY: a lockout is never reported unless the row records it", () => {
  const doctor = (id: string, count: number, status = "active") => {
    pg.exec(`INSERT INTO clinician (id, failed_pin_count, status) VALUES ('${id}', ${count}, '${status}')
             ON CONFLICT (id) DO UPDATE SET failed_pin_count = ${count}, status = '${status}', locked_until = NULL`);
    return { doctor_id: id, failed_pin_count: count, status, locked_until: null } as never;
  };
  const clinicianRow = async (id: string) =>
    ((await pg.sql`SELECT failed_pin_count, status, locked_until::text AS locked_until FROM clinician WHERE id = ${id}`) as Array<Record<string, unknown>>)[0];
  const attempts = async (id: string) =>
    ((await pg.sql`SELECT count(*)::int AS n FROM pin_attempt WHERE doctor_id = ${id}`) as Array<{ n: number }>)[0]!.n;

  it("R58 — THE CLINICIAN WRITE FAILS: the ATTEMPT ROW STILL LANDS, no lock is claimed, and the answer is not_recorded", async () => {
    const { recordFailedAttempt } = await import("@/lib/lockout");
    const d = doctor("doc_fail", 4); // the next failure would be the 5th — a 15-minute lock, if it landed
    armTrigger("t_d3", "clinician", "UPDATE");
    let decision;
    try {
      decision = await recordFailedAttempt(d, "10.0.0.1", "agent");
    } finally {
      disarm("t_d3", "clinician");
    }
    // PRD ADDENDUM 1 / D-5. The attempt row is the RATE LIMITER's evidence as well as the lockout's counter, and
    // the two readers are not in the same failure domain. Collapsed into one statement this measured 0 — the
    // limiter blinded by a clinician failure — which is the regression this test exists to stop coming back.
    expect(await attempts("doc_fail"), "the limiter's evidence survives a clinician failure").toBe(1);
    // It must still be IMPOSSIBLE to answer locked or disabled when no row changed.
    expect(decision.kind, "not a lock, and not a plain ok either: the attempt was not counted").toBe("not_recorded");
    expect(await clinicianRow("doc_fail"), "the count did not move").toMatchObject({ failed_pin_count: 4, status: "active" });
  }, 300_000);

  it("R58 — THE LIMITER STILL THROTTLES while the clinician table is failing: 12 wrong pins, then rate_limited", async () => {
    const { recordFailedAttempt, preAttemptCheck } = await import("@/lib/lockout");
    const d = doctor("doc_rate_limited", 0);
    armTrigger("t_d3_throttle", "clinician", "UPDATE");
    let decisions: string[] = [];
    try {
      for (let i = 0; i < 12; i += 1) decisions.push((await recordFailedAttempt(d, "10.0.0.2", "agent")).kind);
    } finally {
      disarm("t_d3_throttle", "clinician");
    }
    // The Refuter's measurement, both halves: 12 attempt rows, and the gate closes on the next request. The
    // one-statement shape measured 0 rows and `ok` — no throttle at all.
    expect(await attempts("doc_rate_limited"), "twelve attempts, twelve rows").toBe(12);
    expect(new Set(decisions), "every one of them refused to claim a lock it had not taken").toEqual(new Set(["not_recorded"]));
    const gate = await preAttemptCheck(d, "10.0.0.2");
    expect(gate.kind, "the 1/sec gate counts rows the clinician failure never touched").toBe("rate_limited");
  }, 300_000);

  // ── E31 R63 — ASYMMETRIC, ON PURPOSE ─────────────────────────────────────────────────────────────────────
  // An unrecorded FAILURE must not be ignored: a wrong pin whose counter write does not land is REFUSED. An
  // unrecorded SUCCESS is not punished: a correct pin whose reset does not land AUTHENTICATES, loudly. These
  // tests drive the real route against postgres, so folding the two paths back into one rule — refuse-both or
  // allow-both — turns one of them red.
  const PIN = "4821";
  const PIN_HASH = bcrypt.hashSync(PIN, 4);
  const routeDoctor = (id: string, count: number) => {
    pg.exec(`INSERT INTO clinician (id, failed_pin_count, status, full_name, url_slug, pin_hash)
             VALUES ('${id}', ${count}, 'active', 'Fixture Clinician', 'slug-${id}', '${PIN_HASH}')
             ON CONFLICT (id) DO UPDATE SET failed_pin_count = ${count}, status = 'active', locked_until = NULL`);
    return `slug-${id}`;
  };
  const callPin = async (slug: string, pin: string) => {
    const { POST } = await import("@/app/api/auth/pin/route");
    const res = await POST(new NextRequest("https://x.test/api/auth/pin", {
      method: "POST", body: JSON.stringify({ slug, pin }), headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.9" },
    }));
    return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: { code: string } } };
  };
  /** Run fn with the clinician UPDATE failing, capturing every console.error line. */
  const withClinicianWriteFailing = async <T,>(trigger: string, fn: () => Promise<T>, alsoFail?: string) => {
    const lines: string[] = [];
    const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    H.signDoctorJwt.mockClear(); H.setDoctorCookie.mockClear();
    armTrigger(trigger, "clinician", "UPDATE");
    if (alsoFail) armTrigger(`${trigger}_audit`, alsoFail, "INSERT");
    try {
      return { out: await fn(), lines };
    } finally {
      disarm(trigger, "clinician");
      if (alsoFail) disarm(`${trigger}_audit`, alsoFail);
      err.mockRestore(); warn.mockRestore();
    }
  };
  const auditRowsFor = async (id: string) =>
    ((await pg.sql`SELECT count(*)::int AS n FROM audit_log WHERE target_id = ${id} AND action = 'auth.pin_reset_not_recorded'`) as Array<{ n: number }>)[0]!.n;

  it("R63 (a) — WRONG PIN, COUNTER WRITE FAILS: the route REFUSES, claims no lock, issues no session, and logs the FAILURE line", async () => {
    const { LOG_FAILED_ATTEMPT_NOT_RECORDED, LOG_RESET_NOT_RECORDED } = await import("@/lib/lockout");
    const slug = routeDoctor("doc_r63_wrong", 4); // a recorded 5th failure would be a 15-minute lock
    const { out, lines } = await withClinicianWriteFailing("t_r63_wrong", () => callPin(slug, "0000"));
    expect(out.status, "refused as a pipeline failure — not 401 PIN_INVALID, not 423 PIN_LOCKED").toBe(500);
    expect(out.body.error?.code).toBe("PIPELINE_FAILED");
    expect((out.body.error as { message?: string })?.message, "and it is the lockout's refusal, not a lookup or bcrypt failure").toMatch(/could not be recorded/);
    expect(H.signDoctorJwt, "no session is minted for a wrong pin").not.toHaveBeenCalled();
    expect(H.setDoctorCookie).not.toHaveBeenCalled();
    expect(await clinicianRow("doc_r63_wrong"), "no lock is claimed, because none was recorded").toMatchObject({ failed_pin_count: 4, status: "active", locked_until: null });
    expect(lines.some((l) => l.includes(LOG_FAILED_ATTEMPT_NOT_RECORDED)), "the failure path logs its own line").toBe(true);
    expect(lines.some((l) => l.includes(LOG_RESET_NOT_RECORDED)), "and not the success path's").toBe(false);
  }, 300_000);

  it("R63 (a) — THE FAILED-ATTEMPT PATH STILL CANNOT CLAIM A LOCK IT DID NOT RECORD: at 29, a failing write is not `disabled`", async () => {
    const slug = routeDoctor("doc_r63_edge", 29); // in memory this is the 30th — the ORIGINAL code answered disabled
    const { out } = await withClinicianWriteFailing("t_r63_edge", () => callPin(slug, "0000"));
    expect(out.status, "not 403 FORBIDDEN").toBe(500);
    expect(out.body.error?.code).toBe("PIPELINE_FAILED");
    expect(await clinicianRow("doc_r63_edge"), "the row was never disabled").toMatchObject({ failed_pin_count: 29, status: "active", locked_until: null });
    expect(H.signDoctorJwt).not.toHaveBeenCalled();
  }, 300_000);

  it("R63 (b) — CORRECT PIN, RESET WRITE FAILS: the route AUTHENTICATES, logs the RESET line, and writes the audit row", async () => {
    const { LOG_FAILED_ATTEMPT_NOT_RECORDED, LOG_RESET_NOT_RECORDED } = await import("@/lib/lockout");
    const slug = routeDoctor("doc_r63_right", 3);
    const { out, lines } = await withClinicianWriteFailing("t_r63_right", () => callPin(slug, PIN));
    expect(out.status, "a correct pin is not a guess: the clinician gets in").toBe(200);
    expect(out.body.ok).toBe(true);
    expect(H.signDoctorJwt, "a session was minted for this clinician").toHaveBeenCalledWith({ doctor_id: "doc_r63_right", slug });
    expect(H.setDoctorCookie).toHaveBeenCalledTimes(1);
    expect(await clinicianRow("doc_r63_right"), "the cost, accepted: the counter is stale until the next reset lands").toMatchObject({ failed_pin_count: 3 });
    expect(lines.some((l) => l.includes(LOG_RESET_NOT_RECORDED)), "logged loudly, on the success path's own line").toBe(true);
    expect(lines.some((l) => l.includes(LOG_FAILED_ATTEMPT_NOT_RECORDED)), "and not on the failure path's").toBe(false);
    expect(await auditRowsFor("doc_r63_right"), "the audit path was available, so the row exists").toBe(1);
  }, 300_000);

  it("R63 (b) — CORRECT PIN, RESET WRITE FAILS AND AUDIT IS DOWN TOO: still AUTHENTICATES, and says it could not audit", async () => {
    const slug = routeDoctor("doc_r63_noaudit", 2);
    const { out, lines } = await withClinicianWriteFailing("t_r63_noaudit", () => callPin(slug, PIN), "audit_log");
    expect(out.status, "the audit row is best-effort; the login is not conditional on it").toBe(200);
    expect(H.signDoctorJwt).toHaveBeenCalledTimes(1);
    expect(await auditRowsFor("doc_r63_noaudit")).toBe(0);
    expect(lines.some((l) => l.includes('"audited":false')), "the route's line says the audit did not land").toBe(true);
  }, 300_000);

  it("R63 — recordSuccessfulAttempt: reset_not_recorded when the write fails, reset when it lands, and never a refusal", async () => {
    const { recordSuccessfulAttempt } = await import("@/lib/lockout");
    const d = doctor("doc_correct", 3);
    const { out } = await withClinicianWriteFailing("t_d3_ok", () => recordSuccessfulAttempt(d, "10.0.0.3", "agent"));
    expect(out, "the reset did not land, and the audit row did").toEqual({ kind: "reset_not_recorded", audited: true });
    expect(await clinicianRow("doc_correct"), "and the count really did not move").toMatchObject({ failed_pin_count: 3 });
    expect(await attempts("doc_correct"), "the successful attempt is still evidence for the limiter").toBe(1);

    const landed = await recordSuccessfulAttempt(doctor("doc_reset_ok", 7), null, null);
    expect(landed, "the write lands").toEqual({ kind: "reset" });
    expect(await clinicianRow("doc_reset_ok"), "and the counter is cleared").toMatchObject({ failed_pin_count: 0, locked_until: null });
  }, 300_000);

  it("R63 (c) — THE TWO PATHS ARE DISTINGUISHABLE: different log lines, and the correct-pin path is a different type", async () => {
    const lockout = await import("@/lib/lockout");
    expect(lockout.LOG_FAILED_ATTEMPT_NOT_RECORDED).not.toBe(lockout.LOG_RESET_NOT_RECORDED);
    expect(lockout.LOG_FAILED_ATTEMPT_NOT_RECORDED).toMatch(/refusing/);
    expect(lockout.LOG_RESET_NOT_RECORDED).toMatch(/allowing/);
    // Only the failure path may return the refusal kind. A ghost clinician makes the reset match zero rows.
    const ghost = { doctor_id: "doc_ghost_ok", failed_pin_count: 0, status: "active", locked_until: null } as never;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await lockout.recordSuccessfulAttempt(ghost, null, null);
    err.mockRestore();
    expect(res.kind, "zero rows on the success path is reset_not_recorded, never not_recorded").toBe("reset_not_recorded");
  }, 300_000);

  it("R58 — THE UPDATE MATCHES ZERO ROWS: not_recorded, so the caller refuses rather than guessing", async () => {
    const { recordFailedAttempt } = await import("@/lib/lockout");
    // A clinician id that does not exist. In memory this attempt looks like the 30th, which the ORIGINAL code
    // answered {kind:"disabled"} for, from a count it had computed itself — a lock claimed over a row that was
    // never touched. Nothing was counted here either, so the honest answer is that it was not recorded.
    const ghost = { doctor_id: "doc_ghost", failed_pin_count: 29, status: "active", locked_until: null } as never;
    const decision = await recordFailedAttempt(ghost, "10.0.0.1", "agent");
    expect(decision.kind, "no row moved: not a lock, and not a silent pass either").toBe("not_recorded");
    expect(await attempts("doc_ghost"), "the attempt itself is still recorded for the limiter").toBe(1);
  }, 300_000);

  it("THE IN-MEMORY COUNT IS STALE: the answer is the ROW's, not the one this process was carrying", async () => {
    const { recordFailedAttempt } = await import("@/lib/lockout");
    // The caller read this clinician a while ago and believes the next failure is the 30th. The row says
    // otherwise — someone reset it, or the read was simply old. A decision computed from the number in this
    // process would disable an account the database has no reason to disable.
    doctor("doc_stale", 0);
    const stale = { doctor_id: "doc_stale", failed_pin_count: 29, status: "active", locked_until: null } as never;
    const decision = await recordFailedAttempt(stale, null, null);
    expect(decision.kind, "the row counted 1, so nothing is locked").toBe("ok");
    expect(await clinicianRow("doc_stale"), "and the row moved by exactly one, from its OWN value").toMatchObject({ failed_pin_count: 1, status: "active" });
  }, 300_000);

  it("THE WRITE LANDS: the decision is the row's — 15-minute lock at 5, and disabled at 30", async () => {
    const { recordFailedAttempt } = await import("@/lib/lockout");
    const d5 = await recordFailedAttempt(doctor("doc_five", 4), null, null);
    expect(d5.kind).toBe("locked");
    if (d5.kind === "locked") {
      expect(d5.retry_after_seconds, "read off locked_until, not off a constant in this process").toBeGreaterThan(60 * 14);
      expect(d5.retry_after_seconds).toBeLessThanOrEqual(60 * 15);
      expect(d5.reason).toMatch(/15 min/);
    }
    expect(await clinicianRow("doc_five"), "and the row says the same thing").toMatchObject({ failed_pin_count: 5 });
    expect(await attempts("doc_five"), "the attempt is recorded in the same statement").toBe(1);

    const d30 = await recordFailedAttempt(doctor("doc_thirty", 29), null, null);
    expect(d30.kind, "at 30 the account is locked, which this API calls disabled").toBe("disabled");
    expect(await clinicianRow("doc_thirty")).toMatchObject({ failed_pin_count: 30, status: "locked" });

    const d1 = await recordFailedAttempt(doctor("doc_one", 0), null, null);
    expect(d1.kind, "below the first threshold the attempt merely fails").toBe("ok");
    expect(await clinicianRow("doc_one")).toMatchObject({ failed_pin_count: 1, status: "active" });
  }, 300_000);
});

describe.runIf(HAVE_DOCKER)("E31 D1 — AUDIT: `audited` means the audit row exists", () => {
  const input = (visitId: string) => ({
    visitId, roomDayId: "rd_1", actorType: "system" as const, actorId: "mcp",
    before: { clinician_id: null, clinician_source: null, clinician_confidence: null },
    after: { clinician_id: "doc_x", clinician_source: "operator", clinician_confidence: 0.95 },
    visitState: "closed", note: "a late correction",
  });
  const auditRows = async (visitId: string) =>
    ((await pg.sql`SELECT count(*)::int AS n FROM audit_log WHERE target_id = ${visitId}`) as Array<{ n: number }>)[0]!.n;

  it("THE INSERT FAILS: it reports failed, never audited — and the console.warn is no longer the only evidence", async () => {
    const { auditVisitClinicianChange } = await import("@/lib/brain/fuse/visit-update");
    const intent: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { intent.push(String(a[0])); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    armTrigger("t_d1", "audit_log", "INSERT");
    let outcome;
    try {
      outcome = await auditVisitClinicianChange(input("visit_fail"));
    } finally {
      disarm("t_d1", "audit_log"); log.mockRestore(); warn.mockRestore();
    }
    expect(outcome, "it says what happened, and it did not throw").toMatchObject({ audited: false, audit: "failed" });
    expect(await auditRows("visit_fail"), "there is no row, which is exactly what it reported").toBe(0);
    // D-3: intent before the act, so a crash mid-write is still legible from the log alone.
    expect(intent.some((l) => l.includes("audit intended")), "intent was written BEFORE the attempt").toBe(true);
  }, 300_000);

  it("THE INSERT REPORTS SUCCESS AND RETURNS NOTHING: that is not an audit row either", async () => {
    const { auditVisitClinicianChange } = await import("@/lib/brain/fuse/visit-update");
    // The R54 anomaly class, here: a driver or proxy that answers a successful INSERT with no rows. RETURNING
    // id always yields one from Postgres, so this is induced at the driver boundary — what is under test is
    // that "no row came back" is not allowed to read as audited.
    const real = H.sql!;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    H.sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.join("?").includes("INSERT INTO audit_log") ? Promise.resolve([]) : real(strings, ...values)) as typeof real;
    let outcome;
    try {
      outcome = await auditVisitClinicianChange(input("visit_norow"));
    } finally {
      H.sql = real; log.mockRestore(); warn.mockRestore();
    }
    expect(outcome, "no row, so not audited — and it says why").toMatchObject({ audited: false, audit: "failed", error: "insert_returned_no_row" });
  }, 300_000);

  it("R59 — a row whose id is FALSY is still a row, and a MISSING row is still not audited", async () => {
    const { auditVisitClinicianChange } = await import("@/lib/brain/fuse/visit-update");
    const real = H.sql!;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The guard asks whether a ROW came back, not whether a field looks truthy. A driver that answers with
    // {id: 0} — or {id: ""} — has written a row, and calling that "failed" would be as wrong as the reverse.
    // Postgres cannot produce it from a bigserial today; the guard exists for the driver class that answers
    // oddly, which is the same class R54 was about.
    H.sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.join("?").includes("INSERT INTO audit_log") ? Promise.resolve([{ id: 0 }]) : real(strings, ...values)) as typeof real;
    let zero;
    try { zero = await auditVisitClinicianChange(input("visit_zero")); } finally { H.sql = real; }
    expect(zero, "a row came back, so it is audited").toMatchObject({ audited: true, audit: "written", audit_id: "0" });
    log.mockRestore(); warn.mockRestore();
  }, 300_000);

  it("R59 — the intent line names the visit, never the clinician ids or the operator's note", async () => {
    const { auditVisitClinicianChange } = await import("@/lib/brain/fuse/visit-update");
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    await auditVisitClinicianChange({ ...input("visit_quiet"), note: "the operator's own words" });
    log.mockRestore();
    const intent = lines.find((l) => l.includes("audit intended"))!;
    expect(intent, "it says WHICH visit, and that a post-close change was attempted").toContain("visit_quiet");
    expect(intent, "and not who").not.toContain("doc_x");
    expect(intent, "and not the note").not.toContain("the operator's own words");
    // What audit_log holds is unchanged: the row still carries everything.
    const row = ((await pg.sql`SELECT metadata_json FROM audit_log WHERE target_id = 'visit_quiet'`) as Array<{ metadata_json: Record<string, unknown> }>)[0]!;
    expect(JSON.stringify(row.metadata_json), "the audit row still records the payload in full").toContain("doc_x");
    expect(JSON.stringify(row.metadata_json)).toContain("the operator's own words");
  }, 300_000);

  it("THE INSERT LANDS: audited, with the id of the row that exists", async () => {
    const { auditVisitClinicianChange } = await import("@/lib/brain/fuse/visit-update");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const outcome = await auditVisitClinicianChange(input("visit_ok"));
    log.mockRestore();
    expect(outcome).toMatchObject({ audited: true, audit: "written" });
    expect(await auditRows("visit_ok")).toBe(1);
  }, 300_000);

  it("the tool reports the WRITER's outcome, not the state it computed: `audited` is never derived from post_close", async () => {
    // fuse.ts:290 used `audited: postClose` — true whenever the change was post-close, including when the
    // audit insert had just failed. The source is asserted here because driving the tool needs the brain pool;
    // the behaviour it maps to is proven by the two tests above.
    const src = readFileSync("lib/mcp/tools/fuse.ts", "utf8");
    expect(src, "the boolean is no longer computed from state").not.toMatch(/audited:\s*postClose/);
    expect(src, "it carries the writer's own answer").toMatch(/audited:\s*audit === "written"/);
    expect(src, "and the three-way outcome is reported beside it").toMatch(/audit,/);
  });
});
