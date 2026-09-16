import Foundation
#if canImport(Glibc)
import Glibc
#endif

/// Pinned paths. ffmpeg is resolved from an absolute path and NEVER from PATH (spec D2); the Mac's equivalent is the
/// bundled `Contents/Helpers/ffmpeg` with no fallback (InstallPollFields.swift:359-372). On Ubuntu the U4 apt dependency
/// installs it here.
public enum Pinned {
    public static let stateRoot = "/var/lib/room-recorder"
    public static let tapeDirectory = "/var/lib/room-recorder/tape"
    public static let ffmpegPath = "/usr/bin/ffmpeg"
    /// A build constant, the one kind of constant §5.5 permits: it describes the build, not the machine.
    public static let appVersion = "linux-u3"
}

public enum RoomStoreError: Error, Equatable, CustomStringConvertible {
    case unsafeRoot(String)
    case notOwnedByUs(path: String, owner: UInt32, us: UInt32)
    case refused(path: String, reason: String)
    case io(String)

    public var description: String {
        switch self {
        case .unsafeRoot(let why): return "state directory is unsafe: \(why)"
        case .notOwnedByUs(let path, let owner, let us):
            return "\(path) is owned by uid \(owner), not by this process (uid \(us)); run as the room-recorder account"
        case .refused(let path, let reason): return "refusing \(path): \(reason)"
        case .io(let message): return message
        }
    }
}

/// `room-session.json` — the room session. Exactly the Mac's fields (RoomSessionStore.swift `Stored`).
public struct RoomSessionRecord: Codable, Equatable, Sendable {
    public var sessionToken: String
    public var installID: String
    public var roomSlug: String
    public var roomName: String
    public var origin: String
    public var writtenBy: String
    public var writtenAt: Date

    enum CodingKeys: String, CodingKey {
        case sessionToken = "session_token"
        case installID = "install_id"
        case roomSlug = "room_slug"
        case roomName = "room_name"
        case origin
        case writtenBy = "written_by"
        case writtenAt = "written_at"
    }
}

/// `config.json`. The Mac's keys where they apply to Linux (RoomConfiguration.swift), with no token ever: the session
/// lives in room-session.json only. Dropped because they name macOS machinery: tapewriter_path, the resident archive
/// keys. Added: tape_dir, because the tape is one fixed continuous file here rather than per-session segment dirs (V1).
public struct RoomConfig: Codable, Equatable, Sendable {
    public var origin: URL
    public var roomSlug: String
    /// `usb:<VID>:<PID>`, spec S5.
    public var deviceUID: String
    public var ffmpegPath: String
    public var tapeDir: String
    public var installID: String?
    public var tabID: String?
    public var updateChannel: String
    public var channelLocked: Bool

    enum CodingKeys: String, CodingKey {
        case origin
        case roomSlug = "room_slug"
        case deviceUID = "device_uid"
        case ffmpegPath = "ffmpeg_path"
        case tapeDir = "tape_dir"
        case installID = "install_id"
        case tabID = "tab_id"
        case updateChannel = "update_channel"
        case channelLocked = "channel_locked"
    }

    public init(origin: URL, roomSlug: String, deviceUID: String, ffmpegPath: String = Pinned.ffmpegPath,
                tapeDir: String = Pinned.tapeDirectory, installID: String? = nil, tabID: String? = nil,
                updateChannel: String = "stable", channelLocked: Bool = false) {
        self.origin = origin
        self.roomSlug = roomSlug
        self.deviceUID = deviceUID
        self.ffmpegPath = ffmpegPath
        self.tapeDir = tapeDir
        self.installID = installID
        self.tabID = tabID
        self.updateChannel = updateChannel
        self.channelLocked = channelLocked
    }

    public init(from decoder: Decoder) throws {
        let v = try decoder.container(keyedBy: CodingKeys.self)
        self.init(origin: try v.decode(URL.self, forKey: .origin),
                  roomSlug: try v.decode(String.self, forKey: .roomSlug),
                  deviceUID: try v.decode(String.self, forKey: .deviceUID),
                  ffmpegPath: try v.decode(String.self, forKey: .ffmpegPath),
                  tapeDir: try v.decodeIfPresent(String.self, forKey: .tapeDir) ?? Pinned.tapeDirectory,
                  installID: try v.decodeIfPresent(String.self, forKey: .installID),
                  tabID: try v.decodeIfPresent(String.self, forKey: .tabID),
                  // Absent means stable; a channel this build does not know is stable (RoomConfiguration.swift:318-322).
                  updateChannel: { let c = try? v.decodeIfPresent(String.self, forKey: .updateChannel); return ["stable", "test"].contains(c ?? "") ? c! : "stable" }(),
                  channelLocked: try v.decodeIfPresent(Bool.self, forKey: .channelLocked) ?? false)
    }

