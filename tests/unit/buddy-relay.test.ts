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
let fetchImpl: (url: string, init: RequestInit) => Promise<Response> = async () => new Response(JSON.stringify({ window: true, live: true, reason_code: null }), { status: 200 });
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
import { relayInserted, RELAY_TIMEOUT_MS, DECIDE_PATH, DOCTOR_RESOLVE_TIMEOUT_MS, DECIDE_TIMEOUT_MS } from "@/lib/buddy/relay";
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
  fetchImpl = async () => new Response(JSON.stringify({ window: true, live: true, reason_code: null }), { status: 200 });
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
    expect(Object.keys(body).sort()).toEqual(["consult_uid", "doctor_uid", "opaque_id", "room"]);
    expect(body).toMatchObject({ consult_uid: UID, room: "room_fix_1", doctor_uid: "doc-fixture-1", opaque_id: refs[0]!.opaque_id });
  });

  it("decide false: nothing is written", async () => {
    fetchImpl = async () => new Response(JSON.stringify({ window: false, live: false, reason_code: "no" }), { status: 200 });
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
      async () => new Response(JSON.stringify({ window: true }), { status: 200 }),
      async () => new Response(JSON.stringify({ window: true, live: "yes", reason_code: null }), { status: 200 }),
      async () => new Response(JSON.stringify({ window: true, live: true }), { status: 200 }),
      async () => new Response(JSON.stringify({ reason_code: "conflict" }), { status: 409 }),
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
    fetchImpl = () => new Promise<Response>((res) => { release = () => res(new Response(JSON.stringify({ window: true, live: true, reason_code: null }), { status: 200 })); });
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
    fetchImpl = async () => new Response(JSON.stringify({ window: false, live: false, reason_code: "no" }), { status: 200 });
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

const logs = () => [console.warn, console.info].flatMap((f) => (f as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))).join("\n");

describe("Encounter Buddy: server-side doctor resolve", () => {
  const CU = "abcdefghij0123456789abcd"; // 24 chars, passes ^[a-z0-9]{20,32}$
  const MB = "https://mb.example.test";
  const mbCalls: Array<{ body: { database: number; type: string; native: { query: string } }; key: string }> = [];
  let mbImpl: () => Promise<Response> = async () => mbRows([]);
  const mbRows = (docs: unknown[]) => new Response(JSON.stringify({ data: { cols: [{ name: "doctor_uid" }], rows: docs.map((d) => [d]) } }), { status: 200 });
  const decideBodies = () => fetchCalls.filter((c) => c.url.includes(DECIDE_PATH)).map((c) => JSON.parse(c.init.body as string));
  beforeEach(() => {
    mbCalls.length = 0;
    mbImpl = async () => mbRows([]);
    process.env.METABASE_URL = MB;
    process.env.METABASE_API_KEY = "mb-key-value";
    fetchImpl = async (url, init) => {
      if (url.startsWith(MB)) {
        mbCalls.push({ body: JSON.parse(init.body as string), key: (init.headers as Record<string, string>)["x-api-key"]! });
        return mbImpl();
      }
      return new Response(JSON.stringify({ window: true, live: true, reason_code: null }), { status: 200 });
    };
  });
  afterEach(() => { delete process.env.METABASE_URL; delete process.env.METABASE_API_KEY; });
  const openCU = (extra: Record<string, unknown> = {}) => ext({ event: "encounter_open", encounter_id: CU, ...extra });

  it("an exact single resolve is used and sent to newcat; the query is the db13 SELECT", async () => {
    mbImpl = async () => mbRows(["doc-res-1", "doc-res-1"]);
    await post([openCU()]);
    expect(mbCalls).toHaveLength(1);
    expect(mbCalls[0]!.body.database).toBe(13);
    expect(mbCalls[0]!.body.native.query).toBe(`SELECT doctor_uid FROM "accounts-members-calendar_events" WHERE uid = '${CU}'`);
    expect(mbCalls[0]!.key).toBe("mb-key-value");
    expect(decideBodies()[0].doctor_uid).toBe("doc-res-1");
    expect(refs).toHaveLength(1);
  });

  it("a payload doctor_uid is kept and no resolve is made", async () => {
    await post([openCU({ doctor_uid: "doc-pay-1" })]);
    expect(mbCalls).toHaveLength(0);
    expect(decideBodies()[0].doctor_uid).toBe("doc-pay-1");
  });

  it("zero rows and several distinct rows give null", async () => {
    await post([openCU()]);
    mbImpl = async () => mbRows(["doc-a", "doc-b"]);
    await post([openCU({ encounter_id: "zyxwvutsrq9876543210abcd" })]);
    expect(decideBodies().map((b) => b.doctor_uid)).toEqual([null, null]);
  });

  it("a consult_uid outside ^[a-z0-9]{20,32}$ is never sent to Metabase", async () => {
    await post([openCU({ encounter_id: "x' OR '1'='1" })]);
    expect(mbCalls).toHaveLength(0);
    expect(decideBodies()[0].doctor_uid).toBeNull();
  });

  it("C3: a 19-char consult_uid counts unsafe=1 and makes no Metabase call", async () => {
    await post([openCU({ encounter_id: "abcdefghij012345678" })]);
    expect(mbCalls).toHaveLength(0);
    expect(logs()).toContain("doctor_resolve_unsafe_uid=1");
    expect(logs()).toContain("doctor_resolve_null=0");
    expect(logs()).not.toContain("abcdefghij012345678");
  });

  it("C3: zero rows and two distinct rows each count null=1", async () => {
    await post([openCU()]);
    expect(logs()).toContain("doctor_resolve_null=1");
    (console.info as unknown as { mockClear: () => void }).mockClear();
    mbImpl = async () => mbRows(["doc-a", "doc-b"]);
    await post([openCU({ encounter_id: "zyxwvutsrq9876543210abcd" })]);
    expect(logs()).toContain("doctor_resolve_null=1");
    expect(logs()).toContain("doctor_resolve_unsafe_uid=0");
  });

  it("C5: on race loss the Metabase fetch signal is aborted within 100 ms of the cap", async () => {
    let sig: AbortSignal | undefined;
    let abortedAt = 0;
    fetchImpl = async (url, init) => {
      if (url.startsWith(MB)) {
        sig = init.signal as AbortSignal;
        sig.addEventListener("abort", () => { abortedAt = Date.now(); });
        return new Promise<Response>(() => {});
      }
      return new Response(JSON.stringify({ window: true, live: true, reason_code: null }), { status: 200 });
    };
    const t0 = Date.now();
    await post([openCU()]);
    expect(sig).toBeDefined();
    expect(sig!.aborted).toBe(true);
    expect(abortedAt - t0).toBeLessThan(DOCTOR_RESOLVE_TIMEOUT_MS + 100);
    expect(abortedAt - t0).toBeGreaterThanOrEqual(DOCTOR_RESOLVE_TIMEOUT_MS - 50);
  });

  it("the last_doctor_uid hint is never used; its count is logged when the resolve found nothing", async () => {
    await post([openCU({ last_doctor_uid: "doc-hint-1" })]);
    expect(decideBodies()[0].doctor_uid).toBeNull();
    expect(logs()).toContain("doctor_hint_would_help=1");
    expect(logs()).not.toContain("doc-hint-1");
  });

  it("a timeout, a 500 or garbage gives null; the ingest reply is byte-identical; fault counted", async () => {
    delete process.env.METABASE_URL;
    const baseline = await raw(await post([openCU()]));
    process.env.METABASE_URL = MB;
    refs = []; commands = [];
    const faults: Array<() => Promise<Response>> = [
      async () => new Response("{}", { status: 500 }),
      async () => new Response("garbage", { status: 200 }),
      async () => { throw new Error("net secret-value"); },
    ];
    for (const f of faults) {
      mbImpl = f;
      expect(await raw(await post([openCU()]))).toEqual(baseline);
      refs = []; commands = [];
    }
    expect(decideBodies().slice(1).map((b) => b.doctor_uid)).toEqual([null, null, null]);
    expect(logs()).toContain("doctor_resolve_fault=1");
    expect(logs()).not.toContain("secret-value");
  });

  it("a hanging resolve is cut at 700 ms and decide still runs inside the 2 s budget", async () => {
    mbImpl = () => new Promise<Response>(() => {});
    const t0 = Date.now();
    await post([openCU()]);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(DOCTOR_RESOLVE_TIMEOUT_MS - 50);
    expect(took).toBeLessThan(RELAY_TIMEOUT_MS + 300);
    expect(DOCTOR_RESOLVE_TIMEOUT_MS + DECIDE_TIMEOUT_MS).toBeLessThanOrEqual(RELAY_TIMEOUT_MS);
    expect(decideBodies()).toHaveLength(1);
    expect(decideBodies()[0].doctor_uid).toBeNull();
    expect(logs()).toContain("doctor_resolve_fault=1");
  });

  it("METABASE env unset: no Metabase call, doctor_resolve_off counted, fail-closed null", async () => {
    delete process.env.METABASE_API_KEY;
    await post([openCU()]);
    expect(mbCalls).toHaveLength(0);
    expect(fetchCalls.filter((c) => c.url.startsWith(MB))).toHaveLength(0);
    expect(decideBodies()[0].doctor_uid).toBeNull();
    expect(logs()).toContain("doctor_resolve_off=1");
  });

  it("no uid appears in any log line", async () => {
    mbImpl = async () => mbRows(["doc-res-1"]);
    await post([openCU({ last_doctor_uid: "doc-hint-1" })]);
    mbImpl = async () => new Response("{}", { status: 500 });
    await post([openCU({ encounter_id: "zyxwvutsrq9876543210abcd", last_doctor_uid: "doc-hint-1" })]);
    const all = logs();
    for (const bad of [CU, "zyxwvutsrq9876543210abcd", "doc-res-1", "doc-hint-1", "mb.example.test", "mb-key-value"]) expect(all).not.toContain(bad);
  });
});

describe("Encounter Buddy: newcat consult-started route", () => {
  it("posts to /v1/buddy/consult-started; a 409 conflict is a fault and writes nothing", async () => {
    expect(DECIDE_PATH).toBe("/v1/buddy/consult-started");
    fetchImpl = async () => new Response(JSON.stringify({ window: true, live: true, reason_code: null }), { status: 409 });
    await post([open()]);
    expect(refs).toHaveLength(0);
    expect(commands).toHaveLength(0);
    expect(logs()).toContain("decide_fault=1");
  });

  it("window true with live false still writes; live is only counted", async () => {
    fetchImpl = async () => new Response(JSON.stringify({ window: true, live: false, reason_code: null }), { status: 200 });
    await post([open()]);
    expect(refs).toHaveLength(1);
    expect(logs()).toContain("decide_live=0");
  });

  it("window true and live true writes and counts live", async () => {
    await post([open()]);
    expect(refs).toHaveLength(1);
    expect(logs()).toContain("decide_live=1");
  });
});

describe("Encounter Buddy: reason_code contract (RELAY-NR)", () => {
  const reply = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

  it("after a fleet lift, {window:true, live:true, reason_code:null} writes the ref row and command (decide_true)", async () => {
    fetchImpl = reply({ window: true, live: true, reason_code: null });
    await post([open()]);
    expect(refs).toHaveLength(1);
    expect(commands).toHaveLength(1);
    expect(logs()).toContain("decide_true=1");
  });

  it("while fleet_off, {window:false, live:false, reason_code:'fleet_off'} writes nothing (decide_false)", async () => {
    fetchImpl = reply({ window: false, live: false, reason_code: "fleet_off" });
    await post([open()]);
    expect(writes).toEqual([]);
    expect(logs()).toContain("decide_false=1");
  });

  it("a window opens after the lift and stays shut while fleet_off is set", async () => {
    fetchImpl = reply({ window: false, live: false, reason_code: "fleet_off" });
    await post([open("lift-1")]);
    expect(refs).toHaveLength(0);
    fetchImpl = reply({ window: true, live: true, reason_code: null });
    await post([open("lift-1")]);
    expect(refs).toHaveLength(1);
    const before = writes.length;
    fetchImpl = reply({ window: false, live: false, reason_code: "fleet_off" });
    await post([open("lift-2")]);
    expect(writes).toHaveLength(before);
    expect(refs).toHaveLength(1);
  });

  it("a shadow decision {window:false, live:true, reason_code:'fleet_off'} writes nothing (decide_false)", async () => {
    fetchImpl = reply({ window: false, live: true, reason_code: "fleet_off" });
    await post([open()]);
    expect(writes).toEqual([]);
    expect(logs()).toContain("decide_false=1");
  });

  it.each([
    ["window:true with a string reason", { window: true, live: true, reason_code: "fleet_off" }],
    ["window:false with null", { window: false, live: false, reason_code: null }],
    ["reason_code missing, window:true", { window: true, live: true }],
    ["reason_code missing, window:false", { window: false, live: false }],
    ["reason_code a number", { window: false, live: false, reason_code: 7 }],
    ["reason_code a number, window:true", { window: true, live: true, reason_code: 0 }],
    ["reason_code an empty string", { window: false, live: false, reason_code: "" }],
    ["reason_code not snake_case", { window: false, live: false, reason_code: "Fleet Off" }],
  ])("unparseable, writes nothing: %s", async (_n, body) => {
    fetchImpl = reply(body);
    await post([open()]);
    expect(writes).toEqual([]);
    expect(refs).toHaveLength(0);
    expect(commands).toHaveLength(0);
    expect(logs()).toContain("decide_fault=1");
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
