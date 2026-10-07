import Foundation

/// The last MicModeGuard result, written by tapewriter beside its tape and carried into the
/// recorder's `status.json` as `mic_mode`.
public struct MicModeStatus: Codable, Equatable, Sendable {
  public var before: Int
  public var after: Int
  /// "ok", "skip", "fail" or "unreadable".
  public var set: String
  /// ISO 8601, UTC.
  public var at: String

  public init(before: Int, after: Int, set: String, at: String) {
    self.before = before
    self.after = after
    self.set = set
    self.at = at
  }

  public static let fileName = "mic_mode.json"

  public static func write(_ status: MicModeStatus, directory: URL) {
    guard let data = try? JSONEncoder().encode(status) else { return }
    try? data.write(
      to: directory.appendingPathComponent(fileName, isDirectory: false), options: .atomic)
  }

  public static func read(directory: URL) -> MicModeStatus? {
    guard
      let data = try? Data(
        contentsOf: directory.appendingPathComponent(fileName, isDirectory: false))
    else { return nil }
    return try? JSONDecoder().decode(MicModeStatus.self, from: data)
  }
}
