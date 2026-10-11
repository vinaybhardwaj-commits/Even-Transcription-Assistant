import Foundation

// What the standalone daemon took from files this port does not carry (its CLI, its HTTP transport, its audio ladder
// and DarkWake watchdog): only the small pieces the collectors still use.

/// The standalone daemon's Makefile stamped a git sha and a package version. The collectors travel with the helper now,
/// whose own build is identified by `source: "helper"` on every event, so the stamp keeps its shape (the server's heartbeat
/// rules read it) with `unknown` for the sha and the collectors' version for the package.
enum BuildInfo {
    static let gitSHA = "unknown"
    static let pkgVersion = kVersion
}

/// The clinic clock the collectors read. Always Asia/Kolkata: it is a clinic-hours rule, not a setting.
enum LadderPolicy {
    static let windowStart = "21:30"
    static let windowEnd = "08:00"
    static let timeZone = TimeZone(identifier: "Asia/Kolkata") ?? TimeZone(secondsFromGMT: 19800)!
}
