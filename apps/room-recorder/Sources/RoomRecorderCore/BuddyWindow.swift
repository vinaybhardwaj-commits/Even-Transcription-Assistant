import AppKit
import Foundation
import WebKit

/// Encounter Buddy, L1 (0.1.41) — the recorder's own window (Fable C3, A2-C3).
///
/// ─── NEVER CHROME, NEVER FOCUS ─────────────────────────────────────────────────────────────────
/// The page is shown by a WKWebView inside this app. No browser, no osascript, no python3. The panel is
/// non-activating and cannot become key, so a doctor typing in Chrome keeps typing in Chrome: the command orders the
/// panel front and nothing else. This file never calls `NSApplication.activate`, `orderFrontRegardless`,
/// `makeKey*` or `makeMain`, and never raises the window level. `BuddyWindowPolicy` pins the same facts as values.
///
/// The close button on the panel is the one-click hide. Hiding does not end the consult and does not reopen:
/// `consult_started` for the id that is live is a no-op (`BuddyConsultController.alreadyOpen`).
public final class BuddyWindowPresenter: BuddyWindowPresenting, @unchecked Sendable {
  private var panel: NonKeyPanel?

  public init() {}

  public func open(url: URL, opaqueID: String) {
    DispatchQueue.main.async { [self] in
      close(now: true)
      let frame = Self.frame()
      let panel = NonKeyPanel(
        contentRect: frame,
        styleMask: [.titled, .closable, .nonactivatingPanel, .utilityWindow],
        backing: .buffered, defer: false)
      panel.title = BuddyWindowPolicy.title
      panel.isReleasedWhenClosed = false
      panel.hidesOnDeactivate = false
      panel.becomesKeyOnlyIfNeeded = true
      panel.level = .normal
      panel.isFloatingPanel = false
      let web = WKWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: WKWebViewConfiguration())
      panel.contentView = web
      web.load(URLRequest(url: url))
      panel.orderFront(nil)
      self.panel = panel
    }
  }

  public func close(opaqueID: String) {
    DispatchQueue.main.async { [self] in close(now: true) }
  }

  private func close(now: Bool) {
    guard let panel else { return }
    (panel.contentView as? WKWebView)?.stopLoading()
    panel.contentView = nil
    panel.orderOut(nil)
    panel.close()
    self.panel = nil
  }

  /// Bottom-right of the main display's visible area. `NSScreen.main` is the display with the key window; with none it
  /// is the primary one, which is the doctor's display on a clinic Mac.
  static func frame() -> NSRect {
    let area = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
    return NSRect(
      x: area.maxX - BuddyWindowPolicy.width - BuddyWindowPolicy.margin,
      y: area.minY + BuddyWindowPolicy.margin,
      width: BuddyWindowPolicy.width, height: BuddyWindowPolicy.height)
  }
}

/// A panel that never takes key or main status.
private final class NonKeyPanel: NSPanel {
  override var canBecomeKey: Bool { BuddyWindowPolicy.becomesKey }
  override var canBecomeMain: Bool { false }
}
