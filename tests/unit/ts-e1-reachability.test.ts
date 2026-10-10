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

  it("neither seen in 2 h is unknown (never unreachable): 7200 s is still unreachable, 7201 s is unknown; nothing at all is unknown", () => {
    expect(REACH_UNKNOWN_AFTER_S).toBe(7200);
    expect(reachability({ app_poll_at: at(7200) }, NOW).state).toBe("unreachable");
    expect(reachability({ app_poll_at: at(7201), kiosk_health_at: at(9000) }, NOW)).toEqual({ state: "unknown", source: null, last_evidence_at: null, age_s: null });
    expect(reachability({}, NOW).state).toBe("unknown");
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

  it("unknown (nothing in 2 h, or a source failed) raises nothing; it is not the same as down", () => {
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

  it("a reachable Mac with a failed poll and a silent extension is not offline and not a false no_chrome", () => {
    const row = ext({ reach: reachability({ kiosk_health_at: at(30) }, NOW), last_ext: { ts: at(3600), event: "heartbeat", reason: null }, poller: { ts: at(30), state: "unreachable", chrome_running: false, console_user: null } });
    expect(row.status).not.toBe("offline");
    expect(row.status).not.toBe("no_chrome");
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
