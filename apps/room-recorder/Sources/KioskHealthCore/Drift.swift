import Foundation

struct DriftItem: Equatable {
    var field: String
    var expected: String
    var actual: String
    func payload() -> Payload { ["field": field, "expected": expected, "actual": actual] }
}

/// Everything the drift check observed about the machine (separated from collection so it can be unit tested).
struct DriftState {
    var pmsetCustom: [String: String] = [:]        // first profile of `pmset -g custom` (AC Power on a mini)
    var pmsetLive: [String: String] = [:]          // `pmset -g` (live + system-wide, incl. SleepDisabled)
    var autologinUser: String? = nil
    var recorderVersion: String? = nil
    var recorderAppFound = false
    var chromeForcelist: [String]? = nil           // nil = policy file/key absent
    var caffeinatePresent = false
}

enum PmsetSettings {
    static let lineRX = RX(#"^\s+(.+?)\s+(-?\d+)\s*$"#)
    static let profileRX = RX(#"^(.+):\s*$"#)

    /// `pmset -g custom` -> [profile: [key: value]]
    static func parseCustom(_ text: String) -> [String: [String: String]] {
        var profiles: [String: [String: String]] = [:]
        var current: String?
        text.enumerateLines { line, _ in
            if !line.hasPrefix(" "), let g = profileRX.match(line) {
                current = g[1].trimmed
                profiles[current!] = [:]
                return
            }
            if let c = current, let g = lineRX.match(line) { profiles[c]?[g[1].trimmed] = g[2] }
        }
        return profiles
    }

    /// `pmset -g` -> flat [key: value] (system-wide section and "Currently in use" section).
    static func parseLive(_ text: String) -> [String: String] {
        var out: [String: String] = [:]
        text.enumerateLines { line, _ in
            if let g = lineRX.match(line) { out[g[1].trimmed] = g[2] }
        }
        return out
    }

    /// Resolve a baseline key against the observed settings. Returns nil when the setting is not reported.
    static func actual(_ key: String, state: DriftState) -> String? {
        if key == "SleepDisabled" {
            return state.pmsetLive["SleepDisabled"] ?? state.pmsetCustom["SleepDisabled"] ?? state.pmsetCustom["disablesleep"]
        }
        return state.pmsetCustom[key] ?? state.pmsetLive[key]
    }
}

enum ChromePolicy {
    /// ExtensionInstallForcelist from a managed-preferences plist; nil if the key is missing.
    static func forcelist(plistData: Data) -> [String]? {
        guard let obj = try? PropertyListSerialization.propertyList(from: plistData, options: [], format: nil) as? [String: Any],
              let list = obj["ExtensionInstallForcelist"] as? [String] else { return nil }
        return list
    }
}

enum Drift {
    static let pmsetKeys = ["sleep", "disksleep", "displaysleep", "SleepDisabled", "autorestart", "womp"]

    /// Compare baseline with observed state. Report only; the daemon never fixes drift.
    static func compare(baseline: [String: String], state: DriftState, consoleUser: String?) -> [DriftItem] {
        var items: [DriftItem] = []
        for key in pmsetKeys {
            guard let expected = baseline[key] else { continue }
            let actual = PmsetSettings.actual(key, state: state) ?? "absent"
            if actual != expected { items.append(DriftItem(field: "pmset.\(key)", expected: expected, actual: actual)) }
        }
        if let expected = baseline["autologin_user"] ?? consoleUser {
            let actual = state.autologinUser ?? "absent"
            if actual != expected { items.append(DriftItem(field: "autologin_user", expected: expected, actual: actual)) }
        }
        if let expected = baseline["recorder_app_version"] {
            let actual = state.recorderVersion ?? (state.recorderAppFound ? "unknown" : "absent")
            if actual != expected { items.append(DriftItem(field: "recorder_app_version", expected: expected, actual: actual)) }
        }
        if baseline["chrome_forcelist"] != "skip" {
            let n = state.chromeForcelist?.count ?? -1
            let actual = n < 0 ? "absent" : (n == 0 ? "empty" : "present(\(n))")
            if let want = baseline["chrome_forcelist_contains"] {
                let has = state.chromeForcelist?.contains(where: { $0.contains(want) }) ?? false
                if !has { items.append(DriftItem(field: "chrome_forcelist", expected: "contains \(want)", actual: actual)) }
            } else if n <= 0 {
                items.append(DriftItem(field: "chrome_forcelist", expected: "present(non-empty)", actual: actual))
            }
        }
        if let expected = baseline["caffeinate"] {
            let actual = state.caffeinatePresent ? "1" : "0"
            if actual != expected { items.append(DriftItem(field: "caffeinate", expected: expected, actual: actual)) }
        }
        return items
    }
}

final class DriftCollector {
    private let ctx: Context
    /// The drift set as of the previous check; nil until the first one.
    private var last: [String: DriftItem]?
    /// What the recorder app's Info.plist said when somebody was last logged in to read it as.
    private var lastApp: (found: Bool, version: String?)?
    static let summaryDateKey = "drift.summary_date"
    static let summaryMinute = 9 * 60   // 09:00 IST
    init(ctx: Context) { self.ctx = ctx }

    func candidateAppPaths() -> [String] {
        var c: [String] = []
        if let p = ctx.config.recorderAppPath { c.append(p) }
        if let h = ctx.consoleHome() { c.append(h + "/Applications/EvenScribe Room Recorder.app") }
        c.append("/Applications/EvenScribe Room Recorder.app")
        return c
    }

    func observe() -> (state: DriftState, notes: [String]) {
        var st = DriftState()
        var notes: [String] = []

        let custom = ctx.runner.run(Tool.pmset, ["-g", "custom"], timeout: 30)
        if custom.ok {
            let profiles = PmsetSettings.parseCustom(custom.stdout)
            st.pmsetCustom = profiles["AC Power"] ?? profiles.values.first ?? [:]
        } else { notes.append("pmset -g custom: \(custom.failureNote)") }
        let live = ctx.runner.run(Tool.pmset, ["-g"], timeout: 30)
        if live.ok { st.pmsetLive = PmsetSettings.parseLive(live.stdout) } else { notes.append("pmset -g: \(live.failureNote)") }

        let al = ctx.runner.run(Tool.defaults, ["read", "/Library/Preferences/com.apple.loginwindow", "autoLoginUser"], timeout: 5)
        if al.ok { st.autologinUser = al.stdout.trimmed }

        // The bundle is user-owned since 0.1.33, so its Info.plist is read as the room user (plain file, one link, 256 KB).
        // With nobody logged in there is no user to read as: the last answer stands, and nothing is read as root.
        if let io = ctx.userIO() {
            lastApp = (false, nil)
            for path in candidateAppPaths() {
                if let data = io.readWhole(path + "/Contents/Info.plist", maxBytes: 262_144) {
                    var version: String?
                    if let obj = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any] {
                        version = obj["CFBundleShortVersionString"] as? String
                    }
                    lastApp = (true, version)
                    break
                }
            }
        } else {
            notes.append("recorder app not read: no console user")
        }
        if let app = lastApp { st.recorderAppFound = app.found; st.recorderVersion = app.version }

        var policyPaths = ["/Library/Managed Preferences/com.google.Chrome.plist"]
        if let u = ctx.consoleUser() { policyPaths.append("/Library/Managed Preferences/\(u)/com.google.Chrome.plist") }
        for path in policyPaths {
            if let data = FileManager.default.contents(atPath: path) {
                st.chromeForcelist = ChromePolicy.forcelist(plistData: data)
                break
            }
        }

        let pg = ctx.runner.run(Tool.pgrep, ["-x", "caffeinate"], timeout: 5)
        st.caffeinatePresent = pg.ok   // pgrep exits 1 when nothing matches
        return (st, notes)
    }

    /// Drift events only on change (a field newly drifting, changing its value, or resolving; everything on the
    /// first check), plus one `drift.summary` per IST day from 09:00.
    func poll() -> CollectorResult {
        var res = CollectorResult()
        let (state, notes) = observe()
        res.notes = notes
        let drifts = Drift.compare(baseline: ctx.config.baseline, state: state, consoleUser: ctx.consoleUser())
        var cur: [String: DriftItem] = [:]
        for d in drifts { cur[d.field] = d }
        for d in drifts {
            var p = d.payload()
            if let prev = last {
                if prev[d.field] == d { continue }
                p["change"] = prev[d.field] == nil ? "new" : "changed"
            } else {
                p["change"] = "initial"
            }
            res.events.append(DraftEvent("drift", p))
        }
        if let prev = last {
            for (f, was) in prev.sorted(by: { $0.key < $1.key }) where cur[f] == nil {
                res.events.append(DraftEvent("drift", ["field": f, "expected": was.expected, "actual": was.expected,
                                                       "was": was.actual, "change": "resolved", "resolved": true]))
            }
        }
        last = cur
        if let s = summaryIfDue(drifts) { res.events.append(s) }
        return res
    }

    /// One summary per IST calendar day, from 09:00 on; the date is persisted so a restart cannot repeat it.
    func summaryIfDue(_ drifts: [DriftItem]) -> DraftEvent? {
        let now = ctx.clock.now()
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = LadderPolicy.timeZone
        let c = cal.dateComponents([.year, .month, .day, .hour, .minute], from: now)
        guard (c.hour ?? 0) * 60 + (c.minute ?? 0) >= Self.summaryMinute else { return nil }
        let today = String(format: "%04d-%02d-%02d", c.year ?? 1970, c.month ?? 1, c.day ?? 1)
        if (ctx.state.get(Self.summaryDateKey) as? String) == today { return nil }
        ctx.state.set(Self.summaryDateKey, today)
        return DraftEvent("drift.summary", ["date": today, "tz": "Asia/Kolkata", "drift_count": drifts.count,
                                            "items": drifts.map { $0.payload() }])
    }

    /// Full observed state for --once output, alongside the drift verdicts.
    func snapshot() -> (observed: Payload, result: CollectorResult) {
        var res = CollectorResult()
        let (state, notes) = observe()
        res.notes = notes
        let drifts = Drift.compare(baseline: ctx.config.baseline, state: state, consoleUser: ctx.consoleUser())
        res.events = drifts.map { DraftEvent("drift", $0.payload()) }
        let observed: Payload = [
            "pmset_custom": state.pmsetCustom,
            "pmset_sleep_disabled": jv(PmsetSettings.actual("SleepDisabled", state: state)),
            "autologin_user": jv(state.autologinUser),
            "recorder_app_found": state.recorderAppFound,
            "recorder_app_version": jv(state.recorderVersion),
            "chrome_forcelist_count": state.chromeForcelist.map { $0.count as Any } ?? NSNull(),
            "caffeinate_present": state.caffeinatePresent,
            "baseline": ctx.config.baseline,
            "drift_count": drifts.count,
        ]
        return (observed, res)
    }
}
