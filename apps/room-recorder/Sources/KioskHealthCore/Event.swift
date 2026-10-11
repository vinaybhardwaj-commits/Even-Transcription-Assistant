
import Foundation

/// An event before it gets an envelope (seq, boot_id, machine...).
struct DraftEvent {
    var kind: String
    var payload: Payload
    var ts: Date?
    init(_ kind: String, _ payload: Payload = [:], ts: Date? = nil) {
        self.kind = kind
        self.payload = payload
        self.ts = ts
    }
}

struct CollectorResult {
    var events: [DraftEvent] = []
    var notes: [String] = []
    var degraded = false
}

/// JSON null-or-string helper for envelope/payload fields.
func jv(_ s: String?) -> Any { s ?? NSNull() }

/// One serialised event on its way to the sink. `kind` rides along so the spool can route by class without
/// parsing the JSON line again.
struct SinkEntry {
    let kind: String
    let line: String
}

/// What the spool had to throw away (whole segments) since the last time the emitter asked.
struct SpoolDropReport {
    var counts: [String: Int] = [:]
    var protectedDropped = false
    var segments = 0
    var bytes = 0
}

protocol EventSink {
    func append(entries: [SinkEntry]) throws
    /// Non-nil once, after the sink discarded protected events to honour its size cap.
    func takeDropReport() -> SpoolDropReport?
}

extension EventSink {
    func takeDropReport() -> SpoolDropReport? { nil }
}

final class MemorySink: EventSink {
    private(set) var lines: [String] = []
    private let lock = NSLock()
    func append(entries: [SinkEntry]) throws {
        lock.lock(); defer { lock.unlock() }
        lines.append(contentsOf: entries.map { $0.line })
    }
    var snapshot: [String] { lock.lock(); defer { lock.unlock() }; return lines }
}

/// Persists (boot_id, seq) so a daemon restart within one boot continues the sequence.
final class SeqStore {
    private let url: URL
    init(dir: URL) { url = dir.appendingPathComponent("seq.json") }

    func load(bootID: String) -> Int64 {
        guard let data = FileManager.default.contents(atPath: url.path),
              let d = J.parse(data: data) as? [String: Any],
              (d["boot_id"] as? String) == bootID,
              let s = (d["seq"] as? NSNumber)?.int64Value else { return 0 }
        return s
    }

    func save(bootID: String, seq: Int64) {
        let d: [String: Any] = ["boot_id": bootID, "seq": seq]
        if let data = J.string(d).data(using: .utf8) { try? FS.atomicWrite(data, to: url) }
    }
}

enum EventKind {
    /// Kinds that must flush to disk immediately.
    static func isProtected(_ kind: String) -> Bool {
        kind.hasPrefix("power.") || kind.hasPrefix("audio.") || kind.hasPrefix("watchdog.") || kind.hasPrefix("ladder.")
            || kind.hasPrefix("spool.") || kind == "chrome.alert"
    }

    /// Kinds the spool may delete (whole segments, oldest first) to stay under its cap. Everything else,
    /// including any kind added later, lives in protected segments: new kinds fail safe.
    static func isDroppable(_ kind: String) -> Bool {
        kind == "heartbeat" || kind == "chrome.profile" || kind.hasPrefix("drift") || kind.hasPrefix("assert.")
            || kind.hasPrefix("hid.") || kind.hasPrefix("display.") || kind.hasPrefix("recorder.")
    }
}

final class Emitter {
    let config: Config
    let bootID: String
    let clock: Clock
    private let sink: EventSink
    private let seqStore: SeqStore?
    private var seq: Int64
    private var buffer: [SinkEntry] = []
    /// Guards `seq`, `buffer` and `emittedCount`. Held only for in-memory work.
    private let lock = NSLock()
    /// Serialises flushes end to end (snapshot the buffer, write it, persist seq): two concurrent flushes
    /// used to write the same batch twice and then discard events that had arrived in between.
    private let flushLock = NSLock()
    private(set) var emittedCount = 0
    var onError: ((String) -> Void)?
    static let bufferLimit = 20000

    init(config: Config, bootID: String, clock: Clock, sink: EventSink, startSeq: Int64 = 0, seqStore: SeqStore? = nil) {
        self.config = config
        self.bootID = bootID
        self.clock = clock
        self.sink = sink
        self.seq = startSeq
        self.seqStore = seqStore
    }

    var currentSeq: Int64 { lock.lock(); defer { lock.unlock() }; return seq }

    /// The wire event. Every field is held to the sink's limits here (SinkGuard), before anything is spooled.
    func envelope(seq: Int64, kind: String, ts: Date, payload: Payload) -> Payload {
        let k = SinkGuard.sanitizeKind(kind)
        var e: Payload = [
            "machine": SinkGuard.cap(config.machine, SinkGuard.maxMachine),
            "boot_id": SinkGuard.cap(bootID, SinkGuard.maxBootID),
            "seq": seq,
            "source": SinkGuard.cap(config.source, SinkGuard.maxSource),
            "kind": k,
            "ts": SinkGuard.wireTimestamp(ts),
            "payload": SinkGuard.guardPayload(payload, kind: k),
        ]
        // room_id and install_id are optional on the sink: omitted when unset, never sent as null.
        if let r = config.roomID, !r.isEmpty { e["room_id"] = SinkGuard.cap(r, SinkGuard.maxID) }
        if let i = config.installID, !i.isEmpty { e["install_id"] = SinkGuard.cap(i, SinkGuard.maxID) }
        return e
    }

    /// Assign the next seq and buffer the serialised line. No I/O.
    private func enqueue(_ d: DraftEvent) -> Int64 {
        lock.lock(); defer { lock.unlock() }
        seq += 1
        let s = seq
        let kind = SinkGuard.sanitizeKind(d.kind)
        let line = J.string(envelope(seq: s, kind: kind, ts: d.ts ?? clock.now(), payload: d.payload))
        buffer.append(SinkEntry(kind: kind, line: line))
        if buffer.count > Self.bufferLimit { buffer.removeFirst(buffer.count - Self.bufferLimit) }
        emittedCount += 1
        return s
    }

    @discardableResult
    func emit(_ d: DraftEvent) -> Int64 {
        let s = enqueue(d)
        if EventKind.isProtected(d.kind) { flush() }
        return s
    }

    func emit(_ events: [DraftEvent]) { for e in events { emit(e) } }

    /// Write the buffered batch (fsync inside the sink), then persist the seq high-water mark.
    /// The batch is taken out of the buffer before the write and put back in front if the write fails, so
    /// events that arrive meanwhile are neither written twice nor lost.
    func flush() {
        flushLock.lock(); defer { flushLock.unlock() }
        lock.lock()
        let batch = buffer
        buffer = []
        let high = seq
        lock.unlock()
        if !batch.isEmpty {
            do {
                try sink.append(entries: batch)
                seqStore?.save(bootID: bootID, seq: high)
            } catch {
                lock.lock()
                buffer = batch + buffer
                if buffer.count > Self.bufferLimit { buffer.removeFirst(buffer.count - Self.bufferLimit) }
                lock.unlock()
                onError?("spool append failed: \(error)")
            }
        }
        if let rep = sink.takeDropReport() {
            // Queued, not flushed here: the next flush (at most a second away) carries it.
            _ = enqueue(DraftEvent("spool.dropped", [
                "counts": rep.counts, "protected_dropped": rep.protectedDropped,
                "segments_deleted": rep.segments, "bytes_deleted": rep.bytes,
            ]))
        }
    }
}
