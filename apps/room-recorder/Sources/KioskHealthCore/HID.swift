import Foundation

struct HIDActivity: Equatable {
    var idleBeforeS: Double
    var idleNowS: Double
}

/// Detects "idle time reset" (= input happened) between two samples of HIDIdleTime.
/// `monotonic` must be a clock that does not advance during system sleep (ProcessInfo.systemUptime),
/// because HIDIdleTime does not advance while asleep either.
struct HIDTracker {
    private var prevIdle: Double?
    private var prevAt: TimeInterval?
    var tolerance: Double = 2.0

    mutating func update(idleNow: Double, monotonic: TimeInterval) -> HIDActivity? {
        defer { prevIdle = idleNow; prevAt = monotonic }
        guard let p = prevIdle, let pa = prevAt else { return nil }
        let elapsed = monotonic - pa
        guard elapsed > 0 else { return nil }
        // With no input, idle must have grown by `elapsed`; anything noticeably less means a reset.
        guard idleNow < p + elapsed - tolerance else { return nil }
        let before = max(0, p + elapsed - idleNow)   // idle duration immediately before the input arrived
        return HIDActivity(idleBeforeS: before, idleNowS: idleNow)
    }
}

enum HIDParser {
    static let idleRX = RX(#""HIDIdleTime"\s*=\s*(\d+)"#)

    /// Seconds of HID idle time from `ioreg -c IOHIDSystem` output (value is in nanoseconds).
    static func idleSeconds(_ ioregOutput: String) -> Double? {
        guard let g = idleRX.match(ioregOutput), let ns = Double(g[1]) else { return nil }
        return ns / 1_000_000_000
    }

    static func deviceClass(_ product: String) -> String {
        let p = product.lowercased()
        if p.contains("keyboard") || p.contains("kbd") { return "keyboard" }
        if p.contains("mouse") { return "mouse" }
        if p.contains("trackpad") || p.contains("touchpad") { return "trackpad" }
        if p.contains("trackball") { return "trackball" }
        return "other"
    }
}

final class HIDCollector {
    private let ctx: Context
    private let assertions: AssertionsCollector
    private var tracker = HIDTracker()
    var monotonic: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    /// Only resolve the device name (an extra pmset call) for input after at least this much idle time.
    var deviceLookupMinIdle: Double = 120

    init(ctx: Context, assertions: AssertionsCollector) {
        self.ctx = ctx
        self.assertions = assertions
    }

    func sampleIdle() -> Double? {
        let r = ctx.runner.run(Tool.ioreg, ["-c", "IOHIDSystem"], timeout: 10)
        guard r.ok else { return nil }
        return HIDParser.idleSeconds(r.stdout)
    }

    /// One-shot reading for --once (idle reset needs two samples, so this reports the current idle time).
    func snapshot() -> CollectorResult {
        var res = CollectorResult()
        guard let idle = sampleIdle() else {
            res.degraded = true
            res.notes.append("ioreg -c IOHIDSystem: no HIDIdleTime")
            return res
        }
        let now = ctx.clock.now()
        var p: Payload = ["snapshot": true, "idle_now_s": num(idle),
                          "last_input_ts": TimeFmt.iso(now.addingTimeInterval(-idle))]
        if let prod = assertions.refresh()?.userIsActiveProducts.first {
            p["device"] = AudioNames.sanitize(prod)
            p["device_class"] = HIDParser.deviceClass(prod)
        }
        res.events.append(DraftEvent("hid.activity", p))
        return res
    }

    func poll() -> CollectorResult {
        var res = CollectorResult()
        guard let idle = sampleIdle() else {
            res.degraded = true
            res.notes.append("ioreg -c IOHIDSystem: no HIDIdleTime")
            return res
        }
        guard let act = tracker.update(idleNow: idle, monotonic: monotonic()) else { return res }
        let now = ctx.clock.now()
        var p: Payload = ["idle_before_s": num(act.idleBeforeS), "idle_now_s": num(act.idleNowS),
                          "last_input_ts": TimeFmt.iso(now.addingTimeInterval(-act.idleNowS))]
        if act.idleBeforeS >= deviceLookupMinIdle, let prod = assertions.refresh()?.userIsActiveProducts.first {
            p["device"] = AudioNames.sanitize(prod)
            p["device_class"] = HIDParser.deviceClass(prod)
        }
        res.events.append(DraftEvent("hid.activity", p))
        return res
    }
}
