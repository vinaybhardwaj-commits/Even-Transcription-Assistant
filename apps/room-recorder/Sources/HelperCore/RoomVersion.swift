import Foundation

// Moved here from RoomRecorderCore (0.1.37) so the root helper's updater and the user-level updater order versions and
// honour the rollback pin with ONE implementation.

/// `major.minor.patch…` as integers. A suffix after `-` or `+` (a build tag) is ignored for ordering.
public struct RoomVersion: Comparable, Equatable, Sendable {
  public let parts: [Int]

  public init?(_ text: String) {
    let core = text.split(whereSeparator: { $0 == "-" || $0 == "+" }).first.map(String.init) ?? ""
    let pieces = core.split(separator: ".", omittingEmptySubsequences: false)
    guard !pieces.isEmpty, pieces.count <= 4 else { return nil }
    var numbers: [Int] = []
    for piece in pieces {
      guard !piece.isEmpty, piece.allSatisfy({ $0.isASCII && $0.isNumber }), let n = Int(piece) else {
        return nil
      }
      numbers.append(n)
    }
    parts = numbers
  }

  public static func < (a: RoomVersion, b: RoomVersion) -> Bool {
    let n = max(a.parts.count, b.parts.count)
    for i in 0..<n {
      let x = i < a.parts.count ? a.parts[i] : 0, y = i < b.parts.count ? b.parts[i] : 0
      if x != y { return x < y }
    }
    return false
  }
}

// MARK: - The rollback pin (0.1.34)

/// A root-owned file that stops this Mac updating itself FORWARD past a version someone rolled it back to.
///
/// `rollback.sh` writes the rolled-back version here as its last step; a pkg install (the fleet's root
/// path, or `sudo installer`) deletes it. The self-updater already never goes down, but a room rolled
/// back to 0.1.31 would otherwise climb straight back to whatever the channel offers. With a pin, an
/// offered version ABOVE the pin is ignored; one at or below it (and above the running version) is
/// still taken.
///
/// FAIL CLOSED: a pin file that is there but cannot be read as a version holds every update, and says
/// so. The file is root-written; garbage in it means something is wrong, not that nothing is pinned.
public enum RoomUpdatePin {
  public static let defaultPath = "/Library/Application Support/EvenScribe/update-pin"
  public static var defaultURL: URL { URL(fileURLWithPath: defaultPath, isDirectory: false) }

  public enum Verdict: Equatable, Sendable {
    case noPin
    case allowed(pin: String)
    case held(pin: String)
    case unreadable
  }

  /// PURE: is `offered` above the pin text? `pinText` nil means no pin file.
  public static func verdict(offered: String, pinText: String?) -> Verdict {
    guard let pinText else { return .noPin }
    let trimmed = pinText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let pin = RoomVersion(trimmed), let want = RoomVersion(offered) else { return .unreadable }
    return want > pin ? .held(pin: trimmed) : .allowed(pin: trimmed)
  }

  /// `nil` when there is no file; the text otherwise (possibly empty or garbage, which `verdict` refuses).
  public static func read(at url: URL) -> String? {
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    return (try? String(contentsOf: url, encoding: .utf8)) ?? ""
  }
}

