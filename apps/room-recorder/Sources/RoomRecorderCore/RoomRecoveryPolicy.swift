import Foundation
import HelperCore

// 0.1.39 (FR-1 C2). The decisions behind three self-recovery rules, kept pure so a test can pin each
// one without a clock, a microphone or a tapewriter. The engine only supplies facts and acts on the answer.
//
// NOTHING HERE STOPS AN OPEN RECORDING. The stall watchdog restarts the capture owner of a session whose
// tape has stopped growing; it never ends, pauses or abandons the session, and never touches the process.

/// At most `capPerHour` recovery starts in any rolling hour. A start that keeps failing must not turn into a
/// tight loop that hammers the server and the microphone; the third failure ends the attempts until the hour rolls.
public struct StartRetryGovernor: Sendable, Equatable {
  public static let capPerHour = 3
  public static let window: TimeInterval = 3600

  private var attempts: [Date] = []

  public init() {}

  /// True and counted when an attempt is allowed now; false, and not counted, when the hour's cap is spent.
  public mutating func permit(now: Date) -> Bool {
    attempts.removeAll { now.timeIntervalSince($0) >= Self.window || $0 > now }
    guard attempts.count < Self.capPerHour else { return false }
    attempts.append(now)
    return true
  }
}

/// A start the engine may retry on its own once the microphone or the device is back (A4 G3, G4).
/// Only from `.failed`: from `.ready` the engine's own auto-start already retries, behind the same gate and cap.
public enum RecoveryStart {
  public enum Decision: Equatable, Sendable {
    case notDue
    /// Every gate is open. `windowStartMs` is the clinic window the day belongs to.
    case start(windowStartMs: Int64)
    /// Every gate is open but this hour's three attempts are spent.
    case capped
  }

  /// Retry only a day that never started: the window is open, nothing was started in it by any path, the engine
  /// is failed with nothing to reconcile, the install is not retired, the microphone is authorised and the
  /// configured device is not known to be missing. The cap is consulted LAST, so only a real attempt is counted.
  public static func decide(
    schedule: RoomSchedule,
    now: Date,
    phase: RoomEnginePhase,
    needsReconciliation: Bool,
    captureActive: Bool,
    retired: Bool,
    lastStartedWindowMs: Int64?,
    disabled: Bool,
    micState: String,
    deviceReadiness: RoomEngine.InputReadiness,
    governor: inout StartRetryGovernor
  ) -> Decision {
    guard !disabled, !retired, !captureActive, !needsReconciliation,
      phase == .failed,
      let window = schedule.activeWindow(at: now)
    else { return .notDue }
    if let last = lastStartedWindowMs, last >= window.startMs { return .notDue }
    guard micState == "authorized", deviceReadiness != .notReady else { return .notDue }
    guard governor.permit(now: now) else { return .capped }
    return .start(windowStartMs: window.startMs)
  }
}

/// A session is recording and the tape file has not grown for `stallSeconds` (A4 G5).
public struct CaptureStallWatchdog: Sendable, Equatable {
  public static let stallSeconds: TimeInterval = 180
  /// A second stall within this long of a restart is a REPEAT: the restart did not cure it, so it escalates.
  public static let repeatWindow: TimeInterval = 3600

  public enum Verdict: Equatable, Sendable {
    case healthy
    /// Restart the capture owner now. `repeated` means an earlier restart in the last hour did not hold.
    case stalled(repeated: Bool)
  }

  private var lastProgressAt: Date?
  private var restarts: [Date] = []

  public init() {}

  /// `recording`: a plain capture is open and the session is recording (a paused session grows no tape on purpose).
  /// `advanced`: the tape file is larger than at the previous look.
  public mutating func observe(recording: Bool, advanced: Bool, now: Date) -> Verdict {
    guard recording else {
      lastProgressAt = nil
      return .healthy
    }
    guard let last = lastProgressAt else {
      lastProgressAt = now
      return .healthy
    }
    if advanced {
      lastProgressAt = now
      return .healthy
    }
    guard now.timeIntervalSince(last) >= Self.stallSeconds else { return .healthy }
    restarts.removeAll { now.timeIntervalSince($0) >= Self.repeatWindow }
    let repeated = !restarts.isEmpty
    restarts.append(now)
    // The restarted owner gets a fresh three minutes before it can be judged stalled again.
    lastProgressAt = now
    return .stalled(repeated: repeated)
  }

  /// The engine calls this after it has opened a new capture, so a slow-starting tape is not read as a stall.
  public mutating func graceAfterRestart(now: Date) { lastProgressAt = now }
}

extension RoomEngine {
  /// How long an install with no session waits before it reads its session and config again.
  public static let enrolmentRereadNanoseconds: UInt64 = 300_000_000_000

  /// 0.1.39 (A4 G1). The configuration to run with, waiting for enrolment instead of parking.
  ///
  /// `startingConfiguration` writes `needs_enrol` to status.json and says why on stderr each time it finds no
  /// session, so the status stays fresh. The session and config.json are read again every 5 minutes; the moment a
  /// session is there the configuration comes back and the caller carries on as a normal launch. The process
  /// never exits (KeepAlive would restart it) and never goes silent. Any other error is the caller's, as before.
  public static func awaitEnrolment(
    rootURL: URL = defaultRootURL,
    enrolmentReader: (@Sendable () -> RoomKeychainRecord?)? = nil,
    interval: UInt64 = enrolmentRereadNanoseconds,
    sleep: @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) }
  ) async throws -> RoomConfiguration {
    while true {
      do {
        return try startingConfiguration(rootURL: rootURL, enrolmentReader: enrolmentReader)
      } catch RoomEngineError.needsEnrolment {
        try await sleep(interval)
      }
    }
  }
}

/// 0.1.39 (A2 row 7). The `probe-helper` subcommand's answer: one XPC hello, then one line.
public enum HelperProbe {
  public static let timeoutSeconds: TimeInterval = 3

  public struct Line: Equatable, Sendable {
    public let text: String
    public let ok: Bool
  }

  /// PURE. `ok <helper version>` for an accepted hello; `fail no_answer` when nothing came back (timeout, refusal or
  /// a peer that failed the code-signing requirement); `fail <code>` when the helper answered not-ok. The version
  /// is cut to a short run of `[0-9A-Za-z.-]` so nothing else can ride out on the line.
  public static func line(_ response: HelperResponse?) -> Line {
    guard let response else { return Line(text: "fail no_answer", ok: false) }
    guard response.ok else { return Line(text: "fail \(sanitised(response.code, fallback: "refused"))", ok: false) }
    return Line(text: "ok \(sanitised(response.detail["helper_version"] ?? "", fallback: "unknown"))", ok: true)
  }

  public static func probe(client: HelperClient = HelperClient()) -> Line {
    line(client.hello(timeout: timeoutSeconds))
  }

  private static func sanitised(_ value: String, fallback: String) -> String {
    let allowed = value.unicodeScalars.filter {
      ($0.value >= 48 && $0.value <= 57) || ($0.value >= 65 && $0.value <= 90)
        || ($0.value >= 97 && $0.value <= 122) || $0 == "." || $0 == "-" || $0 == "_"
    }
    let cleaned = String(String.UnicodeScalarView(allowed).prefix(32))
    return cleaned.isEmpty ? fallback : cleaned
  }
}
