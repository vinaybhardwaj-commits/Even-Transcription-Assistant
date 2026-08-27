import Foundation

public struct ArchiveLevelObservation: Equatable, Sendable {
  public let rmsQ16: UInt16
  public let peakQ15: UInt16
  public let voiceActive: Bool

  public init(rmsQ16: UInt16, peakQ15: UInt16, voiceActive: Bool) throws {
    guard peakQ15 <= 32_767 else {
      throw ArchiveLevelSidecarError.invalidPeakQ15(peakQ15)
    }
    self.rmsQ16 = rmsQ16
    self.peakQ15 = peakQ15
    self.voiceActive = voiceActive
  }

  fileprivate init(validatedRMSQ16: UInt16, peakQ15: UInt16, voiceActive: Bool) {
    rmsQ16 = validatedRMSQ16
    self.peakQ15 = peakQ15
    self.voiceActive = voiceActive
  }
}

public struct ArchiveLevelRecordPlan: Equatable, Sendable {
  public let firstSample: UInt64
  public let sampleCount: UInt32
  public let observations: [ArchiveLevelObservation]

  public var plaintext: Data {
    ArchiveLevelPayloadCodec.encode(observations)
  }
}

public enum ArchiveLevelSidecarError: Error, Equatable, Sendable {
  case invalidPayloadByteCount(Int)
  case invalidPeakQ15(UInt16)
  case tooManyObservations(Int)
  case invalidEnvelopeRange(first: UInt64, count: UInt32, observations: Int)
  case invalidPCMByteCount(Int)
  case rangeMismatch(expected: UInt64, actual: UInt64)
  case sampleCountOverflow(UInt64)
  case frozenRecordMismatch(position: Int)
}

public enum ArchiveLevelPayloadCodec {
  public static func encode(_ observations: [ArchiveLevelObservation]) -> Data {
    var result = Data()
    result.reserveCapacity(observations.count * 4)
    for observation in observations {
      result.append(UInt8(truncatingIfNeeded: observation.rmsQ16))
      result.append(UInt8(truncatingIfNeeded: observation.rmsQ16 >> 8))
      result.append(UInt8(truncatingIfNeeded: observation.peakQ15))
      var high = UInt8(truncatingIfNeeded: observation.peakQ15 >> 8) & 0x7F
      if observation.voiceActive { high |= 0x80 }
      result.append(high)
    }
    return result
  }

  public static func decode(_ data: Data) throws -> [ArchiveLevelObservation] {
    guard !data.isEmpty, data.count.isMultiple(of: 4) else {
      throw ArchiveLevelSidecarError.invalidPayloadByteCount(data.count)
    }
    let count = data.count / 4
    guard count <= 60 else {
      throw ArchiveLevelSidecarError.tooManyObservations(count)
    }
    return stride(from: 0, to: data.count, by: 4).map { offset in
      let rms = UInt16(data[offset]) | UInt16(data[offset + 1]) << 8
      let peak = UInt16(data[offset + 2]) | UInt16(data[offset + 3] & 0x7F) << 8
      return ArchiveLevelObservation(
        validatedRMSQ16: rms,
        peakQ15: peak,
        voiceActive: data[offset + 3] & 0x80 != 0
      )
    }
  }

  public static func validateRecord(_ record: ArchiveDerivedRecord) throws {
    let observations = try decode(record.plaintext)
    let minimum = UInt64(observations.count - 1) * 16_000 + 1
    let maximum = UInt64(observations.count) * 16_000
    let count = UInt64(record.header.logicalUnitCount)
    guard count >= minimum, count <= maximum else {
      throw ArchiveLevelSidecarError.invalidEnvelopeRange(
        first: record.header.firstLogicalUnit,
        count: record.header.logicalUnitCount,
        observations: observations.count
      )
    }
  }
}

public enum ArchiveLevelSidecarBuilder {
  public static let algorithmID = "energy-adaptive-v1"
  public static let frameSamples: UInt64 = 320
  public static let observationSamples: UInt64 = 16_000
  public static let historyFrameCount = 3_000

  public static func build(
    indexRecords: [ArchiveIndexRecordMetadata],
    readPCM: (_ sampleStart: UInt64, _ sampleEnd: UInt64) throws -> Data
  ) throws -> [ArchiveLevelRecordPlan] {
    try build(indexRecords: indexRecords, frozenRecords: [], readPCM: readPCM)
  }

