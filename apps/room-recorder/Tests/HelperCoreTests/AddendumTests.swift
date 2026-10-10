import Foundation
import Testing

@testable import HelperCore
@testable import RoomRecorderCore

// MARK: - A. Config helper paths follow the running bundle

@Suite struct RoomConfigurationRebaseTests {
  struct Fixture {
    let base: URL
    var root: URL { base.appendingPathComponent("root", isDirectory: true) }
    var newBundle: URL { base.appendingPathComponent("Applications/EvenScribe Room Recorder.app", isDirectory: true) }
    var oldBundle: URL { base.appendingPathComponent("home/Applications/EvenScribe Room Recorder.app", isDirectory: true) }

    init(config: (Fixture) -> (tapewriter: String, ffmpeg: String), archive: Bool = false) throws {
      base = FileManager.default.temporaryDirectory.appendingPathComponent("rebase-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      let paths = config(self)
      let configuration = try RoomConfiguration(
        origin: URL(string: "https://evenscribe.app")!, roomSlug: "room-x", deviceUID: "uid",
        tapewriterPath: paths.tapewriter, ffmpegPath: paths.ffmpeg, residentArchiveCaptureEnabled: archive)
      try RoomPersistence(root: root).saveConfiguration(configuration)
    }

    func helper(_ name: String) -> String { newBundle.appendingPathComponent("Contents/Helpers/\(name)").path }
    func loaded() throws -> RoomConfiguration { try RoomPersistence(root: root).loadConfiguration() }
    func tearDown() { try? FileManager.default.removeItem(at: base) }
  }

  @Test func pathsIntoTheOldBundleAreRewrittenToTheRunningOne() throws {
    let f = try Fixture(config: { f in
      (f.oldBundle.appendingPathComponent("Contents/Helpers/tapewriter").path,
       f.oldBundle.appendingPathComponent("Contents/Helpers/ffmpeg").path)
    })
    defer { f.tearDown() }
    var logged: [String] = []
    let changes = RoomConfigurationRebase.apply(
      root: f.root, bundleURL: f.newBundle, bundledHelper: { f.helper($0) }, log: { logged.append($0) })
    #expect(changes.map(\.field) == ["tapewriter_path", "ffmpeg_path"])
    let config = try f.loaded()
    #expect(config.tapewriterPath == f.helper("tapewriter") && config.ffmpegPath == f.helper("ffmpeg"))
    #expect(logged.count == 2 && logged[0].contains("tapewriter_path") && logged[1].contains("ffmpeg_path"))
    #expect(config.roomSlug == "room-x" && config.deviceUID == "uid", "nothing else moved")
  }

  @Test func aSecondPassChangesNothing() throws {
    let f = try Fixture(config: { f in ("/opt/homebrew/bin/tapewriter", "/opt/homebrew/bin/ffmpeg") })
    defer { f.tearDown() }
    _ = RoomConfigurationRebase.apply(root: f.root, bundleURL: f.newBundle, bundledHelper: { f.helper($0) }, log: { _ in })
    var logged: [String] = []
    let again = RoomConfigurationRebase.apply(
      root: f.root, bundleURL: f.newBundle, bundledHelper: { f.helper($0) }, log: { logged.append($0) })
    #expect(again.isEmpty && logged.isEmpty)
  }

  @Test func pathsAlreadyInsideTheBundleAreLeftAlone() throws {
    let f = try Fixture(config: { f in (f.helper("tapewriter"), f.helper("ffmpeg")) })
    defer { f.tearDown() }
    #expect(RoomConfigurationRebase.apply(root: f.root, bundleURL: f.newBundle, bundledHelper: { f.helper($0) }, log: { _ in }).isEmpty)
  }

  @Test func aBundleWithoutThatToolChangesNothing() throws {
    let f = try Fixture(config: { f in ("/old/tapewriter", "/old/ffmpeg") })
    defer { f.tearDown() }
    let changes = RoomConfigurationRebase.apply(
      root: f.root, bundleURL: f.newBundle, bundledHelper: { $0 == "ffmpeg" ? f.helper("ffmpeg") : nil }, log: { _ in })
    #expect(changes.map(\.field) == ["ffmpeg_path"])
    #expect(try f.loaded().tapewriterPath == "/old/tapewriter")
  }

