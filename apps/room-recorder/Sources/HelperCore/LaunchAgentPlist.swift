import Foundation

/// The recorder's per-user LaunchAgent plist, stated once. The app's `install-launch-agent` and the root helper's
/// watchdog both write it, so they cannot drift apart.
///
/// `KeepAlive true` since 0.1.29: launchd restarts the app after ANY exit. `ThrottleInterval 30`: a bundle that
/// cannot launch retries twice a minute, not six times.
public enum LaunchAgentPlist {
  public static let label = "com.evenscribe.room-recorder"
  public static let throttleInterval = 30

  public static func dictionary(executablePath: String, rootPath: String, logPath: String) -> [String: Any] {
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

  public static func data(executablePath: String, rootPath: String, logPath: String) -> Data? {
    try? PropertyListSerialization.data(
      fromPropertyList: dictionary(executablePath: executablePath, rootPath: rootPath, logPath: logPath),
      format: .xml, options: 0)
  }
}
