import Darwin
import Foundation
import Synchronization
import Testing

@testable import TapeCore

@Suite(.serialized) struct ArchivePersistenceP1Tests {
  private let rootKey = persistenceHex(
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
  private let streamUUID = persistenceHex("00112233445566778899aabbccddeeff")
  private let contextHash = persistenceHex(
    "4776785c037085566905aa531bc701b0219c5950076cd21c433df74a8eccd028")
  private let firstPlaintext = persistenceHex("01000200ff7f0080")
  private let secondPlaintext = persistenceHex("03000400")
  private let firstTag = persistenceHex("5c0b8c5c789140a3c901f0d90cfbf55c")
  private let secondTag = persistenceHex("51a6835fa3a1de005a5a85d6d88ceb60")
  private let firstRecordByteCount = 152

  private var context: ArchiveContext {
    ArchiveContext(
      streamUUID: streamUUID,
      roomID: "room_1",
      istDate: "2026-08-26",
      laneID: "primary",
      stableDeviceUID: "AppleUSBAudioEngine:test"
    )
  }

  @Test func archive03PersistsTheIndependentTwoRecordChainExactly() throws {
    let fixture = try temporaryFixture("golden")
    defer { fixture.remove() }
    let nonces = PersistenceNonceQueue([
      persistenceHex("000102030405060708090a0b"),
      persistenceHex("0c0d0e0f1011121314151617"),
    ])
    let store = try openStore(fixture.url, nonces: nonces)

    let first = try store.appendPCM(firstPlaintext)
    let second = try store.appendPCM(secondPlaintext)
    store.close()

    #expect(first.header.recordSequence == 1)
    #expect(first.encryptedStartOffset == 0)
    #expect(first.encryptedEndOffset == UInt64(firstRecordByteCount))
    #expect(second.header.recordSequence == 2)
    #expect(second.header.firstLogicalUnit == 4)
    #expect(second.header.previousCommittedTag == firstTag)
    #expect(second.authenticationTag == secondTag)
    #expect(second.encryptedEndOffset == UInt64(independentChain.count))
    #expect(try Data(contentsOf: fixture.url) == independentChain)

    let scan = try ArchiveTapeStore.inspect(
      url: fixture.url, rootKey: rootKey, context: context)
    #expect(scan.records == [first, second])
    #expect(scan.completeByteCount == UInt64(independentChain.count))
    #expect(scan.incompleteTrailingByteCount == 0)
  }

  @Test func archive03ReopensFromTheAuthenticatedCheckpointAndContinues() throws {
    let fixture = try chainFixture("reopen")
    defer { fixture.remove() }
    let scan = try ArchiveTapeStore.inspect(
      url: fixture.url, rootKey: rootKey, context: context)
    let nonce = PersistenceNonceQueue([persistenceHex("18191a1b1c1d1e1f20212223")])
    let store = try openStore(
      fixture.url, indexedCheckpoint: scan.records[1].checkpoint, nonces: nonce)

    #expect(store.unindexedRecords.isEmpty)
    #expect(store.sealerRecordCountForTesting == 2)
    let third = try store.appendPCM(persistenceHex("0500"))
    #expect(third.header.recordSequence == 3)
    #expect(third.header.firstLogicalUnit == 6)
    #expect(third.header.previousCommittedTag == secondTag)
    #expect(store.sealerRecordCountForTesting == 3)
    store.close()

    let reopened = try ArchiveTapeStore.inspect(
      url: fixture.url, rootKey: rootKey, context: context)
    #expect(reopened.records.count == 3)
    #expect(reopened.records[2] == third)
  }

  @Test func archive03FailsWrongKeysContextsAndStreamUUIDsWithoutMutation() throws {
    let fixture = try chainFixture("identity")
    defer { fixture.remove() }
    let original = try Data(contentsOf: fixture.url)

    #expect(throws: ArchiveCryptoError.authenticationFailed) {
      try ArchiveTapeStore.inspect(
        url: fixture.url,
        rootKey: Data(repeating: 0xFF, count: 32),
        context: context
      )
    }
    var wrongContext = context
    wrongContext = ArchiveContext(
      streamUUID: streamUUID,
      roomID: "room_2",
      istDate: wrongContext.istDate,
      laneID: wrongContext.laneID,
      stableDeviceUID: wrongContext.stableDeviceUID
    )
    #expect(throws: ArchiveEnvelopeError.contextMismatch) {
      try ArchiveTapeStore.inspect(url: fixture.url, rootKey: rootKey, context: wrongContext)
    }

