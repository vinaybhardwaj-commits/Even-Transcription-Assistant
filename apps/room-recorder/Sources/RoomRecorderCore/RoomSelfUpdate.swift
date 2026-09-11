import CryptoKit
import Foundation

/// Self-update (Install and Fleet PRD §13.3, Build R3).
///
/// ─── THE APP NEVER MOVES ITS OWN RUNNING BUNDLE (R3-1) ───────────────────────────────────────
/// Everything in this file stops one step short of the swap. It asks the server what version this
/// Mac should be running, downloads it, weighs it, hashes it, unpacks it, and verifies that what
/// came out was signed by the certificate this binary was compiled to expect. Then it writes a
/// shell script, spawns it detached from its own process group, and exits 64.
///
/// The reason is the failure mode §7 as originally written could not survive: an app that replaces
/// its own bundle is standing on the thing it is moving, and a process that dies between the two
/// moves leaves the resident path empty, launchd with nothing to start, and a clinic room needing
/// somebody to physically walk to it. Four rooms, one remote engineer. §12.7 and §12.8 already
/// record four instances of a stated guarantee that nothing implemented; a saved `.app.previous`
/// that no code ever restored would have been the fifth.
///
/// ─── EXIT 64 IS A FAIL-SAFE, NOT A STATUS ────────────────────────────────────────────────────
/// The LaunchAgent carries `KeepAlive = {"SuccessfulExit": false}`: launchd restarts the app on a
/// NON-ZERO exit and leaves it stopped on zero. `needs_enrol` and the retired 409 both exit zero
/// on purpose. Exit 1 already means any error. 64 is a third value, distinct in `launchd.log`, and
/// its non-zero-ness is the safety: if the swap script dies before it boots the agent out, launchd
/// starts the OLD app again and the room keeps recording on the version it has. Nothing is lost by
/// an update that does not happen; a room that stops recording is a clinic day.
///
/// ─── THE EXPECTED SIGNER IS COMPILED IN, NEVER SERVED (R3-5) ─────────────────────────────────
/// `pinnedRequirement` below is a constant in this binary. The release route returns where to get
/// the bytes and what they must hash to, and nothing about who signed them. A wrong or compromised
/// publish therefore cannot point a Mac at a different certificate — the worst it can do is offer
/// bytes this app refuses.
public enum RoomSelfUpdate {

  // MARK: - The constants that are not allowed to come off the wire

  /// The SHA-1 of the signing certificate, lower-cased, exactly as `Packaging/build-bundle.sh`
  /// pins it. The certificate runs to 4 September 2036; a rotation inside the life of this module
  /// costs one re-paste per Mac, which is the price of not letting a server name the signer.
  public static let pinnedLeafSHA1 = "187dd424fb866204111113d60c6f88a21d098edb"

  /// The `codesign -R` argument.
  ///
  /// ─── THE LEADING `= ` IS LOAD-BEARING ──────────────────────────────────────────────────────
  /// `codesign -R` takes either a PATH to a compiled requirement or, when the argument opens with
  /// `=`, requirement source text. `Packaging/build-bundle.sh` has always passed the `= ` form and
  /// was verified on 8 September to discriminate — pinned to a different leaf it fails, so it is a
  /// check and not a formality. §13.3 step 6 quotes the string without it. This uses the form the
  /// packaging script has actually proved, because a requirement that silently reads as a filename
  /// is a check that passes everything. FLAGGED in the build report.
  ///
  /// ─── NO `anchor trusted` (0.1.18, R3-5 amended 11 Sep) ─────────────────────────────────────
  /// Until 0.1.18 this read `= anchor trusted and certificate leaf = H"…"`. The certificate is
  /// self-signed — subject and issuer are both `EvenScribe Room Recorder Code Signing 1` — so the
  /// leaf IS the anchor, and the leaf hash already names the one certificate allowed to sign.
  /// What `anchor trusted` added was a second question, put to THIS Mac's trust settings, and a
  /// clinic Mac cannot be made to answer it without someone clicking at its screen: over SSH,
  /// `security add-trusted-cert` is refused with "no user interaction was possible". On 11 Sep
  /// Room 4.1 refused 0.1.17 as `signature_mismatch` for exactly that reason; on its own bundle
  /// the full requirement failed and the same command without the clause passed.
  ///
  /// R3-5 itself is unchanged: the expected signer is compiled into this binary, never served. The
  /// release route says where the bytes are and what they hash to, and cannot name a certificate.
  /// The sha256, the size and `--strict --deep` all still run; only the trust-store question goes.
  public static let pinnedRequirement =
    "= certificate leaf = H\"\(pinnedLeafSHA1)\""

  /// §13.3 step 1. Not configurable, and deliberately so (V, 9 September 2026): acceptance forces
  /// a check with `launchctl kickstart -k`, and a knob added here would exist in every clinic room
  /// for ever.
  public static let checkInterval: TimeInterval = 6 * 60 * 60

  /// The LaunchAgent label, stated once. The plist path is derived from it the same way
  /// `install-launch-agent` derives it.
  public static let launchAgentLabel = "com.evenscribe.room-recorder"

  /// ─── THE EXIT CODE A HANDOVER USES (R3-4). Fix 1, F7: named, not a bare literal. ──────────
  /// 64 is distinct from 0 — which `needs_enrol` and the retired 409 use ON PURPOSE, to stay
  /// stopped — and from 1, which already means any error. So an update restart is readable in
  /// `launchd.log` and separable from a crash.
  ///
  /// ITS NON-ZERO-NESS IS THE FAIL-SAFE, not its value. `KeepAlive` is `{"SuccessfulExit": false}`,
  /// so launchd restarts the app on any non-zero exit: if the swap script dies before it boots the
  /// agent out, the OLD app comes back and the room keeps recording on the version it has.
  public static let handoverExitCode: Int32 = 64

  // MARK: - Paths under the app root

  public static func stagingURL(root: URL) -> URL {
    root.appendingPathComponent("update-staging", isDirectory: true)
  }

  /// §13.3 step 10. The swap script writes it, the NEW copy of the app reads it once, reports it
  /// and deletes it. It is the only proof an update landed, because the app that attempted the
  /// update is not running any more by the time there is anything to say.
  public static func resultURL(root: URL) -> URL {
    root.appendingPathComponent("update-result.json", isDirectory: false)
  }

  public static func logURL(root: URL) -> URL {
    root.appendingPathComponent("update.log", isDirectory: false)
  }

  /// ─── THE HANDOVER MARKER (Fix 1, F3) ───────────────────────────────────────────────────────
  /// Written immediately before the swap script is spawned, removed when its outcome is read.
  ///
  /// WHAT IT PREVENTS. The app exits 64 and launchd restarts it AT ONCE — `ThrottleInterval` is a
  /// minimum interval between *starts*, and this process had been running for hours, so there is no
  /// throttle left to spend. The new process reaches `RoomEngine.init`, which used to delete the
  /// staging directory unconditionally — the directory holding `swap.sh` and the expanded bundle
  /// the script is at that moment about to move. The swap had to win a race it was never told it
  /// was in.
  ///
  /// A marker rather than a timestamp sweep because it states the intent: "a handover is in flight,
  /// leave this alone". It carries the time so it cannot wedge for ever if the script dies without
  /// writing a result.
  public static func handoverMarkerURL(root: URL) -> URL {
    root.appendingPathComponent("update-handover.json", isDirectory: false)
  }

  /// How long a marker is believed. THIRTY MINUTES (V, 9 September 2026, Fix 2 G4 — raised from
  /// ten). A ~90 MB bundle, two directory renames and a `codesign --deep` on a Mac mini's disk,
  /// with the disk possibly busy writing a clinic day of audio at the same time. Ten minutes was
  /// chosen without measuring, and the cost of it being too short is the worst kind: the staging
  /// directory swept out from under a swap script that is still working.
  ///
  /// The cost of it being too LONG is only that a dead script's ~90 MB sits there half an hour
  /// longer. That asymmetry is why the number went up rather than down.
  ///
  /// Past it the marker is stale and staging is swept, so a script that died without writing a
  /// result cannot leave the directory behind for ever.
  ///
  /// NOT CONFIGURABLE — same ruling as the check interval (V, 9 September).
  public static let handoverGrace: TimeInterval = 30 * 60

