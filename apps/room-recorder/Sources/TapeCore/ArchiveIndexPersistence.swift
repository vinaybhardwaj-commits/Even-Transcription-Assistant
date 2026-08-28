import Darwin
import Foundation

public enum ArchiveLaneFile: String, Equatable, Sendable {
  case tape
  case index
}

public struct ArchiveIndexRecordMetadata: Equatable, Sendable {
  public let header: ArchiveEnvelopeHeader
  public let payload: ArchiveIndexPayload
  public let authenticationTag: Data
  public let encryptedStartOffset: UInt64
  public let encryptedEndOffset: UInt64
}

public struct ArchiveIndexScanResult: Equatable, Sendable {
  public let records: [ArchiveIndexRecordMetadata]
  public let completeByteCount: UInt64
  public let incompleteTrailingByteCount: UInt64
  public let initialSamplePosition: UInt64

  public init(
    records: [ArchiveIndexRecordMetadata],
    completeByteCount: UInt64,
    incompleteTrailingByteCount: UInt64,
    initialSamplePosition: UInt64 = 0
  ) {
    self.records = records
    self.completeByteCount = completeByteCount
    self.incompleteTrailingByteCount = incompleteTrailingByteCount
    self.initialSamplePosition = initialSamplePosition
  }
}

public struct ArchiveLaneScanResult: Equatable, Sendable {
  public let tape: ArchiveTapeScanResult
  public let index: ArchiveIndexScanResult

  public var initialSamplePosition: UInt64 { tape.initialLogicalUnit }

  public init(tape: ArchiveTapeScanResult, index: ArchiveIndexScanResult) {
    self.tape = tape
    self.index = index
  }
}

public struct ArchiveAuthenticatedLaneFacts: Equatable, Sendable {
  public let context: ArchiveContext
  public let initialSamplePosition: UInt64
  public let authenticatedSampleEnd: UInt64
  public let recordCount: Int

  fileprivate init(context: ArchiveContext, scanResult: ArchiveLaneScanResult) {
    self.context = context
    initialSamplePosition = scanResult.initialSamplePosition
    authenticatedSampleEnd =
      scanResult.index.records.last?.payload.sampleEnd ?? scanResult.initialSamplePosition
    recordCount = scanResult.index.records.count
  }
}

public struct AuthenticatedArchivePCMRange: Equatable, Sendable {
  public let sampleStart: UInt64
  public let sampleEnd: UInt64
  public let pcm: Data
  public let indexRecords: [ArchiveIndexRecordMetadata]
}

public struct AuthenticatedArchivePCMStreamResult: Equatable, Sendable {
  public let sampleStart: UInt64
  public let sampleEnd: UInt64
  public let byteCount: UInt64
  public let indexRecords: [ArchiveIndexRecordMetadata]
}

public struct ArchiveIndexObservation: Equatable, Sendable {
  public let monoNS: UInt64?
  public let wallNS: UInt64?
  public let rmsQ15: UInt16?
  public let nativeFrames: UInt64?
  public let inputRateNumerator: UInt64?
  public let inputRateDenominator: UInt64?
  public let discontinuity: ArchiveIndexDiscontinuity?
  public let reason: String?
  public let gapNS: UInt64?
  public let previousDurableSample: UInt64?
  public let survivingTailBytes: UInt64?

  public init(
    monoNS: UInt64?,
    wallNS: UInt64?,
    rmsQ15: UInt16?,
    nativeFrames: UInt64?,
    inputRateNumerator: UInt64?,
    inputRateDenominator: UInt64?,
    discontinuity: ArchiveIndexDiscontinuity? = nil,
    reason: String? = nil,
    gapNS: UInt64? = nil,
    previousDurableSample: UInt64? = nil,
    survivingTailBytes: UInt64? = nil
  ) {
    self.monoNS = monoNS
    self.wallNS = wallNS
    self.rmsQ15 = rmsQ15
    self.nativeFrames = nativeFrames
    self.inputRateNumerator = inputRateNumerator
    self.inputRateDenominator = inputRateDenominator
    self.discontinuity = discontinuity
    self.reason = reason
    self.gapNS = gapNS
    self.previousDurableSample = previousDurableSample
    self.survivingTailBytes = survivingTailBytes
  }
}

public struct ArchiveLaneAppendResult: Equatable, Sendable {
  public let tape: ArchiveTapeRecordMetadata
  public let index: ArchiveIndexRecordMetadata
}

public enum ArchiveLanePersistenceError: Error, Equatable, Sendable {
  case sameFile
  case openFailed(file: ArchiveLaneFile, path: String, errno: Int32)
  case lockFailed(file: ArchiveLaneFile, errno: Int32)
  case notRegularFile(ArchiveLaneFile)
  case statFailed(file: ArchiveLaneFile, errno: Int32)
  case fileTooLarge(file: ArchiveLaneFile, size: Int64)
  case readFailed(file: ArchiveLaneFile, offset: UInt64, errno: Int32)
  case unexpectedEndOfFile(file: ArchiveLaneFile, offset: UInt64)
  case streamUUIDMismatch(file: ArchiveLaneFile)
  case invalidFirstSequence(file: ArchiveLaneFile, actual: UInt64)
  case sequenceDiscontinuity(file: ArchiveLaneFile, expected: UInt64, actual: UInt64)
  case invalidFirstLogicalUnit(file: ArchiveLaneFile, actual: UInt64)
  case initialSamplePositionMismatch(file: ArchiveLaneFile, expected: UInt64, actual: UInt64)
  case logicalDiscontinuity(file: ArchiveLaneFile, expected: UInt64, actual: UInt64)
  case predecessorMismatch(file: ArchiveLaneFile, sequence: UInt64)
  case recordCountExceedsLimit(file: ArchiveLaneFile, count: UInt64)
  case indexAhead(indexCount: UInt64, tapeCount: UInt64)
  case indexTapeSequenceMismatch(indexSequence: UInt64, tapeSequence: UInt64)
  case indexTapeTagMismatch(sequence: UInt64)
  case indexEncryptedEndMismatch(sequence: UInt64, expected: UInt64, actual: UInt64)
  case indexSampleRangeMismatch(
    sequence: UInt64, expectedStart: UInt64, expectedEnd: UInt64, actualStart: UInt64,
    actualEnd: UInt64)
  case indexDeviceUIDMismatch(sequence: UInt64)
  case indexEnvelopeRangeMismatch(sequence: UInt64)
  case arithmeticOverflow(field: String)
  case invalidPCMByteCount(Int)
  case invalidReadRange(start: UInt64, end: UInt64)
  case readRangeBeyondAuthenticatedEnd(requested: UInt64, authenticated: UInt64)
  case recoveryObservationNotAllowed
  case writeFailed(file: ArchiveLaneFile, offset: UInt64, errno: Int32)
  case writeMadeNoProgress(file: ArchiveLaneFile, offset: UInt64)
  case fullSyncFailed(file: ArchiveLaneFile, offset: UInt64, errno: Int32)
  case truncateFailed(file: ArchiveLaneFile, offset: UInt64, errno: Int32)
  case directorySyncFailed(file: ArchiveLaneFile, path: String, errno: Int32)
  case createdPathChanged(file: ArchiveLaneFile, path: String)
  case createdPathCleanupFailed(file: ArchiveLaneFile, path: String, errno: Int32)
  case recoveryEpochMismatch(sequence: UInt64)
  case descriptorDuplicationFailed(file: ArchiveLaneFile, errno: Int32)
  case pathInspectionFailed(path: String, errno: Int32)
  case requiresAuthenticatedReopen
  case closed
}

enum ArchiveLanePersistenceEvent: Equatable, Sendable {
  case tapeRepair
  case indexRepair
  case tapeSeal
  case tapeWrite
  case tapeFullSync
  case tapeDirectorySync
  case indexSeal
  case indexWrite
  case indexFullSync
  case indexDirectorySync
  case adoption(UInt64)
}

struct ArchiveLanePersistenceHooks {
  var pread: (Int32, UnsafeMutableRawPointer, Int, off_t) -> Int = Darwin.pread
  var write: (Int32, UnsafeRawPointer, Int) -> Int = Darwin.write
  var fullSync: (Int32) -> Int32 = { fcntl($0, F_FULLFSYNC) }
  var truncate: (Int32, off_t) -> Int32 = Darwin.ftruncate
  var synchronizeDirectory: (URL) throws -> Void = laneSynchronizeDirectory
  var initializeStore: () throws -> Void = {}
  var event: (ArchiveLanePersistenceEvent) -> Void = { _ in }
}

public final class ArchiveLaneStore: @unchecked Sendable {
  public final class AuthenticatedSnapshot: @unchecked Sendable {
    private let lock = NSLock()
    private var descriptors: LaneDescriptors?
    private let rootKey: Data
    public let context: ArchiveContext
    public let initialSamplePosition: UInt64
    private let contextHash: Data
    fileprivate let scanResult: ArchiveLaneScanResult

    public var indexRecords: [ArchiveIndexRecordMetadata] {
      scanResult.index.records
    }

    public var authenticatedFacts: ArchiveAuthenticatedLaneFacts {
      ArchiveAuthenticatedLaneFacts(context: context, scanResult: scanResult)
    }

    fileprivate init(
      descriptors: LaneDescriptors,
      rootKey: Data,
      context: ArchiveContext,
      initialSamplePosition: UInt64,
      contextHash: Data,
      scanResult: ArchiveLaneScanResult
    ) {
      self.descriptors = descriptors
      self.rootKey = rootKey
      self.context = context
      self.initialSamplePosition = initialSamplePosition
      self.contextHash = contextHash
      self.scanResult = scanResult
    }

    deinit {
      close()
    }

    public func readPCMRange(
      sampleStart: UInt64,
      sampleEnd: UInt64
    ) throws -> AuthenticatedArchivePCMRange {
      var pcm = Data()
      let result = try streamPCMRange(sampleStart: sampleStart, sampleEnd: sampleEnd) {
        pcm.append($0)
      }
      return AuthenticatedArchivePCMRange(
        sampleStart: result.sampleStart,
        sampleEnd: result.sampleEnd,
        pcm: pcm,
        indexRecords: result.indexRecords
      )
    }

