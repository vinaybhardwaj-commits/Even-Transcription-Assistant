// U1 step 2: ALSA capture into a counted ring, raw 48 kHz stereo S16_LE to a scratch file. No conversion, no tape.
import ALSACapture
import CaptureCore
import Foundation
#if canImport(Glibc)
import Glibc
#endif

let usage = """
usage: capture-probe --out FILE --seconds S [--device hw:C,D] [--ring-frames N]
                     [--starve-at S --starve-for S] [--stall-capture-at S --stall-capture-for S] [--source alsa|ramp]
  Captures S seconds (S x 48000 frames exactly) into a ring and writes the raw frames to FILE. Prints a JSON summary.
  --device        capture device in stable form hw:CARD=<id>,DEV=<n>; required for --source alsa (no default).
  --ring-frames   ring capacity in frames (default 48000).
  --starve-at/for stop the writer draining the ring for a window (seconds from start): forces a counted overflow.
  --stall-capture-at/for  stop the capture thread reading for a window: forces a device-level overrun in ALSA.
  --source ramp   test source, no ALSA: frame i carries L = low 16 bits of i, R = high 16 bits, paced at 48 kHz.
  Exit 0 only if every conservation check holds.
"""

func die(_ m: String) -> Never { FileHandle.standardError.write(Data((m + "\n").utf8)); exit(2) }
let args = Array(CommandLine.arguments.dropFirst())
func opt(_ n: String) -> String? {
    guard let i = args.firstIndex(of: n) else { return nil }
    guard i + 1 < args.count else { die("\(n) needs a value") }
    return args[i + 1]
}
guard let outPath = opt("--out"), let seconds = opt("--seconds").flatMap(Double.init) else { die(usage) }
let ringFrames = opt("--ring-frames").flatMap(Int.init) ?? 48_000
let starveAt = opt("--starve-at").flatMap(Double.init)
let starveFor = opt("--starve-for").flatMap(Double.init) ?? 0
let stallAt = opt("--stall-capture-at").flatMap(Double.init)
let stallFor = opt("--stall-capture-for").flatMap(Double.init) ?? 0
let sourceKind = opt("--source") ?? "alsa"
let rate = 48_000, channels = 2, bytesPerFrame = 4
let targetFrames = Int64((seconds * Double(rate)).rounded())

@Sendable func monoNS() -> Int64 {
    var ts = timespec()
    clock_gettime(CLOCK_MONOTONIC, &ts)
    return Int64(ts.tv_sec) * 1_000_000_000 + Int64(ts.tv_nsec)
}

// MARK: Sources

protocol FrameSource: AnyObject, Sendable {
    var periodFrames: Int { get }
    func start() -> String?
    func read(into buffer: UnsafeMutableRawPointer, frames: Int) -> ALSACapturePCM.ReadResult
}

final class ALSASource: FrameSource, @unchecked Sendable {
    let pcm: ALSACapturePCM
    init(_ pcm: ALSACapturePCM) { self.pcm = pcm }
    var periodFrames: Int { max(1, Int(pcm.negotiated.periodFrames)) }
    func start() -> String? { pcm.start() }
    func read(into buffer: UnsafeMutableRawPointer, frames: Int) -> ALSACapturePCM.ReadResult { pcm.read(into: buffer, frames: frames) }
}

final class RampSource: FrameSource, @unchecked Sendable {
    var next: Int64 = 0
    var pacedFromNS: Int64 = 0
    let periodFrames = 480
    func start() -> String? { nil }
    func read(into buffer: UnsafeMutableRawPointer, frames: Int) -> ALSACapturePCM.ReadResult {
        if pacedFromNS == 0 { pacedFromNS = monoNS() }
        let due = pacedFromNS + (next + Int64(frames)) * 1_000_000_000 / 48_000
        let wait = due - monoNS()
        if wait > 0 { var ts = timespec(tv_sec: Int(wait / 1_000_000_000), tv_nsec: Int(wait % 1_000_000_000)); nanosleep(&ts, nil) }
        let p = buffer.assumingMemoryBound(to: UInt8.self)
        for f in 0..<frames {
            let i = UInt32(truncatingIfNeeded: next + Int64(f))
            p[f * 4] = UInt8(i & 0xff); p[f * 4 + 1] = UInt8((i >> 8) & 0xff)
            p[f * 4 + 2] = UInt8((i >> 16) & 0xff); p[f * 4 + 3] = UInt8((i >> 24) & 0xff)
        }
        next += Int64(frames)
        return .frames(frames)
    }
}

// MARK: Open and run

