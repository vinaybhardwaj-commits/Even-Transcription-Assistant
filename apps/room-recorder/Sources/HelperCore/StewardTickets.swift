import CryptoKit
import FleetCore
import Foundation

/// #49 (TS-H12, 0.1.37): the Room Steward's repair tickets, verified and run by the root helper.
///
/// ─── WHAT A TICKET IS ──────────────────────────────────────────────────────────────────────
/// The server (`lib/steward/tickets.ts`) signs a small JSON object with Ed25519:
///   { v:1, ticket_id, machine, action, params, issued_at, expires_at, nonce }
/// over the canonical form (keys sorted, no whitespace). The public key is PINNED here (key id `6275a79b`); it is not served,
/// so a leaked database or a hijacked endpoint cannot make a ticket this helper will run.
///
/// ─── HOW IT REACHES THE HELPER ─────────────────────────────────────────────────────────────
/// The helper holds no server credential. The APP fetches `GET /api/steward/tickets` with its device JWT and hands the tickets
/// over XPC; the helper trusts nothing but the signature. Results leave as `steward.result` events on the kiosk-health stream
/// (the app posts them), which is exactly what `lib/steward/results.ts` reads.
///
/// ─── WHAT RUNS ─────────────────────────────────────────────────────────────────────────────
///   wake                  -> the `wake` verb (caffeinate -u -t 5)
///   open_pulse{profile}   -> `open_pulse`
///   relaunch_chrome{p}    -> `chrome_relaunch`   (never 07:30-21:30 IST)
///   policy_cycle{p}       -> `policy_cycle`      (never 07:30-21:30 IST)
///   restart_recorder_app  -> `restart_recorder`  (never under an open session, never 07:30-21:30 IST: a ticket carries no approval)
///   restart_kiosk_health  -> the helper's own collectors restart
/// Nothing a ticket does can end a recording or touch audio.
public enum StewardKeys {
  public static let ticketKeyID = "6275a79b"
  /// The 32 raw bytes of the Ed25519 public key in `lib/steward/ticket-public-key.ts`, standard base64.
  public static let ticketPublicKey = "gNWhOdzRnAxIYueVlkBbGV9TLdG9G71rO/tSIDwB4jI="

  /// The key id of a raw Ed25519 public key as `lib/steward/ticket-public-key.ts` defines it: the first 8 hex of the SHA-256
  /// of the SPKI DER (the 12-byte Ed25519 prefix and the 32 key bytes).
  public static func keyID(of raw: Data) -> String {
    let spki = Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]) + raw
    return SHA256.hash(data: spki).prefix(4).map { String(format: "%02x", $0) }.joined()
  }

  /// The compiled-in key, or nil if it is not 32 bytes or does not hash to the pinned id: a corrupted constant refuses
  /// every ticket instead of trusting a different key.
  public static func pinned(keyText: String = ticketPublicKey, expectedID: String = ticketKeyID) -> Data? {
    guard let raw = FleetB64.fromStd(keyText), raw.count == 32, keyID(of: raw) == expectedID else { return nil }
    return raw
  }
}

public enum StewardAction: String, CaseIterable, Sendable {
  case wake
  case openPulse = "open_pulse"
  case relaunchChrome = "relaunch_chrome"
  case policyCycle = "policy_cycle"
  case restartRecorderApp = "restart_recorder_app"
  case restartKioskHealth = "restart_kiosk_health"

  /// Stops and starts something: Chrome, the recorder, or the helper's collectors. ONE gate covers all four (B2, 0.1.37 R2):
  /// no update in flight, not in clinic hours, no open session of any kind, at most 10 an hour.
  var restartsSomething: Bool {
    switch self {
    case .relaunchChrome, .policyCycle, .restartRecorderApp, .restartKioskHealth: return true
    default: return false
    }
  }
}