  /// Where the attempt ledger lives (Fix 1, F2).
  public static func attemptsURL(root: URL) -> URL {
    root.appendingPathComponent("update-attempts.json", isDirectory: false)
  }

  /// ─── THE LAUNCH CANARY (Release B1, §14.2, B1-D4) ──────────────────────────────────────────
  /// Written by the swap script immediately after `record ok null`, deleted by the NEW copy of the
  /// app on its first successful poll. Its presence 180 seconds after the agent was bootstrapped
  /// means the version that was just swapped in cannot poll, and the script puts the old one back.
  ///
  /// WHAT IT PROTECTS AGAINST is the one remaining way a room can need a physical visit: a build
  /// that installs cleanly — checksum, signature, plist and the resident-verify all pass — and then
  /// cannot run. `KeepAlive = {SuccessfulExit: false}` restarts it for ever, and the updater lives
  /// INSIDE the app, so a room that cannot poll can never be told to go back. Nothing outside the
  /// swap script is in a position to notice, because by then the app that started it is gone.
  ///
  /// DELETION IS THE ACKNOWLEDGEMENT, not a field written into it. A delete is atomic, needs no
  /// parsing by the script, and cannot half-succeed; the app has to be running well enough to have
  /// completed a poll before it can perform one.
  public static func canaryURL(root: URL) -> URL {
    root.appendingPathComponent("update-canary.json", isDirectory: false)
  }

  /// How long the new version has to complete one poll. THREE MINUTES (V, 10 September 2026,
  /// B1-D1). Long enough for a cold launch behind a busy disk and a first poll on a slow clinic
  /// link; short enough that a room that cannot run its new build is back on the old one before
  /// anybody notices. A literal in the rendered script (`CANARY_SECONDS`), and stated once here so
  /// the sentence the receipt carries and the loop that times it cannot drift apart.
  public static let canaryWindow: TimeInterval = 180

  /// How often the watchdog looks. Two seconds: 90 `stat`s across the whole window, and an
  /// acknowledgement is noticed within two seconds of the app making it.
  public static let canarySlice: TimeInterval = 2

  /// How long a version is held after its SECOND failure. One check interval: the room tries again
  /// tomorrow morning rather than every eighty seconds for ever.
  ///
  /// NOT CONFIGURABLE (V, 9 September).
  public static let retryHold: TimeInterval = 6 * 60 * 60

  /// How many failures of the SAME version are allowed before the hold. One retry, then hold.
  public static let failuresBeforeHold = 2

  public static func plistURL() -> URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/LaunchAgents", isDirectory: true)
      .appendingPathComponent("\(launchAgentLabel).plist", isDirectory: false)
  }
}

// MARK: - What the release route answers

/// The four fields of §13.4's 200. Nothing about the signer: see R3-5.
public struct RoomReleaseDescriptor: Codable, Equatable, Sendable {
  public let version: String
  public let sha256: String
  public let sizeBytes: Int64
  public let blobURL: String

  enum CodingKeys: String, CodingKey {
    case version
    case sha256
    case sizeBytes = "size_bytes"
    case blobURL = "blob_url"
  }

  public init(version: String, sha256: String, sizeBytes: Int64, blobURL: String) {
    self.version = version
    self.sha256 = sha256
    self.sizeBytes = sizeBytes
    self.blobURL = blobURL
  }
}

// MARK: - What an attempt leaves behind

/// The outcomes `last_update_result` may hold, and no others.
public enum RoomUpdateOutcome: String, Codable, Equatable, Sendable {
  case ok
  case checksumMismatch = "checksum_mismatch"
  case signatureMismatch = "signature_mismatch"
  case downloadFailed = "download_failed"
  case expandFailed = "expand_failed"
  case swapFailed = "swap_failed"
  /// Fix 2, G1. The zip is authentic and correctly signed, and the bundle inside it calls itself a
  /// DIFFERENT version from the one the release row names. §13.4's original five did not cover it
  /// because it is not a corruption — it is a publish mistake, and it is the one that loops.
  case versionMismatch = "version_mismatch"
}

/// `update-result.json`, written by the swap script in shell and by this file in Swift.
///
/// THE KEYS ARE A WIRE FORMAT BETWEEN A BASH HEREDOC AND A `JSONDecoder`, which is why they are
/// spelled out in `CodingKeys` and why `RoomSwapScript` writes them literally. A rename on one side
/// alone produces a file the app silently cannot read, and the failure it was recording is lost.
public struct RoomUpdateResult: Codable, Equatable, Sendable {
  public let outcome: RoomUpdateOutcome
  /// The version the update was attempting. Present even on failure — especially on failure: the
  /// fleet card's sentence names it, and by the time the card renders it the attempt is history.
  public let version: String
  /// What went wrong, in a sentence. Nil on `ok`.
  public let reason: String?
  public let at: Date

  enum CodingKeys: String, CodingKey {
    case outcome, version, reason, at
  }

  public init(outcome: RoomUpdateOutcome, version: String, reason: String?, at: Date) {
    self.outcome = outcome
    self.version = version
    self.reason = reason
    self.at = at
  }

  /// What goes into `last_update_error` — the reason and NOTHING ELSE.
  ///
  /// The first cut of R3 packed the version into the head of this string and had the card parse it
  /// back out on a delimiter, because §13.4's five columns had nowhere to put it. V ratified a
  /// seventh column in Fix 1, so the version travels in `last_update_version` and this field is a
  /// plain sentence again. A free-text column is no longer load-bearing.
  public var reportedErrorLine: String? {
    guard let reason, !reason.isEmpty else { return nil }
    return reason
  }

  public static func read(root: URL) -> RoomUpdateResult? {
    guard let data = try? Data(contentsOf: RoomSelfUpdate.resultURL(root: root)) else { return nil }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try? decoder.decode(RoomUpdateResult.self, from: data)
  }

  @discardableResult
  public func write(root: URL) -> Bool {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    guard let data = try? encoder.encode(self) else { return false }
    let url = RoomSelfUpdate.resultURL(root: root)
    guard (try? data.write(to: url, options: [.atomic])) != nil else { return false }
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    return true
  }

  public static func delete(root: URL) {
    try? FileManager.default.removeItem(at: RoomSelfUpdate.resultURL(root: root))
  }
}

/// The marker `RoomSelfUpdate.handoverMarkerURL` holds (Fix 1, F3).
public struct RoomUpdateHandover: Codable, Equatable, Sendable {
  public let version: String
  public let at: Date

  public init(version: String, at: Date) {
    self.version = version
    self.at = at
  }

  @discardableResult
  public func write(root: URL) -> Bool {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    guard let data = try? encoder.encode(self) else { return false }
    let url = RoomSelfUpdate.handoverMarkerURL(root: root)
    guard (try? data.write(to: url, options: [.atomic])) != nil else { return false }
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    return true
  }

  public static func read(root: URL) -> RoomUpdateHandover? {
    guard let data = try? Data(contentsOf: RoomSelfUpdate.handoverMarkerURL(root: root)) else {
      return nil
    }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try? decoder.decode(RoomUpdateHandover.self, from: data)
  }

  public static func clear(root: URL) {
    try? FileManager.default.removeItem(at: RoomSelfUpdate.handoverMarkerURL(root: root))
  }
}

/// `update-canary.json`, written by the swap script in shell and read by this file in Swift
/// (Release B1, §14.2.1).
///
/// LIKE THE RECEIPT, THIS IS A WIRE FORMAT BETWEEN A BASH HEREDOC AND A `JSONDecoder`. The script
/// writes these three keys literally; a rename on one side alone produces a file the app cannot
/// decode, and the app would then fail to acknowledge a canary it had every right to — which the
/// watchdog would read as "the new version cannot poll" and roll back a build that was working.
public struct RoomUpdateCanary: Codable, Equatable, Sendable {
  /// The version that was just swapped in — the one on trial.
  public let version: String
  /// The version at `.previous`, read out of its own Info.plist by the script. Nil when the script
  /// could not read it; the receipt then says `unknown` rather than inventing a number.
  public let previous: String?
  public let armedAt: Date

