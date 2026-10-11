import Foundation

/// The kiosk-health collectors (power, display, assertions, audio, HID, drift, recorder logs, Chrome, heartbeat) running
/// inside the root helper (#47, 0.1.36).
///
/// This is the standalone daemon's `Daemon` with three differences, all deliberate:
///  · NO ACTIONS. The DarkWake watchdog, the audio ladder and the reboot rung are not here. This engine observes and
///    reports; it never kills coreaudiod, wakes the display or reboots. (The standalone daemon keeps doing those until
///    that is ruled on separately.)
///  · NO NETWORK. The helper holds no server credential. Events go to a root-only spool, and the APP, which does hold
///    one, takes batches (`nextBatch`), posts them with the device JWT, and reports what the sink said (`complete`).
///    The sink's answer is handled by the same code the standalone transport uses: ack on 200, halve on 413,
///    quarantine on 400, pause an hour on 401, back off on anything else.
///  · `source` is `"helper"`. Everything else in the envelope, and every event kind, is the standalone daemon's.
public final class KioskHealthEngine: @unchecked Sendable {
    /// pmset's log is parsed this often, and again shortly after every IOKit power callback.
    public static let powerPollInterval: TimeInterval = 5 * 60
    public static let source = "helper"
    /// The standalone daemon's config. Read-only, and only for what keeps the two streams comparable: who the machine
    /// is (`machine`, `room_id`, `install_id`), the console user, the recorder path and the power baseline. Its token,
    /// sink URL, post flag and action flags are never read into this engine.
    public static let legacyConfigPath = Config.defaultPath

    /// One batch for the app to post.
    public struct Batch: Equatable, Sendable {
        public let id: String
        public let body: Data
        public let count: Int
    }

    let config: Config
    private let log: OwnLog
    private let spool: Spool
    private let emitter: Emitter
    private let transport: Transport
    private let ctx: Context
    private let instanceLock: InstanceLock
    private let notifier = PowerNotifier()

    private let power: PowerCollector
    private let display: DisplayCollector
    private let assertions: AssertionsCollector
    private let audio: AudioCollector
    private let hid: HIDCollector
    private let drift: DriftCollector
    private let recorder: RecorderLogCollector
    private let chrome: ChromeCollector
    private let heartbeat: HeartbeatCollector

    private var timers: [DispatchSourceTimer] = []
    private let pollLock = NSLock()
    private var powerPollPending = false
    private var audioProfileCount = 0
    private let errLock = NSLock()
    private var errorCounts: [String: Int] = [:]
    private var lastNote: [String: String] = [:]
    private let queues: [String: DispatchQueue]
    private var started = false

    /// Production: the identity comes from the standalone daemon's config when there is one, else the host name.
    public convenience init(stateDir: String, logPath: String, legacyConfigPath: String = KioskHealthEngine.legacyConfigPath) throws {
        var config = Config(machine: Config.defaultMachine())
        let legacy = Config.load(path: legacyConfigPath)
        if FileManager.default.fileExists(atPath: legacyConfigPath) {
            config.machine = legacy.machine
            config.roomID = legacy.roomID
            config.installID = legacy.installID
            config.consoleUser = legacy.consoleUser
            config.recorderAppPath = legacy.recorderAppPath
            config.baseline = legacy.baseline
        }
        config.source = Self.source
        config.actions = Actions(darkwakeWatchdog: false, audioLadder: false, rebootRung: false)  // this engine has no actions
        // `post` here means "events leave this Mac", which they do, through the app. It picks the spool's size caps.
        config.post = true
        config.token = nil
        config.spoolDir = stateDir
        config.logPath = logPath
        try self.init(config: config, runner: ProcessRunner(), clock: SystemClock())
    }

