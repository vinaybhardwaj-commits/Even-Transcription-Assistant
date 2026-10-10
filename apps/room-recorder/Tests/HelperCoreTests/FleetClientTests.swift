import CryptoKit
import Foundation
import Testing

@testable import FleetCore

// MARK: - Fakes

final class FakeTransport: FleetTransport, @unchecked Sendable {
  private let lock = NSLock()
  private(set) var requests: [FleetRequest] = []
  var handler: @Sendable (FleetRequest) throws -> FleetResponse

  init(_ handler: @escaping @Sendable (FleetRequest) throws -> FleetResponse) { self.handler = handler }

  func send(_ request: FleetRequest) async throws -> FleetResponse {
    lock.lock(); requests.append(request); lock.unlock()
    return try handler(request)
  }
  var paths: [String] { lock.lock(); defer { lock.unlock() }; return requests.map(\.path) }
}

final class MemoryKeys: FleetKeyStore, @unchecked Sendable {
  private let lock = NSLock()
  private var key: FleetSigningKey?
  private(set) var created = 0
  private(set) var loads = 0
  func loadOrCreate() throws -> FleetSigningKey {
    lock.lock(); defer { lock.unlock() }
    loads += 1
    if let key { return key }
    created += 1
    let made = FleetSigningKey.generate()
    key = made
    return made
  }
}

final class MemoryState: FleetStateStore, @unchecked Sendable {
  private let lock = NSLock()
  private var state = FleetState()
  func load() -> FleetState { lock.lock(); defer { lock.unlock() }; return state }
  func save(_ new: FleetState) { lock.lock(); state = new; lock.unlock() }
}

final class RecordingExecutor: FleetExecutor, @unchecked Sendable {
  private let lock = NSLock()
  private(set) var ran: [(FleetVerb, String)] = []
  var result = FleetExecResult(outcome: .ok, detail: ["lines": .int(3)])
  func execute(_ verb: FleetVerb, params: FleetParams, commandID: String) async -> FleetExecResult {
    lock.lock(); ran.append((verb, commandID)); lock.unlock()
    return result
  }
  var count: Int { lock.lock(); defer { lock.unlock() }; return ran.count }
}

final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var n = 0
  func next() -> Int { lock.lock(); defer { lock.unlock() }; n += 1; return n }
}

private func json(_ text: String) -> Data { Data(text.utf8) }
private struct NoBody: Error {}
private func parseObject(_ data: Data?) throws -> [String: FleetJSON] {
  guard let data, let object = try FleetJSON.parse(data).objectValue else { throw NoBody() }
  return object
}
private func ok(_ text: String) -> FleetResponse { FleetResponse(status: 200, body: Data(text.utf8)) }

private func pollBody(commands: [FleetJSON], kill: Bool = false) -> FleetResponse {
  let body = FleetJSON.object([
    "ok": .bool(true), "server_time": .string(TestServer.iso(TestServer.now)),
    "kill_switch": .object(["global": .bool(kill)]), "commands": .array(commands),
  ])
  return ok(body.canonical)
}

/// A client wired to fakes, with the clock frozen at `TestServer.now` and a counter for jtis.
struct Rig {
  let transport: FakeTransport
  let keys = MemoryKeys()
  let store = MemoryState()
  let executor = RecordingExecutor()
  let client: FleetClient
  let slept = Slept()

  final class Slept: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var values: [TimeInterval] = []
    func add(_ v: TimeInterval) { lock.lock(); values.append(v); lock.unlock() }
  }

  init(
    enabled: Bool = true, session: String? = "room-jwt", withDevice: Bool = true, kill: Bool = false,
    responder: @escaping @Sendable (FleetRequest, TestServer) throws -> FleetResponse
  ) {
    let server = TestServer()
    let transport = FakeTransport { try responder($0, server) }
    self.transport = transport
    let counter = Counter()
    let slept = self.slept
    let store = self.store
    var initial = FleetState()
    initial.installID = "inst_1"
    if withDevice { initial.deviceID = TestServer.deviceID }
    store.save(initial)
    let rig = (server, store)
    _ = rig
    client = FleetClient(
      config: FleetClientConfig(enabled: enabled, installID: "inst_1", machine: TestServer.machine, hwModel: "Macmini9,1", helperVersion: "0.2.0-h2"),
      transport: transport, keys: keys, store: store, executor: executor,
      serverKeys: ["fk1": server.publicKey], roomSession: { session }, gates: { FleetGateState(sessionOpen: false) },
      clock: { TestServer.now }, sleep: { slept.add($0) }, makeJTI: { "jti-\(counter.next())-padding" }, log: { _ in })
    self.serverRef = server
  }
  let serverRef: TestServer
}

