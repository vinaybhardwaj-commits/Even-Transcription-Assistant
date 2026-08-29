import CryptoKit
import Darwin
import Foundation
import Security
import Synchronization
import Testing

@testable import RoomRecorderCore
@testable import TapeCapture
@testable import TapeCore

@Suite(.serialized) struct ArchiveKeyLifecycleP1Tests {
  private let root = keyHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
  private let stream = keyHex("00112233445566778899aabbccddeeff")

  private var context: ArchiveContext {
    return ArchiveContext(
      streamUUID: stream,
      roomID: "room_1",
      istDate: "2026-08-27",
      laneID: "primary",
      stableDeviceUID: "AppleUSBAudioEngine:test")
  }

  private var controlContext: ArchiveContext {
    var controlStream = Data(repeating: 0xCC, count: 16)
    controlStream[6] = (controlStream[6] & 0x0F) | 0x40
    controlStream[8] = (controlStream[8] & 0x3F) | 0x80
    return ArchiveContext(
      streamUUID: controlStream,
      roomID: "room_1",
      istDate: "2026-08-27",
      laneID: "_control",
      stableDeviceUID: "")
  }

  @Test func key01FreezesIndependentOuterAndPlaintextVectorsIncludingDataSlice() throws {
    let outer = ArchiveKeywrapOuter(
      streamUUID: keyHex("000102030405060708090a0b0c0d0e0f"),
      contextHash: keyHex("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f"),
      publicKeyHash: keyHex("404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f"),
      wrappedData: keyHex("aabbcc"))
    let independentOuter = keyHex(
      "4554414b455930310100010068000000"
        + "000102030405060708090a0b0c0d0e0f"
        + "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f"
        + "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f"
        + "0300000000000000aabbcc")
    #expect(try ArchiveKeywrapCodec.encode(outer) == independentOuter)
    let backing = Data([0xFF]) + independentOuter
    let slice = backing[backing.index(after: backing.startIndex)...]
    let decodedOuter = try ArchiveKeywrapCodec.decode(slice)
    #expect(decodedOuter.streamUUID == outer.streamUUID)
    #expect(decodedOuter.contextHash == outer.contextHash)
    #expect(decodedOuter.publicKeyHash == outer.publicKeyHash)
    #expect(decodedOuter.wrappedData == outer.wrappedData)

    let plaintext = ArchiveKeywrapPlaintext(
      rootKey: root,
      streamUUID: keyHex("101112131415161718191a1b1c1d1e1f"),
      contextHash: keyHex("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f"),
      wrapID: keyHex("404142434445464748494a4b4c4d4e4f"))
    let independentPlaintext = keyHex(
      "4554414b455950310100000000000000"
        + "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
        + "101112131415161718191a1b1c1d1e1f"
        + "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f"
        + "404142434445464748494a4b4c4d4e4f")
    #expect(try ArchiveKeywrapPlaintextCodec.encode(plaintext) == independentPlaintext)
    let decodedPlaintext = try ArchiveKeywrapPlaintextCodec.decode(independentPlaintext)
    #expect(decodedPlaintext.rootKey == plaintext.rootKey)
    #expect(decodedPlaintext.streamUUID == plaintext.streamUUID)
    #expect(decodedPlaintext.contextHash == plaintext.contextHash)
    #expect(decodedPlaintext.wrapID == plaintext.wrapID)
  }

