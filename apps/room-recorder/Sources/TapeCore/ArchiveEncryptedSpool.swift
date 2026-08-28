import CryptoKit
import Darwin
import Foundation

public enum ArchiveEncryptedSpoolError: Error, Equatable, Sendable {
  case invalidReservationID
  case invalidAttemptID
  case invalidDirectory
  case insecureDirectoryMode(UInt16)
  case directoryIdentityChanged
  case finalAttemptExists
  case attemptMissing
  case competingAttemptFiles
  case completionEvidenceRequired
  case manifestRequiresPublishedAttempt
  case closed
  case emptyOutput
  case incompleteSpoolRecord(UInt64)
  case encodedByteCountOverflow
  case publishFailed(errno: Int32)
  case publicationUncertain
  case sourceIdentityChanged
  case journalNotSpoolDurable(ArchiveJournalState)
  case attemptMismatch
  case reservationFactsMismatch
  case fitSegmentMismatch(expected: UInt64, actual: UInt64)
  case encodedByteCountMismatch(expected: UInt64, actual: UInt64)
  case encodedSHA256Mismatch(expected: String, actual: String)
  case invalidInitialReservation
}

public struct ArchivePublishedSpoolAttempt: Equatable, Sendable {
  public let reservationID: String
  public let attemptID: String
  public let url: URL
  public let encodedBytes: UInt64
  public let encodedSHA256: String
}

public struct ArchiveEncodedSpoolAttempt: Equatable, Sendable {
  public let reservationID: String
  public let attemptID: String
  public let temporaryURL: URL
  public let encodedBytes: UInt64
  public let encodedSHA256: String
}

public final class ArchiveEncryptedSpoolWriter: @unchecked Sendable {
  public static let maximumBufferedByteCount = Int(
    ArchiveRecordPurpose.spool.maximumPlaintextByteCount)

  public let reservationID: String
  public let attemptID: String
  public let temporaryURL: URL
  public let finalURL: URL

  private let lock = NSLock()
  private let store: ArchiveDerivedStore
  private var buffered = Data()
  private var encodedBytes: UInt64 = 0
  private var hasher = SHA256()
  private var finished = false
  private var failed = false

  public init(
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    directoryURL: URL,
    reservationID: String,
    attemptID: String = UUID().uuidString.lowercased()
  ) throws {
    guard Self.isLowercaseSHA256(reservationID) else {
      throw ArchiveEncryptedSpoolError.invalidReservationID
    }
    guard let uuid = UUID(uuidString: attemptID), uuid.uuidString.lowercased() == attemptID else {
      throw ArchiveEncryptedSpoolError.invalidAttemptID
    }
    let directoryIdentity = try Self.validateDirectory(directoryURL)
    let directory = try Self.openValidatedDirectory(
      directoryURL,
      expectedIdentity: directoryIdentity
    )
    defer { _ = Darwin.close(directory) }
    let finalName = "\(reservationID).\(attemptID).spool"
    let temporaryName = ".\(finalName).tmp"
    let temporaryURL = directoryURL.appendingPathComponent(temporaryName)
    let finalURL = directoryURL.appendingPathComponent(finalName)
    var finalStat = stat()
    var statResult: Int32
    repeat {
      statResult = finalName.withCString {
        fstatat(directory, $0, &finalStat, AT_SYMLINK_NOFOLLOW)
      }
    } while statResult != 0 && errno == EINTR
    if statResult == 0 {
      throw ArchiveEncryptedSpoolError.finalAttemptExists
    }
    if errno != ENOENT { throw ArchiveEncryptedSpoolError.publishFailed(errno: errno) }

    let store = try snapshot.createSpoolStore(
      directoryFileDescriptor: directory,
      fileName: temporaryName,
      at: temporaryURL
    )
    self.reservationID = reservationID
    self.attemptID = attemptID
    self.temporaryURL = temporaryURL
    self.finalURL = finalURL
    self.store = store
    buffered.reserveCapacity(Self.maximumBufferedByteCount)
  }

  deinit {
    store.close()
  }

