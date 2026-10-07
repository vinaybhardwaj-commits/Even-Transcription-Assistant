import Foundation
import MicModeShim
import Testing
import RoomRecorderCore
import TapeCore

@testable import TapeCapture

private final class FakeMicModeAPI: MicModeAPI, @unchecked Sendable {
  var isAvailable = true
  var modes: [String: Int] = [:]
  var activeModes: [String: Int] = [:]
  var supports: Bool? = true
  var setResult = 1
  var setError: String?
  var setCalls: [String] = []
  var clearsActive = false

  func preferredMode(bundleID: String) -> Int { modes[bundleID] ?? 0 }
  func activeMode(bundleID: String) -> Int { activeModes[bundleID] ?? 0 }
  func supportsStandard(bundleID: String) -> Bool? { supports }
  func setStandard(bundleID: String) -> (result: Int, error: String?) {
    setCalls.append(bundleID)
    if setResult == 1 {
      modes[bundleID] = 0
      if clearsActive { activeModes[bundleID] = 0 }
    }
    return (setResult, setError)
  }
}

@Suite struct MicModeGuardTests {
  @Test func testMissingSymbolsIsNoOp() {
    let api = FakeMicModeAPI()
    api.isAvailable = false
    api.modes["a"] = 2
    #expect(MicModeGuard.enforceStandard(ids: ["a"], api: api, osMajor: 26, log: { _ in }).isEmpty)
    #expect(api.setCalls.isEmpty)
  }

  @Test func testSetSkippedWhenAlreadyStandard() {
    let api = FakeMicModeAPI()
    api.modes["a"] = 0
    MicModeGuard.enforceStandard(ids: ["a"], api: api, osMajor: 26, log: { _ in })
    #expect(api.setCalls.isEmpty)
  }

  @Test func testSetSkippedWhenStandardUnsupported() {
    let api = FakeMicModeAPI()
    api.modes["a"] = 2
    api.supports = false
    MicModeGuard.enforceStandard(ids: ["a"], api: api, osMajor: 26, log: { _ in })
    #expect(api.setCalls.isEmpty)
  }

  @Test func testSetCalledOnceWhenVoiceIsolation() {
    let api = FakeMicModeAPI()
    api.modes["a"] = 2
    var lines: [String] = []
    let reports = MicModeGuard.enforceStandard(ids: ["a"], api: api, osMajor: 26, log: { lines.append($0) })
    #expect(api.setCalls == ["a"])
    #expect(reports.first?.after == 0)
    #expect(lines == ["micmode before=2 set=1 after=0 bundle=a"])
  }

  @Test func testSetCalledWhenSupportedListUnreadable() {
    let api = FakeMicModeAPI()
    api.modes["a"] = 2
    api.supports = nil
    MicModeGuard.enforceStandard(ids: ["a"], api: api, osMajor: 26, log: { _ in })
    #expect(api.setCalls == ["a"])
  }

  @Test func testDerivedParentBundleID() {
    #expect(MicModeGuard.targetBundleIDs(mainBundleID: "com.evenscribe.room-recorder.tapewriter") == ["com.evenscribe.room-recorder.tapewriter", "com.evenscribe.room-recorder"])
    #expect(MicModeGuard.targetBundleIDs(mainBundleID: "com.evenscribe.room-recorder") == ["com.evenscribe.room-recorder"])
    #expect(MicModeGuard.targetBundleIDs(mainBundleID: nil) == [])
  }

  @Test func testSetFailureReportedNotThrown() {
    let api = FakeMicModeAPI()
    api.modes["a"] = 2
    api.setResult = -1
    api.setError = "NSInvalidArgumentException"
    let reports = MicModeGuard.enforceStandard(ids: ["a"], api: api, osMajor: 26, log: { _ in })
    #expect(reports.first?.setResult == -1)
    #expect(reports.first?.error == "NSInvalidArgumentException")
  }
}

private final class RecordingRestartStore: MicModeRestartStore, @unchecked Sendable {
  var date: Date?
  var saves = 0
  func lastRestart() -> Date? { date }
  func saveRestart(_ date: Date) {
    self.date = date
    saves += 1
  }
}

@Suite struct MicModeWatchdogTests {
  static let parent = "com.evenscribe.room-recorder"
  let s: UInt64 = 1_000_000_000

  private func watchdog(
    _ api: FakeMicModeAPI, store: MicModeRestartStore = RecordingRestartStore(), os: Int = 26
  ) -> MicModeWatchdog {
    MicModeWatchdog(
      mainBundleID: Self.parent + ".tapewriter", api: api, osMajor: os, store: store,
      log: { _ in }, status: { _ in })
  }