private func claims(of token: String) -> [String: FleetJSON] {
  let parts = token.split(separator: ".").map(String.init)
  return (try? FleetJSON.parse(FleetB64.fromURL(parts[1]) ?? Data()))?.objectValue ?? [:]
}

private func bearer(_ request: FleetRequest, _ scheme: String) -> String {
  String((request.headers["Authorization"] ?? "").dropFirst(scheme.count + 1))
}

// MARK: - Tests

@Suite struct FleetClientOffByDefaultTests {
  @Test func theConfigIsDisabledUnlessTurnedOn() {
    #expect(FleetClientConfig(installID: "i", machine: "m").enabled == false)
  }

  @Test func aDisabledClientTouchesNothing() async {
    let rig = Rig(enabled: false, withDevice: false) { _, _ in ok("{}") }
    await rig.client.run()
    #expect(await rig.client.registerIfNeeded() == .stop("disabled"))
    #expect(await rig.client.pollOnce() == .stop("disabled"))
    #expect(rig.transport.requests.isEmpty)
    #expect(rig.keys.loads == 0 && rig.keys.created == 0)
  }
}

@Suite struct FleetClientRegistrationTests {
  @Test func registersWithTheRoomSessionAndAProofOfPossession() async throws {
    let rig = Rig(withDevice: false) { request, _ in
      FleetResponse(status: 201, body: json(#"{"ok":true,"device_id":"dev_00000000000000000000000a","server_key_ids":["fk1","fk2"],"poll_url":"/api/fleet/poll","registered_at":"x"}"#))
    }
    #expect(await rig.client.registerIfNeeded() == .handled(1))
    let request = try #require(rig.transport.requests.first)
    #expect(request.method == "POST" && request.path == "/api/fleet/register")
    #expect(request.headers["Authorization"] == "Bearer room-jwt")
    let body = try parseObject(request.body)
    #expect(body["install_id"]?.stringValue == "inst_1")
    #expect(body["machine"]?.stringValue == TestServer.machine)
    #expect(body["hw_model"]?.stringValue == "Macmini9,1")
    #expect(body["key_alg"]?.stringValue == "ed25519")
    let publicKey = try #require(body["public_key"]?.stringValue)
    #expect(publicKey.count == 44)
    // The proof verifies under the key being registered, and binds it.
    let proof = try #require(body["proof"]?.stringValue)
    let parts = proof.split(separator: ".").map(String.init)
    let signature = try #require(FleetB64.fromURL(parts[2]))
    let pub = try Curve25519.Signing.PublicKey(rawRepresentation: Data(base64Encoded: publicKey)!)
    #expect(pub.isValidSignature(signature, for: Data("\(parts[0]).\(parts[1])".utf8)))
    let payload = claims(of: proof)
    #expect(payload["aud"]?.stringValue == "evenscribe-fleet-register")
    #expect(payload["htu"]?.stringValue == "/api/fleet/register")
    #expect(payload["pk"]?.stringValue == FleetB64.url(Data(SHA256.hash(data: Data(base64Encoded: publicKey)!))))
    #expect(rig.store.load().deviceID == TestServer.deviceID)
  }

  @Test func theKeyIsCreatedOnceAndReused() async throws {
    let rig = Rig(withDevice: false) { _, _ in
      FleetResponse(status: 200, body: json(#"{"ok":true,"device_id":"dev_00000000000000000000000a"}"#))
    }
    _ = await rig.client.registerIfNeeded()
    _ = await rig.client.pollOnce()
    #expect(rig.keys.created == 1)
  }

  @Test func revokedOrRetiredOrConflictStopsForGood() async {
    for code in ["REVOKED", "RETIRED", "KEY_CONFLICT"] {
      let rig = Rig(withDevice: false) { _, _ in FleetResponse(status: 409, body: json(#"{"ok":false,"error":"\#(code)"}"#)) }
      let step = await rig.client.registerIfNeeded()
      #expect(step == .stop("register_\(code.lowercased())"))
      #expect(rig.store.load().stoppedReason != nil)
    }
  }

  @Test func noRoomSessionMeansWaitNotGuess() async {
    let rig = Rig(session: nil, withDevice: false) { _, _ in ok("{}") }
    #expect(await rig.client.registerIfNeeded() == .wait(30))
    #expect(rig.transport.requests.isEmpty)
  }
}

@Suite struct FleetClientPollTests {
  @Test func everyPollCarriesAFreshSignedDeviceToken() async throws {
    let rig = Rig { _, _ in pollBody(commands: []) }
    _ = await rig.client.pollOnce()
    _ = await rig.client.pollOnce()
    let requests = rig.transport.requests
    #expect(requests.count == 2)
    var jtis: Set<String> = []
    for request in requests {
      #expect(request.method == "GET" && request.path == "/api/fleet/poll" && request.query == ["wait": "25"])
      #expect(request.body == nil)
      #expect(request.timeout >= 35)
      let token = bearer(request, "Device")
      let c = claims(of: token)
      #expect(c["htm"]?.stringValue == "GET" && c["htu"]?.stringValue == "/api/fleet/poll")
      #expect(c["aud"]?.stringValue == "evenscribe-fleet" && c["iss"]?.stringValue == TestServer.deviceID)
      #expect(c["bsha"] == nil)
      #expect((c["exp"]?.intValue ?? 0) - (c["iat"]?.intValue ?? 0) == 300)
      jtis.insert(c["jti"]?.stringValue ?? "")
      // And the signature verifies under the registered key.
      let parts = token.split(separator: ".").map(String.init)
      let key = try await rig.keys.loadOrCreate()
      let pub = try Curve25519.Signing.PublicKey(rawRepresentation: key.publicKeyData)
      #expect(pub.isValidSignature(try #require(FleetB64.fromURL(parts[2])), for: Data("\(parts[0]).\(parts[1])".utf8)))
    }
    #expect(jtis.count == 2, "a re-sent token would be 401 replay")
  }

  @Test func backoffClimbsToSixtyAndResets() async {
    let failing = Rig { _, _ in FleetResponse(status: 503, body: json(#"{"ok":false,"error":"db"}"#)) }
    var waits: [TimeInterval] = []
    for _ in 0..<9 {
      if case .wait(let s) = await failing.client.pollOnce() { waits.append(s) }
    }
    #expect(waits == [1, 2, 4, 8, 16, 32, 60, 60, 60])
    let flaky = Rig { r, _ in
      FleetResponse(status: 503, body: json("{}"))
    }
    _ = await flaky.client.pollOnce()
    _ = await flaky.client.pollOnce()
    flaky.transport.handler = { _ in pollBody(commands: []) }
    _ = await flaky.client.pollOnce()
    flaky.transport.handler = { _ in FleetResponse(status: 503, body: json("{}")) }
    #expect(await flaky.client.pollOnce() == .wait(1))
  }

  @Test func aNetworkErrorBacksOffAndDoesNotCrash() async {
    struct Down: Error {}
    let rig = Rig { _, _ in throw Down() }
    #expect(await rig.client.pollOnce() == .wait(1))
  }

  @Test func revokedOrUnknownDeviceStopsPolling() async {
    for code in ["revoked", "unknown_device"] {
      let rig = Rig { _, _ in FleetResponse(status: 401, body: json(#"{"ok":false,"error":"\#(code)"}"#)) }
      #expect(await rig.client.pollOnce() == .stop("poll_\(code)"))
      #expect(rig.store.load().stoppedReason == "poll_\(code)")
      await rig.client.run()  // stays down
      #expect(rig.transport.requests.count == 1)
    }
  }

  @Test func aClockProblemWaitsAMinuteAndDoesNotHammer() async {
    for code in ["expired", "not_yet_valid"] {
      let rig = Rig { _, _ in FleetResponse(status: 401, body: json(#"{"ok":false,"error":"\#(code)"}"#)) }
      #expect(await rig.client.pollOnce() == .wait(60))
    }
  }

  @Test func theKillSwitchWithNoCommandsSlowsThePoll() async {
    let rig = Rig { _, _ in pollBody(commands: [], kill: true) }
    #expect(await rig.client.pollOnce() == .wait(5))
  }
}

@Suite struct FleetClientCommandTests {
  private func rig(
    _ commands: @escaping @Sendable (TestServer) -> [FleetJSON], kill: Bool = false,
    resultStatus: Int = 200
  ) -> Rig {
    Rig { request, server in
      if request.path == "/api/fleet/poll" { return pollBody(commands: commands(server), kill: kill) }
      return FleetResponse(status: resultStatus, body: json(#"{"ok":true,"duplicate":false}"#))
    }
  }

  private func results(_ r: Rig) throws -> [[String: FleetJSON]] {
    try r.transport.requests.filter { $0.path == "/api/fleet/results" }.map { try parseObject($0.body) }
  }

  @Test func aGoodCommandRunsAndItsResultIsPostedSigned() async throws {
    let r = rig { [$0.envelope(cmdID: "cmd_a", verb: "report_diag", params: ["log_lines": .int(5)])] }
    #expect(await r.client.pollOnce() == .handled(1))
    #expect(r.executor.ran.map { "\($0.0.rawValue)/\($0.1)" } == ["report_diag/cmd_a"])
    let posted = try #require(r.transport.requests.last)
    #expect(posted.path == "/api/fleet/results" && posted.method == "POST")
    let body = try #require(posted.body)
    let c = claims(of: bearer(posted, "Device"))
    #expect(c["htm"]?.stringValue == "POST" && c["htu"]?.stringValue == "/api/fleet/results")
    #expect(c["bsha"]?.stringValue == FleetToken.bodyHash(body), "bsha binds the exact bytes sent")
    let result = try parseObject(body)
    #expect(result["cmd_id"]?.stringValue == "cmd_a" && result["device_id"]?.stringValue == TestServer.deviceID)
    #expect(result["outcome"]?.stringValue == "ok" && result["reason"] == .null)
    #expect(result["detail"] == .object(["lines": .int(3)]))
    #expect(result["upload"] == .null)
    #expect(body.count <= 16 * 1024)
  }

  @Test func refusalsAreReportedAndNothingRuns() async throws {
    let other = Curve25519.Signing.PrivateKey()
    let r = rig {
      [
        $0.envelope(cmdID: "cmd_unsigned", signWith: other),
        $0.envelope(cmdID: "cmd_wrongmachine", machine: "another-mac"),
        $0.envelope(cmdID: "cmd_old", issued: TestServer.now.addingTimeInterval(-1000)),
        $0.envelope(cmdID: "cmd_shell", verb: "bash"),
        $0.envelope(cmdID: "cmd_params", verb: "collect_diag", params: ["scope": .string("keychain")]),
      ]
    }
    _ = await r.client.pollOnce()
    #expect(r.executor.count == 0)
    let got = try results(r).map { "\($0["cmd_id"]!.stringValue!):\($0["outcome"]!.stringValue!):\($0["reason"]!.stringValue!)" }
    #expect(got == [
      "cmd_unsigned:refused:bad_signature", "cmd_wrongmachine:refused:machine_mismatch",
      "cmd_old:refused:expired", "cmd_shell:refused:verb_not_allowed", "cmd_params:refused:bad_params",
    ])
  }

  @Test func aReplayedNonceIsRefusedEvenUnderAnotherCommandId() async throws {
    let nonce = TestServer.freshNonce()
    let r = rig { [$0.envelope(cmdID: "cmd_one", nonce: nonce), $0.envelope(cmdID: "cmd_two", nonce: nonce)] }
    _ = await r.client.pollOnce()
    #expect(r.executor.ran.map(\.1) == ["cmd_one"])
    let got = try results(r).map { $0["reason"] ?? .null }
    #expect(got == [.null, .string("replay")])
  }

  @Test func aRedeliveredCommandIsAnsweredAgainButNeverRunTwice() async throws {
    let nonce = TestServer.freshNonce()
    let r = rig { [$0.envelope(cmdID: "cmd_again", nonce: nonce)] }
    _ = await r.client.pollOnce()
    _ = await r.client.pollOnce()  // the server offers it again (no result was recorded in this fake)
    #expect(r.executor.count == 1)
    let bodies = try r.transport.requests.filter { $0.path == "/api/fleet/results" }.map { $0.body! }
    #expect(bodies.count == 2 && bodies[0] == bodies[1], "same answer, byte for byte")
    // ...but with a NEW token each time.
    let jtis = r.transport.requests.filter { $0.path == "/api/fleet/results" }.map { claims(of: bearer($0, "Device"))["jti"]?.stringValue }
    #expect(Set(jtis).count == 2)
  }

  @Test func theKillSwitchRefusesDeliveredCommands() async throws {
    let r = rig({ [$0.envelope(cmdID: "cmd_k")] }, kill: true)
    _ = await r.client.pollOnce()
    #expect(r.executor.count == 0)
    #expect(try results(r).first?["reason"]?.stringValue == "kill_switch")
  }

  @Test func theTenPerHourCeilingStopsTheEleventhPrivilegedRun() async throws {
    // The server serves at most ten per poll, so the eleventh arrives in the next one.
    let r = rig { server in
      return (0..<10).map { server.envelope(cmdID: "cmd_a\($0)", verb: "select_audio_input", params: ["device_uid": .string("u")]) }
    }
    _ = await r.client.pollOnce()
    #expect(r.executor.count == 10)
    let signed = r.serverRef.envelope(cmdID: "cmd_b0", verb: "select_audio_input", params: ["device_uid": .string("u")])
    r.transport.handler = { request in
      request.path == "/api/fleet/poll"
        ? pollBody(commands: [signed])
        : FleetResponse(status: 200, body: json(#"{"ok":true,"duplicate":false}"#))
    }
    _ = await r.client.pollOnce()
    #expect(r.executor.count == 10, "the eleventh is not run")
    #expect(try results(r).last?["reason"]?.stringValue == "rate_limited")
  }

  @Test func anUnacceptedResultIsKeptAndRetriedWithAFreshToken() async throws {
    let r = rig({ [$0.envelope(cmdID: "cmd_retry")] }, resultStatus: 503)
    _ = await r.client.pollOnce()
    #expect(r.store.load().results.first?.posted == false)
    r.transport.handler = { request in
      request.path == "/api/fleet/results" ? FleetResponse(status: 200, body: json(#"{"ok":true,"duplicate":false}"#)) : pollBody(commands: [])
    }
    await r.client.flushResults()
    #expect(r.store.load().results.first?.posted == true)
    let tokens = r.transport.requests.filter { $0.path == "/api/fleet/results" }.map { bearer($0, "Device") }
    #expect(tokens.count == 2 && tokens[0] != tokens[1])
  }

  @Test func theAfterResultStepRunsOnlyOnceTheServerHasTheResult() async throws {
    final class Flag: @unchecked Sendable { var fired = 0 }
    let flag = Flag()
    let failing = rig({ [$0.envelope(cmdID: "cmd_restart", verb: "restart_recorder")] }, resultStatus: 503)
    failing.executor.result = FleetExecResult(outcome: .ok, afterResultPosted: { flag.fired += 1 })
    _ = await failing.client.pollOnce()
    #expect(flag.fired == 0, "a restart must not run before the result is safe")
    let good = rig { [$0.envelope(cmdID: "cmd_restart", verb: "restart_recorder")] }
    good.executor.result = FleetExecResult(outcome: .ok, afterResultPosted: { flag.fired += 1 })
    _ = await good.client.pollOnce()
    #expect(flag.fired == 1)
  }

  @Test func oversizedOrOpenEndedDetailIsReplacedNotSent() async throws {
    let r = rig { [$0.envelope(cmdID: "cmd_big")] }
    r.executor.result = FleetExecResult(outcome: .ok, detail: ["blob": .string(String(repeating: "x", count: 5000))])
    _ = await r.client.pollOnce()
    let sent = try #require(try results(r).first)
    #expect(sent["outcome"]?.stringValue == "failed" && sent["reason"]?.stringValue == "bad_detail")
    #expect(sent["detail"] == .object([:]))
  }

  @Test func engineReasonsAreFoldedIntoTheServersCharacterSet() {
    #expect(FleetClient.sanitiseReason("pack_invalid: Bad File!") == "pack_invalid__bad_file_")
    #expect(FleetClient.sanitiseReason("").isEmpty == false)
    #expect(FleetClient.sanitiseReason(String(repeating: "a", count: 100)).count == 64)
  }
}
