#if canImport(RoomRecorderCore)
  import Foundation
  import RoomRecorderCore
  import TapeCore
  import Testing

  @Suite(.serialized) struct RoomBenchContractTests {
    @Test func configurationAndStatusAreAtomicAndPrivate() throws {
      let root = FileManager.default.temporaryDirectory.appendingPathComponent(
        "room-bench-contract-\(UUID().uuidString)",
        isDirectory: true
      )
      defer { try? FileManager.default.removeItem(at: root) }
      let persistence = RoomPersistence(root: root)
      let configuration = try makeConfiguration(cookie: "signed.jwt")
      let status = RoomRecorderStatus(
        state: .uploadPending,
        sessionID: "bs_test",
        pendingPieceCount: 2,
        lastError: "offline",
        updatedAt: Date(timeIntervalSince1970: 1_700_000_000)
      )

      try persistence.saveConfiguration(configuration)
      try persistence.saveStatus(status)

      #expect(try persistence.loadConfiguration() == configuration)
      #expect(try persistence.loadStatus() == status)
      #expect(permissions(of: root) == 0o700)
      #expect(permissions(of: persistence.configurationURL) == 0o600)
      #expect(permissions(of: persistence.statusURL) == 0o600)
      let configJSON = try String(contentsOf: persistence.configurationURL, encoding: .utf8)
      #expect(!configJSON.contains("\"pin\""))
      #expect(configJSON.contains("\"eta_room_session\""))
    }

    @Test func retainedArchiveRecoveryFlagIsPersistedAndDefaultsOffForExistingConfig() throws {
      let legacy = Data(
        #"{"device_uid":"device-stable-1","ffmpeg_path":"/opt/ffmpeg","origin":"https://eta.test/","room_slug":"home-office","tapewriter_path":"/usr/bin/tapewriter"}"#
          .utf8
      )
      let decoded = try JSONDecoder().decode(RoomConfiguration.self, from: legacy)
      #expect(!decoded.retainedArchiveRecoveryEnabled)
      #expect(!decoded.residentArchiveCaptureEnabled)
      #expect(decoded.archivePreflightReceipt == nil)
      #expect(
        decoded.residentArchiveEligibility(
          archiveRootURL: URL(fileURLWithPath: "/private/archive")) == .disabled)

      let enabled = try RoomConfiguration(
        origin: #require(URL(string: "https://eta.test")),
        roomSlug: "home-office",
        deviceUID: "device-stable-1",
        tapewriterPath: "/usr/bin/tapewriter",
        ffmpegPath: "/opt/ffmpeg",
        retainedArchiveRecoveryEnabled: true
      )
      let roundTrip = try JSONDecoder().decode(
        RoomConfiguration.self,
        from: JSONEncoder().encode(enabled)
      )
      #expect(roundTrip.retainedArchiveRecoveryEnabled)
    }

    @Test func residentArchiveRequiresMatchingSuccessfulPreflightReceipt() throws {
      let origin = try #require(URL(string: "https://eta.test/"))
      let archiveRoot = URL(fileURLWithPath: "/private/room-recorder/archive")
      let successful = try RoomArchivePreflightReceipt(
        origin: origin,
        roomSlug: "home-office",
        deviceUID: "device-stable-1",
        ffmpegPath: "/opt/ffmpeg",
        archiveRootPath: archiveRoot.path,
        archiveProbeSucceeded: true,
        keyProbeSucceeded: true,
        encoderProbeSucceeded: true,
        secureEnclavePublicKeySHA256: String(repeating: "a", count: 64),
        encoderProvenanceID: "ffmpeg-pinned-build-1",
        completedAt: Date(timeIntervalSince1970: 1_777_000_000)
      )
      let eligible = try RoomConfiguration(
        origin: origin,
        roomSlug: "home-office",
        deviceUID: "device-stable-1",
        tapewriterPath: "/usr/bin/tapewriter",
        ffmpegPath: "/opt/ffmpeg",
        residentArchiveCaptureEnabled: true,
        archivePreflightReceipt: successful
      )
      #expect(eligible.residentArchiveEligibility(archiveRootURL: archiveRoot) == .eligible)
      #expect(
        eligible.residentArchiveEligibility(
          archiveRootURL: URL(fileURLWithPath: "/private/other")) == .preflightReceiptMismatch)

      var missing = eligible
      missing.archivePreflightReceipt = nil
      #expect(
        missing.residentArchiveEligibility(archiveRootURL: archiveRoot) == .missingPreflightReceipt)

      let unsuccessfulReceipt = try RoomArchivePreflightReceipt(
        origin: origin,
        roomSlug: "home-office",
        deviceUID: "device-stable-1",
        ffmpegPath: "/opt/ffmpeg",
        archiveRootPath: archiveRoot.path,
        archiveProbeSucceeded: true,
        keyProbeSucceeded: false,
        encoderProbeSucceeded: true,
        secureEnclavePublicKeySHA256: String(repeating: "a", count: 64),
        encoderProvenanceID: "ffmpeg-pinned-build-1",
        completedAt: Date(timeIntervalSince1970: 1_777_000_000)
      )
      var unsuccessful = eligible
      unsuccessful.archivePreflightReceipt = unsuccessfulReceipt
      #expect(
        unsuccessful.residentArchiveEligibility(archiveRootURL: archiveRoot)
          == .unsuccessfulPreflightReceipt)

      var changedDevice = eligible
      changedDevice.deviceUID = "device-stable-2"
      #expect(
        changedDevice.residentArchiveEligibility(archiveRootURL: archiveRoot)
          == .preflightReceiptMismatch)

      let roundTrip = try JSONDecoder().decode(
        RoomConfiguration.self,
        from: JSONEncoder().encode(eligible)
      )
      #expect(roundTrip == eligible)
    }

    @Test func loginPathBodyCookieAndActiveLookup() async throws {
      let client = try makeClient(cookie: nil)
      var requests: [URLRequest] = []
      ContractURLProtocol.handler = { request in
        requests.append(request)
        if request.url?.path == "/room/home-office/api/login" {
          #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
          let body = try jsonObject(request)
          #expect(body["pin"] as? String == "1234")
          return stub(
            request,
            body: #"{"ok":true,"room":{"id":"room_1","name":"Home Office","slug":"home-office"}}"#,
            headers: ["Set-Cookie": "eta_room_session=signed.jwt; Path=/; HttpOnly; SameSite=Lax"]
          )
        }
        #expect(request.url?.path == "/api/bench/sessions/active")
        #expect(request.value(forHTTPHeaderField: "Cookie") == "eta_room_session=signed.jwt")
        return stub(
          request,
          body:
            #"{"ok":true,"resumable":false,"session":null,"next_idx":null,"reason":"none","handover_pending":false,"tab_gone":false,"handover_started":null,"handover_complete":null}"#
        )
      }

      let login = try await client.login(pin: "1234")
      let active = try await client.activeSession(tabID: "app_device")

      #expect(login.room.id == "room_1")
      #expect(!active.resumable)
      #expect(
        requests.map { $0.url?.path } == [
          "/room/home-office/api/login",
          "/api/bench/sessions/active",
        ])
      #expect(await client.currentConfiguration().etaRoomSession == "signed.jwt")
    }

    @Test func sessionCreatePatchAckAndConsultBodiesMatchBrowser() async throws {
      let client = try makeClient()
      var seen: [(String, String, [String: Any])] = []
      ContractURLProtocol.handler = { request in
        let body = try jsonObject(request)
        seen.append((request.httpMethod ?? "", request.url?.path ?? "", body))
        switch request.url?.path {
        case "/api/bench/sessions":
          return stub(
            request,
            body:
              #"{"session":{"id":"bs_a","room_id":"room_1","label":null,"mic_label":"TONOR","status":"recording"}}"#
          )
        case "/api/bench/sessions/bs_a":
          return stub(request, body: #"{"ok":true}"#)
        case "/api/bench/commands/cmd_a/ack":
          return stub(request, body: #"{"ok":true,"id":"cmd_a","status":"acked"}"#)
        case "/api/bench/brain-proxy":
          return stub(
            request,
            body:
              #"{"ok":true,"delivered":true,"event_id":"be_a","session_id":"bs_a","at":"2026-08-27T10:00:00.000Z","brain_status":200}"#
          )
        default:
          Issue.record("unexpected path \(request.url?.path ?? "nil")")
          return stub(request, status: 404, body: "missing")
        }
      }

      _ = try await client.createSession(label: nil, micLabel: "TONOR")
      _ = try await client.patchSession(id: "bs_a", action: .pause)
      _ = try await client.acknowledge(commandID: "cmd_a", ok: true, sessionID: "bs_a")
      _ = try await client.markConsult(sessionID: "bs_a", at: "2026-08-27T10:00:00.000Z")

      #expect(seen.map { $0.0 } == ["POST", "PATCH", "POST", "POST"])
      #expect(
        seen.map { $0.1 } == [
          "/api/bench/sessions",
          "/api/bench/sessions/bs_a",
          "/api/bench/commands/cmd_a/ack",
          "/api/bench/brain-proxy",
        ])
      #expect(seen[0].2.keys.contains("label"))
      #expect(seen[0].2["label"] is NSNull)
      #expect(seen[0].2["mic_label"] as? String == "TONOR")
      #expect(seen[1].2["action"] as? String == "pause")
      #expect(seen[2].2["session_id"] as? String == "bs_a")
      #expect(seen[3].2["type"] as? String == "consult_mark")
      #expect(seen[3].2["session_id"] as? String == "bs_a")
    }

    @Test func pollUsesExactNativePrimaryQueryAndNoSpareLane() async throws {
      let client = try makeClient()
      ContractURLProtocol.handler = { request in
        #expect(request.url?.path == "/api/bench/commands")
        let items =
          URLComponents(url: try #require(request.url), resolvingAgainstBaseURL: false)?.queryItems
          ?? []
        let query = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        #expect(
          query == [
            "tab_id": "app_device",
            "prev_poll_at": "2026-08-27T10:00:00.000Z",
            "recording_session_id": "bs_a",
            "paused": "false",
            "mic_peak": "0.7500",
            "mic_avg": "0.1250",
            "spare_device": "false",
          ])
        #expect(query["spare_peak"] == nil)
        #expect(query["spare_avg"] == nil)
        return stub(
          request,
          body:
            #"{"ok":true,"room_id":"room_1","superseded":false,"now":"2026-08-27T10:00:01.000Z","commands":[{"id":"cmd_a","kind":"pause_day","args":{},"created_at":"2026-08-27T10:00:00.500Z"}]}"#
        )
      }

      let levels = try #require(BenchLevelPair(peak: 0.75, average: 0.125))
      let answer = try await client.pollCommands(
        tabID: "app_device",
        previousPollAt: "2026-08-27T10:00:00.000Z",
        recordingSessionID: "bs_a",
        paused: false,
        primaryLevels: levels
      )

      #expect(answer.commands.first?.kind == .pauseDay)
    }

    @Test func pollOmitsMicrophoneLevelsWhenUnavailable() async throws {
      let client = try makeClient()
      ContractURLProtocol.handler = { request in
        let items =
          URLComponents(url: try #require(request.url), resolvingAgainstBaseURL: false)?.queryItems
          ?? []
        let query = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        #expect(query["mic_peak"] == nil)
        #expect(query["mic_avg"] == nil)
        return stub(
          request,
          body: #"{"ok":true,"room_id":"room_1","superseded":false,"commands":[]}"#)
      }

      _ = try await client.pollCommands(
        tabID: "app_device",
        paused: false,
        primaryLevels: nil)
    }

    @Test func primaryPresignOmitsSourceAndKeepsAlreadyVerifiedSignal() async throws {
      let client = try makeClient()
      ContractURLProtocol.handler = { request in
        #expect(request.url?.path == "/api/bench/upload-url")
        let body = try jsonObject(request)
        #expect(body["session_id"] as? String == "bs_a")
        #expect(body["idx"] as? Int == 7)
        #expect(body["content_type"] as? String == "audio/webm")
        #expect(body["source"] == nil)
        return stub(request, body: #"{"already_verified":true}"#)
      }

      let result = try await client.uploadImmutablePiece(
        makePiece(size: 3), bytes: Data([1, 2, 3]))
      #expect(result == .alreadyVerified)
    }

    @Test func immutablePieceDoesHeadPutHeadRegisterAndRetainsEndedDisagrees() async throws {
      let client = try makeClient()
      var methodsAndPaths: [String] = []
      var headCount = 0
      ContractURLProtocol.handler = { request in
        methodsAndPaths.append("\(request.httpMethod ?? "") \(request.url?.path ?? "")")
        switch (request.httpMethod, request.url?.host, request.url?.path) {
        case ("POST", _, "/api/bench/upload-url"):
          return stub(
            request,
            body:
              #"{"url":"https://r2.test/piece","head_url":"https://r2.test/piece-head","key":"bench/piece.webm","expires_in_seconds":600,"method":"PUT"}"#
          )
        case ("HEAD", "r2.test", "/piece-head"):
          headCount += 1
          if headCount == 1 { return stub(request, status: 404, body: "") }
          return stub(request, headers: ["Content-Length": "3"])
        case ("PUT", "r2.test", "/piece"):
          #expect(request.value(forHTTPHeaderField: "Content-Type") == "audio/webm")
          #expect(try requestBody(request) == Data([1, 2, 3]))
          #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
          return stub(request)
        case ("POST", _, "/api/bench/chunks"):
          let body = try jsonObject(request)
          #expect(body["source"] == nil)
          #expect(body["size_bytes"] as? Int == 3)
          #expect(body["gap_before_ms"] as? Int == 0)
          return stub(
            request,
            body:
              #"{"ok":true,"key":"bench/piece.webm","upload_state":"verified","ended_disagrees":"ended_disagrees"}"#
          )
        default:
          Issue.record("unexpected request \(request)")
          return stub(request, status: 404)
        }
      }

      let result = try await client.uploadImmutablePiece(
        makePiece(size: 3), bytes: Data([1, 2, 3]))
      guard case .registered(let response, let uploaded) = result else {
        Issue.record("expected registration")
        return
      }
      #expect(uploaded)
      #expect(response.endedDisagrees == "ended_disagrees")
      #expect(
        methodsAndPaths == [
          "POST /api/bench/upload-url",
          "HEAD /piece-head",
          "PUT /piece",
          "HEAD /piece-head",
          "POST /api/bench/chunks",
        ])
    }

    @Test func archiveDeliveryAdapterPreservesExistingWireFields() async throws {
      let client = try makeClient()
      let piece = ArchiveDeliveryPiece(
        sessionID: "bs_a",
        index: 7,
        contentType: "audio/webm",
        startedAtMS: 1_000,
        endedAtMS: 1_006,
        durationMS: 6,
        sizeBytes: 3,
        gapBeforeMS: 27,
        peakLevel: Double(300) / 32_767,
        averageLevel: Double(100) / 32_767,
        source: .backup
      )
      var methodsAndPaths: [String] = []
      ContractURLProtocol.handler = { request in
        methodsAndPaths.append("\(request.httpMethod ?? "") \(request.url?.path ?? "")")
        switch (request.httpMethod, request.url?.host, request.url?.path) {
        case ("POST", _, "/api/bench/upload-url"):
          let body = try jsonObject(request)
          #expect(body["session_id"] as? String == "bs_a")
          #expect(body["idx"] as? Int == 7)
          #expect(body["content_type"] as? String == "audio/webm")
          #expect(body["source"] as? String == "backup")
          return stub(
            request,
            body:
              #"{"url":"https://r2.test/piece","head_url":"https://r2.test/piece-head","key":"bench/piece.webm","expires_in_seconds":600,"method":"PUT"}"#
          )
        case ("HEAD", "r2.test", "/piece-head"):
          return stub(request, headers: ["Content-Length": "3"])
        case ("PUT", "r2.test", "/piece"):
          #expect(request.value(forHTTPHeaderField: "Content-Type") == "audio/webm")
          #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
          #expect(try requestBody(request) == Data([1, 2, 3]))
          return stub(request)
        case ("POST", _, "/api/bench/chunks"):
          let body = try jsonObject(request)
          #expect(body["session_id"] as? String == "bs_a")
          #expect(body["idx"] as? Int == 7)
          #expect(body["content_type"] as? String == "audio/webm")
          #expect(body["started_at"] as? String == "1970-01-01T00:00:01.000Z")
          #expect(body["ended_at"] as? String == "1970-01-01T00:00:01.006Z")
          #expect(body["duration_ms"] as? Int == 6)
          #expect(body["size_bytes"] as? Int == 3)
          #expect(body["gap_before_ms"] as? Int == 27)
          #expect(body["source"] as? String == "backup")
          #expect(
            abs((body["peak_level"] as? Double ?? 0) - Double(300) / 32_767)
              < Double.ulpOfOne)
          #expect(
            abs((body["avg_level"] as? Double ?? 0) - Double(100) / 32_767)
              < Double.ulpOfOne)
          return stub(
            request,
            body:
              #"{"ok":true,"key":"bench/piece.webm","upload_state":"verified","ended_disagrees":"ended_disagrees"}"#
          )
        default:
          Issue.record("unexpected request \(request)")
          return stub(request, status: 404)
        }
      }

      let prepared = try await client.prepareDelivery(for: piece)
      guard case .upload(let putURL, let headURL, let key) = prepared else {
        Issue.record("expected upload URLs")
        return
      }
      #expect(key == "bench/piece.webm")
      #expect(try await client.probeDeliveryObject(at: headURL) == .present(byteCount: 3))
      try await client.putDeliveryObject(
        chunks: [Data([1]), Data([2, 3])],
        to: putURL,
        contentType: "audio/webm"
      )
      #expect(
        try await client.registerDelivery(piece)
          == ArchiveDeliveryRegistration(
            ok: true,
            key: "bench/piece.webm",
            uploadState: "verified",
            endedDisagrees: "ended_disagrees"
          ))
      #expect(
        methodsAndPaths == [
          "POST /api/bench/upload-url",
          "HEAD /piece-head",
          "PUT /piece",
          "POST /api/bench/chunks",
        ])
    }

    @Test func pieceHTTPFailureBoundsBodyAndSignalsRetention() async throws {
      let client = try makeClient()
      ContractURLProtocol.handler = { request in
        stub(request, status: 503, body: String(repeating: "x", count: 10_000))
      }

      do {
        _ = try await client.presign(makePiece(size: 3))
        Issue.record("expected HTTP error")
      } catch let BenchClientError.http(error) {
        #expect(error.statusCode == 503)
        #expect(error.body.utf8.count == BenchClient.maximumErrorBodyBytes)
        #expect(error.mustRetainLocalPiece)
      } catch {
        Issue.record("unexpected error \(error)")
      }
    }
  }

  private final class ContractURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
      do {
        let handler = try #require(Self.handler)
        let (response, data) = try handler(request)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !data.isEmpty { client?.urlProtocol(self, didLoad: data) }
        client?.urlProtocolDidFinishLoading(self)
      } catch {
        client?.urlProtocol(self, didFailWithError: error)
      }
    }

    override func stopLoading() {}
  }

  private func makeClient(cookie: String? = "signed.jwt") throws -> BenchClient {
    let sessionConfiguration = URLSessionConfiguration.ephemeral
    sessionConfiguration.protocolClasses = [ContractURLProtocol.self]
    sessionConfiguration.httpCookieStorage = nil
    sessionConfiguration.urlCache = nil
    return BenchClient(
      configuration: try makeConfiguration(cookie: cookie),
      session: URLSession(configuration: sessionConfiguration)
    )
  }

  private func makeConfiguration(cookie: String?) throws -> RoomConfiguration {
    try RoomConfiguration(
      origin: #require(URL(string: "https://eta.test")),
      roomSlug: "home-office",
      deviceUID: "device-stable-1",
      tapewriterPath: "/usr/local/bin/tapewriter",
      ffmpegPath: "/opt/homebrew/bin/ffmpeg",
      etaRoomSession: cookie,
      installID: "install_1",
      tabID: "app_device"
    )
  }

  private func makePiece(size: Int64) -> BenchPiece {
    BenchPiece(
      sessionID: "bs_a",
      index: 7,
      startedAt: "2026-08-27T10:00:00.000Z",
      endedAt: "2026-08-27T10:05:00.000Z",
      durationMS: 300_000,
      sizeBytes: size,
      gapBeforeMS: 0,
      peakLevel: 0.75,
      averageLevel: 0.125
    )
  }

  private func jsonObject(_ request: URLRequest) throws -> [String: Any] {
    let data = try requestBody(request)
    return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  private func requestBody(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody { return body }
    let stream = try #require(request.httpBodyStream)
    stream.open()
    defer { stream.close() }
    var result = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)
      guard count >= 0 else { throw try #require(stream.streamError) }
      if count == 0 { break }
      result.append(contentsOf: buffer.prefix(count))
    }
    return result
  }

  private func stub(
    _ request: URLRequest,
    status: Int = 200,
    body: String = #"{"ok":true}"#,
    headers: [String: String] = [:]
  ) -> (HTTPURLResponse, Data) {
    let response = HTTPURLResponse(
      url: request.url!,
      statusCode: status,
      httpVersion: "HTTP/1.1",
      headerFields: headers
    )!
    return (response, Data(body.utf8))
  }

  private func permissions(of url: URL) -> Int? {
    let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
    return (attributes?[.posixPermissions] as? NSNumber)?.intValue
  }
#endif
