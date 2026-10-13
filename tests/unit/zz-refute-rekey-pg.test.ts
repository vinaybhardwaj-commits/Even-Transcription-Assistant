/**
 * REFUTER PROBE (not for merge). Independent B3/B2/A1/A2/0167 probes on real postgres:16 with every migration.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

process.env.JWT_SECRET_DOCTOR = "test-secret-for-refute-rekey-only";
process.env.MIGRATION_SECRET = "test-migration-secret-refute-rekey"; // gitleaks:allow

const H = vi.hoisted(() => ({ sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]> }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.mock("@/lib/cookie", async (orig) => ({ ...(await orig<typeof import("@/lib/cookie")>()), readAdminCookie: async () => null }));
vi.setConfig({ testTimeout: 90_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-refute-rekey");

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
const A = "inst_rf_a";
const B = "inst_rf_b";
const MA = "EHRC-RFA-Mac-mini";
const MB = "EHRC-RFB-Mac-mini";
let JA = "";
let JB = "";
let K: Key;
let DEV = "";
const fpOf = (k: Key) => sha256b64url(Buffer.from(k.pub, "base64"));
const proof = (signer: Key, pkOf: Key, installId: string) =>
  signJws(
    { alg: "EdDSA", typ: "JWT", kid: `install:${installId}` },
    { iss: installId, aud: FLEET_REGISTER_AUD, iat: now(), exp: now() + 300, jti: randomUUID(), htm: "POST", htu: "/api/fleet/register", pk: fpOf(pkOf) },
    signer.priv,
  );
async function register(k: Key, o: { install?: string; bearer?: string; machine?: string; proofJws?: string } = {}) {
  const { POST } = await import("@/app/api/fleet/register/route");
  const install = o.install ?? A;
  const body = { install_id: install, machine: o.machine ?? (install === A ? MA : MB), hw_model: "Macmini9,1", serial_hash: "b".repeat(64), helper_version: "0.1.40", key_alg: "ed25519", public_key: k.pub, proof: o.proofJws ?? proof(k, k, install) };
  const res = await POST(new NextRequest("https://x.test/api/fleet/register", { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${o.bearer ?? (install === A ? JA : JB)}`, "content-type": "application/json" } }));
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}
async function admin(route: "allow-rekey" | "undo-rekey", install: string, body: unknown) {
  const mod = route === "allow-rekey" ? await import("@/app/api/admin/installs/[installId]/allow-rekey/route") : await import("@/app/api/admin/installs/[installId]/undo-rekey/route");
  const res = await mod.POST(
    new NextRequest(`https://x.test/api/admin/installs/${install}/${route}`, { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${process.env.MIGRATION_SECRET}`, "content-type": "application/json" } }),
    { params: Promise.resolve({ installId: install }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}
async function poll(deviceId: string, k: Key) {
  const { GET } = await import("@/app/api/fleet/poll/route");
  const token = signJws({ alg: "EdDSA", typ: "JWT", kid: deviceId }, { iss: deviceId, aud: FLEET_AUD, iat: now(), exp: now() + 300, jti: randomUUID(), htm: "GET", htu: "/api/fleet/poll" }, k.priv);
  const res = await GET(new NextRequest("https://x.test/api/fleet/poll?wait=0", { headers: { authorization: `Device ${token}` } }));
  return res.status;
}
const devs = (install = A) => q<{ device_id: string; status: string; public_key: string }>`SELECT device_id, status, public_key FROM fleet_devices WHERE install_id = ${install} ORDER BY registered_at, device_id`;
const openApprovals = () => q<{ approval_id: string; used_at: unknown }>`SELECT approval_id, used_at FROM fleet_rekey_approval WHERE used_at IS NULL`;
/** Refuse k once on install (records the attempt), then approve. */
async function approveFor(k: Key, install = A) {
  expect((await register(k, { install })).status).toBe(409);
  const r = await admin("allow-rekey", install, { pk_fingerprint: fpOf(k), reason: "refute probe" });
  expect(r.status).toBe(200);
  return String(r.json.approval_id);
}
const catalogue = () =>
  q<{ kind: string; name: string; def: string }>`
    SELECT 'con' AS kind, conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'fleet_devices'::regclass
    UNION ALL SELECT 'idx', indexname, indexdef FROM pg_indexes WHERE tablename IN ('fleet_devices', 'fleet_rekey_approval', 'fleet_rekey_attempt')
    ORDER BY 1, 2`;

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
    DELETE FROM room_install WHERE install_id LIKE 'inst_rf_%'; DELETE FROM room WHERE id IN ('room_rfa', 'room_rfb');
    INSERT INTO room (id, slug, name, pin_hash) VALUES ('room_rfa', 'rf-a', 'RF A', 'x'), ('room_rfb', 'rf-b', 'RF B', 'x');
    INSERT INTO room_install (install_id, room_id, hostname, enrolled_at, enrolled_by) VALUES ('${A}', 'room_rfa', '${MA}', now(), 'test'), ('${B}', 'room_rfb', '${MB}', now(), 'test');
  `);
  JA = await signRoomJwt({ room_id: "room_rfa", slug: "rf-a" });
  JB = await signRoomJwt({ room_id: "room_rfb", slug: "rf-b" });
  K = newKey();
  const r = await register(K);
  expect(r.status).toBe(201);
  DEV = String(r.json.device_id);
});

(HAVE ? describe : describe.skip)("REFUTE B3: nothing re-keys without a matching operator approval", () => {
  it("B3.1 room JWT + valid proof, no approval: 409 KEY_CONFLICT, device unchanged", async () => {
    const k2 = newKey();
    expect(await register(k2)).toMatchObject({ status: 409, json: { error: "KEY_CONFLICT" } });
    expect(await devs()).toEqual([{ device_id: DEV, status: "active", public_key: K.pub }]);
  });
  it("B3.2 approval for another fingerprint: 409, that approval stays open", async () => {
    const kApproved = newKey();
    await approveFor(kApproved);
    const kOther = newKey();
    expect((await register(kOther)).status).toBe(409);
    expect(await openApprovals()).toHaveLength(1);
    expect((await devs()).map((d) => d.status)).toEqual(["active"]);
  });
  it("B3.3 approval for another install (same fingerprint): 409 on this install", async () => {
    const rb = await register(newKey(), { install: B });
    expect(rb.status).toBe(201);
    const k2 = newKey();
    await approveFor(k2, B); // B now has an approval for k2's fingerprint
    expect((await register(k2, { install: A })).status).toBe(409);
    expect(await devs(A)).toEqual([{ device_id: DEV, status: "active", public_key: K.pub }]);
    expect(await openApprovals()).toHaveLength(1);
  });
  it("B3.4 expired approval: 409", async () => {
    const k2 = newKey();
    const id = await approveFor(k2);
    pg.exec(`UPDATE fleet_rekey_approval SET created_at = now() - interval '3 hours', expires_at = now() - interval '1 second' WHERE approval_id = '${id}'`);
    expect((await register(k2)).status).toBe(409);
    expect((await devs()).map((d) => d.device_id)).toEqual([DEV]);
  });
  it("B3.5 used approval (marked used by hand): 409", async () => {
    const k2 = newKey();
    const id = await approveFor(k2);
    pg.exec(`UPDATE fleet_rekey_approval SET used_at = now(), outcome = 'undone' WHERE approval_id = '${id}'`);
    expect((await register(k2)).status).toBe(409);
  });
  it("B3.6 replayed proof: the Mac's own REFUSED proof, re-sent after the approval, is 401 replay", async () => {
    const k2 = newKey();
    const p = proof(k2, k2, A);
    expect((await register(k2, { proofJws: p })).status).toBe(409);
    expect((await admin("allow-rekey", A, { pk_fingerprint: fpOf(k2), reason: "probe" })).status).toBe(200);
    expect(await register(k2, { proofJws: p })).toMatchObject({ status: 401, json: { error: "replay" } });
    expect(await openApprovals()).toHaveLength(1);
  });
  it("B3.6b attacker with the room JWT and an approval for the Mac's fingerprint but NOT its private key: refused, approval unused", async () => {
    const mac = newKey();
    await approveFor(mac);
    const attacker = newKey();
    // presents the approved public key, signs the proof with its own key
    const r1 = await register(mac, { proofJws: proof(attacker, mac, A) });
    expect(r1.status).toBe(401);
    // presents its own key with a proof claiming the approved pk
    const r2 = await register(attacker, { proofJws: proof(attacker, mac, A) });
    expect(r2.status).toBe(401);
    expect(await openApprovals()).toHaveLength(1);
    expect((await devs()).map((d) => d.device_id)).toEqual([DEV]);
  });
  it("B3.7 room mismatch with an open approval: 403, approval unused", async () => {
    const k2 = newKey();
    await approveFor(k2);
    expect((await register(k2, { bearer: JB })).status).toBe(403);
    expect(await openApprovals()).toHaveLength(1);
  });
  it("B3.8 revoked device + approval written by hand: 409 REVOKED, approval unused", async () => {
    const k2 = newKey();
    await approveFor(k2);
    await revokeDevice(H.sql as never, DEV, "op_refute");
    expect(await register(k2)).toMatchObject({ status: 409, json: { error: "REVOKED" } });
    expect(await openApprovals()).toHaveLength(1);
  });
  it("B3.9 retired install with an open approval: 409 RETIRED", async () => {
    const k2 = newKey();
    await approveFor(k2);
    pg.exec(`UPDATE room_install SET retired_at = now() WHERE install_id = '${A}'`);
    expect(await register(k2)).toMatchObject({ status: 409, json: { error: "RETIRED" } });
    expect(await openApprovals()).toHaveLength(1);
  });
  it("B3.10 two different keys, BOTH approved, racing: exactly one wins, the loser is 409 and its approval stays open", async () => {
    const k2 = newKey();
    const k3 = newKey();
    await approveFor(k2);
    await approveFor(k3);
    const [r2, r3] = await Promise.all([register(k2), register(k3)]);
    const apr = await q<Record<string, unknown>>`
      SELECT a.outcome, (a.used_at IS NOT NULL) AS used, a.new_device_id,
             EXISTS (SELECT 1 FROM fleet_devices d WHERE d.device_id = a.new_device_id) AS new_device_exists,
             (SELECT count(*)::int FROM audit_log l WHERE l.action = 'install.rekeyed' AND l.metadata_json->>'approval_id' = a.approval_id) AS audit_rows
        FROM fleet_rekey_approval a ORDER BY a.created_at`;
    console.log("REFUTE-B3.10", JSON.stringify({ statuses: [r2.status, r3.status], approvals: apr.map((x) => ({ ...x, new_device_id: String(x.new_device_id ?? "").slice(0, 8) })) }));
    const statuses = [r2.status, r3.status].sort();
    expect(statuses).toEqual([201, 409]);
    const d = await devs();
    expect(d.filter((x) => x.status === "active")).toHaveLength(1);
    expect(d.filter((x) => x.status === "rotated")).toHaveLength(1);
    expect(await openApprovals()).toHaveLength(1);
  });
  it("B3.11 approve requires a refused attempt: a fingerprint never refused is 409 UNKNOWN_FINGERPRINT", async () => {
    const r = await admin("allow-rekey", A, { pk_fingerprint: fpOf(newKey()), reason: "probe" });
    expect(r).toMatchObject({ status: 409, json: { error: { code: "UNKNOWN_FINGERPRINT" } } });
  });
});

(HAVE ? describe : describe.skip)("REFUTE B2/A1/A2", () => {
  it("B2: expires 2 h after creation; used_at, outcome and the device swap land in ONE statement (same now())", async () => {
    const k2 = newKey();
    const id = await approveFor(k2);
    const w = await q<{ secs: number }>`SELECT extract(epoch FROM expires_at - created_at)::int AS secs FROM fleet_rekey_approval WHERE approval_id = ${id}`;
    expect(w[0]!.secs).toBe(7200);
    const r = await register(k2);
    expect(r.status).toBe(201);
    const same = await q<{ ok: boolean; outcome: string }>`
      SELECT (a.used_at = d.rotated_at) AS ok, a.outcome FROM fleet_rekey_approval a JOIN fleet_devices d ON d.approval_id = a.approval_id WHERE a.approval_id = ${id}`;
    expect(same).toEqual([{ ok: true, outcome: "rekeyed" }]);
  });
  it("A1: rotated row keeps install_id, device_id, rotated_at, approval_id; old key refused at poll; new key polls", async () => {
    const k2 = newKey();
    const id = await approveFor(k2);
    const r = await register(k2);
    const newDev = String(r.json.device_id);
    const old = await q<Record<string, unknown>>`SELECT install_id, status, approval_id, (rotated_at IS NOT NULL) AS has_rot FROM fleet_devices WHERE device_id = ${DEV}`;
    expect(old).toEqual([{ install_id: A, status: "rotated", approval_id: id, has_rot: true }]);
    expect(await poll(DEV, K)).not.toBe(200);
    expect(await poll(newDev, k2)).toBe(200);
  });
  it("A2: undo restores old, retires new in one statement (same now()), audits; old key polls, new key refused", async () => {
    const k2 = newKey();
    const id = await approveFor(k2);
    const newDev = String((await register(k2)).json.device_id);
    const u = await admin("undo-rekey", A, { approval_id: id, reason: "probe undo" });
    expect(u.status).toBe(200);
    const t = await q<{ ok: boolean }>`SELECT (a.undone_at = n.retired_at) AS ok FROM fleet_rekey_approval a, fleet_devices n WHERE a.approval_id = ${id} AND n.device_id = ${newDev}`;
    expect(t).toEqual([{ ok: true }]);
    expect(await poll(DEV, K)).toBe(200);
    expect(await poll(newDev, k2)).not.toBe(200);
    const aud = await q<{ n: number }>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'install.undo_rekey' AND target_id = ${A}`;
    expect(aud[0]!.n).toBe(1);
    // the Mac that already holds k2 is now locked out (flag 5.5): its register is a KEY_CONFLICT again
    expect((await register(k2)).status).toBe(409);
  });
});

(HAVE ? describe : describe.skip)("REFUTE 0167", () => {
  it("runs a second time with no error and leaves the catalogue identical", async () => {
    const before = await catalogue();
    pg.exec(readFileSync("db/migrations/0167_fleet_rekey_approval.sql", "utf8"));
    const after = await catalogue();
    expect(after).toEqual(before);
    console.log("REFUTE-0167 catalogue", JSON.stringify(after));
  });
});
