import Foundation
import Testing

@testable import TapeCapture
@testable import TapeCore

@Suite struct TapeWriterFormatP1Tests {
  @Test func src04DirectRateChangeFlushesAndAnchorsBothDirections() throws {
    for transition in src04Transitions {
      try src04WithTemporaryDirectory { directory in
        let fixture = try src04RecordTransition(
          directory: directory,
          transition: transition,
          path: .direct
        )
        try src04AssertTransition(fixture)
      }
    }
  }

  @Test func src04ConfigurationChangeRetainsRateForMismatchDetection() throws {
    for transition in src04Transitions {
      try src04WithTemporaryDirectory { directory in
        let fixture = try src04RecordTransition(
          directory: directory,
          transition: transition,
          path: .configurationChange
        )
        try src04AssertTransition(fixture)
      }
    }
  }

  @Test func src04ExplicitFormatChangeDoesNotDuplicate() throws {
    for transition in src04Transitions {
      try src04WithTemporaryDirectory { directory in
        let fixture = try src04RecordTransition(
          directory: directory,
          transition: transition,
          path: .explicitFormatChange
        )
        try src04AssertTransition(fixture)
      }
    }
  }

  @Test func src04RestartAppendsFromThePrecedingDurableAccounting() throws {
    try src04WithTemporaryDirectory { directory in
      let fixture = try src04RecordTransition(
        directory: directory,
        transition: src04Transitions[0],
        path: .configurationChange
      )
      try src04AssertTransition(fixture)

      let precedingOffset = try #require(fixture.records.last?.byteOffset)
      let precedingInputFrames = Int64(fixture.oldFrameCount + fixture.newFrameCount)
      let restartFrameCount = 3_503
      let restartOutputFrames = try src04ConvertedFrameCount(
        frameCount: restartFrameCount,
        rate: fixture.newRate
      )
      let ring = AudioRing(slotCount: 6, framesPerSlot: restartFrameCount)
      let writer = TapeWriter(directory: directory, deviceUID: src04DeviceUID, ring: ring)
      try writer.startAndWaitUntilReady()
      let monoStart = src04PastMonotonicNS()
      let wallStart = src04PastWallNS()
      try src04PublishAudio(
        ring,
        frameCount: restartFrameCount,
        rate: fixture.newRate,
        monoStartNS: monoStart,
        wallStartNS: wallStart
      )
      try writer.stopAndWait()

      let records = try src04ReadRecords(directory)
      let report = try TapeVerifier.verify(directory: directory)
      let restartIndex = fixture.records.count
      let restart = records[restartIndex]
      let baseline = records[restartIndex + 1]
      let final = records[restartIndex + 2]

      #expect(
        records.map { $0.discontinuity ?? "checkpoint" }
          == fixture.records.map { $0.discontinuity ?? "checkpoint" }
          + ["restart", "checkpoint", "checkpoint", "stopped"])
      #expect(restart.previousByteOffset == precedingOffset)
      #expect(restart.byteOffset == precedingOffset)
      #expect(restart.survivingTailBytes == 0)
      #expect(baseline.byteOffset == precedingOffset)
      #expect(baseline.inputFrames == precedingInputFrames)
      #expect(baseline.inputSampleRate == fixture.newRate)
      #expect(final.byteOffset == precedingOffset + restartOutputFrames * 2)
      #expect(final.inputFrames == precedingInputFrames + Int64(restartFrameCount))
      #expect(final.inputSampleRate == fixture.newRate)
      #expect(records.last?.inputFrames == final.inputFrames)
      #expect(src04InputTotalsDoNotRegress(records))

      let expectedDifference =
        restartOutputFrames
        - src04RationalOutputFrames(Int64(restartFrameCount), rate: Int64(fixture.newRate))
      #expect(
        report.converterAccountingRecords.suffix(2).map(\.index)
          == [restartIndex + 2, restartIndex + 3])
      #expect(
        report.converterAccountingRecords.suffix(2).map(\.sampleDifference)
          == [0, expectedDifference])
      #expect(report.currentTailBytes == 0)
      #expect(report.passed)
    }
  }

  @Test func src04ImmediateStopAfterExplicitMarkerRecoversTheOldTotal() throws {
    try src04WithTemporaryDirectory { directory in
      let transition = src04Transitions[1]
      let oldFrameCount = 4_096
      let newFrameCount = 5_003
      let oldOutputFrames = try src04ConvertedFrameCount(
        frameCount: oldFrameCount,
        rate: transition.oldRate
      )
      let ring = AudioRing(slotCount: 6, framesPerSlot: oldFrameCount)
      let writer = TapeWriter(directory: directory, deviceUID: src04DeviceUID, ring: ring)
      try writer.startAndWaitUntilReady()
      let monoStart = src04PastMonotonicNS()
      let wallStart = src04PastWallNS()
      try src04PublishAudio(
        ring,
        frameCount: oldFrameCount,
        rate: transition.oldRate,
        monoStartNS: monoStart,
        wallStartNS: wallStart
      )
      let markerMono = monoStart + src04DurationNS(oldFrameCount, rate: transition.oldRate)
      let markerWall = wallStart + src04DurationNS(oldFrameCount, rate: transition.oldRate)
      try #require(
        ring.writeMarker(
          .formatChange,
          monoNS: markerMono,
          wallNS: markerWall
        ))
      try writer.stopAndWait()

      let stoppedRecords = try src04ReadRecords(directory)
      #expect(
        stoppedRecords.map { $0.discontinuity ?? "checkpoint" }
          == ["checkpoint", "checkpoint", "format_change", "stopped"])
      #expect(stoppedRecords[1].samples == oldOutputFrames)
      #expect(stoppedRecords[2].samples == oldOutputFrames)
      #expect(stoppedRecords[2].inputFrames == Int64(oldFrameCount))
      #expect(stoppedRecords[2].inputSampleRate == transition.oldRate)
      #expect(stoppedRecords[3].inputFrames == nil)
      #expect(stoppedRecords[3].inputSampleRate == nil)
      let precedingOffset = try #require(stoppedRecords.last?.byteOffset)

      let restartRing = AudioRing(slotCount: 6, framesPerSlot: newFrameCount)
      let restartWriter = TapeWriter(
        directory: directory,
        deviceUID: src04DeviceUID,
        ring: restartRing
      )
      try restartWriter.startAndWaitUntilReady()
      let restartMono = src04PastMonotonicNS()
      let restartWall = src04PastWallNS()
      try src04PublishAudio(
        restartRing,
        frameCount: newFrameCount,
        rate: transition.newRate,
        monoStartNS: restartMono,
        wallStartNS: restartWall
      )
      try restartWriter.stopAndWait()

      let records = try src04ReadRecords(directory)
      let report = try TapeVerifier.verify(directory: directory)
      let restart = records[4]
      let baseline = records[5]
      let final = records[6]
      let newOutputFrames = try src04ConvertedFrameCount(
        frameCount: newFrameCount,
        rate: transition.newRate
      )

      #expect(
        records.map { $0.discontinuity ?? "checkpoint" }
          == [
            "checkpoint", "checkpoint", "format_change", "stopped", "restart", "checkpoint",
            "checkpoint", "stopped",
          ])
      #expect(records.filter { $0.discontinuity == "format_change" }.count == 1)
      #expect(restart.previousByteOffset == precedingOffset)
      #expect(restart.byteOffset == precedingOffset)
      #expect(restart.survivingTailBytes == 0)
      #expect(baseline.byteOffset == precedingOffset)
      #expect(baseline.inputFrames == Int64(oldFrameCount))
      #expect(baseline.inputSampleRate == transition.newRate)
      #expect(final.samples == oldOutputFrames + newOutputFrames)
      #expect(final.inputFrames == Int64(oldFrameCount + newFrameCount))
      #expect(final.inputSampleRate == transition.newRate)
      #expect(src04InputTotalsDoNotRegress(records))
      #expect(report.converterAccountingRecords.map(\.index) == [1, 2, 6, 7])
      #expect(report.currentTailBytes == 0)
      #expect(report.passed)
    }
  }
}

