#if canImport(RoomRecorderCore)
  import Foundation
  import Testing

  @testable import RoomRecorderCore
  @testable import TapeCore

  @Suite(.serialized) struct RoomPiecePipelineTests {
    private let epochNS: UInt64 = 1_800_000_000_000_000_000

    @Test func plannerUsesExactFullBoundariesAndCheckpointArithmetic() throws {
      let records = [
        checkpoint(samples: 0, wallNS: epochNS),
        checkpoint(samples: 4_800_000, wallNS: epochNS + 300_000_000_000),
        checkpoint(samples: 9_700_000, wallNS: epochNS + 606_250_000_000),
      ]

      let plans = try RoomPiecePlanner.plan(
        records: records,
        sessionID: "bs_plan",
        segmentID: "seg_a",
        startingIndex: 7,
        startingSample: 0
      )

      #expect(plans.map(\.index) == [7, 8])
      #expect(plans.map(\.sampleStart) == [0, 4_800_000])
      #expect(plans.map(\.sampleEnd) == [4_800_000, 9_600_000])
      #expect(plans.map(\.durationMS) == [300_000, 300_000])
      #expect(plans[0].endedAt == plans[1].startedAt)
      #expect(plans[1].endedAt.timeIntervalSince(plans[0].startedAt) == 600)
    }

    @Test func plannerClosesBeforeDiscontinuityAndFlushesOnlyRequestedPartialTail() throws {
      let boundary = Int64(5_600_000)
      let records = [
        checkpoint(samples: 0, wallNS: epochNS),
        checkpoint(samples: boundary, wallNS: epochNS + 350_000_000_000),
        discontinuity(samples: boundary, wallNS: epochNS + 352_000_000_000, gapNS: 2_000_000_000),
        checkpoint(samples: boundary, wallNS: epochNS + 352_000_000_000),
        checkpoint(samples: boundary + 5_000_000, wallNS: epochNS + 664_500_000_000),
      ]

      let normal = try RoomPiecePlanner.plan(
        records: records,
        sessionID: "bs_gap",
        segmentID: "seg_gap",
        startingIndex: 0,
        startingSample: 0
      )
      #expect(normal.map(\.sampleStart) == [0, 4_800_000, boundary])
      #expect(normal.map(\.sampleEnd) == [4_800_000, boundary, boundary + 4_800_000])
      #expect(normal[1].sampleEnd == normal[2].sampleStart)
      #expect(normal[2].gapBeforeMS == 2_000)
      #expect(
        normal[2].startedAt
          == Date(timeIntervalSince1970: Double(epochNS + 352_000_000_000) / 1_000_000_000))
      #expect(normal.allSatisfy { !($0.sampleStart < boundary && $0.sampleEnd > boundary) })

      let final = try RoomPiecePlanner.plan(
        records: records,
        sessionID: "bs_gap",
        segmentID: "seg_gap",
        startingIndex: 0,
        startingSample: 0,
        finalFlush: true
      )
      #expect(final.last?.sampleEnd == boundary + 5_000_000)
      #expect(final.last?.durationMS == 12_500)
    }

    @Test func tornIndexTailCannotExtendAPlannedFinalPiece() throws {
      let directory = try temporaryDirectory(prefix: "piece-index")
      defer { try? FileManager.default.removeItem(at: directory) }
      let indexURL = directory.appendingPathComponent("tape.idx")
      var bytes = try IndexLog.encodedLine(checkpoint(samples: 0, wallNS: epochNS))
      bytes.append(
        try IndexLog.encodedLine(
          checkpoint(samples: 800_000, wallNS: epochNS + 50_000_000_000)))
      bytes.append(Data(#"{"byte_offset":9600000,"samples":4800000"#.utf8))
      try bytes.write(to: indexURL)

      let read = try IndexLog.read(url: indexURL)
      let plans = try RoomPiecePlanner.plan(
        records: read.records,
        sessionID: "bs_partial",
        segmentID: "seg_partial",
        startingIndex: 0,
        startingSample: 0,
        finalFlush: true
      )

      #expect(read.discardedTrailingBytes > 0)
      #expect(plans.count == 1)
      #expect(plans[0].sampleEnd == 800_000)
    }

    @Test func spoolSurvivesRelaunchPublishesStablePrivateImmutableFiles() throws {
      let root = try temporaryDirectory(prefix: "piece-spool").appendingPathComponent("pending")
      defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
      let spool = try RoomPieceSpool(rootURL: root)
      let plans = try RoomPiecePlanner.plan(
        records: [
          checkpoint(samples: 0, wallNS: epochNS),
          checkpoint(samples: 9_600_000, wallNS: epochNS + 600_000_000_000),
        ],
        sessionID: "bs_spool",
        segmentID: "seg_spool",
        startingIndex: 0,
        startingSample: 0
      )
      let manifest = try plans[0].manifest(sizeBytes: 4)
      let laterManifest = try plans[1].manifest(sizeBytes: 2)
      let laterMediaURL = spool.mediaURL(for: laterManifest)
      try Data([5, 6]).write(to: laterMediaURL)
      let laterPiece = try spool.publish(laterManifest)
      let mediaURL = spool.mediaURL(for: manifest)
      try Data([1, 2, 3, 4]).write(to: mediaURL)
      let piece = try spool.publish(manifest)
      let firstJSON = try Data(contentsOf: piece.manifestURL)

      let relaunched = try RoomPieceSpool(rootURL: root)
      let pending = try relaunched.pending()
      #expect(pending.map(\.manifest) == [manifest, laterManifest])
      #expect(try pending[0].manifest.encodedJSON() == firstJSON)
      #expect(fileMode(root) == 0o700)
      #expect(fileMode(pending[0].mediaURL) == 0o600)
      #expect(fileMode(pending[0].manifestURL) == 0o600)

      #expect(throws: RoomPiecePipelineError.destinationExists(piece.manifestURL.path)) {
        try relaunched.publish(manifest)
      }
      #expect(try Data(contentsOf: pending[0].mediaURL) == Data([1, 2, 3, 4]))

      #expect(throws: RoomPiecePipelineError.verificationMismatch) {
        try relaunched.removeVerified(
          pending[0],
          verification: RoomPieceUploadVerification(
            sessionID: manifest.sessionID, index: manifest.index, sizeBytes: 3))
      }
      #expect(try relaunched.pending().count == 2)

      try relaunched.removeVerified(
        pending[0],
        verification: RoomPieceUploadVerification(
          sessionID: manifest.sessionID,
          index: manifest.index,
          sizeBytes: manifest.sizeBytes))
      try relaunched.removeVerified(
        laterPiece,
        verification: RoomPieceUploadVerification(
          sessionID: laterManifest.sessionID,
          index: laterManifest.index,
          sizeBytes: laterManifest.sizeBytes))
      #expect(try relaunched.pending().isEmpty)
    }

    @Test func injectedEncoderReadsExactRangeAndCleansEveryFailureTemporary() throws {
      let directory = try temporaryDirectory(prefix: "piece-encoder")
      defer { try? FileManager.default.removeItem(at: directory) }
      let pcmURL = directory.appendingPathComponent("tape.pcm")
      try Data((0..<64).map(UInt8.init)).write(to: pcmURL)
      let plan = RoomPiecePlan(
        sessionID: "bs_encode",
        index: 0,
        segmentID: "seg_encode",
        sampleStart: 4,
        sampleEnd: 12,
        startedAt: Date(timeIntervalSince1970: 0),
        endedAt: Date(timeIntervalSince1970: 0.0005),
        durationMS: 1,
        gapBeforeMS: 0
      )

      let success = StubRunner { invocation in
        let inputIndex = try #require(invocation.arguments.firstIndex(of: "-i"))
        let inputURL = URL(fileURLWithPath: invocation.arguments[inputIndex + 1])
        #expect(try Data(contentsOf: inputURL) == Data((8..<24).map(UInt8.init)))
        #expect(invocation.arguments.contains("libopus"))
        #expect(invocation.arguments.contains("voip"))
        #expect(invocation.arguments.contains("32k"))
        #expect(invocation.arguments.contains("20"))
        try Data([0x1A, 0x45, 0xDF, 0xA3]).write(to: invocation.outputURL)
        return RoomPieceProcessResult(terminationStatus: 0)
      }
      let destination = directory.appendingPathComponent("piece.webm")
      let encoder = FFmpegPieceEncoder(
        command: FFmpegEncoderCommand(executableURL: URL(fileURLWithPath: "/not/used/ffmpeg")),
        runner: success)
      #expect(try encoder.encode(plan: plan, pcmURL: pcmURL, destinationURL: destination) == 4)
      #expect(try Data(contentsOf: destination) == Data([0x1A, 0x45, 0xDF, 0xA3]))
      #expect(fileMode(destination) == 0o600)

      let failedDestination = directory.appendingPathComponent("failed.webm")
      let failure = StubRunner { invocation in
        try Data([1, 2]).write(to: invocation.outputURL)
        return RoomPieceProcessResult(terminationStatus: 9, standardError: "synthetic failure")
      }
      let failingEncoder = FFmpegPieceEncoder(command: encoder.command, runner: failure)
      #expect(
        throws: RoomPiecePipelineError.processFailed(status: 9, stderr: "synthetic failure")
      ) {
        try failingEncoder.encode(
          plan: plan, pcmURL: pcmURL, destinationURL: failedDestination)
      }
      #expect(!FileManager.default.fileExists(atPath: failedDestination.path))
      let leftovers = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        .filter { $0.hasPrefix(".piece-") }
      #expect(leftovers.isEmpty)
    }

    @Test func installedFFmpegProducesDecodableMonoOpusWebM() throws {
      let ffmpeg = URL(fileURLWithPath: "/opt/homebrew/bin/ffmpeg")
      let ffprobe = URL(fileURLWithPath: "/opt/homebrew/bin/ffprobe")
      guard FileManager.default.isExecutableFile(atPath: ffmpeg.path),
        FileManager.default.isExecutableFile(atPath: ffprobe.path)
      else { return }

      let directory = try temporaryDirectory(prefix: "piece-real-ffmpeg")
      defer { try? FileManager.default.removeItem(at: directory) }
      let pcmURL = directory.appendingPathComponent("tape.pcm")
      var samples = (0..<16_000).map { sample -> Int16 in
        let phase = Double(sample) * 440 * 2 * Double.pi / 16_000
        return Int16((sin(phase) * 4_000).rounded())
      }
      let pcm = samples.withUnsafeMutableBytes { Data($0) }
      try pcm.write(to: pcmURL)
      let plan = RoomPiecePlan(
        sessionID: "bs_real_encoder",
        index: 0,
        segmentID: "seg_real_encoder",
        sampleStart: 0,
        sampleEnd: 16_000,
        startedAt: Date(timeIntervalSince1970: 0),
        endedAt: Date(timeIntervalSince1970: 1),
        durationMS: 1_000,
        gapBeforeMS: 0)
      let webMURL = directory.appendingPathComponent("piece.webm")
      let encoder = FFmpegPieceEncoder(
        command: FFmpegEncoderCommand(executableURL: ffmpeg))

      #expect(try encoder.encode(plan: plan, pcmURL: pcmURL, destinationURL: webMURL) > 0)

      let probe = Process()
      let output = Pipe()
      probe.executableURL = ffprobe
      probe.arguments = [
        "-v", "error", "-show_entries", "stream=codec_name,channels", "-of", "json",
        webMURL.path,
      ]
      probe.standardOutput = output
      probe.standardError = FileHandle.nullDevice
      try probe.run()
      let data = output.fileHandleForReading.readDataToEndOfFile()
      probe.waitUntilExit()
      #expect(probe.terminationStatus == 0)
      let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
      let streams = try #require(object["streams"] as? [[String: Any]])
      let stream = try #require(streams.first)
      #expect(stream["codec_name"] as? String == "opus")
      #expect(stream["channels"] as? Int == 1)
    }

    private func checkpoint(samples: Int64, wallNS: UInt64) -> IndexRecord {
      IndexRecord(
        byteOffset: samples * TapeConstants.bytesPerSample,
        samples: samples,
        monoNS: wallNS - 1_000_000_000,
        wallNS: wallNS,
        device: "fixture",
        rms: 0.1
      )
    }

    private func discontinuity(
      samples: Int64, wallNS: UInt64, gapNS: UInt64
    ) -> IndexRecord {
      IndexRecord(
        byteOffset: samples * TapeConstants.bytesPerSample,
        samples: samples,
        monoNS: wallNS - 1_000_000_000,
        wallNS: wallNS,
        device: "fixture",
        discontinuity: "capture_discontinuity",
        gapNS: gapNS
      )
    }
  }

  private struct StubRunner: RoomPieceProcessRunning {
    let body: @Sendable (FFmpegEncoderInvocation) throws -> RoomPieceProcessResult

    init(_ body: @escaping @Sendable (FFmpegEncoderInvocation) throws -> RoomPieceProcessResult) {
      self.body = body
    }

    func run(_ invocation: FFmpegEncoderInvocation) throws -> RoomPieceProcessResult {
      try body(invocation)
    }
  }

  private func temporaryDirectory(prefix: String) throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(
      "\(prefix)-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
    return url
  }

  private func fileMode(_ url: URL) -> Int {
    let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
    return (attributes?[.posixPermissions] as? NSNumber)?.intValue ?? -1
  }
#endif
