import CryptoKit
import Foundation
import Security

public struct ArchiveRecordSealRequest: Equatable, Sendable {
  public let recordSequence: UInt64
  public let firstLogicalUnit: UInt64
  public let logicalUnitCount: UInt32
  public let previousCommittedTag: Data
  public let contextHash: Data
  public let payloadSchemaVersion: UInt16

  public init(
    recordSequence: UInt64,
    firstLogicalUnit: UInt64,
    logicalUnitCount: UInt32,
    previousCommittedTag: Data,
    contextHash: Data,
    payloadSchemaVersion: UInt16 = 1
  ) {
    self.recordSequence = recordSequence
    self.firstLogicalUnit = firstLogicalUnit
    self.logicalUnitCount = logicalUnitCount
    self.previousCommittedTag = previousCommittedTag
    self.contextHash = contextHash
    self.payloadSchemaVersion = payloadSchemaVersion
  }
}

public struct AuthenticatedArchiveRecord: Equatable, Sendable {
  public let header: ArchiveEnvelopeHeader
  public let plaintext: Data

  fileprivate init(header: ArchiveEnvelopeHeader, plaintext: Data) {
    self.header = header
    self.plaintext = plaintext
  }
}

public enum ArchiveCryptoError: Error, Equatable, Sendable {
  case invalidRootKeyLength(Int)
  case invalidStreamUUIDLength(Int)
  case existingRecordCountExceedsLimit(UInt64)
  case recordLimitReached(UInt64)
  case nonceGenerationFailed(Int32)
  case invalidNonceLength(Int)
  case plaintextTooLarge(Int)
  case authenticationFailed
}

public final class ArchivePurposeSealer: @unchecked Sendable {
  public static let maximumRecordsPerPurposeKey: UInt64 = 131_072

  public let purpose: ArchiveRecordPurpose
  public let streamUUID: Data

  private let purposeKey: SymmetricKey
  private let nonceProvider: @Sendable () throws -> Data
  private let lock = NSLock()
  private var recordCount: UInt64

  public var sealedRecordCount: UInt64 {
    lock.withLock { recordCount }
  }

  public convenience init(
    purpose: ArchiveRecordPurpose,
    rootKey: Data,
    streamUUID: Data,
    existingRecordCount: UInt64 = 0
  ) throws {
    try self.init(
      purpose: purpose,
      rootKey: rootKey,
      streamUUID: streamUUID,
      existingRecordCount: existingRecordCount,
      nonceProvider: { try Self.secureRandomNonce() }
    )
  }

  init(
    purpose: ArchiveRecordPurpose,
    rootKey: Data,
    streamUUID: Data,
    existingRecordCount: UInt64 = 0,
    nonceProvider: @escaping @Sendable () throws -> Data
  ) throws {
    guard existingRecordCount <= Self.maximumRecordsPerPurposeKey else {
      throw ArchiveCryptoError.existingRecordCountExceedsLimit(existingRecordCount)
    }
    self.purpose = purpose
    self.streamUUID = streamUUID
    purposeKey = try ArchiveRecordCrypto.derivePurposeKey(
      rootKey: rootKey, streamUUID: streamUUID, purpose: purpose)
    recordCount = existingRecordCount
    self.nonceProvider = nonceProvider
  }

