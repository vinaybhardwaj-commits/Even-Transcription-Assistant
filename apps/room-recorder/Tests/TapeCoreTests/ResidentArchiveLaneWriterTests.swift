import Foundation
import Testing

@testable import TapeCapture
@testable import TapeCore

@Suite(.serialized) struct ResidentArchiveLaneWriterTests {
  private let rootKey = Data(UInt8(0)...UInt8(31))

  @Test func durableGrowthMeansAuthenticatedTapeAndIndexGrowth() throws {
    let fixture = try makeFixture("durable-growth")
    defer { fixture.remove() }
    let ring = AudioRing(slotCount: 32, framesPerSlot: 8_000)
    let writer = ResidentArchiveLaneWriter(ring: ring, store: try fixture.open(rootKey: rootKey))

    try writer.start()
    #expect(
      try !writer.waitForDurableGrowth(
        after: 0, captureGeneration: 1, timeout: 0.01))
    try enqueueTone(blockCount: 6, captureGeneration: 1, ring: ring)
    #expect(
      try writer.waitForDurableGrowth(
        after: 0, captureGeneration: 1, timeout: 3))
    #expect(writer.durableSampleEnd == 16_000)
    #expect(writer.currentLevels?.averageQ15 ?? 0 > 0)
    #expect(writer.currentLevels?.peakQ15 ?? 0 > 0)

    try writer.stopAndWait()
    try writer.stopAndWait()
    #expect(!writer.isRunning)
    #expect(
      try !writer.waitForDurableGrowth(
        after: 0, captureGeneration: 1, timeout: 0.01))

    let snapshot = try fixture.snapshot(rootKey: rootKey)
    defer { snapshot.close() }
    let authenticated = try snapshot.readPCMRange(sampleStart: 0, sampleEnd: 16_000)
    #expect(authenticated.pcm.count == 32_000)
    #expect(authenticated.pcm.contains { $0 != 0 })
    let record = try #require(authenticated.indexRecords.only)
    #expect(record.payload.sampleStart == 0)
    #expect(record.payload.sampleEnd == 16_000)
    #expect(record.payload.nativeFrames == 48_000)
    #expect(record.payload.inputRateNumerator == 48_000)
    #expect(record.payload.inputRateDenominator == 1)
    #expect(snapshot.authenticatedFacts.authenticatedSampleEnd == 16_011)
    #expect(snapshot.indexRecords.last?.payload.nativeFrames == 0)
  }

  @Test func stopDrainsShortBoundaryAndAttachesPendingDiscontinuity() throws {
    let fixture = try makeFixture("short-boundary")
    defer { fixture.remove() }
    let ring = AudioRing(slotCount: 32, framesPerSlot: 8_000)
    let writer = ResidentArchiveLaneWriter(ring: ring, store: try fixture.open(rootKey: rootKey))

    try writer.start()
    try enqueueTone(blockCount: 6, captureGeneration: 7, ring: ring)
    #expect(ring.writeMarker(.deviceLost, monoNS: 2_000_000_000, wallNS: 4_000_000_000))
    try enqueueTone(
      blockCount: 3,
      captureGeneration: 7,
      startingBlock: 6,
      ring: ring)
    try writer.stopAndWait()

    let snapshot = try fixture.snapshot(rootKey: rootKey)
    defer { snapshot.close() }
    let records = snapshot.indexRecords
    #expect(records.count == 3)
    #expect(records[0].payload.sampleStart == 0)
    #expect(records[0].payload.sampleEnd == 16_000)
    #expect(records[0].payload.nativeFrames == 48_000)
    #expect(records[1].payload.sampleStart == 16_000)
    #expect(records[1].payload.nativeFrames == 0)
    #expect(records[2].payload.nativeFrames == 24_000)
    #expect(records[0].payload.discontinuity == nil)
    #expect(records[1].payload.discontinuity == nil)
    #expect(records[2].payload.discontinuity == .deviceLost)
    #expect(records[2].payload.reason == "device_lost")
    let sampleEnd = try #require(records.last?.payload.sampleEnd)
    #expect(sampleEnd == 24_022)
    let authenticated = try snapshot.readPCMRange(sampleStart: 0, sampleEnd: sampleEnd)
    #expect(authenticated.pcm.count == Int(sampleEnd) * 2)
  }

  @Test func ringPermitsExactlyOneWriterConsumerAtATime() throws {
    let firstFixture = try makeFixture("single-consumer-first")
    let secondFixture = try makeFixture("single-consumer-second")
    defer {
      firstFixture.remove()
      secondFixture.remove()
    }
    let ring = AudioRing()
    let first = ResidentArchiveLaneWriter(
      ring: ring,
      store: try firstFixture.open(rootKey: rootKey))
    let second = ResidentArchiveLaneWriter(
      ring: ring,
      store: try secondFixture.open(rootKey: rootKey))

    try first.start()
    #expect(throws: ResidentArchiveLaneWriterError.ringAlreadyHasConsumer) {
      try second.start()
    }
    try first.stopAndWait()
    try second.start()
    try second.stopAndWait()
  }

  @Test func readinessDoesNotMaskFailureAfterDurableGrowth() throws {
    let fixture = try makeFixture("readiness-failure")
    defer { fixture.remove() }
    let ring = AudioRing(slotCount: 32, framesPerSlot: 8_000)
    let writer = ResidentArchiveLaneWriter(ring: ring, store: try fixture.open(rootKey: rootKey))

    try writer.start()
    try enqueueTone(blockCount: 6, captureGeneration: 3, ring: ring)
    try enqueueTone(
      blockCount: 1,
      captureGeneration: 3,
      startingBlock: 6,
      sampleRate: .nan,
      ring: ring)
    let deadline = Date().addingTimeInterval(3)
    while !writer.hasFailed, Date() < deadline {
      Thread.sleep(forTimeInterval: 0.005)
    }
    #expect(writer.hasFailed)
    do {
      _ = try writer.waitForDurableGrowth(
        after: 0, captureGeneration: 3, timeout: 0.01)
      Issue.record("failed writer reported durable readiness")
    } catch ResidentArchiveLaneWriterError.invalidInputSampleRate(let rate) {
      #expect(rate.isNaN)
    } catch {
      Issue.record("unexpected readiness failure: \(error)")
    }
    try? writer.stopAndWait()
  }

  @Test func nativeFrameAccountingSurvivesFortyFourPointOneKilohertzFinalization() throws {
    let fixture = try makeFixture("native-accounting")
    defer { fixture.remove() }
    let ring = AudioRing(slotCount: 32, framesPerSlot: 7_350)
    let writer = ResidentArchiveLaneWriter(ring: ring, store: try fixture.open(rootKey: rootKey))

    try writer.start()
    try enqueueTone(
      blockCount: 6,
      captureGeneration: 9,
      framesPerBlock: 7_350,
      sampleRate: 44_100,
      ring: ring)
    try writer.stopAndWait()

    let snapshot = try fixture.snapshot(rootKey: rootKey)
    defer { snapshot.close() }
    #expect(snapshot.indexRecords.compactMap(\.payload.nativeFrames).reduce(0, +) == 44_100)
    #expect(snapshot.indexRecords.allSatisfy { $0.payload.inputRateNumerator == 44_100 })
    #expect(snapshot.indexRecords.allSatisfy { $0.payload.inputRateDenominator == 1 })
  }

  @Test func authenticatedRestartContinuesSamplesAndMarksFirstNewRecord() throws {
    let fixture = try makeFixture("restart")
    defer { fixture.remove() }

    let firstRing = AudioRing(slotCount: 32, framesPerSlot: 8_000)
    let first = ResidentArchiveLaneWriter(
      ring: firstRing,
      store: try fixture.open(rootKey: rootKey))
    try first.start()
    try enqueueTone(blockCount: 6, captureGeneration: 1, ring: firstRing)
    try first.stopAndWait()
    let restartSample = first.durableSampleEnd

    let secondRing = AudioRing(slotCount: 32, framesPerSlot: 8_000)
    let second = ResidentArchiveLaneWriter(
      ring: secondRing,
      store: try fixture.open(rootKey: rootKey))
    #expect(second.durableSampleEnd == restartSample)
    try second.start()
    try enqueueTone(blockCount: 6, captureGeneration: 2, ring: secondRing)
    #expect(
      try second.waitForDurableGrowth(
        after: restartSample, captureGeneration: 2, timeout: 3))
    try second.stopAndWait()

    let snapshot = try fixture.snapshot(rootKey: rootKey)
    defer { snapshot.close() }
    let firstNewRecord = try #require(
      snapshot.indexRecords.first { $0.payload.sampleStart == restartSample })
    #expect(firstNewRecord.payload.sampleEnd == restartSample + 16_000)
    #expect(firstNewRecord.payload.discontinuity == .restart)
    #expect(firstNewRecord.payload.reason == "restart")
    let finalSample = snapshot.authenticatedFacts.authenticatedSampleEnd
    #expect(finalSample == restartSample + 16_011)
    let authenticated = try snapshot.readPCMRange(sampleStart: 0, sampleEnd: finalSample)
    #expect(authenticated.pcm.count == Int(finalSample) * 2)
  }

  @Test func captureFacadeStartsOnlyAfterGenerationSpecificDurableGrowthAndDrains() throws {
    let fixture = try makeFixture("capture-facade")
    defer { fixture.remove() }
    let ring = AudioRing(slotCount: 32, framesPerSlot: 8_000)
    let writer = ResidentArchiveLaneWriter(ring: ring, store: try fixture.open(rootKey: rootKey))
    let captured = SyntheticResidentCaptureSession()
    let lane = ResidentAudioCaptureLane(
      ring: ring,
      writer: writer,
      sessionFactory: { generation, _ in
        try enqueueTone(blockCount: 6, captureGeneration: UInt64(generation), ring: ring)
        return captured
      })

    try lane.startAndWaitUntilDurable()
    #expect(lane.isActive)
    #expect(lane.requiresFinalization)
    #expect(lane.durableSampleEnd == 16_000)
    #expect(lane.currentLevels?.averageQ15 ?? 0 > 0)
    try lane.service()

    try lane.stopAndDrain()
    try lane.stopAndDrain()
    #expect(captured.stopCount == 1)
    #expect(!lane.isActive)
    #expect(!lane.requiresFinalization)

    let snapshot = try fixture.snapshot(rootKey: rootKey)
    defer { snapshot.close() }
    #expect(snapshot.authenticatedFacts.authenticatedSampleEnd == 16_011)
  }

  @Test func captureFacadeAuthorizationFailureDoesNotClaimRingOrStartWriter() throws {
    let fixture = try makeFixture("capture-authorization")
    defer { fixture.remove() }
    let ring = AudioRing()
    let writer = ResidentArchiveLaneWriter(ring: ring, store: try fixture.open(rootKey: rootKey))
    var sessionFactoryCalled = false
    let lane = ResidentAudioCaptureLane(
      ring: ring,
      writer: writer,
      authorize: { throw ResidentCaptureFixtureError.authorizationDenied },
      sessionFactory: { _, _ in
        sessionFactoryCalled = true
        return SyntheticResidentCaptureSession()
      })

    #expect(throws: ResidentCaptureFixtureError.authorizationDenied) {
      try lane.startAndWaitUntilDurable()
    }
    #expect(!sessionFactoryCalled)
    #expect(!lane.isActive)
    #expect(!lane.requiresFinalization)
    #expect(ring.claimConsumer())
    ring.releaseConsumer()
  }

  @Test func captureFacadeUnexpectedStopRequiresFinalDrain() throws {
    let fixture = try makeFixture("capture-unexpected-stop")
    defer { fixture.remove() }
    let ring = AudioRing(slotCount: 32, framesPerSlot: 8_000)
    let writer = ResidentArchiveLaneWriter(ring: ring, store: try fixture.open(rootKey: rootKey))
    let captured = SyntheticResidentCaptureSession()
    let lane = ResidentAudioCaptureLane(
      ring: ring,
      writer: writer,
      sessionFactory: { generation, _ in
        try enqueueTone(blockCount: 6, captureGeneration: UInt64(generation), ring: ring)
        return captured
      })
    try lane.startAndWaitUntilDurable()

    captured.stoppedProducing = true
    #expect(throws: ResidentAudioCaptureLaneError.stoppedUnexpectedly) {
      try lane.service()
    }
    #expect(!lane.isActive)
    #expect(lane.requiresFinalization)
    try lane.stopAndDrain()
    #expect(!lane.requiresFinalization)
  }

  @Test func captureFacadeRejectsDurableGrowthFromAnAlreadyStoppedProducer() throws {
    let fixture = try makeFixture("capture-dead-readiness")
    defer { fixture.remove() }
    let ring = AudioRing(slotCount: 32, framesPerSlot: 8_000)
    let writer = ResidentArchiveLaneWriter(ring: ring, store: try fixture.open(rootKey: rootKey))
    let captured = SyntheticResidentCaptureSession()
    captured.stoppedProducing = true
    let lane = ResidentAudioCaptureLane(
      ring: ring,
      writer: writer,
      sessionFactory: { generation, _ in
        try enqueueTone(blockCount: 6, captureGeneration: UInt64(generation), ring: ring)
        return captured
      })

    #expect(throws: ResidentAudioCaptureLaneError.stoppedUnexpectedly) {
      try lane.startAndWaitUntilDurable()
    }
    #expect(!lane.isActive)
    #expect(!lane.requiresFinalization)
    #expect(captured.stopCount == 1)
  }

  @Test func captureFacadeSerializesConcurrentFinalization() throws {
    let fixture = try makeFixture("capture-concurrent-stop")
    defer { fixture.remove() }
    let ring = AudioRing(slotCount: 32, framesPerSlot: 8_000)
    let writer = ResidentArchiveLaneWriter(ring: ring, store: try fixture.open(rootKey: rootKey))
    let captured = SyntheticResidentCaptureSession()
    let lane = ResidentAudioCaptureLane(
      ring: ring,
      writer: writer,
      sessionFactory: { generation, _ in
        try enqueueTone(blockCount: 6, captureGeneration: UInt64(generation), ring: ring)
        return captured
      })
    try lane.startAndWaitUntilDurable()

    let errors = ResidentCaptureErrorCollector()
    let group = DispatchGroup()
    for _ in 0..<4 {
      group.enter()
      DispatchQueue.global().async {
        defer { group.leave() }
        do {
          try lane.stopAndDrain()
        } catch {
          errors.append(error)
        }
      }
    }
    group.wait()

    #expect(errors.values.isEmpty)
    #expect(captured.stopCount == 1)
    #expect(!lane.requiresFinalization)
  }

  @Test func captureFacadeDeinitDoesNotStrandRingOrArchiveOwner() throws {
    let fixture = try makeFixture("capture-deinit")
    defer { fixture.remove() }
    let ring = AudioRing(slotCount: 32, framesPerSlot: 8_000)
    let captured = SyntheticResidentCaptureSession()
    var lane: ResidentAudioCaptureLane? = ResidentAudioCaptureLane(
      ring: ring,
      writer: ResidentArchiveLaneWriter(ring: ring, store: try fixture.open(rootKey: rootKey)),
      sessionFactory: { generation, _ in
        try enqueueTone(blockCount: 6, captureGeneration: UInt64(generation), ring: ring)
        return captured
      })
    try lane?.startAndWaitUntilDurable()

    lane = nil

    #expect(captured.stopCount == 1)
    #expect(ring.claimConsumer())
    ring.releaseConsumer()
    let snapshot = try fixture.snapshot(rootKey: rootKey)
    snapshot.close()
  }

  @Test func captureFacadeStopCancelsAnInflightReadinessAttempt() throws {
    let fixture = try makeFixture("capture-start-cancellation")
    defer { fixture.remove() }
    let ring = AudioRing()
    let writer = ResidentArchiveLaneWriter(ring: ring, store: try fixture.open(rootKey: rootKey))
    let captured = SyntheticResidentCaptureSession()
    let attemptStarted = DispatchSemaphore(value: 0)
    let lane = ResidentAudioCaptureLane(
      ring: ring,
      writer: writer,
      sessionFactory: { _, _ in
        attemptStarted.signal()
        return captured
      })
    let startupErrors = ResidentCaptureErrorCollector()
    let startup = DispatchGroup()
    startup.enter()
    DispatchQueue.global().async {
      defer { startup.leave() }
      do {
        try lane.startAndWaitUntilDurable()
      } catch {
        startupErrors.append(error)
      }
    }
    #expect(attemptStarted.wait(timeout: .now() + 2) == .success)

    try lane.stopAndDrain()
    startup.wait()

    #expect(
      startupErrors.values.contains {
        ($0 as? ResidentAudioCaptureLaneError) == .cancelled
      })
    #expect(captured.stopCount == 1)
    #expect(!lane.isActive)
    #expect(!lane.requiresFinalization)
  }

  private func enqueueTone(
    blockCount: Int,
    captureGeneration: UInt64,
    startingBlock: Int = 0,
    framesPerBlock: Int = 8_000,
    sampleRate: Double = 48_000,
    ring: AudioRing
  ) throws {
    let timingRate = sampleRate.isFinite ? sampleRate : 48_000
    let blockDurationNS = UInt64((Double(framesPerBlock) / timingRate * 1_000_000_000).rounded())
    var samples = [Float](repeating: 0, count: framesPerBlock)
    for block in startingBlock..<(startingBlock + blockCount) {
      for frame in samples.indices {
        let phase = Double(block * framesPerBlock + frame) * 2 * Double.pi * 440 / timingRate
        samples[frame] = Float(0.2 * sin(phase))
      }
      let monoStart = 1_000_000_000 + UInt64(block) * blockDurationNS
      let monoEnd = monoStart + blockDurationNS
      let wallStart = 3_000_000_000 + UInt64(block) * blockDurationNS
      let wallEnd = wallStart + blockDurationNS
      let accepted = samples.withUnsafeMutableBufferPointer { buffer in
        var channel = buffer.baseAddress!
        return withUnsafePointer(to: &channel) { channels in
          ring.writeAudio(
            channels: channels,
            channelCount: 1,
            frameCount: framesPerBlock,
            sampleRate: sampleRate,
            monoStartNS: monoStart,
            monoEndNS: monoEnd,
            wallStartNS: wallStart,
            wallEndNS: wallEnd,
            boundaries: BoundaryBatch(),
            captureGeneration: captureGeneration
          )
        }
      }
      guard accepted else { throw ResidentWriterFixtureError.ringRejectedFixtureAudio }
    }
  }

  private func makeFixture(_ name: String) throws -> ResidentWriterLaneFixture {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "eta-resident-writer-\(name)-\(UUID().uuidString)",
      isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    return ResidentWriterLaneFixture(directory: directory)
  }
}