  @Test func f34RestartRequestedOnlyOnceInTenMinutes() {
    let api = FakeMicModeAPI()
    api.activeModes[Self.parent] = 2
    api.modes[Self.parent] = 2
    let store = RecordingRestartStore()
    var w = watchdog(api, store: store)
    let t0 = Date(timeIntervalSince1970: 1_000_000)
    let r0 = w.tick(nowNS: 0, now: t0)
    let r30 = w.tick(nowNS: 30 * s, now: t0)
    let r60 = w.tick(nowNS: 60 * s, now: t0.addingTimeInterval(60))
    let r120 = w.tick(nowNS: 120 * s, now: t0.addingTimeInterval(120))
    let r600 = w.tick(nowNS: 600 * s, now: t0.addingTimeInterval(600))
    let r660 = w.tick(nowNS: 660 * s, now: t0.addingTimeInterval(660))
    #expect(!r0 && !r30)
    #expect(r60)
    #expect(!r120 && !r600)
    #expect(r660)
    #expect(store.saves == 2)
    #expect(api.setCalls.contains(Self.parent))
  }

  @Test func f34RelaunchedProcessHonoursPersistedThrottle() {
    let api = FakeMicModeAPI()
    api.activeModes[Self.parent] = 2
    let t0 = Date(timeIntervalSince1970: 2_000_000)
    let store = RecordingRestartStore()
    store.date = t0.addingTimeInterval(-120)  // previous process restarted 2 min ago
    var w = watchdog(api, store: store)
    _ = w.tick(nowNS: 0, now: t0)
    let r = w.tick(nowNS: 60 * s, now: t0)
    #expect(!r)
    #expect(store.saves == 0)
  }

  @Test func f34NoRestartWhenSetClearsActiveMode() {
    let api = FakeMicModeAPI()
    api.activeModes[Self.parent] = 2
    api.modes[Self.parent] = 2
    api.clearsActive = true
    var w = watchdog(api)
    _ = w.tick(nowNS: 0)
    let r = w.tick(nowNS: 60 * s)
    #expect(!r)
  }

  @Test func f34FileStoreSurvivesANewInstance() throws {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("micmode-store-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let date = Date(timeIntervalSince1970: 3_000_000)
    FileMicModeRestartStore(directory: dir).saveRestart(date)
    #expect(FileMicModeRestartStore(directory: dir).lastRestart() == date)
  }

  @Test func f34ExitCodeIsDistinctFromRestartEngine() {
    #expect(MicModeGuard.relaunchExitCode == 76)
  }

  @Test func quietWhenStandard() {
    let api = FakeMicModeAPI()
    var w = watchdog(api)
    _ = w.tick(nowNS: 0)
    let r = w.tick(nowNS: 61 * s)
    #expect(!r)
    #expect(api.setCalls.isEmpty)
  }

  @Test func f38WatchdogDoesNothingOnUnsupportedOS() {
    let api = FakeMicModeAPI()
    api.activeModes[Self.parent] = 2
    var w = watchdog(api, os: 15)
    _ = w.tick(nowNS: 0)
    let r = w.tick(nowNS: 61 * s)
    #expect(!r)
    #expect(api.setCalls.isEmpty)
  }
}

@Suite struct MicModeFixTwoTests {
  @Test func f33StatusWordsAndLogOnEveryRun() {
    func run(_ configure: (FakeMicModeAPI) -> Void) -> MicModeStatus? {
      let api = FakeMicModeAPI()
      configure(api)
      var got: MicModeStatus?
      MicModeGuard.enforceStandard(
        ids: ["a"], api: api, osMajor: 26, log: { _ in }, status: { got = $0 })
      return got
    }
    #expect(run { $0.modes["a"] = 2 }?.set == "ok")
    #expect(run { $0.modes["a"] = 2 }?.after == 0)
    #expect(run { _ in }?.set == "skip")
    #expect(run { $0.modes["a"] = 2; $0.setResult = -1 }?.set == "fail")
    #expect(run { $0.modes["a"] = -1 }?.set == "unreadable")
    #expect(!(run { _ in })!.at.isEmpty)
  }

