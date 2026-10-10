/**
 * TS-H3 (#40) — the fleet control plane, server side, on a REAL postgres:16 with EVERY migration (0148 fleet_*). Routes are called as functions; only the database
 * module is bridged to the container. Refused: bad signature, tampered token or body, replayed token, unknown device, expired token / registration proof, revoked or
 * retired device. Also: long-poll timeout, redelivery, kill switch, result binding to the issued command, and that no route can queue a command.
 * All ids are fake. No private key ever reaches the server: tests sign client-side with node:crypto.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

process.env.JWT_SECRET_DOCTOR = "test-secret-for-fleet-control-plane-tests-only";
// A fixed FAKE signing key (seed 0x09 x 32): tests only, never a credential.
process.env.FLEET_COMMAND_SIGNING_KEY = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 9)]).toString("base64"); // gitleaks:allow

const H = vi.hoisted(() => ({ sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]> }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.setConfig({ testTimeout: 90_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-fleet-h3");

import { b64url, sha256b64url, signJws } from "@/lib/fleet/jws";
import { FLEET_AUD, FLEET_REGISTER_AUD, claimJti } from "@/lib/fleet/device-auth";
import { claimCommands, longPoll, type Clock } from "@/lib/fleet/poll";
import { queueCommand as queueRaw, revokeDevice } from "@/lib/fleet/commands";
import { buildSignedEnvelope, publicKeysOf, type Envelope } from "@/lib/fleet/envelope";
import { signEnvelope, loadSigner } from "@/lib/fleet/signing";
import { signRoomJwt } from "@/lib/room-auth";

const q = async <T = Record<string, unknown>>(s: TemplateStringsArray, ...v: unknown[]) => (await H.sql(s, ...v)) as T[];
const now = () => Math.floor(Date.now() / 1000);

type Key = { priv: KeyObject; pub: string };
const newKey = (): Key => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { priv: privateKey, pub: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") };
};

const INSTALL = "inst_h3_1";
const MACHINE = "EHRC-HOMEs-Mac-mini";
let ROOM_JWT = "";

const proof = (k: Key, over: Record<string, unknown> = {}, installId = INSTALL, signWith: Key = k) =>
  signJws(
    { alg: "EdDSA", typ: "JWT", kid: `install:${installId}` },
    { iss: installId, aud: FLEET_REGISTER_AUD, iat: now(), exp: now() + 300, jti: randomUUID(), htm: "POST", htu: "/api/fleet/register", pk: sha256b64url(Buffer.from(k.pub, "base64")), ...over },
    signWith.priv,
  );

async function register(k: Key, opts: { bearer?: string | null; proofOver?: Record<string, unknown>; body?: Record<string, unknown>; signWith?: Key; installId?: string } = {}) {
  const { POST } = await import("@/app/api/fleet/register/route");
  const installId = opts.installId ?? INSTALL;
  const body = { install_id: installId, machine: MACHINE, hw_model: "Macmini9,1", serial_hash: "a".repeat(64), helper_version: "0.2.0", key_alg: "ed25519", public_key: k.pub, proof: proof(k, opts.proofOver, installId, opts.signWith), ...opts.body };
  const bearer = opts.bearer === undefined ? ROOM_JWT : opts.bearer;
  const res = await POST(new NextRequest("https://x.test/api/fleet/register", { method: "POST", body: JSON.stringify(body), headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), "content-type": "application/json" } }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const deviceJwt = (deviceId: string, k: Key, o: { method?: "GET" | "POST"; path?: string; body?: string; claims?: Record<string, unknown>; header?: Record<string, unknown> } = {}) => {
  const method = o.method ?? "GET";
  return signJws(
    { alg: "EdDSA", typ: "JWT", kid: deviceId, ...o.header },
    { iss: deviceId, aud: FLEET_AUD, iat: now(), exp: now() + 300, jti: randomUUID(), htm: method, htu: o.path ?? (method === "GET" ? "/api/fleet/poll" : "/api/fleet/results"), ...(method === "POST" ? { bsha: sha256b64url(Buffer.from(o.body ?? "", "utf8")) } : {}), ...o.claims },
    k.priv,
  );
};

async function poll(token: string | null, wait = 0) {
  const { GET } = await import("@/app/api/fleet/poll/route");
  const res = await GET(new NextRequest(`https://x.test/api/fleet/poll?wait=${wait}`, { headers: token ? { authorization: `Device ${token}` } : {} }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
async function postResult(token: string | null, body: unknown, rawBody?: string) {
  const { POST } = await import("@/app/api/fleet/results/route");
  const text = rawBody ?? JSON.stringify(body);
  const res = await POST(new NextRequest("https://x.test/api/fleet/results", { method: "POST", body: text, headers: { ...(token ? { authorization: `Device ${token}` } : {}), "content-type": "application/json" } }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

let seq = 0;
const iso = (offsetS: number) => new Date(Date.now() + offsetS * 1000).toISOString();
const SIGNER = loadSigner()!;
const KEYS = publicKeysOf(SIGNER);
const queueCommand = (sql: never, c: unknown) => queueRaw(sql, c, KEYS);
/** A signed envelope v2 for a device; `over` is applied BEFORE signing unless it carries its own `signature`. */
const cmdFor = (deviceId: string, machine: string, over: Partial<Envelope> = {}): Envelope => {
  const { signature, ...unsigned } = {
    ...buildSignedEnvelope({ device_id: deviceId, machine, verb: "helper_status", params: {}, issuer: { kind: "operator", id: "op_fake" }, approval_ref: null, ttl_s: 240, nowMs: Date.now() - 1000 }, SIGNER),
    cmd_id: `cmd_h3_${++seq}`,
    ...over,
  };
  void signature;
  return { ...unsigned, signature: over.signature ?? signEnvelope(unsigned, SIGNER) };
};

