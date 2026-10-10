import Foundation

/// Keeps `config.json`'s helper paths pointing INTO the bundle that is running (0.1.30).
///
/// ─── WHY ──────────────────────────────────────────────────────────────────────────────────
/// After the 0.1.29 pkg install on OPD 6, `tapewriter_path` and `ffmpeg_path` still named the old
/// `~/Applications` copy, so the new app recorded with the OLD bundle's tapewriter. The paths were
/// written once at enrolment and nothing moved them when the bundle moved.
///
/// Rule: if a configured path is outside the running bundle, and the running bundle has its own copy
/// of that tool, the configuration is rewritten to the bundle's copy and the change is logged. A
/// path already inside the bundle is left alone. A bundle without the tool changes nothing.
/// When the resident-archive lane is on, the preflight receipt seals the encoder path, so a rewrite
/// would make the next start refuse; nothing is rewritten and the reason is logged.
public enum RoomConfigurationRebase {
  public struct Change: Equatable, Sendable {
    public var field: String
    public var from: String
    public var to: String
  }

  @discardableResult
  public static func apply(
    root: URL,
    bundleURL: URL? = Bundle.main.bundleURL,
    bundledHelper: (String) -> String? = { BuildInfo.bundledHelper($0) },
    log: (String) -> Void
  ) -> [Change] {
    guard let bundleURL, bundleURL.pathExtension == "app" else { return [] }
    let persistence = RoomPersistence(root: root)
    guard var configuration = try? persistence.loadConfiguration() else { return [] }
    let bundlePath = bundleURL.resolvingSymlinksInPath().path
    var changes: [Change] = []

    func rebase(_ field: String, _ tool: String, _ current: String, set: (String) -> Void) {
      guard let bundled = bundledHelper(tool) else { return }
      let resolved = URL(fileURLWithPath: current).resolvingSymlinksInPath().path
      if resolved.hasPrefix(bundlePath + "/") { return }
      guard resolved != URL(fileURLWithPath: bundled).resolvingSymlinksInPath().path else { return }
      changes.append(Change(field: field, from: current, to: bundled))
      set(bundled)
    }
    rebase("tapewriter_path", "tapewriter", configuration.tapewriterPath) { configuration.tapewriterPath = $0 }
    rebase("ffmpeg_path", "ffmpeg", configuration.ffmpegPath) { configuration.ffmpegPath = $0 }
    guard !changes.isEmpty else { return [] }

    if configuration.residentArchiveCaptureEnabled {
      log("config: helper paths are outside the running bundle but the resident archive lane is on; left as they are")
      return []
    }
    do {
      try persistence.saveConfiguration(configuration)
    } catch {
      log("config: could not rewrite helper paths: \(String(describing: error).prefix(120))")
      return []
    }
    for change in changes { log("config: \(change.field) \(change.from) → \(change.to)") }
    return changes
  }
}
