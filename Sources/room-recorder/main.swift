// U1: ALSA capture → ring → StereoDecimator → tape.pcm and tape.idx, with honest faults. No network, no systemd, no upload.
import ALSACapture
import CaptureCore
import Foundation
import TapeConvert
import TapeCore
#if canImport(Glibc)
import Glibc
#endif

#if TAPE_TEST_HOOKS
let hooksUsage = """

  TEST HOOKS (this binary was built with -DTAPE_TEST_HOOKS; release builds do not contain them):
  --tee-input FILE                 every input frame fed to the converter, in order
  --starve-writer-at S --starve-writer-for S   stop the writer draining the ring for a window (forces ring_overflow)
  --inject-device-lost-at S --inject-device-lost-for S   close the device for a window, then reopen it
"""
#else
let hooksUsage = ""
#endif

let usage = """
usage: room-recorder record --device hw:CARD=<id>,DEV=<n> --tape DIR --seconds S [--ring-frames N]
  Records S seconds of captured audio from the named capture device into DIR/tape.pcm and DIR/tape.idx. A new DIR gets
  a new tape; an existing tape is continued with a `restart` record.
  The device must be named in stable form; with no --device, prints the capture devices and exits.
  Refuses a run that would cross IST midnight: day rollover arrives in U1 step 5.
""" + hooksUsage

func die(_ m: String, _ code: Int32 = 2) -> Never { FileHandle.standardError.write(Data((m + "\n").utf8)); exit(code) }
let args = Array(CommandLine.arguments.dropFirst())
func opt(_ n: String) -> String? {
    guard let i = args.firstIndex(of: n) else { return nil }
    guard i + 1 < args.count else { die("\(n) needs a value") }
    return args[i + 1]
}
guard args.first == "record" else { die(usage) }

let listed: CaptureDevices.Listed
do { listed = try CaptureDevices.resolve(opt("--device")) } catch { die("\(error)") }
guard let tapePath = opt("--tape"), let seconds = opt("--seconds").flatMap(Double.init), seconds > 0 else { die(usage) }
let ringFrames = opt("--ring-frames").flatMap(Int.init) ?? 48_000
let inputRate: Int64 = 48_000
let targetFrames = Int64((seconds * Double(inputRate)).rounded())

#if TAPE_TEST_HOOKS
struct Hooks: Sendable {
    var teeInputPath: String?
    var starveAt: Double?, starveFor: Double = 0
    var lossAt: Double?, lossFor: Double = 0
}
let hooks = Hooks(teeInputPath: opt("--tee-input"),
                  starveAt: opt("--starve-writer-at").flatMap(Double.init), starveFor: opt("--starve-writer-for").flatMap(Double.init) ?? 0,
                  lossAt: opt("--inject-device-lost-at").flatMap(Double.init), lossFor: opt("--inject-device-lost-for").flatMap(Double.init) ?? 0)
#else
/// Release builds: no hooks exist. This empty type only keeps the call signatures uniform.
struct Hooks: Sendable {}
let hooks = Hooks()
#endif

@Sendable func clockNS(_ id: clockid_t) -> Int64 {
    var ts = timespec()
    clock_gettime(id, &ts)
    return Int64(ts.tv_sec) * 1_000_000_000 + Int64(ts.tv_nsec)
}

// Day rollover is not implemented until step 5: never record across IST midnight.
let istDayNS: Int64 = 86_400_000_000_000, istOffsetNS: Int64 = 19_800_000_000_000
let nowWall = clockNS(CLOCK_REALTIME)
let nextMidnight = ((nowWall + istOffsetNS) / istDayNS + 1) * istDayNS - istOffsetNS
if nowWall + Int64((seconds + 120) * 1e9) >= nextMidnight {
    die("refusing: a \(seconds) s recording would come within 2 minutes of IST midnight, and day_rollover is U1 step 5")
}

@Sendable func openDevice(_ listed: CaptureDevices.Listed) throws -> ALSACapturePCM {
    let pcm = try ALSACapturePCM(device: listed, channels: 2, rate: UInt32(inputRate), latencyMicros: 100_000)
    guard pcm.negotiated.format == "S16_LE", pcm.negotiated.channels == 2, pcm.negotiated.rate == UInt32(inputRate) else {
        throw ALSAError(description: "\(listed.stableName) negotiated \(pcm.negotiated), not S16_LE 2 ch 48000 Hz")
    }
    return pcm
}