/// The reasons a ticket is turned away. The first six are the server verifier's own, in its order.
public enum StewardRefusal: String, Error, Equatable, Sendable {
  case malformed
  case badSignature = "bad_signature"
  case expired
  case actionNotAllowed = "action_not_allowed"
  case badParams = "bad_params"
  case machineMismatch = "machine_mismatch"
  case replay
  case outstanding
  case sessionOpen = "session_open"
  case noConsoleUser = "no_console_user"
  case clinicHours = "clinic_hours_no_restart"
  case rateLimited = "rate_limited"
  case updateInProgress = "update_in_progress"
  case unsupported

  /// The `outcome` word `lib/steward/results.ts` accepts.
  var outcome: String {
    switch self {
    case .expired: return "expired"
    case .actionNotAllowed, .unsupported: return "unsupported"
    default: return "rejected"
    }
  }
}

public struct StewardTicket: Equatable, Sendable {
  public static let fields: Set<String> = ["v", "ticket_id", "machine", "action", "params", "issued_at", "expires_at", "nonce"]
  public static let maxTTL: TimeInterval = 900
  public var ticketID: String
  public var machine: String
  public var actionName: String
  public var params: [String: FleetJSON]
  public var issuedAt: Date
  public var expiresAt: Date
  public var nonce: String
  public var signedBytes: Data

  /// Every object key, at any depth, matches `^[a-z_][a-z0-9_]*$` (the server's KEY_RE).
  static func keysCanonical(_ json: FleetJSON) -> Bool {
    switch json {
    case .array(let items): return items.allSatisfy(keysCanonical)
    case .object(let object):
      return object.allSatisfy { $0.key.range(of: "^[a-z_][a-z0-9_]*$", options: .regularExpression) != nil && keysCanonical($0.value) }
    default: return true
    }
  }

  /// Shape check, the server's `malformed`: exactly the eight fields, the right types, canonical keys.
  public static func parse(_ json: FleetJSON) -> StewardTicket? {
    guard let o = json.objectValue, Set(o.keys) == fields, o["v"]?.intValue == 1, keysCanonical(json),
      let id = o["ticket_id"]?.stringValue, (1...64).contains(id.utf8.count),
      let machine = o["machine"]?.stringValue, (1...128).contains(machine.utf8.count),
      let action = o["action"]?.stringValue, let params = o["params"]?.objectValue,
      let issuedText = o["issued_at"]?.stringValue, let issued = FleetEnvelope.date(issuedText),
      let expiresText = o["expires_at"]?.stringValue, let expires = FleetEnvelope.date(expiresText),
      let nonce = o["nonce"]?.stringValue, (1...64).contains(nonce.utf8.count)
    else { return nil }
    return StewardTicket(
      ticketID: id, machine: machine, actionName: action, params: params, issuedAt: issued, expiresAt: expires, nonce: nonce,
      signedBytes: json.canonicalData)
  }

  /// `signature` is standard base64 of 64 bytes: exactly 88 characters, padded, canonical.
  public static func signatureBytes(_ text: String) -> Data? {
    guard text.utf8.count == 88, text.range(of: "^[A-Za-z0-9+/]{86}==$", options: .regularExpression) != nil,
      let data = FleetB64.fromStd(text), data.count == 64, data.base64EncodedString() == text
    else { return nil }
    return data
  }

  /// The server verifier's order: malformed, bad_signature, expired, action_not_allowed, bad_params, machine_mismatch.
  public static func verify(
    ticket json: FleetJSON, signature: String, publicKey: Data, machine: String, now: Date
  ) -> Result<(ticket: StewardTicket, action: StewardAction), StewardRefusal> {
    guard let ticket = parse(json) else { return .failure(.malformed) }
    guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey), let sig = signatureBytes(signature),
      key.isValidSignature(sig, for: ticket.signedBytes)
    else { return .failure(.badSignature) }
    guard now < ticket.expiresAt, ticket.expiresAt.timeIntervalSince(ticket.issuedAt) <= maxTTL, ticket.expiresAt > ticket.issuedAt
    else { return .failure(.expired) }
    guard let action = StewardAction(rawValue: ticket.actionName) else { return .failure(.actionNotAllowed) }
    guard paramsValid(action, ticket.params) else { return .failure(.badParams) }
    guard ticket.machine == machine else { return .failure(.machineMismatch) }
    return .success((ticket, action))
  }

  /// open_pulse / relaunch_chrome / policy_cycle take exactly `{profile}` (a Chrome profile directory); the rest take `{}`.
  static func paramsValid(_ action: StewardAction, _ params: [String: FleetJSON]) -> Bool {
    switch action {
    case .openPulse, .relaunchChrome, .policyCycle:
      guard params.count == 1, let profile = params["profile"]?.stringValue else { return false }
      return FleetVerb.isChromeProfile(profile)
    default: return params.isEmpty
    }
  }
}

