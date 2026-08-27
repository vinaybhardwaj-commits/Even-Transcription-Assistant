import Darwin
import Foundation

public struct ArchiveDerivedRecord: Equatable, Sendable {
  public let header: ArchiveEnvelopeHeader
  public let plaintext: Data
  public let authenticationTag: Data
  public let encryptedStartOffset: UInt64
  public let encryptedEndOffset: UInt64
}

public struct ArchiveDerivedScanResult: Equatable, Sendable {
  public let records: [ArchiveDerivedRecord]
  public let completeByteCount: UInt64
  public let incompleteTrailingByteCount: UInt64
}

public enum ArchiveDerivedPersistenceError: Error, Equatable, Sendable {
  case unsupportedPurpose(ArchiveRecordPurpose)
  case openFailed(path: String, errno: Int32)
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
  case emptyLogicalRange
  case predecessorMismatch(sequence: UInt64)
  case recordCountExceedsLimit(UInt64)
  case arithmeticOverflow(field: String)
  case writeFailed(offset: UInt64, errno: Int32)
  case writeMadeNoProgress(offset: UInt64)
  case fullSyncFailed(offset: UInt64, errno: Int32)
  case truncateFailed(offset: UInt64, errno: Int32)
  case directorySyncFailed(path: String, errno: Int32)
  case createdPathChanged(path: String)
  case invalidPartialHeader(offset: Int)
  case ambiguousIncompleteRecord(sequence: UInt64)
  case incompleteTrailingRecordRequiresRepair(UInt64)
  case requiresAuthenticatedReopen
  case closed
}

public final class ArchiveDerivedStore: @unchecked Sendable {
  public typealias PayloadValidator = @Sendable (ArchiveDerivedRecord) throws -> Void
  public typealias HeaderValidator = @Sendable (ArchiveEnvelopeHeader, Int) throws -> Void
  public typealias PartialHeaderValidator = @Sendable (Data, Int) throws -> Void

  private let lock = NSLock()
  private let url: URL
  private let purpose: ArchiveRecordPurpose
  private let context: ArchiveContext
  private let contextHash: Data
  private let rootKey: Data
  private let validator: PayloadValidator
  private let headerValidator: HeaderValidator
  private let partialHeaderValidator: PartialHeaderValidator
  private let sealer: ArchivePurposeSealer
  private var fileDescriptor: Int32?
  private var records: [ArchiveDerivedRecord]
  private var needsDirectorySync: Bool
  private var incompleteTrailingByteCount: UInt64
  private var repairedByteCount: UInt64 = 0
  private let createdIdentity: DerivedFileIdentity?
  private var poisoned = false

  private init(
    url: URL,
    purpose: ArchiveRecordPurpose,
    context: ArchiveContext,
    contextHash: Data,
    rootKey: Data,
    validator: @escaping PayloadValidator,
    headerValidator: @escaping HeaderValidator,
    partialHeaderValidator: @escaping PartialHeaderValidator,
    sealer: ArchivePurposeSealer,
    fileDescriptor: Int32,
    records: [ArchiveDerivedRecord],
    incompleteTrailingByteCount: UInt64,
    createdIdentity: DerivedFileIdentity?
  ) {
    self.url = url
    self.purpose = purpose
    self.context = context
    self.contextHash = contextHash
    self.rootKey = rootKey
    self.validator = validator
    self.headerValidator = headerValidator
    self.partialHeaderValidator = partialHeaderValidator
    self.sealer = sealer
    self.fileDescriptor = fileDescriptor
    self.records = records
    self.incompleteTrailingByteCount = incompleteTrailingByteCount
    self.createdIdentity = createdIdentity
    needsDirectorySync = records.isEmpty
  }

  deinit {
    close()
  }

