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
    at: Date = TestServer.now,
    cmdID: String = "cmd_1", deviceID: String = TestServer.deviceID, machine: String = TestServer.machine,
    verb: String = "helper_status", params: [String: FleetJSON] = [:],
    issued: Date? = nil, ttl: TimeInterval = 300,
    nonce: String = TestServer.freshNonce(), approval: String? = nil, keyID: String = "fk1",
    mutate: ((inout [String: FleetJSON]) -> Void)? = nil, signWith other: Curve25519.Signing.PrivateKey? = nil
  ) -> FleetJSON {
    let issued = issued ?? at.addingTimeInterval(-10)
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
    _ json: FleetJSON, seen: Set<String> = [], sessionOpen: Bool = false, ran: Int = 0, sinceReset: Int? = nil,
    consoleUser: Bool = true, kill: Bool = false, now: Date = TestServer.now
  ) -> Result<FleetVerifier.Accepted, FleetRefusal> {
    verifier().verify(
      json, now: now, nonceSeen: { seen.contains($0) },
      gates: FleetGateState(sessionOpen: sessionOpen, consoleUserPresent: consoleUser),
      rates: FleetRateState(privilegedInLastHour: ran, secondsSinceLastReset: sinceReset), killSwitch: kill)
  }

  /// 03:00 IST: well outside clinic hours (07:30 to 21:30), so privileged verbs need no approval.
  static let night = Date(timeIntervalSince1970: 1_760_000_100 - 11 * 3_600)
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
  // 1. A signature made in Node with the server's canonicalisation over an envelope whose string carries a quote,
  //    a backslash, a tab, DEL, U+2028 and a non-BMP character. Its approval_ref is NOT a legal approval_ref any
  //    more (PROTOCOL §8.4: ^[A-Za-z0-9_-]{3,64}$), so it proves the CANONICAL WRITER and the signature, not the
  //    envelope shape. Throwaway key (seed 0x09 x 32).
  static let publicKey = "/RckOFqgx1tk+3jNYC+h2ZH96/drE8WO1wLqyDXp9hg="  // gitleaks:allow
  static let signature =
    "Jb5XE2E4syWzNzoNQhEsBqMxnr887I+Mt8acY8AM6YE14rSNfTJptdEhDYIZPX8o05EvgPlARofSi7Uju4AkAQ=="  // gitleaks:allow
  static let served =
    #"{"v":2,"cmd_id":"cmd_vec1","device_id":"dev_000000000000000000000001","machine":"ehrc-consul4","verb":"collect_diag","params":{"scope":"audio","log_lines":100},"issued_at":"2026-10-10T07:00:00.000Z","expires_at":"2026-10-10T07:05:00.000Z","nonce":"BQUFBQUFBQUFBQUFBQUFBQ==","issuer":{"kind":"operator","id":"vinay"},"approval_ref":"go_\u00e9\"\\\t/\u007f\u2028\ud83d\ude00","key_id":"fk1"}"#
  static let canonical =
    "{\"approval_ref\":\"go_\u{e9}\\\"\\\\\\t/\u{7f}\u{2028}\u{1f600}\",\"cmd_id\":\"cmd_vec1\",\"device_id\":\"dev_000000000000000000000001\",\"expires_at\":\"2026-10-10T07:05:00.000Z\",\"issued_at\":\"2026-10-10T07:00:00.000Z\",\"issuer\":{\"id\":\"vinay\",\"kind\":\"operator\"},\"key_id\":\"fk1\",\"machine\":\"ehrc-consul4\",\"nonce\":\"BQUFBQUFBQUFBQUFBQUFBQ==\",\"params\":{\"log_lines\":100,\"scope\":\"audio\"},\"v\":2,\"verb\":\"collect_diag\"}"

  @Test func theCanonicalWriterIsByteIdenticalToTheServersAndItsSignatureVerifies() throws {
    var object = try #require(try FleetJSON.parse(Data(Self.served.utf8)).objectValue)
    object["signature"] = nil
    let bytes = FleetJSON.object(object).canonicalData
    #expect(String(decoding: bytes, as: UTF8.self) == Self.canonical)
    let key = try Curve25519.Signing.PublicKey(rawRepresentation: Data(base64Encoded: Self.publicKey)!)
    #expect(key.isValidSignature(Data(base64Encoded: Self.signature)!, for: bytes))
    #expect(!key.isValidSignature(Data(base64Encoded: Self.signature)!, for: bytes + Data([0x20])))
  }

  @Test func thatEnvelopeIsMalformedBecauseItsApprovalRefIsNotAnApprovalRef() throws {
    var object = try #require(try FleetJSON.parse(Data(Self.served.utf8)).objectValue)
    object["signature"] = .string(Self.signature)
    #expect(FleetEnvelope.parse(.object(object)) == nil)
  }

  // 2. PROTOCOL.md §8.7: the SERVER'S published vectors, fixed fake key seed 0x0b x 32, key id fk1.
  static let fakeKey = "Zr5+Myx6RTMyvZ0Kf32wVfXF7xoGraZtmLOftoEMRzo="  // gitleaks:allow
  static let vectorACanonical =
    #"{"approval_ref":null,"cmd_id":"cmd_00000000000000000001","device_id":"dev_000000000000000000000001","expires_at":"2026-10-10T07:05:00.000Z","issued_at":"2026-10-10T07:00:00.000Z","issuer":{"id":"op_example","kind":"operator"},"key_id":"fk1","machine":"EXAMPLE-MAC","nonce":"AAECAwQFBgcICQoLDA0ODw==","params":{"log_lines":200,"scope":"audio"},"v":2,"verb":"collect_diag"}"#
  static let vectorASignature =
    "rvpslFmkoahEZ7Mng3sQodi3DMeNwysqjwzx0KUk62hODq+SeDJYH/lKo68Kxpyd0rZuYtunCSlhuCaga7+aAQ=="  // gitleaks:allow
  static let vectorBSignature =
    "5OGLMDD9y38GH6MO0eX4Y+dFqVGYqrFm7Ya3uClkmq1ChctvKmaWOUT/CP+IPubuC41cQKItO55iMhLCNwinDg=="  // gitleaks:allow

  /// Vector A as served: ordinary JSON, params in an order that is NOT the signed order.
  static func vectorA(signature: String = vectorASignature) throws -> FleetJSON {
    var object = try #require(try FleetJSON.parse(Data(vectorACanonical.utf8)).objectValue)
    object["signature"] = .string(signature)
    return .object(object)
  }

  /// Vector B per the spec: A with cmd_id ...02, verb restart_recorder, params {force:true}, approval go_example1,
  /// nonce EBESExQVFhcYGRobHB0eHw==, issued 07:10:00.000Z, expires 07:15:00.000Z.
  static func vectorB() throws -> FleetJSON {
    var object = try #require(try FleetJSON.parse(Data(vectorACanonical.utf8)).objectValue)
    object["cmd_id"] = .string("cmd_00000000000000000002")
    object["verb"] = .string("restart_recorder")
    object["params"] = .object(["force": .bool(true)])
    object["approval_ref"] = .string("go_example1")
    object["nonce"] = .string("EBESExQVFhcYGRobHB0eHw==")
    object["issued_at"] = .string("2026-10-10T07:10:00.000Z")
    object["expires_at"] = .string("2026-10-10T07:15:00.000Z")
    object["signature"] = .string(vectorBSignature)
    return .object(object)
  }

  private func verifier() -> FleetVerifier {
    FleetVerifier(
      serverKeys: ["fk1": Data(base64Encoded: Self.fakeKey)!], deviceID: "dev_000000000000000000000001", machine: "EXAMPLE-MAC")
  }

  private func verify(_ json: FleetJSON, at iso: String, sessionOpen: Bool = false) -> Result<FleetVerifier.Accepted, FleetRefusal> {
    verifier().verify(
      json, now: FleetEnvelope.date(iso)!, nonceSeen: { _ in false },
      gates: FleetGateState(sessionOpen: sessionOpen), rates: FleetRateState(), killSwitch: false)
  }

  @Test func vectorAsCanonicalBytesAreWhatThisCodeProduces() throws {
    let envelope = try #require(FleetEnvelope.parse(try Self.vectorA()))
    #expect(String(decoding: envelope.signedBytes, as: UTF8.self) == Self.vectorACanonical)
  }

  @Test func vectorAVerifiesAndIsAccepted() throws {
    // 07:01 UTC is 12:31 IST: a diagnose verb is not privileged, so no approval is needed.
    let accepted = try verify(try Self.vectorA(), at: "2026-10-10T07:01:00.000Z").get()
    #expect(accepted.verb == .collectDiag && accepted.envelope.approvalRef == nil)
    #expect(accepted.params.raw["scope"] == .string("audio") && accepted.params.raw["log_lines"] == .int(200))
  }

  @Test func vectorBVerifiesAndIsAcceptedBecauseItCarriesAnApprovalRef() throws {
    // A forced restart, inside clinic hours, with approval_ref go_example1. The session is closed.
    let accepted = try verify(try Self.vectorB(), at: "2026-10-10T07:11:00.000Z").get()
    #expect(accepted.verb == .restartRecorder && accepted.envelope.approvalRef == "go_example1")
  }

  @Test func vectorBWithoutItsApprovalRefIsBadSignatureNotAGateRefusal() throws {
    var object = try #require(try Self.vectorB().objectValue)
    object["approval_ref"] = .null
    #expect(refusal(verify(.object(object), at: "2026-10-10T07:11:00.000Z")) == .badSignature)
  }

  @Test func vectorBWithAnOpenSessionIsStillAcceptedBecauseItIsForcedAndApproved() throws {
    #expect(try verify(try Self.vectorB(), at: "2026-10-10T07:11:00.000Z", sessionOpen: true).get().verb == .restartRecorder)
  }

  @Test func anyChangeToAVectorBreaksIt() throws {
    var changed = try #require(try Self.vectorA().objectValue)
    changed["machine"] = .string("EXAMPLE-MAC2")
    #expect(refusal(verify(.object(changed), at: "2026-10-10T07:01:00.000Z")) == .badSignature)
    #expect(refusal(verify(try Self.vectorA(signature: Self.vectorBSignature), at: "2026-10-10T07:01:00.000Z")) == .badSignature)
  }

  @Test func theWindowIsTheEnvelopesOwn() throws {
    #expect(refusal(verify(try Self.vectorA(), at: "2026-10-10T07:05:01.000Z")) == .expired)
    #expect(refusal(verify(try Self.vectorA(), at: "2026-10-10T06:57:59.000Z")) == .expired)  // 121 s early
    #expect(refusal(verify(try Self.vectorA(), at: "2026-10-10T06:58:01.000Z")) == nil)
  }
}

