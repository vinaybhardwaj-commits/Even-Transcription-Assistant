import CryptoKit
import Foundation
import Testing

@testable import FleetCore

private func hex(_ text: String) -> Data {
  Data(stride(from: 0, to: text.count, by: 2).map { i in
    let start = text.index(text.startIndex, offsetBy: i)
    return UInt8(text[start..<text.index(start, offsetBy: 2)], radix: 16)!
  })
}

@Suite struct FleetVectorTests {
  let key = try! FleetSigningKey(seed: hex(FleetVectors.seedHex))

  @Test func publicKeyAndItsHashMatchTheServer() {
    #expect(key.publicKeyBase64 == FleetVectors.publicKeyB64)
    #expect(key.publicKeyBase64.count == 44)
    #expect(key.publicKeySHA256B64URL == FleetVectors.pkSHA256B64URL)
  }

  @Test func theBodyHashMatchesTheServer() {
    #expect(FleetToken.bodyHash(Data(FleetVectors.body.utf8)) == FleetVectors.bsha)
    #expect(FleetToken.bodyHash(Data((FleetVectors.body + " ").utf8)) != FleetVectors.bsha)
  }

  @Test func theSignerReproducesTheServersPollTokenByteForByte() throws {
    let token = try FleetToken.device(
      key: key, deviceID: FleetVectors.deviceID, method: "GET", path: "/api/fleet/poll", body: nil,
      iat: FleetVectors.iat, jti: "11111111-2222-3333-4444-555555555555")
    #expect(token == FleetVectors.poll)
  }

  @Test func theSignerReproducesTheServersResultsTokenByteForByte() throws {
    let token = try FleetToken.device(
      key: key, deviceID: FleetVectors.deviceID, method: "POST", path: "/api/fleet/results",
      body: Data(FleetVectors.body.utf8), iat: FleetVectors.iat, jti: "66666666-7777-8888-9999-000000000000")
    #expect(token == FleetVectors.results)
  }

  @Test func theSignerReproducesTheServersRegistrationProofByteForByte() throws {
    let token = try FleetToken.registrationProof(
      key: key, installID: FleetVectors.installID, iat: FleetVectors.iat,
      jti: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    #expect(token == FleetVectors.proof)
  }

  @Test func aDifferentBodyOrClaimGivesADifferentToken() throws {
    let other = try FleetToken.device(
      key: key, deviceID: FleetVectors.deviceID, method: "POST", path: "/api/fleet/results",
      body: Data((FleetVectors.body + " ").utf8), iat: FleetVectors.iat, jti: "66666666-7777-8888-9999-000000000000")
    #expect(other != FleetVectors.results)
  }

  @Test func base64urlIsStrictAndCanonical() {
    #expect(FleetB64.fromURL("AAAA") == Data([0, 0, 0]))
    #expect(FleetB64.fromURL("AAAA=") == nil)  // padding
    #expect(FleetB64.fromURL("AA+A") == nil)  // standard alphabet
    #expect(FleetB64.fromURL("AAB") == nil)  // non-canonical trailing bits
    #expect(FleetB64.fromURL("") == nil)
  }

  @Test func aSeedOfTheWrongLengthIsRefused() {
    #expect(throws: FleetError.self) { try FleetSigningKey(seed: Data(count: 31)) }
  }
}

@Suite struct DeterministicEd25519Tests {
  @Test func theBasePointIsTheRFC8032BasePoint() {
    // x and y of B, RFC 8032 §5.1, as decimal strings.
    let curve = DeterministicEd25519.Curve.self
    let encoded = curve.encode(curve.base)
    // y = 4/5 mod p, little-endian, sign bit of x clear: the well-known 0x58666666... encoding.
    #expect(encoded.map { String(format: "%02x", $0) }.joined()
      == "5866666666666666666666666666666666666666666666666666666666666666")
  }

  @Test func signaturesAreDeterministicAndVerifyUnderCryptoKit() throws {
    let key = try FleetSigningKey(seed: hex(FleetVectors.seedHex))
    for text in ["", "a", "hello", String(repeating: "x", count: 1000)] {
      let message = Data(text.utf8)
      let one = try key.sign(message), two = try key.sign(message)
      #expect(one == two)
      #expect(one.count == 64)
      let pub = try Curve25519.Signing.PublicKey(rawRepresentation: key.publicKeyData)
      #expect(pub.isValidSignature(one, for: message))
      #expect(!pub.isValidSignature(one, for: message + Data([0])))
    }
  }

  @Test func randomKeysSignAndVerify() throws {
    for _ in 0..<3 {
      let key = FleetSigningKey.generate()
      let message = Data(UUID().uuidString.utf8)
      let pub = try Curve25519.Signing.PublicKey(rawRepresentation: key.publicKeyData)
      #expect(pub.isValidSignature(try key.sign(message), for: message))
    }
  }
}
