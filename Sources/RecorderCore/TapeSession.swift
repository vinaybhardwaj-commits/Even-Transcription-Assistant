// The writer: ring → decimator → tape. Shared by room-recorder and by the conformance generator, so a synthetic
// rollover fixture is written by exactly the code that records a real one. No ALSA, no threads, no clocks of its own.
import CaptureCore
import Foundation
import TapeConvert
import TapeCore

/// Record timing, cadence, levels, input_frames and gap_ns follow the Mac source as read in
/// ETA-U1-RECORD-FIELDS-MAC-GROUND-TRUTH-14-SEP-2026.md and the step 5 grounding; see spec/RECORDER-RECORDS-LINUX.md.
public final class TapeSession {
    /// Mac TapeWriter.swift:11/29/36 — 1.25 s on the monotonic clock, a floor checked per consumed chunk, not a timer.
    public static let checkpointIntervalNS: Int64 = 1_250_000_000
    public static let chunkFrames = 1_200

    public enum Step { case progressed, empty }

    public let writer: TapeWriter
    let ring: FrameRing
    let arrival: ArrivalClock
    let monoNow: () -> Int64
    let wallNow: () -> Int64
    /// Every input frame fed to the converter, in order (test hook builds only set it).
    public var tee: (([UInt8]) -> Void)?

    var decimator = StereoDecimator()
    /// Running total of input frames fed to the converter, seeded from the prior tape (Mac :152); never reset.
    var consumed: Int64
    /// Mac currentInputSampleRate != nil. Declared per run() (TapeWriter.swift:153), set by the first audio buffer and
    /// cleared only by a format change (:290): a device loss or a new capture session keeps it; a restarted process
    /// does not have it until its own first audio.
    public private(set) var audioArrived = false
    /// Mac needsCaptureAnchor: true at open and set by every discontinuity() (TapeWriter.swift:288-292). The check at
    /// :339-341 is reached only for an audio item (a marker returns early at :323-326), so the anchor is DEFERRED to the
    /// first audio after any run of markers: adjacent markers (device_lost then resumed) get no anchor between them.
    var needsCaptureAnchor = true
    var pendingGap: FrameRing.OverflowEvent? = nil
    /// Mac latestAudioMonoNS/WallNS: END of the most recent consumed input; nil after a discontinuity.
    var latestEnd: (Int64, Int64)? = nil
    var lastCheckpointNow: Int64
    var chunk: [UInt8] = []
    var out: [Int16] = []

    public init(writer: TapeWriter, ring: FrameRing, arrival: ArrivalClock, monoNow: @escaping () -> Int64, wallNow: @escaping () -> Int64) {
        self.writer = writer
        self.ring = ring
        self.arrival = arrival
        self.monoNow = monoNow
        self.wallNow = wallNow
        consumed = writer.prior?.lastInputFrames ?? 0
        lastCheckpointNow = monoNow()
    }

    /// input_frames for a discontinuity or `stopped` record: absent while currentInputSampleRate is nil (TapeWriter.swift:285),
    /// i.e. until this run's first audio. A prior tape's input_frames seeds the running total (:152) but not the rate.
    var recordInputFrames: Int64? { audioArrived ? consumed : nil }

    func startOf(_ f: Int64) -> (Int64, Int64) { arrival.start(of: f).map { ($0.monoNS, $0.wallNS) } ?? (monoNow(), wallNow()) }
    func endOf(_ f: Int64) -> (Int64, Int64) { arrival.end(of: f).map { ($0.monoNS, $0.wallNS) } ?? (monoNow(), wallNow()) }

    func checkpoint(_ t: (Int64, Int64)) throws {
        try writer.checkpoint(monoNS: t.0, wallNS: t.1, inputFrames: consumed)
        lastCheckpointNow = monoNow()
    }

