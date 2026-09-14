/**
 * S1 — the auto-drain (lib/stt/auto-drain.ts) and its cron route (app/api/admin/drain-windows).
 *
 * TWO HALVES, TWO DATABASES.
 *   The flag and the actor are proven against a recording fake: what matters there is whether the
 *   scan and the drain are reached at all, and with what.
 *   The SELECTOR is proven against a REAL postgres:16 with 0057 and 0082 verbatim. A fake cannot
 *   say what a WHERE clause excludes; it answers whatever the test hoped for. Every exclusion is
 *   shown twice on the same row: refused, then — with only that one field changed — offered.
 *
 * The drain itself is mocked. Its guards (Transcript switch, claim, submit) are its own and are
 * proven in c1b-room-window-job.test.ts; this file proves only which windows are handed to it.
 *
 * Its own container name: tests/support/pg-harness.ts hard-codes one, and vitest runs files in
 * parallel, so sharing it would remove c2-e2e-runner's database under it.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

type Sql = (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>;
const H = vi.hoisted(() => ({
  sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>,
  drained: [] as Array<{ windowId: string; origin: string; opts: Record<string, unknown> }>,
  step: "enqueued" as string,
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.mock("@/lib/stt/room-drain", () => ({
  drainRoomWindow: async (windowId: string, origin: string, opts: Record<string, unknown>) => {
    H.drained.push({ windowId, origin, opts });
    return H.step === "enqueued"
      ? { window_id: windowId, ok: true, step: "enqueued", job_id: `job_${H.drained.length}` }
      : { window_id: windowId, ok: false, step: H.step };
  },
}));
vi.mock("@/lib/cookie", () => ({ readAdminCookie: async () => null }));
vi.mock("@/lib/auth", () => ({ verifyAdminJwt: async () => { throw new Error("no admin in this test"); } }));

const { enqueueAutoDrain, clampedIntEnv, AUTO_DRAIN_BATCH_LIMIT, AUTO_DRAIN_MAX_AGE_HOURS, ROOM_AUTO_DRAIN_ENABLED_ENV } = await import("@/lib/stt/auto-drain");
const { SYSTEM_ACTOR, actorProblem } = await import("@/lib/stt/receipt");
const { FlagValueError } = await import("@/lib/flags");

const ENV_KEYS = [ROOM_AUTO_DRAIN_ENABLED_ENV, "AUTO_DRAIN_BATCH_LIMIT", "AUTO_DRAIN_MAX_AGE_HOURS", "CRON_SECRET", "MIGRATION_SECRET"];
let saved: Record<string, string | undefined> = {};
const silent = () => {};

beforeEach(() => {
  H.drained.length = 0;
  H.step = "enqueued";
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete (process.env as Record<string, string | undefined>)[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else process.env[k] = v;
  }
});

/** A recording fake: every query is logged, and every scan answers `rows`. */
function fakeSql(rows: Array<{ id: string }>): { calls: string[] } {
  const log = { calls: [] as string[] };
  H.sql = (async (s: TemplateStringsArray) => { log.calls.push(s.join("?")); return rows; }) as Sql;
  return log;
}

// ═══ 1. THE FLAG — refusal paired with its proof that the refusal is not universal ═══════════════

