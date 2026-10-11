import Foundation
import Testing

@testable import FleetCore
@testable import HelperCore
@testable import KioskHealthCore
@testable import RoomRecorderCore

// MARK: - 0.1.36 (#47): the kiosk-health events leave the Mac through the app

// ─── the XPC verbs ─────────────────────────────────────────────────────────────────────────

@Suite struct KioskCodecTests {
  @Test func bothVerbsRoundTrip() throws {
    for command in [HelperCommand.kioskBatch, .kioskReport(batchID: "boot-1:7..boot-1:9#3", status: 200, reason: "http 200", body: "{\"accepted\":3}")] {
      #expect(try HelperCodec.decode(try HelperCodec.encode(command)) == command)
    }
  }

  @Test func theReportIsBounded() throws {
    func report(id: String = "b1", status: Int = 200, reason: String = "ok", body: String = "") throws -> Data {
      try HelperCodec.encode(.kioskReport(batchID: id, status: status, reason: reason, body: body))
    }
    for bad in [
      try report(id: ""), try report(id: "has space"), try report(id: "../x"), try report(id: String(repeating: "a", count: 161)),
      try report(status: 600), try report(status: -1), try report(reason: "line\nbreak"), try report(reason: String(repeating: "r", count: 161)),
      try report(body: String(repeating: "b", count: 4_097)),
    ] {
      #expect(throws: HelperRefusal.badParams) { try HelperCodec.decode(bad) }
    }
    _ = try HelperCodec.decode(try report(body: String(repeating: "b", count: 4_096)))
  }
}

final class FakeKioskRelay: KioskRelay, @unchecked Sendable {
  var batch: (id: String, body: Data, count: Int)?
  private(set) var reports: [(String, Int, String)] = []
  func relayBatch() -> (id: String, body: Data, count: Int)? { batch }
  func relayReport(batchID: String, status: Int, body: Data, reason: String) -> String {
    reports.append((batchID, status, reason))
    return "sent"
  }
}

@Suite struct KioskServiceTests {
  func ask(_ service: HelperService, _ command: HelperCommand) throws -> HelperResponse {
    try #require(HelperResponse.decode(service.handle(try HelperCodec.encode(command))))
  }

  @Test func withoutAnEngineBothVerbsAreNotImplementedNotSilentlyOk() throws {
    let service = HelperService(safeMode: false)
    #expect(try ask(service, .kioskBatch).code == "not_implemented")
    #expect(try ask(service, .kioskReport(batchID: "b", status: 200, reason: "", body: "")).code == "not_implemented")
  }

  @Test func aBatchComesBackWithItsIdCountAndBody() throws {
    let kiosk = FakeKioskRelay()
    kiosk.batch = ("b-1", Data("{\"events\":[]}".utf8), 4)
    let reply = try ask(HelperService(safeMode: false, kiosk: kiosk), .kioskBatch)
    #expect(reply.ok && reply.detail["count"] == "4" && reply.detail["batch_id"] == "b-1" && reply.detail["body"] == "{\"events\":[]}")
    kiosk.batch = nil
    let none = try ask(HelperService(safeMode: false, kiosk: kiosk), .kioskBatch)
    #expect(none.ok && none.detail["count"] == "0" && none.detail["batch_id"] == nil)
  }

  @Test func aReportReachesTheEngineAndTheOutcomeComesBack() throws {
    let kiosk = FakeKioskRelay()
    let reply = try ask(HelperService(safeMode: false, kiosk: kiosk), .kioskReport(batchID: "b-1", status: 413, reason: "http 413", body: ""))
    #expect(reply.detail["outcome"] == "sent")
    #expect(kiosk.reports.map { "\($0.0):\($0.1)" } == ["b-1:413"])
  }
}

// ─── the relay ─────────────────────────────────────────────────────────────────────────────

final class FakeKioskLink: KioskHelperLink, @unchecked Sendable {
  private let lock = NSLock()
  var batches: [(id: String, body: Data, count: Int)?] = []
  private(set) var reports: [(id: String, status: Int, reason: String, body: String)] = []
  private(set) var asked = 0
  func batch() -> (id: String, body: Data, count: Int)? {
    lock.lock(); defer { lock.unlock() }
    asked += 1
    return batches.isEmpty ? (id: "", body: Data(), count: 0) : batches.removeFirst()
  }
  func report(batchID: String, status: Int, reason: String, body: String) -> Bool {
    lock.lock(); reports.append((batchID, status, reason, body)); lock.unlock()
    return true
  }
}

final class FakeKioskSink: KioskSinkPoster, @unchecked Sendable {
  private let lock = NSLock()
  var answers: [(status: Int, body: Data)?] = []
  private(set) var posted: [Data] = []
  func post(_ body: Data) async -> (status: Int, body: Data)? {
    lock.lock(); defer { lock.unlock() }
    posted.append(body)
    return answers.isEmpty ? (200, Data("{\"ok\":true,\"accepted\":1,\"duplicates\":0,\"rejected\":0}".utf8)) : answers.removeFirst()
  }
}

