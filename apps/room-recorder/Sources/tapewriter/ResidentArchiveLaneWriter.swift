import Foundation
import Synchronization
import TapeCore

enum ResidentArchiveLaneWriterError: Error, Equatable {
  case alreadyStarted
  case notStarted
  case ringAlreadyHasConsumer
  case invalidInputSampleRate(Double)
  case nativeFrameOverflow
  case rolloverFenceMismatch
  case rolloverOriginMismatch(expected: UInt64, actual: UInt64)
  case unattributedNativeFrames(UInt64)
}

struct ResidentArchiveLevels: Equatable, Sendable {
  let averageQ15: UInt16
  let peakQ15: UInt16
}

package struct ResidentArchiveRolloverFence: Equatable, Sendable {
  package let monoNS: UInt64
  package let wallNS: UInt64
  package let authenticatedFacts: ArchiveAuthenticatedLaneFacts
}

final class ResidentArchiveLaneWriter: @unchecked Sendable {
  private struct PreparedRollover {
    let fence: ResidentArchiveRolloverFence
    let store: ArchiveLaneStore
  }

  private typealias RolloverStoreFactory =
    @Sendable (ResidentArchiveRolloverFence) throws -> ArchiveLaneStore

  private struct NativeRate: Equatable {
    let value: Double
    let numerator: UInt64
    let denominator: UInt64
  }

  private static let recordSamples = 16_000
  private static let recordBytes = recordSamples * MemoryLayout<Int16>.size

  private let ring: AudioRing
  private let store: ArchiveLaneStore
  private let initialRolloverFence: ResidentArchiveRolloverFence?
  private let stopping = Atomic<Bool>(false)
  private let condition = NSCondition()
  private var didStart = false
  private var didFinish = false
  private var failure: Error?
  private var durableSampleEndValue: UInt64
  private var durableCaptureGeneration: UInt64 = 0
  private var durableCaptureCompletedNS: UInt64 = 0
  private var levelsValue: ResidentArchiveLevels?
  private var rolloverFenceValue: ResidentArchiveRolloverFence?
  private var rolloverStoreFactory: RolloverStoreFactory?
  private var rolloverHandler: (@Sendable (ResidentArchiveRolloverFence, ArchiveLaneStore) -> Void)?

  // Writer-thread-only state.
  private var resampler: PCMResampler?
  private var inputRate: NativeRate?
  private var captureGeneration: UInt64?
  private var unrecordedNativeFrames: UInt64 = 0
  private var pcm = Data()
  private var latestMonoNS: UInt64?
  private var latestWallNS: UInt64?
  private var discontinuities = ArchiveDiscontinuityAccumulator()
  private var didConsumeInitialRolloverFence = false

  init(
    ring: AudioRing,
    store: ArchiveLaneStore,
    initialRolloverFence: ResidentArchiveRolloverFence? = nil
  ) {
    self.ring = ring
    self.store = store
    self.initialRolloverFence = initialRolloverFence
    durableSampleEndValue =
      store.scanResult.index.records.last?.payload.sampleEnd ?? store.initialSamplePosition
    pcm.reserveCapacity(Self.recordBytes + 8_192)
  }

  deinit {
    store.close()
  }

  func start() throws {
    condition.lock()
    defer { condition.unlock() }
    guard !didStart else { throw ResidentArchiveLaneWriterError.alreadyStarted }
    if let initialRolloverFence {
      let expected = initialRolloverFence.authenticatedFacts.authenticatedSampleEnd
      guard store.initialSamplePosition == expected else {
        throw ResidentArchiveLaneWriterError.rolloverOriginMismatch(
          expected: expected,
          actual: store.initialSamplePosition)
      }
    }
    guard ring.claimConsumer() else {
      throw ResidentArchiveLaneWriterError.ringAlreadyHasConsumer
    }
    didStart = true
    Thread.detachNewThread { [self] in
      var preparedRollover: PreparedRollover?
      do {
        preparedRollover = try run()
      } catch {
        preparedRollover?.store.close()
        condition.lock()
        failure = error
        condition.unlock()
      }
      store.close()
      ring.releaseConsumer()
      condition.lock()
      didFinish = true
      let rolloverHandler = self.rolloverHandler
      condition.broadcast()
      condition.unlock()
      if let preparedRollover, let rolloverHandler {
        rolloverHandler(preparedRollover.fence, preparedRollover.store)
      } else {
        preparedRollover?.store.close()
      }
    }
  }

