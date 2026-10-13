import Foundation

/// The CLOSED protocol between the app and the helper (TS-H2 #39): six verbs, and nothing that
/// takes a command line. There is no field in a request that a helper could hand to a shell.
///
/// `runSignedCommand` (0.1.35) carries a server-signed fleet envelope. The helper does not trust the app's
/// word that it is genuine: it verifies the signature itself (`HelperCommandRunner`).
public enum HelperVerb: String, CaseIterable, Sendable {
  case hello
  case appStatus
  case helperStatus
  case runAppVerb
  case requestBundleUpdate
  case runSignedCommand
  /// 0.1.36 (#47): the app asks for the next batch of kiosk-health events, and reports what the sink answered.
  case kioskBatch
  case kioskReport
  /// 0.1.37 (#45): the app hands over a server-signed release record; the app proves it is alive on a version; the app hands
  /// over the steward tickets it fetched (#49).
  case updateOffer
  case appBeat
  case stewardTickets
}

/// The app-side catalogue `runAppVerb` may name: the bench verbs the app already runs, minus the
/// day-control ones. A verb not in this list is refused before anything else looks at it.
public enum AppVerb: String, CaseIterable, Sendable {
  case reportDiag = "report_diag"
  case restartEngine = "restart_engine"
  case checkUpdateNow = "check_update_now"
  case selfTest = "self_test"
  case setAudioInput = "set_audio_input"
}

/// A request that has passed the codec. Holding one of these means the verb is in the allow-list
/// and the parameters are inside the bounds.
public enum HelperCommand: Equatable, Sendable {
  case hello(clientVersion: String?)
  case appStatus
  case helperStatus
  case runAppVerb(AppVerb, params: [String: String])
  case requestBundleUpdate
  case runSignedCommand(envelope: String, deviceID: String, machine: String)
  case kioskBatch
  /// `status` 0 = no HTTP answer (a transport error). `body` is the sink's reply, reduced to what the helper reads.
  case kioskReport(batchID: String, status: Int, reason: String, body: String)
  case updateOffer(record: String, signature: String, deviceID: String, machine: String)
  case appBeat(version: String)
  case stewardTickets(json: String, deviceID: String, machine: String)
}

public enum HelperRefusal: String, Error, Equatable, Sendable {
  case malformed
  case tooLarge = "too_large"
  case protocolVersion = "protocol_version"
  case verbNotAllowed = "verb_not_allowed"
  case badParams = "bad_params"
}

public enum HelperCodec {
  public static let maxRequestBytes = 8 * 1024
  public static let maxParams = 8
  public static let maxParamBytes = 256

  struct Wire: Codable {
    var v: Int
    var verb: String
    var appVerb: String?
    var params: [String: String]?
    var clientVersion: String?
    var envelope: String?
    var deviceID: String?
    var machine: String?
    var batchID: String?
    var status: Int?
    var reason: String?
    var body: String?
    var record: String?
    var signature: String?
    var version: String?
    var tickets: String?
  }

  public static func encode(_ command: HelperCommand) throws -> Data {
    var wire = Wire(v: HelperIdentity.protocolVersion, verb: "")
    switch command {
    case .hello(let clientVersion):
      wire.verb = HelperVerb.hello.rawValue
      wire.clientVersion = clientVersion
    case .appStatus: wire.verb = HelperVerb.appStatus.rawValue
    case .helperStatus: wire.verb = HelperVerb.helperStatus.rawValue
    case .requestBundleUpdate: wire.verb = HelperVerb.requestBundleUpdate.rawValue
    case .runSignedCommand(let envelope, let deviceID, let machine):
      wire.verb = HelperVerb.runSignedCommand.rawValue
      wire.envelope = envelope
      wire.deviceID = deviceID
      wire.machine = machine
    case .kioskBatch: wire.verb = HelperVerb.kioskBatch.rawValue
    case .kioskReport(let batchID, let status, let reason, let body):
      wire.verb = HelperVerb.kioskReport.rawValue
      wire.batchID = batchID
      wire.status = status
      wire.reason = reason
      wire.body = body
    case .updateOffer(let record, let signature, let deviceID, let machine):
      wire.verb = HelperVerb.updateOffer.rawValue
      wire.record = record
      wire.signature = signature
      wire.deviceID = deviceID
      wire.machine = machine
    case .appBeat(let version):
      wire.verb = HelperVerb.appBeat.rawValue
      wire.version = version
    case .stewardTickets(let json, let deviceID, let machine):
      wire.verb = HelperVerb.stewardTickets.rawValue
      wire.tickets = json
      wire.deviceID = deviceID
      wire.machine = machine
    case .runAppVerb(let verb, let params):
      wire.verb = HelperVerb.runAppVerb.rawValue
      wire.appVerb = verb.rawValue
      wire.params = params
    }
    return try JSONEncoder().encode(wire)
  }

