import CryptoKit
import Foundation

/// Envelope v2 (PRD §5.3, PROTOCOL.md §4): the server's signed command, as served.
public struct FleetEnvelope: Equatable, Sendable {
  public var cmdID: String
  public var deviceID: String
  public var machine: String
  public var verb: String
  public var params: [String: FleetJSON]
  public var issuedAt: String
  public var expiresAt: String
  public var nonce: String
  public var issuerKind: String
  public var issuerID: String
  public var approvalRef: String?
  public var keyID: String
  public var signature: String
  /// The envelope minus `signature`, canonicalised: the bytes the server signed.
  public var signedBytes: Data

  static let fields: Set<String> = [
    "v", "cmd_id", "device_id", "machine", "verb", "params", "issued_at", "expires_at", "nonce",
    "issuer", "approval_ref", "key_id", "signature",
  ]

  /// Shape check (`malformed`): exactly the thirteen fields, each the right type, canonical keys
  /// everywhere, timestamps ISO-8601 with exactly milliseconds, nonce and signature canonical base64.
  public static func parse(_ json: FleetJSON) -> FleetEnvelope? {
    guard case .object(let o) = json, Set(o.keys) == fields, json.keysCanonical,
      o["v"] == .int(2),
      let cmdID = o["cmd_id"]?.stringValue, matches(cmdID, "^[A-Za-z0-9_-]{1,64}$"),
      let deviceID = o["device_id"]?.stringValue, matches(deviceID, "^dev_[0-9a-f]{24}$"),
      let machine = o["machine"]?.stringValue, (1...128).contains(machine.utf8.count),
      let verb = o["verb"]?.stringValue, matches(verb, "^[a-z_][a-z0-9_]{0,63}$"),
      let params = o["params"]?.objectValue,
      let issuedAt = o["issued_at"]?.stringValue, matches(issuedAt, isoMs),
      let expiresAt = o["expires_at"]?.stringValue, matches(expiresAt, isoMs),
      let nonce = o["nonce"]?.stringValue, matches(nonce, "^[A-Za-z0-9+/]{22}==$"),
      let issuer = o["issuer"]?.objectValue, Set(issuer.keys) == ["kind", "id"],
      let kind = issuer["kind"]?.stringValue, ["operator", "steward", "bot"].contains(kind),
      let issuerID = issuer["id"]?.stringValue, (1...64).contains(issuerID.utf8.count),
      let keyID = o["key_id"]?.stringValue, matches(keyID, "^[a-z0-9_]{1,16}$"),
      let signature = o["signature"]?.stringValue, matches(signature, "^[A-Za-z0-9+/]{86}==$")
    else { return nil }
    var approval: String?
    switch o["approval_ref"] {
    case .some(.null): approval = nil
    case .some(.string(let s)) where (1...64).contains(s.utf8.count): approval = s
    default: return nil
    }
    var unsigned = o
    unsigned["signature"] = nil
    return FleetEnvelope(
      cmdID: cmdID, deviceID: deviceID, machine: machine, verb: verb, params: params, issuedAt: issuedAt,
      expiresAt: expiresAt, nonce: nonce, issuerKind: kind, issuerID: issuerID, approvalRef: approval,
      keyID: keyID, signature: signature, signedBytes: FleetJSON.object(unsigned).canonicalData)
  }

  static let isoMs = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"

  static func matches(_ text: String, _ pattern: String) -> Bool {
    text.range(of: pattern, options: .regularExpression) != nil
  }

  static func date(_ iso: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: iso)
  }
}

/// Why a command was not run. Raw values are the `reason` the server stores.
public enum FleetRefusal: String, Error, Equatable, Sendable {
  case malformed
  case badSignature = "bad_signature"
  case expired
  case replay
  case machineMismatch = "machine_mismatch"
  case verbNotAllowed = "verb_not_allowed"
  case badParams = "bad_params"
  case sessionOpen = "session_open"
  case clinicHoursNeedsApproval = "clinic_hours_needs_approval"
  case rateLimited = "rate_limited"
  case killSwitch = "kill_switch"
}