    public func streamPCMRange(
      sampleStart: UInt64,
      sampleEnd: UInt64,
      consume: (Data) throws -> Void
    ) throws -> AuthenticatedArchivePCMStreamResult {
      try lock.withLock {
        guard let descriptors else { throw ArchiveLanePersistenceError.closed }
        return try ArchiveLaneStore.streamAuthenticatedPCMRange(
          descriptors: descriptors,
          scan: scanResult,
          rootKey: rootKey,
          contextHash: contextHash,
          sampleStart: sampleStart,
          sampleEnd: sampleEnd,
          consume: consume
        )
      }
    }

    public func inspectJournal(at url: URL) throws -> ArchiveDerivedScanResult {
      try inspectDerivedStore(
        at: url,
        purpose: .journal,
        validator: { try ArchiveJournalPayloadCodec.validateRecord($0) }
      )
    }

    public func openJournalStoreForAppend(
      at url: URL,
      headerValidator: @escaping ArchiveDerivedStore.HeaderValidator = { _, _ in },
      partialHeaderValidator: @escaping ArchiveDerivedStore.PartialHeaderValidator = { _, _ in },
      repairTrailingRecord: Bool = true
    ) throws -> ArchiveDerivedStore {
      try openDerivedStoreForAppend(
        at: url,
        purpose: .journal,
        validator: { try ArchiveJournalPayloadCodec.validateRecord($0) },
        headerValidator: headerValidator,
        partialHeaderValidator: partialHeaderValidator,
        allowExpectedIncompletePayloadRepair: true,
        repairTrailingRecord: repairTrailingRecord
      )
    }

    public func inspectLevel(
      at url: URL,
      initialLogicalUnit: UInt64
    ) throws -> ArchiveDerivedScanResult {
      try inspectDerivedStore(
        at: url,
        purpose: .level,
        validator: { try ArchiveLevelPayloadCodec.validateRecord($0) },
        initialLogicalUnit: initialLogicalUnit
      )
    }

    public func openLevelStoreForAppend(
      at url: URL,
      initialLogicalUnit: UInt64,
      headerValidator: @escaping ArchiveDerivedStore.HeaderValidator = { _, _ in },
      partialHeaderValidator: @escaping ArchiveDerivedStore.PartialHeaderValidator = { _, _ in },
      repairTrailingRecord: Bool = true
    ) throws -> ArchiveDerivedStore {
      try openDerivedStoreForAppend(
        at: url,
        purpose: .level,
        validator: { try ArchiveLevelPayloadCodec.validateRecord($0) },
        headerValidator: headerValidator,
        partialHeaderValidator: partialHeaderValidator,
        allowExpectedIncompletePayloadRepair: true,
        repairTrailingRecord: repairTrailingRecord,
        initialLogicalUnit: initialLogicalUnit
      )
    }

    public func openManifestStoreForAppend(at url: URL) throws -> ArchiveDerivedStore {
      try openDerivedStoreForAppend(
        at: url,
        purpose: .manifest,
        validator: { try ArchiveManifestPayloadCodec.validateRecord($0) },
        allowExpectedIncompletePayloadRepair: true
      )
    }

    func openSpoolStoreForAppend(
      at url: URL,
      repairTrailingRecord: Bool = true
    ) throws -> ArchiveDerivedStore {
      try openDerivedStoreForAppend(
        at: url,
        purpose: .spool,
        repairTrailingRecord: repairTrailingRecord
      )
    }

    func createSpoolStore(at url: URL) throws -> ArchiveDerivedStore {
      try lock.withLock {
        guard descriptors != nil else { throw ArchiveLanePersistenceError.closed }
        return try ArchiveDerivedStore.createNew(
          url: url,
          purpose: .spool,
          rootKey: rootKey,
          context: context
        )
      }
    }

    func createSpoolStore(
      directoryFileDescriptor: Int32,
      fileName: String,
      at url: URL
    ) throws -> ArchiveDerivedStore {
      try lock.withLock {
        guard descriptors != nil else { throw ArchiveLanePersistenceError.closed }
        return try ArchiveDerivedStore.createNew(
          directoryFileDescriptor: directoryFileDescriptor,
          fileName: fileName,
          url: url,
          purpose: .spool,
          rootKey: rootKey,
          context: context
        )
      }
    }

    public func inspectSpool(at url: URL) throws -> ArchiveDerivedScanResult {
      try lock.withLock {
        guard descriptors != nil else { throw ArchiveLanePersistenceError.closed }
        return try ArchiveDerivedStore.inspect(
          url: url,
          purpose: .spool,
          rootKey: rootKey,
          context: context
        )
      }
    }

    func inspectSpool(fileDescriptor: Int32) throws -> ArchiveDerivedScanResult {
      try lock.withLock {
        guard descriptors != nil else { throw ArchiveLanePersistenceError.closed }
        return try ArchiveDerivedStore.inspect(
          fileDescriptor: fileDescriptor,
          purpose: .spool,
          rootKey: rootKey,
          context: context
        )
      }
    }

    private func openDerivedStoreForAppend(
      at url: URL,
      purpose: ArchiveRecordPurpose,
      validator: @escaping ArchiveDerivedStore.PayloadValidator = { _ in },
      headerValidator: @escaping ArchiveDerivedStore.HeaderValidator = { _, _ in },
      partialHeaderValidator: @escaping ArchiveDerivedStore.PartialHeaderValidator = { _, _ in },
      allowExpectedIncompletePayloadRepair: Bool = false,
      repairTrailingRecord: Bool = true,
      initialLogicalUnit: UInt64 = 0
    ) throws -> ArchiveDerivedStore {
      try lock.withLock {
        guard descriptors != nil else { throw ArchiveLanePersistenceError.closed }
        return try ArchiveDerivedStore.openRecoveringForAppend(
          url: url,
          purpose: purpose,
          rootKey: rootKey,
          context: context,
          validator: validator,
          headerValidator: headerValidator,
          partialHeaderValidator: partialHeaderValidator,
          allowExpectedIncompletePayloadRepair: allowExpectedIncompletePayloadRepair,
          repairTrailingRecord: repairTrailingRecord,
          initialLogicalUnit: initialLogicalUnit
        )
      }
    }

    private func inspectDerivedStore(
      at url: URL,
      purpose: ArchiveRecordPurpose,
      validator: @escaping ArchiveDerivedStore.PayloadValidator = { _ in },
      initialLogicalUnit: UInt64 = 0
    ) throws -> ArchiveDerivedScanResult {
      try lock.withLock {
        guard descriptors != nil else { throw ArchiveLanePersistenceError.closed }
        return try ArchiveDerivedStore.inspect(
          url: url,
          purpose: purpose,
          rootKey: rootKey,
          context: context,
          validator: validator,
          initialLogicalUnit: initialLogicalUnit
        )
      }
    }

    public func close() {
      lock.withLock {
        guard let descriptors else { return }
        self.descriptors = nil
        _ = Darwin.close(descriptors.index)
        _ = Darwin.close(descriptors.tape)
      }
    }

    func authenticates(rootKey: Data, context: ArchiveContext) -> Bool {
      self.rootKey == rootKey && self.context == context
    }

    func aliasesSourceFile(at url: URL) throws -> Bool {
      try lock.withLock {
        guard let descriptors else { throw ArchiveLanePersistenceError.closed }
        var pathStat = stat()
        var result: Int32
        repeat {
          result = lstat(url.path, &pathStat)
        } while result != 0 && errno == EINTR
        if result != 0, errno == ENOENT { return false }
        guard result == 0 else {
          throw ArchiveLanePersistenceError.pathInspectionFailed(path: url.path, errno: errno)
        }
        for (file, descriptor) in [
          (ArchiveLaneFile.tape, descriptors.tape),
          (ArchiveLaneFile.index, descriptors.index),
        ] {
          var descriptorStat = stat()
          guard retryingStat(descriptor, &descriptorStat) == 0 else {
            throw ArchiveLanePersistenceError.statFailed(file: file, errno: errno)
          }
          if pathStat.st_dev == descriptorStat.st_dev && pathStat.st_ino == descriptorStat.st_ino {
            return true
          }
        }
        return false
      }
    }
  }

  private let lock = NSLock()
  private let tapeURL: URL
  private let indexURL: URL
  private let context: ArchiveContext
  private let contextHash: Data
  private let rootKey: Data
  public let initialSamplePosition: UInt64
  private let tapeSealer: ArchivePurposeSealer
  private let indexSealer: ArchivePurposeSealer
  private let hooks: ArchiveLanePersistenceHooks
  private var tapeFileDescriptor: Int32?
  private var indexFileDescriptor: Int32?
  private var tapeRecords: [ArchiveTapeRecordMetadata]
  private var indexRecords: [ArchiveIndexRecordMetadata]
  private var poisoned = false
  private var needsTapeDirectorySync: Bool
  private var needsIndexDirectorySync: Bool

  public let repairedTapeTrailingByteCount: UInt64
  public let repairedIndexTrailingByteCount: UInt64
  public let adoptedRecordCount: UInt64

