import Foundation

public struct ArchiveDeliveryCandidate: Sendable {
  public let initialReservation: ArchiveJournalPayload
  private let advanceDelivery: @Sendable () async throws -> ArchiveDeliveryResult

  public init(
    initialReservation: ArchiveJournalPayload,
    advance: @escaping @Sendable () async throws -> ArchiveDeliveryResult
  ) {
    self.initialReservation = initialReservation
    advanceDelivery = advance
  }

  fileprivate func advance() async throws -> ArchiveDeliveryResult {
    try await advanceDelivery()
  }
}

public struct ArchiveDeliveryInventorySnapshot: Sendable {
  public let localReservations: [ArchiveJournalPayload]
  public let candidates: [ArchiveDeliveryCandidate]
  public let blockedReservations: [ArchiveJournalReplayReservation]

  public init(
    localReservations: [ArchiveJournalPayload],
    candidates: [ArchiveDeliveryCandidate],
    blockedReservations: [ArchiveJournalReplayReservation] = []
  ) {
    self.localReservations = localReservations
    self.candidates = candidates
    self.blockedReservations = blockedReservations
  }

  public func nextIndex(
    sessionID: String,
    laneID: String,
    serverNextIndex: UInt64
  ) throws -> UInt32 {
    try ArchiveReservationIndexReconciler.nextIndex(
      localReservations: localReservations,
      sessionID: sessionID,
      laneID: laneID,
      serverNextIndex: serverNextIndex
    )
  }
}

public protocol ArchiveDeliveryInventory: Sendable {
  func scan() async throws -> ArchiveDeliveryInventorySnapshot
}

public struct ArchiveDeliveryDiskLane: Sendable {
  public let journalURL: URL
  public let manifestURL: URL
  public let spoolDirectoryURL: URL
  private let snapshotFactory: @Sendable () throws -> ArchiveLaneStore.AuthenticatedSnapshot

  public init(
    journalURL: URL,
    manifestURL: URL,
    spoolDirectoryURL: URL,
    openSnapshot: @escaping @Sendable () throws -> ArchiveLaneStore.AuthenticatedSnapshot
  ) {
    self.journalURL = journalURL
    self.manifestURL = manifestURL
    self.spoolDirectoryURL = spoolDirectoryURL
    snapshotFactory = openSnapshot
  }

  fileprivate func openSnapshot() throws -> ArchiveLaneStore.AuthenticatedSnapshot {
    try snapshotFactory()
  }
}

public enum ArchiveDeliveryDiskInventoryError: Error, Equatable, Sendable {
  case missingPiecePlan(String)
}

public struct ArchiveDeliveryDiskInventory: ArchiveDeliveryInventory {
  private let lanes: [ArchiveDeliveryDiskLane]
  private let wire: any ArchiveDeliveryWire
  private let spoolCoordinator: ArchiveSpoolCoordinator?

  public init(
    lanes: [ArchiveDeliveryDiskLane],
    wire: any ArchiveDeliveryWire,
    spoolCoordinator: ArchiveSpoolCoordinator? = nil
  ) {
    self.lanes = lanes
    self.wire = wire
    self.spoolCoordinator = spoolCoordinator
  }

