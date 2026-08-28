import Foundation
import TapeCore
import Testing

@Suite(.serialized) struct ArchiveAuthenticatedSampleOriginTests {
  @Test func zeroRequiresNoRetainedLineage() throws {
    #expect(
      try ArchiveAuthenticatedSampleOriginResolver.resolve(
        roomID: "room_1",
        laneID: "primary",
        stableDeviceUID: "device_1",
        targetISTDate: "2026-08-28",
        snapshots: []) == 0)
  }

  @Test func authenticatedDailySeamsDetermineTheNextOrigin() throws {
    let first = try snapshot(day: "2026-08-27", initial: 0, sampleCount: 2)
    let second = try snapshot(day: "2026-08-28", initial: 2, sampleCount: 4)
    defer {
      first.snapshot.close()
      second.snapshot.close()
      first.remove()
      second.remove()
    }

    #expect(
      try ArchiveAuthenticatedSampleOriginResolver.resolve(
        roomID: "room_1",
        laneID: "primary",
        stableDeviceUID: "device_1",
        targetISTDate: "2026-08-28",
        snapshots: [second.snapshot, first.snapshot]) == 6)
  }

  @Test func discontinuityDeviceSubstitutionAndFutureLineageFailClosed() throws {
    let first = try snapshot(day: "2026-08-27", initial: 0, sampleCount: 2)
    let discontinuous = try snapshot(day: "2026-08-28", initial: 3, sampleCount: 1)
    let replacement = try snapshot(
      day: "2026-08-28",
      initial: 2,
      sampleCount: 1,
      stableDeviceUID: "device_2")
    defer {
      for fixture in [first, discontinuous, replacement] {
        fixture.snapshot.close()
        fixture.remove()
      }
    }

    #expect(
      throws: ArchiveAuthenticatedSampleOriginError.discontinuousLineage(
        day: "2026-08-28",
        expected: 2,
        actual: 3)
    ) {
      try ArchiveAuthenticatedSampleOriginResolver.resolve(
        roomID: "room_1",
        laneID: "primary",
        stableDeviceUID: "device_1",
        targetISTDate: "2026-08-28",
        snapshots: [first.snapshot, discontinuous.snapshot])
    }
    #expect(
      throws: ArchiveAuthenticatedSampleOriginError.stableDeviceMismatch(
        expected: "device_1",
        actual: "device_2")
    ) {
      try ArchiveAuthenticatedSampleOriginResolver.resolve(
        roomID: "room_1",
        laneID: "primary",
        stableDeviceUID: "device_1",
        targetISTDate: "2026-08-28",
        snapshots: [first.snapshot, replacement.snapshot])
    }
    #expect(throws: ArchiveAuthenticatedSampleOriginError.futureLineage("2026-08-28")) {
      try ArchiveAuthenticatedSampleOriginResolver.resolve(
        roomID: "room_1",
        laneID: "primary",
        stableDeviceUID: "device_1",
        targetISTDate: "2026-08-27",
        snapshots: [first.snapshot, discontinuous.snapshot])
    }
  }

  private func snapshot(
    day: String,
    initial: UInt64,
    sampleCount: Int,
    stableDeviceUID: String = "device_1"
  ) throws -> SnapshotFixture {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "authenticated-origin-\(UUID().uuidString)",
      isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    let context = ArchiveContext(
      streamUUID: Data(UUID().uuidString.utf8.prefix(16)),
      roomID: "room_1",
      istDate: day,
      laneID: "primary",
      stableDeviceUID: stableDeviceUID)
    let store = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: directory.appendingPathComponent("lane.tape"),
      indexURL: directory.appendingPathComponent("lane.index"),
      rootKey: Data(repeating: 0x41, count: 32),
      context: context,
      initialSamplePosition: initial)
    if sampleCount > 0 {
      _ = try store.appendPCM(
        Data(repeating: 0, count: sampleCount * 2),
        observation: ArchiveIndexObservation(
          monoNS: 1,
          wallNS: 2,
          rmsQ15: 0,
          nativeFrames: UInt64(sampleCount),
          inputRateNumerator: 16_000,
          inputRateDenominator: 1))
    }
    let snapshot = try store.authenticatedSnapshot()
    store.close()
    return SnapshotFixture(directory: directory, snapshot: snapshot)
  }
}

private struct SnapshotFixture {
  let directory: URL
  let snapshot: ArchiveLaneStore.AuthenticatedSnapshot

  func remove() { try? FileManager.default.removeItem(at: directory) }
}
