import Foundation

final class HeartbeatCollector {
    private let ctx: Context
    private let startedAt: Date
    /// Filled in by the daemon: current spool depth, dropped count, last successful POST, collector failure counts.
    var spoolDepth: () -> Int = { 0 }
    var spoolDropped: () -> Int = { 0 }
    var lastPostOK: () -> Date? = { nil }
    var lastPost: () -> LastPost? = { nil }
    var collectorErrors: () -> [String: Int] = { [:] }

    init(ctx: Context) {
        self.ctx = ctx
        self.startedAt = ctx.clock.now()
    }

    func build(started: Bool = false) -> DraftEvent {
        let now = ctx.clock.now()
        let uptime = systemBootDate().map { now.timeIntervalSince($0) } ?? ProcessInfo.processInfo.systemUptime
        var p: Payload = [
            "uptime_s": Int(uptime),
            "daemon_uptime_s": Int(now.timeIntervalSince(startedAt)),
            "spool_depth": spoolDepth(),
            "spool_dropped": spoolDropped(),
            "last_post_ok": lastPostOK().map { TimeFmt.iso($0) as Any } ?? NSNull(),
            "last_post": lastPost().map { lp -> Any in
                ["at": TimeFmt.iso(lp.at), "http": lp.http.map { $0 as Any } ?? NSNull(),
                 "accepted": lp.accepted, "rejected": lp.rejected] as [String: Any]
            } ?? NSNull(),
            "version": kVersion,
            "build": BuildIdentity.payload(),
            "post_enabled": ctx.config.post,
        ]
        let errs = collectorErrors().filter { $0.value > 0 }
        if !errs.isEmpty { p["collector_errors"] = errs }
        if started { p["event"] = "start" }
        return DraftEvent("heartbeat", p)
    }

    func poll() -> CollectorResult { CollectorResult(events: [build()]) }
}
