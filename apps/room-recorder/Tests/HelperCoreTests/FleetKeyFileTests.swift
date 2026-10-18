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
      root: root, keychainReader: { reads.bump(); return try reader() }, deadline: deadline, uid: uid, currentDeviceID: { nil }, log: { lines.add($0) })
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
      let s = FileFleetKeyStore(root: root, keychainReader: { throw FleetKeychainError.read(status) }, currentDeviceID: { nil }, log: { _ in })
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

  @Test func theRotationIsRecordedInTheSameWriteAsTheKey() throws {
    defer { gone() }
    let s = FileFleetKeyStore(
      root: root, keychainReader: { throw FleetKeychainError.read(errSecInteractionNotAllowed) },
      currentDeviceID: { "dev_aaaaaaaaaaaaaaaaaaaaaaaa" }, log: { _ in })
    let load = try s.loadWithOrigin()
    #expect(load.replacesDeviceID == "dev_aaaaaaaaaaaaaaaaaaaaaaaa")
    let json = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: s.url)) as? [String: Any])
    #expect(json["origin"] as? String == "rotated")
    #expect(json["replaces_device_id"] as? String == "dev_aaaaaaaaaaaaaaaaaaaaaaaa")
    // A later process reads it back without the keychain: same key, same record.
    let again = try FileFleetKeyStore(root: root, keychainReader: { Issue.record("keychain read"); throw FleetKeychainError.read(-1) }, currentDeviceID: { nil }, log: { _ in }).loadWithOrigin()
    #expect(again.origin == .existing && again.replacesDeviceID == "dev_aaaaaaaaaaaaaaaaaaaaaaaa")
    #expect(again.key.publicKeyBase64 == load.key.publicKeyBase64)
  }

  @Test func withNothingToReplaceTheRecordSaysNullNotAbsent() throws {
    defer { gone() }
    let s = store { throw FleetKeychainError.read(errSecItemNotFound) }
    _ = try s.loadWithOrigin()
    let json = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: s.url)) as? [String: Any])
    #expect(json["origin"] as? String == "fresh")
    #expect(json.keys.contains("replaces_device_id") && json["replaces_device_id"] is NSNull)
  }
}

// MARK: - The non-interactive keychain read is pinned

final class InteractionLog: @unchecked Sendable {
  private let lock = NSLock()
  private(set) var events: [String] = []
  private var allowed = true
  func add(_ e: String) { lock.lock(); events.append(e); lock.unlock() }
  var allowedNow: Bool { lock.lock(); defer { lock.unlock() }; return allowed }
  func set(_ v: Bool) { lock.lock(); allowed = v; events.append("allow(\(v))"); lock.unlock() }
}

@Suite struct NonInteractiveReadTests {
  @Test func theQueryAsksTheKeychainNeverToPromptAndReturnsOnlyTheSeed() {
    let q = KeychainFleetKeyStore.nonInteractiveReadQuery(service: "svc", account: "acct")
    #expect(q[kSecUseAuthenticationUI as String] as? String == kSecUseAuthenticationUIFail as String)
    #expect(q[kSecReturnData as String] as? Bool == true)
    #expect(q[kSecMatchLimit as String] as? String == kSecMatchLimitOne as String)
    #expect(q[kSecAttrService as String] as? String == "svc" && q[kSecAttrAccount as String] as? String == "acct")
  }

  @Test func theReadSwitchesInteractionOffForTheCallAndRestoresIt() throws {
    let log = InteractionLog()
    let interaction = KeychainInteraction(current: { true }, allow: { log.set($0) })
    var sawAllowedDuringCall: Bool?
    let seed = Data(repeating: 7, count: 32)
    let data = try KeychainFleetKeyStore.readSeed(service: "s", account: "a", interaction: interaction) { query, item in
      sawAllowedDuringCall = log.allowedNow
      #expect(query[kSecUseAuthenticationUI as String] as? String == kSecUseAuthenticationUIFail as String)
      item = seed as CFData
      return errSecSuccess
    }
    #expect(data == seed)
    #expect(sawAllowedDuringCall == false, "interaction was off while the keychain was asked")
    #expect(log.events == ["allow(false)", "allow(true)"], "off, then restored: \(log.events)")
  }

