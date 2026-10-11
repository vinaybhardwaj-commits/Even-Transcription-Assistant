import Foundation
@testable import KioskHealthCore

func runMiscTests() {
    test("OwnLog rotation: keeps exactly 3 old files, newest is .1") {
        let d = tmpDir("log").path
        let p = d + "/own.log"
        for round in 1...5 {
            FileManager.default.createFile(atPath: p, contents: Data(String(repeating: "\(round)", count: 100).utf8))
            check(OwnLog.rotate(path: p, maxBytes: 50, keep: 3))
        }
        let fm = FileManager.default
        check(!fm.fileExists(atPath: p), "current file moved away")
        check(fm.fileExists(atPath: p + ".1") && fm.fileExists(atPath: p + ".2") && fm.fileExists(atPath: p + ".3"))
        check(!fm.fileExists(atPath: p + ".4"))
        check(String(decoding: fm.contents(atPath: p + ".1")!, as: UTF8.self).hasPrefix("5"), "newest rotated file is .1")
        check(String(decoding: fm.contents(atPath: p + ".3")!, as: UTF8.self).hasPrefix("3"))
        FileManager.default.createFile(atPath: p, contents: Data("tiny".utf8))
        check(!OwnLog.rotate(path: p, maxBytes: 50, keep: 3), "below the threshold: untouched")
    }

    test("OwnLog write appends lines and never throws") {
        let d = tmpDir("log2").path
        let l = OwnLog(path: d + "/a.log", maxBytes: 1_000_000, keep: 3)
        l.info("hello"); l.warn("careful")
        let text = String(decoding: FileManager.default.contents(atPath: d + "/a.log")!, as: UTF8.self)
        check(text.contains("INFO hello") && text.contains("WARN careful"))
        OwnLog(path: "/nonexistent-dir/x.log").info("must not crash")
    }

    test("time: ISO ms output, stamp parsing with fractions and negative offsets") {
        checkEq(TimeFmt.iso(Date(timeIntervalSince1970: 0)), "1970-01-01T00:00:00.000Z")
        let d = TimeFmt.parseStamp(date: "2026-10-05", time: "13:36:55", frac: "506117", tz: "+0530")!
        checkEq(TimeFmt.iso(d), "2026-10-05T08:06:55.506Z")
        let n = TimeFmt.parseStamp(date: "2026-10-05", time: "01:00:00", frac: nil, tz: "-0400")!
        checkEq(TimeFmt.iso(n), "2026-10-05T05:00:00.000Z")
        check(TimeFmt.parseStamp(date: "bad", time: "13:36:55", frac: nil, tz: "+0530") == nil)
        checkEq(TimeFmt.parseISO("2026-10-05T08:06:55.506Z").map { TimeFmt.iso($0) }, "2026-10-05T08:06:55.506Z")
    }

    test("durations and numbers") {
        checkEq(parseDurationHMS("88:59:30"), 88 * 3600 + 59 * 60 + 30)
        checkEq(parseDurationHMS("04:22"), 4 * 60 + 22)
        check(parseDurationHMS("junk") == nil)
        checkEq(num(Double.nan), 0)
        checkEq(num(1.23456), 1.235)
    }

    test("J: invalid objects never crash") {
        check(J.string(["d": Date()] as [String: Any]).contains("invalid_json_object"))
        check(J.parse("{") == nil)
    }

    test("every regex pattern in the daemon compiled (a bad pattern would silently never match)") {
        // Touch the lazily-initialised pattern holders that tests above did not.
        _ = [PmsetLog.stampRX, PmsetLog.multiSpaceRX, PmsetLog.quotedReasonRX, PmsetLog.bareReasonRX, PmsetLog.pidRX,
             PmsetLog.usingRX, PmsetLog.secsRX, PmsetLog.flagsRX, PmsetLog.fromRX,
             AssertionsParser.holderRX, AssertionsParser.systemRX, AssertionsParser.kernelRX, AssertionsParser.productRX,
             AssertionsParser.digitsRX, AudioNames.possessiveRX, AudioNames.scrubRX, IoregUSB.audioLikeRX,
             AudioLogScan.tsRX, AudioLogScan.deviceGoneRX, DisplayProbe.normalModeRX, RepeatCollapser.digitsRX,
             AudioLogScan.notRespondingRX, AudioLogScan.cannotStartRX, AudioLogScan.errNumRX,
             AudioLogScan.errFourCCRX, AudioLogScan.failRX, AudioLogScan.digitsRX, HIDParser.idleRX,
             PmsetSettings.lineRX, PmsetSettings.profileRX, RecorderLogFilter.interestingRX, RecorderLogFilter.stackFrameRX]
        checkEq(RX.failures, [])
    }
}
