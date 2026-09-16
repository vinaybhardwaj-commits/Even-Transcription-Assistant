// U1: ALSA capture → ring → Decimator → tape.pcm and tape.idx, with honest faults. No network, no systemd, no upload.
// The capture format is read from the device and validated, never requested: `hw:` only, no plugin layer, no resampling.
import ALSACapture
import CaptureCore
import Foundation
import RecorderCore
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
  --test-wall-origin-ns N          CLOCK_REALTIME reads as N at startup and runs on from there (inject a pre-midnight start)
"""
#else
let hooksUsage = ""
#endif

let usage = """
usage: room-recorder record --device hw:CARD=<id>,DEV=<n> --tape DIR [--seconds S]
                            [--expect-usbid VID:PID] [--wait-for-device SECONDS] [--ring-frames N]
  Records captured audio from the named capture device into DIR/tape.pcm and DIR/tape.idx. The device's own
  channel count is used (1 or more); 48 000 Hz S16_LE is required of the hardware and never converted. A new DIR gets
  a new tape; an existing tape is continued with a `restart` record.
  The device must be named in stable form; with no --device, prints the capture devices and exits.
  A run that crosses IST midnight (Asia/Kolkata zone data required) writes a day_rollover record at the boundary.

  --seconds S            stop after S seconds of CAPTURED AUDIO (not wall time). OMIT IT to run until terminated
                         (SIGINT/SIGTERM) — a room does not know in advance how long it is a room for. There is no
                         magic value for "forever": an absent option cannot be mistyped, a magic string can.
  --expect-usbid VID:PID the USB vendor:product the pinned device must report (e.g. 0d8c:0134 for a TONOR TM20).
                         Without it the pin is only a NAME, and ALSA card ids are not unique hardware identities, so
                         a different generic USB mic answering to the same name cannot be told from ours.
  --wait-for-device S    bounded wait at startup for the pinned device, default 30. 0 means probe once and fail.
                         ABSENT or BUSY are waited out; a WRONG device is never waited for and fails immediately.

exit codes: 2 usage / refusal   3 pinned device absent after the bounded wait
            4 pinned device busy after the bounded wait     5 wrong device (immediate, never waited for)