  public init(version: String, previous: String?, armedAt: Date) {
    self.version = version
    self.previous = previous
    self.armedAt = armedAt
  }

  enum CodingKeys: String, CodingKey {
    case version, previous
    case armedAt = "armed_at"
  }

  public static func read(root: URL) -> RoomUpdateCanary? {
    guard let data = try? Data(contentsOf: RoomSelfUpdate.canaryURL(root: root)) else { return nil }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try? decoder.decode(RoomUpdateCanary.self, from: data)
  }

  /// NOTHING IN PRODUCTION CALLS THIS. The swap script writes the real canary, in shell, because
  /// the app that would have written it exited 64 before the swap began. This exists so a test can
  /// stand up the state a script leaves behind, and to keep the type symmetrical with the receipt
  /// and the handover marker. Read the shell in `RoomSwapScript.render` for the authority.
  @discardableResult
  public func write(root: URL) -> Bool {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    guard let data = try? encoder.encode(self) else { return false }
    let url = RoomSelfUpdate.canaryURL(root: root)
    guard (try? data.write(to: url, options: [.atomic])) != nil else { return false }
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    return true
  }
}

/// The attempt ledger (Fix 1, F2) — how many times this Mac has failed on one version.
///
/// ─── WHY THIS HAS TO SURVIVE A RESTART ─────────────────────────────────────────────────────────
/// `RoomUpdateSchedule` is in memory and is rebuilt on every process start, and `isDue` returns
/// true unconditionally when nothing has been checked yet. So a resident-verify failure restored
/// `.previous`, launchd started the old app, and about a second and a half later that app asked
/// again, got the same version, downloaded ~90 MB again — the STAGED check had passed; it was the
/// RESIDENT check that failed — spawned again and exited 64 again. Roughly every eighty seconds,
/// for ever, until somebody withdrew the release. Every cycle booted the agent out and passed
/// through the window where the resident bundle does not exist.
///
/// The same loop needs no failure at all: a published release whose `version` disagrees with the
/// `CFBundleShortVersionString` inside its own zip never compares equal, so the swap "succeeds" and
/// the new copy still wants to update. A publish typo would do it.
///
/// ONE RETRY, THEN HOLD. Recorded on disk, keyed by version, cleared the moment a DIFFERENT version
/// is offered — because a new publish is exactly the thing that might fix it.
public struct RoomUpdateAttempts: Codable, Equatable, Sendable {
  public var version: String
  public var failures: Int
  /// Set when the hold begins. Nil while retries remain.
  public var holdUntil: Date?
  /// ─── THE STAMP THAT MAKES A RECEIPT COUNTABLE EXACTLY ONCE (Release B1, B1-D8) ────────────
  /// The `at` of the last `swap_failed` receipt this ledger counted at startup.
  ///
  /// G2's residual, now closed. A receipt lives on disk until a poll carries it away, and every
  /// restart before that poll walked back into `roomUpdateCountStartupReceipt` with the SAME
  /// receipt and counted it again. Two counts is the hold, so a room could be held after one real
  /// failure having never had the retry the design promises it. The receipt's own timestamp is the
  /// identity: the swap script writes it once, and no two failures share it.
  ///
  /// Nil on a ledger written by `stop()`, which counts a failure it is watching happen and has no
  /// receipt to stamp.
  public var countedReceiptAt: Date?

  public init(
    version: String, failures: Int, holdUntil: Date? = nil, countedReceiptAt: Date? = nil
  ) {
    self.version = version
    self.failures = failures
    self.holdUntil = holdUntil
    self.countedReceiptAt = countedReceiptAt
  }

  enum CodingKeys: String, CodingKey {
    case version, failures
    case holdUntil = "hold_until"
    case countedReceiptAt = "counted_receipt_at"
  }

  public static func read(root: URL) -> RoomUpdateAttempts? {
    guard let data = try? Data(contentsOf: RoomSelfUpdate.attemptsURL(root: root)) else {
      return nil
    }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try? decoder.decode(RoomUpdateAttempts.self, from: data)
  }

  @discardableResult
  public func write(root: URL) -> Bool {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    guard let data = try? encoder.encode(self) else { return false }
    let url = RoomSelfUpdate.attemptsURL(root: root)
    guard (try? data.write(to: url, options: [.atomic])) != nil else { return false }
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    return true
  }

  public static func clear(root: URL) {
    try? FileManager.default.removeItem(at: RoomSelfUpdate.attemptsURL(root: root))
  }
}

/// PURE — one more failure on `version`, folded into whatever the ledger already said.
///
/// A failure on a DIFFERENT version resets the count to one: the previous version's history says
/// nothing about this one, and a fresh publish is the most likely fix for a bad one.
public func roomUpdateRecordFailure(
  previous: RoomUpdateAttempts?, version: String, now: Date
) -> RoomUpdateAttempts {
  let sameVersion = previous?.version == version
  let failures = (sameVersion ? (previous?.failures ?? 0) : 0) + 1
  let hold =
    failures >= RoomSelfUpdate.failuresBeforeHold
    ? now.addingTimeInterval(RoomSelfUpdate.retryHold)
    : nil
  // B1-D8. The stamp travels with the count it belongs to. Dropping it here would let the next
  // restart count a receipt this ledger has already counted — the exact double count D8 closes —
  // because `stop()` rewrites the whole ledger on any failure. A DIFFERENT version resets the
  // count, so it resets the stamp with it: the new count has never seen a receipt.
  return RoomUpdateAttempts(
    version: version, failures: failures, holdUntil: hold,
    countedReceiptAt: sameVersion ? previous?.countedReceiptAt : nil)
}

/// PURE — is this Mac currently refusing to attempt `version` again? (Fix 1, F2.)
///
/// A different version is never held. That is deliberate: withdrawing the bad release and
/// publishing a good one must reach the room immediately, without waiting out a backoff earned by
/// the build it replaces.
public func roomUpdateIsHeld(
  attempts: RoomUpdateAttempts?, version: String, now: Date
) -> Bool {
  guard let attempts, attempts.version == version, let holdUntil = attempts.holdUntil else {
    return false
  }
  return now < holdUntil
}

/// The startup half of the ledger: count a receipt this process did not write (Fix 2, G2).
///
/// ─── EXACTLY ONE COUNT PER FAILURE, BY WHOEVER CAN SEE IT ──────────────────────────────────────
/// `swap_failed` is the ONLY outcome the swap script writes, and the only failure whose author
/// cannot count itself — the process that attempted it exited 64 and is gone. Every other outcome
/// comes from `stop()`, which counts it in the same breath.
///
/// This used to fire on any outcome but `ok`, and that over-counted. The receipt lives on disk
/// until a poll has actually carried it, so a process that failed to download and restarted before
/// its next poll — a reboot, a crash, or the very network outage that caused the `download_failed`
/// — came back, found its own receipt, and counted the same failure a second time. Two counts is
/// the hold, so a room could be held after ONE real failure having never had its retry.
///
/// ─── AND EXACTLY ONCE ACROSS RESTARTS (Release B1, B1-D8) ──────────────────────────────────────
/// The narrow `.swapFailed` test above fixed the outcomes that were never this function's to
/// count. It did not fix the one that IS: the receipt stays on disk until a poll carries it away,
/// so every restart inside that window — and the launch canary now makes a restart inside it
/// ordinary, since a rolled-back room comes straight back up with the receipt still there — saw the
/// same receipt again and counted it again. Two counts is the hold.
///
/// The receipt's own `at` is the identity. A ledger that has already counted a receipt carries its
/// timestamp, and a receipt whose timestamp matches is one this Mac has already paid for.
///
/// Returns the ledger it wrote, or nil when there was nothing for this process to count.
@discardableResult
public func roomUpdateCountStartupReceipt(
  root: URL, receipt: RoomUpdateResult?, now: Date
) -> RoomUpdateAttempts? {
  guard let receipt, receipt.outcome == .swapFailed else { return nil }
  let previous = RoomUpdateAttempts.read(root: root)
  // ALREADY COUNTED. Nothing is written: rewriting an identical ledger would be harmless today and
  // is exactly the kind of "harmless" that stops being so when something else starts reading the
  // file's mtime.
  guard receipt.at != previous?.countedReceiptAt else { return nil }
  var ledger = roomUpdateRecordFailure(
    previous: previous, version: receipt.version, now: now)
  ledger.countedReceiptAt = receipt.at
  ledger.write(root: root)
  return ledger
}