  public func append(_ bytes: Data) throws {
    guard !bytes.isEmpty else { return }
    try lock.withLock {
      guard !finished, !failed else { throw ArchiveEncryptedSpoolError.closed }
      let added = encodedBytes.addingReportingOverflow(UInt64(bytes.count))
      guard !added.overflow else {
        failed = true
        throw ArchiveEncryptedSpoolError.encodedByteCountOverflow
      }
      encodedBytes = added.partialValue
      hasher.update(data: bytes)
      buffered.append(bytes)
      do {
        while buffered.count >= Self.maximumBufferedByteCount {
          let record = buffered.prefix(Self.maximumBufferedByteCount)
          try appendRecord(Data(record))
          buffered.removeFirst(Self.maximumBufferedByteCount)
        }
      } catch {
        failed = true
        throw error
      }
    }
  }

  public func finishEncoding() throws -> ArchiveEncodedSpoolAttempt {
    try lock.withLock {
      guard !finished, !failed else { throw ArchiveEncryptedSpoolError.closed }
      guard encodedBytes > 0 else { throw ArchiveEncryptedSpoolError.emptyOutput }
      do {
        if !buffered.isEmpty {
          try appendRecord(buffered)
          buffered.removeAll(keepingCapacity: false)
        }
      } catch {
        failed = true
        throw error
      }
      store.close()
      let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
      finished = true
      return ArchiveEncodedSpoolAttempt(
        reservationID: reservationID,
        attemptID: attemptID,
        temporaryURL: temporaryURL,
        encodedBytes: encodedBytes,
        encodedSHA256: digest
      )
    }
  }

  private func appendRecord(_ plaintext: Data) throws {
    guard plaintext.count <= Self.maximumBufferedByteCount,
      plaintext.count <= Int(UInt32.max)
    else {
      throw ArchiveEncryptedSpoolError.encodedByteCountOverflow
    }
    let current =
      store.scanResult.records.last.map {
        $0.header.firstLogicalUnit + UInt64($0.header.logicalUnitCount)
      } ?? 0
    try store.append(
      plaintext: plaintext,
      firstLogicalUnit: current,
      logicalUnitCount: UInt32(plaintext.count)
    )
  }

  fileprivate static func validateDirectory(_ url: URL) throws -> SpoolFileIdentity {
    guard url.isFileURL, url.path.hasPrefix("/"),
      !url.path.split(separator: "/", omittingEmptySubsequences: false).contains("..")
    else {
      throw ArchiveEncryptedSpoolError.invalidDirectory
    }
    guard let resolved = realpath(url.path, nil) else {
      throw ArchiveEncryptedSpoolError.invalidDirectory
    }
    defer { Darwin.free(resolved) }
    guard String(cString: resolved) == url.path else {
      throw ArchiveEncryptedSpoolError.invalidDirectory
    }
    var value = stat()
    guard lstat(url.path, &value) == 0, value.st_mode & S_IFMT == S_IFDIR else {
      throw ArchiveEncryptedSpoolError.invalidDirectory
    }
    let mode = value.st_mode & mode_t(0o777)
    guard mode == mode_t(0o700) else {
      throw ArchiveEncryptedSpoolError.insecureDirectoryMode(UInt16(mode))
    }
    return SpoolFileIdentity(value)
  }

  fileprivate static func openValidatedDirectory(
    _ url: URL,
    expectedIdentity: SpoolFileIdentity
  ) throws -> Int32 {
    let descriptor = Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    guard descriptor >= 0 else { throw ArchiveEncryptedSpoolError.invalidDirectory }
    var value = stat()
    guard fstat(descriptor, &value) == 0, value.st_mode & S_IFMT == S_IFDIR,
      value.st_mode & mode_t(0o777) == mode_t(0o700),
      SpoolFileIdentity(value) == expectedIdentity
    else {
      _ = Darwin.close(descriptor)
      throw ArchiveEncryptedSpoolError.directoryIdentityChanged
    }
    return descriptor
  }

  fileprivate static func validatePrivateFile(_ url: URL) throws -> SpoolFileIdentity {
    var value = stat()
    guard lstat(url.path, &value) == 0, value.st_mode & S_IFMT == S_IFREG,
      value.st_nlink == 1, value.st_mode & mode_t(0o777) == mode_t(0o600)
    else {
      throw ArchiveEncryptedSpoolError.sourceIdentityChanged
    }
    return SpoolFileIdentity(value)
  }

  fileprivate static func validatePrivateFileDescriptor(_ descriptor: Int32) throws
    -> SpoolFileIdentity
  {
    var value = stat()
    guard fstat(descriptor, &value) == 0, value.st_mode & S_IFMT == S_IFREG,
      value.st_nlink == 1, value.st_mode & mode_t(0o777) == mode_t(0o600)
    else {
      throw ArchiveEncryptedSpoolError.sourceIdentityChanged
    }
    return SpoolFileIdentity(value)
  }

