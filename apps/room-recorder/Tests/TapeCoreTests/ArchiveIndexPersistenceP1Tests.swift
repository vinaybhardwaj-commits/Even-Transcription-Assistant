import Darwin
import Foundation
import Synchronization
import Testing

@testable import TapeCore

@Suite(.serialized) struct ArchiveIndexPersistenceP1Tests {
  private let rootKey = laneHex(
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
  private let streamUUID = laneHex("00112233445566778899aabbccddeeff")
  private let contextHash = laneHex(
    "4776785c037085566905aa531bc701b0219c5950076cd21c433df74a8eccd028")
  private let firstPCM = laneHex("01000200ff7f0080")
  private let firstTapeTag = laneHex("5c0b8c5c789140a3c901f0d90cfbf55c")

  private var context: ArchiveContext {
    ArchiveContext(
      streamUUID: streamUUID,
      roomID: "room_1",
      istDate: "2026-08-26",
      laneID: "primary",
      stableDeviceUID: "AppleUSBAudioEngine:test"
    )
  }

  @Test func archive05FreezesIndependentIndexEnvelopeAndFreshTransaction() throws {
    let fixture = try laneFixture("golden")
    defer { fixture.remove() }
    let events = LaneEventLog()
    var hooks = ArchiveLanePersistenceHooks()
    hooks.event = { events.append($0) }
    let store = try open(
      fixture,
      hooks: hooks,
      tapeNonces: [laneHex("000102030405060708090a0b")],
      indexNonces: [laneHex("18191a1b1c1d1e1f20212223")]
    )

    let result = try store.appendPCM(firstPCM, observation: normalObservation())
    store.close()

    #expect(result.tape.header.recordSequence == 1)
    #expect(result.index.header.recordSequence == result.tape.header.recordSequence)
    #expect(result.index.header.firstLogicalUnit == result.index.payload.sampleStart)
    #expect(result.index.header.logicalUnitCount == 4)
    #expect(result.index.payload.tapeTag == result.tape.authenticationTag)
    #expect(result.index.payload.encryptedEnd == result.tape.encryptedEndOffset)
    #expect(try Data(contentsOf: fixture.tapeURL) == independentFirstTapeRecord)
    #expect(try Data(contentsOf: fixture.indexURL) == independentFirstIndexRecord)
    #expect(
      try encodedIndex(
        [goldenNormalPayload(), goldenRecoveryPayload()],
        nonces: [
          laneHex("18191a1b1c1d1e1f20212223"),
          laneHex("2425262728292a2b2c2d2e2f"),
        ])
        == independentFirstIndexRecord + independentSecondIndexRecord)
    #expect(
      events.values
        == [
          .tapeSeal, .tapeWrite, .tapeFullSync, .tapeDirectorySync,
          .indexSeal, .indexWrite, .indexFullSync, .indexDirectorySync,
        ])
  }

  @Test func archive05CleanReopenDoesNotDuplicateAndReconstructsBothCounts() throws {
    let fixture = try populatedFixture("clean-reopen", count: 2)
    defer { fixture.remove() }
    let originalIndex = try Data(contentsOf: fixture.indexURL)
    let store = try open(fixture)

    #expect(store.adoptedRecordCount == 0)
    #expect(store.scanResult.index.records.count == 2)
    #expect(store.sealerRecordCountsForTesting.tape == 2)
    #expect(store.sealerRecordCountsForTesting.index == 2)
    store.close()
    #expect(try Data(contentsOf: fixture.indexURL) == originalIndex)
  }

  @Test func archive05FatalOpenRestoresEveryNewPathToAbsent() throws {
    let indexOpenFailure = try laneFixture("create-index-open-failure")
    defer { indexOpenFailure.remove() }
    let missingParent = indexOpenFailure.directory.appendingPathComponent(
      "missing", isDirectory: true)
    let unavailableIndex = missingParent.appendingPathComponent("primary.index")
    #expect(throws: ArchiveLanePersistenceError.self) {
      try ArchiveLaneStore.openRecoveringForAppend(
        tapeURL: indexOpenFailure.tapeURL,
        indexURL: unavailableIndex,
        rootKey: rootKey,
        context: context)
    }
    #expect(!FileManager.default.fileExists(atPath: indexOpenFailure.tapeURL.path))
    #expect(!FileManager.default.fileExists(atPath: unavailableIndex.path))

    let initializationFailure = try laneFixture("create-before-init-failure")
    defer { initializationFailure.remove() }
    var initializationHooks = ArchiveLanePersistenceHooks()
    initializationHooks.initializeStore = {
      throw ArchiveLanePersistenceError.statFailed(file: .index, errno: EIO)
    }
    #expect(
      throws: ArchiveLanePersistenceError.statFailed(file: .index, errno: EIO)
    ) {
      try open(initializationFailure, hooks: initializationHooks)
    }
    #expect(!FileManager.default.fileExists(atPath: initializationFailure.tapeURL.path))
    #expect(!FileManager.default.fileExists(atPath: initializationFailure.indexURL.path))

    let lockFailure = try laneFixture("create-tape-before-index-lock-failure")
    defer { lockFailure.remove() }
    try Data().write(to: lockFailure.indexURL)
    let lockedIndex = Darwin.open(
      lockFailure.indexURL.path, O_RDWR | O_CLOEXEC | O_NOFOLLOW)
    #expect(lockedIndex >= 0)
    #expect(flock(lockedIndex, LOCK_EX | LOCK_NB) == 0)
    #expect(throws: ArchiveLanePersistenceError.self) {
      try open(lockFailure)
    }
    #expect(flock(lockedIndex, LOCK_UN) == 0)
    _ = Darwin.close(lockedIndex)
    #expect(!FileManager.default.fileExists(atPath: lockFailure.tapeURL.path))
    #expect(try Data(contentsOf: lockFailure.indexURL).isEmpty)

    let corruptTape = try laneFixture("create-index-after-corrupt-tape")
    defer { corruptTape.remove() }
    var corruptTapeBytes = independentFirstTapeRecord
    corruptTapeBytes[corruptTapeBytes.count - 1] ^= 1
    try corruptTapeBytes.write(to: corruptTape.tapeURL)
    #expect(throws: ArchiveCryptoError.authenticationFailed) {
      try open(corruptTape)
    }
    #expect(try Data(contentsOf: corruptTape.tapeURL) == corruptTapeBytes)
    #expect(!FileManager.default.fileExists(atPath: corruptTape.indexURL.path))

    let indexAhead = try populatedFixture("create-tape-before-index-ahead", count: 1)
    defer { indexAhead.remove() }
    let indexBytes = try Data(contentsOf: indexAhead.indexURL)
    try FileManager.default.removeItem(at: indexAhead.tapeURL)
    #expect(throws: ArchiveLanePersistenceError.indexAhead(indexCount: 1, tapeCount: 0)) {
      try open(indexAhead)
    }
    #expect(!FileManager.default.fileExists(atPath: indexAhead.tapeURL.path))
    #expect(try Data(contentsOf: indexAhead.indexURL) == indexBytes)
  }

  @Test func archive05AtomicOpenLockPreventsAdoptionBeforeRollback() throws {
    let fixture = try laneFixture("atomic-open-rollback")
    defer { fixture.remove() }
    let enteredInitialization = DispatchSemaphore(value: 0)
    let releaseInitialization = DispatchSemaphore(value: 0)
    defer { releaseInitialization.signal() }
    let completed = DispatchSemaphore(value: 0)
    let result = LaneAsyncError()
    var hooks = ArchiveLanePersistenceHooks()
    hooks.initializeStore = {
      enteredInitialization.signal()
      guard releaseInitialization.wait(timeout: .now() + 5) == .success else {
        throw ArchiveLanePersistenceError.statFailed(file: .index, errno: ETIMEDOUT)
      }
      throw ArchiveLanePersistenceError.statFailed(file: .index, errno: EIO)
    }
    let rootKey = rootKey
    let context = context
    DispatchQueue.global().async {
      do {
        let owner = try ArchiveLaneStore.openRecoveringForAppend(
          tapeURL: fixture.tapeURL,
          indexURL: fixture.indexURL,
          rootKey: rootKey,
          context: context,
          hooks: hooks,
          tapeNonceProvider: { throw ArchiveCryptoError.nonceGenerationFailed(-1) },
          indexNonceProvider: { throw ArchiveCryptoError.nonceGenerationFailed(-1) })
        owner.close()
      } catch {
        result.set(error)
      }
      completed.signal()
    }

    #expect(enteredInitialization.wait(timeout: .now() + 5) == .success)
    #expect(try Data(contentsOf: fixture.tapeURL).isEmpty)
    #expect(try Data(contentsOf: fixture.indexURL).isEmpty)
    do {
      _ = try open(fixture)
      Issue.record("competing owner adopted paths before rollback")
    } catch let error as ArchiveLanePersistenceError {
      if case .lockFailed(file: .tape, errno: let lockErrno) = error {
        #expect(lockErrno == EWOULDBLOCK || lockErrno == EAGAIN)
      } else {
        Issue.record("unexpected competing-open error: \(error)")
      }
    }

    releaseInitialization.signal()
    #expect(completed.wait(timeout: .now() + 5) == .success)
    #expect(
      result.value as? ArchiveLanePersistenceError
        == .statFailed(file: .index, errno: EIO))
    #expect(!FileManager.default.fileExists(atPath: fixture.tapeURL.path))
    #expect(!FileManager.default.fileExists(atPath: fixture.indexURL.path))
    let reopened = try open(fixture)
    reopened.close()
    #expect(try Data(contentsOf: fixture.tapeURL).isEmpty)
    #expect(try Data(contentsOf: fixture.indexURL).isEmpty)
  }

  @Test func archive05HardLinkAliasesRemainFailClosedUnderAtomicLocks() throws {
    let fixture = try laneFixture("atomic-lock-hardlink")
    defer { fixture.remove() }
    let bytes = Data([0x45, 0x54, 0x41])
    try bytes.write(to: fixture.tapeURL)
    try FileManager.default.linkItem(at: fixture.tapeURL, to: fixture.indexURL)

    do {
      _ = try open(fixture)
      Issue.record("writable paired owner accepted hard-link aliases")
    } catch let error as ArchiveLanePersistenceError {
      switch error {
      case .lockFailed(file: .index, errno: let lockErrno):
        #expect(lockErrno == EWOULDBLOCK || lockErrno == EAGAIN)
      case .sameFile:
        break
      default:
        Issue.record("unexpected writable alias error: \(error)")
      }
    }
    #expect(throws: ArchiveLanePersistenceError.sameFile) {
      try pairedInspection(fixture)
    }
    #expect(try Data(contentsOf: fixture.tapeURL) == bytes)
    #expect(try Data(contentsOf: fixture.indexURL) == bytes)
  }

  @Test func archive05NormalAppendCannotForgeARecoveryRecord() throws {
    let fixture = try laneFixture("recovery-observation")
    defer { fixture.remove() }
    let store = try open(fixture)
    let recovery = ArchiveIndexObservation(
      monoNS: nil,
      wallNS: nil,
      rmsQ15: nil,
      nativeFrames: nil,
      inputRateNumerator: nil,
      inputRateDenominator: nil,
      discontinuity: .crashRecoveredUnindexed,
      reason: ArchiveIndexDiscontinuity.crashRecoveredUnindexed.rawValue,
      previousDurableSample: 0,
      survivingTailBytes: 1)

    #expect(throws: ArchiveLanePersistenceError.recoveryObservationNotAllowed) {
      try store.appendPCM(firstPCM, observation: recovery)
    }
    #expect(store.scanResult.tape.records.isEmpty)
    #expect(store.scanResult.index.records.isEmpty)
    store.close()
  }

  @Test func archive05ExactPayloadSizeFailsAfterSealButBeforeTapeWrite() throws {
    let fixture = try laneFixture("exact-payload-preflight")
    defer { fixture.remove() }
    let events = LaneEventLog()
    var hooks = ArchiveLanePersistenceHooks()
    hooks.event = { events.append($0) }
    let store = try open(
      fixture,
      hooks: hooks,
      tapeNonces: [laneHex("303132333435363738393a3b")])
    let oversized = ArchiveIndexObservation(
      monoNS: nil,
      wallNS: nil,
      rmsQ15: nil,
      nativeFrames: nil,
      inputRateNumerator: nil,
      inputRateDenominator: nil,
      discontinuity: .restart,
      reason: String(repeating: "x", count: 1_048_576))

    #expect(throws: ArchiveIndexPayloadError.self) {
      try store.appendPCM(firstPCM, observation: oversized)
    }
    #expect(events.values == [.tapeSeal])
    #expect(try Data(contentsOf: fixture.tapeURL).isEmpty)
    #expect(try Data(contentsOf: fixture.indexURL).isEmpty)
    #expect(throws: ArchiveLanePersistenceError.requiresAuthenticatedReopen) {
      try store.appendPCM(firstPCM, observation: normalObservation())
    }
    store.close()
  }

  @Test func archive05AdoptsEveryNoIndexTapeRecordWithOriginalCheckpointFormula() throws {
    let fixture = try populatedFixture("no-index-adoption", count: 3)
    defer { fixture.remove() }
    try Data().write(to: fixture.indexURL)
    let tape = try tapeInspection(fixture)
    let store = try open(
      fixture,
      indexNonces: nonceSeries(start: 0x70, count: 3)
    )

    #expect(store.adoptedRecordCount == 3)
    let records = store.scanResult.index.records
    #expect(records.count == 3)
    for position in records.indices {
      let payload = records[position].payload
      #expect(payload.discontinuity == .crashRecoveredUnindexed)
      #expect(payload.previousDurableSample == 0)
      #expect(payload.survivingTailBytes == tape.records[position].encryptedEndOffset)
      #expect(payload.tapeSequence == UInt64(position + 1))
    }
    store.close()
  }

  @Test func archive05PrefixAdoptionRepeatsOriginalCheckpointAndCumulativeTail() throws {
    let fixture = try populatedFixture("prefix-adoption", count: 4)
    defer { fixture.remove() }
    let initial = try pairedInspection(fixture)
    let indexPrefixEnd = initial.index.records[1].encryptedEndOffset
    try truncateURL(fixture.indexURL, to: indexPrefixEnd)
    let originalTapeEnd = initial.tape.records[1].encryptedEndOffset
    let originalSampleEnd = initial.index.records[1].payload.sampleEnd
    let store = try open(
      fixture,
      indexNonces: nonceSeries(start: 0x90, count: 2)
    )

    #expect(store.adoptedRecordCount == 2)
    let recovered = Array(store.scanResult.index.records.dropFirst(2))
    #expect(
      recovered.map(\.payload.previousDurableSample) == [originalSampleEnd, originalSampleEnd])
    #expect(
      recovered.map(\.payload.survivingTailBytes)
        == [
          initial.tape.records[2].encryptedEndOffset - originalTapeEnd,
          initial.tape.records[3].encryptedEndOffset - originalTapeEnd,
        ])
    store.close()

    let clean = try open(fixture)
    #expect(clean.adoptedRecordCount == 0)
    clean.close()
  }

  @Test func archive05InterruptedAdoptionContinuesOneRecoveryEpoch() throws {
    let fixture = try populatedFixture("interrupted-adoption-epoch", count: 3)
    defer { fixture.remove() }
    try Data().write(to: fixture.indexURL)
    let tape = try tapeInspection(fixture)
    let failure = LaneNthIndexWriteFailure(failAt: 2)
    var hooks = ArchiveLanePersistenceHooks()
    hooks.event = { failure.observe($0) }
    hooks.write = { descriptor, pointer, count in
      failure.write(descriptor: descriptor, pointer: pointer, count: count)
    }

    #expect(throws: ArchiveLanePersistenceError.self) {
      try open(
        fixture,
        hooks: hooks,
        indexNonces: nonceSeries(start: 0x70, count: 2))
    }
    let durablePrefix = try pairedInspection(fixture)
    #expect(durablePrefix.index.records.count == 1)
    #expect(durablePrefix.index.records[0].payload.previousDurableSample == 0)
    #expect(
      durablePrefix.index.records[0].payload.survivingTailBytes
        == tape.records[0].encryptedEndOffset)

    let reopened = try open(
      fixture,
      indexNonces: nonceSeries(start: 0xA0, count: 2))
    let recovery = reopened.scanResult.index.records
    #expect(reopened.adoptedRecordCount == 2)
    #expect(recovery.map(\.payload.previousDurableSample) == [0, 0, 0])
    #expect(
      recovery.map(\.payload.survivingTailBytes)
        == tape.records.map(\.encryptedEndOffset))
    reopened.close()
  }

  @Test func archive05DurableNormalRecordResetsTheRecoveryEpoch() throws {
    let fixture = try populatedFixture("normal-resets-recovery", count: 1)
    defer { fixture.remove() }
    try Data().write(to: fixture.indexURL)
    let firstOpen = try open(
      fixture,
      tapeNonces: [laneHex("b0b1b2b3b4b5b6b7b8b9babb")],
      indexNonces: [
        laneHex("c0c1c2c3c4c5c6c7c8c9cacb"),
        laneHex("d0d1d2d3d4d5d6d7d8d9dadb"),
      ])
    _ = try firstOpen.appendPCM(lanePCM(2), observation: normalObservation())
    firstOpen.close()

    let failingOpen = try open(
      fixture,
      tapeNonces: [laneHex("e0e1e2e3e4e5e6e7e8e9eaeb")])
    #expect(throws: ArchiveCryptoError.nonceGenerationFailed(-1)) {
      try failingOpen.appendPCM(lanePCM(3), observation: normalObservation())
    }
    failingOpen.close()

    let beforeRecovery = try tapeInspection(fixture)
    let reopened = try open(
      fixture,
      indexNonces: [laneHex("f0f1f2f3f4f5f6f7f8f9fafb")])
    let records = reopened.scanResult.index.records
    let reset = records[2].payload
    #expect(records[0].payload.discontinuity == .crashRecoveredUnindexed)
    #expect(records[1].payload.discontinuity == nil)
    #expect(reset.discontinuity == .crashRecoveredUnindexed)
    #expect(reset.previousDurableSample == records[1].payload.sampleEnd)
    #expect(
      reset.survivingTailBytes
        == beforeRecovery.records[2].encryptedEndOffset
        - beforeRecovery.records[2].encryptedStartOffset)
    reopened.close()
  }

  @Test func archive05RejectsEveryTapeIndexCrossValidationMismatch() throws {
    let fixture = try populatedFixture("mismatch", count: 1)
    defer { fixture.remove() }
    let scan = try pairedInspection(fixture)
    let tape = scan.tape.records[0]
    let valid = scan.index.records[0].payload
    let cases: [ArchiveIndexPayload] = [
      try payload(for: tape, tapeSequence: 2),
      try payload(for: tape, tapeTag: Data(repeating: 0x44, count: 16)),
      try payload(for: tape, encryptedEnd: tape.encryptedEndOffset + 1),
      try payload(for: tape, sampleStart: 0, sampleEnd: 3),
      try payload(for: tape, deviceUID: "other-device"),
    ]
    #expect(valid.deviceUID == context.stableDeviceUID)

    for (number, item) in cases.enumerated() {
      let bytes = try encodedIndex(
        [item], nonces: nonceSeries(start: UInt8(0xA0 + number), count: 1))
      try bytes.write(to: fixture.indexURL)
      let beforeTape = try Data(contentsOf: fixture.tapeURL)
      let beforeIndex = try Data(contentsOf: fixture.indexURL)
      do {
        _ = try ArchiveLaneStore.inspect(
          tapeURL: fixture.tapeURL, indexURL: fixture.indexURL,
          rootKey: rootKey, context: context)
        Issue.record("accepted tape/index mismatch \(number)")
      } catch is ArchiveLanePersistenceError {
      } catch {
        Issue.record("unexpected mismatch error: \(error)")
      }
      #expect(try Data(contentsOf: fixture.tapeURL) == beforeTape)
      #expect(try Data(contentsOf: fixture.indexURL) == beforeIndex)
    }
  }

  @Test func archive05RejectsIndexStreamRangeAndRecoveryEpochMismatches() throws {
    let fixture = try populatedFixture("structural-mismatches", count: 2)
    defer { fixture.remove() }
    let tape = try tapeInspection(fixture).records
    let normal = try tape.map { try payload(for: $0) }

    let otherStream = Data(repeating: 0xEE, count: 16)
    try encodedIndex(
      normal,
      nonces: nonceSeries(start: 0x80, count: 2),
      encodedStreamUUID: otherStream
    ).write(to: fixture.indexURL)
    #expect(throws: ArchiveLanePersistenceError.streamUUIDMismatch(file: .index)) {
      try pairedInspection(fixture)
    }

    try encodedIndex(
      normal,
      nonces: nonceSeries(start: 0xA0, count: 2),
      logicalUnitCounts: [2, 1]
    ).write(to: fixture.indexURL)
    #expect(throws: ArchiveLanePersistenceError.indexEnvelopeRangeMismatch(sequence: 1)) {
      try pairedInspection(fixture)
    }

    let recovery = [
      try recoveryPayload(for: tape[0], previousDurableSample: 0, encryptedOrigin: 0),
      try recoveryPayload(
        for: tape[1], previousDurableSample: 0,
        encryptedOrigin: 1),
    ]
    try encodedIndex(
      recovery,
      nonces: nonceSeries(start: 0xC0, count: 2)
    ).write(to: fixture.indexURL)
    #expect(
      throws: ArchiveLanePersistenceError.recoveryEpochMismatch(sequence: 2)
    ) {
      try pairedInspection(fixture)
    }
  }

  @Test func archive05RejectsWrongKeyTamperContextAndIndexChain() throws {
    let fixture = try populatedFixture("authentication", count: 2)
    defer { fixture.remove() }
    let originalTape = try Data(contentsOf: fixture.tapeURL)
    let originalIndex = try Data(contentsOf: fixture.indexURL)

    #expect(throws: ArchiveCryptoError.authenticationFailed) {
      try ArchiveLaneStore.inspect(
        tapeURL: fixture.tapeURL, indexURL: fixture.indexURL,
        rootKey: Data(repeating: 0xFF, count: 32), context: context)
    }
    var tampered = originalIndex
    tampered[tampered.count - 1] ^= 1
    try tampered.write(to: fixture.indexURL)
    #expect(throws: ArchiveCryptoError.authenticationFailed) {
      try ArchiveLaneStore.inspect(
        tapeURL: fixture.tapeURL, indexURL: fixture.indexURL,
        rootKey: rootKey, context: context)
    }

    try originalIndex.write(to: fixture.indexURL)
    let wrongContext = ArchiveContext(
      streamUUID: streamUUID, roomID: "room_other", istDate: context.istDate,
      laneID: context.laneID, stableDeviceUID: context.stableDeviceUID)
    #expect(throws: ArchiveEnvelopeError.contextMismatch) {
      try ArchiveLaneStore.inspect(
        tapeURL: fixture.tapeURL, indexURL: fixture.indexURL,
        rootKey: rootKey, context: wrongContext)
    }

    let scan = try pairedInspection(fixture)
    let payloads = scan.tape.records.map { try! payload(for: $0) }
    let invalidChain = try encodedIndex(
      payloads,
      nonces: nonceSeries(start: 0xB0, count: 2),
      secondPredecessor: Data(repeating: 0, count: 16))
    try invalidChain.write(to: fixture.indexURL)
    #expect(
      throws: ArchiveLanePersistenceError.predecessorMismatch(file: .index, sequence: 2)
    ) {
      try ArchiveLaneStore.inspect(
        tapeURL: fixture.tapeURL, indexURL: fixture.indexURL,
        rootKey: rootKey, context: context)
    }
    #expect(try Data(contentsOf: fixture.tapeURL) == originalTape)
  }

  @Test func archive05IndexAheadIsFatalAndNonmutating() throws {
    let fixture = try populatedFixture("index-ahead", count: 2)
    defer { fixture.remove() }
    let scan = try pairedInspection(fixture)
    try truncateURL(fixture.tapeURL, to: scan.tape.records[0].encryptedEndOffset)
    let tapeBefore = try Data(contentsOf: fixture.tapeURL)
    let indexBefore = try Data(contentsOf: fixture.indexURL)

    #expect(throws: ArchiveLanePersistenceError.indexAhead(indexCount: 2, tapeCount: 1)) {
      try open(fixture)
    }
    #expect(try Data(contentsOf: fixture.tapeURL) == tapeBefore)
    #expect(try Data(contentsOf: fixture.indexURL) == indexBefore)
  }

  @Test func archive05ReportsAndExplicitlyRepairsEveryTornIndexSuffix() throws {
    let base = try populatedFixture("torn-base", count: 1)
    defer { base.remove() }
    let tape = try Data(contentsOf: base.tapeURL)
    let index = try Data(contentsOf: base.indexURL)
    for cut in [64, 130, index.count - 1] {
      let fixture = try laneFixture("torn-\(cut)")
      defer { fixture.remove() }
      try tape.write(to: fixture.tapeURL)
      let torn = Data(index.prefix(cut))
      try torn.write(to: fixture.indexURL)

      let readOnly = try pairedInspection(fixture)
      #expect(readOnly.index.records.isEmpty)
      #expect(readOnly.index.incompleteTrailingByteCount == UInt64(cut))
      #expect(try Data(contentsOf: fixture.indexURL) == torn)

      let store = try open(
        fixture, indexNonces: [laneHex("d0d1d2d3d4d5d6d7d8d9dadb")])
      #expect(store.repairedIndexTrailingByteCount == UInt64(cut))
      #expect(store.adoptedRecordCount == 1)
      #expect(store.scanResult.index.records[0].payload.discontinuity == .crashRecoveredUnindexed)
      store.close()
    }
  }

  @Test func archive05NeverRepairsACompleteInvalidIndexRecord() throws {
    let fixture = try populatedFixture("complete-invalid", count: 1)
    defer { fixture.remove() }
    var invalid = try Data(contentsOf: fixture.indexURL)
    invalid[invalid.count - 1] ^= 1
    try invalid.write(to: fixture.indexURL)

    #expect(throws: ArchiveCryptoError.authenticationFailed) {
      try open(fixture)
    }
    #expect(try Data(contentsOf: fixture.indexURL) == invalid)
  }

  @Test func archive05NeverRepairsACompleteInvalidInteriorIndexRecord() throws {
    let fixture = try populatedFixture("complete-invalid-interior", count: 3)
    defer { fixture.remove() }
    let scan = try pairedInspection(fixture)
    var invalid = try Data(contentsOf: fixture.indexURL)
    let interiorCiphertext =
      Int(scan.index.records[1].encryptedStartOffset)
      + ArchiveEnvelopeCodec.headerByteCount
    invalid[interiorCiphertext] ^= 1
    try invalid.write(to: fixture.indexURL)

    #expect(throws: ArchiveCryptoError.authenticationFailed) {
      try open(fixture)
    }
    #expect(try Data(contentsOf: fixture.indexURL) == invalid)
  }

  @Test func archive05PlansBothRepairsThenRepairsTapeBeforeIndexAndAdopts() throws {
    let fixture = try populatedFixture("both-tails", count: 3)
    defer { fixture.remove() }
    let scan = try pairedInspection(fixture)
    let tornTapeEnd = scan.tape.records[2].encryptedStartOffset + 64
    let tornIndexEnd = scan.index.records[1].encryptedStartOffset + 64
    try truncateURL(fixture.tapeURL, to: tornTapeEnd)
    try truncateURL(fixture.indexURL, to: tornIndexEnd)
    let events = LaneEventLog()
    var hooks = ArchiveLanePersistenceHooks()
    hooks.event = { events.append($0) }

    let store = try open(
      fixture, hooks: hooks,
      indexNonces: [laneHex("e0e1e2e3e4e5e6e7e8e9eaeb")])
    #expect(store.repairedTapeTrailingByteCount == 64)
    #expect(store.repairedIndexTrailingByteCount == 64)
    #expect(store.adoptedRecordCount == 1)
    let significant = events.values.filter {
      if case .tapeRepair = $0 { return true }
      if case .indexRepair = $0 { return true }
      if case .adoption = $0 { return true }
      return false
    }
    #expect(significant == [.tapeRepair, .indexRepair, .adoption(2)])
    store.close()
  }

  @Test func archive05RetriesShortWritesAndEINTRAcrossBothFiles() throws {
    let fixture = try laneFixture("short-write")
    defer { fixture.remove() }
    let plan = LaneShortWritePlan()
    var hooks = ArchiveLanePersistenceHooks()
    hooks.write = { descriptor, pointer, count in
      plan.write(descriptor: descriptor, pointer: pointer, count: count)
    }
    hooks.fullSync = { descriptor in plan.fullSync(descriptor) }
    let store = try open(
      fixture, hooks: hooks,
      tapeNonces: [laneHex("000102030405060708090a0b")],
      indexNonces: [laneHex("18191a1b1c1d1e1f20212223")])

    _ = try store.appendPCM(firstPCM, observation: normalObservation())
    store.close()
    #expect(plan.writeCalls > 4)
    #expect(plan.syncCalls >= 3)
    #expect(try pairedInspection(fixture).index.records.count == 1)
  }

  @Test func archive05RetriesIndexPreadAfterEINTRAndShortReads() throws {
    let fixture = try populatedFixture("index-short-read", count: 2)
    defer { fixture.remove() }
    let plan = try LaneIndexShortReadPlan(indexURL: fixture.indexURL)
    var hooks = ArchiveLanePersistenceHooks()
    hooks.pread = { descriptor, pointer, count, offset in
      plan.read(descriptor: descriptor, pointer: pointer, count: count, offset: offset)
    }

    let scan = try ArchiveLaneStore.inspect(
      tapeURL: fixture.tapeURL,
      indexURL: fixture.indexURL,
      rootKey: rootKey,
      context: context,
      hooks: hooks)
    #expect(scan.index.records.count == 2)
    #expect(plan.indexReadCalls > 4)
  }

  @Test func archive05FaultsPoisonTheSharedOwnerAndReopenResolvesDurability() throws {
    let fixture = try laneFixture("shared-poison")
    defer { fixture.remove() }
    let plan = LaneFaultPlan(failAt: .indexFullSync)
    var hooks = ArchiveLanePersistenceHooks()
    hooks.event = { plan.observe($0) }
    hooks.fullSync = { descriptor in plan.fullSync(descriptor) }
    let store = try open(
      fixture, hooks: hooks,
      tapeNonces: [laneHex("000102030405060708090a0b")],
      indexNonces: [laneHex("18191a1b1c1d1e1f20212223")])

    #expect(
      throws: ArchiveLanePersistenceError.fullSyncFailed(
        file: .index, offset: UInt64(independentFirstIndexRecord.count), errno: EIO)
    ) {
      try store.appendPCM(firstPCM, observation: normalObservation())
    }
    #expect(throws: ArchiveLanePersistenceError.requiresAuthenticatedReopen) {
      try store.appendPCM(firstPCM, observation: normalObservation())
    }
    store.close()

    let reopened = try open(
      fixture, indexNonces: [laneHex("f0f1f2f3f4f5f6f7f8f9fafb")])
    #expect(reopened.adoptedRecordCount == 0)
    #expect(reopened.scanResult.tape.records.count == 1)
    #expect(reopened.scanResult.index.records.count == 1)
    reopened.close()
  }

  @Test func archive05EveryTransactionBoundaryFaultPoisonsBothSides() throws {
    for (position, boundary) in [
      ArchiveLanePersistenceEvent.tapeWrite,
      .tapeFullSync,
      .tapeDirectorySync,
      .indexWrite,
      .indexFullSync,
      .indexDirectorySync,
    ].enumerated() {
      let fixture = try laneFixture("boundary-fault-\(position)")
      defer { fixture.remove() }
      let plan = LaneBoundaryFaultPlan(failAt: boundary)
      var hooks = ArchiveLanePersistenceHooks()
      hooks.event = { plan.observe($0) }
      hooks.write = { descriptor, pointer, count in
        plan.write(descriptor: descriptor, pointer: pointer, count: count)
      }
      hooks.fullSync = { descriptor in plan.fullSync(descriptor) }
      hooks.synchronizeDirectory = { directory in try plan.sync(directory) }
      let store = try open(
        fixture, hooks: hooks,
        tapeNonces: [laneHex("000102030405060708090a0b")],
        indexNonces: [laneHex("18191a1b1c1d1e1f20212223")])

      #expect(throws: (any Error).self) {
        try store.appendPCM(firstPCM, observation: normalObservation())
      }
      #expect(throws: ArchiveLanePersistenceError.requiresAuthenticatedReopen) {
        try store.appendPCM(firstPCM, observation: normalObservation())
      }
      store.close()
    }

    for (label, tapeNonces, indexNonces) in [
      ("tape-seal", [Data](), [laneHex("18191a1b1c1d1e1f20212223")]),
      ("index-seal", [laneHex("000102030405060708090a0b")], [Data]()),
    ] {
      let fixture = try laneFixture(label)
      defer { fixture.remove() }
      let store = try open(
        fixture, tapeNonces: tapeNonces, indexNonces: indexNonces)
      #expect(throws: ArchiveCryptoError.nonceGenerationFailed(-1)) {
        try store.appendPCM(firstPCM, observation: normalObservation())
      }
      #expect(throws: ArchiveLanePersistenceError.requiresAuthenticatedReopen) {
        try store.appendPCM(firstPCM, observation: normalObservation())
      }
      store.close()
    }
  }

  @Test func archive05AdoptionWriteUncertaintyRequiresAnotherAuthenticatedReopen() throws {
    let fixture = try populatedFixture("adoption-uncertainty", count: 1)
    defer { fixture.remove() }
    try Data().write(to: fixture.indexURL)
    let plan = LaneBoundaryFaultPlan(failAt: .indexWrite)
    var hooks = ArchiveLanePersistenceHooks()
    hooks.event = { plan.observe($0) }
    hooks.write = { descriptor, pointer, count in
      plan.write(descriptor: descriptor, pointer: pointer, count: count)
    }

    #expect(throws: (any Error).self) {
      try open(
        fixture, hooks: hooks,
        indexNonces: [laneHex("d0d1d2d3d4d5d6d7d8d9dadb")])
    }
    let reopened = try open(
      fixture, indexNonces: [laneHex("e0e1e2e3e4e5e6e7e8e9eaeb")])
    #expect(reopened.adoptedRecordCount == 1)
    #expect(reopened.scanResult.index.records.count == 1)
    reopened.close()
  }

  @Test func archive05TruncateAndDirectoryFaultsAreLoud() throws {
    let fixture = try populatedFixture("repair-fault", count: 2)
    defer { fixture.remove() }
    let scan = try pairedInspection(fixture)
    try truncateURL(fixture.tapeURL, to: scan.tape.records[1].encryptedStartOffset + 64)
    try truncateURL(fixture.indexURL, to: scan.index.records[1].encryptedStartOffset + 64)
    let tapeBefore = try Data(contentsOf: fixture.tapeURL)
    let indexBefore = try Data(contentsOf: fixture.indexURL)
    var truncateHooks = ArchiveLanePersistenceHooks()
    truncateHooks.truncate = { _, _ in
      errno = EIO
      return -1
    }
    #expect(
      throws: ArchiveLanePersistenceError.truncateFailed(
        file: .tape, offset: scan.tape.records[0].encryptedEndOffset, errno: EIO)
    ) {
      try open(fixture, hooks: truncateHooks)
    }
    #expect(try Data(contentsOf: fixture.tapeURL) == tapeBefore)
    #expect(try Data(contentsOf: fixture.indexURL) == indexBefore)

    let fresh = try laneFixture("directory-fault")
    defer { fresh.remove() }
    let plan = LaneDirectoryFaultPlan()
    var directoryHooks = ArchiveLanePersistenceHooks()
    directoryHooks.event = { plan.observe($0) }
    directoryHooks.synchronizeDirectory = { directory in try plan.sync(directory) }
    let store = try open(
      fresh, hooks: directoryHooks,
      tapeNonces: [laneHex("000102030405060708090a0b")],
      indexNonces: [laneHex("18191a1b1c1d1e1f20212223")])
    #expect(
      throws: ArchiveLanePersistenceError.directorySyncFailed(
        file: .index, path: fresh.directory.path, errno: EIO)
    ) {
      try store.appendPCM(firstPCM, observation: normalObservation())
    }
    #expect(throws: ArchiveLanePersistenceError.requiresAuthenticatedReopen) {
      try store.appendPCM(firstPCM, observation: normalObservation())
    }
    store.close()
  }

  @Test func archive05PairedLocksRefuseReadersAndWriters() throws {
    let fixture = try laneFixture("lock")
    defer { fixture.remove() }
    let owner = try open(fixture)
    defer { owner.close() }

    for operation in [
      { try self.open(fixture) as Any },
      {
        try ArchiveLaneStore.inspect(
          tapeURL: fixture.tapeURL, indexURL: fixture.indexURL,
          rootKey: self.rootKey, context: self.context) as Any
      },
    ] {
      do {
        _ = try operation()
        Issue.record("competing paired lock succeeded")
      } catch let error as ArchiveLanePersistenceError {
        guard case .lockFailed(file: .tape, errno: _) = error else {
          Issue.record("unexpected lock error: \(error)")
          continue
        }
      }
    }
  }

  @Test func archive05IndexLockContentionReleasesTheTapeLock() throws {
    let fixture = try laneFixture("index-lock-contention")
    defer { fixture.remove() }
    let initial = try open(fixture)
    initial.close()
    let indexDescriptor = Darwin.open(fixture.indexURL.path, O_RDWR | O_CLOEXEC | O_NOFOLLOW)
    #expect(indexDescriptor >= 0)
    defer { _ = Darwin.close(indexDescriptor) }
    #expect(flock(indexDescriptor, LOCK_EX | LOCK_NB) == 0)

    do {
      _ = try open(fixture)
      Issue.record("paired owner acquired a contended index lock")
    } catch let error as ArchiveLanePersistenceError {
      guard case .lockFailed(file: .index, errno: _) = error else {
        Issue.record("unexpected second-lock error: \(error)")
        return
      }
    }

    let tapeDescriptor = Darwin.open(fixture.tapeURL.path, O_RDWR | O_CLOEXEC | O_NOFOLLOW)
    #expect(tapeDescriptor >= 0)
    defer { _ = Darwin.close(tapeDescriptor) }
    #expect(flock(tapeDescriptor, LOCK_EX | LOCK_NB) == 0)
    #expect(flock(tapeDescriptor, LOCK_UN) == 0)
    #expect(flock(indexDescriptor, LOCK_UN) == 0)
    let reopened = try open(fixture)
    reopened.close()
  }

  @Test func archive05ConcurrentAppendsProduceOneExactPairedOrder() throws {
    let fixture = try laneFixture("concurrent")
    defer { fixture.remove() }
    let store = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: fixture.tapeURL, indexURL: fixture.indexURL,
      rootKey: rootKey, context: context)
    let failures = Atomic<Int>(0)

    DispatchQueue.concurrentPerform(iterations: 64) { value in
      do {
        _ = try store.appendPCM(lanePCM(UInt16(value)), observation: normalObservation())
      } catch {
        _ = failures.wrappingAdd(1, ordering: .relaxed)
      }
    }
    store.close()

    #expect(failures.load(ordering: .relaxed) == 0)
    let scan = try pairedInspection(fixture)
    #expect(scan.tape.records.count == 64)
    #expect(scan.index.records.count == 64)
    #expect(scan.index.records.map(\.payload.tapeSequence) == Array(1...64).map(UInt64.init))
    for position in 0..<64 {
      #expect(
        scan.index.records[position].payload.tapeTag
          == scan.tape.records[position].authenticationTag)
    }
  }

  private func normalObservation() -> ArchiveIndexObservation {
    ArchiveIndexObservation(
      monoNS: 1_000_000_000,
      wallNS: 2_000_000_000,
      rmsQ15: 8_192,
      nativeFrames: 12,
      inputRateNumerator: 48_000,
      inputRateDenominator: 1
    )
  }

  private func laneFixture(_ label: String) throws -> LaneFixture {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "eta-index-persistence-\(label)-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    return LaneFixture(
      directory: directory,
      tapeURL: directory.appendingPathComponent("primary.tape"),
      indexURL: directory.appendingPathComponent("primary.index"))
  }

  private func populatedFixture(_ label: String, count: Int) throws -> LaneFixture {
    let fixture = try laneFixture(label)
    let store = try open(
      fixture,
      tapeNonces: nonceSeries(start: 0x10, count: count),
      indexNonces: nonceSeries(start: 0x40, count: count))
    for value in 0..<count {
      _ = try store.appendPCM(lanePCM(UInt16(value)), observation: normalObservation())
    }
    store.close()
    return fixture
  }

  private func open(
    _ fixture: LaneFixture,
    hooks: ArchiveLanePersistenceHooks = ArchiveLanePersistenceHooks(),
    tapeNonces: [Data] = [],
    indexNonces: [Data] = []
  ) throws -> ArchiveLaneStore {
    let tapeQueue = LaneNonceQueue(tapeNonces)
    let indexQueue = LaneNonceQueue(indexNonces)
    return try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: fixture.tapeURL,
      indexURL: fixture.indexURL,
      rootKey: rootKey,
      context: context,
      hooks: hooks,
      tapeNonceProvider: { try tapeQueue.next() },
      indexNonceProvider: { try indexQueue.next() }
    )
  }

  private func pairedInspection(_ fixture: LaneFixture) throws -> ArchiveLaneScanResult {
    try ArchiveLaneStore.inspect(
      tapeURL: fixture.tapeURL, indexURL: fixture.indexURL,
      rootKey: rootKey, context: context)
  }

  private func tapeInspection(_ fixture: LaneFixture) throws -> ArchiveTapeScanResult {
    try ArchiveTapeStore.inspect(url: fixture.tapeURL, rootKey: rootKey, context: context)
  }

  private func payload(
    for tape: ArchiveTapeRecordMetadata,
    tapeSequence: UInt64? = nil,
    tapeTag: Data? = nil,
    encryptedEnd: UInt64? = nil,
    sampleStart: UInt64? = nil,
    sampleEnd: UInt64? = nil,
    deviceUID: String? = nil
  ) throws -> ArchiveIndexPayload {
    let start = sampleStart ?? tape.header.firstLogicalUnit
    let defaultEnd = tape.header.firstLogicalUnit + UInt64(tape.header.logicalUnitCount)
    return try ArchiveIndexPayload(
      tapeSequence: tapeSequence ?? tape.header.recordSequence,
      tapeTag: tapeTag ?? tape.authenticationTag,
      encryptedEnd: encryptedEnd ?? tape.encryptedEndOffset,
      sampleStart: start,
      sampleEnd: sampleEnd ?? defaultEnd,
      monoNS: 1,
      wallNS: 2,
      deviceUID: deviceUID ?? context.stableDeviceUID,
      rmsQ15: 1,
      nativeFrames: 1,
      inputRateNumerator: 16_000,
      inputRateDenominator: 1,
      discontinuity: nil,
      reason: nil,
      gapNS: nil,
      previousDurableSample: nil,
      survivingTailBytes: nil)
  }

  private func recoveryPayload(
    for tape: ArchiveTapeRecordMetadata,
    previousDurableSample: UInt64,
    encryptedOrigin: UInt64
  ) throws -> ArchiveIndexPayload {
    try ArchiveIndexPayload(
      tapeSequence: tape.header.recordSequence,
      tapeTag: tape.authenticationTag,
      encryptedEnd: tape.encryptedEndOffset,
      sampleStart: tape.header.firstLogicalUnit,
      sampleEnd: tape.header.firstLogicalUnit + UInt64(tape.header.logicalUnitCount),
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
      previousDurableSample: previousDurableSample,
      survivingTailBytes: tape.encryptedEndOffset - encryptedOrigin)
  }

  private func encodedIndex(
    _ payloads: [ArchiveIndexPayload],
    nonces: [Data],
    secondPredecessor: Data? = nil,
    encodedContextHash: Data? = nil,
    recordSequences: [UInt64]? = nil,
    encodedStreamUUID: Data? = nil,
    firstLogicalUnits: [UInt64]? = nil,
    logicalUnitCounts: [UInt32]? = nil
  ) throws -> Data {
    let queue = LaneNonceQueue(nonces)
    let sealer = try ArchivePurposeSealer(
      purpose: .index, rootKey: rootKey, streamUUID: encodedStreamUUID ?? streamUUID,
      nonceProvider: { try queue.next() })
    var result = Data()
    var predecessor = Data(repeating: 0, count: 16)
    for (position, payload) in payloads.enumerated() {
      let plaintext = try ArchiveIndexPayloadCodec.encode(payload)
      let envelope = try sealer.seal(
        plaintext,
        request: ArchiveRecordSealRequest(
          recordSequence: recordSequences?[position] ?? UInt64(position + 1),
          firstLogicalUnit: firstLogicalUnits?[position] ?? payload.sampleStart,
          logicalUnitCount: logicalUnitCounts?[position]
            ?? UInt32(payload.sampleEnd - payload.sampleStart),
          previousCommittedTag: position == 1 ? secondPredecessor ?? predecessor : predecessor,
          contextHash: encodedContextHash ?? contextHash))
      result.append(try ArchiveEnvelopeCodec.encodeUnauthenticated(envelope))
      predecessor = envelope.authenticationTag
    }
    return result
  }

  private func nonceSeries(start: UInt8, count: Int) -> [Data] {
    (0..<count).map { position in
      Data((0..<12).map { start &+ UInt8(position * 12 + $0) })
    }
  }

  private var independentFirstTapeRecord: Data {
    laneHex(
      "4554415441503031010080000000000000112233445566778899aabbccddeeff010000000000000000000000000000000400000008000000000102030405060708090a0b000000000000000000000000000000004776785c037085566905aa531bc701b0219c5950076cd21c433df74a8eccd0280100010000000000000000005cda39e6798185fe5c0b8c5c789140a3c901f0d90cfbf55c"
    )
  }

  private var independentFirstIndexRecord: Data {
    laneHex(
      "4554414944583031010080000000000000112233445566778899aabbccddeeff01000000000000000000000000000000040000007601000018191a1b1c1d1e1f20212223000000000000000000000000000000004776785c037085566905aa531bc701b0219c5950076cd21c433df74a8eccd028010002000000000000000000962f513d418885a015e56bdf3a42f7cd7c13c0a52673799000cb553750a4382db5ab5c80395b715a79dac5e7635c01627e0343685f95eeb712209d8887a3abdda8715fb593de6680b7b78fe2e7ab04d2ac4d542646a8ad5a2c82592c16020bb954c2df6e855b2ceb1fcced9db3dd0f7056519fa9637894e384586bef03e54a2abf81c93ee0792903e9f6abb8fc20fe6cc2479cb489308ccac61567fa5ba3ae3a8601148cfd7a1ad556efa98d60c920253772bd70f2240cb285c083d8811465f6206c19d40f79b36b967f82efb3cd6c55a4a70060b25b3907f276ce4b0c8c14a42737e4781900978fe38ecb2cd30b338f2d1e480722b43f501e1923c927e14ab3b86ae6aa53f83175c11cfb38342bbb0b71fd9753432ec60a47f490fa7bf225b352b22d5883e599c1623a73da76914852de970d57d4bb5fff45ebb472c3bd6bfd5f2904f4dd016c489bfc25fd8430c19db16e24a4d76948ae7524db701b48309676da65e732abb21cf6675952c0df25a6dacf4dc08b67c91212a8a6bd0245493e59e6456c11c4"
    )
  }

  private var independentSecondIndexRecord: Data {
    laneHex(
      "4554414944583031010080000000000000112233445566778899aabbccddeeff0200000000000000040000000000000002000000980100002425262728292a2b2c2d2e2fc91212a8a6bd0245493e59e6456c11c44776785c037085566905aa531bc701b0219c5950076cd21c433df74a8eccd0280100020000000000000000007383058408313eb0347f271851a74b517446e1a898de0be4434d939822509554f2b2bcc3a7133a8b3e1c46d958e498861971ad2b73f23dbcf2cab0b79561425ac8e3387fcd163e672952ce4d974ea2041ed18998a430e457a3f0fd8abf406e8cb9f31c361861dc956dba508a25650ec800ceae7acb464bff9b305bbe6941c3b9375d080f6ac19be1bf13a73a70d93dc6ebc2e4ff975c4e419e9e70b226e4cc7c3a46b6d697169eb570e112b885ffaa92b54525992da39daf87615a322e8609dc7f3b01dcbc64d4e311e648079b2b9700ae84a13524812240b533fc29b957177f8f52f1e980eca3bed1ea6611941e33ae5c1e49043b70c305a5f2ff5b1349bc793f9d64ce41ba9fb97557d05c38f6416471b81e6b646fafbce4cb309f2b91c2c1d43a9603548f8f42f948dc9a835be4f0b5f9627836cbe9bd200c09b6436ea8103bd3587146c3cfb6b14e08eddd5f7691ee30119bf75b42429d25e1cf3080ac89ec0116a2df78a1c3551e13b4f7a65ddd88ffb05a320b84f63171d077dfffa798e3386bf449c1a50278c655741c69257e535667e02da1f3082db73c63676b0c471e3c6aca5db3b406"
    )
  }

  private func goldenNormalPayload() throws -> ArchiveIndexPayload {
    try ArchiveIndexPayload(
      tapeSequence: 1,
      tapeTag: firstTapeTag,
      encryptedEnd: 152,
      sampleStart: 0,
      sampleEnd: 4,
      monoNS: 1_000_000_000,
      wallNS: 2_000_000_000,
      deviceUID: context.stableDeviceUID,
      rmsQ15: 8_192,
      nativeFrames: 12,
      inputRateNumerator: 48_000,
      inputRateDenominator: 1,
      discontinuity: nil,
      reason: nil,
      gapNS: nil,
      previousDurableSample: nil,
      survivingTailBytes: nil)
  }

  private func goldenRecoveryPayload() throws -> ArchiveIndexPayload {
    try ArchiveIndexPayload(
      tapeSequence: 2,
      tapeTag: laneHex("51a6835fa3a1de005a5a85d6d88ceb60"),
      encryptedEnd: 300,
      sampleStart: 4,
      sampleEnd: 6,
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
      previousDurableSample: 4,
      survivingTailBytes: 148)
  }
}

