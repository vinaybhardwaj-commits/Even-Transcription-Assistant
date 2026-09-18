/**
 * E32 — NEVER ISSUE A SESSION WHILE NEITHER THE LOCKOUT COUNTER NOR THE RATE LIMITER IS RECORDING.
 * Against a real postgres:16, through the real POST /api/auth/pin.
 *
 * THE DEFECT (the E31 batch 1 final refutation, §3 T1, measured): under a database that refuses writes but serves
 * reads, 80 wrong pins were each refused, NONE was counted, and the correct pin then issued a session. Nothing
 * bounded the walk through 10,000 pins. It was present identically at 64ce357; E31 did not introduce it.
 *
 * THE RULE HAS THREE STATES AND THIS FILE PINS ALL THREE, because each wrong fold is a known bug:
 *   BOTH recording        → normal.
 *   EXACTLY ONE recording → ALLOW   (refusing re-creates lockout-during-degradation, R63)
 *   NEITHER recording     → REFUSE, even the correct pin   (allowing re-opens the brute force)
 *
 * Failure is injected by the database, never by mocking the driver: a trigger that RAISES (a write that throws), a
 * trigger that RETURNS NULL (a write that "succeeds" with zero rows), and — for T1 itself — the whole database
 * switched to default_transaction_read_only, which is what a read-only failover or a storage quota looks like.
 * Only signDoctorJwt and setDoctorCookie are stubbed, as spies, so a test can ask whether a session was issued.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({
  sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>),
  signDoctorJwt: vi.fn(async (_c: { doctor_id: string; slug: string }) => "jwt.fixture"),
  setDoctorCookie: vi.fn(async (_jwt: string, _slug: string) => {}),
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), signDoctorJwt: H.signDoctorJwt }));
vi.mock("@/lib/cookie", () => ({ setDoctorCookie: H.setDoctorCookie }));

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-e32-pin-bound");

describe("REQUIRED PROOF — E32 runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/e32-pin-bound.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  // The three tables the login writes, in the shape tests/unit/e31b-atomicity.test.ts uses for D3.
  pg.exec(`
    CREATE TABLE clinician (
      id text PRIMARY KEY, failed_pin_count int NOT NULL DEFAULT 0, locked_until timestamptz,
      status text NOT NULL DEFAULT 'active', updated_at timestamptz, last_active_at timestamptz,
      full_name text, url_slug text, pin_hash text, deleted_at timestamptz);
    CREATE TABLE pin_attempt (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doctor_id text NOT NULL, success boolean NOT NULL, ip inet,
      user_agent text, created_at timestamptz NOT NULL DEFAULT NOW());
    CREATE TABLE audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_type text, actor_id text, action text, target_type text,
      target_id text, metadata_json jsonb, created_at timestamptz NOT NULL DEFAULT NOW());
  `);
  H.sql = pg.sql;
}, 240_000);
afterAll(() => {
  if (!HAVE_DOCKER) return;
  readOnly(false);
  pg.stop();
});

// ── injection ───────────────────────────────────────────────────────────────────────────────────────────────
/** The write THROWS. */
const armRaise = (table: string, event: string) => pg.exec(`
  CREATE OR REPLACE FUNCTION e32_raise_${table}() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'E32 injected failure on ${table} ${event}'; END $$;
  DROP TRIGGER IF EXISTS e32_${table} ON ${table};
  CREATE TRIGGER e32_${table} BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION e32_raise_${table}();
`);
/** The write "SUCCEEDS" AND LANDS NOTHING: a BEFORE trigger returning NULL skips the row, so RETURNING is empty. */
const armSilent = (table: string, event: string) => pg.exec(`
  CREATE OR REPLACE FUNCTION e32_silent_${table}() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RETURN NULL; END $$;
  DROP TRIGGER IF EXISTS e32_${table} ON ${table};
  CREATE TRIGGER e32_${table} BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION e32_silent_${table}();
`);
const disarm = (...tables: string[]) => pg.exec(tables.map((t) => `DROP TRIGGER IF EXISTS e32_${t} ON ${t};`).join("\n"));
/** T1's database: every new session is read-only. Reads work — so the pin comparison works. No write lands. */
function readOnly(on: boolean) {
  if (on) pg.exec(`ALTER DATABASE postgres SET default_transaction_read_only = on;`);
  else pg.exec(`SET default_transaction_read_only = off; ALTER DATABASE postgres RESET default_transaction_read_only;`);
}

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────
const PIN = "4821";
const WRONG = "0000";
const PIN_HASH = bcrypt.hashSync(PIN, 4);
const routeDoctor = (id: string, count: number) => {
  pg.exec(`INSERT INTO clinician (id, failed_pin_count, status, full_name, url_slug, pin_hash)
           VALUES ('${id}', ${count}, 'active', 'Fixture Clinician', 'slug-${id}', '${PIN_HASH}')`);
  return `slug-${id}`;
};
const callPin = async (slug: string, pin: string) => {
  const { POST } = await import("@/app/api/auth/pin/route");
  const res = await POST(new NextRequest("https://x.test/api/auth/pin", {
    method: "POST", body: JSON.stringify({ slug, pin }), headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.9" },
  }));
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as { ok?: boolean; error?: { code: string; message?: string; attempts_remaining?: number } } };
};
/** Run fn with every console.error / console.warn line captured, and the session spies cleared. */
const captured = async <T,>(fn: () => Promise<T>) => {
  const lines: string[] = [];
  const push = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  const err = vi.spyOn(console, "error").mockImplementation(push);
  const warn = vi.spyOn(console, "warn").mockImplementation(push);
  H.signDoctorJwt.mockClear(); H.setDoctorCookie.mockClear();
  try {
    return { out: await fn(), lines };
  } finally {
    err.mockRestore(); warn.mockRestore();
  }
};
const clinicianRow = async (id: string) =>
  ((await pg.sql`SELECT failed_pin_count, status, locked_until::text AS locked_until FROM clinician WHERE id = ${id}`) as Array<Record<string, unknown>>)[0];
