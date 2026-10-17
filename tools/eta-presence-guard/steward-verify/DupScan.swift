import Foundation

// Duplicate-key scanner. The contract says a duplicate JSON key anywhere in a ticket document is `malformed`, but
// JSONSerialization keeps the last value silently, so this walks the raw bytes (RFC 8259 grammar) and reports duplicates.
// Keys are compared after unescaping ("a" and "a" are the same key).
// scan(data) -> nil when the text is not valid JSON; else rootDup (a duplicate key among the root object's own members, or inside
// anything other than the elements of its "tickets" array) and, per element of the root "tickets" array, whether that element's
// subtree holds a duplicate key.

struct DupScanResult { var rootDup = false; var ticketDup: [Bool] = [] }

struct DupScanner {
    private let b: [UInt8]
    private var i = 0
    private init(_ d: Data) { b = [UInt8](d) }

    static func scan(_ d: Data) -> DupScanResult? {
        var s = DupScanner(d)
        s.ws()
        guard s.i < s.b.count, s.b[s.i] == 0x7b else { var dummy = false; guard s.value(&dummy) else { return nil }; s.ws(); return s.i == s.b.count ? DupScanResult() : nil }
        var r = DupScanResult()
        guard s.rootObject(&r) else { return nil }
        s.ws()
        return s.i == s.b.count ? r : nil
    }

    private mutating func ws() { while i < b.count, b[i] == 0x20 || b[i] == 0x09 || b[i] == 0x0a || b[i] == 0x0d { i += 1 } }
    private mutating func eat(_ c: UInt8) -> Bool { if i < b.count, b[i] == c { i += 1; return true }; return false }

    private mutating func rootObject(_ r: inout DupScanResult) -> Bool {
        i += 1; ws()
        var seen = Set<String>()
        if eat(0x7d) { return true }
        while true {
            ws()
            guard let k = string() else { return false }
            if !seen.insert(k).inserted { r.rootDup = true }
            ws(); guard eat(0x3a) else { return false }; ws()
            if k == "tickets", i < b.count, b[i] == 0x5b {
                i += 1; ws()
                r.ticketDup = []
                if !eat(0x5d) {
                    while true {
                        ws(); var d = false
                        guard value(&d) else { return false }
                        r.ticketDup.append(d)
                        ws()
                        if eat(0x2c) { continue }
                        guard eat(0x5d) else { return false }
                        break
                    }
                }
            } else {
                var d = false
                guard value(&d) else { return false }
                if d { r.rootDup = true }
            }
            ws()
            if eat(0x2c) { continue }
            return eat(0x7d)
        }
    }

    /// Parses one value; sets dup when a duplicate key occurs anywhere inside it.
    private mutating func value(_ dup: inout Bool) -> Bool {
        guard i < b.count else { return false }
        switch b[i] {
        case 0x7b:
            i += 1; ws()
            var seen = Set<String>()
            if eat(0x7d) { return true }
            while true {
                ws()
                guard let k = string() else { return false }
                if !seen.insert(k).inserted { dup = true }
                ws(); guard eat(0x3a) else { return false }; ws()
                guard value(&dup) else { return false }
                ws()
                if eat(0x2c) { continue }
                return eat(0x7d)
            }
        case 0x5b:
            i += 1; ws()
            if eat(0x5d) { return true }
            while true {
                ws()
                guard value(&dup) else { return false }
                ws()
                if eat(0x2c) { continue }
                return eat(0x5d)
            }
        case 0x22: return string() != nil
        case 0x74: return lit("true")
        case 0x66: return lit("false")
        case 0x6e: return lit("null")
        default: return number()
        }
    }

    private mutating func lit(_ s: String) -> Bool {
        let u = Array(s.utf8)
        guard i + u.count <= b.count, Array(b[i..<i + u.count]) == u else { return false }
        i += u.count; return true
    }

    private mutating func number() -> Bool {
        _ = eat(0x2d)
        guard i < b.count else { return false }
        if b[i] == 0x30 { i += 1 } else if b[i] >= 0x31 && b[i] <= 0x39 { while i < b.count, b[i] >= 0x30 && b[i] <= 0x39 { i += 1 } } else { return false }
        if eat(0x2e) { guard i < b.count, b[i] >= 0x30 && b[i] <= 0x39 else { return false }; while i < b.count, b[i] >= 0x30 && b[i] <= 0x39 { i += 1 } }
        if i < b.count, b[i] == 0x65 || b[i] == 0x45 {
            i += 1; if i < b.count, b[i] == 0x2b || b[i] == 0x2d { i += 1 }
            guard i < b.count, b[i] >= 0x30 && b[i] <= 0x39 else { return false }
            while i < b.count, b[i] >= 0x30 && b[i] <= 0x39 { i += 1 }
        }
        return true
    }

    private func hex4(_ at: Int) -> UInt16? {
        guard at + 4 <= b.count else { return nil }
        var v: UInt16 = 0
        for k in 0..<4 {
            let c = b[at + k]; var d: UInt16
            switch c { case 0x30...0x39: d = UInt16(c - 0x30); case 0x61...0x66: d = UInt16(c - 0x61 + 10); case 0x41...0x46: d = UInt16(c - 0x41 + 10); default: return nil }
            v = v << 4 | d
        }
        return v
    }

    /// Returns the unescaped string (invalid escapes / raw control characters / unterminated -> nil).
    private mutating func string() -> String? {
        guard eat(0x22) else { return nil }
        var units: [UInt16] = []; var raw: [UInt8] = []
        func flush() { if !raw.isEmpty { units.append(contentsOf: Array(String(decoding: raw, as: UTF8.self).utf16)); raw = [] } }
        while i < b.count {
            let c = b[i]
            if c == 0x22 { i += 1; flush(); return String(decoding: units, as: UTF16.self) }
            if c < 0x20 { return nil }
            if c == 0x5c {
                i += 1; guard i < b.count else { return nil }
                let e = b[i]; i += 1
                flush()
                switch e {
                case 0x22: units.append(0x22); case 0x5c: units.append(0x5c); case 0x2f: units.append(0x2f)
                case 0x62: units.append(0x08); case 0x66: units.append(0x0c); case 0x6e: units.append(0x0a)
                case 0x72: units.append(0x0d); case 0x74: units.append(0x09)
                case 0x75: guard let u = hex4(i) else { return nil }; units.append(u); i += 4
                default: return nil
                }
            } else { raw.append(c); i += 1 }
        }
        return nil
    }
}
