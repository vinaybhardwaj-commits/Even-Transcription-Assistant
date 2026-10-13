
import Foundation

struct SpoolRecord {
    let segment: String
    let line: String
    let key: String   // machine|boot_id|seq — the server-side unique key
    let kind: String
    let seq: Int64
    let bootID: String
}

enum SpoolClass: String {
    case protected = "p"   // power.*, audio.*, watchdog.*, ladder.*, spool.* and any kind not listed as droppable
    case droppable = "d"   // heartbeat, drift*, assert.*, hid.*, display.*, recorder.*

    static func of(_ kind: String) -> SpoolClass { EventKind.isDroppable(kind) ? .droppable : .protected }
}

/// Segmented jsonl spool, two segment families (`seg-p-*.jsonl` protected, `seg-d-*.jsonl` droppable).
/// Append-only, fsync per batch, acknowledge by key (idempotent).
///
/// Size cap: enforced by deleting WHOLE oldest segment files. Droppable segments go first, as soon as the total
/// passes `capBytes`. Protected segments are deleted only once the total passes `protectedCeilingBytes` (their
/// oldest segment, never the newest one), and a drop report is queued for the emitter to ship as one
/// `spool.dropped` event. When posting, the ceiling is a 200 MB disk-safety limit far above the cap; in dry-run
/// (nothing drains the spool) it equals the cap. The cap check never reads or parses a
/// segment: it adds up an in-memory size table that is built from the directory (stat) at start and kept
/// exact by this class, which is the only writer. `resync()` re-stats the directory.
final class Spool: EventSink {
    let dir: URL
    let capBytes: Int
    /// Total size above which protected segments may be deleted (>= capBytes).
    let protectedCeilingBytes: Int
    let segmentBytes: Int
    private let lock = NSLock()
    private(set) var droppedByKind: [String: Int] = [:]
    private var pendingDrop: SpoolDropReport?
    private var depthCache: Int?

    private struct Seg {
        var name: String
        var cls: SpoolClass
        var number: Int
        var size: Int
        var url: URL
        var legacy = false   // bare seg-NNNNNNNNNN.jsonl of the first layout: read, never appended to
    }
    private var table: [Seg] = []   // protected family first, then droppable; each oldest first
    private var tableLoaded = false

    static let megabyte = 1024 * 1024
    /// 50 MB when the daemon posts; 20 MB in dry-run (post:false), where nobody is collecting the spool.
    static func defaultCap(post: Bool) -> Int { post ? 50 * megabyte : 20 * megabyte }
    /// Posting: protected events survive until the spool passes 200 MB (disk safety). Dry-run: dropped at the cap.
    static func defaultProtectedCeiling(post: Bool) -> Int { post ? 200 * megabyte : 20 * megabyte }

    init(dir: URL, capBytes: Int = 50 * 1024 * 1024, protectedCeilingBytes: Int? = nil, segmentBytes: Int = 1 << 20) throws {
        self.dir = dir
        self.capBytes = capBytes
        self.protectedCeilingBytes = Swift.max(capBytes, protectedCeilingBytes ?? capBytes)
        self.segmentBytes = segmentBytes
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        lock.lock(); defer { lock.unlock() }
        migrateLegacyLocked()
    }

    // MARK: segment table

    /// seg-p-0000000001.jsonl / seg-d-0000000001.jsonl; a bare seg-0000000001.jsonl (older layout) counts as protected.
    private static func parseName(_ name: String) -> (SpoolClass, Int)? {
        guard name.hasPrefix("seg-"), name.hasSuffix(".jsonl") else { return nil }
        let core = String(name.dropFirst(4).dropLast(6))
        if core.hasPrefix("p-"), let n = Int(core.dropFirst(2)) { return (.protected, n) }
        if core.hasPrefix("d-"), let n = Int(core.dropFirst(2)) { return (.droppable, n) }
        if let n = Int(core) { return (.protected, n) }
        return nil
    }

    private static func isLegacyName(_ name: String) -> Bool {
        guard name.hasPrefix("seg-"), name.hasSuffix(".jsonl") else { return false }
        let core = name.dropFirst(4).dropLast(6)
        return !core.hasPrefix("p-") && !core.hasPrefix("d-")
    }

    private func sortTable() {
        table.sort { a, b in
            if a.cls != b.cls { return a.cls == .protected }
            return a.number < b.number
        }
    }

    private func loadTableLocked() {
        guard !tableLoaded else { return }
        scanLocked()
    }

