/**
 * ROOM WATCHDOG ALERT OUTBOX — migration 0119, persistPlan, the read door and the heartbeat, AGAINST A REAL POSTGRES.
 *
 * The design (docs/handoff/ETA-WATCHDOG-ALERTS-DESIGN-24-SEP-2026.md) was refuted twice by eta-refuter before any of this existed, and the tests here are
 * the ones it asked for. Failure is injected INSIDE the statement, as e31b-atomicity does, because atomicity is a property of the database, not of a mock.
 *   F1  the outbox is fed FROM the planner's messages, so a seed and a muted room queue nothing and a fleet outage queues ONE row;
 *   F2  two overlapping runs over the same edge queue exactly one alert;
 *   F7  100+ already-delivered rows in the lookback cannot starve a new one;
 *   F9  no heartbeat yet reads `none`, never healthy.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));
vi.mock("@/lib/bench", () => ({ listBenchSessions: async () => [] }));

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-watchdog-outbox");
const noRecord = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");

describe("REQUIRED PROOF — the watchdog outbox runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/room-watchdog-outbox.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const NOW = Date.parse("2026-09-24T10:00:00.000Z");
const nowIso = new Date(NOW).toISOString();
const armTrigger = (name: string, table: string, event: string) => pg.exec(`
  CREATE OR REPLACE FUNCTION ${name}_fn() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'OUTBOX injected failure on ${table} ${event}'; END $$;
  DROP TRIGGER IF EXISTS ${name} ON ${table};
  CREATE TRIGGER ${name} BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}_fn();
`);
const disarm = (name: string, table: string) => pg.exec(`DROP TRIGGER IF EXISTS ${name} ON ${table};`);

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  pg.exec(`
    CREATE TABLE schema_migrations (version int PRIMARY KEY, name text);
    CREATE TABLE room (id text PRIMARY KEY, name text, disabled_at timestamptz);
    CREATE TABLE room_install (
      room_id text PRIMARY KEY, last_seen_at timestamptz, tape_advancing boolean, session_open boolean, disk_free_bytes bigint,
      state_flags jsonb, retired_at timestamptz, enrolled_at timestamptz);
  `);
  pg.exec(noRecord("db/migrations/0103_room_alert_state.sql"));
  pg.exec(noRecord("db/migrations/0119_room_alert_outbox.sql"));
  H.sql = pg.sql;
}, 240_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

const reset = () => pg.exec(`TRUNCATE room_alert_outbox RESTART IDENTITY; TRUNCATE room_alert_state; TRUNCATE room_watchdog_heartbeat; DELETE FROM room_install; DELETE FROM room;`);
beforeEach(() => { if (HAVE_DOCKER) reset(); });

const seedRooms = (ids: string[]) => pg.exec(ids.map((i) => `INSERT INTO room (id, name) VALUES ('${i}', 'Room ${i}');`).join("\n"));
const setState = (id: string, status: string, since = "2026-09-24T09:00:00Z") =>
  pg.exec(`INSERT INTO room_alert_state (room_id, status, since) VALUES ('${id}', '${status}', '${since}') ON CONFLICT (room_id) DO UPDATE SET status = '${status}', since = '${since}';`);
const stateOf = async (id: string) => ((await pg.sql`SELECT status FROM room_alert_state WHERE room_id = ${id}`) as Array<{ status: string }>)[0]?.status;
const outbox = async () => (await pg.sql`SELECT id, kind, room_ids, status_from, status_to, subject FROM room_alert_outbox ORDER BY id`) as Array<{ id: number; kind: string; room_ids: string[]; status_from: string | null; status_to: string | null; subject: string }>;

const okFacts = { last_seen_at: new Date(NOW - 10_000).toISOString(), tape_advancing: true, session_open: false, disk_free_bytes: 500e9, state_flags: [] as string[], open_session: null };
const offlineFacts = { ...okFacts, last_seen_at: new Date(NOW - 20 * 60_000).toISOString() };
const input = (room_id: string, facts: typeof okFacts, prior: { status: "ok" | "offline" | "degraded"; since: string } | null, muted = false) =>
  ({ room_id, room_name: `Room ${room_id}`, facts, prior, muted });

describe.runIf(HAVE_DOCKER)("F1 — the outbox follows the planner's MESSAGES, not the state writes", () => {
  it("a SEED run (first sight) writes the state row and queues NOTHING — never an alert on history", async () => {
    const { planWatchdogRun, persistPlan } = await import("@/lib/room-watchdog");
    seedRooms(["r1"]);
    const plan = planWatchdogRun([input("r1", offlineFacts, null)], NOW);
    expect(plan.writes).toHaveLength(1);
    expect(plan.messages).toHaveLength(0);
    expect(await persistPlan(plan)).toBe(0);
    expect(await stateOf("r1"), "the state row was written").toBe("offline");
    expect(await outbox(), "and nothing was queued").toEqual([]);
  });

  it("a MUTED room's transition moves the state and queues NOTHING", async () => {
    const { planWatchdogRun, persistPlan } = await import("@/lib/room-watchdog");
    seedRooms(["r1"]); setState("r1", "ok");
    const plan = planWatchdogRun([input("r1", offlineFacts, { status: "ok", since: "2026-09-24T09:00:00Z" }, true)], NOW);
    expect(plan.writes).toHaveLength(1);
    expect(plan.messages).toHaveLength(0);
    expect(await persistPlan(plan)).toBe(0);
    expect(await stateOf("r1")).toBe("offline");
    expect(await outbox()).toEqual([]);
  });

  it("a FLEET OUTAGE (3 of 4 rooms offline at once) is N state writes and exactly ONE outbox row, none of the swallowed individual ones", async () => {
    const { planWatchdogRun, persistPlan } = await import("@/lib/room-watchdog");
    const ids = ["r1", "r2", "r3", "r4"];
    seedRooms(ids); ids.forEach((i) => setState(i, "ok"));
    const prior = { status: "ok" as const, since: "2026-09-24T09:00:00Z" };
    const plan = planWatchdogRun([
      input("r1", offlineFacts, prior), input("r2", offlineFacts, prior), input("r3", offlineFacts, prior), input("r4", okFacts, prior),
    ], NOW);
    expect(plan.writes).toHaveLength(3);
    expect(plan.messages).toHaveLength(1);
    expect(await persistPlan(plan)).toBe(1);
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("fleet_outage");
    expect([...rows[0].room_ids].sort()).toEqual(["r1", "r2", "r3"]);
    for (const i of ["r1", "r2", "r3"]) expect(await stateOf(i)).toBe("offline");
    expect(await stateOf("r4")).toBe("ok");
  });

  it("one room going offline, degraded and recovering each queue exactly ONE row of the right kind", async () => {
    const { planWatchdogRun, persistPlan } = await import("@/lib/room-watchdog");
    seedRooms(["a", "b", "c"]);
    ["a", "b"].forEach((i) => setState(i, "ok")); setState("c", "offline", "2026-09-24T08:00:00Z");
    const okPrior = { status: "ok" as const, since: "2026-09-24T09:00:00Z" };
    const degradedFacts = { ...okFacts, state_flags: ["DEVICE_MISSING"] };
    const plan = planWatchdogRun([
      input("a", offlineFacts, okPrior), input("b", degradedFacts, okPrior),
      input("c", okFacts, { status: "offline", since: "2026-09-24T08:00:00Z" }),
    ], NOW);
    expect(await persistPlan(plan)).toBe(3);
    const byRoom = Object.fromEntries((await outbox()).map((r) => [r.room_ids[0], r]));
    expect(byRoom.a.kind).toBe("offline");
    expect(byRoom.a.status_from).toBe("ok");
    expect(byRoom.b.kind).toBe("degraded");
    expect(byRoom.c.kind).toBe("recovered");
    expect(byRoom.c.status_to).toBe("ok");
  });
});

describe.runIf(HAVE_DOCKER)("atomicity — the state advances if and only if the alert is queued", () => {
  it("FAILURE INJECTED on the outbox insert: the state is still on its EARLIER status, and the failure reaches the caller", async () => {
    const { planWatchdogRun, persistPlan } = await import("@/lib/room-watchdog");
    seedRooms(["r1"]); setState("r1", "ok");
    const plan = planWatchdogRun([input("r1", offlineFacts, { status: "ok", since: "2026-09-24T09:00:00Z" })], NOW);
    armTrigger("t_outbox", "room_alert_outbox", "INSERT");
    let threw = "";
    try {
      await persistPlan(plan).catch((e: Error) => { threw = String(e.message); });
    } finally {
      disarm("t_outbox", "room_alert_outbox");
    }
    expect(threw).toMatch(/OUTBOX injected failure/);
    // THE WHOLE POINT. Split into two statements, the state would read `offline` here and the alert would be lost for good: edge-triggered, so the
    // next minute finds nothing changed. In one statement the next minute re-plans the same edge.
    expect(await stateOf("r1"), "the state did NOT advance").toBe("ok");
    expect(await outbox()).toEqual([]);
    // and the retry, once the fault is gone, delivers it
    expect(await persistPlan(plan)).toBe(1);
    expect(await stateOf("r1")).toBe("offline");
  }, 120_000);

  it("a planned message that cannot be queued (no kind or no rooms) is LOGGED, never dropped in silence (ETA-Refuter #422 finding 3)", async () => {
    const { persistPlan } = await import("@/lib/room-watchdog");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      seedRooms(["r1"]); setState("r1", "ok");
      const plan = {
        writes: [{ room_id: "r1", status: "offline" as const, since: nowIso }],
        messages: [{ subject: "s", text: "t" }],   // no kind, no room_ids
      };
      expect(await persistPlan(plan)).toBe(0);
      expect(err.mock.calls.some((c) => String(c[0]).includes("CANNOT be queued")), "the drop was logged").toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  it("the same plan applied twice queues ONE alert: the second run finds nothing changed (IS DISTINCT FROM)", async () => {
    const { planWatchdogRun, persistPlan } = await import("@/lib/room-watchdog");
    seedRooms(["r1"]); setState("r1", "ok");
    const plan = planWatchdogRun([input("r1", offlineFacts, { status: "ok", since: "2026-09-24T09:00:00Z" })], NOW);
    expect(await persistPlan(plan)).toBe(1);
    expect(await persistPlan(plan)).toBe(0);
    expect(await outbox()).toHaveLength(1);
  });

  it("F2 — two OVERLAPPING runs over the same edge queue exactly ONE alert", async () => {
    const { planWatchdogRun, persistPlan } = await import("@/lib/room-watchdog");
    const ids = ["r1", "r2", "r3"];
    seedRooms(ids); ids.forEach((i) => setState(i, "ok"));
    const prior = { status: "ok" as const, since: "2026-09-24T09:00:00Z" };
    const plan = planWatchdogRun([input("r1", offlineFacts, prior), input("r2", okFacts, prior), input("r3", okFacts, prior)], NOW);
    const counts = await Promise.all([persistPlan(plan), persistPlan(plan), persistPlan(plan)]);
    expect(counts.reduce((a, b) => a + b, 0), "exactly one of the three runs won the edge").toBe(1);
    expect(await outbox()).toHaveLength(1);
  }, 120_000);
});

describe.runIf(HAVE_DOCKER)("the read door — two sets, the database's clock, and absent is never healthy", () => {
  const insertAlerts = (n: number, minutesAgo: number) => pg.exec(
    `INSERT INTO room_alert_outbox (kind, room_ids, room_name, subject, body, created_at)
     SELECT 'offline', ARRAY['r'||g], 'Room '||g, 's'||g, 'b'||g, now() - interval '${minutesAgo} minutes' FROM generate_series(1, ${n}) g;`);

  it("F7 — 120 already-delivered rows inside the lookback do NOT starve a NEW row", async () => {
    const { readRoomAlerts } = await import("@/lib/room-alerts");
    insertAlerts(120, 2);                           // ids 1..120, all inside the 10-minute lookback, all already delivered
    insertAlerts(1, 0);                             // id 121, the new one
    const a = await readRoomAlerts({ afterId: 120, lookbackMinutes: 10, limit: 100 });
    expect(a.ok).toBe(true);
    expect(a.new.map((r) => r.id), "the new row is returned").toEqual([121]);
    expect(a.new_truncated).toBe(false);
    expect(a.late.length, "and the lookback only ever looks BEHIND the cursor").toBe(120);
    expect(a.late.every((r) => r.id <= 120)).toBe(true);
    expect(a.head_id).toBe(121);
  });

  it("the limit bounds ONLY new rows, and says when it cut", async () => {
    const { readRoomAlerts } = await import("@/lib/room-alerts");
    insertAlerts(5, 0);
    const a = await readRoomAlerts({ afterId: 0, lookbackMinutes: 10, limit: 3 });
    expect(a.new.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(a.new_truncated).toBe(true);
    expect(a.late).toEqual([]);
  });

  it("F2 — a row committed late (a lower id, read after a higher one) shows in `late`; one older than the window does not", async () => {
    const { readRoomAlerts } = await import("@/lib/room-alerts");
    insertAlerts(1, 30);                            // id 1, 30 min old: outside a 10-minute lookback
    insertAlerts(2, 1);                             // ids 2, 3
    const a = await readRoomAlerts({ afterId: 3, lookbackMinutes: 10, limit: 50 });
    expect(a.new).toEqual([]);
    expect(a.late.map((r) => r.id)).toEqual([2, 3]);
  });

  it("F9 — no heartbeat yet is `none`, its own answer; a fresh pulse is `ok`; a failed run or an old pulse is `stale`", async () => {
    const { readRoomAlerts } = await import("@/lib/room-alerts");
    const { recordHeartbeat } = await import("@/lib/room-watchdog");
    expect((await readRoomAlerts({ afterId: 0, lookbackMinutes: 10, limit: 10 })).heartbeat, "nothing recorded: NOT healthy").toEqual({ state: "none" });
    await recordHeartbeat(true, 7);
    const fresh = (await readRoomAlerts({ afterId: 0, lookbackMinutes: 10, limit: 10 })).heartbeat;
    expect(fresh).toMatchObject({ state: "ok", last_ok: true, evaluated: 7, last_error: null });
    await recordHeartbeat(false, 0, "read_failed");
    expect((await readRoomAlerts({ afterId: 0, lookbackMinutes: 10, limit: 10 })).heartbeat).toMatchObject({ state: "stale", last_ok: false, last_error: "read_failed" });
    await recordHeartbeat(true, 7);
    pg.exec(`UPDATE room_watchdog_heartbeat SET last_run_at = now() - interval '10 minutes';`);
    const old = (await readRoomAlerts({ afterId: 0, lookbackMinutes: 10, limit: 10 })).heartbeat;
    expect(old).toMatchObject({ state: "stale", last_ok: true });
    expect((old as { age_s: number }).age_s, "an AGE computed by the database").toBeGreaterThanOrEqual(600);
  });
});

describe.runIf(HAVE_DOCKER)("runWatchdog end to end — the alert is queued, the pulse is written, and NO V page goes out by default", () => {
  const seedInstall = (id: string, lastSeenMinAgo: number) => pg.exec(
    `INSERT INTO room_install (room_id, last_seen_at, tape_advancing, session_open, disk_free_bytes, state_flags, enrolled_at)
     VALUES ('${id}', now() - interval '${lastSeenMinAgo} minutes', true, false, 500000000000, '{"flags": []}'::jsonb, now());`);

  it("a room that goes offline queues one alert, records an ok heartbeat, and calls neither Resend nor WaSender", async () => {
    const { runWatchdog } = await import("@/lib/room-watchdog");
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      seedRooms(["r1"]); setState("r1", "ok");
      seedInstall("r1", 20);
      const r = await runWatchdog(Date.now());
      expect(r).toMatchObject({ ok: true, evaluated: 1, alerts_queued: 1, channel_results: [] });
      expect(fetchSpy, "V is not paged").not.toHaveBeenCalled();
      expect((await outbox()).map((x) => x.kind)).toEqual(["offline"]);
      expect(await stateOf("r1")).toBe("offline");
      const hb = (await pg.sql`SELECT last_ok, evaluated FROM room_watchdog_heartbeat WHERE id = 1`) as Array<{ last_ok: boolean; evaluated: number }>;
      expect(hb[0]).toMatchObject({ last_ok: true, evaluated: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
  }, 120_000);

  it("a HEARTBEAT write that fails never stops the run or the alert: the pulse must not be the reason a room goes unannounced", async () => {
    const { runWatchdog } = await import("@/lib/room-watchdog");
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      seedRooms(["r1"]); setState("r1", "ok"); seedInstall("r1", 20);
      armTrigger("t_hb", "room_watchdog_heartbeat", "INSERT");
      let r;
      try { r = await runWatchdog(Date.now()); } finally { disarm("t_hb", "room_watchdog_heartbeat"); }
      expect(r).toMatchObject({ ok: true, alerts_queued: 1 });
      expect((await outbox()).map((x) => x.kind), "the alert was queued although the pulse could not be written").toEqual(["offline"]);
    } finally {
      vi.restoreAllMocks();
    }
  }, 120_000);

  it("a persist that fails sends NOTHING, advances NOTHING, and records a FAILED heartbeat", async () => {
    const { runWatchdog } = await import("@/lib/room-watchdog");
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.ROOM_WATCHDOG_PAGE_V = "1"; // even with paging ON, an alert must not go out for a state that did not move
    try {
      seedRooms(["r1"]); setState("r1", "ok"); seedInstall("r1", 20);
      armTrigger("t_outbox2", "room_alert_outbox", "INSERT");
      let r;
      try { r = await runWatchdog(Date.now()); } finally { disarm("t_outbox2", "room_alert_outbox"); }
      expect(r).toMatchObject({ ok: false, error: "persist_failed", alerts_queued: 0 });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await stateOf("r1"), "the state did not advance, so the next run retries the edge").toBe("ok");
      const hb = (await pg.sql`SELECT last_ok, last_error FROM room_watchdog_heartbeat WHERE id = 1`) as Array<{ last_ok: boolean; last_error: string }>;
      expect(hb[0]).toMatchObject({ last_ok: false, last_error: "persist_failed" });
      const retry = await runWatchdog(Date.now());
      expect(retry).toMatchObject({ ok: true, alerts_queued: 1 });
    } finally {
      delete process.env.ROOM_WATCHDOG_PAGE_V;
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  }, 120_000);
});

describe("pageVEnabled — V's pages are OFF unless explicitly on, and a typo never throws", () => {
  it("unset → off; 1 → on; 0 → off; garbage → off (no throw)", async () => {
    const { pageVEnabled } = await import("@/lib/room-watchdog");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(pageVEnabled({})).toBe(false);
    expect(pageVEnabled({ ROOM_WATCHDOG_PAGE_V: "1" })).toBe(true);
    expect(pageVEnabled({ ROOM_WATCHDOG_PAGE_V: "0" })).toBe(false);
    expect(pageVEnabled({ ROOM_WATCHDOG_PAGE_V: "maybe" })).toBe(false);
    vi.restoreAllMocks();
  });
});

describe("heartbeatState — absent is never healthy (F9)", () => {
  it("no row, or a non-numeric age → none", async () => {
    const { heartbeatState } = await import("@/lib/room-alerts");
    expect(heartbeatState(undefined)).toEqual({ state: "none" });
    expect(heartbeatState({ age_s: Number.NaN, last_ok: true, evaluated: 1, last_error: null })).toEqual({ state: "none" });
    expect(heartbeatState({ age_s: 30, last_ok: true, evaluated: 1, last_error: null }).state).toBe("ok");
    // Pinned from BELOW as well (eta-refuter #422 MC): a threshold lowered to 60 would false-alarm every minute of a healthy cron's slack.
    for (const age of [61, 120, 299, 300]) expect(heartbeatState({ age_s: age, last_ok: true, evaluated: 1, last_error: null }).state, `age ${age}`).toBe("ok");
    expect(heartbeatState({ age_s: 301, last_ok: true, evaluated: 1, last_error: null }).state).toBe("stale");
    expect(heartbeatState({ age_s: 30, last_ok: false, evaluated: 1, last_error: "x" }).state).toBe("stale");
  });
});
