import Foundation
@testable import KioskHealthCore

func runAssertionsAudioHIDTests() {
    // MARK: assertions

    test("assertions: real Audiometry snapshot parses (holders, caffeinate, HID product, kernel)") {
        let s = AssertionsParser.parse(Fixtures.read("pmset_assertions.txt"))
        checkEq(s.systemWide["PreventUserIdleSystemSleep"], 1)
        checkEq(s.systemWide["BackgroundTask"], 1)
        checkEq(s.holders.count, 10)
        checkEq(s.caffeinatePIDs, [668, 668, 668, 668])
        let c = s.holders.first { $0.process == "caffeinate" }!
        checkEq(c.heldSeconds, 88 * 3600 + 59 * 60 + 30, "H:MM:SS with hours > 24")
        checkEq(c.type, "PreventUserIdleSystemSleep")
        check(c.details.contains { $0.contains("asserting forever") })
        checkEq(s.userIsActiveProducts, ["2.4G Mouse"])
        checkEq(s.kernel.count, 4)
        check(s.kernel.contains { $0.owner == "C270 HD WEBCAM" })
        check(s.sleepPreventers.count >= 6)
    }

    test("assertions: payload is JSON-safe, redacts names of non-allowlisted processes") {
        var s = AssertionsParser.parse(Fixtures.read("pmset_assertions.txt"))
        s.holders.append(AssertionHolder(pid: 999, process: "Preview", id: "0x1", heldSeconds: 5,
                                         type: "PreventUserIdleDisplaySleep", name: "Reading patient-xyz.pdf"))
        let p = s.payload()
        let text = J.string(p)
        check(!text.contains("patient-xyz"), "document title must not ship")
        check(text.contains("name_redacted"))
        check(text.contains("caffeinate asserting") == false, "details are not shipped")
        check(JSONSerialization.isValidJSONObject(p))
        check((p["caffeinate"] as? Payload)?["present"] as? Bool == true)
    }

    test("assertions: digest ignores durations and coreaudiod context numbers") {
        let a = AssertionsParser.parse(Fixtures.read("pmset_assertions.txt"))
        var b = a
        for i in b.holders.indices { b.holders[i].heldSeconds += 600 }
        for i in b.holders.indices where b.holders[i].process == "coreaudiod" {
            b.holders[i].name = b.holders[i].name.replacingOccurrences(of: "54123", with: "99999")
        }
        checkEq(a.digest, b.digest)
        var c = a
        c.holders.removeAll { $0.process == "caffeinate" }
        check(a.digest != c.digest, "dropping caffeinate must change the digest")
    }

    test("assertions collector: first, change (after min gap), periodic") {
        let r = FakeRunner()
        let fx = Fixtures.read("pmset_assertions.txt")
        let withoutCaf = fx.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.contains("caffeinate") && !$0.contains("Details: caffeinate") && !$0.contains("Localized=THE CAFFEINATE") }
            .joined(separator: "\n")
        r.sequence("/usr/bin/pmset -g assertions", [ok(fx), ok(fx), ok(withoutCaf), ok(withoutCaf), ok(withoutCaf)])
        let (ctx, clock, _) = makeCtx(runner: r)
        let ac = AssertionsCollector(ctx: ctx)
        checkEq(ac.poll().events.first?.payload["trigger"] as? String, "first")
        clock.advance(30)
        checkEq(ac.poll().events.count, 0, "unchanged")
        clock.advance(30)
        checkEq(ac.poll().events.first?.payload["trigger"] as? String, "change", "caffeinate disappeared")
        clock.advance(30)
        checkEq(ac.poll().events.count, 0)
        clock.advance(600)
        checkEq(ac.poll().events.first?.payload["trigger"] as? String, "periodic")
    }

    // MARK: audio names / parsers

    test("audio: leading possessive is stripped, nothing else") {
        checkEq(AudioNames.stripPossessive("Alex's MacBook Air Microphone"), "MacBook Air Microphone")
        checkEq(AudioNames.stripPossessive("Alex\u{2019}s iPhone Microphone"), "iPhone Microphone")
        checkEq(AudioNames.stripPossessive("Mac mini Speakers"), "Mac mini Speakers")
        checkEq(AudioNames.stripPossessive("C270 HD WEBCAM"), "C270 HD WEBCAM")
        checkEq(AudioNames.stripPossessive("Dad's Mac mini's Speakers"), "Mac mini's Speakers", "only the leading possessive")
        checkEq(AudioNames.stripPossessive("Bob'sMic"), "Bob'sMic")
        checkEq(AudioNames.stripPossessive("Alex's "), "Alex's ", "never produce an empty name")
    }

    test("audio: system_profiler SPAudioDataType fixture") {
        let devs = SystemProfilerAudio.parse(Fixtures.read("audio_sp.json"))!
        checkEq(devs.count, 3)
        let cam = devs.first { $0.name == "C270 HD WEBCAM" }!
        checkEq(cam.transport, "usb")
        check(cam.isDefaultInput)
        checkEq(cam.inputChannels, 1)
        let spk = devs.first { $0.name == "Mac mini Speakers" }!
        checkEq(spk.transport, "builtin")
        check(spk.isDefaultOutput && !spk.isDefaultInput)
        check(SystemProfilerAudio.parse("not json") == nil)
    }

    test("audio: ioreg USB tree (real Mini capture): builtin/audio-like flags, diff; synthetic mic adds an audio interface device") {
        let usb = IoregUSB.parse(Fixtures.read("ioreg_usb_mini.txt"))
        checkEq(usb.count, 6, "2 AV adapters, 2 Apple hubs, 2 RTL9210C bridges")
        let av = usb.first { $0.name == "USB Type-C Digital AV Adapter" }!
        check(!av.audioLike && !av.builtin, "billboard interface (class 17) is not audio")
        checkEq(av.vendorID, "0x343c")
        check(usb.filter { $0.builtin }.count == 2, "Apple vendor id = builtin (the two hubs)")
        check(!usb.contains { $0.audioLike }, "no audio device on the Mini")
        check(!Fixtures.read("ioreg_usb_mini.txt").contains("7423J07"), "serial numbers redacted in the fixture")
        let withMic = IoregUSB.parse(Fixtures.read("ioreg_usb_mic_synthetic.txt"))
        checkEq(withMic.count, 7)
        let mic = withMic.first { $0.name == "USB PnP Sound Device" }!
        check(mic.audioLike && !mic.builtin)
        checkEq(mic.vendorID, "0x0d8c")
        checkEq(mic.productID, "0x5001")
        let d = IoregUSB.diff(old: usb, new: withMic)
        checkEq(d.added.map { $0.name }, ["USB PnP Sound Device"])
        check(d.removed.isEmpty)
        checkEq(IoregUSB.diff(old: usb, new: usb).added.count, 0)
        checkEq(IoregUSB.parse("").count, 0)
    }

    test("audio: ioreg IOAudio objects: only class:vendor:product kept (serial and channel fields dropped), empty output = none") {
        let e = IoregAudio.parse(Fixtures.read("ioreg_audio_engine_synthetic.txt"))
        checkEq(e.count, 1)
        checkEq(e[0].name, "AppleUSBAudioEngine:C-Media Electronics Inc.:USB PnP Sound Device")
        checkEq(e[0].cls, "AppleUSBAudioEngine")
        check(!e[0].name.contains("14213000"))
        checkEq(IoregAudio.parse(Fixtures.read("ioreg_audio_engine_empty.txt")).count, 0)
    }

    // MARK: audio log scan (`log show --style ndjson`)

    test("audio log: REAL ndjson capture from the Mac Mini parses; burst deduplicated; trailer object skipped") {
        let text = Fixtures.read("coreaudio_real_ndjson.txt")
        check(text.contains("\"eventMessage\"") && text.contains("{\"count\":10,\"finished\":1}"))
        let hits = AudioLogScan.parse(text)
        checkEq(hits.count, 2, "1 'Failed to copy key' + 1 of the 9 identical ObjectGetPropertyData lines")
        checkEq(hits[0].process, "coreaudiod", "process comes from processImagePath")
        checkEq(hits[0].pid, 314)
        checkEq(hits[0].subsystem, "com.apple.corerepair")
        checkEq(hits[0].cls, "hal_error")
        checkEq(TimeFmt.iso(hits[0].ts), "2026-10-04T22:49:51.991Z")
        checkEq(hits[1].code, "2003329396")
        checkEq(TimeFmt.iso(hits[1].ts), "2026-10-05T09:00:47.977Z")
        check(!hits[0].startFailure && !hits[1].startFailure)
    }

    test("audio log: benign error-0 lines produce nothing; text in the wrong (default) style is not parsed at all") {
        let b = Fixtures.read("coreaudio_benign_ndjson.txt")
        check(b.contains("stopping with error 0"))
        check(b.contains("initialized with error = 0"))
        checkEq(AudioLogScan.parse(b).count, 0)
        let defaultStyle = Fixtures.read("coreaudio_benign.txt")
        check(defaultStyle.contains("coreaudiod:"))
        checkEq(AudioLogScan.parse(defaultStyle).count, 0)
        let compact = "2026-10-06 07:23:49.900 E  coreaudiod[314:502204] AudioDeviceStart failed, error 0xe00002ed"
        checkEq(AudioLogScan.parse(compact).count, 0, "compact style has no JSON: a style mismatch can never look like success")
    }

    test("audio log: start failures, unplug and generic errors are classified; unplug is never a start failure") {
        let hits = AudioLogScan.parse(Fixtures.read("coreaudio_errors_synthetic.txt"))
        checkEq(hits.map { $0.cls }, ["start_failure", "start_failure", "start_failure", "unplug", "hal_error", "unplug"])
        checkEq(hits.map { $0.detail }, ["iokit_not_responding", "device_not_responding", "cannot_start_io", "iokit_no_device", "hal_error", "device_removed"])
        checkEq(hits[0].code, "0xe00002ed")
        checkEq(hits[0].codeName, "kIOReturnNotResponding")
        checkEq(hits[3].code, "0xe00002c0")
        checkEq(hits[3].process, "kernel")
        checkEq(hits[4].code, "-50")
        check(hits.filter { $0.startFailure }.count == 3)
        check(!hits.contains { $0.message.contains("Alex's") }, "personal name scrubbed from message")
        checkEq(TimeFmt.iso(hits[0].ts), "2026-10-04T20:06:17.100Z")
        let ev = AudioLogScan.event(hits[3])
        checkEq(ev.kind, "audio.error")
        checkEq(ev.payload["class"] as? String, "unplug")
        checkEq(ev.payload["start_failure"] as? Bool, false)
        check(AudioLogScan.hasStartFailure(hits.map { AudioLogScan.event($0) }))
        check(!AudioLogScan.hasStartFailure(hits.filter { $0.cls != "start_failure" }.map { AudioLogScan.event($0) }), "unplug + generic errors never trigger the ladder")
    }

    test("audio log: identical message within 60 s is deduplicated") {
        let a = ndjson("2026-10-05 01:36:17.100000+0530", "device not responding: C270 HD WEBCAM", type: "Error")
        let b = ndjson("2026-10-05 01:36:20.100000+0530", "device not responding: C270 HD WEBCAM", type: "Error")
        let c = ndjson("2026-10-05 01:38:20.100000+0530", "device not responding: C270 HD WEBCAM", type: "Error")
        checkEq(AudioLogScan.parse([a, b, c].joined(separator: "\n")).count, 2)
    }

    test("audio collector: log show argv is exactly ndjson + --start + the predicate; a wrong style fails the test") {
        let r = FakeRunner()
        // The fake only answers the one style the parser reads; any other style is an error, as on a real Mac the
        // output would simply not parse.
        r.handle("/usr/bin/log") { args in
            let styleOK = args.count >= 7 && args[0] == "show" && args[1] == "--style" && args[2] == "ndjson"
                && args[3] == "--start" && args[5] == "--predicate" && args[6].contains("coreaudiod")
            return styleOK ? ok(Fixtures.read("coreaudio_errors_synthetic.txt")) : fail(64)
        }
        let (ctx, _, _) = makeCtx(runner: r)
        let res = AudioCollector(ctx: ctx).logPoll()
        checkEq(r.argvs.count, 1)
        check(r.calls[0].hasPrefix("/usr/bin/log show --style ndjson --start "), r.calls[0])
        check(!res.degraded, "ndjson accepted")
        checkEq(res.events.count, 6)
        check(res.events.allSatisfy { $0.kind == "audio.error" })
        // and the converse: had the collector asked for compact, this fake would have failed it
        let wrong = FakeRunner()
        wrong.handle("/usr/bin/log") { args in args.contains("compact") ? ok("2026-10-06 07:23:49.900 E  coreaudiod[314:502204] AudioDeviceStart failed, error 0xe00002ed") : fail(64) }
        let (ctx2, _, _) = makeCtx(runner: wrong)
        let r2 = AudioCollector(ctx: ctx2).logPoll()
        check(r2.degraded || r2.events.isEmpty, "a compact-style fake yields no start failure through the ndjson path")
    }

    test("audio collector: log scan emits audio.error once per line (cursor), never on benign text") {
        let r = FakeRunner()
        r.on("/usr/bin/log show --style ndjson", stdout: Fixtures.read("coreaudio_errors_synthetic.txt"))
        let (ctx, clock, _) = makeCtx(runner: r)
        let ac = AudioCollector(ctx: ctx)
        let a = ac.logPoll()
        checkEq(a.events.count, 6)
        check(a.events.allSatisfy { $0.kind == "audio.error" })
        clock.advance(60)
        checkEq(ac.logPoll().events.count, 0, "overlap window re-reads the same lines but the cursor dedupes")
        let r2 = FakeRunner()
        r2.on("/usr/bin/log show --style ndjson", stdout: Fixtures.read("coreaudio_benign_ndjson.txt"))
        let (ctx2, _, _) = makeCtx(runner: r2)
        checkEq(AudioCollector(ctx: ctx2).logPoll().events.count, 0)
        let r3 = FakeRunner()
        r3.on("/usr/bin/log show", status: 1)
        let (ctx3, _, _) = makeCtx(runner: r3)
        check(AudioCollector(ctx: ctx3).logPoll().degraded)
    }

    // MARK: audio devices (ioreg presence, system_profiler profile)

    test("audio collector: presence is ioreg only (method stated); an ioreg change requests ONE profile read") {
        let r = FakeRunner()
        let io = IoregScript()
        io.usb = [Fixtures.read("ioreg_usb_mini.txt"), Fixtures.read("ioreg_usb_mini.txt"), Fixtures.read("ioreg_usb_mic_synthetic.txt")]
        io.engines["IOAudioEngine"] = ""
        io.install(on: r)
        r.on("/usr/sbin/system_profiler SPAudioDataType -json", stdout: spAudio(input: true, inputName: "Alex's C270 HD WEBCAM"))
        let (ctx, _, _) = makeCtx(runner: r)
        let ac = AudioCollector(ctx: ctx)
        let first = ac.presencePoll()
        checkEq(first.events.count, 1)
        checkEq(first.events[0].payload["method"] as? String, "ioreg")
        checkEq(first.events[0].payload["trigger"] as? String, "first")
        check(!ac.takeProfileRequest(), "first look at the bus is not a change")
        checkEq(ac.presencePoll().events.count, 0, "unchanged bus: silent")
        check(!ac.takeProfileRequest())
        let changed = ac.presencePoll()
        checkEq(changed.events.count, 1)
        checkEq(changed.events[0].payload["trigger"] as? String, "usb_change")
        checkEq((changed.events[0].payload["usb_added"] as? [Payload])?.first?["name"] as? String, "USB PnP Sound Device")
        check(ac.takeProfileRequest(), "the change asks for a profile read")
        check(!ac.takeProfileRequest(), "...once")
        check(!r.called("system_profiler"), "presence polls never ran system_profiler")
        let prof = ac.profilePoll(trigger: "usb_change")
        checkEq(prof.events.count, 1)
        let p = prof.events[0].payload
        checkEq(p["method"] as? String, "system_profiler")
        checkEq((p["default_input"] as? Payload)?["name"] as? String, "C270 HD WEBCAM", "possessive stripped")
        check(ac.hasDefaultInput)
        check(r.argvs.filter { $0[0] == "/usr/sbin/system_profiler" }.count == 1)
    }

    test("audio collector: profile at start, silent on an unchanged periodic read, event on change; missing-input streak") {
        let r = FakeRunner()
        let io = IoregScript(); io.usb = [Fixtures.read("ioreg_usb_mini.txt")]; io.install(on: r)
        r.sequence("/usr/sbin/system_profiler SPAudioDataType -json",
                   [ok(spAudio(input: true)), ok(spAudio(input: true)), ok(spAudio(input: false)), ok(spAudio(input: false))])
        let (ctx, _, _) = makeCtx(runner: r)
        let ac = AudioCollector(ctx: ctx)
        _ = ac.presencePoll()
        checkEq(ac.missingInputStreak, 0, "profile not read yet: unknown, not missing")
        checkEq(ac.profilePoll(trigger: "start").events.count, 1)
        checkEq(ac.profilePoll(trigger: "periodic").events.count, 0, "unchanged periodic read is silent")
        let changed = ac.profilePoll(trigger: "periodic")
        checkEq(changed.events.count, 1, "default input vanished")
        check(!ac.hasDefaultInput)
        _ = ac.presencePoll()
        checkEq(ac.missingInputStreak, 1)
        _ = ac.presencePoll()
        checkEq(ac.missingInputStreak, 2)
        check(!r.calls.contains { $0.contains("--hal-devices") }, "no HAL helper")

        let (ctx3, _, _) = makeCtx(runner: FakeRunner())
        let none = AudioCollector(ctx: ctx3)
        check(none.presencePoll().degraded && none.profilePoll(trigger: "start").degraded, "tools down: degraded, no crash")
    }

    test("audio collector: USB unplug between presence polls emits usb_removed") {
        let r = FakeRunner()
        let io = IoregScript()
        io.usb = [Fixtures.read("ioreg_usb_mic_synthetic.txt"), Fixtures.read("ioreg_usb_mini.txt")]
        io.install(on: r)
        let (ctx, _, _) = makeCtx(runner: r)
        let ac = AudioCollector(ctx: ctx)
        _ = ac.presencePoll()
        let second = ac.presencePoll()
        checkEq(second.events.count, 1)
        let removed = second.events[0].payload["usb_removed"] as? [Payload]
        checkEq(removed?.first?["name"] as? String, "USB PnP Sound Device")
        checkEq(second.events[0].payload["trigger"] as? String, "usb_change")
        check(ac.takeProfileRequest())
    }

    // MARK: HID

    test("hid: real ioreg HIDIdleTime parses to seconds") {
        let s = HIDParser.idleSeconds(Fixtures.read("ioreg_hid.txt"))!
        check(abs(s - 11857.536977208) < 1e-6, "got \(s)")
        check(HIDParser.idleSeconds("nothing here") == nil)
    }

    test("hid tracker: reset detection, idle_before_s, no false positives") {
        var t = HIDTracker()
        check(t.update(idleNow: 100, monotonic: 0) == nil, "first sample")
        check(t.update(idleNow: 115, monotonic: 15) == nil, "idle grew by elapsed")
        let a = t.update(idleNow: 3, monotonic: 30)
        check(a != nil, "idle dropped: input happened")
        check(abs(a!.idleBeforeS - 127) < 1e-9, "115 + 15 - 3 = 127, got \(a!.idleBeforeS)")
        checkEq(a!.idleNowS, 3)
        check(t.update(idleNow: 18, monotonic: 45) == nil)
        var v = HIDTracker()
        _ = v.update(idleNow: 500, monotonic: 0)
        check(v.update(idleNow: 500, monotonic: 600) != nil, "system slept? idle did not advance in 600 s of monotonic time -> reset")
        var w = HIDTracker()
        _ = w.update(idleNow: 500, monotonic: 0)
        check(w.update(idleNow: 500.5, monotonic: 0.5) == nil, "sleep: monotonic clock stood still, idle too")
    }

    test("hid: device class heuristics") {
        checkEq(HIDParser.deviceClass("2.4G Mouse"), "mouse")
        checkEq(HIDParser.deviceClass("Magic Keyboard"), "keyboard")
        checkEq(HIDParser.deviceClass("Apple Internal Trackpad"), "trackpad")
        checkEq(HIDParser.deviceClass("Whatever"), "other")
    }

    test("hid collector: activity names the device from the UserIsActive assertion when idle was long") {
        let r = FakeRunner()
        let idleNs: (Double) -> String = { "    | |   \"HIDIdleTime\" = \(Int($0 * 1_000_000_000))" }
        r.sequence("/usr/sbin/ioreg -c IOHIDSystem", [ok(idleNs(400)), ok(idleNs(415)), ok(idleNs(2)), ok(idleNs(17))])
        r.on("/usr/bin/pmset -g assertions", stdout: Fixtures.read("pmset_assertions.txt"))
        let (ctx, _, _) = makeCtx(runner: r)
        let hc = HIDCollector(ctx: ctx, assertions: AssertionsCollector(ctx: ctx))
        var mono: TimeInterval = 0
        hc.monotonic = { mono }
        check(hc.poll().events.isEmpty)
        mono = 15; check(hc.poll().events.isEmpty)
        mono = 30
        let e = hc.poll().events
        checkEq(e.count, 1)
        checkEq(e[0].kind, "hid.activity")
        check((e[0].payload["idle_before_s"] as? Double ?? 0) > 400)
        checkEq(e[0].payload["device"] as? String, "2.4G Mouse")
        checkEq(e[0].payload["device_class"] as? String, "mouse")
        mono = 45
        check(hc.poll().events.isEmpty)
        let text = J.string(e[0].payload)
        check(!text.contains("key"), "no keystroke content: \(text)")
    }
}
