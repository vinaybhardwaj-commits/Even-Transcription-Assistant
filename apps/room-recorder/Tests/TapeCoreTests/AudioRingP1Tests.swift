import Foundation
import Synchronization
import Testing

@testable import TapeCapture

@Suite struct AudioRingP1Tests {
  @Test func ring01PreservesExactSamplesAcrossManyWraps() {
    let ring = AudioRing(slotCount: 4, framesPerSlot: 2)
    var exact = true

    for sequence in 0..<4_096 {
      let samples = [Float(sequence), Float(sequence) + 0.5]
      if !writeBlock(ring, samples: samples, monoStartNS: UInt64(sequence)) {
        exact = false
        break
      }
      let read = ring.withReadableItem { item, pointer in
        guard item.marker == .none, item.frameCount == samples.count, let pointer else {
          exact = false
          return
        }
        exact = Array(UnsafeBufferPointer(start: pointer, count: item.frameCount)) == samples
      }
      if !read || !exact { break }
    }

    #expect(exact)
    #expect(ring.isEmpty)
    #expect(ring.statistics.acceptedBlocks == 4_096)
    #expect(ring.statistics.droppedBlocks == 0)
  }

  @Test func cap03AveragesLeftAndRightWithoutClipping() {
    let ring = AudioRing(slotCount: 4, framesPerSlot: 8)
    var left: [Float] = [0.8, -0.8, 0, 0, 1, -1, 1, -1]
    var right: [Float] = [0, 0, 0.6, -0.6, 1, -1, -1, 1]
    let expected: [Float] = [0.4, -0.4, 0.3, -0.3, 1, -1, 0, 0]

    let accepted = left.withUnsafeMutableBufferPointer { leftBuffer in
      right.withUnsafeMutableBufferPointer { rightBuffer in
        let channels = [leftBuffer.baseAddress!, rightBuffer.baseAddress!]
        return channels.withUnsafeBufferPointer { channelPointers in
          ring.writeAudio(
            channels: channelPointers.baseAddress!,
            channelCount: channelPointers.count,
            frameCount: leftBuffer.count,
            sampleRate: 48_000,
            monoStartNS: 1,
            monoEndNS: 9,
            wallStartNS: 1_001,
            wallEndNS: 1_009,
            boundaries: BoundaryBatch()
          )
        }
      }
    }

    #expect(accepted)
    let items = drain(ring)
    #expect(items.count == 1)
    #expect(items[0].samples == expected)
    #expect(items[0].samples.allSatisfy { abs($0) <= 1 })
  }