  private init(
    tapeURL: URL,
    indexURL: URL,
    context: ArchiveContext,
    contextHash: Data,
    rootKey: Data,
    initialSamplePosition: UInt64,
    tapeSealer: ArchivePurposeSealer,
    indexSealer: ArchivePurposeSealer,
    tapeFileDescriptor: Int32,
    indexFileDescriptor: Int32,
    tapeRecords: [ArchiveTapeRecordMetadata],
    indexRecords: [ArchiveIndexRecordMetadata],
    repairedTapeTrailingByteCount: UInt64,
    repairedIndexTrailingByteCount: UInt64,
    hooks: ArchiveLanePersistenceHooks
  ) {
    self.tapeURL = tapeURL
    self.indexURL = indexURL
    self.context = context
    self.contextHash = contextHash
    self.rootKey = rootKey
    self.initialSamplePosition = initialSamplePosition
    self.tapeFileDescriptor = tapeFileDescriptor
    self.indexFileDescriptor = indexFileDescriptor
    self.tapeRecords = tapeRecords
    self.indexRecords = indexRecords
    self.repairedTapeTrailingByteCount = repairedTapeTrailingByteCount
    self.repairedIndexTrailingByteCount = repairedIndexTrailingByteCount
    self.hooks = hooks
    needsTapeDirectorySync = tapeRecords.isEmpty
    needsIndexDirectorySync = indexRecords.isEmpty
    self.tapeSealer = tapeSealer
    self.indexSealer = indexSealer
    adoptedRecordCount = UInt64(tapeRecords.count - indexRecords.count)
  }

  deinit {
    closeDescriptors()
  }

  public static func inspect(
    tapeURL: URL,
    indexURL: URL,
    rootKey: Data,
    context: ArchiveContext,
    initialSamplePosition: UInt64 = 0
  ) throws -> ArchiveLaneScanResult {
    try inspect(
      tapeURL: tapeURL,
      indexURL: indexURL,
      rootKey: rootKey,
      context: context,
      initialSamplePosition: initialSamplePosition,
      hooks: ArchiveLanePersistenceHooks()
    )
  }

  static func inspect(
    tapeURL: URL,
    indexURL: URL,
    rootKey: Data,
    context: ArchiveContext,
    initialSamplePosition: UInt64 = 0,
    hooks: ArchiveLanePersistenceHooks
  ) throws -> ArchiveLaneScanResult {
    let contextHash = try validateInputs(
      tapeURL: tapeURL, indexURL: indexURL, rootKey: rootKey, context: context)
    let descriptors = try openPair(tapeURL: tapeURL, indexURL: indexURL, readOnly: true)
    defer {
      _ = Darwin.close(descriptors.index)
      _ = Darwin.close(descriptors.tape)
    }
    let result = try scanPair(
      descriptors: descriptors,
      rootKey: rootKey,
      context: context,
      contextHash: contextHash,
      initialSamplePosition: initialSamplePosition,
      hooks: hooks
    )
    try crossValidate(result, context: context)
    return result
  }

  public static func openAuthenticatedSnapshot(
    tapeURL: URL,
    indexURL: URL,
    rootKey: Data,
    context: ArchiveContext,
    initialSamplePosition: UInt64 = 0
  ) throws -> AuthenticatedSnapshot {
    let contextHash = try validateInputs(
      tapeURL: tapeURL, indexURL: indexURL, rootKey: rootKey, context: context)
    let descriptors = try openPair(tapeURL: tapeURL, indexURL: indexURL, readOnly: true)
    do {
      let hooks = ArchiveLanePersistenceHooks()
      let scan = ArchiveLaneScanResult(
        tape: try scanTapeMetadata(
          descriptors.tape,
          context: context,
          contextHash: contextHash,
          initialSamplePosition: initialSamplePosition,
          hooks: hooks
        ),
        index: try scanIndex(
          descriptors.index,
          rootKey: rootKey,
          context: context,
          contextHash: contextHash,
          initialSamplePosition: initialSamplePosition,
          hooks: hooks
        )
      )
      try crossValidate(scan, context: context)
      return AuthenticatedSnapshot(
        descriptors: descriptors,
        rootKey: rootKey,
        context: context,
        initialSamplePosition: initialSamplePosition,
        contextHash: contextHash,
        scanResult: scan
      )
    } catch {
      _ = Darwin.close(descriptors.index)
      _ = Darwin.close(descriptors.tape)
      throw error
    }
  }

  public static func readAuthenticatedPCMRange(
    tapeURL: URL,
    indexURL: URL,
    rootKey: Data,
    context: ArchiveContext,
    sampleStart: UInt64,
    sampleEnd: UInt64,
    initialSamplePosition: UInt64 = 0
  ) throws -> AuthenticatedArchivePCMRange {
    let snapshot = try openAuthenticatedSnapshot(
      tapeURL: tapeURL,
      indexURL: indexURL,
      rootKey: rootKey,
      context: context,
      initialSamplePosition: initialSamplePosition
    )
    defer { snapshot.close() }
    return try snapshot.readPCMRange(sampleStart: sampleStart, sampleEnd: sampleEnd)
  }

  private static func readAuthenticatedPCMRange(
    descriptors: LaneDescriptors,
    scan: ArchiveLaneScanResult,
    rootKey: Data,
    contextHash: Data,
    sampleStart: UInt64,
    sampleEnd: UInt64
  ) throws -> AuthenticatedArchivePCMRange {
    var pcm = Data()
    let result = try streamAuthenticatedPCMRange(
      descriptors: descriptors,
      scan: scan,
      rootKey: rootKey,
      contextHash: contextHash,
      sampleStart: sampleStart,
      sampleEnd: sampleEnd
    ) { pcm.append($0) }
    return AuthenticatedArchivePCMRange(
      sampleStart: result.sampleStart,
      sampleEnd: result.sampleEnd,
      pcm: pcm,
      indexRecords: result.indexRecords
    )
  }

  private static func streamAuthenticatedPCMRange(
    descriptors: LaneDescriptors,
    scan: ArchiveLaneScanResult,
    rootKey: Data,
    contextHash: Data,
    sampleStart: UInt64,
    sampleEnd: UInt64,
    consume: (Data) throws -> Void
  ) throws -> AuthenticatedArchivePCMStreamResult {
    guard sampleEnd > sampleStart else {
      throw ArchiveLanePersistenceError.invalidReadRange(start: sampleStart, end: sampleEnd)
    }
    guard sampleStart >= scan.initialSamplePosition else {
      throw ArchiveLanePersistenceError.invalidReadRange(start: sampleStart, end: sampleEnd)
    }
    let authenticatedEnd =
      scan.index.records.last?.payload.sampleEnd ?? scan.initialSamplePosition
    guard sampleEnd <= authenticatedEnd else {
      throw ArchiveLanePersistenceError.readRangeBeyondAuthenticatedEnd(
        requested: sampleEnd, authenticated: authenticatedEnd)
    }
    let requestedSamples = sampleEnd - sampleStart
    guard requestedSamples <= UInt64(Int.max / 2) else {
      throw ArchiveLanePersistenceError.arithmeticOverflow(field: "read_range_byte_count")
    }

    let expectedByteCount = Int(requestedSamples) * 2
    var streamedByteCount = 0
    var selectedIndexRecords: [ArchiveIndexRecordMetadata] = []
    let hooks = ArchiveLanePersistenceHooks()
    var lower = 0
    var upper = scan.index.records.count
    while lower < upper {
      let middle = lower + (upper - lower) / 2
      if scan.index.records[middle].payload.sampleEnd > sampleStart {
        upper = middle
      } else {
        lower = middle + 1
      }
    }
    var position = lower
    while position < scan.index.records.count {
      let indexRecord = scan.index.records[position]
      let payload = indexRecord.payload
      if payload.sampleStart >= sampleEnd { break }
      let overlapStart = max(sampleStart, payload.sampleStart)
      let overlapEnd = min(sampleEnd, payload.sampleEnd)
      guard overlapEnd > overlapStart else {
        position += 1
        continue
      }

      let tapeRecord = scan.tape.records[position]
      let encodedCount = tapeRecord.encryptedEndOffset - tapeRecord.encryptedStartOffset
      guard encodedCount <= UInt64(Int.max) else {
        throw ArchiveLanePersistenceError.arithmeticOverflow(field: "read_record_byte_count")
      }
      let encoded = try readExactly(
        descriptors.tape,
        file: .tape,
        offset: tapeRecord.encryptedStartOffset,
        count: Int(encodedCount),
        hooks: hooks
      )
      let authenticated = try ArchiveRecordCrypto.open(
        encoded,
        rootKey: rootKey,
        expectedPurpose: .tape,
        expectedContextHash: contextHash
      )
      let localStart = Int(overlapStart - payload.sampleStart) * 2
      let localEnd = Int(overlapEnd - payload.sampleStart) * 2
      let chunk = authenticated.plaintext.subdata(in: localStart..<localEnd)
      try consume(chunk)
      streamedByteCount += chunk.count
      selectedIndexRecords.append(indexRecord)
      position += 1
    }
    guard streamedByteCount == expectedByteCount else {
      throw ArchiveLanePersistenceError.unexpectedEndOfFile(
        file: .tape, offset: UInt64(streamedByteCount))
    }
    return AuthenticatedArchivePCMStreamResult(
      sampleStart: sampleStart,
      sampleEnd: sampleEnd,
      byteCount: UInt64(streamedByteCount),
      indexRecords: selectedIndexRecords
    )
  }

  public static func openRecoveringForAppend(
    tapeURL: URL,
    indexURL: URL,
    rootKey: Data,
    context: ArchiveContext,
    initialSamplePosition: UInt64 = 0
  ) throws -> ArchiveLaneStore {
    try openRecoveringForAppend(
      tapeURL: tapeURL,
      indexURL: indexURL,
      rootKey: rootKey,
      context: context,
      initialSamplePosition: initialSamplePosition,
      hooks: ArchiveLanePersistenceHooks(),
      tapeNonceProvider: { try ArchivePurposeSealer.secureRandomNonceForPersistence() },
      indexNonceProvider: { try ArchivePurposeSealer.secureRandomNonceForPersistence() }
    )
  }