  public static func inspect(
    url: URL,
    purpose: ArchiveRecordPurpose,
    rootKey: Data,
    context: ArchiveContext,
    validator: @escaping PayloadValidator = { _ in },
    headerValidator: @escaping HeaderValidator = { _, _ in },
    partialHeaderValidator: @escaping PartialHeaderValidator = { _, _ in },
    allowExpectedIncompletePayloadRepair: Bool = false
  ) throws -> ArchiveDerivedScanResult {
    try validate(purpose: purpose, rootKey: rootKey, context: context)
    let contextHash = try context.sha256()
    let fileDescriptor = derivedOpen(
      path: url.path,
      flags: O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | O_SHLOCK
    )
    guard fileDescriptor >= 0 else {
      throw ArchiveDerivedPersistenceError.openFailed(path: url.path, errno: errno)
    }
    defer { _ = Darwin.close(fileDescriptor) }
    return try scan(
      fileDescriptor: fileDescriptor,
      purpose: purpose,
      rootKey: rootKey,
      context: context,
      contextHash: contextHash,
      validator: validator,
      headerValidator: headerValidator,
      partialHeaderValidator: partialHeaderValidator,
      allowExpectedIncompletePayloadRepair: allowExpectedIncompletePayloadRepair
    )
  }

  public static func openRecoveringForAppend(
    url: URL,
    purpose: ArchiveRecordPurpose,
    rootKey: Data,
    context: ArchiveContext,
    validator: @escaping PayloadValidator = { _ in },
    headerValidator: @escaping HeaderValidator = { _, _ in },
    partialHeaderValidator: @escaping PartialHeaderValidator = { _, _ in },
    allowExpectedIncompletePayloadRepair: Bool = false,
    repairTrailingRecord: Bool = true
  ) throws -> ArchiveDerivedStore {
    try validate(purpose: purpose, rootKey: rootKey, context: context)
    let contextHash = try context.sha256()
    let flags = O_RDWR | O_APPEND | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | O_EXLOCK
    var fileDescriptor = derivedOpen(path: url.path, flags: flags)
    var createdIdentity: DerivedFileIdentity?
    var createdFile = false
    if fileDescriptor < 0, errno == ENOENT {
      fileDescriptor = derivedOpen(
        path: url.path,
        flags: flags | O_CREAT | O_EXCL,
        permissions: S_IRUSR | S_IWUSR
      )
      createdFile = fileDescriptor >= 0
    }
    guard fileDescriptor >= 0 else {
      throw ArchiveDerivedPersistenceError.openFailed(path: url.path, errno: errno)
    }

    var transferred = false
    defer {
      if !transferred { _ = Darwin.close(fileDescriptor) }
    }
    if createdFile { createdIdentity = try Self.identity(of: fileDescriptor) }
    let scan = try scan(
      fileDescriptor: fileDescriptor,
      purpose: purpose,
      rootKey: rootKey,
      context: context,
      contextHash: contextHash,
      validator: validator,
      headerValidator: headerValidator,
      partialHeaderValidator: partialHeaderValidator,
      allowExpectedIncompletePayloadRepair: allowExpectedIncompletePayloadRepair
    )
    let sealer = try ArchivePurposeSealer(
      purpose: purpose,
      rootKey: rootKey,
      streamUUID: context.streamUUID,
      existingRecordCount: UInt64(scan.records.count)
    )
    let store = ArchiveDerivedStore(
      url: url,
      purpose: purpose,
      context: context,
      contextHash: contextHash,
      rootKey: rootKey,
      validator: validator,
      headerValidator: headerValidator,
      partialHeaderValidator: partialHeaderValidator,
      sealer: sealer,
      fileDescriptor: fileDescriptor,
      records: scan.records,
      incompleteTrailingByteCount: scan.incompleteTrailingByteCount,
      createdIdentity: createdIdentity
    )
    transferred = true
    if repairTrailingRecord {
      do {
        try store.repairIncompleteTrailingRecord()
      } catch {
        store.close()
        throw error
      }
    }
    return store
  }

  public var repairedTrailingByteCount: UInt64 {
    lock.withLock { repairedByteCount }
  }

  public var scanResult: ArchiveDerivedScanResult {
    lock.withLock {
      ArchiveDerivedScanResult(
        records: records,
        completeByteCount: records.last?.encryptedEndOffset ?? 0,
        incompleteTrailingByteCount: incompleteTrailingByteCount
      )
    }
  }

  public func repairIncompleteTrailingRecord() throws {
    try lock.withLock {
      guard let fileDescriptor else { throw ArchiveDerivedPersistenceError.closed }
      guard incompleteTrailingByteCount > 0 else { return }
      let completeByteCount = records.last?.encryptedEndOffset ?? 0
      try Self.truncate(fileDescriptor, offset: completeByteCount)
      try Self.fullSync(fileDescriptor, offset: completeByteCount)
      repairedByteCount += incompleteTrailingByteCount
      incompleteTrailingByteCount = 0
    }
  }

