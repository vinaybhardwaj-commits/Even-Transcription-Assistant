import Foundation

struct PmsetEntry {
    let ts: Date
    let domain: String
    let message: String
}

struct PowerDetail {
    var reason: String?
    var senderPID: Int?
    var powerSource: String?
    var chargePct: Int?
    var secs: Int?
    var flags: String?
    var from: String?
    var kAESleep = false
    var maintenance = false
}

/// Parser for `pmset -g log` lines. Format (tab separated after the timestamp):
///   2026-10-05 01:36:12 +0530 Sleep   \tEntering Sleep state due to 'Idle Sleep':... Using AC (Charge:100%) 1783 secs
enum PmsetLog {
    static let stampRX = RX(#"^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4}) (.*)$"#)
    static let multiSpaceRX = RX(#"^(\S+(?: \S+)*?) {2,}(.*)$"#)
    static let quotedReasonRX = RX(#"due to '([^']*)'"#)
    static let bareReasonRX = RX(#"due to (.+?)(?= Using | \d+ secs|\s*$)"#)
    static let pidRX = RX(#"\bpid[= ](\d+)"#)
    static let usingRX = RX(#"Using (AC|Batt|BATT|UPS)(?: \(Charge:(\d+)%\))?"#)
    static let secsRX = RX(#"(\d+) secs"#)
    static let flagsRX = RX(#"\[(\w+)\]"#)
    static let fromRX = RX(#"^(?:Dark)?Wake from (.+?) \["#)

    static func parseLine(_ line: String) -> PmsetEntry? {
        guard let g = stampRX.match(line),
              let ts = TimeFmt.parseStamp(date: g[1], time: g[2], frac: nil, tz: g[3]) else { return nil }
        let rest = g[4]
        let domain: String
        let message: String
        if let tab = rest.firstIndex(of: "\t") {
            domain = String(rest[..<tab]).trimmed
            message = String(rest[rest.index(after: tab)...]).squashed
        } else if let m = multiSpaceRX.match(rest) {
            domain = m[1].trimmed
            message = m[2].squashed
        } else {
            domain = rest.trimmed
            message = ""
        }
        return PmsetEntry(ts: ts, domain: domain, message: message)
    }

    /// All parsed entries except the (very numerous, irrelevant here) Assertions domain.
    static func parse(_ text: String) -> [PmsetEntry] {
        var out: [PmsetEntry] = []
        text.enumerateLines { line, _ in
            if line.isEmpty || !(line.hasPrefix("20") || line.hasPrefix("19")) { return }
            if line.contains(" Assertions ") { return }
            if let e = parseLine(line) { out.append(e) }
        }
        return out
    }

    static func detail(domain: String, message: String) -> PowerDetail {
        var d = PowerDetail()
        if let g = quotedReasonRX.match(message) { d.reason = g[1] }
        else if let g = bareReasonRX.match(message) { d.reason = g[1].trimmed }
        if let g = pidRX.match(message) { d.senderPID = Int(g[1]) }
        if let g = usingRX.match(message) {
            d.powerSource = g[1]
            d.chargePct = Int(g[2])
        }
        if let g = secsRX.match(message) { d.secs = Int(g[1]) }
        if let g = flagsRX.match(message) { d.flags = g[1] }
        if let g = fromRX.match(message) { d.from = g[1] }
        d.kAESleep = message.contains("kAESleep")
        if d.kAESleep && d.reason == nil { d.reason = "kAESleep" }
        let low = (domain + " " + message).lowercased()
        d.maintenance = low.contains("maintenance")
        return d
    }

    static func events(for e: PmsetEntry, origin: String = "pmset_log") -> [DraftEvent] {
        let d = detail(domain: e.domain, message: e.message)
        var p: Payload = ["origin": origin, "domain": e.domain, "message": e.message.truncated(300)]
        if let r = d.reason { p["reason"] = r }
        if let s = d.senderPID { p["sender_pid"] = s }
        if let s = d.powerSource { p["power_source"] = s }
        if let c = d.chargePct { p["charge_pct"] = c }
        if let s = d.secs { p["secs"] = s }
        if let f = d.flags { p["flags"] = f }
        if let f = d.from { p["from"] = f }
        if d.kAESleep { p["kAESleep"] = true }

        var out: [DraftEvent] = []
        var kind: String?
        switch e.domain.lowercased() {
        case "sleep", "clamshell sleep": kind = "power.sleep"
        case "darkwake": kind = "power.darkwake"
        case "wake": kind = "power.wake"
        default: kind = nil
        }
        if let k = kind { out.append(DraftEvent(k, p, ts: e.ts)) }
        if d.kAESleep || d.maintenance || d.senderPID != nil {
            out.append(DraftEvent("power.reason", p, ts: e.ts))
        }
        return out
    }

    /// "Display is turned on/off" Notification lines.
    static func displayState(for e: PmsetEntry) -> String? {
        guard e.domain.lowercased() == "notification" else { return nil }
        let m = e.message.lowercased()
        if m.contains("display is turned on") { return "on" }
        if m.contains("display is turned off") { return "off" }
        return nil
    }
}

final class PowerCollector {
    private let ctx: Context
    private(set) var lastEntries: [PmsetEntry] = []
    var lookback: TimeInterval = 24 * 3600
    var maxEvents = 500
    static let cursorKey = "cursor.power"

    init(ctx: Context) { self.ctx = ctx }

    /// Fresh parse of `pmset -g log` (no cursor involved); nil if pmset failed.
    static func fetchEntries(ctx: Context) -> [PmsetEntry]? {
        let r = ctx.runner.run(Tool.pmset, ["-g", "log"], timeout: 60)
        guard r.ok else { return nil }
        return PmsetLog.parse(r.stdout)
    }

    func poll() -> CollectorResult {
        var res = CollectorResult()
        let r = ctx.runner.run(Tool.pmset, ["-g", "log"], timeout: 60)
        guard r.ok else {
            res.degraded = true
            res.notes.append("pmset -g log: \(r.failureNote)")
            return res
        }
        let entries = PmsetLog.parse(r.stdout)
        lastEntries = entries
        var cursor = LogCursor.load(ctx.state, key: Self.cursorKey)
        let fresh = cursor.advance(entries, ts: { $0.ts }, digest: { "\($0.domain)|\($0.message)" },
                                   floor: ctx.clock.now().addingTimeInterval(-lookback))
        cursor.save(ctx.state, key: Self.cursorKey)
        var events = fresh.flatMap { PmsetLog.events(for: $0) }
        if events.count > maxEvents {
            res.notes.append("power: \(events.count - maxEvents) older events omitted (cap \(maxEvents))")
            events = Array(events.suffix(maxEvents))
        }
        res.events = events
        return res
    }
}
