import Foundation
import MicModeShim
import TapeCore

/// The macOS per-app Mic Mode calls, injectable so tests never touch the system.
/// `-1` from a getter and `nil` from `supportsStandard` mean "unreadable".
protocol MicModeAPI {
  var isAvailable: Bool { get }
  func preferredMode(bundleID: String) -> Int
  func activeMode(bundleID: String) -> Int
  func supportsStandard(bundleID: String) -> Bool?
  /// 1 ok, 0 refused, -1 exception or unavailable, -2 timed out.
  func setStandard(bundleID: String) -> (result: Int, error: String?)
}

/// Runs a private call on a background queue and gives up after the timeout. After the first
/// timeout every later call returns its fallback at once, so capture start is delayed by at
/// most one timeout.
final class MicModeCallRunner: @unchecked Sendable {
  let timeout: TimeInterval
  private let lock = NSLock()
  private var blocked = false

  init(timeout: TimeInterval = 2) { self.timeout = timeout }

  var didTimeOut: Bool { lock.withLock { blocked } }

  func run<T>(fallback: T, _ body: @escaping @Sendable () -> T) -> (value: T, timedOut: Bool) {
    if lock.withLock({ blocked }) { return (fallback, true) }
    let box = ResultBox<T>()
    let done = DispatchSemaphore(value: 0)
    DispatchQueue.global(qos: .utility).async {
      box.value = body()
      done.signal()
    }
    if done.wait(timeout: .now() + timeout) == .timedOut {
      lock.withLock { blocked = true }
      return (fallback, true)
    }
    return (box.value ?? fallback, false)
  }

  private final class ResultBox<T>: @unchecked Sendable { var value: T? }
}

final class SystemMicModeAPI: MicModeAPI, @unchecked Sendable {
  let runner: MicModeCallRunner

  init(runner: MicModeCallRunner = MicModeCallRunner()) { self.runner = runner }

  var isAvailable: Bool { runner.run(fallback: false) { rr_micmode_available() == 1 }.value }

  func preferredMode(bundleID: String) -> Int {
    runner.run(fallback: -1) { Int(rr_micmode_get(bundleID)) }.value
  }

  func activeMode(bundleID: String) -> Int {
    runner.run(fallback: -1) { Int(rr_micmode_get_active(bundleID)) }.value
  }

  func supportsStandard(bundleID: String) -> Bool? {
    let code = runner.run(fallback: -1) { Int(rr_micmode_supported_contains(bundleID, 0)) }.value
    switch code {
    case 1: return true
    case 0: return false
    default: return nil
    }
  }

  func setStandard(bundleID: String) -> (result: Int, error: String?) {
    let outcome = runner.run(fallback: (-2, "timeout" as String?)) {
      var buffer = [CChar](repeating: 0, count: 256)
      let result = rr_micmode_set(bundleID, 0, &buffer, buffer.count)
      let message = String(cString: buffer)
      return (Int(result), message.isEmpty ? nil : message)
    }
    return (outcome.value.0, outcome.value.1)
  }
}

struct MicModeReport: Equatable {
  var bundleID: String
  var available: Bool
  var before: Int
  var setResult: Int?
  var after: Int
  var error: String?
  var unreadable = false

  var logLine: String {
    if unreadable { return "micmode before=unreadable set=skip bundle=\(bundleID)" }
    return "micmode before=\(before) set=\(setResult.map(String.init) ?? "skip") after=\(after) bundle=\(bundleID)"
      + (error.map { " error=\($0)" } ?? "")
  }

  /// "ok", "skip", "fail" or "unreadable".
  var statusWord: String {
    if unreadable { return "unreadable" }
    guard let setResult else { return "skip" }
    return setResult == 1 ? "ok" : "fail"
  }
}

/// Where the guard result goes so the recorder's status.json can carry it. Tapewriter points it
/// at its segment directory once, at the top of `Recorder.run`.
enum MicModeStatusSink {
  nonisolated(unsafe) static var directory: URL?

