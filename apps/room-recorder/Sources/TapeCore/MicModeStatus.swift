import Foundation

/// The last MicModeGuard result, written by tapewriter beside its tape and carried into the
/// recorder's `status.json` as `mic_mode`.
public struct MicModeStatus: Codable, Equatable, Sendable {
  public var before: Int
  public var after: Int
  /// "ok", "skip", "fail", "timeout" or "unreadable".
  public var set: String
  /// ISO 8601, UTC.
  public var at: String
  /// Elapsed milliseconds of the Set call; nil when no Set ran.
  public var setMs: Int?
  /// "mic_mode_reset" when the watchdog reset the mode in place; nil otherwise.
  public var lastEvent: String?

  enum CodingKeys: String, CodingKey {
    case before, after, set, at
    case setMs = "set_ms"
    case lastEvent = "last_event"
  }

  public init(
    before: Int, after: Int, set: String, at: String, setMs: Int? = nil, lastEvent: String? = nil
  ) {
    self.before = before
    self.after = after
    self.set = set
    self.at = at
    self.setMs = setMs
    self.lastEvent = lastEvent
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