  @Test func key01RejectsEveryOuterTruncationAndMalformedBoundary() throws {
    let valid = try encodedOuter(wrappedData: Data([1, 2, 3]))
    for count in 0..<ArchiveKeywrapCodec.headerByteCount {
      #expect(throws: ArchiveKeyLifecycleFailure.self) {
        try ArchiveKeywrapCodec.decode(Data(valid.prefix(count)))
      }
    }
    let mutations: [(Int, UInt8)] = [(0, 1), (8, 2), (10, 2), (12, 103), (100, 1)]
    for (offset, byte) in mutations {
      var changed = valid
      changed[offset] = byte
      #expect(throws: ArchiveKeyLifecycleFailure.self) { try ArchiveKeywrapCodec.decode(changed) }
    }
    var zero = valid
    zero.replaceSubrange(96..<100, with: [0, 0, 0, 0])
    #expect(throws: ArchiveKeyLifecycleFailure.emptyWrappedData) {
      try ArchiveKeywrapCodec.decode(zero)
    }
    var excessive = Data(valid.prefix(ArchiveKeywrapCodec.headerByteCount))
    excessive.replaceSubrange(96..<100, with: [1, 16, 0, 0])
    #expect(throws: ArchiveKeyLifecycleFailure.wrappedDataTooLarge(4_097)) {
      try ArchiveKeywrapCodec.decode(excessive)
    }
    #expect(throws: ArchiveKeyLifecycleFailure.self) {
      try ArchiveKeywrapCodec.decode(Data(valid.dropLast()))
    }
    #expect(throws: ArchiveKeyLifecycleFailure.self) {
      try ArchiveKeywrapCodec.decode(valid + Data([0]))
    }
  }

  @Test func key01RejectsPlaintextMagicVersionReservedLengthAndOuterEncodeLengths() throws {
    let valid = try ArchiveKeywrapPlaintextCodec.encode(
      ArchiveKeywrapPlaintext(
        rootKey: root,
        streamUUID: stream,
        contextHash: try context.sha256(),
        wrapID: Data(repeating: 7, count: 16)))
    for (offset, byte) in [(0, UInt8(1)), (8, UInt8(2)), (10, UInt8(1))] {
      var changed = valid
      changed[offset] = byte
      #expect(throws: ArchiveKeyLifecycleFailure.self) {
        try ArchiveKeywrapPlaintextCodec.decode(changed)
      }
    }
    #expect(throws: ArchiveKeyLifecycleFailure.wrongPlaintextLength(111)) {
      try ArchiveKeywrapPlaintextCodec.decode(Data(valid.dropLast()))
    }
    #expect(throws: ArchiveKeyLifecycleFailure.self) {
      try ArchiveKeywrapCodec.encode(
        ArchiveKeywrapOuter(
          streamUUID: Data(repeating: 0, count: 15),
          contextHash: Data(repeating: 0, count: 32),
          publicKeyHash: Data(repeating: 0, count: 32),
          wrappedData: Data([1])))
    }
    #expect(throws: ArchiveKeyLifecycleFailure.wrappedDataTooLarge(4_097)) {
      try ArchiveKeywrapCodec.encode(
        ArchiveKeywrapOuter(
          streamUUID: Data(repeating: 0, count: 16),
          contextHash: Data(repeating: 0, count: 32),
          publicKeyHash: Data(repeating: 0, count: 32),
          wrappedData: Data(repeating: 0, count: 4_097)))
    }
  }

  @Test func key02EEXISTCleanupNeverDoubleClosesTheOwnedTemporary() throws {
    let fixture = try KeyFixture("publisher-eexist-close")
    defer { fixture.remove() }
    let existing = try encodedOuter(wrappedData: Data([1]))
    try existing.write(to: fixture.keywrapURL)
    #expect(chmod(fixture.keywrapURL.path, S_IRUSR | S_IWUSR) == 0)
    let temporaryDescriptor = LockedDescriptor()
    let closes = LockedDescriptorCounts()
    var hooks = ArchiveKeyIOHooks()
    hooks.temporarySuffix = { "owned" }
    hooks.openAt = { directory, name, flags, permissions in
      let descriptor = Darwin.openat(directory, name, flags, permissions)
      if descriptor >= 0, name.contains(".tmp.owned") { temporaryDescriptor.set(descriptor) }
      return descriptor
    }
    hooks.close = { descriptor in
      closes.record(descriptor)
      return Darwin.close(descriptor)
    }
    hooks.renameExclusiveAt = { _, _, _ in
      errno = EEXIST
      return -1
    }
    hooks.unlinkAt = { _, name in
      if name.contains(".tmp.owned") {
        errno = EACCES
        return -1
      }
      errno = ENOENT
      return -1
    }
    let path = try ArchiveValidatedKeyPaths.resolve(fixture.keywrapURL, hooks: hooks)
    #expect(throws: ArchiveKeyLifecycleFailure.temporaryCleanupFailed(errno: EACCES)) {
      try ArchiveKeyDurableStore(hooks: hooks).publishCreateOnly(Data([2]), at: path)
    }
    let descriptor = try #require(temporaryDescriptor.value)
    #expect(closes.count(for: descriptor) == 1)
    #expect(try Data(contentsOf: fixture.keywrapURL) == existing)
  }

  @Test func key02DirectorySyncUncertaintyLeavesPublishedBytesAndRequiresFreshOwner() throws {
    let fixture = try KeyFixture("publisher-directory")
    defer { fixture.remove() }
    let security = FakeArchiveSecurityProvider()
    let syncCalls = LockedCounter()
    var hooks = ArchiveKeyIOHooks()
    hooks.directorySync = { descriptor in
      if syncCalls.increment() == 7 {
        errno = EIO
        return -1
      }
      return Darwin.fsync(descriptor)
    }
    let lifecycle = makeLifecycle(fixture, security: security, ioHooks: hooks)
    #expect(throws: ArchiveKeyLifecycleFailure.publicationUncertain) {
      try lifecycle.openLaneStoreDetailed(
        keywrapURL: fixture.keywrapURL,
        tapeURL: fixture.tapeURL,
        indexURL: fixture.indexURL,
        context: context)
    }
    #expect(FileManager.default.fileExists(atPath: fixture.keywrapURL.path))
    #expect(throws: ArchiveKeyLifecycleFailure.ownerPoisoned) {
      try lifecycle.openLaneStoreDetailed(
        keywrapURL: fixture.keywrapURL,
        tapeURL: fixture.tapeURL,
        indexURL: fixture.indexURL,
        context: context)
    }
    let fresh = makeLifecycle(fixture, security: security)
    let store = try fresh.openLaneStoreDetailed(
      keywrapURL: fixture.keywrapURL,
      tapeURL: fixture.tapeURL,
      indexURL: fixture.indexURL,
      context: context)
    store.close()
  }

  @Test func key03FreshProvisionUsesExactSecurityContractAndReopensWithoutRegeneration() throws {
    let fixture = try KeyFixture("fresh")
    defer { fixture.remove() }
    let security = FakeArchiveSecurityProvider()
    let random = OrderedRandom([root, Data(repeating: 0xA5, count: 16)])
    let lifecycle = makeLifecycle(fixture, security: security, random: random.next)
    let store = try lifecycle.openLaneStoreDetailed(
      keywrapURL: fixture.keywrapURL,
      tapeURL: fixture.tapeURL,
      indexURL: fixture.indexURL,
      context: context)
    store.close()

    #expect(security.createCalls.count == 1)
    #expect(security.queryCalls.count == 2)
    #expect(security.accessibility == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
    #expect(security.accessFlags == [.privateKeyUsage])
    try expectExactQuery(security.queryCalls[0])
    try expectExactCreation(security.createCalls[0], accessControl: security.accessControl)
    #expect(
      security.algorithms == [
        .eciesEncryptionCofactorVariableIVX963SHA256AESGCM,
        .eciesEncryptionCofactorVariableIVX963SHA256AESGCM,
      ])
    #expect(security.operations == [.encrypt, .encrypt])
    #expect(random.remaining == 0)
    let inspection = try ArchiveKeyLifecycle.inspectKeywrap(at: fixture.keywrapURL)
    #expect(!inspection.authenticated)
    #expect(inspection.algorithmID == 1)
    #expect(inspection.wrappedByteCount > 0)
    #expect(inspection.publicKeyHashHex == keySHA256(security.publicRepresentation))

    let reopened = makeLifecycle(
      fixture,
      security: security,
      random: { _ in throw ArchiveKeyLifecycleFailure.randomGenerationFailed(-1) })
    let reopenedStore = try reopened.openLaneStoreDetailed(
      keywrapURL: fixture.keywrapURL,
      tapeURL: fixture.tapeURL,
      indexURL: fixture.indexURL,
      context: context)
    reopenedStore.close()
    #expect(security.createCalls.count == 1)
    #expect(security.operations.suffix(2) == [.decrypt, .decrypt])
  }

  @Test func key03RandomFailurePublishesNothing() throws {
    for failureCall in 1...2 {
      let fixture = try KeyFixture("random-\(failureCall)")
      defer { fixture.remove() }
      let security = FakeArchiveSecurityProvider()
      let calls = LockedCounter()
      let lifecycle = makeLifecycle(fixture, security: security) { count in
        if calls.increment() == failureCall {
          throw ArchiveKeyLifecycleFailure.randomGenerationFailed(-50)
        }
        return Data(repeating: UInt8(count), count: count)
      }
      #expect(throws: ArchiveKeyLifecycleFailure.randomGenerationFailed(-50)) {
        try lifecycle.openLaneStoreDetailed(
          keywrapURL: fixture.keywrapURL,
          tapeURL: fixture.tapeURL,
          indexURL: fixture.indexURL,
          context: context)
      }
      #expect(!FileManager.default.fileExists(atPath: fixture.keywrapURL.path))
      #expect(!FileManager.default.fileExists(atPath: fixture.tapeURL.path))
      #expect(!FileManager.default.fileExists(atPath: fixture.indexURL.path))
    }
  }

  @Test func key03DailyStreamUUIDUsesInjectedSecureBytesAndRFC4122Bits() throws {
    let fixture = try KeyFixture("daily-stream")
    defer { fixture.remove() }
    let random = OrderedRandom([Data(repeating: 0xFF, count: 16)])
    let lifecycle = makeLifecycle(
      fixture,
      security: FakeArchiveSecurityProvider(),
      random: random.next)
    let streamUUID = try lifecycle.makeDailyStreamUUID()
    #expect(streamUUID.count == 16)
    #expect(streamUUID[6] >> 4 == 4)
    #expect(streamUUID[8] >> 6 == 2)
    #expect(random.remaining == 0)
    #expect(throws: ArchiveKeyLifecycleError.archiveKeyUnavailable) {
      try lifecycle.makeDailyStreamUUID()
    }
  }

  @Test func key03MissingInaccessibleDuplicateAndConcurrentProvisionFailClosed() throws {
    let missing = try KeyFixture("existing-no-key")
    defer { missing.remove() }
    let populatedSecurity = FakeArchiveSecurityProvider()
    try writeWrap(missing, security: populatedSecurity, context: context)
    populatedSecurity.removeAllKeys()
    #expect(throws: ArchiveKeyLifecycleFailure.keyMissingForExistingArchive) {
      try makeLifecycle(missing, security: populatedSecurity).openLaneStoreDetailed(
        keywrapURL: missing.keywrapURL,
        tapeURL: missing.tapeURL,
        indexURL: missing.indexURL,
        context: context)
    }

    let inaccessible = try KeyFixture("inaccessible")
    defer { inaccessible.remove() }
    let inaccessibleSecurity = FakeArchiveSecurityProvider()
    inaccessibleSecurity.queryFailure = errSecInteractionNotAllowed
    #expect(throws: ArchiveKeyLifecycleFailure.keyQueryFailed(errSecInteractionNotAllowed)) {
      try makeLifecycle(inaccessible, security: inaccessibleSecurity).openLaneStoreDetailed(
        keywrapURL: inaccessible.keywrapURL,
        tapeURL: inaccessible.tapeURL,
        indexURL: inaccessible.indexURL,
        context: context)
    }

    let duplicate = try KeyFixture("multiple")
    defer { duplicate.remove() }
    let duplicateSecurity = FakeArchiveSecurityProvider(initialKeyCount: 2)
    #expect(throws: ArchiveKeyLifecycleFailure.multipleTaggedKeys(2)) {
      try makeLifecycle(duplicate, security: duplicateSecurity).openLaneStoreDetailed(
        keywrapURL: duplicate.keywrapURL,
        tapeURL: duplicate.tapeURL,
        indexURL: duplicate.indexURL,
        context: context)
    }

  }

  @Test func key03PublicOwnersOnDifferentArchivesShareOneCanonicalGlobalLock() throws {
    let fixture = try KeyFixture("concurrent")
    defer { fixture.remove() }
    let security = FakeArchiveSecurityProvider()
    security.emptyQueryDelay = 0.05
    let errors = LockedErrors()
    let archives = try (0..<2).map { index in
      let directory = fixture.directory.appendingPathComponent(
        "archive-\(index)", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
      return (
        keywrap: directory.appendingPathComponent("keywrap.eak"),
        tape: directory.appendingPathComponent("primary.tape"),
        index: directory.appendingPathComponent("primary.index")
      )
    }
    DispatchQueue.concurrentPerform(iterations: archives.count) { index in
      do {
        let store = try makeLifecycle(fixture, security: security).openLaneStore(
          keywrapURL: archives[index].keywrap,
          tapeURL: archives[index].tape,
          indexURL: archives[index].index,
          context: context)
        store.close()
      } catch {
        errors.append(error)
      }
    }
    #expect(errors.values.isEmpty)
    #expect(security.createCalls.count == 1)
    #expect(archives.allSatisfy { FileManager.default.fileExists(atPath: $0.keywrap.path) })
    let evenScribe = fixture.directory.appendingPathComponent("EvenScribe", isDirectory: true)
    let roomRecorder = evenScribe.appendingPathComponent("RoomRecorder", isDirectory: true)
    let globalLock = roomRecorder.appendingPathComponent("archive-wrap-v1.lock")
    #expect(try permissions(of: evenScribe) == mode_t(0o700))
    #expect(try permissions(of: roomRecorder) == mode_t(0o700))
    #expect(try permissions(of: globalLock) == mode_t(0o600))
  }

  @Test func key04ExistingTapeWithoutWrapNeverQueriesOrCreatesAndWrapWithoutTapeOpens() throws {
    let tapeOnly = try KeyFixture("tape-no-wrap")
    defer { tapeOnly.remove() }
    try Data([1]).write(to: tapeOnly.tapeURL)
    #expect(chmod(tapeOnly.tapeURL.path, S_IRUSR | S_IWUSR) == 0)
    let untouchedSecurity = FakeArchiveSecurityProvider()
    #expect(throws: ArchiveKeyLifecycleFailure.existingArchiveWithoutKeywrap) {
      try makeLifecycle(tapeOnly, security: untouchedSecurity).openLaneStoreDetailed(
        keywrapURL: tapeOnly.keywrapURL,
        tapeURL: tapeOnly.tapeURL,
        indexURL: tapeOnly.indexURL,
        context: context)
    }
    #expect(untouchedSecurity.queryCalls.isEmpty)
    #expect(untouchedSecurity.createCalls.isEmpty)
    #expect(try Data(contentsOf: tapeOnly.tapeURL) == Data([1]))

    let wrapOnly = try KeyFixture("wrap-no-tape")
    defer { wrapOnly.remove() }
    let security = FakeArchiveSecurityProvider()
    try writeWrap(wrapOnly, security: security, context: context)
    let store = try makeLifecycle(wrapOnly, security: security).openLaneStoreDetailed(
      keywrapURL: wrapOnly.keywrapURL,
      tapeURL: wrapOnly.tapeURL,
      indexURL: wrapOnly.indexURL,
      context: context)
    store.close()
    #expect(FileManager.default.fileExists(atPath: wrapOnly.tapeURL.path))
    #expect(FileManager.default.fileExists(atPath: wrapOnly.indexURL.path))
  }

  @Test func key04ExistingSnapshotAuthenticatesWithoutProvisioningOrRootRelease() throws {
    let fixture = try KeyFixture("existing-snapshot")
    defer { fixture.remove() }
    let security = FakeArchiveSecurityProvider()
    let lifecycle = makeLifecycle(fixture, security: security)
    let writer = try lifecycle.openLaneStore(
      keywrapURL: fixture.keywrapURL,
      tapeURL: fixture.tapeURL,
      indexURL: fixture.indexURL,
      context: context
    )
    _ = try writer.appendPCM(
      keyHex("01000200"),
      observation: ArchiveIndexObservation(
        monoNS: 1,
        wallNS: 2,
        rmsQ15: 3,
        nativeFrames: 2,
        inputRateNumerator: 16_000,
        inputRateDenominator: 1
      ))
    writer.close()
    let createCount = security.createCalls.count

    let opened = try lifecycle.openExistingLaneSnapshotWithInspection(
      keywrapURL: fixture.keywrapURL,
      tapeURL: fixture.tapeURL,
      indexURL: fixture.indexURL,
      context: context,
      initialSamplePosition: 0
    )
    let snapshot = opened.snapshot
    defer { snapshot.close() }
    #expect(opened.keywrap.authenticated)
    #expect(opened.keywrap.keywrapDigestHex.count == 64)
    #expect(snapshot.authenticatedFacts.authenticatedSampleEnd == 2)
    #expect(try snapshot.readPCMRange(sampleStart: 0, sampleEnd: 2).pcm == keyHex("01000200"))
    #expect(security.createCalls.count == createCount)

    let missing = try KeyFixture("existing-snapshot-missing")
    defer { missing.remove() }
    #expect(throws: ArchiveKeyLifecycleError.archiveKeyUnavailable) {
      try makeLifecycle(missing, security: security).openExistingLaneSnapshot(
        keywrapURL: missing.keywrapURL,
        tapeURL: missing.tapeURL,
        indexURL: missing.indexURL,
        context: context,
        initialSamplePosition: 0
      )
    }
    #expect(!FileManager.default.fileExists(atPath: missing.keywrapURL.path))
    #expect(!FileManager.default.fileExists(atPath: missing.tapeURL.path))
    #expect(!FileManager.default.fileExists(atPath: missing.indexURL.path))
  }

  @Test func retainedLaneBuilderPublishesOnlyAfterAuthenticatedOpenAndRerunsIdempotently() throws {
    let fixture = try KeyFixture("retained-builder")
    defer { fixture.remove() }
    #expect(chmod(fixture.directory.path, mode_t(0o700)) == 0)
    let security = FakeArchiveSecurityProvider()
    var streamUUID = stream
    streamUUID[6] = (streamUUID[6] & 0x0F) | 0x40
    streamUUID[8] = (streamUUID[8] & 0x3F) | 0x80
    let retainedContext = ArchiveContext(
      streamUUID: streamUUID,
      roomID: "room_1",
      istDate: "2026-08-27",
      laneID: "primary",
      stableDeviceUID: "AppleUSBAudioEngine:test"
    )
    let lifecycle = makeLifecycle(fixture, security: security)
    let builder = try ArchiveRetainedLaneBuilder(
      rootURL: fixture.directory,
      keyLifecycle: lifecycle
    )

    let first = try builder.openLane(context: retainedContext, initialSamplePosition: 480)
    let descriptorBytes = try Data(contentsOf: first.catalogEntry.layout.descriptorURL)
    first.store.close()
    let second = try builder.openLane(context: retainedContext, initialSamplePosition: 480)
    second.store.close()

    #expect(first.keywrap.authenticated)
    #expect(first.catalogEntry.descriptor.keywrapDigestHex == first.keywrap.keywrapDigestHex)
    #expect(try Data(contentsOf: second.catalogEntry.layout.descriptorURL) == descriptorBytes)
    #expect(try ArchiveRetainedLaneCatalog(rootURL: fixture.directory).scan().count == 1)
  }

  @Test func key04UnwrapInspectionRequiresExistingWrapAndNeverCreatesLanes() throws {
    let fixture = try KeyFixture("unwrap-inspection")
    defer { fixture.remove() }
    let security = FakeArchiveSecurityProvider()
    #expect(throws: ArchiveKeyLifecycleFailure.existingArchiveWithoutKeywrap) {
      try makeLifecycle(fixture, security: security).inspectExistingKeywrapDetailed(
        keywrapURL: fixture.keywrapURL, context: context)
    }
    #expect(security.queryCalls.isEmpty)
    try writeWrap(fixture, security: security, context: context)
    let inspection = try makeLifecycle(fixture, security: security).inspectExistingKeywrapDetailed(
      keywrapURL: fixture.keywrapURL, context: context)
    #expect(inspection.streamUUIDHex == stream.keyHexForTest)
    #expect(inspection.wrappedByteCount > 0)
    #expect(!FileManager.default.fileExists(atPath: fixture.tapeURL.path))
    #expect(!FileManager.default.fileExists(atPath: fixture.indexURL.path))
  }

  @Test func key04OpenWithInspectionUsesTheHeldWrapAcrossFormerSubstitutionBoundary() throws {
    let fixture = try KeyFixture("held-wrap-inspection")
    defer { fixture.remove() }
    let replacementFixture = try KeyFixture("held-wrap-replacement")
    defer { replacementFixture.remove() }
    let security = FakeArchiveSecurityProvider()
    try writeWrap(fixture, security: security, context: context)
    let originalBytes = try Data(contentsOf: fixture.keywrapURL)

    let replacementRoot = Data(repeating: 0xD1, count: 32)
    let replacementLifecycle = makeLifecycle(
      replacementFixture,
      security: security,
      random: OrderedRandom([
        replacementRoot, Data(repeating: 0xD2, count: 16),
      ]).next)
    let replacementStore = try replacementLifecycle.openLaneStoreDetailed(
      keywrapURL: replacementFixture.keywrapURL,
      tapeURL: replacementFixture.tapeURL,
      indexURL: replacementFixture.indexURL,
      context: context)
    replacementStore.close()
    let replacementBytes = try Data(contentsOf: replacementFixture.keywrapURL)
    #expect(keySHA256(originalBytes) != keySHA256(replacementBytes))

    let substitutions = LockedCounter()
    let lifecycle = makeLifecycle(
      fixture,
      security: security,
      onRootRelease: { releasedRoot in
        #expect(releasedRoot == root)
        _ = substitutions.increment()
        try replacementBytes.write(to: fixture.keywrapURL, options: .atomic)
        guard chmod(fixture.keywrapURL.path, S_IRUSR | S_IWUSR) == 0 else {
          throw ArchiveKeyLifecycleFailure.fileStatFailed(errno: errno)
        }
      })
    let opened = try lifecycle.openLaneStoreWithInspection(
      keywrapURL: fixture.keywrapURL,
      tapeURL: fixture.tapeURL,
      indexURL: fixture.indexURL,
      context: context)
    #expect(substitutions.value == 1)
    #expect(opened.keywrap.authenticated)
    #expect(opened.keywrap.keywrapDigestHex == keySHA256(originalBytes))
    #expect(opened.keywrap.keywrapDigestHex != keySHA256(replacementBytes))
    #expect(keySHA256(try Data(contentsOf: fixture.keywrapURL)) == keySHA256(replacementBytes))
    _ = try opened.store.appendPCM(
      keyHex("01000200"),
      observation: ArchiveIndexObservation(
        monoNS: 1,
        wallNS: 2,
        rmsQ15: 3,
        nativeFrames: 2,
        inputRateNumerator: 16_000,
        inputRateDenominator: 1))
    opened.store.close()

    let authenticated = try ArchiveLaneStore.inspect(
      tapeURL: fixture.tapeURL,
      indexURL: fixture.indexURL,
      rootKey: root,
      context: context)
    #expect(authenticated.tape.records.count == 1)
    #expect(throws: ArchiveCryptoError.authenticationFailed) {
      try ArchiveLaneStore.inspect(
        tapeURL: fixture.tapeURL,
        indexURL: fixture.indexURL,
        rootKey: replacementRoot,
        context: context)
    }
  }

  @Test func key04RejectsWrongRoomDayLaneDeviceControlAndStreamBeforeRootRelease() throws {
    let fixture = try KeyFixture("wrong-context")
    defer { fixture.remove() }
    let security = FakeArchiveSecurityProvider()
    try writeWrap(fixture, security: security, context: context)
    let wrongContexts = [
      ArchiveContext(
        streamUUID: stream, roomID: "room_2", istDate: "2026-08-27", laneID: "primary",
        stableDeviceUID: "AppleUSBAudioEngine:test"),
      ArchiveContext(
        streamUUID: stream, roomID: "room_1", istDate: "2026-08-28", laneID: "primary",
        stableDeviceUID: "AppleUSBAudioEngine:test"),
      ArchiveContext(
        streamUUID: stream, roomID: "room_1", istDate: "2026-08-27", laneID: "backup",
        stableDeviceUID: "AppleUSBAudioEngine:test"),
      ArchiveContext(
        streamUUID: stream, roomID: "room_1", istDate: "2026-08-27", laneID: "primary",
        stableDeviceUID: "AppleUSBAudioEngine:other"),
      ArchiveContext(
        streamUUID: stream, roomID: "room_1", istDate: "2026-08-27", laneID: "_control",
        stableDeviceUID: ""),
      ArchiveContext(
        streamUUID: Data(repeating: 9, count: 16), roomID: "room_1", istDate: "2026-08-27",
        laneID: "primary", stableDeviceUID: "AppleUSBAudioEngine:test"),
    ]
    for wrong in wrongContexts {
      let releases = LockedCounter()
      let lifecycle = makeLifecycle(
        fixture, security: security,
        onRootRelease: { _ in
          _ = releases.increment()
        })
      #expect(throws: ArchiveKeyLifecycleFailure.self) {
        try lifecycle.openLaneStoreDetailed(
          keywrapURL: fixture.keywrapURL,
          tapeURL: fixture.tapeURL,
          indexURL: fixture.indexURL,
          context: wrong)
      }
      #expect(releases.value == 0)
    }
  }

  @Test func key04RejectsPublicHashCiphertextInnerSubstitutionAndUnsupportedAlgorithm() throws {
    for mutation in WrapMutation.allCases {
      let fixture = try KeyFixture("mutation-\(mutation.rawValue)")
      defer { fixture.remove() }
      let security = FakeArchiveSecurityProvider()
      try writeWrap(fixture, security: security, context: context)
      mutation.apply(to: fixture.keywrapURL, security: security)
      let releases = LockedCounter()
      let lifecycle = makeLifecycle(
        fixture, security: security,
        onRootRelease: { _ in
          _ = releases.increment()
        })
      #expect(throws: ArchiveKeyLifecycleFailure.self) {
        try lifecycle.openLaneStoreDetailed(
          keywrapURL: fixture.keywrapURL,
          tapeURL: fixture.tapeURL,
          indexURL: fixture.indexURL,
          context: context)
      }
      #expect(releases.value == 0)
    }

    let unsupported = try KeyFixture("unsupported")
    defer { unsupported.remove() }
    let security = FakeArchiveSecurityProvider()
    security.algorithmSupported = false
    #expect(throws: ArchiveKeyLifecycleFailure.algorithmUnavailable) {
      try makeLifecycle(unsupported, security: security).openLaneStoreDetailed(
        keywrapURL: unsupported.keywrapURL,
        tapeURL: unsupported.tapeURL,
        indexURL: unsupported.indexURL,
        context: context)
    }
    #expect(!FileManager.default.fileExists(atPath: unsupported.keywrapURL.path))

    let shortPublic = try KeyFixture("short-public")
    defer { shortPublic.remove() }
    let shortSecurity = FakeArchiveSecurityProvider()
    shortSecurity.publicRepresentation = Data(repeating: 1, count: 64)
    #expect(throws: ArchiveKeyLifecycleFailure.invalidPublicKeyRepresentationLength(64)) {
      try makeLifecycle(shortPublic, security: shortSecurity).openLaneStoreDetailed(
        keywrapURL: shortPublic.keywrapURL,
        tapeURL: shortPublic.tapeURL,
        indexURL: shortPublic.indexURL,
        context: context)
    }
  }

  @Test func key04FreshLifecycleAppendAndAuthenticatedReopenUseUnwrappedRoot() throws {
    let fixture = try KeyFixture("append-reopen")
    defer { fixture.remove() }
    let security = FakeArchiveSecurityProvider()
    let first = makeLifecycle(fixture, security: security)
    let store = try first.openLaneStoreDetailed(
      keywrapURL: fixture.keywrapURL,
      tapeURL: fixture.tapeURL,
      indexURL: fixture.indexURL,
      context: context)
    let result = try store.appendPCM(
      keyHex("01000200ff7f0080"),
      observation: ArchiveIndexObservation(
        monoNS: 1,
        wallNS: 2,
        rmsQ15: 3,
        nativeFrames: 4,
        inputRateNumerator: 16_000,
        inputRateDenominator: 1))
    #expect(result.tape.header.recordSequence == 1)
    store.close()

    let reopened = try makeLifecycle(fixture, security: security).openLaneStoreDetailed(
      keywrapURL: fixture.keywrapURL,
      tapeURL: fixture.tapeURL,
      indexURL: fixture.indexURL,
      context: context)
    #expect(reopened.scanResult.tape.records.count == 1)
    #expect(reopened.scanResult.index.records.count == 1)
    #expect(reopened.adoptedRecordCount == 0)
    reopened.close()
  }

  @Test func key04ControlLifecycleAppendsAndAuthenticatesReplayOnStrictReopen() throws {
    let fixture = try KeyFixture("control-append-reopen")
    defer { fixture.remove() }
    let security = FakeArchiveSecurityProvider()
    let random = OrderedRandom([root, Data(repeating: 0xA6, count: 16)])
    let opened = try makeLifecycle(fixture, security: security, random: random.next)
      .openControlStoreWithInspection(
        keywrapURL: fixture.keywrapURL,
        journalURL: fixture.journalURL,
        context: controlContext)
    #expect(opened.keywrap.authenticated)
    let intent = try ArchiveControlPayload(
      commandID: "cmd_1",
      commandKind: .startDay,
      sessionID: nil,
      priorState: nil,
      newState: .startIntent,
      atMonoNS: 1,
      atWallNS: 2,
      error: nil)
    _ = try opened.store.append(
      plaintext: ArchiveControlPayloadCodec.encode(intent),
      firstLogicalUnit: 0,
      logicalUnitCount: 1)
    opened.store.close()

    let reopened = try makeLifecycle(fixture, security: security)
      .openExistingControlStoreWithInspection(
        keywrapURL: fixture.keywrapURL,
        journalURL: fixture.journalURL,
        context: controlContext)
    #expect(reopened.keywrap == opened.keywrap)
    #expect(reopened.store.scanResult.records.count == 1)
    #expect(
      try ArchiveControlPayloadCodec.decode(reopened.store.scanResult.records[0].plaintext)
        == intent)
    reopened.store.close()
  }

  @Test func key04StrictControlReopenRefusesMissingJournalWithoutCreatingIt() throws {
    let fixture = try KeyFixture("control-strict-missing")
    defer { fixture.remove() }
    let security = FakeArchiveSecurityProvider()
    let opened = try makeLifecycle(fixture, security: security).openControlStore(
      keywrapURL: fixture.keywrapURL,
      journalURL: fixture.journalURL,
      context: controlContext)
    opened.close()
    try FileManager.default.removeItem(at: fixture.journalURL)

    #expect(throws: ArchiveKeyLifecycleError.archiveKeyUnavailable) {
      try makeLifecycle(fixture, security: security).openExistingControlStoreWithInspection(
        keywrapURL: fixture.keywrapURL,
        journalURL: fixture.journalURL,
        context: controlContext)
    }
    #expect(!FileManager.default.fileExists(atPath: fixture.journalURL.path))
  }

  @Test func key04ControlReopenRejectsTamperedAuthenticatedHistory() throws {
    let fixture = try KeyFixture("control-tamper")
    defer { fixture.remove() }
    let security = FakeArchiveSecurityProvider()
    let store = try makeLifecycle(fixture, security: security).openControlStore(
      keywrapURL: fixture.keywrapURL,
      journalURL: fixture.journalURL,
      context: controlContext)
    let intent = try ArchiveControlPayload(
      commandID: "cmd_1",
      commandKind: .startDay,
      sessionID: nil,
      priorState: nil,
      newState: .startIntent,
      atMonoNS: 1,
      atWallNS: 2,
      error: nil)
    _ = try store.append(
      plaintext: ArchiveControlPayloadCodec.encode(intent),
      firstLogicalUnit: 0,
      logicalUnitCount: 1)
    store.close()
    var bytes = try Data(contentsOf: fixture.journalURL)
    bytes[bytes.index(before: bytes.endIndex)] ^= 1
    try bytes.write(to: fixture.journalURL)

    #expect(throws: ArchiveKeyLifecycleError.archiveKeyUnavailable) {
      try makeLifecycle(fixture, security: security).openExistingControlStoreWithInspection(
        keywrapURL: fixture.keywrapURL,
        journalURL: fixture.journalURL,
        context: controlContext)
    }
  }

  @Test func key04FailedControlOpenerRemovesOnlyItsEmptyReservation() throws {
    let fixture = try KeyFixture("control-opener-cleanup")
    defer { fixture.remove() }
    let security = FakeArchiveSecurityProvider()
    let lifecycle = makeLifecycle(
      fixture,
      security: security,
      reservedControlStoreOpener: { _, _, _, _, _ in
        throw ArchiveDerivedPersistenceError.closed
      })

    #expect(throws: ArchiveKeyLifecycleError.archiveKeyUnavailable) {
      try lifecycle.openControlStore(
        keywrapURL: fixture.keywrapURL,
        journalURL: fixture.journalURL,
        context: controlContext)
    }
    #expect(FileManager.default.fileExists(atPath: fixture.keywrapURL.path))
    #expect(!FileManager.default.fileExists(atPath: fixture.journalURL.path))
  }

  @Test func key04ControlPathSubstitutionDuringAuthenticatedOpenFailsClosed() throws {
    let fixture = try KeyFixture("control-open-substitution")
    defer { fixture.remove() }
    let security = FakeArchiveSecurityProvider()
    let displacedURL = fixture.directory.appendingPathComponent("displaced.control")
    let lifecycle = makeLifecycle(
      fixture,
      security: security,
      reservedControlStoreOpener: { url, fileDescriptor, directoryDescriptor, rootKey, context in
        let store = try ArchiveDerivedStore.openReservedForAppend(
          url: url,
          fileDescriptor: fileDescriptor,
          directoryFileDescriptor: directoryDescriptor,
          purpose: .control,
          rootKey: rootKey,
          context: context)
        try FileManager.default.moveItem(at: url, to: displacedURL)
        try Data().write(to: url)
        #expect(chmod(url.path, S_IRUSR | S_IWUSR) == 0)
        return store
      })

    #expect(throws: ArchiveKeyLifecycleError.archiveKeyUnavailable) {
      try lifecycle.openControlStore(
        keywrapURL: fixture.keywrapURL,
        journalURL: fixture.journalURL,
        context: controlContext)
    }
    #expect(FileManager.default.fileExists(atPath: displacedURL.path))
  }

  @Test func retainedControlBuilderPublishesAuthenticatedIdentityWithoutCreatingJournal() throws {
    let fixture = try KeyFixture("retained-control-builder")
    defer { fixture.remove() }
    #expect(chmod(fixture.directory.path, mode_t(0o700)) == 0)
    let security = FakeArchiveSecurityProvider()
    let builder = try ArchiveRetainedLaneBuilder(
      rootURL: fixture.directory,
      keyLifecycle: makeLifecycle(fixture, security: security))
    let prepared = try builder.prepareControl(context: controlContext)
    #expect(prepared.keywrap.authenticated)
    #expect(prepared.catalogEntry.descriptor.context == controlContext)
    #expect(
      FileManager.default.fileExists(
        atPath: prepared.catalogEntry.layout.descriptorURL.path))
    #expect(
      !FileManager.default.fileExists(
        atPath: prepared.catalogEntry.layout.journalURL.path))
    #expect(!prepared.catalogEntry.journalPresent)
  }

  @Test func retainedRecoveryAuthenticatesPresentControlHistory() async throws {
    let fixture = try KeyFixture("retained-control-recovery")
    defer { fixture.remove() }
    #expect(chmod(fixture.directory.path, mode_t(0o700)) == 0)
    let security = FakeArchiveSecurityProvider()
    let lifecycle = makeLifecycle(fixture, security: security)
    let builder = try ArchiveRetainedLaneBuilder(
      rootURL: fixture.directory,
      keyLifecycle: lifecycle)
    let prepared = try builder.prepareControl(context: controlContext)
    let store = try lifecycle.openControlStore(
      keywrapURL: prepared.catalogEntry.layout.keywrapURL,
      journalURL: prepared.catalogEntry.layout.journalURL,
      context: controlContext)
    _ = try store.append(
      plaintext: ArchiveControlPayloadCodec.encode(
        try ArchiveControlPayload(
          commandID: "cmd_1",
          commandKind: .startDay,
          sessionID: nil,
          priorState: nil,
          newState: .startIntent,
          atMonoNS: 1,
          atWallNS: 2,
          error: nil)),
      firstLogicalUnit: 0,
      logicalUnitCount: 1)
    store.close()

    let recovery = try RetainedArchiveRecovery(
      rootURL: fixture.directory,
      wire: KeyUnusedWire(),
      keyLifecycle: lifecycle)
    await recovery.run()
    #expect(await recovery.state() == .complete)
  }

  @Test func retainedRecoveryFailsClosedOnTamperedControlHistory() async throws {
    let fixture = try KeyFixture("retained-control-recovery-tamper")
    defer { fixture.remove() }
    #expect(chmod(fixture.directory.path, mode_t(0o700)) == 0)
    let security = FakeArchiveSecurityProvider()
    let lifecycle = makeLifecycle(fixture, security: security)
    let builder = try ArchiveRetainedLaneBuilder(
      rootURL: fixture.directory,
      keyLifecycle: lifecycle)
    let prepared = try builder.prepareControl(context: controlContext)
    let store = try lifecycle.openControlStore(
      keywrapURL: prepared.catalogEntry.layout.keywrapURL,
      journalURL: prepared.catalogEntry.layout.journalURL,
      context: controlContext)
    _ = try store.append(
      plaintext: ArchiveControlPayloadCodec.encode(
        try ArchiveControlPayload(
          commandID: "cmd_1",
          commandKind: .startDay,
          sessionID: nil,
          priorState: nil,
          newState: .startIntent,
          atMonoNS: 1,
          atWallNS: 2,
          error: nil)),
      firstLogicalUnit: 0,
      logicalUnitCount: 1)
    store.close()
    var bytes = try Data(contentsOf: prepared.catalogEntry.layout.journalURL)
    bytes[bytes.index(before: bytes.endIndex)] ^= 1
    try bytes.write(to: prepared.catalogEntry.layout.journalURL)

    let recovery = try RetainedArchiveRecovery(
      rootURL: fixture.directory,
      wire: KeyUnusedWire(),
      keyLifecycle: lifecycle)
    await recovery.run()
    guard case .failed = await recovery.state() else {
      Issue.record("tampered control history passed retained recovery")
      return
    }
  }

  @Test func primaryResidentOwnerCapturesReservesAndVerifiesOneSyntheticLane() async throws {
    let fixture = try KeyFixture("primary-owner")
    defer { fixture.remove() }
    #expect(chmod(fixture.directory.path, mode_t(0o700)) == 0)
    let security = FakeArchiveSecurityProvider()
    var dailyStream = Data(repeating: 0x43, count: 16)
    dailyStream[6] = (dailyStream[6] & 0x0F) | 0x40
    dailyStream[8] = (dailyStream[8] & 0x3F) | 0x80
    let random = OrderedRandom([
      keyUUID(0x42),
      Data(repeating: 0x40, count: 32),
      Data(repeating: 0xA4, count: 16),
      dailyStream,
      root,
      Data(repeating: 0xA5, count: 16),
    ])
    let lifecycle = makeLifecycle(fixture, security: security, random: random.next)
    let journal = try RotatingArchiveRoomControlJournal(
      rootURL: fixture.directory,
      roomID: "room_1",
      keyLifecycle: lifecycle,
      currentDay: ArchiveISTDay(containing: Date(timeIntervalSince1970: 1_777_579_200)))
    let calls = KeyOwnerEncoderCalls()
    let wire = KeyOwnerDeliveryWire(endedDisagrees: "ended_disagrees")
    let owner = try PrimaryResidentArchiveCaptureOwner(
      rootURL: fixture.directory,
      roomID: "room_1",
      stableDeviceUID: "synthetic-device-1",
      wire: wire,
      spoolCoordinator: ArchiveSpoolCoordinator(
        testEncoder: KeyOwnerSpoolEncoder(calls: calls),
        encoderProvenanceID: "ffmpeg-owner-test"),
      keyLifecycle: lifecycle,
      captureFactory: { _, store, _ in KeyOwnerCapture(store: store) },
      now: { Date(timeIntervalSince1970: 1_777_579_200) })
    owner.installRolloverHandlers(
      pendingPlans: [],
      captureBindings: [],
      persistCaptureBinding: { try journal.persistCaptureSessionBinding($0) },
      persistPreparation: { try journal.persistRolloverPreparation($0) },
      persistIntent: {
        try journal.persistRolloverIntent(preparation: $0, primary: $1, stagedPrimary: $2)
      },
      resume: { try journal.resumeRollover($0, effects: $1) },
      rotateControl: { try journal.rotate(to: $0) })
    let start = RoomResidentCaptureStartContext(
      roomID: "room_1",
      sessionID: "bs_owner_test",
      nextPrimaryIndex: 3,
      trigger: .reconciliation)

    try owner.start(context: start)
    #expect(owner.isActive)
    #expect(owner.requiresFinalization)
    #expect(owner.nextBackupIndex == nil)
    try await owner.service()
    try owner.stopAndFinalize(reason: .end(commandID: "cmd_end"))
    let final = RoomResidentFinalizationContext(
      roomID: "room_1",
      sessionID: "bs_owner_test",
      nextPrimaryIndex: 3)
    try await owner.reserveFinalRanges(context: final)
    try await owner.verifyFinalRanges(context: final)

    #expect(!owner.isActive)
    #expect(!owner.requiresFinalization)
    #expect(owner.nextPrimaryIndex == 4)
    #expect(calls.count == 1)
    #expect(await wire.registrationCount == 1)
    #expect(owner.serverEndedSessionID == "bs_owner_test")
    #expect(owner.terminalFailure == nil)
    #expect(random.remaining == 0)
    let entries = try ArchiveRetainedLaneCatalog(rootURL: fixture.directory).scan()
    #expect(entries.count == 1)
    let entry = try #require(entries.first)
    #expect(entry.descriptor.context.roomID == "room_1")
    #expect(entry.descriptor.context.laneID == "primary")
    let backup = entry.layout.directoryURL.deletingLastPathComponent().appendingPathComponent(
      "backup", isDirectory: true)
    #expect(!FileManager.default.fileExists(atPath: backup.path))
  }

  @Test func primaryRuntimeFactoryCreatesOnlyDailyControlStateBeforeCapture() throws {
    let fixture = try KeyFixture("primary-runtime-factory")
    defer { fixture.remove() }
    #expect(chmod(fixture.directory.path, mode_t(0o700)) == 0)
    let security = FakeArchiveSecurityProvider()
    var controlStream = Data(repeating: 0x53, count: 16)
    controlStream[6] = (controlStream[6] & 0x0F) | 0x40
    controlStream[8] = (controlStream[8] & 0x3F) | 0x80
    let random = OrderedRandom([
      controlStream,
      root,
      Data(repeating: 0xA6, count: 16),
    ])
    let lifecycle = makeLifecycle(fixture, security: security, random: random.next)
    let origin = URL(string: "https://scribe.test/")!
    let ffmpegPath = "/usr/bin/true"
    let receipt = try RoomArchivePreflightReceipt(
      origin: origin,
      roomSlug: "owner-test",
      deviceUID: "synthetic-device-1",
      ffmpegPath: ffmpegPath,
      archiveRootPath: fixture.directory.path,
      archiveProbeSucceeded: true,
      keyProbeSucceeded: true,
      encoderProbeSucceeded: true,
      secureEnclavePublicKeySHA256: String(repeating: "a", count: 64),
      encoderProvenanceID: "ffmpeg-owner-test",
      completedAt: Date(timeIntervalSince1970: 1_777_579_100))
    let configuration = try RoomConfiguration(
      origin: origin,
      roomSlug: "owner-test",
      deviceUID: "synthetic-device-1",
      tapewriterPath: "/usr/bin/false",
      ffmpegPath: ffmpegPath,
      residentArchiveCaptureEnabled: true,
      archivePreflightReceipt: receipt)

    let runtime = try PrimaryResidentRuntimeFactory.make(
      configuration: configuration,
      context: RoomResidentRuntimeContext(
        archiveRootURL: fixture.directory,
        roomID: "room_1",
        archiveDeliveryWire: KeyOwnerDeliveryWire()),
      keyLifecycle: lifecycle,
      now: { Date(timeIntervalSince1970: 1_777_579_200) })

    #expect(try runtime.controlJournal.recover().isEmpty)
    #expect(runtime.capture.nextBackupIndex == nil)
    #expect(!runtime.capture.isActive)
    let catalog = try ArchiveRetainedLaneCatalog(rootURL: fixture.directory).scanIncludingControls()
    #expect(catalog.lanes.isEmpty)
    #expect(catalog.controls.count == 1)
    #expect(catalog.controls.first?.descriptor.context.roomID == "room_1")
    #expect(random.remaining == 0)
  }

  @Test func captureBindingPersistenceFailureStartsNoCaptureGrowth() throws {
    let fixture = try KeyFixture("capture-binding-before-growth-failure")
    defer { fixture.remove() }
    #expect(chmod(fixture.directory.path, mode_t(0o700)) == 0)
    let security = FakeArchiveSecurityProvider()
    let random = OrderedRandom([
      keyUUID(0x21), Data(repeating: 0x31, count: 32), Data(repeating: 0x91, count: 16),
      keyUUID(0x22), root, Data(repeating: 0x92, count: 16),
    ])
    let lifecycle = makeLifecycle(fixture, security: security, random: random.next)
    let journal = try RotatingArchiveRoomControlJournal(
      rootURL: fixture.directory,
      roomID: "room_1",
      keyLifecycle: lifecycle,
      currentDay: try ArchiveISTDay("2026-08-29"))
    let calls = KeyOwnerCaptureStartCalls()
    let owner = try PrimaryResidentArchiveCaptureOwner(
      rootURL: fixture.directory,
      roomID: "room_1",
      stableDeviceUID: "synthetic-device-1",
      wire: KeyOwnerDeliveryWire(),
      spoolCoordinator: ArchiveSpoolCoordinator(
        testEncoder: KeyOwnerSpoolEncoder(calls: KeyOwnerEncoderCalls()),
        encoderProvenanceID: "ffmpeg-binding-failure-test"),
      keyLifecycle: lifecycle,
      captureFactory: { _, store, _ in
        KeyOwnerCrashCapture(store: store, calls: calls, failBeforeGrowth: false)
      },
      now: { try! ArchiveISTDay("2026-08-29").start.addingTimeInterval(60) })
    owner.installRolloverHandlers(
      pendingPlans: [],
      captureBindings: [],
      persistCaptureBinding: { _ in throw KeyOwnerCrash.bindingPersistence },
      persistPreparation: { try journal.persistRolloverPreparation($0) },
      persistIntent: {
        try journal.persistRolloverIntent(preparation: $0, primary: $1, stagedPrimary: $2)
      },
      resume: { try journal.resumeRollover($0, effects: $1) },
      rotateControl: { try journal.rotate(to: $0) })

    #expect(throws: KeyOwnerCrash.bindingPersistence) {
      try owner.start(
        context: RoomResidentCaptureStartContext(
          roomID: "room_1", sessionID: "bs_binding_failure", nextPrimaryIndex: 0,
          trigger: .reconciliation))
    }
    #expect(calls.count == 0)
    #expect(try journal.recover().values.allSatisfy { $0.commandKind != .captureSessionBinding })
  }

  @Test func crashAfterProspectiveBindingBeforeGrowthRestartsWithoutMisattribution() async throws {
    let fixture = try KeyFixture("capture-binding-before-growth-crash")
    defer { fixture.remove() }
    #expect(chmod(fixture.directory.path, mode_t(0o700)) == 0)
    let security = FakeArchiveSecurityProvider()
    let random = OrderedRandom([
      keyUUID(0x23), Data(repeating: 0x33, count: 32), Data(repeating: 0x93, count: 16),
      keyUUID(0x24), root, Data(repeating: 0x94, count: 16),
    ])
    let lifecycle = makeLifecycle(fixture, security: security, random: random.next)
    let day = try ArchiveISTDay("2026-08-29")
    let journal = try RotatingArchiveRoomControlJournal(
      rootURL: fixture.directory,
      roomID: "room_1",
      keyLifecycle: lifecycle,
      currentDay: day)
    let failedCalls = KeyOwnerCaptureStartCalls()
    let wire = KeyOwnerDeliveryWire()
    let encoderCalls = KeyOwnerEncoderCalls()

    func makeOwner(failBeforeGrowth: Bool, calls: KeyOwnerCaptureStartCalls)
      throws -> PrimaryResidentArchiveCaptureOwner
    {
      let owner = try PrimaryResidentArchiveCaptureOwner(
        rootURL: fixture.directory,
        roomID: "room_1",
        stableDeviceUID: "synthetic-device-1",
        wire: wire,
        spoolCoordinator: ArchiveSpoolCoordinator(
          testEncoder: KeyOwnerSpoolEncoder(calls: encoderCalls),
          encoderProvenanceID: "ffmpeg-binding-crash-test"),
        keyLifecycle: lifecycle,
        captureFactory: { _, store, _ in
          KeyOwnerCrashCapture(
            store: store, calls: calls, failBeforeGrowth: failBeforeGrowth)
        },
        now: { try! day.start.addingTimeInterval(60) })
      let recovered = try journal.recover()
      owner.installRolloverHandlers(
        pendingPlans: recovered.values.compactMap(\.rolloverPlan),
        captureBindings: recovered.values.compactMap(\.captureSessionBinding),
        persistCaptureBinding: { try journal.persistCaptureSessionBinding($0) },
        persistPreparation: { try journal.persistRolloverPreparation($0) },
        persistIntent: {
          try journal.persistRolloverIntent(preparation: $0, primary: $1, stagedPrimary: $2)
        },
        resume: { try journal.resumeRollover($0, effects: $1) },
        rotateControl: { try journal.rotate(to: $0) })
      return owner
    }

    let context = RoomResidentCaptureStartContext(
      roomID: "room_1", sessionID: "bs_binding_crash", nextPrimaryIndex: 0,
      trigger: .reconciliation)
    let crashed = try makeOwner(failBeforeGrowth: true, calls: failedCalls)
    #expect(throws: KeyOwnerCrash.beforeGrowth) { try crashed.start(context: context) }
    let retainedBinding = try #require(
      journal.recover().values.compactMap(\.captureSessionBinding).first)
    #expect(retainedBinding.segmentSampleStart == 0)

    let restartedCalls = KeyOwnerCaptureStartCalls()
    let restarted = try makeOwner(failBeforeGrowth: false, calls: restartedCalls)
    try restarted.start(context: context)
    try restarted.stopAndFinalize(reason: .cancelled)
    let final = RoomResidentFinalizationContext(
      roomID: "room_1", sessionID: context.sessionID, nextPrimaryIndex: 0)
    try await restarted.reserveFinalRanges(context: final)
    try await restarted.verifyFinalRanges(context: final)

    #expect(failedCalls.count == 1)
    #expect(restartedCalls.count == 1)
    #expect(try journal.recover().values.compactMap(\.captureSessionBinding) == [retainedBinding])
    #expect(encoderCalls.count == 1)
  }

  @Test func crashAfterCompletedRolloverBeforeNewBindingRecoversBothSides() async throws {
    let fixture = try KeyFixture("primary-owner-rollover")
    defer { fixture.remove() }
    #expect(chmod(fixture.directory.path, mode_t(0o700)) == 0)
    let security = FakeArchiveSecurityProvider()
    var firstStream = Data(repeating: 0x71, count: 16)
    firstStream[6] = (firstStream[6] & 0x0F) | 0x40
    firstStream[8] = (firstStream[8] & 0x3F) | 0x80
    var secondStream = Data(repeating: 0x72, count: 16)
    secondStream[6] = (secondStream[6] & 0x0F) | 0x40
    secondStream[8] = (secondStream[8] & 0x3F) | 0x80
    var firstControlStream = Data(repeating: 0x73, count: 16)
    firstControlStream[6] = (firstControlStream[6] & 0x0F) | 0x40
    firstControlStream[8] = (firstControlStream[8] & 0x3F) | 0x80
    var secondControlStream = Data(repeating: 0x74, count: 16)
    secondControlStream[6] = (secondControlStream[6] & 0x0F) | 0x40
    secondControlStream[8] = (secondControlStream[8] & 0x3F) | 0x80
    let random = OrderedRandom([
      firstControlStream,
      Data(repeating: 0x41, count: 32),
      Data(repeating: 0xC0, count: 16),
      firstStream,
      root,
      Data(repeating: 0xC1, count: 16),
      Data(root.reversed()),
      Data(repeating: 0xC2, count: 16),
      Data(repeating: 0x42, count: 32),
      Data(repeating: 0xC3, count: 16),
    ])
    let lifecycle = makeLifecycle(fixture, security: security, random: random.next)
    let calls = KeyOwnerEncoderCalls()
    let wire = KeyOwnerDeliveryWire()
    let firstDay = try ArchiveISTDay("2026-08-28")
    let secondDay = try ArchiveISTDay("2026-08-29")
    let controlJournal =
      try RotatingArchiveRoomControlJournal(
        rootURL: fixture.directory,
        roomID: "room_1",
        keyLifecycle: lifecycle,
        currentDay: firstDay)
    let order = KeyOwnerRolloverOrder()
    let bindingWrites = Atomic<Int>(0)
    let owner = try PrimaryResidentArchiveCaptureOwner(
      rootURL: fixture.directory,
      roomID: "room_1",
      stableDeviceUID: "synthetic-device-1",
      wire: wire,
      spoolCoordinator: ArchiveSpoolCoordinator(
        testEncoder: KeyOwnerSpoolEncoder(calls: calls),
        encoderProvenanceID: "ffmpeg-owner-rollover-test"),
      keyLifecycle: lifecycle,
      captureFactory: { _, store, rolloverStoreFactory in
        KeyOwnerRolloverCapture(
          store: store,
          rolloverStoreFactory: try #require(rolloverStoreFactory),
          rolloverWallNS: UInt64(try secondDay.start.timeIntervalSince1970 * 1_000_000_000),
          order: order)
      },
      now: { try! firstDay.start.addingTimeInterval(3_600) })
    owner.installRolloverHandlers(
      pendingPlans: [],
      captureBindings: [],
      persistCaptureBinding: {
        if bindingWrites.wrappingAdd(1, ordering: .relaxed).oldValue == 1 {
          throw KeyOwnerCrash.bindingPersistence
        }
        try controlJournal.persistCaptureSessionBinding($0)
      },
      persistPreparation: {
        order.record("preparation")
        try controlJournal.persistRolloverPreparation($0)
      },
      persistIntent: {
        order.record("intent")
        return try controlJournal.persistRolloverIntent(
          preparation: $0, primary: $1, stagedPrimary: $2)
      },
      resume: { try controlJournal.resumeRollover($0, effects: $1) },
      rotateControl: { try controlJournal.rotate(to: $0) })
    let start = RoomResidentCaptureStartContext(
      roomID: "room_1",
      sessionID: "bs_owner_rollover",
      nextPrimaryIndex: 3,
      trigger: .reconciliation)

    try owner.start(context: start)
    await #expect(throws: KeyOwnerCrash.bindingPersistence) {
      try await owner.service()
    }
    #expect(owner.isActive)
    #expect(order.values.prefix(3) == ["preparation", "intent", "old_close"])
    let crashedRecovery = try controlJournal.recover()
    #expect(
      crashedRecovery.values.first { $0.commandKind == .rollover }?.state == .rolloverComplete)
    #expect(crashedRecovery.values.compactMap(\.captureSessionBinding).count == 1)
    try owner.stopAndFinalize(reason: .cancelled)

    let restarted = try PrimaryResidentArchiveCaptureOwner(
      rootURL: fixture.directory,
      roomID: "room_1",
      stableDeviceUID: "synthetic-device-1",
      wire: wire,
      spoolCoordinator: ArchiveSpoolCoordinator(
        testEncoder: KeyOwnerSpoolEncoder(calls: calls),
        encoderProvenanceID: "ffmpeg-owner-rollover-test"),
      keyLifecycle: lifecycle,
      captureFactory: { _, store, _ in KeyOwnerCapture(store: store) },
      now: { try! secondDay.start.addingTimeInterval(60) })
    restarted.installRolloverHandlers(
      pendingPlans: crashedRecovery.values.compactMap(\.rolloverPlan),
      captureBindings: crashedRecovery.values.compactMap(\.captureSessionBinding),
      persistCaptureBinding: { try controlJournal.persistCaptureSessionBinding($0) },
      persistPreparation: { try controlJournal.persistRolloverPreparation($0) },
      persistIntent: {
        try controlJournal.persistRolloverIntent(
          preparation: $0, primary: $1, stagedPrimary: $2)
      },
      resume: { try controlJournal.resumeRollover($0, effects: $1) },
      rotateControl: { try controlJournal.rotate(to: $0) })
    let final = RoomResidentFinalizationContext(
      roomID: "room_1",
      sessionID: "bs_owner_rollover",
      nextPrimaryIndex: 3)
    try await restarted.reserveFinalRanges(context: final)
    try await restarted.verifyFinalRanges(context: final)

    #expect(random.remaining == 0)
    #expect(calls.count == 2)
    #expect(await wire.registrationCount == 2)
    #expect(restarted.nextPrimaryIndex == 5)
    let entries = try ArchiveRetainedLaneCatalog(rootURL: fixture.directory).scan()
      .filter { $0.descriptor.context.laneID == "primary" }
      .sorted { $0.descriptor.context.istDate < $1.descriptor.context.istDate }
    #expect(
      entries.map(\.descriptor.context.istDate) == [firstDay.description, secondDay.description])
    #expect(entries[0].descriptor.initialSamplePosition == 0)
    #expect(entries[1].descriptor.initialSamplePosition == 16_000)
    var durableIndices: [[UInt32]] = []
    for entry in entries {
      let opened = try lifecycle.openExistingLaneSnapshotWithInspection(
        keywrapURL: entry.layout.keywrapURL,
        tapeURL: entry.layout.tapeURL,
        indexURL: entry.layout.indexURL,
        context: entry.descriptor.context,
        initialSamplePosition: entry.descriptor.initialSamplePosition)
      let journal = try opened.snapshot.openJournalStoreForAppend(at: entry.layout.journalURL)
      durableIndices.append(
        try ArchiveJournalReplay.validate(
          journal.scanResult.records.map {
            try ArchiveJournalPayloadCodec.decode($0.plaintext)
          }
        ).values.map(\.initialReservation.chunkIndex).sorted())
      journal.close()
      opened.snapshot.close()
    }
    #expect(durableIndices == [[3], [4]])
    let recovered = try controlJournal.recover()
    let preparation = try #require(
      recovered.values.first { $0.commandKind == .rolloverPreparation })
    let rollover = try #require(recovered.values.first { $0.commandKind == .rollover })
    let bindings = recovered.values.compactMap(\.captureSessionBinding).sorted {
      $0.primaryIdentity.context.istDate < $1.primaryIdentity.context.istDate
    }
    #expect(preparation.rolloverPreparation?.nextChunkIndex == 3)
    #expect(rollover.state == .rolloverComplete)
    #expect(rollover.rolloverPlan?.backup == nil)
    #expect(rollover.rolloverPlan?.primary.nextChunkIndex == 3)
    #expect(
      bindings.map(\.primaryIdentity.context.istDate) == [
        firstDay.description, secondDay.description,
      ])
    #expect(bindings.map(\.segmentSampleStart) == [0, 16_000])
  }

  @Test func midnightRelaunchWithoutPreparationStagesAndCompletesTheSameSession() async throws {
    let fixture = try KeyFixture("primary-owner-midnight-relaunch")
    defer { fixture.remove() }
    #expect(chmod(fixture.directory.path, mode_t(0o700)) == 0)
    let security = FakeArchiveSecurityProvider()
    let firstDay = try ArchiveISTDay("2026-08-28")
    let secondDay = try ArchiveISTDay("2026-08-29")
    let thirdDay = try ArchiveISTDay("2026-08-30")
    let fourthDay = try ArchiveISTDay("2026-08-31")
    let random = OrderedRandom([
      keyUUID(0x31), Data(repeating: 0x41, count: 32), Data(repeating: 0xA1, count: 16),
      keyUUID(0x32), root, Data(repeating: 0xA2, count: 16),
      Data(root.reversed()), Data(repeating: 0xA3, count: 16),
      Data(repeating: 0x42, count: 32), Data(repeating: 0xA4, count: 16),
      Data(repeating: 0x43, count: 32), Data(repeating: 0xA5, count: 16),
      Data(repeating: 0x44, count: 32), Data(repeating: 0xA6, count: 16),
      keyUUID(0x37), Data(repeating: 0x45, count: 32), Data(repeating: 0xA7, count: 16),
      keyUUID(0x38), Data(repeating: 0x46, count: 32), Data(repeating: 0xA8, count: 16),
    ])
    let lifecycle = makeLifecycle(fixture, security: security, random: random.next)
    let journal = try RotatingArchiveRoomControlJournal(
      rootURL: fixture.directory,
      roomID: "room_1",
      keyLifecycle: lifecycle,
      currentDay: firstDay)
    let calls = KeyOwnerEncoderCalls()
    let wire = KeyOwnerDeliveryWire()
    func makeOwner(
      now: @escaping @Sendable () -> Date,
      rolloverAt: ArchiveISTDay? = nil
    ) throws
      -> PrimaryResidentArchiveCaptureOwner
    {
      let owner = try PrimaryResidentArchiveCaptureOwner(
        rootURL: fixture.directory,
        roomID: "room_1",
        stableDeviceUID: "synthetic-device-1",
        wire: wire,
        spoolCoordinator: ArchiveSpoolCoordinator(
          testEncoder: KeyOwnerSpoolEncoder(calls: calls),
          encoderProvenanceID: "ffmpeg-owner-relaunch-test"),
        keyLifecycle: lifecycle,
        captureFactory: { _, store, rolloverStoreFactory -> any PrimaryResidentAudioCapturing in
          guard let rolloverAt else { return KeyOwnerCapture(store: store) }
          return KeyOwnerRolloverCapture(
            store: store,
            rolloverStoreFactory: try #require(rolloverStoreFactory),
            rolloverWallNS: UInt64(try rolloverAt.start.timeIntervalSince1970 * 1_000_000_000),
            order: KeyOwnerRolloverOrder())
        },
        now: now)
      let recovered = try journal.recover()
      owner.installRolloverHandlers(
        pendingPlans: recovered.values.compactMap(\.rolloverPlan),
        captureBindings: recovered.values.compactMap(\.captureSessionBinding),
        persistCaptureBinding: { try journal.persistCaptureSessionBinding($0) },
        persistPreparation: { try journal.persistRolloverPreparation($0) },
        persistIntent: {
          try journal.persistRolloverIntent(
            preparation: $0, primary: $1, stagedPrimary: $2)
        },
        resume: { try journal.resumeRollover($0, effects: $1) },
        rotateControl: { try journal.rotate(to: $0) })
      return owner
    }
    let context = RoomResidentCaptureStartContext(
      roomID: "room_1", sessionID: "bs_midnight_relaunch", nextPrimaryIndex: 5,
      trigger: .reconciliation)
    let first = try makeOwner(now: { try! firstDay.start.addingTimeInterval(3_600) })
    try first.start(context: context)
    try first.stopAndFinalize(reason: .cancelled)

    let relaunched = try makeOwner(
      now: { try! secondDay.start.addingTimeInterval(60) }, rolloverAt: thirdDay)
    try relaunched.start(context: context)
    try await relaunched.service()

    #expect(relaunched.isActive)
    let recovered = try journal.recover()
    let preparations = recovered.values.filter { $0.commandKind == .rolloverPreparation }
    let rollovers = recovered.values.filter { $0.commandKind == .rollover }.sorted {
      $0.rolloverPlan!.primary.oldDay.context.istDate
        < $1.rolloverPlan!.primary.oldDay.context.istDate
    }
    #expect(preparations.count == 2)
    #expect(preparations.allSatisfy { $0.rolloverPreparation?.sessionID == context.sessionID })
    #expect(rollovers.allSatisfy { $0.state == .rolloverComplete })
    #expect(rollovers.compactMap(\.rolloverPlan?.sessionSampleStart) == [0, 0])
    #expect(rollovers.compactMap(\.rolloverPlan?.primary.boundarySample) == [16_000, 32_000])
    let days = try ArchiveRetainedLaneCatalog(rootURL: fixture.directory).scan()
      .filter { $0.descriptor.context.laneID == "primary" }
      .sorted { $0.descriptor.context.istDate < $1.descriptor.context.istDate }
    #expect(
      days.map(\.descriptor.context.istDate) == [
        firstDay.description, secondDay.description, thirdDay.description,
      ])
    #expect(days.map(\.descriptor.initialSamplePosition) == [0, 16_000, 32_000])
    try relaunched.stopAndFinalize(reason: .cancelled)
    let endingNow = KeyOwnerNow(try thirdDay.start.addingTimeInterval(60))
    let ending = try makeOwner(now: { endingNow.value })
    let final = RoomResidentFinalizationContext(
      roomID: "room_1", sessionID: context.sessionID,
      nextPrimaryIndex: relaunched.nextPrimaryIndex)
    try await ending.reserveFinalRanges(context: final)
    try await ending.verifyFinalRanges(context: final)

    let endStates: [ArchiveControlState] = [
      .endIntent, .finalRangesReserved, .finalRangesVerified, .sessionEndPatched,
    ]
    for (index, state) in endStates.enumerated() {
      _ = try journal.advance(
        RoomControlTransition(
          commandID: "cmd_end_session_a",
          commandKind: .endDay,
          sessionID: context.sessionID,
          priorState: index == 0 ? nil : endStates[index - 1],
          newState: state))
    }
    _ = try journal.advance(
      RoomControlTransition(
        commandID: "cmd_start_session_b",
        commandKind: .startDay,
        sessionID: nil,
        priorState: nil,
        newState: .startIntent))
    _ = try journal.advance(
      RoomControlTransition(
        commandID: "cmd_start_session_b",
        commandKind: .startDay,
        sessionID: "bs_after_rollover",
        priorState: .startIntent,
        newState: .sessionOpened))
    endingNow.value = try fourthDay.start.addingTimeInterval(60)
    let secondContext = RoomResidentCaptureStartContext(
      roomID: "room_1",
      sessionID: "bs_after_rollover",
      nextPrimaryIndex: ending.nextPrimaryIndex,
      trigger: .startDay(commandID: "cmd_start_session_b"))
    try ending.start(context: secondContext)
    try ending.stopAndFinalize(reason: .end(commandID: "cmd_end_session_b"))
    let secondFinal = RoomResidentFinalizationContext(
      roomID: "room_1",
      sessionID: secondContext.sessionID,
      nextPrimaryIndex: ending.nextPrimaryIndex)
    try await ending.reserveFinalRanges(context: secondFinal)
    try await ending.verifyFinalRanges(context: secondFinal)
  }

  @Test func rolloverEffectFailureIsTerminalEvenAfterTheNewWriterStarts() async throws {
    let fixture = try KeyFixture("primary-owner-terminal-rollover")
    defer { fixture.remove() }
    #expect(chmod(fixture.directory.path, mode_t(0o700)) == 0)
    let security = FakeArchiveSecurityProvider()
    let firstDay = try ArchiveISTDay("2026-08-28")
    let secondDay = try ArchiveISTDay("2026-08-29")
    let firstDayStart = try firstDay.start
    let secondDayStart = try secondDay.start
    let random = OrderedRandom([
      keyUUID(0x51), Data(repeating: 0x61, count: 32), Data(repeating: 0xB1, count: 16),
      keyUUID(0x52), root, Data(repeating: 0xB2, count: 16),
      Data(root.reversed()), Data(repeating: 0xB3, count: 16),
      Data(repeating: 0x62, count: 32), Data(repeating: 0xB4, count: 16),
    ])
    let lifecycle = makeLifecycle(fixture, security: security, random: random.next)
    let journal = try RotatingArchiveRoomControlJournal(
      rootURL: fixture.directory,
      roomID: "room_1",
      keyLifecycle: lifecycle,
      currentDay: firstDay)
    let owner = try PrimaryResidentArchiveCaptureOwner(
      rootURL: fixture.directory,
      roomID: "room_1",
      stableDeviceUID: "synthetic-device-1",
      wire: KeyOwnerDeliveryWire(),
      spoolCoordinator: ArchiveSpoolCoordinator(
        testEncoder: KeyOwnerSpoolEncoder(calls: KeyOwnerEncoderCalls()),
        encoderProvenanceID: "ffmpeg-owner-terminal-test"),
      keyLifecycle: lifecycle,
      captureFactory: { _, store, rolloverStoreFactory in
        KeyOwnerRolloverCapture(
          store: store,
          rolloverStoreFactory: try #require(rolloverStoreFactory),
          rolloverWallNS: UInt64(secondDayStart.timeIntervalSince1970 * 1_000_000_000),
          order: KeyOwnerRolloverOrder())
      },
      now: { firstDayStart.addingTimeInterval(3_600) })
    owner.installRolloverHandlers(
      pendingPlans: [],
      captureBindings: [],
      persistCaptureBinding: { try journal.persistCaptureSessionBinding($0) },
      persistPreparation: { try journal.persistRolloverPreparation($0) },
      persistIntent: {
        try journal.persistRolloverIntent(
          preparation: $0, primary: $1, stagedPrimary: $2)
      },
      resume: { plan, _ in
        try journal.resumeRollover(
          plan,
          effects: ArchiveRolloverEffects(
            reserveOldDayFinal: { _ in
              throw ArchiveRolloverEffectFailure.internalIOFailed
            },
            closeOldDayFiles: { _ in
              throw ArchiveRolloverEffectFailure.internalIOFailed
            },
            makeNewDayFilesDurable: { _ in
              throw ArchiveRolloverEffectFailure.internalIOFailed
            }))
      },
      rotateControl: { try journal.rotate(to: $0) })
    try owner.start(
      context: RoomResidentCaptureStartContext(
        roomID: "room_1", sessionID: "bs_terminal_rollover", nextPrimaryIndex: 0,
        trigger: .reconciliation))

    do {
      try await owner.service()
      Issue.record("expected rollover effect failure")
    } catch {
      #expect(
        error as? ArchiveRolloverError
          == .effectFailed(.internalIOFailed))
    }

    #expect(owner.isActive)
    #expect(owner.terminalFailure != nil)
    #expect(try journal.recover().values.contains { $0.state == .rolloverFailed })
    try owner.stopAndFinalize(reason: .cancelled)
  }

  @Test func rotatingControlJournalKeepsOldCommandsOwnedAndRecoversBothDays() throws {
    let fixture = try KeyFixture("rotating-control-journal")
    defer { fixture.remove() }
    #expect(chmod(fixture.directory.path, mode_t(0o700)) == 0)
    let security = FakeArchiveSecurityProvider()
    var firstStream = Data(repeating: 0x61, count: 16)
    firstStream[6] = (firstStream[6] & 0x0F) | 0x40
    firstStream[8] = (firstStream[8] & 0x3F) | 0x80
    var secondStream = Data(repeating: 0x62, count: 16)
    secondStream[6] = (secondStream[6] & 0x0F) | 0x40
    secondStream[8] = (secondStream[8] & 0x3F) | 0x80
    let random = OrderedRandom([
      firstStream,
      root,
      Data(repeating: 0xB1, count: 16),
      secondStream,
      Data(root.reversed()),
      Data(repeating: 0xB2, count: 16),
    ])
    let lifecycle = makeLifecycle(fixture, security: security, random: random.next)
    let firstDay = try ArchiveISTDay("2026-08-28")
    let secondDay = try ArchiveISTDay("2026-08-29")
    var journal: RotatingArchiveRoomControlJournal? = try RotatingArchiveRoomControlJournal(
      rootURL: fixture.directory,
      roomID: "room_1",
      keyLifecycle: lifecycle,
      currentDay: firstDay)
    _ = try journal?.advance(
      RoomControlTransition(
        commandID: "cmd_old",
        commandKind: .startDay,
        sessionID: nil,
        priorState: nil,
        newState: .startIntent))

    try journal?.rotate(to: secondDay)
    _ = try journal?.advance(
      RoomControlTransition(
        commandID: "cmd_old",
        commandKind: .startDay,
        sessionID: "bs_1",
        priorState: .startIntent,
        newState: .sessionOpened))
    _ = try journal?.advance(
      RoomControlTransition(
        commandID: "cmd_new",
        commandKind: .pauseDay,
        sessionID: "bs_1",
        priorState: nil,
        newState: .pauseIntent))
    #expect(random.remaining == 0)
    #expect(
      try ArchiveRetainedLaneCatalog(rootURL: fixture.directory).scanIncludingControls().controls
        .count
        == 2)
    journal = nil

    let reopened = try RotatingArchiveRoomControlJournal(
      rootURL: fixture.directory,
      roomID: "room_1",
      keyLifecycle: lifecycle,
      currentDay: secondDay)
    let recovered = try reopened.recover()
    #expect(recovered["cmd_old"]?.state == .sessionOpened)
    #expect(recovered["cmd_new"]?.state == .pauseIntent)
  }

  @Test func key04ExistingLaneSubstitutionIsRejectedWithoutPathReopen() throws {
    for target in ["tape", "index"] {
      let fixture = try KeyFixture("existing-substitution-\(target)")
      defer { fixture.remove() }
      let security = FakeArchiveSecurityProvider()
      let initial = try makeLifecycle(fixture, security: security).openLaneStoreDetailed(
        keywrapURL: fixture.keywrapURL,
        tapeURL: fixture.tapeURL,
        indexURL: fixture.indexURL,
        context: context)
      initial.close()
      let targetURL = target == "tape" ? fixture.tapeURL : fixture.indexURL
      let displacedURL = fixture.directory.appendingPathComponent("displaced-\(target)")
      let substitution = LockedCounter()
      security.beforeDecrypt = {
        guard substitution.takeFirst() else { return }
        try! FileManager.default.moveItem(at: targetURL, to: displacedURL)
        _ = FileManager.default.createFile(atPath: targetURL.path, contents: Data())
        _ = chmod(targetURL.path, S_IRUSR | S_IWUSR)
      }
      let releases = LockedCounter()
      #expect(throws: ArchiveKeyLifecycleFailure.pathIdentityChanged) {
        try makeLifecycle(
          fixture,
          security: security,
          onRootRelease: { _ in _ = releases.increment() }
        ).openLaneStoreDetailed(
          keywrapURL: fixture.keywrapURL,
          tapeURL: fixture.tapeURL,
          indexURL: fixture.indexURL,
          context: context)
      }
      #expect(releases.value == 0)
      #expect(FileManager.default.fileExists(atPath: targetURL.path))
      #expect(FileManager.default.fileExists(atPath: displacedURL.path))
    }
  }

  @Test func key04PublicErrorsExposeOnlyRatifiedNamesAndNoSensitiveDescriptions() throws {
    #expect(
      ArchiveKeyLifecycleError.secureHardwareUnavailable.localizedDescription
        == "secure_hardware_unavailable")
    #expect(
      ArchiveKeyLifecycleError.archiveKeyUnavailable.localizedDescription
        == "archive_key_unavailable")
    let fixture = try KeyFixture("public-errors")
    defer { fixture.remove() }
    let security = FakeArchiveSecurityProvider()
    security.queryFailure = errSecNotAvailable
    #expect(throws: ArchiveKeyLifecycleError.secureHardwareUnavailable) {
      try makeLifecycle(fixture, security: security).openLaneStore(
        keywrapURL: fixture.keywrapURL,
        tapeURL: fixture.tapeURL,
        indexURL: fixture.indexURL,
        context: context)
    }
    #expect(
      !String(describing: ArchiveKeyLifecycleFailure.decryptionFailed).contains(root.keyHexForTest))
  }

  @Test func key03PostCreateDuplicateKeysFailAndRemoveOwnedReservations() throws {
    let fixture = try KeyFixture("post-create-duplicate")
    defer { fixture.remove() }
    let security = FakeArchiveSecurityProvider()
    security.duplicateAfterCreate = true
    #expect(throws: ArchiveKeyLifecycleFailure.multipleTaggedKeys(2)) {
      try makeLifecycle(fixture, security: security).openLaneStoreDetailed(
        keywrapURL: fixture.keywrapURL,
        tapeURL: fixture.tapeURL,
        indexURL: fixture.indexURL,
        context: context)
    }
    #expect(security.createCalls.count == 1)
    #expect(security.queryCalls.count == 2)
    #expect(!FileManager.default.fileExists(atPath: fixture.keywrapURL.path))
    #expect(!FileManager.default.fileExists(atPath: fixture.tapeURL.path))
    #expect(!FileManager.default.fileExists(atPath: fixture.indexURL.path))
  }

  @Test func key04EmptyArtifactsAndStrictOpenPoliciesNeverCreateByReopen() throws {
    for artifact in ["tape", "index"] {
      let fixture = try KeyFixture("empty-existing-\(artifact)")
      defer { fixture.remove() }
      let url = artifact == "tape" ? fixture.tapeURL : fixture.indexURL
      #expect(FileManager.default.createFile(atPath: url.path, contents: Data()))
      #expect(chmod(url.path, S_IRUSR | S_IWUSR) == 0)
      let security = FakeArchiveSecurityProvider()
      #expect(throws: ArchiveKeyLifecycleFailure.existingArchiveWithoutKeywrap) {
        try makeLifecycle(fixture, security: security).openLaneStoreDetailed(
          keywrapURL: fixture.keywrapURL,
          tapeURL: fixture.tapeURL,
          indexURL: fixture.indexURL,
          context: context)
      }
      #expect(security.queryCalls.isEmpty)
    }

    let strict = try KeyFixture("strict-open")
    defer { strict.remove() }
    let security = FakeArchiveSecurityProvider()
    #expect(throws: ArchiveKeyLifecycleFailure.existingArchiveWithoutKeywrap) {
      try makeLifecycle(strict, security: security).openLaneStoreDetailed(
        keywrapURL: strict.keywrapURL,
        tapeURL: strict.tapeURL,
        indexURL: strict.indexURL,
        context: context,
        policy: .requireExistingKeywrapAllowLaneCreation)
    }
    #expect(!FileManager.default.fileExists(atPath: strict.keywrapURL.path))
    try writeWrap(strict, security: security, context: context)
    #expect(throws: ArchiveKeyLifecycleFailure.laneStoreOpenFailed) {
      try makeLifecycle(strict, security: security).openLaneStoreDetailed(
        keywrapURL: strict.keywrapURL,
        tapeURL: strict.tapeURL,
        indexURL: strict.indexURL,
        context: context,
        policy: .requireCompleteArchive)
    }
    #expect(!FileManager.default.fileExists(atPath: strict.tapeURL.path))
    #expect(!FileManager.default.fileExists(atPath: strict.indexURL.path))
    let append = try makeLifecycle(strict, security: security).openLaneStoreDetailed(
      keywrapURL: strict.keywrapURL,
      tapeURL: strict.tapeURL,
      indexURL: strict.indexURL,
      context: context,
      policy: .requireExistingKeywrapAllowLaneCreation)
    append.close()
    try FileManager.default.removeItem(at: strict.indexURL)
    #expect(throws: ArchiveKeyLifecycleFailure.laneStoreOpenFailed) {
      try makeLifecycle(strict, security: security).openLaneStoreDetailed(
        keywrapURL: strict.keywrapURL,
        tapeURL: strict.tapeURL,
        indexURL: strict.indexURL,
        context: context,
        policy: .requireCompleteArchive)
    }
    #expect(!FileManager.default.fileExists(atPath: strict.indexURL.path))
  }

  @Test func key04LifecycleRejectsExactHardlinkSymlinkParentAndModeAliases() throws {
    let exact = try KeyFixture("exact-alias")
    defer { exact.remove() }
    let exactSecurity = FakeArchiveSecurityProvider()
    #expect(throws: ArchiveKeyLifecycleFailure.pathAlias) {
      try makeLifecycle(exact, security: exactSecurity).openLaneStoreDetailed(
        keywrapURL: exact.keywrapURL,
        tapeURL: exact.keywrapURL,
        indexURL: exact.indexURL,
        context: context)
    }
    #expect(exactSecurity.queryCalls.isEmpty)

    for (label, firstName, secondName) in [
      ("case", "Keywrap.eak", "keywrap.eak"),
      ("unicode", "caf\u{00e9}.eak", "cafe\u{0301}.eak"),
    ] {
      let absent = try KeyFixture("absent-alias-\(label)")
      defer { absent.remove() }
      let absentSecurity = FakeArchiveSecurityProvider()
      #expect(throws: ArchiveKeyLifecycleFailure.pathAlias) {
        try makeLifecycle(absent, security: absentSecurity).openLaneStoreDetailed(
          keywrapURL: absent.directory.appendingPathComponent(firstName),
          tapeURL: absent.directory.appendingPathComponent(secondName),
          indexURL: absent.indexURL,
          context: context)
      }
      #expect(absentSecurity.queryCalls.isEmpty)
      #expect(!FileManager.default.fileExists(atPath: absent.keywrapURL.path))
      #expect(
        !FileManager.default.fileExists(
          atPath: absent.directory.appendingPathComponent("EvenScribe").path))
    }

    let hardlink = try KeyFixture("hardlink-alias")
    defer { hardlink.remove() }
    let hardlinkSecurity = FakeArchiveSecurityProvider()
    try writeWrap(hardlink, security: hardlinkSecurity, context: context)
    #expect(link(hardlink.keywrapURL.path, hardlink.tapeURL.path) == 0)
    #expect(throws: ArchiveKeyLifecycleFailure.self) {
      try makeLifecycle(hardlink, security: hardlinkSecurity).openLaneStoreDetailed(
        keywrapURL: hardlink.keywrapURL,
        tapeURL: hardlink.tapeURL,
        indexURL: hardlink.indexURL,
        context: context)
    }

    let mode = try KeyFixture("mode")
    defer { mode.remove() }
    let modeSecurity = FakeArchiveSecurityProvider()
    try writeWrap(mode, security: modeSecurity, context: context)
    #expect(chmod(mode.keywrapURL.path, S_IRUSR | S_IWUSR | S_IRGRP) == 0)
    #expect(throws: ArchiveKeyLifecycleFailure.existingModeMismatch(mode_t(0o640))) {
      try makeLifecycle(mode, security: modeSecurity).openLaneStoreDetailed(
        keywrapURL: mode.keywrapURL,
        tapeURL: mode.tapeURL,
        indexURL: mode.indexURL,
        context: context)
    }

    let parent = try KeyFixture("symlink-parent")
    defer { parent.remove() }
    let alias = parent.directory.deletingLastPathComponent().appendingPathComponent(
      "eta-key-parent-alias-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: alias) }
    try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: parent.directory)
    let aliasSecurity = FakeArchiveSecurityProvider()
    #expect(throws: ArchiveKeyLifecycleFailure.self) {
      try makeLifecycle(parent, security: aliasSecurity).openLaneStoreDetailed(
        keywrapURL: alias.appendingPathComponent("keywrap.eak"),
        tapeURL: alias.appendingPathComponent("primary.tape"),
        indexURL: alias.appendingPathComponent("primary.index"),
        context: context)
    }
    #expect(aliasSecurity.queryCalls.isEmpty)
  }

  @Test func key04ExistingWrapRepairsDurabilityAndRejectsSnapshotMutation() throws {
    let repaired = try KeyFixture("repair-existing")
    defer { repaired.remove() }
    let security = FakeArchiveSecurityProvider()
    try writeWrap(repaired, security: security, context: context)
    let fileSyncs = LockedCounter()
    let directorySyncs = LockedCounter()
    var hooks = ArchiveKeyIOHooks()
    hooks.fullSync = { descriptor in
      _ = fileSyncs.increment()
      return fcntl(descriptor, F_FULLFSYNC)
    }
    hooks.directorySync = { descriptor in
      _ = directorySyncs.increment()
      return Darwin.fsync(descriptor)
    }
    let store = try makeLifecycle(repaired, security: security, ioHooks: hooks)
      .openLaneStoreDetailed(
        keywrapURL: repaired.keywrapURL,
        tapeURL: repaired.tapeURL,
        indexURL: repaired.indexURL,
        context: context)
    store.close()
    #expect(fileSyncs.value >= 3)
    #expect(directorySyncs.value >= 2)

    let mutation = try KeyFixture("snapshot-mutation")
    defer { mutation.remove() }
    let mutationSecurity = FakeArchiveSecurityProvider()
    try writeWrap(mutation, security: mutationSecurity, context: context)
    let keywrapStats = LockedCounter()
    var mutationHooks = ArchiveKeyIOHooks()
    mutationHooks.fstat = { descriptor, value in
      let result = Darwin.fstat(descriptor, value)
      if result == 0, value.pointee.st_mode & S_IFMT == S_IFREG,
        value.pointee.st_size >= ArchiveKeywrapCodec.headerByteCount,
        keywrapStats.increment() == 2
      {
        value.pointee.st_size += 1
      }
      return result
    }
    #expect(throws: ArchiveKeyLifecycleFailure.self) {
      try makeLifecycle(
        mutation, security: mutationSecurity, ioHooks: mutationHooks
      ).openLaneStoreDetailed(
        keywrapURL: mutation.keywrapURL,
        tapeURL: mutation.tapeURL,
        indexURL: mutation.indexURL,
        context: context)
    }
  }

  @Test func key04ReservationValidationAndSyncFailuresLeaveNoPathOrDescriptor() throws {
    for (target, validationFailure) in [
      ("tape", true), ("tape", false), ("index", true), ("index", false),
    ] {
      let fixture = try KeyFixture("reserve-\(target)-\(validationFailure ? "validate" : "sync")")
      defer { fixture.remove() }
      let descriptors = LockedNamedDescriptors()
      let fstatCalls = LockedDescriptorCounts()
      var hooks = ArchiveKeyIOHooks()
      hooks.openAt = { directory, name, flags, permissions in
        let descriptor = Darwin.openat(directory, name, flags, permissions)
        if descriptor >= 0, name == fixture.tapeURL.lastPathComponent {
          descriptors.set(descriptor, for: "tape")
        }
        if descriptor >= 0, name == fixture.indexURL.lastPathComponent {
          descriptors.set(descriptor, for: "index")
        }
        return descriptor
      }
      hooks.fstat = { descriptor, value in
        let result = Darwin.fstat(descriptor, value)
        let call = fstatCalls.record(descriptor)
        if result == 0, validationFailure, descriptor == descriptors.value(for: target), call == 2 {
          value.pointee.st_mode |= mode_t(S_IRGRP)
        }
        return result
      }
      hooks.fullSync = { descriptor in
        if !validationFailure, descriptor == descriptors.value(for: target) {
          errno = EIO
          return -1
        }
        return fcntl(descriptor, F_FULLFSYNC)
      }
      let paths = try ArchiveValidatedKeyPaths(
        keywrapURL: fixture.keywrapURL,
        tapeURL: fixture.tapeURL,
        indexURL: fixture.indexURL,
        hooks: hooks)
      #expect(throws: ArchiveKeyLifecycleFailure.self) {
        try ArchiveKeyDurableStore(hooks: hooks).reserveLanePair(
          tape: paths.tape, index: paths.index, expectedIdentities: nil)
      }
      #expect(!FileManager.default.fileExists(atPath: fixture.tapeURL.path))
      #expect(!FileManager.default.fileExists(atPath: fixture.indexURL.path))
      for descriptor in descriptors.values {
        errno = 0
        #expect(fcntl(descriptor, F_GETFD) == -1)
        #expect(errno == EBADF)
      }
    }
  }

  @Test func key04ReservationAndTemporaryCleanupDenialsAreLoud() throws {
    let fixture = try KeyFixture("cleanup-denial")
    defer { fixture.remove() }
    var hooks = ArchiveKeyIOHooks()
    hooks.unlinkAt = { directory, name in
      if name == fixture.indexURL.lastPathComponent {
        errno = EACCES
        return -1
      }
      return Darwin.unlinkat(directory, name, 0)
    }
    let security = FakeArchiveSecurityProvider()
    #expect(throws: ArchiveKeyLifecycleFailure.reservationCleanupFailed(errno: EACCES)) {
      try makeLifecycle(
        fixture,
        security: security,
        ioHooks: hooks,
        random: { _ in throw ArchiveKeyLifecycleFailure.randomGenerationFailed(-77) }
      ).openLaneStoreDetailed(
        keywrapURL: fixture.keywrapURL,
        tapeURL: fixture.tapeURL,
        indexURL: fixture.indexURL,
        context: context)
    }
    #expect(FileManager.default.fileExists(atPath: fixture.indexURL.path))
    #expect(!FileManager.default.fileExists(atPath: fixture.keywrapURL.path))

    let temporary = try KeyFixture("temporary-cleanup-denial")
    defer { temporary.remove() }
    var temporaryHooks = ArchiveKeyIOHooks()
    temporaryHooks.temporarySuffix = { "retained" }
    temporaryHooks.renameExclusiveAt = { _, _, _ in
      errno = EIO
      return -1
    }
    temporaryHooks.unlinkAt = { _, name in
      if name.contains(".tmp.retained") {
        errno = EACCES
        return -1
      }
      return -1
    }
    let durable = ArchiveKeyDurableStore(hooks: temporaryHooks)
    let paths = try ArchiveValidatedKeyPaths(
      keywrapURL: temporary.keywrapURL,
      tapeURL: temporary.tapeURL,
      indexURL: temporary.indexURL,
      hooks: temporaryHooks)
    #expect(throws: ArchiveKeyLifecycleFailure.self) {
      try durable.publishCreateOnly(Data("candidate".utf8), at: paths.keywrap)
    }
    #expect(
      FileManager.default.fileExists(
        atPath: temporary.directory.appendingPathComponent(".keywrap.eak.tmp.retained").path))
  }

  @Test func key04CanonicalGlobalLockRejectsSymlinkParentWithRedactedPublicError() throws {
    let fixture = try KeyFixture("canonical-lock-symlink")
    defer { fixture.remove() }
    let outside = fixture.directory.appendingPathComponent("outside", isDirectory: true)
    try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
    try FileManager.default.createSymbolicLink(
      at: fixture.directory.appendingPathComponent("EvenScribe"), withDestinationURL: outside)
    let security = FakeArchiveSecurityProvider()
    #expect(throws: ArchiveKeyLifecycleError.archiveKeyUnavailable) {
      try makeLifecycle(fixture, security: security).openLaneStore(
        keywrapURL: fixture.keywrapURL,
        tapeURL: fixture.tapeURL,
        indexURL: fixture.indexURL,
        context: context)
    }
    #expect(security.queryCalls.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: fixture.keywrapURL.path))
    #expect(!FileManager.default.fileExists(atPath: fixture.tapeURL.path))
    #expect(!FileManager.default.fileExists(atPath: fixture.indexURL.path))
  }

  @Test func key04NextDayOpenDerivesEmptyOriginFromOldAuthenticatedWitness() throws {
    let fixture = try KeyFixture("next-day-origin")
    defer { fixture.remove() }
    let security = FakeArchiveSecurityProvider()
    let random = OrderedRandom([
      root, Data(repeating: 0xA5, count: 16),
      Data(repeating: 0xB1, count: 32), Data(repeating: 0xB2, count: 16),
    ])
    let lifecycle = makeLifecycle(fixture, security: security, random: random.next)
    let old = try lifecycle.openLaneStoreWithInspection(
      keywrapURL: fixture.keywrapURL,
      tapeURL: fixture.tapeURL,
      indexURL: fixture.indexURL,
      context: context)
    #expect(old.keywrap.authenticated)
    _ = try old.store.appendPCM(
      keyHex("01000200"),
      observation: ArchiveIndexObservation(
        monoNS: nil, wallNS: nil, rmsQ15: 0, nativeFrames: nil,
        inputRateNumerator: nil, inputRateDenominator: nil))
    let oldSnapshot = try old.store.authenticatedSnapshot()
    old.store.close()
    #expect(old.keywrap.keywrapDigestHex == keySHA256(try Data(contentsOf: fixture.keywrapURL)))

    var newStream = Data(repeating: 0xB3, count: 16)
    newStream[6] = (newStream[6] & 0x0F) | 0x40
    newStream[8] = (newStream[8] & 0x3F) | 0x80
    let newContext = ArchiveContext(
      streamUUID: newStream,
      roomID: context.roomID,
      istDate: "2026-08-28",
      laneID: context.laneID,
      stableDeviceUID: context.stableDeviceUID)
    let newKeywrap = fixture.directory.appendingPathComponent("next.keywrap.eak")
    let newTape = fixture.directory.appendingPathComponent("next.tape")
    let newIndex = fixture.directory.appendingPathComponent("next.index")
    #expect(throws: ArchiveKeyLifecycleError.archiveKeyUnavailable) {
      try lifecycle.openNextDayLaneStore(
        keywrapURL: newKeywrap,
        tapeURL: newTape,
        indexURL: newIndex,
        context: newContext,
        oldDaySnapshot: oldSnapshot,
        expectedInitialSamplePosition: 3)
    }
    #expect(!FileManager.default.fileExists(atPath: newKeywrap.path))
    #expect(!FileManager.default.fileExists(atPath: newTape.path))
    #expect(!FileManager.default.fileExists(atPath: newIndex.path))

    let new = try lifecycle.openNextDayLaneStore(
      keywrapURL: newKeywrap,
      tapeURL: newTape,
      indexURL: newIndex,
      context: newContext,
      oldDaySnapshot: oldSnapshot,
      expectedInitialSamplePosition: 2)
    #expect(new.store.initialSamplePosition == 2)
    #expect(new.store.scanResult.index.records.isEmpty)
    #expect(new.keywrap.keywrapDigestHex == keySHA256(try Data(contentsOf: newKeywrap)))
    #expect(new.keywrap.keywrapDigestHex != old.keywrap.keywrapDigestHex)
    new.store.close()
    let newKeywrapBefore = try Data(contentsOf: newKeywrap)
    #expect(throws: ArchiveKeyLifecycleError.archiveKeyUnavailable) {
      try lifecycle.openNextDayLaneStore(
        keywrapURL: newKeywrap,
        tapeURL: newTape,
        indexURL: newIndex,
        context: newContext,
        oldDaySnapshot: oldSnapshot,
        expectedInitialSamplePosition: 3)
    }
    #expect(try Data(contentsOf: newKeywrap) == newKeywrapBefore)
    #expect(try Data(contentsOf: newTape).isEmpty)
    #expect(try Data(contentsOf: newIndex).isEmpty)
    oldSnapshot.close()
    #expect(random.remaining == 0)
  }

  @Test func keyPreflightPerformsCanonicalInMemoryRoundTripWithoutArchiveArtifacts() throws {
    let fixture = try KeyFixture("preflight-round-trip")
    defer { fixture.remove() }
    let security = FakeArchiveSecurityProvider()
    let random = OrderedRandom([
      Data(repeating: 0x31, count: 32),
      Data(repeating: 0x32, count: 32),
    ])
    let lifecycle = makeLifecycle(
      fixture,
      security: security,
      random: random.next)
    let expectedHash = Data(SHA256.hash(data: security.publicRepresentation)).map {
      String(format: "%02x", $0)
    }.joined()

    #expect(try lifecycle.probeSecureEnclaveKey() == expectedHash)
    #expect(try lifecycle.probeSecureEnclaveKey() == expectedHash)
    #expect(security.createCalls.count == 1)
    #expect(random.remaining == 0)
    #expect(!FileManager.default.fileExists(atPath: fixture.keywrapURL.path))
    #expect(!FileManager.default.fileExists(atPath: fixture.tapeURL.path))
    #expect(!FileManager.default.fileExists(atPath: fixture.indexURL.path))
    #expect(
      FileManager.default.fileExists(
        atPath: fixture.directory.appendingPathComponent(
          "EvenScribe/RoomRecorder/archive-wrap-v1.lock"
        ).path))
  }

  @Test func keyPreflightSerializesCanonicalProvisioningAcrossLifecycleInstances() async throws {
    let fixture = try KeyFixture("preflight-global-lock")
    defer { fixture.remove() }
    let security = FakeArchiveSecurityProvider()
    security.emptyQueryDelay = 0.05
    let firstRandom = OrderedRandom([Data(repeating: 0x41, count: 32)])
    let secondRandom = OrderedRandom([Data(repeating: 0x42, count: 32)])
    let first = makeLifecycle(fixture, security: security, random: firstRandom.next)
    let second = makeLifecycle(fixture, security: security, random: secondRandom.next)

    let hashes = try await withThrowingTaskGroup(of: String.self) { group in
      group.addTask { try first.probeSecureEnclaveKey() }
      group.addTask { try second.probeSecureEnclaveKey() }
      var values: [String] = []
      for try await value in group { values.append(value) }
      return values
    }

    #expect(Set(hashes).count == 1)
    #expect(security.createCalls.count == 1)
    #expect(firstRandom.remaining == 0)
    #expect(secondRandom.remaining == 0)
  }

  @Test func keyPreflightFailsClosedForUnsupportedAlgorithmAndMalformedPublicKey() throws {
    let unsupportedFixture = try KeyFixture("preflight-unsupported")
    defer { unsupportedFixture.remove() }
    let unsupported = FakeArchiveSecurityProvider(initialKeyCount: 1)
    unsupported.algorithmSupported = false
    #expect(throws: ArchiveKeyLifecycleError.secureHardwareUnavailable) {
      try makeLifecycle(unsupportedFixture, security: unsupported).probeSecureEnclaveKey()
    }

    let malformedFixture = try KeyFixture("preflight-malformed")
    defer { malformedFixture.remove() }
    let malformed = FakeArchiveSecurityProvider(initialKeyCount: 1)
    malformed.publicRepresentation = Data(repeating: 0x04, count: 64)
    #expect(throws: ArchiveKeyLifecycleError.archiveKeyUnavailable) {
      try makeLifecycle(malformedFixture, security: malformed).probeSecureEnclaveKey()
    }
    #expect(!FileManager.default.fileExists(atPath: malformedFixture.keywrapURL.path))
    #expect(!FileManager.default.fileExists(atPath: malformedFixture.tapeURL.path))
    #expect(!FileManager.default.fileExists(atPath: malformedFixture.indexURL.path))
  }

  private func encodedOuter(wrappedData: Data) throws -> Data {
    try ArchiveKeywrapCodec.encode(
      ArchiveKeywrapOuter(
        streamUUID: stream,
        contextHash: try context.sha256(),
        publicKeyHash: Data(repeating: 3, count: 32),
        wrappedData: wrappedData))
  }

  private func makeLifecycle(
    _ fixture: KeyFixture,
    security: FakeArchiveSecurityProvider,
    ioHooks: ArchiveKeyIOHooks = ArchiveKeyIOHooks(),
    applicationSupportRoot: URL? = nil,
    random: @escaping (Int) throws -> Data = { Data(repeating: UInt8($0), count: $0) },
    onRootRelease: @escaping (Data) throws -> Void = { _ in },
    reservedControlStoreOpener:
      @escaping (URL, Int32, Int32, Data, ArchiveContext) throws -> ArchiveDerivedStore = {
        url, fileDescriptor, directoryFileDescriptor, rootKey, context in
        try ArchiveDerivedStore.openReservedForAppend(
          url: url,
          fileDescriptor: fileDescriptor,
          directoryFileDescriptor: directoryFileDescriptor,
          purpose: .control,
          rootKey: rootKey,
          context: context)
      }
  ) -> ArchiveKeyLifecycle {
    ArchiveKeyLifecycle(
      security: security,
      durableStore: ArchiveKeyDurableStore(hooks: ioHooks),
      applicationSupportRoot: applicationSupportRoot ?? fixture.directory,
      randomBytes: random,
      reservedLaneStoreOpener: {
        tape, index, tapeFD, indexFD, releasedRoot, context, initialSamplePosition in
        try onRootRelease(releasedRoot)
        return try ArchiveLaneStore.openReservedForAppend(
          tapeURL: tape,
          indexURL: index,
          tapeFileDescriptor: tapeFD,
          indexFileDescriptor: indexFD,
          rootKey: releasedRoot,
          context: context,
          initialSamplePosition: initialSamplePosition)
      },
      reservedControlStoreOpener: reservedControlStoreOpener)
  }

  private func writeWrap(
    _ fixture: KeyFixture,
    security: FakeArchiveSecurityProvider,
    context: ArchiveContext
  ) throws {
    let lifecycle = makeLifecycle(
      fixture, security: security,
      random: OrderedRandom([
        root, Data(repeating: 0xA5, count: 16),
      ]).next)
    let store = try lifecycle.openLaneStoreDetailed(
      keywrapURL: fixture.keywrapURL,
      tapeURL: fixture.tapeURL,
      indexURL: fixture.indexURL,
      context: context)
    store.close()
    try FileManager.default.removeItem(at: fixture.tapeURL)
    try FileManager.default.removeItem(at: fixture.indexURL)
  }

  private func expectExactQuery(_ query: [String: Any]) throws {
    #expect(query.count == 8)
    #expect((query[kSecClass as String] as? String) == (kSecClassKey as String))
    #expect(
      (query[kSecAttrApplicationTag as String] as? Data) == ArchiveKeyLifecycle.applicationTag)
    #expect(
      (query[kSecAttrTokenID as String] as? String) == (kSecAttrTokenIDSecureEnclave as String))
    #expect(
      (query[kSecAttrKeyType as String] as? String) == (kSecAttrKeyTypeECSECPrimeRandom as String))
    #expect((query[kSecAttrKeyClass as String] as? String) == (kSecAttrKeyClassPrivate as String))
    #expect((query[kSecUseDataProtectionKeychain as String] as? Bool) == true)
    #expect((query[kSecReturnRef as String] as? Bool) == true)
    #expect((query[kSecMatchLimit as String] as? String) == (kSecMatchLimitAll as String))
  }

  private func expectExactCreation(_ attributes: [String: Any], accessControl: AnyObject) throws {
    #expect(attributes.count == 4)
    #expect(
      (attributes[kSecAttrTokenID as String] as? String) == (kSecAttrTokenIDSecureEnclave as String)
    )
    #expect(
      (attributes[kSecAttrKeyType as String] as? String)
        == (kSecAttrKeyTypeECSECPrimeRandom as String))
    #expect((attributes[kSecAttrKeySizeInBits as String] as? Int) == 256)
    let privateAttributes = try #require(
      attributes[kSecPrivateKeyAttrs as String] as? [String: Any])
    #expect(privateAttributes.count == 3)
    #expect((privateAttributes[kSecAttrIsPermanent as String] as? Bool) == true)
    #expect(
      (privateAttributes[kSecAttrApplicationTag as String] as? Data)
        == ArchiveKeyLifecycle.applicationTag)
    #expect(privateAttributes[kSecAttrAccessControl as String] as AnyObject === accessControl)
    #expect(privateAttributes[kSecUseAuthenticationUI as String] == nil)
  }

  #if ETA_KEYWRAP_PROBE
    @Test func key04ProbePathParserRejectsRelativePathsBeforeURLConstruction() {
      for path in ["keywrap.eak", "lane/primary.tape", ".", ""] {
        #expect(ArchiveKeywrapProbePathParser.fileURL(path) == nil)
      }
      #expect(
        ArchiveKeywrapProbePathParser.fileURL("/tmp/keywrap.eak")?.path
          == "/tmp/keywrap.eak")
      #expect(
        ArchiveKeywrapProbePathParser.fileURL("/tmp/tamper", isDirectory: true)?.path
          == "/tmp/tamper")
    }
  #endif
}

