import Foundation

public struct DriftRecord: Sendable {
  public let index: Int
  public let driftMS: Double
  public let ppm: Double?
}

public struct ConverterAccountingRecord: Sendable {
  public let index: Int
  public let sampleDifference: Int64
}

public struct DiscontinuityReport: Sendable {
  public let kind: String
  public let monoNS: UInt64
  public let wallNS: UInt64
  public let gapNS: UInt64?
  public let survivingTailBytes: Int64?
}

public struct VerificationReport: Sendable {
  public let totalSamples: Int64
  public let sampleDurationSeconds: Double
  public let wallSpanSeconds: Double?
  public let sampleWallDifferenceSeconds: Double?
  public let driftRecords: [DriftRecord]
  public let fittedPPM: Double?
  public let largestStepAnomalyMS: Double?
  public let nativeDriftRecords: [DriftRecord]
  public let fittedNativePPM: Double?
  public let largestNativeStepAnomalyMS: Double?
  public let converterAccountingRecords: [ConverterAccountingRecord]
  public let largestConverterDifferenceSamples: Int64?
  public let largestCheckpointGapSeconds: Double?
  public let largestDurableRecordGapSeconds: Double?
  public let discontinuities: [DiscontinuityReport]
  public let currentTailBytes: Int64
  public let worstTailBytes: Int64
  public let discardedTrailingIndexBytes: Int
  public let passed: Bool

  public var currentTailSeconds: Double {
    Double(currentTailBytes) / Double(TapeConstants.bytesPerSecond)
  }
  public var worstTailSeconds: Double {
    Double(worstTailBytes) / Double(TapeConstants.bytesPerSecond)
  }

  public func rendered() -> String {
    let f: (Double, Int) -> String = { value, places in
      String(format: "%.*f", places, value)
    }
    var lines = [
      "Tape verification",
      "Total samples: \(totalSamples)",
      "Sample duration: \(f(sampleDurationSeconds, 6)) s",
      "Wall-clock span: \(wallSpanSeconds.map { f($0, 6) + " s" } ?? "unavailable")",
      "Sample minus wall: \(sampleWallDifferenceSeconds.map { f($0, 6) + " s" } ?? "unavailable")",
      "Per-record durable tape drift:",
    ]
    if driftRecords.isEmpty {
      lines.append("  unavailable")
    } else {
      for item in driftRecords {
        let ppm = item.ppm.map { f($0, 3) + " ppm" } ?? "baseline"
        lines.append("  record \(item.index): \(f(item.driftMS, 3)) ms, \(ppm)")
      }
    }
    lines.append(
      "Fitted durable tape drift: \(fittedPPM.map { f($0, 3) + " ppm" } ?? "unavailable")")
    lines.append(
      "Largest durable tape step anomaly: \(largestStepAnomalyMS.map { f($0, 3) + " ms" } ?? "unavailable")"
    )
    lines.append("Per-record native input-clock drift:")
    if nativeDriftRecords.isEmpty {
      lines.append("  unavailable")
    } else {
      for item in nativeDriftRecords {
        let ppm = item.ppm.map { f($0, 3) + " ppm" } ?? "baseline"
        lines.append("  record \(item.index): \(f(item.driftMS, 3)) ms, \(ppm)")
      }
    }
    lines.append(
      "Fitted native input-clock drift: \(fittedNativePPM.map { f($0, 3) + " ppm" } ?? "unavailable")"
    )
    lines.append(
      "Native drift per five-minute piece: \(fittedNativePPM.map { f($0 * 0.3, 3) + " ms" } ?? "unavailable")"
    )
    lines.append(
      "Largest native input step anomaly: \(largestNativeStepAnomalyMS.map { f($0, 3) + " ms" } ?? "unavailable")"
    )
    lines.append("Native-to-tape converter accounting:")
    if converterAccountingRecords.isEmpty {
      lines.append("  unavailable")
    } else {
      for item in converterAccountingRecords {
        let milliseconds = Double(item.sampleDifference) / Double(TapeConstants.sampleRate) * 1_000
        lines.append(
          "  record \(item.index): \(item.sampleDifference) samples (\(f(milliseconds, 3)) ms)")
      }
    }
    lines.append(
      "Largest converter difference: \(largestConverterDifferenceSamples.map { "\($0) samples" } ?? "unavailable")"
    )
    lines.append(
      "Largest checkpoint gap: \(largestCheckpointGapSeconds.map { f($0, 6) + " s" } ?? "unavailable")"
    )
    lines.append(
      "Largest adjacent durable-record gap: \(largestDurableRecordGapSeconds.map { f($0, 6) + " s" } ?? "unavailable")"
    )
    lines.append("Discontinuities:")
    if discontinuities.isEmpty {
      lines.append("  none")
    } else {
      for event in discontinuities {
        let gap =
          event.gapNS.map {
            let label = event.kind == "clock_jump" ? "clock adjustment" : "gap"
            return ", \(label) " + f(Double($0) / 1_000_000_000, 3) + " s"
          } ?? ""
        let tail =
          event.survivingTailBytes.map {
            ", surviving crash tail \($0) bytes ("
              + f(Double($0) / Double(TapeConstants.bytesPerSecond), 6) + " s)"
          } ?? ""
        lines.append(
          "  \(event.kind): mono_ns=\(event.monoNS), wall_ns=\(event.wallNS)\(gap)\(tail)")
      }
    }
    lines.append(
      "Current unindexed tail: \(currentTailBytes) bytes (\(f(currentTailSeconds, 6)) s)")
    lines.append(
      "Worst surviving crash tail: \(worstTailBytes) bytes (\(f(worstTailSeconds, 6)) s)")
    lines.append(
      "Crash-loss scope: surviving unindexed PCM; power-cut disappearance requires external timing and listening evidence"
    )
    if discardedTrailingIndexBytes > 0 {
      lines.append("Ignored incomplete index suffix: \(discardedTrailingIndexBytes) bytes")
    }
    lines.append("VERDICT: \(passed ? "PASS" : "FAIL")")
    return lines.joined(separator: "\n")
  }
}

