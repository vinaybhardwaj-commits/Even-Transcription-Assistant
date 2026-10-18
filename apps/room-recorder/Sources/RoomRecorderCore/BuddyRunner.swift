import Foundation

// Encounter Buddy, L2 (0.1.42) — the runner: it carries 12 s chunks of the tape to newcat's chunk route and keeps the
// live transcript the page shows.
//
// ─── THE RULES THIS FILE KEEPS ─────────────────────────────────────────────────────────────────
//  * SEND GATE and DISPLAY GATE are separate. Chunks go while the session is `live`. The window and the page exist only
//    while `window` is true. A shadow session (live true, window false) sends and shows nothing (ADDENDUM 1).
//  * A reply with no `text` key is normal: no error, no retry, nothing rendered, nothing cached.
//  * One chunk in flight per consult. A seq is never sent until the one before it has a final answer.
//  * 403, 409 duplicate_seq, 429 and 503 STOP the consult for good: audio is never sent again after one. 502 and
//    409 busy are retried at most twice (1 s, 2 s; capped at 30 s). After that the chunk becomes a gap and we move on.
//  * Audio waits in a ring of at most 60 s, in memory only. When it is full the OLDEST frames drop and a gap is marked.
//    Audio captured more than 60 s before a send attempt is never (re)sent; the age is counted from the chunk's first byte, not from the cut. (The chunk in flight sits outside the ring, so up to 12 s more than the ring is held.)
//  * Reading the tape never blocks or slows capture: the runner only asks the L1 tap (127.0.0.1, bearer token), which
//    opens `tape.pcm` read-only. This file writes no audio and no text to disk.
//  * Logs hold counts, codes and timings and the opaque id only. Never text, never the token, never the key.
//  * No identifier other than the opaque id exists here (A2-C6).

// MARK: - Wire types

/// The answer of the flags poll. `fleetKill` is optional: newcat may or may not name it.
public struct BuddyFlags: Equatable, Sendable {
  public var window: Bool
  public var live: Bool
  public var reasonCode: String?
  public var fleetKill: Bool?
  public init(window: Bool, live: Bool, reasonCode: String? = nil, fleetKill: Bool? = nil) {
    self.window = window
    self.live = live
    self.reasonCode = reasonCode
    self.fleetKill = fleetKill
  }
}

public enum BuddyTokenResult: Equatable, Sendable {
  case ok(token: String, ttlSeconds: TimeInterval)
  /// `status` 0 is a transport failure.
  case failed(status: Int)
}

public enum BuddyFlagsResult: Equatable, Sendable {
  case ok(BuddyFlags)
  case failed(status: Int)
}

public struct BuddyChunk: Equatable, Sendable {
  public var opaqueID: String
  public var seq: Int
  public var startMs: Int
  public var durationMs: Int
  public var wav: Data
}

/// What came back from `POST /runner/v1/chunks`. `status` 0 means no answer at all (timeout, refused, reset).
public struct BuddyChunkReply: Equatable, Sendable {
  public var status: Int
  /// The `error` code in the body of a refusal (`killed`, `duplicate_seq`, `busy`, `allowance_exhausted` ...).
  public var error: String?
  public var seq: Int?
  public var text: String?
  /// True only when the body held a string under `text`. A shadow session's reply has none, and that is normal.
  public var hasText: Bool
  public init(status: Int, error: String? = nil, seq: Int? = nil, text: String? = nil, hasText: Bool = false) {
    self.status = status
    self.error = error
    self.seq = seq
    self.text = text
    self.hasText = hasText
  }
}

public protocol BuddyRunnerTransport: Sendable {
  func issueToken() async -> BuddyTokenResult
  func flags(token: String, opaqueID: String) async -> BuddyFlagsResult
  func sendChunk(token: String, chunk: BuddyChunk) async -> BuddyChunkReply
}

public enum BuddyPCMRead: Equatable, Sendable {
  case bytes(Data, segment: String, size: Int64)
  /// `from` was past the end of the tape: a new capture started.
  case pastEnd(size: Int64)
  /// No plain capture is running.
  case noCapture
  /// The tap itself refused (it stops serving the moment the consult ends or the kill switch lands).
  case refused(status: Int)
  case failed
}