private final class FakeArchiveSecurityProvider: ArchiveKeySecurityProviding, @unchecked Sendable {
  private let lock = NSLock()
  private var keys: [ArchiveSecurityKey]
  private var encrypted: [Data: Data] = [:]
  private var nextCipher: UInt64 = 1
  var queryFailure: OSStatus?
  var duplicateAfterCreate = false
  var algorithmSupported = true
  var emptyQueryDelay: TimeInterval = 0
  var beforeDecrypt: () -> Void = {}
  var publicRepresentation = Data([0x04]) + Data((0..<64).map(UInt8.init))
  let accessControl: AnyObject = NSObject()
  private(set) var accessibility: CFString?
  private(set) var accessFlags: SecAccessControlCreateFlags = []
  private(set) var queryCalls: [[String: Any]] = []
  private(set) var createCalls: [[String: Any]] = []
  private(set) var algorithms: [SecKeyAlgorithm] = []
  private(set) var operations: [SecKeyOperationType] = []

  init(initialKeyCount: Int = 0) {
    keys = (0..<initialKeyCount).map { _ in ArchiveSecurityKey(NSObject()) }
  }

  func makeAccessControl(accessibility: CFString, flags: SecAccessControlCreateFlags) throws
    -> AnyObject
  {
    lock.withLock {
      self.accessibility = accessibility
      accessFlags = flags
    }
    return accessControl
  }

