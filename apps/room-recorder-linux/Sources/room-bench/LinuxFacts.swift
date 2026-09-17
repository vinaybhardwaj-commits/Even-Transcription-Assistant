import BenchCore
import Foundation
#if canImport(Glibc)
import Glibc
#endif

/// The machine facts the poll carries, each READ now or not sent (§5.5). Not sent at all from Linux, because nothing
/// here measures them: `mic_state` (a CoreAudio authorisation concept), `launched_by` (the Mac's values are launchd's),
/// `build_sha` (not stamped into this build), `clip_count` and `silence_ms` (the Mac reads them from the PCM; this
/// process reads PCM only through the piece pipeline).
enum LinuxFacts {
    static func read() -> MachineFacts {
        MachineFacts(hostname: hostname(), hardwareModel: hardwareModel(), osVersion: osVersion(), neverSleep: neverSleep())
    }

    static func hostname() -> String? {
        var buffer = [CChar](repeating: 0, count: 256)
        guard gethostname(&buffer, buffer.count) == 0 else { return nil }
        let name = String(cString: buffer)
        return name.isEmpty ? nil : name
    }

    static func file(_ path: String) -> String? {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// DMI vendor, version and product, e.g. "LENOVO Yoga 7 14ITL5 82BH".
    static func hardwareModel() -> String? {
        let parts = ["sys_vendor", "product_version", "product_name"].compactMap { file("/sys/devices/virtual/dmi/id/\($0)") }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    static func osVersion() -> String? {
        guard let text = file("/etc/os-release") else { return nil }
        for line in text.split(separator: "\n") where line.hasPrefix("PRETTY_NAME=") {
            return String(line.dropFirst("PRETTY_NAME=".count)).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        }
        return nil
    }

    /// U2 S5 made true of the machine by masking the four sleep targets. True only when all four are masked (a symlink
    /// to /dev/null in /etc/systemd/system), false when any is not, nil when that cannot be read.
    static func neverSleep() -> Bool? {
        var masked = 0
        for target in ["sleep.target", "suspend.target", "hibernate.target", "hybrid-sleep.target"] {
            let path = "/etc/systemd/system/\(target)"
            var info = stat()
            if lstat(path, &info) != 0 {
                guard errno == ENOENT else { return nil }
                continue
            }
            if (info.st_mode & S_IFMT) == S_IFLNK,
               let destination = try? FileManager.default.destinationOfSymbolicLink(atPath: path), destination == "/dev/null" {
                masked += 1
            }
        }
        return masked == 4
    }

    /// First line of `<pinned ffmpeg> -version` and its exit status, at most 5 s.
    static func ffmpegVersion(path: String) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = ["-version"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(5)
        while process.isRunning && Date() < deadline { usleep(20_000) }
        if process.isRunning {
            process.terminate()
            return "no answer within 5 s"
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let first = String(decoding: data, as: UTF8.self).split(separator: "\n").first.map(String.init) ?? ""
        return "\(first.prefix(200)) (exit \(process.terminationStatus))"
    }
}
