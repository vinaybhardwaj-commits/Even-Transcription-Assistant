// U2 S3 — the boot race is not a mismatch, and it has THREE cases, not two.
//
// "A device that has not enumerated YET is a different condition [from the wrong device] and must not be treated as
// the same" (U2 spec S3). Collapsing them is how a room machine ends up recording the wrong thing, or dying for the
// wrong reason. The three cases and what each one does:
//
//   ABSENT  the pinned identity matches nothing present   -> bounded wait, then a named non-zero failure
//   BUSY    present and ours, but the open returns EBUSY  -> bounded wait, then a named non-zero failure
//   WRONG   present, but it is NOT the pinned identity    -> NO WAIT. Immediate named non-zero failure.
//
// WRONG never waits. Waiting there would be waiting for the right mic to appear next to the wrong one, and a room
// that quietly records the laptop's own array mic instead of the pinned TM20 is worse than a room that records
// nothing, because it looks like it worked. There is no fallback to another device in any of the three cases.
//
// This file is deliberately free of ALSA and of Foundation: the decision is a pure function of a probe result, a
// clock and a sleep, so the conformance suite drives it with scripted sequences and a fake clock (case S3) without
// needing a sound card. The hardware probe that produces DeviceState lives in ALSACapture.

/// What a single probe of the pinned device found.
public enum DeviceState: Sendable, Equatable {
    /// The pinned device is present, is ours, and opened.
    case ready
    /// Nothing present under the pinned name. May still be enumerating.
    case absent
    /// Present and ours, but the open returned EBUSY. Transient: PipeWire holds the PCM for a measured 5.0 s after
    /// its last client exits (M2.2, three trials, no variance).
    case busy
    /// Present under the pinned name, but it is not the pinned hardware. `found` names what was actually there.
    case wrong(found: String)
}

/// How the bounded wait ended. Every non-`ready` outcome is a distinct, named, non-zero failure at the call site.
public enum DeviceWaitOutcome: Sendable, Equatable {
    case ready(attempts: Int, waited: Double)
    case absentTimeout(attempts: Int, waited: Double)
    case busyTimeout(attempts: Int, waited: Double)
    /// Carries no attempt count worth reporting: it is always the first probe, by construction.
    case wrong(found: String)

    public var isReady: Bool { if case .ready = self { return true }; return false }
}

public enum DeviceWait {
    /// V's figure, 16 Sep, and recorded as a judgement rather than a measurement: long enough for a slow hub or a
    /// re-enumeration, short enough that a genuinely absent mic is reported inside half a minute. It is settable
    /// (`--wait-for-device`) so the acceptance tests can drive it to 0 and prove the immediate-failure path.
    /// Grounded as our-choice in spec/check-grounding.json; it is not derived from any measurement and must not be
    /// quoted as one.
    public static let defaultTimeoutSeconds: Double = 30

    /// One probe per second, so the journal shows *waiting* rather than hanging. The interval is not tuned: at a
    /// 30 s bound it is the coarsest rate that still reports promptly, and a faster poll would only add journal
    /// lines during a window where nothing can change faster than USB enumeration.
    public static let defaultPollSeconds: Double = 1

    /// Poll for the pinned device until it is ready or the bound expires.
    ///
    /// - `timeout` 0 means "probe exactly once and fail if it is not ready". That is a supported value, not an edge
    ///   case: it is how the acceptance test proves the immediate-failure path without waiting 30 s for it.
    /// - `log` is called once per attempt for ABSENT and BUSY, never for WRONG (which does not retry) and never for
    ///   a first-probe READY (which has nothing to report). S6: lifecycle and device identity only, no sample values.
    public static func wait(timeout: Double = defaultTimeoutSeconds,
                            pollInterval: Double = defaultPollSeconds,
                            now: () -> Double,
                            sleep: (Double) -> Void,
                            log: (String) -> Void,
                            probe: () -> DeviceState) -> DeviceWaitOutcome {
        let start = now()
        var attempts = 0
        var last: DeviceState = .absent

        while true {
            let state = probe()
            attempts += 1
            last = state

            switch state {
            case .ready:
                return .ready(attempts: attempts, waited: now() - start)
            case .wrong(let found):
                // NO WAIT, and deliberately no log line here: the caller's failure message names both identities,
                // and a "waiting" line before an immediate abort would misdescribe what happened.
                return .wrong(found: found)
            case .absent, .busy:
                break
            }

            let elapsed = now() - start
            let reason = (state == .busy) ? "held by another client (EBUSY)" : "not present yet"
            // A wait that cannot poll again is over: report the bound as reached rather than sleeping past it.
            if elapsed + pollInterval > timeout {
                // Says elapsed as well as the bound, because they differ: polling stops when the NEXT poll would
                // overrun the bound, so a 4 s bound at a 1 s interval gives up at 3 s having probed 4 times. The
                // wait therefore never exceeds its bound, and the line must not claim a full bound was spent.
                log("pinned device \(reason); giving up after \(attempts) attempt(s) and \(fmt(elapsed)) s — a further poll would exceed the \(fmt(timeout)) s bound")
                return (state == .busy)
                    ? .busyTimeout(attempts: attempts, waited: elapsed)
                    : .absentTimeout(attempts: attempts, waited: elapsed)
            }
            log("pinned device \(reason); attempt \(attempts), \(fmt(elapsed)) s of \(fmt(timeout)) s elapsed, retrying in \(fmt(pollInterval)) s")
            sleep(pollInterval)
        }
        _ = last
    }

    /// One decimal, no Foundation. Enough to read a poll log; the exact figure is never load-bearing.
    public static func fmt(_ v: Double) -> String {
        let t = (v * 10).rounded() / 10
        let whole = Int(t)
        let tenth = Int((t - Double(whole)) * 10 + 0.5)
        return "\(whole).\(tenth)"
    }
}
