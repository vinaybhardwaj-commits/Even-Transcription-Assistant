import Foundation
import XCTest
#if canImport(Glibc)
import Glibc
#endif
@testable import BenchCore

func temporaryRoot() -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("bench-\(UUID().uuidString)")
    mkdir(url.path, 0o750)
    return url
}

func mode(_ url: URL) -> mode_t {
    var info = stat()
    lstat(url.path, &info)
    return info.st_mode & 0o7777
}

final class WriteLog: @unchecked Sendable {
    private let lock = NSLock()
    private var names: [String] = []
    func add(_ n: String) { lock.withLock { names.append(n) } }
    var all: [String] { lock.withLock { names } }
}

let tm20 = EnumeratedCaptureDevice(uid: USBDeviceUID("usb:0d8c:0134")!, name: "USB Audio", alsaName: "hw:CARD=Device,DEV=0", card: 1)

final class EnrolmentTests: XCTestCase {
    let enrolJSON = #"{"install_id":"inst_1","room_slug":"opd-5","room_name":"OPD 5","session":{"token":"JWT.SECRET","expires_at":"2027-09-16T00:00:00Z"}}"#

    func testOriginAllowlist() throws {
        XCTAssertEqual(try RoomEnrolment.validate(origin: "https://www.evenscribe.app", allowLocalStub: false).absoluteString, "https://www.evenscribe.app")
        XCTAssertEqual(try RoomEnrolment.validate(origin: "HTTPS://EvenScribe.App/some/path?x=1", allowLocalStub: false).absoluteString, "https://evenscribe.app")
        XCTAssertEqual(try RoomEnrolment.validate(origin: "https://evenscribe.app:8443", allowLocalStub: false).absoluteString, "https://evenscribe.app:8443")
        for bad in ["http://www.evenscribe.app", "https://www.evenscribe.app.evil.example", "https://evil.example", "www.evenscribe.app", "http://127.0.0.1:8080"] {
            XCTAssertThrowsError(try RoomEnrolment.validate(origin: bad, allowLocalStub: false), bad)
        }
        XCTAssertFalse(RoomEnrolment.allowsLocalStubOrigin, "the stub allowance must not be in an ordinary build")
        XCTAssertEqual(try RoomEnrolment.validate(origin: "http://127.0.0.1:8080", allowLocalStub: true).absoluteString, "http://127.0.0.1:8080")
        XCTAssertThrowsError(try RoomEnrolment.validate(origin: "http://10.0.0.1", allowLocalStub: true))
    }

    func testExchangeRequestShape() async throws {
        let t = FakeTransport()
        t.onJSON("POST /api/room-recorder/enrol", enrolJSON)
        let r = try await RoomEnrolment.exchange(token: "BOOT", origin: URL(string: "https://www.evenscribe.app")!, transport: t)
        XCTAssertEqual(r.installID, "inst_1")
        XCTAssertEqual(r.session.expiresAt, "2027-09-16T00:00:00Z")
        let req = try XCTUnwrap(t.requests.first)
        XCTAssertEqual(req.url.absoluteString, "https://www.evenscribe.app/api/room-recorder/enrol")
        XCTAssertNil(req.headers["Cookie"])
        XCTAssertEqual(jsonObject(req.body) as NSDictionary, ["token": "BOOT"] as NSDictionary)
    }