// MARK: - The compiled-in server key

@Suite struct FleetServerKeyTests {
  @Test func fk1IsCompiledInAndIsAThirtyTwoByteEd25519PublicKey() throws {
    let keys = FleetServerKeys.resolve()
    #expect(keys.keys.sorted() == ["fk1"])
    let fk1 = try #require(keys["fk1"])
    #expect(fk1.count == 32)
    #expect(FleetServerKeys.compiled["fk1"] == "wpYSW+ClvmAYrb8qvuCJ8aFj2yX0aoujdK14ALOkcb8=")
    #expect(throws: Never.self) { try Curve25519.Signing.PublicKey(rawRepresentation: fk1) }
  }

  @Test func theDefaultVerifierAcceptsOnlyFk1AndRefusesAnyOtherSigner() {
    let verifier = FleetVerifier(serverKeys: FleetServerKeys.resolve(), deviceID: TestServer.deviceID, machine: TestServer.machine)
    let stranger = TestServer()  // a different key under the same name
    let verdict = verifier.verify(
      stranger.envelope(), now: TestServer.now, nonceSeen: { _ in false }, gates: FleetGateState(sessionOpen: false),
      rates: FleetRateState(), killSwitch: false)
    #expect(refusal(verdict) == .badSignature)
    let other = verifier.verify(
      stranger.envelope(keyID: "fk2"), now: TestServer.now, nonceSeen: { _ in false },
      gates: FleetGateState(sessionOpen: false), rates: FleetRateState(), killSwitch: false)
    #expect(refusal(other) == .badSignature, "fk2 is not compiled in yet")
  }

