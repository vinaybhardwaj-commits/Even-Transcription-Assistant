import Foundation
@testable import KioskHealthCore

// Round-9: recorder.log ships only lines written after the collector first sees a file (tail -n 0 on first start), the read
// position (inode + offset) survives a daemon restart, rotation and truncation restart at 0. Event kind and payload unchanged.

private func w9(_ path: String, _ text: String) {
    try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try? text.write(toFile: path, atomically: false, encoding: .utf8)
}
private func ap9(_ path: String, _ text: String) {
    let h = FileHandle(forWritingAtPath: path)!
    _ = try? h.seekToEnd(); try? h.write(contentsOf: text.data(using: .utf8)!); try? h.close()
}

private struct R9Rig {
    let home: String
    let rr: String
    let stateURL: URL
    var launchd: String { rr + "/launchd.log" }
}

private func r9Rig(launchd initial: String? = nil) -> R9Rig {
    let home = tmpDir("r9home").path
    let rr = home + "/Library/Application Support/EvenScribe/RoomRecorder"
    try? FileManager.default.createDirectory(atPath: rr, withIntermediateDirectories: true)
    if let t = initial { w9(rr + "/launchd.log", t) }
    return R9Rig(home: home, rr: rr, stateURL: tmpDir("r9state").appendingPathComponent("state.json"))
}

/// A collector with its own FileState loaded from disk, like a freshly started daemon.
private func daemonStart(_ rig: R9Rig, clock: FakeClock? = nil) -> (RecorderLogCollector, FakeClock) {
    let c = clock ?? FakeClock(Date(timeIntervalSince1970: 1_790_000_000))
    var cfg = Config(machine: "m"); cfg.consoleUser = "kiosk"
    let ctx = Context(config: cfg, runner: FakeRunner(), clock: c, sleeper: RecordingSleeper(),
                      state: FileState(url: rig.stateURL), homeOverride: rig.home)
    return (RecorderLogCollector(ctx: ctx), c)
}

private func logs(_ r: CollectorResult) -> [DraftEvent] { r.events.filter { $0.kind == "recorder.log" } }
private func lineOf(_ e: DraftEvent) -> String { (e.payload["line"] as? String) ?? "" }