public protocol BuddyPCMReading: Sendable {
  func read(from: Int64, max: Int) async -> BuddyPCMRead
}

public protocol BuddyRunnerClock: Sendable {
  /// Monotonic seconds.
  var now: TimeInterval { get }
  func sleep(seconds: TimeInterval) async
}

public struct BuddySystemClock: BuddyRunnerClock {
  public init() {}
  public var now: TimeInterval { ProcessInfo.processInfo.systemUptime }
  public func sleep(seconds: TimeInterval) async {
    try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
  }
}

/// What the runner may do to the window. The consult controller implements it.
public protocol BuddyRunnerWindowControlling: Sendable {
  func setWindow(open: Bool, reason: String)
}

// MARK: - The live transcript (what the page may show)

/// The transcript of ONE consult, in memory. It is created with the consult and dropped with it, so text from another
/// consult can never be on the page (A2-C5). It holds no audio and is never written anywhere.
public final class BuddyLiveTranscript: @unchecked Sendable {
  public enum LiveState: String, Sendable { case live, off, unavailable }
  public struct Segment: Equatable, Sendable {
    public var text: String
    public var gap: Bool
  }
  public struct Snapshot: Equatable, Sendable {
    public var opaqueID: String
    public var state: LiveState
    public var stale: Bool
    public var segments: [Segment]
  }

  /// The stale indicator shows after this many seconds with no new text (C7).
  public static let staleSeconds: TimeInterval = 30
  static let maxSegments = 400
  static let maxCharacters = 60_000

  public let opaqueID: String
  private let clock: @Sendable () -> TimeInterval
  private let lock = NSLock()
  private var state: LiveState = .live
  private var segments: [Segment] = []
  private var characters = 0
  private var lastActivity: TimeInterval

  public init(opaqueID: String, clock: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
    self.opaqueID = opaqueID
    self.clock = clock
    self.lastActivity = clock()
  }

  public func setState(_ new: LiveState) {
    lock.withLock {
      state = new
      if new != .live { segments = []; characters = 0 }
    }
  }

  public func append(text: String) {
    guard !text.isEmpty else { return }
    lock.withLock {
      guard state == .live else { return }
      segments.append(Segment(text: text, gap: false))
      characters += text.count
      lastActivity = clock()
      trim()
    }
  }

  /// A gap is a mark in the transcript, not text. Two in a row collapse into one.
  public func appendGap() {
    lock.withLock {
      guard state == .live, segments.last?.gap != true else { return }
      segments.append(Segment(text: "", gap: true))
      trim()
    }
  }

  public func clear() {
    lock.withLock { segments = []; characters = 0 }
  }

  public func snapshot() -> Snapshot {
    lock.withLock {
      let silent = clock() - lastActivity
      // `unavailable` is shown WITH the stale indicator (A2-C5); `off` is not stale, it is off.
      let stale: Bool
      switch state {
      case .live: stale = silent >= Self.staleSeconds
      case .unavailable: stale = true
      case .off: stale = false
      }
      return Snapshot(opaqueID: opaqueID, state: state, stale: stale, segments: state == .live ? segments : [])
    }
  }

  private func trim() {
    while segments.count > Self.maxSegments || characters > Self.maxCharacters, !segments.isEmpty {
      characters -= segments.removeFirst().text.count
    }
  }
}

// MARK: - WAV

