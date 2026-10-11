import Foundation

/// Everything a collector needs from the outside world. Tests build one with fakes.
final class Context {
    let config: Config
    let runner: CommandRunner
    let clock: Clock
    let sleeper: Sleeper
    let state: StateStore
    /// Override for tests; otherwise derived from the console user.
    var homeOverride: String?
    var selfPath: String = selfExecutablePath()

    init(config: Config, runner: CommandRunner, clock: Clock = SystemClock(), sleeper: Sleeper = RealSleeper(),
         state: StateStore = MemoryState(), homeOverride: String? = nil) {
        self.config = config
        self.runner = runner
        self.clock = clock
        self.sleeper = sleeper
        self.state = state
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