/// PURE — may the staging directory be swept at startup? (Fix 1, F3.)
///
/// NO while a marker is present and fresh: the swap script is running out of that directory right
/// now. YES otherwise, including when the marker is stale, so a script that died without writing a
/// result cannot leave ~90 MB parked on a clinic Mac for ever.
public func roomUpdateMayClearStaging(handover: RoomUpdateHandover?, now: Date) -> Bool {
  guard let handover else { return true }
  return now.timeIntervalSince(handover.at) > RoomSelfUpdate.handoverGrace
}

// MARK: - Deciding whether to look at all

/// PURE — when the app should ask the release route, and nothing else (§13.3 steps 1 and 3).
///
/// SEPARATED FROM THE DOING so the rules are testable without a network, a disk or a clock. Every
/// decision R3-9 and R3-10 turn on is here, and none of it can be reached by accident from the
/// step that downloads.
public struct RoomUpdateSchedule: Equatable, Sendable {
  /// When the last check actually reached the route, whatever it answered. Nil = never checked.
  public var lastCheckedAt: Date?
  /// A check happened, found an update, and stood down because a session was open (§13.3 step 3).
  /// R3-10: that one re-checks the moment the session ends rather than in six hours.
  public var deferredWhileRecording: Bool

  public init(lastCheckedAt: Date? = nil, deferredWhileRecording: Bool = false) {
    self.lastCheckedAt = lastCheckedAt
    self.deferredWhileRecording = deferredWhileRecording
  }

  /// True when the app should call the release route now.
  ///
  /// `sessionJustEnded` is R3-10 and is the whole reason this is not a plain interval. A clinic day
  /// is close to continuous recording, so an update deferred at 09:10 would otherwise wait until
  /// 15:10 — most of a day after the last patient left.
  public func isDue(now: Date, sessionJustEnded: Bool) -> Bool {
    guard let last = lastCheckedAt else { return true }  // on launch
    if deferredWhileRecording && sessionJustEnded { return true }
    return now.timeIntervalSince(last) >= RoomSelfUpdate.checkInterval
  }
}

/// PURE — §13.3 step 2. A DIFFERENT version is an update, in either direction.
///
/// NOT `>`, and the asymmetry is the entire rollback mechanism. `latestRelease` orders by
/// `published_at`, not by version, so withdrawing the newest row makes the route answer with the
/// one before it — a LOWER version — and every Mac walks backwards at its next check. Turning this
/// into a greater-than would leave withdraw with nothing to do and a bad build in four rooms.
public func roomUpdateIsAvailable(running: String?, offered: String) -> Bool {
  guard let running, !running.isEmpty else {
    // No version at all is an unbundled `swift run` binary. It has no release identity, must not
    // claim one, and must never swap a bundle it is not running from.
    return false
  }
  return running != offered
}

// MARK: - The seams

/// Fetching the release descriptor. R3-9 lives at this boundary: ANY answer other than a 200 is
/// `nil`, not an error to act on. 404 `NO_RELEASE`, 401, a timeout and a dead network all mean the
/// same thing — log it, change nothing on disk, look again next tick. A missing release is never a
/// reason to remove software from a room.
public protocol RoomReleaseFetching: Sendable {
  func fetchRelease(channel: String) async -> RoomReleaseDescriptor?
}

/// Downloading the zip. Separate from the fetcher so a test can offer bytes without a server.
public protocol RoomUpdateDownloading: Sendable {
  func download(from url: URL) async throws -> Data
}

/// Running `ditto`, `codesign`, and the swap script. Never throws on a non-zero status: a failed
/// verify is an ANSWER, and turning it into an exception loses which of the six outcomes it was.
public protocol RoomUpdateCommandRunning: Sendable {
  func run(_ executable: String, _ arguments: [String]) -> Int32
  /// Spawn detached from this process's group, and do not wait. The child must outlive its parent.
  func spawnDetached(_ executable: String, _ arguments: [String]) throws
}

public struct FoundationUpdateDownloader: RoomUpdateDownloading {
  private let session: URLSession
  public init(session: URLSession = .shared) { self.session = session }

  public func download(from url: URL) async throws -> Data {
    var request = URLRequest(url: url)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    // A clinic Mac on a slow line downloading ~90 MB. Generous, and still bounded: an update that
    // never finishes must end as a reported `download_failed`, not as a task that lives for ever.
    request.timeoutInterval = 600
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      throw RoomUpdateError.download("the blob answered a status other than 200")
    }
    return data
  }
}

public struct FoundationUpdateCommandRunner: RoomUpdateCommandRunning {
  public init() {}

  public func run(_ executable: String, _ arguments: [String]) -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    do {
      try process.run()
      process.waitUntilExit()
      return process.terminationStatus
    } catch {
      return -1
    }
  }

  /// ─── DETACHED, AND THE DETACHMENT IS THE POINT (R3-1) ──────────────────────────────────────
  /// The script has to outlive the app that wrote it — it exists precisely to act after that app
  /// is gone. A `Process` child stays in this process's group, and launchd terminating the job
  /// signals the whole group: the swap would be killed half-done, in exactly the window R3-1 was
  /// written to survive.
  ///
  /// So this is `posix_spawn` with `POSIX_SPAWN_SETSID`, which puts the child in a NEW SESSION
  /// before it execs. Darwin, no dependency, and the one call that actually makes the guarantee.
  /// The three standard descriptors go to /dev/null because inheriting launchd's log handles would
  /// keep the job's file descriptors alive after the job is gone; the script logs to its own file.
  public func spawnDetached(_ executable: String, _ arguments: [String]) throws {
    var attributes: posix_spawnattr_t?
    guard posix_spawnattr_init(&attributes) == 0 else {
      throw RoomUpdateError.spawn("posix_spawnattr_init failed")
    }
    defer { posix_spawnattr_destroy(&attributes) }
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID))

    var actions: posix_spawn_file_actions_t?
    guard posix_spawn_file_actions_init(&actions) == 0 else {
      throw RoomUpdateError.spawn("posix_spawn_file_actions_init failed")
    }
    defer { posix_spawn_file_actions_destroy(&actions) }
    posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
    posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0)
    posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0)

    var argv: [UnsafeMutablePointer<CChar>?] = ([executable] + arguments).map { strdup($0) }
    argv.append(nil)
    defer { for pointer in argv where pointer != nil { free(pointer) } }

    var pid: pid_t = 0
    let status = posix_spawn(&pid, executable, &actions, &attributes, &argv, environ)
    guard status == 0 else { throw RoomUpdateError.spawn("posix_spawn failed with \(status)") }
    // Deliberately NOT waited on. The parent is about to exit 64, and the child now belongs to a
    // session of its own that nothing in this process's lifetime can signal.
  }
}

public enum RoomUpdateError: Error, Equatable, Sendable {
  case download(String)
  case spawn(String)
}

// MARK: - The attempt

public enum RoomUpdateAttempt: Equatable, Sendable {
  /// The running version is what the channel offers. Nothing to do, nothing written.
  case upToDate
  /// A session is open (§13.3 step 3). NOTHING was downloaded — see the guard's own comment.
  case deferredWhileRecording(version: String)
  /// Staged, verified, script spawned. The caller must now exit 64 and stop touching the disk.
  case handedOver(version: String)
  /// Steps 4 to 6 failed. `update-result.json` has been written and the staging area removed.
  case stopped(RoomUpdateOutcome, reason: String)
  /// F2. This version has failed twice on this Mac and is not being attempted again until the hold
  /// expires or a different version appears. NOTHING was downloaded.
  case heldAfterRepeatedFailure(version: String)
}

