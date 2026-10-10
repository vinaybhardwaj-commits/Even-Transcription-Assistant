import Darwin
import Foundation

/// The recorder's per-user LaunchAgent plist, stated once so `install-launch-agent` and its test
/// read the same dictionary.
///
/// ─── KEEPALIVE IS TRUE, AND WHY (0.1.29) ──────────────────────────────────────────────────
/// Until 0.1.28 the agent carried `KeepAlive = {SuccessfulExit: false}`: restart on a non-zero exit,
/// stay stopped on zero. On 9 Oct 2026 an OPD room's app exited 0 and launchd never brought it
/// back; the room had no listener for about 26 hours while an orphan tapewriter kept writing. A
/// recorder that is meant to be resident has no exit it should stay stopped after — except the two
/// deliberate ones, which now park inside the process instead of leaving it
/// (`RoomLaunchAgent.parkForever`), so `true` cannot turn them into a restart loop.
///
/// `ThrottleInterval` 30 stays: a bundle that cannot launch retries twice a minute, not six times.
public enum RoomLaunchAgent {
  public static let label = "com.evenscribe.room-recorder"
  public static let throttleInterval = 30

  public static func plist(executablePath: String, rootPath: String, logPath: String) -> [String: Any] {
    [
      "Label": label,
      "ProgramArguments": [executablePath, "run", "--root", rootPath],
      "RunAtLoad": true,
      "KeepAlive": true,
      "ThrottleInterval": throttleInterval,
      "ProcessType": "Interactive",
      "StandardOutPath": logPath,
      "StandardErrorPath": logPath,
    ]
  }

  /// A retired install, or a Mac that was never enrolled, is a deliberate stop: there is nothing
  /// to retry and polling again is how a superseded copy takes a room back. With `KeepAlive true`
  /// the process must not exit, or launchd would restart it for ever. It stays alive and idle: no
  /// polling, no capture, nothing written.
  public static func parkForever() async -> Never {
    while true { try? await Task.sleep(nanoseconds: 3_600_000_000_000) }
  }

  /// Synchronous variant for the paths that run before any async context exists.
  public static func parkForeverBlocking() -> Never {
    while true { sleep(3600) }
  }
}
