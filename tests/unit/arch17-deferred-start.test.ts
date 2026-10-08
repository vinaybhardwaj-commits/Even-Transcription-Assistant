/**
 * Arch #17 C1 + C2 (herdr-lead rulings on the re-check of aa70725).
 *   C2 a deferred ack ({ok:true, deferred:true, session_id:null}) is PENDING: MCP scribe_start_recording says so; the Steward re-checks for a recording
 *      session and never records success without one.
 *   C1 a deferred start whose background wait ends in failure reaches the server (a failed ack on the same start_day -> status failed -> Remote start failed);
 *      the amendment is proved on real postgres in arch17-deferred-start-pg.test.ts and the alert in fleet-attention-sql.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { decideStart, type StartAttempt } from "@/lib/bench-commands";
import { PENDING_PREFIX, isDeferredAck, liveScribeStart, type StartDeps } from "@/lib/steward/executor";
import { outcomeOf, reconcilePending } from "@/lib/steward/loop";
import { START_NO_ACK_FAIL_S } from "@/lib/steward/start-schedule";
import type { Decision } from "@/lib/steward/rules";

const NOW = new Date("2026-10-07T08:00:00Z");
const dec = (): Decision => ({ room_id: "room_a", machine: "HOST-A", window_kind: "clinic", rule: "not_recording", action: "scribe_start", params: {}, why: "", why_not: null, severity: "warn", inputs_hash: "x", inputs: {} }) as Decision;
const listening = () => ({ room_id: "room_a", tab_id: "t", last_poll_at: new Date(NOW.getTime() - 2000), recording_session_id: null, paused: false }) as never;
const PENDING_ROW = /^pending\b.*command_id=(\S+)/;
const DEFERRED = { status: "acked", error: null, result: { ok: true, deferred: true } };

function deps(over: Partial<StartDeps> & { sessions?: Array<{ id: string; status: string } | null> } = {}) {
  const seq = over.sessions ?? [null];
  let i = 0;
  const calls = { active: 0 };
  const { sessions: _s, ...rest } = over;
  const d: StartDeps = {
    getListener: async () => listening(),
    findActiveSession: async () => (calls.active++, seq[Math.min(i++, seq.length - 1)] ?? null),
    getRecentStartAttempts: async () => [] as StartAttempt[],
    getStewardAttemptsToday: async () => [] as StartAttempt[],
    decideStart,
    insertCommand: async () => "cmd_d",
    waitForAck: async () => DEFERRED,
    ...rest,
  };
  return { d, calls };
}

describe("C2 — Steward (folded into F44's fire-then-collect): accepted is not started", () => {
  it("isDeferredAck reads only an explicit deferred:true", () => {
    expect(isDeferredAck({ ok: true, deferred: true })).toBe(true);
    expect(isDeferredAck({ ok: true })).toBe(false);
    expect(isDeferredAck({ deferred: "true" })).toBe(false);
    expect(isDeferredAck(null)).toBe(false);
  });
  it("a deferred ack is PENDING at once (F44's prefix and command_id), never ok and never a counted failure", async () => {
    const { d } = deps();
    const r = await liveScribeStart(dec(), d, { now: () => NOW });
    expect(r.result).toMatch(new RegExp(`^${PENDING_PREFIX}`));
    expect(r.result).toContain("command_id=cmd_d");
    expect(r.result).toMatch(/deferred/);
    expect(outcomeOf(r.result)).toBeNull();                 // not ok, not failed: the caps do not count it either way
    expect(r.result).toMatch(PENDING_ROW);                  // and the loop's own collector regexp finds the command id
  });
  it("there is no second collector: liveScribeStart does not poll for a session itself (one mechanism, F44's)", async () => {
    const { d, calls } = deps();
    await liveScribeStart(dec(), d, { now: () => NOW });
    expect(calls.active).toBe(1);                           // only the pre-send read
  });
  it("a plain (non-deferred) acked start is unchanged: ok at once", async () => {
    const { d } = deps({ waitForAck: async () => ({ status: "acked", error: null, result: { ok: true, session_id: "bs_x" } }) });
    expect((await liveScribeStart(dec(), d, { now: () => NOW })).result).toMatch(/^ok: start_day acked/);
  });
});

describe("C2 — reconcilePending settles a deferred start only on evidence", () => {
  const T = Date.parse("2026-10-07T08:00:00Z");
  const run = async (opts: { cmd: Record<string, unknown>; sessions: Array<{ id: string }>; nowS: number }) => {
    const updates: string[] = [];
    const sql = ((strings: TemplateStringsArray, ...v: unknown[]) => {
      const text = strings.join("?");
      if (/FROM steward_decisions d WHERE/.test(text)) return Promise.resolve([{ id: 1, ts: new Date(T), result: "pending: sent, awaiting ack (deferred: the kiosk accepted the start and is waiting for its input device) command_id=cmd_d" }]);
      if (/FROM bench_command WHERE id = ANY/.test(text)) return Promise.resolve([{ id: "cmd_d", room_id: "room_a", created_at: new Date(T), error: null, ...opts.cmd }]);
      if (/FROM bench_session s/.test(text)) return Promise.resolve(opts.sessions);
      if (/UPDATE steward_decisions SET result/.test(text)) { updates.push(String(v[0])); return Promise.resolve([]); }
      return Promise.resolve([]);
    }) as never;
    const n = await reconcilePending(sql, T + opts.nowS * 1000, 5000);
    return { n, updates };
  };
  const deferredAcked = { status: "acked", result: { ok: true, deferred: true } };

  it("a session opened for the room after the command = ok (deferred then recording)", async () => {
    const r = await run({ cmd: deferredAcked, sessions: [{ id: "bs_new" }], nowS: 45 });
    expect(r.n).toBe(1);
    expect(r.updates[0]).toMatch(/^ok: start_day deferred then recording \(late\) session_id=bs_new command_id=cmd_d/);
  });
  it("no session yet, inside START_NO_ACK_FAIL_S = still pending (nothing written)", async () => {
    const r = await run({ cmd: deferredAcked, sessions: [], nowS: START_NO_ACK_FAIL_S - 1 });
    expect(r.n).toBe(0);
    expect(r.updates).toEqual([]);
  });
  it("no session after START_NO_ACK_FAIL_S = failed (never success)", async () => {
    const r = await run({ cmd: deferredAcked, sessions: [], nowS: START_NO_ACK_FAIL_S + 1 });
    expect(r.updates[0]).toMatch(/^failed: start_day deferred, no recording session after 120 s command_id=cmd_d/);
  });
  it("the app's late failure ack (command amended to failed) settles as failed with its reason", async () => {
    const r = await run({ cmd: { status: "failed", error: "input_device_not_ready", result: { ok: false, error: "input_device_not_ready" } }, sessions: [], nowS: 30 });
    expect(r.updates[0]).toMatch(/^failed: start_day failed \(input_device_not_ready\) command_id=cmd_d/);
  });
  it("F44's own case is untouched: a plainly acked late command is ok (late) without a session query", async () => {
    const r = await run({ cmd: { status: "acked", result: { ok: true, session_id: "bs_q" } }, sessions: [], nowS: 30 });
    expect(r.updates[0]).toMatch(/^ok: start_day acked \(late\) command_id=cmd_d/);
  });
});

describe("C2 — MCP scribe_start_recording returns a deferred ack as pending", () => {
  it("the answer says pending / not started, with no session, and ok means only 'accepted'", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => {
      const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join("?").replace(/\s+/g, " ").trim();
        if (/FROM room WHERE/.test(text)) return Promise.resolve([{ id: "room_opd5", slug: "opd-x", name: "OPD X", disabled_at: null }]);
        if (/FROM bench_listener/.test(text)) return Promise.resolve([{ room_id: "room_opd5", tab_id: "t", last_poll_at: new Date().toISOString(), recording_session_id: null, paused: false }]);
        if (/FROM bench_command c/.test(text)) return Promise.resolve([]);
        if (/status IN \('recording','paused'\)/.test(text)) return Promise.resolve([]);
        if (/FROM bench_command WHERE id = \?/.test(text)) {
          return Promise.resolve([{ id: values[0], room_id: "room_opd5", kind: "start_day", args: null, status: "acked", source: "mcp", result: { ok: true, deferred: true }, error: null, created_at: new Date().toISOString(), acked_at: new Date().toISOString() }]);
        }
        return Promise.resolve([]);
      };
      (sql as unknown as { transaction: unknown }).transaction = async () => [];
      return { sql, db: {} };
    });
    vi.doMock("@/lib/brain/db", async (orig) => ({ ...((await orig()) as Record<string, unknown>), brainLog: () => {}, query: async () => ({ rows: [], rowCount: 0 }) }));
    const { BENCH_TOOLS } = await import("@/lib/mcp/tools/bench");
    const start = BENCH_TOOLS.find((t) => t.name === "scribe_start_recording")!;
    const out = (await start.handler({ room: "opd-x" }, { origin: "https://preview.example" } as never)) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, pending: true, deferred: true, started: false, session_id: null, status: "pending" });
    expect(String(out.hint)).toMatch(/no recording exists yet/);
  });
});

describe("C1 — a deferred start's late failure reaches the server (source pins; behaviour proved on postgres)", () => {
  it("the app acks the start as deferred outside the journal gate, and reports a failed wait as a second ack with a fixed reason", () => {
    const swift = readFileSync("apps/room-recorder/Sources/RoomRecorderCore/RoomEngine.swift", "utf8");
    expect(swift).toMatch(/verb: OperatorVerbAcknowledgement\(deferred: true\)/);
    expect(swift).toMatch(/await sendLateStartFailure\(commandID: commandID, error: failure\)/);
    expect(swift).toMatch(/return "input_device_not_ready"/);
    // only a start that was acked AS deferred reports late; one that died inline was already acked failed
    expect(swift).toMatch(/let reportLateFailure = waitForDevice/);
  });
});
