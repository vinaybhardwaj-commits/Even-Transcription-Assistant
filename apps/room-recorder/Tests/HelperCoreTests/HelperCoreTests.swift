import Foundation
import Security
import Testing

import RoomRecorderCore
@testable import HelperCore

private func raw(_ json: String) -> Data { Data(json.utf8) }

private func refusal(_ data: Data) -> HelperRefusal? {
  do { _ = try HelperCodec.decode(data); return nil } catch { return error as? HelperRefusal }
}

@Suite struct HelperIdentityTests {
  // Literals on purpose: a value derived from the constant under test cannot catch a change to it.
  @Test func requirementStringsArePinnedBothDirections() {
    #expect(
      HelperIdentity.requirementForApp
        == "identifier \"com.evenscribe.room-recorder\" and certificate leaf = H\"187dd424fb866204111113d60c6f88a21d098edb\"")
    #expect(
      HelperIdentity.requirementForHelper
        == "identifier \"com.evenscribe.room-recorder.helper\" and certificate leaf = H\"187dd424fb866204111113d60c6f88a21d098edb\"")
    #expect(HelperIdentity.requirementForApp != HelperIdentity.requirementForHelper)
  }

  @Test func leafPinMatchesTheSelfUpdaterPin() {
    #expect(HelperIdentity.pinnedLeafSHA1 == RoomSelfUpdate.pinnedLeafSHA1)
  }

  @Test func requirementsParseAsCodeSigningRequirements() {
    #expect(PeerRequirement.isValid(HelperIdentity.requirementForApp))
    #expect(PeerRequirement.isValid(HelperIdentity.requirementForHelper))
    #expect(!PeerRequirement.isValid("identifier and and"))
  }

  @Test func machServiceAndPlistNames() {
    #expect(HelperIdentity.machServiceName == "com.evenscribe.room-recorder.helper.xpc")
    #expect(HelperIdentity.daemonPlistName == "com.evenscribe.room-recorder.helper.plist")
  }
}

@Suite struct HelperCodecTests {
  @Test func theVerbSetIsClosedAtSix() {
    #expect(
      Set(HelperVerb.allCases.map(\.rawValue))
        == ["hello", "appStatus", "helperStatus", "runAppVerb", "requestBundleUpdate", "runSignedCommand"])
  }

  @Test func theAppVerbAllowListIsPinned() {
    #expect(
      Set(AppVerb.allCases.map(\.rawValue))
        == ["report_diag", "restart_engine", "check_update_now", "self_test", "set_audio_input"])
  }

  @Test func everyCommandRoundTrips() throws {
    let commands: [HelperCommand] = [
      .hello(clientVersion: "0.1.29"), .appStatus, .helperStatus, .requestBundleUpdate,
      .runAppVerb(.reportDiag, params: [:]),
      .runAppVerb(.setAudioInput, params: ["uid": "BuiltInMic"]),
    ]
    for command in commands {
      #expect(try HelperCodec.decode(try HelperCodec.encode(command)) == command)
    }
  }

  @Test func unknownHelperVerbsAreRefused() {
    for verb in ["exec", "shell", "run", "sudo", "pmset", "Hello", ""] {
      #expect(refusal(raw("{\"v\":1,\"verb\":\"\(verb)\"}")) == .verbNotAllowed, "\(verb)")
    }
  }

  @Test func appVerbsOutsideTheAllowListAreRefused() {
    for name in ["start_day", "end_day", "pause_day", "bash", "rm", "../report_diag", " self_test"] {
      #expect(
        refusal(raw("{\"v\":1,\"verb\":\"runAppVerb\",\"appVerb\":\"\(name)\"}")) == .verbNotAllowed,
        "\(name)")
    }
    #expect(refusal(raw("{\"v\":1,\"verb\":\"runAppVerb\"}")) == .verbNotAllowed)
  }

  @Test func malformedWrongVersionAndOversizeAreRefused() {
    #expect(refusal(raw("not json")) == .malformed)
    #expect(refusal(raw("{\"v\":2,\"verb\":\"hello\"}")) == .protocolVersion)
    #expect(refusal(Data(count: HelperCodec.maxRequestBytes + 1)) == .tooLarge)
  }

  @Test func paramBoundsAreEnforced() throws {
    let many = Dictionary(uniqueKeysWithValues: (0...HelperCodec.maxParams).map { ("k\($0)", "v") })
    #expect(refusal(try HelperCodec.encode(.runAppVerb(.selfTest, params: many))) == .badParams)
    let long = String(repeating: "x", count: HelperCodec.maxParamBytes + 1)
    #expect(refusal(try HelperCodec.encode(.runAppVerb(.selfTest, params: ["k": long]))) == .badParams)
    let edge = Dictionary(uniqueKeysWithValues: (0..<HelperCodec.maxParams).map { ("k\($0)", "v") })
    #expect(refusal(try HelperCodec.encode(.runAppVerb(.selfTest, params: edge))) == nil)
  }
}

