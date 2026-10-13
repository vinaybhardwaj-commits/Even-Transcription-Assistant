import Foundation
import Testing

@testable import HelperCore
@testable import RoomRecorderCore
@testable import TapeCapture
@testable import TapeCore

/// 0.1.39 (FR-1 C2) — status.json poll/upload facts, probe-helper, the enrolment wait, the retry of a day that never
/// started, the capture-progress watchdog, and the removal of the unreachable `.retired` exit.
///
/// Mutants (each run by hand against these tests; a kill is a failed assertion, not a bare non-zero exit):
///  (3) `awaitEnrolment` rethrows instead of waiting          -> `anInstallWithNoSessionWaitsAndRereadsInsteadOfParking` fails
///  (3) interval constant changed                              -> the same test fails on the 300 s sleeps
///  (3) loop returns the first miss without re-reading         -> the same test fails on the call count
///  (4) governor cap raised / never spent                      -> `theGovernorAllowsThreeAttemptsPerRollingHour`, `aFailingStartIsRetriedThreeTimesAnHourNotEveryMinute` fail
///  (4) every failure treated as mic/device (the R2 blocker)   -> `aServerOutageAtOpenKeepsTheUncappedMinuteRetry`, `onlyAMicOrDeviceFailureCountsAsOne` fail
///  (4) retry skips the readiness gate                         -> `aStartThatDiedOnADeniedMicrophoneRetriesOnlyOnceItIsBack` fails on the create count
///  (4) `decide` ignores the retired flag / the window         -> `aRecoveryStartNeedsEveryGate` fails
///  (5) watchdog never reports a stall                         -> both engine stall tests fail on the launch count
///  (5) restart ends the session instead of restarting capture -> `aStalledCaptureIsRestartedUnderTheSameOpenSession` fails (second launch, patches)
///  (5) repeat never flagged                                   -> `aStallThatComesBackIsFlaggedAsARepeat` fails
///  (5) kill after the wait removed                            -> `aCaptureThatIgnoresItsInterruptIsKilledAndRestarted` fails on `forceStops`
///  (5) stalled state never cleared                            -> `theStalledStateClearsWhenTheTapeGrowsAgain` fails
///  (5) watchdog also judges a paused session                 -> SURVIVES, equivalent: a paused plain session has no capture to judge (`capture` is nil)
///  (3) reader called once, never re-read                       -> not run: the loop never ends, so it hangs rather than fails an assertion
@Suite(.serialized) struct RoomFr1C2Tests {

  // MARK: - fixtures

