import Foundation
import HelperCore
import ServiceManagement

/// The last helper reading, for the bench poll. Written by `HelperBootstrap`, read by the engine.
public final class HelperStatusCache: @unchecked Sendable {
  public static let shared = HelperStatusCache()
  private let lock = NSLock()
  private var value: HelperSnapshot?

  public var snapshot: HelperSnapshot? {
    lock.lock(); defer { lock.unlock() }
    return value
  }

  func set(_ snapshot: HelperSnapshot?) {
    lock.lock(); defer { lock.unlock() }
    value = snapshot
  }
}

/// App side of TS-H2 #39: register the helper at launch, keep probing it, and send the user to
/// Login Items when macOS wants approval.
///
/// Only a real `.app` bundle registers. A loose `swift run` binary has no daemon plist to find and
/// would only report `notFound`, which is what the cache already says by default.
public enum HelperBootstrap {
  public static func start(probeInterval: TimeInterval = 60) {
    guard Bundle.main.bundleURL.pathExtension == "app" else { return }
    Task.detached {
      var openedSettings = false
      while !Task.isCancelled {
        var service = HelperRegistration.service
        if service.status == .notRegistered {
          // register() throws when approval is pending; the status read below says which.
          try? service.register()
          service = HelperRegistration.service
        }
        let registration = HelperRegistration.name(service.status)
        if service.status == .requiresApproval, !openedSettings {
          openedSettings = true
          SMAppService.openSystemSettingsLoginItems()
        }
        var version: String?
        var xpcOK: Bool?
        if service.status == .enabled {
          let reply = HelperClient().hello()
          xpcOK = reply?.ok == true
          version = reply?.detail["helper_version"]
        }
        HelperStatusCache.shared.set(
          HelperSnapshot(registration: registration, helperVersion: version, xpcOK: xpcOK))
        try? await Task.sleep(nanoseconds: UInt64(probeInterval * 1_000_000_000))
      }
    }
  }
}
