import Foundation
import Testing

@testable import TapeCore

@Suite struct ArchiveFinalRangeCoverageTests {
  @Test func exactDoneReservationsProveFinalCoverage() throws {
    let first = try replay(seed: "a", index: 4, start: 100, end: 200, state: .done)
    let second = try replay(seed: "b", index: 7, start: 200, end: 300, state: .done)

    #expect(
      try ArchiveFinalRangeCoverage.verify(
        reservations: [second, first],
        sessionID: "bs_final",
        laneID: "primary",
        sampleStart: 100,
        sampleEnd: 300
      ) == [first.initialReservation.reservationID, second.initialReservation.reservationID]
    )
  }

  @Test func finalCoverageRejectsUnverifiedAndWrongBoundaries() throws {
    let unfinished = try replay(
      seed: "a", index: 4, start: 100, end: 200, state: .headVerified)
    #expect(
      throws: ArchiveFinalRangeCoverageError.reservationNotDone(
        reservationID: unfinished.initialReservation.reservationID,
        state: .headVerified)
    ) {
      try ArchiveFinalRangeCoverage.verify(
        reservations: [unfinished],
        sessionID: "bs_final",
        laneID: "primary",
        sampleStart: 100,
        sampleEnd: 200)
    }

    let done = try replay(seed: "b", index: 7, start: 150, end: 300, state: .done)
    #expect(throws: ArchiveFinalRangeCoverageError.startMismatch(expected: 100, actual: 150)) {
      try ArchiveFinalRangeCoverage.verify(
        reservations: [done],
        sessionID: "bs_final",
        laneID: "primary",
        sampleStart: 100,
        sampleEnd: 300)
    }
  }

  private func replay(
    seed: Character,
    index: UInt32,
    start: UInt64,
    end: UInt64,
    state: ArchiveJournalState
  ) throws -> ArchiveJournalReplayReservation {
    let initial = try ArchiveJournalPayload(
      reservationID: String(repeating: String(seed), count: 64),
      roomID: "room_final",
      sessionID: "bs_final",
      laneID: "primary",
      istDate: "2026-08-28",
      chunkIndex: index,
      sampleStart: start,
      sampleEnd: end,
      startMS: start,
      endMS: end,
      uncertainty: nil,
      averageLevelQ15: 100,
      peakLevelQ15: 300,
      attemptID: nil,
      priorState: nil,
      newState: .reserved,
      error: nil)
    return ArchiveJournalReplayReservation(
      initialReservation: initial,
      state: state,
      attemptID: state == .reserved ? nil : "attempt_1")
  }
}