/// The steps of §13.3, with every piece of the outside world injected.
public struct RoomUpdater: Sendable {
  public let rootURL: URL
  /// Where the running app lives. `Bundle.main.bundleURL` in production; a temp dir in a test.
  public let residentBundleURL: URL
  public let runningVersion: String?
  public let channel: String
  let fetcher: any RoomReleaseFetching
  let downloader: any RoomUpdateDownloading
  let runner: any RoomUpdateCommandRunning
  let now: @Sendable () -> Date
  let log: @Sendable (String) -> Void

  public init(
    rootURL: URL,
    residentBundleURL: URL,
    runningVersion: String?,
    channel: String,
    fetcher: any RoomReleaseFetching,
    downloader: any RoomUpdateDownloading = FoundationUpdateDownloader(),
    runner: any RoomUpdateCommandRunning = FoundationUpdateCommandRunner(),
    now: @escaping @Sendable () -> Date = { Date() },
    log: @escaping @Sendable (String) -> Void = { message in
      FileHandle.standardError.write(Data("room-recorder: \(message)\n".utf8))
    }
  ) {
    self.rootURL = rootURL
    self.residentBundleURL = residentBundleURL
    self.runningVersion = runningVersion
    self.channel = channel
    self.fetcher = fetcher
    self.downloader = downloader
    self.runner = runner
    self.now = now
    self.log = log
  }

  /// `CFBundleShortVersionString` out of a bundle ON DISK, or nil (Fix 2, G1).
  ///
  /// `PropertyListSerialization` over the raw `Contents/Info.plist` bytes, deliberately:
  ///
  /// · NOT `defaults read` — it answers from a preferences cache, not from the file, and can be
  ///   stale or simply wrong about a bundle that has just been unpacked into a temporary path.
  /// · NOT `Bundle.main` — that is THIS process's identity. The question here is what the bundle
  ///   sitting in the staging directory claims to be.
  /// · `Bundle(url:)` would work but caches per-path inside the process, and the staging path is
  ///   reused across attempts within one run of the app. Reading the bytes has no such memory.
  ///
  /// Nil on any failure — missing plist, unreadable plist, missing or non-string key. The caller
  /// treats nil as a mismatch, which is right: a bundle that will not say what it is has not been
  /// shown to be what the release claims.
  static func bundleShortVersion(at bundleURL: URL) -> String? {
    let plistURL = bundleURL.appendingPathComponent("Contents/Info.plist", isDirectory: false)
    guard let data = try? Data(contentsOf: plistURL),
      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil),
      let object = plist as? [String: Any],
      let version = object["CFBundleShortVersionString"] as? String,
      !version.isEmpty
    else {
      return nil
    }
    return version
  }

  /// One whole check, from asking the route to spawning the script.
  ///
  /// `sessionIsOpen` IS PASSED IN AND READ ONCE, at the top. The engine owns that fact and this
  /// type must not guess at it; taking it as a parameter is what makes step 3 provable without a
  /// recorder.
  public func check(sessionIsOpen: Bool) async -> RoomUpdateAttempt {
    guard let release = await fetcher.fetchRelease(channel: channel) else {
      // R3-9, and the whole of it. 404, 401, a timeout, a dead network: log, change nothing,
      // look again next tick. NOT an outcome, not a result file, not a card line — a room that
      // could not reach the server has nothing wrong with it.
      log("update check: no release available on channel \(channel); nothing changed")
      return .upToDate
    }
    guard roomUpdateIsAvailable(running: runningVersion, offered: release.version) else {
      // A version match also means the ledger is spent: whatever went wrong before, this Mac is
      // now running what its channel offers.
      RoomUpdateAttempts.clear(root: rootURL)
      return .upToDate
    }
    // F2. THE LOOP-BREAKER. Two failures on this exact version and the Mac stops asking for it
    // until the hold expires or a different version is published. Read from DISK, because the
    // process that failed is not this one — that is the whole reason the ledger is a file.
    let attempts = RoomUpdateAttempts.read(root: rootURL)
    if roomUpdateIsHeld(attempts: attempts, version: release.version, now: now()) {
      log(
        "update to \(release.version) held: it has failed \(attempts?.failures ?? 0) times on this Mac. "
          + "Publish a different version, or withdraw this one, to clear the hold.")
      return .heldAfterRepeatedFailure(version: release.version)
    }
    // §13.3 step 3, BEFORE the download and not after it. A clinic Mac recording a consultation
    // must not spend its disk and its network on ~90 MB it has already decided not to install.
    if sessionIsOpen {
      log("update to \(release.version) deferred: a recording session is open")
      return .deferredWhileRecording(version: release.version)
    }
    return await stage(release)
  }

  /// Steps 4 to 7. Split out so `check`'s guards read as the decision they are.
  func stage(_ release: RoomReleaseDescriptor) async -> RoomUpdateAttempt {
    let manager = FileManager.default
    let staging = RoomSelfUpdate.stagingURL(root: rootURL)

    func stop(_ outcome: RoomUpdateOutcome, _ reason: String) -> RoomUpdateAttempt {
      // NOTHING STAGED SURVIVES A FAILURE. The resident bundle was never touched — no step below
      // this line reaches it — so "the resident copy is unchanged" (acceptance item 5) is a
      // property of the ORDER of this function, not of a cleanup that might not run.
      try? manager.removeItem(at: staging)
      RoomUpdateResult(outcome: outcome, version: release.version, reason: reason, at: now())
        .write(root: rootURL)
      // F2. Counted here, on disk, so the count survives the restart that follows a failed swap —
      // and so a staging failure that repeats every tick is held after one retry too.
      roomUpdateRecordFailure(
        previous: RoomUpdateAttempts.read(root: rootURL), version: release.version, now: now()
      ).write(root: rootURL)
      log("update to \(release.version) stopped: \(outcome.rawValue): \(reason)")
      return .stopped(outcome, reason: reason)
    }

    try? manager.removeItem(at: staging)
    do {
      try manager.createDirectory(
        at: staging, withIntermediateDirectories: true,
        attributes: [.posixPermissions: NSNumber(value: 0o700)])
    } catch {
      return stop(.downloadFailed, "the staging directory could not be created")
    }

    // ── Step 4: download ────────────────────────────────────────────────────────────────────
    guard let blobURL = URL(string: release.blobURL), blobURL.scheme == "https" else {
      return stop(.downloadFailed, "the release named a blob address this app will not fetch")
    }
    let bytes: Data
    do {
      bytes = try await downloader.download(from: blobURL)
    } catch {
      return stop(.downloadFailed, "the download did not finish")
    }
    // SIZE FIRST, because it is the cheap half of the same question and it names the likelier
    // fault: a truncated download weighs less than it should, and saying so is more useful than
    // "the hash did not match".
    guard Int64(bytes.count) == release.sizeBytes else {
      return stop(
        .downloadFailed,
        "the download weighed \(bytes.count) bytes where \(release.sizeBytes) were expected")
    }
    let zipURL = staging.appendingPathComponent("app.zip", isDirectory: false)
    do {
      try bytes.write(to: zipURL, options: [.atomic])
    } catch {
      return stop(.downloadFailed, "the download could not be written to disk")
    }

    // ── Step 5: sha256 the bytes that are actually on disk ──────────────────────────────────
    // Hashed from the FILE, not from the Data in hand, so a bad write is caught too. These are
    // the bytes `ditto` is about to read.
    guard let written = try? Data(contentsOf: zipURL) else {
      return stop(.downloadFailed, "the download could not be read back after writing")
    }
    let digest = SHA256.hash(data: written).map { String(format: "%02x", $0) }.joined()
    guard digest.caseInsensitiveCompare(release.sha256) == .orderedSame else {
      return stop(.checksumMismatch, "the downloaded file did not match its checksum")
    }

    // ── Step 6a: expand ─────────────────────────────────────────────────────────────────────
    // `ditto -x -k`, the counterpart of the `ditto -c -k --keepParent` the packaging script uses.
    // NOT `unzip`: it does not carry the extended attributes a signature is sealed over, and a
    // bundle unpacked with it arrives with a broken seal.
    let expanded = staging.appendingPathComponent("expanded", isDirectory: true)
    guard runner.run("/usr/bin/ditto", ["-x", "-k", zipURL.path, expanded.path]) == 0 else {
      return stop(.expandFailed, "the downloaded file could not be unpacked")
    }
    let contents = (try? manager.contentsOfDirectory(atPath: expanded.path)) ?? []
    guard let appName = contents.first(where: { $0.hasSuffix(".app") }) else {
      return stop(.expandFailed, "the downloaded file held no application bundle")
    }
    let stagedApp = expanded.appendingPathComponent(appName, isDirectory: true)

    // ── Step 6b: the signature, against the compiled-in requirement (R3-5) ──────────────────
    // `--deep` because this is the same check `Packaging/build-bundle.sh` runs on the unpacked
    // zip, on this exact bundle shape, unpacked this exact way — and that bundle carries two
    // signed helpers under Contents/Helpers that a non-recursive verify would not look at.
    let verified = runner.run(
      "/usr/bin/codesign",
      [
        "--verify", "--strict", "--deep", "--verbose=4",
        "-R", RoomSelfUpdate.pinnedRequirement, stagedApp.path,
      ])
    guard verified == 0 else {
      return stop(.signatureMismatch, "the downloaded app was not signed by Even")
    }

    // ── Step 6c: does the bundle call itself what the release calls it? (Fix 2, G1) ─────────
    //
    // ─── THE ONLY FAILURE IN THIS FILE THAT NEEDS NO CORRUPTION TO HAPPEN ──────────────────
    // Everything above catches a zip that is broken or forged. This catches one that is perfect
    // and MISLABELLED: `app_release.version` says 0.1.8, the `Info.plist` inside says 0.1.9. A
    // publish typo is enough.
    //
    // Left undetected it is not a failed update, it is an ENDLESS one. The swap succeeds, the new
    // copy starts, reads its own `CFBundleShortVersionString` as 0.1.9, asks the route, is told
    // 0.1.8, and `running != offered` is true again — so it downloads, swaps and restarts about
    // every eighty seconds, for ever. The attempt ledger could not see it either, because the
    // receipt said `ok`: a ledger that counts failures cannot bound a loop made of successes.
    //
    // Caught HERE, before the swap, it becomes an ordinary failure — `stop()` writes the receipt
    // and counts it, so one-retry-then-hold applies with no further machinery, and nothing
    // resident has been touched.
    //
    // READ FROM THE STAGED PATH, NEVER THE RUNNING BUNDLE. `Bundle.main` is this process's own
    // identity and comparing it to the offer is the question we already answered in `check()`.
    // And never `defaults read`: it consults a preferences cache, not the file on disk.
    let stagedVersion = Self.bundleShortVersion(at: stagedApp)
    guard let stagedVersion, stagedVersion == release.version else {
      return stop(
        .versionMismatch,
        "the downloaded app calls itself \(stagedVersion ?? "nothing") but the release is named "
          + release.version)
    }

    // ── Step 7: write the script, spawn it detached, and hand over ──────────────────────────
    let scriptURL = staging.appendingPathComponent("swap.sh", isDirectory: false)
    let script = RoomSwapScript.render(
      residentBundleURL: residentBundleURL,
      stagedBundleURL: stagedApp,
      rootURL: rootURL,
      version: release.version)
    do {
      try script.write(to: scriptURL, atomically: true, encoding: .utf8)
      try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: scriptURL.path)
    } catch {
      return stop(.expandFailed, "the swap script could not be written")
    }
    // F3. BEFORE the spawn, not after: the moment the script exists and runs, the restarted app
    // must already be able to see that a handover is in flight.
    RoomUpdateHandover(version: release.version, at: now()).write(root: rootURL)
    do {
      try runner.spawnDetached("/bin/bash", [scriptURL.path])
    } catch {
      RoomUpdateHandover.clear(root: rootURL)
      return stop(.expandFailed, "the swap script could not be started")
    }
    // THE LAST THING THIS PROCESS SAYS. From here the script owns the bundle and the restart, and
    // the caller's only remaining job is to exit 64 without touching anything.
    log("handing over to the swap script for \(release.version); exiting 64")
    return .handedOver(version: release.version)
  }
}

