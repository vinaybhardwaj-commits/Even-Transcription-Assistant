import CryptoKit
import FleetCore
import Foundation

/// #45 (TS-H8, 0.1.37). What the root helper will act on before it downloads anything: a release record the SERVER signed.
///
/// ─── WHY A SIGNED RECORD ───────────────────────────────────────────────────────────────────
/// The pkg is unsigned (V's ruling: no Installer identity), and its `preinstall`/`postinstall` run as root. Nothing in the
/// pkg's code signature covers them. So the whole pkg is bound by its sha256, and that sha256 is only worth trusting when it
/// comes from something the server signed with `fk1`, the key that is already compiled into the helper for envelopes.
/// The app fetches the record (it holds the room session) and hands it over; the helper trusts only the signature.
///
/// Signed bytes: the canonical JSON of the record object (`FleetJSON`, keys sorted, no whitespace), exactly the envelope rule.
/// The record is bound to ONE device and machine, has a window of at most a day, and names its signing key.
public struct ReleaseRecord: Equatable, Sendable {
  public static let fields: Set<String> = [
    "v", "version", "channel", "pkg_url", "pkg_sha256", "pkg_size", "min_helper", "cohort", "rollout_pct", "device_cohorts",
    "device_id", "machine", "issued_at", "expires_at", "nonce", "key_id",
  ]
  public static let maxWindow: TimeInterval = 24 * 3600
  public static let skew: TimeInterval = 120
  public static let maxPkgBytes: Int64 = 400 * 1024 * 1024
  /// Where a pkg may be downloaded from. The URL is signed, so this is a second fence: a host that is not ours is refused
  /// even when the signature is good.
  public static let allowedHosts: [String] = ["www.evenscribe.app", "evenscribe.app"]
  public static let allowedHostSuffixes: [String] = [".public.blob.vercel-storage.com"]

  public var version: String
  public var channel: String
  public var pkgURL: URL
  public var pkgSHA256: String
  public var pkgSize: Int64
  public var minHelper: String
  public var cohort: String
  public var rolloutPct: Int
  public var deviceCohorts: [String]
  public var deviceID: String
  public var machine: String
  public var issuedAt: Date
  public var expiresAt: Date
  public var nonce: String
  public var keyID: String
  /// The exact bytes that were signed.
  public var signedBytes: Data

  public static let cohortNames: Set<String> = ["home_office", "audiometry", "opd1", "pct", "all"]

  /// nil unless the object is EXACTLY the sixteen fields, each the right type and inside its bounds.
  public static func parse(_ json: FleetJSON) -> ReleaseRecord? {
    guard let o = json.objectValue, Set(o.keys) == fields, o["v"]?.intValue == 1,
      let version = o["version"]?.stringValue, isPlainVersion(version),
      let channel = o["channel"]?.stringValue, ["stable", "test"].contains(channel),
      let urlText = o["pkg_url"]?.stringValue, let url = validatedURL(urlText),
      let sha = o["pkg_sha256"]?.stringValue, sha.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
      let size = o["pkg_size"]?.intValue, size > 0, size <= maxPkgBytes,
      let minHelper = o["min_helper"]?.stringValue, RoomVersion(minHelper) != nil,
      let cohort = o["cohort"]?.stringValue, cohortNames.contains(cohort),
      let pct = o["rollout_pct"]?.intValue, (0...100).contains(pct),
      let cohorts = o["device_cohorts"]?.arrayValue, cohorts.count <= 8,
      let device = o["device_id"]?.stringValue, device.range(of: "^dev_[0-9a-f]{24}$", options: .regularExpression) != nil,
      let machine = o["machine"]?.stringValue, (1...128).contains(machine.utf8.count),
      machine.unicodeScalars.allSatisfy({ $0.value >= 0x20 }),
      let issuedText = o["issued_at"]?.stringValue, let issued = FleetEnvelope.date(issuedText),
      let expiresText = o["expires_at"]?.stringValue, let expires = FleetEnvelope.date(expiresText),
      let nonce = o["nonce"]?.stringValue, (8...64).contains(nonce.utf8.count),
      let keyID = o["key_id"]?.stringValue, keyID.range(of: "^[a-z0-9]{1,8}$", options: .regularExpression) != nil
    else { return nil }
    var names: [String] = []
    for item in cohorts {
      guard let name = item.stringValue, cohortNames.contains(name) else { return nil }
      names.append(name)
    }
    return ReleaseRecord(
      version: version, channel: channel, pkgURL: url, pkgSHA256: sha, pkgSize: size, minHelper: minHelper, cohort: cohort,
      rolloutPct: Int(pct), deviceCohorts: names, deviceID: device, machine: machine, issuedAt: issued, expiresAt: expires,
      nonce: nonce, keyID: keyID, signedBytes: json.canonicalData)
  }