enum BuddyWAV {
  /// 16 kHz mono PCM16, a canonical 44-byte header, and the data chunk is the LAST thing in the file (newcat B3 refuses
  /// anything after it).
  static func wrap(pcm: Data) -> Data {
    var header = Data()
    func u32(_ value: UInt32) { var v = value.littleEndian; withUnsafeBytes(of: &v) { header.append(contentsOf: $0) } }
    func u16(_ value: UInt16) { var v = value.littleEndian; withUnsafeBytes(of: &v) { header.append(contentsOf: $0) } }
    header.append(contentsOf: Array("RIFF".utf8))
    u32(UInt32(36 + pcm.count))
    header.append(contentsOf: Array("WAVE".utf8))
    header.append(contentsOf: Array("fmt ".utf8))
    u32(16)
    u16(1)  // PCM
    u16(1)  // mono
    u32(16_000)
    u32(32_000)
    u16(2)
    u16(16)
    header.append(contentsOf: Array("data".utf8))
    u32(UInt32(pcm.count))
    return header + pcm
  }
}

// MARK: - The runner

public actor BuddyRunner {
  /// 12 s chunks (D3), a frozen-build parameter (C8).
  public static let chunkMilliseconds = 12_000
  public static let ringMilliseconds = 60_000
  static let bytesPerMillisecond = 32  // 16 kHz x 2 bytes
  static let chunkBytes = chunkMilliseconds * bytesPerMillisecond
  static let ringBytes = ringMilliseconds * bytesPerMillisecond
  static let readBytes = 256 * 1024
  static let readsPerTick = 8
  static let tickSeconds: TimeInterval = 0.5
  static let flagsEverySeconds: TimeInterval = 60
  /// Until a first good answer there is nothing to show, so ask again sooner.
  static let flagsRetryBeforeFirstSeconds: TimeInterval = 10
  static let maxRetries = 2
  static let backoffCapSeconds: TimeInterval = 30

  public struct Stats: Equatable, Sendable {
    public var postAttempts = 0
    public var chunksOK = 0
    public var gaps = 0
    public var droppedMilliseconds = 0
    public var flagPolls = 0
    public var tokenIssues = 0
    public var windowOpens = 0
    public var windowCloses = 0
    public var breaches = 0
    public var tapReads = 0
    public var textless = 0
    public var maxInFlight = 0
    public var stopStatus: Int?
    public var ringBytes = 0
  }

  private let opaqueID: String
  private let transport: any BuddyRunnerTransport
  private let pcm: any BuddyPCMReading
  private let window: any BuddyRunnerWindowControlling
  private let transcript: BuddyLiveTranscript
  private let clock: any BuddyRunnerClock
  private let log: @Sendable (String) -> Void

  private var ring = Data()
  private var ringStartMs = 0
  private var nextSeq = 0
  private var inFlight = 0
  private var sendTask: Task<Void, Never>?
  private var token: String?
  private var tokenAt: TimeInterval = 0
  private var tokenTTL: TimeInterval = 900
  private var flags: BuddyFlags?
  private var nextFlagsAt: TimeInterval = 0
  private var polling = false
  private var finished = false
  private var stopped = false
  private var fleetOffSeen = false
  private var windowOpen = false
  private var windowLocked = false
  private var readOffset: Int64?
  private var segment: String?
  private var arrivals: [(at: TimeInterval, bytes: Int)] = []
  private let halt = HaltFlag()
  public private(set) var stats = Stats()

  public init(
    opaqueID: String, transport: any BuddyRunnerTransport, pcm: any BuddyPCMReading,
    window: any BuddyRunnerWindowControlling, transcript: BuddyLiveTranscript,
    clock: any BuddyRunnerClock = BuddySystemClock(), log: @escaping @Sendable (String) -> Void
  ) {
    self.opaqueID = opaqueID
    self.transport = transport
    self.pcm = pcm
    self.window = window
    self.transcript = transcript
    self.clock = clock
    self.log = log
  }

  // MARK: Lifecycle

  /// Runs until the consult ends (`stop()`), the task is cancelled, or `live` goes false.
  public func run() async {
    while !finished && !Task.isCancelled {
      await tick()
      if finished || Task.isCancelled { break }
      await clock.sleep(seconds: Self.tickSeconds)
    }
  }

  /// Callable from any thread, and effective at once: no new chunk is cut and none is sent after this returns. The consult
  /// controller calls it under its own lock, before it hands the rest of the teardown to `stop()`.
  public nonisolated func haltNow() { halt.set() }

  /// The consult ended, the kill switch landed, or the process is going away: nothing more is sent, the ring is dropped.
  public func stop() {
    halt.set()
    finished = true
    sendTask?.cancel()
    clearRing()
    stats.ringBytes = 0
    transcript.clear()
  }

  /// Waits for the chunk now in flight, if any. For tests.
  func settle() async { await sendTask?.value }

  var isFinished: Bool { finished }
  var isStopped: Bool { stopped }

  // MARK: One tick

  func tick() async {
    guard !finished, !halt.isSet else { return }
    if clock.now >= nextFlagsAt, !polling { await pollFlags() }
    guard !finished, flags?.live == true, !stopped else { return }
    await pumpTape()
    cutIfReady()
  }

  // MARK: Flags

  private func pollFlags() async {
    polling = true
    stats.flagPolls += 1
    defer {
      polling = false
      nextFlagsAt = clock.now + (flags == nil ? Self.flagsRetryBeforeFirstSeconds : Self.flagsEverySeconds)
    }
    var reissued = false
    while true {
      guard let bearer = await ensureToken() else { return }
      switch await transport.flags(token: bearer, opaqueID: opaqueID) {
      case .ok(let answer):
        apply(answer)
        return
      case .failed(let status):
        if status == 401, !reissued {
          token = nil
          reissued = true
          continue
        }
        // The server is the authority on a kill (the chunk route re-checks it on every chunk), so a missed poll
        // changes nothing here. It is logged as a count and tried again at the next interval.
        log("buddy runner: flags poll failed (status \(status)) (opaque_id \(opaqueID))")
        return
      }
    }
  }

  private func apply(_ answer: BuddyFlags) {
    flags = answer
    if answer.reasonCode == "fleet_off" { fleetOffSeen = true }
    // A window that is true under a KILLED fleet is a fail-closed breach: count it, keep the window shut, and keep
    // sending as `live` says. The fleet is known to be killed from the reply, or from an earlier reply this consult.
    var wantWindow = answer.window
    if answer.window, answer.fleetKill == true || fleetOffSeen {
      stats.breaches += 1
      wantWindow = false
      log("buddy runner: window_breach count \(stats.breaches) (opaque_id \(opaqueID))")
    }
    if !wantWindow || !windowLocked { setWindow(wantWindow, reason: wantWindow ? "flags" : "flags_window_false") }
    guard answer.live else {
      // The send gate is shut: a kill, shadow_live off or an opt-out. No more calls, no more polls.
      transcript.setState(.off)
      clearRing()
      stats.ringBytes = 0
      finished = true
      log("buddy runner: live false, sending stopped (opaque_id \(opaqueID))")
      return
    }
    if !stopped { transcript.setState(.live) }
  }

  private func setWindow(_ open: Bool, reason: String) {
    guard open != windowOpen else { return }
    windowOpen = open
    if open { stats.windowOpens += 1 } else { stats.windowCloses += 1 }
    window.setWindow(open: open, reason: reason)
  }

  // MARK: Token

  private func ensureToken() async -> String? {
    if let token, clock.now - tokenAt < tokenTTL * 0.8 { return token }
    switch await transport.issueToken() {
    case .ok(let issued, let ttl):
      token = issued
      tokenAt = clock.now
      tokenTTL = min(max(ttl, 60), 900)
      stats.tokenIssues += 1
      log("buddy runner: token issued (ttl \(Int(tokenTTL)) s) (opaque_id \(opaqueID))")
      return issued
    case .failed(let status):
      token = nil
      log("buddy runner: token not issued (status \(status)) (opaque_id \(opaqueID))")
      return nil
    }
  }

  // MARK: The tape and the ring

  private func pumpTape() async {
    for _ in 0..<Self.readsPerTick {
      guard !finished, !halt.isSet, !stopped else { return }
      stats.tapReads += 1
      guard let offset = readOffset else {
        // The consult starts HERE: audio from before it is never read.
        if case .bytes(_, let seg, let size) = await pcm.read(from: 0, max: 2) {
          readOffset = size & ~Int64(1)
          segment = seg
        }
        return
      }
      switch await pcm.read(from: offset, max: Self.readBytes) {
      case .bytes(let data, let seg, _):
        if let segment, seg != segment {
          // A new capture: bytes read at the old offset belong to another file. Mark the gap and start over at 0.
          newCapture(segment: seg)
          continue
        }
        segment = seg
        readOffset = offset + Int64(data.count)
        append(data)
        if data.count < Self.readBytes { return }
      case .pastEnd:
        newCapture(segment: nil)
        return
      case .noCapture, .failed:
        return
      case .refused:
        // The tap closed under us: the consult is ending. Stop reading; the controller tears the runner down.
        stopped = true
        clearRing()
        stats.ringBytes = 0
        return
      }
    }
  }

  private func clearRing() {
    ring = Data()
    arrivals = []
  }

  /// Drops `count` bytes from the head of the arrival record, so the age of the oldest audio in the ring is known.
  private func consumeArrivals(_ count: Int) {
    var left = count
    while left > 0, let first = arrivals.first {
      if first.bytes <= left {
        left -= first.bytes
        arrivals.removeFirst()
      } else {
        arrivals[0].bytes -= left
        left = 0
      }
    }
  }

  private func newCapture(segment seg: String?) {
    segment = seg
    readOffset = 0
    // A partial chunk of the old capture must not be spliced onto the new one.
    let lost = ring.count / Self.bytesPerMillisecond
    clearRing()
    ringStartMs += lost
    stats.droppedMilliseconds += lost
    stats.ringBytes = 0
    transcript.appendGap()
    log("buddy runner: new capture, \(lost) ms of ring dropped (opaque_id \(opaqueID))")
  }

  private func append(_ data: Data) {
    guard !data.isEmpty else { return }
    ring.append(data)
    arrivals.append((clock.now, data.count))
    if ring.count > Self.ringBytes {
      var drop = ring.count - Self.ringBytes
      drop += drop % 2  // whole samples only
      ring = Data(ring.suffix(from: ring.startIndex + drop))
      consumeArrivals(drop)
      let dropped = drop / Self.bytesPerMillisecond
      ringStartMs += dropped
      stats.droppedMilliseconds += dropped
      transcript.appendGap()
      log("buddy runner: ring full, oldest \(dropped) ms dropped (opaque_id \(opaqueID))")
    }
    stats.ringBytes = ring.count
  }

  private func cutIfReady() {
    guard inFlight == 0, !stopped, !finished, !halt.isSet, flags?.live == true, ring.count >= Self.chunkBytes else { return }
    // The chunk is as old as its first byte: that is the age the 60 s rule measures, not the moment it was cut.
    let capturedAt = arrivals.first?.at ?? clock.now
    let body = Data(ring.prefix(Self.chunkBytes))
    ring = Data(ring.suffix(from: ring.startIndex + Self.chunkBytes))
    consumeArrivals(Self.chunkBytes)
    stats.ringBytes = ring.count
    let chunk = BuddyChunk(
      opaqueID: opaqueID, seq: nextSeq, startMs: ringStartMs, durationMs: Self.chunkMilliseconds, wav: BuddyWAV.wrap(pcm: body))
    nextSeq += 1
    ringStartMs += Self.chunkMilliseconds
    let cutAt = capturedAt
    inFlight += 1
    stats.maxInFlight = max(stats.maxInFlight, inFlight)
    sendTask = Task { [self] in await deliver(chunk, cutAt: cutAt) }
  }

  // MARK: Delivering one chunk

  private enum Verdict {
    case done
    case reauth
    case stop(closeWindow: Bool)
    case retry
    case gap
  }

  private func verdict(for reply: BuddyChunkReply) -> Verdict {
    switch reply.status {
    case 200: return .done
    case 401: return .reauth
    case 403: return .stop(closeWindow: reply.error == "killed")
    case 409: return reply.error == "busy" ? .retry : .stop(closeWindow: false)
    case 429: return .stop(closeWindow: true)
    case 503: return .stop(closeWindow: false)
    case 502: return .retry
    // No answer at all (a timeout): the server may still hold the chunk, and a resend could be a duplicate. A gap.
    case 0: return .gap
    default: return .gap
    }
  }

  private func deliver(_ chunk: BuddyChunk, cutAt: TimeInterval) async {
    defer { inFlight -= 1 }
    var retries = 0
    var reauthed = false
    while true {
      guard !Task.isCancelled, !finished, !halt.isSet, !stopped, flags?.live == true else { return }
      // Nothing older than 60 s is ever sent (A2-C10).
      if clock.now - cutAt > Double(Self.ringMilliseconds) / 1000 {
        markGap("older_than_60s")
        return
      }
      guard let bearer = await ensureToken() else {
        markGap("no_token")
        return
      }
      stats.postAttempts += 1
      let started = clock.now
      let reply = await transport.sendChunk(token: bearer, chunk: chunk)
      let elapsed = Int((clock.now - started) * 1000)
      log(
        "buddy runner: chunk seq \(chunk.seq) status \(reply.status)\(Self.safeCode(reply.error)) ms \(elapsed) audio_ms \(chunk.durationMs) try \(retries + 1) (opaque_id \(opaqueID))"
      )
      guard !Task.isCancelled, !finished else { return }
      switch verdict(for: reply) {
      case .done:
        stats.chunksOK += 1
        accept(reply, sent: chunk)
        return
      case .reauth:
        if reauthed { markGap("unauthorized"); return }
        reauthed = true
        token = nil
      case .stop(let closeWindow):
        await stopForConsult(status: reply.status, closeWindow: closeWindow)
        return
      case .retry:
        guard retries < Self.maxRetries else {
          markGap("retries_exhausted")
          return
        }
        retries += 1
        await clock.sleep(seconds: min(Self.backoffCapSeconds, Double(1 << (retries - 1))))
      case .gap:
        markGap(reply.status == 0 ? "no_answer" : "status_\(reply.status)")
        return
      }
    }
  }

  private func accept(_ reply: BuddyChunkReply, sent chunk: BuddyChunk) {
    guard reply.hasText, let text = reply.text else {
      // A shadow session's reply carries no text. That is normal: no error, no retry, no render, nothing cached.
      stats.textless += 1
      return
    }
    if let seq = reply.seq, seq != chunk.seq {
      log("buddy runner: reply seq does not match the chunk sent, text not shown (opaque_id \(opaqueID))")
      return
    }
    // Text is held only while the window is open. With no window there is nowhere to show it and no reason to keep it.
    if windowOpen { transcript.append(text: text) }
  }

  private func markGap(_ reason: String) {
    stats.gaps += 1
    transcript.appendGap()
    log("buddy runner: gap (\(reason)) (opaque_id \(opaqueID))")
  }

  private func stopForConsult(status: Int, closeWindow: Bool) async {
    stopped = true
    stats.stopStatus = status
    clearRing()
    stats.ringBytes = 0
    transcript.setState(.unavailable)
    log("buddy runner: stopped for this consult (status \(status)), no more audio will be sent (opaque_id \(opaqueID))")
    if closeWindow {
      // A kill or a cap stop closes the window (item 5) and it stays closed for this consult.
      windowLocked = true
      setWindow(false, reason: status == 429 ? "cap_stop" : "kill_stop")
    }
    // Re-poll at each stop, so the window follows the flags and not the failure.
    nextFlagsAt = 0
    if !polling { await pollFlags() }
  }

  /// A server error code is logged only if it is a short lower-case word. Anything else is logged as `other`.
  static func safeCode(_ code: String?) -> String {
    guard let code, !code.isEmpty else { return "" }
    let ok = code.utf8.count <= 32 && code.utf8.allSatisfy { ($0 >= 0x61 && $0 <= 0x7A) || $0 == 0x5F }
    return " " + (ok ? code : "other")
  }
}

