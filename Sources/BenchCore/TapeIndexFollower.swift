import Foundation
#if canImport(Glibc)
import Glibc
#endif

/// tape.idx read from where the last read stopped (the Mac's `TapeIndexTail`): complete lines only, an offset that is
/// never carried across to a different or rewritten file.
///
/// Before reading on, it checks the file is still the one it was reading — same inode, at least as long as what was
/// consumed, and holding, just before the offset, the exact bytes of the last line consumed. Any of those failing starts
/// again from the top and says so, through `reset`.
public final class TapeIndexFollower: @unchecked Sendable {
    public let path: String
    private var consumed: UInt64 = 0
    private var anchor = Data()
    private var inode: UInt64?
    /// Set when the last read had to start again from the top.
    public private(set) var didReset = false
    /// Lines that did not decode, over this reader's life.
    public private(set) var undecodableLines = 0

    public init(path: String) { self.path = path }

    /// New complete records since the last call.
    public func readNew() -> [TapeRecord] {
        didReset = false
        var info = stat()
        guard stat(path, &info) == 0, info.st_mode & S_IFMT == S_IFREG else {
            forget()
            return []
        }
        let size = UInt64(info.st_size)
        if UInt64(info.st_ino) != inode || size < consumed {
            if inode != nil { didReset = true }
            forget()
            inode = UInt64(info.st_ino)
        }
        guard size > consumed else { return [] }
        let fd = open(path, O_RDONLY | O_CLOEXEC)
        guard fd >= 0 else { return [] }
        defer { close(fd) }
        let start = consumed - UInt64(anchor.count)
        var data = Data(count: Int(size - start))
        let got = data.withUnsafeMutableBytes { pread(fd, $0.baseAddress!, $0.count, off_t(start)) }
        guard got > 0 else { return [] }
        data.count = got
        if !anchor.isEmpty {
            guard data.starts(with: anchor) else {
                didReset = true
                forget()
                inode = UInt64(info.st_ino)
                return readNew()
            }
            data.removeFirst(anchor.count)
        }
        guard let lastNewline = data.lastIndex(of: 0x0A) else { return [] }
        let committed = data[data.startIndex...lastNewline]
        consumed += UInt64(committed.count)
        var records: [TapeRecord] = []
        let decoder = JSONDecoder()
        var lineStart = committed.startIndex
        var lastLineStart = committed.startIndex
        for i in committed.indices where committed[i] == 0x0A {
            let line = committed[lineStart..<i]
            if !line.isEmpty {
                if let record = try? decoder.decode(TapeRecord.self, from: Data(line)) {
                    records.append(record)
                } else {
                    undecodableLines += 1
                }
            }
            lastLineStart = lineStart
            lineStart = committed.index(after: i)
        }
        anchor = Data(committed[lastLineStart...lastNewline])
        return records
    }

    private func forget() {
        consumed = 0
        anchor = Data()
        inode = nil
    }
}
