import Synchronization

enum StreamMarker: UInt8, CaseIterable, Hashable, Sendable {
  case none
  case restart
  case deviceLost
  case resumed
  case configurationChange
  case ringOverflow
  case captureDiscontinuity
  case invalidTimestamp
  case clockJump
  case formatChange
  case dayRollover

  var indexName: String {
    switch self {
    case .none: ""
    case .restart: "restart"
    case .deviceLost: "device_lost"
    case .resumed: "resumed"
    case .configurationChange: "configuration_change"
    case .ringOverflow: "ring_overflow"
    case .captureDiscontinuity: "capture_discontinuity"
    case .invalidTimestamp: "invalid_timestamp"
    case .clockJump: "clock_jump"
    case .formatChange: "format_change"
    case .dayRollover: "day_rollover"
    }
  }
}

struct CaptureRolloverSplit: Equatable, Sendable {
  let frameOffset: Int
  let monoNS: UInt64
  let wallNS: UInt64
}

struct BoundaryEvent: Sendable {
  var marker: StreamMarker = .none
  var monoNS: UInt64 = 0
  var wallNS: UInt64 = 0
  var gapNS: UInt64 = 0
}

struct BoundaryBatch: Sendable {
  var first = BoundaryEvent()
  var second = BoundaryEvent()
  var third = BoundaryEvent()
  var fourth = BoundaryEvent()

  var count: UInt64 {
    UInt64(first.marker == .none ? 0 : 1)
      + UInt64(second.marker == .none ? 0 : 1)
      + UInt64(third.marker == .none ? 0 : 1)
      + UInt64(fourth.marker == .none ? 0 : 1)
  }

  mutating func append(_ marker: StreamMarker, monoNS: UInt64, wallNS: UInt64, gapNS: UInt64 = 0) {
    if first.marker == marker || second.marker == marker || third.marker == marker
      || fourth.marker == marker
    {
      return
    }
    let event = BoundaryEvent(marker: marker, monoNS: monoNS, wallNS: wallNS, gapNS: gapNS)
    if first.marker == .none {
      first = event
    } else if second.marker == .none {
      second = event
    } else if third.marker == .none {
      third = event
    } else if fourth.marker == .none {
      fourth = event
    }
  }

  mutating func clear() {
    first = BoundaryEvent()
    second = BoundaryEvent()
    third = BoundaryEvent()
    fourth = BoundaryEvent()
  }
}

struct StreamItem: Sendable {
  var marker: StreamMarker = .none
  var captureGeneration: UInt64 = 0
  var frameCount: Int = 0
  var sampleRate: Double = 0
  var monoStartNS: UInt64 = 0
  var monoEndNS: UInt64 = 0
  var wallStartNS: UInt64 = 0
  var wallEndNS: UInt64 = 0
  var gapNS: UInt64 = 0
  var droppedFrames: UInt64 = 0
}

enum AudioRingReadDisposition: Equatable {
  case consume
  case retain
}

enum AudioRingReadResult: Equatable {
  case empty
  case consumed
  case retained
}

final class AudioRing: @unchecked Sendable {
  private let samples: UnsafeMutablePointer<Float>
  private let items: UnsafeMutablePointer<StreamItem>
  private let slotCount: UInt64
  private let framesPerSlot: Int
  private let readPosition = Atomic<UInt64>(0)
  private let writePosition = Atomic<UInt64>(0)
  private let acceptedBlocks = Atomic<UInt64>(0)
  private let droppedBlocks = Atomic<UInt64>(0)
  private let consumerClaimed = Atomic<Bool>(false)

  // Producer-only state. AVAudioEngine serializes a tap callback; the main thread uses
  // producer methods only after stopping that engine.
  private var pendingDroppedFrames: UInt64 = 0
  private var pendingDropStartNS: UInt64 = 0

