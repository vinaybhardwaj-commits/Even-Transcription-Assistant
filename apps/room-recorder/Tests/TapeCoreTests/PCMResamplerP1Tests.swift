import Foundation
import Testing

@testable import TapeCapture
@testable import TapeCore

@Suite struct PCMResamplerP1Tests {
  @Test func src01DeterministicRateMatrixUsesProductionCapacityAndPartitions() throws {
    #expect(TapeConstants.sampleRate == 16_000)
    #expect(TapeConstants.channels == 1)
    #expect(TapeConstants.bitsPerSample == 16)

    for rate in sourceRates {
      let denominator = rate / greatestCommonDivisor(rate, Int64(TapeConstants.sampleRate))
      for residue in [0, 1, denominator - 1] {
        let totalInputFrames = rate * 2 + residue
        var partitionIndependentCount: Int64?
        var partitionIndependentDigest: UInt64?
        for seed in partitionSeeds {
          let metrics = try runPartitionedConversion(
            rate: rate,
            totalInputFrames: totalInputFrames,
            seed: seed
          )
          let expected = rationallyRoundedOutputFrames(totalInputFrames, rate: rate)

          #expect(abs(metrics.finalDifference) <= candidateFinalBound)
          #expect(metrics.outputFrames == expected + metrics.finalDifference)
          #expect(metrics.energy > 0)
          #expect(metrics.digest != digestOffsetBasis)
          if let partitionIndependentCount {
            #expect(metrics.outputFrames == partitionIndependentCount)
          } else {
            partitionIndependentCount = metrics.outputFrames
          }
          if let partitionIndependentDigest {
            #expect(metrics.digest == partitionIndependentDigest)
          } else {
            partitionIndependentDigest = metrics.digest
          }
          printMetrics("SRC-01", rate: rate, seed: seed, metrics: metrics)
        }
      }
    }
  }

  @Test func src02FreshConvertersCoverEveryShortLengthAndProductionEdge() throws {
    let lengths = Array(1...512) + [4_095, 4_096, 4_097, 8_191, 8_192]
    for rate in sourceRates {
      var largestIntermediateDifference: Int64 = 0
      var largestFinalDifference: Int64 = 0
      var largestPreFinishBacklog: Int64 = 0
      for length in lengths {
        let metrics = try autoreleasepool {
          let samples = toneSamples(startFrame: 0, count: length)
          return try runWholeConversion(samples: samples, rate: rate)
        }
        let expected = rationallyRoundedOutputFrames(Int64(length), rate: rate)
        let preFinishBacklog = expected - metrics.preFinishOutputFrames

        retainLargestSigned(
          metrics.maximumIntermediateDifference, in: &largestIntermediateDifference)
        retainLargestSigned(metrics.finalDifference, in: &largestFinalDifference)
        retainLargestSigned(preFinishBacklog, in: &largestPreFinishBacklog)
        #expect(metrics.outputFrames == expected + metrics.finalDifference)
        #expect(abs(metrics.finalDifference) <= candidateFinalBound)
      }
      print(
        "SRC-02 rate=\(rate) lengths=\(lengths.count) maxIntermediate=\(largestIntermediateDifference) "
          + "maxBacklog=\(largestPreFinishBacklog) maxFinal=\(largestFinalDifference)"
      )
    }
  }

  @Test func src02ZeroInputIsDeterministicAndExplicitlyRejected() throws {
    for rate in sourceRates {
      let outcomes = try (0..<2).map { _ in try zeroInputOutcome(rate: rate) }
      #expect(outcomes[0] == outcomes[1])
      #expect(outcomes[0].hasPrefix("rejected:"))
      print("SRC-02 zero rate=\(rate) outcome=\(outcomes[0])")
    }
  }

