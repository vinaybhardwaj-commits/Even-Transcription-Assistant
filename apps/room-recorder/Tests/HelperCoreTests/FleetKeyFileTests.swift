import Foundation
import Security
import Testing

@testable import FleetCore
@testable import RoomRecorderCore

// MARK: - 0.1.39.1: the fleet key lives in a file, and nothing waits on securityd

final class Reads: @unchecked Sendable {
  private let lock = NSLock()
  private var n = 0
  func bump() { lock.lock(); n += 1; lock.unlock() }
  var count: Int { lock.lock(); defer { lock.unlock() }; return n }
}

private func tempRoot() throws -> URL {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("fleet-key-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  return root
}

private func mode(_ url: URL) -> UInt16 {
  ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.posixPermissions] as? NSNumber)?.uint16Value ?? 0
}

@Suite(.serialized) struct FileFleetKeyStoreTests {
  let root: URL
  let lines = LogLines()
  let reads = Reads()

  init() throws { root = try tempRoot() }

  func store(
    uid: UInt32 = getuid(), deadline: TimeInterval = 5, _ reader: @escaping @Sendable () throws -> Data
  ) -> FileFleetKeyStore {
    let reads = self.reads, lines = self.lines
    return FileFleetKeyStore(
      root: root, keychainReader: { reads.bump(); return try reader() }, deadline: deadline, uid: uid, log: { lines.add($0) })
  }
  func gone() { try? FileManager.default.removeItem(at: root) }

  @Test func theFileIsWrittenAtMode600AndNothingIsLeftBeside() throws {
    defer { gone() }
    let s = store { throw FleetKeychainError.read(errSecItemNotFound) }
    let load = try s.loadWithOrigin()
    #expect(load.origin == .fresh)
    #expect(mode(s.url) == 0o600)
    let names = try FileManager.default.contentsOfDirectory(atPath: root.path)
    #expect(names == ["fleet-key.json"], "no .tmp left: \(names)")
  }

  @Test func aFilePresentMeansTheKeychainIsNeverTouched() throws {
    defer { gone() }
    let first = try store { throw FleetKeychainError.read(errSecItemNotFound) }.loadWithOrigin()
    let readsBefore = reads.count
    let again = store { Issue.record("the keychain was read"); throw FleetKeychainError.read(errSecItemNotFound) }
    let second = try again.loadWithOrigin()
    #expect(second.origin == .existing)
    #expect(reads.count == readsBefore + 0, "the second store never called its reader")
    #expect(second.key.publicKeyBase64 == first.key.publicKeyBase64)
  }

  @Test func aReadableItemIsMovedOnceAndNeverReadAgain() throws {
    defer { gone() }
    let seed = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    let s = store { seed }
    let moved = try s.loadWithOrigin()
    #expect(moved.origin == .existing)
    #expect(moved.key.publicKeyBase64 == (try FleetSigningKey(seed: seed)).publicKeyBase64)
    #expect(lines.all == ["fleet key: moved from keychain to file"])
    #expect(mode(s.url) == 0o600)
    _ = try s.loadWithOrigin()
    #expect(reads.count == 1, "the second load came from the file")
  }

  @Test func noItemMintsAFreshKeyIntoTheFile() throws {
    defer { gone() }
    let s = store { throw FleetKeychainError.read(errSecItemNotFound) }
    #expect(try s.loadWithOrigin().origin == .fresh)
    #expect(FileManager.default.fileExists(atPath: s.url.path))
  }

  @Test func anItemOnlyAPersonCanOpenGivesANewKeyAndSaysSo() throws {
    for status in [errSecInteractionNotAllowed, errSecAuthFailed, errSecInteractionRequired] {
      let root = try tempRoot(); defer { try? FileManager.default.removeItem(at: root) }
      let s = FileFleetKeyStore(root: root, keychainReader: { throw FleetKeychainError.read(status) }, log: { _ in })
      #expect(try s.loadWithOrigin().origin == .rotated(reason: String(status)))
      #expect(mode(s.url) == 0o600)
    }
  }

  @Test func noAnswerInTimeGivesANewKeyAndSaysTimeout() throws {
    defer { gone() }
    let never = DispatchSemaphore(value: 0)
    let s = store(deadline: 0.3) { never.wait(); return Data() }
    let started = Date()
    #expect(try s.loadWithOrigin().origin == .rotated(reason: "timeout"))
    #expect(Date().timeIntervalSince(started) < 3, "it gave up at the deadline, not later")
    never.signal()
  }

  @Test func anyOtherErrorMakesNoKeyAndWritesNoFile() throws {
    defer { gone() }
    let s = store { throw FleetKeychainError.read(-34018) }
    #expect(throws: FleetKeychainError.read(-34018)) { try s.loadWithOrigin() }
    #expect(!FileManager.default.fileExists(atPath: s.url.path))
  }