// MARK: - The swap script

/// §13.3 step 8, rendered as shell.
///
/// ─── WHY EVERY PATH IS SINGLE-QUOTED ─────────────────────────────────────────────────────────
/// The three paths this script moves all contain spaces in production —
/// `~/Applications/EvenScribe Room Recorder.app` and
/// `~/Library/Application Support/EvenScribe/RoomRecorder` — and an unquoted one would split into
/// arguments and `rm -rf` something that was never named. Single quotes are used rather than double
/// because nothing inside them expands, so a path containing `$` or a backtick is inert; the one
/// character that needs handling is the single quote itself, and `quoted(_:)` handles it.
public enum RoomSwapScript {

  /// POSIX single-quoting: close the quote, emit an escaped quote, reopen. The only correct way to
  /// put an arbitrary byte string inside `'...'`.
  public static func quoted(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
  }

  /// The BODY of a JSON string — no surrounding quotes — with everything JSON requires escaped.
  ///
  /// F8. The swap script writes `update-result.json` from a bash heredoc, and bash has no idea what
  /// JSON is. A version containing `"` or `\\` would close or corrupt the string and produce a
  /// receipt the app cannot decode, losing the very outcome the receipt exists to carry. Escaping
  /// happens here, in Swift, and the script copies the finished bytes.
  ///
  /// Backslash FIRST — escaping it after the quotes would double-escape what the quote rule added.
  public static func jsonStringBody(_ value: String) -> String {
    var out = ""
    out.reserveCapacity(value.count + 8)
    for scalar in value.unicodeScalars {
      switch scalar {
      case "\\": out += "\\\\"
      case "\"": out += "\\\""
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        // Every other C0 control has to be escaped too; JSON forbids them raw in a string.
        if scalar.value < 0x20 {
          out += String(format: "\\u%04x", scalar.value)
        } else {
          out.unicodeScalars.append(scalar)
        }
      }
    }
    return out
  }

