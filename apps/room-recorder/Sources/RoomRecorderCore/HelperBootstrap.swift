import Foundation
import HelperCore
import ServiceManagement

/// The last helper reading, for the bench poll and status.json. Written by `HelperBootstrap`, read by the engine.
public final class HelperStatusCache: @unchecked Sendable {
  public static let shared = HelperStatusCache()
  private let lock = NSLock()
  private var value: HelperSnapshot?
  private var error: String?

  public var snapshot: HelperSnapshot? {
    lock.lock(); defer { lock.unlock() }
    return value
  }

  /// The last `register()` failure, or nil.
  public var registrationError: String? {
    lock.lock(); defer { lock.unlock() }
    return error
  }

  func set(_ snapshot: HelperSnapshot?, error: String? = nil) {
    lock.lock(); defer { lock.unlock() }
    value = snapshot
    self.error = error
  }
}

/// What `HelperBootstrap` needs from `SMAppService`, so the registration logic can be driven by a test.
public protocol HelperDaemonService {
  var registrationName: String { get }
  func register() throws
}

struct SMAppDaemonService: HelperDaemonService {
  var registrationName: String { HelperRegistration.name(HelperRegistration.service.status) }
  func register() throws { try HelperRegistration.service.register() }
}

/// App side of TS-H2 #39: register the helper at launch, keep probing it, and send the user to
/// Login Items when macOS wants approval.
///
/// ─── 0.1.30: IDEMPOTENT, LOGGED, VISIBLE ──────────────────────────────────────────────────
/// After the 0.1.29 proof install on OPD 6 the helper was not registered and nothing said why: the
/// error from `register()` was dropped. Now every step is logged, the status and the last error
/// are kept for status.json and the bench row, and `register()` is called on every start while
/// the daemon is `notRegistered` (a no-op once registered).
/// What one process remembers between registration passes.
public struct HelperRegistrationState: Equatable, Sendable {
  /// `register()` calls made so far in this process.
  public var attempts = 0
  public var settingsOpened = false
  /// The last refusal, as `domain=… code=…: …`; cleared by a register() that is accepted.
  public var lastError: String?
  public init() {}

  /// One attempt on start, plus one retry a probe interval (60 s) later. Then no more: a daemon that
  /// macOS will not register is not made registrable by asking every minute, and the log must not fill.
  public static let maxAttempts = 2
}

public enum HelperBootstrap {
  /// Statuses where `register()` has nothing to do: it is on, or it is waiting for the user.
  static let settled: Set<String> = ["enabled", "requiresApproval"]

  /// `domain=SMAppServiceErrorDomain code=2: …`, bounded. The three things an operator needs.
  public static func describe(_ error: Error) -> String {
    let ns = error as NSError
    return String("domain=\(ns.domain) code=\(ns.code): \(ns.localizedDescription)".prefix(200))
  }

  /// A refusal that is about the daemon's SIGNATURE rather than about approval or the plist.
  /// INFERRED: Apple does not document the text. A self-signed leaf with no Team ID is the case
  /// this is for; it is recognised by the words macOS uses or by the invalid-signature code (2) in
  /// the ServiceManagement domain. The text is always logged whole, so a miss here loses nothing.
  public static func looksLikeSigningFailure(_ error: Error) -> Bool {
    let ns = error as NSError
    let text = ns.localizedDescription.lowercased()
    if ["signature", "code sign", "codesign", "team id", "not signed", "certificate"].contains(where: text.contains) {
      return true
    }
    return ns.domain.contains("ServiceManagement") || ns.domain.contains("SMAppService") ? ns.code == 2 : false
  }

