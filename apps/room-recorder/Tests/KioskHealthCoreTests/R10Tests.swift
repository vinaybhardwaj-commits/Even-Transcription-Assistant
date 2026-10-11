import Foundation
@testable import KioskHealthCore

// Round-10: one daemon per state dir (flock on <state dir>/daemon.lock). The process-level behaviour (exit status, one ERROR
// line, spool untouched, stale lock after a kill) is checked against the built binary in Tests/install_test.sh.

func runR10Tests() {
    test("R10 lock: first acquire wins, a second holder is refused, release and deinit free it") {
        let dir = tmpDir("r10lock").path + "/state"   // does not exist yet: acquire creates it
        var a: InstanceLock? = InstanceLock.acquire(dir: dir)
        check(a != nil)
        check(FileManager.default.fileExists(atPath: dir + "/daemon.lock"))
        check(InstanceLock.acquire(dir: dir) == nil, "a second instance on the same state dir is refused")
        check(InstanceLock.acquire(dir: dir) == nil, "and again")
        a?.release()
        let b = InstanceLock.acquire(dir: dir)
        check(b != nil, "free after release")
        check(InstanceLock.acquire(dir: dir) == nil)
        a = nil
        check(InstanceLock.acquire(dir: dir) == nil, "releasing an already released lock does not free b's")
        b?.release()
        var c: InstanceLock? = InstanceLock.acquire(dir: dir)
        check(c != nil)
        c = nil   // deinit closes the fd
        check(InstanceLock.acquire(dir: dir) != nil, "free after the holder is gone")
    }

    test("R10 lock: the lock file is 0600, holds the holder's pid, and a refused instance leaves it untouched") {
        let dir = tmpDir("r10pid").path
        let holder = InstanceLock.acquire(dir: dir)!
        let path = dir + "/daemon.lock"
        let mode = ((try? FileManager.default.attributesOfItem(atPath: path))?[.posixPermissions] as? NSNumber)?.intValue
        checkEq(mode, 0o600)
        let before = String(decoding: FileManager.default.contents(atPath: path) ?? Data(), as: UTF8.self)
        checkEq(before.trimmingCharacters(in: .whitespacesAndNewlines), "\(getpid())")
        check(InstanceLock.acquire(dir: dir) == nil)
        let after = String(decoding: FileManager.default.contents(atPath: path) ?? Data(), as: UTF8.self)
        checkEq(after, before, "the refused instance did not rewrite the pid")
        _ = holder
    }

    test("R10 lock: different state dirs do not block each other; an unusable dir is refused, not crashed on") {
        let a = InstanceLock.acquire(dir: tmpDir("r10a").path)
        let b = InstanceLock.acquire(dir: tmpDir("r10b").path)
        check(a != nil && b != nil)
        check(InstanceLock.acquire(dir: "/dev/null/not-a-dir") == nil)
    }

    test("R10 lock: the refusal error names the lock file") {
        let e = AlreadyRunning(dir: "/var/db/eta-kiosk-health/spool")
        check(e.description.contains("/var/db/eta-kiosk-health/spool/daemon.lock"))
        check(e.description.contains("another kiosk-health instance"))
    }
}
