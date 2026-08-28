import CryptoKit
import Foundation

public struct ArchiveLocalPiecePlan: Equatable, Sendable {
  public let chunkIndex: UInt32
  public let fitSegment: UInt64
  public let sampleStart: UInt64
  public let sampleEnd: UInt64
  public let startMS: UInt64?
  public let endMS: UInt64?
  public let uncertainty: ArchiveTimestampUncertainty?
}

public enum ArchiveLocalCutterError: Error, Equatable, Sendable {
  case invalidStartingIndex(UInt64)
  case invalidIndexedRange(position: Int)
  case noncontiguousIndexedRange(expected: UInt64, actual: UInt64)
  case chunkIndexOverflow
}

private struct CutterAnchor {
  let sample: UInt64
  let monoNS: UInt64
  let wallNS: UInt64
}

private struct CutterSegment {
  let start: UInt64
  let end: UInt64
  let anchors: [CutterAnchor]
  let fallback: CutterAnchor?
  let closesAtDiscontinuity: Bool
  let uncertainRanges: [Range<UInt64>]
}

private struct CutterFit {
  let slope: Double
  let meanSample: Double
  let meanMonoNS: Double
}

public enum ArchiveLocalCutter {
  public static let fullPieceSamples: UInt64 = 4_800_000
  public static let nominalSampleRate = 16_000.0

  public static func plan(
    indexRecords: [ArchiveIndexRecordMetadata],
    startingChunkIndex: UInt64 = 0,
    finalFlush: Bool = false
  ) throws -> [ArchiveLocalPiecePlan] {
    guard startingChunkIndex <= UInt64(UInt32.max) else {
      throw ArchiveLocalCutterError.invalidStartingIndex(startingChunkIndex)
    }
    guard let first = indexRecords.first else { return [] }
    var expected = first.payload.sampleStart
    for (position, record) in indexRecords.enumerated() {
      guard record.payload.sampleEnd > record.payload.sampleStart else {
        throw ArchiveLocalCutterError.invalidIndexedRange(position: position)
      }
      guard record.payload.sampleStart == expected else {
        throw ArchiveLocalCutterError.noncontiguousIndexedRange(
          expected: expected, actual: record.payload.sampleStart)
      }
      expected = record.payload.sampleEnd
    }

    var segments: [CutterSegment] = []
    var segmentStart = first.payload.sampleStart
    var anchors: [CutterAnchor] = []
    var fallback: CutterAnchor?
    var uncertainRanges: [Range<UInt64>] = []
    for record in indexRecords {
      let payload = record.payload
      if payload.discontinuity != nil {
        if payload.sampleStart > segmentStart {
          segments.append(
            CutterSegment(
              start: segmentStart,
              end: payload.sampleStart,
              anchors: anchors,
              fallback: fallback,
              closesAtDiscontinuity: true,
              uncertainRanges: uncertainRanges
            ))
        }
        segmentStart = payload.sampleStart
        anchors.removeAll(keepingCapacity: true)
        uncertainRanges.removeAll(keepingCapacity: true)
        if let monoNS = payload.monoNS, let wallNS = payload.wallNS {
          fallback = CutterAnchor(sample: payload.sampleStart, monoNS: monoNS, wallNS: wallNS)
        } else {
          fallback = nil
        }
        if payload.discontinuity == .crashRecoveredUnindexed {
          uncertainRanges.append(payload.sampleStart..<payload.sampleEnd)
        }
      } else if let monoNS = payload.monoNS, let wallNS = payload.wallNS {
        anchors.append(CutterAnchor(sample: payload.sampleEnd, monoNS: monoNS, wallNS: wallNS))
        if fallback == nil {
          fallback = CutterAnchor(sample: payload.sampleEnd, monoNS: monoNS, wallNS: wallNS)
        }
      }
    }
    let authenticatedEnd = indexRecords.last!.payload.sampleEnd
    if authenticatedEnd > segmentStart {
      segments.append(
        CutterSegment(
          start: segmentStart,
          end: authenticatedEnd,
          anchors: anchors,
          fallback: fallback,
          closesAtDiscontinuity: false,
          uncertainRanges: uncertainRanges
        ))
    }

    var result: [ArchiveLocalPiecePlan] = []
    var chunkIndex = startingChunkIndex
    for (fitSegment, segment) in segments.enumerated() {
      var cursor = segment.start
      while segment.end - cursor >= fullPieceSamples {
        let end = cursor + fullPieceSamples
        result.append(
          try makePlan(
            chunkIndex: &chunkIndex,
            fitSegment: UInt64(fitSegment),
            start: cursor,
            end: end,
            anchors: segment.anchors,
            fallback: segment.fallback,
            uncertainRanges: segment.uncertainRanges
          ))
        cursor = end
      }
      if cursor < segment.end && (segment.closesAtDiscontinuity || finalFlush) {
        result.append(
          try makePlan(
            chunkIndex: &chunkIndex,
            fitSegment: UInt64(fitSegment),
            start: cursor,
            end: segment.end,
            anchors: segment.anchors,
            fallback: segment.fallback,
            uncertainRanges: segment.uncertainRanges
          ))
      }
    }
    return result
  }

