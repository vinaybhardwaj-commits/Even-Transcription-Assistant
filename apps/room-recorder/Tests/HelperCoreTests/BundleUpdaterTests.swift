import CryptoKit
import Foundation
import Testing

@testable import FleetCore
@testable import HelperCore
@testable import KioskHealthCore

// MARK: - 0.1.37 (#45): whole-bundle update from the root helper

/// A Mac on disk: an installed app, a support directory, and fakes for exactly the four things a test cannot do for real
/// (download, pkgutil, codesign, launchctl). Everything else, the state file, the snapshot copy, the restore and the
/// renames, runs on real temp directories.
final class UpdateRig: @unchecked Sendable {
  let base = FileManager.default.temporaryDirectory.appendingPathComponent("update-\(UUID().uuidString)")
  var apps: String { base.path + "/Applications" }
  var app: String { apps + "/EvenScribe Room Recorder.app" }
  var support: String { base.path + "/support" }
  var rollback: String { support + "/rollback" }
  var statePath: String { support + "/helper-update.json" }
  var pinPath: String { support + "/update-pin" }
  var marker: String { support + "/install-in-progress" }
  let server = TestServer()
  let env = FakeEnv()
  let tools = FakeTools()
  let lock = NSLock()
  var clockDate = TestServer.night
  var pkgBytes = Data((0..<4096).map { UInt8($0 % 251) })
  var downloadOK = true
  var downloaded: [URL] = []
  var codesignFailsFor: [String] = []  // substrings of the path
  var expandOK = true
  var payloadVersion = "0.1.37"
  var installerLoaded = false
  var installerRunning = false
  var installerExit = 0
  var installedAfterInstall: String?  // what Info.plist says once the installer "finished"
  var helperVersion = "0.2.2-h4"
  var markerSeenDuring: [String: Bool] = [:]
  var onSnapshot: (() -> Void)?
  var onRestore: (() -> Void)?
  var failRenames = false

  init() throws {
    try FileManager.default.createDirectory(atPath: support, withIntermediateDirectories: true)
    try makeApp(at: app, version: "0.1.36", body: "old")
    env.clock = TestServer.night
    tools.responder = { [unowned self] exe, args in handle(exe, args) }
  }
  func tearDown() { try? FileManager.default.removeItem(at: base) }

