import Foundation

// Day rollover, ported from the Mac at f798edf (read off source by the orchestrator, 15 Sep 2026):
//   ArchiveMidnightFoundation.swift:10-11  timeZoneIdentifier = "Asia/Kolkata", utcOffsetSeconds = 19_800
//   Recorder.swift ~65-77                  CaptureSession.init: nextRolloverWallNS = ArchiveISTDay.nextMidnight(now:)
//   CaptureTimeline.swift:24               istDayNS = 86_400_000_000_000 (its only constant; no timezone)
//   CaptureTimeline.swift:48-51            wallStartNS = observedWallNS − callbackLag
//   CaptureTimeline.swift:122-131          didPublishFrame: next = pending + istDayNS (overflow → nil); no calendar re-query
//   CaptureTimeline.swift:141              guard let target = nextRolloverWallNS, target <= wallEndNS   (wall domain only)
//   CaptureTimeline.swift:141-150          target <= wallStartNS: frameOffset = 0, monoNS = monoStartNS; otherwise
//                                          frameOffset = min(frameCount, Int((elapsedNS × sampleRate / 1e9).rounded(.up))),
//                                          monoNS = monoStartNS + (target − wallStartNS), exact integer addition
//   AudioRing.swift:143-215                prefix audio, .dayRollover marker (wallNS = target, gapNS 0, droppedFrames 0),
//                                          suffix audio; suffix wallStartNS = segmentEnd(start: wallStartNS, frameCount: prefixFrames)
//   AudioRing.swift:323-325                segmentEnd = start + UInt64(Double(frameCount) / sampleRate * 1_000_000_000)
//                                          (read 15 Sep): floating point, truncated — ceil for the frame count, floor for the time

/// The IST day, as the Mac's ArchiveISTDay. Queried once per capture session, never per record.
public enum ISTDay {
    public static let timeZoneIdentifier = "Asia/Kolkata"

    public struct ZoneError: Error, CustomStringConvertible { public let description: String }

    /// The first local midnight of Asia/Kolkata strictly after `nowWallNS`, as UTC wall ns, using the zone's UTC offset
    /// at `nowWallNS` (the zone has had no transition since 1945). No zone data is refused, never guessed.
    public static func nextMidnight(nowWallNS: Int64) throws -> Int64 {
        guard let zone = TimeZone(identifier: timeZoneIdentifier) else {
            throw ZoneError(description: "time zone \(timeZoneIdentifier) is not available (no zone data)")
        }
        let offsetNS = Int64(zone.secondsFromGMT(for: Date(timeIntervalSince1970: Double(nowWallNS) / 1e9))) * 1_000_000_000
        let dayNS = RolloverTimeline.istDayNS
        let local = nowWallNS + offsetNS
        let day = local >= 0 ? local / dayNS : (local - dayNS + 1) / dayNS
        return (day + 1) * dayNS - offsetNS
    }
}

/// Time spans of whole frames, exactly as the Mac's segmentEnd (AudioRing.swift:323-325):
///   start + UInt64(Double(frameCount) / sampleRate * 1_000_000_000)
/// Double throughout, truncated at the integer conversion (floor for non-negative spans), never rounded. One function
/// serves the arrival clock and the rollover split, so the end of a prefix and the start of its suffix are one number.
public enum FrameTime {
    public static func duration(frames: Int64, rate: Int64) -> Int64 {
        frames >= 0 ? Int64(UInt64(Double(frames) / Double(rate) * 1_000_000_000))
                    : -Int64(UInt64(Double(-frames) / Double(rate) * 1_000_000_000))
    }

    public static func segmentEnd(start: Int64, frames: Int64, rate: Int64) -> Int64 {
        start + duration(frames: frames, rate: rate)
    }
}

/// CaptureTimeline's rollover state for one capture session.
public struct RolloverTimeline: Sendable {
    public static let istDayNS: Int64 = 86_400_000_000_000
    public private(set) var nextRolloverWallNS: Int64?

    public init(nextRolloverWallNS: Int64?) { self.nextRolloverWallNS = nextRolloverWallNS }

    public struct Split: Codable, Equatable, Sendable {
        /// Capture frame index of the buffer's first frame (set by CaptureSide).
        public var firstFrame: Int64 = 0
        public var bufferWallStartNS: Int64
        public var bufferMonoStartNS: Int64
        public var frameCount: Int
        public var targetWallNS: Int64
        /// Prefix frames [0, frameOffset) stay in the old day, including a frame that straddles midnight.
        public var frameOffset: Int
        public var markerMonoNS: Int64
        public var suffixWallStartNS: Int64
        public var suffixMonoStartNS: Int64
        /// The re-armed target after this marker was published.
        public var nextRolloverWallNS: Int64?
        enum CodingKeys: String, CodingKey {
            case firstFrame = "first_frame", bufferWallStartNS = "buffer_wall_start_ns", bufferMonoStartNS = "buffer_mono_start_ns", frameCount = "frame_count"
            case targetWallNS = "target_wall_ns", frameOffset = "frame_offset", markerMonoNS = "marker_mono_ns"
            case suffixWallStartNS = "suffix_wall_start_ns", suffixMonoStartNS = "suffix_mono_start_ns"
            case nextRolloverWallNS = "next_rollover_wall_ns"
        }
    }

