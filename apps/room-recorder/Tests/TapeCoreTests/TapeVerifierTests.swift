import Foundation
import Testing

@testable import TapeCore

@Suite struct TapeVerifierTests {
  @Test func computesDriftAndLargestStepWithinSegments() throws {
    let records = [
      IndexRecord(byteOffset: 0, samples: 0, monoNS: 0, wallNS: 1_000_000_000),
      IndexRecord(
        byteOffset: 64_064, samples: 32_032, monoNS: 2_000_000_000, wallNS: 3_000_000_000),
      IndexRecord(
        byteOffset: 128_064, samples: 64_032, monoNS: 4_000_000_000, wallNS: 5_000_000_000),
    ]

    let report = try TapeVerifier.verify(pcmSize: 128_064, records: records)

    #expect(report.driftRecords.count == 3)
    #expect(abs(report.driftRecords[1].driftMS - 2) < 0.000_1)
    #expect(abs(report.driftRecords[1].ppm! - 1_000) < 0.001)
    #expect(abs(report.driftRecords[2].driftMS - 2) < 0.000_1)
    #expect(abs(report.largestStepAnomalyMS! - 2) < 0.000_1)
    #expect(abs(report.largestCheckpointGapSeconds! - 2) < 0.000_1)
    #expect(abs(report.fittedPPM! - 600) < 0.001)
    #expect(report.passed)
  }

  @Test func discontinuityStartsNewDriftSegment() throws {
    let records = [
      IndexRecord(byteOffset: 0, samples: 0, monoNS: 10, wallNS: 10),
      IndexRecord(
        byteOffset: 64_000, samples: 32_000, monoNS: 2_000_000_010, wallNS: 2_000_000_010),
      IndexRecord(
        byteOffset: 64_000, samples: 32_000, monoNS: 3_000_000_010, wallNS: 3_000_000_010,
        discontinuity: "device_lost"),
      IndexRecord(
        byteOffset: 64_000, samples: 32_000, monoNS: 8_000_000_010, wallNS: 8_000_000_010,
        discontinuity: "resumed", gapNS: 5_000_000_000),
      IndexRecord(
        byteOffset: 64_000, samples: 32_000, monoNS: 8_100_000_010, wallNS: 8_100_000_010),
      IndexRecord(
        byteOffset: 128_000, samples: 64_000, monoNS: 10_100_000_010, wallNS: 10_100_000_010),
    ]

    let report = try TapeVerifier.verify(pcmSize: 128_000, records: records)

    #expect(report.discontinuities.map(\.kind) == ["device_lost", "resumed"])
    #expect(report.discontinuities[1].gapNS == 5_000_000_000)
    #expect(report.driftRecords.count == 4)
    #expect(abs(report.driftRecords.last!.driftMS) < 0.000_1)
  }

  @Test func failsForCurrentTailAboveThreshold() throws {
    let indexedBytes = Int64(32_000)
    let tailBytes = Int64(Double(TapeConstants.bytesPerSecond) * 2.51)
    let records = [
      IndexRecord(byteOffset: indexedBytes, samples: indexedBytes / 2, monoNS: 1, wallNS: 1)
    ]

    let report = try TapeVerifier.verify(pcmSize: indexedBytes + tailBytes, records: records)

    #expect(!report.passed)
    #expect(report.worstTailBytes == tailBytes)
    #expect(report.rendered().hasSuffix("VERDICT: FAIL"))
  }

  @Test func ver02ExactInheritedTailBoundary() throws {
    let indexedBytes: Int64 = 32_000
    let records = [
      IndexRecord(
        byteOffset: indexedBytes,
        samples: indexedBytes / TapeConstants.bytesPerSample,
        monoNS: 1,
        wallNS: 1,
        device: "ver02-fixture",
        rms: 0
      )
    ]
    let cases: [(tailBytes: Int64, shouldPass: Bool)] = [
      (79_998, true),
      (80_000, true),
      (80_002, false),
    ]

    for fixture in cases {
      let report = try TapeVerifier.verify(
        pcmSize: indexedBytes + fixture.tailBytes,
        records: records
      )

      #expect(report.currentTailBytes == fixture.tailBytes)
      #expect(report.worstTailBytes == fixture.tailBytes)
      #expect(report.passed == fixture.shouldPass)
    }
  }

