/**
 * TS-H8 (#45) + TS-H12 (#49) server side on a REAL postgres:16 with EVERY migration (incl. 0161): the signed release record (cohorts, rollout stage, bucket, unsigned fallback), the admin
 * actions that are the ONLY way a version reaches a cohort (audited, atomic), /api/steward/tickets and /api/kiosk-health with the per-device credential, the (machine, boot_id, seq,
 * source) key, v2-item results via steward.result, and the helper-update progress fields. Keys are FIXED FAKE seeds. All ids are fake.
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
  /** what readRoomClaims answers (the release route authenticates with the room session) */
  claims: null as null | { room_id: string; slug: string; aud: "room" },
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
vi.mock("@/lib/room-auth", async (orig) => ({ ...(await orig<Record<string, unknown>>()), readRoomClaims: async () => H.claims }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray | string, ...v: unknown[]) => { H.statements.push(typeof s === "string" ? s : s.join("?")); return (H.sql as (s: unknown, ...v: unknown[]) => Promise<unknown[]>)(s, ...v); } }));
vi.mock("@/lib/cookie", async (orig) => ({ ...(await orig<Record<string, unknown>>()), readAdminCookie: async () => H.cookie }));
vi.setConfig({ testTimeout: 90_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-fleet-h8");

import { signAdminJwt, signDoctorJwt } from "@/lib/auth";
import { loadSigner } from "@/lib/fleet/signing";
import { claimCommands } from "@/lib/fleet/poll";
import { fleetDevices } from "@/lib/fleet/read";
import { signRoomJwt } from "@/lib/room-auth";
import { parseRecord, verifyRecord, bucketOf } from "@/lib/fleet/release";
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
  H.cookie = opts.cookie === undefined ? await signAdminJwt({ admin_id: "adm_fake1", email: "admin@example.test" }) : opts.cookie;
  const res = await POST(new NextRequest("https://x.test/api/admin/fleet/commands", { method: "POST", body: opts.raw ?? JSON.stringify(body), headers: { "content-type": "application/json" } }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
async function overview(cookie?: string | null) {
  const { GET } = await import("@/app/api/admin/fleet/route");
  H.cookie = cookie === undefined ? await signAdminJwt({ admin_id: "adm_fake1", email: "admin@example.test" }) : cookie;
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

const HOST = "EHRC-H8s-Mac-mini";
const DAEMON_TOKEN = "daemon-bearer-made-up-token";
const keypair = (): { priv: KeyObject; pub: string } => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { priv: privateKey, pub: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") };
};
const DEVKEY = keypair();
const now = () => Math.floor(Date.now() / 1000);
const SHA = "ab".repeat(32);
const URL_OK = "https://www.evenscribe.app/dl/room-recorder-0.1.37.pkg";

beforeEach(() => {
  if (!HAVE) return;
  process.env.FLEET_COMMAND_SIGNING_KEY = KEY;
  process.env.KIOSK_HEALTH_INGEST_TOKEN = DAEMON_TOKEN;
  H.claims = { room_id: "room_h8a", slug: "h8-a", aud: "room" };
  pg.exec(`
    TRUNCATE fleet_results, fleet_commands, fleet_devices, fleet_jti, fleet_control, fleet_audit, kiosk_health_events, kiosk_health_dedupe, fleet_release_rollout, fleet_device_cohort, steward_tickets, steward_nonces RESTART IDENTITY CASCADE;
    DELETE FROM app_release WHERE id LIKE 'rel_h8_%';
    DELETE FROM room_install WHERE install_id LIKE 'inst_h8_%'; DELETE FROM room WHERE id IN ('room_h8a', 'room_h8b');
    INSERT INTO room (id, slug, name, pin_hash) VALUES ('room_h8a', 'h8-a', 'H8 A', 'x'), ('room_h8b', 'h8-b', 'H8 B', 'x');
    INSERT INTO room_install (install_id, room_id, hostname, enrolled_at, enrolled_by, last_seen_at) VALUES
      ('inst_h8_1', 'room_h8a', 'EHRC-H8’s Mac mini', now(), 'test', now()), ('inst_h8_2', 'room_h8b', 'EHRC-H8Bs-Mac-mini', now(), 'test', now());
    INSERT INTO fleet_devices (device_id, install_id, room_id, machine, public_key, helper_version, registered_at, last_poll_at) VALUES
      ('${DEV}', 'inst_h8_1', 'room_h8a', '${HOST}', '${DEVKEY.pub}', '0.2.3', now() - interval '1 day', now()),
      ('${DEV2}', 'inst_h8_2', 'room_h8b', 'EHRC-H8Bs-Mac-mini', '${PUB}', '0.2.3', now() - interval '1 day', now());
    INSERT INTO app_release (id, version, build_sha, sha256, size_bytes, blob_url, channel, published_by, platform)
      VALUES ('rel_h8_1', '0.1.37', 'abc1234', '${"cd".repeat(32)}', 5000, 'https://example.public.blob.vercel-storage.com/app-0.1.37.zip', 'stable', 'test', 'macos');
  `);
  H.statements.length = 0;
});
afterEach(() => { vi.restoreAllMocks(); });

const jsonPost = async (route: string, body: unknown, cookie?: string | null) => {
  const { POST } = await import(route);
  H.cookie = cookie === undefined ? await signAdminJwt({ admin_id: "adm_fake1", email: "admin@example.test" }) : cookie;
  const res = await POST(new NextRequest("https://x.test/x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } }));
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const rollout = (body: Record<string, unknown>, cookie?: string | null) =>
  jsonPost("@/app/api/admin/fleet/releases/rollout/route", { version: "0.1.37", channel: "stable", pkg_url: URL_OK, pkg_sha256: SHA, pkg_size: 123456, cohort: "home_office", ...body }, cookie);
const cohorts = (device_id: string, list: string[], cookie?: string | null) => jsonPost("@/app/api/admin/fleet/releases/cohorts/route", { device_id, cohorts: list }, cookie);
const release = async (channel = "stable") => {
  const { GET } = await import("@/app/api/room-recorder/release/route");
  const res = await GET(new NextRequest(`https://x.test/api/room-recorder/release?channel=${channel}`));
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const dev = (method: "GET" | "POST", path: string, body?: string) =>
  `Device ${signJws({ alg: "EdDSA", typ: "JWT", kid: DEV }, { iss: DEV, aud: "evenscribe-fleet", iat: now(), exp: now() + 300, jti: randomUUID(), htm: method, htu: path, ...(method === "POST" ? { bsha: sha256b64url(Buffer.from(body ?? "", "utf8")) } : {}) }, DEVKEY.priv)}`;
async function tickets(authorization: string, machine = HOST) {
  const { GET } = await import("@/app/api/steward/tickets/route");
  const res = await GET(new NextRequest(`https://x.test/api/steward/tickets?machine=${encodeURIComponent(machine)}`, { headers: { authorization } }));
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}
async function kh(body: unknown, authorization: string) {
  const { POST } = await import("@/app/api/kiosk-health/route");
  const res = await POST(new NextRequest("https://x.test/api/kiosk-health", { method: "POST", body: JSON.stringify(body), headers: { authorization, "content-type": "application/json" } }));
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}
const khDevice = (body: unknown) => kh(body, dev("POST", "/api/kiosk-health", JSON.stringify(body)));
const evt = (seq: number, source: string, o: Record<string, unknown> = {}) => ({
  machine: HOST, room_id: null, install_id: null, boot_id: "b1", seq, source, kind: "power.sleep", ts: "2026-10-11T10:00:00.000Z", payload: { x: 1 }, ...o,
});
const PUBKEYS = { fk1: publicKeysOf(SIGNER).fk1! };

(HAVE ? describe : describe.skip)("TS-H8 / TS-H12 server on real postgres", () => {
  describe("GET /api/room-recorder/release: the signed record", () => {
    it("with no rollout stage the answer is exactly the old four fields (nothing is offered to the helper path until an ADMIN opens it)", async () => {
      const r = await release();
      expect(r.status).toBe(200);
      expect(Object.keys(r.json).sort()).toEqual(["blob_url", "sha256", "size_bytes", "version"]);
    });

    it("after an admin opens the version to a cohort: the old four fields are unchanged and `record` + `record_signature` verify exactly as the app verifies them (bound to the device, 1 h window)", async () => {
      expect((await cohorts(DEV, ["home_office", "opd1"])).status).toBe(200);
      expect((await rollout({ cohort: "home_office" })).status).toBe(200);
      const r = await release();
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ version: "0.1.37", sha256: "cd".repeat(32), size_bytes: 5000, blob_url: "https://example.public.blob.vercel-storage.com/app-0.1.37.zip" });
      expect(r.json.record).toMatchObject({ v: 1, version: "0.1.37", channel: "stable", pkg_url: URL_OK, pkg_sha256: SHA, pkg_size: 123456, min_helper: "0.2.0", cohort: "home_office", rollout_pct: 0, device_cohorts: ["home_office", "opd1"], device_id: DEV, machine: HOST, key_id: "fk1" });
      expect(Object.keys(r.json.record)).toHaveLength(16);
      expect(parseRecord(r.json.record)).not.toBeNull();
      const v = verifyRecord(JSON.stringify(r.json.record), r.json.record_signature, PUBKEYS, DEV, HOST, Date.now());
      expect(v).toMatchObject({ ok: true });
      expect(verifyRecord(JSON.stringify(r.json.record), r.json.record_signature, PUBKEYS, DEV2, HOST, Date.now())).toEqual({ ok: false, reason: "record_wrong_device" });
      // a second answer carries a fresh nonce (and so a different signature)
      const r2 = await release();
      expect(r2.json.record.nonce).not.toBe(r.json.record.nonce);
    });

    it("the stage fields follow the admin's action: pct carries rollout_pct and the device's bucket decides; all is 100", async () => {
      await rollout({ cohort: "pct", rollout_pct: 25 });
      let rec = (await release()).json.record;
      expect(rec).toMatchObject({ cohort: "pct", rollout_pct: 25, device_cohorts: [] });
      await rollout({ cohort: "all" });
      rec = (await release()).json.record;
      expect(rec).toMatchObject({ cohort: "all", rollout_pct: 100 });
      expect(bucketOf(DEV, "0.1.37")).toBeGreaterThanOrEqual(0);
    });

    it("UNSIGNED when FLEET_COMMAND_SIGNING_KEY is unset: the record is returned with record_signature null (the app refuses it); the four fields are untouched", async () => {
      await rollout({ cohort: "all" });
      delete process.env.FLEET_COMMAND_SIGNING_KEY;
      const r = await release();
      expect(r.status).toBe(200);
      expect(r.json.record).toMatchObject({ device_id: DEV, key_id: "fk1" });
      expect(r.json.record_signature).toBeNull();
      expect(verifyRecord(JSON.stringify(r.json.record), r.json.record_signature, PUBKEYS, DEV, HOST, Date.now())).toEqual({ ok: false, reason: "record_bad_signature" });
      expect(r.json.version).toBe("0.1.37");
    });

    it("no record (only the four fields) when the room has no registered device, when the device is revoked, or when the release is withdrawn (404 as before)", async () => {
      await rollout({ cohort: "all" });
      H.claims = { room_id: "room_nodevice", slug: "x", aud: "room" };
      expect(Object.keys((await release()).json).sort()).toEqual(["blob_url", "sha256", "size_bytes", "version"]);
      H.claims = { room_id: "room_h8a", slug: "h8-a", aud: "room" };
      pg.exec(`UPDATE fleet_devices SET status = 'revoked' WHERE device_id = '${DEV}'`);
      expect((await release()).json.record).toBeUndefined();
      pg.exec(`UPDATE fleet_devices SET status = 'active' WHERE device_id = '${DEV}'; UPDATE app_release SET withdrawn_at = now()`);
      expect((await release()).status).toBe(404);
    });

    it("a stored rollout the app's parser would refuse (a bad pkg host) is NEVER signed or offered; the four fields still go out", async () => {
      pg.exec(`INSERT INTO fleet_release_rollout (version, channel, pkg_url, pkg_sha256, pkg_size, cohort, set_by) VALUES ('0.1.37', 'stable', 'https://evil.example/x.pkg', '${SHA}', 10, 'all', 'raw')`);
      vi.spyOn(console, "error").mockImplementation(() => {});
      const r = await release();
      expect(r.status).toBe(200);
      expect(r.json.record).toBeUndefined();
      expect(r.json.version).toBe("0.1.37");
    });

    it("a failure while building the record never costs the room its release answer", async () => {
      await rollout({ cohort: "all" });
      vi.spyOn(console, "error").mockImplementation(() => {});
      pg.exec("ALTER TABLE fleet_device_cohort RENAME TO fleet_device_cohort_x");
      try {
        const r = await release();
        expect(r.status).toBe(200);
        expect(r.json.record).toBeUndefined();
        expect(r.json.sha256).toBe("cd".repeat(32));
      } finally {
        pg.exec("ALTER TABLE fleet_device_cohort_x RENAME TO fleet_device_cohort");
      }
    });
  });

  describe("the admin actions are the ONLY way a version reaches a cohort", () => {
    it("admin cookie only: no cookie, junk, a doctor's cookie -> 401 and nothing written; unknown keys 400; an unpublished version 404", async () => {
      for (const c of [null, "not.a.jwt", await signDoctorJwt({ doctor_id: "doc_fake", email: "d@example.test", slug: "dr-fake" } as never)]) {
        expect((await rollout({}, c)).status).toBe(401);
        expect((await cohorts(DEV, ["opd1"], c)).status).toBe(401);
      }
      expect((await rollout({ extra: 1 })).status).toBe(400);
      expect((await rollout({ version: "9.9.9" }))).toMatchObject({ status: 404, json: { error: "release_not_published" } });
      expect(await q`SELECT 1 FROM fleet_release_rollout`).toHaveLength(0);
      expect(await q`SELECT 1 FROM fleet_audit`).toHaveLength(0);
    });

    it("bad values are named and store nothing: version, channel, pkg_url (host), sha, size, cohort, pct", async () => {
      for (const [o, why] of [[{ version: "x" }, "bad_version"], [{ channel: "beta" }, "bad_channel"], [{ pkg_url: "https://evil.example/x.pkg" }, "bad_pkg_url"], [{ pkg_url: "http://www.evenscribe.app/x.pkg" }, "bad_pkg_url"],
        [{ pkg_sha256: "G".repeat(64) }, "bad_pkg_sha256"], [{ pkg_size: 0 }, "bad_pkg_size"], [{ cohort: "everyone" }, "bad_cohort"], [{ cohort: "pct", rollout_pct: 101 }, "bad_rollout_pct"]] as const) {
        expect(await rollout(o), why).toMatchObject({ status: 400, json: { error: why } });
      }
      expect(await q`SELECT 1 FROM fleet_release_rollout`).toHaveLength(0);
    });

    it("EVERY action is audited with who and what (from -> to), and the row and the audit land together: a failing audit trigger leaves NO rollout row and NO cohort change", async () => {
      expect((await rollout({ cohort: "home_office" })).json).toMatchObject({ ok: true, from: null });
      expect((await rollout({ cohort: "pct", rollout_pct: 50 })).json).toMatchObject({ ok: true, from: "home_office" });
      expect((await cohorts(DEV, ["audiometry"])).status).toBe(200);
      const audit = await q<{ actor: string; action: string; summary: string }>`SELECT actor, action, summary FROM fleet_audit ORDER BY id`;
      expect(audit).toEqual([
        { actor: "operator:adm_fake1", action: "release_rollout", summary: "0.1.37 (stable): not offered -> home_office" },
        { actor: "operator:adm_fake1", action: "release_rollout", summary: "0.1.37 (stable): home_office -> pct 50%" },
        { actor: "operator:adm_fake1", action: "device_cohorts", summary: `device ${DEV}: [audiometry]` },
      ]);
      vi.spyOn(console, "error").mockImplementation(() => {});
      pg.exec(`
        CREATE OR REPLACE FUNCTION h8_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit is down'; END $$;
        CREATE TRIGGER h8_boom BEFORE INSERT ON fleet_audit FOR EACH ROW EXECUTE FUNCTION h8_boom();
      `);
      try {
        expect((await rollout({ cohort: "all" })).status).toBe(503);
        expect((await cohorts(DEV, ["opd1"])).status).toBe(503);
      } finally {
        pg.exec("DROP TRIGGER IF EXISTS h8_boom ON fleet_audit; DROP FUNCTION IF EXISTS h8_boom()");
      }
      expect((await q<{ cohort: string }>`SELECT cohort FROM fleet_release_rollout`)[0]!.cohort).toBe("pct");
      expect((await q<{ cohort: string }>`SELECT cohort FROM fleet_device_cohort`).map((r) => r.cohort)).toEqual(["audiometry"]);
    });

    it("device cohorts: unknown device 404, a stage name is not a membership", async () => {
      expect(await cohorts("dev_" + "9".repeat(24), ["opd1"])).toMatchObject({ status: 404 });
      expect(await cohorts(DEV, ["pct"])).toMatchObject({ status: 400, json: { error: "bad_cohort" } });
      expect(await cohorts(DEV, ["all"])).toMatchObject({ status: 400 });
      expect(await q`SELECT 1 FROM fleet_device_cohort`).toHaveLength(0);
    });

    it("REPLACE semantics keep what is kept (refute F1): re-posting the SAME list leaves it unchanged (and audited); a superset keeps the old and adds the new; a subset removes the rest; [] clears", async () => {
      const have = async () => (await q<{ cohort: string }>`SELECT cohort FROM fleet_device_cohort WHERE device_id = ${DEV} ORDER BY cohort`).map((r) => r.cohort);
      const stamp = async () => (await q<{ cohort: string; assigned_at: string }>`SELECT cohort, assigned_at FROM fleet_device_cohort WHERE device_id = ${DEV} ORDER BY cohort`).map((r) => `${r.cohort}@${r.assigned_at}`);
      expect((await cohorts(DEV, ["opd1"])).status).toBe(200);
      expect(await have()).toEqual(["opd1"]);
      const first = await stamp();
      expect((await cohorts(DEV, ["opd1"])).status).toBe(200); // the SAME list again
      expect(await have()).toEqual(["opd1"]);
      expect(await stamp()).toEqual(first); // the row was not deleted and re-created
      expect((await cohorts(DEV, ["opd1", "audiometry"])).status).toBe(200); // a superset
      expect(await have()).toEqual(["audiometry", "opd1"]);
      expect((await stamp()).find((x) => x.startsWith("opd1@"))).toBe(first[0]); // the old one is the old row
      expect((await cohorts(DEV, ["audiometry", "home_office"])).status).toBe(200); // overlap: one kept, one dropped, one added
      expect(await have()).toEqual(["audiometry", "home_office"]);
      expect((await cohorts(DEV, ["home_office"])).status).toBe(200); // a subset
      expect(await have()).toEqual(["home_office"]);
      expect((await cohorts(DEV, ["home_office", "home_office"])).status).toBe(200); // duplicates in the request
      expect(await have()).toEqual(["home_office"]);
      expect((await cohorts(DEV, [])).status).toBe(200); // empty clears
      expect(await have()).toEqual([]);
      expect((await cohorts(DEV, [])).status).toBe(200); // empty again: still fine
      // every call was audited, and the audit says what the device actually has
      const audit = await q<{ summary: string }>`SELECT summary FROM fleet_audit WHERE action = 'device_cohorts' ORDER BY id`;
      expect(audit.map((a) => a.summary)).toEqual([
        `device ${DEV}: [opd1]`, `device ${DEV}: [opd1]`, `device ${DEV}: [opd1, audiometry]`, `device ${DEV}: [audiometry, home_office]`, `device ${DEV}: [home_office]`, `device ${DEV}: [home_office]`, `device ${DEV}: []`, `device ${DEV}: []`,
      ]);
    });

    it("another device's cohorts are never touched by a change to this one", async () => {
      await cohorts(DEV2, ["audiometry"]);
      await cohorts(DEV, ["opd1"]);
      await cohorts(DEV, []);
      expect((await q<{ device_id: string; cohort: string }>`SELECT device_id, cohort FROM fleet_device_cohort`)).toEqual([{ device_id: DEV2, cohort: "audiometry" }]);
    });

    it("the admin read lists stages, cohorts and buckets, with no signature or key", async () => {
      await rollout({ cohort: "pct", rollout_pct: 10 });
      await cohorts(DEV, ["opd1"]);
      const { GET } = await import("@/app/api/admin/fleet/releases/route");
      H.cookie = await signAdminJwt({ admin_id: "adm_fake1", email: "a@example.test" });
      const j = (await (await GET()).json()) as Record<string, any>;
      expect(j.rollouts[0]).toMatchObject({ version: "0.1.37", cohort: "pct", rollout_pct: 10 });
      expect(j.devices.find((d: any) => d.device_id === DEV)).toMatchObject({ cohorts: ["opd1"], buckets: { "0.1.37": bucketOf(DEV, "0.1.37") } });
      expect(JSON.stringify(j)).not.toMatch(/signature|public_key|FLEET_COMMAND/);
      H.cookie = null;
      expect(((await GET()) as Response).status).toBe(401);
    });

    it("NOTHING else moves a rollout: only lib/fleet/release.ts writes the two tables, only the two admin routes call it, and no cron or job mentions them", () => {
      const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
      const files = [...walk("app"), ...walk("lib"), ...walk("scripts")].filter((f) => /\.(ts|tsx|mjs)$/.test(f));
      const writers = files.filter((f) => /INSERT INTO fleet_release_rollout|UPDATE fleet_release_rollout|INSERT INTO fleet_device_cohort|DELETE FROM fleet_device_cohort/.test(readFileSync(f, "utf8")));
      expect(writers).toEqual(["lib/fleet/release.ts"]);
      const callers = files.filter((f) => !f.startsWith("lib/fleet/") && /setRollout|setDeviceCohorts/.test(readFileSync(f, "utf8"))).sort();
      expect(callers).toEqual(["app/api/admin/fleet/releases/cohorts/route.ts", "app/api/admin/fleet/releases/rollout/route.ts"]);
      expect(readFileSync("vercel.json", "utf8")).not.toMatch(/rollout|releases/);
    });
  });

  describe("#49 GET /api/steward/tickets with the device credential", () => {
    const seedTicket = () => pg.exec(`INSERT INTO steward_tickets (ticket_id, machine, action, issued_at, expires_at, nonce, signature, status) VALUES ('t_h8_1', '${HOST}', 'wake', now(), now() + interval '10 minutes', 'nonce_h8_1', 'SIG', 'issued')`);

    it("a device may fetch ITS OWN machine's tickets (marked fetched); the bearer path is unchanged", async () => {
      seedTicket();
      const r = await tickets(dev("GET", "/api/steward/tickets"));
      expect(r.status).toBe(200);
      expect(r.json.tickets.map((t: any) => t.ticket.ticket_id)).toEqual(["t_h8_1"]);
      pg.exec(`UPDATE steward_tickets SET status = 'issued', fetched_at = NULL`);
      expect((await tickets(`Bearer ${DAEMON_TOKEN}`)).json.tickets).toHaveLength(1);
    });

    it("another machine is 403 machine_mismatch; garbage, a replayed token, a token for another path, a revoked device are 401; the ticket stays issued", async () => {
      seedTicket();
      expect(await tickets(dev("GET", "/api/steward/tickets"), "EHRC-H8Bs-Mac-mini")).toMatchObject({ status: 403, json: { error: "machine_mismatch" } });
      expect((await tickets("Device garbage")).status).toBe(401);
      const tok = dev("GET", "/api/steward/tickets");
      expect((await tickets(tok)).status).toBe(200);
      expect((await tickets(tok)).status).toBe(401);
      expect((await tickets(dev("GET", "/api/fleet/poll"))).status).toBe(401);
      pg.exec(`UPDATE steward_tickets SET status = 'issued'; UPDATE fleet_devices SET status = 'revoked' WHERE device_id = '${DEV}'`);
      expect((await tickets(dev("GET", "/api/steward/tickets"))).status).toBe(401);
      expect((await q<{ status: string }>`SELECT status FROM steward_tickets`)[0]!.status).toBe("issued");
    });
  });

  describe("kiosk-health: the dedupe key includes source (0161)", () => {
    it("a daemon event and a helper event that share (machine, boot_id, seq) are BOTH stored; a replay from the same source is still a duplicate", async () => {
      const d = await kh({ events: [evt(1, "daemon", { ts: "2026-10-11T10:00:00.000Z" })] }, `Bearer ${DAEMON_TOKEN}`);
      expect(d.json).toMatchObject({ accepted: 1 });
      const h = await khDevice({ events: [evt(1, "helper", { ts: "2026-10-11T10:05:00.000Z" })] }); // same machine, boot, seq; 5 minutes later so it is not a dedupe twin
      expect(h.json).toMatchObject({ accepted: 1, duplicates: 0 });
      expect((await q<{ source: string }>`SELECT source FROM kiosk_health_events ORDER BY id`).map((r) => r.source)).toEqual(["daemon", "helper"]);
      expect((await kh({ events: [evt(1, "daemon", { ts: "2026-10-11T10:00:00.000Z" })] }, `Bearer ${DAEMON_TOKEN}`)).json).toMatchObject({ accepted: 0, duplicates: 1 });
    });

    it("the constraint keeps its NAME (code that names it works before and after the migration) and now covers four columns", async () => {
      const rows = await q<{ n: number }>`SELECT array_length(conkey, 1) AS n FROM pg_constraint WHERE conname = 'kiosk_health_events_machine_boot_seq_key' AND conrelid = 'kiosk_health_events'::regclass`;
      expect(rows).toEqual([{ n: 4 }]);
    });

    it("the migration is idempotent: applying 0161 again changes nothing", () => {
      expect(() => pg.exec(readFileSync("db/migrations/0161_release_rollout_and_sources.sql", "utf8"))).not.toThrow();
      expect(() => pg.exec(readFileSync("db/migrations/0161_release_rollout_and_sources.sql", "utf8"))).not.toThrow();
    });
  });

  describe("#49 results reported against cmd_id + nonce (v2 items), via steward.result", () => {
    const delivered = async (verb = "helper_status") => {
      const r = await enqueue({ device_id: DEV, verb });
      expect(r.status).toBe(200);
      const row = (await q<{ nonce: string }>`SELECT nonce FROM fleet_commands WHERE cmd_id = ${r.json.cmd_id}`)[0]!;
      pg.exec(`UPDATE fleet_commands SET state = 'delivered', delivery_count = 1 WHERE cmd_id = '${r.json.cmd_id}'`);
      return { cmd: String(r.json.cmd_id), nonce: row.nonce };
    };
    const report = (cmd: string, nonce: string, outcome: string, extra: Record<string, unknown> = {}, seq = 1) =>
      khDevice({ events: [evt(seq, "helper", { kind: "steward.result", boot_id: `b-${cmd}-${seq}`, payload: { ticket_id: cmd, nonce, outcome, detail: "ok", ...extra }, ts: new Date(Date.now()).toISOString() })] });

    it("a delivered command's result arrives as steward.result{ticket_id: cmd_id, nonce}: one fleet result, the command done, one audit row; mapping done->ok, rejected->refused, expired->refused/expired", async () => {
      const a = await delivered();
      expect((await report(a.cmd, a.nonce, "done")).json).toMatchObject({ accepted: 1 });
      expect(await q`SELECT outcome, reason FROM fleet_results WHERE cmd_id = ${a.cmd}`).toEqual([{ outcome: "ok", reason: null }]);
      expect((await q<{ state: string }>`SELECT state FROM fleet_commands WHERE cmd_id = ${a.cmd}`)[0]!.state).toBe("done");
      expect((await q<{ summary: string }>`SELECT summary FROM fleet_audit WHERE action = 'result'`)[0]!.summary).toContain("outcome ok");
      const b = await delivered("wake");
      await report(b.cmd, b.nonce, "rejected", { detail: "clinic_hours" }, 2);
      expect(await q`SELECT outcome, reason FROM fleet_results WHERE cmd_id = ${b.cmd}`).toEqual([{ outcome: "refused", reason: "clinic_hours" }]);
      const c = await delivered("self_test");
      await report(c.cmd, c.nonce, "expired", {}, 3);
      expect(await q`SELECT outcome, reason FROM fleet_results WHERE cmd_id = ${c.cmd}`).toEqual([{ outcome: "refused", reason: "expired" }]);
    });

    it("bound to cmd_id AND nonce AND the machine AND delivery: a wrong nonce, another device's command, a never-delivered command, and a second report are all ignored", async () => {
      const a = await delivered();
      await report(a.cmd, "wrong-nonce", "done");
      expect(await q`SELECT 1 FROM fleet_results`).toHaveLength(0);
      const other = await enqueue({ device_id: DEV2, verb: "helper_status" });
      const otherNonce = (await q<{ nonce: string }>`SELECT nonce FROM fleet_commands WHERE cmd_id = ${other.json.cmd_id}`)[0]!.nonce;
      pg.exec(`UPDATE fleet_commands SET state = 'delivered', delivery_count = 1 WHERE cmd_id = '${other.json.cmd_id}'`);
      await report(String(other.json.cmd_id), otherNonce, "done", {}, 2); // posted by DEV for a command that belongs to DEV2's machine
      const queued = await enqueue({ device_id: DEV, verb: "wake" });
      const queuedNonce = (await q<{ nonce: string }>`SELECT nonce FROM fleet_commands WHERE cmd_id = ${queued.json.cmd_id}`)[0]!.nonce;
      await report(String(queued.json.cmd_id), queuedNonce, "done", {}, 3); // still queued, never delivered
      expect(await q`SELECT 1 FROM fleet_results`).toHaveLength(0);
      await report(a.cmd, a.nonce, "done", {}, 4);
      await report(a.cmd, a.nonce, "failed", {}, 5);
      expect(await q<{ outcome: string }>`SELECT outcome FROM fleet_results`).toEqual([{ outcome: "ok" }]);
    });

    it("a steward TICKET's result still works exactly as before", async () => {
      pg.exec(`INSERT INTO steward_tickets (ticket_id, machine, action, issued_at, expires_at, nonce, signature, status) VALUES ('t_h8_9', '${HOST}', 'wake', now(), now() + interval '10 minutes', 'nonce_h8_9', 'SIG', 'fetched')`);
      await khDevice({ events: [evt(1, "helper", { kind: "steward.result", boot_id: "b-t", payload: { ticket_id: "t_h8_9", nonce: "nonce_h8_9", outcome: "done" }, ts: new Date().toISOString() })] });
      expect((await q<{ status: string }>`SELECT status FROM steward_tickets WHERE ticket_id = 't_h8_9'`)[0]!.status).toBe("done");
    });
  });

  describe("#45 the helper's update progress arrives on the bench poll", () => {
    it("helper_update_step / _version / _result are stored (cleaned one by one), kept when omitted, and shown read-only", async () => {
      const { applyInstallPoll } = await import("@/lib/room-install");
      const flush = async () => { const fns = H.deferred.splice(0); for (const f of fns) await f(); };
      await applyInstallPoll({ install_id: "inst_h8_1", helper_update_step: "installing", helper_update_version: "0.1.37", helper_update_result: "pending", helper_state: "ok" } as never, {});
      await flush();
      await applyInstallPoll({ install_id: "inst_h8_1", helper_update_step: "Bad Step!", helper_update_version: "v1", helper_state: "ok" } as never, {});
      await flush();
      expect(await q`SELECT helper_update_step, helper_update_version, helper_update_result FROM room_install WHERE install_id = 'inst_h8_1'`).toEqual([{ helper_update_step: "installing", helper_update_version: "0.1.37", helper_update_result: "pending" }]);
      const view = (await fleetDevices(H.sql as never, null)).find((d) => d.device_id === DEV)!;
      expect(view.helper.health).toMatchObject({ helper_update_step: "installing", helper_update_version: "0.1.37", helper_update_result: "pending" });
    });
  });
});
