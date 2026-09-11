import CryptoKit
import Darwin
import Foundation
import TapeCore

public enum RoomEngineError: Error, LocalizedError, Equatable, Sendable {
  /// The keychain holds no session for this install. The app cannot authenticate and must not
  /// poll — see `RoomEngine.load`.
  case needsEnrolment
  case alreadyRunning
  case roomPaused
  case noActiveSession
  case captureAlreadyActive
  case captureExited(Int32)
  case captureDidNotBecomeDurable
  case pendingUploads(Int)
  case handoverPending
  case sessionEndedByServer
  case retainedArchiveRecoveryPending
  case retainedArchiveRecoveryFailed(String)
  case residentArchivePreflightRequired
  case residentArchivePreflightFailed
  case residentArchivePreflightMismatch
  case residentArchiveRecoveryUnavailable
  case residentArchiveRuntimeUnavailable
  case residentArchiveMissingRoomID
  case residentArchiveDidNotBecomeDurable
  case residentArchiveCaptureStopped
  case invalidManifestMetadata
  case io(String)

  public var errorDescription: String? {
    switch self {
    case .needsEnrolment:
      return "no room session in the keychain; this install is not enrolled"
    case .alreadyRunning: return "another room-recorder is already running under this root"
    case .roomPaused: return "room_paused"
    case .noActiveSession: return "no_active_session"
    case .captureAlreadyActive: return "capture_already_active"
    case .captureExited(let status): return "tapewriter exited with status \(status)"
    case .captureDidNotBecomeDurable:
      return "tapewriter did not produce durable index growth"
    case .pendingUploads(let count): return "\(count) piece(s) remain pending"
    case .handoverPending: return "browser_handover_pending"
    case .sessionEndedByServer: return "session_ended_by_server"
    case .retainedArchiveRecoveryPending: return "archive_recovery_pending"
    case .retainedArchiveRecoveryFailed(let reason): return reason
    case .residentArchivePreflightRequired: return "resident_archive_preflight_required"
    case .residentArchivePreflightFailed: return "resident_archive_preflight_failed"
    case .residentArchivePreflightMismatch: return "resident_archive_preflight_mismatch"
    case .residentArchiveRecoveryUnavailable: return "resident_archive_recovery_unavailable"
    case .residentArchiveRuntimeUnavailable: return "resident_archive_runtime_unavailable"
    case .residentArchiveMissingRoomID: return "resident_archive_missing_room_id"
    case .residentArchiveDidNotBecomeDurable: return "resident_archive_capture_not_durable"
    case .residentArchiveCaptureStopped: return "resident_archive_capture_stopped"
    case .invalidManifestMetadata: return "spool manifest metadata is invalid"
    case .io(let message): return message
    }
  }
}

public enum RoomEnginePhase: Equatable, Sendable {
  case ready
  case recording
  case paused
  case ending
  case failed
  case superseded
}

public enum RoomCommandDecision: Equatable, Sendable {
  case start
  case acknowledgeCurrentState
  case resume
  case pause
  case end
  case refuse(String)
}

public enum RoomCommandDecider {
  public static func decide(
    kind: BenchCommandKind,
    phase: RoomEnginePhase,
    overridePause: Bool = false
  ) -> RoomCommandDecision {
    switch kind {
    case .startDay:
      switch phase {
      case .recording: return .acknowledgeCurrentState
      case .paused: return overridePause ? .resume : .refuse("room_paused")
      case .ending: return .refuse("ending_in_progress")
      case .superseded: return .refuse("superseded")
      case .ready, .failed: return .start
      }
    case .pauseDay:
      if phase == .paused { return .acknowledgeCurrentState }
      return phase == .recording ? .pause : .refuse("not_recording")
    case .resumeDay:
      if phase == .recording { return .acknowledgeCurrentState }
      return phase == .paused ? .resume : .refuse("not_paused")
    case .endDay:
      return phase == .recording || phase == .paused || phase == .failed
        ? .end : .refuse("no_active_session")
    }
  }
}

enum RoomSessionBoundary {
  static func retainedPieceEnd(
    currentSessionID: String?, nextSessionID: String?, pieceEndedAt: Date?
  ) -> Date? {
    currentSessionID == nextSessionID ? pieceEndedAt : nil
  }
}

public enum RoomManifestBenchAdapter {
  public static func piece(manifestBytes: Data) throws -> BenchPiece {
    let manifest = try RoomPieceManifest.decodeJSON(manifestBytes)
    guard
      let object = try JSONSerialization.jsonObject(with: manifestBytes) as? [String: Any],
      let startedAt = object["started_at"] as? String,
      let endedAt = object["ended_at"] as? String,
      let durationMS = Int(exactly: manifest.durationMS),
      let gapBeforeMS = Int(exactly: manifest.gapBeforeMS)
    else {
      throw RoomEngineError.invalidManifestMetadata
    }
    return BenchPiece(
      sessionID: manifest.sessionID,
      index: manifest.index,
      contentType: manifest.contentType,
      startedAt: startedAt,
      endedAt: endedAt,
      durationMS: durationMS,
      sizeBytes: manifest.sizeBytes,
      gapBeforeMS: gapBeforeMS,
      source: .primary
    )
  }
}

public protocol RoomEngineRemote: Sendable {
  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse
  func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse
  func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws
    -> BenchOKResponse
  func pollCommands(
    tabID: String,
    previousPollAt: String?,
    recordingSessionID: String?,
    paused: Bool,
    primaryLevels: BenchLevelPair?,
    install: InstallPollFields?
  ) async throws -> CommandPollResponse
  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse
  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws
    -> ImmutablePieceUploadResult
  /// Build R3 (§13.4). `nil` for every answer that is not a 200 — see `BenchClient.fetchRelease`.
  func fetchRelease(channel: String) async -> RoomReleaseDescriptor?
}

extension RoomEngineRemote {
  /// A REMOTE THAT DOES NOT SPEAK R3 NEVER OFFERS AN UPDATE, which is the safe answer and the one
  /// that keeps every existing test double compiling unchanged. `BenchClient` provides the real
  /// implementation and its witness wins; nothing else in this package needs to.
  public func fetchRelease(channel: String) async -> RoomReleaseDescriptor? { nil }
}

extension BenchClient: RoomEngineRemote {}

/// Adapts whatever remote the engine was built with to `RoomSelfUpdate`'s narrow seam, so
/// `RoomUpdater` depends on one method and not on the whole bench wire.
struct RoomEngineReleaseFetcher: RoomReleaseFetching {
  let remote: any RoomEngineRemote
  func fetchRelease(channel: String) async -> RoomReleaseDescriptor? {
    await remote.fetchRelease(channel: channel)
  }
}

/// 0.1.17 — which file the engine's install id came from.
enum RoomInstallIDSource: Equatable, Sendable {
  /// `room-session.json` (or the keychain record it was migrated from), agreeing with config.json
  /// or with config.json naming none.
  case sessionFile
  /// config.json: no session record, or the record disagreed and lost.
  case configuration
}

/// What `run()` decided the process should do when it returned (§13.3 steps 7 and 9).
public enum RoomEngineExit: Equatable, Sendable {
  /// The ordinary stop: retired, superseded, cancelled. Exit 0 and stay stopped.
  case stopped
  /// A swap script now owns the bundle and the restart. Exit 64 (R3-4).
  case handedOverToUpdate(version: String)
}

public protocol RoomCaptureProcess: AnyObject, Sendable {
  var isRunning: Bool { get }
  var terminationStatus: Int32? { get }
  func interrupt()
  func waitUntilExit()
}

public protocol RoomCaptureLaunching: Sendable {
  func launch(executable: URL, outputDirectory: URL, deviceUID: String, logURL: URL) throws
    -> any RoomCaptureProcess
}

public struct RoomResidentCaptureStartContext: Equatable, Sendable {
  public enum Trigger: Equatable, Sendable {
    case startDay(commandID: String)
    case resumeDay(commandID: String)
    case reconciliation
  }

  public let roomID: String
  public let sessionID: String
  public let nextPrimaryIndex: Int
  public let nextBackupIndex: Int?
  public let trigger: Trigger

  public init(
    roomID: String,
    sessionID: String,
    nextPrimaryIndex: Int,
    nextBackupIndex: Int? = nil,
    trigger: Trigger
  ) {
    self.roomID = roomID
    self.sessionID = sessionID
    self.nextPrimaryIndex = nextPrimaryIndex
    self.nextBackupIndex = nextBackupIndex
    self.trigger = trigger
  }
}

public enum RoomResidentCaptureStopReason: Equatable, Sendable {
  case startupFailed
  case pause(commandID: String)
  case end(commandID: String)
  case superseded
  case cancelled
  case serverEnded
}

public struct RoomResidentFinalizationContext: Equatable, Sendable {
  public let roomID: String
  public let sessionID: String
  public let nextPrimaryIndex: Int
  public let nextBackupIndex: Int?

  public init(
    roomID: String,
    sessionID: String,
    nextPrimaryIndex: Int,
    nextBackupIndex: Int? = nil
  ) {
    self.roomID = roomID
    self.sessionID = sessionID
    self.nextPrimaryIndex = nextPrimaryIndex
    self.nextBackupIndex = nextBackupIndex
  }
}

public protocol RoomResidentCaptureOwning: AnyObject, Sendable {
  var isActive: Bool { get }
  /// True while a started generation has not yet proved its durable final boundary.
  var requiresFinalization: Bool { get }
  var nextPrimaryIndex: Int { get }
  var nextBackupIndex: Int? { get }
  /// A retained correctness failure that cannot be healed by retrying delivery.
  var terminalFailure: String? { get }
  /// The exact session for which delivery durably observed that the server had already ended it.
  var serverEndedSessionID: String? { get }
  /// Authenticated capture authority that has no converged local terminal control.
  var retainedUnfinalizedSessionID: String? { get }
  /// Returns only after this generation has authenticated durable tape and index growth.
  func start(context: RoomResidentCaptureStartContext) throws
  /// Advances local derivation, delivery, health, and unexpected-stop detection off the callback.
  func service() async throws
  /// Idempotently stops the producer, drains the writer, and durably closes the boundary.
  /// A failed call must retain `requiresFinalization` so a later command can retry.
  func stopAndFinalize(reason: RoomResidentCaptureStopReason) throws
  /// Durably reserves every final derivative range after the capture boundary is closed.
  func reserveFinalRanges(context: RoomResidentFinalizationContext) async throws
  /// Returns only after every reserved final range has its immutable delivery witnesses.
  func verifyFinalRanges(context: RoomResidentFinalizationContext) async throws
  /// Clears only the in-memory startup signal after local finalization has converged.
  func clearServerEndedSessionID(_ sessionID: String)
  /// Promotes retained capture authority after an authoritative no-active server response.
  func markRetainedUnfinalizedSessionAsServerEnded(_ sessionID: String) throws
  func currentLevels() -> BenchLevelPair?
}

extension RoomResidentCaptureOwning {
  public var terminalFailure: String? { nil }
  public var serverEndedSessionID: String? { nil }
  public var retainedUnfinalizedSessionID: String? { nil }
  public func clearServerEndedSessionID(_: String) {}
  public func markRetainedUnfinalizedSessionAsServerEnded(_: String) throws {
    throw RoomEngineError.residentArchiveRuntimeUnavailable
  }
}

public struct RoomResidentRuntime: Sendable {
  public let capture: any RoomResidentCaptureOwning
  public let controlJournal: any RoomControlJournalOwning

  public init(
    capture: any RoomResidentCaptureOwning,
    controlJournal: any RoomControlJournalOwning
  ) {
    self.capture = capture
    self.controlJournal = controlJournal
  }
}

public struct RoomResidentRuntimeContext: Sendable {
  public let archiveRootURL: URL
  public let roomID: String
  public let archiveDeliveryWire: (any ArchiveDeliveryWire)?

  public init(
    archiveRootURL: URL,
    roomID: String,
    archiveDeliveryWire: (any ArchiveDeliveryWire)? = nil
  ) {
    self.archiveRootURL = archiveRootURL
    self.roomID = roomID
    self.archiveDeliveryWire = archiveDeliveryWire
  }
}

public typealias RoomResidentRuntimeFactory =
  @Sendable (
    _ configuration: RoomConfiguration,
    _ context: RoomResidentRuntimeContext
  ) throws -> RoomResidentRuntime

public struct FoundationRoomCaptureLauncher: RoomCaptureLaunching {
  public init() {}

  public func launch(
    executable: URL,
    outputDirectory: URL,
    deviceUID: String,
    logURL: URL
  ) throws -> any RoomCaptureProcess {
    let logFD = open(
      logURL.path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC | O_NOFOLLOW,
      S_IRUSR | S_IWUSR)
    guard logFD >= 0 else {
      throw RoomEngineError.io("cannot open capture log: \(String(cString: strerror(errno)))")
    }
    let log = FileHandle(fileDescriptor: logFD, closeOnDealloc: true)
    let process = Process()
    process.executableURL = executable
    process.arguments = ["record", "--out", outputDirectory.path, "--device", deviceUID]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = log
    process.standardError = log
    do {
      try process.run()
    } catch {
      try? log.close()
      throw error
    }
    return FoundationRoomCaptureProcess(process: process, log: log)
  }
}

private final class FoundationRoomCaptureProcess: RoomCaptureProcess, @unchecked Sendable {
  private let process: Process
  private let log: FileHandle

  init(process: Process, log: FileHandle) {
    self.process = process
    self.log = log
  }

  var isRunning: Bool { process.isRunning }
  var terminationStatus: Int32? { process.isRunning ? nil : process.terminationStatus }
  func interrupt() { if process.isRunning { process.interrupt() } }
  func waitUntilExit() {
    FoundationProcessWaiter.waitUntilExit(process)
    try? log.close()
  }
}

enum FoundationProcessWaiter {
  static func waitUntilExit(_ process: Process, pollInterval: TimeInterval = 0.01) {
    while process.isRunning {
      Thread.sleep(forTimeInterval: pollInterval)
    }
  }
}

