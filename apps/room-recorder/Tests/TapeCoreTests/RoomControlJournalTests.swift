import Foundation
import RoomRecorderCore
import Synchronization
import Testing

@testable import TapeCore

@Suite(.serialized) struct RoomControlJournalTests {
  @Test func successChainIsDurableRecoverableAndExactStateIdempotent() throws {
    let fixture = try JournalFixture("success")
    defer { fixture.remove() }
    let journal = fixture.journal()
    let transitions = [
      RoomControlTransition(
        commandID: "cmd_1",
        commandKind: .startDay,
        sessionID: nil,
        priorState: nil,
        newState: .startIntent),
      RoomControlTransition(
        commandID: "cmd_1",
        commandKind: .startDay,
        sessionID: "bs_1",
        priorState: .startIntent,
        newState: .sessionOpened),
      RoomControlTransition(
        commandID: "cmd_1",
        commandKind: .startDay,
        sessionID: "bs_1",
        priorState: .sessionOpened,
        newState: .captureDurable),
      RoomControlTransition(
        commandID: "cmd_1",
        commandKind: .startDay,
        sessionID: "bs_1",
        priorState: .captureDurable,
        newState: .startAckReady),
      RoomControlTransition(
        commandID: "cmd_1",
        commandKind: .startDay,
        sessionID: "bs_1",
        priorState: .startAckReady,
        newState: .startAckObserved),
    ]
    for transition in transitions { _ = try journal.advance(transition) }
    _ = try journal.advance(transitions.last!)
    #expect(fixture.store.scanResult.records.count == transitions.count)
    fixture.store.close()

    let reopened = try fixture.reopen()
    defer { reopened.close() }
    let recovered = try ArchiveRoomControlJournal(store: reopened).recover()["cmd_1"]
    #expect(recovered?.commandKind == .startDay)
    #expect(recovered?.sessionID == "bs_1")
    #expect(recovered?.state == .startAckObserved)
  }

