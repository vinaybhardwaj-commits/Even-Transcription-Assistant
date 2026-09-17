/**
 * E32b — THE TWO REFUSALS ARE SYMMETRIC. Against a real postgres:16, through the real POST /api/auth/pin.
 *
 * THE DEFECT: under a total write failure the wrong pin and the correct pin get one byte-identical refusal, but
 * they did not do the same WORK. The wrong pin (not_recorded) attempted two writes — pin_attempt, clinician — and
 * the correct pin (no_bound_recording) three, the third being its audit row. The right guess was the one that took
 * a database round trip longer. A refusal that takes longer for the right pin announces the right pin.
 *
 * THE CURE IS SYMMETRY, NOT DELETION: the wrong-pin refusal attempts its own audit row
 * (auth.pin_attempt_refused_unrecorded), on BOTH of its exits — the UPDATE that throws and the UPDATE that matches
 * no row. The correct-pin audit row stays.
 *
 * ROUND TRIPS ARE COUNTED TWICE, and neither count is a reading of the source:
 *   1. at the driver boundary — every call the app makes into `sql`, each of which is one psql session;
 *   2. by the server — log_statement = 'all' on this suite's own container, and the PREPAREd statements between
 *      two marker statements are read back out of the postgres log.
 * Failure is injected by the database (triggers that RAISE, triggers that RETURN NULL, a read-only database).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { execFileSync } from "node:child_process";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({
  sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>),
  /** When set, every statement the APP sends is appended here, as its text. */
  sent: null as null | string[],
  signDoctorJwt: vi.fn(async (_c: { doctor_id: string; slug: string }) => "jwt.fixture"),
  setDoctorCookie: vi.fn(async (_jwt: string, _slug: string) => {}),
}));
vi.mock("@/lib/db", () => ({
  sql: (s: TemplateStringsArray, ...v: unknown[]) => {
    H.sent?.push(s.join("$"));
    return H.sql!(s, ...v);
  },
}));
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), signDoctorJwt: H.signDoctorJwt }));
vi.mock("@/lib/cookie", () => ({ setDoctorCookie: H.setDoctorCookie }));

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-e32b-refusal-symmetry");

describe("REQUIRED PROOF — E32b runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/e32b-refusal-symmetry.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
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
  // The server's own record of every statement it receives. This container is this suite's alone.
  pg.exec(`ALTER SYSTEM SET log_statement = 'all';`);
  pg.exec(`SELECT pg_reload_conf();`);
  H.sql = pg.sql;
}, 240_000);
afterAll(() => {
  if (!HAVE_DOCKER) return;
  readOnly(false);
  pg.stop();
});

// ── injection ───────────────────────────────────────────────────────────────────────────────────────────────
const EVENT: Record<string, string> = { clinician: "UPDATE", pin_attempt: "INSERT", audit_log: "INSERT" };
/** The write THROWS. */
const armRaise = (...tables: string[]) => pg.exec(tables.map((t) => `
  CREATE OR REPLACE FUNCTION e32b_raise_${t}() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'E32b injected failure on ${t}'; END $$;
  DROP TRIGGER IF EXISTS e32b_${t} ON ${t};
  CREATE TRIGGER e32b_${t} BEFORE ${EVENT[t]} ON ${t} FOR EACH ROW EXECUTE FUNCTION e32b_raise_${t}();`).join("\n"));
/** The write "SUCCEEDS" AND LANDS NOTHING: RETURNING comes back empty. */
const armSilent = (...tables: string[]) => pg.exec(tables.map((t) => `
  CREATE OR REPLACE FUNCTION e32b_silent_${t}() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RETURN NULL; END $$;
  DROP TRIGGER IF EXISTS e32b_${t} ON ${t};
  CREATE TRIGGER e32b_${t} BEFORE ${EVENT[t]} ON ${t} FOR EACH ROW EXECUTE FUNCTION e32b_silent_${t}();`).join("\n"));
