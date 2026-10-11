import Foundation
@testable import KioskHealthCore

// Round-1 fix tests (Refuter findings F1-F12). Every gate here is tested at the level where it acts: remove the
// gate and the corresponding test fails.

private func write(_ path: String, _ text: String) {
    try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: path, contents: text.data(using: .utf8))
}

/// A console user's home with a recorder folder. status nil = no status.json; tapeAge nil = no tape file.
private func r1Home(status: String?, tapeAge: TimeInterval? = nil, now: Date, mkdir: Bool = true) -> String {
    let home = tmpDir("r1").path
    let rr = home + "/Library/Application Support/EvenScribe/RoomRecorder"
    if mkdir { try? FileManager.default.createDirectory(atPath: rr, withIntermediateDirectories: true) }
    if let s = status { write(rr + "/status.json", s) }
    if let age = tapeAge {
        let t = rr + "/captures/bs_1/seg_1/tape.pcm"
        write(t, "x")
        let m = now.addingTimeInterval(-age)
        try? FileManager.default.setAttributes([.modificationDate: m], ofItemAtPath: t)
        try? FileManager.default.setAttributes([.modificationDate: m], ofItemAtPath: rr + "/captures/bs_1")
    }
    return home
}

private let emptyAudio = "{\"SPAudioDataType\":[{\"_items\":[]}]}"

private func rungNames(_ evs: [DraftEvent]) -> [String] {
    evs.map { "\($0.payload["rung"] as? String ?? "?"):\($0.payload["outcome"] as? String ?? $0.payload["reason"] as? String ?? "")" }
}

private func sinkEntry(_ kind: String, pad: Int) -> SinkEntry {
    SinkEntry(kind: kind, line: "{\"kind\":\"\(kind)\",\"pad\":\"\(String(repeating: "p", count: pad))\"}")
}

