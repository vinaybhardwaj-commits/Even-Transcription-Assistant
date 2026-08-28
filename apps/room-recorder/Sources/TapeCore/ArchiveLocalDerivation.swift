import Foundation

public struct ArchiveLocalReservedPiece: Equatable, Sendable {
  public let reservation: ArchiveJournalPayload
  public let fitSegment: UInt64

  public init(reservation: ArchiveJournalPayload, fitSegment: UInt64) {
    self.reservation = reservation
    self.fitSegment = fitSegment
  }
}

public struct ArchiveLocalDerivationResult: Equatable, Sendable {
  public let authenticatedSampleCount: UInt64
  public let authenticatedSampleEnd: UInt64
  public let reservations: [ArchiveJournalPayload]
  public let reservedPieces: [ArchiveLocalReservedPiece]
  public let journalRecordsWritten: Int
  public let levelRecords: [ArchiveLevelRecordPlan]
  public let levelRecordsWritten: Int
  public let repairedJournalTrailingByteCount: UInt64
  public let repairedLevelTrailingByteCount: UInt64
}

public enum ArchiveLocalDerivationError: Error, Equatable, Sendable {
  case invalidSessionID
  case aliasedPath(String)
  case existingJournalMismatch(position: Int)
  case existingLevelMismatch(position: Int)
  case snapshotContextMismatch
}

public enum ArchiveLocalDeriver {
  public static func derive(
    tapeURL: URL,
    indexURL: URL,
    journalURL: URL,
    levelURL: URL,
    rootKey: Data,
    context: ArchiveContext,
    sessionID: String,
    finalFlush: Bool,
    initialSamplePosition: UInt64 = 0,
    startingChunkIndex: UInt64 = 0
  ) throws -> ArchiveLocalDerivationResult {
    guard !sessionID.isEmpty, sessionID.utf8.count <= 256 else {
      throw ArchiveLocalDerivationError.invalidSessionID
    }
    let paths = [tapeURL, indexURL, journalURL, levelURL].map { $0.standardizedFileURL.path }
    guard Set(paths).count == paths.count else {
      let duplicate = paths.first { value in paths.filter { $0 == value }.count > 1 } ?? "unknown"
      throw ArchiveLocalDerivationError.aliasedPath(duplicate)
    }
    let snapshot = try ArchiveLaneStore.openAuthenticatedSnapshot(
      tapeURL: tapeURL,
      indexURL: indexURL,
      rootKey: rootKey,
      context: context,
      initialSamplePosition: initialSamplePosition
    )
    defer { snapshot.close() }
    return try derive(
      snapshot: snapshot,
      journalURL: journalURL,
      levelURL: levelURL,
      rootKey: rootKey,
      context: context,
      sessionID: sessionID,
      finalFlush: finalFlush,
      startingChunkIndex: startingChunkIndex
    )
  }

  public static func derive(
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    journalURL: URL,
    levelURL: URL,
    rootKey: Data,
    context: ArchiveContext,
    sessionID: String,
    finalFlush: Bool,
    startingChunkIndex: UInt64 = 0
  ) throws -> ArchiveLocalDerivationResult {
    guard !sessionID.isEmpty, sessionID.utf8.count <= 256 else {
      throw ArchiveLocalDerivationError.invalidSessionID
    }
    guard journalURL.standardizedFileURL.path != levelURL.standardizedFileURL.path else {
      throw ArchiveLocalDerivationError.aliasedPath(journalURL.standardizedFileURL.path)
    }
    guard snapshot.authenticates(rootKey: rootKey, context: context) else {
      throw ArchiveLocalDerivationError.snapshotContextMismatch
    }
    return try derive(
      snapshot: snapshot,
      journalURL: journalURL,
      levelURL: levelURL,
      sessionID: sessionID,
      finalFlush: finalFlush,
      startingChunkIndex: startingChunkIndex
    )
  }