  @Test func f33StatusRoundTripsIntoRecorderStatusJSON() throws {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("micmode-status-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let status = MicModeStatus(before: 2, after: 0, set: "ok", at: "2026-10-08T00:00:00.000Z")
    MicModeStatus.write(status, directory: dir)
    #expect(MicModeStatus.read(directory: dir) == status)
    let json = try JSONEncoder().encode(status)
    let object = try JSONSerialization.jsonObject(with: json) as! [String: Any]
    #expect(Set(object.keys) == ["before", "after", "set", "at"])
  }

  @Test func f38UnsupportedOSSkipsWithoutCalls() {
    let api = FakeMicModeAPI()
    api.modes["a"] = 2
    var lines: [String] = []
    var got: MicModeStatus?
    let reports = MicModeGuard.enforceStandard(
      ids: ["a"], api: api, osMajor: 25, log: { lines.append($0) }, status: { got = $0 })
    #expect(reports.isEmpty)
    #expect(api.setCalls.isEmpty)
    #expect(lines == ["micmode skipped: os 25"])
    #expect(got?.set == "skip")
  }

  @Test func f35AnyNonZeroModeIsNotStandardAndLogsRawValue() {
    for raw in [1, 2, 3, 7] {
      let api = FakeMicModeAPI()
      api.modes["a"] = raw
      var lines: [String] = []
      MicModeGuard.enforceStandard(
        ids: ["a"], api: api, osMajor: 26, log: { lines.append($0) }, status: { _ in })
      #expect(api.setCalls == ["a"])
      #expect(lines.first?.hasPrefix("micmode before=\(raw) set=1") == true)
    }
  }

  @Test func f36RunnerTimesOutAndStaysNonBlocking() {
    let runner = MicModeCallRunner(timeout: 0.2)
    let started = Date()
    let first = runner.run(fallback: -1) {
      Thread.sleep(forTimeInterval: 1.5)
      return 5
    }
    #expect(first.timedOut && first.value == -1)
    let second = runner.run(fallback: -1) { 9 }
    #expect(second.timedOut && second.value == -1)
    #expect(Date().timeIntervalSince(started) < 1.4)
    let fast = MicModeCallRunner(timeout: 30).run(fallback: -1) { 4 }
    #expect(!fast.timedOut && fast.value == 4)
  }

  @Test func f36TimedOutSetIsReportedAsFail() {
    // A hung Set: the system API returns (-2, "timeout"); the guard reports set=fail.
    let api = FakeMicModeAPI()
    api.modes["a"] = 2
    api.setResult = -2
    api.setError = "timeout"
    var got: MicModeStatus?
    let reports = MicModeGuard.enforceStandard(
      ids: ["a"], api: api, osMajor: 26, log: { _ in }, status: { got = $0 })
    #expect(reports.first?.setResult == -2)
    #expect(got?.set == "fail")
  }
}

/// Touches the process-wide resolver, so it runs alone.
@Suite(.serialized) struct MicModeShimResolverTests {
  @Test func realShimDoesNotCrashOnThisHost() {
    rr_micmode_reset_resolver(nil)
    let api = SystemMicModeAPI(runner: MicModeCallRunner(timeout: 30))
    _ = api.isAvailable
    _ = api.preferredMode(bundleID: "com.example.nonexistent")
  }

  @Test func f37EverySymbolMissingMeansNoCallAndStatusSkip() {
    rr_micmode_reset_resolver("/nonexistent/AVFCapture")
    defer { rr_micmode_reset_resolver(nil) }
    let api = SystemMicModeAPI(runner: MicModeCallRunner(timeout: 30))
    #expect(!api.isAvailable)
    #expect(api.preferredMode(bundleID: "a") == -1)
    #expect(api.activeMode(bundleID: "a") == -1)
    #expect(api.supportsStandard(bundleID: "a") == nil)
    #expect(api.setStandard(bundleID: "a").result == -1)
    var got: MicModeStatus?
    var lines: [String] = []
    let reports = MicModeGuard.enforceStandard(
      ids: ["a"], api: api, osMajor: 26, log: { lines.append($0) }, status: { got = $0 })
    #expect(reports.isEmpty)
    #expect(got?.set == "skip")
    #expect(lines == ["micmode skipped: AVFCapture symbols unavailable"])
  }
}

@Suite struct MicModeLaneWiringTests {
  private func source(_ name: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(
      contentsOf: root.appendingPathComponent("Sources/tapewriter/\(name)"), encoding: .utf8)
  }

  @Test func guardIsCalledOnceInCaptureSessionInitAndNeverInTheLane() throws {
    let recorder = try source("Recorder.swift")
    let lane = try source("ResidentAudioCaptureLane.swift")
    // Every lane start builds a CaptureSession, whose init is the single guard call.
    #expect(recorder.components(separatedBy: "MicModeGuard.enforceStandardForMainBundle()").count == 2)
    #expect(!lane.contains("MicModeGuard"))
    #expect(!lane.contains("MicModeWatchdog"))
  }

