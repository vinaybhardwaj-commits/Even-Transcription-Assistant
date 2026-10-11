import Foundation

struct TailPos: Equatable {
    var inode: UInt64
    var offset: UInt64
}

enum Tail {
    /// Read complete new lines from `path`.
    ///
    /// First sight of a file (no saved position) is `tail -n 0`: nothing is shipped and the position is the end of the
    /// file, so history that was already there (an old launchd.log, a session that ended last week) never leaves the
    /// machine. The one exception is a file the collector can prove did not exist yet when it started watching: pass
    /// `newFileSince` and a file whose creation time is later than that is read from byte 0, so the first lines of a
    /// brand-new capture session are not lost.
    ///
    /// The saved position is (inode, byte offset). Rotation (the inode changed) and truncation (the file is now
    /// smaller than the offset) both restart at 0. Not handled, by design: lines the old file received between the
    /// last poll and its rotation are not read (the rotated-away file is not followed), and a file that was truncated
    /// and grew back past the saved offset between two polls looks like an ordinary append.
    ///
    /// Note for readers of the audio events: ECHO's `audio.error` hal_error lines come from "Google Chrome Helper
    /// AppleUSBHostUserClient", not from the recorder. They are NOT filtered here (decision deferred).
    static func read(path: String, pos: TailPos?, newFileSince: Date? = nil, maxBytes: Int = 256 * 1024) -> (lines: [String], pos: TailPos)? {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let size = (attrs[.size] as? NSNumber)?.uint64Value,
              let ino = (attrs[.systemFileNumber] as? NSNumber)?.uint64Value else { return nil }
        var offset: UInt64
        if let p = pos, p.inode == ino, p.offset <= size {
            offset = p.offset
        } else if pos != nil {
            offset = 0   // rotated or truncated: start over
        } else if let since = newFileSince, let born = attrs[.creationDate] as? Date, born > since {
            offset = 0   // created after we started watching: every line in it is new
        } else {
            return ([], TailPos(inode: ino, offset: size))   // first sight: tail -n 0
        }
        guard size > offset else { return ([], TailPos(inode: ino, offset: size)) }
        guard let h = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? h.close() }
        do { try h.seek(toOffset: offset) } catch { return nil }
        let want = Int(min(UInt64(maxBytes), size - offset))
        guard let data = try? h.read(upToCount: want), !data.isEmpty else { return ([], TailPos(inode: ino, offset: offset)) }
        // Consume only up to the last newline so a half-written line is read next time.
        guard let lastNL = data.lastIndex(of: 0x0A) else {
            // No newline in a full-size chunk: consume it all to avoid getting stuck on a giant line.
            let consumed = data.count >= maxBytes ? UInt64(data.count) : 0
            return (consumed > 0 ? [String(decoding: data, as: UTF8.self)] : [], TailPos(inode: ino, offset: offset + consumed))
        }
        let chunk = data[data.startIndex...lastNL]
        let lines = String(decoding: chunk, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        return (lines, TailPos(inode: ino, offset: offset + UInt64(chunk.count)))
    }
}

struct RateLimiter {
    let cap: Int
    let window: TimeInterval
    private var windowStart: Date?
    private var used = 0
    private(set) var dropped = 0

    init(cap: Int = 200, window: TimeInterval = 60) { self.cap = cap; self.window = window }

    mutating func allow(now: Date) -> Bool {
        if let s = windowStart, now.timeIntervalSince(s) < window {
            if used < cap { used += 1; return true }
            dropped += 1
            return false
        }
        windowStart = now
        used = 1
        return true
    }

    mutating func takeDropped() -> Int { let d = dropped; dropped = 0; return d }
}

/// Collapses identical lines inside a 10 minute window. The first occurrence ships at once (an error must not wait
/// ten minutes); repeats are counted and leave as ONE trailing event carrying the count when the window closes.
struct RepeatCollapser {
    struct Entry {
        var first: Date
        var last: Date
        var suppressed: Int
        var file: String
        var line: String
    }
    let window: TimeInterval
    let maxEntries: Int
    private(set) var entries: [String: Entry] = [:]

    init(window: TimeInterval = 600, maxEntries: Int = 2000) { self.window = window; self.maxEntries = maxEntries }

