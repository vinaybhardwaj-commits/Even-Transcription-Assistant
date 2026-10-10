import Foundation

/// Names and pins for the privileged helper (TS-H2 #39). Stated once; every other file reads them
/// from here.
///
/// ─── THE PIN IS THE LEAF HASH, NOT A TEAM ID ──────────────────────────────────────────────
/// V ruled 10 Oct 2026: no Developer ID, no notarization. The bundle is signed with V's own
/// keychain identity, which has no Team ID, so the requirement strings below pin the same leaf
/// hash `RoomSelfUpdate.pinnedRequirement` pins. `HelperIdentityTests` asserts the two hashes
/// agree. When a Developer ID build exists, only `requirement(identifier:)` changes.
public enum HelperIdentity {
  public static let appIdentifier = "com.evenscribe.room-recorder"
  public static let helperIdentifier = "com.evenscribe.room-recorder.helper"
  public static let machServiceName = "com.evenscribe.room-recorder.helper.xpc"
  public static let daemonPlistName = "com.evenscribe.room-recorder.helper.plist"
  public static let helperExecutableName = "room-recorder-helper"
  /// Lowercase SHA-1 of V's signing leaf, the form `codesign -R` and `RoomSelfUpdate` use.
  public static let pinnedLeafSHA1 = "187dd424fb866204111113d60c6f88a21d098edb"

  /// Where the helper keeps its own state, and where an operator drops the kill file.
  public static let supportDirectory = "/Library/Application Support/EvenScribe"
  public static let killFileName = "helper-disabled"
  public static let ledgerFileName = "helper-launches.json"

  /// The helper's own version. Bumped with the helper's behaviour, not with the app's.
  public static let helperVersion = "0.2.0-h2"
  public static let protocolVersion = 1

  /// `identifier "<id>" and certificate leaf = H"<sha1>"`. The leaf pin is what refuses an
  /// ad-hoc or other-signed peer; the identifier is what stops our own helper being accepted in
  /// the app's seat and the other way round.
  public static func requirement(identifier: String, leafSHA1: String = pinnedLeafSHA1) -> String {
    "identifier \"\(identifier)\" and certificate leaf = H\"\(leafSHA1)\""
  }

  /// The helper checks the app with this.
  public static var requirementForApp: String { requirement(identifier: appIdentifier) }
  /// The app checks the helper with this.
  public static var requirementForHelper: String { requirement(identifier: helperIdentifier) }
}
