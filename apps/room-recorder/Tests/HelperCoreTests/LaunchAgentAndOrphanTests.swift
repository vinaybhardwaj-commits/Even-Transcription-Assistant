import Foundation
import Testing

@testable import RoomRecorderCore

@Suite struct RoomLaunchAgentPlistTests {
  private let plist = RoomLaunchAgent.plist(
    executablePath: "/Applications/EvenScribe Room Recorder.app/Contents/MacOS/room-recorder",
    rootPath: "/root", logPath: "/root/launchd.log")

  @Test func keepAliveIsTheBooleanTrueNotASuccessfulExitDictionary() throws {
    // Read back from the serialised XML, because that is what launchd reads.
    let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    let xml = String(decoding: data, as: UTF8.self)
    #expect(xml.contains("<key>KeepAlive</key>\n\t<true/>"))
    #expect(!xml.contains("SuccessfulExit"))
    let back = try #require(
      try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    #expect(back["KeepAlive"] as? Bool == true)
  }

  @Test func throttleRunAtLoadAndArgumentsArePinned() {
    #expect(plist["ThrottleInterval"] as? Int == 30)
    #expect(plist["RunAtLoad"] as? Bool == true)
    #expect(plist["Label"] as? String == "com.evenscribe.room-recorder")
    #expect(
      plist["ProgramArguments"] as? [String] == [
        "/Applications/EvenScribe Room Recorder.app/Contents/MacOS/room-recorder", "run", "--root", "/root",
      ])
  }
}

@Suite struct OrphanTapewriterTests {
  private let dir = "/Users/x/Library/Application Support/RoomRecorder/captures/sess_1/seg_abc"
  private func line(_ pid: Int32, _ ppid: Int32, _ command: String) -> ProcessLine {
    ProcessLine(pid: pid, ppid: ppid, command: command)
  }
  private var tapewriterCommand: String {
    "/Applications/EvenScribe Room Recorder.app/Contents/Helpers/tapewriter record --out \(dir) --device BuiltInMic"
  }

  @Test func parsesPsOutput() {
    let parsed = OrphanTapewriterReaper.parse(
      psOutput: "  101     1 /sbin/launchd\n 202   101 /bin/sh -c x y\nnot a line\n")
    #expect(parsed == [
      ProcessLine(pid: 101, ppid: 1, command: "/sbin/launchd"),
      ProcessLine(pid: 202, ppid: 101, command: "/bin/sh -c x y"),
    ])
  }

  @Test func anOrphanIsFoundWithItsSessionAndSegmentIds() {
    let found = OrphanTapewriterReaper.find(in: [line(500, 1, tapewriterCommand)], ownPID: 9)
    #expect(found == [OrphanTapewriter(pid: 500, sessionID: "sess_1", segmentID: "seg_abc")])
  }

  @Test func aTapewriterWithALiveAppParentIsNotAnOrphan() {
    #expect(OrphanTapewriterReaper.find(in: [line(500, 321, tapewriterCommand)], ownPID: 9).isEmpty)
  }

  @Test func otherProcessesAreLeftAlone() {
    let others = [
      line(1, 1, "/sbin/launchd"),
      line(2, 1, "/usr/bin/tapewriter-other record --out \(dir) --device x"),
      line(3, 1, "/x/tapewriter record --out /tmp/not-captures/sess/seg_a --device x"),
      line(4, 1, "/x/tapewriter record --out /tmp/captures/sess/notaseg --device x"),
      line(5, 1, "/x/tapewriter --version"),
      line(9, 1, tapewriterCommand),  // this process itself, never its own target
    ]
    #expect(OrphanTapewriterReaper.find(in: others, ownPID: 9).isEmpty)
  }

  @Test func reapSignalsTheOrphanLogsIdsAndNeverTheAudioPath() {
    final class State: @unchecked Sendable { var signalled: [Int32] = []; var logs: [String] = []; var alive = true }
    let state = State()
    let reaped = OrphanTapewriterReaper.reap(
      snapshot: { [self.line(500, 1, self.tapewriterCommand)] },
      terminate: { state.signalled.append($0); state.alive = false },
      alive: { _ in state.alive },
      graceSeconds: 1, pollInterval: 0.01, ownPID: 9,
      log: { state.logs.append($0) })
    #expect(reaped.count == 1)
    #expect(state.signalled == [500])
    #expect(state.logs.contains { $0.contains("session=sess_1") && $0.contains("segment=seg_abc") })
    #expect(state.logs.last?.hasSuffix("exited") == true)
    #expect(!state.logs.contains { $0.contains("captures") }, "the log names ids, not audio paths")
  }

  @Test func anOrphanThatIgnoresSigtermIsLoggedAndLeftAlone() {
    final class State: @unchecked Sendable { var logs: [String] = [] }
    let state = State()
    OrphanTapewriterReaper.reap(
      snapshot: { [self.line(500, 1, self.tapewriterCommand)] },
      terminate: { _ in }, alive: { _ in true },
      graceSeconds: 0.1, pollInterval: 0.02, ownPID: 9,
      log: { state.logs.append($0) })
    #expect(state.logs.last?.contains("left alone") == true)
  }

  /// A real process, really re-parented to launchd, really signalled. The snapshot is filtered to
  /// this test's unique token so no real tapewriter on the machine can be touched.
  @Test func aRealOrphanIsTerminatedAndALiveChildOfTheAppIsNot() throws {
    let token = UUID().uuidString.lowercased()
    let base = FileManager.default.temporaryDirectory.appendingPathComponent("orphan-\(token)")
    defer { try? FileManager.default.removeItem(at: base) }
    let orphanDir = base.appendingPathComponent("captures/sess_\(token)/seg_orphan")
    let childDir = base.appendingPathComponent("captures/sess_\(token)/seg_child")
    try FileManager.default.createDirectory(at: orphanDir, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: childDir, withIntermediateDirectories: true)
    let script = base.appendingPathComponent("tapewriter")
    try "#!/bin/bash\nwhile true; do sleep 1; done\n".write(to: script, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)

    // Orphan: backgrounded by a shell that exits at once, so launchd adopts it.
    let launcher = Process()
    launcher.executableURL = URL(fileURLWithPath: "/bin/sh")
    launcher.arguments = [
      "-c", "'\(script.path)' record --out '\(orphanDir.path)' --device d >/dev/null 2>&1 &",
    ]
    try launcher.run()
    launcher.waitUntilExit()
    // Control: same command line, still a child of this test process.
    let child = Process()
    child.executableURL = script
    child.arguments = ["record", "--out", childDir.path, "--device", "d"]
    try child.run()
    defer { if child.isRunning { child.terminate() } }

    let mine: () -> [ProcessLine] = {
      OrphanTapewriterReaper.liveSnapshot().filter { $0.command.contains(token) }
    }
    var orphanPID: Int32?
    for _ in 0..<50 {
      orphanPID = mine().first { $0.command.contains("seg_orphan") && $0.ppid == 1 }?.pid
      if orphanPID != nil { break }
      Thread.sleep(forTimeInterval: 0.1)
    }
    let pid = try #require(orphanPID, "the backgrounded process was not re-parented to launchd")

    let reaped = OrphanTapewriterReaper.reap(snapshot: mine, graceSeconds: 5, log: { _ in })
    #expect(reaped.map(\.pid) == [pid])
    #expect(!OrphanTapewriterReaper.isAlive(pid))
    #expect(child.isRunning, "a tapewriter whose app is alive must never be signalled")
  }
}
