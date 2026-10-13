import Foundation
@testable import KioskHealthCore

// Round-6: the chrome collector (Local State two keys, extension version dirs, pgrep) for the presence signal.

/// Fakes pgrep and refuses everything else (0.1.36 R2: no tool runs on a user path any more; Local State is parsed in process,
/// as the room user). Records every command so a test can prove nothing else was run.
private final class ChromeRunner: CommandRunner {
    var chromeRunning: CommandResult = CommandResult(status: 0, stdout: "123\n", stderr: "")
    private(set) var argvs: [[String]] = []
    func run(_ exe: String, _ args: [String], timeout: TimeInterval) -> CommandResult {
        argvs.append([exe] + args)
        if exe == Tool.pgrep { return chromeRunning }
        return CommandResult(status: 127, stdout: "", stderr: "unmocked: \(exe)", timedOut: false, launchError: nil)
    }
}

private struct ChromeRig {
    let home: String
    let runner: ChromeRunner
    let collector: ChromeCollector
    let clock: FakeClock
    var dataDir: String { home + ChromeProbe.userDataSuffix }
}

/// A fake home with Chrome's Local State copied from a fixture (nil = no Local State at all) and the given
/// extension versions per profile ("." names are created too, to prove they are ignored).
private func chromeRig(state fixture: String?, ext: [String: [String]] = [:], running: Bool = true) -> ChromeRig {
    let home = tmpDir("r6home").path
    let data = home + ChromeProbe.userDataSuffix
    try? FileManager.default.createDirectory(atPath: data, withIntermediateDirectories: true)
    if let f = fixture {
        try? Fixtures.read(f).write(toFile: data + "/Local State", atomically: true, encoding: .utf8)
    }
    for (profile, versions) in ext {
        let base = "\(data)/\(profile)/Extensions/\(ChromeProbe.extensionID)"
        try? FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
        for v in versions { try? FileManager.default.createDirectory(atPath: "\(base)/\(v)", withIntermediateDirectories: true) }
        FileManager.default.createFile(atPath: base + "/.DS_Store", contents: Data())
        try? FileManager.default.createDirectory(atPath: base + "/.tmp-update", withIntermediateDirectories: true)
    }
    let runner = ChromeRunner()
    runner.chromeRunning = running ? CommandResult(status: 0, stdout: "123\n", stderr: "") : CommandResult(status: 1, stdout: "", stderr: "")
    let clock = FakeClock(Date(timeIntervalSince1970: 1_790_000_000))
    var cfg = Config(machine: "m"); cfg.consoleUser = "kiosk"
    let ctx = Context(config: cfg, runner: runner, clock: clock, sleeper: RecordingSleeper(), state: MemoryState(), files: UnprivilegedUserFiles(), homeOverride: home)
    return ChromeRig(home: home, runner: runner, collector: ChromeCollector(ctx: ctx), clock: clock)
}