  @Test func src02DefaultCapacityRejectsOneFrameOver() throws {
    let samples = [Float](repeating: 0.25, count: 65_537)
    for rate in sourceRates {
      let converter = try PCMResampler(inputSampleRate: Double(rate))
      var errorMessage: String?
      do {
        try samples.withUnsafeBufferPointer { buffer in
          try converter.convert(samples: buffer.baseAddress!, frameCount: buffer.count) { _, _ in }
        }
      } catch {
        errorMessage = error.localizedDescription
      }
      #expect(errorMessage == "native input block exceeds converter capacity")
    }
  }

  @Test func src02FinishRetainsAModerateTerminalSuffix() throws {
    let prefixLength = 4_096
    let suffixLength = 512
    for rate in sourceRates {
      let silent = [Float](repeating: 0, count: prefixLength + suffixLength)
      var terminal = silent
      for index in prefixLength..<terminal.count {
        let phase = 2 * Double.pi * Double(index - prefixLength) / 32
        terminal[index] = Float(0.3 * sin(phase))
      }

      let silentMetrics = try runWholeConversion(samples: silent, rate: rate)
      let terminalMetrics = try runWholeConversion(samples: terminal, rate: rate)
      #expect(silentMetrics.energy == 0)
      #expect(terminalMetrics.energy > 0)
      #expect(terminalMetrics.outputFrames == silentMetrics.outputFrames)
      #expect(abs(terminalMetrics.finalDifference) <= candidateFinalBound)
      #expect(
        terminalMetrics.preFinishOutputFrames + terminalMetrics.finishOutputFrames
          == terminalMetrics.outputFrames)
      printMetrics("SRC-02-suffix", rate: rate, seed: 0, metrics: terminalMetrics)
    }
  }

  @Test func src02RepresentativeWriterStopsIncludeFlushedOutput() throws {
    for rate in sourceRates {
      let directory = try temporaryDirectory()
      defer { try? FileManager.default.removeItem(at: directory) }
      let frameCount = 8_192
      let ring = AudioRing(slotCount: 6, framesPerSlot: frameCount)
      let writer = TapeWriter(directory: directory, deviceUID: "src02-fixture", ring: ring)
      try writer.startAndWaitUntilReady()

      var samples = toneSamples(startFrame: 0, count: frameCount)
      let accepted = samples.withUnsafeMutableBufferPointer { buffer in
        var channel = buffer.baseAddress!
        return withUnsafePointer(to: &channel) { channels in
          ring.writeAudio(
            channels: channels,
            channelCount: 1,
            frameCount: frameCount,
            sampleRate: Double(rate),
            monoStartNS: 1_000_000_000,
            monoEndNS: 1_000_000_000
              + UInt64((Double(frameCount) / Double(rate) * 1_000_000_000).rounded()),
            wallStartNS: 11_000_000_000,
            wallEndNS: 11_000_000_000
              + UInt64((Double(frameCount) / Double(rate) * 1_000_000_000).rounded()),
            boundaries: BoundaryBatch()
          )
        }
      }
      try #require(accepted)
      try writer.stopAndWait()

      let pcmURL = directory.appendingPathComponent("tape.pcm")
      let pcmSize = try #require(
        (try FileManager.default.attributesOfItem(atPath: pcmURL.path)[.size] as? NSNumber)?
          .int64Value)
      let records = try IndexLog.read(
        url: directory.appendingPathComponent("tape.idx"), pcmSize: pcmSize
      ).records
      let finalCheckpoint = try #require(records.last { $0.discontinuity == nil })
      let stopped = try #require(records.last)
      let expected = rationallyRoundedOutputFrames(Int64(frameCount), rate: rate)
      let report = try TapeVerifier.verify(directory: directory)

      #expect(stopped.discontinuity == "stopped")
      #expect(finalCheckpoint.samples == stopped.samples)
      #expect(finalCheckpoint.inputFrames == Int64(frameCount))
      #expect(stopped.inputFrames == Int64(frameCount))
      #expect(finalCheckpoint.inputSampleRate == Double(rate))
      #expect(abs((finalCheckpoint.samples ?? 0) - expected) <= candidateFinalBound)
      #expect(
        abs(report.converterAccountingRecords.last?.sampleDifference ?? 13) <= candidateFinalBound)
      #expect(report.totalSamples == finalCheckpoint.samples)
      #expect(report.currentTailBytes == 0)
      #expect(report.passed)
    }
  }

  @Test func src03RoutineFiniteConverterStability() throws {
    for rate in sourceRates {
      let totalInputFrames = rate * 5 + rate / 7 + 1
      var partitionIndependentCount: Int64?
      for seed in stabilitySeeds {
        let metrics = try runPartitionedConversion(
          rate: rate,
          totalInputFrames: totalInputFrames,
          seed: seed
        )
        #expect(abs(metrics.finalDifference) <= candidateFinalBound)
        #expect(abs(metrics.maximumIntermediateDifference) <= intermediateDifferenceBound(rate))
        #expect(metrics.energy > 0)
        if let partitionIndependentCount {
          #expect(metrics.outputFrames == partitionIndependentCount)
        } else {
          partitionIndependentCount = metrics.outputFrames
        }
        printMetrics("SRC-03-routine", rate: rate, seed: seed, metrics: metrics)
      }
    }
  }

  @Test func src03TwentyFourHourAccountingRoundTripsThroughIndexAndVerifier() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let indexURL = directory.appendingPathComponent("tape.idx")
    let segmentSeconds: Int64 = 6 * 60 * 60
    let checkpointSeconds: Int64 = 5 * 60
    let differences: [Int64] = [-11, -12, -10, -9, -12, -11, -10]
    var records: [IndexRecord] = []
    var indexData = Data()
    var cumulativeInputFrames: Int64 = 0
    var outputFrames: Int64 = 0

    for (segmentIndex, rate) in sourceRates.enumerated() {
      let segmentStartSeconds = Int64(segmentIndex) * segmentSeconds
      let monoBase = UInt64(1 + segmentStartSeconds) * 1_000_000_000
      let wallBase = monoBase + 100_000_000_000
      if segmentIndex > 0 {
        records.append(
          IndexRecord(
            byteOffset: outputFrames * TapeConstants.bytesPerSample,
            samples: outputFrames,
            monoNS: monoBase,
            wallNS: wallBase,
            device: "src03-fixture",
            discontinuity: "format_change",
            inputFrames: cumulativeInputFrames,
            inputSampleRate: Double(sourceRates[segmentIndex - 1])
          ))
      }
      let segmentInputBase = cumulativeInputFrames
      let segmentOutputBase = outputFrames
      records.append(
        IndexRecord(
          byteOffset: outputFrames * TapeConstants.bytesPerSample,
          samples: outputFrames,
          monoNS: monoBase,
          wallNS: wallBase,
          device: "src03-fixture",
          rms: 0.125,
          inputFrames: cumulativeInputFrames,
          inputSampleRate: Double(rate)
        ))

      var elapsedSeconds = checkpointSeconds
      while elapsedSeconds <= segmentSeconds {
        let segmentInputFrames = rate * elapsedSeconds
        let expected = rationallyRoundedOutputFrames(segmentInputFrames, rate: rate)
        let checkpointIndex = Int(elapsedSeconds / checkpointSeconds) - 1
        let difference = differences[checkpointIndex % differences.count]
        outputFrames = segmentOutputBase + expected + difference
        cumulativeInputFrames = segmentInputBase + segmentInputFrames
        records.append(
          IndexRecord(
            byteOffset: outputFrames * TapeConstants.bytesPerSample,
            samples: outputFrames,
            monoNS: monoBase + UInt64(elapsedSeconds) * 1_000_000_000,
            wallNS: wallBase + UInt64(elapsedSeconds) * 1_000_000_000,
            device: "src03-fixture",
            rms: 0.125,
            inputFrames: cumulativeInputFrames,
            inputSampleRate: Double(rate)
          ))
        elapsedSeconds += checkpointSeconds
      }
    }

    for record in records { indexData.append(try IndexLog.encodedLine(record)) }
    try indexData.write(to: indexURL)
    let pcmSize = outputFrames * TapeConstants.bytesPerSample
    let parsed = try IndexLog.read(url: indexURL, pcmSize: pcmSize)
    let report = try TapeVerifier.verify(pcmSize: pcmSize, records: parsed.records)
    let observedDifferences = report.converterAccountingRecords.map(\.sampleDifference)

    #expect(parsed.records == records)
    #expect(parsed.discardedTrailingBytes == 0)
    #expect(report.totalSamples == outputFrames)
    #expect(report.currentTailBytes == 0)
    #expect(
      report.discontinuities.map(\.kind) == ["format_change", "format_change", "format_change"])
    #expect(abs(report.largestConverterDifferenceSamples ?? 13) <= candidateFinalBound)
    #expect(Set(observedDifferences).count > 2)
    #expect(observedDifferences.allSatisfy { abs($0) <= candidateFinalBound })
    #expect(report.largestCheckpointGapSeconds == Double(checkpointSeconds))
    print(
      "SRC-03-index hours=24 records=\(records.count) samples=\(outputFrames) "
        + "maxDifference=\(report.largestConverterDifferenceSamples ?? 0)"
    )
  }

  @Test(
    .enabled(
      if: ProcessInfo.processInfo.environment["ETA_SRC03_SOAK"] == "1",
      "Set ETA_SRC03_SOAK=1 to run the accelerated real-converter acceptance soak."
    )
  )
  func src03AcceleratedTwentyFourHourEquivalentRealConverterSoak() throws {
    for rate in sourceRates {
      let converter = try PCMResampler(inputSampleRate: Double(rate))
      let totalInputFrames = rate * 24 * 60 * 60
      let input = toneSamples(startFrame: 0, count: maximumOrdinaryBlockFrames)
      var inputFrames: Int64 = 0
      var metrics = StreamMetrics()
      let started = Date()

      while inputFrames < totalInputFrames {
        let frameCount = Int(
          min(Int64(maximumOrdinaryBlockFrames), totalInputFrames - inputFrames))
        try input.withUnsafeBufferPointer { buffer in
          try converter.convert(samples: buffer.baseAddress!, frameCount: frameCount) {
            output, count in
            metrics.consume(output, count: count)
          }
        }
        inputFrames += Int64(frameCount)
        metrics.observeIntermediate(
          actual: metrics.outputFrames,
          expected: rationallyRoundedOutputFrames(inputFrames, rate: rate)
        )
      }
      metrics.preFinishOutputFrames = metrics.outputFrames
      try converter.finish { output, count in metrics.consume(output, count: count) }
      metrics.finishOutputFrames = metrics.outputFrames - metrics.preFinishOutputFrames
      metrics.inputFrames = inputFrames
      metrics.expectedOutputFrames = rationallyRoundedOutputFrames(totalInputFrames, rate: rate)
      metrics.finalDifference =
        metrics.outputFrames - metrics.expectedOutputFrames

      #expect(inputFrames == totalInputFrames)
      #expect(abs(metrics.finalDifference) <= candidateFinalBound)
      #expect(abs(metrics.maximumIntermediateDifference) <= intermediateDifferenceBound(rate))
      #expect(metrics.energy > 0)
      print(
        String(
          format:
            "SRC-03-soak rate=%lld native=%lld output=%lld expected=%lld maxIntermediate=%lld final=%lld finish=%lld digest=%016llx seconds=%.3f",
          rate,
          inputFrames,
          metrics.outputFrames,
          rationallyRoundedOutputFrames(totalInputFrames, rate: rate),
          metrics.maximumIntermediateDifference,
          metrics.finalDifference,
          metrics.finishOutputFrames,
          metrics.digest,
          Date().timeIntervalSince(started)
        ))
    }
  }
}

