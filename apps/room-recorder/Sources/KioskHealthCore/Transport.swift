import Foundation

enum PostResult: Equatable {
    /// 2xx. `body` is the response body (the sink's {ok, accepted, duplicates, rejected, rejected_reasons}).
    case ok(status: Int, body: Data = Data())
    case failed(status: Int?, reason: String)   // status nil = transport error
}

protocol HTTPPoster {
    func post(url: URL, token: String?, body: Data) -> PostResult
}

struct Backoff {
    var base: TimeInterval = 10
    var cap: TimeInterval = 300
    private(set) var failures = 0
    mutating func fail() -> TimeInterval {
        failures += 1
        return min(cap, base * pow(2, Double(failures - 1)))
    }
    mutating func reset() { failures = 0 }
}

enum TickOutcome: Equatable {
    case disabled            // post:false — never touches the network
    case waiting             // inside the backoff / interval window
    case idle                // nothing to send
    case sent(count: Int)
    case failed(retryIn: TimeInterval)
    case quarantined(count: Int)   // 400 or a single event the sink calls too large: moved to spool/quarantine/
    case unauthorized              // 401: posting paused, spooling continues
}

/// What the sink last said, for the heartbeat's `last_post` field. `http` is nil for a transport error.
struct LastPost: Equatable {
    var at: Date
    var http: Int?
    var accepted: Int
    var rejected: Int
}

/// Batches spool records to the sink and follows its contract:
///  - 200: the whole batch is deleted, even when some or all events were rejected (the sink says so in the body);
///  - 413: halve the batch and resend, down to one event; one event that still gets 413 is quarantined;
///  - 400: permanent, the batch is quarantined and never retried;
///  - 401: bad token, posting pauses for an hour at a time while spooling continues;
///  - 503, any other status, and network errors: nothing is deleted, exponential backoff to 5 minutes.
final class Transport {
    let config: Config
    let spool: Spool
    let poster: HTTPPoster
    let clock: Clock
    private var nextAttempt: Date = .distantPast
    private var backoff = Backoff()
    private let stateLock = NSLock()
    private var _lastPostOK: Date?
    private var _lastPost: LastPost?
    /// (level, message): the daemon maps this to its own log.
    var onLog: ((String, String) -> Void)?
    /// Event count per request (the sink accepts 1...500).
    let batchSize = 500
    /// Serialised body cap: the sink's limit is 3,000,000 bytes, this leaves a margin.
    static let maxBodyBytes = 2_900_000
    static let interval: TimeInterval = 10
    static let unauthorizedPause: TimeInterval = 3600

    init(config: Config, spool: Spool, poster: HTTPPoster, clock: Clock) {
        self.config = config
        self.spool = spool
        self.poster = poster
        self.clock = clock
    }

    var lastPostOK: Date? { stateLock.lock(); defer { stateLock.unlock() }; return _lastPostOK }
    var lastPost: LastPost? { stateLock.lock(); defer { stateLock.unlock() }; return _lastPost }

    private func record(_ http: Int?, accepted: Int, rejected: Int, at: Date, ok: Bool = false) {
        stateLock.lock()
        _lastPost = LastPost(at: at, http: http, accepted: accepted, rejected: rejected)
        if ok { _lastPostOK = at }
        stateLock.unlock()
    }

    private func log(_ level: String, _ msg: String) { onLog?(level, msg) }

    static func body(_ records: ArraySlice<SpoolRecord>) -> Data {
        ("{\"events\":[" + records.map { $0.line }.joined(separator: ",") + "]}").data(using: .utf8) ?? Data()
    }

    private struct SinkReply {
        var accepted = 0, duplicates = 0, rejected = 0
        var reasons: [String] = []
        var hasAccepted = false
    }

    private static func parseReply(_ data: Data) -> SinkReply {
        var r = SinkReply()
        guard let d = J.parse(data: data) as? [String: Any] else { return r }
        guard let acc = d["accepted"] as? NSNumber else { return r }
        r.hasAccepted = true
        r.accepted = acc.intValue
        r.duplicates = (d["duplicates"] as? NSNumber)?.intValue ?? 0
        r.rejected = (d["rejected"] as? NSNumber)?.intValue ?? 0
        if let a = d["rejected_reasons"] as? [Any] {
            r.reasons = a.prefix(3).map { x in
                if let s = x as? String { return s }
                return J.string(x).truncated(160)
            }
        }
        return r
    }

    private enum Step {
        case done(TickOutcome)
        /// A 413: send again with this many events.
        case retry(Int)
    }