const disarm = () => pg.exec(Object.keys(EVENT).map((t) => `DROP TRIGGER IF EXISTS e32b_${t} ON ${t};`).join("\n"));
function readOnly(on: boolean) {
  if (on) pg.exec(`ALTER DATABASE postgres SET default_transaction_read_only = on;`);
  else pg.exec(`SET default_transaction_read_only = off; ALTER DATABASE postgres RESET default_transaction_read_only;`);
}

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────
// Distinctive values, so a leak of any of them into audit metadata is a substring match.
const PIN = "4821";
const WRONG = "7395";
const NAME = "Fixture Clinician Zeta";
const PIN_HASH = bcrypt.hashSync(PIN, 4);
const slugOf = (id: string) => `slug-${id}-q7x2`;
const routeDoctor = (id: string, count: number) => {
  pg.exec(`INSERT INTO clinician (id, failed_pin_count, status, full_name, url_slug, pin_hash)
           VALUES ('${id}', ${count}, 'active', '${NAME}', '${slugOf(id)}', '${PIN_HASH}')`);
  return slugOf(id);
};
const lockState = (id: string, count: number) =>
  ({ doctor_id: id, url_slug: slugOf(id), failed_pin_count: count, status: "active", locked_until: null }) as const;

/** The FULL response, serialized: status, status text, every header, the body bytes. */
const callPin = async (slug: string, pin: string) => {
  const { POST } = await import("@/app/api/auth/pin/route");
  const res = await POST(new NextRequest("https://x.test/api/auth/pin", {
    method: "POST", body: JSON.stringify({ slug, pin }), headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.9" },
  }));
  const text = await res.text();
  const headers = [...res.headers.entries()].sort(([a], [b]) => a.localeCompare(b));
  return { status: res.status, text, full: JSON.stringify({ status: res.status, statusText: res.statusText, headers, body: text }) };
};
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
const auditRows = async (id: string) =>
  (await pg.sql`SELECT actor_type, actor_id, action, target_type, target_id, metadata_json, metadata_json::text AS raw
                  FROM audit_log WHERE target_id = ${id} ORDER BY created_at`) as Array<Record<string, unknown>>;

