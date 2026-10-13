import Foundation
@testable import KioskHealthCore

// Round-5: omitted ids, F25 (2xx needs the sink's body), F23 (UTF-16 caps), F24 (nesting depth).

func runR5Tests() {
    test("R5 ids: room_id and install_id are omitted when unset or empty, sent when set, never null") {
        let dir = tmpDir("r5ids")
        let spool = try! Spool(dir: dir)
        func line(_ cfg: Config) -> [String: Any] {
            let em = Emitter(config: cfg, bootID: "B", clock: FakeClock(Date(timeIntervalSince1970: 1_790_000_000)), sink: spool, startSeq: 0, seqStore: nil)
            em.emit(DraftEvent("power.x", ["a": 1])); em.flush()
            let r = spool.readBatch(max: 1)
            spool.ack(records: r)
            return J.dict(r[0].line)!
        }
        let none = line(Config(machine: "m"))
        check(none["room_id"] == nil && none["install_id"] == nil)
        check(!J.string(none).contains("null"), "no null anywhere in the envelope")
        var empty = Config(machine: "m"); empty.roomID = ""; empty.installID = ""
        let e = line(empty)
        check(e["room_id"] == nil && e["install_id"] == nil)
        var both = Config(machine: "m"); both.roomID = "room_1"; both.installID = "install_1"
        let b = line(both)
        checkEq(b["room_id"] as? String, "room_1")
        checkEq(b["install_id"] as? String, "install_1")
    }

    test("R5 F25: a 2xx without a parseable body containing accepted keeps every line and backs off like a 503") {
        for (label, body) in [("html", "<html>Please log in to the wifi</html>"), ("empty", ""), ("json without accepted", "{\"ok\":true}"),
                              ("accepted not a number", "{\"accepted\":\"7\"}"), ("array", "[1]")] {
            let dir = tmpDir("r5f25")
            let spool = try! Spool(dir: dir)
            var cfg = Config(machine: "m1"); cfg.post = true
            let em = Emitter(config: cfg, bootID: "B", clock: FakeClock(Date(timeIntervalSince1970: 1_790_000_000)), sink: spool, startSeq: 0, seqStore: nil)
            for _ in 0..<4 { em.emit(DraftEvent("power.x", ["a": 1])) }
            em.flush()
            let poster = FakePoster()
            poster.results = [.ok(status: 200, body: Data(body.utf8)), .ok(status: 204, body: Data()), FakePoster.accepted]
            let clock = FakeClock(Date(timeIntervalSince1970: 1_790_000_000))
            let t = Transport(config: cfg, spool: spool, poster: poster, clock: clock)
            var logs: [String] = []
            t.onLog = { _, m in logs.append(m) }
            checkEq(t.tick(), .failed(retryIn: 10), label)
            checkEq(spool.depth, 4, "\(label): nothing deleted")
            checkEq(t.tick(), .waiting, "\(label): backoff window")
            check(t.lastPostOK == nil, "\(label): not a successful post")
            check(logs.contains { $0.contains("without a sink reply") }, label)
            clock.advance(10)
            checkEq(t.tick(), .failed(retryIn: 20), "\(label): 204 is no better, backoff doubles")
            clock.advance(20)
            checkEq(t.tick(), .sent(count: 4), "\(label): a real sink reply deletes")
            checkEq(spool.depth, 0)
            checkEq(poster.calls.count, 3)
        }
    }

    test("R5 F25: over the real HTTP path, a 200 proxy page keeps the lines and a real reply deletes them") {
        let (spool, t, sink, clock) = r5Rig(events: 3, handler: { i, _ in i == 0 ? (200, "<html>captive portal</html>") : (200, "{\"ok\":true,\"accepted\":3,\"duplicates\":0,\"rejected\":0,\"rejected_reasons\":[]}") })
        defer { sink.stop() }
        if case .failed = t.tick() {} else { check(false, "expected failure") }
        checkEq(spool.depth, 3)
        clock.advance(10)
        checkEq(t.tick(), .sent(count: 3))
        checkEq(spool.depth, 0)
        checkEq(sink.requests.count, 2)
    }

    test("R5 F23: caps count UTF-16 code units; an astral character is 2 units and is never split") {
        let emoji = "😀"   // 1 character, 2 UTF-16 units
        let s = String(repeating: emoji, count: 100)   // 100 characters, 200 units
        let capped = SinkGuard.cap(s, 64)
        checkEq(capped.utf16.count, 64)
        checkEq(capped.count, 32)
        check(capped.unicodeScalars.allSatisfy { $0 == "😀" }, "no broken pair")
        let odd = SinkGuard.cap("a" + String(repeating: emoji, count: 50), 64)
        checkEq(odd.utf16.count, 63, "a pair that would straddle the cap is dropped whole")
        checkEq(SinkGuard.cap("héllo", 64), "héllo")
        checkEq(SinkGuard.cap(String(repeating: "x", count: 70), 64).utf16.count, 64)
        // combining marks: one visible character, several units
        let combining = String(repeating: "e\u{0301}", count: 60)   // 60 characters, 120 units
        checkEq(SinkGuard.cap(combining, 64).utf16.count, 64)
    }

    test("R5 F23: machine, boot_id, room_id and install_id on the wire never exceed their caps in UTF-16 units") {
        let dir = tmpDir("r5f23")
        let spool = try! Spool(dir: dir)
        var cfg = Config(machine: String(repeating: "😀", count: 100))
        cfg.roomID = String(repeating: "é", count: 40) + String(repeating: "😀", count: 40)
        cfg.installID = String(repeating: "😀", count: 100)
        let em = Emitter(config: cfg, bootID: String(repeating: "😀", count: 100), clock: FakeClock(Date(timeIntervalSince1970: 1_790_000_000)),
                         sink: spool, startSeq: 0, seqStore: nil)
        em.emit(DraftEvent("power.x", ["a": 1])); em.flush()
        let d = J.dict(spool.readBatch(max: 1)[0].line)!
        func u(_ k: String) -> Int { (d[k] as? String)?.utf16.count ?? -1 }
        check(u("machine") <= 128 && u("machine") >= 127, "\(u("machine"))")
        check(u("boot_id") <= 64 && u("boot_id") >= 63, "\(u("boot_id"))")
        check(u("room_id") <= 64 && u("room_id") >= 63, "\(u("room_id"))")
        check(u("install_id") <= 64 && u("install_id") >= 63, "\(u("install_id"))")
        check(u("source") <= 32)
    }

    test("R5 F24: payload nesting deeper than 12 is replaced by the _truncated marker; 12 stays") {
        func nest(_ levels: Int) -> Payload {   // a payload whose deepest value sits `levels` objects down
            var inner: Any = "leaf"
            for _ in 1..<levels { inner = ["k": inner] as [String: Any] }
            return ["root": inner]
        }
        checkEq(SinkGuard.depth(["a": 1]), 1)
        checkEq(SinkGuard.depth(nest(1)), 1)
        checkEq(SinkGuard.depth(nest(12)), 12)
        check(SinkGuard.guardPayload(nest(12), kind: "k")["_truncated"] == nil, "depth 12 passes")
        let deep = SinkGuard.guardPayload(nest(13), kind: "audio.error")
        checkEq(deep["_truncated"] as? Bool, true)
        checkEq(deep["kind"] as? String, "audio.error")
        check((deep["orig_bytes"] as? Int ?? 0) > 0)
        // arrays count as a level too
        var arr: Any = "leaf"
        for _ in 0..<13 { arr = [arr] }
        checkEq(SinkGuard.guardPayload(["x": arr], kind: "k")["_truncated"] as? Bool, true)
        check(SinkGuard.guardPayload(["x": [[1, 2], [3]], "y": ["z": ["w": 1]]] as Payload, kind: "k")["_truncated"] == nil, "ordinary payloads are untouched")
    }

    test("R5 F24: the emitter spools the marker for a too-deep payload") {
        let dir = tmpDir("r5f24")
        let spool = try! Spool(dir: dir)
        var inner: Any = 1
        for _ in 0..<30 { inner = ["k": inner] as [String: Any] }
        let em = Emitter(config: Config(machine: "m"), bootID: "B", clock: FakeClock(Date()), sink: spool, startSeq: 0, seqStore: nil)
        em.emit(DraftEvent("watchdog.x", ["deep": inner])); em.flush()
        let d = J.dict(spool.readBatch(max: 1)[0].line)!
        checkEq((d["payload"] as? [String: Any])?["_truncated"] as? Bool, true)
    }
}

private func r5Rig(events: Int, handler: @escaping (Int, FakeSink.Request) -> (Int, String)) -> (Spool, Transport, FakeSink, FakeClock) {
    let dir = tmpDir("r5rig")
    let spool = try! Spool(dir: dir)
    var cfg = Config(machine: "m1")
    cfg.post = true; cfg.token = "tok"
    let em = Emitter(config: cfg, bootID: "B", clock: FakeClock(Date(timeIntervalSince1970: 1_790_000_000)), sink: spool, startSeq: 0, seqStore: nil)
    for _ in 0..<events { em.emit(DraftEvent("power.x", ["a": 1])) }
    em.flush()
    let sink = FakeSink()
    sink.handler = handler
    cfg.sinkURL = sink.url
    let clock = FakeClock(Date(timeIntervalSince1970: 1_790_000_000))
    return (spool, Transport(config: cfg, spool: spool, poster: URLSessionPoster(), clock: clock), sink, clock)
}