  @Test func ver03AllDiscontinuityIndexLeavesDriftUnavailable() throws {
    let records = [
      IndexRecord(
        byteOffset: 32_000,
        samples: 16_000,
        monoNS: 1_000_000_000,
        wallNS: 11_000_000_000,
        device: "ver03-fixture",
        discontinuity: "device_lost"
      ),
      IndexRecord(
        byteOffset: 40_000,
        samples: 20_000,
        monoNS: 2_000_000_000,
        wallNS: 12_000_000_000,
        device: "ver03-fixture",
        discontinuity: "restart",
        previousByteOffset: 32_000,
        survivingTailBytes: 8_000
      ),
      IndexRecord(
        byteOffset: 96_000,
        samples: 48_000,
        monoNS: 3_000_000_000,
        wallNS: 13_000_000_000,
        device: "ver03-fixture",
        discontinuity: "stopped"
      ),
    ]

    let report = try TapeVerifier.verify(pcmSize: 128_000, records: records)

    #expect(report.currentTailBytes == 32_000)
    #expect(report.worstTailBytes == 32_000)
    #expect(report.discontinuities[1].survivingTailBytes == 8_000)
    #expect(report.driftRecords.isEmpty)
    #expect(report.fittedPPM == nil)
    #expect(report.largestStepAnomalyMS == nil)
    #expect(report.nativeDriftRecords.isEmpty)
    #expect(report.fittedNativePPM == nil)
    #expect(report.largestNativeStepAnomalyMS == nil)
    #expect(report.converterAccountingRecords.isEmpty)
    #expect(report.largestConverterDifferenceSamples == nil)
    #expect(report.largestCheckpointGapSeconds == nil)
    #expect(report.rendered().contains("Per-record durable tape drift:\n  unavailable"))
    #expect(report.passed)
  }

