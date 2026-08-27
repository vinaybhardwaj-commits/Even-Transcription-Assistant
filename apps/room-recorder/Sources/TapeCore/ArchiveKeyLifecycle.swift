import CryptoKit
import Darwin
import Foundation
import Security

public enum ArchiveKeyLifecycleError: String, Error, LocalizedError, Sendable {
  case secureHardwareUnavailable = "secure_hardware_unavailable"
  case archiveKeyUnavailable = "archive_key_unavailable"

  public var errorDescription: String? { rawValue }
}

public struct ArchiveKeywrapInspection: Equatable, Sendable {
  public let formatVersion: UInt16
  public let algorithmID: UInt16
  public let streamUUIDHex: String
  public let contextHashHex: String
  public let publicKeyHashHex: String
  public let wrappedByteCount: UInt32
}

#if ETA_KEYWRAP_PROBE
  public enum ArchiveKeywrapProbeOpenMode: Sendable {
    case provision
    case appendFixture
    case reopenFixture
  }

  package enum ArchiveKeywrapProbePathParser {
    package static func fileURL(_ rawPath: String, isDirectory: Bool = false) -> URL? {
      guard rawPath.hasPrefix("/") else { return nil }
      return URL(fileURLWithPath: rawPath, isDirectory: isDirectory)
    }
  }
#endif

enum ArchiveKeyLifecycleFailure: Error, Equatable {
  case invalidFieldLength(field: String, expected: Int, actual: Int)
  case truncatedOuter(actual: Int)
  case wrongOuterMagic
  case unsupportedOuterVersion(UInt16)
  case unsupportedAlgorithm(UInt16)
  case invalidOuterHeaderLength(UInt32)
  case nonzeroOuterReserved(UInt32)
  case emptyWrappedData
  case wrappedDataTooLarge(UInt32)
  case outerLengthMismatch(expected: Int, actual: Int)
  case wrongPlaintextLength(Int)
  case wrongPlaintextMagic
  case unsupportedPlaintextVersion(UInt16)
  case nonzeroPlaintextReserved
  case streamUUIDMismatch
  case contextHashMismatch
  case publicKeyHashMismatch
  case invalidPublicKeyRepresentationLength(Int)
  case keyQueryFailed(OSStatus)
  case keyCreationFailed(OSStatus)
  case keyMissingForExistingArchive
  case multipleTaggedKeys(Int)
  case accessControlCreationFailed
  case algorithmUnavailable
  case encryptionFailed
  case decryptionFailed
  case randomGenerationFailed(OSStatus)
  case existingArchiveWithoutKeywrap
  case fileOpenFailed(errno: Int32)
  case fileStatFailed(errno: Int32)
  case notRegularFile
  case hardLinkedFile(UInt64)
  case fileTooLarge(Int64)
  case fileReadFailed(errno: Int32)
  case unexpectedEndOfFile
  case pathIdentityChanged
  case temporaryOpenFailed(errno: Int32)
  case temporaryModeMismatch(mode_t)
  case writeFailed(errno: Int32)
  case writeMadeNoProgress
  case fullSyncFailed(errno: Int32)
  case renameFailed(errno: Int32)
  case directorySyncFailed(errno: Int32)
  case temporaryCleanupFailed(errno: Int32)
  case publicationUncertain
  case ownerPoisoned
  case laneStoreOpenFailed
  case invalidPath
  case symlinkParent(String)
  case pathAlias
  case globalLockFailed(errno: Int32)
  case reservationFailed(errno: Int32)
  case reservationCleanupFailed(errno: Int32)
  case existingModeMismatch(mode_t)
  case snapshotChanged
}

struct ArchiveKeywrapOuter {
  let streamUUID: Data
  let contextHash: Data
  let publicKeyHash: Data
  let wrappedData: Data
}

enum ArchiveKeywrapCodec {
  static let headerByteCount = 104
  static let maximumWrappedByteCount = 4_096
  static let formatVersion: UInt16 = 1
  static let algorithmID: UInt16 = 1

