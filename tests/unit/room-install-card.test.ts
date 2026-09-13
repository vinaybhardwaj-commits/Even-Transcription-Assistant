/**
 * Build R1 §6 — the fleet card's decisions, pure.
 *
 * THE PROPERTY UNDER TEST IS A NEGATIVE ONE, and it is the whole point of the card: no step can
 * turn done without a Mac having said so. Every case below drives `deriveSteps` from an install
 * row — the thing a poll writes — and the only page-side input in the whole file is `copiedAt`,
 * which belongs to step 1 and to nothing else.
 */
import { describe, it, expect } from "vitest";
import {
  LAST_SEEN_ALARM_MS,
  SESSION_WARN_DAYS,
  deriveRow,
  deriveSteps,
  fmtSeen,
  type FleetRow,
  type InstallView,
  type ReleaseView,
} from "@/lib/room-install-view";
import { makeFakeClinician, makeFakeOperator } from "../support/fake-identity";

const FAKE_DOC = makeFakeClinician(5);
const FAKE_OPERATOR = makeFakeOperator(1);

const NOW = new Date("2026-09-07T14:40:00.000Z");
const nowMs = NOW.getTime();
const ago = (ms: number) => new Date(nowMs - ms).toISOString();
const ahead = (ms: number) => new Date(nowMs + ms).toISOString();

const install = (over: Partial<InstallView> = {}): InstallView => ({
  install_id: "install_d9k4s1jb6vn2",
  room_id: "room_1",
  created_at: ago(600_000),
  enrolled_at: ago(500_000),
  session_expires_at: ahead(365 * 86_400_000),
  launched_by: null,
  hostname: null,
  hardware_model: null,
  os_version: null,
  input_device_name: null,
  app_version: null,
  build_sha: null,
  first_seen_at: null,
  last_seen_at: ago(4_000),
  mic_state: "unknown",
  launch_agent_loaded: false,
  tape_advancing: false,
  tape_poll_streak: 0,
  tape_advancing_since: null,
  never_sleep: null,
  retired_at: null,
  ...over,
});

const release = (over: Partial<ReleaseView> = {}): ReleaseView => ({
  id: "rel_1",
  version: "1.0.3",
  build_sha: "abc1234",
  sha256: "a".repeat(64),
  size_bytes: 1024,
  blob_url: "https://x.public.blob.vercel-storage.com/a.zip",
  channel: "stable",
  published_at: ago(86_400_000),
  published_by: FAKE_OPERATOR.name,
  withdrawn_at: null,
  notes: null,
  min_macos: "15.0",
  ...over,
});

const row = (over: Partial<FleetRow> = {}): FleetRow => ({
  room_id: "room_1",
  room_slug: `opd-5-${FAKE_DOC.url_slug}`,
  room_name: `OPD 5 ${FAKE_DOC.label}`,
  disabled: false,
  install: null,
  pending: null,
  last_retired: null,
  ...over,
});

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

describe("the page never asserts completion from its own actions (§6)", () => {
  it("marks NOTHING done from a copy alone, except step 1", () => {
    const steps = deriveSteps({ install: null, copiedAt: ago(1000) });
    expect(steps.map((s) => s.state)).toEqual(["done", "waiting", "waiting", "waiting", "waiting"]);
  });

  it("labels step 1 'Command copied' and never 'Installed'", () => {
    const [one] = deriveSteps({ install: null, copiedAt: ago(1000) });
    expect(one!.title).toBe("Command copied");
    expect(one!.did).toMatch(/^Command copied /);
    expect(one!.note).toMatch(/does not mean the install finished/);
    expect(JSON.stringify(one)).not.toMatch(/Installed/);
  });

  it("never blocks step 1, whatever the Mac reports", () => {
    for (const i of [null, install({ launched_by: "user", mic_state: "denied" })]) {
      expect(deriveSteps({ install: i, copiedAt: ago(1) })[0]!.state).not.toBe("blocked");
    }
  });
});

// ---------------------------------------------------------------------------
// Step 2 — launchd, or it does not count
// ---------------------------------------------------------------------------

