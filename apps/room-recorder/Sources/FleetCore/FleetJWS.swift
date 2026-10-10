import CryptoKit
import Foundation

/// Wire formats for the fleet control plane (TS-H3 #40, docs/fleet/PROTOCOL.md §2).
/// Pure: no network, no file, no keychain. Everything here is checked against the server's fixed-seed
/// vectors in `FleetVectorTests`, byte for byte.
public enum FleetB64 {
  /// base64url, NO padding.
  public static func url(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  /// Strict: unpadded, URL alphabet, canonical (re-encoding gives the same text).
  public static func fromURL(_ text: String) -> Data? {
    guard !text.isEmpty, text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
    else { return nil }
    var standard = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while standard.count % 4 != 0 { standard += "=" }
    guard let data = Data(base64Encoded: standard), url(data) == text else { return nil }
    return data
  }

  /// Strict standard base64 (padded, canonical).
  public static func fromStd(_ text: String) -> Data? {
    guard let data = Data(base64Encoded: text), data.base64EncodedString() == text else { return nil }
    return data
  }
}

/// The device's Ed25519 key (RFC 8032). Ed25519 is deterministic, so a correct signer reproduces the
/// server's vectors exactly.
public struct FleetSigningKey: @unchecked Sendable {
  private let key: Curve25519.Signing.PrivateKey

  public init(seed: Data) throws {
    guard seed.count == 32 else { throw FleetError.badKey }
    key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
  }

  public static func generate() -> FleetSigningKey {
    // 32 random bytes cannot fail to be a valid seed.
    try! FleetSigningKey(seed: Data((0..<32).map { _ in UInt8.random(in: 0...255) }))
  }

  /// The secret. For the key store only; never logged, never put in a result.
  public var seed: Data { key.rawRepresentation }
  public var publicKeyData: Data { key.publicKey.rawRepresentation }
  /// Standard base64 of the 32 raw bytes: 44 characters.
  public var publicKeyBase64: String { publicKeyData.base64EncodedString() }
  /// `base64url(SHA-256(32 raw public-key bytes))`, the `pk` claim of the registration proof.
  public var publicKeySHA256B64URL: String { FleetB64.url(Data(SHA256.hash(data: publicKeyData))) }

  /// Deterministic (RFC 8032). CryptoKit's own `signature(for:)` is randomised; see
  /// `DeterministicEd25519` for why that cannot be used here.
  func sign(_ input: Data) throws -> Data {
    DeterministicEd25519.sign(message: input, seed: seed, publicKey: publicKeyData)
  }
}

public enum FleetError: Error, Equatable, Sendable {
  case badKey
  case badJSON
}

/// Compact JWS (EdDSA). Header and payload are written by hand, in the order the vectors fix, so the
/// bytes do not depend on a dictionary's iteration order.
public enum FleetToken {
  static func quote(_ text: String) -> String { FleetJSON.quote(text) }

  static func compact(header: String, payload: String, key: FleetSigningKey) throws -> String {
    let input = "\(FleetB64.url(Data(header.utf8))).\(FleetB64.url(Data(payload.utf8)))"
    return "\(input).\(FleetB64.url(try key.sign(Data(input.utf8))))"
  }

  /// `bsha` for a POST: `base64url(SHA-256(the exact body bytes))`.
  public static func bodyHash(_ body: Data) -> String { FleetB64.url(Data(SHA256.hash(data: body))) }

  /// A device request token. A NEW one for every request, retries included.
  public static func device(
    key: FleetSigningKey, deviceID: String, method: String, path: String, body: Data?,
    iat: Int, ttl: Int = 300, jti: String
  ) throws -> String {
    var payload =
      "{\"iss\":\(quote(deviceID)),\"aud\":\"evenscribe-fleet\",\"iat\":\(iat),\"exp\":\(iat + ttl),"
      + "\"jti\":\(quote(jti)),\"htm\":\(quote(method)),\"htu\":\(quote(path))"
    if method == "POST", let body { payload += ",\"bsha\":\(quote(bodyHash(body)))" }
    payload += "}"
    return try compact(
      header: "{\"alg\":\"EdDSA\",\"typ\":\"JWT\",\"kid\":\(quote(deviceID))}", payload: payload, key: key)
  }

  /// The registration proof, signed by the NEW key. Single use.
  public static func registrationProof(
    key: FleetSigningKey, installID: String, iat: Int, ttl: Int = 300, jti: String
  ) throws -> String {
    let payload =
      "{\"iss\":\(quote(installID)),\"aud\":\"evenscribe-fleet-register\",\"iat\":\(iat),\"exp\":\(iat + ttl),"
      + "\"jti\":\(quote(jti)),\"htm\":\"POST\",\"htu\":\"/api/fleet/register\","
      + "\"pk\":\(quote(key.publicKeySHA256B64URL))}"
    return try compact(
      header: "{\"alg\":\"EdDSA\",\"typ\":\"JWT\",\"kid\":\(quote("install:" + installID))}",
      payload: payload, key: key)
  }
}
