import CryptoKit
import Foundation
import Testing

@testable import RoomRecorderCore

/// 0.1.25 item 6 — the acoustic self-test: pack pinning, the gate, the runner over a fake speaker,
/// and the `self_test` command through the engine. No sound is played anywhere in this file.
private func ist(_ day: String, _ hhmm: String) -> Date {
  ISO8601DateFormatter().date(from: "\(day)T\(hhmm):00+05:30")!
}

private func sha(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

/// A pack of four tiny files with correct hashes. Returns its directory.
private func makePack(
  mutate: (inout [[String: Any]], URL) throws -> Void = { _, _ in }
) throws -> URL {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pack-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  var entries: [[String: Any]] = []
  for (id, kind) in [("tone-1k", "tone"), ("sweep", "sweep"), ("canary-1", "canary"), ("phrase-en-1", "phrase")] {
    let bytes = Data("wav-bytes-\(id)".utf8)
    try bytes.write(to: dir.appendingPathComponent("\(id).wav"))
    var entry: [String: Any] = ["id": id, "kind": kind, "file": "\(id).wav", "sha256": sha(bytes), "duration_s": 2.0]
    if kind == "canary" || kind == "phrase" { entry["lang"] = "en"; entry["truth"] = "invented text" }
    entries.append(entry)
  }
  try mutate(&entries, dir)
  let body = try JSONSerialization.data(withJSONObject: ["pack_version": 1, "stimuli": entries])
  try body.write(to: dir.appendingPathComponent("pack.json"))
  return dir
}

final class FakeSpeaker: SelfTestPlaying, @unchecked Sendable {
  private let lock = NSLock()
  private var _events: [String] = []
  var failOn: String?
  /// Plays for ever (until cancelled): a wedged speaker.
  var hangOn: String?
  var events: [String] { lock.withLock { _events } }
  private func note(_ e: String) { lock.withLock { _events.append(e) } }
  func prepare(volume: Double) throws -> SelfTestSpeakerState {
    note("prepare:\(volume)")
    return SelfTestSpeakerState(deviceUID: "builtin-speaker", previousVolume: 0.25)
  }
  func play(file: URL) async throws {
    let name = file.deletingPathExtension().lastPathComponent
    note("play:\(name)")
    if name == failOn { throw SelfTestError.noBuiltInSpeaker }
    if name == hangOn { try await Task.sleep(nanoseconds: 3_600_000_000_000) }
    try await Task.sleep(nanoseconds: 20_000_000)
  }
  func restore(_ state: SelfTestSpeakerState) { note("restore:\(state.previousVolume ?? -1)") }
}

@Suite struct SelfTestPackTests {
  @Test func aGoodPackLoadsInOrderAndIsHashVerified() throws {
    let dir = try makePack()
    let pack = try SelfTestPack.load(directory: dir)
    #expect(pack.map(\.id) == ["tone-1k", "sweep", "canary-1", "phrase-en-1"])
    #expect(pack.map(\.kind) == ["tone", "sweep", "canary", "phrase"])
    #expect(SelfTestPack.packHash(directory: dir)?.count == 64)
  }

  @Test func aTamperedFileRefusesTheWholePack() throws {
    let dir = try makePack()
    try Data("changed".utf8).write(to: dir.appendingPathComponent("sweep.wav"))
    #expect(throws: SelfTestPackError.hashMismatch("sweep")) { try SelfTestPack.load(directory: dir) }
  }

  @Test func missingUnreadableWrongVersionAndBadEntriesAreRefused() throws {
    let empty = FileManager.default.temporaryDirectory.appendingPathComponent("nopack-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: empty, withIntermediateDirectories: true)
    #expect(throws: SelfTestPackError.missingPack) { try SelfTestPack.load(directory: empty) }

    try Data("not json".utf8).write(to: empty.appendingPathComponent("pack.json"))
    #expect(throws: SelfTestPackError.unreadablePack) { try SelfTestPack.load(directory: empty) }

    try Data(#"{"pack_version":2,"stimuli":[{}]}"#.utf8).write(to: empty.appendingPathComponent("pack.json"))
    #expect(throws: SelfTestPackError.unknownPackVersion(2)) { try SelfTestPack.load(directory: empty) }

    try Data(#"{"pack_version":1,"stimuli":[]}"#.utf8).write(to: empty.appendingPathComponent("pack.json"))
    #expect(throws: SelfTestPackError.emptyPack) { try SelfTestPack.load(directory: empty) }

    let unknownKind = try makePack { entries, _ in entries[0]["kind"] = "music" }
    #expect(throws: SelfTestPackError.badEntry("tone-1k")) { try SelfTestPack.load(directory: unknownKind) }

    let traversal = try makePack { entries, _ in entries[0]["file"] = "../etc/passwd" }
    #expect(throws: SelfTestPackError.badEntry("tone-1k")) { try SelfTestPack.load(directory: traversal) }

    let duplicate = try makePack { entries, _ in entries[1]["id"] = "tone-1k" }
    #expect(throws: SelfTestPackError.badEntry("tone-1k")) { try SelfTestPack.load(directory: duplicate) }
  }
}

@Suite struct SelfTestGateTests {
  let clinic = RoomSchedule.defaultClinic
  let inside = ist("2026-09-28", "10:00")
  let outside = ist("2026-09-28", "21:00")

  @Test func aSessionOpenAlwaysRefuses() {
    for slug in ["home-office", "opd-4-ortho-778q"] {
      for now in [inside, outside] {
        #expect(SelfTestGate.refusal(sessionOpen: true, alreadyRunning: false, now: now, schedule: clinic, roomSlug: slug) == "session_open")
      }
    }
  }

  @Test func aClinicRoomIsRefusedInsideItsWindowAndAllowedOutside() {
    #expect(SelfTestGate.refusal(sessionOpen: false, alreadyRunning: false, now: inside, schedule: clinic, roomSlug: "opd-4-ortho-778q") == "clinic_hours")
    #expect(SelfTestGate.refusal(sessionOpen: false, alreadyRunning: false, now: outside, schedule: clinic, roomSlug: "opd-4-ortho-778q") == nil)
  }

  /// eta-refuter B2: only `.ready` (no capture, no reconciliation pending) may be tested; a `.failed`
  /// room can hold a session the next loop re-adopts.
  @Test func aRoomThatIsNotReadyIsRefused() {
    #expect(SelfTestGate.refusal(sessionOpen: false, alreadyRunning: false, ready: false, now: outside, schedule: clinic, roomSlug: "home-office-w8fb") == "not_ready")
  }

  @Test func theHomeOfficeKioskIsATestRoomAtAnyHour() {
    #expect(SelfTestGate.refusal(sessionOpen: false, alreadyRunning: false, now: inside, schedule: clinic, roomSlug: "home-office-w8fb") == nil)
    #expect(SelfTestGate.refusal(sessionOpen: false, alreadyRunning: true, now: inside, schedule: clinic, roomSlug: "home-office-w8fb") == "self_test_running")
  }
}

@Suite(.serialized) struct SelfTestRunnerTests {
  private func runner(_ speaker: FakeSpeaker, _ pack: [SelfTestStimulus], _ launcher: R4FakeLauncher) -> SelfTestRunner {
    SelfTestRunner(
      pack: pack, packSHA256: "abc", player: speaker, launcher: launcher,
      tapewriter: URL(fileURLWithPath: "/usr/bin/false"), micDeviceUID: "device-a",
      roomSlug: "home-office", appVersion: "0.1.25", volume: 0.5, leadSeconds: 0.05,
      gapSeconds: 0.02, log: { _ in })
  }

  @Test func aRunPlaysThePackInOrderAtTheFixedVolumeRecordsAndRestores() async throws {
    let pack = try SelfTestPack.load(directory: try makePack())
    let speaker = FakeSpeaker()
    let launcher = R4FakeLauncher()
    let dir = R4Fixture.temporaryRoot()
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }

    let manifest = await runner(speaker, pack, launcher).run(runID: "st_test", directory: dir).manifest

    #expect(manifest.outcome == "complete")
    #expect(manifest.stimuli.map(\.id) == pack.map(\.id))
    #expect(manifest.stimuli.map(\.sha256) == pack.map(\.sha256))
    #expect(speaker.events == ["prepare:0.5"] + pack.map { "play:\($0.id)" } + ["restore:0.25"])
    #expect(manifest.speakerVolume == 0.5)
    #expect(manifest.previousSpeakerVolume == 0.25)
    #expect(launcher.launchedDevices == ["device-a"])
    #expect(launcher.runningDevices.isEmpty)  // capture stopped
    // Each stimulus sits inside the capture window, in order, without overlap.
    var last = manifest.captureStartWallNS
    for played in manifest.stimuli {
      #expect(played.startWallNS >= last && played.endWallNS > played.startWallNS)
      last = played.endWallNS
    }
    #expect(last <= manifest.captureEndWallNS)
    #expect(manifest.pcmBytes >= 0)
    let written = try JSONDecoder().decode(SelfTestManifest.self, from: Data(contentsOf: dir.appendingPathComponent("manifest.json")))
    #expect(written == manifest)
  }

  /// eta-refuter B3: a wedged speaker must not hold the room. The run ends at its deadline, stops the
  /// capture, restores the volume and says so.
  @Test func aHungSpeakerEndsAtTheDeadline() async throws {
    let pack = try SelfTestPack.load(directory: try makePack())
    let speaker = FakeSpeaker()
    speaker.hangOn = "sweep"
    let launcher = R4FakeLauncher()
    let dir = R4Fixture.temporaryRoot()
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    var r = runner(speaker, pack, launcher)
    r = SelfTestRunner(
      pack: pack, packSHA256: nil, player: speaker, launcher: launcher,
      tapewriter: URL(fileURLWithPath: "/usr/bin/false"), micDeviceUID: "device-a",
      roomSlug: "home-office", appVersion: nil, volume: 0.5, leadSeconds: 0.02, gapSeconds: 0.02,
      maxSeconds: 0.5, log: { _ in })
    let started = Date()
    let manifest = await r.run(runID: "st_hang", directory: dir).manifest
    #expect(Date().timeIntervalSince(started) < 10)
    #expect(manifest.outcome.contains("timedOut"))
    #expect(manifest.stimuli.isEmpty || manifest.stimuli.map(\.id) == ["tone-1k"])
    #expect(launcher.runningDevices.isEmpty)
    #expect(speaker.events.last == "restore:0.25")
  }

  /// eta-refuter R1: a capture that ignores its interrupt is handed back so the engine can keep the
  /// mic claimed; a capture that exits is not.
  @Test func aCaptureThatWillNotExitIsHandedBackAndOneThatExitsIsNot() async throws {
    let pack = try SelfTestPack.load(directory: try makePack())
    let dir = R4Fixture.temporaryRoot()
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let speaker = FakeSpeaker()
    let stubborn = StubbornLauncher()
    let r = SelfTestRunner(
      pack: [pack[0]], packSHA256: nil, player: speaker, launcher: stubborn,
      tapewriter: URL(fileURLWithPath: "/usr/bin/false"), micDeviceUID: "device-a",
      roomSlug: "home-office", appVersion: nil, volume: 0.5, leadSeconds: 0.02, gapSeconds: 0.02,
      maxSeconds: 30, log: { _ in })
    let outcome = await r.run(runID: "st_stuck", directory: dir)
    #expect(outcome.lingering?.isRunning == true)
    stubborn.process.finish()
    #expect(outcome.lingering?.isRunning == false)

    let clean = await runner(speaker, [pack[0]], R4FakeLauncher()).run(runID: "st_ok", directory: dir)
    #expect(clean.lingering == nil)
  }

  @Test func aFailurePartWayStopsTheCaptureRestoresTheSpeakerAndSaysSo() async throws {
    let pack = try SelfTestPack.load(directory: try makePack())
    let speaker = FakeSpeaker()
    speaker.failOn = "canary-1"
    let launcher = R4FakeLauncher()
    let dir = R4Fixture.temporaryRoot()
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }

    let manifest = await runner(speaker, pack, launcher).run(runID: "st_fail", directory: dir).manifest

    #expect(manifest.outcome.hasPrefix("failed"))
    #expect(manifest.stimuli.map(\.id) == ["tone-1k", "sweep"])
    #expect(launcher.runningDevices.isEmpty)
    #expect(speaker.events.last == "restore:0.25")
    #expect(FileManager.default.fileExists(atPath: dir.appendingPathComponent("manifest.json").path))
  }
}

@Suite(.serialized) struct SelfTestEngineTests {
  private func engine(
    slug: String, polls: [String], activeJSON: String, clock: Date, root: URL, speaker: FakeSpeaker
  ) async throws -> (RoomEngine, R4Remote, R4FakeLauncher, URL) {
    var config = try R4Fixture.configuration()
    config.roomSlug = slug
    try RoomPersistence(root: root).saveConfiguration(config)
    let remote = R4Remote(activeSessionJSON: activeJSON, polls: polls)
    let launcher = R4FakeLauncher()
    let pack = try makePack()
    let engine = try await RoomEngine.load(
      rootURL: root, enrolmentReader: R4Fixture.enrolled, remoteFactory: { _ in remote },
      captureLauncher: launcher, pieceRunner: R4FakeEncoder(), updaterFactory: { _, _, _ in nil },
      log: { _ in })
    await engine.configureSelfTestForTests(pack: pack, speaker: speaker, clock: clock)
    return (engine, remote, launcher, pack)
  }

  private func cmd(_ json: String = "{}") -> String {
    #"[{"id":"cmd_st","kind":"self_test","args":\#(json),"created_at":null}]"#
  }

  @Test func theHomeOfficeKioskRunsItInsideClinicHoursAndWritesAManifest() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let speaker = FakeSpeaker()
    let (engine, remote, launcher, _) = try await engine(
      slug: "home-office", polls: [cmd()], activeJSON: R4Fixture.idleActiveJSON,
      clock: ist("2026-09-28", "10:00"), root: root, speaker: speaker)
    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.reached(acks: 1, polls: 1) }
    let runsLog = root.appendingPathComponent("selftest/runs.log")
    for _ in 0..<600 where !FileManager.default.fileExists(atPath: runsLog.path) {
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    task.cancel()
    try await task.value

    let ack = try #require(await remote.acknowledgements().first)
    #expect(ack.ok)
    #expect(ack.sessionID == nil)
    #expect(launcher.launchedDevices == ["device-a"])
    let runs = try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("selftest").path)
    let runDir = try #require(runs.first(where: { $0.hasPrefix("st_") }))
    #expect(FileManager.default.fileExists(atPath: root.appendingPathComponent("selftest/\(runDir)/manifest.json").path))
    #expect(await remote.createCalls() == 0)  // never a session
    #expect(speaker.events.first == "prepare:0.5" && speaker.events.last?.hasPrefix("restore") == true)
    #expect(FileManager.default.fileExists(atPath: root.appendingPathComponent("selftest/runs.log").path))
  }

  @Test func aClinicRoomInsideItsWindowIsRefusedAndPlaysNothing() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let speaker = FakeSpeaker()
    let (engine, remote, launcher, _) = try await engine(
      slug: "opd-4-ortho-778q", polls: [cmd()], activeJSON: R4Fixture.idleActiveJSON,
      clock: ist("2026-09-28", "10:00"), root: root, speaker: speaker)
    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.reached(acks: 1, polls: 1) }
    task.cancel()
    try await task.value
    let ack = try #require(await remote.acknowledgements().first)
    #expect(!ack.ok)
    #expect(ack.error == "clinic_hours")
    #expect(speaker.events.isEmpty)
    #expect(launcher.launchedDevices.isEmpty)
  }

  @Test func aSessionOpenIsRefusedEvenForTheKioskAndNothingIsPlayed() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let speaker = FakeSpeaker()
    let (engine, remote, launcher, _) = try await engine(
      slug: "home-office", polls: [cmd()], activeJSON: R4Fixture.recordingActiveJSON,
      clock: ist("2026-09-28", "22:00"), root: root, speaker: speaker)
    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.reached(acks: 1, polls: 1) }
    task.cancel()
    try await task.value
    let ack = try #require(await remote.acknowledgements().first)
    #expect(!ack.ok)
    #expect(ack.error == "capture_active" || ack.error == "session_open")
    #expect(speaker.events.isEmpty)
    #expect(launcher.launchedDevices == ["device-a"])  // only the patient capture
  }

  @Test func aTamperedPackIsRefusedByName() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let speaker = FakeSpeaker()
    let (engine, remote, _, pack) = try await engine(
      slug: "home-office", polls: [cmd()], activeJSON: R4Fixture.idleActiveJSON,
      clock: ist("2026-09-28", "22:00"), root: root, speaker: speaker)
    try Data("changed".utf8).write(to: pack.appendingPathComponent("tone-1k.wav"))
    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.reached(acks: 1, polls: 1) }
    task.cancel()
    try await task.value
    let ack = try #require(await remote.acknowledgements().first)
    #expect(!ack.ok)
    #expect(ack.error?.hasPrefix("pack_invalid") == true)
    #expect(speaker.events.isEmpty)
  }
}