  @Test func anUnbundledBinaryNeverRewrites() throws {
    let f = try Fixture(config: { _ in ("/old/tapewriter", "/old/ffmpeg") })
    defer { f.tearDown() }
    let plain = f.base.appendingPathComponent("debug/room-recorder")
    #expect(RoomConfigurationRebase.apply(root: f.root, bundleURL: plain, bundledHelper: { f.helper($0) }, log: { _ in }).isEmpty)
    #expect(try f.loaded().tapewriterPath == "/old/tapewriter")
  }

  @Test func theResidentArchiveLaneKeepsItsSealedPaths() throws {
    let f = try Fixture(config: { _ in ("/old/tapewriter", "/old/ffmpeg") }, archive: true)
    defer { f.tearDown() }
    var logged: [String] = []
    let changes = RoomConfigurationRebase.apply(
      root: f.root, bundleURL: f.newBundle, bundledHelper: { f.helper($0) }, log: { logged.append($0) })
    #expect(changes.isEmpty)
    #expect(try f.loaded().ffmpegPath == "/old/ffmpeg")
    #expect(logged.first?.contains("resident archive") == true)
  }

  @Test func noConfigFileIsNotAnError() {
    let empty = FileManager.default.temporaryDirectory.appendingPathComponent("none-\(UUID().uuidString)")
    #expect(RoomConfigurationRebase.apply(root: empty, bundleURL: URL(fileURLWithPath: "/Applications/X.app"), bundledHelper: { $0 }, log: { _ in }).isEmpty)
  }
}

// MARK: - B. The updater only goes up, and only into the running bundle

@Suite struct RoomUpdateOrderingTests {
  @Test func onlyAStrictlyHigherVersionIsAnUpdate() {
    let table: [(String, String, Bool)] = [
      ("0.1.29", "0.1.28", false),  // the OPD 6 case: the channel offered 0.1.28 to a 0.1.29 app
      ("0.1.29", "0.1.29", false),
      ("0.1.29", "0.1.30", true),
      ("0.1.9", "0.1.10", true),  // numeric, not lexical
      ("0.1.10", "0.1.9", false),
      ("0.1.29", "0.2.0", true),
      ("0.1.29", "1.0", true),
      ("0.1.29", "0.1.29.1", true),
      ("0.1.29", "0.1.30-test", true),
      ("0.1.30", "0.1.30-test", false),
      ("0.1.29", "banana", false),  // cannot be ordered, so not an update
      ("0.1.29", "", false),
      ("0.1.29", "0.1.x", false),
    ]
    for (running, offered, expected) in table {
      #expect(roomUpdateIsAvailable(running: running, offered: offered) == expected, "\(running) -> \(offered)")
    }
    #expect(!roomUpdateIsAvailable(running: nil, offered: "9.9.9"))
    #expect(!roomUpdateIsAvailable(running: "garbage", offered: "9.9.9"))
  }

