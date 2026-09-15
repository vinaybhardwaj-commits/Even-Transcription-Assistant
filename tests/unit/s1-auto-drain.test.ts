/**
 * S1 — the auto-drain (lib/stt/auto-drain.ts) and its cron route (app/api/admin/drain-windows).
 *
 * TWO HALVES, TWO DATABASES.
 *   The flag, the actor and the route are proven against a recording fake: what matters there is
 *   whether the scan and the drain are reached at all, and with what.
 *   The SELECTOR, the Transcript filter, the legacy row and the refusal cooldown are proven against a REAL
 *   postgres:16 with 0041's room and bench_session, 0057, 0061, 0065, 0082 and 0092 verbatim, through
 *   BOUND parameters (tests/support/s1-pg.ts). Every
 *   exclusion is shown twice on the same row: refused, then — with only that one field changed — offered.
 *
 * THE ENVIRONMENT IS PART OF THE CONTRACT (FIX2 N4). A misspelt env name falls back to the default
 * silently, and the default is what a test would assume — so the test and the bug agree. So:
 *   - env names are written here LITERALLY, never taken from the module's own constants;
 *   - every tunable is exercised at a NON-DEFAULT value, and the fixture is derived from the value the
 *     test set, not from the module's reading of it.
 *
 * The drain is mocked for the selector, and REAL for the legacy-row proof (C1), where its recordFailure
 * must count an attempt against a row the auto-drain created.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer, type Sql } from "../support/s1-pg";
import { makeFakeOperator } from "../support/fake-identity";

const H = vi.hoisted(() => ({
  sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>,
  drained: [] as Array<{ windowId: string; origin: string; opts: Record<string, unknown> }>,
  step: "enqueued" as string,
  detail: undefined as string | undefined,
  realDrain: false,
  submits: 0,
  submitThrows: false,
  cookie: null as string | null,
  /** E22 R3 — a per-window step; null means "use `step`". */
  stepFor: null as ((windowId: string) => string) | null,
  /** E22 R3 — an `enqueued` answer also writes the room_window job the real drain's submit would. */
  writeJob: false,
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.mock("@/lib/stt/room-drain", async (orig) => {
  const actual = await orig<typeof import("@/lib/stt/room-drain")>();
  return {
    ...actual,
    drainRoomWindow: async (windowId: string, origin: string, opts: Record<string, unknown>) => {
      H.drained.push({ windowId, origin, opts });
      if (H.realDrain) return actual.drainRoomWindow(windowId, origin, opts as never);
      const step = H.stepFor ? H.stepFor(windowId) : H.step;
      if (step === "enqueued" && H.writeJob) {
        await H.sql`INSERT INTO scribe_job (id, kind, args, status) VALUES (${`job_${windowId}`}, 'room_window', ${{ window_id: windowId }}, 'queued')`;
      }
      return step === "enqueued"
        ? { window_id: windowId, ok: true, step: "enqueued", job_id: `job_${H.drained.length}` }
        : { window_id: windowId, ok: false, step, ...(H.detail ? { detail: H.detail } : {}) };
    },
  };
});
vi.mock("@/lib/room-switches", () => ({ isTranscriptEnabled: async () => true }));
vi.mock("@/lib/bench-join", async (orig) => ({ ...(await orig<Record<string, unknown>>()), joinServiceConfigured: () => true }));
vi.mock("@/lib/jobs/submit", () => ({
  submitJob: async () => {
    H.submits += 1;
    if (H.submitThrows) throw new Error("job store unavailable");
    return { id: `job_real_${H.submits}` };
  },
}));
// The cookie READ is the only seam: next/headers has no request here. The token in it is REAL — minted by
// signAdminJwt and verified by the real verifyAdminJwt (FIX3b C14) — so the door is proven to open, not
// merely to call its helpers.
vi.mock("@/lib/cookie", () => ({ readAdminCookie: async () => H.cookie }));

const { enqueueAutoDrain, clampedIntEnv, AUTO_DRAIN_BATCH_LIMIT, AUTO_DRAIN_MAX_AGE_HOURS, AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES, ROOM_AUTO_DRAIN_ENABLED_ENV } = await import("@/lib/stt/auto-drain");
const { SYSTEM_ACTOR, actorProblem } = await import("@/lib/stt/receipt");
const { FlagValueError } = await import("@/lib/flags");
type AutoDrainModule = typeof import("@/lib/stt/auto-drain");

// Literal names: the operator-facing contract, independent of the module's spelling.
const FLAG = "ROOM_AUTO_DRAIN_ENABLED";
const BATCH = "AUTO_DRAIN_BATCH_LIMIT";
const MAX_AGE = "AUTO_DRAIN_MAX_AGE_HOURS";
const COOLDOWN = "AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES";
const ENV_KEYS = [FLAG, BATCH, MAX_AGE, COOLDOWN, "CRON_SECRET", "MIGRATION_SECRET", "JWT_SECRET_ADMIN"];
let saved: Record<string, string | undefined> = {};
const silent = () => {};

beforeEach(() => {
  Object.assign(H, { step: "enqueued", detail: undefined, realDrain: false, submits: 0, submitThrows: false, cookie: null, stepFor: null, writeJob: false });
  H.drained.length = 0;
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete (process.env as Record<string, string | undefined>)[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else process.env[k] = v;
  }
});

/** A fresh module instance, reading the environment as it is set NOW. The next import is reset too. */
async function freshModule(env: Record<string, string>): Promise<AutoDrainModule> {
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  vi.resetModules();
  try {
    return await import("@/lib/stt/auto-drain");
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else process.env[k] = v;
    }
    vi.resetModules();
  }
}

/** A recording fake: every query is logged in order; the window scan answers `rows`, everything else []. */
function fakeSql(rows: Array<Record<string, unknown> & { id: string }>): { calls: string[] } {
  const log = { calls: [] as string[] };
  H.sql = (async (s: TemplateStringsArray) => {
    const text = s.join("?").replace(/\s+/g, " ");
    log.calls.push(text);
    return /FROM bench_window w/.test(text) ? rows : [];
  }) as Sql;
  return log;
}

