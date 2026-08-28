import Foundation

public enum ArchiveDeliverySource: String, Equatable, Sendable {
  case primary
  case backup
}

public struct ArchiveDeliveryPiece: Equatable, Sendable {
  public let sessionID: String
  public let index: UInt32
  public let contentType: String
  public let startedAtMS: UInt64
  public let endedAtMS: UInt64
  public let durationMS: UInt64
  public let sizeBytes: UInt64
  public let gapBeforeMS: UInt64
  public let peakLevel: Double?
  public let averageLevel: Double?
  public let source: ArchiveDeliverySource

  public init(
    sessionID: String,
    index: UInt32,
    contentType: String,
    startedAtMS: UInt64,
    endedAtMS: UInt64,
    durationMS: UInt64,
    sizeBytes: UInt64,
    gapBeforeMS: UInt64,
    peakLevel: Double?,
    averageLevel: Double?,
    source: ArchiveDeliverySource
  ) {
    self.sessionID = sessionID
    self.index = index
    self.contentType = contentType
    self.startedAtMS = startedAtMS
    self.endedAtMS = endedAtMS
    self.durationMS = durationMS
    self.sizeBytes = sizeBytes
    self.gapBeforeMS = gapBeforeMS
    self.peakLevel = peakLevel
    self.averageLevel = averageLevel
    self.source = source
  }
}

public enum ArchiveDeliveryPresignResult: Equatable, Sendable {
  case alreadyVerified
  case upload(putURL: URL, headURL: URL, key: String)
}

public enum ArchiveDeliveryRemoteObject: Equatable, Sendable {
  case missing
  case present(byteCount: UInt64?)
}

public struct ArchiveDeliveryRegistration: Equatable, Sendable {
  public let ok: Bool
  public let key: String
  public let uploadState: String
  public let endedDisagrees: String?

  public init(ok: Bool, key: String, uploadState: String, endedDisagrees: String? = nil) {
    self.ok = ok
    self.key = key
    self.uploadState = uploadState
    self.endedDisagrees = endedDisagrees
  }
}

public protocol ArchiveDeliveryWire: Sendable {
  func prepareDelivery(for piece: ArchiveDeliveryPiece) async throws
    -> ArchiveDeliveryPresignResult
  func probeDeliveryObject(at url: URL) async throws -> ArchiveDeliveryRemoteObject
  func putDeliveryObject(
    chunks: [Data],
    to url: URL,
    contentType: String
  ) async throws
  func registerDelivery(_ piece: ArchiveDeliveryPiece) async throws
    -> ArchiveDeliveryRegistration
}

public enum ArchiveDeliveryStage: String, Equatable, Sendable {
  case presign = "presign_failed"
  case reconciliation = "already_verified_unproven"
  case preflightHead = "preflight_head_failed"
  case put = "put_failed"
  case verificationHead = "verification_head_failed"
  case registration = "registration_failed"
}

public enum ArchiveDeliveryCoordinatorError: Error, Equatable, Sendable {
  case missingReservation(String)
  case reservationMismatch(String)
  case missingManifest(String)
  case deliveryBeforeSpoolDurable(ArchiveJournalState)
  case missingServerTimestamps
  case invalidServerTimestampRange(start: UInt64, end: UInt64)
  case unsupportedLaneID(String)
  case invalidServerIndex(UInt32)
  case remoteObjectMissing
  case remoteContentLengthMissing
  case remoteSizeMismatch(expected: UInt64, actual: UInt64)
  case registrationKeyMismatch(expected: String, actual: String)
  case registrationNotVerified
  case unprovenAlreadyVerified(ArchiveJournalState)
  case wireFailure(ArchiveDeliveryStage)
  case failureObservationFailed(stage: ArchiveDeliveryStage)
}

public struct ArchiveDeliveryResult: Equatable, Sendable {
  public let state: ArchiveJournalState
  public let journalRecordsWritten: Int
  public let uploaded: Bool
  public let alreadyVerified: Bool
  public let spoolURL: URL
  public let endedDisagrees: String?

