/**
 * POST /api/presence — auth, validation, insert (T-PRESENCE-5). The DB is mocked; the mock records
 * the JSON array handed to the single INSERT.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const calls: unknown[][] = [];
let failDb = false;
vi.mock("@/lib/db", () => ({
  sql: async (_s: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push(vals);
    if (failDb) throw new Error("db down");
    return JSON.parse(vals[0] as string).map((_: unknown, i: number) => ({ id: i + 1 }));
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
    expect(await res.json()).toEqual({ ok: true, count: 3 });
    const rows = inserted();
    expect(rows.length).toBe(3);
    expect(rows[0]).toMatchObject({ source: "ext", machine: "MAC-1", room: "OPD-3", event: "heartbeat", email: "dr@even.in", ts: "2026-09-30T08:35:00.000Z" });
    expect((rows[0]!.payload as Record<string, unknown>).display_name).toBe("Dr X");
  });
  it("valid poller batch inserts M rows; state→event, machine→machine", async () => {
    const res = await post([poller(), poller({ state: "locked", locked: true })]);
    expect(await res.json()).toEqual({ ok: true, count: 2 });
    expect(inserted()[1]).toMatchObject({ source: "poller", machine: "MAC-2", room: null, email: null, event: "locked" });
  });
  it("single object and mixed batch are accepted", async () => {
    expect(await (await post(poller())).json()).toEqual({ ok: true, count: 1 });
    calls.length = 0;
    expect(await (await post([ext(), poller()])).json()).toEqual({ ok: true, count: 2 });
  });
  it("empty batch → 200 count 0, no insert", async () => {
    expect(await (await post([])).json()).toEqual({ ok: true, count: 0 });
    expect(calls.length).toBe(0);
  });
  it("db failure → 503 (retryable)", async () => {
    failDb = true;
    expect((await post([ext()])).status).toBe(503);
  });
});

describe("validation → 422, nothing inserted", () => {
  const cases: Array<[string, unknown]> = [
    ["not json", "{oops"],
    ["scalar", 5],
    ["unknown ext key", [ext({ uid: "leak" })]],
    ["unknown poller key", [poller({ email: "x@y.z" })]],
    ["missing ext key", [(() => { const e = ext(); delete (e as Record<string, unknown>).reason; return e; })()]],
    ["bad event name", [ext({ event: "idle_locked" })]],
    ["bad ts", [ext({ ts: "yesterday" })]],
    ["bad boolean", [ext({ tab_focus: "yes" })]],
    ["poller bad idle_s", [poller({ idle_s: "12" })]],
    ["ambiguous shape", [{ ...ext(), state: "active" }]],
    ["one bad item poisons the batch", [ext(), ext({ ts: "nope" })]],
  ];
  for (const [name, body] of cases) {
    it(name, async () => {
      expect((await post(body)).status).toBe(422);
      expect(calls.length).toBe(0);
    });
  }
  it("more than 200 items → 413", async () => {
    expect((await post(Array.from({ length: 201 }, () => ext()))).status).toBe(413);
    expect(calls.length).toBe(0);
  });
});

describe("promoted columns come only from known fields", () => {
  it("a stray key never reaches a column (rejected outright)", async () => {
    await post([ext({ machine: "EVIL", state: "EVIL" })]);
    expect(calls.length).toBe(0);
  });
  it("row keys are exactly the promoted set plus payload", async () => {
    await post([ext()]);
    expect(Object.keys(inserted()[0]!).sort()).toEqual(["email", "event", "machine", "payload", "room", "source", "ts"]);
  });
});