  func queryKeys(_ query: [String: Any]) throws -> [ArchiveSecurityKey] {
    let result = try lock.withLock {
      queryCalls.append(query)
      if let queryFailure { throw ArchiveKeyLifecycleFailure.keyQueryFailed(queryFailure) }
      return keys
    }
    if result.isEmpty, emptyQueryDelay > 0 { Thread.sleep(forTimeInterval: emptyQueryDelay) }
    return result
  }

  func createKey(_ attributes: [String: Any]) throws -> ArchiveSecurityKey {
    lock.withLock {
      createCalls.append(attributes)
      let key = ArchiveSecurityKey(NSObject())
      keys.append(key)
      if duplicateAfterCreate { keys.append(ArchiveSecurityKey(NSObject())) }
      return key
    }
  }

  func publicKey(for privateKey: ArchiveSecurityKey) throws -> ArchiveSecurityKey {
    ArchiveSecurityKey(NSObject())
  }

  func externalRepresentation(of key: ArchiveSecurityKey) throws -> Data { publicRepresentation }

  func supports(
    _ algorithm: SecKeyAlgorithm, operation: SecKeyOperationType, key: ArchiveSecurityKey
  ) -> Bool {
    lock.withLock {
      algorithms.append(algorithm)
      operations.append(operation)
      return algorithmSupported
    }
  }

