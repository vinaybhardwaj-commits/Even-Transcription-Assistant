import Foundation

/// The signed command catalogue this build will run. CLOSED: a verb that is not a case here is
/// refused `verb_not_allowed`, whatever the server's own list says. No shell, no file path, no key
/// access, no network configuration.
///
/// These are the verbs the app already runs for the desk (restart, self-test, audio input,
/// diagnostics) plus the read-only Diagnose group of #41. The rest of the server's catalogue
/// (`coreaudiod_reset`, `pmset_enforce`, `update_bundle`, …) needs root work this build does not do.
public enum FleetVerb: String, CaseIterable, Sendable {
  // Diagnose (#41), read-only
  case helperStatus = "helper_status"
  case collectDiag = "collect_diag"
  case reportDiag = "report_diag"
  // App verbs that exist today
  case selectAudioInput = "select_audio_input"
  case selfTest = "self_test"
  case restartRecorder = "restart_recorder"

  /// Counted against the device ceiling (≤10 per hour).
  public var isPrivileged: Bool {
    switch self {
    case .helperStatus, .collectDiag, .reportDiag: return false
    case .selectAudioInput, .selfTest, .restartRecorder: return true
    }
  }

  /// Runs in the app through the engine (`true`) or asks the helper over XPC (`false`).
  public var runsInApp: Bool {
    switch self {
    case .reportDiag, .selectAudioInput, .selfTest, .restartRecorder: return true
    case .helperStatus, .collectDiag: return false
    }
  }

  public static let collectScopes: Set<String> = ["recorder", "audio", "power", "chrome", "helper"]
  public static let maxLogLines: Int64 = 500
  public static let maxDeviceUIDBytes = 256

  /// `nil` when the params are not exactly the closed schema for this verb.
  func parseParams(_ raw: [String: FleetJSON]) -> FleetParams? {
    func only(_ allowed: Set<String>) -> Bool { Set(raw.keys).isSubset(of: allowed) }
    switch self {
    case .helperStatus:
      return raw.isEmpty ? FleetParams(raw) : nil
    case .collectDiag:
      guard only(["scope", "log_lines"]), let scope = raw["scope"]?.stringValue,
        Self.collectScopes.contains(scope)
      else { return nil }
      if let lines = raw["log_lines"] {
        guard let n = lines.intValue, (0...Self.maxLogLines).contains(n) else { return nil }
      }
      return FleetParams(raw)
    case .reportDiag:
      guard only(["log_lines"]) else { return nil }
      if let lines = raw["log_lines"] {
        guard let n = lines.intValue, (0...Self.maxLogLines).contains(n) else { return nil }
      }
      return FleetParams(raw)
    case .selectAudioInput:
      // Volume is a whole percent: envelopes carry integers only, so 0.5 cannot be signed.
      guard only(["device_uid", "input_volume_pct"]), !raw.isEmpty else { return nil }
      if let uid = raw["device_uid"] {
        guard let s = uid.stringValue, (1...Self.maxDeviceUIDBytes).contains(s.utf8.count) else { return nil }
      }
      if let pct = raw["input_volume_pct"] {
        guard let n = pct.intValue, (0...100).contains(n) else { return nil }
      }
      return FleetParams(raw)
    case .selfTest:
      guard only(["volume_pct"]) else { return nil }
      if let pct = raw["volume_pct"] {
        guard let n = pct.intValue, (20...80).contains(n) else { return nil }
      }
      return FleetParams(raw)
    case .restartRecorder:
      guard only(["force"]) else { return nil }
      if let force = raw["force"] { guard force.boolValue != nil else { return nil } }
      return FleetParams(raw)
    }
  }

  /// PRD §6 gates that this build can evaluate. `restart_recorder` over an open session needs
  /// `force` and an `approval_ref`.
  func gate(params: FleetParams, approvalRef: String?, state: FleetGateState) -> FleetRefusal? {
    switch self {
    case .restartRecorder:
      if state.sessionOpen {
        let forced = params.raw["force"]?.boolValue == true
        if !(forced && approvalRef != nil) { return .sessionOpen }
      }
      return nil
    default:
      return nil
    }
  }
}

/// Params that have passed `FleetVerb.parseParams`. Holding one means the schema held.
public struct FleetParams: Equatable, Sendable {
  public let raw: [String: FleetJSON]
  init(_ raw: [String: FleetJSON]) { self.raw = raw }
}

/// The last 1,000 nonces and the recent result bodies, as the client persists them.
public struct FleetState: Codable, Equatable, Sendable {
  public static let nonceLimit = 1_000
  public static let resultLimit = 100

  public var deviceID: String?
  /// The install this state belongs to. A different install id (a re-enrolment) discards all of it.
  public var installID: String?
  /// Set when the server said REVOKED/RETIRED/unknown_device: the client stays down until re-enrolment.
  public var stoppedReason: String?
  public var nonces: [String] = []
  /// Epoch seconds of recent privileged runs.
  public var privilegedRuns: [Int] = []
  /// cmd_id → result body (the exact JSON text that is POSTed), newest last.
  public var results: [FleetStoredResult] = []

  public init(deviceID: String? = nil) { self.deviceID = deviceID }

  public func nonceSeen(_ nonce: String) -> Bool { nonces.contains(nonce) }

  public mutating func remember(nonce: String) {
    nonces.append(nonce)
    if nonces.count > Self.nonceLimit { nonces.removeFirst(nonces.count - Self.nonceLimit) }
  }

  public mutating func recordPrivilegedRun(at epoch: Int) {
    privilegedRuns.append(epoch)
    privilegedRuns.removeAll { $0 < epoch - 3600 }
  }

  public func privilegedRuns(inHourBefore epoch: Int) -> Int {
    privilegedRuns.filter { $0 > epoch - 3600 }.count
  }

  public mutating func store(result: FleetStoredResult) {
    results.removeAll { $0.cmdID == result.cmdID }
    results.append(result)
    if results.count > Self.resultLimit { results.removeFirst(results.count - Self.resultLimit) }
  }
}

public struct FleetStoredResult: Codable, Equatable, Sendable {
  public var cmdID: String
  public var body: String
  public var posted: Bool
  public init(cmdID: String, body: String, posted: Bool) {
    self.cmdID = cmdID
    self.body = body
    self.posted = posted
  }
}
