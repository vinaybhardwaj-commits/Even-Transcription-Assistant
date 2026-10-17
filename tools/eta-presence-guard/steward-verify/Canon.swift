import Foundation

// Canonical JSON for steward tickets: object keys sorted bytewise ascending (keys are ASCII by contract), no whitespace,
// UTF-8, strings escaped as JSON.stringify does (\" \\ \b \f \n \r \t, other < 0x20 as \u00xx, nothing else).
// Mirrors python json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False) on ASCII keys.

enum Canon {
    static func escape(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if u.value < 0x20 { out += String(format: "\\u%04x", u.value) } else { out.unicodeScalars.append(u) }
            }
        }
        return out + "\""
    }

    /// nil when the value holds something the canonical form cannot carry (non-integral or huge numbers).
    static func encode(_ v: Any) -> String? {
        if v is NSNull { return "null" }
        if let n = v as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "true" : "false" }
            let d = n.doubleValue
            guard d == d.rounded(), abs(d) < 9_007_199_254_740_992 else { return nil }
            return String(n.int64Value)
        }
        if let s = v as? String { return escape(s) }
        if let a = v as? [Any] {
            var parts: [String] = []
            for x in a { guard let e = encode(x) else { return nil }; parts.append(e) }
            return "[" + parts.joined(separator: ",") + "]"
        }
        if let d = v as? [String: Any] {
            let keys = d.keys.sorted { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }
            var parts: [String] = []
            for k in keys { guard let e = encode(d[k]!) else { return nil }; parts.append(escape(k) + ":" + e) }
            return "{" + parts.joined(separator: ",") + "}"
        }
        return nil
    }

    static func bytes(_ v: Any) -> Data? { encode(v)?.data(using: .utf8) }

    static func parse(_ data: Data) -> Any? { try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) }
}