  @Test func unreadableModeNeverSets() {
    let api = FakeMicModeAPI()
    api.modes["a"] = -1
    var lines: [String] = []
    MicModeGuard.enforceStandard(ids: ["a"], api: api, osMajor: 26, log: { lines.append($0) })
    #expect(api.setCalls.isEmpty)
    #expect(lines == ["micmode before=unreadable set=skip bundle=a"])
  }
}

@Suite struct RecorderStatusMicModeTests {
  @Test func statusJSONCarriesMicModeKey() throws {
    let status = RoomRecorderStatus(
      state: .recording,
      micMode: MicModeStatus(before: 2, after: 0, set: "ok", at: "2026-10-08T00:00:00.000Z"))
    let data = try JSONEncoder().encode(status)
    let object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    let mic = object["mic_mode"] as? [String: Any]
    #expect(mic?["set"] as? String == "ok")
    #expect(mic?["before"] as? Int == 2)
    // An old status.json without the key still decodes.
    let plain = try JSONEncoder().encode(RoomRecorderStatus(state: .ready))
    #expect(try JSONDecoder().decode(RoomRecorderStatus.self, from: plain).micMode == nil)
  }
}

// MARK: - FIX3: exit 76 is a planned restart that needs no server

/// Wraps an `R4FakeTapewriter` so a test can make it "exit" with a chosen status once it is
/// durable. The inner fake is interrupted so its writer thread stops.
private final class ScriptedExitTapewriter: RoomCaptureProcess, @unchecked Sendable {
  let inner: R4FakeTapewriter
  private let lock = NSLock()
  private var forced: Int32?
  init(inner: R4FakeTapewriter) { self.inner = inner }
  func exit(status: Int32) {
    lock.withLock { forced = status }
    inner.interrupt()
  }
  var isRunning: Bool { lock.withLock { forced == nil } && inner.isRunning }
  var terminationStatus: Int32? {
    lock.withLock { forced } ?? inner.terminationStatus
  }
  func interrupt() { inner.interrupt() }
  func waitUntilExit() { inner.waitUntilExit() }
}

private final class ScriptedLauncher: RoomCaptureLaunching, @unchecked Sendable {
  private let lock = NSLock()
  private let base = R4FakeLauncher()
  private var wrapped: [ScriptedExitTapewriter] = []
  func launch(executable: URL, outputDirectory: URL, deviceUID: String, logURL: URL) throws
    -> any RoomCaptureProcess
  {
    let process = try base.launch(
      executable: executable, outputDirectory: outputDirectory, deviceUID: deviceUID, logURL: logURL
    )
    let scripted = ScriptedExitTapewriter(inner: process as! R4FakeTapewriter)
    lock.withLock { wrapped.append(scripted) }
    return scripted
  }
  var count: Int { lock.withLock { wrapped.count } }
  func exitLatest(status: Int32) { lock.withLock { wrapped.last }?.exit(status: status) }
  var directories: [URL] { base.launchedDirectories }
}

/// The server never answers: every call after the first active-session read throws.
private actor DeadRemote: RoomEngineRemote {
  private let inner: R4Remote
  private var activeCalls = 0
  init() { inner = R4Remote(activeSessionJSON: R4Fixture.recordingActiveJSON, polls: []) }
  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
    activeCalls += 1
    if activeCalls == 1 { return try await inner.activeSession(tabID: tabID, since: since) }
    throw URLError(.notConnectedToInternet)
  }
  func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
    throw URLError(.notConnectedToInternet)
  }
  func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws
    -> BenchOKResponse
  { throw URLError(.notConnectedToInternet) }
  func pollCommands(
    tabID: String, previousPollAt: String?, recordingSessionID: String?, paused: Bool,
    primaryLevels: BenchLevelPair?, install: InstallPollFields?
  ) async throws -> CommandPollResponse { throw URLError(.notConnectedToInternet) }
  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  { throw URLError(.notConnectedToInternet) }
  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse {
    throw URLError(.notConnectedToInternet)
  }
  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws
    -> ImmutablePieceUploadResult
  { throw URLError(.notConnectedToInternet) }
}