  @Test func aWrongModeWrongOwnerOrGarbageFileIsIgnoredLoggedAndReplaced() throws {
    defer { gone() }
    let good = try store { throw FleetKeychainError.read(errSecItemNotFound) }
    _ = try good.loadWithOrigin()

    try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o644)], ofItemAtPath: good.url.path)
    let r1 = try store { throw FleetKeychainError.read(errSecItemNotFound) }.loadWithOrigin()
    #expect(r1.origin == .rotated(reason: "file unusable"))
    #expect(lines.all.contains("ignoring fleet-key.json: its mode is 644, not 600"))
    #expect(mode(good.url) == 0o600, "the replacement is written at 600")

    let other = try store(uid: getuid() &+ 1) { throw FleetKeychainError.read(errSecItemNotFound) }.loadWithOrigin()
    #expect(other.origin == .rotated(reason: "file unusable"))
    #expect(lines.all.contains("ignoring fleet-key.json: it is owned by another user"))

    try Data("not json".utf8).write(to: good.url)
    try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o600)], ofItemAtPath: good.url.path)
    let r3 = try store { throw FleetKeychainError.read(errSecItemNotFound) }.loadWithOrigin()
    #expect(r3.origin == .rotated(reason: "file unusable"))
    #expect(lines.all.contains("ignoring fleet-key.json: it is not the JSON this app writes"))
  }
}

// MARK: - The client: a new key never signs for the old device, and nothing waits for ever

/// A store that answers with a fixed origin.
final class OriginKeys: FleetKeyStore, @unchecked Sendable {
  let origin: FleetKeyOrigin
  let key = FleetSigningKey.generate()
  init(_ origin: FleetKeyOrigin) { self.origin = origin }
  func loadOrCreate() throws -> FleetSigningKey { key }
  func loadWithOrigin() throws -> FleetKeyLoad { FleetKeyLoad(key: key, origin: origin) }
}

/// A store whose load never returns.
final class HangingKeys: FleetKeyStore, @unchecked Sendable {
  private let never = DispatchSemaphore(value: 0)
  private let reads = Reads()
  var loads: Int { reads.count }
  func loadOrCreate() throws -> FleetSigningKey { reads.bump(); never.wait(); throw FleetKeychainError.read(-1) }
  func release() { never.signal() }
}

final class Outcomes: @unchecked Sendable {
  var step: FleetPollStep?
  var kiosk: Bool?
  var tickets: Bool?
}

final class CountingFailingKeys: FleetKeyStore, @unchecked Sendable {
  private let reads = Reads()
  var loads: Int { reads.count }
  func loadOrCreate() throws -> FleetSigningKey { reads.bump(); throw FleetKeychainError.read(-34018) }
}

@Suite(.serialized) struct FleetClientKeyTests {
  private func seeded() -> MemoryState {
    let store = MemoryState()
    var state = FleetState()
    state.installID = "inst_1"
    state.deviceID = "dev_aaaaaaaaaaaaaaaaaaaaaaaa"
    store.save(state)
    return store
  }

  private func client(
    keys: FleetKeyStore, store: FleetStateStore, transport: FakeTransport, log: LogLines, sleeps: TaskBox,
    keyDeadline: TimeInterval = 0.3
  ) -> FleetClient {
    let server = TestServer()
    return FleetClient(
      config: FleetClientConfig(enabled: true, installID: "inst_1", machine: TestServer.machine, hwModel: "Macmini9,1", helperVersion: "0.2.4-h6"),
      transport: transport, keys: keys, store: store, executor: RecordingExecutor(),
      serverKeys: ["fk1": server.publicKey], roomSession: { "room-jwt" }, gates: { FleetGateState(sessionOpen: false) },
      clock: { TestServer.now }, sleep: { _ in sleeps.tick(limit: Int.max); try? await Task.sleep(nanoseconds: 5_000_000) },
      makeJTI: { UUID().uuidString.lowercased() }, log: { log.add($0) }, keyDeadline: keyDeadline)
  }

  private func pollReply() -> FleetResponse {
    let body = FleetJSON.object([
      "ok": .bool(true), "server_time": .string(TestServer.iso(TestServer.now)),
      "kill_switch": .object(["global": .bool(false)]), "commands": .array([]),
    ])
    return FleetResponse(status: 200, body: Data(body.canonical.utf8))
  }

  private func claims(of authorization: String?) -> [String: FleetJSON] {
    let token = String((authorization ?? "").dropFirst("Device ".count))
    let parts = token.split(separator: ".").map(String.init)
    guard parts.count == 3 else { return [:] }
    return (try? FleetJSON.parse(FleetB64.fromURL(parts[1]) ?? Data()))?.objectValue ?? [:]
  }

