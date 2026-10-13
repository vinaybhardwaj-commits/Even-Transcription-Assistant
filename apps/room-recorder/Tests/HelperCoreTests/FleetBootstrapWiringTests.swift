import Foundation
import Testing

@testable import FleetCore
@testable import RoomRecorderCore

// MARK: - 0.1.36 carry (refuter R3 gap): `FleetBootstrap.start` wires the engine's gate

/// `start` assembles its client in `FleetBootstrap.makeClient` and nowhere else. These tests build a client with
/// that very factory, the engine replaced by a fake that answers `fleetSessionOpen`, and push real signed
/// commands through it. The 0.1.35 R3 defect (a constant `sessionOpen: false` handed to the client) fails here.
@Suite struct FleetBootstrapWiringTests {
  struct Wired {
    let client: FleetClient
    let transport: FakeTransport
    let app: FakeAppRunner
  }

  func wired(app: FakeAppRunner, commands: @escaping @Sendable (TestServer) -> [FleetJSON]) -> Wired {
    let server = TestServer()
    let store = MemoryState()
    var initial = FleetState()
    initial.installID = "inst_1"
    initial.deviceID = TestServer.deviceID
    store.save(initial)
    let transport = FakeTransport { request in
      if request.path == "/api/fleet/poll" {
        let body = FleetJSON.object([
          "ok": .bool(true), "server_time": .string(TestServer.iso(TestServer.now)),
          "kill_switch": .object(["global": .bool(false)]), "commands": .array(commands(server)),
        ])
        return FleetResponse(status: 200, body: Data(body.canonical.utf8))
      }
      return FleetResponse(status: 200, body: Data(#"{"ok":true,"duplicate":false}"#.utf8))
    }
    let counter = Counter()
    let client = FleetBootstrap.makeClient(
      config: FleetClientConfig(enabled: true, installID: "inst_1", machine: TestServer.machine, hwModel: "Macmini9,1"),
      app: app, transport: transport, keys: MemoryKeys(), store: store, serverKeys: ["fk1": server.publicKey],
      roomSession: { "room-jwt" }, clock: { TestServer.now }, sleep: { _ in },
      makeJTI: { "jti-\(counter.next())-padding" }, log: { _ in })
    return Wired(client: client, transport: transport, app: app)
  }

  func results(_ w: Wired) throws -> [[String: FleetJSON]] {
    try w.transport.requests.filter { $0.path == "/api/fleet/results" }.map { try parseObject($0.body) }
  }

  @Test func theClientStartBuildsRefusesARestartOverAnOpenSession() async throws {
    let app = FakeAppRunner()
    app.sessionOpen = true
    let w = wired(app: app) { [$0.envelope(cmdID: "cmd_restart", verb: "restart_recorder", approval: "go_test")] }
    _ = await w.client.pollOnce()
    #expect(app.asked.isEmpty, "the engine was never asked to restart")
    let posted = try results(w)
    #expect(posted.first?["reason"]?.stringValue == "session_open")
    #expect(posted.first?["outcome"]?.stringValue != "ok")
  }

  @Test func theSameClientRunsTheRestartWhenTheRoomIsQuiet() async throws {
    let app = FakeAppRunner()
    let w = wired(app: app) { [$0.envelope(cmdID: "cmd_restart", verb: "restart_recorder", approval: "go_test")] }
    _ = await w.client.pollOnce()
    #expect(app.asked == ["restart_recorder"], "the executor is the engine's: the app verb reached it")
    #expect(try results(w).first?["outcome"]?.stringValue == "ok")
  }

  @Test func theGateIsReadFromTheEngineAtEachCommandNotOnceAtStart() async throws {
    let app = FakeAppRunner()
    let w = wired(app: app) { [$0.envelope(cmdID: "cmd_\(UUID().uuidString.prefix(6))", verb: "restart_recorder", approval: "go_test")] }
    _ = await w.client.pollOnce()
    #expect(app.asked.count == 1, "quiet at first")
    app.sessionOpen = true
    _ = await w.client.pollOnce()
    #expect(app.asked.count == 1, "a session that opened since is seen by the very next command")
    #expect(try results(w).last?["reason"]?.stringValue == "session_open")
  }

  @Test func startAssemblesItsClientOnlyThroughMakeClient() throws {
    // `start` must not build a FleetClient any other way: a second path is where a constant gate crept in.
    let source = try String(
      contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Sources/RoomRecorderCore/FleetWiring.swift"), encoding: .utf8)
    #expect(source.components(separatedBy: "FleetClient(").count - 1 == 1, "FleetClient( appears in makeClient only (FleetClientConfig( is a different token)")
    #expect(source.contains("gates: gateProvider(app)"))
    #expect(!source.contains("sessionOpen: false"), "no constant gate anywhere in the wiring")
  }
}
