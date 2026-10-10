/**
 * TS-H4 (#41): envelope v2, the canonical JSON, the closed catalogue, the approval rule and the REFERENCE VERIFIER (every check, in order), plus the cross-language vectors
 * in docs/fleet/PROTOCOL.md. Pure; no database. The vector key is a FIXED FAKE seed (0x0b x 32), never a credential.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { canonicalJson } from "@/lib/fleet/canonical";
import { CATALOGUE, FLEET_VERBS, inClinicHours, isFleetVerb, needsApprovalAlways, paramsValid } from "@/lib/fleet/verbs";
import { approvalProblem, buildSignedEnvelope, envelopeShapeOk, publicKeysOf, verifyEnvelope, type Envelope, type VerifyCtx } from "@/lib/fleet/envelope";
import { loadSigner, signEnvelope, signingBytes, verifyEnvelopeSignature, type Signer, type UnsignedEnvelope } from "@/lib/fleet/signing";

const V = {
  "seed_hex": "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b",
  "public_key_b64": "Zr5+Myx6RTMyvZ0Kf32wVfXF7xoGraZtmLOftoEMRzo=",
  "a": {
    "env": {
      "v": 2,
      "cmd_id": "cmd_00000000000000000001",
      "device_id": "dev_000000000000000000000001",
      "machine": "EXAMPLE-MAC",
      "verb": "collect_diag",
      "params": {
        "scope": "audio",
        "log_lines": 200
      },
      "issued_at": "2026-10-10T07:00:00.000Z",
      "expires_at": "2026-10-10T07:05:00.000Z",
      "nonce": "AAECAwQFBgcICQoLDA0ODw==",
      "issuer": {
        "kind": "operator",
        "id": "op_example"
      },
      "approval_ref": null,
      "key_id": "fk1"
    },
    "canonical": "{\"approval_ref\":null,\"cmd_id\":\"cmd_00000000000000000001\",\"device_id\":\"dev_000000000000000000000001\",\"expires_at\":\"2026-10-10T07:05:00.000Z\",\"issued_at\":\"2026-10-10T07:00:00.000Z\",\"issuer\":{\"id\":\"op_example\",\"kind\":\"operator\"},\"key_id\":\"fk1\",\"machine\":\"EXAMPLE-MAC\",\"nonce\":\"AAECAwQFBgcICQoLDA0ODw==\",\"params\":{\"log_lines\":200,\"scope\":\"audio\"},\"v\":2,\"verb\":\"collect_diag\"}",
    "signature": "rvpslFmkoahEZ7Mng3sQodi3DMeNwysqjwzx0KUk62hODq+SeDJYH/lKo68Kxpyd0rZuYtunCSlhuCaga7+aAQ=="
  },
  "b": {
    "env": {
      "v": 2,
      "cmd_id": "cmd_00000000000000000002",
      "device_id": "dev_000000000000000000000001",
      "machine": "EXAMPLE-MAC",
      "verb": "restart_recorder",
      "params": {
        "force": true
      },
      "issued_at": "2026-10-10T07:10:00.000Z",
      "expires_at": "2026-10-10T07:15:00.000Z",
      "nonce": "EBESExQVFhcYGRobHB0eHw==",
      "issuer": {
        "kind": "operator",
        "id": "op_example"
      },
      "approval_ref": "go_example1",
      "key_id": "fk1"
    },
    "canonical": "{\"approval_ref\":\"go_example1\",\"cmd_id\":\"cmd_00000000000000000002\",\"device_id\":\"dev_000000000000000000000001\",\"expires_at\":\"2026-10-10T07:15:00.000Z\",\"issued_at\":\"2026-10-10T07:10:00.000Z\",\"issuer\":{\"id\":\"op_example\",\"kind\":\"operator\"},\"key_id\":\"fk1\",\"machine\":\"EXAMPLE-MAC\",\"nonce\":\"EBESExQVFhcYGRobHB0eHw==\",\"params\":{\"force\":true},\"v\":2,\"verb\":\"restart_recorder\"}",
    "signature": "5OGLMDD9y38GH6MO0eX4Y+dFqVGYqrFm7Ya3uClkmq1ChctvKmaWOUT/CP+IPubuC41cQKItO55iMhLCNwinDg=="
  }
} as const;
const NOW = Date.parse("2026-10-10T07:02:00.000Z");
const DEVICE = "dev_000000000000000000000001";

const pkcs8 = (seed: number) => Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, seed)]).toString("base64");
const SIGNER = loadSigner({ FLEET_COMMAND_SIGNING_KEY: pkcs8(11), FLEET_COMMAND_SIGNING_KEY_ID: "fk1" })!;
const OTHER = loadSigner({ FLEET_COMMAND_SIGNING_KEY: pkcs8(12), FLEET_COMMAND_SIGNING_KEY_ID: "fk1" })!;

const make = (over: Partial<UnsignedEnvelope> = {}, signer: Signer = SIGNER): Envelope => {
  const base = buildSignedEnvelope({ device_id: DEVICE, machine: "EXAMPLE-MAC", verb: "helper_status", params: {}, issuer: { kind: "operator", id: "op_x" }, approval_ref: null, ttl_s: 300, nowMs: NOW - 1000 }, signer);
  const { signature, ...u } = { ...base, ...over };
  void signature;
  return { ...u, signature: signEnvelope(u, signer) };
};
const ctx = (over: Partial<VerifyCtx> = {}): VerifyCtx => ({ publicKeys: publicKeysOf(SIGNER), nowMs: NOW, nonceSeen: () => false, deviceId: DEVICE, machine: "EXAMPLE-MAC", ...over });

describe("canonical JSON", () => {
  it("sorts keys at every depth, no whitespace, integers only", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: "x" } })).toBe('{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
  });
  it("refuses floats, -0, unsafe integers, integer-like or upper-case keys, lone surrogates, undefined", () => {
    for (const bad of [{ a: 1.5 }, { a: -0 }, { a: 2 ** 60 }, { "1": 1 }, { A: 1 }, { "a-b": 1 }, { a: "\ud800" }, { a: undefined }, { a: NaN }]) expect(() => canonicalJson(bad), JSON.stringify(bad)).toThrow();
  });
  it("escapes like JSON.stringify: control characters as \\u00xx / short forms, non-ASCII and U+2028 literal", () => {
    expect(canonicalJson({ a: 'q"\\\n\t\u0001é\u2028' })).toBe('{"a":"q\\"\\\\\\n\\t\\u0001é\u2028"}');
  });
});

describe("the closed catalogue", () => {
  it("is exactly 13 verbs: 3 diagnose, 5 helper, 5 app; 4 are privileged", () => {
    expect(FLEET_VERBS).toHaveLength(13);
    const by = (g: string) => FLEET_VERBS.filter((v) => CATALOGUE[v].group === g).sort();
    expect(by("diagnose")).toEqual(["collect_diag", "helper_status", "report_diag"]);
    expect(by("helper")).toEqual(["coreaudiod_reset", "reload_launchagent", "restart_recorder", "usb_reseat", "wake"]);
    expect(by("app")).toEqual(["list_audio_inputs", "pieces_inventory", "pieces_reupload", "select_audio_input", "self_test"]);
    expect(FLEET_VERBS.filter((v) => CATALOGUE[v].privileged).sort()).toEqual(["coreaudiod_reset", "reload_launchagent", "restart_recorder", "usb_reseat"]);
    expect(FLEET_VERBS.filter((v) => CATALOGUE[v].group === "diagnose").every((v) => CATALOGUE[v].readOnly)).toBe(true);
  });
  it("allow-list: shell-shaped names and near misses are not verbs", () => {
    for (const bad of ["bash", "sh", "exec", "shell", "run", "sudo", "pmset_enforce", "schedule_poweron", "update_bundle", "breakglass_enable", "chrome_relaunch", "rotate_identity", "helper_status ", "HELPER_STATUS", "__proto__", "constructor", "toString", "", null, 7]) expect(isFleetVerb(bad), String(bad)).toBe(false);
    for (const v of FLEET_VERBS) expect(isFleetVerb(v)).toBe(true);
  });
  it("params are CLOSED per verb: unknown keys, wrong types, out-of-range values are refused", () => {
    const ok: Array<[string, unknown]> = [["helper_status", {}], ["collect_diag", { scope: "chrome" }], ["collect_diag", { scope: "power", log_lines: 500 }], ["select_audio_input", { device_uid: "BuiltInMic", input_volume_pct: 80 }],
      ["self_test", {}], ["self_test", { volume_pct: 0 }], ["usb_reseat", { port: "1-2" }], ["restart_recorder", { force: true }], ["pieces_inventory", { since: "2026-10-10T00:00:00.000Z" }], ["wake", {}]];
    for (const [v, p] of ok) expect(paramsValid(v, p), `${v} ${JSON.stringify(p)}`).toBe(true);
    const bad: Array<[string, unknown]> = [["helper_status", { x: 1 }], ["wake", { cmd: "ls" }], ["collect_diag", {}], ["collect_diag", { scope: "all" }], ["collect_diag", { scope: "audio", log_lines: 501 }],
      ["collect_diag", { scope: "audio", log_lines: 1.5 }], ["collect_diag", { scope: "audio", path: "/etc" }], ["select_audio_input", {}], ["select_audio_input", { device_uid: "" }], ["select_audio_input", { device_uid: "u".repeat(129) }], ["select_audio_input", { device_uid: "a\u0000b" }], ["select_audio_input", { device_uid: "a", input_volume_pct: 101 }],
      ["select_audio_input", { device_uid: "a", input_volume: 0.5 }], ["restart_recorder", { force: "yes" }], ["pieces_reupload", { since: "yesterday" }], ["usb_reseat", { port: "x".repeat(33) }], ["helper_status", null], ["helper_status", []], ["nope", {}]];
    for (const [v, p] of bad) expect(paramsValid(v, p), `${v} ${JSON.stringify(p)}`).toBe(false);
  });
});

describe("approval rule and clinic hours (IST 07:30 inclusive to 21:30 exclusive)", () => {
  const ist = (hhmm: string) => Date.parse(`2026-10-10T${hhmm}:00+05:30`);
  it("boundaries", () => {
    expect(inClinicHours(ist("07:29"))).toBe(false);
    expect(inClinicHours(ist("07:30"))).toBe(true);
    expect(inClinicHours(ist("21:29"))).toBe(true);
    expect(inClinicHours(ist("21:30"))).toBe(false);
  });
  it("a privileged verb in clinic hours needs approval_ref; outside hours it does not; force always does; read-only never does", () => {
    expect(approvalProblem("coreaudiod_reset", {}, null, ist("10:00"))).toBe("approval_required");
    expect(approvalProblem("coreaudiod_reset", {}, "go_abc", ist("10:00"))).toBeNull();
    expect(approvalProblem("coreaudiod_reset", {}, null, ist("22:00"))).toBeNull();
    expect(approvalProblem("restart_recorder", { force: true }, null, ist("22:00"))).toBe("approval_required");
    expect(needsApprovalAlways("restart_recorder", { force: true })).toBe(true);
    expect(approvalProblem("helper_status", {}, null, ist("10:00"))).toBeNull();
    expect(approvalProblem("wake", {}, null, ist("10:00"))).toBeNull();
    expect(approvalProblem("wake", {}, "no spaces allowed", ist("10:00"))).toBe("bad_approval_ref");
  });
});

describe("the reference verifier: every check, in order", () => {
  it("accepts a genuine envelope", () => expect(verifyEnvelope(make(), ctx())).toEqual({ ok: true }));

  it("1 malformed: missing field, extra field, wrong type, odd nonce, bad issuer kind, unsigned (no signature)", () => {
    const e = make();
    const { signature, ...unsigned } = e;
    void signature;
    for (const bad of [unsigned, { ...e, extra: 1 }, { ...e, v: 1 }, { ...e, nonce: "short" }, { ...e, issuer: { kind: "root", id: "x" } }, { ...e, params: [] }, { ...e, approval_ref: "has space" }, null, "str", 5]) {
      expect(verifyEnvelope(bad, ctx())).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("2 bad_signature: tampered field, forged by another key, unknown key id, garbage signature, signature of a different envelope", () => {
    const e = make();
    expect(verifyEnvelope({ ...e, verb: "wake" }, ctx())).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyEnvelope({ ...e, machine: "OTHER-MAC" }, ctx())).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyEnvelope({ ...e, params: { x: 1 } }, ctx())).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyEnvelope(make({}, OTHER), ctx())).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyEnvelope(make({ key_id: "fk2" }), ctx())).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyEnvelope({ ...e, signature: "A".repeat(86) + "==" }, ctx())).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyEnvelope({ ...e, signature: make({ cmd_id: "cmd_other" }).signature }, ctx())).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyEnvelope(e, ctx({ publicKeys: {} }))).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("3 expired: past, ttl over 900 s, issued more than 120 s in the future; and the 120 s skew edge is accepted", () => {
    expect(verifyEnvelope(make({ issued_at: "2026-10-10T06:00:00.000Z", expires_at: "2026-10-10T06:05:00.000Z" }), ctx())).toEqual({ ok: false, reason: "expired" });
    expect(verifyEnvelope(make({ issued_at: "2026-10-10T07:00:00.000Z", expires_at: "2026-10-10T07:15:00.001Z" }), ctx())).toEqual({ ok: false, reason: "expired" });
    expect(verifyEnvelope(make({ issued_at: "2026-10-10T07:00:00.000Z", expires_at: "2026-10-10T07:15:00.000Z" }), ctx({ nowMs: Date.parse("2026-10-10T07:00:00.000Z") }))).toEqual({ ok: true });
    expect(verifyEnvelope(make({ issued_at: "2026-10-10T07:04:01.000Z", expires_at: "2026-10-10T07:09:00.000Z" }), ctx())).toEqual({ ok: false, reason: "expired" });
    expect(verifyEnvelope(make({ issued_at: "2026-10-10T07:04:00.000Z", expires_at: "2026-10-10T07:09:00.000Z" }), ctx())).toEqual({ ok: true });
    const e = make();
    expect(verifyEnvelope(e, ctx({ nowMs: Date.parse(e.expires_at) }))).toEqual({ ok: true }); // the expiry instant itself is still inside
    expect(verifyEnvelope(e, ctx({ nowMs: Date.parse(e.expires_at) + 1 }))).toMatchObject({ reason: "expired" });
  });

  it("4 replay, 5 machine_mismatch (device and machine), 6 verb_not_allowed (signed but not catalogued), 7 bad_params (signed, closed-schema violation)", () => {
    expect(verifyEnvelope(make(), ctx({ nonceSeen: () => true }))).toEqual({ ok: false, reason: "replay" });
    expect(verifyEnvelope(make(), ctx({ deviceId: "dev_000000000000000000000002" }))).toEqual({ ok: false, reason: "machine_mismatch" });
    expect(verifyEnvelope(make(), ctx({ machine: "ANOTHER-MAC" }))).toEqual({ ok: false, reason: "machine_mismatch" });
    expect(verifyEnvelope(make(), ctx({ machine: "example-mac" }))).toEqual({ ok: false, reason: "machine_mismatch" });
    expect(verifyEnvelope(make({ verb: "bash" }), ctx())).toEqual({ ok: false, reason: "verb_not_allowed" });
    expect(verifyEnvelope(make({ verb: "collect_diag", params: { scope: "all" } }), ctx())).toEqual({ ok: false, reason: "bad_params" });
    expect(verifyEnvelope(make({ verb: "wake", params: { cmd: "ls" } }), ctx())).toEqual({ ok: false, reason: "bad_params" });
  });

  it("8 local gates, 9 rate_limited, 10 kill_switch, in that order", () => {
    expect(verifyEnvelope(make(), ctx({ localGate: () => "session_open", rateOk: () => false, killSwitch: true }))).toEqual({ ok: false, reason: "session_open" });
    expect(verifyEnvelope(make(), ctx({ rateOk: () => false, killSwitch: true }))).toEqual({ ok: false, reason: "rate_limited" });
    expect(verifyEnvelope(make(), ctx({ killSwitch: true }))).toEqual({ ok: false, reason: "kill_switch" });
  });

  it("ORDER: bad_signature beats expired beats replay beats machine_mismatch beats verb_not_allowed", () => {
    const old = { issued_at: "2026-10-10T06:00:00.000Z", expires_at: "2026-10-10T06:05:00.000Z" };
    expect(verifyEnvelope({ ...make(old), verb: "wake" }, ctx({ nonceSeen: () => true }))).toMatchObject({ reason: "bad_signature" });
    expect(verifyEnvelope(make(old), ctx({ nonceSeen: () => true, machine: "X" }))).toMatchObject({ reason: "expired" });
    expect(verifyEnvelope(make(), ctx({ nonceSeen: () => true, machine: "X" }))).toMatchObject({ reason: "replay" });
    expect(verifyEnvelope(make({ verb: "bash" }), ctx({ machine: "X" }))).toMatchObject({ reason: "machine_mismatch" });
    expect(verifyEnvelope(make({ verb: "bash", params: { a: 1 } }), ctx())).toMatchObject({ reason: "verb_not_allowed" });
  });

  it("M3: a NON-CANONICAL base64 signature (same 64 bytes, different trailing bits) is refused", () => {
    const e = make();
    const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const last = e.signature[85]!;
    const twin = B64[B64.indexOf(last) ^ 1]!; // differs only in the 4 unused low bits before "=="
    const forged = e.signature.slice(0, 85) + twin + "==";
    expect(Buffer.from(forged, "base64").equals(Buffer.from(e.signature, "base64"))).toBe(true); // same bytes
    expect(forged).not.toBe(e.signature);
    expect(verifyEnvelope({ ...e, signature: forged }, ctx())).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("an envelope with a float in params can carry no valid signature (refused, not rounded)", () => {
    const e = make();
    expect(verifyEnvelope({ ...e, params: { x: 1.5 } }, ctx())).toEqual({ ok: false, reason: "bad_signature" });
    expect(() => signEnvelope({ ...e, params: { x: 1.5 } } as never, SIGNER)).toThrow();
  });
});

describe("signing key from the environment", () => {
  it("no key, an unknown key id, a non-Ed25519 key or junk gives no signer; the value is never echoed", () => {
    expect(loadSigner({})).toBeNull();
    expect(loadSigner({ FLEET_COMMAND_SIGNING_KEY: pkcs8(1), FLEET_COMMAND_SIGNING_KEY_ID: "fk9" })).toBeNull();
    expect(loadSigner({ FLEET_COMMAND_SIGNING_KEY: "not base64 at all !!" })).toBeNull();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    expect(loadSigner({ FLEET_COMMAND_SIGNING_KEY: rsa })).toBeNull();
    expect(loadSigner({ FLEET_COMMAND_SIGNING_KEY: pkcs8(3) })?.keyId).toBe("fk1");
    expect(loadSigner({ FLEET_COMMAND_SIGNING_KEY: pkcs8(3), FLEET_COMMAND_SIGNING_KEY_ID: "fk2" })?.keyId).toBe("fk2");
  });
  it("the repo holds no signing key: .env.example names the variable with an EMPTY value", () => {
    const ex = readFileSync(".env.example", "utf8");
    expect(ex).toMatch(/^FLEET_COMMAND_SIGNING_KEY=$/m);
    expect(ex).toMatch(/^FLEET_COMMAND_SIGNING_KEY_ID=fk1$/m);
    expect(createPrivateKey).toBeDefined();
  });
});

describe("cross-language vectors (docs/fleet/PROTOCOL.md section 8)", () => {
  it("the independent node script and this library agree on the canonical bytes and the signature", () => {
    for (const x of [V.a, V.b]) {
      const { env } = x;
      expect(canonicalJson(env)).toBe(x.canonical);
      expect(Buffer.from(signingBytes(env as never)).toString("utf8")).toBe(x.canonical);
      expect(verifyEnvelopeSignature(env as never, x.signature, V.public_key_b64)).toBe(true);
      expect(envelopeShapeOk({ ...env, signature: x.signature })).toBe(true);
    }
    const signer = loadSigner({ FLEET_COMMAND_SIGNING_KEY: pkcs8(11) })!;
    expect(signer.publicKeyB64).toBe(V.public_key_b64);
    expect(signEnvelope(V.a.env as never, signer)).toBe(V.a.signature); // Ed25519 is deterministic
  });
  it("vector B is a forced restart with an approval_ref and verifies through the reference verifier", () => {
    const r = verifyEnvelope({ ...V.b.env, signature: V.b.signature }, ctx({ publicKeys: { fk1: V.public_key_b64 }, nowMs: Date.parse("2026-10-10T07:11:00.000Z"), machine: "EXAMPLE-MAC" }));
    expect(r).toEqual({ ok: true });
  });
  it("the document carries exactly these vectors", () => {
    const doc = readFileSync("docs/fleet/PROTOCOL.md", "utf8");
    for (const s of [V.public_key_b64, V.a.canonical, V.a.signature, V.b.signature]) expect(doc, s.slice(0, 30)).toContain(s);
  });
});