    let alternateUUID = Data(repeating: 0x44, count: 16)
    let first = try encodedRecord(
      streamUUID: alternateUUID,
      sequence: 1,
      firstLogicalUnit: 0,
      plaintext: firstPlaintext,
      nonce: persistenceHex("303132333435363738393a3b"),
      predecessor: Data(repeating: 0, count: 16)
    )
    try first.write(to: fixture.url)
    #expect(throws: ArchiveTapePersistenceError.streamUUIDMismatch) {
      try ArchiveTapeStore.inspect(url: fixture.url, rootKey: rootKey, context: context)
    }
    #expect(try Data(contentsOf: fixture.url) == first)

    try original.write(to: fixture.url)
    #expect(try Data(contentsOf: fixture.url) == original)
  }

  @Test func archive03RejectsAuthenticatedChainViolations() throws {
    let fixture = try temporaryFixture("chain-violations")
    defer { fixture.remove() }
    let first = Data(independentChain.prefix(firstRecordByteCount))

    let cases: [(Data, ArchiveTapePersistenceError)] = [
      (
        try encodedRecord(
          sequence: 1,
          firstLogicalUnit: 4,
          plaintext: secondPlaintext,
          nonce: persistenceHex("404142434445464748494a4b"),
          predecessor: firstTag
        ),
        .sequenceDiscontinuity(expected: 2, actual: 1)
      ),
      (
        try encodedRecord(
          sequence: 2,
          firstLogicalUnit: 3,
          plaintext: secondPlaintext,
          nonce: persistenceHex("505152535455565758595a5b"),
          predecessor: firstTag
        ),
        .logicalDiscontinuity(expected: 4, actual: 3)
      ),
      (
        try encodedRecord(
          sequence: 2,
          firstLogicalUnit: 4,
          plaintext: secondPlaintext,
          nonce: persistenceHex("606162636465666768696a6b"),
          predecessor: Data(repeating: 0, count: 16)
        ),
        .predecessorMismatch(sequence: 2)
      ),
      (
        try encodedRecord(
          sequence: 3,
          firstLogicalUnit: 4,
          plaintext: secondPlaintext,
          nonce: persistenceHex("707172737475767778797a7b"),
          predecessor: firstTag
        ),
        .sequenceDiscontinuity(expected: 2, actual: 3)
      ),
    ]

    for (record, expectedError) in cases {
      let bytes = first + record
      try bytes.write(to: fixture.url)
      do {
        _ = try ArchiveTapeStore.inspect(url: fixture.url, rootKey: rootKey, context: context)
        Issue.record("accepted authenticated chain violation: \(expectedError)")
      } catch let error as ArchiveTapePersistenceError {
        #expect(error == expectedError)
      }
      #expect(try Data(contentsOf: fixture.url) == bytes)
    }
  }

  @Test func archive03ReportsAndRepairsOnlyIncompleteFinalRecords() throws {
    let cuts = [
      64,
      firstRecordByteCount + 64,
      firstRecordByteCount + 130,
      independentChain.count - 1,
    ]
    for cut in cuts {
      let fixture = try temporaryFixture("torn-\(cut)")
      defer { fixture.remove() }
      let torn = Data(independentChain.prefix(cut))
      try torn.write(to: fixture.url)

      let readOnly = try ArchiveTapeStore.inspect(
        url: fixture.url, rootKey: rootKey, context: context)
      let completeCount = cut < firstRecordByteCount ? 0 : firstRecordByteCount
      #expect(readOnly.completeByteCount == UInt64(completeCount))
      #expect(readOnly.incompleteTrailingByteCount == UInt64(cut - completeCount))
      #expect(try Data(contentsOf: fixture.url) == torn)

      let checkpoint = completeCount == 0 ? nil : firstCheckpoint
      let store = try openStore(fixture.url, indexedCheckpoint: checkpoint)
      #expect(store.repairedTrailingByteCount == UInt64(cut - completeCount))
      store.close()
      #expect(try Data(contentsOf: fixture.url) == independentChain.prefix(completeCount))
    }
  }

  @Test func archive03NeverRepairsACompleteInvalidFinalOrInteriorRecord() throws {
    let fixture = try chainFixture("complete-corruption")
    defer { fixture.remove() }

    var invalidFinal = independentChain
    invalidFinal[invalidFinal.count - 1] ^= 0x01
    try invalidFinal.write(to: fixture.url)
    #expect(throws: ArchiveCryptoError.authenticationFailed) {
      try ArchiveTapeStore.openRecoveringForAppend(
        url: fixture.url, rootKey: rootKey, context: context)
    }
    #expect(try Data(contentsOf: fixture.url) == invalidFinal)

    let third = try encodedRecord(
      sequence: 3,
      firstLogicalUnit: 6,
      plaintext: persistenceHex("0500"),
      nonce: persistenceHex("808182838485868788898a8b"),
      predecessor: secondTag
    )
    var invalidInterior = independentChain + third
    invalidInterior[firstRecordByteCount + 128] ^= 0x01
    try invalidInterior.write(to: fixture.url)
    #expect(throws: ArchiveCryptoError.authenticationFailed) {
      try ArchiveTapeStore.openRecoveringForAppend(
        url: fixture.url, rootKey: rootKey, context: context)
    }
    #expect(try Data(contentsOf: fixture.url) == invalidInterior)
  }

  @Test func archive03RequiresAnExactIndexedCheckpointBeforeStartupAppend() throws {
    let fixture = try chainFixture("checkpoint")
    defer { fixture.remove() }

    let noCheckpoint = try openStore(fixture.url)
    #expect(noCheckpoint.unindexedRecords.count == 2)
    #expect(throws: ArchiveTapePersistenceError.startupRecordsRequireIndex(2)) {
      try noCheckpoint.appendPCM(persistenceHex("0500"))
    }
    noCheckpoint.close()

    let firstOnly = try openStore(fixture.url, indexedCheckpoint: firstCheckpoint)
    #expect(firstOnly.unindexedRecords.map(\.header.recordSequence) == [2])
    #expect(throws: ArchiveTapePersistenceError.startupRecordsRequireIndex(1)) {
      try firstOnly.appendPCM(persistenceHex("0500"))
    }
    firstOnly.close()

    for checkpoint in [
      ArchiveTapeCheckpoint(
        recordSequence: 2,
        authenticationTag: Data(repeating: 0, count: 16),
        encryptedEndOffset: UInt64(independentChain.count)
      ),
      ArchiveTapeCheckpoint(
        recordSequence: 2,
        authenticationTag: secondTag,
        encryptedEndOffset: UInt64(independentChain.count - 1)
      ),
    ] {
      #expect(throws: ArchiveTapePersistenceError.indexedCheckpointMismatch(2)) {
        try ArchiveTapeStore.openRecoveringForAppend(
          url: fixture.url,
          rootKey: rootKey,
          context: context,
          indexedCheckpoint: checkpoint
        )
      }
    }
    #expect(throws: ArchiveTapePersistenceError.indexedCheckpointNotFound(3)) {
      try ArchiveTapeStore.openRecoveringForAppend(
        url: fixture.url,
        rootKey: rootKey,
        context: context,
        indexedCheckpoint: ArchiveTapeCheckpoint(
          recordSequence: 3,
          authenticationTag: Data(repeating: 0, count: 16),
          encryptedEndOffset: UInt64(independentChain.count)
        )
      )
    }
  }

  @Test func archive03RetriesEINTRAndShortWrites() throws {
    let fixture = try temporaryFixture("short-write")
    defer { fixture.remove() }
    let writePlan = PersistenceShortWritePlan()
    let syncPlan = PersistenceInterruptedSyncPlan()
    var hooks = ArchiveTapePersistenceHooks()
    hooks.write = { fileDescriptor, pointer, count in
      writePlan.write(fileDescriptor: fileDescriptor, pointer: pointer, count: count)
    }
    hooks.fullSync = { fileDescriptor in syncPlan.fullSync(fileDescriptor) }
    let store = try openStore(
      fixture.url,
      hooks: hooks,
      nonces: PersistenceNonceQueue([persistenceHex("000102030405060708090a0b")])
    )

    _ = try store.appendPCM(firstPlaintext)
    store.close()
    #expect(writePlan.calls > 2)
    #expect(syncPlan.calls == 2)
    #expect(try Data(contentsOf: fixture.url) == independentChain.prefix(firstRecordByteCount))
  }

  @Test func archive03RetriesEINTRAndShortReads() throws {
    let fixture = try chainFixture("short-read")
    defer { fixture.remove() }
    let readPlan = PersistenceShortReadPlan()
    var hooks = ArchiveTapePersistenceHooks()
    hooks.pread = { fileDescriptor, pointer, count, offset in
      readPlan.read(
        fileDescriptor: fileDescriptor, pointer: pointer, count: count, offset: offset)
    }

    let scan = try ArchiveTapeStore.inspect(
      url: fixture.url,
      rootKey: rootKey,
      context: context,
      hooks: hooks
    )
    #expect(readPlan.calls > 2)
    #expect(scan.records.count == 2)
    #expect(scan.completeByteCount == UInt64(independentChain.count))
  }

  @Test func archive03PoisonsTheOwnerAfterAppendOrSyncFailure() throws {
    let writeFixture = try temporaryFixture("write-eio")
    defer { writeFixture.remove() }
    var writeHooks = ArchiveTapePersistenceHooks()
    writeHooks.write = { _, _, _ in
      errno = EIO
      return -1
    }
    let writeStore = try openStore(
      writeFixture.url,
      hooks: writeHooks,
      nonces: PersistenceNonceQueue([persistenceHex("000102030405060708090a0b")])
    )
    #expect(throws: ArchiveTapePersistenceError.writeFailed(offset: 0, errno: EIO)) {
      try writeStore.appendPCM(firstPlaintext)
    }
    #expect(throws: ArchiveTapePersistenceError.requiresAuthenticatedReopen) {
      try writeStore.appendPCM(firstPlaintext)
    }
    writeStore.close()
    #expect(try Data(contentsOf: writeFixture.url).isEmpty)

    let stalledFixture = try temporaryFixture("write-no-progress")
    defer { stalledFixture.remove() }
    var stalledHooks = ArchiveTapePersistenceHooks()
    stalledHooks.write = { _, _, _ in 0 }
    let stalledStore = try openStore(
      stalledFixture.url,
      hooks: stalledHooks,
      nonces: PersistenceNonceQueue([persistenceHex("000102030405060708090a0b")])
    )
    #expect(throws: ArchiveTapePersistenceError.writeMadeNoProgress(offset: 0)) {
      try stalledStore.appendPCM(firstPlaintext)
    }
    #expect(throws: ArchiveTapePersistenceError.requiresAuthenticatedReopen) {
      try stalledStore.appendPCM(firstPlaintext)
    }
    stalledStore.close()

    let syncFixture = try temporaryFixture("sync-eio")
    defer { syncFixture.remove() }
    var syncHooks = ArchiveTapePersistenceHooks()
    syncHooks.fullSync = { _ in
      errno = EIO
      return -1
    }
    let syncStore = try openStore(
      syncFixture.url,
      hooks: syncHooks,
      nonces: PersistenceNonceQueue([persistenceHex("000102030405060708090a0b")])
    )
    #expect(
      throws: ArchiveTapePersistenceError.fullSyncFailed(
        offset: UInt64(firstRecordByteCount), errno: EIO)
    ) {
      try syncStore.appendPCM(firstPlaintext)
    }
    #expect(throws: ArchiveTapePersistenceError.requiresAuthenticatedReopen) {
      try syncStore.appendPCM(firstPlaintext)
    }
    syncStore.close()
    let reopenSync = PersistenceCountingSyncPlan()
    var reopenHooks = ArchiveTapePersistenceHooks()
    reopenHooks.fullSync = { fileDescriptor in reopenSync.fullSync(fileDescriptor) }
    let survived = try openStore(syncFixture.url, hooks: reopenHooks)
    #expect(reopenSync.calls == 1)
    #expect(survived.unindexedRecords.count == 1)
    survived.close()
  }

  @Test func archive03RetriesDirectoryDurabilityAfterFirstRecordFailure() throws {
    let fixture = try temporaryFixture("directory-sync")
    defer { fixture.remove() }
    var failingHooks = ArchiveTapePersistenceHooks()
    failingHooks.synchronizeDirectory = { directory in
      throw ArchiveTapePersistenceError.directorySyncFailed(path: directory.path, errno: EIO)
    }
    let store = try openStore(
      fixture.url,
      hooks: failingHooks,
      nonces: PersistenceNonceQueue([persistenceHex("000102030405060708090a0b")])
    )
    #expect(
      throws: ArchiveTapePersistenceError.directorySyncFailed(
        path: fixture.directory.path, errno: EIO)
    ) {
      try store.appendPCM(firstPlaintext)
    }
    #expect(throws: ArchiveTapePersistenceError.requiresAuthenticatedReopen) {
      try store.appendPCM(firstPlaintext)
    }
    store.close()

    let directorySync = PersistenceDirectorySyncPlan()
    var reopenHooks = ArchiveTapePersistenceHooks()
    reopenHooks.synchronizeDirectory = { directory in try directorySync.sync(directory) }
    let reopened = try openStore(fixture.url, hooks: reopenHooks)
    #expect(directorySync.calls == 1)
    #expect(reopened.unindexedRecords.count == 1)
    reopened.close()
  }

  @Test func archive03MakesRepairFailuresLoud() throws {
    let fixture = try temporaryFixture("repair-eio")
    defer { fixture.remove() }
    let torn = Data(independentChain.prefix(firstRecordByteCount + 64))
    try torn.write(to: fixture.url)
    var hooks = ArchiveTapePersistenceHooks()
    hooks.truncate = { _, _ in
      errno = EIO
      return -1
    }

    #expect(
      throws: ArchiveTapePersistenceError.truncateFailed(
        offset: UInt64(firstRecordByteCount), errno: EIO)
    ) {
      try openStore(fixture.url, indexedCheckpoint: firstCheckpoint, hooks: hooks)
    }
    #expect(try Data(contentsOf: fixture.url) == torn)

    var syncHooks = ArchiveTapePersistenceHooks()
    syncHooks.fullSync = { _ in
      errno = EIO
      return -1
    }
    #expect(
      throws: ArchiveTapePersistenceError.fullSyncFailed(
        offset: UInt64(firstRecordByteCount), errno: EIO)
    ) {
      try openStore(fixture.url, indexedCheckpoint: firstCheckpoint, hooks: syncHooks)
    }
    #expect(try Data(contentsOf: fixture.url) == independentChain.prefix(firstRecordByteCount))
  }

  @Test func archive03ValidatesTheIndexedCheckpointBeforeRepair() throws {
    let fixture = try temporaryFixture("checkpoint-before-repair")
    defer { fixture.remove() }
    let torn = Data(independentChain.prefix(firstRecordByteCount + 64))
    try torn.write(to: fixture.url)
    let truncatePlan = PersistenceTruncatePlan()
    var hooks = ArchiveTapePersistenceHooks()
    hooks.truncate = { fileDescriptor, offset in
      truncatePlan.truncate(fileDescriptor: fileDescriptor, offset: offset)
    }

    #expect(throws: ArchiveTapePersistenceError.indexedCheckpointNotFound(2)) {
      try openStore(
        fixture.url,
        indexedCheckpoint: ArchiveTapeCheckpoint(
          recordSequence: 2,
          authenticationTag: secondTag,
          encryptedEndOffset: UInt64(independentChain.count)
        ),
        hooks: hooks
      )
    }
    #expect(truncatePlan.calls == 0)
    #expect(try Data(contentsOf: fixture.url) == torn)
  }

  @Test func archive03RefusesImpossibleIncompleteHeaderContinuations() throws {
    let fixture = try temporaryFixture("impossible-torn-header")
    defer { fixture.remove() }
    let secondHeaderOffset = firstRecordByteCount
    let completeHeaders = Data(
      independentChain.prefix(firstRecordByteCount + ArchiveEnvelopeCodec.headerByteCount))
    let mutations: [(Int, UInt8, ArchiveTapePersistenceError)] = [
      (secondHeaderOffset + 16, 0xFF, .streamUUIDMismatch),
      (
        secondHeaderOffset + 32, 3,
        .sequenceDiscontinuity(expected: 2, actual: 3)
      ),
      (
        secondHeaderOffset + 40, 5,
        .logicalDiscontinuity(expected: 4, actual: 5)
      ),
      (secondHeaderOffset + 68, 0xFF, .predecessorMismatch(sequence: 2)),
    ]

    for (offset, byte, expectedError) in mutations {
      var impossible = completeHeaders
      impossible[offset] = byte
      try impossible.write(to: fixture.url)
      do {
        _ = try openStore(fixture.url, indexedCheckpoint: firstCheckpoint)
        Issue.record("repaired impossible torn continuation: \(expectedError)")
      } catch let error as ArchiveTapePersistenceError {
        #expect(error == expectedError)
      }
      #expect(try Data(contentsOf: fixture.url) == impossible)
    }
  }

  @Test func archive03RefusesASecondProcessOwner() throws {
    let fixture = try temporaryFixture("lock")
    defer { fixture.remove() }
    let first = try openStore(fixture.url)
    defer { first.close() }

    do {
      _ = try openStore(fixture.url)
      Issue.record("second writer acquired the tape lock")
    } catch let error as ArchiveTapePersistenceError {
      guard case .lockFailed = error else {
        Issue.record("unexpected second-writer error: \(error)")
        return
      }
    }
  }

  @Test func archive03SerializesConcurrentAppendsIntoOneChain() throws {
    let fixture = try temporaryFixture("concurrent")
    defer { fixture.remove() }
    let store = try ArchiveTapeStore.openRecoveringForAppend(
      url: fixture.url, rootKey: rootKey, context: context)
    let failures = Atomic<Int>(0)

    DispatchQueue.concurrentPerform(iterations: 64) { sequence in
      do {
        _ = try store.appendPCM(persistencePCM(UInt16(sequence + 1)))
      } catch {
        _ = failures.wrappingAdd(1, ordering: .relaxed)
      }
    }
    store.close()

    #expect(failures.load(ordering: .relaxed) == 0)
    let scan = try ArchiveTapeStore.inspect(
      url: fixture.url, rootKey: rootKey, context: context)
    #expect(scan.records.count == 64)
    #expect(scan.records.map(\.header.recordSequence) == Array(1...64).map(UInt64.init))
    #expect(scan.records.last?.header.firstLogicalUnit == 63)
  }

  private var independentChain: Data {
    persistenceHex(
      "4554415441503031010080000000000000112233445566778899aabbccddeeff010000000000000000000000000000000400000008000000000102030405060708090a0b000000000000000000000000000000004776785c037085566905aa531bc701b0219c5950076cd21c433df74a8eccd0280100010000000000000000005cda39e6798185fe5c0b8c5c789140a3c901f0d90cfbf55c4554415441503031010080000000000000112233445566778899aabbccddeeff0200000000000000040000000000000002000000040000000c0d0e0f10111213141516175c0b8c5c789140a3c901f0d90cfbf55c4776785c037085566905aa531bc701b0219c5950076cd21c433df74a8eccd0280100010000000000000000008807410a51a6835fa3a1de005a5a85d6d88ceb60"
    )
  }

  private var firstCheckpoint: ArchiveTapeCheckpoint {
    ArchiveTapeCheckpoint(
      recordSequence: 1,
      authenticationTag: firstTag,
      encryptedEndOffset: UInt64(firstRecordByteCount)
    )
  }

  private func openStore(
    _ url: URL,
    indexedCheckpoint: ArchiveTapeCheckpoint? = nil,
    hooks: ArchiveTapePersistenceHooks = ArchiveTapePersistenceHooks(),
    nonces: PersistenceNonceQueue = PersistenceNonceQueue([])
  ) throws -> ArchiveTapeStore {
    try ArchiveTapeStore.openRecoveringForAppend(
      url: url,
      rootKey: rootKey,
      context: context,
      indexedCheckpoint: indexedCheckpoint,
      hooks: hooks,
      nonceProvider: { try nonces.next() }
    )
  }

  private func encodedRecord(
    streamUUID: Data? = nil,
    sequence: UInt64,
    firstLogicalUnit: UInt64,
    plaintext: Data,
    nonce: Data,
    predecessor: Data
  ) throws -> Data {
    let sealer = try ArchivePurposeSealer(
      purpose: .tape,
      rootKey: rootKey,
      streamUUID: streamUUID ?? self.streamUUID,
      nonceProvider: { nonce }
    )
    let envelope = try sealer.seal(
      plaintext,
      request: ArchiveRecordSealRequest(
        recordSequence: sequence,
        firstLogicalUnit: firstLogicalUnit,
        logicalUnitCount: UInt32(plaintext.count / 2),
        previousCommittedTag: predecessor,
        contextHash: contextHash
      )
    )
    return try ArchiveEnvelopeCodec.encodeUnauthenticated(envelope)
  }

  private func temporaryFixture(_ label: String) throws -> PersistenceFixture {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "eta-archive-persistence-\(label)-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    return PersistenceFixture(
      directory: directory,
      url: directory.appendingPathComponent("primary.tape")
    )
  }

  private func chainFixture(_ label: String) throws -> PersistenceFixture {
    let fixture = try temporaryFixture(label)
    try independentChain.write(to: fixture.url)
    return fixture
  }
}