  static func openRecoveringForAppend(
    tapeURL: URL,
    indexURL: URL,
    rootKey: Data,
    context: ArchiveContext,
    initialSamplePosition: UInt64 = 0,
    hooks: ArchiveLanePersistenceHooks,
    tapeNonceProvider: @escaping @Sendable () throws -> Data,
    indexNonceProvider: @escaping @Sendable () throws -> Data
  ) throws -> ArchiveLaneStore {
    let contextHash = try validateInputs(
      tapeURL: tapeURL, indexURL: indexURL, rootKey: rootKey, context: context)
    let descriptors = try openPair(tapeURL: tapeURL, indexURL: indexURL, readOnly: false)
    return try openRecoveringForAppend(
      tapeURL: tapeURL,
      indexURL: indexURL,
      rootKey: rootKey,
      context: context,
      contextHash: contextHash,
      initialSamplePosition: initialSamplePosition,
      descriptors: descriptors,
      callerRetainsDescriptorsOnFailure: false,
      hooks: hooks,
      tapeNonceProvider: tapeNonceProvider,
      indexNonceProvider: indexNonceProvider)
  }

  static func openReservedForAppend(
    tapeURL: URL,
    indexURL: URL,
    tapeFileDescriptor: Int32,
    indexFileDescriptor: Int32,
    rootKey: Data,
    context: ArchiveContext,
    initialSamplePosition: UInt64 = 0
  ) throws -> ArchiveLaneStore {
    let descriptors = LaneDescriptors(
      tapeFile: OpenedLaneFile(
        file: .tape, url: tapeURL, fileDescriptor: tapeFileDescriptor, createdIdentity: nil),
      indexFile: OpenedLaneFile(
        file: .index, url: indexURL, fileDescriptor: indexFileDescriptor, createdIdentity: nil))
    let contextHash = try validateInputs(
      tapeURL: tapeURL, indexURL: indexURL, rootKey: rootKey, context: context)
    return try openRecoveringForAppend(
      tapeURL: tapeURL,
      indexURL: indexURL,
      rootKey: rootKey,
      context: context,
      contextHash: contextHash,
      initialSamplePosition: initialSamplePosition,
      descriptors: descriptors,
      callerRetainsDescriptorsOnFailure: true,
      hooks: ArchiveLanePersistenceHooks(),
      tapeNonceProvider: { try ArchivePurposeSealer.secureRandomNonceForPersistence() },
      indexNonceProvider: { try ArchivePurposeSealer.secureRandomNonceForPersistence() })
  }

  private static func openRecoveringForAppend(
    tapeURL: URL,
    indexURL: URL,
    rootKey: Data,
    context: ArchiveContext,
    contextHash: Data,
    initialSamplePosition: UInt64,
    descriptors: LaneDescriptors,
    callerRetainsDescriptorsOnFailure: Bool,
    hooks: ArchiveLanePersistenceHooks,
    tapeNonceProvider: @escaping @Sendable () throws -> Data,
    indexNonceProvider: @escaping @Sendable () throws -> Data
  ) throws -> ArchiveLaneStore {
    var transferred = false
    var openedStore: ArchiveLaneStore?
    do {
      var scan = try scanPair(
        descriptors: descriptors,
        rootKey: rootKey,
        context: context,
        contextHash: contextHash,
        initialSamplePosition: initialSamplePosition,
        hooks: hooks
      )
      try crossValidate(scan, context: context)
      try hooks.initializeStore()
      let tapeSealer = try ArchivePurposeSealer(
        purpose: .tape,
        rootKey: rootKey,
        streamUUID: context.streamUUID,
        existingRecordCount: UInt64(scan.tape.records.count),
        nonceProvider: tapeNonceProvider
      )
      let indexSealer = try ArchivePurposeSealer(
        purpose: .index,
        rootKey: rootKey,
        streamUUID: context.streamUUID,
        existingRecordCount: UInt64(scan.index.records.count),
        nonceProvider: indexNonceProvider
      )

      let tapeRepair = scan.tape.incompleteTrailingByteCount
      let indexRepair = scan.index.incompleteTrailingByteCount
      if tapeRepair > 0 {
        hooks.event(.tapeRepair)
        try truncate(
          descriptors.tape, file: .tape, offset: scan.tape.completeByteCount, hooks: hooks)
        try sync(
          descriptors.tape, file: .tape, offset: scan.tape.completeByteCount, hooks: hooks)
        scan = ArchiveLaneScanResult(
          tape: ArchiveTapeScanResult(
            records: scan.tape.records,
            completeByteCount: scan.tape.completeByteCount,
            incompleteTrailingByteCount: 0,
            initialLogicalUnit: initialSamplePosition),
          index: scan.index
        )
      }
      if indexRepair > 0 {
        hooks.event(.indexRepair)
        try truncate(
          descriptors.index, file: .index, offset: scan.index.completeByteCount, hooks: hooks)
        try sync(
          descriptors.index, file: .index, offset: scan.index.completeByteCount, hooks: hooks)
        scan = ArchiveLaneScanResult(
          tape: scan.tape,
          index: ArchiveIndexScanResult(
            records: scan.index.records,
            completeByteCount: scan.index.completeByteCount,
            incompleteTrailingByteCount: 0,
            initialSamplePosition: initialSamplePosition)
        )
      }

      if scan.tape.completeByteCount > 0 {
        try sync(
          descriptors.tape, file: .tape, offset: scan.tape.completeByteCount, hooks: hooks)
        try synchronizeDirectory(for: tapeURL, file: .tape, hooks: hooks)
      }
      if scan.index.completeByteCount > 0 {
        try sync(
          descriptors.index, file: .index, offset: scan.index.completeByteCount, hooks: hooks)
        try synchronizeDirectory(for: indexURL, file: .index, hooks: hooks)
      }

      let store = ArchiveLaneStore(
        tapeURL: tapeURL,
        indexURL: indexURL,
        context: context,
        contextHash: contextHash,
        rootKey: rootKey,
        initialSamplePosition: initialSamplePosition,
        tapeSealer: tapeSealer,
        indexSealer: indexSealer,
        tapeFileDescriptor: descriptors.tape,
        indexFileDescriptor: descriptors.index,
        tapeRecords: scan.tape.records,
        indexRecords: scan.index.records,
        repairedTapeTrailingByteCount: tapeRepair,
        repairedIndexTrailingByteCount: indexRepair,
        hooks: hooks
      )
      openedStore = store
      transferred = true
      do {
        try store.adoptStartupTapeRecords()
      } catch {
        store.poisoned = true
        throw error
      }
      return store
    } catch {
      if callerRetainsDescriptorsOnFailure {
        openedStore?.releaseDescriptorsWithoutClosing()
      } else if !transferred {
        try descriptors.releaseCloseAndCleanupCreatedPaths()
      }
      throw error
    }
  }

  public var scanResult: ArchiveLaneScanResult {
    lock.withLock {
      ArchiveLaneScanResult(
        tape: ArchiveTapeScanResult(
          records: tapeRecords,
          completeByteCount: tapeRecords.last?.encryptedEndOffset ?? 0,
          incompleteTrailingByteCount: 0,
          initialLogicalUnit: initialSamplePosition),
        index: ArchiveIndexScanResult(
          records: indexRecords,
          completeByteCount: indexRecords.last?.encryptedEndOffset ?? 0,
          incompleteTrailingByteCount: 0,
          initialSamplePosition: initialSamplePosition)
      )
    }
  }

  var sealerRecordCountsForTesting: (tape: UInt64, index: UInt64) {
    lock.withLock {
      (tapeSealer.sealedRecordCount, indexSealer.sealedRecordCount)
    }
  }

  public func appendPCM(
    _ plaintext: Data,
    observation: ArchiveIndexObservation
  ) throws -> ArchiveLaneAppendResult {
    try lock.withLock {
      guard let tapeFileDescriptor, let indexFileDescriptor else {
        throw ArchiveLanePersistenceError.closed
      }
      guard !poisoned else {
        throw ArchiveLanePersistenceError.requiresAuthenticatedReopen
      }
      guard !plaintext.isEmpty, plaintext.count.isMultiple(of: 2), plaintext.count <= 32_000 else {
        throw ArchiveLanePersistenceError.invalidPCMByteCount(plaintext.count)
      }
      guard observation.discontinuity != .crashRecoveredUnindexed else {
        throw ArchiveLanePersistenceError.recoveryObservationNotAllowed
      }
      guard tapeRecords.count == indexRecords.count else {
        poisoned = true
        throw ArchiveLanePersistenceError.requiresAuthenticatedReopen
      }

      do {
        let previousTape = tapeRecords.last
        let sequence = try Self.increment(
          previousTape?.header.recordSequence ?? 0, field: "tape_sequence")
        let sampleStart = try Self.logicalEnd(
          of: previousTape?.header, initialSamplePosition: initialSamplePosition)
        let sampleCount = UInt32(plaintext.count / 2)
        let tapeRequest = ArchiveRecordSealRequest(
          recordSequence: sequence,
          firstLogicalUnit: sampleStart,
          logicalUnitCount: sampleCount,
          previousCommittedTag: previousTape?.authenticationTag ?? Self.zeroTag,
          contextHash: contextHash
        )
        hooks.event(.tapeSeal)
        let tapeEnvelope = try tapeSealer.seal(plaintext, request: tapeRequest)
        let encodedTape = try ArchiveEnvelopeCodec.encodeUnauthenticated(tapeEnvelope)
        let tapeStart = previousTape?.encryptedEndOffset ?? 0
        let tapeEnd = try Self.add(
          tapeStart, UInt64(encodedTape.count), field: "tape_encrypted_end")
        let sampleEnd = try Self.add(
          sampleStart, UInt64(sampleCount), field: "sample_end")
        let payload = try ArchiveIndexPayload(
          tapeSequence: sequence,
          tapeTag: tapeEnvelope.authenticationTag,
          encryptedEnd: tapeEnd,
          sampleStart: sampleStart,
          sampleEnd: sampleEnd,
          monoNS: observation.monoNS,
          wallNS: observation.wallNS,
          deviceUID: context.stableDeviceUID,
          rmsQ15: observation.rmsQ15,
          nativeFrames: observation.nativeFrames,
          inputRateNumerator: observation.inputRateNumerator,
          inputRateDenominator: observation.inputRateDenominator,
          discontinuity: observation.discontinuity,
          reason: observation.reason,
          gapNS: observation.gapNS,
          previousDurableSample: observation.previousDurableSample,
          survivingTailBytes: observation.survivingTailBytes
        )
        let indexPlaintext = try ArchiveIndexPayloadCodec.encode(payload)
        hooks.event(.tapeWrite)
        try Self.writeAll(
          tapeFileDescriptor, file: .tape, data: encodedTape, startOffset: tapeStart, hooks: hooks)
        hooks.event(.tapeFullSync)
        try Self.sync(tapeFileDescriptor, file: .tape, offset: tapeEnd, hooks: hooks)
        if needsTapeDirectorySync {
          hooks.event(.tapeDirectorySync)
          try Self.synchronizeDirectory(for: tapeURL, file: .tape, hooks: hooks)
          needsTapeDirectorySync = false
        }
        let tapeMetadata = ArchiveTapeRecordMetadata(
          header: tapeEnvelope.header,
          authenticationTag: tapeEnvelope.authenticationTag,
          encryptedStartOffset: tapeStart,
          encryptedEndOffset: tapeEnd
        )
        let indexMetadata = try appendIndex(
          payload: payload,
          plaintext: indexPlaintext,
          indexFileDescriptor: indexFileDescriptor
        )
        tapeRecords.append(tapeMetadata)
        return ArchiveLaneAppendResult(tape: tapeMetadata, index: indexMetadata)
      } catch {
        poisoned = true
        throw error
      }
    }
  }