  init(slotCount: Int = 64, framesPerSlot: Int = 8_192) {
    precondition(slotCount > 2 && framesPerSlot > 0)
    self.slotCount = UInt64(slotCount)
    self.framesPerSlot = framesPerSlot
    samples = .allocate(capacity: slotCount * framesPerSlot)
    samples.initialize(repeating: 0, count: slotCount * framesPerSlot)
    items = .allocate(capacity: slotCount)
    items.initialize(repeating: StreamItem(), count: slotCount)
  }

  deinit {
    samples.deinitialize(count: Int(slotCount) * framesPerSlot)
    samples.deallocate()
    items.deinitialize(count: Int(slotCount))
    items.deallocate()
  }

  // Called only by the audio callback. It performs no allocation, locking, or I/O.
  func writeAudio(
    channels: UnsafePointer<UnsafeMutablePointer<Float>>,
    channelCount: Int,
    frameCount: Int,
    sampleRate: Double,
    monoStartNS: UInt64,
    monoEndNS: UInt64,
    wallStartNS: UInt64,
    wallEndNS: UInt64,
    boundaries: BoundaryBatch,
    rollover: CaptureRolloverSplit? = nil,
    captureGeneration: UInt64 = 0
  ) -> Bool {
    guard channelCount > 0 else { return false }
    guard frameCount <= framesPerSlot else {
      noteDrop(frames: frameCount, monoStartNS: monoStartNS)
      return false
    }
    guard let rollover, (0...frameCount).contains(rollover.frameOffset) else {
      return writeUnsplitAudio(
        channels: channels,
        channelCount: channelCount,
        frameCount: frameCount,
        sampleRate: sampleRate,
        monoStartNS: monoStartNS,
        monoEndNS: monoEndNS,
        wallStartNS: wallStartNS,
        wallEndNS: wallEndNS,
        boundaries: boundaries,
        captureGeneration: captureGeneration)
    }
    let audioSlots: UInt64 = rollover.frameOffset == 0 || rollover.frameOffset == frameCount ? 1 : 2
    let overflowCount: UInt64 = pendingDroppedFrames > 0 ? 1 : 0
    let requiredSlots = boundaries.count + overflowCount + audioSlots + 1
    guard freeSlots >= requiredSlots else {
      noteDrop(frames: frameCount, monoStartNS: monoStartNS)
      return false
    }

    publishBoundary(boundaries.first)
    publishBoundary(boundaries.second)
    publishBoundary(boundaries.third)
    publishBoundary(boundaries.fourth)
    if pendingDroppedFrames > 0 {
      publishMarker(
        .ringOverflow,
        monoNS: monoStartNS,
        wallNS: wallStartNS,
        gapNS: monoStartNS >= pendingDropStartNS ? monoStartNS - pendingDropStartNS : 0,
        droppedFrames: pendingDroppedFrames
      )
      pendingDroppedFrames = 0
      pendingDropStartNS = 0
    }
    let prefixFrames = rollover.frameOffset
    if prefixFrames > 0 {
      publishAudio(
        channels: channels,
        channelCount: channelCount,
        sourceFrameOffset: 0,
        frameCount: prefixFrames,
        sampleRate: sampleRate,
        monoStartNS: monoStartNS,
        monoEndNS: segmentEnd(start: monoStartNS, frameCount: prefixFrames, sampleRate: sampleRate),
        wallStartNS: wallStartNS,
        wallEndNS: segmentEnd(start: wallStartNS, frameCount: prefixFrames, sampleRate: sampleRate),
        captureGeneration: captureGeneration)
    }
    publishMarker(
      .dayRollover,
      monoNS: rollover.monoNS,
      wallNS: rollover.wallNS,
      gapNS: 0,
      droppedFrames: 0)
    let suffixFrames = frameCount - prefixFrames
    if suffixFrames > 0 {
      publishAudio(
        channels: channels,
        channelCount: channelCount,
        sourceFrameOffset: prefixFrames,
        frameCount: suffixFrames,
        sampleRate: sampleRate,
        monoStartNS: segmentEnd(
          start: monoStartNS, frameCount: prefixFrames, sampleRate: sampleRate),
        monoEndNS: monoEndNS,
        wallStartNS: segmentEnd(
          start: wallStartNS, frameCount: prefixFrames, sampleRate: sampleRate),
        wallEndNS: wallEndNS,
        captureGeneration: captureGeneration)
    }
    acceptedBlocks.wrappingAdd(1, ordering: .relaxed)
    return true
  }