/// Opt-in: the REAL pack diar-lab produced. `ETA_SELFTEST_PACK=<dir>` (a folder with pack.json and
/// the WAVs). Proves the loader accepts the shipped layout and every pinned hash.
@Suite struct SelfTestRealPackTests {
  @Test(.enabled(if: ProcessInfo.processInfo.environment["ETA_SELFTEST_PACK"] != nil))
  func theRealPackLoadsAndEveryHashHolds() throws {
    let dir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["ETA_SELFTEST_PACK"]!)
    let pack = try SelfTestPack.load(directory: dir)
    #expect(pack.count == 17)
    #expect(pack.first?.id == "tone-1k")
    #expect(pack.filter { $0.kind == "canary" }.count == 3)
    #expect(pack.filter { $0.kind == "phrase" }.count == 12)
    #expect(SelfTestPack.packHash(directory: dir)?.hasPrefix("57d9bfbc") == true)
  }
}

@Suite struct AutoStartOptInTests {
  /// eta-refuter B1: auto-start is opt-in per Mac. No file, no auto-start.
  @Test func aMacIsOptedInOnlyByTheFile() throws {
    let root = R4Fixture.temporaryRoot()
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let marker = RoomAutoStartMarker(root: root)
    #expect(!marker.optedIn())
    FileManager.default.createFile(atPath: root.appendingPathComponent("auto-start-on").path, contents: Data())
    #expect(marker.optedIn())
  }

