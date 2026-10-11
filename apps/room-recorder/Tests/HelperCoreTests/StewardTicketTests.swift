import CryptoKit
import Foundation
import Testing

@testable import FleetCore
@testable import HelperCore
@testable import KioskHealthCore
@testable import RoomRecorderCore

// MARK: - 0.1.37 (#49): steward tickets, verified and run by the root helper

/// A ticket signed the way `lib/steward/tickets.ts` signs it: Ed25519 over the canonical JSON (keys sorted, no whitespace).
struct TicketMaker {
  /// 16 random bytes, base64url without padding.
  static func freshNonce() -> String {
    let bytes: [UInt8] = (0..<16).map { _ in UInt8.random(in: 0...255) }
    var text = Data(bytes).base64EncodedString()
    text = text.replacingOccurrences(of: "+", with: "-")
    text = text.replacingOccurrences(of: "/", with: "_")
    return text.replacingOccurrences(of: "=", with: "")
  }
  let key = Curve25519.Signing.PrivateKey()
  var publicKey: Data { key.publicKey.rawRepresentation }

  func ticket(
    action: String = "wake", params: [String: FleetJSON] = [:], machine: String = "EHRC-CONSUL4s-Mac-mini",
    id: String = UUID().uuidString.lowercased(), nonce: String = TicketMaker.freshNonce(),
    issued: Date, ttl: TimeInterval = 600, version: Int64 = 1, extra: [String: FleetJSON] = [:], signWith other: Curve25519.Signing.PrivateKey? = nil
  ) -> FleetJSON {
    var o: [String: FleetJSON] = [
      "v": .int(version), "ticket_id": .string(id), "machine": .string(machine), "action": .string(action), "params": .object(params),
      "issued_at": .string(FleetClient.iso(issued)), "expires_at": .string(FleetClient.iso(issued.addingTimeInterval(ttl))), "nonce": .string(nonce),
    ]
    for (k, v) in extra { o[k] = v }
    return .object(o)
  }

  func sign(_ ticket: FleetJSON, with other: Curve25519.Signing.PrivateKey? = nil) -> String {
    try! (other ?? key).signature(for: ticket.canonicalData).base64EncodedString()
  }

  /// `{"tickets":[{ticket,signature}...]}` as the app forwards it.
  func batch(_ tickets: [FleetJSON], signWith other: Curve25519.Signing.PrivateKey? = nil) -> String {
    FleetJSON.object([
      "tickets": .array(tickets.map { .object(["ticket": $0, "signature": .string(sign($0, with: other))]) })
    ]).canonical
  }
}

final class StewardWorld: @unchecked Sendable {
  let maker = TicketMaker()
  let w = ChromeWorld()
  let statePath = "/support/helper-steward-state.json"
  var restarts = 0
  var restartOK = true
  var updating = false
  var events: [HelperEvent] { w.events }
  var envelopeCalls: [(String, String, String)] = []
  var envelopeOutcome = HelperCommandOutcome(.ok)

  var now: Date { w.env.clock }

  func executor(chrome: Bool = true, collectors: Bool = true) -> StewardExecutor {
    let reconciler: ChromePolicyReconciler? = chrome ? w.reconciler() : nil
    var restart: (@Sendable () -> Bool)?
    if collectors {
      restart = { [unowned self] in
        self.restarts += 1
        return self.restartOK
      }
    }
    let updatingNow: @Sendable () -> Bool = { [unowned self] in self.updating }
    let runEnvelope: @Sendable (String, String, String) -> HelperCommandOutcome = { [unowned self] e, d, m in
      self.envelopeCalls.append((e, d, m))
      return self.envelopeOutcome
    }
    let emit: @Sendable (HelperEvent) -> Void = { [unowned self] e in self.w.record(e) }
    return StewardExecutor(
      publicKey: maker.publicKey, machine: { "EHRC-CONSUL4s-Mac-mini" }, env: w.env, tools: w.tools, chrome: reconciler, files: w.files,
      statePath: statePath, restartCollectors: restart, isUpdating: updatingNow, envelopeRunner: runEnvelope, emit: emit, log: { _ in })
  }

