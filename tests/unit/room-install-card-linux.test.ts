/**
 * The install checklist on a Linux room — and, first, proof that a Mac row reads exactly as it did.
 *
 * THE RULE CARRIED OVER UNCHANGED: no step turns done without the machine having said so. On Linux that
 * means step 2 turns done on the first poll (a systemd service that polled is running), step 3 is NOT
 * APPLICABLE rather than done (nothing grants a permission), and nothing here writes `launched_by` or
 * `mic_state` to make a tick go green.
 */
import { describe, it, expect } from "vitest";
import { deriveSteps, installPlatform, type InstallView } from "@/lib/room-install-view";

const NOW = Date.parse("2026-09-17T09:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const install = (over: Partial<InstallView> = {}): InstallView => ({
  install_id: "install_linux00000001",
  room_id: "room_1",
  created_at: ago(600_000),
  enrolled_at: ago(500_000),
  session_expires_at: ago(-365 * 86_400_000),
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
  session_open: null,
  update_channel: null,
  last_update_result: null,
  last_update_version: null,
  last_update_error: null,
  last_update_at: null,
  disk_free_bytes: null,
  ...over,
});

describe("installPlatform", () => {
  it("reads the Mac app's own os_version as a Mac, and a row that has not polled as a Mac", () => {
    expect(installPlatform(install({ os_version: "macOS 15.6" }))).toBe("macos");
    expect(installPlatform(install({ os_version: "macOS 27.0" }))).toBe("macos");
    expect(installPlatform(install({ os_version: null }))).toBe("macos");
    expect(installPlatform(null)).toBe("macos");
  });

  it("reads os-release PRETTY_NAME as Linux, and nothing unrecognised as Linux", () => {
    expect(installPlatform(install({ os_version: "Ubuntu 26.04 LTS" }))).toBe("linux");
    expect(installPlatform(install({ os_version: "Ubuntu 24.04.3 LTS" }))).toBe("linux");
    expect(installPlatform(install({ os_version: "Windows 11" }))).toBe("macos");
  });
});

describe("a Mac row's checklist does not move", () => {
  // Every combination the Mac steps branch on. A reported `macOS` version must give exactly what a row
  // with no os_version gives, which is the checklist every Mac had before this change.
  const variants: Array<Partial<InstallView>> = [
    {},
    { launched_by: "launchd", first_seen_at: ago(90_000) },
    { launched_by: "user", first_seen_at: ago(90_000) },
    { mic_state: "authorized" },
    { mic_state: "denied" },
    { mic_state: "not_determined" },
    { tape_advancing: true, tape_poll_streak: 2, tape_advancing_since: ago(30_000) },
    { never_sleep: true },
    { never_sleep: false },
  ];
  for (const v of variants) {
    it(`is unchanged for ${JSON.stringify(v)}`, () => {
      const legacy = deriveSteps({ install: install(v), copiedAt: ago(1000) });
      const reported = deriveSteps({ install: install({ ...v, os_version: "macOS 15.6" }), copiedAt: ago(1000) });
      expect(reported.map(({ did, ...rest }) => rest)).toEqual(legacy.map(({ did, ...rest }) => rest));
      expect(reported.some((s) => s.state === "not_applicable")).toBe(false);
    });
  }
});

describe("a Linux row's checklist", () => {
  const ubuntu = { os_version: "Ubuntu 26.04 LTS", hostname: "ot3-rec" };

  it("waits on step 2 until the first poll, then turns done without any launched_by", () => {
    const before = deriveSteps({ install: install({ ...ubuntu, first_seen_at: null }), copiedAt: ago(1000) });
    expect(before[1]!.state).toBe("waiting");
    const after = deriveSteps({ install: install({ ...ubuntu, first_seen_at: ago(60_000) }), copiedAt: ago(1000) });
    expect(after[1]!.state).toBe("done");
    expect(after[1]!.did).toContain("systemd service");
    expect(after[1]!.did).not.toContain("launchd");
  });

  it("marks step 3 not applicable — never done — with mic_state left unknown", () => {
    const s = deriveSteps({ install: install({ ...ubuntu, first_seen_at: ago(60_000) }), copiedAt: null });
    expect(s[2]!.state).toBe("not_applicable");
    expect(s[2]!.note).toMatch(/^Not applicable on Linux/);
    expect(s[2]!.note).not.toMatch(/System Settings/);
  });

  it("turns step 4 done on the same two-poll rule as a Mac", () => {
    const s = deriveSteps({
      install: install({ ...ubuntu, tape_advancing: true, tape_poll_streak: 2, tape_advancing_since: ago(30_000) }),
      copiedAt: null,
    });
    expect(s[3]!.state).toBe("done");
  });

  it("gives step 5 the Linux login rule, never the Mac reminder to turn automatic login on", () => {
    for (const never_sleep of [true, false, null]) {
      const five = deriveSteps({ install: install({ ...ubuntu, never_sleep }), copiedAt: null })[4]!;
      expect(five.note).toContain("Nobody needs to log in");
      expect(five.note).toContain("watch this checklist from another device");
      expect(five.note).not.toMatch(/Automatic login|System Settings/);
      expect(five.state).toBe(never_sleep === true ? "done" : "waiting");
    }
  });
});