// ═══ 1. THE FLAG — refusal paired with its proof that the refusal is not universal ═══════════════

describe("ROOM_AUTO_DRAIN_ENABLED", () => {
  it("the exported name is the documented one", () => {
    expect(ROOM_AUTO_DRAIN_ENABLED_ENV).toBe(FLAG);
  });

  it("OFF (unset): enqueued 0, no query of any kind, and NO call to drainRoomWindow", async () => {
    const db = fakeSql([{ id: "bw_a" }]);
    const r = await enqueueAutoDrain("https://x.test", { log: silent });
    expect(r).toEqual({ enqueued: 0, considered: 0, results: [] });
    expect(db.calls).toHaveLength(0);
    expect(H.drained).toHaveLength(0);
  });

  it("OFF (a documented falsy value): the same no-op", async () => {
    for (const v of ["0", "false", "off", ""]) {
      process.env[FLAG] = v;
      const db = fakeSql([{ id: "bw_a" }]);
      const r = await enqueueAutoDrain("https://x.test", { log: silent });
      expect(r.enqueued, JSON.stringify(v)).toBe(0);
      expect(db.calls, JSON.stringify(v)).toHaveLength(0);
    }
    expect(H.drained).toHaveLength(0);
  });

  it("ON, with the SAME eligible row: scan, legacy row, drain, then the refusal columns cleared — in that order", async () => {
    process.env[FLAG] = "1";
    const db = fakeSql([{ id: "bw_a" }]);
    const r = await enqueueAutoDrain("https://x.test", { log: silent });
    expect(H.drained.map((d) => d.windowId)).toEqual(["bw_a"]);
    expect(r).toEqual({ enqueued: 1, considered: 1, results: [{ window_id: "bw_a", step: "enqueued", job_id: "job_1" }] });
    expect(db.calls).toHaveLength(3);
    expect(db.calls[0]).toMatch(/FROM bench_window w/);
    expect(db.calls[1]).toMatch(/INSERT INTO stt_subject_job/);
    expect(db.calls[2]).toMatch(/SET auto_drain_refused_at = NULL, auto_drain_refused_reason = NULL/);
  });

  it("an UNRECOGNISED value throws — never read as off — and nothing is read, written or drained", async () => {
    process.env[FLAG] = "enabled";
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
  it("defaults to SYSTEM_ACTOR through the cron door — and actorProblem accepts exactly that", async () => {
    process.env[FLAG] = "1";
    fakeSql([{ id: "bw_a" }]);
    await enqueueAutoDrain("https://x.test", { log: silent });
    expect(H.drained[0]!.opts).toEqual({ actor: SYSTEM_ACTOR, via: "cron" });
    expect(H.drained[0]!.origin).toBe("https://x.test");
    expect(actorProblem(H.drained[0]!.opts as never)).toBeNull();
  });

  it("a named person through the admin door is passed through unchanged", async () => {
    process.env[FLAG] = "1";
    fakeSql([{ id: "bw_a" }]);
    await enqueueAutoDrain("https://x.test", { log: silent, actor: { actor: "adm_s1_test", via: "admin_route" } });
    expect(H.drained[0]!.opts).toEqual({ actor: "adm_s1_test", via: "admin_route" });
  });

  it("an unusable or crossed actor is refused AS A BATCH, before anything is read or written", async () => {
    process.env[FLAG] = "1";
    for (const actor of [{ actor: "", via: "admin_route" }, { actor: SYSTEM_ACTOR, via: "admin_route" }, { actor: "adm_s1_test", via: "cron" }] as const) {
      const db = fakeSql([{ id: "bw_a" }]);
      await expect(enqueueAutoDrain("https://x.test", { log: silent, actor }), JSON.stringify(actor)).rejects.toThrow(/auto-drain refused/);
      expect(db.calls, JSON.stringify(actor)).toHaveLength(0);
    }
    expect(H.drained).toHaveLength(0);
  });

  it("the constant is imported, not typed", () => {
    const code = readFileSync("lib/stt/auto-drain.ts", "utf8");
    expect(code).toContain("actor: SYSTEM_ACTOR");
    expect(code).not.toContain('"system:cron"');
  });

  it("a window the drain refuses by name is reported with its detail, not counted", async () => {
    process.env[FLAG] = "1";
    fakeSql([{ id: "bw_a" }]);
    Object.assign(H, { step: "join_failed", detail: "join_service_not_configured" });
    const r = await enqueueAutoDrain("https://x.test", { log: silent });
    expect(r).toEqual({ enqueued: 0, considered: 1, results: [{ window_id: "bw_a", step: "join_failed", detail: "join_service_not_configured" }] });
    expect(readFileSync("lib/stt/auto-drain.ts", "utf8")).not.toMatch(/isTranscriptEnabled\(/);
  });
});

describe("the env constants — defaults, clamps, and every NAME read at a non-default value", () => {
  it("the shipped defaults are 1, 6 and 60", () => {
    expect(AUTO_DRAIN_BATCH_LIMIT).toBe(1);
    expect(AUTO_DRAIN_MAX_AGE_HOURS).toBe(6);
    expect(AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES).toBe(60);
  });

  it("each literal env name is READ: an in-range non-default value comes back as set", async () => {
    const m = await freshModule({ [BATCH]: "3", [MAX_AGE]: "2", [COOLDOWN]: "15" });
    expect(m.AUTO_DRAIN_BATCH_LIMIT).toBe(3);
    expect(m.AUTO_DRAIN_MAX_AGE_HOURS).toBe(2);
    expect(m.AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES).toBe(15);
  });

  it("each is CLAMPED to its own range: 1..10, 1..48, 5..1440", async () => {
    const hi = await freshModule({ [BATCH]: "999", [MAX_AGE]: "999", [COOLDOWN]: "99999" });
    expect([hi.AUTO_DRAIN_BATCH_LIMIT, hi.AUTO_DRAIN_MAX_AGE_HOURS, hi.AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES]).toEqual([10, 48, 1440]);
    const lo = await freshModule({ [BATCH]: "0", [MAX_AGE]: "0", [COOLDOWN]: "0" });
    expect([lo.AUTO_DRAIN_BATCH_LIMIT, lo.AUTO_DRAIN_MAX_AGE_HOURS, lo.AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES]).toEqual([1, 1, 5]);
  });

  it("clampedIntEnv: anything that is not a whole number is the default", () => {
    expect(clampedIntEnv("N", 1, 1, 10, { N: " 4 " })).toBe(4);
    expect(clampedIntEnv("N", 1, 1, 10, { N: "-3" })).toBe(1);
    for (const v of ["", "abc", "2.5", "1e3", "4h"]) expect(clampedIntEnv("N", 6, 1, 48, { N: v }), v).toBe(6);
    expect(clampedIntEnv("N", 6, 1, 48, {})).toBe(6);
  });

  it("the cap cannot be raised by the caller's limit", async () => {
    // E17: the cap is applied by orderAutoDrainOffers after the scan, not as a SQL LIMIT. So the proof is
    // behavioural: more eligible windows than the cap, in more rooms than the cap, and a caller limit above it.
    process.env[FLAG] = "1";
    const n = AUTO_DRAIN_BATCH_LIMIT + 5;
    fakeSql(Array.from({ length: n }, (_, i) => ({ id: `bw_${i}`, room_id: `room_${i}`, start_ms: i * 900_000, end_ms: (i + 1) * 900_000, closed_ms: 0, last_served_ms: null })));
    const r = await enqueueAutoDrain("https://x.test", { limit: n, log: silent });
    expect(r.considered).toBe(AUTO_DRAIN_BATCH_LIMIT);
    expect(H.drained).toHaveLength(AUTO_DRAIN_BATCH_LIMIT);
  });

  it("E17: the scan's last_served_ms reaches the ranking — a recently served room with the newer window yields the slot", async () => {
    process.env[FLAG] = "1";
    // The scan returns numerics as strings, as the driver does for float8/bigint; the seam must convert them.
    fakeSql([
      { id: "bw_served_newer", room_id: "room_a", start_ms: "7200000", end_ms: "8100000", closed_ms: "8160000", last_served_ms: "8000000" },
      { id: "bw_waiting_older", room_id: "room_b", start_ms: "900000", end_ms: "1800000", closed_ms: "1860000", last_served_ms: null },
    ]);
    const r = await enqueueAutoDrain("https://x.test", { log: silent });
    expect(r.considered).toBe(1);
    expect(H.drained.map((d) => d.windowId), "room_b was never served; room_a was, so room_b goes first despite the older slot").toEqual(["bw_waiting_older"]);
  });
});

// ═══ 2. THE SELECTOR, THE LEGACY ROW AND THE COOLDOWN, AGAINST A REAL POSTGRES ═══════════════════

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-s1-auto-drain");

describe("REQUIRED PROOF — the auto-drain selector against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/s1-auto-drain.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that the selector was not proven.");
  });
});

