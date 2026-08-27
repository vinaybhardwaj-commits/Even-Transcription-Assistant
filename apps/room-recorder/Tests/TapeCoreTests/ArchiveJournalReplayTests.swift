import Foundation
import Testing

@testable import TapeCore

@Suite struct ArchiveJournalReplayTests {
  @Test func successAndFailureObservationsReplayWithOneBoundAttempt() throws {
    let initial = try payload()
    let reservedFailure = try payload(
      attemptID: "attempt_abandoned",
      prior: .reserved,
      new: .reserved,
      error: "encoder_failed"
    )
    let states: [ArchiveJournalState] = [
      .encoded, .spoolDurable, .putComplete, .headVerified, .rowRegistered, .done,
    ]
    var records = [initial, reservedFailure]
    var prior = ArchiveJournalState.reserved
    for state in states {
      records.append(try payload(attemptID: "attempt_final", prior: prior, new: state))
      if state == .spoolDurable {
        records.append(
          try payload(
            attemptID: "attempt_final",
            prior: state,
            new: state,
            error: "temporary_io_failure"
          ))
      }
      prior = state
    }

    let replay = try ArchiveJournalReplay.validate(records)
    #expect(replay[initial.reservationID]?.initialReservation == initial)
    #expect(replay[initial.reservationID]?.state == .done)
    #expect(replay[initial.reservationID]?.attemptID == "attempt_final")
    #expect(records.filter { $0.error == nil }.allSatisfy { $0.priorState != $0.newState })
  }

  @Test func illegalStateFactsAndAttemptChangesAreRejected() throws {
    let initial = try payload()
    let skipped = try payload(
      attemptID: "attempt_1",
      prior: .encoded,
      new: .spoolDurable
    )
    #expect(throws: ArchiveJournalReplayError.self) {
      try ArchiveJournalReplay.validate([initial, skipped])
    }

    let encoded = try payload(attemptID: "attempt_1", prior: .reserved, new: .encoded)
    let changedFacts = try payload(
      sampleEnd: 32_001,
      attemptID: "attempt_1",
      prior: .encoded,
      new: .spoolDurable
    )
    #expect(throws: ArchiveJournalReplayError.self) {
      try ArchiveJournalReplay.validate([initial, encoded, changedFacts])
    }

    let substituted = try payload(
      attemptID: "attempt_2",
      prior: .encoded,
      new: .spoolDurable
    )
    #expect(
      throws: ArchiveJournalReplayError.attemptSubstitution(reservationID: initial.reservationID)
    ) {
      try ArchiveJournalReplay.validate([initial, encoded, substituted])
    }

    let nullFailure = try payload(
      attemptID: nil,
      prior: .encoded,
      new: .encoded,
      error: "temporary_failure"
    )
    #expect(throws: ArchiveJournalReplayError.self) {
      try ArchiveJournalReplay.validate([initial, encoded, nullFailure])
    }
    #expect(throws: ArchiveJournalPayloadError.self) {
      try payload(attemptID: "attempt_1", prior: .reserved, new: .spoolDurable)
    }
    #expect(throws: ArchiveJournalPayloadError.self) {
      try payload(attemptID: nil, prior: .reserved, new: .encoded)
    }
  }

  @Test func preManifestReencodeRebindsOnlyToANewAttempt() throws {
    let initial = try payload()
    let firstEncode = try payload(attemptID: "attempt_1", prior: .reserved, new: .encoded)
    let replacement = try payload(attemptID: "attempt_2", prior: .encoded, new: .encoded)
    let failure = try payload(
      attemptID: "attempt_2",
      prior: .encoded,
      new: .encoded,
      error: "temporary_failure"
    )
    let durable = try payload(
      attemptID: "attempt_2",
      prior: .encoded,
      new: .spoolDurable
    )

    let replay = try ArchiveJournalReplay.validate([
      initial, firstEncode, replacement, failure, durable,
    ])
    #expect(replay[initial.reservationID]?.state == .spoolDurable)
    #expect(replay[initial.reservationID]?.attemptID == "attempt_2")

    let fakeReencode = try payload(
      attemptID: "attempt_1",
      prior: .encoded,
      new: .encoded
    )
    #expect(throws: ArchiveJournalReplayError.sameAttemptReencode(initial.reservationID)) {
      try ArchiveJournalReplay.validate([initial, firstEncode, fakeReencode])
    }
    let replacedAfterDurable = try payload(
      attemptID: "attempt_3",
      prior: .spoolDurable,
      new: .putComplete
    )
    #expect(
      throws: ArchiveJournalReplayError.attemptSubstitution(reservationID: initial.reservationID)
    ) {
      try ArchiveJournalReplay.validate([
        initial, firstEncode, replacement, durable, replacedAfterDurable,
      ])
    }
    let failureReplacement = try payload(
      attemptID: "attempt_3",
      prior: .spoolDurable,
      new: .spoolDurable,
      error: "temporary_failure"
    )
    #expect(
      throws: ArchiveJournalReplayError.attemptSubstitution(reservationID: initial.reservationID)
    ) {
      try ArchiveJournalReplay.validate([
        initial, firstEncode, replacement, durable, failureReplacement,
      ])
    }
  }

  @Test func deterministicReservationHashRequirementRemainsFrozen() throws {
    #expect(throws: ArchiveJournalPayloadError.invalidReservationID) {
      try payload(reservationID: String(repeating: "A", count: 64))
    }
    #expect(throws: ArchiveJournalPayloadError.invalidReservationID) {
      try payload(reservationID: String(repeating: "a", count: 63))
    }
  }

  private func payload(
    reservationID: String = String(repeating: "a", count: 64),
    sampleEnd: UInt64 = 32_000,
    attemptID: String? = nil,
    prior: ArchiveJournalState? = nil,
    new: ArchiveJournalState = .reserved,
    error: String? = nil
  ) throws -> ArchiveJournalPayload {
    try ArchiveJournalPayload(
      reservationID: reservationID,
      roomID: "room_1",
      sessionID: "bs_1",
      laneID: "primary",
      istDate: "2026-08-27",
      chunkIndex: 1,
      sampleStart: 16_000,
      sampleEnd: sampleEnd,
      startMS: 1_000,
      endMS: 2_000,
      uncertainty: nil,
      averageLevelQ15: 100,
      peakLevelQ15: 200,
      attemptID: attemptID,
      priorState: prior,
      newState: new,
      error: error
    )
  }
}