const attempts = async (id: string) =>
  ((await pg.sql`SELECT count(*)::int AS n FROM pin_attempt WHERE doctor_id = ${id}`) as Array<{ n: number }>)[0]!.n;
const auditRows = async (id: string) =>
  (await pg.sql`SELECT actor_type, actor_id, action, target_type, target_id, metadata_json FROM audit_log WHERE target_id = ${id} ORDER BY created_at`) as Array<Record<string, unknown>>;
const has = (lines: string[], needle: string) => lines.some((l) => l.includes(needle));

describe.runIf(HAVE_DOCKER)("E32 — no session while no brute-force bound is recording", () => {
  // ═══ 1. NEITHER RECORDING ═══════════════════════════════════════════════════════════════════════════════
  it("1 — BOTH RECORDERS THROW, CORRECT PIN: no session, the refusal is named, and the reason is legible in the log and the audit row", async () => {
    const L = await import("@/lib/lockout");
    const slug = routeDoctor("doc_e32_neither", 3);
    armRaise("clinician", "UPDATE");
    armRaise("pin_attempt", "INSERT");
    let right, wrong;
    try {
      right = await captured(() => callPin(slug, PIN));
      wrong = await captured(() => callPin(slug, WRONG));
    } finally {
      disarm("clinician", "pin_attempt");
    }
    expect(right.out.status, "the correct pin is REFUSED: nothing is recording, so nothing bounded the guesses before it").toBe(500);
    expect(right.out.body.error?.code).toBe("PIPELINE_FAILED");
    expect(H.signDoctorJwt, "no session").not.toHaveBeenCalled();
    expect(H.setDoctorCookie).not.toHaveBeenCalled();
    expect(has(right.lines, L.LOG_NO_BOUND_RECORDING), "named on its own line").toBe(true);
    expect(has(right.lines, L.LOG_RESET_NOT_RECORDED), "not on R63's allowing line").toBe(false);
    expect(has(right.lines, L.LOG_ATTEMPT_ROW_NOT_RECORDED), "nor on the limiter-only allowing line").toBe(false);
    expect(right.lines.some((l) => l.includes("session issued")), "and the route never says it issued one").toBe(false);
    // The reason, for the operator: audit_log was still writable here, so the row exists — and it is the E32
    // row, not R63's reset row. Closed codes and a count; no pin, no name, no slug, no error text.
    // E32b: the wrong pin that follows now writes its own row too — the two refusals attempt the same writes.
    expect(await auditRows("doc_e32_neither")).toEqual([{
      actor_type: "system", actor_id: "auth:pin-lockout-v1", action: "auth.pin_session_refused_no_bound",
      target_type: "doctor", target_id: "doc_e32_neither",
      metadata_json: { attempt_reason: "threw", reset_reason: "threw", stale_failed_pin_count: 3 },
    }, {
      actor_type: "system", actor_id: "auth:pin-lockout-v1", action: "auth.pin_attempt_refused_unrecorded",
      target_type: "doctor", target_id: "doc_e32_neither",
      metadata_json: { reason: "threw", stale_failed_pin_count: 3 },
    }]);
    // NO ORACLE. The same doctor's WRONG pin under the same fault gets the IDENTICAL response. If the correct pin's
    // refusal differed in any byte, the refusal would reveal the pin to an attacker who then waits out the fault.
    expect(wrong.out.status).toBe(right.out.status);
    expect(wrong.out.text, "byte-identical to the wrong-pin refusal").toBe(right.out.text);
  }, 300_000);

  it("1 — T1 REPLAYED: a READ-ONLY database, 30 wrong pins then the correct one — every answer identical, and never a session", async () => {
    const L = await import("@/lib/lockout");
    const slug = routeDoctor("doc_e32_t1", 0);
    const answers: string[] = [];
    let right;
    readOnly(true);
    try {
      const wrongRun = await captured(async () => {
        for (let i = 0; i < 30; i += 1) {
          const r = await callPin(slug, String(1000 + i));
          answers.push(`${r.status}:${r.text}`);
        }
      });
      expect(H.signDoctorJwt).not.toHaveBeenCalled();
      expect(wrongRun.lines.filter((l) => l.includes(L.LOG_FAILED_ATTEMPT_NOT_RECORDED)).length, "every wrong pin was refused as unrecorded").toBe(30);
      right = await captured(() => callPin(slug, PIN));
    } finally {
      readOnly(false);
    }
    expect(new Set(answers).size, "the thirty wrong pins got one answer").toBe(1);
    expect(`${right.out.status}:${right.out.text}`, "and the correct pin got the same one").toBe(answers[0]);
    expect(H.signDoctorJwt, "THE DEFECT: this was 1 at 64ce357 and at c8ffc12").not.toHaveBeenCalled();
    expect(H.setDoctorCookie).not.toHaveBeenCalled();
    expect(has(right.lines, L.LOG_NO_BOUND_RECORDING)).toBe(true);
    expect(await clinicianRow("doc_e32_t1"), "nothing was recorded, and no lock was claimed").toMatchObject({ failed_pin_count: 0, status: "active", locked_until: null });
    expect(await attempts("doc_e32_t1")).toBe(0);
    expect(await auditRows("doc_e32_t1"), "audit_log refused too, so the log line is the evidence").toEqual([]);

    // And the refusal is about RECORDING, not the pin: writes back, the same correct pin gets in.
    const back = await captured(() => callPin(slug, PIN));
    expect(back.out.status).toBe(200);
    expect(H.signDoctorJwt).toHaveBeenCalledTimes(1);
  }, 300_000);

  it("1 — BOTH RECORDERS LAND NOTHING WITHOUT THROWING (zero rows): still no session — a write has landed only if its row comes back", async () => {
    const L = await import("@/lib/lockout");
    const slug = routeDoctor("doc_e32_silent", 2);
    armSilent("clinician", "UPDATE");
    armSilent("pin_attempt", "INSERT");
    let right;
    try {
      right = await captured(() => callPin(slug, PIN));
    } finally {
      disarm("clinician", "pin_attempt");
    }
    expect(right.out.status).toBe(500);
    expect(H.signDoctorJwt).not.toHaveBeenCalled();
    expect(has(right.lines, L.LOG_NO_BOUND_RECORDING)).toBe(true);
    expect(await attempts("doc_e32_silent"), "the row really did not land").toBe(0);
    expect((await auditRows("doc_e32_silent"))[0]?.metadata_json).toEqual({ attempt_reason: "zero_rows", reset_reason: "zero_rows", stale_failed_pin_count: 2 });
  }, 300_000);

  // ═══ 2 and 3. EXACTLY ONE RECORDING — R63 PRESERVED ═══════════════════════════════════════════════════════
  it("2 — ONLY THE LOCKOUT COUNTER FAILS, CORRECT PIN: the session IS issued; the limiter recorded the attempt", async () => {
    const L = await import("@/lib/lockout");
    const slug = routeDoctor("doc_e32_counter_down", 3);
    armRaise("clinician", "UPDATE");
    let right;
    try {
      right = await captured(() => callPin(slug, PIN));
    } finally {
      disarm("clinician");
    }
    expect(right.out.status, "a partial fault must not lock a clinician out").toBe(200);
    expect(right.out.body.ok).toBe(true);
    expect(H.signDoctorJwt).toHaveBeenCalledWith({ doctor_id: "doc_e32_counter_down", slug });
    expect(H.setDoctorCookie).toHaveBeenCalledTimes(1);
    expect(await attempts("doc_e32_counter_down"), "the surviving bound recorded it").toBe(1);
    expect(has(right.lines, L.LOG_RESET_NOT_RECORDED), "R63's line").toBe(true);
    expect(has(right.lines, L.LOG_NO_BOUND_RECORDING), "not E32's refusal").toBe(false);
    expect((await auditRows("doc_e32_counter_down")).map((r) => r.action), "R63's audit row, not E32's").toEqual(["auth.pin_reset_write_failed"]);
  }, 300_000);

  it("3 — ONLY pin_attempt FAILS, CORRECT PIN: the session IS issued; the counter reset landed", async () => {
    const L = await import("@/lib/lockout");
    const slug = routeDoctor("doc_e32_limiter_down", 3);
    armRaise("pin_attempt", "INSERT");
    let right;
    try {
      right = await captured(() => callPin(slug, PIN));
    } finally {
      disarm("pin_attempt");
    }
    expect(right.out.status, "a partial fault must not lock a clinician out").toBe(200);
    expect(H.signDoctorJwt).toHaveBeenCalledWith({ doctor_id: "doc_e32_limiter_down", slug });
    expect(await clinicianRow("doc_e32_limiter_down"), "the surviving bound recorded it").toMatchObject({ failed_pin_count: 0 });
    expect(await attempts("doc_e32_limiter_down")).toBe(0);
    expect(has(right.lines, L.LOG_ATTEMPT_ROW_NOT_RECORDED), "its own allowing line").toBe(true);
    expect(has(right.lines, L.LOG_NO_BOUND_RECORDING)).toBe(false);
    expect(has(right.lines, L.LOG_RESET_NOT_RECORDED), "and not the counter's").toBe(false);
  }, 300_000);

  it("3 — ONLY pin_attempt LANDS NOTHING (zero rows, no throw), CORRECT PIN: still issued", async () => {
    const slug = routeDoctor("doc_e32_limiter_silent", 1);
    armSilent("pin_attempt", "INSERT");
    let right;
    try {
      right = await captured(() => callPin(slug, PIN));
    } finally {
      disarm("pin_attempt");
    }
    expect(right.out.status).toBe(200);
    expect(H.signDoctorJwt).toHaveBeenCalledTimes(1);
  }, 300_000);

  // ═══ 4. NEITHER RECORDING, WRONG PIN — R58/R63 UNCHANGED ═══════════════════════════════════════════════════
  it("4 — BOTH RECORDERS FAIL, WRONG PIN: refused, no session, and no lock claimed that was not recorded — at 4 and at 29", async () => {
    const L = await import("@/lib/lockout");
    const at4 = routeDoctor("doc_e32_wrong4", 4);   // a recorded 5th failure would be a 15-minute lock
    const at29 = routeDoctor("doc_e32_wrong29", 29); // a recorded 30th would disable the account
    armRaise("clinician", "UPDATE");
    armRaise("pin_attempt", "INSERT");
    let r4, r29;
    try {
      r4 = await captured(() => callPin(at4, WRONG));
      r29 = await captured(() => callPin(at29, WRONG));
    } finally {
      disarm("clinician", "pin_attempt");
    }
    for (const r of [r4, r29]) {
      expect(r.out.status, "not 401, not 423, not 403").toBe(500);
      expect(r.out.body.error?.code).toBe("PIPELINE_FAILED");
      expect(has(r.lines, L.LOG_FAILED_ATTEMPT_NOT_RECORDED)).toBe(true);
    }
    expect(H.signDoctorJwt).not.toHaveBeenCalled();
    expect(await clinicianRow("doc_e32_wrong4")).toMatchObject({ failed_pin_count: 4, status: "active", locked_until: null });
    expect(await clinicianRow("doc_e32_wrong29")).toMatchObject({ failed_pin_count: 29, status: "active", locked_until: null });
  }, 300_000);

  // ═══ 5. NORMAL OPERATION — UNCHANGED ═══════════════════════════════════════════════════════════════════════
  it("5 — NOTHING FAILS: the correct pin is issued and resets; a wrong pin is PIN_INVALID and counts; the 5th locks", async () => {
    const right = await captured(() => callPin(routeDoctor("doc_e32_ok", 3), PIN));
    expect(right.out.status).toBe(200);
    expect(right.out.body.ok).toBe(true);
    expect(H.signDoctorJwt).toHaveBeenCalledTimes(1);
    expect(H.setDoctorCookie).toHaveBeenCalledTimes(1);
    expect(await clinicianRow("doc_e32_ok")).toMatchObject({ failed_pin_count: 0, locked_until: null });
    expect(await attempts("doc_e32_ok")).toBe(1);
    expect(await auditRows("doc_e32_ok"), "no audit row when nothing failed").toEqual([]);
    expect(right.lines, "and not one warning").toEqual([]);

    const wrong = await captured(() => callPin(routeDoctor("doc_e32_ok_wrong", 0), WRONG));
    expect(wrong.out.status).toBe(401);
    expect(wrong.out.body.error).toEqual({ code: "PIN_INVALID", message: "Incorrect PIN", attempts_remaining: 4 });
    expect(await clinicianRow("doc_e32_ok_wrong")).toMatchObject({ failed_pin_count: 1 });
    expect(H.signDoctorJwt).not.toHaveBeenCalled();
    expect(wrong.lines).toEqual([]);

    const fifth = await captured(() => callPin(routeDoctor("doc_e32_ok_fifth", 4), WRONG));
    expect(fifth.out.status).toBe(423);
    expect(fifth.out.body.error?.code).toBe("PIN_LOCKED");
  }, 300_000);

  // ═══ THE THREE STATES, IN CODE ═════════════════════════════════════════════════════════════════════════════
  it("THE THREE STATES ARE DISTINCT IN CODE AND IN LOGS: four outcomes of recordSuccessfulAttempt, three log lines", async () => {
    const L = await import("@/lib/lockout");
    const d = (id: string) => {
      pg.exec(`INSERT INTO clinician (id, failed_pin_count) VALUES ('${id}', 2)`);
      return { doctor_id: id, url_slug: `slug-${id}`, failed_pin_count: 2, status: "active", locked_until: null } as const;
    };
    const run = async (id: string, fail: string[]) => {
      for (const t of fail) armRaise(t, t === "clinician" ? "UPDATE" : "INSERT");
      try {
        return (await captured(() => L.recordSuccessfulAttempt(d(id), null, null))).out;
      } finally {
        if (fail.length) disarm(...fail);
      }
    };
    expect(await run("doc_e32_k_both", [])).toEqual({ kind: "reset" });
    expect(await run("doc_e32_k_counter", ["clinician"])).toEqual({ kind: "reset_not_recorded", audited: true });
    expect(await run("doc_e32_k_limiter", ["pin_attempt"])).toEqual({ kind: "attempt_not_recorded" });
    expect(await run("doc_e32_k_neither", ["clinician", "pin_attempt"])).toEqual({ kind: "no_bound_recording", audited: true });
    expect(await run("doc_e32_k_nothing", ["clinician", "pin_attempt", "audit_log"])).toEqual({ kind: "no_bound_recording", audited: false });
    // `audited` is the row's, not the call's: an audit INSERT that returns without landing a row is not audited.
    armSilent("audit_log", "INSERT");
    try {
      expect(await run("doc_e32_k_silent_audit", ["clinician", "pin_attempt"])).toEqual({ kind: "no_bound_recording", audited: false });
    } finally {
      disarm("audit_log");
    }

    const lines = [L.LOG_FAILED_ATTEMPT_NOT_RECORDED, L.LOG_RESET_NOT_RECORDED, L.LOG_ATTEMPT_ROW_NOT_RECORDED, L.LOG_NO_BOUND_RECORDING];
    expect(new Set(lines).size, "four distinct lines: one for the failure path, three for the success path").toBe(4);
    expect(L.LOG_NO_BOUND_RECORDING).toMatch(/refusing the session/);
    expect(L.LOG_RESET_NOT_RECORDED).toMatch(/allowing/);
    expect(L.LOG_ATTEMPT_ROW_NOT_RECORDED).toMatch(/allowing/);
    expect(L.AUDIT_PIN_SESSION_REFUSED_NO_BOUND).not.toBe(L.AUDIT_PIN_RESET_WRITE_FAILED);
  }, 300_000);
});
