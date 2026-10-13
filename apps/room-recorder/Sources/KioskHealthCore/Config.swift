
import Foundation

struct Actions: Equatable {
    var darkwakeWatchdog = true
    var audioLadder = false
    var rebootRung = false
}

struct Config {
    /// Envelope `source`. The standalone daemon says "daemon"; the helper says "helper" (0.1.36).
    var source: String = "daemon"
    var machine: String
    var roomID: String? = nil
    var installID: String? = nil
    var sinkURL: String = "https://www.evenscribe.app/api/kiosk-health"
    var token: String? = nil
    var post: Bool = false
    var baseline: [String: String] = Config.defaultBaseline
    var actions = Actions()
    var consoleUser: String? = nil
    var recorderAppPath: String? = nil
    var spoolDir = "/var/db/eta-kiosk-health/spool"
    var logPath = "/var/log/eta-kiosk-health.log"
    var notes: [String] = []

    static let defaultBaseline: [String: String] = [
        "sleep": "0", "disksleep": "0", "displaysleep": "0",
        "SleepDisabled": "1", "autorestart": "1", "womp": "1", "caffeinate": "1",
    ]

    static let defaultPath = "/Library/Application Support/eta-kiosk-health/config.json"

    /// Every key the daemon reads. Anything else is ignored and named once in `notes`. In particular there is
    /// no way to move the 21:30-08:00 Asia/Kolkata window: a `ladder_window` key is just an unknown key.
    static let knownKeys: Set<String> = [
        "machine", "room_id", "install_id", "sink_url", "token", "post", "baseline", "actions",
        "console_user", "recorder_app_path", "spool_dir", "log_path",
    ]
    static let knownActionKeys: Set<String> = ["darkwake_watchdog", "audio_ladder", "reboot_rung"]

    static func defaultMachine() -> String {
        ProcessInfo.processInfo.hostName
    }

    /// Normalise baseline keys: "disablesleep" and "SleepDisabled" are the same setting.
    static func normalizeBaselineKey(_ k: String) -> String {
        k.lowercased() == "disablesleep" || k.lowercased() == "sleepdisabled" ? "SleepDisabled" : k
    }

