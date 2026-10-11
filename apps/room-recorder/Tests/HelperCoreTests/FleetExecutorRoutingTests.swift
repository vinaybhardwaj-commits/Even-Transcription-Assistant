import CryptoKit
import Foundation
import Testing

@testable import FleetCore
@testable import HelperCore
@testable import RoomRecorderCore

/// Stands in for the engine and records which app verbs it was asked to run.
final class FakeAppRunner: FleetAppVerbRunning, @unchecked Sendable {
  private let lock = NSLock()
  private(set) var asked: [String] = []
  var result = FleetExecResult(outcome: .ok, detail: ["from_app": .bool(true)])
  func runFleetAppVerb(_ verb: FleetVerb, params: FleetParams, commandID: String) async -> FleetExecResult {
    lock.lock(); asked.append(verb.rawValue); lock.unlock()
    return result
  }
}

/// An in-process "root helper" behind a real NSXPCConnection: the app side talks to it exactly as it does the daemon.
final class Loopback {
  let server = TestServer()
  let env = FakeEnv()
  let tools = FakeTools()
  let listener = NSXPCListener.anonymous()
  let delegate: HelperListenerDelegate
  let runner: HelperCommandRunner

  init(helperKeys: [String: Data]? = nil, statePath: String = tempPath("loop-state.json")) {
    let keys = helperKeys ?? ["fk1": server.publicKey]
    runner = HelperCommandRunner(serverKeys: keys, env: env, tools: tools, statePath: statePath, log: { _ in })
    delegate = HelperListenerDelegate(service: HelperService(safeMode: false, runner: runner), requirement: Loopback.ownRequirement)
    listener.delegate = delegate
    listener.resume()
  }
  deinit { listener.invalidate() }

  /// The identifier this test process is signed with, as an XPC requirement.
  static var ownRequirement: String {
    var me: SecCode?
    var staticCode: SecStaticCode?
    var info: CFDictionary?
    guard SecCodeCopySelf([], &me) == errSecSuccess, let me, SecCodeCopyStaticCode(me, [], &staticCode) == errSecSuccess,
      let staticCode,
      SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
      let id = (info as? [String: Any])?[kSecCodeInfoIdentifier as String] as? String
    else { return "anchor apple" }
    return "identifier \"\(id)\""
  }

  func client() -> HelperClient { HelperClient(endpoint: listener.endpoint, requirement: Loopback.ownRequirement) }
}

@Suite struct FleetExecutorRoutingTests {
  func executor(_ app: FakeAppRunner, _ loop: Loopback) -> EngineFleetExecutor {
    EngineFleetExecutor(engine: app, helper: { loop.client() })
  }
  func accepted(_ loop: Loopback, _ verb: String, _ params: [String: FleetJSON] = [:], approval: String? = nil) throws -> FleetEnvelope {
    try #require(FleetEnvelope.parse(loop.server.envelope(at: loop.env.clock, verb: verb, params: params, approval: approval)))
  }
  func run(_ x: EngineFleetExecutor, _ envelope: FleetEnvelope) async -> FleetExecResult {
    let verb = FleetVerb(rawValue: envelope.verb)!
    return await x.execute(verb, params: FleetParams(envelope.params), envelope: envelope)
  }

  @Test func aHelperVerbGoesToTheHelperOverXPCAndComesBackAsAResult() async throws {
    let loop = Loopback(), app = FakeAppRunner()
    let result = await run(executor(app, loop), try accepted(loop, "coreaudiod_reset"))
    #expect(result.outcome == .ok && result.detail["restarted"] == .bool(true))
    #expect(app.asked.isEmpty, "the app did not run it")
    #expect(loop.tools.actions == ["/bin/launchctl kickstart -k system/com.apple.audio.coreaudiod"])
  }

  @Test func theHelperGivesBackItsOwnDetailAndUnsupportedStaysUnsupported() async throws {
    let loop = Loopback(), app = FakeAppRunner()
    let usb = await run(executor(app, loop), try accepted(loop, "usb_reseat"))
    #expect(usb.outcome == .unsupported && usb.reason == "no_controllable_hub")
    let collect = await run(executor(app, loop), try accepted(loop, "collect_diag", ["scope": .string("audio")]))
    #expect(collect.outcome == .unsupported && collect.reason == "upload_not_available" && collect.detail["scope"] == .string("audio"))
    let pmset = await run(executor(app, loop), try accepted(loop, "helper_status"))
    #expect(pmset.outcome == .ok && pmset.detail["helper_version"] == .string(HelperIdentity.helperVersion))
  }

  @Test func anAppVerbNeverReachesTheHelper() async throws {
    let loop = Loopback(), app = FakeAppRunner()
    for verb in ["list_audio_inputs", "report_diag", "pieces_inventory", "pieces_reupload", "self_test"] {
      let result = await run(executor(app, loop), try accepted(loop, verb))
      #expect(result.outcome == .ok, "\(verb)")
    }
    let select = await run(executor(app, loop), try accepted(loop, "select_audio_input", ["device_uid": .string("u")]))
    #expect(select.outcome == .ok)
    #expect(app.asked == ["list_audio_inputs", "report_diag", "pieces_inventory", "pieces_reupload", "self_test", "select_audio_input"])
    #expect(loop.tools.calls.isEmpty)
  }