  func makeApp(at path: String, version: String, body: String) throws {
    try? FileManager.default.removeItem(atPath: path)
    try FileManager.default.createDirectory(atPath: path + "/Contents/MacOS", withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: path + "/Contents/Frameworks", withIntermediateDirectories: true)
    try PropertyListSerialization.data(fromPropertyList: ["CFBundleShortVersionString": version], format: .xml, options: 0)
      .write(to: URL(fileURLWithPath: path + "/Contents/Info.plist"))
    try Data(body.utf8).write(to: URL(fileURLWithPath: path + "/Contents/MacOS/room-recorder"))
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path + "/Contents/MacOS/room-recorder")
    try Data(body.utf8).write(to: URL(fileURLWithPath: path + "/Contents/MacOS/room-recorder-helper"))
    try FileManager.default.createSymbolicLink(atPath: path + "/Contents/Frameworks/Current", withDestinationPath: "../MacOS")
  }

  /// A fingerprint of a tree: relative path, kind, mode, content.
  func fingerprint(_ path: String) -> [String] {
    var out: [String] = []
    guard let walker = FileManager.default.enumerator(atPath: path) else { return out }
    for case let rel as String in walker {
      let full = path + "/" + rel
      var s = stat()
      lstat(full, &s)
      let kind = (s.st_mode & S_IFMT) == S_IFLNK ? "l:" + ((try? FileManager.default.destinationOfSymbolicLink(atPath: full)) ?? "?")
        : (s.st_mode & S_IFMT) == S_IFDIR ? "d" : "f:" + String(decoding: (try? Data(contentsOf: URL(fileURLWithPath: full))) ?? Data(), as: UTF8.self)
      out.append("\(rel) \(kind) \(String(s.st_mode & 0o777, radix: 8))")
    }
    return out.sorted()
  }

  // The four fakes ------------------------------------------------------------------------------

  func handle(_ exe: String, _ args: [String]) -> ToolResult {
    lock.lock(); defer { lock.unlock() }
    if FileManager.default.fileExists(atPath: marker) { markerSeenDuring[exe + " " + args.joined(separator: " ")] = true }
    switch exe {
    case "/usr/sbin/pkgutil":
      guard expandOK, args.first == "--expand-full", args.count == 3 else { return ToolResult(status: 1) }
      let dest = args[2] + "/Payload/EvenScribe Room Recorder.app"
      try? makeApp(at: dest, version: payloadVersion, body: "new")
      return ToolResult(status: 0)
    case "/usr/bin/codesign":
      let path = args.last ?? ""
      return codesignFailsFor.contains { path.contains($0) } ? ToolResult(status: 3) : ToolResult(status: 0)
    case "/bin/launchctl":
      let verb = args.first ?? ""
      let target = args.dropFirst().first ?? ""
      if target.contains(BundleUpdater.installerLabel) || (verb == "bootstrap" && (args.last ?? "").hasSuffix("installer.plist")) {
        switch verb {
        case "bootstrap": installerLoaded = true; installerRunning = true; return ToolResult(status: 0)
        case "bootout": installerLoaded = false; return ToolResult(status: 0)
        case "print":
          guard installerLoaded else { return ToolResult(status: 113) }
          return ToolResult(status: 0, output: installerRunning ? "state = running\n" : "state = not running\nlast exit code = \(installerExit)\n")
        default: return ToolResult(status: 0)
        }
      }
      return ToolResult(status: 0)
    default:
      return ToolResult(status: 0)
    }
  }

  struct Downloader: UpdateDownloading {
    let rig: UpdateRig
    func download(_ url: URL, to path: String, maxBytes: Int64) -> Bool {
      rig.downloaded.append(url)
      guard rig.downloadOK else { return false }
      return (try? rig.pkgBytes.write(to: URL(fileURLWithPath: path))) != nil
    }
  }

  /// The real disk, except that it tells the rig when the snapshot starts (so a test can open a session mid-copy).
  struct Disk: UpdateDisk {
    let inner: SystemUpdateDisk
    let rig: UpdateRig
    func ensureDirectory(_ p: String) -> Bool { inner.ensureDirectory(p) }
    func exists(_ p: String) -> Bool { inner.exists(p) }
    func write(_ d: Data, to p: String, mode: UInt16) -> Bool { inner.write(d, to: p, mode: mode) }
    func read(_ p: String, maxBytes: Int) -> Data? { inner.read(p, maxBytes: maxBytes) }
    func remove(_ p: String) { inner.remove(p) }
    func rename(_ a: String, to b: String) -> Bool { rig.failRenames ? false : inner.rename(a, to: b) }
    func sha256(ofFileAt p: String) -> String? { inner.sha256(ofFileAt: p) }
    func size(ofFileAt p: String) -> Int64? { inner.size(ofFileAt: p) }
    func snapshotBundle(_ a: String, user: String, to d: String) -> Bool {
      let ok = inner.snapshotBundle(a, user: user, to: d)
      rig.onSnapshot?()
      return ok
    }
    func restoreTree(from s: String, to d: String, uid: UInt32, gid: UInt32) -> Bool {
      let ok = inner.restoreTree(from: s, to: d, uid: uid, gid: gid)
      rig.onRestore?()
      return ok
    }
    func download(_ u: URL, to p: String, maxBytes: Int64) -> Bool { inner.download(u, to: p, maxBytes: maxBytes) }
    func touchInstallMarker() { inner.touchInstallMarker() }
    func clearInstallMarker() { inner.clearInstallMarker() }
  }

  func updater(helperVersion: String? = nil) -> BundleUpdater {
    let inner = SystemUpdateDisk(reader: UnprivilegedUserFiles(), supportDirectory: support, setOwner: false, downloader: Downloader(rig: self))
    return BundleUpdater(
      env: env, tools: tools, disk: Disk(inner: inner, rig: self), reader: UnprivilegedUserFiles(), serverKeys: ["fk1": server.publicKey],
      directory: support + "/update", rollbackDirectory: rollback, statePath: statePath, appPath: app, pinPath: pinPath,
      helperVersion: helperVersion ?? self.helperVersion, now: { [unowned self] in env.clock }, log: { _ in })
  }

  // Records ---------------------------------------------------------------------------------------

  func record(
    version: String = "0.1.37", cohort: String = "all", pct: Int = 100, deviceCohorts: [String] = [], minHelper: String = "0.2.0",
    device: String = TestServer.deviceID, machine: String = TestServer.machine, url: String = "https://www.evenscribe.app/dl/room-recorder-0.1.37.pkg",
    sha: String? = nil, size: Int? = nil, issued: Date? = nil, expires: Date? = nil, key: String = "fk1", extra: [String: FleetJSON] = [:],
    signWith other: Curve25519.Signing.PrivateKey? = nil, nonce: String = "nonce-\(UUID().uuidString.prefix(12))"
  ) -> (json: String, signature: String) {
    let issuedAt = issued ?? env.clock.addingTimeInterval(-10)
    var o: [String: FleetJSON] = [
      "v": .int(1), "version": .string(version), "channel": .string("stable"), "pkg_url": .string(url),
      "pkg_sha256": .string(sha ?? SHA256.hash(data: pkgBytes).map { String(format: "%02x", $0) }.joined()),
      "pkg_size": .int(Int64(size ?? pkgBytes.count)), "min_helper": .string(minHelper), "cohort": .string(cohort),
      "rollout_pct": .int(Int64(pct)), "device_cohorts": .array(deviceCohorts.map(FleetJSON.string)), "device_id": .string(device),
      "machine": .string(machine), "issued_at": .string(FleetClient.iso(issuedAt)),
      "expires_at": .string(FleetClient.iso(expires ?? issuedAt.addingTimeInterval(3600))), "nonce": .string(nonce), "key_id": .string(key),
    ]
    for (k, v) in extra { o[k] = v }
    let object = FleetJSON.object(o)
    let signature = try! (other ?? server.key).signature(for: object.canonicalData).base64EncodedString()
    return (object.canonical, signature)
  }

  func offer(_ r: (json: String, signature: String), updater u: BundleUpdater) -> BundleUpdater.Offer {
    u.offer(recordJSON: r.json, signature: r.signature, deviceID: TestServer.deviceID, machine: TestServer.machine)
  }

  func advance(_ seconds: TimeInterval) { env.clock = env.clock.addingTimeInterval(seconds) }
  func finishInstall(version: String? = nil, exit: Int = 0) throws {
    installerRunning = false
    installerExit = exit
    if let v = version ?? installedAfterInstall { try makeApp(at: app, version: v, body: "new") }
  }
  var installedVersion: String {
    let data = (try? Data(contentsOf: URL(fileURLWithPath: app + "/Contents/Info.plist"))) ?? Data()
    return ((try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any])?["CFBundleShortVersionString"] as? String ?? "?"
  }
  var markerExists: Bool { FileManager.default.fileExists(atPath: marker) }
  var jobBootstraps: [String] { tools.calls.filter { $0.contains("bootstrap system") } }
}

@Suite(.serialized) struct BundleUpdaterTests {
  // ─── the happy path, every step ─────────────────────────────────────────────────────────────