  func send(_ x: StewardExecutor, _ action: String, _ params: [String: FleetJSON] = [:], at: Date? = nil) -> StewardExecutor.Report? {
    let t = maker.ticket(action: action, params: params, issued: at ?? now.addingTimeInterval(-5))
    return x.receive(ticketsJSON: maker.batch([t])).first
  }
}

extension ChromeWorld {
  func record(_ event: HelperEvent) { lock.lock(); events.append(event); lock.unlock() }
}

@Suite(.serialized) struct StewardTicketTests {
  // ─── the pinned key, and compatibility with the server's signer ────────────────────────────

  @Test func theCompiledInKeyIsTheServersTicketKey() {
    let raw = FleetB64.fromStd(StewardKeys.ticketPublicKey)
    #expect(raw?.count == 32)
    // key id = first 8 hex of sha256 of the SPKI DER, as lib/steward/ticket-public-key.ts defines it
    let spki = Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]) + (raw ?? Data())
    #expect(SHA256.hash(data: spki).prefix(4).map { String(format: "%02x", $0) }.joined() == StewardKeys.ticketKeyID)
    #expect(StewardKeys.ticketKeyID == "6275a79b")
  }

  @Test func aTicketSignedByTheServersOwnCodeVerifies_nodeVector() throws {
    // Produced by node with lib/steward/tickets.ts's sortKeys/JSON.stringify and a fixed seed (0x0c x 32); nothing here derives it.
    let pub = Data(base64Encoded: "C1E62bSSQBXKCQLtB5BE06xdvsIwbwaUjBDajrbjny0=")!
    let canonical =
      #"{"action":"relaunch_chrome","expires_at":"2026-10-11T22:10:00.000Z","issued_at":"2026-10-11T22:00:00.000Z","machine":"EHRC-CONSUL4s-Mac-mini","nonce":"AAAAAAAAAAAAAAAAAAAAAA","params":{"profile":"Profile 1"},"ticket_id":"11111111-2222-4333-8444-555555555555","v":1}"#
    let signature = "2BxELwd0N0+7nOKrLioCnI7e7hfWcu5Q4fX9ATHtoSJCw77KoCj2HG3F/etlTYOH9JSt0l8PHQzOnDfjuxhkCw=="
    // shuffled key order on the wire, as a transport might deliver it: the canonical form must put it right
    let wire = #"{"v":1,"ticket_id":"11111111-2222-4333-8444-555555555555","nonce":"AAAAAAAAAAAAAAAAAAAAAA","machine":"EHRC-CONSUL4s-Mac-mini","params":{"profile":"Profile 1"},"issued_at":"2026-10-11T22:00:00.000Z","expires_at":"2026-10-11T22:10:00.000Z","action":"relaunch_chrome"}"#
    let json = try FleetJSON.parse(Data(wire.utf8))
    #expect(String(decoding: json.canonicalData, as: UTF8.self) == canonical, "our canonical bytes are the server's")
    let now = FleetEnvelope.date("2026-10-11T22:01:00.000Z")!
    let ok = StewardTicket.verify(ticket: json, signature: signature, publicKey: pub, machine: "EHRC-CONSUL4s-Mac-mini", now: now)
    guard case .success(let (ticket, action)) = ok else { Issue.record("did not verify: \(ok)"); return }
    #expect(action == .relaunchChrome && ticket.params["profile"] == .string("Profile 1"))
  }

  // ─── the verifier's order, one refusal each ────────────────────────────────────────────────

  @Test func eachRefusalInTheServersOrder() throws {
    let m = TicketMaker()
    let now = TestServer.night
    let machine = "EHRC-CONSUL4s-Mac-mini"
    func verdict(_ ticket: FleetJSON, signature: String? = nil, machine: String = machine, at: Date = now) -> StewardRefusal? {
      if case .failure(let why) = StewardTicket.verify(ticket: ticket, signature: signature ?? m.sign(ticket), publicKey: m.publicKey, machine: machine, now: at) { return why }
      return nil
    }
    let good = m.ticket(issued: now.addingTimeInterval(-5))
    #expect(verdict(good) == nil)
    #expect(verdict(m.ticket(issued: now, version: 2)) == .malformed)
    #expect(verdict(m.ticket(issued: now, extra: ["extra": .int(1)])) == .malformed, "a ninth field")
    #expect(verdict(m.ticket(issued: now, extra: ["Params": .null])) == .malformed)
    #expect(verdict(.object(["v": .int(1)])) == .malformed)
    #expect(verdict(good, signature: String(repeating: "A", count: 86) + "==") == .badSignature)
    #expect(verdict(good, signature: "short") == .badSignature)
    #expect(verdict(good, signature: m.sign(good, with: Curve25519.Signing.PrivateKey())) == .badSignature, "another key")
    #expect(verdict(good, at: now.addingTimeInterval(700)) == .expired)
    #expect(verdict(m.ticket(issued: now, ttl: 901)) == .expired, "a window over 900 s")
    #expect(verdict(m.ticket(action: "format_disk", issued: now)) == .actionNotAllowed)
    #expect(verdict(m.ticket(action: "open_pulse", issued: now)) == .badParams, "open_pulse needs its profile")
    #expect(verdict(m.ticket(action: "open_pulse", params: ["profile": .string("../x")], issued: now)) == .badParams)
    #expect(verdict(m.ticket(action: "wake", params: ["x": .int(1)], issued: now)) == .badParams)
    #expect(verdict(m.ticket(machine: "OTHER", issued: now)) == .machineMismatch)
  }

  @Test func theSignatureIsCheckedBeforeTheWindowAndTheWindowBeforeTheAction() throws {
    let m = TicketMaker()
    let now = TestServer.night
    let expiredUnsigned = m.ticket(action: "format_disk", issued: now.addingTimeInterval(-3_000))
    if case .failure(let why) = StewardTicket.verify(ticket: expiredUnsigned, signature: String(repeating: "A", count: 86) + "==", publicKey: m.publicKey, machine: "x", now: now) {
      #expect(why == .badSignature)
    }
    if case .failure(let why) = StewardTicket.verify(ticket: expiredUnsigned, signature: m.sign(expiredUnsigned), publicKey: m.publicKey, machine: "x", now: now) {
      #expect(why == .expired)
    }
  }

  // ─── what runs ──────────────────────────────────────────────────────────────────────────────

  @Test func wakeRunsAndIsReportedDone() {
    let s = StewardWorld()
    let report = s.send(s.executor(), "wake")
    #expect(report?.outcome == "done")
    #expect(s.w.tools.calls == ["/usr/bin/caffeinate -u -t 5"])
    #expect(s.events.map(\.kind) == ["steward.result"])
    #expect(s.events[0].fields["outcome"] == .string("done") && s.events[0].fields["ticket_id"] == .string(report!.ticketID) && s.events[0].fields["nonce"] == .string(report!.nonce))
  }

  @Test func openPulseGoesToTheChromeCode() {
    let s = StewardWorld()
    s.w.env.directories[ChromeWorld.base] = ["Default"]
    #expect(s.send(s.executor(), "open_pulse", ["profile": .string("Default")])?.outcome == "done")
    #expect(s.w.launchctlOpens.count == 1 && s.w.launchctlOpens[0].contains("--profile-directory=Default"))
    #expect(s.send(s.executor(), "open_pulse", ["profile": .string("Profile 1")])?.outcome == "failed", "no such profile on this Mac")
  }

  @Test func relaunchAndPolicyCycleRunAtNightAndNeverInClinicHours() {
    let night = StewardWorld()
    night.w.storeConfig()
    #expect(night.send(night.executor(), "relaunch_chrome", ["profile": .string("Default")])?.outcome == "done")
    #expect(night.send(night.executor(), "policy_cycle", ["profile": .string("Default")])?.outcome == "done")
    let day = StewardWorld()
    day.w.env.clock = ChromeCatalogueTests.day  // 14:45 IST
    day.w.storeConfig()
    for action in ["relaunch_chrome", "policy_cycle"] {
      let r = day.send(day.executor(), action, ["profile": .string("Default")])
      #expect(r?.outcome == "rejected" && r?.detail == "clinic_hours_no_restart", "\(action)")
    }
    #expect(day.w.signals.isEmpty && day.w.launchctlOpens.isEmpty, "Chrome was not touched")
  }

  @Test func restartRecorderAppNeverRunsUnderASessionOrInClinicHours() {
    let s = StewardWorld()
    s.w.env.setStatus("recording")
    let busy = s.send(s.executor(), "restart_recorder_app")
    #expect(busy?.outcome == "rejected" && busy?.detail == "session_open")
    #expect(!s.w.tools.calls.contains { $0.contains("kickstart") }, "an open recording is never stopped by a ticket")
    s.w.env.setStatus("paused")
    #expect(s.send(s.executor(), "restart_recorder_app")?.detail == "session_open")
    s.w.env.files[FakeEnv.root + "/status.json"] = Data("garbage".utf8)
    #expect(s.send(s.executor(), "restart_recorder_app")?.detail == "session_open", "unreadable status fails closed")
    s.w.env.setStatus("ready")
    #expect(s.send(s.executor(), "restart_recorder_app")?.outcome == "done")
    #expect(s.w.tools.calls.contains("/bin/launchctl kickstart -k gui/501/com.evenscribe.room-recorder"))
    let day = StewardWorld()
    day.w.env.clock = ChromeCatalogueTests.day
    #expect(day.send(day.executor(), "restart_recorder_app")?.detail == "clinic_hours_no_restart")
  }

  @Test func restartKioskHealthRestartsTheCollectorsOnly() {
    let s = StewardWorld()
    #expect(s.send(s.executor(), "restart_kiosk_health")?.outcome == "done" && s.restarts == 1)
    s.restartOK = false
    #expect(s.send(s.executor(), "restart_kiosk_health")?.outcome == "failed")
    #expect(s.send(s.executor(collectors: false), "restart_kiosk_health")?.outcome == "unsupported")
    #expect(s.w.tools.calls.isEmpty)
  }

  @Test func noTicketRunsWhileAnUpdateIsInFlight() {
    let s = StewardWorld()
    s.updating = true
    s.w.storeConfig()
    for action in ["restart_recorder_app", "relaunch_chrome", "policy_cycle"] {
      let params: [String: FleetJSON] = action == "restart_recorder_app" ? [:] : ["profile": .string("Default")]
      #expect(s.send(s.executor(), action, params)?.detail == "update_in_progress", "\(action)")
    }
    #expect(s.send(s.executor(), "wake")?.outcome == "done", "a wake disturbs nothing")
  }

  @Test func withNobodyAtTheConsoleTheGuiActionsAreRefused() {
    let s = StewardWorld()
    s.w.env.console = nil
    s.w.storeConfig()
    #expect(s.send(s.executor(), "restart_recorder_app")?.detail == "no_console_user")
    #expect(s.send(s.executor(), "open_pulse", ["profile": .string("Default")])?.detail == "no_console_user")
    #expect(s.send(s.executor(), "relaunch_chrome", ["profile": .string("Default")])?.detail == "no_console_user")
  }

  // ─── replay, expiry, one outstanding ────────────────────────────────────────────────────────

  @Test func aReplayedTicketIsRefusedAndReported_evenByANewProcess() {
    let s = StewardWorld()
    let t = s.maker.ticket(action: "wake", issued: s.now.addingTimeInterval(-5))
    let batch = s.maker.batch([t])
    #expect(s.executor().receive(ticketsJSON: batch).first?.outcome == "done")
    let again = s.executor().receive(ticketsJSON: batch)  // a new executor: the ledger is on disk
    #expect(again.first?.outcome == "rejected" && again.first?.detail == "replay")
    #expect(s.w.tools.calls.filter { $0.contains("caffeinate") }.count == 1, "it ran once")
    #expect(s.events.map { $0.fields["outcome"] } == [.string("done"), .string("rejected")])
  }

  @Test func anExpiredTicketIsRefusedAndReportedExpired() {
    let s = StewardWorld()
    let old = s.maker.ticket(action: "wake", issued: s.now.addingTimeInterval(-3_000))
    let r = s.executor().receive(ticketsJSON: s.maker.batch([old]))
    #expect(r.first?.outcome == "expired" && s.w.tools.calls.isEmpty)
  }

  @Test func twoTicketsForOneActionInOneBatchRunOnce() {
    let s = StewardWorld()
    let a = s.maker.ticket(action: "wake", issued: s.now.addingTimeInterval(-5))
    let b = s.maker.ticket(action: "wake", issued: s.now.addingTimeInterval(-4))
    let r = s.executor().receive(ticketsJSON: s.maker.batch([a, b]))
    #expect(r.map(\.outcome) == ["done", "rejected"] && r[1].detail == "outstanding")
    #expect(s.w.tools.calls.filter { $0.contains("caffeinate") }.count == 1)
  }

  @Test func aTamperedOrForeignTicketIsReportedRejectedAndDoesNothing() {
    let s = StewardWorld()
    let t = s.maker.ticket(action: "wake", issued: s.now.addingTimeInterval(-5))
    let r = s.executor().receive(ticketsJSON: s.maker.batch([t], signWith: Curve25519.Signing.PrivateKey()))
    #expect(r.first?.outcome == "rejected" && r.first?.detail == "bad_signature")
    let foreign = s.maker.ticket(action: "wake", machine: "ANOTHER-MAC", issued: s.now.addingTimeInterval(-5))
    #expect(s.executor().receive(ticketsJSON: s.maker.batch([foreign])).first?.detail == "machine_mismatch")
    #expect(s.w.tools.calls.isEmpty)
  }

  @Test func theRestartCeilingIsTenAnHour() {
    let s = StewardWorld()
    s.w.storeConfig()
    var outcomes: [String] = []
    for _ in 0..<12 { outcomes.append(s.send(s.executor(), "policy_cycle", ["profile": .string("Default")])?.detail ?? "?") }
    #expect(outcomes.filter { $0 == "rate_limited" }.count == 2, "\(outcomes)")
    s.w.env.clock = s.w.env.clock.addingTimeInterval(3_700)
    #expect(s.send(s.executor(), "policy_cycle", ["profile": .string("Default")])?.outcome == "done")
  }

  @Test func theTokenAndTheTicketNonceNeverReachALogOrAnEventBeyondTheResultFields() {
    let s = StewardWorld()
    s.w.storeConfig()
    _ = s.send(s.executor(), "policy_cycle", ["profile": .string("Default")])
    let text = (s.w.logs + s.events.map { "\($0.fields)" }).joined()
    #expect(!text.contains("SECRET"))
  }

  // ─── v2 envelopes ride the same fetch ───────────────────────────────────────────────────────

  @Test func aV2EnvelopeInTheListGoesToTheSignedCommandRunnerAndIsReported() {
    let s = StewardWorld()
    let envelope = FleetJSON.object(["cmd_id": .string("cmd_77"), "nonce": .string("envelope-nonce-1"), "verb": .string("wake")])
    let body = FleetJSON.object(["tickets": .array([.object(["envelope": envelope])])]).canonical
    let r = s.executor().receive(ticketsJSON: body, deviceID: "dev_00000000000000000000000a", fleetMachine: "ehrc-consul4")
    #expect(r.map(\.outcome) == ["done"] && r[0].ticketID == "cmd_77" && r[0].nonce == "envelope-nonce-1")
    #expect(s.envelopeCalls.count == 1 && s.envelopeCalls[0].1 == "dev_00000000000000000000000a" && s.envelopeCalls[0].2 == "ehrc-consul4")
    s.envelopeOutcome = HelperCommandOutcome(.refused, reason: "session_open")
    let refused = s.executor().receive(ticketsJSON: body, deviceID: "dev_00000000000000000000000a", fleetMachine: "ehrc-consul4")
    #expect(refused.first?.outcome == "rejected")
  }

  // ─── the XPC verb ───────────────────────────────────────────────────────────────────────────

  @Test func theTicketVerbRoundTripsAndIsBounded() throws {
    let command = HelperCommand.stewardTickets(json: "{\"tickets\":[]}", deviceID: "dev_00000000000000000000000a", machine: "m")
    #expect(try HelperCodec.decode(try HelperCodec.encode(command)) == command)
    for bad in [
      try HelperCodec.encode(.stewardTickets(json: "", deviceID: "dev_00000000000000000000000a", machine: "m")),
      try HelperCodec.encode(.stewardTickets(json: String(repeating: "x", count: 6_001), deviceID: "dev_00000000000000000000000a", machine: "m")),
      try HelperCodec.encode(.stewardTickets(json: "{}", deviceID: "not-a-device", machine: "m")),
    ] { #expect(throws: HelperRefusal.badParams) { try HelperCodec.decode(bad) } }
  }

  @Test func theServiceRefusesTicketsAndOffersInSafeMode() throws {
    struct Never: StewardRelay, UpdateRelay {
      func receiveTickets(json: String, deviceID: String, machine: String) -> Int { Issue.record("ran in safe mode"); return 0 }
      func offerUpdate(record: String, signature: String, deviceID: String, machine: String) -> String { Issue.record("offered in safe mode"); return "accepted" }
      func noteAppBeat(version: String) {}
    }
    let service = HelperService(safeMode: true, updates: Never(), steward: Never())
    let t = try #require(HelperResponse.decode(service.handle(try HelperCodec.encode(.stewardTickets(json: "{}", deviceID: "dev_00000000000000000000000a", machine: "m")))))
    #expect(!t.ok && t.code == "safe_mode")
    let o = try #require(HelperResponse.decode(service.handle(try HelperCodec.encode(.updateOffer(record: "{}", signature: String(repeating: "A", count: 88), deviceID: "dev_00000000000000000000000a", machine: "m")))))
    #expect(!o.ok && o.code == "safe_mode")
  }
}