private let sourceRates: [Int64] = [44_100, 48_000, 96_000, 192_000]
private let partitionSeeds: [UInt64] = [0x01, 0x5EED, 0xC0FFEE]
private let stabilitySeeds: [UInt64] = [0x03, 0xBAD5EED, 0x1234_5678]
private let maximumOrdinaryBlockFrames = 8_192
private let candidateFinalBound: Int64 = 12
private let digestOffsetBasis: UInt64 = 1_469_598_103_934_665_603

private struct StreamMetrics {
  var inputFrames: Int64 = 0
  var outputFrames: Int64 = 0
  var expectedOutputFrames: Int64 = 0
  var preFinishOutputFrames: Int64 = 0
  var finishOutputFrames: Int64 = 0
  var maximumIntermediateDifference: Int64 = 0
  var finalDifference: Int64 = 0
  var energy: UInt64 = 0
  var digest = digestOffsetBasis

  mutating func consume(_ output: UnsafePointer<Int16>, count: Int) {
    outputFrames += Int64(count)
    for index in 0..<count {
      let sample = output[index]
      let wideSample = Int64(sample)
      energy += UInt64(wideSample * wideSample)
      digest ^= UInt64(UInt16(bitPattern: sample))
      digest &*= 1_099_511_628_211
    }
  }