    private func scanLocked() {
        var t: [Seg] = []
        for name in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] {
            guard let (cls, n) = Spool.parseName(name) else { continue }
            let url = dir.appendingPathComponent(name)
            t.append(Seg(name: name, cls: cls, number: n, size: FS.size(url.path), url: url,
                         legacy: Spool.isLegacyName(name)))
        }
        table = t
        sortTable()
        tableLoaded = true
    }

    /// Re-stat every segment (cheap) so the size table cannot drift from the disk.
    func resync() {
        lock.lock(); defer { lock.unlock() }
        scanLocked()
    }

    private func totalLocked() -> Int { table.reduce(0) { $0 + $1.size } }

    // MARK: legacy layout (first build: one family, seg-NNNNNNNNNN.jsonl)

    /// On start, move every old-layout segment's lines into the class segments (protected vs droppable by kind),
    /// then delete the old file. Write-then-delete: a crash in between leaves the lines twice, which the server's
    /// machine|boot_id|seq key de-duplicates. A file that cannot be migrated is left in place (still read, never
    /// appended to).
    private func migrateLegacyLocked() {
        scanLocked()
        let legacy = table.filter { $0.legacy }.sorted { $0.number < $1.number }
        guard !legacy.isEmpty else { return }
        for seg in legacy {
            var prot: [String] = [], drop: [String] = []
            for l in readLines(seg.url) {
                let kind = (J.dict(l)?["kind"] as? String) ?? ""
                if kind.isEmpty || SpoolClass.of(kind) == .protected { prot.append(l) } else { drop.append(l) }
            }
            do {
                try writeChunkedLocked(.protected, lines: prot)
                try writeChunkedLocked(.droppable, lines: drop)
            } catch { continue }
            try? FileManager.default.removeItem(at: seg.url)
            table.removeAll { $0.name == seg.name }
        }
        depthCache = nil
        if totalLocked() > capBytes { enforceCapLocked() }
    }

    /// Append many lines, rolling to a new segment about every `segmentBytes`.
    private func writeChunkedLocked(_ cls: SpoolClass, lines: [String]) throws {
        var batch: [String] = []
        var bytes = 0
        for l in lines {
            batch.append(l)
            bytes += l.utf8.count + 1
            if bytes >= segmentBytes { try writeLocked(cls, lines: batch); batch = []; bytes = 0 }
        }
        if !batch.isEmpty { try writeLocked(cls, lines: batch) }
    }

    // MARK: file helpers

    private func readData(_ url: URL) -> Data { FileManager.default.contents(atPath: url.path) ?? Data() }

    private func readLines(_ url: URL) -> [String] {
        String(decoding: readData(url), as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    }

    private static func newlineCount(_ d: Data) -> Int { d.reduce(0) { $1 == 0x0A ? $0 + 1 : $0 } }

    /// Rewrite a segment with the lines that survive; keeps the size table exact.
    private func rewriteLocked(_ i: Int, lines: [String]) {
        let url = table[i].url
        if lines.isEmpty {
            try? FileManager.default.removeItem(at: url)
            table.remove(at: i)
        } else if let data = (lines.joined(separator: "\n") + "\n").data(using: .utf8) {
            try? FS.atomicWrite(data, to: url)
            table[i].size = data.count
        }
    }

    // MARK: append

    func append(entries: [SinkEntry]) throws {
        lock.lock(); defer { lock.unlock() }
        guard !entries.isEmpty else { return }
        loadTableLocked()
        for cls in [SpoolClass.protected, .droppable] {
            let lines = entries.filter { SpoolClass.of($0.kind) == cls }.map { $0.line }
            if lines.isEmpty { continue }
            try writeLocked(cls, lines: lines)
        }
        if let d = depthCache { depthCache = d + entries.count }
        if totalLocked() > capBytes { enforceCapLocked() }
    }

    private func writeLocked(_ cls: SpoolClass, lines: [String]) throws {
        let data = (lines.joined(separator: "\n") + "\n").data(using: .utf8) ?? Data()
        var idx = table.lastIndex(where: { $0.cls == cls && !$0.legacy })
        if let i = idx, table[i].size >= segmentBytes { idx = nil }
        if idx == nil {
            let n = (table.filter { $0.cls == cls && !$0.legacy }.map { $0.number }.max() ?? 0) + 1
            let name = "seg-\(cls.rawValue)-" + String(format: "%010d.jsonl", n)
            let url = dir.appendingPathComponent(name)
            if !FileManager.default.fileExists(atPath: url.path) {
                FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
            }
            table.append(Seg(name: name, cls: cls, number: n, size: FS.size(url.path), url: url))
            sortTable()
            idx = table.lastIndex(where: { $0.cls == cls && !$0.legacy })
        }
        guard let i = idx else { return }
        let h = try FileHandle(forWritingTo: table[i].url)
        defer { try? h.close() }
        try h.seekToEnd()
        try h.write(contentsOf: data)
        try h.synchronize()
        table[i].size += data.count
    }

    // MARK: read / ack

    private func parse(line: String, segment: String) -> SpoolRecord? {
        guard let d = J.dict(line), let boot = d["boot_id"] as? String,
              let machine = d["machine"] as? String,
              let seq = (d["seq"] as? NSNumber)?.int64Value else { return nil }
        return SpoolRecord(segment: segment, line: line, key: "\(machine)|\(boot)|\(seq)",
                           kind: (d["kind"] as? String) ?? "", seq: seq, bootID: boot)
    }

    /// Oldest-first batch of up to `max` records (protected family first). Pure read; calling it twice returns
    /// the same records.
    /// `maxBytes` caps the serialised request body: `{"events":[` + lines joined by commas + `]}`. The first record is
    /// always taken, so a single oversized line still gets sent (and quarantined by the transport on a 413).
    func readBatch(max: Int, maxBytes: Int = Int.max) -> [SpoolRecord] {
        lock.lock(); defer { lock.unlock() }
        loadTableLocked()
        var out: [SpoolRecord] = []
        var bytes = Spool.bodyOverhead
        for seg in table {
            for l in readLines(seg.url) {
                if let r = parse(line: l, segment: seg.name) {
                    let add = l.utf8.count + (out.isEmpty ? 0 : 1)
                    if !out.isEmpty && bytes + add > maxBytes { return out }
                    out.append(r)
                    bytes += add
                    if out.count >= max { return out }
                }
            }
        }
        return out
    }

    /// Bytes of `{"events":[` and `]}`.
    static let bodyOverhead = 13

    // MARK: quarantine

    static let quarantineCapBytes = 5 * megabyte
    private var quarantineDir: URL { dir.appendingPathComponent("quarantine", isDirectory: true) }
    private var quarantineCounter = 0

    /// Move records the sink will never accept out of the spool into `quarantine/q-<ms>-<n>.jsonl`, then drop them from
    /// the spool. The quarantine folder is capped at 5 MB: oldest files are deleted first, never the one just written.
    /// Returns the file name, or nil if the file could not be written (the records then stay in the spool).
    @discardableResult
    func quarantine(records: [SpoolRecord]) -> String? {
        guard !records.isEmpty else { return nil }
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: quarantineDir, withIntermediateDirectories: true,
                                   attributes: [.posixPermissions: 0o700])
        } catch { return nil }
        lock.lock()
        quarantineCounter += 1
        let name = String(format: "q-%013d-%04d.jsonl", Int(Date().timeIntervalSince1970 * 1000), quarantineCounter)
        lock.unlock()
        let url = quarantineDir.appendingPathComponent(name)
        guard let data = (records.map { $0.line }.joined(separator: "\n") + "\n").data(using: .utf8),
              (try? FS.atomicWrite(data, to: url)) != nil else { return nil }
        enforceQuarantineCap(keeping: name)
        ack(records: records)
        return name
    }

    private func enforceQuarantineCap(keeping newest: String) {
        let fm = FileManager.default
        var files = ((try? fm.contentsOfDirectory(atPath: quarantineDir.path)) ?? [])
            .filter { $0.hasPrefix("q-") && $0.hasSuffix(".jsonl") }.sorted()
        var total = files.reduce(0) { $0 + FS.size(quarantineDir.appendingPathComponent($1).path) }
        while total > Spool.quarantineCapBytes, let oldest = files.first, oldest != newest {
            total -= FS.size(quarantineDir.appendingPathComponent(oldest).path)
            try? fm.removeItem(at: quarantineDir.appendingPathComponent(oldest))
            files.removeFirst()
        }
    }

    var quarantineFiles: [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: quarantineDir.path)) ?? [])
            .filter { $0.hasPrefix("q-") && $0.hasSuffix(".jsonl") }.sorted()
    }

    var quarantineBytes: Int {
        quarantineFiles.reduce(0) { $0 + FS.size(quarantineDir.appendingPathComponent($1).path) }
    }

    /// Remove acknowledged records. Idempotent: unknown/already-removed keys are ignored.
    func ack(keys: Set<String>) { ackLocked(keys: keys, only: nil) }

    /// Same, but only the segments the acknowledged records came from are touched.
    func ack(records: [SpoolRecord]) {
        ackLocked(keys: Set(records.map { $0.key }), only: Set(records.map { $0.segment }))
    }

    private func ackLocked(keys: Set<String>, only: Set<String>?) {
        lock.lock(); defer { lock.unlock() }
        guard !keys.isEmpty else { return }
        loadTableLocked()
        var i = 0
        while i < table.count {
            let seg = table[i]
            if let o = only, !o.contains(seg.name) { i += 1; continue }
            let lines = readLines(seg.url)
            let keep = lines.filter { l in
                guard let r = parse(line: l, segment: seg.name) else { return true }
                return !keys.contains(r.key)
            }
            if keep.count != lines.count {
                if let d = depthCache { depthCache = Swift.max(0, d - (lines.count - keep.count)) }
                let before = table.count
                rewriteLocked(i, lines: keep)
                if table.count < before { continue }   // segment removed: same index now holds the next one
            }
            i += 1
        }
    }

    /// Highest seq recorded for a boot (used to recover if the seq file lags behind the spool after a crash).
    func maxSeq(bootID: String) -> Int64 {
        lock.lock(); defer { lock.unlock() }
        loadTableLocked()
        var best: Int64 = 0
        for seg in table {
            for l in readLines(seg.url) {
                if let r = parse(line: l, segment: seg.name), r.bootID == bootID { best = Swift.max(best, r.seq) }
            }
        }
        return best
    }

    /// Number of buffered events. Counted from the files once, then maintained incrementally.
    var depth: Int {
        lock.lock(); defer { lock.unlock() }
        loadTableLocked()
        if let d = depthCache { return d }
        let n = table.reduce(0) { $0 + Spool.newlineCount(readData($1.url)) }
        depthCache = n
        return n
    }

    var totalBytes: Int {
        lock.lock(); defer { lock.unlock() }
        loadTableLocked()
        return totalLocked()
    }

    var segmentCount: Int {
        lock.lock(); defer { lock.unlock() }
        loadTableLocked()
        return table.count
    }

    // MARK: cap policy

    /// Per-kind line counts of a segment, found by substring search (no JSON parsing).
    private static func kindCounts(_ data: Data) -> (counts: [String: Int], lines: Int) {
        var counts: [String: Int] = [:]
        var lines = 0
        let needle = Array("\"kind\":\"".utf8)
        for chunk in data.split(separator: 0x0A, omittingEmptySubsequences: true) {
            lines += 1
            let bytes = Array(chunk)
            var kind = "unknown"
            if let r = find(needle, in: bytes) {
                var j = r + needle.count
                var k: [UInt8] = []
                while j < bytes.count, bytes[j] != 0x22 { k.append(bytes[j]); j += 1 }
                kind = String(decoding: k, as: UTF8.self)
            }
            counts[kind, default: 0] += 1
        }
        return (counts, lines)
    }

    private static func find(_ needle: [UInt8], in hay: [UInt8]) -> Int? {
        guard !needle.isEmpty, hay.count >= needle.count else { return nil }
        let last = hay.count - needle.count
        var i = 0
        while i <= last {
            if hay[i] == needle[0] {
                var ok = true
                var j = 1
                while j < needle.count { if hay[i + j] != needle[j] { ok = false; break }; j += 1 }
                if ok { return i }
            }
            i += 1
        }
        return nil
    }

    private func dropSegmentLocked(at i: Int, protectedClass: Bool) {
        let seg = table[i]
        let data = readData(seg.url)
        let (counts, lines) = Spool.kindCounts(data)
        for (k, n) in counts { droppedByKind[k, default: 0] += n }
        if let d = depthCache { depthCache = Swift.max(0, d - lines) }
        if protectedClass {
            var rep = pendingDrop ?? SpoolDropReport()
            for (k, n) in counts { rep.counts[k, default: 0] += n }
            rep.protectedDropped = true
            rep.segments += 1
            rep.bytes += seg.size
            pendingDrop = rep
        }
        try? FileManager.default.removeItem(at: seg.url)
        table.remove(at: i)
    }

    private func enforceCapLocked() {
        var total = totalLocked()
        // 1. droppable segments, oldest first (the newest may go too: it only holds heartbeats, hid, drift...).
        while total > capBytes, let i = table.firstIndex(where: { $0.cls == .droppable }) {
            total -= table[i].size
            dropSegmentLocked(at: i, protectedClass: false)
        }
        // 2. still over the protected ceiling (== the cap in dry-run, 200 MB when posting): delete the oldest
        //    protected segment, never the newest one.
        while total > protectedCeilingBytes {
            let prot = table.indices.filter { table[$0].cls == .protected }
            guard prot.count > 1 else { break }
            total -= table[prot[0]].size
            dropSegmentLocked(at: prot[0], protectedClass: true)
        }
    }

    func takeDropReport() -> SpoolDropReport? {
        lock.lock(); defer { lock.unlock() }
        let r = pendingDrop
        pendingDrop = nil
        return r
    }

    var droppedTotal: Int { lock.lock(); defer { lock.unlock() }; return droppedByKind.values.reduce(0, +) }
}