@Suite struct KioskRelayTests {
  let link = FakeKioskLink()
  let sink = FakeKioskSink()
  func relay() -> KioskHealthRelay { KioskHealthRelay(sink: sink, link: link, sleep: { _ in }) }
  func batch(_ n: Int) -> (id: String, body: Data, count: Int) { ("b\(n)", Data("{\"events\":[{\"n\":\(n)}]}".utf8), 1) }

  @Test func nothingToSendPostsNothing() async {
    #expect(await relay().passOnce() == .idle)
    #expect(sink.posted.isEmpty && link.reports.isEmpty)
  }

  @Test func aBatchIsPostedAsIsAndTheSinksReplyIsReportedCompactly() async {
    link.batches = [batch(1)]
    sink.answers = [(200, Data("{\"ok\":true,\"accepted\":1,\"duplicates\":2,\"rejected\":0,\"extra\":\"ignored\"}".utf8))]
    #expect(await relay().passOnce() == .sent(batches: 1))
    #expect(sink.posted == [batch(1).body], "the helper's bytes, untouched")
    #expect(link.reports.count == 1 && link.reports[0].id == "b1" && link.reports[0].status == 200)
    let reply = (try? JSONSerialization.jsonObject(with: Data(link.reports[0].body.utf8))) as? [String: Int]
    #expect(reply == ["accepted": 1, "duplicates": 2, "rejected": 0])
  }

  @Test func aBacklogIsDrainedInOnePassUpToTheLimit() async {
    link.batches = (1...20).map { batch($0) }
    #expect(await relay().passOnce() == .sent(batches: KioskHealthRelay.batchesPerPass))
    #expect(sink.posted.count == 8 && link.reports.count == 8)
  }

  @Test func noHttpAnswerIsReportedAsStatusZeroAndEndsThePass() async {
    link.batches = [batch(1), batch(2)]
    sink.answers = [nil]
    #expect(await relay().passOnce() == .stopped("offline"))
    #expect(link.reports.map { "\($0.status):\($0.reason)" } == ["0:offline"])
    #expect(sink.posted.count == 1, "the second batch was not tried")
  }

  @Test func a401And503EndThePassAfterTellingTheHelper() async {
    link.batches = [batch(1), batch(2)]
    sink.answers = [(401, Data())]
    #expect(await relay().passOnce() == .stopped("http_401"))
    #expect(link.reports.map(\.status) == [401])
    link.batches = [batch(3)]
    sink.answers = [(503, Data())]
    #expect(await relay().passOnce() == .stopped("http_503"))
  }

  @Test func a413And400AreTheHelpersToHandleAndThePassGoesOn() async {
    link.batches = [batch(1), batch(2)]
    sink.answers = [(413, Data()), (400, Data())]
    #expect(await relay().passOnce() == .sent(batches: 2))
    #expect(link.reports.map(\.status) == [413, 400])
  }

  @Test func anOlderHelperThatDoesNotKnowTheVerbIsAskedRarely() async {
    link.batches = [nil]
    #expect(await relay().passOnce() == .helperUnavailable)
    #expect(KioskHealthRelay.unsupportedInterval > KioskHealthRelay.interval)
  }

  @Test func theCompactReplyKeepsOnlyWhatTheHelperReadsAndEmptiesAnythingElse() {
    let long = String(repeating: "r", count: 400)
    let reply = KioskHealthRelay.compactReply(Data("{\"ok\":true,\"accepted\":0,\"duplicates\":0,\"rejected\":5,\"rejected_reasons\":[\"a\",\"b\",\"c\",\"d\",\"\(long)\"],\"secret\":\"x\"}".utf8))
    let parsed = (try? JSONSerialization.jsonObject(with: Data(reply.utf8))) as? [String: Any]
    #expect(parsed?["accepted"] as? Int == 0 && parsed?["rejected"] as? Int == 5 && parsed?["secret"] == nil)
    #expect((parsed?["rejected_reasons"] as? [String])?.count == 3)
    #expect(KioskHealthRelay.compactReply(Data("<html>portal</html>".utf8)) == "")
    #expect(KioskHealthRelay.compactReply(Data("{\"ok\":true}".utf8)) == "", "no accepted field, no reply")
    #expect(KioskHealthRelay.compactReply(Data()) == "")
  }
}

// ─── the whole road, through a real XPC connection ─────────────────────────────────────────

@Suite(.serialized) struct KioskThroughXPCTests {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent("kiosk-xpc-\(UUID().uuidString)")
  let listener = NSXPCListener.anonymous()
  let delegate: HelperListenerDelegate
  let engine: KioskHealthEngine

  init() throws {
    engine = try KioskHealthEngine(
      stateDir: dir.appendingPathComponent("spool").path, logPath: dir.appendingPathComponent("k.log").path,
      files: UnprivilegedUserFiles(), legacyConfigPath: dir.appendingPathComponent("none.json").path)
    delegate = HelperListenerDelegate(service: HelperService(safeMode: false, kiosk: engine), requirement: Loopback.ownRequirement)
    listener.delegate = delegate
    listener.resume()
  }

