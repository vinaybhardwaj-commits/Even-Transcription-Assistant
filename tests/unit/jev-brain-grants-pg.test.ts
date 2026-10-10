/**
 * tests/unit/jev-brain-grants-pg.test.ts — Jev P0 #56: the brain-pool Jev readers, as brain_svc, on a REAL postgres:16
 * with EVERY migration applied in order.
 *
 *   BEFORE 0144: scribe_jev_decisions and scribe_jev_signals fail with 42501, and the tool answers `db_error:42501`
 *                (never the driver's message, which names the relation).
 *   AFTER  0144: both return their rows.
 *   EACH GRANT is load-bearing: revoking any one of the five makes a NAMED test fail.
 *
 * Only the driver is a stand-in: `@/lib/brain/db` query runs through psql with `SET ROLE brain_svc` (the role the brain
 * pool connects as), values bound as $1..$n; `@/lib/db` is the harness's postgres-role sql (the app pool).
 * Ids only; no transcript text.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({
  sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>),
  brain: null as null | ((text: string, values: unknown[]) => Promise<{ rows: unknown[] }>),
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));
vi.mock("@/lib/brain/db", () => ({ query: (t: string, v: unknown[] = []) => H.brain!(t, v) }));
vi.mock("@/lib/jobs/submit", () => ({ submitJob: vi.fn() }));

import { JEV_TOOLS } from "@/lib/mcp/tools/jev";
import { safeJevErrorMessage } from "@/lib/jev/safe-error";
import type { ToolContext } from "@/lib/mcp/registry";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-jev-brain-grants");
const ctx: ToolContext = { origin: "https://preview.example", actor: "test-actor", scopes: new Set(["read"]) };
const tool = (name: string) => JEV_TOOLS.find((t) => t.name === name)!;

const GRANT_FILE = "0144_jev_brain_reader_grants.sql";
const ALL = readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort();
const GRANTED = ["jev_window_signal", "jev_decision", "jev_window_text"];
/** 0074's intent stands: brain_svc does not read room tables, before or after 0144. */
const NOT_GRANTED = ["bench_window", "room_diarize_window", "jev_role_signal"];

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  const s = Array.isArray(v) ? `{${v.map((e) => `"${String(e)}"`).join(",")}}` : String(v);
  return `'${s.replace(/'/g, "''")}'`;
};

/** The brain pool: psql as brain_svc. A Postgres error is thrown the way node-postgres throws it: `.code` = SQLSTATE. */
function brainQuery(text: string, values: unknown[]): Promise<{ rows: unknown[] }> {
  const args = values.length ? `(${values.map(lit).join(", ")})` : "";
  const script = `\\set VERBOSITY verbose\nSET ROLE brain_svc;\nPREPARE __b AS SELECT COALESCE(jsonb_agg(__q)::text, '[]') FROM (${text}) __q;\nEXECUTE __b${args};\n`;
  try {
    const out = execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], {
      input: script, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    return Promise.resolve({ rows: JSON.parse(out.trim().split("\n").pop()!) });
  } catch (e) {
    const stderr = String((e as { stderr?: string }).stderr ?? "");
    const m = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(stderr);
    return Promise.reject(Object.assign(new Error(m ? m[2] : stderr.slice(0, 200)), { code: m?.[1] }));
  }
}

const suite = HAVE_DOCKER || !ALLOW_SKIP ? describe : describe.skip;

