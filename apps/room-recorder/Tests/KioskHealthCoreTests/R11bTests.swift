import Foundation
@testable import KioskHealthCore

// Round-11b: presence_ok also needs local evidence that the extension's worker is alive while someone is at the console:
// newest mtime under <profile>/Local Extension Settings/<id>/ within 10 min if HID idle < 120 s. Stat and listing only.

private final class WRunner: CommandRunner {
    private(set) var argvs: [[String]] = []
    func run(_ exe: String, _ args: [String], timeout: TimeInterval) -> CommandResult {
        argvs.append([exe] + args)
        if exe == Tool.pgrep { return CommandResult(status: 0, stdout: "1\n", stderr: "") }
        return CommandResult(status: 127, stdout: "", stderr: "unmocked: \(exe)", timedOut: false, launchError: nil)
    }
}

private struct WRig {
    let home: String
    let collector: ChromeCollector
    let clock: FakeClock
    let runner: WRunner
    var dataDir: String { home + ChromeProbe.userDataSuffix }
    var now: Date { clock.now() }
}

/// Fake home: Local State from a fixture, extension version dirs, and (optionally) a worker storage dir whose files have the
/// given ages in seconds before the fake clock. `idle` is what the HID closure reports (nil = unknown).
private func wrig(state: String = "chrome_localstate_default.json", profiles: [String] = ["Default"],
                  workerAges: [String: [Int]] = [:], idle: Double?) -> WRig {
    let home = tmpDir("r11bhome").path
    let data = home + ChromeProbe.userDataSuffix
    try? FileManager.default.createDirectory(atPath: data, withIntermediateDirectories: true)
    try? Fixtures.read(state).write(toFile: data + "/Local State", atomically: true, encoding: .utf8)
    let clock = FakeClock(Date(timeIntervalSince1970: 1_790_000_000))
    for p in profiles {
        let v = "\(data)/\(p)/Extensions/\(ChromeProbe.extensionID)/1.0_0"
        try? FileManager.default.createDirectory(atPath: v, withIntermediateDirectories: true)
    }
    for (p, ages) in workerAges {
        let w = "\(data)/\(p)/\(ChromeProbe.workerStorageDir)/\(ChromeProbe.extensionID)"
        try? FileManager.default.createDirectory(atPath: w, withIntermediateDirectories: true)
        for (i, age) in ages.enumerated() {
            let f = "\(w)/00000\(i).log"
            FileManager.default.createFile(atPath: f, contents: Data("leveldb bytes".utf8))
            try? FileManager.default.setAttributes([.modificationDate: clock.now().addingTimeInterval(-Double(age))], ofItemAtPath: f)
            try? FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: f)   // unreadable: proves nothing is opened
        }
        try? FileManager.default.setAttributes([.modificationDate: clock.now().addingTimeInterval(-86_400)], ofItemAtPath: w)
    }
    let runner = WRunner()
    var cfg = Config(machine: "m"); cfg.consoleUser = "kiosk"
    let ctx = Context(config: cfg, runner: runner, clock: clock, sleeper: RecordingSleeper(), state: MemoryState(), files: UnprivilegedUserFiles(), homeOverride: home)
    let c = ChromeCollector(ctx: ctx)
    c.hidIdle = { idle }
    return WRig(home: home, collector: c, clock: clock, runner: runner)
}