  func installRolloverHandler(
    storeFactory: @escaping @Sendable (ResidentArchiveRolloverFence) throws -> ArchiveLaneStore,
    _ handler: @escaping @Sendable (ResidentArchiveRolloverFence, ArchiveLaneStore) -> Void
  ) {
    condition.withLock {
      rolloverStoreFactory = storeFactory
      rolloverHandler = handler
    }
  }

  func stopAndWait() throws {
    condition.lock()
    guard didStart else {
      condition.unlock()
      throw ResidentArchiveLaneWriterError.notStarted
    }
    stopping.store(true, ordering: .releasing)
    while !didFinish { condition.wait() }
    let failure = failure
    condition.unlock()
    if let failure { throw failure }
  }

  func throwFailure() throws {
    condition.lock()
    let failure = failure
    condition.unlock()
    if let failure { throw failure }
  }

  var hasFailed: Bool {
    condition.lock()
    defer { condition.unlock() }
    return failure != nil
  }

  var isRunning: Bool {
    condition.lock()
    defer { condition.unlock() }
    return didStart && !didFinish
  }

  func authenticatedSnapshot() throws -> ArchiveLaneStore.AuthenticatedSnapshot {
    try store.authenticatedSnapshot()
  }

  var durableSampleEnd: UInt64 {
    condition.lock()
    defer { condition.unlock() }
    return durableSampleEndValue
  }

  var currentLevels: ResidentArchiveLevels? {
    condition.lock()
    defer { condition.unlock() }
    return levelsValue
  }

  var rolloverFence: ResidentArchiveRolloverFence? {
    condition.lock()
    defer { condition.unlock() }
    return rolloverFenceValue
  }

