import Foundation

/// Small persistent key/value store for cursors, tail offsets and ladder state.
protocol StateStore: AnyObject {
    func get(_ key: String) -> Any?
    func set(_ key: String, _ value: Any?)
}

final class MemoryState: StateStore {
    private var d: [String: Any] = [:]
    private let lock = NSLock()
    func get(_ key: String) -> Any? { lock.lock(); defer { lock.unlock() }; return d[key] }
    func set(_ key: String, _ value: Any?) {
        lock.lock(); defer { lock.unlock() }
        if let v = value { d[key] = v } else { d.removeValue(forKey: key) }
    }
}

final class FileState: StateStore {
    private let url: URL
    private var d: [String: Any]
    private let lock = NSLock()

    init(url: URL) {
        self.url = url
        if let data = FileManager.default.contents(atPath: url.path),
           let obj = J.parse(data: data) as? [String: Any] {
            d = obj
        } else {
            d = [:]
        }
    }

    func get(_ key: String) -> Any? { lock.lock(); defer { lock.unlock() }; return d[key] }

    func set(_ key: String, _ value: Any?) {
        lock.lock(); defer { lock.unlock() }
        if let v = value { d[key] = v } else { d.removeValue(forKey: key) }
        if let data = J.string(d).data(using: .utf8) {
            try? FS.atomicWrite(data, to: url)
        }
    }
}

/// Dedup cursor for incrementally-read, timestamped logs. Entries at exactly the cursor second
/// are disambiguated by a digest so a re-read never re-emits them.
struct LogCursor {
    var lastTs: Date? = nil
    var seen: Set<String> = []

    static func load(_ state: StateStore, key: String) -> LogCursor {
        guard let d = state.get(key) as? [String: Any],
              let t = d["ts"] as? Double else { return LogCursor() }
        let seen = (d["seen"] as? [String]) ?? []
        return LogCursor(lastTs: Date(timeIntervalSince1970: t), seen: Set(seen))
    }

    func save(_ state: StateStore, key: String) {
        guard let t = lastTs else { return }
        state.set(key, ["ts": t.timeIntervalSince1970, "seen": Array(seen).sorted()] as [String: Any])
    }

    /// Returns the entries that have not been seen, and advances the cursor over *all* entries.
    mutating func advance<T>(_ items: [T], ts: (T) -> Date, digest: (T) -> String, floor: Date?) -> [T] {
        var fresh: [T] = []
        for it in items {
            let t = ts(it)
            let d = digest(it)
            let isNew: Bool
            if let last = lastTs {
                isNew = t > last || (t == last && !seen.contains(d))
            } else {
                isNew = floor.map { t >= $0 } ?? true
            }
            if isNew { fresh.append(it) }
        }
        if let maxT = items.map(ts).max() {
            if lastTs == nil || maxT > lastTs! {
                lastTs = maxT
                seen = Set(items.filter { ts($0) == maxT }.map(digest))
            } else if maxT == lastTs! {
                for it in items where ts(it) == maxT { seen.insert(digest(it)) }
            }
        }
        return fresh
    }
}