  @Test func aGoodReleaseGoesThroughEveryStepAndEndsHealthy() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let u = r.updater()
    #expect(r.offer(r.record(), updater: u) == .accepted(step: "offered"))
    u.tick()
    #expect(u.current.phase == "installing" && u.current.step == "installing")
    #expect(r.markerExists, "the watchdog is held from the snapshot on")
    #expect(r.jobBootstraps == ["/bin/launchctl bootstrap system \(r.support)/update/installer.plist"])
    try r.finishInstall(version: "0.1.37")
    u.tick()
    #expect(u.current.phase == "health" && u.current.step == "health_wait")
    #expect(r.tools.calls.contains("/bin/launchctl kickstart -k gui/501/com.evenscribe.room-recorder"))
    r.advance(40)
    u.appBeat(version: "0.1.37")
    u.tick()
    #expect(u.current.phase == "idle" && u.current.result == "ok")
    #expect(!r.markerExists && !FileManager.default.fileExists(atPath: r.support + "/update/staging"))
    #expect(FileManager.default.fileExists(atPath: r.rollback + "/0.1.36.app"), "the snapshot is kept")
    #expect(u.statusDetail()["update_result"] == "ok" && u.statusDetail()["update_version"] == "0.1.37")
  }

  @Test func theStepsAreReportedInOrderOnTheStatus() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    var seen: [String] = []
    let u = r.updater()
    _ = r.offer(r.record(), updater: u); seen.append(u.current.step)
    u.tick(); seen.append(u.current.step)
    try r.finishInstall(version: "0.1.37"); u.tick(); seen.append(u.current.step)
    u.appBeat(version: "0.1.37"); u.tick(); seen.append(u.current.step)
    #expect(seen == ["offered", "installing", "health_wait", "ok"])
  }

  // ─── the signed record ──────────────────────────────────────────────────────────────────────

  @Test func aBadSignatureIsRefusedBeforeAnythingIsDownloaded() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let u = r.updater()
    let stranger = Curve25519.Signing.PrivateKey()
    #expect(r.offer(r.record(signWith: stranger), updater: u) == .refused(.badSignature))
    var tampered = r.record()
    tampered.json = tampered.json.replacingOccurrences(of: "0.1.37", with: "0.1.99")
    #expect(r.offer(tampered, updater: u) == .refused(.badSignature))
    #expect(r.offer(r.record(key: "fk9"), updater: u) == .refused(.badSignature), "an unknown key id")
    #expect(r.downloaded.isEmpty && u.current.phase == "idle" && !r.markerExists)
    #expect(u.statusDetail()["update_step"] == "refused" && u.statusDetail()["update_detail"] == "record_bad_signature")
  }

  @Test func aRecordForAnotherDeviceOrMachineOrOutsideItsWindowOrMalformedIsRefused() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let u = r.updater()
    #expect(r.offer(r.record(device: "dev_00000000000000000000000b"), updater: u) == .refused(.wrongDevice))
    #expect(r.offer(r.record(machine: "another-mac"), updater: u) == .refused(.wrongDevice))
    #expect(r.offer(r.record(issued: r.env.clock.addingTimeInterval(-7200), expires: r.env.clock.addingTimeInterval(-3600)), updater: u) == .refused(.expired))
    #expect(r.offer(r.record(issued: r.env.clock.addingTimeInterval(-10), expires: r.env.clock.addingTimeInterval(3 * 86_400)), updater: u) == .refused(.expired), "a window over a day")
    #expect(r.offer(r.record(extra: ["extra": .int(1)]), updater: u) == .refused(.malformed))
    #expect(r.offer(r.record(url: "http://www.evenscribe.app/x.pkg"), updater: u) == .refused(.malformed), "not https")
    #expect(r.offer(r.record(url: "https://evil.example/x.pkg"), updater: u) == .refused(.malformed), "not our host")
    #expect(r.offer(r.record(url: "https://user:pw@www.evenscribe.app/x.pkg"), updater: u) == .refused(.malformed))
    #expect(r.offer(r.record(sha: String(repeating: "g", count: 64)), updater: u) == .refused(.malformed))
    #expect(r.offer(("not json", "AAAA"), updater: u) == .refused(.malformed))
    #expect(r.downloaded.isEmpty)
  }

  @Test func theBlobHostIsAllowedAndSubdomainTricksAreNot() {
    #expect(ReleaseRecord.validatedURL("https://abc123.public.blob.vercel-storage.com/room-recorder.pkg") != nil)
    #expect(ReleaseRecord.validatedURL("https://abc.public.blob.vercel-storage.com.evil.example/x.pkg") == nil)
    #expect(ReleaseRecord.validatedURL("https://notevenscribe.app/x.pkg") == nil)
    #expect(ReleaseRecord.validatedURL("https://www.evenscribe.app:8443/x.pkg") == nil)
  }

  // ─── the package ────────────────────────────────────────────────────────────────────────────

  @Test func aShaMismatchStopsBeforeThePackageIsOpened() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let u = r.updater()
    let before = r.fingerprint(r.app)
    _ = r.offer(r.record(sha: String(repeating: "a", count: 64)), updater: u)
    u.tick()
    #expect(u.current.phase == "idle" && u.current.result == "failed" && u.current.detail == "sha_mismatch")
    #expect(!r.tools.calls.contains { $0.contains("pkgutil") }, "an unverified package is never expanded")
    #expect(!r.markerExists && r.fingerprint(r.app) == before && r.jobBootstraps.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: r.support + "/update/staging"), "and it is deleted")
  }

  @Test func aWrongSizeAndADownloadThatFailsAreStopped() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let u = r.updater()
    _ = r.offer(r.record(size: 9_999), updater: u); u.tick()
    #expect(u.current.detail == "size_mismatch")
    r.downloadOK = false
    let u2 = r.updater()
    _ = r.offer(r.record(nonce: "other-nonce-1"), updater: u2); u2.tick()
    #expect(u2.current.detail == "download_failed")
  }

  @Test func aBundleInsideThePackageThatFailsThePinnedSignatureIsRefused() throws {
    for failing in ["Payload/EvenScribe Room Recorder.app", "room-recorder-helper"] {
      let r = try UpdateRig(); defer { r.tearDown() }
      r.codesignFailsFor = [failing]
      let u = r.updater()
      _ = r.offer(r.record(), updater: u); u.tick()
      #expect(u.current.result == "failed" && (u.current.detail ?? "").hasSuffix("_signature_invalid"), "\(failing)")
      #expect(r.jobBootstraps.isEmpty && r.installedVersion == "0.1.36")
    }
  }

  @Test func theCodesignChecksUseThePinnedLeafAndIdentifier() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let u = r.updater()
    _ = r.offer(r.record(), updater: u); u.tick()
    let checks = r.tools.calls.filter { $0.hasPrefix("/usr/bin/codesign") }
    #expect(checks.contains { $0.contains("-R =identifier \"com.evenscribe.room-recorder\" and certificate leaf = H\"187dd424fb866204111113d60c6f88a21d098edb\"") })
    #expect(checks.contains { $0.contains("-R =identifier \"com.evenscribe.room-recorder.helper\" and certificate leaf = H\"187dd424fb866204111113d60c6f88a21d098edb\"") })
    #expect(checks.allSatisfy { $0.contains("--verify") && $0.contains("--strict") })
  }

  @Test func aPackageWhoseBundleSaysAnotherVersionIsRefused() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    r.payloadVersion = "0.1.50"
    let u = r.updater()
    _ = r.offer(r.record(), updater: u); u.tick()
    #expect(u.current.detail == "version_mismatch" && r.jobBootstraps.isEmpty)
  }

  @Test func anUnreadablePackageIsRefused() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    r.expandOK = false
    let u = r.updater()
    _ = r.offer(r.record(), updater: u); u.tick()
    #expect(u.current.detail == "pkg_unreadable")
  }

  // ─── no session is ever interrupted ─────────────────────────────────────────────────────────

  @Test func anOpenSessionDefersEverythingUntilItEnds() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    r.env.setStatus("recording")
    let u = r.updater()
    let before = r.fingerprint(r.app)
    let copies = Counter()
    r.onSnapshot = { _ = copies.next() }
    _ = r.offer(r.record(), updater: u)
    for _ in 0..<6 { u.tick(); r.advance(30) }
    #expect(copies.next() == 1, "the bundle is not even READ while a consultation is on: no snapshot was started")
    #expect(u.current.phase == "staged" && u.current.step == "deferred_session_open")
    #expect(r.jobBootstraps.isEmpty && !r.markerExists && !FileManager.default.fileExists(atPath: r.rollback + "/0.1.36.app"))
    #expect(r.fingerprint(r.app) == before, "the installed app was not touched")
    #expect(!r.tools.calls.contains { $0.contains("kickstart") || $0.contains("bootout gui") })
    r.env.setStatus("ready")
    u.tick()
    #expect(u.current.phase == "installing", "it goes as soon as the room is quiet")
  }

  @Test func pausedAndUnreadableStatusCountAsASession() throws {
    for status in ["paused", "garbage"] {
      let r = try UpdateRig(); defer { r.tearDown() }
      if status == "garbage" { r.env.files[FakeEnv.root + "/status.json"] = Data("not json".utf8) } else { r.env.setStatus(status) }
      let u = r.updater()
      _ = r.offer(r.record(), updater: u); u.tick()
      #expect(u.current.step == "deferred_session_open" && r.jobBootstraps.isEmpty, "\(status)")
    }
  }

  @Test func aSessionThatOpensWhileTheSnapshotIsBeingTakenStopsTheInstall() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    r.onSnapshot = { r.env.setStatus("recording") }
    let u = r.updater()
    let before = r.fingerprint(r.app)
    _ = r.offer(r.record(), updater: u); u.tick()
    #expect(u.current.phase == "staged" && u.current.step == "deferred_session_open")
    #expect(r.jobBootstraps.isEmpty && !r.markerExists && r.fingerprint(r.app) == before)
  }

  @Test func theRestartWaitsForTheSessionToEndToo() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let u = r.updater()
    _ = r.offer(r.record(), updater: u); u.tick()
    try r.finishInstall(version: "0.1.37")
    r.env.setStatus("recording")  // a session opened after the files went in
    u.tick()
    #expect(u.current.phase == "restarting" && u.current.step == "deferred_restart_session_open")
    #expect(!r.tools.calls.contains { $0.contains("kickstart") }, "the running app is not restarted under a session")
    r.env.setStatus("ready")
    u.tick()
    #expect(u.current.phase == "health")
  }

  @Test func noConsoleUserMeansWaitNotInstall() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    r.env.console = nil
    let u = r.updater()
    _ = r.offer(r.record(), updater: u)
    #expect(u.current.phase == "idle" || u.current.step == "refused", "the installed version cannot even be read with nobody logged in")
  }

  // ─── health check and rollback ──────────────────────────────────────────────────────────────

  @Test func noBeatInFiveMinutesRestoresTheSnapshotAndTheRoomKeepsRecordingOnTheOldVersion() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let u = r.updater()
    let original = r.fingerprint(r.app)
    _ = r.offer(r.record(), updater: u); u.tick()
    try r.finishInstall(version: "0.1.37"); u.tick()
    #expect(r.installedVersion == "0.1.37" && u.current.phase == "health")
    r.advance(299); u.tick()
    #expect(u.current.phase == "health", "five minutes are five minutes")
    r.advance(2); u.tick()
    #expect(u.current.phase == "rollback_health" && u.current.step == "restored")
    #expect(r.fingerprint(r.app) == original, "the bundle is byte for byte what it was, executable bits and links included")
    #expect(r.installedVersion == "0.1.36")
    #expect(FileManager.default.fileExists(atPath: r.rollback + "/failed-0.1.37.app"), "the failed bundle is kept aside")
    #expect(r.tools.calls.contains("/bin/launchctl bootout gui/501/com.evenscribe.room-recorder"))
    #expect(r.tools.calls.contains { $0.hasPrefix("/bin/launchctl bootstrap gui/501") })
    r.advance(20); u.appBeat(version: "0.1.36"); u.tick()
    #expect(u.current.phase == "idle" && u.current.result == "rolled_back")
    #expect(!r.markerExists)
    #expect(u.current.failures["0.1.37"]?.count == 1)
  }

  @Test func aBeatFromTheOldVersionDoesNotCountAsHealthyForTheNewOne() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let u = r.updater()
    _ = r.offer(r.record(), updater: u); u.tick()
    try r.finishInstall(version: "0.1.37"); u.tick()
    r.advance(10); u.appBeat(version: "0.1.36"); u.tick()
    #expect(u.current.phase == "health")
    r.advance(400); u.tick()
    #expect(u.current.step == "restored")
  }

  @Test func aBeatFromBeforeTheRestartDoesNotCount() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let u = r.updater()
    _ = r.offer(r.record(), updater: u); u.tick()
    u.appBeat(version: "0.1.37")  // stale: before the restart
    r.advance(5)
    try r.finishInstall(version: "0.1.37"); u.tick()
    #expect(u.current.phase == "health", "an old beat is not a new proof")
  }

  @Test func theRollbackWaitsOutASessionAndNeverCutsOne() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let u = r.updater()
    _ = r.offer(r.record(), updater: u); u.tick()
    try r.finishInstall(version: "0.1.37"); u.tick()
    r.advance(400)
    r.env.setStatus("recording")
    u.tick()
    #expect(u.current.phase == "rollback_pending" && u.current.step == "rollback_deferred_session_open")
    #expect(r.installedVersion == "0.1.37", "nothing is replaced under a session")
    #expect(!r.tools.calls.contains { $0.contains("bootout gui") })
    r.env.setStatus("ready"); u.tick()
    #expect(r.installedVersion == "0.1.36" && u.current.phase == "rollback_health")
  }

  @Test func aRollbackThatDoesNotComeBackIsReportedFailedNotHidden() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let u = r.updater()
    _ = r.offer(r.record(), updater: u); u.tick()
    try r.finishInstall(version: "0.1.37"); u.tick()
    r.advance(400); u.tick()
    r.advance(400); u.tick()
    #expect(u.current.phase == "idle" && u.current.result == "failed" && u.current.detail == "rollback_unhealthy")
    #expect(!r.markerExists, "the watchdog is free to try")
  }

  @Test func aSnapshotThatDoesNotVerifyMeansNoUpdate() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    r.codesignFailsFor = ["/rollback/"]
    let u = r.updater()
    _ = r.offer(r.record(), updater: u); u.tick()
    #expect(u.current.result == "failed" && u.current.detail == "snapshot_unverified")
    #expect(r.jobBootstraps.isEmpty && r.installedVersion == "0.1.36" && !FileManager.default.fileExists(atPath: r.rollback + "/0.1.36.app"))
  }

  // ─── the install job, and the helper being replaced under it ────────────────────────────────

  @Test func theInstallerRunsAsAOneShotJobAndNeverAsAChildOfTheHelper() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let u = r.updater()
    _ = r.offer(r.record(), updater: u); u.tick()
    let plist = try #require(try? String(contentsOfFile: r.support + "/update/installer.plist", encoding: .utf8))
    let parsed = try #require(try PropertyListSerialization.propertyList(from: Data(plist.utf8), format: nil) as? [String: Any])
    #expect(parsed["Label"] as? String == BundleUpdater.installerLabel)
    #expect(parsed["ProgramArguments"] as? [String] == ["/usr/sbin/installer", "-pkg", r.support + "/update/staging/update-0.1.37.pkg", "-target", "/"])
    #expect(parsed["KeepAlive"] == nil && parsed["RunAtLoad"] as? Bool == true)
    #expect(!r.tools.calls.contains { $0.contains("/usr/sbin/installer") }, "the helper never runs installer itself")
  }

  @Test func aNewHelperProcessPicksUpWhereTheOldOneWasReplaced() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let first = r.updater()
    _ = r.offer(r.record(), updater: first); first.tick()
    try r.finishInstall(version: "0.1.37")
    // the pkg's postinstall booted the helper out and in: a fresh object, the same state file
    let second = r.updater()
    #expect(second.current.phase == "installing" && second.current.version == "0.1.37")
    second.tick()
    #expect(second.current.phase == "health")
    second.appBeat(version: "0.1.37"); second.tick()
    #expect(second.current.result == "ok")
  }

  @Test func anInstallThatFailedAndLeftTheOldBundleIntactIsAFailureNotARollback() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let u = r.updater()
    _ = r.offer(r.record(), updater: u); u.tick()
    try r.finishInstall(version: nil, exit: 1)  // the job failed and changed nothing
    u.tick()
    #expect(u.current.result == "failed" && u.current.detail == "install_failed" && r.installedVersion == "0.1.36")
    #expect(!r.markerExists && u.current.failures["0.1.37"]?.count == 1)
  }

  @Test func anInstallThatDamagedTheBundleRestoresTheSnapshot() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let u = r.updater()
    let original = r.fingerprint(r.app)
    _ = r.offer(r.record(), updater: u); u.tick()
    try r.finishInstall(version: "0.0.1", exit: 1)  // half-written: neither version
    r.codesignFailsFor = ["Applications/EvenScribe"]  // the installed copy no longer verifies
    u.tick()
    #expect(u.current.step == "restored" || u.current.phase == "rollback_pending")
    r.codesignFailsFor = []
    u.tick()
    #expect(r.fingerprint(r.app) == original)
  }

  // ─── what the offer decides ─────────────────────────────────────────────────────────────────

  @Test func onlyANewerVersionIsTaken() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let u = r.updater()
    #expect(r.offer(r.record(version: "0.1.36"), updater: u) == .refused(.notNewer))
    #expect(r.offer(r.record(version: "0.1.35"), updater: u) == .refused(.notNewer))
    #expect(r.downloaded.isEmpty && u.current.phase == "idle")
  }

  @Test func theRollbackPinIsHonoured() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    try Data("0.1.36\n".utf8).write(to: URL(fileURLWithPath: r.pinPath))
    let u = r.updater()
    #expect(r.offer(r.record(), updater: u) == .refused(.pinned))
    try Data("0.1.37\n".utf8).write(to: URL(fileURLWithPath: r.pinPath))
    #expect(r.offer(r.record(), updater: u) == .accepted(step: "offered"), "at the pin is allowed")
    let r2 = try UpdateRig(); defer { r2.tearDown() }
    try Data("garbage".utf8).write(to: URL(fileURLWithPath: r2.pinPath))
    #expect(r2.offer(r2.record(), updater: r2.updater()) == .refused(.pinUnreadable), "an unreadable pin holds everything")
  }

  @Test func aPinPutDownWhileTheUpdateWaitedStopsIt() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    r.env.setStatus("recording")
    let u = r.updater()
    _ = r.offer(r.record(), updater: u); u.tick()
    try Data("0.1.36\n".utf8).write(to: URL(fileURLWithPath: r.pinPath))
    r.env.setStatus("ready"); u.tick()
    #expect(u.current.result == "failed" && u.current.detail == "pinned" && r.jobBootstraps.isEmpty)
  }

  @Test func theHelperMustBeNewEnoughForTheRelease() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    #expect(r.offer(r.record(minHelper: "0.3.0"), updater: r.updater()) == .refused(.helperTooOld))
    #expect(r.offer(r.record(minHelper: "0.2.2"), updater: r.updater()) == .accepted(step: "offered"))
  }

  @Test func twoFailuresHoldAVersionForSixHours() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let u = r.updater()
    for attempt in 0..<2 {
      #expect(r.offer(r.record(nonce: "attempt-nonce-\(attempt)"), updater: u) == .accepted(step: "offered"))
      r.pkgBytes = Data([1, 2, 3])  // size no longer matches the record built before? rebuilt below
      r.downloadOK = false
      u.tick()
      r.downloadOK = true
      r.pkgBytes = Data((0..<4096).map { UInt8($0 % 251) })
    }
    #expect(u.current.failures["0.1.37"]?.count == 2)
    #expect(r.offer(r.record(nonce: "attempt-nonce-3"), updater: u) == .refused(.held))
    r.advance(6 * 3600 + 5)
    #expect(r.offer(r.record(nonce: "attempt-nonce-4"), updater: u) == .accepted(step: "offered"))
  }

  @Test func theSameRecordAgainIsIdempotentAndADifferentOneIsBusy() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    r.env.setStatus("recording")
    let u = r.updater()
    let record = r.record()
    #expect(r.offer(record, updater: u) == .accepted(step: "offered"))
    u.tick()
    #expect(r.offer(record, updater: u) == .inProgress(step: "deferred_session_open"))
    #expect(r.offer(r.record(version: "0.1.38", nonce: "another-nonce"), updater: u) == .refused(.busy))
  }

  // ─── cohorts ────────────────────────────────────────────────────────────────────────────────

  @Test func theBucketIsTheFirstFourBytesOfShaOfDeviceAndVersionModuloAHundred() {
    // Computed outside this code base with `printf '%s' "<device>|<version>" | shasum -a 256`.
    #expect(ReleaseRecord.bucket(deviceID: "dev_0123456789abcdef01234567", version: "0.1.37") == 83)
    #expect(ReleaseRecord.bucket(deviceID: "dev_00000000000000000000000a", version: "0.1.37") == 14)
    #expect(ReleaseRecord.bucket(deviceID: "dev_00000000000000000000000a", version: "0.1.38") == 9)
  }

  @Test func cohortsGateTheOffer() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    func verdict(_ cohort: String, pct: Int = 0, mine: [String]) -> BundleUpdater.Offer {
      let rig = try! UpdateRig(); defer { rig.tearDown() }
      return rig.offer(rig.record(cohort: cohort, pct: pct, deviceCohorts: mine), updater: rig.updater())
    }
    #expect(verdict("home_office", mine: ["home_office"]) == .accepted(step: "offered"))
    #expect(verdict("home_office", mine: ["audiometry"]) == .refused(.notEligible))
    #expect(verdict("audiometry", mine: []) == .refused(.notEligible))
    #expect(verdict("all", mine: []) == .accepted(step: "offered"))
    // this device's bucket for 0.1.37 is 14
    #expect(verdict("pct", pct: 14, mine: []) == .refused(.notEligible), "bucket 14 is not under 14")
    #expect(verdict("pct", pct: 15, mine: []) == .accepted(step: "offered"))
    #expect(verdict("pct", pct: 0, mine: ["pct"]) == .refused(.notEligible), "membership of 'pct' does not matter, the bucket does")
    #expect(verdict("opd1", mine: ["opd1", "audiometry"]) == .accepted(step: "offered"))
  }

  // ─── nothing else moves ─────────────────────────────────────────────────────────────────────

  @Test func theRecordersAudioIsNeverTouchedByAnUpdateOrARollback() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let sentinel = r.base.path + "/home/Library/Application Support/EvenScribe/RoomRecorder/captures/s1/seg1/tape.pcm"
    try FileManager.default.createDirectory(atPath: (sentinel as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try Data("audio".utf8).write(to: URL(fileURLWithPath: sentinel))
    let u = r.updater()
    _ = r.offer(r.record(), updater: u); u.tick()
    try r.finishInstall(version: "0.1.37"); u.tick()
    r.advance(400); u.tick()
    #expect(u.current.step == "restored")
    #expect(try Data(contentsOf: URL(fileURLWithPath: sentinel)) == Data("audio".utf8))
    #expect(!r.tools.calls.contains { $0.contains("captures") || $0.contains("RoomRecorder") })
  }

  @Test func everyToolTheUpdaterRunsIsOnTheHelpersList() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let u = r.updater()
    _ = r.offer(r.record(), updater: u); u.tick()
    try r.finishInstall(version: "0.1.37"); u.tick()
    r.advance(400); u.tick()
    let executables = Set(r.tools.calls.compactMap { $0.split(separator: " ").first.map(String.init) })
    #expect(executables.isSubset(of: ProcessSystemTools.allowed), "\(executables)")
    #expect(!r.tools.calls.contains { $0.contains("sh -c") || $0.contains("/bin/sh") })
  }

  @Test func theUpdaterSourceNeverNamesAudioOrTheRecordersFolder() throws {
    let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources/HelperCore")
    for name in ["BundleUpdater.swift", "UpdateDisk.swift", "ReleaseRecord.swift"] {
      let text = try String(contentsOf: sources.appendingPathComponent(name), encoding: .utf8)
      let code = text.split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") && !$0.trimmingCharacters(in: .whitespaces).hasPrefix("///") }.joined(separator: "\n")
      for word in ["captures", "tape.pcm", "tapewriter", "RoomRecorder/", "removeItem(atPath: roomRoot"] { #expect(!code.contains(word), "\(name) mentions \(word)") }
    }
  }
}

