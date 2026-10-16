import Foundation

// Encounter Buddy, L1 (0.1.41) — what `consult_started` and `consult_ended` do.
//
// The rules this file keeps (Fable A1-C10, A2-C3, A2-C6, A2-C17):
//  * It never starts, stops, pauses or reconfigures recording, and never touches the microphone permission, the input
//    device, the recorder's enable state or status.json. It only reads the engine's state box.
//  * `buddy_off` (the per-room, per-doctor kill switch newcat applies per consult) means NO window and a tap that
//    serves nothing. The field name is INFERRED; see the report.
//  * Only the opaque id is ever written to the log. No doctor, consult or prescription uid exists on this Mac.

/// Where the window goes. The AppKit implementation is `BuddyWindowPresenter`; tests substitute their own.
public protocol BuddyWindowPresenting: Sendable {
  func open(url: URL, opaqueID: String)
  func close(opaqueID: String)
}

/// The window's fixed policy (Fable A2-C3). Pure values, so a test can pin them without a window server.
public enum BuddyWindowPolicy {
  public static let title = "Encounter Buddy"
  public static let width = 340.0
  public static let height = 190.0
  /// Distance from the bottom-right corner of the main display's visible area. INFERRED: newcat has not named the
  /// Pulse window area; the bottom-right corner is the one corner a clinic Mac's browser content does not reach.
  public static let margin = 16.0
  /// The window is ordered front without becoming key, never activates the app, and sits at the normal level.
  public static let becomesKey = false
  public static let activatesApp = false
  public static let floatsAboveOtherApps = false
  public static let hasCloseControl = true
}

/// 0.1.42. What a runner is built from. The runner itself lives in `BuddyRunner.swift`.
public struct BuddyRunnerContext: Sendable {
  public let opaqueID: String
  public let tapPort: UInt16
  public let tapToken: String
  public let transcript: BuddyLiveTranscript
  public let window: any BuddyRunnerWindowControlling
  public let log: @Sendable (String) -> Void
}

/// Decided BEFORE the tap starts: nil means no usable `buddy-runner.json` on this Mac, so no runner. (0.1.43: that no
/// longer means "window at once"; the window follows the payload's `window` alone.) Otherwise it returns the builder
/// for this consult's runner.
public typealias BuddyRunnerPlan = @Sendable () -> (@Sendable (BuddyRunnerContext) -> BuddyRunner)?

public enum BuddyConsultOutcome: Equatable, Sendable {
  /// The window is open and the tap is serving.
  case opened(port: UInt16)
  /// The same consult is already live; nothing was reopened (A2-C3: no re-open while the consult is live).
  case alreadyOpen
  /// The kill switch is on for this consult: no window, no tap.
  case off
  /// 0.1.43. The payload did not say `window === true` and there is no runner to start: no window, no tap, no page.
  case noWindow
  /// The opaque id is not the shape newcat mints.
  case badID
  /// The tap could not be started. The recording is untouched.
  case tapUnavailable
  /// A `consult_ended` closed the window.
  case closed
  /// A `consult_ended` with nothing open.
  case nothingOpen
}

public final class BuddyConsultController: @unchecked Sendable {
  private let root: URL
  private let state: BuddyStateBox
  private let presenter: any BuddyWindowPresenting
  private let log: @Sendable (String) -> Void
  private let makeToken: @Sendable () -> String?
  private let lock = NSLock()
  private var token: String?
  private var server: BuddyTapServer?
  private var liveID: String?
  private let runnerPlan: BuddyRunnerPlan?
  private var runner: BuddyRunner?
  private var runnerTask: Task<Void, Never>?
  private var windowOpen = false
  /// 0.1.43. The payload's `window === true` for the live consult. A runner may ask for the window only while this is set.
  private var windowPermitted = false
  /// 0.1.43. How many consults wanted a runner (`live === true`) and found no usable config. Counts only.
  private var noConfigCount = 0

  /// `buddy-tap.json`: the port and the token for the local Buddy process. Mode 0600, written when a consult opens,
  /// deleted when it ends. The token is never logged.
  public static let tapFileName = "buddy-tap.json"

  public init(
    root: URL, state: BuddyStateBox, presenter: any BuddyWindowPresenting,
    log: @escaping @Sendable (String) -> Void, runnerPlan: BuddyRunnerPlan? = nil
  ) {
    self.root = root
    self.state = state
    self.presenter = presenter
    self.log = log
    self.makeToken = { BuddyToken.make() }
    self.runnerPlan = runnerPlan
  }

