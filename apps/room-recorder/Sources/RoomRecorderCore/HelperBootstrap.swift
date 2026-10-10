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
public enum HelperBootstrap {
  /// One registration pass. Returns what to report. `openSettings` is called at most once per process.
  @discardableResult
  public static func registrationPass(
    service: any HelperDaemonService, openSettings: () -> Void, settingsOpened: inout Bool,
    log: (String) -> Void
  ) -> (registration: String, error: String?) {
    var status = service.registrationName
    if status == "notRegistered" {
      do {
        try service.register()
        log("helper: register() accepted")
      } catch {
        let text = String(String(describing: error).prefix(200))
        log("helper: register() refused: \(text)")
        return (service.registrationName, text)
      }
      status = service.registrationName
    }
    switch status {
    case "requiresApproval":
      log("helper: requires approval in System Settings › General › Login Items & Extensions")
      if !settingsOpened {
        settingsOpened = true
        openSettings()
      }
    case "notFound":
      log("helper: notFound — the daemon plist is not in this bundle, or the app is not in /Applications")
    default:
      break
    }
    return (status, nil)
  }

  public static func start(
    probeInterval: TimeInterval = 60,
    log: @escaping @Sendable (String) -> Void = { message in
      FileHandle.standardError.write(Data("room-recorder: \(message)\n".utf8))
    }
  ) {
    guard Bundle.main.bundleURL.pathExtension == "app" else { return }
    Task.detached {
      var openedSettings = false
      var lastLogged = ""
      while !Task.isCancelled {
        let service = SMAppDaemonService()
        let result = registrationPass(
          service: service, openSettings: { SMAppService.openSystemSettingsLoginItems() },
          settingsOpened: &openedSettings, log: log)
        var version: String?
        var xpcOK: Bool?
        if result.registration == "enabled" {
          let reply = HelperClient().hello()
          xpcOK = reply?.ok == true
          version = reply?.detail["helper_version"]
          if xpcOK == false, lastLogged != "xpc_down" { log("helper: enabled but hello over XPC failed"); lastLogged = "xpc_down" }
        }
        HelperStatusCache.shared.set(
          HelperSnapshot(registration: result.registration, helperVersion: version, xpcOK: xpcOK),
          error: result.error)
        if lastLogged != result.registration {
          log("helper: registration is \(result.registration)")
          lastLogged = result.registration
        }
        try? await Task.sleep(nanoseconds: UInt64(probeInterval * 1_000_000_000))
      }
    }
  }
}