  public static func derive(
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    journalURL: URL,
    levelURL: URL,
    sessionID: String,
    finalFlush: Bool,
    startingChunkIndex: UInt64 = 0
  ) throws -> ArchiveLocalDerivationResult {
    guard !sessionID.isEmpty, sessionID.utf8.count <= 256 else {
      throw ArchiveLocalDerivationError.invalidSessionID
    }
    guard journalURL.standardizedFileURL.path != levelURL.standardizedFileURL.path else {
      throw ArchiveLocalDerivationError.aliasedPath(journalURL.standardizedFileURL.path)
    }
    for url in [journalURL, levelURL] {
      if try snapshot.aliasesSourceFile(at: url) {
        throw ArchiveLocalDerivationError.aliasedPath(url.standardizedFileURL.path)
      }
    }
    let context = snapshot.context
    let initialSamplePosition = snapshot.initialSamplePosition
    let indexRecords = snapshot.indexRecords
    guard let authenticatedEnd = indexRecords.last?.payload.sampleEnd else {
      try validateEmptyDerivedIfPresent(
        snapshot: snapshot,
        journalURL: journalURL,
        levelURL: levelURL,
        initialSamplePosition: initialSamplePosition
      )
      return ArchiveLocalDerivationResult(
        authenticatedSampleCount: 0,
        authenticatedSampleEnd: initialSamplePosition,
        reservations: [],
        reservedPieces: [],
        journalRecordsWritten: 0,
        levelRecords: [],
        levelRecordsWritten: 0,
        repairedJournalTrailingByteCount: 0,
        repairedLevelTrailingByteCount: 0
      )
    }
    let readPCM: (UInt64, UInt64) throws -> Data = { start, end in
      try snapshot.readPCMRange(sampleStart: start, sampleEnd: end).pcm
    }
    let plans = try ArchiveLocalCutter.plan(
      indexRecords: indexRecords,
      startingChunkIndex: 0,
      finalFlush: finalFlush
    )
    var existingJournalRecords: [ArchiveDerivedRecord] = []
    if FileManager.default.fileExists(atPath: journalURL.path) {
      let existing = try snapshot.inspectJournal(at: journalURL)
      existingJournalRecords = existing.records
    }
    let existingPayloads = try existingJournalRecords.map {
      try ArchiveJournalPayloadCodec.decode($0.plaintext)
    }
    _ = try ArchiveJournalReplay.validate(existingPayloads)
    let existingInitialReservations = existingPayloads.filter {
      $0.priorState == nil && $0.newState == .reserved && $0.error == nil
    }
    guard existingInitialReservations.count <= plans.count else {
      throw ArchiveLocalDerivationError.existingJournalMismatch(position: plans.count)
    }
    try ArchiveReservationIndexReconciler.validate(existingInitialReservations)
    var nextChunkIndex = startingChunkIndex
    if let localMaximum = existingInitialReservations.map(\.chunkIndex).max() {
      nextChunkIndex = max(nextChunkIndex, UInt64(localMaximum) + 1)
    }
    var reservations: [ArchiveJournalPayload] = []
    var reservedPieces: [ArchiveLocalReservedPiece] = []
    reservations.reserveCapacity(plans.count)
    reservedPieces.reserveCapacity(plans.count)
    for (position, plan) in plans.enumerated() {
      let pcm = try readPCM(plan.sampleStart, plan.sampleEnd)
      let levels = try ArchiveLevelSidecarBuilder.quantizedLevels(pcm)
      let chunkIndex: UInt32
      if position < existingInitialReservations.count {
        chunkIndex = existingInitialReservations[position].chunkIndex
      } else {
        guard nextChunkIndex <= UInt64(ArchiveReservationIndexReconciler.maximumServerIndex) else {
          throw ArchiveReservationIndexError.indexExhausted(
            ArchiveReservationLane(sessionID: sessionID, laneID: context.laneID)
          )
        }
        chunkIndex = UInt32(nextChunkIndex)
        nextChunkIndex += 1
      }
      let reservationID = try ArchiveReservationIdentity.make(
        context: context,
        sessionID: sessionID,
        chunkIndex: chunkIndex,
        sampleStart: plan.sampleStart,
        sampleEnd: plan.sampleEnd
      )
      let reservation = try ArchiveJournalPayload(
        reservationID: reservationID,
        roomID: context.roomID,
        sessionID: sessionID,
        laneID: context.laneID,
        istDate: context.istDate,
        chunkIndex: chunkIndex,
        sampleStart: plan.sampleStart,
        sampleEnd: plan.sampleEnd,
        startMS: plan.startMS,
        endMS: plan.endMS,
        uncertainty: plan.uncertainty,
        averageLevelQ15: levels.averageQ15,
        peakLevelQ15: levels.peakQ15,
        attemptID: nil,
        priorState: nil,
        newState: .reserved,
        error: nil
      )
      if position < existingInitialReservations.count,
        reservation != existingInitialReservations[position]
      {
        let recordPosition =
          existingPayloads.firstIndex {
            $0.reservationID == existingInitialReservations[position].reservationID
          } ?? position
        throw ArchiveLocalDerivationError.existingJournalMismatch(position: recordPosition)
      }
      reservations.append(reservation)
      reservedPieces.append(
        ArchiveLocalReservedPiece(
          reservation: reservation,
          fitSegment: plan.fitSegment
        ))
    }
    var existingLevelRecords: [ArchiveDerivedRecord] = []
    _ = try validateJournalReservations(existingJournalRecords, expected: reservations)
    if FileManager.default.fileExists(atPath: levelURL.path) {
      let existing = try snapshot.inspectLevel(
        at: levelURL,
        initialLogicalUnit: initialSamplePosition
      )
      existingLevelRecords = existing.records
    }
    let frozenLevelPlans = try existingLevelRecords.enumerated().map { position, record in
      do {
        return ArchiveLevelRecordPlan(
          firstSample: record.header.firstLogicalUnit,
          sampleCount: record.header.logicalUnitCount,
          observations: try ArchiveLevelPayloadCodec.decode(record.plaintext))
      } catch {
        throw ArchiveLocalDerivationError.existingLevelMismatch(position: position)
      }
    }
    let levelPlans: [ArchiveLevelRecordPlan]
    do {
      levelPlans = try ArchiveLevelSidecarBuilder.build(
        indexRecords: indexRecords,
        frozenRecords: frozenLevelPlans,
        readPCM: readPCM)
    } catch ArchiveLevelSidecarError.frozenRecordMismatch(let position) {
      throw ArchiveLocalDerivationError.existingLevelMismatch(position: position)
    }
    var journalStore: ArchiveDerivedStore?
    var levelStore: ArchiveDerivedStore?
    do {
      journalStore = try snapshot.openJournalStoreForAppend(
        at: journalURL,
        headerValidator: { header, position in
          guard header.firstLogicalUnit == UInt64(position), header.logicalUnitCount == 1
          else {
            throw ArchiveLocalDerivationError.existingJournalMismatch(position: position)
          }
        },
        partialHeaderValidator: { partial, position in
          try validatePartialJournalHeader(
            partial,
            position: position,
            mismatch: .existingJournalMismatch(position: position)
          )
        },
        repairTrailingRecord: false
      )
      levelStore = try snapshot.openLevelStoreForAppend(
        at: levelURL,
        initialLogicalUnit: initialSamplePosition,
        headerValidator: { header, position in
          guard position < levelPlans.count,
            header.firstLogicalUnit == levelPlans[position].firstSample,
            header.logicalUnitCount == levelPlans[position].sampleCount,
            header.plaintextByteCount == UInt32(levelPlans[position].plaintext.count)
          else {
            throw ArchiveLocalDerivationError.existingLevelMismatch(position: position)
          }
        },
        partialHeaderValidator: { partial, position in
          try validatePartialExpectedHeader(
            partial,
            position: position,
            expectedFirstLogicalUnit: levelPlans[safe: position]?.firstSample,
            expectedLogicalUnitCount: levelPlans[safe: position].map { UInt32($0.sampleCount) },
            expectedPlaintextByteCount: levelPlans[safe: position]?.plaintext.count,
            mismatch: .existingLevelMismatch(position: position)
          )
        },
        repairTrailingRecord: false
      )
      _ = try validateJournalReservations(
        journalStore!.scanResult.records,
        expected: reservations
      )
      try validateLevelPrefix(levelStore!.scanResult.records, expected: levelPlans)
      try journalStore!.repairIncompleteTrailingRecord()
      try levelStore!.repairIncompleteTrailingRecord()
    } catch {
      let originalError = error
      do {
        try levelStore?.discardIfCreatedAndEmpty()
        try journalStore?.discardIfCreatedAndEmpty()
      } catch {
        levelStore?.close()
        journalStore?.close()
        throw error
      }
      levelStore?.close()
      journalStore?.close()
      throw originalError
    }
    defer { levelStore!.close() }
    defer { journalStore!.close() }

    let existingReservations = try validateJournalReservations(
      journalStore!.scanResult.records,
      expected: reservations
    )
    let missingReservations = reservations.filter {
      existingReservations[$0.reservationID] == nil
    }
    var journalPosition = journalStore!.scanResult.records.count
    for reservation in missingReservations {
      try journalStore!.append(
        plaintext: ArchiveJournalPayloadCodec.encode(reservation),
        firstLogicalUnit: UInt64(journalPosition),
        logicalUnitCount: 1
      )
      journalPosition += 1
    }
    let levelStart = levelStore!.scanResult.records.count
    for position in levelStart..<levelPlans.count {
      let plan = levelPlans[position]
      try levelStore!.append(
        plaintext: plan.plaintext,
        firstLogicalUnit: plan.firstSample,
        logicalUnitCount: plan.sampleCount
      )
    }
    let covered = authenticatedEnd.subtractingReportingOverflow(initialSamplePosition)
    guard !covered.overflow else {
      throw ArchiveLanePersistenceError.arithmeticOverflow(field: "authenticated_sample_count")
    }
    return ArchiveLocalDerivationResult(
      authenticatedSampleCount: covered.partialValue,
      authenticatedSampleEnd: authenticatedEnd,
      reservations: reservations,
      reservedPieces: reservedPieces,
      journalRecordsWritten: missingReservations.count,
      levelRecords: levelPlans,
      levelRecordsWritten: levelPlans.count - levelStart,
      repairedJournalTrailingByteCount: journalStore!.repairedTrailingByteCount,
      repairedLevelTrailingByteCount: levelStore!.repairedTrailingByteCount
    )
  }

