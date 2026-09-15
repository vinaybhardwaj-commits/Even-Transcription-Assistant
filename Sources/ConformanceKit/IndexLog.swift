import Foundation

public enum IndexLogError: Error, Equatable, CustomStringConvertible {
    case interiorBlankLine(line: Int)
    case invalidRecord(line: Int, reason: String)

    public var description: String {
        switch self {
        case .interiorBlankLine(let n): return "interior blank line at line \(n)"
        case .invalidRecord(let n, let r): return "invalid record at line \(n): \(r)"
        }
    }
}

/// One complete (0x0A-terminated) index line.
public struct IndexLine {
    /// 1-based line number.
    public let number: Int
    /// The line bytes without the terminating 0x0A.
    public let bytes: [UInt8]
    public let fields: [String: JSONValue]

    public func int(_ key: String) -> Int64? { fields[key]?.int64 }
}

public enum IndexScanOutcome: Equatable {
    case clean
    /// A torn trailing line (no 0x0A). Repair truncates to `repairedLength`.
    case tornTail(repairedLength: Int, droppedBytes: Int)
}

public struct IndexScan {
    public let lines: [IndexLine]
    public let outcome: IndexScanOutcome
}

/// tape.idx: newline-delimited JSON, one object per line, append-only.
public enum IndexLog {
    /// Reads every complete line. A torn tail is reported, not an error.
    /// An empty complete line is a hard error, as is a complete line that is not a JSON object.
    public static func scan(_ data: [UInt8]) throws -> IndexScan {
        var lines: [IndexLine] = []
        var start = 0
        var number = 0
        for i in data.indices where data[i] == 0x0A {
            number += 1
            let bytes = Array(data[start..<i])
            if bytes.isEmpty { throw IndexLogError.interiorBlankLine(line: number) }
            let fields: [String: JSONValue]
            do {
                fields = try IndexLineCodec.decodeObject(bytes)
            } catch {
                throw IndexLogError.invalidRecord(line: number, reason: "\(error)")
            }
            lines.append(IndexLine(number: number, bytes: bytes, fields: fields))
            start = i + 1
        }
        if start < data.count {
            return IndexScan(lines: lines, outcome: .tornTail(repairedLength: start, droppedBytes: data.count - start))
        }
        return IndexScan(lines: lines, outcome: .clean)
    }

    /// Repairs a log file in place: a torn tail is truncated away; anything else is left untouched.
    public static func repair(fileAt url: URL) throws -> IndexScanOutcome {
        let data = [UInt8](try Data(contentsOf: url))
        let scan = try scan(data)
        if case .tornTail(let length, _) = scan.outcome {
            let h = try FileHandle(forWritingTo: url)
            defer { try? h.close() }
            try h.truncate(atOffset: UInt64(length))
            try h.synchronize()
        }
        return scan.outcome
    }
}