    func testServerRefusalCarriesTheCodeAndNeverTheToken() async {
        let t = FakeTransport()
        t.onJSON("POST *", status: 401, #"{"error":{"code":"TOKEN_INVALID","message":"unknown, expired or spent"}}"#)
        do {
            _ = try await RoomEnrolment.exchange(token: "SECRET-BOOT", origin: URL(string: "https://evenscribe.app")!, transport: t)
            XCTFail()
        } catch {
            XCTAssertEqual(error as? RoomEnrolmentError, .server(status: 401, code: "TOKEN_INVALID", message: "unknown, expired or spent"))
            XCTAssertFalse("\(error)".contains("SECRET-BOOT"))
        }
        t.onJSON("POST *", #"{"install_id":"x"}"#)
        do {
            _ = try await RoomEnrolment.exchange(token: "t", origin: URL(string: "https://evenscribe.app")!, transport: t)
            XCTFail()
        } catch {
            XCTAssertEqual(error as? RoomEnrolmentError, .malformedResponse)
        }
    }

    func testPersistOrderSessionFirstThenConfigAtModes() throws {
        let root = temporaryRoot()
        let log = WriteLog()
        let store = RoomStore(root: root, didWrite: { log.add($0) })
        let enrolled = try JSONDecoder().decode(RoomEnrolmentResponse.self, from: Data(enrolJSON.utf8))
        let device = try RoomEnrolment.preflight(store: store, requestedDeviceUID: "usb:0D8C:0134", devices: [tm20], ffmpegIsExecutable: true)
        let config = try RoomEnrolment.persist(enrolled, origin: URL(string: "https://www.evenscribe.app")!, deviceUID: device, store: store)
        XCTAssertEqual(log.all, ["config.json.staged", "room-session.json", "config.json"], "staged, then the session installed FIRST, then config.json")
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.stagedConfigURL.path))
        XCTAssertEqual(mode(root), 0o750)
        XCTAssertEqual(mode(store.sessionURL), 0o600)
        XCTAssertEqual(mode(store.configURL), 0o600)
        XCTAssertEqual(config.deviceUID, "usb:0d8c:0134")
        XCTAssertEqual(config.tabID, "app_inst_1")
        XCTAssertEqual(try store.loadSession()?.sessionToken, "JWT.SECRET")
        let configText = try String(contentsOf: store.configURL, encoding: .utf8)
        XCTAssertFalse(configText.contains("JWT.SECRET"), "config.json never holds the token")
        XCTAssertEqual(Set((try JSONSerialization.jsonObject(with: Data(contentsOf: store.sessionURL)) as! [String: Any]).keys),
                       ["session_token", "install_id", "room_slug", "room_name", "origin", "written_by", "written_at"])
        XCTAssertTrue((try FileManager.default.contentsOfDirectory(atPath: root.path)).allSatisfy { !$0.hasSuffix(".tmp") })
    }

    func testReEnrolKeepsDeviceAndChannelLockResetsTheRest() throws {
        let root = temporaryRoot()
        let store = RoomStore(root: root)
        var existing = RoomConfig(origin: URL(string: "https://evenscribe.app")!, roomSlug: "old", deviceUID: "usb:0d8c:0134",
                                  installID: "inst_0", tabID: "app_inst_0", updateChannel: "test", channelLocked: true)
        existing.ffmpegPath = "/opt/old/ffmpeg"
        try store.saveConfig(existing)
        try store.saveRetired(RetiredMarker(installID: "inst_0", at: Date()))
        XCTAssertThrowsError(try RoomEnrolment.preflight(store: store, requestedDeviceUID: "usb:1234:5678", devices: [tm20], ffmpegIsExecutable: true)) {
            guard case .deviceIdentityConflict = $0 as? RoomEnrolmentError else { return XCTFail("\($0)") }
        }
        let device = try RoomEnrolment.preflight(store: store, requestedDeviceUID: nil, devices: [tm20], ffmpegIsExecutable: true)
        let enrolled = try JSONDecoder().decode(RoomEnrolmentResponse.self, from: Data(enrolJSON.utf8))
        let config = try RoomEnrolment.persist(enrolled, origin: URL(string: "https://www.evenscribe.app")!, deviceUID: device, store: store)
        XCTAssertEqual(config.deviceUID, "usb:0d8c:0134")
        XCTAssertTrue(config.channelLocked)
        XCTAssertEqual(config.updateChannel, "stable")
        XCTAssertEqual(config.installID, "inst_1")
        XCTAssertEqual(config.roomSlug, "opd-5")
        XCTAssertEqual(config.ffmpegPath, Pinned.ffmpegPath)
        XCTAssertNil(try store.loadRetired(), "a new install id supersedes the old retirement")
    }

    struct SimulatedDeath: Error {}

