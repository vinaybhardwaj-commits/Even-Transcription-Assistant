import Foundation
import Testing

@testable import TapeCapture
@testable import TapeCore

@Suite(.serialized)
struct CaptureReadinessP1Tests {
  @Test func dgr01WriterPublishesOnlyDurableCheckpointGrowth() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let ring = AudioRing()
    let writer = TapeWriter(
      directory: directory,
      deviceUID: "dgr-01",
      ring: ring,
      checkpointIntervalNS: 0
    )

    try writer.startAndWaitUntilReady()
    let baseline = writer.durableCheckpointOffset
    #expect(baseline == 0)

    var samples = [Float](repeating: 0.25, count: 512)
    let frameCount = samples.count
    let accepted = samples.withUnsafeMutableBufferPointer { buffer in
      var channel = buffer.baseAddress!
      return withUnsafePointer(to: &channel) { channels in
        ring.writeAudio(
          channels: channels,
          channelCount: 1,
          frameCount: frameCount,
          sampleRate: 48_000,
          monoStartNS: 1,
          monoEndNS: 10_666_668,
          wallStartNS: 1,
          wallEndNS: 10_666_668,
          boundaries: BoundaryBatch(),
          captureGeneration: 7
        )
      }
    }
    #expect(accepted)

    let deadline = Date().addingTimeInterval(2)
    while writer.durableCheckpointOffset == baseline, !writer.hasFailed, Date() < deadline {
      Thread.sleep(forTimeInterval: 0.001)
    }
    try writer.throwFailure()
    let durableOffset = writer.durableCheckpointOffset
    #expect(durableOffset > baseline)
    #expect(
      writer.hasDurableGrowth(
        after: baseline,
        captureGeneration: 7,
        completedByNS: UInt64.max
      ))

    let index = try IndexLog.read(
      url: directory.appendingPathComponent("tape.idx"),
      pcmSize: durableOffset
    )
    #expect(index.records.last?.byteOffset == durableOffset)
    try writer.stopAndWait()
  }

  @Test func dgr02FirstCycleGrowthReturnsReadyWithoutRetry() throws {
    let fixture = ReadinessFixture(growthAtNS: 200)

    let result = try fixture.acquire()

    #expect(result.outcome == .ready)
    #expect(result.attempts == 1)
    #expect(result.session?.attempt == 1)
    #expect(fixture.starts == [1])
    #expect(fixture.stops.isEmpty)
  }

  @Test func dgr02WriterDoesNotCreditPriorGenerationToTheNextCapture() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let ring = AudioRing()
    let writer = TapeWriter(
      directory: directory,
      deviceUID: "dgr-02",
      ring: ring,
      checkpointIntervalNS: UInt64.max
    )
    try writer.startAndWaitUntilReady()
    let baseline = writer.durableCheckpointOffset

    #expect(writeReadinessAudio(to: ring, captureGeneration: 1, monoStartNS: 1))
    let drainDeadline = Date().addingTimeInterval(2)
    while !ring.isEmpty, !writer.hasFailed, Date() < drainDeadline {
      Thread.sleep(forTimeInterval: 0.001)
    }
    try writer.throwFailure()
    #expect(ring.isEmpty)
    #expect(ring.writeMarker(.resumed, monoNS: 20_000_000, wallNS: 20_000_000))
    let firstDeadline = Date().addingTimeInterval(2)
    while !writer.hasDurableGrowth(
      after: baseline,
      captureGeneration: 1,
      completedByNS: UInt64.max
    ), !writer.hasFailed, Date() < firstDeadline {
      Thread.sleep(forTimeInterval: 0.001)
    }
    try writer.throwFailure()
    #expect(
      writer.hasDurableGrowth(
        after: baseline,
        captureGeneration: 1,
        completedByNS: UInt64.max
      ))
    #expect(
      !writer.hasDurableGrowth(
        after: baseline,
        captureGeneration: 2,
        completedByNS: UInt64.max
      ))

    #expect(writeReadinessAudio(to: ring, captureGeneration: 2, monoStartNS: 30_000_000))
    #expect(ring.writeMarker(.configurationChange, monoNS: 50_000_000, wallNS: 50_000_000))
    let secondDeadline = Date().addingTimeInterval(2)
    while !writer.hasDurableGrowth(
      after: baseline,
      captureGeneration: 2,
      completedByNS: UInt64.max
    ), !writer.hasFailed, Date() < secondDeadline {
      Thread.sleep(forTimeInterval: 0.001)
    }
    try writer.throwFailure()
    #expect(
      writer.hasDurableGrowth(
        after: baseline,
        captureGeneration: 2,
        completedByNS: UInt64.max
      ))
    try writer.stopAndWait()
  }

  @Test func dgr03FirstRetryReResolvesStableUIDAndRecovers() throws {
    let fixture = ReadinessFixture(growthAtNS: 5_200)

    let result = try fixture.acquire()

    #expect(result.outcome == .ready)
    #expect(result.attempts == 2)
    #expect(fixture.starts == [1, 2])
    #expect(fixture.resolvedUIDs == ["stable-tonor", "stable-tonor"])
    #expect(fixture.resolvedDeviceIDs == [101, 102])
    #expect(fixture.stops == [1])
    #expect(fixture.nowNS == 5_200)
  }

  @Test func dgr04SecondRetryRecoversAfterTwoNoGrowthCycles() throws {
    let fixture = ReadinessFixture(growthAtNS: 10_200)

    let result = try fixture.acquire()

    #expect(result.outcome == .ready)
    #expect(result.attempts == 3)
    #expect(fixture.starts == [1, 2, 3])
    #expect(fixture.stops == [1, 2])
    #expect(fixture.resolvedUIDs.count == 3)
  }

  @Test func dgr05ThreeCyclesExhaustAtFifteenSeconds() throws {
    let fixture = ReadinessFixture()

    let result = try fixture.acquire()

    #expect(result.outcome == .physicalFallbackRequired)
    #expect(result.attempts == 3)
    #expect(result.session?.attempt == nil)
    #expect(fixture.nowNS == 15_000)
    #expect(fixture.starts == [1, 2, 3])
    #expect(fixture.stops == [1, 2, 3])
  }

  @Test func dgr05AttemptOverheadDoesNotResetTheRequestDeadline() throws {
    let policy = CaptureReadinessPolicy(
      maximumAttempts: 3,
      attemptWindowNS: 1_000,
      pollIntervalNS: 100
    )
    let fixture = ReadinessFixture(startDelaysNS: [1: 600, 2: 400])

    let result = try fixture.acquire(policy: policy)

    #expect(result.outcome == .physicalFallbackRequired)
    #expect(fixture.nowNS == 3_000)
    #expect(fixture.starts == [1, 2, 3])
  }

  @Test func dgr05ExpiredRetryWindowsCannotStartDelayedCapture() throws {
    let policy = CaptureReadinessPolicy(
      maximumAttempts: 3,
      attemptWindowNS: 1_000,
      pollIntervalNS: 100
    )
    let fixture = ReadinessFixture(startDelaysNS: [1: 3_500])

    let result = try fixture.acquire(policy: policy)

    #expect(result.outcome == .physicalFallbackRequired)
    #expect(result.attempts == 1)
    #expect(fixture.starts == [1])
    #expect(fixture.stops == [1])
  }

  @Test func dgr06EngineActivityWithoutDurableGrowthIsNotReady() throws {
    let fixture = ReadinessFixture()
    fixture.engineActivityObserved = true

    let result = try fixture.acquire()

    #expect(fixture.engineActivityObserved)
    #expect(result.outcome == .physicalFallbackRequired)
    #expect(fixture.durableOffset == 0)
  }

  @Test func dgr06LatePriorAttemptGrowthCannotReadyTheNextAttempt() throws {
    let fixture = ReadinessFixture(growthAtNS: 5_200, growthGeneration: 1)

    let result = try fixture.acquire()

    #expect(result.outcome == .physicalFallbackRequired)
    #expect(fixture.durableGeneration == 1)
    #expect(fixture.starts == [1, 2, 3])
  }

  @Test func dgr07CancellationDuringRetryCannotStartLaterCapture() throws {
    let fixture = ReadinessFixture(cancelAtNS: 5_200)

    let result = try fixture.acquire()

    #expect(result.outcome == .cancelled)
    #expect(result.attempts == 2)
    #expect(fixture.starts == [1, 2])
    #expect(fixture.stops == [1, 2])
    fixture.nowNS = 100_000
    #expect(fixture.starts == [1, 2])
    #expect(fixture.activeAttempts == 0)
  }

  @Test func dgr07CancellationBeforeAcquisitionStartsNothing() throws {
    let fixture = ReadinessFixture()
    fixture.cancelled = true

    let result = try fixture.acquire()

    #expect(result.outcome == .cancelled)
    #expect(result.attempts == 0)
    #expect(fixture.starts.isEmpty)
    #expect(fixture.stops.isEmpty)
  }

  @Test func dgr07CancellationDuringConstructionStopsAndCannotRetry() throws {
    let fixture = ReadinessFixture(cancelDuringStartAttempts: [1])

    let result = try fixture.acquire()

    #expect(result.outcome == .cancelled)
    #expect(fixture.starts == [1])
    #expect(fixture.stops == [1])
  }

  @Test func dgr07CancellationOutranksSimultaneousGrowth() throws {
    let fixture = ReadinessFixture(growthAtNS: 200, cancelAtNS: 200)

    let result = try fixture.acquire()

    #expect(result.outcome == .cancelled)
    #expect(fixture.starts == [1])
    #expect(fixture.stops == [1])
  }

  @Test func dgr07CancellationCountsOnlyStartedAttemptsAfterExpiredWindow() throws {
    let policy = CaptureReadinessPolicy(
      maximumAttempts: 3,
      attemptWindowNS: 1_000,
      pollIntervalNS: 100
    )
    let fixture = ReadinessFixture(
      startDelaysNS: [1: 2_500],
      cancelDuringStartAttempts: [3]
    )

    let result = try fixture.acquire(policy: policy)

    #expect(result.outcome == .cancelled)
    #expect(result.attempts == 2)
    #expect(fixture.starts == [1, 3])
    #expect(fixture.stops == [1, 3])
  }

  @Test func dgr07WriterFailureStopsTheActiveAttemptAndDoesNotRetry() {
    let fixture = ReadinessFixture(writerFailureAtNS: 200)

    do {
      _ = try fixture.acquire()
      Issue.record("writer failure should escape the acquisition coordinator")
    } catch is SyntheticWriterError {
    } catch {
      Issue.record("unexpected error: \(error)")
    }

    #expect(fixture.starts == [1])
    #expect(fixture.stops == [1])
    #expect(fixture.activeAttempts == 0)
  }

  @Test func dgr08AttemptsNeverOverlap() throws {
    let fixture = ReadinessFixture()

    let result = try fixture.acquire()

    #expect(result.outcome == .physicalFallbackRequired)
    #expect(fixture.maximumActiveAttempts == 1)
    #expect(fixture.activeAttempts == 0)
    #expect(fixture.events == ["start1", "stop1", "start2", "stop2", "start3", "stop3"])
  }

  @Test func dgr09RestartRequiresGrowthBeyondItsOwnBaseline() throws {
    let policy = CaptureReadinessPolicy(
      maximumAttempts: 1,
      attemptWindowNS: 1_000,
      pollIntervalNS: 100
    )
    let stale = ReadinessFixture(durableOffset: 42)

    let staleResult = try stale.acquire(policy: policy, baselineDurableOffset: 42)

    #expect(staleResult.outcome == .physicalFallbackRequired)

    let restarted = ReadinessFixture(durableOffset: 42, growthAtNS: 200)
    let restartedResult = try restarted.acquire(policy: policy, baselineDurableOffset: 42)

    #expect(restartedResult.outcome == .ready)
    #expect(restarted.durableOffset == 43)
  }

  @Test func dgr09PreDeadlineGrowthSurvivesLatePollingWake() throws {
    let policy = CaptureReadinessPolicy(
      maximumAttempts: 1,
      attemptWindowNS: 1_000,
      pollIntervalNS: 100
    )
    let beforeDeadline = ReadinessFixture(growthAtNS: 900, extraSleepNS: 300)
    let afterDeadline = ReadinessFixture(growthAtNS: 1_100, extraSleepNS: 300)

    let ready = try beforeDeadline.acquire(policy: policy)
    let fallback = try afterDeadline.acquire(policy: policy)

    #expect(ready.outcome == .ready)
    #expect(fallback.outcome == .physicalFallbackRequired)
  }
}