final class Shared: @unchecked Sendable {
    let lock = NSLock()
    var captureDone = false
    var overruns: [String] = []
    var firstReadNS: Int64 = 0, firstChunkFrames: Int64 = 0, lastReadNS: Int64 = 0
    var startNS: Int64 = 0
    var writtenFrames: Int64 = 0
    var starveStart: FrameRing.Counters? = nil
    var starveEnd: FrameRing.Counters? = nil
    var failure: String? = nil
    func with<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }
}

func openSource() -> (FrameSource, OpenedDevice?, Negotiated?) {
    switch sourceKind {
    case "alsa":
        do {
            let listed = try CaptureDevices.resolve(opt("--device"))
            let pcm = try ALSACapturePCM(device: listed, channels: UInt32(channels), rate: UInt32(rate), latencyMicros: 100_000)
            guard pcm.negotiated.rate == UInt32(rate), pcm.negotiated.channels == UInt32(channels), pcm.negotiated.format == "S16_LE" else {
                die("device negotiated \(pcm.negotiated), not S16_LE 2 ch 48000 Hz")
            }
            return (ALSASource(pcm), pcm.device, pcm.negotiated)
        } catch { die("\(error)") }
    case "ramp":
        return (RampSource(), nil, nil)
    default:
        die(usage)
    }
}

let (source, device, negotiated) = openSource()
let ring = FrameRing(capacityFrames: ringFrames, bytesPerFrame: bytesPerFrame)
let shared = Shared()
_ = FileManager.default.createFile(atPath: outPath, contents: nil)
guard let out = FileHandle(forWritingAtPath: outPath) else { die("cannot open \(outPath)") }

func runProbe(source: FrameSource, ring: FrameRing, shared: Shared, out: FileHandle,
              starveAt: Double?, starveFor: Double, stallAt: Double?, stallFor: Double, targetFrames: Int64) {
    shared.startNS = monoNS()
    let writerFinished = DispatchSemaphore(value: 0)
    let captureFinished = DispatchSemaphore(value: 0)

    let writer = Thread {
        var chunk: [UInt8] = []
        let window: (Int64, Int64)? = starveAt.map { at in
            let s = shared.startNS + Int64(at * 1e9)
            return (s, s + Int64(starveFor * 1e9))
        }
        while true {
            if let (s, e) = window {
                let now = monoNS()
                if now >= s && now < e {
                    shared.with { if shared.starveStart == nil { shared.starveStart = ring.snapshot().counters } }
                    usleep(1_000)
                    continue
                }
                shared.with { if shared.starveStart != nil && shared.starveEnd == nil { shared.starveEnd = ring.snapshot().counters } }
            }
            chunk.removeAll(keepingCapacity: true)
            let n = ring.take(into: &chunk, maxFrames: 4_096)
            if n > 0 {
                out.write(Data(chunk))
                shared.with { shared.writtenFrames += Int64(n) }
                continue
            }
            if shared.with({ shared.captureDone }) && ring.snapshot().counters.fill == 0 { break }
            usleep(2_000)
        }
        writerFinished.signal()
    }

    let capture = Thread {
        let period = source.periodFrames
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: period * bytesPerFrame, alignment: 1)
        defer { buffer.deallocate(); captureFinished.signal() }
        var captured: Int64 = 0
        var stalled = false
        if let e = source.start() {
            shared.with { shared.failure = e; shared.captureDone = true }
            return
        }
        while captured < targetFrames {
            if let at = stallAt, !stalled, monoNS() >= shared.startNS + Int64(at * 1e9) {
                stalled = true
                usleep(useconds_t(stallFor * 1e6))
            }
            let want = Int(min(Int64(period), targetFrames - captured))
            switch source.read(into: buffer, frames: want) {
            case .frames(let n):
                let t = monoNS()
                ring.push(UnsafeRawBufferPointer(start: buffer, count: n * bytesPerFrame))
                shared.with {
                    if shared.firstReadNS == 0 { shared.firstReadNS = t; shared.firstChunkFrames = Int64(n) }
                    shared.lastReadNS = t
                }
                captured += Int64(n)
            case .overrun(let text):
                ring.markDiscontinuity(cause: "capture_discontinuity")
                shared.with { shared.overruns.append("at captured frame \(captured): \(text)") }
            case .failed(let text):
                shared.with { shared.failure = "read failed at captured frame \(captured): \(text)" }
                shared.with { shared.captureDone = true }
                return
            }
        }
        shared.with { shared.captureDone = true }
    }
    writer.start()
    capture.start()
    captureFinished.wait()
    writerFinished.wait()
    try? out.synchronize()
    try? out.close()
}