public actor RoomEngine {
  public static var defaultRootURL: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(
        "Library/Application Support/EvenScribe/RoomRecorder", isDirectory: true)
  }

  private struct Segment {
    let id: String
    let directory: URL
    let pcmURL: URL
    let indexURL: URL
    let process: any RoomCaptureProcess
    var nextSample: Int64
    var nextPieceIndex: Int
    var initialGapBeforeMS: Int64
  }

  private struct CommandResult: Sendable {
    let ok: Bool
    let sessionID: String?
    let error: String?
  }

  private let persistence: RoomPersistence
  private let configuration: RoomConfiguration
  private let remote: any RoomEngineRemote
  private let captureLauncher: any RoomCaptureLaunching
  private let pieceRunner: any RoomPieceProcessRunning
  private let spool: RoomPieceSpool
  private let capturesURL: URL
  private let instanceLock: RoomEngineInstanceLock
  private let retainedArchiveRecovery: (any RoomRetainedArchiveRecovering)?
  private let residentRuntimeFactory: RoomResidentRuntimeFactory?
  /// Release B1. Where `canary passed for <version>` goes. Defaulted to the same stderr line every
  /// other engine message uses — launchd routes it to `launchd.log`, which is where §14.4's
  /// acceptance reads it — and injected in tests, which cannot capture a process-wide descriptor
  /// without taking every other test's output with it.
  private let log: @Sendable (String) -> Void
  private var residentCaptureOwner: (any RoomResidentCaptureOwning)?
  private var residentControlJournal: (any RoomControlJournalOwning)?
  private var residentRuntimeRoomID: String?
  private var residentControlCommands: [String: RoomRecoveredControlCommand]
  private var unacknowledgeableControlCommands: Set<String> = []
  private var phase: RoomEnginePhase = .ready
  private var sessionID: String?
  private var nextPieceIndex = 0
  private var nextBackupPieceIndex = 0
  private var roomID: String?
  private var capture: Segment?
  private var previousPollAt: String?
  private var completedCommands: [String: CommandResult] = [:]
  private var lastError: String?
  private var lastPieceEndedAt: Date?
  private var needsActiveReconciliation = false
  private var reconciledServerStateKnown = false
  private var reconciledServerSessionID: String?
  private var reconciledServerSessionStatus: BenchSessionStatus?
  /// `var` since 0.1.17, for one reason: the single RETIRED retry re-points it (see `installID`).
  private var listenerTabID: String
  /// The server-minted install id from the keychain, when this build is enrolled (§5.3). Nil for
  /// an unenrolled build, and nil is what keeps the seven fields off the wire entirely.
  ///
  /// `var` since 0.1.17, and it changes at most once in a process's life: `retryAfterRetired`.
  private var installID: String?
  /// 0.1.17 — which file `installID` came from. Only a session-file id earns the RETIRED retry.
  private var installIDSource: RoomInstallIDSource
  /// 0.1.17 — the session record read at launch, kept so a successful retry can write the file
  /// back from memory. The file is never read again after the retry discards it.
  private let enrolmentRecord: RoomKeychainRecord?
  /// 0.1.17 — set by the one RETIRED retry. Never cleared, so there can never be a second.
  private var retiredRetryTaken = false
  /// 0.1.17 — a retry is in flight: the next poll that returns proves config's id is live.
  private var retiredRetryAwaitingPoll = false
  /// The durable sample index at the previous poll. §5.5 defines `tape_advancing` as this index
  /// GROWING, so one reading is never enough — the first poll of a session reports false, and
  /// that is correct rather than pessimistic: nothing has been shown to advance yet.
  private var lastDurableSampleIndex: Int64?
  /// §4.5 rule 3 — this install has been superseded or retired and must never poll again.
  private var retiredByServer = false

  // ─── BUILD R3 (§13.3) ──────────────────────────────────────────────────────────────────────
  /// Injected, and nil on every path that is not the resident app. A `swift run` binary, a test
  /// and an unbundled build all have no bundle to replace and must never try.
  private let updater: RoomUpdater?
  private var updateSchedule = RoomUpdateSchedule()
  /// Set once, by the check that spawned the swap script. `run()` returns on the next line after
  /// it is set, and the CLI turns it into exit 64.
  private var handedOverToUpdateVersion: String?
  /// R3-10 — a session ended since the last update check, so a deferred check is due NOW rather
  /// than in six hours. Set on the transition, cleared by the check that consumes it.
  private var sessionEndedSinceUpdateCheck = false
  /// §13.3 step 10. Read once at startup, carried until a poll has actually delivered it, and
  /// only then is the file deleted. Held rather than deleted-on-read because the app that would
  /// have reported it is the one that just started: a crash between the read and the first
  /// successful poll would otherwise lose the only record that an update failed.
  private var pendingUpdateResult: RoomUpdateResult?
  /// The phase the previous poll reported, so a session ending is observable as a transition.
  private var previousSessionWasOpen = false
  private var retainedArchiveRecoveryTask: Task<Void, Never>?
  private var retainedArchiveRecoveryState: RoomRetainedArchiveRecoveryState?

  /// The configuration an engine starts from: what is on disk, plus the session from the keychain.
  ///
  /// ─── EVERY CLIENT MUST BE BUILT FROM THIS, NOT FROM `loadConfiguration()` ────────────────
  /// V's ruling of 8 September 2026 put the keychain read in `RoomEngine`. The first attempt put
  /// it inside `load` only, and that was not enough: the CLI's `run` builds a `BenchClient` of its
  /// own for the retained-archive wire and passed `remoteFactory: { _ in bench }`. The factory
  /// IGNORES ITS ARGUMENT, so the hydrated configuration `load` handed it was discarded and the
  /// app polled with the same unauthenticated client as before — `missingSessionCookie`, again,
  /// from a build that was supposed to have fixed it.
  ///
  /// Exposing the hydration is what makes that impossible: there is one place a starting
  /// configuration comes from, it always carries the session, and a caller that wants a client
  /// has to come through here to get a configuration at all.
  ///
  /// THE SESSION IS IN MEMORY ONLY — `saveConfiguration` strips it on the way to disk.
  public static func startingConfiguration(
    rootURL: URL = defaultRootURL,
    /// Nil means the real one: `RoomSessionStore.load(root:)`. It cannot be spelled as a default
    /// value because a default cannot see another parameter, and this one needs `rootURL`.
    enrolmentReader: (@Sendable () -> RoomKeychainRecord?)? = nil
  ) throws -> RoomConfiguration {
    let persistence = RoomPersistence(root: rootURL)
    var configuration = try persistence.loadConfiguration()
    let enrolment = (enrolmentReader ?? { RoomSessionStore.load(root: rootURL) })()
    guard let session = enrolment?.session, !session.isEmpty else {
      // REFUSE LOUDLY AND STOP. Polling unauthenticated in a loop cannot succeed, buries the real
      // cause under a retry backoff, and on the server looks like a room that is merely offline.
      try? persistence.saveStatus(
        RoomRecorderStatus(
          state: .needsEnrol,
          sessionID: nil,
          pendingPieceCount: 0,
          lastError: "no session in room-session.json or the keychain; this install is not enrolled",
          updatedAt: Date()))
      FileHandle.standardError.write(
        Data(
          """
          room-recorder: no room session in room-session.json or the keychain (service \
          \(RoomKeychain.service)). This install cannot authenticate and will not poll. \
          Re-run the install command for this room from /admin/bench — enrolment is what writes \
          the session — or run the migration command for this room if it enrolled before 0.1.13.

          """.utf8))
      throw RoomEngineError.needsEnrolment
    }
    configuration.etaRoomSession = session
    return configuration
  }

  public static func load(
    rootURL: URL = defaultRootURL,
    /// Where the session comes from. Injected so a test can prove the read without touching the
    /// real login keychain — the live room's session lives in it and must not be disturbed. Nil
    /// means `RoomSessionStore.load(root:)`, which needs the root a default value cannot see.
    enrolmentReader: (@Sendable () -> RoomKeychainRecord?)? = nil,
    remoteFactory: @Sendable (RoomConfiguration) -> any RoomEngineRemote = {
      BenchClient(configuration: $0)
    },
    captureLauncher: any RoomCaptureLaunching = FoundationRoomCaptureLauncher(),
    pieceRunner: any RoomPieceProcessRunning = FoundationPieceProcessRunner(),
    retainedArchiveRecovery: (any RoomRetainedArchiveRecovering)? = nil,
    residentRuntimeFactory: RoomResidentRuntimeFactory? = nil,
    /// Build R3. Nil disables self-update entirely, which is what every test and every unbundled
    /// build wants. The default builds one only when this process is actually running from a
    /// `.app` with a version — see `defaultUpdater`.
    updaterFactory: @Sendable (RoomConfiguration, any RoomEngineRemote, URL) -> RoomUpdater? = {
      RoomEngine.defaultUpdater(configuration: $0, remote: $1, rootURL: $2)
    },
    /// Release B1 (§14.2 step 5). Stderr by default, which launchd writes into `launchd.log`.
    log: @escaping @Sendable (String) -> Void = { message in
      FileHandle.standardError.write(Data("room-recorder: \(message)\n".utf8))
    }
  ) async throws -> RoomEngine {
    let persistence = RoomPersistence(root: rootURL)
    let configuration = try startingConfiguration(rootURL: rootURL, enrolmentReader: enrolmentReader)
    let eligibility = configuration.residentArchiveEligibility(archiveRootURL: persistence.root)
    switch eligibility {
    case .disabled, .eligible:
      break
    case .missingPreflightReceipt:
      throw RoomEngineError.residentArchivePreflightRequired
    case .unsuccessfulPreflightReceipt:
      throw RoomEngineError.residentArchivePreflightFailed
    case .preflightReceiptMismatch:
      throw RoomEngineError.residentArchivePreflightMismatch
    }
    if eligibility == .eligible {
      guard let retainedArchiveRecovery, retainedArchiveRecovery.encoderCapable else {
        throw RoomEngineError.residentArchiveRecoveryUnavailable
      }
      guard residentRuntimeFactory != nil else {
        throw RoomEngineError.residentArchiveRuntimeUnavailable
      }
    }
    let lock = try RoomEngineInstanceLock(root: persistence.root)
    let captures = persistence.root.appendingPathComponent("captures", isDirectory: true)
    try createPrivateDirectory(captures)
    let spoolURL = persistence.root.appendingPathComponent("spool", isDirectory: true)
    try createPrivateDirectory(spoolURL)
    let spool = try RoomPieceSpool(rootURL: spoolURL)
    let remote = remoteFactory(configuration)
    return RoomEngine(
      persistence: persistence,
      configuration: configuration,
      remote: remote,
      captureLauncher: captureLauncher,
      pieceRunner: pieceRunner,
      spool: spool,
      capturesURL: captures,
      instanceLock: lock,
      retainedArchiveRecovery: retainedArchiveRecovery,
      residentRuntimeFactory: eligibility == .eligible ? residentRuntimeFactory : nil,
      updater: updaterFactory(configuration, remote, persistence.root),
      log: log
    )
  }

  /// Build R3 — a self-updater, but ONLY when there is something to update.
  ///
  /// ─── THE THREE GUARDS, AND EACH ONE IS A REAL CASE ────────────────────────────────────────
  /// A `swift run` binary has no `.app` and no `CFBundleShortVersionString`: it has no release
  /// identity, must not claim one, and must never swap a bundle it is not running from. A test
  /// harness is the same shape. And a bundle whose path does not end in `.app` is not a thing
  /// launchd starts from a plist, so replacing it would achieve nothing and could destroy
  /// something. In all three, nil — the app polls and records exactly as it always did.
  public static func defaultUpdater(
    configuration: RoomConfiguration,
    remote: any RoomEngineRemote,
    rootURL: URL
  ) -> RoomUpdater? {
    guard let version = BuildInfo.appVersion, !version.isEmpty else { return nil }
    let bundle = Bundle.main.bundleURL.standardizedFileURL
    guard bundle.pathExtension == "app" else { return nil }
    return RoomUpdater(
      rootURL: rootURL,
      residentBundleURL: bundle,
      runningVersion: version,
      channel: configuration.updateChannel,
      fetcher: RoomEngineReleaseFetcher(remote: remote)
    )
  }

  private init(
    persistence: RoomPersistence,
    configuration: RoomConfiguration,
    remote: any RoomEngineRemote,
    captureLauncher: any RoomCaptureLaunching,
    pieceRunner: any RoomPieceProcessRunning,
    spool: RoomPieceSpool,
    capturesURL: URL,
    instanceLock: RoomEngineInstanceLock,
    retainedArchiveRecovery: (any RoomRetainedArchiveRecovering)?,
    residentRuntimeFactory: RoomResidentRuntimeFactory?,
    updater: RoomUpdater? = nil,
    log: @escaping @Sendable (String) -> Void = { message in
      FileHandle.standardError.write(Data("room-recorder: \(message)\n".utf8))
    }
  ) {
    self.persistence = persistence
    self.configuration = configuration
    self.remote = remote
    self.captureLauncher = captureLauncher
    self.pieceRunner = pieceRunner
    self.spool = spool
    self.capturesURL = capturesURL
    self.instanceLock = instanceLock
    self.retainedArchiveRecovery = retainedArchiveRecovery
    self.residentRuntimeFactory = residentRuntimeFactory
    self.updater = updater
    self.log = log
    // §13.3 step 10, at the earliest moment there is anywhere to put it. The swap script wrote
    // this file and then started this process; the version and build sha this copy reports on its
    // first poll are the other half of the same evidence, and the fleet card showing both change
    // together is the ONLY proof the update landed.
    pendingUpdateResult = RoomUpdateResult.read(root: persistence.root)

    // ─── DO NOT DELETE STAGING WHILE A HANDOVER IS IN FLIGHT (Fix 1, F3) ─────────────────────
    //
    // This line used to be unconditional, and it was a race the swap script could lose. The app
    // exits 64; launchd restarts it AT ONCE — `ThrottleInterval` is a minimum interval between
    // *starts* and this process had been running for hours, so there is no throttle left to spend;
    // the new process reaches here and deletes `update-staging`, which is where `swap.sh` and the
    // expanded bundle the script is about to move both live.
    //
    // The marker says "a handover is in flight". It is cleared when the outcome is read, and it
    // goes stale after `handoverGrace` so a script that died without writing a result cannot leave
    // ~90 MB parked on a clinic Mac for ever.
    let handover = RoomUpdateHandover.read(root: persistence.root)
    if roomUpdateMayClearStaging(handover: handover, now: Date()) {
      // Whatever the last attempt left staged is dead weight — the bundle it held has either been
      // moved into place or been abandoned.
      try? FileManager.default.removeItem(at: RoomSelfUpdate.stagingURL(root: persistence.root))
      // A stale marker goes with it; keeping it would suppress the next sweep too.
      if handover != nil { RoomUpdateHandover.clear(root: persistence.root) }
    }
    // ─── THE RECEIPT IS NO LONGER THE HANDOVER'S END (Release B1, B1-D5) ────────────────────
    //
    // This used to clear the marker on any receipt, on the reasoning that a script that got far
    // enough to write one had finished. Under the launch canary it has not: the script writes
    // `record ok null` and then stays alive for up to three minutes watching whether this very
    // process can poll, and it is still running out of the staging directory the whole time.
    // Clearing here would have unsuppressed the sweep above on the NEXT restart inside that
    // window — the F3 race, reopened by the thing that made the script outlive the swap.
    //
    // The marker is cleared where the handover actually ends now: at the acknowledgement, on the
    // first successful poll (`roomCanaryAcknowledge`). It still goes stale after `handoverGrace`,
    // so a script that died without either outcome cannot wedge staging for ever.

    // ─── COUNT A FAILED SWAP, AND ONLY A FAILED SWAP (Fix 1 F2, corrected by Fix 2 G2) ──────
    //
    // `swap_failed` IS THE ONLY OUTCOME THE SWAP SCRIPT WRITES, and the only failure whose author
    // cannot count itself: the process that attempted it exited 64 and is gone, so THIS one, its
    // replacement, is the only thing left that can. Every other outcome — checksum, signature,
    // download, expand, version — is written by `stop()`, which counts it in the same breath.
    //
    // ─── WHY THE TEST IS NOT `!= .ok` ANY MORE ────────────────────────────────────────────
    // It was, and that made the ledger over-count. The receipt is deleted only after a poll has
    // actually carried it (see `run()`), so a process that fails to download and then restarts
    // before its next poll — a reboot, a crash, or simply the network outage that caused the
    // `download_failed` in the first place — arrived back here with its own receipt still on disk
    // and counted the same failure a second time. Two counts is the hold. A room could be held
    // after ONE real failure, having never had the retry the design promises it.
    //
    // Under-counting a swap failure loops a room; over-counting a download failure strands one.
    // The narrow test is what makes each failure counted exactly once, by whoever can see it.
    // The `.swapFailed` test lives inside `roomUpdateCountStartupReceipt`, stated once, so the rule
    // is testable without standing a whole engine up.
    if let ledger = roomUpdateCountStartupReceipt(
      root: persistence.root, receipt: pendingUpdateResult, now: Date()),
      let receipt = pendingUpdateResult
    {
      // SAY SO ON THE CARD when the hold begins. The row already keeps the reason for ever (the
      // update columns COALESCE), but "and it has stopped trying" is a fact this app measured by
      // counting, and an operator reading the row deserves it rather than having to infer it from
      // a version that stops changing.
      if ledger.holdUntil != nil, let reason = receipt.reason {
        pendingUpdateResult = RoomUpdateResult(
          outcome: receipt.outcome,
          version: receipt.version,
          reason: reason
            + " This Mac has stopped retrying that version; publish a different one to clear it.",
          at: receipt.at)
      }
    }
    residentCaptureOwner = nil
    residentControlJournal = nil
    residentControlCommands = [:]
    // §5.5: install_id is "read from the enrolment record". That record is the authority, not
    // config.json — a config copied between Macs would otherwise carry an install id that belongs
    // to another machine, and the fleet card would show one Mac's facts under another's row.
    // config.json's copy is a convenience for `status`, never the source.
    //
    // ─── B1.5: THIS WAS A SECOND KEYCHAIN READ, AND IT WOULD HAVE HUNG TOO ──────────────────
    // `startingConfiguration` is not the only place the app asked securityd. This line ran on
    // every launch, inside `init`, and on an unmigrated room it would have blocked exactly the way
    // 0.1.11 did — after the session had already been read successfully from the file. B1.5-D2 is
    // "no code path may block on securityd", and this is one of the paths. It reads the store now,
    // which answers from the file and never waits.
    //
    // ─── 0.1.17: WHEN THE TWO DISAGREE, CONFIG WINS ─────────────────────────────────────────
    // The paragraph above made the enrolment record the authority, and on 11 Sep that record was
    // the stale one: a paste wrote a new id into config.json and left an older install's
    // `room-session.json` in place. See `resolveInstallIdentity`.
    let enrolled = RoomSessionStore.load(root: persistence.root, log: { _ in })
    let identity = Self.resolveInstallIdentity(
      record: enrolled, configuration: configuration, root: persistence.root, log: log)
    installID = identity.installID
    installIDSource = identity.source
    enrolmentRecord = enrolled
    // §4.5 rule 1: the app writes `app_<install_id>` and no other form.
    listenerTabID =
      installID.map { "app_\($0)" }
      ?? configuration.tabID
      ?? "native_\(UUID().uuidString.prefix(8).lowercased())"
  }

  /// §5.5 — the durable sample index, from whichever capture path is running.
  ///
  /// The plain capture segment's `nextSample` is the index for the ordinary path; the resident
  /// owner's primary index is the same measurement on the retained-archive path. Nil when nothing
  /// is capturing, which reports as "not advancing" rather than as an absent field: an idle room
  /// genuinely is not advancing, and that is a fact rather than a gap.
  private func currentDurableSampleIndex() -> Int64? {
    if let capture {
      // ─── NOT `segment.nextSample` ─────────────────────────────────────────────────────────
      // `nextSample` is the PIECE-CUTTING CURSOR. It is assigned in `publishAvailable` when a
      // piece is encoded, which is once every five minutes (§10.7's wire format). Comparing it
      // between polls four seconds apart therefore reports "not advancing" on almost every poll,
      // and §6 step 4 — which needs TWO CONSECUTIVE polls — could essentially never turn done.
      // Home Office recorded for ten minutes, wrote 20 MB of durable audio, and the fleet card
      // still read `tape=false/streak=0`.
      //
      // The durable frontier is the index tapewriter appends to. A record lands there only after
      // its audio is durably on disk, so the file growing IS the durable sample index growing —
      // §5.5's signal, measured rather than inferred, and one `stat` rather than re-reading a
      // file that reaches tens of megabytes over a clinic day.
      if let durable = try? regularFileSizeIfPresent(capture.indexURL), durable > 0 {
        return durable
      }
      // No index yet: capture has started but nothing is durable. Fall back to the cursor so a
      // freshly cut piece still counts rather than reading as a gap.
      return capture.nextSample
    }
    if let owner = residentCaptureOwner, owner.isActive { return Int64(owner.nextPrimaryIndex) }
    return nil
  }

  /// 0.1.17 — which install id this process polls as, and where it came from.
  ///
  /// ─── THE 11 SEP LOOP ────────────────────────────────────────────────────────────────────
  /// Bootstrap installs 0.1.8. Its enrol writes the new id into config.json and knows nothing of
  /// `room-session.json`, so a file an EARLIER install left behind survives it. 0.1.8 self-updates;
  /// the new build reads that file, which used to outrank config.json, polls as a retired id, takes
  /// a 409 and stops for ever. Four pastes on Home Office died exactly that way.
  ///
  /// So a disagreement means the file is stale. config.json is what the last enrol wrote, on every
  /// build that has an enrol at all; the file is only what the last build to SAVE a session wrote.
  /// Config's id is used, and the file is rewritten with it — the token kept, since a room session
  /// is the room's and not the install's (the 11 Sep hand fix changed the id alone, and the room
  /// came back) — so the next launch finds them agreeing.
  ///
  /// When they agree, or there is no record, or config.json names no install, nothing changes.
  static func resolveInstallIdentity(
    record: RoomKeychainRecord?,
    configuration: RoomConfiguration,
    root: URL,
    log: (String) -> Void
  ) -> (installID: String?, source: RoomInstallIDSource) {
    guard let record else { return (configuration.installID, .configuration) }
    guard let configured = configuration.installID, configured != record.installID else {
      return (record.installID, .sessionFile)
    }
    var rewritten = record
    rewritten.installID = configured
    do {
      try RoomSessionStore.save(rewritten, root: root)
      log(
        "room session install id \(record.installID) disagrees with config \(configured); config wins, session file rewritten"
      )
    } catch {
      // Still config's id. A file that could not be rewritten is found disagreeing again on the
      // next launch and gets the same answer; polling as the stale id is the one wrong answer.
      log(
        "room session install id \(record.installID) disagrees with config \(configured); config wins, session file NOT rewritten: \(error.localizedDescription)"
      )
    }
    return (configured, .configuration)
  }

  /// 0.1.17 — the single retry a RETIRED answer earns, or nil for "stop as before".
  ///
  /// ONLY FOR AN ID THAT CAME FROM THE SESSION FILE, and only when config.json — read NOW, not the
  /// copy from launch — names a different one. After `resolveInstallIdentity` that is the case
  /// launch could not see: a re-enrol that rewrote config.json while this process was running.
  /// When the file and config.json still agree, the server has refused the id both of them name;
  /// the Mac really has lost the room, and nothing is discarded.
  ///
  /// CANNOT LOOP. `retiredRetryTaken` is set before anything else and never cleared, and the id
  /// retried comes from config.json. The session file is read once more, by `discard`, only to
  /// check it still names the refused id before removing it — never to choose the next id.
  private func retryAfterRetired() -> String? {
    guard !retiredRetryTaken, installIDSource == .sessionFile, let refused = installID else {
      return nil
    }
    retiredRetryTaken = true
    let configured = (try? persistence.loadConfiguration())?.installID ?? configuration.installID
    guard let configured, configured != refused else {
      log("poll refused (409 RETIRED) for install \(refused); config.json names no other install, not retrying")
      return nil
    }
    let discarded = RoomSessionStore.discard(root: persistence.root, ifInstallID: refused)
    installID = configured
    listenerTabID = "app_\(configured)"
    installIDSource = .configuration
    retiredRetryAwaitingPoll = true
    log(
      "poll refused (409 RETIRED) for install \(refused) from room-session.json; "
        + (discarded ? "file discarded" : "file left alone: it no longer names that install")
        + "; retrying once as config install \(configured)")
    return configured
  }

  /// 0.1.17 — the retry's poll came back, so config's id is live. If the retry discarded the file
  /// and nothing has written one since, write it from memory: without it the next launch would
  /// find no file, fall back to a keychain it cannot read, and stop at `needs_enrol`.
  private func retryAfterRetiredAccepted() {
    guard retiredRetryAwaitingPoll, let accepted = installID else { return }
    retiredRetryAwaitingPoll = false
    let file = RoomSessionStore.url(root: persistence.root)
    guard !FileManager.default.fileExists(atPath: file.path), var record = enrolmentRecord else {
      log("retry as install \(accepted) accepted")
      return
    }
    record.installID = accepted
    record.session = configuration.etaRoomSession ?? record.session
    do {
      try RoomSessionStore.save(record, root: persistence.root)
      log("retry as install \(accepted) accepted; session file rewritten")
    } catch {
      log(
        "retry as install \(accepted) accepted; session file NOT rewritten: \(error.localizedDescription)"
      )
    }
  }

  /// PURE — is this the server telling us the install is retired (§4.5 rule 3)?
  ///
  /// Matched on the STATUS AND the code, not the status alone: 409 is also the shape a future
  /// conflict could take, and treating every 409 as "stop for ever" would be a way to silence a
  /// room by accident.
  static func isRetired(_ error: BenchClientError) -> Bool {
    guard case .http(let http) = error else { return false }
    return http.statusCode == 409 && http.body.contains("RETIRED")
  }

  /// R3-6 — is a recording session open on this Mac RIGHT NOW?
  ///
  /// The same expression that decides which `recording_session_id` the poll carries, stated once
  /// so the two cannot drift apart. `.ending` is deliberately NOT open: a session being wound up
  /// has stopped taking audio, and treating it as open would hold an update back for the length of
  /// a finalisation that may itself be waiting on an upload.
  private var sessionIsOpen: Bool { phase == .recording || phase == .paused }

  /// True only when the index is present now, was present before, and GREW.
  private func tapeIsAdvancing() -> Bool {
    let current = currentDurableSampleIndex()
    defer { lastDurableSampleIndex = current }
    guard let current, let previous = lastDurableSampleIndex else { return false }
    return current > previous
  }

  /// One whole update check, when one is due. Returns the version handed over to, or nil.
  ///
  /// R3-10 IS THE `sessionJustEnded` ARGUMENT. A clinic day is close to continuous recording, so a
  /// check deferred at 09:10 would otherwise wait until 15:10 — most of a day after the last
  /// patient left, on a Mac that has been idle the whole time.
  private func checkForUpdateIfDue() async -> String? {
    guard let updater else { return nil }

    // The transition, not the state. A session that was open on the previous poll and is not open
    // now is the moment R3-10 names, and it is observable only by remembering the previous answer.
    let open = sessionIsOpen
    let justEnded = previousSessionWasOpen && !open
    previousSessionWasOpen = open
    if justEnded { sessionEndedSinceUpdateCheck = true }

    let now = Date()
    guard updateSchedule.isDue(now: now, sessionJustEnded: sessionEndedSinceUpdateCheck) else {
      return nil
    }
    sessionEndedSinceUpdateCheck = false
    updateSchedule.lastCheckedAt = now

    switch await updater.check(sessionIsOpen: open) {
    case .upToDate:
      updateSchedule.deferredWhileRecording = false
      return nil
    case .deferredWhileRecording:
      // R3-10 arms here and fires at the end of the session, not six hours from now.
      updateSchedule.deferredWhileRecording = true
      return nil
    case .heldAfterRepeatedFailure:
      // F2. Nothing was downloaded and nothing is on the card that was not already there. The
      // hold lives on disk, so it survives the restarts that got us here.
      updateSchedule.deferredWhileRecording = false
      return nil
    case .stopped(_, _):
      // R3-9 and acceptance item 5. `update-result.json` is on disk; the next poll carries it and
      // the fleet card names the reason. NOTHING resident was touched, so the room is recording on
      // the version it has and there is nothing to recover from.
      updateSchedule.deferredWhileRecording = false
      pendingUpdateResult = RoomUpdateResult.read(root: persistence.root)
      return nil
    case .handedOver(let version):
      updateSchedule.deferredWhileRecording = false
      return version
    }
  }

  /// Why `run()` returned (§13.3 steps 7 and 9). `.stopped` until it returns.
  ///
  /// ─── A PROPERTY RATHER THAN A RETURN VALUE, DELIBERATELY ───────────────────────────────────
  /// `run()` is called from a dozen existing tests that ignore what it gives back. Making it
  /// return would have put a warning on every one of those call sites and invited a sweep through
  /// test files this build's file contract does not open. The CLI reads this after `run()`
  /// returns, which is the only place the answer is wanted.
  public private(set) var exitReason: RoomEngineExit = .stopped

  /// Run until the room stops, or until a swap script takes the bundle over (§13.3 step 7).
  ///
  /// On return, `exitReason` says which. The CLI turns `.handedOverToUpdate` into exit 64, and 64
  /// is a fail-safe rather than a status: launchd restarts the app on any non-zero exit, so a swap
  /// script that dies before it boots the agent out leaves launchd starting the OLD app and the
  /// room recording on the version it has (R3-4).
  public func run() async throws {
    do {
      _ = try await drainPending()
    } catch {
      needsActiveReconciliation = true
      lastError = bounded(error)
      try saveStatus(preferred: .offline)
    }
    tryStartRetainedArchiveRecovery()

    if await refreshRetainedArchiveRecovery() {
      do {
        let active = try await remote.activeSession(tabID: listenerTabID, since: nil)
        if let activeRoomID = active.session?.roomID, !activeRoomID.isEmpty {
          _ = try initializeResidentRuntime(roomID: activeRoomID)
        } else if residentRuntimeFactory != nil, active.resumable {
          throw RoomEngineError.residentArchiveMissingRoomID
        }
        if try spool.pending().isEmpty {
          try await adopt(active)
        } else {
          transition(to: active.session?.id)
          nextPieceIndex = active.nextIndex?.primary ?? 0
          phase = .failed
          needsActiveReconciliation = true
          try saveStatus()
        }
      } catch {
        needsActiveReconciliation = true
        lastError = bounded(error)
        try saveStatus(preferred: .offline)
      }
    } else {
      needsActiveReconciliation = true
      phase = .failed
      try saveStatus()
    }

    await retryRecoveredAcknowledgements()

    var backoffNanoseconds: UInt64 = 5_000_000_000
    var uploadRetryAfter = Date.distantPast
    var uploadBackoff: TimeInterval = 5
    while !Task.isCancelled && phase != .superseded {
      do {
        try await finishUnexpectedCaptureIfNeeded()
        try publishAvailable(finalFlush: false)
      } catch {
        lastError = bounded(error)
        try? saveStatus()
      }

      if Date() >= uploadRetryAfter {
        do {
          if try await drainPending() {
            try await stopAfterServerEnd()
          }
          uploadBackoff = 5
          uploadRetryAfter = .distantPast
        } catch {
          lastError = bounded(error)
          uploadRetryAfter = Date().addingTimeInterval(uploadBackoff)
          uploadBackoff = min(uploadBackoff * 2, 60)
          try? saveStatus(preferred: .offline)
        }
      }

      tryStartRetainedArchiveRecovery()
      let retainedArchiveReady = await refreshRetainedArchiveRecovery()
      if needsActiveReconciliation && retainedArchiveReady {
        do {
          let active = try await remote.activeSession(tabID: listenerTabID, since: nil)
          try await adopt(active)
        } catch {
          lastError = bounded(error)
          try? saveStatus(preferred: .offline)
        }
      }

      do {
        // Install and Fleet §4.3/§5.5. Every value is read HERE, at the moment of the poll —
        // MachineFactsReader measures on each call and reports nil for anything it cannot read.
        let reportedResult = pendingUpdateResult
        let installFields = installID.map {
          InstallPollFields(
            installID: $0,
            // The device the CONFIG says this room records from — the same string RoomEngine
            // hands `tapewriter --device`. The reader turns it into the name CoreAudio reports
            // for it right now, or nil when it is not attached.
            facts: MachineFactsReader.read(inputDeviceUID: configuration.deviceUID),
            tapeAdvancing: tapeIsAdvancing(),
            // R3-6. THE ENGINE'S OWN STATE, read here at the moment of the poll — the same
            // expression that decides `recordingSessionID` two lines below, so the two can never
            // disagree about whether a patient is in the room.
            sessionOpen: sessionIsOpen,
            updateChannel: configuration.updateChannel,
            lastUpdateResult: reportedResult?.outcome.rawValue,
            lastUpdateVersion: reportedResult?.version,
            lastUpdateError: reportedResult?.reportedErrorLine,
            lastUpdateAt: reportedResult.map { Self.iso8601($0.at) },
            // V, 9 Sep. The volume the CAPTURES live on, which is the one that fills.
            diskFreeBytes: InstallPollFields.freeBytes(onVolumeHolding: capturesURL)
          )
        }
        let response = try await remote.pollCommands(
          tabID: listenerTabID,
          previousPollAt: previousPollAt,
          recordingSessionID: phase == .recording || phase == .paused ? sessionID : nil,
          paused: phase == .paused,
          primaryLevels: currentLevels(),
          install: installFields
        )
        // 0.1.17. A no-op unless the one RETIRED retry is in flight, in which case this poll
        // returning is what proves config's id is live.
        retryAfterRetiredAccepted()
        // ─── THE CANARY IS ACKNOWLEDGED HERE (Release B1, §14.2 step 5, B1-D3) ─────────────
        //
        // `pollCommands` RETURNED. That is the definition of a working build, and it is the whole
        // acknowledgement: this process launched, read its session out of the keychain, reached
        // the server and was answered. Before anything below can throw — a superseded response, a
        // missing room id — because every one of those is the SERVER answering, and a build that
        // was answered has proved the thing the watchdog is waiting on.
        //
        // Costs one `stat` per poll on the ordinary path, where the file is not there.
        if let acknowledged = roomCanaryAcknowledge(root: persistence.root) {
          log("canary passed for \(acknowledged)")
          // B1-D5. The handover ends here, not at the receipt: the swap script is watching for
          // exactly this deletion and exits the moment it sees it, so staging is now free.
          RoomUpdateHandover.clear(root: persistence.root)
        }
        previousPollAt = response.now ?? previousPollAt
        if let polledRoomID = response.roomID, !polledRoomID.isEmpty {
          roomID = polledRoomID
          if retainedArchiveReady {
            let initialized = try initializeResidentRuntime(roomID: polledRoomID)
            if initialized {
              needsActiveReconciliation = true
              await retryRecoveredAcknowledgements()
            }
          }
        }
        if residentRuntimeFactory != nil, residentCaptureOwner == nil {
          if !retainedArchiveReady { throw RoomEngineError.retainedArchiveRecoveryPending }
          throw RoomEngineError.residentArchiveMissingRoomID
        }
        if response.superseded {
          try await stopAfterSuperseded()
          await stopRetainedArchiveRecovery()
          break
        }
        // §13.3 step 10. The poll carrying the receipt came back, so the file has done its job and
        // is deleted. Only now: if this line ran before the poll, a network fault would have
        // erased the only record that an update failed.
        if reportedResult != nil {
          RoomUpdateResult.delete(root: persistence.root)
          pendingUpdateResult = nil
        }
        if retainedArchiveReady { lastError = nil }
        for command in response.commands {
          await handle(command)
        }
        try saveStatus()
        backoffNanoseconds = 5_000_000_000

        // ─── BUILD R3 — the update check (§13.3 steps 1 to 7) ────────────────────────────────
        //
        // HERE, AFTER A SUCCESSFUL POLL, AND NOT AT THE TOP OF THE LOOP. §9 of the kickoff asks
        // where this sits and this is the answer, for three reasons. The receipt above has just
        // been delivered, so no handover can discard an unreported failure. The commands above
        // have just been applied, so `sessionIsOpen` below is the freshest reading the engine
        // has and a session that ended on THIS poll is already visible. And a room that cannot
        // reach the server does not reach this line at all, which is exactly R3-9's "do nothing".
        //
        // The cost is that "on launch" means "on the first successful poll", about 1.5 seconds
        // in. That is the conservative half of the trade and it is stated in the build report.
        if let handedOver = await checkForUpdateIfDue() {
          handedOverToUpdateVersion = handedOver
          break
        }

        try await Task.sleep(nanoseconds: 1_500_000_000)
      } catch is CancellationError {
        break
      } catch let error as BenchClientError where Self.isRetired(error) {
        // §4.5 rule 3. NOT the generic backoff below: a retired install is not a transient fault
        // and retrying it is how a superseded copy keeps taking the room back from the install
        // that replaced it. Stop, say why, and let the process exit.
        //
        // 0.1.17: ONE exception, and only once — see `retryAfterRetired`.
        if retryAfterRetired() != nil { continue }
        if retiredRetryAwaitingPoll, let refused = installID {
          log("retry as install \(refused) also refused (409 RETIRED); stopping")
        }
        retiredByServer = true
        lastError = "retired: this install was superseded by a newer enrolment"
        FileHandle.standardError.write(
          Data(
            """
            room-recorder: this install has been retired (409 RETIRED). \
            A newer enrolment owns \(configuration.roomSlug). Stopping; this copy will not poll again. \
            Re-enrol with a fresh install command from /admin/bench if this Mac should serve the room.

            """.utf8))
        try? await stopWithoutEnding(reason: .cancelled)
        await stopRetainedArchiveRecovery()
        break
      } catch {
        lastError = bounded(error)
        try? saveStatus(preferred: .offline)
        try await Task.sleep(nanoseconds: backoffNanoseconds)
        backoffNanoseconds = min(backoffNanoseconds * 2, 30_000_000_000)
      }
    }

    // §13.3 step 7. THE FIRST THING CHECKED AFTER THE LOOP, and before anything that could block.
    // A swap script is already running with this bundle's path in its hands; the only correct
    // remaining action is to stop touching the disk and let the process exit 64.
    if let version = handedOverToUpdateVersion {
      exitReason = .handedOverToUpdate(version: version)
      await stopRetainedArchiveRecovery()
      return
    }

    if Task.isCancelled {
      do {
        try await stopWithoutEnding(reason: .cancelled)
      } catch {
        await stopRetainedArchiveRecovery()
        throw error
      }
      await stopRetainedArchiveRecovery()
      return
    }
    await stopRetainedArchiveRecovery()
    while phase == .superseded && !Task.isCancelled {
      try await Task.sleep(nanoseconds: 3_600_000_000_000)
    }
  }

  public func markConsult(at: Date = Date()) async throws -> ConsultMarkResponse {
    try await remote.markConsult(sessionID: sessionID, at: Self.iso8601(at))
  }

  private func tryStartRetainedArchiveRecovery() {
    guard retainedArchiveRecoveryTask == nil, let retainedArchiveRecovery else { return }
    guard (try? spool.pending().isEmpty) == true else { return }
    retainedArchiveRecoveryTask = Task { await retainedArchiveRecovery.run() }
  }

  @discardableResult
  private func initializeResidentRuntime(roomID: String) throws -> Bool {
    guard let residentRuntimeFactory else { return false }
    guard !roomID.isEmpty else { throw RoomEngineError.residentArchiveMissingRoomID }
    if let residentRuntimeRoomID {
      guard residentRuntimeRoomID == roomID else {
        throw RoomEngineError.io("resident runtime room identity changed")
      }
      return false
    }
    let runtime = try residentRuntimeFactory(
      configuration,
      RoomResidentRuntimeContext(
        archiveRootURL: persistence.root,
        roomID: roomID,
        archiveDeliveryWire: remote as? any ArchiveDeliveryWire))
    let recovered = try runtime.controlJournal.recover()
    residentCaptureOwner = runtime.capture
    residentControlJournal = runtime.controlJournal
    residentControlCommands = recovered
    residentRuntimeRoomID = roomID
    return true
  }

  private func stopRetainedArchiveRecovery() async {
    guard let task = retainedArchiveRecoveryTask else { return }
    task.cancel()
    await task.value
    retainedArchiveRecoveryTask = nil
  }

  private func refreshRetainedArchiveRecovery() async -> Bool {
    guard let retainedArchiveRecovery else { return true }
    let state = await retainedArchiveRecovery.state()
    if state != retainedArchiveRecoveryState {
      retainedArchiveRecoveryState = state
      if state == .complete { needsActiveReconciliation = true }
    }
    switch state {
    case .complete:
      return true
    case .pending:
      phase = .failed
      lastError = RoomEngineError.retainedArchiveRecoveryPending.localizedDescription
      return false
    case .failed(let reason):
      phase = .failed
      lastError = RoomEngineError.retainedArchiveRecoveryFailed(reason).localizedDescription
      return false
    }
  }

  private func requireRetainedArchiveReady() async throws {
    guard let retainedArchiveRecovery else { return }
    switch await retainedArchiveRecovery.state() {
    case .complete:
      return
    case .pending:
      throw RoomEngineError.retainedArchiveRecoveryPending
    case .failed(let reason):
      throw RoomEngineError.retainedArchiveRecoveryFailed(reason)
    }
  }

  public static func markConsult(rootURL: URL = defaultRootURL, at: Date = Date()) async throws
    -> ConsultMarkResponse
  {
    let persistence = RoomPersistence(root: rootURL)
    // Same rule as `run`: a client is built from a configuration that carries the keychain
    // session, never from the bare on-disk one. `mark` posts to the server like any other verb.
    let configuration = try startingConfiguration(rootURL: rootURL)
    let status = try? persistence.loadStatus()
    return try await BenchClient(configuration: configuration).markConsult(
      sessionID: status?.sessionID,
      at: iso8601(at)
    )
  }

  private func adopt(_ active: ActiveSessionResponse) async throws {
    needsActiveReconciliation = !active.ok
    reconciledServerStateKnown = active.ok
    reconciledServerSessionID = active.ok ? active.session?.id : nil
    reconciledServerSessionStatus = active.ok ? active.session?.status : nil
    let activeSessionID = active.ok ? active.session?.id : nil
    if let serverEndedSessionID = residentCaptureOwner?.serverEndedSessionID,
      let activeSessionID, serverEndedSessionID != activeSessionID
    {
      throw RoomEngineError.retainedArchiveRecoveryFailed(
        "server_ended_session_conflict")
    }
    let resumableSession =
      active.ok && active.resumable
        && (active.session?.status == .recording || active.session?.status == .paused)
      ? active.session : nil
    if active.ok, let retainedSessionID = residentCaptureOwner?.retainedUnfinalizedSessionID {
      if let resumableSession {
        guard resumableSession.id == retainedSessionID else {
          phase = .failed
          needsActiveReconciliation = true
          throw RoomEngineError.retainedArchiveRecoveryFailed(
            "retained_unfinalized_session_conflict")
        }
      } else {
        try residentCaptureOwner?.markRetainedUnfinalizedSessionAsServerEnded(retainedSessionID)
        transition(to: retainedSessionID)
        nextPieceIndex = residentCaptureOwner?.nextPrimaryIndex ?? 0
        nextBackupPieceIndex = residentCaptureOwner?.nextBackupIndex ?? 0
        phase = .ending
        try saveStatus()
        return
      }
    }
    let latestActiveControl = activeSessionID.flatMap { latestRecoveredControl(sessionID: $0) }
    let barrier: RoomRecoveredControlCommand?
    if let latestActiveControl,
      !(latestActiveControl.commandKind == .pauseDay && active.session?.status == .paused),
      controlBlocksCaptureReconciliation(latestActiveControl)
    {
      barrier = latestActiveControl
    } else {
      barrier = nil
    }
    guard active.ok, active.resumable, let session = active.session,
      session.status == .recording || session.status == .paused
    else {
      if let serverEndedSessionID = residentCaptureOwner?.serverEndedSessionID {
        transition(to: serverEndedSessionID)
        nextPieceIndex = residentCaptureOwner?.nextPrimaryIndex ?? 0
        nextBackupPieceIndex = residentCaptureOwner?.nextBackupIndex ?? 0
        phase = .ending
        try saveStatus()
        return
      }
      phase = barrier == nil ? .ready : .failed
      transition(to: barrier?.sessionID)
      nextPieceIndex = 0
      nextBackupPieceIndex = 0
      if let barrier {
        lastError = "resident_control_recovery_required:\(barrier.state.rawValue)"
      }
      try saveStatus()
      return
    }
    guard !active.handoverPending || active.tabGone else {
      phase = .failed
      needsActiveReconciliation = true
      throw RoomEngineError.handoverPending
    }
    if let barrier {
      phase = .failed
      needsActiveReconciliation = true
      if let barrierSessionID = barrier.sessionID { transition(to: barrierSessionID) }
      if let sessionRoomID = session.roomID, !sessionRoomID.isEmpty { roomID = sessionRoomID }
      nextPieceIndex = active.nextIndex?.primary ?? 0
      nextBackupPieceIndex = active.nextIndex?.backup ?? 0
      lastError = "resident_control_recovery_required:\(barrier.state.rawValue)"
      try saveStatus()
      return
    }
    transition(to: session.id)
    if let sessionRoomID = session.roomID, !sessionRoomID.isEmpty { roomID = sessionRoomID }
    nextPieceIndex = active.nextIndex?.primary ?? 0
    nextBackupPieceIndex = active.nextIndex?.backup ?? 0
    if residentCaptureOwner?.serverEndedSessionID == session.id {
      phase = .ending
    } else if session.status == .paused {
      phase = .paused
    } else {
      try startCapture(trigger: .reconciliation)
      phase = .recording
    }
    try saveStatus()
  }

  private func handle(_ command: BenchCommand) async {
    if let result = completedCommands[command.id] {
      await acknowledge(command, result: result)
      return
    }
    if let recovered = residentControlCommands[command.id] {
      unacknowledgeableControlCommands.remove(command.id)
      if await resumeRecoveredAcknowledgement(command, recovered: recovered) { return }
    }
    let overridePause: Bool
    if case .object(let arguments) = command.args, case .bool(true) = arguments["override_pause"] {
      overridePause = true
    } else {
      overridePause = false
    }
    let decision = RoomCommandDecider.decide(
      kind: command.kind, phase: phase, overridePause: overridePause)
    let result: CommandResult
    do {
      switch decision {
      case .acknowledgeCurrentState:
        try prepareDecisionAcknowledgement(command, success: true)
        result = CommandResult(ok: true, sessionID: sessionID, error: nil)
      case .start:
        try await beginOrResume(commandID: command.id)
        result = CommandResult(ok: true, sessionID: sessionID, error: nil)
      case .resume:
        try await resume(commandID: command.id)
        result = CommandResult(ok: true, sessionID: sessionID, error: nil)
      case .pause:
        let id = sessionID
        try await pause(commandID: command.id)
        result = CommandResult(ok: true, sessionID: id, error: nil)
      case .end:
        let id = sessionID
        try await end(commandID: command.id)
        result = CommandResult(ok: true, sessionID: id, error: nil)
      case .refuse(let reason):
        try prepareDecisionAcknowledgement(command, success: false)
        result = CommandResult(ok: false, sessionID: nil, error: reason)
      }
    } catch {
      lastError = bounded(error)
      do {
        try prepareFailureAcknowledgement(command)
      } catch {
        lastError = bounded(error)
      }
      if !hasActiveCapture || (phase != .paused && phase != .recording) {
        phase = .failed
      }
      try? saveStatus()
      result = CommandResult(ok: false, sessionID: sessionID, error: bounded(error, limit: 160))
    }
    if residentControlJournal == nil || controlIsAtAcknowledgementBoundary(command, result: result)
    {
      completedCommands[command.id] = result
    }
    await acknowledge(command, result: result)
  }

  private func resumeRecoveredAcknowledgement(
    _ command: BenchCommand,
    recovered: RoomRecoveredControlCommand
  ) async -> Bool {
    guard let recoveredKind = benchCommandKind(recovered.commandKind) else { return false }
    let successStates = acknowledgementStates(kind: recoveredKind, success: true)
    let failureStates = acknowledgementStates(kind: recoveredKind, success: false)
    if recovered.state == successStates.observed || recovered.state == failureStates.observed
      || recovered.state == successStates.outcomeUnobservable
      || recovered.state == failureStates.outcomeUnobservable
    {
      return true
    }
    if recovered.state == successStates.ready || recovered.state == failureStates.ready {
      let success = recovered.state == successStates.ready
      let result = CommandResult(
        ok: success,
        sessionID: recovered.sessionID,
        error: success ? nil : recovered.failure?.rawValue ?? "resident_control_command_failed")
      completedCommands[command.id] = result
      await acknowledge(command, result: result)
      return true
    }
    if recovered.state == .commandNoop || recovered.state == .commandRefused {
      let success = recovered.state == .commandNoop
      do {
        let states = acknowledgementStates(kind: recoveredKind, success: success)
        try advanceControl(
          commandID: command.id,
          commandKind: recovered.commandKind,
          sessionID: recovered.sessionID,
          priorState: recovered.state,
          newState: states.ready)
        let result = CommandResult(
          ok: success,
          sessionID: recovered.sessionID,
          error: success ? nil : ArchiveControlFailure.commandRefused.rawValue)
        completedCommands[command.id] = result
        await acknowledge(command, result: result)
      } catch {
        lastError = bounded(error)
        try? saveStatus(preferred: .offline)
      }
      return true
    }
    if recovered.commandKind == .startDay, recovered.state == .startIntent {
      do {
        try advanceControl(
          commandID: command.id, commandKind: .startDay, sessionID: nil,
          priorState: .startIntent, newState: .sessionOpenOutcomeUnobservable,
          failure: .sessionOpenOutcomeUnobservable)
        try prepareFailureAcknowledgement(command)
        let result = CommandResult(
          ok: false, sessionID: nil, error: "session_open_outcome_unobservable")
        completedCommands[command.id] = result
        await acknowledge(command, result: result)
      } catch {
        lastError = bounded(error)
        try? saveStatus(preferred: .offline)
      }
      return true
    }
    guard recoveredIsLatestEffectCandidate(recovered) else { return true }
    do {
      switch recovered.commandKind {
      case .startDay:
        try await continueRecoveredStart(command, recovered: recovered)
      case .pauseDay:
        try await continueRecoveredPause(command, recovered: recovered)
      case .resumeDay:
        try await continueRecoveredResume(command, recovered: recovered)
      case .endDay:
        try await continueRecoveredEnd(command, recovered: recovered)
      default:
        return false
      }
      if let updated = residentControlCommands[command.id], updated.state != recovered.state {
        return await resumeRecoveredAcknowledgement(command, recovered: updated)
      }
      lastError = "resident_control_recovery_required:\(recovered.state.rawValue)"
      try? saveStatus(preferred: .offline)
    } catch {
      lastError = bounded(error)
      try? saveStatus(preferred: .offline)
    }
    return true
  }

  private func continueRecoveredStart(
    _ command: BenchCommand,
    recovered: RoomRecoveredControlCommand
  ) async throws {
    if recovered.state == .sessionOpenOutcomeUnobservable || recovered.state == .startFailed {
      try prepareFailureAcknowledgement(command)
      return
    }
    guard let id = recovered.sessionID else {
      throw RoomEngineError.io("recovered start state has no session")
    }
    transition(to: id)
    switch recovered.state {
    case .sessionOpened:
      try advanceControl(
        commandID: command.id, commandKind: .startDay, sessionID: id,
        priorState: .sessionOpened, newState: .startCompensationIntent,
        failure: .noDurableGrowth)
    case .captureDurable:
      try requireRecoveredActiveSession(id, statuses: [.recording])
      if !hasActiveCapture {
        try startCapture(trigger: .reconciliation)
      }
      guard hasActiveCapture else { throw RoomEngineError.residentArchiveCaptureStopped }
      phase = .recording
      try saveStatus()
      try advanceControl(
        commandID: command.id, commandKind: .startDay, sessionID: id,
        priorState: .captureDurable, newState: .startAckReady)
    case .startCompensationIntent:
      if hasActiveCapture || residentCaptureOwner?.requiresFinalization == true {
        try stopCaptureAndPublishFinal(reason: .startupFailed)
      }
      try advanceControl(
        commandID: command.id, commandKind: .startDay, sessionID: id,
        priorState: .startCompensationIntent, newState: .captureStopped)
    case .captureStopped:
      _ = try await remote.patchSession(id: id, action: .end, notes: nil)
      reconciledServerSessionID = nil
      reconciledServerSessionStatus = nil
      try advanceControl(
        commandID: command.id, commandKind: .startDay, sessionID: id,
        priorState: .captureStopped, newState: .sessionEndPatched)
    case .sessionEndPatched:
      residentCaptureOwner?.clearServerEndedSessionID(id)
      transition(to: nil)
      phase = .ready
      try saveStatus()
      try advanceControl(
        commandID: command.id, commandKind: .startDay, sessionID: id,
        priorState: .sessionEndPatched, newState: .startFailed,
        failure: .noDurableGrowth)
    default:
      break
    }
  }

  private func continueRecoveredPause(
    _ command: BenchCommand,
    recovered: RoomRecoveredControlCommand
  ) async throws {
    guard let id = recovered.sessionID else {
      throw RoomEngineError.io("recovered pause state has no session")
    }
    transition(to: id)
    switch recovered.state {
    case .pauseIntent:
      if hasActiveCapture || residentCaptureOwner?.requiresFinalization == true {
        try stopCaptureAndPublishFinal(reason: .pause(commandID: command.id))
      }
      try advanceControl(
        commandID: command.id, commandKind: .pauseDay, sessionID: id,
        priorState: .pauseIntent, newState: .laneBoundariesDurable)
    case .laneBoundariesDurable:
      do {
        _ = try await remote.patchSession(id: id, action: .pause, notes: nil)
        reconciledServerSessionStatus = .paused
      } catch {
        try advanceControl(
          commandID: command.id, commandKind: .pauseDay, sessionID: id,
          priorState: .laneBoundariesDurable, newState: .pauseFailed,
          failure: .sessionPatchFailed)
        try prepareFailureAcknowledgement(command)
        return
      }
      try advanceControl(
        commandID: command.id, commandKind: .pauseDay, sessionID: id,
        priorState: .laneBoundariesDurable, newState: .pausePatched)
    case .pausePatched:
      phase = .paused
      try saveStatus()
      try advanceControl(
        commandID: command.id, commandKind: .pauseDay, sessionID: id,
        priorState: .pausePatched, newState: .pauseAckReady)
    case .pauseFailed:
      if hasActiveCapture || residentCaptureOwner?.requiresFinalization == true {
        try stopCaptureAndPublishFinal(reason: .pause(commandID: command.id))
      }
      try prepareFailureAcknowledgement(command)
    default:
      break
    }
  }

  private func continueRecoveredResume(
    _ command: BenchCommand,
    recovered: RoomRecoveredControlCommand
  ) async throws {
    guard let id = recovered.sessionID else {
      throw RoomEngineError.io("recovered resume state has no session")
    }
    transition(to: id)
    switch recovered.state {
    case .resumeIntent:
      if hasActiveCapture || residentCaptureOwner?.requiresFinalization == true {
        try stopCaptureAndPublishFinal(reason: .pause(commandID: command.id))
      }
      try advanceControl(
        commandID: command.id, commandKind: .resumeDay, sessionID: id,
        priorState: .resumeIntent, newState: .resumeFailed,
        failure: .internalIOFailed)
    case .cleanSegmentOpened:
      if hasActiveCapture || residentCaptureOwner?.requiresFinalization == true {
        try stopCaptureAndPublishFinal(reason: .pause(commandID: command.id))
      }
      try advanceControl(
        commandID: command.id, commandKind: .resumeDay, sessionID: id,
        priorState: .cleanSegmentOpened, newState: .resumeFailed,
        failure: .noDurableGrowth)
    case .captureDurable:
      try requireRecoveredActiveSession(id, statuses: [.paused, .recording])
      if !hasActiveCapture {
        try startCapture(trigger: .reconciliation)
      }
      guard hasActiveCapture else { throw RoomEngineError.residentArchiveCaptureStopped }
      do {
        _ = try await remote.patchSession(id: id, action: .resume, notes: nil)
        reconciledServerSessionStatus = .recording
      } catch {
        try advanceControl(
          commandID: command.id, commandKind: .resumeDay, sessionID: id,
          priorState: .captureDurable, newState: .resumeCompensationIntent,
          failure: .sessionPatchFailed)
        try stopCaptureAndPublishFinal(reason: .pause(commandID: command.id))
        try advanceControl(
          commandID: command.id, commandKind: .resumeDay, sessionID: id,
          priorState: .resumeCompensationIntent, newState: .captureStopped)
        try advanceControl(
          commandID: command.id, commandKind: .resumeDay, sessionID: id,
          priorState: .captureStopped, newState: .resumeFailed,
          failure: .sessionPatchFailed)
        try prepareFailureAcknowledgement(command)
        return
      }
      phase = .recording
      try saveStatus()
      try advanceControl(
        commandID: command.id, commandKind: .resumeDay, sessionID: id,
        priorState: .captureDurable, newState: .resumePatched)
    case .resumePatched:
      try requireRecoveredActiveSession(id, statuses: [.paused, .recording])
      if reconciledServerSessionStatus == .paused {
        _ = try await remote.patchSession(id: id, action: .resume, notes: nil)
        reconciledServerSessionStatus = .recording
      }
      if !hasActiveCapture {
        try startCapture(trigger: .reconciliation)
      }
      guard hasActiveCapture else { throw RoomEngineError.residentArchiveCaptureStopped }
      phase = .recording
      try saveStatus()
      try advanceControl(
        commandID: command.id, commandKind: .resumeDay, sessionID: id,
        priorState: .resumePatched, newState: .resumeAckReady)
    case .resumeCompensationIntent:
      if hasActiveCapture || residentCaptureOwner?.requiresFinalization == true {
        try stopCaptureAndPublishFinal(reason: .pause(commandID: command.id))
      }
      try advanceControl(
        commandID: command.id, commandKind: .resumeDay, sessionID: id,
        priorState: .resumeCompensationIntent, newState: .captureStopped)
    case .captureStopped:
      try advanceControl(
        commandID: command.id, commandKind: .resumeDay, sessionID: id,
        priorState: .captureStopped, newState: .resumeFailed,
        failure: .sessionPatchFailed)
    case .resumeFailed:
      if hasActiveCapture || residentCaptureOwner?.requiresFinalization == true {
        try stopCaptureAndPublishFinal(reason: .pause(commandID: command.id))
      }
      try prepareFailureAcknowledgement(command)
    default:
      break
    }
  }

  private func continueRecoveredEnd(
    _ command: BenchCommand,
    recovered: RoomRecoveredControlCommand
  ) async throws {
    guard let id = recovered.sessionID else {
      throw RoomEngineError.io("recovered end state has no session")
    }
    transition(to: id)
    switch recovered.state {
    case .endIntent:
      if hasActiveCapture || residentCaptureOwner?.requiresFinalization == true {
        try stopCaptureAndPublishFinal(reason: .end(commandID: command.id))
      }
      try await residentCaptureOwner?.reserveFinalRanges(context: try finalizationContext())
      try advanceControl(
        commandID: command.id, commandKind: .endDay, sessionID: id,
        priorState: .endIntent, newState: .finalRangesReserved)
    case .finalRangesReserved:
      if try await drainPending() { throw RoomEngineError.sessionEndedByServer }
      let remaining = try spool.pending().count
      guard remaining == 0 else { throw RoomEngineError.pendingUploads(remaining) }
      do {
        try await residentCaptureOwner?.verifyFinalRanges(context: try finalizationContext())
      } catch {
        try advanceControl(
          commandID: command.id, commandKind: .endDay, sessionID: id,
          priorState: .finalRangesReserved, newState: .endFailed,
          failure: .finalVerificationFailed)
        try prepareFailureAcknowledgement(command)
        return
      }
      try advanceControl(
        commandID: command.id, commandKind: .endDay, sessionID: id,
        priorState: .finalRangesReserved, newState: .finalRangesVerified)
    case .finalRangesVerified:
      if try !residentObservedServerEnd(sessionID: id) {
        do {
          _ = try await remote.patchSession(id: id, action: .end, notes: nil)
          reconciledServerSessionID = nil
          reconciledServerSessionStatus = nil
        } catch {
          try advanceControl(
            commandID: command.id, commandKind: .endDay, sessionID: id,
            priorState: .finalRangesVerified, newState: .endFailed,
            failure: .sessionPatchFailed)
          try prepareFailureAcknowledgement(command)
          return
        }
      }
      try advanceControl(
        commandID: command.id, commandKind: .endDay, sessionID: id,
        priorState: .finalRangesVerified, newState: .sessionEndPatched)
    case .sessionEndPatched:
      transition(to: nil)
      nextPieceIndex = 0
      nextBackupPieceIndex = 0
      phase = .ready
      try saveStatus()
      try advanceControl(
        commandID: command.id, commandKind: .endDay, sessionID: id,
        priorState: .sessionEndPatched, newState: .endAckReady)
    case .endFailed:
      if hasActiveCapture || residentCaptureOwner?.requiresFinalization == true {
        try stopCaptureAndPublishFinal(reason: .end(commandID: command.id))
      }
      try prepareFailureAcknowledgement(command)
    default:
      break
    }
  }

  private func retryRecoveredAcknowledgements() async {
    for recovered in residentControlCommands.values.sorted(by: {
      ($0.atWallNS, $0.atMonoNS, $0.commandID)
        < ($1.atWallNS, $1.atMonoNS, $1.commandID)
    }) {
      guard let kind = benchCommandKind(recovered.commandKind) else { continue }
      let command = BenchCommand(
        id: recovered.commandID,
        kind: kind,
        args: .object([:]),
        createdAt: nil)
      _ = await resumeRecoveredAcknowledgement(command, recovered: recovered)
    }
  }

  private func acknowledge(_ command: BenchCommand, result: CommandResult) async {
    if residentControlJournal != nil {
      guard !unacknowledgeableControlCommands.contains(command.id) else { return }
      guard let recovered = residentControlCommands[command.id] else {
        lastError = "control journal has no durable command intent"
        try? saveStatus(preferred: .offline)
        return
      }
      let controlKind = benchCommandKind(recovered.commandKind) ?? command.kind
      let states = acknowledgementStates(kind: controlKind, success: result.ok)
      if recovered.state == states.observed || recovered.state == states.outcomeUnobservable {
        return
      }
      guard recovered.state == states.ready else {
        lastError = "control journal is not durable at an acknowledgement boundary"
        try? saveStatus(preferred: .offline)
        return
      }
    }
    for attempt in 1...3 {
      do {
        let acknowledgement = try await remote.acknowledge(
          commandID: command.id,
          ok: result.ok,
          sessionID: result.sessionID,
          error: result.error)
        let expectedStatus = result.ok ? "acked" : "failed"
        guard acknowledgement.ok, acknowledgement.id == command.id,
          acknowledgement.status == expectedStatus
        else {
          throw RoomEngineError.io("invalid command acknowledgement response")
        }
        do {
          let recovered = residentControlCommands[command.id]
          let controlKind = recovered.flatMap { benchCommandKind($0.commandKind) } ?? command.kind
          let states = acknowledgementStates(kind: controlKind, success: result.ok)
          let journalSessionID: String?
          if let recovered = residentControlCommands[command.id] {
            journalSessionID = recovered.sessionID
          } else {
            journalSessionID = result.sessionID
          }
          try advanceControl(
            commandID: command.id,
            commandKind: recovered?.commandKind ?? archiveCommandKind(command.kind),
            sessionID: journalSessionID,
            priorState: states.ready,
            newState: states.observed)
        } catch {
          lastError = bounded(error)
          try? saveStatus(preferred: .offline)
        }
        return
      } catch {
        lastError = bounded(error)
        if commandNotPending(error) {
          let recovered = residentControlCommands[command.id]
          let controlKind = recovered.flatMap { benchCommandKind($0.commandKind) } ?? command.kind
          let states = acknowledgementStates(kind: controlKind, success: result.ok)
          do {
            let journalSessionID: String?
            if let recovered = residentControlCommands[command.id] {
              journalSessionID = recovered.sessionID
            } else {
              journalSessionID = result.sessionID
            }
            try advanceControl(
              commandID: command.id,
              commandKind: recovered?.commandKind ?? archiveCommandKind(command.kind),
              sessionID: journalSessionID,
              priorState: states.ready,
              newState: states.outcomeUnobservable,
              failure: .ackOutcomeUnobservable)
          } catch {
            lastError = bounded(error)
            try? saveStatus(preferred: .offline)
          }
          return
        }
        if attempt < 3 {
          try? await Task.sleep(nanoseconds: UInt64(attempt) * 1_000_000_000)
        }
      }
    }
    try? saveStatus(preferred: .offline)
  }

  private func advanceControl(
    commandID: String,
    commandKind: ArchiveControlCommandKind,
    sessionID: String?,
    priorState: ArchiveControlState?,
    newState: ArchiveControlState,
    failure: ArchiveControlFailure? = nil
  ) throws {
    guard let residentControlJournal else { return }
    let recovered = try residentControlJournal.advance(
      RoomControlTransition(
        commandID: commandID,
        commandKind: commandKind,
        sessionID: sessionID,
        priorState: priorState,
        newState: newState,
        failure: failure))
    residentControlCommands[commandID] = recovered
  }

  private func archiveCommandKind(_ kind: BenchCommandKind) -> ArchiveControlCommandKind {
    switch kind {
    case .startDay: return .startDay
    case .pauseDay: return .pauseDay
    case .resumeDay: return .resumeDay
    case .endDay: return .endDay
    }
  }

  private func benchCommandKind(_ kind: ArchiveControlCommandKind) -> BenchCommandKind? {
    switch kind {
    case .startDay: return .startDay
    case .pauseDay: return .pauseDay
    case .resumeDay: return .resumeDay
    case .endDay: return .endDay
    case .maintenanceHandoff, .maintenanceReclaim, .captureSessionBinding,
      .serverEndedFinalization, .rolloverPreparation, .rollover:
      return nil
    }
  }

  private func commandNotPending(_ error: Error) -> Bool {
    guard let benchError = error as? BenchClientError,
      case .http(let response) = benchError
    else { return false }
    return response.statusCode == 404 && response.body.contains("command_not_pending")
  }

  private func controlBlocksCaptureReconciliation(
    _ command: RoomRecoveredControlCommand
  ) -> Bool {
    switch command.commandKind {
    case .startDay:
      switch command.state {
      case .captureDurable, .startAckReady, .startAckObserved, .startAckOutcomeUnobservable,
        .commandNoop:
        return false
      default:
        return true
      }
    case .pauseDay, .endDay:
      return true
    case .resumeDay:
      switch command.state {
      case .resumePatched, .resumeAckReady, .resumeAckObserved,
        .resumeAckOutcomeUnobservable:
        return false
      default:
        return true
      }
    default:
      return false
    }
  }

  private func latestRecoveredControl(sessionID: String? = nil) -> RoomRecoveredControlCommand? {
    residentControlCommands.values
      .filter { sessionID == nil || $0.sessionID == nil || $0.sessionID == sessionID }
      .max {
        ($0.atWallNS, $0.atMonoNS, $0.commandID)
          < ($1.atWallNS, $1.atMonoNS, $1.commandID)
      }
  }

  private func recoveredIsLatestEffectCandidate(_ recovered: RoomRecoveredControlCommand) -> Bool {
    let activeSessionID = sessionID
    guard
      activeSessionID == nil || recovered.sessionID == nil || recovered.sessionID == activeSessionID
    else { return false }
    return latestRecoveredControl(sessionID: activeSessionID)?.commandID == recovered.commandID
  }

  private func requireRecoveredActiveSession(
    _ expectedSessionID: String,
    statuses: [BenchSessionStatus]
  ) throws {
    guard reconciledServerStateKnown else {
      throw RoomEngineError.io("active session state is unknown during control recovery")
    }
    guard reconciledServerSessionID == expectedSessionID else {
      throw RoomEngineError.io("recovered control session is not active")
    }
    guard let status = reconciledServerSessionStatus, statuses.contains(status) else {
      throw RoomEngineError.io("active session status conflicts with recovered control")
    }
  }

  private func controlBlocksNewStart(_ command: RoomRecoveredControlCommand) -> Bool {
    switch command.commandKind {
    case .startDay:
      return [
        .startIntent, .sessionOpened, .startCompensationIntent, .captureStopped,
        .sessionEndPatched, .sessionOpenOutcomeUnobservable, .startFailed,
      ].contains(command.state)
    case .pauseDay:
      return [
        .pauseIntent, .laneBoundariesDurable, .pauseFailed,
      ].contains(command.state)
    case .resumeDay:
      return [
        .resumeCompensationIntent, .captureStopped, .resumeFailed,
      ].contains(command.state)
    case .endDay:
      return [
        .endIntent, .finalRangesReserved, .finalRangesVerified, .endFailed,
      ].contains(command.state)
    default:
      return false
    }
  }

  private func acknowledgementStates(kind: BenchCommandKind, success: Bool) -> (
    ready: ArchiveControlState,
    observed: ArchiveControlState,
    outcomeUnobservable: ArchiveControlState
  ) {
    switch (kind, success) {
    case (.startDay, true):
      return (.startAckReady, .startAckObserved, .startAckOutcomeUnobservable)
    case (.startDay, false):
      return (
        .startFailureAckReady, .startFailureAckObserved,
        .startFailureAckOutcomeUnobservable
      )
    case (.pauseDay, true):
      return (.pauseAckReady, .pauseAckObserved, .pauseAckOutcomeUnobservable)
    case (.pauseDay, false):
      return (
        .pauseFailureAckReady, .pauseFailureAckObserved,
        .pauseFailureAckOutcomeUnobservable
      )
    case (.resumeDay, true):
      return (.resumeAckReady, .resumeAckObserved, .resumeAckOutcomeUnobservable)
    case (.resumeDay, false):
      return (
        .resumeFailureAckReady, .resumeFailureAckObserved,
        .resumeFailureAckOutcomeUnobservable
      )
    case (.endDay, true):
      return (.endAckReady, .endAckObserved, .endAckOutcomeUnobservable)
    case (.endDay, false):
      return (
        .endFailureAckReady, .endFailureAckObserved,
        .endFailureAckOutcomeUnobservable
      )
    }
  }

  private func controlIsAtAcknowledgementBoundary(
    _ command: BenchCommand,
    result: CommandResult
  ) -> Bool {
    guard let recovered = residentControlCommands[command.id],
      let kind = benchCommandKind(recovered.commandKind)
    else { return false }
    let states = acknowledgementStates(kind: kind, success: result.ok)
    return recovered.state == states.ready || recovered.state == states.observed
      || recovered.state == states.outcomeUnobservable
  }

  private func prepareDecisionAcknowledgement(
    _ command: BenchCommand,
    success: Bool
  ) throws {
    guard residentControlJournal != nil else { return }
    let kind = archiveCommandKind(command.kind)
    let journalSessionID: String?
    switch command.kind {
    case .startDay: journalSessionID = nil
    case .pauseDay, .resumeDay, .endDay: journalSessionID = sessionID
    }
    let decisionState: ArchiveControlState = success ? .commandNoop : .commandRefused
    let failure: ArchiveControlFailure? = success ? nil : .commandRefused
    try advanceControl(
      commandID: command.id,
      commandKind: kind,
      sessionID: journalSessionID,
      priorState: nil,
      newState: decisionState,
      failure: failure)
    let states = acknowledgementStates(kind: command.kind, success: success)
    try advanceControl(
      commandID: command.id,
      commandKind: kind,
      sessionID: journalSessionID,
      priorState: decisionState,
      newState: states.ready)
  }

  private func prepareFailureAcknowledgement(_ command: BenchCommand) throws {
    guard !unacknowledgeableControlCommands.contains(command.id) else { return }
    guard let current = residentControlCommands[command.id] else { return }
    let kind = current.commandKind
    guard let commandKind = benchCommandKind(kind) else { return }
    switch (commandKind, current.state) {
    case (.startDay, .startIntent):
      try advanceControl(
        commandID: command.id, commandKind: kind, sessionID: nil,
        priorState: .startIntent, newState: .startFailed, failure: .internalIOFailed)
      try prepareFailureAcknowledgement(command)
    case (.startDay, .sessionOpenOutcomeUnobservable):
      try advanceControl(
        commandID: command.id, commandKind: kind, sessionID: nil,
        priorState: .sessionOpenOutcomeUnobservable, newState: .startFailureAckReady)
    case (.startDay, .startFailed):
      try advanceControl(
        commandID: command.id, commandKind: kind, sessionID: current.sessionID,
        priorState: .startFailed, newState: .startFailureAckReady)
    case (.pauseDay, .pauseIntent):
      try advanceControl(
        commandID: command.id, commandKind: kind, sessionID: current.sessionID,
        priorState: .pauseIntent, newState: .pauseFailed, failure: .internalIOFailed)
      try prepareFailureAcknowledgement(command)
    case (.pauseDay, .laneBoundariesDurable):
      try advanceControl(
        commandID: command.id, commandKind: kind, sessionID: current.sessionID,
        priorState: .laneBoundariesDurable, newState: .pauseFailed,
        failure: .sessionPatchFailed)
      try prepareFailureAcknowledgement(command)
    case (.pauseDay, .pauseFailed):
      try advanceControl(
        commandID: command.id, commandKind: kind, sessionID: current.sessionID,
        priorState: .pauseFailed, newState: .pauseFailureAckReady)
    case (.resumeDay, .resumeIntent):
      try advanceControl(
        commandID: command.id, commandKind: kind, sessionID: current.sessionID,
        priorState: .resumeIntent, newState: .resumeFailed, failure: .internalIOFailed)
      try prepareFailureAcknowledgement(command)
    case (.resumeDay, .cleanSegmentOpened):
      try advanceControl(
        commandID: command.id, commandKind: kind, sessionID: current.sessionID,
        priorState: .cleanSegmentOpened, newState: .resumeFailed, failure: .noDurableGrowth)
      try prepareFailureAcknowledgement(command)
    case (.resumeDay, .captureStopped):
      try advanceControl(
        commandID: command.id, commandKind: kind, sessionID: current.sessionID,
        priorState: .captureStopped, newState: .resumeFailed, failure: .sessionPatchFailed)
      try prepareFailureAcknowledgement(command)
    case (.resumeDay, .resumeFailed):
      try advanceControl(
        commandID: command.id, commandKind: kind, sessionID: current.sessionID,
        priorState: .resumeFailed, newState: .resumeFailureAckReady)
    case (.endDay, .endIntent):
      try advanceControl(
        commandID: command.id, commandKind: kind, sessionID: current.sessionID,
        priorState: .endIntent, newState: .endFailed, failure: .internalIOFailed)
      try prepareFailureAcknowledgement(command)
    case (.endDay, .finalRangesVerified):
      try advanceControl(
        commandID: command.id, commandKind: kind, sessionID: current.sessionID,
        priorState: .finalRangesVerified, newState: .endFailed,
        failure: .sessionPatchFailed)
      try prepareFailureAcknowledgement(command)
    case (.endDay, .endFailed):
      try advanceControl(
        commandID: command.id, commandKind: kind, sessionID: current.sessionID,
        priorState: .endFailed, newState: .endFailureAckReady)
    default:
      break
    }
  }

  private func beginOrResume(commandID: String) async throws {
    if let barrier = latestRecoveredControl(), controlBlocksNewStart(barrier) {
      unacknowledgeableControlCommands.insert(commandID)
      throw RoomEngineError.io("resident control recovery blocks start: \(barrier.state.rawValue)")
    }
    try await requireRetainedArchiveReady()
    _ = try await drainPending()
    let pending = try spool.pending().count
    guard pending == 0 else { throw RoomEngineError.pendingUploads(pending) }
    let active = try await remote.activeSession(tabID: listenerTabID, since: nil)
    reconciledServerStateKnown = active.ok
    reconciledServerSessionID = active.ok ? active.session?.id : nil
    reconciledServerSessionStatus = active.ok ? active.session?.status : nil
    if active.resumable, let existing = active.session {
      guard !active.handoverPending || active.tabGone else {
        throw RoomEngineError.handoverPending
      }
      guard existing.status != .paused else { throw RoomEngineError.roomPaused }
      transition(to: existing.id)
      if let existingRoomID = existing.roomID, !existingRoomID.isEmpty { roomID = existingRoomID }
      nextPieceIndex = active.nextIndex?.primary ?? 0
      nextBackupPieceIndex = active.nextIndex?.backup ?? 0
      try startCapture(trigger: .reconciliation)
      phase = .recording
      try saveStatus()
      try advanceControl(
        commandID: commandID, commandKind: .startDay, sessionID: nil,
        priorState: nil, newState: .commandNoop)
      try advanceControl(
        commandID: commandID, commandKind: .startDay, sessionID: nil,
        priorState: .commandNoop, newState: .startAckReady)
      return
    } else {
      try advanceControl(
        commandID: commandID, commandKind: .startDay, sessionID: nil,
        priorState: nil, newState: .startIntent)
      let created: CreateSessionResponse
      do {
        created = try await remote.createSession(label: nil, micLabel: configuration.deviceUID)
      } catch {
        try advanceControl(
          commandID: commandID, commandKind: .startDay, sessionID: nil,
          priorState: .startIntent, newState: .sessionOpenOutcomeUnobservable,
          failure: .sessionOpenOutcomeUnobservable)
        throw error
      }
      transition(to: created.session.id)
      reconciledServerStateKnown = true
      reconciledServerSessionID = created.session.id
      reconciledServerSessionStatus = .recording
      if let createdRoomID = created.session.roomID, !createdRoomID.isEmpty {
        roomID = createdRoomID
      }
      nextPieceIndex = 0
      nextBackupPieceIndex = 0
    }
    guard let openedSessionID = sessionID else { throw RoomEngineError.noActiveSession }
    do {
      try advanceControl(
        commandID: commandID, commandKind: .startDay, sessionID: openedSessionID,
        priorState: .startIntent, newState: .sessionOpened)
    } catch {
      unacknowledgeableControlCommands.insert(commandID)
      if (try? await remote.patchSession(id: openedSessionID, action: .end, notes: nil)) != nil {
        transition(to: nil)
      }
      throw error
    }
    do {
      try startCapture(trigger: .startDay(commandID: commandID))
      try advanceControl(
        commandID: commandID, commandKind: .startDay, sessionID: openedSessionID,
        priorState: .sessionOpened, newState: .captureDurable)
    } catch {
      let startupError = error
      do {
        try advanceControl(
          commandID: commandID, commandKind: .startDay, sessionID: openedSessionID,
          priorState: .sessionOpened, newState: .startCompensationIntent,
          failure: .noDurableGrowth)
      } catch {
        unacknowledgeableControlCommands.insert(commandID)
        if hasActiveCapture || residentCaptureOwner?.requiresFinalization == true {
          try? stopCaptureAndPublishFinal(reason: .startupFailed)
        }
        throw error
      }
      if hasActiveCapture || residentCaptureOwner?.requiresFinalization == true {
        try stopCaptureAndPublishFinal(reason: .startupFailed)
      }
      try advanceControl(
        commandID: commandID, commandKind: .startDay, sessionID: openedSessionID,
        priorState: .startCompensationIntent, newState: .captureStopped)
      _ = try await remote.patchSession(id: openedSessionID, action: .end, notes: nil)
      try advanceControl(
        commandID: commandID, commandKind: .startDay, sessionID: openedSessionID,
        priorState: .captureStopped, newState: .sessionEndPatched)
      try advanceControl(
        commandID: commandID, commandKind: .startDay, sessionID: openedSessionID,
        priorState: .sessionEndPatched, newState: .startFailed,
        failure: .noDurableGrowth)
      transition(to: nil)
      throw startupError
    }
    phase = .recording
    try saveStatus()
    try advanceControl(
      commandID: commandID, commandKind: .startDay, sessionID: openedSessionID,
      priorState: .captureDurable, newState: .startAckReady)
  }

  private func pause(commandID: String) async throws {
    guard let id = sessionID else { throw RoomEngineError.noActiveSession }
    try advanceControl(
      commandID: commandID, commandKind: .pauseDay, sessionID: id,
      priorState: nil, newState: .pauseIntent)
    try stopCaptureAndPublishFinal(reason: .pause(commandID: commandID))
    try advanceControl(
      commandID: commandID, commandKind: .pauseDay, sessionID: id,
      priorState: .pauseIntent, newState: .laneBoundariesDurable)
    do {
      _ = try await remote.patchSession(id: id, action: .pause, notes: nil)
      reconciledServerSessionStatus = .paused
    } catch {
      phase = .failed
      throw error
    }
    phase = .paused
    try saveStatus()
    do {
      try advanceControl(
        commandID: commandID, commandKind: .pauseDay, sessionID: id,
        priorState: .laneBoundariesDurable, newState: .pausePatched)
      try advanceControl(
        commandID: commandID, commandKind: .pauseDay, sessionID: id,
        priorState: .pausePatched, newState: .pauseAckReady)
    } catch {
      unacknowledgeableControlCommands.insert(commandID)
      throw error
    }
  }

  private func resume(commandID: String) async throws {
    try await requireRetainedArchiveReady()
    guard let id = sessionID else { throw RoomEngineError.noActiveSession }
    try advanceControl(
      commandID: commandID, commandKind: .resumeDay, sessionID: id,
      priorState: nil, newState: .resumeIntent)
    var serverResumeObserved = false
    do {
      try startCapture(trigger: .resumeDay(commandID: commandID))
      try advanceControl(
        commandID: commandID, commandKind: .resumeDay, sessionID: id,
        priorState: .resumeIntent, newState: .cleanSegmentOpened)
      try advanceControl(
        commandID: commandID, commandKind: .resumeDay, sessionID: id,
        priorState: .cleanSegmentOpened, newState: .captureDurable)
      do {
        _ = try await remote.patchSession(id: id, action: .resume, notes: nil)
        serverResumeObserved = true
        reconciledServerSessionStatus = .recording
      } catch {
        try advanceControl(
          commandID: commandID, commandKind: .resumeDay, sessionID: id,
          priorState: .captureDurable, newState: .resumeCompensationIntent,
          failure: .sessionPatchFailed)
        try stopCaptureAndPublishFinal(reason: .pause(commandID: commandID))
        try advanceControl(
          commandID: commandID, commandKind: .resumeDay, sessionID: id,
          priorState: .resumeCompensationIntent, newState: .captureStopped)
        throw error
      }
      try advanceControl(
        commandID: commandID, commandKind: .resumeDay, sessionID: id,
        priorState: .captureDurable, newState: .resumePatched)
      phase = .recording
      try saveStatus()
      try advanceControl(
        commandID: commandID, commandKind: .resumeDay, sessionID: id,
        priorState: .resumePatched, newState: .resumeAckReady)
    } catch {
      if !serverResumeObserved, hasActiveCapture {
        do {
          try stopCaptureAndPublishFinal(reason: .pause(commandID: commandID))
        } catch {
          phase = .failed
          throw error
        }
      }
      phase = serverResumeObserved && hasActiveCapture ? .recording : .paused
      throw error
    }
  }

  private func end(commandID: String) async throws {
    guard let id = sessionID else { throw RoomEngineError.noActiveSession }
    try advanceControl(
      commandID: commandID, commandKind: .endDay, sessionID: id,
      priorState: nil, newState: .endIntent)
    phase = .ending
    try stopCaptureAndPublishFinal(reason: .end(commandID: commandID))
    try saveStatus()
    try await residentCaptureOwner?.reserveFinalRanges(context: try finalizationContext())
    try advanceControl(
      commandID: commandID, commandKind: .endDay, sessionID: id,
      priorState: .endIntent, newState: .finalRangesReserved)
    var finalError: Error?
    for attempt in 1...3 {
      do {
        if try await drainPending() {
          throw RoomEngineError.sessionEndedByServer
        }
        finalError = nil
        break
      } catch {
        finalError = error
        lastError = bounded(error)
        try? saveStatus(preferred: .offline)
        if attempt < 3 {
          try await Task.sleep(nanoseconds: UInt64(attempt) * 1_000_000_000)
        }
      }
    }
    if let finalError { throw finalError }
    let remaining = try spool.pending().count
    guard remaining == 0 else { throw RoomEngineError.pendingUploads(remaining) }
    do {
      try await residentCaptureOwner?.verifyFinalRanges(context: try finalizationContext())
    } catch {
      try advanceControl(
        commandID: commandID, commandKind: .endDay, sessionID: id,
        priorState: .finalRangesReserved, newState: .endFailed,
        failure: .finalVerificationFailed)
      throw error
    }
    try advanceControl(
      commandID: commandID, commandKind: .endDay, sessionID: id,
      priorState: .finalRangesReserved, newState: .finalRangesVerified)
    if try !residentObservedServerEnd(sessionID: id) {
      _ = try await remote.patchSession(id: id, action: .end, notes: nil)
      reconciledServerSessionID = nil
      reconciledServerSessionStatus = nil
    }
    do {
      try advanceControl(
        commandID: commandID, commandKind: .endDay, sessionID: id,
        priorState: .finalRangesVerified, newState: .sessionEndPatched)
    } catch {
      unacknowledgeableControlCommands.insert(commandID)
      throw error
    }
    residentCaptureOwner?.clearServerEndedSessionID(id)
    transition(to: nil)
    nextPieceIndex = 0
    nextBackupPieceIndex = 0
    phase = .ready
    try saveStatus()
    try advanceControl(
      commandID: commandID, commandKind: .endDay, sessionID: id,
      priorState: .sessionEndPatched, newState: .endAckReady)
  }

  private func startCapture(trigger: RoomResidentCaptureStartContext.Trigger) throws {
    guard !hasActiveCapture else { throw RoomEngineError.captureAlreadyActive }
    guard let sessionID else { throw RoomEngineError.noActiveSession }
    if let residentCaptureOwner {
      if residentCaptureOwner.requiresFinalization {
        defer { updateResidentIndices(residentCaptureOwner) }
        try residentCaptureOwner.stopAndFinalize(reason: .startupFailed)
      }
      guard let roomID, !roomID.isEmpty else { throw RoomEngineError.residentArchiveMissingRoomID }
      guard nextPieceIndex >= 0 else {
        throw RoomEngineError.io("resident archive received a negative primary server lane index")
      }
      do {
        try residentCaptureOwner.start(
          context: RoomResidentCaptureStartContext(
            roomID: roomID,
            sessionID: sessionID,
            nextPrimaryIndex: nextPieceIndex,
            nextBackupIndex: residentCaptureOwner.nextBackupIndex.map { _ in nextBackupPieceIndex },
            trigger: trigger
          ))
        guard residentCaptureOwner.isActive else {
          throw RoomEngineError.residentArchiveDidNotBecomeDurable
        }
      } catch let startupError {
        if residentCaptureOwner.isActive || residentCaptureOwner.requiresFinalization {
          do {
            try residentCaptureOwner.stopAndFinalize(reason: .startupFailed)
          } catch {
            throw error
          }
        }
        throw startupError
      }
      updateResidentIndices(residentCaptureOwner)
      return
    }
    if residentRuntimeFactory != nil {
      throw RoomEngineError.residentArchiveRuntimeUnavailable
    }
    let safeSession = safePathComponent(sessionID)
    let sessionDirectory = capturesURL.appendingPathComponent(safeSession, isDirectory: true)
    try createPrivateDirectory(sessionDirectory)
    let segmentID = "seg_\(UUID().uuidString.lowercased())"
    let directory = sessionDirectory.appendingPathComponent(segmentID, isDirectory: true)
    try createPrivateDirectory(directory)
    let indexURL = directory.appendingPathComponent("tape.idx")
    let process = try captureLauncher.launch(
      executable: URL(fileURLWithPath: configuration.tapewriterPath),
      outputDirectory: directory,
      deviceUID: configuration.deviceUID,
      logURL: directory.appendingPathComponent("tapewriter.log")
    )
    var segment = Segment(
      id: segmentID,
      directory: directory,
      pcmURL: directory.appendingPathComponent("tape.pcm"),
      indexURL: indexURL,
      process: process,
      nextSample: 0,
      nextPieceIndex: nextPieceIndex,
      initialGapBeforeMS: 0
    )
    do {
      try waitForDurableGrowth(segment: segment)
      if let lastPieceEndedAt,
        let first = try IndexLog.read(url: segment.indexURL).records.first(where: {
          $0.discontinuity == nil
        })
      {
        let firstAudioAt = Date(timeIntervalSince1970: Double(first.wallNS) / 1_000_000_000)
        segment.initialGapBeforeMS = max(
          0, Int64((firstAudioAt.timeIntervalSince(lastPieceEndedAt) * 1_000).rounded()))
      }
    } catch let startupError {
      process.interrupt()
      process.waitUntilExit()
      capture = segment
      do {
        try publishAvailable(segment: &segment, finalFlush: true)
        nextPieceIndex = segment.nextPieceIndex
        capture = nil
      } catch {
        nextPieceIndex = segment.nextPieceIndex
        capture = segment
        throw error
      }
      throw startupError
    }
    capture = segment
  }

  private func finalizationContext() throws -> RoomResidentFinalizationContext {
    guard let roomID, !roomID.isEmpty else {
      throw RoomEngineError.residentArchiveMissingRoomID
    }
    guard let sessionID else { throw RoomEngineError.noActiveSession }
    return RoomResidentFinalizationContext(
      roomID: roomID,
      sessionID: sessionID,
      nextPrimaryIndex: nextPieceIndex,
      nextBackupIndex: residentCaptureOwner?.nextBackupIndex.map { _ in nextBackupPieceIndex })
  }

  private func waitForDurableGrowth(segment: Segment) throws {
    let deadline = Date().addingTimeInterval(20)
    while Date() < deadline {
      if !segment.process.isRunning {
        throw RoomEngineError.captureExited(segment.process.terminationStatus ?? -1)
      }
      if let records = try? IndexLog.read(url: segment.indexURL).records,
        (records.compactMap(\.samples).last ?? 0) > 0
      {
        return
      }
      Thread.sleep(forTimeInterval: 0.1)
    }
    throw RoomEngineError.captureDidNotBecomeDurable
  }

  private func finishUnexpectedCaptureIfNeeded() async throws {
    if let residentCaptureOwner {
      defer { updateResidentIndices(residentCaptureOwner) }
      do {
        try await residentCaptureOwner.service()
      } catch {
        if residentCaptureOwner.terminalFailure != nil
          || (phase == .recording && !residentCaptureOwner.isActive)
        {
          phase = .failed
          needsActiveReconciliation = true
        }
        throw error
      }
      if let terminalFailure = residentCaptureOwner.terminalFailure {
        phase = .failed
        needsActiveReconciliation = true
        throw RoomEngineError.retainedArchiveRecoveryFailed(terminalFailure)
      }
      if let serverEndedSessionID = residentCaptureOwner.serverEndedSessionID {
        if let sessionID, sessionID != serverEndedSessionID {
          phase = .failed
          needsActiveReconciliation = true
          throw RoomEngineError.retainedArchiveRecoveryFailed(
            "server_ended_session_conflict")
        }
        if sessionID == nil {
          transition(to: serverEndedSessionID)
          nextPieceIndex = residentCaptureOwner.nextPrimaryIndex
          nextBackupPieceIndex = residentCaptureOwner.nextBackupIndex ?? 0
          phase = .ending
        }
        do {
          try await stopAfterServerEnd()
        } catch {
          phase = .failed
          needsActiveReconciliation = true
          throw error
        }
        return
      }
      guard phase != .recording || residentCaptureOwner.isActive else {
        phase = .failed
        needsActiveReconciliation = true
        throw RoomEngineError.residentArchiveCaptureStopped
      }
      return
    }
    guard var segment = capture, !segment.process.isRunning else { return }
    segment.process.waitUntilExit()
    do {
      try publishAvailable(segment: &segment, finalFlush: true)
    } catch {
      nextPieceIndex = segment.nextPieceIndex
      capture = segment
      throw error
    }
    nextPieceIndex = segment.nextPieceIndex
    capture = nil
    phase = .failed
    needsActiveReconciliation = true
    throw RoomEngineError.captureExited(segment.process.terminationStatus ?? -1)
  }

  private func stopCaptureAndPublishFinal(reason: RoomResidentCaptureStopReason) throws {
    if let residentCaptureOwner {
      guard residentCaptureOwner.isActive || residentCaptureOwner.requiresFinalization else {
        return
      }
      defer { updateResidentIndices(residentCaptureOwner) }
      try residentCaptureOwner.stopAndFinalize(reason: reason)
      return
    }
    guard var segment = capture else { return }
    segment.process.interrupt()
    segment.process.waitUntilExit()
    do {
      try publishAvailable(segment: &segment, finalFlush: true)
    } catch {
      nextPieceIndex = segment.nextPieceIndex
      capture = segment
      throw error
    }
    nextPieceIndex = segment.nextPieceIndex
    capture = nil
    if let status = segment.process.terminationStatus, status != 0 {
      throw RoomEngineError.captureExited(status)
    }
  }

  private func publishAvailable(finalFlush: Bool) throws {
    if residentCaptureOwner != nil { return }
    guard var segment = capture else { return }
    do {
      try publishAvailable(segment: &segment, finalFlush: finalFlush)
    } catch {
      nextPieceIndex = segment.nextPieceIndex
      capture = segment
      throw error
    }
    nextPieceIndex = segment.nextPieceIndex
    capture = segment
  }

  private func publishAvailable(segment: inout Segment, finalFlush: Bool) throws {
    let pcmSize = try regularFileSizeIfPresent(segment.pcmURL)
    let records = try IndexLog.read(url: segment.indexURL, pcmSize: pcmSize).records
    let plans = try RoomPiecePlanner.plan(
      records: records,
      sessionID: sessionID ?? "",
      segmentID: segment.id,
      startingIndex: segment.nextPieceIndex,
      startingSample: segment.nextSample,
      initialGapBeforeMS: segment.initialGapBeforeMS,
      finalFlush: finalFlush
    )
    let encoder = FFmpegPieceEncoder(
      command: FFmpegEncoderCommand(
        executableURL: URL(fileURLWithPath: configuration.ffmpegPath)),
      runner: pieceRunner)
    for plan in plans {
      let filename = RoomPiecePlan.defaultFilename(sessionID: plan.sessionID, index: plan.index)
      let mediaURL = spool.rootURL.appendingPathComponent(filename)
      let size = try encoder.encode(
        plan: plan, pcmURL: segment.pcmURL, destinationURL: mediaURL)
      let manifest = try plan.manifest(sizeBytes: size, filename: filename)
      _ = try spool.publish(manifest)
      segment.nextSample = plan.sampleEnd
      segment.nextPieceIndex = plan.index + 1
      segment.initialGapBeforeMS = 0
      lastPieceEndedAt = plan.endedAt
    }
  }

  private func drainPending() async throws -> Bool {
    var endedByServer = false
    for pending in try spool.pending() {
      let manifestBytes = try Data(contentsOf: pending.manifestURL)
      let benchPiece = try RoomManifestBenchAdapter.piece(manifestBytes: manifestBytes)
      guard pending.manifest == (try RoomPieceManifest.decodeJSON(manifestBytes)) else {
        throw RoomEngineError.invalidManifestMetadata
      }
      let mediaBytes = try Data(contentsOf: pending.mediaURL)
      let result = try await remote.uploadImmutablePiece(benchPiece, bytes: mediaBytes)
      try spool.removeVerified(
        pending,
        verification: RoomPieceUploadVerification(
          sessionID: benchPiece.sessionID,
          index: benchPiece.index,
          sizeBytes: benchPiece.sizeBytes))
      if case .registered(let response, _) = result, response.endedDisagrees != nil {
        endedByServer = true
      }
    }
    return endedByServer
  }

  private func stopWithoutEnding(reason: RoomResidentCaptureStopReason) async throws {
    do {
      try stopCaptureAndPublishFinal(reason: reason)
      _ = try await drainPending()
    } catch {
      lastError = bounded(error)
      phase = .failed
      needsActiveReconciliation = true
      try? saveStatus()
      throw error
    }
    phase = .superseded
    try saveStatus()
  }

  private func stopAfterSuperseded() async throws {
    var retryNanoseconds: UInt64 = 1_000_000_000
    while true {
      do {
        try await stopWithoutEnding(reason: .superseded)
        return
      } catch {
        if Task.isCancelled { throw CancellationError() }
        try await Task.sleep(nanoseconds: retryNanoseconds)
        retryNanoseconds = min(retryNanoseconds * 2, 30_000_000_000)
      }
    }
  }

  private func updateResidentIndices(_ owner: any RoomResidentCaptureOwning) {
    nextPieceIndex = owner.nextPrimaryIndex
    if let nextBackupIndex = owner.nextBackupIndex {
      nextBackupPieceIndex = nextBackupIndex
    }
  }

  private func stopAfterServerEnd() async throws {
    let residentFinalizationContext = try residentCaptureOwner.map { _ in
      try finalizationContext()
    }
    try stopCaptureAndPublishFinal(reason: .serverEnded)
    if let residentCaptureOwner, let residentFinalizationContext {
      try await residentCaptureOwner.reserveFinalRanges(context: residentFinalizationContext)
      try await residentCaptureOwner.verifyFinalRanges(context: residentFinalizationContext)
    }
    _ = try await drainPending()
    if let finalizedSessionID = residentFinalizationContext?.sessionID {
      try persistServerEndedFinalization(sessionID: finalizedSessionID)
      residentCaptureOwner?.clearServerEndedSessionID(finalizedSessionID)
    }
    transition(to: nil)
    nextPieceIndex = 0
    nextBackupPieceIndex = 0
    reconciledServerSessionID = nil
    reconciledServerSessionStatus = nil
    phase = .ready
    needsActiveReconciliation = true
    lastError = RoomEngineError.sessionEndedByServer.localizedDescription
    try saveStatus()
  }

  private func residentObservedServerEnd(sessionID: String) throws -> Bool {
    guard let observed = residentCaptureOwner?.serverEndedSessionID else { return false }
    guard observed == sessionID else {
      throw RoomEngineError.retainedArchiveRecoveryFailed(
        "server_ended_session_conflict")
    }
    return true
  }

  private func persistServerEndedFinalization(sessionID: String) throws {
    guard let residentControlJournal else {
      throw RoomEngineError.residentArchiveRuntimeUnavailable
    }
    let digest = SHA256.hash(data: Data(sessionID.utf8)).map {
      String(format: "%02x", $0)
    }.joined()
    let commandID = "local_server_ended_\(digest)"
    let recovered = try residentControlJournal.advance(
      RoomControlTransition(
        commandID: commandID,
        commandKind: .serverEndedFinalization,
        sessionID: sessionID,
        priorState: nil,
        newState: .serverEndedFinalized))
    residentControlCommands[commandID] = recovered
  }

  private func currentLevels() -> BenchLevelPair? {
    if let residentCaptureOwner { return residentCaptureOwner.currentLevels() }
    guard let capture,
      let records = try? IndexLog.read(url: capture.indexURL).records,
      let rms = records.reversed().compactMap(\.rms).first
    else { return nil }
    return BenchLevelPair(peak: rms, average: rms)
  }

  private var hasActiveCapture: Bool {
    residentCaptureOwner?.isActive ?? (capture?.process.isRunning == true)
  }

  private func saveStatus(preferred: RoomRecorderStatus.State? = nil) throws {
    let pending = try spool.pending().count
    let state: RoomRecorderStatus.State
    switch phase {
    case .recording, .ending: state = .recording
    case .paused: state = .paused
    case .failed: state = .failed
    case .ready, .superseded:
      state = pending > 0 ? .uploadPending : (preferred ?? .ready)
    }
    try persistence.saveStatus(
      RoomRecorderStatus(
        state: state,
        sessionID: sessionID,
        pendingPieceCount: pending,
        lastError: lastError))
  }

  private static func iso8601(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: date)
  }

  private func transition(to nextSessionID: String?) {
    lastPieceEndedAt = RoomSessionBoundary.retainedPieceEnd(
      currentSessionID: sessionID,
      nextSessionID: nextSessionID,
      pieceEndedAt: lastPieceEndedAt)
    sessionID = nextSessionID
  }
}