private struct LaneFixture {
  let directory: URL
  let tapeURL: URL
  let indexURL: URL

  func remove() {
    try? FileManager.default.removeItem(at: directory)
  }
}

private final class LaneNonceQueue: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [Data]

  init(_ values: [Data]) {
    self.values = values
  }

  func next() throws -> Data {
    try lock.withLock {
      guard !values.isEmpty else { throw ArchiveCryptoError.nonceGenerationFailed(-1) }
      return values.removeFirst()
    }
  }
}

private final class LaneEventLog: @unchecked Sendable {
  private let lock = NSLock()
  private var events: [ArchiveLanePersistenceEvent] = []

  var values: [ArchiveLanePersistenceEvent] { lock.withLock { events } }

  func append(_ event: ArchiveLanePersistenceEvent) {
    lock.withLock { events.append(event) }
  }
}

private final class LaneAsyncError: @unchecked Sendable {
  private let lock = NSLock()
  private var error: (any Error)?

  var value: (any Error)? { lock.withLock { error } }

  func set(_ error: any Error) {
    lock.withLock { self.error = error }
  }
}

private final class LaneShortWritePlan: @unchecked Sendable {
  private let lock = NSLock()
  private var writes = 0
  private var syncs = 0

  var writeCalls: Int { lock.withLock { writes } }
  var syncCalls: Int { lock.withLock { syncs } }