// ─── 0.1.37 R2: the three blockers and the hardening ───────────────────────────────────────────────

extension UpdateRig {
  /// Installs 0.1.37, restarts, lets the five minutes pass with no beat: the updater now wants to roll back.
  func driveToRollbackPending(_ u: BundleUpdater) throws {
    _ = offer(record(), updater: u); u.tick()
    try finishInstall(version: "0.1.37"); u.tick()
    advance(400)
    env.setStatus("ready")
  }
  var restoreDir: String { support + "/update/staging/restore.app" }
}

@Suite(.serialized) struct BundleUpdaterR2Tests {
  // B1: the session is looked at again, last, before the recorder is stopped
  @Test func aSessionThatOpensDuringTheRestoreCopyDefersTheBootoutAndCutsNothing() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let u = r.updater()
    try r.driveToRollbackPending(u)
    r.onRestore = { r.env.setStatus("recording") }  // a consultation starts while the snapshot is being copied
    u.tick()
    #expect(u.current.phase == "rollback_pending" && u.current.step == "rollback_deferred_session_open")
    #expect(!r.tools.calls.contains { $0.contains("bootout gui") }, "the recorder was not stopped")
    #expect(r.installedVersion == "0.1.37", "the installed bundle was not moved")
    #expect(!FileManager.default.fileExists(atPath: r.restoreDir), "the unused copy is removed")
    #expect(!FileManager.default.fileExists(atPath: r.rollback + "/failed-0.1.37.app"))
    // the session ends: the rollback goes through
    r.onRestore = nil
    r.env.setStatus("ready"); u.tick()
    #expect(r.installedVersion == "0.1.36" && u.current.phase == "rollback_health")
  }

  @Test func theSessionReProbeIsFailClosedToo() throws {
    for status in ["paused", "garbage"] {
      let r = try UpdateRig(); defer { r.tearDown() }
      let u = r.updater()
      try r.driveToRollbackPending(u)
      r.onRestore = { if status == "paused" { r.env.setStatus("paused") } else { r.env.files[FakeEnv.root + "/status.json"] = Data("junk".utf8) } }
      u.tick()
      #expect(u.current.step == "rollback_deferred_session_open" && !r.tools.calls.contains { $0.contains("bootout gui") }, "\(status)")
    }
  }

  // B3: a crash between the two renames resumes to an installed app
  /// The disk exactly as a crash between the renames leaves it: phase rolling_back, the failed bundle aside, a staged restore copy,
  /// NO app at the install path.
  func crashBetweenTheRenames(_ r: UpdateRig, keepRestoreCopy: Bool = true) throws -> BundleUpdater {
    let first = r.updater()
    try r.driveToRollbackPending(first)
    #expect(first.current.phase == "health", "the five minutes have passed but no pass has noticed yet")
    var state = try JSONDecoder().decode(BundleUpdater.State.self, from: Data(contentsOf: URL(fileURLWithPath: r.statePath)))
    state.phase = "rolling_back"
    try JSONEncoder().encode(state).write(to: URL(fileURLWithPath: r.statePath))
    if keepRestoreCopy {
      try? FileManager.default.createDirectory(atPath: r.support + "/update/staging", withIntermediateDirectories: true)
      try FileManager.default.copyItem(atPath: r.rollback + "/0.1.36.app", toPath: r.restoreDir)
    }
    try FileManager.default.moveItem(atPath: r.app, toPath: r.rollback + "/failed-0.1.37.app")  // the first rename happened
    #expect(!FileManager.default.fileExists(atPath: r.app))
    return r.updater()  // the helper restarted: a new object on the same state file
  }

  @Test func aCrashBetweenTheRenamesResumesToTheOldAppByteForByte() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let original = r.fingerprint(r.app)  // 0.1.36, as installed before the update began
    let resumed = try crashBetweenTheRenames(r)
    resumed.tick()
    #expect(FileManager.default.fileExists(atPath: r.app), "there is an app again")
    #expect(r.installedVersion == "0.1.36" && resumed.current.phase == "rollback_health" && resumed.current.step == "restored")
    #expect(r.fingerprint(r.app) == original, "byte for byte what was installed before the update")
    #expect(r.tools.calls.contains { $0.hasPrefix("/bin/launchctl bootstrap gui/501") }, "the agent is started again")
    resumed.appBeat(version: "0.1.36"); resumed.tick()
    #expect(resumed.current.result == "rolled_back" && !r.markerExists)
  }

  @Test func ifTheStagedCopyIsGoneToo_theSnapshotIsCopiedAgain() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let resumed = try crashBetweenTheRenames(r, keepRestoreCopy: false)
    resumed.tick()
    #expect(r.installedVersion == "0.1.36" && resumed.current.phase == "rollback_health")
    #expect(r.fingerprint(r.app) == r.fingerprint(r.rollback + "/0.1.36.app"))
  }

  @Test func aFinishNeverDeletesTheStagedCopyWhileThereIsNoApp() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let resumed = try crashBetweenTheRenames(r)
    r.failRenames = true  // the second rename keeps failing on resume
    resumed.tick()
    #expect(resumed.current.phase == "idle" && resumed.current.detail == "restore_rename_failed")
    #expect(FileManager.default.fileExists(atPath: r.restoreDir), "the only whole bundle left is not thrown away")
    #expect(!FileManager.default.fileExists(atPath: r.app))
  }

  @Test func withNoAppNoCopyAndNoSnapshotItIsReportedLoudly() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let resumed = try crashBetweenTheRenames(r, keepRestoreCopy: false)
    try FileManager.default.removeItem(atPath: r.rollback + "/0.1.36.app")
    resumed.tick()
    #expect(resumed.current.result == "failed" && resumed.current.detail == "no_app_and_no_snapshot")
  }

  // hardening: nothing but digits and dots builds a path or a plist
  @Test func aVersionThatCouldBuildAPathOrBreakAPlistIsNotAVersion() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    for bad in ["0.1.37-beta", "0.1.37+x", "../../etc", "0.1.37</string><key>x", "0.1.37/../x", "0.1.37 ", "", "1.2.3.4.5", "v1"] {
      #expect(r.offer(r.record(version: bad), updater: r.updater()) == .refused(.malformed), "\(bad)")
    }
    #expect(r.offer(r.record(version: "0.1.37"), updater: r.updater()) == .accepted(step: "offered"))
    #expect(ReleaseRecord.isPlainVersion("1") && ReleaseRecord.isPlainVersion("1.2.3.4") && !ReleaseRecord.isPlainVersion("1.2.3.4.5"))
  }

  @Test func anInstalledVersionThatIsNotPlainBuildsNoRootPath() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    try r.makeApp(at: r.app, version: "../../Library/x", body: "old")
    #expect(r.offer(r.record(), updater: r.updater()) == .refused(.unknownInstalled))
    #expect(!FileManager.default.fileExists(atPath: r.rollback), "nothing was created from it")
  }
}

