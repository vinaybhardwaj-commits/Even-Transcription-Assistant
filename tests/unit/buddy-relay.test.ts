/**
 * Encounter Buddy L1 — the presence ingest relays encounter_open / encounter_close as consult_started / consult_ended.
 * The DB is a small fake keyed on the SQL text. All ids, hostnames and rooms are synthetic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

type Ref = { opaque_id: string; consult_uid: string; room_id: string; closed_at: string | null };
let refs: Ref[] = [];
let commands: Array<{ roomId: string; kind: string; args: string | null; source: string }> = [];
let installs: Array<{ room_id: string; hostname: string; app_version: string | null }> = [];
let throwOn: RegExp | null = null;
let hang = false;
let fetchImpl: (url: string, init: RequestInit) => Promise<Response> = async () => new Response(JSON.stringify({ window: true }), { status: 200 });
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let releaseHang: (() => void) | null = null;
const writes: string[] = [];

vi.mock("@/lib/db", () => ({
  sql: async (s: TemplateStringsArray, ...v: unknown[]) => {
    const q = s.join("?");
    if (throwOn && throwOn.test(q)) throw new Error("boom: secret-value");
    if (/INSERT INTO pulse_presence_events/.test(q)) {
      const rows = JSON.parse(v[0] as string) as unknown[];
      return rows.map((_, i) => ({ id: i + 1 }));
    }
    if (hang && /FROM room_install/.test(q)) {
      const gate = v[0] as string[];
      return new Promise((res) => { releaseHang = () => res(installs.filter((i) => gate.includes(i.room_id))); });
    }
    if (/FROM room_install/.test(q)) {
      const gate = v[0] as string[];
      return installs.filter((i) => gate.includes(i.room_id));
    }
    if (/FROM buddy_consult_ref/.test(q) && /SELECT 1/.test(q)) {
      return refs.some((r) => r.consult_uid === (v[0] as string)) ? [{ one: 1 }] : [];
    }
    if (/WITH made AS/.test(q)) {
      // one statement: the ref row and its command, atomically
      writes.push("ref_and_command");
      const [opaque, uid, room, , , cmd] = v as string[];
      if (refs.some((r) => r.consult_uid === uid)) return [];
      refs.push({ opaque_id: opaque!, consult_uid: uid!, room_id: room!, closed_at: null });
      commands.push({ roomId: room!, kind: "consult_started", args: JSON.stringify({ opaque_id: opaque }), source: "buddy" });
      return [{ id: cmd }];
    }
    if (/WITH closed AS/.test(q)) {
      writes.push("ref_and_command");
      const [ts, uid, cmd] = v as string[];
      const r = refs.find((x) => x.consult_uid === uid && x.closed_at === null);
      if (!r) return [];
      r.closed_at = ts!;
      commands.push({ roomId: r.room_id, kind: "consult_ended", args: JSON.stringify({ opaque_id: r.opaque_id }), source: "buddy" });
      return [{ id: cmd }];
    }
    return [];
  },
}));

import { POST } from "../../app/api/presence/route";
import { relayInserted, RELAY_TIMEOUT_MS, DECIDE_PATH } from "@/lib/buddy/relay";
import { COMMAND_KINDS } from "@/lib/bench-commands";

const TOKEN = "test-presence-token";
const UID = "consult-fixture-1";
const nowIso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const ext = (over: Record<string, unknown> = {}) => ({
  machine_id: "MAC-FIX-1", room: "ROOM-FIX", email: "fixture.one@example.test", display_name: null, event: "heartbeat",
  encounter_id: null, prescription_ref: null, ts: nowIso(), tab_focus: true,
  impersonating: false, ext_version: "0.1.0", reason: null, ...over,
});
const open = (uid: string | null = UID) => ext({ event: "encounter_open", encounter_id: uid });
const close = (uid: string | null = UID) => ext({ event: "encounter_close", encounter_id: uid });
const rowOf = (over: Record<string, unknown> = {}) => ({ source: "ext" as const, machine: "MAC-FIX-1", room: null, event: "encounter_open", ts: nowIso(), email: null, payload: { encounter_id: UID }, ...over });
const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/presence", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) }));
const raw = async (res: Response) => ({ status: res.status, body: await res.text() });

beforeEach(() => {
  refs = []; commands = []; writes.length = 0; throwOn = null; hang = false; releaseHang = null;
  installs = [{ room_id: "room_fix_1", hostname: "MAC-FIX-1", app_version: "0.1.30" }];
  process.env.PRESENCE_INGEST_TOKEN = TOKEN;
  process.env.BUDDY_RELAY_ROOMS = "room_fix_1";
  process.env.NEWCAT_BASE_URL = "https://newcat.example.test";
  process.env.NEWCAT_RELAY_KEY = "test-relay-key-value";
  fetchCalls.length = 0;
  fetchImpl = async () => new Response(JSON.stringify({ window: true }), { status: 200 });
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => { fetchCalls.push({ url, init }); return fetchImpl(url, init); });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.BUDDY_RELAY_ROOMS;
  delete process.env.NEWCAT_BASE_URL;
  delete process.env.NEWCAT_RELAY_KEY;
});

describe("Encounter Buddy L1 relay", () => {
  it("the two kinds are in COMMAND_KINDS", () => {
    expect(COMMAND_KINDS).toContain("consult_started");
    expect(COMMAND_KINDS).toContain("consult_ended");
  });

  it("open creates one ref and one consult_started command", async () => {
    const res = await post([open()]);
    expect(res.status).toBe(200);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.consult_uid).toBe(UID);
    expect(refs[0]!.opaque_id).toMatch(/^[0-9a-f]{32}$/);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ roomId: "room_fix_1", kind: "consult_started", source: "buddy" });
  });

  it("a duplicate open sends nothing", async () => {
    await post([open()]);
    await post([open()]);
    expect(refs).toHaveLength(1);
    expect(commands).toHaveLength(1);
  });

  it("close updates the ref and sends one consult_ended; a second close sends nothing", async () => {
    await post([open()]);
    await post([close()]);
    expect(refs[0]!.closed_at).not.toBeNull();
    expect(commands.map((c) => c.kind)).toEqual(["consult_started", "consult_ended"]);
    await post([close()]);
    expect(commands).toHaveLength(2);
  });

  it("close without an open sends nothing", async () => {
    await post([close()]);
    expect(commands).toHaveLength(0);
    expect(refs).toHaveLength(0);
  });

  it("command args contain only opaque_id", async () => {
    await post([open(), close()]);
    expect(commands).toHaveLength(2);
    for (const c of commands) {
      expect(Object.keys(JSON.parse(c.args!))).toEqual(["opaque_id"]);
      expect(c.args).not.toContain(UID);
    }
    expect(JSON.parse(commands[0]!.args!).opaque_id).toBe(refs[0]!.opaque_id);
  });

  it("room not in BUDDY_RELAY_ROOMS: no writes at all", async () => {
    process.env.BUDDY_RELAY_ROOMS = "room_other";
    await post([open(), close()]);
    expect(writes).toEqual([]);
  });

  it("env unset or empty: relay is off, no writes", async () => {
    delete process.env.BUDDY_RELAY_ROOMS;
    await post([open()]);
    process.env.BUDDY_RELAY_ROOMS = " , ";
    await post([open()]);
    expect(writes).toEqual([]);
  });

  it("an app below the version floor gets nothing", async () => {
    installs[0]!.app_version = "0.1.21";
    await post([open()]);
    expect(writes).toEqual([]);
  });

  it("an unknown machine gets nothing", async () => {
    await post([ext({ machine_id: "MAC-FIX-9", event: "encounter_open", encounter_id: UID })]);
    expect(writes).toEqual([]);
  });

  it("open without an encounter_id, heartbeat and other events do nothing", async () => {
    await post([open(null), ext(), ext({ event: "login" }), ext({ event: "idle", encounter_id: UID })]);
    expect(writes).toEqual([]);
  });

  it("a relay throw leaves the ingest response byte-identical", async () => {
    const off = await raw(await post([open()]));
    refs = []; commands = [];
    throwOn = /buddy_consult_ref|room_install/;
    const on = await raw(await post([open()]));
    expect(on).toEqual(off);
    expect(on.status).toBe(200);
    expect(JSON.parse(on.body)).toMatchObject({ ok: true, inserted: 1 });
    expect(commands).toHaveLength(0);
  });

  it("a relay failure logs counts only", async () => {
    throwOn = /buddy_consult_ref/;
    await post([open()]);
    const logged = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("[buddy-relay]");
    expect(logged).not.toContain("secret-value");
    expect(logged).not.toContain(UID);
  });

  it("a hung relay is cut at the timeout, and when the read finally returns it writes nothing", async () => {
    vi.useFakeTimers();
    hang = true;
    const p = relayInserted([rowOf()]);
    await vi.advanceTimersByTimeAsync(RELAY_TIMEOUT_MS + 1);
    await expect(p).resolves.toBeUndefined();
    releaseHang!();
    await vi.advanceTimersByTimeAsync(10);
    expect(writes).toEqual([]);
    expect(refs).toHaveLength(0);
    expect(commands).toHaveLength(0);
  });

  it("the ref row and its command land in one statement", async () => {
    await post([open()]);
    expect(writes).toEqual(["ref_and_command"]);
  });

  it("consult_ended goes to the room stored on the ref, not the closing machine's room", async () => {
    installs.push({ room_id: "room_fix_2", hostname: "MAC-FIX-2", app_version: "0.1.30" });
    process.env.BUDDY_RELAY_ROOMS = "room_fix_1,room_fix_2";
    await post([open()]);
    await post([ext({ machine_id: "MAC-FIX-2", event: "encounter_close", encounter_id: UID })]);
    expect(commands.map((c) => [c.roomId, c.kind])).toEqual([["room_fix_1", "consult_started"], ["room_fix_1", "consult_ended"]]);
  });

  it("freshness: an event older than 120 s or more than 30 s ahead is ignored; inside the window it is relayed", async () => {
    await post([ext({ event: "encounter_open", encounter_id: "old-1", ts: nowIso(-121_000) })]);
    await post([ext({ event: "encounter_open", encounter_id: "future-1", ts: nowIso(31_000) })]);
    expect(writes).toEqual([]);
    await post([ext({ event: "encounter_open", encounter_id: "ok-1", ts: nowIso(-100_000) })]);
    await post([ext({ event: "encounter_open", encounter_id: "ok-2", ts: nowIso(20_000) })]);
    expect(commands).toHaveLength(2);
  });

  it("only source ext is relayed", async () => {
    await relayInserted([rowOf({ source: "poller" }), rowOf({ source: "guard" })]);
    expect(writes).toEqual([]);
  });

  it("a blank or whitespace-only encounter_id is not a consult; a padded one is trimmed", async () => {
    await post([open("   "), open("")]);
    expect(writes).toEqual([]);
    await post([open("  " + UID + "  ")]);
    expect(refs.map((r) => r.consult_uid)).toEqual([UID]);
  });

  // ---- DECIDE (A1-C6, A2-C1, A2-C5, A2-C6) ----
  const logs = () => [console.warn, console.info].flatMap((f) => (f as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))).join("\n");

  it("decide true: one ref row and one command; the request body is exactly the contract", async () => {
    await post([ext({ event: "encounter_open", encounter_id: UID, doctor_uid: "doc-fixture-1" })]);
    expect(refs).toHaveLength(1);
    expect(commands).toHaveLength(1);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(`https://newcat.example.test${DECIDE_PATH}`);
    const h = fetchCalls[0]!.init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer test-relay-key-value");
    const body = JSON.parse(fetchCalls[0]!.init.body as string);
    expect(Object.keys(body).sort()).toEqual(["consult_uid", "doctor_uid", "opaque_id", "room_id"]);
    expect(body).toMatchObject({ consult_uid: UID, room_id: "room_fix_1", doctor_uid: "doc-fixture-1", opaque_id: refs[0]!.opaque_id });
  });

  it("decide false: nothing is written", async () => {
    fetchImpl = async () => new Response(JSON.stringify({ window: false }), { status: 200 });
    await post([open()]);
    expect(writes).toEqual([]);
    expect(refs).toHaveLength(0);
    expect(commands).toHaveLength(0);
    expect(logs()).toContain("decide_false=1");
  });

  it("a 500, garbage, a non-boolean window, a network error: nothing written, ingest reply unchanged", async () => {
    const baseline = await raw(await post([open("baseline-1")]));
    refs = []; commands = []; writes.length = 0;
    const faults: Array<() => Promise<Response>> = [
      async () => new Response("{}", { status: 500 }),
      async () => new Response("not json at all", { status: 200 }),
      async () => new Response(JSON.stringify({ window: "yes" }), { status: 200 }),
      async () => new Response(JSON.stringify({}), { status: 200 }),
      async () => { throw new Error("network down secret-value"); },
    ];
    for (const f of faults) {
      fetchImpl = f;
      const r = await raw(await post([open("baseline-1")]));
      expect(r).toEqual(baseline);
    }
    expect(writes).toEqual([]);
    expect(commands).toHaveLength(0);
    expect(logs()).toContain("decide_fault=1");
    expect(logs()).not.toContain("secret-value");
  });

  it("NEWCAT_BASE_URL or NEWCAT_RELAY_KEY unset: fail closed, no call, nothing written", async () => {
    delete process.env.NEWCAT_RELAY_KEY;
    await post([open()]);
    process.env.NEWCAT_RELAY_KEY = "k";
    delete process.env.NEWCAT_BASE_URL;
    await post([open()]);
    expect(fetchCalls).toHaveLength(0);
    expect(writes).toEqual([]);
  });

  it("a null or blank doctor_uid is passed as null", async () => {
    await post([open()]);
    await post([ext({ event: "encounter_open", encounter_id: "u-blank", doctor_uid: "   " })]);
    await post([ext({ event: "encounter_open", encounter_id: "u-num", doctor_uid: 7 })]);
    expect(fetchCalls.map((c) => JSON.parse(c.init.body as string).doctor_uid)).toEqual([null, null, null]);
  });

  it("decide hanging: the ingest POST returns within the 2 s bound, identical to the no-relay reply, and nothing is written", async () => {
    delete process.env.BUDDY_RELAY_ROOMS;
    const baseline = await raw(await post([open("hang-1")]));
    process.env.BUDDY_RELAY_ROOMS = "room_fix_1";
    fetchImpl = () => new Promise<Response>(() => {});
    const t0 = Date.now();
    const r = await raw(await post([open("hang-1")]));
    const took = Date.now() - t0;
    expect(took).toBeLessThan(RELAY_TIMEOUT_MS + 500);
    expect(r).toEqual(baseline);
    expect(writes).toEqual([]);
  });

  it("decide resolving after the budget writes nothing", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    fetchImpl = () => new Promise<Response>((res) => { release = () => res(new Response(JSON.stringify({ window: true }), { status: 200 })); });
    const p = relayInserted([rowOf()]);
    await vi.advanceTimersByTimeAsync(RELAY_TIMEOUT_MS + 1);
    await expect(p).resolves.toBeUndefined();
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(writes).toEqual([]);
  });

  it("a repeat open for a known consult does not ask newcat again", async () => {
    await post([open()]);
    await post([open()]);
    expect(fetchCalls).toHaveLength(1);
    expect(commands).toHaveLength(1);
  });

  it("close never calls newcat; a close after a false decision writes nothing", async () => {
    fetchImpl = async () => new Response(JSON.stringify({ window: false }), { status: 200 });
    await post([open()]);
    const callsAfterOpen = fetchCalls.length;
    await post([close()]);
    expect(fetchCalls).toHaveLength(callsAfterOpen);
    expect(commands).toHaveLength(0);
  });

  it("no uid, opaque_id or room appears in any log line", async () => {
    await post([ext({ event: "encounter_open", encounter_id: UID, doctor_uid: "doc-fixture-1" })]);
    fetchImpl = async () => new Response("{}", { status: 500 });
    await post([ext({ event: "encounter_open", encounter_id: "u-2", doctor_uid: "doc-fixture-1" })]);
    const all = logs();
    expect(all).toContain("[buddy-relay]");
    for (const bad of [UID, "u-2", "doc-fixture-1", refs[0]!.opaque_id, "room_fix_1", "test-relay-key-value", "newcat.example.test"]) expect(all).not.toContain(bad);
  });
});

describe("F8: the operator route refuses the relay-only kinds", () => {
  it("consult_started and consult_ended answer 400 and enqueue nothing", async () => {
    vi.resetModules();
    const inserted: string[] = [];
    vi.doMock("@/lib/bench", () => ({ benchAdminGuard: async () => ({ ok: true, claims: { admin_id: "admin-fixture" } }) }));
    vi.doMock("@/lib/bench-commands", async (orig) => ({
      ...((await orig()) as object),
      insertCommand: async (a: { kind: string }) => { inserted.push(a.kind); return "cmd-fixture"; },
    }));
    const { POST: adminPost } = await import("../../app/api/admin/bench/command/route");
    for (const kind of ["consult_started", "consult_ended"]) {
      const res = await adminPost(new Request("http://localhost/api/admin/bench/command", { method: "POST", body: JSON.stringify({ room_id: "room_fix_1", kind }) }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, error: "relay_only_kind" });
    }
    expect(inserted).toEqual([]);
    expect(commands).toHaveLength(0);
    vi.doUnmock("@/lib/bench");
    vi.doUnmock("@/lib/bench-commands");
  });
});
