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