  static func encode(_ value: ArchiveKeywrapOuter) throws -> Data {
    try requireLength(value.streamUUID, field: "stream_uuid", expected: 16)
    try requireLength(value.contextHash, field: "context_hash", expected: 32)
    try requireLength(value.publicKeyHash, field: "public_key_hash", expected: 32)
    guard !value.wrappedData.isEmpty else { throw ArchiveKeyLifecycleFailure.emptyWrappedData }
    guard value.wrappedData.count <= maximumWrappedByteCount else {
      throw ArchiveKeyLifecycleFailure.wrappedDataTooLarge(UInt32(value.wrappedData.count))
    }

    var result = Data("ETAKEY01".utf8)
    result.appendKeyLittleEndian(formatVersion)
    result.appendKeyLittleEndian(algorithmID)
    result.appendKeyLittleEndian(UInt32(headerByteCount))
    result.append(value.streamUUID)
    result.append(value.contextHash)
    result.append(value.publicKeyHash)
    result.appendKeyLittleEndian(UInt32(value.wrappedData.count))
    result.appendKeyLittleEndian(UInt32(0))
    result.append(value.wrappedData)
    return result
  }

  static func decode(_ data: Data) throws -> ArchiveKeywrapOuter {
    guard data.count >= headerByteCount else {
      throw ArchiveKeyLifecycleFailure.truncatedOuter(actual: data.count)
    }
    guard data.keyBytes(0..<8) == Data("ETAKEY01".utf8) else {
      throw ArchiveKeyLifecycleFailure.wrongOuterMagic
    }
    let version = data.keyUInt16(at: 8)
    guard version == formatVersion else {
      throw ArchiveKeyLifecycleFailure.unsupportedOuterVersion(version)
    }
    let algorithm = data.keyUInt16(at: 10)
    guard algorithm == algorithmID else {
      throw ArchiveKeyLifecycleFailure.unsupportedAlgorithm(algorithm)
    }
    let headerLength = data.keyUInt32(at: 12)
    guard headerLength == UInt32(headerByteCount) else {
      throw ArchiveKeyLifecycleFailure.invalidOuterHeaderLength(headerLength)
    }
    let wrappedLength = data.keyUInt32(at: 96)
    guard wrappedLength > 0 else { throw ArchiveKeyLifecycleFailure.emptyWrappedData }
    guard wrappedLength <= UInt32(maximumWrappedByteCount) else {
      throw ArchiveKeyLifecycleFailure.wrappedDataTooLarge(wrappedLength)
    }
    let reserved = data.keyUInt32(at: 100)
    guard reserved == 0 else {
      throw ArchiveKeyLifecycleFailure.nonzeroOuterReserved(reserved)
    }
    let expectedCount = headerByteCount + Int(wrappedLength)
    guard data.count == expectedCount else {
      throw ArchiveKeyLifecycleFailure.outerLengthMismatch(
        expected: expectedCount, actual: data.count)
    }
    return ArchiveKeywrapOuter(
      streamUUID: data.keyBytes(16..<32),
      contextHash: data.keyBytes(32..<64),
      publicKeyHash: data.keyBytes(64..<96),
      wrappedData: data.keyBytes(headerByteCount..<expectedCount)
    )
  }

  private static func requireLength(_ data: Data, field: String, expected: Int) throws {
    guard data.count == expected else {
      throw ArchiveKeyLifecycleFailure.invalidFieldLength(
        field: field, expected: expected, actual: data.count)
    }
  }
}

struct ArchiveKeywrapPlaintext {
  let rootKey: Data
  let streamUUID: Data
  let contextHash: Data
  let wrapID: Data
}

enum ArchiveKeywrapPlaintextCodec {
  static let byteCount = 112

  static func encode(_ value: ArchiveKeywrapPlaintext) throws -> Data {
    try requireLength(value.rootKey, field: "root_key", expected: 32)
    try requireLength(value.streamUUID, field: "stream_uuid", expected: 16)
    try requireLength(value.contextHash, field: "context_hash", expected: 32)
    try requireLength(value.wrapID, field: "wrap_id", expected: 16)
    var result = Data("ETAKEYP1".utf8)
    result.appendKeyLittleEndian(UInt16(1))
    result.append(Data(repeating: 0, count: 6))
    result.append(value.rootKey)
    result.append(value.streamUUID)
    result.append(value.contextHash)
    result.append(value.wrapID)
    return result
  }

  static func decode(_ data: Data) throws -> ArchiveKeywrapPlaintext {
    guard data.count == byteCount else {
      throw ArchiveKeyLifecycleFailure.wrongPlaintextLength(data.count)
    }
    guard data.keyBytes(0..<8) == Data("ETAKEYP1".utf8) else {
      throw ArchiveKeyLifecycleFailure.wrongPlaintextMagic
    }
    let version = data.keyUInt16(at: 8)
    guard version == 1 else {
      throw ArchiveKeyLifecycleFailure.unsupportedPlaintextVersion(version)
    }
    guard data.keyBytes(10..<16) == Data(repeating: 0, count: 6) else {
      throw ArchiveKeyLifecycleFailure.nonzeroPlaintextReserved
    }
    return ArchiveKeywrapPlaintext(
      rootKey: data.keyBytes(16..<48),
      streamUUID: data.keyBytes(48..<64),
      contextHash: data.keyBytes(64..<96),
      wrapID: data.keyBytes(96..<112)
    )
  }

