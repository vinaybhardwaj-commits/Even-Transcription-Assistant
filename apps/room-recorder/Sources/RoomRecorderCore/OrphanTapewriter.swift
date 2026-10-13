import Darwin
import Foundation

/// A tapewriter left running by an app instance that is gone (0.1.29).
///
/// On 9 Oct 2026 an app exited and its tapewriter kept recording with nobody to read the tape. A
/// new app instance must not start a second capture next to it. This finds such a process and asks
/// it to stop. It reads ids out of the command line for the log and TOUCHES NO FILE: the audio
/// the orphan wrote stays exactly where it is for the recovery path to find.
public struct OrphanTapewriter: Equatable, Sendable {
  public var pid: Int32
  public var sessionID: String
  public var segmentID: String
}

public struct ProcessLine: Equatable, Sendable {
  public var pid: Int32
  public var ppid: Int32
  public var command: String
  public init(pid: Int32, ppid: Int32, command: String) {
    self.pid = pid
    self.ppid = ppid
    self.command = command
  }
}

public enum OrphanTapewriterReaper {
  /// `ps -axww -o pid=,ppid=,command=`, one process per line.
  public static func parse(psOutput: String) -> [ProcessLine] {
    psOutput.split(separator: "\n").compactMap { raw in
      let parts = raw.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
      guard parts.count == 3, let pid = Int32(parts[0]), let ppid = Int32(parts[1]) else { return nil }
      return ProcessLine(pid: pid, ppid: ppid, command: String(parts[2]))
    }
  }

  /// Strict on purpose. An orphan is a process that (1) was re-parented to launchd (ppid 1), (2) is a
  /// `tapewriter record --out <dir> --device <uid>` and (3) writes into `.../captures/<session>/seg_*`.
  /// Anything that misses one of the three is somebody else's process and is left alone. A
  /// tapewriter that still has a live app parent has ppid != 1 and never matches.
  public static func find(in lines: [ProcessLine], ownPID: Int32) -> [OrphanTapewriter] {
    lines.compactMap { line in
      guard line.ppid == 1, line.pid != ownPID,
        let record = line.command.range(of: "/tapewriter record --out "),
        let device = line.command.range(of: " --device ", range: record.upperBound..<line.command.endIndex)
      else { return nil }
      let dir = String(line.command[record.upperBound..<device.lowerBound])
      let parts = dir.split(separator: "/", omittingEmptySubsequences: true)
      guard parts.count >= 3, parts[parts.count - 3] == "captures", parts[parts.count - 1].hasPrefix("seg_")
      else { return nil }
      return OrphanTapewriter(
        pid: line.pid, sessionID: String(parts[parts.count - 2]), segmentID: String(parts[parts.count - 1]))
    }
  }

  public static func liveSnapshot() -> [ProcessLine] {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/ps")
    process.arguments = ["-axww", "-o", "pid=,ppid=,command="]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return [] }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return parse(psOutput: String(decoding: data, as: UTF8.self))
  }

  public static func isAlive(_ pid: Int32) -> Bool {
    kill(pid, 0) == 0 || errno == EPERM
  }

  /// SIGTERM each orphan and wait for it to go. SIGTERM only: no SIGKILL, because a tapewriter that
  /// is flushing its tape must be allowed to finish; one that ignores SIGTERM is logged and left.
  @discardableResult
  public static func reap(
    snapshot: () -> [ProcessLine] = liveSnapshot,
    terminate: (Int32) -> Void = { _ = kill($0, SIGTERM) },
    alive: (Int32) -> Bool = isAlive,
    graceSeconds: TimeInterval = 10,
    pollInterval: TimeInterval = 0.2,
    ownPID: Int32 = getpid(),
    log: (String) -> Void
  ) -> [OrphanTapewriter] {
    let orphans = find(in: snapshot(), ownPID: ownPID)
    for orphan in orphans {
      log(
        "orphan tapewriter pid=\(orphan.pid) session=\(orphan.sessionID) segment=\(orphan.segmentID); sending SIGTERM")
      terminate(orphan.pid)
      let deadline = Date().addingTimeInterval(graceSeconds)
      while alive(orphan.pid), Date() < deadline { Thread.sleep(forTimeInterval: pollInterval) }
      log(
        alive(orphan.pid)
          ? "orphan tapewriter pid=\(orphan.pid) still running after \(Int(graceSeconds)) s; left alone"
          : "orphan tapewriter pid=\(orphan.pid) exited")
    }
    return orphans
  }
}