  init(
    root: URL, state: BuddyStateBox, presenter: any BuddyWindowPresenting,
    log: @escaping @Sendable (String) -> Void, makeToken: @escaping @Sendable () -> String?,
    runnerPlan: BuddyRunnerPlan? = nil
  ) {
    self.root = root
    self.state = state
    self.presenter = presenter
    self.log = log
    self.makeToken = makeToken
    self.runnerPlan = runnerPlan
  }

  public var isLive: Bool { lock.withLock { liveID != nil } }
  public var liveOpaqueID: String? { lock.withLock { liveID } }

  /// 0.1.43 (fail closed). `window` and `live` are the payload's, each true ONLY for a JSON `true`: absent, null, a
  /// string or false arrive here as false. A window opens only when `window` is true. A runner starts only when `live`
  /// is true and `buddy-runner.json` is usable. There is no default for either argument, on purpose.
  public func consultStarted(opaqueID: String, buddyOff: Bool, window: Bool, live: Bool) -> BuddyConsultOutcome {
    guard BuddyTapServer.isValidOpaqueID(opaqueID) else { return .badID }
    if buddyOff {
      // The kill switch on a consult that is already live closes it; on a fresh one it opens nothing.
      let wasLive = lock.withLock { liveID != nil }
      if wasLive { _ = tearDown(reason: "buddy_off") }
      log("encounter buddy: off for this consult, no window opened (opaque_id \(opaqueID))")
      return .off
    }
    return lock.withLock {
      if liveID == opaqueID { return .alreadyOpen }
      if liveID != nil { _ = tearDownLocked(reason: "replaced") }
      // The runner plan is asked only for a live session. No usable config is one counted line per consult.
      let build = live ? runnerPlan?() : nil
      if live && build == nil {
        noConfigCount += 1
        log("buddy runner: no config count \(noConfigCount) (opaque_id \(opaqueID))")
      }
      guard window || build != nil else {
        log("encounter buddy: no window and no runner for this consult (opaque_id \(opaqueID))")
        return .noWindow
      }
      guard let minted = token ?? makeToken() else {
        log("encounter buddy: no random source, tap not started (opaque_id \(opaqueID))")
        return .tapUnavailable
      }
      token = minted
      let server = BuddyTapServer(token: minted, opaqueID: opaqueID, state: state)
      // With a runner the page does not exist until the payload and newcat both say `window` is true (ADDENDUM 1).
      if build != nil { server.setPageEnabled(false) }
      let port: UInt16
      do {
        port = try server.start()
      } catch {
        log("encounter buddy: tap not started (\(error)) (opaque_id \(opaqueID))")
        return .tapUnavailable
      }
      guard writeTapFile(port: port, token: minted) else {
        server.stop()
        log("encounter buddy: tap file not written, tap not started (opaque_id \(opaqueID))")
        return .tapUnavailable
      }
      self.server = server
      liveID = opaqueID
      windowPermitted = window
      guard let build else {
        // No runner, and the payload said `window === true` (the guard above): the 0.1.41 window, no POSTs.
        openWindowLocked(opaqueID: opaqueID)
        return .opened(port: port)
      }
      let transcript = BuddyLiveTranscript(opaqueID: opaqueID)
      server.attach(transcript: transcript)
      let context = BuddyRunnerContext(
        opaqueID: opaqueID, tapPort: port, tapToken: minted, transcript: transcript,
        window: ConsultWindow(opaqueID: opaqueID, controller: self), log: log)
      let runner = build(context)
      self.runner = runner
      runnerTask = Task { await runner.run() }
      log("encounter buddy: runner started, no window until the flags say so (opaque_id \(opaqueID))")
      return .opened(port: port)
    }
  }

  /// `opaqueID` nil closes whatever is open (a bare `consult_ended`). A different id than the live one is ignored.
  public func consultEnded(opaqueID: String?) -> BuddyConsultOutcome {
    lock.withLock {
      guard let live = liveID else { return .nothingOpen }
      if let opaqueID, opaqueID != live { return .nothingOpen }
      return tearDownLocked(reason: "consult_ended")
    }
  }

