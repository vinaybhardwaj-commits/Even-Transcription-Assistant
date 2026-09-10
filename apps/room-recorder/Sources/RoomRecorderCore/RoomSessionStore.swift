import Foundation
import Security

/// Where the room session actually lives (Install and Fleet PRD §15, Release B1.5).
///
/// ─── WHY THE KEYCHAIN STOPPED WORKING, AND IT WAS NEVER OUR CODE ─────────────────────────────
/// The session was a login-keychain item. Its trusted-application ACL is by DESIGNATED REQUIREMENT
/// and matches every build we sign — that part worked, and it is what §5.4 reasoned about. But
/// securityd keeps a second gate on the item, the **partition list**, and because the signing
/// identity carries no Apple Team ID, macOS keys that list by **cdhash**: a hash of the exact
/// binary. Every new version is therefore a stranger to the item, and `SecItemCopyMatching` puts up
/// a dialog asking a human to allow it.
///
/// On Home Office a human clicked Allow twice — securityd logged `user approved` at 05:21:03 and
/// 05:40:15 — which is why 0.1.9 and 0.1.10 "worked" and why R3 acceptance items 1 and 2 are now
/// marked NOT PROVEN REMOTE. 0.1.11 launched with nobody at the screen and blocked for ever inside
/// the keychain read. Every clinic Mac's item was written by 0.1.8, so its list is `[0.1.8]` and the
/// FIRST self-update of any of those rooms would have hung exactly the same way.
///
/// ─── SO THE SESSION MOVES TO A FILE, AND NOTHING MAY EVER BLOCK ON securityd (B1.5-D1, D2) ───
/// `<root>/room-session.json`, mode 0600, owned by the room user, written atomically. The same
/// protection `config.json` already gets on an auto-login kiosk whose login keychain is unlocked
/// from boot — which is what a clinic Mac is. The keychain is kept only as a one-time fallback for
/// a room that has not been migrated yet, and that read now carries
/// `kSecUseAuthenticationUIFail`, so a partition mismatch returns an error in microseconds instead
/// of waiting for a click that will never come.
public enum RoomSessionStore {

  /// §15.2. Beside `config.json`, in the room root, so a room's whole identity is one directory.
  public static func url(root: URL) -> URL {
    root.appendingPathComponent("room-session.json", isDirectory: false)
  }

  /// The file's shape (§15.2).
  ///
  /// ─── THESE ARE EXACTLY THE FIELDS THE KEYCHAIN RECORD CARRIES, AND NO OTHERS ───────────────
  /// §15.2 lists `room_id` and `expires_at`; neither exists. `RoomKeychainRecord` has carried
  /// `session`, `install_id`, `room_slug`, `room_name` and `origin` since R2, and the enrolment
  /// response's `expires_at` is read and then dropped at the point of saving. A migration cannot
  /// invent either field, because the keychain item it reads does not contain them — so the file
  /// carries what there is, under §15.2's name for the secret. FLAGGED in the build report.
  struct Stored: Codable {
    let sessionToken: String
    let installID: String
    let roomSlug: String
    let roomName: String
    let origin: String
    let writtenBy: String
    let writtenAt: Date

    enum CodingKeys: String, CodingKey {
      case sessionToken = "session_token"
      case installID = "install_id"
      case roomSlug = "room_slug"
      case roomName = "room_name"
      case origin
      case writtenBy = "written_by"
      case writtenAt = "written_at"
    }
  }

