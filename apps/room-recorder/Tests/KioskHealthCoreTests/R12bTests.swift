import Foundation
@testable import KioskHealthCore

// Round-12b: the refuter's R12-1 (`at` is not part of the change fingerprint), R12-2 (numeric values are accepted and stringified),
// R12-3 (no separator ambiguity in the fingerprint), and the adversarial inputs from RefuteR12.swift.

private func wb(_ path: String, _ text: String) {
    try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try? text.write(toFile: path, atomically: false, encoding: .utf8)
}
private func wbData(_ path: String, _ d: Data) {
    try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try? d.write(to: URL(fileURLWithPath: path))
}
private func stb(_ mm: String) -> String {
    "{\"state\":\"recording\",\"session_id\":\"bs_a\",\"pending_piece_count\":0,\"updated_at\":\"2026-10-08T03:00:00Z\",\"mic_mode\":\(mm)}"
}
private func evb(_ json: String) -> [DraftEvent] {
    let home = tmpDir("r12b").path
    wb(home + "/Library/Application Support/EvenScribe/RoomRecorder/status.json", json)
    let (ctx, _, _) = makeCtx(home: home)
    return RecorderLogCollector(ctx: ctx).poll().events.filter { $0.kind == "recorder.status" }
}
private func fp(_ mm: String) -> String { RecorderLogCollector.statusFingerprint(RecorderStatusParser.parse(Data(stb(mm).utf8))) }

