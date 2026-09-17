import Foundation
#if canImport(Glibc)
import Glibc
#endif

public struct SpooledPiece: Equatable, Sendable {
    public let manifest: PieceManifest
    public let manifestPath: String
    public let mediaPath: String
}

/// One drop, as written to spool-drops.jsonl. Everything a re-cut needs, and nothing from the audio.
public struct SpoolDrop: Codable, Equatable, Sendable {
    public var pieceID: String
    public var sessionID: String
    public var index: Int
    public var byteStart: Int64
    public var byteEnd: Int64
    public var sampleStart: Int64
    public var sampleEnd: Int64
    public var startedAt: String
    public var endedAt: String
    public var durationMS: Int64
    public var gapBeforeMS: Int64
    public var sizeBytes: Int64
    public var droppedAt: String
    public var reason: String

    enum CodingKeys: String, CodingKey {
        case pieceID = "piece_id", sessionID = "session_id", index = "idx", byteStart = "byte_start", byteEnd = "byte_end"
        case sampleStart = "sample_start", sampleEnd = "sample_end", startedAt = "started_at", endedAt = "ended_at"
        case durationMS = "duration_ms", gapBeforeMS = "gap_before_ms", sizeBytes = "size_bytes", droppedAt = "dropped_at", reason
    }

    public static func pieceID(sessionID: String, index: Int) -> String { "\(sessionID)/\(index)" }
}

/// The spool directory IS the ledger (PiecePipeline.swift `RoomPieceSpool`): a piece is `<file>.webm` plus
/// `<file>.webm.manifest.json`, and both are deleted only after a verified registration.
///
/// CAPPED (spec D1, S4), which the Mac is not. When a new piece would take the spooled media over `capBytes`, the OLDEST
/// pieces are dropped first until it fits, each drop logged with its piece id and byte range and appended to the drop
/// log. The new piece is always published: a full spool never stops cutting, and it never touches tape.pcm, so every
/// dropped piece can be re-cut.
public struct PieceSpool: Sendable {
    /// 12 h of pieces (144 at 5 min, the spec's proposal) at the WORST measured size of a 5-minute piece:
    /// 144 x 2 770 122 bytes = 398 897 568. Measured 16 Sep 2026 with the exact argv on synthetic 300 s signals: the
    /// worst was a full-scale clipped square wave, 2 770 122 bytes on the fleet pair (ffmpeg 6.1.1 / libopus 1.4) and
    /// 2 741 281 on this Yoga's (ffmpeg 8.0.1 / libopus 1.6.1) — 2.31x the 1 200 000 bytes that 300 s at 32 kbit/s would
    /// be, because VBR spends bits on tonal content. Speech-like noise bursts measured 1 069 769, silence 212 368.
    /// Manifests (a few hundred bytes each) are not counted.
    public static let defaultCapBytes: Int64 = 144 * 2_770_122

    public let root: URL
    public let capBytes: Int64
    public let dropLog: URL
    let log: RoomLog
    let now: @Sendable () -> Date

