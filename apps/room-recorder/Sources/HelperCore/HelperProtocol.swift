import Foundation

/// The CLOSED protocol between the app and the helper (TS-H2 #39): five verbs, and nothing that
/// takes a command line. There is no field in a request that a helper could hand to a shell.
public enum HelperVerb: String, CaseIterable, Sendable {
  case hello
  case appStatus
  case helperStatus
  case runAppVerb
  case requestBundleUpdate
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
