import Darwin
import Foundation

// 0.1.36 R2 (B1). The collectors read files that the ROOM USER controls: the recorder's logs and status.json under the
// user's home, Chrome's Local State and extension directories, the recorder app's Info.plist in a user-owned bundle.
// A root process that opens such a path follows whatever the user put there (a symlink, a hard link to a root-only
// file, a FIFO), and the lines it reads leave the Mac. So NOTHING in this module touches a user path as root:
// every read, stat and listing goes through `UserFileAccess`, whose production implementation (in HelperCore) runs
// `HardenedFile` on a thread that has taken the room user's identity. The kernel then refuses what the user could not
// read, whatever the user planted. `HardenedFile` adds the checks that hold even for the user's own files.

public struct UserFileInfo: Equatable, Sendable {
    public var size: UInt64
    public var mtime: Date
    public var created: Date?
    public var inode: UInt64
    public var nlink: UInt16
    public var isRegular: Bool
    public var isDirectory: Bool
    public var isSymlink: Bool
    /// Permission bits (`st_mode & 0o7777`).
    public var mode: UInt16
}

public protocol UserFileAccess: Sendable {
    /// `lstat` as `user`: a symlink reports itself (`isSymlink`), never its target. Nil when missing or not visible to the user.
    func info(_ path: String, user: String) -> UserFileInfo?
    /// A whole plain file, at most `maxBytes` (a larger file is nil, not truncated). Nil for anything that is not a plain file
    /// with exactly one link: a symlink, a hard-linked file, a FIFO, a device, a directory.
    func readWhole(_ path: String, user: String, maxBytes: Int) -> Data?
    /// Up to `maxBytes` of a plain, singly-linked file from `offset`.
    func readRange(_ path: String, user: String, offset: UInt64, maxBytes: Int) -> Data?
    /// Where a symlink points, read as `user`. Nil when it is not a symlink.
    func linkTarget(_ path: String, user: String) -> String?
    /// Entry names of a plain directory (not a symlink to one), without `.` and `..`, at most 2,000.
    func entries(_ path: String, user: String) -> [String]?
}

/// The syscalls, with no notion of who runs them. Callers either run these on a privilege-dropped thread (production) or
/// in a process that is not root (tests, via `UnprivilegedUserFiles`).
public enum HardenedFile {
    public static let maxEntries = 2_000

    public static func info(_ path: String) -> UserFileInfo? {
        var s = stat()
        guard lstat(path, &s) == 0 else { return nil }
        let mode = s.st_mode & S_IFMT
        func date(_ t: timespec) -> Date { Date(timeIntervalSince1970: TimeInterval(t.tv_sec) + TimeInterval(t.tv_nsec) / 1e9) }
        return UserFileInfo(
            size: UInt64(max(s.st_size, 0)), mtime: date(s.st_mtimespec), created: date(s.st_birthtimespec), inode: UInt64(s.st_ino),
            nlink: s.st_nlink, isRegular: mode == S_IFREG, isDirectory: mode == S_IFDIR, isSymlink: mode == S_IFLNK,
            mode: UInt16(s.st_mode & 0o7777))
    }

    /// Opens without following a final symlink and without blocking on a FIFO, then checks the OPEN descriptor (not the
    /// path): a plain file with a single link.
    static func openPlain(_ path: String) -> (fd: Int32, size: UInt64)? {
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { return nil }
        var s = stat()
        guard fstat(fd, &s) == 0, (s.st_mode & S_IFMT) == S_IFREG, s.st_nlink == 1 else {
            close(fd)
            return nil
        }
        return (fd, UInt64(max(s.st_size, 0)))
    }

    public static func readWhole(_ path: String, maxBytes: Int) -> Data? {
        guard let (fd, size) = openPlain(path) else { return nil }
        defer { close(fd) }
        guard size <= UInt64(maxBytes) else { return nil }
        return read(fd, offset: 0, count: Int(size))
    }

    public static func readRange(_ path: String, offset: UInt64, maxBytes: Int) -> Data? {
        guard let (fd, size) = openPlain(path) else { return nil }
        defer { close(fd) }
        guard offset <= size else { return Data() }
        return read(fd, offset: offset, count: Int(min(UInt64(maxBytes), size - offset)))
    }

    private static func read(_ fd: Int32, offset: UInt64, count: Int) -> Data? {
        var data = Data(count: count)
        var done = 0
        while done < count {
            let n = data.withUnsafeMutableBytes { pread(fd, $0.baseAddress! + done, count - done, off_t(offset) + off_t(done)) }
            if n < 0 { return nil }
            if n == 0 { break }
            done += n
        }
        return data.prefix(done)
    }

    public static func linkTarget(_ path: String) -> String? {
        var s = stat()
        guard lstat(path, &s) == 0, (s.st_mode & S_IFMT) == S_IFLNK else { return nil }
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX) + 1)
        let n = readlink(path, &buffer, Int(PATH_MAX))
        guard n > 0 else { return nil }
        return String(cString: Array(buffer.prefix(n)) + [0])
    }

    public static func entries(_ path: String) -> [String]? {
        var s = stat()
        guard lstat(path, &s) == 0, (s.st_mode & S_IFMT) == S_IFDIR, let dir = opendir(path) else { return nil }
        defer { closedir(dir) }
        var names: [String] = []
        while let entry = readdir(dir), names.count < maxEntries {
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(cString: $0) }
            }
            if name == "." || name == ".." { continue }
            names.append(name)
        }
        return names
    }
}

/// For a process that is NOT root (the unit tests): the same checks, run as the caller. It REFUSES to act as root, so it
/// can never be the production reader by mistake.
public struct UnprivilegedUserFiles: UserFileAccess {
    public init() {}
    private var allowed: Bool { geteuid() != 0 }
    public func info(_ path: String, user: String) -> UserFileInfo? { allowed ? HardenedFile.info(path) : nil }
    public func readWhole(_ path: String, user: String, maxBytes: Int) -> Data? { allowed ? HardenedFile.readWhole(path, maxBytes: maxBytes) : nil }
    public func readRange(_ path: String, user: String, offset: UInt64, maxBytes: Int) -> Data? {
        allowed ? HardenedFile.readRange(path, offset: offset, maxBytes: maxBytes) : nil
    }
    public func linkTarget(_ path: String, user: String) -> String? { allowed ? HardenedFile.linkTarget(path) : nil }
    public func entries(_ path: String, user: String) -> [String]? { allowed ? HardenedFile.entries(path) : nil }
}