  func waitForDurableGrowth(
    after baselineSampleEnd: UInt64,
    captureGeneration: UInt64,
    timeout: TimeInterval
  ) throws -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    condition.lock()
    defer { condition.unlock() }
    while durableSampleEndValue <= baselineSampleEnd
      || durableCaptureGeneration != captureGeneration
    {
      if let failure { throw failure }
      if didFinish || !condition.wait(until: deadline) { return false }
    }
    if let failure { throw failure }
    guard !didFinish else { return false }
    return true
  }

  func hasDurableGrowth(
    after baselineSampleEnd: UInt64,
    captureGeneration: UInt64,
    completedByNS deadlineNS: UInt64
  ) -> Bool {
    condition.lock()
    defer { condition.unlock() }
    return failure == nil && !didFinish && durableSampleEndValue > baselineSampleEnd
      && durableCaptureGeneration == captureGeneration
      && durableCaptureCompletedNS <= deadlineNS
  }

  private func run() throws -> PreparedRollover? {
    if !store.scanResult.index.records.isEmpty {
      discontinuities.append(
        StreamItem(
          marker: .restart,
          monoStartNS: monotonicNowNS(),
          wallStartNS: wallNowNS()
        ))
    }
    while !stopping.load(ordering: .acquiring) || !ring.isEmpty {
      let result = try ring.withReadableItemDisposition { item, samples in
        if item.marker == .dayRollover {
          if let initialRolloverFence, !didConsumeInitialRolloverFence {
            guard item.monoStartNS == initialRolloverFence.monoNS,
              item.wallStartNS == initialRolloverFence.wallNS
            else {
              throw ResidentArchiveLaneWriterError.rolloverFenceMismatch
            }
            didConsumeInitialRolloverFence = true
            return .consume
          }
          return .retain
        }
        try consume(item: item, samples: samples)
        return .consume
      }
      if result == .retained {
        try finishCurrentStream()
        let snapshot = try store.authenticatedSnapshot()
        let facts = snapshot.authenticatedFacts
        snapshot.close()
        let marker = try retainedRolloverMarker()
        let fence = ResidentArchiveRolloverFence(
          monoNS: marker.monoStartNS,
          wallNS: marker.wallStartNS,
          authenticatedFacts: facts)
        condition.lock()
        rolloverFenceValue = fence
        let rolloverStoreFactory = self.rolloverStoreFactory
        condition.broadcast()
        condition.unlock()
        guard let rolloverStoreFactory else { return nil }
        var preparedStore: ArchiveLaneStore?
        do {
          let store = try rolloverStoreFactory(fence)
          preparedStore = store
          let expected = fence.authenticatedFacts.authenticatedSampleEnd
          guard store.initialSamplePosition == expected else {
            throw ResidentArchiveLaneWriterError.rolloverOriginMismatch(
              expected: expected,
              actual: store.initialSamplePosition)
          }
          return PreparedRollover(fence: fence, store: store)
        } catch {
          preparedStore?.close()
          throw error
        }
      }
      if result == .empty { Thread.sleep(forTimeInterval: 0.005) }
    }
    try finishCurrentStream()
    return nil
  }

  private func retainedRolloverMarker() throws -> StreamItem {
    var retained: StreamItem?
    let result = ring.withReadableItemDisposition { item, _ in
      retained = item
      return .retain
    }
    guard result == .retained, let retained, retained.marker == .dayRollover else {
      throw RecorderError("rollover fence disappeared before writer handoff")
    }
    return retained
  }

  private func consume(item: StreamItem, samples: UnsafePointer<Float>?) throws {
    if item.marker != .none {
      try finishCurrentStream()
      discontinuities.append(item)
      return
    }
    guard let samples else { throw RecorderError("audio stream item has no samples") }
    let rate = try nativeRate(item.sampleRate)
    if let inputRate, inputRate != rate {
      try finishCurrentStream()
      discontinuities.append(
        StreamItem(
          marker: .formatChange,
          monoStartNS: item.monoStartNS,
          wallStartNS: item.wallStartNS
        ))
    } else if let captureGeneration, captureGeneration != item.captureGeneration {
      try finishCurrentStream()
      discontinuities.append(
        StreamItem(
          marker: .restart,
          monoStartNS: item.monoStartNS,
          wallStartNS: item.wallStartNS
        ))
    }
    if inputRate == nil {
      inputRate = rate
      captureGeneration = item.captureGeneration
      resampler = try PCMResampler(inputSampleRate: item.sampleRate)
    }
    let addition = unrecordedNativeFrames.addingReportingOverflow(UInt64(item.frameCount))
    guard !addition.overflow else { throw ResidentArchiveLaneWriterError.nativeFrameOverflow }
    unrecordedNativeFrames = addition.partialValue
    latestMonoNS = item.monoEndNS
    latestWallNS = item.wallEndNS
    try resampler!.convert(samples: samples, frameCount: item.frameCount) { output, count in
      try appendConverted(output, count: count)
    }
  }

  private func finishCurrentStream() throws {
    if let resampler {
      try resampler.finish { output, count in
        try appendConverted(output, count: count, flushFullRecords: false)
      }
    }
    while pcm.count > Self.recordBytes {
      try appendRecord(byteCount: Self.recordBytes, final: false)
    }
    if !pcm.isEmpty { try appendRecord(byteCount: pcm.count, final: true) }
    guard unrecordedNativeFrames == 0 else {
      throw ResidentArchiveLaneWriterError.unattributedNativeFrames(unrecordedNativeFrames)
    }
    resampler = nil
    inputRate = nil
    captureGeneration = nil
    unrecordedNativeFrames = 0
    latestMonoNS = nil
    latestWallNS = nil
  }

  private func appendConverted(
    _ output: UnsafePointer<Int16>,
    count: Int,
    flushFullRecords: Bool = true
  ) throws {
    guard count > 0 else { return }
    pcm.append(Data(bytes: output, count: count * MemoryLayout<Int16>.size))
    while flushFullRecords && pcm.count >= Self.recordBytes {
      try appendRecord(byteCount: Self.recordBytes, final: false)
    }
  }

  private func appendRecord(byteCount: Int, final: Bool) throws {
    let plaintext = Data(pcm.prefix(byteCount))
    let sampleCount = UInt64(byteCount / MemoryLayout<Int16>.size)
    let trailingSamples = UInt64((pcm.count - byteCount) / MemoryLayout<Int16>.size)
    let trailingNS = trailingSamples * 1_000_000_000 / UInt64(TapeConstants.sampleRate)
    let monoNS = latestMonoNS.map { $0 >= trailingNS ? $0 - trailingNS : 0 }
    let wallNS = latestWallNS.map { $0 >= trailingNS ? $0 - trailingNS : 0 }
    let levels = try ArchiveLevelSidecarBuilder.quantizedLevels(plaintext)
    let pending = discontinuities.observation
    let nativeFrames = try nativeFrames(for: sampleCount, final: final)
    let result = try store.appendPCM(
      plaintext,
      observation: ArchiveIndexObservation(
        monoNS: pending?.monoNS ?? monoNS,
        wallNS: pending?.wallNS ?? wallNS,
        rmsQ15: levels.averageQ15,
        nativeFrames: nativeFrames,
        inputRateNumerator: inputRate?.numerator,
        inputRateDenominator: inputRate?.denominator,
        discontinuity: pending?.discontinuity,
        reason: pending?.reason,
        gapNS: pending?.gapNS
      ))
    pcm.removeFirst(byteCount)
    if pending != nil { discontinuities.removeAll() }

    condition.lock()
    durableSampleEndValue = result.index.payload.sampleEnd
    durableCaptureGeneration = captureGeneration ?? 0
    durableCaptureCompletedNS = monotonicNowNS()
    levelsValue = ResidentArchiveLevels(
      averageQ15: levels.averageQ15,
      peakQ15: levels.peakQ15)
    condition.broadcast()
    condition.unlock()
  }

  private func nativeFrames(for sampleCount: UInt64, final: Bool) throws -> UInt64 {
    guard let inputRate else { return 0 }
    if final {
      let result = unrecordedNativeFrames
      unrecordedNativeFrames = 0
      return result
    }
    guard inputRate.numerator <= UInt64.max / sampleCount else {
      throw ResidentArchiveLaneWriterError.nativeFrameOverflow
    }
    let denominator = UInt64(TapeConstants.sampleRate) * inputRate.denominator
    let product = sampleCount * inputRate.numerator
    let estimate = (product + denominator / 2) / denominator
    let result = min(estimate, unrecordedNativeFrames)
    unrecordedNativeFrames -= result
    return result
  }

  private func nativeRate(_ value: Double) throws -> NativeRate {
    let scale = 1_000_000.0
    guard value.isFinite, value > 0, value <= Double(UInt64.max) / scale else {
      throw ResidentArchiveLaneWriterError.invalidInputSampleRate(value)
    }
    let scaled = UInt64((value * scale).rounded())
    guard scaled > 0 else {
      throw ResidentArchiveLaneWriterError.invalidInputSampleRate(value)
    }
    let divisor = greatestCommonDivisor(scaled, 1_000_000)
    return NativeRate(
      value: value,
      numerator: scaled / divisor,
      denominator: 1_000_000 / divisor)
  }

  private func greatestCommonDivisor(_ lhs: UInt64, _ rhs: UInt64) -> UInt64 {
    var lhs = lhs
    var rhs = rhs
    while rhs != 0 {
      (lhs, rhs) = (rhs, lhs % rhs)
    }
    return lhs
  }
}
