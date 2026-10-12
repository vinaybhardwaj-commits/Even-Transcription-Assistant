/**
 * TS-H7/H10/H11 server side on a REAL postgres:16 with EVERY migration (incl. 0154): the five Chrome / legacy verbs through the admin route, the clinic-hours refusal of Chrome restarts,
 * the extension token (server config -> signed params -> redacted at rest -> back only into the device's own poll), and POST /api/kiosk-health with a Device credential plus
 * cross-source de-duplication. Keys are FIXED FAKE seeds; the token below is a made-up string. All ids are fake.
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
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray | string, ...v: unknown[]) => { H.statements.push(typeof s === "string" ? s : s.join("?")); return (H.sql as (s: unknown, ...v: unknown[]) => Promise<unknown[]>)(s, ...v); } }));
vi.mock("@/lib/cookie", async (orig) => ({ ...(await orig<Record<string, unknown>>()), readAdminCookie: async () => H.cookie }));
vi.setConfig({ testTimeout: 90_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-fleet-h6");

import { signAdminJwt, signDoctorJwt } from "@/lib/auth";
import { loadSigner } from "@/lib/fleet/signing";
import { claimCommands } from "@/lib/fleet/poll";
import { fleetDevices } from "@/lib/fleet/read";
import { signRoomJwt } from "@/lib/room-auth";
import { signJws, sha256b64url } from "@/lib/fleet/jws";
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
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
  // The kiosk-health route also calls `sql(text, params)` (numbered placeholders) for its multi-row INSERT; the psql harness only knows tagged templates, so that form is rewritten to one.
  const tagged = pg.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>;
  H.sql = ((a: unknown, ...v: unknown[]) => {
    if (typeof a !== "string") return tagged(a as TemplateStringsArray, ...v);
    const parts = a.split(/\$\d+/);
    return tagged(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...(v[0] as unknown[]));
  }) as never;
}, 300_000);
afterAll(() => { if (HAVE) pg.stop(); });

const HOST = "EHRC-H6s-Mac-mini";
const TOKEN = "EXTTOKEN-made-up-0123456789abcdef";
const DAEMON_TOKEN = "daemon-bearer-made-up-token";
const keypair = (): { priv: KeyObject; pub: string } => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { priv: privateKey, pub: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") };
};
const DEVKEY = keypair();
const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  if (!HAVE) return;
  process.env.FLEET_COMMAND_SIGNING_KEY = KEY;
  process.env.PRESENCE_INGEST_TOKEN = TOKEN;
  process.env.KIOSK_HEALTH_INGEST_TOKEN = DAEMON_TOKEN;
  pg.exec(`
    TRUNCATE fleet_results, fleet_commands, fleet_devices, fleet_jti, fleet_control, fleet_audit, kiosk_health_events, kiosk_health_dedupe RESTART IDENTITY CASCADE;
    DELETE FROM bench_session WHERE room_id IN ('room_h6a', 'room_h6b');
    DELETE FROM room_install WHERE install_id LIKE 'inst_h6_%'; DELETE FROM room WHERE id IN ('room_h6a', 'room_h6b');
    INSERT INTO room (id, slug, name, pin_hash) VALUES ('room_h6a', 'h6-a', 'H6 A', 'x'), ('room_h6b', 'h6-b', 'H6 B', 'x');
    INSERT INTO room_install (install_id, room_id, hostname, enrolled_at, enrolled_by, last_seen_at) VALUES
      ('inst_h6_1', 'room_h6a', 'EHRC-H6’s Mac mini', now(), 'test', now()),
      ('inst_h6_2', 'room_h6b', 'EHRC-H6Bs-Mac-mini', now(), 'test', now());
    INSERT INTO fleet_devices (device_id, install_id, room_id, machine, public_key, helper_version, registered_at, last_poll_at) VALUES
      ('${DEV}', 'inst_h6_1', 'room_h6a', '${HOST}', '${DEVKEY.pub}', '0.2.2', now() - interval '1 day', now()),
      ('${DEV2}', 'inst_h6_2', 'room_h6b', 'EHRC-H6Bs-Mac-mini', '${PUB}', '0.2.2', now() - interval '1 day', now());
  `);
  H.statements.length = 0;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const dayAt = (hhmm: string) => new Date(`2026-10-11T${hhmm}:00+05:30`);
const fakeClock = (hhmm: string) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(dayAt(hhmm)); };

async function poll(token: string) {
  const { GET } = await import("@/app/api/fleet/poll/route");
  const res = await GET(new NextRequest("https://x.test/api/fleet/poll?wait=0", { headers: { authorization: `Device ${token}` } }));
  return { status: res.status, text: await res.text() };
}
const deviceToken = () => signJws({ alg: "EdDSA", typ: "JWT", kid: DEV }, { iss: DEV, aud: "evenscribe-fleet", iat: now(), exp: now() + 300, jti: randomUUID(), htm: "GET", htu: "/api/fleet/poll" }, DEVKEY.priv);

async function kh(body: unknown, authorization: string) {
  const { POST } = await import("@/app/api/kiosk-health/route");
  const res = await POST(new NextRequest("https://x.test/api/kiosk-health", { method: "POST", body: JSON.stringify(body), headers: { authorization, "content-type": "application/json" } }));
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}
const ev = (seq: number, source: string, tsOffsetMs: number, o: Record<string, unknown> = {}) => ({
  machine: "EHRC-H6s-Mac-mini", room_id: null, install_id: null, boot_id: `b-${source}`, seq, source, kind: "power.sleep", ts: new Date(Date.parse("2026-10-11T10:00:00.000Z") + tsOffsetMs).toISOString(), payload: { x: 1 }, ...o,
});
const stored = async () => q<{ source: string; kind: string }>`SELECT source, kind FROM kiosk_health_events ORDER BY id`;

(HAVE ? describe : describe.skip)("TS-H7/H10/H11 server on real postgres", () => {
  describe("#44 / #48 verbs through the admin route", () => {
    it("the catalogue is 20 verbs; privileged are exactly the five restart-ish ones; the new non-privileged ones queue in clinic hours without an approval_ref", async () => {
      const { FLEET_VERBS, CATALOGUE } = await import("@/lib/fleet/verbs");
      expect(FLEET_VERBS).toHaveLength(20);
      expect(FLEET_VERBS.filter((v) => CATALOGUE[v].privileged).sort()).toEqual(["chrome_relaunch", "coreaudiod_reset", "policy_cycle", "reload_launchagent", "restart_recorder", "usb_reseat"].sort());
      fakeClock("10:00");
      for (const b of [
        { verb: "open_pulse", params: { profile: "Profile 1" } },
        { verb: "chrome_policy_apply" },
        { verb: "retire_legacy", params: { component: "presence-guard" } },
      ]) expect(await enqueue({ device_id: DEV, ...b }), b.verb).toMatchObject({ status: 200 });
    });

    it("chrome_relaunch and policy_cycle are REFUSED 07:30-21:30 IST even with an approval_ref (409 clinic_hours_no_chrome_restart); allowed outside; edges 07:29 / 07:30 / 21:29 / 21:30", async () => {
      for (const verb of ["chrome_relaunch", "policy_cycle"]) {
        fakeClock("10:00");
        expect(await enqueue({ device_id: DEV, verb }), verb).toMatchObject({ status: 409, json: { error: "clinic_hours_no_chrome_restart" } });
        expect(await enqueue({ device_id: DEV, verb, approval_ref: "go_fake1", params: { profile: "Default" } }), verb).toMatchObject({ status: 409, json: { error: "clinic_hours_no_chrome_restart" } });
      }
      expect(await q`SELECT 1 FROM fleet_commands`).toHaveLength(0);
      expect(await q`SELECT 1 FROM fleet_audit`).toHaveLength(0);
      fakeClock("22:00");
      expect((await enqueue({ device_id: DEV, verb: "chrome_relaunch", params: { profile: "Default" } })).status).toBe(200);
      expect((await enqueue({ device_id: DEV, verb: "policy_cycle" })).status).toBe(200);
      pg.exec("DELETE FROM fleet_commands");
      for (const [hhmm, expected] of [["07:29", 200], ["07:30", 409], ["21:29", 409], ["21:30", 200]] as const) {
        fakeClock(hhmm);
        expect((await enqueue({ device_id: DEV, verb: "chrome_relaunch" })).status, hhmm).toBe(expected);
        pg.exec("DELETE FROM fleet_commands");
      }
    });

    it("closed params exactly as the issues: open_pulse needs a profile; retire_legacy only presence-guard (kiosk-health is NOT retirable), purge_secrets boolean; no extra keys; no free text", async () => {
      fakeClock("22:00");
      const bad = [
        { verb: "open_pulse" }, { verb: "open_pulse", params: { profile: "" } }, { verb: "open_pulse", params: { profile: "x".repeat(65) } }, { verb: "open_pulse", params: { profile: "P", url: "https://x" } },
        { verb: "retire_legacy" }, { verb: "retire_legacy", params: { component: "kiosk-health" } }, { verb: "retire_legacy", params: { component: "presence-guard", purge_secrets: "yes" } },
        { verb: "retire_legacy", params: { component: "presence-guard", path: "/etc" } }, { verb: "chrome_relaunch", params: { profile: 5 } }, { verb: "policy_cycle", params: { force: true } },
        { verb: "chrome_policy_apply", params: { update_url: "https://evil.example/ext/update.xml" } }, { verb: "chrome_policy_apply", params: { update_url: "http://www.evenscribe.app/ext/update.xml" } },
      ];
      for (const b of bad) expect(await enqueue({ device_id: DEV, ...b }), JSON.stringify(b)).toMatchObject({ status: 400, json: { error: "bad_params" } });
      expect((await enqueue({ device_id: DEV, verb: "retire_legacy", params: { component: "presence-guard", purge_secrets: true } })).status).toBe(200);
      expect((await enqueue({ device_id: DEV, verb: "chrome_policy_apply", params: { update_url: "https://www.evenscribe.app/ext/EHRC-H6s-Mac-mini/update.xml" } })).status).toBe(200);
      expect(await q`SELECT 1 FROM fleet_commands`).toHaveLength(2);
    });
  });

  describe("#44 the extension token never leaves server config except into the device's own poll", () => {
    const allText = async () => JSON.stringify([
      await q`SELECT * FROM fleet_commands`, await q`SELECT * FROM fleet_audit`, await q`SELECT * FROM fleet_results`,
    ]);

    it("enqueue: the server supplies machine_id, room and token, signs them; the DB, the audit, the API response, the admin view and the MCP view hold only the marker", async () => {
      const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info")].map((s) => s.mockImplementation(() => {}));
      const r = await enqueue({ device_id: DEV, verb: "chrome_policy_apply" });
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.json)).not.toContain(TOKEN);
      const row = (await q<Record<string, any>>`SELECT params, signature FROM fleet_commands`)[0]!;
      expect(row.params).toEqual({ machine_id: "EHRC-H6s-Mac-mini", room: "H6 A", token: "[redacted:server_token]" });
      expect(await allText()).not.toContain(TOKEN);
      expect((await q<{ summary: string }>`SELECT summary FROM fleet_audit`)[0]!.summary).toBe("verb chrome_policy_apply");
      const view = await overview();
      expect(JSON.stringify(view.json)).not.toContain(TOKEN);
      expect(JSON.stringify(await kiosks({ view: "commands" }))).not.toContain(TOKEN);
      expect(JSON.stringify(await kiosks({ view: "helper" }))).not.toContain(TOKEN);
      expect(JSON.stringify((await fleetDevices(H.sql as never, null)))).not.toContain(TOKEN);
      expect(JSON.stringify(spies.flatMap((s) => s.mock.calls))).not.toContain(TOKEN);
      expect(H.statements.join("\n")).not.toContain(TOKEN); // not even in the SQL text (it is only ever a bound value, and never one that reaches SQL)
    });

    it("the operator cannot supply it or anything else for this verb: token / machine_id / room in params are refused and not echoed", async () => {
      for (const params of [{ token: "operator-picked-secret-12345" /* gitleaks:allow (made-up) */ }, { machine_id: "X" }, { room: "X" }, { token: TOKEN }]) {
        const r = await enqueue({ device_id: DEV, verb: "chrome_policy_apply", params });
        expect(r).toMatchObject({ status: 400, json: { error: "bad_params" } });
        expect(JSON.stringify(r.json)).not.toMatch(/operator-picked|EXTTOKEN/);
      }
      expect(await q`SELECT 1 FROM fleet_commands`).toHaveLength(0);
    });

    it("no server-side token configured: 503 extension_token_not_configured, nothing stored; a command already queued is HELD (not delivered) until the token is back", async () => {
      expect((await enqueue({ device_id: DEV, verb: "chrome_policy_apply" })).status).toBe(200);
      delete process.env.PRESENCE_INGEST_TOKEN;
      expect(await claimCommands(H.sql as never, DEV)).toEqual([]);
      expect((await q<{ state: string; delivery_count: number }>`SELECT state, delivery_count FROM fleet_commands`)[0]).toEqual({ state: "queued", delivery_count: 0 });
      pg.exec("DELETE FROM fleet_audit; DELETE FROM fleet_commands");
      expect(await enqueue({ device_id: DEV2, verb: "chrome_policy_apply" })).toMatchObject({ status: 503, json: { error: "extension_token_not_configured" } });
      expect(await q`SELECT 1 FROM fleet_commands`).toHaveLength(0);
      process.env.PRESENCE_INGEST_TOKEN = TOKEN;
      expect((await enqueue({ device_id: DEV2, verb: "chrome_policy_apply" })).status).toBe(200);
      expect(await claimCommands(H.sql as never, DEV2)).toHaveLength(1);
    });

    it("the device's own authenticated poll receives the REAL token inside the signed params, and the envelope verifies under the server's public key; the stored row is untouched", async () => {
      expect((await enqueue({ device_id: DEV, verb: "chrome_policy_apply", params: { update_url: "https://www.evenscribe.app/ext/EHRC-H6s-Mac-mini/update.xml" } })).status).toBe(200);
      const r = await poll(deviceToken());
      expect(r.status).toBe(200);
      const env = (JSON.parse(r.text) as { commands: Envelope[] }).commands[0]!;
      expect(env.params).toEqual({ machine_id: "EHRC-H6s-Mac-mini", room: "H6 A", token: TOKEN, update_url: "https://www.evenscribe.app/ext/EHRC-H6s-Mac-mini/update.xml" });
      expect(verifyEnvelope(env, { publicKeys: KEYS, nowMs: Date.now(), nonceSeen: () => false, deviceId: DEV, machine: HOST })).toEqual({ ok: true });
      expect(await allText()).not.toContain(TOKEN);
    });

    it("a token rotated between enqueue and delivery is delivered but cannot verify (bad_signature): the helper refuses it, the operator re-issues", async () => {
      expect((await enqueue({ device_id: DEV, verb: "chrome_policy_apply" })).status).toBe(200);
      process.env.PRESENCE_INGEST_TOKEN = "ROTATED-made-up-token-9876543210";
      const env = (await claimCommands(H.sql as never, DEV))[0]!;
      expect(env.params.token).toBe("ROTATED-made-up-token-9876543210");
      expect(verifyEnvelope(env, { publicKeys: KEYS, nowMs: Date.now(), nonceSeen: () => false, deviceId: DEV, machine: HOST })).toEqual({ ok: false, reason: "bad_signature" });
    });

    it("other verbs' params are served exactly as stored (no marker handling leaks onto them)", async () => {
      expect((await enqueue({ device_id: DEV, verb: "open_pulse", params: { profile: "Profile 1" } })).status).toBe(200);
      const env = (await claimCommands(H.sql as never, DEV))[0]!;
      expect(env.params).toEqual({ profile: "Profile 1" });
      expect(verifyEnvelope(env, { publicKeys: KEYS, nowMs: Date.now(), nonceSeen: () => false, deviceId: DEV, machine: HOST })).toEqual({ ok: true });
    });
  });

  describe("#47 POST /api/kiosk-health with a Device credential, and cross-source de-duplication", () => {
    const BEARER = `Bearer ${DAEMON_TOKEN}`;
    const device = async (room = "room_h6a") => `Device ${await signRoomJwt({ room_id: room, slug: "s" })}`;

    it("a helper event for this room's Mac is stored with source helper; another room's Mac, source daemon, and steward.result are rejected by name", async () => {
      const r = await kh({ events: [ev(1, "helper", 0), ev(2, "daemon", 0, { boot_id: "b2" }), ev(3, "helper", 0, { machine: "EHRC-H6Bs-Mac-mini", boot_id: "b3" }), ev(4, "helper", 0, { kind: "steward.result", boot_id: "b4" })] }, await device());
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ accepted: 1, rejected: 3, deduped: 0 });
      expect((r.json.rejected_reasons as Array<{ reason: string }>).map((x) => x.reason).sort()).toEqual(["kind_not_allowed", "machine_not_in_room", "wrong_source"]);
      expect(await stored()).toEqual([{ source: "helper", kind: "power.sleep" }]);
    });

    it("an invalid Device token is 401 and stores nothing; the daemon's Bearer path still works and still stores any source", async () => {
      expect((await kh({ events: [ev(1, "helper", 0)] }, "Device garbage")).status).toBe(401);
      expect((await kh({ events: [ev(1, "daemon", 0)] }, "Bearer wrong")).status).toBe(401);
      expect((await kh({ events: [ev(1, "daemon", 0)] }, BEARER)).json).toMatchObject({ accepted: 1, deduped: 0 });
      expect(await stored()).toEqual([{ source: "daemon", kind: "power.sleep" }]);
    });

    it("DEDUPE helper after daemon: the twin (same Mac, kind, ts within 2 s, different source) is not stored; counted in `deduped`; recorded once in kiosk_health_dedupe; a replay does not record twice", async () => {
      await kh({ events: [ev(1, "daemon", 0)] }, BEARER);
      const post = async () => (await kh({ events: [ev(1, "helper", 1500)] }, await device())).json;
      expect(await post()).toMatchObject({ accepted: 0, deduped: 1, duplicates: 0, rejected: 0 });
      expect(await stored()).toEqual([{ source: "daemon", kind: "power.sleep" }]);
      expect(await q`SELECT machine, kind, source, twin_source FROM kiosk_health_dedupe`).toEqual([{ machine: "EHRC-H6s-Mac-mini", kind: "power.sleep", source: "helper", twin_source: "daemon" }]);
      expect(await post()).toMatchObject({ deduped: 1 });
      expect(await q`SELECT 1 FROM kiosk_health_dedupe`).toHaveLength(1);
    });

    it("DEDUPE daemon after helper (either order): the later arrival is the one skipped", async () => {
      await kh({ events: [ev(1, "helper", 0)] }, await device());
      expect((await kh({ events: [ev(1, "daemon", -1800)] }, BEARER)).json).toMatchObject({ accepted: 0, deduped: 1 });
      expect(await stored()).toEqual([{ source: "helper", kind: "power.sleep" }]);
      expect(await q`SELECT source, twin_source FROM kiosk_health_dedupe`).toEqual([{ source: "daemon", twin_source: "helper" }]);
    });

    it("NOT twins: 2001 ms apart, a different kind, the same source twice, another Mac; and the daemon's own repeated kind within 2 s both land", async () => {
      await kh({ events: [ev(1, "daemon", 0)] }, BEARER);
      const r = await kh({ events: [ev(1, "helper", 2001), ev(2, "helper", 0, { kind: "power.wake" }), ev(3, "daemon", 500, { boot_id: "b-daemon" })] }, BEARER);
      expect(r.json).toMatchObject({ accepted: 3, deduped: 0 }); // via the daemon path the helper-labelled rows are same-batch, so only cross-STORED twins count
      const dev = await kh({ events: [ev(9, "helper", 60_000, { machine: "EHRC-H6s-Mac-mini", boot_id: "b-h2" })] }, await device());
      expect(dev.json).toMatchObject({ accepted: 1, deduped: 0 });
      expect((await stored()).length).toBe(5);
    });

    it("idempotency on (machine, boot_id, seq) is unchanged: a replayed helper batch is `duplicates`, not `deduped`", async () => {
      const batch = { events: [ev(1, "helper", 0)] };
      expect((await kh(batch, await device())).json).toMatchObject({ accepted: 1, duplicates: 0, deduped: 0 });
      expect((await kh(batch, await device())).json).toMatchObject({ accepted: 0, duplicates: 1, deduped: 0 });
    });

    describe("C1: the replay key is (machine, source, boot_id, seq) (migration 0155), R8", () => {
      const at = (o: number, source: string, seq: number, boot: string, n: number) => ev(seq, source, o, { boot_id: boot, payload: { n } });
      const ledger = () => q<{ source: string; boot_id: string | null; seq: number | null }>`SELECT source, boot_id, seq FROM kiosk_health_dedupe ORDER BY id`;

      it("R8: a NEW helper event with the SAME ts as an absorbed one (another seq, or another boot_id) is ACCEPTED and stored; a true replay of the absorbed one is deduped again", async () => {
        await kh({ events: [at(0, "daemon", 1, "b-d", 0)] }, BEARER); // the stored twin
        const first = at(500, "helper", 1, "b-h", 1);
        expect((await kh({ events: [first] }, await device())).json).toMatchObject({ accepted: 0, deduped: 1 });
        expect(await ledger()).toEqual([{ source: "helper", boot_id: "b-h", seq: 1 }]); // the ledger now names the event by boot_id/seq
        // same machine, kind, source and ts as the absorbed event, a different seq: a DISTINCT event, previously lost as a "replay"
        expect((await kh({ events: [at(500, "helper", 2, "b-h", 2)] }, await device())).json).toMatchObject({ accepted: 1, deduped: 0, duplicates: 0 });
        // a different boot_id (the Mac rebooted; seq restarted) with the same ts
        expect((await kh({ events: [at(500, "helper", 1, "b-h2", 3)] }, await device())).json).toMatchObject({ accepted: 1, deduped: 0 });
        expect((await q<{ payload: { n: number } }>`SELECT payload FROM kiosk_health_events ORDER BY id`).map((r) => r.payload.n)).toEqual([0, 2, 3]);
        // the TRUE replay of the absorbed event (same boot_id and seq): skipped again, nothing stored, no second ledger row, no second twin used
        expect((await kh({ events: [first] }, await device())).json).toMatchObject({ accepted: 0, deduped: 1, duplicates: 0 });
        expect(await ledger()).toHaveLength(1);
        expect((await stored()).length).toBe(3);
      });

      it("the same-ts case in the OTHER direction: an absorbed DAEMON event, then a distinct daemon event with the same ts is stored", async () => {
        await kh({ events: [at(0, "helper", 1, "b-h", 0)] }, await device());
        expect((await kh({ events: [at(300, "daemon", 1, "b-d", 1)] }, BEARER)).json).toMatchObject({ accepted: 0, deduped: 1 });
        expect((await kh({ events: [at(300, "daemon", 2, "b-d", 2)] }, BEARER)).json).toMatchObject({ accepted: 1, deduped: 0 });
        expect((await kh({ events: [at(300, "daemon", 1, "b-d", 1)] }, BEARER)).json).toMatchObject({ accepted: 0, deduped: 1 });
      });

      it("FALLBACK: a ledger row written BEFORE 0155 (no boot_id/seq) still recognises a replay by ts", async () => {
        await kh({ events: [at(0, "daemon", 1, "b-d", 0)] }, BEARER);
        pg.exec(`INSERT INTO kiosk_health_dedupe (machine, kind, source, twin_source, ts, twin_ts) VALUES ('EHRC-H6s-Mac-mini', 'power.sleep', 'helper', 'daemon', '2026-10-11T10:00:00.500Z', '2026-10-11T10:00:00.000Z');`);
        expect((await kh({ events: [at(500, "helper", 7, "b-h", 7)] }, await device())).json).toMatchObject({ accepted: 0, deduped: 1 });
        expect(await q`SELECT 1 FROM kiosk_health_dedupe`).toHaveLength(1); // not a second row: the old one answered it
      });

      it("migration 0155: applies twice, registers once; the old (machine, kind, source, ts) unique index survives only for rows WITHOUT boot_id; id'd rows are unique on (machine, source, boot_id, seq)", async () => {
        const sqlText = readFileSync("db/migrations/0155_kiosk_health_dedupe_boot_seq.sql", "utf8");
        pg.exec(sqlText);
        pg.exec(sqlText);
        expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM schema_migrations WHERE version = 155`)[0]!.n).toBe(1);
        const idx = (await q<{ indexname: string }>`SELECT indexname FROM pg_indexes WHERE tablename = 'kiosk_health_dedupe'`).map((r) => r.indexname);
        expect(idx).toEqual(expect.arrayContaining(["kiosk_health_dedupe_uidx_legacy", "kiosk_health_dedupe_uidx_id"]));
        expect(idx).not.toContain("kiosk_health_dedupe_uidx");
        const ins = (cols: string) => { try { pg.exec(`INSERT INTO kiosk_health_dedupe (machine, kind, source, twin_source, ts, twin_ts${cols.includes("b1") ? ", boot_id, seq" : ""}) VALUES (${cols});`); return ""; } catch (e) { return String((e as { stderr?: unknown }).stderr ?? e); } };
        const base = "'M', 'k', 'helper', 'daemon', '2026-10-11T10:00:00Z', '2026-10-11T10:00:00Z'";
        expect(ins(base)).toBe("");
        expect(ins(base)).toMatch(/uidx_legacy/); // an id-less duplicate is still refused
        expect(ins(`${base}, 'b1', 1`)).toBe(""); // an id'd row with the same ts is a different event
        expect(ins(`${base}, 'b1', 1`)).toMatch(/uidx_id/);
        expect(ins(`${base}, 'b1', 2`)).toBe("");
      });
    });

    describe("ONE-TO-ONE pairing: distinct events are never lost (refute F1)", () => {
      const sleepAt = (o: number, source: string, seq: number, payload: Record<string, unknown>, boot = `b-${source}`) => ev(seq, source, o, { boot_id: boot, payload });
      const payloads = async () => (await q<{ source: string; payload: { n: number } }>`SELECT source, payload FROM kiosk_health_events ORDER BY id`).map((r) => `${r.source}:${r.payload.n}`);

      it("THE PROBE: one stored daemon event, then 3 DISTINCT helper events at -1.5 s, 0, +1.5 s -> 2 accepted (their payloads stored), exactly 1 deduped (the nearest)", async () => {
        await kh({ events: [sleepAt(0, "daemon", 1, { n: 0 })] }, BEARER);
        const r = await kh({ events: [sleepAt(-1500, "helper", 1, { n: 1 }), sleepAt(0, "helper", 2, { n: 2 }), sleepAt(1500, "helper", 3, { n: 3 })] }, await device());
        expect(r.json).toMatchObject({ accepted: 2, deduped: 1, duplicates: 0, rejected: 0 });
        expect(await payloads()).toEqual(["daemon:0", "helper:1", "helper:3"]); // the helper event at 0 (the nearest) was the twin
        const led = await q<{ source: string; twin_source: string; ts: string; twin_ts: string }>`SELECT source, twin_source, ts, twin_ts FROM kiosk_health_dedupe`;
        expect(led.map((l) => [l.source, l.twin_source, new Date(l.ts).toISOString(), new Date(l.twin_ts).toISOString()])).toEqual([["helper", "daemon", "2026-10-11T10:00:00.000Z", "2026-10-11T10:00:00.000Z"]]);
      });

      it("THE REVERSE: one stored helper event, then 2 daemon events within 1 s -> 1 accepted, 1 deduped", async () => {
        await kh({ events: [sleepAt(0, "helper", 1, { n: 0 })] }, await device());
        const r = await kh({ events: [sleepAt(-900, "daemon", 1, { n: 1 }), sleepAt(300, "daemon", 2, { n: 2 })] }, BEARER);
        expect(r.json).toMatchObject({ accepted: 1, deduped: 1 });
        expect(await payloads()).toEqual(["helper:0", "daemon:1"]);
      });

      it("a stored event that has ALREADY absorbed one is not reusable in a LATER batch; a replay of the skipped batch is skipped again without using another twin", async () => {
        await kh({ events: [sleepAt(0, "daemon", 1, { n: 0 })] }, BEARER);
        const batch = { events: [sleepAt(-1500, "helper", 1, { n: 1 }), sleepAt(0, "helper", 2, { n: 2 }), sleepAt(1500, "helper", 3, { n: 3 })] };
        await kh(batch, await device());
        // the same batch again (a lost response): idempotency covers the two stored, the skipped one stays skipped
        expect((await kh(batch, await device())).json).toMatchObject({ accepted: 0, duplicates: 2, deduped: 1 });
        expect(await q`SELECT 1 FROM kiosk_health_dedupe`).toHaveLength(1);
        expect((await stored()).length).toBe(3);
        // a NEW helper event next to the already-used daemon event has no twin left
        expect((await kh({ events: [sleepAt(200, "helper", 4, { n: 4 })] }, await device())).json).toMatchObject({ accepted: 1, deduped: 0 });
        expect(await payloads()).toEqual(["daemon:0", "helper:1", "helper:3", "helper:4"]);
      });

      it("repeats on both sides pair off: two daemon events and three helper events -> two absorbed, one kept", async () => {
        await kh({ events: [sleepAt(0, "daemon", 1, { n: 0 }), sleepAt(1000, "daemon", 2, { n: 1 })] }, BEARER);
        const r = await kh({ events: [sleepAt(0, "helper", 1, { n: 2 }), sleepAt(1000, "helper", 2, { n: 3 }), sleepAt(500, "helper", 3, { n: 4 })] }, await device());
        expect(r.json).toMatchObject({ accepted: 1, deduped: 2 });
      });
    });

    it("C1: only the daemon/helper pair — a guard event and a daemon event 0.5 s apart BOTH land on the old Bearer path; so do guard vs helper and steward vs daemon", async () => {
      const r = await kh({ events: [ev(1, "guard", 0), ev(2, "daemon", 500, { boot_id: "b-d" }), ev(3, "steward", 100, { boot_id: "b-s" })] }, BEARER);
      expect(r.json).toMatchObject({ accepted: 3, deduped: 0 });
      // a helper event 200 ms from the daemon event IS a twin of it (the pair), and only of it: guard and steward rows are never candidates
      expect((await kh({ events: [ev(4, "helper", 300, { boot_id: "b-h" })] }, await device())).json).toMatchObject({ accepted: 0, deduped: 1 });
      expect(await q<{ twin_source: string }>`SELECT twin_source FROM kiosk_health_dedupe`).toEqual([{ twin_source: "daemon" }]);
      expect((await stored()).map((r) => r.source).sort()).toEqual(["daemon", "guard", "steward"]);
    });

    it("K17: a FAILING dedupe lookup stores everything (a duplicate beats a lost event) and still answers 200", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await kh({ events: [ev(1, "daemon", 0)] }, BEARER);
      pg.exec("ALTER TABLE kiosk_health_dedupe RENAME TO kiosk_health_dedupe_x");
      try {
        const r = await kh({ events: [ev(1, "helper", 100, { boot_id: "b-h" })] }, await device());
        expect(r.status).toBe(200);
        expect(r.json).toMatchObject({ accepted: 1, deduped: 0 }); // would have been a twin; the lookup could not run, so it is stored
        expect((await stored()).length).toBe(2);
      } finally {
        pg.exec("ALTER TABLE kiosk_health_dedupe_x RENAME TO kiosk_health_dedupe");
      }
    });
  });

  it("nothing in this slice enqueues on its own: the only callers of issueCommand/queueCommand are still the admin route", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
    const callers = [...walk("app"), ...walk("lib"), ...walk("scripts")].filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !f.startsWith("lib/fleet/")).filter((f) => /issueCommand|queueCommand/.test(readFileSync(f, "utf8")));
    expect(callers).toEqual(["app/api/admin/fleet/commands/route.ts"]);
  });
});