// ─── the app's half ───────────────────────────────────────────────────────────────────────────

final class FakeTicketSource: StewardTicketSource, @unchecked Sendable {
  var body: Data?
  private(set) var asked: [String] = []
  func fetch(machine: String) async -> Data? { asked.append(machine); return body }
}
final class FakeStewardLink: StewardHelperLink, @unchecked Sendable {
  var name: String? = "EHRC-CONSUL4s-Mac-mini"
  private(set) var handed: [(String, String, String)] = []
  var ok = true
  func machine() -> String? { name }
  func hand(json: String, deviceID: String, machine: String) -> Bool { handed.append((json, deviceID, machine)); return ok }
}

@Suite struct StewardRelayTests {
  func list(_ n: Int) -> Data {
    let items: [FleetJSON] = (0..<n).map { i in .object(["ticket": .object(["ticket_id": .string("t\(i)"), "pad": .string(String(repeating: "p", count: 400))]), "signature": .string("s")]) }
    return Data(FleetJSON.object(["ok": .bool(true), "key_id": .string("6275a79b"), "tickets": .array(items)]).canonical.utf8)
  }

  @Test func ticketsAreFetchedForTheHelpersMachineAndHandedOverInSmallPieces() async {
    let source = FakeTicketSource(), link = FakeStewardLink()
    source.body = list(10)
    let relay = StewardTicketRelay(source: source, link: link, deviceID: { "dev_00000000000000000000000a" })
    let pass = await relay.passOnce()
    #expect(source.asked == ["EHRC-CONSUL4s-Mac-mini"])
    #expect(pass == .handed(tickets: 10))
    #expect(link.handed.count >= 2 && link.handed.allSatisfy { $0.0.utf8.count <= 6_000 && $0.1 == "dev_00000000000000000000000a" })
  }

