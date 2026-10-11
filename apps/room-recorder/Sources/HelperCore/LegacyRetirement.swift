import FleetCore
import Foundation

/// #48 (TS-H11): `retire_legacy{component:"presence-guard"}`.
///
/// The standalone presence-guard is a root LaunchDaemon (`com.eta.presence-guard`) with a script, an env file that
/// holds the OLD ingest token, and a state directory. Once the helper owns the Chrome policy on this Mac, the helper
/// boots it out and takes it away.
///
/// GUARDED: nothing happens unless the helper's own policy is active here (a stored config, and the live managed
/// plist checked right within the last five minutes). Without that, removing the guard would leave the extension
/// unmanaged.
/// REVERSIBLE: nothing is deleted. The four artifacts are MOVED into a root-only archive under the helper's support
/// directory, with a `RESTORE.txt` that holds the exact commands to put them back. Only an order with
/// `purge_secrets: true` deletes the env file (the old token) instead of archiving it.
public final class LegacyRetirement: @unchecked Sendable {
  public static let label = "com.eta.presence-guard"
  public static let component = "presence-guard"

  /// `prefix` is "" in production; a test points it at a sandbox directory.
  private let prefix: String
  private let tools: SystemTools
  private let policyActive: @Sendable () -> Bool
  private let now: @Sendable () -> Date
  private let sleep: @Sendable (TimeInterval) -> Void
  private let archiveRoot: String
  private let log: @Sendable (String) -> Void

  public init(
    prefix: String = "", tools: SystemTools, policyActive: @escaping @Sendable () -> Bool,
    archiveRoot: String = HelperPaths.supportDirectory + "/retired", now: @escaping @Sendable () -> Date = { Date() },
    sleep: @escaping @Sendable (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) },
    log: @escaping @Sendable (String) -> Void
  ) {
    self.prefix = prefix
    self.tools = tools
    self.policyActive = policyActive
    self.now = now
    self.sleep = sleep
    self.archiveRoot = archiveRoot
    self.log = log
  }

  /// (name in the archive, path on the Mac, whether it holds a secret)
  static let artifacts: [(name: String, path: String, secret: Bool)] = [
    ("plist", "/Library/LaunchDaemons/com.eta.presence-guard.plist", false),
    ("script", "/usr/local/libexec/eta-presence-guard.sh", false),
    ("env", "/usr/local/etc/eta-presence-guard.env", true),
    ("state", "/var/db/eta-presence-guard", false),
  ]

  private func exists(_ path: String) -> Bool {
    var info = stat()
    return lstat(prefix + path, &info) == 0
  }

  private func jobLoaded() -> Bool {
    tools.run("/bin/launchctl", ["print", "system/\(Self.label)"]).status == 0
  }

  public func retire(purgeSecrets: Bool) -> HelperCommandOutcome {
    let present = Self.artifacts.filter { exists($0.path) }
    if present.isEmpty, !jobLoaded() {
      return HelperCommandOutcome(.ok, detail: ["state": .string("already_retired")])
    }
    guard policyActive() else {
      log("retire_legacy: refused, the helper's Chrome policy is not active here")
      return HelperCommandOutcome(.refused, reason: "policy_not_active")
    }
    // 1. Out, and wait until launchd has really let go of it. Nothing has moved yet, so a failure here changes nothing.
    _ = tools.run("/bin/launchctl", ["bootout", "system/\(Self.label)"])
    var waited = 0
    while jobLoaded(), waited < 10 {
      sleep(1)
      waited += 1
    }
    guard !jobLoaded() else { return HelperCommandOutcome(.failed, reason: "still_loaded") }

    // 2. Move, one by one; on a failure put back what was already moved.
    let stamp = Int(now().timeIntervalSince1970)
    let directory = "\(archiveRoot)/\(Self.component)-\(stamp)"
    let archive = prefix + directory
    do {
      try FileManager.default.createDirectory(
        atPath: archive, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    } catch {
      return HelperCommandOutcome(.failed, reason: "archive_not_created")
    }
    var moved: [(from: String, to: String)] = []
    var archived: [String] = []
    var purged = false
    for artifact in present {
      let source = prefix + artifact.path
      if artifact.secret, purgeSecrets {
        guard (try? FileManager.default.removeItem(atPath: source)) != nil else {
          rollBack(moved)
          return HelperCommandOutcome(.failed, reason: "move_failed")
        }
        purged = true
        continue
      }
      let target = "\(archive)/\(artifact.name)"
      do {
        try FileManager.default.moveItem(atPath: source, toPath: target)
      } catch {
        rollBack(moved)
        return HelperCommandOutcome(.failed, reason: "move_failed")
      }
      moved.append((source, target))
      archived.append(artifact.name)
    }
    let restore = restoreText(archived: present.filter { archived.contains($0.name) }, directory: directory)
    try? restore.write(toFile: archive + "/RESTORE.txt", atomically: true, encoding: .utf8)
    log("retire_legacy: \(Self.component) retired (\(archived.count) archived, secrets \(purged ? "deleted" : "archived"))")
    return HelperCommandOutcome(
      .ok,
      detail: [
        "state": .string("retired"), "archived": .array(archived.map(FleetJSON.string)),
        "env_deleted": .bool(purged), "archive": .string(directory),
      ])
  }

  private func rollBack(_ moved: [(from: String, to: String)]) {
    for item in moved.reversed() { try? FileManager.default.moveItem(atPath: item.to, toPath: item.from) }
  }

  private func restoreText(archived: [(name: String, path: String, secret: Bool)], directory: String) -> String {
    // Both daemons write the same forcelist entry, so putting the guard back does not make them fight.
    var lines = ["Retired presence-guard. To put it back, as root:"]
    for item in archived { lines.append("  mv \"\(directory)/\(item.name)\" \"\(item.path)\"") }
    lines.append("  launchctl bootstrap system /Library/LaunchDaemons/\(Self.label).plist")
    return lines.joined(separator: "\n") + "\n"
  }
}