  public static func build(
    indexRecords: [ArchiveIndexRecordMetadata],
    frozenRecords: [ArchiveLevelRecordPlan],
    readPCM: (_ sampleStart: UInt64, _ sampleEnd: UInt64) throws -> Data
  ) throws -> [ArchiveLevelRecordPlan] {
    guard let first = indexRecords.first else {
      guard frozenRecords.isEmpty else {
        throw ArchiveLevelSidecarError.frozenRecordMismatch(position: 0)
      }
      return []
    }
    let authenticatedEnd = indexRecords.last!.payload.sampleEnd
    let discontinuities = Set(
      indexRecords.compactMap { record in
        record.payload.discontinuity == nil ? nil : record.payload.sampleStart
      })

    var history = LevelVADHistory(capacity: historyFrameCount)
    var plans: [ArchiveLevelRecordPlan] = []
    var cursor = first.payload.sampleStart
    for (position, frozen) in frozenRecords.enumerated() {
      let end = cursor.addingReportingOverflow(UInt64(frozen.sampleCount))
      guard !end.overflow, frozen.firstSample == cursor, end.partialValue <= authenticatedEnd,
        !discontinuities.contains(where: { $0 > cursor && $0 < end.partialValue })
      else {
        throw ArchiveLevelSidecarError.frozenRecordMismatch(position: position)
      }
      let observations = try observations(
        start: cursor,
        end: end.partialValue,
        history: &history,
        readPCM: readPCM)
      guard observations == frozen.observations else {
        throw ArchiveLevelSidecarError.frozenRecordMismatch(position: position)
      }
      plans.append(frozen)
      cursor = end.partialValue
    }

    while cursor < authenticatedEnd {
      let segmentEnd =
        discontinuities.filter { $0 > cursor }.min() ?? authenticatedEnd
      var observations: [ArchiveLevelObservation] = []
      let recordStart = cursor
      while cursor < segmentEnd && observations.count < 60 {
        let remaining = segmentEnd - cursor
        let end = cursor + min(remaining, observationSamples)
        observations.append(
          try observation(start: cursor, end: end, history: &history, readPCM: readPCM))
        cursor = end
      }
      let sampleCount = cursor - recordStart
      guard sampleCount > 0, sampleCount <= UInt64(UInt32.max) else {
        throw ArchiveLevelSidecarError.sampleCountOverflow(sampleCount)
      }
      plans.append(
        ArchiveLevelRecordPlan(
          firstSample: recordStart,
          sampleCount: UInt32(sampleCount),
          observations: observations))
    }
    return plans
  }

  private static func observations(
    start: UInt64,
    end: UInt64,
    history: inout LevelVADHistory,
    readPCM: (_ sampleStart: UInt64, _ sampleEnd: UInt64) throws -> Data
  ) throws -> [ArchiveLevelObservation] {
    var result: [ArchiveLevelObservation] = []
    var cursor = start
    while cursor < end {
      let remaining = end - cursor
      let observationEnd = cursor + min(remaining, observationSamples)
      result.append(
        try observation(
          start: cursor, end: observationEnd, history: &history, readPCM: readPCM))
      cursor = observationEnd
    }
    guard !result.isEmpty, result.count <= 60 else {
      throw ArchiveLevelSidecarError.tooManyObservations(result.count)
    }
    return result
  }

  private static func observation(
    start: UInt64,
    end: UInt64,
    history: inout LevelVADHistory,
    readPCM: (_ sampleStart: UInt64, _ sampleEnd: UInt64) throws -> Data
  ) throws -> ArchiveLevelObservation {
    let pcm = try readPCM(start, end)
    let sampleCount = end - start
    let expectedBytes = sampleCount.multipliedReportingOverflow(by: 2)
    guard !expectedBytes.overflow, expectedBytes.partialValue <= UInt64(Int.max),
      pcm.count == Int(expectedBytes.partialValue)
    else {
      throw ArchiveLevelSidecarError.rangeMismatch(
        expected: expectedBytes.partialValue, actual: UInt64(pcm.count))
    }
    return levelObservation(samples: try samples(pcm), history: &history)
  }

  public static func quantizedLevels(_ pcm: Data) throws -> (averageQ15: UInt16, peakQ15: UInt16) {
    let values = try samples(pcm)
    guard !values.isEmpty else {
      throw ArchiveLevelSidecarError.invalidPCMByteCount(pcm.count)
    }
    let metrics = normalizedLevels(values)
    return (
      UInt16(min(32_767, Int((metrics.rms * 32_767).rounded()))),
      UInt16(min(32_767, Int((metrics.peak * 32_767).rounded())))
    )
  }

  private static func levelObservation(
    samples: [Int16],
    history: inout LevelVADHistory
  ) -> ArchiveLevelObservation {
    let metrics = normalizedLevels(samples)
    var qualifyingFrames = 0
    var frameStart = 0
    while frameStart + Int(frameSamples) <= samples.count {
      let frame = samples[frameStart..<(frameStart + Int(frameSamples))]
      let frameRMS = normalizedLevels(frame).rms
      let dbFS = 20 * log10(max(frameRMS, 1.0 / 32_768.0))
      let threshold: Double
      threshold = history.threshold
      if dbFS >= threshold { qualifyingFrames += 1 }
      history.append(dbFS)
      frameStart += Int(frameSamples)
    }
    return ArchiveLevelObservation(
      validatedRMSQ16: UInt16(min(65_535, Int((metrics.rms * 65_535).rounded()))),
      peakQ15: UInt16(min(32_767, Int((metrics.peak * 32_767).rounded()))),
      voiceActive: qualifyingFrames >= 5
    )
  }