@Suite struct HelperServiceTests {
  private func call(_ service: HelperService, _ command: HelperCommand) throws -> HelperResponse {
    try #require(HelperResponse.decode(service.handle(try HelperCodec.encode(command))))
  }

  @Test func helloAndStatusAnswerWithTheHelperVersion() throws {
    let service = HelperService(safeMode: false)
    for command in [HelperCommand.hello(clientVersion: nil), .helperStatus] {
      let reply = try call(service, command)
      #expect(reply.ok)
      #expect(reply.detail["helper_version"] == "0.2.1-h3")
      #expect(reply.detail["safe_mode"] == "false")
    }
    #expect(try call(HelperService(safeMode: true), .helperStatus).detail["safe_mode"] == "true")
  }

  @Test func noRootWorkBeyondHello() throws {
    let service = HelperService(safeMode: false)
    for command in [HelperCommand.appStatus, .requestBundleUpdate, .runAppVerb(.restartEngine, params: [:])] {
      let reply = try call(service, command)
      #expect(!reply.ok)
      #expect(reply.code == "not_implemented")
    }
  }

  @Test func refusalsComeBackAsCodesNotCrashes() throws {
    let service = HelperService(safeMode: false)
    let exec = try #require(HelperResponse.decode(service.handle(raw("{\"v\":1,\"verb\":\"exec\"}"))))
    #expect(exec == HelperResponse(ok: false, code: "verb_not_allowed"))
    #expect(try #require(HelperResponse.decode(service.handle(raw("x")))).code == "malformed")
  }
}

@Suite struct LaunchLedgerTests {
  @Test func fourthLaunchAfterThreeUnstableOnesIsSafeMode() {
    var ledger = LaunchLedger()
    let launches = (0..<4).map { _ in ledger.recordLaunch() }
    #expect(launches == [false, false, false, true])
  }

  @Test func aStableMinuteClearsTheLedger() {
    var ledger = LaunchLedger(unstableLaunches: 3)
    ledger.recordStable()
    let safe = ledger.recordLaunch()
    #expect(!safe)
  }

  @Test func ledgerSurvivesARoundTripAndLoadsGarbageAsEmpty() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ledger-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dir) }
    let url = dir.appendingPathComponent("l.json")
    LaunchLedger(unstableLaunches: 2).save(to: url)
    #expect(LaunchLedger.load(from: url).unstableLaunches == 2)
    try Data("garbage".utf8).write(to: url)
    #expect(LaunchLedger.load(from: url).unstableLaunches == 0)
  }
}

@Suite struct PollFieldTests {
  @Test func helperFieldsAreAbsentUntilMeasured() {
    let names = InstallPollFields(installID: "i", tapeAdvancing: true).queryItems().map(\.name)
    #expect(!names.contains("helper_version"))
    #expect(!names.contains("helper_registration"))
    #expect(!names.contains("helper_xpc_ok"))
  }

  @Test func helperFieldsAreSentWhenKnown() {
    var fields = InstallPollFields(installID: "i", tapeAdvancing: true)
    fields.helperVersion = "0.2.1-h3"
    fields.helperRegistration = "enabled"
    fields.helperXPCOK = false
    let items = Dictionary(uniqueKeysWithValues: fields.queryItems().map { ($0.name, $0.value ?? "") })
    #expect(items["helper_version"] == "0.2.1-h3")
    #expect(items["helper_registration"] == "enabled")
    #expect(items["helper_xpc_ok"] == "false")
  }
}

/// The client-requirement check. Peers are real binaries signed for real with `codesign`.
@Suite struct PeerRequirementTests {
  let dir: URL

  init() throws {
    dir = FileManager.default.temporaryDirectory.appendingPathComponent("peer-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  }

  @discardableResult
  private func run(_ args: [String]) throws -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
    p.arguments = args
    p.standardError = FileHandle.nullDevice
    p.standardOutput = FileHandle.nullDevice
    try p.run()
    p.waitUntilExit()
    return p.terminationStatus
  }

  /// A copy of /bin/ls with its signature replaced by an ad-hoc one (nil identifier = removed).
  private func makeClient(named name: String, adHocIdentifier: String?) throws -> URL {
    let url = dir.appendingPathComponent(name)
    try FileManager.default.copyItem(atPath: "/bin/ls", toPath: url.path)
    try #require(try run(["--remove-signature", url.path]) == 0)
    if let adHocIdentifier {
      try #require(try run(["--force", "--sign", "-", "--identifier", adHocIdentifier, url.path]) == 0)
    }
    return url
  }

  @Test func adHocSignedClientWithTheRightIdentifierIsRefused() throws {
    let client = try makeClient(named: "adhoc-app", adHocIdentifier: HelperIdentity.appIdentifier)
    #expect(!PeerRequirement.satisfies(codeAt: client, requirement: HelperIdentity.requirementForApp))
  }

  @Test func unsignedClientIsRefused() throws {
    let client = try makeClient(named: "unsigned", adHocIdentifier: nil)
    #expect(!PeerRequirement.satisfies(codeAt: client, requirement: HelperIdentity.requirementForApp))
  }

  @Test func appleSignedBinaryIsRefused() {
    #expect(
      !PeerRequirement.satisfies(
        codeAt: URL(fileURLWithPath: "/bin/ls"), requirement: HelperIdentity.requirementForApp))
  }

