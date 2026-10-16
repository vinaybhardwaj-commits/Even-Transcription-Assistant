/** POST /api/kiosk-health — auth, size limits, chunking, duplicate accounting and DB-fault behaviour. sql is mocked. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const M = vi.hoisted(() => ({ sql: vi.fn(), auth: vi.fn() }));
// TS-H8: the Device credential is the per-device Ed25519 JWS (lib/fleet/device-auth.ts, proven on a real postgres in fleet-h6-pg); here it is a controlled answer.
vi.mock("@/lib/fleet/device-auth", async (orig) => ({ ...(await orig<Record<string, unknown>>()), authenticateDevice: (...a: unknown[]) => M.auth(...a) }));
// TS-H10: the route first looks for cross-source twins with ONE tagged-template read; it answers "none" here so these tests keep counting only the INSERTs (the dedupe itself is proven
// on a real postgres in fleet-h6-pg.test.ts and in kiosk-health-dedupe.test.ts).
const isTwinLookup = (a: unknown[]): boolean => Array.isArray(a[0]) && (a[0] as string[]).join("?").match(/SELECT machine, kind, source, ts(, twin_source, twin_ts(, boot_id, seq)?)? FROM kiosk_health_(events|dedupe)/) !== null;
vi.mock("@/lib/db", () => ({ sql: (...a: unknown[]) => (isTwinLookup(a) ? Promise.resolve([]) : M.sql(...a)) }));

import { createHash } from "crypto";
import { POST } from "@/app/api/kiosk-health/route";
import { NextRequest } from "next/server";

const TOKEN = "tok-123";
const SAVED = process.env.KIOSK_HEALTH_INGEST_TOKEN;
const ev = (seq: number, o: Record<string, unknown> = {}) => ({
  machine: "m1", room_id: "r1", install_id: "i1", boot_id: "b1", seq, source: "daemon", kind: "heartbeat", ts: new Date().toISOString(), payload: {}, ...o,
});
const events = (n: number) => Array.from({ length: n }, (_, i) => ev(i));
const post = (body: unknown, auth: string | null = `Bearer ${TOKEN}`, extra: Record<string, string> = {}) =>
  new NextRequest("https://x.test/api/kiosk-health", {
    method: "POST",
    headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json", ...extra },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const idsFor = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

beforeEach(() => {
  process.env.KIOSK_HEALTH_INGEST_TOKEN = TOKEN;
  M.sql.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (SAVED === undefined) delete process.env.KIOSK_HEALTH_INGEST_TOKEN; else process.env.KIOSK_HEALTH_INGEST_TOKEN = SAVED;
  vi.restoreAllMocks();
});

describe("POST /api/kiosk-health", () => {
  it("401 without or with a wrong bearer; the database is never touched", async () => {
    expect((await POST(post({ events: [ev(1)] }, null))).status).toBe(401);
    expect((await POST(post({ events: [ev(1)] }, "Bearer nope"))).status).toBe(401);
    expect((await POST(post({ events: [ev(1)] }, `Bearer ${TOKEN}x`))).status).toBe(401);
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("a token saved with a trailing newline still matches", async () => {
    process.env.KIOSK_HEALTH_INGEST_TOKEN = `${TOKEN}\n`;
    M.sql.mockResolvedValueOnce(idsFor(1));
    expect((await POST(post({ events: [ev(1)] }))).status).toBe(200);
    expect((await POST(post({ events: [ev(1)] }, "Bearer nope"))).status).toBe(401);
  });

  it("500 when the token env var is unset", async () => {
    delete process.env.KIOSK_HEALTH_INGEST_TOKEN;
    expect((await POST(post({ events: [ev(1)] }))).status).toBe(500);
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("413 over 3 MB, by content-length header and by body length", async () => {
    const byHeader = await POST(post({ events: [ev(1)] }, `Bearer ${TOKEN}`, { "content-length": String(3_000_001) }));
    expect(byHeader.status).toBe(413);
    const big = JSON.stringify({ events: [ev(1)], pad: "x".repeat(3_000_001) });
    const byBody = await POST(post(big));
    expect(byBody.status).toBe(413);
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("400 on bad json, bad body, empty batch and 501 events", async () => {
    const e = async (b: unknown) => ((await (await POST(post(b))).json()) as { error: string }).error;
    expect((await POST(post("{nope"))).status).toBe(400);
    expect(await e("{nope")).toBe("bad_json");
    expect(await e({ nothing: 1 })).toBe("bad_body");
    expect(await e({ events: [] })).toBe("empty_batch");
    expect(await e({ events: events(501) })).toBe("too_many_events");
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("inserts in chunks of at most 100 with bound params and ON CONFLICT DO NOTHING", async () => {
    M.sql.mockImplementation(async (_t: string, p: unknown[]) => idsFor(p.length / 9));
    const res = await POST(post({ events: events(250) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, accepted: 250, duplicates: 0, rejected: 0, rejected_reasons: [] });
    expect(M.sql).toHaveBeenCalledTimes(3);
    expect(M.sql.mock.calls.map((c) => (c[1] as unknown[]).length / 9)).toEqual([100, 100, 50]);
    const [text, params] = M.sql.mock.calls[0] as [string, unknown[]];
    expect(text).toContain("ON CONFLICT ON CONSTRAINT kiosk_health_events_machine_boot_seq_key DO NOTHING RETURNING id");
    expect(text).toContain("$900::jsonb");
    expect(text).not.toContain("m1"); // values are bound, never interpolated
    expect(params.slice(0, 9)).toEqual(["m1", "r1", "i1", "b1", 0, "daemon", "heartbeat", expect.any(String), "{}"]);
  });

  it("counts duplicates as valid rows minus rows returned", async () => {
    M.sql.mockResolvedValueOnce(idsFor(3)); // 5 sent, 3 new
    const res = await POST(post({ events: events(5) }));
    expect(await res.json()).toMatchObject({ ok: true, accepted: 3, duplicates: 2, rejected: 0 });
    M.sql.mockResolvedValueOnce([]); // full replay
    expect(await (await POST(post({ events: events(5) }))).json()).toMatchObject({ ok: true, accepted: 0, duplicates: 5 });
  });

  it("reports rejected items (first 20 reasons) and still inserts the valid ones", async () => {
    M.sql.mockImplementation(async (_t: string, p: unknown[]) => idsFor(p.length / 9));
    const bad = Array.from({ length: 25 }, (_, i) => ev(i, { kind: "BAD" }));
    const res = await POST(post({ events: [ev(100), ...bad] }));
    const j = (await res.json()) as { accepted: number; rejected: number; rejected_reasons: { index: number; reason: string }[] };
    expect(j.accepted).toBe(1);
    expect(j.rejected).toBe(25);
    expect(j.rejected_reasons).toHaveLength(20);
    expect(j.rejected_reasons[0]).toEqual({ index: 1, reason: "bad_kind" });
  });

  it("all items invalid: 200 with nothing inserted and no database call", async () => {
    const res = await POST(post({ events: [ev(1, { seq: -1 })] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 0, duplicates: 0, rejected: 1 });
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("503 {ok:false,error:'db'} on a database error so the spool retries", async () => {
    M.sql.mockRejectedValueOnce(new Error("connect ECONNRESET"));
    const res = await POST(post({ events: events(3) }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "db" });
  });

  it("503 when a later chunk fails after an earlier one succeeded", async () => {
    M.sql.mockResolvedValueOnce(idsFor(100)).mockRejectedValueOnce(new Error("timeout"));
    const res = await POST(post({ events: events(150) }));
    expect(res.status).toBe(503);
  });

  it("a SQLSTATE 22/23 data fault falls back row by row and rejects only the refused row", async () => {
    const fault = Object.assign(new Error("bad data"), { code: "22P05" });
    M.sql.mockRejectedValueOnce(fault); // whole chunk refused
    M.sql.mockResolvedValueOnce(idsFor(1)).mockRejectedValueOnce(fault).mockResolvedValueOnce(idsFor(1)); // 3 rows one by one
    const res = await POST(post({ events: events(3) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 2, duplicates: 0, rejected: 1 });
    expect(M.sql).toHaveBeenCalledTimes(4);
  });

  it("never logs payload contents", async () => {
    const warn = vi.spyOn(console, "warn");
    M.sql.mockRejectedValueOnce(new Error("boom"));
    await POST(post({ events: [ev(1, { payload: { secret: "PAYLOAD-MARKER" } })] }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PAYLOAD-MARKER");
  });
});


describe("POST /api/kiosk-health — Authorization: Device <device JWS> (TS-H10 #47, TS-H8)", () => {
  const DEVICE = { device_id: "dev_" + "a".repeat(24), install_id: "i1", room_id: "r1", machine: "EHRC-OPD1’s Mac mini", public_key: "k", status: "active" };
  const asDevice = () => M.auth.mockResolvedValueOnce({ ok: true, device: DEVICE });
  const hev = (seq: number, o: Record<string, unknown> = {}) => ev(seq, { source: "helper", machine: "EHRC-OPD1s-Mac-mini", ...o });
  beforeEach(() => M.auth.mockReset());

  it("401 when the device credential does not verify (bad signature, replay, unknown device, expired...); the database is never touched; the body and request line are what was verified", async () => {
    M.auth.mockResolvedValueOnce({ ok: false, status: 401, code: "bad_signature" });
    expect((await POST(post({ events: [hev(1)] }, "Device not.a.jwt"))).status).toBe(401);
    expect(M.sql).not.toHaveBeenCalled();
    const body = { events: [hev(1)] };
    M.auth.mockResolvedValueOnce({ ok: false, status: 401, code: "replay" });
    await POST(post(body, "Device abc"));
    expect(M.auth.mock.calls[1]![1]).toMatchObject({ authorization: "Device abc", method: "POST", path: "/api/kiosk-health", bodyText: JSON.stringify(body) });
  });

  it("no space after the scheme is not the Device scheme (and is not the daemon token either)", async () => {
    expect((await POST(post({ events: [hev(1)] }, "Device"))).status).toBe(401);
    expect(M.auth).not.toHaveBeenCalled();
  });

  it("a device-authenticated post stores the helper's events for ITS OWN Mac; it works with the daemon's env token UNSET (separate credential)", async () => {
    delete process.env.KIOSK_HEALTH_INGEST_TOKEN;
    asDevice();
    M.sql.mockResolvedValueOnce(idsFor(2));
    const res = await POST(post({ events: [hev(1), hev(2, { kind: "power.sleep" })] }, "Device x"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, accepted: 2, duplicates: 0, rejected: 0, deduped: 0 });
  });

  it("only source helper, only the device's own Mac, only its room id: each refusal is named and the rest of the batch still lands; steward.result IS allowed", async () => {
    asDevice();
    M.sql.mockResolvedValueOnce(idsFor(2));
    const res = await POST(post({ events: [
      hev(1),
      hev(2, { source: "daemon" }),
      hev(3, { machine: "EHRC-OPD9s-Mac-mini" }),
      hev(4, { room_id: "r2" }),
      hev(5, { kind: "steward.result", payload: { ticket_id: "t1", nonce: "n1", outcome: "done" } }),
    ] }, "Device x"));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j).toMatchObject({ accepted: 2, rejected: 3 });
    expect((j.rejected_reasons as Array<{ reason: string }>).map((r) => r.reason).sort()).toEqual(["machine_not_in_room", "room_mismatch", "wrong_source"]);
  });

  it("an auth lookup fault is 503 so the spool retries; the daemon's Bearer path is unchanged", async () => {
    M.auth.mockRejectedValueOnce(new Error("db down"));
    expect((await POST(post({ events: [hev(1)] }, "Device x"))).status).toBe(503);
    expect((await POST(post({ events: [ev(1)] }, null))).status).toBe(401);
    M.sql.mockResolvedValueOnce(idsFor(1));
    expect((await POST(post({ events: [ev(1, { machine: "anything-at-all" })] }))).status).toBe(200);
    expect(M.auth).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/kiosk-health — Bearer poller token via KIOSK_HEALTH_POLLER_TOKEN_SHA256 (mic-guard poller, scoped)", () => {
  const POLLER = ["t", "poller", "fixture"].join("-");
  const SAVED_POLLER = process.env.KIOSK_HEALTH_POLLER_TOKEN_SHA256;
  const HASH = createHash("sha256").update(POLLER).digest("hex");
  const pev = (seq: number, o: Record<string, unknown> = {}) => ev(seq, { source: "mini_micguard_poller", kind: "mic_guard", ...o });
  const asPoller = (body: unknown) => post(body, `Bearer ${POLLER}`);
  const reasons = (j: unknown) => ((j as { rejected_reasons: Array<{ reason: string }> }).rejected_reasons).map((r) => r.reason);
  beforeEach(() => { process.env.KIOSK_HEALTH_POLLER_TOKEN_SHA256 = HASH; });
  afterEach(() => { if (SAVED_POLLER === undefined) delete process.env.KIOSK_HEALTH_POLLER_TOKEN_SHA256; else process.env.KIOSK_HEALTH_POLLER_TOKEN_SHA256 = SAVED_POLLER; });

  it("the daemon token still works with the poller token set", async () => {
    M.sql.mockResolvedValueOnce(idsFor(1));
    expect(await (await POST(post({ events: [ev(1)] }))).json()).toMatchObject({ ok: true, accepted: 1, rejected: 0 });
  });

  it("poller token + a mic_guard/mini_micguard_poller row is accepted", async () => {
    M.sql.mockResolvedValueOnce(idsFor(1));
    const res = await POST(asPoller({ events: [pev(1)] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, accepted: 1, rejected: 0 });
  });

  it("another source is rejected wrong_source; the right source with another kind is wrong_kind; nothing is stored", async () => {
    const a = await POST(asPoller({ events: [pev(1, { source: "daemon" })] }));
    expect(a.status).toBe(200);
    const ja = await a.json();
    expect(ja).toMatchObject({ accepted: 0, rejected: 1 });
    expect(reasons(ja)).toEqual(["wrong_source"]);
    const jb = await (await POST(asPoller({ events: [pev(2, { kind: "heartbeat" })] }))).json();
    expect(jb).toMatchObject({ accepted: 0, rejected: 1 });
    expect(reasons(jb)).toEqual(["wrong_kind"]);
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("a mixed batch keeps only the allowed rows", async () => {
    M.sql.mockImplementation(async (_t: string, p: unknown[]) => idsFor(p.length / 9));
    const j = await (await POST(asPoller({ events: [pev(1), pev(2, { source: "helper" }), pev(3), pev(4, { kind: "power.sleep" })] }))).json();
    expect(j).toMatchObject({ accepted: 2, rejected: 2 });
    expect(reasons(j).sort()).toEqual(["wrong_kind", "wrong_source"]);
    const params = (M.sql.mock.calls[0] as [string, unknown[]])[1];
    expect(params.length / 9).toBe(2);
  });

  it("a steward.result row from the poller is rejected and never reaches applyStewardResults", async () => {
    const j = await (await POST(asPoller({ events: [pev(1, { kind: "steward.result", payload: { ticket_id: "t1", nonce: "n1", outcome: "done" } })] }))).json();
    expect(j).toMatchObject({ accepted: 0, rejected: 1 });
    expect(reasons(j)).toEqual(["wrong_kind"]);
    expect(M.sql).not.toHaveBeenCalled(); // applyStewardResults would have queried; the row was never stored
  });

  it("a wrong token is 401 with the poller token set and with it unset", async () => {
    expect((await POST(post({ events: [pev(1)] }, "Bearer nope"))).status).toBe(401);
    delete process.env.KIOSK_HEALTH_POLLER_TOKEN_SHA256;
    expect((await POST(post({ events: [pev(1)] }, "Bearer nope"))).status).toBe(401);
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("an unset or blank poller env makes the poller value a 401", async () => {
    delete process.env.KIOSK_HEALTH_POLLER_TOKEN_SHA256;
    expect((await POST(asPoller({ events: [pev(1)] }))).status).toBe(401);
    process.env.KIOSK_HEALTH_POLLER_TOKEN_SHA256 = "  \n";
    expect((await POST(asPoller({ events: [pev(1)] }))).status).toBe(401);
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("a non-hex or wrong-length hash env turns the poller path off (401)", async () => {
    for (const bad of [POLLER, "zz".repeat(32), HASH.slice(0, 63), HASH + "0"]) {
      process.env.KIOSK_HEALTH_POLLER_TOKEN_SHA256 = bad;
      expect((await POST(asPoller({ events: [pev(1)] }))).status).toBe(401);
    }
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("the hash itself is not a bearer credential, and a prefix other than Bearer is refused", async () => {
    expect((await POST(post({ events: [pev(1)] }, `Bearer ${HASH}`))).status).toBe(401);
    expect((await POST(post({ events: [pev(1)] }, `bearer ${POLLER}`))).status).toBe(401);
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("an empty token never authenticates, even when the env holds the hash of an empty string", async () => {
    process.env.KIOSK_HEALTH_POLLER_TOKEN_SHA256 = createHash("sha256").update("").digest("hex");
    for (const h of ["Bearer ", "Bearer  ", "Bearer   "]) {
      expect((await POST(post({ events: [pev(1)] }, h))).status).toBe(401);
    }
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("the daemon token unset with the poller set is still 500 not_configured", async () => {
    delete process.env.KIOSK_HEALTH_INGEST_TOKEN;
    const res = await POST(asPoller({ events: [pev(1)] }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "not_configured" });
  });

  it("a poller token saved with a trailing newline still matches", async () => {
    process.env.KIOSK_HEALTH_POLLER_TOKEN_SHA256 = `${HASH}\n`;
    M.sql.mockResolvedValueOnce(idsFor(1));
    expect((await POST(asPoller({ events: [pev(1)] }))).status).toBe(200);
  });
});