runProbe(source: source, ring: ring, shared: shared, out: out, starveAt: starveAt, starveFor: starveFor,
         stallAt: stallAt, stallFor: stallFor, targetFrames: targetFrames)
let writtenFrames = shared.writtenFrames

// MARK: Summary

struct Starvation: Codable {
    var atS: Double, forS: Double
    var offeredInWindow: Int64, fillAtStart: Int, freeAtStart: Int, acceptedInWindow: Int64
    var droppedInWindow: Int64, expectedDropped: Int64
    enum CodingKeys: String, CodingKey {
        case atS = "at_s", forS = "for_s", offeredInWindow = "offered_in_window", fillAtStart = "fill_at_start"
        case freeAtStart = "free_at_start", acceptedInWindow = "accepted_in_window"
        case droppedInWindow = "dropped_in_window", expectedDropped = "expected_dropped"
    }
}
struct Summary: Codable {
    var source: String
    var device: OpenedDevice?
    var negotiated: Negotiated?
    var targetFrames: Int64
    var ringCapacityFrames: Int
    var ring: FrameRing.Counters
    var writtenFrames: Int64
    var fileBytes: Int64
    var overflowEvents: [FrameRing.OverflowEvent]
    var deviceOverruns: [String]
    var starvation: Starvation?
    var measuredRateHz: Double?
    /// Frames the monotonic clock says should have arrived between the first and last read, minus frames that did.
    /// ALSA does not count frames lost in a device overrun; this measures them.
    var clockDeficitFrames: Int64?
    var failure: String?
    var checks: [String: Bool]
    enum CodingKeys: String, CodingKey {
        case source, device, negotiated, ring, starvation, failure, checks
        case targetFrames = "target_frames", ringCapacityFrames = "ring_capacity_frames", writtenFrames = "written_frames"
        case fileBytes = "file_bytes", overflowEvents = "overflow_events", deviceOverruns = "device_overruns"
        case measuredRateHz = "measured_rate_hz", clockDeficitFrames = "clock_deficit_frames"
    }
}

let (counters, events) = ring.snapshot()
let fileBytes = ((try? FileManager.default.attributesOfItem(atPath: outPath)[.size]) as? NSNumber)?.int64Value ?? -1
var starvation: Starvation? = nil
if let at = starveAt, let s = shared.starveStart, let e = shared.starveEnd {
    let offered = e.offered - s.offered
    let free = ringFrames - s.fill
    starvation = Starvation(atS: at, forS: starveFor, offeredInWindow: offered, fillAtStart: s.fill, freeAtStart: free,
                            acceptedInWindow: e.accepted - s.accepted,
                            droppedInWindow: e.dropped - s.dropped,
                            expectedDropped: max(0, offered - Int64(free)))
}
var rateHz: Double? = nil
var deficit: Int64? = nil
if shared.lastReadNS > shared.firstReadNS {
    let seconds = Double(shared.lastReadNS - shared.firstReadNS) / 1e9
    rateHz = Double(counters.offered - shared.firstChunkFrames) / seconds
    deficit = Int64((seconds * Double(rate)).rounded()) - (counters.offered - shared.firstChunkFrames)
}
var checks: [String: Bool] = [
    "captured_equals_target": counters.offered == targetFrames,
    "captured_equals_written_plus_dropped": counters.offered == writtenFrames + counters.dropped,
    "file_bytes_equal_written_frames_x4": fileBytes == writtenFrames * Int64(bytesPerFrame),
    "ring_balanced": counters.balanced,
    "ring_empty_at_end": counters.fill == 0,
    "dropped_equals_sum_of_overflow_events": counters.dropped == events.reduce(0) { $0 + $1.frames },
    "no_read_failure": shared.failure == nil,
]
if let st = starvation {
    checks["starvation_dropped_equals_offered_minus_free"] = st.droppedInWindow == st.expectedDropped
    checks["no_drops_outside_starvation"] = counters.dropped == st.droppedInWindow
}
let summary = Summary(source: sourceKind, device: device, negotiated: negotiated, targetFrames: targetFrames,
                      ringCapacityFrames: ringFrames, ring: counters, writtenFrames: writtenFrames, fileBytes: fileBytes,
                      overflowEvents: events, deviceOverruns: shared.overruns, starvation: starvation,
                      measuredRateHz: rateHz, clockDeficitFrames: deficit, failure: shared.failure, checks: checks)
let enc = JSONEncoder()
enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
print(String(decoding: try! enc.encode(summary), as: UTF8.self))
exit(checks.values.allSatisfy { $0 } ? 0 : 1)
