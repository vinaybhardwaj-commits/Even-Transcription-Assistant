import Foundation

public enum ArchiveFinalRangeCoverageError: Error, Equatable, Sendable {
  case invalidExpectedRange(start: UInt64, end: UInt64)
  case unexpectedReservationsForEmptyRange
  case missingCoverage(expectedStart: UInt64)
  case startMismatch(expected: UInt64, actual: UInt64)
  case endMismatch(expected: UInt64, actual: UInt64)
  case reservationNotDone(reservationID: String, state: ArchiveJournalState)
}

public enum ArchiveFinalRangeCoverage {
  /// Proves that one server session and lane has one contiguous set of server-verified reservations
  /// over the exact durable capture boundary. A `.done` journal state is the immutable local witness
  /// for successful object verification and chunk-row registration.
  @discardableResult
  public static func verify(
    reservations: [ArchiveJournalReplayReservation],
    sessionID: String,
    laneID: String,
    sampleStart: UInt64,
    sampleEnd: UInt64
  ) throws -> [String] {
    guard sampleEnd >= sampleStart else {
      throw ArchiveFinalRangeCoverageError.invalidExpectedRange(
        start: sampleStart,
        end: sampleEnd)
    }
    let relevant = reservations.filter {
      $0.initialReservation.sessionID == sessionID
        && $0.initialReservation.laneID == laneID
    }.sorted {
      let left = $0.initialReservation
      let right = $1.initialReservation
      if left.sampleStart != right.sampleStart { return left.sampleStart < right.sampleStart }
      if left.sampleEnd != right.sampleEnd { return left.sampleEnd < right.sampleEnd }
      return left.chunkIndex < right.chunkIndex
    }
    if sampleStart == sampleEnd {
      guard relevant.isEmpty else {
        throw ArchiveFinalRangeCoverageError.unexpectedReservationsForEmptyRange
      }
      return []
    }
    guard let first = relevant.first, let last = relevant.last else {
      throw ArchiveFinalRangeCoverageError.missingCoverage(expectedStart: sampleStart)
    }
    let initialReservations = relevant.map(\.initialReservation)
    try ArchiveReservationIndexReconciler.validate(initialReservations)
    guard first.initialReservation.sampleStart == sampleStart else {
      throw ArchiveFinalRangeCoverageError.startMismatch(
        expected: sampleStart,
        actual: first.initialReservation.sampleStart)
    }
    guard last.initialReservation.sampleEnd == sampleEnd else {
      throw ArchiveFinalRangeCoverageError.endMismatch(
        expected: sampleEnd,
        actual: last.initialReservation.sampleEnd)
    }
    for reservation in relevant where reservation.state != .done {
      throw ArchiveFinalRangeCoverageError.reservationNotDone(
        reservationID: reservation.initialReservation.reservationID,
        state: reservation.state)
    }
    return relevant.map(\.initialReservation.reservationID)
  }
}