    public init(root: URL, dropLog: URL, capBytes: Int64 = defaultCapBytes, log: RoomLog, now: @escaping @Sendable () -> Date = { Date() }) throws {
        self.root = root.standardizedFileURL
        self.capBytes = capBytes
        self.dropLog = dropLog
        self.log = log
        self.now = now
        if mkdir(self.root.path, 0o700) != 0 && errno != EEXIST {
            throw PiecePipelineError.writeFailed(self.root.path, errno)
        }
        var info = stat()
        guard lstat(self.root.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else { throw PiecePipelineError.io("spool root is not a directory") }
        _ = chmod(self.root.path, 0o700)
    }

    public func mediaURL(filename: String) -> URL { root.appendingPathComponent(filename) }
    func manifestPath(_ filename: String) -> String { root.appendingPathComponent("\(filename).manifest.json").path }

    /// Pieces awaiting upload, oldest first (started_at, then session, then index).
    public func pending() throws -> [SpooledPiece] {
        var pieces: [SpooledPiece] = []
        for name in try FileManager.default.contentsOfDirectory(atPath: root.path) where name.hasSuffix(".manifest.json") && !name.hasPrefix(".") {
            let path = root.appendingPathComponent(name).path
            let manifest = try JSONDecoder().decode(PieceManifest.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
            let media = mediaURL(filename: manifest.filename).path
            guard regularFileSize(media) == manifest.sizeBytes else {
                throw PiecePipelineError.invalidManifest("spooled media is missing or changed for \(manifest.filename)")
            }
            pieces.append(SpooledPiece(manifest: manifest, manifestPath: path, mediaPath: media))
        }
        return pieces.sorted {
            ($0.manifest.startedAt, $0.manifest.sessionID, $0.manifest.index) < ($1.manifest.startedAt, $1.manifest.sessionID, $1.manifest.index)
        }
    }

    /// The manifest already spooled under this piece's filename, if any.
    public func existingManifest(filename: String) -> PieceManifest? {
        guard let data = FileManager.default.contents(atPath: manifestPath(filename)) else { return nil }
        return try? JSONDecoder().decode(PieceManifest.self, from: data)
    }

    /// The media is already installed at `mediaURL(filename:)`. Enforce the cap, then install the manifest.
    @discardableResult
    public func publish(_ manifest: PieceManifest) throws -> SpooledPiece {
        let media = mediaURL(filename: manifest.filename).path
        guard let size = regularFileSize(media), size == manifest.sizeBytes else {
            throw PiecePipelineError.invalidManifest("media size does not match \(manifest.sizeBytes)")
        }
        guard chmod(media, 0o600) == 0 else { throw PiecePipelineError.writeFailed(media, errno) }
        try enforceCap(making: manifest.sizeBytes)
        let destination = manifestPath(manifest.filename)
        guard access(destination, F_OK) != 0 else { throw PiecePipelineError.destinationExists(destination) }
        let temporary = root.appendingPathComponent(".manifest-\(UUID().uuidString).json.tmp").path
        defer { unlink(temporary) }
        try writeSynchronized(try manifest.encodedJSON(), to: temporary)
        try installWithoutReplacement(source: temporary, destination: destination)
        try fsyncDirectory(root.path)
        return SpooledPiece(manifest: manifest, manifestPath: destination, mediaPath: media)
    }

    /// Drop oldest-first until `incoming` more bytes fit under the cap. Never drops to zero pieces for its own sake:
    /// when nothing is left to drop, the new piece goes in regardless.
    func enforceCap(making incoming: Int64) throws {
        var queue = try pending()
        var total = queue.reduce(Int64(0)) { $0 + $1.manifest.sizeBytes }
        while total + incoming > capBytes, !queue.isEmpty {
            let oldest = queue.removeFirst()
            try drop(oldest, reason: "spool_cap")
            total -= oldest.manifest.sizeBytes
        }
    }

    func drop(_ piece: SpooledPiece, reason: String) throws {
        let m = piece.manifest
        let record = SpoolDrop(pieceID: SpoolDrop.pieceID(sessionID: m.sessionID, index: m.index), sessionID: m.sessionID, index: m.index,
                               byteStart: m.sampleStart * 2, byteEnd: m.sampleEnd * 2, sampleStart: m.sampleStart, sampleEnd: m.sampleEnd,
                               startedAt: m.startedAt, endedAt: m.endedAt, durationMS: m.durationMS, gapBeforeMS: m.gapBeforeMS,
                               sizeBytes: m.sizeBytes, droppedAt: ISO8601.string(now()), reason: reason)
        // The record goes down BEFORE the piece is removed: a crash between the two leaves a piece that is both logged and
        // still spooled, which uploads normally; the reverse would lose the only record of what to re-cut.
        try appendDrop(record)
        guard unlink(piece.manifestPath) == 0 else { throw PiecePipelineError.writeFailed(piece.manifestPath, errno) }
        try fsyncDirectory(root.path)
        _ = unlink(piece.mediaPath)
        try fsyncDirectory(root.path)
        log("SPOOL FULL: dropped piece \(record.pieceID) bytes \(record.byteStart)-\(record.byteEnd) of tape.pcm (\(m.startedAt) to \(m.endedAt), \(m.sizeBytes) bytes); re-cut with: room-bench recut --piece \(record.pieceID) --bytes \(record.byteStart)-\(record.byteEnd)")
    }

    func appendDrop(_ record: SpoolDrop) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var line = try encoder.encode(record)
        line.append(0x0A)
        let fd = open(dropLog.path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw PiecePipelineError.writeFailed(dropLog.path, errno) }
        defer { close(fd) }
        try line.withUnsafeBytes { try writeAll(fd, $0.baseAddress!, $0.count, dropLog.path) }
        while fsync(fd) != 0 {
            if errno == EINTR { continue }
            throw PiecePipelineError.writeFailed(dropLog.path, errno)
        }
    }

    public func drops() throws -> [SpoolDrop] {
        guard let data = FileManager.default.contents(atPath: dropLog.path) else { return [] }
        return try data.split(separator: 0x0A).map { try JSONDecoder().decode(SpoolDrop.self, from: Data($0)) }
    }

    /// Only after a verified registration, and only when the verification names this exact piece.
    public func removeVerified(_ piece: SpooledPiece, sessionID: String, index: Int, sizeBytes: Int64) throws {
        let m = piece.manifest
        guard sessionID == m.sessionID, index == m.index, sizeBytes == m.sizeBytes,
              piece.manifestPath == manifestPath(m.filename), piece.mediaPath == mediaURL(filename: m.filename).path,
              regularFileSize(piece.mediaPath) == m.sizeBytes else {
            throw PiecePipelineError.verificationMismatch
        }
        guard unlink(piece.manifestPath) == 0 else { throw PiecePipelineError.writeFailed(piece.manifestPath, errno) }
        try fsyncDirectory(root.path)
        guard unlink(piece.mediaPath) == 0 else { throw PiecePipelineError.writeFailed(piece.mediaPath, errno) }
        try fsyncDirectory(root.path)
    }
}