  public func seal(
    _ plaintext: Data,
    request: ArchiveRecordSealRequest
  ) throws -> UnauthenticatedArchiveEnvelope {
    try lock.withLock {
      guard recordCount < Self.maximumRecordsPerPurposeKey else {
        throw ArchiveCryptoError.recordLimitReached(recordCount)
      }
      guard plaintext.count <= Int(UInt32.max) else {
        throw ArchiveCryptoError.plaintextTooLarge(plaintext.count)
      }
      let nonceBytes = try nonceProvider()
      guard nonceBytes.count == 12 else {
        throw ArchiveCryptoError.invalidNonceLength(nonceBytes.count)
      }

      let header = ArchiveEnvelopeHeader(
        purpose: purpose,
        streamUUID: streamUUID,
        recordSequence: request.recordSequence,
        firstLogicalUnit: request.firstLogicalUnit,
        logicalUnitCount: request.logicalUnitCount,
        plaintextByteCount: UInt32(plaintext.count),
        nonce: nonceBytes,
        previousCommittedTag: request.previousCommittedTag,
        contextHash: request.contextHash,
        payloadSchemaVersion: request.payloadSchemaVersion
      )
      let authenticatedData = try ArchiveEnvelopeCodec.encodeHeader(header)
      let nonce = try AES.GCM.Nonce(data: nonceBytes)
      let sealed = try AES.GCM.seal(
        plaintext, using: purposeKey, nonce: nonce, authenticating: authenticatedData)
      let envelope = UnauthenticatedArchiveEnvelope(
        header: header,
        ciphertext: sealed.ciphertext,
        authenticationTag: sealed.tag
      )
      _ = try ArchiveEnvelopeCodec.encodeUnauthenticated(envelope)
      recordCount += 1
      return envelope
    }
  }

  private static func secureRandomNonce() throws -> Data {
    var bytes = [UInt8](repeating: 0, count: 12)
    let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    guard status == errSecSuccess else {
      throw ArchiveCryptoError.nonceGenerationFailed(status)
    }
    return Data(bytes)
  }
}

public enum ArchiveRecordCrypto {
  public static func open(
    _ encodedRecord: Data,
    rootKey: Data,
    expectedPurpose: ArchiveRecordPurpose,
    expectedContextHash: Data
  ) throws -> AuthenticatedArchiveRecord {
    let envelope = try ArchiveEnvelopeCodec.decodeUnauthenticated(
      encodedRecord,
      expectedPurpose: expectedPurpose,
      expectedContextHash: expectedContextHash
    )
    let key = try derivePurposeKey(
      rootKey: rootKey,
      streamUUID: envelope.header.streamUUID,
      purpose: expectedPurpose
    )
    let authenticatedData = try ArchiveEnvelopeCodec.encodeHeader(envelope.header)
    do {
      let nonce = try AES.GCM.Nonce(data: envelope.header.nonce)
      let sealed = try AES.GCM.SealedBox(
        nonce: nonce,
        ciphertext: envelope.ciphertext,
        tag: envelope.authenticationTag
      )
      let plaintext = try AES.GCM.open(sealed, using: key, authenticating: authenticatedData)
      return AuthenticatedArchiveRecord(header: envelope.header, plaintext: plaintext)
    } catch {
      throw ArchiveCryptoError.authenticationFailed
    }
  }

  static func derivedPurposeKeyBytesForTesting(
    rootKey: Data,
    streamUUID: Data,
    purpose: ArchiveRecordPurpose
  ) throws -> Data {
    let key = try derivePurposeKey(rootKey: rootKey, streamUUID: streamUUID, purpose: purpose)
    return key.withUnsafeBytes { Data($0) }
  }

  fileprivate static func derivePurposeKey(
    rootKey: Data,
    streamUUID: Data,
    purpose: ArchiveRecordPurpose
  ) throws -> SymmetricKey {
    guard rootKey.count == 32 else {
      throw ArchiveCryptoError.invalidRootKeyLength(rootKey.count)
    }
    guard streamUUID.count == 16 else {
      throw ArchiveCryptoError.invalidStreamUUIDLength(streamUUID.count)
    }
    return HKDF<SHA256>.deriveKey(
      inputKeyMaterial: SymmetricKey(data: rootKey),
      salt: streamUUID,
      info: Data(purpose.hkdfInfoLabel.utf8),
      outputByteCount: 32
    )
  }
}

extension ArchiveRecordPurpose {
  fileprivate var hkdfInfoLabel: String {
    switch self {
    case .tape: return "eta.room-recorder/v1/tape"
    case .index: return "eta.room-recorder/v1/index"
    case .journal: return "eta.room-recorder/v1/journal"
    case .control: return "eta.room-recorder/v1/control"
    case .level: return "eta.room-recorder/v1/level"
    case .manifest: return "eta.room-recorder/v1/manifest"
    case .spool: return "eta.room-recorder/v1/spool"
    }
  }
}
