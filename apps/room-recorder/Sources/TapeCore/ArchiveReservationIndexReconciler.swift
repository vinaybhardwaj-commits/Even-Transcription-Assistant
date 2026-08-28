import Foundation

public struct ArchiveReservationLane: Equatable, Hashable, Sendable {
  public let sessionID: String
  public let laneID: String

  public init(sessionID: String, laneID: String) {
    self.sessionID = sessionID
    self.laneID = laneID
  }
}

public enum ArchiveReservationIndexError: Error, Equatable, Sendable {
  case duplicateReservationID(String)
  case duplicateChunkIndex(lane: ArchiveReservationLane, index: UInt32)
  case overlappingSampleRanges(
    lane: ArchiveReservationLane,
    firstStart: UInt64,
    firstEnd: UInt64,
    secondStart: UInt64,
    secondEnd: UInt64
  )
  case noncontiguousSampleRanges(lane: ArchiveReservationLane, expected: UInt64, actual: UInt64)
  case nonmonotonicChunkIndex(
    lane: ArchiveReservationLane,
    previous: UInt32,
    current: UInt32
  )
  case invalidLocalIndex(UInt32)
  case invalidServerNextIndex(UInt64)
  case indexExhausted(ArchiveReservationLane)
}

public enum ArchiveReservationIndexReconciler {
  public static let maximumServerIndex: UInt32 = 99_999

  public static func validate(_ reservations: [ArchiveJournalPayload]) throws {
    var reservationIDs: Set<String> = []
    var grouped: [ArchiveReservationLane: [ArchiveJournalPayload]] = [:]
    for reservation in reservations {
      guard reservationIDs.insert(reservation.reservationID).inserted else {
        throw ArchiveReservationIndexError.duplicateReservationID(reservation.reservationID)
      }
      guard reservation.chunkIndex <= maximumServerIndex else {
        throw ArchiveReservationIndexError.invalidLocalIndex(reservation.chunkIndex)
      }
      grouped[
        ArchiveReservationLane(
          sessionID: reservation.sessionID,
          laneID: reservation.laneID),
        default: []
      ].append(reservation)
    }

    for (lane, laneReservations) in grouped {
      var indices: Set<UInt32> = []
      for reservation in laneReservations {
        guard indices.insert(reservation.chunkIndex).inserted else {
          throw ArchiveReservationIndexError.duplicateChunkIndex(
            lane: lane,
            index: reservation.chunkIndex
          )
        }
      }
      let byRange = laneReservations.sorted {
        if $0.sampleStart != $1.sampleStart { return $0.sampleStart < $1.sampleStart }
        if $0.sampleEnd != $1.sampleEnd { return $0.sampleEnd < $1.sampleEnd }
        return $0.chunkIndex < $1.chunkIndex
      }
      for position in byRange.indices.dropFirst() {
        let previous = byRange[position - 1]
        let current = byRange[position]
        guard previous.sampleEnd <= current.sampleStart else {
          throw ArchiveReservationIndexError.overlappingSampleRanges(
            lane: lane,
            firstStart: previous.sampleStart,
            firstEnd: previous.sampleEnd,
            secondStart: current.sampleStart,
            secondEnd: current.sampleEnd
          )
        }
        guard previous.sampleEnd == current.sampleStart else {
          throw ArchiveReservationIndexError.noncontiguousSampleRanges(
            lane: lane,
            expected: previous.sampleEnd,
            actual: current.sampleStart
          )
        }
        guard previous.chunkIndex < current.chunkIndex else {
          throw ArchiveReservationIndexError.nonmonotonicChunkIndex(
            lane: lane,
            previous: previous.chunkIndex,
            current: current.chunkIndex
          )
        }
      }
    }
  }

  public static func localMaximumIndex(
    in reservations: [ArchiveJournalPayload],
    sessionID: String,
    laneID: String
  ) throws -> UInt32? {
    try validate(reservations)
    return reservations.lazy
      .filter { $0.sessionID == sessionID && $0.laneID == laneID }
      .map(\.chunkIndex)
      .max()
  }

  public static func nextIndex(
    localReservations: [ArchiveJournalPayload],
    sessionID: String,
    laneID: String,
    serverNextIndex: UInt64
  ) throws -> UInt32 {
    let lane = ArchiveReservationLane(sessionID: sessionID, laneID: laneID)
    let maximum = UInt64(maximumServerIndex)
    guard serverNextIndex <= maximum + 1 else {
      throw ArchiveReservationIndexError.invalidServerNextIndex(serverNextIndex)
    }
    let localMaximum = try localMaximumIndex(
      in: localReservations,
      sessionID: sessionID,
      laneID: laneID
    )
    let localNext = localMaximum.map { UInt64($0) + 1 } ?? 0
    let next = max(serverNextIndex, localNext)
    guard next <= maximum else {
      throw ArchiveReservationIndexError.indexExhausted(lane)
    }
    return UInt32(next)
  }
}
