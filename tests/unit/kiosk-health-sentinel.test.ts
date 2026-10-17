/** POST /api/kiosk-health — Sentinel S6: the event kind "sentinel" (the Mini forwarder on the poller credential, strictly validated). sql is mocked. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const M = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock("@/lib/fleet/device-auth", async (orig) => ({ ...(await orig<Record<string, unknown>>()), authenticateDevice: vi.fn() }));
// the cross-source twin lookup (daemon/helper pair only; sentinel rows can never be twins) answers "none" here
const isTwinLookup = (a: unknown[]): boolean => Array.isArray(a[0]) && (a[0] as string[]).join("?").match(/SELECT machine, kind, source, ts(, twin_source, twin_ts(, boot_id, seq)?)? FROM kiosk_health_(events|dedupe)/) !== null;
vi.mock("@/lib/db", () => ({ sql: (...a: unknown[]) => (isTwinLookup(a) ? Promise.resolve([]) : M.sql(...a)) }));

import { createHash } from "crypto";
import { POST } from "@/app/api/kiosk-health/route";
import { NextRequest } from "next/server";
import { SENTINEL_SOURCE } from "@/lib/sentinel-ingest";

const TOKEN = "tok-123";
const POLLER = ["sentinel", "poller", "fixture"].join("-");
const HASH = createHash("sha256").update(POLLER).digest("hex");
const SAVED = process.env.KIOSK_HEALTH_INGEST_TOKEN;
const SAVED_POLLER = process.env.KIOSK_HEALTH_POLLER_TOKEN_SHA256;

const S_PAYLOAD = { code: "MIC_MUTED_TONOR", mic_class: "tonor", zr: 0.82, peak: 0.0009, last_action: null, last_result: null, mode: "shadow" };
const sev = (seq: number, o: Record<string, unknown> = {}) => ({
  machine: "opd3", room_id: "room_abc", install_id: "mini-sentinel-forwarder", boot_id: "1789315200", seq,
  source: SENTINEL_SOURCE, kind: "sentinel", ts: new Date().toISOString(), payload: S_PAYLOAD, ...o,
});
const ev = (seq: number, o: Record<string, unknown> = {}) => ({
  machine: "m1", room_id: "r1", install_id: "i1", boot_id: "b1", seq, source: "daemon", kind: "heartbeat", ts: new Date().toISOString(), payload: {}, ...o,
});
const post = (body: unknown, auth: string | null = `Bearer ${POLLER}`) =>
  new NextRequest("https://x.test/api/kiosk-health", {
    method: "POST",
    headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const idsFor = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
const j = (r: Response | Promise<Response>): Promise<Record<string, unknown>> => {
  const p = r instanceof Promise ? r : Promise.resolve(r);
  return p.then((x) => x.json() as Promise<Record<string, unknown>>);
};

beforeEach(() => {
  process.env.KIOSK_HEALTH_INGEST_TOKEN = TOKEN;
  process.env.KIOSK_HEALTH_POLLER_TOKEN_SHA256 = HASH;
  M.sql.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (SAVED === undefined) delete process.env.KIOSK_HEALTH_INGEST_TOKEN; else process.env.KIOSK_HEALTH_INGEST_TOKEN = SAVED;
  if (SAVED_POLLER === undefined) delete process.env.KIOSK_HEALTH_POLLER_TOKEN_SHA256; else process.env.KIOSK_HEALTH_POLLER_TOKEN_SHA256 = SAVED_POLLER;
  vi.restoreAllMocks();
});

describe("POST /api/kiosk-health — kind \"sentinel\" (the Mini forwarder, Sentinel S6)", () => {
  it("poller token + a valid sentinel row is accepted and stored as kind sentinel with the forwarder source", async () => {
    M.sql.mockResolvedValueOnce(idsFor(1));
    const res = await POST(post({ events: [sev(1)] }));
    expect(res.status).toBe(200);
    expect(await j(res)).toMatchObject({ ok: true, accepted: 1, duplicates: 0, rejected: 0 });
    const params = (M.sql.mock.calls[0] as [string, unknown[]])[1];
    expect(params.slice(0, 8)).toEqual(["opd3", "room_abc", "mini-sentinel-forwarder", "1789315200", 1, SENTINEL_SOURCE, "sentinel", expect.any(String)]);
    expect(JSON.parse(String(params[8]))).toEqual(S_PAYLOAD);
  });

  it("every one of the 8 codes is valid", async () => {
    for (const code of ["MIC_DEAD_WEBCAM", "MIC_MUTED_TONOR", "DEVICE_MISSING", "RECORDER_DOWN", "PRESENCE_DEAD", "TAILNET_DOWN", "MIC_PERM", "OK"]) {
      M.sql.mockReset();
      M.sql.mockResolvedValueOnce(idsFor(1));
      const res = await POST(post({ events: [sev(1, { payload: { ...S_PAYLOAD, code } })] }));
      expect(res.status).toBe(200);
      expect((await j(res)).accepted).toBe(1);
    }
  });

  it("an unknown code is a 400 bad_sentinel, and nothing is stored", async () => {
    for (const code of ["mic_muted_tonor", "MIC_DEAD", "OK ", "", "REBOOT"]) {
      const res = await POST(post({ events: [sev(1, { payload: { ...S_PAYLOAD, code } })] }));
      expect(res.status).toBe(400);
      expect(await j(res)).toEqual({ ok: false, error: "bad_sentinel" });
    }
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("every other payload violation is a 400 bad_sentinel (strict: closed sets, [0,1] ratios, words, all keys required)", async () => {
    const bad: Array<Record<string, unknown>> = [
      { ...S_PAYLOAD, code: 42 },
      { ...S_PAYLOAD, mic_class: "c270" },
      { ...S_PAYLOAD, mic_class: null },
      { ...S_PAYLOAD, mode: "live" },
      { ...S_PAYLOAD, zr: -0.1 },
      { ...S_PAYLOAD, zr: 1.0001 },
      { ...S_PAYLOAD, zr: "0.8" },
      { ...S_PAYLOAD, last_action: "" },
      { ...S_PAYLOAD, last_action: "x".repeat(65) },
      { ...S_PAYLOAD, last_result: 7 },
      { code: S_PAYLOAD.code }, // every other key missing
      { ...S_PAYLOAD, zr: undefined }, // key absent (undefined drops out of the JSON)
      { ...S_PAYLOAD, peak: undefined },
      { ...S_PAYLOAD, last_action: "a", extra_is_fine: true }, // extra keys are tolerated (the generic envelope already accepts arbitrary payloads); this one is VALID
    ];
    const valid = bad.pop()!;
    for (const p of bad) {
      const res = await POST(post({ events: [sev(1, { payload: p })] }));
      expect(res.status, JSON.stringify(p)).toBe(400);
      expect(await j(res)).toEqual({ ok: false, error: "bad_sentinel" });
    }
    M.sql.mockResolvedValueOnce(idsFor(1));
    expect((await POST(post({ events: [sev(1, { payload: valid })] }))).status).toBe(200);
    expect(M.sql).toHaveBeenCalledTimes(1);
  });

  it("401 with no token or a wrong bearer; the database is never touched", async () => {
    expect((await POST(post({ events: [sev(1)] }, null))).status).toBe(401);
    expect((await POST(post({ events: [sev(1)] }, "Bearer nope"))).status).toBe(401);
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("the poller token without the hash env is a 401", async () => {
    delete process.env.KIOSK_HEALTH_POLLER_TOKEN_SHA256;
    expect((await POST(post({ events: [sev(1)] }))).status).toBe(401);
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("the daemon token also carries a valid sentinel row (the daemon path has no kind restriction)", async () => {
    M.sql.mockResolvedValueOnce(idsFor(1));
    const res = await POST(post({ events: [sev(1)] }, `Bearer ${TOKEN}`));
    expect(res.status).toBe(200);
    expect(await j(res)).toMatchObject({ ok: true, accepted: 1, rejected: 0 });
  });

  it("a poller-token post is scoped: a sentinel with the micguard source is wrong_kind, mic_guard with the forwarder source is wrong_kind, another source is wrong_source; nothing is stored", async () => {
    const postOne = async (o: Record<string, unknown>) => {
      const res = await POST(post({ events: [sev(1, o)] }));
      expect(res.status).toBe(200);
      const out = await j(res);
      expect(out).toMatchObject({ accepted: 0, rejected: 1 });
      return (out.rejected_reasons as Array<{ reason: string }>)[0]!.reason;
    };
    expect(await postOne({ source: "mini_micguard_poller" })).toBe("wrong_kind");
    expect(await postOne({ kind: "mic_guard", payload: { state: "ok" } })).toBe("wrong_kind");
    expect(await postOne({ source: "daemon" })).toBe("wrong_source");
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("a mixed poller batch keeps the allowed rows (mic_guard from the poller + sentinel from the forwarder) and rejects the rest", async () => {
    M.sql.mockImplementation(async (_t: string, p: unknown[]) => idsFor(p.length / 9));
    const mg = { machine: "opd3", room_id: "room_abc", install_id: "mini-micguard-poller", boot_id: "1", seq: 1, source: "mini_micguard_poller", kind: "mic_guard", ts: new Date().toISOString(), payload: { state: "ok" } };
    const res = await POST(post({ events: [sev(1), mg, sev(2, { source: "daemon" })] }));
    const out = await j(res);
    expect(out).toMatchObject({ ok: true, accepted: 2, rejected: 1 });
    expect((out.rejected_reasons as Array<{ reason: string }>)[0]).toEqual({ index: -1, reason: "wrong_source" });
  });
});