  func encrypt(_ plaintext: Data, with key: ArchiveSecurityKey, algorithm: SecKeyAlgorithm) throws
    -> Data
  {
    lock.withLock {
      algorithms.append(algorithm)
      operations.append(.encrypt)
      var counter = nextCipher.littleEndian
      let ciphertext = withUnsafeBytes(of: &counter) { Data($0) }
      nextCipher += 1
      encrypted[ciphertext] = plaintext
      return ciphertext
    }
  }

  func decrypt(_ ciphertext: Data, with key: ArchiveSecurityKey, algorithm: SecKeyAlgorithm) throws
    -> Data
  {
    beforeDecrypt()
    return try lock.withLock {
      algorithms.append(algorithm)
      operations.append(.decrypt)
      guard let plaintext = encrypted[ciphertext] else {
        throw ArchiveKeyLifecycleFailure.decryptionFailed
      }
      return plaintext
    }
  }

  func deleteKeys(_ query: [String: Any]) throws { lock.withLock { keys = [] } }

  func removeAllKeys() { lock.withLock { keys = [] } }

  func replacePlaintext(for ciphertext: Data, with plaintext: Data) {
    lock.withLock { encrypted[ciphertext] = plaintext }
  }
}

private final class OrderedRandom: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [Data]
  init(_ values: [Data]) { self.values = values }
  var remaining: Int { lock.withLock { values.count } }
  func next(count: Int) throws -> Data {
    try lock.withLock {
      guard !values.isEmpty else { throw ArchiveKeyLifecycleFailure.randomGenerationFailed(-1) }
      return values.removeFirst()
    }
  }
}