  /// `1`, `0.1.37`, up to four numeric parts. The version builds root-side paths and a plist, so nothing else is allowed in it.
  static func isPlainVersion(_ text: String) -> Bool {
    text.utf8.count <= 32 && text.range(of: "^[0-9]+(\\.[0-9]+){0,3}$", options: .regularExpression) != nil
  }

  /// https, an allowed host, no credentials, no port, no query or fragment games.
  static func validatedURL(_ text: String) -> URL? {
    guard text.utf8.count <= 512, text.unicodeScalars.allSatisfy({ $0.value > 0x20 && $0.value < 0x7f }),
      let url = URL(string: text), url.scheme == "https", url.user == nil, url.password == nil, url.port == nil,
      url.fragment == nil, let host = url.host?.lowercased(), !host.isEmpty
    else { return nil }
    guard allowedHosts.contains(host) || allowedHostSuffixes.contains(where: { host.hasSuffix($0) }) else { return nil }
    return url
  }

  /// This device's bucket for this version, 0...99. Stated here so the server can compute the same number:
  /// the first four bytes of SHA-256 of `"<device_id>|<version>"`, big-endian, modulo 100.
  public static func bucket(deviceID: String, version: String) -> Int {
    let digest = SHA256.hash(data: Data("\(deviceID)|\(version)".utf8))
    let bytes = Array(digest.prefix(4))
    let value = bytes.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    return Int(value % 100)
  }

  /// Is this device in the group the release is currently open to? `all` is everyone; a named cohort is those devices the
  /// server listed that cohort for; `pct` is the devices whose bucket is under `rollout_pct`.
  public var eligible: Bool {
    switch cohort {
    case "all": return true
    case "pct": return Self.bucket(deviceID: deviceID, version: version) < rolloutPct
    default: return deviceCohorts.contains(cohort)
    }
  }
}

/// Why the helper turned an offer down. These are the words the bench poll shows.
public enum UpdateRefusal: String, Error, Equatable, Sendable {
  case malformed = "record_malformed"
  case badSignature = "record_bad_signature"
  case expired = "record_expired"
  case wrongDevice = "record_wrong_device"
  case notEligible = "not_eligible"
  case notNewer = "version_not_newer"
  /// 0.1.38: the offered version sorts BELOW the installed one. Refused and reported under its own name, so a rollout
  /// that points a Mac backwards is visible on the bench poll, not folded into "already current".
  case downgrade = "version_downgrade_refused"
  /// 0.1.38: the install path is not under /Applications (a per-user ~/Applications copy). Nothing is installed there.
  case userApplications = "install_path_not_applications"
  case pinned = "pinned"
  case pinUnreadable = "pin_unreadable"
  case helperTooOld = "helper_too_old"
  case held = "held_after_failures"
  case busy = "update_in_progress"
  case unknownInstalled = "installed_version_unknown"
}

public enum ReleaseVerifier {
  /// Steps in order; the first failure wins. `signature` is standard base64 of 64 bytes over `record.signedBytes`.
  public static func verify(
    recordJSON: String, signature: String, serverKeys: [String: Data], deviceID: String, machine: String, now: Date
  ) -> Result<ReleaseRecord, UpdateRefusal> {
    guard recordJSON.utf8.count <= 4_096, let json = try? FleetJSON.parse(Data(recordJSON.utf8)),
      let record = ReleaseRecord.parse(json)
    else { return .failure(.malformed) }
    // The bytes that are signed are the canonical form, whatever spacing the app forwarded.
    guard let keyData = serverKeys[record.keyID], let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData),
      let sig = FleetB64.fromStd(signature), sig.count == 64, key.isValidSignature(sig, for: record.signedBytes)
    else { return .failure(.badSignature) }
    guard record.expiresAt > record.issuedAt, record.expiresAt.timeIntervalSince(record.issuedAt) <= ReleaseRecord.maxWindow,
      now >= record.issuedAt.addingTimeInterval(-ReleaseRecord.skew), now <= record.expiresAt
    else { return .failure(.expired) }
    guard record.deviceID == deviceID, record.machine == machine else { return .failure(.wrongDevice) }
    return .success(record)
  }
}
