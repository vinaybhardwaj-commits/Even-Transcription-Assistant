import Foundation
import Testing

@testable import FleetCore
@testable import HelperCore
@testable import KioskHealthCore
@testable import RoomRecorderCore

// MARK: - 0.2.4-h7: the kiosk-health relay and the fleet poll keep cycling

/// A helper-side relay that has a batch for every cycle, the way a live engine does once its collectors keep emitting.
final class CyclingRelay: KioskRelay, @unchecked Sendable {
  private let lock = NSLock()
  private(set) var handedOut = 0
  private(set) var answered: [String] = []
  func relayBatch() -> (id: String, body: Data, count: Int)? {
    lock.lock(); defer { lock.unlock() }
    handedOut += 1
    return ("b-\(handedOut)", Data("{\"events\":[{\"n\":\(handedOut)}]}".utf8), 1)
  }
  func relayReport(batchID: String, status: Int, body: Data, reason: String) -> String {
    lock.lock(); answered.append(batchID); lock.unlock()
    return "sent"
  }
}

final class TaskBox: @unchecked Sendable {
  private let lock = NSLock()
  private var task: Task<Void, Never>?
  private var count = 0
  func set(_ task: Task<Void, Never>) { lock.lock(); self.task = task; lock.unlock() }
  /// Counts one cycle; cancels the loop when `limit` have gone by.
  @discardableResult func tick(limit: Int) -> Int {
    lock.lock(); count += 1; let n = count; let t = task; lock.unlock()
    if n >= limit { t?.cancel() }
    return n
  }
  var cycles: Int { lock.lock(); defer { lock.unlock() }; return count }
}

@Suite(.serialized) struct HelperLoopsTests {
  private func pollReply() -> FleetResponse {
    let body = FleetJSON.object([
      "ok": .bool(true), "server_time": .string(TestServer.iso(TestServer.now)),
      "kill_switch": .object(["global": .bool(false)]), "commands": .array([]),
    ])
    return FleetResponse(status: 200, body: Data(body.canonical.utf8))
  }

  @Test func theRelayPostsOnEveryCycleAndTheFleetClientPollsOnEveryCycleThroughHellosMidCycle() async throws {
    let listener = NSXPCListener.anonymous()
    let relayEngine = CyclingRelay()
    let delegate = HelperListenerDelegate(
      service: HelperService(safeMode: false, kiosk: relayEngine), requirement: Loopback.ownRequirement)
    listener.delegate = delegate
    listener.resume()
    defer { listener.invalidate() }
    let endpoint = listener.endpoint
    func helper() -> HelperClient { HelperClient(endpoint: endpoint, requirement: Loopback.ownRequirement) }

    // The fleet client, over a fake HTTP, with the real device poll shape.
    let polls = TaskBox()
    let reply = pollReply()
    let rig = Rig { request, _ in
      if request.path == "/api/fleet/poll" { polls.tick(limit: 5) }
      return request.path == "/api/fleet/poll" ? reply : FleetResponse(status: 200, body: Data("{\"accepted\":1}".utf8))
    }

    // The relay: its sink is that same client; its sleep is the cycle clock. A hello goes out in the middle of every cycle.
    let cycles = TaskBox()
    let hellos = HelloTally()
    let relay = KioskHealthRelay(
      sink: rig.client, link: HelperKioskLink(helper: { helper() }),
      sleep: { _ in
        cycles.tick(limit: 5)
        hellos.record(helper().hello(timeout: 5)?.ok == true)
        await Task.yield()
      })

    let relayTask = Task.detached { await relay.run() }
    cycles.set(relayTask)
    let fleetTask = Task.detached { await rig.client.run() }
    polls.set(fleetTask)

    // Bounded wait: both loops must finish their five cycles on their own.
    let deadline = Date().addingTimeInterval(30)
    while (cycles.cycles < 5 || polls.cycles < 5) && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
    relayTask.cancel(); fleetTask.cancel()
    await relayTask.value; await fleetTask.value

    let posts = rig.transport.requests.filter { $0.path == "/api/kiosk-health" }.count
    let pollCount = rig.transport.requests.filter { $0.path == "/api/fleet/poll" }.count
    #expect(posts >= 3, "kiosk-health posts: \(posts)")
    #expect(pollCount >= 3, "fleet polls: \(pollCount)")
    #expect(relayEngine.answered.count >= 3, "the helper was told the sink's answer each time")
    #expect(hellos.okCount >= 3, "hellos answered while both loops ran: \(hellos.okCount)")
  }
}

// MARK: - The OPD 6 shape: enrolled, state on disk, the key store refusing

/// Fails like a locked or unavailable login keychain until `heal()`.
final class FlakyKeys: FleetKeyStore, @unchecked Sendable {
  private let lock = NSLock()
  private var healed = false
  private let real = MemoryKeys()
  func heal() { lock.lock(); healed = true; lock.unlock() }
  func loadOrCreate() throws -> FleetSigningKey {
    lock.lock(); let ok = healed; lock.unlock()
    if !ok { throw FleetKeychainError.read(-25308) }
    return try real.loadOrCreate()
  }
}

final class ClockBox: @unchecked Sendable {
  private let lock = NSLock()
  private var date = TestServer.now
  var value: Date { lock.lock(); defer { lock.unlock() }; return date }
  func advance(by seconds: TimeInterval) { lock.lock(); date = date.addingTimeInterval(seconds); lock.unlock() }
}

final class LogLines: @unchecked Sendable {
  private let lock = NSLock()
  private var lines: [String] = []
  func add(_ l: String) { lock.lock(); lines.append(l); lock.unlock() }
  var all: [String] { lock.lock(); defer { lock.unlock() }; return lines }
}

