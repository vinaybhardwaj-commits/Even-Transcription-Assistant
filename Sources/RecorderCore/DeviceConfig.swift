// U3 fix 1: the capture re-pins itself when config.json's device identity changes.
//
// The capture reads its pinned device from config.json (`device_uid`, spec S5: `usb:<vid>:<pid>`) and watches that file.
// room-bench writes a new identity for `set_audio_input` and never restarts anything. On a change the capture decides:
//   - the new device is NOT present  -> no switch, no stop: keep recording the current device, put config.json back,
//                                       report `refused_absent`. A working mic is never traded for a missing one.
//   - the new device IS present      -> close cleanly (a `stopped` record) and re-exec the same process image, whose
//                                       startup resolves the new identity and continues the tape (a `restart` record).
// A re-exec'd start that cannot get the new device ready within `repinReadySeconds` goes back to the device it came
// from, puts config.json back, and reports `reverted`. The outcome of every decision is written to capture-device.json,
// which room-bench reads to ack truthfully.
//
// Everything here is pure or plain file I/O; nothing touches a sound card.
import Foundation
#if canImport(Glibc)
import Glibc
#endif

/// `usb:<vid>:<pid>`, four lower-case hex digits each (spec S5).
public struct PinnedUSBIdentity: Equatable, Hashable, Sendable, CustomStringConvertible {
    public let vendor: String
    public let product: String

    public init?(_ raw: String) {
        let parts = raw.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "usb",
              parts[1].count == 4, parts[1].allSatisfy(\.isHexDigit), parts[2].count == 4, parts[2].allSatisfy(\.isHexDigit) else { return nil }
        vendor = parts[1].lowercased()
        product = parts[2].lowercased()
    }

    /// `/proc/asound/cardN/usbid`'s form, `vvvv:pppp`.
    public var procUSBID: String { "\(vendor):\(product)" }
    public var description: String { "usb:\(vendor):\(product)" }
}

/// One capture PCM as the device layer lists it, with the card's USB id when it has one.
public struct ListedCapture: Equatable, Sendable {
    public var stableName: String
    public var card: Int
    public var device: Int
    public var usbID: String?
    public init(stableName: String, card: Int, device: Int, usbID: String?) {
        self.stableName = stableName
        self.card = card
        self.device = device
        self.usbID = usbID
    }
}

public enum DeviceIdentityResolution {
    /// The capture PCM for an identity: exact usb id match, lowest card then device. Nil when nothing matches.
    public static func resolve(_ identity: PinnedUSBIdentity, in listed: [ListedCapture]) -> ListedCapture? {
        listed.filter { $0.usbID?.lowercased() == identity.procUSBID }
            .sorted { ($0.card, $0.device) < ($1.card, $1.device) }
            .first
    }
}

/// What the capture does when config.json's identity changes under it.
public enum RepinDecision: Equatable, Sendable {
    /// Same identity, or a file this build cannot read: nothing to do.
    case ignore(reason: String)
    /// The new device is not attached. Keep recording; put config.json back.
    case refuseAbsent(requested: PinnedUSBIdentity)
    case switchTo(PinnedUSBIdentity, ListedCapture)

    public static func decide(current: PinnedUSBIdentity, configured raw: String?, listed: [ListedCapture]) -> RepinDecision {
        guard let raw else { return .ignore(reason: "config.json has no readable device_uid") }
        guard let requested = PinnedUSBIdentity(raw) else { return .ignore(reason: "device_uid \(raw.prefix(64)) is not usb:<vid>:<pid>") }
        guard requested != current else { return .ignore(reason: "unchanged") }
        guard let found = DeviceIdentityResolution.resolve(requested, in: listed) else { return .refuseAbsent(requested: requested) }
        return .switchTo(requested, found)
    }
}

/// `capture-device.json`, beside config.json: what the capture is recording from and what became of the last request.
public struct CaptureDeviceStatus: Codable, Equatable, Sendable {
    public enum Outcome: String, Codable, Sendable {
        /// An ordinary start on the configured device.
        case started
        /// A re-pin that took: now recording `deviceUID`, which is what was requested.
        case switched
        /// The requested device was not attached: nothing changed.
        case refusedAbsent = "refused_absent"
        /// The requested device was attached but could not be made ready: back on the previous device.
        case reverted
    }
    public var deviceUID: String
    public var requestedUID: String
    public var outcome: Outcome
    public var alsaName: String?
    public var reason: String?
    public var atWallNS: Int64
    public var pid: Int32

    enum CodingKeys: String, CodingKey {
        case outcome, reason, pid
        case deviceUID = "device_uid"
        case requestedUID = "requested_uid"
        case alsaName = "alsa_name"
        case atWallNS = "at_wall_ns"
    }

    public init(deviceUID: String, requestedUID: String, outcome: Outcome, alsaName: String?, reason: String?, atWallNS: Int64, pid: Int32) {
        self.deviceUID = deviceUID
        self.requestedUID = requestedUID
        self.outcome = outcome
        self.alsaName = alsaName
        self.reason = reason
        self.atWallNS = atWallNS
        self.pid = pid
    }
}

