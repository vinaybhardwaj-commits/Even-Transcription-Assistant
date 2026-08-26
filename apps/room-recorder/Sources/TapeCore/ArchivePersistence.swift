import Darwin
import Foundation

public struct ArchiveTapeCheckpoint: Equatable, Sendable {
  public let recordSequence: UInt64
  public let authenticationTag: Data
  public let encryptedEndOffset: UInt64

  public init(recordSequence: UInt64, authenticationTag: Data, encryptedEndOffset: UInt64) {
    self.recordSequence = recordSequence
    self.authenticationTag = authenticationTag
    self.encryptedEndOffset = encryptedEndOffset
  }
}

public struct ArchiveTapeRecordMetadata: Equatable, Sendable {
  public let header: ArchiveEnvelopeHeader
  public let authenticationTag: Data
  public let encryptedStartOffset: UInt64
  public let encryptedEndOffset: UInt64

  public var checkpoint: ArchiveTapeCheckpoint {
    ArchiveTapeCheckpoint(
      recordSequence: header.recordSequence,
      authenticationTag: authenticationTag,
      encryptedEndOffset: encryptedEndOffset
    )
  }
}

public struct ArchiveTapeScanResult: Equatable, Sendable {
  public let records: [ArchiveTapeRecordMetadata]
  public let completeByteCount: UInt64
  public let incompleteTrailingByteCount: UInt64
}

public enum ArchiveTapePersistenceError: Error, Equatable, Sendable {
  case openFailed(path: String, errno: Int32)
  case lockFailed(errno: Int32)
  case notRegularFile
  case statFailed(errno: Int32)
  case fileTooLarge(Int64)
  case readFailed(offset: UInt64, errno: Int32)
  case unexpectedEndOfFile(offset: UInt64)
  case streamUUIDMismatch
  case invalidFirstSequence(UInt64)
  case sequenceDiscontinuity(expected: UInt64, actual: UInt64)
  case invalidFirstLogicalUnit(UInt64)
  case logicalDiscontinuity(expected: UInt64, actual: UInt64)
  case predecessorMismatch(sequence: UInt64)
  case recordCountExceedsLimit(UInt64)
  case indexedCheckpointNotFound(UInt64)
  case indexedCheckpointMismatch(UInt64)
  case startupRecordsRequireIndex(Int)
  case invalidPCMByteCount(Int)
  case writeFailed(offset: UInt64, errno: Int32)
  case writeMadeNoProgress(offset: UInt64)
  case fullSyncFailed(offset: UInt64, errno: Int32)
  case truncateFailed(offset: UInt64, errno: Int32)
  case directorySyncFailed(path: String, errno: Int32)
  case requiresAuthenticatedReopen
  case closed
}

struct ArchiveTapePersistenceHooks {
  var pread: (Int32, UnsafeMutableRawPointer, Int, off_t) -> Int = Darwin.pread
  var write: (Int32, UnsafeRawPointer, Int) -> Int = Darwin.write
  var fullSync: (Int32) -> Int32 = { fcntl($0, F_FULLFSYNC) }
  var truncate: (Int32, off_t) -> Int32 = Darwin.ftruncate
  var synchronizeDirectory: (URL) throws -> Void = archiveSynchronizeDirectory
}

public final class ArchiveTapeStore: @unchecked Sendable {
  private let lock = NSLock()
  private let url: URL
  private let contextHash: Data
  private let sealer: ArchivePurposeSealer
  private let hooks: ArchiveTapePersistenceHooks
  private var fileDescriptor: Int32?
  private var records: [ArchiveTapeRecordMetadata]
  private let indexedRecordCountAtOpen: Int
  private let startupUnindexedRecordCount: Int
  private var poisoned = false
  private var needsFirstRecordDirectorySync: Bool

  public let repairedTrailingByteCount: UInt64

  private init(
    url: URL,
    fileDescriptor: Int32,
    contextHash: Data,
    sealer: ArchivePurposeSealer,
    hooks: ArchiveTapePersistenceHooks,
    records: [ArchiveTapeRecordMetadata],
    indexedRecordCountAtOpen: Int,
    repairedTrailingByteCount: UInt64,
    needsFirstRecordDirectorySync: Bool
  ) {
    self.url = url
    self.fileDescriptor = fileDescriptor
    self.contextHash = contextHash
    self.sealer = sealer
    self.hooks = hooks
    self.records = records
    self.indexedRecordCountAtOpen = indexedRecordCountAtOpen
    startupUnindexedRecordCount = records.count - indexedRecordCountAtOpen
    self.repairedTrailingByteCount = repairedTrailingByteCount
    self.needsFirstRecordDirectorySync = needsFirstRecordDirectorySync
  }