  func write(descriptor: Int32, pointer: UnsafeRawPointer, count: Int) -> Int {
    lock.withLock {
      writes += 1
      if writes == 1 {
        errno = EINTR
        return -1
      }
      return Darwin.write(descriptor, pointer, min(count, 11))
    }
  }

  func fullSync(_ descriptor: Int32) -> Int32 {
    lock.withLock {
      syncs += 1
      if syncs == 1 {
        errno = EINTR
        return -1
      }
      return fcntl(descriptor, F_FULLFSYNC)
    }
  }
}

private final class LaneIndexShortReadPlan: @unchecked Sendable {
  private let lock = NSLock()
  private let indexDevice: dev_t
  private let indexInode: ino_t
  private var reads = 0

  var indexReadCalls: Int { lock.withLock { reads } }

  init(indexURL: URL) throws {
    var fileStat = stat()
    guard lstat(indexURL.path, &fileStat) == 0 else {
      throw CocoaError(.fileReadUnknown)
    }
    indexDevice = fileStat.st_dev
    indexInode = fileStat.st_ino
  }

  func read(
    descriptor: Int32,
    pointer: UnsafeMutableRawPointer,
    count: Int,
    offset: off_t
  ) -> Int {
    lock.withLock {
      var descriptorStat = stat()
      guard fstat(descriptor, &descriptorStat) == 0 else {
        errno = EBADF
        return -1
      }
      guard descriptorStat.st_dev == indexDevice, descriptorStat.st_ino == indexInode else {
        return Darwin.pread(descriptor, pointer, count, offset)
      }
      reads += 1
      if reads == 1 {
        errno = EINTR
        return -1
      }
      return Darwin.pread(descriptor, pointer, min(count, 7), offset)
    }
  }
}

