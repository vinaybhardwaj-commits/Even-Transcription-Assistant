import Foundation
import Testing

@testable import TapeCapture
@testable import TapeCore

@Suite(.serialized) struct ArchiveLocalDerivationTests {
  private let rootKey = Data(UInt8(0)...UInt8(31))
  private let streamUUID = Data([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
  private let wallBase: UInt64 = 1_787_833_800_000_000_000

  private var context: ArchiveContext {
    ArchiveContext(
      streamUUID: streamUUID,
      roomID: "room_development",
      istDate: "2026-08-27",
      laneID: "primary",
      stableDeviceUID: "AppleUSBAudioEngine:test"
    )
  }

  @Test func journalCodecFreezesCanonicalReservationBytes() throws {
    let payload = try ArchiveJournalPayload(
      reservationID: String(repeating: "a", count: 64),
      roomID: "room_dev",
      sessionID: "bs_dev",
      laneID: "primary",
      istDate: "2026-08-27",
      chunkIndex: 7,
      sampleStart: 0,
      sampleEnd: 4_800_000,
      startMS: 1_000,
      endMS: 301_000,
      uncertainty: nil,
      averageLevelQ15: 100,
      peakLevelQ15: 200,
      attemptID: nil,
      priorState: nil,
      newState: .reserved,
      error: nil
    )
    let expected = Data(
      (#"{"attempt_id":null,"avg_level_q15":100,"chunk_idx":7,"end_ms":301000,"error":null,"ist_date":"2026-08-27","lane_id":"primary","new_state":"reserved","peak_level_q15":200,"prior_state":null,"reservation_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","room_id":"room_dev","sample_end":4800000,"sample_start":0,"session_id":"bs_dev","start_ms":1000,"uncertainty":null}"#)
        .utf8
    )

    let encoded = try ArchiveJournalPayloadCodec.encode(payload)
    #expect(encoded == expected)
    #expect(try ArchiveJournalPayloadCodec.decode(encoded) == payload)
    #expect(throws: ArchiveJournalPayloadError.self) {
      try ArchiveJournalPayloadCodec.decode(encoded + Data([0x20]))
    }
    #expect(throws: ArchiveJournalPayloadError.missingReservedLevels) {
      try ArchiveJournalPayload(
        reservationID: String(repeating: "a", count: 64),
        roomID: "room_dev",
        sessionID: "bs_dev",
        laneID: "primary",
        istDate: "2026-08-27",
        chunkIndex: 7,
        sampleStart: 0,
        sampleEnd: 4_800_000,
        startMS: nil,
        endMS: nil,
        uncertainty: .fewerThanThreeAnchors,
        averageLevelQ15: nil,
        peakLevelQ15: nil,
        attemptID: nil,
        priorState: nil,
        newState: .reserved,
        error: nil
      )
    }
  }

  @Test func authenticatedRangeReaderTrimsOneAndMultipleRecordsAndRefusesPastEnd() throws {
    let fixture = try makeLaneFixture("range")
    defer { fixture.remove() }
    let values = Array(Int16(0)..<Int16(24))
    let store = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: fixture.tape,
      indexURL: fixture.index,
      rootKey: rootKey,
      context: context
    )
    _ = try store.appendPCM(pcm(Array(values[0..<8])), observation: observation(sampleEnd: 8))
    _ = try store.appendPCM(pcm(Array(values[8..<16])), observation: observation(sampleEnd: 16))
    _ = try store.appendPCM(pcm(Array(values[16..<24])), observation: observation(sampleEnd: 24))
    store.close()

    let within = try readRange(fixture, start: 2, end: 6)
    #expect(decodePCM(within.pcm) == Array(values[2..<6]))
    #expect(within.indexRecords.count == 1)
    let crossing = try readRange(fixture, start: 6, end: 19)
    #expect(decodePCM(crossing.pcm) == Array(values[6..<19]))
    #expect(crossing.indexRecords.count == 3)
    #expect(
      throws: ArchiveLanePersistenceError.readRangeBeyondAuthenticatedEnd(
        requested: 25, authenticated: 24)
    ) {
      try readRange(fixture, start: 23, end: 25)
    }
    #expect(throws: ArchiveLanePersistenceError.invalidReadRange(start: 4, end: 4)) {
      try readRange(fixture, start: 4, end: 4)
    }
  }

  @Test func authenticatedSnapshotHoldsBothSourceLocksUntilDerivationCloses() throws {
    let fixture = try makeLaneFixture("snapshot-lock")
    defer { fixture.remove() }
    let store = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: fixture.tape,
      indexURL: fixture.index,
      rootKey: rootKey,
      context: context
    )
    _ = try store.appendPCM(pcm([1, 2, 3, 4]), observation: observation(sampleEnd: 4))
    store.close()

    let snapshot = try ArchiveLaneStore.openAuthenticatedSnapshot(
      tapeURL: fixture.tape,
      indexURL: fixture.index,
      rootKey: rootKey,
      context: context
    )
    #expect(throws: ArchiveLanePersistenceError.self) {
      try ArchiveLaneStore.openRecoveringForAppend(
        tapeURL: fixture.tape,
        indexURL: fixture.index,
        rootKey: rootKey,
        context: context
      )
    }
    #expect(decodePCM(try snapshot.readPCMRange(sampleStart: 1, sampleEnd: 3).pcm) == [2, 3])
    snapshot.close()
    let reopened = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: fixture.tape,
      indexURL: fixture.index,
      rootKey: rootKey,
      context: context
    )
    reopened.close()
  }

  @Test func cutterUsesExactFiveMinuteSeamsAndNamedDiscontinuityCuts() throws {
    let records = [
      metadata(sequence: 1, start: 0, end: 1_600_000, monoNS: 100_000_000_000),
      metadata(sequence: 2, start: 1_600_000, end: 3_200_000, monoNS: 200_000_000_000),
      metadata(sequence: 3, start: 3_200_000, end: 4_800_000, monoNS: 300_000_000_000),
      metadata(sequence: 4, start: 4_800_000, end: 5_600_000, monoNS: 350_000_000_000),
      metadata(
        sequence: 5,
        start: 5_600_000,
        end: 5_700_000,
        monoNS: 352_000_000_000,
        discontinuity: .deviceLost
      ),
      metadata(sequence: 6, start: 5_700_000, end: 7_300_000, monoNS: 452_000_000_000),
      metadata(sequence: 7, start: 7_300_000, end: 8_900_000, monoNS: 552_000_000_000),
      metadata(sequence: 8, start: 8_900_000, end: 10_500_000, monoNS: 652_000_000_000),
    ]

    let plans = try ArchiveLocalCutter.plan(indexRecords: records, finalFlush: true)
    #expect(plans.map(\.sampleStart) == [0, 4_800_000, 5_600_000, 10_400_000])
    #expect(plans.map(\.sampleEnd) == [4_800_000, 5_600_000, 10_400_000, 10_500_000])
    #expect(plans[0].sampleEnd == plans[1].sampleStart)
    #expect(plans[1].sampleEnd == plans[2].sampleStart)
    #expect(plans.allSatisfy { !($0.sampleStart < 5_600_000 && $0.sampleEnd > 5_600_000) })
    #expect(plans.map(\.chunkIndex) == [0, 1, 2, 3])
  }

  @Test func cutterClosesAtEveryRatifiedArchiveDiscontinuity() throws {
    for discontinuity in ArchiveIndexDiscontinuity.allCases {
      let records = [
        metadata(sequence: 1, start: 0, end: 100, monoNS: 1_000_000_000),
        metadata(
          sequence: 2,
          start: 100,
          end: 200,
          discontinuity: discontinuity
        ),
        metadata(sequence: 3, start: 200, end: 300, monoNS: 2_000_000_000),
      ]
      let plans = try ArchiveLocalCutter.plan(indexRecords: records, finalFlush: true)
      #expect(plans.map(\.sampleStart) == [0, 100])
      #expect(plans.map(\.sampleEnd) == [100, 300])
      #expect(plans.allSatisfy { !($0.sampleStart < 100 && $0.sampleEnd > 100) })
    }
  }

  @Test func cutterNamesEachClockFitUncertaintyPrecedence() throws {
    let fewer = try ArchiveLocalCutter.plan(
      indexRecords: [metadata(sequence: 1, start: 0, end: 100, monoNS: 1_000_000_000)],
      finalFlush: true
    )
    #expect(fewer[0].uncertainty == .fewerThanThreeAnchors)

    let shortSpan = try ArchiveLocalCutter.plan(
      indexRecords: [
        metadata(sequence: 1, start: 0, end: 100, monoNS: 1_000_000_000),
        metadata(sequence: 2, start: 100, end: 200, monoNS: 2_000_000_000),
        metadata(sequence: 3, start: 200, end: 300, monoNS: 3_000_000_000),
      ],
      finalFlush: true
    )
    #expect(shortSpan[0].uncertainty == .anchorsSpanLessThanTenSeconds)

    let stale = try ArchiveLocalCutter.plan(
      indexRecords: [
        metadata(sequence: 1, start: 0, end: 4_300_000, monoNS: 268_750_000_000),
        metadata(sequence: 2, start: 4_300_000, end: 4_500_000, monoNS: 281_250_000_000),
        metadata(sequence: 3, start: 4_500_000, end: 4_700_000, monoNS: 293_750_000_000),
        metadata(sequence: 4, start: 4_700_000, end: 4_800_000),
      ]
    )
    #expect(stale[0].uncertainty == .boundaryBeyondNewestAnchor)

    let backwards = try ArchiveLocalCutter.plan(
      indexRecords: [
        metadata(sequence: 1, start: 0, end: 1_600_000, monoNS: 300_000_000_000),
        metadata(sequence: 2, start: 1_600_000, end: 3_200_000, monoNS: 200_000_000_000),
        metadata(sequence: 3, start: 3_200_000, end: 4_800_000, monoNS: 100_000_000_000),
      ]
    )
    #expect(backwards[0].uncertainty == .fittedRateNonFinite)

    let wrongRate = try ArchiveLocalCutter.plan(
      indexRecords: [
        metadata(sequence: 1, start: 0, end: 1_600_000, monoNS: 80_000_000_000),
        metadata(sequence: 2, start: 1_600_000, end: 3_200_000, monoNS: 160_000_000_000),
        metadata(sequence: 3, start: 3_200_000, end: 4_800_000, monoNS: 240_000_000_000),
      ]
    )
    #expect(wrongRate[0].uncertainty == .fittedRateOutOfBounds)

    let recovered = try ArchiveLocalCutter.plan(
      indexRecords: [
        metadata(
          sequence: 1,
          start: 0,
          end: 100_000,
          discontinuity: .crashRecoveredUnindexed
        ),
        metadata(sequence: 2, start: 100_000, end: 1_600_000, monoNS: 100_000_000_000),
        metadata(sequence: 3, start: 1_600_000, end: 3_200_000, monoNS: 200_000_000_000),
        metadata(sequence: 4, start: 3_200_000, end: 4_800_000, monoNS: 300_000_000_000),
      ]
    )
    #expect(recovered[0].uncertainty == .discontinuityIntersectsFit)
  }

  @Test func cutterProjectsTheLeastSquaresInterceptInsteadOfTheFirstAnchor() throws {
    let plans = try ArchiveLocalCutter.plan(
      indexRecords: [
        metadata(sequence: 1, start: 0, end: 1_600_000, monoNS: 100_000_000_000),
        metadata(sequence: 2, start: 1_600_000, end: 3_200_000, monoNS: 201_000_000_000),
        metadata(sequence: 3, start: 3_200_000, end: 4_800_000, monoNS: 300_000_000_000),
      ]
    )
    #expect(plans[0].uncertainty == nil)
    #expect(plans[0].startMS == wallBase / 1_000_000 + 333)
    #expect(plans[0].endMS == wallBase / 1_000_000 + 300_333)
  }

  @Test func levelCodecQuantizesAndVADRequiresFiveBootstrapFrames() throws {
    let encoded = ArchiveLevelPayloadCodec.encode([
      try ArchiveLevelObservation(rmsQ16: 0, peakQ15: 0, voiceActive: false),
      try ArchiveLevelObservation(rmsQ16: 65_535, peakQ15: 32_767, voiceActive: true),
    ])
    #expect(encoded == Data([0, 0, 0, 0, 255, 255, 255, 255]))
    #expect(try ArchiveLevelPayloadCodec.decode(encoded).count == 2)
    #expect(throws: ArchiveLevelSidecarError.invalidPeakQ15(32_768)) {
      try ArchiveLevelObservation(rmsQ16: 0, peakQ15: 32_768, voiceActive: false)
    }

    let four = vadPCM(activeFrames: 4)
    let five = vadPCM(activeFrames: 5)
    let index = [metadata(sequence: 1, start: 0, end: 16_000)]
    let fourResult = try ArchiveLevelSidecarBuilder.build(indexRecords: index) { _, _ in four }
    let fiveResult = try ArchiveLevelSidecarBuilder.build(indexRecords: index) { _, _ in five }
    #expect(fourResult[0].observations[0].voiceActive == false)
    #expect(fiveResult[0].observations[0].voiceActive == true)
    #expect(try ArchiveLevelSidecarBuilder.quantizedLevels(pcm([-32_768])) == (32_767, 32_767))
  }

  @Test func sidecarClosesAtDiscontinuityCapsSixtyAndRebuildsIdentically() throws {
    let boundary: UInt64 = 30 * 16_000 + 8_000
    let end: UInt64 = 61 * 16_000
    let records = [
      metadata(sequence: 1, start: 0, end: boundary),
      metadata(
        sequence: 2,
        start: boundary,
        end: end,
        discontinuity: .captureDiscontinuity
      ),
    ]
    let reader: (UInt64, UInt64) throws -> Data = { start, end in
      Data(repeating: 0, count: Int((end - start) * 2))
    }
    let first = try ArchiveLevelSidecarBuilder.build(indexRecords: records, readPCM: reader)
    let second = try ArchiveLevelSidecarBuilder.build(indexRecords: records, readPCM: reader)
    #expect(first == second)
    #expect(first.count == 2)
    #expect(first[0].firstSample == 0)
    #expect(first[0].sampleCount == UInt32(boundary))
    #expect(first[0].observations.count == 31)
    #expect(first[1].firstSample == boundary)
    #expect(first.reduce(UInt64(0)) { $0 + UInt64($1.sampleCount) } == end)

    let uninterrupted = try ArchiveLevelSidecarBuilder.build(
      indexRecords: [metadata(sequence: 1, start: 0, end: end)],
      readPCM: reader
    )
    #expect(uninterrupted.map(\.observations.count) == [60, 1])
  }

  @Test func adaptiveVADUsesThePrecedingSixtySecondsAcrossAWallGap() throws {
    let boundary: UInt64 = 60 * 16_000
    let end = boundary + 16_000
    let records = [
      metadata(sequence: 1, start: 0, end: boundary),
      metadata(
        sequence: 2,
        start: boundary,
        end: end,
        discontinuity: .captureDiscontinuity
      ),
    ]
    let plans = try ArchiveLevelSidecarBuilder.build(indexRecords: records) { start, end in
      self.pcm(Array(repeating: Int16(1_036), count: Int(end - start)))
    }
    #expect(plans[0].observations.first?.voiceActive == true)
    #expect(plans[1].observations.count == 1)
    #expect(plans[1].observations[0].voiceActive == false)
  }

  @Test func adaptiveVADUsesTheExactNearestRankTwentiethPercentile() throws {
    var samples = Array(repeating: Int16(0), count: 61 * 16_000)
    for frame in 0..<2_400 {
      for sample in (frame * 320)..<((frame + 1) * 320) { samples[sample] = 1_036 }
    }
    for frame in 2_400..<3_000 {
      for sample in (frame * 320)..<((frame + 1) * 320) { samples[sample] = 33 }
    }
    for frame in 3_000..<3_005 {
      for sample in (frame * 320)..<((frame + 1) * 320) { samples[sample] = 1_036 }
    }
    let bytes = pcm(samples)
    let plans = try ArchiveLevelSidecarBuilder.build(
      indexRecords: [metadata(sequence: 1, start: 0, end: UInt64(samples.count))]
    ) { start, end in
      Data(bytes[Int(start * 2)..<Int(end * 2)])
    }
    #expect(plans.last?.observations.last?.voiceActive == true)
  }

  @Test func derivedStoreReopensRepairsOnlyTornTailAndRefusesTamper() throws {
    let directory = try temporaryDirectory("derived-store")
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("primary.jrn")
    let payload = try reservation(sampleStart: 0, sampleEnd: 100, chunkIndex: 0)
    let plaintext = try ArchiveJournalPayloadCodec.encode(payload)
    let store = try ArchiveDerivedStore.openRecoveringForAppend(
      url: url,
      purpose: .journal,
      rootKey: rootKey,
      context: context,
      validator: { try ArchiveJournalPayloadCodec.validateRecord($0) }
    )
    try store.append(plaintext: plaintext, firstLogicalUnit: 0, logicalUnitCount: 1)
    store.close()
    let complete = try Data(contentsOf: url)
    try append(Data("ETA".utf8), to: url)

    let readOnly = try ArchiveDerivedStore.inspect(
      url: url,
      purpose: .journal,
      rootKey: rootKey,
      context: context,
      validator: { try ArchiveJournalPayloadCodec.validateRecord($0) }
    )
    #expect(readOnly.incompleteTrailingByteCount == 3)
    let repaired = try ArchiveDerivedStore.openRecoveringForAppend(
      url: url,
      purpose: .journal,
      rootKey: rootKey,
      context: context,
      validator: { try ArchiveJournalPayloadCodec.validateRecord($0) }
    )
    #expect(repaired.repairedTrailingByteCount == 3)
    repaired.close()
    #expect(try Data(contentsOf: url) == complete)

    try append(Data([1, 2, 3]), to: url)
    let randomTail = try Data(contentsOf: url)
    #expect(throws: ArchiveDerivedPersistenceError.invalidPartialHeader(offset: 0)) {
      try ArchiveDerivedStore.openRecoveringForAppend(
        url: url,
        purpose: .journal,
        rootKey: rootKey,
        context: context,
        validator: { try ArchiveJournalPayloadCodec.validateRecord($0) }
      )
    }
    #expect(try Data(contentsOf: url) == randomTail)
    try complete.write(to: url)

    var tampered = complete
    tampered[tampered.count - 1] ^= 0x01
    try tampered.write(to: url)
    #expect(throws: ArchiveCryptoError.authenticationFailed) {
      try ArchiveDerivedStore.openRecoveringForAppend(
        url: url,
        purpose: .journal,
        rootKey: rootKey,
        context: context,
        validator: { try ArchiveJournalPayloadCodec.validateRecord($0) }
      )
    }
    #expect(try Data(contentsOf: url) == tampered)
  }

  @Test func emptyCreatedDerivedStoreIsDiscardedWhileItsIdentityLockIsHeld() throws {
    let directory = try temporaryDirectory("derived-discard")
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("primary.jrn")
    let store = try ArchiveDerivedStore.openRecoveringForAppend(
      url: url,
      purpose: .journal,
      rootKey: rootKey,
      context: context
    )
    #expect(FileManager.default.fileExists(atPath: url.path))
    try store.discardIfCreatedAndEmpty()
    #expect(!FileManager.default.fileExists(atPath: url.path))
    store.close()
  }

  @Test func emptyAuthenticatedSourceRefusesStaleDerivedRecords() throws {
    let fixture = try makeLaneFixture("empty-source")
    defer { fixture.remove() }
    let lane = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: fixture.tape,
      indexURL: fixture.index,
      rootKey: rootKey,
      context: context
    )
    lane.close()
    let journal = fixture.directory.appendingPathComponent("primary.jrn")
    let level = fixture.directory.appendingPathComponent("primary.lvl")
    let stale = try ArchiveDerivedStore.openRecoveringForAppend(
      url: journal,
      purpose: .journal,
      rootKey: rootKey,
      context: context,
      validator: { try ArchiveJournalPayloadCodec.validateRecord($0) }
    )
    let payload = try reservation(sampleStart: 0, sampleEnd: 100, chunkIndex: 0)
    _ = try stale.append(
      plaintext: ArchiveJournalPayloadCodec.encode(payload),
      firstLogicalUnit: 0,
      logicalUnitCount: 1
    )
    stale.close()
    let original = try Data(contentsOf: journal)

    #expect(throws: ArchiveLocalDerivationError.existingJournalMismatch(position: 0)) {
      try ArchiveLocalDeriver.derive(
        tapeURL: fixture.tape,
        indexURL: fixture.index,
        journalURL: journal,
        levelURL: level,
        rootKey: rootKey,
        context: context,
        sessionID: "bs_empty",
        finalFlush: true
      )
    }
    #expect(try Data(contentsOf: journal) == original)
    #expect(!FileManager.default.fileExists(atPath: level.path))
  }

  @Test func localDeriverPersistsReservationsThenSidecarAndRerunsIdempotently() throws {
    let fixture = try makeLaneFixture("derive")
    defer { fixture.remove() }
    let store = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: fixture.tape,
      indexURL: fixture.index,
      rootKey: rootKey,
      context: context
    )
    _ = try store.appendPCM(
      pcm(Array(repeating: Int16(1_000), count: 16_000)),
      observation: observation(sampleEnd: 16_000))
    _ = try store.appendPCM(
      pcm(Array(repeating: Int16(2_000), count: 16_000)),
      observation: observation(sampleEnd: 32_000))
    store.close()
    let originalTape = try Data(contentsOf: fixture.tape)
    let originalIndex = try Data(contentsOf: fixture.index)
    let journal = fixture.directory.appendingPathComponent("primary.jrn")
    let level = fixture.directory.appendingPathComponent("primary.lvl")

    let first = try ArchiveLocalDeriver.derive(
      tapeURL: fixture.tape,
      indexURL: fixture.index,
      journalURL: journal,
      levelURL: level,
      rootKey: rootKey,
      context: context,
      sessionID: "bs_unsigned_development",
      finalFlush: true
    )
    #expect(first.authenticatedSampleCount == 32_000)
    #expect(first.authenticatedSampleEnd == 32_000)
    #expect(first.reservations.count == 1)
    #expect(first.journalRecordsWritten == 1)
    #expect(first.levelRecordsWritten == 1)
    #expect(first.levelRecords[0].observations.count == 2)

    let second = try ArchiveLocalDeriver.derive(
      tapeURL: fixture.tape,
      indexURL: fixture.index,
      journalURL: journal,
      levelURL: level,
      rootKey: rootKey,
      context: context,
      sessionID: "bs_unsigned_development",
      finalFlush: true
    )
    #expect(second.reservations == first.reservations)
    #expect(second.levelRecords == first.levelRecords)
    #expect(second.journalRecordsWritten == 0)
    #expect(second.levelRecordsWritten == 0)
    #expect(try Data(contentsOf: fixture.tape) == originalTape)
    #expect(try Data(contentsOf: fixture.index) == originalIndex)

    let journalBytes = try Data(contentsOf: journal)
    let levelBytes = try Data(contentsOf: level)
    #expect(throws: ArchiveLocalDerivationError.existingJournalMismatch(position: 0)) {
      try ArchiveLocalDeriver.derive(
        tapeURL: fixture.tape,
        indexURL: fixture.index,
        journalURL: journal,
        levelURL: level,
        rootKey: rootKey,
        context: context,
        sessionID: "bs_competing_development",
        finalFlush: true
      )
    }
    #expect(try Data(contentsOf: journal) == journalBytes)
    #expect(try Data(contentsOf: level) == levelBytes)
    #expect(try Data(contentsOf: fixture.tape) == originalTape)
    #expect(try Data(contentsOf: fixture.index) == originalIndex)

    try append(Data("ETA".utf8), to: journal)
    let repaired = try ArchiveLocalDeriver.derive(
      tapeURL: fixture.tape,
      indexURL: fixture.index,
      journalURL: journal,
      levelURL: level,
      rootKey: rootKey,
      context: context,
      sessionID: "bs_unsigned_development",
      finalFlush: true
    )
    #expect(repaired.repairedJournalTrailingByteCount == 3)
    #expect(try Data(contentsOf: journal) == journalBytes)
  }

  @Test func localDeriverAcceptsAdvancedJournalAndAppendsOnlyNewReservations() throws {
    let fixture = try makeLaneFixture("derive-advanced")
    defer { fixture.remove() }
    var lane = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: fixture.tape,
      indexURL: fixture.index,
      rootKey: rootKey,
      context: context
    )
    _ = try lane.appendPCM(
      pcm(Array(repeating: Int16(1_000), count: 16_000)),
      observation: observation(sampleEnd: 16_000)
    )
    lane.close()
    let journalURL = fixture.directory.appendingPathComponent("primary.jrn")
    let levelURL = fixture.directory.appendingPathComponent("primary.lvl")
    let first = try ArchiveLocalDeriver.derive(
      tapeURL: fixture.tape,
      indexURL: fixture.index,
      journalURL: journalURL,
      levelURL: levelURL,
      rootKey: rootKey,
      context: context,
      sessionID: "bs_advanced",
      finalFlush: true
    )
    let reservation = first.reservations[0]
    let encoded = try ArchiveJournalPayload(
      reservationID: reservation.reservationID,
      roomID: reservation.roomID,
      sessionID: reservation.sessionID,
      laneID: reservation.laneID,
      istDate: reservation.istDate,
      chunkIndex: reservation.chunkIndex,
      sampleStart: reservation.sampleStart,
      sampleEnd: reservation.sampleEnd,
      startMS: reservation.startMS,
      endMS: reservation.endMS,
      uncertainty: reservation.uncertainty,
      averageLevelQ15: reservation.averageLevelQ15,
      peakLevelQ15: reservation.peakLevelQ15,
      attemptID: "attempt_1",
      priorState: .reserved,
      newState: .encoded,
      error: nil
    )
    let journal = try ArchiveDerivedStore.openRecoveringForAppend(
      url: journalURL,
      purpose: .journal,
      rootKey: rootKey,
      context: context
    )
    try journal.append(
      plaintext: ArchiveJournalPayloadCodec.encode(encoded),
      firstLogicalUnit: 1,
      logicalUnitCount: 1
    )
    journal.close()

    lane = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: fixture.tape,
      indexURL: fixture.index,
      rootKey: rootKey,
      context: context
    )
    _ = try lane.appendPCM(
      pcm(Array(repeating: Int16(2_000), count: 16_000)),
      observation: ArchiveIndexObservation(
        monoNS: 2_000_000_000,
        wallNS: wallBase + 2_000_000_000,
        rmsQ15: 0,
        nativeFrames: nil,
        inputRateNumerator: nil,
        inputRateDenominator: nil,
        discontinuity: .restart,
        reason: ArchiveIndexDiscontinuity.restart.rawValue
      )
    )
    lane.close()

    let second = try ArchiveLocalDeriver.derive(
      tapeURL: fixture.tape,
      indexURL: fixture.index,
      journalURL: journalURL,
      levelURL: levelURL,
      rootKey: rootKey,
      context: context,
      sessionID: "bs_advanced",
      finalFlush: true
    )
    #expect(second.reservations.count == 2)
    #expect(second.journalRecordsWritten == 1)
    let scan = try ArchiveDerivedStore.inspect(
      url: journalURL,
      purpose: .journal,
      rootKey: rootKey,
      context: context
    )
    let replay = try ArchiveJournalReplay.validate(
      scan.records.map { try ArchiveJournalPayloadCodec.decode($0.plaintext) }
    )
    #expect(replay.count == 2)
    #expect(replay[reservation.reservationID]?.state == .encoded)
    #expect(
      replay[second.reservations[1].reservationID]?.initialReservation
        == second.reservations[1]
    )
  }

  @Test func liveDerivationFreezesShortTailThenAppendsSixtyObservationRecordAndDiscontinuity()
    throws
  {
    let fixture = try makeLaneFixture("derive-live-growth")
    defer { fixture.remove() }
    let writer = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: fixture.tape,
      indexURL: fixture.index,
      rootKey: rootKey,
      context: context)
    let journal = fixture.directory.appendingPathComponent("primary.jrn")
    let level = fixture.directory.appendingPathComponent("primary.lvl")

    _ = try writer.appendPCM(
      pcm(Array(repeating: Int16(100), count: 8_000)),
      observation: observation(sampleEnd: 8_000))
    var snapshot = try writer.authenticatedSnapshot()
    let first = try ArchiveLocalDeriver.derive(
      snapshot: snapshot,
      journalURL: journal,
      levelURL: level,
      rootKey: rootKey,
      context: context,
      sessionID: "bs_live",
      finalFlush: false)
    snapshot.close()
    #expect(first.levelRecords.map(\.observations.count) == [1])
    #expect(first.levelRecords[0].sampleCount == 8_000)
    let firstBytes = try Data(contentsOf: level)

    let oneSecond = pcm(Array(repeating: Int16(1_000), count: 16_000))
    for second in 1...60 {
      _ = try writer.appendPCM(
        oneSecond,
        observation: observation(sampleEnd: 8_000 + UInt64(second) * 16_000))
    }
    snapshot = try writer.authenticatedSnapshot()
    let second = try ArchiveLocalDeriver.derive(
      snapshot: snapshot,
      journalURL: journal,
      levelURL: level,
      rootKey: rootKey,
      context: context,
      sessionID: "bs_live",
      finalFlush: false)
    snapshot.close()
    #expect(second.levelRecords.map(\.observations.count) == [1, 60])
    #expect(second.levelRecordsWritten == 1)
    let secondBytes = try Data(contentsOf: level)
    #expect(secondBytes.starts(with: firstBytes))

    _ = try writer.appendPCM(
      pcm(Array(repeating: Int16(2_000), count: 8_000)),
      observation: ArchiveIndexObservation(
        monoNS: nil,
        wallNS: nil,
        rmsQ15: 0,
        nativeFrames: nil,
        inputRateNumerator: nil,
        inputRateDenominator: nil,
        discontinuity: .restart,
        reason: ArchiveIndexDiscontinuity.restart.rawValue))
    snapshot = try writer.authenticatedSnapshot()
    let third = try ArchiveLocalDeriver.derive(
      snapshot: snapshot,
      journalURL: journal,
      levelURL: level,
      rootKey: rootKey,
      context: context,
      sessionID: "bs_live",
      finalFlush: false)
    snapshot.close()
    writer.close()
    #expect(third.levelRecords.map(\.observations.count) == [1, 60, 1])
    #expect(third.levelRecords.map(\.firstSample) == [0, 8_000, 968_000])
    #expect(third.levelRecordsWritten == 1)
    let thirdBytes = try Data(contentsOf: level)
    #expect(thirdBytes.starts(with: secondBytes))

    let rerun = try ArchiveLocalDeriver.derive(
      tapeURL: fixture.tape,
      indexURL: fixture.index,
      journalURL: journal,
      levelURL: level,
      rootKey: rootKey,
      context: context,
      sessionID: "bs_live",
      finalFlush: false)
    #expect(rerun.levelRecords == third.levelRecords)
    #expect(rerun.levelRecordsWritten == 0)
    #expect(try Data(contentsOf: level) == thirdBytes)
  }

  @Test func postMidnightDerivationReportsCoveredCountAndGlobalEndSeparately() throws {
    let fixture = try makeLaneFixture("derive-nonzero-count")
    defer { fixture.remove() }
    let origin: UInt64 = 4_800_000
    let writer = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: fixture.tape,
      indexURL: fixture.index,
      rootKey: rootKey,
      context: context,
      initialSamplePosition: origin)
    var snapshot = try writer.authenticatedSnapshot()
    var result = try ArchiveLocalDeriver.derive(
      snapshot: snapshot,
      journalURL: fixture.directory.appendingPathComponent("primary.jrn"),
      levelURL: fixture.directory.appendingPathComponent("primary.lvl"),
      rootKey: rootKey,
      context: context,
      sessionID: "bs_nonzero",
      finalFlush: false)
    #expect(result.authenticatedSampleCount == 0)
    #expect(result.authenticatedSampleEnd == origin)
    snapshot.close()

    _ = try writer.appendPCM(
      pcm([1, 2, 3]), observation: observation(sampleEnd: origin + 3))
    snapshot = try writer.authenticatedSnapshot()
    result = try ArchiveLocalDeriver.derive(
      snapshot: snapshot,
      journalURL: fixture.directory.appendingPathComponent("primary.jrn"),
      levelURL: fixture.directory.appendingPathComponent("primary.lvl"),
      rootKey: rootKey,
      context: context,
      sessionID: "bs_nonzero",
      finalFlush: false)
    #expect(result.authenticatedSampleCount == 3)
    #expect(result.authenticatedSampleEnd == origin + 3)
    #expect(result.levelRecords.reduce(0) { $0 + UInt64($1.sampleCount) } == 3)
    snapshot.close()
    writer.close()
  }

  @Test func derivationParserRejectsPartialContextBeforeOpeningFiles() throws {
    let directory = try temporaryDirectory("derivation-parse")
    defer { try? FileManager.default.removeItem(at: directory) }
    #expect(throws: RecorderError.self) {
      try UnsignedDevelopmentDerivationCommandOptions.parse([
        "--dir", directory.path,
        "--device", "test",
        "--session", "bs_test",
        "--archive-stream", "C2393EAE-B1E7-41C8-A151-B98719E6C35D",
      ])
    }
    #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
    #expect(throws: RecorderError.self) {
      try UnsignedDevelopmentDerivationCommandOptions.parse([
        "--dir", "",
        "--device", "test",
        "--session", "bs_test",
        "--archive-stream", "C2393EAE-B1E7-41C8-A151-B98719E6C35D",
        "--archive-room", "room_test",
        "--archive-date", "2026-08-27",
        "--archive-lane", "primary",
      ])
    }
  }

  private func reservation(
    sampleStart: UInt64,
    sampleEnd: UInt64,
    chunkIndex: UInt32
  ) throws -> ArchiveJournalPayload {
    let sessionID = "bs_test"
    return try ArchiveJournalPayload(
      reservationID: ArchiveReservationIdentity.make(
        context: context,
        sessionID: sessionID,
        chunkIndex: chunkIndex,
        sampleStart: sampleStart,
        sampleEnd: sampleEnd
      ),
      roomID: context.roomID,
      sessionID: sessionID,
      laneID: context.laneID,
      istDate: context.istDate,
      chunkIndex: chunkIndex,
      sampleStart: sampleStart,
      sampleEnd: sampleEnd,
      startMS: nil,
      endMS: nil,
      uncertainty: .fewerThanThreeAnchors,
      averageLevelQ15: 0,
      peakLevelQ15: 0,
      attemptID: nil,
      priorState: nil,
      newState: .reserved,
      error: nil
    )
  }

  private func metadata(
    sequence: UInt64,
    start: UInt64,
    end: UInt64,
    monoNS: UInt64? = nil,
    discontinuity: ArchiveIndexDiscontinuity? = nil
  ) -> ArchiveIndexRecordMetadata {
    let mono = monoNS
    let wall = mono.map { wallBase + $0 }
    let payload = try! ArchiveIndexPayload(
      tapeSequence: sequence,
      tapeTag: Data(repeating: UInt8(truncatingIfNeeded: sequence), count: 16),
      encryptedEnd: sequence,
      sampleStart: start,
      sampleEnd: end,
      monoNS: mono,
      wallNS: wall,
      deviceUID: context.stableDeviceUID,
      rmsQ15: discontinuity == .crashRecoveredUnindexed ? nil : 0,
      nativeFrames: nil,
      inputRateNumerator: nil,
      inputRateDenominator: nil,
      discontinuity: discontinuity,
      reason: discontinuity?.rawValue,
      gapNS: nil,
      previousDurableSample: discontinuity == .crashRecoveredUnindexed ? start : nil,
      survivingTailBytes: discontinuity == .crashRecoveredUnindexed ? 2 : nil
    )
    let header = ArchiveEnvelopeHeader(
      purpose: .index,
      streamUUID: streamUUID,
      recordSequence: sequence,
      firstLogicalUnit: start,
      logicalUnitCount: UInt32(end - start),
      plaintextByteCount: 1,
      nonce: Data(repeating: 0, count: 12),
      previousCommittedTag: Data(repeating: 0, count: 16),
      contextHash: try! context.sha256()
    )
    return ArchiveIndexRecordMetadata(
      header: header,
      payload: payload,
      authenticationTag: Data(repeating: 0, count: 16),
      encryptedStartOffset: 0,
      encryptedEndOffset: sequence
    )
  }

  private func observation(sampleEnd: UInt64) -> ArchiveIndexObservation {
    ArchiveIndexObservation(
      monoNS: sampleEnd * 62_500,
      wallNS: wallBase + sampleEnd * 62_500,
      rmsQ15: 0,
      nativeFrames: nil,
      inputRateNumerator: nil,
      inputRateDenominator: nil
    )
  }

  private func readRange(
    _ fixture: LaneFixture,
    start: UInt64,
    end: UInt64
  ) throws -> AuthenticatedArchivePCMRange {
    try ArchiveLaneStore.readAuthenticatedPCMRange(
      tapeURL: fixture.tape,
      indexURL: fixture.index,
      rootKey: rootKey,
      context: context,
      sampleStart: start,
      sampleEnd: end
    )
  }

  private func pcm(_ samples: [Int16]) -> Data {
    var result = Data()
    result.reserveCapacity(samples.count * 2)
    for sample in samples {
      let bits = UInt16(bitPattern: sample)
      result.append(UInt8(truncatingIfNeeded: bits))
      result.append(UInt8(truncatingIfNeeded: bits >> 8))
    }
    return result
  }

  private func decodePCM(_ data: Data) -> [Int16] {
    stride(from: 0, to: data.count, by: 2).map { offset in
      Int16(bitPattern: UInt16(data[offset]) | UInt16(data[offset + 1]) << 8)
    }
  }

  private func vadPCM(activeFrames: Int) -> Data {
    var samples = Array(repeating: Int16(0), count: 16_000)
    for index in 0..<(activeFrames * 320) { samples[index] = 4_000 }
    return pcm(samples)
  }

  private func temporaryDirectory(_ name: String) throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(
      "eta-\(name)-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
    return url
  }

  private func makeLaneFixture(_ name: String) throws -> LaneFixture {
    let directory = try temporaryDirectory(name)
    return LaneFixture(
      directory: directory,
      tape: directory.appendingPathComponent("primary.tape"),
      index: directory.appendingPathComponent("primary.index")
    )
  }

  private func append(_ data: Data, to url: URL) throws {
    let handle = try FileHandle(forWritingTo: url)
    defer { try? handle.close() }
    try handle.seekToEnd()
    try handle.write(contentsOf: data)
  }
}

private struct LaneFixture {
  let directory: URL
  let tape: URL
  let index: URL

  func remove() {
    try? FileManager.default.removeItem(at: directory)
  }
}