  @Test func restartRecorderIsTheAppsOwnRestartNotAHelperKickstartThatWouldKillTheMessenger() async throws {
    let loop = Loopback(), app = FakeAppRunner()
    let result = await run(executor(app, loop), try accepted(loop, "restart_recorder"))
    #expect(result.outcome == .ok && app.asked == ["restart_recorder"] && loop.tools.calls.isEmpty)
  }

  @Test func reloadLaunchAgentAnswersFirstAndOnlyThenAsksTheHelper() async throws {
    let loop = Loopback(), app = FakeAppRunner()
    loop.env.files[FakeEnv.plist] = Data("plist".utf8)
    let result = await run(executor(app, loop), try accepted(loop, "reload_launchagent"))
    #expect(result.outcome == .ok && result.detail["reloading"] == .bool(true))
    #expect(loop.tools.calls.isEmpty, "nothing has touched the agent before the result is safe")
    let after = try #require(result.afterResultPosted)
    await after()
    #expect(loop.tools.actions == ["/bin/launchctl bootout gui/501/com.evenscribe.room-recorder", "/bin/launchctl bootstrap gui/501 \(FakeEnv.plist)"])
  }

  @Test func aHelperThatRefusesIsReportedAsRefusedByTheHelperNotAsSuccess() async throws {
    let loop = Loopback(helperKeys: ["fk1": TestServer().publicKey]), app = FakeAppRunner()  // the helper trusts a DIFFERENT key
    let result = await run(executor(app, loop), try accepted(loop, "wake"))
    #expect(result.outcome == .failed && result.reason == "helper_refused_bad_signature")
    #expect(loop.tools.calls.isEmpty, "the app's verification did not make the helper act")
  }

  @Test func noHelperAnswerIsHelperUnreachable() async throws {
    let loop = Loopback(), app = FakeAppRunner()
    var dead = EngineFleetExecutor(engine: app, helper: {
      let listener = NSXPCListener.anonymous()  // nobody listens on it
      return HelperClient(endpoint: listener.endpoint, requirement: Loopback.ownRequirement)
    })
    dead.helperTimeout = 1
    let started = Date()
    let result = await run(dead, try accepted(loop, "wake"))
    #expect(result.outcome == .failed && result.reason == "helper_unreachable")
    #expect(Date().timeIntervalSince(started) < 10)
  }

  @Test func theResultMappingCoversEveryOutcome() {
    func reply(_ outcome: String, reason: String = "", detail: String = "{}") -> HelperResponse {
      HelperResponse(ok: outcome == "ok", code: reason, detail: ["outcome": outcome, "reason": reason, "detail_json": detail])
    }
    #expect(EngineFleetExecutor.result(from: nil).reason == "helper_unreachable")
    #expect(EngineFleetExecutor.result(from: reply("ok", detail: "{\"n\":3}")).detail["n"] == .int(3))
    #expect(EngineFleetExecutor.result(from: reply("failed", reason: "launchctl_5")).reason == "launchctl_5")
    #expect(EngineFleetExecutor.result(from: reply("refused", reason: "replay")).reason == "helper_refused_replay")
    #expect(EngineFleetExecutor.result(from: reply("unsupported", reason: "x")).outcome == .unsupported)
    #expect(EngineFleetExecutor.result(from: reply("garbage")).outcome == .failed)
    #expect(EngineFleetExecutor.result(from: reply("ok", detail: "not json")).detail.isEmpty)
  }
}

// MARK: - The whole path: poll -> app verifies -> XPC -> helper verifies -> tool -> signed result

@Suite struct CommandsLiveEndToEndTests {
  private func pollBody(_ commands: [FleetJSON]) -> FleetResponse {
    FleetResponse(
      status: 200,
      body: Data(FleetJSON.object([
        "ok": .bool(true), "server_time": .string(TestServer.iso(TestServer.night)),
        "kill_switch": .object(["global": .bool(false)]), "commands": .array(commands),
      ]).canonical.utf8))
  }

