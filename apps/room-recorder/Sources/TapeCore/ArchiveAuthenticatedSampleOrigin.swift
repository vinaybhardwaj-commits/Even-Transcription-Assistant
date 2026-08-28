import Foundation

public enum ArchiveAuthenticatedSampleOriginError: Error, Equatable, Sendable {
  case unsupportedLane(String)
  case stableDeviceMismatch(expected: String, actual: String)
  case futureLineage(String)
  case duplicateDay(String)
  case invalidRange(day: String, initial: UInt64, end: UInt64)
  case discontinuousLineage(day: String, expected: UInt64, actual: UInt64)
}

public enum ArchiveAuthenticatedSampleOriginResolver {
  public static func resolve(
    roomID: String,
    laneID: String,
    stableDeviceUID: String,
    targetISTDate: String,
    snapshots: [ArchiveLaneStore.AuthenticatedSnapshot]
  ) throws -> UInt64 {
    guard laneID == "primary" || laneID == "backup" else {
      throw ArchiveAuthenticatedSampleOriginError.unsupportedLane(laneID)
    }
    let targetDay = try ArchiveISTDay(targetISTDate)
    let matchingLane = snapshots.map(\.authenticatedFacts).filter {
      $0.context.roomID == roomID && $0.context.laneID == laneID
    }
    guard !matchingLane.isEmpty else { return 0 }

    for facts in matchingLane where facts.context.stableDeviceUID != stableDeviceUID {
      throw ArchiveAuthenticatedSampleOriginError.stableDeviceMismatch(
        expected: stableDeviceUID,
        actual: facts.context.stableDeviceUID)
    }

    let ordered = try matchingLane.sorted {
      try ArchiveISTDay($0.context.istDate).description
        < ArchiveISTDay($1.context.istDate).description
    }
    var previousDay: ArchiveISTDay?
    var previousEnd: UInt64?
    for facts in ordered {
      let day = try ArchiveISTDay(facts.context.istDate)
      guard day.description <= targetDay.description else {
        throw ArchiveAuthenticatedSampleOriginError.futureLineage(facts.context.istDate)
      }
      if day == previousDay {
        throw ArchiveAuthenticatedSampleOriginError.duplicateDay(facts.context.istDate)
      }
      guard facts.initialSamplePosition <= facts.authenticatedSampleEnd else {
        throw ArchiveAuthenticatedSampleOriginError.invalidRange(
          day: facts.context.istDate,
          initial: facts.initialSamplePosition,
          end: facts.authenticatedSampleEnd)
      }
      if let previousEnd, facts.initialSamplePosition != previousEnd {
        throw ArchiveAuthenticatedSampleOriginError.discontinuousLineage(
          day: facts.context.istDate,
          expected: previousEnd,
          actual: facts.initialSamplePosition)
      }
      previousDay = day
      previousEnd = facts.authenticatedSampleEnd
    }
    return previousEnd ?? 0
  }
}