  private static func validateJournalReservations(
    _ records: [ArchiveDerivedRecord],
    expected: [ArchiveJournalPayload]
  ) throws -> [String: ArchiveJournalReplayReservation] {
    let payloads = try records.map { try ArchiveJournalPayloadCodec.decode($0.plaintext) }
    let replay = try ArchiveJournalReplay.validate(payloads)
    let expectedByID = Dictionary(uniqueKeysWithValues: expected.map { ($0.reservationID, $0) })
    for (reservationID, reservation) in replay {
      guard reservation.initialReservation == expectedByID[reservationID] else {
        let position = payloads.firstIndex { $0.reservationID == reservationID } ?? records.count
        throw ArchiveLocalDerivationError.existingJournalMismatch(position: position)
      }
    }
    return replay
  }

  private static func validateEmptyDerivedIfPresent(
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    journalURL: URL,
    levelURL: URL,
    initialSamplePosition: UInt64
  ) throws {
    if FileManager.default.fileExists(atPath: journalURL.path) {
      let journal = try snapshot.inspectJournal(at: journalURL)
      guard journal.records.isEmpty, journal.incompleteTrailingByteCount == 0 else {
        throw ArchiveLocalDerivationError.existingJournalMismatch(position: 0)
      }
    }
    if FileManager.default.fileExists(atPath: levelURL.path) {
      let level = try snapshot.inspectLevel(
        at: levelURL,
        initialLogicalUnit: initialSamplePosition
      )
      guard level.records.isEmpty, level.incompleteTrailingByteCount == 0 else {
        throw ArchiveLocalDerivationError.existingLevelMismatch(position: 0)
      }
    }
  }

