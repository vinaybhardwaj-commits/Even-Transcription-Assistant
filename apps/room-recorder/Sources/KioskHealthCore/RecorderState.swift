import Foundation

enum SessionOpen: String {
    case yes, no, unknown
}

struct RecorderStatus {
    var present = false
    var parseError = false
    var state: String?
    var sessionID: String?
    var pendingPieces: Int?
    var updatedAt: String?
    /// Room Recorder 0.1.26 MicModeGuard: status.json "mic_mode" {before, after, set, at}, bounded (see RecorderStatusParser.micMode).
    /// nil when status.json has no usable mic_mode: the event then carries no mic_mode key at all.
    var micMode: [String: String]?
    var otherKeys: [String] = []
}

enum RecorderStatusParser {
    static let knownKeys: Set<String> = ["state", "session_id", "pending_piece_count", "updated_at", "mic_mode"]
    /// The only keys of mic_mode that ever leave the machine, and the longest string for any of them.
    static let micModeKeys: [String] = ["before", "after", "set", "at"]
    static let micModeMaxChars = 64
    static let closedStates: Set<String> = ["idle", "ready", "stopped", "closed", "ended", "none", "inactive"]

    /// status.json shape seen on a live kiosk: {pending_piece_count, session_id, state, updated_at}.
    /// Only those four fields are ever reported; any other key is listed by name only (never its value).
    static func parse(_ data: Data?) -> RecorderStatus {
        guard let data = data else { return RecorderStatus() }
        var s = RecorderStatus(present: true)
        guard let obj = J.parse(data: data) as? [String: Any] else { s.parseError = true; return s }
        s.state = obj["state"] as? String
        s.sessionID = obj["session_id"] as? String
        s.pendingPieces = (obj["pending_piece_count"] as? NSNumber)?.intValue
        s.updatedAt = obj["updated_at"] as? String
        s.micMode = micMode(obj["mic_mode"])
        s.otherKeys = obj.keys.filter { !knownKeys.contains($0) }.sorted()
        return s
    }

    /// mic_mode, bounded: it must be a JSON object; only the known keys are kept. A value may be a string or a number (macOS
    /// stores the mic mode as an integer, e.g. 2 = Voice Isolation, 0 = Standard, and `at` may be an epoch): numbers are turned
    /// into strings ("2", "0", "1728360000.5"). Booleans, null, arrays and objects are dropped. Every string is cleaned (NUL and
    /// lone surrogates stripped) and cut at 64 UTF-16 units like every other wire string. Anything else (not an object, no known
    /// key with a usable value) is treated as absent, never as an error: a recorder that writes something unexpected must not
    /// break the status event.
    static func micMode(_ raw: Any?) -> [String: String]? {
        guard let d = raw as? [String: Any] else { return nil }
        var out: [String: String] = [:]
        for k in micModeKeys {
            if let text = micModeText(d[k]) { out[k] = SinkGuard.cap(text, micModeMaxChars) }
        }
        return out.isEmpty ? nil : out
    }

    private static func micModeText(_ v: Any?) -> String? {
        if let s = v as? String { return s }
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        if CFNumberIsFloatType(n) {
            let x = n.doubleValue
            guard x.isFinite else { return nil }
            if x == x.rounded(), abs(x) < 1e15 { return String(Int64(x)) }   // 2.0 -> "2", like the integer 2
            return "\(x)"
        }
        return String(n.int64Value)
    }

    /// Fail closed: only an explicit closed state is "no session". An absent or unreadable status.json is
    /// "unknown", and unknown is treated as open by every action gate.
    static func sessionOpen(_ s: RecorderStatus) -> SessionOpen {
        guard s.present else { return .unknown }
        guard !s.parseError, let st = s.state?.lowercased() else { return .unknown }
        return closedStates.contains(st) ? .no : .yes
    }
}

struct RecorderSnapshot {
    var status: RecorderStatus
    var open: SessionOpen
    var newestTapeMTime: Date?
    var newestTapeFile: String?
    var recorderDirFound: Bool

    func payload() -> Payload {
        [
            "recorder_dir_found": recorderDirFound,
            "status_present": status.present,
            "state": jv(status.state),
            "session_id": jv(status.sessionID),
            "pending_piece_count": status.pendingPieces.map { $0 as Any } ?? NSNull(),
            "updated_at": jv(status.updatedAt),
            "other_keys": status.otherKeys,
            "session_open": open.rawValue,
            "newest_tape_mtime": newestTapeMTime.map { TimeFmt.iso($0) as Any } ?? NSNull(),
        ]
    }
}

enum RecorderState {
    /// Newest mtime among the files of the newest capture segment (tape.pcm / tape.idx / tapewriter.log).
    static func newestTape(recorderDir: String) -> (Date, String)? {
        let fm = FileManager.default
        let captures = recorderDir + "/captures"
        guard let sessions = try? fm.contentsOfDirectory(atPath: captures) else { return nil }
        let dirs = sessions.map { captures + "/" + $0 }
            .compactMap { p -> (String, Date)? in FS.mtime(p).map { (p, $0) } }
            .sorted { $0.1 > $1.1 }
        for (sessionDir, _) in dirs.prefix(3) {
            var best: (Date, String)?
            for seg in (try? fm.contentsOfDirectory(atPath: sessionDir)) ?? [] {
                let segDir = sessionDir + "/" + seg
                for f in (try? fm.contentsOfDirectory(atPath: segDir)) ?? [] {
                    let path = segDir + "/" + f
                    if let m = FS.mtime(path), best == nil || m > best!.0 { best = (m, f) }
                }
            }
            if let b = best { return b }
        }
        return nil
    }

    /// A tape chunk written this recently means a session is open whatever status.json says.
    static let tapeFreshSeconds: TimeInterval = 120

    /// The session gate. It fails CLOSED: no console user, a missing recorder folder, or an absent/unreadable
    /// status.json all read as `.unknown` (treated as open by every action), and a tape file modified within the
    /// last 120 s reads as `.yes` even when status.json claims the recorder is idle.
    static func read(_ ctx: Context) -> RecorderSnapshot {
        guard let dir = ctx.recorderDir(), FileManager.default.fileExists(atPath: dir) else {
            return RecorderSnapshot(status: RecorderStatus(), open: .unknown, newestTapeMTime: nil, newestTapeFile: nil, recorderDirFound: false)
        }
        let status = RecorderStatusParser.parse(FileManager.default.contents(atPath: dir + "/status.json"))
        let tape = newestTape(recorderDir: dir)
        var open = RecorderStatusParser.sessionOpen(status)
        if let t = tape?.0, ctx.clock.now().timeIntervalSince(t) < tapeFreshSeconds { open = .yes }
        return RecorderSnapshot(status: status, open: open,
                                newestTapeMTime: tape?.0, newestTapeFile: tape?.1, recorderDirFound: true)
    }
}
