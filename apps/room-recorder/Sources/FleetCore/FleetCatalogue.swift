import Foundation

/// The signed command catalogue this build will run: PROTOCOL.md §8.3 (13 verbs, closed params) plus the two
/// power verbs of #43 that §8.3 does not list yet (`pmset_enforce`, `schedule_poweron`). CLOSED: a verb that is
/// not a case here is refused `verb_not_allowed`. No shell, no file path, no key access, no network
/// configuration.
public enum FleetVerb: String, CaseIterable, Sendable {
  // Diagnose
  case helperStatus = "helper_status"
  case collectDiag = "collect_diag"
  case reportDiag = "report_diag"
  // Audio (#42)
  case listAudioInputs = "list_audio_inputs"
  case selectAudioInput = "select_audio_input"
  case coreaudiodReset = "coreaudiod_reset"
  case usbReseat = "usb_reseat"
  case selfTest = "self_test"
  // Recorder lifecycle (#42)
  case restartRecorder = "restart_recorder"
  case reloadLaunchagent = "reload_launchagent"
  case piecesInventory = "pieces_inventory"
  case piecesReupload = "pieces_reupload"
  // Power (#43)
  case wake
  case pmsetEnforce = "pmset_enforce"
  case schedulePoweron = "schedule_poweron"

  /// §8.3 "privileged": these four need approval inside clinic hours and count against the hourly ceiling.
  /// `pmset_enforce` and `schedule_poweron` restore a fixed baseline and are NOT privileged; the server's
  /// catalogue must say the same or the two sides would refuse different things.
  public var isPrivileged: Bool {
    switch self {
    case .coreaudiodReset, .usbReseat, .restartRecorder, .reloadLaunchagent: return true
    default: return false
    }
  }

  /// §8.3 "runs": the root helper does these; the app does the rest.
  public var runsOnHelper: Bool {
    switch self {
    case .helperStatus, .collectDiag, .coreaudiodReset, .usbReseat, .restartRecorder, .reloadLaunchagent,
      .wake, .pmsetEnforce, .schedulePoweron:
      return true
    case .reportDiag, .listAudioInputs, .selectAudioInput, .selfTest, .piecesInventory, .piecesReupload:
      return false
    }
  }

  public static let collectScopes: Set<String> = ["recorder", "audio", "power", "chrome", "helper"]
  public static let maxLogLines: Int64 = 500

  /// A string with no control characters (U+0000...U+001F). Lone surrogates never get this far: the parser refuses them.
  static func cleanString(_ value: FleetJSON?, length: ClosedRange<Int>) -> String? {
    guard let text = value?.stringValue, length.contains(text.utf8.count),
      text.unicodeScalars.allSatisfy({ $0.value >= 0x20 })
    else { return nil }
    return text
  }

  /// `nil` when the params are not exactly the closed schema for this verb.
  func parseParams(_ raw: [String: FleetJSON]) -> FleetParams? {
    func only(_ allowed: Set<String>) -> Bool { Set(raw.keys).isSubset(of: allowed) }
    func isoMs(_ value: FleetJSON?) -> Bool {
      guard let text = value?.stringValue else { return false }
      return FleetEnvelope.matches(text, FleetEnvelope.isoMs)
    }
    switch self {
    case .helperStatus, .reportDiag, .listAudioInputs, .coreaudiodReset, .reloadLaunchagent, .wake, .pmsetEnforce:
      return raw.isEmpty ? FleetParams(raw) : nil
    case .collectDiag:
      guard only(["scope", "log_lines"]), let scope = raw["scope"]?.stringValue, Self.collectScopes.contains(scope)
      else { return nil }
      if let lines = raw["log_lines"] {
        guard let n = lines.intValue, (1...Self.maxLogLines).contains(n) else { return nil }
      }
      return FleetParams(raw)
    case .usbReseat:
      guard only(["port"]) else { return nil }
      if let port = raw["port"] { guard Self.cleanString(port, length: 1...32) != nil else { return nil } }
      return FleetParams(raw)
    case .restartRecorder:
      guard only(["force"]) else { return nil }
      if let force = raw["force"] { guard force.boolValue != nil else { return nil } }
      return FleetParams(raw)
    case .selectAudioInput:
      // Volume is a whole percent: envelopes carry integers only, so 0.5 cannot be signed.
      guard only(["device_uid", "input_volume_pct"]), Self.cleanString(raw["device_uid"], length: 1...128) != nil
      else { return nil }
      if let pct = raw["input_volume_pct"] { guard let n = pct.intValue, (0...100).contains(n) else { return nil } }
      return FleetParams(raw)
    case .selfTest:
      guard only(["volume_pct"]) else { return nil }
      if let pct = raw["volume_pct"] { guard let n = pct.intValue, (0...100).contains(n) else { return nil } }
      return FleetParams(raw)
    case .piecesInventory, .piecesReupload:
      guard only(["since"]) else { return nil }
      if let since = raw["since"] { guard isoMs(since) else { return nil } }
      return FleetParams(raw)
    case .schedulePoweron:
      guard only(["time"]) else { return nil }
      if let time = raw["time"] {
        guard let text = time.stringValue, FleetEnvelope.matches(text, "^([01][0-9]|2[0-3]):[0-5][0-9]$") else { return nil }
      }
      return FleetParams(raw)
    }
  }

  /// §8.4 / §8.5 step 8, in the order the verifier lists them: `session_open`, `no_console_user`,
  /// `clinic_hours_needs_approval`.
  func gate(params: FleetParams, approvalRef: String?, state: FleetGateState, now: Date) -> FleetRefusal? {
    let approved = approvalRef.map { FleetEnvelope.matches($0, FleetEnvelope.approvalPattern) } ?? false
    let forced = params.raw["force"]?.boolValue == true
    // An open session is never interrupted by a reset or a restart, unless the restart is forced AND approved.
    switch self {
    case .coreaudiodReset, .reloadLaunchagent:
      if state.sessionOpen { return .sessionOpen }
    case .restartRecorder:
      if state.sessionOpen, !(forced && approved) { return .sessionOpen }
    default: break
    }
    // The gui verbs need a GUI session to talk to.
    switch self {
    case .restartRecorder, .reloadLaunchagent:
      if !state.consoleUserPresent { return .noConsoleUser }
    default: break
    }
    // Inside clinic hours a privileged verb needs an approval_ref; a FORCED restart needs one at any hour.
    if isPrivileged, FleetClock.inClinicHours(now), !approved { return .clinicHoursNeedsApproval }
    if self == .restartRecorder, forced, !approved { return .clinicHoursNeedsApproval }
    return nil
  }
}

/// IST is UTC+05:30 with no daylight saving, so clinic hours are arithmetic on the UTC clock.
public enum FleetClock {
  /// 07:30 inclusive to 21:30 exclusive, IST, every day (§8.4).
  public static func inClinicHours(_ now: Date) -> Bool {
    let seconds = Int(now.timeIntervalSince1970) + 19_800
    let minuteOfDay = ((seconds % 86_400) + 86_400) % 86_400 / 60
    return minuteOfDay >= 450 && minuteOfDay < 1_290
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
  /// Epoch seconds of the last coreaudiod reset (the ceiling is one per 30 minutes).
  public var lastCoreaudiodReset: Int?
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
