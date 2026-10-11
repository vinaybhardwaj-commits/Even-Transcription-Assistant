import Foundation
@testable import KioskHealthCore

// Round-12: Room Recorder 0.1.26 (MicModeGuard) writes status.json "mic_mode": {before, after, set, at}.
// recorder.status carries it, bounded; the recorder.log forward filter also forwards "micmode" lines.

private func w12(_ path: String, _ text: String) {
    try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try? text.write(toFile: path, atomically: false, encoding: .utf8)
}

private func status(_ extra: String = "") -> String {
    "{\"state\":\"recording\",\"session_id\":\"bs_a\",\"pending_piece_count\":0,\"updated_at\":\"2026-10-08T03:00:00Z\"\(extra)}"
}

/// Run the real collector over a status.json and return the recorder.status events it emits.
private func statusEvents(_ json: String) -> [DraftEvent] {
    let home = tmpDir("r12home").path
    let rr = home + "/Library/Application Support/EvenScribe/RoomRecorder"
    w12(rr + "/status.json", json)
    let (ctx, _, _) = makeCtx(home: home)
    return RecorderLogCollector(ctx: ctx).poll().events.filter { $0.kind == "recorder.status" }
}

func runR12Tests() {
    let good = "{\"before\":\"built_in\",\"after\":\"standard\",\"set\":\"ok\",\"at\":\"2026-10-08T03:00:01Z\"}"

    test("R12 mic_mode present: carried verbatim in recorder.status, known keys only, and no longer listed under other_keys") {
        let ev = statusEvents(status(",\"mic_mode\":" + good))
        checkEq(ev.count, 1)
        let mm = ev.first?.payload["mic_mode"] as? [String: String]
        checkEq(mm, ["before": "built_in", "after": "standard", "set": "ok", "at": "2026-10-08T03:00:01Z"])
        checkEq(ev.first?.payload["other_keys"] as? [String], [], "mic_mode is a known key now")
        // the rest of the payload is exactly what it was
        checkEq(ev.first?.payload["state"] as? String, "recording")
        checkEq(ev.first?.payload["session_open"] as? String, "yes")
        check(ev.first?.payload["file_mtime"] is String)
        // every documented `set` value passes through untouched
        for v in ["ok", "skip", "fail", "unreadable"] {
            let e = statusEvents(status(",\"mic_mode\":{\"set\":\"\(v)\"}"))
            checkEq((e.first?.payload["mic_mode"] as? [String: String])?["set"], v)
        }
    }

    test("R12 mic_mode absent: the key is not in the payload at all (not null), and nothing else changed") {
        let ev = statusEvents(status())
        checkEq(ev.count, 1)
        check(ev.first?.payload["mic_mode"] == nil, "absent, not NSNull")
        check(!ev.first!.payload.keys.contains("mic_mode"))
        checkEq(Set(ev.first!.payload.keys), ["state", "session_id", "pending_piece_count", "updated_at", "other_keys", "session_open", "file_mtime"])
        check(RecorderStatusParser.parse(Data(status().utf8)).micMode == nil)
    }

    test("R12 mic_mode malformed: treated as absent, never an error, never a crash") {
        let bad = ["\"oops\"", "[1,2,3]", "42", "true", "null", "{}", "[]",
                   "{\"unknown\":\"x\",\"other\":\"y\"}",             // no known key
                   "{\"before\":true,\"after\":false,\"set\":null,\"at\":[\"x\"]}",  // known keys, no usable values (R12b: numbers ARE usable, booleans are not)
                   "{\"before\":{\"nested\":\"obj\"}}"]
        for b in bad {
            let ev = statusEvents(status(",\"mic_mode\":" + b))
            checkEq(ev.count, 1, b)
            check(ev.first?.payload["mic_mode"] == nil, "malformed mic_mode \(b) must be absent")
            checkEq(ev.first?.payload["session_open"] as? String, "yes", "the rest of the status still reads")
        }
        // a mix: only the usable string keys survive, unknown keys are dropped
        let mix = statusEvents(status(",\"mic_mode\":{\"before\":\"a\",\"after\":[7],\"set\":\"fail\",\"extra\":\"nope\"}"))
        checkEq(mix.first?.payload["mic_mode"] as? [String: String], ["before": "a", "set": "fail"])
        // status.json itself unreadable JSON: no mic_mode, parse error flagged as before
        let broken = RecorderStatusParser.parse(Data("{\"mic_mode\":".utf8))
        check(broken.parseError && broken.micMode == nil)
    }

    test("R12 mic_mode oversize: strings cut at 64, NUL stripped, astral characters never split, huge extra keys ignored, event within the payload limit") {
        let long = String(repeating: "x", count: 5000)
        let ev = statusEvents(status(",\"mic_mode\":{\"before\":\"\(long)\",\"after\":\"\(long)\",\"set\":\"\(long)\",\"at\":\"\(long)\"}"))
        let mm = ev.first?.payload["mic_mode"] as? [String: String]
        for k in ["before", "after", "set", "at"] { checkEq(mm?[k]?.utf16.count, 64, k) }
        let emoji = String(repeating: "😀", count: 100)
        let e2 = statusEvents(status(",\"mic_mode\":{\"before\":\"\(emoji)\",\"set\":\"a\\u0000b\"}"))
        let m2 = e2.first?.payload["mic_mode"] as? [String: String]
        checkEq(m2?["before"]?.utf16.count, 64)
        check(m2?["before"]?.unicodeScalars.allSatisfy { $0 == "😀" } == true, "no broken surrogate pair")
        checkEq(m2?["set"], "ab", "NUL stripped")
        // thousands of unknown keys inside mic_mode: none of them leaves the machine
        let junk = (0..<3000).map { "\"junk\($0)\":\"v\($0)\"" }.joined(separator: ",")
        let e3 = statusEvents(status(",\"mic_mode\":{\"set\":\"ok\",\(junk)}"))
        checkEq(e3.first?.payload["mic_mode"] as? [String: String], ["set": "ok"])
        // worst case through the sink guards: not truncated, well under 16 KB
        for e in [ev, e2, e3] {
            let g = SinkGuard.guardPayload(e.first!.payload, kind: "recorder.status")
            check(g["_truncated"] == nil, "payload limit untouched")
            check(J.string(g).utf8.count < 1024)
        }
    }

    test("R12 a changed mic_mode emits a new recorder.status; an unchanged one does not (fingerprint)") {
        let home = tmpDir("r12fp").path
        let rr = home + "/Library/Application Support/EvenScribe/RoomRecorder"
        w12(rr + "/status.json", status(",\"mic_mode\":" + good))
        let (ctx, clock, _) = makeCtx(home: home)
        let rc = RecorderLogCollector(ctx: ctx)
        func n() -> Int { rc.poll().events.filter { $0.kind == "recorder.status" }.count }
        checkEq(n(), 1)
        clock.advance(10)
        checkEq(n(), 0, "unchanged")
        w12(rr + "/status.json", status(",\"mic_mode\":{\"before\":\"built_in\",\"after\":\"standard\",\"set\":\"fail\",\"at\":\"2026-10-08T03:05:00Z\"}"))
        clock.advance(10)
        checkEq(n(), 1, "set ok -> fail is a change")
        w12(rr + "/status.json", status())
        clock.advance(10)
        checkEq(n(), 1, "mic_mode disappearing is a change too")
    }

    test("R12 filter: lines containing micmode (any case) are forwarded; the old rules and exclusions are unchanged") {
        for l in ["MicModeGuard: set skipped", "room-recorder: micmode=fail before=voice", "MICMODE unreadable", "x MiCmOdE y",
                  "ERROR something", "stream stopped", "fallback to builtin mic", "tape writer exited", "no durable growth for 12s", "physical_fallback_required"] {
            check(RecorderLogFilter.matches(l), l)
        }
        for l in ["room-recorder: chunk 17 written", "room-recorder: microphone authorized", "mic mode changed", "mic_mode set", "room session read from room-session.json"] {
            check(!RecorderLogFilter.matches(l), "must not match: \(l)")
        }
        check(!RecorderLogFilter.matches("\t7  room-recorder                       0x000000010078b8ad $s12MicModeGuardC3set + 1"), "stack frames stay excluded")
    }

    test("R12 recorder.log: micmode lines ship with the unchanged payload shape; the 300-char cut and the 200/min limit still hold") {
        let home = tmpDir("r12log").path
        let rr = home + "/Library/Application Support/EvenScribe/RoomRecorder"
        w12(rr + "/launchd.log", "old history\n")
        let (ctx, clock, _) = makeCtx(home: home)
        let rc = RecorderLogCollector(ctx: ctx)
        _ = rc.poll()   // first sight is history
        clock.advance(10)
        func append(_ text: String) {
            let h = FileHandle(forWritingAtPath: rr + "/launchd.log")!
            _ = try? h.seekToEnd(); try? h.write(contentsOf: text.data(using: .utf8)!); try? h.close()
        }
        append("MicModeGuard: set=skip before=built_in\n" + "micmode " + String(repeating: "z", count: 600) + "\nroom-recorder: chunk 18 written\n")
        let ev = rc.poll().events.filter { $0.kind == "recorder.log" }
        checkEq(ev.count, 2, "two micmode lines, the plain chunk line stays home")
        for e in ev {
            checkEq(Set(e.payload.keys), ["file", "line", "count", "recv_ts", "redaction"])
            check((e.payload["line"] as? String ?? "").count <= 300)
            checkEq(e.payload["redaction"] as? String, "keyword_only")
        }
        // 250 DISTINCT micmode lines inside one minute: the cap of 200 still applies and the drop is reported
        func word(_ i: Int) -> String { var n = i; var s = ""; repeat { s += String(UnicodeScalar(97 + UInt8(n % 26))); n /= 26 } while n > 0; return s }
        clock.advance(120)
        append((0..<250).map { "micmode event \(word($0))" }.joined(separator: "\n") + "\n")
        let burst = rc.poll().events.filter { $0.kind == "recorder.log" }
        let shipped = burst.filter { $0.payload["rate_limited"] == nil }
        let limited = burst.filter { $0.payload["rate_limited"] as? Bool == true }
        checkEq(shipped.count, 200, "rate limit unchanged")
        checkEq(limited.first?.payload["dropped_lines"] as? Int, 50)
    }
}