private struct PersistenceFixture {
  let directory: URL
  let url: URL

  func remove() {
    try? FileManager.default.removeItem(at: directory)
  }
}

private final class PersistenceNonceQueue: @unchecked Sendable {
  private let lock = NSLock()
  private var nonces: [Data]

  init(_ nonces: [Data]) {
    self.nonces = nonces
  }

  func next() throws -> Data {
    try lock.withLock {
      guard !nonces.isEmpty else { throw ArchiveCryptoError.nonceGenerationFailed(-1) }
      return nonces.removeFirst()
    }
  }
}

private final class PersistenceShortWritePlan: @unchecked Sendable {
  private let lock = NSLock()
  private var callCount = 0

  var calls: Int { lock.withLock { callCount } }

  func write(fileDescriptor: Int32, pointer: UnsafeRawPointer, count: Int) -> Int {
    lock.withLock {
      callCount += 1
      if callCount == 1 {
        errno = EINTR
        return -1
      }
      return Darwin.write(fileDescriptor, pointer, min(count, 7))
    }
  }
}

private final class PersistenceShortReadPlan: @unchecked Sendable {
  private let lock = NSLock()
  private var callCount = 0

  var calls: Int { lock.withLock { callCount } }

  func read(
    fileDescriptor: Int32,
    pointer: UnsafeMutableRawPointer,
    count: Int,
    offset: off_t
  ) -> Int {
    lock.withLock {
      callCount += 1
      if callCount == 1 {
        errno = EINTR
        return -1
      }
      return Darwin.pread(fileDescriptor, pointer, min(count, 7), offset)
    }
  }
}