describe("step 2, app running (§6, mockup 2 / 2b)", () => {
  it("turns done on launchd, showing the hostname, model, OS and start time", () => {
    const s = deriveSteps({
      install: install({
        launched_by: "launchd",
        hostname: "OPD-5-MINI",
        hardware_model: "Mac mini M2",
        os_version: "macOS 15.6",
        first_seen_at: "2026-09-07T14:34:00.000Z",
      }),
      copiedAt: ago(120_000),
    })[1]!;
    expect(s.state).toBe("done");
    expect(s.did).toContain("OPD-5-MINI");
    expect(s.did).toContain("Mac mini M2");
    expect(s.did).toContain("macOS 15.6");
    expect(s.did).toContain("started by launchd");
  });

  it("turns BLOCKED on launched_by = user, and the instruction is to report it", () => {
    const s = deriveSteps({ install: install({ launched_by: "user" }), copiedAt: ago(1) })[1]!;
    expect(s.state).toBe("blocked");
    expect(s.note).toMatch(/Started by user, not launchd/);
    expect(s.note).toMatch(/stop and report/);
  });

  it("stays waiting while the Mac has not polled at all", () => {
    expect(deriveSteps({ install: install(), copiedAt: ago(1) })[1]!.state).toBe("waiting");
  });
});

// ---------------------------------------------------------------------------
// Step 3 — the microphone
// ---------------------------------------------------------------------------

describe("step 3, microphone (§6, mockup 3)", () => {
  it("turns done only on authorized", () => {
    expect(deriveSteps({ install: install({ mic_state: "authorized" }), copiedAt: null })[2]!.state).toBe("done");
    for (const m of ["unknown", "not_determined"] as const) {
      expect(deriveSteps({ install: install({ mic_state: m }), copiedAt: null })[2]!.state).toBe("waiting");
    }
  });

  it("blocks on denied and gives the System Settings path, and says nothing to press", () => {
    const s = deriveSteps({ install: install({ mic_state: "denied" }), copiedAt: null })[2]!;
    expect(s.state).toBe("blocked");
    expect(s.note).toContain("System Settings → Privacy & Security → Microphone");
    expect(s.note).toMatch(/nothing to press here/);
  });
});

// ---------------------------------------------------------------------------
// Step 4 — two consecutive polls, and never blocked
// ---------------------------------------------------------------------------

describe("step 4, tape advancing (§6)", () => {
  it("stays waiting on ONE poll and turns done on two in a row", () => {
    const one = install({ tape_advancing: true, tape_poll_streak: 1, tape_advancing_since: ago(3000) });
    expect(deriveSteps({ install: one, copiedAt: null })[3]!.state).toBe("waiting");

    const two = install({ tape_advancing: true, tape_poll_streak: 2, tape_advancing_since: ago(6000) });
    const s = deriveSteps({ install: two, copiedAt: null })[3]!;
    expect(s.state).toBe("done");
    expect(s.did).toMatch(/two polls in a row/);
    expect(s.did).toContain("app_install_d9k4s1jb6vn2");
  });

  it("is NEVER blocked — not even when the microphone is denied", () => {
    const s = deriveSteps({
      install: install({ mic_state: "denied", tape_advancing: false, tape_poll_streak: 0 }),
      copiedAt: null,
    })[3]!;
    expect(s.state).toBe("waiting");
    // It does explain itself, though: no audio can arrive through a denied microphone.
    expect(s.note).toMatch(/until the microphone is allowed/);
  });

  it("does not turn done on a streak with the flag since gone false", () => {
    const s = deriveSteps({
      install: install({ tape_advancing: false, tape_poll_streak: 5 }),
      copiedAt: null,
    })[3]!;
    expect(s.state).toBe("waiting");
  });
});

// ---------------------------------------------------------------------------
// Step 5 — auto-login is never done
// ---------------------------------------------------------------------------

describe("step 5, machine settings (§6)", () => {
  it("turns done on never_sleep and STILL carries the auto-login reminder", () => {
    const s = deriveSteps({ install: install({ never_sleep: true }), copiedAt: null })[4]!;
    expect(s.state).toBe("done");
    expect(s.did).toBe("Never sleep: detected");
    // §6: automatic login "stays a reminder and never turns done". Dropping it once never-sleep
    // landed would quietly lose the only instruction the operator still has to act on.
    expect(s.note).toMatch(/Automatic login/);
    expect(s.note).toMatch(/reminder, not checked/);
  });

  it("names the sleep setting's path once the Mac reports it is off", () => {
    const s = deriveSteps({ install: install({ never_sleep: false }), copiedAt: null })[4]!;
    expect(s.state).toBe("waiting");
    expect(s.note).toContain("Prevent automatic sleeping when the display is off");
  });

  it("is never blocked", () => {
    for (const v of [null, true, false]) {
      expect(deriveSteps({ install: install({ never_sleep: v }), copiedAt: null })[4]!.state).not.toBe("blocked");
    }
  });
});

// ---------------------------------------------------------------------------
// Row words and states (§6, D13)
// ---------------------------------------------------------------------------