// MARK: - The real transports

/// Where the runner talks and the credential for it. `buddy-runner.json` in the room root, mode 0600:
/// `{"base":"http://<c4 tailnet host>:<port>","key":"<api consumer key>"}`. The key is never logged. No file, no runner.
public struct BuddyRunnerConfig: Equatable, Sendable {
  public static let fileName = "buddy-runner.json"
  public var base: URL
  public var key: String

  /// 0.1.43. What the health field reports: counts of rooms by these three words, never the path or the contents.
  public enum Status: String, Sendable { case ok, absent, unusable }

  public static func load(root: URL, log: @Sendable (String) -> Void = { _ in }) -> BuddyRunnerConfig? {
    inspect(root: root, log: log).config
  }

  /// The file's state, read afresh. `absent` is no file at all; `unusable` is a file that is loose, unparseable or
  /// missing a field; `ok` carries the config.
  public static func status(root: URL) -> Status { inspect(root: root).status }

  static func inspect(root: URL, log: @Sendable (String) -> Void = { _ in }) -> (status: Status, config: BuddyRunnerConfig?) {
    let url = root.appendingPathComponent(fileName)
    var info = stat()
    guard stat(url.path, &info) == 0 else { return (.absent, nil) }
    // The key is a credential: a file other users can read is refused, not used.
    guard info.st_mode & 0o077 == 0 else {
      log("buddy runner: \(fileName) is readable by others, runner off")
      return (.unusable, nil)
    }
    guard let data = try? Data(contentsOf: url),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let base = (object["base"] as? String).flatMap(URL.init(string:)), let host = base.host, !host.isEmpty,
      base.scheme == "http" || base.scheme == "https",
      let key = object["key"] as? String, !key.isEmpty
    else {
      log("buddy runner: \(fileName) is not usable, runner off")
      return (.unusable, nil)
    }
    return (.ok, BuddyRunnerConfig(base: base, key: key))
  }
}