  fileprivate static func isLowercaseSHA256(_ value: String) -> Bool {
    value.utf8.count == 64
      && value.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
  }
}

enum ArchiveEncryptedSpoolPublisher {
  static func publish(
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    directoryURL: URL,
    reservation: ArchiveJournalReplayReservation,
    expected: ArchiveEncodedSpoolAttempt? = nil,
    manifest: ArchiveManifestPayload? = nil
  ) throws -> ArchivePublishedSpoolAttempt {
    let reservationID = reservation.initialReservation.reservationID
    guard let attemptID = expected?.attemptID ?? manifest?.attemptID else {
      throw ArchiveEncryptedSpoolError.completionEvidenceRequired
    }
    guard ArchiveEncryptedSpoolWriter.isLowercaseSHA256(reservationID) else {
      throw ArchiveEncryptedSpoolError.invalidReservationID
    }
    guard let uuid = UUID(uuidString: attemptID), uuid.uuidString.lowercased() == attemptID else {
      throw ArchiveEncryptedSpoolError.invalidAttemptID
    }
    if let expected {
      guard expected.reservationID == reservationID, expected.attemptID == attemptID else {
        throw ArchiveEncryptedSpoolError.attemptMismatch
      }
    }
    if let manifest {
      guard manifest.reservationID == reservationID, manifest.attemptID == attemptID else {
        throw ArchiveEncryptedSpoolError.attemptMismatch
      }
    }
    if manifest != nil, reservation.state != .encoded,
      let boundAttemptID = reservation.attemptID, boundAttemptID != attemptID
    {
      throw ArchiveEncryptedSpoolError.attemptMismatch
    }
    let directoryIdentity = try ArchiveEncryptedSpoolWriter.validateDirectory(directoryURL)
    let directory = try ArchiveEncryptedSpoolWriter.openValidatedDirectory(
      directoryURL,
      expectedIdentity: directoryIdentity
    )
    defer { _ = Darwin.close(directory) }
    let finalName = "\(reservationID).\(attemptID).spool"
    let temporaryURL = directoryURL.appendingPathComponent(".\(finalName).tmp")
    let finalURL = directoryURL.appendingPathComponent(finalName)
    let temporaryName = temporaryURL.lastPathComponent
    let temporaryExists = try fileExists(directory: directory, name: temporaryName)
    let finalExists = try fileExists(directory: directory, name: finalName)
    guard temporaryExists || finalExists else { throw ArchiveEncryptedSpoolError.attemptMissing }
    guard !(temporaryExists && finalExists) else {
      throw ArchiveEncryptedSpoolError.competingAttemptFiles
    }
    if manifest != nil, !finalExists {
      throw ArchiveEncryptedSpoolError.manifestRequiresPublishedAttempt
    }

    let sourceName = finalExists ? finalName : temporaryName
    let source = try openSource(directory: directory, name: sourceName)
    defer { _ = Darwin.close(source) }
    let sourceIdentity = try ArchiveEncryptedSpoolWriter.validatePrivateFileDescriptor(source)
    let scan = try snapshot.inspectSpool(fileDescriptor: source)
    guard try ArchiveEncryptedSpoolWriter.validatePrivateFileDescriptor(source) == sourceIdentity,
      try pathIdentity(directory: directory, name: sourceName) == sourceIdentity
    else {
      throw ArchiveEncryptedSpoolError.sourceIdentityChanged
    }
    let facts = try plaintextFacts(scan)
    if let expected {
      guard expected.temporaryURL == temporaryURL else {
        throw ArchiveEncryptedSpoolError.sourceIdentityChanged
      }
      guard expected.encodedBytes == facts.encodedBytes else {
        throw ArchiveEncryptedSpoolError.encodedByteCountMismatch(
          expected: expected.encodedBytes,
          actual: facts.encodedBytes
        )
      }
      guard expected.encodedSHA256 == facts.encodedSHA256 else {
        throw ArchiveEncryptedSpoolError.encodedSHA256Mismatch(
          expected: expected.encodedSHA256,
          actual: facts.encodedSHA256
        )
      }
    }
    if let manifest {
      guard manifest.encodedBytes == facts.encodedBytes else {
        throw ArchiveEncryptedSpoolError.encodedByteCountMismatch(
          expected: manifest.encodedBytes,
          actual: facts.encodedBytes
        )
      }
      guard manifest.encodedSHA256 == facts.encodedSHA256 else {
        throw ArchiveEncryptedSpoolError.encodedSHA256Mismatch(
          expected: manifest.encodedSHA256,
          actual: facts.encodedSHA256
        )
      }
    }

    if temporaryExists {
      var renameResult: Int32
      repeat {
        renameResult = temporaryName.withCString { sourceName in
          finalName.withCString { destinationName in
            renameatx_np(
              directory,
              sourceName,
              directory,
              destinationName,
              UInt32(RENAME_EXCL)
            )
          }
        }
      } while renameResult != 0 && errno == EINTR
      guard renameResult == 0 else {
        if errno == EEXIST { throw ArchiveEncryptedSpoolError.finalAttemptExists }
        throw ArchiveEncryptedSpoolError.publishFailed(errno: errno)
      }
      guard try pathIdentity(directory: directory, name: finalName) == sourceIdentity else {
        throw ArchiveEncryptedSpoolError.publicationUncertain
      }
    }
    var syncResult: Int32
    repeat { syncResult = fsync(directory) } while syncResult != 0 && errno == EINTR
    guard syncResult == 0 else { throw ArchiveEncryptedSpoolError.publicationUncertain }

    return ArchivePublishedSpoolAttempt(
      reservationID: reservationID,
      attemptID: attemptID,
      url: finalURL,
      encodedBytes: facts.encodedBytes,
      encodedSHA256: facts.encodedSHA256
    )
  }