    /// What the sink said to a batch of `n` events (`sent`), turned into the spool's next move. Shared by the standalone
    /// loop (`tick`) and by the relay (`complete`), so the two cannot drift apart.
    private func handle(_ result: PostResult, sent: ArraySlice<SpoolRecord>, n: Int, now: Date) -> Step {
        switch result {
        case .ok(let status, let data):
            let r = Transport.parseReply(data)
            guard r.hasAccepted else {
                // F25: a 2xx without the sink's body (proxy page, captive portal) proves nothing was stored.
                record(status, accepted: 0, rejected: 0, at: now)
                let d = backoff.fail()
                nextAttempt = now.addingTimeInterval(d)
                log("WARN", "post: http \(status) without a sink reply (no \"accepted\"); treated as a failure, retry in \(Int(d))s, events kept")
                return .done(.failed(retryIn: d))
            }
            spool.ack(records: Array(sent))
            backoff.reset()
            record(status, accepted: r.accepted, rejected: r.rejected, at: now, ok: true)
            var msg = "post ok: http \(status) sent=\(n) accepted=\(r.accepted) duplicates=\(r.duplicates) rejected=\(r.rejected)"
            if !r.reasons.isEmpty { msg += " reasons=\(r.reasons.joined(separator: " | "))" }
            log(r.rejected > 0 ? "WARN" : "INFO", msg)
            nextAttempt = spool.depth > 0 ? now : now.addingTimeInterval(Transport.interval)
            return .done(.sent(count: n))

        case .failed(let status, let reason):
            switch status {
            case 413?:
                record(413, accepted: 0, rejected: 0, at: now)
                if n > 1 {
                    log("WARN", "post: http 413, retrying with \(n / 2) events")
                    return .retry(n / 2)
                }
                let q = spool.quarantine(records: Array(sent))
                log("ERROR", "post: http 413 for a single event; \(q.map { "quarantined as \($0)" } ?? "quarantine write failed, event kept")")
                nextAttempt = now
                return .done(q == nil ? .failed(retryIn: 0) : .quarantined(count: 1))

            case 400?:
                record(400, accepted: 0, rejected: 0, at: now)
                let q = spool.quarantine(records: Array(sent))
                log("ERROR", "post: http 400 (permanent) for \(n) events; \(q.map { "quarantined as \($0)" } ?? "quarantine write failed, batch kept"); not retried")
                nextAttempt = now
                if q == nil {
                    let d = backoff.fail()
                    nextAttempt = now.addingTimeInterval(d)
                    return .done(.failed(retryIn: d))
                }
                return .done(.quarantined(count: n))

            case 401?:
                record(401, accepted: 0, rejected: 0, at: now)
                nextAttempt = now.addingTimeInterval(Transport.unauthorizedPause)
                log("ERROR", "post: http 401, the sink refuses the token; posting paused for 1 h, events keep spooling")
                return .done(.unauthorized)

            default:
                record(status, accepted: 0, rejected: 0, at: now)
                let d = backoff.fail()
                nextAttempt = now.addingTimeInterval(d)
                log("WARN", "post failed (\(reason)); retry in \(Int(d))s")
                return .done(.failed(retryIn: d))
            }
        }
    }

    @discardableResult
    func tick() -> TickOutcome {
        guard config.post else { return .disabled }
        let now = clock.now()
        if now < nextAttempt { return .waiting }
        let batch = spool.readBatch(max: batchSize, maxBytes: Transport.maxBodyBytes)
        if batch.isEmpty { nextAttempt = now.addingTimeInterval(Transport.interval); return .idle }
        guard let url = URL(string: config.sinkURL) else {
            let d = backoff.fail()
            nextAttempt = now.addingTimeInterval(d)
            return .failed(retryIn: d)
        }
        var n = batch.count
        while true {
            let sent = batch[0..<n]
            switch handle(poster.post(url: url, token: config.token, body: Transport.body(sent)), sent: sent, n: n, now: now) {
            case .done(let outcome): return outcome
            case .retry(let smaller): n = smaller
            }
        }
    }

    // MARK: relay (0.1.36): the helper holds no server credential, so the APP posts

    /// One batch handed to the app, until the app says what the sink answered. The helper never touches the network:
    /// it spools, hands out the oldest events, and applies the sink's answer exactly as `tick` would have.
    struct RelayBatch {
        let id: String
        let body: Data
        let count: Int
        fileprivate let records: ArraySlice<SpoolRecord>
    }

    /// Guards the relay's own state. Not `stateLock`: `handle` takes that one (through `record`) while a relay call holds this.
    private let relayLock = NSLock()
    private var relayLimit: Int?
    private var relayInFlight: (id: String, batch: RelayBatch)?

    /// The next batch to post, or nil when there is nothing to send or the transport is waiting (backoff, the one hour
    /// pause after a 401). A batch that was handed out and not answered is handed out again, with the same id: the
    /// sink dedupes, so a lost answer costs a duplicate post and never an event.
    func nextRelayBatch() -> RelayBatch? {
        relayLock.lock(); defer { relayLock.unlock() }
        let now = clock.now()
        if let inflight = relayInFlight { return inflight.batch }
        if now < nextAttempt { return nil }
        let all = spool.readBatch(max: relayLimit ?? batchSize, maxBytes: Transport.maxBodyBytes)
        if all.isEmpty { nextAttempt = now.addingTimeInterval(Transport.interval); return nil }
        let batch = RelayBatch(id: Transport.relayID(all), body: Transport.body(all[0..<all.count]), count: all.count, records: all[0..<all.count])
        relayInFlight = (batch.id, batch)
        return batch
    }

    /// Stable across runs: the sequence numbers inside the first and last event, and the count.
    static func relayID(_ records: [SpoolRecord]) -> String {
        func seq(_ r: SpoolRecord) -> String {
            guard let d = J.parse(r.line) as? [String: Any] else { return "?" }
            return "\(d["boot_id"] as? String ?? "?"):\((d["seq"] as? NSNumber)?.int64Value ?? -1)"
        }
        return "\(seq(records.first!))..\(seq(records.last!))#\(records.count)"
    }

    /// The app's report of what the sink answered for `id`. An unknown id (a stale answer) changes nothing.
    @discardableResult
    func completeRelay(id: String, result: PostResult) -> TickOutcome? {
        relayLock.lock(); defer { relayLock.unlock() }
        guard let inflight = relayInFlight, inflight.id == id else { return nil }
        let now = clock.now()
        let batch = inflight.batch
        switch handle(result, sent: batch.records, n: batch.count, now: now) {
        case .done(let outcome):
            relayInFlight = nil
            relayLimit = nil
            return outcome
        case .retry(let smaller):
            // 413: the same events, in a smaller batch, next time.
            relayInFlight = nil
            relayLimit = smaller
            nextAttempt = now
            return .failed(retryIn: 0)
        }
    }
}