private final class LaneFaultPlan: @unchecked Sendable {
  private let lock = NSLock()
  private let failAt: ArchiveLanePersistenceEvent
  private var current: ArchiveLanePersistenceEvent?
  private var failed = false

  init(failAt: ArchiveLanePersistenceEvent) {
    self.failAt = failAt
  }

  func observe(_ event: ArchiveLanePersistenceEvent) {
    lock.withLock { current = event }
  }

  func fullSync(_ descriptor: Int32) -> Int32 {
    lock.withLock {
      if !failed, current == failAt {
        failed = true
        errno = EIO
        return -1
      }
      return fcntl(descriptor, F_FULLFSYNC)
    }
  }
}

private final class LaneNthIndexWriteFailure: @unchecked Sendable {
  private let lock = NSLock()
  private let failAt: Int
  private var current: ArchiveLanePersistenceEvent?
  private var indexWrites = 0

  init(failAt: Int) {
    self.failAt = failAt
  }

  func observe(_ event: ArchiveLanePersistenceEvent) {
    lock.withLock {
      current = event
      if event == .indexWrite { indexWrites += 1 }
    }
  }

  func write(descriptor: Int32, pointer: UnsafeRawPointer, count: Int) -> Int {
    lock.withLock {
      if current == .indexWrite, indexWrites == failAt {
        errno = EIO
        return -1
      }
      return Darwin.write(descriptor, pointer, count)
    }
  }
}