  private static func fileExists(directory: Int32, name: String) throws -> Bool {
    var value = stat()
    var result: Int32
    repeat {
      result = name.withCString {
        fstatat(directory, $0, &value, AT_SYMLINK_NOFOLLOW)
      }
    } while result != 0 && errno == EINTR
    if result == 0 { return true }
    if errno == ENOENT { return false }
    throw ArchiveEncryptedSpoolError.publishFailed(errno: errno)
  }

  private static func openSource(directory: Int32, name: String) throws -> Int32 {
    var descriptor: Int32
    repeat {
      descriptor = name.withCString {
        openat(directory, $0, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | O_SHLOCK)
      }
    } while descriptor < 0 && errno == EINTR
    guard descriptor >= 0 else {
      throw ArchiveEncryptedSpoolError.publishFailed(errno: errno)
    }
    return descriptor
  }

  private static func pathIdentity(directory: Int32, name: String) throws -> SpoolFileIdentity {
    var value = stat()
    var result: Int32
    repeat {
      result = name.withCString {
        fstatat(directory, $0, &value, AT_SYMLINK_NOFOLLOW)
      }
    } while result != 0 && errno == EINTR
    guard result == 0, value.st_mode & S_IFMT == S_IFREG, value.st_nlink == 1,
      value.st_mode & mode_t(0o777) == mode_t(0o600)
    else {
      throw ArchiveEncryptedSpoolError.sourceIdentityChanged
    }
    return SpoolFileIdentity(value)
  }

  private static func plaintextFacts(_ scan: ArchiveDerivedScanResult) throws
    -> (encodedBytes: UInt64, encodedSHA256: String)
  {
    guard scan.incompleteTrailingByteCount == 0 else {
      throw ArchiveEncryptedSpoolError.incompleteSpoolRecord(scan.incompleteTrailingByteCount)
    }
    var hasher = SHA256()
    var encodedBytes: UInt64 = 0
    for record in scan.records {
      let added = encodedBytes.addingReportingOverflow(UInt64(record.plaintext.count))
      guard !added.overflow else { throw ArchiveEncryptedSpoolError.encodedByteCountOverflow }
      encodedBytes = added.partialValue
      hasher.update(data: record.plaintext)
    }
    guard encodedBytes > 0 else { throw ArchiveEncryptedSpoolError.emptyOutput }
    return (
      encodedBytes,
      hasher.finalize().map { String(format: "%02x", $0) }.joined()
    )
  }
}