    /// An enrolment's persist killed at every point, then the next start's recovery: the machine holds either what it had
    /// before (nothing, or the previous pair) or the complete new pair — never a session without a config, never a
    /// partial file, never a stray staged config.
    func testDeathAtAnyPointLeavesTheOldStateOrTheCompleteNewPair() throws {
        let enrolled = try JSONDecoder().decode(RoomEnrolmentResponse.self, from: Data(enrolJSON.utf8))
        let origin = URL(string: "https://www.evenscribe.app")!
        for previous in [false, true] {
            for point in ["before-staged-config", "after-staged-config", "after-session", "after-config", "never"] {
                let root = temporaryRoot()
                let dying = RoomStore(root: root, faultPoint: { if $0 == point { throw SimulatedDeath() } })
                if previous {
                    try dying.saveSession(RoomSessionRecord(sessionToken: "OLD", installID: "inst_0", roomSlug: "opd-5", roomName: "OPD 5",
                                                            origin: origin.absoluteString, writtenBy: "t", writtenAt: Date()))
                    try dying.saveConfig(RoomConfig(origin: origin, roomSlug: "opd-5", deviceUID: "usb:0d8c:0134", installID: "inst_0", tabID: "app_inst_0"))
                }
                do {
                    try RoomEnrolment.persist(enrolled, origin: origin, deviceUID: USBDeviceUID("usb:0d8c:0134")!, store: dying)
                } catch is SimulatedDeath {}
                let next = RoomStore(root: root)
                _ = try RoomEnrolment.completeInterruptedEnrolment(store: next)
                let session = try next.loadSession()
                let config = try next.loadConfig()
                let label = "\(previous ? "re-enrol" : "first enrol"), died \(point)"
                XCTAssertFalse(FileManager.default.fileExists(atPath: next.stagedConfigURL.path), label)
                XCTAssertEqual(session?.installID, config?.installID, "\(label): session and config always name the same install")
                XCTAssertEqual(session == nil, config == nil, "\(label): never one without the other")
                if point == "after-session" || point == "after-config" || point == "never" {
                    XCTAssertEqual(session?.installID, "inst_1", "\(label): the new pair")
                    XCTAssertEqual(session?.sessionToken, "JWT.SECRET", label)
                } else {
                    XCTAssertEqual(session?.installID, previous ? "inst_0" : nil, "\(label): the state from before")
                }
                XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).allSatisfy { !$0.hasSuffix(".tmp") }, label)
            }
        }
    }

    func testEveryTransportSharesOneProcessSession() {
        XCTAssertTrue(URLSessionTransport().session === URLSessionTransport(timeout: 5).session,
                      "a released transport must never release the URLSession (corelibs aborts in its teardown)")
    }

    func testAbsentDeviceRefusesBeforeAnythingIsWritten() throws {
        let root = temporaryRoot()
        let store = RoomStore(root: root)
        XCTAssertThrowsError(try RoomEnrolment.preflight(store: store, requestedDeviceUID: "usb:0d8c:0134", devices: [], ffmpegIsExecutable: true)) {
            XCTAssertEqual($0 as? RoomEnrolmentError, .deviceNotPresent("usb:0d8c:0134"))
        }
        XCTAssertThrowsError(try RoomEnrolment.preflight(store: store, requestedDeviceUID: nil, devices: [tm20], ffmpegIsExecutable: true)) {
            XCTAssertEqual($0 as? RoomEnrolmentError, .firstEnrolNeedsDevice)
        }
        XCTAssertThrowsError(try RoomEnrolment.preflight(store: store, requestedDeviceUID: "hw:CARD=Device", devices: [tm20], ffmpegIsExecutable: true))
        XCTAssertThrowsError(try RoomEnrolment.preflight(store: store, requestedDeviceUID: "usb:0d8c:0134", devices: [tm20], ffmpegIsExecutable: false))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
    }

    func testReadRefusesWrongModeAndSymlink() throws {
        let root = temporaryRoot()
        let store = RoomStore(root: root)
        try store.saveStatus(RoomStatus(state: .ready))
        chmod(store.statusURL.path, 0o644)
        XCTAssertThrowsError(try store.loadStatus())
        let target = root.appendingPathComponent("elsewhere.json")
        try Data("{}".utf8).write(to: target)
        chmod(target.path, 0o600)
        symlink(target.path, store.configURL.path)
        XCTAssertThrowsError(try store.loadConfig())
    }

    func testUSBDeviceUID() {
        XCTAssertEqual(USBDeviceUID("usb:0D8C:0134")?.description, "usb:0d8c:0134")
        XCTAssertEqual(USBDeviceUID(procUSBID: "0d8c:0134\n")?.description, "usb:0d8c:0134")
        for bad in ["usb:d8c:0134", "usb:0d8c:0134:1", "USB:0d8c:0134", "usb:0g8c:0134", "0d8c:0134", ""] {
            XCTAssertNil(USBDeviceUID(bad), bad)
        }
        XCTAssertNil(DeviceResolution.resolve("usb:0d8c:0135", in: [tm20]), "exact match only")
    }
}
