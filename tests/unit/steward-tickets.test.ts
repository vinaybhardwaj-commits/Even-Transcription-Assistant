/** lib/steward/tickets.ts — canonicalisation, Ed25519 sign/verify, rejection reasons, issueTicket guards. sql is a mock; no database. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  ACTION_ALLOWLIST, KEY_RE, MAX_TTL_S, canonicalTicket, decodeSignature, issueTicket, paramsValid, signTicket, verifyTicket, type Ticket,
} from "@/lib/steward/tickets";
import { STEWARD_TICKET_KEY_ID, STEWARD_TICKET_PUBLIC_KEY_PEM } from "@/lib/steward/ticket-public-key";

const kp = generateKeyPairSync("ed25519");
const PRIV = kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const PUB = kp.publicKey.export({ type: "spki", format: "pem" }) as string;
const other = generateKeyPairSync("ed25519");
const OTHER_PUB = other.publicKey.export({ type: "spki", format: "pem" }) as string;

const NOW = Date.parse("2026-10-06T10:00:00.000Z");
const mk = (over: Partial<Ticket> = {}): Ticket => ({
  v: 1, ticket_id: "t-1", machine: "EHRC-ECHOs-Mac-mini", action: "open_pulse", params: { profile: "Default" },
  issued_at: "2026-10-06T10:00:00.000Z", expires_at: "2026-10-06T10:05:00.000Z", nonce: "bm9uY2Utbm9uY2Utbm9uY2U", ...over,
});
const V = { machine: "EHRC-ECHOs-Mac-mini", now: NOW };

describe("canonicalTicket", () => {
  it("is stable under key order, recursively, with no whitespace", () => {
    const a = { b: 1, a: { d: [3, { y: 1, x: 2 }], c: "é" } };
    const b = { a: { c: "é", d: [3, { x: 2, y: 1 }] }, b: 1 };
    expect(canonicalTicket(a)).toBe(canonicalTicket(b));
    expect(canonicalTicket(a)).toBe('{"a":{"c":"é","d":[3,{"x":2,"y":1}]},"b":1}');
  });
});

describe("params schema", () => {
  it("open_pulse / relaunch_chrome / policy_cycle take exactly { profile: 1..64 chars }; every other action takes {}", () => {
    for (const a of ["open_pulse", "relaunch_chrome", "policy_cycle"]) {
      expect(paramsValid(a, { profile: "x" })).toBe(true);
      expect(paramsValid(a, { profile: "x".repeat(64) })).toBe(true);
      expect(paramsValid(a, { profile: "x".repeat(65) })).toBe(false);
      expect(paramsValid(a, { profile: "" })).toBe(false);
      expect(paramsValid(a, {})).toBe(false);
      expect(paramsValid(a, { profile: "x", extra: 1 })).toBe(false);
      expect(paramsValid(a, { profile: 5 })).toBe(false);
    }
    for (const a of ["wake", "restart_recorder_app", "restart_kiosk_health"]) {
      expect(paramsValid(a, {})).toBe(true);
      expect(paramsValid(a, { profile: "x" })).toBe(false);
    }
    expect(paramsValid("format_disk", {})).toBe(false);
    expect(ACTION_ALLOWLIST).toEqual(["wake", "open_pulse", "relaunch_chrome", "policy_cycle", "restart_recorder_app", "restart_kiosk_health"]);
  });
});

describe("sign / verify", () => {
  it("round-trips, and the signature is standard base64 of 64 bytes", () => {
    const t = mk();
    const sig = signTicket(t, PRIV);
    expect(Buffer.from(sig, "base64")).toHaveLength(64);
    expect(verifyTicket(t, sig, PUB, V)).toEqual({ ok: true });
  });

  it("is independent of key order in the ticket the verifier holds", () => {
    const t = mk();
    const sig = signTicket(t, PRIV);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(t).reverse())));
    expect(verifyTicket(reordered, sig, PUB, V)).toEqual({ ok: true });
  });

  it("rejects a tampered field (each field), a signature from another key, and garbage", () => {
    const t = mk();
    const sig = signTicket(t, PRIV);
    const tampered: Array<Partial<Ticket>> = [
      { ticket_id: "t-2" }, { machine: "EHRC-OTHER" }, { action: "wake", params: {} }, { params: { profile: "Evil" } },
      { issued_at: "2026-10-06T09:00:00.000Z" }, { expires_at: "2026-10-06T23:00:00.000Z" }, { nonce: "AAAA" },
    ];
    for (const over of tampered) expect(verifyTicket(mk(over), sig, PUB, V)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyTicket(t, sig, OTHER_PUB, V)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyTicket(t, "not-base64!!", PUB, V)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyTicket(t, sig, "not a pem", V)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyTicket({ ...t, extra: 1 }, sig, PUB, V)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects (malformed) any object key not matching /^[a-z_][a-z0-9_]*$/, at any depth, before the signature is looked at", () => {
    const good = mk();
    const sig = signTicket(good, PRIV);
    for (const bad of [
      { ...good, params: { "1": "x" } }, { ...good, params: { "10": "x" } }, { ...good, params: { Profile: "x" } }, { ...good, params: { "a-b": 1 } },
      { ...good, params: { profile: "x", nested: { "2": 1 } } }, { ...good, "0": 1 }, { ...good, params: { "": 1 } },
    ]) {
      expect(verifyTicket(bad, signTicket(bad, PRIV), PUB, V)).toEqual({ ok: false, reason: "malformed" });
    }
    expect(KEY_RE.test("profile")).toBe(true);
    expect(KEY_RE.test("_x9")).toBe(true);
    expect(verifyTicket(good, sig, PUB, V)).toEqual({ ok: true });
  });

  it("decodes the signature strictly: standard base64, 88 chars, padded, no trailing junk; base64url is refused", () => {
    const t = mk();
    const sig = signTicket(t, PRIV);
    expect(sig).toHaveLength(88);
    expect(verifyTicket(t, sig + "!!", PUB, V)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyTicket(t, sig + "AAAA", PUB, V)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyTicket(t, sig + "\n", PUB, V)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyTicket(t, " " + sig, PUB, V)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyTicket(t, sig.slice(0, 86), PUB, V)).toEqual({ ok: false, reason: "bad_signature" }); // padding stripped
    const url = sig.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); // base64url, unpadded
    expect(verifyTicket(t, url, PUB, V)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyTicket(t, Buffer.from(sig, "base64").toString("hex"), PUB, V)).toEqual({ ok: false, reason: "bad_signature" });
    // base64url with "-" / "_" and padding kept is not standard base64 either (force those characters in with a crafted non-signature)
    expect(decodeSignature("-".repeat(86) + "==")).toBeNull();
    expect(decodeSignature(sig)).not.toBeNull();
    // non-canonical trailing bits: the last character of a 64-byte signature carries 4 data bits + 2 zero bits; setting a zero bit decodes to the SAME bytes
    const alt = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const nonCanon = sig.slice(0, 85) + alt[alt.indexOf(sig[85]!) | 1] + "==";
    expect(nonCanon).not.toBe(sig);
    expect(Buffer.from(nonCanon, "base64").equals(Buffer.from(sig, "base64"))).toBe(true);
    expect(decodeSignature(nonCanon)).toBeNull();
    expect(verifyTicket(t, nonCanon, PUB, V)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("reports the reject reasons in the documented check order", () => {
    // malformed beats bad_signature; bad_signature beats expired; expired beats action; action beats params; params beats machine
    const exp = mk({ action: "rm" as never, params: { x: 1 }, machine: "other", expires_at: "2026-10-06T09:00:00.000Z" });
    expect(verifyTicket({ ...exp, v: 2 }, signTicket(exp, PRIV), PUB, V)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyTicket(exp, "A".repeat(86) + "==", PUB, V)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyTicket(exp, signTicket(exp, PRIV), PUB, V)).toEqual({ ok: false, reason: "expired" });
    const act = { ...exp, expires_at: "2026-10-06T11:00:00.000Z" };
    expect(verifyTicket(act, signTicket(act, PRIV), PUB, V)).toEqual({ ok: false, reason: "action_not_allowed" });
    const par = { ...act, action: "wake" };
    expect(verifyTicket(par, signTicket(par, PRIV), PUB, V)).toEqual({ ok: false, reason: "bad_params" });
    const mach = { ...par, params: {} };
    expect(verifyTicket(mach, signTicket(mach, PRIV), PUB, V)).toEqual({ ok: false, reason: "machine_mismatch" });
  });

  it("rejects malformed tickets", () => {
    expect(verifyTicket(null, "x", PUB, V)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyTicket({ ...mk(), v: 2 }, "x", PUB, V)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyTicket({ ...mk(), params: null }, "x", PUB, V)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects an expired ticket (at and after expires_at), accepts one ms before", () => {
    const t = mk();
    const sig = signTicket(t, PRIV);
    expect(verifyTicket(t, sig, PUB, { ...V, now: Date.parse(t.expires_at) - 1 })).toEqual({ ok: true });
    expect(verifyTicket(t, sig, PUB, { ...V, now: Date.parse(t.expires_at) })).toEqual({ ok: false, reason: "expired" });
    expect(verifyTicket(t, sig, PUB, { ...V, now: Date.parse(t.expires_at) + 60_000 })).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a correctly signed ticket whose action is not allow-listed", () => {
    const t = mk({ action: "rm_rf" as never, params: {} });
    expect(verifyTicket(t, signTicket(t, PRIV), PUB, V)).toEqual({ ok: false, reason: "action_not_allowed" });
  });

  it("rejects correctly signed params that do not match the action's schema", () => {
    for (const t of [mk({ params: {} }), mk({ params: { profile: "x".repeat(65) } }), mk({ params: { profile: "a", x: 1 } }), mk({ action: "wake", params: { profile: "a" } })]) {
      expect(verifyTicket(t, signTicket(t, PRIV), PUB, V)).toEqual({ ok: false, reason: "bad_params" });
    }
  });

  it("rejects a correctly signed ticket for another machine", () => {
    const t = mk({ machine: "EHRC-OTHERs-Mac-mini" });
    expect(verifyTicket(t, signTicket(t, PRIV), PUB, V)).toEqual({ ok: false, reason: "machine_mismatch" });
  });

  it("accepts a private key pasted with literal \\n sequences (one-line env value)", () => {
    const t = mk();
    expect(verifyTicket(t, signTicket(t, PRIV.trim().replace(/\n/g, "\\n")), PUB, V)).toEqual({ ok: true });
  });
});

describe("committed public key", () => {
  it("key id is the first 8 hex of sha256 of the DER public key", () => {
    const der = createPublicKey(STEWARD_TICKET_PUBLIC_KEY_PEM).export({ type: "spki", format: "der" });
    expect(createHash("sha256").update(der).digest("hex").slice(0, 8)).toBe(STEWARD_TICKET_KEY_ID);
    expect(createPublicKey(STEWARD_TICKET_PUBLIC_KEY_PEM).asymmetricKeyType).toBe("ed25519");
  });
});

describe("issueTicket", () => {
  const SAVED = process.env.STEWARD_TICKET_PRIVATE_KEY;
  const sql = vi.fn();
  beforeEach(() => {
    sql.mockReset();
    sql.mockResolvedValue([{ ticket_id: "x" }]);
    delete process.env.STEWARD_TICKET_PRIVATE_KEY;
  });
  afterEach(() => {
    if (SAVED === undefined) delete process.env.STEWARD_TICKET_PRIVATE_KEY; else process.env.STEWARD_TICKET_PRIVATE_KEY = SAVED;
  });
  const base = { machine: "m1", action: "wake" as const, params: {}, decision_id: null, ttl_s: 300 };

  it("refuses ttl > 900 (and <= 0 / NaN) before touching the database", async () => {
    for (const ttl_s of [901, 3600, 0, -1, Number.NaN]) {
      await expect(issueTicket(sql as never, { ...base, ttl_s, privateKeyPem: PRIV })).rejects.toThrow(/ttl_s/);
    }
    expect(MAX_TTL_S).toBe(900);
    expect(sql).not.toHaveBeenCalled();
    await expect(issueTicket(sql as never, { ...base, ttl_s: 900, privateKeyPem: PRIV, now: NOW })).resolves.toMatchObject({ ok: true });
  });

  it("throws a clear error when STEWARD_TICKET_PRIVATE_KEY is unset or blank", async () => {
    await expect(issueTicket(sql as never, base)).rejects.toThrow(/STEWARD_TICKET_PRIVATE_KEY is not set/);
    process.env.STEWARD_TICKET_PRIVATE_KEY = "   ";
    await expect(issueTicket(sql as never, base)).rejects.toThrow(/STEWARD_TICKET_PRIVATE_KEY is not set/);
    expect(sql).not.toHaveBeenCalled();
  });

  it("rejects an action outside the allow-list, bad params and a bad machine", async () => {
    await expect(issueTicket(sql as never, { ...base, action: "reboot" as never, privateKeyPem: PRIV })).rejects.toThrow(/allow-list/);
    await expect(issueTicket(sql as never, { ...base, action: "open_pulse", params: {}, privateKeyPem: PRIV })).rejects.toThrow(/params/);
    await expect(issueTicket(sql as never, { ...base, machine: "", privateKeyPem: PRIV })).rejects.toThrow(/machine/);
    expect(sql).not.toHaveBeenCalled();
  });

  it("signs with the env key, stores status 'issued' with bound values, and the result verifies", async () => {
    process.env.STEWARD_TICKET_PRIVATE_KEY = PRIV;
    const r = await issueTicket(sql as never, { ...base, action: "policy_cycle", params: { profile: "Default" }, decision_id: 7, ttl_s: 600, now: NOW });
    if (!r.ok) throw new Error("expected ok");
    expect(r.ticket).toMatchObject({ v: 1, machine: "m1", action: "policy_cycle", params: { profile: "Default" }, issued_at: "2026-10-06T10:00:00.000Z", expires_at: "2026-10-06T10:10:00.000Z" });
    expect(r.ticket.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/); // 16 bytes, base64url, no padding
    expect(verifyTicket(r.ticket, r.signature, PUB, { machine: "m1", now: NOW })).toEqual({ ok: true });
    // statement 1 expires stale outstanding rows, statement 2 inserts; every value is a bound parameter
    const [, insert] = sql.mock.calls as Array<[string[], ...unknown[]]>;
    const text = insert![0].join("?");
    expect(text).toContain("INSERT INTO steward_tickets");
    expect(text).toContain("'issued'");
    expect(text).toContain("ON CONFLICT (machine, action) WHERE status IN ('issued', 'fetched') DO NOTHING");
    expect(insert!.slice(1)).toEqual([r.ticket.ticket_id, "m1", "policy_cycle", '{"profile":"Default"}', 7, r.ticket.issued_at, r.ticket.expires_at, r.ticket.nonce, r.signature]);
  });

  it("returns { ok:false, reason:'outstanding' } when the insert is a conflict no-op", async () => {
    sql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect(await issueTicket(sql as never, { ...base, privateKeyPem: PRIV })).toEqual({ ok: false, reason: "outstanding" });
  });

  it("two tickets never share a ticket_id or a nonce", async () => {
    const a = await issueTicket(sql as never, { ...base, privateKeyPem: PRIV });
    const b = await issueTicket(sql as never, { ...base, privateKeyPem: PRIV });
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(a.ticket.ticket_id).not.toBe(b.ticket.ticket_id);
    expect(a.ticket.nonce).not.toBe(b.ticket.nonce);
  });
});
