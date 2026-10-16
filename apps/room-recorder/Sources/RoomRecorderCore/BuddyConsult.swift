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

public enum BuddyConsultOutcome: Equatable, Sendable {
  /// The window is open and the tap is serving.
  case opened(port: UInt16)
  /// The same consult is already live; nothing was reopened (A2-C3: no re-open while the consult is live).
  case alreadyOpen
  /// The kill switch is on for this consult: no window, no tap.
  case off
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

  /// `buddy-tap.json`: the port and the token for the local Buddy process. Mode 0600, written when a consult opens,
  /// deleted when it ends. The token is never logged.
  public static let tapFileName = "buddy-tap.json"

  public init(
    root: URL, state: BuddyStateBox, presenter: any BuddyWindowPresenting,
    log: @escaping @Sendable (String) -> Void
  ) {
    self.root = root
    self.state = state
    self.presenter = presenter
    self.log = log
    self.makeToken = { BuddyToken.make() }
  }

  init(
    root: URL, state: BuddyStateBox, presenter: any BuddyWindowPresenting,
    log: @escaping @Sendable (String) -> Void, makeToken: @escaping @Sendable () -> String?
  ) {
    self.root = root
    self.state = state
    self.presenter = presenter
    self.log = log
    self.makeToken = makeToken
  }

  public var isLive: Bool { lock.withLock { liveID != nil } }
  public var liveOpaqueID: String? { lock.withLock { liveID } }

  public func consultStarted(opaqueID: String, buddyOff: Bool) -> BuddyConsultOutcome {
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
      guard let minted = token ?? makeToken() else {
        log("encounter buddy: no random source, tap not started (opaque_id \(opaqueID))")
        return .tapUnavailable
      }
      token = minted
      let server = BuddyTapServer(token: minted, opaqueID: opaqueID, state: state)
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
      let url = URL(string: "http://127.0.0.1:\(port)/encounter/\(opaqueID)")!
      presenter.open(url: url, opaqueID: opaqueID)
      log("encounter buddy: window open (opaque_id \(opaqueID))")
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
    server?.stopServing()
    server?.stop()
    server = nil
    liveID = nil
    try? FileManager.default.removeItem(at: root.appendingPathComponent(Self.tapFileName))
    presenter.close(opaqueID: live)
    log("encounter buddy: window closed (opaque_id \(live)) (\(reason))")
    return .closed
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