private final class BuddyNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)  // a redirect would carry the bearer somewhere else
  }
}

/// `POST /runner/v1/token`, `GET /runner/v1/flags`, `POST /runner/v1/chunks` on the c4 tailnet listener. Every wire
/// detail the kickoff does not name (the token and flags bodies, the `opaque_id` query) is INFERRED; see the report.
public final class BuddyHTTPTransport: BuddyRunnerTransport, @unchecked Sendable {
  private let config: BuddyRunnerConfig
  private let session: URLSession
  private let redirects = BuddyNoRedirect()

  public init(config: BuddyRunnerConfig, requestTimeout: TimeInterval = 25) {
    self.config = config
    let configuration = URLSessionConfiguration.ephemeral
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.timeoutIntervalForRequest = requestTimeout
    configuration.timeoutIntervalForResource = requestTimeout + 5
    configuration.waitsForConnectivity = false
    session = URLSession(configuration: configuration, delegate: redirects, delegateQueue: nil)
  }

  private func url(_ path: String, query: [URLQueryItem] = []) -> URL? {
    guard var parts = URLComponents(url: config.base, resolvingAgainstBaseURL: false) else { return nil }
    let prefix = parts.path.hasSuffix("/") ? String(parts.path.dropLast()) : parts.path
    parts.path = prefix + path
    parts.queryItems = query.isEmpty ? nil : query
    return parts.url
  }