private final class RoomEngineInstanceLock: @unchecked Sendable {
  private let fileDescriptor: Int32

  init(root: URL) throws {
    let lockURL = root.appendingPathComponent("room-recorder.lock")
    let descriptor = open(
      lockURL.path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else {
      throw RoomEngineError.io("cannot open instance lock: \(String(cString: strerror(errno)))")
    }
    guard fchmod(descriptor, S_IRUSR | S_IWUSR) == 0 else {
      let code = errno
      close(descriptor)
      throw RoomEngineError.io("cannot secure instance lock: \(String(cString: strerror(code)))")
    }
    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
      close(descriptor)
      throw RoomEngineError.alreadyRunning
    }
    fileDescriptor = descriptor
  }

  deinit {
    flock(fileDescriptor, LOCK_UN)
    close(fileDescriptor)
  }
}

private func createPrivateDirectory(_ url: URL) throws {
  var isDirectory: ObjCBool = false
  if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    guard attributes[.type] as? FileAttributeType != .typeSymbolicLink else {
      throw RoomEngineError.io("directory must not be a symbolic link: \(url.path)")
    }
    guard isDirectory.boolValue else {
      throw RoomEngineError.io("path is not a directory: \(url.path)")
    }
  } else {
    try FileManager.default.createDirectory(
      at: url,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: NSNumber(value: 0o700)])
  }
  try FileManager.default.setAttributes(
    [.posixPermissions: NSNumber(value: 0o700)], ofItemAtPath: url.path)
}

