import Foundation

typealias Payload = [String: Any]

let kVersion = "0.1.0"

// MARK: - Clock / sleeper (injectable so tests never wait)

protocol Clock { func now() -> Date }
struct SystemClock: Clock { func now() -> Date { Date() } }

protocol Sleeper { func sleep(_ seconds: TimeInterval) }
struct RealSleeper: Sleeper {
    func sleep(_ seconds: TimeInterval) { if seconds > 0 { Thread.sleep(forTimeInterval: seconds) } }
}

// MARK: - Time formatting / parsing

enum TimeFmt {
    private static let lock = NSLock()
    private static let isoFmt: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    static func iso(_ d: Date) -> String {
        lock.lock(); defer { lock.unlock() }
        // Round to the millisecond first: the formatter truncates, so 17.1 s would print as .099.
        return isoFmt.string(from: Date(timeIntervalSince1970: (d.timeIntervalSince1970 * 1000).rounded() / 1000))
    }

    /// Same instant, UTC, written with an explicit numeric offset ("...123+00:00") instead of "Z".
    static func isoOffset(_ d: Date) -> String {
        let s = iso(d)
        return s.hasSuffix("Z") ? String(s.dropLast()) + "+00:00" : s
    }

    static func parseISO(_ s: String) -> Date? {
        lock.lock(); defer { lock.unlock() }
        return isoFmt.date(from: s)
    }

    /// Parse "2026-10-05" "13:36:55" [fraction digits] "+0530" into an absolute Date.
    static func parseStamp(date: String, time: String, frac: String?, tz: String) -> Date? {
        let dp = date.split(separator: "-").compactMap { Int($0) }
        let tp = time.split(separator: ":").compactMap { Int($0) }
        guard dp.count == 3, tp.count == 3, tz.count == 5 else { return nil }
        let sign = tz.hasPrefix("-") ? -1 : 1
        guard let hh = Int(tz.dropFirst().prefix(2)), let mm = Int(tz.dropFirst(3)) else { return nil }
        guard let zone = TimeZone(secondsFromGMT: sign * (hh * 3600 + mm * 60)) else { return nil }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = zone
        var c = DateComponents()
        c.year = dp[0]; c.month = dp[1]; c.day = dp[2]
        c.hour = tp[0]; c.minute = tp[1]; c.second = tp[2]
        guard var d = cal.date(from: c) else { return nil }
        if let f = frac, !f.isEmpty, let fv = Double("0." + f) { d = d.addingTimeInterval(fv) }
        return d
    }

    /// "YYYY-MM-DD HH:MM:SS" in the machine's local time zone (the format `log show --start` wants).
    static func localLogStamp(_ d: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone.current
        let c = cal.dateComponents([.year, .month, .day, .hour, .minute, .second], from: d)
        return String(format: "%04d-%02d-%02d %02d:%02d:%02d",
                      c.year ?? 1970, c.month ?? 1, c.day ?? 1, c.hour ?? 0, c.minute ?? 0, c.second ?? 0)
    }
}

// MARK: - JSON

enum J {
    static func string(_ obj: Any, pretty: Bool = false) -> String {
        guard JSONSerialization.isValidJSONObject(obj) else { return "{\"error\":\"invalid_json_object\"}" }
        var opts: JSONSerialization.WritingOptions = [.sortedKeys, .withoutEscapingSlashes]
        if pretty { opts.insert(.prettyPrinted) }
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: opts) else {
            return "{\"error\":\"json_encode_failed\"}"
        }
        return String(decoding: d, as: UTF8.self)
    }

    static func parse(_ s: String) -> Any? {
        guard let d = s.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: d, options: [.fragmentsAllowed])
    }

    static func parse(data: Data) -> Any? {
        try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    static func dict(_ s: String) -> [String: Any]? { parse(s) as? [String: Any] }
}

/// Round to 3 decimals and neutralise NaN/inf so JSON serialisation never fails.
func num(_ d: Double) -> Double {
    if d.isNaN || d.isInfinite { return 0 }
    return (d * 1000).rounded() / 1000
}

// MARK: - Regex helper (NSRegularExpression; a bad pattern never crashes the daemon)

final class RX {
    nonisolated(unsafe) static var failures: [String] = []
    let re: NSRegularExpression
    init(_ pattern: String, _ options: NSRegularExpression.Options = []) {
        if let r = try? NSRegularExpression(pattern: pattern, options: options) {
            re = r
        } else {
            RX.failures.append(pattern)
            re = try! NSRegularExpression(pattern: "(?!)")
        }
    }

    /// First match: element 0 is the whole match, then capture groups ("" if a group did not participate).
    func match(_ s: String) -> [String]? {
        let ns = s as NSString
        guard let m = re.firstMatch(in: s, options: [], range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            let r = m.range(at: i)
            return r.location == NSNotFound ? "" : ns.substring(with: r)
        }
    }

    func matches(_ s: String) -> Bool { match(s) != nil }

    func allMatches(_ s: String) -> [[String]] {
        let ns = s as NSString
        return re.matches(in: s, options: [], range: NSRange(location: 0, length: ns.length)).map { m in
            (0..<m.numberOfRanges).map { i in
                let r = m.range(at: i)
                return r.location == NSNotFound ? "" : ns.substring(with: r)
            }
        }
    }

    func replace(_ s: String, with template: String) -> String {
        let ns = s as NSString
        return re.stringByReplacingMatches(in: s, options: [], range: NSRange(location: 0, length: ns.length), withTemplate: template)
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }

    func truncated(_ n: Int) -> String {
        count <= n ? self : String(prefix(n)) + "…"
    }

    /// Collapse tabs/runs of whitespace into single spaces.
    var squashed: String {
        split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\r" }).joined(separator: " ")
    }
}

// MARK: - Files

enum FS {
    static func atomicWrite(_ data: Data, to url: URL, mode: Int = 0o600) throws {
        let fm = FileManager.default
        let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).tmp-\(getpid())")
        try data.write(to: tmp)
        try? fm.setAttributes([.posixPermissions: mode], ofItemAtPath: tmp.path)
        if fm.fileExists(atPath: url.path) {
            _ = try fm.replaceItemAt(url, withItemAt: tmp)
        } else {
            try fm.moveItem(at: tmp, to: url)
        }
    }

    static func mtime(_ path: String) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date
    }

    static func size(_ path: String) -> Int {
        ((try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? NSNumber)?.intValue ?? 0
    }
}

// MARK: - sysctl helpers

func sysctlString(_ name: String) -> String? {
    var size = 0
    guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
    var buf = [CChar](repeating: 0, count: size)
    guard sysctlbyname(name, &buf, &size, nil, 0) == 0 else { return nil }
    return String(cString: buf)
}

func systemBootDate() -> Date? {
    var tv = timeval()
    var size = MemoryLayout<timeval>.size
    guard sysctlbyname("kern.boottime", &tv, &size, nil, 0) == 0 else { return nil }
    return Date(timeIntervalSince1970: TimeInterval(tv.tv_sec) + TimeInterval(tv.tv_usec) / 1_000_000)
}

func currentBootID() -> String {
    sysctlString("kern.bootsessionuuid") ?? "unknown-boot"
}

/// Parse "88:59:30" (H:MM:SS, hours may exceed 24) or "04:22" into seconds.
func parseDurationHMS(_ s: String) -> Int? {
    let parts = s.split(separator: ":").compactMap { Int($0) }
    switch parts.count {
    case 3: return parts[0] * 3600 + parts[1] * 60 + parts[2]
    case 2: return parts[0] * 60 + parts[1]
    default: return nil
    }
}
