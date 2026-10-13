/**
 * REFUTER PROBE (not for merge). The NEW register code on a database WITHOUT 0167: fail closed, or break everyone?
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

process.env.JWT_SECRET_DOCTOR = "test-secret-for-refute-pre0167-only";

const H = vi.hoisted(() => ({ sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]> }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.setConfig({ testTimeout: 90_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-refute-pre0167");

import { sha256b64url, signJws } from "@/lib/fleet/jws";
import { FLEET_REGISTER_AUD } from "@/lib/fleet/device-auth";
import { signRoomJwt } from "@/lib/room-auth";

type Key = { priv: KeyObject; pub: string };
const newKey = (): Key => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { priv: privateKey, pub: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") };
};
const now = () => Math.floor(Date.now() / 1000);
async function register(k: Key, install: string, machine: string, jwt: string) {
  const { POST } = await import("@/app/api/fleet/register/route");
  const p = signJws(
    { alg: "EdDSA", typ: "JWT", kid: `install:${install}` },
    { iss: install, aud: FLEET_REGISTER_AUD, iat: now(), exp: now() + 300, jti: randomUUID(), htm: "POST", htu: "/api/fleet/register", pk: sha256b64url(Buffer.from(k.pub, "base64")) },
    k.priv,
  );
  const body = { install_id: install, machine, hw_model: "Macmini9,1", serial_hash: "c".repeat(64), helper_version: "0.1.40", key_alg: "ed25519", public_key: k.pub, proof: p };
  const res = await POST(new NextRequest("https://x.test/api/fleet/register", { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" } }));
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql") && x < "0167").sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  H.sql = pg.sql as never;
  pg.exec(`
    INSERT INTO room (id, slug, name, pin_hash) VALUES ('room_p1', 'p-1', 'P 1', 'x'), ('room_p2', 'p-2', 'P 2', 'x');
    INSERT INTO room_install (install_id, room_id, hostname, enrolled_at, enrolled_by) VALUES ('inst_p_1', 'room_p1', 'EHRC-P1-Mac-mini', now(), 'test'), ('inst_p_2', 'room_p2', 'EHRC-P2-Mac-mini', now(), 'test');
  `);
}, 300_000);
afterAll(() => { if (HAVE) pg.stop(); });

(HAVE ? describe : describe.skip)("REFUTE: new code, database without 0167", () => {
  it("first registration 201, same key 200, different key fails closed (no second device), other installs unaffected", async () => {
    const j1 = await signRoomJwt({ room_id: "room_p1", slug: "p-1" });
    const j2 = await signRoomJwt({ room_id: "room_p2", slug: "p-2" });
    const k = newKey();
    const first = await register(k, "inst_p_1", "EHRC-P1-Mac-mini", j1);
    const again = await register(k, "inst_p_1", "EHRC-P1-Mac-mini", j1);
    const other = await register(newKey(), "inst_p_1", "EHRC-P1-Mac-mini", j1);
    const fresh = await register(newKey(), "inst_p_2", "EHRC-P2-Mac-mini", j2);
    const rows = (await H.sql`SELECT install_id, status FROM fleet_devices ORDER BY install_id`) as unknown[];
    console.log("REFUTE-PRE0167", JSON.stringify({ first: first.status, again: again.status, other: [other.status, other.json], fresh: fresh.status, rows }));
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(other.status).not.toBe(201);
    expect(other.status).not.toBe(200);
    expect(fresh.status).toBe(201);
    expect(rows).toHaveLength(2);
  });
});