private enum ResidentWriterFixtureError: Error {
  case ringRejectedFixtureAudio
}

private enum ResidentCaptureFixtureError: Error {
  case authorizationDenied
}

private final class SyntheticResidentCaptureSession: ResidentAudioCaptureSession {
  private let lock = NSLock()
  private var stoppedProducingValue = false
  private var stopCountValue = 0

  var stoppedProducing: Bool {
    get { lock.withLock { stoppedProducingValue } }
    set { lock.withLock { stoppedProducingValue = newValue } }
  }

  var stopCount: Int { lock.withLock { stopCountValue } }
  var hasStoppedProducing: Bool { stoppedProducing }
  var lastAcceptedFrameEnd: (monoNS: UInt64, wallNS: UInt64)? {
    (monoNS: 2_000_000_000, wallNS: 4_000_000_000)
  }

  func stop() {
    lock.withLock {
      stopCountValue += 1
      stoppedProducingValue = true
    }
  }
}

private final class ResidentCaptureErrorCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [Error] = []

  var values: [Error] { lock.withLock { storage } }
  func append(_ error: Error) { lock.withLock { storage.append(error) } }
}

private struct ResidentWriterLaneFixture {
  let directory: URL

  var tape: URL { directory.appendingPathComponent("primary.tape") }
  var index: URL { directory.appendingPathComponent("primary.index") }
  var context: ArchiveContext {
    ArchiveContext(
      streamUUID: Data([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
      roomID: "room_resident_writer",
      istDate: "2026-08-28",
      laneID: "primary",
      stableDeviceUID: "AppleUSBAudioEngine:resident-writer"
    )
  }

  func open(rootKey: Data) throws -> ArchiveLaneStore {
    try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: tape,
      indexURL: index,
      rootKey: rootKey,
      context: context)
  }

  func snapshot(rootKey: Data) throws -> ArchiveLaneStore.AuthenticatedSnapshot {
    try ArchiveLaneStore.openAuthenticatedSnapshot(
      tapeURL: tape,
      indexURL: index,
      rootKey: rootKey,
      context: context)
  }

  func remove() {
    try? FileManager.default.removeItem(at: directory)
  }
}

extension Array {
  fileprivate var only: Element? { count == 1 ? self[0] : nil }
}
