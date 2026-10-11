import Foundation
@testable import KioskHealthCore

private func write(_ path: String, _ text: String) {
    try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: path, contents: text.data(using: .utf8))
}

private func setMTime(_ path: String, _ d: Date) {
    try? FileManager.default.setAttributes([.modificationDate: d], ofItemAtPath: path)
}

func runDriftConfigRecorderTests() {
    // MARK: config

    test("config: defaults are safe (post:false), token never printed") {
        let c = Config.parse(["machine": "OPD-6.local", "token": "SECRET-TOKEN-123", "post": false])
        check(!c.post)
        check(!c.actions.audioLadder && !c.actions.rebootRung && c.actions.darkwakeWatchdog)
        let summary = J.string(c.redactedSummary())
        check(!summary.contains("SECRET-TOKEN-123"))
        check(summary.contains("\"token_set\":true"))
        checkEq(Config.parse([:]).post, false)
    }

    test("config: baseline merge, disablesleep alias, bool/number stringification") {
        let c = Config.parse(["baseline": ["disablesleep": 1, "displaysleep": 0, "autorestart": true]])
        checkEq(c.baseline["SleepDisabled"], "1")
        checkEq(c.baseline["displaysleep"], "0")
        checkEq(c.baseline["autorestart"], "1")
        checkEq(c.baseline["womp"], "1", "untouched defaults remain")
        check(c.baseline["disablesleep"] == nil)
    }

    test("config: missing and invalid files degrade to defaults with a note") {
        let missing = Config.load(path: "/nonexistent/kh-config.json")
        check(!missing.post && !missing.notes.isEmpty)
        let d = tmpDir("cfg")
        let bad = d.appendingPathComponent("bad.json").path
        write(bad, "{not json")
        check(!Config.load(path: bad).notes.isEmpty)
        let good = d.appendingPathComponent("good.json").path
        write(good, "{\"machine\":\"m1\",\"room_id\":\"room_x\",\"post\":true,\"actions\":{\"audio_ladder\":true,\"reboot_rung\":true}}")
        let c = Config.load(path: good)
        checkEq(c.machine, "m1"); checkEq(c.roomID, "room_x"); check(c.post)
        check(c.actions.audioLadder && c.actions.rebootRung)
    }

    // MARK: drift

    test("drift: pmset custom/live fixtures parse") {
        let profiles = PmsetSettings.parseCustom(Fixtures.read("pmset_custom.txt"))
        let ac = profiles["AC Power"]!
        checkEq(ac["sleep"], "0"); checkEq(ac["disksleep"], "0"); checkEq(ac["displaysleep"], "0")
        checkEq(ac["womp"], "1"); checkEq(ac["autorestart"], "1")
        checkEq(ac["Sleep On Power Button"], "1", "multi-word key")
        let live = PmsetSettings.parseLive(Fixtures.read("pmset_g_live.txt"))
        checkEq(live["SleepDisabled"], "0")
        checkEq(live["displaysleep"], "30")
    }

    test("drift: kiosk-like state has no pmset drift; wrong values report field/expected/actual") {
        var st = DriftState()
        st.pmsetCustom = PmsetSettings.parseCustom(Fixtures.read("pmset_custom.txt"))["AC Power"]!
        st.pmsetLive = ["SleepDisabled": "1"]
        st.caffeinatePresent = true
        st.chromeForcelist = ["abcdef;https://example.invalid/update.xml"]
        var base = Config.defaultBaseline
        base["chrome_forcelist"] = "skip"
        checkEq(Drift.compare(baseline: base, state: st, consoleUser: nil), [])

        st.pmsetLive = PmsetSettings.parseLive(Fixtures.read("pmset_g_live.txt"))   // SleepDisabled 0, displaysleep 30
        st.pmsetCustom["displaysleep"] = "30"
        st.caffeinatePresent = false
        let d = Drift.compare(baseline: Config.defaultBaseline, state: st, consoleUser: "kiosk")
        let fields = d.map { $0.field }
        check(fields.contains("pmset.displaysleep"))
        check(fields.contains("pmset.SleepDisabled"))
        check(fields.contains("caffeinate"))
        check(fields.contains("autologin_user"), "console user expected as autologin")
        let sd = d.first { $0.field == "pmset.SleepDisabled" }!
        checkEq(sd.expected, "1"); checkEq(sd.actual, "0")
        checkEq(d.first { $0.field == "pmset.displaysleep" }!.actual, "30")
    }

    test("drift: setting not reported at all is 'absent', not silently fine") {
        var st = DriftState()
        st.caffeinatePresent = true
        st.chromeForcelist = ["x"]
        let d = Drift.compare(baseline: ["sleep": "0"], state: st, consoleUser: nil)
        checkEq(d.first { $0.field == "pmset.sleep" }?.actual, "absent")
    }

    test("drift: recorder version and Chrome force-list") {
        var st = DriftState()
        st.caffeinatePresent = true
        st.recorderAppFound = true
        st.recorderVersion = "0.1.24"
        st.chromeForcelist = ["aaa;https://u.invalid", "bbb;https://u.invalid"]
        var base: [String: String] = ["recorder_app_version": "0.1.25", "chrome_forcelist_contains": "bbb"]
        var d = Drift.compare(baseline: base, state: st, consoleUser: nil)
        checkEq(d, [DriftItem(field: "recorder_app_version", expected: "0.1.25", actual: "0.1.24")])
        base = ["chrome_forcelist_contains": "zzz"]
        d = Drift.compare(baseline: base, state: st, consoleUser: nil)
        checkEq(d.first?.field, "chrome_forcelist")
        st.chromeForcelist = nil
        d = Drift.compare(baseline: [:], state: st, consoleUser: nil)
        checkEq(d, [DriftItem(field: "chrome_forcelist", expected: "present(non-empty)", actual: "absent")])
    }

    test("drift: Chrome managed-preferences plist ExtensionInstallForcelist") {
        let plist: [String: Any] = ["ExtensionInstallForcelist": ["aaa;https://u.invalid", "bbb;https://u.invalid"], "Other": 1]
        let data = try! PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        checkEq(ChromePolicy.forcelist(plistData: data)?.count, 2)
        let none = try! PropertyListSerialization.data(fromPropertyList: ["Other": 1], format: .xml, options: 0)
        check(ChromePolicy.forcelist(plistData: none) == nil)
    }

    test("drift collector: observes with a fake machine, report only") {
        let home = tmpDir("home").path
        let app = home + "/Applications/EvenScribe Room Recorder.app/Contents"
        let info: [String: Any] = ["CFBundleShortVersionString": "0.1.24"]
        try? FileManager.default.createDirectory(atPath: app, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: app + "/Info.plist",
                                       contents: try! PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0))
        let r = FakeRunner()
        r.on("/usr/bin/pmset -g custom", stdout: Fixtures.read("pmset_custom.txt"))
        r.on("/usr/bin/pmset -g", stdout: Fixtures.read("pmset_g_live.txt"))
        r.on("/usr/bin/defaults read", stdout: "kiosk\n")
        r.on("/usr/bin/pgrep -x caffeinate", stdout: "668\n")
        var cfg = Config(machine: "m"); cfg.consoleUser = "kiosk"; cfg.baseline["recorder_app_version"] = "0.1.24"
        let (ctx, _, _) = makeCtx(runner: r, config: cfg, home: home)
        let (obs, res) = DriftCollector(ctx: ctx).snapshot()
        checkEq(obs["recorder_app_version"] as? String, "0.1.24")
        checkEq(obs["autologin_user"] as? String, "kiosk")
        checkEq(obs["caffeinate_present"] as? Bool, true)
        let fields = res.events.map { $0.payload["field"] as? String ?? "" }
        check(fields.contains("pmset.SleepDisabled"), "live SleepDisabled is 0 in the Mini fixture")
        check(!fields.contains("caffeinate") && !fields.contains("recorder_app_version"))
        check(!r.calls.contains { $0.contains("pmset -a") || $0.contains("sudo") }, "never fixes drift")
    }

    // MARK: recorder status / session gating

    test("recorder status: fields whitelisted, other keys by name only") {
        let json = "{\"pending_piece_count\":0,\"session_id\":\"bs_h25yeq3u\",\"state\":\"recording\",\"updated_at\":\"2026-10-05T08:25:49Z\",\"patient_hint\":\"SHOULD-NOT-LEAK\"}"
        let s = RecorderStatusParser.parse(json.data(using: .utf8))
        checkEq(s.state, "recording"); checkEq(s.sessionID, "bs_h25yeq3u"); checkEq(s.pendingPieces, 0)
        checkEq(s.otherKeys, ["patient_hint"])
        let snap = RecorderSnapshot(status: s, open: .yes, newestTapeMTime: nil, newestTapeFile: nil, recorderDirFound: true)
        check(!J.string(snap.payload()).contains("SHOULD-NOT-LEAK"))
    }

    test("recorder session gating: recording open, ready closed, missing unknown (fail closed), garbage unknown") {
        func open(_ s: String?) -> SessionOpen { RecorderStatusParser.sessionOpen(RecorderStatusParser.parse(s?.data(using: .utf8))) }
        checkEq(open("{\"state\":\"recording\",\"session_id\":\"bs_1\"}"), .yes)
        checkEq(open("{\"state\":\"ready\",\"session_id\":null}"), .no)
        checkEq(open("{\"state\":\"idle\"}"), .no)
        checkEq(open("{\"state\":\"paused\",\"session_id\":\"bs_1\"}"), .yes)
        checkEq(open("{\"state\":\"some-new-state\"}"), .yes, "unknown vocabulary is treated as open")
        checkEq(open(nil), .unknown, "absent status.json fails closed")
        checkEq(open("{broken"), .unknown)
        checkEq(open("{\"session_id\":\"bs_1\"}"), .unknown)
    }

    test("recorder snapshot: newest tape mtime from the newest capture segment") {
        let home = tmpDir("rec").path
        let rr = home + "/Library/Application Support/EvenScribe/RoomRecorder"
        write(rr + "/status.json", "{\"state\":\"recording\",\"session_id\":\"bs_new\"}")
        write(rr + "/captures/bs_old/seg_a/tape.pcm", "x")
        write(rr + "/captures/bs_new/seg_b/tape.pcm", "x")
        write(rr + "/captures/bs_new/seg_b/tape.idx", "x")
        let t0 = Date(timeIntervalSince1970: 1_790_000_000)
        setMTime(rr + "/captures/bs_old", t0.addingTimeInterval(-3600))
        setMTime(rr + "/captures/bs_new", t0)
        setMTime(rr + "/captures/bs_new/seg_b/tape.pcm", t0.addingTimeInterval(100))
        setMTime(rr + "/captures/bs_new/seg_b/tape.idx", t0.addingTimeInterval(50))
        let (ctx, _, _) = makeCtx(home: home)
        let snap = RecorderState.read(ctx)
        checkEq(snap.open, .yes)
        checkEq(snap.newestTapeMTime, t0.addingTimeInterval(100))
        checkEq(snap.newestTapeFile, "tape.pcm")
        let (ctx2, _, _) = makeCtx(home: tmpDir("nohome").path)
        checkEq(RecorderState.read(ctx2).open, .unknown, "no recorder folder fails closed")
    }

    // MARK: tail / filter / limiter

    test("tail: first sight ships nothing (tail -n 0), incremental reads, partial line held back") {
        let d = tmpDir("tail").path
        let f = d + "/t.log"
        write(f, "a one\nb error two\n")
        let r1 = Tail.read(io: tailIO, path: f, pos: nil)!
        checkEq(r1.lines, [], "history is not shipped on first sight")
        let r2 = Tail.read(io: tailIO, path: f, pos: r1.pos)!
        checkEq(r2.lines, [])
        let h = FileHandle(forWritingAtPath: f)!
        _ = try? h.seekToEnd(); try? h.write(contentsOf: "c three\nd par".data(using: .utf8)!); try? h.close()
        let r3 = Tail.read(io: tailIO, path: f, pos: r2.pos)!
        checkEq(r3.lines, ["c three"], "half-written line not consumed")
        let h2 = FileHandle(forWritingAtPath: f)!
        _ = try? h2.seekToEnd(); try? h2.write(contentsOf: "tial\n".data(using: .utf8)!); try? h2.close()
        checkEq(Tail.read(io: tailIO, path: f, pos: r3.pos)!.lines, ["d partial"])
    }

    test("tail: rotation and truncation restart from zero, an old file is skipped on first sight") {
        let d = tmpDir("tail2").path
        let f = d + "/t.log"
        write(f, "old1\nold2\n")
        let now = Date()
        let r1 = Tail.read(io: tailIO, path: f, pos: nil)!
        try? FileManager.default.removeItem(atPath: f)
        write(f, "new1\n")
        let r2 = Tail.read(io: tailIO, path: f, pos: r1.pos)!
        checkEq(r2.lines, ["new1"], "rotated (new inode)")
        write(f, "x\n")   // truncate in place (same inode, smaller)
        let r3 = Tail.read(io: tailIO, path: f, pos: TailPos(inode: r2.pos.inode, offset: 9999))!
        checkEq(r3.lines, ["x"])
        let stale = d + "/stale.log"
        write(stale, "ancient error\n")
        setMTime(stale, now.addingTimeInterval(-3 * 86400))
        checkEq(Tail.read(io: tailIO, path: stale, pos: nil)!.lines, [])
    }

    test("recorder log filter and 200-lines-per-minute limiter") {
        for l in ["tapewriter: no durable growth for 30s", "physical_fallback_required", "recorder exited with code 1",
                  "stream stopped", "Error: write failed", "fallback to builtin mic"] { check(RecorderLogFilter.matches(l), l) }
        for l in ["room-recorder: microphone authorized", "room session read from room-session.json", "chunk 12 written"] { check(!RecorderLogFilter.matches(l), l) }
        check(!RecorderLogFilter.matches("\t14  room-recorder                       0x000000010078b8ad $sxIeAgHr_xs5Error_pIegHrzo_s8SendableRzs5NeverORs_r0_lTRyt_Tg5TATQ0_ + 1"),
              "mangled-symbol stack frames are not log errors")
        var lim = RateLimiter(cap: 200, window: 60)
        let t0 = Date(timeIntervalSince1970: 1_790_000_000)
        var allowed = 0
        for _ in 0..<500 where lim.allow(now: t0.addingTimeInterval(10)) { allowed += 1 }
        checkEq(allowed, 200)
        checkEq(lim.takeDropped(), 300)
        check(lim.allow(now: t0.addingTimeInterval(80)), "new window")
    }

    test("recorder log collector: ships only matching lines, adds recv_ts, status on change, no replays") {
        let home = tmpDir("rlog").path
        let rr = home + "/Library/Application Support/EvenScribe/RoomRecorder"
        write(rr + "/launchd.log", "room-recorder: old history\n")
        write(rr + "/captures/bs_a/seg_b/tapewriter.log", "old history\n")
        write(rr + "/status.json", "{\"state\":\"recording\",\"session_id\":\"bs_a\",\"pending_piece_count\":2,\"updated_at\":\"2026-10-05T08:25:49Z\"}")
        let (ctx, clock, _) = makeCtx(home: home)
        let rc = RecorderLogCollector(ctx: ctx)
        // first poll: the files are history (tail -n 0); only the status event leaves
        let base = rc.poll()
        checkEq(base.events.filter { $0.kind == "recorder.log" }.count, 0)
        checkEq(base.events.filter { $0.kind == "recorder.status" }.count, 1)
        clock.advance(10)
        func appendTo(_ path: String, _ text: String) {
            let h = FileHandle(forWritingAtPath: path)!
            _ = try? h.seekToEnd(); try? h.write(contentsOf: text.data(using: .utf8)!); try? h.close()
        }
        appendTo(rr + "/launchd.log", "room-recorder: microphone authorized\nroom-recorder: tape writer exited unexpectedly\n")
        appendTo(rr + "/captures/bs_a/seg_b/tapewriter.log", "chunk ok\nno durable growth for 12s\nphysical_fallback_required\n")
        let first = rc.poll()
        let logs = first.events.filter { $0.kind == "recorder.log" }
        checkEq(logs.count, 3)
        check(logs.allSatisfy { $0.payload["recv_ts"] is String })
        check(logs.contains { ($0.payload["file"] as? String) == "launchd.log" })
        check(logs.contains { ($0.payload["file"] as? String)?.hasSuffix("tapewriter.log") == true })
        clock.advance(10)
        checkEq(rc.poll().events.count, 0, "no replay, status unchanged")
        let h = FileHandle(forWritingAtPath: rr + "/launchd.log")!
        _ = try? h.seekToEnd(); try? h.write(contentsOf: "room-recorder: stopping capture\n".data(using: .utf8)!); try? h.close()
        write(rr + "/status.json", "{\"state\":\"ready\",\"session_id\":null,\"pending_piece_count\":0}")
        let again = rc.poll()
        checkEq(again.events.filter { $0.kind == "recorder.log" }.count, 1)
        let st = again.events.filter { $0.kind == "recorder.status" }
        checkEq(st.count, 1)
        checkEq(st[0].payload["session_open"] as? String, "no")
    }
}