public enum ArchiveSpoolCorrespondence {
  public static func validate(
    reservation: ArchiveJournalReplayReservation,
    manifest: ArchiveManifestPayload,
    spool: ArchiveDerivedScanResult,
    spoolURL: URL,
    expectedFitSegment: UInt64
  ) throws -> ArchivePublishedSpoolAttempt {
    switch reservation.state {
    case .spoolDurable, .putComplete, .headVerified, .rowRegistered, .done:
      break
    case .reserved, .encoded:
      throw ArchiveEncryptedSpoolError.journalNotSpoolDurable(reservation.state)
    }
    guard let attemptID = reservation.attemptID, manifest.attemptID == attemptID else {
      throw ArchiveEncryptedSpoolError.attemptMismatch
    }
    return try validateManifest(
      initialReservation: reservation.initialReservation,
      manifest: manifest,
      spool: spool,
      spoolURL: spoolURL,
      expectedFitSegment: expectedFitSegment
    )
  }

  public static func validateManifest(
    initialReservation initial: ArchiveJournalPayload,
    manifest: ArchiveManifestPayload,
    spool: ArchiveDerivedScanResult,
    spoolURL: URL,
    expectedFitSegment: UInt64
  ) throws -> ArchivePublishedSpoolAttempt {
    guard manifest.reservationID == initial.reservationID,
      manifest.sampleStart == initial.sampleStart,
      manifest.sampleEnd == initial.sampleEnd,
      manifest.startMS == initial.startMS,
      manifest.endMS == initial.endMS,
      manifest.uncertainty == initial.uncertainty,
      manifest.averageLevelQ15 == initial.averageLevelQ15,
      manifest.peakLevelQ15 == initial.peakLevelQ15
    else {
      throw ArchiveEncryptedSpoolError.reservationFactsMismatch
    }
    guard manifest.fitSegment == expectedFitSegment else {
      throw ArchiveEncryptedSpoolError.fitSegmentMismatch(
        expected: expectedFitSegment,
        actual: manifest.fitSegment
      )
    }
    guard spool.incompleteTrailingByteCount == 0 else {
      throw ArchiveEncryptedSpoolError.incompleteSpoolRecord(
        spool.incompleteTrailingByteCount
      )
    }

    var hasher = SHA256()
    var encodedBytes: UInt64 = 0
    for record in spool.records {
      let added = encodedBytes.addingReportingOverflow(UInt64(record.plaintext.count))
      guard !added.overflow else { throw ArchiveEncryptedSpoolError.encodedByteCountOverflow }
      encodedBytes = added.partialValue
      hasher.update(data: record.plaintext)
    }
    guard encodedBytes == manifest.encodedBytes else {
      throw ArchiveEncryptedSpoolError.encodedByteCountMismatch(
        expected: manifest.encodedBytes,
        actual: encodedBytes
      )
    }
    let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
    guard digest == manifest.encodedSHA256 else {
      throw ArchiveEncryptedSpoolError.encodedSHA256Mismatch(
        expected: manifest.encodedSHA256,
        actual: digest
      )
    }
    return ArchivePublishedSpoolAttempt(
      reservationID: initial.reservationID,
      attemptID: manifest.attemptID,
      url: spoolURL,
      encodedBytes: encodedBytes,
      encodedSHA256: digest
    )
  }
}

public enum ArchiveJournalTransition {
  public static func make(
    from initial: ArchiveJournalPayload,
    attemptID: String,
    priorState: ArchiveJournalState,
    newState: ArchiveJournalState,
    error: String? = nil
  ) throws -> ArchiveJournalPayload {
    guard initial.priorState == nil, initial.newState == .reserved,
      initial.attemptID == nil, initial.error == nil
    else {
      throw ArchiveEncryptedSpoolError.invalidInitialReservation
    }
    return try ArchiveJournalPayload(
      reservationID: initial.reservationID,
      roomID: initial.roomID,
      sessionID: initial.sessionID,
      laneID: initial.laneID,
      istDate: initial.istDate,
      chunkIndex: initial.chunkIndex,
      sampleStart: initial.sampleStart,
      sampleEnd: initial.sampleEnd,
      startMS: initial.startMS,
      endMS: initial.endMS,
      uncertainty: initial.uncertainty,
      averageLevelQ15: initial.averageLevelQ15,
      peakLevelQ15: initial.peakLevelQ15,
      attemptID: attemptID,
      priorState: priorState,
      newState: newState,
      error: error
    )
  }
}

private struct SpoolFileIdentity: Equatable {
  let device: UInt64
  let inode: UInt64

  init(_ value: stat) {
    device = UInt64(value.st_dev)
    inode = UInt64(value.st_ino)
  }
}
