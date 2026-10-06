/** POST /api/kiosk-health — auth, size limits, chunking, duplicate accounting and DB-fault behaviour. sql is mocked. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const M = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock("@/lib/db", () => ({ sql: M.sql }));

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
