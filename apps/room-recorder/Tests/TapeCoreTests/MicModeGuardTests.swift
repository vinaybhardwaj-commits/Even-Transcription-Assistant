import Foundation
import Testing

@testable import TapeCapture

private final class FakeMicModeAPI: MicModeAPI, @unchecked Sendable {
  var isAvailable = true
  var modes: [String: Int] = [:]
  var activeModes: [String: Int] = [:]
  var supports: Bool? = true
  var setResult = 1
  var setError: String?
  var setCalls: [String] = []

  func preferredMode(bundleID: String) -> Int { modes[bundleID] ?? 0 }
  func activeMode(bundleID: String) -> Int { activeModes[bundleID] ?? 0 }
  func supportsStandard(bundleID: String) -> Bool? { supports }
  func setStandard(bundleID: String) -> (result: Int, error: String?) {
    setCalls.append(bundleID)
    if setResult == 1 { modes[bundleID] = 0 }
    return (setResult, setError)
  }
}

@Suite struct MicModeGuardTests {
  @Test func testMissingSymbolsIsNoOp() {
    let api = FakeMicModeAPI()
    api.isAvailable = false
    api.modes["a"] = 2
    #expect(MicModeGuard.enforceStandard(ids: ["a"], api: api, log: { _ in }).isEmpty)
    #expect(api.setCalls.isEmpty)
  }

  @Test func testRealShimDoesNotCrash() {
    // Real dlopen path; on any macOS this must return without throwing.
    _ = SystemMicModeAPI().isAvailable
    _ = SystemMicModeAPI().preferredMode(bundleID: "com.example.nonexistent")
  }

  @Test func testSetSkippedWhenAlreadyStandard() {
    let api = FakeMicModeAPI()
    api.modes["a"] = 0
    MicModeGuard.enforceStandard(ids: ["a"], api: api, log: { _ in })
    #expect(api.setCalls.isEmpty)
  }

  @Test func testSetSkippedWhenStandardUnsupported() {
    let api = FakeMicModeAPI()
    api.modes["a"] = 2
    api.supports = false
    MicModeGuard.enforceStandard(ids: ["a"], api: api, log: { _ in })
    #expect(api.setCalls.isEmpty)
  }

  @Test func testSetCalledOnceWhenVoiceIsolation() {
    let api = FakeMicModeAPI()
    api.modes["a"] = 2
    var lines: [String] = []
    let reports = MicModeGuard.enforceStandard(ids: ["a"], api: api, log: { lines.append($0) })
    #expect(api.setCalls == ["a"])
    #expect(reports.first?.after == 0)
    #expect(lines == ["micmode before=2 set=1 after=0 bundle=a"])
  }

  @Test func testSetCalledWhenSupportedListUnreadable() {
    let api = FakeMicModeAPI()
    api.modes["a"] = 2
    api.supports = nil
    MicModeGuard.enforceStandard(ids: ["a"], api: api, log: { _ in })
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
    let reports = MicModeGuard.enforceStandard(ids: ["a"], api: api, log: { _ in })
    #expect(reports.first?.setResult == -1)
    #expect(reports.first?.error == "NSInvalidArgumentException")
  }

  @Test func testWatchdogThrottlesToOncePerTenMinutes() {
    let api = FakeMicModeAPI()
    api.activeModes["com.evenscribe.room-recorder"] = 2
    var watchdog = MicModeWatchdog(
      mainBundleID: "com.evenscribe.room-recorder.tapewriter", api: api, log: { _ in })
    let s: UInt64 = 1_000_000_000
    let r0 = watchdog.tick(nowNS: 0)
    #expect(!r0)
    let r30xs = watchdog.tick(nowNS: 30 * s)
    #expect(!r30xs)
    let r60xs = watchdog.tick(nowNS: 60 * s)
    #expect(r60xs)
    let r120xs = watchdog.tick(nowNS: 120 * s)
    #expect(!r120xs)
    let r600xs = watchdog.tick(nowNS: 600 * s)
    #expect(!r600xs)
    let r660xs = watchdog.tick(nowNS: 660 * s)
    #expect(r660xs)
  }

  @Test func testWatchdogQuietWhenStandard() {
    let api = FakeMicModeAPI()
    var watchdog = MicModeWatchdog(mainBundleID: "com.x", api: api, log: { _ in })
    let r0 = watchdog.tick(nowNS: 0)
    #expect(!r0)
    let r61000000000 = watchdog.tick(nowNS: 61_000_000_000)
    #expect(!r61000000000)
    #expect(api.setCalls.isEmpty)
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
    MicModeGuard.enforceStandard(ids: ["a"], api: api, log: { lines.append($0) })
    #expect(api.setCalls.isEmpty)
    #expect(lines == ["micmode before=unreadable set=skip bundle=a"])
  }
}
