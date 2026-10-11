import Foundation

struct CommandResult {
    var status: Int32 = -1
    var stdout: String = ""
    var stderr: String = ""
    var timedOut = false
    var launchError: String? = nil
    var ok: Bool { status == 0 && !timedOut && launchError == nil }
    var failureNote: String {
        if let e = launchError { return "launch failed: \(e)" }
        if timedOut { return "timed out" }
        return "exit \(status): \(stderr.trimmed.truncated(160))"
    }
}

protocol CommandRunner {
    func run(_ exe: String, _ args: [String], timeout: TimeInterval) -> CommandResult
}

private final class DataBox {
    var data = Data()
}

/// Runs a subprocess with a hard timeout. Never uses a shell; always absolute executable paths.
final class ProcessRunner: CommandRunner {
    /// The helper port (0.1.36) runs READ-ONLY tools only. Anything not in `Tool.all` is refused without a launch.
    /// Only a test passes a wider set.
    let allowed: Set<String>
    init(allowed: Set<String> = Tool.all) { self.allowed = allowed }

    func run(_ exe: String, _ args: [String], timeout: TimeInterval) -> CommandResult {
        guard allowed.contains(exe) else {
            return CommandResult(status: -1, stdout: "", stderr: "", timedOut: false, launchError: "tool not allowed: \(exe)")
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8"]
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch {
            return CommandResult(status: -1, stdout: "", stderr: "", timedOut: false, launchError: "\(error)")
        }
        // Dedicated threads (not the GCD pool): blocking pipe reads on pool threads can starve the pool when
        // several collectors shell out at once, which showed up as spurious "timed out" results.
        let outBox = DataBox(), errBox = DataBox()
        let group = DispatchGroup()
        group.enter()
        Thread.detachNewThread {
            outBox.data = out.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        group.enter()
        Thread.detachNewThread {
            errBox.data = err.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        // Poll for exit instead of waitUntilExit(): no run-loop dependency, exact timeout control.
        let started = Date()
        var timedOut = false
        while p.isRunning {
            let elapsed = Date().timeIntervalSince(started)
            if elapsed >= timeout { timedOut = true; break }
            usleep(elapsed < 0.5 ? 5_000 : 25_000)
        }
        if timedOut {
            p.terminate()
            let t0 = Date()
            while p.isRunning && Date().timeIntervalSince(t0) < 2 { usleep(10_000) }
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
            let t1 = Date()
            while p.isRunning && Date().timeIntervalSince(t1) < 2 { usleep(10_000) }
        }
        _ = group.wait(timeout: .now() + 3)
        let status: Int32 = p.isRunning ? -1 : p.terminationStatus
        return CommandResult(status: status,
                             stdout: String(decoding: outBox.data, as: UTF8.self),
                             stderr: String(decoding: errBox.data, as: UTF8.self),
                             timedOut: timedOut, launchError: nil)
    }
}

/// Absolute paths of every external tool the daemon uses.
enum Tool {
    static let pmset = "/usr/bin/pmset"
    static let ioreg = "/usr/sbin/ioreg"
    static let systemProfiler = "/usr/sbin/system_profiler"
    static let log = "/usr/bin/log"
    static let pgrep = "/usr/bin/pgrep"
    static let defaults = "/usr/bin/defaults"
    static let stat = "/usr/bin/stat"
    static let ps = "/bin/ps"
    static let plutil = "/usr/bin/plutil"
    /// The whole list. The standalone daemon also had caffeinate, killall and shutdown for its DarkWake watchdog, audio
    /// ladder and reboot rung; those actions are NOT part of this port, and neither are their tools.
    static let all: Set<String> = [pmset, ioreg, systemProfiler, log, pgrep, defaults, stat, ps, plutil]
}

/// Path of the running binary, so helper sub-commands can be spawned in a crash-isolated child.
func selfExecutablePath() -> String {
    if let p = Bundle.main.executablePath { return p }
    let a = CommandLine.arguments[0]
    return a.hasPrefix("/") ? a : FileManager.default.currentDirectoryPath + "/" + a
}