  @Test func theUpdaterReplacesTheRunningBundleAndNothingElse() {
    let home = URL(fileURLWithPath: "/Users/room")
    let applications = URL(fileURLWithPath: "/Applications/EvenScribe Room Recorder.app")
    // (/Applications present, no system helper plist: the ordinary case.)
    #expect(RoomEngine.updaterBundle(bundleURL: applications, homeDirectory: home, fileExists: { _ in false }) == applications)
    // A copy under ~/Applications with no /Applications install yet is the pre-pkg state: it may update itself.
    let old = URL(fileURLWithPath: "/Users/room/Applications/EvenScribe Room Recorder.app")
    #expect(RoomEngine.updaterBundle(bundleURL: old, homeDirectory: home, fileExists: { _ in false }) == old)
    // ...but once /Applications has the app, the stale copy never updates itself.
    #expect(RoomEngine.updaterBundle(bundleURL: old, homeDirectory: home, fileExists: { $0 == "/Applications/EvenScribe Room Recorder.app" }) == nil)
    #expect(RoomEngine.updaterBundle(bundleURL: URL(fileURLWithPath: "/tmp/debug/room-recorder"), homeDirectory: home, fileExists: { _ in false }) == nil)
  }
}

// MARK: - C. The helper is registered at start, and the answer is kept (0.1.31: notFound too, bounded)

@Suite struct HelperRegistrationPassTests {
  final class FakeService: HelperDaemonService, @unchecked Sendable {
    var status: String
    var registerCalls = 0
    var failure: Error?
    var statusAfterRegister: String
    init(_ status: String, after: String = "enabled", failure: Error? = nil) {
      self.status = status
      statusAfterRegister = after
      self.failure = failure
    }
    var registrationName: String { status }
    func register() throws {
      registerCalls += 1
      if let failure { throw failure }
      status = statusAfterRegister
    }
  }

  static let refused = NSError(
    domain: "SMAppServiceErrorDomain", code: 1,
    userInfo: [NSLocalizedDescriptionKey: "Operation not permitted"])
  static let signing = NSError(
    domain: "SMAppServiceErrorDomain", code: 2,
    userInfo: [NSLocalizedDescriptionKey: "The code signature of the service is invalid"])

  private func pass(_ service: FakeService, _ state: inout HelperRegistrationState, logs: inout [String], opens: inout Int)
    -> (registration: String, error: String?)
  {
    var local: [String] = []
    var count = 0
    let result = HelperBootstrap.registrationPass(
      service: service, openSettings: { count += 1 }, state: &state, log: { local.append($0) })
    logs += local
    opens += count
    return result
  }

  @Test func notRegisteredIsRegisteredOnce() {
    let service = FakeService("notRegistered")
    var state = HelperRegistrationState(); var logs: [String] = []; var opens = 0
    let result = pass(service, &state, logs: &logs, opens: &opens)
    #expect(service.registerCalls == 1 && result.registration == "enabled" && result.error == nil)
    #expect(logs.contains { $0.contains("register() accepted") })
  }

  @Test func notFoundIsRegisteredToo_theOPD6Case() {
    let service = FakeService("notFound")
    var state = HelperRegistrationState(); var logs: [String] = []; var opens = 0
    let result = pass(service, &state, logs: &logs, opens: &opens)
    #expect(service.registerCalls == 1, "0.1.30 never asked on notFound")
    #expect(result.registration == "enabled")
  }

  @Test func enabledAndRequiresApprovalAreNeverRegisteredAgain() {
    for status in ["enabled", "requiresApproval"] {
      let service = FakeService(status)
      var state = HelperRegistrationState(); var logs: [String] = []; var opens = 0
      for _ in 0..<5 { _ = pass(service, &state, logs: &logs, opens: &opens) }
      #expect(service.registerCalls == 0, "\(status)")
    }
  }

  @Test func approvalOpensSettingsOnceAndIsReported() {
    let service = FakeService("notRegistered", after: "requiresApproval")
    var state = HelperRegistrationState(); var logs: [String] = []; var opens = 0
    for _ in 0..<3 {
      #expect(pass(service, &state, logs: &logs, opens: &opens).registration == "requiresApproval")
    }
    #expect(opens == 1 && service.registerCalls == 1)
    #expect(logs.contains { $0.contains("requires approval") })
  }

  @Test func aRefusalIsRecordedWithDomainCodeAndText() {
    let service = FakeService("notFound", failure: Self.refused)
    var state = HelperRegistrationState(); var logs: [String] = []; var opens = 0
    let result = pass(service, &state, logs: &logs, opens: &opens)
    #expect(result.registration == "notFound")
    #expect(result.error == "domain=SMAppServiceErrorDomain code=1: Operation not permitted")
    #expect(state.lastError == result.error)
    #expect(logs.contains { $0.contains("register() refused (attempt 1 of 2") && $0.contains("code=1") })
  }