  private static func samples(_ pcm: Data) throws -> [Int16] {
    guard !pcm.isEmpty, pcm.count.isMultiple(of: 2) else {
      throw ArchiveLevelSidecarError.invalidPCMByteCount(pcm.count)
    }
    var result: [Int16] = []
    result.reserveCapacity(pcm.count / 2)
    var offset = 0
    while offset < pcm.count {
      let bits = UInt16(pcm[offset]) | UInt16(pcm[offset + 1]) << 8
      result.append(Int16(bitPattern: bits))
      offset += 2
    }
    return result
  }

  private static func normalizedLevels<S: Collection>(_ samples: S) -> (rms: Double, peak: Double)
  where S.Element == Int16 {
    var squared = 0.0
    var peak = 0.0
    var count = 0
    for sample in samples {
      let normalized = Double(sample) / 32_768.0
      squared += normalized * normalized
      peak = max(peak, abs(normalized))
      count += 1
    }
    return (count == 0 ? 0 : sqrt(squared / Double(count)), peak)
  }
}

private struct LevelVADHistory {
  private let capacity: Int
  private var chronological: [Double] = []
  private var root: LevelOrderNode?
  private var replacementIndex = 0

  init(capacity: Int) {
    self.capacity = capacity
    chronological.reserveCapacity(capacity)
  }

  var threshold: Double {
    guard chronological.count == capacity else { return -48 }
    let rank = max(1, Int(ceil(0.2 * Double(capacity))))
    return max(-48, LevelOrderNode.value(at: rank - 1, in: root!) + 10)
  }

  mutating func append(_ value: Double) {
    if chronological.count < capacity {
      chronological.append(value)
    } else {
      let removed = chronological[replacementIndex]
      chronological[replacementIndex] = value
      replacementIndex = (replacementIndex + 1) % capacity
      root = LevelOrderNode.removing(removed, from: root)
    }
    root = LevelOrderNode.inserting(value, into: root)
  }
}

private final class LevelOrderNode {
  let value: Double
  let priority: UInt64
  var count = 1
  var size = 1
  var left: LevelOrderNode?
  var right: LevelOrderNode?

  init(value: Double) {
    self.value = value
    var hash = value.bitPattern &+ 0x9E37_79B9_7F4A_7C15
    hash = (hash ^ (hash >> 30)) &* 0xBF58_476D_1CE4_E5B9
    hash = (hash ^ (hash >> 27)) &* 0x94D0_49BB_1331_11EB
    priority = hash ^ (hash >> 31)
  }

  static func inserting(_ value: Double, into node: LevelOrderNode?) -> LevelOrderNode {
    guard let node else { return LevelOrderNode(value: value) }
    if value == node.value {
      node.count += 1
    } else if value < node.value {
      node.left = inserting(value, into: node.left)
      if node.left!.priority < node.priority { return rotateRight(node) }
    } else {
      node.right = inserting(value, into: node.right)
      if node.right!.priority < node.priority { return rotateLeft(node) }
    }
    node.updateSize()
    return node
  }

  static func removing(_ value: Double, from node: LevelOrderNode?) -> LevelOrderNode? {
    guard let node else { return nil }
    if value < node.value {
      node.left = removing(value, from: node.left)
    } else if value > node.value {
      node.right = removing(value, from: node.right)
    } else if node.count > 1 {
      node.count -= 1
    } else {
      return merging(node.left, node.right)
    }
    node.updateSize()
    return node
  }

  static func value(at index: Int, in node: LevelOrderNode) -> Double {
    let leftSize = node.left?.size ?? 0
    if index < leftSize { return value(at: index, in: node.left!) }
    if index < leftSize + node.count { return node.value }
    return value(at: index - leftSize - node.count, in: node.right!)
  }

  private static func merging(
    _ left: LevelOrderNode?,
    _ right: LevelOrderNode?
  ) -> LevelOrderNode? {
    guard let left else { return right }
    guard let right else { return left }
    if left.priority < right.priority {
      left.right = merging(left.right, right)
      left.updateSize()
      return left
    }
    right.left = merging(left, right.left)
    right.updateSize()
    return right
  }

  private static func rotateLeft(_ node: LevelOrderNode) -> LevelOrderNode {
    let root = node.right!
    node.right = root.left
    root.left = node
    node.updateSize()
    root.updateSize()
    return root
  }

  private static func rotateRight(_ node: LevelOrderNode) -> LevelOrderNode {
    let root = node.left!
    node.left = root.right
    root.right = node
    node.updateSize()
    root.updateSize()
    return root
  }

  private func updateSize() {
    size = (left?.size ?? 0) + count + (right?.size ?? 0)
  }
}