  static func record(_ status: MicModeStatus) {
    guard let directory else { return }
    MicModeStatus.write(status, directory: directory)
  }

  static func isoNow(_ date: Date = Date()) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: date)
  }
}

/// Thrown by `Recorder.run`, after the segment is finished cleanly, when the watchdog wants a
/// fresh tapewriter process. The CLI turns it into `MicModeGuard.relaunchExitCode`.
public struct MicModeRelaunchRequested: Error {
  public init() {}
}

enum MicModeGuard {
  /// tapewriter exit code for "mic mode still not Standard; relaunch me". Not 0, not 75
  /// (`restart_engine`), so the existing unexpected-exit relaunch path takes it.
  static let relaunchExitCode: Int32 = 76

  /// The private calls are only exercised on the macOS majors they were proven on.
  static let supportedOSMajors = 26...27

  static var currentOSMajor: Int { ProcessInfo.processInfo.operatingSystemVersion.majorVersion }

  /// Bundle ids are derived at runtime. The HAL keys the preference by the parent bundle,
  /// so a trailing ".tapewriter" is stripped and both ids are returned (own id first).
  static func targetBundleIDs(mainBundleID: String?) -> [String] {
    guard let id = mainBundleID, !id.isEmpty else { return [] }
    var ids = [id]
    let suffix = ".tapewriter"
    if id.hasSuffix(suffix), id.count > suffix.count {
      ids.append(String(id.dropLast(suffix.count)))
    }
    return ids
  }

  /// Parent (HAL-keyed) id: the last entry of `targetBundleIDs`.
  static func responsibleBundleID(mainBundleID: String?) -> String? {
    targetBundleIDs(mainBundleID: mainBundleID).last
  }

  /// Forces Standard (0) when the preferred mode is a readable non-zero value (Voice Isolation,
  /// Wide Spectrum, or any value this code does not know) and 0 is supported or the list is
  /// unreadable. An unreadable mode (-1) is never Set. Never throws; a missing symbol, a wrong
  /// OS or a failed or hung Set leaves capture exactly as before.
  @discardableResult
  static func enforceStandard(
    ids: [String],
    api: MicModeAPI = SystemMicModeAPI(),
    osMajor: Int = MicModeGuard.currentOSMajor,
    log: (String) -> Void = { print($0) },
    status: (MicModeStatus) -> Void = MicModeStatusSink.record
  ) -> [MicModeReport] {
    guard supportedOSMajors.contains(osMajor) else {
      log("micmode skipped: os \(osMajor)")
      status(MicModeStatus(before: -1, after: -1, set: "skip", at: MicModeStatusSink.isoNow()))
      return []
    }
    guard api.isAvailable else {
      log("micmode skipped: AVFCapture symbols unavailable")
      status(MicModeStatus(before: -1, after: -1, set: "skip", at: MicModeStatusSink.isoNow()))
      return []
    }
    var reports: [MicModeReport] = []
    for id in ids {
      let before = api.preferredMode(bundleID: id)
      var report = MicModeReport(
        bundleID: id, available: true, before: before, setResult: nil, after: before, error: nil)
      if before < 0 {
        report.unreadable = true
      } else if before > 0, api.supportsStandard(bundleID: id) != false {
        let outcome = api.setStandard(bundleID: id)
        report.setResult = outcome.result
        report.error = outcome.error
        report.after = api.preferredMode(bundleID: id)
      }
      log(report.logLine)
      reports.append(report)
    }
    if let last = reports.last {
      status(
        MicModeStatus(
          before: last.before, after: last.after, set: last.statusWord,
          at: MicModeStatusSink.isoNow()))
    }
    return reports
  }

  static func enforceStandardForMainBundle() {
    enforceStandard(ids: targetBundleIDs(mainBundleID: Bundle.main.bundleIdentifier))
  }
}