  deinit {
    if let fileDescriptor {
      _ = flock(fileDescriptor, LOCK_UN)
      _ = Darwin.close(fileDescriptor)
    }
  }

  public static func inspect(
    url: URL,
    rootKey: Data,
    context: ArchiveContext
  ) throws -> ArchiveTapeScanResult {
    try inspect(url: url, rootKey: rootKey, context: context, hooks: ArchiveTapePersistenceHooks())
  }

  static func inspect(
    url: URL,
    rootKey: Data,
    context: ArchiveContext,
    hooks: ArchiveTapePersistenceHooks
  ) throws -> ArchiveTapeScanResult {
    let contextHash = try validateInputs(rootKey: rootKey, context: context)
    let fileDescriptor = openFile(path: url.path, flags: O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    guard fileDescriptor >= 0 else {
      throw ArchiveTapePersistenceError.openFailed(path: url.path, errno: errno)
    }
    defer { _ = Darwin.close(fileDescriptor) }
    try lockFile(fileDescriptor, operation: LOCK_SH | LOCK_NB)
    defer { _ = flock(fileDescriptor, LOCK_UN) }
    return try scan(
      fileDescriptor: fileDescriptor,
      rootKey: rootKey,
      context: context,
      contextHash: contextHash,
      hooks: hooks
    )
  }

  public static func openRecoveringForAppend(
    url: URL,
    rootKey: Data,
    context: ArchiveContext,
    indexedCheckpoint: ArchiveTapeCheckpoint? = nil
  ) throws -> ArchiveTapeStore {
    try openRecoveringForAppend(
      url: url,
      rootKey: rootKey,
      context: context,
      indexedCheckpoint: indexedCheckpoint,
      hooks: ArchiveTapePersistenceHooks(),
      nonceProvider: { try ArchivePurposeSealer.secureRandomNonceForPersistence() }
    )
  }

  static func openRecoveringForAppend(
    url: URL,
    rootKey: Data,
    context: ArchiveContext,
    indexedCheckpoint: ArchiveTapeCheckpoint? = nil,
    hooks: ArchiveTapePersistenceHooks,
    nonceProvider: @escaping @Sendable () throws -> Data
  ) throws -> ArchiveTapeStore {
    let contextHash = try validateInputs(rootKey: rootKey, context: context)
    let flags = O_RDWR | O_APPEND | O_CLOEXEC | O_NOFOLLOW
    var fileDescriptor = openFile(
      path: url.path,
      flags: flags | O_CREAT | O_EXCL,
      permissions: S_IRUSR | S_IWUSR
    )
    if fileDescriptor < 0, errno == EEXIST {
      fileDescriptor = openFile(path: url.path, flags: flags)
    }
    guard fileDescriptor >= 0 else {
      throw ArchiveTapePersistenceError.openFailed(path: url.path, errno: errno)
    }

    var transferred = false
    defer {
      if !transferred {
        _ = flock(fileDescriptor, LOCK_UN)
        _ = Darwin.close(fileDescriptor)
      }
    }
    try lockFile(fileDescriptor, operation: LOCK_EX | LOCK_NB)

    var scanResult = try scan(
      fileDescriptor: fileDescriptor,
      rootKey: rootKey,
      context: context,
      contextHash: contextHash,
      hooks: hooks
    )
    let repairedTrailingByteCount = scanResult.incompleteTrailingByteCount
    let indexedRecordCount = try validate(
      indexedCheckpoint: indexedCheckpoint, records: scanResult.records)
    if repairedTrailingByteCount > 0 {
      try truncateFile(
        fileDescriptor,
        offset: scanResult.completeByteCount,
        hooks: hooks
      )
      scanResult = ArchiveTapeScanResult(
        records: scanResult.records,
        completeByteCount: scanResult.completeByteCount,
        incompleteTrailingByteCount: 0
      )
    }
    if scanResult.completeByteCount > 0 || repairedTrailingByteCount > 0 {
      try fullSync(
        fileDescriptor,
        offset: scanResult.completeByteCount,
        hooks: hooks
      )
    }
    if scanResult.completeByteCount > 0 {
      try hooks.synchronizeDirectory(url.deletingLastPathComponent())
    }
    let sealer = try ArchivePurposeSealer(
      purpose: .tape,
      rootKey: rootKey,
      streamUUID: context.streamUUID,
      existingRecordCount: UInt64(scanResult.records.count),
      nonceProvider: nonceProvider
    )
    let store = ArchiveTapeStore(
      url: url,
      fileDescriptor: fileDescriptor,
      contextHash: contextHash,
      sealer: sealer,
      hooks: hooks,
      records: scanResult.records,
      indexedRecordCountAtOpen: indexedRecordCount,
      repairedTrailingByteCount: repairedTrailingByteCount,
      needsFirstRecordDirectorySync: scanResult.records.isEmpty
    )
    transferred = true
    return store
  }

  public var scanResult: ArchiveTapeScanResult {
    lock.withLock {
      ArchiveTapeScanResult(
        records: records,
        completeByteCount: records.last?.encryptedEndOffset ?? 0,
        incompleteTrailingByteCount: 0
      )
    }
  }

  public var unindexedRecords: [ArchiveTapeRecordMetadata] {
    lock.withLock { Array(records.dropFirst(indexedRecordCountAtOpen)) }
  }

  var sealerRecordCountForTesting: UInt64 {
    lock.withLock { sealer.sealedRecordCount }
  }

  public func appendPCM(_ plaintext: Data) throws -> ArchiveTapeRecordMetadata {
    try lock.withLock {
      guard let fileDescriptor else { throw ArchiveTapePersistenceError.closed }
      guard !poisoned else { throw ArchiveTapePersistenceError.requiresAuthenticatedReopen }
      guard startupUnindexedRecordCount == 0 else {
        throw ArchiveTapePersistenceError.startupRecordsRequireIndex(
          startupUnindexedRecordCount)
      }
      guard !plaintext.isEmpty, plaintext.count.isMultiple(of: 2), plaintext.count <= 32_000 else {
        throw ArchiveTapePersistenceError.invalidPCMByteCount(plaintext.count)
      }

      let previous = records.last
      let sequence = (previous?.header.recordSequence ?? 0) + 1
      let firstLogicalUnit =
        previous.map {
          $0.header.firstLogicalUnit + UInt64($0.header.logicalUnitCount)
        } ?? 0
      let request = ArchiveRecordSealRequest(
        recordSequence: sequence,
        firstLogicalUnit: firstLogicalUnit,
        logicalUnitCount: UInt32(plaintext.count / 2),
        previousCommittedTag: previous?.authenticationTag ?? Data(repeating: 0, count: 16),
        contextHash: contextHash
      )

      let envelope: UnauthenticatedArchiveEnvelope
      let encoded: Data
      do {
        envelope = try sealer.seal(plaintext, request: request)
        encoded = try ArchiveEnvelopeCodec.encodeUnauthenticated(envelope)
      } catch {
        poisoned = true
        throw error
      }

      let startOffset = previous?.encryptedEndOffset ?? 0
      do {
        try writeAll(
          fileDescriptor: fileDescriptor,
          data: encoded,
          startOffset: startOffset,
          hooks: hooks
        )
        let endOffset = startOffset + UInt64(encoded.count)
        try fullSync(fileDescriptor, offset: endOffset, hooks: hooks)
        if needsFirstRecordDirectorySync {
          try hooks.synchronizeDirectory(url.deletingLastPathComponent())
          needsFirstRecordDirectorySync = false
        }
        let metadata = ArchiveTapeRecordMetadata(
          header: envelope.header,
          authenticationTag: envelope.authenticationTag,
          encryptedStartOffset: startOffset,
          encryptedEndOffset: endOffset
        )
        records.append(metadata)
        return metadata
      } catch {
        poisoned = true
        throw error
      }
    }
  }

  public func close() {
    lock.withLock {
      if let fileDescriptor {
        _ = flock(fileDescriptor, LOCK_UN)
        _ = Darwin.close(fileDescriptor)
        self.fileDescriptor = nil
      }
    }
  }

  private static func validateInputs(rootKey: Data, context: ArchiveContext) throws -> Data {
    guard rootKey.count == 32 else {
      throw ArchiveCryptoError.invalidRootKeyLength(rootKey.count)
    }
    return try context.sha256()
  }

  private static func validate(
    indexedCheckpoint: ArchiveTapeCheckpoint?,
    records: [ArchiveTapeRecordMetadata]
  ) throws -> Int {
    guard let indexedCheckpoint else { return 0 }
    guard
      let index = records.firstIndex(where: {
        $0.header.recordSequence == indexedCheckpoint.recordSequence
      })
    else {
      throw ArchiveTapePersistenceError.indexedCheckpointNotFound(
        indexedCheckpoint.recordSequence)
    }
    guard records[index].checkpoint == indexedCheckpoint else {
      throw ArchiveTapePersistenceError.indexedCheckpointMismatch(
        indexedCheckpoint.recordSequence)
    }
    return index + 1
  }

  private static func scan(
    fileDescriptor: Int32,
    rootKey: Data,
    context: ArchiveContext,
    contextHash: Data,
    hooks: ArchiveTapePersistenceHooks
  ) throws -> ArchiveTapeScanResult {
    var fileStat = stat()
    var statResult: Int32
    repeat {
      statResult = fstat(fileDescriptor, &fileStat)
    } while statResult != 0 && errno == EINTR
    guard statResult == 0 else {
      throw ArchiveTapePersistenceError.statFailed(errno: errno)
    }
    guard fileStat.st_mode & S_IFMT == S_IFREG else {
      throw ArchiveTapePersistenceError.notRegularFile
    }
    guard fileStat.st_size >= 0 else {
      throw ArchiveTapePersistenceError.fileTooLarge(fileStat.st_size)
    }

    let fileSize = UInt64(fileStat.st_size)
    var offset: UInt64 = 0
    var records: [ArchiveTapeRecordMetadata] = []
    var expectedSequence: UInt64 = 1
    var expectedLogicalUnit: UInt64 = 0
    var expectedPredecessor = Data(repeating: 0, count: 16)

    while offset < fileSize {
      let remaining = fileSize - offset
      guard remaining >= UInt64(ArchiveEnvelopeCodec.headerByteCount) else {
        return ArchiveTapeScanResult(
          records: records,
          completeByteCount: offset,
          incompleteTrailingByteCount: remaining
        )
      }
      let headerData = try readExactly(
        fileDescriptor: fileDescriptor,
        offset: offset,
        count: ArchiveEnvelopeCodec.headerByteCount,
        hooks: hooks
      )
      let header = try ArchiveEnvelopeCodec.decodeHeaderPrefix(
        headerData, expectedPurpose: .tape, expectedContextHash: contextHash)
      let recordByteCount =
        UInt64(ArchiveEnvelopeCodec.headerByteCount)
        + UInt64(header.plaintextByteCount)
        + UInt64(ArchiveEnvelopeCodec.authenticationTagByteCount)
      guard remaining >= recordByteCount else {
        try validateContinuation(
          header: header,
          streamUUID: context.streamUUID,
          expectedSequence: expectedSequence,
          expectedLogicalUnit: expectedLogicalUnit,
          expectedPredecessor: expectedPredecessor,
          isFirstRecord: records.isEmpty
        )
        return ArchiveTapeScanResult(
          records: records,
          completeByteCount: offset,
          incompleteTrailingByteCount: remaining
        )
      }
      let encoded = try readExactly(
        fileDescriptor: fileDescriptor,
        offset: offset,
        count: Int(recordByteCount),
        hooks: hooks
      )
      let authenticated = try ArchiveRecordCrypto.open(
        encoded,
        rootKey: rootKey,
        expectedPurpose: .tape,
        expectedContextHash: contextHash
      )
      try validateContinuation(
        header: authenticated.header,
        streamUUID: context.streamUUID,
        expectedSequence: expectedSequence,
        expectedLogicalUnit: expectedLogicalUnit,
        expectedPredecessor: expectedPredecessor,
        isFirstRecord: records.isEmpty
      )
      let authenticationTag = Data(encoded.suffix(ArchiveEnvelopeCodec.authenticationTagByteCount))
      let endOffset = offset + recordByteCount
      records.append(
        ArchiveTapeRecordMetadata(
          header: authenticated.header,
          authenticationTag: authenticationTag,
          encryptedStartOffset: offset,
          encryptedEndOffset: endOffset
        ))
      guard UInt64(records.count) <= ArchivePurposeSealer.maximumRecordsPerPurposeKey else {
        throw ArchiveTapePersistenceError.recordCountExceedsLimit(UInt64(records.count))
      }
      expectedPredecessor = authenticationTag
      expectedLogicalUnit += UInt64(authenticated.header.logicalUnitCount)
      expectedSequence += 1
      offset = endOffset
    }
    return ArchiveTapeScanResult(
      records: records,
      completeByteCount: offset,
      incompleteTrailingByteCount: 0
    )
  }

  private static func validateContinuation(
    header: ArchiveEnvelopeHeader,
    streamUUID: Data,
    expectedSequence: UInt64,
    expectedLogicalUnit: UInt64,
    expectedPredecessor: Data,
    isFirstRecord: Bool
  ) throws {
    guard header.streamUUID == streamUUID else {
      throw ArchiveTapePersistenceError.streamUUIDMismatch
    }
    if isFirstRecord, header.recordSequence != 1 {
      throw ArchiveTapePersistenceError.invalidFirstSequence(header.recordSequence)
    }
    guard header.recordSequence == expectedSequence else {
      throw ArchiveTapePersistenceError.sequenceDiscontinuity(
        expected: expectedSequence, actual: header.recordSequence)
    }
    if isFirstRecord, header.firstLogicalUnit != 0 {
      throw ArchiveTapePersistenceError.invalidFirstLogicalUnit(header.firstLogicalUnit)
    }
    guard header.firstLogicalUnit == expectedLogicalUnit else {
      throw ArchiveTapePersistenceError.logicalDiscontinuity(
        expected: expectedLogicalUnit, actual: header.firstLogicalUnit)
    }
    guard header.previousCommittedTag == expectedPredecessor else {
      throw ArchiveTapePersistenceError.predecessorMismatch(sequence: header.recordSequence)
    }
  }
}

private func openFile(path: String, flags: Int32, permissions: mode_t? = nil) -> Int32 {
  var fileDescriptor: Int32
  repeat {
    if let permissions {
      fileDescriptor = Darwin.open(path, flags, permissions)
    } else {
      fileDescriptor = Darwin.open(path, flags)
    }
  } while fileDescriptor < 0 && errno == EINTR
  return fileDescriptor
}

private func lockFile(_ fileDescriptor: Int32, operation: Int32) throws {
  while flock(fileDescriptor, operation) != 0 {
    let lockErrno = errno
    if lockErrno == EINTR { continue }
    throw ArchiveTapePersistenceError.lockFailed(errno: lockErrno)
  }
}

private func truncateFile(
  _ fileDescriptor: Int32,
  offset: UInt64,
  hooks: ArchiveTapePersistenceHooks
) throws {
  while hooks.truncate(fileDescriptor, off_t(offset)) != 0 {
    let truncateErrno = errno
    if truncateErrno == EINTR { continue }
    throw ArchiveTapePersistenceError.truncateFailed(offset: offset, errno: truncateErrno)
  }
}

private func fullSync(
  _ fileDescriptor: Int32,
  offset: UInt64,
  hooks: ArchiveTapePersistenceHooks
) throws {
  while hooks.fullSync(fileDescriptor) != 0 {
    let syncErrno = errno
    if syncErrno == EINTR { continue }
    throw ArchiveTapePersistenceError.fullSyncFailed(offset: offset, errno: syncErrno)
  }
}

private func readExactly(
  fileDescriptor: Int32,
  offset: UInt64,
  count: Int,
  hooks: ArchiveTapePersistenceHooks
) throws -> Data {
  var data = Data(count: count)
  try data.withUnsafeMutableBytes { bytes in
    var completed = 0
    while completed < count {
      let result = hooks.pread(
        fileDescriptor,
        bytes.baseAddress!.advanced(by: completed),
        count - completed,
        off_t(offset + UInt64(completed))
      )
      let readErrno = errno
      if result < 0 {
        if readErrno == EINTR { continue }
        throw ArchiveTapePersistenceError.readFailed(
          offset: offset + UInt64(completed), errno: readErrno)
      }
      guard result > 0 else {
        throw ArchiveTapePersistenceError.unexpectedEndOfFile(
          offset: offset + UInt64(completed))
      }
      completed += result
    }
  }
  return data
}

private func writeAll(
  fileDescriptor: Int32,
  data: Data,
  startOffset: UInt64,
  hooks: ArchiveTapePersistenceHooks
) throws {
  try data.withUnsafeBytes { bytes in
    var completed = 0
    while completed < bytes.count {
      let result = hooks.write(
        fileDescriptor,
        bytes.baseAddress!.advanced(by: completed),
        bytes.count - completed
      )
      let writeErrno = errno
      if result < 0 {
        if writeErrno == EINTR { continue }
        throw ArchiveTapePersistenceError.writeFailed(
          offset: startOffset + UInt64(completed), errno: writeErrno)
      }
      guard result > 0 else {
        throw ArchiveTapePersistenceError.writeMadeNoProgress(
          offset: startOffset + UInt64(completed))
      }
      completed += result
    }
  }
}

private func archiveSynchronizeDirectory(_ directory: URL) throws {
  let fileDescriptor = openFile(
    path: directory.path, flags: O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
  guard fileDescriptor >= 0 else {
    throw ArchiveTapePersistenceError.directorySyncFailed(path: directory.path, errno: errno)
  }
  defer { _ = Darwin.close(fileDescriptor) }
  while fsync(fileDescriptor) != 0 {
    let syncErrno = errno
    if syncErrno == EINTR { continue }
    throw ArchiveTapePersistenceError.directorySyncFailed(
      path: directory.path, errno: syncErrno)
  }
}
