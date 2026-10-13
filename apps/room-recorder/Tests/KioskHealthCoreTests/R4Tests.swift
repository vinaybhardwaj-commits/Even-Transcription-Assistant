import Foundation
@testable import KioskHealthCore

// Round-4: the daemon transport matches the live W1 sink contract (guards, byte-capped batches, response handling).

/// A tiny HTTP/1.1 server on 127.0.0.1 (random port) so the real URLSessionPoster is exercised. The handler gets the
/// request index (0-based) and the parsed request and returns (status, response body).
final class FakeSink {
    struct Request { var auth: String?; var body: Data; var events: Int }
    private var fd: Int32 = -1
    private(set) var port: UInt16 = 0
    private let lock = NSLock()
    private var _requests: [Request] = []
    var handler: (Int, Request) -> (Int, String) = { _, _ in (200, "{\"ok\":true,\"accepted\":0,\"duplicates\":0,\"rejected\":0,\"rejected_reasons\":[]}") }

    var requests: [Request] { lock.lock(); defer { lock.unlock() }; return _requests }
    var url: String { "http://127.0.0.1:\(port)/api/kiosk-health" }

    init() {
        fd = socket(AF_INET, SOCK_STREAM, 0)
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        listen(fd, 16)
        var bound = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &bound) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
        port = UInt16(bigEndian: bound.sin_port)
        let listener = fd
        Thread.detachNewThread { [self] in
            while true {
                let c = accept(listener, nil, nil)
                if c < 0 { return }
                serve(c)
            }
        }
    }

    func stop() { close(fd) }

    private func readAll(_ c: Int32) -> (head: String, body: Data)? {
        var buf = Data()
        var chunk = [UInt8](repeating: 0, count: 65536)
        let sep = Data("\r\n\r\n".utf8)
        var headEnd: Range<Data.Index>?
        while headEnd == nil {
            let n = recv(c, &chunk, chunk.count, 0)
            if n <= 0 { return nil }
            buf.append(chunk, count: n)
            headEnd = buf.range(of: sep)
        }
        let head = String(decoding: buf[buf.startIndex..<headEnd!.lowerBound], as: UTF8.self)
        var want = 0
        for l in head.split(separator: "\r\n") where l.lowercased().hasPrefix("content-length:") {
            want = Int(l.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) ?? 0
        }
        var body = Data(buf[headEnd!.upperBound...])
        while body.count < want {
            let n = recv(c, &chunk, chunk.count, 0)
            if n <= 0 { break }
            body.append(chunk, count: n)
        }
        return (head, body)
    }

    private func serve(_ c: Int32) {
        defer { close(c) }
        guard let (head, body) = readAll(c) else { return }
        var auth: String?
        for l in head.split(separator: "\r\n") where l.lowercased().hasPrefix("authorization:") {
            auth = l.split(separator: ":", maxSplits: 1)[1].trimmingCharacters(in: .whitespaces)
        }
        let count = ((J.parse(data: body) as? [String: Any])?["events"] as? [Any])?.count ?? 0
        let req = Request(auth: auth, body: body, events: count)
        lock.lock()
        let idx = _requests.count
        _requests.append(req)
        lock.unlock()
        let (status, text) = handler(idx, req)
        let payload = Data(text.utf8)
        let resp = "HTTP/1.1 \(status) X\r\nContent-Type: application/json\r\nContent-Length: \(payload.count)\r\nConnection: close\r\n\r\n"
        var out = Data(resp.utf8)
        out.append(payload)
        out.withUnsafeBytes { p in
            var off = 0
            while off < out.count {
                let n = send(c, p.baseAddress! + off, out.count - off, 0)
                if n <= 0 { break }
                off += n
            }
        }
    }
}

private func ack200(_ accepted: Int, dup: Int = 0, rejected: Int = 0, reasons: [String] = []) -> String {
    J.string(["ok": true, "accepted": accepted, "duplicates": dup, "rejected": rejected, "rejected_reasons": reasons] as [String: Any])
}

