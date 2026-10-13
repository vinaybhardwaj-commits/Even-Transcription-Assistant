import Foundation

// MARK: - Seams

public struct FleetRequest: Sendable {
  public var method: String
  public var path: String
  public var query: [String: String] = [:]
  public var headers: [String: String] = [:]
  public var body: Data?
  public var timeout: TimeInterval
}

public struct FleetResponse: Sendable {
  public var status: Int
  public var body: Data
  public init(status: Int, body: Data) {
    self.status = status
    self.body = body
  }
}

/// HTTPS to the app's origin, outbound only. The production implementation is URLSession, which
/// honours the system proxy.
public protocol FleetTransport: Sendable {
  func send(_ request: FleetRequest) async throws -> FleetResponse
}

/// The device's own keychain. `loadOrCreate` makes the key once and returns the same one after.
public protocol FleetKeyStore: Sendable {
  func loadOrCreate() throws -> FleetSigningKey
  /// The key, and where it came from. A store that cannot read the key the device registered with MUST say `rotated`
  /// (or `fresh`) so the client drops the old device id: a new key under the old id is a KEY_CONFLICT at the server.
  func loadWithOrigin() throws -> FleetKeyLoad
}

extension FleetKeyStore {
  public func loadWithOrigin() throws -> FleetKeyLoad { FleetKeyLoad(key: try loadOrCreate(), origin: .existing) }
}

/// 0.1.39.1. How the key in hand relates to the one the device registered with.
public enum FleetKeyOrigin: Equatable, Sendable {
  /// The same key as before (read from the file, or moved from the keychain once).
  case existing
  /// Made now because there was none.
  case fresh
  /// Made now because the old one exists and cannot be read; `reason` is the status or `timeout`.
  case rotated(reason: String)
}

public struct FleetKeyLoad: @unchecked Sendable {
  public let key: FleetSigningKey
  public let origin: FleetKeyOrigin
  /// 0.1.40 R2. Read from the store's durable record, not from this load: the device id this key REPLACED, when the
  /// store rotated it (possibly in an earlier process, or after the client's deadline had passed). The client drops a
  /// device id that matches, so a lost or late rotation can never sign for the old id.
  public let replacesDeviceID: String?
  /// The recorded reason for the rotation (a status, or `timeout`), when there was one.
  public let rotationReason: String?
  public init(key: FleetSigningKey, origin: FleetKeyOrigin, replacesDeviceID: String? = nil, rotationReason: String? = nil) {
    self.key = key
    self.origin = origin
    self.replacesDeviceID = replacesDeviceID
    self.rotationReason = rotationReason
  }
}

/// 0.1.39.1. The client's own errors, with a stable domain and code for the log.
public enum FleetClientError: Error, Equatable, CustomNSError {
  /// The key store did not answer within the deadline (or a previous load is still stuck).
  case keyTimeout
  /// The key changed and the device id was dropped; the next pass registers again.
  case reenrolling

  public static var errorDomain: String { "FleetClient" }
  public var errorCode: Int {
    switch self {
    case .keyTimeout: return 1
    case .reenrolling: return 2
    }
  }
}

/// The load of a key runs on its own thread and resumes the caller exactly once: with the answer, or with a timeout.
final class FleetKeyLoadGate: @unchecked Sendable {
  private let lock = NSLock()
  private var busy = false
  func begin() -> Bool { lock.lock(); defer { lock.unlock() }; if busy { return false }; busy = true; return true }
  func end() { lock.lock(); busy = false; lock.unlock() }
}

private final class ResumeOnce: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Result<FleetKeyLoad, Error>, Never>?
  init(_ continuation: CheckedContinuation<Result<FleetKeyLoad, Error>, Never>) { self.continuation = continuation }
  func resume(_ result: Result<FleetKeyLoad, Error>) {
    lock.lock(); let c = continuation; continuation = nil; lock.unlock()
    c?.resume(returning: result)
  }
}

