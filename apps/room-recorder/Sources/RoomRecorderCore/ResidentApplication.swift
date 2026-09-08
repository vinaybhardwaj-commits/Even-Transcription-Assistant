import AppKit
import Foundation

/// The resident app's process shape (Install and Fleet PRD §5.2; V's ruling of 8 September 2026).
///
/// ─── WHY THERE IS AN NSAPPLICATION HERE AT ALL ───────────────────────────────────────────────
/// `room-recorder run` was a plain command-line binary started by launchd. It polled perfectly
/// well, and it could never obtain a microphone. `AVCaptureDevice.requestAccess` returned FALSE
/// immediately with no dialog on screen, and macOS recorded a denial; enabling the app by hand in
/// System Settings did not take effect either. TCC has to attach its dialog to something, and a
/// process with no run loop and no application identity gives it nothing to attach to.
///
/// So the resident app is a real `NSApplication` with `.accessory` activation policy: it has a run
/// loop and an application identity, and it still has no Dock icon, no menu bar and no window —
/// the same thing `LSUIElement` promises in §5.2, now actually true of the process and not only of
/// the plist.
///
/// R3 wants this shape regardless: a self-update needs an app identity to replace, and D1 binds the
/// microphone grant to that identity.
///
/// ─── THE ORDER MATTERS ───────────────────────────────────────────────────────────────────────
/// The microphone is requested from `applicationDidFinishLaunching`, which is to say AFTER the run
/// loop is up. Asking before it exists is what the previous version did, and it is why the answer
/// came back instantly and negative.
///
/// THE ENGINE STARTS WHATEVER THE ANSWER IS. A room whose microphone was refused must still poll,
/// so the fleet card can say `denied` and send someone to System Settings. Refusing to start would
/// turn a fixable permission into a Mac that looks dead.
public enum ResidentApplication {

  /// Run the resident app. Never returns — the process ends with the run loop.
  public static func run(work: @escaping @Sendable () async -> Int32) -> Never {
    let application = NSApplication.shared
    let delegate = Delegate(work: work)
    application.delegate = delegate
    // No Dock icon, no menu bar, no window. `.accessory` rather than `.prohibited` because
    // `.prohibited` is what a process with no UI at all declares, and TCC will not present a
    // dialog on behalf of one.
    application.setActivationPolicy(.accessory)
    application.run()
    // `NSApplication.run()` only returns after `terminate(_:)`, and the delegate exits before
    // that. This is here so the signature can be `Never` honestly.
    exit(0)
  }

  private final class Delegate: NSObject, NSApplicationDelegate {
    private let work: @Sendable () async -> Int32

    init(work: @escaping @Sendable () async -> Int32) {
      self.work = work
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
      let work = self.work
      MachineFactsReader.requestMicrophoneAccess { state in
        // Say what the machine answered, on stderr, which launchd captures to the room's log.
        // MEASURED after asking — `not_determined` here would mean macOS declined to prompt at
        // all, which is a different fault from a person clicking Don't Allow.
        FileHandle.standardError.write(Data("room-recorder: microphone \(state)\n".utf8))
        Task.detached {
          let code = await work()
          exit(code)
        }
      }
    }
  }
}