describe("row words and states (§6)", () => {
  it("reads not installed with nothing bound, and enrolling once a token is out", () => {
    expect(deriveRow({ row: row(), latestRelease: release(), nowMs }).state).toBe("not_installed");
    expect(deriveRow({ row: row(), latestRelease: release(), nowMs }).words).toEqual(["not installed"]);

    const enrolling = deriveRow({
      row: row({ pending: install({ enrolled_at: null, created_at: ago(60_000) }) }),
      latestRelease: release(),
      nowMs,
    });
    expect(enrolling.state).toBe("enrolling");
    expect(enrolling.words).toEqual(["not installed"]);
  });

  it("distinguishes a room that HAD a Mac from one that never did", () => {
    const r = deriveRow({
      row: row({ last_retired: install({ retired_at: ago(86_400_000) }) }),
      latestRelease: release(),
      nowMs,
    });
    expect(r.state).toBe("retired");
  });

  it("reads healthy when everything the Mac reported is good", () => {
    const r = deriveRow({
      row: row({
        install: install({
          app_version: "1.0.3",
          mic_state: "authorized",
          tape_advancing: true,
          tape_poll_streak: 9,
          last_seen_at: ago(4_000),
        }),
      }),
      latestRelease: release(),
      nowMs,
    });
    expect(r.state).toBe("healthy");
    expect(r.words).toEqual(["installed"]);
    expect(r.attention).toEqual([]);
    expect(r.session_label).toBe("session expires in 365 d");
  });

  it("wears 'update pending' as a WORD, not as a state — an old version still records", () => {
    const r = deriveRow({
      row: row({
        install: install({
          app_version: "1.0.2",
          mic_state: "authorized",
          tape_advancing: true,
          last_seen_at: ago(4_000),
        }),
      }),
      latestRelease: release({ version: "1.0.3" }),
      nowMs,
    });
    expect(r.words).toEqual(["installed", "update pending"]);
    expect(r.state).toBe("healthy");
  });

  it("reads needs re-enrol on an expired session, and that outranks every other complaint", () => {
    const r = deriveRow({
      row: row({
        install: install({
          session_expires_at: ago(3 * 86_400_000),
          mic_state: "denied",
          last_seen_at: ago(3 * 86_400_000),
        }),
      }),
      latestRelease: release(),
      nowMs,
    });
    expect(r.words).toEqual(["needs re-enrol"]);
    expect(r.state).toBe("needs_attention");
    expect(r.session_label).toBe("session expired");
    // One reason, not four. The room stopped for one cause and that is the one to act on.
    expect(r.attention).toHaveLength(1);
    expect(r.attention[0]).toMatch(/stopped polling on a 401/);
  });

  it("warns at 30 days or fewer, and not at 31", () => {
    const at30 = deriveRow({
      row: row({ install: install({ session_expires_at: ahead(SESSION_WARN_DAYS * 86_400_000 + 1000), mic_state: "authorized", tape_advancing: true }) }),
      latestRelease: release(),
      nowMs,
    });
    expect(at30.session_warn).toBe(true);

    const at31 = deriveRow({
      row: row({ install: install({ session_expires_at: ahead(31 * 86_400_000), mic_state: "authorized", tape_advancing: true }) }),
      latestRelease: release(),
      nowMs,
    });
    expect(at31.session_warn).toBe(false);
  });

  it("calls a Mac dark past the alarm window, and does not also complain about its stale tape", () => {
    const r = deriveRow({
      row: row({ install: install({ last_seen_at: ago(LAST_SEEN_ALARM_MS + 60_000), mic_state: "authorized", tape_advancing: false }) }),
      latestRelease: release(),
      nowMs,
    });
    expect(r.state).toBe("needs_attention");
    expect(r.attention).toHaveLength(1);
    expect(r.attention[0]).toMatch(/No poll from this Mac for over 10 minutes/);
  });

  it("names an enrolled Mac that has never polled as exactly that", () => {
    const r = deriveRow({
      row: row({ install: install({ last_seen_at: null }) }),
      latestRelease: release(),
      nowMs,
    });
    expect(r.attention[0]).toMatch(/never polled/);
  });
});

describe("last-seen wording", () => {
  it("never renders a missing stamp as a number", () => {
    expect(fmtSeen(null, nowMs)).toBe("never");
    expect(fmtSeen("not a date", nowMs)).toBe("never");
  });

  it("counts up through the units the card shows", () => {
    expect(fmtSeen(ago(4_000), nowMs)).toBe("4 s ago");
    expect(fmtSeen(ago(12 * 60_000), nowMs)).toBe("12 min ago");
    expect(fmtSeen(ago(3 * 86_400_000), nowMs)).toBe("3 days ago");
  });
});
