import Darwin
import Foundation
import HelperCore

/// The recorder's per-user LaunchAgent plist, stated once so `install-launch-agent` and its test
/// read the same dictionary.
///
/// ─── KEEPALIVE IS TRUE, AND WHY (0.1.29) ──────────────────────────────────────────────────
/// Until 0.1.28 the agent carried `KeepAlive = {SuccessfulExit: false}`: restart on a non-zero exit,
/// stay stopped on zero. On 9 Oct 2026 an OPD room's app exited 0 and launchd never brought it
/// back; the room had no listener for about 26 hours while an orphan tapewriter kept writing. A
/// recorder that is meant to be resident has no exit it should stay stopped after. 0.1.39: the two
/// states that used to park the process (a retired install, an install with no session) no longer
/// park either. A retired install re-polls every 5 minutes (0.1.38); an install with no session
/// re-reads its session and config every 5 minutes (`RoomEngine.awaitEnrolment`). Neither exits,
/// so `true` cannot turn them into a restart loop, and neither goes silent.
///
/// `ThrottleInterval` 30 stays: a bundle that cannot launch retries twice a minute, not six times.
public enum RoomLaunchAgent {
  public static let label = "com.evenscribe.room-recorder"
  public static let throttleInterval = 30

  public static func plist(executablePath: String, rootPath: String, logPath: String) -> [String: Any] {
    // One definition, shared with the root helper's watchdog, which rewrites this file when it goes missing.
    LaunchAgentPlist.dictionary(executablePath: executablePath, rootPath: rootPath, logPath: logPath)
  }
}
