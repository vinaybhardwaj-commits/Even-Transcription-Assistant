import Foundation
import Security

/// The one keychain item the Room Recorder owns (Install and Fleet PRD §5.4).
///
/// Service `com.evenscribe.room-recorder.room-token`, one generic password in the login keychain,
/// holding the room session JWT, the `install_id`, the room's slug and name, and the origin the
/// enrolment was performed against. `config.json` holds no token once this item exists.
///
/// ─── WHY THE FILE-BASED KEYCHAIN AND NOT THE DATA-PROTECTION ONE ─────────────────────────
/// §5.4 asks for `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, which is a DATA-PROTECTION
/// keychain attribute, and §8 acceptance item 6 asks for `security find-generic-password` to show
/// the item. On macOS those two requirements are mutually exclusive: the `security` CLI reads
/// file-based keychains, and an item added with `kSecUseDataProtectionKeychain: true` is invisible
/// to it.
///
/// The acceptance wins, because it is the evidence a person checks. The item goes in the login
/// keychain, where `security find-generic-password -s com.evenscribe.room-recorder.room-token`
/// finds it. `kSecAttrAccessible` is still set — it is accepted and inert on this path rather than
/// rejected — so the intent survives in the code if the item is ever migrated. **Flagged in the
/// build report; this is a conflict in the spec, not a choice made quietly.**
///
/// ─── WHY launchd CAN READ IT WITHOUT PROMPTING ───────────────────────────────────────────
/// `enrol` writes the item and `run` reads it, and both are the SAME signed executable inside the
/// same bundle. A file-based keychain item records the creating application in its ACL, and a
/// signed binary matches that ACL by its designated requirement rather than by path — so the
/// launchd-started `run` reads it silently. An unsigned build would match by path alone and would
/// prompt the first time the bundle moved. That is one more thing the D1 signature buys, and it is
/// why an unsigned candidate could never have carried this design.
public struct RoomKeychainRecord: Codable, Equatable, Sendable {
  /// The room session JWT (365-day TTL, D10). The secret. Never logged, never printed.
  public var session: String
  /// The server-minted install id this Mac enrolled as.
  public var installID: String
  public var roomSlug: String
  public var roomName: String
  /// The origin the enrolment was performed against, as an absolute https URL string.
  public var origin: String

  public init(session: String, installID: String, roomSlug: String, roomName: String, origin: String) {
    self.session = session
    self.installID = installID
    self.roomSlug = roomSlug
    self.roomName = roomName
    self.origin = origin
  }

  enum CodingKeys: String, CodingKey {
    case session
    case installID = "install_id"
    case roomSlug = "room_slug"
    case roomName = "room_name"
    case origin
  }
}

public enum RoomKeychainError: Error, LocalizedError, Equatable {
  case notFound
  case malformed
  case status(OSStatus)

  public var errorDescription: String? {
    switch self {
    case .notFound:
      return "no room session in the keychain — run `room-recorder enrol` first"
    case .malformed:
      return "the keychain item exists but could not be decoded"
    case .status(let code):
      let detail = SecCopyErrorMessageString(code, nil) as String? ?? "unknown"
      return "keychain error \(code): \(detail)"
    }
  }
}

public enum RoomKeychain {
  /// §5.4. Stated once; the packaging script and the acceptance both quote this string.
  public static let service = "com.evenscribe.room-recorder.room-token"
  /// One item per Mac. A Mac serves one room (A1), and a re-enrol REPLACES rather than adds —
  /// two sessions in one keychain would be two answers to "which room is this", and §4.5's
  /// supersession rule already decided there is only ever one.
  public static let account = "room-session"

