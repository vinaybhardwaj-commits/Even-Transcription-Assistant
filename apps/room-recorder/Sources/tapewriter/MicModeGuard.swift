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
  /// An API with its own call runner, so a call still hung in this one cannot affect it.
  func fresh() -> MicModeAPI
}

extension MicModeAPI {
  func fresh() -> MicModeAPI { self }
}

/// Runs a private call on a background queue and gives up after the timeout. A call that
/// outlasts its timeout is abandoned on its own queue; it never blocks or fails a later call.
final class MicModeCallRunner: @unchecked Sendable {
  let timeout: TimeInterval

  init(timeout: TimeInterval = 2) { self.timeout = timeout }

  func run<T>(
    fallback: T, timeout override: TimeInterval? = nil, _ body: @escaping @Sendable () -> T
  ) -> (value: T, timedOut: Bool) {
    let box = ResultBox<T>()
    let done = DispatchSemaphore(value: 0)
    DispatchQueue.global(qos: .utility).async {
      box.value = body()
      done.signal()
    }
    if done.wait(timeout: .now() + (override ?? timeout)) == .timedOut {
      return (fallback, true)
    }
    return (box.value ?? fallback, false)
  }

  private final class ResultBox<T>: @unchecked Sendable { var value: T? }
}

final class SystemMicModeAPI: MicModeAPI, @unchecked Sendable {
  /// Reads give up after 2 s; the Set gets longer because it can wait on the audio daemon.
  static let setTimeout: TimeInterval = 10

  let runner: MicModeCallRunner

  init(runner: MicModeCallRunner = MicModeCallRunner()) { self.runner = runner }

  func fresh() -> MicModeAPI { SystemMicModeAPI(runner: MicModeCallRunner(timeout: runner.timeout)) }

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
    let outcome = runner.run(fallback: (-2, "timeout" as String?), timeout: Self.setTimeout) {
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
  var setMs: Int?
  var unreadable = false

  var logLine: String {
    if unreadable { return "micmode before=unreadable set=skip bundle=\(bundleID)" }
    return "micmode before=\(before) set=\(setResult.map(String.init) ?? "skip") after=\(after) bundle=\(bundleID)"
      + (setMs.map { " set_ms=\($0)" } ?? "") + (error.map { " error=\($0)" } ?? "")
  }

  /// "ok", "skip", "fail", "timeout" or "unreadable".
  var statusWord: String {
    if unreadable { return "unreadable" }
    guard let setResult else { return "skip" }
    return MicModeGuard.setWord(setResult)
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

enum MicModeGuard {
  /// "ok" for a Set that returned 1, "timeout" for one that outlasted its timeout, else "fail".
  static func setWord(_ result: Int) -> String {
    switch result {
    case 1: return "ok"
    case -2: return "timeout"
    default: return "fail"
    }
  }

  /// One timed Set. The re-read of the mode that follows goes through `api.fresh()`.
  static func timedSet(id: String, api: MicModeAPI) -> (result: Int, error: String?, ms: Int) {
    let started = DispatchTime.now().uptimeNanoseconds
    let outcome = api.setStandard(bundleID: id)
    let ms = Int((DispatchTime.now().uptimeNanoseconds &- started) / 1_000_000)
    return (outcome.result, outcome.error, ms)
  }

  /// The offending value: the first positive of preferred and active; -1 if either is
  /// unreadable and neither is positive; else 0.
  static func worstMode(preferred: Int, active: Int) -> Int {
    if preferred > 0 { return preferred }
    if active > 0 { return active }
    return (preferred < 0 || active < 0) ? -1 : 0
  }

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
        let outcome = timedSet(id: id, api: api)
        report.setResult = outcome.result
        report.error = outcome.error
        report.setMs = outcome.ms
        report.after = api.fresh().preferredMode(bundleID: id)
      }
      log(report.logLine)
      reports.append(report)
    }
    if let last = reports.last {
      status(
        MicModeStatus(
          before: last.before, after: last.after, set: last.statusWord,
          at: MicModeStatusSink.isoNow(), setMs: last.setMs))
    }
    return reports
  }

  static func enforceStandardForMainBundle() {
    enforceStandard(ids: targetBundleIDs(mainBundleID: Bundle.main.bundleIdentifier))
  }
}

/// Every 60 s while recording, on a fresh runner each tick: read the preferred and the active
/// mode and log one line. Any non-zero value is Set back to 0 in place (no process restart,
/// status last_event "mic_mode_reset"), at most once per 2 minutes. An unreadable mode (-1) is
/// logged and written to the status as "unreadable"; it is never treated as healthy.
struct MicModeWatchdog {
  static let checkIntervalNS: UInt64 = 60_000_000_000
  static let resetIntervalSeconds: TimeInterval = 120
  static let resetEvent = "mic_mode_reset"

  private let responsibleID: String?
  private let api: MicModeAPI
  private let osMajor: Int
  private let log: (String) -> Void
  private let status: (MicModeStatus) -> Void
  private var nextCheckNS: UInt64?
  private var lastReset: Date?

  init(
    mainBundleID: String? = Bundle.main.bundleIdentifier,
    api: MicModeAPI = SystemMicModeAPI(),
    osMajor: Int = MicModeGuard.currentOSMajor,
    log: @escaping (String) -> Void = { print($0) },
    status: @escaping (MicModeStatus) -> Void = MicModeStatusSink.record
  ) {
    responsibleID = MicModeGuard.responsibleBundleID(mainBundleID: mainBundleID)
    self.api = api
    self.osMajor = osMajor
    self.log = log
    self.status = status
  }

  mutating func tick(nowNS: UInt64, now: Date = Date()) {
    if nextCheckNS == nil { nextCheckNS = nowNS &+ Self.checkIntervalNS }
    guard let due = nextCheckNS, nowNS >= due else { return }
    nextCheckNS = nowNS &+ Self.checkIntervalNS
    guard let id = responsibleID else { return }
    guard MicModeGuard.supportedOSMajors.contains(osMajor) else {
      log("micmode watchdog skipped: os \(osMajor)")
      return
    }
    let reader = api.fresh()
    guard reader.isAvailable else {
      log("micmode watchdog skipped: AVFCapture symbols unavailable")
      return
    }
    let preferred = reader.preferredMode(bundleID: id)
    let active = reader.activeMode(bundleID: id)
    log("micmode watchdog preferred=\(preferred) active=\(active) bundle=\(id)")
    let before = MicModeGuard.worstMode(preferred: preferred, active: active)
    if before == 0 { return }
    if before < 0 {
      status(
        MicModeStatus(
          before: -1, after: -1, set: "unreadable", at: MicModeStatusSink.isoNow()))
      return
    }
    if let last = lastReset, now >= last, now.timeIntervalSince(last) < Self.resetIntervalSeconds {
      log("micmode watchdog reset suppressed (2 min throttle) preferred=\(preferred) active=\(active)")
      return
    }
    lastReset = now
    let outcome = MicModeGuard.timedSet(id: id, api: api.fresh())
    let verify = api.fresh()
    let after = MicModeGuard.worstMode(
      preferred: verify.preferredMode(bundleID: id), active: verify.activeMode(bundleID: id))
    let word = MicModeGuard.setWord(outcome.result)
    log(
      "micmode watchdog reset before=\(before) set=\(outcome.result) after=\(after) set_ms=\(outcome.ms)"
        + (outcome.error.map { " error=\($0)" } ?? ""))
    status(
      MicModeStatus(
        before: before, after: after, set: word, at: MicModeStatusSink.isoNow(),
        setMs: outcome.ms, lastEvent: Self.resetEvent))
  }
}
