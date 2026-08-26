import Foundation
import Testing

@testable import TapeCapture
@testable import TapeCore

@Suite struct TapeCaptureTests {
  @Test func recoversAfterOverflowWithMaximumBoundaryBatch() throws {
    let ring = AudioRing(slotCount: 6, framesPerSlot: 4)
    for clock in 1...6 {
      #expect(
        ring.writeMarker(
          .configurationChange,
          monoNS: UInt64(clock),
          wallNS: UInt64(clock)
        ))
    }

    var input: [Float] = [0.1, 0.2, 0.3, 0.4]
    let frameCount = input.count
    var boundaries = BoundaryBatch()
    boundaries.append(.resumed, monoNS: 10, wallNS: 10)
    boundaries.append(.captureDiscontinuity, monoNS: 10, wallNS: 10)
    boundaries.append(.invalidTimestamp, monoNS: 10, wallNS: 10)
    boundaries.append(.clockJump, monoNS: 10, wallNS: 10)
    let accepted = input.withUnsafeMutableBufferPointer { inputBuffer in
      var channel = inputBuffer.baseAddress!
      return withUnsafePointer(to: &channel) { channels in
        ring.writeAudio(
          channels: channels,
          channelCount: 1,
          frameCount: frameCount,
          sampleRate: 48_000,
          monoStartNS: 10,
          monoEndNS: 20,
          wallStartNS: 10,
          wallEndNS: 20,
          boundaries: boundaries
        )
      }
    }
    #expect(!accepted)
    while ring.withReadableItem({ _, _ in }) {}

    let recovered = input.withUnsafeMutableBufferPointer { inputBuffer in
      var channel = inputBuffer.baseAddress!
      return withUnsafePointer(to: &channel) { channels in
        ring.writeAudio(
          channels: channels,
          channelCount: 1,
          frameCount: frameCount,
          sampleRate: 48_000,
          monoStartNS: 30,
          monoEndNS: 40,
          wallStartNS: 30,
          wallEndNS: 40,
          boundaries: boundaries
        )
      }
    }
    #expect(recovered)

    var overflow: StreamItem?
    while ring.withReadableItem({ item, _ in
      if item.marker == .ringOverflow { overflow = item }
    }) {}
    #expect(overflow?.droppedFrames == 4)
    #expect(overflow?.gapNS == 20)
  }

  @Test func cleanStopAlwaysCommitsFinalRecord() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let writer = TapeWriter(directory: directory, deviceUID: "fixture", ring: AudioRing())

    try writer.startAndWaitUntilReady()
    try writer.stopAndWait()

    let read = try IndexLog.read(
      url: directory.appendingPathComponent("tape.idx"),
      pcmSize: 0
    )
    #expect(read.records.last?.discontinuity == "stopped")
    #expect(read.records.last?.byteOffset == 0)
    let report = try TapeVerifier.verify(directory: directory)
    #expect(!report.passed)
  }

  @Test func finalOverflowIsDurableBeforeCleanStop() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let ring = AudioRing(slotCount: 4, framesPerSlot: 4)
    for clock in 1...4 {
      #expect(
        ring.writeMarker(
          .configurationChange,
          monoNS: UInt64(clock),
          wallNS: UInt64(clock)
        ))
    }
    var input: [Float] = [0.1, 0.2, 0.3, 0.4]
    let frameCount = input.count
    let accepted = input.withUnsafeMutableBufferPointer { inputBuffer in
      var channel = inputBuffer.baseAddress!
      return withUnsafePointer(to: &channel) { channels in
        ring.writeAudio(
          channels: channels,
          channelCount: 1,
          frameCount: frameCount,
          sampleRate: 48_000,
          monoStartNS: 10,
          monoEndNS: 20,
          wallStartNS: 10,
          wallEndNS: 20,
          boundaries: BoundaryBatch()
        )
      }
    }
    #expect(!accepted)

    let writer = TapeWriter(directory: directory, deviceUID: "fixture", ring: ring)
    try writer.startAndWaitUntilReady()
    while !ring.flushPendingOverflow(monoNS: 30, wallNS: 30) {
      try writer.throwFailure()
      Thread.sleep(forTimeInterval: 0.001)
    }
    try writer.stopAndWait()

    let read = try IndexLog.read(
      url: directory.appendingPathComponent("tape.idx"),
      pcmSize: 0
    )
    #expect(read.records.suffix(2).map(\.discontinuity) == ["ring_overflow", "stopped"])
    let report = try TapeVerifier.verify(directory: directory)
    #expect(!report.passed)
  }
}
