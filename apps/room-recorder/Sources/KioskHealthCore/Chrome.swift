import Foundation

/// What the Pulse Presence extension needs from Chrome, read without touching anything private.
///
/// Reads, for the console user only: two keys of Chrome's `Local State` (`profile.last_used` and
/// `profile.last_active_profiles`, through `plutil -extract`, which works on macOS 15.8 where `plutil -p` cannot read
/// JSON), the NAMES in `<profile>/Extensions/<extension id>/`, and `pgrep`. Never Preferences, Secure Preferences,
/// Cookies, Login Data or any other key or file. No CoreGraphics, no Apple events, nothing that triggers TCC.
struct ChromeSample: Equatable {
    var running: Bool
    var lastUsed: String?
    var active: [String]
    var ext: [String: [String]]   // profile dir -> installed version dir names (sorted)
    /// R11b: local evidence that the extension's service worker is alive. Newest mtime (stat only, no file is opened or read)
    /// under <profile>/Local Extension Settings/<extension id>/. The extension writes chrome.storage.local on every run,
    /// including its 30 s heartbeat alarm, so this moves about every 30 s while it works.
    var workerDirFound = false
    var workerAgeS: Int? = nil
    var workerScope = "active"      // "active": the active profile(s); "all_profiles": no active profile known, newest across profiles
    var hidIdleS: Double? = nil
    static let consoleActiveBelowS = 120.0
    static let workerFreshWithinS = 600
    /// The console counts as active when HID idle is known and under 120 s. Unknown idle never makes a verdict worse.
    var consoleActive: Bool { (hidIdleS.map { $0 < Self.consoleActiveBelowS }) ?? false }

    var guest: Bool { lastUsed == ChromeProbe.guestProfile || active.contains(ChromeProbe.guestProfile) }

    /// nil when presence is fine, otherwise the first reason: not_running | guest | no_profile | ext_missing:<profile> |
    /// ext_dir_missing | ext_worker_stale. The last two apply only while the console is active (HID idle < 120 s):
    /// the worker's storage dir must exist and have been written within the last 10 minutes.
    var failure: String? {
        if !running { return "not_running" }
        if guest { return "guest" }
        if active.isEmpty { return "no_profile" }
        for p in active where (ext[p] ?? []).isEmpty { return "ext_missing:\(p)" }
        if consoleActive {
            if !workerDirFound { return "ext_dir_missing" }
            if let a = workerAgeS, a > Self.workerFreshWithinS { return "ext_worker_stale" }
        }
        return nil
    }

    var presenceOK: Bool { failure == nil }

    func payload() -> Payload {
        var e: [String: Any] = [:]
        for (k, v) in ext { e[k] = v }
        return [
            "running": running,
            "last_used": jv(lastUsed),
            "active": active,
            "guest": guest,
            "ext": e,
            "ext_worker_mtime_age_s": workerAgeS.map { $0 as Any } ?? NSNull(),
            "ext_worker_scope": workerScope,
            "hid_idle_s": hidIdleS.map { Int($0) as Any } ?? NSNull(),
            "console_active": consoleActive,
            "presence_ok": presenceOK,
        ]
    }
}

enum ChromeProbe {
    static let guestProfile = "Guest Profile"
    static let extensionID = "choegfgddhpljibnolbcljnlfhfpimbh"
    static let workerStorageDir = "Local Extension Settings"
    static let userDataSuffix = "/Library/Application Support/Google/Chrome"

    /// A profile directory name is one path component; anything else is ignored rather than followed.
    static func safeProfile(_ s: String) -> Bool {
        !s.isEmpty && s != "." && s != ".." && !s.contains("/") && !s.contains("\0")
    }

    /// `plutil -extract` prints JSON null (and a missing key's absence) as an empty, `<null>` or `(null)` value.
    static func isNullText(_ s: String) -> Bool { s.isEmpty || s == "null" || s == "<null>" || s == "(null)" }

    static func parseActive(_ json: String) -> [String] {
        guard let arr = J.parse(json) as? [Any] else { return [] }
        var out: [String] = []
        for case let s as String in arr where safeProfile(s) && !out.contains(s) { out.append(s) }
        return out
    }
}

final class ChromeCollector {
    private let ctx: Context
    private var lastOK: Bool?
    private var falseStreak = 0
    private var lastSig: String?
    private var lastEmit: Date?
    static let emitInterval: TimeInterval = 5 * 60

    /// Seconds of HID idle time (ioreg), injected by the daemon; nil = unknown.
    var hidIdle: () -> Double? = { nil }

    init(ctx: Context) { self.ctx = ctx }

    /// Chrome running for the console user: 0 = yes, 1 = no, anything else (launch failure, timeout) = unknown.
    private func chromeRunning(user: String) -> Bool? {
        let r = ctx.runner.run(Tool.pgrep, ["-x", "-u", user, "Google Chrome"], timeout: 5)
        if r.launchError != nil || r.timedOut { return nil }
        if r.status == 0 { return true }
        if r.status == 1 { return false }
        return nil
    }

    private func versions(io: UserIO, dataDir: String, profile: String) -> [String] {
        let dir = "\(dataDir)/\(profile)/Extensions/\(ChromeProbe.extensionID)"
        var out: [String] = []
        for n in io.entries(dir) ?? [] where !n.hasPrefix(".") {
            if io.isDirectory("\(dir)/\(n)") { out.append(n) }
        }
        return out.sorted()
    }