/// What the helper remembers about tickets (root-only): nonces it has seen, and when it last disturbed something.
public struct StewardState: Codable, Equatable, Sendable {
  public var nonces: [String] = []
  public var restartRuns: [Int] = []
  public init() {}
  enum CodingKeys: String, CodingKey {
    case nonces
    case restartRuns = "restart_runs"
  }
}

public final class StewardExecutor: @unchecked Sendable {
  public static let nonceLimit = 1_000
  public static let restartCeilingPerHour = 10

  private let publicKey: Data
  private let machine: @Sendable () -> String
  private let env: HelperEnvironment
  private let tools: SystemTools
  private let chrome: ChromePolicyReconciler?
  private let files: ChromePolicyFiles
  private let statePath: String
  private let restartCollectors: (@Sendable () -> Bool)?
  private let isUpdating: @Sendable () -> Bool
  /// v2 envelopes riding the same fetch go to the helper's own signed-command runner, which verifies them for itself.
  private let envelopeRunner: (@Sendable (_ envelope: String, _ deviceID: String, _ machine: String) -> HelperCommandOutcome)?
  private let emit: @Sendable (HelperEvent) -> Void
  private let log: @Sendable (String) -> Void
  private let lock = NSLock()

  public init(
    publicKey: Data? = nil, machine: @escaping @Sendable () -> String, env: HelperEnvironment, tools: SystemTools,
    chrome: ChromePolicyReconciler?, files: ChromePolicyFiles = SystemChromePolicyFiles(),
    statePath: String = HelperPaths.supportDirectory + "/helper-steward-state.json",
    restartCollectors: (@Sendable () -> Bool)? = nil, isUpdating: @escaping @Sendable () -> Bool = { false },
    envelopeRunner: (@Sendable (_ envelope: String, _ deviceID: String, _ machine: String) -> HelperCommandOutcome)? = nil,
    emit: @escaping @Sendable (HelperEvent) -> Void, log: @escaping @Sendable (String) -> Void
  ) {
    self.publicKey = publicKey ?? StewardKeys.pinned() ?? Data()
    self.machine = machine
    self.env = env
    self.tools = tools
    self.chrome = chrome
    self.files = files
    self.statePath = statePath
    self.restartCollectors = restartCollectors
    self.isUpdating = isUpdating
    self.envelopeRunner = envelopeRunner
    self.emit = emit
    self.log = log
  }

  /// nil when the ledger EXISTS and cannot be read (corrupt, a link, a FIFO): then nothing is run, because an unreadable ledger
  /// must not be treated as an empty one, which would let an old ticket be replayed. A missing file is a fresh ledger.
  private func loadState() -> StewardState? {
    if let data = files.read(statePath) { return try? JSONDecoder().decode(StewardState.self, from: data) }
    return files.present(statePath) ? nil : StewardState()
  }
  private func saveState(_ state: StewardState) {
    if let data = try? JSONEncoder().encode(state) { _ = files.writeAtomic(statePath, data: data, mode: 0o600) }
  }

  public struct Report: Equatable, Sendable {
    public var ticketID: String
    public var nonce: String
    public var outcome: String
    public var detail: String
  }