public enum TapeVerifier {
  public static func verify(directory: URL) throws -> VerificationReport {
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let indexURL = directory.appendingPathComponent("tape.idx")
    guard FileManager.default.fileExists(atPath: pcmURL.path) else {
      throw TapeError.missingFile("tape.pcm")
    }
    guard FileManager.default.fileExists(atPath: indexURL.path) else {
      throw TapeError.missingFile("tape.idx")
    }
    let attributes = try FileManager.default.attributesOfItem(atPath: pcmURL.path)
    let pcmSize = (attributes[.size] as? NSNumber)?.int64Value ?? 0
    guard pcmSize % TapeConstants.bytesPerSample == 0 else { throw TapeError.oddPCMSize(pcmSize) }
    let read = try IndexLog.read(url: indexURL, pcmSize: pcmSize)
    return try verify(
      pcmSize: pcmSize, records: read.records,
      discardedTrailingIndexBytes: read.discardedTrailingBytes)
  }

  public static func verify(
    pcmSize: Int64,
    records: [IndexRecord],
    discardedTrailingIndexBytes: Int = 0
  ) throws -> VerificationReport {
    guard pcmSize % TapeConstants.bytesPerSample == 0 else { throw TapeError.oddPCMSize(pcmSize) }
    guard !records.isEmpty else { throw TapeError.emptyIndex }
    let totalSamples = pcmSize / TapeConstants.bytesPerSample
    let sampleDuration = Double(totalSamples) / Double(TapeConstants.sampleRate)
    let firstWall = records.first?.wallNS
    let lastWall = records.last?.wallNS
    let wallSpan = firstWall.flatMap { first in
      lastWall.flatMap { last in last >= first ? Double(last - first) / 1_000_000_000 : nil }
    }

    var driftRecords: [DriftRecord] = []
    var nativeDriftRecords: [DriftRecord] = []
    var converterRecords: [ConverterAccountingRecord] = []
    var discontinuities: [DiscontinuityReport] = []
    var segmentBase: IndexRecord?
    var previousCheckpoint: IndexRecord?
    var fitXX = 0.0
    var fitXY = 0.0
    var largestStep: Double?
    var nativeFitXX = 0.0
    var nativeFitXY = 0.0
    var largestNativeStep: Double?
    var largestConverterDifference: Int64?
    var largestCheckpointGap: Double?
    var largestDurableGap: Double?
    var previousDurableMonoNS: UInt64?
    var lastDurableOffset: Int64 = 0
    var historicalTail: Int64 = 0

    for (index, record) in records.enumerated() {
      if let offset = record.byteOffset {
        lastDurableOffset = offset
        if let previous = previousDurableMonoNS, record.monoNS >= previous {
          let gap = Double(record.monoNS - previous) / 1_000_000_000
          if largestDurableGap == nil || gap > largestDurableGap! { largestDurableGap = gap }
        }
        previousDurableMonoNS = record.monoNS
      }
      if let kind = record.discontinuity {
        discontinuities.append(
          .init(
            kind: kind,
            monoNS: record.monoNS,
            wallNS: record.wallNS,
            gapNS: record.gapNS,
            survivingTailBytes: record.survivingTailBytes
          ))
        historicalTail = max(historicalTail, record.survivingTailBytes ?? 0)
        segmentBase = nil
        previousCheckpoint = nil
        continue
      }
      guard record.isCheckpoint, let samples = record.samples else { continue }
      if segmentBase == nil {
        segmentBase = record
        driftRecords.append(.init(index: index + 1, driftMS: 0, ppm: nil))
        if record.inputFrames != nil, record.inputSampleRate != nil {
          nativeDriftRecords.append(.init(index: index + 1, driftMS: 0, ppm: nil))
          converterRecords.append(.init(index: index + 1, sampleDifference: 0))
          if largestConverterDifference == nil { largestConverterDifference = 0 }
        }
        previousCheckpoint = record
        continue
      }
      guard let base = segmentBase, let baseSamples = base.samples, record.monoNS > base.monoNS
      else {
        throw TapeError.invalidIndex(
          line: index + 1, detail: "checkpoint monotonic clock did not advance")
      }
      let monoElapsed = Double(record.monoNS - base.monoNS) / 1_000_000_000
      let tapeElapsed = Double(samples - baseSamples) / Double(TapeConstants.sampleRate)
      let driftMS = (tapeElapsed - monoElapsed) * 1_000
      let ppm = (tapeElapsed / monoElapsed - 1) * 1_000_000
      driftRecords.append(.init(index: index + 1, driftMS: driftMS, ppm: ppm))
      fitXX += monoElapsed * monoElapsed
      fitXY += monoElapsed * tapeElapsed

      if let inputFrames = record.inputFrames,
        let baseInputFrames = base.inputFrames,
        let inputRate = record.inputSampleRate,
        base.inputSampleRate == inputRate
      {
        guard inputFrames >= baseInputFrames else {
          throw TapeError.invalidIndex(line: index + 1, detail: "input_frames regressed")
        }
        let nativeElapsed = Double(inputFrames - baseInputFrames) / inputRate
        let nativeDriftMS = (nativeElapsed - monoElapsed) * 1_000
        let nativePPM = (nativeElapsed / monoElapsed - 1) * 1_000_000
        nativeDriftRecords.append(.init(index: index + 1, driftMS: nativeDriftMS, ppm: nativePPM))
        nativeFitXX += monoElapsed * monoElapsed
        nativeFitXY += monoElapsed * nativeElapsed
        let expectedTapeSamplesValue =
          (Double(inputFrames - baseInputFrames)
          * Double(TapeConstants.sampleRate) / inputRate).rounded()
        guard expectedTapeSamplesValue.isFinite,
          expectedTapeSamplesValue >= Double(Int64.min),
          expectedTapeSamplesValue < Double(Int64.max)
        else {
          throw TapeError.invalidIndex(
            line: index + 1, detail: "converter sample accounting is out of range")
        }
        let expectedTapeSamples = Int64(expectedTapeSamplesValue)
        let actualTapeSamples = samples - baseSamples
        let converterDifference = actualTapeSamples - expectedTapeSamples
        converterRecords.append(.init(index: index + 1, sampleDifference: converterDifference))
        if largestConverterDifference == nil
          || abs(converterDifference) > abs(largestConverterDifference!)
        {
          largestConverterDifference = converterDifference
        }
      }

      if let previous = previousCheckpoint,
        let previousSamples = previous.samples,
        record.monoNS > previous.monoNS
      {
        let stepMono = Double(record.monoNS - previous.monoNS) / 1_000_000_000
        let stepTape = Double(samples - previousSamples) / Double(TapeConstants.sampleRate)
        let stepMS = (stepTape - stepMono) * 1_000
        if largestStep == nil || abs(stepMS) > abs(largestStep!) { largestStep = stepMS }
        if let inputFrames = record.inputFrames,
          let previousInputFrames = previous.inputFrames,
          let inputRate = record.inputSampleRate,
          previous.inputSampleRate == inputRate
        {
          let stepNative = Double(inputFrames - previousInputFrames) / inputRate
          let nativeStepMS = (stepNative - stepMono) * 1_000
          if largestNativeStep == nil || abs(nativeStepMS) > abs(largestNativeStep!) {
            largestNativeStep = nativeStepMS
          }
        }
        if largestCheckpointGap == nil || stepMono > largestCheckpointGap! {
          largestCheckpointGap = stepMono
        }
      }
      previousCheckpoint = record
    }

    guard lastDurableOffset <= pcmSize else {
      throw TapeError.indexBeyondPCM(
        line: records.count, offset: lastDurableOffset, pcmSize: pcmSize)
    }
    let currentTail = pcmSize - lastDurableOffset
    let worstTail = max(currentTail, historicalTail)
    let fittedPPM = fitXX > 0 ? (fitXY / fitXX - 1) * 1_000_000 : nil
    let fittedNativePPM = nativeFitXX > 0 ? (nativeFitXY / nativeFitXX - 1) * 1_000_000 : nil
    let difference = wallSpan.map { sampleDuration - $0 }
    let hasRingOverflow = discontinuities.contains { $0.kind == "ring_overflow" }
    let cadencePassed = largestCheckpointGap.map { $0 <= TapeConstants.passTailSeconds } ?? true
    let passed =
      totalSamples > 0
      && Double(worstTail) / Double(TapeConstants.bytesPerSecond) <= TapeConstants.passTailSeconds
      && cadencePassed && !hasRingOverflow
    return VerificationReport(
      totalSamples: totalSamples,
      sampleDurationSeconds: sampleDuration,
      wallSpanSeconds: wallSpan,
      sampleWallDifferenceSeconds: difference,
      driftRecords: driftRecords,
      fittedPPM: fittedPPM,
      largestStepAnomalyMS: largestStep,
      nativeDriftRecords: nativeDriftRecords,
      fittedNativePPM: fittedNativePPM,
      largestNativeStepAnomalyMS: largestNativeStep,
      converterAccountingRecords: converterRecords,
      largestConverterDifferenceSamples: largestConverterDifference,
      largestCheckpointGapSeconds: largestCheckpointGap,
      largestDurableRecordGapSeconds: largestDurableGap,
      discontinuities: discontinuities,
      currentTailBytes: currentTail,
      worstTailBytes: worstTail,
      discardedTrailingIndexBytes: discardedTrailingIndexBytes,
      passed: passed
    )
  }
}