/// What the app knows at the moment a command arrives; read by the gates.
public struct FleetGateState: Equatable, Sendable {
  public var sessionOpen: Bool
  public init(sessionOpen: Bool) { self.sessionOpen = sessionOpen }
}

/// The compiled-in server signing keys (PRD §5.3: "current + next"; the signer is never served).
///
/// ─── EMPTY UNTIL THE SERVER BUILDER SUPPLIES THEM ────────────────────────────────────────
/// PROTOCOL.md §4: "the signer and server keys arrive with #41". The public keys for `fk1` and `fk2`
/// were not available to this build, and a key invented here would be a key nobody holds. With the
/// table empty every command is refused `bad_signature`: fail-safe, and the client is off by default.
public enum FleetServerKeys {
  /// key id → standard base64 of the 32-byte Ed25519 public key.
  public static let compiled: [String: String] = [:]

  public static func resolve(_ table: [String: String] = compiled) -> [String: Data] {
    table.compactMapValues { text in
      guard text.count == 44, let data = FleetB64.fromStd(text), data.count == 32 else { return nil }
      return data
    }
  }
}

/// The ten checks of PRD §5.3, in order; the first failure wins.
public struct FleetVerifier: Sendable {
  public static let maxTTL: TimeInterval = 900
  public static let skew: TimeInterval = 120
  public static let rateCeilingPerHour = 10

  public var serverKeys: [String: Data]
  public var deviceID: String
  public var machine: String

  public init(serverKeys: [String: Data], deviceID: String, machine: String) {
    self.serverKeys = serverKeys
    self.deviceID = deviceID
    self.machine = machine
  }

  public struct Accepted: Equatable, Sendable {
    public var envelope: FleetEnvelope
    public var verb: FleetVerb
    public var params: FleetParams
  }

  /// - Parameters:
  ///   - nonceSeen: has this nonce been accepted before (last 1,000)?
  ///   - privilegedRunsInLastHour: how many privileged verbs ran in the last 3600 s.
  ///   - killSwitch: the poll's `kill_switch.global`.
  public func verify(
    _ json: FleetJSON, now: Date, nonceSeen: (String) -> Bool, gates: FleetGateState,
    privilegedRunsInLastHour: Int, killSwitch: Bool
  ) -> Result<Accepted, FleetRefusal> {
    // 1. shape
    guard let envelope = FleetEnvelope.parse(json) else { return .failure(.malformed) }
    // 2. known key id, valid signature
    guard let keyData = serverKeys[envelope.keyID],
      let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData),
      let signature = FleetB64.fromStd(envelope.signature), signature.count == 64,
      key.isValidSignature(signature, for: envelope.signedBytes)
    else { return .failure(.badSignature) }
    // 3. ttl and window
    guard let issued = FleetEnvelope.date(envelope.issuedAt), let expires = FleetEnvelope.date(envelope.expiresAt),
      expires > issued, expires.timeIntervalSince(issued) <= Self.maxTTL,
      now >= issued.addingTimeInterval(-Self.skew), now <= expires
    else { return .failure(.expired) }
    // 4. nonce
    if nonceSeen(envelope.nonce) { return .failure(.replay) }
    // 5. device and machine
    guard envelope.deviceID == deviceID, envelope.machine == machine else {
      return .failure(.machineMismatch)
    }
    // 6. allow-list
    guard let verb = FleetVerb(rawValue: envelope.verb) else { return .failure(.verbNotAllowed) }
    // 7. closed params
    guard let params = verb.parseParams(envelope.params) else { return .failure(.badParams) }
    // 8. local gates
    if let refusal = verb.gate(params: params, approvalRef: envelope.approvalRef, state: gates) {
      return .failure(refusal)
    }
    // 9. device rate ceiling (privileged verbs only)
    if verb.isPrivileged, privilegedRunsInLastHour >= Self.rateCeilingPerHour {
      return .failure(.rateLimited)
    }
    // 10. kill switch
    if killSwitch { return .failure(.killSwitch) }
    return .success(Accepted(envelope: envelope, verb: verb, params: params))
  }
}