/// The app's half of the launch canary (Release B1, §14.2 step 5, B1-D4).
///
/// ─── DELETING THE FILE IS THE ACKNOWLEDGEMENT ────────────────────────────────────────────────
/// The swap script is at this moment sitting in a two-second loop watching for this file to
/// disappear, and will put the previous bundle back if it is still there 180 seconds after the
/// agent was bootstrapped. Deleting it says the one thing the script needs to know and cannot
/// find out for itself: the version it installed can talk to the server.
///
/// Returns the version the canary named, or nil when there was no canary — which is every poll but
/// the first one after an update, and every poll a room that has never updated will ever make.
///
/// IT DELETES EVEN WHEN IT CANNOT DECODE, and returns nil. A canary this app cannot parse would
/// otherwise sit there until the watchdog rolled back a version that was in fact polling perfectly
/// well — an update undone by a JSON error. The acknowledgement is the load-bearing half and it
/// happens either way; what is lost is the version, which costs a log line and the early clearing
/// of the handover marker, and the marker goes stale on its own half an hour later.
public func roomCanaryAcknowledge(root: URL) -> String? {
  let url = RoomSelfUpdate.canaryURL(root: root)
  guard let data = try? Data(contentsOf: url) else { return nil }
  let decoder = JSONDecoder()
  decoder.dateDecodingStrategy = .iso8601
  let version = (try? decoder.decode(RoomUpdateCanary.self, from: data))?.version
  try? FileManager.default.removeItem(at: url)
  return version
}

private func regularFileSizeIfPresent(_ url: URL) throws -> Int64? {
  guard FileManager.default.fileExists(atPath: url.path) else { return nil }
  let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
  guard attributes[.type] as? FileAttributeType == .typeRegular,
    let number = attributes[.size] as? NSNumber
  else {
    throw RoomEngineError.io("path is not a regular file: \(url.path)")
  }
  return number.int64Value
}

private func safePathComponent(_ value: String) -> String {
  String(value.map { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" ? $0 : "_" })
}

private func bounded(_ error: Error, limit: Int = 500) -> String {
  String(
    (error as? LocalizedError)?.errorDescription?.prefix(limit)
      ?? String(describing: error).prefix(limit))
}