  @Test func aReplacedKeyDropsTheOldDeviceAndRegistersANewOne() async throws {
    let newID = "dev_bbbbbbbbbbbbbbbbbbbbbbbb"
    let polls = TaskBox()
    let reply = pollReply()
    let transport = FakeTransport { request in
      if request.path == "/api/fleet/register" {
        return FleetResponse(status: 201, body: Data("{\"ok\":true,\"device_id\":\"\(newID)\"}".utf8))
      }
      if request.path == "/api/fleet/poll" { polls.tick(limit: 2) }
      return reply
    }
    let log = LogLines()
    let state = seeded()
    let fleet = client(keys: OriginKeys(.rotated(reason: "-25308")), store: state, transport: transport, log: log, sleeps: TaskBox())
    let task = Task.detached { await fleet.run() }
    polls.set(task)
    let deadline = Date().addingTimeInterval(20)
    while polls.cycles < 2 && Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
    task.cancel(); await task.value

    #expect(transport.paths.first == "/api/fleet/register", "the first request registers; the old id signs nothing: \(transport.paths)")
    #expect(state.load().deviceID == newID, "the new id is on disk (fleet-state.json)")
    let signed = transport.requests.filter { $0.path == "/api/fleet/poll" }
    #expect(!signed.isEmpty)
    for request in signed { #expect(claims(of: request.headers["Authorization"])["iss"]?.stringValue == newID, "every poll is signed for the new device") }
    #expect(
      log.all.contains(
        "fleet key: keychain item unreadable (-25308), registered as new device bbbbbbbb; old device aaaaaaaa needs retiring"),
      "got \(log.all)")
  }

  @Test func aKeyThatIsTheSameKeepsTheDevice() async throws {
    let transport = FakeTransport { _ in pollReply() }
    let polls = TaskBox()
    let reply = pollReply()
    let t2 = FakeTransport { request in
      if request.path == "/api/fleet/poll" { polls.tick(limit: 2) }
      return reply
    }
    _ = transport
    let state = seeded()
    let fleet = client(keys: OriginKeys(.existing), store: state, transport: t2, log: LogLines(), sleeps: TaskBox())
    let task = Task.detached { await fleet.run() }
    polls.set(task)
    let deadline = Date().addingTimeInterval(20)
    while polls.cycles < 2 && Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
    task.cancel(); await task.value
    #expect(!t2.paths.contains("/api/fleet/register"))
    #expect(state.load().deviceID == "dev_aaaaaaaaaaaaaaaaaaaaaaaa")
  }

  @Test func aStoreThatNeverReturnsTimesOutEveryCallAndTheLoopKeepsRunning() async throws {
    let keys = HangingKeys()
    let transport = FakeTransport { _ in pollReply() }
    let log = LogLines()
    let sleeps = TaskBox()
    let fleet = client(keys: keys, store: seeded(), transport: transport, log: log, sleeps: sleeps)
    let task = Task.detached { await fleet.run() }
    sleeps.set(task)

    // Each call must come back by itself. A call that never does is a FAILED assertion here, not a hung run.
    let finished = TaskBox()
    let outcome = Outcomes()
    let calls = Task.detached {
      outcome.step = await fleet.pollOnce()
      finished.tick(limit: Int.max)
      outcome.kiosk = await fleet.postKioskHealth(Data("{}".utf8)) == nil
      finished.tick(limit: Int.max)
      outcome.tickets = await fleet.fetchStewardTickets(machine: "m") == nil
      finished.tick(limit: Int.max)
    }
    let limit = Date().addingTimeInterval(10)
    while finished.cycles < 3 && Date() < limit { try await Task.sleep(nanoseconds: 10_000_000) }
    guard finished.cycles == 3 else {
      Issue.record("a key load that never returns held the client: \(finished.cycles) of 3 calls came back")
      calls.cancel(); task.cancel(); keys.release()
      return
    }
    guard case .wait = outcome.step else { Issue.record("poll should back off, got \(String(describing: outcome.step))"); task.cancel(); keys.release(); return }
    #expect(outcome.kiosk == true && outcome.tickets == true)
    #expect(log.all.contains("fleet client: poll failed (FleetClient 1)"), "got \(log.all)")
    #expect(log.all.contains("fleet client: kiosk_health_post failed (FleetClient 1)"))

    // The loop is still cycling: it went round again after the timeouts, instead of sitting in the key read.
    let deadline = Date().addingTimeInterval(20)
    while sleeps.cycles < 3 && Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
    #expect(sleeps.cycles >= 3, "the loop kept running: \(sleeps.cycles) cycles")
    #expect(keys.loads == 1, "one stuck load, not one per retry")
    #expect(transport.requests.isEmpty)
    task.cancel()
    keys.release()
    await task.value
  }

  @Test func anErrorThatIsNotATimeoutIsSaidAndRetriedOnlyEveryFiveMinutes() async throws {
    let keys = CountingFailingKeys()
    let log = LogLines()
    let fleet = client(keys: keys, store: seeded(), transport: FakeTransport { _ in pollReply() }, log: log, sleeps: TaskBox())
    for _ in 0..<4 { _ = await fleet.pollOnce() }
    #expect(keys.loads == 1, "the store is asked again after 300 s, not on every pass")
    #expect(log.all.filter { $0.hasPrefix("fleet client stopped: key read failed") } == ["fleet client stopped: key read failed (FleetKeychain -34018)"])
    #expect(FleetClient.keyRetryInterval == 300)
  }
}