    static let digitsRX = RX(#"\d+"#)
    static func key(file: String, line: String) -> String { file + "|" + digitsRX.replace(line, with: "#") }

    /// true: ship this line now (first sight, or the previous window closed). false: it was folded into a count.
    mutating func offer(key: String, file: String, line: String, now: Date) -> Bool {
        if var e = entries[key], now.timeIntervalSince(e.first) < window {
            e.suppressed += 1
            e.last = now
            entries[key] = e
            return false
        }
        if entries.count >= maxEntries { entries.removeAll() }
        entries[key] = Entry(first: now, last: now, suppressed: 0, file: file, line: line)
        return true
    }

    /// Windows that have closed: entries that folded repeats are returned (to ship as one event), all are forgotten.
    mutating func closeExpired(now: Date) -> [Entry] {
        var out: [Entry] = []
        for (k, e) in entries where now.timeIntervalSince(e.first) >= window {
            if e.suppressed > 0 { out.append(e) }
            entries.removeValue(forKey: k)
        }
        return out.sorted { $0.first < $1.first }
    }
}

enum RecorderLogFilter {
    static let interestingRX = RX(#"(?i)(error|stop|fallback|exited|no durable growth|physical_fallback_required|micmode)"#)
    /// Crash-report stack frames ("14  room-recorder   0x000000010078b71d $s...Error...") match "error" by
    /// accident through mangled Swift symbol names; they are noise, the crash banner line is what matters.
    static let stackFrameRX = RX(#"^\s*\d+\s+\S+\s+0x[0-9a-fA-F]+\s"#)
    static func matches(_ line: String) -> Bool { !stackFrameRX.matches(line) && interestingRX.matches(line) }
}

final class RecorderLogCollector {
    private let ctx: Context
    private var limiter = RateLimiter()
    private var collapser = RepeatCollapser()
    /// Longest line that leaves the machine, in characters.
    static let maxLineChars = 300
    static let redaction = "keyword_only"
    private var lastStatusFingerprint: String?
    private var lastStatusEmit: Date?
    var statusRefresh: TimeInterval = 300
    /// Persisted read positions: {path: [inode, offset]} in the daemon's state file (state.json in the spool dir), written
    /// after every poll, so a daemon restart or a reboot continues where it stopped and never re-ships old lines.
    static let tailsKey = "recorder.tails"
    private var firstPollAt: Date?

    init(ctx: Context) { self.ctx = ctx }

    /// launchd.log plus tapewriter.log in the newest few capture sessions.
    func discoverLogs(recorderDir: String) -> [String] {
        let fm = FileManager.default
        var out: [String] = []
        let launchd = recorderDir + "/launchd.log"
        if fm.fileExists(atPath: launchd) { out.append(launchd) }
        let captures = recorderDir + "/captures"
        let sessions = ((try? fm.contentsOfDirectory(atPath: captures)) ?? [])
            .map { captures + "/" + $0 }
            .compactMap { p -> (String, Date)? in FS.mtime(p).map { (p, $0) } }
            .sorted { $0.1 > $1.1 }
            .prefix(5)
        for (s, _) in sessions {
            for seg in (try? fm.contentsOfDirectory(atPath: s)) ?? [] {
                let tw = s + "/" + seg + "/tapewriter.log"
                if fm.fileExists(atPath: tw) { out.append(tw) }
            }
        }
        return out
    }

    func poll() -> CollectorResult {
        var res = CollectorResult()
        guard let dir = ctx.recorderDir(), FileManager.default.fileExists(atPath: dir) else {
            res.notes.append("recorder dir not found (no console user or recorder not installed)")
            return res
        }
        let now = ctx.clock.now()
        // Files seen for the first time on the very first poll are history (tail -n 0). A file that first appears after
        // that and was created after the first poll is new, and is read from its start.
        let newFileSince = firstPollAt
        if firstPollAt == nil { firstPollAt = now }
        let collapsed = collapser.closeExpired(now: now)
        var tails = (ctx.state.get(Self.tailsKey) as? [String: [NSNumber]]) ?? [:]
        for path in discoverLogs(recorderDir: dir) {
            let pos = tails[path].flatMap { $0.count == 2 ? TailPos(inode: $0[0].uint64Value, offset: $0[1].uint64Value) : nil }
            guard let (lines, newPos) = Tail.read(path: path, pos: pos, newFileSince: newFileSince) else { continue }
            tails[path] = [NSNumber(value: newPos.inode), NSNumber(value: newPos.offset)]
            let rel = path.hasPrefix(dir + "/") ? String(path.dropFirst(dir.count + 1)) : path
            for l in lines where RecorderLogFilter.matches(l) {
                // Only keyword lines ship, personal possessives scrubbed, hard-cut at 300 characters.
                let shipped = String(AudioNames.scrubMessage(l).squashed.prefix(Self.maxLineChars))
                guard collapser.offer(key: RepeatCollapser.key(file: rel, line: shipped), file: rel, line: shipped, now: now) else { continue }
                guard limiter.allow(now: now) else { continue }
                res.events.append(DraftEvent("recorder.log", ["file": rel, "line": shipped, "count": 1,
                                                              "recv_ts": TimeFmt.iso(now), "redaction": Self.redaction]))
            }
        }
        for e in collapsed {
            res.events.append(DraftEvent("recorder.log", ["file": e.file, "line": e.line, "count": e.suppressed,
                                                          "collapsed_repeats": true, "first_ts": TimeFmt.iso(e.first),
                                                          "last_ts": TimeFmt.iso(e.last), "recv_ts": TimeFmt.iso(now),
                                                          "redaction": Self.redaction]))
        }
        // Forget tails for files that no longer exist so the state file cannot grow without bound.
        tails = tails.filter { FileManager.default.fileExists(atPath: $0.key) }
        ctx.state.set(Self.tailsKey, tails)
        let dropped = limiter.takeDropped()
        if dropped > 0 {
            res.events.append(DraftEvent("recorder.log", ["rate_limited": true, "dropped_lines": dropped, "recv_ts": TimeFmt.iso(now),
                                                          "redaction": Self.redaction]))
        }
        res.events.append(contentsOf: statusEvents(dir: dir))
        return res
    }

    /// mic_mode part of the fingerprint: JSON of the bounded dict (sorted keys, so no separator can be confused with a value)
    /// WITHOUT `at`: `at` stays in the payload but moving on its own never emits a new status. Only before/after/set do.
    static func micModeFingerprint(_ m: [String: String]?) -> String {
        guard var d = m else { return "no-mic-mode" }
        d.removeValue(forKey: "at")
        return J.string(d)
    }

    /// Fingerprint of the parts of status.json that matter. `updated_at` ticks constantly and the exact pending
    /// piece count fluctuates, so neither triggers an event on its own (only "pending > 0" does).
    static func statusFingerprint(_ st: RecorderStatus) -> String {
        [st.state ?? "-", st.sessionID ?? "-", (st.pendingPieces ?? 0) > 0 ? "pending" : "clear",
         st.otherKeys.joined(separator: ","), RecorderStatusParser.sessionOpen(st).rawValue, st.parseError ? "bad" : "ok",
         Self.micModeFingerprint(st.micMode)]
            .joined(separator: "|")
    }

    /// status.json: emit when the fingerprint changes, and at least every `statusRefresh` seconds.
    func statusEvents(dir: String, force: Bool = false) -> [DraftEvent] {
        guard let data = FileManager.default.contents(atPath: dir + "/status.json") else { return [] }
        let st = RecorderStatusParser.parse(data)
        let fp = Self.statusFingerprint(st)
        let now = ctx.clock.now()
        let due = lastStatusEmit.map { now.timeIntervalSince($0) >= statusRefresh } ?? true
        guard force || fp != lastStatusFingerprint || due else { return [] }
        lastStatusFingerprint = fp
        lastStatusEmit = now
        var p: Payload = [
            "state": jv(st.state), "session_id": jv(st.sessionID),
            "pending_piece_count": st.pendingPieces.map { $0 as Any } ?? NSNull(),
            "updated_at": jv(st.updatedAt), "other_keys": st.otherKeys,
            "session_open": RecorderStatusParser.sessionOpen(st).rawValue,
        ]
        if let mm = st.micMode { p["mic_mode"] = mm }   // absent (not null) when status.json has none
        if let m = FS.mtime(dir + "/status.json") { p["file_mtime"] = TimeFmt.iso(m) }
        return [DraftEvent("recorder.status", p)]
    }
}
