/**
 * gating/fleet-rekey — the operator-approved one-time re-key, on a REAL postgres:16 with EVERY migration (0148 fleet_*, 0167 the approval + partial unique index).
 * Routes are called as functions; only the database module is bridged to the container. All ids are fake; no private key reaches the server.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

process.env.JWT_SECRET_DOCTOR = "test-secret-for-fleet-rekey-tests-only";
process.env.MIGRATION_SECRET = "test-migration-secret-fleet-rekey"; // gitleaks:allow

const H = vi.hoisted(() => ({ sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]> }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.setConfig({ testTimeout: 90_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-fleet-rekey");

import { sha256b64url, signJws } from "@/lib/fleet/jws";
import { FLEET_AUD, FLEET_REGISTER_AUD } from "@/lib/fleet/device-auth";
import { revokeDevice } from "@/lib/fleet/commands";
import { signRoomJwt } from "@/lib/room-auth";

const q = async <T = Record<string, unknown>>(s: TemplateStringsArray, ...v: unknown[]) => (await H.sql(s, ...v)) as T[];
const now = () => Math.floor(Date.now() / 1000);

type Key = { priv: KeyObject; pub: string };
const newKey = (): Key => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { priv: privateKey, pub: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") };
};

const INSTALL = "inst_rk_1";
const MACHINE = "EHRC-HOMEs-Mac-mini";
let ROOM_JWT = "";
let K: Key;
let DEV: string;

const proof = (k: Key, over: Record<string, unknown> = {}) =>
  signJws(
    { alg: "EdDSA", typ: "JWT", kid: `install:${INSTALL}` },
    { iss: INSTALL, aud: FLEET_REGISTER_AUD, iat: now(), exp: now() + 300, jti: randomUUID(), htm: "POST", htu: "/api/fleet/register", pk: sha256b64url(Buffer.from(k.pub, "base64")), ...over },
    k.priv,
  );

async function register(k: Key, opts: { bearer?: string; proofJws?: string } = {}) {
  const { POST } = await import("@/app/api/fleet/register/route");
  const body = { install_id: INSTALL, machine: MACHINE, hw_model: "Macmini9,1", serial_hash: "a".repeat(64), helper_version: "0.1.40", key_alg: "ed25519", public_key: k.pub, proof: opts.proofJws ?? proof(k) };
  const res = await POST(new NextRequest("https://x.test/api/fleet/register", { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${opts.bearer ?? ROOM_JWT}`, "content-type": "application/json" } }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function allow(installId: string, body: unknown, auth: string | null = `Bearer ${process.env.MIGRATION_SECRET}`) {
  const { POST } = await import("@/app/api/admin/installs/[installId]/allow-rekey/route");
  const res = await POST(
    new NextRequest(`https://x.test/api/admin/installs/${installId}/allow-rekey`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json" } }),
    { params: Promise.resolve({ installId }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

async function poll(deviceId: string, k: Key) {
  const { GET } = await import("@/app/api/fleet/poll/route");
  const token = signJws({ alg: "EdDSA", typ: "JWT", kid: deviceId }, { iss: deviceId, aud: FLEET_AUD, iat: now(), exp: now() + 300, jti: randomUUID(), htm: "GET", htu: "/api/fleet/poll" }, k.priv);
  const res = await GET(new NextRequest("https://x.test/api/fleet/poll?wait=0", { headers: { authorization: `Device ${token}` } }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  H.sql = pg.sql as never;
}, 300_000);
afterAll(() => { if (HAVE) pg.stop(); });

beforeEach(async () => {
  if (!HAVE) return;
  pg.exec(`
    TRUNCATE fleet_results, fleet_commands, fleet_devices, fleet_jti, fleet_control, fleet_audit RESTART IDENTITY CASCADE;
    DELETE FROM audit_log WHERE target_id LIKE 'inst_rk_%';
    DELETE FROM room_install WHERE install_id LIKE 'inst_rk_%'; DELETE FROM room WHERE id IN ('room_rka', 'room_rkb');
    INSERT INTO room (id, slug, name, pin_hash) VALUES ('room_rka', 'rk-a', 'RK A', 'x'), ('room_rkb', 'rk-b', 'RK B', 'x');
    INSERT INTO room_install (install_id, room_id, hostname, enrolled_at, enrolled_by) VALUES ('${INSTALL}', 'room_rka', 'EHRC-HOME’s Mac mini', now(), 'test'), ('inst_rk_2', 'room_rkb', 'EHRC-OTHERs-Mac-mini', now(), 'test');
  `);
  ROOM_JWT = await signRoomJwt({ room_id: "room_rka", slug: "rk-a" });
  K = newKey();
  const r = await register(K);
  expect(r.status).toBe(201);
  DEV = String(r.json.device_id);
});

const devices = () => q<{ device_id: string; status: string; public_key: string; rotated_at: unknown }>`SELECT device_id, status, public_key, rotated_at FROM fleet_devices WHERE install_id = ${INSTALL} ORDER BY registered_at, device_id`;
const approval = async () => (await q<{ until: unknown; by: unknown }>`SELECT rekey_allowed_until AS until, rekey_allowed_by AS by FROM room_install WHERE install_id = ${INSTALL}`)[0]!;

(HAVE ? describe : describe.skip)("fleet re-key on real postgres", () => {
  describe("POST /api/admin/installs/{id}/allow-rekey", () => {
    it("REFUSED: no credential is 401 and changes nothing", async () => {
      expect((await allow(INSTALL, { reason: "x" }, null)).status).toBe(401);
      expect((await allow(INSTALL, { reason: "x" }, "Bearer wrong")).status).toBe(401);
      expect((await approval()).until).toBeNull();
    });

    it("approves for two hours, records who, and writes both audit rows", async () => {
      const r = await allow(INSTALL, { reason: "keychain unreadable after update" });
      expect(r.status).toBe(200);
      expect(r.json.rekey_allowed_by).toBe("migration_secret");
      const mins = (Date.parse(String(r.json.rekey_allowed_until)) - Date.now()) / 60_000;
      expect(mins).toBeGreaterThan(118);
      expect(mins).toBeLessThan(121);
      const a = await approval();
      expect(a.by).toBe("migration_secret");
      expect(a.until).not.toBeNull();
      const al = await q<{ actor_id: string; metadata_json: Record<string, unknown> }>`SELECT actor_id, metadata_json FROM audit_log WHERE action = 'install.allow_rekey' AND target_id = ${INSTALL}`;
      expect(al).toHaveLength(1);
      expect(al[0]!.actor_id).toBe("migration_secret");
      expect(al[0]!.metadata_json).toMatchObject({ install_id: INSTALL, room_id: "room_rka", reason: "keychain unreadable after update" });
      expect(typeof al[0]!.metadata_json.until).toBe("string");
      expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM fleet_audit WHERE action = 'fleet_rekey_allowed'`)[0]!.n).toBe(1);
    });

    it("REFUSED: bad bodies are 400; an unknown install 404; a retired install 409 RETIRED; no active device 409 NOTHING_TO_REKEY", async () => {
      expect((await allow(INSTALL, "not json")).status).toBe(400);
      expect((await allow(INSTALL, {})).status).toBe(400);
      expect((await allow(INSTALL, { reason: "" })).status).toBe(400);
      expect((await allow(INSTALL, { reason: "x".repeat(201) })).status).toBe(400);
      expect((await allow(INSTALL, { reason: "x".repeat(200) })).status).toBe(200);
      expect((await allow("inst_rk_nope", { reason: "x" })).status).toBe(404);
      expect(await allow("inst_rk_2", { reason: "x" })).toMatchObject({ status: 409, json: { error: { code: "NOTHING_TO_REKEY" } } });
      await revokeDevice(H.sql as never, DEV, "op_fake");
      expect(await allow(INSTALL, { reason: "x" })).toMatchObject({ status: 409, json: { error: { code: "NOTHING_TO_REKEY" } } });
      pg.exec(`UPDATE room_install SET retired_at = now() WHERE install_id = '${INSTALL}'`);
      expect(await allow(INSTALL, { reason: "x" })).toMatchObject({ status: 409, json: { error: { code: "RETIRED" } } });
    });
  });

  describe("POST /api/fleet/register with an approval", () => {
    it("approve, then re-key succeeds once and the second re-key is refused (one-shot)", async () => {
      expect((await allow(INSTALL, { reason: "r" })).status).toBe(200);
      const k2 = newKey();
      const r = await register(k2);
      expect(r.status).toBe(201);
      expect(r.json.device_id).toMatch(/^dev_[a-f0-9]{24}$/);
      expect(r.json.device_id).not.toBe(DEV);
      expect(await approval()).toEqual({ until: null, by: null });
      expect(await register(newKey())).toMatchObject({ status: 409, json: { error: "KEY_CONFLICT" } });
      const d = await devices();
      expect(d.filter((x) => x.status === "active").map((x) => x.device_id)).toEqual([r.json.device_id]);
    });

    it("the same new key again is an idempotent 200 on the new device", async () => {
      await allow(INSTALL, { reason: "r" });
      const k2 = newKey();
      const first = await register(k2);
      expect(await register(k2)).toMatchObject({ status: 200, json: { device_id: first.json.device_id } });
    });

    it("REFUSED: an expired approval", async () => {
      await allow(INSTALL, { reason: "r" });
      pg.exec(`UPDATE room_install SET rekey_allowed_until = now() - interval '1 minute' WHERE install_id = '${INSTALL}'`);
      expect(await register(newKey())).toMatchObject({ status: 409, json: { error: "KEY_CONFLICT" } });
      expect((await devices()).map((x) => x.device_id)).toEqual([DEV]);
    });

    it("REFUSED: no approval is KEY_CONFLICT, today's rule", async () => {
      expect(await register(newKey())).toMatchObject({ status: 409, json: { error: "KEY_CONFLICT" } });
      expect((await devices())).toHaveLength(1);
    });

    it("REFUSED: a replayed proof, even inside an open approval", async () => {
      await allow(INSTALL, { reason: "r" });
      const k2 = newKey();
      const p = proof(k2);
      expect((await register(k2, { proofJws: p })).status).toBe(201);
      await allow(INSTALL, { reason: "again" });
      expect(await register(k2, { proofJws: p })).toMatchObject({ status: 401, json: { error: "replay" } });
    });

    it("REFUSED: a room mismatch is 403 and the approval is not consumed", async () => {
      await allow(INSTALL, { reason: "r" });
      const other = await signRoomJwt({ room_id: "room_rkb", slug: "rk-b" });
      expect(await register(newKey(), { bearer: other })).toMatchObject({ status: 403, json: { error: "room_mismatch" } });
      expect((await approval()).until).not.toBeNull();
      expect((await devices()).map((x) => x.status)).toEqual(["active"]);
    });

    it("REFUSED: a retired install, even with an approval written before the retire", async () => {
      await allow(INSTALL, { reason: "r" });
      pg.exec(`UPDATE room_install SET retired_at = now() WHERE install_id = '${INSTALL}'`);
      expect(await register(newKey())).toMatchObject({ status: 409, json: { error: "RETIRED" } });
      expect((await devices()).map((x) => x.status)).toEqual(["active"]);
    });

    it("REFUSED: REVOKED stays REVOKED even with an approval written by hand; a revoked successor stays revoked", async () => {
      await revokeDevice(H.sql as never, DEV, "op_fake");
      pg.exec(`UPDATE room_install SET rekey_allowed_until = now() + interval '1 hour', rekey_allowed_by = 'hand' WHERE install_id = '${INSTALL}'`);
      expect(await register(newKey())).toMatchObject({ status: 409, json: { error: "REVOKED" } });
      expect(await register(K)).toMatchObject({ status: 409, json: { error: "REVOKED" } });
      expect((await devices()).map((x) => x.status)).toEqual(["revoked"]);
    });

    it("the old row is 'rotated' with rotated_at, not deleted; the old key can no longer poll, the new one can", async () => {
      await allow(INSTALL, { reason: "r" });
      const k2 = newKey();
      const r = await register(k2);
      const d = await devices();
      expect(d).toHaveLength(2);
      const old = d.find((x) => x.device_id === DEV)!;
      expect(old.status).toBe("rotated");
      expect(old.rotated_at).not.toBeNull();
      expect(old.public_key).toBe(K.pub);
      expect(await poll(DEV, K)).toMatchObject({ status: 401, json: { error: "revoked" } });
      expect((await poll(String(r.json.device_id), k2)).status).toBe(200);
      // a rotated-away key presented again is not an idempotent hit on the old row: the active key differs and the approval is spent
      expect(await register(K)).toMatchObject({ status: 409, json: { error: "KEY_CONFLICT" } });
    });

    it("the audit rows exist: fleet_device_rekeyed names the old and the new device id", async () => {
      await allow(INSTALL, { reason: "r" });
      const r = await register(newKey());
      const rows = await q<{ actor: string; summary: string }>`SELECT actor, summary FROM fleet_audit WHERE action = 'fleet_device_rekeyed'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe("room:room_rka");
      expect(rows[0]!.summary).toContain(DEV);
      expect(rows[0]!.summary).toContain(String(r.json.device_id));
      expect(rows[0]!.summary).toContain("migration_secret");
    });

    it("two concurrent re-keys with different keys: exactly one is 201", async () => {
      await allow(INSTALL, { reason: "r" });
      const [a, b] = await Promise.all([register(newKey()), register(newKey())]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect((await devices()).filter((x) => x.status === "active")).toHaveLength(1);
      expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM fleet_audit WHERE action = 'fleet_device_rekeyed'`)[0]!.n).toBe(1);
    });
  });

  describe("the partial unique index", () => {
    it("allows rotated/revoked history beside one active row, and refuses a second active row", async () => {
      expect(() => pg.exec(`INSERT INTO fleet_devices (device_id, install_id, room_id, machine, public_key) VALUES ('dev_${"b".repeat(24)}', '${INSTALL}', 'room_rka', 'm', 'k')`)).toThrow();
      pg.exec(`INSERT INTO fleet_devices (device_id, install_id, room_id, machine, public_key, status) VALUES ('dev_${"c".repeat(24)}', '${INSTALL}', 'room_rka', 'm', 'k', 'rotated')`);
      expect(await devices()).toHaveLength(2);
    });
  });
});