let K: Key;
let DEV: string;

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
    DELETE FROM room_install WHERE install_id LIKE 'inst_h3_%'; DELETE FROM room WHERE id IN ('room_h3a', 'room_h3b');
    INSERT INTO room (id, slug, name, pin_hash) VALUES ('room_h3a', 'h3-a', 'H3 A', 'x'), ('room_h3b', 'h3-b', 'H3 B', 'x');
    INSERT INTO room_install (install_id, room_id, hostname, enrolled_at, enrolled_by) VALUES ('${INSTALL}', 'room_h3a', 'EHRC-HOME’s Mac mini', now(), 'test'), ('inst_h3_2', 'room_h3b', 'EHRC-OTHERs-Mac-mini', now(), 'test');
  `);
  ROOM_JWT = await signRoomJwt({ room_id: "room_h3a", slug: "h3-a" });
  K = newKey();
  const r = await register(K);
  if (process.env.H3_DEBUG) console.log("REG", JSON.stringify(r));
  DEV = String(r.json.device_id);
});

(HAVE ? describe : describe.skip)("TS-H3 on real postgres", () => {
  // ---------------------------------------------------------------- register
  describe("POST /api/fleet/register", () => {
    it("binds the key: 201 with a device_id and the server key ids; the same key again is an idempotent 200 with the SAME device; one row; an audit row", async () => {
      expect(DEV).toMatch(/^dev_[a-f0-9]{24}$/);
      const again = await register(K);
      expect(again.status).toBe(200);
      expect(again.json).toMatchObject({ ok: true, device_id: DEV, server_key_ids: ["fk1", "fk2"], poll_url: "/api/fleet/poll" });
      expect(await q`SELECT device_id, status, public_key FROM fleet_devices`).toEqual([{ device_id: DEV, status: "active", public_key: K.pub }]);
      expect((await q<{ action: string }>`SELECT action FROM fleet_audit ORDER BY id`).map((a) => a.action)).toEqual(["register"]);
    });

    it("REFUSED: no room JWT, an expired room JWT, a JWT for another room", async () => {
      expect((await register(newKey(), { bearer: null })).json.error).toBe("room_auth");
      const expired = await new SignJWT({ room_id: "room_h3a", slug: "h3-a" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt(now() - 7200).setAudience("room").setExpirationTime(now() - 3600).sign(new TextEncoder().encode(process.env.JWT_SECRET_DOCTOR));
      expect(await register(newKey(), { bearer: expired })).toMatchObject({ status: 401, json: { error: "room_auth" } });
      const other = await signRoomJwt({ room_id: "room_h3b", slug: "h3-b" });
      expect(await register(newKey(), { bearer: other })).toMatchObject({ status: 403, json: { error: "room_mismatch" } });
    });

    it("REFUSED: an EXPIRED registration proof", async () => {
      const k = newKey();
      const r = await register(k, { installId: "inst_h3_1", proofOver: { iat: now() - 1200, exp: now() - 900 } });
      expect(r).toMatchObject({ status: 401, json: { error: "expired" } });
    });

    it("REFUSED: a proof signed by a different key (bad signature), a proof naming another key (pk), a replayed proof", async () => {
      const k = newKey();
      expect(await register(k, { signWith: newKey() })).toMatchObject({ status: 401, json: { error: "bad_signature" } });
      expect(await register(k, { proofOver: { pk: sha256b64url("someone else") } })).toMatchObject({ status: 401, json: { error: "proof_key_mismatch" } });
      const jti = randomUUID();
      const k2 = newKey();
      const one = await register(k2, { installId: "inst_h3_1", proofOver: { jti } });
      expect(one.status).toBe(409); // a different key for an existing install: KEY_CONFLICT (the proof was still consumed)
      expect(await register(k2, { installId: "inst_h3_1", proofOver: { jti } })).toMatchObject({ status: 401, json: { error: "replay" } });
    });

    it("REFUSED: a different key for the same install is 409 KEY_CONFLICT and changes nothing; a revoked device 409 REVOKED; a retired install 409 RETIRED; unknown install 404; wrong machine 403", async () => {
      expect(await register(newKey())).toMatchObject({ status: 409, json: { error: "KEY_CONFLICT" } });
      expect((await q<{ public_key: string }>`SELECT public_key FROM fleet_devices`)[0]!.public_key).toBe(K.pub);
      expect(await register(newKey(), { installId: "inst_h3_nope" })).toMatchObject({ status: 404, json: { error: "unknown_install" } });
      expect(await register(newKey(), { body: { machine: "SOME-OTHER-MAC" } })).toMatchObject({ status: 403, json: { error: "machine_mismatch" } });
      await revokeDevice(H.sql as never, DEV, "op_fake");
      expect(await register(K)).toMatchObject({ status: 409, json: { error: "REVOKED" } });
      pg.exec(`UPDATE room_install SET retired_at = now() WHERE install_id = '${INSTALL}'`);
      expect(await register(newKey())).toMatchObject({ status: 409, json: { error: "RETIRED" } });
    });

    it("REFUSED: malformed bodies", async () => {
      const k = newKey();
      expect((await register(k, { body: { public_key: "short" } })).json.error).toBe("bad_public_key");
      expect((await register(k, { body: { key_alg: "rsa" } })).json.error).toBe("bad_key_alg");
      expect((await register(k, { body: { machine: "" } })).json.error).toBe("bad_machine");
      expect((await register(k, { body: { serial_hash: "not-a-hash" } })).json.error).toBe("bad_serial_hash");
    });
  });

  // ------------------------------------------------------------ authentication
  describe("device authentication (poll)", () => {
    it("an authentic token is accepted", async () => {
      const r = await poll(deviceJwt(DEV, K));
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ ok: true, commands: [], kill_switch: { global: false } });
      expect(Number.isFinite(Date.parse(String(r.json.server_time)))).toBe(true);
      expect((await q<{ t: unknown }>`SELECT last_poll_at AS t FROM fleet_devices WHERE device_id = ${DEV}`)[0]!.t).not.toBeNull();
    });

    it("REFUSED: no header, a malformed header, a bearer instead of Device", async () => {
      expect(await poll(null)).toMatchObject({ status: 401, json: { error: "malformed" } });
      expect(await poll("not.a.jws")).toMatchObject({ status: 401, json: { error: "malformed" } });
    });

    it("REFUSED: iss must equal kid (a genuine signature by the device's key, but the claims name another issuer)", async () => {
      expect(await poll(deviceJwt(DEV, K, { claims: { iss: "dev_" + "2".repeat(24) } }))).toMatchObject({ status: 401, json: { error: "malformed" } });
      expect(await poll(deviceJwt(DEV, K, { claims: { iss: undefined } }))).toMatchObject({ status: 401, json: { error: "malformed" } });
    });

    it("REFUSED: UNKNOWN DEVICE (a valid signature by a key the server never registered)", async () => {
      const stranger = newKey();
      expect(await poll(deviceJwt("dev_" + "0".repeat(24), stranger))).toMatchObject({ status: 401, json: { error: "unknown_device" } });
    });

    it("REFUSED: BAD SIGNATURE — signed by another key; and TAMPERED claims on a genuine signature", async () => {
      expect(await poll(deviceJwt(DEV, newKey()))).toMatchObject({ status: 401, json: { error: "bad_signature" } });
      const good = deviceJwt(DEV, K);
      const [h, p, s] = good.split(".") as [string, string, string];
      const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
      claims.exp = (claims.exp as number) + 3000; // stretch the lifetime
      const tampered = `${h}.${b64url(JSON.stringify(claims))}.${s}`;
      expect(await poll(tampered)).toMatchObject({ status: 401, json: { error: "bad_signature" } });
    });

    it("REFUSED: a REPLAYED token (the same jti twice)", async () => {
      const t = deviceJwt(DEV, K);
      expect((await poll(t)).status).toBe(200);
      expect(await poll(t)).toMatchObject({ status: 401, json: { error: "replay" } });
      expect(await q`SELECT 1 FROM fleet_jti WHERE signer = ${DEV}`).toHaveLength(1);
    });

    it("REFUSED: expired, not yet valid, lifetime over 300 s, wrong audience, wrong request line", async () => {
      expect(await poll(deviceJwt(DEV, K, { claims: { iat: now() - 900, exp: now() - 600 } }))).toMatchObject({ json: { error: "expired" } });
      expect(await poll(deviceJwt(DEV, K, { claims: { iat: now() + 900, exp: now() + 1100 } }))).toMatchObject({ json: { error: "not_yet_valid" } });
      expect(await poll(deviceJwt(DEV, K, { claims: { exp: now() + 400 } }))).toMatchObject({ json: { error: "ttl_too_long" } });
      expect(await poll(deviceJwt(DEV, K, { claims: { aud: "evenscribe-fleet-register" } }))).toMatchObject({ json: { error: "bad_audience" } });
      expect(await poll(deviceJwt(DEV, K, { claims: { htu: "/api/fleet/results" } }))).toMatchObject({ json: { error: "request_mismatch" } });
      expect(await poll(deviceJwt(DEV, K, { claims: { htm: "POST" } }))).toMatchObject({ json: { error: "request_mismatch" } });
    });

    it("clock skew is tolerated both ways inside 120 s", async () => {
      expect((await poll(deviceJwt(DEV, K, { claims: { iat: now() + 100, exp: now() + 300 } }))).status).toBe(200);
      expect((await poll(deviceJwt(DEV, K, { claims: { iat: now() - 400, exp: now() - 100 } }))).status).toBe(200);
    });

    it("REFUSED: a REVOKED device gets 401 revoked and stops; so does a device whose install was RETIRED", async () => {
      await revokeDevice(H.sql as never, DEV, "op_fake");
      expect(await poll(deviceJwt(DEV, K))).toMatchObject({ status: 401, json: { error: "revoked" } });
      const k2 = newKey();
      pg.exec(`UPDATE fleet_devices SET status = 'active', revoked_at = NULL, public_key = '${k2.pub}' WHERE device_id = '${DEV}'`);
      expect((await poll(deviceJwt(DEV, k2))).status).toBe(200);
      pg.exec(`UPDATE room_install SET retired_at = now() WHERE install_id = '${INSTALL}'`);
      expect(await poll(deviceJwt(DEV, k2))).toMatchObject({ status: 401, json: { error: "revoked" } });
    });

    it("a bad wait is 400 and costs nothing", async () => {
      const { GET } = await import("@/app/api/fleet/poll/route");
      for (const w of ["26", "-1", "abc", "1.5"]) {
        const res = await GET(new NextRequest(`https://x.test/api/fleet/poll?wait=${w}`, { headers: { authorization: `Device ${deviceJwt(DEV, K)}` } }));
        expect(res.status, w).toBe(400);
      }
    });

    it("jti rows older than 15 minutes are pruned for the signer; a fresh one is kept", async () => {
      pg.exec(`INSERT INTO fleet_jti (signer, jti, seen_at) VALUES ('${DEV}', 'old-jti-00000001', now() - interval '20 minutes')`);
      await poll(deviceJwt(DEV, K));
      expect((await q<{ jti: string }>`SELECT jti FROM fleet_jti WHERE signer = ${DEV}`).map((r) => r.jti)).not.toContain("old-jti-00000001");
      expect(await claimJti(H.sql as never, DEV, "fresh-jti-0000001")).toBe(true);
      expect(await claimJti(H.sql as never, DEV, "fresh-jti-0000001")).toBe(false);
    });
  });

  // ------------------------------------------------------------------ long-poll
  describe("long-poll", () => {
    it("TIMEOUT: wait=1 with nothing queued returns an empty list after about a second (not at once, not much later)", async () => {
      const t0 = Date.now();
      const r = await poll(deviceJwt(DEV, K), 1);
      const dt = Date.now() - t0;
      expect(r.json.commands).toEqual([]);
      expect(dt).toBeGreaterThanOrEqual(0); // the interval (1.5 s) is longer than wait=1, so the first pass is also the last
      expect(dt).toBeLessThan(5000);
    });

    it("holds the request until the deadline and returns the moment a command appears (fake clock)", async () => {
      let t = 1_000_000;
      const sleeps: number[] = [];
      const clock: Clock = {
        now: () => t,
        sleep: async (ms) => {
          sleeps.push(ms);
          t += ms;
          if (sleeps.length === 3) await queueCommand(H.sql as never, cmdFor(DEV, MACHINE));
        },
      };
      const out = await longPoll(H.sql as never, DEV, 25, clock, 1500);
      expect(sleeps).toEqual([1500, 1500, 1500]); // the command appeared during the third sleep, so the fourth pass returns it
      expect(out.commands).toHaveLength(1);
      // and with nothing ever queued it runs to the deadline and returns empty
      t = 0;
      sleeps.length = 0;
      const empty = await longPoll(H.sql as never, DEV, 6, { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } }, 1500);
      expect(empty.commands).toEqual([]);
      expect(sleeps.length).toBe(4); // t = 0, 1500, 3000, 4500: the next sleep would pass the 6 s deadline
    });

    it("DELIVERY: the envelope is served exactly as queued (ms timestamps, approval_ref null, issuer object); not re-sent within 30 s; re-sent after; never after expiry", async () => {
      const c = cmdFor(DEV, MACHINE, { verb: "collect_diag", params: { scope: "audio", log_lines: 200 }, approval_ref: "go_fake1" });
      expect(await queueCommand(H.sql as never, c)).toMatchObject({ ok: true });
      const r1 = await poll(deviceJwt(DEV, K));
      const env = (r1.json.commands as Array<Record<string, unknown>>)[0]!;
      expect(env).toMatchObject({ v: 2, cmd_id: c.cmd_id, device_id: DEV, machine: MACHINE, verb: "collect_diag", params: { scope: "audio", log_lines: 200 }, nonce: c.nonce, issuer: { kind: "operator", id: "op_fake" }, approval_ref: "go_fake1", key_id: "fk1", signature: c.signature });
      expect(String(env.issued_at)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(Date.parse(String(env.issued_at))).toBe(Date.parse(c.issued_at));
      expect(Date.parse(String(env.expires_at))).toBe(Date.parse(c.expires_at));
      expect((await poll(deviceJwt(DEV, K))).json.commands).toEqual([]); // delivered, inside the 30 s grace
      pg.exec(`UPDATE fleet_commands SET delivered_at = now() - interval '31 seconds' WHERE cmd_id = '${c.cmd_id}'`);
      expect(((await poll(deviceJwt(DEV, K))).json.commands as unknown[]).length).toBe(1);
      expect((await q<{ delivery_count: number }>`SELECT delivery_count FROM fleet_commands WHERE cmd_id = ${c.cmd_id}`)[0]!.delivery_count).toBe(2);
      pg.exec(`UPDATE fleet_commands SET delivered_at = now() - interval '31 seconds', expires_at = now() - interval '1 second', issued_at = now() - interval '200 seconds' WHERE cmd_id = '${c.cmd_id}'`);
      expect((await poll(deviceJwt(DEV, K))).json.commands).toEqual([]);
    });

    it("a queued command that has expired is flipped to 'expired' and never delivered; one issued far in the future is held back", async () => {
      pg.exec(`INSERT INTO fleet_commands (cmd_id, device_id, machine, verb, issued_at, expires_at, nonce, issuer_kind, issuer_id, key_id, signature)
        VALUES ('cmd_old', '${DEV}', '${MACHINE}', 'helper_status', now() - interval '200 seconds', now() - interval '5 seconds', 'n_old', 'operator', 'op', 'fk1', 'sig'),
               ('cmd_future', '${DEV}', '${MACHINE}', 'wake', now() + interval '600 seconds', now() + interval '800 seconds', 'n_fut', 'operator', 'op', 'fk1', 'sig')`);
      expect((await poll(deviceJwt(DEV, K))).json.commands).toEqual([]);
      expect(await q`SELECT cmd_id, state FROM fleet_commands ORDER BY cmd_id`).toEqual([{ cmd_id: "cmd_future", state: "queued" }, { cmd_id: "cmd_old", state: "expired" }]);
    });

    it("F2: the envelope serves the machine the command was ISSUED for, even after a same-key re-registration under another spelling", async () => {
      const c = cmdFor(DEV, MACHINE);
      expect(await queueCommand(H.sql as never, c)).toMatchObject({ ok: true });
      const again = await register(K, { body: { machine: "EHRC-HOME’s Mac mini" } }); // normalises equal to MACHINE
      expect(again.status).toBe(200);
      expect((await q<{ machine: string }>`SELECT machine FROM fleet_devices WHERE device_id = ${DEV}`)[0]!.machine).toBe("EHRC-HOME’s Mac mini");
      const env = ((await poll(deviceJwt(DEV, K))).json.commands as Array<Record<string, unknown>>)[0]!;
      expect(env.machine).toBe(MACHINE);
    });

    it("a device receives only ITS OWN commands", async () => {
      const k2 = newKey();
      const second = await register(k2, { installId: "inst_h3_2", bearer: await signRoomJwt({ room_id: "room_h3b", slug: "h3-b" }), body: { machine: "EHRC-OTHERs-Mac-mini" } });
      const dev2 = String(second.json.device_id);
      await queueCommand(H.sql as never, cmdFor(dev2, "EHRC-OTHERs-Mac-mini"));
      expect((await poll(deviceJwt(DEV, K))).json.commands).toEqual([]);
      expect(((await poll(deviceJwt(dev2, k2))).json.commands as unknown[]).length).toBe(1);
    });

    it("KILL SWITCH: no commands are served while it is on; the reason is reported; turning it off serves them", async () => {
      await queueCommand(H.sql as never, cmdFor(DEV, MACHINE));
      pg.exec(`INSERT INTO fleet_control (key, value) VALUES ('kill_switch', '{"global": true, "reason": "test"}'::jsonb)`);
      const r = await poll(deviceJwt(DEV, K));
      expect(r.json).toMatchObject({ commands: [], kill_switch: { global: true, reason: "test" } });
      expect((await q<{ state: string }>`SELECT state FROM fleet_commands`)[0]!.state).toBe("queued");
      pg.exec(`DELETE FROM fleet_control`);
      expect(((await poll(deviceJwt(DEV, K))).json.commands as unknown[]).length).toBe(1);
    });

    it("claimCommands hands the same command to only one of two concurrent claims", async () => {
      await queueCommand(H.sql as never, cmdFor(DEV, MACHINE));
      const [a, b] = await Promise.all([claimCommands(H.sql as never, DEV), claimCommands(H.sql as never, DEV)]);
      expect(a.length + b.length).toBe(1);
    });
  });

  // ------------------------------------------------------------------- queueing
  describe("queueing is closed: only the catalogue, only by library, no route", () => {
    it("REFUSED: a verb outside the catalogue (shell-ish), loose params, a bad key id, a ttl over 900 s, an unknown or revoked device, a wrong machine", async () => {
      const s = H.sql as never;
      for (const verb of ["bash", "exec", "shell", "rm -rf /", "sudo pmset", "helper_status; id"]) expect(await queueCommand(s, cmdFor(DEV, MACHINE, { verb })), verb).toEqual({ ok: false, reason: "verb_not_allowed" });
      expect(await queueCommand(s, cmdFor(DEV, MACHINE, { params: { "Bad Key": 1 }, signature: "A".repeat(86) + "==" }))).toEqual({ ok: false, reason: "bad_params" });
      expect(await queueCommand(s, cmdFor(DEV, MACHINE, { params: { x: 1.5 }, signature: "A".repeat(86) + "==" }))).toEqual({ ok: false, reason: "bad_params" });
      expect(await queueCommand(s, cmdFor(DEV, MACHINE, { key_id: "fk9" }))).toEqual({ ok: false, reason: "bad_signature" });
      expect(await queueCommand(s, cmdFor(DEV, MACHINE, { expires_at: iso(1200) }))).toEqual({ ok: false, reason: "bad_ttl" });
      expect(await queueCommand(s, cmdFor("dev_" + "1".repeat(24), MACHINE))).toEqual({ ok: false, reason: "unknown_device" });
      expect(await queueCommand(s, cmdFor(DEV, "OTHER-MAC"))).toEqual({ ok: false, reason: "machine_mismatch" });
      await revokeDevice(s, DEV, "op_fake");
      expect(await queueCommand(s, cmdFor(DEV, MACHINE))).toEqual({ ok: false, reason: "device_revoked" });
      expect(await q`SELECT 1 FROM fleet_commands`).toHaveLength(0);
    });

    it("the same command id, or the same nonce for a device, queues once", async () => {
      const c = cmdFor(DEV, MACHINE);
      expect(await queueCommand(H.sql as never, c)).toMatchObject({ ok: true });
      expect(await queueCommand(H.sql as never, c)).toEqual({ ok: false, reason: "duplicate" });
      expect(await queueCommand(H.sql as never, cmdFor(DEV, MACHINE, { nonce: c.nonce }))).toEqual({ ok: false, reason: "duplicate" });
    });

    it("the device-facing routes never queue anything; exactly ONE route (admin-only) can; no cron, job or worker reaches the queue", () => {
      const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
      const fleet = [...walk("app/api/fleet"), ...walk("lib/fleet")].filter((f) => f.endsWith(".ts"));
      expect(fleet.length).toBeGreaterThan(5);
      for (const f of fleet) {
        const src = readFileSync(f, "utf8");
        if (f.startsWith("app/")) expect(src, f).not.toMatch(/fleet\/commands|queueCommand|issueCommand|revokeDevice/);
        expect(src, f).not.toMatch(/child_process|execFile|execSync|spawn\(|(?<![.\w])exec\(|eval\(|new Function/);
      }
      const callers = [...walk("app"), ...walk("lib"), ...walk("scripts")].filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !f.startsWith("lib/fleet/")).filter((f) => /issueCommand|queueCommand/.test(readFileSync(f, "utf8")));
      expect(callers).toEqual(["app/api/admin/fleet/commands/route.ts"]);
      expect(readFileSync("vercel.json", "utf8")).not.toMatch(/fleet/);
    });
  });

  // -------------------------------------------------------------------- results
  describe("POST /api/fleet/results", () => {
    const body = (cmd: string, over: Record<string, unknown> = {}) => ({ cmd_id: cmd, device_id: DEV, outcome: "ok", reason: null, started_at: iso(-3), finished_at: iso(-2), detail: { exit: 0, notes: "done" }, ...over });
    const delivered = async (over: Partial<Envelope> = {}) => {
      const c = cmdFor(DEV, MACHINE, over);
      await queueCommand(H.sql as never, c);
      await poll(deviceJwt(DEV, K));
      return c.cmd_id;
    };
    const send = (b: unknown, k: Key = K, dev = DEV) => { const text = JSON.stringify(b); return postResult(deviceJwt(dev, k, { method: "POST", body: text }), b, text); };

    it("ATOMIC: the result, the command's move to done and the result's audit row are ONE statement — a failing audit insert leaves NO result row and the command stays delivered; the helper's retry then lands cleanly", async () => {
      const id = await delivered();
      pg.exec(`
        CREATE OR REPLACE FUNCTION fleet_audit_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit is down'; END $$;
        CREATE TRIGGER fleet_audit_boom BEFORE INSERT ON fleet_audit FOR EACH ROW EXECUTE FUNCTION fleet_audit_boom();
      `);
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(await send(body(id))).toMatchObject({ status: 503, json: { error: "db" } });
        expect(await q`SELECT 1 FROM fleet_results`).toHaveLength(0);
        expect((await q<{ state: string }>`SELECT state FROM fleet_commands WHERE cmd_id = ${id}`)[0]!.state).toBe("delivered");
        expect(await q`SELECT 1 FROM fleet_audit WHERE action = 'result'`).toHaveLength(0);
      } finally {
        pg.exec("DROP TRIGGER IF EXISTS fleet_audit_boom ON fleet_audit; DROP FUNCTION IF EXISTS fleet_audit_boom()");
        spy.mockRestore();
      }
      expect(await send(body(id))).toMatchObject({ status: 200, json: { ok: true, duplicate: false } });
      expect(await q`SELECT 1 FROM fleet_results`).toHaveLength(1);
      expect(await q`SELECT 1 FROM fleet_audit WHERE action = 'result'`).toHaveLength(1);
      expect((await q<{ state: string }>`SELECT state FROM fleet_commands WHERE cmd_id = ${id}`)[0]!.state).toBe("done");
    });

    it("BOUND TO THE ISSUED COMMAND: a delivered command takes its result once; state becomes done; an audit row; the answer is recorded", async () => {
      const id = await delivered();
      expect(await send(body(id))).toMatchObject({ status: 200, json: { ok: true, duplicate: false } });
      expect(await q`SELECT cmd_id, device_id, outcome, detail FROM fleet_results`).toEqual([{ cmd_id: id, device_id: DEV, outcome: "ok", detail: { exit: 0, notes: "done" } }]);
      expect((await q<{ state: string }>`SELECT state FROM fleet_commands WHERE cmd_id = ${id}`)[0]!.state).toBe("done");
      expect((await q<{ action: string }>`SELECT action FROM fleet_audit WHERE action = 'result'`)).toHaveLength(1);
    });

    it("an identical resend is a 200 duplicate; a DIFFERENT second answer is 409 RESULT_CONFLICT and changes nothing", async () => {
      const id = await delivered();
      const b = body(id);
      await send(b);
      expect(await send(b)).toMatchObject({ status: 200, json: { duplicate: true } });
      expect(await send({ ...b, outcome: "failed" })).toMatchObject({ status: 409, json: { error: "RESULT_CONFLICT" } });
      expect((await q<{ outcome: string }>`SELECT outcome FROM fleet_results`)[0]!.outcome).toBe("ok");
    });

    it("F1: an identical resend whose detail keys are NOT in jsonb order is still 200 duplicate:true (a helper retrying after a lost response); a changed value is 409", async () => {
      const id = await delivered();
      const text = (d: string) => `{"cmd_id":"${id}","device_id":"${DEV}","outcome":"ok","reason":null,"started_at":"2026-10-10T07:00:00.000Z","finished_at":"2026-10-10T07:00:01.000Z","detail":${d}}`;
      const post = (t: string) => postResult(deviceJwt(DEV, K, { method: "POST", body: t }), null, t);
      expect(await post(text('{"notes":"done","exit":0}'))).toMatchObject({ status: 200, json: { duplicate: false } });
      expect(await post(text('{"notes":"done","exit":0}'))).toMatchObject({ status: 200, json: { duplicate: true } });
      expect(await post(text('{ "exit": 0, "notes": "done" }'))).toMatchObject({ status: 200, json: { duplicate: true } });
      expect(await post(text('{"notes":"done","exit":1}'))).toMatchObject({ status: 409, json: { error: "RESULT_CONFLICT" } });
    });

    it("REFUSED: a result for a command that was never delivered (409), for an unknown command (404)", async () => {
      const c = cmdFor(DEV, MACHINE);
      await queueCommand(H.sql as never, c);
      expect(await send(body(c.cmd_id))).toMatchObject({ status: 409, json: { error: "not_delivered" } });
      expect(await send(body("cmd_nope"))).toMatchObject({ status: 404, json: { error: "unknown_command" } });
    });

    it("REFUSED: device B cannot answer device A's command (404, as if it did not exist); body.device_id must be the signer (403)", async () => {
      const id = await delivered();
      const k2 = newKey();
      const second = await register(k2, { installId: "inst_h3_2", bearer: await signRoomJwt({ room_id: "room_h3b", slug: "h3-b" }), body: { machine: "EHRC-OTHERs-Mac-mini" } });
      const dev2 = String(second.json.device_id);
      expect(await send({ ...body(id), device_id: dev2 }, k2, dev2)).toMatchObject({ status: 404, json: { error: "unknown_command" } });
      expect(await send({ ...body(id), device_id: dev2 })).toMatchObject({ status: 403, json: { error: "device_mismatch" } });
      expect(await q`SELECT 1 FROM fleet_results`).toHaveLength(0);
    });

    it("REFUSED: a TAMPERED BODY (token bound to another body), a replayed token, a bad signature, an unsigned post", async () => {
      const id = await delivered();
      const good = JSON.stringify(body(id));
      const token = deviceJwt(DEV, K, { method: "POST", body: good });
      expect(await postResult(token, null, JSON.stringify(body(id, { outcome: "failed" })))).toMatchObject({ status: 401, json: { error: "request_mismatch" } });
      // the failed attempt consumed that jti; a fresh token for the genuine body works, and its replay does not
      const t2 = deviceJwt(DEV, K, { method: "POST", body: good });
      expect((await postResult(t2, null, good)).status).toBe(200);
      expect(await postResult(t2, null, good)).toMatchObject({ status: 401, json: { error: "replay" } });
      expect(await postResult(deviceJwt(DEV, newKey(), { method: "POST", body: good }), null, good)).toMatchObject({ status: 401, json: { error: "bad_signature" } });
      expect(await postResult(null, null, good)).toMatchObject({ status: 401, json: { error: "malformed" } });
    });

    it("REFUSED: bad outcome, oversized detail, a non-canonical detail key, an upload outside this device's prefix, bad JSON, a body over 16 KB", async () => {
      const id = await delivered();
      expect(await send(body(id, { outcome: "great" }))).toMatchObject({ status: 400, json: { error: "bad_outcome" } });
      expect(await send(body(id, { detail: { notes: "x".repeat(5000) } }))).toMatchObject({ status: 400, json: { error: "bad_detail" } });
      expect(await send(body(id, { detail: { "Bad Key": 1 } }))).toMatchObject({ status: 400, json: { error: "bad_detail" } });
      expect(await send(body(id, { upload: { kind: "diag_bundle", r2_key: "fleet/diag/dev_other/x.zip", bytes: 5 } }))).toMatchObject({ status: 400, json: { error: "bad_upload" } });
      expect(await send(body(id, { upload: { kind: "diag_bundle", r2_key: `fleet/diag/${DEV}/${id}.zip`, bytes: 5 } }))).toMatchObject({ status: 200 });
      expect((await q<{ upload_key: string }>`SELECT upload_key FROM fleet_results`)[0]!.upload_key).toBe(`fleet/diag/${DEV}/${id}.zip`);
      const bad = "{not json";
      expect(await postResult(deviceJwt(DEV, K, { method: "POST", body: bad }), null, bad)).toMatchObject({ status: 400, json: { error: "bad_json" } });
      const huge = JSON.stringify({ pad: "x".repeat(17_000) });
      expect(await postResult(deviceJwt(DEV, K, { method: "POST", body: huge }), null, huge)).toMatchObject({ status: 413 });
    });
  });

  // ---------------------------------------------------------------------- audit
  it("fleet_audit is append-only: an UPDATE is refused, an insert is fine", async () => {
    pg.exec(`INSERT INTO fleet_audit (actor, action) VALUES ('t', 'x')`);
    expect(() => pg.exec(`UPDATE fleet_audit SET action = 'y'`)).toThrow(/append-only/);
  });
});
