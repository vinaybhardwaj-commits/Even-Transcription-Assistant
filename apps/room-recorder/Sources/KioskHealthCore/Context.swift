import Foundation

/// Everything a collector needs from the outside world. Tests build one with fakes.
final class Context {
    let config: Config
    let runner: CommandRunner
    let clock: Clock
    let sleeper: Sleeper
    let state: StateStore
    /// EVERY read, stat and listing of a path the room user controls goes through this (0.1.36 R2). No default: a caller
    /// must say how, and production says "as the room user, on a privilege-dropped thread".
    let files: UserFileAccess
    /// Override for tests; otherwise derived from the console user.
    var homeOverride: String?
    var selfPath: String = selfExecutablePath()

    init(config: Config, runner: CommandRunner, clock: Clock = SystemClock(), sleeper: Sleeper = RealSleeper(),
         state: StateStore = MemoryState(), files: UserFileAccess, homeOverride: String? = nil) {
        self.config = config
        self.runner = runner
        self.clock = clock
        self.sleeper = sleeper
        self.state = state
        self.files = files
        self.homeOverride = homeOverride
    }

    /// Always Asia/Kolkata: the night window is a clinic-hours safety rule, not a setting.
    var timeZone: TimeZone { LadderPolicy.timeZone }

    /// config.console_user, else the owner of /dev/console. "root"/"loginwindow" mean nobody is logged in.
    func consoleUser() -> String? {
        if let u = config.consoleUser, !u.isEmpty { return u }
        let r = runner.run(Tool.stat, ["-f%Su", "/dev/console"], timeout: 5)
        let u = r.stdout.trimmed
        guard r.ok, !u.isEmpty, u != "root", u != "loginwindow" else { return nil }
        return u
    }

    /// Who owns /dev/console right now, ignoring config.console_user (which names the kiosk's user even when
    /// nobody is logged in). nil at the login window.
    func liveConsoleUser() -> String? {
        let r = runner.run(Tool.stat, ["-f%Su", "/dev/console"], timeout: 5)
        let u = r.stdout.trimmed
        guard r.ok, !u.isEmpty, u != "root", u != "loginwindow" else { return nil }
        return u
    }

    func consoleHome() -> String? {
        if let h = homeOverride { return h }
        guard let u = consoleUser() else { return nil }
        return NSHomeDirectory().hasSuffix("/\(u)") ? NSHomeDirectory() : "/Users/\(u)"
    }

    func recorderDir() -> String? {
        consoleHome().map { $0 + "/Library/Application Support/EvenScribe/RoomRecorder" }
    }
}

/// The console user's view of the disk: the same four calls as `UserFileAccess`, with the user bound in.
struct UserIO {
    let files: UserFileAccess
    let user: String

    func info(_ path: String) -> UserFileInfo? { files.info(path, user: user) }
    func readWhole(_ path: String, maxBytes: Int) -> Data? { files.readWhole(path, user: user, maxBytes: maxBytes) }
    func readRange(_ path: String, offset: UInt64, maxBytes: Int) -> Data? { files.readRange(path, user: user, offset: offset, maxBytes: maxBytes) }
    func entries(_ path: String) -> [String]? { files.entries(path, user: user) }

    func isDirectory(_ path: String) -> Bool { info(path)?.isDirectory == true }
    /// A plain file with one link: the only kind of file a collector reads.
    func isPlainFile(_ path: String) -> Bool { info(path).map { $0.isRegular && $0.nlink == 1 } ?? false }
    func mtime(_ path: String) -> Date? { info(path)?.mtime }
}

extension Context {
    /// nil when nobody is logged in: there is then no user to read as, and nothing under a home is read.
    func userIO() -> UserIO? { consoleUser().map { UserIO(files: files, user: $0) } }
}