private func emitInto(_ spool: Spool, dir: URL, count: Int, payload: @autoclosure () -> Payload = ["n": 1], kind: String = "power.wake") -> Emitter {
    var cfg = Config(machine: "m1")
    cfg.installID = "install_abc"
    let em = Emitter(config: cfg, bootID: "BOOT-R4", clock: FakeClock(Date(timeIntervalSince1970: 1_790_000_000)),
                     sink: spool, startSeq: 0, seqStore: nil)
    for _ in 0..<count { em.emit(DraftEvent(kind, payload())) }
    em.flush()
    return em
}

private func rig(events: Int, payload: @autoclosure () -> Payload = ["n": 1], handler: ((Int, FakeSink.Request) -> (Int, String))? = nil)
    -> (Spool, Transport, FakeSink, FakeClock, URL) {
    let dir = tmpDir("r4")
    let spool = try! Spool(dir: dir, capBytes: 200 * 1024 * 1024, segmentBytes: 1 << 20)
    _ = emitInto(spool, dir: dir, count: events, payload: payload())
    let sink = FakeSink()
    if let h = handler { sink.handler = h }
    var cfg = Config(machine: "m1")
    cfg.post = true
    cfg.token = "tok-r4"
    cfg.sinkURL = sink.url
    let clock = FakeClock(Date(timeIntervalSince1970: 1_790_000_000))
    return (spool, Transport(config: cfg, spool: spool, poster: URLSessionPoster(), clock: clock), sink, clock, dir)
}