  public static func render(
    residentBundleURL: URL,
    stagedBundleURL: URL,
    rootURL: URL,
    version: String
  ) -> String {
    let resident = quoted(residentBundleURL.path)
    let previous = quoted(residentBundleURL.path + ".previous")
    let staged = quoted(stagedBundleURL.path)
    let root = quoted(rootURL.path)
    let plist = quoted(RoomSelfUpdate.plistURL().path)
    let result = quoted(RoomSelfUpdate.resultURL(root: rootURL).path)
    let logPath = quoted(RoomSelfUpdate.logURL(root: rootURL).path)
    let label = quoted(RoomSelfUpdate.launchAgentLabel)
    let requirement = quoted(RoomSelfUpdate.pinnedRequirement)
    // The version reaches shell twice, and the two need different escaping.
    //
    // ─── F8: THE JSON FORM IS ESCAPED IN SWIFT, NOT HOPED FOR IN BASH ────────────────────────
    // `record()` interpolates the version into a JSON string literal in a heredoc. A version
    // carrying a `"` or a `\` — it comes off the server, so it can carry anything — produced a
    // receipt `RoomUpdateResult.read` could not decode, and the outcome it was recording was lost
    // silently: exactly the failure the receipt exists to prevent. So the JSON-escaped form is
    // computed here, where a real escaper exists, and the shell only copies bytes.
    let versionLiteral = quoted(version)
    let versionJSONLiteral = quoted(jsonStringBody(version))
    let canary = quoted(RoomSelfUpdate.canaryURL(root: rootURL).path)
    let canarySeconds = Int(RoomSelfUpdate.canaryWindow)
    let canarySlice = Int(RoomSelfUpdate.canarySlice)
    // The rollback receipt's sentence, up to the version it restored — which only the script can
    // know, because only the script has read the canary file. Escaped HERE for the same reason the
    // version is (F8): `record` interpolates it into a JSON string literal and bash cannot escape
    // one. The number is the constant, not a second copy of it.
    let canaryReasonLiteral = quoted(
      jsonStringBody("the new version did not poll within \(canarySeconds) s; restored "))
    // H1. The other half of the same sentence, for the rollback that could not put the old bundle
    // back. Escaped in Swift for the same reason; the two versions are appended in shell.
    let canaryKeptReasonLiteral = quoted(
      jsonStringBody("the new version did not poll within \(canarySeconds) s; restore of "))
    // H2. The marker the rollback clears, at the one path `RoomUpdateHandover` uses. Passed in
    // rather than rebuilt in shell, so the two cannot drift apart.
    let handoverMarker = quoted(RoomSelfUpdate.handoverMarkerURL(root: rootURL).path)

    return """
      #!/bin/bash
      # EvenScribe Room Recorder — the swap script (Install and Fleet PRD §13.3 step 8, R3-1).
      #
      # WRITTEN BY THE APP, RUN AFTER THE APP HAS EXITED. Nothing in here runs while the bundle it
      # moves is executing, which is the whole of R3-1: an app that replaces its own bundle is
      # standing on the thing it is moving.
      #
      # `set -u` but NOT `set -e`. Every step below tests its own status and decides what to do
      # about it — a bare `set -e` would abandon the swap half-done, with the resident path empty
      # and no line written saying why.
      set -u

      LABEL=\(label)
      RESIDENT=\(resident)
      PREVIOUS=\(previous)
      STAGED=\(staged)
      ROOT=\(root)
      PLIST=\(plist)
      RESULT=\(result)
      LOG=\(logPath)
      VERSION=\(versionLiteral)
      # The same version, pre-escaped for the JSON string in record(). See F8.
      VERSION_JSON=\(versionJSONLiteral)
      REQUIREMENT=\(requirement)
      DOMAIN="gui/$(/usr/bin/id -u)"
      # ── Release B1, §14.2: the launch canary ────────────────────────────────────────────────
      CANARY=\(canary)
      CANARY_SECONDS=\(canarySeconds)
      CANARY_SLICE=\(canarySlice)
      # Pre-escaped for the JSON string in record(); the version it restored is appended at the
      # moment of the rollback.
      CANARY_REASON=\(canaryReasonLiteral)
      CANARY_KEPT_REASON=\(canaryKeptReasonLiteral)
      HANDOVER_MARKER=\(handoverMarker)

      say() {
        /bin/echo "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ') room-recorder-swap: $*" >> "$LOG" 2>/dev/null
      }

      # §13.3 step 8.6. Written atomically and 0600, because the app root is 0700 and this file is
      # the only thing that will ever say what happened here.
      record() {
        /bin/cat > "${RESULT}.tmp" <<JSON
      {
        "outcome": "$1",
        "version": "${VERSION_JSON}",
        "reason": $2,
        "at": "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"
      }
      JSON
        /bin/chmod 600 "${RESULT}.tmp" 2>/dev/null
        /bin/mv -f "${RESULT}.tmp" "$RESULT" 2>/dev/null
      }

      # §13.3 step 8.8. `bootstrap` is the modern verb; `load` is the fallback for a domain that
      # refuses it. Either is better than leaving a Mac with no agent.
      bootstrap_agent() {
        /bin/launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null \\
          || /bin/launchctl load "$PLIST" 2>/dev/null
      }

      # ─── THE FAIL-SAFE FOR THE WINDOW BETWEEN THE TWO MOVES ────────────────────────────────
      # Acceptance item 6 kills this script between step 8.3 and step 8.4, where the resident path
      # is empty and the old bundle is at .previous. A trap puts the old bundle back and boots the
      # agent in again, so the room polls on the version it had without anybody walking to it.
      #
      # THIS DOES NOT COVER `kill -9`, WHICH IS NOT TRAPPABLE. The window is two directory renames
      # on one volume, but it is not zero, and closing it completely needs an atomic exchange
      # (renamex_np with RENAME_SWAP) that shell cannot perform. FLAGGED in the build report.
      rescue() {
        if [ ! -d "$RESIDENT" ] && [ -d "$PREVIOUS" ]; then
          say "interrupted with the resident path empty — putting the previous bundle back"
          /bin/mv -f "$PREVIOUS" "$RESIDENT" 2>/dev/null
          # A rescue inside the ROLLBACK arrives with the failed bundle still parked at `.failed`,
          # because B1 Fix 1 made it outlive the restore. Nothing else would ever delete it: ~90 MB
          # on a Mac that also holds a clinic day of audio. Idempotent, and a no-op on the swap
          # path where that path never existed (V, 10 Sep, ruling on Fix 1 flag 1).
          /bin/rm -rf "${RESIDENT}.failed"
          record swap_failed '"the swap was interrupted and the previous version was put back"'
        fi
        bootstrap_agent
        exit 1
      }
      trap rescue INT TERM HUP QUIT

      say "swapping to ${VERSION}"

      # ── 8.1 Boot the agent out. Failure is ignored: it may already be gone. ─────────────────
      /bin/launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null

      # The app that wrote this script exited 64 a moment ago. Wait for launchd to reap it before
      # its bundle moves out from under it. The plist's ThrottleInterval of 30 s (R3-11) is what
      # buys the time for everything below.
      /bin/sleep 3

      # ── 8.2 One previous bundle, never two (R3-12) ─────────────────────────────────────────
      /bin/rm -rf "$PREVIOUS"
      # And no failed bundle from a rollback that was killed before its own cleanup could run. The
      # next swap is the last chance anything has to notice it (V, 10 Sep, ruling on Fix 1 flag 1).
      /bin/rm -rf "${RESIDENT}.failed"

      # ── 8.3 and 8.4 — THE TWO MOVES, adjacent, with nothing between them ───────────────────
      if ! /bin/mv -f "$RESIDENT" "$PREVIOUS"; then
        say "the resident bundle could not be moved aside — nothing was changed"
        record swap_failed '"the resident bundle could not be moved aside"'
        bootstrap_agent
        exit 1
      fi
      if ! /bin/mv -f "$STAGED" "$RESIDENT"; then
        say "the staged bundle could not be moved into place — putting the previous one back"
        /bin/mv -f "$PREVIOUS" "$RESIDENT" 2>/dev/null
        record swap_failed '"the staged bundle could not be moved into place"'
        bootstrap_agent
        exit 1
      fi

      # ── 8.5 Verify the bundle that is now RESIDENT, and roll back if it does not hold ──────
      # Against the resident path and not the staged one: the move is the thing being checked. The
      # requirement is the app's compiled-in constant, passed through, never fetched.
      if ! /usr/bin/codesign --verify --strict --deep --verbose=4 -R "$REQUIREMENT" "$RESIDENT" >> "$LOG" 2>&1; then
        say "the bundle now at the resident path does not satisfy the pinned requirement — restoring"
        /bin/rm -rf "$RESIDENT"
        /bin/mv -f "$PREVIOUS" "$RESIDENT" 2>/dev/null
        record swap_failed '"the new version did not satisfy the pinned signing requirement and the previous one was put back"'
        bootstrap_agent
        exit 1
      fi

      # ── 8.6 Say it worked, before anything else can fail ──────────────────────────────────
      record ok null

      # ── 8.6a Arm the launch canary (§14.2 step 1, B1-D1/B1-D4) ────────────────────────────
      # From here the script is a WATCHDOG, not a swap: it stays alive until the version it just
      # put in place has proved it can poll, and puts the old one back if it cannot. The app
      # acknowledges by deleting this file (step 8.9).
      #
      # The version at .previous is read from its own Info.plist, because that is the only place
      # that knows what the room was running a moment ago — the receipt names it so the fleet card
      # can say what the room went back to. `plutil -extract ... raw` prints the bare string.
      #
      # `tr` KEEPS THE JSON WELL-FORMED. This value goes into a JSON string and, unlike VERSION,
      # it has not been through the Swift escaper — it came off a plist on disk. Restricting it to
      # the characters a version string is made of means a plist carrying a quote or a backslash
      # cannot produce a canary file the app is unable to decode.
      PREVIOUS_VERSION="$(/usr/bin/plutil -extract CFBundleShortVersionString raw "${PREVIOUS}/Contents/Info.plist" 2>/dev/null | /usr/bin/tr -cd 'A-Za-z0-9._+-')"
      if [ -z "$PREVIOUS_VERSION" ]; then
        say "the previous bundle would not say what version it is; the canary records null"
        PREVIOUS_JSON=null
      else
        PREVIOUS_JSON="\\"${PREVIOUS_VERSION}\\""
      fi
      /bin/cat > "${CANARY}.tmp" <<JSON
      {
        "version": "${VERSION_JSON}",
        "previous": ${PREVIOUS_JSON},
        "armed_at": "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"
      }
      JSON
      /bin/chmod 600 "${CANARY}.tmp" 2>/dev/null
      /bin/mv -f "${CANARY}.tmp" "$CANARY" 2>/dev/null
      say "armed the canary for ${VERSION}"
      # THE HANDOVER MARKER STAYS (B1-D5). Staging must outlive this script: the rollback below
      # touches only the two bundles, but a marker cleared here would let the restarted app sweep
      # the directory this script is still running out of.

      # ── 8.7 The NEW bundle writes the plist, so a plist change ships with the app (R3-11) ──
      # --root is passed because the plist's own ProgramArguments carry it, and an
      # install-launch-agent that defaulted would point a custom-rooted install at the wrong place.
      if ! "${RESIDENT}/Contents/MacOS/room-recorder" install-launch-agent --root "$ROOT" >> "$LOG" 2>&1; then
        say "install-launch-agent failed — bootstrapping the plist already on disk"
      fi

      # ── 8.8 Start it again ────────────────────────────────────────────────────────────────
      bootstrap_agent
      say "swapped to ${VERSION} and bootstrapped"

      # ── 8.9 THE WATCHDOG (§14.2 step 3, B1-D1) ────────────────────────────────────────────
      # The swap is done and the agent is running. This script now waits, up to CANARY_SECONDS,
      # for the new version to delete the canary — which it does on its first successful poll, and
      # which it can only do if it launched, read its keychain, reached the server and got an
      # answer. That is the whole of "the new build works" as far as a room is concerned.
      #
      # A build that installs cleanly and then cannot poll is the one failure left that needed
      # somebody to walk to the room: launchd restarts it for ever, and the updater lives inside
      # the app, so a room that cannot poll can never be told to go back.
      say "waiting up to ${CANARY_SECONDS}s for ${VERSION} to poll"
      CANARY_WAITED=0
      while [ "$CANARY_WAITED" -lt "$CANARY_SECONDS" ]; do
        # Checked BEFORE the first sleep, so an app that acknowledges instantly is not made to
        # wait out a slice for the privilege.
        if [ ! -f "$CANARY" ]; then
          say "${VERSION} acknowledged the canary after ${CANARY_WAITED}s"
          exit 0
        fi
        /bin/sleep "$CANARY_SLICE"
        CANARY_WAITED=$((CANARY_WAITED + CANARY_SLICE))
      done

      # The version to name in the receipt, read from the canary while it is still there.
      #
      # NOT A JSON PARSER — cut on the quote character. This script wrote that file itself two
      # steps up, one key to a line, so the fourth quote-delimited field of the `previous` line is
      # the version and nothing else. `"previous": null` has no fourth field, which falls through
      # to `unknown` rather than to a sentence that trails off. The pattern is anchored to the line
      # because a version string is server-supplied and could contain the bytes `"previous"`.
      OLD_VERSION="$(/usr/bin/grep '^  "previous"' "$CANARY" 2>/dev/null | /usr/bin/head -n 1 | /usr/bin/cut -d '"' -f 4 | /usr/bin/tr -cd 'A-Za-z0-9._+-')"
      if [ -z "$OLD_VERSION" ]; then OLD_VERSION=unknown; fi

      # ── THE LAST LOOK, AT EXACTLY CANARY_SECONDS ──────────────────────────────────────────
      # The loop above takes its final look one slice BEFORE the window closes — at 178 s, not at
      # 180 — and then sleeps. Without this line an app that acknowledged anywhere in that last
      # two seconds, which is exactly where a slow cold launch on a busy clinic Mac lands, would
      # have a WORKING build deleted and a failure written against it. §14.2.3 says "if still
      # present at 180 s", and this is 180 s.
      #
      # It sits immediately before the bootout for the second reason too: everything between a
      # check and the first destructive step is a window in which an acknowledgement can arrive
      # and be ignored, so there is nothing between them but this `say`.
      if [ ! -f "$CANARY" ]; then
        say "${VERSION} acknowledged the canary after ${CANARY_WAITED}s"
        exit 0
      fi

      say "${VERSION} did not poll within ${CANARY_SECONDS}s"

      # ── 8.9a NOTHING IS DESTROYED UNTIL THERE IS SOMETHING TO GO BACK TO (H1) ─────────────
      # The first cut of this rolled back unconditionally: resident aside, resident deleted, then
      # an UNCHECKED `mv "$PREVIOUS"`. With no `.previous` on disk — a Mac whose first swap is
      # this one, or one where step 8.2's `rm -rf` was the last thing to touch that path — the
      # room ended with an empty resident path and launchd pointed at nothing. A bricked room,
      # produced by the code whose whole purpose is to prevent one.
      #
      # A room left running a broken build is recoverable: it thrashes under KeepAlive, the ledger
      # holds after the retry, and a republish reaches it the moment it can poll again. A room
      # with no bundle needs somebody to walk to it. So when there is nothing to restore, the new
      # version stays where it is and the receipt says exactly that.
      #
      # NO `bootout` HAS HAPPENED YET at this point, so the agent is still loaded and still
      # restarting the broken build; there is nothing to bootstrap and nothing to undo.
      if [ ! -d "$PREVIOUS" ]; then
        say "no previous bundle to restore; leaving ${VERSION} in place"
        record swap_failed "\\"the new version did not poll within ${CANARY_SECONDS} s and no previous bundle was present to restore\\""
        /bin/rm -f "$CANARY"
        exit 1
      fi

      # ── 8.9b…8.9h The rollback, in the order §14.2.3 sets out ─────────────────────────────
      # Each step says so in update.log: this runs unattended, minutes after the operator's last
      # keystroke, and the log is the only account of it anybody will ever get.
      say "rolling back to ${OLD_VERSION}"
      /bin/launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null
      say "booted the agent out"

      # The failed bundle is moved aside rather than deleted in place: from here until the restore
      # the resident path is empty, and that is exactly the window the rescue trap covers —
      # resident absent, previous present, put it back.
      /bin/mv -f "$RESIDENT" "${RESIDENT}.failed" 2>/dev/null
      say "moved ${VERSION} aside"

      # ── THE RESTORE IS CHECKED, AND THE FAILED BUNDLE OUTLIVES IT (H1) ───────────────────
      # `.failed` is deleted AFTER the restore succeeds, not before it is attempted. Until that
      # `rm` there are two bundles on disk and the room can end up on either one; the old order
      # had a moment with neither.
      if ! /bin/mv -f "$PREVIOUS" "$RESIDENT"; then
        say "the previous bundle could not be put back — keeping ${VERSION}"
        /bin/mv -f "${RESIDENT}.failed" "$RESIDENT" 2>/dev/null
        record swap_failed "\\"${CANARY_KEPT_REASON}${OLD_VERSION} failed; kept ${VERSION_JSON}\\""
        /bin/rm -f "$CANARY"
        bootstrap_agent
        say "kept ${VERSION} and bootstrapped"
        exit 1
      fi
      say "restored ${OLD_VERSION}"
      /bin/rm -rf "${RESIDENT}.failed"
      say "deleted ${VERSION}"

      record swap_failed "\\"${CANARY_REASON}${OLD_VERSION}\\""
      say "recorded swap_failed"
      /bin/rm -f "$CANARY"
      # H2. The handover is over and the room is back on the old version, so the marker that keeps
      # the staging directory alive has done its job. The app can no longer clear it — the canary
      # it would have acknowledged is gone — and leaving it would park ~90 MB on the Mac until the
      # grace expires half an hour later.
      /bin/rm -f "$HANDOVER_MARKER"
      bootstrap_agent
      say "rolled back to ${OLD_VERSION} and bootstrapped"
      exit 1
      """
  }
}
