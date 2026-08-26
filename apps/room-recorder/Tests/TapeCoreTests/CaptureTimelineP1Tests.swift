import Foundation
import Testing

@testable import TapeCapture
@testable import TapeCore

@Suite struct CaptureTimelineP1Tests {
  @Test func cap04ShortDropoutPrecedesTheFirstRecoveredSamplesWithoutZeroFill() throws {
    var timeline = CaptureTimeline()
    let first = timeline.classify(observation(hostStartNS: 1_000_000_000, sampleTime: 0))
    timeline.didPublishFrame()

    let recovered = timeline.classify(
      observation(hostStartNS: 1_510_000_000, sampleTime: 480))
    let ring = AudioRing(slotCount: 4, framesPerSlot: 480)
    let recoveredSamples = [Float](repeating: 0.5, count: 480)
    #expect(publish(ring, samples: recoveredSamples, timing: recovered))
    let items = consume(ring)

    #expect(items.map(\.item.marker) == [.captureDiscontinuity, .none])
    #expect(items[0].item.gapNS == 500_000_000)
    #expect(items[1].samples == recoveredSamples)

    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let writerRing = AudioRing(slotCount: 8, framesPerSlot: 480)
    let writer = TapeWriter(directory: directory, deviceUID: "fixture", ring: writerRing)
    try writer.startAndWaitUntilReady()
    #expect(
      publish(
        writerRing, samples: [Float](repeating: 0.25, count: 480), timing: first))
    #expect(publish(writerRing, samples: recoveredSamples, timing: recovered))
    try writer.stopAndWait()

    let report = try TapeVerifier.verify(directory: directory)
    #expect(report.discontinuities.map(\.kind) == ["capture_discontinuity", "stopped"])
    #expect(report.discontinuities[0].gapNS == 500_000_000)
    #expect(report.totalSamples < 1_000)
  }

  @Test func cap05InvalidHostAndSampleTimesIndependentlyProduceUncertainBoundaries() throws {
    let cases: [(hostStartNS: UInt64?, sampleTime: Int64?)] = [
      (nil, 0),
      (5_000_000_000, nil),
      (nil, nil),
    ]
    var producedKind: String?
    for item in cases {
      var timeline = CaptureTimeline()
      let invalid = timeline.classify(
        observation(
          hostStartNS: item.hostStartNS,
          sampleTime: item.sampleTime,
          observedMonoNS: 5_000_000_000,
          observedWallNS: 15_000_000_000
        ))
      let ring = AudioRing(slotCount: 4, framesPerSlot: 480)
      #expect(
        publish(ring, samples: [Float](repeating: 0.1, count: 480), timing: invalid))
      let items = consume(ring)

      #expect(items.map(\.item.marker) == [.invalidTimestamp, .none])
      #expect(items[0].item.monoStartNS == 5_000_000_000)
      #expect(items[0].item.wallStartNS == 15_000_000_000)
      producedKind = items[0].item.marker.indexName
    }

    let report = try TapeVerifier.verify(
      pcmSize: 128_000,
      records: [
        IndexRecord(byteOffset: 0, samples: 0, monoNS: 1, wallNS: 1),
        IndexRecord(
          byteOffset: 64_000,
          samples: 32_000,
          monoNS: 2_000_000_001,
          wallNS: 2_000_000_001
        ),
        IndexRecord(
          byteOffset: 64_000,
          samples: 32_000,
          monoNS: 2_100_000_001,
          wallNS: 2_100_000_001,
          discontinuity: producedKind
        ),
        IndexRecord(
          byteOffset: 64_000,
          samples: 32_000,
          monoNS: 2_200_000_001,
          wallNS: 2_200_000_001
        ),
        IndexRecord(
          byteOffset: 128_000,
          samples: 64_000,
          monoNS: 4_200_000_001,
          wallNS: 4_200_000_001
        ),
      ])
    #expect(report.discontinuities.map(\.kind) == ["invalid_timestamp"])
    #expect(report.driftRecords.count == 4)
    #expect(abs(report.fittedPPM ?? 1) < 0.001)
  }

  @Test func cap06DetectsSampleResetGapOverlapAndHostDiscontinuities() {
    let cases: [(secondHost: UInt64, secondSample: Int64, expectedGap: UInt64)] = [
      (1_010_000_000, 0, 0),  // sample reset
      (1_010_000_000, 960, 0),  // sample-time gap
      (1_010_000_000, 240, 0),  // sample-time overlap
      (1_013_000_000, 480, 3_000_000),  // host-time gap
      (1_007_000_000, 480, 0),  // host-time overlap
    ]

    for item in cases {
      var timeline = CaptureTimeline()
      _ = timeline.classify(observation(hostStartNS: 1_000_000_000, sampleTime: 0))
      timeline.didPublishFrame()
      let timing = timeline.classify(
        observation(hostStartNS: item.secondHost, sampleTime: item.secondSample))
      let boundaries = boundaryItems(timing.boundaries)
      #expect(boundaries.map(\.marker) == [.captureDiscontinuity])
      #expect(boundaries[0].gapNS == item.expectedGap)
    }
  }

  @Test func cap06WriterCommitsTheBoundaryAtTheExactPCMOffset() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let ring = AudioRing(slotCount: 8, framesPerSlot: 480)
    let writer = TapeWriter(directory: directory, deviceUID: "fixture", ring: ring)
    try writer.startAndWaitUntilReady()

    var timeline = CaptureTimeline()
    let first = timeline.classify(observation(hostStartNS: 1_000_000_000, sampleTime: 0))
    #expect(publish(ring, samples: [Float](repeating: 0.25, count: 480), timing: first))
    timeline.didPublishFrame()
    let reset = timeline.classify(observation(hostStartNS: 1_010_000_000, sampleTime: 0))
    #expect(publish(ring, samples: [Float](repeating: 0.5, count: 480), timing: reset))
    timeline.didPublishFrame()
    try writer.stopAndWait()

    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let pcmSize = try #require(
      (try FileManager.default.attributesOfItem(atPath: pcmURL.path)[.size] as? NSNumber)?
        .int64Value)
    let records = try IndexLog.read(
      url: directory.appendingPathComponent("tape.idx"), pcmSize: pcmSize
    ).records
    let boundaryIndex = try #require(
      records.firstIndex { $0.discontinuity == "capture_discontinuity" })
    let boundaryOffset = try #require(records[boundaryIndex].byteOffset)

    #expect(boundaryOffset > 0)
    #expect(records[boundaryIndex - 1].byteOffset == boundaryOffset)
    #expect(records[boundaryIndex + 1].byteOffset == boundaryOffset)
    #expect((records.last?.byteOffset ?? 0) > boundaryOffset)
  }

  @Test func cap07ReportsForwardAndBackwardWallJumpsWithoutChangingMonotonicDrift() throws {
    for secondWall in [11_510_000_000 as UInt64, 10_510_000_000] {
      var timeline = CaptureTimeline()
      _ = timeline.classify(
        observation(
          hostStartNS: 1_000_000_000,
          sampleTime: 0,
          observedMonoNS: 1_000_000_000,
          observedWallNS: 11_000_000_000
        ))
      timeline.didPublishFrame()
      let jumped = timeline.classify(
        observation(
          hostStartNS: 1_010_000_000,
          sampleTime: 480,
          observedMonoNS: 1_010_000_000,
          observedWallNS: secondWall
        ))
      let boundaries = boundaryItems(jumped.boundaries)
      #expect(boundaries.map(\.marker) == [.clockJump])
      #expect(boundaries[0].gapNS == 500_000_000)
    }

    let report = try TapeVerifier.verify(
      pcmSize: 128_000,
      records: [
        IndexRecord(
          byteOffset: 0,
          samples: 0,
          monoNS: 1,
          wallNS: 1_000_000_001,
          inputFrames: 0,
          inputSampleRate: 48_000
        ),
        IndexRecord(
          byteOffset: 64_000,
          samples: 32_000,
          monoNS: 2_000_000_001,
          wallNS: 3_000_000_001,
          inputFrames: 96_000,
          inputSampleRate: 48_000
        ),
        IndexRecord(
          byteOffset: 64_000,
          samples: 32_000,
          monoNS: 2_100_000_001,
          wallNS: 3_600_000_001,
          discontinuity: "clock_jump",
          gapNS: 500_000_000,
          inputFrames: 96_000,
          inputSampleRate: 48_000
        ),
        IndexRecord(
          byteOffset: 64_000,
          samples: 32_000,
          monoNS: 2_200_000_001,
          wallNS: 3_700_000_001,
          inputFrames: 96_000,
          inputSampleRate: 48_000
        ),
        IndexRecord(
          byteOffset: 128_000,
          samples: 64_000,
          monoNS: 4_200_000_001,
          wallNS: 5_700_000_001,
          inputFrames: 192_000,
          inputSampleRate: 48_000
        ),
      ])
    #expect(report.discontinuities.map(\.kind) == ["clock_jump"])
    #expect(abs(report.fittedPPM ?? 1) < 0.001)
    #expect(report.nativeDriftRecords.count == 4)
    #expect(abs(report.fittedNativePPM ?? 1) < 0.001)
    #expect(report.rendered().contains("clock adjustment 0.500 s"))
  }
}

