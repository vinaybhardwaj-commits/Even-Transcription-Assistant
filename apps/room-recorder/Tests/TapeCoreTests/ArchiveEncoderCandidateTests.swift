import Darwin
import Foundation
import Testing

@testable import TapeCore

@Suite(.serialized) struct ArchiveEncoderCandidateTests {
  @Test func commandMatchesTheRatifiedPipeOnlyCandidate() {
    let command = ArchiveFFmpegCommand(executableURL: URL(fileURLWithPath: "/encoder/ffmpeg"))

    #expect(
      command.arguments == [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-nostats",
        "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "pipe:0",
        "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1",
        "-c:a", "libopus", "-application", "voip", "-b:a", "32k", "-vbr", "on",
        "-frame_duration", "20", "-packet_loss", "0", "-fec", "0", "-dtx", "0",
        "-ar", "16000", "-ac", "1", "-write_crc32", "1", "-cluster_time_limit", "5000",
        "-live", "1", "-f", "webm", "pipe:1",
      ])
    #expect(ArchiveFFmpegCommand.contentType == "audio/webm")
  }

  @Test func pinnedCandidateProducesIndependentlyDecodableMonoOpusWebM() throws {
    guard let encoderPath = ProcessInfo.processInfo.environment["ETA_ENCODER_FFMPEG"] else {
      return
    }
    let encoderURL = URL(fileURLWithPath: encoderPath)
    try #require(FileManager.default.isExecutableFile(atPath: encoderURL.path))

    let pcm = syntheticPCM(sampleCount: 16_000)
    let encoded = try runProcess(
      executableURL: encoderURL,
      arguments: ArchiveFFmpegCommand(executableURL: encoderURL).arguments,
      standardInput: pcm)
    #expect(encoded.status == 0)
    #expect(encoded.standardError.isEmpty)
    #expect(encoded.standardOutput.count > 4)
    #expect(encoded.standardOutput.prefix(4) == Data([0x1A, 0x45, 0xDF, 0xA3]))

    let independentDecoder = URL(fileURLWithPath: "/opt/homebrew/bin/ffmpeg")
    guard FileManager.default.isExecutableFile(atPath: independentDecoder.path) else {
      return
    }
    let decoded = try runProcess(
      executableURL: independentDecoder,
      arguments: [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", "pipe:0", "-map", "0:a:0", "-f", "s16le",
        "-ar", "16000", "-ac", "1", "pipe:1",
      ],
      standardInput: encoded.standardOutput)
    #expect(decoded.status == 0)
    #expect(decoded.standardError.isEmpty)
    #expect(decoded.standardOutput.count >= 16_000)
    #expect(decoded.standardOutput.contains { $0 != 0 })
  }

  @Test func pinnedCandidatePublishesFromAuthenticatedTapeThroughEncryptedSpool() throws {
    guard let encoderPath = ProcessInfo.processInfo.environment["ETA_ENCODER_FFMPEG"] else {
      return
    }
    let encoderURL = URL(fileURLWithPath: encoderPath)
    try #require(FileManager.default.isExecutableFile(atPath: encoderURL.path))
    let requestedDirectory = FileManager.default.temporaryDirectory
      .appendingPathComponent("archive-encoder-pipeline-\(UUID().uuidString)")
    try FileManager.default.createDirectory(
      at: requestedDirectory, withIntermediateDirectories: false)
    guard let resolved = realpath(requestedDirectory.path, nil) else {
      throw ArchiveEncryptedSpoolError.invalidDirectory
    }
    defer { Darwin.free(resolved) }
    let directory = URL(fileURLWithPath: String(cString: resolved), isDirectory: true)
    #expect(chmod(directory.path, mode_t(0o700)) == 0)
    defer { try? FileManager.default.removeItem(at: directory) }

    let rootKey = Data(UInt8(0)...UInt8(31))
    let context = ArchiveContext(
      streamUUID: Data(UInt8(16)...UInt8(31)),
      roomID: "room_encoder_pipeline_test",
      istDate: "2026-08-28",
      laneID: "primary",
      stableDeviceUID: "synthetic-encoder-pipeline-test"
    )
    let lane = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: directory.appendingPathComponent("primary.tape"),
      indexURL: directory.appendingPathComponent("primary.idx"),
      rootKey: rootKey,
      context: context
    )
    let pcm = syntheticPCM(sampleCount: 16_000)
    _ = try lane.appendPCM(
      pcm,
      observation: ArchiveIndexObservation(
        monoNS: 1_000_000_000,
        wallNS: 1_787_907_600_000_000_000,
        rmsQ15: 2_000,
        nativeFrames: nil,
        inputRateNumerator: nil,
        inputRateDenominator: nil
      )
    )
    let snapshot = try lane.authenticatedSnapshot()
    lane.close()
    defer { snapshot.close() }

    let sessionID = "bs_encoder_pipeline_test"
    let reservationID = try ArchiveReservationIdentity.make(
      context: context,
      sessionID: sessionID,
      chunkIndex: 0,
      sampleStart: 0,
      sampleEnd: 16_000
    )
    let reservation = try ArchiveJournalPayload(
      reservationID: reservationID,
      roomID: context.roomID,
      sessionID: sessionID,
      laneID: context.laneID,
      istDate: context.istDate,
      chunkIndex: 0,
      sampleStart: 0,
      sampleEnd: 16_000,
      startMS: 1_000,
      endMS: 2_000,
      uncertainty: nil,
      averageLevelQ15: 1_000,
      peakLevelQ15: 4_000,
      attemptID: nil,
      priorState: nil,
      newState: .reserved,
      error: nil
    )
    let journalURL = directory.appendingPathComponent("primary.jrn")
    let journal = try snapshot.openJournalStoreForAppend(at: journalURL)
    _ = try journal.append(
      plaintext: ArchiveJournalPayloadCodec.encode(reservation),
      firstLogicalUnit: 0,
      logicalUnitCount: 1
    )
    journal.close()
    let coordinator = ArchiveSpoolCoordinator(
      encoder: ArchiveFFmpegStreamingEncoder(
        command: ArchiveFFmpegCommand(executableURL: encoderURL)
      ),
      encoderProvenanceID: "ffmpeg-n9.0.1-libopus-1.6.1-arm64-candidate"
    )
    let result = try coordinator.advance(
      snapshot: snapshot,
      journalURL: journalURL,
      manifestURL: directory.appendingPathComponent("primary.manifest"),
      spoolDirectoryURL: directory,
      initialReservation: reservation,
      fitSegment: 0,
      freshAttemptID: "632009ea-5437-4f96-9d16-ccbee00ba4a6"
    )
    let spool = try snapshot.inspectSpool(at: result.published.url)
    let encoded = spool.records.reduce(into: Data()) { $0.append($1.plaintext) }
    #expect(encoded.prefix(4) == Data([0x1A, 0x45, 0xDF, 0xA3]))
    #expect(result.published.encodedBytes == UInt64(encoded.count))

    let independentDecoder = URL(fileURLWithPath: "/opt/homebrew/bin/ffmpeg")
    guard FileManager.default.isExecutableFile(atPath: independentDecoder.path) else {
      return
    }
    let decoded = try runProcess(
      executableURL: independentDecoder,
      arguments: [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", "pipe:0", "-map", "0:a:0", "-f", "s16le",
        "-ar", "16000", "-ac", "1", "pipe:1",
      ],
      standardInput: encoded
    )
    #expect(decoded.status == 0)
    #expect(decoded.standardError.isEmpty)
    #expect(decoded.standardOutput.count >= 16_000)
    #expect(decoded.standardOutput.contains { $0 != 0 })
  }
}

private struct EncoderProcessResult {
  let status: Int32
  let standardOutput: Data
  let standardError: String
}

private func runProcess(
  executableURL: URL,
  arguments: [String],
  standardInput: Data
) throws -> EncoderProcessResult {
  let output = EncoderLockedData()
  try FoundationArchiveStreamingProcess.run(
    executableURL: executableURL,
    arguments: arguments,
    input: { write in try write(standardInput) },
    output: { output.append($0) },
    timeout: 30
  )
  return EncoderProcessResult(
    status: 0,
    standardOutput: output.data,
    standardError: ""
  )
}

private final class EncoderLockedData: @unchecked Sendable {
  private let lock = NSLock()
  private var storage = Data()

  var data: Data {
    lock.withLock { storage }
  }

  func append(_ data: Data) {
    lock.withLock { storage.append(data) }
  }
}

private func syntheticPCM(sampleCount: Int) -> Data {
  var samples = (0..<sampleCount).map { sample -> Int16 in
    let phase = Double(sample) * 440 * 2 * Double.pi / 16_000
    return Int16((sin(phase) * 4_000).rounded())
  }
  return samples.withUnsafeMutableBytes { Data($0) }
}