func runR9Tests() {
    let oldSig = "room-recorder: error: signature_mismatch for chunk 7\nroom-recorder: tape writer exited unexpectedly\n"

    test("R9 first start: historical lines already in launchd.log and tapewriter.log are NOT shipped") {
        let rig = r9Rig(launchd: oldSig)
        w9(rig.rr + "/captures/bs_a/seg_b/tapewriter.log", "no durable growth for 12s\nphysical_fallback_required\n")
        let (rc, clock) = daemonStart(rig)
        checkEq(logs(rc.poll()).count, 0, "nothing old on the first poll")
        clock.advance(10)
        checkEq(logs(rc.poll()).count, 0, "nor on the second")
    }

    test("R9 append: lines written after first sight ship exactly once, in order, with the unchanged payload shape") {
        let rig = r9Rig(launchd: oldSig)
        let (rc, clock) = daemonStart(rig)
        _ = rc.poll()
        clock.advance(10)
        ap9(rig.launchd, "room-recorder: info line that does not match\nroom-recorder: stream stopped\nroom-recorder: Error: write failed\n")
        let a = logs(rc.poll())
        checkEq(a.map(lineOf), ["room-recorder: stream stopped", "room-recorder: Error: write failed"])
        for e in a {
            checkEq(e.kind, "recorder.log")
            checkEq(Set(e.payload.keys), ["file", "line", "count", "recv_ts", "redaction"], "payload keys exactly as before R9")
            checkEq(e.payload["file"] as? String, "launchd.log")
            checkEq(e.payload["count"] as? Int, 1)
            checkEq(e.payload["redaction"] as? String, "keyword_only")
            check(e.payload["recv_ts"] is String)
        }
        clock.advance(10)
        checkEq(logs(rc.poll()).count, 0, "shipped once, not again")
        clock.advance(10)
        ap9(rig.launchd, "room-recorder: fallback to builtin mic\n")
        checkEq(logs(rc.poll()).map(lineOf), ["room-recorder: fallback to builtin mic"])
    }

    test("R9 restart: a new daemon process ships nothing old; the position survives on disk as [inode, offset]") {
        let rig = r9Rig(launchd: oldSig)
        let (rc1, c1) = daemonStart(rig)
        _ = rc1.poll()
        c1.advance(10)
        ap9(rig.launchd, "room-recorder: stream stopped\n")
        checkEq(logs(rc1.poll()).count, 1)
        // the saved position is in state.json under recorder.tails
        let saved = (J.parse(data: FileManager.default.contents(atPath: rig.stateURL.path) ?? Data()) as? [String: Any])?["recorder.tails"] as? [String: [NSNumber]]
        let pos = saved?[rig.launchd]
        checkEq(pos?.count, 2)
        checkEq(pos?[1].intValue, FS.size(rig.launchd), "offset is the end of the file as read")
        // restart: brand-new collector and a FileState re-read from disk
        let (rc2, c2) = daemonStart(rig, clock: FakeClock(Date(timeIntervalSince1970: 1_790_100_000)))
        checkEq(logs(rc2.poll()).count, 0, "restart re-ships nothing, old or already shipped")
        c2.advance(10)
        checkEq(logs(rc2.poll()).count, 0)
        // a line written while the daemon was down (after the saved offset) ships once after the restart, not twice
        ap9(rig.launchd, "room-recorder: Error: written while down\n")
        let (rc3, c3) = daemonStart(rig)
        checkEq(logs(rc3.poll()).map(lineOf), ["room-recorder: Error: written while down"])
        c3.advance(10)
        checkEq(logs(rc3.poll()).count, 0)
        let (rc4, _) = daemonStart(rig)
        checkEq(logs(rc4.poll()).count, 0, "and not again after another restart")
    }

    test("R9 rotation: a new inode is read from byte 0; the rotated-away file is not followed") {
        let rig = r9Rig(launchd: oldSig)
        let (rc, clock) = daemonStart(rig)
        _ = rc.poll()
        clock.advance(10)
        ap9(rig.launchd, "room-recorder: stream stopped\n")
        checkEq(logs(rc.poll()).count, 1)
        // rotate: rename the file away, start a fresh launchd.log
        try? FileManager.default.moveItem(atPath: rig.launchd, toPath: rig.launchd + ".1")
        w9(rig.launchd, "room-recorder: Error: first line of the new file\nroom-recorder: tape writer exited\n")
        clock.advance(10)
        checkEq(logs(rc.poll()).map(lineOf), ["room-recorder: Error: first line of the new file", "room-recorder: tape writer exited"])
        // the rotated file keeps receiving a line after the saved offset: documented limit, it is not read
        ap9(rig.launchd + ".1", "room-recorder: Error: late line in the rotated-away file\n")
        clock.advance(10)
        checkEq(logs(rc.poll()).count, 0, "rotated-away file is not followed (lines after the saved offset are lost)")
        // rotation survives a restart too
        let (rcB, _) = daemonStart(rig)
        checkEq(logs(rcB.poll()).count, 0)
    }

    test("R9 truncation: a file smaller than the saved offset is read from byte 0") {
        let rig = r9Rig(launchd: oldSig + String(repeating: "room-recorder: filler line\n", count: 20))
        let (rc, clock) = daemonStart(rig)
        _ = rc.poll()
        clock.advance(10)
        // truncate in place (same inode) and write something shorter than the saved offset
        let h = FileHandle(forWritingAtPath: rig.launchd)!
        try? h.truncate(atOffset: 0); try? h.close()
        ap9(rig.launchd, "room-recorder: Error: after truncation\n")
        checkEq(logs(rc.poll()).map(lineOf), ["room-recorder: Error: after truncation"])
        clock.advance(10)
        checkEq(logs(rc.poll()).count, 0)
    }

    test("R9 files that appear later: a brand-new capture log is read from its start, an old one that merely came into view is not") {
        let rig = r9Rig(launchd: oldSig)
        let (rc, clock) = daemonStart(rig)
        _ = rc.poll()
        clock.advance(10)
        // a new session starts after the collector did: its first lines must not be lost
        w9(rig.rr + "/captures/bs_new/seg_1/tapewriter.log", "no durable growth for 5s\nphysical_fallback_required\n")
        let n = logs(rc.poll())
        checkEq(n.map(lineOf), ["no durable growth for 5s", "physical_fallback_required"])
        checkEq(n.first?.payload["file"] as? String, "captures/bs_new/seg_1/tapewriter.log")
        // an old session directory whose log was created long before the collector started and only now enters view
        let oldLog = rig.rr + "/captures/bs_old/seg_1/tapewriter.log"
        w9(oldLog, "ancient error line\n")
        try? FileManager.default.setAttributes([.creationDate: Date(timeIntervalSince1970: 1_600_000_000)], ofItemAtPath: oldLog)
        clock.advance(10)
        checkEq(logs(rc.poll()).count, 0, "history of a file that was not new is never shipped")
        clock.advance(10)
        ap9(oldLog, "stream stopped again\n")
        checkEq(logs(rc.poll()).map(lineOf), ["stream stopped again"], "but what it writes from now on is")
    }

    test("R9 an absent recorder dir or a vanished file is harmless, and tails of deleted files are forgotten") {
        let rig = r9Rig(launchd: oldSig)
        let (rc, clock) = daemonStart(rig)
        _ = rc.poll()
        try? FileManager.default.removeItem(atPath: rig.launchd)
        clock.advance(10)
        checkEq(logs(rc.poll()).count, 0)
        let saved = (J.parse(data: FileManager.default.contents(atPath: rig.stateURL.path) ?? Data()) as? [String: Any])?["recorder.tails"] as? [String: Any]
        check(saved?[rig.launchd] == nil, "state does not keep a dead path")
        // the file comes back: it is a new file created after the collector started, so it is read from its start
        w9(rig.launchd, "room-recorder: Error: recreated\n")
        clock.advance(10)
        checkEq(logs(rc.poll()).map(lineOf), ["room-recorder: Error: recreated"])
    }
}
