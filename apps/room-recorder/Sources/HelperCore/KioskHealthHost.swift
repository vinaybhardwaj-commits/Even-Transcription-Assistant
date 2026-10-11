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
