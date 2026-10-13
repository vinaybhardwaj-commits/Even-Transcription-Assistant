import Foundation
@testable import KioskHealthCore

final class FakePoster: HTTPPoster {
    /// A 2xx with the sink's reply body (F25: only such a reply lets the transport delete lines).
    static let accepted = PostResult.ok(status: 200, body: Data("{\"ok\":true,\"accepted\":1,\"duplicates\":0,\"rejected\":0,\"rejected_reasons\":[]}".utf8))
    var results: [PostResult] = []
    private(set) var calls: [(url: URL, token: String?, body: Data)] = []
    func post(url: URL, token: String?, body: Data) -> PostResult {
        calls.append((url, token, body))
        return results.isEmpty ? FakePoster.accepted : results.removeFirst()
    }
}

private func makeSpool(cap: Int = 50 * 1024 * 1024, segment: Int = 1 << 20) -> (Spool, URL) {
    let dir = tmpDir("spool")
    return (try! Spool(dir: dir, capBytes: cap, segmentBytes: segment), dir)
}

private func makeEmitter(_ spool: Spool, dir: URL, boot: String = "BOOT-1", machine: String = "m1", startSeq: Int64 = 0) -> Emitter {
    var cfg = Config(machine: machine)
    cfg.installID = "install_abc"
    return Emitter(config: cfg, bootID: boot, clock: FakeClock(Date(timeIntervalSince1970: 1_790_000_000.123)),
                   sink: spool, startSeq: startSeq, seqStore: SeqStore(dir: dir))
}