  /// A client whose verifier trusts `server`, wired to the loopback helper.
  private func rig(_ loop: Loopback, commands: @escaping @Sendable (TestServer) -> [FleetJSON]) -> (FleetClient, FakeTransport, MemoryState) {
    let state = MemoryState()
    var initial = FleetState()
    initial.installID = "inst_1"
    initial.deviceID = TestServer.deviceID
    state.save(initial)
    let transport = FakeTransport { [self] request in
      request.path == "/api/fleet/poll"
        ? pollBody(commands(loop.server))
        : FleetResponse(status: 200, body: Data(#"{"ok":true,"duplicate":false}"#.utf8))
    }
    let client = FleetClient(
      config: FleetClientConfig(enabled: true, installID: "inst_1", machine: TestServer.machine),
      transport: transport, keys: MemoryKeys(), store: state,
      executor: EngineFleetExecutor(engine: FakeAppRunner(), helper: { loop.client() }),
      serverKeys: ["fk1": loop.server.publicKey], roomSession: { "room-jwt" }, gates: { FleetGateState(sessionOpen: false) },
      clock: { TestServer.night }, sleep: { _ in }, makeJTI: { UUID().uuidString.lowercased() }, log: { _ in })
    return (client, transport, state)
  }

  private func postedResults(_ transport: FakeTransport) throws -> [[String: FleetJSON]] {
    try transport.requests.filter { $0.path == "/api/fleet/results" }.map { try parseObject($0.body) }
  }

  @Test func aSignedCoreaudiodResetRunsEndToEndAndTheSignedResultSaysSo() async throws {
    let loop = Loopback()
    let (client, transport, _) = rig(loop) { [$0.envelope(at: TestServer.night, cmdID: "cmd_reset", verb: "coreaudiod_reset")] }
    #expect(await client.pollOnce() == .handled(1))
    #expect(loop.tools.actions == ["/bin/launchctl kickstart -k system/com.apple.audio.coreaudiod"])
    let results = try postedResults(transport)
    #expect(results.count == 1 && results[0]["cmd_id"]?.stringValue == "cmd_reset" && results[0]["outcome"]?.stringValue == "ok")
    #expect(results[0]["detail"] == .object(["restarted": .bool(true)]))
  }

  @Test func theWholePowerAndLifecycleCatalogueRunsThroughOnePollEachWithTheRightTool() async throws {
    let loop = Loopback()
    loop.env.files[FakeEnv.plist] = Data("plist".utf8)
    loop.tools.responder = { _, args in
      args == ["-g"] ? ToolResult(status: 0, output: " sleep 0\n womp 1\n") : args == ["-g", "sched"]
        ? ToolResult(status: 0, output: "  wakepoweron at 7:05AM every day\n") : ToolResult(status: 0)
    }
    let verbs: [(String, [String: FleetJSON])] = [
      ("helper_status", [:]), ("wake", [:]), ("pmset_enforce", [:]), ("schedule_poweron", [:]),
      ("usb_reseat", [:]), ("collect_diag", ["scope": .string("power")]),
    ]
    let (client, transport, _) = rig(loop) { server in
      verbs.enumerated().map { server.envelope(at: TestServer.night, cmdID: "cmd_\($0.offset)", verb: $0.element.0, params: $0.element.1) }
    }
    _ = await client.pollOnce()
    let results = try postedResults(transport)
    let outcomes = results.map { "\($0["cmd_id"]!.stringValue!):\($0["outcome"]!.stringValue!)" }
    #expect(outcomes == ["cmd_0:ok", "cmd_1:ok", "cmd_2:ok", "cmd_3:ok", "cmd_4:unsupported", "cmd_5:unsupported"])
    #expect(loop.tools.actions.contains("/usr/bin/caffeinate -u -t 5"))
    #expect(loop.tools.actions.contains("/usr/bin/pmset repeat wakeorpoweron MTWRFSU 07:05:00"))
  }

  @Test func theAppsOwnRefusalNeverReachesTheHelperAndIsReported() async throws {
    let loop = Loopback()
    let (client, transport, _) = rig(loop) {
      [$0.envelope(at: TestServer.night, cmdID: "cmd_bad", verb: "update_bundle"), $0.envelope(at: TestServer.night, cmdID: "cmd_p", verb: "coreaudiod_reset", params: ["x": .int(1)])]
    }
    _ = await client.pollOnce()
    let results = try postedResults(transport)
    #expect(results.map { $0["reason"]?.stringValue } == ["verb_not_allowed", "bad_params"])
    #expect(loop.tools.calls.isEmpty)
  }

  @Test func aCommandSignedByTheWrongKeyIsRefusedByTheAppAndWouldBeByTheHelperToo() async throws {
    let loop = Loopback()
    let stranger = Curve25519.Signing.PrivateKey()
    let (client, transport, _) = rig(loop) { [$0.envelope(at: TestServer.night, cmdID: "cmd_forged", verb: "coreaudiod_reset", signWith: stranger)] }
    _ = await client.pollOnce()
    #expect(try postedResults(transport).first?["reason"]?.stringValue == "bad_signature")
    #expect(loop.tools.calls.isEmpty)
  }

  @Test func theSameEnvelopeDeliveredAgainIsNotRunAgain() async throws {
    let loop = Loopback()
    let nonce = TestServer.freshNonce()
    let (client, _, _) = rig(loop) { [$0.envelope(at: TestServer.night, cmdID: "cmd_once", verb: "wake", nonce: nonce)] }
    _ = await client.pollOnce()
    _ = await client.pollOnce()
    #expect(loop.tools.actions.filter { $0.contains("caffeinate") }.count == 1)
  }
}
