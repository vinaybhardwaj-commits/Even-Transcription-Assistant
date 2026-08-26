struct CaptureObservation: Sendable {
  let frameCount: Int
  let sampleRate: Double
  let hostStartNS: UInt64?
  let sampleTime: Int64?
  let observedMonoNS: UInt64
  let observedWallNS: UInt64
}

struct CaptureFrameTiming: Sendable {
  let monoStartNS: UInt64
  let monoEndNS: UInt64
  let wallStartNS: UInt64
  let wallEndNS: UInt64
  let boundaries: BoundaryBatch
}

/// Callback-only timing state. Keeping classification pure of AVAudioEngine and global clocks makes
/// timestamp faults deterministic without moving allocation, locks, logging, or I/O onto the tap.
struct CaptureTimeline: Sendable {
  private static let hostDiscontinuityNS: UInt64 = 2_000_000
  private static let wallJumpNS: Int64 = 100_000_000

  private var resumeAfterNS: UInt64?
  private var expectedSampleTime: Int64?
  private var previousFrameEndNS: UInt64?
  private var previousWallOffsetNS: Int64?
  private var pendingBoundaries = BoundaryBatch()

  init(resumeAfterNS: UInt64? = nil) {
    self.resumeAfterNS = resumeAfterNS
  }

  mutating func classify(_ observation: CaptureObservation) -> CaptureFrameTiming {
    let startMono = observation.hostStartNS ?? observation.observedMonoNS
    let duration = UInt64(
      Double(observation.frameCount) / observation.sampleRate * 1_000_000_000)
    let endMono = startMono + duration
    let callbackLag =
      observation.observedMonoNS >= startMono
      ? observation.observedMonoNS - startMono
      : 0
    let startWall =
      observation.observedWallNS >= callbackLag
      ? observation.observedWallNS - callbackLag
      : observation.observedWallNS
    let endWall = startWall + duration

    if observation.hostStartNS == nil {
      pendingBoundaries.append(.invalidTimestamp, monoNS: startMono, wallNS: startWall)
    }
    if let sampleTime = observation.sampleTime {
      if let expectedSampleTime, sampleTime != expectedSampleTime {
        let gap = previousFrameEndNS.map { startMono >= $0 ? startMono - $0 : 0 } ?? 0
        pendingBoundaries.append(
          .captureDiscontinuity, monoNS: startMono, wallNS: startWall, gapNS: gap)
      }
      expectedSampleTime = sampleTime + Int64(observation.frameCount)
    } else {
      pendingBoundaries.append(.invalidTimestamp, monoNS: startMono, wallNS: startWall)
      expectedSampleTime = nil
    }
    if let previousEnd = previousFrameEndNS {
      let hostDelta = startMono >= previousEnd ? startMono - previousEnd : previousEnd - startMono
      if hostDelta > Self.hostDiscontinuityNS {
        pendingBoundaries.append(
          .captureDiscontinuity,
          monoNS: startMono,
          wallNS: startWall,
          gapNS: startMono >= previousEnd ? startMono - previousEnd : 0
        )
      }
    }
    let wallOffset = Int64(startWall) - Int64(startMono)
    if let previousOffset = previousWallOffsetNS {
      let offsetDelta =
        wallOffset >= previousOffset
        ? wallOffset - previousOffset
        : previousOffset - wallOffset
      if offsetDelta > Self.wallJumpNS {
        pendingBoundaries.append(
          .clockJump,
          monoNS: startMono,
          wallNS: startWall,
          gapNS: UInt64(offsetDelta)
        )
      }
    }
    previousWallOffsetNS = wallOffset
    previousFrameEndNS = endMono

    var publishedBoundaries = pendingBoundaries
    if let resumeAfterNS {
      publishedBoundaries.append(
        .resumed,
        monoNS: startMono,
        wallNS: startWall,
        gapNS: startMono >= resumeAfterNS ? startMono - resumeAfterNS : 0
      )
    }
    return CaptureFrameTiming(
      monoStartNS: startMono,
      monoEndNS: endMono,
      wallStartNS: startWall,
      wallEndNS: endWall,
      boundaries: publishedBoundaries
    )
  }

  mutating func didPublishFrame() {
    resumeAfterNS = nil
    pendingBoundaries.clear()
  }
}
