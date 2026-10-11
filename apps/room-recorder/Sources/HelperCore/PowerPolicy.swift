import FleetCore
import Foundation

/// #43: the power baseline and the 07:05 power-on, enforced by the root helper.
///
/// Evening "Shut Down" left rooms dark at clinic open, and a manual `pmset` change was only ever reported, never
/// reverted. The baseline is compiled in. Autologin is NOT touched: it stays a manual setting.
public struct PowerReport: Equatable, Sendable {
  /// `key=current(want N)` for every setting that differed when we looked.
  public var driftBefore: [String]
  public var applied: [String]
  public var driftAfter: [String]
  public var failures: [String]
  public var ok: Bool { failures.isEmpty && driftAfter.isEmpty }
}

public struct PowerPolicy: Sendable {
  /// sleep 0, disksleep 0, displaysleep 0, powernap 0, autorestart 1, womp 1.
  public static let baseline: [(key: String, value: Int)] = [
    ("sleep", 0), ("disksleep", 0), ("displaysleep", 0), ("powernap", 0), ("autorestart", 1), ("womp", 1),
  ]
  public static let defaultPowerOn = "07:05"
  let tools: SystemTools

  public init(tools: SystemTools) { self.tools = tools }

  /// `pmset -g` lines of the form `<key> <integer> [note]`.
  public static func parse(pmsetG output: String) -> [String: Int] {
    var values: [String: Int] = [:]
    for line in output.split(separator: "\n") {
      let parts = line.split(whereSeparator: { $0 == " " || $0 == "\t" })
      guard parts.count >= 2, let value = Int(parts[1]) else { continue }
      values[String(parts[0])] = value
    }
    return values
  }

  /// A setting this Mac does not report cannot be judged, so it is not drift.
  public static func drift(current: [String: Int]) -> [String] {
    baseline.compactMap { entry in
      guard let have = current[entry.key], have != entry.value else { return nil }
      return "\(entry.key)=\(have)(want \(entry.value))"
    }
  }

  public func currentDrift() -> [String]? {
    let result = tools.run("/usr/bin/pmset", ["-g"])
    guard result.status == 0 else { return nil }
    return Self.drift(current: Self.parse(pmsetG: result.output))
  }

  /// Apply what differs, then look again.
  public func enforce() -> PowerReport {
    let first = tools.run("/usr/bin/pmset", ["-g"])
    guard first.status == 0 else {
      return PowerReport(driftBefore: [], applied: [], driftAfter: [], failures: ["pmset_read_\(first.status)"])
    }
    let current = Self.parse(pmsetG: first.output)
    let before = Self.drift(current: current)
    var applied: [String] = []
    var failures: [String] = []
    for entry in Self.baseline {
      guard let have = current[entry.key], have != entry.value else { continue }
      let result = tools.run("/usr/bin/pmset", ["-a", entry.key, String(entry.value)])
      if result.status == 0 { applied.append("\(entry.key)=\(entry.value)") } else { failures.append("\(entry.key)_\(result.status)") }
    }
    let after = applied.isEmpty ? before : (currentDrift() ?? before)
    return PowerReport(driftBefore: before, applied: applied, driftAfter: after, failures: failures)
  }

  // MARK: Scheduled power-on

  /// Does `pmset -g sched` say there is a repeating power-on at `time` ("HH:MM", 24 h) EVERY day?
  /// INFERRED format: `wakepoweron at 7:05AM every day`.
  public static func scheduleMatches(_ sched: String, time: String) -> Bool {
    guard let regex = try? NSRegularExpression(
      pattern: "(wakepoweron|poweron|wake or power on)\\s+at\\s+(\\d{1,2}):(\\d{2})\\s*(AM|PM)\\s+every day",
      options: [.caseInsensitive])
    else { return false }
    let range = NSRange(sched.startIndex..., in: sched)
    for match in regex.matches(in: sched, range: range) {
      func group(_ i: Int) -> String { Range(match.range(at: i), in: sched).map { String(sched[$0]) } ?? "" }
      guard var hour = Int(group(2)), let minute = Int(group(3)) else { continue }
      let pm = group(4).uppercased() == "PM"
      if hour == 12 { hour = pm ? 12 : 0 } else if pm { hour += 12 }
      if String(format: "%02d:%02d", hour, minute) == time { return true }
    }
    return false
  }

  /// `MTWRFSU HH:MM` when the repeating power-on is the one we want, otherwise `none`.
  public func powerSchedule(time: String = defaultPowerOn) -> String {
    let result = tools.run("/usr/bin/pmset", ["-g", "sched"])
    return result.status == 0 && Self.scheduleMatches(result.output, time: time) ? "MTWRFSU \(time)" : "none"
  }

  /// Re-assert the daily power-on if it is not there. Returns (changed, ok).
  @discardableResult
  public func assertSchedule(time: String = defaultPowerOn) -> (changed: Bool, ok: Bool) {
    if powerSchedule(time: time) != "none" { return (false, true) }
    let set = tools.run("/usr/bin/pmset", ["repeat", "wakeorpoweron", "MTWRFSU", "\(time):00"])
    guard set.status == 0 else { return (false, false) }
    return (true, powerSchedule(time: time) != "none")
  }
}
