/**
 * Bench command bus lifecycle (Operator MCP S2) — lib/bench-commands with a MOCKED `sql`.
 * No live DB anywhere: migration 0044 is not applied; these tests pin the SQL shapes and the
 * pure decisions (supersede, expiry rule, ack transitions, idempotent start, room_paused,
 * bus_down / bus_not_migrated classification).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
type Call = { text: string; values: unknown[] };

const calls: Call[] = [];
let responder: (text: string, values: unknown[]) => Row[] | Promise<Row[]> = () => [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    return Promise.resolve(responder(text, values));
  };
  return { sql };
});

import {
  ackCommand,
  classifyBusError,
  cleanLevels,
  COMMAND_EXPIRY_SECONDS,
  decideStart,
  getListener,
  insertCommand,
  isListening,
  LISTENER_FRESH_MS,
  pollCommands,
  waitForAck,
  BusError,
} from "@/lib/bench-commands";

const NOW = new Date("2026-08-19T06:00:00.000Z");
const iso = (d: Date) => d.toISOString();
const secondsAgo = (s: number) => new Date(NOW.getTime() - s * 1000);

beforeEach(() => {
  calls.length = 0;
  responder = () => [];
});

const findCall = (re: RegExp) => calls.find((c) => re.test(c.text));

describe("pollCommands — poll lifecycle", () => {
  it("first poll of an empty room upserts the listener, expires stale-undelivered, returns pending oldest first", async () => {
    responder = (text) => {
      if (/FROM bench_listener/.test(text)) return [];
      if (/SELECT id, kind, args, created_at FROM bench_command/.test(text)) {
        return [
          { id: "cmd_a", kind: "start_day", args: null, created_at: iso(secondsAgo(2)) },
          { id: "cmd_b", kind: "pause_day", args: { x: 1 }, created_at: iso(secondsAgo(1)) },
        ];
      }
      return [];
    };
    const r = await pollCommands({ roomId: "room_1", tabId: "tab_A", prevPollAt: null, recordingSessionId: null, paused: false });
    expect(r.superseded).toBe(false);
    if (r.superseded) return;
    expect(r.commands.map((c) => c.id)).toEqual(["cmd_a", "cmd_b"]);
    const upsert = findCall(/INSERT INTO bench_listener/);
    expect(upsert).toBeTruthy();
    expect(upsert!.text).toContain("ON CONFLICT (room_id) DO UPDATE");
    expect(upsert!.values.slice(0, 2)).toEqual(["room_1", "tab_A"]);
    const expire = findCall(/UPDATE bench_command SET status = 'expired'/);
    expect(expire).toBeTruthy();
    expect(expire!.text).toContain("status = 'pending'");
    expect(expire!.text).toContain("INTERVAL '1 second'");
    expect(expire!.values).toContain(COMMAND_EXPIRY_SECONDS);
    // no previous listener → prevPoll null → every stale pending is expired
    expect(expire!.values).toContain(null);
    const sel = findCall(/SELECT id, kind, args, created_at FROM bench_command/);
    expect(sel!.text).toContain("status = 'pending'");
    expect(sel!.text).toContain("ORDER BY created_at ASC");
  });

  it("15 s expiry excludes commands already delivered by the previous poll", async () => {
    const prev = secondsAgo(1.5);
    responder = (text) => {
      if (/FROM bench_listener/.test(text)) return [{ room_id: "room_1", tab_id: "tab_A", last_poll_at: iso(prev), recording_session_id: null, paused: false }];
      return [];
    };
    await pollCommands({ roomId: "room_1", tabId: "tab_A", prevPollAt: prev, recordingSessionId: "bs_x", paused: false });
    const expire = findCall(/UPDATE bench_command SET status = 'expired'/);
    expect(expire).toBeTruthy();
    // created_at > previous poll → only rows no poll has delivered
    expect(expire!.text).toContain("created_at > ?::timestamptz");
    expect(expire!.values).toContain(iso(prev));
  });

  it("D4 last-poll-wins: an older tab is superseded when another tab polled more recently", async () => {
    responder = (text) => {
      if (/FROM bench_listener/.test(text)) return [{ room_id: "room_1", tab_id: "tab_B", last_poll_at: iso(secondsAgo(1)), recording_session_id: null, paused: false }];
      return [];
    };
    const r = await pollCommands({ roomId: "room_1", tabId: "tab_A", prevPollAt: secondsAgo(3), recordingSessionId: null, paused: false });
    expect(r.superseded).toBe(true);
    if (!r.superseded) return;
    expect(r.owner_tab_id).toBe("tab_B");
    // superseded tab must NOT upsert or read commands
    expect(findCall(/INSERT INTO bench_listener/)).toBeUndefined();
    expect(findCall(/SELECT id, kind, args, created_at FROM bench_command/)).toBeUndefined();
  });

  it("D4: a fresh tab (no previous poll) takes over from the stored tab", async () => {
    responder = (text) => {
      if (/FROM bench_listener/.test(text)) return [{ room_id: "room_1", tab_id: "tab_A", last_poll_at: iso(secondsAgo(1)), recording_session_id: null, paused: false }];
      return [];
    };
    const r = await pollCommands({ roomId: "room_1", tabId: "tab_B", prevPollAt: null, recordingSessionId: null, paused: false });
    expect(r.superseded).toBe(false);
    expect(findCall(/INSERT INTO bench_listener/)!.values[1]).toBe("tab_B");
  });

  it("D4: the same tab is never superseded by its own row", async () => {
    responder = (text) => {
      if (/FROM bench_listener/.test(text)) return [{ room_id: "room_1", tab_id: "tab_A", last_poll_at: iso(secondsAgo(1)), recording_session_id: null, paused: false }];
      return [];
    };
    const r = await pollCommands({ roomId: "room_1", tabId: "tab_A", prevPollAt: secondsAgo(10), recordingSessionId: null, paused: true });
    expect(r.superseded).toBe(false);
    expect(findCall(/INSERT INTO bench_listener/)!.values).toContain(true); // paused flag stored
  });

  it("appends a PHI-free IST-day sample when a measured level arrives", async () => {
    responder = () => [];
    await pollCommands({
      roomId: "room_1",
      tabId: "tab_A",
      prevPollAt: null,
      recordingSessionId: "bs_live",
      paused: false,
      mic: { peak: 0.42, avg: 0.12, zeroRatio: 0.07 },
    });
    const append = findCall(/INSERT INTO bench_level_sample/);
    expect(append).toBeTruthy();
    expect(append!.text).toContain("AT TIME ZONE 'Asia/Kolkata'");
    expect(append!.values).toEqual([
      "room_1",
      0.42,
      0.12,
      0.07,
      true,
      true,
    ]);
  });
});

describe("cleanLevels", () => {
  it("accepts peak-only native heartbeats and optional zero ratio", () => {
    expect(cleanLevels({ peak: 0.4, zero_ratio: 0.98 })).toEqual({
      peak: 0.4,
      avg: null,
      zeroRatio: 0.98,
    });
  });

  it("rejects missing or out-of-range peaks instead of inventing silence", () => {
    expect(cleanLevels({})).toBeNull();
    expect(cleanLevels({ peak: 2, avg: 0.1 })).toBeNull();
    expect(cleanLevels({ peak: 0.1, zero_ratio: -1 })).toBeNull();
  });
});

describe("ackCommand — pending → acked | failed", () => {
  it("acks a pending command with the session id and returns 'acked'", async () => {
    responder = (text) => (/UPDATE bench_command SET status = \?/.test(text) ? [{ id: "cmd_a" }] : []);
    const st = await ackCommand({ roomId: "room_1", commandId: "cmd_a", ok: true, sessionId: "bs_new" });
    expect(st).toBe("acked");
    const upd = findCall(/UPDATE bench_command SET status = \?/)!;
    expect(upd.values[0]).toBe("acked");
    expect(JSON.parse(String(upd.values[1]))).toEqual({ ok: true, session_id: "bs_new" });
    expect(upd.values[2]).toBeNull(); // error column null on ack
    expect(upd.text).toContain("status = 'pending' RETURNING id"); // only a pending row of this room
    expect(upd.values).toContain("room_1");
  });

  it("fails a pending command with the kiosk's error", async () => {
    responder = () => [{ id: "cmd_a" }];
    const st = await ackCommand({ roomId: "room_1", commandId: "cmd_a", ok: false, error: "room_paused" });
    expect(st).toBe("failed");
    const upd = findCall(/UPDATE bench_command SET status = \?/)!;
    expect(upd.values[0]).toBe("failed");
    expect(upd.values[2]).toBe("room_paused");
  });

  it("returns null when no pending row matches (already acked, expired, or another room)", async () => {
    responder = () => [];
    expect(await ackCommand({ roomId: "room_2", commandId: "cmd_a", ok: true })).toBeNull();
  });
});

describe("insertCommand / waitForAck", () => {
  it("inserts a pending 'mcp' command with a cmd_ id and jsonb args", async () => {
    const id = await insertCommand({ roomId: "room_1", kind: "start_day", args: { override_pause: true } });
    expect(id).toMatch(/^cmd_[a-z2-9]{8}$/);
    const ins = findCall(/INSERT INTO bench_command/)!;
    expect(ins.text).toContain("'pending'");
    expect(ins.values).toEqual([id, "room_1", "start_day", JSON.stringify({ override_pause: true }), "mcp"]);
  });

  it("waitForAck resolves once the row leaves pending, and times out to null otherwise", async () => {
    let n = 0;
    responder = (text) => {
      if (/FROM bench_command WHERE id/.test(text)) {
        n++;
        return [{ id: "cmd_a", room_id: "room_1", kind: "start_day", args: null, status: n < 3 ? "pending" : "acked", source: "mcp", result: { ok: true, session_id: "bs_new" }, error: null, created_at: iso(NOW), acked_at: iso(NOW) }];
      }
      return [];
    };
    const sleep = async () => undefined;
    const row = await waitForAck("cmd_a", { timeoutMs: 5_000, intervalMs: 1, sleep });
    expect(row?.status).toBe("acked");
    expect((row?.result as { session_id: string }).session_id).toBe("bs_new");
    expect(n).toBe(3);

    responder = () => [{ id: "cmd_b", status: "pending", room_id: "room_1", kind: "end_day", args: null, source: "mcp", result: null, error: null, created_at: iso(NOW), acked_at: null }];
    const none = await waitForAck("cmd_b", { timeoutMs: 0, intervalMs: 1, sleep });
    expect(none).toBeNull();
  });
});

describe("decideStart — safe / consent-aware start (PRD §11.1)", () => {
  const live = (ageMs: number, extra: Partial<{ recording_session_id: string | null; paused: boolean }> = {}) => ({
    room_id: "room_1",
    tab_id: "tab_A",
    last_poll_at: new Date(NOW.getTime() - ageMs),
    recording_session_id: null,
    paused: false,
    ...extra,
  });

  it("no listener / stale listener → kiosk_not_listening (no command)", () => {
    expect(decideStart({ listener: null, activeSession: null, overridePause: false, now: NOW })).toEqual({ action: "reject", error: "kiosk_not_listening" });
    expect(decideStart({ listener: live(LISTENER_FRESH_MS + 1), activeSession: null, overridePause: false, now: NOW })).toEqual({ action: "reject", error: "kiosk_not_listening" });
    expect(isListening(live(LISTENER_FRESH_MS), NOW)).toBe(true);
  });

  it("already recording → return the live session, no second tape", () => {
    expect(decideStart({ listener: live(500), activeSession: { id: "bs_live", status: "recording" }, overridePause: false, now: NOW })).toEqual({ action: "already_recording", session_id: "bs_live" });
    // kiosk-reported live session counts too
    expect(decideStart({ listener: live(500, { recording_session_id: "bs_k" }), activeSession: null, overridePause: false, now: NOW })).toEqual({ action: "already_recording", session_id: "bs_k" });
  });

  it("paused-for-consent → room_paused unless override_pause (then send with the audited flag)", () => {
    expect(decideStart({ listener: live(500, { paused: true, recording_session_id: "bs_p" }), activeSession: { id: "bs_p", status: "paused" }, overridePause: false, now: NOW })).toEqual({ action: "reject", error: "room_paused" });
    expect(decideStart({ listener: live(500, { paused: true, recording_session_id: "bs_p" }), activeSession: { id: "bs_p", status: "paused" }, overridePause: true, now: NOW })).toEqual({ action: "send", args: { override_pause: true } });
  });

  it("idle listening room → send start_day with no args", () => {
    expect(decideStart({ listener: live(500), activeSession: null, overridePause: false, now: NOW })).toEqual({ action: "send", args: null });
  });
});

describe("runtime guard — bus_not_migrated / bus_down", () => {
  it("classifies 42P01 / relation-does-not-exist as bus_not_migrated, everything else as bus_down", () => {
    expect(classifyBusError({ code: "42P01", message: 'relation "bench_command" does not exist' }).code).toBe("bus_not_migrated");
    expect(classifyBusError(new Error('relation "bench_listener" does not exist')).code).toBe("bus_not_migrated");
    expect(classifyBusError(new Error("connect ECONNREFUSED")).code).toBe("bus_down");
    expect(classifyBusError(new BusError("bus_down")).code).toBe("bus_down");
  });

  it("getListener surfaces a BusError (routes → 503, tools → error field)", async () => {
    responder = () => {
      const e = new Error('relation "bench_listener" does not exist') as Error & { code?: string };
      e.code = "42P01";
      throw e;
    };
    await expect(getListener("room_1")).rejects.toMatchObject({ code: "bus_not_migrated" });
    responder = () => {
      throw new Error("timeout");
    };
    await expect(pollCommands({ roomId: "room_1", tabId: "t", prevPollAt: null, recordingSessionId: null, paused: false })).rejects.toMatchObject({ code: "bus_down" });
  });
});