  @Test func aSigningRefusalIsCalledOutPlainly() {
    let service = FakeService("notFound", failure: Self.signing)
    var state = HelperRegistrationState(); var logs: [String] = []; var opens = 0
    _ = pass(service, &state, logs: &logs, opens: &opens)
    #expect(logs.contains { $0.contains("SIGNING refusal") && $0.contains("Team ID") })
    // ...and an ordinary refusal is not mislabelled.
    let other = FakeService("notFound", failure: Self.refused)
    var s2 = HelperRegistrationState(); var l2: [String] = []; var o2 = 0
    _ = pass(other, &s2, logs: &l2, opens: &o2)
    #expect(!l2.contains { $0.contains("SIGNING refusal") })
  }

  @Test func signingRecognition() {
    #expect(HelperBootstrap.looksLikeSigningFailure(Self.signing))
    #expect(HelperBootstrap.looksLikeSigningFailure(NSError(domain: "x", code: 9, userInfo: [NSLocalizedDescriptionKey: "No Team ID in the signature"])))
    #expect(!HelperBootstrap.looksLikeSigningFailure(Self.refused))
    #expect(!HelperBootstrap.looksLikeSigningFailure(NSError(domain: "Other", code: 2, userInfo: [NSLocalizedDescriptionKey: "boom"])))
  }

  @Test func neverMoreThanOneAttemptPlusOneRetry_noTightLoop() {
    let service = FakeService("notFound", failure: Self.refused)
    var state = HelperRegistrationState(); var logs: [String] = []; var opens = 0
    for _ in 0..<50 { _ = pass(service, &state, logs: &logs, opens: &opens) }
    #expect(service.registerCalls == 2)
    #expect(logs.filter { $0.contains("register() refused") }.count == 2, "the log does not fill either")
  }

  @Test func theErrorSurvivesLaterProbesThatDoNotAttempt() {
    let service = FakeService("notFound", failure: Self.refused)
    var state = HelperRegistrationState(); var logs: [String] = []; var opens = 0
    for _ in 0..<4 { _ = pass(service, &state, logs: &logs, opens: &opens) }
    #expect(pass(service, &state, logs: &logs, opens: &opens).error?.contains("Operation not permitted") == true)
  }

  @Test func theRetryCanSucceedAndClearsTheError() {
    let service = FakeService("notFound", failure: Self.refused)
    var state = HelperRegistrationState(); var logs: [String] = []; var opens = 0
    _ = pass(service, &state, logs: &logs, opens: &opens)
    service.failure = nil
    let result = pass(service, &state, logs: &logs, opens: &opens)
    #expect(result.registration == "enabled" && result.error == nil && service.registerCalls == 2)
  }

  @Test func theDescriptionIsBounded() {
    let long = NSError(domain: "D", code: 3, userInfo: [NSLocalizedDescriptionKey: String(repeating: "x", count: 500)])
    #expect(HelperBootstrap.describe(long).count == 200)
  }

  @Test func statusJSONAndTheBenchRowCarryTheError() throws {
    let status = RoomRecorderStatus(state: .ready, helperRegistration: "notFound", helperRegistrationError: "domain=D code=2: nope")
    let object = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(status)) as? [String: Any])
    #expect(object["helper_registration"] as? String == "notFound")
    #expect(object["helper_registration_error"] as? String == "domain=D code=2: nope")
    var fields = InstallPollFields(installID: "i", tapeAdvancing: true)
    #expect(!fields.queryItems().map(\.name).contains("helper_registration_error"), "absent until measured")
    fields.helperRegistration = "notFound"
    fields.helperRegistrationError = String(repeating: "e", count: 300)
    let items = Dictionary(uniqueKeysWithValues: fields.queryItems().map { ($0.name, $0.value ?? "") })
    #expect(items["helper_registration"] == "notFound")
    #expect(items["helper_registration_error"]?.count == 200)
    // An old status.json without the keys still decodes.
    let old = try JSONEncoder().encode(RoomRecorderStatus(state: .ready))
    #expect(try JSONDecoder().decode(RoomRecorderStatus.self, from: old).helperRegistration == nil)
  }
}