  public func discardIfCreatedAndEmpty() throws {
    try lock.withLock {
      guard let createdIdentity, records.isEmpty, incompleteTrailingByteCount == 0,
        let fileDescriptor
      else { return }
      let descriptorIdentity = try Self.identity(of: fileDescriptor)
      var pathStat = stat()
      guard lstat(url.path, &pathStat) == 0 else {
        throw ArchiveDerivedPersistenceError.createdPathChanged(path: url.path)
      }
      let pathIdentity = DerivedFileIdentity(pathStat)
      var fileStat = stat()
      guard descriptorIdentity == createdIdentity, pathIdentity == createdIdentity,
        fstat(fileDescriptor, &fileStat) == 0, fileStat.st_size == 0
      else {
        throw ArchiveDerivedPersistenceError.createdPathChanged(path: url.path)
      }
      guard unlink(url.path) == 0 else {
        throw ArchiveDerivedPersistenceError.createdPathChanged(path: url.path)
      }
      try Self.syncDirectory(url.deletingLastPathComponent())
      self.fileDescriptor = nil
      _ = Darwin.close(fileDescriptor)
    }
  }

  @discardableResult
  public func append(
    plaintext: Data,
    firstLogicalUnit: UInt64,
    logicalUnitCount: UInt32
  ) throws -> ArchiveDerivedRecord {
    try lock.withLock {
      guard let fileDescriptor else { throw ArchiveDerivedPersistenceError.closed }
      guard !poisoned else {
        throw ArchiveDerivedPersistenceError.requiresAuthenticatedReopen
      }
      guard incompleteTrailingByteCount == 0 else {
        throw ArchiveDerivedPersistenceError.incompleteTrailingRecordRequiresRepair(
          incompleteTrailingByteCount)
      }
      guard logicalUnitCount > 0 else {
        throw ArchiveDerivedPersistenceError.emptyLogicalRange
      }
      let previous = records.last
      let expectedLogicalUnit = try Self.logicalEnd(previous?.header)
      guard firstLogicalUnit == expectedLogicalUnit else {
        if previous == nil {
          throw ArchiveDerivedPersistenceError.invalidFirstLogicalUnit(firstLogicalUnit)
        }
        throw ArchiveDerivedPersistenceError.logicalDiscontinuity(
          expected: expectedLogicalUnit, actual: firstLogicalUnit)
      }
      let sequence = try Self.increment(previous?.header.recordSequence ?? 0)
      let request = ArchiveRecordSealRequest(
        recordSequence: sequence,
        firstLogicalUnit: firstLogicalUnit,
        logicalUnitCount: logicalUnitCount,
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
      let endOffset = try Self.add(startOffset, UInt64(encoded.count), field: "append_end")
      let record = ArchiveDerivedRecord(
        header: envelope.header,
        plaintext: plaintext,
        authenticationTag: envelope.authenticationTag,
        encryptedStartOffset: startOffset,
        encryptedEndOffset: endOffset
      )
      do {
        try headerValidator(record.header, records.count)
        try validator(record)
        try Self.writeAll(fileDescriptor, data: encoded, startOffset: startOffset)
        try Self.fullSync(fileDescriptor, offset: endOffset)
        if needsDirectorySync {
          try Self.syncDirectory(url.deletingLastPathComponent())
          needsDirectorySync = false
        }
      } catch {
        poisoned = true
        throw error
      }
      records.append(record)
      return record
    }
  }

  public func close() {
    lock.withLock {
      guard let fileDescriptor else { return }
      self.fileDescriptor = nil
      _ = Darwin.close(fileDescriptor)
    }
  }

  private static func validate(
    purpose: ArchiveRecordPurpose,
    rootKey: Data,
    context: ArchiveContext
  ) throws {
    guard purpose == .journal || purpose == .level else {
      throw ArchiveDerivedPersistenceError.unsupportedPurpose(purpose)
    }
    guard rootKey.count == 32 else {
      throw ArchiveCryptoError.invalidRootKeyLength(rootKey.count)
    }
    _ = try context.encodedBytes()
  }

  private static func identity(of fileDescriptor: Int32) throws -> DerivedFileIdentity {
    var fileStat = stat()
    guard fstat(fileDescriptor, &fileStat) == 0 else {
      throw ArchiveDerivedPersistenceError.statFailed(errno: errno)
    }
    return DerivedFileIdentity(fileStat)
  }

  private static func scan(
    fileDescriptor: Int32,
    purpose: ArchiveRecordPurpose,
    rootKey: Data,
    context: ArchiveContext,
    contextHash: Data,
    validator: PayloadValidator,
    headerValidator: HeaderValidator,
    partialHeaderValidator: PartialHeaderValidator,
    allowExpectedIncompletePayloadRepair: Bool
  ) throws -> ArchiveDerivedScanResult {
    var fileStat = stat()
    while fstat(fileDescriptor, &fileStat) != 0 {
      if errno == EINTR { continue }
      throw ArchiveDerivedPersistenceError.statFailed(errno: errno)
    }
    guard (fileStat.st_mode & S_IFMT) == S_IFREG else {
      throw ArchiveDerivedPersistenceError.notRegularFile
    }
    guard fileStat.st_size >= 0 else {
      throw ArchiveDerivedPersistenceError.fileTooLarge(fileStat.st_size)
    }
    let fileSize = UInt64(fileStat.st_size)
    var offset: UInt64 = 0
    var records: [ArchiveDerivedRecord] = []
    var expectedSequence: UInt64 = 1
    var expectedLogicalUnit: UInt64 = 0
    var expectedPredecessor = Data(repeating: 0, count: 16)
    while offset < fileSize {
      guard UInt64(records.count) < ArchivePurposeSealer.maximumRecordsPerPurposeKey else {
        throw ArchiveDerivedPersistenceError.recordCountExceedsLimit(UInt64(records.count) + 1)
      }
      let remaining = fileSize - offset
      guard remaining >= UInt64(ArchiveEnvelopeCodec.headerByteCount) else {
        let partial = try readExactly(fileDescriptor, offset: offset, count: Int(remaining))
        try validatePartialHeader(
          partial,
          purpose: purpose,
          context: context,
          contextHash: contextHash,
          expectedSequence: expectedSequence,
          expectedLogicalUnit: expectedLogicalUnit,
          expectedPredecessor: expectedPredecessor
        )
        try partialHeaderValidator(partial, records.count)
        return ArchiveDerivedScanResult(
          records: records,
          completeByteCount: offset,
          incompleteTrailingByteCount: remaining
        )
      }
      let headerData = try readExactly(
        fileDescriptor,
        offset: offset,
        count: ArchiveEnvelopeCodec.headerByteCount
      )
      let header = try ArchiveEnvelopeCodec.decodeHeaderPrefix(
        headerData,
        expectedPurpose: purpose,
        expectedContextHash: contextHash
      )
      try headerValidator(header, records.count)
      guard header.streamUUID == context.streamUUID else {
        throw ArchiveDerivedPersistenceError.streamUUIDMismatch
      }
      guard header.recordSequence == expectedSequence else {
        if records.isEmpty {
          throw ArchiveDerivedPersistenceError.invalidFirstSequence(header.recordSequence)
        }
        throw ArchiveDerivedPersistenceError.sequenceDiscontinuity(
          expected: expectedSequence,
          actual: header.recordSequence
        )
      }
      guard header.firstLogicalUnit == expectedLogicalUnit else {
        if records.isEmpty {
          throw ArchiveDerivedPersistenceError.invalidFirstLogicalUnit(header.firstLogicalUnit)
        }
        throw ArchiveDerivedPersistenceError.logicalDiscontinuity(
          expected: expectedLogicalUnit,
          actual: header.firstLogicalUnit
        )
      }
      guard header.logicalUnitCount > 0 else {
        throw ArchiveDerivedPersistenceError.emptyLogicalRange
      }
      guard header.previousCommittedTag == expectedPredecessor else {
        throw ArchiveDerivedPersistenceError.predecessorMismatch(sequence: header.recordSequence)
      }
      let recordByteCount =
        UInt64(ArchiveEnvelopeCodec.headerByteCount) + UInt64(header.plaintextByteCount)
        + UInt64(ArchiveEnvelopeCodec.authenticationTagByteCount)
      guard remaining >= recordByteCount else {
        guard allowExpectedIncompletePayloadRepair else {
          throw ArchiveDerivedPersistenceError.ambiguousIncompleteRecord(
            sequence: header.recordSequence)
        }
        return ArchiveDerivedScanResult(
          records: records,
          completeByteCount: offset,
          incompleteTrailingByteCount: remaining
        )
      }
      guard recordByteCount <= UInt64(Int.max) else {
        throw ArchiveDerivedPersistenceError.arithmeticOverflow(field: "record_byte_count")
      }
      let encoded = try readExactly(
        fileDescriptor,
        offset: offset,
        count: Int(recordByteCount)
      )
      let authenticated = try ArchiveRecordCrypto.open(
        encoded,
        rootKey: rootKey,
        expectedPurpose: purpose,
        expectedContextHash: contextHash
      )
      let end = try add(offset, recordByteCount, field: "scan_end")
      let tag = Data(encoded.suffix(ArchiveEnvelopeCodec.authenticationTagByteCount))
      let record = ArchiveDerivedRecord(
        header: authenticated.header,
        plaintext: authenticated.plaintext,
        authenticationTag: tag,
        encryptedStartOffset: offset,
        encryptedEndOffset: end
      )
      try validator(record)
      records.append(record)
      expectedPredecessor = tag
      expectedLogicalUnit = try logicalEnd(header)
      expectedSequence = try increment(expectedSequence)
      offset = end
    }
    return ArchiveDerivedScanResult(
      records: records,
      completeByteCount: offset,
      incompleteTrailingByteCount: 0
    )
  }

  private static func validatePartialHeader(
    _ partial: Data,
    purpose: ArchiveRecordPurpose,
    context: ArchiveContext,
    contextHash: Data,
    expectedSequence: UInt64,
    expectedLogicalUnit: UInt64,
    expectedPredecessor: Data
  ) throws {
    var expected = Data()
    expected.append(contentsOf: purpose.magic.utf8)
    appendLittleEndian(UInt16(1), to: &expected)
    appendLittleEndian(UInt16(ArchiveEnvelopeCodec.headerByteCount), to: &expected)
    appendLittleEndian(UInt32(0), to: &expected)
    expected.append(context.streamUUID)
    appendLittleEndian(expectedSequence, to: &expected)
    appendLittleEndian(expectedLogicalUnit, to: &expected)
    var fixedRanges = [0..<min(48, partial.count)]
    if partial.count > 68 {
      while expected.count < 68 { expected.append(0) }
      expected.append(expectedPredecessor)
      fixedRanges.append(68..<min(84, partial.count))
    }
    if partial.count > 84 {
      while expected.count < 84 { expected.append(0) }
      expected.append(contextHash)
      fixedRanges.append(84..<min(116, partial.count))
    }
    if partial.count > 116 {
      while expected.count < 116 { expected.append(0) }
      appendLittleEndian(UInt16(1), to: &expected)
      appendLittleEndian(purpose.kind, to: &expected)
      appendLittleEndian(UInt64(0), to: &expected)
      fixedRanges.append(116..<min(120, partial.count))
      if partial.count > 120 { fixedRanges.append(120..<min(128, partial.count)) }
    }
    for range in fixedRanges where !range.isEmpty {
      for offset in range where partial[offset] != expected[offset] {
        throw ArchiveDerivedPersistenceError.invalidPartialHeader(offset: offset)
      }
    }
    if partial.count >= 52 {
      let count =
        UInt32(partial[48]) | UInt32(partial[49]) << 8
        | UInt32(partial[50]) << 16 | UInt32(partial[51]) << 24
      guard count > 0 else { throw ArchiveDerivedPersistenceError.emptyLogicalRange }
    }
  }

  private static func appendLittleEndian<T: FixedWidthInteger>(
    _ value: T,
    to data: inout Data
  ) {
    for index in 0..<MemoryLayout<T>.size {
      data.append(UInt8(truncatingIfNeeded: value >> T(index * 8)))
    }
  }

  private static func logicalEnd(_ header: ArchiveEnvelopeHeader?) throws -> UInt64 {
    guard let header else { return 0 }
    return try logicalEnd(header)
  }

  private static func logicalEnd(_ header: ArchiveEnvelopeHeader) throws -> UInt64 {
    try add(
      header.firstLogicalUnit,
      UInt64(header.logicalUnitCount),
      field: "logical_end"
    )
  }

  private static func increment(_ value: UInt64) throws -> UInt64 {
    try add(value, 1, field: "sequence")
  }

  private static func add(_ lhs: UInt64, _ rhs: UInt64, field: String) throws -> UInt64 {
    let result = lhs.addingReportingOverflow(rhs)
    guard !result.overflow else {
      throw ArchiveDerivedPersistenceError.arithmeticOverflow(field: field)
    }
    return result.partialValue
  }

  private static func readExactly(
    _ fileDescriptor: Int32,
    offset: UInt64,
    count: Int
  ) throws -> Data {
    guard offset <= UInt64(Int64.max) else {
      throw ArchiveDerivedPersistenceError.arithmeticOverflow(field: "read_offset")
    }
    var data = Data(count: count)
    try data.withUnsafeMutableBytes { bytes in
      var completed = 0
      while completed < count {
        let result = pread(
          fileDescriptor,
          bytes.baseAddress!.advanced(by: completed),
          count - completed,
          off_t(offset + UInt64(completed))
        )
        let readErrno = errno
        if result < 0, readErrno == EINTR { continue }
        guard result >= 0 else {
          throw ArchiveDerivedPersistenceError.readFailed(
            offset: offset + UInt64(completed), errno: readErrno)
        }
        guard result > 0 else {
          throw ArchiveDerivedPersistenceError.unexpectedEndOfFile(
            offset: offset + UInt64(completed))
        }
        completed += result
      }
    }
    return data
  }

  private static func writeAll(
    _ fileDescriptor: Int32,
    data: Data,
    startOffset: UInt64
  ) throws {
    try data.withUnsafeBytes { bytes in
      var completed = 0
      while completed < bytes.count {
        let result = Darwin.write(
          fileDescriptor,
          bytes.baseAddress!.advanced(by: completed),
          bytes.count - completed
        )
        let writeErrno = errno
        if result < 0, writeErrno == EINTR { continue }
        guard result >= 0 else {
          throw ArchiveDerivedPersistenceError.writeFailed(
            offset: startOffset + UInt64(completed), errno: writeErrno)
        }
        guard result > 0 else {
          throw ArchiveDerivedPersistenceError.writeMadeNoProgress(
            offset: startOffset + UInt64(completed))
        }
        completed += result
      }
    }
  }

  private static func truncate(_ fileDescriptor: Int32, offset: UInt64) throws {
    guard offset <= UInt64(Int64.max) else {
      throw ArchiveDerivedPersistenceError.arithmeticOverflow(field: "truncate_offset")
    }
    while ftruncate(fileDescriptor, off_t(offset)) != 0 {
      let truncateErrno = errno
      if truncateErrno == EINTR { continue }
      throw ArchiveDerivedPersistenceError.truncateFailed(offset: offset, errno: truncateErrno)
    }
  }

  private static func fullSync(_ fileDescriptor: Int32, offset: UInt64) throws {
    while fcntl(fileDescriptor, F_FULLFSYNC) != 0 {
      let syncErrno = errno
      if syncErrno == EINTR { continue }
      throw ArchiveDerivedPersistenceError.fullSyncFailed(offset: offset, errno: syncErrno)
    }
  }

  private static func syncDirectory(_ directory: URL) throws {
    let descriptor = derivedOpen(
      path: directory.path,
      flags: O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW
    )
    guard descriptor >= 0 else {
      throw ArchiveDerivedPersistenceError.directorySyncFailed(
        path: directory.path, errno: errno)
    }
    defer { _ = Darwin.close(descriptor) }
    while fcntl(descriptor, F_FULLFSYNC) != 0 {
      let syncErrno = errno
      if syncErrno == EINTR { continue }
      throw ArchiveDerivedPersistenceError.directorySyncFailed(
        path: directory.path, errno: syncErrno)
    }
  }
}

private struct DerivedFileIdentity: Equatable {
  let device: UInt64
  let inode: UInt64

  init(_ fileStat: stat) {
    device = UInt64(fileStat.st_dev)
    inode = UInt64(fileStat.st_ino)
  }
}

private func derivedOpen(
  path: String,
  flags: Int32,
  permissions: mode_t? = nil
) -> Int32 {
  path.withCString { pointer in
    if let permissions {
      return Darwin.open(pointer, flags, permissions)
    }
    return Darwin.open(pointer, flags)
  }
}