  @Test func theRotationKeyCanBeAddedWithoutTouchingTheVerifier() throws {
    let next = TestServer()
    let keys = FleetServerKeys.resolve(["fk1": FleetServerKeys.compiled["fk1"]!, "fk2": next.publicKey.base64EncodedString()])
    #expect(keys.keys.sorted() == ["fk1", "fk2"])
    let verifier = FleetVerifier(serverKeys: keys, deviceID: TestServer.deviceID, machine: TestServer.machine)
    let verdict = verifier.verify(
      next.envelope(keyID: "fk2"), now: TestServer.now, nonceSeen: { _ in false },
      gates: FleetGateState(sessionOpen: false), rates: FleetRateState(), killSwitch: false)
    #expect(refusal(verdict) == nil)
  }
}

@Suite struct FleetVerifierOrderTests {
  let server = TestServer()
  /// In clinic hours (14:25 IST) unless a test says otherwise.
  let day = TestServer.now
  let night = TestServer.night

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
    #expect(mal { $0["approval_ref"] = .string("ab") } == .malformed)  // 3..64 characters
    #expect(mal { $0["approval_ref"] = .string("has space") } == .malformed)
    #expect(mal { $0["approval_ref"] = .string(String(repeating: "a", count: 65)) } == .malformed)
    #expect(mal { $0["params"] = .array([]) } == .malformed)
    #expect(mal { $0["issuer"] = .object(["kind": .string("root"), "id": .string("x")]) } == .malformed)
    #expect(mal { $0["params"] = .object(["Bad-Key": .int(1)]) } == .malformed)
    #expect(refusal(server.verify(.string("x"))) == .malformed)
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
          rates: FleetRateState(), killSwitch: false)) == .badSignature, "no keys: everything is refused")
  }

  @Test func expiredAndTheWindow() {
    #expect(refusal(server.verify(server.envelope(issued: TestServer.now.addingTimeInterval(-400), ttl: 300))) == .expired)
    #expect(refusal(server.verify(server.envelope(issued: TestServer.now.addingTimeInterval(-10), ttl: 901))) == .expired)
    #expect(refusal(server.verify(server.envelope(issued: TestServer.now.addingTimeInterval(130)))) == .expired)
    #expect(refusal(server.verify(server.envelope(issued: TestServer.now.addingTimeInterval(110)))) == nil)
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
    for verb in ["update_bundle", "rollback_bundle", "breakglass_enable", "chrome_relaunch", "bash", "exec", "rotate_identity", "x"] {
      #expect(refusal(server.verify(server.envelope(verb: verb))) == .verbNotAllowed, "\(verb)")
    }
  }

  @Test func aVerbOutsideTheCharacterSetIsMalformedNotAllowListed() {
    #expect(refusal(server.verify(server.envelope(verb: "Helper_Status"))) == .malformed)
    #expect(refusal(server.verify(server.envelope(verb: "../etc/passwd"))) == .malformed)
  }

  @Test func theCatalogueIsTheFifteenAndNothingElse() {
    #expect(
      Set(FleetVerb.allCases.map(\.rawValue))
        == [
          "helper_status", "collect_diag", "report_diag", "list_audio_inputs", "select_audio_input", "coreaudiod_reset",
          "usb_reseat", "self_test", "restart_recorder", "reload_launchagent", "pieces_inventory", "pieces_reupload",
          "wake", "pmset_enforce", "schedule_poweron",
        ])
    // PROTOCOL §8.3: who runs what, and which are privileged.
    let helperVerbs: Set<FleetVerb> = [
      .helperStatus, .collectDiag, .coreaudiodReset, .usbReseat, .restartRecorder, .reloadLaunchagent, .wake, .pmsetEnforce,
      .schedulePoweron,
    ]
    #expect(Set(FleetVerb.allCases.filter(\.runsOnHelper)) == helperVerbs)
    #expect(Set(FleetVerb.allCases.filter(\.isPrivileged)) == [.coreaudiodReset, .usbReseat, .restartRecorder, .reloadLaunchagent])
  }

  @Test func closedParams() {
    func ok(_ verb: String, _ params: [String: FleetJSON]) -> Bool {
      refusal(server.verify(server.envelope(at: night, verb: verb, params: params), now: night)) == nil
    }
    func bad(_ verb: String, _ params: [String: FleetJSON]) -> Bool {
      refusal(server.verify(server.envelope(at: night, verb: verb, params: params), now: night)) == .badParams
    }
    for verb in ["helper_status", "report_diag", "list_audio_inputs", "coreaudiod_reset", "reload_launchagent", "wake", "pmset_enforce"] {
      #expect(ok(verb, [:]), "\(verb)")
      #expect(bad(verb, ["x": .int(1)]), "\(verb)")
    }
    #expect(ok("collect_diag", ["scope": .string("power"), "log_lines": .int(500)]) && ok("collect_diag", ["scope": .string("chrome")]))
    #expect(bad("collect_diag", [:]) && bad("collect_diag", ["scope": .string("keychain")]))
    #expect(bad("collect_diag", ["scope": .string("audio"), "log_lines": .int(501)]))
    #expect(bad("collect_diag", ["scope": .string("audio"), "log_lines": .int(0)]), "1..500")
    #expect(bad("collect_diag", ["scope": .string("audio"), "path": .string("/etc/passwd")]))
    #expect(ok("usb_reseat", [:]) && ok("usb_reseat", ["port": .string("3")]))
    #expect(bad("usb_reseat", ["port": .string("")]) && bad("usb_reseat", ["port": .string(String(repeating: "p", count: 33))]))
    #expect(bad("usb_reseat", ["port": .string("a\nb")]), "no control characters")
    #expect(ok("restart_recorder", [:]) && ok("restart_recorder", ["force": .bool(false)]))
    #expect(bad("restart_recorder", ["force": .string("yes")]) && bad("restart_recorder", ["cmd": .string("rm -rf /")]))
    #expect(ok("select_audio_input", ["device_uid": .string("BuiltInMicrophoneDevice"), "input_volume_pct": .int(100)]))
    #expect(bad("select_audio_input", [:]) && bad("select_audio_input", ["input_volume_pct": .int(50)]), "device_uid is required")
    #expect(bad("select_audio_input", ["device_uid": .string("u"), "input_volume_pct": .int(101)]))
    #expect(bad("select_audio_input", ["device_uid": .string(String(repeating: "u", count: 129))]))
    #expect(ok("self_test", [:]) && ok("self_test", ["volume_pct": .int(0)]) && ok("self_test", ["volume_pct": .int(100)]))
    #expect(bad("self_test", ["volume_pct": .int(101)]) && bad("self_test", ["volume": .int(50)]))
    #expect(ok("pieces_inventory", ["since": .string("2026-10-10T07:00:00.000Z")]) && ok("pieces_reupload", [:]))
    #expect(bad("pieces_inventory", ["since": .string("yesterday")]) && bad("pieces_reupload", ["since": .string("2026-10-10")]))
    #expect(ok("schedule_poweron", [:]) && ok("schedule_poweron", ["time": .string("07:05")]) && ok("schedule_poweron", ["time": .string("23:59")]))
    #expect(bad("schedule_poweron", ["time": .string("24:00")]) && bad("schedule_poweron", ["time": .string("7:05")]))
    #expect(bad("schedule_poweron", ["time": .int(705)]))
  }

  // ─── step 8: the local gates, in the order PROTOCOL §8.5 lists them ──────────────────────────

  @Test func clinicHoursAreSevenThirtyInclusiveToTwentyOneThirtyExclusiveIST() {
    func at(_ hh: Int, _ mm: Int, _ ss: Int = 0) -> Date {
      // IST = UTC + 5:30. 2026-10-10 00:00 UTC = 05:30 IST.
      Date(timeIntervalSince1970: 1_791_590_400 + Double((hh * 3600 + mm * 60 + ss) - 19_800))
    }
    #expect(!FleetClock.inClinicHours(at(7, 29, 59)) && FleetClock.inClinicHours(at(7, 30)))
    #expect(FleetClock.inClinicHours(at(21, 29, 59)) && !FleetClock.inClinicHours(at(21, 30)))
    #expect(!FleetClock.inClinicHours(at(0, 0)) && !FleetClock.inClinicHours(at(3, 0)) && FleetClock.inClinicHours(at(12, 0)))
  }

  @Test func aPrivilegedVerbInsideClinicHoursNeedsAnApprovalRef() {
    for verb in ["coreaudiod_reset", "usb_reseat", "restart_recorder", "reload_launchagent"] {
      #expect(refusal(server.verify(server.envelope(verb: verb), now: day)) == .clinicHoursNeedsApproval, "\(verb)")
      #expect(refusal(server.verify(server.envelope(verb: verb, approval: "go_14"), now: day)) == nil, "\(verb)")
      #expect(refusal(server.verify(server.envelope(at: night, verb: verb), now: night)) == nil, "\(verb) at night")
    }
  }

  @Test func nonPrivilegedVerbsNeverNeedApprovalAtAnyHour() {
    for verb in ["helper_status", "wake", "pmset_enforce", "schedule_poweron", "list_audio_inputs", "report_diag", "pieces_inventory"] {
      #expect(refusal(server.verify(server.envelope(verb: verb), now: day)) == nil, "\(verb)")
    }
  }

  @Test func aForcedRestartNeedsAnApprovalRefAtAnyHour() {
    let forced = ["force": FleetJSON.bool(true)]
    #expect(refusal(server.verify(server.envelope(at: night, verb: "restart_recorder", params: forced), now: night)) == .clinicHoursNeedsApproval)
    #expect(refusal(server.verify(server.envelope(at: night, verb: "restart_recorder", params: forced, approval: "go_x1"), now: night)) == nil)
    #expect(refusal(server.verify(server.envelope(at: night, verb: "restart_recorder", params: ["force": .bool(false)]), now: night)) == nil)
  }

  @Test func noResetOrRestartWhileASessionIsOpenUnlessForcedAndApproved() {
    func v(_ verb: String, _ params: [String: FleetJSON] = [:], approval: String? = nil) -> FleetRefusal? {
      refusal(server.verify(server.envelope(at: night, verb: verb, params: params, approval: approval), sessionOpen: true, now: night))
    }
    #expect(v("coreaudiod_reset") == .sessionOpen && v("coreaudiod_reset", approval: "go_ok1") == .sessionOpen, "no force exists for it")
    #expect(v("reload_launchagent", approval: "go_ok1") == .sessionOpen)
    #expect(v("restart_recorder") == .sessionOpen)
    #expect(v("restart_recorder", ["force": .bool(true)]) == .clinicHoursNeedsApproval || v("restart_recorder", ["force": .bool(true)]) == .sessionOpen)
    #expect(v("restart_recorder", ["force": .bool(true)], approval: "go_ok1") == nil)
    #expect(v("restart_recorder", approval: "go_ok1") == .sessionOpen, "approval alone is not force")
    // harmless verbs run during a session
    for verb in ["helper_status", "wake", "pmset_enforce", "list_audio_inputs", "report_diag", "pieces_inventory"] { #expect(v(verb) == nil, "\(verb)") }
  }

  @Test func guiVerbsNeedAConsoleUserAndCoreaudiodDoesNot() {
    func v(_ verb: String) -> FleetRefusal? {
      refusal(server.verify(server.envelope(at: night, verb: verb), consoleUser: false, now: night))
    }
    #expect(v("restart_recorder") == .noConsoleUser && v("reload_launchagent") == .noConsoleUser)
    #expect(v("coreaudiod_reset") == nil && v("wake") == nil && v("pmset_enforce") == nil && v("helper_status") == nil)
  }

  @Test func theGatesRunInThePublishedOrder() {
    // open session AND no console user AND no approval in clinic hours: session_open first.
    #expect(refusal(server.verify(server.envelope(verb: "reload_launchagent"), sessionOpen: true, consoleUser: false, now: day)) == .sessionOpen)
    // no console user AND no approval in clinic hours: no_console_user before the approval rule.
    #expect(refusal(server.verify(server.envelope(verb: "reload_launchagent"), consoleUser: false, now: day)) == .noConsoleUser)
  }

  @Test func theCeilings() {
    let restart = server.envelope(at: night, verb: "reload_launchagent")
    #expect(refusal(server.verify(restart, ran: 9, now: night)) == nil)
    #expect(refusal(server.verify(restart, ran: 10, now: night)) == .rateLimited)
    #expect(refusal(server.verify(server.envelope(verb: "helper_status"), ran: 99)) == nil, "diagnostics are not counted")
    let reset = server.envelope(at: night, verb: "coreaudiod_reset")
    #expect(refusal(server.verify(reset, sinceReset: 1_799, now: night)) == .rateLimited)
    #expect(refusal(server.verify(reset, sinceReset: 1_800, now: night)) == nil)
    #expect(refusal(server.verify(reset, sinceReset: nil, now: night)) == nil)
    #expect(refusal(server.verify(server.envelope(at: night, verb: "wake"), sinceReset: 5, now: night)) == nil, "the gap is for resets only")
  }

  @Test func theKillSwitchRefusesEverything() {
    #expect(refusal(server.verify(server.envelope(), kill: true)) == .killSwitch)
  }

  @Test func theFirstFailureWins() {
    let nonce = TestServer.freshNonce()
    let both = server.envelope(verb: "bash", issued: TestServer.now.addingTimeInterval(-900), nonce: nonce)
    #expect(refusal(server.verify(both, seen: [nonce], kill: true)) == .expired)
    let two = server.envelope(verb: "bash", nonce: nonce)
    #expect(refusal(server.verify(two, seen: [nonce], kill: true)) == .replay)
    #expect(refusal(server.verify(server.envelope(verb: "bash"), kill: true)) == .verbNotAllowed)
    let p = server.envelope(verb: "restart_recorder", params: ["force": .int(1)])
    #expect(refusal(server.verify(p, ran: 99, kill: true)) == .badParams)
    // gates before ceilings before the kill switch
    #expect(refusal(server.verify(server.envelope(verb: "restart_recorder"), ran: 99, kill: true, now: day)) == .clinicHoursNeedsApproval)
    #expect(refusal(server.verify(server.envelope(at: night, verb: "coreaudiod_reset"), ran: 99, kill: true, now: night)) == .rateLimited)
  }
}
