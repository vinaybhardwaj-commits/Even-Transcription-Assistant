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
import { relayInserted, RELAY_TIMEOUT_MS } from "@/lib/buddy/relay";
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
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.BUDDY_RELAY_ROOMS;
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
});
