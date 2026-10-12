/**
 * RR 0.1.37 server side on a REAL postgres:16 with EVERY migration (incl. 0160): the Device JWT on /api/steward/tickets and /api/kiosk-health, the kiosk-health unique key with `source`,
 * the helper_update_* poll fields, the signed release record against a real device row, and the steward.result v2 (cmd_id + nonce) question. All ids and keys are FAKE.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

process.env.JWT_SECRET_DOCTOR = "test-secret-for-rr0137-server-tests-only";
const SEED = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 31)]).toString("base64"); // gitleaks:allow — a fixed FAKE test key
const H = vi.hoisted(() => ({ sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>, room: "room_r1" }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray | string, ...v: unknown[]) => (H.sql as (s: unknown, ...v: unknown[]) => Promise<unknown[]>)(s, ...v) }));
vi.mock("@/lib/room-auth", async (orig) => ({ ...(await orig<Record<string, unknown>>()), readRoomClaims: async () => ({ room_id: H.room }) }));
vi.setConfig({ testTimeout: 90_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-rr0137");

import { signJws, sha256b64url } from "@/lib/fleet/jws";
import { FLEET_AUD } from "@/lib/fleet/device-auth";
import { applyStewardResults } from "@/lib/steward/results";
import { cleanPollFields, writeHelperFields } from "@/lib/room-install";

const q = async <T = Record<string, unknown>>(s: TemplateStringsArray, ...v: unknown[]) => (await H.sql(s, ...v)) as T[];
const now = () => Math.floor(Date.now() / 1000);
const newKey = () => { const { privateKey, publicKey } = generateKeyPairSync("ed25519"); return { priv: privateKey as KeyObject, pub: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") }; };
const DEV = "dev_" + "c".repeat(24);
const DEV2 = "dev_" + "d".repeat(24);
const HOST = "EXAMPLE-MAC-1";
const K = newKey();
const K2 = newKey();

const jwt = (o: { dev?: string; key?: { priv: KeyObject }; method?: "GET" | "POST"; path: string; body?: string; iat?: number; exp?: number }) => {
  const method = o.method ?? "GET";
  const iat = o.iat ?? now();
  return signJws({ alg: "EdDSA", typ: "JWT", kid: o.dev ?? DEV }, { iss: o.dev ?? DEV, aud: FLEET_AUD, iat, exp: o.exp ?? iat + 300, jti: randomUUID(), htm: method, htu: o.path, ...(method === "POST" ? { bsha: sha256b64url(Buffer.from(o.body ?? "", "utf8")) } : {}) }, (o.key ?? K).priv);
};
const getTickets = async (authz: string | null, machine = HOST) => {
  const { GET } = await import("@/app/api/steward/tickets/route");
  const res = await GET(new NextRequest(`https://x.test/api/steward/tickets?machine=${machine}`, { headers: authz ? { authorization: authz } : {} }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const postHealth = async (authz: string, body: unknown, rawBody?: string) => {
  const { POST } = await import("@/app/api/kiosk-health/route");
  const text = rawBody ?? JSON.stringify(body);
  const res = await POST(new NextRequest("https://x.test/api/kiosk-health", { method: "POST", body: text, headers: { authorization: authz, "content-type": "application/json" } }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const ev = (o: Record<string, unknown> = {}) => ({ machine: HOST, room_id: "room_r1", install_id: "inst_r1", boot_id: "b1", seq: 1, source: "helper", kind: "helper.tick", ts: new Date().toISOString(), payload: {}, ...o });

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  // The kiosk-health route also calls `sql(text, params)` (numbered placeholders); the psql harness only knows tagged templates, so that form is rewritten to one (as fleet-h6-pg does).
  const tagged = pg.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>;
  H.sql = ((a: unknown, ...v: unknown[]) => {
    if (typeof a !== "string") return tagged(a as TemplateStringsArray, ...v);
    const parts = a.split(/\$\d+/);
    return tagged(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...(v[0] as unknown[]));
  }) as never;
}, 300_000);
afterAll(() => { if (HAVE) pg.stop(); });

beforeEach(() => {
  if (!HAVE) return;
  process.env.KIOSK_HEALTH_INGEST_TOKEN = "tok-rr0137";
  delete process.env.FLEET_COMMAND_SIGNING_KEY;
  pg.exec(`
    TRUNCATE fleet_results, fleet_commands, fleet_devices, fleet_jti, fleet_control, fleet_audit, kiosk_health_events, kiosk_health_dedupe, steward_tickets, steward_nonces, app_release RESTART IDENTITY CASCADE;
    DELETE FROM room_install WHERE install_id LIKE 'inst_r%'; DELETE FROM room WHERE id IN ('room_r1', 'room_r2');
    INSERT INTO room (id, slug, name, pin_hash) VALUES ('room_r1', 'r-1', 'R 1', 'x'), ('room_r2', 'r-2', 'R 2', 'x');
    INSERT INTO room_install (install_id, room_id, hostname, enrolled_at, enrolled_by) VALUES ('inst_r1', 'room_r1', '${HOST}', now(), 'test'), ('inst_r2', 'room_r2', 'EXAMPLE-MAC-2', now(), 'test');
    INSERT INTO fleet_devices (device_id, install_id, room_id, machine, public_key, registered_at) VALUES
      ('${DEV}', 'inst_r1', 'room_r1', '${HOST}', '${K.pub}', now()), ('${DEV2}', 'inst_r2', 'room_r2', 'EXAMPLE-MAC-2', '${K2.pub}', now());
  `);
});

(HAVE ? describe : describe.skip)("RR 0.1.37 server on real postgres", () => {
  describe("migration 0160", () => {
    it("the old 3-column key is gone, the 4-column key exists, and the three room_install columns exist", async () => {
      const keys = (await q<{ conname: string }>`SELECT conname FROM pg_constraint WHERE conrelid = 'kiosk_health_events'::regclass AND contype = 'u'`).map((r) => r.conname);
      expect(keys).toEqual(["kiosk_health_events_machine_boot_seq_source_key"]);
      const cols = (await q<{ column_name: string }>`SELECT column_name FROM information_schema.columns WHERE table_name = 'room_install' AND column_name LIKE 'helper_update_%' ORDER BY 1`).map((r) => r.column_name);
      expect(cols).toEqual(["helper_update_result", "helper_update_step", "helper_update_version"]);
    });
  });

  describe("GET /api/steward/tickets with a fleet Device JWT", () => {
    const issue = () => pg.exec(`INSERT INTO steward_tickets (ticket_id, machine, action, params, issued_at, expires_at, nonce, signature, status) VALUES ('t_r1', '${HOST}', 'wake', '{}', now(), now() + interval '10 minutes', 'n_r1', 's_r1', 'issued')`);
    it("a valid token gets the same response as the Bearer path, and works with the Bearer env UNSET", async () => {
      issue();
      delete process.env.KIOSK_HEALTH_INGEST_TOKEN;
      const r = await getTickets(`Device ${jwt({ path: "/api/steward/tickets" })}`);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ ok: true, tickets: [{ ticket: { ticket_id: "t_r1", machine: HOST, nonce: "n_r1" }, signature: "s_r1" }] });
    });
    it("401: wrong path, expired, foreign key, unknown device, replayed token, malformed; the Bearer path is unchanged", async () => {
      issue();
      const path = "/api/steward/tickets";
      expect((await getTickets(`Device ${jwt({ path: "/api/fleet/poll" })}`)).json).toMatchObject({ error: "request_mismatch" });
      expect((await getTickets(`Device ${jwt({ path, iat: now() - 1000, exp: now() - 700 })}`)).json).toMatchObject({ error: "expired" });
      expect((await getTickets(`Device ${jwt({ path, key: K2 })}`)).json).toMatchObject({ error: "bad_signature" });
      expect((await getTickets(`Device ${jwt({ path, dev: "dev_" + "e".repeat(24) })}`)).json).toMatchObject({ error: "unknown_device" });
      const once = `Device ${jwt({ path })}`;
      expect((await getTickets(once)).status).toBe(200);
      expect(await getTickets(once)).toMatchObject({ status: 401, json: { error: "replay" } });
      expect((await getTickets("Device not-a-jws")).status).toBe(401);
      expect((await getTickets("Bearer tok-rr0137")).status).toBe(200);
      expect((await getTickets("Bearer nope")).status).toBe(401);
    });
    it("a device may fetch only its own machine's tickets (403); a revoked device is 401", async () => {
      expect(await getTickets(`Device ${jwt({ path: "/api/steward/tickets" })}`, "EXAMPLE-MAC-2")).toMatchObject({ status: 403, json: { error: "machine_mismatch" } });
      pg.exec(`UPDATE fleet_devices SET status = 'revoked' WHERE device_id = '${DEV}'`);
      expect(await getTickets(`Device ${jwt({ path: "/api/steward/tickets" })}`)).toMatchObject({ status: 401, json: { error: "revoked" } });
    });
  });

  describe("POST /api/kiosk-health with a fleet Device JWT", () => {
    const path = "/api/kiosk-health";
    it("stores a helper event for its own Mac; the token binds the exact body", async () => {
      const body = JSON.stringify({ events: [ev()] });
      const ok = await postHealth(`Device ${jwt({ method: "POST", path, body })}`, null, body);
      expect(ok).toMatchObject({ status: 200, json: { accepted: 1, rejected: 0 } });
      const other = JSON.stringify({ events: [ev({ seq: 2 })] });
      expect(await postHealth(`Device ${jwt({ method: "POST", path, body })}`, null, other)).toMatchObject({ status: 401 });
      expect(await q`SELECT 1 FROM kiosk_health_events`).toHaveLength(1);
    });
    it("401: wrong path, expired, foreign key. Refused by name: another Mac, wrong source, steward.result", async () => {
      const body = JSON.stringify({ events: [ev()] });
      expect((await postHealth(`Device ${jwt({ method: "POST", path: "/api/fleet/results", body })}`, null, body)).status).toBe(401);
      expect((await postHealth(`Device ${jwt({ method: "POST", path, body, iat: now() - 1000, exp: now() - 700 })}`, null, body)).status).toBe(401);
      expect((await postHealth(`Device ${jwt({ method: "POST", path, body, key: K2 })}`, null, body)).status).toBe(401);
      const mixed = JSON.stringify({ events: [ev({ machine: "EXAMPLE-MAC-2", seq: 3 }), ev({ source: "daemon", seq: 4 }), ev({ kind: "steward.result", seq: 5 })] });
      const r = await postHealth(`Device ${jwt({ method: "POST", path, body: mixed })}`, null, mixed);
      expect(r.json).toMatchObject({ accepted: 0, rejected: 3 });
      expect((r.json.rejected_reasons as Array<{ reason: string }>).map((x) => x.reason).sort()).toEqual(["kind_not_allowed", "machine_not_in_room", "wrong_source"]);
    });
    it("the same machine, boot and seq from TWO sources is two rows; a replay of either is still a duplicate", async () => {
      const t = Date.now();
      const body = JSON.stringify({ events: [ev({ seq: 7, ts: new Date(t).toISOString() })] });
      expect((await postHealth(`Device ${jwt({ method: "POST", path, body })}`, null, body)).json).toMatchObject({ accepted: 1 });
      const daemon = JSON.stringify({ events: [ev({ seq: 7, source: "daemon", kind: "heartbeat", ts: new Date(t + 60_000).toISOString() })] });
      expect((await postHealth("Bearer tok-rr0137", null, daemon)).json).toMatchObject({ accepted: 1, duplicates: 0 });
      expect((await q<{ source: string }>`SELECT source FROM kiosk_health_events WHERE seq = 7 ORDER BY source`).map((r) => r.source)).toEqual(["daemon", "helper"]);
      expect((await postHealth("Bearer tok-rr0137", null, daemon)).json).toMatchObject({ accepted: 0, duplicates: 1 });
      const again = jwt({ method: "POST", path, body });
      expect((await postHealth(`Device ${again}`, null, body)).json).toMatchObject({ accepted: 0, duplicates: 1 });
      expect(await q`SELECT 1 FROM kiosk_health_events WHERE seq = 7`).toHaveLength(2);
    });
  });

  describe("bench poll: helper_update_step / _version / _result", () => {
    const raw = (o: Record<string, unknown>) => cleanPollFields(o as never);
    it("closed charset, length-capped, malformed dropped to null (never a refusal), absent stays null", () => {
      expect(raw({ helper_update_step: "verify_pkg", helper_update_version: "0.2.3-h5", helper_update_result: "ok" })).toMatchObject({ helper_update_step: "verify_pkg", helper_update_version: "0.2.3-h5", helper_update_result: "ok" });
      expect(raw({})).toMatchObject({ helper_update_step: null, helper_update_version: null, helper_update_result: null });
      for (const bad of ["Verify", "a b", "x".repeat(33), "9step", "step;drop", "", "é"]) expect(raw({ helper_update_step: bad, helper_update_result: bad }), bad).toMatchObject({ helper_update_step: null, helper_update_result: null });
      for (const bad of ["x".repeat(33), "-1", "a b", ""]) expect(raw({ helper_update_version: bad }), bad).toMatchObject({ helper_update_version: null });
    });
    it("stored on the install row; a later poll without them leaves them (COALESCE); the GET route reads the query string", async () => {
      await writeHelperFields(pg.sql as never, "inst_r1", raw({ helper_update_step: "install", helper_update_version: "0.2.3-h5", helper_update_result: "pending" }));
      expect(await q`SELECT helper_update_step, helper_update_version, helper_update_result FROM room_install WHERE install_id = 'inst_r1'`).toEqual([{ helper_update_step: "install", helper_update_version: "0.2.3-h5", helper_update_result: "pending" }]);
      await writeHelperFields(pg.sql as never, "inst_r1", raw({ helper_state: "ok" }));
      expect(await q`SELECT helper_update_step FROM room_install WHERE install_id = 'inst_r1'`).toEqual([{ helper_update_step: "install" }]);
      await writeHelperFields(pg.sql as never, "inst_r1", raw({ helper_update_result: "ok" }));
      expect(await q`SELECT helper_update_step, helper_update_result FROM room_install WHERE install_id = 'inst_r1'`).toEqual([{ helper_update_step: "install", helper_update_result: "ok" }]);
    });
  });

  describe("GET /api/room-recorder/release with a real device row", () => {
    const rel = () => pg.exec(`INSERT INTO app_release (id, version, build_sha, sha256, size_bytes, blob_url, channel, published_by, platform) VALUES ('rel_r1', '0.1.37', 'abc', '${"b".repeat(64)}', 1000, 'https://x.public.blob.vercel-storage.com/a.pkg', 'stable', 'op', 'macos')`);
    const get = async () => {
      const { GET } = await import("@/app/api/room-recorder/release/route");
      const res = await GET(new NextRequest("https://www.evenscribe.app/api/room-recorder/release"));
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    it("signed record for the room's own device; a retired install or a revoked device gives none; the key unset gives none", async () => {
      rel();
      expect(Object.keys((await get()).json)).toHaveLength(4);
      process.env.FLEET_COMMAND_SIGNING_KEY = SEED;
      const ok = await get();
      expect(ok.status).toBe(200);
      expect(ok.json.record).toMatchObject({ v: 1, device_id: DEV, machine: HOST, version: "0.1.37", pkg_size: 1000 });
      H.room = "room_r2";
      expect((await get()).json.record).toMatchObject({ device_id: DEV2 });
      pg.exec(`UPDATE room_install SET retired_at = now() WHERE install_id = 'inst_r2'`);
      expect(Object.keys((await get()).json)).toHaveLength(4);
      H.room = "room_r1";
      pg.exec(`UPDATE fleet_devices SET status = 'revoked' WHERE device_id = '${DEV}'`);
      expect(Object.keys((await get()).json)).toHaveLength(4);
    });
  });

  describe("steward.result v2: a {envelope} item reported against cmd_id + nonce (item 5)", () => {
    it("the existing steward.result path is ticket_id + nonce only: a cmd_id + nonce payload is IGNORED and changes nothing", async () => {
      pg.exec(`INSERT INTO fleet_commands (cmd_id, device_id, machine, verb, issued_at, expires_at, nonce, issuer_kind, issuer_id, key_id, signature, state, delivery_count)
        VALUES ('cmd_r1', '${DEV}', '${HOST}', 'helper_status', now(), now() + interval '200 seconds', 'n_cmd_r1', 'operator', 'op', 'fk1', 'sig', 'delivered', 1)`);
      const stats = await applyStewardResults(pg.sql as never, [{ machine: HOST, kind: "steward.result", payload: { cmd_id: "cmd_r1", nonce: "n_cmd_r1", outcome: "done" } }]);
      expect(stats).toEqual({ applied: 0, ignored: 1, errors: 0 });
      expect(await q`SELECT state FROM fleet_commands WHERE cmd_id = 'cmd_r1'`).toEqual([{ state: "delivered" }]);
      expect(await q`SELECT 1 FROM fleet_results`).toHaveLength(0);
    });
  });
});
