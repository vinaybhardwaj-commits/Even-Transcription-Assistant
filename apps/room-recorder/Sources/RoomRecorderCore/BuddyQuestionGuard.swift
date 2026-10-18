import Foundation

// Encounter Buddy, L2 (0.1.42) — C8V3-C4, the mechanical wrong-patient check, built before any question can render.
//
// No question reaches a screen before L5 (A2-C4), so nothing calls this yet. It exists now so the rule is in place and
// tested when the question panel is added: the page code that renders questions asks `admit` first, and a question whose
// fact_refs do not all name the snapshot bound to THIS consult is dropped and counted as a `wrong_snapshot_breach`.
//
// A fact_ref names its snapshot by prefix: `<snapshot_id>#<path>` (INFERRED; the separator is `#`, `:` or `/`, and a
// snapshot id holds none of them). The bound snapshot id is the one newcat holds for this opaque id.

public final class BuddyQuestionGuard: @unchecked Sendable {
  public let boundSnapshotID: String
  private let log: @Sendable (String) -> Void
  private let lock = NSLock()
  private var breaches = 0

  public init(boundSnapshotID: String, log: @escaping @Sendable (String) -> Void) {
    self.boundSnapshotID = boundSnapshotID
    self.log = log
  }

  public var breachCount: Int { lock.withLock { breaches } }

  /// The snapshot id a fact_ref names: everything before the first `#`, `:` or `/`.
  static func snapshotPrefix(of factRef: String) -> String {
    String(factRef.prefix { $0 != "#" && $0 != ":" && $0 != "/" })
  }

  /// True when every fact_ref names the bound snapshot. One mismatch drops the whole question and counts one breach.
  /// A question with no fact_refs has nothing to contradict the binding and is admitted; whether that is allowed is the
  /// question panel's rule, not this check's.
  public func admit(factRefs: [String]) -> Bool {
    let bound = boundSnapshotID
    guard !bound.isEmpty, factRefs.allSatisfy({ Self.snapshotPrefix(of: $0) == bound }) else {
      let count = lock.withLock { () -> Int in breaches += 1; return breaches }
      log("buddy page: wrong_snapshot_breach count \(count)")  // a count, never the question or the refs
      return false
    }
    return true
  }
}