    /// The record written when audio returns after a gap, stamped with the START of the new-side buffer.
    /// gap_ns is a monotonic delta clamped to zero (CaptureTimeline.swift:59,75,103; AudioRing.swift:191,264,338,355).
    func resumeRecord(_ gap: FrameRing.OverflowEvent, newSideStart: (Int64, Int64)) throws {
        let cause: String, gapNS: Int64
        switch gap.cause {
        case "ring_overflow":
            cause = "ring_overflow"
            gapNS = max(0, newSideStart.0 - startOf(gap.firstFrame).0)      // from the start of the first dropped frame
        case "device_lost":
            cause = "resumed"
            gapNS = max(0, newSideStart.0 - (gap.monoNS ?? newSideStart.0))  // from the moment the loss was detected
        default:
            cause = gap.cause
            gapNS = max(0, newSideStart.0 - endOf(gap.firstFrame - 1).0)     // from the end of the last frame before
        }
        try writer.discontinuity(cause: cause, gapNS: gapNS,
                                 droppedInputFrames: gap.cause == "ring_overflow" ? gap.frames : nil,
                                 monoNS: newSideStart.0, wallNS: newSideStart.1, inputFrames: recordInputFrames)
    }

    /// Consumes the next item from the ring: one chunk of frames (up to the next gap) or one gap marker.
    public func step() throws -> Step {
        chunk.removeAll(keepingCapacity: true)
        switch ring.takeNext(into: &chunk, maxFrames: Self.chunkFrames) {
        case .gap(let gap):
            // Inside discontinuity(): a checkpoint only if levels hold samples, stamped with the END of the prior buffer.
            if writer.pendingWindowSamples > 0, let t = latestEnd { try checkpoint(t) }
            decimator.reset()                        // U1 §11.4: history resets at every discontinuity, day_rollover included
            latestEnd = nil
            needsCaptureAnchor = true
            switch gap.cause {
            case "device_lost":
                // Written when the loss is detected, on the capture thread's clocks at that moment. No gap_ns.
                try writer.discontinuity(cause: "device_lost", gapNS: nil, droppedInputFrames: nil,
                                         monoNS: gap.monoNS ?? monoNow(), wallNS: gap.wallNS ?? wallNow(), inputFrames: recordInputFrames)
                pendingGap = gap
            case "day_rollover":
                // A gap still waiting for its new-side audio is written first: that audio is the buffer being split.
                if let pending = pendingGap {
                    try resumeRecord(pending, newSideStart: startOf(gap.firstFrame))
                    pendingGap = nil
                }
                // The marker's own clocks (CaptureTimeline.swift:141-150): wall = the target midnight. gap 0 and dropped 0 are omitted.
                try writer.discontinuity(cause: "day_rollover", gapNS: nil, droppedInputFrames: nil,
                                         monoNS: gap.monoNS ?? monoNow(), wallNS: gap.wallNS ?? wallNow(), inputFrames: recordInputFrames)
            default:
                pendingGap = gap
            }
            return .progressed
        case .frames(let first, let count):
            audioArrived = true                      // :336, before the anchor
            if let gap = pendingGap {
                try resumeRecord(gap, newSideStart: startOf(first))
                pendingGap = nil
            }
            if needsCaptureAnchor {
                try checkpoint(startOf(first))       // :339-341, window empty
                needsCaptureAnchor = false
            }
            decimator.process(interleaved: chunk, into: &out)
            tee?(chunk)
            consumed += Int64(count)
            try writer.append(out)
            out.removeAll(keepingCapacity: true)
            latestEnd = endOf(first + Int64(count) - 1)
            // Periodic checkpoint: levels hold samples, the 1.25 s monotonic floor has passed, audio timestamps exist.
            if writer.pendingWindowSamples > 0, monoNow() - lastCheckpointNow >= Self.checkpointIntervalNS, let t = latestEnd {
                try checkpoint(t)
            }
            return .progressed
        case .empty:
            return .empty
        }
    }

    /// Capture has ended and the ring is drained: close the tape cleanly.
    public func finish() throws {
        if let gap = pendingGap, gap.cause != "device_lost" {
            // Ended inside a gap with no new-side buffer: stamped with fresh clocks. A device that never came back gets
            // no `resumed`.
            try resumeRecord(gap, newSideStart: (monoNow(), wallNow()))
        }
        // Clean stop, in the Mac's order (TapeWriter.swift:366-384): (1) the final checkpoint — the pending window at the
        // end of the latest buffer, or, if bytes were written since the last record, a bare checkpoint on fresh clocks;
        // (2) the PCM full sync; (3) the `stopped` record on fresh clocks.
        if writer.pendingWindowSamples > 0, let t = latestEnd {
            try checkpoint(t)
        } else if writer.samples * 2 > writer.lastRecordByteOffset {
            try checkpoint((monoNow(), wallNow()))
        }
        try writer.stopped(monoNS: monoNow(), wallNS: wallNow(), inputFrames: recordInputFrames)
    }
}