private let src04DeviceUID = "src04-fixture"
private let src04Transitions = [
  Src04RateTransition(oldRate: 44_100, newRate: 48_000),
  Src04RateTransition(oldRate: 192_000, newRate: 44_100),
]

private struct Src04RateTransition {
  let oldRate: Double
  let newRate: Double
}

private enum Src04TransitionPath {
  case direct
  case configurationChange
  case explicitFormatChange
}

private struct Src04TransitionFixture {
  let path: Src04TransitionPath
  let oldRate: Double
  let newRate: Double
  let oldFrameCount: Int
  let newFrameCount: Int
  let oldOutputFrames: Int64
  let newOutputFrames: Int64
  let records: [IndexRecord]
  let report: VerificationReport
}

private func src04RecordTransition(
  directory: URL,
  transition: Src04RateTransition,
  path: Src04TransitionPath
) throws -> Src04TransitionFixture {
  let oldFrameCount = 4_096
  let newFrameCount = 5_003
  let ring = AudioRing(
    slotCount: 8,
    framesPerSlot: max(oldFrameCount, newFrameCount)
  )
  let writer = TapeWriter(directory: directory, deviceUID: src04DeviceUID, ring: ring)
  try writer.startAndWaitUntilReady()

  let monoStart = src04PastMonotonicNS()
  let wallStart = src04PastWallNS()
  try src04PublishAudio(
    ring,
    frameCount: oldFrameCount,
    rate: transition.oldRate,
    monoStartNS: monoStart,
    wallStartNS: wallStart
  )
  let transitionMono = monoStart + src04DurationNS(oldFrameCount, rate: transition.oldRate)
  let transitionWall = wallStart + src04DurationNS(oldFrameCount, rate: transition.oldRate)
  switch path {
  case .direct:
    break
  case .configurationChange:
    try #require(
      ring.writeMarker(
        .configurationChange,
        monoNS: transitionMono,
        wallNS: transitionWall
      ))
  case .explicitFormatChange:
    try #require(
      ring.writeMarker(
        .formatChange,
        monoNS: transitionMono,
        wallNS: transitionWall
      ))
  }
  try src04PublishAudio(
    ring,
    frameCount: newFrameCount,
    rate: transition.newRate,
    monoStartNS: transitionMono,
    wallStartNS: transitionWall
  )
  try writer.stopAndWait()

  return try Src04TransitionFixture(
    path: path,
    oldRate: transition.oldRate,
    newRate: transition.newRate,
    oldFrameCount: oldFrameCount,
    newFrameCount: newFrameCount,
    oldOutputFrames: src04ConvertedFrameCount(
      frameCount: oldFrameCount,
      rate: transition.oldRate
    ),
    newOutputFrames: src04ConvertedFrameCount(
      frameCount: newFrameCount,
      rate: transition.newRate
    ),
    records: src04ReadRecords(directory),
    report: TapeVerifier.verify(directory: directory)
  )
}

