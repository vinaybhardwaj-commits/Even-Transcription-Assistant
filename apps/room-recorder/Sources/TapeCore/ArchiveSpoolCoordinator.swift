import Foundation

public enum ArchiveSpoolCoordinatorError: Error, Equatable, Sendable {
  case missingReservation(String)
  case reservationMismatch(String)
  case missingManifestForDeliveryState(ArchiveJournalState)
  case invalidEncoderProvenanceID
  case attemptReuse(String)
  case encoderFailed(String)
  case spoolPublicationFailed(String)
  case manifestAppendFailed(String)
  case failureObservationFailed(original: String, observation: String)
}

public struct ArchiveSpoolDurabilityResult: Equatable, Sendable {
  public let published: ArchivePublishedSpoolAttempt
  public let manifest: ArchiveManifestPayload
  public let journalRecordsWritten: Int
  public let manifestWritten: Bool
}

public struct ArchiveSpoolCoordinator: Sendable {
  private let encoder: any ArchivePCMSpoolEncoding
  public let encoderProvenanceID: String

  public init(
    encoder: ArchiveFFmpegStreamingEncoder,
    encoderProvenanceID: String
  ) {
    self.encoder = encoder
    self.encoderProvenanceID = encoderProvenanceID
  }

  init(
    testEncoder encoder: any ArchivePCMSpoolEncoding,
    encoderProvenanceID: String
  ) {
    self.encoder = encoder
    self.encoderProvenanceID = encoderProvenanceID
  }