  private func object(_ data: Data) -> [String: Any]? {
    (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }

  /// newcat refuses with `{"error": {"type": "<code>", "message": "..."}}` (runner-listener `fail()`). A bare string is
  /// accepted too. Only the code is kept; the message is never read.
  static func errorType(_ body: [String: Any]?) -> String? {
    if let nested = body?["error"] as? [String: Any] { return nested["type"] as? String }
    return body?["error"] as? String
  }

  public func issueToken() async -> BuddyTokenResult {
    guard let url = url("/runner/v1/token") else { return .failed(status: 0) }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(config.key)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = Data("{}".utf8)
    guard let (data, response) = try? await session.data(for: request), let http = response as? HTTPURLResponse else {
      return .failed(status: 0)
    }
    guard http.statusCode == 200, let body = object(data), let token = body["token"] as? String, !token.isEmpty else {
      return .failed(status: http.statusCode)
    }
    let ttl = (body["expires_in"] as? NSNumber)?.doubleValue ?? 900
    return .ok(token: token, ttlSeconds: ttl)
  }

  public func flags(token: String, opaqueID: String) async -> BuddyFlagsResult {
    guard let url = url("/runner/v1/flags", query: [URLQueryItem(name: "opaque_id", value: opaqueID)]) else {
      return .failed(status: 0)
    }
    var request = URLRequest(url: url)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    guard let (data, response) = try? await session.data(for: request), let http = response as? HTTPURLResponse else {
      return .failed(status: 0)
    }
    guard http.statusCode == 200, let body = object(data), let window = body["window"] as? Bool,
      let live = body["live"] as? Bool
    else { return .failed(status: http.statusCode == 200 ? 0 : http.statusCode) }
    return .ok(
      BuddyFlags(
        window: window, live: live, reasonCode: body["reason_code"] as? String, fleetKill: body["fleet_kill"] as? Bool))
  }

  public func sendChunk(token: String, chunk: BuddyChunk) async -> BuddyChunkReply {
    guard let url = url("/runner/v1/chunks") else { return BuddyChunkReply(status: 0) }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
    request.setValue(chunk.opaqueID, forHTTPHeaderField: "x-chunk-opaque-id")
    request.setValue(String(chunk.seq), forHTTPHeaderField: "x-chunk-seq")
    request.setValue(String(chunk.startMs), forHTTPHeaderField: "x-chunk-start-ms")
    request.setValue(String(chunk.durationMs), forHTTPHeaderField: "x-chunk-duration-ms")
    guard let (data, response) = try? await session.upload(for: request, from: chunk.wav),
      let http = response as? HTTPURLResponse
    else { return BuddyChunkReply(status: 0) }
    let body = object(data)
    if http.statusCode == 200 {
      let seq = (body?["seq"] as? NSNumber)?.intValue
      if let text = body?["text"] as? String {
        return BuddyChunkReply(status: 200, seq: seq, text: text, hasText: true)
      }
      return BuddyChunkReply(status: 200, seq: seq)
    }
    return BuddyChunkReply(status: http.statusCode, error: Self.errorType(body))
  }
}

/// Reads the L1 tap: `GET http://127.0.0.1:<port>/tap/pcm` with the per-consult token. The tap opens `tape.pcm`
/// read-only, so this can never slow or touch the writer.
public final class BuddyTapReader: BuddyPCMReading, @unchecked Sendable {
  private let port: UInt16
  private let token: String
  private let session: URLSession

