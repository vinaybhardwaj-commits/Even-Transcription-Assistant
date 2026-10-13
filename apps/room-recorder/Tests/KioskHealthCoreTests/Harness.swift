import Foundation
import Testing
@testable import KioskHealthCore

// Minimal self-contained test harness (no XCTest dependency: runs with Command Line Tools only).

enum T {
    nonisolated(unsafe) static var assertions = 0
    nonisolated(unsafe) static var tests = 0
    nonisolated(unsafe) static var failedTests = 0
    nonisolated(unsafe) static var current = ""
    nonisolated(unsafe) static var currentFailed = false
    nonisolated(unsafe) static var tmpDirs: [URL] = []
}

func test(_ name: String, _ body: () -> Void) {
    T.current = name
    T.currentFailed = false
    T.tests += 1
    body()
    if T.currentFailed { T.failedTests += 1 }
}

func check(_ cond: Bool, _ msg: @autoclosure () -> String = "", file: String = #fileID, line: Int = #line) {
    T.assertions += 1
    if !cond {
        T.currentFailed = true
        let text = "FAIL [\(T.current)] \(file):\(line) \(msg())"
        print(text)
        Issue.record(Comment(rawValue: text))
    }
}

func checkEq<X: Equatable>(_ a: X, _ b: X, _ msg: String = "", file: String = #fileID, line: Int = #line) {
    T.assertions += 1
    if a != b {
        T.currentFailed = true
        let text = "FAIL [\(T.current)] \(file):\(line) expected \(b) got \(a) \(msg)"
        print(text)
        Issue.record(Comment(rawValue: text))
    }
}

// MARK: fixtures / temp dirs

enum Fixtures {
    static let dir: String = {
        let f = #filePath
        return (f as NSString).deletingLastPathComponent + "/Fixtures"
    }()
    static func read(_ name: String) -> String {
        let p = dir + "/" + name
        guard let d = FileManager.default.contents(atPath: p) else {
            print("MISSING FIXTURE \(p)")
            exit(3)
        }
        return String(decoding: d, as: UTF8.self)
    }
}