  private static func requireLength(_ data: Data, field: String, expected: Int) throws {
    guard data.count == expected else {
      throw ArchiveKeyLifecycleFailure.invalidFieldLength(
        field: field, expected: expected, actual: data.count)
    }
  }
}

final class ArchiveSecurityKey {
  let value: AnyObject
  init(_ value: AnyObject) { self.value = value }
}

protocol ArchiveKeySecurityProviding {
  func makeAccessControl(accessibility: CFString, flags: SecAccessControlCreateFlags) throws
    -> AnyObject
  func queryKeys(_ query: [String: Any]) throws -> [ArchiveSecurityKey]
  func createKey(_ attributes: [String: Any]) throws -> ArchiveSecurityKey
  func publicKey(for privateKey: ArchiveSecurityKey) throws -> ArchiveSecurityKey
  func externalRepresentation(of key: ArchiveSecurityKey) throws -> Data
  func supports(
    _ algorithm: SecKeyAlgorithm, operation: SecKeyOperationType, key: ArchiveSecurityKey
  ) -> Bool
  func encrypt(_ plaintext: Data, with key: ArchiveSecurityKey, algorithm: SecKeyAlgorithm) throws
    -> Data
  func decrypt(_ ciphertext: Data, with key: ArchiveSecurityKey, algorithm: SecKeyAlgorithm) throws
    -> Data
  func deleteKeys(_ query: [String: Any]) throws
}

struct SystemArchiveKeySecurityProvider: ArchiveKeySecurityProviding {
  func makeAccessControl(accessibility: CFString, flags: SecAccessControlCreateFlags) throws
    -> AnyObject
  {
    var error: Unmanaged<CFError>?
    guard let control = SecAccessControlCreateWithFlags(nil, accessibility, flags, &error) else {
      throw ArchiveKeyLifecycleFailure.accessControlCreationFailed
    }
    return control
  }

  func queryKeys(_ query: [String: Any]) throws -> [ArchiveSecurityKey] {
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess else {
      throw ArchiveKeyLifecycleFailure.keyQueryFailed(status)
    }
    if let keys = result as? [SecKey] {
      return keys.map { ArchiveSecurityKey($0) }
    }
    if let result, CFGetTypeID(result) == SecKeyGetTypeID() {
      let key = unsafeBitCast(result, to: SecKey.self)
      return [ArchiveSecurityKey(key)]
    }
    throw ArchiveKeyLifecycleFailure.keyQueryFailed(errSecInternalError)
  }

  func createKey(_ attributes: [String: Any]) throws -> ArchiveSecurityKey {
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      let status =
        (error?.takeRetainedValue() as Error? as NSError?)?.code ?? Int(errSecInternalError)
      throw ArchiveKeyLifecycleFailure.keyCreationFailed(OSStatus(status))
    }
    return ArchiveSecurityKey(key)
  }

  func publicKey(for privateKey: ArchiveSecurityKey) throws -> ArchiveSecurityKey {
    guard let key = SecKeyCopyPublicKey(privateKey.value as! SecKey) else {
      throw ArchiveKeyLifecycleFailure.keyCreationFailed(errSecInternalError)
    }
    return ArchiveSecurityKey(key)
  }

  func externalRepresentation(of key: ArchiveSecurityKey) throws -> Data {
    var error: Unmanaged<CFError>?
    guard let data = SecKeyCopyExternalRepresentation(key.value as! SecKey, &error) else {
      throw ArchiveKeyLifecycleFailure.keyCreationFailed(errSecInternalError)
    }
    return data as Data
  }

  func supports(
    _ algorithm: SecKeyAlgorithm, operation: SecKeyOperationType, key: ArchiveSecurityKey
  ) -> Bool {
    SecKeyIsAlgorithmSupported(key.value as! SecKey, operation, algorithm)
  }

  func encrypt(_ plaintext: Data, with key: ArchiveSecurityKey, algorithm: SecKeyAlgorithm) throws
    -> Data
  {
    var error: Unmanaged<CFError>?
    guard
      let encrypted = SecKeyCreateEncryptedData(
        key.value as! SecKey, algorithm, plaintext as CFData, &error)
    else {
      throw ArchiveKeyLifecycleFailure.encryptionFailed
    }
    return encrypted as Data
  }

  func decrypt(_ ciphertext: Data, with key: ArchiveSecurityKey, algorithm: SecKeyAlgorithm) throws
    -> Data
  {
    var error: Unmanaged<CFError>?
    guard
      let decrypted = SecKeyCreateDecryptedData(
        key.value as! SecKey, algorithm, ciphertext as CFData, &error)
    else {
      throw ArchiveKeyLifecycleFailure.decryptionFailed
    }
    return decrypted as Data
  }

  func deleteKeys(_ query: [String: Any]) throws {
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw ArchiveKeyLifecycleFailure.keyQueryFailed(status)
    }
  }
}