private final class LaneBoundaryFaultPlan: @unchecked Sendable {
  private let lock = NSLock()
  private let failAt: ArchiveLanePersistenceEvent
  private var current: ArchiveLanePersistenceEvent?
  private var failed = false

  init(failAt: ArchiveLanePersistenceEvent) {
    self.failAt = failAt
  }

  func observe(_ event: ArchiveLanePersistenceEvent) {
    lock.withLock { current = event }
  }

  func write(descriptor: Int32, pointer: UnsafeRawPointer, count: Int) -> Int {
    lock.withLock {
      if shouldFail() {
        errno = EIO
        return -1
      }
      return Darwin.write(descriptor, pointer, count)
    }
  }

  func fullSync(_ descriptor: Int32) -> Int32 {
    lock.withLock {
      if shouldFail() {
        errno = EIO
        return -1
      }
      return fcntl(descriptor, F_FULLFSYNC)
    }
  }

  func sync(_ directory: URL) throws {
    try lock.withLock {
      if shouldFail() {
        throw ArchiveLanePersistenceError.directorySyncFailed(
          file: current == .indexDirectorySync ? .index : .tape,
          path: directory.path,
          errno: EIO)
      }
      let descriptor = Darwin.open(directory.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
      guard descriptor >= 0 else {
        throw ArchiveLanePersistenceError.directorySyncFailed(
          file: .tape, path: directory.path, errno: errno)
      }
      defer { _ = Darwin.close(descriptor) }
      guard fsync(descriptor) == 0 else {
        throw ArchiveLanePersistenceError.directorySyncFailed(
          file: .tape, path: directory.path, errno: errno)
      }
    }
  }

  private func shouldFail() -> Bool {
    guard !failed, current == failAt else { return false }
    failed = true
    return true
  }
}

private final class LaneDirectoryFaultPlan: @unchecked Sendable {
  private let lock = NSLock()
  private var current: ArchiveLanePersistenceEvent?