  @Test func theDietaryRoomIsNeverAutoStartedWhateverItsSlugSays() {
    #expect(RoomAutoStart.disabledBySlug("room-4-1-after-cards-before-5-494q"))
    #expect(RoomAutoStart.disabledBySlug("dietary-x"))
    #expect(!RoomAutoStart.disabledBySlug("home-office-w8fb"))
  }
}

/// A capture process that writes something to tape.pcm and then ignores interrupt().
final class StubbornProcess: RoomCaptureProcess, @unchecked Sendable {
  private let lock = NSLock()
  private var running = true
  var isRunning: Bool { lock.withLock { running } }
  var terminationStatus: Int32? { lock.withLock { running ? nil : 0 } }
  func interrupt() {}
  func waitUntilExit() { while isRunning { Thread.sleep(forTimeInterval: 0.002) } }
  func finish() { lock.withLock { running = false } }
}

final class StubbornLauncher: RoomCaptureLaunching, @unchecked Sendable {
  let process = StubbornProcess()
  func launch(executable: URL, outputDirectory: URL, deviceUID: String, logURL: URL) throws
    -> any RoomCaptureProcess
  {
    FileManager.default.createFile(
      atPath: outputDirectory.appendingPathComponent("tape.pcm").path, contents: Data(count: 100))
    return process
  }
}
