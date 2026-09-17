import Foundation

/// A frame-accurate ring between the capture thread and the writer. The capture side never blocks: frames that do
/// not fit are dropped, counted and recorded as a gap at their capture frame index. Nothing is lost without being
/// counted, and nothing is zero-filled.
public final class FrameRing: @unchecked Sendable {
    public struct OverflowEvent: Codable, Equatable, Sendable {
        /// Capture frame index (0-based, counted from the first frame read) of the first missing frame.
        public var firstFrame: Int64
        /// Frames dropped by the ring. 0 for a capture-side marker (a device overrun or loss), whose loss ALSA does
        /// not count.
        public var frames: Int64
        /// "ring_overflow", "capture_discontinuity", "device_lost" or "day_rollover".
        public var cause: String
        /// Capture-side markers carry their own clocks: device_lost the moment of detection; day_rollover the
        /// interpolated monotonic time and the target wall time (the IST midnight itself).
        public var monoNS: Int64? = nil
        public var wallNS: Int64? = nil
        enum CodingKeys: String, CodingKey { case frames, cause, firstFrame = "first_frame", monoNS = "mono_ns", wallNS = "wall_ns" }
    }

    public struct Counters: Codable, Equatable, Sendable {
        public var offered: Int64
        public var accepted: Int64
        public var dropped: Int64
        public var taken: Int64
        public var fill: Int
        public var highWater: Int
        enum CodingKeys: String, CodingKey { case offered, accepted, dropped, taken, fill, highWater = "high_water" }

        /// offered == accepted + dropped, and accepted == taken + fill.
        public var balanced: Bool { offered == accepted + dropped && accepted == taken + Int64(fill) }
    }

    /// What the writer gets next: frames up to the next gap, or the gap itself.
    public enum Next: Sendable {
        case frames(firstFrame: Int64, count: Int)
        case gap(OverflowEvent)
        case empty
    }

    public let capacityFrames: Int
    public let bytesPerFrame: Int
    private var storage: [UInt8]
    private var readIndex = 0
    private var counters = Counters(offered: 0, accepted: 0, dropped: 0, taken: 0, fill: 0, highWater: 0)
    private var history: [OverflowEvent] = []
    private var pending: [OverflowEvent] = []
    /// Capture frame index of the next frame the writer will receive.
    private var nextTakeFrame: Int64 = 0
    private let lock = NSLock()

    public init(capacityFrames: Int, bytesPerFrame: Int) {
        precondition(capacityFrames > 0 && bytesPerFrame > 0)
        self.capacityFrames = capacityFrames
        self.bytesPerFrame = bytesPerFrame
        storage = [UInt8](repeating: 0, count: capacityFrames * bytesPerFrame)
    }

    private func record(_ event: OverflowEvent) {
        if event.frames > 0, var last = pending.last, last.cause == event.cause, last.firstFrame + last.frames == event.firstFrame {
            last.frames += event.frames
            pending[pending.count - 1] = last
            history[history.count - 1] = last
        } else {
            pending.append(event)
            history.append(event)
        }
    }

    /// Offers whole frames. Keeps what fits (the oldest of the offered frames), drops the rest. Returns frames dropped.
    @discardableResult
    public func push(_ bytes: UnsafeRawBufferPointer) -> Int {
        precondition(bytes.count % bytesPerFrame == 0)
        let frames = bytes.count / bytesPerFrame
        lock.lock()
        defer { lock.unlock() }
        let fit = min(frames, capacityFrames - counters.fill)
        var write = (readIndex + counters.fill) % capacityFrames
        for f in 0..<fit {
            let src = f * bytesPerFrame, dst = write * bytesPerFrame
            for b in 0..<bytesPerFrame { storage[dst + b] = bytes[src + b] }
            write = write + 1 == capacityFrames ? 0 : write + 1
        }
        let dropped = frames - fit
        if dropped > 0 {
            record(OverflowEvent(firstFrame: counters.offered + Int64(fit), frames: Int64(dropped), cause: "ring_overflow"))
        }
        counters.offered += Int64(frames)
        counters.accepted += Int64(fit)
        counters.dropped += Int64(dropped)
        counters.fill += fit
        counters.highWater = max(counters.highWater, counters.fill)
        return dropped
    }

    /// Marks a capture-side discontinuity before the next frame to be offered.
    public func markDiscontinuity(cause: String, monoNS: Int64? = nil, wallNS: Int64? = nil) {
        lock.lock()
        defer { lock.unlock() }
        record(OverflowEvent(firstFrame: counters.offered, frames: 0, cause: cause, monoNS: monoNS, wallNS: wallNS))
    }

