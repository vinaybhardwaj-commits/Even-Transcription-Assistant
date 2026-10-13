
import Foundation

// MARK: - Models

struct AudioDeviceInfo: Equatable {
    var name: String
    var uid: String?
    var transport: String
    var inputChannels: Int
    var outputChannels: Int
    var isDefaultInput: Bool
    var isDefaultOutput: Bool

    func payload() -> Payload {
        ["name": name, "uid": jv(uid), "transport": transport, "input_channels": inputChannels,
         "output_channels": outputChannels, "is_default_input": isDefaultInput, "is_default_output": isDefaultOutput]
    }
}

struct UsbDevice: Equatable {
    var name: String
    var vendorID: String
    var productID: String
    var locationID: String
    var builtin: Bool
    var audioLike: Bool

    var key: String { "\(vendorID):\(productID)@\(locationID)|\(name)" }
    func payload() -> Payload {
        ["name": name, "vendor_id": vendorID, "product_id": productID, "location_id": locationID,
         "builtin": builtin, "audio_like": audioLike]
    }
}

// MARK: - Names

enum AudioNames {
    static let possessiveRX = RX(#"^[^'’]+['’]s\s+"#)
    static let scrubRX = RX(#"\b[A-Z][A-Za-z]*['’]s\s+"#)

    /// "Vinay's MacBook Air Microphone" -> "MacBook Air Microphone". Only a leading possessive is removed.
    static func stripPossessive(_ name: String) -> String {
        let out = possessiveRX.replace(name, with: "")
        return out.isEmpty ? name : out
    }

    /// Remove "Name's " possessives anywhere in a log message (device names can carry a person's name).
    static func scrubMessage(_ s: String) -> String { scrubRX.replace(s, with: "") }

    /// Every device, HID, assertion or owner name that leaves the machine goes through this: a leading
    /// possessive ("Dr X's Keyboard") and any capitalised "Name's " inside the string are removed.
    static func sanitize(_ name: String) -> String {
        let stripped = stripPossessive(name)
        let scrubbed = scrubMessage(stripped)
        return scrubbed.isEmpty ? stripped : scrubbed
    }
}

// MARK: - system_profiler parsing

enum SystemProfilerAudio {
    static func transportName(_ raw: String) -> String {
        let t = raw.replacingOccurrences(of: "coreaudio_device_type_", with: "")
        return t.isEmpty ? "unknown" : t
    }

    /// `system_profiler SPAudioDataType -json` -> devices (uid is not available from the profiler).
    static func parse(_ json: String) -> [AudioDeviceInfo]? {
        guard let root = J.dict(json), let arr = root["SPAudioDataType"] as? [[String: Any]] else { return nil }
        var out: [AudioDeviceInfo] = []
        for group in arr {
            for item in (group["_items"] as? [[String: Any]]) ?? [] {
                let name = (item["_name"] as? String) ?? "unknown"
                out.append(AudioDeviceInfo(
                    name: name, uid: nil,
                    transport: transportName((item["coreaudio_device_transport"] as? String) ?? ""),
                    inputChannels: (item["coreaudio_device_input"] as? NSNumber)?.intValue ?? 0,
                    outputChannels: (item["coreaudio_device_output"] as? NSNumber)?.intValue ?? 0,
                    isDefaultInput: (item["coreaudio_default_audio_input_device"] as? String) == "spaudio_yes",
                    isDefaultOutput: (item["coreaudio_default_audio_output_device"] as? String) == "spaudio_yes"))
            }
        }
        return out
    }
}

// MARK: - ioreg parsing (USB tree, audio engines)

/// One `+-o Name@loc  <class X, ...>` block of `ioreg` output with its `"key" = value` property lines.
struct IoEntry {
    var depth: Int
    var name: String
    var location: String?
    var cls: String
    var props: [String: String] = [:]

    /// Value with surrounding quotes removed.
    func prop(_ k: String) -> String? {
        guard let v = props[k] else { return nil }
        let t = v.trimmed
        if t.hasPrefix("\""), t.hasSuffix("\""), t.count >= 2 { return String(t.dropFirst().dropLast()) }
        return t
    }
    func int(_ k: String) -> Int? { prop(k).flatMap { Int($0) } }
}

enum IoregTree {
    static let headerRX = RX(#"^([ |]*)\+-o (.+?)\s+<class ([A-Za-z0-9_]+),"#)
    static let propRX = RX(#"^[ |]*"([^"]+)" = (.*)$"#)
    static let atRX = RX(#"^(.*)@([0-9A-Fa-f,]+)$"#)

    /// Flat list of entries in output order. Child entries have a larger `depth` than their parent.
    static func parse(_ text: String) -> [IoEntry] {
        var out: [IoEntry] = []
        for raw in text.split(separator: "\n", omittingEmptySubsequences: true) {
            let line = String(raw)
            if let m = headerRX.match(line) {
                var name = m[2], loc: String? = nil
                if let a = atRX.match(name) { name = a[1]; loc = a[2] }
                out.append(IoEntry(depth: m[1].count, name: name, location: loc, cls: m[3]))
            } else if !out.isEmpty, let p = propRX.match(line) {
                if out[out.count - 1].props[p[1]] == nil { out[out.count - 1].props[p[1]] = p[2] }
            }
        }
        return out
    }
}

/// USB devices from `ioreg -r -c IOUSBHostDevice -l -d 2 -w0` (device blocks plus their interface children). No
/// system_profiler, no coreaudiod: reading the registry is what makes presence checks cheap (about 10 ms).
enum IoregUSB {
    static let audioLikeRX = RX(#"(?i)(audio|mic\b|microphone|webcam|camera|headset|headphone|speaker|sound|codec|tonor|c270|usb ?pnp)"#)
    static let appleVendor = 0x05ac
    static let audioInterfaceClass = 1

    static func hex(_ n: Int?, width: Int) -> String { n.map { String(format: "0x%0\(width)x", $0) } ?? "" }

    /// Devices (hubs included; Apple vendor id = builtin). A device is audio-like when one of its interfaces has
    /// bInterfaceClass 1 (USB Audio) or its name looks like a mic/camera/headset. Names are sanitized (possessives).
    static func parse(_ text: String) -> [UsbDevice] {
        let entries = IoregTree.parse(text)
        var out: [UsbDevice] = []
        for (i, e) in entries.enumerated() where e.cls == "IOUSBHostDevice" {
            var audioIface = false
            var j = i + 1
            while j < entries.count, entries[j].depth > e.depth {
                if entries[j].cls == "IOUSBHostInterface", entries[j].int("bInterfaceClass") == audioInterfaceClass { audioIface = true }
                j += 1
            }
            let name = AudioNames.sanitize(e.prop("USB Product Name") ?? e.name)
            out.append(UsbDevice(name: name,
                                 vendorID: hex(e.int("idVendor"), width: 4),
                                 productID: hex(e.int("idProduct"), width: 4),
                                 locationID: hex(e.int("locationID"), width: 8),
                                 builtin: e.int("idVendor") == appleVendor,
                                 audioLike: audioIface || audioLikeRX.matches(name)))
        }
        return out
    }

    static func diff(old: [UsbDevice], new: [UsbDevice]) -> (added: [UsbDevice], removed: [UsbDevice]) {
        let o = Set(old.map { $0.key }), n = Set(new.map { $0.key })
        return (new.filter { !o.contains($0.key) }, old.filter { !n.contains($0.key) })
    }
}

/// IOAudioEngine / IOAudioDevice instances (`ioreg -r -c <class> -d 1 -w0`): the kernel-side audio objects of a
/// device. Their names carry "class:vendor:product:serial:channels"; only the first three fields are kept.
struct AudioEngineEntry: Equatable {
    var cls: String
    var name: String
    var key: String { "\(cls)|\(name)" }
    func payload() -> Payload { ["class": cls, "name": name] }
}

enum IoregAudio {
    static let classes = ["IOAudioEngine", "IOAudioDevice", "IOAudio2Device"]

    static func parse(_ text: String, classes: [String] = IoregAudio.classes) -> [AudioEngineEntry] {
        IoregTree.parse(text).filter { $0.depth == 0 }.map { e in
            let fields = e.name.split(separator: ":", omittingEmptySubsequences: false).prefix(3).joined(separator: ":")
            return AudioEngineEntry(cls: e.cls, name: AudioNames.sanitize(fields))
        }
    }
}

// MARK: - Unified-log scan (coreaudiod / com.apple.audio / IOUSBHost)

/// One audio.error candidate.
///   cls  "start_failure"  the device would not start (0xe00002ed, "not responding", "cannot start IO"); the only class
///                         the audio ladder reacts to
///        "unplug"         the device went away (0xe00002c0, "device removed/terminated"); never a start failure
///        "hal_error"      any other non-zero error
struct AudioLogHit: Equatable {
    var ts: Date
    var process: String
    var pid: Int
    var subsystem: String
    var cls: String
    var detail: String
    var code: String?
    var codeName: String?
    var message: String

    var startFailure: Bool { cls == "start_failure" }
}

enum AudioLogScan {
    /// `log show --style ndjson` timestamp: "2026-10-05 14:30:47.977316+0530".
    static let tsRX = RX(#"^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.(\d+)([+-]\d{4})$"#)
    static let notRespondingRX = RX(#"(?i)not responding"#)
    static let cannotStartRX = RX(#"(?i)((cannot|can't|could not|unable to|failed to) start (the )?(io|audio)|start ?io.*(fail|err)|audiodevicestart.*(fail|err))"#)
    static let deviceGoneRX = RX(#"(?i)(device (?:has been |was |is )?(?:removed|terminated|unplugged|disconnected)|(?:removed|terminated|unplugged|disconnected) device)"#)
    static let errNumRX = RX(#"(?i)\berr(?:or)?(?: code)?\s*[=:]?\s*(-?\d+|0x[0-9a-fA-F]+)"#)
    static let errFourCCRX = RX(#"(?i)\berr(?:or)?\s*[=:]?\s*'(\S{4})'"#)
    static let failRX = RX(#"(?i)\bfail(?:ed|ure|s)?\b"#)
    static let digitsRX = RX(#"\d+"#)

    static func numeric(_ s: String) -> Int? {
        let t = s.lowercased()
        if t.hasPrefix("0x") { return Int(t.dropFirst(2), radix: 16) }
        return Int(t)
    }

    /// Classify one log message. Benign "error 0" lines (very common in coreaudiod) return nil.
    static func classify(_ msg: String) -> (cls: String, detail: String, code: String?, codeName: String?)? {
        let low = msg.lowercased()
        // Unplug first: an ordinary USB removal must never read as a start failure.
        if low.contains("0xe00002c0") { return ("unplug", "iokit_no_device", "0xe00002c0", "kIOReturnNoDevice") }
        if deviceGoneRX.matches(msg) { return ("unplug", "device_removed", nil, nil) }
        if low.contains("0xe00002ed") { return ("start_failure", "iokit_not_responding", "0xe00002ed", "kIOReturnNotResponding") }
        if notRespondingRX.matches(msg) { return ("start_failure", "device_not_responding", nil, nil) }
        if cannotStartRX.matches(msg) { return ("start_failure", "cannot_start_io", nil, nil) }
        for g in errNumRX.allMatches(msg) {
            if let v = numeric(g[1]), v != 0 { return ("hal_error", "hal_error", g[1], nil) }
        }
        if let g = errFourCCRX.match(msg) { return ("hal_error", "hal_error", "'\(g[1])'", nil) }
        if failRX.matches(msg) { return ("hal_error", "hal_error", nil, nil) }
        return nil
    }

    /// One ndjson object -> (timestamp, process, pid, subsystem, message). The trailer object that `log show`
    /// prints at the end ({"count":0,"finished":1}) has no eventMessage and is skipped.
    static func fields(_ line: String) -> (ts: Date, process: String, pid: Int, subsystem: String, message: String)? {
        guard let d = J.dict(line), let msg = d["eventMessage"] as? String,
              let stamp = d["timestamp"] as? String, let g = tsRX.match(stamp),
              let ts = TimeFmt.parseStamp(date: g[1], time: g[2], frac: g[3], tz: g[4]) else { return nil }
        var process = (d["process"] as? String) ?? ""
        if process.isEmpty, let path = d["processImagePath"] as? String {
            process = (path as NSString).lastPathComponent
        }
        let pid = (d["processID"] as? NSNumber)?.intValue ?? 0
        return (ts, process, pid, (d["subsystem"] as? String) ?? "", msg)
    }

    static func parse(_ text: String, maxHits: Int = 50) -> [AudioLogHit] {
        var hits: [AudioLogHit] = []
        var seenNorm: [String: Date] = [:]
        text.enumerateLines { line, stop in
            guard line.hasPrefix("{"), let f = fields(line), let c = classify(f.message) else { return }
            let clean = AudioNames.scrubMessage(f.message).squashed.truncated(400)
            let norm = digitsRX.replace(clean, with: "#")
            if let last = seenNorm[norm], f.ts.timeIntervalSince(last) < 60 { return }
            seenNorm[norm] = f.ts
            hits.append(AudioLogHit(ts: f.ts, process: f.process, pid: f.pid, subsystem: f.subsystem, cls: c.cls,
                                    detail: c.detail, code: c.code, codeName: c.codeName, message: clean))
            if hits.count >= maxHits { stop = true }
        }
        return hits
    }

    static func event(_ h: AudioLogHit) -> DraftEvent {
        var p: Payload = ["class": h.cls, "detail": h.detail, "start_failure": h.startFailure, "process": h.process,
                          "pid": h.pid, "message": h.message, "log_ts": TimeFmt.iso(h.ts)]
        if !h.subsystem.isEmpty { p["subsystem"] = h.subsystem }
        if let c = h.code { p["code"] = c }
        if let n = h.codeName { p["code_name"] = n }
        return DraftEvent("audio.error", p, ts: h.ts)
    }

    static let predicate =
        #"(process == "coreaudiod" OR subsystem BEGINSWITH "com.apple.audio" OR (process == "kernel" AND eventMessage CONTAINS "IOUSBHost")) "#
        + #"AND (eventMessage CONTAINS[c] "error" OR eventMessage CONTAINS[c] "fail" OR eventMessage CONTAINS[c] "not responding" "#
        + #"OR eventMessage CONTAINS[c] "0xe00002" OR eventMessage CONTAINS[c] "cannot start")"#

    /// The ladder reacts to audio.error events of class start_failure and to nothing else (an unplug never counts).
    static func hasStartFailure(_ events: [DraftEvent]) -> Bool {
        events.contains { $0.kind == "audio.error" && ($0.payload["class"] as? String) == "start_failure" }
    }

    /// The exact argv of the `log show` call. The parser above reads ndjson, so the style is asserted by a test.
    static func logArgs(from: Date) -> [String] {
        ["show", "--style", "ndjson", "--start", TimeFmt.localLogStamp(from), "--predicate", predicate]
    }
}

// MARK: - Collector

final class AudioCollector {
    private let ctx: Context
    private var lastDeviceDigest: String?
    private var lastPresenceDigest: String?
    private var lastUsb: [UsbDevice]?
    private var lastEngines: [AudioEngineEntry] = []
    private(set) var lastDevices: [AudioDeviceInfo] = []
    private(set) var lastMethod = "none"
    private(set) var missingInputStreak = 0
    /// True once a system_profiler read has succeeded (until then "no default input" is unknown, not missing).
    private(set) var profileKnown = false
    private var profileRequested = false
    static let logCursorKey = "cursor.audiolog"
    static let scannedKey = "audiolog.scanned_from"
    /// How the daemon reads devices. Presence (every 60 s) is ioreg only: the USB tree and the IOAudio objects, which
    /// involve neither coreaudiod nor system_profiler. `system_profiler SPAudioDataType -json` (default input and
    /// names) runs only at start, every 30 minutes, and within seconds of an ioreg change. CoreAudio's HAL and
    /// CoreGraphics are never linked: touching them makes macOS run TCC checks on a headless root daemon.
    static let presenceMethod = "ioreg"
    static let profileMethod = "system_profiler"
    static let profileInterval: TimeInterval = 30 * 60
    static let profileDelayAfterChange: TimeInterval = 3

    init(ctx: Context) { self.ctx = ctx }

    var hasDefaultInput: Bool { lastDevices.contains { $0.isDefaultInput && $0.inputChannels > 0 } }

    private func readProfile() -> [AudioDeviceInfo]? {
        let sp = ctx.runner.run(Tool.systemProfiler, ["SPAudioDataType", "-json"], timeout: 30)
        guard sp.ok else { return nil }
        return SystemProfilerAudio.parse(sp.stdout)
    }

    private func sanitized(_ raw: [AudioDeviceInfo]) -> [AudioDeviceInfo] {
        raw.map { d -> AudioDeviceInfo in var c = d; c.name = AudioNames.sanitize(d.name); return c }
    }

    /// Refresh `lastDevices` without touching change-detection state (used by the ladder's recovery check).
    @discardableResult
    func refreshOnly() -> Bool {
        guard let raw = readProfile() else { return false }
        lastDevices = sanitized(raw)
        lastMethod = Self.profileMethod
        profileKnown = true
        return true
    }

    private func readIoregUSB() -> [UsbDevice]? {
        let r = ctx.runner.run(Tool.ioreg, ["-r", "-c", "IOUSBHostDevice", "-l", "-d", "2", "-w0"], timeout: 10)
        guard r.ok else { return nil }
        return IoregUSB.parse(r.stdout)
    }

    private func readIoregEngines() -> [AudioEngineEntry]? {
        var all: [AudioEngineEntry] = []
        for cls in IoregAudio.classes {
            let r = ctx.runner.run(Tool.ioreg, ["-r", "-c", cls, "-d", "1", "-w0"], timeout: 10)
            guard r.ok else { return nil }
            all += IoregAudio.parse(r.stdout)
        }
        return all
    }

    /// Set when the last presence poll saw the ioreg picture change; the daemon then reads the profile within
    /// `profileDelayAfterChange` seconds. Reading it clears the flag.
    func takeProfileRequest() -> Bool {
        let r = profileRequested
        profileRequested = false
        return r
    }

    private func usbPayload(_ p: inout Payload, _ u: [UsbDevice], added: [UsbDevice], removed: [UsbDevice]) {
        p["usb_audio"] = u.filter { $0.audioLike && !$0.builtin }.map { $0.payload() }
        p["usb_device_count"] = u.filter { !$0.builtin }.count
        p["usb_added"] = added.map { $0.payload() }
        p["usb_removed"] = removed.map { $0.payload() }
    }

    /// Every 60 s. ioreg only (USB tree + IOAudio classes). Emits `audio.devices` (method "ioreg") on the first
    /// poll and whenever a USB or audio object appears or disappears, and asks for a profile read after a change.
    func presencePoll() -> CollectorResult {
        var res = CollectorResult()
        if profileKnown { missingInputStreak = hasDefaultInput ? 0 : missingInputStreak + 1 }
        guard let usb = readIoregUSB() else {
            res.degraded = true
            res.notes.append("ioreg USB tree unavailable")
            return res
        }
        let engines = readIoregEngines()
        if engines == nil { res.notes.append("ioreg IOAudio classes unavailable") }
        let digest = (usb.map { $0.key } + (engines ?? lastEngines).map { $0.key }).sorted().joined(separator: "\n")
        let first = lastPresenceDigest == nil
        let changed = !first && digest != lastPresenceDigest
        var added: [UsbDevice] = [], removed: [UsbDevice] = []
        if let old = lastUsb { let d = IoregUSB.diff(old: old, new: usb); added = d.added; removed = d.removed }
        let oldEngines = Set(lastEngines.map { $0.key })
        let newEngines = engines ?? lastEngines
        lastUsb = usb
        lastEngines = newEngines
        lastPresenceDigest = digest
        lastMethod = Self.presenceMethod
        guard first || changed else { return res }
        if changed { profileRequested = true }
        var p: Payload = ["method": Self.presenceMethod, "trigger": first ? "first" : "usb_change"]
        usbPayload(&p, usb, added: added, removed: removed)
        p["audio_engines"] = newEngines.map { $0.payload() }
        p["audio_engines_added"] = newEngines.filter { !oldEngines.contains($0.key) }.map { $0.payload() }
        p["audio_engines_removed"] = lastEnginesRemoved(old: oldEngines, new: newEngines)
        res.events.append(DraftEvent("audio.devices", p))
        return res
    }

    private func lastEnginesRemoved(old: Set<String>, new: [AudioEngineEntry]) -> [Payload] {
        let n = Set(new.map { $0.key })
        return old.subtracting(n).sorted().map { k in
            let parts = k.split(separator: "|", maxSplits: 1).map(String.init)
            return ["class": parts.first ?? "", "name": parts.count > 1 ? parts[1] : ""] as Payload
        }
    }

    /// Start, every 30 minutes, and after an ioreg change (`trigger` "start" | "periodic" | "usb_change"):
    /// `system_profiler SPAudioDataType -json` for names and the default input. Emits `audio.devices` (method
    /// "system_profiler") at start, after an ioreg change, and whenever the profile itself changed.
    func profilePoll(trigger: String) -> CollectorResult {
        var res = CollectorResult()
        guard let raw = readProfile() else {
            res.degraded = true
            res.notes.append("audio profile unavailable (system_profiler SPAudioDataType failed)")
            return res
        }
        let devices = sanitized(raw)
        lastDevices = devices
        lastMethod = Self.profileMethod
        profileKnown = true
        missingInputStreak = hasDefaultInput ? 0 : missingInputStreak
        let digest = devices.map { "\($0.uid ?? "-")|\($0.name)|\($0.transport)|\($0.isDefaultInput)" }.sorted().joined(separator: "\n")
        let first = lastDeviceDigest == nil
        let devChanged = !first && digest != lastDeviceDigest
        lastDeviceDigest = digest
        guard first || devChanged || trigger == "usb_change" || trigger == "start" else { return res }
        var p: Payload = ["method": Self.profileMethod, "trigger": trigger]
        p["devices"] = devices.map { $0.payload() }
        if let din = devices.first(where: { $0.isDefaultInput }) {
            p["default_input"] = ["name": din.name, "uid": jv(din.uid)] as Payload
        } else {
            p["default_input"] = NSNull()
        }
        p["default_input_present"] = hasDefaultInput
        res.events.append(DraftEvent("audio.devices", p))
        return res
    }

    /// `--once`: both views in one go.
    func snapshotPoll() -> CollectorResult {
        var a = presencePoll()
        let b = profilePoll(trigger: "start")
        a.events += b.events
        a.notes += b.notes
        a.degraded = a.degraded || b.degraded
        return a
    }

    func logPoll() -> CollectorResult {
        var res = CollectorResult()
        let now = ctx.clock.now()
        var from = now.addingTimeInterval(-10 * 60)
        if let t = ctx.state.get(Self.scannedKey) as? Double {
            from = max(Date(timeIntervalSince1970: t - 5), now.addingTimeInterval(-6 * 3600))
        }
        let r = ctx.runner.run(Tool.log, AudioLogScan.logArgs(from: from), timeout: 55)
        guard r.ok else {
            res.degraded = true
            res.notes.append("log show: \(r.failureNote)")
            return res
        }
        ctx.state.set(Self.scannedKey, now.timeIntervalSince1970)
        let hits = AudioLogScan.parse(r.stdout)
        var cursor = LogCursor.load(ctx.state, key: Self.logCursorKey)
        let fresh = cursor.advance(hits, ts: { $0.ts }, digest: { "\($0.cls)|\($0.message)" }, floor: nil)
        cursor.save(ctx.state, key: Self.logCursorKey)
        res.events = fresh.map { AudioLogScan.event($0) }
        return res
    }
}