  /// One fetch's worth of tickets, `{"tickets":[{"ticket":{...},"signature":"..."}, ...]}`. Every ticket gets exactly one
  /// `steward.result` event, whatever happened to it.
  @discardableResult
  public func receive(ticketsJSON: String, deviceID: String = "", fleetMachine: String = "") -> [Report] {
    lock.lock(); defer { lock.unlock() }
    guard let root = try? FleetJSON.parse(Data(ticketsJSON.utf8)), let list = root.objectValue?["tickets"]?.arrayValue else { return [] }
    var reports: [Report] = []
    // The batch's key id, when it names one, must be ours (B2/R2: checked in code, not only in a test).
    if let kid = root.objectValue?["key_id"]?.stringValue, kid != StewardKeys.ticketKeyID {
      return rejectAll(list, why: "unknown_key_id")
    }
    guard !publicKey.isEmpty else { return rejectAll(list, why: "key_not_pinned") }
    guard var state = loadState() else { return rejectAll(list, why: "state_unreadable") }
    var actionsThisBatch = Set<String>()
    let now = env.now()
    for item in list.prefix(10) {
      guard let o = item.objectValue else { continue }
      if let envelope = o["envelope"] {
        // A v2 envelope: its own verifier runs it. The result is reported against the envelope's cmd_id and nonce.
        guard let runner = envelopeRunner, let id = envelope.objectValue?["cmd_id"]?.stringValue,
          let nonce = envelope.objectValue?["nonce"]?.stringValue, (1...64).contains(id.utf8.count), (1...64).contains(nonce.utf8.count)
        else { continue }
        let outcome = runner(envelope.canonical, deviceID, fleetMachine)
        let word: String
        switch outcome.kind {
        case .ok: word = "done"
        case .unsupported: word = "unsupported"
        case .refused: word = outcome.reason == "expired" ? "expired" : "rejected"
        case .failed: word = "failed"
        }
        let report = Report(ticketID: id, nonce: nonce, outcome: word, detail: outcome.reason ?? word)
        reports.append(report)
        emit(HelperEvent("steward.result", ["ticket_id": .string(id), "nonce": .string(nonce), "outcome": .string(word), "detail": .string(String(report.detail.prefix(300)))]))
        continue
      }
      guard let ticketJSON = o["ticket"], let signature = o["signature"]?.stringValue else { continue }
      let report = handle(ticketJSON, signature: signature, state: &state, actionsThisBatch: &actionsThisBatch, now: now)
      guard let report else { continue }  // no ticket id to report against
      reports.append(report)
      emit(HelperEvent("steward.result", [
        "ticket_id": .string(report.ticketID), "nonce": .string(report.nonce), "outcome": .string(report.outcome), "detail": .string(String(report.detail.prefix(300))),
      ]))
    }
    saveState(state)
    return reports
  }

  /// Every ticket in the list gets a `rejected` result with `why`, and nothing runs or is written.
  private func rejectAll(_ list: [FleetJSON], why: String) -> [Report] {
    log("steward: all tickets refused: \(why)")
    var reports: [Report] = []
    for item in list.prefix(10) {
      let ticket = item.objectValue?["ticket"]?.objectValue
      let envelope = item.objectValue?["envelope"]?.objectValue
      guard let id = ticket?["ticket_id"]?.stringValue ?? envelope?["cmd_id"]?.stringValue,
        let nonce = ticket?["nonce"]?.stringValue ?? envelope?["nonce"]?.stringValue, (1...64).contains(id.utf8.count), (1...64).contains(nonce.utf8.count)
      else { continue }
      let report = Report(ticketID: id, nonce: nonce, outcome: "rejected", detail: why)
      reports.append(report)
      emit(HelperEvent("steward.result", ["ticket_id": .string(id), "nonce": .string(nonce), "outcome": .string("rejected"), "detail": .string(why)]))
    }
    return reports
  }