enum ArchiveLaneOpenPolicy: Equatable {
  case createOrOpen
  case requireExistingKeywrapAllowLaneCreation
  case requireCompleteArchive
}

public final class ArchiveKeyLifecycle: @unchecked Sendable {
  public static let applicationTag = Data(
    "com.evenscribe.room-recorder.archive-wrap-v1".utf8)

  private static let algorithm =
    SecKeyAlgorithm.eciesEncryptionCofactorVariableIVX963SHA256AESGCM
  private let lock = NSLock()
  private let keyTag: Data
  private let security: ArchiveKeySecurityProviding
  private let durableStore: ArchiveKeyDurableStore
  private let applicationSupportRoot: URL
  private let randomBytes: (Int) throws -> Data
  private let reservedLaneStoreOpener:
    (URL, URL, Int32, Int32, Data, ArchiveContext) throws -> ArchiveLaneStore
  private var poisoned = false

  public convenience init() {
    self.init(
      keyTag: Self.applicationTag,
      security: SystemArchiveKeySecurityProvider(),
      durableStore: ArchiveKeyDurableStore(),
      applicationSupportRoot: Self.defaultApplicationSupportRoot,
      randomBytes: secureArchiveRandomBytes,
      reservedLaneStoreOpener: { tapeURL, indexURL, tapeFD, indexFD, rootKey, context in
        try ArchiveLaneStore.openReservedForAppend(
          tapeURL: tapeURL,
          indexURL: indexURL,
          tapeFileDescriptor: tapeFD,
          indexFileDescriptor: indexFD,
          rootKey: rootKey,
          context: context)
      })
  }

  #if ETA_KEYWRAP_PROBE
    public static func probeLifecycle(candidateApplicationTag: String) throws -> ArchiveKeyLifecycle
    {
      let tag = Data(candidateApplicationTag.utf8)
      let prefix = Data("com.evenscribe.room-recorder.archive-wrap-probe.".utf8)
      guard tag.starts(with: prefix), tag != applicationTag, tag.count <= 128 else {
        throw ArchiveKeyLifecycleError.archiveKeyUnavailable
      }
      return ArchiveKeyLifecycle(
        keyTag: tag,
        security: SystemArchiveKeySecurityProvider(),
        durableStore: ArchiveKeyDurableStore(),
        applicationSupportRoot: Self.defaultApplicationSupportRoot,
        randomBytes: secureArchiveRandomBytes,
        reservedLaneStoreOpener: { tapeURL, indexURL, tapeFD, indexFD, rootKey, context in
          try ArchiveLaneStore.openReservedForAppend(
            tapeURL: tapeURL,
            indexURL: indexURL,
            tapeFileDescriptor: tapeFD,
            indexFileDescriptor: indexFD,
            rootKey: rootKey,
            context: context)
        })
    }

    public func openLaneStoreForProbe(
      mode: ArchiveKeywrapProbeOpenMode,
      keywrapURL: URL,
      tapeURL: URL,
      indexURL: URL,
      context: ArchiveContext
    ) throws -> ArchiveLaneStore {
      let policy: ArchiveLaneOpenPolicy
      switch mode {
      case .provision: policy = .createOrOpen
      case .appendFixture: policy = .requireExistingKeywrapAllowLaneCreation
      case .reopenFixture: policy = .requireCompleteArchive
      }
      do {
        return try openLaneStoreDetailed(
          keywrapURL: keywrapURL,
          tapeURL: tapeURL,
          indexURL: indexURL,
          context: context,
          policy: policy)
      } catch let error as ArchiveKeyLifecycleError {
        throw error
      } catch let failure as ArchiveKeyLifecycleFailure {
        switch failure {
        case .algorithmUnavailable, .accessControlCreationFailed, .keyQueryFailed,
          .keyCreationFailed:
          throw ArchiveKeyLifecycleError.secureHardwareUnavailable
        default:
          throw ArchiveKeyLifecycleError.archiveKeyUnavailable
        }
      } catch {
        throw ArchiveKeyLifecycleError.archiveKeyUnavailable
      }
    }

