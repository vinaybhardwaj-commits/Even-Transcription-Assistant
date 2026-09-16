import Foundation
import XCTest
@testable import BenchCore

final class BenchClientTests: XCTestCase {
    let origin = URL(string: "https://www.evenscribe.app")!

    func client(_ t: FakeTransport, token: String? = "TOKEN") -> BenchClient {
        BenchClient(origin: origin, transport: t, sessionToken: { token })
    }

    func testEveryAPIRequestCarriesTheCookieAndAccept() async throws {
        let t = FakeTransport()
        t.onJSON("GET /api/bench/sessions/active", #"{"ok":true,"resumable":false,"session":null,"handover_pending":false,"tab_gone":false}"#)
        _ = try await client(t).activeSession(tabID: "app_i1")
        let r = try XCTUnwrap(t.requests.first)
        XCTAssertEqual(r.headers["Cookie"], "eta_room_session=TOKEN")
        XCTAssertEqual(r.headers["Accept"], "application/json")
        XCTAssertNil(r.headers["Content-Type"], "a GET carries no Content-Type")
        XCTAssertEqual(r.url.absoluteString, "https://www.evenscribe.app/api/bench/sessions/active?tab_id=app_i1")
    }

    func testNoTokenIsARefusalBeforeAnythingIsSent() async {
        let t = FakeTransport()
        do {
            _ = try await client(t, token: nil).activeSession(tabID: nil)
            XCTFail("sent without a session")
        } catch {
            XCTAssertEqual(error as? BenchError, .missingSessionCookie)
        }
        XCTAssertTrue(t.requests.isEmpty)
    }

    func testCreateSessionSendsBothKeysEvenWhenNull() async throws {
        let t = FakeTransport()
        t.onJSON("POST /api/bench/sessions", #"{"session":{"id":"s1","room_id":"r1","label":null,"mic_label":"usb:0d8c:0134","status":"recording"}}"#)
        let created = try await client(t).createSession(label: nil, micLabel: "usb:0d8c:0134")
        XCTAssertEqual(created.session.id, "s1")
        XCTAssertEqual(created.session.roomID, "r1")
        let r = try XCTUnwrap(t.requests.first)
        XCTAssertEqual(r.headers["Content-Type"], "application/json")
        let body = jsonObject(r.body)
        XCTAssertEqual(Set(body.keys), ["label", "mic_label"])
        XCTAssertTrue(body["label"] is NSNull)
        XCTAssertEqual(body["mic_label"] as? String, "usb:0d8c:0134")
    }

    func testPatchSessionPath() async throws {
        let t = FakeTransport()
        t.onJSON("PATCH *", #"{"ok":true}"#)
        _ = try await client(t).patchSession(id: "a/b c", action: .pause)
        let r = try XCTUnwrap(t.requests.first)
        XCTAssertEqual(r.method, "PATCH")
        XCTAssertEqual(r.url.absoluteString, "https://www.evenscribe.app/api/bench/sessions/a%2Fb%20c")
        XCTAssertEqual(jsonObject(r.body) as NSDictionary, ["action": "pause"] as NSDictionary)
    }

    func testPollQueryOrderAndDecode() async throws {
        let t = FakeTransport()
        t.onJSON("GET /api/bench/commands", """
        {"ok":true,"room_id":"r1","now":"2026-09-16T10:00:00.000Z","assigned_channel":7,
         "commands":[{"id":"c1","kind":"start_day","args":{"override_pause":true}},
                     {"id":"c2","kind":"teleport"},
                     {"kind":"start_day"},
                     {"id":"c3","kind":"end_day","created_at":5}]}
        """)
        var install = InstallPollFields(installID: "i1", tapeAdvancing: true)
        install.hostname = "yoga"
        install.peak = 0.5
        install.zeroRatio = 1.5  // outside 0-1: dropped, never clamped
        let response = try await client(t).pollCommands(
            tabID: "app_i1", previousPollAt: "p", recordingSessionID: "s1", paused: false,
            primaryLevels: BenchLevelPair(peak: 0.25, average: 0.25), install: install)
        XCTAssertEqual(response.roomID, "r1")
        XCTAssertFalse(response.superseded)
        XCTAssertNil(response.assignedChannel, "a wrong-typed field costs that field only")
        XCTAssertEqual(response.commands.map(\.id), ["c1", "c2", "c3"], "an undecodable command is dropped, the rest run")
        XCTAssertEqual(response.commands[1].kind, .unknown("teleport"))
        XCTAssertEqual(response.commands[0].args, .object(["override_pause": .bool(true)]))
        let names = queryItems(try XCTUnwrap(t.requests.first).url).map(\.name)
        XCTAssertEqual(names, ["tab_id", "prev_poll_at", "recording_session_id", "paused", "mic_peak", "mic_avg",
                               "install_id", "tape_advancing", "hostname", "peak"])
        let values = Dictionary(uniqueKeysWithValues: queryItems(t.requests[0].url).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(values["mic_peak"], "0.2500")
        XCTAssertEqual(values["peak"], "0.5000")
        XCTAssertEqual(values["paused"], "false")
    }

    func testAckBodyCarriesOnlyPresentFields() async throws {
        let t = FakeTransport()
        t.onJSON("POST *", #"{"ok":true,"id":"c1","status":"acked"}"#)
        _ = try await client(t).acknowledge(commandID: "c1", ok: true, sessionID: nil, error: nil)
        XCTAssertEqual(Set(jsonObject(t.requests[0].body).keys), ["ok"])
        XCTAssertEqual(t.requests[0].url.path, "/api/bench/commands/c1/ack")
        _ = try await client(t).acknowledge(
            commandID: "c1", ok: false, sessionID: "s1", error: "device_not_present",
            audioInput: AudioInputAcknowledgement(inputVolumeSettable: false),
            verb: OperatorVerbAcknowledgement(restarting: true, diag: .object(["a": .number(1)])))
        XCTAssertEqual(Set(jsonObject(t.requests[1].body).keys),
                       ["ok", "session_id", "error", "input_volume_settable", "restarting", "diag"])
    }

    func testFiveStepUploadInOrder() async throws {
        let t = FakeTransport()
        t.onJSON("POST /api/bench/upload-url", #"{"url":"https://store.example/put/k","head_url":"https://store.example/head/k","key":"k"}"#)
        t.on("HEAD /head/k") { [t] _ in
            // First HEAD (probe): not there yet. Second HEAD (verify): there, with the right length.
            let heads = t.requests.filter { $0.method == "HEAD" }.count
            return heads == 1 ? HTTPResponse(status: 404) : HTTPResponse(status: 200, headers: ["Content-Length": "4"])
        }
        t.on("PUT /put/k") { _ in HTTPResponse(status: 200) }
        t.onJSON("POST /api/bench/chunks", #"{"ok":true,"key":"k","upload_state":"verified"}"#)
        let piece = BenchPiece(sessionID: "s1", index: 3, startedAt: "a", endedAt: "b", durationMS: 300000, sizeBytes: 4, gapBeforeMS: 0)
        let result = try await client(t).uploadImmutablePiece(piece, bytes: Data([1, 2, 3, 4]))
        XCTAssertEqual(t.requests.map { "\($0.method) \($0.url.path)" },
                       ["POST /api/bench/upload-url", "HEAD /head/k", "PUT /put/k", "HEAD /head/k", "POST /api/bench/chunks"])
        guard case .registered(_, let uploaded) = result else { return XCTFail("\(result)") }
        XCTAssertTrue(uploaded)
        XCTAssertNil(t.requests[1].headers["Cookie"], "presigned storage calls carry no session cookie")
        XCTAssertNil(t.requests[2].headers["Cookie"])
        XCTAssertEqual(t.requests[2].headers["Content-Type"], "audio/webm")
        XCTAssertEqual(jsonObject(t.requests[0].body) as NSDictionary,
                       ["session_id": "s1", "idx": 3, "content_type": "audio/webm"] as NSDictionary)
        XCTAssertEqual(Set(jsonObject(t.requests[4].body).keys),
                       ["session_id", "idx", "content_type", "started_at", "ended_at", "duration_ms", "size_bytes", "gap_before_ms"])
    }

    func testVerifyHeadDisagreeingIsASizeMismatchThatRetainsThePiece() async throws {
        let t = FakeTransport()
        t.onJSON("POST /api/bench/upload-url", #"{"url":"https://s/p","head_url":"https://s/h"}"#)
        t.on("HEAD /h") { [t] _ in
            t.requests.filter { $0.method == "HEAD" }.count == 1 ? HTTPResponse(status: 404) : HTTPResponse(status: 200, headers: ["content-length": "3"])
        }
        t.on("PUT /p") { _ in HTTPResponse(status: 200) }
        let piece = BenchPiece(sessionID: "s1", index: 0, startedAt: "a", endedAt: "b", durationMS: 1, sizeBytes: 4, gapBeforeMS: 0)
        do {
            _ = try await client(t).uploadImmutablePiece(piece, bytes: Data([1, 2, 3, 4]))
            XCTFail("registered a piece whose verify HEAD disagreed")
        } catch let error as BenchError {
            XCTAssertEqual(error, .sizeMismatch(expected: 4, actual: 3, retention: .retainLocalPiece))
            XCTAssertTrue(error.mustRetainLocalPiece)
        }
        XCTAssertFalse(t.requests.contains { $0.url.path == "/api/bench/chunks" })
    }

    func testObjectAlreadyPresentSkipsThePut() async throws {
        let t = FakeTransport()
        t.onJSON("POST /api/bench/upload-url", #"{"url":"https://s/p","head_url":"https://s/h"}"#)
        t.on("HEAD /h") { _ in HTTPResponse(status: 200, headers: ["Content-Length": "4"]) }
        t.onJSON("POST /api/bench/chunks", #"{"ok":true,"key":"k","upload_state":"verified"}"#)
        let piece = BenchPiece(sessionID: "s1", index: 0, startedAt: "a", endedAt: "b", durationMS: 1, sizeBytes: 4, gapBeforeMS: 0)
        guard case .registered(_, let uploaded) = try await client(t).uploadImmutablePiece(piece, bytes: Data([1, 2, 3, 4])) else {
            return XCTFail()
        }
        XCTAssertFalse(uploaded)
        XCTAssertFalse(t.requests.contains { $0.method == "PUT" })
    }

    func testAlreadyVerifiedEndsAtPresign() async throws {
        let t = FakeTransport()
        t.onJSON("POST /api/bench/upload-url", #"{"already_verified":true}"#)
        let piece = BenchPiece(sessionID: "s1", index: 0, startedAt: "a", endedAt: "b", durationMS: 1, sizeBytes: 1, gapBeforeMS: 0)
        let result = try await client(t).uploadImmutablePiece(piece, bytes: Data([9]))
        XCTAssertEqual(result, .alreadyVerified)
        XCTAssertEqual(t.requests.count, 1)
    }

    func testErrorClassification() async throws {
        let t = FakeTransport()
        t.onJSON("GET /api/bench/commands", status: 409, #"{"error":{"code":"RETIRED","message":"x"}}"#)
        do {
            _ = try await client(t).pollCommands(tabID: "t", previousPollAt: nil, recordingSessionID: nil, paused: false, primaryLevels: nil, install: nil)
            XCTFail()
        } catch let e as BenchError {
            XCTAssertTrue(e.isRetired)
            XCTAssertFalse(e.mustRetainLocalPiece)
        }
        t.onJSON("GET /api/bench/commands", status: 409, #"{"error":{"code":"CONFLICT"}}"#)
        do {
            _ = try await client(t).pollCommands(tabID: "t", previousPollAt: nil, recordingSessionID: nil, paused: false, primaryLevels: nil, install: nil)
            XCTFail()
        } catch let e as BenchError {
            XCTAssertFalse(e.isRetired, "409 alone is not RETIRED")
        }
        t.onJSON("GET /api/bench/commands", status: 401, #"{}"#)
        do {
            _ = try await client(t).pollCommands(tabID: "t", previousPollAt: nil, recordingSessionID: nil, paused: false, primaryLevels: nil, install: nil)
            XCTFail()
        } catch let e as BenchError {
            XCTAssertTrue(e.isAuthRefused)
        }
    }

    func testInputDevicesJSON() {
        let json = InstallPollFields.inputDevicesJSON([
            .init(name: " TONOR TM20 ", uid: "usb:0d8c:0134", isDefault: true),
            .init(name: "", uid: "usb:1:2", isDefault: false),
            .init(name: "second default", uid: "usb:3:4", isDefault: true),
        ])
        XCTAssertEqual(json, #"[{"is_default":true,"name":"TONOR TM20","uid":"usb:0d8c:0134"}]"#)
        XCTAssertNil(InstallPollFields.inputDevicesJSON([.init(name: "", uid: "", isDefault: false)]))
        XCTAssertEqual(InstallPollFields.inputDevicesJSON([]), "[]")
    }
}