func runTransportTests() {
    // MARK: envelope + seq

    test("envelope: required fields, null room/install, ISO ms UTC timestamp, source daemon") {
        let (spool, dir) = makeSpool()
        let em = makeEmitter(spool, dir: dir)
        em.emit(DraftEvent("heartbeat", ["uptime_s": 5]))
        em.flush()
        let rec = spool.readBatch(max: 10)
        checkEq(rec.count, 1)
        let d = J.dict(rec[0].line)!
        checkEq(d["machine"] as? String, "m1")
        check(d["room_id"] == nil, "unset room_id is omitted, never null")
        checkEq(d["install_id"] as? String, "install_abc")
        checkEq(d["boot_id"] as? String, "BOOT-1")
        checkEq((d["seq"] as? NSNumber)?.intValue, 1)
        checkEq(d["source"] as? String, "daemon")
        checkEq(d["kind"] as? String, "heartbeat")
        checkEq(d["ts"] as? String, "2026-09-21T14:13:20.123+00:00")
        checkEq((d["payload"] as? [String: Any])?["uptime_s"] as? Int, 5)
        checkEq(rec[0].key, "m1|BOOT-1|1")
    }

    test("seq: continues across a restart within a boot, resets on a new boot") {
        let (spool, dir) = makeSpool()
        let em = makeEmitter(spool, dir: dir)
        for _ in 0..<3 { em.emit(DraftEvent("heartbeat")) }
        em.flush()
        let store = SeqStore(dir: dir)
        checkEq(store.load(bootID: "BOOT-1"), 3)
        // "restart": a new Emitter seeded like the daemon does
        let start = max(store.load(bootID: "BOOT-1"), spool.maxSeq(bootID: "BOOT-1"))
        let em2 = makeEmitter(spool, dir: dir, startSeq: start)
        checkEq(em2.emit(DraftEvent("heartbeat")), 4)
        em2.flush()
        // new boot id starts over
        let start3 = max(store.load(bootID: "BOOT-2"), spool.maxSeq(bootID: "BOOT-2"))
        checkEq(start3, 0)
        let em3 = makeEmitter(spool, dir: dir, boot: "BOOT-2", startSeq: start3)
        checkEq(em3.emit(DraftEvent("heartbeat")), 1)
    }

    test("seq: a seq file that lags behind the spool (crash) is repaired from the spool") {
        let (spool, dir) = makeSpool()
        let em = makeEmitter(spool, dir: dir)
        for _ in 0..<5 { em.emit(DraftEvent("power.sleep")) }   // protected: flushes each
        try? FileManager.default.removeItem(at: dir.appendingPathComponent("seq.json"))
        let start = max(SeqStore(dir: dir).load(bootID: "BOOT-1"), spool.maxSeq(bootID: "BOOT-1"))
        checkEq(start, 5)
    }

    test("emitter: protected kinds hit the disk immediately, others wait for flush") {
        let (spool, dir) = makeSpool()
        let em = makeEmitter(spool, dir: dir)
        em.emit(DraftEvent("heartbeat"))
        checkEq(spool.depth, 0, "buffered")
        em.emit(DraftEvent("watchdog.action"))
        checkEq(spool.depth, 2, "protected event flushed the whole buffer")
    }

    // MARK: spool replay / ack

    test("spool replay is idempotent: reading twice is identical, ack is idempotent and partial acks hold") {
        let (spool, dir) = makeSpool(segment: 600)
        let em = makeEmitter(spool, dir: dir)
        for i in 0..<12 {
            em.emit(DraftEvent("heartbeat", ["i": i]))
            if i % 3 == 2 { em.flush() }   // several flushes so several segments exist
        }
        em.flush()
        let a = spool.readBatch(max: 100), b = spool.readBatch(max: 100)
        checkEq(a.map { $0.key }, b.map { $0.key })
        checkEq(a.count, 12)
        check(Set(a.map { $0.segment }).count > 1, "multiple segments exercised")
        let firstFive = Set(a.prefix(5).map { $0.key })
        spool.ack(keys: firstFive)
        spool.ack(keys: firstFive)   // replayed ack: no-op
        checkEq(spool.readBatch(max: 100).map { $0.key }, Array(a.dropFirst(5)).map { $0.key })
        spool.ack(keys: Set(a.map { $0.key }))
        checkEq(spool.depth, 0)
        checkEq(spool.readBatch(max: 10).count, 0)
        spool.ack(keys: ["nonexistent|key|1"])
    }

    // MARK: cap policy (more in R1Tests.swift)

    test("spool cap: droppable segments are deleted whole, oldest first; power/audio/watchdog/ladder never touched") {
        let (spool, dir) = makeSpool(cap: 14_000, segment: 1500)
        let em = makeEmitter(spool, dir: dir)
        var protectedSeqs: [Int64] = []
        var heartbeatSeqs: [Int64] = []
        let big = String(repeating: "x", count: 150)
        for i in 0..<60 {
            heartbeatSeqs.append(em.emit(DraftEvent("heartbeat", ["i": i, "pad": big])))
            if i % 6 == 0 { protectedSeqs.append(em.emit(DraftEvent(["power.sleep", "audio.error", "watchdog.action", "ladder.rung"][i / 6 % 4], ["pad": big]))) }
        }
        em.flush()
        let remaining = spool.readBatch(max: 10_000)
        let kinds = remaining.map { $0.kind }
        checkEq(kinds.filter { EventKind.isProtected($0) }.count, protectedSeqs.count, "every protected event survives")
        let hbLeft = remaining.filter { $0.kind == "heartbeat" }.map { $0.seq }
        check(hbLeft.count < heartbeatSeqs.count, "some heartbeats were dropped")
        check(spool.totalBytes <= 14_000, "under the cap: \(spool.totalBytes)")
        if let oldestKept = hbLeft.min() {
            let dropped = heartbeatSeqs.filter { !hbLeft.contains($0) }
            check(dropped.allSatisfy { $0 < oldestKept }, "only the OLDEST heartbeats are gone")
        }
        check(spool.droppedByKind["heartbeat", default: 0] > 0)
        check(spool.droppedByKind["power.sleep", default: 0] == 0 && spool.droppedByKind["audio.error", default: 0] == 0)
        let names = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).filter { $0.hasPrefix("seg-") }
        check(names.contains { $0.hasPrefix("seg-p-") } && names.contains { $0.hasPrefix("seg-d-") }, "two segment families: \(names)")
    }

    // MARK: transport

    func filled(_ n: Int, config: Config) -> (Spool, Transport, FakePoster, FakeClock) {
        let (spool, dir) = makeSpool()
        let em = makeEmitter(spool, dir: dir)
        for i in 0..<n { em.emit(DraftEvent("heartbeat", ["i": i])) }
        em.flush()
        let poster = FakePoster()
        let clock = FakeClock(Date(timeIntervalSince1970: 1_790_000_000))
        return (spool, Transport(config: config, spool: spool, poster: poster, clock: clock), poster, clock)
    }

    test("transport: post:false never calls the poster (dry-run: spool only)") {
        let cfg = Config(machine: "m1")
        check(!cfg.post)
        let (spool, t, poster, _) = filled(5, config: cfg)
        checkEq(t.tick(), .disabled)
        checkEq(poster.calls.count, 0)
        checkEq(spool.depth, 5)
    }

    test("transport: 2xx deletes sent lines; body is {events:[...]} with Bearer token; <=500 per batch") {
        var cfg = Config(machine: "m1"); cfg.post = true; cfg.token = "tok-123"; cfg.sinkURL = "https://example.invalid/api/kiosk-health"
        let (spool, t, poster, clock) = filled(1200, config: cfg)
        checkEq(t.tick(), .sent(count: 500))
        checkEq(poster.calls.count, 1)
        checkEq(poster.calls[0].token, "tok-123")
        checkEq(poster.calls[0].url.absoluteString, "https://example.invalid/api/kiosk-health")
        let body = J.dict(String(decoding: poster.calls[0].body, as: UTF8.self))!
        checkEq((body["events"] as? [Any])?.count, 500)
        checkEq(spool.depth, 700)
        checkEq(t.tick(), .sent(count: 500), "full batch: next one goes immediately")
        checkEq(t.tick(), .sent(count: 200))
        checkEq(spool.depth, 0)
        checkEq(t.tick(), .waiting, "10 s interval after a short batch")
        clock.advance(10)
        checkEq(t.tick(), .idle)
        check(t.lastPostOK != nil)
    }

    test("transport: failure keeps the spool, exponential backoff 10/20/40... capped at 300 s, success resets") {
        var cfg = Config(machine: "m1"); cfg.post = true
        let (spool, t, poster, clock) = filled(3, config: cfg)
        poster.results = Array(repeating: PostResult.failed(status: 503, reason: "x"), count: 8) + [FakePoster.accepted]
        var delays: [TimeInterval] = []
        for _ in 0..<8 {
            if case .failed(let d) = t.tick() { delays.append(d); clock.advance(d - 1); checkEq(t.tick(), .waiting); clock.advance(1) }
        }
        checkEq(delays, [10, 20, 40, 80, 160, 300, 300, 300])
        checkEq(spool.depth, 3, "nothing deleted on failure")
        checkEq(t.tick(), .sent(count: 3))
        checkEq(spool.depth, 0)
    }

    test("transport: replay after failure resends the same keys (server dedupes on machine+boot+seq)") {
        var cfg = Config(machine: "m1"); cfg.post = true
        let (_, t, poster, clock) = filled(4, config: cfg)
        poster.results = [.failed(status: nil, reason: "net"), FakePoster.accepted]
        _ = t.tick()
        clock.advance(10)
        _ = t.tick()
        func keys(_ d: Data) -> [String] {
            ((J.dict(String(decoding: d, as: UTF8.self))!["events"] as! [[String: Any]]).map { "\($0["boot_id"] as! String)|\($0["seq"] as! NSNumber)" })
        }
        checkEq(keys(poster.calls[0].body), keys(poster.calls[1].body))
    }

    test("transport: 413 halves the batch and resends in the same tick (R4)") {
        var cfg = Config(machine: "m1"); cfg.post = true
        let (_, t, poster, _) = filled(10, config: cfg)
        poster.results = [.failed(status: 413, reason: "too big")]
        checkEq(t.tick(), .sent(count: 5))
        checkEq(poster.calls.count, 2)
    }

    test("backoff struct") {
        var b = Backoff()
        checkEq([b.fail(), b.fail(), b.fail()], [10, 20, 40])
        b.reset()
        checkEq(b.fail(), 10)
    }
}