""" + hooksUsage

func die(_ m: String, _ code: Int32 = 2) -> Never { FileHandle.standardError.write(Data((m + "\n").utf8)); exit(code) }
let args = Array(CommandLine.arguments.dropFirst())
func opt(_ n: String) -> String? {
    guard let i = args.firstIndex(of: n) else { return nil }
    guard i + 1 < args.count else { die("\(n) needs a value") }
    return args[i + 1]
}
guard args.first == "record" else { die(usage) }
// Every option must be one this binary has: a release build refuses a test-hook option rather than ignoring it.
#if TAPE_TEST_HOOKS
let knownOptions: Set<String> = ["--device", "--tape", "--seconds", "--ring-frames", "--expect-usbid",
                                 "--wait-for-device", "--tee-input", "--starve-writer-at",
                                 "--starve-writer-for", "--inject-device-lost-at", "--inject-device-lost-for", "--test-wall-origin-ns"]
#else
let knownOptions: Set<String> = ["--device", "--tape", "--seconds", "--ring-frames", "--expect-usbid",
                                 "--wait-for-device"]
#endif
do {
    var i = 1
    while i < args.count {
        guard knownOptions.contains(args[i]) else { die("unknown option \(args[i])\n" + usage) }
        i += 2
    }
}

guard let tapePath = opt("--tape") else { die(usage) }

// A --seconds that is PRESENT must be a positive number. A mistyped one is a usage error and is never silently
// demoted to an indefinite run: "record until terminated" is asked for by omitting the option, not by fumbling it.
let runLength: RunLength
if let raw = opt("--seconds") {
    guard let s = Double(raw), s > 0 else { die("--seconds must be a positive number of seconds; got \(raw). Omit --seconds entirely to run until terminated.") }
    runLength = RunLength(seconds: s, rate: Int64(CaptureFormat.requiredRate))
} else {
    runLength = .indefinite
}
let ringFrames = opt("--ring-frames").flatMap(Int.init) ?? 48_000
let inputRate = Int64(CaptureFormat.requiredRate)

guard let pinnedDevice = opt("--device") else {
    // Unchanged behaviour: with no --device, print what is there and exit. resolve(nil) builds that listing.
    do { _ = try CaptureDevices.resolve(nil) } catch { die("\(error)") }
    die(usage)
}
let waitBound = opt("--wait-for-device").flatMap(Double.init) ?? DeviceWait.defaultTimeoutSeconds
guard waitBound >= 0 else { die("--wait-for-device must be zero or positive seconds; got \(opt("--wait-for-device") ?? "")") }
let expectUSBID = opt("--expect-usbid")

// S6 — lifecycle and device identity only. Never sample values, never anything derived from what was said.
@Sendable func journal(_ m: String) { FileHandle.standardError.write(Data(("room-recorder: " + m + "\n").utf8)) }
journal("starting: pinned \(pinnedDevice), identity \(expectUSBID ?? "NOT PINNED"), tape \(tapePath), run \(runLength.describedForJournal), device wait \(waitBound) s")
if expectUSBID == nil {
    // Said out loud rather than left implicit: without a usbid the WRONG case cannot be detected at all, and a
    // stranger answering to our pinned name would be recorded as if it were ours.
    journal("WARNING: no --expect-usbid, so the pin is a NAME ONLY. A different device answering to \(pinnedDevice) cannot be detected.")
}

// S3 — the bounded wait. ABSENT and BUSY are waited out; WRONG is never waited for. No fallback to another device
// in any case, for any reason.
switch DeviceWait.wait(timeout: waitBound,
                       now: { Double(clockNS(CLOCK_MONOTONIC)) / 1e9 },
                       sleep: { usleep(UInt32($0 * 1e6)) },
                       log: { journal($0) },
                       probe: { CaptureDevices.probe(pinned: pinnedDevice, expectUSBID: expectUSBID) }) {
case .ready(let attempts, let waited):
    journal("pinned device present after \(attempts) probe(s), \(DeviceWait.fmt(waited)) s")
case .absentTimeout(let attempts, let waited):
    die("PINNED DEVICE ABSENT: \(pinnedDevice) did not appear within \(waitBound) s (\(attempts) probe(s) over \(DeviceWait.fmt(waited)) s). Not falling back to any other device.", 3)
case .busyTimeout(let attempts, let waited):
    die("PINNED DEVICE BUSY: \(pinnedDevice) is present but held by another client and did not free within \(waitBound) s (\(attempts) probe(s) over \(DeviceWait.fmt(waited)) s). Not falling back to any other device.", 4)
case .wrong(let found):
    die("WRONG DEVICE: expected \(pinnedDevice) with USB id \(expectUSBID ?? "(unpinned)"); found \(found). Refusing to record: a device that is not the pinned one is a hard failure, never waited for and never substituted.", 5)
}

let listed: CaptureDevices.Listed
do { listed = try CaptureDevices.resolve(pinnedDevice) } catch { die("\(error)") }

#if TAPE_TEST_HOOKS
struct Hooks: Sendable {
    var teeInputPath: String?
    var starveAt: Double?, starveFor: Double = 0
    var lossAt: Double?, lossFor: Double = 0
    var wallOriginNS: Int64?
}
let hooks = Hooks(teeInputPath: opt("--tee-input"),
                  starveAt: opt("--starve-writer-at").flatMap(Double.init), starveFor: opt("--starve-writer-for").flatMap(Double.init) ?? 0,
                  lossAt: opt("--inject-device-lost-at").flatMap(Double.init), lossFor: opt("--inject-device-lost-for").flatMap(Double.init) ?? 0,
                  wallOriginNS: opt("--test-wall-origin-ns").flatMap(Int64.init))
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

/// The wall clock every record and every rollover decision reads. Release builds read CLOCK_REALTIME and nothing else;
/// a test-hook build can shift it by a constant fixed at startup, so a run can start seconds before an IST midnight.
enum WallClock {
    #if TAPE_TEST_HOOKS
    nonisolated(unsafe) static var testHookWallOffsetNS: Int64 = 0
    @Sendable static func now() -> Int64 { clockNS(CLOCK_REALTIME) + testHookWallOffsetNS }
    #else
    @Sendable static func now() -> Int64 { clockNS(CLOCK_REALTIME) }
    #endif
}
#if TAPE_TEST_HOOKS
if let origin = hooks.wallOriginNS { WallClock.testHookWallOffsetNS = origin - clockNS(CLOCK_REALTIME) }
#endif
// The zone decides each capture session's first boundary; without zone data the recorder does not start.
do { _ = try ISTDay.nextMidnight(nowWallNS: WallClock.now()) } catch { die("\(error)") }

// The device's channel count is READ, never requested (the Mac reads input.inputFormat(forBus: 0), Recorder.swift:78,
// and taps that same format at :89). Validated by CaptureFormat, then used as it is: 1 for a TONOR TM20, 2 for the DMIC.
let capabilities: DeviceCapabilities
do {
    capabilities = try CaptureDevices.capabilities(listed)
    try CaptureFormat.validate(capabilities, device: listed.stableName)
} catch { die("\(error)") }
let inputChannels = capabilities.channels

@Sendable func openDevice(_ listed: CaptureDevices.Listed) throws -> ALSACapturePCM {
    // A device that comes back with a different channel count than the tape's audio so far would silently change the
    // downmix, and no index key records the channel count (see spec/RECORDER-RECORDS-LINUX.md), so the run stops instead.
    let now = try CaptureDevices.capabilities(listed)
    guard now.channels == inputChannels else {
        throw ALSAError(description: "\(listed.stableName) now offers \(now.channels) channel(s); this tape's audio was converted from \(inputChannels). The tape records no channel count, so the run stops rather than change the downmix mid-tape")
    }
    try CaptureFormat.validate(now, device: listed.stableName)
    let pcm = try ALSACapturePCM(device: listed, channels: inputChannels, rate: UInt32(inputRate), latencyMicros: 100_000)
    guard pcm.negotiated.format == "S16_LE", pcm.negotiated.channels == inputChannels, pcm.negotiated.rate == UInt32(inputRate) else {
        throw ALSAError(description: "\(listed.stableName) negotiated \(pcm.negotiated), not S16_LE \(inputChannels) ch \(inputRate) Hz")
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
                            monoNow: { clockNS(CLOCK_MONOTONIC) }, wallNow: WallClock.now)
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
let ring = FrameRing(capacityFrames: ringFrames, bytesPerFrame: 2 * Int(inputChannels))
let arrival = ArrivalClock(rate: inputRate)
let side = CaptureSide(ring: ring, arrival: arrival)

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
/// captured audio, not wall time; omitted, the loop ends only on SIGINT/SIGTERM.
/// Every (re)open is a new capture session: the next IST midnight is queried from the zone then, and only then.
@Sendable func capture(box: PCMBox, listed: CaptureDevices.Listed, side: CaptureSide, shared: Shared,
                       runLength: RunLength, hooks: Hooks) {
    let ring = side.ring
    defer { box.pcm = nil; shared.with { shared.captureDone = true } }
    let period = 1_200
    let bytesPerFrame = side.bytesPerFrame
    let buffer = UnsafeMutableRawPointer.allocate(byteCount: period * bytesPerFrame, alignment: 1)
    defer { buffer.deallocate() }
    var captured: Int64 = 0
    var needStart = true
    var lastReopenError = ""
    #if TAPE_TEST_HOOKS
    var injected = false
    #endif

    func lose(_ why: String) {
        let mono = clockNS(CLOCK_MONOTONIC), wall = WallClock.now()
        ring.markDiscontinuity(cause: "device_lost", monoNS: mono, wallNS: wall)
        shared.with { shared.outages.append("device lost before capture frame \(captured): \(why)") }
        box.pcm = nil
    }

    while runLength.shouldContinue(captured: captured), !shared.with({ shared.stop }) {
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
            do { side.beginSession(nextRolloverWallNS: try ISTDay.nextMidnight(nowWallNS: WallClock.now())) } catch {
                shared.with { shared.failure = "capture session: \(error)"; shared.stop = true }
                continue
            }
            if let e = pcm.start() { lose(e); continue }
            needStart = false
        }
        switch pcm.read(into: buffer, frames: runLength.readSize(period: period, captured: captured)) {
        case .frames(let n):
            // Read return stamps the END of the buffer; its start is that minus the buffer's duration (the Mac's
            // observed time minus callback lag, CaptureTimeline.swift:48-51).
            let mono = clockNS(CLOCK_MONOTONIC), wall = WallClock.now()
            let duration = FrameTime.duration(frames: Int64(n), rate: inputRate)
            side.deliver(UnsafeRawBufferPointer(start: buffer, count: n * bytesPerFrame), monoStartNS: mono - duration, wallStartNS: wall - duration)
            captured += Int64(n)
        case .overrun(let text):
            ring.markDiscontinuity(cause: "capture_discontinuity")
            shared.with { shared.overruns.append("device overrun before capture frame \(captured): \(text)") }
        case .failed(let text):
            lose(text)
        }
    }
}

func runWriter(session: TapeSession, ring: FrameRing, shared: Shared, hooks: Hooks) throws {
    #if TAPE_TEST_HOOKS
    if let path = hooks.teeInputPath {
        _ = FileManager.default.createFile(atPath: path, contents: nil)
        if let tee = FileHandle(forWritingAtPath: path) { session.tee = { tee.write(Data($0)) } }
    }
    #endif
    while true {
        #if TAPE_TEST_HOOKS
        if let at = hooks.starveAt {
            let elapsed = Double(clockNS(CLOCK_MONOTONIC) - shared.with({ shared.startNS })) / 1e9
            if elapsed >= at, elapsed < at + hooks.starveFor { usleep(2_000); continue }
        }
        #endif
        if try session.step() == .empty {
            if shared.with({ shared.captureDone }) && ring.snapshot().counters.fill == 0 {
                // One more pass: a marker recorded after the last frame (a loss at the very end) is still in the ring.
                if try session.step() == .empty { try session.finish(); return }
                continue
            }
            usleep(2_000)
        }
    }
}

shared.startNS = clockNS(CLOCK_MONOTONIC)
let captureDone = DispatchSemaphore(value: 0)
Thread {
    capture(box: pcmBox, listed: listed, side: side, shared: shared, runLength: runLength, hooks: hooks)
    captureDone.signal()
}.start()
var writeError: String? = nil
let session = TapeSession(writer: writer, ring: ring, arrival: arrival, rule: .production(channels: Int(inputChannels)),
                          monoNow: { clockNS(CLOCK_MONOTONIC) }, wallNow: WallClock.now)
do { try runWriter(session: session, ring: ring, shared: shared, hooks: hooks) } catch { writeError = "\(error)" }
captureDone.wait()
_ = signalSources

struct Summary: Codable {
    var device: OpenedDevice
    var negotiated: Negotiated
    /// What the hardware offered before anything was requested of it, and the channel count the conversion used.
    var capabilities: DeviceCapabilities
    var conversionChannels: Int
    var tape: String
    var prior: TapeWriter.PriorTape?
    var samples: Int64
    var records: Int
    var ring: FrameRing.Counters
    var events: [FrameRing.OverflowEvent]
    /// The first rollover target of each capture session, and every split made.
    var sessionTargets: [Int64?]
    var rollovers: [RolloverTimeline.Split]
    var deviceOverruns: [String]
    var outages: [String]
    var elapsedS: Double
    var testHooks: Bool
    var failure: String?
    enum CodingKeys: String, CodingKey {
        case device, negotiated, capabilities, tape, prior, samples, records, ring, events, outages, failure
        case conversionChannels = "conversion_channels"
        case deviceOverruns = "device_overruns", elapsedS = "elapsed_s", testHooks = "test_hooks"
        case sessionTargets = "session_rollover_targets", rollovers
    }
}
#if TAPE_TEST_HOOKS
let builtWithHooks = true
#else
let builtWithHooks = false
#endif
let (counters, events) = ring.snapshot()
let rolloverLog = side.log()
let summary = Summary(device: openedDevice, negotiated: negotiated, capabilities: capabilities, conversionChannels: Int(inputChannels),
                      tape: tapePath, prior: writer.prior, samples: writer.samples,
                      records: writer.records, ring: counters, events: events,
                      sessionTargets: rolloverLog.sessions, rollovers: rolloverLog.rollovers, deviceOverruns: shared.overruns,
                      outages: shared.outages, elapsedS: Double(clockNS(CLOCK_MONOTONIC) - shared.startNS) / 1e9,
                      testHooks: builtWithHooks, failure: writeError ?? shared.failure)
let enc = JSONEncoder()
enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
print(String(decoding: try! enc.encode(summary), as: UTF8.self))
exit(summary.failure == nil ? 0 : 1)