  public func close() {
    lock.withLock { closeDescriptors() }
  }

  public func authenticatedSnapshot() throws -> AuthenticatedSnapshot {
    try lock.withLock {
      guard let tapeFileDescriptor, let indexFileDescriptor else {
        throw ArchiveLanePersistenceError.closed
      }
      guard !poisoned, tapeRecords.count == indexRecords.count else {
        throw ArchiveLanePersistenceError.requiresAuthenticatedReopen
      }
      let tapeCopy = try Self.duplicate(tapeFileDescriptor, file: .tape)
      do {
        let indexCopy = try Self.duplicate(indexFileDescriptor, file: .index)
        return AuthenticatedSnapshot(
          descriptors: LaneDescriptors(
            tapeFile: OpenedLaneFile(
              file: .tape, url: tapeURL, fileDescriptor: tapeCopy, createdIdentity: nil),
            indexFile: OpenedLaneFile(
              file: .index, url: indexURL, fileDescriptor: indexCopy, createdIdentity: nil)
          ),
          rootKey: rootKey,
          context: context,
          initialSamplePosition: initialSamplePosition,
          contextHash: contextHash,
          scanResult: scanResultUnlocked()
        )
      } catch {
        _ = Darwin.close(tapeCopy)
        throw error
      }
    }
  }

  private func scanResultUnlocked() -> ArchiveLaneScanResult {
    ArchiveLaneScanResult(
      tape: ArchiveTapeScanResult(
        records: tapeRecords,
        completeByteCount: tapeRecords.last?.encryptedEndOffset ?? 0,
        incompleteTrailingByteCount: 0,
        initialLogicalUnit: initialSamplePosition),
      index: ArchiveIndexScanResult(
        records: indexRecords,
        completeByteCount: indexRecords.last?.encryptedEndOffset ?? 0,
        incompleteTrailingByteCount: 0,
        initialSamplePosition: initialSamplePosition)
    )
  }

  private func adoptStartupTapeRecords() throws {
    guard let indexFileDescriptor else { throw ArchiveLanePersistenceError.closed }
    let originalIndexCount = indexRecords.count
    guard originalIndexCount < tapeRecords.count else { return }
    let recoveryOrigin = try Self.recoveryOrigin(
      tapeRecords: tapeRecords,
      indexRecords: indexRecords,
      initialSamplePosition: initialSamplePosition)

    for tape in tapeRecords.dropFirst(originalIndexCount) {
      hooks.event(.adoption(tape.header.recordSequence))
      let sampleEnd = try Self.logicalEnd(of: tape.header)
      let tailBytes = tape.encryptedEndOffset.subtractingReportingOverflow(
        recoveryOrigin.tapeOffset)
      guard !tailBytes.overflow, tailBytes.partialValue > 0 else {
        throw ArchiveLanePersistenceError.arithmeticOverflow(field: "surviving_tail_bytes")
      }
      let payload = try ArchiveIndexPayload(
        tapeSequence: tape.header.recordSequence,
        tapeTag: tape.authenticationTag,
        encryptedEnd: tape.encryptedEndOffset,
        sampleStart: tape.header.firstLogicalUnit,
        sampleEnd: sampleEnd,
        monoNS: nil,
        wallNS: nil,
        deviceUID: context.stableDeviceUID,
        rmsQ15: nil,
        nativeFrames: nil,
        inputRateNumerator: nil,
        inputRateDenominator: nil,
        discontinuity: .crashRecoveredUnindexed,
        reason: ArchiveIndexDiscontinuity.crashRecoveredUnindexed.rawValue,
        gapNS: nil,
        previousDurableSample: recoveryOrigin.sample,
        survivingTailBytes: tailBytes.partialValue
      )
      let plaintext = try ArchiveIndexPayloadCodec.encode(payload)
      _ = try appendIndex(
        payload: payload, plaintext: plaintext, indexFileDescriptor: indexFileDescriptor)
    }
  }

  private func appendIndex(
    payload: ArchiveIndexPayload,
    plaintext: Data,
    indexFileDescriptor: Int32
  ) throws -> ArchiveIndexRecordMetadata {
    let logicalCount = payload.sampleEnd.subtractingReportingOverflow(payload.sampleStart)
    guard !logicalCount.overflow, logicalCount.partialValue <= UInt64(UInt32.max) else {
      throw ArchiveLanePersistenceError.arithmeticOverflow(field: "index_logical_unit_count")
    }
    let previous = indexRecords.last
    let expectedSequence = try Self.increment(
      previous?.header.recordSequence ?? 0, field: "index_sequence")
    guard expectedSequence == payload.tapeSequence else {
      throw ArchiveLanePersistenceError.indexTapeSequenceMismatch(
        indexSequence: expectedSequence, tapeSequence: payload.tapeSequence)
    }
    let request = ArchiveRecordSealRequest(
      recordSequence: payload.tapeSequence,
      firstLogicalUnit: payload.sampleStart,
      logicalUnitCount: UInt32(logicalCount.partialValue),
      previousCommittedTag: previous?.authenticationTag ?? Self.zeroTag,
      contextHash: contextHash
    )
    hooks.event(.indexSeal)
    let envelope = try indexSealer.seal(plaintext, request: request)
    let encoded = try ArchiveEnvelopeCodec.encodeUnauthenticated(envelope)
    let start = previous?.encryptedEndOffset ?? 0
    let end = try Self.add(start, UInt64(encoded.count), field: "index_encrypted_end")
    hooks.event(.indexWrite)
    try Self.writeAll(
      indexFileDescriptor, file: .index, data: encoded, startOffset: start, hooks: hooks)
    hooks.event(.indexFullSync)
    try Self.sync(indexFileDescriptor, file: .index, offset: end, hooks: hooks)
    if needsIndexDirectorySync {
      hooks.event(.indexDirectorySync)
      try Self.synchronizeDirectory(for: indexURL, file: .index, hooks: hooks)
      needsIndexDirectorySync = false
    }
    let metadata = ArchiveIndexRecordMetadata(
      header: envelope.header,
      payload: payload,
      authenticationTag: envelope.authenticationTag,
      encryptedStartOffset: start,
      encryptedEndOffset: end
    )
    indexRecords.append(metadata)
    return metadata
  }

  private func closeDescriptors() {
    if let indexFileDescriptor {
      _ = Darwin.close(indexFileDescriptor)
      self.indexFileDescriptor = nil
    }
    if let tapeFileDescriptor {
      _ = Darwin.close(tapeFileDescriptor)
      self.tapeFileDescriptor = nil
    }
  }

  private func releaseDescriptorsWithoutClosing() {
    indexFileDescriptor = nil
    tapeFileDescriptor = nil
  }

  private static let zeroTag = Data(
    repeating: 0, count: ArchiveEnvelopeCodec.authenticationTagByteCount)

  private static func validateInputs(
    tapeURL: URL,
    indexURL: URL,
    rootKey: Data,
    context: ArchiveContext
  ) throws -> Data {
    guard tapeURL.standardizedFileURL.path != indexURL.standardizedFileURL.path else {
      throw ArchiveLanePersistenceError.sameFile
    }
    guard rootKey.count == 32 else {
      throw ArchiveCryptoError.invalidRootKeyLength(rootKey.count)
    }
    let deviceUIDBytes = Data(context.stableDeviceUID.utf8)
    guard !deviceUIDBytes.isEmpty, deviceUIDBytes.count <= 256 else {
      throw ArchiveIndexPayloadError.invalidDeviceUID
    }
    return try context.sha256()
  }

  private static func openPair(tapeURL: URL, indexURL: URL, readOnly: Bool) throws
    -> LaneDescriptors
  {
    let tape = try openLaneFileForPair(file: .tape, url: tapeURL, readOnly: readOnly)
    let index: OpenedLaneFile
    do {
      index = try openLaneFileForPair(file: .index, url: indexURL, readOnly: readOnly)
    } catch {
      try cleanupOpenedLaneFiles([tape])
      throw error
    }
    do {
      try rejectSameFile(tape.fileDescriptor, index.fileDescriptor)
    } catch {
      try cleanupOpenedLaneFiles([index, tape])
      throw error
    }
    return LaneDescriptors(tapeFile: tape, indexFile: index)
  }

  private static func rejectSameFile(_ tape: Int32, _ index: Int32) throws {
    var tapeStat = stat()
    var indexStat = stat()
    guard retryingStat(tape, &tapeStat) == 0 else {
      throw ArchiveLanePersistenceError.statFailed(file: .tape, errno: errno)
    }
    guard retryingStat(index, &indexStat) == 0 else {
      throw ArchiveLanePersistenceError.statFailed(file: .index, errno: errno)
    }
    guard tapeStat.st_dev != indexStat.st_dev || tapeStat.st_ino != indexStat.st_ino else {
      throw ArchiveLanePersistenceError.sameFile
    }
  }