  @Test func staleAndDivergentRequestsAreRejectedWithoutMutation() throws {
    let fixture = try JournalFixture("stale")
    defer { fixture.remove() }
    let journal = fixture.journal()
    let intent = RoomControlTransition(
      commandID: "cmd_1",
      commandKind: .startDay,
      sessionID: nil,
      priorState: nil,
      newState: .startIntent)
    _ = try journal.advance(intent)

    #expect(throws: ArchiveControlPayloadError.self) {
      try journal.advance(
        RoomControlTransition(
          commandID: "cmd_1",
          commandKind: .startDay,
          sessionID: "bs_1",
          priorState: nil,
          newState: .sessionOpened))
    }
    #expect(throws: ArchiveControlPayloadError.self) {
      try journal.advance(
        RoomControlTransition(
          commandID: "cmd_1",
          commandKind: .pauseDay,
          sessionID: nil,
          priorState: nil,
          newState: .startIntent))
    }
    #expect(fixture.store.scanResult.records.count == 1)
  }

  @Test func timestampsNeverRegressWithinACommand() throws {
    let fixture = try JournalFixture("clock")
    defer { fixture.remove() }
    let calls = Atomic<Int>(0)
    let journal = fixture.journal {
      let call = calls.wrappingAdd(1, ordering: .relaxed).oldValue
      return call == 0 ? (20, 30) : (10, 5)
    }
    _ = try journal.advance(
      RoomControlTransition(
        commandID: "cmd_1",
        commandKind: .startDay,
        sessionID: nil,
        priorState: nil,
        newState: .startIntent))
    let second = try journal.advance(
      RoomControlTransition(
        commandID: "cmd_1",
        commandKind: .startDay,
        sessionID: "bs_1",
        priorState: .startIntent,
        newState: .sessionOpened))
    #expect(second.atMonoNS == 20)
    #expect(second.atWallNS == 30)
  }

  @Test func concurrentIdenticalAdvanceAppendsExactlyOnce() async throws {
    let fixture = try JournalFixture("concurrent")
    defer { fixture.remove() }
    let journal = fixture.journal()
    let transition = RoomControlTransition(
      commandID: "cmd_1",
      commandKind: .pauseDay,
      sessionID: "bs_1",
      priorState: nil,
      newState: .pauseIntent)

    try await withThrowingTaskGroup(of: Void.self) { group in
      for _ in 0..<20 {
        group.addTask { _ = try journal.advance(transition) }
      }
      try await group.waitForAll()
    }
    #expect(fixture.store.scanResult.records.count == 1)
  }

  @Test func failureCauseSurvivesFailureAckBoundaryAndReopen() throws {
    let fixture = try JournalFixture("failure-cause")
    defer { fixture.remove() }
    let journal = fixture.journal()
    _ = try journal.advance(
      RoomControlTransition(
        commandID: "cmd_1",
        commandKind: .pauseDay,
        sessionID: "bs_1",
        priorState: nil,
        newState: .pauseIntent))
    _ = try journal.advance(
      RoomControlTransition(
        commandID: "cmd_1",
        commandKind: .pauseDay,
        sessionID: "bs_1",
        priorState: .pauseIntent,
        newState: .pauseFailed,
        failure: .internalIOFailed))
    let ready = try journal.advance(
      RoomControlTransition(
        commandID: "cmd_1",
        commandKind: .pauseDay,
        sessionID: "bs_1",
        priorState: .pauseFailed,
        newState: .pauseFailureAckReady))
    #expect(ready.failure == .internalIOFailed)
    fixture.store.close()

    let reopened = try fixture.reopen()
    defer { reopened.close() }
    let recovered = try ArchiveRoomControlJournal(store: reopened).recover()["cmd_1"]
    #expect(recovered?.state == .pauseFailureAckReady)
    #expect(recovered?.failure == .internalIOFailed)
  }

  @Test func noOpAndSessionlessRefusalReachExistingAckBoundaries() throws {
    let fixture = try JournalFixture("decisions")
    defer { fixture.remove() }
    let journal = fixture.journal()
    _ = try journal.advance(
      RoomControlTransition(
        commandID: "cmd_start",
        commandKind: .startDay,
        sessionID: nil,
        priorState: nil,
        newState: .commandNoop))
    let noOpReady = try journal.advance(
      RoomControlTransition(
        commandID: "cmd_start",
        commandKind: .startDay,
        sessionID: nil,
        priorState: .commandNoop,
        newState: .startAckReady))
    #expect(noOpReady.state == .startAckReady)
    let noOpObserved = try journal.advance(
      RoomControlTransition(
        commandID: "cmd_start",
        commandKind: .startDay,
        sessionID: nil,
        priorState: .startAckReady,
        newState: .startAckObserved))
    #expect(noOpObserved.sessionID == nil)

    let carriedPause = try journal.advance(
      RoomControlTransition(
        commandID: "cmd_pause",
        commandKind: .pauseDay,
        sessionID: "bs_existing",
        priorState: nil,
        newState: .pauseIntent))
    #expect(carriedPause.sessionID == "bs_existing")

    _ = try journal.advance(
      RoomControlTransition(
        commandID: "cmd_end",
        commandKind: .endDay,
        sessionID: nil,
        priorState: nil,
        newState: .commandRefused,
        failure: .commandRefused))
    let refusalReady = try journal.advance(
      RoomControlTransition(
        commandID: "cmd_end",
        commandKind: .endDay,
        sessionID: nil,
        priorState: .commandRefused,
        newState: .endFailureAckReady))
    #expect(refusalReady.state == .endFailureAckReady)
    #expect(refusalReady.failure == .commandRefused)
  }

  @Test func captureSessionBindingIsDurableAndExactStateIdempotent() throws {
    let fixture = try JournalFixture("capture-binding")
    defer { fixture.remove() }
    let binding = try ArchiveCaptureSessionBinding(
      sessionID: "bs_bound",
      primaryIdentity: ArchiveDailyLaneIdentity(
        context: ArchiveContext(
          streamUUID: Data([
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x46, 0x77,
            0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF,
          ]),
          roomID: "room_1",
          istDate: "2026-08-28",
          laneID: "primary",
          stableDeviceUID: "device_1"),
        expectedInitialSessionSample: 500,
        keywrapDigestHex: String(repeating: "a", count: 64)),
      sessionSampleStart: 100,
      segmentSampleStart: 500)
    let transition = RoomControlTransition(
      commandID: binding.commandID,
      commandKind: .captureSessionBinding,
      sessionID: binding.sessionID,
      priorState: nil,
      newState: .captureSessionBound,
      captureSessionBinding: binding)
    let journal = fixture.journal()
    _ = try journal.advance(transition)
    _ = try journal.advance(transition)
    #expect(fixture.store.scanResult.records.count == 1)
    #expect(try journal.recover()[binding.commandID]?.captureSessionBinding == binding)
  }
}

private struct JournalFixture {
  let directory: URL
  let context: ArchiveContext
  let store: ArchiveDerivedStore

  init(_ label: String) throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "room-control-journal-\(label)-\(UUID().uuidString)",
      isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    context = ArchiveContext(
      streamUUID: Data(repeating: 0x31, count: 16),
      roomID: "room_1",
      istDate: "2026-08-28",
      laneID: "_control",
      stableDeviceUID: "")
    store = try ArchiveDerivedStore.openRecoveringForAppend(
      url: directory.appendingPathComponent("control.journal"),
      purpose: .control,
      rootKey: Data(repeating: 0x41, count: 32),
      context: context)
  }

  func journal(
    clock: @escaping ArchiveRoomControlJournal.Clock = {
      (DispatchTime.now().uptimeNanoseconds, 1_777_000_000_000_000_000)
    }
  ) -> ArchiveRoomControlJournal {
    ArchiveRoomControlJournal(store: store, clock: clock)
  }

  func reopen() throws -> ArchiveDerivedStore {
    try ArchiveDerivedStore.openRecoveringForAppend(
      url: directory.appendingPathComponent("control.journal"),
      purpose: .control,
      rootKey: Data(repeating: 0x41, count: 32),
      context: context)
  }

  func remove() {
    store.close()
    try? FileManager.default.removeItem(at: directory)
  }
}
