import Foundation
@testable import KioskHealthCore

func runPowerDisplayTests() {
    let log = Fixtures.read("pmset_log_sleepwake.txt")

    test("pmset log: timestamp with offset parses to the right instant") {
        let e = PmsetLog.parseLine("2026-10-05 01:36:12 +0530 Sleep               \tEntering Sleep state due to 'Idle Sleep' Using AC (Charge:100%) 5 secs  \t  ")
        check(e != nil)
        checkEq(TimeFmt.iso(e!.ts), "2026-10-04T20:06:12.000Z")
        checkEq(e!.domain, "Sleep")
        check(e!.message.hasPrefix("Entering Sleep state"))
        check(!e!.message.contains("\t"))
    }

    test("pmset log: Assertions lines and headers are skipped, real Start/Notification lines survive") {
        let entries = PmsetLog.parse(log)
        check(!entries.contains { $0.domain == "Assertions" })
        check(entries.contains { $0.domain == "Start" })
        check(entries.contains { $0.domain == "Notification" })
        check(entries.contains { $0.domain == "Clamshell Sleep" }, "multi-word domain")
    }

    test("pmset log: kAESleep sleep line yields power.sleep plus power.reason carrying kAESleep") {
        let entries = PmsetLog.parse(log)
        let e = entries.first { $0.message.contains("kAESleep") }!
        let evs = PmsetLog.events(for: e)
        checkEq(evs.map { $0.kind }, ["power.sleep", "power.reason"])
        checkEq(payloadString(evs[0], "reason"), "kAESleep")
        check((evs[0].payload["kAESleep"] as? Bool) == true)
        checkEq(evs[0].payload["power_source"] as? String, "AC")
        checkEq(evs[0].payload["charge_pct"] as? Int, 100)
        checkEq(evs[0].payload["secs"] as? Int, 1783)
        checkEq(TimeFmt.iso(evs[0].ts!), "2026-10-04T20:06:12.000Z")
    }

    test("pmset log: DarkWake line has reason, flags, from and is Maintenance-flagged") {
        let e = PmsetLog.parse(log).first { $0.domain == "DarkWake" }!
        let evs = PmsetLog.events(for: e)
        checkEq(evs.map { $0.kind }, ["power.darkwake", "power.reason"])
        checkEq(payloadString(evs[0], "reason"), "RTC/Maintenance")
        checkEq(payloadString(evs[0], "flags"), "CDNVA")
        checkEq(payloadString(evs[0], "from"), "Normal Sleep")
        checkEq(evs[0].payload["secs"] as? Int, 2)
    }

    test("pmset log: sender pid extracted from Software Sleep pid=N") {
        let e = PmsetLog.parse(log).first { $0.message.contains("Software Sleep") }!
        let evs = PmsetLog.events(for: e)
        checkEq(evs.map { $0.kind }, ["power.sleep", "power.reason"])
        checkEq(evs[0].payload["sender_pid"] as? Int, 412)
        checkEq(payloadString(evs[0], "reason"), "Software Sleep pid=412")
    }

    test("pmset log: Wake and Clamshell Sleep map to the right kinds") {
        let entries = PmsetLog.parse(log)
        let w = PmsetLog.events(for: entries.first { $0.domain == "Wake" }!)
        checkEq(w.map { $0.kind }, ["power.wake"])
        checkEq(payloadString(w[0], "reason"), "EC.LidOpen/Lid Open")
        let c = PmsetLog.events(for: entries.first { $0.domain == "Clamshell Sleep" }!)
        checkEq(c.map { $0.kind }, ["power.sleep"])
    }

    test("pmset log: Maintenance Sleep gets a power.reason") {
        let e = PmsetLog.parse(log).first { $0.message.contains("Maintenance Sleep") }!
        checkEq(PmsetLog.events(for: e).map { $0.kind }, ["power.sleep", "power.reason"])
    }

    test("pmset log: display notifications recognised") {
        let entries = PmsetLog.parse(log)
        let states = entries.compactMap { PmsetLog.displayState(for: $0) }
        checkEq(states, ["on", "off", "off", "on"])
    }

    test("LogCursor: replay emits nothing, new line emits once, same-second twins are not duplicated") {
        let state = MemoryState()
        let r = FakeRunner()
        r.on("/usr/bin/pmset -g log", stdout: log)
        let (ctx, _, _) = makeCtx(runner: r, now: ist("2026-10-05", "10:00:00"), state: state)
        let pc = PowerCollector(ctx: ctx)
        let first = pc.poll()
        check(first.events.count >= 8, "first poll emits history within lookback: \(first.events.count)")
        checkEq(pc.poll().events.count, 0, "replay of the same log")

        let extra = "2026-10-05 09:40:00 +0530 DarkWake            \tDarkWake from Normal Sleep [CDNVA] : due to RTC/Maintenance Using AC (Charge:100%) 2 secs\n"
        let r2 = FakeRunner()
        r2.on("/usr/bin/pmset -g log", stdout: log + extra)
        let (ctx2, _, _) = makeCtx(runner: r2, now: ist("2026-10-05", "10:00:00"), state: state)
        let second = PowerCollector(ctx: ctx2).poll()
        checkEq(second.events.map { $0.kind }, ["power.darkwake", "power.reason"])

        // Two different lines in the same second: both emitted once, neither re-emitted next poll.
        let twin = "2026-10-05 09:50:00 +0530 Wake                \tWake [CDNVA] due to UserActivity Assertion Using AC (Charge:100%) 1 secs\n"
            + "2026-10-05 09:50:00 +0530 DarkWake            \tDarkWake from Normal Sleep [CDNVA] : due to NUB Using AC (Charge:100%) 1 secs\n"
        let r3 = FakeRunner()
        r3.on("/usr/bin/pmset -g log", stdout: log + extra + twin)
        let (ctx3, _, _) = makeCtx(runner: r3, now: ist("2026-10-05", "10:00:00"), state: state)
        let pc3 = PowerCollector(ctx: ctx3)
        checkEq(pc3.poll().events.filter { $0.kind != "power.reason" }.count, 2)
        checkEq(pc3.poll().events.count, 0)
    }

    test("power collector: pmset failure degrades with a note, never crashes") {
        let r = FakeRunner()
        r.on("/usr/bin/pmset -g log", status: 1)
        let (ctx, _, _) = makeCtx(runner: r)
        let res = PowerCollector(ctx: ctx).poll()
        check(res.degraded)
        check(res.events.isEmpty)
        check(res.notes.first?.contains("pmset -g log") == true)
    }

    test("power: IOKit message constants and kind mapping") {
        checkEq(PowerMsg.systemWillSleep, 0xE0000280)
        checkEq(PowerMsg.eventKind(PowerMsg.systemWillSleep), "power.sleep")
        checkEq(PowerMsg.eventKind(PowerMsg.systemHasPoweredOn), "power.wake")
        checkEq(PowerMsg.eventKind(PowerMsg.systemWillNotSleep), "power.sleep_refused")
        check(PowerMsg.eventKind(PowerMsg.canSystemSleep) == nil, "can-sleep is acknowledge-only")
    }

    // MARK: display

    test("display: ioreg framebuffer reading (real Mini capture, trimmed); no CoreGraphics, no log reading as state") {
        checkEq(DisplayProbe.fromIoreg(Fixtures.read("ioreg_display_mini.txt")), DisplayReading(state: "on", source: "ioreg"))
        checkEq(DisplayProbe.fromIoreg(Fixtures.read("ioreg_display_off_synthetic.txt")), DisplayReading(state: "off", source: "ioreg"))
        checkEq(DisplayProbe.fromIoreg("      \"NormalModeActive\" = No\n"), DisplayReading(state: "off", source: "ioreg"))
        check(DisplayProbe.fromIoreg("garbage") == nil)
    }

    test("display collector: log notifications become transition events once, sampled state on change only, state is ioreg") {
        let r = FakeRunner()
        let io = IoregScript(); io.display = [ioregFB(true)]; io.install(on: r)
        let (ctx, _, _) = makeCtx(runner: r, now: ist("2026-10-05", "10:00:00"))
        let dc = DisplayCollector(ctx: ctx)
        let entries = PmsetLog.parse(log)
        let first = dc.poll(entries: entries)
        let logEvents = first.events.filter { ($0.payload["origin"] as? String) == "pmset_log" && ($0.payload["sampled"] as? Bool) != true }
        checkEq(logEvents.count, 3, "three notifications inside the 24h lookback")
        let sampled = first.events.filter { ($0.payload["sampled"] as? Bool) == true }
        checkEq(sampled.count, 1)
        checkEq(sampled[0].payload["state"] as? String, "on")
        checkEq(sampled[0].payload["origin"] as? String, "ioreg")
        checkEq(dc.poll(entries: entries).events.count, 0, "nothing new on second poll")
        check(r.argvs.allSatisfy { $0[0] == Tool.ioreg }, "only ioreg was spawned: \(r.calls)")

        let r2 = FakeRunner()
        r2.on("/usr/sbin/ioreg -r -c IOMobileFramebufferShim", stdout: "  \"NormalModeActive\" = No\n")
        let (ctx2, _, _) = makeCtx(runner: r2)
        checkEq(DisplayCollector(ctx: ctx2).current(), DisplayReading(state: "off", source: "ioreg"))
        let (ctx3, _, _) = makeCtx(runner: FakeRunner())
        checkEq(DisplayCollector(ctx: ctx3).current(), DisplayReading(state: "unknown", source: "none"))
        check(!r2.calls.contains { $0.contains("--display-state") || $0.contains(fakeSelf) }, "no helper child any more")
    }
}
