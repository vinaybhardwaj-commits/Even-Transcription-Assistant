/**
 * TS-H8 (#45): the signed release record. Pure. The vector is made by an INDEPENDENT node script (plain crypto, sorted-key JSON.stringify) with the fixed FAKE seed 0x0b x 32
 * (key id fk1, the same key as the envelope vectors in docs/fleet/PROTOCOL.md); the record shape and checks mirror the app's ReleaseRecord.parse / ReleaseVerifier.verify
 * (apps/room-recorder, branch gating/rr-0137). The Swift tests there sign with a throw-away key and publish no record bytes, so THIS vector is the byte-for-byte one to adopt.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { canonicalJson } from "@/lib/fleet/canonical";
import { loadSigner } from "@/lib/fleet/signing";
import {
  COHORT_NAMES, RECORD_FIELDS, bucketOf, buildRecord, eligible, parseRecord, rolloutProblem, signRecord, validPkgUrl, verifyRecord, type ReleaseRecord, type RolloutRow,
} from "@/lib/fleet/release";

const V = {
  "record": {
    "v": 1,
    "version": "0.1.37",
    "channel": "stable",
    "pkg_url": "https://www.evenscribe.app/dl/room-recorder-0.1.37.pkg",
    "pkg_sha256": "abababababababababababababababababababababababababababababababab",
    "pkg_size": 123456789,
    "min_helper": "0.2.0",
    "cohort": "pct",
    "rollout_pct": 50,
    "device_cohorts": [
      "audiometry",
      "home_office"
    ],
    "device_id": "dev_000000000000000000000001",
    "machine": "EXAMPLE-MAC",
    "issued_at": "2026-10-11T10:00:00.000Z",
    "expires_at": "2026-10-11T11:00:00.000Z",
    "nonce": "AAECAwQFBgcICQoLDA0ODw==",
    "key_id": "fk1"
  },
  "canonical": "{\"channel\":\"stable\",\"cohort\":\"pct\",\"device_cohorts\":[\"audiometry\",\"home_office\"],\"device_id\":\"dev_000000000000000000000001\",\"expires_at\":\"2026-10-11T11:00:00.000Z\",\"issued_at\":\"2026-10-11T10:00:00.000Z\",\"key_id\":\"fk1\",\"machine\":\"EXAMPLE-MAC\",\"min_helper\":\"0.2.0\",\"nonce\":\"AAECAwQFBgcICQoLDA0ODw==\",\"pkg_sha256\":\"abababababababababababababababababababababababababababababababab\",\"pkg_size\":123456789,\"pkg_url\":\"https://www.evenscribe.app/dl/room-recorder-0.1.37.pkg\",\"rollout_pct\":50,\"v\":1,\"version\":\"0.1.37\"}",
  "signature": "PyQlGaM2bOoJqraj93geRAdu67DdscrsOQGF7ZntnMiT2x0a0LsQJlZVgEf0d7XzpXmN33tStc7cyTnmMM8vCw==",
  "public_key_b64": "Zr5+Myx6RTMyvZ0Kf32wVfXF7xoGraZtmLOftoEMRzo=",
  "buckets": {
    "dev_000000000000000000000001|0.1.37": 48,
    "dev_000000000000000000000002|0.1.37": 44,
    "dev_0123456789abcdef01234567|0.1.37": 83,
    "dev_000000000000000000000001|0.1.38": 7
  }
} as const;
const SIGNER = loadSigner({ FLEET_COMMAND_SIGNING_KEY: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 11)]).toString("base64") })!;
const KEYS = { fk1: V.public_key_b64 };
const NOW = Date.parse("2026-10-11T10:30:00.000Z");
const DEV = "dev_000000000000000000000001";

describe("the byte-for-byte vector", () => {
  it("the independent script and the library agree on the canonical bytes and the signature (Ed25519 is deterministic)", () => {
    expect(SIGNER.publicKeyB64).toBe(V.public_key_b64);
    expect(canonicalJson(V.record)).toBe(V.canonical);
    expect(signRecord(V.record as unknown as ReleaseRecord, SIGNER)).toBe(V.signature);
  });
  it("the app's checks accept it (inside its window, for its own device and machine) and it is exactly sixteen fields", () => {
    expect(Object.keys(V.record).sort()).toEqual([...RECORD_FIELDS].sort());
    expect(verifyRecord(JSON.stringify(V.record), V.signature, KEYS, DEV, "EXAMPLE-MAC", NOW)).toMatchObject({ ok: true });
    // the app canonicalises whatever spacing/order it forwarded
    expect(verifyRecord(JSON.stringify(V.record, null, 2), V.signature, KEYS, DEV, "EXAMPLE-MAC", NOW)).toMatchObject({ ok: true });
  });
  it("the vector is in docs/fleet/PROTOCOL.md", () => {
    const doc = readFileSync("docs/fleet/PROTOCOL.md", "utf8");
    for (const s of [V.canonical, V.signature]) expect(doc).toContain(s);
  });
});

describe("bucket and eligibility (the app's rules, stated so the server computes the same number)", () => {
  it("bucket = first 4 bytes of SHA-256(\"<device_id>|<version>\") big-endian, modulo 100", () => {
    for (const [k, b] of Object.entries(V.buckets)) {
      const [d, ver] = k.split("|") as [string, string];
      expect(bucketOf(d, ver), k).toBe(b);
    }
  });
  const rec = (o: Partial<ReleaseRecord>) => ({ ...(V.record as unknown as ReleaseRecord), ...o });
  it("all is everyone; a named cohort is its members; pct is bucket < rollout_pct (48 -> 49% no... 48 < 49 yes, 48 < 48 no)", () => {
    expect(eligible(rec({ cohort: "all", rollout_pct: 100, device_cohorts: [] }))).toBe(true);
    expect(eligible(rec({ cohort: "home_office", device_cohorts: ["home_office"] }))).toBe(true);
    expect(eligible(rec({ cohort: "home_office", device_cohorts: ["opd1"] }))).toBe(false);
    expect(eligible(rec({ cohort: "audiometry", device_cohorts: [] }))).toBe(false);
    expect(eligible(rec({ cohort: "pct", rollout_pct: 49 }))).toBe(true);
    expect(eligible(rec({ cohort: "pct", rollout_pct: 48 }))).toBe(false);
    expect(eligible(rec({ cohort: "pct", rollout_pct: 0 }))).toBe(false);
    expect(eligible(rec({ cohort: "pct", rollout_pct: 100 }))).toBe(true);
  });
});

describe("pkg_url (mirror of ReleaseRecord.validatedURL — the app's own cases)", () => {
  it("accepts our host and the blob store suffix", () => {
    expect(validPkgUrl("https://www.evenscribe.app/dl/room-recorder-0.1.37.pkg")).toBe(true);
    expect(validPkgUrl("https://evenscribe.app/x.pkg")).toBe(true);
    expect(validPkgUrl("https://abc123.public.blob.vercel-storage.com/room-recorder.pkg")).toBe(true);
  });
  it("refuses http, other hosts, look-alikes, credentials, ports, fragments, spaces, non-ASCII, over 512", () => {
    for (const bad of ["http://www.evenscribe.app/x.pkg", "https://evil.example/x.pkg", "https://abc.public.blob.vercel-storage.com.evil.example/x.pkg", "https://notevenscribe.app/x.pkg",
      "https://user:pw@www.evenscribe.app/x.pkg", "https://www.evenscribe.app:8443/x.pkg", "https://www.evenscribe.app/x.pkg#frag", "https://www.evenscribe.app/x y.pkg", "https://www.evenscribe.app/é.pkg",
      `https://www.evenscribe.app/${"a".repeat(500)}`, "", 5, null]) expect(validPkgUrl(bad), String(bad)).toBe(false);
  });
});

describe("parseRecord (mirror of ReleaseRecord.parse): exactly the sixteen fields, each in bounds", () => {
  const good = () => structuredClone(V.record) as Record<string, unknown>;
  it("accepts the vector", () => expect(parseRecord(good())).not.toBeNull());
  it("refuses an extra or a missing field, a wrong type, and every out-of-bounds value", () => {
    const mut = (f: (o: Record<string, unknown>) => void) => { const o = good(); f(o); return parseRecord(o); };
    expect(mut((o) => { o.extra = 1; })).toBeNull();
    for (const k of RECORD_FIELDS) expect(mut((o) => { delete o[k]; }), `missing ${k}`).toBeNull();
    const bad: Array<[string, unknown]> = [["v", 2], ["version", "abc"], ["version", "1"], ["channel", "beta"], ["pkg_sha256", "A".repeat(64)], ["pkg_sha256", "a".repeat(63)], ["pkg_size", 0], ["pkg_size", 400 * 1024 * 1024 + 1],
      ["pkg_size", 1.5], ["min_helper", "x"], ["cohort", "everyone"], ["rollout_pct", 101], ["rollout_pct", -1], ["rollout_pct", 50.5], ["device_cohorts", ["nope"]], ["device_cohorts", Array(9).fill("all")],
      ["device_cohorts", "all"], ["device_id", "dev_XYZ"], ["machine", ""], ["machine", "x".repeat(129)], ["machine", "a\nb"], ["issued_at", "2026-10-11T10:00:00Z"], ["nonce", "short"], ["nonce", "x".repeat(65)], ["key_id", "FK1"], ["key_id", "fk123456789"]];
    for (const [k, val] of bad) expect(mut((o) => { o[k] = val; }), `${k}=${JSON.stringify(val)}`).toBeNull();
    expect(parseRecord(null)).toBeNull();
    expect(parseRecord([])).toBeNull();
  });
});

describe("verifyRecord (mirror of ReleaseVerifier.verify): malformed -> bad signature -> expired -> wrong device, first failure wins", () => {
  const json = JSON.stringify(V.record);
  const verify = (over: { json?: string; sig?: string | null; keys?: Record<string, string>; dev?: string; machine?: string; now?: number } = {}) =>
    verifyRecord(over.json ?? json, over.sig === undefined ? V.signature : over.sig, over.keys ?? KEYS, over.dev ?? DEV, over.machine ?? "EXAMPLE-MAC", over.now ?? NOW);
  it("each refusal is named", () => {
    expect(verify({ json: "{not json" })).toEqual({ ok: false, reason: "record_malformed" });
    expect(verify({ json: JSON.stringify({ ...V.record, extra: 1 }) })).toEqual({ ok: false, reason: "record_malformed" });
    expect(verify({ json: JSON.stringify({ ...V.record, pkg_sha256: "c".repeat(64) }) })).toEqual({ ok: false, reason: "record_bad_signature" }); // tampered after signing
    expect(verify({ sig: null })).toEqual({ ok: false, reason: "record_bad_signature" }); // UNSIGNED (no signer configured): the app never offers it
    expect(verify({ keys: {} })).toEqual({ ok: false, reason: "record_bad_signature" });
    expect(verify({ now: Date.parse("2026-10-11T11:00:00.001Z") })).toEqual({ ok: false, reason: "record_expired" });
    expect(verify({ now: Date.parse("2026-10-11T09:57:59.000Z") })).toEqual({ ok: false, reason: "record_expired" });
    expect(verify({ dev: "dev_00000000000000000000000b" })).toEqual({ ok: false, reason: "record_wrong_device" });
    expect(verify({ machine: "another-mac" })).toEqual({ ok: false, reason: "record_wrong_device" });
  });
  it("the window edges: 120 s early is inside, the expiry instant is inside", () => {
    expect(verify({ now: Date.parse("2026-10-11T09:58:00.000Z") })).toMatchObject({ ok: true });
    expect(verify({ now: Date.parse("2026-10-11T11:00:00.000Z") })).toMatchObject({ ok: true });
  });
});

describe("buildRecord", () => {
  const roll: RolloutRow = { version: "0.1.37", channel: "stable", pkg_url: "https://www.evenscribe.app/dl/room-recorder-0.1.37.pkg", pkg_sha256: "ab".repeat(32), pkg_size: 1000, min_helper: "0.2.0", cohort: "opd1", rollout_pct: 0 };
  it("builds a record the app's parser accepts, with a 1 h window, sorted device cohorts and a fresh nonce each time", () => {
    const a = buildRecord(roll, { device_id: DEV, machine: "M" }, ["opd1", "audiometry"], "fk1", NOW)!;
    const b = buildRecord(roll, { device_id: DEV, machine: "M" }, ["opd1", "audiometry"], "fk1", NOW)!;
    expect(a.device_cohorts).toEqual(["audiometry", "opd1"]);
    expect(Date.parse(a.expires_at) - Date.parse(a.issued_at)).toBe(3_600_000);
    expect(a.nonce).not.toBe(b.nonce);
    expect(verifyRecord(JSON.stringify(a), signRecord(a, SIGNER), KEYS, DEV, "M", NOW)).toMatchObject({ ok: true });
  });
  it("returns null (nothing is signed) when the app would turn the record away", () => {
    expect(buildRecord({ ...roll, pkg_url: "http://www.evenscribe.app/x.pkg" }, { device_id: DEV, machine: "M" }, [], "fk1", NOW)).toBeNull();
    expect(buildRecord({ ...roll, pkg_size: 0 }, { device_id: DEV, machine: "M" }, [], "fk1", NOW)).toBeNull();
    expect(buildRecord(roll, { device_id: "dev_bad", machine: "M" }, [], "fk1", NOW)).toBeNull();
    expect(buildRecord(roll, { device_id: DEV, machine: "" }, [], "fk1", NOW)).toBeNull();
  });
  it("device cohorts outside the app's vocabulary are dropped, not signed", () => {
    expect(buildRecord(roll, { device_id: DEV, machine: "M" }, ["opd1", "everything"], "fk1", NOW)!.device_cohorts).toEqual(["opd1"]);
  });
});

describe("rolloutProblem", () => {
  const ok = { version: "0.1.37", channel: "stable", pkg_url: "https://www.evenscribe.app/x.pkg", pkg_sha256: "ab".repeat(32), pkg_size: 10, cohort: "home_office" };
  it("accepts a sane request and names every bad field", () => {
    expect(rolloutProblem(ok)).toBeNull();
    expect(rolloutProblem({ ...ok, cohort: "pct", rollout_pct: 25 })).toBeNull();
    expect(rolloutProblem({ ...ok, cohort: "all" })).toBeNull();
    const bad: Array<[Partial<typeof ok> & Record<string, unknown>, string]> = [[{ version: "x" }, "bad_version"], [{ channel: "beta" }, "bad_channel"], [{ pkg_url: "https://evil.example/x" }, "bad_pkg_url"],
      [{ pkg_sha256: "zz" }, "bad_pkg_sha256"], [{ pkg_size: 0 }, "bad_pkg_size"], [{ min_helper: "abc" }, "bad_min_helper"], [{ cohort: "nobody" }, "bad_cohort"], [{ cohort: "pct", rollout_pct: 101 }, "bad_rollout_pct"],
      [{ cohort: "all", rollout_pct: 50 }, "bad_rollout_pct"]];
    for (const [o, why] of bad) expect(rolloutProblem({ ...ok, ...o } as never), why).toBe(why);
    expect(COHORT_NAMES).toHaveLength(5);
  });
});
