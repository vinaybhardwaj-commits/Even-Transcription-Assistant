import Synchronization

enum StreamMarker: UInt8, Sendable {
  case none
  case deviceLost
  case resumed
  case configurationChange
  case ringOverflow
  case captureDiscontinuity
  case invalidTimestamp
  case clockJump
  case formatChange

  var indexName: String {
    switch self {
    case .none: ""
    case .deviceLost: "device_lost"
    case .resumed: "resumed"
    case .configurationChange: "configuration_change"
    case .ringOverflow: "ring_overflow"
    case .captureDiscontinuity: "capture_discontinuity"
    case .invalidTimestamp: "invalid_timestamp"
    case .clockJump: "clock_jump"
    case .formatChange: "format_change"
    }
  }
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
  var frameCount: Int = 0
  var sampleRate: Double = 0
  var monoStartNS: UInt64 = 0
  var monoEndNS: UInt64 = 0
  var wallStartNS: UInt64 = 0
  var wallEndNS: UInt64 = 0
  var gapNS: UInt64 = 0
  var droppedFrames: UInt64 = 0
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

  // Producer-only state. AVAudioEngine serializes a tap callback; the main thread uses
  // producer methods only after stopping that engine.
  private var pendingDroppedFrames: UInt64 = 0
  private var pendingDropStartNS: UInt64 = 0

  init(slotCount: Int = 6, framesPerSlot: Int = 8_192) {
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
    boundaries: BoundaryBatch
  ) -> Bool {
    guard frameCount <= framesPerSlot else {
      noteDrop(frames: frameCount, monoStartNS: monoStartNS)
      return false
    }
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
        droppedFrames: pendingDroppedFrames
      )
      pendingDroppedFrames = 0
      pendingDropStartNS = 0
    }
    let write = writePosition.load(ordering: .relaxed)
    let slot = Int(write % slotCount)
    let destination = samples.advanced(by: slot * framesPerSlot)
    if channelCount == 1 {
      destination.update(from: channels[0], count: frameCount)
    } else {
      let divisor = Float(channelCount)
      for frame in 0..<frameCount {
        var mono: Float = 0
        for channel in 0..<channelCount { mono += channels[channel][frame] }
        destination[frame] = mono / divisor
      }
    }
    items[slot] = StreamItem(
      frameCount: frameCount,
      sampleRate: sampleRate,
      monoStartNS: monoStartNS,
      monoEndNS: monoEndNS,
      wallStartNS: wallStartNS,
      wallEndNS: wallEndNS
    )
    writePosition.store(write + 1, ordering: .releasing)
    acceptedBlocks.wrappingAdd(1, ordering: .relaxed)
    return true
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
    let read = readPosition.load(ordering: .relaxed)
    let write = writePosition.load(ordering: .acquiring)
    guard read < write else { return false }
    let slot = Int(read % slotCount)
    let item = items[slot]
    let pointer =
      item.marker == .none ? UnsafePointer(samples.advanced(by: slot * framesPerSlot)) : nil
    try body(item, pointer)
    readPosition.store(read + 1, ordering: .releasing)
    return true
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
