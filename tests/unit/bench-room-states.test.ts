/**
 * Tier 1 §2 — named install states. The seven rules at every boundary, the ring and its carried
 * silence count, the 0.1.21 fallback, the write-only-on-change rule, the poll's "recording", the
 * desk switch that sets the expected device, migration 0081, and the fleet surfaces.
 *
 * No live database: `sql` is mocked and every statement is captured. The SQL is pinned by shape;
 * the rules are pure and are proven here directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

type Row = Record<string, unknown>;
type Call = { text: string; values: unknown[] };

const calls: Call[] = [];
let responder: (text: string, values: unknown[]) => Row[] | Promise<Row[]> = () => [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    try {
      return Promise.resolve(responder(text, values));
    } catch (e) {
      return Promise.reject(e);
    }
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});

const C = await import("@/lib/bench-bus-constants");
const RI = await import("@/lib/room-install");
const BC = await import("@/lib/bench-commands");
const V = await import("@/lib/room-install-view");
const { FleetTable } = await import("@/components/admin/BenchInstallFleet");

beforeEach(() => {
  calls.length = 0;
  responder = () => [];
});

const NOW_MS = Date.parse("2026-09-11T16:00:00.000Z");
const entry = (over: Partial<import("@/lib/bench-bus-constants").PollRingEntry> = {}) => ({
  at: new Date(NOW_MS).toISOString(),
  peak: 0.2,
  zero_ratio: 0.001,
  tape_advancing: true,
  rec: true,
  silent_polls: 0,
  ...over,
});
const base = (over: Partial<Parameters<typeof C.evaluateInstallStates>[0]> = {}) =>
  C.evaluateInstallStates({
    ring: [entry()],
    recording: true,
    tapeAdvancing: true,
    inputDeviceName: "C270 HD WEBCAM",
    inputDevices: [{ name: "C270 HD WEBCAM" }, { name: "TONOR TM20 Audio Device" }],
    expectedDeviceName: "C270 HD WEBCAM",
    diskFreeBytes: 400e9,
    updateChannel: "stable",
    assignedChannel: null,
    prev: { flags: [], drift_since: null },
    nowMs: NOW_MS,
    ...over,
  });

// ---------------------------------------------------------------------------
// The rules, at their boundaries
// ---------------------------------------------------------------------------

describe("a healthy recording room raises nothing", () => {
  it("returns the empty record", () => {
    expect(base()).toEqual({ flags: [], drift_since: null });
  });
});

describe("SILENT_WHILE_RECORDING", () => {
  it("fires at exactly SILENT_POLLS carried silent polls, not one before", () => {
    expect(C.SILENT_POLLS).toBe(80);
    expect(base({ ring: [entry({ silent_polls: 79 })] }).flags).not.toContain("SILENT_WHILE_RECORDING");
    expect(base({ ring: [entry({ silent_polls: 80 })] }).flags).toContain("SILENT_WHILE_RECORDING");
  });

  it("never fires on a paused room — `recording` is false while paused", () => {
    expect(base({ recording: false, ring: [entry({ silent_polls: 500, rec: false })] }).flags).toEqual([]);
  });

  it("needs the tape to be advancing on this poll", () => {
    expect(base({ tapeAdvancing: false, ring: [entry({ silent_polls: 80 })] }).flags).not.toContain("SILENT_WHILE_RECORDING");
    expect(base({ tapeAdvancing: null, ring: [entry({ silent_polls: 80 })] }).flags).not.toContain("SILENT_WHILE_RECORDING");
  });

  it("0.1.22: silence_ms decides on its own when present — SILENT_MS is the boundary", () => {
    expect(C.SILENT_MS).toBe(80 * 1_500);
    expect(base({ silenceMs: C.SILENT_MS - 1 }).flags).not.toContain("SILENT_WHILE_RECORDING");
    expect(base({ silenceMs: C.SILENT_MS }).flags).toContain("SILENT_WHILE_RECORDING");
    // Present and short overrides a long carried count: the app measured sound.
    expect(base({ silenceMs: 0, ring: [entry({ silent_polls: 200 })] }).flags).not.toContain("SILENT_WHILE_RECORDING");
  });

  it("0.1.21 fallback: no silence_ms, and the carried zero_ratio count decides", () => {
    expect(base({ silenceMs: null, ring: [entry({ silent_polls: 80 })] }).flags).toContain("SILENT_WHILE_RECORDING");
    expect(base({ silenceMs: undefined, ring: [entry({ silent_polls: 80 })] }).flags).toContain("SILENT_WHILE_RECORDING");
  });

  it("pollIsSilent: zero_ratio 0.98 is silent, 0.9799 is not, absent is not, paused is not", () => {
    expect(C.pollIsSilent({ rec: true, tape_advancing: true, zero_ratio: 0.98 })).toBe(true);
    expect(C.pollIsSilent({ rec: true, tape_advancing: true, zero_ratio: 0.9799 })).toBe(false);
    expect(C.pollIsSilent({ rec: true, tape_advancing: true, zero_ratio: null })).toBe(false);
    expect(C.pollIsSilent({ rec: false, tape_advancing: true, zero_ratio: 1 })).toBe(false);
    expect(C.pollIsSilent({ rec: true, tape_advancing: false, zero_ratio: 1 })).toBe(false);
  });
});

describe("CLIPPING", () => {
  const clipped = (n: number, over = {}) =>
    Array.from({ length: 10 }, (_, k) => entry({ peak: k < n ? 0.99 : 0.5, ...over }));

  it("three of the last ten recording polls at 0.99, not two", () => {
    expect(base({ ring: clipped(2) }).flags).not.toContain("CLIPPING");
    expect(base({ ring: clipped(3) }).flags).toContain("CLIPPING");
  });

  it("0.99 is clipped, 0.9899 is not", () => {
    const ring = [entry({ peak: 0.9899 }), entry({ peak: 0.9899 }), entry({ peak: 0.9899 })];
    expect(base({ ring }).flags).not.toContain("CLIPPING");
  });

  it("a poll that was not recording does not count, and a room not recording now is never clipping", () => {
    expect(base({ ring: clipped(3, { rec: false }) }).flags).not.toContain("CLIPPING");
    expect(base({ recording: false, ring: clipped(10) }).flags).not.toContain("CLIPPING");
  });

  it("0.1.22: clip_count decides a poll when present — 0 is clean at peak 1.0, 1 is clipped at peak 0", () => {
    const zeroCount = Array.from({ length: 5 }, () => entry({ peak: 1, clip_count: 0 }));
    expect(base({ ring: zeroCount }).flags).not.toContain("CLIPPING");
    const counted = Array.from({ length: 3 }, () => entry({ peak: 0, clip_count: 1 }));
    expect(base({ ring: counted }).flags).toContain("CLIPPING");
  });
});

describe("DEVICE_MISSING", () => {
  it("fires when the recorded-from name is not in the device list, including an empty list", () => {
    expect(base({ inputDevices: [{ name: "TONOR TM20 Audio Device" }] }).flags).toContain("DEVICE_MISSING");
    expect(base({ inputDevices: [] }).flags).toContain("DEVICE_MISSING");
  });

  it("says nothing without both halves measured", () => {
    expect(base({ inputDevices: null }).flags).not.toContain("DEVICE_MISSING");
    expect(base({ inputDeviceName: null }).flags).not.toContain("DEVICE_MISSING");
  });
});

describe("DEVICE_CHANGED", () => {
  it("fires when the reported device is not the expected one", () => {
    expect(base({ expectedDeviceName: "TONOR TM20 Audio Device" }).flags).toContain("DEVICE_CHANGED");
  });

  it("says nothing when they match, or when either is unknown", () => {
    expect(base().flags).not.toContain("DEVICE_CHANGED");
    expect(base({ expectedDeviceName: null }).flags).not.toContain("DEVICE_CHANGED");
    expect(base({ inputDeviceName: null }).flags).not.toContain("DEVICE_CHANGED");
  });
});

describe("ENCODER_STALLED", () => {
  const stalled = (n: number, over = {}) =>
    Array.from({ length: 6 }, (_, k) => entry({ tape_advancing: k < n ? false : true, ...over }));

  it("four consecutive recording polls without the tape advancing, not three", () => {
    expect(C.STALLED_POLLS).toBe(4);
    expect(base({ ring: stalled(3) }).flags).not.toContain("ENCODER_STALLED");
    expect(base({ ring: stalled(4) }).flags).toContain("ENCODER_STALLED");
  });

  it("a poll in the four that was not recording breaks the run — the first poll of a session", () => {
    const ring = stalled(4);
    ring[3] = entry({ tape_advancing: false, rec: false });
    expect(base({ ring }).flags).not.toContain("ENCODER_STALLED");
  });

  it("an unreported tape (null) is not a stalled one, and a short ring cannot stall", () => {
    expect(base({ ring: stalled(4, { tape_advancing: null }) }).flags).not.toContain("ENCODER_STALLED");
    expect(base({ ring: stalled(3).slice(0, 3) }).flags).not.toContain("ENCODER_STALLED");
  });
});

describe("DISK_LOW", () => {
  it("under 2 GiB, binary: 2 GiB itself is not low, one byte less is", () => {
    expect(C.DISK_LOW_BYTES).toBe(2_147_483_648);
    expect(base({ diskFreeBytes: 2_147_483_648 }).flags).not.toContain("DISK_LOW");
    expect(base({ diskFreeBytes: 2_147_483_647 }).flags).toContain("DISK_LOW");
  });

  it("an unreported disk is never low", () => {
    expect(base({ diskFreeBytes: null }).flags).not.toContain("DISK_LOW");
  });
});

describe("CHANNEL_DRIFT", () => {
  it("starts its clock on the first mismatched poll and raises nothing yet", () => {
    const r = base({ assignedChannel: "test", updateChannel: "stable" });
    expect(r.flags).not.toContain("CHANNEL_DRIFT");
    expect(r.drift_since).toBe(new Date(NOW_MS).toISOString());
  });

  it("fires only AFTER thirty minutes: 30 min exactly is not drift, 30 min and 1 ms is", () => {
    const since = new Date(NOW_MS - C.CHANNEL_DRIFT_MS).toISOString();
    const at = (nowMs: number) =>
      base({ assignedChannel: "test", updateChannel: "stable", prev: { flags: [], drift_since: since }, nowMs });
    expect(at(NOW_MS).flags).not.toContain("CHANNEL_DRIFT");
    expect(at(NOW_MS + 1).flags).toContain("CHANNEL_DRIFT");
    expect(at(NOW_MS + 1).drift_since).toBe(since);
  });

  it("clears its clock when the Mac reports the assigned channel, or when nothing is assigned", () => {
    const prev = { flags: ["CHANNEL_DRIFT" as const], drift_since: new Date(NOW_MS - 3_600_000).toISOString() };
    expect(base({ assignedChannel: "test", updateChannel: "test", prev })).toEqual({ flags: [], drift_since: null });
    expect(base({ assignedChannel: null, updateChannel: "stable", prev })).toEqual({ flags: [], drift_since: null });
  });

  it("a Mac that does not report its channel cannot drift", () => {
    expect(base({ assignedChannel: "stable", updateChannel: null }).drift_since).toBeNull();
  });
});

describe("the record itself", () => {
  it("lists several flags at once, in the one canonical order", () => {
    const r = base({ diskFreeBytes: 1, inputDevices: [], expectedDeviceName: "TONOR TM20 Audio Device", ring: [entry({ silent_polls: 90 })] });
    expect(r.flags).toEqual(["SILENT_WHILE_RECORDING", "DEVICE_MISSING", "DEVICE_CHANGED", "DISK_LOW"]);
  });

  it("parses what it wrote, and anything unreadable is the empty state", () => {
    const rec = { flags: ["DISK_LOW", "CLIPPING"], drift_since: null };
    expect(C.parseInstallState(rec)).toEqual({ flags: ["CLIPPING", "DISK_LOW"], drift_since: null });
    expect(C.parseInstallState(JSON.stringify(rec)).flags).toEqual(["CLIPPING", "DISK_LOW"]);
    expect(C.parseInstallState("not json")).toEqual({ flags: [], drift_since: null });
    expect(C.parseInstallState({ flags: ["NOT_A_FLAG"] })).toEqual({ flags: [], drift_since: null });
    expect(C.parseInstallState([1, 2])).toEqual({ flags: [], drift_since: null });
  });

  it("the ring parser keeps ten entries, newest first, and drops what it cannot read", () => {
    const stored = Array.from({ length: 12 }, (_, k) => entry({ silent_polls: k }));
    const ring = C.parsePollRing([...stored.slice(0, 3), "junk", ...stored.slice(3)]);
    expect(ring).toHaveLength(9); // 10 read, 1 was junk
    expect(ring[0]!.silent_polls).toBe(0);
    expect(C.parsePollRing("[]")).toEqual([]);
    expect(C.parsePollRing(null)).toEqual([]);
  });

  it("sameInstallState and installFlagsChanged separate a clock move from a flag move", () => {
    const a = { flags: ["DISK_LOW" as const], drift_since: null };
    const b = { flags: ["DISK_LOW" as const], drift_since: "2026-09-11T16:00:00.000Z" };
    expect(C.sameInstallState(a, b)).toBe(false);
    expect(C.installFlagsChanged(a, b)).toBe(false);
    expect(C.installFlagsChanged(a, { flags: [], drift_since: null })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyInstallPoll — the ring rides the UPDATE; the flags are written only on change
// ---------------------------------------------------------------------------

describe("applyInstallPoll writes the ring in the same UPDATE (no extra round trip)", () => {
  it("prepends this poll, carries the silent count from the old head, and cuts to ten", async () => {
    responder = (t) => (/^UPDATE room_install SET last_seen_at/.test(t) ? [{ install_id: "install_a" }] : []);
    await RI.applyInstallPoll(
      { install_id: "install_a", tape_advancing: true, zero_ratio: "1.0000", peak: "0.0000" },
      { recording: true, now: new Date(NOW_MS) },
    );
    expect(calls).toHaveLength(1);
    const up = calls[0]!;
    expect(up.text).toMatch(/poll_ring = \( SELECT COALESCE\(jsonb_agg\(r\.e ORDER BY r\.n\), '\[\]'::jsonb\)/);
    expect(up.text).toMatch(/COALESCE\(\(room_install\.poll_ring -> 0 ->> 'silent_polls'\)::int, 0\) \+ 1 ELSE 0/);
    expect(up.text).toMatch(/WITH ORDINALITY AS r\(e, n\) WHERE r\.n <= \?::int/);
    expect(up.values).toContain(C.POLL_RING_SIZE);
    // This poll's own readings, and the silent verdict the SQL carries.
    const ringEntry = up.values.find((v) => typeof v === "string" && v.includes('"rec"')) as string;
    expect(JSON.parse(ringEntry)).toEqual({
      at: new Date(NOW_MS).toISOString(),
      peak: 0,
      zero_ratio: 1,
      tape_advancing: true,
      rec: true,
    });
    expect(up.values).toContain(true); // silentNow: recording, advancing, zero_ratio 1
    expect(up.text).toMatch(/expected_device_name = COALESCE\(expected_device_name, \?::text, input_device_name\)/);
  });

  it("a paused room's poll is not recording, so it is never counted silent", async () => {
    responder = () => [{ install_id: "install_a" }];
    await RI.applyInstallPoll(
      { install_id: "install_a", tape_advancing: true, zero_ratio: "1" },
      { recording: false, now: new Date(NOW_MS) },
    );
    const ringEntry = calls[0]!.values.find((v) => typeof v === "string" && v.includes('"rec"')) as string;
    expect(JSON.parse(ringEntry).rec).toBe(false);
    // The silentNow parameter sits right after the ring entry.
    const at = calls[0]!.values.indexOf(ringEntry);
    expect(calls[0]!.values[at + 1]).toBe(false);
  });

  it("writes the flags when they change, with state_changed_at, by install id", async () => {
    responder = (t) =>
      /^UPDATE room_install SET last_seen_at/.test(t)
        ? [{
            install_id: "install_a",
            assigned_channel: null,
            poll_ring: [entry({ silent_polls: 80 })],
            state_flags: { flags: [], drift_since: null },
            input_device_name: "TONOR TM20 Audio Device",
            input_devices: [{ name: "TONOR TM20 Audio Device", uid: "u", is_default: true }],
            expected_device_name: "TONOR TM20 Audio Device",
            disk_free_bytes: "400000000000",
            update_channel: "stable",
          }]
        : [];
    const out = await RI.applyInstallPoll(
      { install_id: "install_a", tape_advancing: true, zero_ratio: "1" },
      { recording: true, now: new Date(NOW_MS) },
    );
    expect(out).toEqual({ ok: true, assigned_channel: null });
    expect(calls).toHaveLength(2);
    const w = calls[1]!;
    expect(w.text).toMatch(/^UPDATE room_install SET state_flags = \?::jsonb, state_changed_at = CASE WHEN \?::boolean THEN now\(\) ELSE state_changed_at END WHERE install_id = \? AND retired_at IS NULL$/);
    expect(JSON.parse(w.values[0] as string)).toEqual({ flags: ["SILENT_WHILE_RECORDING"], drift_since: null });
    expect(w.values[1]).toBe(true);
    expect(w.values[2]).toBe("install_a");
  });

  it("writes NOTHING more when the evaluation matches what the row holds — one statement per poll", async () => {
    responder = () => [{
      install_id: "install_a",
      assigned_channel: null,
      poll_ring: [entry()],
      state_flags: { flags: [], drift_since: null },
      disk_free_bytes: "400000000000",
    }];
    await RI.applyInstallPoll({ install_id: "install_a", tape_advancing: true }, { recording: true, now: new Date(NOW_MS) });
    expect(calls).toHaveLength(1);
  });

  it("writes the first evaluation even when it finds nothing — NULL means never evaluated", async () => {
    responder = (t) => (/^UPDATE room_install SET last_seen_at/.test(t) ? [{ install_id: "install_a", assigned_channel: null, state_flags: null }] : []);
    await RI.applyInstallPoll({ install_id: "install_a" }, { now: new Date(NOW_MS) });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]!.values[0] as string)).toEqual({ flags: [], drift_since: null });
    expect(calls[1]!.values[1]).toBe(false); // the SET did not change: state_changed_at stays
  });

  it("a failed state write is logged and the poll still answers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    responder = (t) => {
      if (/SET state_flags/.test(t)) throw new Error("column state_flags does not exist");
      return [{ install_id: "install_a", assigned_channel: "stable", state_flags: null }];
    };
    expect(await RI.applyInstallPoll({ install_id: "install_a" })).toEqual({ ok: true, assigned_channel: "stable" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// pollCommands — the listener's answer becomes "recording"
// ---------------------------------------------------------------------------

describe("pollCommands hands the install write this poll's recording answer", () => {
  const ringRec = () => {
    const up = calls.find((c) => /^UPDATE room_install SET last_seen_at/.test(c.text))!;
    return JSON.parse(up.values.find((v) => typeof v === "string" && v.includes('"rec"')) as string).rec;
  };

  it("a session id and not paused is recording", async () => {
    responder = (t) => (/UPDATE room_install/.test(t) ? [{ install_id: "install_1" }] : []);
    await BC.pollCommands({ roomId: "room_1", tabId: "app_install_1", prevPollAt: null, recordingSessionId: "bs_1", paused: false, install: { install_id: "install_1" } });
    expect(ringRec()).toBe(true);
  });

  it("paused is not recording, and no session is not recording", async () => {
    responder = (t) => (/UPDATE room_install/.test(t) ? [{ install_id: "install_1" }] : []);
    await BC.pollCommands({ roomId: "room_1", tabId: "app_install_1", prevPollAt: null, recordingSessionId: "bs_1", paused: true, install: { install_id: "install_1" } });
    expect(ringRec()).toBe(false);
    calls.length = 0;
    await BC.pollCommands({ roomId: "room_1", tabId: "app_install_1", prevPollAt: null, recordingSessionId: null, paused: false, install: { install_id: "install_1" } });
    expect(ringRec()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ackCommand — a desk switch sets the expected device
// ---------------------------------------------------------------------------

describe("a set_audio_input ack records the expected device, best-effort", () => {
  const expectedWrites = () => calls.filter((c) => /SET expected_device_name/.test(c.text));

  it("sets it from the room's device list by the applied uid", async () => {
    responder = (t) => (/UPDATE bench_command/.test(t) ? [{ id: "cmd_a", kind: "set_audio_input" }] : []);
    const st = await BC.ackCommand({ roomId: "room_1", commandId: "cmd_a", ok: true, applied: { applied_device_uid: "c270-uid" } });
    expect(st).toBe("acked");
    const w = expectedWrites();
    expect(w).toHaveLength(1);
    expect(w[0]!.text).toMatch(/SELECT d ->> 'name' FROM jsonb_array_elements\( CASE WHEN jsonb_typeof\(input_devices\) = 'array' THEN input_devices ELSE '\[\]'::jsonb END \) AS d WHERE d ->> 'uid' = \? LIMIT 1/);
    expect(w[0]!.text).toMatch(/WHERE room_id = \? AND enrolled_at IS NOT NULL AND retired_at IS NULL$/);
    expect(w[0]!.values).toEqual(["c270-uid", "room_1"]);
  });

  it("does nothing for a failed ack, another kind, or an ack with no device", async () => {
    responder = (t) => (/UPDATE bench_command/.test(t) ? [{ id: "cmd_a", kind: "set_audio_input" }] : []);
    await BC.ackCommand({ roomId: "room_1", commandId: "cmd_a", ok: false, error: "device_not_present", applied: { applied_device_uid: "x" } });
    await BC.ackCommand({ roomId: "room_1", commandId: "cmd_a", ok: true, applied: { applied_input_volume: 0.5 } });
    responder = (t) => (/UPDATE bench_command/.test(t) ? [{ id: "cmd_a", kind: "start_day" }] : []);
    await BC.ackCommand({ roomId: "room_1", commandId: "cmd_a", ok: true, applied: { applied_device_uid: "x" } });
    expect(expectedWrites()).toHaveLength(0);
  });

  it("a failure of that write never fails the ack", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    responder = (t) => {
      if (/SET expected_device_name/.test(t)) throw new Error("column expected_device_name does not exist");
      return /UPDATE bench_command/.test(t) ? [{ id: "cmd_a", kind: "set_audio_input" }] : [];
    };
    expect(await BC.ackCommand({ roomId: "room_1", commandId: "cmd_a", ok: true, applied: { applied_device_uid: "x" } })).toBe("acked");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Migration 0081
// ---------------------------------------------------------------------------

describe("migration 0081", () => {
  const src = readFileSync("db/migrations/0081_room_states_and_verbs.sql", "utf8");

  it("adds the seven nullable room_install columns, idempotently", () => {
    for (const col of ["state_flags jsonb", "state_changed_at timestamptz", "poll_ring jsonb", "expected_device_name text", "clip_count integer", "silence_ms bigint", "channel_locked boolean"]) {
      expect(src).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${col.split(" ")[0]}\\s+${col.split(" ")[1]}\\s+NULL`));
    }
    const adds = src.split("\n").filter((l) => /ADD COLUMN/.test(l) && !l.trim().startsWith("--"));
    expect(adds).toHaveLength(7);
    for (const l of adds) expect(l).not.toMatch(/DEFAULT/);
  });

  it("swaps the kind CHECK to the five existing kinds plus the three Tier 1 verbs, by the catalogue", () => {
    const m = src.match(/CHECK \(kind IN \(([^)]*)\)\)/);
    const kinds = m![1]!.split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(kinds).toEqual([
      "start_day", "pause_day", "resume_day", "end_day", "set_audio_input",
      "check_update_now", "report_diag", "restart_engine",
    ]);
    for (const k of BC.COMMAND_KINDS) expect(kinds).toContain(k);
    expect(src).toMatch(/RAISE EXCEPTION '0081: % CHECK constraints on bench_command\.kind/);
  });

  it("swaps the assigned_channel CHECK to stable and test, by what the catalogue says", () => {
    expect(src).toMatch(/ADD CONSTRAINT room_install_assigned_channel_check\s+CHECK \(assigned_channel IN \('stable','test'\)\)/);
    expect(src).toMatch(/att\.attname = 'assigned_channel'/);
    expect(src).toMatch(/RAISE EXCEPTION '0081: % CHECK constraints on room_install\.assigned_channel/);
  });

  it("records itself", () => {
    expect(src).toMatch(/INSERT INTO schema_migrations \(version, name\)\s+VALUES \(81, '0081_room_states_and_verbs'\)\s+ON CONFLICT DO NOTHING;/);
  });
});

// ---------------------------------------------------------------------------
// The surfaces — the fleet row and its chip
// ---------------------------------------------------------------------------

describe("the fleet read carries the flags; the card shows a chip each", () => {
  it("selects the three 0081 columns and shows the stored record as its flags", async () => {
    responder = (t) => {
      if (/FROM room WHERE/.test(t)) return [{ id: "room_1", slug: "opd-3", name: "OPD 3", disabled_at: null }];
      if (/FROM room_install ORDER BY created_at DESC/.test(t)) {
        return [{
          install_id: "install_a", room_id: "room_1", created_at: "2026-09-10T00:00:00Z", enrolled_at: "2026-09-10T00:00:00Z",
          session_expires_at: null, mic_state: "authorized", tape_poll_streak: 0, retired_at: null,
          state_flags: { flags: ["SILENT_WHILE_RECORDING"], drift_since: null },
          state_changed_at: "2026-09-11T15:00:00Z",
          expected_device_name: "TONOR TM20 Audio Device",
        }];
      }
      return [];
    };
    const fleet = await RI.readFleet(new Date(NOW_MS));
    const sel = calls.find((c) => /FROM room_install ORDER BY created_at DESC/.test(c.text))!;
    expect(sel.text).toMatch(/input_volume, input_volume_settable, state_flags, state_changed_at, expected_device_name, channel_locked FROM room_install/);
    const inst = fleet.rows[0]!.install!;
    expect(inst.state_flags).toEqual(["SILENT_WHILE_RECORDING"]);
    expect(inst.state_changed_at).toBe("2026-09-11T15:00:00.000Z");
    expect(inst.expected_device_name).toBe("TONOR TM20 Audio Device");
  });

  it("a never-evaluated row is null, not []", async () => {
    responder = (t) =>
      /FROM room_install ORDER BY/.test(t)
        ? [{ install_id: "install_a", room_id: "room_1", created_at: "2026-09-10T00:00:00Z", enrolled_at: "2026-09-10T00:00:00Z", tape_poll_streak: 0, retired_at: null, state_flags: null }]
        : /FROM room WHERE/.test(t)
          ? [{ id: "room_1", slug: "opd-3", name: "OPD 3", disabled_at: null }]
          : [];
    const fleet = await RI.readFleet(new Date(NOW_MS));
    expect(fleet.rows[0]!.install!.state_flags).toBeNull();
  });

  it("deriveRow passes the flags through, and a retired row shows none", () => {
    const install = { install_id: "install_a", room_id: "room_1", enrolled_at: "x", retired_at: null, state_flags: ["DISK_LOW"] } as unknown as import("@/lib/room-install-view").InstallView;
    const row = { room_id: "room_1", room_slug: "s", room_name: "n", disabled: false, install, pending: null, last_retired: null } as import("@/lib/room-install-view").FleetRow;
    expect(V.deriveRow({ row, latestRelease: null, nowMs: NOW_MS }).state_flags).toEqual(["DISK_LOW"]);
    const retired = { ...row, install: { ...install, retired_at: "2026-09-11T00:00:00Z" } };
    expect(V.deriveRow({ row: retired, latestRelease: null, nowMs: NOW_MS }).state_flags).toEqual([]);
  });

  it("the card renders one labelled chip per flag", () => {
    const install = {
      install_id: "install_a", room_id: "room_1", created_at: "2026-09-10T00:00:00Z", enrolled_at: "2026-09-10T00:00:00Z",
      session_expires_at: null, launched_by: "launchd", hostname: "MINI", hardware_model: null, os_version: null,
      input_device_name: "C270 HD WEBCAM", app_version: "0.1.21", build_sha: "5af9075", first_seen_at: null,
      last_seen_at: new Date(NOW_MS - 2_000).toISOString(), mic_state: "authorized", launch_agent_loaded: true,
      tape_advancing: true, tape_poll_streak: 3, tape_advancing_since: null, never_sleep: true, retired_at: null,
      session_open: true, update_channel: "stable", last_update_result: null, last_update_version: null,
      last_update_error: null, last_update_at: null, disk_free_bytes: 1e9,
      state_flags: ["SILENT_WHILE_RECORDING", "DISK_LOW"],
    } as import("@/lib/room-install-view").InstallView;
    const payload = {
      now: new Date(NOW_MS).toISOString(),
      rows: [{ room_id: "room_1", room_slug: "opd-3", room_name: "OPD 3", disabled: false, install, pending: null, last_retired: null }],
      latest_release: null,
      releases: { stable: null, test: null },
      degraded: [],
    } as import("@/lib/room-install-view").FleetPayload;
    const html = renderToStaticMarkup(
      React.createElement(FleetTable, {
        fleet: payload, nowMs: NOW_MS, busy: null, onCopy: () => {}, onRetire: () => {}, onAssignStable: () => {}, onSetAudioInput: () => {},
      }),
    );
    expect(html).toContain('data-state-flag="SILENT_WHILE_RECORDING"');
    expect(html).toContain('data-state-flag="DISK_LOW"');
    expect(html).toContain(C.INSTALL_STATE_LABEL.SILENT_WHILE_RECORDING);
    expect(html).toContain(C.INSTALL_STATE_LABEL.DISK_LOW);
  });
});
