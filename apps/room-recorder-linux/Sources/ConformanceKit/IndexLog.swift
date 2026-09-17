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
    /// A numeric field as Double, whether written as an integer (48000) or not.
    public func double(_ key: String) -> Double? {
        switch fields[key] {
        case .int(let v)?: return Double(v)
        case .double(let v)?: return v
        default: return nil
        }
    }
}

public enum IndexScanOutcome: Equatable, Sendable {
    case clean
    /// A torn trailing line (no 0x0A). Repair truncates to `repairedLength`.
    case tornTail(repairedLength: Int, droppedBytes: Int)
}

public struct IndexScan {
    public let lines: [IndexLine]
    public let outcome: IndexScanOutcome
}

/// What a repair did to the file.
public struct IndexRepair: Equatable, Sendable {
    public var outcome: IndexScanOutcome
    /// Whether the file was ever opened for writing. A clean log must not be (Mac TapeFormat.swift:136-144: the guard is
    /// false, discarded is 0, and FileHandle(forWritingTo:) is never reached).
    public var openedForWriting: Bool
}

/// tape.idx: newline-delimited JSON, one object per line, append-only. Mac TapeFormat.swift:135-154: a final line with no
/// 0x0A is ALWAYS excluded from the parse (committedLength walks back to the last 0x0A, or 0); it is truncated on disk only
/// when repairTrailingPartial is true, which the writer passes on open (TapeWriter.swift:137). A reader never truncates.
public enum IndexLog {
    /// The reader: every complete line. A torn tail is reported and excluded, never an error and never repaired.
    /// An empty complete line fails the whole read, as does a complete line that is not a JSON object
    /// (TapeFormat.swift:170-175: TapeError.malformedIndex "empty interior record").
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

    /// The writer's open path (repairTrailingPartial, Mac TapeWriter.swift:137): a torn tail is truncated away; anything
    /// else leaves the file untouched and unopened for writing.
    public static func repair(fileAt url: URL) throws -> IndexRepair {
        let data = [UInt8](try Data(contentsOf: url))
        let scan = try scan(data)
        guard case .tornTail(let length, _) = scan.outcome else {
            return IndexRepair(outcome: scan.outcome, openedForWriting: false)
        }
        let h = try FileHandle(forWritingTo: url)
        defer { try? h.close() }
        try h.truncate(atOffset: UInt64(length))
        try h.synchronize()
        return IndexRepair(outcome: scan.outcome, openedForWriting: true)
    }
}
