/**
 * TS-E1 (#36): reachability from heartbeats. A failed tailnet SSH poll must never make a Mac unreachable while the Mac itself is heard (app poll,
 * kiosk-health heartbeat). Pure: every clock is explicit.
 */
import { describe, it, expect } from "vitest";
import { REACH_FRESH_S, REACH_UNKNOWN_AFTER_S, reachability, reachabilityLabel } from "@/lib/reachability";
import { computeAttention, resolveLockState, type RoomAttentionInputs } from "@/lib/fleet-attention";
import { computeExtHealth, EXT_TARGET_VERSION, type ExtHealthInput } from "@/lib/encounter-windows/ext-health";
import { decideRoom, EMPTY_RECENT } from "@/lib/steward/rules";
import { DEFAULT_CONFIG } from "@/lib/steward/config";
import { ago as sago, healthy, idle, ist as sist } from "../support/steward-fixtures";

const NOW = Date.parse("2026-10-10T08:00:00.000Z");
const at = (secAgo: number): string => new Date(NOW - secAgo * 1000).toISOString();

describe("reachability(machine, asOf)", () => {
  it("a fresh heartbeat with a failed poll is reachable (the poll is not an input; a poll-only function fails this)", () => {
    // Tailscale off: the poller wrote `unreachable` (nothing to pass), while the app polls 2 s ago and kiosk-health 40 s ago.
    expect(reachability({ app_poll_at: at(2), kiosk_health_at: at(40), poller_ok_at: null }, NOW)).toMatchObject({ state: "reachable", source: "app_poll", age_s: 2 });
    expect(reachability({ kiosk_health_at: at(40) }, NOW)).toMatchObject({ state: "reachable", source: "kiosk_health", age_s: 40 });
    expect(reachability({ app_poll_at: at(2), poller_ok_at: at(900) }, NOW).state).toBe("reachable");
  });

  it("stale heartbeats and no ok poll is unreachable", () => {
    expect(reachability({ app_poll_at: at(600), kiosk_health_at: at(900), poller_ok_at: at(1200) }, NOW)).toMatchObject({ state: "unreachable", source: "app_poll", age_s: 600 });
  });

  it("boundary at the stale threshold: 180 s is reachable, 181 s is unreachable", () => {
    expect(REACH_FRESH_S).toBe(180);
    expect(reachability({ app_poll_at: at(180) }, NOW).state).toBe("reachable");
    expect(reachability({ app_poll_at: at(181) }, NOW).state).toBe("unreachable");
    expect(reachability({ kiosk_health_at: at(180) }, NOW).state).toBe("reachable");
    expect(reachability({ kiosk_health_at: at(181) }, NOW).state).toBe("unreachable");
  });

  it("F2: a Mac silent for over 2 h stays UNREACHABLE (R1 stays red); only no evidence at all is unknown", () => {
    expect(REACH_UNKNOWN_AFTER_S).toBe(7200); // the heartbeat look-back, not a verdict threshold
    expect(reachability({ app_poll_at: at(7200) }, NOW).state).toBe("unreachable");
    expect(reachability({ app_poll_at: at(7201), kiosk_health_at: at(9000) }, NOW)).toMatchObject({ state: "unreachable", source: "app_poll", age_s: 7201 });
    expect(reachability({ app_poll_at: at(3 * 86400) }, NOW)).toMatchObject({ state: "unreachable", age_s: 3 * 86400 });
    expect(reachability({}, NOW)).toEqual({ state: "unknown", source: null, last_evidence_at: null, age_s: null });
    expect(reachability({ app_poll_at: null, kiosk_health_at: null, poller_ok_at: null }, NOW).state).toBe("unknown");
  });

  it("the newest source decides and names itself; a tie goes app poll, then kiosk-health, then poller; junk and future stamps are safe", () => {
    expect(reachability({ app_poll_at: at(100), kiosk_health_at: at(30), poller_ok_at: at(60) }, NOW).source).toBe("kiosk_health");
    expect(reachability({ app_poll_at: at(10), kiosk_health_at: at(10), poller_ok_at: at(10) }, NOW).source).toBe("app_poll");
    expect(reachability({ kiosk_health_at: at(10), poller_ok_at: at(10) }, NOW).source).toBe("kiosk_health");
    expect(reachability({ app_poll_at: "not a date", poller_ok_at: at(5) }, NOW).source).toBe("poller");
    expect(reachability({ app_poll_at: at(-30) }, NOW)).toMatchObject({ state: "reachable", age_s: 0 });
    expect(() => reachability({}, "nope")).toThrow();
  });

  it("the Bench label names the source", () => {
    expect(reachabilityLabel(reachability({ app_poll_at: at(2) }, NOW))).toBe("reachable via app poll, 2s ago");
    expect(reachabilityLabel(reachability({ kiosk_health_at: at(500) }, NOW))).toBe("unreachable via kiosk-health, 500s ago");
    expect(reachabilityLabel(reachability({}, NOW))).toContain("unknown");
  });
});

