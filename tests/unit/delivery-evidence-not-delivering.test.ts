/**
 * ETA-DELIVERY-EVIDENCE phase 1 (amendment 1) — "A room that stops delivering must say so."
 *
 * PURE. `deriveRow` is where NOT_DELIVERING is computed, at read time, against a fresh `nowMs` —
 * exactly the same shape every other row fact here already takes (Build R1 §6). No database: the
 * PRD's seven-row acceptance table is a table of `deriveRow` inputs and outputs, and that is what
 * every `it` below is.
 *
 * THE RULE IS IMPORTED, NOT RE-DERIVED. `isBenchStalled` and `STALLED_BADGE_MINUTES` both come
 * from lib/bench-reaper-core.ts — the same file lib/admin/rooms-live.ts and lib/mcp/tools/bench.ts
 * already import them from. This file imports `STALLED_BADGE_MINUTES` ONLY to compute boundary
 * offsets for its fixtures; it never writes its own copy of the 10-minute comparison.
 */
import { describe, it, expect } from "vitest";
import { deriveRow, type FleetRow, type InstallView } from "@/lib/room-install-view";
import { STALLED_BADGE_MINUTES } from "@/lib/bench-reaper-core";

const NOW = new Date("2026-09-17T09:00:00.000Z");
const nowMs = NOW.getTime();
const ago = (ms: number) => new Date(nowMs - ms).toISOString();
const ahead = (ms: number) => new Date(nowMs + ms).toISOString();

const MIN = 60_000;

type OpenSession = NonNullable<FleetRow["open_session"]>;
const session = (over: Partial<OpenSession> = {}): OpenSession => ({
  status: "recording",
  started_at: ago(120 * MIN),
  last_any_chunk_at: ago(2 * MIN),
  ...over,
});

const install = (over: Partial<InstallView> = {}): InstallView => ({
  install_id: "install_test_0001",
  room_id: "room_test_1",
  created_at: ago(10 * 86_400_000),
  enrolled_at: ago(10 * 86_400_000),
  session_expires_at: ahead(300 * 86_400_000),
  launched_by: "launchd",
  hostname: "TEST-MINI",
  hardware_model: "Mac mini M2",
  os_version: "macOS 15.6",
  input_device_name: "TONOR TM20 Audio Device",
  app_version: "0.1.24",
  build_sha: "abc1234",
  first_seen_at: ago(10 * 86_400_000),
  last_seen_at: ago(4_000),
  mic_state: "authorized",
  launch_agent_loaded: true,
  tape_advancing: true,
  tape_poll_streak: 20,
  tape_advancing_since: ago(600_000),
  never_sleep: true,
  retired_at: null,
  session_open: true,
  update_channel: "stable",
  last_update_result: "ok",
  last_update_version: null,
  last_update_error: null,
  last_update_at: null,
  disk_free_bytes: 200_000_000_000,
  ...over,
});

const row = (over: Partial<FleetRow> = {}): FleetRow => ({
  room_id: "room_test_1",
  room_slug: "test-room",
  room_name: "Test Room",
  disabled: false,
  install: install(),
  pending: null,
  last_retired: null,
  open_session: null,
  ...over,
});

// ---------------------------------------------------------------------------
// The PRD's acceptance table — one `it` per row, same order.
// ---------------------------------------------------------------------------

describe("ETA-DELIVERY-EVIDENCE §acceptance — the three incidents", () => {
  it("1: OPD 7 wedged 90 min — recording, four-field status, no error, last chunk 90 min old", () => {
    const view = deriveRow({
      row: row({
        install: install({ tape_advancing: true, session_open: true }), // "no error" — everything else reports fine
        open_session: session({ started_at: ago(150 * MIN), last_any_chunk_at: ago(90 * MIN) }),
      }),
      latestRelease: null,
      nowMs,
    });
    expect(view.not_delivering_minutes).toBe(90);
    expect(view.state).toBe("needs_attention");
  });

  it("2: OPD 3 logged out — a room that has simply gone, not a room that polls and reports no chunks", () => {
    // Fidelity matters here: the Mac vanished (LaunchAgent unloaded), so BOTH clocks go stale
    // together — install.last_seen_at (no new poll) AND the session's chunk clock (nothing ran
    // to produce a chunk). This is deliberately NOT "an alive Mac whose poll says zero chunks".
    const view = deriveRow({
      row: row({
        install: install({ last_seen_at: ago(69 * MIN), session_open: true, tape_advancing: true }),
        open_session: session({ started_at: ago(140 * MIN), last_any_chunk_at: ago(69 * MIN) }),
      }),
      latestRelease: null,
      nowMs,
    });
    expect(view.not_delivering_minutes).toBe(69);
    expect(view.state).toBe("needs_attention");
  });

  it('3: OPD 6 phantom — zero chunks ever, caught via the started_at fallback, not last_chunk_at', () => {
    const view = deriveRow({
      row: row({
        install: install({ session_open: true }),
        open_session: session({ started_at: ago(15 * MIN), last_any_chunk_at: null }),
      }),
      latestRelease: null,
      nowMs,
    });
    expect(view.not_delivering_minutes).toBe(15);
    expect(view.state).toBe("needs_attention");
  });
});