@Suite(.serialized) struct FleetClientStartupFromOPD6StateTests {
  /// fleet-state.json as OPD 6 has it: a device id and an install id, nothing stopped, no results waiting.
  private func seeded() -> MemoryState {
    let store = MemoryState()
    var state = FleetState()
    state.installID = "inst_1"
    state.deviceID = TestServer.deviceID
    store.save(state)
    return store
  }

  private func client(
    keys: FleetKeyStore, store: FleetStateStore, transport: FakeTransport, log: LogLines, sleeps: TaskBox,
    clock: @escaping @Sendable () -> Date = { TestServer.now }
  ) -> FleetClient {
    let server = TestServer()
    return FleetClient(
      config: FleetClientConfig(enabled: true, installID: "inst_1", machine: TestServer.machine, hwModel: "Macmini9,1", helperVersion: "0.2.4-h6"),
      transport: transport, keys: keys, store: store, executor: RecordingExecutor(),
      serverKeys: ["fk1": server.publicKey], roomSession: { "room-jwt" }, gates: { FleetGateState(sessionOpen: false) },
      clock: clock, sleep: { _ in sleeps.tick(limit: Int.max); await Task.yield() }, makeJTI: { UUID().uuidString.lowercased() },
      log: { log.add($0) })
  }

  private func pollReply() -> FleetResponse {
    let body = FleetJSON.object([
      "ok": .bool(true), "server_time": .string(TestServer.iso(TestServer.now)),
      "kill_switch": .object(["global": .bool(false)]), "commands": .array([]),
    ])
    return FleetResponse(status: 200, body: Data(body.canonical.utf8))
  }

  /// The failure the OPD 6 log shows: "fleet client: on", then nothing, ever. A key that cannot be read made every
  /// poll throw inside the client, which swallowed it and retried in silence; no request ever left the Mac.
  @Test func aKeyThatCannotBeReadIsSaidOnceAndTheClientPollsAsSoonAsItCan() async throws {
    let polls = TaskBox()
    let reply = pollReply()
    let transport = FakeTransport { request in
      if request.path == "/api/fleet/poll" { polls.tick(limit: 3) }
      return reply
    }
    let log = LogLines()
    let sleeps = TaskBox()
    let keys = FlakyKeys()
    let now = ClockBox()
    let fleet = client(keys: keys, store: seeded(), transport: transport, log: log, sleeps: sleeps, clock: { now.value })
    let task = Task.detached { await fleet.run() }
    polls.set(task)

    // Locked: several retries go by, no request leaves, and the log says why exactly once.
    let deadline = Date().addingTimeInterval(20)
    while sleeps.cycles < 5 && Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
    #expect(sleeps.cycles >= 5)
    #expect(transport.requests.isEmpty, "nothing can be signed, so nothing is sent")
    let said = log.all.filter { $0.hasPrefix("fleet client: poll failed") }
    #expect(said == ["fleet client: poll failed (FleetKeychain -25308)"], "once, with the status; got \(said)")

    // Unlocked. A key that failed to load is asked for again after 300 s (0.1.39.1), so the clock moves on.
    // It then carries on by itself, polling at least three times, and registration is not repeated.
    keys.heal()
    now.advance(by: FleetClient.keyRetryInterval + 1)
    while polls.cycles < 3 && Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
    task.cancel()
    await task.value
    #expect(transport.paths.filter { $0 == "/api/fleet/poll" }.count >= 3)
    #expect(!transport.paths.contains("/api/fleet/register"))
    #expect(log.all.last == "fleet client stopped: cancelled")
  }

  @Test func everyExitSaysWhyItStopped() async {
    let log = LogLines()
    let transport = FakeTransport { _ in FleetResponse(status: 401, body: Data("{\"error\":\"revoked\"}".utf8)) }
    let disabled = FleetClient(
      config: FleetClientConfig(enabled: false, installID: "inst_1", machine: "m"), transport: transport, keys: MemoryKeys(),
      store: MemoryState(), executor: RecordingExecutor(), serverKeys: [:], roomSession: { nil }, gates: { FleetGateState(sessionOpen: false) },
      log: { log.add($0) })
    await disabled.run()
    #expect(log.all == ["fleet client stopped: disabled"])

    let revokedLog = LogLines()
    let revoked = client(keys: MemoryKeys(), store: seeded(), transport: transport, log: revokedLog, sleeps: TaskBox())
    await revoked.run()
    #expect(revokedLog.all.last?.hasPrefix("fleet client stopped: poll_") == true)
  }

  @Test func theUpdaterRefusingADowngradeDuringStartupDoesNotTouchTheClient() async throws {
    // The refusal is a log line from RoomUpdater on the engine; the client is its own detached task and actor.
    #expect(roomUpdateIsDowngrade(running: "0.1.38", offered: "0.1.28"))
    let polls = TaskBox()
    let reply = pollReply()
    let transport = FakeTransport { request in
      if request.path == "/api/fleet/poll" { polls.tick(limit: 3) }
      return reply
    }
    let fleet = client(keys: MemoryKeys(), store: seeded(), transport: transport, log: LogLines(), sleeps: TaskBox())
    let task = Task.detached { await fleet.run() }
    polls.set(task)
    let deadline = Date().addingTimeInterval(20)
    while polls.cycles < 3 && Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
    task.cancel(); await task.value
    #expect(transport.paths.filter { $0 == "/api/fleet/poll" }.count >= 3)
  }
}

final class HelloTally: @unchecked Sendable {
  private let lock = NSLock()
  private var oks = 0
  func record(_ ok: Bool) { lock.lock(); if ok { oks += 1 }; lock.unlock() }
  var okCount: Int { lock.lock(); defer { lock.unlock() }; return oks }
}