  /// The process is going away (restart, update): close what is open, so no window outlives its server.
  public func shutdown() {
    lock.withLock { if liveID != nil { _ = tearDownLocked(reason: "shutdown") } }
  }

  private func tearDown(reason: String) -> BuddyConsultOutcome {
    lock.withLock { tearDownLocked(reason: reason) }
  }

  private func tearDownLocked(reason: String) -> BuddyConsultOutcome {
    guard let live = liveID else { return .nothingOpen }
    // Stop sending first, and drop the ring: nothing is sent after a consult ends, a kill or a cap stop.
    if let runner {
      runner.haltNow()  // at once: no chunk is cut or sent after this line, whatever the actor is in the middle of
      let task = runnerTask
      Task { task?.cancel(); await runner.stop() }
    }
    runner = nil
    runnerTask = nil
    server?.stopServing()
    server?.stop()
    server = nil
    liveID = nil
    windowPermitted = false
    try? FileManager.default.removeItem(at: root.appendingPathComponent(Self.tapFileName))
    if windowOpen {
      presenter.close(opaqueID: live)
      windowOpen = false
      log("encounter buddy: window closed (opaque_id \(live)) (\(reason))")
    } else {
      log("encounter buddy: consult closed, no window was open (opaque_id \(live)) (\(reason))")
    }
    return .closed
  }

  private func openWindowLocked(opaqueID: String) {
    guard !windowOpen, let server else { return }
    server.setPageEnabled(true)
    let url = URL(string: "http://127.0.0.1:\(server.port)/encounter/\(opaqueID)")!
    presenter.open(url: url, opaqueID: opaqueID)
    windowOpen = true
    log("encounter buddy: window open (opaque_id \(opaqueID))")
  }

  /// The runner's request, for ITS consult only. A runner that outlives its consult cannot open or close anything.
  fileprivate func setWindow(opaqueID: String, open: Bool, reason: String) {
    lock.withLock {
      guard liveID == opaqueID else { return }
      if open {
        // The payload is the first gate: a flags answer cannot open a window the relay did not allow.
        guard windowPermitted else {
          log("encounter buddy: window request refused, the payload did not allow a window (opaque_id \(opaqueID))")
          return
        }
        openWindowLocked(opaqueID: opaqueID)
      } else if windowOpen {
        server?.setPageEnabled(false)
        presenter.close(opaqueID: opaqueID)
        windowOpen = false
        log("encounter buddy: window closed (opaque_id \(opaqueID)) (\(reason))")
      }
    }
  }

  private func writeTapFile(port: UInt16, token: String) -> Bool {
    let url = root.appendingPathComponent(Self.tapFileName)
    let temporary = root.appendingPathComponent(".\(Self.tapFileName).\(UUID().uuidString).tmp")
    let body = Data("{\"port\":\(port),\"token\":\"\(token)\"}".utf8)
    let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
    guard fd >= 0 else { return false }
    let wrote = body.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) } == body.count
    close(fd)
    guard wrote, rename(temporary.path, url.path) == 0 else {
      try? FileManager.default.removeItem(at: temporary)
      return false
    }
    return true
  }
}

/// The runner's handle on one consult's window.
private final class ConsultWindow: BuddyRunnerWindowControlling, @unchecked Sendable {
  let opaqueID: String
  private weak var controller: BuddyConsultController?
  init(opaqueID: String, controller: BuddyConsultController) {
    self.opaqueID = opaqueID
    self.controller = controller
  }
  func setWindow(open: Bool, reason: String) { controller?.setWindow(opaqueID: opaqueID, open: open, reason: reason) }
}

extension BuddyConsultController {
  /// The plan a resident app uses: a runner exists only where `buddy-runner.json` is present and usable in the room root
  /// (and the payload said `live`), read afresh at each consult so a Mac can be switched on or off without a restart.
  public static func filePlan(root: URL, log: @escaping @Sendable (String) -> Void) -> BuddyRunnerPlan {
    {
      guard let config = BuddyRunnerConfig.load(root: root, log: log) else { return nil }
      return { context in
        BuddyRunner(
          opaqueID: context.opaqueID, transport: BuddyHTTPTransport(config: config),
          pcm: BuddyTapReader(port: context.tapPort, token: context.tapToken), window: context.window,
          transcript: context.transcript, log: context.log)
      }
    }
  }
}