private final class KeyOwnerNow: @unchecked Sendable {
  private let lock = NSLock()
  private var date: Date

  init(_ date: Date) { self.date = date }

  var value: Date {
    get { lock.withLock { date } }
    set { lock.withLock { date = newValue } }
  }
}

private struct KeyFixture {
  let directory: URL
  let keywrapURL: URL
  let tapeURL: URL
  let indexURL: URL
  let journalURL: URL

  init(_ label: String) throws {
    let requested = FileManager.default.temporaryDirectory.appendingPathComponent(
      "eta-key-p1-\(label)-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: requested, withIntermediateDirectories: false)
    guard let canonical = Darwin.realpath(requested.path, nil) else {
      throw ArchiveKeyLifecycleFailure.invalidPath
    }
    defer { Darwin.free(canonical) }
    directory = URL(fileURLWithPath: String(cString: canonical), isDirectory: true)
    keywrapURL = directory.appendingPathComponent("keywrap.eak")
    tapeURL = directory.appendingPathComponent("primary.tape")
    indexURL = directory.appendingPathComponent("primary.index")
    journalURL = directory.appendingPathComponent("control.journal")
  }

  func remove() { try? FileManager.default.removeItem(at: directory) }
}

private final class KeyOwnerCapture: PrimaryResidentAudioCapturing, @unchecked Sendable {
  private let store: ArchiveLaneStore
  private var active = false
  private var finalizationRequired = false