private func src04AssertTransition(_ fixture: Src04TransitionFixture) throws {
  let expectedKinds: [String]
  let oldFinalIndex: Int
  let formatIndex: Int
  switch fixture.path {
  case .direct, .explicitFormatChange:
    expectedKinds = [
      "checkpoint", "checkpoint", "format_change", "checkpoint", "checkpoint", "stopped",
    ]
    oldFinalIndex = 1
    formatIndex = 2
  case .configurationChange:
    expectedKinds = [
      "checkpoint", "checkpoint", "configuration_change", "format_change", "checkpoint",
      "checkpoint", "stopped",
    ]
    oldFinalIndex = 1
    formatIndex = 3
  }

  let records = fixture.records
  let oldBaseline = records[0]
  let oldFinal = records[oldFinalIndex]
  let formatMarker = records[formatIndex]
  let newBaseline = records[formatIndex + 1]
  let newFinal = records[formatIndex + 2]
  let transitionOffset = try #require(formatMarker.byteOffset)
  let oldExpected = src04RationalOutputFrames(
    Int64(fixture.oldFrameCount),
    rate: Int64(fixture.oldRate)
  )
  let newExpected = src04RationalOutputFrames(
    Int64(fixture.newFrameCount),
    rate: Int64(fixture.newRate)
  )

  #expect(records.map { $0.discontinuity ?? "checkpoint" } == expectedKinds)
  #expect(records.filter { $0.discontinuity == "format_change" }.count == 1)
  #expect(oldBaseline.inputFrames == 0)
  #expect(oldBaseline.inputSampleRate == fixture.oldRate)
  #expect(oldFinal.samples == fixture.oldOutputFrames)
  #expect(oldFinal.inputFrames == Int64(fixture.oldFrameCount))
  #expect(oldFinal.inputSampleRate == fixture.oldRate)
  #expect(abs(fixture.oldOutputFrames - oldExpected) <= 12)
  #expect(formatMarker.samples == fixture.oldOutputFrames)
  #expect(formatMarker.inputFrames == Int64(fixture.oldFrameCount))
  #expect(formatMarker.inputSampleRate == fixture.oldRate)
  #expect(newBaseline.inputFrames == Int64(fixture.oldFrameCount))
  #expect(newBaseline.inputSampleRate == fixture.newRate)
  #expect(newFinal.samples == fixture.oldOutputFrames + fixture.newOutputFrames)
  #expect(newFinal.inputFrames == Int64(fixture.oldFrameCount + fixture.newFrameCount))
  #expect(newFinal.inputSampleRate == fixture.newRate)
  #expect(abs(fixture.newOutputFrames - newExpected) <= 12)
  #expect(records.last?.inputFrames == newFinal.inputFrames)
  #expect(records.last?.inputSampleRate == fixture.newRate)
  #expect(src04InputTotalsDoNotRegress(records))

  let sharedOffsetIndexes = oldFinalIndex...(formatIndex + 1)
  #expect(sharedOffsetIndexes.allSatisfy { records[$0].byteOffset == transitionOffset })
  if fixture.path == .configurationChange {
    let configurationMarker = records[formatIndex - 1]
    #expect(configurationMarker.inputFrames == Int64(fixture.oldFrameCount))
    #expect(configurationMarker.inputSampleRate == fixture.oldRate)
  }

  let expectedAccountingIndexes = [1, oldFinalIndex + 1, formatIndex + 2, formatIndex + 3]
  let expectedAccountingDifferences: [Int64] = [
    0,
    fixture.oldOutputFrames - oldExpected,
    0,
    fixture.newOutputFrames - newExpected,
  ]
  #expect(fixture.report.converterAccountingRecords.map(\.index) == expectedAccountingIndexes)
  #expect(
    fixture.report.converterAccountingRecords.map(\.sampleDifference)
      == expectedAccountingDifferences)
  #expect(fixture.report.nativeDriftRecords.map(\.index) == expectedAccountingIndexes)
  #expect(
    fixture.report.discontinuities.map(\.kind)
      == expectedKinds.filter { $0 != "checkpoint" })
  #expect(fixture.report.currentTailBytes == 0)
  #expect(fixture.report.passed)
}