  @Test func cap03RejectsInvalidChannelCount() {
    for channelCount in [0, -1] {
      let ring = AudioRing(slotCount: 4, framesPerSlot: 1)
      var sample: Float = 1

      #expect(
        !withUnsafeMutablePointer(to: &sample) { samplePointer in
          var channel = samplePointer
          return withUnsafePointer(to: &channel) { channels in
            ring.writeAudio(
              channels: channels,
              channelCount: channelCount,
              frameCount: 1,
              sampleRate: 48_000,
              monoStartNS: 1,
              monoEndNS: 2,
              wallStartNS: 1,
              wallEndNS: 2,
              boundaries: BoundaryBatch()
            )
          }
        })
      #expect(ring.isEmpty)
    }
  }

  @Test func ring02AggregatesDropsOnceAndRetainsRecoveryAudio() {
    let ring = AudioRing(slotCount: 4, framesPerSlot: 4)
    for clock in 1...4 {
      #expect(
        ring.writeMarker(.configurationChange, monoNS: UInt64(clock), wallNS: UInt64(clock)))
    }

    #expect(!writeBlock(ring, samples: [10, 11, 12, 13], monoStartNS: 10))
    #expect(!writeBlock(ring, samples: [14, 15, 16, 17], monoStartNS: 14))
    _ = drain(ring)

    let recovery = [30 as Float, 31, 32, 33]
    #expect(writeBlock(ring, samples: recovery, monoStartNS: 30))
    let recovered = drain(ring)

    #expect(recovered.count == 2)
    #expect(recovered[0].item.marker == .ringOverflow)
    #expect(recovered[0].item.droppedFrames == 8)
    #expect(recovered[0].item.gapNS == 20)
    #expect(recovered[1].item.marker == .none)
    #expect(recovered[1].samples == recovery)
    #expect(ring.statistics.acceptedBlocks == 1)
    #expect(ring.statistics.droppedBlocks == 2)
  }

  @Test func ring03PublishesEveryBoundaryOnceBeforeOverflowAndAudio() {
    let ring = AudioRing(slotCount: 8, framesPerSlot: 2)
    for clock in 1...8 {
      #expect(
        ring.writeMarker(.configurationChange, monoNS: UInt64(clock), wallNS: UInt64(clock)))
    }
    #expect(!writeBlock(ring, samples: [50, 51], monoStartNS: 50))
    _ = drain(ring)

    var boundaries = BoundaryBatch()
    boundaries.append(.resumed, monoNS: 101, wallNS: 1_101, gapNS: 11)
    boundaries.append(.captureDiscontinuity, monoNS: 102, wallNS: 1_102, gapNS: 12)
    boundaries.append(.invalidTimestamp, monoNS: 103, wallNS: 1_103, gapNS: 13)
    boundaries.append(.clockJump, monoNS: 104, wallNS: 1_104, gapNS: 14)
    boundaries.append(.resumed, monoNS: 999, wallNS: 999, gapNS: 999)

    #expect(
      writeBlock(
        ring,
        samples: [200, 201],
        monoStartNS: 200,
        wallStartNS: 1_200,
        boundaries: boundaries
      ))
    let items = drain(ring)

    #expect(
      items.map(\.item.marker) == [
        .resumed, .captureDiscontinuity, .invalidTimestamp, .clockJump, .ringOverflow, .none,
      ])
    #expect(items[0].item.monoStartNS == 101)
    #expect(items[0].item.wallStartNS == 1_101)
    #expect(items[0].item.gapNS == 11)
    #expect(items[1].item.monoStartNS == 102)
    #expect(items[1].item.gapNS == 12)
    #expect(items[2].item.monoStartNS == 103)
    #expect(items[2].item.gapNS == 13)
    #expect(items[3].item.monoStartNS == 104)
    #expect(items[3].item.gapNS == 14)
    #expect(items[4].item.droppedFrames == 2)
    #expect(items[4].item.gapNS == 150)
    #expect(items[5].samples == [200, 201])
  }

  @Test func ring05SerializesProducerHandoffAroundLossAndResume() {
    let ring = AudioRing(slotCount: 8, framesPerSlot: 2)
    let firstAccepted = Atomic<Bool>(false)
    let secondAccepted = Atomic<Bool>(false)
    let producerActive = Atomic<Bool>(false)
    let producersOverlapped = Atomic<Bool>(false)

    let first = DispatchGroup()
    first.enter()
    DispatchQueue.global().async {
      if producerActive.exchange(true, ordering: .acquiringAndReleasing) {
        producersOverlapped.store(true, ordering: .releasing)
      }
      firstAccepted.store(
        writeBlock(ring, samples: [1, 2], monoStartNS: 10), ordering: .releasing)
      producerActive.store(false, ordering: .releasing)
      first.leave()
    }
    first.wait()

    #expect(ring.writeMarker(.deviceLost, monoNS: 20, wallNS: 1_020, gapNS: 10))
    var resumed = BoundaryBatch()
    resumed.append(.resumed, monoNS: 30, wallNS: 1_030, gapNS: 10)

    let second = DispatchGroup()
    second.enter()
    DispatchQueue.global().async {
      if producerActive.exchange(true, ordering: .acquiringAndReleasing) {
        producersOverlapped.store(true, ordering: .releasing)
      }
      secondAccepted.store(
        writeBlock(ring, samples: [3, 4], monoStartNS: 30, boundaries: resumed),
        ordering: .releasing
      )
      producerActive.store(false, ordering: .releasing)
      second.leave()
    }
    second.wait()

    let items = drain(ring)
    let didAcceptFirst = firstAccepted.load(ordering: .acquiring)
    let didAcceptSecond = secondAccepted.load(ordering: .acquiring)
    let didOverlap = producersOverlapped.load(ordering: .acquiring)
    #expect(didAcceptFirst)
    #expect(didAcceptSecond)
    #expect(!didOverlap)
    #expect(items.map(\.item.marker) == [.none, .deviceLost, .resumed, .none])
    #expect(items[0].samples == [1, 2])
    #expect(items[1].item.gapNS == 10)
    #expect(items[2].item.gapNS == 10)
    #expect(items[3].samples == [3, 4])
  }

  @Test func ring07SplitsOneCallbackAroundTheRolloverFence() {
    let ring = AudioRing(slotCount: 4, framesPerSlot: 8)
    let samples = (0..<8).map(Float.init)

    #expect(
      writeBlock(
        ring,
        samples: samples,
        monoStartNS: 1_000,
        wallStartNS: 2_000,
        sampleRate: 4,
        rollover: CaptureRolloverSplit(
          frameOffset: 3,
          monoNS: 750_001_000,
          wallNS: 750_002_000)))
    let items = drain(ring)

    #expect(items.map(\.item.marker) == [.none, .dayRollover, .none])
    #expect(items[0].samples == [0, 1, 2])
    #expect(items[0].item.monoStartNS == 1_000)
    #expect(items[0].item.monoEndNS == 750_001_000)
    #expect(items[1].item.monoStartNS == 750_001_000)
    #expect(items[1].item.wallStartNS == 750_002_000)
    #expect(items[2].samples == [3, 4, 5, 6, 7])
    #expect(items[2].item.monoStartNS == 750_001_000)
    #expect(items[2].item.monoEndNS == 2_000_001_000)
    #expect(ring.statistics.acceptedBlocks == 1)
  }

  @Test func ring08BoundaryOffsetsDoNotPublishEmptyAudioItems() {
    for offset in [0, 4] {
      let ring = AudioRing(slotCount: 3, framesPerSlot: 4)
      #expect(
        writeBlock(
          ring,
          samples: [1, 2, 3, 4],
          monoStartNS: 10,
          sampleRate: 4,
          rollover: CaptureRolloverSplit(
            frameOffset: offset,
            monoNS: 20,
            wallNS: 1_020)))

      let items = drain(ring)
      #expect(items.count == 2)
      #expect(items.map(\.item.marker).filter { $0 == .none }.count == 1)
      #expect(items.first { $0.item.marker == .none }?.samples == [1, 2, 3, 4])
      #expect(items.first { $0.item.marker == .none }?.item.frameCount == 4)
    }
  }

  @Test func ring09RejectsTheEntireRolloverTransactionWhenCapacityIsShort() {
    let ring = AudioRing(slotCount: 3, framesPerSlot: 4)
    #expect(ring.writeMarker(.configurationChange, monoNS: 1, wallNS: 1))

    #expect(
      !writeBlock(
        ring,
        samples: [1, 2, 3, 4],
        monoStartNS: 10,
        sampleRate: 4,
        rollover: CaptureRolloverSplit(
          frameOffset: 2,
          monoNS: 500_000_010,
          wallNS: 500_001_010)))
    let items = drain(ring)

    #expect(items.map(\.item.marker) == [.configurationChange])
    #expect(ring.statistics.acceptedBlocks == 0)
    #expect(ring.statistics.droppedBlocks == 1)
  }

  @Test func ring10RetainedReadLeavesTheFenceForTheNextConsumer() {
    let ring = AudioRing(slotCount: 3, framesPerSlot: 1)
    #expect(ring.writeMarker(.dayRollover, monoNS: 10, wallNS: 20))
    #expect(ring.writeMarker(.resumed, monoNS: 11, wallNS: 21))

    let retained = ring.withReadableItemDisposition { item, _ in
      #expect(item.marker == .dayRollover)
      return .retain
    }
    #expect(retained == .retained)
    #expect(!ring.isEmpty)

    let items = drain(ring)
    #expect(items.map(\.item.marker) == [.dayRollover, .resumed])
  }

  @Test func ring06SustainsConcurrentProducerAndConsumerWithoutCorruption() {
    let ring = AudioRing(slotCount: 17, framesPerSlot: 1)
    let producerDone = Atomic<Bool>(false)
    let results = StressResults()
    let workers = DispatchGroup()

    workers.enter()
    DispatchQueue.global().async {
      for sequence in 0..<25_000 {
        let sample = Float(sequence)
        if writeBlock(ring, samples: [sample], monoStartNS: UInt64(sequence)) {
          results.accepted.append(sample)
        }
        if sequence.isMultiple(of: 17) { sched_yield() }
      }
      while !ring.flushPendingOverflow(monoNS: 25_000, wallNS: 26_000) { sched_yield() }
      producerDone.store(true, ordering: .releasing)
      workers.leave()
    }

    workers.enter()
    DispatchQueue.global().async {
      while !producerDone.load(ordering: .acquiring) || !ring.isEmpty {
        let consumed = ring.withReadableItem { item, pointer in
          if item.marker == .ringOverflow {
            results.overflowMarkers += 1
            results.droppedFrames += item.droppedFrames
          } else if let pointer {
            results.received.append(pointer[0])
          }
        }
        if !consumed { sched_yield() }
      }
      workers.leave()
    }

    workers.wait()
    let statistics = ring.statistics
    #expect(results.received == results.accepted)
    #expect(zip(results.received, results.received.dropFirst()).allSatisfy(<))
    #expect(statistics.acceptedBlocks == UInt64(results.received.count))
    #expect(statistics.droppedBlocks == results.droppedFrames)
    #expect((statistics.droppedBlocks == 0) == (results.overflowMarkers == 0))
    #expect(ring.isEmpty)
  }
}