// ---------------------------------------------------------------------------
// R1
// ---------------------------------------------------------------------------
const room = (over: Partial<RoomAttentionInputs> = {}): RoomAttentionInputs => ({
  room_id: "room_opd6",
  room_name: "OPD 6",
  machine: "EHRC-OPD6s-Mac-mini",
  ext_events: [],
  poller: null,
  recent_activity: null,
  open_session: null,
  last_session_started_at: null,
  samples: [],
  frozen_since: null,
  last_sample_at: null,
  chunks: [],
  windows: [],
  outbox: null,
  failed_start: null,
  ...over,
});
/** The poller has said `unreachable` for 90 minutes: Tailscale is off on the Mac. */
const tailscaleOffPoller = { ts: at(30), state: "unreachable", locked: false, unreachable_since: at(5400) };
const run = (...rooms: RoomAttentionInputs[]) => computeAttention({ now_ms: NOW, rooms });
const asleep = (items: ReturnType<typeof run>) => items.filter((i) => i.kind === "asleep");

describe("R1 with reachability", () => {
  it("replay of a Tailscale-off day: poller unreachable for 90 min, the app polling 1 s ago, nothing is raised", () => {
    const reach = reachability({ app_poll_at: at(1), kiosk_health_at: at(30) }, NOW);
    expect(run(room({ poller: tailscaleOffPoller, reach }))).toEqual([]);
  });

  it("the same replay with a session open and the app polling: still nothing (no false lock-down from the poller)", () => {
    const reach = reachability({ app_poll_at: at(1) }, NOW);
    const open = { id: "bs_1", status: "recording" as const, started_at: at(3600) };
    // audio is fine: a chunk 60 s ago and moving levels
    const chunks = [{ session_id: "bs_1", source: "room", created_at: at(60), started_at: at(120), size_bytes: 400_000, duration_ms: 60_000 }];
    const samples = [0, 30, 60, 90].map((s, i) => ({ sampled_at: at(120 - s), peak: 0.1 + i / 10, zero_ratio: 0.1 }));
    expect(asleep(run(room({ poller: tailscaleOffPoller, reach, open_session: open, chunks, samples })))).toEqual([]);
    expect(resolveLockState([], tailscaleOffPoller, reach)).toEqual({ down: false, since: null, by: null });
  });

  it("nothing heard from the Mac for 10 min while the poller also fails: unreachable, red, since the last sign of life", () => {
    const reach = reachability({ app_poll_at: at(600), kiosk_health_at: at(660) }, NOW);
    const items = asleep(run(room({ poller: tailscaleOffPoller, reach })));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ severity: "red", since: at(600) });
    expect(items[0]!.detail).toContain("unreachable");
  });

  it("boundary: a heartbeat 180 s old raises nothing; 181 s raises the item", () => {
    expect(asleep(run(room({ poller: tailscaleOffPoller, reach: reachability({ app_poll_at: at(180) }, NOW) })))).toEqual([]);
    expect(asleep(run(room({ poller: tailscaleOffPoller, reach: reachability({ app_poll_at: at(181) }, NOW) })))).toHaveLength(1);
  });

  it("F2: a Mac silent for 3 h (past the old 2 h unknown cut-off) is still RED", () => {
    const items = asleep(run(room({ poller: tailscaleOffPoller, reach: reachability({ app_poll_at: at(3 * 3600), kiosk_health_at: at(4 * 3600) }, NOW) })));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ severity: "red", since: at(3 * 3600) });
  });

  it("M9: R1(b) is not raised while a recording session is demonstrably delivering audio, even though the Mac has been silent for 10 min", () => {
    const reach = reachability({ app_poll_at: at(600) }, NOW);
    const open = { id: "bs_1", status: "recording" as const, started_at: at(3600) };
    const chunks = [{ session_id: "bs_1", source: "room", created_at: at(60), started_at: at(120), size_bytes: 400_000, duration_ms: 60_000 }];
    const samples = [0, 30, 60, 90].map((s, i) => ({ sampled_at: at(120 - s), peak: 0.1 + i / 10, zero_ratio: 0.1 }));
    expect(asleep(run(room({ poller: tailscaleOffPoller, reach, open_session: open, chunks, samples })))).toEqual([]);
    // the same Mac with the audio gone is raised (so the exemption is the only reason for the empty list above)
    expect(asleep(run(room({ poller: tailscaleOffPoller, reach, open_session: open, chunks: [], samples: [], last_sample_at: at(900), last_chunk_at: at(900) })))).not.toEqual([]);
  });

  it("M7/M9 threshold: R1(b) needs the silence to be >= 3 min (UNREACHABLE_AFTER_MS), measured from the last sign of life", () => {
    expect(asleep(run(room({ reach: reachability({ app_poll_at: at(181) }, NOW) })))).toHaveLength(1);
    expect(asleep(run(room({ reach: reachability({ app_poll_at: at(179) }, NOW) })))).toEqual([]);
  });

  it("unknown (no evidence at all, or the heartbeat READ failed) raises nothing; it is not the same as down", () => {
    expect(run(room({ poller: tailscaleOffPoller, reach: reachability({}, NOW) }))).toEqual([]);
    expect(run(room({ poller: tailscaleOffPoller, reach: { state: "unknown", source: null, last_evidence_at: null, age_s: null } }))).toEqual([]);
  });

  it("legacy (no reach supplied): the poller's unreachable run still raises, so hand-built inputs keep their meaning", () => {
    expect(asleep(run(room({ poller: tailscaleOffPoller })))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ext-health
// ---------------------------------------------------------------------------
const mkExt = (over: Partial<ExtHealthInput> = {}): ExtHealthInput => ({
  machine: "EHRC-ECHOs-Mac-mini",
  room_id: "room_cardio",
  room_name: "Cardiology OPD",
  last_ext: { ts: at(20), event: "heartbeat", reason: null },
  ext_version: EXT_TARGET_VERSION,
  poller: null,
  behind_since: null,
  ...over,
});
const ext = (over: Partial<ExtHealthInput> = {}) => computeExtHealth([mkExt(over)], NOW)[0]!;

describe("ext-health offline from reachability", () => {
  it("poller unreachable (Tailscale off) but the app is polling: not offline, and the source is on the row", () => {
    const row = ext({ reach: reachability({ app_poll_at: at(1) }, NOW), poller: { ts: at(30), state: "unreachable", chrome_running: null, console_user: null } });
    expect(row.status).toBe("ok");
    expect(row.reach).toMatchObject({ state: "reachable", source: "app_poll" });
  });

  it("stale heartbeats: offline; unknown: offline (the extension of a Mac we cannot see says nothing)", () => {
    expect(ext({ reach: reachability({ app_poll_at: at(400) }, NOW) }).status).toBe("offline");
    expect(ext({ reach: reachability({}, NOW) }).status).toBe("offline");
  });

  it("an ok, fresh poller still supplements a reachable Mac (Chrome down is still no_chrome)", () => {
    const poller = { ts: at(30), state: "ok", chrome_running: false, console_user: "console-a" };
    expect(ext({ reach: reachability({ app_poll_at: at(1) }, NOW), poller }).status).toBe("no_chrome");
  });

  it("F3: a reachable Mac with a failed poll and a SILENT extension is `poller_down` (unknown), never ok/green, and not offline or a false no_chrome", () => {
    const row = ext({ reach: reachability({ kiosk_health_at: at(30) }, NOW), last_ext: { ts: at(3600), event: "heartbeat", reason: null }, poller: { ts: at(30), state: "unreachable", chrome_running: false, console_user: null } });
    expect(row.status).toBe("poller_down");
    expect(ext({ reach: reachability({ app_poll_at: at(1) }, NOW), last_ext: null }).status).toBe("poller_down");
    // an extension that IS heard needs no poller: still ok / behind
    expect(ext({ reach: reachability({ app_poll_at: at(1) }, NOW), poller: null }).status).toBe("ok");
    expect(ext({ reach: reachability({ app_poll_at: at(1) }, NOW), poller: null, ext_version: "0.1.0.9" }).status).toBe("behind");
    // with an ok, fresh poller the old verdicts are unchanged
    expect(ext({ reach: reachability({ app_poll_at: at(1) }, NOW), last_ext: { ts: at(3600), event: "heartbeat", reason: null }, poller: { ts: at(30), state: "ok", chrome_running: true, console_user: "c", idle_s: 0 } }).status).toBe("missing");
  });

  it("legacy (no reach supplied): the poller alone decides offline", () => {
    expect(ext({ poller: { ts: at(30), state: "unreachable", chrome_running: null, console_user: null } }).status).toBe("offline");
    expect(ext({ poller: { ts: at(30), state: "ok", chrome_running: true, console_user: "c" } }).status).toBe("ok");
    expect(ext({ poller: { ts: at(30), state: "ok", chrome_running: true, console_user: "c" } }).reach).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Steward
// ---------------------------------------------------------------------------
const T = sist("10:00");
const decide = (s: Parameters<typeof decideRoom>[0]) => decideRoom(s, DEFAULT_CONFIG, T, EMPTY_RECENT);

describe("Steward reachability", () => {
  it("kiosk_asleep: poller and kiosk-health both stale but the app is polling -> the Mac is not asleep", () => {
    const s = idle(T, { reachable: { poller_ok_at: sago(T, 900), kh_heartbeat_at: sago(T, 900), app_poll_at: sago(T, 2) } });
    expect(decide(s).map((d) => d.rule)).not.toContain("kiosk_asleep");
  });

  it("kiosk_asleep: all three stale at 4 min -> ticket wake; the app poll at exactly 180 s keeps it reachable", () => {
    const stale = { poller_ok_at: sago(T, 240), kh_heartbeat_at: sago(T, 240) };
    expect(decide(idle(T, { reachable: { ...stale, app_poll_at: sago(T, 240) } }))[0]).toMatchObject({ rule: "kiosk_asleep", action: "ticket:wake" });
    expect(decide(idle(T, { reachable: { ...stale, app_poll_at: sago(T, 180) } })).map((d) => d.rule)).not.toContain("kiosk_asleep");
  });

  it("kiosk_health_down fires when the Tailscale poller is off but the app polls and the daemon is silent", () => {
    const s = healthy(T, { reachable: { poller_ok_at: sago(T, 3600), kh_heartbeat_at: sago(T, 480), app_poll_at: sago(T, 1) } });
    expect(decide(s)[0]).toMatchObject({ rule: "kiosk_health_down", action: "ticket:restart_kiosk_health" });
  });

  it("kiosk_health_down stays quiet when neither the poller nor the app sees the Mac (that is the asleep rule's business)", () => {
    const s = healthy(T, { reachable: { poller_ok_at: sago(T, 3600), kh_heartbeat_at: sago(T, 480), app_poll_at: sago(T, 3600) } });
    expect(decide(s).map((d) => d.rule)).not.toContain("kiosk_health_down");
  });
});

// ---------------------------------------------------------------------------
// Round 2, F1: no new LIVE start (path C) + the replay table
// ---------------------------------------------------------------------------
import { readyRecorder } from "../support/steward-fixtures";

type Reach = { poller_ok_at?: string | null; kh_heartbeat_at?: string | null; app_poll_at?: string | null; sleep_at?: string | null };
/** 10:00 IST, no session, recorder ready 900 s, 0 attempts (the refuter's replay baseline). */
const roomWith = (reachable: Reach, at_ = T) => idle(at_, { reachable: { kh_enrolled: true, ...reachable }, recording: { recorder_history: readyRecorder(at_, 900) } });
const firstOf = (s: Parameters<typeof decideRoom>[0], at_ = T) => decideRoom(s, DEFAULT_CONFIG, at_, EMPTY_RECENT)[0]!;

describe("F1 — Steward: the app poll never switches off the sleep marker (path C)", () => {
  it("C: sleep/display-off marker 200 s old, kiosk-health 30 s, poller 3600 s, app poll 2 s -> kiosk_asleep ticket:wake, NEVER scribe_start", () => {
    const d = firstOf(roomWith({ sleep_at: sago(T, 200), kh_heartbeat_at: sago(T, 30), poller_ok_at: sago(T, 3600), app_poll_at: sago(T, 2) }));
    expect(d).toMatchObject({ rule: "kiosk_asleep", action: "ticket:wake" });
    expect(d.action).not.toBe("scribe_start");
  });

  /**
   * The refuter's cases A-K, same inputs. `main` is what origin/main (d6fb7f2) decided for the same room. The invariant: where this branch starts and main did not,
   * the start is shadow-only (start_gate_fail names a failed gate, so the LiveExecutor sends nothing). A case that starts LIVE where main did not is the defect.
   */
  const cases: Array<{ id: string; r: Reach; main: string; now?: string; session?: boolean }> = [
    { id: "A tailscale-off, kh 30 s", r: { poller_ok_at: sago(T, 3600), kh_heartbeat_at: sago(T, 30), app_poll_at: sago(T, 2) }, main: "scribe_start" },
    { id: "B poller 3600 / kh 240 / app 2", r: { poller_ok_at: sago(T, 3600), kh_heartbeat_at: sago(T, 240), app_poll_at: sago(T, 2) }, main: "ticket:wake" },
    { id: "C marker 200 s, kh 30, poller 3600, app 2", r: { sleep_at: sago(T, 200), poller_ok_at: sago(T, 3600), kh_heartbeat_at: sago(T, 30), app_poll_at: sago(T, 2) }, main: "ticket:wake" },
    { id: "C2 marker, app stale", r: { sleep_at: sago(T, 200), poller_ok_at: sago(T, 3600), kh_heartbeat_at: sago(T, 30), app_poll_at: sago(T, 3600) }, main: "ticket:wake" },
    { id: "C3 marker, no app", r: { sleep_at: sago(T, 200), poller_ok_at: sago(T, 3600), kh_heartbeat_at: sago(T, 30), app_poll_at: null }, main: "ticket:wake" },
    { id: "C4 marker, poller ok", r: { sleep_at: sago(T, 200), poller_ok_at: sago(T, 30), kh_heartbeat_at: sago(T, 30), app_poll_at: sago(T, 2) }, main: "scribe_start" },
    { id: "D kh 180.5 s, no app", r: { poller_ok_at: sago(T, 3600), kh_heartbeat_at: new Date(T - 180_500).toISOString(), app_poll_at: null }, main: "ticket:wake" },
    { id: "E all 240 s", r: { poller_ok_at: sago(T, 240), kh_heartbeat_at: sago(T, 240), app_poll_at: sago(T, 240) }, main: "ticket:wake" },
    { id: "F 21:40", r: { poller_ok_at: sago(T, 3600), kh_heartbeat_at: sago(T, 30), app_poll_at: sago(T, 2) }, main: "none", now: "21:40" },
    { id: "I only the app in 2 h", r: { poller_ok_at: null, kh_heartbeat_at: null, app_poll_at: sago(T, 600) }, main: "log_only" },
  ];

  for (const c of cases) {
    it(`replay ${c.id}: no live start where main did not`, () => {
      const at_ = c.now ? sist(c.now) : T;
      const shifted: Reach = c.now ? Object.fromEntries(Object.entries(c.r).map(([k, v]) => [k, v === null ? null : new Date(at_ - (T - Date.parse(v as string))).toISOString()])) : c.r;
      const d = firstOf(roomWith(shifted, at_), at_);
      if (d.action === "scribe_start" && c.main !== "scribe_start") {
        expect(d.inputs.start_gate_fail, "a start main did not make must be shadow-only").not.toBeNull();
      }
      // cases that are the same on both
      if (["A", "C ", "C2", "C3", "C4", "E ", "F "].some((p) => c.id.startsWith(p))) expect(d.action).toBe(c.main);
    });
  }

  it("replay G: recording, poller 3600 / kh 480 / app 1 -> kiosk_health_down restart ticket (a shadow ticket), never a start", () => {
    const s = healthy(T, { reachable: { poller_ok_at: sago(T, 3600), kh_heartbeat_at: sago(T, 480), app_poll_at: sago(T, 1) } });
    const d = firstOf(s);
    expect(d).toMatchObject({ rule: "kiosk_health_down", action: "ticket:restart_kiosk_health" });
  });

  it("replay J/K: a session open never produces scribe_start, with the Mac reachable or silent", () => {
    for (const r of [{ poller_ok_at: sago(T, 30), kh_heartbeat_at: sago(T, 30), app_poll_at: sago(T, 1) }, { poller_ok_at: sago(T, 3600), kh_heartbeat_at: sago(T, 600), app_poll_at: sago(T, 1) }]) {
      const s = healthy(T, { reachable: { ...r }, recording: { recorder_status: { state: "idle", session_open: false, received_at: sago(T, 20) } } });
      expect(decideRoom(s, DEFAULT_CONFIG, T, EMPTY_RECENT).map((d) => d.action)).not.toContain("scribe_start");
    }
  });
});