  @Test func withoutAMachineFromTheHelperOrADeviceNothingIsFetched() async {
    let source = FakeTicketSource(), link = FakeStewardLink()
    source.body = list(1)
    link.name = nil
    #expect(await StewardTicketRelay(source: source, link: link, deviceID: { "dev_00000000000000000000000a" }).passOnce() == .unavailable)
    link.name = "m"
    #expect(await StewardTicketRelay(source: source, link: link, deviceID: { nil }).passOnce() == .unavailable)
    #expect(source.asked.isEmpty)
  }

  @Test func noTicketsOrNoAnswerIsIdle() async {
    let source = FakeTicketSource(), link = FakeStewardLink()
    let relay = StewardTicketRelay(source: source, link: link, deviceID: { "dev_00000000000000000000000a" })
    #expect(await relay.passOnce() == .idle)
    source.body = Data("{\"ok\":true,\"tickets\":[]}".utf8)
    #expect(await relay.passOnce() == .idle)
    #expect(link.handed.isEmpty)
  }

  @Test func theFleetClientFetchesTicketsAsTheDeviceWithNoBodyAndTheMachineInTheQuery() async throws {
    let r = Rig { _, _ in FleetResponse(status: 200, body: Data("{\"tickets\":[]}".utf8)) }
    let response = await r.client.fetchStewardTickets(machine: "EHRC-CONSUL4s-Mac-mini")
    #expect(response?.status == 200)
    let sent = try #require(r.transport.requests.last)
    #expect(sent.method == "GET" && sent.path == "/api/steward/tickets" && sent.query == ["machine": "EHRC-CONSUL4s-Mac-mini"] && sent.body == nil)
    #expect((sent.headers["Authorization"] ?? "").hasPrefix("Device "))
    let off = Rig(withDevice: false) { _, _ in FleetResponse(status: 200, body: Data()) }
    #expect(await off.client.fetchStewardTickets(machine: "m") == nil)
  }
}

