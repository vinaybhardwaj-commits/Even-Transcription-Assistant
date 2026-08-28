import Darwin
import Foundation
import TapeCore

public enum RoomEngineError: Error, LocalizedError, Equatable, Sendable {
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
  case invalidManifestMetadata
  case io(String)

  public var errorDescription: String? {
    switch self {
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
    primaryLevels: BenchLevelPair?
  ) async throws -> CommandPollResponse
  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse
  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws
    -> ImmutablePieceUploadResult
}

extension BenchClient: RoomEngineRemote {}

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
  private var phase: RoomEnginePhase = .ready
  private var sessionID: String?
  private var nextPieceIndex = 0
  private var capture: Segment?
  private var previousPollAt: String?
  private var completedCommands: [String: CommandResult] = [:]
  private var lastError: String?
  private var lastPieceEndedAt: Date?
  private var needsActiveReconciliation = false
  private let listenerTabID: String
  private var retainedArchiveRecoveryTask: Task<Void, Never>?
  private var retainedArchiveRecoveryState: RoomRetainedArchiveRecoveryState?

  public static func load(
    rootURL: URL = defaultRootURL,
    remoteFactory: @Sendable (RoomConfiguration) -> any RoomEngineRemote = {
      BenchClient(configuration: $0)
    },
    captureLauncher: any RoomCaptureLaunching = FoundationRoomCaptureLauncher(),
    pieceRunner: any RoomPieceProcessRunning = FoundationPieceProcessRunner(),
    retainedArchiveRecovery: (any RoomRetainedArchiveRecovering)? = nil
  ) async throws -> RoomEngine {
    let persistence = RoomPersistence(root: rootURL)
    let configuration = try persistence.loadConfiguration()
    let lock = try RoomEngineInstanceLock(root: persistence.root)
    let captures = persistence.root.appendingPathComponent("captures", isDirectory: true)
    try createPrivateDirectory(captures)
    let spoolURL = persistence.root.appendingPathComponent("spool", isDirectory: true)
    try createPrivateDirectory(spoolURL)
    let spool = try RoomPieceSpool(rootURL: spoolURL)
    return RoomEngine(
      persistence: persistence,
      configuration: configuration,
      remote: remoteFactory(configuration),
      captureLauncher: captureLauncher,
      pieceRunner: pieceRunner,
      spool: spool,
      capturesURL: captures,
      instanceLock: lock,
      retainedArchiveRecovery: retainedArchiveRecovery
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
    retainedArchiveRecovery: (any RoomRetainedArchiveRecovering)?
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
    listenerTabID =
      configuration.tabID ?? configuration.installID
      ?? "native_\(UUID().uuidString.prefix(8).lowercased())"
  }

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

    var backoffNanoseconds: UInt64 = 5_000_000_000
    var uploadRetryAfter = Date.distantPast
    var uploadBackoff: TimeInterval = 5
    while !Task.isCancelled && phase != .superseded {
      do {
        try finishUnexpectedCaptureIfNeeded()
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
        let levels = BenchLevelPair(peak: 0, average: 0)
        let response = try await remote.pollCommands(
          tabID: listenerTabID,
          previousPollAt: previousPollAt,
          recordingSessionID: phase == .recording || phase == .paused ? sessionID : nil,
          paused: phase == .paused,
          primaryLevels: currentLevels() ?? levels
        )
        previousPollAt = response.now ?? previousPollAt
        if response.superseded {
          await stopWithoutEnding()
          await stopRetainedArchiveRecovery()
          break
        }
        if retainedArchiveReady { lastError = nil }
        for command in response.commands {
          await handle(command)
        }
        try saveStatus()
        backoffNanoseconds = 5_000_000_000
        try await Task.sleep(nanoseconds: 1_500_000_000)
      } catch is CancellationError {
        break
      } catch {
        lastError = bounded(error)
        try? saveStatus(preferred: .offline)
        try await Task.sleep(nanoseconds: backoffNanoseconds)
        backoffNanoseconds = min(backoffNanoseconds * 2, 30_000_000_000)
      }
    }

    if Task.isCancelled {
      await stopWithoutEnding()
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
    let configuration = try persistence.loadConfiguration()
    let status = try? persistence.loadStatus()
    return try await BenchClient(configuration: configuration).markConsult(
      sessionID: status?.sessionID,
      at: iso8601(at)
    )
  }

  private func adopt(_ active: ActiveSessionResponse) async throws {
    needsActiveReconciliation = false
    guard active.ok, active.resumable, let session = active.session,
      session.status == .recording || session.status == .paused
    else {
      phase = .ready
      transition(to: nil)
      nextPieceIndex = 0
      try saveStatus()
      return
    }
    guard !active.handoverPending || active.tabGone else {
      phase = .failed
      needsActiveReconciliation = true
      throw RoomEngineError.handoverPending
    }
    transition(to: session.id)
    nextPieceIndex = active.nextIndex?.primary ?? 0
    if session.status == .paused {
      phase = .paused
    } else {
      try startCapture()
      phase = .recording
    }
    try saveStatus()
  }

  private func handle(_ command: BenchCommand) async {
    if let result = completedCommands[command.id] {
      await acknowledge(command.id, result: result)
      return
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
        result = CommandResult(ok: true, sessionID: sessionID, error: nil)
      case .start:
        try await beginOrResume()
        result = CommandResult(ok: true, sessionID: sessionID, error: nil)
      case .resume:
        try await resume()
        result = CommandResult(ok: true, sessionID: sessionID, error: nil)
      case .pause:
        let id = sessionID
        try await pause()
        result = CommandResult(ok: true, sessionID: id, error: nil)
      case .end:
        let id = sessionID
        try await end()
        result = CommandResult(ok: true, sessionID: id, error: nil)
      case .refuse(let reason):
        result = CommandResult(ok: false, sessionID: nil, error: reason)
      }
    } catch {
      lastError = bounded(error)
      if capture?.process.isRunning != true || (phase != .paused && phase != .recording) {
        phase = .failed
      }
      try? saveStatus()
      result = CommandResult(ok: false, sessionID: sessionID, error: bounded(error, limit: 160))
    }
    completedCommands[command.id] = result
    await acknowledge(command.id, result: result)
  }