  mutating func observeIntermediate(actual: Int64, expected: Int64) {
    retainLargestSigned(actual - expected, in: &maximumIntermediateDifference)
  }
}

private struct SplitMix64 {
  private var state: UInt64

  init(seed: UInt64) { state = seed }

  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var value = state
    value = (value ^ (value >> 30)) &* 0xBF58_476D_1CE4_E5B9
    value = (value ^ (value >> 27)) &* 0x94D0_49BB_1331_11EB
    return value ^ (value >> 31)
  }

  mutating func nextBlock(maximum: Int) -> Int {
    Int(next() % UInt64(maximum)) + 1
  }
}

private func runPartitionedConversion(
  rate: Int64,
  totalInputFrames: Int64,
  seed: UInt64
) throws -> StreamMetrics {
  let converter = try PCMResampler(inputSampleRate: Double(rate))
  var input = [Float](repeating: 0, count: maximumOrdinaryBlockFrames)
  var random = SplitMix64(seed: seed)
  var inputFrames: Int64 = 0
  var metrics = StreamMetrics()

  while inputFrames < totalInputFrames {
    let frameCount = min(
      random.nextBlock(maximum: maximumOrdinaryBlockFrames),
      Int(totalInputFrames - inputFrames)
    )
    fillTone(&input, startFrame: inputFrames, count: frameCount)
    try input.withUnsafeBufferPointer { buffer in
      try converter.convert(samples: buffer.baseAddress!, frameCount: frameCount) { output, count in
        metrics.consume(output, count: count)
      }
    }
    inputFrames += Int64(frameCount)
    metrics.observeIntermediate(
      actual: metrics.outputFrames,
      expected: rationallyRoundedOutputFrames(inputFrames, rate: rate)
    )
  }
  metrics.preFinishOutputFrames = metrics.outputFrames
  try converter.finish { output, count in metrics.consume(output, count: count) }
  metrics.finishOutputFrames = metrics.outputFrames - metrics.preFinishOutputFrames
  metrics.inputFrames = inputFrames
  metrics.expectedOutputFrames = rationallyRoundedOutputFrames(totalInputFrames, rate: rate)
  metrics.finalDifference =
    metrics.outputFrames - metrics.expectedOutputFrames
  return metrics
}