// ── round-trip counting ─────────────────────────────────────────────────────────────────────────────────────
/** A statement's verb and table, from its text: "INSERT pin_attempt", "UPDATE clinician", or "SELECT". */
const classify = (text: string) => {
  const w = /\b(INSERT INTO|UPDATE)\s+(\w+)/i.exec(text);
  return w ? `${w[1]!.toUpperCase().startsWith("INSERT") ? "INSERT" : "UPDATE"} ${w[2]}` : "SELECT";
};
const serverLog = () => execFileSync("sh", ["-c", `docker logs ${pg.name} 2>&1`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
let markSeq = 0;
/** Run fn and return what the DRIVER sent and what the SERVER logged receiving, both classified in order. */
const roundTrips = async <T,>(fn: () => Promise<T>) => {
  const tag = `e32b_mark_${process.pid}_${(markSeq += 1)}`;
  pg.exec(`SELECT '${tag}_begin';`);
  const sent: string[] = [];
  H.sent = sent;
  let out: T;
  try {
    out = await fn();
  } finally {
    H.sent = null;
  }
  pg.exec(`SELECT '${tag}_end';`);
  let log = "";
  for (const deadline = Date.now() + 10_000; ;) {
    log = serverLog();
    if (log.includes(`${tag}_end'`)) break;
    if (Date.now() > deadline) throw new Error(`the server log never showed ${tag}_end`);
    execFileSync("sleep", ["0.2"]);
  }
  const window = log.slice(log.indexOf(`${tag}_begin'`), log.indexOf(`${tag}_end'`));
  const server = window.split("\n")
    .map((l) => /LOG:\s+statement: PREPARE __s AS (.*)$/.exec(l)?.[1])
    .filter((l): l is string => l !== undefined)
    .map(classify);
  return { out, driver: sent.map(classify), server };
};
const writesOf = (xs: string[]) => xs.filter((x) => x !== "SELECT");
const report = (label: string, wrong: { driver: string[]; server: string[] }, right: { driver: string[]; server: string[] }) =>
  console.log(`[e32b] ROUND TRIPS ${label}: wrong pin driver=${wrong.driver.length} server=${wrong.server.length} writes=${writesOf(wrong.server).length} | ` +
    `correct pin driver=${right.driver.length} server=${right.server.length} writes=${writesOf(right.server).length} | ` +
    `wrong=${JSON.stringify(wrong.server)} correct=${JSON.stringify(right.server)}`);

const THE_THREE_WRITES = ["INSERT pin_attempt", "UPDATE clinician", "INSERT audit_log"];
/** R64: closed codes and counts only. Asserted on the ROW the database holds. */
const expectClean = (row: Record<string, unknown>, id: string) => {
  const raw = String(row.raw);
  for (const leak of [PIN, WRONG, NAME, "Fixture", slugOf(id), "slug-", id, "E32b injected", "Command failed", "ERROR", "psql"]) {
    expect(raw.includes(leak), `audit metadata must not carry ${JSON.stringify(leak)}: ${raw}`).toBe(false);
  }
  for (const v of Object.values(row.metadata_json as Record<string, unknown>)) {
    expect(typeof v === "number" ? Number.isInteger(v) : ["threw", "zero_rows"].includes(String(v)), `closed code or count: ${String(v)}`).toBe(true);
  }
};

describe.runIf(HAVE_DOCKER)("E32b — the wrong-pin and correct-pin refusals do the same work", () => {
  // ═══ ROUND TRIPS ═════════════════════════════════════════════════════════════════════════════════════════
  const symmetric = async (label: string, arm: () => void, disarmAll: () => void, idBase: string) => {
    const wrongSlug = routeDoctor(`${idBase}_w`, 3);
    const rightSlug = routeDoctor(`${idBase}_r`, 3);
    let wrong, right;
    arm();
    try {
      wrong = await captured(() => roundTrips(() => callPin(wrongSlug, WRONG)));
      right = await captured(() => roundTrips(() => callPin(rightSlug, PIN)));
    } finally {
      disarmAll();
    }
    report(label, wrong.out, right.out);
    expect(wrong.out.out.status).toBe(500);
    expect(right.out.out.status, "the correct pin is refused too: nothing is recording").toBe(500);
    expect(H.signDoctorJwt).not.toHaveBeenCalled();
    // The driver and the server agree with each other on each path…
    expect(wrong.out.server, "the server received what the driver sent (wrong pin)").toEqual(wrong.out.driver);
    expect(right.out.server, "the server received what the driver sent (correct pin)").toEqual(right.out.driver);
    // …and the two paths do the same work: same count, same writes, in the same order.
    expect(wrong.out.server.length, "EQUAL ROUND TRIPS").toBe(right.out.server.length);
    expect(writesOf(wrong.out.server), "the wrong pin attempts all three writes").toEqual(THE_THREE_WRITES);
    expect(writesOf(right.out.server), "the correct pin attempts the same three").toEqual(THE_THREE_WRITES);
    expect(wrong.out.server, "and the whole sequence, reads included, is the same").toEqual(right.out.server);
    return { wrong, right };
  };

  it("ROUND TRIPS — TOTAL WRITE FAILURE, every write THROWS: the wrong pin and the correct pin attempt the same statements", async () => {
    await symmetric("all-raise", () => armRaise("clinician", "pin_attempt", "audit_log"), disarm, "doc_rt_raise");
  }, 300_000);

  it("ROUND TRIPS — TOTAL WRITE FAILURE, every write lands ZERO ROWS: still equal (the zero-rows exit audits too)", async () => {
    await symmetric("all-zero-rows", () => armSilent("clinician", "pin_attempt", "audit_log"), disarm, "doc_rt_silent");
  }, 300_000);

  it("ROUND TRIPS — T1, a READ-ONLY database: still equal", async () => {
    await symmetric("read-only", () => readOnly(true), () => readOnly(false), "doc_rt_ro");
  }, 300_000);

  it("ROUND TRIPS — the counters and audit_log fail, pin_attempt ZERO ROWS and clinician RAISE mixed: still equal", async () => {
    await symmetric("mixed", () => { armRaise("clinician", "audit_log"); armSilent("pin_attempt"); }, disarm, "doc_rt_mixed");
  }, 300_000);

  // ═══ AUDIT ROWS WHEN audit_log IS HEALTHY ═════════════════════════════════════════════════════════════════
  it("AUDIT HEALTHY, clinician + pin_attempt THROW: the wrong pin lands exactly one refused_unrecorded row, the correct pin exactly one refused_no_bound row", async () => {
    const wrongSlug = routeDoctor("doc_au_w", 7);
    const rightSlug = routeDoctor("doc_au_r", 7);
    let wrong, right;
    armRaise("clinician", "pin_attempt");
    try {
      wrong = await captured(() => callPin(wrongSlug, WRONG));
      right = await captured(() => callPin(rightSlug, PIN));
    } finally {
      disarm();
    }
    const w = await auditRows("doc_au_w");
    const r = await auditRows("doc_au_r");
    expect(w.map(({ raw: _raw, ...x }) => x)).toEqual([{
      actor_type: "system", actor_id: "auth:pin-lockout-v1", action: "auth.pin_attempt_refused_unrecorded",
      target_type: "doctor", target_id: "doc_au_w", metadata_json: { reason: "threw", stale_failed_pin_count: 7 },
    }]);
    expect(r.map((x) => x.action)).toEqual(["auth.pin_session_refused_no_bound"]);
    for (const row of w) expectClean(row, "doc_au_w");
    for (const row of r) expectClean(row, "doc_au_r");
    expect(wrong.lines.some((l) => l.includes("[auth/pin] attempt refused, not recorded:") && l.includes('"audited":true')),
      "the route logs audited on the not_recorded branch").toBe(true);
    expect(right.out.status).toBe(500);
  }, 300_000);

  it("AUDIT HEALTHY, clinician UPDATE matches ZERO ROWS: the wrong pin's other exit lands its row too, reason zero_rows", async () => {
    const L = await import("@/lib/lockout");
    const slug = routeDoctor("doc_au_zero", 2);
    let wrong;
    armSilent("clinician");
    try {
      wrong = await captured(() => callPin(slug, WRONG));
    } finally {
      disarm();
    }
    expect(wrong.out.status).toBe(500);
    const rows = await auditRows("doc_au_zero");
    expect(rows.map((x) => [x.action, x.metadata_json])).toEqual([
      ["auth.pin_attempt_refused_unrecorded", { reason: "zero_rows", stale_failed_pin_count: 2 }],
    ]);
    for (const row of rows) expectClean(row, "doc_au_zero");
    // And the lib says so directly, for a doctor with no row at all (the UPDATE matches nothing, nothing throws).
    const ghost = await captured(() => L.recordFailedAttempt(lockState("doc_au_ghost", 4), null, null));
    expect(ghost.out).toEqual({ kind: "not_recorded", audited: true });
    const ghostRows = await auditRows("doc_au_ghost");
    expect(ghostRows.map((x) => [x.action, x.metadata_json])).toEqual([
      ["auth.pin_attempt_refused_unrecorded", { reason: "zero_rows", stale_failed_pin_count: 4 }],
    ]);
    for (const row of ghostRows) expectClean(row, "doc_au_ghost");
  }, 300_000);

  // ═══ AUDIT ALSO FAILING ════════════════════════════════════════════════════════════════════════════════════
  it("AUDIT ALSO FAILING (throws, or lands zero rows): both paths still refuse, both report audited:false, nothing throws out", async () => {
    const L = await import("@/lib/lockout");
    for (const [mode, arm] of [["raise", () => armRaise("audit_log")], ["zero_rows", () => armSilent("audit_log")]] as const) {
      pg.exec(`INSERT INTO clinician (id, failed_pin_count) VALUES ('doc_af_${mode}_w', 5), ('doc_af_${mode}_r', 5)`);
      const wrongSlug = routeDoctor(`doc_af_${mode}_rw`, 5);
      const rightSlug = routeDoctor(`doc_af_${mode}_rr`, 5);
      armRaise("clinician", "pin_attempt");
      arm();
      let libWrong: unknown, libRight: unknown, routeWrong, routeRight;
      let libWrongZero: unknown;
      try {
        // In the lib. Each is awaited bare: a rejection out of either function fails this test.
        libWrong = (await captured(() => L.recordFailedAttempt(lockState(`doc_af_${mode}_w`, 5), null, null))).out;
        libRight = (await captured(() => L.recordSuccessfulAttempt(lockState(`doc_af_${mode}_r`, 5), null, null))).out;
        libWrongZero = (await captured(() => L.recordFailedAttempt(lockState(`doc_af_${mode}_nobody`, 5), null, null))).out;
        routeWrong = await captured(() => callPin(wrongSlug, WRONG));
        routeRight = await captured(() => callPin(rightSlug, PIN));
      } finally {
        disarm();
      }
      expect(libWrong, `${mode}: wrong pin, catch exit`).toEqual({ kind: "not_recorded", audited: false });
      expect(libWrongZero, `${mode}: wrong pin, zero-rows exit`).toEqual({ kind: "not_recorded", audited: false });
      expect(libRight, `${mode}: correct pin`).toEqual({ kind: "no_bound_recording", audited: false });
      expect(routeWrong.out.status).toBe(500);
      expect(routeRight.out.status).toBe(500);
      expect(routeWrong.out.full, `${mode}: the refusal is unchanged when audit_log is down`).toBe(routeRight.out.full);
      expect(routeWrong.lines.some((l) => l.includes("[auth/pin] attempt refused, not recorded:") && l.includes('"audited":false')),
        `${mode}: the route says the audit did not land`).toBe(true);
      expect(H.signDoctorJwt).not.toHaveBeenCalled();
      for (const id of [`doc_af_${mode}_w`, `doc_af_${mode}_r`, `doc_af_${mode}_nobody`, `doc_af_${mode}_rw`, `doc_af_${mode}_rr`]) {
        expect(await auditRows(id), `${mode}: audit_log refused, so no row for ${id}`).toEqual([]);
      }
    }
  }, 300_000);

  // ═══ THE RESPONSE DOES NOT CHANGE ══════════════════════════════════════════════════════════════════════════
  it("BYTE-IDENTICAL: the full wrong-pin and correct-pin refusals serialize the same, with audit_log up and with it down", async () => {
    const fulls: Record<string, string> = {};
    for (const [label, arm] of [
      ["audit-up", () => armRaise("clinician", "pin_attempt")],
      ["audit-down", () => armRaise("clinician", "pin_attempt", "audit_log")],
    ] as const) {
      const wrongSlug = routeDoctor(`doc_bi_${label}_w`, 1);
      const rightSlug = routeDoctor(`doc_bi_${label}_r`, 1);
      arm();
      let wrong, right;
      try {
        wrong = await captured(() => callPin(wrongSlug, WRONG));
        right = await captured(() => callPin(rightSlug, PIN));
        expect(H.setDoctorCookie, "no cookie").not.toHaveBeenCalled();
      } finally {
        disarm();
      }
      expect(wrong.out.full, `${label}: diff of the two serialized responses is empty`).toBe(right.out.full);
      fulls[`${label}:wrong`] = wrong.out.full;
      fulls[`${label}:right`] = right.out.full;
    }
    expect(new Set(Object.values(fulls)).size, "four responses, one byte string").toBe(1);
    const one = JSON.parse(Object.values(fulls)[0]!);
    expect(one.status).toBe(500);
    expect(JSON.parse(one.body)).toEqual({ error: { code: "PIPELINE_FAILED", message: "Attempt could not be recorded; refusing the attempt" } });
    expect(one.headers.some(([k]: [string]) => k === "set-cookie"), "no cookie header").toBe(false);
  }, 300_000);

  it("THE CONSTANT: exported beside the others, distinct, on the R64 actor", async () => {
    const L = await import("@/lib/lockout");
    expect(L.AUDIT_PIN_ATTEMPT_REFUSED_UNRECORDED).toBe("auth.pin_attempt_refused_unrecorded");
    expect(L.AUDIT_ACTOR_PIN_LOCKOUT).toBe("auth:pin-lockout-v1");
    expect(new Set([L.AUDIT_PIN_ATTEMPT_REFUSED_UNRECORDED, L.AUDIT_PIN_SESSION_REFUSED_NO_BOUND, L.AUDIT_PIN_RESET_WRITE_FAILED]).size).toBe(3);
  });
});