  private static func scanPair(
    descriptors: LaneDescriptors,
    rootKey: Data,
    context: ArchiveContext,
    contextHash: Data,
    initialSamplePosition: UInt64,
    hooks: ArchiveLanePersistenceHooks
  ) throws -> ArchiveLaneScanResult {
    ArchiveLaneScanResult(
      tape: try scanTape(
        descriptors.tape,
        rootKey: rootKey,
        context: context,
        contextHash: contextHash,
        initialSamplePosition: initialSamplePosition,
        hooks: hooks),
      index: try scanIndex(
        descriptors.index,
        rootKey: rootKey,
        context: context,
        contextHash: contextHash,
        initialSamplePosition: initialSamplePosition,
        hooks: hooks)
    )
  }

  private static func scanTape(
    _ fileDescriptor: Int32,
    rootKey: Data,
    context: ArchiveContext,
    contextHash: Data,
    initialSamplePosition: UInt64,
    hooks: ArchiveLanePersistenceHooks
  ) throws -> ArchiveTapeScanResult {
    let fileSize = try size(of: fileDescriptor, file: .tape)
    var offset: UInt64 = 0
    var records: [ArchiveTapeRecordMetadata] = []
    var expectedSequence: UInt64 = 1
    var expectedLogicalUnit = initialSamplePosition
    var expectedPredecessor = zeroTag
    while offset < fileSize {
      try enforceCap(records.count + 1, file: .tape)
      let remaining = fileSize - offset
      guard remaining >= UInt64(ArchiveEnvelopeCodec.headerByteCount) else {
        return ArchiveTapeScanResult(
          records: records, completeByteCount: offset,
          incompleteTrailingByteCount: remaining,
          initialLogicalUnit: initialSamplePosition)
      }
      let headerData = try readExactly(
        fileDescriptor, file: .tape, offset: offset,
        count: ArchiveEnvelopeCodec.headerByteCount, hooks: hooks)
      let header = try ArchiveEnvelopeCodec.decodeHeaderPrefix(
        headerData, expectedPurpose: .tape, expectedContextHash: contextHash)
      let recordByteCount =
        UInt64(ArchiveEnvelopeCodec.headerByteCount) + UInt64(header.plaintextByteCount)
        + UInt64(ArchiveEnvelopeCodec.authenticationTagByteCount)
      try validateContinuation(
        header: header, file: .tape, streamUUID: context.streamUUID,
        expectedSequence: expectedSequence, expectedLogicalUnit: expectedLogicalUnit,
        expectedPredecessor: expectedPredecessor, isFirstRecord: records.isEmpty)
      guard remaining >= recordByteCount else {
        return ArchiveTapeScanResult(
          records: records, completeByteCount: offset,
          incompleteTrailingByteCount: remaining,
          initialLogicalUnit: initialSamplePosition)
      }
      let encoded = try readExactly(
        fileDescriptor, file: .tape, offset: offset, count: Int(recordByteCount), hooks: hooks)
      let authenticated = try ArchiveRecordCrypto.open(
        encoded, rootKey: rootKey, expectedPurpose: .tape, expectedContextHash: contextHash)
      let tag = Data(encoded.suffix(ArchiveEnvelopeCodec.authenticationTagByteCount))
      let end = try add(offset, recordByteCount, field: "tape_scan_end")
      records.append(
        ArchiveTapeRecordMetadata(
          header: authenticated.header, authenticationTag: tag,
          encryptedStartOffset: offset, encryptedEndOffset: end))
      expectedPredecessor = tag
      expectedLogicalUnit = try logicalEnd(of: authenticated.header)
      expectedSequence = try increment(expectedSequence, field: "tape_expected_sequence")
      offset = end
    }
    return ArchiveTapeScanResult(
      records: records, completeByteCount: offset, incompleteTrailingByteCount: 0,
      initialLogicalUnit: initialSamplePosition)
  }

  private static func scanTapeMetadata(
    _ fileDescriptor: Int32,
    context: ArchiveContext,
    contextHash: Data,
    initialSamplePosition: UInt64,
    hooks: ArchiveLanePersistenceHooks
  ) throws -> ArchiveTapeScanResult {
    let fileSize = try size(of: fileDescriptor, file: .tape)
    var offset: UInt64 = 0
    var records: [ArchiveTapeRecordMetadata] = []
    var expectedSequence: UInt64 = 1
    var expectedLogicalUnit = initialSamplePosition
    var expectedPredecessor = zeroTag
    while offset < fileSize {
      try enforceCap(records.count + 1, file: .tape)
      let remaining = fileSize - offset
      guard remaining >= UInt64(ArchiveEnvelopeCodec.headerByteCount) else {
        return ArchiveTapeScanResult(
          records: records, completeByteCount: offset,
          incompleteTrailingByteCount: remaining,
          initialLogicalUnit: initialSamplePosition)
      }
      let headerData = try readExactly(
        fileDescriptor, file: .tape, offset: offset,
        count: ArchiveEnvelopeCodec.headerByteCount, hooks: hooks)
      let header = try ArchiveEnvelopeCodec.decodeHeaderPrefix(
        headerData, expectedPurpose: .tape, expectedContextHash: contextHash)
      let recordByteCount =
        UInt64(ArchiveEnvelopeCodec.headerByteCount) + UInt64(header.plaintextByteCount)
        + UInt64(ArchiveEnvelopeCodec.authenticationTagByteCount)
      try validateContinuation(
        header: header, file: .tape, streamUUID: context.streamUUID,
        expectedSequence: expectedSequence, expectedLogicalUnit: expectedLogicalUnit,
        expectedPredecessor: expectedPredecessor, isFirstRecord: records.isEmpty)
      guard remaining >= recordByteCount else {
        return ArchiveTapeScanResult(
          records: records, completeByteCount: offset,
          incompleteTrailingByteCount: remaining,
          initialLogicalUnit: initialSamplePosition)
      }
      let tagOffset = try add(
        offset,
        UInt64(ArchiveEnvelopeCodec.headerByteCount) + UInt64(header.plaintextByteCount),
        field: "tape_tag_offset"
      )
      let tag = try readExactly(
        fileDescriptor,
        file: .tape,
        offset: tagOffset,
        count: ArchiveEnvelopeCodec.authenticationTagByteCount,
        hooks: hooks
      )
      let end = try add(offset, recordByteCount, field: "tape_scan_end")
      records.append(
        ArchiveTapeRecordMetadata(
          header: header,
          authenticationTag: tag,
          encryptedStartOffset: offset,
          encryptedEndOffset: end
        ))
      expectedPredecessor = tag
      expectedLogicalUnit = try logicalEnd(of: header)
      expectedSequence = try increment(expectedSequence, field: "tape_expected_sequence")
      offset = end
    }
    return ArchiveTapeScanResult(
      records: records, completeByteCount: offset, incompleteTrailingByteCount: 0,
      initialLogicalUnit: initialSamplePosition)
  }

  private static func scanIndex(
    _ fileDescriptor: Int32,
    rootKey: Data,
    context: ArchiveContext,
    contextHash: Data,
    initialSamplePosition: UInt64,
    hooks: ArchiveLanePersistenceHooks
  ) throws -> ArchiveIndexScanResult {
    let fileSize = try size(of: fileDescriptor, file: .index)
    var offset: UInt64 = 0
    var records: [ArchiveIndexRecordMetadata] = []
    var expectedSequence: UInt64 = 1
    var expectedLogicalUnit = initialSamplePosition
    var expectedPredecessor = zeroTag
    while offset < fileSize {
      try enforceCap(records.count + 1, file: .index)
      let remaining = fileSize - offset
      guard remaining >= UInt64(ArchiveEnvelopeCodec.headerByteCount) else {
        return ArchiveIndexScanResult(
          records: records, completeByteCount: offset,
          incompleteTrailingByteCount: remaining,
          initialSamplePosition: initialSamplePosition)
      }
      let headerData = try readExactly(
        fileDescriptor, file: .index, offset: offset,
        count: ArchiveEnvelopeCodec.headerByteCount, hooks: hooks)
      let header = try ArchiveEnvelopeCodec.decodeHeaderPrefix(
        headerData, expectedPurpose: .index, expectedContextHash: contextHash)
      let recordByteCount =
        UInt64(ArchiveEnvelopeCodec.headerByteCount) + UInt64(header.plaintextByteCount)
        + UInt64(ArchiveEnvelopeCodec.authenticationTagByteCount)
      try validateContinuation(
        header: header, file: .index, streamUUID: context.streamUUID,
        expectedSequence: expectedSequence, expectedLogicalUnit: expectedLogicalUnit,
        expectedPredecessor: expectedPredecessor, isFirstRecord: records.isEmpty)
      guard remaining >= recordByteCount else {
        return ArchiveIndexScanResult(
          records: records, completeByteCount: offset,
          incompleteTrailingByteCount: remaining,
          initialSamplePosition: initialSamplePosition)
      }
      let encoded = try readExactly(
        fileDescriptor, file: .index, offset: offset, count: Int(recordByteCount), hooks: hooks)
      let authenticated = try ArchiveRecordCrypto.open(
        encoded, rootKey: rootKey, expectedPurpose: .index, expectedContextHash: contextHash)
      let payload = try ArchiveIndexPayloadCodec.decode(authenticated.plaintext)
      guard authenticated.header.recordSequence == payload.tapeSequence else {
        throw ArchiveLanePersistenceError.indexTapeSequenceMismatch(
          indexSequence: authenticated.header.recordSequence,
          tapeSequence: payload.tapeSequence)
      }
      let payloadCount = payload.sampleEnd.subtractingReportingOverflow(payload.sampleStart)
      guard !payloadCount.overflow,
        authenticated.header.firstLogicalUnit == payload.sampleStart,
        UInt64(authenticated.header.logicalUnitCount) == payloadCount.partialValue
      else {
        throw ArchiveLanePersistenceError.indexEnvelopeRangeMismatch(
          sequence: authenticated.header.recordSequence)
      }
      let tag = Data(encoded.suffix(ArchiveEnvelopeCodec.authenticationTagByteCount))
      let end = try add(offset, recordByteCount, field: "index_scan_end")
      records.append(
        ArchiveIndexRecordMetadata(
          header: authenticated.header, payload: payload, authenticationTag: tag,
          encryptedStartOffset: offset, encryptedEndOffset: end))
      expectedPredecessor = tag
      expectedLogicalUnit = payload.sampleEnd
      expectedSequence = try increment(expectedSequence, field: "index_expected_sequence")
      offset = end
    }
    return ArchiveIndexScanResult(
      records: records, completeByteCount: offset, incompleteTrailingByteCount: 0,
      initialSamplePosition: initialSamplePosition)
  }