  public func scan() async throws -> ArchiveDeliveryInventorySnapshot {
    var localReservations: [ArchiveJournalPayload] = []
    var candidates: [ArchiveDeliveryCandidate] = []
    var blockedReservations: [ArchiveJournalReplayReservation] = []
    for lane in lanes where FileManager.default.fileExists(atPath: lane.journalURL.path) {
      let snapshot = try lane.openSnapshot()
      let replay: [String: ArchiveJournalReplayReservation]
      let manifests: [String: ArchiveManifestPayload]
      let indexRecords: [ArchiveIndexRecordMetadata]
      do {
        indexRecords = snapshot.indexRecords
        let journal = try snapshot.openJournalStoreForAppend(at: lane.journalURL)
        defer { journal.close() }
        replay = try ArchiveJournalReplay.validate(
          journal.scanResult.records.map {
            try ArchiveJournalPayloadCodec.decode($0.plaintext)
          })
        if FileManager.default.fileExists(atPath: lane.manifestURL.path) {
          let manifest = try snapshot.openManifestStoreForAppend(at: lane.manifestURL)
          defer { manifest.close() }
          manifests = try ArchiveManifestReplay.validate(
            manifest.scanResult.records.map {
              try ArchiveManifestPayloadCodec.decode($0.plaintext)
            })
        } else {
          manifests = [:]
        }
      }
      snapshot.close()

      for reservation in replay.values {
        let initial = reservation.initialReservation
        localReservations.append(initial)
        switch reservation.state {
        case .spoolDurable, .putComplete, .headVerified, .rowRegistered, .serverEnded:
          let expectedFitSegment = manifests[initial.reservationID]?.fitSegment ?? 0
          candidates.append(
            ArchiveDeliveryCandidate(initialReservation: initial) {
              let deliverySnapshot = try lane.openSnapshot()
              defer { deliverySnapshot.close() }
              return try await ArchiveDeliveryCoordinator(wire: wire).advance(
                snapshot: deliverySnapshot,
                journalURL: lane.journalURL,
                manifestURL: lane.manifestURL,
                spoolDirectoryURL: lane.spoolDirectoryURL,
                initialReservation: initial,
                expectedFitSegment: expectedFitSegment
              )
            })
        case .reserved, .encoded:
          guard let spoolCoordinator else {
            blockedReservations.append(reservation)
            continue
          }
          let expectedFitSegment: UInt64
          if let manifest = manifests[initial.reservationID] {
            expectedFitSegment = manifest.fitSegment
          } else {
            let plans = try ArchiveLocalCutter.plan(
              indexRecords: indexRecords,
              finalFlush: true)
            guard
              let plan = plans.first(where: {
                $0.sampleStart == initial.sampleStart && $0.sampleEnd == initial.sampleEnd
              })
            else {
              throw ArchiveDeliveryDiskInventoryError.missingPiecePlan(initial.reservationID)
            }
            expectedFitSegment = plan.fitSegment
          }
          candidates.append(
            ArchiveDeliveryCandidate(initialReservation: initial) {
              let deliverySnapshot = try lane.openSnapshot()
              defer { deliverySnapshot.close() }
              _ = try spoolCoordinator.advance(
                snapshot: deliverySnapshot,
                journalURL: lane.journalURL,
                manifestURL: lane.manifestURL,
                spoolDirectoryURL: lane.spoolDirectoryURL,
                initialReservation: initial,
                fitSegment: expectedFitSegment
              )
              return try await ArchiveDeliveryCoordinator(wire: wire).advance(
                snapshot: deliverySnapshot,
                journalURL: lane.journalURL,
                manifestURL: lane.manifestURL,
                spoolDirectoryURL: lane.spoolDirectoryURL,
                initialReservation: initial,
                expectedFitSegment: expectedFitSegment
              )
            })
        case .done:
          break
        }
      }
    }
    return ArchiveDeliveryInventorySnapshot(
      localReservations: localReservations,
      candidates: candidates,
      blockedReservations: blockedReservations
    )
  }
}

public protocol ArchiveDeliverySleeping: Sendable {
  func sleep(seconds: UInt64) async throws
}

public struct ArchiveContinuousDeliverySleeper: ArchiveDeliverySleeping {
  public init() {}

  public func sleep(seconds: UInt64) async throws {
    try await Task.sleep(for: .seconds(seconds))
  }
}

public enum ArchiveDeliverySweeperError: Error, Equatable, Sendable {
  case alreadyRunning
  case candidateMissingFromInventory(String)
  case duplicateCandidate(String)
}

public enum ArchiveDeliverySweepOutcome: Equatable, Sendable {
  case idle
  case delivered(reservationID: String, result: ArchiveDeliveryResult)
  case retryScheduled(
    reservationID: String,
    delaySeconds: UInt64,
    error: ArchiveDeliveryCoordinatorError
  )
}

