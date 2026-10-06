/** GET /api/steward/tickets — auth, machine validation, response shape/order, SQL shape, DB fault. sql is mocked; real row semantics are proven in steward-0128-pg.test.ts. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const M = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock("@/lib/db", () => ({ sql: M.sql }));

import { GET } from "@/app/api/steward/tickets/route";
import { NextRequest } from "next/server";
import { STEWARD_TICKET_KEY_ID } from "@/lib/steward/ticket-public-key";

const TOKEN = "tok-123";
const SAVED = process.env.KIOSK_HEALTH_INGEST_TOKEN;
const get = (qs = "machine=m1", auth: string | null = `Bearer ${TOKEN}`) =>
  new NextRequest(`https://x.test/api/steward/tickets${qs ? `?${qs}` : ""}`, { headers: auth ? { authorization: auth } : {} });
const row = (id: string, issued: string, over: Record<string, unknown> = {}) => ({
  ticket_id: id, machine: "m1", action: "wake", params: {}, nonce: `n-${id}`, signature: `s-${id}`, issued_at: issued, expires_at: "2026-10-06T10:15:00.000Z", ...over,
});

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

describe("GET /api/steward/tickets", () => {
  it("401 without or with a wrong bearer; the database is never touched", async () => {
    expect((await GET(get("machine=m1", null))).status).toBe(401);
    expect((await GET(get("machine=m1", "Bearer nope"))).status).toBe(401);
    expect((await GET(get("machine=m1", `Bearer ${TOKEN}x`))).status).toBe(401);
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("500 when the token env var is unset; a token saved with a trailing newline still matches", async () => {
    delete process.env.KIOSK_HEALTH_INGEST_TOKEN;
    expect((await GET(get())).status).toBe(500);
    process.env.KIOSK_HEALTH_INGEST_TOKEN = `${TOKEN}\n`;
    M.sql.mockResolvedValue([]);
    expect((await GET(get())).status).toBe(200);
  });

  it("400 on a missing, empty or over-long machine", async () => {
    for (const qs of ["", "machine=", `machine=${"x".repeat(129)}`, "machine=a%00b"]) {
      expect((await GET(get(qs))).status).toBe(400);
    }
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("flips expired rows first, then marks fetched; every value bound; 200 with key_id, no-store, tickets oldest first", async () => {
    M.sql
      .mockResolvedValueOnce([]) // expire
      .mockResolvedValueOnce([row("b", "2026-10-06T10:00:02.000Z"), row("a", "2026-10-06T10:00:01.000Z", { action: "open_pulse", params: { profile: "P" } })]);
    const res = await GET(get("machine=m1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.key_id).toBe(STEWARD_TICKET_KEY_ID);
    expect(body.tickets.map((t: { ticket: { ticket_id: string } }) => t.ticket.ticket_id)).toEqual(["a", "b"]);
    expect(body.tickets[0]).toEqual({
      ticket: { v: 1, ticket_id: "a", machine: "m1", action: "open_pulse", params: { profile: "P" }, issued_at: "2026-10-06T10:00:01.000Z", expires_at: "2026-10-06T10:15:00.000Z", nonce: "n-a" },
      signature: "s-a",
    });

    const [expire, fetch] = M.sql.mock.calls as Array<[string[], ...unknown[]]>;
    const t1 = expire![0].join("?");
    expect(t1).toContain("UPDATE steward_tickets SET status = 'expired'");
    expect(t1).toContain("status IN ('issued', 'fetched') AND expires_at <= now()");
    expect(expire!.slice(1)).toEqual(["m1"]);
    const t2 = fetch![0].join("?");
    expect(t2).toContain("SET status = 'fetched', fetched_at = now()");
    expect(t2).toContain("status = 'issued' AND expires_at > now()");
    expect(t2).toContain("ORDER BY issued_at ASC");
    expect(fetch!.slice(1)).toEqual(["m1", 10]); // cap 10
  });

  it("returns an empty list when nothing is pending", async () => {
    M.sql.mockResolvedValue([]);
    expect(await (await GET(get())).json()).toEqual({ ok: true, key_id: STEWARD_TICKET_KEY_ID, tickets: [] });
  });

  it("503 on a database fault", async () => {
    M.sql.mockRejectedValueOnce(new Error("down"));
    const res = await GET(get());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "db" });
  });
});