final class PCMBox: @unchecked Sendable {
    var pcm: ALSACapturePCM?
    init(_ pcm: ALSACapturePCM) { self.pcm = pcm }
}
// The box holds the only reference to the open PCM, so dropping it closes the device (snd_pcm_close in deinit).
let pcmBox: PCMBox
do { pcmBox = PCMBox(try openDevice(listed)) } catch { die("\(error)") }
let openedDevice = pcmBox.pcm!.device
let negotiated = pcmBox.pcm!.negotiated
let writer: TapeWriter
do {
    writer = try TapeWriter(directory: URL(fileURLWithPath: tapePath), device: openedDevice.name, inputSampleRate: Double(inputRate),
                            monoNow: { clockNS(CLOCK_MONOTONIC) }, wallNow: { clockNS(CLOCK_REALTIME) })
} catch { die("\(error)") }

final class Shared: @unchecked Sendable {
    let lock = NSLock()
    var stop = false
    var captureDone = false
    var overruns: [String] = []
    var outages: [String] = []
    var failure: String?
    var startNS: Int64 = 0
    func with<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }
}

let shared = Shared()
let ring = FrameRing(capacityFrames: ringFrames, bytesPerFrame: 4)
let arrival = ArrivalClock(rate: inputRate)

signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let signalQueue = DispatchQueue(label: "signals")
let signalSources = [SIGINT, SIGTERM].map { sig -> DispatchSourceSignal in
    let s = DispatchSource.makeSignalSource(signal: sig, queue: signalQueue)
    s.setEventHandler { shared.with { shared.stop = true } }
    s.resume()
    return s
}

/// The capture thread. A read that cannot be recovered is a lost device: it is marked `device_lost` at the moment of
/// detection, the PCM is closed, and the device is reopened by its stable name as soon as it can be. `--seconds` counts
/// captured audio, not wall time.
@Sendable func capture(box: PCMBox, listed: CaptureDevices.Listed, ring: FrameRing, arrival: ArrivalClock, shared: Shared,
                       targetFrames: Int64, hooks: Hooks) {
    defer { box.pcm = nil; shared.with { shared.captureDone = true } }
    let period = 1_200
    let buffer = UnsafeMutableRawPointer.allocate(byteCount: period * 4, alignment: 1)
    defer { buffer.deallocate() }
    var captured: Int64 = 0
    var needStart = true
    var lastReopenError = ""
    #if TAPE_TEST_HOOKS
    var injected = false
    #endif

    func lose(_ why: String) {
        let mono = clockNS(CLOCK_MONOTONIC), wall = clockNS(CLOCK_REALTIME)
        ring.markDiscontinuity(cause: "device_lost", monoNS: mono, wallNS: wall)
        shared.with { shared.outages.append("device lost before capture frame \(captured): \(why)") }
        box.pcm = nil
    }

    while captured < targetFrames, !shared.with({ shared.stop }) {
        #if TAPE_TEST_HOOKS
        let elapsed = Double(clockNS(CLOCK_MONOTONIC) - shared.startNS) / 1e9
        if let at = hooks.lossAt, elapsed >= at, elapsed < at + hooks.lossFor {
            if !injected, box.pcm != nil { injected = true; lose("injected by --inject-device-lost-at (test hook)") }
            usleep(50_000)
            continue
        }
        #endif
        guard let pcm = box.pcm else {
            do {
                guard CaptureDevices.list().contains(where: { $0.stableName == listed.stableName }) else {
                    throw ALSAError(description: "\(listed.stableName) not listed in /proc/asound/pcm")
                }
                box.pcm = try openDevice(listed)
                needStart = true
                lastReopenError = ""
                shared.with { shared.outages.append("device reopened at capture frame \(captured)") }
            } catch {
                let text = "\(error)"
                if text != lastReopenError {
                    lastReopenError = text
                    shared.with { shared.outages.append("reopen failed: \(text)") }
                }
                usleep(200_000)
            }
            continue
        }
        if needStart {
            if let e = pcm.start() { lose(e); continue }
            needStart = false
        }
        switch pcm.read(into: buffer, frames: Int(min(Int64(period), targetFrames - captured))) {
        case .frames(let n):
            let mono = clockNS(CLOCK_MONOTONIC), wall = clockNS(CLOCK_REALTIME)
            arrival.stamp(lastFrame: captured + Int64(n) - 1, monoNS: mono, wallNS: wall)
            ring.push(UnsafeRawBufferPointer(start: buffer, count: n * 4))
            captured += Int64(n)
        case .overrun(let text):
            ring.markDiscontinuity(cause: "capture_discontinuity")
            shared.with { shared.overruns.append("device overrun before capture frame \(captured): \(text)") }
        case .failed(let text):
            lose(text)
        }
    }
}