private struct ReadinessSession {
  let attempt: Int
}

private struct SyntheticAcquisitionError: Error {}
private struct SyntheticWriterError: Error {}

private final class ReadinessFixture {
  private let defaultPolicy = CaptureReadinessPolicy(
    maximumAttempts: 3,
    attemptWindowNS: 5_000,
    pollIntervalNS: 100
  )
  private let growthAtNS: UInt64?
  private let cancelAtNS: UInt64?
  private let startFailures: Set<Int>
  private let writerFailureAtNS: UInt64?
  private let growthGeneration: Int?
  private let startDelaysNS: [Int: UInt64]
  private let cancelDuringStartAttempts: Set<Int>
  private let extraSleepNS: UInt64
  var nowNS: UInt64 = 0
  var durableOffset: Int64
  var durableGeneration = 0
  var durableCompletedAtNS: UInt64 = 0
  var cancelled = false
  var engineActivityObserved = false
  var starts: [Int] = []
  var stops: [Int] = []
  var resolvedUIDs: [String] = []
  var resolvedDeviceIDs: [Int] = []
  var events: [String] = []
  var activeAttempts = 0
  var currentAttempt = 0
  var maximumActiveAttempts = 0

  init(
    durableOffset: Int64 = 0,
    growthAtNS: UInt64? = nil,
    cancelAtNS: UInt64? = nil,
    startFailures: Set<Int> = [],
    writerFailureAtNS: UInt64? = nil,
    growthGeneration: Int? = nil,
    startDelaysNS: [Int: UInt64] = [:],
    cancelDuringStartAttempts: Set<Int> = [],
    extraSleepNS: UInt64 = 0
  ) {
    self.durableOffset = durableOffset
    self.growthAtNS = growthAtNS
    self.cancelAtNS = cancelAtNS
    self.startFailures = startFailures
    self.writerFailureAtNS = writerFailureAtNS
    self.growthGeneration = growthGeneration
    self.startDelaysNS = startDelaysNS
    self.cancelDuringStartAttempts = cancelDuringStartAttempts
    self.extraSleepNS = extraSleepNS
  }