@Suite struct HelperUpdateGlueTests {
  @Test func theBeatIsSentAtMostOnceEveryTwentySecondsWithTheVersion() async throws {
    final class Clock: @unchecked Sendable { var t = Date(timeIntervalSince1970: 1_800_000_000) }
    let clock = Clock()
    let sent = NSLock()
    nonisolated(unsafe) var versions: [String] = []
    let beat = HelperBeat(version: "0.1.37", interval: 20, now: { clock.t }, send: { sent.lock(); versions.append($0); sent.unlock() })
    beat.ping(); beat.ping(); beat.ping()
    clock.t = clock.t.addingTimeInterval(21)
    beat.ping()
    try await Task.sleep(nanoseconds: 300_000_000)
    sent.lock(); defer { sent.unlock() }
    #expect(versions == ["0.1.37", "0.1.37"])
  }

  @Test func aBeatWithoutAVersionIsNotSent() async throws {
    nonisolated(unsafe) var count = 0
    HelperBeat(version: nil, send: { _ in count += 1 }).ping()
    try await Task.sleep(nanoseconds: 100_000_000)
    #expect(count == 0)
  }

  @Test func theReleaseRecordCrossesAsTheExactCanonicalBytesThatWereSigned() throws {
    let record: JSONValue = .object(["rollout_pct": .number(100), "version": .string("0.1.37"), "device_cohorts": .array([.string("all")])])
    let json = try #require(HelperUpdateOffer.fleetJSON(record))
    #expect(json.canonical == #"{"device_cohorts":["all"],"rollout_pct":100,"version":"0.1.37"}"#)
    #expect(HelperUpdateOffer.fleetJSON(.object(["x": .number(1.5)])) == nil, "a fraction is not a record")
  }