func tmpDir(_ tag: String = "t") -> URL {
    let u = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("kh-test-\(tag)-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    T.tmpDirs.append(u)
    return u
}

func cleanupTmp() { for u in T.tmpDirs { try? FileManager.default.removeItem(at: u) } }

// MARK: fakes

final class FakeClock: Clock {
    var t: Date
    init(_ t: Date) { self.t = t }
    func now() -> Date { t }
    func advance(_ s: TimeInterval) { t = t.addingTimeInterval(s) }
}

final class RecordingSleeper: Sleeper {
    var total: TimeInterval = 0
    var calls: [TimeInterval] = []
    var onSleep: (() -> Void)?
    func sleep(_ seconds: TimeInterval) { total += seconds; calls.append(seconds); onSleep?() }
}

final class FakeRunner: CommandRunner {
    private var rules: [(prefix: String, results: [CommandResult], idx: Int)] = []
    private var handlers: [(exe: String, fn: ([String]) -> CommandResult)] = []
    private(set) var calls: [String] = []
    /// argv of every call, in order (calls[] has the same data joined with spaces).
    private(set) var argvs: [[String]] = []

    /// Match by prefix of "exe arg1 arg2"; the first matching rule wins. A rule with several results
    /// returns them in order and then repeats the last one.
    func on(_ prefix: String, stdout: String = "", status: Int32 = 0, stderr: String = "") {
        rules.append((prefix, [CommandResult(status: status, stdout: stdout, stderr: stderr)], 0))
    }
    func sequence(_ prefix: String, _ results: [CommandResult]) { rules.append((prefix, results, 0)) }

    /// Decide by the exact argument vector of one executable (checked before the prefix rules).
    func handle(_ exe: String, _ fn: @escaping ([String]) -> CommandResult) { handlers.append((exe, fn)) }

    func run(_ exe: String, _ args: [String], timeout: TimeInterval) -> CommandResult {
        let key = ([exe] + args).joined(separator: " ")
        calls.append(key)
        argvs.append([exe] + args)
        for h in handlers where h.exe == exe { return h.fn(args) }
        for i in rules.indices where key.hasPrefix(rules[i].prefix) {
            let r = rules[i].results[min(rules[i].idx, rules[i].results.count - 1)]
            rules[i].idx += 1
            return r
        }
        return CommandResult(status: 127, stdout: "", stderr: "unmocked: \(key)", timedOut: false, launchError: nil)
    }

    func called(_ fragment: String) -> Bool { calls.contains { $0.contains(fragment) } }
    func count(_ fragment: String) -> Int { calls.filter { $0.contains(fragment) }.count }
}

let fakeSelf = "/fake/kiosk-health"

/// The collectors' disk access in the tests: the hardened reads, as the test's own (non-root) user.
let tailIO = UserIO(files: UnprivilegedUserFiles(), user: "tester")

func makeCtx(runner: FakeRunner = FakeRunner(), config: Config? = nil, now: Date? = nil,
             home: String? = nil, state: StateStore = MemoryState()) -> (Context, FakeClock, RecordingSleeper) {
    var cfg = config ?? Config(machine: "test-mac")
    if config == nil { cfg.consoleUser = "kiosk" }
    let clock = FakeClock(now ?? Date(timeIntervalSince1970: 1_790_000_000))
    let sleeper = RecordingSleeper()
    let ctx = Context(config: cfg, runner: runner, clock: clock, sleeper: sleeper, state: state, files: UnprivilegedUserFiles(), homeOverride: home)
    ctx.selfPath = fakeSelf
    return (ctx, clock, sleeper)
}

/// One `log show --style ndjson` object with the keys the parser reads (plus the usual noise).
func ndjson(_ ts: String, _ msg: String, process: String = "/usr/sbin/coreaudiod", pid: Int = 314,
            type: String = "Default", subsystem: String = "") -> String {
    let d: [String: Any] = ["timestamp": ts, "eventMessage": msg, "processImagePath": process, "processID": pid,
                            "messageType": type, "subsystem": subsystem, "eventType": "logEvent", "category": ""]
    return J.string(d)
}

/// `system_profiler SPAudioDataType -json` with a speaker and, optionally, a USB webcam mic as default input.
func spAudio(input: Bool, inputName: String = "C270 HD WEBCAM") -> String {
    var items = ["{\"_name\":\"Mac mini Speakers\",\"coreaudio_default_audio_output_device\":\"spaudio_yes\",\"coreaudio_device_output\":2,\"coreaudio_device_transport\":\"coreaudio_device_type_builtin\"}"]
    if input {
        let n = inputName.replacingOccurrences(of: "\"", with: "\\\"")
        items.append("{\"_name\":\"\(n)\",\"coreaudio_default_audio_input_device\":\"spaudio_yes\",\"coreaudio_device_input\":1,\"coreaudio_device_transport\":\"coreaudio_device_type_usb\"}")
    }
    return "{\"SPAudioDataType\":[{\"_items\":[" + items.joined(separator: ",") + "],\"_name\":\"coreaudio_device\"}]}"
}

func ist(_ date: String, _ time: String) -> Date {
    TimeFmt.parseStamp(date: date, time: time, frac: nil, tz: "+0530")!
}

func ok(_ out: String) -> CommandResult { CommandResult(status: 0, stdout: out, stderr: "") }
func fail(_ code: Int32 = 1) -> CommandResult { CommandResult(status: code, stdout: "", stderr: "boom") }

func payloadString(_ e: DraftEvent, _ k: String) -> String? { e.payload[k] as? String }


/// `ioreg -r -c IOMobileFramebufferShim` reduced to what the probe reads.
func ioregFB(_ on: Bool) -> String { "      \"NormalModeActive\" = \(on ? "Yes" : "No")\n" }

/// Scripted `ioreg` for the audio presence and display probes. Each list is consumed in order, the last entry repeats.
final class IoregScript {
    var usb: [String] = []
    var engines: [String: String] = [:]   // IOAudio class -> output
    var display: [String] = []
    private(set) var usbCalls = 0
    private(set) var displayCalls = 0
    private let lock = NSLock()
    func install(on r: FakeRunner) {
        r.handle(Tool.ioreg) { [self] args in
            guard let i = args.firstIndex(of: "-c"), i + 1 < args.count else { return fail(1) }
            let cls = args[i + 1]
            lock.lock(); defer { lock.unlock() }
            switch cls {
            case "IOUSBHostDevice":
                let o = usb.isEmpty ? "" : usb[min(usbCalls, usb.count - 1)]
                usbCalls += 1
                return ok(o)
            case "IOMobileFramebufferShim":
                if display.isEmpty { return fail(1) }
                let o = display[min(displayCalls, display.count - 1)]
                displayCalls += 1
                return ok(o)
            default:
                return ok(engines[cls] ?? "")
            }
        }
    }
}
