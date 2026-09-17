import Foundation

/// The telemetry that rides on the poll GET as query parameters (InstallPollFields.swift). There is no heartbeat
/// endpoint. NIL MEANS NOT MEASURED AND IS SENT AS ABSENCE: the server COALESCEs these columns, so an omitted field keeps
/// the last good reading while a guessed one overwrites a true value.
///
/// Linux reports a SUBSET. Fields this build cannot measure honestly are never sent — see `LinuxMachineFacts` in
/// room-bench for which, and why.
public struct InstallPollFields: Equatable, Sendable {
    public struct InputDevice: Equatable, Sendable {
        public var name: String
        public var uid: String
        public var isDefault: Bool
        public init(name: String, uid: String, isDefault: Bool) {
            self.name = name
            self.uid = uid
            self.isDefault = isDefault
        }
    }

    public var installID: String
    public var appVersion: String?
    public var buildSHA: String?
    public var micState: String?
    public var tapeAdvancing: Bool
    public var neverSleep: Bool?
    public var launchedBy: String?
    public var hostname: String?
    public var hardwareModel: String?
    public var osVersion: String?
    public var inputDeviceName: String?
    public var sessionOpen: Bool?
    public var updateChannel: String?
    public var diskFreeBytes: Int64?
    public var peak: Double?
    public var zeroRatio: Double?
    public var inputDevices: [InputDevice]?
    public var inputVolume: Double?
    public var inputVolumeSettable: Bool?
    public var clipCount: Int?
    public var silenceMS: Int64?
    public var channelLocked: Bool?

    public init(installID: String, tapeAdvancing: Bool) {
        self.installID = installID
        self.tapeAdvancing = tapeAdvancing
    }

    /// InstallPollFields.swift `queryItems()`, in its order.
    public func queryItems() -> [URLQueryItem] {
        var items = [URLQueryItem(name: "install_id", value: installID)]
        func add(_ name: String, _ value: String?) {
            guard let value, !value.isEmpty else { return }
            items.append(URLQueryItem(name: name, value: value))
        }
        func flag(_ name: String, _ value: Bool?) {
            if let value { items.append(URLQueryItem(name: name, value: value ? "true" : "false")) }
        }
        add("app_version", appVersion)
        add("build_sha", buildSHA)
        add("mic_state", micState)
        items.append(URLQueryItem(name: "tape_advancing", value: tapeAdvancing ? "true" : "false"))
        flag("never_sleep", neverSleep)
        add("launched_by", launchedBy)
        add("hostname", hostname)
        add("hardware_model", hardwareModel)
        add("os_version", osVersion)
        add("input_device_name", inputDeviceName)
        flag("session_open", sessionOpen)
        add("update_channel", updateChannel)
        if let diskFreeBytes, diskFreeBytes > 0 {
            items.append(URLQueryItem(name: "disk_free_bytes", value: String(diskFreeBytes)))
        }
        add("peak", Self.unitString(peak))
        add("zero_ratio", Self.unitString(zeroRatio))
        add("input_devices", inputDevices.flatMap(Self.inputDevicesJSON))
        add("input_volume", Self.unitString(inputVolume))
        flag("input_volume_settable", inputVolumeSettable)
        if let clipCount, clipCount >= 0 { items.append(URLQueryItem(name: "clip_count", value: String(clipCount))) }
        if let silenceMS, silenceMS >= 0 { items.append(URLQueryItem(name: "silence_ms", value: String(silenceMS))) }
        flag("channel_locked", channelLocked)
        return items
    }

    /// Four decimals, POSIX; outside 0-1 or not finite is dropped, never clamped.
    public static func unitString(_ value: Double?) -> String? {
        guard let value, value.isFinite, (0...1).contains(value) else { return nil }
        return fourDecimals(value)
    }

    /// `String(format: "%.4f")` without a locale dependency.
    public static func fourDecimals(_ value: Double) -> String {
        let scaled = (value * 10_000).rounded()
        let whole = Int64(scaled) / 10_000
        let fraction = abs(Int64(scaled) % 10_000)
        let digits = String(fraction)
        return "\(whole).\(String(repeating: "0", count: 4 - digits.count))\(digits)"
    }

    static let inputDevicesMax = 16
    static let inputDeviceNameMax = 128
    static let inputDeviceUIDMax = 256

    /// B2-D10's bounds, counted in UTF-16 after trimming; a bad entry is dropped, not the list. Nil when every entry was
    /// dropped; `[]` only when there were none.
    static func inputDevicesJSON(_ devices: [InputDevice]) -> String? {
        struct Wire: Encodable {
            let name: String
            let uid: String
            let is_default: Bool
        }
        var kept: [Wire] = []
        var defaultKept = false
        for device in devices {
            let name = device.name.trimmingCharacters(in: .whitespacesAndNewlines)
            let uid = device.uid.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, !uid.isEmpty, name.utf16.count <= inputDeviceNameMax, uid.utf16.count <= inputDeviceUIDMax,
                  !(device.isDefault && defaultKept) else { continue }
            if device.isDefault { defaultKept = true }
            kept.append(Wire(name: name, uid: uid, is_default: device.isDefault))
            if kept.count == inputDevicesMax { break }
        }
        if kept.isEmpty && !devices.isEmpty { return nil }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(kept) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