    private static func stringify(_ v: Any) -> String? {
        if v is NSNull { return nil }
        if let n = v as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "1" : "0" }
            return "\(n)"
        }
        if let s = v as? String { return s }
        return nil
    }

    static func parse(_ obj: [String: Any]) -> Config {
        var c = Config(machine: (obj["machine"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? defaultMachine())
        c.roomID = obj["room_id"] as? String
        c.installID = obj["install_id"] as? String
        if let s = obj["sink_url"] as? String, !s.isEmpty { c.sinkURL = s }
        if let t = obj["token"] as? String, !t.isEmpty { c.token = t }
        if let p = obj["post"] as? Bool { c.post = p }
        if let b = obj["baseline"] as? [String: Any] {
            var merged = Config.defaultBaseline
            for (k, v) in b { if let s = stringify(v) { merged[normalizeBaselineKey(k)] = s } }
            c.baseline = merged
        }
        if let a = obj["actions"] as? [String: Any] {
            if let v = a["darkwake_watchdog"] as? Bool { c.actions.darkwakeWatchdog = v }
            if let v = a["audio_ladder"] as? Bool { c.actions.audioLadder = v }
            if let v = a["reboot_rung"] as? Bool { c.actions.rebootRung = v }
            let extra = a.keys.filter { !knownActionKeys.contains($0) }.sorted()
            if !extra.isEmpty { c.notes.append("ignored unknown config keys under actions: \(extra.joined(separator: ", "))") }
        }
        if let u = obj["console_user"] as? String, !u.isEmpty { c.consoleUser = u }
        if let p = obj["recorder_app_path"] as? String, !p.isEmpty { c.recorderAppPath = p }
        if let s = obj["spool_dir"] as? String, !s.isEmpty { c.spoolDir = s }
        if let s = obj["log_path"] as? String, !s.isEmpty { c.logPath = s }
        let unknown = obj.keys.filter { !knownKeys.contains($0) }.sorted()
        if !unknown.isEmpty {
            c.notes.append("ignored unknown config keys: \(unknown.joined(separator: ", "))"
                           + (unknown.contains("ladder_window") ? " (the night window is fixed at 21:30-08:00 Asia/Kolkata)" : ""))
        }
        return c
    }

    /// Load config; a missing/unreadable file yields defaults with a note (never an error, never post:true).
    static func load(path: String?) -> Config {
        let p = path ?? defaultPath
        guard let data = HardenedFile.readWhole(p, maxBytes: 1_048_576) else {
            var c = Config(machine: defaultMachine())
            c.notes.append("config not found at \(p); using defaults (post:false)")
            return c
        }
        guard let obj = J.parse(data: data) as? [String: Any] else {
            var c = Config(machine: defaultMachine())
            c.notes.append("config at \(p) is not valid JSON; using defaults (post:false)")
            return c
        }
        return parse(obj)
    }

    /// Safe-to-print summary: the token is never included, only whether one is set.
    func redactedSummary() -> Payload {
        [
            "machine": machine,
            "room_id": jv(roomID),
            "install_id": jv(installID),
            "sink_url": sinkURL,
            "post": post,
            "token_set": (token?.isEmpty == false),
            "actions": [
                "darkwake_watchdog": actions.darkwakeWatchdog,
                "audio_ladder": actions.audioLadder,
                "reboot_rung": actions.rebootRung,
            ],
            "console_user": jv(consoleUser),
            "night_window": "21:30-08:00 Asia/Kolkata (fixed)",
            "baseline": baseline,
            "notes": notes,
        ]
    }
}

/// `kiosk-health --check-config FILE`: what install.sh runs (with the binary it is about to install) before it
/// replaces anything. Uses Foundation's JSON parser, so it does not depend on what `plutil` can read on the host
/// (macOS 15.8's `plutil -p` cannot read JSON at all). The reason never contains a config value.
enum ConfigCheck {
    private static func isBool(_ v: Any) -> Bool { (v as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() } ?? false }
    private static func isStringOrNull(_ v: Any) -> Bool { v is String || v is NSNull }

    /// nil = valid, otherwise a one-line reason.
    static func check(_ data: Data) -> String? {
        guard let any = J.parse(data: data) else { return "not valid JSON" }
        guard let obj = any as? [String: Any] else { return "top level is not a JSON object" }
        if obj["ladder_window"] != nil { return "ladder_window is not a setting (the night window is fixed at 21:30-08:00 Asia/Kolkata); remove it" }
        for k in ["machine", "sink_url", "post", "actions"] where obj[k] == nil { return "required key missing: \(k)" }
        guard let machine = obj["machine"] as? String, !machine.isEmpty else { return "machine must be a non-empty string" }
        _ = machine
        guard let sink = obj["sink_url"] as? String, sink.hasPrefix("http://") || sink.hasPrefix("https://") else {
            return "sink_url must be an http(s) URL"
        }
        _ = sink
        guard isBool(obj["post"]!) else { return "post must be true or false" }
        for k in ["room_id", "install_id", "token", "console_user", "recorder_app_path", "spool_dir", "log_path"] {
            if let v = obj[k], !isStringOrNull(v) { return "\(k) must be a string or null" }
        }
        if let b = obj["baseline"], !(b is [String: Any]) { return "baseline must be an object" }
        guard let a = obj["actions"] as? [String: Any] else { return "actions must be an object" }
        for k in Config.knownActionKeys.sorted() {
            if let v = a[k], !isBool(v) { return "actions.\(k) must be true or false" }
        }
        if (a["reboot_rung"] as? Bool) == true && (a["audio_ladder"] as? Bool) != true {
            return "actions.reboot_rung requires actions.audio_ladder"
        }
        // F22: posting without a token can only produce 401s.
        if (obj["post"] as? Bool) == true, ((obj["token"] as? String) ?? "").isEmpty {
            return "post is true but token is missing or empty"
        }
        return nil
    }

    /// Exit status for the command line: 0 valid, 1 invalid or unreadable. Prints one line, never a value.
    static func run(path: String) -> Int32 {
        guard let data = FileManager.default.contents(atPath: path) else {
            print("invalid: cannot read \(path)")
            return 1
        }
        if let why = check(data) { print("invalid: \(why)"); return 1 }
        print("ok")
        return 0
    }
}