const noRecord = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  // room and bench_session from 0041 verbatim, room.transcript_enabled from 0065 verbatim.
  const m0041 = readFileSync("db/migrations/0041_room_bench.sql", "utf8");
  const keep = (name: string) => { const i = m0041.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`); return m0041.slice(i, m0041.indexOf(");", i) + 2); };
  pg.exec("CREATE TABLE schema_migrations (version int PRIMARY KEY, name text);");
  pg.exec(keep("room"));
  pg.exec(noRecord("db/migrations/0065_room_processing_switches.sql"));
  pg.exec(keep("bench_session"));
  pg.exec(`
    INSERT INTO room (id, slug, name, pin_hash, transcript_enabled) VALUES ('room_on', 'on', 'On', 'x', TRUE), ('room_off', 'off', 'Off', 'x', FALSE);
    INSERT INTO bench_session (id, room_id) VALUES ('sess_1', 'room_on'), ('sess_off', 'room_off');
  `);
  pg.exec(noRecord("db/migrations/0057_bench_window.sql"));
  pg.exec(noRecord("db/migrations/0061_stt_subject_job.sql"));
  pg.exec(noRecord("db/migrations/0082_scribe_job.sql"));
  pg.exec(noRecord("db/migrations/0092_bench_window_auto_drain_refusal.sql"));
}, 180_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

let startMs = 0;
/** A window eligible in every respect unless overridden. `ageMin` is minutes since close; `refusedMin` minutes since a refusal. */
function windowRow(id: string, o: { ageMin?: number; state?: string; grid?: boolean; roomDay?: string | null; refusedMin?: number; session?: string } = {}): void {
  startMs += 900_000;
  const q = (v: string | null) => (v === null ? "NULL" : `'${v}'`);
  pg.exec(`INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, grid_aligned, state, closed_at, auto_drain_refused_at, auto_drain_refused_reason)
           VALUES ('${id}', '${o.session ?? "sess_1"}', ${q(o.roomDay === undefined ? "rd_1" : o.roomDay)}, ${startMs}, ${startMs + 900_000}, 'primary',
                   ${o.grid ?? true}, '${o.state ?? "closed"}', NOW() - (${o.ageMin ?? 10} * INTERVAL '1 minute'),
                   ${o.refusedMin === undefined ? "NULL" : `NOW() - (${o.refusedMin} * INTERVAL '1 minute')`},
                   ${o.refusedMin === undefined ? "NULL" : "'flag_off'"});`);
}
const row = async (id: string) =>
  ((await pg.sql`SELECT state, auto_drain_refused_at IS NOT NULL AS refused, auto_drain_refused_reason AS reason FROM bench_window WHERE id = ${id}`) as Array<{ state: string; refused: boolean; reason: string | null }>)[0]!;
const offered = () => H.drained.map((d) => d.windowId);
const drainOnce = async (mod: Pick<AutoDrainModule, "enqueueAutoDrain"> = { enqueueAutoDrain }) => {
  H.drained.length = 0;
  return mod.enqueueAutoDrain("https://x.test", { log: silent });
};
const resetDb = () => {
  pg.exec("TRUNCATE bench_window, scribe_job, stt_subject_job; UPDATE room SET transcript_enabled = (id = 'room_on');");
  H.sql = pg.sql;
  process.env[FLAG] = "1";
};

describe.skipIf(!HAVE_DOCKER)("the selector — each exclusion, then the same row with only that field changed", () => {
  const maxAgeMin = AUTO_DRAIN_MAX_AGE_HOURS * 60;
  beforeEach(resetDb);

  it("closed longer ago than AUTO_DRAIN_MAX_AGE_HOURS is refused; just inside it is offered", async () => {
    windowRow("bw_age", { ageMin: maxAgeMin + 5 });
    expect((await drainOnce()).considered).toBe(0);
    await pg.sql`UPDATE bench_window SET closed_at = NOW() - (${maxAgeMin - 5}::int * INTERVAL '1 minute') WHERE id = 'bw_age'`;
    expect((await drainOnce()).considered).toBe(1);
    expect(offered()).toEqual(["bw_age"]);
  });

  it("AUTO_DRAIN_MAX_AGE_HOURS at a NON-DEFAULT value is the bound actually applied", async () => {
    const hours = 2;
    expect(hours * 60 + 5, "the fixture must fall inside the DEFAULT bound, or it proves nothing").toBeLessThan(maxAgeMin);
    const m = await freshModule({ [MAX_AGE]: String(hours) });
    windowRow("bw_age2", { ageMin: hours * 60 + 5 });
    expect((await drainOnce(m)).considered, "outside the configured bound").toBe(0);
    expect((await drainOnce()).considered, "the default module still offers it — so the env value is what refused it").toBe(1);
    pg.exec("UPDATE bench_window SET auto_drain_refused_at = NULL, auto_drain_refused_reason = NULL;");
    await pg.sql`UPDATE bench_window SET closed_at = NOW() - (${hours * 60 - 5}::int * INTERVAL '1 minute') WHERE id = 'bw_age2'`;
    expect((await drainOnce(m)).considered).toBe(1);
  });

  it("grid_aligned = false is refused; true is offered", async () => {
    windowRow("bw_grid", { grid: false });
    expect((await drainOnce()).considered).toBe(0);
    pg.exec("UPDATE bench_window SET grid_aligned = TRUE WHERE id = 'bw_grid';");
    expect((await drainOnce()).considered).toBe(1);
    expect(offered()).toEqual(["bw_grid"]);
  });

  it("a null room_day_id is refused; a set one is offered", async () => {
    windowRow("bw_day", { roomDay: null });
    expect((await drainOnce()).considered).toBe(0);
    pg.exec("UPDATE bench_window SET room_day_id = 'rd_1' WHERE id = 'bw_day';");
    expect((await drainOnce()).considered).toBe(1);
    expect(offered()).toEqual(["bw_day"]);
  });

  it("a state other than closed is refused; closed is offered", async () => {
    for (const s of ["open", "transcribing", "transcribed", "failed"]) {
      pg.exec("TRUNCATE bench_window;");
      windowRow("bw_state", { state: s });
      expect((await drainOnce()).considered, s).toBe(0);
    }
    pg.exec("UPDATE bench_window SET state = 'closed' WHERE id = 'bw_state';");
    expect((await drainOnce()).considered).toBe(1);
  });

  it("a queued or running room_window job for the window is refused; a finished one, or another kind, is not", async () => {
    windowRow("bw_job");
    const clear = () => pg.exec("UPDATE bench_window SET auto_drain_refused_at = NULL, auto_drain_refused_reason = NULL;");
    for (const status of ["queued", "running"]) {
      pg.exec(`TRUNCATE scribe_job; INSERT INTO scribe_job (id, kind, args, status) VALUES ('job_live', 'room_window', '{"window_id":"bw_job"}', '${status}');`);
      expect((await drainOnce()).considered, status).toBe(0);
    }
    for (const status of ["done", "failed", "cancelled"]) {
      clear();
      pg.exec(`UPDATE scribe_job SET status = '${status}' WHERE id = 'job_live';`);
      expect((await drainOnce()).considered, status).toBe(1);
    }
    clear();
    pg.exec(`TRUNCATE scribe_job; INSERT INTO scribe_job (id, kind, args, status) VALUES ('job_other', 'diarize_window', '{"window_id":"bw_job"}', 'queued');`);
    expect((await drainOnce()).considered).toBe(1);
    expect(offered()).toEqual(["bw_job"]);
  });
});

describe.skipIf(!HAVE_DOCKER)("the Transcript filter (FIX3b C8) — in the selector, before the LIMIT", () => {
  beforeEach(resetDb);
  const legacyRows = async (id: string) =>
    ((await pg.sql`SELECT count(*)::int AS n FROM stt_subject_job WHERE subject_type = 'bench_window' AND subject_id = ${id}`) as Array<{ n: number }>)[0]!.n;

  it("a window in a Transcript-OFF room is not selected and gets NO legacy row; the identical window in a Transcript-ON room is, and does", async () => {
    windowRow("bw_room_off", { session: "sess_off" });
    expect((await drainOnce()).considered).toBe(0);
    expect(offered()).toEqual([]);
    expect(await legacyRows("bw_room_off"), "it must not leave the room card's waiting count").toBe(0);

    windowRow("bw_room_on", { session: "sess_1" });
    expect((await drainOnce()).considered).toBe(1);
    expect(offered()).toEqual(["bw_room_on"]);
    expect(await legacyRows("bw_room_on")).toBe(1);
    expect(await legacyRows("bw_room_off")).toBe(0);
  });

  it("the same window is offered once its room's switch is turned on — only that one field changed", async () => {
    windowRow("bw_flip", { session: "sess_off" });
    expect((await drainOnce()).considered).toBe(0);
    pg.exec("UPDATE room SET transcript_enabled = TRUE WHERE id = 'room_off';");
    expect((await drainOnce()).considered).toBe(1);
    expect(offered()).toEqual(["bw_flip"]);
  });

  it("a newer Transcript-off window cannot take the slot from an older Transcript-on one", async () => {
    windowRow("bw_on_older", { session: "sess_1", ageMin: 60 });
    windowRow("bw_off_newer", { session: "sess_off", ageMin: 1 });
    await drainOnce();
    expect(offered()).toEqual(["bw_on_older"]);
  });

  it("drainRoomWindow keeps its own Transcript check on entry — the selector's filter is on top, not instead", () => {
    const drain = readFileSync("lib/stt/room-drain.ts", "utf8");
    expect(drain).toContain(`if (!(await isTranscriptEnabled(w.room_id))) return { ...out, step: "flag_off" };`);
  });
});

describe.skipIf(!HAVE_DOCKER)("the refusal cooldown (0092)", () => {
  beforeEach(resetDb);

  it("any step but enqueued records the refusal with the step as its reason", async () => {
    for (const step of ["flag_off", "too_long", "join_failed", "wrong_state", "no_room_day", "engine_failed"]) {
      pg.exec("TRUNCATE bench_window;");
      windowRow("bw_ref");
      H.step = step;
      await drainOnce();
      expect(await row("bw_ref"), step).toMatchObject({ refused: true, reason: step });
    }
  });

  it("a refused window is NOT offered again inside AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES; just past it, it is", async () => {
    windowRow("bw_cool");
    H.step = "flag_off";
    expect((await drainOnce()).considered).toBe(1);
    expect((await drainOnce()).considered, "the same refused window must not hold the slot on the next tick").toBe(0);
    await pg.sql`UPDATE bench_window SET auto_drain_refused_at = NOW() - (${AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES - 5}::int * INTERVAL '1 minute') WHERE id = 'bw_cool'`;
    expect((await drainOnce()).considered, "still inside the cooldown").toBe(0);
    await pg.sql`UPDATE bench_window SET auto_drain_refused_at = NOW() - (${AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES + 5}::int * INTERVAL '1 minute') WHERE id = 'bw_cool'`;
    expect((await drainOnce()).considered).toBe(1);
  });

  it("a refused window does not starve a fresh one: the fresh window gets the slot", async () => {
    windowRow("bw_fresh", { ageMin: 30 });
    windowRow("bw_refused_newer", { ageMin: 5, refusedMin: 1 });
    await drainOnce();
    expect(offered()).toEqual(["bw_fresh"]);
  });

  it("AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES at a NON-DEFAULT value is the cooldown actually applied", async () => {
    const minutes = 15;
    expect(minutes + 5, "the fixture must fall inside the DEFAULT cooldown, or it proves nothing").toBeLessThan(AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES);
    const m = await freshModule({ [COOLDOWN]: String(minutes) });
    windowRow("bw_cool2", { refusedMin: minutes + 5 });
    expect((await drainOnce()).considered, "the default cooldown still holds it").toBe(0);
    expect((await drainOnce(m)).considered, "the configured cooldown has passed").toBe(1);
    pg.exec("TRUNCATE bench_window;");
    windowRow("bw_cool3", { refusedMin: minutes - 5 });
    expect((await drainOnce(m)).considered, "inside the configured cooldown").toBe(0);
  });

  it("a successful enqueue CLEARS both columns", async () => {
    windowRow("bw_clear", { refusedMin: AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES + 5 });
    expect(await row("bw_clear")).toMatchObject({ refused: true, reason: "flag_off" });
    await drainOnce();
    expect(await row("bw_clear")).toMatchObject({ refused: false, reason: null });
  });
});

describe.skipIf(!HAVE_DOCKER)("the legacy row (C1) — through the REAL drain", () => {
  beforeEach(() => { resetDb(); H.realDrain = true; });
  const job = async (id: string) =>
    (await pg.sql`SELECT state, attempts, last_error FROM stt_subject_job WHERE subject_type = 'bench_window' AND subject_id = ${id} AND tier = 'asr'`) as Array<{ state: string; attempts: number; last_error: string | null }>;

  it("a window with NO legacy row is drained ONCE, and its failure counts a real attempt", async () => {
    windowRow("bw_nolegacy");
    expect(await job("bw_nolegacy"), "the premise: no row").toEqual([]);
    H.submitThrows = true;
    const r = await drainOnce();
    expect(r.results).toMatchObject([{ window_id: "bw_nolegacy", step: "engine_failed" }]);
    expect(H.submits).toBe(1);
    const j = await job("bw_nolegacy");
    expect(j).toHaveLength(1);
    expect(j[0]!.attempts, "without the row, recordFailure counted 0 and the window never parked").toBe(1);
    expect(j[0]!.last_error).toMatch(/^engine_failed/);
    expect((await row("bw_nolegacy")).state, "back to closed, with an attempt on the books").toBe("closed");

    expect((await drainOnce()).considered, "and not offered again on the next tick").toBe(0);
    expect(H.submits).toBe(1);
  });

  it("control: a window that ALREADY has its legacy row keeps that one row — its attempts carry on from it", async () => {
    windowRow("bw_legacy");
    pg.exec("INSERT INTO stt_subject_job (subject_type, subject_id, tier, state, attempts) VALUES ('bench_window', 'bw_legacy', 'asr', 'queued', 1);");
    H.submitThrows = true;
    await drainOnce();
    const j = await job("bw_legacy");
    expect(j).toHaveLength(1);
    expect(j[0]!.attempts, "the existing row was used, not replaced").toBe(2);
  });

  it("and the success path: enqueued, claimed, and the job ref returned", async () => {
    windowRow("bw_ok", { refusedMin: AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES + 5 });
    const r = await drainOnce();
    expect(r).toMatchObject({ enqueued: 1, considered: 1, results: [{ window_id: "bw_ok", step: "enqueued", job_id: "job_real_1" }] });
    expect(await row("bw_ok")).toMatchObject({ state: "transcribing", refused: false, reason: null });
    expect(await job("bw_ok")).toMatchObject([{ state: "running" }]);
  });
});

describe.skipIf(!HAVE_DOCKER)("the cap and the order", () => {
  beforeEach(resetDb);

  /**
   * CAP + 2 eligible windows, ages spread evenly inside AUTO_DRAIN_MAX_AGE_HOURS. Returns their ids
   * newest-closed first. Inserted in the order [1, 0, 2, 3, ...], so start_ms rises with insertion:
   * neither insertion order, start_ms ASC nor start_ms DESC puts the newest-closed window first.
   */
  function seedScrambled(cap: number, maxAgeHours: number): string[] {
    const n = cap + 2;
    const step = Math.floor((maxAgeHours * 60) / (n + 1));
    const ages = Array.from({ length: n }, (_, i) => (i + 1) * step);
    for (const i of [1, 0, ...Array.from({ length: n - 2 }, (_, k) => k + 2)]) windowRow(`bw_rank_${i}`, { ageMin: ages[i] });
    return ages.map((_, i) => `bw_rank_${i}`);
  }

  it("the shipped cap: AUTO_DRAIN_BATCH_LIMIT window, the NEWEST SLOT in the room — which here closed longest ago (E17 R6)", async () => {
    const newestClosedFirst = seedScrambled(AUTO_DRAIN_BATCH_LIMIT, AUTO_DRAIN_MAX_AGE_HOURS);
    // start_ms rises with insertion; the last inserted has the newest slot and the OLDEST closed_at.
    const newestSlot = newestClosedFirst.at(-1)!;
    const r = await drainOnce();
    expect(r.considered).toBe(AUTO_DRAIN_BATCH_LIMIT);
    expect(offered()).toEqual([newestSlot]);
    expect(offered(), "closed_at DESC would have taken a different window").not.toEqual(newestClosedFirst.slice(0, 1));
  });

  it("AUTO_DRAIN_BATCH_LIMIT at a NON-DEFAULT value: one window per room, up to the cap", async () => {
    const cap = 3;
    expect(cap, "a non-default cap").not.toBe(AUTO_DRAIN_BATCH_LIMIT);
    const m = await freshModule({ [BATCH]: String(cap) });
    pg.exec(`INSERT INTO room (id, slug, name, pin_hash, transcript_enabled) VALUES ('room_c1', 'c1', 'C1', 'x', TRUE), ('room_c2', 'c2', 'C2', 'x', TRUE)
             ON CONFLICT (id) DO UPDATE SET transcript_enabled = TRUE;
             INSERT INTO bench_session (id, room_id) VALUES ('sess_c1', 'room_c1'), ('sess_c2', 'room_c2') ON CONFLICT (id) DO NOTHING;`);
    seedScrambled(cap, AUTO_DRAIN_MAX_AGE_HOURS); // cap + 2 windows, all in room_on
    windowRow("bw_c1", { session: "sess_c1" });
    const r = await drainOnce(m);
    expect(r.considered, "room_on holds five windows but takes one; room_c1 takes one; room_c2 has none").toBe(2);
    expect(offered()).toContain("bw_c1");
  });
});

describe.skipIf(!HAVE_DOCKER)("E17 — last served, derived from scribe_job, in the selector", () => {
  beforeEach(() => {
    resetDb();
    pg.exec(`INSERT INTO room (id, slug, name, pin_hash, transcript_enabled) VALUES ('room_two', 'two', 'Two', 'x', TRUE)
             ON CONFLICT (id) DO UPDATE SET transcript_enabled = TRUE;
             INSERT INTO bench_session (id, room_id) VALUES ('sess_two', 'room_two') ON CONFLICT (id) DO NOTHING;`);
  });
  const servedJob = (id: string, windowId: string, minutesAgo: number) =>
    pg.exec(`INSERT INTO scribe_job (id, kind, args, status, created_at) VALUES ('${id}', 'room_window', '{"window_id": "${windowId}"}', 'done', NOW() - (${minutesAgo} * INTERVAL '1 minute'));`);

  it("the room served more recently waits; the other room takes the slot even though its window is older", async () => {
    windowRow("bw_on_done", { state: "transcribed" });
    windowRow("bw_two_old", { session: "sess_two", ageMin: 40 });
    windowRow("bw_on_new", { ageMin: 5 });
    servedJob("job_on", "bw_on_done", 5);
    await drainOnce();
    expect(offered()).toEqual(["bw_two_old"]);
  });

  it("a room_window job older than AUTO_DRAIN_MAX_AGE_HOURS does not count as served", async () => {
    windowRow("bw_two_done", { session: "sess_two", state: "transcribed" });
    windowRow("bw_on_a", { ageMin: 30 });
    windowRow("bw_two_b", { session: "sess_two", ageMin: 5 });
    servedJob("job_two_old", "bw_two_done", AUTO_DRAIN_MAX_AGE_HOURS * 60 + 30);
    await drainOnce();
    expect(offered(), "neither room served inside the horizon: the newer slot wins").toEqual(["bw_two_b"]);
  });

  it("a window verified 18 hours late, in a room never served, does not take the slot from a fresh window in another (R6)", async () => {
    windowRow("bw_fresh_two", { session: "sess_two", ageMin: 10 });
    pg.exec(`UPDATE bench_window SET start_ms = start_ms + 100 * 900000, end_ms = end_ms + 100 * 900000 WHERE id = 'bw_fresh_two';`);
    windowRow("bw_late_verify", { ageMin: 1 });
    pg.exec(`UPDATE bench_window SET start_ms = 0, end_ms = 900000 WHERE id = 'bw_late_verify';`);
    await drainOnce();
    expect(offered()).toEqual(["bw_fresh_two"]);
  });
});

describe.skipIf(!HAVE_DOCKER)("E22 R3 — a room is served when its slot is OFFERED, not when a job is created (F1)", () => {
  beforeEach(() => {
    resetDb();
    pg.exec(`INSERT INTO room (id, slug, name, pin_hash, transcript_enabled) VALUES ('room_two', 'two', 'Two', 'x', TRUE)
             ON CONFLICT (id) DO UPDATE SET transcript_enabled = TRUE;
             INSERT INTO bench_session (id, room_id) VALUES ('sess_two', 'room_two') ON CONFLICT (id) DO NOTHING;`);
  });

  it("a room with a window refused inside the horizon has had its turn: the other room's OLDER window takes the slot", async () => {
    windowRow("bw_on_refused", { refusedMin: 5 });
    windowRow("bw_two_old", { session: "sess_two", ageMin: 40 });
    windowRow("bw_on_new", { ageMin: 5 });
    await drainOnce();
    expect(offered(), "with no job anywhere, a job-only 'served' leaves both rooms null and the newer slot wins").toEqual(["bw_two_old"]);
  });

  it("control: a refusal older than AUTO_DRAIN_MAX_AGE_HOURS is not a turn — the newer slot wins again", async () => {
    windowRow("bw_on_refused", { refusedMin: AUTO_DRAIN_MAX_AGE_HOURS * 60 + 30 });
    windowRow("bw_two_old", { session: "sess_two", ageMin: 40 });
    windowRow("bw_on_new", { ageMin: 5 });
    await drainOnce();
    expect(offered()).toContain("bw_on_new");
    expect(offered()).toHaveLength(1);
  });

  it("through the loop: every refusal step the drain can give — flag_off and join_service_not_configured included — makes the room wait its turn", async () => {
    for (const [step, detail] of [["flag_off"], ["join_failed", "join_service_not_configured"], ["too_long", "31m"], ["wrong_state", "claim_lost"], ["engine_failed"], ["no_room_day"]] as Array<[string, string?]>) {
      pg.exec("TRUNCATE bench_window, scribe_job, stt_subject_job;");
      windowRow("bw_two_old", { session: "sess_two", ageMin: 40 });
      windowRow("bw_on_first", { ageMin: 10 });
      windowRow("bw_on_second", { ageMin: 5 });
      H.step = step; H.detail = detail;
      await drainOnce();
      expect(offered(), `${step}: the first tick goes to room_on's newest slot`).toEqual(["bw_on_second"]);
      H.step = "enqueued"; H.detail = undefined;
      await drainOnce();
      expect(offered(), `${step}: room_on was offered a slot and refused it — that was its turn`).toEqual(["bw_two_old"]);
    }
  });

  it("an enqueue is still a turn: the job the drain writes marks the room served", async () => {
    H.writeJob = true;
    windowRow("bw_two_old", { session: "sess_two", ageMin: 40 });
    windowRow("bw_on_first", { ageMin: 10 });
    windowRow("bw_on_second", { ageMin: 5 });
    await drainOnce();
    expect(offered()).toEqual(["bw_on_second"]);
    await drainOnce();
    expect(offered()).toEqual(["bw_two_old"]);
  });

  /**
   * THE REFUTATION'S S2, ON THE REAL SELECTOR (ETA-E11-E17-REFUTATION §4). Six rooms, 36 windows each, each kiosk's
   * phase fixed at 20-25 s, a tick every 300 s to one hour past the clinic, cap 1, 6 h horizon, 60 min cooldown.
   * One room refuses every offer before the claim. Time is advanced by moving every stored timestamp back one tick,
   * so NOW() stays the database's own and the SQL under test is the shipped statement, not a model of it.
   * Before R3 the refusing room held 98-100 of 117 slots and the other five got 3-4 each.
   */
  it("S2: one room refuses every offer — the slots stay spread across all six rooms", async () => {
    const GRID = 900, TICK = 300, CLINIC = 9 * 3600, PHASE = [20, 21, 22, 23, 24, 25], REFUSER = 5;
    pg.exec(PHASE.map((_, r) => `INSERT INTO room (id, slug, name, pin_hash, transcript_enabled) VALUES ('room_s${r}', 's${r}', 'S${r}', 'x', TRUE) ON CONFLICT (id) DO UPDATE SET transcript_enabled = TRUE;
      INSERT INTO bench_session (id, room_id) VALUES ('sess_s${r}', 'room_s${r}') ON CONFLICT (id) DO NOTHING;`).join("\n"));
    H.writeJob = true;
    H.stepFor = (id) => (id.startsWith(`s${REFUSER}_`) ? "flag_off" : "enqueued");
    const slots = Array(PHASE.length).fill(0) as number[];
    let prev = 0;
    for (let t = TICK; t <= CLINIC + 3600; t += TICK) {
      const closing: string[] = [];
      for (let r = 0; r < PHASE.length; r++)
        for (let k = 0; k < CLINIC / GRID; k++) {
          const end = (k + 1) * GRID, closed = end + PHASE[r]!;
          if (closed > prev && closed <= t)
            closing.push(`('s${r}_k${k}', 'sess_s${r}', 'rd_1', ${(end - GRID) * 1000}, ${end * 1000}, 'primary', TRUE, 'closed', NOW() - (${t - closed} * INTERVAL '1 second'))`);
        }
      if (closing.length) pg.exec(`INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, grid_aligned, state, closed_at) VALUES ${closing.join(",\n")};`);
      prev = t;
      await drainOnce();
      for (const id of offered()) slots[Number(id.slice(1, id.indexOf("_")))]! += 1;
      pg.exec(`UPDATE bench_window SET closed_at = closed_at - INTERVAL '${TICK} seconds', auto_drain_refused_at = auto_drain_refused_at - INTERVAL '${TICK} seconds';
               UPDATE scribe_job SET created_at = created_at - INTERVAL '${TICK} seconds';`);
    }
    const total = slots.reduce((a, b) => a + b, 0);
    console.log(`[E22 S2] slots per room ${slots.join("/")} of ${total}; room_s${REFUSER} refuses every offer`);
    expect(total, "the scenario must actually offer slots").toBeGreaterThan(100);
    expect(Math.max(...slots) - Math.min(...slots), `flat: ${slots.join("/")}`).toBeLessThanOrEqual(2);
  }, 180_000);
});

