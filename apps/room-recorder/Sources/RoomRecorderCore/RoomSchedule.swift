import Foundation

/// 0.1.25 — the per-room schedule and the auto-start decision. A Swift port of `lib/room-schedule.ts`
/// (same window rules, same tests): clinic rooms every day 08:30–20:30 IST; a window whose `end` is
/// at or before its `start` crosses midnight and belongs to the day it STARTS on.
///
/// PURE. Every function takes the clock as a parameter. IST has no DST, so a fixed UTC offset is
/// exact.
public struct RoomScheduleWindow: Equatable, Sendable {
  public var days: [Int]  // weekday the window STARTS on, 0 = Sunday … 6 = Saturday
  public var start: String  // "HH:MM"
  public var end: String  // "HH:MM"; at or before `start` = ends the next calendar day

  public init(days: [Int], start: String, end: String) {
    self.days = days
    self.start = start
    self.end = end
  }
}

public struct RoomSchedule: Equatable, Sendable {
  public var utcOffsetMinutes: Int
  public var windows: [RoomScheduleWindow]

  public init(utcOffsetMinutes: Int, windows: [RoomScheduleWindow]) {
    self.utcOffsetMinutes = utcOffsetMinutes
    self.windows = windows
  }

  /// Every day, 08:30–20:30 IST (the whole hospital runs 7 days a week).
  public static let defaultClinic = RoomSchedule(
    utcOffsetMinutes: 330,
    windows: [RoomScheduleWindow(days: [0, 1, 2, 3, 4, 5, 6], start: "08:30", end: "20:30")])

  /// The window `now` falls inside — start inclusive, end exclusive, real instants in epoch
  /// milliseconds — or nil. A malformed window is skipped, never guessed at.
  public func activeWindow(at now: Date) -> (startMs: Int64, endMs: Int64)? {
    let nowMs = Int64((now.timeIntervalSince1970 * 1000).rounded(.down))
    let dayMs: Int64 = 86_400_000
    let offsetMs = Int64(utcOffsetMinutes) * 60_000
    let todayIndex = Int64((Double(nowMs + offsetMs) / Double(dayMs)).rounded(.down))
    for dayIndex in [todayIndex - 1, todayIndex] {
      let weekday = Int((((dayIndex + 4) % 7) + 7) % 7)  // 1970-01-01 was a Thursday
      let dayStartMs = dayIndex * dayMs - offsetMs
      for window in windows where window.days.contains(weekday) {
        guard let s = Self.minutes(window.start), let e = Self.minutes(window.end), s != e else {
          continue
        }
        let startMs = dayStartMs + Int64(s) * 60_000
        let endMs = dayStartMs + Int64(e) * 60_000 + (e <= s ? dayMs : 0)
        if nowMs >= startMs && nowMs < endMs { return (startMs, endMs) }
      }
    }
    return nil
  }

  private static func minutes(_ hhmm: String) -> Int? {
    let parts = hhmm.split(separator: ":")
    guard parts.count == 2, parts[0].count == 2, parts[1].count == 2,
      let h = Int(parts[0]), let m = Int(parts[1]), h <= 23, m <= 59
    else { return nil }
    return h * 60 + m
  }
}

public enum RoomAutoStart {
  public enum Decision: Equatable, Sendable {
    case notDue
    case start(windowStartMs: Int64)
  }

  /// Should the engine start the day by itself now?
  ///
  /// Only from `.ready`: a room already recording was started by hand (left alone), a `.paused`
  /// room was paused by the desk (left alone), `.failed` is the reconciliation loop's, and
  /// `.ending`/`.superseded` are on their way out. And at most once per window: a desk `end_day`
  /// after a start must stay ended, so `lastStartedWindowMs` (persisted) suppresses a second start
  /// in the same window even across an app restart.
  public static func decide(
    schedule: RoomSchedule,
    now: Date,
    phase: RoomEnginePhase,
    lastStartedWindowMs: Int64?,
    disabled: Bool
  ) -> Decision {
    guard !disabled, phase == .ready, let window = schedule.activeWindow(at: now) else {
      return .notDue
    }
    if let last = lastStartedWindowMs, last >= window.startMs { return .notDue }
    return .start(windowStartMs: window.startMs)
  }

  /// The Dietary room never auto-starts unless re-enabled (Fable, 27 Sep). Its slug does NOT say
  /// so (`room-4-1-after-cards-before-5-494q`, name "Dietary Room"), so it is listed by slug. This is
  /// belt and braces: auto-start is opt-in per Mac, and Dietary is never opted in.
  public static let neverAutoStartSlugs: Set<String> = ["room-4-1-after-cards-before-5-494q"]

  public static func disabledBySlug(_ slug: String) -> Bool {
    let lowered = slug.lowercased()
    return lowered.contains("dietary") || neverAutoStartSlugs.contains(lowered)
  }
}

/// The last window this Mac started a day in, by ANY path (desk or auto). One small file beside
/// config.json; unreadable means "none", which errs toward starting a room that should be recording.
public struct RoomAutoStartMarker {
  let url: URL

  public init(root: URL) { url = root.appendingPathComponent("auto-start.json") }

  public func read() -> Int64? {
    guard let data = try? Data(contentsOf: url),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let ms = object["window_start_ms"] as? Int64 ?? (object["window_start_ms"] as? Int).map(Int64.init)
    else { return nil }
    return ms
  }

  public func write(windowStartMs: Int64) {
    let body = "{\"window_start_ms\":\(windowStartMs)}\n"
    try? Data(body.utf8).write(to: url, options: .atomic)
  }

  /// OPT-IN (eta-refuter B1, 27 Sep): auto-start runs ONLY on a Mac whose config directory holds an
  /// `auto-start-on` file. Absent = off, so a self-update mid-day can never start a day by itself.
  /// Home Office is opted in first; the server-delivered per-room schedule replaces this later.
  public func optedIn() -> Bool {
    FileManager.default.fileExists(
      atPath: url.deletingLastPathComponent().appendingPathComponent("auto-start-on").path)
  }

  /// The kill switch: `auto-start-off` beside config.json disables auto-start for this Mac
  /// without a build or a config edit. Rooms have no ssh, so this is for whoever is at the Mac.
  public func killSwitchPresent() -> Bool {
    FileManager.default.fileExists(
      atPath: url.deletingLastPathComponent().appendingPathComponent("auto-start-off").path)
  }
}
