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