// ═══ THE ROUTE AND THE CRON ═══════════════════════════════════════════════════════════════════════

describe("/api/admin/drain-windows", () => {
  const call = async (method: "GET" | "POST", auth?: string) => {
    const route = await import("@/app/api/admin/drain-windows/route");
    const req = new NextRequest("https://x.test/api/admin/drain-windows", { method, ...(auth ? { headers: { authorization: auth } } : {}) });
    return method === "GET" ? route.GET(req) : route.POST(req);
  };

  it("GET: 401 without the cron or migration secret, and nothing is read or drained", async () => {
    process.env.CRON_SECRET = "cron-tok";
    process.env[FLAG] = "1";
    const db = fakeSql([{ id: "bw_a" }]);
    for (const auth of [undefined, "Bearer wrong", "cron-tok"]) expect((await call("GET", auth)).status, String(auth)).toBe(401);
    expect(db.calls).toHaveLength(0);
    expect(H.drained).toHaveLength(0);
  });

  it("GET with the flag unset: 200, enqueued 0, no drain", async () => {
    process.env.CRON_SECRET = "cron-tok";
    fakeSql([{ id: "bw_a" }]);
    const res = await call("GET", "Bearer cron-tok");
    expect(res.status).toBe(200);
    expect((await res.json()).enqueued).toBe(0);
    expect(H.drained).toHaveLength(0);
  });

  it("GET records SYSTEM_ACTOR / cron, under the shipped cap — on either secret", async () => {
    process.env.CRON_SECRET = "cron-tok";
    process.env.MIGRATION_SECRET = "mig-tok";
    process.env[FLAG] = "1";
    for (const auth of ["Bearer cron-tok", "Bearer mig-tok"]) {
      H.drained.length = 0;
      fakeSql([{ id: "bw_a" }]);
      const res = await call("GET", auth);
      expect(res.status, auth).toBe(200);
      const body = await res.json();
      expect(body.cap).toBe(AUTO_DRAIN_BATCH_LIMIT);
      expect(body.results).toEqual([{ window_id: "bw_a", step: "enqueued", job_id: "job_1" }]);
      expect(H.drained[0]!.opts, auth).toEqual({ actor: SYSTEM_ACTOR, via: "cron" });
    }
  });

  /** A REAL admin token, through the repo's own signing path (lib/auth signAdminJwt). */
  const mint = async (adminId: string, secret = "s1-test-admin-secret") => {
    process.env.JWT_SECRET_ADMIN = secret;
    const { signAdminJwt } = await import("@/lib/auth");
    return signAdminJwt({ admin_id: adminId, email: makeFakeOperator(1).email });
  };

  it("POST with a REAL signed-in admin token SUCCEEDS, verified by the real verifyAdminJwt, and records that admin's id through admin_route", async () => {
    process.env[FLAG] = "1";
    H.cookie = await mint("adm_s1_test");
    fakeSql([{ id: "bw_a" }]);
    const res = await call("POST");
    expect(res.status).toBe(200);
    expect((await res.json()).enqueued).toBe(1);
    expect(H.drained[0]!.opts).toEqual({ actor: "adm_s1_test", via: "admin_route" });
    expect(actorProblem(H.drained[0]!.opts as never)).toBeNull();
    const { verifyAdminJwt } = await import("@/lib/auth");
    expect(vi.isMockFunction(verifyAdminJwt), "the JWT check is the real one").toBe(false);
  });

  it("POST with a token signed under a DIFFERENT secret is refused — the same minting path, only the key changed", async () => {
    process.env[FLAG] = "1";
    const db = fakeSql([{ id: "bw_a" }]);
    H.cookie = await mint("adm_s1_test", "some-other-secret");
    process.env.JWT_SECRET_ADMIN = "s1-test-admin-secret";
    expect((await call("POST")).status).toBe(401);
    expect(db.calls).toHaveLength(0);
    expect(H.drained).toHaveLength(0);
  });

  it("POST with only MIGRATION_SECRET is refused, and says a manual drain records spend against a person", async () => {
    process.env.MIGRATION_SECRET = "mig-tok";
    process.env[FLAG] = "1";
    const db = fakeSql([{ id: "bw_a" }]);
    const res = await call("POST", "Bearer mig-tok");
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).toMatch(/records spend against a person and requires a signed-in admin/);
    expect(db.calls).toHaveLength(0);
    expect(H.drained).toHaveLength(0);
  });

  it("POST with a real token that verifies but names nobody is refused admin_id_missing_from_token; a malformed token is refused", async () => {
    process.env[FLAG] = "1";
    const db = fakeSql([{ id: "bw_a" }]);
    H.cookie = await mint("");
    const res = await call("POST");
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).toMatch(/admin_id_missing_from_token/);
    H.cookie = "not-a-jwt";
    expect((await call("POST")).status).toBe(401);
    expect(db.calls).toHaveLength(0);
    expect(H.drained).toHaveLength(0);
  });

  it("join_failed with join_service_not_configured is PIPELINE_FAILED; join_failed for any other reason stays 200", async () => {
    process.env.CRON_SECRET = "cron-tok";
    process.env[FLAG] = "1";
    fakeSql([{ id: "bw_a" }]);
    Object.assign(H, { step: "join_failed", detail: "join_service_not_configured" });
    expect((await call("GET", "Bearer cron-tok")).status).toBe(500);
    fakeSql([{ id: "bw_a" }]);
    Object.assign(H, { step: "join_failed", detail: "join_http_502" });
    expect((await call("GET", "Bearer cron-tok")).status).toBe(200);
  });

  it("a named per-window refusal stays 200; a drain that could not submit is PIPELINE_FAILED", async () => {
    process.env.CRON_SECRET = "cron-tok";
    process.env[FLAG] = "1";
    fakeSql([{ id: "bw_a" }]);
    H.step = "flag_off";
    expect((await call("GET", "Bearer cron-tok")).status).toBe(200);
    fakeSql([{ id: "bw_a" }]);
    H.step = "engine_failed";
    expect((await call("GET", "Bearer cron-tok")).status).toBe(500);
  });

  it("a bad flag value is PIPELINE_FAILED, not a 200", async () => {
    process.env.CRON_SECRET = "cron-tok";
    process.env[FLAG] = "enabled";
    fakeSql([{ id: "bw_a" }]);
    expect((await call("GET", "Bearer cron-tok")).status).toBe(500);
  });

  it("is scheduled every five minutes in vercel.json", () => {
    const v = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    expect(v.crons.filter((c) => c.path === "/api/admin/drain-windows")).toEqual([{ path: "/api/admin/drain-windows", schedule: "*/5 * * * *" }]);
  });
});