  /// The session, from the file if there is a usable one and from the keychain exactly once if
  /// there is not (§15.2, B1.5-D2).
  ///
  /// NIL IS ALWAYS AN ANSWER, NEVER A WAIT. Every failure — no file, a file with the wrong mode or
  /// the wrong owner, unparseable JSON, a keychain that will not answer without a human — returns
  /// nil promptly, and `RoomEngine.startingConfiguration` turns that into a loud `needs_enrol` and
  /// a process that stops. A room that cannot authenticate must say so, not hang with the
  /// microphone light off and nothing in the log.
  public static func load(
    root: URL,
    /// Injected so a test can prove the fallback without touching the machine's real keychain —
    /// the live room's session lives in it and must not be disturbed.
    keychainReader: () throws -> RoomKeychainRecord = { try RoomKeychain.load() },
    log: (String) -> Void = { message in
      FileHandle.standardError.write(Data("room-recorder: \(message)\n".utf8))
    }
  ) -> RoomKeychainRecord? {
    switch readFile(root: root) {
    case .ok(let record):
      log("room session read from room-session.json")
      return record
    case .refused(let why):
      // A file that exists and is not usable is worth a line: the fallback below may well succeed
      // and rewrite it, and then nobody would ever know the first one was wrong.
      log("ignoring room-session.json: \(why)")
    case .absent:
      break
    }

    let record: RoomKeychainRecord
    do {
      record = try keychainReader()
    } catch {
      // errSecInteractionNotAllowed is the ordinary case on an unmigrated room, not an emergency:
      // it is `kSecUseAuthenticationUIFail` doing its job. Everything else lands here too, and all
      // of it means the same thing to the caller.
      log("no usable room session: \(error.localizedDescription)")
      return nil
    }

    log("room session read from the keychain; writing room-session.json")
    // Best effort. A room that could read the keychain this launch can read it the next one, so a
    // failed write costs a fallback rather than the session.
    try? save(record, root: root)
    return record
  }

  /// §15.2, B1.5-D1. Atomic: written to a temporary name, chmod 0600 BEFORE the rename, then
  /// renamed over the destination — so no reader can ever observe the file at 0644, and no crash
  /// can leave a half-written one in place.
  ///
  /// NEVER TOUCHES THE KEYCHAIN ITEM (B1.5-D4). The legacy item stays where it is; deleting it is
  /// an optional SSH step for later, and an app that deleted it would destroy the only copy of a
  /// session it had just failed to write.
  public static func save(_ record: RoomKeychainRecord, root: URL) throws {
    let stored = Stored(
      sessionToken: record.session,
      installID: record.installID,
      roomSlug: record.roomSlug,
      roomName: record.roomName,
      origin: record.origin,
      writtenBy: BuildInfo.appVersion ?? "unbundled",
      writtenAt: Date())
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    let data = try encoder.encode(stored)

    let destination = url(root: root)
    let temporary = root.appendingPathComponent(
      "room-session.json.\(UUID().uuidString).tmp", isDirectory: false)
    try data.write(to: temporary, options: [.atomic])
    try FileManager.default.setAttributes(
      [.posixPermissions: NSNumber(value: 0o600)], ofItemAtPath: temporary.path)
    do {
      _ = try FileManager.default.replaceItemAt(destination, withItemAt: temporary)
    } catch {
      try? FileManager.default.removeItem(at: temporary)
      throw error
    }
  }

  enum FileOutcome {
    case ok(RoomKeychainRecord)
    case refused(String)
    case absent
  }

  /// §15.2's four rejections, and one more. A file that is not a REGULAR file is refused as well:
  /// the mode and owner below are read through a symlink, so without this check a link could point
  /// the read at something it was never meant to see.
  static func readFile(root: URL) -> FileOutcome {
    let path = url(root: root).path
    guard FileManager.default.fileExists(atPath: path) else { return .absent }
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: path) else {
      return .refused("its attributes could not be read")
    }
    guard attributes[.type] as? FileAttributeType == .typeRegular else {
      return .refused("it is not a regular file")
    }
    guard let mode = (attributes[.posixPermissions] as? NSNumber)?.uint16Value, mode == 0o600 else {
      let mode = (attributes[.posixPermissions] as? NSNumber)?.uint16Value ?? 0
      return .refused("its mode is \(String(mode, radix: 8)), not 600")
    }
    guard let owner = (attributes[.ownerAccountID] as? NSNumber)?.uint32Value,
      owner == getuid()
    else {
      return .refused("it is owned by another user")
    }
    guard let data = try? Data(contentsOf: url(root: root)) else {
      return .refused("it could not be read")
    }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    guard let stored = try? decoder.decode(Stored.self, from: data) else {
      return .refused("it is not the JSON this app writes")
    }
    guard !stored.sessionToken.isEmpty else { return .refused("it carries no session_token") }
    return .ok(
      RoomKeychainRecord(
        session: stored.sessionToken,
        installID: stored.installID,
        roomSlug: stored.roomSlug,
        roomName: stored.roomName,
        origin: stored.origin))
  }
}