describe("ETA-DELIVERY-EVIDENCE §acceptance — the four controls", () => {
  it("A: open, healthy, chunk 2 min ago — no flag", () => {
    const view = deriveRow({
      row: row({ open_session: session({ last_any_chunk_at: ago(2 * MIN) }) }),
      latestRelease: null,
      nowMs,
    });
    expect(view.not_delivering_minutes).toBeNull();
    expect(view.state).toBe("healthy");
  });

  it("B: open, started 3 min ago, zero chunks yet — no flag (younger than the threshold)", () => {
    const view = deriveRow({
      row: row({ open_session: session({ started_at: ago(3 * MIN), last_any_chunk_at: null }) }),
      latestRelease: null,
      nowMs,
    });
    expect(view.not_delivering_minutes).toBeNull();
    expect(view.state).toBe("healthy");
  });

  it("C: paused — no flag, whether the join omits the session or a stale one is somehow seen", () => {
    // The realistic case: readFleet only joins `status: 'recording'` sessions, so a paused room's
    // open_session is null by construction.
    const omitted = deriveRow({ row: row({ open_session: null }), latestRelease: null, nowMs });
    expect(omitted.not_delivering_minutes).toBeNull();
    expect(omitted.state).toBe("healthy");
    // Defence in depth: `isBenchStalled` itself gates on status === "recording", so even a stale
    // paused session passed through would not flag.
    const stalePaused = deriveRow({
      row: row({ open_session: session({ status: "paused", last_any_chunk_at: ago(999 * MIN) }) }),
      latestRelease: null,
      nowMs,
    });
    expect(stalePaused.not_delivering_minutes).toBeNull();
    expect(stalePaused.state).toBe("healthy");
  });

  it("D: closed, idle — no flag; the case the old tape_advancing boolean could never tell from wedged", () => {
    const view = deriveRow({
      row: row({
        install: install({ session_open: false, tape_advancing: false }),
        open_session: null,
      }),
      latestRelease: null,
      nowMs,
    });
    expect(view.not_delivering_minutes).toBeNull();
    expect(view.state).toBe("healthy");
  });
});

// ---------------------------------------------------------------------------
// Item 5 — the words, and the one word that must never appear
// ---------------------------------------------------------------------------

describe("the chip's words", () => {
  it('reads "no audio delivered for Nm", not a bare boolean', () => {
    const view = deriveRow({
      row: row({ open_session: session({ last_any_chunk_at: ago(23 * MIN) }) }),
      latestRelease: null,
      nowMs,
    });
    expect(view.not_delivering_minutes).toBe(23);
  });

  it('never carries the word "recording" on a row NOT_DELIVERING has flagged — incident 3\'s exact shape', () => {
    // tape_advancing false + session_open true is the one branch that used to print
    // "recording, not advancing". A room in that state whose chunk clock has also gone stale
    // must not say "recording" anywhere in the row.
    const view = deriveRow({
      row: row({
        install: install({ tape_advancing: false, session_open: true }),
        open_session: session({ last_any_chunk_at: ago(12 * MIN) }),
      }),
      latestRelease: null,
      nowMs,
    });
    expect(view.not_delivering_minutes).toBe(12);
    expect(view.tape_label).toBe("not advancing");
    expect(JSON.stringify(view)).not.toMatch(/recording/i);
  });

  it("still says \"recording, not advancing\" on a room that is merely wedged, not NOT_DELIVERING yet", () => {
    // The one word's absence must be caused by the flag, not by touching unrelated wording.
    const view = deriveRow({
      row: row({
        install: install({ tape_advancing: false, session_open: true }),
        open_session: session({ last_any_chunk_at: ago(2 * MIN) }), // fresh — not stalled
      }),
      latestRelease: null,
      nowMs,
    });
    expect(view.not_delivering_minutes).toBeNull();
    expect(view.tape_label).toBe("recording, not advancing");
  });
});

// ---------------------------------------------------------------------------
// The rule is imported, not re-derived — proven at its own boundary
// ---------------------------------------------------------------------------

describe("the threshold is STALLED_BADGE_MINUTES, imported via isBenchStalled", () => {
  it("is still 10 — known fact, not re-derived here either", () => {
    expect(STALLED_BADGE_MINUTES).toBe(10);
  });

  it("does not fire at exactly the threshold, fires one minute past it", () => {
    const atThreshold = deriveRow({
      row: row({ open_session: session({ last_any_chunk_at: ago(STALLED_BADGE_MINUTES * MIN) }) }),
      latestRelease: null,
      nowMs,
    });
    expect(atThreshold.not_delivering_minutes).toBeNull();

    const pastThreshold = deriveRow({
      row: row({ open_session: session({ last_any_chunk_at: ago((STALLED_BADGE_MINUTES + 1) * MIN) }) }),
      latestRelease: null,
      nowMs,
    });
    expect(pastThreshold.not_delivering_minutes).toBe(STALLED_BADGE_MINUTES + 1);
  });
});

// ---------------------------------------------------------------------------
// Never on a retired install
// ---------------------------------------------------------------------------

describe("a retired install's session is not this Mac's to answer for", () => {
  it("stays null even when open_session is somehow still joined", () => {
    const view = deriveRow({
      row: row({
        install: install({ retired_at: ago(60 * MIN) }),
        open_session: session({ last_any_chunk_at: ago(90 * MIN) }),
      }),
      latestRelease: null,
      nowMs,
    });
    expect(view.not_delivering_minutes).toBeNull();
  });
});
