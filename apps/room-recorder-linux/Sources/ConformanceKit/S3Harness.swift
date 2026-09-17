import CaptureCore
import Foundation

/// U2 S3 and the indefinite run, pinned by scripted scenarios rather than by tapes.
///
/// Every scenario drives the real `DeviceWait.wait` and the real `RunLength` — the same code the recorder runs — with
/// a fake clock, a fake sleep and a scripted probe sequence. Nothing here touches a sound card, so these rows hold on
/// a build machine with no audio hardware, which is the whole reason the decision logic lives in CaptureCore and not
/// in ALSACapture.
///
/// The three cases must stay DISTINCT. A change that makes WRONG wait, or that lets ABSENT fall through to another
/// device, breaks a named row here rather than being discovered on a room machine at 2 a.m.
public enum S3Harness {
    /// A fake clock and sleep. `sleep` does not sleep: it advances the clock, so a 30 s bound is proven in
    /// microseconds and the test cannot be flaky on a loaded build box.
    final class FakeTime {
        var now: Double = 0
        var sleeps: [Double] = []
        func sleep(_ d: Double) { sleeps.append(d); now += d }
    }

    struct Scenario {
        var id: String
        var role: FixtureRole
        /// The named check in spec/check-grounding.json this row asserts under. Several rows may share one check:
        /// "absent waits then fails named" is one claim exercised from three directions.
        var check: String
        var run: () -> [String]   // returns failures; empty means the row holds
    }

    public static func run() -> [(String, FixtureRole, Verdict)] {
        scenarios().map { s in
            CheckRegistry.record(s.check)
            let failures = s.run()
            return (s.id, s.role, failures.isEmpty ? .pass : .fail(failures))
        }
    }

    /// Drive the real wait loop with a scripted sequence of probe results. The sequence is consumed one per probe;
    /// when it runs out the last element repeats, so "always absent" is written as `[.absent]`.
    static func drive(_ script: [DeviceState], timeout: Double, poll: Double = 1)
        -> (outcome: DeviceWaitOutcome, time: FakeTime, logs: [String], probes: Int) {
        let t = FakeTime()
        var i = 0, probes = 0
        var logs: [String] = []
        let outcome = DeviceWait.wait(
            timeout: timeout, pollInterval: poll,
            now: { t.now }, sleep: { t.sleep($0) }, log: { logs.append($0) },
            probe: {
                probes += 1
                let s = script[min(i, script.count - 1)]
                i += 1
                return s
            })
        return (outcome, t, logs, probes)
    }

    static func expect(_ cond: Bool, _ why: @autoclosure () -> String) -> [String] { cond ? [] : [why()] }