  /// One registration pass.
  ///
  /// `register()` is called whenever the daemon is anything other than `enabled` or
  /// `requiresApproval` — `notRegistered` AND `notFound` (0.1.31: on OPD 6 the status read
  /// `notFound` and the old code, which only tried on `notRegistered`, never asked) — at most
  /// `HelperRegistrationState.maxAttempts` times per process. `openSettings` is called at most once.
  @discardableResult
  public static func registrationPass(
    service: any HelperDaemonService, openSettings: () -> Void, state: inout HelperRegistrationState,
    log: (String) -> Void
  ) -> (registration: String, error: String?) {
    var status = service.registrationName
    if !settled.contains(status), state.attempts < HelperRegistrationState.maxAttempts {
      state.attempts += 1
      do {
        try service.register()
        state.lastError = nil
        log("helper: register() accepted (attempt \(state.attempts), status was \(status))")
      } catch {
        let text = describe(error)
        state.lastError = text
        log("helper: register() refused (attempt \(state.attempts) of \(HelperRegistrationState.maxAttempts), status was \(status)): \(text)")
        if looksLikeSigningFailure(error) {
          log("helper: this is a SIGNING refusal: macOS will not register a daemon signed with a self-signed certificate that has no Team ID; the bundle is otherwise fine")
        }
      }
      status = service.registrationName
    }
    if settled.contains(status), status == "enabled" { state.lastError = nil }
    switch status {
    case "requiresApproval":
      log("helper: requires approval in System Settings › General › Login Items & Extensions")
      if !state.settingsOpened {
        state.settingsOpened = true
        openSettings()
      }
    case "notFound":
      log("helper: notFound after \(state.attempts) register attempt(s) — the daemon plist is not in this bundle, or the app is not in /Applications")
    default:
      break
    }
    return (status, state.lastError)
  }

  /// What one probe found.
  public struct Probe: Equatable, Sendable {
    public var mode: String
    public var registration: String
    public var helperVersion: String?
    public var xpcOK: Bool?
    public var error: String?
  }

  /// One probe of the helper, in whichever mode it runs (0.1.32).
  ///
  /// - `launchd`: the pkg installed a system LaunchDaemon (its plist exists). The job needs no
  ///   approval and is not an SMAppService item, so `register()` is NEVER called while it is there:
  ///   two registrations of one Mach service would fight. The status is `enabled` when the helper
  ///   answers a hello over XPC, `notAnswering` when it does not.
  /// - `smappservice`: no system plist; the bundle's own daemon plist is registered as before
  ///   (`registrationPass`).
  /// - `none`: neither exists (`SMAppService` says notFound even after the attempts).
  public static func probe(
    systemPlistExists: () -> Bool, service: any HelperDaemonService, hello: () -> HelperResponse?,
    openSettings: () -> Void, state: inout HelperRegistrationState, log: (String) -> Void
  ) -> Probe {
    if systemPlistExists() {
      let reply = hello()
      let answering = reply?.ok == true
      return Probe(
        mode: "launchd", registration: answering ? "enabled" : "notAnswering",
        helperVersion: reply?.detail["helper_version"], xpcOK: answering, error: nil)
    }
    let result = registrationPass(service: service, openSettings: openSettings, state: &state, log: log)
    var version: String?
    var xpcOK: Bool?
    if result.registration == "enabled" {
      let reply = hello()
      xpcOK = reply?.ok == true
      version = reply?.detail["helper_version"]
    }
    let mode = result.registration == "notFound" ? "none" : "smappservice"
    return Probe(mode: mode, registration: result.registration, helperVersion: version, xpcOK: xpcOK, error: result.error)
  }

  public static func start(
    probeInterval: TimeInterval = 60,
    log: @escaping @Sendable (String) -> Void = { message in
      FileHandle.standardError.write(Data("room-recorder: \(message)\n".utf8))
    }
  ) {
    guard Bundle.main.bundleURL.pathExtension == "app" else { return }
    Task.detached {
      var registration = HelperRegistrationState()
      var lastLogged = ""
      while !Task.isCancelled {
        let found = probe(
          systemPlistExists: { FileManager.default.fileExists(atPath: HelperIdentity.systemDaemonPlistPath) },
          service: SMAppDaemonService(), hello: { HelperClient().hello() },
          openSettings: { SMAppService.openSystemSettingsLoginItems() }, state: &registration, log: log)
        HelperStatusCache.shared.set(
          HelperSnapshot(registration: found.registration, helperVersion: found.helperVersion, xpcOK: found.xpcOK, mode: found.mode),
          error: found.error)
        let summary = "\(found.mode)/\(found.registration)/\(found.xpcOK.map(String.init(describing:)) ?? "-")"
        if lastLogged != summary {
          log("helper: mode \(found.mode), registration \(found.registration)" + (found.xpcOK == false ? ", XPC not answering" : ""))
          lastLogged = summary
        }
        try? await Task.sleep(nanoseconds: UInt64(probeInterval * 1_000_000_000))
      }
    }
  }
}
