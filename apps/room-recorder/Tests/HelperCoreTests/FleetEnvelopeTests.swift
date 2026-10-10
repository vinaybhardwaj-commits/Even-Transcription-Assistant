import CryptoKit
import Foundation
import Testing

@testable import FleetCore

/// A stand-in for the server's signer. The envelope vector test below uses a REAL server-side
/// signature (Node, the server's canonicalisation); everything else signs with this.
struct TestServer {
  let key = Curve25519.Signing.PrivateKey()
  var publicKey: Data { key.publicKey.rawRepresentation }
  static let deviceID = "dev_00000000000000000000000a"
  static let machine = "ehrc-consul4"
  static let now = Date(timeIntervalSince1970: 1_760_000_100)

  static func iso(_ date: Date) -> String { FleetClient.iso(date) }
  static func freshNonce() -> String { Data((0..<16).map { _ in UInt8.random(in: 0...255) }).base64EncodedString() }

  func envelope(
    cmdID: String = "cmd_1", deviceID: String = TestServer.deviceID, machine: String = TestServer.machine,
    verb: String = "helper_status", params: [String: FleetJSON] = [:],
    issued: Date = TestServer.now.addingTimeInterval(-10), ttl: TimeInterval = 300,
    nonce: String = TestServer.freshNonce(), approval: String? = nil, keyID: String = "fk1",
    mutate: ((inout [String: FleetJSON]) -> Void)? = nil, signWith other: Curve25519.Signing.PrivateKey? = nil
  ) -> FleetJSON {
    var o: [String: FleetJSON] = [
      "v": .int(2), "cmd_id": .string(cmdID), "device_id": .string(deviceID), "machine": .string(machine),
      "verb": .string(verb), "params": .object(params), "issued_at": .string(Self.iso(issued)),
      "expires_at": .string(Self.iso(issued.addingTimeInterval(ttl))), "nonce": .string(nonce),
      "issuer": .object(["kind": .string("operator"), "id": .string("vinay")]),
      "approval_ref": approval.map(FleetJSON.string) ?? .null, "key_id": .string(keyID),
    ]
    let signature = try! (other ?? key).signature(for: FleetJSON.object(o).canonicalData)
    o["signature"] = .string(signature.base64EncodedString())
    mutate?(&o)
    return .object(o)
  }

  func verifier() -> FleetVerifier {
    FleetVerifier(serverKeys: ["fk1": publicKey], deviceID: Self.deviceID, machine: Self.machine)
  }

  func verify(
    _ json: FleetJSON, seen: Set<String> = [], sessionOpen: Bool = false, ran: Int = 0, kill: Bool = false
  ) -> Result<FleetVerifier.Accepted, FleetRefusal> {
    verifier().verify(
      json, now: Self.now, nonceSeen: { seen.contains($0) }, gates: FleetGateState(sessionOpen: sessionOpen),
      privilegedRunsInLastHour: ran, killSwitch: kill)
  }
}

private func refusal(_ result: Result<FleetVerifier.Accepted, FleetRefusal>) -> FleetRefusal? {
  if case .failure(let r) = result { return r }
  return nil
}

