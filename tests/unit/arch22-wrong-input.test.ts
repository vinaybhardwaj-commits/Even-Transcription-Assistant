/**
 * Arch #22 — wrong-input detection (alert-only), the selected-input mark, and the capture-side level sequence.
 * `sql` is mocked; the rules are pure and proven directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

type Row = Record<string, unknown>;
type Call = { text: string; values: unknown[] };
const calls: Call[] = [];
let responder: (text: string, values: unknown[]) => Row[] = () => [];

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
const W = await import("@/lib/room-watchdog");
const BC = await import("@/lib/bench-commands");
const M = await import("@/lib/bench-meter");

beforeEach(() => {
  calls.length = 0;
  responder = () => [];
});

const NOW_MS = Date.parse("2026-10-08T10:00:00.000Z");
const dead = { at: new Date(NOW_MS).toISOString(), peak: 0, zero_ratio: 1, tape_advancing: true, rec: true, silent_polls: 80 };
const TONOR = { name: "TONOR TM20", uid: "uid-tonor", is_default: false, is_selected: true };
const C270 = { name: "C270 HD", uid: "uid-c270", is_default: true };
const state = (over: Partial<Parameters<typeof C.evaluateInstallStates>[0]> = {}) =>
  C.evaluateInstallStates({
    ring: [dead],
    recording: true,
    tapeAdvancing: true,
    inputDeviceName: "TONOR TM20",
    inputDevices: [TONOR, C270],
    expectedDeviceName: "TONOR TM20",
    diskFreeBytes: 400e9,
    updateChannel: "stable",
    assignedChannel: null,
    prev: { flags: [], drift_since: null },
    nowMs: NOW_MS,
    ...over,
  });

describe("AC2 — WRONG_INPUT_SUSPECTED", () => {
  it("digital zero on the selected input while another input is attached raises it, beside SILENT_WHILE_RECORDING", () => {
    const flags = state().flags;
    expect(flags).toContain("SILENT_WHILE_RECORDING");
    expect(flags).toContain("WRONG_INPUT_SUSPECTED");
  });
  it("no other attached input: SILENT only", () => {
    const flags = state({ inputDevices: [TONOR] }).flags;
    expect(flags).toContain("SILENT_WHILE_RECORDING");
    expect(flags).not.toContain("WRONG_INPUT_SUSPECTED");
  });
  it("a live input (no digital silence) never raises it, however many inputs are attached", () => {
    const live = { ...dead, silent_polls: 0, peak: 0.05, zero_ratio: 0.1 };
    expect(state({ ring: [live] }).flags).not.toContain("WRONG_INPUT_SUSPECTED");
  });
  it("the digital-silence window is #14's: 79 polls does not raise it", () => {
    expect(state({ ring: [{ ...dead, silent_polls: 79 }] }).flags).not.toContain("WRONG_INPUT_SUSPECTED");
  });
  it("the candidate is the OS default when it is another device, else the first other input", () => {
    expect(C.wrongInputCandidate([TONOR, C270], "TONOR TM20")?.uid).toBe("uid-c270");
    const mic3 = { name: "Meet", uid: "uid-meet", is_default: false };
    expect(C.wrongInputCandidate([{ ...TONOR, is_default: true }, mic3], "TONOR TM20")?.uid).toBe("uid-meet");
  });
  it("two attached devices sharing the selected name, and no mark, is ambiguous: no candidate, no flag", () => {
    const a = { name: "C270 HD", uid: "a", is_default: false };
    const b = { name: "C270 HD", uid: "b", is_default: true };
    expect(C.wrongInputCandidate([a, b], "C270 HD")).toBeNull();
  });
  it("the is_selected mark settles that ambiguity", () => {
    const a = { name: "C270 HD", uid: "a", is_default: false, is_selected: true };
    const b = { name: "C270 HD", uid: "b", is_default: true };
    expect(C.wrongInputCandidate([a, b], "C270 HD")?.uid).toBe("b");
  });
  it("it is a degraded flag, in the canonical order, with its own label", () => {
    expect(C.INSTALL_STATE_FLAGS).toContain("WRONG_INPUT_SUSPECTED");
    expect(C.INSTALL_STATE_LABEL.WRONG_INPUT_SUSPECTED).toBe("wrong input suspected");
    expect(readFileSync("lib/room-install-view.ts", "utf8")).toMatch(/DEGRADED_STATE_FLAGS[\s\S]*"WRONG_INPUT_SUSPECTED"/);
  });
});

describe("AC2 — the watchdog names the candidate", () => {
  const facts = (over = {}) => ({
    last_seen_at: new Date(NOW_MS).toISOString(), tape_advancing: true, session_open: true, disk_free_bytes: null,
    state_flags: ["SILENT_WHILE_RECORDING", "WRONG_INPUT_SUSPECTED"], open_session: null, ...over,
  });
  it("computeRoomStatus lists wrong_input_suspected as a degradation reason", () => {
    expect(W.computeRoomStatus(facts(), NOW_MS).reasons).toEqual(["silent_while_recording", "wrong_input_suspected"]);
  });
  it("the degraded text names the candidate and says suspected", () => {
    const m = W.degradedMessage("OPD 3", ["silent_while_recording", "wrong_input_suspected"], "2026-10-08T10:00:00Z", "C270 HD");
    expect(m.text).toContain("digital silence on the capture");
    expect(m.text).toContain("may be on the wrong input");
    expect(m.text).toContain("C270 HD");
  });
  it("without a candidate it still reads, using the generic label", () => {
    expect(W.degradedMessage("OPD 3", ["wrong_input_suspected"], "t").text).toContain("another input is attached");
  });
});

describe("AC1 — the inventory per heartbeat: selected, default, others", () => {
  it("cleanInputDevices keeps a literal is_selected true and drops anything else", () => {
    const out = JSON.parse(RI.cleanInputDevices([{ name: "A", uid: "a", is_default: true, is_selected: true }, { name: "B", uid: "b", is_default: false }])!);
    expect(out[0]).toEqual({ name: "A", uid: "a", is_default: true, is_selected: true });
    expect(out[1]).toEqual({ name: "B", uid: "b", is_default: false });
  });
  it("an app that does not send the mark is accepted exactly as before", () => {
    expect(JSON.parse(RI.cleanInputDevices([{ name: "A", uid: "a", is_default: true }])!)).toEqual([{ name: "A", uid: "a", is_default: true }]);
  });
  it("a non-boolean mark, or two marks, refuses the list", () => {
    expect(RI.cleanInputDevices([{ name: "A", uid: "a", is_default: false, is_selected: "yes" }])).toBeNull();
    expect(RI.cleanInputDevices([
      { name: "A", uid: "a", is_default: false, is_selected: true },
      { name: "B", uid: "b", is_default: false, is_selected: true },
    ])).toBeNull();
  });
});

describe("AC3 + AC4 + AC5 — card, policy, alert-only (source-level; no DOM harness)", () => {
  const card = readFileSync("components/admin/BenchInstallFleet.tsx", "utf8");
  it("the card marks the selected input and offers the existing set_audio_input on the candidate, by a press", () => {
    expect(card).toContain(" · selected");
    expect(card).toContain("data-wrong-input");
    expect(card).toContain("onSetAudioInput(i, { device_uid: cand.uid! })");
    expect(card).toContain("Switch to {cand.name}");
  });
  it("nothing server-side switches a device: the only caller of the audio-input command is the button/select", () => {
    for (const f of ["lib/bench-bus-constants.ts", "lib/room-watchdog.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/set_audio_input|insertCommand/);
    }
  });
  it("the policy is written, says alert-only, and names the rule log line", () => {
    const doc = readFileSync("docs/capture-input-selection-policy.md", "utf8");
    expect(doc).toContain("Alert-only");
    expect(doc).toContain("configured_missing");
    expect(doc).toContain("auto_switch=false");
  });
});

describe("level sequence — levelsStale prefers it, falls back to the identical-run rule", () => {
  const T = 1_000_000;
  const s = (i: number, seq: number | null | undefined, peak = 0.0125) => ({ t_ms: T + i * 1500, peak, avg: 0.01, zero_ratio: 0.1, seq });
  it("a sequence that stops advancing is stale even though the values keep changing", () => {
    const rows = Array.from({ length: 8 }, (_, i) => s(i, 7, 0.01 + i * 0.001));
    expect(M.levelsStale(rows, T + 7 * 1500)).toBe(true);
  });
  it("an advancing sequence is live even when the values are identical", () => {
    const rows = Array.from({ length: 8 }, (_, i) => s(i, 100 + i));
    expect(M.levelsStale(rows, T + 7 * 1500)).toBe(false);
  });
  it("a muted mic (identical zeros) with an advancing sequence is not stale; with a stuck sequence it is", () => {
    const zeros = (seq: (i: number) => number) => Array.from({ length: 8 }, (_, i) => ({ t_ms: T + i * 1500, peak: 0, avg: 0, zero_ratio: 1, seq: seq(i) }));
    expect(M.levelsStale(zeros((i) => i), T + 7 * 1500)).toBe(false);
    expect(M.levelsStale(zeros(() => 3), T + 7 * 1500)).toBe(true);
  });
  it("a lower sequence is a new capture, not a stall", () => {
    const rows = [s(0, 900), s(1, 901), s(2, 1), s(3, 2), s(4, 3), s(5, 4)];
    expect(M.levelsStale(rows, T + 5 * 1500)).toBe(false);
  });
  it("samples without a sequence fall back to the identical-run rule", () => {
    const frozen = Array.from({ length: 8 }, (_, i) => s(i, null));
    expect(M.levelsStale(frozen, T + 7 * 1500)).toBe(true);
    const moving = Array.from({ length: 8 }, (_, i) => s(i, undefined, 0.01 + i * 0.001));
    expect(M.levelsStale(moving, T + 7 * 1500)).toBe(false);
  });
});

describe("level sequence — stored with the sample, and no sample lost before the migration", () => {
  const poll = (extra: Record<string, unknown> = {}) =>
    BC.pollCommands({
      roomId: "room_1", tabId: "t", prevPollAt: null, recordingSessionId: "bs_x", paused: false,
      mic: { peak: 0.2, avg: 0.1, zeroRatio: 0.1 }, ...extra,
    } as Parameters<typeof BC.pollCommands>[0]);
  const open = (text: string) => (/FROM bench_session/.test(text) ? [{ x: 1 }] : []);

  it("seq and captured_at are written when the recorder sent them", async () => {
    responder = open;
    await poll({ levelSeq: 42, levelCapturedAt: "2026-10-08T10:00:00.000Z" });
    const ins = calls.find((c) => /INSERT INTO bench_level_sample/.test(c.text))!;
    expect(ins.text).toContain("seq, captured_at");
    expect(ins.values.slice(-2)).toEqual([42, "2026-10-08T10:00:00.000Z"]);
  });
  it("with no sequence the insert is the old one (NULL, never 0)", async () => {
    responder = open;
    await poll();
    const ins = calls.filter((c) => /INSERT INTO bench_level_sample/.test(c.text));
    expect(ins).toHaveLength(1);
    expect(ins[0]!.text).not.toContain("seq");
  });
  it("migration 0133 not applied: the sample is still written the old way", async () => {
    responder = (text) => {
      if (/seq, captured_at/.test(text)) throw new Error('column "seq" does not exist');
      return open(text);
    };
    await poll({ levelSeq: 42, levelCapturedAt: "2026-10-08T10:00:00.000Z" });
    const ins = calls.filter((c) => /INSERT INTO bench_level_sample/.test(c.text));
    expect(ins).toHaveLength(2);
    expect(ins[1]!.text).not.toContain("seq");
  });
  it("migration 0133 is additive, nullable and idempotent", () => {
    const m = readFileSync("db/migrations/0133_level_seq.sql", "utf8");
    expect(m).toContain("ADD COLUMN IF NOT EXISTS seq bigint");
    expect(m).toContain("ADD COLUMN IF NOT EXISTS captured_at timestamptz");
    expect(m).toMatch(/VALUES\s*\(133,\s*'0133_level_seq'\)/);
    expect(m).not.toMatch(/NOT NULL|UPDATE |DELETE /);
  });
  it("the route parses level_seq as digits only and level_at as an ISO instant", () => {
    const r = readFileSync("app/api/bench/commands/route.ts", "utf8");
    expect(r).toContain('sp.get("level_seq")');
    expect(r).toContain("levelSeq, levelCapturedAt");
  });
});

describe("Swift side (not compiled here)", () => {
  it("sends level_seq / level_at, marks is_selected, and has a selection policy with tests", () => {
    const f = readFileSync("apps/room-recorder/Sources/RoomRecorderCore/InstallPollFields.swift", "utf8");
    expect(f).toContain('"level_seq"');
    expect(f).toContain("is_selected");
    expect(readFileSync("apps/room-recorder/Sources/RoomRecorderCore/InputSelectionPolicy.swift", "utf8")).toContain("auto_switch=false");
    expect(readFileSync("apps/room-recorder/Tests/TapeCoreTests/RoomInputSelectionTests.swift", "utf8")).toContain("configuredMissing");
  });
});