private func src04PublishAudio(
  _ ring: AudioRing,
  frameCount: Int,
  rate: Double,
  monoStartNS: UInt64,
  wallStartNS: UInt64
) throws {
  var samples = (0..<frameCount).map { index in
    Float(0.15 * sin(2 * Double.pi * Double(index % 257) / 257))
  }
  let duration = src04DurationNS(frameCount, rate: rate)
  let accepted = samples.withUnsafeMutableBufferPointer { buffer in
    var channel = buffer.baseAddress!
    return withUnsafePointer(to: &channel) { channels in
      ring.writeAudio(
        channels: channels,
        channelCount: 1,
        frameCount: frameCount,
        sampleRate: rate,
        monoStartNS: monoStartNS,
        monoEndNS: monoStartNS + duration,
        wallStartNS: wallStartNS,
        wallEndNS: wallStartNS + duration,
        boundaries: BoundaryBatch()
      )
    }
  }
  try #require(accepted)
}

private func src04ConvertedFrameCount(frameCount: Int, rate: Double) throws -> Int64 {
  let converter = try PCMResampler(inputSampleRate: rate)
  var samples = [Float](repeating: 0.125, count: frameCount)
  var outputFrames: Int64 = 0
  try samples.withUnsafeMutableBufferPointer { buffer in
    try converter.convert(samples: buffer.baseAddress!, frameCount: buffer.count) { _, count in
      outputFrames += Int64(count)
    }
  }
  try converter.finish { _, count in outputFrames += Int64(count) }
  return outputFrames
}

private func src04ReadRecords(_ directory: URL) throws -> [IndexRecord] {
  let pcmURL = directory.appendingPathComponent("tape.pcm")
  let pcmSize = try #require(
    (try FileManager.default.attributesOfItem(atPath: pcmURL.path)[.size] as? NSNumber)?
      .int64Value)
  return try IndexLog.read(
    url: directory.appendingPathComponent("tape.idx"),
    pcmSize: pcmSize
  ).records
}

private func src04InputTotalsDoNotRegress(_ records: [IndexRecord]) -> Bool {
  let totals = records.compactMap(\.inputFrames)
  return zip(totals, totals.dropFirst()).allSatisfy { $0 <= $1 }
}

private func src04RationalOutputFrames(_ inputFrames: Int64, rate: Int64) -> Int64 {
  let outputRate = Int64(TapeConstants.sampleRate)
  let wholeOutput = (inputFrames / rate) * outputRate
  let scaledRemainder = (inputFrames % rate) * outputRate
  let quotient = scaledRemainder / rate
  let remainder = scaledRemainder % rate
  return wholeOutput + quotient + (remainder * 2 >= rate ? 1 : 0)
}

private func src04DurationNS(_ frameCount: Int, rate: Double) -> UInt64 {
  UInt64((Double(frameCount) / rate * 1_000_000_000).rounded())
}

private func src04PastMonotonicNS() -> UInt64 {
  let now = monotonicNowNS()
  return now > 1_000_000_000 ? now - 1_000_000_000 : 1
}

private func src04PastWallNS() -> UInt64 {
  wallNowNS() - 1_000_000_000
}

private func src04WithTemporaryDirectory(_ body: (URL) throws -> Void) throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
    "src04-\(UUID().uuidString)",
    isDirectory: true
  )
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: directory) }
  try body(directory)
}
