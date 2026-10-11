import Foundation

/// One daemon per state dir. Two instances sharing a spool corrupt each other's view of it (an orphan started outside launchd
/// ran beside the launchd job on one kiosk for hours), so the daemon takes an exclusive, non-blocking flock(2) on
/// `<state dir>/daemon.lock` before it touches anything else. The kernel drops the lock when the process dies, however it dies,
/// so a crash never leaves a stale lock behind. The pid inside the file is for people reading it, not part of the protocol.
final class InstanceLock {
    static let fileName = "daemon.lock"
    private var fd: Int32

    private init(fd: Int32) { self.fd = fd }

    /// nil when another process (or another holder in this one) already holds the lock, or the lock file cannot be opened.
    static func acquire(dir: String) -> InstanceLock? {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        let fd = open(dir + "/" + fileName, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return nil }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); return nil }
        // Only the holder writes its pid; a refused instance leaves the file exactly as it was.
        _ = ftruncate(fd, 0)
        let text = "\(getpid())\n"
        _ = text.withCString { pwrite(fd, $0, strlen($0), 0) }
        return InstanceLock(fd: fd)
    }

    func release() {
        guard fd >= 0 else { return }
        flock(fd, LOCK_UN)
        close(fd)
        fd = -1
    }

    deinit { release() }
}

/// What `Daemon.init` throws when it cannot take the lock; main.swift turns it into exit status 3.
struct AlreadyRunning: Error, CustomStringConvertible {
    let dir: String
    var description: String { "another kiosk-health instance holds \(dir)/\(InstanceLock.fileName)" }
}