private func runWholeConversion(samples: [Float], rate: Int64) throws -> StreamMetrics {
  let converter = try PCMResampler(inputSampleRate: Double(rate))
  var metrics = StreamMetrics()
  try samples.withUnsafeBufferPointer { buffer in
    try converter.convert(samples: buffer.baseAddress!, frameCount: buffer.count) { output, count in
      metrics.consume(output, count: count)
    }
  }
  metrics.observeIntermediate(
    actual: metrics.outputFrames,
    expected: rationallyRoundedOutputFrames(Int64(samples.count), rate: rate)
  )
  metrics.preFinishOutputFrames = metrics.outputFrames
  try converter.finish { output, count in metrics.consume(output, count: count) }
  metrics.finishOutputFrames = metrics.outputFrames - metrics.preFinishOutputFrames
  metrics.inputFrames = Int64(samples.count)
  metrics.expectedOutputFrames = rationallyRoundedOutputFrames(Int64(samples.count), rate: rate)
  metrics.finalDifference =
    metrics.outputFrames - metrics.expectedOutputFrames
  return metrics
}

private func zeroInputOutcome(rate: Int64) throws -> String {
  let converter = try PCMResampler(inputSampleRate: Double(rate))
  var sample: Float = 0
  var metrics = StreamMetrics()
  do {
    try withUnsafePointer(to: &sample) { pointer in
      try converter.convert(samples: pointer, frameCount: 0) { output, count in
        metrics.consume(output, count: count)
      }
    }
    metrics.preFinishOutputFrames = metrics.outputFrames
    try converter.finish { output, count in metrics.consume(output, count: count) }
    return "accepted:pre=\(metrics.preFinishOutputFrames),final=\(metrics.outputFrames)"
  } catch {
    return "rejected:\(error.localizedDescription)"
  }
}