public protocol FleetStateStore: Sendable {
  func load() -> FleetState
  func save(_ state: FleetState)
}

public struct FleetExecResult: Sendable {
  public enum Outcome: String, Sendable { case ok, failed, unsupported }
  public var outcome: Outcome
  public var reason: String?
  /// Closed per-verb object, no PHI. Keys `[a-z_][a-z0-9_]*`, depth ≤ 4, ≤ 4096 bytes.
  public var detail: [String: FleetJSON]
  /// Runs once, after the result has been posted. A restart waits here so the result is not lost.
  public var afterResultPosted: (@Sendable () async -> Void)?

  public init(
    outcome: Outcome, reason: String? = nil, detail: [String: FleetJSON] = [:],
    afterResultPosted: (@Sendable () async -> Void)? = nil
  ) {
    self.outcome = outcome
    self.reason = reason
    self.detail = detail
    self.afterResultPosted = afterResultPosted
  }
}

public protocol FleetExecutor: Sendable {
  /// `envelope` is the verified envelope; the app forwards it whole to the root helper for the verbs that
  /// run there, and the helper verifies it again for itself.
  func execute(_ verb: FleetVerb, params: FleetParams, envelope: FleetEnvelope) async -> FleetExecResult
}

public struct FleetClientConfig: Sendable {
  /// OFF by default. Nothing is read, created, registered or sent unless this is true.
  public var enabled: Bool = false
  public var installID: String
  public var machine: String
  public var hwModel: String?
  public var helperVersion: String?

  public init(
    enabled: Bool = false, installID: String, machine: String, hwModel: String? = nil,
    helperVersion: String? = nil
  ) {
    self.enabled = enabled
    self.installID = installID
    self.machine = machine
    self.hwModel = hwModel
    self.helperVersion = helperVersion
  }
}

/// 1, 2, 4 … 60 seconds; reset to nothing after any 200.
public struct FleetBackoff: Equatable, Sendable {
  public private(set) var next: TimeInterval = 1
  public init() {}
  public mutating func failure() -> TimeInterval {
    let delay = next
    next = min(next * 2, 60)
    return delay
  }
  public mutating func success() { next = 1 }
}

// MARK: - Client

public enum FleetPollStep: Equatable, Sendable {
  case handled(Int)
  case wait(TimeInterval)
  case stop(String)
}