func runR11bTests() {
    test("R11b fresh worker mtime + active console -> presence_ok, evidence age in the payload") {
        let r = wrig(workerAges: ["Default": [30, 400]], idle: 5)
        let res = r.collector.poll()
        let p = res.events[0].payload
        checkEq(p["presence_ok"] as? Bool, true)
        checkEq(p["ext_worker_mtime_age_s"] as? Int, 30, "newest file wins")
        checkEq(p["ext_worker_scope"] as? String, "active")
        checkEq(p["console_active"] as? Bool, true)
        checkEq(p["hid_idle_s"] as? Int, 5)
        check(res.events.allSatisfy { $0.kind != "chrome.alert" })
    }

    test("R11b stale worker (> 10 min) + active console -> not ok, reason ext_worker_stale, alert on the 2nd sample") {
        let r = wrig(workerAges: ["Default": [601, 3000]], idle: 10)
        let (s, _) = r.collector.sample()
        checkEq(s?.failure, "ext_worker_stale")
        let first = r.collector.poll()
        check(first.events.allSatisfy { $0.kind != "chrome.alert" }, "first false sample does not alert")
        checkEq(first.events[0].payload["presence_ok"] as? Bool, false)
        checkEq(first.events[0].payload["ext_worker_mtime_age_s"] as? Int, 601)
        r.clock.advance(60)
        let alerts = r.collector.poll().events.filter { $0.kind == "chrome.alert" }
        checkEq(alerts.count, 1)
        checkEq(alerts.first?.payload["reason"] as? String, "ext_worker_stale")
    }

    test("R11b ok -> stale flips with an alert at once") {
        let r = wrig(workerAges: ["Default": [20]], idle: 5)
        checkEq(r.collector.poll().events.filter { $0.kind == "chrome.alert" }.count, 0)
        r.clock.advance(700)   // nothing wrote since: the same file is now 720 s old
        let res = r.collector.poll()
        checkEq(res.events.filter { $0.kind == "chrome.alert" }.first?.payload["reason"] as? String, "ext_worker_stale")
    }

    test("R11b the boundaries: age 600 is fresh, 601 is stale; HID idle 119 is active, 120 is not") {
        checkEq(wrig(workerAges: ["Default": [600]], idle: 1).collector.sample().0?.failure, nil)
        checkEq(wrig(workerAges: ["Default": [601]], idle: 1).collector.sample().0?.failure, "ext_worker_stale")
        checkEq(wrig(workerAges: ["Default": [5000]], idle: 119).collector.sample().0?.failure, "ext_worker_stale")
        checkEq(wrig(workerAges: ["Default": [5000]], idle: 120).collector.sample().0?.failure, nil, "idle exactly 120 s is not active")
    }

    test("R11b idle console (or unknown idle) is unaffected, whatever the worker evidence says") {
        for idle in [Double?(120), 600, 86_400, nil] {
            let stale = wrig(workerAges: ["Default": [9000]], idle: idle).collector.sample().0
            checkEq(stale?.failure, nil, "stale + idle \(String(describing: idle))")
            let missing = wrig(workerAges: [:], idle: idle).collector.sample().0
            checkEq(missing?.failure, nil, "missing dir + idle \(String(describing: idle))")
            checkEq(missing?.consoleActive, false)
        }
    }

    test("R11b missing worker dir + active console -> ext_dir_missing, age is null") {
        let r = wrig(workerAges: [:], idle: 3)
        let (s, _) = r.collector.sample()
        checkEq(s?.failure, "ext_dir_missing")
        let p = r.collector.poll().events[0].payload
        check(p["ext_worker_mtime_age_s"] is NSNull)
        checkEq(p["presence_ok"] as? Bool, false)
        // the older checks keep their priority: no extension version dir at all is still ext_missing
        let none = wrig(profiles: [], workerAges: [:], idle: 3).collector.sample().0
        checkEq(none?.failure, "ext_missing:Default")
    }

    test("R11b only the ACTIVE profile counts; with several active profiles the newest wins") {
        // Default is active, Profile 1 is not: a fresh Profile 1 worker must not rescue a stale Default one
        let a = wrig(profiles: ["Default", "Profile 1"], workerAges: ["Default": [5000], "Profile 1": [10]], idle: 1)
        checkEq(a.collector.sample().0?.failure, "ext_worker_stale")
        // two active profiles: the newest across them
        let b = wrig(state: "chrome_localstate_two_active.json", profiles: ["Default", "Profile 1"],
                     workerAges: ["Default": [5000], "Profile 1": [40]], idle: 1)
        let (s, _) = b.collector.sample()
        checkEq(s?.failure, nil)
        checkEq(s?.workerAgeS, 40)
        checkEq(s?.workerScope, "active")
    }

    test("R11b no active profile known: newest across all profile dirs, and the payload says so") {
        let r = wrig(state: "chrome_localstate_nulls.json", profiles: ["Default", "Profile 1"],
                     workerAges: ["Default": [900], "Profile 1": [60]], idle: 2)
        let p = r.collector.poll().events[0].payload
        checkEq(p["ext_worker_scope"] as? String, "all_profiles")
        checkEq(p["ext_worker_mtime_age_s"] as? Int, 60)
        checkEq(p["presence_ok"] as? Bool, false, "still no_profile: the older rule is unchanged")
    }

    test("R11b stat and listing only: unreadable (mode 000) worker files do not matter, and only pgrep ever runs") {
        let r = wrig(workerAges: ["Default": [15]], idle: 4)   // wrig makes every worker file mode 000
        let f = "\(r.dataDir)/Default/\(ChromeProbe.workerStorageDir)/\(ChromeProbe.extensionID)/000000.log"
        check(FileHandle(forReadingAtPath: f) == nil, "fixture file really is unreadable")
        checkEq(r.collector.sample().0?.failure, nil)
        for a in r.runner.argvs { check(a[0] == Tool.pgrep, "\(a)") }
    }

    test("R11b chrome.profile is not re-emitted every minute just because the age and idle seconds tick") {
        let r = wrig(workerAges: ["Default": [10]], idle: 5)
        checkEq(r.collector.poll().events.count, 1)
        for _ in 0..<4 {
            r.clock.advance(60)
            // keep the worker fresh so presence stays ok while the age counter restarts each time
            let f = "\(r.dataDir)/Default/\(ChromeProbe.workerStorageDir)/\(ChromeProbe.extensionID)/000000.log"
            try? FileManager.default.setAttributes([.modificationDate: r.clock.now().addingTimeInterval(-10)], ofItemAtPath: f)
            checkEq(r.collector.poll().events.count, 0, "unchanged state inside 5 min")
        }
    }

    test("R11b payload keys: the old ones are kept, the new ones are added, depth stays small") {
        let p = wrig(workerAges: ["Default": [5]], idle: 5).collector.poll().events[0].payload
        for k in ["running", "last_used", "active", "guest", "ext", "presence_ok"] { check(p[k] != nil, k) }
        for k in ["ext_worker_mtime_age_s", "ext_worker_scope", "hid_idle_s", "console_active"] { check(p[k] != nil, k) }
        check(SinkGuard.depth(p) <= 3)
    }
}