  private static func validateLevelPrefix(
    _ records: [ArchiveDerivedRecord],
    expected: [ArchiveLevelRecordPlan]
  ) throws {
    guard records.count <= expected.count else {
      throw ArchiveLocalDerivationError.existingLevelMismatch(position: expected.count)
    }
    for position in records.indices {
      let plan = expected[position]
      guard records[position].header.firstLogicalUnit == plan.firstSample,
        records[position].header.logicalUnitCount == plan.sampleCount,
        records[position].plaintext == plan.plaintext
      else {
        throw ArchiveLocalDerivationError.existingLevelMismatch(position: position)
      }
    }
  }

  private static func validatePartialExpectedHeader(
    _ partial: Data,
    position: Int,
    expectedFirstLogicalUnit: UInt64?,
    expectedLogicalUnitCount: UInt32?,
    expectedPlaintextByteCount: Int?,
    mismatch: ArchiveLocalDerivationError
  ) throws {
    guard let expectedFirstLogicalUnit, let expectedLogicalUnitCount,
      let expectedPlaintextByteCount, expectedPlaintextByteCount <= Int(UInt32.max)
    else {
      throw mismatch
    }
    let fields: [(offset: Int, bytes: [UInt8])] = [
      (40, littleEndianBytes(expectedFirstLogicalUnit)),
      (48, littleEndianBytes(expectedLogicalUnitCount)),
      (52, littleEndianBytes(UInt32(expectedPlaintextByteCount))),
    ]
    for field in fields where partial.count > field.offset {
      let available = min(field.bytes.count, partial.count - field.offset)
      guard
        Array(partial[field.offset..<(field.offset + available)])
          == Array(field.bytes.prefix(available))
      else {
        throw mismatch
      }
    }
    _ = position
  }

  private static func validatePartialJournalHeader(
    _ partial: Data,
    position: Int,
    mismatch: ArchiveLocalDerivationError
  ) throws {
    let fields: [(offset: Int, bytes: [UInt8])] = [
      (40, littleEndianBytes(UInt64(position))),
      (48, littleEndianBytes(UInt32(1))),
    ]
    for field in fields where partial.count > field.offset {
      let available = min(field.bytes.count, partial.count - field.offset)
      guard
        Array(partial[field.offset..<(field.offset + available)])
          == Array(field.bytes.prefix(available))
      else {
        throw mismatch
      }
    }
  }

  private static func littleEndianBytes<T: FixedWidthInteger>(_ value: T) -> [UInt8] {
    (0..<MemoryLayout<T>.size).map {
      UInt8(truncatingIfNeeded: value >> T($0 * 8))
    }
  }
}

extension Array {
  fileprivate subscript(safe index: Int) -> Element? {
    indices.contains(index) ? self[index] : nil
  }
}