  private static func crossValidate(_ result: ArchiveLaneScanResult, context: ArchiveContext) throws
  {
    guard result.tape.initialLogicalUnit == result.index.initialSamplePosition else {
      throw ArchiveLanePersistenceError.initialSamplePositionMismatch(
        file: .index,
        expected: result.tape.initialLogicalUnit,
        actual: result.index.initialSamplePosition)
    }
    guard result.index.records.count <= result.tape.records.count else {
      throw ArchiveLanePersistenceError.indexAhead(
        indexCount: UInt64(result.index.records.count),
        tapeCount: UInt64(result.tape.records.count))
    }
    for position in result.index.records.indices {
      let index = result.index.records[position]
      let tape = result.tape.records[position]
      let sequence = index.header.recordSequence
      guard sequence == tape.header.recordSequence,
        index.payload.tapeSequence == tape.header.recordSequence
      else {
        throw ArchiveLanePersistenceError.indexTapeSequenceMismatch(
          indexSequence: index.payload.tapeSequence,
          tapeSequence: tape.header.recordSequence)
      }
      guard index.payload.tapeTag == tape.authenticationTag else {
        throw ArchiveLanePersistenceError.indexTapeTagMismatch(sequence: sequence)
      }
      guard index.payload.encryptedEnd == tape.encryptedEndOffset else {
        throw ArchiveLanePersistenceError.indexEncryptedEndMismatch(
          sequence: sequence, expected: tape.encryptedEndOffset,
          actual: index.payload.encryptedEnd)
      }
      let tapeEnd = try logicalEnd(of: tape.header)
      guard index.payload.sampleStart == tape.header.firstLogicalUnit,
        index.payload.sampleEnd == tapeEnd
      else {
        throw ArchiveLanePersistenceError.indexSampleRangeMismatch(
          sequence: sequence, expectedStart: tape.header.firstLogicalUnit,
          expectedEnd: tapeEnd, actualStart: index.payload.sampleStart,
          actualEnd: index.payload.sampleEnd)
      }
      guard index.payload.deviceUID == context.stableDeviceUID else {
        throw ArchiveLanePersistenceError.indexDeviceUIDMismatch(sequence: sequence)
      }
    }
    _ = try recoveryOrigin(
      tapeRecords: result.tape.records,
      indexRecords: result.index.records,
      initialSamplePosition: result.initialSamplePosition)
  }

  private static func recoveryOrigin(
    tapeRecords: [ArchiveTapeRecordMetadata],
    indexRecords: [ArchiveIndexRecordMetadata],
    initialSamplePosition: UInt64
  ) throws -> (sample: UInt64, tapeOffset: UInt64) {
    var firstRecovery = indexRecords.count
    while firstRecovery > 0,
      indexRecords[firstRecovery - 1].payload.discontinuity == .crashRecoveredUnindexed
    {
      firstRecovery -= 1
    }
    guard firstRecovery < indexRecords.count else {
      return (
        indexRecords.last?.payload.sampleEnd ?? initialSamplePosition,
        indexRecords.isEmpty ? 0 : tapeRecords[indexRecords.count - 1].encryptedEndOffset
      )
    }

    let firstPayload = indexRecords[firstRecovery].payload
    guard let originalDurableSample = firstPayload.previousDurableSample,
      originalDurableSample == firstPayload.sampleStart
    else {
      throw ArchiveLanePersistenceError.recoveryEpochMismatch(
        sequence: firstPayload.tapeSequence)
    }
    let tapeOrigin = tapeRecords[firstRecovery].encryptedStartOffset
    for position in firstRecovery..<indexRecords.count {
      let payload = indexRecords[position].payload
      let tape = tapeRecords[position]
      let expectedTail = tape.encryptedEndOffset.subtractingReportingOverflow(tapeOrigin)
      guard payload.discontinuity == .crashRecoveredUnindexed,
        payload.previousDurableSample == originalDurableSample,
        !expectedTail.overflow,
        payload.survivingTailBytes == expectedTail.partialValue
      else {
        throw ArchiveLanePersistenceError.recoveryEpochMismatch(
          sequence: payload.tapeSequence)
      }
    }
    return (originalDurableSample, tapeOrigin)
  }

  private static func validateContinuation(
    header: ArchiveEnvelopeHeader,
    file: ArchiveLaneFile,
    streamUUID: Data,
    expectedSequence: UInt64,
    expectedLogicalUnit: UInt64,
    expectedPredecessor: Data,
    isFirstRecord: Bool
  ) throws {
    guard header.streamUUID == streamUUID else {
      throw ArchiveLanePersistenceError.streamUUIDMismatch(file: file)
    }
    if isFirstRecord, header.recordSequence != 1 {
      throw ArchiveLanePersistenceError.invalidFirstSequence(
        file: file, actual: header.recordSequence)
    }
    guard header.recordSequence == expectedSequence else {
      throw ArchiveLanePersistenceError.sequenceDiscontinuity(
        file: file, expected: expectedSequence, actual: header.recordSequence)
    }
    if isFirstRecord, header.firstLogicalUnit != expectedLogicalUnit {
      if expectedLogicalUnit == 0 {
        throw ArchiveLanePersistenceError.invalidFirstLogicalUnit(
          file: file, actual: header.firstLogicalUnit)
      }
      throw ArchiveLanePersistenceError.initialSamplePositionMismatch(
        file: file, expected: expectedLogicalUnit, actual: header.firstLogicalUnit)
    }
    guard header.firstLogicalUnit == expectedLogicalUnit else {
      throw ArchiveLanePersistenceError.logicalDiscontinuity(
        file: file, expected: expectedLogicalUnit, actual: header.firstLogicalUnit)
    }
    guard header.previousCommittedTag == expectedPredecessor else {
      throw ArchiveLanePersistenceError.predecessorMismatch(
        file: file, sequence: header.recordSequence)
    }
  }

  private static func size(of fileDescriptor: Int32, file: ArchiveLaneFile) throws -> UInt64 {
    var fileStat = stat()
    guard retryingStat(fileDescriptor, &fileStat) == 0 else {
      throw ArchiveLanePersistenceError.statFailed(file: file, errno: errno)
    }
    guard fileStat.st_mode & S_IFMT == S_IFREG else {
      throw ArchiveLanePersistenceError.notRegularFile(file)
    }
    guard fileStat.st_size >= 0 else {
      throw ArchiveLanePersistenceError.fileTooLarge(file: file, size: fileStat.st_size)
    }
    return UInt64(fileStat.st_size)
  }

  private static func enforceCap(_ count: Int, file: ArchiveLaneFile) throws {
    guard UInt64(count) <= ArchivePurposeSealer.maximumRecordsPerPurposeKey else {
      throw ArchiveLanePersistenceError.recordCountExceedsLimit(
        file: file, count: UInt64(count))
    }
  }

  private static func logicalEnd(
    of header: ArchiveEnvelopeHeader?,
    initialSamplePosition: UInt64 = 0
  ) throws -> UInt64 {
    guard let header else { return initialSamplePosition }
    return try logicalEnd(of: header)
  }

  private static func duplicate(_ fileDescriptor: Int32, file: ArchiveLaneFile) throws -> Int32 {
    var duplicate: Int32
    repeat {
      duplicate = fcntl(fileDescriptor, F_DUPFD_CLOEXEC, 0)
    } while duplicate < 0 && errno == EINTR
    guard duplicate >= 0 else {
      throw ArchiveLanePersistenceError.descriptorDuplicationFailed(file: file, errno: errno)
    }
    return duplicate
  }

  private static func logicalEnd(of header: ArchiveEnvelopeHeader) throws -> UInt64 {
    try add(
      header.firstLogicalUnit, UInt64(header.logicalUnitCount), field: "logical_end")
  }

  private static func increment(_ value: UInt64, field: String) throws -> UInt64 {
    try add(value, 1, field: field)
  }

  private static func add(_ lhs: UInt64, _ rhs: UInt64, field: String) throws -> UInt64 {
    let result = lhs.addingReportingOverflow(rhs)
    guard !result.overflow else {
      throw ArchiveLanePersistenceError.arithmeticOverflow(field: field)
    }
    return result.partialValue
  }

  private static func readExactly(
    _ fileDescriptor: Int32,
    file: ArchiveLaneFile,
    offset: UInt64,
    count: Int,
    hooks: ArchiveLanePersistenceHooks
  ) throws -> Data {
    var data = Data(count: count)
    try data.withUnsafeMutableBytes { bytes in
      var completed = 0
      while completed < count {
        let result = hooks.pread(
          fileDescriptor, bytes.baseAddress!.advanced(by: completed), count - completed,
          off_t(offset + UInt64(completed)))
        let readErrno = errno
        if result < 0 {
          if readErrno == EINTR { continue }
          throw ArchiveLanePersistenceError.readFailed(
            file: file, offset: offset + UInt64(completed), errno: readErrno)
        }
        guard result > 0 else {
          throw ArchiveLanePersistenceError.unexpectedEndOfFile(
            file: file, offset: offset + UInt64(completed))
        }
        completed += result
      }
    }
    return data
  }