  public init(
    state: ArchiveJournalState,
    journalRecordsWritten: Int,
    uploaded: Bool,
    alreadyVerified: Bool,
    spoolURL: URL,
    endedDisagrees: String?
  ) {
    self.state = state
    self.journalRecordsWritten = journalRecordsWritten
    self.uploaded = uploaded
    self.alreadyVerified = alreadyVerified
    self.spoolURL = spoolURL
    self.endedDisagrees = endedDisagrees
  }
}

public struct ArchiveDeliveryCoordinator: Sendable {
  private let wire: any ArchiveDeliveryWire

  public init(wire: any ArchiveDeliveryWire) {
    self.wire = wire
  }

  public func advance(
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    journalURL: URL,
    manifestURL: URL,
    spoolDirectoryURL: URL,
    initialReservation: ArchiveJournalPayload,
    expectedFitSegment: UInt64
  ) async throws -> ArchiveDeliveryResult {
    var reservation = try currentReservation(
      snapshot: snapshot,
      journalURL: journalURL,
      expectedInitial: initialReservation
    )
    guard
      let manifest = try currentManifests(snapshot: snapshot, manifestURL: manifestURL)[
        initialReservation.reservationID
      ]
    else {
      throw ArchiveDeliveryCoordinatorError.missingManifest(initialReservation.reservationID)
    }
    switch reservation.state {
    case .spoolDurable, .putComplete, .headVerified, .rowRegistered, .done:
      break
    case .reserved, .encoded:
      throw ArchiveDeliveryCoordinatorError.deliveryBeforeSpoolDurable(reservation.state)
    }

    let published = try ArchiveEncryptedSpoolPublisher.publish(
      snapshot: snapshot,
      directoryURL: spoolDirectoryURL,
      reservation: reservation,
      manifest: manifest
    )
    let spool = try snapshot.inspectSpool(at: published.url)
    _ = try ArchiveSpoolCorrespondence.validate(
      reservation: reservation,
      manifest: manifest,
      spool: spool,
      spoolURL: published.url,
      expectedFitSegment: expectedFitSegment
    )
    let piece = try makePiece(
      initial: initialReservation,
      manifest: manifest,
      gapBeforeMS: gapBeforeMS(initial: initialReservation, snapshot: snapshot)
    )

    var journalRecordsWritten = 0
    var uploaded = false
    var endedDisagrees: String?

    if reservation.state == .done {
      return ArchiveDeliveryResult(
        state: .done,
        journalRecordsWritten: 0,
        uploaded: false,
        alreadyVerified: false,
        spoolURL: published.url,
        endedDisagrees: nil
      )
    }

    if reservation.state == .spoolDurable || reservation.state == .putComplete
      || reservation.state == .headVerified
    {
      let presign: ArchiveDeliveryPresignResult
      do {
        presign = try await wire.prepareDelivery(for: piece)
      } catch {
        try observeFailure(
          .presign,
          reservation: reservation,
          snapshot: snapshot,
          journalURL: journalURL
        )
        throw ArchiveDeliveryCoordinatorError.wireFailure(.presign)
      }

      switch presign {
      case .alreadyVerified:
        reservation = try currentReservation(
          snapshot: snapshot,
          journalURL: journalURL,
          expectedInitial: initialReservation
        )
        switch reservation.state {
        case .headVerified, .rowRegistered, .done:
          break
        case .spoolDurable, .putComplete:
          try observeFailure(
            .reconciliation,
            reservation: reservation,
            snapshot: snapshot,
            journalURL: journalURL
          )
          throw ArchiveDeliveryCoordinatorError.unprovenAlreadyVerified(reservation.state)
        case .reserved, .encoded:
          throw ArchiveDeliveryCoordinatorError.deliveryBeforeSpoolDurable(reservation.state)
        }
        while reservation.state != .done {
          let advanced = try appendNextSuccess(
            reservation: reservation,
            snapshot: snapshot,
            journalURL: journalURL
          )
          reservation = advanced.reservation
          journalRecordsWritten += advanced.written ? 1 : 0
        }
        return ArchiveDeliveryResult(
          state: reservation.state,
          journalRecordsWritten: journalRecordsWritten,
          uploaded: false,
          alreadyVerified: true,
          spoolURL: published.url,
          endedDisagrees: nil
        )

      case .upload(let putURL, let headURL, let key):
        if reservation.state == .spoolDurable {
          let existing = try await probe(
            headURL,
            stage: .preflightHead,
            reservation: reservation,
            snapshot: snapshot,
            journalURL: journalURL
          )
          switch existing {
          case .missing:
            do {
              try await wire.putDeliveryObject(
                chunks: spool.records.map(\.plaintext),
                to: putURL,
                contentType: manifest.mime.rawValue
              )
            } catch {
              try observeFailure(
                .put,
                reservation: reservation,
                snapshot: snapshot,
                journalURL: journalURL
              )
              throw ArchiveDeliveryCoordinatorError.wireFailure(.put)
            }
            uploaded = true
          case .present(let byteCount):
            try requireExpectedSize(
              byteCount,
              expected: manifest.encodedBytes,
              reservation: reservation,
              snapshot: snapshot,
              journalURL: journalURL,
              stage: .preflightHead
            )
          }
          let advanced = try appendNextSuccess(
            reservation: reservation,
            snapshot: snapshot,
            journalURL: journalURL
          )
          reservation = advanced.reservation
          journalRecordsWritten += advanced.written ? 1 : 0
        }

        if reservation.state == .putComplete {
          let verified = try await probe(
            headURL,
            stage: .verificationHead,
            reservation: reservation,
            snapshot: snapshot,
            journalURL: journalURL
          )
          switch verified {
          case .missing:
            try observeFailure(
              .verificationHead,
              reservation: reservation,
              snapshot: snapshot,
              journalURL: journalURL
            )
            throw ArchiveDeliveryCoordinatorError.remoteObjectMissing
          case .present(let byteCount):
            try requireExpectedSize(
              byteCount,
              expected: manifest.encodedBytes,
              reservation: reservation,
              snapshot: snapshot,
              journalURL: journalURL,
              stage: .verificationHead
            )
          }
          let advanced = try appendNextSuccess(
            reservation: reservation,
            snapshot: snapshot,
            journalURL: journalURL
          )
          reservation = advanced.reservation
          journalRecordsWritten += advanced.written ? 1 : 0
        }

        if reservation.state == .headVerified {
          let registration = try await register(
            piece,
            reservation: reservation,
            snapshot: snapshot,
            journalURL: journalURL
          )
          guard registration.key == key else {
            try observeFailure(
              .registration,
              reservation: reservation,
              snapshot: snapshot,
              journalURL: journalURL
            )
            throw ArchiveDeliveryCoordinatorError.registrationKeyMismatch(
              expected: key,
              actual: registration.key
            )
          }
          endedDisagrees = registration.endedDisagrees
          let advanced = try appendNextSuccess(
            reservation: reservation,
            snapshot: snapshot,
            journalURL: journalURL
          )
          reservation = advanced.reservation
          journalRecordsWritten += advanced.written ? 1 : 0
        }
      }
    }

    if reservation.state == .rowRegistered {
      let advanced = try appendNextSuccess(
        reservation: reservation,
        snapshot: snapshot,
        journalURL: journalURL
      )
      reservation = advanced.reservation
      journalRecordsWritten += advanced.written ? 1 : 0
    }

    return ArchiveDeliveryResult(
      state: reservation.state,
      journalRecordsWritten: journalRecordsWritten,
      uploaded: uploaded,
      alreadyVerified: false,
      spoolURL: published.url,
      endedDisagrees: endedDisagrees
    )
  }