    /// Takes up to `maxFrames` frames, ignoring gaps (the raw byte stream). Used by capture-probe.
    public func take(into out: inout [UInt8], maxFrames: Int) -> Int {
        lock.lock()
        defer { lock.unlock() }
        pending.removeAll()
        let n = copyOut(into: &out, count: min(maxFrames, counters.fill))
        nextTakeFrame = counters.offered - Int64(counters.fill)
        return n
    }

    /// Takes frames up to the next gap, or returns the gap once the writer has reached it.
    public func takeNext(into out: inout [UInt8], maxFrames: Int) -> Next {
        lock.lock()
        defer { lock.unlock() }
        if let gap = pending.first, gap.firstFrame == nextTakeFrame {
            pending.removeFirst()
            nextTakeFrame += gap.frames
            return .gap(gap)
        }
        var n = min(maxFrames, counters.fill)
        if let gap = pending.first { n = min(n, Int(gap.firstFrame - nextTakeFrame)) }
        guard n > 0 else { return .empty }
        let first = nextTakeFrame
        _ = copyOut(into: &out, count: n)
        nextTakeFrame += Int64(n)
        return .frames(firstFrame: first, count: n)
    }

    private func copyOut(into out: inout [UInt8], count n: Int) -> Int {
        out.reserveCapacity(out.count + n * bytesPerFrame)
        for _ in 0..<n {
            let src = readIndex * bytesPerFrame
            out.append(contentsOf: storage[src..<(src + bytesPerFrame)])
            readIndex = readIndex + 1 == capacityFrames ? 0 : readIndex + 1
        }
        counters.fill -= n
        counters.taken += Int64(n)
        return n
    }

    public func snapshot() -> (counters: Counters, events: [OverflowEvent]) {
        lock.lock()
        defer { lock.unlock() }
        return (counters, history)
    }
}

/// When each input frame was captured. Every buffer (or rollover segment) is stamped with its first frame, its frame
/// count and its monotonic and wall START; frame F of a segment starting at S occupies
///   [S + duration(F − first), S + duration(F − first + 1))   (FrameTime.duration: the Mac's segmentEnd arithmetic)
/// so a segment's end is FrameTime.segmentEnd(start: S, frames: count). Frames beyond the latest segment extrapolate it.
public final class ArrivalClock: @unchecked Sendable {
    public struct Stamp: Sendable { public var firstFrame: Int64; public var frames: Int64; public var monoStartNS: Int64; public var wallStartNS: Int64 }
    public let rate: Int64
    private var stamps: [Stamp] = []
    private let lock = NSLock()

    public init(rate: Int64) { self.rate = rate }

    public func stamp(firstFrame: Int64, frames: Int64, monoStartNS: Int64, wallStartNS: Int64) {
        lock.lock()
        defer { lock.unlock() }
        stamps.append(Stamp(firstFrame: firstFrame, frames: frames, monoStartNS: monoStartNS, wallStartNS: wallStartNS))
        if stamps.count > 4096 { stamps.removeFirst(2048) }
    }

    private func boundary(_ k: Int64) -> (monoNS: Int64, wallNS: Int64)? {
        lock.lock()
        defer { lock.unlock() }
        guard let s = stamps.last(where: { $0.firstFrame <= k }) ?? stamps.first else { return nil }
        let d = k - s.firstFrame
        let offset = d >= 0 ? FrameTime.duration(frames: d, rate: rate) : -FrameTime.duration(frames: -d, rate: rate)
        return (s.monoStartNS + offset, s.wallStartNS + offset)
    }

    /// (mono, wall) start of capture frame `frame`, nil before any stamp.
    public func start(of frame: Int64) -> (monoNS: Int64, wallNS: Int64)? { boundary(frame) }

    /// (mono, wall) end of capture frame `frame`: the end of its own segment's frame, not the next segment's start.
    public func end(of frame: Int64) -> (monoNS: Int64, wallNS: Int64)? {
        lock.lock()
        let s = stamps.last(where: { $0.firstFrame <= frame }) ?? stamps.first
        lock.unlock()
        guard let s else { return nil }
        let offset = FrameTime.duration(frames: frame - s.firstFrame + 1, rate: rate)
        return (s.monoStartNS + offset, s.wallStartNS + offset)
    }
}