  private func writeUnsplitAudio(
    channels: UnsafePointer<UnsafeMutablePointer<Float>>,
    channelCount: Int,
    frameCount: Int,
    sampleRate: Double,
    monoStartNS: UInt64,
    monoEndNS: UInt64,
    wallStartNS: UInt64,
    wallEndNS: UInt64,
    boundaries: BoundaryBatch,
    captureGeneration: UInt64
  ) -> Bool {
    let overflowCount: UInt64 = pendingDroppedFrames > 0 ? 1 : 0
    let requiredSlots = 1 + boundaries.count + overflowCount
    guard freeSlots >= requiredSlots else {
      noteDrop(frames: frameCount, monoStartNS: monoStartNS)
      return false
    }
    publishBoundary(boundaries.first)
    publishBoundary(boundaries.second)
    publishBoundary(boundaries.third)
    publishBoundary(boundaries.fourth)
    if pendingDroppedFrames > 0 {
      publishMarker(
        .ringOverflow,
        monoNS: monoStartNS,
        wallNS: wallStartNS,
        gapNS: monoStartNS >= pendingDropStartNS ? monoStartNS - pendingDropStartNS : 0,
        droppedFrames: pendingDroppedFrames)
      pendingDroppedFrames = 0
      pendingDropStartNS = 0
    }
    publishAudio(
      channels: channels,
      channelCount: channelCount,
      sourceFrameOffset: 0,
      frameCount: frameCount,
      sampleRate: sampleRate,
      monoStartNS: monoStartNS,
      monoEndNS: monoEndNS,
      wallStartNS: wallStartNS,
      wallEndNS: wallEndNS,
      captureGeneration: captureGeneration)
    acceptedBlocks.wrappingAdd(1, ordering: .relaxed)
    return true
  }

  private func publishAudio(
    channels: UnsafePointer<UnsafeMutablePointer<Float>>,
    channelCount: Int,
    sourceFrameOffset: Int,
    frameCount: Int,
    sampleRate: Double,
    monoStartNS: UInt64,
    monoEndNS: UInt64,
    wallStartNS: UInt64,
    wallEndNS: UInt64,
    captureGeneration: UInt64
  ) {
    let write = writePosition.load(ordering: .relaxed)
    let slot = Int(write % slotCount)
    let destination = samples.advanced(by: slot * framesPerSlot)
    if channelCount == 1 {
      destination.update(from: channels[0].advanced(by: sourceFrameOffset), count: frameCount)
    } else {
      let divisor = Float(channelCount)
      for frame in 0..<frameCount {
        var mono: Float = 0
        for channel in 0..<channelCount {
          mono += channels[channel][sourceFrameOffset + frame]
        }
        destination[frame] = mono / divisor
      }
    }
    items[slot] = StreamItem(
      captureGeneration: captureGeneration,
      frameCount: frameCount,
      sampleRate: sampleRate,
      monoStartNS: monoStartNS,
      monoEndNS: monoEndNS,
      wallStartNS: wallStartNS,
      wallEndNS: wallEndNS
    )
    writePosition.store(write + 1, ordering: .releasing)
  }

  private func segmentEnd(start: UInt64, frameCount: Int, sampleRate: Double) -> UInt64 {
    start + UInt64(Double(frameCount) / sampleRate * 1_000_000_000)
  }