func runR12bTests() {
    test("R12b R12-1: `at` ships in the payload but moving on its own never emits; before/after/set changes do") {
        let home = tmpDir("r12bat").path
        let p = home + "/Library/Application Support/EvenScribe/RoomRecorder/status.json"
        let (ctx, clock, _) = makeCtx(home: home)
        let rc = RecorderLogCollector(ctx: ctx)
        func n() -> Int { rc.poll().events.filter { $0.kind == "recorder.status" }.count }
        wb(p, stb("{\"before\":\"2\",\"after\":\"0\",\"set\":\"ok\",\"at\":\"T0\"}"))
        checkEq(n(), 1, "first sight")
        var churn = 0
        for i in 1...20 {                      // 200 s of `at` ticking every poll
            clock.advance(10)
            wb(p, stb("{\"before\":\"2\",\"after\":\"0\",\"set\":\"ok\",\"at\":\"T\(i)\"}"))
            churn += n()
        }
        checkEq(churn, 0, "no storm: `at` alone is not a change")
        for (field, value) in [("before", "0"), ("after", "2"), ("set", "fail")] {
            clock.advance(10)
            var d = ["before": "2", "after": "0", "set": "ok", "at": "Tx"]
            d[field] = value
            wb(p, stb(J.string(d)))
            checkEq(n(), 1, "\(field) changed")
            clock.advance(10)
            checkEq(n(), 0, "and then quiet")
            d[field] = field == "before" ? "2" : field == "after" ? "0" : "ok"
            wb(p, stb(J.string(d)))
            clock.advance(10)
            checkEq(n(), 1, "\(field) changed back")
        }
        // the payload that does go out (on a real change or the 300 s refresh) carries the CURRENT `at`
        clock.advance(10)
        wb(p, stb("{\"before\":\"2\",\"after\":\"0\",\"set\":\"skip\",\"at\":\"LATEST\"}"))
        let ev = rc.poll().events.filter { $0.kind == "recorder.status" }
        checkEq((ev.first?.payload["mic_mode"] as? [String: String])?["at"], "LATEST")
        // the 300 s refresh still happens when nothing changed
        clock.advance(301)
        wb(p, stb("{\"before\":\"2\",\"after\":\"0\",\"set\":\"skip\",\"at\":\"REFRESH\"}"))
        let r = rc.poll().events.filter { $0.kind == "recorder.status" }
        checkEq((r.first?.payload["mic_mode"] as? [String: String])?["at"], "REFRESH")
    }

    test("R12b R12-2: numeric values (int or float) are accepted and stringified under the same 64-char cap") {
        let e1 = evb(stb("{\"before\":2,\"after\":0,\"set\":\"ok\",\"at\":1728360000}"))
        checkEq(e1.first?.payload["mic_mode"] as? [String: String], ["before": "2", "after": "0", "set": "ok", "at": "1728360000"])
        let e2 = evb(stb("{\"before\":2,\"after\":0,\"set\":1,\"at\":1728360000.5}"))
        checkEq(e2.first?.payload["mic_mode"] as? [String: String], ["before": "2", "after": "0", "set": "1", "at": "1728360000.5"])
        let e3 = evb(stb("{\"before\":2.0,\"after\":-1,\"set\":0.25,\"at\":12345678901234567}"))
        let m3 = e3.first?.payload["mic_mode"] as? [String: String]
        checkEq(m3?["before"], "2", "2.0 reads like the integer 2")
        checkEq(m3?["after"], "-1")
        checkEq(m3?["set"], "0.25")
        checkEq(m3?["at"], "12345678901234567", "a large integer keeps every digit")
        // booleans, null, arrays and objects are still dropped; a known key with only those is absent
        let e4 = evb(stb("{\"before\":true,\"after\":false,\"set\":null,\"at\":[1]}"))
        check(e4.first?.payload["mic_mode"] == nil)
        // mixed numbers and strings; unknown keys stay out even when numeric
        let e5 = evb(stb("{\"before\":2,\"after\":\"0\",\"extra\":99}"))
        checkEq(e5.first?.payload["mic_mode"] as? [String: String], ["before": "2", "after": "0"])
        // numbers go through the same cap (a 400-digit integer literal cannot exceed 64 units)
        let big = String(repeating: "9", count: 400)
        let e6 = evb(stb("{\"set\":\"ok\",\"at\":\(big)}"))
        let at6 = (e6.first?.payload["mic_mode"] as? [String: String])?["at"]
        check((at6?.utf16.count ?? 0) <= 64, "bounded: \(at6 ?? "nil")")
        // numeric and string forms of the same value give the same fingerprint, so a type switch alone is not a change
        checkEq(fp("{\"before\":2,\"set\":\"ok\"}"), fp("{\"before\":\"2\",\"set\":\"ok\"}"))
    }

    test("R12b R12-3: the fingerprint has no separator ambiguity, and an absent key is not a '-' value") {
        let a = fp("{\"before\":\"x,after=y\",\"set\":\"ok\"}")
        let b = fp("{\"before\":\"x\",\"after\":\"y,after=-\",\"set\":\"ok\"}")
        check(a != b, "the refuter's separator-injection pair")
        check(fp("{\"set\":\"ok\"}") != fp("{\"set\":\"ok\",\"after\":\"-\"}"), "absent vs literal '-'")
        check(fp("{\"before\":\"a\",\"after\":\"b\"}") != fp("{\"before\":\"b\",\"after\":\"a\"}"), "swapped values")
        check(fp("{\"set\":\"ok\"}") != fp("\"nope\""), "mic_mode vs none")
        checkEq(fp("{\"set\":\"ok\",\"at\":\"1\"}"), fp("{\"set\":\"ok\",\"at\":\"2\"}"), "at is not part of it")
    }

    test("R12b hostile inputs from the refuter: never a crash, always bounded, never truncated by the sink guards") {
        let cases: [(String, String)] = [
            ("lone high surrogate", "{\"before\":\"a\\ud800b\",\"set\":\"\\udfff\"}"),
            ("pair straddling the 64 cut", "{\"at\":\"" + String(repeating: "x", count: 63) + "\\ud83d\\ude00tail\"}"),
            ("RTL override + BOM + C1 controls", "{\"set\":\"\\u202eko\\ufeff\\u0085\\u001b[31m\"}"),
            ("numeric flavors", "{\"before\":2,\"after\":0,\"set\":\"ok\",\"at\":1728360000}"),
            ("all numeric", "{\"before\":2,\"after\":0,\"set\":1,\"at\":1728360000.5}"),
            ("duplicate key", "{\"set\":\"ok\",\"set\":\"fail\"}"),
            ("1 MB value", "{\"set\":\"" + String(repeating: "\\u00e9", count: 1_000_000) + "\"}"),
            ("deep nesting 2000 inside mic_mode", "{\"before\":" + String(repeating: "[", count: 2000) + String(repeating: "]", count: 2000) + ",\"set\":\"ok\"}"),
            ("huge number", "{\"at\":1e400,\"set\":\"ok\"}"),
            ("1 MB value, pair at the cut", "{\"before\":\"" + String(repeating: "😀", count: 500_000) + "\"}"),
        ]
        for (name, mm) in cases {
            let e = evb(stb(mm))
            let p = e.first?.payload ?? [:]
            let g = SinkGuard.guardPayload(p, kind: "recorder.status")
            let bytes = J.string(g).utf8.count
            let m = p["mic_mode"] as? [String: String]
            check(e.count <= 1, name)
            check((m?.values.map { $0.utf16.count }.max() ?? 0) <= 64, "\(name): 64 units")
            check(m?.values.allSatisfy { SinkGuard.cleanString($0) == $0 } ?? true, "\(name): clean UTF-16")
            check(bytes < 16 * 1024 && g["_truncated"] == nil, "\(name): within the payload limit")
        }
        // exact values for the interesting ones
        checkEq((evb(stb(cases[1].1)).first?.payload["mic_mode"] as? [String: String])?["at"]?.utf16.count, 63, "a pair straddling the cut is dropped whole")
        let dup = (evb(stb(cases[5].1)).first?.payload["mic_mode"] as? [String: String])?["set"]
        check(dup == "ok" || dup == "fail", "duplicate key: one of the two values (Foundation keeps the first), got \(dup ?? "nil")")
        // invalid UTF-8 bytes in the file: no crash, the rest of the status handling is whatever it was before mic_mode existed
        let home = tmpDir("r12butf").path
        var d = Data(stb("{\"set\":\"ok\"}").utf8); d.insert(contentsOf: [0xC3, 0x28, 0xFF], at: d.count - 5)
        wbData(home + "/Library/Application Support/EvenScribe/RoomRecorder/status.json", d)
        let (ctx, _, _) = makeCtx(home: home)
        let e = RecorderLogCollector(ctx: ctx).poll().events.filter { $0.kind == "recorder.status" }
        check(e.count <= 1)
    }
}