private func sourcesDir() -> String {
    // #filePath is relative to the build cwd (the repo root) when swiftc is given relative paths.
    var f = #filePath
    if !f.hasPrefix("/") { f = FileManager.default.currentDirectoryPath + "/" + f }
    return ((f as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent + "/Sources/KioskHealthCore"
}

func runR1Tests() {
    // MARK: F2 spool cap

    test("F2 spool: protected-only overflow deletes whole OLDEST protected segments, never the newest, one report per episode") {
        let dir = tmpDir("r1spool")
        let spool = try! Spool(dir: dir, capBytes: 6_000, segmentBytes: 1_000)
        for _ in 0..<30 { try! spool.append(entries: [sinkEntry("power.wake", pad: 300)]) }   // ~330 B each, ~10 KB
        check(spool.totalBytes <= 6_000 + 1_000, "cap holds to within one segment: \(spool.totalBytes)")
        check(spool.droppedByKind["power.wake", default: 0] > 0, "oldest protected segments were deleted")
        let kept = spool.depth
        checkEq(kept + spool.droppedByKind["power.wake", default: 0], 30, "every event is either kept or counted as dropped")
        let rep = spool.takeDropReport()
        check(rep != nil && rep!.protectedDropped && rep!.segments >= 1, "a drop report is queued")
        checkEq(rep!.counts["power.wake"], spool.droppedByKind["power.wake"], "report carries the per-kind counts")
        check(spool.takeDropReport() == nil, "taken once")
        // the newest segment survives even when it alone is over the cap
        let tiny = try! Spool(dir: tmpDir("r1tiny"), capBytes: 100, segmentBytes: 1_000_000)
        try! tiny.append(entries: [sinkEntry("power.wake", pad: 500)])
        checkEq(tiny.depth, 1, "the only protected segment is never deleted")
    }

    test("F2 spool: Emitter turns the drop report into ONE spool.dropped event that lands in the spool") {
        let dir = tmpDir("r1em")
        let spool = try! Spool(dir: dir, capBytes: 6_000, segmentBytes: 1_000)
        var cfg = Config(machine: "m1"); cfg.installID = "i"
        let em = Emitter(config: cfg, bootID: "B1", clock: FakeClock(Date(timeIntervalSince1970: 1_790_000_000)), sink: spool)
        for _ in 0..<40 { em.emit(DraftEvent("power.wake", ["pad": String(repeating: "q", count: 300)])) }
        em.flush(); em.flush()
        let recs = spool.readBatch(max: 10_000)
        let dropped = recs.filter { $0.kind == "spool.dropped" }
        check(!dropped.isEmpty, "spool.dropped reached the spool")
        let last = J.dict(dropped.last!.line)!["payload"] as? Payload
        checkEq(last?["protected_dropped"] as? Bool, true)
        check(((last?["counts"] as? Payload)?["power.wake"] as? Int ?? 0) > 0, "counts name the dropped kind")
        check(recs.contains { $0.kind == "power.wake" && $0.seq == 40 }, "newest protected event kept")
    }

    test("F2 spool: segment families, droppable deleted first, whole files only") {
        let dir = tmpDir("r1fam")
        let spool = try! Spool(dir: dir, capBytes: 5_000, segmentBytes: 800)
        for i in 0..<12 {
            try! spool.append(entries: [sinkEntry(i % 4 == 0 ? "power.sleep" : "heartbeat", pad: 250)])
        }
        for k in ["hid.activity", "assert.snapshot", "display.state", "drift", "recorder.log"] { try! spool.append(entries: [sinkEntry(k, pad: 250)]) }
        let names = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).filter { $0.hasPrefix("seg-") }
        check(names.contains { $0.hasPrefix("seg-p-") } && names.contains { $0.hasPrefix("seg-d-") }, "\(names)")
        check(spool.totalBytes <= 5_000, "droppable deletion alone satisfied the cap: \(spool.totalBytes)")
        checkEq(spool.droppedByKind["power.sleep", default: 0], 0, "protected untouched while droppable remained")
        check(spool.takeDropReport() == nil, "no drop report for droppable-only deletions")
        for name in names {
            let data = FileManager.default.contents(atPath: dir.appendingPathComponent(name).path) ?? Data()
            check(data.last == 0x0A, "\(name) ends on a whole line (segments are deleted whole, never rewritten)")
        }
    }

    test("F12/F2 spool: 1000 appends at the cap cost < 1 s (no re-parsing), for droppable and protected pressure") {
        let cap = 2 * 1024 * 1024
        let spool = try! Spool(dir: tmpDir("r1cost"), capBytes: cap, segmentBytes: 256 * 1024)
        let big = sinkEntry("power.wake", pad: 2_000)
        while spool.totalBytes < cap - 64 * 1024 { try! spool.append(entries: [big, big, big, big]) }
        check(spool.totalBytes >= cap - 128 * 1024 && spool.totalBytes <= cap, "filled to the cap: \(spool.totalBytes)")
        let t0 = Date()
        for _ in 0..<1000 { try! spool.append(entries: [sinkEntry("heartbeat", pad: 300)]) }
        let droppableCost = Date().timeIntervalSince(t0)
        let t1 = Date()
        for _ in 0..<1000 { try! spool.append(entries: [big]) }
        let protectedCost = Date().timeIntervalSince(t1)
        print("  [timing] 1000 appends at cap: droppable \(String(format: "%.3f", droppableCost)) s, protected-over-cap \(String(format: "%.3f", protectedCost)) s")
        check(droppableCost < 1.0, "droppable appends at cap took \(droppableCost) s")
        check(protectedCost < 1.0, "protected-over-cap appends took \(protectedCost) s")
        check(spool.totalBytes <= cap + 256 * 1024)
    }

    test("F2 spool: default cap is 50 MB posting, 20 MB in dry-run; depth stays exact through append, ack and drops") {
        checkEq(Spool.defaultCap(post: true), 50 * 1024 * 1024)
        checkEq(Spool.defaultCap(post: false), 20 * 1024 * 1024)
        let dir = tmpDir("r1depth")
        let spool = try! Spool(dir: dir, capBytes: 3_000, segmentBytes: 700)
        var cfg = Config(machine: "m1")
        cfg.installID = "i"
        let em = Emitter(config: cfg, bootID: "B", clock: FakeClock(Date(timeIntervalSince1970: 1_790_000_000)), sink: spool)
        checkEq(spool.depth, 0)
        for i in 0..<30 { em.emit(DraftEvent(i % 2 == 0 ? "heartbeat" : "power.wake", ["pad": String(repeating: "z", count: 120)])) }
        em.flush()
        checkEq(spool.depth, spool.readBatch(max: 100_000).count, "cached depth equals the real record count after drops")
        let some = spool.readBatch(max: 3)
        spool.ack(records: some)
        checkEq(spool.depth, spool.readBatch(max: 100_000).count, "and after an ack")
        spool.resync()
        checkEq(spool.depth, spool.readBatch(max: 100_000).count, "and after a resync")
    }

    // MARK: F3 flush race

    test("F3 emitter: 1000 concurrent emits (8 threads, concurrent flushes) -> exactly 1000 unique seqs, none lost, none duplicated") {
        let sink = MemorySink()
        let em = Emitter(config: Config(machine: "m"), bootID: "B", clock: SystemClock(), sink: sink)
        DispatchQueue.concurrentPerform(iterations: 8) { t in
            for i in 0..<125 {
                em.emit(DraftEvent(i % 7 == 0 ? "power.wake" : "heartbeat", ["t": t, "i": i]))
                if i % 3 == 0 { em.flush() }
            }
        }
        em.flush()
        let seqs = sink.snapshot.compactMap { (J.dict($0)?["seq"] as? NSNumber)?.int64Value }
        checkEq(seqs.count, 1000, "line count (duplicates would push this above 1000, loss below)")
        checkEq(Set(seqs).count, 1000, "unique seqs")
        checkEq(Set(seqs), Set((1...1000).map { Int64($0) }), "seq 1...1000 all present")
    }

    test("F3 emitter: a failed append is retried without loss or duplication") {
        final class Flaky: EventSink {
            var failNext = true
            var lines: [String] = []
            func append(entries: [SinkEntry]) throws {
                if failNext { failNext = false; throw NSError(domain: "x", code: 1) }
                lines += entries.map { $0.line }
            }
        }
        let sink = Flaky()
        let em = Emitter(config: Config(machine: "m"), bootID: "B", clock: SystemClock(), sink: sink)
        for _ in 0..<5 { em.emit(DraftEvent("heartbeat")) }
        em.flush()
        em.emit(DraftEvent("heartbeat"))
        em.flush()
        let seqs = sink.lines.compactMap { (J.dict($0)?["seq"] as? NSNumber)?.int64Value }
        checkEq(seqs, [1, 2, 3, 4, 5, 6], "retried in order, exactly once")
    }

    test("F3 emitter: flushes are serialised - a slow flush cannot be overtaken (order on disk, seq high-water never regresses)") {
        final class Slow: EventSink {
            let m = NSLock()
            var batches: [[Int64]] = []
            var first = true
            func append(entries: [SinkEntry]) throws {
                m.lock(); let slow = first; first = false; m.unlock()
                if slow { Thread.sleep(forTimeInterval: 0.15) }
                let seqs = entries.compactMap { (J.dict($0.line)?["seq"] as? NSNumber)?.int64Value }
                m.lock(); batches.append(seqs); m.unlock()
            }
        }
        let dir = tmpDir("r1seq")
        let store = SeqStore(dir: dir)
        let sink = Slow()
        let em = Emitter(config: Config(machine: "m"), bootID: "B", clock: SystemClock(), sink: sink, seqStore: store)
        let g = DispatchGroup()
        for _ in 0..<5 { em.emit(DraftEvent("heartbeat")) }
        g.enter(); DispatchQueue.global().async { em.flush(); g.leave() }          // takes seq 1...5, sleeps in the sink
        Thread.sleep(forTimeInterval: 0.03)
        for _ in 0..<5 { em.emit(DraftEvent("heartbeat")) }
        g.enter(); DispatchQueue.global().async { em.flush(); g.leave() }          // takes seq 6...10
        g.wait()
        checkEq(sink.batches, [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]], "second flush waited for the first")
        checkEq(store.load(bootID: "B"), 10, "persisted high-water is the newest, not the slowest writer's")
    }

    // MARK: F4 session gate fails closed

    // MARK: F6 fixed window

    // MARK: F7 no TCC-triggering APIs

    // MARK: F8 ladder rate limits

    // MARK: F9 privacy

    test("F9: possessives are stripped from every device, HID, assertion, kernel-owner and USB name that ships") {
        checkEq(AudioNames.sanitize("Dr Rao's Keyboard"), "Keyboard")
        checkEq(AudioNames.sanitize("Alex\u{2019}s iPhone Microphone"), "iPhone Microphone")
        checkEq(AudioNames.sanitize("Mac mini Speakers"), "Mac mini Speakers")
        // assertion holder name (powerd is allowlisted), UserIsActive product, kernel owner
        var s = AssertionsSnapshot()
        s.holders.append(AssertionHolder(pid: 1, process: "powerd", id: "0x1", heldSeconds: 5, type: "UserIsActive",
                                         name: "com.apple.iohideventsystem.queue.tickle serviceID:1 product:Dr Rao's Keyboard eventType:3"))
        s.holders.append(AssertionHolder(pid: 2, process: "coreaudiod", id: "0x2", heldSeconds: 5, type: "PreventUserIdleSystemSleep",
                                         name: "Created for Priya's USB Microphone"))
        s.kernel.append(KernelAssertion(owner: "Sam's Webcam", kind: "x"))
        let text = J.string(s.payload())
        for leak in ["Rao", "Priya", "Sam's", "Sam\u{2019}s"] { check(!text.contains(leak), "\(leak) leaked: \(text)") }
        check(text.contains("Keyboard") && text.contains("USB Microphone") && text.contains("Webcam"))
        // USB tree
        let usb = Fixtures.read("ioreg_usb_mic_synthetic.txt").replacingOccurrences(of: "\"USB Product Name\" = \"USB PnP Sound Device\"", with: "\"USB Product Name\" = \"Dr Rao's USB PnP Sound Device\"")
        let devs = IoregUSB.parse(usb)
        check(devs.contains { $0.name == "USB PnP Sound Device" } && !devs.contains { $0.name.contains("Rao") })
        // audio device names
        let r = FakeRunner()
        let io = IoregScript(); io.usb = [usb]; io.install(on: r)
        r.on("/usr/sbin/system_profiler SPAudioDataType -json", stdout: spAudio(input: true, inputName: "Dr Rao's USB Mic"))
        let (ctx, _, _) = makeCtx(runner: r)
        let ac = AudioCollector(ctx: ctx)
        let ev = ac.presencePoll().events + ac.profilePoll(trigger: "start").events
        check(ev.count == 2 && !ev.contains { J.string($0.payload).contains("Rao") }, ev.map { J.string($0.payload) }.joined())
        // HID collector
        let hr = FakeRunner()
        let idleNs: (Double) -> String = { "    \"HIDIdleTime\" = \(Int($0 * 1_000_000_000))" }
        hr.sequence("/usr/sbin/ioreg -c IOHIDSystem", [ok(idleNs(400)), ok(idleNs(2))])
        hr.on("/usr/bin/pmset -g assertions", stdout:
              "Listed by owning process:\n   pid 1(powerd): [0x1] 00:00:05 UserIsActive named: \"com.apple.iohideventsystem.queue.tickle serviceID:1 product:Dr Rao's Keyboard eventType:3\"\n")
        let (hctx, _, _) = makeCtx(runner: hr)
        let hc = HIDCollector(ctx: hctx, assertions: AssertionsCollector(ctx: hctx))
        var mono: TimeInterval = 0
        hc.monotonic = { mono }
        _ = hc.poll()
        mono = 500
        let hev = hc.poll().events
        checkEq(hev.count, 1)
        checkEq(hev.first?.payload["device"] as? String, "Keyboard")
        checkEq(hev.first?.payload["device_class"] as? String, "keyboard")
    }

    test("F9: recorder.log ships keyword lines only, <= 300 chars, names scrubbed, redaction stated; repeats collapse into one counted event") {
        let home = tmpDir("r1rlog").path
        let rr = home + "/Library/Application Support/EvenScribe/RoomRecorder"
        let long = "recorder error " + String(repeating: "a", count: 600)
        write(rr + "/launchd.log", "room-recorder: history before the collector started\n")
        let (ctx, clock, _) = makeCtx(home: home)
        let rc = RecorderLogCollector(ctx: ctx)
        checkEq(rc.poll().events.filter { $0.kind == "recorder.log" }.count, 0, "first sight is history")
        clock.advance(10)
        do {
            let h = FileHandle(forWritingAtPath: rr + "/launchd.log")!
            _ = try? h.seekToEnd()
            try? h.write(contentsOf: "room-recorder: authorized for Dr Rao's account\n\(long)\nroom-recorder: tape writer exited unexpectedly for Dr Rao's session\nroom-recorder: chunk 17 written\n".data(using: .utf8)!)
            try? h.close()
        }
        let first = rc.poll().events.filter { $0.kind == "recorder.log" }
        checkEq(first.count, 2, "only the two keyword lines; 'authorized' and 'chunk written' stay on the machine")
        check(first.allSatisfy { ($0.payload["line"] as? String ?? "").count <= 300 }, "truncated to 300")
        check(first.contains { ($0.payload["line"] as? String)?.count == 300 }, "the long line is cut at exactly 300")
        check(first.allSatisfy { $0.payload["redaction"] as? String == "keyword_only" })
        check(!J.string(first.map { $0.payload }).contains("Rao"), "possessive name scrubbed")
        check(first.allSatisfy { $0.payload["count"] as? Int == 1 })
        // the same error line 5 more times within 10 minutes
        func append(_ text: String) {
            let h = FileHandle(forWritingAtPath: rr + "/launchd.log")!
            _ = try? h.seekToEnd(); try? h.write(contentsOf: text.data(using: .utf8)!); try? h.close()
        }
        for i in 0..<5 {
            clock.advance(60)
            append("room-recorder: tape writer exited unexpectedly for Dr Rao's session\n")
            checkEq(rc.poll().events.filter { $0.kind == "recorder.log" }.count, 0, "repeat \(i + 1) folded into a count")
        }
        clock.advance(600)
        let closing = rc.poll().events.filter { $0.kind == "recorder.log" }
        checkEq(closing.count, 1, "one collapsed event when the window closes")
        checkEq(closing.first?.payload["count"] as? Int, 5)
        checkEq(closing.first?.payload["collapsed_repeats"] as? Bool, true)
        checkEq(closing.first?.payload["redaction"] as? String, "keyword_only")
        // after the window a new occurrence ships again
        append("room-recorder: tape writer exited unexpectedly for Dr Rao's session\n")
        clock.advance(10)
        checkEq(rc.poll().events.filter { $0.kind == "recorder.log" }.count, 1)
    }

    // MARK: F10 polling

    test("F10 drift: events only on change (new/changed/resolved), one drift.summary per IST day from 09:00") {
        let r = FakeRunner()
        let custom = Fixtures.read("pmset_custom.txt")
        r.sequence("/usr/bin/pmset -g custom", [ok(custom), ok(custom), ok(custom.replacingOccurrences(of: "displaysleep         0", with: "displaysleep         30")),
                                                ok(custom.replacingOccurrences(of: "displaysleep         0", with: "displaysleep         30")), ok(custom)])
        r.on("/usr/bin/pmset -g", stdout: Fixtures.read("pmset_g_live.txt"))
        r.on("/usr/bin/defaults read", stdout: "kiosk\n")
        r.on("/usr/bin/pgrep -x caffeinate", stdout: "668\n")
        var cfg = Config(machine: "m"); cfg.consoleUser = "kiosk"; cfg.baseline["chrome_forcelist"] = "skip"
        let (ctx, clock, _) = makeCtx(runner: r, config: cfg, now: ist("2026-10-05", "07:00:00"), home: tmpDir("r1drift").path)
        let dc = DriftCollector(ctx: ctx)
        let first = dc.poll().events.filter { $0.kind == "drift" }
        check(first.count >= 1, "first check reports what is drifting")
        check(first.allSatisfy { $0.payload["change"] as? String == "initial" })
        clock.advance(15 * 60)
        checkEq(dc.poll().events.filter { $0.kind == "drift" }.count, 0, "unchanged: silent (was: every drifted field every 15 min)")
        clock.advance(15 * 60)
        let changed = dc.poll().events.filter { $0.kind == "drift" }
        checkEq(changed.count, 1)
        checkEq(changed.first?.payload["field"] as? String, "pmset.displaysleep")
        checkEq(changed.first?.payload["change"] as? String, "new")
        clock.advance(15 * 60)
        checkEq(dc.poll().events.filter { $0.kind == "drift" }.count, 0, "still drifting, no news")
        clock.advance(15 * 60)
        let resolved = dc.poll().events.filter { $0.kind == "drift" }
        checkEq(resolved.first?.payload["change"] as? String, "resolved")
        // summary: not before 09:00 IST, once per IST date
        var summaries = 0
        func tick(_ d: String, _ t: String) -> Int {
            clock.t = ist(d, t)
            return dc.poll().events.filter { $0.kind == "drift.summary" }.count
        }
        summaries += tick("2026-10-05", "08:59:00"); checkEq(summaries, 0, "08:59 IST: too early")
        summaries += tick("2026-10-05", "09:00:00"); checkEq(summaries, 1, "09:00 IST: the day's summary")
        summaries += tick("2026-10-05", "09:15:00"); summaries += tick("2026-10-05", "17:00:00")
        checkEq(summaries, 1, "only one per day")
        summaries += tick("2026-10-06", "09:05:00"); checkEq(summaries, 2, "next IST day")
        let sev = { () -> DraftEvent? in clock.t = ist("2026-10-07", "09:00:00"); return dc.poll().events.first { $0.kind == "drift.summary" } }()
        check(sev != nil && sev!.payload["date"] as? String == "2026-10-07" && sev!.payload["tz"] as? String == "Asia/Kolkata")
        check(EventKind.isDroppable("drift.summary") && !EventKind.isProtected("drift.summary"))
    }

    // MARK: F11 / spool classes

    test("spool classes: protected kinds and unknown kinds fail safe, droppable list is exactly the spec's") {
        for k in ["power.sleep", "power.wake", "power.darkwake", "audio.error", "audio.devices", "watchdog.action", "ladder.rung", "spool.dropped", "some.future.kind"] {
            checkEq(SpoolClass.of(k), .protected, k)
        }
        for k in ["heartbeat", "drift", "drift.summary", "assert.snapshot", "hid.activity", "display.state", "recorder.log", "recorder.status"] {
            checkEq(SpoolClass.of(k), .droppable, k)
        }
    }
}