  @Test func ver04MixedDiscontinuitiesPreserveSourceOrderAndSegmentFitsAcrossReboot() throws {
    let records = [
      IndexRecord(
        byteOffset: 0, samples: 0, monoNS: 100_000_000_000, wallNS: 1_000_000_000_000,
        device: "ver04-fixture", rms: 0, inputFrames: 0, inputSampleRate: 48_000),
      IndexRecord(
        byteOffset: 32_000, samples: 16_000, monoNS: 101_000_000_000,
        wallNS: 1_001_000_000_000, device: "ver04-fixture", rms: 0.1,
        inputFrames: 48_000, inputSampleRate: 48_000),
      IndexRecord(
        byteOffset: 40_000, samples: 20_000, monoNS: 1_000_000_000,
        wallNS: 1_100_000_000_000, device: "ver04-fixture", discontinuity: "restart",
        previousByteOffset: 32_000, survivingTailBytes: 8_000),
      IndexRecord(
        byteOffset: 40_000, samples: 20_000, monoNS: 1_100_000_000,
        wallNS: 1_100_100_000_000, device: "ver04-fixture", rms: 0,
        inputFrames: 0, inputSampleRate: 48_000),
      IndexRecord(
        byteOffset: 72_000, samples: 36_000, monoNS: 2_100_000_000,
        wallNS: 1_101_100_000_000, device: "ver04-fixture", rms: 0.1,
        inputFrames: 48_000, inputSampleRate: 48_000),
      IndexRecord(
        byteOffset: 72_000, samples: 36_000, monoNS: 2_200_000_000,
        wallNS: 1_101_200_000_000, device: "ver04-fixture", discontinuity: "device_lost"),
      IndexRecord(
        byteOffset: 72_000, samples: 36_000, monoNS: 5_200_000_000,
        wallNS: 1_104_200_000_000, device: "ver04-fixture", discontinuity: "resumed",
        gapNS: 3_000_000_000),
      IndexRecord(
        byteOffset: 72_000, samples: 36_000, monoNS: 5_300_000_000,
        wallNS: 1_104_300_000_000, device: "ver04-fixture", rms: 0,
        inputFrames: 0, inputSampleRate: 48_000),
      IndexRecord(
        byteOffset: 104_000, samples: 52_000, monoNS: 6_300_000_000,
        wallNS: 1_105_300_000_000, device: "ver04-fixture", rms: 0.1,
        inputFrames: 48_000, inputSampleRate: 48_000),
      IndexRecord(
        byteOffset: 104_000, samples: 52_000, monoNS: 6_400_000_000,
        wallNS: 1_105_900_000_000, device: "ver04-fixture", discontinuity: "clock_jump",
        gapNS: 500_000_000),
      IndexRecord(
        byteOffset: 104_000, samples: 52_000, monoNS: 6_500_000_000,
        wallNS: 1_106_000_000_000, device: "ver04-fixture", rms: 0,
        inputFrames: 0, inputSampleRate: 48_000),
      IndexRecord(
        byteOffset: 136_000, samples: 68_000, monoNS: 7_500_000_000,
        wallNS: 1_107_000_000_000, device: "ver04-fixture", rms: 0.1,
        inputFrames: 48_000, inputSampleRate: 48_000),
      IndexRecord(
        byteOffset: 136_000, samples: 68_000, monoNS: 7_600_000_000,
        wallNS: 1_107_100_000_000, device: "ver04-fixture", discontinuity: "format_change"),
      IndexRecord(
        byteOffset: 136_000, samples: 68_000, monoNS: 7_700_000_000,
        wallNS: 1_107_200_000_000, device: "ver04-fixture", rms: 0,
        inputFrames: 0, inputSampleRate: 44_100),
      IndexRecord(
        byteOffset: 168_000, samples: 84_000, monoNS: 8_700_000_000,
        wallNS: 1_108_200_000_000, device: "ver04-fixture", rms: 0.1,
        inputFrames: 44_100, inputSampleRate: 44_100),
      IndexRecord(
        byteOffset: 168_000, samples: 84_000, monoNS: 8_800_000_000,
        wallNS: 1_108_300_000_000, device: "ver04-fixture", discontinuity: "ring_overflow",
        droppedInputFrames: 16),
      IndexRecord(
        byteOffset: 168_000, samples: 84_000, monoNS: 8_900_000_000,
        wallNS: 1_108_400_000_000, device: "ver04-fixture", rms: 0,
        inputFrames: 0, inputSampleRate: 44_100),
      IndexRecord(
        byteOffset: 200_000, samples: 100_000, monoNS: 9_900_000_000,
        wallNS: 1_109_400_000_000, device: "ver04-fixture", rms: 0.1,
        inputFrames: 44_100, inputSampleRate: 44_100),
    ]
    let expectedKinds = [
      "restart", "device_lost", "resumed", "clock_jump", "format_change", "ring_overflow",
    ]
    let expectedCheckpointIndices = [1, 2, 4, 5, 8, 9, 11, 12, 14, 15, 17, 18]

    let report = try TapeVerifier.verify(pcmSize: 200_000, records: records)
    let renderedDiscontinuities = report.rendered().split(separator: "\n").filter { line in
      expectedKinds.contains { line.hasPrefix("  \($0):") }
    }

    #expect(report.discontinuities.map(\.kind) == expectedKinds)
    #expect(report.discontinuities.first?.monoNS == 1_000_000_000)
    #expect(report.discontinuities.first!.monoNS < records[1].monoNS)
    #expect(report.driftRecords.map(\.index) == expectedCheckpointIndices)
    #expect(report.driftRecords.allSatisfy { abs($0.driftMS) < 0.000_1 })
    #expect(abs(report.fittedPPM ?? 1) < 0.001)
    #expect(report.nativeDriftRecords.map(\.index) == expectedCheckpointIndices)
    #expect(report.nativeDriftRecords.allSatisfy { abs($0.driftMS) < 0.000_1 })
    #expect(abs(report.fittedNativePPM ?? 1) < 0.001)
    #expect(renderedDiscontinuities.count == expectedKinds.count)
    #expect(
      zip(renderedDiscontinuities, expectedKinds).allSatisfy { line, kind in
        line.hasPrefix("  \(kind):")
      })
    #expect(!report.passed)
  }

  @Test func ver05WallJumpsDoNotContaminateMonotonicOrNativeDrift() throws {
    func report(
      firstWallNS: UInt64,
      secondWallNS: UInt64,
      jumpWallNS: UInt64,
      postJumpWallNS: UInt64,
      lastWallNS: UInt64
    ) throws -> VerificationReport {
      try TapeVerifier.verify(
        pcmSize: 128_000,
        records: [
          IndexRecord(
            byteOffset: 0, samples: 0, monoNS: 1_000_000_000, wallNS: firstWallNS,
            device: "ver05-fixture", rms: 0, inputFrames: 0, inputSampleRate: 48_000),
          IndexRecord(
            byteOffset: 64_000, samples: 32_000, monoNS: 3_000_000_000,
            wallNS: secondWallNS, device: "ver05-fixture", rms: 0.1,
            inputFrames: 96_000, inputSampleRate: 48_000),
          IndexRecord(
            byteOffset: 64_000, samples: 32_000, monoNS: 3_100_000_000,
            wallNS: jumpWallNS, device: "ver05-fixture", discontinuity: "clock_jump",
            gapNS: 100_000_000_000),
          IndexRecord(
            byteOffset: 64_000, samples: 32_000, monoNS: 3_200_000_000,
            wallNS: postJumpWallNS, device: "ver05-fixture", rms: 0,
            inputFrames: 0, inputSampleRate: 48_000),
          IndexRecord(
            byteOffset: 128_000, samples: 64_000, monoNS: 5_200_000_000,
            wallNS: lastWallNS, device: "ver05-fixture", rms: 0.1,
            inputFrames: 96_000, inputSampleRate: 48_000),
        ])
    }

    let forward = try report(
      firstWallNS: 10_000_000_000,
      secondWallNS: 12_000_000_000,
      jumpWallNS: 112_100_000_000,
      postJumpWallNS: 112_200_000_000,
      lastWallNS: 114_200_000_000
    )
    let backward = try report(
      firstWallNS: 100_000_000_000,
      secondWallNS: 102_000_000_000,
      jumpWallNS: 2_100_000_000,
      postJumpWallNS: 2_200_000_000,
      lastWallNS: 4_200_000_000
    )

    for fixture in [forward, backward] {
      #expect(fixture.discontinuities.map(\.kind) == ["clock_jump"])
      #expect(fixture.driftRecords.map(\.driftMS).allSatisfy { abs($0) < 0.000_1 })
      #expect(abs(fixture.fittedPPM ?? 1) < 0.001)
      #expect(fixture.nativeDriftRecords.map(\.driftMS).allSatisfy { abs($0) < 0.000_1 })
      #expect(abs(fixture.fittedNativePPM ?? 1) < 0.001)
      #expect(fixture.rendered().contains("clock adjustment 100.000 s"))
    }
    #expect(abs((forward.wallSpanSeconds ?? 0) - 104.2) < 0.000_000_1)
    #expect(abs((forward.sampleWallDifferenceSeconds ?? 0) + 100.2) < 0.000_000_1)
    #expect(backward.wallSpanSeconds == nil)
    #expect(backward.sampleWallDifferenceSeconds == nil)
    #expect(backward.rendered().contains("Wall-clock span: unavailable"))
  }

  @Test func ver06TapeNativeAndConverterAccountingRemainIndependent() throws {
    let records = [
      IndexRecord(
        byteOffset: 0, samples: 0, monoNS: 1, wallNS: 1, device: "ver06-fixture", rms: 0,
        inputFrames: 0, inputSampleRate: 48_000),
      IndexRecord(
        byteOffset: 31_980, samples: 15_990, monoNS: 1_000_000_001,
        wallNS: 1_000_000_001, device: "ver06-fixture", rms: 0.1,
        inputFrames: 48_000, inputSampleRate: 48_000),
      IndexRecord(
        byteOffset: 64_028, samples: 32_014, monoNS: 2_000_000_001,
        wallNS: 2_000_000_001, device: "ver06-fixture", rms: 0.1,
        inputFrames: 96_024, inputSampleRate: 48_000),
    ]

    let report = try TapeVerifier.verify(pcmSize: 64_028, records: records)

    #expect(report.driftRecords.map(\.driftMS).count == 3)
    #expect(abs(report.driftRecords[1].driftMS + 0.625) < 0.000_1)
    #expect(abs(report.driftRecords[2].driftMS - 0.875) < 0.000_1)
    #expect(abs((report.fittedPPM ?? 0) - 225) < 0.001)
    #expect(abs(report.nativeDriftRecords[1].driftMS) < 0.000_1)
    #expect(abs(report.nativeDriftRecords[2].driftMS - 0.5) < 0.000_1)
    #expect(abs((report.fittedNativePPM ?? 0) - 200) < 0.001)
    #expect(report.converterAccountingRecords.map(\.sampleDifference) == [0, -10, 6])
    #expect(report.largestConverterDifferenceSamples == -10)
    #expect(report.passed)
  }

  @Test func ver07CheckpointCadenceExcludesDowntimeWhileDurableCadenceExposesIt() throws {
    let records = [
      IndexRecord(
        byteOffset: 0, samples: 0, monoNS: 1_000_000_000, wallNS: 11_000_000_000,
        device: "ver07-fixture", rms: 0),
      IndexRecord(
        byteOffset: 40_000, samples: 20_000, monoNS: 2_250_000_000,
        wallNS: 12_250_000_000, device: "ver07-fixture", rms: 0.1),
      IndexRecord(
        byteOffset: 40_000, samples: 20_000, monoNS: 3_000_000_000,
        wallNS: 13_000_000_000, device: "ver07-fixture", discontinuity: "device_lost"),
      IndexRecord(
        byteOffset: 40_000, samples: 20_000, monoNS: 8_000_000_000,
        wallNS: 18_000_000_000, device: "ver07-fixture", discontinuity: "resumed",
        gapNS: 5_000_000_000),
      IndexRecord(
        byteOffset: 40_000, samples: 20_000, monoNS: 8_100_000_000,
        wallNS: 18_100_000_000, device: "ver07-fixture", rms: 0),
      IndexRecord(
        byteOffset: 88_000, samples: 44_000, monoNS: 9_600_000_000,
        wallNS: 19_600_000_000, device: "ver07-fixture", rms: 0.1),
      IndexRecord(
        byteOffset: 96_000, samples: 48_000, monoNS: 20_000_000_000,
        wallNS: 30_000_000_000, device: "ver07-fixture", discontinuity: "restart",
        previousByteOffset: 88_000, survivingTailBytes: 8_000),
      IndexRecord(
        byteOffset: 96_000, samples: 48_000, monoNS: 20_100_000_000,
        wallNS: 30_100_000_000, device: "ver07-fixture", rms: 0),
      IndexRecord(
        byteOffset: 136_000, samples: 68_000, monoNS: 21_350_000_000,
        wallNS: 31_350_000_000, device: "ver07-fixture", rms: 0.1),
    ]

    let report = try TapeVerifier.verify(pcmSize: 136_000, records: records)

    #expect(report.largestCheckpointGapSeconds == 1.5)
    #expect(abs((report.largestDurableRecordGapSeconds ?? 0) - 10.4) < 0.000_000_1)
    #expect(report.largestDurableRecordGapSeconds! > report.largestCheckpointGapSeconds!)
    #expect(report.rendered().contains("Largest checkpoint gap: 1.500000 s"))
    #expect(report.rendered().contains("Largest adjacent durable-record gap: 10.400000 s"))
    #expect(report.passed)
  }

  @Test func ver08RenderedReportIsVerbatimStable() throws {
    let records = [
      IndexRecord(
        byteOffset: 0, samples: 0, monoNS: 10_000_000_000, wallNS: 100_000_000_000,
        device: "ver08-fixture", rms: 0),
      IndexRecord(
        byteOffset: 32_000, samples: 16_000, monoNS: 11_000_000_000,
        wallNS: 101_000_000_000, device: "ver08-fixture", rms: 0.25),
      IndexRecord(
        byteOffset: 64_000, samples: 32_000, monoNS: 1_000_000_000,
        wallNS: 102_000_000_000, device: "ver08-fixture", discontinuity: "restart",
        previousByteOffset: 32_000, survivingTailBytes: 32_000),
      IndexRecord(
        byteOffset: 64_000, samples: 32_000, monoNS: 2_000_000_000,
        wallNS: 5_000_000_000, device: "ver08-fixture", discontinuity: "clock_jump",
        gapNS: 97_000_000_000),
    ]
    let report = try TapeVerifier.verify(
      pcmSize: 144_002,
      records: records,
      discardedTrailingIndexBytes: 17
    )

    let expected = """
      Tape verification
      Total samples: 72001
      Sample duration: 4.500063 s
      Wall-clock span: unavailable
      Sample minus wall: unavailable
      Per-record durable tape drift:
        record 1: 0.000 ms, baseline
        record 2: 0.000 ms, 0.000 ppm
      Fitted durable tape drift: 0.000 ppm
      Largest durable tape step anomaly: 0.000 ms
      Per-record native input-clock drift:
        unavailable
      Fitted native input-clock drift: unavailable
      Native drift per five-minute piece: unavailable
      Largest native input step anomaly: unavailable
      Native-to-tape converter accounting:
        unavailable
      Largest converter difference: unavailable
      Largest checkpoint gap: 1.000000 s
      Largest adjacent durable-record gap: 1.000000 s
      Discontinuities:
        restart: mono_ns=1000000000, wall_ns=102000000000, surviving crash tail 32000 bytes (1.000000 s)
        clock_jump: mono_ns=2000000000, wall_ns=5000000000, clock adjustment 97.000 s
      Current unindexed tail: 80002 bytes (2.500062 s)
      Worst surviving crash tail: 80002 bytes (2.500062 s)
      Crash-loss scope: surviving unindexed PCM; power-cut disappearance requires external timing and listening evidence
      Ignored incomplete index suffix: 17 bytes
      VERDICT: FAIL
      """

    #expect(report.rendered() == expected)
  }

  @Test func historicalRestartTailControlsVerdict() throws {
    let historical = Int64(96_000)
    let records = [
      IndexRecord(byteOffset: 128_000, samples: 64_000, monoNS: 1, wallNS: 1),
      IndexRecord(
        byteOffset: 224_000,
        samples: 112_000,
        monoNS: 2,
        wallNS: 2,
        discontinuity: "restart",
        previousByteOffset: 128_000,
        survivingTailBytes: historical
      ),
      IndexRecord(byteOffset: 224_000, samples: 112_000, monoNS: 3, wallNS: 3),
    ]

    let report = try TapeVerifier.verify(pcmSize: 224_000, records: records)

    #expect(report.currentTailBytes == 0)
    #expect(report.worstTailBytes == historical)
    #expect(!report.passed)
  }

  @Test func rejectsOddPCMSize() {
    #expect(throws: TapeError.oddPCMSize(3)) {
      try TapeVerifier.verify(pcmSize: 3, records: [])
    }
  }

  @Test func reportsTapeAndNativeDriftSeparately() throws {
    let records = [
      IndexRecord(
        byteOffset: 0,
        samples: 0,
        monoNS: 1,
        wallNS: 1,
        inputFrames: 0,
        inputSampleRate: 48_000
      ),
      IndexRecord(
        byteOffset: 63_680,
        samples: 31_840,
        monoNS: 2_000_000_001,
        wallNS: 2_000_000_001,
        inputFrames: 96_000,
        inputSampleRate: 48_000
      ),
    ]

    let report = try TapeVerifier.verify(pcmSize: 63_680, records: records)

    #expect(abs(report.driftRecords[1].driftMS + 10) < 0.000_1)
    #expect(abs(report.nativeDriftRecords[1].driftMS) < 0.000_1)
    #expect(report.converterAccountingRecords[1].sampleDifference == -160)
    #expect(report.rendered().contains("Native drift per five-minute piece: 0.000 ms"))
  }

  @Test func failsForDelayedCheckpointOrRingOverflow() throws {
    let delayed = try TapeVerifier.verify(
      pcmSize: 128_000,
      records: [
        IndexRecord(byteOffset: 0, samples: 0, monoNS: 1, wallNS: 1),
        IndexRecord(
          byteOffset: 128_000,
          samples: 64_000,
          monoNS: 4_000_000_001,
          wallNS: 4_000_000_001
        ),
      ])
    #expect(delayed.largestCheckpointGapSeconds == 4)
    #expect(!delayed.passed)

    let overflow = try TapeVerifier.verify(
      pcmSize: 0,
      records: [
        IndexRecord(byteOffset: 0, samples: 0, monoNS: 1, wallNS: 1),
        IndexRecord(
          byteOffset: 0,
          samples: 0,
          monoNS: 2,
          wallNS: 2,
          discontinuity: "ring_overflow",
          droppedInputFrames: 4
        ),
      ])
    #expect(!overflow.passed)
  }

  @Test func rejectsOutOfRangeConverterAccounting() {
    let records = [
      IndexRecord(
        byteOffset: 0,
        samples: 0,
        monoNS: 1,
        wallNS: 1,
        inputFrames: 0,
        inputSampleRate: Double.leastNonzeroMagnitude
      ),
      IndexRecord(
        byteOffset: 0,
        samples: 0,
        monoNS: 2,
        wallNS: 2,
        inputFrames: Int64.max,
        inputSampleRate: Double.leastNonzeroMagnitude
      ),
    ]

    #expect(
      throws: TapeError.invalidIndex(
        line: 2, detail: "converter sample accounting is out of range")
    ) {
      try TapeVerifier.verify(pcmSize: 0, records: records)
    }
  }

  @Test func verifiesThroughProductionIndexParser() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let indexURL = directory.appendingPathComponent("tape.idx")
    try Data(repeating: 0, count: 64_000).write(to: pcmURL)
    var index = try IndexLog.encodedLine(
      IndexRecord(
        byteOffset: 0,
        samples: 0,
        monoNS: 1,
        wallNS: 1,
        device: "fixture",
        rms: 0
      ))
    index.append(
      try IndexLog.encodedLine(
        IndexRecord(
          byteOffset: 64_000,
          samples: 32_000,
          monoNS: 2_000_000_001,
          wallNS: 2_000_000_001,
          device: "fixture",
          rms: 0.25
        )))
    try index.write(to: indexURL)

    let report = try TapeVerifier.verify(directory: directory)

    #expect(report.totalSamples == 32_000)
    #expect(report.currentTailBytes == 0)
    #expect(report.passed)
  }
}