  /// A clock the test moves.
  final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date
    init(_ start: Date) { current = start }
    var now: Date { lock.withLock { current } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current = current.addingTimeInterval(seconds) } }
  }

  /// The two things a person changes in a room: the microphone permission and the devices that are plugged in.
  final class Room: @unchecked Sendable, RoomAudioInputControlling {
    private let lock = NSLock()
    private var mic: String
    private var devices: [String]
    init(mic: String, devices: [String]) {
      self.mic = mic
      self.devices = devices
    }
    var micState: String { lock.withLock { mic } }
    func setMic(_ value: String) { lock.withLock { mic = value } }
    func setDevices(_ value: [String]) { lock.withLock { devices = value } }
    func inputDevices() -> [AudioInputDeviceEntry]? {
      lock.withLock { devices.map { AudioInputDeviceEntry(name: $0, uid: $0, isDefault: false) } }
    }
    func inputVolume(uid: String) -> AudioInputVolume? { nil }
    func setInputVolume(uid: String, value: Double) throws {}
  }

  /// A capture that wrote a little tape and then stopped growing. `ignoresInterrupt` makes it need `forceStop`.
  final class FrozenTape: RoomCaptureProcess, @unchecked Sendable {
    let directory: URL
    private let lock = NSLock()
    private var running = true
    private var status: Int32?
    private let ignoresInterrupt: Bool
    private(set) var forceStops = 0
    init(directory: URL, deviceUID: String, ignoresInterrupt: Bool) {
      self.directory = directory
      self.ignoresInterrupt = ignoresInterrupt
      // 0.1 s of tape and the index lines a real tapewriter writes for it, then nothing more.
      FileManager.default.createFile(
        atPath: directory.appendingPathComponent("tape.pcm").path, contents: Data(count: 1_600 * 2))
      var index = Data()
      func line(_ record: IndexRecord) { if let l = try? IndexLog.encodedLine(record) { index.append(l) } }
      let mono = DispatchTime.now().uptimeNanoseconds
      let wall = UInt64(Date().timeIntervalSince1970 * 1_000_000_000)
      line(IndexRecord(byteOffset: 0, samples: 0, monoNS: mono, wallNS: wall, device: deviceUID, rms: 0))
      line(
        IndexRecord(
          byteOffset: 3_200, samples: 1_600, monoNS: mono + 100_000_000, wallNS: wall + 100_000_000,
          device: deviceUID, rms: 0.1, peak: 0.2, zeroRatio: 0))
      FileManager.default.createFile(
        atPath: directory.appendingPathComponent("tape.idx").path, contents: index)
    }
    var isRunning: Bool { lock.withLock { running } }
    var terminationStatus: Int32? { lock.withLock { running ? nil : status } }
    func interrupt() {
      guard !ignoresInterrupt else { return }
      lock.withLock {
        running = false
        status = 0
      }
    }
    func forceStop() {
      lock.withLock {
        forceStops += 1
        running = false
        status = 9
      }
    }
    func waitUntilExit() {
      // Bounded, so a broken restart fails an assertion instead of hanging the suite.
      let deadline = Date().addingTimeInterval(5)
      while isRunning, Date() < deadline { Thread.sleep(forTimeInterval: 0.002) }
      lock.withLock {
        if running {
          running = false
          status = 0
        }
      }
    }
  }

  /// Launch k of a scripted run: frozen (stalls), frozen and deaf, healthy, or dies at once.
  enum Behaviour { case frozen, deaf, healthy, dies }

  /// The script's next entry is used per launch; the last entry repeats.
  final class Launcher: RoomCaptureLaunching, @unchecked Sendable {
    private let lock = NSLock()
    private var script: [Behaviour]
    private var processes: [any RoomCaptureProcess] = []
    init(_ script: [Behaviour]) { self.script = script }
    func setScript(_ next: [Behaviour]) { lock.withLock { script = next } }
    var launches: Int { lock.withLock { processes.count } }
    var frozen: [FrozenTape] { lock.withLock { processes.compactMap { $0 as? FrozenTape } } }
    func launch(executable: URL, outputDirectory: URL, deviceUID: String, logURL: URL) throws
      -> any RoomCaptureProcess
    {
      lock.withLock {
        let index = processes.count
        let behaviour = script[min(index, script.count - 1)]
        let process: any RoomCaptureProcess
        switch behaviour {
        case .frozen: process = FrozenTape(directory: outputDirectory, deviceUID: deviceUID, ignoresInterrupt: false)
        case .deaf: process = FrozenTape(directory: outputDirectory, deviceUID: deviceUID, ignoresInterrupt: true)
        case .healthy:
          process = R4FakeTapewriter(
            directory: outputDirectory, deviceUID: deviceUID, peak: 0.3, exitStatus: nil)
        case .dies:
          process = R4FakeTapewriter(
            directory: outputDirectory, deviceUID: deviceUID, peak: 0.3, exitStatus: 1)
        }
        processes.append(process)
        return process
      }
    }
  }

  static func ist(_ day: String, _ hhmm: String) -> Date {
    ISO8601DateFormatter().date(from: "\(day)T\(hhmm):00+05:30")!
  }

  static func status(_ root: URL) -> RoomRecorderStatus? { try? RoomPersistence(root: root).loadStatus() }

  static func prepareRoot(autoStart: Bool = false) throws -> URL {
    let root = R4Fixture.temporaryRoot()
    try RoomPersistence(root: root).saveConfiguration(try R4Fixture.configuration())
    return root
  }

  static func engine(
    root: URL, remote: R4Remote, launcher: any RoomCaptureLaunching, room: Room,
    inputReadyWait: RoomInputReadyWait = .disabled, log: @escaping @Sendable (String) -> Void = { _ in }
  ) async throws -> RoomEngine {
    let engine = try await RoomEngine.load(
      rootURL: root,
      enrolmentReader: R4Fixture.enrolled,
      remoteFactory: { _ in remote },
      captureLauncher: launcher,
      pieceRunner: R4FakeEncoder(),
      updaterFactory: { _, _, _ in nil },
      log: log,
      audioInputs: room,
      inputReadyWait: inputReadyWait)
    await engine.setMicStateProvider { [room] in room.micState }
    return engine
  }

  // MARK: - (1) status.json facts

  @Test func statusCarriesTheLastPollTheLastHTTPCodeAndTheLastUploadedChunk() async throws {
    let root = try Self.prepareRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let remote = R4Remote(activeSessionJSON: R4Fixture.recordingActiveJSON, polls: [])
    let launcher = Launcher([.frozen])
    let room = Room(mic: "authorized", devices: ["device-a"])
    let engine = try await Self.engine(root: root, remote: remote, launcher: launcher, room: room)
    let clock = Clock(Date())
    await engine.setRecoveryClock { clock.now }
    await engine.setStalledCaptureExitWait(nanoseconds: 200_000_000)
    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { Self.status(root)?.lastPollOKAt != nil }
    let polled = try #require(Self.status(root))
    #expect(polled.lastHTTP == 200)
    #expect(polled.lastChunkUploadedAt == nil)  // nothing has been cut yet
    // A chunk reaches the server once the stall restart cuts the segment.
    try await R4Fixture.waitUntil { launcher.launches == 1 }
    try await Task.sleep(for: .milliseconds(1_700))
    clock.advance(200)
    try await R4Fixture.waitUntil { launcher.launches >= 2 }
    try await R4Fixture.waitUntil { Self.status(root)?.lastChunkUploadedAt != nil }
    #expect(await remote.uploadedPieces().count >= 1)
    let json = try String(contentsOf: RoomPersistence(root: root).statusURL, encoding: .utf8)
    #expect(json.contains("\"last_poll_ok_at\""))
    #expect(json.contains("\"last_http\""))
    #expect(json.contains("\"last_chunk_uploaded_at\""))
    task.cancel()
    _ = await task.result
  }

  @Test func aRefusedPollSaysItsHTTPCodeAndNeverClaimsAGoodPoll() async throws {
    let root = try RoomRetiredAndMicTests.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let remote = IdentityRecordingRemote(answers: [.retired(), .retired(), .retired()])
    let engine = try await RoomEngine.load(rootURL: root, remoteFactory: { _ in remote }, log: { _ in })
    await engine.setRetiredRepoll(nanoseconds: 60_000_000_000)
    await engine.setMicStateProvider { "authorized" }
    let task = Task { try await engine.run() }
    try await RoomRetiredAndMicTests.waitFor("status retired") {
      RoomRetiredAndMicTests.status(root)?.state == .retired
    }
    let status = try #require(RoomRetiredAndMicTests.status(root))
    #expect(status.lastHTTP == 409)
    #expect(status.lastPollOKAt == nil)
    task.cancel()
    _ = await task.result
  }

  // MARK: - (2) probe-helper

  @Test func probeHelperPrintsOkAndTheVersionOrFailAndTheReason() {
    #expect(
      HelperProbe.line(HelperResponse(ok: true, code: "ok", detail: ["helper_version": "0.2.4-h6"]))
        == HelperProbe.Line(text: "ok 0.2.4-h6", ok: true))
    #expect(HelperProbe.line(nil) == HelperProbe.Line(text: "fail no_answer", ok: false))
    #expect(
      HelperProbe.line(HelperResponse(ok: false, code: "bad_peer", detail: [:]))
        == HelperProbe.Line(text: "fail bad_peer", ok: false))
    // Nothing but a short run of safe characters can leave on the line.
    let noisy = HelperProbe.line(
      HelperResponse(ok: true, code: "ok", detail: ["helper_version": "1.2\nrm -rf /;" + String(repeating: "x", count: 80)]))
    #expect(!noisy.text.contains("\n") && !noisy.text.contains(" -rf") && !noisy.text.contains(";"))
    #expect(noisy.text.count <= 3 + 32)
    #expect(HelperProbe.line(HelperResponse(ok: true, code: "ok", detail: [:])).text == "ok unknown")
    #expect(HelperProbe.timeoutSeconds == 3)
  }

  // MARK: - (3) needs_enrol

  @Test func anInstallWithNoSessionWaitsAndRereadsInsteadOfParking() async throws {
    let root = try Self.prepareRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    final class Reads: @unchecked Sendable {
      let lock = NSLock()
      var count = 0
      var sleeps: [UInt64] = []
      var statesSeenWhileWaiting: [RoomRecorderStatus.State?] = []
    }
    let reads = Reads()
    let record = R4Fixture.enrolled()!
    let reader: @Sendable () -> RoomKeychainRecord? = {
      reads.lock.withLock {
        reads.count += 1
        return reads.count >= 4 ? record : nil
      }
    }
    let configuration = try await RoomEngine.awaitEnrolment(
      rootURL: root, enrolmentReader: reader,
      sleep: { nanoseconds in
        let state = Self.status(root)?.state
        reads.lock.withLock {
          reads.sleeps.append(nanoseconds)
          reads.statesSeenWhileWaiting.append(state)
        }
      })
    #expect(configuration.etaRoomSession == "test.session.jwt")
    #expect(reads.count == 4)
    #expect(reads.sleeps == [300_000_000_000, 300_000_000_000, 300_000_000_000])
    #expect(RoomEngine.enrolmentRereadNanoseconds == 300_000_000_000)
    // While it waited, status.json said needs_enrol.
    #expect(reads.statesSeenWhileWaiting == [.needsEnrol, .needsEnrol, .needsEnrol])
  }

  @Test func anErrorThatIsNotAMissingSessionStillEndsTheWait() async throws {
    let root = R4Fixture.temporaryRoot()  // no config.json at all
    defer { try? FileManager.default.removeItem(at: root) }
    await #expect(throws: Error.self) {
      _ = try await RoomEngine.awaitEnrolment(
        rootURL: root, enrolmentReader: { nil }, sleep: { _ in Issue.record("must not wait on a missing config") })
    }
  }

  @Test func theRetiredExitPathAndTheParkingHelpersAreGone() throws {
    let here = URL(fileURLWithPath: #filePath)
    let package = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    for relative in [
      "Sources/RoomRecorderCLI/main.swift", "Sources/RoomRecorderCore/RoomEngine.swift",
      "Sources/RoomRecorderCore/RoomLaunchAgent.swift", "Sources/RoomRecorderCore/RoomSelfUpdate.swift",
    ] {
      let text = try String(contentsOf: package.appendingPathComponent(relative), encoding: .utf8)
      #expect(!text.contains("parkForever"), "\(relative) still parks")
      #expect(!text.contains("case .retired:"), "\(relative) still has the unreachable retired exit")
      #expect(!text.contains("use ON PURPOSE, to stay"), "\(relative) keeps the stale exit-0 comment")
    }
    #expect(RoomEngineExit.stopped == .stopped)
  }

  // MARK: - (4) retry a day that never started

  @Test func theGovernorAllowsThreeAttemptsPerRollingHour() {
    var governor = StartRetryGovernor()
    let t0 = Date(timeIntervalSince1970: 1_000_000)
    var results: [Bool] = []
    // Three attempts, then refusals (a refusal is not an attempt and spends nothing).
    for offset in [0.0, 60, 120, 180, 3_599] { results.append(governor.permit(now: t0.addingTimeInterval(offset))) }
    #expect(results == [true, true, true, false, false])
    // The first has aged out at t0 + 3600; the 60 s and 120 s ones are still inside the hour.
    results = []
    for offset in [3_600.0, 3_601] { results.append(governor.permit(now: t0.addingTimeInterval(offset))) }
    #expect(results == [true, false])
    #expect(StartRetryGovernor.capPerHour == 3)
  }

  @Test func aRecoveryStartNeedsEveryGate() {
    let schedule = RoomSchedule.defaultClinic
    let inside = Self.ist("2026-09-28", "09:00")
    let windowStart = Int64(Self.ist("2026-09-28", "08:30").timeIntervalSince1970 * 1000)
    func decide(
      now: Date? = nil, phase: RoomEnginePhase = .failed, reconcile: Bool = false, active: Bool = false,
      retired: Bool = false, last: Int64? = nil, disabled: Bool = false, mic: String = "authorized",
      device: RoomEngine.InputReadiness = .ready, governor: inout StartRetryGovernor
    ) -> RecoveryStart.Decision {
      RecoveryStart.decide(
        schedule: schedule, now: now ?? inside, phase: phase, needsReconciliation: reconcile,
        captureActive: active, retired: retired, lastStartedWindowMs: last, disabled: disabled,
        micState: mic, deviceReadiness: device, governor: &governor)
    }
    let start = RecoveryStart.Decision.start(windowStartMs: windowStart)
    var fresh = StartRetryGovernor()
    var got: [RecoveryStart.Decision] = []
    // Each gate, alone, says not due, and none of them spends an attempt.
    got.append(decide(now: Self.ist("2026-09-28", "07:00"), governor: &fresh))  // before the window
    got.append(decide(now: Self.ist("2026-09-28", "21:00"), governor: &fresh))  // after it
    got.append(decide(phase: .recording, governor: &fresh))
    got.append(decide(phase: .paused, governor: &fresh))
    got.append(decide(phase: .ready, governor: &fresh))  // from .ready the engine's own auto-start retries
    got.append(decide(reconcile: true, governor: &fresh))
    got.append(decide(active: true, governor: &fresh))
    got.append(decide(retired: true, governor: &fresh))
    got.append(decide(last: windowStart, governor: &fresh))  // a day already started in this window
    got.append(decide(disabled: true, governor: &fresh))
    got.append(decide(mic: "denied", governor: &fresh))
    got.append(decide(mic: "not_determined", governor: &fresh))
    got.append(decide(device: .notReady, governor: &fresh))
    #expect(got == Array(repeating: .notDue, count: 13))
    // Everything open: it starts. A device that cannot be listed is not a missing device.
    var open = StartRetryGovernor()
    let first = decide(governor: &open)
    let unknown = decide(device: .unknown, governor: &open)
    #expect(first == start)
    #expect(unknown == start)
    // The closed gates above spent nothing: three real attempts pass in total, the fourth is capped.
    var counted = StartRetryGovernor()
    var attempts: [RecoveryStart.Decision] = []
    for _ in 0..<4 { attempts.append(decide(governor: &counted)) }
    #expect(attempts == [start, start, start, .capped])
    let closed = decide(mic: "denied", governor: &counted)  // a closed gate still reads not-due, not capped
    #expect(closed == .notDue)
  }

  /// The desk's start died waiting for a device that was not there (A4 G4). The device comes back inside the window:
  /// the engine starts the day by itself, once the microphone is also authorised.
  @Test func aStartThatDiedOnAMissingDeviceIsRetriedWhenTheDeviceReturns() async throws {
    let root = try Self.prepareRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let remote = R4Remote(
      activeSessionJSON: R4Fixture.idleActiveJSON,
      polls: [#"[{"id":"cmd_start","kind":"start_day","args":{},"created_at":null}]"#])
    let launcher = Launcher([.healthy])
    let room = Room(mic: "denied", devices: [])
    let engine = try await Self.engine(
      root: root, remote: remote, launcher: launcher, room: room,
      inputReadyWait: RoomInputReadyWait(enabled: true, jitterRoll: { 0 }, sleep: { _ in }))
    await engine.setRecoveryCheckEvery(seconds: 0)
    let task = Task { try await engine.run() }
    // The desk's start gives up: the device is not listed.
    try await R4Fixture.waitUntil { Self.status(root)?.state == .failed || Self.status(root)?.state == .micDenied }
    // Auto-start is turned on only now, so the day the desk tried to start is the one being recovered.
    await engine.enableAutoStart(clock: { Self.ist("2026-09-28", "09:00") })
    try await Task.sleep(for: .milliseconds(1_800))
    #expect(await remote.createCalls() == 0)
    #expect(launcher.launches == 0)
    // The device returns but the microphone is still denied: nothing starts.
    room.setDevices(["device-a"])
    try await Task.sleep(for: .milliseconds(1_800))
    #expect(await remote.createCalls() == 0)
    // The microphone comes back: the day starts by itself.
    room.setMic("authorized")
    try await R4Fixture.waitUntil { await remote.createCalls() == 1 }
    try await R4Fixture.waitUntil { Self.status(root)?.state == .recording }
    #expect(launcher.launches == 1)
    #expect(RoomAutoStartMarker(root: root).read() != nil)
    task.cancel()
    _ = await task.result
  }

  /// The engine's own auto-start used to retry a dead start every minute whatever the cause, opening and ending a
  /// server session each time. Now a retry waits for the microphone, and a returning microphone starts the day.
  @Test func aStartThatDiedOnADeniedMicrophoneRetriesOnlyOnceItIsBack() async throws {
    let root = try Self.prepareRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let remote = R4Remote(activeSessionJSON: R4Fixture.idleActiveJSON, polls: [])
    let launcher = Launcher([.dies, .healthy])
    let room = Room(mic: "denied", devices: ["device-a"])
    let engine = try await Self.engine(root: root, remote: remote, launcher: launcher, room: room)
    let clock = Clock(Self.ist("2026-09-28", "09:00"))
    await engine.enableAutoStart(clock: { clock.now })
    await engine.setRecoveryClock { clock.now }
    let task = Task { try await engine.run() }
    // The first attempt of the window runs as before and dies.
    try await R4Fixture.waitUntil { await remote.createCalls() == 1 && launcher.launches == 1 }
    // A minute later, and again: the microphone is still denied, so no second session is opened.
    for _ in 0..<3 {
      clock.advance(61)
      try await Task.sleep(for: .milliseconds(1_800))
    }
    #expect(await remote.createCalls() == 1)
    #expect(launcher.launches == 1)
    // The microphone returns; the next minute's retry starts the day.
    room.setMic("authorized")
    clock.advance(61)
    try await R4Fixture.waitUntil { await remote.createCalls() == 2 }
    try await R4Fixture.waitUntil { Self.status(root)?.state == .recording }
    #expect(launcher.launches == 2)
    task.cancel()
    _ = await task.result
  }

  /// Scoped to a start that dies on the microphone or the device (the launcher exits at once).
  @Test func aFailingStartIsRetriedThreeTimesAnHourNotEveryMinute() async throws {
    let root = try Self.prepareRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let remote = R4Remote(activeSessionJSON: R4Fixture.idleActiveJSON, polls: [])
    let launcher = Launcher([.dies])
    let room = Room(mic: "authorized", devices: ["device-a"])
    let engine = try await Self.engine(root: root, remote: remote, launcher: launcher, room: room)
    let clock = Clock(Self.ist("2026-09-28", "09:00"))
    await engine.enableAutoStart(clock: { clock.now })
    await engine.setRecoveryClock { clock.now }
    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.createCalls() == 1 }
    // Six more minutes of everything being ready: three retries, then the cap holds.
    for minute in 1...6 {
      clock.advance(61)
      try await Task.sleep(for: .milliseconds(1_800))
      #expect(await remote.createCalls() <= 4, "after minute \(minute)")
    }
    #expect(await remote.createCalls() == 4)
    #expect(await engine.startRetryAttemptsLeftForTests(now: clock.now) == 0)
    // The hour rolls: attempts are available again.
    clock.advance(3_600)
    try await R4Fixture.waitUntil { await remote.createCalls() == 5 }
    task.cancel()
    _ = await task.result
  }

  /// The refuter's probe (C2-REFUTE 11): the server is unreachable for about five minutes at clinic open with the
  /// microphone authorised and the device listed. That is not a mic or device failure, so the 0.1.38 retry (every
  /// minute, uncapped) must hold: the day starts within a minute of the network returning, and the hourly cap is untouched.
  @Test func aServerOutageAtOpenKeepsTheUncappedMinuteRetry() async throws {
    let root = try Self.prepareRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let remote = OutageRemote()
    let launcher = Launcher([.healthy])
    let room = Room(mic: "authorized", devices: ["device-a"])
    let engine = try await RoomEngine.load(
      rootURL: root, enrolmentReader: R4Fixture.enrolled, remoteFactory: { _ in remote },
      captureLauncher: launcher, pieceRunner: R4FakeEncoder(), updaterFactory: { _, _, _ in nil },
      log: { _ in }, audioInputs: room, inputReadyWait: .disabled)
    await engine.setMicStateProvider { "authorized" }
    let clock = Clock(Self.ist("2026-09-28", "08:00"))  // before the window
    await engine.enableAutoStart(clock: { clock.now })
    await engine.setRecoveryClock { clock.now }
    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.pollCount() >= 1 }
    await remote.setDown(true)
    clock.advance(3_600)  // 09:00, the window opens, the server is down
    try await R4Fixture.waitUntil { await remote.failedAttempts() >= 1 }
    // Five more minutes of outage: every minute's retry is made (none is capped away) and none creates a session.
    for _ in 0..<5 {
      clock.advance(61)
      try await Task.sleep(for: .milliseconds(1_800))
    }
    #expect(await remote.failedAttempts() >= 5)
    #expect(await remote.creates() == 0)
    // The network returns: the very next minute's retry starts the day.
    await remote.setDown(false)
    clock.advance(61)
    try await R4Fixture.waitUntil { await remote.creates() == 1 }
    try await R4Fixture.waitUntil { Self.status(root)?.state == .recording }
    // Offline spent nothing from the hour's three attempts.
    #expect(await engine.startRetryAttemptsLeftForTests(now: clock.now) == StartRetryGovernor.capPerHour)
    task.cancel()
    _ = await task.result
  }

  @Test func onlyAMicOrDeviceFailureCountsAsOne() {
    #expect(RoomEngine.isMicOrDeviceFailure(RoomEngineError.captureExited(1)))
    #expect(RoomEngine.isMicOrDeviceFailure(RoomEngineError.inputDeviceNotReady("gone")))
    #expect(!RoomEngine.isMicOrDeviceFailure(RoomEngineError.pendingUploads(2)))
    #expect(!RoomEngine.isMicOrDeviceFailure(URLError(.notConnectedToInternet)))
    #expect(!RoomEngine.isMicOrDeviceFailure(RoomEngineError.noActiveSession))
  }

  // MARK: - (5) capture-progress watchdog

  @Test func theWatchdogJudgesOnlyARecordingAndOnlyAfterThreeMinutes() {
    var watchdog = CaptureStallWatchdog()
    let t0 = Date(timeIntervalSince1970: 2_000_000)
    // Paused or no capture: never a stall, however long.
    for second in stride(from: 0, through: 3_600, by: 60) {
      do { let r = watchdog.observe(recording: false, advanced: false, now: t0.addingTimeInterval(Double(second))); #expect(r == .healthy) }
    }
    // Recording: the clock starts at the first look.
    var w = CaptureStallWatchdog()
    do { let r = w.observe(recording: true, advanced: false, now: t0); #expect(r == .healthy) }
    do { let r = w.observe(recording: true, advanced: false, now: t0.addingTimeInterval(179)); #expect(r == .healthy) }
    do { let r = w.observe(recording: true, advanced: false, now: t0.addingTimeInterval(180)); #expect(r == .stalled(repeated: false)) }
    // Growth resets the clock.
    var grows = CaptureStallWatchdog()
    _ = grows.observe(recording: true, advanced: false, now: t0)
    do { let r = grows.observe(recording: true, advanced: true, now: t0.addingTimeInterval(170)); #expect(r == .healthy) }
    do { let r = grows.observe(recording: true, advanced: false, now: t0.addingTimeInterval(340)); #expect(r == .healthy) }
    do { let r = grows.observe(recording: true, advanced: false, now: t0.addingTimeInterval(351)); #expect(r == .stalled(repeated: false)) }
    // A pause in the middle forgets the clock.
    var paused = CaptureStallWatchdog()
    _ = paused.observe(recording: true, advanced: false, now: t0)
    _ = paused.observe(recording: false, advanced: false, now: t0.addingTimeInterval(100))
    do { let r = paused.observe(recording: true, advanced: false, now: t0.addingTimeInterval(200)); #expect(r == .healthy) }
    #expect(CaptureStallWatchdog.stallSeconds == 180)
  }

  @Test func aSecondStallWithinTheHourIsARepeatAndALaterOneIsNot() {
    var w = CaptureStallWatchdog()
    let t0 = Date(timeIntervalSince1970: 2_000_000)
    _ = w.observe(recording: true, advanced: false, now: t0)
    do { let r = w.observe(recording: true, advanced: false, now: t0.addingTimeInterval(180)); #expect(r == .stalled(repeated: false)) }
    // The restarted owner gets a fresh 3 minutes.
    do { let r = w.observe(recording: true, advanced: false, now: t0.addingTimeInterval(359)); #expect(r == .healthy) }
    do { let r = w.observe(recording: true, advanced: false, now: t0.addingTimeInterval(360)); #expect(r == .stalled(repeated: true)) }
    // Still stalled over an hour after the last restart: the earlier restarts have aged out, so it is a first again.
    let late = w.observe(recording: true, advanced: false, now: t0.addingTimeInterval(360 + 3_700))
    #expect(late == .stalled(repeated: false))
  }

  /// Starts an engine that adopts an open session whose capture freezes, and returns what the tests need.
  private func frozenSession(
    script: [Behaviour], exitWaitNanoseconds: UInt64 = 200_000_000
  ) async throws -> (root: URL, engine: RoomEngine, remote: R4Remote, launcher: Launcher, clock: Clock, task: Task<Void, Error>) {
    let root = try Self.prepareRoot()
    let remote = R4Remote(activeSessionJSON: R4Fixture.recordingActiveJSON, polls: [])
    let launcher = Launcher(script)
    let room = Room(mic: "authorized", devices: ["device-a"])
    let engine = try await Self.engine(root: root, remote: remote, launcher: launcher, room: room)
    let clock = Clock(Date())
    await engine.setRecoveryClock { clock.now }
    await engine.setStalledCaptureExitWait(nanoseconds: exitWaitNanoseconds)
    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { launcher.launches == 1 }
    try await R4Fixture.waitUntil { Self.status(root)?.state == .recording }
    // One loop pass so the watchdog has taken its first look at the open capture.
    try await Task.sleep(for: .milliseconds(1_700))
    return (root, engine, remote, launcher, clock, task)
  }

  @Test func aStalledCaptureIsRestartedUnderTheSameOpenSession() async throws {
    let s = try await frozenSession(script: [.frozen, .frozen])
    defer { try? FileManager.default.removeItem(at: s.root) }
    s.clock.advance(181)
    try await R4Fixture.waitUntil { s.launcher.launches == 2 }
    try await R4Fixture.waitUntil { Self.status(s.root)?.state == .captureStalled }
    let stalled = try #require(Self.status(s.root))
    // The same session stays open: still capture_open, same id, nothing ended or paused, nothing created.
    #expect(stalled.sessionID == "bs_r4")
    #expect(stalled.captureOpen == true)
    #expect(await s.remote.patchedActions().isEmpty)
    #expect(await s.remote.createCalls() == 0)
    #expect(stalled.lastEvent == "capture_stalled")
    #expect(stalled.lastError?.contains("capture stalled") == true)
    // The cut segment's audio reached the server under that session.
    #expect(await s.remote.uploadedPieces().allSatisfy { $0.sessionID == "bs_r4" })
    s.task.cancel()
    _ = await s.task.result
  }

  @Test func aStallThatComesBackIsFlaggedAsARepeat() async throws {
    let s = try await frozenSession(script: [.frozen, .frozen, .frozen])
    defer { try? FileManager.default.removeItem(at: s.root) }
    s.clock.advance(181)
    try await R4Fixture.waitUntil { s.launcher.launches == 2 }
    #expect(Self.status(s.root)?.lastEvent == "capture_stalled")
    try await Task.sleep(for: .milliseconds(1_700))
    s.clock.advance(181)
    try await R4Fixture.waitUntil { s.launcher.launches == 3 }
    try await R4Fixture.waitUntil { Self.status(s.root)?.lastEvent == "capture_stall_repeat" }
    #expect(Self.status(s.root)?.state == .captureStalled)
    #expect(await s.remote.patchedActions().isEmpty)
    s.task.cancel()
    _ = await s.task.result
  }

  @Test func theStalledStateClearsWhenTheTapeGrowsAgain() async throws {
    let s = try await frozenSession(script: [.frozen, .healthy])
    defer { try? FileManager.default.removeItem(at: s.root) }
    s.clock.advance(181)
    try await R4Fixture.waitUntil { s.launcher.launches == 2 }
    // The restart is reported as a stall first ...
    try await R4Fixture.waitUntil { Self.status(s.root)?.state == .captureStalled }
    // ... and the second capture is healthy: once its tape has grown between two looks, the state is recording again.
    try await R4Fixture.waitUntil { Self.status(s.root)?.state == .recording }
    #expect(Self.status(s.root)?.captureOpen == true)
    #expect(Self.status(s.root)?.sessionID == "bs_r4")
    s.task.cancel()
    _ = await s.task.result
  }

  @Test func aCaptureThatIgnoresItsInterruptIsKilledAndRestarted() async throws {
    let s = try await frozenSession(script: [.deaf, .healthy], exitWaitNanoseconds: 300_000_000)
    defer { try? FileManager.default.removeItem(at: s.root) }
    s.clock.advance(181)
    try await R4Fixture.waitUntil { s.launcher.launches == 2 }
    #expect(s.launcher.frozen.first?.forceStops == 1)
    try await R4Fixture.waitUntil { Self.status(s.root)?.state == .recording }
    #expect(Self.status(s.root)?.sessionID == "bs_r4")
    s.task.cancel()
    _ = await s.task.result
  }

  /// R1 from 0.1.38 holds beside the watchdog: a 409 RETIRED never stops a recording, and a retired install whose tape
  /// froze is still restarted (the capture, not the process).
  @Test func aRetiredInstallWithAFrozenTapeKeepsItsSessionAndIsStillRestarted() async throws {
    let root = try Self.prepareRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let remote = ResidentFreeRetiredRemote()
    let launcher = Launcher([.frozen, .frozen])
    let room = Room(mic: "authorized", devices: ["device-a"])
    let engine = try await RoomEngine.load(
      rootURL: root, enrolmentReader: R4Fixture.enrolled, remoteFactory: { _ in remote },
      captureLauncher: launcher, pieceRunner: R4FakeEncoder(), updaterFactory: { _, _, _ in nil },
      log: { _ in }, audioInputs: room, inputReadyWait: .disabled)
    await engine.setMicStateProvider { "authorized" }
    await engine.setRetiredRepoll(nanoseconds: 120_000_000_000)
    let clock = Clock(Date())
    await engine.setRecoveryClock { clock.now }
    await engine.setStalledCaptureExitWait(nanoseconds: 200_000_000)
    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { launcher.launches == 1 }
    try await R4Fixture.waitUntil { Self.status(root)?.state == .retired }
    try await Task.sleep(for: .milliseconds(1_700))
    clock.advance(181)
    try await R4Fixture.waitUntil { launcher.launches == 2 }
    let status = try #require(Self.status(root))
    #expect(status.state == .retired)  // retired outranks capture_stalled
    #expect(status.captureOpen == true)
    #expect(status.sessionID == "bs_r4")
    #expect(await remote.patches.isEmpty)
    task.cancel()
    _ = await task.result
  }
}

/// Answers the first poll 200 so the session is adopted and recording, then 409 RETIRED for ever.
actor ResidentFreeRetiredRemote: RoomEngineRemote {
  private var polls = 0
  private(set) var patches: [BenchSessionAction] = []

  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
    try JSONDecoder().decode(
      ActiveSessionResponse.self, from: Data(R4Fixture.recordingActiveJSON.utf8))
  }
  func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
    throw CancellationError()
  }
  func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws -> BenchOKResponse {
    patches.append(action)
    return try JSONDecoder().decode(BenchOKResponse.self, from: Data(#"{"ok":true}"#.utf8))
  }
  func pollCommands(
    tabID: String, previousPollAt: String?, recordingSessionID: String?, paused: Bool,
    primaryLevels: BenchLevelPair?, install: InstallPollFields?
  ) async throws -> CommandPollResponse {
    polls += 1
    if polls == 1 {
      return try JSONDecoder().decode(
        CommandPollResponse.self,
        from: Data(#"{"ok":true,"room_id":"room_1","superseded":false,"commands":[]}"#.utf8))
    }
    throw BenchClientError.http(
      BenchHTTPError(
        statusCode: 409, body: #"{"ok":false,"error":{"code":"RETIRED","message":"install retired"}}"#,
        retention: .notApplicable))
  }
  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  { throw CancellationError() }
  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse {
    throw CancellationError()
  }
  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws -> ImmutablePieceUploadResult {
    throw CancellationError()
  }
}

/// An idle server that can be taken down: while down, reading or creating a session fails like a lost network.
actor OutageRemote: RoomEngineRemote {
  private var down = false
  private var polls = 0
  private var failed = 0
  private var created = 0

  func setDown(_ value: Bool) { down = value }
  func pollCount() -> Int { polls }
  func failedAttempts() -> Int { failed }
  func creates() -> Int { created }

  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
    if down {
      failed += 1
      throw URLError(.notConnectedToInternet)
    }
    return try JSONDecoder().decode(ActiveSessionResponse.self, from: Data(R4Fixture.idleActiveJSON.utf8))
  }
  func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
    if down {
      failed += 1
      throw URLError(.notConnectedToInternet)
    }
    created += 1
    return try JSONDecoder().decode(
      CreateSessionResponse.self,
      from: Data(
        #"{"session":{"id":"bs_new","room_id":"room_1","label":null,"mic_label":"device-a","status":"recording"}}"#.utf8))
  }
  func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws -> BenchOKResponse {
    try JSONDecoder().decode(BenchOKResponse.self, from: Data(#"{"ok":true}"#.utf8))
  }
  func pollCommands(
    tabID: String, previousPollAt: String?, recordingSessionID: String?, paused: Bool,
    primaryLevels: BenchLevelPair?, install: InstallPollFields?
  ) async throws -> CommandPollResponse {
    polls += 1
    return try JSONDecoder().decode(
      CommandPollResponse.self,
      from: Data(#"{"ok":true,"room_id":"room_1","superseded":false,"commands":[]}"#.utf8))
  }
  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  { throw CancellationError() }
  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse { throw CancellationError() }
  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws -> ImmutablePieceUploadResult {
    .alreadyVerified
  }
}
