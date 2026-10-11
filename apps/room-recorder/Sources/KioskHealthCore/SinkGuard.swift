import Foundation

/// Per-event guards that make every spooled line acceptable to the live W1 sink (see SPEC / R4 orders):
/// machine <=128, boot_id <=64, source <=32, kind /^[a-z0-9_.-]+$/ <=64, room_id/install_id <=64, ts ISO with offset,
/// payload object <=16 KB with no NUL and no lone surrogates. Pure functions; nothing here does I/O.
enum SinkGuard {
    static let maxPayloadBytes = 16 * 1024
    /// F24: the payload object itself is depth 1; anything nested deeper than this is replaced by the marker.
    static let maxPayloadDepth = 12
    static let maxKind = 64
    static let maxMachine = 128
    static let maxBootID = 64
    static let maxSource = 32
    static let maxID = 64

    /// Lowercase, every character outside [a-z0-9_.-] becomes '_', capped at 64. Never empty.
    static func sanitizeKind(_ kind: String) -> String {
        var out = ""
        for u in kind.lowercased().unicodeScalars {
            switch u {
            case "a"..."z", "0"..."9", "_", ".", "-": out.unicodeScalars.append(u)
            default: out.unicodeScalars.append("_")
            }
            if out.unicodeScalars.count >= maxKind { break }
        }
        return out.isEmpty ? "unknown" : out
    }

    /// Remove NUL and lone UTF-16 surrogates. A Swift String cannot hold a lone surrogate, but one can arrive through
    /// an NSString bridge, so the UTF-16 view is checked explicitly.
    static func cleanString(_ s: String) -> String {
        let u = Array(s.utf16)
        var needs = false
        for (i, c) in u.enumerated() {
            if c == 0 { needs = true; break }
            if (0xD800...0xDBFF).contains(c) {
                if !(i + 1 < u.count && (0xDC00...0xDFFF).contains(u[i + 1])) { needs = true; break }
            } else if (0xDC00...0xDFFF).contains(c) {
                if !(i > 0 && (0xD800...0xDBFF).contains(u[i - 1])) { needs = true; break }
            }
        }
        if !needs { return s }
        var kept: [UInt16] = []
        var i = 0
        while i < u.count {
            let c = u[i]
            if c == 0 { i += 1; continue }
            if (0xD800...0xDBFF).contains(c) {
                if i + 1 < u.count, (0xDC00...0xDFFF).contains(u[i + 1]) { kept.append(c); kept.append(u[i + 1]); i += 2; continue }
                i += 1; continue
            }
            if (0xDC00...0xDFFF).contains(c) { i += 1; continue }
            kept.append(c)
            i += 1
        }
        return String(decoding: kept, as: UTF16.self)
    }

    /// Deep clean of a JSON-ish value: strings (and dictionary keys) lose NUL and lone surrogates.
    static func cleanValue(_ v: Any) -> Any {
        if let s = v as? String { return cleanString(s) }
        if let d = v as? [String: Any] {
            var out: [String: Any] = [:]
            for (k, x) in d { out[cleanString(k)] = cleanValue(x) }
            return out
        }
        if let a = v as? [Any] { return a.map { cleanValue($0) } }
        return v
    }

    /// The payload as it will be sent: cleaned, and replaced by a marker when it serialises to more than 16 KB.
    static func guardPayload(_ payload: Payload, kind: String) -> Payload {
        let cleaned = cleanValue(payload) as? Payload ?? [:]
        let size = J.string(cleaned).utf8.count
        if size > maxPayloadBytes || depth(cleaned) > maxPayloadDepth {
            return ["_truncated": true, "orig_bytes": size, "kind": kind]
        }
        return cleaned
    }

    /// Cap in UTF-16 code units (what the sink counts, F23), never splitting a surrogate pair.
    static func cap(_ s: String, _ n: Int) -> String {
        let c = cleanString(s)
        guard c.utf16.count > n else { return c }
        var out = ""
        var units = 0
        for ch in c.unicodeScalars {
            let w = ch.value > 0xFFFF ? 2 : 1
            if units + w > n { break }
            out.unicodeScalars.append(ch)
            units += w
        }
        return out
    }

    /// Nesting depth of a JSON value: a scalar is 0, an object or array is 1 + its deepest child.
    static func depth(_ v: Any) -> Int {
        if let d = v as? [String: Any] { return 1 + (d.values.map { depth($0) }.max() ?? 0) }
        if let a = v as? [Any] { return 1 + (a.map { depth($0) }.max() ?? 0) }
        return 0
    }

    /// Wire timestamp: ISO-8601 with milliseconds and an explicit +00:00 offset. The contract says "ISO with offset";
    /// a `Z` suffix is only accepted by some validators, `+00:00` by all of them.
    static func wireTimestamp(_ d: Date) -> String { TimeFmt.isoOffset(d) }
}