  private func currentReservation(
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    journalURL: URL,
    expectedInitial: ArchiveJournalPayload
  ) throws -> ArchiveJournalReplayReservation {
    let journal = try snapshot.openJournalStoreForAppend(at: journalURL)
    defer { journal.close() }
    return try currentReservation(journal: journal, expectedInitial: expectedInitial)
  }

  private func currentReservation(
    journal: ArchiveDerivedStore,
    expectedInitial: ArchiveJournalPayload
  ) throws -> ArchiveJournalReplayReservation {
    let payloads = try journal.scanResult.records.map {
      try ArchiveJournalPayloadCodec.decode($0.plaintext)
    }
    let replay = try ArchiveJournalReplay.validate(payloads)
    guard let reservation = replay[expectedInitial.reservationID] else {
      throw ArchiveDeliveryCoordinatorError.missingReservation(expectedInitial.reservationID)
    }
    guard reservation.initialReservation == expectedInitial else {
      throw ArchiveDeliveryCoordinatorError.reservationMismatch(expectedInitial.reservationID)
    }
    return reservation
  }

  private func currentManifests(
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    manifestURL: URL
  ) throws
    -> [String: ArchiveManifestPayload]
  {
    let store = try snapshot.openManifestStoreForAppend(at: manifestURL)
    defer { store.close() }
    return try ArchiveManifestReplay.validate(
      store.scanResult.records.map { try ArchiveManifestPayloadCodec.decode($0.plaintext) }
    )
  }