  @Test func withoutADeviceOrARecordTheOfferIsUnavailableSoTheUserUpdaterStaysInCharge() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("offer-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let plain = RoomReleaseDescriptor(version: "0.1.37", sha256: "x", sizeBytes: 1, blobURL: "https://x")
    #expect(HelperUpdateOffer.offer(plain, root: root, machine: "m") == "unavailable")
    let withRecord = RoomReleaseDescriptor(version: "0.1.37", sha256: "x", sizeBytes: 1, blobURL: "https://x", record: .object([:]), recordSignature: "s")
    #expect(HelperUpdateOffer.offer(withRecord, root: root, machine: "m") == "unavailable", "no device id yet")
  }

  @Test func theReleaseDescriptorStillDecodesTheOldFourFieldAnswer() throws {
    let old = Data(#"{"version":"0.1.30","sha256":"abc","size_bytes":10,"blob_url":"https://x"}"#.utf8)
    let d = try JSONDecoder().decode(RoomReleaseDescriptor.self, from: old)
    #expect(d.record == nil && d.recordSignature == nil)
    let new = Data(#"{"version":"0.1.37","sha256":"abc","size_bytes":10,"blob_url":"https://x","record":{"v":1,"rollout_pct":50},"record_signature":"sig"}"#.utf8)
    let n = try JSONDecoder().decode(RoomReleaseDescriptor.self, from: new)
    #expect(n.record != nil && n.recordSignature == "sig")
  }
}
