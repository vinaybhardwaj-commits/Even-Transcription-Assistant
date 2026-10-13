import Foundation

struct AssertionHolder {
    var pid: Int
    var process: String
    var id: String
    var heldSeconds: Int
    var type: String
    var name: String
    var details: [String] = []
}

struct KernelAssertion {
    var owner: String
    var kind: String
}

struct AssertionsSnapshot {
    var systemWide: [String: Int] = [:]
    var holders: [AssertionHolder] = []
    var kernel: [KernelAssertion] = []

    static let sleepTypes: Set<String> = [
        "PreventUserIdleSystemSleep", "PreventSystemSleep", "PreventUserIdleDisplaySleep", "PreventDiskIdle",
        "NoIdleSleepAssertion", "NoDisplaySleepAssertion", "InternalPreventSleep", "InternalPreventDisplaySleep",
    ]
    /// Processes whose assertion *names* are safe to ship (system components). Names from any other process
    /// can embed document or window titles, so they are redacted.
    static let nameAllowlist: Set<String> = [
        "caffeinate", "powerd", "coreaudiod", "WindowServer", "cupsd", "mds_stores", "Google Chrome",
        "EvenScribe Room Recorder", "room-recorder", "kiosk-health", "bluetoothd", "sharingd", "backupd",
        "apsd", "softwareupdated", "mediaremoted", "NotificationCenter", "studentd", "kernel_task",
    ]

    var sleepPreventers: [AssertionHolder] { holders.filter { Self.sleepTypes.contains($0.type) } }
    var caffeinatePIDs: [Int] { holders.filter { $0.process == "caffeinate" }.map { $0.pid } }

    /// Product names of HID devices named in UserIsActive assertions, newest (shortest-held) first.
    var userIsActiveProducts: [String] {
        holders.filter { $0.type == "UserIsActive" }
            .sorted { $0.heldSeconds < $1.heldSeconds }
            .compactMap { AssertionsParser.productRX.match($0.name)?[1].trimmed }
            .map { AudioNames.sanitize($0) }
    }

    /// Stable fingerprint over sleep-relevant holders only; ignores durations and digits in names
    /// (coreaudiod context numbers) so it changes only when the holder set really changes.
    var digest: String {
        sleepPreventers
            .map { "\($0.process)|\($0.type)|\(AssertionsParser.digitsRX.replace($0.name, with: "#"))" }
            .sorted().joined(separator: "\n")
    }

    func payload() -> Payload {
        let holders: [Payload] = self.holders.map { h in
            var p: Payload = ["pid": h.pid, "process": h.process, "type": h.type, "held_s": h.heldSeconds]
            if Self.nameAllowlist.contains(h.process) { p["name"] = AudioNames.sanitize(h.name).truncated(120) } else { p["name_redacted"] = true }
            return p
        }
        let preventers: [Payload] = sleepPreventers.map { ["pid": $0.pid, "process": $0.process, "type": $0.type] }
        let caf: Payload = ["present": !caffeinatePIDs.isEmpty, "pids": caffeinatePIDs]
        let kern: [Payload] = kernel.map { ["owner": AudioNames.sanitize($0.owner), "kind": $0.kind] }
        return [
            "system_wide": systemWide,
            "holders": holders,
            "sleep_preventers": preventers,
            "caffeinate": caf,
            "user_is_active_products": userIsActiveProducts,
            "kernel": kern,
        ]
    }
}

enum AssertionsParser {
    static let holderRX = RX(#"^\s+pid (\d+)\((.*?)\): \[(0x[0-9a-fA-F]+)\] (\d+:\d+(?::\d+)?) (\w+) named: "(.*)"\s*$"#)
    static let systemRX = RX(#"^\s+(\w+)\s+(\d+)\s*$"#)
    static let kernelRX = RX(#"^\s+id=(\d+)\s+level=(\d+)\s+(\S+)\s.*?owner=(.*?)\s*$"#)
    static let productRX = RX(#"product:(.+?) eventType"#)
    static let digitsRX = RX(#"\d+"#)

    static func parse(_ text: String) -> AssertionsSnapshot {
        var snap = AssertionsSnapshot()
        enum Section { case none, system, process, kernel }
        var section = Section.none
        text.enumerateLines { line, _ in
            if line.hasPrefix("Assertion status system-wide") { section = .system; return }
            if line.hasPrefix("Listed by owning process") { section = .process; return }
            if line.hasPrefix("Kernel Assertions") { section = .kernel; return }
            switch section {
            case .system:
                if let g = systemRX.match(line), let v = Int(g[2]) { snap.systemWide[g[1]] = v }
            case .process:
                if let g = holderRX.match(line) {
                    snap.holders.append(AssertionHolder(pid: Int(g[1]) ?? 0, process: g[2], id: g[3],
                                                        heldSeconds: parseDurationHMS(g[4]) ?? 0, type: g[5], name: g[6]))
                } else if !snap.holders.isEmpty, line.hasPrefix("\t") {
                    snap.holders[snap.holders.count - 1].details.append(line.trimmed)
                }
            case .kernel:
                if let g = kernelRX.match(line) { snap.kernel.append(KernelAssertion(owner: g[4], kind: g[3])) }
            case .none:
                break
            }
        }
        return snap
    }
}

final class AssertionsCollector {
    private let ctx: Context
    private(set) var last: AssertionsSnapshot?
    private var lastEmittedDigest: String?
    private var lastEmit: Date = .distantPast
    var periodic: TimeInterval = 600
    var minChangeGap: TimeInterval = 60

    init(ctx: Context) { self.ctx = ctx }

    /// Cheap read used by the HID collector to name the device behind a UserIsActive assertion.
    func refresh() -> AssertionsSnapshot? {
        let r = ctx.runner.run(Tool.pmset, ["-g", "assertions"], timeout: 20)
        guard r.ok else { return nil }
        let s = AssertionsParser.parse(r.stdout)
        last = s
        return s
    }

    func poll(force: Bool = false) -> CollectorResult {
        var res = CollectorResult()
        guard let snap = refresh() else {
            res.degraded = true
            res.notes.append("pmset -g assertions failed")
            return res
        }
        let now = ctx.clock.now()
        let gap = now.timeIntervalSince(lastEmit)
        var trigger: String?
        if lastEmittedDigest == nil { trigger = "first" }
        else if force { trigger = "forced" }
        else if snap.digest != lastEmittedDigest && gap >= minChangeGap { trigger = "change" }
        else if gap >= periodic { trigger = "periodic" }
        if let t = trigger {
            lastEmit = now
            lastEmittedDigest = snap.digest
            var p = snap.payload()
            p["trigger"] = t
            res.events.append(DraftEvent("assert.snapshot", p))
        }
        return res
    }
}
