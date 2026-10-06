/**
 * tests/unit/steward-pg.test.ts — REQUIRED PROOF: the Room Steward loop (part 2) against a real postgres:16, with BOUND parameters (tests/support/s1-pg.ts).
 * Every SQL statement of senseAll / loadRecent / runSteward / leaseLock / the cron and admin routes runs against the REAL migrations (0041..0128), not a stand-in.
 * Only the driver is a stand-in: `@/lib/db` is the harness's psql-backed sql.
 *
 *   1. leaseLock: a second holder cannot take a live lease, release frees it, an expired lease is taken over, a stale holder cannot release the new holder's lease.
 *   2. runSteward on a seeded fleet (as of 2026-10-06 10:00 IST): the excluded rooms (ORB3, Home Office) never appear; ORB2 (ot) and a clinic room with no session get a
 *      scribe_start; a healthy recording room gets none. The seed's kill switch ON -> result "kill_switch", mode shadow. No source is degraded.
 *   3. Dedupe: the same tick again writes nothing; a changed fact writes.
 *   4. Kill switch OFF + shadow -> "shadow: would scribe_start"; shadow off (live asked) -> "blocked: live executor not enabled in P0" and live_executor in degraded.
 *   5. /api/cron/steward and /api/admin/steward/decisions through the real tables.
 *   6. (fix pass) last_tick written by the lease release; config_unavailable takes no lease; the scoped occupancy reader (roster machines, 2 h, LIMIT) on the real index.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));
const G = vi.hoisted(() => ({ ok: true }));
vi.mock("@/lib/bench", () => ({
  benchAdminGuard: async () => (G.ok ? { ok: true, claims: {} } : { ok: false, code: "AUTH_REQUIRED", msg: "Sign in required" }),
}));

import { GET as cron } from "@/app/api/cron/steward/route";
import { GET as decisionsRoute } from "@/app/api/admin/steward/decisions/route";
import { leaseLock, runSteward } from "@/lib/steward/loop";
import { OCCUPANCY_ROW_LIMIT, scopedOccupancy } from "@/lib/steward/occupancy-read";
import type { StewardSql } from "@/lib/steward/tickets";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-steward-loop");

const MIGRATIONS = [
  "0041_room_bench.sql",
  "0044_bench_command.sql",
  "0075_room_install.sql",
  "0076_bootstrap_token_fk.sql",
  "0077_install_input_device_name.sql",
  "0078_install_update_fields.sql",
  "0079_install_assigned_channel.sql",
  "0080_bench_command_set_audio_input.sql",
  "0081_room_states_and_verbs.sql",
  "0103_room_alert_state.sql",
  "0112_bench_level_samples.sql",
  "0122_pulse_presence_events.sql",
  "0123_eta_encounter_windows.sql",
  "0124_encounter_windows_warehouse_attribution.sql",
  "0125_presence_source_guard.sql",
  "0126_kiosk_health_events.sql",
  "0127_kiosk_health_machine_received_idx.sql",
  "0128_room_steward.sql",
];
const mig = (n: string) => readFileSync(`db/migrations/${n}`, "utf8");
const rows = async (q: TemplateStringsArray, ...v: unknown[]) => (await H.sql!(q, ...v)) as Array<Record<string, any>>;
const sql = ((s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v)) as unknown as StewardSql;

// 10:00 IST on 2026-10-06
const AS_OF = Date.parse("2026-10-06T04:30:00Z");
const at = (minAgo: number) => new Date(AS_OF - minAgo * 60_000).toISOString();

const ORB3 = "room_jwyrr4dc";
const HOME = "room_2qe955hy";
const ORB2 = "room_mah3aspr";
const CLINIC_A = "room_clinica";
const CLINIC_B = "room_clinicb";

function seedFleet() {
  const rm = (id: string, slug: string, name: string) =>
    `INSERT INTO room (id, slug, name, pin_hash) VALUES ('${id}', '${slug}', '${name}', 'x') ON CONFLICT DO NOTHING;`;
  const inst = (id: string, room: string, host: string) =>
    `INSERT INTO room_install (install_id, room_id, enrolled_at, enrolled_by, hostname) VALUES ('${id}', '${room}', '${at(10_000)}', 'test', '${host}');`;
  const poller = (machine: string, minAgo: number) =>
    `INSERT INTO pulse_presence_events (source, machine, event, ts, payload) VALUES ('poller', '${machine}', 'ok', '${at(minAgo)}', '{"idle_s": 5, "chrome_running": "true"}'::jsonb);`;
  pg.exec(`
    ${rm(ORB3, "orb3-x", "ORB3")}
    ${rm(HOME, "home-x", "Home Office")}
    ${rm(ORB2, "orb2-x", "ORB2")}
    ${rm(CLINIC_A, "clinic-a-x", "Clinic A")}
    ${rm(CLINIC_B, "clinic-b-x", "Clinic B")}
    ${inst("inst_orb3", ORB3, "ORBOX3")}
    ${inst("inst_home", HOME, "Vinays-Mac-mini")}
    ${inst("inst_orb2", ORB2, "vinay-orb2")}
    ${inst("inst_a", CLINIC_A, "clinic-a-mac")}
    ${inst("inst_b", CLINIC_B, "clinic-b-mac")}
    ${poller("vinay-orb2", 1)}
    ${poller("clinic-a-mac", 1)}
    ${poller("clinic-b-mac", 1)}
    ${poller("ORBOX3", 1)}
    INSERT INTO bench_listener (room_id, tab_id, last_poll_at, paused) VALUES
      ('${ORB2}', 't', '${at(0.2)}', false), ('${CLINIC_A}', 't', '${at(0.2)}', false), ('${CLINIC_B}', 't', '${at(0.2)}', false);
    INSERT INTO bench_session (id, room_id, started_at, status) VALUES ('bs_b', '${CLINIC_B}', '${at(60)}', 'recording');
    INSERT INTO bench_chunk (id, session_id, idx, r2_key, content_type, started_at, ended_at, duration_ms, size_bytes, created_at) VALUES
      ('bc_1', 'bs_b', 0, 'k0', 'audio/webm', '${at(50)}', '${at(45)}', 300000, 480000, '${at(45)}'),
      ('bc_2', 'bs_b', 1, 'k1', 'audio/webm', '${at(40)}', '${at(35)}', 300000, 480000, '${at(35)}'),
      ('bc_3', 'bs_b', 2, 'k2', 'audio/webm', '${at(30)}', '${at(25)}', 300000, 480000, '${at(25)}'),
      ('bc_4', 'bs_b', 3, 'k3', 'audio/webm', '${at(20)}', '${at(15)}', 300000, 480000, '${at(15)}'),
      ('bc_5', 'bs_b', 4, 'k4', 'audio/webm', '${at(10)}', '${at(5)}', 300000, 480000, '${at(5)}'),
      ('bc_6', 'bs_b', 5, 'k5', 'audio/webm', '${at(5)}', '${at(0.5)}', 270000, 440000, '${at(0.5)}');
    INSERT INTO bench_level_sample (room_id, ist_date, sampled_at, peak, avg, zero_ratio, session_open, tape_advancing) VALUES
      ('${CLINIC_B}', '2026-10-06', '${at(0.5)}', 0.3, 0.1, 0.2, true, true),
      ('${CLINIC_B}', '2026-10-06', '${at(1.5)}', 0.3, 0.1, 0.2, true, true);
  `);
}

const actionable = (r: Record<string, any>) => r.action !== "none" && r.action !== "log_only";
const decisions = async () => rows`SELECT room_id, rule, action, mode, result, params, inputs, why FROM steward_decisions WHERE room_id IS NOT NULL ORDER BY room_id, id`;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("REQUIRED PROOF — the steward loop against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/steward-pg.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

describe.skipIf(!HAVE_DOCKER)("room steward loop over real postgres", () => {
  beforeAll(() => {
    pg.start();
    H.sql = pg.sql as never;
    pg.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    for (const m of MIGRATIONS) pg.exec(mig(m));
    seedFleet();
  }, 240_000);
  afterAll(() => {
    pg.stop();
  });

  it("leaseLock: exclusive while live, released, expired lease taken over, a stale holder cannot release the new one", async () => {
    const a = leaseLock(sql, { holder: "A", ttlSeconds: 30 });
    const b = leaseLock(sql, { holder: "B", ttlSeconds: 30 });
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
    await b.release(); // not the holder: a no-op
    expect(await b.acquire()).toBe(false);
    await a.release();
    expect(await b.acquire()).toBe(true);
    // expire B's lease, then A takes over; B's late release must not free A's lease
    pg.exec(`UPDATE steward_config SET value = jsonb_build_object('holder', 'B', 'until', (now() - interval '1 second')::text) WHERE key = 'loop_lease'`);
    expect(await a.acquire()).toBe(true);
    await b.release();
    expect(await leaseLock(sql, { holder: "C" }).acquire()).toBe(false);
    await a.release();
    expect(await leaseLock(sql, { holder: "C" }).acquire()).toBe(true);
    pg.exec(`UPDATE steward_config SET value = jsonb_build_object('holder', NULL::text, 'until', now()::text) WHERE key = 'loop_lease'`);
  });

  it("runSteward (seed config: kill switch ON): excluded rooms absent, starts decided, results kill_switch, nothing degraded", async () => {
    const s = await runSteward(sql, { asOf: AS_OF, budgetMs: 20_000 });
    expect(s).toMatchObject({ rooms: 3, decisions_written: 3, skipped_lock: false, kill_switch: true, budget_hit: false, fleet_incidents: 0, degraded: [] });
    const d = await decisions();
    expect(d.map((r) => r.room_id).sort()).toEqual([CLINIC_A, CLINIC_B, ORB2].sort());
    expect(d.some((r) => [ORB3, HOME].includes(r.room_id))).toBe(false);
    const by = Object.fromEntries(d.map((r) => [r.room_id as string, r]));
    for (const id of [CLINIC_A, ORB2]) {
      expect(by[id]).toMatchObject({ rule: "not_recording", action: "scribe_start", mode: "shadow", result: "kill_switch" });
      expect(by[id]!.inputs).toMatchObject({ primary: true, tick: "2026-10-06T04:30:00.000Z", in_window: true, session_open: false });
      expect(by[id]!.inputs.ages_s.poller_ok_s).toBe(60);
    }
    expect(by[CLINIC_B]).toMatchObject({ rule: "ok", action: "none", mode: "shadow", result: null });
    expect(by[CLINIC_B]!.inputs).toMatchObject({ session_open: true, session_status: "recording" });
    expect(by[CLINIC_B]!.inputs.ages_s.last_chunk_s).toBe(30);
    expect((await rows`SELECT count(*)::int AS n FROM steward_decisions WHERE room_id IS NULL`)[0]!.n).toBe(0);
    // shadow only: no ticket, no kiosk command
    expect((await rows`SELECT count(*)::int AS n FROM steward_tickets`)[0]!.n).toBe(0);
    expect((await rows`SELECT count(*)::int AS n FROM bench_command`)[0]!.n).toBe(0);
  }, 120_000);

  it("dedupe: the same tick again writes nothing; the lease is free afterwards", async () => {
    const s = await runSteward(sql, { asOf: AS_OF + 60_000, budgetMs: 20_000 });
    expect(s.decisions_written).toBe(0);
    expect(s.skipped_lock).toBe(false);
    expect((await rows`SELECT count(*)::int AS n FROM steward_decisions WHERE room_id IS NOT NULL`)[0]!.n).toBe(3);
    expect((await rows`SELECT value->>'holder' AS h FROM steward_config WHERE key = 'loop_lease'`)[0]!.h).toBeNull();
  }, 120_000);

  it("a held lease makes the tick a no-op", async () => {
    const other = leaseLock(sql, { holder: "someone-else", ttlSeconds: 30 });
    expect(await other.acquire()).toBe(true);
    const s = await runSteward(sql, { asOf: AS_OF, budgetMs: 20_000 });
    expect(s).toMatchObject({ skipped_lock: true, rooms: 0, decisions_written: 0 });
    await other.release();
  }, 120_000);

  it("kill switch OFF + shadow: 'shadow: would scribe_start'; shadow off (live asked): blocked, live_executor degraded", async () => {
    pg.exec(`UPDATE steward_config SET value = '{"on":false}'::jsonb WHERE key = 'kill_switch'`);
    pg.exec(`DELETE FROM steward_decisions`);
    const s1 = await runSteward(sql, { asOf: AS_OF, budgetMs: 20_000 });
    expect(s1.kill_switch).toBe(false);
    expect(s1.decisions_written).toBe(3);
    const d1 = (await decisions()).filter(actionable);
    expect(d1.map((r) => r.result)).toEqual(["shadow: would scribe_start", "shadow: would scribe_start"]);
    expect(d1.every((r) => r.mode === "shadow")).toBe(true);

    pg.exec(`UPDATE steward_config SET value = '{"global":false,"actions":{}}'::jsonb WHERE key = 'shadow'`);
    pg.exec(`DELETE FROM steward_decisions`);
    const s2 = await runSteward(sql, { asOf: AS_OF, budgetMs: 20_000 });
    expect(s2.degraded).toContain("live_executor");
    const d2 = (await decisions()).filter(actionable);
    expect(d2.map((r) => r.result)).toEqual(["blocked: live executor not enabled in P0", "blocked: live executor not enabled in P0"]);
    expect(d2.every((r) => r.mode === "shadow")).toBe(true);
    // still nothing was issued or sent
    expect((await rows`SELECT count(*)::int AS n FROM steward_tickets`)[0]!.n).toBe(0);
    expect((await rows`SELECT count(*)::int AS n FROM bench_command`)[0]!.n).toBe(0);

    // restore the seed
    pg.exec(`UPDATE steward_config SET value = '{"global":true,"actions":{}}'::jsonb WHERE key = 'shadow'`);
    pg.exec(`UPDATE steward_config SET value = '{"on":true}'::jsonb WHERE key = 'kill_switch'`);
  }, 180_000);

  it("a listener paused by the kiosk means no start decision (consent safety), through the real sense queries", async () => {
    pg.exec(`DELETE FROM steward_decisions`);
    pg.exec(`UPDATE bench_listener SET paused = true WHERE room_id = '${CLINIC_A}'`);
    await runSteward(sql, { asOf: AS_OF, budgetMs: 20_000 });
    const a = (await decisions()).find((r) => r.room_id === CLINIC_A)!;
    expect(a.action).not.toBe("scribe_start");
    pg.exec(`UPDATE bench_listener SET paused = false WHERE room_id = '${CLINIC_A}'`);
  }, 120_000);

  it("GET /api/cron/steward through the real tables; the bearer is checked", async () => {
    const SAVED = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-pg";
    try {
      pg.exec(`DELETE FROM steward_decisions`);
      expect((await cron(new Request("https://x.test/api/cron/steward"))).status).toBe(401);
      const r = await cron(new Request("https://x.test/api/cron/steward", { headers: { authorization: "Bearer cron-pg" } }));
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body).toMatchObject({ skipped_lock: false, kill_switch: true });
      expect(typeof body.rooms).toBe("number");
      expect(body.rooms).toBe(3);
    } finally {
      if (SAVED === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = SAVED;
    }
  }, 120_000);

  it("GET /api/admin/steward/decisions: guard, room / since / limit filters, newest first, ISO ts, bound parameters", async () => {
    pg.exec(`DELETE FROM steward_decisions`);
    pg.exec(`
      INSERT INTO steward_decisions (ts, room_id, rule, action, mode, result) VALUES
        ('2026-10-06T04:00:00Z', '${CLINIC_A}', 'not_recording', 'scribe_start', 'shadow', 'kill_switch'),
        ('2026-10-06T04:10:00Z', '${CLINIC_A}', 'ok', 'none', 'shadow', NULL),
        ('2026-10-06T04:20:00Z', '${CLINIC_B}', 'ok', 'none', 'shadow', NULL);
    `);
    const get = async (qs: string) => decisionsRoute(new Request(`https://x.test/api/admin/steward/decisions${qs}`));
    G.ok = false;
    expect((await get("")).status).toBe(401);
    G.ok = true;
    const all = await (await get("")).json();
    expect(all.decisions.map((d: any) => d.rule + "@" + d.ts)).toEqual(["ok@2026-10-06T04:20:00.000Z", "ok@2026-10-06T04:10:00.000Z", "not_recording@2026-10-06T04:00:00.000Z"]);
    const a = await (await get(`?room=${CLINIC_A}`)).json();
    expect(a.decisions).toHaveLength(2);
    const s = await (await get("?since=2026-10-06T04:05:00Z")).json();
    expect(s.decisions).toHaveLength(2);
    const l = await (await get("?limit=1")).json();
    expect(l.decisions).toHaveLength(1);
    expect((await get("?room=x%27%3B%20DROP%20TABLE%20steward_decisions%3B--")).status).toBe(200);
    expect((await rows`SELECT count(*)::int AS n FROM steward_decisions`)[0]!.n).toBe(3);
    expect((await get("?since=nope")).status).toBe(400);
    expect((await get("?limit=0")).status).toBe(400);
  }, 60_000);
  it("F7: the lease release writes steward_config.last_tick (the same statement); the lease is free afterwards", async () => {
    pg.exec(`DELETE FROM steward_decisions`);
    pg.exec(`DELETE FROM steward_config WHERE key = 'last_tick'`);
    const s = await runSteward(sql, { asOf: AS_OF, budgetMs: 20_000 });
    const lt = (await rows`SELECT value, updated_by FROM steward_config WHERE key = 'last_tick'`)[0]!;
    expect(Object.keys(lt.value).sort()).toEqual(["at", "budget_hit", "decisions_written", "degraded", "elapsed_ms", "rooms"]);
    expect(lt.value).toMatchObject({ at: new Date(AS_OF).toISOString(), rooms: 3, decisions_written: 3, budget_hit: false, degraded: [] });
    expect(lt.value.elapsed_ms).toBe(s.elapsed_ms);
    expect((await rows`SELECT value->>'holder' AS h FROM steward_config WHERE key = 'loop_lease'`)[0]!.h).toBeNull();
    // a second tick overwrites it (upsert), still one row
    await runSteward(sql, { asOf: AS_OF + 60_000, budgetMs: 20_000 });
    expect((await rows`SELECT count(*)::int AS n FROM steward_config WHERE key = 'last_tick'`)[0]!.n).toBe(1);
    expect((await rows`SELECT value->>'at' AS at FROM steward_config WHERE key = 'last_tick'`)[0]!.at).toBe(new Date(AS_OF + 60_000).toISOString());
  }, 120_000);

  it("F8: no `rooms` row in steward_config -> {ok:false, reason:'config_unavailable'}, the lease row is never touched, nothing is written", async () => {
    pg.exec(`DELETE FROM steward_decisions`);
    const before = (await rows`SELECT updated_at::text AS u, updated_by FROM steward_config WHERE key = 'loop_lease'`)[0]!;
    const saved = (await rows`SELECT value FROM steward_config WHERE key = 'rooms'`)[0]!.value;
    pg.exec(`DELETE FROM steward_config WHERE key = 'rooms'`);
    try {
      const s = await runSteward(sql, { asOf: AS_OF, budgetMs: 20_000 });
      expect(s).toMatchObject({ ok: false, reason: "config_unavailable", rooms: 0, decisions_written: 0, skipped_lock: false });
      expect((await rows`SELECT count(*)::int AS n FROM steward_decisions`)[0]!.n).toBe(0);
      const after = (await rows`SELECT updated_at::text AS u, updated_by FROM steward_config WHERE key = 'loop_lease'`)[0]!;
      expect(after).toEqual(before);
      // the cron answers 200 with the same body
      const SAVED = process.env.CRON_SECRET;
      process.env.CRON_SECRET = "cron-pg";
      try {
        const r = await cron(new Request("https://x.test/api/cron/steward", { headers: { authorization: "Bearer cron-pg" } }));
        expect(r.status).toBe(200);
        expect(await r.json()).toMatchObject({ ok: false, reason: "config_unavailable" });
      } finally {
        if (SAVED === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = SAVED;
      }
    } finally {
      pg.exec(`INSERT INTO steward_config (key, value, updated_by) VALUES ('rooms', '${JSON.stringify(saved).replace(/'/g, "''")}'::jsonb, 'test-restore') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    }
  }, 120_000);

  it("F6: scopedOccupancy reads only the roster machines, only the last 2 h, bounded, with machine = ANY on the (machine, ts) index", async () => {
    const ext = (machine: string, event: string, minAgo: number, extra = "") =>
      `INSERT INTO pulse_presence_events (source, machine, event, ts, payload) VALUES ('ext', '${machine}', '${event}', '${at(minAgo)}', '{"doctor_uid":"d1","display_name":"Dr T","tab_focus":"true","instance_id":"i1"${extra}}'::jsonb);`;
    pg.exec(`
      ${ext("clinic-a-mac", "login", 30)}
      ${ext("clinic-a-mac", "heartbeat", 1)}
      ${ext("other-mac", "login", 20)}
      ${ext("other-mac", "heartbeat", 1)}
      ${ext("clinic-b-mac", "login", 180)}
    `);
    const seen: string[] = [];
    const spy = ((strings: TemplateStringsArray, ...v: unknown[]) => {
      seen.push(strings.join("?"));
      return H.sql!(strings, ...v);
    }) as never;
    const out = await scopedOccupancy(spy, AS_OF, ["clinic-a-mac", "clinic-b-mac"]);
    expect(out.map((o) => o.machine)).toEqual(["clinic-a-mac"]); // other-mac not in the roster; clinic-b-mac's only event is 3 h old
    const text = seen.join(" ");
    expect(text).toContain("machine = ANY(");
    expect(text).toContain("LIMIT");
    expect(text).not.toContain("machine IS NOT NULL");
    expect(await scopedOccupancy(spy, AS_OF, [])).toEqual([]);

    // volume: more focused heartbeats than the limit inside 2 h -> still answers, newest rows win
    pg.exec(`
      INSERT INTO pulse_presence_events (source, machine, event, ts, payload)
      SELECT 'ext', 'clinic-b-mac', 'heartbeat', '${at(0)}'::timestamptz - (g * interval '1 second'), '{"doctor_uid":"d2","display_name":"Dr U","tab_focus":"true","instance_id":"i2"}'::jsonb
        FROM generate_series(1, ${OCCUPANCY_ROW_LIMIT + 200}) g;
    `);
    const big = await scopedOccupancy(spy, AS_OF, ["clinic-a-mac", "clinic-b-mac"]);
    expect(big.map((o) => o.machine).sort()).toEqual(["clinic-a-mac", "clinic-b-mac"]);
    pg.exec(`DELETE FROM pulse_presence_events WHERE machine IN ('clinic-b-mac', 'other-mac') AND source = 'ext'`);
  }, 120_000);
});
