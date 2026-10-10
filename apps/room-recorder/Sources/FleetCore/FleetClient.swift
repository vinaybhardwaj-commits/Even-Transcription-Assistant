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
  func execute(_ verb: FleetVerb, params: FleetParams, commandID: String) async -> FleetExecResult
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
    log: @escaping @Sendable (String) -> Void
  ) {
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
    guard config.enabled else { return }
    loadState()
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
  }

  func loadState() {
    var loaded = store.load()
    if loaded.installID != config.installID {
      loaded = FleetState()  // a different enrolment starts clean
      loaded.installID = config.installID
    }
    state = loaded
  }

  private func persist() { store.save(state) }

  private func now() -> Int { Int(clock().timeIntervalSince1970) }

  private func signingKey() throws -> FleetSigningKey {
    if let key { return key }
    let made = try keys.loadOrCreate()
    key = made
    return made
  }

  // MARK: Register

  public func registerIfNeeded() async -> FleetPollStep {
    guard config.enabled else { return .stop("disabled") }
    if state.installID == nil { loadState() }
    if state.deviceID != nil { return .handled(0) }
    guard let session = roomSession() else { return .wait(30) }
    do {
      let key = try signingKey()
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
        log("fleet device registered")
        return .handled(1)
      case 409:
        let code = errorCode(response)
        if ["REVOKED", "RETIRED", "KEY_CONFLICT"].contains(code) {
          return stop("register_\(code.lowercased())")
        }
        return .wait(backoff.failure())
      default:
        return .wait(backoff.failure())
      }
    } catch {
      return .wait(backoff.failure())
    }
  }

  // MARK: Poll

  public func pollOnce() async -> FleetPollStep {
    guard config.enabled else { return .stop("disabled") }
    if state.installID == nil { loadState() }
    guard let deviceID = state.deviceID else { return .wait(1) }
    do {
      let response = try await transport.send(
        FleetRequest(
          method: "GET", path: "/api/fleet/poll", query: ["wait": "25"],
          headers: ["Authorization": "Device \(try token(method: "GET", path: "/api/fleet/poll", body: nil, deviceID: deviceID))"],
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
    let verdict = verifier.verify(
      json, now: started, nonceSeen: { [state] in state.nonceSeen($0) }, gates: await gates(),
      privilegedRunsInLastHour: state.privilegedRuns(inHourBefore: now()), killSwitch: killSwitch)
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
      persist()
      let result = await executor.execute(accepted.verb, params: accepted.params, commandID: accepted.envelope.cmdID)
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

  // MARK: Results

  /// Re-send anything that has not been acknowledged. Each attempt gets a new token.
  public func flushResults() async {
    for stored in state.results where !stored.posted { await post(stored) }
  }

  private func post(_ stored: FleetStoredResult) async {
    guard let deviceID = state.deviceID else { return }
    let body = Data(stored.body.utf8)
    do {
      let response = try await transport.send(
        FleetRequest(
          method: "POST", path: "/api/fleet/results",
          headers: [
            "Authorization": "Device \(try token(method: "POST", path: "/api/fleet/results", body: body, deviceID: deviceID))",
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
      // network: stays unposted and goes out again on the next pass
    }
  }

  private func markPosted(_ cmdID: String) {
    guard var item = state.results.first(where: { $0.cmdID == cmdID }) else { return }
    item.posted = true
    state.store(result: item)
    persist()
  }

  // MARK: Helpers

  private func token(method: String, path: String, body: Data?, deviceID: String) throws -> String {
    try FleetToken.device(
      key: try signingKey(), deviceID: deviceID, method: method, path: path, body: body, iat: now(),
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