    /// RoomConfiguration.swift:536-559 `applyEnrolment`. DELIBERATELY ABSENT: `deviceUID` — a re-enrol keeps the room's
    /// device (V's ruling, 8 Sep). Also untouched: `channelLocked`, which only a hand on the machine sets.
    public mutating func applyEnrolment(origin: URL, roomSlug: String, installID: String) {
        self.ffmpegPath = Pinned.ffmpegPath
        self.origin = origin
        self.roomSlug = roomSlug
        self.installID = installID
        self.tabID = "app_\(installID)"
        self.updateChannel = "stable"
    }
}

/// `status.json` (RoomConfiguration.swift `RoomRecorderStatus`), same state names.
public struct RoomStatus: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable {
        case ready, recording, paused, failed, offline
        case uploadPending = "upload_pending"
        case needsEnrol = "needs_enrol"
    }
    public var state: State
    public var sessionID: String?
    public var pendingPieceCount: Int
    public var lastError: String?
    public var updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case state
        case sessionID = "session_id"
        case pendingPieceCount = "pending_piece_count"
        case lastError = "last_error"
        case updatedAt = "updated_at"
    }

    public init(state: State, sessionID: String? = nil, pendingPieceCount: Int = 0, lastError: String? = nil, updatedAt: Date = Date()) {
        self.state = state
        self.sessionID = sessionID
        self.pendingPieceCount = max(0, pendingPieceCount)
        self.lastError = lastError.map { String($0.prefix(500)) }
        self.updatedAt = updatedAt
    }
}

/// `retired.json` — Linux only. The Mac stops polling for the life of the process on 409 RETIRED and launchd leaves it
/// stopped. Under systemd `Restart=always` a process exit is not permanent, so the retirement is written down and a
/// start that finds it for the configured install id refuses to poll. A re-enrol, which mints a new install id,
/// supersedes it.
public struct RetiredMarker: Codable, Equatable, Sendable {
    public var installID: String
    public var at: Date
    enum CodingKeys: String, CodingKey {
        case installID = "install_id"
        case at
    }
}

/// The state directory, `/var/lib/room-recorder`: 0750, owned by the account that runs this, holding config.json,
/// room-session.json, status.json and the spool. Every JSON file is written atomically at 0600 — mode set BEFORE the
/// rename, so no reader ever sees it wider — and every read refuses a file that is not a regular 0600 file owned by us.
public struct RoomStore: Sendable {
    public static let directoryMode: mode_t = 0o750
    public static let fileMode: mode_t = 0o600

    public let root: URL
    /// Test hook: observes each completed install, by file name, in order.
    let didWrite: (@Sendable (String) -> Void)?

    public init(root: URL, didWrite: (@Sendable (String) -> Void)? = nil) {
        self.root = root.standardizedFileURL
        self.didWrite = didWrite
    }

    public var configURL: URL { root.appendingPathComponent("config.json") }
    public var sessionURL: URL { root.appendingPathComponent("room-session.json") }
    public var statusURL: URL { root.appendingPathComponent("status.json") }
    public var retiredURL: URL { root.appendingPathComponent("retired.json") }
    public var spoolURL: URL { root.appendingPathComponent("spool", isDirectory: true) }
    public var cursorURL: URL { root.appendingPathComponent("cursor.json") }
    public var dropLogURL: URL { root.appendingPathComponent("spool-drops.jsonl") }

    /// The root exists, is a real directory (not a symlink), is ours, and is 0750. Created 0750 if absent — in
    /// production systemd's StateDirectory= has already created it as room-recorder:room-recorder 0750.
    public func prepareRoot() throws {
        var info = stat()
        if lstat(root.path, &info) != 0 {
            guard errno == ENOENT else { throw RoomStoreError.io("cannot stat \(root.path): errno \(errno)") }
            guard mkdir(root.path, Self.directoryMode) == 0 || errno == EEXIST else {
                throw RoomStoreError.io("cannot create \(root.path): errno \(errno)")
            }
            guard lstat(root.path, &info) == 0 else { throw RoomStoreError.io("cannot stat \(root.path): errno \(errno)") }
        }
        guard info.st_mode & S_IFMT == S_IFDIR else { throw RoomStoreError.unsafeRoot("\(root.path) is not a real directory") }
        guard info.st_uid == getuid() else { throw RoomStoreError.notOwnedByUs(path: root.path, owner: info.st_uid, us: getuid()) }
        if info.st_mode & 0o7777 != Self.directoryMode {
            guard chmod(root.path, Self.directoryMode) == 0 else { throw RoomStoreError.io("cannot chmod \(root.path): errno \(errno)") }
        }
    }

