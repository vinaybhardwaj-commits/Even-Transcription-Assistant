import Foundation
#if canImport(Glibc)
import Glibc
#endif

public struct FFmpegInvocation: Equatable, Sendable {
    public let executable: String
    public let arguments: [String]
}

public protocol PieceProcessRunning: Sendable {
    func run(_ invocation: FFmpegInvocation) throws -> (status: Int32, standardError: String)
}

public struct FoundationProcessRunner: PieceProcessRunning {
    public init() {}
    public func run(_ invocation: FFmpegInvocation) throws -> (status: Int32, standardError: String) {
        let process = Process()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: invocation.executable)
        process.arguments = invocation.arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = errors
        try process.run()
        let data = errors.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: data.prefix(4_096), as: UTF8.self))
    }
}

/// The Mac's encoder (PiecePipeline.swift:478-546): copy the piece's exact byte range out of tape.pcm, run ffmpeg with
/// the exact argv on the copy, fsync the output, install it without replacement.
public struct PieceEncoder: Sendable {
    public let ffmpegPath: String
    let runner: any PieceProcessRunning

    /// The ffmpeg path must be absolute; it is never looked up on PATH (spec D2).
    public init(ffmpegPath: String, runner: any PieceProcessRunning = FoundationProcessRunner()) throws {
        guard ffmpegPath.hasPrefix("/") else { throw PiecePipelineError.io("ffmpeg path must be absolute, got \(ffmpegPath)") }
        self.ffmpegPath = ffmpegPath
        self.runner = runner
    }

    /// PiecePipeline.swift:478-499, verbatim.
    public static func arguments(inputPCM: String, outputWebM: String) -> [String] {
        ["-hide_banner", "-loglevel", "error", "-nostdin", "-n",
         "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", inputPCM,
         "-map_metadata", "-1", "-c:a", "libopus", "-application", "voip",
         "-b:a", "32k", "-vbr", "on", "-frame_duration", "20",
         "-f", "webm", outputWebM]
    }

    @discardableResult
    public func encode(plan: PiecePlan, pcmPath: String, destination: URL) throws -> Int64 {
        guard plan.byteCount > 0 else { throw PiecePipelineError.sourceRangeUnavailable(offset: plan.byteOffset, count: plan.byteCount) }
        guard access(destination.path, F_OK) != 0 else { throw PiecePipelineError.destinationExists(destination.path) }
        let directory = destination.deletingLastPathComponent()
        let token = UUID().uuidString
        let input = directory.appendingPathComponent(".piece-\(token).pcm.tmp").path
        let output = directory.appendingPathComponent(".piece-\(token).webm.tmp").path
        defer {
            unlink(input)
            unlink(output)
        }
        try copyExactRange(source: pcmPath, offset: plan.byteOffset, count: plan.byteCount, destination: input)
        let result = try runner.run(FFmpegInvocation(executable: ffmpegPath, arguments: Self.arguments(inputPCM: input, outputWebM: output)))
        guard result.status == 0 else {
            throw PiecePipelineError.processFailed(status: result.status, stderr: result.standardError.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        let size = try fsyncRegularFile(output)
        guard size > 0 else { throw PiecePipelineError.emptyOutput }
        guard chmod(output, 0o600) == 0 else { throw PiecePipelineError.writeFailed(output, errno) }
        try installWithoutReplacement(source: output, destination: destination.path)
        try fsyncDirectory(directory.path)
        return size
    }
}

/// pread the exact range; a source too short for it is an error, never a short piece.
func copyExactRange(source: String, offset: Int64, count: Int64, destination: String) throws {
    let src = open(source, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    guard src >= 0 else { throw PiecePipelineError.sourceOpenFailed(source, errno) }
    defer { close(src) }
    var info = stat()
    guard fstat(src, &info) == 0, info.st_mode & S_IFMT == S_IFREG, offset >= 0, count >= 0,
          offset <= Int64(info.st_size), count <= Int64(info.st_size) - offset else {
        throw PiecePipelineError.sourceRangeUnavailable(offset: offset, count: count)
    }
    let dst = open(destination, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
    guard dst >= 0 else { throw PiecePipelineError.writeFailed(destination, errno) }
    defer { close(dst) }
    var buffer = [UInt8](repeating: 0, count: 1 << 20)
    var done: Int64 = 0
    while done < count {
        let want = min(buffer.count, Int(count - done))
        let n = buffer.withUnsafeMutableBytes { pread(src, $0.baseAddress!, want, off_t(offset + done)) }
        if n < 0 {
            if errno == EINTR { continue }
            throw PiecePipelineError.readFailed(offset: offset + done, errno: errno)
        }
        guard n > 0 else { throw PiecePipelineError.sourceRangeUnavailable(offset: offset, count: count) }
        try buffer.withUnsafeBytes { try writeAll(dst, $0.baseAddress!, n, destination) }
        done += Int64(n)
    }
}

func writeAll(_ fd: Int32, _ pointer: UnsafeRawPointer, _ count: Int, _ path: String) throws {
    var done = 0
    while done < count {
        let n = write(fd, pointer + done, count - done)
        if n < 0 {
            if errno == EINTR { continue }
            throw PiecePipelineError.writeFailed(path, errno)
        }
        guard n > 0 else { throw PiecePipelineError.writeFailed(path, EIO) }
        done += n
    }
}

func fsyncRegularFile(_ path: String) throws -> Int64 {
    let fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    guard fd >= 0 else { throw PiecePipelineError.emptyOutput }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG else { throw PiecePipelineError.emptyOutput }
    while fsync(fd) != 0 {
        if errno == EINTR { continue }
        throw PiecePipelineError.writeFailed(path, errno)
    }
    return Int64(info.st_size)
}

func fsyncDirectory(_ path: String) throws {
    let fd = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard fd >= 0 else { throw PiecePipelineError.writeFailed(path, errno) }
    defer { close(fd) }
    while fsync(fd) != 0 {
        if errno == EINTR { continue }
        throw PiecePipelineError.writeFailed(path, errno)
    }
}

/// link then unlink: fails with EEXIST rather than replacing anything.
func installWithoutReplacement(source: String, destination: String) throws {
    guard link(source, destination) == 0 else {
        let code = errno
        if code == EEXIST { throw PiecePipelineError.destinationExists(destination) }
        throw PiecePipelineError.writeFailed(destination, code)
    }
    guard unlink(source) == 0 else { throw PiecePipelineError.writeFailed(source, errno) }
}

func writeSynchronized(_ data: Data, to path: String) throws {
    let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw PiecePipelineError.writeFailed(path, errno) }
    defer { close(fd) }
    try data.withUnsafeBytes { try writeAll(fd, $0.baseAddress!, $0.count, path) }
    while fsync(fd) != 0 {
        if errno == EINTR { continue }
        throw PiecePipelineError.writeFailed(path, errno)
    }
}

func regularFileSize(_ path: String) -> Int64? {
    var info = stat()
    guard lstat(path, &info) == 0, info.st_mode & S_IFMT == S_IFREG else { return nil }
    return Int64(info.st_size)
}
