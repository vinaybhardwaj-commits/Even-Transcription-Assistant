import FleetCore
import Foundation
import Security
import Testing

@testable import RoomRecorderCore

@Suite struct FleetConfigFlagTests {
  private func config(extra: String = "") throws -> RoomConfiguration {
    let json = """
      {"origin":"https://evenscribe.app","room_slug":"r","device_uid":"u","tapewriter_path":"/t","ffmpeg_path":"/f"\(extra)}
      """
    return try JSONDecoder().decode(RoomConfiguration.self, from: Data(json.utf8))
  }

  @Test func theFleetClientIsOnInAnOldConfigAndInANewOne_since0_1_35() throws {
    #expect(try config().fleetClientEnabled == true)
    let fresh = try RoomConfiguration(
      origin: URL(string: "https://evenscribe.app")!, roomSlug: "r", deviceUID: "u", tapewriterPath: "/t", ffmpegPath: "/f")
    #expect(fresh.fleetClientEnabled == true)
  }

  @Test func onlyAnExplicitFalseInConfigJSONTurnsItOff() throws {
    #expect(try config(extra: #","fleet_client_enabled":true"#).fleetClientEnabled == true)
    #expect(try config(extra: #","fleet_client_enabled":false"#).fleetClientEnabled == false)
    #expect(throws: (any Error).self) { try config(extra: #","fleet_client_enabled":"yes""#) }
  }

  @Test func theFlagSurvivesASaveAndLoad() throws {
    var on = try config()
    on.fleetClientEnabled = false
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("flag-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let persistence = RoomPersistence(root: root)
    try persistence.saveConfiguration(on)
    #expect(try persistence.loadConfiguration().fleetClientEnabled == false, "an explicit off survives a save and load")
  }
}

@Suite struct FleetWiringTests {
  @Test func stateSurvivesARoundTripAndIsPrivate() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("fleet-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = FileFleetStateStore(root: root)
    #expect(store.load() == FleetState())
    var state = FleetState(deviceID: "dev_00000000000000000000000a")
    state.installID = "inst_1"
    state.remember(nonce: "n1")
    state.store(result: FleetStoredResult(cmdID: "c1", body: "{}", posted: false))
    store.save(state)
    #expect(store.load() == state)
    let mode = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent("fleet-state.json").path)[.posixPermissions] as? NSNumber
    #expect(mode?.intValue == 0o600)
    try Data("not json".utf8).write(to: root.appendingPathComponent("fleet-state.json"))
    #expect(store.load() == FleetState(), "a damaged file reads as empty, never as a crash")
  }

  @Test func theStateKeepsOnlyTheLastThousandNoncesAndHundredResults() {
    var state = FleetState()
    for i in 0..<1_100 { state.remember(nonce: "n\(i)") }
    #expect(state.nonces.count == 1_000 && !state.nonceSeen("n99") && state.nonceSeen("n100") && state.nonceSeen("n1099"))
    for i in 0..<130 { state.store(result: FleetStoredResult(cmdID: "c\(i)", body: "{}", posted: true)) }
    #expect(state.results.count == 100 && state.results.first?.cmdID == "c30")
  }

  /// A throwaway file keychain, unlocked, deleted afterwards. The login keychain is not usable from a
  /// session outside the GUI login, and a test must not write the real device key anyway.
  private func withTemporaryKeychain(_ body: (SecKeychain) throws -> Void) throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent("fleet-test-\(UUID().uuidString).keychain").path
    var keychain: SecKeychain?
    let password = "test-only"
    let status = SecKeychainCreate(path, UInt32(password.utf8.count), password, false, nil, &keychain)
    try #require(status == errSecSuccess, "SecKeychainCreate returned \(status)")
    let created = try #require(keychain)
    defer {
      SecKeychainDelete(created)
      try? FileManager.default.removeItem(atPath: path)
    }
    try body(created)
  }

  @Test func theKeychainKeepsOneKeyAndHandsBackTheSameOne() throws {
    try withTemporaryKeychain { keychain in
      let store = KeychainFleetKeyStore(service: "test.fleet", account: "test", keychain: keychain)
      let first = try store.loadOrCreate()
      let second = try store.loadOrCreate()
      #expect(first.seed == second.seed)
      #expect(first.publicKeyBase64 == second.publicKeyBase64)
      #expect(first.seed.count == 32)
    }
  }

  @Test func aDamagedSeedInTheKeychainIsRefusedNotReplaced() throws {
    try withTemporaryKeychain { keychain in
      let add: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "test.fleet",
        kSecAttrAccount as String: "test", kSecValueData as String: Data(count: 5),
        kSecUseKeychain as String: keychain,
      ]
      #expect(SecItemAdd(add as CFDictionary, nil) == errSecSuccess)
      #expect(throws: FleetError.self) {
        try KeychainFleetKeyStore(service: "test.fleet", account: "test", keychain: keychain).loadOrCreate()
      }
    }
  }
}
