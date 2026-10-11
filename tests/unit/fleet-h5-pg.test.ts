/**
 * TS-H5/H6/H9 server side on a REAL postgres:16 with EVERY migration: the power verbs through the admin route, the session gate and the per-device ceilings, the helper heartbeat
 * as shown read-only on Bench / the MCP door, and app_missing / helper_missing in the live attention loader. Keys are FIXED FAKE seeds. All ids are fake.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

process.env.JWT_SECRET_ADMIN = "test-admin-secret-for-fleet-h4-tests-only";
process.env.JWT_SECRET_DOCTOR = "test-doctor-secret-for-fleet-h4-tests-only";
const KEY = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 13)]).toString("base64"); // gitleaks:allow
process.env.FLEET_COMMAND_SIGNING_KEY = KEY;

const H = vi.hoisted(() => ({
  /** next/server after(): captured so a test decides WHEN the deferred write runs; "throw" simulates no request scope (the setTimeout fallback) */
  afterMode: "capture" as "capture" | "throw",
  deferred: [] as Array<() => unknown>,
  sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>,
  cookie: null as string | null,
  statements: [] as string[],
}));
vi.mock("next/server", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  after: (fn: () => unknown) => {
    if (H.afterMode === "throw") throw new Error("after() outside a request scope");
    H.deferred.push(fn);
  },
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => { H.statements.push(s.join("?")); return H.sql(s, ...v); } }));
vi.mock("@/lib/cookie", async (orig) => ({ ...(await orig<Record<string, unknown>>()), readAdminCookie: async () => H.cookie }));
vi.setConfig({ testTimeout: 90_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-fleet-h5");

import { signAdminJwt, signDoctorJwt } from "@/lib/auth";
import { loadSigner } from "@/lib/fleet/signing";
import { claimCommands } from "@/lib/fleet/poll";
import { fleetDevices } from "@/lib/fleet/read";
import { publicKeysOf, verifyEnvelope, type Envelope } from "@/lib/fleet/envelope";

const q = async <T = Record<string, unknown>>(s: TemplateStringsArray, ...v: unknown[]) => (await H.sql(s, ...v)) as T[];
const DEV = "dev_" + "a".repeat(24);
const DEV2 = "dev_" + "b".repeat(24);
const PUB = Buffer.alloc(32, 5).toString("base64");
const SIGNER = loadSigner()!;
const KEYS = publicKeysOf(SIGNER);

async function enqueue(body: unknown, opts: { cookie?: string | null; raw?: string } = {}) {
  const { POST } = await import("@/app/api/admin/fleet/commands/route");
  H.cookie = opts.cookie === undefined ? await signAdminJwt({ admin_id: "adm_fake1", email: "admin@example.invalid" }) : opts.cookie;
  const res = await POST(new NextRequest("https://x.test/api/admin/fleet/commands", { method: "POST", body: opts.raw ?? JSON.stringify(body), headers: { "content-type": "application/json" } }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
async function overview(cookie?: string | null) {
  const { GET } = await import("@/app/api/admin/fleet/route");
  H.cookie = cookie === undefined ? await signAdminJwt({ admin_id: "adm_fake1", email: "admin@example.invalid" }) : cookie;
  const res = await GET(new NextRequest("https://x.test/api/admin/fleet"));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const kiosks = async (args: Record<string, unknown>) => {
  const { CALLABLE_TOOLS } = await import("@/lib/mcp/surface");
  return (await CALLABLE_TOOLS.get("scribe_kiosks")!.handler(args, { origin: "x", actor: "a", scopes: new Set(["read"]) } as never)) as Record<string, unknown>;
};

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  H.sql = pg.sql as never;
}, 300_000);
afterAll(() => { if (HAVE) pg.stop(); });

const HOST = "EHRC-H5s-Mac-mini";
beforeEach(() => {
  if (!HAVE) return;
  H.afterMode = "capture";
  H.deferred.length = 0;
  process.env.FLEET_COMMAND_SIGNING_KEY = KEY;
  pg.exec(`
    TRUNCATE fleet_results, fleet_commands, fleet_devices, fleet_jti, fleet_control, fleet_audit, kiosk_health_events RESTART IDENTITY CASCADE;
    DELETE FROM bench_session WHERE room_id IN ('room_h5a', 'room_h5b');
    DELETE FROM room_install WHERE install_id LIKE 'inst_h5_%'; DELETE FROM room WHERE id IN ('room_h5a', 'room_h5b');
    INSERT INTO room (id, slug, name, pin_hash) VALUES ('room_h5a', 'h5-a', 'H5 A', 'x'), ('room_h5b', 'h5-b', 'H5 B', 'x');
    INSERT INTO room_install (install_id, room_id, hostname, enrolled_at, enrolled_by, last_seen_at) VALUES
      ('inst_h5_1', 'room_h5a', '${HOST}', now(), 'test', now() - interval '1 second'),
      ('inst_h5_2', 'room_h5b', 'EHRC-H5Bs-Mac-mini', now(), 'test', now() - interval '1 second');
    INSERT INTO fleet_devices (device_id, install_id, room_id, machine, public_key, helper_version, registered_at, last_poll_at) VALUES
      ('${DEV}', 'inst_h5_1', 'room_h5a', '${HOST}', '${PUB}', '0.2.0', now() - interval '1 day', now() - interval '5 seconds'),
      ('${DEV2}', 'inst_h5_2', 'room_h5b', 'EHRC-H5Bs-Mac-mini', '${PUB}', '0.2.0', now() - interval '1 day', now() - interval '5 seconds');
  `);
  H.statements.length = 0;
});
afterEach(() => { vi.restoreAllMocks(); });

const openSession = (room: string, status = "recording") => pg.exec(`INSERT INTO bench_session (id, room_id, started_at, status) VALUES ('bs_${room}_${status}', '${room}', now() - interval '10 minutes', '${status}')`);
const rawCmd = (id: string, dev: string, verb: string, state: string, issuedAgoS: number, delivered = 0) =>
  pg.exec(`INSERT INTO fleet_commands (cmd_id, device_id, machine, verb, issued_at, expires_at, nonce, issuer_kind, issuer_id, key_id, signature, state, delivery_count)
    VALUES ('${id}', '${dev}', 'M', '${verb}', now() - interval '${issuedAgoS} seconds', now() - interval '${issuedAgoS} seconds' + interval '300 seconds', 'n_${id}', 'operator', 'op', 'fk1', 'sig', '${state}', ${delivered})`);

(HAVE ? describe : describe.skip)("TS-H5/H6/H9 server on real postgres", () => {
  describe("#43 power verbs through the admin route", () => {
    it("pmset_enforce and schedule_poweron queue (signed, audited); bad params are refused", async () => {
      expect((await enqueue({ device_id: DEV, verb: "pmset_enforce" })).status).toBe(200);
      expect((await enqueue({ device_id: DEV, verb: "schedule_poweron", params: { time: "07:05" } })).status).toBe(200);
      expect(await enqueue({ device_id: DEV, verb: "schedule_poweron", params: { time: "7:5" } })).toMatchObject({ status: 400, json: { error: "bad_params" } });
      expect(await enqueue({ device_id: DEV2, verb: "pmset_enforce", params: { sleep: 0 } })).toMatchObject({ status: 400, json: { error: "bad_params" } });
      expect(await q`SELECT verb FROM fleet_audit a JOIN fleet_commands c USING (cmd_id) ORDER BY a.id`).toEqual([{ verb: "pmset_enforce" }, { verb: "schedule_poweron" }]);
    });
  });

  describe("#42 session gate (server side)", () => {
    it("with a session OPEN (recording or paused) the four reset/restart verbs need an approval_ref; restart_recorder also needs force:true; without a session nothing is gated", async () => {
      openSession("room_h5a");
      for (const verb of ["coreaudiod_reset", "reload_launchagent", "usb_reseat", "restart_recorder"]) {
        expect(await enqueue({ device_id: DEV, verb }), verb).toMatchObject({ status: 409, json: { error: "session_open" } });
      }
      expect(await enqueue({ device_id: DEV, verb: "restart_recorder", approval_ref: "go_fake1" })).toMatchObject({ status: 409, json: { error: "session_open" } }); // approval but no force
      expect(await enqueue({ device_id: DEV, verb: "restart_recorder", params: { force: true } })).toMatchObject({ status: 409, json: { error: "session_open" } }); // force but no approval
      expect((await enqueue({ device_id: DEV, verb: "restart_recorder", params: { force: true }, approval_ref: "go_fake1" })).status).toBe(200);
      expect((await enqueue({ device_id: DEV, verb: "reload_launchagent", approval_ref: "go_fake2" })).status).toBe(200);
      // not gated: unprivileged verbs, and the OTHER room's device
      expect((await enqueue({ device_id: DEV, verb: "wake" })).status).toBe(200);
      expect((await enqueue({ device_id: DEV2, verb: "coreaudiod_reset", approval_ref: "go_fake3" })).status).toBe(200);
      expect(await q`SELECT 1 FROM fleet_commands`).toHaveLength(4);
    });
    it("a paused session gates too; an ended one does not", async () => {
      pg.exec(`INSERT INTO bench_session (id, room_id, started_at, ended_at, status) VALUES ('bs_ended', 'room_h5a', now() - interval '2 hours', now() - interval '1 hour', 'ended')`);
      expect((await enqueue({ device_id: DEV, verb: "reload_launchagent", approval_ref: "go_fake4" })).status).toBe(200);
      pg.exec(`UPDATE fleet_commands SET state = 'done'`);
      openSession("room_h5a", "paused");
      expect(await enqueue({ device_id: DEV, verb: "reload_launchagent" })).toMatchObject({ status: 409, json: { error: "session_open" } });
    });
  });

  describe("#42 per-device ceilings (server side)", () => {
    it("at most ONE coreaudiod_reset per device per 30 minutes: the second is 429; after 31 minutes it is allowed; other devices are unaffected", async () => {
      const OK = { approval_ref: "go_fake5" };
      const first = await enqueue({ device_id: DEV, verb: "coreaudiod_reset", ...OK });
      expect(first.status).toBe(200);
      pg.exec(`UPDATE fleet_commands SET state = 'done'`); // answered, so the outstanding index is not what refuses the next one
      expect(await enqueue({ device_id: DEV, verb: "coreaudiod_reset", ...OK })).toMatchObject({ status: 429, json: { error: "rate_limited" } });
      expect((await enqueue({ device_id: DEV2, verb: "coreaudiod_reset", ...OK })).status).toBe(200);
      pg.exec(`UPDATE fleet_commands SET issued_at = now() - interval '31 minutes', expires_at = now() - interval '26 minutes' WHERE cmd_id = '${first.json.cmd_id}'`);
      expect((await enqueue({ device_id: DEV, verb: "coreaudiod_reset", ...OK })).status).toBe(200);
    });
    it("a reset that expired UNDELIVERED does not use the allowance; one that was delivered does", async () => {
      const OK = { approval_ref: "go_fake6" };
      rawCmd("c_undelivered", DEV, "coreaudiod_reset", "expired", 120, 0);
      expect((await enqueue({ device_id: DEV, verb: "coreaudiod_reset", ...OK })).status).toBe(200);
      pg.exec(`UPDATE fleet_commands SET state = 'done' WHERE state = 'queued'`);
      rawCmd("c_delivered", DEV2, "coreaudiod_reset", "expired", 120, 1);
      expect(await enqueue({ device_id: DEV2, verb: "coreaudiod_reset", ...OK })).toMatchObject({ status: 429, json: { error: "rate_limited" } });
    });
    it("at most TEN privileged verbs per device per hour: the 11th is 429; unprivileged verbs and commands older than an hour do not count", async () => {
      const OK = { approval_ref: "go_fake7" };
      for (let i = 0; i < 10; i += 1) rawCmd(`c_priv_${i}`, DEV, i % 2 ? "usb_reseat" : "reload_launchagent", "done", 600 + i);
      expect(await enqueue({ device_id: DEV, verb: "restart_recorder", ...OK })).toMatchObject({ status: 429, json: { error: "rate_limited" } });
      expect((await enqueue({ device_id: DEV, verb: "helper_status" })).status).toBe(200); // not privileged
      expect((await enqueue({ device_id: DEV2, verb: "restart_recorder", ...OK })).status).toBe(200); // other device
      pg.exec(`UPDATE fleet_commands SET issued_at = now() - interval '61 minutes', expires_at = now() - interval '56 minutes' WHERE cmd_id = 'c_priv_0'`);
      expect((await enqueue({ device_id: DEV, verb: "restart_recorder", ...OK })).status).toBe(200);
    });
  });

  describe("what the APP reports on its bench poll (no helper heartbeat): stored, shown read-only, and the attention rules", () => {
    const GOOD = { install_id: "inst_h5_1", helper_version: "0.2.0", helper_registration: "enabled", helper_xpc_ok: true, helper_state: "ok", console_user: true, power_schedule: "MTWRFSU 07:05", pmset_drift: "sleep" };
    /** the poll's answer, THEN the deferred helper write run to completion (what the runtime does after the response) */
    const flush = async () => { const fns = H.deferred.splice(0); for (const f of fns) await f(); };
    const poll = async (over: Record<string, unknown> = {}) => {
      const out = await (await import("@/lib/room-install")).applyInstallPoll({ ...GOOD, ...over } as never, {});
      await flush();
      return out;
    };
    const pollNoFlush = async (over: Record<string, unknown> = {}) => (await import("@/lib/room-install")).applyInstallPoll({ ...GOOD, ...over } as never, {});
    const row = async () => (await q<Record<string, any>>`SELECT helper_version, helper_registration, helper_xpc_ok, helper_state, console_user, power_schedule, pmset_drift, helper_bad_since FROM room_install WHERE install_id = 'inst_h5_1'`)[0]!;
    const DAY = Date.parse("2026-10-11T10:00:00+05:30");
    const at = (secBefore: number) => new Date(DAY - secBefore * 1000).toISOString();
    const setRow = (set: string) => pg.exec(`UPDATE room_install SET ${set} WHERE install_id = 'inst_h5_1'`);

    it("power_schedule, pmset_drift, helper fields and console_user arrive on the poll and are stored; hostile/malformed values are dropped field by field", async () => {
      expect(await poll()).toMatchObject({ ok: true });
      expect(await row()).toMatchObject({ helper_version: "0.2.0", helper_registration: "enabled", helper_xpc_ok: true, helper_state: "ok", console_user: true, power_schedule: "MTWRFSU 07:05", pmset_drift: ["sleep"], helper_bad_since: null });
      await poll({ helper_state: "Not OK; DROP", power_schedule: "line1\nline2", pmset_drift: "ok,BAD TOKEN", helper_registration: "hacked" });
      expect(await row()).toMatchObject({ helper_state: "ok", power_schedule: "MTWRFSU 07:05", pmset_drift: ["sleep"], helper_registration: "enabled" }); // the old readings stand
    });

    it("a poll that omits the fields (an app below 0.1.35) changes nothing and costs no second statement", async () => {
      await poll();
      H.statements.length = 0;
      await poll({ helper_version: undefined, helper_registration: undefined, helper_xpc_ok: undefined, helper_state: undefined, console_user: undefined, power_schedule: undefined, pmset_drift: undefined });
      expect(H.statements.filter((t) => /helper_state/.test(t))).toEqual([]);
      expect(await row()).toMatchObject({ helper_state: "ok", console_user: true, power_schedule: "MTWRFSU 07:05" });
    });

    it("helper_bad_since: starts at the first bad reading, is kept (not moved) by later bad readings, is left alone by a poll with neither field, and clears on the first good one", async () => {
      await poll({ helper_state: "xpc_down", helper_xpc_ok: false });
      const first = (await row()).helper_bad_since;
      expect(first).not.toBeNull();
      pg.exec(`SELECT pg_sleep(0.05)`);
      await poll({ helper_state: "stopped", helper_xpc_ok: false });
      expect((await row()).helper_bad_since).toBe(first);
      await poll({ helper_state: undefined, helper_xpc_ok: undefined, power_schedule: "MTWRFSU 07:05" });
      expect((await row()).helper_bad_since).toBe(first);
      await poll({ helper_state: "ok", helper_xpc_ok: true });
      expect((await row()).helper_bad_since).toBeNull();
      await poll({ helper_state: "ok", helper_xpc_ok: false }); // xpc false alone is bad
      expect((await row()).helper_bad_since).not.toBeNull();
    });

    it("F1: the helper write runs AFTER the poll's answer — a 3 s trigger on that write does not delay the poll, and the write still lands", async () => {
      pg.exec(`
        CREATE OR REPLACE FUNCTION h5_slow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.helper_state = 'slow' THEN PERFORM pg_sleep(3); END IF; RETURN NEW; END $$;
        CREATE TRIGGER h5_slow BEFORE UPDATE ON room_install FOR EACH ROW EXECUTE FUNCTION h5_slow();
      `);
      try {
        const t0 = Date.now();
        const out = await pollNoFlush({ helper_state: "slow" });
        const answered = Date.now() - t0;
        expect(out).toMatchObject({ ok: true });
        expect(answered, `the poll took ${answered} ms; the slow write must not be on its path`).toBeLessThan(1500);
        expect(H.deferred).toHaveLength(1); // scheduled with after(), not run
        expect((await row()).helper_state).toBeNull(); // not written yet when the answer went out
        const t1 = Date.now();
        await flush(); // what the runtime does once the response is sent
        expect(Date.now() - t1).toBeGreaterThanOrEqual(2900); // the 3 s is spent HERE, off the response path
        expect((await row()).helper_state).toBe("slow");
      } finally {
        pg.exec("DROP TRIGGER IF EXISTS h5_slow ON room_install; DROP FUNCTION IF EXISTS h5_slow()");
      }
    });

    it("F1: outside a request scope (after() unavailable) the write is still deferred past the caller's answer (macrotask), and an old app's poll schedules nothing", async () => {
      H.afterMode = "throw";
      await pollNoFlush({ helper_state: "xpc_down", helper_xpc_ok: false });
      expect((await row()).helper_state).toBeNull(); // the answer came back before the write ran
      for (let i = 0; i < 100 && (await row()).helper_state === null; i += 1) await new Promise((r) => setTimeout(r, 50));
      expect((await row()).helper_state).toBe("xpc_down");
      H.afterMode = "capture";
      await pollNoFlush({ helper_state: undefined, helper_xpc_ok: undefined, helper_version: undefined, helper_registration: undefined, console_user: undefined, power_schedule: undefined, pmset_drift: undefined });
      expect(H.deferred).toHaveLength(0);
    });

    it("a failing helper write NEVER fails the poll (best effort, logged by name)", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      pg.exec(`
        CREATE OR REPLACE FUNCTION h5_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.helper_state = 'boom' THEN RAISE EXCEPTION 'helper write down'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER h5_boom BEFORE UPDATE ON room_install FOR EACH ROW EXECUTE FUNCTION h5_boom();
      `);
      try {
        expect(await poll({ helper_state: "boom" })).toMatchObject({ ok: true });
        const logged = err.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(logged).toContain("install=inst_h5_1");
        expect(logged).toMatch(/code=\w+/); // P0001 on the real driver; the psql test harness carries no SQLSTATE
        expect(logged).not.toContain("helper write down"); // the database's message can quote a value: ids and the error code only
        expect((await row()).helper_state).toBeNull();
        expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM room_install WHERE install_id = 'inst_h5_1' AND last_seen_at > now() - interval '5 seconds'`)[0]!.n).toBe(1); // the main poll write still landed
      } finally {
        pg.exec("DROP TRIGGER IF EXISTS h5_boom ON room_install; DROP FUNCTION IF EXISTS h5_boom()");
      }
    });

    it("Bench / admin view and the MCP view show the app-reported health read-only; no secret or signature anywhere", async () => {
      await poll();
      const r = await overview();
      const d = (r.json.devices as Array<Record<string, any>>).find((x) => x.device_id === DEV)!;
      expect(d.helper.health).toMatchObject({ helper_version: "0.2.0", helper_state: "ok", helper_xpc_ok: true, power_schedule: "MTWRFSU 07:05", pmset_drift: ["sleep"], console_user: true });
      expect((r.json.devices as Array<Record<string, any>>).find((x) => x.device_id === DEV2)!.helper.health).toBeNull(); // that app has not reported
      H.statements.length = 0;
      const mcp = await kiosks({ view: "helper" });
      expect(((mcp.devices as Array<Record<string, any>>).find((x) => x.device_id === DEV))!.helper.health.pmset_drift).toEqual(["sleep"]);
      expect(H.statements.filter((t) => /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i.test(t))).toEqual([]);
      const text = JSON.stringify([r.json, mcp]);
      for (const x of ["signature", "nonce", "public_key", PUB, KEY]) expect(text, x).not.toContain(x);
    });

    it("helper_missing (AMBER): the app is polling, the helper has read bad for over 3 min — on the device view and in the live attention loader; clears when the app reports ok; not raised for an app that never reported", async () => {
      const { getFleetAttention } = await import("@/lib/fleet-attention");
      setRow(`last_seen_at = '${at(2)}', helper_state = 'xpc_down', helper_xpc_ok = false, helper_bad_since = '${at(240)}', console_user = true`);
      const a = await getFleetAttention(DAY);
      expect(a.items.find((i) => i.room_id === "room_h5a" && i.kind === "helper_missing")).toMatchObject({ severity: "amber" });
      const dev = (await fleetDevices(H.sql as never, null, DAY)).find((x) => x.device_id === DEV)!;
      expect(dev.helper.attention).toMatchObject({ kind: "helper_missing", severity: "amber" });
      expect(dev.helper.bad_for_s).toBe(240);
      expect(a.items.some((i) => i.room_id === "room_h5b" && (i.kind === "helper_missing" || i.kind === "app_missing"))).toBe(false); // room B never reported
      setRow(`helper_state = 'ok', helper_xpc_ok = true, helper_bad_since = NULL`);
      expect((await getFleetAttention(DAY)).items.some((i) => i.kind === "helper_missing")).toBe(false);
    });

    it("app_missing (RED): no bench poll for over 3 min in clinic hours, last report had a console user — on the device view and in the loader; not at night, not without a console user, not when the Mac is already unreachable (one red row)", async () => {
      const { getFleetAttention } = await import("@/lib/fleet-attention");
      setRow(`last_seen_at = '${at(240)}', console_user = true, helper_state = 'ok', helper_xpc_ok = true, helper_bad_since = NULL`);
      // the Mac is UP (its kiosk-health daemon is still talking), only the recorder app has gone quiet
      pg.exec(`INSERT INTO kiosk_health_events (received_at, machine, boot_id, seq, source, kind, ts, payload) VALUES ('${at(20)}', '${HOST}', 'b', 1, 'daemon', 'heartbeat', '${at(20)}', '{}'::jsonb)`);
      const items = (await getFleetAttention(DAY)).items.filter((i) => i.room_id === "room_h5a");
      expect(items.find((i) => i.kind === "app_missing")).toMatchObject({ severity: "red" });
      expect(items.some((i) => i.kind === "asleep")).toBe(false);
      // ...but when NOTHING hears from the Mac, R1 already says it is unreachable and app_missing is not a second red row for the same fault
      pg.exec(`DELETE FROM kiosk_health_events`);
      const both = (await getFleetAttention(DAY)).items.filter((i) => i.room_id === "room_h5a");
      expect(both.some((i) => i.kind === "asleep")).toBe(true);
      expect(both.some((i) => i.kind === "app_missing")).toBe(false);
      pg.exec(`INSERT INTO kiosk_health_events (received_at, machine, boot_id, seq, source, kind, ts, payload) VALUES ('${at(20)}', '${HOST}', 'b', 2, 'daemon', 'heartbeat', '${at(20)}', '{}'::jsonb)`);
      const dev = (await fleetDevices(H.sql as never, null, DAY)).find((x) => x.device_id === DEV)!;
      expect(dev.helper.attention).toMatchObject({ kind: "app_missing", severity: "red" });
      const NIGHT = Date.parse("2026-10-11T22:00:00+05:30");
      setRow(`last_seen_at = '${new Date(NIGHT - 240_000).toISOString()}'`);
      expect((await getFleetAttention(NIGHT)).items.some((i) => i.kind === "app_missing")).toBe(false);
      setRow(`last_seen_at = '${at(240)}', console_user = false`);
      expect((await getFleetAttention(DAY)).items.some((i) => i.kind === "app_missing")).toBe(false);
    });

    it("a FAILING helper read is marked degraded (never a silent all-clear); a poll-driven rule never needs the fleet tables", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      pg.exec(`ALTER TABLE room_install RENAME COLUMN helper_state TO helper_state_x`);
      try {
        const { getFleetAttention } = await import("@/lib/fleet-attention");
        expect((await getFleetAttention(DAY)).degraded).toContain("helper_fleet");
      } finally {
        pg.exec(`ALTER TABLE room_install RENAME COLUMN helper_state_x TO helper_state`);
      }
    });
  });

  it("nothing in this slice enqueues on its own: the only callers of issueCommand/queueCommand are still the admin route", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
    const callers = [...walk("app"), ...walk("lib"), ...walk("scripts")].filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !f.startsWith("lib/fleet/")).filter((f) => /issueCommand|queueCommand/.test(readFileSync(f, "utf8")));
    expect(callers).toEqual(["app/api/admin/fleet/commands/route.ts"]);
    for (const f of ["lib/fleet/helper-health.ts", "lib/fleet/read.ts"]) expect(readFileSync(f, "utf8"), f).not.toMatch(/issueCommand|queueCommand|INSERT INTO|UPDATE |DELETE FROM/);
  });
});
