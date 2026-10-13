import Foundation
import MachO

/// Which build is running, as telemetry can verify it: {git_sha, lc_uuid, pkg_version}.
/// git_sha and pkg_version are stamped by the Makefile (build/BuildInfo.swift). lc_uuid is the Mach-O LC_UUID (load command 0x1b)
/// of the running executable, read from its own image header: the linker derives it from the final bytes, so it cannot be
/// stamped before linking. install.sh re-signs the binary, which changes its sha256 but not this UUID, so the same value is what
/// kh-rollout.sh compares after an install. No file is read and no tool is run.
enum BuildIdentity {
    /// 32 lowercase hex digits, or "unknown" if the image has no LC_UUID.
    static let lcUUID: String = {
        guard let raw = _dyld_get_image_header(0) else { return "unknown" }
        let header = UnsafeRawPointer(raw)
        var cmd = header + MemoryLayout<mach_header_64>.size
        let count = header.load(fromByteOffset: 16, as: UInt32.self)   // mach_header_64.ncmds
        for _ in 0..<count {
            let lc = cmd.load(as: load_command.self)
            if lc.cmd == UInt32(LC_UUID) {
                let u = cmd.load(as: uuid_command.self).uuid
                return [u.0, u.1, u.2, u.3, u.4, u.5, u.6, u.7, u.8, u.9, u.10, u.11, u.12, u.13, u.14, u.15]
                    .map { String(format: "%02x", $0) }.joined()
            }
            cmd += Int(lc.cmdsize)
        }
        return "unknown"
    }()

    static func payload() -> Payload {
        ["git_sha": BuildInfo.gitSHA, "lc_uuid": lcUUID, "pkg_version": BuildInfo.pkgVersion]
    }
}
