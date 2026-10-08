#if canImport(RoomRecorderCore)
  import Foundation
  import Testing
  @testable import RoomRecorderCore
  @testable import TapeCapture

  /// Arch #17. Swift was NOT compiled where this was written (no toolchain on the build box).
  @Suite struct InputDeviceReadyTests {
    private let mic = AudioInputDeviceEntry(name: "USB mic", uid: "uid-1", isDefault: false)

    @Test func readinessReadsTheConfiguredDevice() {
      #expect(RoomEngine.inputReadiness(devices: [mic], uid: "uid-1") == .ready)
      #expect(RoomEngine.inputReadiness(devices: [mic], uid: "uid-2") == .notReady)
      #expect(RoomEngine.inputReadiness(devices: [], uid: "uid-1") == .notReady)
    }

    @Test func notBeingAbleToLookNeverBlocksAStart() {
      #expect(RoomEngine.inputReadiness(devices: nil, uid: "uid-1") == .unknown)
      #expect(RoomEngine.inputReadiness(devices: [mic], uid: "") == .unknown)
    }

    @Test func backoffDoublesAndJitterSpreadsRooms() {
      let flat = RoomEngine.inputReadyDelays(jitterRoll: 0)
      #expect(flat == [1, 2, 4, 8, 16].map { UInt64($0) * 1_000_000_000 })
      let stretched = RoomEngine.inputReadyDelays(jitterRoll: 1)
      #expect(zip(flat, stretched).allSatisfy { $1 == UInt64(Double($0) * 1.5) })
      #expect(RoomEngine.inputReadyDelays(jitterRoll: 7) == stretched)   // out-of-range roll is clamped
    }
  }
#endif

#if canImport(RoomRecorderCore)
  /// Arch #17, herdr-lead's ARCH-17-SWIFT fix: the wait is drivable without the engine or real time.
  @Suite struct InputDeviceWaitLoopTests {
    private let mic = AudioInputDeviceEntry(name: "USB mic", uid: "uid-1", isDefault: false)
    private final class Script: @unchecked Sendable {
      private let lock = NSLock()
      private var calls = 0
      private var slept: [UInt64] = []
      let appearsOnCall: Int?     // nil = never
      init(appearsOnCall: Int?) { self.appearsOnCall = appearsOnCall }
      func devices(_ mic: AudioInputDeviceEntry) -> [AudioInputDeviceEntry]? {
        lock.lock(); defer { lock.unlock() }
        calls += 1
        if let n = appearsOnCall, calls >= n { return [mic] }
        return []
      }
      func sleep(_ ns: UInt64) { lock.lock(); slept.append(ns); lock.unlock() }
      var sleeps: [UInt64] { lock.lock(); defer { lock.unlock() }; return slept }
    }

    @Test func readyImmediatelyMakesOneCheckAndNeverSleeps() async throws {
      let s = Script(appearsOnCall: 1)
      let checks = try await RoomEngine.awaitInputDevice(
        uid: "uid-1", devices: { s.devices(mic) }, delays: [1, 2, 4], sleep: { s.sleep($0) })
      #expect(checks == 1)
      #expect(s.sleeps.isEmpty)
    }

    @Test func aDeviceThatAttachesLateIsWaitedFor() async throws {
      let s = Script(appearsOnCall: 3)
      let checks = try await RoomEngine.awaitInputDevice(
        uid: "uid-1", devices: { s.devices(mic) }, delays: [10, 20, 40], sleep: { s.sleep($0) })
      #expect(checks == 3)
      #expect(s.sleeps == [10, 20])
    }

    @Test func aDeviceThatNeverAttachesFailsAfterEveryDelayWithTheNamedError() async {
      let s = Script(appearsOnCall: nil)
      await #expect(throws: RoomEngineError.self) {
        try await RoomEngine.awaitInputDevice(
          uid: "uid-1", devices: { s.devices(mic) }, delays: [1, 2], sleep: { s.sleep($0) })
      }
      #expect(s.sleeps == [1, 2])
    }

    @Test func anUnreadableDeviceListIsReadyAndNeverSleeps() async throws {
      let s = Script(appearsOnCall: nil)
      let checks = try await RoomEngine.awaitInputDevice(
        uid: "uid-1", devices: { nil }, delays: [1, 2, 3], sleep: { s.sleep($0) })
      #expect(checks == 1)
      #expect(s.sleeps.isEmpty)
    }
  }

  /// Arch #17, refute F1: a start death is retried (3 attempts, backed off) before it is final.
  @Suite struct StartDeathRetryTests {
    @Test func theRetryPausesAreBackedOffAndJittered() {
      #expect(RoomEngine.startAttempts == 3)
      #expect(RoomEngine.startRetryDelays(jitterRoll: 0) == [2, 5].map { UInt64($0) * 1_000_000_000 })
      #expect(RoomEngine.startRetryDelays(jitterRoll: 1) == [3, 7.5].map { UInt64($0 * 1_000_000_000) })
      #expect(RoomEngine.startRetryDelays(jitterRoll: -4) == RoomEngine.startRetryDelays(jitterRoll: 0))
    }

    @Test func onlyACaptureDeathIsRetried() {
      #expect(RoomEngine.isStartDeath(RoomEngineError.captureExited(1)))
      #expect(RoomEngine.isStartDeath(RoomEngineError.captureDidNotBecomeDurable))
      #expect(RoomEngine.isStartDeath(RoomEngineError.residentArchiveDidNotBecomeDurable))
      #expect(!RoomEngine.isStartDeath(RoomEngineError.roomPaused))
      #expect(!RoomEngine.isStartDeath(RoomEngineError.pendingUploads(2)))
      #expect(!RoomEngine.isStartDeath(RoomEngineError.inputDeviceNotReady("x")))
      #expect(!RoomEngine.isStartDeath(CancellationError()))
    }
  }

  /// Arch #17 C1/C2: what a deferred start reports when its wait ends badly. Swift NOT compiled where written.
  @Suite struct DeferredStartReportTests {
    private final class Sleeps: @unchecked Sendable {
      private let lock = NSLock()
      private var n = 0
      func tick() { lock.lock(); n += 1; lock.unlock() }
      var count: Int { lock.lock(); defer { lock.unlock() }; return n }
    }

    @Test func aWaitThatNeverFindsTheDeviceEndsInTheNamedErrorAndTheServerCode() async {
      let sleeps = Sleeps()
      var thrown: Error?
      do {
        try await RoomEngine.awaitInputDevice(
          uid: "uid-1", devices: { [] }, delays: [1, 2, 4], sleep: { _ in sleeps.tick() })
      } catch { thrown = error }
      #expect(sleeps.count == 3)                                   // every backoff step was taken, none of it real time
      #expect(thrown as? RoomEngineError == RoomEngineError.inputDeviceNotReady("configured input device not attached after 4 checks"))
      #expect(RoomEngine.lateStartFailureReason(thrown!) == "input_device_not_ready")
    }

    @Test func otherFailuresReportTheirBoundedText() {
      #expect(RoomEngine.lateStartFailureReason(RoomEngineError.captureExited(1)) == "tapewriter exited with status 1")
    }
  }
#endif