  public init(port: UInt16, token: String) {
    self.port = port
    self.token = token
    let configuration = URLSessionConfiguration.ephemeral
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    configuration.httpCookieStorage = nil
    configuration.timeoutIntervalForRequest = 3
    configuration.connectionProxyDictionary = [:]  // loopback is never proxied
    session = URLSession(configuration: configuration)
  }

  public func read(from: Int64, max: Int) async -> BuddyPCMRead {
    guard let url = URL(string: "http://127.0.0.1:\(port)/tap/pcm?from=\(from)&max=\(max)") else { return .failed }
    var request = URLRequest(url: url)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    guard let (data, response) = try? await session.data(for: request), let http = response as? HTTPURLResponse else {
      return .failed
    }
    let size = Int64(http.value(forHTTPHeaderField: "X-Tape-Size") ?? "") ?? 0
    switch http.statusCode {
    case 200: return .bytes(data, segment: http.value(forHTTPHeaderField: "X-Tape-Segment") ?? "", size: size)
    case 416: return .pastEnd(size: size)
    case 404: return .noCapture
    case 401, 403: return .refused(status: http.statusCode)
    default: return .failed
    }
  }
}

/// A flag any thread can set and any thread can read, for `BuddyRunner.haltNow()`.
final class HaltFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var value = false
  func set() { lock.withLock { value = true } }
  var isSet: Bool { lock.withLock { value } }
}
