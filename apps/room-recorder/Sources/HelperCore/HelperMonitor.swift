import FleetCore
import Foundation

/// The helper's own record of how things are, written to a root-owned, world-readable file every tick. This is the
/// "helper heartbeat" of #43/#46: `power_schedule`, `pmset_drift`, `app_state`.
///
/// It is a LOCAL file. The helper holds no server credential (the device key lives in the room user's keychain,
/// with the app), so it cannot post a heartbeat of its own; the app reads this through the `helperStatus` XPC verb and
/// reports it on its bench poll and in `status.json`.
public struct HelperHeartbeat: Codable, Equatable, Sendable {
  public var at: String
  public var helperVersion: String
  /// `ok` or `safe_mode`.
  public var state: String
  public var appState: String
  public var consoleUser: Bool
  public var powerSchedule: String
  public var pmsetDrift: [String]
  public var watchdogFailures: Int

  enum CodingKeys: String, CodingKey {
    case at, state
    case helperVersion = "helper_version"
    case appState = "app_state"
    case consoleUser = "console_user"
    case powerSchedule = "power_schedule"
    case pmsetDrift = "pmset_drift"
    case watchdogFailures = "watchdog_failures"
  }
}

/// Owns the periodic work: the watchdog (every 30 s) and the power policy (at start, then every 15 min).
public final class HelperMonitor: @unchecked Sendable {
  public static let powerInterval: TimeInterval = 15 * 60

  private let env: HelperEnvironment
  private let power: PowerPolicy
  public let watchdog: AppWatchdog
  private let safeMode: Bool
  private let heartbeatPath: String
  private let powerTimePath: String
  private let log: @Sendable (String) -> Void
  private let lock = NSLock()
  private var schedule = "none"
  private var drift: [String] = []

  public init(
    env: HelperEnvironment, tools: SystemTools, watchdog: AppWatchdog, safeMode: Bool, heartbeatPath: String,
    powerTimePath: String = HelperIdentity.supportDirectory + "/" + HelperPaths.powerTimeFile,
    log: @escaping @Sendable (String) -> Void
  ) {
    self.powerTimePath = powerTimePath
    self.env = env
    self.power = PowerPolicy(tools: tools)
    self.watchdog = watchdog
    self.safeMode = safeMode
    self.heartbeatPath = heartbeatPath
    self.log = log
  }

  /// At start and every 15 minutes: bring the baseline and the 07:05 power-on back, and say what changed.
  public func enforcePower() {
    let report = power.enforce()
    if !report.driftBefore.isEmpty {
      log("power: reverted \(report.driftBefore.joined(separator: ", ")); now \(report.driftAfter.isEmpty ? "at baseline" : "still off: \(report.driftAfter.joined(separator: ", "))")")
    }
    if !report.failures.isEmpty { log("power: could not apply \(report.failures.joined(separator: ", "))") }
    let time = PowerPolicy.storedTime(at: powerTimePath) ?? PowerPolicy.defaultPowerOn
    let sched = power.assertSchedule(time: time)
    if sched.changed { log("power: the scheduled power-on was missing; set \(time) every day") }
    if !sched.ok { log("power: could not set the scheduled power-on") }
    lock.lock()
    drift = report.driftAfter
    schedule = power.powerSchedule(time: time)
    lock.unlock()
  }

  /// One 30 s tick: watchdog, then the heartbeat file.
  @discardableResult
  public func tick() -> HelperHeartbeat {
    let state = watchdog.tick()
    let beat = snapshot(appState: state)
    write(beat)
    return beat
  }

  public func snapshot(appState: WatchdogAppState? = nil) -> HelperHeartbeat {
    lock.lock(); let drift = drift, schedule = schedule; lock.unlock()
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return HelperHeartbeat(
      at: formatter.string(from: env.now()), helperVersion: HelperIdentity.helperVersion,
      state: safeMode ? "safe_mode" : "ok", appState: (appState ?? watchdog.lastState).rawValue,
      consoleUser: env.consoleUser() != nil, powerSchedule: schedule, pmsetDrift: drift,
      watchdogFailures: watchdog.consecutiveFailures)
  }

  /// What the `helperStatus` XPC verb adds to its answer (all strings).
  public func statusDetail() -> [String: String] {
    let beat = snapshot()
    return [
      "state": beat.state, "app_state": beat.appState, "console_user": beat.consoleUser ? "true" : "false",
      "power_schedule": beat.powerSchedule, "pmset_drift": beat.pmsetDrift.joined(separator: ","),
      "watchdog_failures": String(beat.watchdogFailures),
    ]
  }

  private func write(_ beat: HelperHeartbeat) {
    guard let data = try? JSONEncoder().encode(beat) else { return }
    let url = URL(fileURLWithPath: heartbeatPath)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? data.write(to: url, options: .atomic)
    try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: heartbeatPath)
  }
}
