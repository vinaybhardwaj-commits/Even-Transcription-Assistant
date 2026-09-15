import Foundation

/// Launch a helper without `Foundation.Pipe`.
///
/// Home Office 15 Sep 2026: `Pipe()` on the 1.5 s poll (`pmset` / `launchctl` / `scutil`) and on
/// every ffmpeg piece encode leaked PIPE FDs for the life of `room-recorder`. Kickstart did not
/// change the code; FDs climbed again during a healthy recording (947 → 1101) before any EMFILE.
/// Temp files are REG FDs that we close; they do not accumulate as PIPEs.
enum RoomSubprocess {
  static func run(
    executable: URL,
    arguments: [String],
    timeout: TimeInterval? = nil,
    captureStdout: Bool,
    captureStderr: Bool
  ) -> (status: Int32, stdout: Data, stderr: Data)? {
    let fm = FileManager.default
    func openTemp() -> (URL, FileHandle)? {
      let url = fm.temporaryDirectory.appendingPathComponent("rr-proc-\(UUID().uuidString)")
      guard fm.createFile(
        atPath: url.path, contents: nil,
        attributes: [.posixPermissions: NSNumber(value: 0o600)]),
        let handle = try? FileHandle(forUpdating: url)
      else { return nil }
      return (url, handle)
    }

    var stdoutURL: URL?
    var stderrURL: URL?
    var stdoutHandle: FileHandle?
    var stderrHandle: FileHandle?
    defer {
      try? stdoutHandle?.close()
      try? stderrHandle?.close()
      if let stdoutURL { try? fm.removeItem(at: stdoutURL) }
      if let stderrURL { try? fm.removeItem(at: stderrURL) }
    }

    let process = Process()
    process.executableURL = executable
    process.arguments = arguments
    process.standardInput = FileHandle.nullDevice
    if captureStdout, let captured = openTemp() {
      stdoutURL = captured.0
      stdoutHandle = captured.1
      process.standardOutput = captured.1
    } else {
      process.standardOutput = FileHandle.nullDevice
    }
    if captureStderr, let captured = openTemp() {
      stderrURL = captured.0
      stderrHandle = captured.1
      process.standardError = captured.1
    } else {
      process.standardError = FileHandle.nullDevice
    }

    do { try process.run() } catch { return nil }
    if let timeout {
      let deadline = Date().addingTimeInterval(timeout)
      while process.isRunning && Date() < deadline {
        Thread.sleep(forTimeInterval: 0.02)
      }
      if process.isRunning {
        process.terminate()
        return nil
      }
    } else {
      process.waitUntilExit()
    }

    try? stdoutHandle?.synchronize()
    try? stderrHandle?.synchronize()
    try? stdoutHandle?.close()
    try? stderrHandle?.close()
    stdoutHandle = nil
    stderrHandle = nil
    process.standardOutput = nil
    process.standardError = nil
    process.standardInput = nil

    let stdout = stdoutURL.flatMap { try? Data(contentsOf: $0) } ?? Data()
    let stderr = stderrURL.flatMap { try? Data(contentsOf: $0) } ?? Data()
    return (process.terminationStatus, stdout, stderr)
  }
}