  init(store: ArchiveLaneStore) { self.store = store }

  var isActive: Bool { active }
  var requiresFinalization: Bool { finalizationRequired }
  var durableSampleEnd: UInt64 {
    store.scanResult.index.records.last?.payload.sampleEnd ?? store.initialSamplePosition
  }
  var currentLevels: ResidentAudioCaptureLevels? { nil }

  func startAndWaitUntilDurable() throws {
    _ = try store.appendPCM(
      Data(repeating: 0x20, count: 32_000),
      observation: ArchiveIndexObservation(
        monoNS: 1_000_000_000,
        wallNS: 2_000_000_000,
        rmsQ15: 100,
        nativeFrames: 48_000,
        inputRateNumerator: 48_000,
        inputRateDenominator: 1,
        discontinuity: .resumed,
        reason: ArchiveIndexDiscontinuity.resumed.rawValue,
        gapNS: 0))
    active = true
    finalizationRequired = true
  }

  func service() throws {}

  func stopAndDrain() throws {
    guard finalizationRequired else { return }
    active = false
    finalizationRequired = false
    store.close()
  }

  func authenticatedSnapshot() throws -> ArchiveLaneStore.AuthenticatedSnapshot {
    try store.authenticatedSnapshot()
  }
}

private enum KeyOwnerCrash: Error, Equatable {
  case bindingPersistence
  case beforeGrowth
}

private final class KeyOwnerCaptureStartCalls: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  var count: Int { lock.withLock { value } }
  func increment() { lock.withLock { value += 1 } }
}