    public func deleteProbeKey() throws {
      do {
        let path = try durableStore.canonicalProvisioningLock(
          applicationSupportRoot: applicationSupportRoot)
        let provisioningLock = try durableStore.acquireGlobalLock(path)
        try withExtendedLifetime(provisioningLock) {
          guard keyTag != Self.applicationTag,
            keyTag.starts(with: Data("com.evenscribe.room-recorder.archive-wrap-probe.".utf8))
          else {
            throw ArchiveKeyLifecycleFailure.keyQueryFailed(errSecParam)
          }
          try security.deleteKeys(keyDeleteQuery)
        }
      } catch let failure as ArchiveKeyLifecycleFailure {
        switch failure {
        case .keyQueryFailed, .keyCreationFailed:
          throw ArchiveKeyLifecycleError.secureHardwareUnavailable
        default:
          throw ArchiveKeyLifecycleError.archiveKeyUnavailable
        }
      } catch {
        throw ArchiveKeyLifecycleError.archiveKeyUnavailable
      }
    }
  #endif

  init(
    keyTag: Data = ArchiveKeyLifecycle.applicationTag,
    security: ArchiveKeySecurityProviding,
    durableStore: ArchiveKeyDurableStore,
    applicationSupportRoot: URL,
    randomBytes: @escaping (Int) throws -> Data,
    reservedLaneStoreOpener:
      @escaping (URL, URL, Int32, Int32, Data, ArchiveContext) throws -> ArchiveLaneStore
  ) {
    self.keyTag = keyTag
    self.security = security
    self.durableStore = durableStore
    self.applicationSupportRoot = applicationSupportRoot
    self.randomBytes = randomBytes
    self.reservedLaneStoreOpener = reservedLaneStoreOpener
  }

  public func openLaneStore(
    keywrapURL: URL,
    tapeURL: URL,
    indexURL: URL,
    context: ArchiveContext,
  ) throws -> ArchiveLaneStore {
    do {
      return try openLaneStoreDetailed(
        keywrapURL: keywrapURL,
        tapeURL: tapeURL,
        indexURL: indexURL,
        context: context)
    } catch let error as ArchiveKeyLifecycleError {
      throw error
    } catch let failure as ArchiveKeyLifecycleFailure {
      switch failure {
      case .algorithmUnavailable, .accessControlCreationFailed, .keyQueryFailed, .keyCreationFailed:
        throw ArchiveKeyLifecycleError.secureHardwareUnavailable
      default:
        throw ArchiveKeyLifecycleError.archiveKeyUnavailable
      }
    } catch {
      throw ArchiveKeyLifecycleError.archiveKeyUnavailable
    }
  }

  public func inspectExistingKeywrap(
    keywrapURL: URL,
    context: ArchiveContext
  ) throws -> ArchiveKeywrapInspection {
    do {
      return try inspectExistingKeywrapDetailed(keywrapURL: keywrapURL, context: context)
    } catch let error as ArchiveKeyLifecycleError {
      throw error
    } catch let failure as ArchiveKeyLifecycleFailure {
      switch failure {
      case .algorithmUnavailable, .keyQueryFailed, .keyCreationFailed:
        throw ArchiveKeyLifecycleError.secureHardwareUnavailable
      default:
        throw ArchiveKeyLifecycleError.archiveKeyUnavailable
      }
    } catch {
      throw ArchiveKeyLifecycleError.archiveKeyUnavailable
    }
  }

  public static func inspectKeywrap(at url: URL) throws -> ArchiveKeywrapInspection {
    do {
      let store = ArchiveKeyDurableStore()
      let path = try ArchiveValidatedKeyPaths.resolve(url, hooks: store.hooks)
      guard let held = try store.loadKeywrapIfExists(path) else {
        throw ArchiveKeyLifecycleFailure.fileOpenFailed(errno: ENOENT)
      }
      let outer = try ArchiveKeywrapCodec.decode(held.bytes)
      return inspection(outer)
    } catch {
      throw ArchiveKeyLifecycleError.archiveKeyUnavailable
    }
  }