  // Main-thread producer calls are valid only after the capture engine has stopped.
  func writeMarker(_ marker: StreamMarker, monoNS: UInt64, wallNS: UInt64, gapNS: UInt64 = 0)
    -> Bool
  {
    let required: UInt64 = pendingDroppedFrames > 0 ? 2 : 1
    guard freeSlots >= required else { return false }
    if pendingDroppedFrames > 0 {
      publishMarker(
        .ringOverflow,
        monoNS: monoNS,
        wallNS: wallNS,
        gapNS: monoNS >= pendingDropStartNS ? monoNS - pendingDropStartNS : 0,
        droppedFrames: pendingDroppedFrames
      )
      pendingDroppedFrames = 0
      pendingDropStartNS = 0
    }
    publishMarker(marker, monoNS: monoNS, wallNS: wallNS, gapNS: gapNS, droppedFrames: 0)
    return true
  }

  func flushPendingOverflow(monoNS: UInt64, wallNS: UInt64) -> Bool {
    guard pendingDroppedFrames > 0 else { return true }
    guard freeSlots >= 1 else { return false }
    publishMarker(
      .ringOverflow,
      monoNS: monoNS,
      wallNS: wallNS,
      gapNS: monoNS >= pendingDropStartNS ? monoNS - pendingDropStartNS : 0,
      droppedFrames: pendingDroppedFrames
    )
    pendingDroppedFrames = 0
    pendingDropStartNS = 0
    return true
  }

  func withReadableItem(_ body: (StreamItem, UnsafePointer<Float>?) throws -> Void) rethrows -> Bool
  {
    let result = try withReadableItemDisposition { item, samples in
      try body(item, samples)
      return .consume
    }
    return result == .consumed
  }

  func withReadableItemDisposition(
    _ body: (StreamItem, UnsafePointer<Float>?) throws -> AudioRingReadDisposition
  ) rethrows -> AudioRingReadResult {
    let read = readPosition.load(ordering: .relaxed)
    let write = writePosition.load(ordering: .acquiring)
    guard read < write else { return .empty }
    let slot = Int(read % slotCount)
    let item = items[slot]
    let pointer =
      item.marker == .none ? UnsafePointer(samples.advanced(by: slot * framesPerSlot)) : nil
    guard try body(item, pointer) == .consume else { return .retained }
    readPosition.store(read + 1, ordering: .releasing)
    return .consumed
  }

  var isEmpty: Bool {
    readPosition.load(ordering: .acquiring) == writePosition.load(ordering: .acquiring)
  }

  var statistics: (acceptedBlocks: UInt64, droppedBlocks: UInt64) {
    (
      acceptedBlocks.load(ordering: .acquiring),
      droppedBlocks.load(ordering: .acquiring)
    )
  }

  func claimConsumer() -> Bool {
    !consumerClaimed.exchange(true, ordering: .acquiringAndReleasing)
  }

  func releaseConsumer() {
    consumerClaimed.store(false, ordering: .releasing)
  }

  private var freeSlots: UInt64 {
    let write = writePosition.load(ordering: .relaxed)
    let read = readPosition.load(ordering: .acquiring)
    return slotCount - (write - read)
  }

  private func noteDrop(frames: Int, monoStartNS: UInt64) {
    if pendingDroppedFrames == 0 { pendingDropStartNS = monoStartNS }
    pendingDroppedFrames += UInt64(frames)
    droppedBlocks.wrappingAdd(1, ordering: .relaxed)
  }

  private func publishMarker(
    _ marker: StreamMarker,
    monoNS: UInt64,
    wallNS: UInt64,
    gapNS: UInt64,
    droppedFrames: UInt64
  ) {
    let write = writePosition.load(ordering: .relaxed)
    let slot = Int(write % slotCount)
    items[slot] = StreamItem(
      marker: marker,
      monoStartNS: monoNS,
      monoEndNS: monoNS,
      wallStartNS: wallNS,
      wallEndNS: wallNS,
      gapNS: gapNS,
      droppedFrames: droppedFrames
    )
    writePosition.store(write + 1, ordering: .releasing)
  }

  private func publishBoundary(_ event: BoundaryEvent) {
    guard event.marker != .none else { return }
    publishMarker(
      event.marker,
      monoNS: event.monoNS,
      wallNS: event.wallNS,
      gapNS: event.gapNS,
      droppedFrames: 0
    )
  }
}