func runR4Tests() {
    // MARK: per-event guards

    test("R4 guards: kind is lowercased, bad characters become '_', capped at 64, never empty") {
        checkEq(SinkGuard.sanitizeKind("Power.Wake"), "power.wake")
        checkEq(SinkGuard.sanitizeKind("audio error/start failure!"), "audio_error_start_failure_")
        checkEq(SinkGuard.sanitizeKind("a-b_c.d9"), "a-b_c.d9")
        checkEq(SinkGuard.sanitizeKind(""), "unknown")
        checkEq(SinkGuard.sanitizeKind(String(repeating: "k", count: 200)).count, 64)
        let re = RX("^[a-z0-9_.-]+$")
        for k in ["Ünïcode kind", "UPPER", "tab\tkind", "emoji😀kind"] { check(re.matches(SinkGuard.sanitizeKind(k)), "\(k)") }
    }

    test("R4 guards: NUL and lone surrogates are stripped from strings, nested too; valid text is untouched") {
        checkEq(SinkGuard.cleanString("ab\u{0}cd"), "abcd")
        checkEq(SinkGuard.cleanString("héllo 😀 日本"), "héllo 😀 日本")
        let lone = String(decoding: [0x61, 0xD800, 0x62, 0xDC00, 0x63], as: UTF16.self)   // replacement chars from decoding
        check(!SinkGuard.cleanString(lone).utf16.contains(0))
        let ns = NSString(characters: [0x61, 0xD800, 0x62, 0xDC00, 0x63, 0xD83D, 0xDE00] as [unichar], length: 7) as String
        let cleaned = SinkGuard.cleanString(ns)
        check(!cleaned.utf16.contains(where: { (0xD800...0xDFFF).contains($0) && !(cleaned.contains("😀")) }), "no lone surrogates left")
        let p = SinkGuard.cleanValue(["a": "x\u{0}y", "b": ["c": "p\u{0}q", "d": ["r\u{0}s"]] as [String: Any]]) as! [String: Any]
        checkEq(p["a"] as? String, "xy")
        checkEq(((p["b"] as? [String: Any])?["c"]) as? String, "pq")
        checkEq((((p["b"] as? [String: Any])?["d"]) as? [String])?.first, "rs")
    }

    test("R4 guards: an oversized payload becomes the _truncated marker; a payload at the cap stays") {
        let big = SinkGuard.guardPayload(["blob": String(repeating: "x", count: 20_000)], kind: "audio.error")
        checkEq(big["_truncated"] as? Bool, true)
        checkEq(big["kind"] as? String, "audio.error")
        check((big["orig_bytes"] as? Int ?? 0) > SinkGuard.maxPayloadBytes)
        check(J.string(big).utf8.count < 200)
        let fits = SinkGuard.guardPayload(["blob": String(repeating: "x", count: 16_000)], kind: "k")
        check(fits["_truncated"] == nil)
        check(J.string(fits).utf8.count <= SinkGuard.maxPayloadBytes)
    }

    test("R4 emitter: every spooled line meets the contract (kind, ts +00:00, caps, no NUL, payload <=16 KB)") {
        let dir = tmpDir("r4e")
        let spool = try! Spool(dir: dir)
        var cfg = Config(machine: String(repeating: "m", count: 300))
        cfg.roomID = String(repeating: "r", count: 90)
        let em = Emitter(config: cfg, bootID: String(repeating: "b", count: 100), clock: FakeClock(Date(timeIntervalSince1970: 1_790_000_000.123)),
                         sink: spool, startSeq: 0, seqStore: nil)
        em.emit(DraftEvent("Bad Kind/X", ["note": "a\u{0}b"]))
        em.emit(DraftEvent("power.big", ["blob": String(repeating: "z", count: 40_000)]))
        em.flush()
        let recs = spool.readBatch(max: 10)
        checkEq(recs.count, 2)
        let a = J.dict(recs[0].line)!, b = J.dict(recs[1].line)!
        checkEq(a["kind"] as? String, "bad_kind_x")
        checkEq(a["ts"] as? String, "2026-09-21T14:13:20.123+00:00")
        checkEq((a["payload"] as? [String: Any])?["note"] as? String, "ab")
        check(!recs[0].line.contains("\\u0000"), "no NUL escape on the wire")
        checkEq((a["machine"] as? String)?.count, 128)
        checkEq((a["boot_id"] as? String)?.count, 64)
        checkEq((a["room_id"] as? String)?.count, 64)
        checkEq((b["payload"] as? [String: Any])?["_truncated"] as? Bool, true)
        check(RX("^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}[+-]\\d\\d:\\d\\d$").matches(a["ts"] as! String))
        // the spool routes by the sanitised kind
        checkEq(recs[0].kind, "bad_kind_x")
    }

    // MARK: response handling against a real local HTTP server

    test("R4 200 with partial rejection: the whole batch is deleted, counts are logged and kept as last_post") {
        let (spool, t, sink, _, _) = rig(events: 10, handler: { _, _ in (200, ack200(7, dup: 1, rejected: 2, reasons: ["bad kind at 3", "ts at 5"])) })
        defer { sink.stop() }
        var logs: [(String, String)] = []
        t.onLog = { logs.append(($0, $1)) }
        checkEq(t.tick(), .sent(count: 10))
        checkEq(spool.depth, 0, "rejected lines are deleted too")
        checkEq(spool.readBatch(max: 100).count, 0)
        checkEq(sink.requests.count, 1)
        checkEq(sink.requests[0].auth, "Bearer tok-r4")
        let lp = t.lastPost
        checkEq(lp?.http, 200); checkEq(lp?.accepted, 7); checkEq(lp?.rejected, 2)
        check(t.lastPostOK != nil)
        let line = logs.map { $0.1 }.joined(separator: "\n")
        check(line.contains("accepted=7") && line.contains("duplicates=1") && line.contains("rejected=2"), line)
        check(line.contains("bad kind at 3"), "first rejected reason logged")
    }

    test("R4 200 with every event rejected still deletes the lines (nothing is retried)") {
        let (spool, t, sink, clock, _) = rig(events: 4, handler: { _, _ in (200, ack200(0, rejected: 4, reasons: ["x"])) })
        defer { sink.stop() }
        checkEq(t.tick(), .sent(count: 4))
        clock.advance(10)
        checkEq(t.tick(), .idle)
        checkEq(spool.depth, 0)
        checkEq(sink.requests.count, 1)
    }

    test("R4 413: halve and resend down to what fits; the sent lines are deleted, the rest stay") {
        let (spool, t, sink, _, _) = rig(events: 400, handler: { _, r in r.events > 100 ? (413, "{\"error\":\"too_large\"}") : (200, ack200(r.events)) })
        defer { sink.stop() }
        checkEq(t.tick(), .sent(count: 100))
        checkEq(sink.requests.map { $0.events }, [400, 200, 100])
        checkEq(spool.depth, 300)
        // the resent events are the OLDEST ones, so a retry is idempotent on (machine, boot_id, seq)
        func firstSeq(_ d: Data) -> Int { (((J.parse(data: d) as! [String: Any])["events"] as! [[String: Any]])[0]["seq"] as! NSNumber).intValue }
        checkEq(firstSeq(sink.requests[0].body), firstSeq(sink.requests[2].body))
    }

    test("R4 413 for a single event: that event goes to quarantine, the others are still sent") {
        // every request containing the first event (seq 1) is too large; others pass
        let (spool, t, sink, _, _) = rig(events: 4, handler: { _, r in
            let evs = (J.parse(data: r.body) as! [String: Any])["events"] as! [[String: Any]]
            let hasFirst = evs.contains { ($0["seq"] as! NSNumber).intValue == 1 }
            return hasFirst ? (413, "{}") : (200, ack200(evs.count))
        })
        defer { sink.stop() }
        checkEq(t.tick(), .quarantined(count: 1))
        checkEq(sink.requests.map { $0.events }, [4, 2, 1])
        checkEq(spool.quarantineFiles.count, 1)
        checkEq(spool.depth, 3)
        checkEq(t.tick(), .sent(count: 3))
        checkEq(sink.requests.last?.events, 3)
        checkEq(spool.depth, 0)
    }

    test("R4 400: batch goes to spool/quarantine/, logged once, never retried") {
        let (spool, t, sink, clock, dir) = rig(events: 5, handler: { _, _ in (400, "{\"error\":\"bad_body\"}") })
        defer { sink.stop() }
        var logs: [String] = []
        t.onLog = { _, m in logs.append(m) }
        checkEq(t.tick(), .quarantined(count: 5))
        checkEq(spool.depth, 0)
        checkEq(sink.requests.count, 1)
        let files = spool.quarantineFiles
        checkEq(files.count, 1)
        let q = dir.appendingPathComponent("quarantine").appendingPathComponent(files[0])
        let lines = String(decoding: FileManager.default.contents(atPath: q.path) ?? Data(), as: UTF8.self).split(separator: "\n")
        checkEq(lines.count, 5)
        checkEq(((try? FileManager.default.attributesOfItem(atPath: q.path))?[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        checkEq(logs.filter { $0.contains("400") }.count, 1)
        for _ in 0..<3 { clock.advance(600); _ = t.tick() }
        checkEq(sink.requests.count, 1, "no retry: the spool is empty and the batch is not sent again")
        checkEq(t.lastPost?.http, 400)
    }

    test("R4 quarantine folder is capped at 5 MB, oldest file dropped first") {
        let dir = tmpDir("r4q")
        let spool = try! Spool(dir: dir, capBytes: 400 * 1024 * 1024)
        let em = { () -> Emitter in
            var cfg = Config(machine: "m1"); cfg.installID = "i"
            return Emitter(config: cfg, bootID: "B", clock: FakeClock(Date()), sink: spool, startSeq: 0, seqStore: nil)
        }()
        var names: [String] = []
        for _ in 0..<8 {   // each batch ~1.6 MB: 100 events of ~16 KB
            for _ in 0..<100 { em.emit(DraftEvent("power.x", ["blob": String(repeating: "q", count: 15_900)])) }
            em.flush()
            let recs = spool.readBatch(max: 100)
            checkEq(recs.count, 100)
            if let n = spool.quarantine(records: recs) { names.append(n) }
        }
        check(spool.quarantineBytes <= Spool.quarantineCapBytes, "\(spool.quarantineBytes)")
        check(spool.quarantineFiles.count < 8 && spool.quarantineFiles.count >= 2)
        checkEq(spool.quarantineFiles.last, names.last, "newest kept")
        check(!spool.quarantineFiles.contains(names[0]), "oldest dropped")
        checkEq(spool.depth, 0)
    }

    test("R4 401: posting stops (no further requests for an hour), events keep spooling, then it tries again") {
        let (spool, t, sink, clock, dir) = rig(events: 6, handler: { _, _ in (401, "{\"error\":\"unauthorized\"}") })
        defer { sink.stop() }
        var logs: [(String, String)] = []
        t.onLog = { logs.append(($0, $1)) }
        checkEq(t.tick(), .unauthorized)
        checkEq(spool.depth, 6, "nothing deleted")
        // new events keep arriving and spooling
        _ = emitInto(spool, dir: dir, count: 2)
        checkEq(spool.depth, 8)
        clock.advance(3000)
        checkEq(t.tick(), .waiting)
        checkEq(sink.requests.count, 1)
        clock.advance(601)
        checkEq(t.tick(), .unauthorized, "after an hour one more try, loud again")
        checkEq(sink.requests.count, 2)
        checkEq(logs.filter { $0.0 == "ERROR" }.count, 2, "one loud line per hour")
        checkEq(t.lastPost?.http, 401)
    }

    test("R4 503: nothing deleted, exponential backoff 10/20/40 s, success resets") {
        let (spool, t, sink, clock, _) = rig(events: 3, handler: { i, _ in i < 3 ? (503, "{\"error\":\"unavailable\"}") : (200, ack200(3)) })
        defer { sink.stop() }
        var delays: [TimeInterval] = []
        for _ in 0..<3 {
            if case .failed(let d) = t.tick() { delays.append(d); clock.advance(d) }
        }
        checkEq(delays, [10, 20, 40])
        checkEq(spool.depth, 3)
        checkEq(t.tick(), .sent(count: 3))
        checkEq(spool.depth, 0)
        checkEq(sink.requests.count, 4)
    }

    test("R4 network error (nothing listening): backoff, spool kept, last_post http is nil") {
        let (spool, t, sink, _, _) = rig(events: 2)
        sink.stop()
        // closing the listening socket makes connects fail (or reset): either way a transport error or non-2xx
        let r = t.tick()
        if case .failed = r {} else { check(false, "expected failure, got \(r)") }
        checkEq(spool.depth, 2)
        check(t.lastPost?.http == nil)
    }

    // MARK: byte-capped batching

    test("R4 batches stop at 2,900,000 bytes: 16 KB payloads give ~175 events per request, all arrive, none over 3 MB") {
        let (spool, t, sink, clock, _) = rig(events: 520, payload: ["blob": String(repeating: "b", count: 16_000)],
                                             handler: { _, r in (200, ack200(r.events)) })
        defer { sink.stop() }
        var guardLoops = 0
        while spool.depth > 0 && guardLoops < 20 { _ = t.tick(); clock.advance(10); guardLoops += 1 }
        checkEq(spool.depth, 0)
        let sizes = sink.requests.map { $0.body.count }
        let counts = sink.requests.map { $0.events }
        check(sizes.allSatisfy { $0 <= Transport.maxBodyBytes }, "\(sizes)")
        check(sizes.allSatisfy { $0 < 3_000_000 })
        check(counts.allSatisfy { $0 <= 500 && $0 >= 1 })
        checkEq(counts.reduce(0, +), 520)
        check((170...185).contains(counts[0]), "first batch \(counts[0])")
        check(counts.count >= 3, "\(counts)")
    }

    test("R4 batches stop at 500 events when payloads are small") {
        let (spool, t, sink, _, _) = rig(events: 700, handler: { _, r in (200, ack200(r.events)) })
        defer { sink.stop() }
        checkEq(t.tick(), .sent(count: 500))
        checkEq(t.tick(), .sent(count: 200))
        checkEq(sink.requests.map { $0.events }, [500, 200])
        checkEq(spool.depth, 0)
    }

    test("R4 Spool.readBatch(maxBytes:) always returns at least one record and keeps order") {
        let dir = tmpDir("r4b")
        let spool = try! Spool(dir: dir)
        _ = emitInto(spool, dir: dir, count: 5, payload: ["blob": String(repeating: "c", count: 4000)])
        let all = spool.readBatch(max: 100)
        let one = spool.readBatch(max: 100, maxBytes: 10)
        checkEq(one.count, 1)
        checkEq(one[0].key, all[0].key)
        let some = spool.readBatch(max: 100, maxBytes: Spool.bodyOverhead + all[0].line.utf8.count * 2 + 1)
        checkEq(some.count, 2)
        // the byte total the batch builder counts equals the serialised body
        let body = Transport.body(some[0..<some.count])
        check(body.count <= Spool.bodyOverhead + all[0].line.utf8.count * 2 + 1)
    }

    // MARK: heartbeat last_post, config F22

    test("R4 heartbeat carries last_post {at, http, accepted, rejected}; null before the first post") {
        let (ctx, _, _) = makeCtx()
        let hb = HeartbeatCollector(ctx: ctx)
        check(hb.build().payload["last_post"] is NSNull)
        hb.lastPost = { LastPost(at: Date(timeIntervalSince1970: 1_790_000_000), http: 200, accepted: 9, rejected: 1) }
        let lp = hb.build().payload["last_post"] as? [String: Any]
        checkEq(lp?["http"] as? Int, 200)
        checkEq(lp?["accepted"] as? Int, 9)
        checkEq(lp?["rejected"] as? Int, 1)
        checkEq(lp?["at"] as? String, "2026-09-21T14:13:20.000Z")
        hb.lastPost = { LastPost(at: Date(timeIntervalSince1970: 1_790_000_000), http: nil, accepted: 0, rejected: 0) }
        check((hb.build().payload["last_post"] as? [String: Any])?["http"] is NSNull)
        check(J.string(hb.build().payload).utf8.count < SinkGuard.maxPayloadBytes)
    }

    test("R4 F22 --check-config rejects post:true with no token (missing, null, empty), accepts it with one") {
        func cfg(post: Bool, token: Any?) -> Data {
            var d: [String: Any] = ["machine": "m", "sink_url": "https://x.example/api", "post": post,
                                    "actions": ["darkwake_watchdog": true, "audio_ladder": false, "reboot_rung": false] as [String: Any]]
            if let t = token { d["token"] = t }
            return (try? JSONSerialization.data(withJSONObject: d)) ?? Data()
        }
        checkEq(ConfigCheck.check(cfg(post: true, token: nil)), "post is true but token is missing or empty")
        checkEq(ConfigCheck.check(cfg(post: true, token: NSNull())), "post is true but token is missing or empty")
        checkEq(ConfigCheck.check(cfg(post: true, token: "")), "post is true but token is missing or empty")
        check(ConfigCheck.check(cfg(post: true, token: "SECRET-TOKEN-R4")) == nil)
        check(ConfigCheck.check(cfg(post: false, token: nil)) == nil, "spool-only needs no token")
        check(ConfigCheck.check(cfg(post: true, token: nil))?.contains("SECRET") == false)
    }
}