  func observe(_ event: ArchiveLanePersistenceEvent) {
    lock.withLock { current = event }
  }

  func sync(_ directory: URL) throws {
    try lock.withLock {
      if current == .indexDirectorySync {
        throw ArchiveLanePersistenceError.directorySyncFailed(
          file: .index, path: directory.path, errno: EIO)
      }
      let descriptor = Darwin.open(directory.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
      guard descriptor >= 0 else {
        throw ArchiveLanePersistenceError.directorySyncFailed(
          file: .tape, path: directory.path, errno: errno)
      }
      defer { _ = Darwin.close(descriptor) }
      guard fsync(descriptor) == 0 else {
        throw ArchiveLanePersistenceError.directorySyncFailed(
          file: .tape, path: directory.path, errno: errno)
      }
    }
  }
}

private func truncateURL(_ url: URL, to offset: UInt64) throws {
  let descriptor = Darwin.open(url.path, O_RDWR | O_CLOEXEC | O_NOFOLLOW)
  guard descriptor >= 0 else { throw CocoaError(.fileNoSuchFile) }
  defer { _ = Darwin.close(descriptor) }
  guard ftruncate(descriptor, off_t(offset)) == 0 else { throw CocoaError(.fileWriteUnknown) }
}

private func lanePCM(_ sample: UInt16) -> Data {
  Data([UInt8(truncatingIfNeeded: sample), UInt8(truncatingIfNeeded: sample >> 8)])
}

private func laneHex(_ hex: String) -> Data {
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