private final class KeyOwnerCrashCapture: PrimaryResidentAudioCapturing, @unchecked Sendable {
  private let store: ArchiveLaneStore
  private let calls: KeyOwnerCaptureStartCalls
  private let failBeforeGrowth: Bool
  private var active = false
  private var finalizationRequired = false

  init(
    store: ArchiveLaneStore,
    calls: KeyOwnerCaptureStartCalls,
    failBeforeGrowth: Bool
  ) {
    self.store = store
    self.calls = calls
    self.failBeforeGrowth = failBeforeGrowth
  }

  var isActive: Bool { active }
  var requiresFinalization: Bool { finalizationRequired }
  var durableSampleEnd: UInt64 {
    store.scanResult.index.records.last?.payload.sampleEnd ?? store.initialSamplePosition
  }
  var currentLevels: ResidentAudioCaptureLevels? { nil }

  func startAndWaitUntilDurable() throws {
    calls.increment()
    if failBeforeGrowth { throw KeyOwnerCrash.beforeGrowth }
    _ = try store.appendPCM(
      Data(repeating: 0x25, count: 32_000),
      observation: ArchiveIndexObservation(
        monoNS: 1_000_000_000,
        wallNS: 2_000_000_000,
        rmsQ15: 100,
        nativeFrames: 48_000,
        inputRateNumerator: 48_000,
        inputRateDenominator: 1,
        discontinuity: .resumed,
        reason: ArchiveIndexDiscontinuity.resumed.rawValue,
        gapNS: 0))
    active = true
    finalizationRequired = true
  }

  func service() throws {}

  func stopAndDrain() throws {
    active = false
    finalizationRequired = false
    store.close()
  }

  func authenticatedSnapshot() throws -> ArchiveLaneStore.AuthenticatedSnapshot {
    try store.authenticatedSnapshot()
  }
}

private final class KeyOwnerRolloverCapture: PrimaryResidentAudioCapturing, @unchecked Sendable {
  private var store: ArchiveLaneStore
  private let rolloverStoreFactory: ResidentAudioCaptureLane.RolloverStoreFactory
  private let rolloverWallNSs: [UInt64]
  private let order: KeyOwnerRolloverOrder
  private var active = false
  private var finalizationRequired = false
  private var rolloverIndex = 0

  init(
    store: ArchiveLaneStore,
    rolloverStoreFactory: @escaping ResidentAudioCaptureLane.RolloverStoreFactory,
    rolloverWallNS: UInt64,
    order: KeyOwnerRolloverOrder
  ) {
    self.store = store
    self.rolloverStoreFactory = rolloverStoreFactory
    rolloverWallNSs = [rolloverWallNS]
    self.order = order
  }

  init(
    store: ArchiveLaneStore,
    rolloverStoreFactory: @escaping ResidentAudioCaptureLane.RolloverStoreFactory,
    rolloverWallNSs: [UInt64],
    order: KeyOwnerRolloverOrder
  ) {
    self.store = store
    self.rolloverStoreFactory = rolloverStoreFactory
    self.rolloverWallNSs = rolloverWallNSs
    self.order = order
  }

  var isActive: Bool { active }
  var requiresFinalization: Bool { finalizationRequired }
  var durableSampleEnd: UInt64 {
    store.scanResult.index.records.last?.payload.sampleEnd ?? store.initialSamplePosition
  }
  var currentLevels: ResidentAudioCaptureLevels? { nil }

  func startAndWaitUntilDurable() throws {
    try appendPCM(byte: 0x31)
    active = true
    finalizationRequired = true
  }

  func service() throws {
    guard rolloverIndex < rolloverWallNSs.count else { return }
    let rolloverWallNS = rolloverWallNSs[rolloverIndex]
    let snapshot = try store.authenticatedSnapshot()
    let facts = snapshot.authenticatedFacts
    snapshot.close()
    let replacement = try rolloverStoreFactory(
      ResidentArchiveRolloverFence(
        monoNS: 10_000,
        wallNS: rolloverWallNS,
        authenticatedFacts: facts))
    store.close()
    order.record("old_close")
    store = replacement
    try appendPCM(byte: 0x32 &+ UInt8(rolloverIndex))
    rolloverIndex += 1
  }

  func stopAndDrain() throws {
    guard finalizationRequired else { return }
    active = false
    finalizationRequired = false
    store.close()
  }

  func authenticatedSnapshot() throws -> ArchiveLaneStore.AuthenticatedSnapshot {
    try store.authenticatedSnapshot()
  }

  private func appendPCM(byte: UInt8) throws {
    _ = try store.appendPCM(
      Data(repeating: byte, count: 32_000),
      observation: ArchiveIndexObservation(
        monoNS: 1_000_000_000,
        wallNS: rolloverWallNSs[min(rolloverIndex, rolloverWallNSs.count - 1)],
        rmsQ15: 100,
        nativeFrames: 48_000,
        inputRateNumerator: 48_000,
        inputRateDenominator: 1))
  }
}

private final class KeyOwnerRolloverOrder: @unchecked Sendable {
  private let lock = NSLock()
  private var events: [String] = []
  var values: [String] { lock.withLock { events } }
  func record(_ event: String) { lock.withLock { events.append(event) } }
}

private final class KeyOwnerEncoderCalls: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  var count: Int { lock.withLock { value } }
  func increment() { lock.withLock { value += 1 } }
}

private struct KeyOwnerSpoolEncoder: ArchivePCMSpoolEncoding {
  let calls: KeyOwnerEncoderCalls

  func encode(
    snapshot _: ArchiveLaneStore.AuthenticatedSnapshot,
    sampleStart _: UInt64,
    sampleEnd _: UInt64,
    spoolWriter: ArchiveEncryptedSpoolWriter
  ) throws -> ArchiveEncodedSpoolAttempt {
    calls.increment()
    try spoolWriter.append(Data("synthetic-webm".utf8))
    return try spoolWriter.finishEncoding()
  }
}

private actor KeyOwnerDeliveryWire: ArchiveDeliveryWire {
  private let putURL = URL(string: "https://r2.test/owner-put")!
  private let headURL = URL(string: "https://r2.test/owner-head")!
  private var object: Data?
  private(set) var registrationCount = 0
  private let endedDisagrees: String?

  init(endedDisagrees: String? = nil) {
    self.endedDisagrees = endedDisagrees
  }

  func prepareDelivery(for piece: ArchiveDeliveryPiece) async throws
    -> ArchiveDeliveryPresignResult
  {
    .upload(putURL: putURL, headURL: headURL, key: "bench/owner/chunk_00003.webm")
  }

  func probeDeliveryObject(at url: URL) async throws -> ArchiveDeliveryRemoteObject {
    object.map { .present(byteCount: UInt64($0.count)) } ?? .missing
  }

  func putDeliveryObject(chunks: [Data], to url: URL, contentType: String) async throws {
    object = chunks.reduce(into: Data()) { $0.append($1) }
  }

  func registerDelivery(_ piece: ArchiveDeliveryPiece) async throws
    -> ArchiveDeliveryRegistration
  {
    registrationCount += 1
    return ArchiveDeliveryRegistration(
      ok: true,
      key: "bench/owner/chunk_00003.webm",
      uploadState: "verified",
      endedDisagrees: endedDisagrees)
  }
}

private actor KeyCompleteRecovery: RoomRetainedArchiveRecovering {
  nonisolated let encoderCapable = true
  func run() {}
  func state() -> RoomRetainedArchiveRecoveryState { .complete }
}

private final class KeyRefusingCaptureLauncher: RoomCaptureLaunching, @unchecked Sendable {
  func launch(executable: URL, outputDirectory: URL, deviceUID: String, logURL: URL) throws
    -> any RoomCaptureProcess
  {
    throw KeyUnusedWireError.called
  }
}

private actor KeyCrashReconciliationRemote: RoomEngineRemote {
  private let activeOK: Bool
  private(set) var patchCalls = 0

  init(activeOK: Bool) { self.activeOK = activeOK }

  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
    try JSONDecoder().decode(
      ActiveSessionResponse.self,
      from: Data(
        """
        {"ok":\(activeOK),"resumable":false,"session":null,"next_idx":null,"reason":null,"handover_pending":false,"tab_gone":false}
        """.utf8))
  }

  func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
    throw KeyUnusedWireError.called
  }

  func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws
    -> BenchOKResponse
  {
    patchCalls += 1
    throw KeyUnusedWireError.called
  }

  func pollCommands(
    tabID: String,
    previousPollAt: String?,
    recordingSessionID: String?,
    paused: Bool,
    primaryLevels: BenchLevelPair?
  ) async throws -> CommandPollResponse {
    try JSONDecoder().decode(
      CommandPollResponse.self,
      from: Data(#"{"ok":true,"room_id":"room_1","superseded":false,"commands":[]}"#.utf8))
  }

  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  {
    throw KeyUnusedWireError.called
  }

  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse {
    throw KeyUnusedWireError.called
  }

  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws
    -> ImmutablePieceUploadResult
  {
    throw KeyUnusedWireError.called
  }
}

private enum WrapMutation: String, CaseIterable {
  case publicHash
  case ciphertext
  case innerStream
  case innerContext
  case innerMagic

  func apply(to url: URL, security: FakeArchiveSecurityProvider) {
    var bytes = try! Data(contentsOf: url)
    switch self {
    case .publicHash:
      bytes[64] ^= 1
      try! bytes.write(to: url)
    case .ciphertext:
      bytes[ArchiveKeywrapCodec.headerByteCount] ^= 1
      try! bytes.write(to: url)
    case .innerStream, .innerContext, .innerMagic:
      let outer = try! ArchiveKeywrapCodec.decode(bytes)
      var plaintext = try! security.decrypt(
        outer.wrappedData,
        with: ArchiveSecurityKey(NSObject()),
        algorithm: .eciesEncryptionCofactorVariableIVX963SHA256AESGCM)
      let offset: Int
      switch self {
      case .innerStream: offset = 48
      case .innerContext: offset = 64
      case .innerMagic: offset = 0
      default: fatalError()
      }
      plaintext[offset] ^= 1
      security.replacePlaintext(for: outer.wrappedData, with: plaintext)
    }
  }
}

private final class LockedCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0
  var value: Int { lock.withLock { count } }
  func increment() -> Int {
    lock.withLock {
      count += 1
      return count
    }
  }
  func takeFirst() -> Bool { increment() == 1 }
}

private final class LockedDescriptor: @unchecked Sendable {
  private let lock = NSLock()
  private var descriptor: Int32?
  var value: Int32? { lock.withLock { descriptor } }
  func set(_ value: Int32) { lock.withLock { descriptor = value } }
}

private final class LockedDescriptorCounts: @unchecked Sendable {
  private let lock = NSLock()
  private var counts: [Int32: Int] = [:]
  @discardableResult
  func record(_ descriptor: Int32) -> Int {
    lock.withLock {
      counts[descriptor, default: 0] += 1
      return counts[descriptor]!
    }
  }
  func count(for descriptor: Int32) -> Int { lock.withLock { counts[descriptor, default: 0] } }
}

private struct KeyUnusedWire: ArchiveDeliveryWire {
  func prepareDelivery(for piece: ArchiveDeliveryPiece) async throws
    -> ArchiveDeliveryPresignResult
  {
    throw KeyUnusedWireError.called
  }

  func probeDeliveryObject(at url: URL) async throws -> ArchiveDeliveryRemoteObject {
    throw KeyUnusedWireError.called
  }

  func putDeliveryObject(chunks: [Data], to url: URL, contentType: String) async throws {
    throw KeyUnusedWireError.called
  }

  func registerDelivery(_ piece: ArchiveDeliveryPiece) async throws
    -> ArchiveDeliveryRegistration
  {
    throw KeyUnusedWireError.called
  }
}

private enum KeyUnusedWireError: Error {
  case called
}

private final class LockedNamedDescriptors: @unchecked Sendable {
  private let lock = NSLock()
  private var descriptors: [String: Int32] = [:]
  var values: [Int32] { lock.withLock { Array(descriptors.values) } }
  func set(_ descriptor: Int32, for name: String) {
    lock.withLock { descriptors[name] = descriptor }
  }
  func value(for name: String) -> Int32? { lock.withLock { descriptors[name] } }
}

private final class LockedErrors: @unchecked Sendable {
  private let lock = NSLock()
  private var errors: [any Error] = []
  var values: [any Error] { lock.withLock { errors } }
  func append(_ error: any Error) { lock.withLock { errors.append(error) } }
}

private func keyHex(_ value: String) -> Data {
  var result = Data()
  var index = value.startIndex
  while index < value.endIndex {
    let end = value.index(index, offsetBy: 2)
    result.append(UInt8(value[index..<end], radix: 16)!)
    index = end
  }
  return result
}

private func keyUUID(_ byte: UInt8) -> Data {
  var value = Data(repeating: byte, count: 16)
  value[6] = (value[6] & 0x0F) | 0x40
  value[8] = (value[8] & 0x3F) | 0x80
  return value
}

private func keySHA256(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func permissions(of url: URL) throws -> mode_t {
  var value = stat()
  guard lstat(url.path, &value) == 0 else {
    throw ArchiveKeyLifecycleFailure.fileStatFailed(errno: errno)
  }
  return value.st_mode & mode_t(0o777)
}

extension Data {
  fileprivate var keyHexForTest: String { map { String(format: "%02x", $0) }.joined() }
}