@Suite struct FleetCanonicalJSONTests {
  @Test func keysAreSortedBytewiseAtEveryDepthWithNoWhitespace() throws {
    let json = try FleetJSON.parse(Data(#"{"b":{"z":1,"a":[{"y":true,"x":null}]},"a":"s"}"#.utf8))
    #expect(json.canonical == #"{"a":"s","b":{"a":[{"x":null,"y":true}],"z":1}}"#)
  }

  @Test func floatsAreRefused() {
    for text in ["1.5", "1e3", "1E3", "0.0", "-0.5", "01", "9007199254740992", "[1.0]"] {
      #expect(throws: FleetError.self, "\(text)") { try FleetJSON.parse(Data(text.utf8)) }
    }
  }

  @Test func duplicateKeysTrailingBytesAndBadEscapesAreRefused() {
    for text in [#"{"a":1,"a":2}"#, "{} x", #""\ud800""#, #""\udc00x""#, #""\x""#, "[1,]", "{\"a\":}", "\"tab\there\""] {
      #expect(throws: FleetError.self, "\(text)") { try FleetJSON.parse(Data(text.utf8)) }
    }
  }

  @Test func integerLikeAndMalformedKeysFailTheCanonicalKeyRule() throws {
    for key in ["1", "A", "a-b", "a b", "", "é"] {
      let json = FleetJSON.object([key: .int(1)])
      #expect(!json.keysCanonical, "\(key)")
    }
    #expect(FleetJSON.object(["a_1": .object(["_x": .int(1)])]).keysCanonical)
  }

  @Test func stringsEscapeLikeJSONStringify() {
    #expect(FleetJSON.string("a\"b\\c\n\u{01}/é\u{7f}\u{2028}").canonical == "\"a\\\"b\\\\c\\n\\u0001/é\u{7f}\u{2028}\"")
  }
}

@Suite struct FleetEnvelopeVectorTests {
  // Produced by Node with the server's canonicalisation (JSON.stringify(sortKeys(env)), lib/steward/tickets.ts)
  // and an Ed25519 key from the seed 0x09 x 32: a throwaway, not a credential. The approval_ref carries
  // a quote, a backslash, a tab, DEL, U+2028 and a non-BMP character, so string escaping is proved too.
  static let publicKey = "/RckOFqgx1tk+3jNYC+h2ZH96/drE8WO1wLqyDXp9hg="  // gitleaks:allow
  static let signature =
    "Jb5XE2E4syWzNzoNQhEsBqMxnr887I+Mt8acY8AM6YE14rSNfTJptdEhDYIZPX8o05EvgPlARofSi7Uju4AkAQ=="  // gitleaks:allow
  static let served =
    #"{"v":2,"cmd_id":"cmd_vec1","device_id":"dev_000000000000000000000001","machine":"ehrc-consul4","verb":"collect_diag","params":{"scope":"audio","log_lines":100},"issued_at":"2026-10-10T07:00:00.000Z","expires_at":"2026-10-10T07:05:00.000Z","nonce":"BQUFBQUFBQUFBQUFBQUFBQ==","issuer":{"kind":"operator","id":"vinay"},"approval_ref":"go_é\"\\\t/\u007f 😀","key_id":"fk1"}"#
  static let canonical =
    "{\"approval_ref\":\"go_é\\\"\\\\\\t/\u{7f}\u{2028}\u{1F600}\",\"cmd_id\":\"cmd_vec1\",\"device_id\":\"dev_000000000000000000000001\",\"expires_at\":\"2026-10-10T07:05:00.000Z\",\"issued_at\":\"2026-10-10T07:00:00.000Z\",\"issuer\":{\"id\":\"vinay\",\"kind\":\"operator\"},\"key_id\":\"fk1\",\"machine\":\"ehrc-consul4\",\"nonce\":\"BQUFBQUFBQUFBQUFBQUFBQ==\",\"params\":{\"log_lines\":100,\"scope\":\"audio\"},\"v\":2,\"verb\":\"collect_diag\"}"

  private func served(signature: String = signature) throws -> FleetJSON {
    var o = try #require(try FleetJSON.parse(Data(Self.served.utf8)).objectValue)
    o["signature"] = .string(signature)
    return .object(o)
  }

  @Test func theCanonicalBytesAreTheServersBytes() throws {
    let envelope = try #require(FleetEnvelope.parse(try served()))
    #expect(String(decoding: envelope.signedBytes, as: UTF8.self) == Self.canonical)
  }

  @Test func theServersSignatureVerifiesAndTheCommandIsAccepted() throws {
    let verifier = FleetVerifier(
      serverKeys: ["fk1": Data(base64Encoded: Self.publicKey)!], deviceID: "dev_000000000000000000000001",
      machine: "ehrc-consul4")
    let now = Date(timeIntervalSince1970: 1_791_000_000 + 0)  // inside [issued, expires]; set below
    _ = now
    let inside = FleetEnvelope.date("2026-10-10T07:01:00.000Z")!
    let result = verifier.verify(
      try served(), now: inside, nonceSeen: { _ in false }, gates: FleetGateState(sessionOpen: false),
      privilegedRunsInLastHour: 0, killSwitch: false)
    let accepted = try result.get()
    #expect(accepted.verb == .collectDiag)
    #expect(accepted.envelope.approvalRef == "go_é\"\\\t/\u{7f}\u{2028}\u{1F600}")
  }

  @Test func oneChangedByteInTheSignatureOrTheEnvelopeIsBadSignature() throws {
    let verifier = FleetVerifier(
      serverKeys: ["fk1": Data(base64Encoded: Self.publicKey)!], deviceID: "dev_000000000000000000000001",
      machine: "ehrc-consul4")
    let inside = FleetEnvelope.date("2026-10-10T07:01:00.000Z")!
    func run(_ json: FleetJSON) -> FleetRefusal? {
      if case .failure(let r) = verifier.verify(
        json, now: inside, nonceSeen: { _ in false }, gates: FleetGateState(sessionOpen: false),
        privilegedRunsInLastHour: 0, killSwitch: false)
      { return r }
      return nil
    }
    var chars = Array(Self.signature)
    chars[10] = chars[10] == "A" ? "B" : "A"
    let flipped = String(chars)
    #expect(run(try served(signature: flipped)) == .badSignature)
    var changed = try #require(try served().objectValue)
    changed["cmd_id"] = .string("cmd_vec2")
    #expect(run(.object(changed)) == .badSignature)
  }
}

@Suite struct FleetVerifierOrderTests {
  let server = TestServer()

  @Test func aGoodCommandIsAccepted() throws {
    let accepted = try server.verify(server.envelope(verb: "collect_diag", params: ["scope": .string("audio")])).get()
    #expect(accepted.verb == .collectDiag)
  }

  @Test func malformedShapes() {
    func mal(_ mutate: @escaping (inout [String: FleetJSON]) -> Void) -> FleetRefusal? {
      refusal(server.verify(server.envelope(mutate: mutate)))
    }
    #expect(mal { $0["extra"] = .int(1) } == .malformed)
    #expect(mal { $0["v"] = .int(1) } == .malformed)
    #expect(mal { $0["signature"] = nil } == .malformed)
    #expect(mal { $0["issued_at"] = .string("2026-10-10T07:00:00Z") } == .malformed)  // no milliseconds
    #expect(mal { $0["nonce"] = .string("short") } == .malformed)
    #expect(mal { $0["approval_ref"] = .int(1) } == .malformed)
    #expect(mal { $0["params"] = .array([]) } == .malformed)
    #expect(mal { $0["issuer"] = .object(["kind": .string("root"), "id": .string("x")]) } == .malformed)
    #expect(mal { $0["params"] = .object(["Bad-Key": .int(1)]) } == .malformed)
    #expect(refusal(server.verify(.string("x"))) == .malformed)
  }

  @Test func aVerbOutsideTheCharacterSetIsMalformedNotAllowListed() {
    #expect(refusal(server.verify(server.envelope(verb: "Helper_Status"))) == .malformed)
    #expect(refusal(server.verify(server.envelope(verb: "../etc/passwd"))) == .malformed)
  }

  @Test func badSignature() {
    let other = Curve25519.Signing.PrivateKey()
    #expect(refusal(server.verify(server.envelope(signWith: other))) == .badSignature)
    #expect(refusal(server.verify(server.envelope(keyID: "fk2"))) == .badSignature)  // unknown key id
    #expect(refusal(server.verify(server.envelope(mutate: { $0["machine"] = .string("other") }))) == .badSignature)
    let empty = FleetVerifier(serverKeys: [:], deviceID: TestServer.deviceID, machine: TestServer.machine)
    #expect(
      refusal(
        empty.verify(
          server.envelope(), now: TestServer.now, nonceSeen: { _ in false }, gates: FleetGateState(sessionOpen: false),
          privilegedRunsInLastHour: 0, killSwitch: false)) == .badSignature, "no compiled keys: everything is refused")
  }

  @Test func expiredAndTheWindow() {
    #expect(refusal(server.verify(server.envelope(issued: TestServer.now.addingTimeInterval(-400), ttl: 300))) == .expired)
    #expect(refusal(server.verify(server.envelope(issued: TestServer.now.addingTimeInterval(-10), ttl: 901))) == .expired)  // ttl > 900
    #expect(refusal(server.verify(server.envelope(issued: TestServer.now.addingTimeInterval(130)))) == .expired)  // from the future
    #expect(refusal(server.verify(server.envelope(issued: TestServer.now.addingTimeInterval(110)))) == nil)  // inside the skew
    #expect(refusal(server.verify(server.envelope(issued: TestServer.now.addingTimeInterval(-10), ttl: 900))) == nil)
  }

  @Test func replay() {
    let nonce = TestServer.freshNonce()
    #expect(refusal(server.verify(server.envelope(nonce: nonce), seen: [nonce])) == .replay)
  }

  @Test func wrongMachineOrDevice() {
    #expect(refusal(server.verify(server.envelope(machine: "another-mac"))) == .machineMismatch)
    #expect(refusal(server.verify(server.envelope(deviceID: "dev_00000000000000000000000b"))) == .machineMismatch)
  }

  @Test func verbsOutsideTheCatalogueAreRefused() {
    for verb in ["coreaudiod_reset", "update_bundle", "breakglass_enable", "bash", "exec", "rotate_identity", "x"] {
      #expect(refusal(server.verify(server.envelope(verb: verb))) == .verbNotAllowed, "\(verb)")
    }
  }

  @Test func closedParams() {
    func bad(_ verb: String, _ params: [String: FleetJSON]) -> Bool {
      refusal(server.verify(server.envelope(verb: verb, params: params))) == .badParams
    }
    #expect(bad("helper_status", ["x": .int(1)]))
    #expect(bad("collect_diag", [:]))  // scope is required
    #expect(bad("collect_diag", ["scope": .string("keychain")]))
    #expect(bad("collect_diag", ["scope": .string("audio"), "log_lines": .int(501)]))
    #expect(bad("collect_diag", ["scope": .string("audio"), "path": .string("/etc/passwd")]))
    #expect(bad("report_diag", ["log_lines": .int(-1)]))
    #expect(bad("report_diag", ["log_lines": .string("5")]))
    #expect(bad("select_audio_input", [:]))
    #expect(bad("select_audio_input", ["input_volume_pct": .int(101)]))
    #expect(bad("select_audio_input", ["device_uid": .string("")]))
    #expect(bad("self_test", ["volume_pct": .int(10)]))
    #expect(bad("restart_recorder", ["force": .string("yes")]))
    #expect(bad("restart_recorder", ["cmd": .string("rm -rf /")]))
  }

  @Test func theLocalGate() {
    let restart = server.envelope(verb: "restart_recorder")
    #expect(refusal(server.verify(restart, sessionOpen: true)) == .sessionOpen)
    #expect(refusal(server.verify(server.envelope(verb: "restart_recorder", params: ["force": .bool(true)]), sessionOpen: true)) == .sessionOpen)  // force without approval_ref
    #expect(refusal(server.verify(server.envelope(verb: "restart_recorder", params: ["force": .bool(true)], approval: "go_1"), sessionOpen: true)) == nil)
    #expect(refusal(server.verify(restart, sessionOpen: false)) == nil)
  }

  @Test func theDeviceRateCeilingCountsPrivilegedVerbsOnly() {
    let restart = server.envelope(verb: "restart_recorder")
    #expect(refusal(server.verify(restart, ran: 9)) == nil)
    #expect(refusal(server.verify(restart, ran: 10)) == .rateLimited)
    #expect(refusal(server.verify(server.envelope(verb: "helper_status"), ran: 99)) == nil)
  }

  @Test func theKillSwitchRefusesEverything() {
    #expect(refusal(server.verify(server.envelope(), kill: true)) == .killSwitch)
  }

  @Test func theFirstFailureWins() {
    // expired AND replayed AND wrong verb AND kill switch: expired comes first.
    let nonce = TestServer.freshNonce()
    let both = server.envelope(verb: "bash", issued: TestServer.now.addingTimeInterval(-900), nonce: nonce)
    #expect(refusal(server.verify(both, seen: [nonce], kill: true)) == .expired)
    // replayed AND wrong verb AND kill switch: replay first.
    let two = server.envelope(verb: "bash", nonce: nonce)
    #expect(refusal(server.verify(two, seen: [nonce], kill: true)) == .replay)
    // wrong verb AND kill switch: verb first.
    #expect(refusal(server.verify(server.envelope(verb: "bash"), kill: true)) == .verbNotAllowed)
    // bad params AND rate AND kill: params first.
    let p = server.envelope(verb: "restart_recorder", params: ["force": .int(1)])
    #expect(refusal(server.verify(p, ran: 99, kill: true)) == .badParams)
  }

  @Test func theCatalogueIsClosedAndPinned() {
    #expect(
      Set(FleetVerb.allCases.map(\.rawValue))
        == ["helper_status", "collect_diag", "report_diag", "select_audio_input", "self_test", "restart_recorder"])
  }
}
