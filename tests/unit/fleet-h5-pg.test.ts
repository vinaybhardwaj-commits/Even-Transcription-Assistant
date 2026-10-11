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
  sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>,
  cookie: null as string | null,
  statements: [] as string[],
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => { H.statements.push(s.join("?")); return H.sql(s, ...v); } }));
vi.mock("@/lib/cookie", async (orig) => ({ ...(await orig<Record<string, unknown>>()), readAdminCookie: async () => H.cookie }));
vi.setConfig({ testTimeout: 90_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-fleet-h5");

import { signAdminJwt, signDoctorJwt } from "@/lib/auth";
import { loadSigner } from "@/lib/fleet/signing";
import { claimCommands } from "@/lib/fleet/poll";
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

const beat = (host: string, secAgo: number, payload: Record<string, unknown>, seq = 1) =>
  pg.exec(`INSERT INTO kiosk_health_events (received_at, machine, boot_id, seq, source, kind, ts, payload) VALUES
    (now() - interval '${secAgo} seconds', '${host}', 'b', ${seq}, 'helper', 'helper.heartbeat', now() - interval '${secAgo} seconds', '${JSON.stringify(payload)}'::jsonb)`);
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

  describe("heartbeat fields shown read-only (#43) and the attention rules (#46) on Bench and the MCP door", () => {
    const GOOD = { helper_version: "0.2.0", app_version: "0.1.30", registration: "enabled", xpc_ok: true, app_state: "running", console_user: true, session_open: false, power_schedule: "MTWRFSU 07:05", pmset_drift: ["sleep"], chrome_policy: "ok", poll_last_ok_s: 3, safe_mode: false };

    it("power_schedule and pmset_drift from the NEWEST heartbeat are shown; hostile payload fields are sanitised away; a stale-only host shows no health", async () => {
      beat(HOST, 300, { ...GOOD, power_schedule: "OLD", pmset_drift: [] }, 1);
      beat(HOST, 20, { ...GOOD, token: "SECRETMARK", power_schedule: "MTWRFSU 07:05", app_state: "bogus" }, 2);
      const r = await overview();
      const d = (r.json.devices as Array<Record<string, any>>).find((x) => x.device_id === DEV)!;
      expect(d.helper.health).toMatchObject({ power_schedule: "MTWRFSU 07:05", pmset_drift: ["sleep"], app_state: null, xpc_ok: true, console_user: true });
      expect(d.helper.heartbeat_age_s).toBe(20);
      expect(JSON.stringify(r.json)).not.toContain("SECRETMARK");
      expect((r.json.devices as Array<Record<string, any>>).find((x) => x.device_id === DEV2)!.helper.health).toBeNull();
    });

    it("app_missing: helper heartbeat fresh + console user + no bench poll for over 3 min -> RED on the device view, on the MCP view, and in the live attention loader", async () => {
      beat(HOST, 20, GOOD);
      pg.exec(`UPDATE room_install SET last_seen_at = now() - interval '4 minutes' WHERE install_id = 'inst_h5_1'`);
      const r = await overview();
      const d = (r.json.devices as Array<Record<string, any>>).find((x) => x.device_id === DEV)!;
      expect(d.helper.attention).toMatchObject({ kind: "app_missing", severity: "red" });
      const mcp = await kiosks({ view: "helper" });
      expect(((mcp.devices as Array<Record<string, any>>).find((x) => x.device_id === DEV))!.helper.attention.kind).toBe("app_missing");
      const { getFleetAttention } = await import("@/lib/fleet-attention");
      const att = await getFleetAttention(Date.now());
      expect(att.items.filter((i) => i.room_id === "room_h5a" && i.kind === "app_missing")).toHaveLength(1);
      expect(att.items.find((i) => i.room_id === "room_h5a" && i.kind === "app_missing")).toMatchObject({ severity: "red" });
      expect(att.items.some((i) => i.room_id === "room_h5b" && (i.kind === "app_missing" || i.kind === "helper_missing"))).toBe(false);
      expect(att.degraded ?? []).not.toContain("helper_fleet");
    });

    it("app_missing is NOT raised for needs_enrol / no_console_user (no relaunch spam at the login window)", async () => {
      pg.exec(`UPDATE room_install SET last_seen_at = now() - interval '4 minutes' WHERE install_id = 'inst_h5_1'`);
      beat(HOST, 20, { ...GOOD, app_state: "no_console_user", console_user: false });
      const { getFleetAttention } = await import("@/lib/fleet-attention");
      expect((await getFleetAttention(Date.now())).items.some((i) => i.kind === "app_missing")).toBe(false);
      beat(HOST, 10, { ...GOOD, app_state: "needs_enrol" }, 2);
      expect((await getFleetAttention(Date.now())).items.some((i) => i.kind === "app_missing")).toBe(false);
    });

    it("helper_missing: app polling, helper silent for over 3 min -> AMBER; a fresh long-poll clears it; an unregistered room never raises it", async () => {
      pg.exec(`UPDATE fleet_devices SET last_poll_at = now() - interval '5 minutes', registered_at = now() - interval '1 day' WHERE device_id = '${DEV}'`);
      const { getFleetAttention } = await import("@/lib/fleet-attention");
      const a = await getFleetAttention(Date.now());
      expect(a.items.find((i) => i.room_id === "room_h5a" && i.kind === "helper_missing")).toMatchObject({ severity: "amber" });
      const view = ((await overview()).json.devices as Array<Record<string, any>>).find((x) => x.device_id === DEV)!;
      expect(view.helper.attention).toMatchObject({ kind: "helper_missing", severity: "amber" });
      pg.exec(`UPDATE fleet_devices SET last_poll_at = now() - interval '10 seconds' WHERE device_id = '${DEV}'`);
      expect((await getFleetAttention(Date.now())).items.some((i) => i.kind === "helper_missing")).toBe(false);
      pg.exec(`UPDATE fleet_devices SET status = 'revoked', last_poll_at = now() - interval '9 minutes' WHERE device_id = '${DEV}'`);
      expect((await getFleetAttention(Date.now())).items.some((i) => i.room_id === "room_h5a" && i.kind === "helper_missing")).toBe(false);
    });

    it("rooms with NO helper device get no helper rule and no degraded flag (the fleet is just not there)", async () => {
      pg.exec(`TRUNCATE fleet_devices CASCADE`);
      const { getFleetAttention } = await import("@/lib/fleet-attention");
      const a = await getFleetAttention(Date.now());
      expect(a.items.some((i) => i.kind === "app_missing" || i.kind === "helper_missing")).toBe(false);
      expect(a.degraded ?? []).not.toContain("helper_fleet");
    });

    it("a FAILING helper read is marked degraded (never a silent all-clear)", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      pg.exec(`ALTER TABLE fleet_devices RENAME TO fleet_devices_x`);
      try {
        const { getFleetAttention } = await import("@/lib/fleet-attention");
        expect((await getFleetAttention(Date.now())).degraded).toContain("helper_fleet");
      } finally {
        pg.exec(`ALTER TABLE fleet_devices_x RENAME TO fleet_devices`);
      }
    });

    it("the views stay read-only and carry no secret", async () => {
      beat(HOST, 20, { ...GOOD, token: "SECRETMARK" });
      H.statements.length = 0;
      const mcp = await kiosks({ view: "helper" });
      await overview();
      expect(H.statements.filter((s) => /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i.test(s))).toEqual([]);
      const text = JSON.stringify(mcp);
      for (const s of ["SECRETMARK", "signature", "nonce", "public_key", PUB]) expect(text, s).not.toContain(s);
    });
  });

  it("nothing in this slice enqueues on its own: the only callers of issueCommand/queueCommand are still the admin route", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
    const callers = [...walk("app"), ...walk("lib"), ...walk("scripts")].filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !f.startsWith("lib/fleet/")).filter((f) => /issueCommand|queueCommand/.test(readFileSync(f, "utf8")));
    expect(callers).toEqual(["app/api/admin/fleet/commands/route.ts"]);
    for (const f of ["lib/fleet/helper-health.ts", "lib/fleet/read.ts"]) expect(readFileSync(f, "utf8"), f).not.toMatch(/issueCommand|queueCommand|INSERT INTO|UPDATE fleet|DELETE FROM/);
  });
});
