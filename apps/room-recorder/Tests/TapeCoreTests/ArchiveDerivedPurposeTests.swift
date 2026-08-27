import Foundation
import Testing

@testable import TapeCore

@Suite(.serialized) struct ArchiveDerivedPurposeTests {
  private let rootKey = Data(UInt8(0)...UInt8(31))

  @Test func controlManifestAndOpaqueSpoolUseAuthenticatedAppendAndReopen() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "archive-derived-purpose-\(UUID().uuidString)",
      isDirectory: true
    )
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }

    let controlContext = ArchiveContext(
      streamUUID: Data(repeating: 1, count: 16),
      roomID: "room_test",
      istDate: "2026-08-27",
      laneID: "_control",
      stableDeviceUID: ""
    )
    let laneContext = ArchiveContext(
      streamUUID: Data(repeating: 2, count: 16),
      roomID: "room_test",
      istDate: "2026-08-27",
      laneID: "primary",
      stableDeviceUID: "test_device"
    )
    let controlPayload = try ArchiveControlPayload(
      commandID: "cmd_1",
      commandKind: .rollover,
      sessionID: "bs_1",
      priorState: nil,
      newState: .rolloverIntent,
      atMonoNS: 1,
      atWallNS: 2,
      error: nil
    )
    let manifestPayload = try ArchiveManifestPayload(
      reservationID: String(repeating: "a", count: 64),
      attemptID: "attempt_1",
      sampleStart: 0,
      sampleEnd: 16_000,
      startMS: 1_000,
      endMS: 2_000,
      uncertainty: nil,
      fitSegment: 0,
      averageLevelQ15: 1,
      peakLevelQ15: 2,
      mime: .audioWebM,
      encodedBytes: 4,
      encodedSHA256: String(repeating: "b", count: 64),
      encoderProvenanceID: "ffmpeg_1"
    )
    let cases:
      [(
        ArchiveRecordPurpose, ArchiveContext, Data, ArchiveDerivedStore.PayloadValidator
      )] = [
        (
          .control,
          controlContext,
          try ArchiveControlPayloadCodec.encode(controlPayload),
          { try ArchiveControlPayloadCodec.validateRecord($0) }
        ),
        (
          .manifest,
          laneContext,
          try ArchiveManifestPayloadCodec.encode(manifestPayload),
          { try ArchiveManifestPayloadCodec.validateRecord($0) }
        ),
        (.spool, laneContext, Data([0x00, 0xFF, 0x7B, 0x7D]), { _ in }),
      ]

    for (purpose, context, plaintext, validator) in cases {
      let url = directory.appendingPathComponent("\(purpose.kind).derived")
      let store = try ArchiveDerivedStore.openRecoveringForAppend(
        url: url,
        purpose: purpose,
        rootKey: rootKey,
        context: context,
        validator: validator
      )
      try store.append(
        plaintext: plaintext,
        firstLogicalUnit: 0,
        logicalUnitCount: purpose == .spool ? UInt32(plaintext.count) : 1
      )
      store.close()

      let reopened = try ArchiveDerivedStore.inspect(
        url: url,
        purpose: purpose,
        rootKey: rootKey,
        context: context,
        validator: validator
      )
      #expect(reopened.records.map(\.plaintext) == [plaintext])
      #expect(reopened.incompleteTrailingByteCount == 0)
    }
  }

  @Test func spoolRemainsEnvelopeBoundedAndTapeIndexRemainUnsupported() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "archive-derived-boundary-\(UUID().uuidString)",
      isDirectory: true
    )
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let context = ArchiveContext(
      streamUUID: Data(repeating: 3, count: 16),
      roomID: "room_test",
      istDate: "2026-08-27",
      laneID: "primary",
      stableDeviceUID: "test_device"
    )
    let spoolURL = directory.appendingPathComponent("primary.spool")
    let spool = try ArchiveDerivedStore.openRecoveringForAppend(
      url: spoolURL,
      purpose: .spool,
      rootKey: rootKey,
      context: context
    )
    let original = try Data(contentsOf: spoolURL)
    #expect(
      throws: ArchiveDerivedPersistenceError.invalidSpoolLogicalRange(expected: 4, actual: 1)
    ) {
      try spool.append(
        plaintext: Data([0x00, 0xFF, 0x7B, 0x7D]),
        firstLogicalUnit: 0,
        logicalUnitCount: 1
      )
    }
    #expect(try Data(contentsOf: spoolURL) == original)
    try spool.append(
      plaintext: Data([0x00, 0xFF, 0x7B, 0x7D]),
      firstLogicalUnit: 0,
      logicalUnitCount: 4
    )
    let oversized = Data(
      repeating: 0xA5,
      count: Int(ArchiveRecordPurpose.spool.maximumPlaintextByteCount) + 1
    )
    #expect(
      throws: ArchiveEnvelopeError.plaintextTooLarge(
        maximum: ArchiveRecordPurpose.spool.maximumPlaintextByteCount,
        actual: ArchiveRecordPurpose.spool.maximumPlaintextByteCount + 1
      )
    ) {
      try spool.append(
        plaintext: oversized,
        firstLogicalUnit: 4,
        logicalUnitCount: UInt32(oversized.count)
      )
    }
    spool.close()
    let reopened = try ArchiveDerivedStore.inspect(
      url: spoolURL,
      purpose: .spool,
      rootKey: rootKey,
      context: context
    )
    #expect(reopened.records.map(\.plaintext) == [Data([0x00, 0xFF, 0x7B, 0x7D])])

    for purpose in [ArchiveRecordPurpose.tape, .index] {
      let url = directory.appendingPathComponent("\(purpose.kind).unsupported")
      #expect(throws: ArchiveDerivedPersistenceError.unsupportedPurpose(purpose)) {
        try ArchiveDerivedStore.openRecoveringForAppend(
          url: url,
          purpose: purpose,
          rootKey: rootKey,
          context: context
        )
      }
      #expect(!FileManager.default.fileExists(atPath: url.path))
    }
  }

  @Test func controlContextIsRejectedBeforeAnyPathIsOpened() throws {
    let directory = try temporaryDirectory("control-context")
    defer { try? FileManager.default.removeItem(at: directory) }
    let invalidContexts = [
      ArchiveContext(
        streamUUID: Data(repeating: 4, count: 16),
        roomID: "room_test",
        istDate: "2026-08-27",
        laneID: "primary",
        stableDeviceUID: "device"
      ),
      ArchiveContext(
        streamUUID: Data(repeating: 5, count: 16),
        roomID: "room_test",
        istDate: "2026-08-27",
        laneID: "_control",
        stableDeviceUID: "device"
      ),
    ]
    for (index, context) in invalidContexts.enumerated() {
      let url = directory.appendingPathComponent("invalid-\(index).control")
      #expect(throws: ArchiveDerivedPersistenceError.invalidControlContext) {
        try ArchiveDerivedStore.openRecoveringForAppend(
          url: url,
          purpose: .control,
          rootKey: rootKey,
          context: context
        )
      }
      #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    let reservedContext = controlContext(streamByte: 5)
    for purpose in [
      ArchiveRecordPurpose.journal, .level, .manifest, .spool,
    ] {
      let url = directory.appendingPathComponent("reserved-\(purpose.kind).derived")
      #expect(throws: ArchiveDerivedPersistenceError.reservedControlContext(purpose)) {
        try ArchiveDerivedStore.openRecoveringForAppend(
          url: url,
          purpose: purpose,
          rootKey: rootKey,
          context: reservedContext
        )
      }
      #expect(!FileManager.default.fileExists(atPath: url.path))
    }
  }

  @Test func persistedJournalReservationsAreBoundToTheirEncryptedContextAndIdentity() throws {
    let directory = try temporaryDirectory("journal-binding")
    defer { try? FileManager.default.removeItem(at: directory) }
    let laneContext = context(streamByte: 15)
    let url = directory.appendingPathComponent("bound.journal")
    let store = try ArchiveDerivedStore.openRecoveringForAppend(
      url: url,
      purpose: .journal,
      rootKey: rootKey,
      context: laneContext
    )
    let original = try Data(contentsOf: url)
    let invalidIdentity = try journalPayload(
      context: laneContext,
      reservationID: String(repeating: "a", count: 64)
    )
    #expect(
      throws: ArchiveDerivedPersistenceError.journalReservationIdentityMismatch(
        invalidIdentity.reservationID)
    ) {
      try store.append(
        plaintext: ArchiveJournalPayloadCodec.encode(invalidIdentity),
        firstLogicalUnit: 0,
        logicalUnitCount: 1
      )
    }
    let invalidContexts = try [
      journalPayload(context: laneContext, roomID: "room_other"),
      journalPayload(context: laneContext, laneID: "backup"),
      journalPayload(context: laneContext, istDate: "2026-08-26"),
    ]
    for invalidContext in invalidContexts {
      #expect(
        throws: ArchiveDerivedPersistenceError.journalContextMismatch(
          invalidContext.reservationID)
      ) {
        try store.append(
          plaintext: ArchiveJournalPayloadCodec.encode(invalidContext),
          firstLogicalUnit: 0,
          logicalUnitCount: 1
        )
      }
    }
    #expect(try Data(contentsOf: url) == original)
    let valid = try journalPayload(context: laneContext)
    try store.append(
      plaintext: ArchiveJournalPayloadCodec.encode(valid),
      firstLogicalUnit: 0,
      logicalUnitCount: 1
    )
    store.close()

    for (name, payload, expectedError) in [
      (
        "identity",
        invalidIdentity,
        ArchiveDerivedPersistenceError.journalReservationIdentityMismatch(
          invalidIdentity.reservationID)
      ),
      (
        "context",
        invalidContexts[0],
        ArchiveDerivedPersistenceError.journalContextMismatch(
          invalidContexts[0].reservationID)
      ),
    ] {
      let invalidURL = directory.appendingPathComponent("invalid-\(name).journal")
      try writeRawHistory(
        [ArchiveJournalPayloadCodec.encode(payload)],
        purpose: .journal,
        context: laneContext,
        url: invalidURL
      )
      #expect(throws: expectedError) {
        try ArchiveDerivedStore.inspect(
          url: invalidURL,
          purpose: .journal,
          rootKey: rootKey,
          context: laneContext
        )
      }
    }
  }

  @Test func invalidCompleteHistoriesAreRejectedOnReopen() throws {
    let directory = try temporaryDirectory("invalid-history")
    defer { try? FileManager.default.removeItem(at: directory) }
    let laneContext = context(streamByte: 6)
    let controlContext = controlContext(streamByte: 7)

    let journalInitial = try journalPayload(context: laneContext)
    let skippedJournal = try journalPayload(
      context: laneContext,
      attemptID: "attempt_1",
      prior: .encoded,
      new: .spoolDurable
    )
    let journalURL = directory.appendingPathComponent("invalid.journal")
    try writeRawHistory(
      [
        ArchiveJournalPayloadCodec.encode(journalInitial),
        ArchiveJournalPayloadCodec.encode(skippedJournal),
      ],
      purpose: .journal,
      context: laneContext,
      url: journalURL
    )
    #expect(throws: ArchiveJournalReplayError.self) {
      try ArchiveDerivedStore.inspect(
        url: journalURL,
        purpose: .journal,
        rootKey: rootKey,
        context: laneContext
      )
    }

    let controlIntent = try controlPayload(
      sessionID: nil,
      prior: nil,
      new: .startIntent,
      mono: 1,
      wall: 1
    )
    let skippedControl = try controlPayload(
      sessionID: "bs_1",
      prior: .sessionOpened,
      new: .captureDurable,
      mono: 2,
      wall: 2
    )
    let controlURL = directory.appendingPathComponent("invalid.control")
    try writeRawHistory(
      [
        ArchiveControlPayloadCodec.encode(controlIntent),
        ArchiveControlPayloadCodec.encode(skippedControl),
      ],
      purpose: .control,
      context: controlContext,
      url: controlURL
    )
    #expect(throws: ArchiveControlPayloadError.self) {
      try ArchiveDerivedStore.inspect(
        url: controlURL,
        purpose: .control,
        rootKey: rootKey,
        context: controlContext
      )
    }

    let manifest = try manifestPayload()
    let duplicate = try manifestPayload(attemptID: "attempt_2")
    let manifestURL = directory.appendingPathComponent("invalid.manifest")
    try writeRawHistory(
      [
        ArchiveManifestPayloadCodec.encode(manifest),
        ArchiveManifestPayloadCodec.encode(duplicate),
      ],
      purpose: .manifest,
      context: laneContext,
      url: manifestURL
    )
    #expect(throws: ArchiveManifestPayloadError.duplicateReservationID(manifest.reservationID)) {
      try ArchiveDerivedStore.inspect(
        url: manifestURL,
        purpose: .manifest,
        rootKey: rootKey,
        context: laneContext
      )
    }

    let duplicateAttemptURL = directory.appendingPathComponent("duplicate-attempt.manifest")
    let sameAttempt = try manifestPayload(
      reservationID: String(repeating: "c", count: 64),
      attemptID: manifest.attemptID
    )
    try writeRawHistory(
      [
        ArchiveManifestPayloadCodec.encode(manifest),
        ArchiveManifestPayloadCodec.encode(sameAttempt),
      ],
      purpose: .manifest,
      context: laneContext,
      url: duplicateAttemptURL
    )
    #expect(throws: ArchiveManifestPayloadError.duplicateAttemptID(manifest.attemptID)) {
      try ArchiveDerivedStore.inspect(
        url: duplicateAttemptURL,
        purpose: .manifest,
        rootKey: rootKey,
        context: laneContext
      )
    }

    let spoolURL = directory.appendingPathComponent("invalid.spool")
    try writeRawHistory(
      [Data([1, 2, 3, 4])],
      purpose: .spool,
      context: laneContext,
      url: spoolURL,
      logicalCounts: [1]
    )
    #expect(
      throws: ArchiveDerivedPersistenceError.invalidSpoolLogicalRange(expected: 4, actual: 1)
    ) {
      try ArchiveDerivedStore.inspect(
        url: spoolURL,
        purpose: .spool,
        rootKey: rootKey,
        context: laneContext
      )
    }
  }

  @Test func invalidCandidatesAreRejectedBeforeMutationAndDoNotPoisonStore() throws {
    let directory = try temporaryDirectory("candidate-history")
    defer { try? FileManager.default.removeItem(at: directory) }
    let laneContext = context(streamByte: 8)
    let controlContext = controlContext(streamByte: 9)

    let journalURL = directory.appendingPathComponent("candidate.journal")
    let journal = try ArchiveDerivedStore.openRecoveringForAppend(
      url: journalURL,
      purpose: .journal,
      rootKey: rootKey,
      context: laneContext
    )
    try journal.append(
      plaintext: ArchiveJournalPayloadCodec.encode(journalPayload(context: laneContext)),
      firstLogicalUnit: 0,
      logicalUnitCount: 1
    )
    let journalBytes = try Data(contentsOf: journalURL)
    #expect(throws: ArchiveJournalReplayError.self) {
      try journal.append(
        plaintext: ArchiveJournalPayloadCodec.encode(
          journalPayload(
            context: laneContext,
            attemptID: "attempt_1",
            prior: .encoded,
            new: .spoolDurable
          )
        ),
        firstLogicalUnit: 1,
        logicalUnitCount: 1
      )
    }
    #expect(try Data(contentsOf: journalURL) == journalBytes)
    try journal.append(
      plaintext: ArchiveJournalPayloadCodec.encode(
        journalPayload(
          context: laneContext,
          attemptID: "attempt_1",
          prior: .reserved,
          new: .encoded
        )
      ),
      firstLogicalUnit: 1,
      logicalUnitCount: 1
    )
    journal.close()

    let controlURL = directory.appendingPathComponent("candidate.control")
    let control = try ArchiveDerivedStore.openRecoveringForAppend(
      url: controlURL,
      purpose: .control,
      rootKey: rootKey,
      context: controlContext
    )
    try control.append(
      plaintext: ArchiveControlPayloadCodec.encode(
        controlPayload(sessionID: nil, prior: nil, new: .startIntent, mono: 1, wall: 1)
      ),
      firstLogicalUnit: 0,
      logicalUnitCount: 1
    )
    let controlBytes = try Data(contentsOf: controlURL)
    #expect(throws: ArchiveControlPayloadError.self) {
      try control.append(
        plaintext: ArchiveControlPayloadCodec.encode(
          controlPayload(
            sessionID: "bs_1",
            prior: .sessionOpened,
            new: .captureDurable,
            mono: 2,
            wall: 2
          )
        ),
        firstLogicalUnit: 1,
        logicalUnitCount: 1
      )
    }
    #expect(try Data(contentsOf: controlURL) == controlBytes)
    try control.append(
      plaintext: ArchiveControlPayloadCodec.encode(
        controlPayload(
          sessionID: "bs_1",
          prior: .startIntent,
          new: .sessionOpened,
          mono: 2,
          wall: 2
        )
      ),
      firstLogicalUnit: 1,
      logicalUnitCount: 1
    )
    control.close()

    let manifestURL = directory.appendingPathComponent("candidate.manifest")
    let manifest = try ArchiveDerivedStore.openRecoveringForAppend(
      url: manifestURL,
      purpose: .manifest,
      rootKey: rootKey,
      context: laneContext
    )
    let firstManifest = try manifestPayload()
    try manifest.append(
      plaintext: ArchiveManifestPayloadCodec.encode(firstManifest),
      firstLogicalUnit: 0,
      logicalUnitCount: 1
    )
    let manifestBytes = try Data(contentsOf: manifestURL)
    #expect(throws: ArchiveManifestPayloadError.self) {
      try manifest.append(
        plaintext: ArchiveManifestPayloadCodec.encode(
          manifestPayload(attemptID: "attempt_2")
        ),
        firstLogicalUnit: 1,
        logicalUnitCount: 1
      )
    }
    #expect(try Data(contentsOf: manifestURL) == manifestBytes)
    #expect(throws: ArchiveManifestPayloadError.duplicateAttemptID(firstManifest.attemptID)) {
      try manifest.append(
        plaintext: ArchiveManifestPayloadCodec.encode(
          manifestPayload(
            reservationID: String(repeating: "c", count: 64),
            attemptID: firstManifest.attemptID
          )
        ),
        firstLogicalUnit: 1,
        logicalUnitCount: 1
      )
    }
    #expect(try Data(contentsOf: manifestURL) == manifestBytes)
    try manifest.append(
      plaintext: ArchiveManifestPayloadCodec.encode(
        manifestPayload(
          reservationID: String(repeating: "c", count: 64),
          attemptID: "attempt_2"
        )
      ),
      firstLogicalUnit: 1,
      logicalUnitCount: 1
    )
    manifest.close()
  }

  private func context(streamByte: UInt8) -> ArchiveContext {
    ArchiveContext(
      streamUUID: Data(repeating: streamByte, count: 16),
      roomID: "room_test",
      istDate: "2026-08-27",
      laneID: "primary",
      stableDeviceUID: "test_device"
    )
  }

  private func controlContext(streamByte: UInt8) -> ArchiveContext {
    ArchiveContext(
      streamUUID: Data(repeating: streamByte, count: 16),
      roomID: "room_test",
      istDate: "2026-08-27",
      laneID: "_control",
      stableDeviceUID: ""
    )
  }

  private func journalPayload(
    context: ArchiveContext,
    reservationID: String? = nil,
    roomID: String? = nil,
    laneID: String? = nil,
    istDate: String? = nil,
    attemptID: String? = nil,
    prior: ArchiveJournalState? = nil,
    new: ArchiveJournalState = .reserved
  ) throws -> ArchiveJournalPayload {
    let sessionID = "bs_1"
    let chunkIndex: UInt32 = 0
    let sampleStart: UInt64 = 0
    let sampleEnd: UInt64 = 16_000
    let resolvedReservationID =
      try reservationID
      ?? ArchiveReservationIdentity.make(
        context: context,
        sessionID: sessionID,
        chunkIndex: chunkIndex,
        sampleStart: sampleStart,
        sampleEnd: sampleEnd
      )
    return try ArchiveJournalPayload(
      reservationID: resolvedReservationID,
      roomID: roomID ?? context.roomID,
      sessionID: sessionID,
      laneID: laneID ?? context.laneID,
      istDate: istDate ?? context.istDate,
      chunkIndex: chunkIndex,
      sampleStart: sampleStart,
      sampleEnd: sampleEnd,
      startMS: 1_000,
      endMS: 2_000,
      uncertainty: nil,
      averageLevelQ15: 1,
      peakLevelQ15: 2,
      attemptID: attemptID,
      priorState: prior,
      newState: new,
      error: nil
    )
  }

  private func controlPayload(
    sessionID: String?,
    prior: ArchiveControlState?,
    new: ArchiveControlState,
    mono: UInt64,
    wall: UInt64
  ) throws -> ArchiveControlPayload {
    try ArchiveControlPayload(
      commandID: "cmd_1",
      commandKind: .startDay,
      sessionID: sessionID,
      priorState: prior,
      newState: new,
      atMonoNS: mono,
      atWallNS: wall,
      error: nil
    )
  }

  private func manifestPayload(
    reservationID: String = String(repeating: "b", count: 64),
    attemptID: String = "attempt_1"
  ) throws -> ArchiveManifestPayload {
    try ArchiveManifestPayload(
      reservationID: reservationID,
      attemptID: attemptID,
      sampleStart: 0,
      sampleEnd: 16_000,
      startMS: 1_000,
      endMS: 2_000,
      uncertainty: nil,
      fitSegment: 0,
      averageLevelQ15: 1,
      peakLevelQ15: 2,
      mime: .audioWebM,
      encodedBytes: 4,
      encodedSHA256: String(repeating: "d", count: 64),
      encoderProvenanceID: "ffmpeg_1"
    )
  }

  private func writeRawHistory(
    _ plaintexts: [Data],
    purpose: ArchiveRecordPurpose,
    context: ArchiveContext,
    url: URL,
    logicalCounts: [UInt32]? = nil
  ) throws {
    let sealer = try ArchivePurposeSealer(
      purpose: purpose,
      rootKey: rootKey,
      streamUUID: context.streamUUID
    )
    let contextHash = try context.sha256()
    var predecessor = Data(repeating: 0, count: 16)
    var firstLogicalUnit: UInt64 = 0
    var encoded = Data()
    for (position, plaintext) in plaintexts.enumerated() {
      let count = logicalCounts?[position] ?? 1
      let envelope = try sealer.seal(
        plaintext,
        request: ArchiveRecordSealRequest(
          recordSequence: UInt64(position + 1),
          firstLogicalUnit: firstLogicalUnit,
          logicalUnitCount: count,
          previousCommittedTag: predecessor,
          contextHash: contextHash
        )
      )
      encoded.append(try ArchiveEnvelopeCodec.encodeUnauthenticated(envelope))
      predecessor = envelope.authenticationTag
      firstLogicalUnit += UInt64(count)
    }
    try encoded.write(to: url)
  }

  private func temporaryDirectory(_ label: String) throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(
      "archive-derived-\(label)-\(UUID().uuidString)",
      isDirectory: true
    )
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
    return url
  }
}
