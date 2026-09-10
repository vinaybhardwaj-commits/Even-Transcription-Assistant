import Foundation
import Security
import Testing

@testable import RoomRecorderCore

/// Release B1.5 §15 — the session store.
///
/// ─── WHAT THESE TESTS ARE ACTUALLY DEFENDING ─────────────────────────────────────────────────
/// A room whose session lives only in the login keychain cannot be updated remotely: macOS keys the
/// item's partition list by cdhash, so the new build is a stranger and securityd waits for a click
/// that will never come at 3 a.m. in a clinic. Every assertion below is about one of two promises:
/// the file is read in preference to the keychain, and NO path waits on securityd.
@Suite struct RoomSessionStoreTests {

  static func makeRoot() throws -> URL {
    let root = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("b15 session store \(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  static func record(session: String = "a.session.jwt") -> RoomKeychainRecord {
    RoomKeychainRecord(
      session: session,
      installID: "install_ufbyh5h6j8c6",
      roomSlug: "home-office-w8fb",
      roomName: "Home Office",
      origin: "https://www.evenscribe.app")
  }

  /// Records whether the keychain was consulted at all, which is the point of half of this file.
  final class KeychainSpy: @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0
    let answer: () throws -> RoomKeychainRecord

    init(answer: @escaping () throws -> RoomKeychainRecord) { self.answer = answer }

    func read() throws -> RoomKeychainRecord {
      lock.lock()
      calls += 1
      lock.unlock()
      return try answer()
    }

    var callCount: Int {
      lock.lock()
      defer { lock.unlock() }
      return calls
    }
  }

  static func mode(of url: URL) -> UInt16? {
    (try? FileManager.default.attributesOfItem(atPath: url.path))
      .flatMap { ($0[.posixPermissions] as? NSNumber)?.uint16Value }
  }

  // MARK: - The file wins, and the keychain is not even asked

  @Test func aUsableSessionFileIsUsedAndTheKeychainIsNeverTouched() throws {
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomSessionStore.save(Self.record(), root: root)

    let spy = KeychainSpy(answer: {
      Issue.record("the keychain must not be consulted when the file is usable")
      return Self.record()
    })
    let loaded = try #require(
      RoomSessionStore.load(root: root, keychainReader: spy.read, log: { _ in }))