private struct CapturedRingItem {
  let item: StreamItem
  let samples: [Float]
}

private final class StressResults: @unchecked Sendable {
  // Each array/counter has exactly one worker writer; the test reads them only after both join.
  var accepted: [Float] = []
  var received: [Float] = []
  var overflowMarkers: UInt64 = 0
  var droppedFrames: UInt64 = 0
}

private func writeBlock(
  _ ring: AudioRing,
  samples: [Float],
  monoStartNS: UInt64,
  wallStartNS: UInt64? = nil,
  boundaries: BoundaryBatch = BoundaryBatch(),
  sampleRate: Double = 48_000,
  rollover: CaptureRolloverSplit? = nil
) -> Bool {
  var mutableSamples = samples
  let durationNS = UInt64(Double(samples.count) / sampleRate * 1_000_000_000)
  return mutableSamples.withUnsafeMutableBufferPointer { inputBuffer in
    var channel = inputBuffer.baseAddress!
    return withUnsafePointer(to: &channel) { channels in
      ring.writeAudio(
        channels: channels,
        channelCount: 1,
        frameCount: inputBuffer.count,
        sampleRate: sampleRate,
        monoStartNS: monoStartNS,
        monoEndNS: monoStartNS + durationNS,
        wallStartNS: wallStartNS ?? monoStartNS + 1_000,
        wallEndNS: (wallStartNS ?? monoStartNS + 1_000) + durationNS,
        boundaries: boundaries,
        rollover: rollover
      )
    }
  }
}

private func drain(_ ring: AudioRing) -> [CapturedRingItem] {
  var captured: [CapturedRingItem] = []
  while ring.withReadableItem({ item, pointer in
    let samples =
      pointer.map {
        Array(UnsafeBufferPointer(start: $0, count: item.frameCount))
      } ?? []
    captured.append(CapturedRingItem(item: item, samples: samples))
  }) {}
  return captured
}
