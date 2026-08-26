import Foundation
import Synchronization
import Testing

@testable import TapeCore

@Suite struct ArchiveCryptoP1Tests {
  private let rootKey = hexData("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
  private let streamUUID = hexData("00112233445566778899aabbccddeeff")
  private let contextHash = hexData(
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f")
  private let fixedNonce = hexData("000102030405060708090a0b")
  private let plaintext = hexData("01000200ff7f0080")

  @Test func archive02FreezesEveryPurposeHKDFKey() throws {
    let expected: [(ArchiveRecordPurpose, String)] = [
      (.tape, "1b42df84247cb5a9825746f45d46fb86c91ecd952ae6e817310fd3ccfbfb934f"),
      (.index, "d6a0b73c1f1b18930f6ab84b0aee78728576b672346830c9e355101eba05af15"),
      (.journal, "a4ca3107f4cf6d8a9e4c189f9f6832f6c6ab6152cfff450f5b0a36331260eb36"),
      (.control, "f42043e07e5b3787d79bec6ed1e47373897bc31a5c91fccc7c4351e0ca217950"),
      (.level, "e7aecbacad17d74935f50fcc0b62c133e6bf7755f607525a16e1b6b5f4d78d78"),
      (.manifest, "18dd2e3e8ee554b9b72ec74cbc73a29a5c464de1d92d75a5ab9c68c33fde5fe9"),
      (.spool, "f425f8e0824c64224230686e7f5f3efcc269a705c24166a05f4a68491e6e5964"),
    ]

    var derived = Set<Data>()
    for (purpose, keyHex) in expected {
      let key = try ArchiveRecordCrypto.derivedPurposeKeyBytesForTesting(
        rootKey: rootKey, streamUUID: streamUUID, purpose: purpose)
      #expect(key == hexData(keyHex))
      derived.insert(key)
    }
    #expect(derived.count == ArchiveRecordPurpose.allCases.count)
  }

  @Test func archive02SealsAndOpensTheIndependentGoldenRecord() throws {
    let sealer = try fixedNonceSealer()
    let envelope = try sealer.seal(plaintext, request: request())
    let encoded = try ArchiveEnvelopeCodec.encodeUnauthenticated(envelope)

    #expect(
      encoded
        == hexData(
          "4554415441503031010080000000000000112233445566778899aabbccddeeff010000000000000000000000000000000400000008000000000102030405060708090a0b00000000000000000000000000000000202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f0100010000000000000000005cda39e6798185fefb88a4d71cd12469364d21fd9befa9b8"
        ))
    #expect(envelope.ciphertext == hexData("5cda39e6798185fe"))
    #expect(envelope.authenticationTag == hexData("fb88a4d71cd12469364d21fd9befa9b8"))
    #expect(sealer.sealedRecordCount == 1)

    let opened = try ArchiveRecordCrypto.open(
      encoded,
      rootKey: rootKey,
      expectedPurpose: .tape,
      expectedContextHash: contextHash
    )
    #expect(opened.plaintext == plaintext)
    #expect(opened.header == envelope.header)
  }

  @Test func archive02RejectsWrongKeyAndAuthenticatedByteTampering() throws {
    let envelope = try fixedNonceSealer().seal(plaintext, request: request())
    let valid = try ArchiveEnvelopeCodec.encodeUnauthenticated(envelope)

    #expect(throws: ArchiveCryptoError.authenticationFailed) {
      try ArchiveRecordCrypto.open(
        valid,
        rootKey: Data(repeating: 0xFF, count: 32),
        expectedPurpose: .tape,
        expectedContextHash: contextHash
      )
    }

    for offset in [32, 128, valid.count - 1] {
      var tampered = valid
      tampered[offset] ^= 0x01
      #expect(throws: ArchiveCryptoError.authenticationFailed) {
        try ArchiveRecordCrypto.open(
          tampered,
          rootKey: rootKey,
          expectedPurpose: .tape,
          expectedContextHash: contextHash
        )
      }
    }
  }

  @Test func archive02RejectsPurposeAndContextSubstitutionBeforeOpening() throws {
    let encoded = try ArchiveEnvelopeCodec.encodeUnauthenticated(
      fixedNonceSealer().seal(plaintext, request: request()))

    #expect(throws: ArchiveEnvelopeError.wrongPurpose(expected: .index, actual: .tape)) {
      try ArchiveRecordCrypto.open(
        encoded,
        rootKey: rootKey,
        expectedPurpose: .index,
        expectedContextHash: contextHash
      )
    }
    #expect(throws: ArchiveEnvelopeError.contextMismatch) {
      try ArchiveRecordCrypto.open(
        encoded,
        rootKey: rootKey,
        expectedPurpose: .tape,
        expectedContextHash: Data(repeating: 0xFF, count: 32)
      )
    }

    var purposeSubstitution = encoded
    purposeSubstitution.replaceSubrange(0..<8, with: Data("ETAIDX01".utf8))
    purposeSubstitution[118] = 2
    #expect(throws: ArchiveCryptoError.authenticationFailed) {
      try ArchiveRecordCrypto.open(
        purposeSubstitution,
        rootKey: rootKey,
        expectedPurpose: .index,
        expectedContextHash: contextHash
      )
    }

    var contextSubstitution = encoded
    contextSubstitution[84] ^= 0x01
    let substitutedContextHash = Data(contextSubstitution[84..<116])
    #expect(throws: ArchiveCryptoError.authenticationFailed) {
      try ArchiveRecordCrypto.open(
        contextSubstitution,
        rootKey: rootKey,
        expectedPurpose: .tape,
        expectedContextHash: substitutedContextHash
      )
    }
  }

  @Test func archive02EnforcesThePerPurposeRecordCap() throws {
    let sealer = try fixedNonceSealer(
      existingRecordCount: ArchivePurposeSealer.maximumRecordsPerPurposeKey - 1)

    _ = try sealer.seal(plaintext, request: request())
    #expect(
      sealer.sealedRecordCount == ArchivePurposeSealer.maximumRecordsPerPurposeKey)
    #expect(
      throws: ArchiveCryptoError.recordLimitReached(
        ArchivePurposeSealer.maximumRecordsPerPurposeKey)
    ) {
      try sealer.seal(plaintext, request: request(recordSequence: 2))
    }
  }

  @Test func archive02DoesNotConsumeTheCapOnNonceFailure() throws {
    let sealer = try ArchivePurposeSealer(
      purpose: .tape,
      rootKey: rootKey,
      streamUUID: streamUUID,
      nonceProvider: { throw ArchiveCryptoError.nonceGenerationFailed(-1) }
    )

    #expect(throws: ArchiveCryptoError.nonceGenerationFailed(-1)) {
      try sealer.seal(plaintext, request: request())
    }
    #expect(sealer.sealedRecordCount == 0)
  }

  @Test func archive02RejectsInvalidKeysUUIDsNoncesAndExistingCounts() throws {
    #expect(throws: ArchiveCryptoError.invalidRootKeyLength(31)) {
      try ArchivePurposeSealer(
        purpose: .tape,
        rootKey: Data(repeating: 0, count: 31),
        streamUUID: streamUUID
      )
    }
    #expect(throws: ArchiveCryptoError.invalidStreamUUIDLength(15)) {
      try ArchivePurposeSealer(
        purpose: .tape,
        rootKey: rootKey,
        streamUUID: Data(repeating: 0, count: 15)
      )
    }
    #expect(
      throws: ArchiveCryptoError.existingRecordCountExceedsLimit(
        ArchivePurposeSealer.maximumRecordsPerPurposeKey + 1)
    ) {
      try ArchivePurposeSealer(
        purpose: .tape,
        rootKey: rootKey,
        streamUUID: streamUUID,
        existingRecordCount: ArchivePurposeSealer.maximumRecordsPerPurposeKey + 1
      )
    }

    let shortNonceSealer = try ArchivePurposeSealer(
      purpose: .tape,
      rootKey: rootKey,
      streamUUID: streamUUID,
      nonceProvider: { Data(repeating: 0, count: 11) }
    )
    #expect(throws: ArchiveCryptoError.invalidNonceLength(11)) {
      try shortNonceSealer.seal(plaintext, request: request())
    }
    #expect(shortNonceSealer.sealedRecordCount == 0)
  }

  @Test func archive02ProductionNoncePathProducesAnOpenableRecord() throws {
    let sealer = try ArchivePurposeSealer(
      purpose: .tape, rootKey: rootKey, streamUUID: streamUUID)
    let envelope = try sealer.seal(plaintext, request: request())
    #expect(envelope.header.nonce.count == 12)

    let encoded = try ArchiveEnvelopeCodec.encodeUnauthenticated(envelope)
    let opened = try ArchiveRecordCrypto.open(
      encoded,
      rootKey: rootKey,
      expectedPurpose: .tape,
      expectedContextHash: contextHash
    )
    #expect(opened.plaintext == plaintext)
  }

  @Test func archive02SerializesConcurrentSealsAndCapOnOnePurposeKey() throws {
    let sealer = try ArchivePurposeSealer(
      purpose: .tape,
      rootKey: rootKey,
      streamUUID: streamUUID,
      existingRecordCount: ArchivePurposeSealer.maximumRecordsPerPurposeKey - 32
    )
    let successes = Atomic<Int>(0)
    let capRefusals = Atomic<Int>(0)
    let unexpectedFailures = Atomic<Int>(0)

    DispatchQueue.concurrentPerform(iterations: 64) { sequence in
      do {
        _ = try sealer.seal(
          plaintext,
          request: request(recordSequence: UInt64(sequence + 1))
        )
        _ = successes.wrappingAdd(1, ordering: .relaxed)
      } catch ArchiveCryptoError.recordLimitReached(
        ArchivePurposeSealer.maximumRecordsPerPurposeKey
      ) {
        _ = capRefusals.wrappingAdd(1, ordering: .relaxed)
      } catch {
        _ = unexpectedFailures.wrappingAdd(1, ordering: .relaxed)
      }
    }

    #expect(successes.load(ordering: .relaxed) == 32)
    #expect(capRefusals.load(ordering: .relaxed) == 32)
    #expect(unexpectedFailures.load(ordering: .relaxed) == 0)
    #expect(
      sealer.sealedRecordCount == ArchivePurposeSealer.maximumRecordsPerPurposeKey)
  }

  private func fixedNonceSealer(existingRecordCount: UInt64 = 0) throws
    -> ArchivePurposeSealer
  {
    try ArchivePurposeSealer(
      purpose: .tape,
      rootKey: rootKey,
      streamUUID: streamUUID,
      existingRecordCount: existingRecordCount,
      nonceProvider: { fixedNonce }
    )
  }

  private func request(recordSequence: UInt64 = 1) -> ArchiveRecordSealRequest {
    ArchiveRecordSealRequest(
      recordSequence: recordSequence,
      firstLogicalUnit: 0,
      logicalUnitCount: 4,
      previousCommittedTag: Data(repeating: 0, count: 16),
      contextHash: contextHash
    )
  }
}

private func hexData(_ hex: String) -> Data {
  precondition(hex.count.isMultiple(of: 2))
  var result = Data()
  result.reserveCapacity(hex.count / 2)
  var index = hex.startIndex
  while index < hex.endIndex {
    let next = hex.index(index, offsetBy: 2)
    result.append(UInt8(hex[index..<next], radix: 16)!)
    index = next
  }
  return result
}