  private func handle(_ json: FleetJSON, signature: String, state: inout StewardState, actionsThisBatch: inout Set<String>, now: Date) -> Report? {
    let verdict = StewardTicket.verify(ticket: json, signature: signature, publicKey: publicKey, machine: machine(), now: now)
    let id = json.objectValue?["ticket_id"]?.stringValue
    let nonce = json.objectValue?["nonce"]?.stringValue
    guard case .success(let (ticket, action)) = verdict else {
      guard case .failure(let why) = verdict else { return nil }
      log("steward: ticket refused: \(why.rawValue)")
      // Without a ticket id and nonce the server cannot match a result to anything.
      guard let id, let nonce, (1...64).contains(id.utf8.count), (1...64).contains(nonce.utf8.count) else { return nil }
      return Report(ticketID: id, nonce: nonce, outcome: why.outcome, detail: why.rawValue)
    }
    func refuse(_ why: StewardRefusal) -> Report {
      log("steward: \(action.rawValue) refused: \(why.rawValue)")
      return Report(ticketID: ticket.ticketID, nonce: ticket.nonce, outcome: why.outcome, detail: why.rawValue)
    }
    if state.nonces.contains(ticket.nonce) { return refuse(.replay) }
    // The server keeps one outstanding ticket per (machine, action); two in one batch are refused here as well.
    if !actionsThisBatch.insert(action.rawValue).inserted { return refuse(.outstanding) }
    // Spent from here on: a ticket that is refused or fails is not offered to the helper twice.
    state.nonces.append(ticket.nonce)
    if state.nonces.count > Self.nonceLimit { state.nonces.removeFirst(state.nonces.count - Self.nonceLimit) }
    let epoch = Int(now.timeIntervalSince1970)
    state.restartRuns.removeAll { $0 < epoch - 3600 }
    if action.restartsSomething {
      if isUpdating() { return refuse(.updateInProgress) }
      if FleetClock.inClinicHours(now) { return refuse(.clinicHours) }
      // The same fail-closed probe the signed commands use: recording, paused or an unreadable status all count as a session.
      if SessionProbe.isOpen(env: env) { return refuse(.sessionOpen) }
      if state.restartRuns.count >= Self.restartCeilingPerHour { return refuse(.rateLimited) }
      state.restartRuns.append(epoch)
    }
    let user = env.consoleUser()
    let result: HelperCommandOutcome
    switch action {
    case .wake:
      let run = tools.run("/usr/bin/caffeinate", ["-u", "-t", "5"])
      result = run.status == 0 ? HelperCommandOutcome(.ok) : HelperCommandOutcome(.failed, reason: "caffeinate_\(run.status)")
    case .openPulse:
      guard let chrome else { return refuse(.unsupported) }
      guard user != nil else { return refuse(.noConsoleUser) }
      result = chrome.openPulse(profile: ticket.params["profile"]?.stringValue ?? "")
    case .relaunchChrome:
      guard let chrome else { return refuse(.unsupported) }
      guard user != nil else { return refuse(.noConsoleUser) }
      result = chrome.relaunch(profile: ticket.params["profile"]?.stringValue)
    case .policyCycle:
      guard let chrome else { return refuse(.unsupported) }
      guard user != nil else { return refuse(.noConsoleUser) }
      result = chrome.cycle(profile: ticket.params["profile"]?.stringValue)
    case .restartRecorderApp:
      guard let user else { return refuse(.noConsoleUser) }
      let run = tools.run("/bin/launchctl", ["kickstart", "-k", "gui/\(user.uid)/\(HelperPaths.agentLabel)"])
      result = run.status == 0 ? HelperCommandOutcome(.ok) : HelperCommandOutcome(.failed, reason: "launchctl_\(run.status)")
    case .restartKioskHealth:
      guard let restartCollectors else { return refuse(.unsupported) }
      result = restartCollectors() ? HelperCommandOutcome(.ok) : HelperCommandOutcome(.failed, reason: "collectors_not_restarted")
    }
    let outcome: String
    switch result.kind {
    case .ok: outcome = "done"
    case .unsupported: outcome = "unsupported"
    case .refused: outcome = "rejected"
    case .failed: outcome = "failed"
    }
    log("steward: \(action.rawValue): \(outcome)")
    return Report(ticketID: ticket.ticketID, nonce: ticket.nonce, outcome: outcome, detail: result.reason ?? outcome)
  }
}

extension StewardExecutor: StewardRelay {
  public func receiveTickets(json: String, deviceID: String, machine: String) -> Int {
    receive(ticketsJSON: json, deviceID: deviceID, fleetMachine: machine).count
  }
}
