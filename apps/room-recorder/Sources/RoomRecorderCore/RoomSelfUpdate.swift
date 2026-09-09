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
  public static let pinnedRequirement =
    "= anchor trusted and certificate leaf = H\"\(pinnedLeafSHA1)\""

  /// §13.3 step 1. Not configurable, and deliberately so (V, 9 September 2026): acceptance forces
  /// a check with `launchctl kickstart -k`, and a knob added here would exist in every clinic room
  /// for ever.
  public static let checkInterval: TimeInterval = 6 * 60 * 60

  /// The LaunchAgent label, stated once. The plist path is derived from it the same way
  /// `install-launch-agent` derives it.
  public static let launchAgentLabel = "com.evenscribe.room-recorder"

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

/// The six outcomes §13.4 lets `last_update_result` hold, and no others.
public enum RoomUpdateOutcome: String, Codable, Equatable, Sendable {
  case ok
  case checksumMismatch = "checksum_mismatch"
  case signatureMismatch = "signature_mismatch"
  case downloadFailed = "download_failed"
  case expandFailed = "expand_failed"
  case swapFailed = "swap_failed"
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

  /// The reason line the poll carries into `last_update_error`.
  ///
  /// THE VERSION TRAVELS AT THE HEAD OF IT, and that is a decision worth naming. §13.4 fixes the
  /// R3 columns and none of them holds the version an update was attempting, while the approved
  /// mockup's sentence names it: "Update to 0.1.8 stopped at 09:14." Rather than add a column
  /// against a ratified list, the version rides in the field §13.4 calls "the reason line" and
  /// `lib/room-install-view.ts` reads it back off the same separator. FLAGGED in the build report.
  public var reportedErrorLine: String? {
    guard let reason, !reason.isEmpty else { return nil }
    return "\(version)\(RoomUpdateResult.errorSeparator)\(reason)"
  }

  /// Kept identical to `UPDATE_ERROR_SEPARATOR` in `lib/room-install-view.ts`.
  public static let errorSeparator = " — "

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
      return .upToDate
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
    do {
      try runner.spawnDetached("/bin/bash", [scriptURL.path])
    } catch {
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
    // The version reaches shell only inside a single-quoted assignment and a JSON string. It comes
    // from the server, so it is quoted like everything else rather than trusted.
    let versionLiteral = quoted(version)

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
      REQUIREMENT=\(requirement)
      DOMAIN="gui/$(/usr/bin/id -u)"

      say() {
        /bin/echo "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ') room-recorder-swap: $*" >> "$LOG" 2>/dev/null
      }

      # §13.3 step 8.6. Written atomically and 0600, because the app root is 0700 and this file is
      # the only thing that will ever say what happened here.
      record() {
        /bin/cat > "${RESULT}.tmp" <<JSON
      {
        "outcome": "$1",
        "version": "${VERSION}",
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

      # ── 8.7 The NEW bundle writes the plist, so a plist change ships with the app (R3-11) ──
      # --root is passed because the plist's own ProgramArguments carry it, and an
      # install-launch-agent that defaulted would point a custom-rooted install at the wrong place.
      if ! "${RESIDENT}/Contents/MacOS/room-recorder" install-launch-agent --root "$ROOT" >> "$LOG" 2>&1; then
        say "install-launch-agent failed — bootstrapping the plist already on disk"
      fi

      # ── 8.8 Start it again ────────────────────────────────────────────────────────────────
      bootstrap_agent
      say "swapped to ${VERSION} and bootstrapped"
      exit 0
      """
  }
}