private struct CapturedTimelineItem {
  let item: StreamItem
  let samples: [Float]
}

private func observation(
  hostStartNS: UInt64?,
  sampleTime: Int64?,
  observedMonoNS: UInt64? = nil,
  observedWallNS: UInt64? = nil
) -> CaptureObservation {
  CaptureObservation(
    frameCount: 480,
    sampleRate: 48_000,
    hostStartNS: hostStartNS,
    sampleTime: sampleTime,
    observedMonoNS: observedMonoNS ?? hostStartNS ?? 1_000_000_000,
    observedWallNS: observedWallNS ?? (hostStartNS ?? 1_000_000_000) + 10_000_000_000
  )
}

private func publish(_ ring: AudioRing, samples: [Float], timing: CaptureFrameTiming) -> Bool {
  var samples = samples
  return samples.withUnsafeMutableBufferPointer { buffer in
    var channel = buffer.baseAddress!
    return withUnsafePointer(to: &channel) { channels in
      ring.writeAudio(
        channels: channels,
        channelCount: 1,
        frameCount: buffer.count,
        sampleRate: 48_000,
        monoStartNS: timing.monoStartNS,
        monoEndNS: timing.monoEndNS,
        wallStartNS: timing.wallStartNS,
        wallEndNS: timing.wallEndNS,
        boundaries: timing.boundaries
      )
    }
  }
}

private func consume(_ ring: AudioRing) -> [CapturedTimelineItem] {
  var captured: [CapturedTimelineItem] = []
  while ring.withReadableItem({ item, pointer in
    let samples =
      pointer.map {
        Array(UnsafeBufferPointer(start: $0, count: item.frameCount))
      } ?? []
    captured.append(CapturedTimelineItem(item: item, samples: samples))
  }) {}
  return captured
}

private func boundaryItems(_ batch: BoundaryBatch) -> [BoundaryEvent] {
  [batch.first, batch.second, batch.third, batch.fourth].filter { $0.marker != .none }
}
