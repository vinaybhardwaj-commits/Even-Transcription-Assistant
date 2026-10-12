/** RR 0.1.37 #45 — the signed per-device update record: the bucket vector, exactly 16 fields, the signature, and the route's dark behaviour. sql is mocked; the real-DB path is rr0137-server-pg.test.ts. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPublicKey, generateKeyPairSync, verify as edVerify } from "node:crypto";

const calls: string[] = [];
let responses: unknown[] = [];
vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray) => {
    calls.push(strings.join("?").replace(/\s+/g, " ").trim());
    const next = responses.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
  };
  return { sql, db: {} };
});
vi.mock("@/lib/room-auth", () => ({ readRoomClaims: async () => ({ room_id: "room_1" }) }));

import { loadSigner } from "@/lib/fleet/signing";
import { canonicalJson } from "@/lib/fleet/canonical";
import { RECORD_FIELDS, RECORD_TTL_MS, buildRecord, releaseBucket, signRecord } from "@/lib/fleet/release-record";

const seed = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 21)]).toString("base64"); // gitleaks:allow — a fixed FAKE test key
const KEY_ENV = "FLEET_COMMAND_SIGNING_KEY";
const DEVICE = { device_id: "dev_" + "0".repeat(23) + "1", machine: "EXAMPLE-MAC" };
const RELEASE = { version: "0.1.37", sha256: "a".repeat(64), size_bytes: 94371840, blob_url: "https://x.public.blob.vercel-storage.com/EvenScribe-0.1.37.pkg" };
const pubOf = (b64: string) => loadSigner({ [KEY_ENV]: b64 })!.publicKeyB64;
const verifies = (record: object, sig: string, publicKeyB64: string) =>
  edVerify(null, Buffer.from(canonicalJson(record), "utf8"), createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyB64, "base64")]), format: "der", type: "spki" }), Buffer.from(sig, "base64"));

describe("releaseBucket", () => {
  it("is the first 4 bytes of sha256('<device_id>|<version>') big-endian, mod 100 (vectors from `shasum -a 256`)", () => {
    // printf 'dev_0123456789abcdef01234567|0.1.37' | shasum -a 256  -> 539a4273... ; 0x539a4273 % 100 = 83
    expect(releaseBucket("dev_0123456789abcdef01234567", "0.1.37")).toBe(83);
    // printf 'dev_000000000000000000000001|0.1.37' | shasum -a 256  -> a9880f6c... ; 0xa9880f6c % 100 = 48
    expect(releaseBucket("dev_000000000000000000000001", "0.1.37")).toBe(48);
  });
  it("is always 0..99 and depends on the version", () => {
    for (let i = 0; i < 200; i++) expect(releaseBucket(`dev_${String(i).padStart(24, "0")}`, "1")).toBeLessThan(100);
    expect(new Set(["0.1.36", "0.1.37", "0.1.38", "0.1.39"].map((v) => releaseBucket(DEVICE.device_id, v))).size).toBeGreaterThan(1);
  });
});

describe("the record", () => {
  const signer = loadSigner({ [KEY_ENV]: seed })!;
  it("has exactly the 16 fields, a <= 24 h life, and its signature verifies over the canonical JSON with the signer's public key", () => {
    const rec = buildRecord({ release: RELEASE, channel: "stable", device: DEVICE, signer, nowMs: Date.parse("2026-10-12T10:00:00.000Z") });
    expect(Object.keys(rec).sort()).toEqual([...RECORD_FIELDS].sort());
    expect(Object.keys(rec)).toHaveLength(16);
    expect(rec).toMatchObject({ v: 1, version: "0.1.37", channel: "stable", pkg_url: RELEASE.blob_url, pkg_sha256: RELEASE.sha256, pkg_size: 94371840, device_id: DEVICE.device_id, machine: "EXAMPLE-MAC", key_id: "fk1", device_cohorts: [] });
    expect(Date.parse(rec.expires_at) - Date.parse(rec.issued_at)).toBe(RECORD_TTL_MS);
    expect(RECORD_TTL_MS).toBeLessThanOrEqual(24 * 3600 * 1000);
    const sig = signRecord(rec, signer);
    expect(sig).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    expect(verifies(rec, sig, signer.publicKeyB64)).toBe(true);
    expect(verifies({ ...rec, machine: "OTHER" }, sig, signer.publicKeyB64)).toBe(false);
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    expect(verifies(rec, sig, other)).toBe(false);
  });
  it("a fresh nonce each time", () => {
    const a = buildRecord({ release: RELEASE, channel: "stable", device: DEVICE, signer });
    const b = buildRecord({ release: RELEASE, channel: "stable", device: DEVICE, signer });
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe("GET /api/room-recorder/release — the record rides beside the old four fields", () => {
  const saved = process.env[KEY_ENV];
  const savedId = process.env.FLEET_COMMAND_SIGNING_KEY_ID;
  const release = { id: "rel_1", version: "0.1.37", build_sha: "abc1234", sha256: "a".repeat(64), size_bytes: 94371840, blob_url: RELEASE.blob_url, channel: "stable", published_at: "2026-10-12T10:00:00.000Z", published_by: "op", withdrawn_at: null, notes: null, min_macos: "15.0", platform: "macos" };
  const get = async () => {
    const { GET } = await import("@/app/api/room-recorder/release/route");
    const res = await GET({ nextUrl: new URL("https://www.evenscribe.app/api/room-recorder/release") } as never);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  beforeEach(() => { calls.length = 0; responses = []; delete process.env.FLEET_COMMAND_SIGNING_KEY_ID; vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { if (saved === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = saved; if (savedId !== undefined) process.env.FLEET_COMMAND_SIGNING_KEY_ID = savedId; vi.restoreAllMocks(); });

  it("DARK: the signing key unset -> the old four fields only, 200, one closed reason logged, no device lookup", async () => {
    delete process.env[KEY_ENV];
    responses = [[release]];
    const out = await get();
    expect(out.status).toBe(200);
    expect(Object.keys(out.json).sort()).toEqual(["blob_url", "sha256", "size_bytes", "version"]);
    expect(calls.some((c) => c.includes("fleet_devices"))).toBe(false);
    expect(console.warn).toHaveBeenCalledWith("[room-recorder-release] no signed record: signing_key_unset");
  });
  it("key set + an active device: the four fields AND record + record_signature that verifies", async () => {
    process.env[KEY_ENV] = seed;
    responses = [[release], [DEVICE]];
    const out = await get();
    expect(out.status).toBe(200);
    expect(Object.keys(out.json).sort()).toEqual(["blob_url", "record", "record_signature", "sha256", "size_bytes", "version"]);
    expect(Object.keys(out.json.record as object)).toHaveLength(16);
    expect(verifies(out.json.record as object, out.json.record_signature as string, pubOf(seed))).toBe(true);
    expect(out.json.version).toBe("0.1.37");
  });
  it("no device for the room, or a device lookup fault: still 200 with the old four fields, a closed reason logged", async () => {
    process.env[KEY_ENV] = seed;
    responses = [[release], []];
    expect(Object.keys((await get()).json)).toHaveLength(4);
    expect(console.warn).toHaveBeenCalledWith("[room-recorder-release] no signed record: no_device");
    responses = [[release], new Error("boom")];
    const out = await get();
    expect(out.status).toBe(200);
    expect(Object.keys(out.json)).toHaveLength(4);
    expect(console.warn).toHaveBeenCalledWith("[room-recorder-release] no signed record: device_lookup_failed");
  });
  it("an unusable key id behaves as unset (dark), never a 500", async () => {
    process.env[KEY_ENV] = seed;
    process.env.FLEET_COMMAND_SIGNING_KEY_ID = "fk9";
    responses = [[release]];
    const out = await get();
    expect(out.status).toBe(200);
    expect(Object.keys(out.json)).toHaveLength(4);
  });
});