public enum DeviceConfigFile {
    public static let statusFileName = "capture-device.json"
    /// How long a re-exec'd start gives the NEW device to become ready before going back to the old one. Covers a PCM
    /// that is present but still settling; deliberately short, because the room is not recording while it waits.
    public static let repinReadySeconds: Double = 5
    /// How often the capture looks at config.json.
    public static let watchIntervalSeconds: Double = 1

    public struct FileSignature: Equatable, Sendable {
        var inode: UInt64
        var size: Int64
        var mtimeNS: Int64
    }

    public static func signature(_ path: String) -> FileSignature? {
        var info = stat()
        guard stat(path, &info) == 0 else { return nil }
        return FileSignature(inode: UInt64(info.st_ino), size: Int64(info.st_size),
                             mtimeNS: Int64(info.st_mtim.tv_sec) * 1_000_000_000 + Int64(info.st_mtim.tv_nsec))
    }

    /// The `device_uid` string, or nil when the file is missing, unreadable or not a JSON object carrying one.
    public static func readDeviceUID(_ path: String) -> String? {
        guard let data = FileManager.default.contents(atPath: path),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return object["device_uid"] as? String
    }

    /// Read-modify-write of ONE key, every other key kept, atomically at 0600: O_EXCL temp, fchmod, fsync, rename,
    /// fsync(dir). The same discipline room-bench's store uses for the same file.
    public static func rewriteDeviceUID(_ path: String, to uid: String) throws {
        guard let data = FileManager.default.contents(atPath: path),
              var object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CocoaError(.fileReadCorruptFile)
        }
        object["device_uid"] = uid
        try atomicWrite(try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]), to: path)
    }

    public static func writeStatus(_ status: CaptureDeviceStatus, besideConfig configPath: String) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try atomicWrite(try encoder.encode(status), to: statusPath(besideConfig: configPath))
    }

    public static func statusPath(besideConfig configPath: String) -> String {
        (configPath as NSString).deletingLastPathComponent + "/" + statusFileName
    }

    static func atomicWrite(_ data: Data, to path: String) throws {
        let directory = (path as NSString).deletingLastPathComponent
        let temporary = "\(directory)/.\((path as NSString).lastPathComponent).\(UUID().uuidString).tmp"
        let fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        var installed = false
        defer {
            close(fd)
            if !installed { unlink(temporary) }
        }
        try data.withUnsafeBytes { bytes in
            var done = 0
            while done < bytes.count {
                let n = write(fd, bytes.baseAddress! + done, bytes.count - done)
                if n < 0 {
                    if errno == EINTR { continue }
                    throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                }
                done += n
            }
        }
        guard fchmod(fd, 0o600) == 0, fsync(fd) == 0, rename(temporary, path) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        installed = true
        let dirFD = open(directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        if dirFD >= 0 { _ = fsync(dirFD); close(dirFD) }
    }
}

/// U4: which identity a `--device-config` start pins. The capture must not depend on enrolment (V8): before the first
/// enrol there is no config.json, and a capture that refused to start until one existed would make recording wait on
/// the network. So the install-time `--default-device-uid` stands in until config.json names a device, and the watcher
/// re-pins from config.json as usual once it does.
public enum StartIdentity {
    public enum Source: Equatable, Sendable {
        /// config.json's own device_uid.
        case config
        /// No config.json yet (not enrolled): the install-time default.
        case defaultNoConfig
        /// config.json exists but names no usable device_uid: the install-time default, said loudly.
        case defaultUnusableConfig(String)
    }

    /// Nil when neither config.json nor the default gives a `usb:<vid>:<pid>`.
    public static func choose(configExists: Bool, configRaw: String?, defaultRaw: String?) -> (identity: PinnedUSBIdentity, source: Source)? {
        if let raw = configRaw, let identity = PinnedUSBIdentity(raw) { return (identity, .config) }
        guard let raw = defaultRaw, let fallback = PinnedUSBIdentity(raw) else { return nil }
        guard configExists else { return (fallback, .defaultNoConfig) }
        let why = configRaw.map { "device_uid \($0.prefix(64)) is not usb:<vid>:<pid>" } ?? "no readable device_uid"
        return (fallback, .defaultUnusableConfig(why))
    }
}

/// The re-exec'd start's choice: the new device if it became ready in time, else the one it came from.
public enum RepinStartup {
    public enum Choice: Equatable, Sendable {
        case useRequested
        case revertTo(PinnedUSBIdentity, reason: String)
    }

    /// `requestedReady` is the bounded wait's verdict on the requested device (`nil` reason means ready).
    public static func decide(requestedNotReadyReason: String?, previous: PinnedUSBIdentity) -> Choice {
        guard let reason = requestedNotReadyReason else { return .useRequested }
        return .revertTo(previous, reason: reason)
    }

    /// argv for the re-exec: the same arguments, with `--repin-from <previous>` set exactly once.
    public static func execArguments(_ arguments: [String], previous: PinnedUSBIdentity) -> [String] {
        var out: [String] = []
        var i = 0
        while i < arguments.count {
            if arguments[i] == "--repin-from" { i += 2; continue }
            out.append(arguments[i])
            i += 1
        }
        return out + ["--repin-from", previous.description]
    }
}
