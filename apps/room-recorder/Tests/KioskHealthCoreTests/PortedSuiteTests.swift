import Foundation
import Testing
@testable import KioskHealthCore

// The standalone daemon's own test files, ported with their harness (`test`, `check`, `checkEq`), run here as Swift
// Testing tests. A failed `check` records an issue with the original file and line. Each run function is one @Test;
// the suite is serialised because the harness keeps its counters in globals.
@Suite(.serialized) struct PortedKioskHealthTests {
    func run(_ name: String, _ body: () -> Void) {
        let (tests, failed) = (T.tests, T.failedTests)
        body()
        #expect(T.tests - tests > 0, "\(name) ran no tests")
        #expect(T.failedTests == failed, "\(name): \(T.failedTests - failed) of \(T.tests - tests) tests failed")
    }

    @Test func powerAndDisplay() { run("power/display", runPowerDisplayTests) }
    @Test func assertionsAudioHID() { run("assertions/audio/hid", runAssertionsAudioHIDTests) }
    @Test func driftConfigRecorder() { run("drift/config/recorder", runDriftConfigRecorderTests) }
    @Test func transport() { run("transport", runTransportTests) }
    @Test func misc() { run("misc", runMiscTests) }
    @Test func r1() { run("r1", runR1Tests) }
    @Test func r2() { run("r2", runR2Tests) }
    @Test func r3() { run("r3", runR3Tests) }
    @Test func r4() { run("r4", runR4Tests) }
    @Test func r5() { run("r5", runR5Tests) }
    @Test func r6() { run("r6", runR6Tests) }
    @Test func r9() { run("r9", runR9Tests) }
    @Test func r10() { run("r10", runR10Tests) }
    @Test func r11() { run("r11", runR11Tests) }
    @Test func r11b() { run("r11b", runR11bTests) }
    @Test func r12() { run("r12", runR12Tests) }
    @Test func r12b() { run("r12b", runR12bTests) }

    @Test func zzCleanup() { cleanupTmp() }
}