// ─── the snapshot is read as the user ─────────────────────────────────────────────────────────────

@Suite struct BundleSnapshotTests {
  func disk(_ base: String) -> SystemUpdateDisk {
    SystemUpdateDisk(reader: UnprivilegedUserFiles(), supportDirectory: base, setOwner: false)
  }

  @Test func theCopyKeepsLinksModesAndContentAndNothingElse() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let target = r.base.path + "/snap.app"
    #expect(disk(r.support).snapshotBundle(r.app, user: "room", to: target))
    #expect(r.fingerprint(target) == r.fingerprint(r.app))
  }

  @Test func aHardLinkedFileInTheBundleRefusesTheWholeSnapshot() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    try FileManager.default.linkItem(atPath: r.app + "/Contents/Info.plist", toPath: r.base.path + "/elsewhere.plist")
    let target = r.base.path + "/snap.app"
    #expect(!disk(r.support).snapshotBundle(r.app, user: "room", to: target))
    #expect(!FileManager.default.fileExists(atPath: target), "a partial copy is not left behind")
  }

  @Test func aFifoInTheBundleRefusesTheWholeSnapshotWithoutHanging() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    #expect(mkfifo(r.app + "/Contents/trap", 0o600) == 0)
    let done = DispatchSemaphore(value: 0)
    let box = Box2()
    Thread.detachNewThread { box.ok = disk(r.support).snapshotBundle(r.app, user: "room", to: r.base.path + "/snap.app"); done.signal() }
    #expect(done.wait(timeout: .now() + 5) == .success, "the copy must not block on a FIFO")
    #expect(box.ok == false)
  }

  @Test func aSymlinkIsCopiedAsALinkAndItsTargetIsNeverRead() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    try Data("ROOT-ONLY-SECRET".utf8).write(to: URL(fileURLWithPath: r.base.path + "/secret"))
    try FileManager.default.createSymbolicLink(atPath: r.app + "/Contents/leak", withDestinationPath: r.base.path + "/secret")
    let target = r.base.path + "/snap.app"
    #expect(disk(r.support).snapshotBundle(r.app, user: "room", to: target))
    #expect(try FileManager.default.destinationOfSymbolicLink(atPath: target + "/Contents/leak") == r.base.path + "/secret")
    let all = r.fingerprint(target).joined()
    #expect(!all.contains("ROOT-ONLY-SECRET"))
  }

  @Test func theRestoreCopyIsRootsOwnAndKeepsLinks() throws {
    let r = try UpdateRig(); defer { r.tearDown() }
    let snap = r.base.path + "/snap.app", restored = r.base.path + "/restored.app"
    #expect(disk(r.support).snapshotBundle(r.app, user: "room", to: snap))
    #expect(disk(r.support).restoreTree(from: snap, to: restored, uid: getuid(), gid: getgid()))
    #expect(r.fingerprint(restored) == r.fingerprint(r.app))
  }

  final class Box2: @unchecked Sendable { var ok: Bool? }
}
