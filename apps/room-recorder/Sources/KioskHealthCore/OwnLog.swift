import Foundation

/// The daemon's own log (/var/log/eta-kiosk-health.log), rotated at 5 MB, keeping 3 old files.
final class OwnLog {
    let path: String
    let maxBytes: Int
    let keep: Int
    private let lock = NSLock()

    init(path: String, maxBytes: Int = 5 * 1024 * 1024, keep: Int = 3) {
        self.path = path
        self.maxBytes = maxBytes
        self.keep = keep
    }

    /// Shift path -> path.1 -> path.2 ... dropping the oldest. Returns true if it rotated.
    @discardableResult
    static func rotate(path: String, maxBytes: Int, keep: Int) -> Bool {
        let fm = FileManager.default
        guard FS.size(path) >= maxBytes else { return false }
        try? fm.removeItem(atPath: "\(path).\(keep)")
        if keep > 1 {
            for i in stride(from: keep - 1, through: 1, by: -1) {
                if fm.fileExists(atPath: "\(path).\(i)") { try? fm.moveItem(atPath: "\(path).\(i)", toPath: "\(path).\(i + 1)") }
            }
        }
        try? fm.moveItem(atPath: path, toPath: "\(path).1")
        return true
    }

    /// launchd's stderr file: startup failures land there (the daemon's own log may not be writable yet). Cut to zero
    /// at start when it has grown past `maxBytes`, so a restart loop cannot fill the disk. Returns true if cut.
    static let stderrPath = "/var/log/eta-kiosk-health.err"
    @discardableResult
    static func truncateIfLarge(path: String, maxBytes: Int = 1024 * 1024) -> Bool {
        guard FS.size(path) > maxBytes else { return false }
        return truncate(path, 0) == 0
    }

    func write(_ level: String, _ msg: String) {
        lock.lock(); defer { lock.unlock() }
        OwnLog.rotate(path: path, maxBytes: maxBytes, keep: keep)
        let line = "\(TimeFmt.iso(Date())) \(level) \(msg)\n"
        guard let data = line.data(using: .utf8) else { return }
        let fm = FileManager.default
        if !fm.fileExists(atPath: path) { fm.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        if let h = FileHandle(forWritingAtPath: path) {
            _ = try? h.seekToEnd()
            try? h.write(contentsOf: data)
            try? h.close()
        } else {
            FileHandle.standardError.write(data)
        }
    }

    func info(_ m: String) { write("INFO", m) }
    func warn(_ m: String) { write("WARN", m) }
    func error(_ m: String) { write("ERROR", m) }
}