  private func makePiece(
    initial: ArchiveJournalPayload,
    manifest: ArchiveManifestPayload,
    gapBeforeMS: UInt64
  ) throws -> ArchiveDeliveryPiece {
    guard let startedAtMS = initial.startMS, let endedAtMS = initial.endMS else {
      throw ArchiveDeliveryCoordinatorError.missingServerTimestamps
    }
    guard endedAtMS >= startedAtMS else {
      throw ArchiveDeliveryCoordinatorError.invalidServerTimestampRange(
        start: startedAtMS,
        end: endedAtMS
      )
    }
    guard initial.chunkIndex <= 99_999 else {
      throw ArchiveDeliveryCoordinatorError.invalidServerIndex(initial.chunkIndex)
    }
    let source: ArchiveDeliverySource
    switch initial.laneID {
    case ArchiveDeliverySource.primary.rawValue: source = .primary
    case ArchiveDeliverySource.backup.rawValue: source = .backup
    default: throw ArchiveDeliveryCoordinatorError.unsupportedLaneID(initial.laneID)
    }
    let average = initial.averageLevelQ15.map { Double($0) / Double(UInt16.max >> 1) }
    let peak = initial.peakLevelQ15.map { Double($0) / Double(UInt16.max >> 1) }
    return ArchiveDeliveryPiece(
      sessionID: initial.sessionID,
      index: initial.chunkIndex,
      contentType: manifest.mime.rawValue,
      startedAtMS: startedAtMS,
      endedAtMS: endedAtMS,
      durationMS: endedAtMS - startedAtMS,
      sizeBytes: manifest.encodedBytes,
      gapBeforeMS: gapBeforeMS,
      peakLevel: peak,
      averageLevel: average,
      source: source
    )
  }

  private func probe(
    _ url: URL,
    stage: ArchiveDeliveryStage,
    reservation: ArchiveJournalReplayReservation,
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    journalURL: URL
  ) async throws -> ArchiveDeliveryRemoteObject {
    do {
      return try await wire.probeDeliveryObject(at: url)
    } catch {
      try observeFailure(
        stage,
        reservation: reservation,
        snapshot: snapshot,
        journalURL: journalURL
      )
      throw ArchiveDeliveryCoordinatorError.wireFailure(stage)
    }
  }

  private func requireExpectedSize(
    _ byteCount: UInt64?,
    expected: UInt64,
    reservation: ArchiveJournalReplayReservation,
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    journalURL: URL,
    stage: ArchiveDeliveryStage
  ) throws {
    guard let byteCount else {
      try observeFailure(
        stage,
        reservation: reservation,
        snapshot: snapshot,
        journalURL: journalURL
      )
      throw ArchiveDeliveryCoordinatorError.remoteContentLengthMissing
    }
    guard byteCount == expected else {
      try observeFailure(
        stage,
        reservation: reservation,
        snapshot: snapshot,
        journalURL: journalURL
      )
      throw ArchiveDeliveryCoordinatorError.remoteSizeMismatch(
        expected: expected,
        actual: byteCount
      )
    }
  }

