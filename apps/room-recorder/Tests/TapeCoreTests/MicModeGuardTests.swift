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