/// Mac TapeWriter.swift:11/29/36 — checkpointIntervalNS = 1.25 s on the monotonic clock, a floor, not a timer.
let checkpointIntervalNS: Int64 = 1_250_000_000

/// The writer: ring → decimator → tape. Record timing, cadence, levels, input_frames and gap_ns follow the Mac source
/// as read in ETA-U1-RECORD-FIELDS-MAC-GROUND-TRUTH-14-SEP-2026.md; see spec/RECORDER-RECORDS-LINUX.md.
///
/// Input frame F is taken to occupy [arrival(F) − 1/48000 s, arrival(F)] on each clock (ArrivalClock), so the start
/// of a buffer is arrival(first) − one frame and its end is arrival(last).
func runWriter(writer: TapeWriter, ring: FrameRing, arrival: ArrivalClock, shared: Shared, hooks: Hooks) throws {
    #if TAPE_TEST_HOOKS
    let tee: FileHandle? = hooks.teeInputPath.flatMap { path in
        _ = FileManager.default.createFile(atPath: path, contents: nil)
        return FileHandle(forWritingAtPath: path)
    }
    #endif
    var decimator = StereoDecimator()
    var consumed: Int64 = writer.prior?.lastInputFrames ?? 0   // running total, seeded from the prior tape; never reset
    var anchored = false
    var pendingGap: FrameRing.OverflowEvent? = nil
    var latestEnd: (Int64, Int64)? = nil         // (mono, wall) end of the most recent consumed input
    var lastCheckpointNow = clockNS(CLOCK_MONOTONIC)
    var chunk: [UInt8] = []
    var out: [Int16] = []
    let nsPerFrame = 1_000_000_000 / arrival.rate

    func endOf(_ f: Int64) -> (Int64, Int64) {
        arrival.time(of: f).map { ($0.monoNS, $0.wallNS) } ?? (clockNS(CLOCK_MONOTONIC), clockNS(CLOCK_REALTIME))
    }
    func startOf(_ f: Int64) -> (Int64, Int64) {
        let (m, w) = endOf(f)
        return (m - nsPerFrame, w - nsPerFrame)
    }
    func checkpoint(_ t: (Int64, Int64)) throws {
        try writer.checkpoint(monoNS: t.0, wallNS: t.1, inputFrames: consumed)
        lastCheckpointNow = clockNS(CLOCK_MONOTONIC)
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
                                 monoNS: newSideStart.0, wallNS: newSideStart.1, inputFrames: consumed)
    }

    while true {
        #if TAPE_TEST_HOOKS
        if let at = hooks.starveAt {
            let elapsed = Double(clockNS(CLOCK_MONOTONIC) - shared.with({ shared.startNS })) / 1e9
            if elapsed >= at, elapsed < at + hooks.starveFor { usleep(2_000); continue }
        }
        #endif
        chunk.removeAll(keepingCapacity: true)
        switch ring.takeNext(into: &chunk, maxFrames: 1_200) {
        case .gap(let gap):
            // Inside discontinuity(): a checkpoint only if levels hold samples, stamped with the END of the prior buffer.
            if writer.pendingWindowSamples > 0, let t = latestEnd { try checkpoint(t) }
            decimator.reset()                        // U1 §11.4: history resets at every discontinuity
            if gap.cause == "device_lost" {
                // Written when the loss is detected, on the capture thread's clocks at that moment. No gap_ns.
                try writer.discontinuity(cause: "device_lost", gapNS: nil, droppedInputFrames: nil,
                                         monoNS: gap.monoNS ?? clockNS(CLOCK_MONOTONIC), wallNS: gap.wallNS ?? clockNS(CLOCK_REALTIME),
                                         inputFrames: consumed)
            }
            pendingGap = gap
        case .frames(let first, let count):
            if !anchored {
                // First audio: the anchor checkpoint, stamped with the START of the first buffer, window empty.
                try checkpoint(startOf(first))
                anchored = true
            }
            if let gap = pendingGap {
                try resumeRecord(gap, newSideStart: startOf(first))
                pendingGap = nil
            }
            decimator.process(interleaved: chunk, into: &out)
            #if TAPE_TEST_HOOKS
            tee?.write(Data(chunk))
            #endif
            consumed += Int64(count)
            try writer.append(out)
            out.removeAll(keepingCapacity: true)
            latestEnd = endOf(first + Int64(count) - 1)
            // Periodic checkpoint: levels hold samples, the 1.25 s monotonic floor has passed, audio timestamps exist.
            let now = clockNS(CLOCK_MONOTONIC)
            if writer.pendingWindowSamples > 0, now - lastCheckpointNow >= checkpointIntervalNS, let t = latestEnd {
                try checkpoint(t)
            }
        case .empty:
            if shared.with({ shared.captureDone }) && ring.snapshot().counters.fill == 0 {
                if let gap = pendingGap, gap.cause != "device_lost" {
                    // Ended inside a gap with no new-side buffer: stamped with fresh clocks. A device that never came
                    // back gets no `resumed`.
                    try resumeRecord(gap, newSideStart: (clockNS(CLOCK_MONOTONIC), clockNS(CLOCK_REALTIME)))
                }
                // Clean stop, in the Mac's order (TapeWriter.swift:366-384): (1) the final checkpoint — the pending
                // window at the end of the latest buffer, or, if bytes were written since the last record, a bare
                // checkpoint on fresh clocks; (2) the PCM full sync; (3) the `stopped` record on fresh clocks.
                if writer.pendingWindowSamples > 0, let t = latestEnd {
                    try checkpoint(t)
                } else if writer.samples * 2 > writer.lastRecordByteOffset {
                    try checkpoint((clockNS(CLOCK_MONOTONIC), clockNS(CLOCK_REALTIME)))
                }
                try writer.stopped(monoNS: clockNS(CLOCK_MONOTONIC), wallNS: clockNS(CLOCK_REALTIME),
                                   inputFrames: anchored || writer.prior?.lastInputFrames != nil ? consumed : nil)
                return
            }
            usleep(2_000)
        }
    }
}

