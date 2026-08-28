import Foundation
import Testing

@testable import TapeCapture
@testable import TapeCore

@Suite(.serialized) struct UnsignedDevelopmentArchiveTests {
  private let streamUUID = UUID(uuidString: "00112233-4455-6677-8899-AABBCCDDEEFF")!

  @Test func recordOptionsRequireAnExplicitCompleteValidContextBeforeOutputExists() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let output = root.appendingPathComponent("recording").path

    let legacy = try RecordCommandOptions.parse(["--out", output, "--device", "fixture"])
    #expect(legacy.outputDirectory.path == output)
    #expect(legacy.requestedDeviceUID == "fixture")
    #expect(legacy.unsignedDevelopmentArchive == nil)

    let archive = try RecordCommandOptions.parse(validArguments(output: output))
    #expect(archive.unsignedDevelopmentArchive?.streamUUID == streamUUID)
    #expect(archive.unsignedDevelopmentArchive?.roomID == "room_test")
    #expect(archive.unsignedDevelopmentArchive?.istDate == "2026-08-27")
    #expect(archive.unsignedDevelopmentArchive?.laneID == "primary")

    let inspection = try UnsignedDevelopmentArchiveInspectionCommandOptions.parse(
      inspectionArguments(directory: output))
    #expect(inspection.directory.path == output)
    #expect(inspection.stableDeviceUID == "fixture-device")
    #expect(inspection.archive == archive.unsignedDevelopmentArchive)