  func acquire(
    policy: CaptureReadinessPolicy? = nil,
    baselineDurableOffset: Int64 = 0
  ) throws -> CaptureReadinessResult<ReadinessSession> {
    try CaptureReadinessCoordinator.acquire(
      policy: policy ?? defaultPolicy,
      isCancelled: { self.cancelled },
      nowNS: { self.nowNS },
      sleepNS: { interval in
        self.nowNS += interval + self.extraSleepNS
        if let growthAtNS = self.growthAtNS, self.nowNS >= growthAtNS,
          self.durableOffset == baselineDurableOffset
        {
          self.durableOffset += 1
          self.durableGeneration = self.growthGeneration ?? self.currentAttempt
          self.durableCompletedAtNS = growthAtNS
        }
        if let cancelAtNS = self.cancelAtNS, self.nowNS >= cancelAtNS {
          self.cancelled = true
        }
      },
      hasDurableGrowth: { attempt, deadlineNS in
        self.durableOffset > baselineDurableOffset
          && self.durableGeneration == attempt
          && self.durableCompletedAtNS <= deadlineNS
      },
      checkWriter: {
        if let writerFailureAtNS = self.writerFailureAtNS, self.nowNS >= writerFailureAtNS {
          throw SyntheticWriterError()
        }
      },
      startAttempt: { attempt in
        self.starts.append(attempt)
        self.resolvedUIDs.append("stable-tonor")
        self.resolvedDeviceIDs.append(100 + attempt)
        self.nowNS += self.startDelaysNS[attempt] ?? 0
        if self.startFailures.contains(attempt) { throw SyntheticAcquisitionError() }
        self.activeAttempts += 1
        self.currentAttempt = attempt
        self.maximumActiveAttempts = max(self.maximumActiveAttempts, self.activeAttempts)
        self.events.append("start\(attempt)")
        if self.cancelDuringStartAttempts.contains(attempt) { self.cancelled = true }
        return ReadinessSession(attempt: attempt)
      },
      stopAttempt: { session in
        self.activeAttempts -= 1
        self.currentAttempt = 0
        self.stops.append(session.attempt)
        self.events.append("stop\(session.attempt)")
      }
    )
  }
}

private func writeReadinessAudio(
  to ring: AudioRing,
  captureGeneration: UInt64,
  monoStartNS: UInt64
) -> Bool {
  var samples = [Float](repeating: 0.25, count: 512)
  let frameCount = samples.count
  return samples.withUnsafeMutableBufferPointer { buffer in
    var channel = buffer.baseAddress!
    return withUnsafePointer(to: &channel) { channels in
      ring.writeAudio(
        channels: channels,
        channelCount: 1,
        frameCount: frameCount,
        sampleRate: 48_000,
        monoStartNS: monoStartNS,
        monoEndNS: monoStartNS + 10_666_667,
        wallStartNS: monoStartNS,
        wallEndNS: monoStartNS + 10_666_667,
        boundaries: BoundaryBatch(),
        captureGeneration: captureGeneration
      )
    }
  }
}