  public func advance(
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    journalURL: URL,
    manifestURL: URL,
    spoolDirectoryURL: URL,
    initialReservation: ArchiveJournalPayload,
    fitSegment: UInt64,
    freshAttemptID: String = UUID().uuidString.lowercased()
  ) throws -> ArchiveSpoolDurabilityResult {
    guard !encoderProvenanceID.isEmpty, encoderProvenanceID.utf8.count <= 256 else {
      throw ArchiveSpoolCoordinatorError.invalidEncoderProvenanceID
    }
    let journal = try snapshot.openJournalStoreForAppend(at: journalURL)
    defer { journal.close() }
    let manifestStore = try snapshot.openManifestStoreForAppend(at: manifestURL)
    defer { manifestStore.close() }
    var journalRecordsWritten = 0

    var reservation = try currentReservation(
      journal: journal,
      expectedInitial: initialReservation
    )
    let manifests = try currentManifests(manifestStore)
    if let manifest = manifests[initialReservation.reservationID] {
      let published = try ArchiveEncryptedSpoolPublisher.publish(
        snapshot: snapshot,
        directoryURL: spoolDirectoryURL,
        reservation: reservation,
        manifest: manifest
      )
      let scan = try snapshot.inspectSpool(at: published.url)
      _ = try ArchiveSpoolCorrespondence.validateManifest(
        initialReservation: initialReservation,
        manifest: manifest,
        spool: scan,
        spoolURL: published.url,
        expectedFitSegment: fitSegment
      )
      if reservation.state == .reserved {
        let encoded = try ArchiveJournalTransition.make(
          from: initialReservation,
          attemptID: manifest.attemptID,
          priorState: .reserved,
          newState: .encoded
        )
        try append(encoded, to: journal)
        journalRecordsWritten += 1
        reservation = try currentReservation(
          journal: journal,
          expectedInitial: initialReservation
        )
      }
      if reservation.state == .encoded, reservation.attemptID != manifest.attemptID {
        let reencoded = try ArchiveJournalTransition.make(
          from: initialReservation,
          attemptID: manifest.attemptID,
          priorState: .encoded,
          newState: .encoded
        )
        try append(reencoded, to: journal)
        journalRecordsWritten += 1
        reservation = try currentReservation(
          journal: journal,
          expectedInitial: initialReservation
        )
      }
      if reservation.state == .encoded {
        let durable = try ArchiveJournalTransition.make(
          from: initialReservation,
          attemptID: manifest.attemptID,
          priorState: .encoded,
          newState: .spoolDurable
        )
        try append(durable, to: journal)
        journalRecordsWritten += 1
        reservation = try currentReservation(
          journal: journal,
          expectedInitial: initialReservation
        )
      }
      _ = try ArchiveSpoolCorrespondence.validate(
        reservation: reservation,
        manifest: manifest,
        spool: scan,
        spoolURL: published.url,
        expectedFitSegment: fitSegment
      )
      return ArchiveSpoolDurabilityResult(
        published: published,
        manifest: manifest,
        journalRecordsWritten: journalRecordsWritten,
        manifestWritten: false
      )
    }

    guard reservation.state == .reserved || reservation.state == .encoded else {
      throw ArchiveSpoolCoordinatorError.missingManifestForDeliveryState(reservation.state)
    }
    if let boundAttemptID = reservation.attemptID, boundAttemptID == freshAttemptID {
      throw ArchiveSpoolCoordinatorError.attemptReuse(freshAttemptID)
    }

    let writer = try ArchiveEncryptedSpoolWriter(
      snapshot: snapshot,
      directoryURL: spoolDirectoryURL,
      reservationID: initialReservation.reservationID,
      attemptID: freshAttemptID
    )
    let completed: ArchiveEncodedSpoolAttempt
    do {
      completed = try encoder.encode(
        snapshot: snapshot,
        sampleStart: initialReservation.sampleStart,
        sampleEnd: initialReservation.sampleEnd,
        spoolWriter: writer
      )
    } catch {
      try observeFailure(
        journal: journal,
        initial: initialReservation,
        attemptID: reservation.attemptID ?? freshAttemptID,
        state: reservation.state,
        error: "encoder_failed",
        originalError: error
      )
      throw ArchiveSpoolCoordinatorError.encoderFailed(String(describing: error))
    }

    let published: ArchivePublishedSpoolAttempt
    do {
      published = try ArchiveEncryptedSpoolPublisher.publish(
        snapshot: snapshot,
        directoryURL: spoolDirectoryURL,
        reservation: reservation,
        expected: completed
      )
    } catch {
      try observeFailure(
        journal: journal,
        initial: initialReservation,
        attemptID: reservation.attemptID ?? freshAttemptID,
        state: reservation.state,
        error: "spool_publish_failed",
        originalError: error
      )
      throw ArchiveSpoolCoordinatorError.spoolPublicationFailed(String(describing: error))
    }

    let manifest = try ArchiveManifestPayload(
      reservationID: initialReservation.reservationID,
      attemptID: published.attemptID,
      sampleStart: initialReservation.sampleStart,
      sampleEnd: initialReservation.sampleEnd,
      startMS: initialReservation.startMS,
      endMS: initialReservation.endMS,
      uncertainty: initialReservation.uncertainty,
      fitSegment: fitSegment,
      averageLevelQ15: initialReservation.averageLevelQ15,
      peakLevelQ15: initialReservation.peakLevelQ15,
      mime: .audioWebM,
      encodedBytes: published.encodedBytes,
      encodedSHA256: published.encodedSHA256,
      encoderProvenanceID: encoderProvenanceID
    )
    do {
      try append(manifest, to: manifestStore)
    } catch {
      try observeFailure(
        journal: journal,
        initial: initialReservation,
        attemptID: reservation.attemptID ?? freshAttemptID,
        state: reservation.state,
        error: "manifest_append_failed",
        originalError: error
      )
      throw ArchiveSpoolCoordinatorError.manifestAppendFailed(String(describing: error))
    }
    let durableManifests = try currentManifests(manifestStore)
    guard durableManifests[initialReservation.reservationID] == manifest else {
      throw ArchiveSpoolCoordinatorError.manifestAppendFailed("manifest_replay_mismatch")
    }
    let encoded = try ArchiveJournalTransition.make(
      from: initialReservation,
      attemptID: freshAttemptID,
      priorState: reservation.state,
      newState: .encoded
    )
    try append(encoded, to: journal)
    journalRecordsWritten += 1
    reservation = try currentReservation(
      journal: journal,
      expectedInitial: initialReservation
    )
    let durable = try ArchiveJournalTransition.make(
      from: initialReservation,
      attemptID: freshAttemptID,
      priorState: .encoded,
      newState: .spoolDurable
    )
    try append(durable, to: journal)
    journalRecordsWritten += 1
    reservation = try currentReservation(
      journal: journal,
      expectedInitial: initialReservation
    )
    let scan = try snapshot.inspectSpool(at: published.url)
    _ = try ArchiveSpoolCorrespondence.validate(
      reservation: reservation,
      manifest: manifest,
      spool: scan,
      spoolURL: published.url,
      expectedFitSegment: fitSegment
    )
    return ArchiveSpoolDurabilityResult(
      published: published,
      manifest: manifest,
      journalRecordsWritten: journalRecordsWritten,
      manifestWritten: true
    )
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
      throw ArchiveSpoolCoordinatorError.missingReservation(expectedInitial.reservationID)
    }
    guard reservation.initialReservation == expectedInitial else {
      throw ArchiveSpoolCoordinatorError.reservationMismatch(expectedInitial.reservationID)
    }
    return reservation
  }

  private func currentManifests(_ store: ArchiveDerivedStore) throws
    -> [String: ArchiveManifestPayload]
  {
    try ArchiveManifestReplay.validate(
      store.scanResult.records.map { try ArchiveManifestPayloadCodec.decode($0.plaintext) }
    )
  }

  private func append(_ payload: ArchiveJournalPayload, to store: ArchiveDerivedStore) throws {
    let position = UInt64(store.scanResult.records.count)
    try store.append(
      plaintext: ArchiveJournalPayloadCodec.encode(payload),
      firstLogicalUnit: position,
      logicalUnitCount: 1
    )
  }

  private func append(_ payload: ArchiveManifestPayload, to store: ArchiveDerivedStore) throws {
    let position = UInt64(store.scanResult.records.count)
    try store.append(
      plaintext: ArchiveManifestPayloadCodec.encode(payload),
      firstLogicalUnit: position,
      logicalUnitCount: 1
    )
  }

  private func observeFailure(
    journal: ArchiveDerivedStore,
    initial: ArchiveJournalPayload,
    attemptID: String,
    state: ArchiveJournalState,
    error: String,
    originalError: Error
  ) throws {
    do {
      let observation = try ArchiveJournalTransition.make(
        from: initial,
        attemptID: attemptID,
        priorState: state,
        newState: state,
        error: error
      )
      try append(observation, to: journal)
    } catch {
      throw ArchiveSpoolCoordinatorError.failureObservationFailed(
        original: String(describing: originalError),
        observation: String(describing: error)
      )
    }
  }
}
