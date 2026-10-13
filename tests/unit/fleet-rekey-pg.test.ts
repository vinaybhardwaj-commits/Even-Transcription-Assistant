/**
 * gating/fleet-rekey — the operator-approved one-time re-key, on a REAL postgres:16 with EVERY migration (0148 fleet_*, 0167 the approval table, attempts, partial unique index).
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
vi.mock("@/lib/cookie", async (orig) => ({ ...(await orig<typeof import("@/lib/cookie")>()), readAdminCookie: async () => null })); // no admin cookie outside a request; the secret path is under test
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

const fpOf = (k: Key) => sha256b64url(Buffer.from(k.pub, "base64"));
const proof = (k: Key, over: Record<string, unknown> = {}, installId = INSTALL) =>
  signJws(
    { alg: "EdDSA", typ: "JWT", kid: `install:${installId}` },
    { iss: installId, aud: FLEET_REGISTER_AUD, iat: now(), exp: now() + 300, jti: randomUUID(), htm: "POST", htu: "/api/fleet/register", pk: fpOf(k), ...over },
    k.priv,
  );

async function register(k: Key, opts: { bearer?: string; proofJws?: string; installId?: string; machine?: string } = {}) {
  const { POST } = await import("@/app/api/fleet/register/route");
  const installId = opts.installId ?? INSTALL;
  const body = { install_id: installId, machine: opts.machine ?? MACHINE, hw_model: "Macmini9,1", serial_hash: "a".repeat(64), helper_version: "0.1.40", key_alg: "ed25519", public_key: k.pub, proof: opts.proofJws ?? proof(k, {}, installId) };
  const res = await POST(new NextRequest("https://x.test/api/fleet/register", { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${opts.bearer ?? ROOM_JWT}`, "content-type": "application/json" } }));
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

const AUTH = () => `Bearer ${process.env.MIGRATION_SECRET}`;
async function adminPost(route: "allow-rekey" | "undo-rekey", installId: string, body: unknown, auth: string | null = AUTH()) {
  const mod = route === "allow-rekey" ? await import("@/app/api/admin/installs/[installId]/allow-rekey/route") : await import("@/app/api/admin/installs/[installId]/undo-rekey/route");
  const res = await mod.POST(
    new NextRequest(`https://x.test/api/admin/installs/${installId}/${route}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json" } }),
    { params: Promise.resolve({ installId }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}
const allow = (installId: string, body: unknown, auth?: string | null) => adminPost("allow-rekey", installId, body, auth);
const undo = (installId: string, body: unknown, auth?: string | null) => adminPost("undo-rekey", installId, body, auth);

/** The operator's path: the new key is refused once (which records its fingerprint), then approved. Returns the approval id. */
async function approve(k: Key, installId = INSTALL) {
  const refused = await register(k, installId === INSTALL ? {} : { installId, bearer: await signRoomJwt({ room_id: "room_rkb", slug: "rk-b" }), machine: "EHRC-OTHERs-Mac-mini" });
  expect(refused.status).toBe(409);
  const r = await allow(installId, { pk_fingerprint: fpOf(k), reason: "keychain unreadable after update" });
  expect(r.status).toBe(200);
  return String(r.json.approval_id);
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
    TRUNCATE fleet_results, fleet_commands, fleet_devices, fleet_jti, fleet_control, fleet_audit, fleet_rekey_attempt RESTART IDENTITY CASCADE;
    DELETE FROM fleet_rekey_approval;
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

type Dev = { device_id: string; status: string; public_key: string; rotated_at: unknown; retired_at: unknown; approval_id: string | null };
const devices = (installId = INSTALL) => q<Dev>`SELECT device_id, status, public_key, rotated_at, retired_at, approval_id FROM fleet_devices WHERE install_id = ${installId} ORDER BY registered_at, device_id`;
const approvals = () => q<Record<string, any>>`SELECT * FROM fleet_rekey_approval ORDER BY created_at`;
const active = async () => (await devices()).filter((x) => x.status === "active").map((x) => x.device_id);

(HAVE ? describe : describe.skip)("fleet re-key on real postgres", () => {
  describe("a refused key is recorded (fleet_rekey_attempt)", () => {
    it("every KEY_CONFLICT upserts one row per (install, fingerprint); a repeat counts, it does not add", async () => {
      const k2 = newKey();
      expect(await register(k2)).toMatchObject({ status: 409, json: { error: "KEY_CONFLICT" } });
      expect(await register(k2)).toMatchObject({ status: 409, json: { error: "KEY_CONFLICT" } });
      const rows = await q<{ install_id: string; pk_fingerprint: string; attempts: number }>`SELECT install_id, pk_fingerprint, attempts FROM fleet_rekey_attempt`;
      expect(rows).toEqual([{ install_id: INSTALL, pk_fingerprint: fpOf(k2), attempts: 2 }]);
    });

    it("the table is bounded: only the 20 newest fingerprints per install are kept", async () => {
      for (let n = 0; n < 23; n += 1) expect((await register(newKey())).status).toBe(409);
      expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM fleet_rekey_attempt WHERE install_id = ${INSTALL}`)[0]!.n).toBe(20);
    });

    it("a wrong-room refusal records nothing", async () => {
      expect((await register(newKey(), { bearer: await signRoomJwt({ room_id: "room_rkb", slug: "rk-b" }) })).status).toBe(403);
      expect((await q`SELECT 1 FROM fleet_rekey_attempt`)).toHaveLength(0);
    });
  });

  describe("POST /api/admin/installs/{id}/allow-rekey", () => {
    it("REFUSED: no or a wrong credential is 401 and changes nothing", async () => {
      const k2 = newKey();
      await register(k2);
      expect((await allow(INSTALL, { pk_fingerprint: fpOf(k2), reason: "x" }, null)).status).toBe(401);
      expect((await allow(INSTALL, { pk_fingerprint: fpOf(k2), reason: "x" }, "Bearer wrong")).status).toBe(401);
      expect(await approvals()).toHaveLength(0);
    });

    it("approves install + fingerprint for two hours, records who, and writes both audit rows", async () => {
      const k2 = newKey();
      const id = await approve(k2);
      const a = (await approvals())[0]!;
      expect(a).toMatchObject({ approval_id: id, install_id: INSTALL, pk_fingerprint: fpOf(k2), approved_by: "migration_secret", reason: "keychain unreadable after update", used_at: null, outcome: null });
      const hours = (new Date(a.expires_at).getTime() - new Date(a.created_at).getTime()) / 3_600_000;
      expect(hours).toBeCloseTo(2, 2);
      const al = await q<{ actor_id: string; metadata_json: Record<string, unknown> }>`SELECT actor_id, metadata_json FROM audit_log WHERE action = 'install.allow_rekey' AND target_id = ${INSTALL}`;
      expect(al).toHaveLength(1);
      expect(al[0]!.actor_id).toBe("migration_secret");
      expect(al[0]!.metadata_json).toMatchObject({ who: "migration_secret", install_id: INSTALL, pk_fingerprint: fpOf(k2), approval_id: id, outcome: "approved" });
      const fa = await q<{ summary: string }>`SELECT summary FROM fleet_audit WHERE action = 'fleet_rekey_allowed'`;
      expect(fa).toHaveLength(1);
      expect(fa[0]!.summary).toContain(fpOf(k2));
    });

    it("REFUSED: a fingerprint never seen in a refused attempt for this install is 409 UNKNOWN_FINGERPRINT", async () => {
      expect(await allow(INSTALL, { pk_fingerprint: fpOf(newKey()), reason: "x" })).toMatchObject({ status: 409, json: { error: { code: "UNKNOWN_FINGERPRINT" } } });
      expect(await approvals()).toHaveLength(0);
    });

    it("REFUSED: bad bodies 400; unknown install 404; no active device 409 NOTHING_TO_REKEY; revoked 409; retired 409 RETIRED", async () => {
      const k2 = newKey();
      await register(k2);
      const fp = fpOf(k2);
      expect((await allow(INSTALL, "not json")).status).toBe(400);
      expect((await allow(INSTALL, { reason: "x" })).status).toBe(400);
      expect((await allow(INSTALL, { pk_fingerprint: "short", reason: "x" })).status).toBe(400);
      expect((await allow(INSTALL, { pk_fingerprint: fp, reason: "" })).status).toBe(400);
      expect((await allow(INSTALL, { pk_fingerprint: fp, reason: "x".repeat(201) })).status).toBe(400);
      expect((await allow("inst_rk_nope", { pk_fingerprint: fp, reason: "x" })).status).toBe(404);
      expect(await allow("inst_rk_2", { pk_fingerprint: fp, reason: "x" })).toMatchObject({ status: 409, json: { error: { code: "NOTHING_TO_REKEY" } } });
      await revokeDevice(H.sql as never, DEV, "op_fake");
      expect(await allow(INSTALL, { pk_fingerprint: fp, reason: "x" })).toMatchObject({ status: 409, json: { error: { code: "NOTHING_TO_REKEY" } } });
      pg.exec(`UPDATE room_install SET retired_at = now() WHERE install_id = '${INSTALL}'`);
      expect(await allow(INSTALL, { pk_fingerprint: fp, reason: "x" })).toMatchObject({ status: 409, json: { error: { code: "RETIRED" } } });
    });
  });

  describe("POST /api/fleet/register: no path re-keys from a room JWT alone (B3)", () => {
    it("a room JWT plus a valid proof with NO approval is 409 KEY_CONFLICT and changes nothing", async () => {
      expect(await register(newKey())).toMatchObject({ status: 409, json: { error: "KEY_CONFLICT" } });
      expect((await devices()).map((x) => x.device_id)).toEqual([DEV]);
    });

    it("an approval for a DIFFERENT fingerprint is 409 and is not consumed", async () => {
      const approved = newKey();
      await approve(approved);
      expect(await register(newKey())).toMatchObject({ status: 409, json: { error: "KEY_CONFLICT" } });
      expect((await devices()).map((x) => x.device_id)).toEqual([DEV]);
      expect((await approvals())[0]!.used_at).toBeNull();
    });

    it("an approval for a DIFFERENT install is 409: the same fingerprint approved on another install does not open this one", async () => {
      // inst_rk_2 gets a device and its own approval for the very key that is then presented to INSTALL
      const rb = await signRoomJwt({ room_id: "room_rkb", slug: "rk-b" });
      const other = { installId: "inst_rk_2", bearer: rb, machine: "EHRC-OTHERs-Mac-mini" };
      expect((await register(newKey(), other)).status).toBe(201);
      const k2 = newKey();
      await approve(k2, "inst_rk_2");
      expect(await register(k2)).toMatchObject({ status: 409, json: { error: "KEY_CONFLICT" } });
      expect((await devices()).map((x) => x.device_id)).toEqual([DEV]);
      expect((await approvals())[0]!.used_at).toBeNull();
    });
  });

  describe("POST /api/fleet/register with a matching approval", () => {
    it("approve, then re-key succeeds once; a second re-key with another key is refused; the approval is used with outcome 'rekeyed'", async () => {
      const k2 = newKey();
      const id = await approve(k2);
      const r = await register(k2);
      expect(r.status).toBe(201);
      expect(r.json.device_id).toMatch(/^dev_[a-f0-9]{24}$/);
      expect(r.json.device_id).not.toBe(DEV);
      const a = (await approvals())[0]!;
      expect(a).toMatchObject({ approval_id: id, outcome: "rekeyed", old_device_id: DEV, new_device_id: r.json.device_id });
      expect(a.used_at).not.toBeNull();
      const k3 = newKey();
      await register(k3);
      expect(await allow(INSTALL, { pk_fingerprint: fpOf(k3), reason: "x" })).toMatchObject({ status: 200 }); // a NEW approval is a new decision
      expect(await register(newKey())).toMatchObject({ status: 409, json: { error: "KEY_CONFLICT" } });
      expect(await active()).toEqual([r.json.device_id]);
    });

    it("the same new key again is an idempotent 200 on the new device", async () => {
      const k2 = newKey();
      await approve(k2);
      const first = await register(k2);
      expect(await register(k2)).toMatchObject({ status: 200, json: { device_id: first.json.device_id } });
    });

    it("REFUSED: an expired approval", async () => {
      const k2 = newKey();
      await approve(k2);
      pg.exec(`UPDATE fleet_rekey_approval SET created_at = now() - interval '3 hours', expires_at = now() - interval '1 hour'`);
      expect(await register(k2)).toMatchObject({ status: 409, json: { error: "KEY_CONFLICT" } });
      expect((await devices()).map((x) => x.device_id)).toEqual([DEV]);
    });

    it("REFUSED: a replayed proof, even with an open approval", async () => {
      const k2 = newKey();
      await approve(k2);
      const p = proof(k2);
      expect((await register(k2, { proofJws: p })).status).toBe(201);
      expect(await register(k2, { proofJws: p })).toMatchObject({ status: 401, json: { error: "replay" } });
    });

    it("REFUSED: a room mismatch is 403 and the approval is not consumed", async () => {
      const k2 = newKey();
      await approve(k2);
      expect(await register(k2, { bearer: await signRoomJwt({ room_id: "room_rkb", slug: "rk-b" }) })).toMatchObject({ status: 403, json: { error: "room_mismatch" } });
      expect((await approvals())[0]!.used_at).toBeNull();
      expect(await active()).toEqual([DEV]);
    });

    it("REFUSED: a retired install, even with an approval written before the retire", async () => {
      const k2 = newKey();
      await approve(k2);
      pg.exec(`UPDATE room_install SET retired_at = now() WHERE install_id = '${INSTALL}'`);
      expect(await register(k2)).toMatchObject({ status: 409, json: { error: "RETIRED" } });
      expect(await active()).toEqual([DEV]);
      expect((await approvals())[0]!.used_at).toBeNull();
    });

    it("REFUSED: REVOKED stays REVOKED even with an approval written by hand", async () => {
      const k2 = newKey();
      await approve(k2);
      await revokeDevice(H.sql as never, DEV, "op_fake");
      expect(await register(k2)).toMatchObject({ status: 409, json: { error: "REVOKED" } });
      expect(await register(K)).toMatchObject({ status: 409, json: { error: "REVOKED" } });
      expect((await devices()).map((x) => x.status)).toEqual(["revoked"]);
      expect((await approvals())[0]!.used_at).toBeNull();
    });

    it("the old row is 'rotated' with rotated_at, install_id, device_id and approval_id: not deleted; the old key can no longer poll, the new one can", async () => {
      const k2 = newKey();
      const id = await approve(k2);
      const r = await register(k2);
      const d = await devices();
      expect(d).toHaveLength(2);
      const old = d.find((x) => x.device_id === DEV)!;
      expect(old).toMatchObject({ status: "rotated", public_key: K.pub, approval_id: id });
      expect(old.rotated_at).not.toBeNull();
      expect(await poll(DEV, K)).toMatchObject({ status: 401, json: { error: "revoked" } });
      expect((await poll(String(r.json.device_id), k2)).status).toBe(200);
      expect(await register(K)).toMatchObject({ status: 409, json: { error: "KEY_CONFLICT" } });
    });

    it("the audit rows exist: who, install, fingerprint, outcome, old and new device id", async () => {
      const k2 = newKey();
      const id = await approve(k2);
      const r = await register(k2);
      const fa = await q<{ actor: string; summary: string }>`SELECT actor, summary FROM fleet_audit WHERE action = 'fleet_device_rekeyed'`;
      expect(fa).toHaveLength(1);
      expect(fa[0]!.actor).toBe("room:room_rka");
      for (const part of [DEV, String(r.json.device_id), fpOf(k2), "outcome rekeyed", id, "migration_secret"]) expect(fa[0]!.summary).toContain(part);
      const al = await q<{ metadata_json: Record<string, unknown> }>`SELECT metadata_json FROM audit_log WHERE action = 'install.rekeyed' AND target_id = ${INSTALL}`;
      expect(al).toHaveLength(1);
      expect(al[0]!.metadata_json).toMatchObject({ install_id: INSTALL, pk_fingerprint: fpOf(k2), approval_id: id, old_device_id: DEV, new_device_id: r.json.device_id, outcome: "rekeyed", approved_by: "migration_secret" });
    });

    it("two concurrent re-keys with the approved key: exactly one is 201, one device is active", async () => {
      const k2 = newKey();
      await approve(k2);
      const [a, b] = await Promise.all([register(k2), register(k2)]);
      expect([a.status, b.status].sort()).toEqual([200, 201]); // the loser is judged against the winner: same key, so an idempotent 200
      expect(a.json.device_id).toBe(b.json.device_id);
      expect(await active()).toHaveLength(1);
      expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM fleet_audit WHERE action = 'fleet_device_rekeyed'`)[0]!.n).toBe(1);
    });
  });

  describe("B3.10: the approval is consumed only by the statement that rotated and inserted", () => {
    it("two DIFFERENT approved keys register concurrently: exactly one 201, one active + one rotated row, the loser's approval stays UNUSED, no phantom device, one audit row each", async () => {
      const k2 = newKey();
      const k3 = newKey();
      await approve(k2);
      await approve(k3);
      const [a, b] = await Promise.all([register(k2), register(k3)]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const [win, lose, loseKey] = a.status === 201 ? [a, b, k3] : [b, a, k2];
      expect(lose.json.error).toBe("KEY_CONFLICT");
      const d = await devices();
      expect(d.map((x) => x.status).sort()).toEqual(["active", "rotated"]);
      expect(d.find((x) => x.status === "active")!.device_id).toBe(win.json.device_id);
      const ap = await approvals();
      const loser = ap.find((x) => x.pk_fingerprint === fpOf(loseKey))!;
      expect(loser).toMatchObject({ used_at: null, outcome: null, old_device_id: null, new_device_id: null });
      const used = ap.filter((x) => x.used_at !== null);
      expect(used).toHaveLength(1);
      expect(used[0]).toMatchObject({ outcome: "rekeyed", old_device_id: DEV, new_device_id: win.json.device_id });
      for (const x of ap.filter((y) => y.new_device_id)) expect(d.map((y) => y.device_id)).toContain(x.new_device_id); // no phantom device
      expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM fleet_audit WHERE action = 'fleet_device_rekeyed'`)[0]!.n).toBe(1);
      expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'install.rekeyed' AND target_id = ${INSTALL}`)[0]!.n).toBe(1);
    });

    it("an admin revoke landing between the lookup and the re-key leaves the approval unused", async () => {
      const k2 = newKey();
      await approve(k2);
      const real = H.sql;
      let fired = 0;
      H.sql = (async (s: TemplateStringsArray, ...v: unknown[]) => {
        if (fired === 0 && s.join("?").includes("'fleet_device_rekeyed'")) {
          fired += 1;
          pg.exec(`UPDATE fleet_devices SET status = 'revoked', revoked_at = now() WHERE device_id = '${DEV}'`); // lands after register read the active row, before the re-key statement
        }
        return real(s, ...v);
      }) as never;
      let r;
      try {
        r = await register(k2);
      } finally {
        H.sql = real;
      }
      expect(fired).toBe(1);
      expect(r.status).toBe(409);
      expect(r.json.error).toBe("REVOKED");
      expect((await approvals())[0]).toMatchObject({ used_at: null, outcome: null, new_device_id: null });
      expect((await devices()).map((x) => x.status)).toEqual(["revoked"]);
      expect((await q`SELECT 1 FROM fleet_audit WHERE action = 'fleet_device_rekeyed'`)).toHaveLength(0);
    });
  });

  describe("POST /api/admin/installs/{id}/undo-rekey", () => {
    it("restores the old row to active, retires the new row, marks the approval undone, audits it; the old key polls again and the new one is refused", async () => {
      const k2 = newKey();
      const id = await approve(k2);
      const r = await register(k2);
      const u = await undo(INSTALL, { approval_id: id, reason: "new key was a mistake" });
      expect(u).toMatchObject({ status: 200, json: { approval_id: id, restored_device_id: DEV, retired_device_id: r.json.device_id } });
      const d = await devices();
      expect(d.find((x) => x.device_id === DEV)!.status).toBe("active");
      const nw = d.find((x) => x.device_id === r.json.device_id)!;
      expect(nw.status).toBe("retired");
      expect(nw.retired_at).not.toBeNull();
      expect(d).toHaveLength(2);
      expect((await approvals())[0]).toMatchObject({ outcome: "undone", undone_by: "migration_secret" });
      expect((await poll(DEV, K)).status).toBe(200);
      expect(await poll(String(r.json.device_id), k2)).toMatchObject({ status: 401, json: { error: "revoked" } });
      const al = await q<{ metadata_json: Record<string, unknown> }>`SELECT metadata_json FROM audit_log WHERE action = 'install.undo_rekey' AND target_id = ${INSTALL}`;
      expect(al).toHaveLength(1);
      expect(al[0]!.metadata_json).toMatchObject({ who: "migration_secret", install_id: INSTALL, pk_fingerprint: fpOf(k2), approval_id: id, outcome: "undone", reason: "new key was a mistake" });
      expect((await q<{ summary: string }>`SELECT summary FROM fleet_audit WHERE action = 'fleet_rekey_undone'`)[0]!.summary).toContain(fpOf(k2));
    });

    it("an approval is ONE-SHOT: after a re-key and its undo the same key is refused again", async () => {
      const k2 = newKey();
      const id = await approve(k2);
      expect((await register(k2)).status).toBe(201);
      expect((await undo(INSTALL, { approval_id: id, reason: "r" })).status).toBe(200);
      expect(await register(k2)).toMatchObject({ status: 409, json: { error: "KEY_CONFLICT" } });
      expect(await active()).toEqual([DEV]);
    });

    it("REFUSED: no credential 401; bad body 400; unknown approval or another install's approval 404; a second undo 409; an approval never used 409", async () => {
      const k2 = newKey();
      const id = await approve(k2);
      expect((await undo(INSTALL, { approval_id: id, reason: "r" }, null)).status).toBe(401);
      expect((await undo(INSTALL, { approval_id: "nope", reason: "r" })).status).toBe(400);
      expect((await undo(INSTALL, { approval_id: id })).status).toBe(400);
      expect((await undo(INSTALL, { approval_id: `rka_${"0".repeat(24)}`, reason: "r" })).status).toBe(404);
      expect((await undo("inst_rk_2", { approval_id: id, reason: "r" })).status).toBe(404);
      expect(await undo(INSTALL, { approval_id: id, reason: "r" })).toMatchObject({ status: 409, json: { error: { code: "NOT_UNDOABLE" } } }); // approved, never used
      await register(k2);
      expect((await undo(INSTALL, { approval_id: id, reason: "r" })).status).toBe(200);
      expect(await undo(INSTALL, { approval_id: id, reason: "r" })).toMatchObject({ status: 409, json: { error: { code: "NOT_UNDOABLE" } } });
    });

    it("REFUSED: when the new device has since been revoked, or the install retired, nothing changes", async () => {
      const k2 = newKey();
      const id = await approve(k2);
      const r = await register(k2);
      await revokeDevice(H.sql as never, String(r.json.device_id), "op_fake");
      expect(await undo(INSTALL, { approval_id: id, reason: "r" })).toMatchObject({ status: 409, json: { error: { code: "NOT_UNDOABLE" } } });
      expect((await devices()).map((x) => x.status).sort()).toEqual(["revoked", "rotated"]);
      pg.exec(`UPDATE room_install SET retired_at = now() WHERE install_id = '${INSTALL}'`);
      expect(await undo(INSTALL, { approval_id: id, reason: "r" })).toMatchObject({ status: 409, json: { error: { code: "RETIRED" } } });
    });
  });

  describe("the partial unique index", () => {
    it("allows rotated/retired/revoked history beside one active row, and refuses a second active row", async () => {
      expect(() => pg.exec(`INSERT INTO fleet_devices (device_id, install_id, room_id, machine, public_key) VALUES ('dev_${"b".repeat(24)}', '${INSTALL}', 'room_rka', 'm', 'k')`)).toThrow();
      for (const [c, st] of [["c", "rotated"], ["d", "retired"], ["e", "revoked"]] as const) {
        pg.exec(`INSERT INTO fleet_devices (device_id, install_id, room_id, machine, public_key, status) VALUES ('dev_${c.repeat(24)}', '${INSTALL}', 'room_rka', 'm', 'k', '${st}')`);
      }
      expect(await devices()).toHaveLength(4);
    });
  });
});