  @Test func theHelperIdentityCannotSitInTheAppSeat() throws {
    let impostor = try makeClient(named: "helper-as-app", adHocIdentifier: HelperIdentity.helperIdentifier)
    #expect(!PeerRequirement.satisfies(codeAt: impostor, requirement: HelperIdentity.requirementForApp))
  }

  @Test func positiveControlTheCheckerCanSayYes() throws {
    let client = try makeClient(named: "control", adHocIdentifier: HelperIdentity.appIdentifier)
    #expect(PeerRequirement.satisfies(codeAt: client, requirement: "identifier \"\(HelperIdentity.appIdentifier)\""))
    #expect(!PeerRequirement.satisfies(codeAt: client, requirement: "identifier \"\(HelperIdentity.helperIdentifier)\""))
  }
}

/// A live NSXPCConnection against an anonymous listener. The peer is this test process, which is
/// not signed by our leaf, so the pinned requirement must drop its messages. The control uses a
/// requirement this process does satisfy, so a silent transport failure cannot pass as a refusal.
@Suite(.serialized) struct XPCPeerEnforcementTests {
  final class Box: @unchecked Sendable { var value: HelperResponse? }

  private func roundTrip(requirement: String) -> HelperResponse? {
    let delegate = HelperListenerDelegate(service: HelperService(safeMode: false), requirement: requirement)
    let listener = NSXPCListener.anonymous()
    listener.delegate = delegate
    listener.resume()
    let connection = NSXPCConnection(listenerEndpoint: listener.endpoint)
    connection.remoteObjectInterface = NSXPCInterface(with: HelperXPCProtocol.self)
    connection.resume()
    defer { connection.invalidate(); listener.invalidate() }
    let done = DispatchSemaphore(value: 0)
    let box = Box()
    let proxy = connection.remoteObjectProxyWithErrorHandler { _ in done.signal() }
    guard let remote = proxy as? HelperXPCProtocol,
      let request = try? HelperCodec.encode(.hello(clientVersion: nil))
    else { return nil }
    remote.send(request) { data in
      box.value = HelperResponse.decode(data)
      done.signal()
    }
    _ = done.wait(timeout: .now() + 5)
    return box.value
  }

  @Test func pinnedRequirementRefusesThisProcess() {
    #expect(roundTrip(requirement: HelperIdentity.requirementForApp) == nil)
  }

  /// This process's own signing identifier, read from its dynamic code object.
  private func ownIdentifier() -> String? {
    var me: SecCode?
    guard SecCodeCopySelf([], &me) == errSecSuccess, let me else { return nil }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(me, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
      let dict = info as? [String: Any]
    else { return nil }
    return dict[kSecCodeInfoIdentifier as String] as? String
  }

  @Test func aSatisfiedRequirementIsAnswered() throws {
    let id = try #require(ownIdentifier())
    let reply = roundTrip(requirement: "identifier \"\(id)\"")
    #expect(reply?.ok == true)
  }

  // ─── The APP side: the client must refuse a helper that does not match the pinned requirement ──

  /// An in-process "helper" whose own side accepts this process, so only the CLIENT's check is
  /// under test. The helper here is this test runner, which is not signed by our leaf.
  private func clientHello(requirement: String, serverRequirement: String) -> HelperResponse? {
    let delegate = HelperListenerDelegate(
      service: HelperService(safeMode: false), requirement: serverRequirement)
    let listener = NSXPCListener.anonymous()
    listener.delegate = delegate
    listener.resume()
    defer { listener.invalidate() }
    return HelperClient(endpoint: listener.endpoint, requirement: requirement).hello(timeout: 5)
  }

  @Test func appRefusesAHelperThatDoesNotMatchThePinnedRequirement() throws {
    let id = try #require(ownIdentifier())
    let serverAccepts = "identifier \"\(id)\""
    #expect(clientHello(requirement: HelperIdentity.requirementForHelper, serverRequirement: serverAccepts) == nil)
  }

  @Test func appAcceptsAHelperThatMatchesTheRequirementItIsGiven() throws {
    // Control for the refusal above: same wiring, a requirement the "helper" does satisfy.
    let id = try #require(ownIdentifier())
    let requirement = "identifier \"\(id)\""
    #expect(clientHello(requirement: requirement, serverRequirement: requirement)?.ok == true)
  }
}
