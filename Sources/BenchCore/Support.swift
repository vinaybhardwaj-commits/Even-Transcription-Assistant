import Foundation
#if canImport(Glibc)
import Glibc
#endif

/// Lifecycle, identity, errors and counts to the journal — never a token, never a sample value. The last lines are kept
/// in memory for `report_diag`, redacted again when read out.
public final class RoomLog: @unchecked Sendable {
    public static let keptLines = 500
    private let lock = NSLock()
    private var lines: [String] = []
    private let sink: @Sendable (String) -> Void

    public init(sink: @escaping @Sendable (String) -> Void = { FileHandle.standardError.write(Data(("room-bench: " + $0 + "\n").utf8)) }) {
        self.sink = sink
    }

    public func callAsFunction(_ message: String) {
        let line = "\(ISO8601.string(Date())) \(message)"
        lock.withLock {
            lines.append(line)
            if lines.count > Self.keptLines { lines.removeFirst(lines.count - Self.keptLines) }
        }
        sink(message)
    }

    public func tail(_ count: Int) -> [String] {
        lock.withLock { Array(lines.suffix(max(0, count))) }
    }
}

public enum ISO8601 {
    /// `2026-09-16T08:10:02.123Z`: UTC, milliseconds — the Mac's `[.withInternetDateTime, .withFractionalSeconds]`.
    public static func string(_ date: Date) -> String {
        string(milliseconds: Int64((date.timeIntervalSince1970 * 1_000).rounded()))
    }

    public static func string(milliseconds ms: Int64) -> String {
        var seconds = time_t(ms >= 0 ? ms / 1_000 : (ms - 999) / 1_000)
        let millis = Int(ms - Int64(seconds) * 1_000)
        var parts = tm()
        gmtime_r(&seconds, &parts)
        func pad(_ v: Int32, _ n: Int) -> String {
            let s = String(v)
            return String(repeating: "0", count: max(0, n - s.count)) + s
        }
        return "\(pad(parts.tm_year + 1900, 4))-\(pad(parts.tm_mon + 1, 2))-\(pad(parts.tm_mday, 2))T"
            + "\(pad(parts.tm_hour, 2)):\(pad(parts.tm_min, 2)):\(pad(parts.tm_sec, 2)).\(pad(Int32(millis), 3))Z"
    }
}

/// Injected so tests run the loop without real time passing.
public protocol Sleeper: Sendable {
    func sleep(nanoseconds: UInt64) async throws
}

public struct TaskSleeper: Sleeper {
    public init() {}
    public func sleep(nanoseconds: UInt64) async throws { try await Task.sleep(nanoseconds: nanoseconds) }
}

func bounded(_ error: Error, limit: Int = 500) -> String {
    String(String(describing: error).prefix(limit))
}

/// Free bytes on the filesystem holding `path`, or nil. NIL, NEVER 0 (InstallPollFields.swift `freeBytes`).
public func freeBytes(onFilesystemHolding path: String) -> Int64? {
    var info = statvfs()
    guard statvfs(path, &info) == 0 else { return nil }
    let bytes = Int64(info.f_bavail) * Int64(info.f_frsize)
    return bytes > 0 ? bytes : nil
}