    #expect(loaded == Self.record())
    // THE WHOLE POINT: on a migrated room, securityd is never in the picture at all.
    #expect(spy.callCount == 0)
  }

  @Test func theFileIsWritten0600AndRoundTrips() throws {
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomSessionStore.save(Self.record(), root: root)

    let url = RoomSessionStore.url(root: root)
    #expect(Self.mode(of: url) == 0o600)
    // §15.2's spelling of the secret, and the fields that actually exist.
    let json = try #require(
      try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    #expect(json["session_token"] as? String == "a.session.jwt")
    #expect(json["install_id"] as? String == "install_ufbyh5h6j8c6")
    #expect(json["room_slug"] as? String == "home-office-w8fb")
    #expect(json["room_name"] as? String == "Home Office")
    #expect(json["origin"] as? String == "https://www.evenscribe.app")
    #expect(json["written_at"] != nil)
    #expect(json["written_by"] != nil)
    // And nothing §15.2 named that does not exist — see the report's flag.
    #expect(json["room_id"] == nil)
    #expect(json["expires_at"] == nil)
  }

  // MARK: - The one-time fallback

  @Test func aRoomWithOnlyAKeychainItemIsMigratedOnItsFirstRead() throws {
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let spy = KeychainSpy(answer: { Self.record(session: "from.the.keychain") })

    let loaded = try #require(
      RoomSessionStore.load(root: root, keychainReader: spy.read, log: { _ in }))
    #expect(loaded.session == "from.the.keychain")
    #expect(spy.callCount == 1)

    // It wrote the file, at 0600 — so the NEXT launch, which may be a different build with a
    // different cdhash, never has to ask securityd anything.
    let url = RoomSessionStore.url(root: root)
    #expect(FileManager.default.fileExists(atPath: url.path))
    #expect(Self.mode(of: url) == 0o600)

    let again = KeychainSpy(answer: {
      Issue.record("the second read must come from the file")
      return Self.record()
    })
    #expect(
      RoomSessionStore.load(root: root, keychainReader: again.read, log: { _ in })?.session
        == "from.the.keychain")
    #expect(again.callCount == 0)
  }

  @Test func anUnmigratedRoomThatWouldNeedAClickGetsNilAndNotAWait() throws {
    // ─── THE FAILURE 0.1.11 DIED OF, NOW AN ANSWER INSTEAD OF A HANG ─────────────────────────
    // `kSecUseAuthenticationUIFail` turns the partition-list mismatch into this error. The store
    // must hand back nil promptly and write nothing: `startingConfiguration` then says needs_enrol
    // and the process stops, which an operator can see and act on. A hang is invisible.
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let spy = KeychainSpy(answer: { throw RoomKeychainError.status(errSecInteractionNotAllowed) })

    let started = Date()
    let loaded = RoomSessionStore.load(root: root, keychainReader: spy.read, log: { _ in })
    #expect(loaded == nil)
    #expect(Date().timeIntervalSince(started) < 1)
    #expect(spy.callCount == 1)
    // Nothing half-written, and no empty file for the next launch to trip over.
    #expect(!FileManager.default.fileExists(atPath: RoomSessionStore.url(root: root).path))
    #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
  }

  @Test func aKeychainThatIsSimplyEmptyIsAlsoJustNil() throws {
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let spy = KeychainSpy(answer: { throw RoomKeychainError.notFound })
    #expect(RoomSessionStore.load(root: root, keychainReader: spy.read, log: { _ in }) == nil)
  }

  // MARK: - §15.2's rejections

  @Test func aWorldReadableSessionFileIsRefused() throws {
    // A session at 0644 is readable by every process on the Mac. Refusing it is not pedantry: the
    // file replaces a keychain item, and the mode is the only thing standing where the ACL stood.
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomSessionStore.save(Self.record(), root: root)
    let url = RoomSessionStore.url(root: root)
    try FileManager.default.setAttributes(
      [.posixPermissions: NSNumber(value: 0o644)], ofItemAtPath: url.path)

    var refusal = ""
    let spy = KeychainSpy(answer: { throw RoomKeychainError.notFound })
    #expect(
      RoomSessionStore.load(root: root, keychainReader: spy.read, log: { refusal += $0 }) == nil)
    #expect(refusal.contains("ignoring room-session.json"))
    #expect(refusal.contains("644"))
    // Refused, and the fallback was still tried — a bad file must not stop a room that could
    // otherwise have migrated itself.
    #expect(spy.callCount == 1)
  }

  @Test func rubbishAndAnEmptyTokenAreBothRefused() throws {
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let url = RoomSessionStore.url(root: root)

    for (bytes, why) in [
      (Data("not json at all".utf8), "the JSON this app writes"),
      (Data(#"{"session_token":"","install_id":"i","room_slug":"s","room_name":"n","origin":"o","written_by":"v","written_at":"2026-09-10T00:00:00Z"}"#.utf8),
        "no session_token"),
    ] {
      try bytes.write(to: url)
      try FileManager.default.setAttributes(
        [.posixPermissions: NSNumber(value: 0o600)], ofItemAtPath: url.path)
      guard case .refused(let reason) = RoomSessionStore.readFile(root: root) else {
        Issue.record("expected a refusal for \(why)")
        continue
      }
      #expect(reason.contains(why))
    }
  }

  @Test func aSessionFileOwnedBySomebodyElseIsRefused() throws {
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomSessionStore.save(Self.record(), root: root)
    let url = RoomSessionStore.url(root: root)

    // Staging this needs root, which the suite does not have and must not want. When the chown
    // cannot be done the check below is UNEXERCISED, and that is said out loud here and in the
    // build report rather than left as a test that looks green and proves nothing.
    guard chown(url.path, 0, 0) == 0 else {
      #expect(
        getuid() != 0,
        "cannot chown without root, so the foreign-owner branch is unexercised — see the report")
      return
    }
    guard case .refused(let reason) = RoomSessionStore.readFile(root: root) else {
      Issue.record("a file owned by another user must be refused")
      return
    }
    #expect(reason.contains("owned by another user"))
  }

  @Test func aMissingFileIsAbsentRatherThanRefused() throws {
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    guard case .absent = RoomSessionStore.readFile(root: root) else {
      Issue.record("no file is not the same as a bad file")
      return
    }
  }

  // MARK: - What `enrol` writes (B1.5-D3)

  @Test func enrolPersistsTheSessionToTheFileAndNotTheKeychain() throws {
    // The verb's whole persistence step, minus the network: `enrolled.record(origin:)` is what
    // `main.swift` hands to `RoomSessionStore.save`, and there is no keychain call left on that
    // path to stub — see the report, which quotes the grep.
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let response = try JSONDecoder().decode(
      RoomEnrolmentResponse.self,
      from: Data(
        #"{"install_id":"install_ufbyh5h6j8c6","room_slug":"home-office-w8fb","room_name":"Home Office","session":{"token":"a.session.jwt","expires_at":"2027-09-10T00:00:00Z"}}"#
          .utf8))
    let origin = try #require(URL(string: "https://www.evenscribe.app"))

    try RoomSessionStore.save(response.record(origin: origin), root: root)

    let url = RoomSessionStore.url(root: root)
    #expect(Self.mode(of: url) == 0o600)
    let spy = KeychainSpy(answer: {
      Issue.record("an enrolled room must never reach the keychain")
      return Self.record()
    })
    let loaded = try #require(
      RoomSessionStore.load(root: root, keychainReader: spy.read, log: { _ in }))
    #expect(loaded.session == "a.session.jwt")
    #expect(loaded.installID == "install_ufbyh5h6j8c6")
    #expect(loaded.roomSlug == "home-office-w8fb")
    #expect(loaded.roomName == "Home Office")
    #expect(loaded.origin == "https://www.evenscribe.app")
    #expect(spy.callCount == 0)
    // `expires_at` came off the wire and is dropped, because the record has nowhere to put it.
    // Stated as a test so the flag in the report is not the only place it is written down.
    let json = try #require(
      try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    #expect(json["expires_at"] == nil)
  }
}