  private func acknowledge(_ commandID: String, result: CommandResult) async {
    for attempt in 1...3 {
      do {
        _ = try await remote.acknowledge(
          commandID: commandID,
          ok: result.ok,
          sessionID: result.sessionID,
          error: result.error)
        return
      } catch {
        lastError = bounded(error)
        if attempt < 3 {
          try? await Task.sleep(nanoseconds: UInt64(attempt) * 1_000_000_000)
        }
      }
    }
    try? saveStatus(preferred: .offline)
  }

  private func beginOrResume() async throws {
    try await requireRetainedArchiveReady()
    _ = try await drainPending()
    let pending = try spool.pending().count
    guard pending == 0 else { throw RoomEngineError.pendingUploads(pending) }
    let active = try await remote.activeSession(tabID: listenerTabID, since: nil)
    if active.resumable, let existing = active.session {
      guard !active.handoverPending || active.tabGone else {
        throw RoomEngineError.handoverPending
      }
      guard existing.status != .paused else { throw RoomEngineError.roomPaused }
      transition(to: existing.id)
      nextPieceIndex = active.nextIndex?.primary ?? 0
    } else {
      let created = try await remote.createSession(label: nil, micLabel: configuration.deviceUID)
      transition(to: created.session.id)
      nextPieceIndex = 0
    }
    try startCapture()
    phase = .recording
    try saveStatus()
  }

  private func pause() async throws {
    guard let id = sessionID else { throw RoomEngineError.noActiveSession }
    try stopCaptureAndPublishFinal()
    do {
      _ = try await remote.patchSession(id: id, action: .pause, notes: nil)
      phase = .paused
      try saveStatus()
    } catch {
      phase = .failed
      throw error
    }
  }

  private func resume() async throws {
    try await requireRetainedArchiveReady()
    guard let id = sessionID else { throw RoomEngineError.noActiveSession }
    _ = try await remote.patchSession(id: id, action: .resume, notes: nil)
    do {
      try startCapture()
      phase = .recording
      try saveStatus()
    } catch {
      _ = try? await remote.patchSession(id: id, action: .pause, notes: nil)
      phase = .paused
      throw error
    }
  }

  private func end() async throws {
    guard let id = sessionID else { throw RoomEngineError.noActiveSession }
    phase = .ending
    try saveStatus()
    try stopCaptureAndPublishFinal()
    var finalError: Error?
    for attempt in 1...3 {
      do {
        if try await drainPending() {
          transition(to: nil)
          nextPieceIndex = 0
          phase = .ready
          try saveStatus()
          return
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
    _ = try await remote.patchSession(id: id, action: .end, notes: nil)
    transition(to: nil)
    nextPieceIndex = 0
    phase = .ready
    try saveStatus()
  }

  private func startCapture() throws {
    guard capture == nil else { throw RoomEngineError.captureAlreadyActive }
    guard let sessionID else { throw RoomEngineError.noActiveSession }
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

  private func finishUnexpectedCaptureIfNeeded() throws {
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

  private func stopCaptureAndPublishFinal() throws {
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

  private func stopWithoutEnding() async {
    do {
      try stopCaptureAndPublishFinal()
      _ = try await drainPending()
    } catch {
      lastError = bounded(error)
    }
    phase = .superseded
    try? saveStatus()
  }

  private func stopAfterServerEnd() async throws {
    try stopCaptureAndPublishFinal()
    _ = try await drainPending()
    transition(to: nil)
    nextPieceIndex = 0
    phase = .ready
    needsActiveReconciliation = true
    lastError = RoomEngineError.sessionEndedByServer.localizedDescription
    try saveStatus()
  }

  private func currentLevels() -> BenchLevelPair? {
    guard let capture,
      let records = try? IndexLog.read(url: capture.indexURL).records,
      let rms = records.reversed().compactMap(\.rms).first
    else { return nil }
    return BenchLevelPair(peak: rms, average: rms)
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