private func toneSamples(startFrame: Int64, count: Int) -> [Float] {
  var samples = [Float](repeating: 0, count: count)
  fillTone(&samples, startFrame: startFrame, count: count)
  return samples
}

private func fillTone(_ samples: inout [Float], startFrame: Int64, count: Int) {
  for index in 0..<count {
    let phaseFrame = Double((startFrame + Int64(index)) % Int64(maximumOrdinaryBlockFrames))
    let phase = 2 * Double.pi * phaseFrame / Double(maximumOrdinaryBlockFrames)
    samples[index] = Float(0.12 * sin(37 * phase) + 0.05 * sin(83 * phase))
  }
}

private func rationallyRoundedOutputFrames(_ inputFrames: Int64, rate: Int64) -> Int64 {
  let outputRate = Int64(TapeConstants.sampleRate)
  let wholeOutput = (inputFrames / rate) * outputRate
  let scaledRemainder = (inputFrames % rate) * outputRate
  let quotient = scaledRemainder / rate
  let remainder = scaledRemainder % rate
  return wholeOutput + quotient + (remainder * 2 >= rate ? 1 : 0)
}

private func intermediateDifferenceBound(_ rate: Int64) -> Int64 {
  rationallyRoundedOutputFrames(Int64(maximumOrdinaryBlockFrames), rate: rate)
    + candidateFinalBound
}

private func greatestCommonDivisor(_ left: Int64, _ right: Int64) -> Int64 {
  var left = left
  var right = right
  while right != 0 { (left, right) = (right, left % right) }
  return left
}

private func retainLargestSigned(_ candidate: Int64, in retained: inout Int64) {
  if abs(candidate) > abs(retained) { retained = candidate }
}

private func printMetrics(
  _ label: String,
  rate: Int64,
  seed: UInt64,
  metrics: StreamMetrics
) {
  print(
    "\(label) rate=\(rate) seed=\(seed) native=\(metrics.inputFrames) "
      + "output=\(metrics.outputFrames) expected=\(metrics.expectedOutputFrames) "
      + "maxIntermediate=\(metrics.maximumIntermediateDifference) final=\(metrics.finalDifference) "
      + "finish=\(metrics.finishOutputFrames) energy=\(metrics.energy) "
      + String(format: "digest=%016llx", metrics.digest)
  )
}
