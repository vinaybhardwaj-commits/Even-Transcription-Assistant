import Darwin
import Foundation
import Testing

@testable import FleetCore
@testable import HelperCore
@testable import RoomRecorderCore
@testable import TapeCapture
@testable import TapeCore

/// Encounter Buddy, L2 shadow reach (0.1.43): the window decision travels in the `consult_started` payload and the Mac
/// fails closed. A window opens only on `window === true`; a runner starts only on `live === true` plus a usable config.
extension BuddyConsultController {
  /// The 0.1.41 / 0.1.42 tests were written when a consult always meant "window, and live". Production has no such
  /// shorthand: `RoomEngine` passes the payload's two booleans, each false unless the JSON was `true`.
  func consultStarted(opaqueID: String, buddyOff: Bool) -> BuddyConsultOutcome {
    consultStarted(opaqueID: opaqueID, buddyOff: buddyOff, window: true, live: true)
  }
}

@Suite(.serialized) struct BuddyL3Tests {

  static let noConfigPrefix = "buddy runner: no config count "

  // MARK: - The payload through the engine

  /// One consult_started with `payload` on a fresh engine. Returns what the presenter saw, whether a tap file exists,
  /// the ack, and the number of chunks and flag polls the runner (if any) made.
  static func send(
    payload: String, plan: @escaping BuddyRunnerPlan, transport: BuddyL2Tests.ScriptedTransport = BuddyL2Tests.ScriptedTransport()
  ) async throws -> (windows: [String], tapFile: Bool, ack: R4Ack?, posts: Int, polls: Int, logs: [String]) {
    let rig = try await BuddyL2Tests.engineRig(plan: plan)
    defer { try? FileManager.default.removeItem(at: rig.root) }
    let task = Task { try await rig.engine.run() }
    await rig.remote.push(BuddyL1Tests.command("c1", "consult_started", payload))
    try await R4Fixture.waitUntil { await rig.remote.acks.contains { $0.id == "c1" } }
    try await Task.sleep(nanoseconds: 200_000_000)
    let tapFile = BuddyL1Tests.tapFile(rig.root) != nil
    let windows = rig.presenter.all
    // End the consult, so a runner started by this payload is halted before the engine stops.
    await rig.remote.push(BuddyL1Tests.command("c2", "consult_ended", #"{"opaque_id":"opq_p"}"#))
    try await R4Fixture.waitUntil { await rig.remote.acks.contains { $0.id == "c2" } }
    let ack = await rig.remote.acks.first { $0.id == "c1" }
    task.cancel()
    try await task.value
    return (windows, tapFile, ack, transport.posted.count, transport.flagPollCount, rig.logs.all)
  }

  @Test func aWindowOpensOnlyOnAJSONTrueAndEveryOtherShapeIsNoWindowNoTapNoPage() async throws {
    // Without a config, so the only thing that can open a window is the payload.
    let shapes: [(payload: String, opens: Bool)] = [
      (#"{"opaque_id":"opq_p","window":true}"#, true),
      (#"{"opaque_id":"opq_p","window":true,"live":true}"#, true),
      (#"{"opaque_id":"opq_p","window":false}"#, false),
      (#"{"opaque_id":"opq_p"}"#, false),
      (#"{"opaque_id":"opq_p","window":null}"#, false),
      (#"{"opaque_id":"opq_p","window":"true"}"#, false),
      (#"{"opaque_id":"opq_p","window":1}"#, false),
      (#"{"opaque_id":"opq_p","window":"yes","live":true}"#, false),
      (#"{"opaque_id":"opq_p","live":true}"#, false),
    ]
    for shape in shapes {
      let result = try await Self.send(payload: shape.payload, plan: { nil })
      #expect(result.ack?.ok == true, "an unusable decision is acknowledged, never an error: \(shape.payload)")
      if shape.opens {
        #expect(result.windows == ["open:opq_p"], "window true opens: \(shape.payload)")
        #expect(result.posts == 0 && result.polls == 0, "and nothing is sent: \(shape.payload)")
      } else {
        #expect(result.windows.isEmpty, "no window call at all: \(shape.payload)")
        #expect(!result.tapFile, "no tap, so no page route: \(shape.payload)")
      }
    }
  }

  @Test func aStringOrNumberForLiveDoesNotStartARunner() async throws {
    let transport = BuddyL2Tests.ScriptedTransport()
    transport.setFlags(BuddyL2Tests.shadow)
    let tape = BuddyL2Tests.FakeTape()
    let plan: BuddyRunnerPlan = {
      { context in
        BuddyRunner(
          opaqueID: context.opaqueID, transport: transport, pcm: tape, window: context.window, transcript: context.transcript,
          clock: BuddyL2Tests.FakeClock(), log: { _ in })
      }
    }
    for live in [#""true""#, "1", "null", "false"] {
      let result = try await Self.send(
        payload: #"{"opaque_id":"opq_p","window":true,"live":\#(live)}"#, plan: plan, transport: transport)
      #expect(result.windows == ["open:opq_p"], "window true with a config but no live: the L1 window, live=\(live)")
      #expect(result.polls == 0 && result.posts == 0, "no runner, no polls, no chunks, live=\(live)")
    }
  }

  // MARK: - The controller

  @Test func shadowWithNoConfigHasZeroWindowsZeroPostsAndOneCountedLine() async throws {
    let c = try BuddyL2Tests.consult(flags: BuddyL2Tests.shadow, runner: false)
    defer { c.controller.shutdown() }
    defer { try? FileManager.default.removeItem(at: c.root) }
    #expect(c.controller.consultStarted(opaqueID: "opq_l3", buddyOff: false, window: false, live: true) == .noWindow)
    c.h.tape.growSeconds(26)
    try await Task.sleep(nanoseconds: 300_000_000)
    #expect(c.presenter.all.isEmpty, "0 windows")
    #expect(c.h.transport.posted.isEmpty && c.h.transport.flagPollCount == 0, "0 POSTs, 0 polls")
    #expect(!c.controller.isLive, "nothing is open, so nothing to close")
    #expect(BuddyL1Tests.tapFile(c.root) == nil, "no tap file")
    let counted = c.logs.all.filter { $0.hasPrefix(Self.noConfigPrefix) }
    #expect(counted == ["\(Self.noConfigPrefix)1 (opaque_id opq_l3)"], "exactly one counted line: \(c.logs.all)")
    // The next consult is the second count.
    #expect(c.controller.consultStarted(opaqueID: "opq_l3b", buddyOff: false, window: false, live: true) == .noWindow)
    #expect(c.logs.all.filter { $0.hasPrefix(Self.noConfigPrefix) }.last == "\(Self.noConfigPrefix)2 (opaque_id opq_l3b)")
    #expect(c.controller.consultEnded(opaqueID: "opq_l3") == .nothingOpen)
    #expect(c.presenter.all.isEmpty, "ending it closes nothing")
  }

  @Test func shadowWithAConfigPostsChunksAndOpensNoWindowAndServesNoPage() async throws {
    let c = try BuddyL2Tests.consult(flags: BuddyL2Tests.shadow)
    defer { c.controller.shutdown() }
    defer { try? FileManager.default.removeItem(at: c.root) }
    guard case .opened(let port) = c.controller.consultStarted(opaqueID: "opq_l3", buddyOff: false, window: false, live: true) else {
      Issue.record("not opened")
      return
    }
    try await R4Fixture.waitUntil { c.h.transport.flagPollCount >= 1 }
    try await R4Fixture.waitUntil { c.h.tape.offsetsAsked.count >= 1 }
    c.h.tape.growSeconds(14)
    try await R4Fixture.waitUntil { c.h.transport.posted.count >= 1 }
    #expect(c.h.transport.posted.count > 0, "POSTs > 0")
    #expect(c.presenter.all.isEmpty, "0 windows")
    #expect(BuddyL1Tests.get(port: Int(port), path: "/encounter/opq_l3")?.status == 404, "no page route")
    #expect(BuddyL1Tests.get(port: Int(port), path: "/encounter/opq_l3/state")?.status == 404, "no state route")
    #expect(!c.logs.all.contains { $0.hasPrefix(Self.noConfigPrefix) }, "a config was found: no counted line")
    _ = c.controller.consultEnded(opaqueID: "opq_l3")
  }

  @Test func aWindowTrueWithoutAConfigOpensTheL1WindowAndPostsNothing() async throws {
    let c = try BuddyL2Tests.consult(flags: BuddyL2Tests.live, runner: false)
    defer { c.controller.shutdown() }
    defer { try? FileManager.default.removeItem(at: c.root) }
    guard case .opened(let port) = c.controller.consultStarted(opaqueID: "opq_l3", buddyOff: false, window: true, live: true) else {
      Issue.record("not opened")
      return
    }
    #expect(c.presenter.all == ["open:opq_l3"], "an explicit true opens the L1 window at once")
    #expect(BuddyL1Tests.get(port: Int(port), path: "/encounter/opq_l3")?.status == 200)
    c.h.tape.growSeconds(26)
    try await Task.sleep(nanoseconds: 300_000_000)
    #expect(c.h.transport.posted.isEmpty && c.h.transport.flagPollCount == 0, "no POSTs")
    #expect(c.logs.all.filter { $0.hasPrefix(Self.noConfigPrefix) } == ["\(Self.noConfigPrefix)1 (opaque_id opq_l3)"], "live was true and nothing could run it")
    _ = c.controller.consultEnded(opaqueID: "opq_l3")
    #expect(c.presenter.all == ["open:opq_l3", "close:opq_l3"])
  }

  @Test func aWindowTrueWithoutLiveHasNoRunnerAndNoCountedLine() async throws {
    let c = try BuddyL2Tests.consult(flags: BuddyL2Tests.live, runner: true)
    defer { c.controller.shutdown() }
    defer { try? FileManager.default.removeItem(at: c.root) }
    _ = c.controller.consultStarted(opaqueID: "opq_l3", buddyOff: false, window: true, live: false)
    #expect(c.presenter.all == ["open:opq_l3"])
    try await Task.sleep(nanoseconds: 300_000_000)
    #expect(c.h.transport.posted.isEmpty && c.h.transport.flagPollCount == 0, "a config exists but live was not true: no runner")
    #expect(!c.logs.all.contains { $0.hasPrefix(Self.noConfigPrefix) }, "the line is for live consults only")
    _ = c.controller.consultEnded(opaqueID: "opq_l3")
  }

  @Test func aFlagsAnswerCannotOpenAWindowThePayloadDidNotAllow() async throws {
    // newcat says window true, the relay said window false: the payload wins, the window stays shut, chunks still go.
    let c = try BuddyL2Tests.consult(flags: BuddyL2Tests.live)
    defer { c.controller.shutdown() }
    defer { try? FileManager.default.removeItem(at: c.root) }
    guard case .opened(let port) = c.controller.consultStarted(opaqueID: "opq_l3", buddyOff: false, window: false, live: true) else {
      Issue.record("not opened")
      return
    }
    try await R4Fixture.waitUntil { c.h.transport.flagPollCount >= 1 }
    try await R4Fixture.waitUntil { c.logs.all.contains { $0.contains("window request refused") } }
    try await R4Fixture.waitUntil { c.h.tape.offsetsAsked.count >= 1 }
    c.h.tape.growSeconds(14)
    try await R4Fixture.waitUntil { c.h.transport.posted.count >= 1 }
    #expect(c.presenter.all.isEmpty, "0 windows")
    #expect(BuddyL1Tests.get(port: Int(port), path: "/encounter/opq_l3")?.status == 404, "page still disabled")
    _ = c.controller.consultEnded(opaqueID: "opq_l3")
  }

  @Test func aLiveWindowConsultWithAConfigStillOpensOnlyWhenBothAgree() async throws {
    let c = try BuddyL2Tests.consult(flags: BuddyL2Tests.live)
    defer { c.controller.shutdown() }
    defer { try? FileManager.default.removeItem(at: c.root) }
    _ = c.controller.consultStarted(opaqueID: "opq_l3", buddyOff: false, window: true, live: true)
    try await R4Fixture.waitUntil { c.presenter.all == ["open:opq_l3"] }
    _ = c.controller.consultEnded(opaqueID: "opq_l3")
    #expect(c.presenter.all == ["open:opq_l3", "close:opq_l3"])
  }

  @Test func theKillSwitchStillWinsOverAWindowTrue() {
    let c = try! BuddyL2Tests.consult(flags: BuddyL2Tests.live, runner: false)
    defer { c.controller.shutdown() }
    defer { try? FileManager.default.removeItem(at: c.root) }
    #expect(c.controller.consultStarted(opaqueID: "opq_l3", buddyOff: true, window: true, live: true) == .off)
    #expect(c.presenter.all.isEmpty)
  }

  // MARK: - The health field

  @Test func theConfigStatusIsAbsentUnusableOrOkAndTheFieldCarriesOnlyThatWord() throws {
    let root = R4Fixture.temporaryRoot()
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    #expect(BuddyRunnerConfig.status(root: root) == .absent)
    let url = root.appendingPathComponent(BuddyRunnerConfig.fileName)
    try Data(#"{"base":"http://c4:43124","key":"KEY-SECRET-1"}"#.utf8).write(to: url)
    chmod(url.path, 0o644)
    #expect(BuddyRunnerConfig.status(root: root) == .unusable, "readable by others")
    chmod(url.path, 0o600)
    #expect(BuddyRunnerConfig.status(root: root) == .ok)
    try Data(#"{"base":"http://c4:43124"}"#.utf8).write(to: url)
    chmod(url.path, 0o600)
    #expect(BuddyRunnerConfig.status(root: root) == .unusable, "no key")
    try Data("not json".utf8).write(to: url)
    chmod(url.path, 0o600)
    #expect(BuddyRunnerConfig.status(root: root) == .unusable, "unparseable")
    #expect(BuddyRunnerConfig.load(root: root) == nil, "load agrees with status")

    func items(_ fields: InstallPollFields) -> [String: String] {
      Dictionary(uniqueKeysWithValues: fields.queryItems().map { ($0.name, $0.value ?? "") })
    }
    let facts = R4AudioInputs.standard().facts(forUID: "device-a")
    var fields = InstallPollFields(installID: "install_x", facts: facts, tapeAdvancing: false)
    #expect(items(fields)["buddy_runner_config"] == nil, "absent when not measured")
    for word in ["ok", "absent", "unusable"] {
      fields.buddyRunnerConfig = word
      #expect(items(fields)["buddy_runner_config"] == word)
    }
    fields.buddyRunnerConfig = "/Users/x/buddy-runner.json KEY-SECRET-1"
    #expect(items(fields)["buddy_runner_config"] == nil, "nothing but the three words is ever sent")
  }

  @Test func theEngineReportsTheConfigStatusOnItsPoll() throws {
    // The poll fields are built where the engine reads `BuddyRunnerConfig.status(root:)`; pin that the call is there and
    // that the config path is the one path, `<room root>/buddy-runner.json`.
    let engine = try BuddyL1Tests.sourceWithoutComments("RoomEngine.swift")
    #expect(engine.contains("BuddyRunnerConfig.status(root: persistence.root)"))
    #expect(BuddyRunnerConfig.fileName == "buddy-runner.json")
  }

  @Test func noLogLineOfTheGateCarriesAKeyATokenOrText() async throws {
    let c = try BuddyL2Tests.consult(flags: BuddyL2Tests.shadow, runner: false)
    defer { c.controller.shutdown() }
    defer { try? FileManager.default.removeItem(at: c.root) }
    _ = c.controller.consultStarted(opaqueID: "opq_l3", buddyOff: false, window: false, live: true)
    _ = c.controller.consultStarted(opaqueID: "opq_l3", buddyOff: false, window: true, live: true)
    _ = c.controller.consultEnded(opaqueID: "opq_l3")
    for line in c.logs.all {
      #expect(!line.lowercased().contains("bearer") && !line.contains(String(repeating: "c", count: 64)), "no token: \(line)")
      #expect(line.hasPrefix("buddy runner: ") || line.hasPrefix("encounter buddy: "), "\(line)")
    }
  }

  // MARK: - Shadow + unusable config (F4)

  @Test func shadowWithUnusableConfigHasZeroWindowsZeroPostsAndNoTapFile_WellFormed0644() async throws {
    // A well-formed config file readable by others (0644) is unusable: the production plan refuses it, no runner starts.
    let server = try FakeRunnerServer()
    defer { server.stop() }
    server.respond(path: "/runner/v1/token", status: 200, body: #"{"token":"brt-f4","expires_in":900}"#)
    server.respond(path: "/runner/v1/flags", status: 200, body: #"{"window":false,"live":true,"reason_code":"fleet_off"}"#)
    server.respond(path: "/runner/v1/chunks", status: 200, body: #"{"seq":0}"#)
    let root = R4Fixture.temporaryRoot()
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let configURL = root.appendingPathComponent(BuddyRunnerConfig.fileName)
    try Data(#"{"base":"http://127.0.0.1:\#(server.port)","key":"KEY-SECRET-1"}"#.utf8).write(to: configURL)
    chmod(configURL.path, 0o644)
    #expect(BuddyRunnerConfig.status(root: root) == .unusable, "the file is 0644 so unusable")
    let logs = LockedList<String>()
    let presenter = BuddyL1Tests.SpyPresenter()
    let state = BuddyStateBox()
    state.set(.init(recording: true, micState: "authorized", pcmURL: nil, segmentID: nil))
    let plan = BuddyConsultController.filePlan(root: root, log: { logs.append($0) })
    let controller = BuddyConsultController(
      root: root, state: state, presenter: presenter, log: { logs.append($0) }, makeToken: { String(repeating: "c", count: 64) },
      runnerPlan: plan)
    defer { controller.shutdown() }
    #expect(controller.consultStarted(opaqueID: "opq_f4a", buddyOff: false, window: false, live: true) == .noWindow)
    try await Task.sleep(nanoseconds: 300_000_000)
    #expect(presenter.all.isEmpty, "0 windows")
    #expect(server.requests.filter { $0.line.hasPrefix("POST /runner/v1/chunks") }.isEmpty, "0 chunk POSTs to the real server")
    #expect(!controller.isLive, "nothing is open, so nothing to close")
    #expect(BuddyL1Tests.tapFile(root) == nil, "no tap file")
    let counted = logs.all.filter { $0.hasPrefix(Self.noConfigPrefix) }
    #expect(counted == ["\(Self.noConfigPrefix)1 (opaque_id opq_f4a)"], "exactly one counted line: \(logs.all)")
    #expect(logs.all.contains { $0.contains("readable by others") }, "the production load path logged the refusal: \(logs.all)")
    _ = controller.consultEnded(opaqueID: "opq_f4a")
  }

  @Test func shadowWithUnusableConfigHasZeroWindowsZeroPostsAndNoTapFile_Unparseable0600() async throws {
    // A 0600 file with unparseable JSON is unusable: the production plan refuses it, no runner starts.
    let server = try FakeRunnerServer()
    defer { server.stop() }
    server.respond(path: "/runner/v1/token", status: 200, body: #"{"token":"brt-f4","expires_in":900}"#)
    server.respond(path: "/runner/v1/flags", status: 200, body: #"{"window":false,"live":true,"reason_code":"fleet_off"}"#)
    server.respond(path: "/runner/v1/chunks", status: 200, body: #"{"seq":0}"#)
    let root = R4Fixture.temporaryRoot()
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let configURL = root.appendingPathComponent(BuddyRunnerConfig.fileName)
    try Data("not json".utf8).write(to: configURL)
    chmod(configURL.path, 0o600)
    #expect(BuddyRunnerConfig.status(root: root) == .unusable, "the file is 0600 but unparseable")
    let logs = LockedList<String>()
    let presenter = BuddyL1Tests.SpyPresenter()
    let state = BuddyStateBox()
    state.set(.init(recording: true, micState: "authorized", pcmURL: nil, segmentID: nil))
    let plan = BuddyConsultController.filePlan(root: root, log: { logs.append($0) })
    let controller = BuddyConsultController(
      root: root, state: state, presenter: presenter, log: { logs.append($0) }, makeToken: { String(repeating: "c", count: 64) },
      runnerPlan: plan)
    defer { controller.shutdown() }
    #expect(controller.consultStarted(opaqueID: "opq_f4b", buddyOff: false, window: false, live: true) == .noWindow)
    try await Task.sleep(nanoseconds: 300_000_000)
    #expect(presenter.all.isEmpty, "0 windows")
    #expect(server.requests.filter { $0.line.hasPrefix("POST /runner/v1/chunks") }.isEmpty, "0 chunk POSTs to the real server")
    #expect(!controller.isLive, "nothing is open, so nothing to close")
    #expect(BuddyL1Tests.tapFile(root) == nil, "no tap file")
    let counted = logs.all.filter { $0.hasPrefix(Self.noConfigPrefix) }
    #expect(counted == ["\(Self.noConfigPrefix)1 (opaque_id opq_f4b)"], "exactly one counted line: \(logs.all)")
    #expect(logs.all.contains { $0.contains("not usable") }, "the production load path logged the refusal: \(logs.all)")
    _ = controller.consultEnded(opaqueID: "opq_f4b")
  }

  @Test func shadowWithUnusableConfigHasZeroWindowsZeroPostsAndNoTapFile_TruncatedJSON0600() async throws {
    // A 0600 file with truncated JSON is unusable: the production plan refuses it, no runner starts.
    let server = try FakeRunnerServer()
    defer { server.stop() }
    server.respond(path: "/runner/v1/token", status: 200, body: #"{"token":"brt-f4","expires_in":900}"#)
    server.respond(path: "/runner/v1/flags", status: 200, body: #"{"window":false,"live":true,"reason_code":"fleet_off"}"#)
    server.respond(path: "/runner/v1/chunks", status: 200, body: #"{"seq":0}"#)
    let root = R4Fixture.temporaryRoot()
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let configURL = root.appendingPathComponent(BuddyRunnerConfig.fileName)
    try Data(#"{"base":"http://127.0.0.1:\#(server.port)","key":"KEY-SECR"#.utf8).write(to: configURL)
    chmod(configURL.path, 0o600)
    #expect(BuddyRunnerConfig.status(root: root) == .unusable, "the file is 0600 but truncated/unparseable")
    let logs = LockedList<String>()
    let presenter = BuddyL1Tests.SpyPresenter()
    let state = BuddyStateBox()
    state.set(.init(recording: true, micState: "authorized", pcmURL: nil, segmentID: nil))
    let plan = BuddyConsultController.filePlan(root: root, log: { logs.append($0) })
    let controller = BuddyConsultController(
      root: root, state: state, presenter: presenter, log: { logs.append($0) }, makeToken: { String(repeating: "c", count: 64) },
      runnerPlan: plan)
    defer { controller.shutdown() }
    #expect(controller.consultStarted(opaqueID: "opq_f4c", buddyOff: false, window: false, live: true) == .noWindow)
    try await Task.sleep(nanoseconds: 300_000_000)
    #expect(presenter.all.isEmpty, "0 windows")
    #expect(server.requests.filter { $0.line.hasPrefix("POST /runner/v1/chunks") }.isEmpty, "0 chunk POSTs to the real server")
    #expect(!controller.isLive, "nothing is open, so nothing to close")
    #expect(BuddyL1Tests.tapFile(root) == nil, "no tap file")
    let counted = logs.all.filter { $0.hasPrefix(Self.noConfigPrefix) }
    #expect(counted == ["\(Self.noConfigPrefix)1 (opaque_id opq_f4c)"], "exactly one counted line: \(logs.all)")
    #expect(logs.all.contains { $0.contains("not usable") }, "the production load path logged the refusal: \(logs.all)")
    _ = controller.consultEnded(opaqueID: "opq_f4c")
  }

  @Test func shadowWithUsable0600ConfigStartsARunnerAndPosts_PositiveControl() async throws {
    // A well-formed 0600 file with the production plan starts a runner. At minimum it polls flags. Proves the path is live.
    let server = try FakeRunnerServer()
    defer { server.stop() }
    server.respond(path: "/runner/v1/token", status: 200, body: #"{"token":"brt-f4","expires_in":900}"#)
    server.respond(path: "/runner/v1/flags", status: 200, body: #"{"window":false,"live":true,"reason_code":"fleet_off"}"#)
    server.respond(path: "/runner/v1/chunks", status: 200, body: #"{"seq":0}"#)
    let root = R4Fixture.temporaryRoot()
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let configURL = root.appendingPathComponent(BuddyRunnerConfig.fileName)
    try Data(#"{"base":"http://127.0.0.1:\#(server.port)","key":"KEY-SECRET-1"}"#.utf8).write(to: configURL)
    chmod(configURL.path, 0o600)
    #expect(BuddyRunnerConfig.status(root: root) == .ok, "the file is 0600 and well-formed: usable")
    let logs = LockedList<String>()
    let presenter = BuddyL1Tests.SpyPresenter()
    let state = BuddyStateBox()
    state.set(.init(recording: true, micState: "authorized", pcmURL: nil, segmentID: nil))
    let plan = BuddyConsultController.filePlan(root: root, log: { logs.append($0) })
    let controller = BuddyConsultController(
      root: root, state: state, presenter: presenter, log: { logs.append($0) }, makeToken: { String(repeating: "c", count: 64) },
      runnerPlan: plan)
    defer { controller.shutdown() }
    _ = controller.consultStarted(opaqueID: "opq_f4d", buddyOff: false, window: false, live: true)
    try await R4Fixture.waitUntil { server.requests.contains { $0.line.hasPrefix("GET /runner/v1/flags") } }
    #expect(presenter.all.isEmpty, "0 windows (shadow)")
    #expect(server.requests.contains { $0.line.hasPrefix("POST /runner/v1/token") }, "at least token request")
    #expect(server.requests.contains { $0.line.hasPrefix("GET /runner/v1/flags") }, "at least one flag poll")
    #expect(controller.isLive, "a runner is open")
    _ = controller.consultEnded(opaqueID: "opq_f4d")
  }
}
