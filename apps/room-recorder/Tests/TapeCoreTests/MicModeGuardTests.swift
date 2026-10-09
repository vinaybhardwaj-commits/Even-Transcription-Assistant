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
  var setDelay: TimeInterval = 0
  var freshCalls = 0

  func fresh() -> MicModeAPI {
    freshCalls += 1
    return self
  }
  func preferredMode(bundleID: String) -> Int { modes[bundleID] ?? 0 }
  func activeMode(bundleID: String) -> Int { activeModes[bundleID] ?? 0 }
  func supportsStandard(bundleID: String) -> Bool? { supports }
  func setStandard(bundleID: String) -> (result: Int, error: String?) {
    setCalls.append(bundleID)
    if setDelay > 0 { Thread.sleep(forTimeInterval: setDelay) }
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
    #expect(lines.count == 1)
    #expect(lines[0].hasPrefix("micmode before=2 set=1 after=0 bundle=a set_ms="))
    #expect(api.freshCalls == 1)  // the re-read after the Set uses a fresh runner
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

@Suite struct MicModeWatchdogTests {
  static let parent = "com.evenscribe.room-recorder"
  let s: UInt64 = 1_000_000_000

  final class Capture: @unchecked Sendable {
    var lines: [String] = []
    var statuses: [MicModeStatus] = []
  }

  private func watchdog(_ api: FakeMicModeAPI, _ out: Capture, os: Int = 26) -> MicModeWatchdog {
    MicModeWatchdog(
      mainBundleID: Self.parent + ".tapewriter", api: api, osMajor: os,
      log: { out.lines.append($0) }, status: { out.statuses.append($0) })
  }

  @Test func resetsInPlaceWhenPreferredIsTwoAndActiveIsZero() {
    let api = FakeMicModeAPI()
    api.modes[Self.parent] = 2
    api.activeModes[Self.parent] = 0
    let out = Capture()
    var w = watchdog(api, out)
    w.tick(nowNS: 0)
    #expect(api.setCalls.isEmpty)  // first tick only arms the 60 s timer
    w.tick(nowNS: 60 * s)
    #expect(api.setCalls == [Self.parent])
    #expect(api.modes[Self.parent] == 0)
    #expect(out.lines.first == "micmode watchdog preferred=2 active=0 bundle=\(Self.parent)")
    let status = out.statuses.last
    #expect(status?.lastEvent == "mic_mode_reset")
    #expect(status?.before == 2 && status?.after == 0 && status?.set == "ok")
    #expect(status?.setMs != nil)
  }

  @Test func resetsWhenOnlyActiveIsNonZero() {
    let api = FakeMicModeAPI()
    api.activeModes[Self.parent] = 2
    api.clearsActive = true
    let out = Capture()
    var w = watchdog(api, out)
    w.tick(nowNS: 0)
    w.tick(nowNS: 60 * s)
    #expect(api.setCalls == [Self.parent])
    #expect(out.statuses.last?.before == 2 && out.statuses.last?.after == 0)
  }

  @Test func unreadableIsLoggedAndWrittenNeverSetAndNeverRestarts() {
    let api = FakeMicModeAPI()
    api.modes[Self.parent] = -1
    api.activeModes[Self.parent] = -1
    let out = Capture()
    var w = watchdog(api, out)
    w.tick(nowNS: 0)
    w.tick(nowNS: 60 * s)
    #expect(api.setCalls.isEmpty)
    #expect(out.lines == ["micmode watchdog preferred=-1 active=-1 bundle=\(Self.parent)"])
    #expect(out.statuses.last?.set == "unreadable")
    #expect(out.statuses.last?.lastEvent == nil)
  }

  @Test func throttleAllowsOneResetPerTwoMinutesAndLogsTheSuppressed() {
    let api = FakeMicModeAPI()
    api.modes[Self.parent] = 2
    api.setResult = 0  // the Set does not take, so the mode stays non-zero
    let out = Capture()
    var w = watchdog(api, out)
    let t0 = Date(timeIntervalSince1970: 1_000_000)
    w.tick(nowNS: 0, now: t0)
    w.tick(nowNS: 60 * s, now: t0.addingTimeInterval(60))  // reset
    w.tick(nowNS: 120 * s, now: t0.addingTimeInterval(120))  // 60 s later: suppressed
    w.tick(nowNS: 180 * s, now: t0.addingTimeInterval(180))  // 120 s later: reset again
    #expect(api.setCalls.count == 2)
    #expect(out.lines.filter { $0.contains("reset suppressed") }.count == 1)
    #expect(out.statuses.filter { $0.lastEvent == "mic_mode_reset" }.count == 2)
    #expect(out.statuses.first?.set == "fail")
  }

  @Test func oneLogLinePerTickEvenWhenStandardAndFreshRunnerEachTick() {
    let api = FakeMicModeAPI()
    let out = Capture()
    var w = watchdog(api, out)
    w.tick(nowNS: 0)
    w.tick(nowNS: 30 * s)
    #expect(out.lines.isEmpty)
    w.tick(nowNS: 60 * s)
    w.tick(nowNS: 120 * s)
    #expect(out.lines.count == 2)
    #expect(api.freshCalls == 2)
    #expect(api.setCalls.isEmpty)
    #expect(out.statuses.isEmpty)
  }

  @Test func timedOutSetIsRecordedAsTimeout() {
    let api = FakeMicModeAPI()
    api.modes[Self.parent] = 2
    api.setResult = -2
    api.setError = "timeout"
    let out = Capture()
    var w = watchdog(api, out)
    w.tick(nowNS: 0)
    w.tick(nowNS: 60 * s)
    #expect(out.statuses.last?.set == "timeout")
    #expect(out.statuses.last?.lastEvent == "mic_mode_reset")
  }

  @Test func watchdogDoesNothingOnUnsupportedOS() {
    let api = FakeMicModeAPI()
    api.activeModes[Self.parent] = 2
    let out = Capture()
    var w = watchdog(api, out, os: 15)
    w.tick(nowNS: 0)
    w.tick(nowNS: 61 * s)
    #expect(api.setCalls.isEmpty)
    #expect(out.lines == ["micmode watchdog skipped: os 15"])
  }

  @Test func sourceHasNoRestartPath() throws {
    let root = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    for name in ["tapewriter/MicModeGuard.swift", "tapewriter/Recorder.swift", "TapewriterCLI/main.swift"] {
      let text = try String(contentsOf: root.appendingPathComponent("Sources/\(name)"), encoding: .utf8)
      #expect(!text.contains("MicModeRelaunchRequested"))
      #expect(!text.contains("exit(76)"))
    }
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
    #expect(run { $0.modes["a"] = 2; $0.setResult = -2 }?.set == "timeout")
    #expect(run { $0.modes["a"] = 2 }?.setMs != nil)
    #expect(run { _ in }?.setMs == nil)
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

  @Test func hungCallDoesNotPoisonLaterCalls() {
    let runner = MicModeCallRunner(timeout: 0.2)
    let started = Date()
    let first = runner.run(fallback: -1) {
      Thread.sleep(forTimeInterval: 1.5)
      return 5
    }
    #expect(first.timedOut && first.value == -1)
    let second = runner.run(fallback: -1) { 9 }
    #expect(!second.timedOut && second.value == 9)
    #expect(Date().timeIntervalSince(started) < 1.4)
  }

  @Test func slowCallInsideItsTimeoutIsNotATimeout() {
    // A call that takes longer than the read timeout but less than the Set timeout completes.
    let runner = MicModeCallRunner(timeout: 0.1)
    let slow = runner.run(fallback: -1, timeout: 5) {
      Thread.sleep(forTimeInterval: 0.5)
      return 1
    }
    #expect(!slow.timedOut && slow.value == 1)
    #expect(runner.run(fallback: -1) { 4 }.value == 4)
    #expect(SystemMicModeAPI.setTimeout == 10)
  }

  @Test func neverReturningCallTimesOutAndNextReadStillWorks() {
    let runner = MicModeCallRunner(timeout: 0.2)
    let gate = DispatchSemaphore(value: 0)
    let hung = runner.run(fallback: -2, timeout: 0.3) {
      gate.wait()
      return 1
    }
    #expect(hung.timedOut && hung.value == -2)
    #expect(runner.run(fallback: -1) { 7 }.value == 7)
    gate.signal()
  }

  @Test func freshAPIHasItsOwnRunner() {
    let api = SystemMicModeAPI(runner: MicModeCallRunner(timeout: 3))
    let fresh = api.fresh() as? SystemMicModeAPI
    #expect(fresh != nil && fresh !== api)
    #expect(fresh?.runner !== api.runner && fresh?.runner.timeout == 3)
  }

  @Test func setThatTakesThreeSecondsIsOkWithItsElapsedTime() {
    let api = FakeMicModeAPI()
    api.modes["a"] = 2
    api.setDelay = 3
    var got: MicModeStatus?
    var lines: [String] = []
    MicModeGuard.enforceStandard(
      ids: ["a"], api: api, osMajor: 26, log: { lines.append($0) }, status: { got = $0 })
    #expect(got?.set == "ok" && got?.after == 0)
    let ms = got?.setMs ?? 0
    #expect(ms >= 2_900 && ms < 4_500)
    #expect(lines.first?.contains("set_ms=") == true)
    #expect(api.freshCalls == 1)
  }

  @Test func timedOutSetIsReportedAsTimeoutAndTheNextReadStillWorks() {
    // A Set that never returns: the system API gives (-2, "timeout"); the guard reports
    // set=timeout and the re-read goes through a fresh API.
    let api = FakeMicModeAPI()
    api.modes["a"] = 2
    api.setResult = -2
    api.setError = "timeout"
    var got: MicModeStatus?
    let reports = MicModeGuard.enforceStandard(
      ids: ["a"], api: api, osMajor: 26, log: { _ in }, status: { got = $0 })
    #expect(reports.first?.setResult == -2)
    #expect(got?.set == "timeout")
    #expect(got?.after == 2)  // the re-read worked and shows the mode unchanged
    #expect(api.freshCalls == 1)
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
  private let other: R4Remote
  private var activeCalls = 0
  private var reachable = false
  init() {
    inner = R4Remote(activeSessionJSON: R4Fixture.recordingActiveJSON, polls: [])
    other = R4Remote(
      activeSessionJSON: R4Fixture.recordingActiveJSON.replacingOccurrences(
        of: "bs_r4", with: "bs_r5"),
      polls: [])
  }
  /// From now on the active-session read answers with a different recording session.
  func comeBackWithNewSession() { reachable = true }
  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
    activeCalls += 1
    if activeCalls == 1 { return try await inner.activeSession(tabID: tabID, since: since) }
    if reachable { return try await other.activeSession(tabID: tabID, since: since) }
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

@Suite(.serialized) struct MicModeEngineTests {
  final class Lines: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []
    func add(_ line: String) { lock.withLock { items.append(line) } }
    var all: [String] { lock.withLock { items } }
  }

  private func start(
    _ launcher: ScriptedLauncher, lines: Lines, root: URL, remote: DeadRemote = DeadRemote()
  ) async throws -> (RoomEngine, Task<Void, Error>) {
    try RoomPersistence(root: root).saveConfiguration(try R4Fixture.configuration())
    let engine = try await RoomEngine.load(
      rootURL: root,
      enrolmentReader: R4Fixture.enrolled,
      remoteFactory: { _ in remote },
      captureLauncher: launcher,
      pieceRunner: R4FakeEncoder(),
      updaterFactory: { _, _, _ in nil },
      log: { lines.add($0) })
    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { launcher.count == 1 }
    return (engine, task)
  }

  @Test func watchdogResetEventReachesStatusJSON() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let launcher = ScriptedLauncher()
    let lines = Lines()
    let (_, task) = try await start(launcher, lines: lines, root: root)
    try await Task.sleep(for: .milliseconds(300))
    MicModeStatus.write(
      MicModeStatus(
        before: 2, after: 0, set: "ok", at: "2026-10-08T00:00:00.000Z", setMs: 41,
        lastEvent: "mic_mode_reset"),
      directory: launcher.directories[0])
    try await R4Fixture.waitUntil {
      (try? RoomPersistence(root: root).loadStatus().lastEvent) == "mic_mode_reset"
    }
    task.cancel()
    _ = try? await task.value
    let status = try RoomPersistence(root: root).loadStatus()
    #expect(status.state == .recording)
    #expect(status.lastEventAt != nil)
    #expect(status.micMode?.setMs == 41)
    #expect(launcher.count == 1)  // no relaunch
  }

  @Test func exit76IsNoLongerAPlannedRestart() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let launcher = ScriptedLauncher()
    let lines = Lines()
    let (_, task) = try await start(launcher, lines: lines, root: root)
    try await Task.sleep(for: .milliseconds(300))
    launcher.exitLatest(status: 76)
    try await R4Fixture.waitUntil {
      (try? RoomPersistence(root: root).loadStatus().state) == .failed
    }
    task.cancel()
    _ = try? await task.value
    #expect(launcher.count == 1)
    #expect(!lines.all.contains("tapewriter planned restart: mic_mode"))
    #expect(try RoomPersistence(root: root).loadStatus().lastEvent == nil)
  }

  @Test func newSessionClearsLastEvent() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let launcher = ScriptedLauncher()
    let lines = Lines()
    let remote = DeadRemote()
    let (_, task) = try await start(launcher, lines: lines, root: root, remote: remote)
    try await Task.sleep(for: .milliseconds(300))
    MicModeStatus.write(
      MicModeStatus(
        before: 2, after: 0, set: "ok", at: "2026-10-08T00:00:00.000Z", setMs: 5,
        lastEvent: "mic_mode_reset"),
      directory: launcher.directories[0])
    try await R4Fixture.waitUntil {
      (try? RoomPersistence(root: root).loadStatus().lastEvent) == "mic_mode_reset"
    }
    // The capture dies; the server then answers with another session.
    launcher.exitLatest(status: 1)
    try await R4Fixture.waitUntil {
      (try? RoomPersistence(root: root).loadStatus().state) == .failed
    }
    await remote.comeBackWithNewSession()
    for _ in 0..<4_000 where (try? RoomPersistence(root: root).loadStatus().lastEvent) != nil {
      try await Task.sleep(for: .milliseconds(10))
    }
    task.cancel()
    _ = try? await task.value
    let status = try RoomPersistence(root: root).loadStatus()
    #expect(status.lastEvent == nil)
    #expect(status.lastEventAt == nil)
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
  }

  @Test func statusRoundTripsLastEventAndOldFilesDecode() throws {
    let at = Date(timeIntervalSince1970: 1_790_000_000)
    let status = RoomRecorderStatus(state: .recording, lastEvent: "mic_mode_reset", lastEventAt: at)
    let object =
      try JSONSerialization.jsonObject(with: JSONEncoder().encode(status)) as! [String: Any]
    #expect(object["last_event"] as? String == "mic_mode_reset")
    #expect(object["last_event_at"] != nil)
    let plain = try JSONEncoder().encode(RoomRecorderStatus(state: .ready))
    #expect(try JSONDecoder().decode(RoomRecorderStatus.self, from: plain).lastEvent == nil)
    // An old mic_mode.json (no set_ms, no last_event) still decodes.
    let old = Data(#"{"before":2,"after":0,"set":"ok","at":"x"}"#.utf8)
    let decoded = try JSONDecoder().decode(MicModeStatus.self, from: old)
    #expect(decoded.setMs == nil && decoded.lastEvent == nil)
  }
}
