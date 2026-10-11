import Foundation
@testable import KioskHealthCore

// Round-2 fix tests (Refuter findings F13, F14, F7 revisited, F16, F17, F18; F19 is in Tests/install_test.sh).

private func r2Root() -> String {
    var f = #filePath
    if !f.hasPrefix("/") { f = FileManager.default.currentDirectoryPath + "/" + f }
    return ((f as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent
}

private func mkEmitter(_ sink: EventSink) -> Emitter {
    var cfg = Config(machine: "m1")
    cfg.installID = "i"
    return Emitter(config: cfg, bootID: "B", clock: FakeClock(Date(timeIntervalSince1970: 1_790_000_000)), sink: sink)
}

private func pad(_ n: Int) -> Payload { ["pad": String(repeating: "p", count: n)] }

func runR2Tests() {
    // MARK: F13 display: live ioreg is the current state; pmset lines are history

    test("F13 display: last pmset line is 20 h old and says off, ioreg says on => current = on (ioreg); the old line is a dated transition only") {
        let stamp = ist("2026-10-04", "14:00:00")
        let old = PmsetLog.parse("2026-10-04 14:00:00 +0530 Notification        \tDisplay is turned off                \t          \n")
        checkEq(old.count, 1)
        let r = FakeRunner()
        let io = IoregScript(); io.display = [Fixtures.read("ioreg_display_mini.txt")]; io.install(on: r)
        let (ctx, _, _) = makeCtx(runner: r, now: ist("2026-10-05", "10:00:00"))
        let dc = DisplayCollector(ctx: ctx)
        checkEq(dc.current(), DisplayReading(state: "on", source: "ioreg"))
        let res = dc.poll(entries: old)
        let transition = res.events.first { ($0.payload["origin"] as? String) == "pmset_log" }
        checkEq(transition?.payload["state"] as? String, "off")
        checkEq(transition?.ts, stamp, "stamped with the log line's own time, not 'now'")
        let sampled = res.events.first { ($0.payload["sampled"] as? Bool) == true }
        checkEq(sampled?.payload["state"] as? String, "on", "the current state comes from ioreg")
        check(!r.called("pmset"), "no pmset in the current-state path")
    }

    // MARK: F14 spool policy by post mode

    test("F14 posting: droppable goes first at the cap, protected is kept until the 200 MB-style ceiling, then oldest protected goes with spool.dropped") {
        let spool = try! Spool(dir: tmpDir("r2post"), capBytes: 4_000, protectedCeilingBytes: 16_000, segmentBytes: 800)
        let em = mkEmitter(spool)
        for _ in 0..<25 { em.emit(DraftEvent("power.wake", pad(300))) }
        for _ in 0..<20 { em.emit(DraftEvent("heartbeat", pad(300))) }
        em.flush(); em.flush()   // the second flush would carry a spool.dropped event, if one were queued
        var recs = spool.readBatch(max: 10_000)
        checkEq(recs.filter { $0.kind == "power.wake" }.count, 25, "every protected event survives although the total is over the cap")
        checkEq(recs.filter { $0.kind == "heartbeat" }.count, 0, "droppable was deleted to make room")
        check(spool.totalBytes > 4_000 && spool.totalBytes <= 16_000, "between cap and ceiling: \(spool.totalBytes)")
        check(!recs.contains { $0.kind == "spool.dropped" }, "no spool.dropped while only droppable data went")
        checkEq(spool.droppedByKind["power.wake", default: 0], 0)
        for _ in 0..<30 { em.emit(DraftEvent("power.wake", pad(300))) }
        em.flush(); em.flush()
        recs = spool.readBatch(max: 10_000)
        check(spool.totalBytes <= 16_000 + 800, "ceiling enforced: \(spool.totalBytes)")
        check(spool.droppedByKind["power.wake", default: 0] > 0, "past the ceiling the oldest protected segment is deleted")
        check(recs.contains { $0.seq == 75 }, "the newest event is kept")
        check(!recs.contains { $0.seq == 1 }, "the oldest is gone")
        let dropped = recs.filter { $0.kind == "spool.dropped" }
        check(!dropped.isEmpty, "the drop was reported")
        let last = J.dict(dropped.last!.line)?["payload"] as? Payload
        checkEq(last?["protected_dropped"] as? Bool, true)
        check(((last?["counts"] as? Payload)?["power.wake"] as? Int ?? 0) > 0)
    }

    // MARK: F18 legacy spool layout

    test("F18 spool: an old-layout seg-NNNNNNNNNN.jsonl is migrated into class segments on start and removed") {
        let dir = tmpDir("r2legacy")
        let src = MemorySink()
        let em = mkEmitter(src)
        for k in ["power.wake", "heartbeat", "audio.devices", "display.state", "drift", "power.sleep"] { em.emit(DraftEvent(k, ["x": 1])) }
        em.flush()
        let legacyLines = src.snapshot + ["not json at all"]
        let legacy = dir.appendingPathComponent("seg-0000000001.jsonl")
        FileManager.default.createFile(atPath: legacy.path, contents: (legacyLines.joined(separator: "\n") + "\n").data(using: .utf8))
        let spool = try! Spool(dir: dir, capBytes: 1 << 20, segmentBytes: 1 << 20)
        check(!FileManager.default.fileExists(atPath: legacy.path), "legacy file removed after migration")
        let names = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).filter { $0.hasPrefix("seg-") }
        check(names.contains { $0.hasPrefix("seg-p-") } && names.contains { $0.hasPrefix("seg-d-") }, "\(names)")
        check(!names.contains { Int($0.dropFirst(4).dropLast(6)) != nil }, "no bare-numbered segment is left: \(names)")
        let read = { (prefix: String) -> [String] in
            names.filter { $0.hasPrefix(prefix) }.sorted().flatMap { n in
                String(decoding: FileManager.default.contents(atPath: dir.appendingPathComponent(n).path) ?? Data(), as: UTF8.self)
                    .split(separator: "\n").map(String.init)
            }
        }
        let kindsIn = { (lines: [String]) -> [String] in lines.compactMap { J.dict($0)?["kind"] as? String } }
        checkEq(Set(kindsIn(read("seg-p-"))), Set(["power.wake", "audio.devices", "power.sleep"]), "protected kinds")
        checkEq(Set(kindsIn(read("seg-d-"))), Set(["heartbeat", "display.state", "drift"]), "droppable kinds")
        check(read("seg-p-").contains("not json at all"), "an unparsable line is kept as protected, not lost")
        checkEq(spool.depth, 7)
        checkEq(spool.readBatch(max: 100).count, 6, "six parseable records")
        // droppable lines now live in droppable segments: a squeeze removes them and keeps the protected ones
        let squeezed = try! Spool(dir: dir, capBytes: 1, protectedCeilingBytes: 1 << 20, segmentBytes: 1 << 20)
        try! squeezed.append(entries: [SinkEntry(kind: "heartbeat", line: "{\"kind\":\"heartbeat\"}")])
        check(squeezed.readBatch(max: 100).filter { $0.kind == "power.wake" }.count == 1, "protected record survived the squeeze")
        check(squeezed.readBatch(max: 100).filter { $0.kind == "heartbeat" }.isEmpty, "droppable records were deleted instead")
    }

    // MARK: F16 stderr file

    // MARK: F17 watchdog without a console user

    // MARK: F7 audio presence: ioreg only, profile rarely

}