/// The outbound long-poll client (TS-H3 #40) and the command runner (TS-H4 #41). One actor, no
/// inbound port. Every request carries a fresh device token.
public actor FleetClient {
  private let config: FleetClientConfig
  private let transport: FleetTransport
  private let keys: FleetKeyStore
  private let store: FleetStateStore
  private let executor: FleetExecutor
  private let serverKeys: [String: Data]
  private let roomSession: @Sendable () -> String?
  private let gates: @Sendable () async -> FleetGateState
  private let clock: @Sendable () -> Date
  private let sleep: @Sendable (TimeInterval) async -> Void
  private let makeJTI: @Sendable () -> String
  private let log: @Sendable (String) -> Void
  private let keyDeadline: TimeInterval
  private let rekeyJitter: @Sendable () -> Double
  private nonisolated let keyGate = FleetKeyLoadGate()

  private var state: FleetState
  private var key: FleetSigningKey?
  private var backoff = FleetBackoff()
  public private(set) var lastServerSkew: TimeInterval?

  public init(
    config: FleetClientConfig, transport: FleetTransport, keys: FleetKeyStore, store: FleetStateStore,
    executor: FleetExecutor, serverKeys: [String: Data] = FleetServerKeys.resolve(),
    roomSession: @escaping @Sendable () -> String?, gates: @escaping @Sendable () async -> FleetGateState,
    clock: @escaping @Sendable () -> Date = { Date() },
    sleep: @escaping @Sendable (TimeInterval) async -> Void = {
      try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000))
    },
    makeJTI: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() },
    log: @escaping @Sendable (String) -> Void,
    keyDeadline: TimeInterval = 10,
    rekeyJitter: @escaping @Sendable () -> Double = { Double.random(in: -0.1...0.1) }
  ) {
    self.rekeyJitter = rekeyJitter
    self.keyDeadline = keyDeadline
    self.config = config
    self.transport = transport
    self.keys = keys
    self.store = store
    self.executor = executor
    self.serverKeys = serverKeys
    self.roomSession = roomSession
    self.gates = gates
    self.clock = clock
    self.sleep = sleep
    self.makeJTI = makeJTI
    self.log = log
    self.state = FleetState()
  }

  // MARK: Loop

  /// Returns when the task is cancelled, the client is disabled, or the server has revoked this
  /// device. Disabled: returns at once, having touched nothing.
  public func run() async {
    guard config.enabled else { log("fleet client stopped: disabled"); return }
    loadState()
    // 0.1.40 R2. The key first, so a rotation drops the old device id BEFORE any pass reads it.
    _ = try? await signingKey()
    while !Task.isCancelled {
      if let reason = state.stoppedReason {
        log("fleet client stopped: \(reason)")
        return
      }
      await flushResults()
      if state.deviceID == nil {
        switch await registerIfNeeded() {
        case .handled: break
        case .wait(let seconds): await sleep(seconds); continue
        case .stop(let why): log("fleet client stopped: \(why)"); return
        }
      }
      switch await pollOnce() {
      case .handled: break
      case .wait(let seconds): await sleep(seconds)
      case .stop(let why): log("fleet client stopped: \(why)"); return
      }
    }
    log("fleet client stopped: cancelled")
  }

  /// 0.1.39. A request that threw (no key, no network, a bad token) used to retry in silence. It now says so once per
  /// change: where, the error's domain and code. Never the error's text, which can carry a URL, and never a token.
  private var lastFailures: [String: String] = [:]
  private func noteFailure(_ site: String, _ error: Error) {
    if (error as? FleetClientError) == .reenrolling { return }
    let ns = error as NSError
    let line = "fleet client: \(site) failed (\(ns.domain) \(ns.code))"
    guard lastFailures[site] != line else { return }
    lastFailures[site] = line
    log(line)
  }

  func loadState() {
    var loaded = store.load()
    if loaded.installID != config.installID {
      loaded = FleetState()  // a different enrolment starts clean
      loaded.installID = config.installID
    }
    // 0.1.40 R2. 0.1.40's first build (948d3829) persisted a stop for a KEY_CONFLICT after a rotation. That is a wait now:
    // the stop is cleared on the first start of this build.
    if loaded.stoppedReason == "register_key_conflict" {
      loaded.stoppedReason = nil
      store.save(loaded)
    }
    state = loaded
  }

  private func persist() { store.save(state) }

  private func now() -> Int { Int(clock().timeIntervalSince1970) }

  /// How long a key that failed to load (not a timeout) is left alone before the store is asked again.
  static let keyRetryInterval: TimeInterval = 300
  /// How often a register refused after a key rotation is asked again.
  public static let rekeyRetryInterval: TimeInterval = 900
  /// The refused-register line is written at most this often.
  static let refusedLogInterval: TimeInterval = 3600
  private var lastRefusedLogAt: Date?
  private var keyRetryAt: Date?
  private var keyRetryError: Error?
  private var rotation: (reason: String, oldDevice: String)?

  /// 0.1.39.1. NOTHING HERE CAN WAIT FOR EVER. The store is asked on its own thread; this actor waits at most
  /// `keyDeadline` for the answer. A load that never returns stays on its thread (it cannot be killed) and no second
  /// one is started while it is stuck, so a hang costs one thread, not one per retry.
  private func signingKey() async throws -> FleetSigningKey {
    if let key { return key }
    if let at = keyRetryAt, clock() < at, let error = keyRetryError { throw error }
    guard keyGate.begin() else { throw FleetClientError.keyTimeout }
    let keys = self.keys, gate = keyGate, deadline = keyDeadline
    let result: Result<FleetKeyLoad, Error> = await withCheckedContinuation { continuation in
      let once = ResumeOnce(continuation)
      Thread.detachNewThread {
        let answer = Result { try keys.loadWithOrigin() }
        gate.end()
        once.resume(answer)
      }
      DispatchQueue.global().asyncAfter(deadline: .now() + deadline) { once.resume(.failure(FleetClientError.keyTimeout)) }
    }
    switch result {
    case .success(let load):
      key = load.key
      keyRetryAt = nil
      keyRetryError = nil
      applyRotation(of: load)
      return load.key
    case .failure(let error):
      if (error as? FleetClientError) != .keyTimeout {
        let ns = error as NSError
        log("fleet client stopped: key read failed (\(ns.domain) \(ns.code))")
        keyRetryAt = clock().addingTimeInterval(Self.keyRetryInterval)
        keyRetryError = error
      }
      throw error
    }
  }

  /// True once this process knows the key is not the one the device registered with. A 409 at register is then the
  /// server waiting for an operator re-key, not a verdict on this install.
  private var afterRotation = false

  /// The key is not the one this device registered with: forget the device id so the next pass registers a new one.
  /// Two sources, both honoured: this load's origin (a key made just now) and the store's DURABLE record of the id it
  /// replaced (a rotation the client missed because its own deadline had passed, or an earlier process made).
  private func applyRotation(of load: FleetKeyLoad) {
    var reason: String?
    switch load.origin {
    case .existing: break
    case .fresh: reason = state.deviceID == nil ? nil : "no key on this Mac"
    case .rotated(let why): reason = why
    }
    if load.replacesDeviceID != nil || { if case .rotated = load.origin { return true }; return false }() { afterRotation = true }
    if let replaced = load.replacesDeviceID, replaced == state.deviceID {
      reason = reason ?? load.rotationReason ?? "recorded"
    }
    guard let reason, let old = state.deviceID else { return }
    afterRotation = true
    rotation = (reason, String(old.dropFirst(4).prefix(8)))
    state.deviceID = nil
    persist()
  }

  // MARK: Register

  public func registerIfNeeded() async -> FleetPollStep {
    guard config.enabled else { return .stop("disabled") }
    if state.installID == nil { loadState() }
    if state.deviceID != nil { return .handled(0) }
    guard let session = roomSession() else { return .wait(30) }
    do {
      let key = try await signingKey()
      guard state.deviceID == nil else { return .handled(0) }
      let proof = try FleetToken.registrationProof(
        key: key, installID: config.installID, iat: now(), jti: makeJTI())
      var body =
        "{\"install_id\":\(FleetJSON.quote(config.installID)),\"machine\":\(FleetJSON.quote(config.machine))"
      if let hw = config.hwModel { body += ",\"hw_model\":\(FleetJSON.quote(String(hw.prefix(64))))" }
      if let hv = config.helperVersion { body += ",\"helper_version\":\(FleetJSON.quote(String(hv.prefix(32))))" }
      body += ",\"key_alg\":\"ed25519\",\"public_key\":\(FleetJSON.quote(key.publicKeyBase64)),\"proof\":\(FleetJSON.quote(proof))}"
      let response = try await transport.send(
        FleetRequest(
          method: "POST", path: "/api/fleet/register",
          headers: ["Authorization": "Bearer \(session)", "Content-Type": "application/json"],
          body: Data(body.utf8), timeout: 30))
      switch response.status {
      case 200, 201:
        guard let json = try? FleetJSON.parse(response.body),
          let id = json.objectValue?["device_id"]?.stringValue,
          FleetEnvelope.matches(id, "^dev_[0-9a-f]{24}$")
        else { return .wait(backoff.failure()) }
        state.deviceID = id
        persist()
        backoff.success()
        if let note = rotation {
          log("fleet key: keychain item unreadable (\(note.reason)), registered as new device \(id.dropFirst(4).prefix(8)); old device \(note.oldDevice) needs retiring")
          rotation = nil
        }
        log("fleet device registered")
        return .handled(1)
      case 409:
        let code = errorCode(response)
        if afterRotation, code == "KEY_CONFLICT" || code == "REVOKED" {
          // 0.1.40 R2. The server holds the old key for this install until an operator re-keys it. That is a wait, not
          // a stop: nothing is persisted, the register is asked again every 900 s, and no restart is needed.
          // At most one line an hour while it lasts. The fingerprint is the HASH of the public key (the proof's `pk`
          // claim, first 12 characters): what the operator approves. The key itself is never logged.
          if lastRefusedLogAt.map({ clock().timeIntervalSince($0) >= Self.refusedLogInterval }) ?? true {
            lastRefusedLogAt = clock()
            let fingerprint = key.publicKeySHA256B64URL.prefix(12)
            log("fleet client: register refused (\(code)) after key rotation; key fp \(fingerprint); waiting for operator re-key, retry every ~900 s")
          }
          // ±10 % so a fleet that was refused together does not ask together.
          return .wait(Self.rekeyRetryInterval * (1 + rekeyJitter()))
        }
        if ["REVOKED", "RETIRED", "KEY_CONFLICT"].contains(code) {
          return stop("register_\(code.lowercased())")
        }
        return .wait(backoff.failure())
      default:
        return .wait(backoff.failure())
      }
    } catch {
      noteFailure("register", error)
      return .wait(backoff.failure())
    }
  }

  // MARK: Poll

  public func pollOnce() async -> FleetPollStep {
    guard config.enabled else { return .stop("disabled") }
    if state.installID == nil { loadState() }
    guard state.deviceID != nil else { return .wait(1) }
    do {
      let response = try await transport.send(
        FleetRequest(
          method: "GET", path: "/api/fleet/poll", query: ["wait": "25"],
          headers: ["Authorization": "Device \(try await token(method: "GET", path: "/api/fleet/poll", body: nil))"],
          body: nil, timeout: 40))
      switch response.status {
      case 200:
        guard let json = try? FleetJSON.parse(response.body), let object = json.objectValue,
          object["ok"] == .bool(true), let commands = object["commands"]?.arrayValue
        else { return .wait(backoff.failure()) }
        backoff.success()
        if let serverTime = object["server_time"]?.stringValue, let date = FleetEnvelope.date(serverTime) {
          lastServerSkew = clock().timeIntervalSince(date)
        }
        let kill = object["kill_switch"]?.objectValue?["global"]?.boolValue ?? false
        for command in commands.prefix(10) { await handle(command, killSwitch: kill) }
        // An empty answer after the wait is normal: poll again at once. A short pause only keeps a
        // server that answers instantly (a kill switch) from becoming a hot loop.
        return commands.isEmpty && kill ? .wait(5) : .handled(commands.count)
      case 401:
        let code = errorCode(response)
        if ["revoked", "unknown_device"].contains(code) { return stop("poll_\(code)") }
        if ["expired", "not_yet_valid"].contains(code) { return .wait(60) }  // the clock is off; do not hammer
        return .wait(backoff.failure())
      default:
        return .wait(backoff.failure())
      }
    } catch {
      noteFailure("poll", error)
      return .wait(backoff.failure())
    }
  }

  // MARK: One command

  func handle(_ json: FleetJSON, killSwitch: Bool) async {
    guard let deviceID = state.deviceID else { return }
    let cmdID = json.objectValue?["cmd_id"]?.stringValue
    // At-least-once delivery: a command we already answered is answered again with the stored
    // result and is never run twice.
    if let cmdID, let stored = state.results.first(where: { $0.cmdID == cmdID }) {
      await post(stored)
      return
    }
    let started = clock()
    let verifier = FleetVerifier(serverKeys: serverKeys, deviceID: deviceID, machine: config.machine)
    let rates = FleetRateState(
      privilegedInLastHour: state.privilegedRuns(inHourBefore: now()),
      secondsSinceLastReset: state.lastCoreaudiodReset.map { now() - $0 })
    let verdict = verifier.verify(
      json, now: started, nonceSeen: { [state] in state.nonceSeen($0) }, gates: await gates(),
      rates: rates, killSwitch: killSwitch)
    switch verdict {
    case .failure(let refusal):
      // Without a cmd_id there is nothing to report against; the server will offer it again until it expires.
      guard let cmdID, FleetEnvelope.matches(cmdID, "^[A-Za-z0-9_-]{1,64}$") else {
        log("fleet command dropped: \(refusal.rawValue)")
        return
      }
      log("fleet command refused: \(refusal.rawValue)")
      await finish(cmdID: cmdID, deviceID: deviceID, outcome: "refused", reason: refusal.rawValue, detail: [:],
        started: started, after: nil)
    case .success(let accepted):
      state.remember(nonce: accepted.envelope.nonce)
      if accepted.verb.isPrivileged { state.recordPrivilegedRun(at: now()) }
      if accepted.verb == .coreaudiodReset { state.lastCoreaudiodReset = now() }
      persist()
      let result = await executor.execute(accepted.verb, params: accepted.params, envelope: accepted.envelope)
      await finish(
        cmdID: accepted.envelope.cmdID, deviceID: deviceID, outcome: result.outcome.rawValue,
        reason: result.reason, detail: result.detail, started: started, after: result.afterResultPosted)
    }
  }

  private func finish(
    cmdID: String, deviceID: String, outcome: String, reason: String?, detail: [String: FleetJSON],
    started: Date, after: (@Sendable () async -> Void)?
  ) async {
    var outcome = outcome
    var reason = reason.map(Self.sanitiseReason)
    var detail = detail
    if !Self.detailIsClosed(detail) {
      detail = [:]
      outcome = "failed"
      reason = "bad_detail"
    }
    let body = FleetJSON.object([
      "cmd_id": .string(cmdID), "device_id": .string(deviceID), "outcome": .string(outcome),
      "reason": reason.map(FleetJSON.string) ?? .null,
      "started_at": .string(Self.iso(started)), "finished_at": .string(Self.iso(clock())),
      "detail": .object(detail), "upload": .null,
    ]).canonical
    let stored = FleetStoredResult(cmdID: cmdID, body: body, posted: false)
    state.store(result: stored)
    persist()
    await post(stored)
    if state.results.first(where: { $0.cmdID == cmdID })?.posted == true, let after { await after() }
  }

  // MARK: Other routes the device may post to

  /// The only route besides `/api/fleet/*` this device authenticates to: the kiosk-health sink (#47, 0.1.36).
  public static let kioskHealthPath = "/api/kiosk-health"

  /// A device-authenticated POST of `body` to the kiosk-health sink, with a fresh token bound to this method, path and
  /// body. Nil when the device is not enrolled, the client has stopped, or the request never got an HTTP answer.
  public func postKioskHealth(_ body: Data, timeout: TimeInterval = 30) async -> FleetResponse? {
    guard config.enabled else { return nil }
    if state.installID == nil { loadState() }
    guard state.stoppedReason == nil, state.deviceID != nil else { return nil }
    do {
      return try await transport.send(
        FleetRequest(
          method: "POST", path: Self.kioskHealthPath,
          headers: [
            "Authorization": "Device \(try await token(method: "POST", path: Self.kioskHealthPath, body: body))",
            "Content-Type": "application/json",
          ], body: body, timeout: timeout))
    } catch {
      noteFailure("kiosk_health_post", error)
      return nil
    }
  }

  /// The only other GET this device authenticates to (#49, 0.1.37): its steward repair tickets, signed by the server and
  /// verified by the root helper, not here. Nil when not enrolled, stopped, or no HTTP answer.
  public static let stewardTicketsPath = "/api/steward/tickets"

  public func fetchStewardTickets(machine: String, timeout: TimeInterval = 20) async -> FleetResponse? {
    guard config.enabled else { return nil }
    if state.installID == nil { loadState() }
    guard state.stoppedReason == nil, state.deviceID != nil else { return nil }
    do {
      return try await transport.send(
        FleetRequest(
          method: "GET", path: Self.stewardTicketsPath, query: ["machine": machine],
          headers: ["Authorization": "Device \(try await token(method: "GET", path: Self.stewardTicketsPath, body: nil))"],
          body: nil, timeout: timeout))
    } catch {
      noteFailure("steward_tickets", error)
      return nil
    }
  }

  // MARK: Results

  /// Re-send anything that has not been acknowledged. Each attempt gets a new token.
  public func flushResults() async {
    for stored in state.results where !stored.posted { await post(stored) }
  }

  private func post(_ stored: FleetStoredResult) async {
    guard state.deviceID != nil else { return }
    let body = Data(stored.body.utf8)
    do {
      let response = try await transport.send(
        FleetRequest(
          method: "POST", path: "/api/fleet/results",
          headers: [
            "Authorization": "Device \(try await token(method: "POST", path: "/api/fleet/results", body: body))",
            "Content-Type": "application/json",
          ], body: body, timeout: 30))
      switch response.status {
      case 200:
        markPosted(stored.cmdID)
      case 401, 429, 500...599:
        break  // try again later with a fresh token
      default:
        // 400/403/404/409/413: the server will not take this answer. Keep it from looping.
        log("fleet result not accepted (\(response.status)): \(errorCode(response))")
        markPosted(stored.cmdID)
      }
    } catch {
      noteFailure("result_post", error)
      // stays unposted and goes out again on the next pass
    }
  }

  private func markPosted(_ cmdID: String) {
    guard var item = state.results.first(where: { $0.cmdID == cmdID }) else { return }
    item.posted = true
    state.store(result: item)
    persist()
  }

  // MARK: Helpers

  /// The key is loaded FIRST and the device id read AFTER, so a key that had to be replaced never signs for the old id.
  private func token(method: String, path: String, body: Data?) async throws -> String {
    let key = try await signingKey()
    guard let deviceID = state.deviceID else { throw FleetClientError.reenrolling }
    return try FleetToken.device(
      key: key, deviceID: deviceID, method: method, path: path, body: body, iat: now(),
      jti: makeJTI())
  }

  private func errorCode(_ response: FleetResponse) -> String {
    (try? FleetJSON.parse(response.body))?.objectValue?["error"]?.stringValue ?? ""
  }

  private func stop(_ reason: String) -> FleetPollStep {
    state.stoppedReason = reason
    persist()
    return .stop(reason)
  }

  static func iso(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }

  /// The server accepts `[a-z0-9_]{1,64}`. Engine reasons can carry spaces and colons; fold them.
  static func sanitiseReason(_ text: String) -> String {
    let cleaned = String(
      text.lowercased().unicodeScalars.prefix(64).map { scalar -> Character in
        let ok = (scalar.value >= 97 && scalar.value <= 122) || (scalar.value >= 48 && scalar.value <= 57) || scalar == "_"
        return ok ? Character(scalar) : "_"
      })
    return cleaned.isEmpty ? "unspecified" : cleaned
  }

  /// `detail`: keys `[a-z_][a-z0-9_]*`, depth ≤ 4, ≤ 4096 bytes serialised.
  static func detailIsClosed(_ detail: [String: FleetJSON]) -> Bool {
    let value = FleetJSON.object(detail)
    func depth(_ v: FleetJSON) -> Int {
      switch v {
      case .object(let o): return 1 + (o.values.map(depth).max() ?? 0)
      case .array(let a): return 1 + (a.map(depth).max() ?? 0)
      default: return 0
      }
    }
    return value.keysCanonical && depth(value) <= 4 && value.canonicalData.count <= 4096
  }
}
