import Foundation
import MicModeShim

/// The macOS per-app Mic Mode calls, injectable so tests never touch the system.
/// `-1` from a getter and `nil` from `supportsStandard` mean "unreadable".
protocol MicModeAPI {
  var isAvailable: Bool { get }
  func preferredMode(bundleID: String) -> Int
  func activeMode(bundleID: String) -> Int
  func supportsStandard(bundleID: String) -> Bool?
  /// 1 ok, 0 refused, -1 exception or unavailable.
  func setStandard(bundleID: String) -> (result: Int, error: String?)
}

struct SystemMicModeAPI: MicModeAPI {
  var isAvailable: Bool { rr_micmode_available() == 1 }
  func preferredMode(bundleID: String) -> Int { Int(rr_micmode_get(bundleID)) }
  func activeMode(bundleID: String) -> Int { Int(rr_micmode_get_active(bundleID)) }
  func supportsStandard(bundleID: String) -> Bool? {
    switch rr_micmode_supported_contains(bundleID, 0) {
    case 1: return true
    case 0: return false
    default: return nil
    }
  }
  func setStandard(bundleID: String) -> (result: Int, error: String?) {
    var buffer = [CChar](repeating: 0, count: 256)
    let result = rr_micmode_set(bundleID, 0, &buffer, buffer.count)
    let message = String(cString: buffer)
    return (Int(result), message.isEmpty ? nil : message)
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
}

enum MicModeGuard {
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

  /// Forces Standard (0) when the mode is not 0 and 0 is supported (or the list is unreadable).
  /// Never throws; a missing symbol or failed Set leaves capture exactly as before.
  @discardableResult
  static func enforceStandard(
    ids: [String],
    api: MicModeAPI = SystemMicModeAPI(),
    log: (String) -> Void = { print($0) }
  ) -> [MicModeReport] {
    guard api.isAvailable else { return [] }
    var reports: [MicModeReport] = []
    for id in ids {
      let before = api.preferredMode(bundleID: id)
      var report = MicModeReport(
        bundleID: id, available: true, before: before, setResult: nil, after: before, error: nil)
      let supported = api.supportsStandard(bundleID: id)
      if before < 0 {
        report.unreadable = true
      } else if before > 0, supported != false {
        let outcome = api.setStandard(bundleID: id)
        report.setResult = outcome.result
        report.error = outcome.error
        report.after = api.preferredMode(bundleID: id)
      }
      log(report.logLine)
      reports.append(report)
    }
    return reports
  }

  static func enforceStandardForMainBundle() {
    enforceStandard(ids: targetBundleIDs(mainBundleID: Bundle.main.bundleIdentifier))
  }
}

/// Every 60 s while recording: if the active mode is not Standard, Set(0) and ask for one
/// session replacement, at most once per 10 minutes.
struct MicModeWatchdog {
  static let checkIntervalNS: UInt64 = 60_000_000_000
  static let replacementIntervalNS: UInt64 = 600_000_000_000

  private let ids: [String]
  private let responsibleID: String?
  private let api: MicModeAPI
  private let log: (String) -> Void
  private var nextCheckNS: UInt64?
  private var lastReplacementNS: UInt64?

  init(
    mainBundleID: String? = Bundle.main.bundleIdentifier,
    api: MicModeAPI = SystemMicModeAPI(),
    log: @escaping (String) -> Void = { print($0) }
  ) {
    ids = MicModeGuard.targetBundleIDs(mainBundleID: mainBundleID)
    responsibleID = MicModeGuard.responsibleBundleID(mainBundleID: mainBundleID)
    self.api = api
    self.log = log
  }

  /// True when the caller should replace the capture session now.
  mutating func tick(nowNS: UInt64) -> Bool {
    if nextCheckNS == nil { nextCheckNS = nowNS &+ Self.checkIntervalNS }
    guard let due = nextCheckNS, nowNS >= due else { return false }
    nextCheckNS = nowNS &+ Self.checkIntervalNS
    guard let id = responsibleID, api.isAvailable else { return false }
    let active = api.activeMode(bundleID: id)
    guard active > 0 else { return false }
    MicModeGuard.enforceStandard(ids: ids, api: api, log: log)
    if let last = lastReplacementNS, nowNS &- last < Self.replacementIntervalNS {
      log("micmode watchdog active=\(active) replacement suppressed (10 min throttle)")
      return false
    }
    lastReplacementNS = nowNS
    log("micmode watchdog active=\(active) requesting session replacement")
    return true
  }
}
