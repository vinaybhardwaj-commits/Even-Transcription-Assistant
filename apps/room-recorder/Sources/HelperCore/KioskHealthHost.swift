import FleetCore
import Foundation
import KioskHealthCore

/// The kiosk-health engine as the helper sees it: the relay the XPC service hands batches out of, and the sink for the
/// helper's own events (`chrome.policy`).
extension KioskHealthEngine: KioskRelay {
  public func relayBatch() -> (id: String, body: Data, count: Int)? {
    nextBatch().map { ($0.id, $0.body, $0.count) }
  }

  public func relayReport(batchID: String, status: Int, body: Data, reason: String) -> String {
    complete(batchID: batchID, status: status == 0 ? nil : status, body: body, reason: reason)
  }
}

extension FleetJSON {
  /// Plain Foundation values, for the engine's payloads.
  var foundationValue: Any {
    switch self {
    case .null: return NSNull()
    case .bool(let value): return value
    case .int(let value): return value
    case .string(let value): return value
    case .array(let values): return values.map(\.foundationValue)
    case .object(let object): return object.mapValues(\.foundationValue)
    }
  }
}

public enum KioskHealthHost {
  /// Where the engine keeps its spool and its log: root-owned, beside the helper's other state, and different from the
  /// standalone daemon's, so the two can run at the same time (the shadow period).
  public static let stateDirectory = HelperPaths.supportDirectory + "/kiosk-health"
  public static let logPath = "/var/log/room-recorder-helper-kiosk-health.log"

  /// An event the helper raises, on the sink.
  public static func event(_ engine: KioskHealthEngine?) -> @Sendable (HelperEvent) -> Void {
    { event in engine?.emit(kind: event.kind, payload: event.fields.mapValues(\.foundationValue)) }
  }
}

/// How the kiosk-health collectors read anything under a room user's home (0.1.36 R2): `HardenedFile` on a thread that has
/// taken THAT user's identity (`ThreadUserContext`). The kernel then refuses whatever the user could not read themselves,
/// so a symlink or a hard link to a root-only file yields nothing; `HardenedFile` also refuses links, FIFOs and big files.
/// If the thread cannot take the identity, nothing is read: there is no fallback to root.
public struct HelperUserFiles: UserFileAccess {
  let context: UserContext
  public init(context: UserContext = ThreadUserContext()) { self.context = context }

  /// uid and gid of a named, ordinary user. Never root, never a name with odd characters.
  static func identity(_ name: String) -> (uid: UInt32, gid: UInt32)? {
    guard name.range(of: "^[A-Za-z0-9._-]{1,64}$", options: .regularExpression) != nil, let entry = getpwnam(name),
      entry.pointee.pw_uid != 0
    else { return nil }
    return (entry.pointee.pw_uid, entry.pointee.pw_gid)
  }

  private func asUser<T: Sendable>(_ user: String, _ body: @escaping @Sendable () -> T?) -> T? {
    guard let id = Self.identity(user) else { return nil }
    return context.run(uid: id.uid, gid: id.gid, body) ?? nil
  }

  public func info(_ path: String, user: String) -> UserFileInfo? { asUser(user) { HardenedFile.info(path) } }
  public func readWhole(_ path: String, user: String, maxBytes: Int) -> Data? { asUser(user) { HardenedFile.readWhole(path, maxBytes: maxBytes) } }
  public func readRange(_ path: String, user: String, offset: UInt64, maxBytes: Int) -> Data? {
    asUser(user) { HardenedFile.readRange(path, offset: offset, maxBytes: maxBytes) }
  }
  public func entries(_ path: String, user: String) -> [String]? { asUser(user) { HardenedFile.entries(path) } }
}