    init(config: Config, runner: CommandRunner, clock: Clock) throws {
        self.config = config
        log = OwnLog(path: config.logPath)
        guard let lock = InstanceLock.acquire(dir: config.spoolDir) else {
            let err = AlreadyRunning(dir: config.spoolDir)
            log.error("\(err); this instance exits without touching the spool")
            throw err
        }
        instanceLock = lock
        let dir = URL(fileURLWithPath: config.spoolDir)
        spool = try Spool(dir: dir, capBytes: Spool.defaultCap(post: config.post),
                          protectedCeilingBytes: Spool.defaultProtectedCeiling(post: config.post))
        let state = FileState(url: dir.appendingPathComponent("state.json"))
        ctx = Context(config: config, runner: runner, state: state)

        let boot = currentBootID()
        let seqStore = SeqStore(dir: dir)
        let start = max(seqStore.load(bootID: boot), spool.maxSeq(bootID: boot))
        emitter = Emitter(config: config, bootID: boot, clock: clock, sink: spool, startSeq: start, seqStore: seqStore)
        // The poster is never used: the app posts, the engine only applies the answer (`complete`).
        transport = Transport(config: config, spool: spool, poster: NoNetworkPoster(), clock: clock)

        power = PowerCollector(ctx: ctx)
        display = DisplayCollector(ctx: ctx)
        assertions = AssertionsCollector(ctx: ctx)
        audio = AudioCollector(ctx: ctx)
        hid = HIDCollector(ctx: ctx, assertions: assertions)
        drift = DriftCollector(ctx: ctx)
        recorder = RecorderLogCollector(ctx: ctx)
        chrome = ChromeCollector(ctx: ctx)
        heartbeat = HeartbeatCollector(ctx: ctx)

        var q: [String: DispatchQueue] = [:]
        for n in ["power", "assert", "audio", "audiolog", "hid", "drift", "recorder", "chrome", "heartbeat", "flush", "misc"] {
            q[n] = DispatchQueue(label: "kh.\(n)")
        }
        queues = q

        emitter.onError = { [weak self] m in self?.log.error(m) }
        chrome.hidIdle = { [hid] in hid.sampleIdle() }
        heartbeat.spoolDepth = { [spool] in spool.depth }
        heartbeat.spoolDropped = { [spool] in spool.droppedTotal }
        heartbeat.lastPostOK = { [transport] in transport.lastPostOK }
        heartbeat.lastPost = { [transport] in transport.lastPost }
        transport.onLog = { [weak self] level, m in
            switch level {
            case "ERROR": self?.log.error(m)
            case "WARN": self?.log.warn(m)
            default: self?.log.info(m)
            }
        }
        heartbeat.collectorErrors = { [weak self] in self?.snapshotErrors() ?? [:] }
    }

    private func snapshotErrors() -> [String: Int] {
        errLock.lock(); defer { errLock.unlock() }
        return errorCounts
    }

    /// Emit a collector's events and record (once per distinct message) why it was degraded.
    private func handle(_ name: String, _ r: CollectorResult) {
        emitter.emit(r.events)
        if r.degraded {
            errLock.lock(); errorCounts[name, default: 0] += 1; errLock.unlock()
        }
        let note = r.notes.joined(separator: "; ")
        errLock.lock()
        let changed = lastNote[name] != note
        lastNote[name] = note
        errLock.unlock()
        if changed && !note.isEmpty { log.warn("\(name): \(note)") }
    }

    private func every(_ interval: TimeInterval, queue: String, startAfter: TimeInterval = 1, _ block: @escaping () -> Void) {
        guard let q = queues[queue] else { return }
        let t = DispatchSource.makeTimerSource(queue: q)
        t.schedule(deadline: .now() + startAfter, repeating: interval, leeway: .milliseconds(500))
        t.setEventHandler { autoreleasepool { block() } }
        t.resume()
        timers.append(t)
    }

    // MARK: power-notifier handling

    /// pmset's log is parsed every 5 minutes and, in addition, shortly after any IOKit power callback (the log line
    /// for the transition appears a moment after the callback). Coalesced: one pending poll at a time.
    private func schedulePowerPoll(after delay: TimeInterval = 2) {
        pollLock.lock()
        if powerPollPending { pollLock.unlock(); return }
        powerPollPending = true
        pollLock.unlock()
        queues["power"]?.asyncAfter(deadline: .now() + delay) { [self] in
            pollLock.lock(); powerPollPending = false; pollLock.unlock()
            powerTick()
        }
    }

    private func onPowerMessage(_ msg: UInt32) {
        schedulePowerPoll()
        guard let kind = PowerMsg.eventKind(msg) else { return }
        emitter.emit(DraftEvent(kind, ["origin": "iokit", "message": PowerMsg.name(msg) ?? "unknown"]))
        if msg == PowerMsg.systemHasPoweredOn {
            // A did-wake is not necessarily a full wake: look at the display a moment later. The event is the same
            // one the standalone daemon sends; this engine does not act on it.
            queues["power"]?.asyncAfter(deadline: .now() + 3) { [self] in
                let d = display.current()
                if d.state == "off" {
                    emitter.emit(DraftEvent("power.darkwake", ["origin": "iokit_inferred", "display": "off",
                                                               "message": "did-wake with display off"]))
                }
            }
        }
    }

    private func powerTick() {
        let r = power.poll()
        handle("power", r)
        handle("display", display.poll(entries: power.lastEntries))
    }