  func openLaneStoreDetailed(
    keywrapURL: URL,
    tapeURL: URL,
    indexURL: URL,
    context: ArchiveContext,
    policy: ArchiveLaneOpenPolicy = .createOrOpen
  ) throws -> ArchiveLaneStore {
    try lock.withLock {
      guard !poisoned else { throw ArchiveKeyLifecycleFailure.ownerPoisoned }
      let paths = try ArchiveValidatedKeyPaths(
        keywrapURL: keywrapURL,
        tapeURL: tapeURL,
        indexURL: indexURL,
        hooks: durableStore.hooks)
      let provisioningLockPath = try durableStore.canonicalProvisioningLock(
        applicationSupportRoot: applicationSupportRoot)
      let provisioningLock = try durableStore.acquireGlobalLock(provisioningLockPath)
      return try withExtendedLifetime(provisioningLock) {
        let contextHash = try context.sha256()
        var reservation: ArchiveLaneReservation?
        do {
          var heldWrap = try durableStore.loadKeywrapIfExists(paths.keywrap)
          let tapeIdentity = try durableStore.existingArtifactIdentity(paths.tape)
          let indexIdentity = try durableStore.existingArtifactIdentity(paths.index)
          let existingIdentities = [heldWrap?.identity, tapeIdentity, indexIdentity].compactMap {
            $0
          }
          guard Set(existingIdentities).count == existingIdentities.count else {
            throw ArchiveKeyLifecycleFailure.pathAlias
          }

          if heldWrap == nil {
            guard policy == .createOrOpen else {
              throw ArchiveKeyLifecycleFailure.existingArchiveWithoutKeywrap
            }
            guard tapeIdentity == nil, indexIdentity == nil else {
              throw ArchiveKeyLifecycleFailure.existingArchiveWithoutKeywrap
            }
            reservation = try durableStore.reserveLanePair(
              tape: paths.tape, index: paths.index, expectedIdentities: nil)
          } else {
            guard (tapeIdentity == nil) == (indexIdentity == nil) else {
              throw ArchiveKeyLifecycleFailure.laneStoreOpenFailed
            }
            if tapeIdentity == nil {
              guard policy != .requireCompleteArchive else {
                throw ArchiveKeyLifecycleFailure.laneStoreOpenFailed
              }
              reservation = try durableStore.reserveLanePair(
                tape: paths.tape, index: paths.index, expectedIdentities: nil)
            } else {
              reservation = try durableStore.reserveLanePair(
                tape: paths.tape,
                index: paths.index,
                expectedIdentities: (tapeIdentity!, indexIdentity!))
            }
          }

          let key = try resolvePrivateKey(allowCreation: heldWrap == nil)
          let rootKey: Data
          if let heldWrap {
            rootKey = try unwrap(
              heldWrap.bytes, privateKey: key, context: context, contextHash: contextHash)
          } else {
            let candidateRoot = try exactRandomBytes(32)
            let wrapID = try exactRandomBytes(16)
            let encoded = try wrap(
              rootKey: candidateRoot,
              wrapID: wrapID,
              privateKey: key,
              context: context,
              contextHash: contextHash)
            do {
              switch try durableStore.publishCreateOnly(encoded, at: paths.keywrap) {
              case .published(let published):
                heldWrap = published
                rootKey = candidateRoot
              case .alreadyExists(let raced):
                heldWrap = raced
                rootKey = try unwrap(
                  raced.bytes, privateKey: key, context: context, contextHash: contextHash)
              }
            } catch ArchiveKeyLifecycleFailure.publicationUncertain {
              poisoned = true
              throw ArchiveKeyLifecycleFailure.publicationUncertain
            }
          }
          return try withExtendedLifetime(heldWrap) {
            guard let reservation else {
              throw ArchiveKeyLifecycleFailure.laneStoreOpenFailed
            }
            try reservation.validateForHandoff()
            let store = try reservedLaneStoreOpener(
              paths.tape.url,
              paths.index.url,
              reservation.tapeDescriptor,
              reservation.indexDescriptor,
              rootKey,
              context)
            reservation.completeHandoff()
            return store
          }
        } catch {
          if let reservation {
            do {
              try reservation.cleanup()
            } catch let cleanupFailure as ArchiveKeyLifecycleFailure {
              throw cleanupFailure
            } catch {
              throw ArchiveKeyLifecycleFailure.reservationCleanupFailed(errno: EIO)
            }
          }
          if let failure = error as? ArchiveKeyLifecycleFailure { throw failure }
          throw ArchiveKeyLifecycleFailure.laneStoreOpenFailed
        }
      }
    }
  }