  @Test func anErrorStillRestoresTheSetting() {
    let log = InteractionLog()
    let interaction = KeychainInteraction(current: { true }, allow: { log.set($0) })
    #expect(throws: FleetKeychainError.read(errSecInteractionNotAllowed)) {
      try KeychainFleetKeyStore.readSeed(service: "s", account: "a", interaction: interaction) { _, _ in errSecInteractionNotAllowed }
    }
    #expect(log.events == ["allow(false)", "allow(true)"])
  }

  @Test func ifTheSettingCannotBeReadItIsLeftOffNotGuessedOn() {
    let log = InteractionLog()
    let interaction = KeychainInteraction(current: { nil }, allow: { log.set($0) })
    _ = try? KeychainFleetKeyStore.readSeed(service: "s", account: "a", interaction: interaction) { _, _ in errSecItemNotFound }
    #expect(log.events == ["allow(false)"])
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
    keyDeadline: TimeInterval = 0.3, onSleep: @escaping @Sendable (TimeInterval) -> Void = { _ in },
    clock: @escaping @Sendable () -> Date = { TestServer.now }, jitter: @escaping @Sendable () -> Double = { 0 }
  ) -> FleetClient {
    let server = TestServer()
    return FleetClient(
      config: FleetClientConfig(enabled: true, installID: "inst_1", machine: TestServer.machine, hwModel: "Macmini9,1", helperVersion: "0.2.4-h6"),
      transport: transport, keys: keys, store: store, executor: RecordingExecutor(),
      serverKeys: ["fk1": server.publicKey], roomSession: { "room-jwt" }, gates: { FleetGateState(sessionOpen: false) },
      clock: clock, sleep: { onSleep($0); sleeps.tick(limit: Int.max); try? await Task.sleep(nanoseconds: 5_000_000) },
      makeJTI: { UUID().uuidString.lowercased() }, log: { log.add($0) }, keyDeadline: keyDeadline, rekeyJitter: jitter)
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

  // ── 0.1.40 R2: a refused register after a rotation is a wait, not a stop ───────────────────

  final class Rekey: @unchecked Sendable {
    private let lock = NSLock()
    private var open = false
    var accepting: Bool { lock.lock(); defer { lock.unlock() }; return open }
    func accept() { lock.lock(); open = true; lock.unlock() }
  }
  final class Sleeps: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var values: [TimeInterval] = []
    func add(_ v: TimeInterval) { lock.lock(); values.append(v); lock.unlock() }
  }

  @Test(arguments: ["KEY_CONFLICT", "REVOKED"]) func aRefusedRegisterAfterARotationWaitsAndPicksUpTheReKeyWithoutARestart(code: String) async throws {
    let newID = "dev_bbbbbbbbbbbbbbbbbbbbbbbb"
    let rekey = Rekey()
    let polls = TaskBox()
    let reply = pollReply()
    let transport = FakeTransport { request in
      if request.path == "/api/fleet/register" {
        return rekey.accepting
          ? FleetResponse(status: 201, body: Data("{\"ok\":true,\"device_id\":\"\(newID)\"}".utf8))
          : FleetResponse(status: 409, body: Data("{\"error\":\"\(code)\"}".utf8))
      }
      if request.path == "/api/fleet/poll" { polls.tick(limit: 2) }
      return reply
    }
    let log = LogLines(), sleeps = Sleeps(), cycles = TaskBox()
    let state = seeded()
    let keys = OriginKeys(.rotated(reason: "-25308"))
    let fleet = client(keys: keys, store: state, transport: transport, log: log, sleeps: cycles, onSleep: { sleeps.add($0) })
    let task = Task.detached { await fleet.run() }
    polls.set(task)

    let deadline = Date().addingTimeInterval(20)
    while cycles.cycles < 3 && Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
    #expect(cycles.cycles >= 3, "it kept asking")
    #expect(sleeps.values.prefix(3).allSatisfy { $0 == 900 }, "every wait is 900 s (jitter fixed at 0 here): \(sleeps.values)")
    #expect(transport.paths.allSatisfy { $0 == "/api/fleet/register" }, "no poll without a device id: \(transport.paths)")
    #expect(state.load().stoppedReason == nil, "nothing persisted as a stop")
    let fingerprint = String(keys.key.publicKeySHA256B64URL.prefix(12))
    #expect(
      log.all.filter { $0.hasPrefix("fleet client: register refused") }
        == ["fleet client: register refused (\(code)) after key rotation; key fp \(fingerprint); waiting for operator re-key, retry every ~900 s"],
      "said once: \(log.all)")
    #expect(await fleet.postKioskHealth(Data("{}".utf8)) == nil, "kiosk-health posts stay off")

    rekey.accept()  // the operator re-keys; no restart
    while polls.cycles < 2 && Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
    task.cancel(); await task.value
    #expect(state.load().deviceID == newID && state.load().stoppedReason == nil)
    #expect(transport.paths.filter { $0 == "/api/fleet/poll" }.count >= 2, "it polls as the new device")
  }

  /// 0.1.41 FU-RR0140-1(b). The flag meant "the server is waiting for an operator re-key". Once a register succeeds that
  /// is no longer true, so it is cleared; a refused register before that keeps it.
  @Test func aSuccessfulRegisterClearsTheRotationWait() async throws {
    let newID = "dev_bbbbbbbbbbbbbbbbbbbbbbbb"
    let rekey = Rekey()
    let transport = FakeTransport { _ in
      rekey.accepting
        ? FleetResponse(status: 201, body: Data("{\"ok\":true,\"device_id\":\"\(newID)\"}".utf8))
        : FleetResponse(status: 409, body: Data("{\"error\":\"KEY_CONFLICT\"}".utf8))
    }
    let store = MemoryState()
    var initial = FleetState(); initial.installID = "inst_1"; store.save(initial)
    let fleet = client(
      keys: OriginKeys(.rotated(reason: "-25308")), store: store, transport: transport, log: LogLines(), sleeps: TaskBox())
    _ = await fleet.registerIfNeeded()
    #expect(await fleet.afterRotation, "a refused register after a rotation keeps the wait")
    rekey.accept()
    _ = await fleet.registerIfNeeded()
    #expect(store.load().deviceID == newID)
    #expect(await fleet.afterRotation == false, "cleared by the successful register")
  }

  @Test func theRefusedLineIsAtMostOncePerHourCarriesOnlyTheFingerprintAndTheWaitIsJittered() async throws {
    let transport = FakeTransport { _ in FleetResponse(status: 409, body: Data("{\"error\":\"KEY_CONFLICT\"}".utf8)) }
    let keys = OriginKeys(.rotated(reason: "-25308"))
    let clock = ClockBox()
    let log = LogLines()
    let draws = Sleeps()
    let bare = MemoryState()  // the old id is already gone (dropped by an earlier start); only the rotation is known
    var initial = FleetState(); initial.installID = "inst_1"; bare.save(initial)
    let fleet = client(
      keys: keys, store: bare, transport: transport, log: log, sleeps: TaskBox(), clock: { clock.value },
      jitter: { let j = [-0.1, 0.0, 0.1].randomElement()!; draws.add(j); return j })

    // Fifty retries in one instant: one line.
    var waits: [TimeInterval] = []
    for _ in 0..<50 { if case .wait(let w) = await fleet.registerIfNeeded() { waits.append(w) } }
    #expect(log.all.filter { $0.hasPrefix("fleet client: register refused") }.count == 1)
    // Then twenty retries ten minutes apart (200 minutes): lines at 0, 60, 120 and 180 minutes at most.
    for _ in 0..<20 { clock.advance(by: 600); if case .wait(let w) = await fleet.registerIfNeeded() { waits.append(w) } }
    let lines = log.all.filter { $0.hasPrefix("fleet client: register refused") }
    #expect(lines.count == 4, "one an hour, not one a retry: \(lines.count)")

    // The wait is 900 s +-10 %, and it does vary.
    #expect(waits.allSatisfy { $0 >= 810 - 0.001 && $0 <= 990 + 0.001 }, "waits: \(Set(waits).sorted()) count \(waits.count)")
    #expect(Set(waits).count > 1)
    // The line carries the 12-character hash prefix and nothing of the key.
    let full = keys.key.publicKeySHA256B64URL
    let prefix = String(full.prefix(12))
    let all = log.all.joined(separator: "\n")
    #expect(lines.allSatisfy { $0.contains("key fp \(prefix);") })
    #expect(!all.contains(full), "not even the whole hash")
    #expect(!all.contains(keys.key.publicKeyBase64), "never the public key")
    #expect(!all.contains(keys.key.seed.base64EncodedString()), "never the seed")
  }

  @Test func aKeyConflictWithNoRotationStillStopsAndSaysSo() async {
    let transport = FakeTransport { _ in FleetResponse(status: 409, body: Data("{\"error\":\"KEY_CONFLICT\"}".utf8)) }
    let log = LogLines()
    let state = MemoryState()
    var initial = FleetState(); initial.installID = "inst_1"; state.save(initial)  // no device id yet: a first registration
    let fleet = client(keys: OriginKeys(.existing), store: state, transport: transport, log: log, sleeps: TaskBox())
    await fleet.run()
    #expect(log.all.last == "fleet client stopped: register_key_conflict")
    #expect(state.load().stoppedReason == "register_key_conflict")
  }

  @Test func aStopPersistedByTheFirstBuildIsClearedOnTheFirstStart() async throws {
    let state = seeded()
    var stopped = state.load(); stopped.stoppedReason = "register_key_conflict"; state.save(stopped)
    let polls = TaskBox()
    let reply = pollReply()
    let transport = FakeTransport { request in
      if request.path == "/api/fleet/poll" { polls.tick(limit: 2) }
      return reply
    }
    let fleet = client(keys: OriginKeys(.existing), store: state, transport: transport, log: LogLines(), sleeps: TaskBox())
    let task = Task.detached { await fleet.run() }
    polls.set(task)
    let deadline = Date().addingTimeInterval(20)
    while polls.cycles < 2 && Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
    task.cancel(); await task.value
    #expect(state.load().stoppedReason == nil)
    #expect(transport.paths.filter { $0 == "/api/fleet/poll" }.count >= 2)
  }

  // ── Probe P2: the client gives up before the store rotates ─────────────────────────────────

  @Test func aRotationThatLandsAfterTheClientGaveUpNeverSignsForTheOldDevice() async throws {
    let root = try tempRoot(); defer { try? FileManager.default.removeItem(at: root) }
    let oldID = "dev_aaaaaaaaaaaaaaaaaaaaaaaa", newID = "dev_bbbbbbbbbbbbbbbbbbbbbbbb"
    let hang = DispatchSemaphore(value: 0)
    let state = seeded()
    // The keychain read never returns; the STORE gives up at 0.6 s and rotates, AFTER the client's 0.2 s deadline.
    let store = FileFleetKeyStore(
      root: root, keychainReader: { hang.wait(); return Data() }, deadline: 0.6,
      currentDeviceID: { state.load().deviceID }, log: { _ in })
    let reply = pollReply()
    let transport = FakeTransport { request in
      request.path == "/api/fleet/register"
        ? FleetResponse(status: 201, body: Data("{\"ok\":true,\"device_id\":\"\(newID)\"}".utf8)) : reply
    }
    let fleet = client(keys: store, store: state, transport: transport, log: LogLines(), sleeps: TaskBox(), keyDeadline: 0.2)

    let first = await fleet.pollOnce()
    guard case .wait = first else { Issue.record("the first poll should time out, got \(first)"); hang.signal(); return }
    #expect(transport.requests.isEmpty)
    // Wait for the store to finish rotating in the background.
    let deadline = Date().addingTimeInterval(10)
    while !FileManager.default.fileExists(atPath: store.url.path) && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
    try await Task.sleep(nanoseconds: 200_000_000)

    for _ in 0..<4 { _ = await fleet.pollOnce(); _ = await fleet.registerIfNeeded() }
    let issuers = transport.requests.filter { $0.path == "/api/fleet/poll" }.map { claims(of: $0.headers["Authorization"])["iss"]?.stringValue }
    #expect(!issuers.contains(oldID), "nothing was signed for the old id: \(issuers)")
    #expect(transport.paths.first == "/api/fleet/register", "the first request registers: \(transport.paths)")
    #expect(state.load().deviceID == newID)
    hang.signal()
  }
}