    /// Every 60 s: ioreg presence only. A change asks for a system_profiler read a few seconds later (within 10 s).
    private func audioDeviceTick() {
        handle("audio", audio.presencePoll())
        if audio.takeProfileRequest() {
            queues["audio"]?.asyncAfter(deadline: .now() + AudioCollector.profileDelayAfterChange) { [self] in
                handle("audio", audio.profilePoll(trigger: "usb_change"))
            }
        }
    }

    // MARK: run

    /// Start the collectors. Idempotent.
    public func start() {
        guard !started else { return }
        started = true
        log.info("kiosk-health in helper \(kVersion) starting; machine=\(config.machine) source=\(config.source)")
        for n in config.notes { log.warn(n) }
        if getuid() != 0 { log.warn("not running as root: collectors that need root will degrade") }

        if !notifier.start() { log.warn("IORegisterForSystemPower failed; relying on pmset log for sleep/wake") }
        notifier.onMessage = { [weak self] m in self?.onPowerMessage(m) }

        emitter.emit(heartbeat.build(started: true))
        emitter.flush()

        every(Self.powerPollInterval, queue: "power", startAfter: 1) { [self] in powerTick() }
        every(30, queue: "assert", startAfter: 5) { [self] in handle("assertions", assertions.poll()) }
        every(AudioCollector.profileInterval, queue: "audio", startAfter: 2) { [self] in
            handle("audio", audio.profilePoll(trigger: audioProfileCount == 0 ? "start" : "periodic"))
            audioProfileCount += 1
        }
        every(60, queue: "audio", startAfter: 3) { [self] in audioDeviceTick() }
        every(60, queue: "audiolog", startAfter: 8) { [self] in handle("audiolog", audio.logPoll()) }
        every(15, queue: "hid", startAfter: 2) { [self] in handle("hid", hid.poll()) }
        every(15 * 60, queue: "drift", startAfter: 20) { [self] in handle("drift", drift.poll()) }
        every(10, queue: "recorder", startAfter: 4) { [self] in handle("recorder", recorder.poll()) }
        every(60, queue: "chrome", startAfter: 12) { [self] in handle("chrome", chrome.poll()) }
        every(60, queue: "heartbeat", startAfter: 60) { [self] in handle("heartbeat", heartbeat.poll()) }
        every(1, queue: "flush", startAfter: 1) { [self] in emitter.flush() }
        every(300, queue: "misc", startAfter: 300) { [self] in
            OwnLog.rotate(path: config.logPath, maxBytes: log.maxBytes, keep: log.keep)
            spool.resync()
        }
    }

    /// Flush what is buffered. Called on the helper's SIGTERM.
    public func stop() {
        emitter.flush()
    }

    // MARK: events from the rest of the helper

    /// An event the helper itself raises (for example `chrome.policy`). It goes through the same envelope, the same
    /// SinkGuard limits and the same spool as the collectors' events. Protected kinds flush at once.
    public func emit(kind: String, payload: [String: Any]) {
        emitter.emit(DraftEvent(kind, payload))
    }

    // MARK: delivery, driven by the app

    public var spoolDepth: Int { spool.depth }

    /// The next batch for the app to post, or nil when there is nothing to send or the engine is waiting (backoff, the
    /// one hour pause after a 401). The same batch comes back, with the same id, until the app reports an answer.
    public func nextBatch() -> Batch? {
        emitter.flush()
        guard let b = transport.nextRelayBatch() else { return nil }
        return Batch(id: b.id, body: b.body, count: b.count)
    }

    /// What the sink answered. `status` nil = a transport error. A 2xx must carry the sink's own reply in `body`.
    /// Returns a one-word outcome for the log: sent, failed, quarantined, unauthorized, stale.
    @discardableResult
    public func complete(batchID: String, status: Int?, body: Data, reason: String) -> String {
        let result: PostResult
        if let status, (200..<300).contains(status) {
            result = .ok(status: status, body: body)
        } else {
            result = .failed(status: status, reason: reason)
        }
        guard let outcome = transport.completeRelay(id: batchID, result: result) else { return "stale" }
        switch outcome {
        case .sent: return "sent"
        case .quarantined: return "quarantined"
        case .unauthorized: return "unauthorized"
        case .failed: return "failed"
        case .disabled, .waiting, .idle: return "idle"
        }
    }
}

/// Never called: the engine does not post. It exists because `Transport` is built around a poster.
struct NoNetworkPoster: HTTPPoster {
    func post(url: URL, token: String?, body: Data) -> PostResult {
        .failed(status: nil, reason: "post disabled")
    }
}