public actor ArchiveDeliverySweeper {
  public static let minimumBackoffSeconds: UInt64 = 5
  public static let maximumBackoffSeconds: UInt64 = 60

  private let inventory: any ArchiveDeliveryInventory
  private let sleeper: any ArchiveDeliverySleeping
  private var nextBackoffSeconds = minimumBackoffSeconds
  private var stepping = false

  public init(
    inventory: any ArchiveDeliveryInventory,
    sleeper: any ArchiveDeliverySleeping = ArchiveContinuousDeliverySleeper()
  ) {
    self.inventory = inventory
    self.sleeper = sleeper
  }

  public func step() async throws -> ArchiveDeliverySweepOutcome {
    guard !stepping else { throw ArchiveDeliverySweeperError.alreadyRunning }
    stepping = true
    defer { stepping = false }
    let inventorySnapshot = try await inventory.scan()
    try ArchiveReservationIndexReconciler.validate(inventorySnapshot.localReservations)
    let byID = Dictionary(
      uniqueKeysWithValues: inventorySnapshot.localReservations.map {
        ($0.reservationID, $0)
      })
    var candidateIDs: Set<String> = []
    for candidate in inventorySnapshot.candidates {
      let reservation = candidate.initialReservation
      guard candidateIDs.insert(reservation.reservationID).inserted else {
        throw ArchiveDeliverySweeperError.duplicateCandidate(reservation.reservationID)
      }
      guard byID[reservation.reservationID] == reservation else {
        throw ArchiveDeliverySweeperError.candidateMissingFromInventory(reservation.reservationID)
      }
    }
    guard let candidate = inventorySnapshot.candidates.min(by: isOlder) else {
      nextBackoffSeconds = Self.minimumBackoffSeconds
      return .idle
    }

    do {
      let result = try await candidate.advance()
      nextBackoffSeconds = Self.minimumBackoffSeconds
      return .delivered(
        reservationID: candidate.initialReservation.reservationID,
        result: result
      )
    } catch let error as ArchiveDeliveryCoordinatorError where isRetryable(error) {
      let delay = nextBackoffSeconds
      nextBackoffSeconds = min(delay * 2, Self.maximumBackoffSeconds)
      try await sleeper.sleep(seconds: delay)
      return .retryScheduled(
        reservationID: candidate.initialReservation.reservationID,
        delaySeconds: delay,
        error: error
      )
    }
  }

  public func drain() async throws {
    while true {
      if try await step() == .idle { return }
    }
  }

  private func isOlder(_ lhs: ArchiveDeliveryCandidate, _ rhs: ArchiveDeliveryCandidate) -> Bool {
    let left = lhs.initialReservation
    let right = rhs.initialReservation
    if left.istDate != right.istDate { return left.istDate < right.istDate }
    switch (left.startMS, right.startMS) {
    case (.some(let leftStart), .some(let rightStart)) where leftStart != rightStart:
      return leftStart < rightStart
    case (.none, .some):
      return true
    case (.some, .none):
      return false
    default:
      break
    }
    if left.sampleStart != right.sampleStart { return left.sampleStart < right.sampleStart }
    if left.sessionID != right.sessionID { return left.sessionID < right.sessionID }
    if left.laneID != right.laneID { return left.laneID < right.laneID }
    if left.chunkIndex != right.chunkIndex { return left.chunkIndex < right.chunkIndex }
    return left.reservationID < right.reservationID
  }

  private func isRetryable(_ error: ArchiveDeliveryCoordinatorError) -> Bool {
    switch error {
    case .wireFailure, .remoteObjectMissing, .remoteContentLengthMissing,
      .registrationNotVerified:
      true
    case .missingReservation, .reservationMismatch, .missingManifest,
      .deliveryBeforeSpoolDurable, .missingServerTimestamps, .invalidServerTimestampRange,
      .unsupportedLaneID, .invalidServerIndex, .remoteSizeMismatch,
      .registrationKeyMismatch, .unprovenAlreadyVerified, .failureObservationFailed:
      false
    }
  }
}