@Suite(.serialized) struct MicModeRestartTests {
  final class Lines: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []
    func add(_ line: String) { lock.withLock { items.append(line) } }
    var all: [String] { lock.withLock { items } }
  }

  private func start(_ launcher: ScriptedLauncher, lines: Lines, root: URL) async throws
    -> (RoomEngine, Task<Void, Error>)
  {
    try RoomPersistence(root: root).saveConfiguration(try R4Fixture.configuration())
    let engine = try await RoomEngine.load(
      rootURL: root,
      enrolmentReader: R4Fixture.enrolled,
      remoteFactory: { _ in DeadRemote() },
      captureLauncher: launcher,
      pieceRunner: R4FakeEncoder(),
      updaterFactory: { _, _, _ in nil },
      log: { lines.add($0) })
    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { launcher.count == 1 }
    return (engine, task)
  }

  @Test func exit76RelaunchesWithNoServerAndIsNotFailed() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let launcher = ScriptedLauncher()
    let lines = Lines()
    let (_, task) = try await start(launcher, lines: lines, root: root)
    // Let the first segment become durable, then plant mic_mode.json as tapewriter would.
    try await Task.sleep(for: .milliseconds(300))
    MicModeStatus.write(
      MicModeStatus(before: 2, after: 0, set: "ok", at: "2026-10-08T00:00:00.000Z"),
      directory: launcher.directories[0])
    launcher.exitLatest(status: 76)
    try await R4Fixture.waitUntil { launcher.count == 2 }
    // Same session dir, next segment.
    #expect(
      launcher.directories[0].deletingLastPathComponent()
        == launcher.directories[1].deletingLastPathComponent())
    MicModeStatus.write(
      MicModeStatus(before: 0, after: 0, set: "skip", at: "2026-10-08T00:01:00.000Z"),
      directory: launcher.directories[1])
    try await Task.sleep(for: .milliseconds(1_800))
    task.cancel()
    _ = try? await task.value

    let status = try RoomPersistence(root: root).loadStatus()
    #expect(status.state == .recording)
    #expect(status.lastEvent == "mic_mode_restart")
    #expect(status.lastEventAt != nil)
    #expect(status.micMode?.after == 0)
    #expect(lines.all.contains("tapewriter planned restart: mic_mode"))
    #expect(!lines.all.contains { $0.contains("tapewriter exited") })
  }

  @Test func secondExit76InsideTenMinutesTakesTheOldPath() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let launcher = ScriptedLauncher()
    let lines = Lines()
    let (_, task) = try await start(launcher, lines: lines, root: root)
    try await Task.sleep(for: .milliseconds(300))
    launcher.exitLatest(status: 76)
    try await R4Fixture.waitUntil { launcher.count == 2 }
    try await Task.sleep(for: .milliseconds(300))
    launcher.exitLatest(status: 76)
    // The dead server puts the loop in poll back-off (5 to 30 s), so allow for it.
    for _ in 0..<6_000 where !lines.all.contains("micmode restart suppressed: throttle") {
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(lines.all.contains("micmode restart suppressed: throttle"))
    try await Task.sleep(for: .milliseconds(500))
    task.cancel()
    _ = try? await task.value

    #expect(launcher.count == 2)  // the server is dead, so nothing relaunched the third
    let status = try RoomPersistence(root: root).loadStatus()
    #expect(status.state == .failed)
  }

  @Test func exit1KeepsTheOldPath() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let launcher = ScriptedLauncher()
    let lines = Lines()
    let (_, task) = try await start(launcher, lines: lines, root: root)
    try await Task.sleep(for: .milliseconds(300))
    launcher.exitLatest(status: 1)
    try await R4Fixture.waitUntil {
      (try? RoomPersistence(root: root).loadStatus().state) == .failed
    }
    task.cancel()
    _ = try? await task.value

    #expect(launcher.count == 1)
    let status = try RoomPersistence(root: root).loadStatus()
    #expect(status.lastEvent == nil)
    #expect(!lines.all.contains("tapewriter planned restart: mic_mode"))
  }

  @Test func statusRoundTripsLastEventAndOldFilesDecode() throws {
    let at = Date(timeIntervalSince1970: 1_790_000_000)
    let status = RoomRecorderStatus(state: .recording, lastEvent: "mic_mode_restart", lastEventAt: at)
    let object =
      try JSONSerialization.jsonObject(with: JSONEncoder().encode(status)) as! [String: Any]
    #expect(object["last_event"] as? String == "mic_mode_restart")
    #expect(object["last_event_at"] != nil)
    let plain = try JSONEncoder().encode(RoomRecorderStatus(state: .ready))
    #expect(try JSONDecoder().decode(RoomRecorderStatus.self, from: plain).lastEvent == nil)
  }
}
