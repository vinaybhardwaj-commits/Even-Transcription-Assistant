
import Foundation

struct DisplayReading: Equatable {
    var state: String      // on | off | unknown
    var source: String     // ioreg | none
}

enum DisplayProbe {
    /// `"NormalModeActive" = Yes|No` per IOMobileFramebufferShim instance (`ioreg -r -c IOMobileFramebufferShim`).
    /// Any framebuffer active -> display on; every one inactive -> off. No CoreGraphics, no WindowServer, no TCC.
    static let normalModeRX = RX(#""NormalModeActive"\s*=\s*(Yes|No)"#)

    static func fromIoreg(_ text: String) -> DisplayReading? {
        let all = normalModeRX.allMatches(text)
        guard !all.isEmpty else { return nil }
        return DisplayReading(state: all.contains { $0[1] == "Yes" } ? "on" : "off", source: "ioreg")
    }
}

final class DisplayCollector {
    private let ctx: Context
    private var lastReported: String?
    static let cursorKey = "cursor.display"

    init(ctx: Context) { self.ctx = ctx }

    /// The CURRENT display state is the live ioreg reading of the framebuffers' power state, always. pmset's log is
    /// history: its "Display is turned on/off" lines are only ever turned into transition events stamped with their
    /// own time (see `poll`), never into the current state, because the last line can be many hours old. If ioreg
    /// does not answer the state is "unknown" (the watchdog and the did-wake path treat unknown as "not off").
    /// Never CoreGraphics (a TCC trigger).
    func current() -> DisplayReading {
        let r = ctx.runner.run(Tool.ioreg, ["-r", "-c", "IOMobileFramebufferShim", "-d", "1", "-w0"], timeout: 10)
        if r.ok, let reading = DisplayProbe.fromIoreg(r.stdout) { return reading }
        return DisplayReading(state: "unknown", source: "none")
    }

    func poll(entries: [PmsetEntry]) -> CollectorResult {
        var res = CollectorResult()
        var cursor = LogCursor.load(ctx.state, key: Self.cursorKey)
        let notes = entries.filter { PmsetLog.displayState(for: $0) != nil }
        let fresh = cursor.advance(notes, ts: { $0.ts }, digest: { "\($0.domain)|\($0.message)" },
                                   floor: ctx.clock.now().addingTimeInterval(-24 * 3600))
        cursor.save(ctx.state, key: Self.cursorKey)
        for e in fresh {
            if let s = PmsetLog.displayState(for: e) {
                // A transition that happened at e.ts, reported with that time; says nothing about the state now.
                res.events.append(DraftEvent("display.state", ["state": s, "origin": "pmset_log", "message": e.message], ts: e.ts))
            }
        }
        let cur = current()
        if cur.state != lastReported {
            lastReported = cur.state
            res.events.append(DraftEvent("display.state", ["state": cur.state, "origin": cur.source, "sampled": true]))
        }
        if cur.state == "unknown" { res.notes.append("display state unknown (ioreg framebuffer reading unavailable)") }
        return res
    }
}
