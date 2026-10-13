import Foundation
@testable import KioskHealthCore

// Room Recorder 0.1.38: status.json carries "mic_state" and the new states "retired" and "mic_denied".
// recorder.status relays them; a change of either is a new event.

private func statusEvents138(_ json: String) -> [DraftEvent] {
    let home = tmpDir("r138home").path
    let rr = home + "/Library/Application Support/EvenScribe/RoomRecorder"
    try? FileManager.default.createDirectory(atPath: rr, withIntermediateDirectories: true)
    try? json.write(toFile: rr + "/status.json", atomically: false, encoding: .utf8)
    let (ctx, _, _) = makeCtx(home: home)
    return RecorderLogCollector(ctx: ctx).poll().events.filter { $0.kind == "recorder.status" }
}

func runR138Tests() {
    test("R138 retired: state and mic_state are carried, and mic_state is no longer an unknown key") {
        let ev = statusEvents138("{\"state\":\"retired\",\"mic_state\":\"authorized\",\"updated_at\":\"2026-10-13T03:00:00Z\",\"pending_piece_count\":0}")
        checkEq(ev.count, 1)
        checkEq(ev.first?.payload["state"] as? String, "retired")
        checkEq(ev.first?.payload["mic_state"] as? String, "authorized")
        checkEq(ev.first?.payload["other_keys"] as? [String], [])
    }
    test("R138 mic_denied: the state and the denied mic_state both reach the sink") {
        let ev = statusEvents138("{\"state\":\"mic_denied\",\"mic_state\":\"denied\",\"updated_at\":\"2026-10-13T03:00:00Z\",\"pending_piece_count\":0}")
        checkEq(ev.first?.payload["state"] as? String, "mic_denied")
        checkEq(ev.first?.payload["mic_state"] as? String, "denied")
    }
    test("R138 mic_state outside the three known words is dropped, not forwarded") {
        let ev = statusEvents138("{\"state\":\"ready\",\"mic_state\":\"free text from nowhere\",\"updated_at\":\"2026-10-13T03:00:00Z\",\"pending_piece_count\":0}")
        check(ev.first?.payload["mic_state"] == nil, "an unknown mic_state is absent from the payload")
    }
    test("R138 mic_state absent (an older recorder): the key is not in the payload") {
        let ev = statusEvents138("{\"state\":\"ready\",\"updated_at\":\"2026-10-13T03:00:00Z\",\"pending_piece_count\":0}")
        check(ev.first?.payload["mic_state"] == nil, "no mic_state key")
    }
    test("R138 capture_open is a known key and reaches the sink as a bool") {
        let ev = statusEvents138("{\"state\":\"retired\",\"capture_open\":true,\"updated_at\":\"2026-10-13T03:00:00Z\",\"pending_piece_count\":0}")
        checkEq(ev.first?.payload["capture_open"] as? Bool, true)
        checkEq(ev.first?.payload["other_keys"] as? [String], [])
    }
}