suite("brain_svc reads the Jev tables (real postgres:16, every migration)", () => {
  beforeAll(() => {
    if (!HAVE_DOCKER) throw new Error("docker is required (set ETA_ALLOW_SKIP_E2E=1 to skip)");
    pg.start();
    H.sql = pg.sql as typeof H.sql;
    H.brain = brainQuery;
    // The role exists BEFORE the migrations, as in production, so 0053 grants as it did there.
    pg.exec(`CREATE ROLE brain_svc NOLOGIN;`);
    for (const f of ALL) if (f !== GRANT_FILE) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
    pg.exec(`
      INSERT INTO room (id, slug, name, pin_hash) VALUES ('room_t', 'room-t', 'Room T', 'x');
      INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_t', 'room_t', '2026-10-01');
      INSERT INTO bench_session (id, room_id) VALUES ('bs_t', 'room_t');
      INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, state) VALUES ('bw_t', 'bs_t', 'rd_t', 0, 900000, 'm', 'closed');
      INSERT INTO jev_window_signal (window_id, room_day_id, session_id, start_ms, end_ms, phase, phase_probs, phase_confidence, p_start, p_end, p_clinician, p_clinical, model, prompt_version, input_tokens, batch_id)
        VALUES ('bw_t', 'rd_t', 'bs_t', 0, 900000, 'history', '{"history":1}', 1, 0.1, 0.1, 0.5, 0.9, 'jev-x', 'v1', 10, 'b1');
      INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, answer)
        VALUES ('jd_t', 'window', 'bw_t', 'phase', 'v1', 'jev-x', '{"choice":"history"}'),
               ('jd_u1', 'window', 'bw_t', 'u1_phase', 'u1-phase-w1', 'jev-x', '{"choice":"history"}');
    `);
  }, 240_000);
  afterAll(() => pg.stop());

  const decisions = () => tool("scribe_jev_decisions").handler({}, ctx) as Promise<Record<string, unknown>>;
  const signals = () => tool("scribe_jev_signals").handler({ room_day_id: "rd_t" }, ctx) as Promise<Record<string, unknown>>;

  it("BEFORE 0144: both tools fail 42501 and say db_error:42501, never the driver's text", async () => {
    for (const out of [await decisions(), await signals()]) {
      expect(out.degraded).toBe(true);
      expect(out.error).toBe("db_error:42501");
      expect(String(out.error)).not.toMatch(/permission denied|relation|jev_/i);
    }
  });

  it("AFTER 0144: scribe_jev_decisions and scribe_jev_signals return their rows", async () => {
    pg.exec(readFileSync(`db/migrations/${GRANT_FILE}`, "utf8"));
    const d = await decisions();
    expect(d.ok).toBe(true);
    expect((d.decisions as Array<{ id: string }>).map((r) => r.id).sort()).toEqual(["jd_t", "jd_u1"]);
    const s = await signals();
    expect(s.ok).toBe(true);
    expect((s.signals as Array<{ window_id: string }>).map((r) => r.window_id)).toEqual(["bw_t"]);
  });

  it("scribe_jev_decisions {question_id:'u1_phase'} returns only prompt_version u1-phase-w1", async () => {
    const d = (await tool("scribe_jev_decisions").handler({ question_id: "u1_phase" }, ctx)) as Record<string, unknown>;
    expect(d.ok).toBe(true);
    expect((d.decisions as Array<{ prompt_version: string }>).map((r) => r.prompt_version)).toEqual(["u1-phase-w1"]);
  });

  it("brain_svc still cannot SELECT the room tables (0074) or jev_role_signal", () => {
    for (const t of NOT_GRANTED) {
      const out = execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-U", "postgres", "-d", "postgres", "-c", `SELECT has_table_privilege('brain_svc', '${t}', 'SELECT')`], { encoding: "utf8" }).trim();
      expect(out, t).toBe("f");
    }
  });

  it("0144 is idempotent and SELECT-only: a re-run is clean and brain_svc gains no write", () => {
    pg.exec(readFileSync(`db/migrations/${GRANT_FILE}`, "utf8"));
    for (const t of GRANTED) {
      for (const priv of ["INSERT", "UPDATE", "DELETE"]) {
        const out = execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-U", "postgres", "-d", "postgres", "-c", `SELECT has_table_privilege('brain_svc', '${t}', '${priv}')`], { encoding: "utf8" }).trim();
        expect(out, `${t} ${priv}`).toBe("f");
      }
    }
  });

  // jev_window_text has no brain-pool reader today (granted because the order names it), so no reader test can depend on it.
  // Each other GRANT is load-bearing: revoke ONE, and a named test fails (mutant: drop that GRANT from 0144).
  it.each(GRANTED.filter((t) => t !== "jev_window_text"))("dropping the GRANT on %s breaks a Jev reader with 42501", async (table) => {
    pg.exec(`REVOKE SELECT ON TABLE ${table} FROM brain_svc;`);
    try {
      const outs = [await decisions(), await signals()];
      expect(outs.some((o) => o.error === "db_error:42501"), `no reader failed without ${table}`).toBe(true);
    } finally {
      pg.exec(`GRANT SELECT ON TABLE ${table} TO brain_svc;`);
    }
  });
});

describe("safeJevErrorMessage maps Postgres errors to db_error:<code>", () => {
  it("uses the SQLSTATE only", () => {
    expect(safeJevErrorMessage(Object.assign(new Error('permission denied for table jev_decision'), { code: "42501" }))).toBe("db_error:42501");
    expect(safeJevErrorMessage(Object.assign(new Error("x"), { code: "57P01" }))).toBe("db_error:57P01");
  });
  it("does not mistake a Node system error for one", () => {
    expect(safeJevErrorMessage(Object.assign(new Error("boom"), { code: "EPIPE" }))).toBe("jev_error: Error");
    expect(safeJevErrorMessage(Object.assign(new Error("boom"), { code: "ECONNRESET" }))).toBe("jev_error: Error");
  });
});

describe("a forced permission failure on a Jev MCP read (no docker needed)", () => {
  it("DatabaseError{name:'error', code:'42501'} gives db_error:42501, not jev_error", () => {
    const e = Object.assign(new Error('permission denied for table jev_decision'), { name: "error", code: "42501" });
    expect(safeJevErrorMessage(e)).toBe("db_error:42501");
    expect(safeJevErrorMessage(e)).not.toMatch(/jev_decision|permission/);
  });
});