    let invalidArguments = [
      ["--out", output, "--out", output],
      ["--out", output, "--unknown"],
      ["--out", output, "--archive-room", "room_test"],
      ["--out", output, "--unsigned-development-archive"],
      validArguments(output: output, stream: "not-a-uuid"),
      validArguments(output: output, date: "2026-02-29"),
      validArguments(output: output, lane: "../primary"),
    ]
    for arguments in invalidArguments {
      #expect(throws: (any Error).self) {
        try RecordCommandOptions.parse(arguments)
      }
    }
    #expect(!FileManager.default.fileExists(atPath: root.path))
  }

  @Test func archiveMirrorsExactPCMInOneSecondRecordsAndOneShortFinalRecord() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let options = try archiveOptions()

    try writeSamples(count: 40_000, to: directory, archive: options)

    let pcm = try Data(contentsOf: directory.appendingPathComponent("tape.pcm"))
    let opened = try openedArchive(directory: directory, options: options)
    #expect(opened.plaintext == pcm)
    #expect(opened.scan.tape.records.count == 3)
    #expect(opened.scan.index.records.count == opened.scan.tape.records.count)
    #expect(opened.scan.tape.records.map(\.header.logicalUnitCount) == [16_000, 16_000, 8_000])
    #expect(
      opened.scan.index.records.map { [$0.payload.sampleStart, $0.payload.sampleEnd] }
        == [[0, 16_000], [16_000, 32_000], [32_000, 40_000]])
    #expect(
      opened.scan.index.records.map(\.payload.tapeSequence)
        == opened.scan.tape.records.map(\.header.recordSequence))
    #expect(opened.scan.index.records.allSatisfy { $0.payload.nativeFrames == nil })
    #expect(
      Array(unsignedDevelopmentArchivePublishedFixedTestRootKey)
        == Array(UInt8(0x00)...UInt8(0x1F)))
    let inspection = try UnsignedDevelopmentArchiveInspection.inspect(
      directory: directory,
      options: options,
      stableDeviceUID: "fixture-device")
    #expect(inspection.ok)
    #expect(inspection.recordCount == 3)
    #expect(inspection.sampleCount == 40_000)
    #expect(inspection.plaintextByteCount == UInt64(pcm.count))
    #expect(inspection.stagingByteCount == UInt64(pcm.count))
    #expect(inspection.plaintextMatchesStaging)
    #expect(inspection.fullRecordCount == 2)
    #expect(inspection.shortRecordCount == 1)
  }

  @Test func archiveReopensAndContinuesFromItsAuthenticatedLogicalEnd() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let options = try archiveOptions()

    try writeSamples(count: 20_000, to: directory, archive: options, startNS: 1_000_000_000)
    try writeSamples(count: 17_000, to: directory, archive: options, startNS: 3_000_000_000)

    let pcm = try Data(contentsOf: directory.appendingPathComponent("tape.pcm"))
    let opened = try openedArchive(directory: directory, options: options)
    #expect(opened.plaintext == pcm)
    #expect(
      opened.scan.tape.records.map(\.header.logicalUnitCount)
        == [16_000, 4_000, 16_000, 1_000])
    #expect(opened.scan.index.records.last?.payload.sampleEnd == 37_000)
    #expect(opened.scan.tape.records.last?.header.recordSequence == 4)
    #expect(opened.scan.index.records[2].payload.discontinuity == .restart)
    #expect(opened.scan.index.records[2].payload.reason == "restart")
  }

  @Test func archiveReopenTruncatesOnlyThePlaintextStagingTail() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let options = try archiveOptions()
    try writeSamples(count: 18_000, to: directory, archive: options)
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let durablePCM = try Data(contentsOf: pcmURL)
    let handle = try FileHandle(forWritingTo: pcmURL)
    try handle.seekToEnd()
    try handle.write(contentsOf: Data([1, 2, 3, 4, 5, 6]))
    try handle.close()

    let writer = TapeWriter(
      directory: directory,
      deviceUID: "fixture-device",
      ring: AudioRing(),
      checkpointIntervalNS: .max,
      unsignedDevelopmentArchive: options
    )
    try writer.startAndWaitUntilReady()
    try writer.stopAndWait()

    #expect(try Data(contentsOf: pcmURL) == durablePCM)
    let opened = try openedArchive(directory: directory, options: options)
    #expect(opened.plaintext == durablePCM)
    #expect(opened.scan.index.records.last?.payload.sampleEnd == 18_000)
  }

  @Test func archiveRefusesShortPlaintextAndNonemptyLegacyPlaintext() throws {
    let archiveDirectory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: archiveDirectory) }
    let options = try archiveOptions()
    try writeSamples(count: 1_000, to: archiveDirectory, archive: options)
    let pcmURL = archiveDirectory.appendingPathComponent("tape.pcm")
    let handle = try FileHandle(forWritingTo: pcmURL)
    try handle.truncate(atOffset: 1_998)
    try handle.close()
    let shortWriter = TapeWriter(
      directory: archiveDirectory,
      deviceUID: "fixture-device",
      ring: AudioRing(),
      unsignedDevelopmentArchive: options
    )
    #expect(throws: (any Error).self) {
      try shortWriter.startAndWaitUntilReady()
    }

    let legacyDirectory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: legacyDirectory) }
    try writeSamples(count: 1_000, to: legacyDirectory, archive: nil)
    let legacyPCM = try Data(contentsOf: legacyDirectory.appendingPathComponent("tape.pcm"))
    let adoptingWriter = TapeWriter(
      directory: legacyDirectory,
      deviceUID: "fixture-device",
      ring: AudioRing(),
      unsignedDevelopmentArchive: options
    )
    #expect(throws: (any Error).self) {
      try adoptingWriter.startAndWaitUntilReady()
    }
    #expect(try Data(contentsOf: legacyDirectory.appendingPathComponent("tape.pcm")) == legacyPCM)
    #expect(
      !FileManager.default.fileExists(
        atPath: legacyDirectory.appendingPathComponent("primary.tape").path))
    #expect(
      !FileManager.default.fileExists(
        atPath: legacyDirectory.appendingPathComponent("primary.index").path))
  }

  @Test func archiveFailsClosedWhenPlaintextIndexClaimsAStagingTail() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let options = try archiveOptions()
    try writeSamples(count: 1_000, to: directory, archive: options)
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let pcmHandle = try FileHandle(forWritingTo: pcmURL)
    try pcmHandle.seekToEnd()
    try pcmHandle.write(contentsOf: Data([0, 0]))
    try pcmHandle.close()
    let indexURL = directory.appendingPathComponent("tape.idx")
    let indexHandle = try FileHandle(forWritingTo: indexURL)
    try indexHandle.seekToEnd()
    try indexHandle.write(
      contentsOf: IndexLog.encodedLine(
        IndexRecord(
          byteOffset: 2_002,
          samples: 1_001,
          monoNS: 20_000_000_000,
          wallNS: 30_000_000_000,
          device: "fixture-device",
          rms: 0
        )))
    try indexHandle.close()

    let writer = TapeWriter(
      directory: directory,
      deviceUID: "fixture-device",
      ring: AudioRing(),
      unsignedDevelopmentArchive: options
    )
    #expect(throws: (any Error).self) {
      try writer.startAndWaitUntilReady()
    }
    #expect(try Data(contentsOf: pcmURL).count == 2_000)
  }

  @Test func legacyWriterStillProducesOnlyItsValidPlaintextTapeAndIndex() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }

    try writeSamples(count: 16_000, to: directory, archive: nil)

    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let pcm = try Data(contentsOf: pcmURL)
    #expect(pcm.count == 32_000)
    #expect(try TapeVerifier.verify(directory: directory).passed)
    #expect(
      !FileManager.default.fileExists(
        atPath: directory.appendingPathComponent("primary.tape").path))
    #expect(
      !FileManager.default.fileExists(
        atPath: directory.appendingPathComponent("primary.index").path))
  }

  @Test func markerMappingIsExactAndCoalescingIsDeterministicAndBounded() throws {
    let mappings: [(StreamMarker, ArchiveIndexDiscontinuity)] = [
      (.restart, .restart),
      (.deviceLost, .deviceLost),
      (.resumed, .resumed),
      (.configurationChange, .captureDiscontinuity),
      (.ringOverflow, .ringOverflow),
      (.captureDiscontinuity, .captureDiscontinuity),
      (.invalidTimestamp, .invalidTimestamp),
      (.clockJump, .clockDiscontinuity),
      (.formatChange, .formatChange),
    ]
    for (marker, expected) in mappings {
      var accumulator = ArchiveDiscontinuityAccumulator()
      accumulator.append(
        StreamItem(marker: marker, monoStartNS: 10, wallStartNS: 20, gapNS: 30))
      let observation = try #require(accumulator.observation)
      #expect(observation.discontinuity == expected)
      #expect(observation.reason == marker.indexName)
      #expect(observation.gapNS == 30)
      #expect(observation.monoNS == 10)
      #expect(observation.wallNS == 20)
    }

    var coalesced = ArchiveDiscontinuityAccumulator()
    coalesced.append(
      StreamItem(marker: .configurationChange, monoStartNS: 1, wallStartNS: 2, gapNS: 3))
    coalesced.append(
      StreamItem(marker: .clockJump, monoStartNS: 4, wallStartNS: 5, gapNS: 9))
    coalesced.append(
      StreamItem(marker: .configurationChange, monoStartNS: 6, wallStartNS: 7, gapNS: 4))
    let observation = try #require(coalesced.observation)
    #expect(observation.discontinuity == .captureDiscontinuity)
    #expect(observation.reason == "coalesced:clock_jump,configuration_change*2")
    #expect(observation.gapNS == 9)
    #expect(observation.monoNS == nil)
    #expect(observation.wallNS == nil)
    #expect(observation.reason.utf8.count < 256)
  }

  private func validArguments(
    output: String,
    stream: String = "00112233-4455-6677-8899-AABBCCDDEEFF",
    date: String = "2026-08-27",
    lane: String = "primary"
  ) -> [String] {
    [
      "--out", output,
      "--unsigned-development-archive",
      "--archive-stream", stream,
      "--archive-room", "room_test",
      "--archive-date", date,
      "--archive-lane", lane,
    ]
  }

  private func inspectionArguments(directory: String) -> [String] {
    [
      "--dir", directory,
      "--device", "fixture-device",
      "--archive-stream", "00112233-4455-6677-8899-AABBCCDDEEFF",
      "--archive-room", "room_test",
      "--archive-date", "2026-08-27",
      "--archive-lane", "primary",
    ]
  }

  private func archiveOptions() throws -> UnsignedDevelopmentArchiveOptions {
    try UnsignedDevelopmentArchiveOptions(
      streamUUID: streamUUID,
      roomID: "room_test",
      istDate: "2026-08-27",
      laneID: "primary"
    )
  }

  private func writeSamples(
    count: Int,
    to directory: URL,
    archive: UnsignedDevelopmentArchiveOptions?,
    startNS: UInt64 = 1_000_000_000
  ) throws {
    let ring = AudioRing(slotCount: 64, framesPerSlot: 8_192)
    var remaining = count
    var written = 0
    while remaining > 0 {
      let frameCount = min(8_192, remaining)
      var samples = [Float](repeating: 0.25, count: frameCount)
      let monoStart = startNS + UInt64(written) * 1_000_000_000 / 16_000
      let monoEnd = startNS + UInt64(written + frameCount) * 1_000_000_000 / 16_000
      let accepted = samples.withUnsafeMutableBufferPointer { buffer in
        var channel = buffer.baseAddress!
        return withUnsafePointer(to: &channel) { channels in
          ring.writeAudio(
            channels: channels,
            channelCount: 1,
            frameCount: frameCount,
            sampleRate: 16_000,
            monoStartNS: monoStart,
            monoEndNS: monoEnd,
            wallStartNS: monoStart + 10_000_000_000,
            wallEndNS: monoEnd + 10_000_000_000,
            boundaries: BoundaryBatch()
          )
        }
      }
      guard accepted else { throw RecorderError("test ring unexpectedly rejected audio") }
      remaining -= frameCount
      written += frameCount
    }

    let writer = TapeWriter(
      directory: directory,
      deviceUID: "fixture-device",
      ring: ring,
      checkpointIntervalNS: .max,
      unsignedDevelopmentArchive: archive
    )
    try writer.startAndWaitUntilReady()
    try writer.stopAndWait()
  }

  private func openedArchive(
    directory: URL,
    options: UnsignedDevelopmentArchiveOptions
  ) throws -> (scan: ArchiveLaneScanResult, plaintext: Data) {
    let tapeURL = directory.appendingPathComponent("\(options.laneID).tape")
    let indexURL = directory.appendingPathComponent("\(options.laneID).index")
    let context = archiveContext(options)
    let scan = try ArchiveLaneStore.inspect(
      tapeURL: tapeURL,
      indexURL: indexURL,
      rootKey: unsignedDevelopmentArchivePublishedFixedTestRootKey,
      context: context
    )
    let encodedTape = try Data(contentsOf: tapeURL)
    let contextHash = try context.sha256()
    var plaintext = Data()
    for record in scan.tape.records {
      let start = Int(record.encryptedStartOffset)
      let end = Int(record.encryptedEndOffset)
      let opened = try ArchiveRecordCrypto.open(
        Data(encodedTape[start..<end]),
        rootKey: unsignedDevelopmentArchivePublishedFixedTestRootKey,
        expectedPurpose: .tape,
        expectedContextHash: contextHash
      )
      plaintext.append(opened.plaintext)
    }
    return (scan, plaintext)
  }

  private func archiveContext(_ options: UnsignedDevelopmentArchiveOptions) -> ArchiveContext {
    let streamBytes = withUnsafeBytes(of: options.streamUUID.uuid) { Data($0) }
    return ArchiveContext(
      streamUUID: streamBytes,
      roomID: options.roomID,
      istDate: options.istDate,
      laneID: options.laneID,
      stableDeviceUID: "fixture-device"
    )
  }
}
