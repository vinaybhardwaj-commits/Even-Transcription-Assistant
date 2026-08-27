import CryptoKit
import Darwin
import Foundation
import Security
import Synchronization
import Testing

@testable import TapeCore

@Suite(.serialized) struct ArchiveKeyLifecycleP1Tests {
  private let root = keyHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
  private let stream = keyHex("00112233445566778899aabbccddeeff")

  private var context: ArchiveContext {
    ArchiveContext(
      streamUUID: stream,
      roomID: "room_1",
      istDate: "2026-08-27",
      laneID: "primary",
      stableDeviceUID: "AppleUSBAudioEngine:test")
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
    onRootRelease: @escaping (Data) throws -> Void = { _ in }
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
      })
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

private struct KeyFixture {
  let directory: URL
  let keywrapURL: URL
  let tapeURL: URL
  let indexURL: URL

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
  }

  func remove() { try? FileManager.default.removeItem(at: directory) }
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