  private func appendNextSuccess(
    reservation: ArchiveJournalReplayReservation,
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    journalURL: URL
  ) throws -> (reservation: ArchiveJournalReplayReservation, written: Bool) {
    let journal = try snapshot.openJournalStoreForAppend(at: journalURL)
    defer { journal.close() }
    let current = try currentReservation(
      journal: journal,
      expectedInitial: reservation.initialReservation
    )
    if current.state != reservation.state {
      guard stateRank(current.state) > stateRank(reservation.state) else {
        throw ArchiveJournalReplayError.stateMismatch(
          reservationID: reservation.initialReservation.reservationID,
          expected: reservation.state,
          actual: current.state
        )
      }
      return (current, false)
    }
    let next: ArchiveJournalState
    switch current.state {
    case .spoolDurable: next = .putComplete
    case .putComplete: next = .headVerified
    case .headVerified: next = .rowRegistered
    case .rowRegistered: next = .done
    case .reserved, .encoded, .done:
      throw ArchiveDeliveryCoordinatorError.deliveryBeforeSpoolDurable(reservation.state)
    }
    let transition = try ArchiveJournalTransition.make(
      from: reservation.initialReservation,
      attemptID: current.attemptID!,
      priorState: current.state,
      newState: next
    )
    try append(transition, to: journal)
    return (
      ArchiveJournalReplayReservation(
        initialReservation: reservation.initialReservation,
        state: next,
        attemptID: current.attemptID
      ),
      true
    )
  }

  private func observeFailure(
    _ stage: ArchiveDeliveryStage,
    reservation: ArchiveJournalReplayReservation,
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    journalURL: URL
  ) throws {
    do {
      let journal = try snapshot.openJournalStoreForAppend(at: journalURL)
      defer { journal.close() }
      let current = try currentReservation(
        journal: journal,
        expectedInitial: reservation.initialReservation
      )
      guard current.state == reservation.state else { return }
      let observation = try ArchiveJournalTransition.make(
        from: reservation.initialReservation,
        attemptID: current.attemptID!,
        priorState: current.state,
        newState: current.state,
        error: stage.rawValue
      )
      try append(observation, to: journal)
    } catch {
      throw ArchiveDeliveryCoordinatorError.failureObservationFailed(stage: stage)
    }
  }

  private func register(
    _ piece: ArchiveDeliveryPiece,
    reservation: ArchiveJournalReplayReservation,
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    journalURL: URL
  ) async throws -> ArchiveDeliveryRegistration {
    let registration: ArchiveDeliveryRegistration
    do {
      registration = try await wire.registerDelivery(piece)
    } catch {
      try observeFailure(
        .registration,
        reservation: reservation,
        snapshot: snapshot,
        journalURL: journalURL
      )
      throw ArchiveDeliveryCoordinatorError.wireFailure(.registration)
    }
    guard registration.ok, !registration.key.isEmpty, registration.uploadState == "verified" else {
      try observeFailure(
        .registration,
        reservation: reservation,
        snapshot: snapshot,
        journalURL: journalURL
      )
      throw ArchiveDeliveryCoordinatorError.registrationNotVerified
    }
    return registration
  }

  private func gapBeforeMS(
    initial: ArchiveJournalPayload,
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot
  ) -> UInt64 {
    guard
      let record = snapshot.indexRecords.first(where: {
        $0.payload.sampleStart == initial.sampleStart
      })?.payload,
      [.captureDiscontinuity, .resumed, .ringOverflow, .deviceLost].contains(record.discontinuity),
      let gapNS = record.gapNS
    else { return 0 }
    return gapNS / 1_000_000 + (gapNS % 1_000_000 >= 500_000 ? 1 : 0)
  }

  private func stateRank(_ state: ArchiveJournalState) -> Int {
    switch state {
    case .reserved: 0
    case .encoded: 1
    case .spoolDurable: 2
    case .putComplete: 3
    case .headVerified: 4
    case .rowRegistered: 5
    case .done: 6
    }
  }

  private func append(_ payload: ArchiveJournalPayload, to store: ArchiveDerivedStore) throws {
    let position = UInt64(store.scanResult.records.count)
    try store.append(
      plaintext: ArchiveJournalPayloadCodec.encode(payload),
      firstLogicalUnit: position,
      logicalUnitCount: 1
    )
  }
}
