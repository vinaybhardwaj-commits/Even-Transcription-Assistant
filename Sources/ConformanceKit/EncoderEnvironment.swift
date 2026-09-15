import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

/// The encoder a C10 fixture was recorded against. Opus output is not stable across ffmpeg or
/// libopus versions, so these are recorded as provenance and never asserted on.
public struct EncoderEnvironment: Equatable, Sendable {
    public var ffmpegPath: String
    /// First line of `ffmpeg -version`, verbatim.
    public var ffmpegVersion: String
    /// Lines of `ffmpeg -encoders` matching "opus" (case-insensitive), verbatim.
    public var opusEncoders: [String]
    /// `opus_get_version_string()` from the libopus that ffmpeg actually links.
    public var libopusVersion: String
    public var libopusLibrary: String
    /// PRETTY_NAME from /etc/os-release.
    public var host: String

    public var libopusCompiledIn: Bool { opusEncoders.contains { $0.split(separator: " ").contains("libopus") } }

    public static func detect() -> Result<EncoderEnvironment, EncoderDetectionError> {
        guard let ffmpeg = Tools.which("ffmpeg") else { return .failure(.init("ffmpeg not found on PATH")) }
        guard let version = Tools.output(ffmpeg, ["-version"])?.split(separator: "\n").first.map(String.init),
              version.hasPrefix("ffmpeg version ") else {
            return .failure(.init("`ffmpeg -version` did not print a version line"))
        }
        let encoders = (Tools.output(ffmpeg, ["-hide_banner", "-encoders"]) ?? "")
            .split(separator: "\n").map(String.init)
            .filter { $0.lowercased().contains("opus") }
        guard let ldd = Tools.which("ldd"), let linked = Tools.output(ldd, [ffmpeg]) else {
            return .failure(.init("cannot run ldd on \(ffmpeg) to find the libopus it links"))
        }
        guard let line = linked.split(separator: "\n").first(where: { $0.contains("libopus.so") }),
              let arrow = line.range(of: "=> ") else {
            return .failure(.init("\(ffmpeg) does not dynamically link libopus"))
        }
        let path = String(line[arrow.upperBound...].split(separator: " ").first ?? "")
        guard let libopus = libopusVersionString(path) else {
            return .failure(.init("cannot read opus_get_version_string from \(path)"))
        }
        return .success(EncoderEnvironment(ffmpegPath: ffmpeg, ffmpegVersion: version, opusEncoders: encoders,
                                           libopusVersion: libopus, libopusLibrary: path, host: osPrettyName()))
    }

    static func libopusVersionString(_ path: String) -> String? {
        guard let handle = dlopen(path, RTLD_NOW) else { return nil }
        defer { dlclose(handle) }
        guard let sym = dlsym(handle, "opus_get_version_string") else { return nil }
        typealias VersionFn = @convention(c) () -> UnsafePointer<CChar>?
        guard let cstr = unsafeBitCast(sym, to: VersionFn.self)() else { return nil }
        return String(cString: cstr)
    }

    static func osPrettyName() -> String {
        let text = (try? String(contentsOfFile: "/etc/os-release", encoding: .utf8)) ?? ""
        for line in text.split(separator: "\n") where line.hasPrefix("PRETTY_NAME=") {
            return String(line.dropFirst("PRETTY_NAME=".count)).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        }
        return "unknown"
    }
}

public struct EncoderDetectionError: Error, CustomStringConvertible {
    public let description: String
    init(_ d: String) { description = d }
}