    /// Newest mtime of <profile>/Local Extension Settings/<id>/ and of the entries listed in it. Listing and lstat only, as the
    /// room user: no file is opened, no content is read, and nothing else in the profile is touched.
    private func workerMtime(io: UserIO, dataDir: String, profile: String) -> Date? {
        let dir = "\(dataDir)/\(profile)/\(ChromeProbe.workerStorageDir)/\(ChromeProbe.extensionID)"
        guard let top = io.info(dir), top.isDirectory else { return nil }
        var newest = top.mtime
        for n in io.entries(dir) ?? [] {
            if let m = io.mtime("\(dir)/\(n)"), m > newest { newest = m }
        }
        return newest
    }

    /// Profile directories present in the Chrome user-data dir (names only), for the case where no active profile is known.
    private func allProfileDirs(io: UserIO, dataDir: String) -> [String] {
        (io.entries(dataDir) ?? [])
            .filter { $0 == "Default" || $0.hasPrefix("Profile ") }
            .filter { ChromeProbe.safeProfile($0) }
            .sorted()
    }

    /// Local State is big, but only two keys of it are used. It is read as the room user (plain file, one link, 4 MiB at most)
    /// and parsed here; no tool runs on it.
    static let localStateMaxBytes = 4 * 1024 * 1024

    static func localStateKeys(_ data: Data) -> (lastUsed: String?, active: [String])? {
        guard let root = J.parse(data: data) as? [String: Any] else { return nil }
        guard let profile = root["profile"] as? [String: Any] else { return (nil, []) }
        var lastUsed: String?
        if let s = profile["last_used"] as? String, !ChromeProbe.isNullText(s) { lastUsed = s }
        var active: [String] = []
        if let arr = profile["last_active_profiles"] as? [Any] {
            for case let s as String in arr where ChromeProbe.safeProfile(s) && !active.contains(s) { active.append(s) }
        }
        return (lastUsed, active)
    }

    /// One reading, or nil (with a note) if it could not be taken: no console user, or pgrep failed.
    func sample() -> (ChromeSample?, [String]) {
        guard let io = ctx.userIO(), let home = ctx.consoleHome() else { return (nil, ["chrome: no console user"]) }
        guard let running = chromeRunning(user: io.user) else { return (nil, ["chrome: pgrep did not answer; sample skipped"]) }
        let dataDir = home + ChromeProbe.userDataSuffix
        let state = dataDir + "/Local State"
        var notes: [String] = []
        var lastUsed: String?
        var active: [String] = []
        if io.info(state) != nil {
            if let data = io.readWhole(state, maxBytes: Self.localStateMaxBytes), let keys = Self.localStateKeys(data) {
                lastUsed = keys.lastUsed
                active = keys.active
            } else {
                notes.append("chrome: Local State could not be read (not a plain file, too large or not JSON)")
            }
        } else {
            notes.append("chrome: Local State not found")
        }
        if active.isEmpty, let l = lastUsed, ChromeProbe.safeProfile(l) { active = [l] }
        var ext: [String: [String]] = [:]
        for p in active { ext[p] = versions(io: io, dataDir: dataDir, profile: p) }
        var sample = ChromeSample(running: running, lastUsed: lastUsed, active: active, ext: ext)
        // the worker evidence: the active profile(s); if none is known, the newest across every profile (and the payload says so)
        let scoped = active.isEmpty ? allProfileDirs(io: io, dataDir: dataDir) : active
        sample.workerScope = active.isEmpty ? "all_profiles" : "active"
        let newest = scoped.compactMap { workerMtime(io: io, dataDir: dataDir, profile: $0) }.max()
        if let m = newest {
            sample.workerDirFound = true
            sample.workerAgeS = max(0, Int(ctx.clock.now().timeIntervalSince(m)))
        }
        sample.hidIdleS = hidIdle()
        return (sample, notes)
    }

    /// Called every minute. `chrome.profile` goes out on any change and at least every 5 minutes; `chrome.alert`
    /// when presence_ok goes true -> false, or when it has been false for two samples in a row (a daemon that starts
    /// while presence is already broken).
    func poll() -> CollectorResult {
        var res = CollectorResult()
        let (maybe, notes) = sample()
        res.notes = notes
        guard let s = maybe else { return res }
        let now = ctx.clock.now()
        let p = s.payload()
        // the change signature leaves out the two readings that move every sample (age, HID idle seconds): a change is a change in
        // state (running, profile, extension, console_active, presence_ok), not the clock ticking
        var stable = p
        stable.removeValue(forKey: "ext_worker_mtime_age_s")
        stable.removeValue(forKey: "hid_idle_s")
        let sig = J.string(stable)
        if sig != lastSig || lastEmit.map({ now.timeIntervalSince($0) >= Self.emitInterval }) ?? true {
            res.events.append(DraftEvent("chrome.profile", p))
            lastSig = sig
            lastEmit = now
        }
        if s.presenceOK {
            falseStreak = 0
        } else {
            falseStreak += 1
            if lastOK == true || falseStreak == 2, let reason = s.failure {
                var a = p
                a["reason"] = reason
                res.events.append(DraftEvent("chrome.alert", a))
            }
        }
        lastOK = s.presenceOK
        return res
    }
}