  private static func baseQuery() -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }

  /// Write (or replace) the record. Replace is delete-then-add rather than `SecItemUpdate`,
  /// so a re-enrol cannot leave half of the previous room's identity behind.
  public static func save(_ record: RoomKeychainRecord) throws {
    let data = try JSONEncoder().encode(record)
    SecItemDelete(baseQuery() as CFDictionary)

    var attributes = baseQuery()
    attributes[kSecValueData as String] = data
    attributes[kSecAttrLabel as String] = "EvenScribe Room Recorder — room session"
    attributes[kSecAttrDescription as String] = "Room session, install id and origin"
    // Accepted and inert on the file-based keychain; see the type comment. Kept so the intent
    // §5.4 states is visible where the item is written.
    attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    let status = SecItemAdd(attributes as CFDictionary, nil)
    guard status == errSecSuccess else { throw RoomKeychainError.status(status) }
  }

  /// Read the item — **and never wait for a human** (Release B1.5, B1.5-D2).
  ///
  /// ─── THE ONE ATTRIBUTE THIS BUILD EXISTS FOR ───────────────────────────────────────────────
  /// The ACL on this item is by designated requirement and matches every build we sign. The
  /// PARTITION LIST is not: with no Apple Team ID on the signing identity, macOS keys it by cdhash,
  /// so every new version is a stranger and securityd raises a dialog. On a clinic Mac at 3 a.m.
  /// there is nobody to click it, and this call blocked for ever — 0.1.11 died that way on Home
  /// Office, and every room's list holds only `[0.1.8]`, so the first update of any of them would
  /// have done the same.
  ///
  /// `kSecUseAuthenticationUIFail` makes the mismatch RETURN instead of waiting:
  /// `errSecInteractionNotAllowed`, in microseconds. It grants nothing and hides nothing; it turns
  /// a hang into an error a caller can act on, which is the whole of B1.5-D2's "no code path may
  /// block on securityd".
  ///
  /// This is now a FALLBACK. `RoomSessionStore` is what the app reads; this runs once, on a room
  /// that still has its session only in the keychain, and its result is written to a file.
  /// Belt and braces for the same prompt (B1.5 Fix 1, K1).
  ///
  /// `kSecUseAuthenticationUIFail` is documented for DATA-PROTECTION items, and the dialog this
  /// item raises is the legacy file-based keychain's partition prompt — a different code path that
  /// may not honour the attribute at all. `SecKeychainSetUserInteractionAllowed(false)` is the
  /// switch that governs THAT prompt. It is deprecated and still functional, and a deprecated API
  /// that returns an error beats a supported one that waits for ever on a Mac nobody is sitting at.
  ///
  /// The previous value is read and restored, because this is process-global state and `enrol`
  /// runs interactively in the same binary.
  ///
  /// Deprecated by declaration ON PURPOSE: Swift does not warn about calling a deprecated API from
  /// a deprecated context, which is how the two `SecKeychain…` calls stay warning-free without a
  /// blanket suppression. Ordered by the B1.5 Fix 1 kickoff, K1.
  @available(
    macOS, deprecated: 10.10,
    message: "SecKeychainSetUserInteractionAllowed is the only switch for the legacy partition prompt (B1.5 Fix 1, K1)"
  )
  private static func withoutUserInteraction<T>(_ body: () -> T) -> T {
    var previous: DarwinBoolean = true
    let read = SecKeychainGetUserInteractionAllowed(&previous)
    SecKeychainSetUserInteractionAllowed(false)
    defer {
      // Only restore what was actually read. If the getter failed we leave interaction disabled
      // rather than guessing "true" and re-arming the very dialog this exists to prevent.
      if read == errSecSuccess { SecKeychainSetUserInteractionAllowed(previous.boolValue) }
    }
    return body()
  }

  public static func load() throws -> RoomKeychainRecord {
    var query = baseQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail

    var item: CFTypeRef?
    let status = withoutUserInteraction { SecItemCopyMatching(query as CFDictionary, &item) }
    if status == errSecItemNotFound { throw RoomKeychainError.notFound }
    guard status == errSecSuccess else { throw RoomKeychainError.status(status) }
    guard let data = item as? Data else { throw RoomKeychainError.malformed }
    do {
      return try JSONDecoder().decode(RoomKeychainRecord.self, from: data)
    } catch {
      throw RoomKeychainError.malformed
    }
  }

  /// Present without decoding, for `status` and for the migration check. Never returns the secret.
  public static func exists() -> Bool {
    var query = baseQuery()
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    return SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess
  }

  @discardableResult
  public static func delete() -> Bool {
    SecItemDelete(baseQuery() as CFDictionary) == errSecSuccess
  }
}
