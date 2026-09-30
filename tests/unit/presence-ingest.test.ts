/**
 * POST /api/presence — auth, validation, insert (T-PRESENCE-5). The DB is mocked; the mock records
 * the JSON array handed to the single INSERT.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const calls: unknown[][] = [];
let failDb = false;
// Stands in for Postgres: a row whose machine is DBFAIL is refused on data grounds (SQLSTATE 23514);
// failDb is a dead connection (no SQLSTATE).
vi.mock("@/lib/db", () => ({
  sql: async (_s: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push(vals);
    if (failDb) throw new Error("connection refused");
    const rows = JSON.parse(vals[0] as string) as Array<{ machine: string }>;
    if (rows.some((r) => r.machine === "DBFAIL")) throw Object.assign(new Error("check violation: secret-value"), { code: "23514" });
    return rows.map((_, i) => ({ id: i + 1 }));
  },
}));

import { POST } from "../../app/api/presence/route";

const TOKEN = "test-presence-token";
const ext = (over: Record<string, unknown> = {}) => ({
  machine_id: "MAC-1", room: "OPD-3", email: "dr@even.in", display_name: "Dr X", event: "heartbeat",
  encounter_id: null, prescription_ref: null, ts: "2026-09-30T14:05:00.000+05:30", tab_focus: true,
  impersonating: false, ext_version: "0.1.0", reason: null, ...over,
});
const poller = (over: Record<string, unknown> = {}) => ({
  machine: "MAC-2", ts: "2026-09-30T08:35:00Z", idle_s: 12, locked: false, chrome_running: true,
  console_user: "doc", state: "active", poller_version: "0.1", ...over,
});
const post = (body: unknown, auth: string | null = `Bearer ${TOKEN}`) =>
  POST(new NextRequest("http://x/api/presence", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
const inserted = () => (calls.length ? (JSON.parse(calls[0]![0] as string) as Array<Record<string, unknown>>) : []);

beforeEach(() => { calls.length = 0; failDb = false; process.env.PRESENCE_INGEST_TOKEN = TOKEN; });

describe("auth", () => {
  it("missing or wrong token → 401, nothing inserted", async () => {
    expect((await post([ext()], null)).status).toBe(401);
    expect((await post([ext()], "Bearer nope")).status).toBe(401);
    expect((await post([ext()], TOKEN)).status).toBe(401);
    expect(calls.length).toBe(0);
  });
  it("token env unset → 503 (never open)", async () => {
    delete process.env.PRESENCE_INGEST_TOKEN;
    expect((await post([ext()], "Bearer ")).status).toBe(503);
    expect(calls.length).toBe(0);
  });
});

describe("insert", () => {
  it("valid ext batch inserts N rows with promoted columns", async () => {
    const res = await post([ext(), ext({ event: "login" }), ext({ event: "idle", email: null, display_name: null })]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, inserted: 3, rejected: 0, count: 3 });
    const rows = inserted();
    expect(rows.length).toBe(3);
    expect(rows[0]).toMatchObject({ source: "ext", machine: "MAC-1", room: "OPD-3", event: "heartbeat", email: "dr@even.in", ts: "2026-09-30T08:35:00.000Z" });
    expect((rows[0]!.payload as Record<string, unknown>).display_name).toBe("Dr X");
  });
  it("valid poller batch inserts M rows; state→event, machine→machine", async () => {
    const res = await post([poller(), poller({ state: "locked", locked: true })]);
    expect(await res.json()).toMatchObject({ ok: true, inserted: 2, rejected: 0 });
    expect(inserted()[1]).toMatchObject({ source: "poller", machine: "MAC-2", room: null, email: null, event: "locked" });
  });
  it("single object and mixed batch are accepted", async () => {
    expect(await (await post(poller())).json()).toMatchObject({ inserted: 1, rejected: 0 });
    calls.length = 0;
    expect(await (await post([ext(), poller()])).json()).toMatchObject({ inserted: 2, rejected: 0 });
  });
  it("empty batch → 200 count 0, no insert", async () => {
    expect(await (await post([])).json()).toMatchObject({ inserted: 0, rejected: 0 });
    expect(calls.length).toBe(0);
  });
  it("DB unreachable → 503 (retryable), and the log does not echo input", async () => {
    failDb = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await post([ext({ email: "leaky@even.in" })])).status).toBe(503);
    const logged = JSON.stringify(warn.mock.calls);
    warn.mockRestore();
    expect(logged).not.toContain("leaky");
    expect(logged).not.toContain("connection refused");
    expect(logged).not.toContain(TOKEN);
  });
  it("a row Postgres refuses on data grounds is rejected, the rest insert, 2xx, log has no values", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post([ext({ machine_id: "A" }), ext({ machine_id: "DBFAIL" }), ext({ machine_id: "B" })]);
    const logged = JSON.stringify(warn.mock.calls);
    warn.mockRestore();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, inserted: 2, rejected: 1 });
    expect(logged).not.toContain("secret-value");
    expect(logged).not.toContain("DBFAIL");
  });
});

describe("per-item faults: rejected, never 5xx, good items in the same batch still insert", () => {
  const good = () => ext({ machine_id: "GOOD" });
  const classes: Array<[string, () => unknown]> = [
    ["NUL in a promoted string", () => ext({ machine_id: "a\u0000b" })],
    ["NUL in a non-promoted string", () => ext({ display_name: "Dr\u0000X" })],
    ["NUL in an unknown key value", () => ext({ extra: "x\u0000" })],
    ["NUL nested in an unknown key", () => ext({ extra: { deep: ["ok", "y\u0000"] } })],
    ["NUL in a key name", () => ext({ ["k\u0000"]: 1 })],
    ["lone high surrogate", () => ext({ room: "a\uD800b" })],
    ["lone low surrogate", () => ext({ reason: "\uDC00" })],
    ["lone surrogate nested", () => ext({ extra: { a: "\uD83D" } })],
    ["timestamp +275760", () => ext({ ts: "+275760-09-13T00:00:00.000Z" })],
    ["timestamp -000001", () => ext({ ts: "-000001-01-01T00:00:00.000Z" })],
    ["timestamp year 0000", () => ext({ ts: "0000-06-01T00:00:00Z" })],
    ["timestamp year 9999", () => ext({ ts: "9999-01-01T00:00:00Z" })],
    ["loose timestamp '1'", () => ext({ ts: "1" })],
    ["loose timestamp '2026'", () => ext({ ts: "2026" })],
    ["date-only timestamp", () => ext({ ts: "2026-09-30" })],
    ["no offset", () => ext({ ts: "2026-09-30T08:35:00" })],
    ["Feb 30", () => ext({ ts: "2026-02-30T00:00:00Z" })],
    ["hour 24", () => ext({ ts: "2026-09-30T24:00:00Z" })],
    ["poller NUL", () => poller({ console_user: "a\u0000" })],
    ["poller out-of-range ts", () => poller({ ts: "+275760-09-13T00:00:00.000Z" })],
    ["missing ext key", () => { const e = ext(); delete (e as Record<string, unknown>).reason; return e; }],
    ["bad event name", () => ext({ event: "idle_locked" })],
    ["bad boolean", () => ext({ tab_focus: "yes" })],
    ["poller bad idle_s", () => poller({ idle_s: "12" })],
    ["neither shape", () => ({ hello: "world" })],
    ["scalar item", () => 5],
    ["oversize item", () => ext({ extra: "x".repeat(20_000) })],
  ];
  for (const [name, bad] of classes) {
    it(name, async () => {
      const res = await post([good(), bad(), good()]);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, inserted: 2, rejected: 1 });
      const rows = inserted();
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.machine === "GOOD")).toBe(true);
    });
  }
  it("a batch of only bad items → 200, inserted 0, no DB call", async () => {
    const res = await post([{ x: 1 }, ext({ ts: "1" })]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ inserted: 0, rejected: 2 });
    expect(calls.length).toBe(0);
  });
  it("valid astral characters (paired surrogates) are accepted", async () => {
    const res = await post([ext({ display_name: "Dr \u{1F600}" })]);
    expect(await res.json()).toMatchObject({ inserted: 1, rejected: 0 });
  });
  it("valid timestamps with fractions and offsets are accepted and normalized to UTC", async () => {
    await post([ext({ ts: "2026-09-30T14:05:00.123456+05:30" }), ext({ ts: "2026-09-30T08:35:00Z" })]);
    expect(inserted().map((r) => r.ts)).toEqual(["2026-09-30T08:35:00.123Z", "2026-09-30T08:35:00.000Z"]);
  });
  it("not JSON → 422; more than 200 items → 413", async () => {
    expect((await post("{oops")).status).toBe(422);
    expect((await post(Array.from({ length: 201 }, () => ext()))).status).toBe(413);
    expect(calls.length).toBe(0);
  });
});

describe("unknown top-level keys are kept in payload, never promoted", () => {
  it("stored verbatim in payload; absent from every promoted column", async () => {
    const res = await post([ext({ future_field: "F1", machine: "EVIL", state: "EVIL2", source: "EVIL3" })]);
    expect(await res.json()).toMatchObject({ inserted: 1, rejected: 0 });
    const row = inserted()[0]!;
    expect(row.payload).toMatchObject({ future_field: "F1", machine: "EVIL", state: "EVIL2", source: "EVIL3" });
    expect(row).toMatchObject({ source: "ext", machine: "MAC-1", event: "heartbeat" });
    expect(Object.keys(row).sort()).toEqual(["email", "event", "machine", "payload", "room", "source", "ts"]);
    expect(JSON.stringify({ ...row, payload: null })).not.toContain("EVIL");
  });
  it("an unknown-key poller event too", async () => {
    await post([poller({ new_metric: 7 })]);
    expect((inserted()[0]!.payload as Record<string, unknown>).new_metric).toBe(7);
  });
});