private final class PersistenceInterruptedSyncPlan: @unchecked Sendable {
  private let lock = NSLock()
  private var callCount = 0

  var calls: Int { lock.withLock { callCount } }

  func fullSync(_ fileDescriptor: Int32) -> Int32 {
    lock.withLock {
      callCount += 1
      if callCount == 1 {
        errno = EINTR
        return -1
      }
      return fcntl(fileDescriptor, F_FULLFSYNC)
    }
  }
}

private final class PersistenceCountingSyncPlan: @unchecked Sendable {
  private let lock = NSLock()
  private var callCount = 0

  var calls: Int { lock.withLock { callCount } }

  func fullSync(_ fileDescriptor: Int32) -> Int32 {
    lock.withLock {
      callCount += 1
      return fcntl(fileDescriptor, F_FULLFSYNC)
    }
  }
}

private final class PersistenceDirectorySyncPlan: @unchecked Sendable {
  private let lock = NSLock()
  private var callCount = 0

  var calls: Int { lock.withLock { callCount } }

  func sync(_ directory: URL) throws {
    try lock.withLock {
      callCount += 1
      let fileDescriptor = Darwin.open(directory.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
      guard fileDescriptor >= 0 else {
        throw ArchiveTapePersistenceError.directorySyncFailed(path: directory.path, errno: errno)
      }
      defer { _ = Darwin.close(fileDescriptor) }
      guard fsync(fileDescriptor) == 0 else {
        throw ArchiveTapePersistenceError.directorySyncFailed(path: directory.path, errno: errno)
      }
    }
  }
}

private final class PersistenceTruncatePlan: @unchecked Sendable {
  private let lock = NSLock()
  private var callCount = 0

  var calls: Int { lock.withLock { callCount } }

  func truncate(fileDescriptor: Int32, offset: off_t) -> Int32 {
    lock.withLock {
      callCount += 1
      return ftruncate(fileDescriptor, offset)
    }
  }
}

private func persistencePCM(_ sample: UInt16) -> Data {
  Data([UInt8(truncatingIfNeeded: sample), UInt8(truncatingIfNeeded: sample >> 8)])
}

private func persistenceHex(_ hex: String) -> Data {
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