    static func scenarios() -> [Scenario] {
        let bound = DeviceWait.defaultTimeoutSeconds   // 30, our-choice
        return [

            // ---------------------------------------------------------------- READY
            Scenario(id: "s3/ready-on-first-probe", role: .good, check: "S3.wait-bound") {
                let r = drive([.ready], timeout: bound)
                return expect(r.outcome == .ready(attempts: 1, waited: 0), "expected ready on probe 1, got \(r.outcome)")
                     + expect(r.time.sleeps.isEmpty, "a device that is already there must not sleep at all; slept \(r.time.sleeps)")
                     + expect(r.logs.isEmpty, "a first-probe ready has nothing to report; logged \(r.logs)")
            },

            // ---------------------------------------------------------------- ABSENT: wait, then named failure
            Scenario(id: "s3/absent-then-appears", role: .good, check: "S3.absent-waits-then-fails") {
                // Absent for four polls, then present: the boot race S3 exists for.
                let r = drive([.absent, .absent, .absent, .absent, .ready], timeout: bound)
                return expect(r.outcome == .ready(attempts: 5, waited: 4), "expected ready after 5 probes at t=4, got \(r.outcome)")
                     + expect(r.time.sleeps == [1, 1, 1, 1], "expected four 1 s polls, got \(r.time.sleeps)")
                     + expect(r.logs.count == 4, "the journal must show waiting, one line per attempt; got \(r.logs.count)")
                     + expect(r.logs.allSatisfy { $0.contains("not present yet") }, "absent attempts must say so: \(r.logs)")
            },
            Scenario(id: "s3/absent-times-out-named", role: .good, check: "S3.absent-waits-then-fails") {
                let r = drive([.absent], timeout: bound)
                guard case .absentTimeout(let attempts, let waited) = r.outcome else {
                    return ["a permanently absent device must end in absentTimeout, got \(r.outcome)"]
                }
                // 31, not 30: the probes land at t = 0, 1, … 30, so the bound is used in FULL and never exceeded.
                // The last probe is at exactly t = bound; a device that appears at 29.9 s is still caught.
                return expect(waited == bound, "the wait must use its whole bound and not exceed it: waited \(waited) of \(bound)")
                     + expect(attempts == 31, "expected probes at t=0…30 inclusive = 31, got \(attempts)")
                     + expect(r.logs.last?.contains("would exceed the") == true, "the last line must say why polling stopped: \(r.logs.last ?? "-")")
            },

            // ---------------------------------------------------------------- BUSY: the measured 5.0 s hold
            Scenario(id: "s3/busy-rides-out-pipewire-hold", role: .good, check: "S3.busy-waits-then-fails") {
                // M2.2 measured PipeWire holding the PCM for exactly 5.0 s after its last client exits, three trials,
                // no variance. Five 1 s polls must ride that out and then record — NOT fail, and NOT fall back.
                let r = drive([.busy, .busy, .busy, .busy, .busy, .ready], timeout: bound)
                return expect(r.outcome == .ready(attempts: 6, waited: 5), "a 5.0 s PipeWire hold must be ridden out, got \(r.outcome)")
                     + expect(r.logs.allSatisfy { $0.contains("EBUSY") }, "busy attempts must name EBUSY: \(r.logs)")
            },
            Scenario(id: "s3/busy-times-out-named-distinctly", role: .good, check: "S3.busy-waits-then-fails") {
                let r = drive([.busy], timeout: bound)
                guard case .busyTimeout = r.outcome else {
                    return ["a permanent holder must end in busyTimeout, not \(r.outcome) — busy and absent are different faults and get different exits"]
                }
                return []
            },

            // ---------------------------------------------------------------- WRONG: no wait, ever
            Scenario(id: "s3/wrong-fails-immediately", role: .good, check: "S3.wrong-never-waits") {
                let r = drive([.wrong(found: "1234:5678 at hw:CARD=Device,DEV=0")], timeout: bound)
                return expect(r.outcome == .wrong(found: "1234:5678 at hw:CARD=Device,DEV=0"), "expected wrong, got \(r.outcome)")
                     + expect(r.probes == 1, "WRONG must be decided on the first probe; probed \(r.probes) times")
                     + expect(r.time.sleeps.isEmpty, "WRONG MUST NEVER WAIT; slept \(r.time.sleeps)")
                     + expect(r.time.now == 0, "no time may pass before a wrong-device failure; clock at \(r.time.now)")
            },
            Scenario(id: "s3/wrong-not-waited-even-if-right-one-follows", role: .good, check: "S3.wrong-never-waits") {
                // The trap this case exists for: the pinned mic appearing a second later next to the wrong one does
                // NOT rescue the run. Waiting here is waiting for the right mic to show up beside the wrong one.
                let r = drive([.wrong(found: "0000:0000 at hw:CARD=Device,DEV=0"), .ready], timeout: bound)
                guard case .wrong = r.outcome else {
                    return ["a wrong device must fail even when the pinned one would appear on the next probe; got \(r.outcome)"]
                }
                return expect(r.probes == 1, "must not probe again after WRONG; probed \(r.probes)")
            },

            // ---------------------------------------------------------------- the settable bound, including 0
            Scenario(id: "s3/zero-bound-probes-once-and-fails", role: .good, check: "S3.wait-bound") {
                // --wait-for-device 0 is how the acceptance test proves the immediate-failure path without waiting.
                let r = drive([.absent], timeout: 0)
                guard case .absentTimeout(let attempts, _) = r.outcome else {
                    return ["a zero bound must still probe once and then fail named, got \(r.outcome)"]
                }
                return expect(attempts == 1, "expected exactly one probe at a zero bound, got \(attempts)")
                     + expect(r.time.sleeps.isEmpty, "a zero bound must not sleep; slept \(r.time.sleeps)")
            },
            Scenario(id: "s3/zero-bound-still-accepts-a-present-device", role: .good, check: "S3.wait-bound") {
                let r = drive([.ready], timeout: 0)
                return expect(r.outcome.isReady, "a zero bound must still succeed when the device is already there, got \(r.outcome)")
            },

            // ---------------------------------------------------------------- NEGATIVE CONTROL
            Scenario(id: "s3/negative-fallback-to-another-device", role: .negative, check: "S3.no-fallback") {
                // S3 says: never fall back to another device, for any reason. There is no fallback path to exercise,
                // so this control asserts the property that WOULD be true if one existed, and must FAIL.
                // It holds (as a negative) precisely because the assertion below is false.
                let r = drive([.absent], timeout: bound)
                return expect(r.outcome.isReady,
                              "S3 forbids substituting a device: a permanently absent pinned mic must NOT end ready. It ended \(r.outcome), which is correct — this negative control holds by failing.")
            },

            // ---------------------------------------------------------------- the indefinite run
            Scenario(id: "s3/run-indefinite-never-stops-on-count", role: .good, check: "S3.run-length") {
                let r = RunLength(seconds: nil, rate: 48_000)
                return expect(r == .indefinite, "an absent --seconds is the indefinite run, got \(r)")
                     + expect(r.targetFrames == nil, "an indefinite run has no frame target, got \(String(describing: r.targetFrames))")
                     + expect(r.shouldContinue(captured: 0), "indefinite must continue at 0 frames")
                     + expect(r.shouldContinue(captured: 48_000 * 3_600 * 24), "indefinite must continue after a day of audio")
                     + expect(r.readSize(period: 1_200, captured: 999_999) == 1_200, "indefinite always asks for a full period, got \(r.readSize(period: 1_200, captured: 999_999))")
            },
            Scenario(id: "s3/run-bounded-is-unchanged", role: .good, check: "S3.run-length") {
                // --seconds S must mean exactly what it meant before, or every existing fixture and measurement moves.
                let r = RunLength(seconds: 10, rate: 48_000)
                return expect(r.targetFrames == 480_000, "10 s at 48 kHz is 480 000 frames, got \(String(describing: r.targetFrames))")
                     + expect(r.shouldContinue(captured: 479_999), "must continue one frame short")
                     + expect(!r.shouldContinue(captured: 480_000), "must stop exactly at the target")
                     + expect(r.readSize(period: 1_200, captured: 479_500) == 500, "the last read must not overshoot the target, got \(r.readSize(period: 1_200, captured: 479_500))")
                     + expect(r.readSize(period: 1_200, captured: 0) == 1_200, "a mid-run read is a full period, got \(r.readSize(period: 1_200, captured: 0))")
            },
        ]
    }
}