/// Remembers when the watchdog last asked for a restart, so a relaunched tapewriter honours the
/// 10-minute throttle.
protocol MicModeRestartStore {
  func lastRestart() -> Date?
  func saveRestart(_ date: Date)
}

struct FileMicModeRestartStore: MicModeRestartStore {
  let directory: URL
  static let fileName = "mic-mode-restart.json"

  private var url: URL { directory.appendingPathComponent(Self.fileName, isDirectory: false) }

  func lastRestart() -> Date? {
    guard let data = try? Data(contentsOf: url),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let epoch = object["last_restart_epoch"] as? Double
    else { return nil }
    return Date(timeIntervalSince1970: epoch)
  }

  func saveRestart(_ date: Date) {
    let object: [String: Any] = ["last_restart_epoch": date.timeIntervalSince1970]
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    try? data.write(to: url, options: .atomic)
  }
}

struct MemoryMicModeRestartStore: MicModeRestartStore {
  func lastRestart() -> Date? { nil }
  func saveRestart(_ date: Date) {}
}

/// Every 60 s while recording: if the active mode is not Standard, Set(0) and, if it is still
/// not Standard, ask for a tapewriter process restart, at most once per 10 minutes (the time of
/// the last restart is persisted, so the relaunched process keeps the limit).
struct MicModeWatchdog {
  static let checkIntervalNS: UInt64 = 60_000_000_000
  static let restartIntervalSeconds: TimeInterval = 600

  private let ids: [String]
  private let responsibleID: String?
  private let api: MicModeAPI
  private let osMajor: Int
  private let log: (String) -> Void
  private let status: (MicModeStatus) -> Void
  private let store: MicModeRestartStore
  private var nextCheckNS: UInt64?
  private var lastRestart: Date?

  init(
    mainBundleID: String? = Bundle.main.bundleIdentifier,
    api: MicModeAPI = SystemMicModeAPI(),
    osMajor: Int = MicModeGuard.currentOSMajor,
    store: MicModeRestartStore = MemoryMicModeRestartStore(),
    log: @escaping (String) -> Void = { print($0) },
    status: @escaping (MicModeStatus) -> Void = MicModeStatusSink.record
  ) {
    ids = MicModeGuard.targetBundleIDs(mainBundleID: mainBundleID)
    responsibleID = MicModeGuard.responsibleBundleID(mainBundleID: mainBundleID)
    self.api = api
    self.osMajor = osMajor
    self.store = store
    self.log = log
    self.status = status
    lastRestart = store.lastRestart()
  }

  /// True when the caller should finish the segment and exit for a relaunch.
  mutating func tick(nowNS: UInt64, now: Date = Date()) -> Bool {
    if nextCheckNS == nil { nextCheckNS = nowNS &+ Self.checkIntervalNS }
    guard let due = nextCheckNS, nowNS >= due else { return false }
    nextCheckNS = nowNS &+ Self.checkIntervalNS
    guard MicModeGuard.supportedOSMajors.contains(osMajor), let id = responsibleID,
      api.isAvailable
    else { return false }
    let active = api.activeMode(bundleID: id)
    guard active > 0 else { return false }
    MicModeGuard.enforceStandard(ids: ids, api: api, osMajor: osMajor, log: log, status: status)
    let stillActive = api.activeMode(bundleID: id)
    guard stillActive > 0 else {
      log("micmode watchdog active=\(active) cleared after set")
      return false
    }
    if let last = lastRestart, now.timeIntervalSince(last) < Self.restartIntervalSeconds,
      now >= last
    {
      log("micmode watchdog active=\(stillActive) restart suppressed (10 min throttle)")
      return false
    }
    lastRestart = now
    store.saveRestart(now)
    log("micmode watchdog active=\(stillActive) after set; finishing segment and exiting for relaunch")
    return true
  }
}