  private static func makePlan(
    chunkIndex: inout UInt64,
    fitSegment: UInt64,
    start: UInt64,
    end: UInt64,
    anchors: [CutterAnchor],
    fallback: CutterAnchor?,
    uncertainRanges: [Range<UInt64>]
  ) throws -> ArchiveLocalPiecePlan {
    guard chunkIndex <= UInt64(UInt32.max) else {
      throw ArchiveLocalCutterError.chunkIndexOverflow
    }
    let fit = fittedLine(anchors)
    let newest = anchors.max { $0.sample < $1.sample }
    let uncertainty: ArchiveTimestampUncertainty?
    if anchors.count < 3 {
      uncertainty = .fewerThanThreeAnchors
    } else if let minimum = anchors.map(\.monoNS).min(),
      let maximum = anchors.map(\.monoNS).max(), maximum - minimum < 10_000_000_000
    {
      uncertainty = .anchorsSpanLessThanTenSeconds
    } else if let newest, end > newest.sample,
      end - newest.sample > UInt64(nominalSampleRate * 2)
    {
      uncertainty = .boundaryBeyondNewestAnchor
    } else if fit == nil || !fit!.slope.isFinite || fit!.slope <= 0 {
      uncertainty = .fittedRateNonFinite
    } else if abs(1_000_000_000 / fit!.slope - nominalSampleRate) / nominalSampleRate > 0.001 {
      uncertainty = .fittedRateOutOfBounds
    } else if uncertainRanges.contains(where: { $0.lowerBound < end && $0.upperBound > start }) {
      uncertainty = .discontinuityIntersectsFit
    } else {
      uncertainty = nil
    }
    let startMS = projectedMS(sample: start, anchors: anchors, fallback: fallback, fit: fit)
    let endMS = projectedMS(sample: end, anchors: anchors, fallback: fallback, fit: fit)
    let plan = ArchiveLocalPiecePlan(
      chunkIndex: UInt32(chunkIndex),
      fitSegment: fitSegment,
      sampleStart: start,
      sampleEnd: end,
      startMS: startMS,
      endMS: endMS,
      uncertainty: uncertainty
    )
    let incremented = chunkIndex.addingReportingOverflow(1)
    guard !incremented.overflow else { throw ArchiveLocalCutterError.chunkIndexOverflow }
    chunkIndex = incremented.partialValue
    return plan
  }

  private static func fittedLine(_ anchors: [CutterAnchor]) -> CutterFit? {
    guard anchors.count >= 2 else { return nil }
    let meanSample = anchors.reduce(0.0) { $0 + Double($1.sample) } / Double(anchors.count)
    let meanMono = anchors.reduce(0.0) { $0 + Double($1.monoNS) } / Double(anchors.count)
    var numerator = 0.0
    var denominator = 0.0
    for anchor in anchors {
      let sampleDelta = Double(anchor.sample) - meanSample
      numerator += sampleDelta * (Double(anchor.monoNS) - meanMono)
      denominator += sampleDelta * sampleDelta
    }
    guard denominator > 0 else { return nil }
    return CutterFit(
      slope: numerator / denominator,
      meanSample: meanSample,
      meanMonoNS: meanMono
    )
  }

  private static func projectedMS(
    sample: UInt64,
    anchors: [CutterAnchor],
    fallback: CutterAnchor?,
    fit: CutterFit?
  ) -> UInt64? {
    let anchor: CutterAnchor
    let mono: Double
    if let first = anchors.first, let fit, fit.slope.isFinite, fit.slope > 0 {
      anchor = first
      mono = fit.meanMonoNS + (Double(sample) - fit.meanSample) * fit.slope
    } else if let first = anchors.first {
      anchor = first
      mono =
        Double(anchor.monoNS) + (Double(sample) - Double(anchor.sample))
        * (1_000_000_000 / nominalSampleRate)
    } else if let fallback {
      anchor = fallback
      mono =
        Double(anchor.monoNS) + (Double(sample) - Double(anchor.sample))
        * (1_000_000_000 / nominalSampleRate)
    } else {
      return nil
    }
    let wallOffset: Double
    if anchors.isEmpty {
      wallOffset = Double(anchor.wallNS) - Double(anchor.monoNS)
    } else {
      wallOffset =
        anchors.reduce(0.0) { $0 + Double($1.wallNS) - Double($1.monoNS) }
        / Double(anchors.count)
    }
    let milliseconds = (mono + wallOffset) / 1_000_000
    guard milliseconds.isFinite, milliseconds >= 0, milliseconds <= Double(UInt64.max) else {
      return nil
    }
    return UInt64(milliseconds.rounded())
  }
}

public enum ArchiveReservationIdentity {
  public static func make(
    context: ArchiveContext,
    sessionID: String,
    chunkIndex: UInt32,
    sampleStart: UInt64,
    sampleEnd: UInt64
  ) throws -> String {
    var data = Data("eta.room-recorder/development-reservation/v1".utf8)
    append(try context.encodedBytes(), to: &data)
    append(Data(sessionID.utf8), to: &data)
    append(chunkIndex, to: &data)
    append(sampleStart, to: &data)
    append(sampleEnd, to: &data)
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private static func append(_ value: Data, to data: inout Data) {
    append(UInt64(value.count), to: &data)
    data.append(value)
  }

  private static func append<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
    for index in 0..<MemoryLayout<T>.size {
      data.append(UInt8(truncatingIfNeeded: value >> T(index * 8)))
    }
  }
}