  private static func writeAll(
    _ fileDescriptor: Int32,
    file: ArchiveLaneFile,
    data: Data,
    startOffset: UInt64,
    hooks: ArchiveLanePersistenceHooks
  ) throws {
    try data.withUnsafeBytes { bytes in
      var completed = 0
      while completed < bytes.count {
        let result = hooks.write(
          fileDescriptor, bytes.baseAddress!.advanced(by: completed), bytes.count - completed)
        let writeErrno = errno
        if result < 0 {
          if writeErrno == EINTR { continue }
          throw ArchiveLanePersistenceError.writeFailed(
            file: file, offset: startOffset + UInt64(completed), errno: writeErrno)
        }
        guard result > 0 else {
          throw ArchiveLanePersistenceError.writeMadeNoProgress(
            file: file, offset: startOffset + UInt64(completed))
        }
        completed += result
      }
    }
  }

  private static func truncate(
    _ fileDescriptor: Int32,
    file: ArchiveLaneFile,
    offset: UInt64,
    hooks: ArchiveLanePersistenceHooks
  ) throws {
    while hooks.truncate(fileDescriptor, off_t(offset)) != 0 {
      let truncateErrno = errno
      if truncateErrno == EINTR { continue }
      throw ArchiveLanePersistenceError.truncateFailed(
        file: file, offset: offset, errno: truncateErrno)
    }
  }

  private static func sync(
    _ fileDescriptor: Int32,
    file: ArchiveLaneFile,
    offset: UInt64,
    hooks: ArchiveLanePersistenceHooks
  ) throws {
    while hooks.fullSync(fileDescriptor) != 0 {
      let syncErrno = errno
      if syncErrno == EINTR { continue }
      throw ArchiveLanePersistenceError.fullSyncFailed(
        file: file, offset: offset, errno: syncErrno)
    }
  }

  private static func synchronizeDirectory(
    for url: URL,
    file: ArchiveLaneFile,
    hooks: ArchiveLanePersistenceHooks
  ) throws {
    do {
      try hooks.synchronizeDirectory(url.deletingLastPathComponent())
    } catch ArchiveLanePersistenceError.directorySyncFailed(_, _, let syncErrno) {
      throw ArchiveLanePersistenceError.directorySyncFailed(
        file: file, path: url.deletingLastPathComponent().path, errno: syncErrno)
    } catch {
      throw ArchiveLanePersistenceError.directorySyncFailed(
        file: file, path: url.deletingLastPathComponent().path, errno: EIO)
    }
  }
}

private struct LaneDescriptors {
  let tapeFile: OpenedLaneFile
  let indexFile: OpenedLaneFile

  var tape: Int32 { tapeFile.fileDescriptor }
  var index: Int32 { indexFile.fileDescriptor }

  func releaseCloseAndCleanupCreatedPaths() throws {
    try cleanupOpenedLaneFiles([indexFile, tapeFile])
  }
}

private struct OpenedLaneFile {
  let file: ArchiveLaneFile
  let url: URL
  let fileDescriptor: Int32
  let createdIdentity: LaneFileIdentity?
}

private struct LaneFileIdentity: Equatable {
  let device: UInt64
  let inode: UInt64
}

private func openLaneFileForPair(
  file: ArchiveLaneFile,
  url: URL,
  readOnly: Bool
) throws -> OpenedLaneFile {
  let lockFlag = readOnly ? O_SHLOCK : O_EXLOCK
  let baseFlags =
    (readOnly ? O_RDONLY : O_RDWR | O_APPEND)
    | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | lockFlag
  if readOnly {
    let fileDescriptor = openLaneFile(path: url.path, flags: baseFlags, permissions: 0)
    guard fileDescriptor >= 0 else {
      throw laneOpenError(file: file, path: url.path, errno: errno)
    }
    return OpenedLaneFile(
      file: file, url: url, fileDescriptor: fileDescriptor, createdIdentity: nil)
  }

  while true {
    let existing = openLaneFile(path: url.path, flags: baseFlags, permissions: 0)
    if existing >= 0 {
      return OpenedLaneFile(
        file: file, url: url, fileDescriptor: existing, createdIdentity: nil)
    }
    let existingErrno = errno
    guard existingErrno == ENOENT else {
      throw laneOpenError(file: file, path: url.path, errno: existingErrno)
    }

    let created = openLaneFile(
      path: url.path,
      flags: baseFlags | O_CREAT | O_EXCL,
      permissions: S_IRUSR | S_IWUSR)
    if created >= 0 {
      var fileStat = stat()
      guard retryingStat(created, &fileStat) == 0 else {
        let statErrno = errno
        _ = Darwin.close(created)
        throw ArchiveLanePersistenceError.statFailed(file: file, errno: statErrno)
      }
      return OpenedLaneFile(
        file: file,
        url: url,
        fileDescriptor: created,
        createdIdentity: LaneFileIdentity(
          device: UInt64(fileStat.st_dev), inode: UInt64(fileStat.st_ino)))
    }
    let createErrno = errno
    if createErrno == EEXIST { continue }
    throw laneOpenError(file: file, path: url.path, errno: createErrno)
  }
}

private func laneOpenError(
  file: ArchiveLaneFile,
  path: String,
  errno openErrno: Int32
) -> ArchiveLanePersistenceError {
  if openErrno == EWOULDBLOCK || openErrno == EAGAIN {
    return .lockFailed(file: file, errno: openErrno)
  }
  return .openFailed(file: file, path: path, errno: openErrno)
}

private func cleanupOpenedLaneFiles(_ files: [OpenedLaneFile]) throws {
  var cleanupError: (any Error)?
  var directoriesToSync: [(file: ArchiveLaneFile, url: URL)] = []
  for opened in files {
    if let identity = opened.createdIdentity {
      do {
        if try cleanupCreatedPath(opened, identity: identity) {
          directoriesToSync.append((opened.file, opened.url.deletingLastPathComponent()))
        }
      } catch {
        if cleanupError == nil { cleanupError = error }
      }
    }
  }
  var synchronizedDirectories: Set<String> = []
  for directory in directoriesToSync
  where synchronizedDirectories.insert(directory.url.path).inserted {
    do {
      try laneSynchronizeDirectory(directory.url)
    } catch ArchiveLanePersistenceError.directorySyncFailed(_, _, let syncErrno) {
      if cleanupError == nil {
        cleanupError = ArchiveLanePersistenceError.createdPathCleanupFailed(
          file: directory.file, path: directory.url.path, errno: syncErrno)
      }
    } catch {
      if cleanupError == nil {
        cleanupError = ArchiveLanePersistenceError.createdPathCleanupFailed(
          file: directory.file, path: directory.url.path, errno: EIO)
      }
    }
  }
  for opened in files {
    _ = Darwin.close(opened.fileDescriptor)
  }
  if let cleanupError { throw cleanupError }
}

private func cleanupCreatedPath(
  _ opened: OpenedLaneFile,
  identity: LaneFileIdentity
) throws -> Bool {
  var descriptorStat = stat()
  guard retryingStat(opened.fileDescriptor, &descriptorStat) == 0 else {
    throw ArchiveLanePersistenceError.createdPathCleanupFailed(
      file: opened.file, path: opened.url.path, errno: errno)
  }
  let descriptorIdentity = LaneFileIdentity(
    device: UInt64(descriptorStat.st_dev), inode: UInt64(descriptorStat.st_ino))
  guard descriptorIdentity == identity else {
    throw ArchiveLanePersistenceError.createdPathChanged(
      file: opened.file, path: opened.url.path)
  }
  var pathStat = stat()
  var statResult: Int32
  repeat {
    statResult = lstat(opened.url.path, &pathStat)
  } while statResult != 0 && errno == EINTR
  if statResult != 0, errno == ENOENT { return false }
  guard statResult == 0 else {
    throw ArchiveLanePersistenceError.createdPathCleanupFailed(
      file: opened.file, path: opened.url.path, errno: errno)
  }
  let pathIdentity = LaneFileIdentity(
    device: UInt64(pathStat.st_dev), inode: UInt64(pathStat.st_ino))
  guard pathIdentity == identity else {
    throw ArchiveLanePersistenceError.createdPathChanged(
      file: opened.file, path: opened.url.path)
  }
  guard retryingUnlink(opened.url.path) == 0 else {
    throw ArchiveLanePersistenceError.createdPathCleanupFailed(
      file: opened.file, path: opened.url.path, errno: errno)
  }
  return true
}

private func retryingUnlink(_ path: String) -> Int32 {
  var result: Int32
  repeat {
    result = Darwin.unlink(path)
  } while result != 0 && errno == EINTR
  return result
}

private func openLaneFile(path: String, flags: Int32, permissions: mode_t) -> Int32 {
  var fileDescriptor: Int32
  repeat {
    fileDescriptor = Darwin.open(path, flags, permissions)
  } while fileDescriptor < 0 && errno == EINTR
  return fileDescriptor
}

private func retryingStat(_ fileDescriptor: Int32, _ fileStat: inout stat) -> Int32 {
  var result: Int32
  repeat {
    result = fstat(fileDescriptor, &fileStat)
  } while result != 0 && errno == EINTR
  return result
}

private func laneSynchronizeDirectory(_ directory: URL) throws {
  let fileDescriptor = openLaneFile(
    path: directory.path, flags: O_RDONLY | O_CLOEXEC | O_NOFOLLOW, permissions: 0)
  guard fileDescriptor >= 0 else {
    throw ArchiveLanePersistenceError.directorySyncFailed(
      file: .tape, path: directory.path, errno: errno)
  }
  defer { _ = Darwin.close(fileDescriptor) }
  while fsync(fileDescriptor) != 0 {
    let syncErrno = errno
    if syncErrno == EINTR { continue }
    throw ArchiveLanePersistenceError.directorySyncFailed(
      file: .tape, path: directory.path, errno: syncErrno)
  }
}