  func inspectExistingKeywrapDetailed(
    keywrapURL: URL,
    context: ArchiveContext
  ) throws -> ArchiveKeywrapInspection {
    try lock.withLock {
      guard !poisoned else { throw ArchiveKeyLifecycleFailure.ownerPoisoned }
      let keywrap = try ArchiveValidatedKeyPaths.resolve(keywrapURL, hooks: durableStore.hooks)
      let provisioningLockPath = try durableStore.canonicalProvisioningLock(
        applicationSupportRoot: applicationSupportRoot)
      let provisioningLock = try durableStore.acquireGlobalLock(provisioningLockPath)
      return try withExtendedLifetime(provisioningLock) {
        guard let heldWrap = try durableStore.loadKeywrapIfExists(keywrap) else {
          throw ArchiveKeyLifecycleFailure.existingArchiveWithoutKeywrap
        }
        let outer = try ArchiveKeywrapCodec.decode(heldWrap.bytes)
        let key = try resolvePrivateKey(allowCreation: false)
        let rootKey = try unwrap(
          heldWrap.bytes,
          privateKey: key,
          context: context,
          contextHash: try context.sha256())
        return withExtendedLifetime(rootKey) { Self.inspection(outer) }
      }
    }
  }

  private static var defaultApplicationSupportRoot: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library", isDirectory: true)
      .appendingPathComponent("Application Support", isDirectory: true)
  }

  private static func inspection(_ outer: ArchiveKeywrapOuter) -> ArchiveKeywrapInspection {
    ArchiveKeywrapInspection(
      formatVersion: ArchiveKeywrapCodec.formatVersion,
      algorithmID: ArchiveKeywrapCodec.algorithmID,
      streamUUIDHex: outer.streamUUID.keyHex,
      contextHashHex: outer.contextHash.keyHex,
      publicKeyHashHex: outer.publicKeyHash.keyHex,
      wrappedByteCount: UInt32(outer.wrappedData.count))
  }

  private func resolvePrivateKey(allowCreation: Bool) throws -> ArchiveSecurityKey {
    let query = keyQuery
    let initial = try security.queryKeys(query)
    if initial.count == 1 { return initial[0] }
    guard initial.isEmpty else {
      throw ArchiveKeyLifecycleFailure.multipleTaggedKeys(initial.count)
    }
    guard allowCreation else {
      throw ArchiveKeyLifecycleFailure.keyMissingForExistingArchive
    }

    let accessControl = try security.makeAccessControl(
      accessibility: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      flags: [.privateKeyUsage])
    _ = try security.createKey(keyCreationAttributes(accessControl: accessControl))
    let resolved = try security.queryKeys(query)
    guard resolved.count == 1 else {
      if resolved.isEmpty { throw ArchiveKeyLifecycleFailure.keyCreationFailed(errSecItemNotFound) }
      throw ArchiveKeyLifecycleFailure.multipleTaggedKeys(resolved.count)
    }
    return resolved[0]
  }

  private func wrap(
    rootKey: Data,
    wrapID: Data,
    privateKey: ArchiveSecurityKey,
    context: ArchiveContext,
    contextHash: Data
  ) throws -> Data {
    let publicKey = try security.publicKey(for: privateKey)
    let representation = try security.externalRepresentation(of: publicKey)
    guard representation.count == 65 else {
      throw ArchiveKeyLifecycleFailure.invalidPublicKeyRepresentationLength(representation.count)
    }
    guard security.supports(Self.algorithm, operation: .encrypt, key: publicKey) else {
      throw ArchiveKeyLifecycleFailure.algorithmUnavailable
    }
    let plaintext = try ArchiveKeywrapPlaintextCodec.encode(
      ArchiveKeywrapPlaintext(
        rootKey: rootKey,
        streamUUID: context.streamUUID,
        contextHash: contextHash,
        wrapID: wrapID))
    let wrapped = try security.encrypt(plaintext, with: publicKey, algorithm: Self.algorithm)
    guard !wrapped.isEmpty else { throw ArchiveKeyLifecycleFailure.emptyWrappedData }
    guard wrapped.count <= ArchiveKeywrapCodec.maximumWrappedByteCount else {
      throw ArchiveKeyLifecycleFailure.wrappedDataTooLarge(UInt32(wrapped.count))
    }
    return try ArchiveKeywrapCodec.encode(
      ArchiveKeywrapOuter(
        streamUUID: context.streamUUID,
        contextHash: contextHash,
        publicKeyHash: Data(SHA256.hash(data: representation)),
        wrappedData: wrapped))
  }

  private func unwrap(
    _ encoded: Data,
    privateKey: ArchiveSecurityKey,
    context: ArchiveContext,
    contextHash: Data
  ) throws -> Data {
    let outer = try ArchiveKeywrapCodec.decode(encoded)
    guard outer.streamUUID == context.streamUUID else {
      throw ArchiveKeyLifecycleFailure.streamUUIDMismatch
    }
    guard outer.contextHash == contextHash else {
      throw ArchiveKeyLifecycleFailure.contextHashMismatch
    }
    let publicKey = try security.publicKey(for: privateKey)
    let representation = try security.externalRepresentation(of: publicKey)
    guard representation.count == 65 else {
      throw ArchiveKeyLifecycleFailure.invalidPublicKeyRepresentationLength(representation.count)
    }
    guard Data(SHA256.hash(data: representation)) == outer.publicKeyHash else {
      throw ArchiveKeyLifecycleFailure.publicKeyHashMismatch
    }
    guard security.supports(Self.algorithm, operation: .decrypt, key: privateKey) else {
      throw ArchiveKeyLifecycleFailure.algorithmUnavailable
    }
    let decrypted = try security.decrypt(
      outer.wrappedData, with: privateKey, algorithm: Self.algorithm)
    let plaintext = try ArchiveKeywrapPlaintextCodec.decode(decrypted)
    guard plaintext.streamUUID == outer.streamUUID,
      plaintext.streamUUID == context.streamUUID
    else {
      throw ArchiveKeyLifecycleFailure.streamUUIDMismatch
    }
    guard plaintext.contextHash == outer.contextHash,
      plaintext.contextHash == contextHash
    else {
      throw ArchiveKeyLifecycleFailure.contextHashMismatch
    }
    return plaintext.rootKey
  }

  private func exactRandomBytes(_ count: Int) throws -> Data {
    let bytes = try randomBytes(count)
    guard bytes.count == count else {
      throw ArchiveKeyLifecycleFailure.invalidFieldLength(
        field: "secure_random", expected: count, actual: bytes.count)
    }
    return bytes
  }

  var keyQuery: [String: Any] {
    [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: keyTag,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
      kSecUseDataProtectionKeychain as String: true,
      kSecReturnRef as String: true,
      kSecMatchLimit as String: kSecMatchLimitAll,
    ]
  }

  #if ETA_KEYWRAP_PROBE
    private var keyDeleteQuery: [String: Any] {
      [
        kSecClass as String: kSecClassKey,
        kSecAttrApplicationTag as String: keyTag,
        kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
        kSecUseDataProtectionKeychain as String: true,
      ]
    }
  #endif

  func keyCreationAttributes(accessControl: AnyObject) -> [String: Any] {
    [
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: keyTag,
        kSecAttrAccessControl as String: accessControl,
      ],
    ]
  }
}

