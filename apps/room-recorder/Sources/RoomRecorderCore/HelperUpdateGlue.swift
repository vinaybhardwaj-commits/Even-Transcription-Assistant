import FleetCore
import Foundation
import HelperCore

/// 0.1.37. The app's half of #45 (whole-bundle update from the root helper) and #49 (steward tickets). The helper holds no
/// server credential and trusts nothing the app says except what the server signed, so this file only CARRIES things:
/// the release record to the helper, a proof of life to the helper, the steward tickets to the helper.

// MARK: - #45: the release record

public enum HelperUpdateOffer {
  /// `JSONValue` (what the release route decoded) as the `FleetJSON` the signature was made over. Whole numbers become
  /// integers; anything that is not representable (a fraction) makes the record unusable, and nil is returned.
  static func fleetJSON(_ value: JSONValue) -> FleetJSON? {
    switch value {
    case .null: return .null
    case .bool(let b): return .bool(b)
    case .string(let s): return .string(s)
    case .number(let d):
      guard d.isFinite, d == d.rounded(), abs(d) < 9_007_199_254_740_992 else { return nil }
      return .int(Int64(d))
    case .array(let items):
      var out: [FleetJSON] = []
      for item in items { guard let j = fleetJSON(item) else { return nil }; out.append(j) }
      return .array(out)
    case .object(let object):
      var out: [String: FleetJSON] = [:]
      for (key, item) in object { guard let j = fleetJSON(item) else { return nil }; out[key] = j }
      return .object(out)
    }
  }

  /// Hands the release to the helper. `accepted`, `in_progress`, `refused:<reason>`, or `unavailable`: no device id yet, an
  /// unusable record, no helper, an older helper that does not know the verb, a helper in safe mode. Only `unavailable`
  /// lets the user-level updater take over; anything else is the helper's verdict.
  public static func offer(
    _ release: RoomReleaseDescriptor, root: URL, machine: String? = MachineFactsReader.hostname(),
    client: @Sendable () -> HelperClient = { HelperClient() }
  ) -> String {
    guard let record = release.record, let signature = release.recordSignature, let machine,
      let json = fleetJSON(record), let deviceID = FileFleetStateStore(root: root).load().deviceID
    else { return "unavailable" }
    guard let reply = client().updateOffer(record: json.canonical, signature: signature, deviceID: deviceID, machine: machine),
      reply.ok, let answer = reply.detail["answer"]
    else { return "unavailable" }
    return answer
  }
}

/// A proof of life for the helper's health check, at most once every 20 seconds.
public final class HelperBeat: @unchecked Sendable {
  private let lock = NSLock()
  private var last: Date?
  private let version: String?
  private let interval: TimeInterval
  private let send: @Sendable (String) -> Void
  private let now: @Sendable () -> Date

  public init(
    version: String? = BuildInfo.appVersion, interval: TimeInterval = 20, now: @escaping @Sendable () -> Date = { Date() },
    send: @escaping @Sendable (String) -> Void = { _ = HelperClient().appBeat(version: $0) }
  ) {
    self.version = version
    self.interval = interval
    self.now = now
    self.send = send
  }

  /// Call after every bench poll that was answered.
  public func ping() {
    guard let version, !version.isEmpty else { return }
    lock.lock()
    let due = last.map { now().timeIntervalSince($0) >= interval } ?? true
    if due { last = now() }
    lock.unlock()
    guard due else { return }
    DispatchQueue.global().async { [send] in send(version) }
  }
}

// MARK: - #49: steward tickets

protocol StewardTicketSource: Sendable {
  func fetch(machine: String) async -> Data?
}

protocol StewardHelperLink: Sendable {
  func machine() -> String?
  func hand(json: String, deviceID: String, machine: String) -> Bool
}

extension FleetClient: StewardTicketSource {
  func fetch(machine: String) async -> Data? {
    guard let response = await fetchStewardTickets(machine: machine), response.status == 200 else { return nil }
    return response.body
  }
}

struct HelperStewardLink: StewardHelperLink {
  var helper: @Sendable () -> HelperClient = { HelperClient() }
  func machine() -> String? {
    guard let reply = helper().helperStatus(), reply.ok, let name = reply.detail["kiosk_machine"], !name.isEmpty else { return nil }
    return name
  }
  func hand(json: String, deviceID: String, machine: String) -> Bool {
    helper().stewardTickets(json: json, deviceID: deviceID, machine: machine)?.ok == true
  }
}

/// Every 30 s: ask the server for this Mac's tickets and give them to the helper, a few at a time. The helper verifies them
/// (pinned key, machine, window, replay, gates), runs the allowed ones and reports each as a `steward.result` event.
struct StewardTicketRelay: Sendable {
  let source: StewardTicketSource
  let link: StewardHelperLink
  let deviceID: @Sendable () -> String?
  var sleep: @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }
  var log: @Sendable (String) -> Void = { _ in }
  static let interval: TimeInterval = 30
  static let perCall = 5
  static let maxBytes = 5_500

  enum Pass: Equatable {
    case idle
    case handed(tickets: Int)
    case unavailable
  }

  func run() async {
    while !Task.isCancelled {
      _ = await passOnce()
      await sleep(Self.interval)
    }
  }

  /// The ticket list split into XPC-sized pieces (`{"tickets":[...]}`), at most five or ~5.5 KB each.
  static func chunks(_ body: Data) -> [String] {
    guard let root = try? FleetJSON.parse(body), let list = root.objectValue?["tickets"]?.arrayValue else { return [] }
    var out: [String] = []
    var current: [FleetJSON] = []
    // The server names the key that signed the list; the helper checks it against the pinned id, so it travels with every piece.
    let keyID = root.objectValue?["key_id"]
    func piece(_ tickets: [FleetJSON]) -> String {
      var object: [String: FleetJSON] = ["tickets": .array(tickets)]
      if let keyID { object["key_id"] = keyID }
      return FleetJSON.object(object).canonical
    }
    func flush() {
      guard !current.isEmpty else { return }
      out.append(piece(current))
      current = []
    }
    for item in list.prefix(10) {
      let next = current + [item]
      if next.count > perCall || piece(next).utf8.count > maxBytes { flush() }
      current.append(item)
    }
    flush()
    return out
  }

  @discardableResult
  func passOnce() async -> Pass {
    guard let machine = link.machine(), let device = deviceID() else { return .unavailable }
    guard let body = await source.fetch(machine: machine) else { return .idle }
    let pieces = Self.chunks(body)
    guard !pieces.isEmpty else { return .idle }
    var handed = 0
    for piece in pieces where link.hand(json: piece, deviceID: device, machine: machine) {
      handed += (try? FleetJSON.parse(Data(piece.utf8)))?.objectValue?["tickets"]?.arrayValue?.count ?? 0
    }
    if handed > 0 { log("steward: handed \(handed) ticket(s) to the helper") }
    return .handed(tickets: handed)
  }
}
