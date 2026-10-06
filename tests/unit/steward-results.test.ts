/** steward.result ingestion — lib/steward/results.ts directly, and through POST /api/kiosk-health (the response never depends on it). sql is mocked. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const M = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock("@/lib/db", () => ({ sql: M.sql }));

import { applyStewardResults, truncateDetail, validateResultPayload, type StewardResultRow } from "@/lib/steward/results";
import { POST } from "@/app/api/kiosk-health/route";
import { NextRequest } from "next/server";

const texts = () => (M.sql.mock.calls as Array<[string[] | string, ...unknown[]]>).map((c) => (typeof c[0] === "string" ? c[0] : c[0].join("?")));
const res = (payload: Record<string, unknown>, machine = "m1"): StewardResultRow => ({ machine, kind: "steward.result", payload });
const good = { ticket_id: "t1", nonce: "n1", outcome: "done", detail: "ok" };

beforeEach(() => {
  M.sql.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("validateResultPayload", () => {
  it("accepts the five outcomes and an optional detail up to 2 KB; refuses anything else", () => {
    for (const outcome of ["done", "failed", "rejected", "expired", "unsupported"]) expect(validateResultPayload({ ...good, outcome })).toMatchObject({ outcome });
    expect(validateResultPayload({ ticket_id: "t", nonce: "n", outcome: "done" })).toEqual({ ticket_id: "t", nonce: "n", outcome: "done" });
    expect(validateResultPayload({ ...good, detail: "x".repeat(2048) })).not.toBeNull();
    for (const bad of [null, [], { ...good, outcome: "ok" }, { ...good, ticket_id: "" }, { ...good, nonce: 5 }, { ...good, ticket_id: "x".repeat(65) }, { ...good, detail: 5 }]) {
      expect(validateResultPayload(bad)).toBeNull();
    }
  });
});

describe("detail truncation (never dropped)", () => {
  it("an oversize detail is cut to <= 2048 bytes ending in the marker; the payload stays valid", () => {
    const long = validateResultPayload({ ...good, detail: "x".repeat(5000) })!;
    expect(Buffer.byteLength(long.detail!, "utf8")).toBe(2048);
    expect(long.detail!.endsWith("…")).toBe(true);
    expect(long.detail!.startsWith("x".repeat(2045))).toBe(true);
    expect(long).toMatchObject({ ticket_id: "t1", nonce: "n1", outcome: "done" });
    expect(truncateDetail("x".repeat(2048))).toBe("x".repeat(2048)); // exactly at the limit: untouched
    expect(truncateDetail("x".repeat(2049)).endsWith("…")).toBe(true);
  });

  it("never splits a multi-byte character", () => {
    for (const ch of ["é", "€", "😀"]) {
      const d = validateResultPayload({ ...good, detail: ch.repeat(3000) })!.detail!;
      expect(Buffer.byteLength(d, "utf8")).toBeLessThanOrEqual(2048);
      expect(d.endsWith("…")).toBe(true);
      expect(d).not.toContain("\uFFFD");
      expect(d.slice(0, -1)).toBe(ch.repeat((d.length - 1) / ch.length));
    }
  });

  it("the outcome still applies when the detail is oversize, and the stored result carries the truncated detail", async () => {
    M.sql.mockResolvedValueOnce([{ ticket_id: "t1" }]);
    expect(await applyStewardResults(M.sql as never, [res({ ...good, detail: "y".repeat(10_000) })])).toEqual({ applied: 1, ignored: 0, errors: 0 });
    const call = M.sql.mock.calls[0] as [string[], ...unknown[]];
    const stored = JSON.parse(call.find((v) => typeof v === "string" && v.startsWith("{")) as string);
    expect(Buffer.byteLength(stored.detail, "utf8")).toBeLessThanOrEqual(2048);
    expect(stored.outcome).toBe("done");
  });
});

describe("applyStewardResults", () => {
  it("happy path: ONE statement spends the nonce and sets the ticket done, every value bound", async () => {
    M.sql.mockResolvedValueOnce([{ ticket_id: "t1" }]);
    expect(await applyStewardResults(M.sql as never, [res(good)])).toEqual({ applied: 1, ignored: 0, errors: 0 });
    expect(M.sql).toHaveBeenCalledTimes(1); // nonce insert and ticket update are one statement: a failed update cannot spend the nonce
    const text = texts()[0]!;
    expect(text).toContain("WITH spent AS (");
    expect(text).toContain("INSERT INTO steward_nonces");
    expect(text).toContain("ON CONFLICT (nonce) DO NOTHING");
    expect(text).toContain("UPDATE steward_tickets SET status =");
    expect(text).toContain("AND EXISTS (SELECT 1 FROM spent)");
    expect(text).toContain("status IN ('issued', 'fetched', 'expired')");
    const call = M.sql.mock.calls[0] as [string[], ...unknown[]];
    expect(call[1]).toBe("n1"); // nonce
    expect(call.slice(1)).toContain("done");
    expect(JSON.parse(call.find((v) => typeof v === "string" && v.startsWith("{")) as string)).toEqual(good);
  });

  it("rejected / expired / unsupported / failed map to failed, outcome kept in result", async () => {
    for (const outcome of ["rejected", "expired", "unsupported", "failed"]) {
      M.sql.mockReset();
      M.sql.mockResolvedValueOnce([{ ticket_id: "t1" }]);
      await applyStewardResults(M.sql as never, [res({ ...good, outcome })]);
      const call = M.sql.mock.calls[0] as [string[], ...unknown[]];
      expect(call.slice(1)).toContain("failed");
      expect(JSON.parse(call.find((v) => typeof v === "string" && v.startsWith("{")) as string).outcome).toBe(outcome);
    }
  });

  it("no row back (replayed nonce, wrong machine, wrong nonce, unknown or finished ticket) is ignored", async () => {
    M.sql.mockResolvedValue([]);
    expect(await applyStewardResults(M.sql as never, [res(good), res(good, "other")])).toEqual({ applied: 0, ignored: 2, errors: 0 });
  });

  it("bad payload (bad outcome, wrong types): ignored without touching the database; other kinds skipped", async () => {
    const stats = await applyStewardResults(M.sql as never, [
      res({ ...good, outcome: "exploded" }), res({ ...good, detail: 5 }), { machine: "m1", kind: "heartbeat", payload: good },
    ]);
    expect(stats).toEqual({ applied: 0, ignored: 2, errors: 0 });
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("never throws: a failing statement is counted and logged, later rows still run", async () => {
    M.sql.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce([{ ticket_id: "t2" }]);
    const stats = await applyStewardResults(M.sql as never, [res(good), res({ ...good, ticket_id: "t2", nonce: "n2" })]);
    expect(stats).toEqual({ applied: 1, ignored: 0, errors: 1 });
  });
});

describe("POST /api/kiosk-health with steward.result events", () => {
  const TOKEN = "tok-123";
  const SAVED = process.env.KIOSK_HEALTH_INGEST_TOKEN;
  beforeEach(() => { process.env.KIOSK_HEALTH_INGEST_TOKEN = TOKEN; });
  afterEach(() => { if (SAVED === undefined) delete process.env.KIOSK_HEALTH_INGEST_TOKEN; else process.env.KIOSK_HEALTH_INGEST_TOKEN = SAVED; });
  const ev = (seq: number, kind: string, payload: Record<string, unknown>) => ({
    machine: "m1", room_id: "r1", install_id: "i1", boot_id: "b1", seq, source: "daemon", kind, ts: new Date().toISOString(), payload,
  });
  const post = (events: unknown[]) =>
    new NextRequest("https://x.test/api/kiosk-health", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ events }) });

  it("stores the event first, then applies it; 200 with the usual counts", async () => {
    M.sql
      .mockResolvedValueOnce([{ id: 1 }, { id: 2 }]) // insertChunk
      .mockResolvedValueOnce([{ ticket_id: "t1" }]); // the single steward statement
    const r = await POST(post([ev(1, "heartbeat", {}), ev(2, "steward.result", good)]));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, accepted: 2, duplicates: 0, rejected: 0 });
    const t = texts();
    expect(t[0]).toContain("INSERT INTO kiosk_health_events");
    expect(t[1]).toContain("INSERT INTO steward_nonces");
    expect(t[1]).toContain("UPDATE steward_tickets");
    expect(t).toHaveLength(2);
  });

  it("still 200 when the steward update throws; the event stays stored", async () => {
    M.sql.mockResolvedValueOnce([{ id: 1 }]).mockRejectedValue(new Error("steward tables missing"));
    const r = await POST(post([ev(1, "steward.result", good)]));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, accepted: 1, rejected: 0 });
  });

  it("a batch with no steward.result events makes no steward query", async () => {
    M.sql.mockResolvedValueOnce([{ id: 1 }]);
    await POST(post([ev(1, "heartbeat", {})]));
    expect(M.sql).toHaveBeenCalledTimes(1);
  });
});