private func secureArchiveRandomBytes(count: Int) throws -> Data {
  var bytes = [UInt8](repeating: 0, count: count)
  let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
  guard status == errSecSuccess else {
    throw ArchiveKeyLifecycleFailure.randomGenerationFailed(status)
  }
  return Data(bytes)
}

extension Data {
  fileprivate mutating func appendKeyLittleEndian<T: FixedWidthInteger>(_ value: T) {
    for index in 0..<MemoryLayout<T>.size {
      append(UInt8(truncatingIfNeeded: value >> T(index * 8)))
    }
  }

  fileprivate func keyBytes(_ range: Range<Int>) -> Data {
    let lower = index(startIndex, offsetBy: range.lowerBound)
    let upper = index(startIndex, offsetBy: range.upperBound)
    return Data(self[lower..<upper])
  }

  fileprivate func keyUInt16(at offset: Int) -> UInt16 {
    let first = self[index(startIndex, offsetBy: offset)]
    let second = self[index(startIndex, offsetBy: offset + 1)]
    return UInt16(first) | UInt16(second) << 8
  }

  fileprivate func keyUInt32(at offset: Int) -> UInt32 {
    (0..<4).reduce(UInt32(0)) { result, index in
      result
        | UInt32(self[self.index(startIndex, offsetBy: offset + index)]) << UInt32(index * 8)
    }
  }

  fileprivate var keyHex: String {
    map { String(format: "%02x", $0) }.joined()
  }
}