    // MARK: typed files

    public func loadConfig() throws -> RoomConfig? { try read(RoomConfig.self, from: configURL) }
    public func saveConfig(_ config: RoomConfig) throws { try write(config, to: configURL) }
    public func loadSession() throws -> RoomSessionRecord? { try read(RoomSessionRecord.self, from: sessionURL) }
    public func saveSession(_ record: RoomSessionRecord) throws { try write(record, to: sessionURL) }
    public func loadStatus() throws -> RoomStatus? { try read(RoomStatus.self, from: statusURL) }
    public func saveStatus(_ status: RoomStatus) throws { try write(status, to: statusURL) }
    public func loadRetired() throws -> RetiredMarker? { try read(RetiredMarker.self, from: retiredURL) }
    public func saveRetired(_ marker: RetiredMarker) throws { try write(marker, to: retiredURL) }
    public func clearRetired() throws {
        if unlink(retiredURL.path) != 0 && errno != ENOENT { throw RoomStoreError.io("cannot remove retired.json: errno \(errno)") }
        try syncDirectory(root)
    }

    // MARK: primitives

    public func write<T: Encodable>(_ value: T, to destination: URL) throws {
        try prepareRoot()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        try writeBytes(try encoder.encode(value), to: destination)
        didWrite?(destination.lastPathComponent)
    }

    /// tmp (O_EXCL, 0600) -> write -> fchmod 0600 -> fsync -> rename -> fsync(dir).
    public func writeBytes(_ data: Data, to destination: URL) throws {
        let directory = destination.deletingLastPathComponent()
        let temporary = directory.appendingPathComponent(".\(destination.lastPathComponent).\(UUID().uuidString).tmp")
        let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, Self.fileMode)
        guard fd >= 0 else { throw RoomStoreError.io("cannot create \(temporary.path): errno \(errno)") }
        var installed = false
        defer {
            close(fd)
            if !installed { unlink(temporary.path) }
        }
        try data.withUnsafeBytes { bytes in
            var done = 0
            while done < bytes.count {
                let n = Glibc.write(fd, bytes.baseAddress! + done, bytes.count - done)
                if n < 0 {
                    if errno == EINTR { continue }
                    throw RoomStoreError.io("cannot write \(temporary.path): errno \(errno)")
                }
                done += n
            }
        }
        guard fchmod(fd, Self.fileMode) == 0, fsync(fd) == 0 else { throw RoomStoreError.io("cannot secure \(temporary.path): errno \(errno)") }
        guard rename(temporary.path, destination.path) == 0 else { throw RoomStoreError.io("cannot install \(destination.path): errno \(errno)") }
        installed = true
        try syncDirectory(directory)
    }

    /// Nil when absent. Refuses a symlink, a non-regular file, a mode other than 0600, or a file owned by someone else.
    public func read<T: Decodable>(_ type: T.Type, from source: URL) throws -> T? {
        var info = stat()
        guard lstat(source.path, &info) == 0 else {
            if errno == ENOENT { return nil }
            throw RoomStoreError.io("cannot stat \(source.path): errno \(errno)")
        }
        guard info.st_mode & S_IFMT == S_IFREG else { throw RoomStoreError.refused(path: source.path, reason: "not a regular file") }
        guard info.st_mode & 0o7777 == Self.fileMode else {
            throw RoomStoreError.refused(path: source.path, reason: "mode is \(String(info.st_mode & 0o7777, radix: 8)), not 600")
        }
        guard info.st_uid == getuid() else { throw RoomStoreError.notOwnedByUs(path: source.path, owner: info.st_uid, us: getuid()) }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        do {
            return try decoder.decode(type, from: try Data(contentsOf: source))
        } catch {
            throw RoomStoreError.refused(path: source.path, reason: "not the JSON this build writes")
        }
    }

    func syncDirectory(_ url: URL) throws {
        let fd = open(url.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard fd >= 0 else { throw RoomStoreError.io("cannot open \(url.path): errno \(errno)") }
        defer { close(fd) }
        _ = fsync(fd)
    }
}