    /// The split of one capture buffer, or nil when the target is later than the buffer's wall end (CaptureTimeline.swift:141).
    /// CaptureTimeline.swift:141-150: a target at or before the buffer's wall start gives frameOffset 0 and the marker the
    /// buffer's mono start; otherwise frameOffset = ceil(elapsed × rate / 1e9) and mono = mono start + elapsed.
    public func split(wallStartNS: Int64, monoStartNS: Int64, frameCount: Int, rate: Int64) -> Split? {
        guard let target = nextRolloverWallNS,
              target <= FrameTime.segmentEnd(start: wallStartNS, frames: Int64(frameCount), rate: rate) else { return nil }
        let elapsedNS = target - wallStartNS
        let frameOffset = target <= wallStartNS ? 0 : min(frameCount, Int((Double(elapsedNS) * Double(rate) / 1_000_000_000).rounded(.up)))
        return Split(bufferWallStartNS: wallStartNS, bufferMonoStartNS: monoStartNS, frameCount: frameCount, targetWallNS: target,
                     frameOffset: frameOffset, markerMonoNS: target <= wallStartNS ? monoStartNS : monoStartNS + elapsedNS,
                     suffixWallStartNS: FrameTime.segmentEnd(start: wallStartNS, frames: Int64(frameOffset), rate: rate),
                     suffixMonoStartNS: FrameTime.segmentEnd(start: monoStartNS, frames: Int64(frameOffset), rate: rate),
                     nextRolloverWallNS: nil)
    }

    /// After the marker is published: the next boundary is exactly one IST day later. No calendar re-query.
    public mutating func didPublish() {
        guard let t = nextRolloverWallNS else { return }
        let (next, overflow) = t.addingReportingOverflow(Self.istDayNS)
        nextRolloverWallNS = overflow ? nil : next
    }
}

/// The capture side of a session: stamps each buffer, splits it at a rollover, and feeds the ring.
public final class CaptureSide: @unchecked Sendable {
    public let ring: FrameRing
    public let arrival: ArrivalClock
    public let rate: Int64
    /// 2 × the device's channel count.
    public let bytesPerFrame: Int
    public private(set) var capturedFrames: Int64 = 0
    private var timeline = RolloverTimeline(nextRolloverWallNS: nil)
    private var rollovers: [RolloverTimeline.Split] = []
    private var sessions: [Int64?] = []
    private let lock = NSLock()

    public init(ring: FrameRing, arrival: ArrivalClock) {
        self.ring = ring
        self.arrival = arrival
        self.rate = arrival.rate
        self.bytesPerFrame = ring.bytesPerFrame
    }

    /// A new capture session (stream opened, device reopened): the rollover target is queried afresh by the caller.
    public func beginSession(nextRolloverWallNS: Int64?) {
        timeline = RolloverTimeline(nextRolloverWallNS: nextRolloverWallNS)
        lock.lock(); sessions.append(nextRolloverWallNS); lock.unlock()
    }

    public var nextRolloverWallNS: Int64? { timeline.nextRolloverWallNS }

    /// One capture buffer of whole 4-byte frames, whose wall and monotonic START are given (read-return time minus the
    /// buffer's duration). Frames not accepted by the ring are still stamped, so a gap can be timed.
    public func deliver(_ bytes: UnsafeRawBufferPointer, monoStartNS: Int64, wallStartNS: Int64) {
        let n = bytes.count / bytesPerFrame
        guard n > 0 else { return }
        if var s = timeline.split(wallStartNS: wallStartNS, monoStartNS: monoStartNS, frameCount: n, rate: rate) {
            let p = s.frameOffset
            s.firstFrame = capturedFrames
            // Both segments are stamped before anything is published, so the writer can time the marker's neighbours.
            if p > 0 { arrival.stamp(firstFrame: capturedFrames, frames: Int64(p), monoStartNS: monoStartNS, wallStartNS: wallStartNS) }
            if p < n {
                arrival.stamp(firstFrame: capturedFrames + Int64(p), frames: Int64(n - p),
                              monoStartNS: s.suffixMonoStartNS, wallStartNS: s.suffixWallStartNS)
            }
            if p > 0 { ring.push(UnsafeRawBufferPointer(rebasing: bytes[0..<(p * bytesPerFrame)])) }
            ring.markDiscontinuity(cause: "day_rollover", monoNS: s.markerMonoNS, wallNS: s.targetWallNS)
            if p < n { ring.push(UnsafeRawBufferPointer(rebasing: bytes[(p * bytesPerFrame)...])) }
            timeline.didPublish()
            s.nextRolloverWallNS = timeline.nextRolloverWallNS
            lock.lock(); rollovers.append(s); lock.unlock()
        } else {
            arrival.stamp(firstFrame: capturedFrames, frames: Int64(n), monoStartNS: monoStartNS, wallStartNS: wallStartNS)
            ring.push(bytes)
        }
        capturedFrames += Int64(n)
    }

    /// Every split made, and the first target of every session, for the run summary.
    public func log() -> (sessions: [Int64?], rollovers: [RolloverTimeline.Split]) {
        lock.lock(); defer { lock.unlock() }
        return (sessions, rollovers)
    }
}