describe("ROOM_AUTO_DRAIN_ENABLED", () => {
  it("OFF (unset): enqueued 0, no scan, and NO call to drainRoomWindow", async () => {
    const db = fakeSql([{ id: "bw_a" }]);
    const r = await enqueueAutoDrain("https://x.test", { log: silent });
    expect(r).toEqual({ enqueued: 0, considered: 0, results: [] });
    expect(db.calls).toHaveLength(0);
    expect(H.drained).toHaveLength(0);
  });

  it("OFF (a documented falsy value): the same no-op", async () => {
    for (const v of ["0", "false", "off", ""]) {
      process.env[ROOM_AUTO_DRAIN_ENABLED_ENV] = v;
      const db = fakeSql([{ id: "bw_a" }]);
      const r = await enqueueAutoDrain("https://x.test", { log: silent });
      expect(r.enqueued, JSON.stringify(v)).toBe(0);
      expect(db.calls, JSON.stringify(v)).toHaveLength(0);
    }
    expect(H.drained).toHaveLength(0);
  });

  it("ON, with the SAME eligible row: it scans, drains, and counts the enqueue", async () => {
    process.env[ROOM_AUTO_DRAIN_ENABLED_ENV] = "1";
    const db = fakeSql([{ id: "bw_a" }]);
    const r = await enqueueAutoDrain("https://x.test", { log: silent });
    expect(db.calls).toHaveLength(1);
    expect(H.drained.map((d) => d.windowId)).toEqual(["bw_a"]);
    expect(r).toEqual({ enqueued: 1, considered: 1, results: [{ window_id: "bw_a", step: "enqueued", job_id: "job_1" }] });
  });

  it("an UNRECOGNISED value throws — never read as off — and drains nothing", async () => {
    process.env[ROOM_AUTO_DRAIN_ENABLED_ENV] = "enabled";
    const db = fakeSql([{ id: "bw_a" }]);
    await expect(enqueueAutoDrain("https://x.test", { log: silent })).rejects.toThrow(FlagValueError);
    expect(db.calls).toHaveLength(0);
    expect(H.drained).toHaveLength(0);
  });

  it("the flag is read through parseFlag, never with === \"1\"", () => {
    const code = readFileSync("lib/stt/auto-drain.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("parseFlag(ROOM_AUTO_DRAIN_ENABLED_ENV)");
    expect(code).not.toMatch(/===\s*["']1["']/);
  });
});

describe("the actor", () => {
  it("is SYSTEM_ACTOR through the cron door — and actorProblem accepts exactly that", async () => {
    process.env[ROOM_AUTO_DRAIN_ENABLED_ENV] = "1";
    fakeSql([{ id: "bw_a" }]);
    await enqueueAutoDrain("https://x.test", { log: silent });
    expect(H.drained[0]!.opts).toEqual({ actor: SYSTEM_ACTOR, via: "cron" });
    expect(H.drained[0]!.origin).toBe("https://x.test");
    expect(actorProblem(H.drained[0]!.opts as never)).toBeNull();
  });

  it("the constant is imported, not typed", () => {
    const code = readFileSync("lib/stt/auto-drain.ts", "utf8");
    expect(code).toContain("actor: SYSTEM_ACTOR");
    expect(code).not.toContain('"system:cron"');
  });

  it("a window the drain refuses by name is reported, not counted — the Transcript switch is the drain's check", async () => {
    process.env[ROOM_AUTO_DRAIN_ENABLED_ENV] = "1";
    fakeSql([{ id: "bw_a" }]);
    H.step = "flag_off";
    const r = await enqueueAutoDrain("https://x.test", { log: silent });
    expect(r).toEqual({ enqueued: 0, considered: 1, results: [{ window_id: "bw_a", step: "flag_off" }] });
    expect(readFileSync("lib/stt/auto-drain.ts", "utf8")).not.toMatch(/isTranscriptEnabled\(/);
  });
});

describe("the env constants", () => {
  it("defaults 1 and 6; integers clamped to 1..10 and 1..48; anything else is the default", () => {
    expect(clampedIntEnv("N", 1, 1, 10, {})).toBe(1);
    expect(clampedIntEnv("N", 6, 1, 48, {})).toBe(6);
    expect(clampedIntEnv("N", 1, 1, 10, { N: "4" })).toBe(4);
    expect(clampedIntEnv("N", 1, 1, 10, { N: " 4 " })).toBe(4);
    expect(clampedIntEnv("N", 1, 1, 10, { N: "0" })).toBe(1);
    expect(clampedIntEnv("N", 1, 1, 10, { N: "-3" })).toBe(1);
    expect(clampedIntEnv("N", 1, 1, 10, { N: "11" })).toBe(10);
    expect(clampedIntEnv("N", 6, 1, 48, { N: "49" })).toBe(48);
    for (const v of ["", "abc", "2.5", "1e3", "4h"]) expect(clampedIntEnv("N", 6, 1, 48, { N: v }), v).toBe(6);
  });

  it("the shipped cap cannot be raised by the caller's limit", async () => {
    process.env[ROOM_AUTO_DRAIN_ENABLED_ENV] = "1";
    const values: unknown[][] = [];
    H.sql = (async (_s: TemplateStringsArray, ...v: unknown[]) => { values.push(v); return []; }) as Sql;
    await enqueueAutoDrain("https://x.test", { limit: AUTO_DRAIN_BATCH_LIMIT + 5, log: silent });
    expect(values[0]!.at(-1)).toBe(AUTO_DRAIN_BATCH_LIMIT);
  });
});

// ═══ 2 & 3. THE SELECTOR, AGAINST A REAL POSTGRES ═════════════════════════════════════════════════

const PG = "eta-s1-auto-drain";
const HAVE_DOCKER = (() => { try { execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe" }); return true; } catch { return false; } })();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";

describe("REQUIRED PROOF — the auto-drain selector against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/s1-auto-drain.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that the selector was not proven.");
  });
});

const docker = (args: string[], input?: string) =>
  execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
const psql = (text: string, rows = false) =>
  docker(["exec", "-i", PG, "psql", rows ? "-qAt" : "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], text);
const lit = (v: unknown): string =>
  v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : `'${String(v).replace(/'/g, "''")}'`;
/** The app's `sql` tag over psql. Values are inlined as literals: test-only, never user input. */
const realSql: Sql = async (strings, ...values) => {
  let q = "";
  strings.forEach((s, i) => { q += s + (i < values.length ? lit(values[i]) : ""); });
  const out = psql(`WITH __q AS (${q}) SELECT COALESCE(jsonb_agg(__q)::text, '[]') FROM __q;`, true).trim();
  return out ? (JSON.parse(out) as unknown[]) : [];
};
const noRecord = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  try { docker(["rm", "-f", PG]); } catch { /* not running */ }
  docker(["run", "-d", "--rm", "--name", PG, "-e", "POSTGRES_PASSWORD=x", "postgres:16"]);
  // Two consecutive real SELECTs: pg_isready answers during initdb's restart and then loses the race.
  const deadline = Date.now() + 90_000;
  for (let ok = 0; ok < 2;) {
    try { psql("SELECT 1;"); ok += 1; } catch { ok = 0; }
    if (Date.now() > deadline) throw new Error("postgres did not become ready");
    execFileSync("sleep", ["0.5"]);
  }
  psql("CREATE TABLE bench_session (id text PRIMARY KEY); INSERT INTO bench_session VALUES ('sess_1');");
  psql(noRecord("db/migrations/0057_bench_window.sql"));
  psql(noRecord("db/migrations/0082_scribe_job.sql"));
}, 180_000);
afterAll(() => { if (HAVE_DOCKER) { try { docker(["rm", "-f", PG]); } catch { /* already gone */ } } });

let startMs = 0;
/** A window that is eligible in every respect unless an override says otherwise. `ageMin` is minutes since close. */
function windowRow(id: string, o: { ageMin?: number; state?: string; grid?: boolean; roomDay?: string | null } = {}): void {
  startMs += 900_000;
  const age = o.ageMin ?? 10;
  psql(`INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, grid_aligned, state, closed_at)
        VALUES (${lit(id)}, 'sess_1', ${lit(o.roomDay === undefined ? "rd_1" : o.roomDay)}, ${startMs}, ${startMs + 900_000}, 'primary',
                ${lit(o.grid ?? true)}, ${lit(o.state ?? "closed")}, NOW() - (${age} * INTERVAL '1 minute'));`);
}
const offered = () => H.drained.map((d) => d.windowId);
const drainOnce = async (mod: { enqueueAutoDrain: typeof enqueueAutoDrain } = { enqueueAutoDrain }) => {
  H.drained.length = 0;
  return mod.enqueueAutoDrain("https://x.test", { log: silent });
};

describe.skipIf(!HAVE_DOCKER)("the selector — each exclusion, then the same row with only that field changed", () => {
  const maxAgeMin = AUTO_DRAIN_MAX_AGE_HOURS * 60;

  beforeEach(() => {
    psql("TRUNCATE bench_window, scribe_job;");
    H.sql = realSql;
    process.env[ROOM_AUTO_DRAIN_ENABLED_ENV] = "1";
  });

  it("closed longer ago than AUTO_DRAIN_MAX_AGE_HOURS is refused; just inside it is offered", async () => {
    windowRow("bw_age", { ageMin: maxAgeMin + 5 });
    expect((await drainOnce()).considered).toBe(0);
    expect(offered()).toEqual([]);

    psql(`UPDATE bench_window SET closed_at = NOW() - (${maxAgeMin - 5} * INTERVAL '1 minute') WHERE id = 'bw_age';`);
    expect((await drainOnce()).considered).toBe(1);
    expect(offered()).toEqual(["bw_age"]);
  });

  it("grid_aligned = false is refused; true is offered", async () => {
    windowRow("bw_grid", { grid: false });
    expect((await drainOnce()).considered).toBe(0);
    psql("UPDATE bench_window SET grid_aligned = TRUE WHERE id = 'bw_grid';");
    expect((await drainOnce()).considered).toBe(1);
    expect(offered()).toEqual(["bw_grid"]);
  });

  it("a null room_day_id is refused; a set one is offered", async () => {
    windowRow("bw_day", { roomDay: null });
    expect((await drainOnce()).considered).toBe(0);
    psql("UPDATE bench_window SET room_day_id = 'rd_1' WHERE id = 'bw_day';");
    expect((await drainOnce()).considered).toBe(1);
    expect(offered()).toEqual(["bw_day"]);
  });

  it("a state other than closed is refused; closed is offered", async () => {
    for (const s of ["open", "transcribing", "transcribed", "failed"]) {
      psql("TRUNCATE bench_window;");
      windowRow("bw_state", { state: s });
      expect((await drainOnce()).considered, s).toBe(0);
    }
    psql("UPDATE bench_window SET state = 'closed' WHERE id = 'bw_state';");
    expect((await drainOnce()).considered).toBe(1);
  });

  it("a queued or running room_window job for the window is refused; a finished one, or another kind, is not", async () => {
    windowRow("bw_job");
    for (const status of ["queued", "running"]) {
      psql(`TRUNCATE scribe_job; INSERT INTO scribe_job (id, kind, args, status) VALUES ('job_live', 'room_window', '{"window_id":"bw_job"}', ${lit(status)});`);
      expect((await drainOnce()).considered, status).toBe(0);
    }
    for (const status of ["done", "failed", "cancelled"]) {
      psql(`UPDATE scribe_job SET status = ${lit(status)} WHERE id = 'job_live';`);
      expect((await drainOnce()).considered, status).toBe(1);
    }
    psql(`TRUNCATE scribe_job; INSERT INTO scribe_job (id, kind, args, status) VALUES ('job_other', 'diarize_window', '{"window_id":"bw_job"}', 'queued');`);
    expect((await drainOnce()).considered).toBe(1);
    expect(offered()).toEqual(["bw_job"]);
  });
});

describe.skipIf(!HAVE_DOCKER)("the cap and the order", () => {
  beforeEach(() => {
    psql("TRUNCATE bench_window, scribe_job;");
    H.sql = realSql;
    process.env[ROOM_AUTO_DRAIN_ENABLED_ENV] = "1";
  });

  /**
   * CAP + 2 eligible windows. Returns their ids newest-closed first. Inserted in the order
   * [1, 0, 2, 3, ...], so start_ms rises with insertion: neither insertion order, start_ms ASC nor
   * start_ms DESC puts the newest-closed window first. Only closed_at DESC does.
   */
  function seedScrambled(cap: number): string[] {
    const n = cap + 2;
    const ages = Array.from({ length: n }, (_, i) => (i + 1) * 7);
    for (const i of [1, 0, ...Array.from({ length: n - 2 }, (_, k) => k + 2)]) windowRow(`bw_age_${ages[i]}`, { ageMin: ages[i] });
    return ages.map((a) => `bw_age_${a}`);
  }

  it("the shipped cap: AUTO_DRAIN_BATCH_LIMIT windows, and they are the newest", async () => {
    const newestFirst = seedScrambled(AUTO_DRAIN_BATCH_LIMIT);
    const r = await drainOnce();
    expect(r.considered).toBe(AUTO_DRAIN_BATCH_LIMIT);
    expect(offered()).toEqual(newestFirst.slice(0, AUTO_DRAIN_BATCH_LIMIT));
  });

  it("with the cap raised by env, the whole batch is in closed_at DESC order and stops at the cap", async () => {
    process.env.AUTO_DRAIN_BATCH_LIMIT = "3";
    vi.resetModules();
    try {
      const mod = await import("@/lib/stt/auto-drain");
      expect(mod.AUTO_DRAIN_BATCH_LIMIT).toBe(3);
      const newestFirst = seedScrambled(mod.AUTO_DRAIN_BATCH_LIMIT);
      const r = await drainOnce(mod);
      expect(r.considered).toBe(mod.AUTO_DRAIN_BATCH_LIMIT);
      expect(offered()).toEqual(newestFirst.slice(0, mod.AUTO_DRAIN_BATCH_LIMIT));
    } finally {
      // Drop the raised-cap instance, so later imports (the route) resolve the shipped cap again.
      vi.resetModules();
    }
  });
});

// ═══ THE ROUTE AND THE CRON ═══════════════════════════════════════════════════════════════════════

describe("/api/admin/drain-windows", () => {
  const call = async (method: "GET" | "POST", auth?: string) => {
    const route = await import("@/app/api/admin/drain-windows/route");
    const req = new NextRequest("https://x.test/api/admin/drain-windows", { method, ...(auth ? { headers: { authorization: auth } } : {}) });
    return method === "GET" ? route.GET(req) : route.POST(req);
  };

  it("401 without the cron or migration secret, and nothing is scanned or drained", async () => {
    process.env.CRON_SECRET = "cron-tok";
    process.env[ROOM_AUTO_DRAIN_ENABLED_ENV] = "1";
    const db = fakeSql([{ id: "bw_a" }]);
    for (const auth of [undefined, "Bearer wrong", "cron-tok"]) expect((await call("GET", auth)).status, String(auth)).toBe(401);
    expect((await call("POST", "Bearer cron-tok")).status, "POST is the admin door, not the cron's").toBe(401);
    expect(db.calls).toHaveLength(0);
    expect(H.drained).toHaveLength(0);
  });

  it("the cron bearer with the flag unset: 200, enqueued 0, no drain", async () => {
    process.env.CRON_SECRET = "cron-tok";
    fakeSql([{ id: "bw_a" }]);
    const res = await call("GET", "Bearer cron-tok");
    expect(res.status).toBe(200);
    expect((await res.json()).enqueued).toBe(0);
    expect(H.drained).toHaveLength(0);
  });

  it("the cron bearer with the flag on: 200 and the job ref", async () => {
    process.env.CRON_SECRET = "cron-tok";
    process.env[ROOM_AUTO_DRAIN_ENABLED_ENV] = "1";
    fakeSql([{ id: "bw_a" }]);
    const body = await (await call("GET", "Bearer cron-tok")).json();
    expect(body.cap, "the route runs under the shipped cap").toBe(AUTO_DRAIN_BATCH_LIMIT);
    expect(body.enqueued).toBe(1);
    expect(body.results).toEqual([{ window_id: "bw_a", step: "enqueued", job_id: "job_1" }]);
  });

  it("a drain that could not submit is PIPELINE_FAILED, not a 200", async () => {
    process.env.MIGRATION_SECRET = "mig-tok";
    process.env[ROOM_AUTO_DRAIN_ENABLED_ENV] = "1";
    fakeSql([{ id: "bw_a" }]);
    H.step = "engine_failed";
    expect((await call("POST", "Bearer mig-tok")).status).toBe(500);
  });

  it("a bad flag value is PIPELINE_FAILED, not a 200", async () => {
    process.env.CRON_SECRET = "cron-tok";
    process.env[ROOM_AUTO_DRAIN_ENABLED_ENV] = "enabled";
    fakeSql([{ id: "bw_a" }]);
    expect((await call("GET", "Bearer cron-tok")).status).toBe(500);
  });

  it("is scheduled every five minutes in vercel.json", () => {
    const v = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    expect(v.crons.filter((c) => c.path === "/api/admin/drain-windows")).toEqual([{ path: "/api/admin/drain-windows", schedule: "*/5 * * * *" }]);
  });
});