  /// Order of refusals is fixed: size, shape, protocol version, helper verb, app verb, params.
  public static func decode(_ data: Data) throws -> HelperCommand {
    guard data.count <= maxRequestBytes else { throw HelperRefusal.tooLarge }
    guard let wire = try? JSONDecoder().decode(Wire.self, from: data) else {
      throw HelperRefusal.malformed
    }
    guard wire.v == HelperIdentity.protocolVersion else { throw HelperRefusal.protocolVersion }
    guard let verb = HelperVerb(rawValue: wire.verb) else { throw HelperRefusal.verbNotAllowed }
    switch verb {
    case .hello: return .hello(clientVersion: wire.clientVersion)
    case .appStatus: return .appStatus
    case .helperStatus: return .helperStatus
    case .requestBundleUpdate: return .requestBundleUpdate
    case .kioskBatch: return .kioskBatch
    case .updateOffer:
      guard let record = wire.record, (1...4_096).contains(record.utf8.count), let signature = wire.signature, signature.utf8.count == 88,
        let deviceID = wire.deviceID, deviceID.range(of: "^dev_[0-9a-f]{24}$", options: .regularExpression) != nil,
        let machine = wire.machine, (1...128).contains(machine.utf8.count), machine.unicodeScalars.allSatisfy({ $0.value >= 0x20 })
      else { throw HelperRefusal.badParams }
      return .updateOffer(record: record, signature: signature, deviceID: deviceID, machine: machine)
    case .appBeat:
      guard let version = wire.version, (1...32).contains(version.utf8.count), RoomVersion(version) != nil else { throw HelperRefusal.badParams }
      return .appBeat(version: version)
    case .stewardTickets:
      guard let json = wire.tickets, (1...6_000).contains(json.utf8.count),
        let deviceID = wire.deviceID, deviceID.range(of: "^dev_[0-9a-f]{24}$", options: .regularExpression) != nil || deviceID.isEmpty,
        let machine = wire.machine, machine.utf8.count <= 128, machine.unicodeScalars.allSatisfy({ $0.value >= 0x20 })
      else { throw HelperRefusal.badParams }
      return .stewardTickets(json: json, deviceID: deviceID, machine: machine)
    case .kioskReport:
      guard let id = wire.batchID, (1...160).contains(id.utf8.count),
        id.range(of: "^[A-Za-z0-9:._#-]+$", options: .regularExpression) != nil,
        let status = wire.status, (0...599).contains(status),
        let reason = wire.reason, reason.utf8.count <= 160, !reason.unicodeScalars.contains(where: { $0.value < 0x20 }),
        let body = wire.body, body.utf8.count <= 4_096
      else { throw HelperRefusal.badParams }
      return .kioskReport(batchID: id, status: status, reason: reason, body: body)
    case .runSignedCommand:
      guard let envelope = wire.envelope, !envelope.isEmpty, envelope.utf8.count <= 6_000,
        let deviceID = wire.deviceID, deviceID.range(of: "^dev_[0-9a-f]{24}$", options: .regularExpression) != nil,
        let machine = wire.machine, (1...128).contains(machine.utf8.count),
        machine.unicodeScalars.allSatisfy({ $0.value >= 0x20 })
      else { throw HelperRefusal.badParams }
      return .runSignedCommand(envelope: envelope, deviceID: deviceID, machine: machine)
    case .runAppVerb:
      guard let name = wire.appVerb, let appVerb = AppVerb(rawValue: name) else {
        throw HelperRefusal.verbNotAllowed
      }
      let params = wire.params ?? [:]
      guard params.count <= maxParams,
        params.allSatisfy({ $0.key.utf8.count <= maxParamBytes && $0.value.utf8.count <= maxParamBytes })
      else { throw HelperRefusal.badParams }
      return .runAppVerb(appVerb, params: params)
    }
  }
}

/// `ok` is true only when the helper did what was asked. `code` is `ok`, a `HelperRefusal` raw
/// value, or `not_implemented` (a valid verb whose root work this slice does not do).
public struct HelperResponse: Codable, Equatable, Sendable {
  public var v: Int = HelperIdentity.protocolVersion
  public var ok: Bool
  public var code: String
  public var detail: [String: String]

  public init(ok: Bool, code: String, detail: [String: String] = [:]) {
    self.ok = ok
    self.code = code
    self.detail = detail
  }

  public func encoded() -> Data {
    (try? JSONEncoder().encode(self)) ?? Data("{\"ok\":false,\"code\":\"encode_failed\",\"v\":1,\"detail\":{}}".utf8)
  }

  public static func decode(_ data: Data) -> HelperResponse? {
    try? JSONDecoder().decode(HelperResponse.self, from: data)
  }
}