func runR6Tests() {
    test("R6 chrome: healthy Default profile with the extension installed -> presence_ok true, no alert") {
        let r = chromeRig(state: "chrome_localstate_default.json", ext: ["Default": ["3.4.1_0", "3.4.0_0"]])
        let res = r.collector.poll()
        checkEq(res.events.map { $0.kind }, ["chrome.profile"])
        let p = res.events[0].payload
        checkEq(p["running"] as? Bool, true)
        checkEq(p["last_used"] as? String, "Default")
        checkEq(p["active"] as? [String], ["Default"])
        checkEq(p["guest"] as? Bool, false)
        checkEq(((p["ext"] as? [String: Any])?["Default"]) as? [String], ["3.4.0_0", "3.4.1_0"], "sorted version dirs, dot entries ignored")
        checkEq(p["presence_ok"] as? Bool, true)
    }

    test("R6 chrome: reads only the two Local State keys, in process; pgrep is the only command that runs") {
        let r = chromeRig(state: "chrome_localstate_default.json", ext: ["Default": ["1.0_0"]])
        _ = r.collector.poll()
        for a in r.runner.argvs {
            check(a[0] == Tool.pgrep, "only pgrep runs; no tool is pointed at a user's file: \(a)")
            check(!a.joined(separator: " ").contains("Preferences") && !a.joined(separator: " ").contains("Cookies")
                  && !a.joined(separator: " ").contains("Login Data") && !a.joined(separator: " ").contains("Local State"))
        }
        let pg = r.runner.argvs.first { $0[0] == Tool.pgrep }!
        checkEq(pg, [Tool.pgrep, "-x", "-u", "kiosk", "Google Chrome"])
        check(!Tool.all.contains("/usr/bin/plutil"), "plutil is not even on the tool list any more")
    }

    test("R6 chrome: Guest Profile as last_used -> guest, presence_ok false, alert reason guest on the first flip") {
        let healthy = chromeRig(state: "chrome_localstate_default.json", ext: ["Default": ["1.0_0"]])
        _ = healthy.collector.poll()   // establish true
        // same collector, Local State now says Guest Profile
        try? Fixtures.read("chrome_localstate_guest.json").write(toFile: healthy.dataDir + "/Local State", atomically: true, encoding: .utf8)
        let res = healthy.collector.poll()
        checkEq(res.events.map { $0.kind }, ["chrome.profile", "chrome.alert"])
        checkEq(res.events[0].payload["guest"] as? Bool, true)
        checkEq(res.events[0].payload["presence_ok"] as? Bool, false)
        checkEq(res.events[1].payload["reason"] as? String, "guest")
        checkEq(res.events[1].payload["active"] as? [String], ["Guest Profile"])
    }

    test("R6 chrome: Guest Profile only in the active list also counts as guest") {
        let r = chromeRig(state: "chrome_localstate_guest_active_only.json", ext: ["Default": ["1.0_0"]])
        let p = r.collector.poll().events[0].payload
        checkEq(p["guest"] as? Bool, true)
        checkEq(p["last_used"] as? String, "Default")
        checkEq(p["presence_ok"] as? Bool, false)
    }

    test("R6 chrome: empty active list falls back to last_used") {
        let r = chromeRig(state: "chrome_localstate_empty_active.json", ext: ["Profile 1": ["2.0_0"]])
        let p = r.collector.poll().events[0].payload
        checkEq(p["active"] as? [String], ["Profile 1"])
        checkEq(p["presence_ok"] as? Bool, true)
        checkEq(((p["ext"] as? [String: Any])?["Profile 1"]) as? [String], ["2.0_0"])
    }

    test("R6 chrome: JSON null values and a missing profile key read as empty -> no_profile, never a crash") {
        for fx in ["chrome_localstate_nulls.json", "chrome_localstate_no_profile_key.json"] {
            let r = chromeRig(state: fx)
            let res = r.collector.poll()
            let p = res.events[0].payload
            check(p["last_used"] is NSNull, fx)
            checkEq(p["active"] as? [String], [], fx)
            checkEq(p["presence_ok"] as? Bool, false, fx)
            checkEq(r.collector.sample().0?.failure, "no_profile", fx)
            check(res.events.allSatisfy { $0.kind != "chrome.alert" }, "first false sample alone does not alert")
        }
    }

    test("R6 chrome: no Local State file at all -> noted, no_profile") {
        let r = chromeRig(state: nil)
        let (s, notes) = r.collector.sample()
        checkEq(s?.failure, "no_profile")
        check(notes.contains { $0.contains("Local State not found") })
    }

    test("R6 chrome: profile names that are not one path component are ignored (no path traversal)") {
        let r = chromeRig(state: "chrome_localstate_traversal.json", ext: ["Default": ["1.0_0"]])
        let p = r.collector.poll().events[0].payload
        checkEq(p["active"] as? [String], ["Default"], "falls back to last_used, the unsafe names are dropped")
        let (s, _) = r.collector.sample()
        check(s?.ext.keys.allSatisfy { ChromeProbe.safeProfile($0) } == true)
    }

    test("R6 chrome: extension missing for an active profile -> ext_missing:<profile>; a dot-only dir does not count") {
        let r = chromeRig(state: "chrome_localstate_two_active.json", ext: ["Default": ["1.0_0"], "Profile 1": []])
        let (s, _) = r.collector.sample()
        checkEq(s?.failure, "ext_missing:Profile 1")
        checkEq(s?.ext["Profile 1"], [])
        checkEq(s?.ext["Default"], ["1.0_0"])
        // Profile 1 has only ".DS_Store" and ".tmp-update"
        let none = chromeRig(state: "chrome_localstate_default.json")
        checkEq(none.collector.sample().0?.failure, "ext_missing:Default")
    }

    test("R6 chrome: Chrome not running -> not_running (takes priority), pgrep exit 1") {
        let r = chromeRig(state: "chrome_localstate_default.json", ext: ["Default": ["1.0_0"]], running: false)
        let (s, _) = r.collector.sample()
        checkEq(s?.running, false)
        checkEq(s?.failure, "not_running")
        let g = chromeRig(state: "chrome_localstate_guest.json", running: false)
        checkEq(g.collector.sample().0?.failure, "not_running")
    }

    test("R6 chrome: pgrep that cannot answer skips the sample (no false alert), with a note") {
        let r = chromeRig(state: "chrome_localstate_default.json", ext: ["Default": ["1.0_0"]])
        _ = r.collector.poll()
        r.runner.chromeRunning = CommandResult(status: 2, stdout: "", stderr: "bad")
        let res = r.collector.poll()
        checkEq(res.events.count, 0)
        check(res.notes.contains { $0.contains("pgrep did not answer") })
        r.runner.chromeRunning = CommandResult(status: -1, stdout: "", stderr: "", timedOut: true, launchError: nil)
        checkEq(r.collector.poll().events.count, 0)
    }

    test("R6 chrome: alert on true -> false, and when false for two samples in a row, once per episode") {
        // starts already broken: first sample no alert, second sample alert, third none
        let r = chromeRig(state: "chrome_localstate_guest.json")
        let a = r.collector.poll(), b = r.collector.poll(), c = r.collector.poll()
        checkEq(a.events.filter { $0.kind == "chrome.alert" }.count, 0)
        checkEq(b.events.filter { $0.kind == "chrome.alert" }.count, 1)
        checkEq(c.events.filter { $0.kind == "chrome.alert" }.count, 0)
        // recover, then break again: alert at once on the flip
        try? Fixtures.read("chrome_localstate_default.json").write(toFile: r.dataDir + "/Local State", atomically: true, encoding: .utf8)
        try? FileManager.default.createDirectory(atPath: "\(r.dataDir)/Default/Extensions/\(ChromeProbe.extensionID)/1.0_0", withIntermediateDirectories: true)
        let ok = r.collector.poll()
        checkEq(ok.events.map { $0.kind }, ["chrome.profile"])
        checkEq(ok.events[0].payload["presence_ok"] as? Bool, true)
        r.runner.chromeRunning = CommandResult(status: 1, stdout: "", stderr: "")
        let flip = r.collector.poll()
        checkEq(flip.events.map { $0.kind }, ["chrome.profile", "chrome.alert"])
        checkEq(flip.events[1].payload["reason"] as? String, "not_running")
    }

    test("R6 chrome: chrome.profile goes out on change and at least every 5 minutes, not every sample") {
        let r = chromeRig(state: "chrome_localstate_default.json", ext: ["Default": ["1.0_0"]])
        checkEq(r.collector.poll().events.count, 1)
        for _ in 0..<4 { r.clock.advance(60); checkEq(r.collector.poll().events.count, 0, "unchanged inside 5 min") }
        r.clock.advance(60)
        checkEq(r.collector.poll().events.map { $0.kind }, ["chrome.profile"], "5 min elapsed")
        r.clock.advance(60)
        r.runner.chromeRunning = CommandResult(status: 1, stdout: "", stderr: "")
        check(r.collector.poll().events.contains { $0.kind == "chrome.profile" }, "a change goes out at once")
    }

    test("R6 chrome: event classes: chrome.alert is protected (flushed at once), chrome.profile is droppable") {
        check(EventKind.isProtected("chrome.alert"))
        check(!EventKind.isDroppable("chrome.alert"))
        check(EventKind.isDroppable("chrome.profile"))
        checkEq(SpoolClass.of("chrome.alert"), .protected)
        checkEq(SpoolClass.of("chrome.profile"), .droppable)
    }

    test("R6 chrome: no console user -> no sample, no events, a note") {
        let ctx = Context(config: Config(machine: "m"), runner: FakeRunner(), clock: FakeClock(Date()), sleeper: RecordingSleeper(), state: MemoryState(), files: UnprivilegedUserFiles())
        let fr = ctx.runner as! FakeRunner
        fr.on("/usr/bin/stat", stdout: "root\n")
        let res = ChromeCollector(ctx: ctx).poll()
        checkEq(res.events.count, 0)
        check(res.notes.contains { $0.contains("no console user") })
    }
}