  func link() -> HelperKioskLink {
    let endpoint = listener.endpoint
    return HelperKioskLink(helper: { HelperClient(endpoint: endpoint, requirement: Loopback.ownRequirement) })
  }
  func tearDown() { listener.invalidate(); try? FileManager.default.removeItem(at: dir) }

  @Test func eventsGoFromTheEngineThroughXPCToTheSinkAndAreAckedOnlyAfterA200() async throws {
    defer { tearDown() }
    for i in 0..<5 { engine.emit(kind: "drift", payload: ["i": i]) }
    let sink = FakeKioskSink()
    sink.answers = [(503, Data())]
    let relay = KioskHealthRelay(sink: sink, link: link(), sleep: { _ in })
    #expect(await relay.passOnce() == .stopped("http_503"))
    #expect(engine.spoolDepth == 5, "a 503 deletes nothing")
    let body = try #require(sink.posted.first)
    let sent = (try JSONSerialization.jsonObject(with: body) as? [String: Any])?["events"] as? [[String: Any]]
    #expect(sent?.count == 5 && sent?.allSatisfy { $0["source"] as? String == "helper" } == true)
  }

  @Test func aLaterGoodAnswerAcksAndTheSpoolEmpties() async throws {
    defer { tearDown() }
    engine.emit(kind: "drift", payload: ["i": 1])
    let sink = FakeKioskSink()
    sink.answers = [(200, Data("{\"ok\":true,\"accepted\":1,\"duplicates\":0,\"rejected\":0}".utf8))]
    let relay = KioskHealthRelay(sink: sink, link: link(), sleep: { _ in })
    #expect(await relay.passOnce() == .sent(batches: 1))
    #expect(engine.spoolDepth == 0)
  }

  @Test func theHelperIsTheOneThatHalvesAOversizedBatch() async throws {
    defer { tearDown() }
    for i in 0..<6 { engine.emit(kind: "drift", payload: ["i": i]) }
    let sink = FakeKioskSink()
    sink.answers = [(413, Data()), (200, Data("{\"ok\":true,\"accepted\":3,\"duplicates\":0,\"rejected\":0}".utf8))]
    let relay = KioskHealthRelay(sink: sink, link: link(), sleep: { _ in })
    _ = await relay.passOnce()
    let counts = sink.posted.map { ((try? JSONSerialization.jsonObject(with: $0)) as? [String: Any])?["events"].flatMap { $0 as? [Any] }?.count ?? -1 }
    #expect(counts == [6, 3, 3], "6 refused, then 3 and the other 3: the helper chose the sizes, the app only posted \(counts)")
    #expect(engine.spoolDepth == 0, "and everything was delivered in the end")
  }
}

// ─── the fleet client's one extra route ────────────────────────────────────────────────────

@Suite struct KioskSinkPostTests {
  @Test func itPostsToTheKioskHealthRouteAsTheDeviceWithAFreshTokenEachTime() async throws {
    let r = Rig { _, _ in FleetResponse(status: 200, body: Data("{\"accepted\":1}".utf8)) }
    let first = await r.client.postKioskHealth(Data("{\"events\":[]}".utf8))
    #expect(first?.status == 200)
    _ = await r.client.postKioskHealth(Data("{\"events\":[]}".utf8))
    let sent = r.transport.requests.filter { $0.path == "/api/kiosk-health" }
    #expect(sent.count == 2 && sent.allSatisfy { $0.method == "POST" && $0.body == Data("{\"events\":[]}".utf8) })
    let tokens = sent.map { $0.headers["Authorization"] ?? "" }
    #expect(tokens.allSatisfy { $0.hasPrefix("Device ") } && Set(tokens).count == 2, "a new token for each post")
  }

  @Test func aDeviceThatIsNotEnrolledPostsNothing() async {
    let r = Rig(withDevice: false) { _, _ in FleetResponse(status: 200, body: Data()) }
    #expect(await r.client.postKioskHealth(Data("{}".utf8)) == nil)
    #expect(r.transport.requests.isEmpty)
  }

  @Test func aDisabledClientPostsNothing() async {
    let r = Rig(enabled: false) { _, _ in FleetResponse(status: 200, body: Data()) }
    #expect(await r.client.postKioskHealth(Data("{}".utf8)) == nil)
    #expect(r.transport.requests.isEmpty)
  }

  @Test func aNetworkErrorIsNilNotACrash() async {
    let r = Rig { _, _ in throw URLError(.notConnectedToInternet) }
    #expect(await r.client.postKioskHealth(Data("{}".utf8)) == nil)
  }

  @Test func theRouteIsFixed_noCallerCanChooseAnotherPath() throws {
    #expect(FleetClient.kioskHealthPath == "/api/kiosk-health")
    let source = try String(
      contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Sources/FleetCore/FleetClient.swift"), encoding: .utf8)
    #expect(source.contains("public func postKioskHealth(_ body: Data"), "the signature takes a body and no path")
  }
}