shared.startNS = clockNS(CLOCK_MONOTONIC)
let captureDone = DispatchSemaphore(value: 0)
Thread {
    capture(box: pcmBox, listed: listed, ring: ring, arrival: arrival, shared: shared, targetFrames: targetFrames, hooks: hooks)
    captureDone.signal()
}.start()
var writeError: String? = nil
do { try runWriter(writer: writer, ring: ring, arrival: arrival, shared: shared, hooks: hooks) } catch { writeError = "\(error)" }
captureDone.wait()
_ = signalSources

struct Summary: Codable {
    var device: OpenedDevice
    var negotiated: Negotiated
    var tape: String
    var prior: TapeWriter.PriorTape?
    var samples: Int64
    var records: Int
    var ring: FrameRing.Counters
    var events: [FrameRing.OverflowEvent]
    var deviceOverruns: [String]
    var outages: [String]
    var elapsedS: Double
    var testHooks: Bool
    var failure: String?
    enum CodingKeys: String, CodingKey {
        case device, negotiated, tape, prior, samples, records, ring, events, outages, failure
        case deviceOverruns = "device_overruns", elapsedS = "elapsed_s", testHooks = "test_hooks"
    }
}
#if TAPE_TEST_HOOKS
let builtWithHooks = true
#else
let builtWithHooks = false
#endif
let (counters, events) = ring.snapshot()
let summary = Summary(device: openedDevice, negotiated: negotiated, tape: tapePath, prior: writer.prior, samples: writer.samples,
                      records: writer.records, ring: counters, events: events, deviceOverruns: shared.overruns,
                      outages: shared.outages, elapsedS: Double(clockNS(CLOCK_MONOTONIC) - shared.startNS) / 1e9,
                      testHooks: builtWithHooks, failure: writeError ?? shared.failure)
let enc = JSONEncoder()
enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
print(String(decoding: try! enc.encode(summary), as: UTF8.self))
exit(summary.failure == nil ? 0 : 1)
