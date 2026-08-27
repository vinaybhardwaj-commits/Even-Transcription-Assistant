#if canImport(RoomRecorderCore)
  import Foundation
  import Testing

  @testable import RoomRecorderCore

  @Suite struct RoomEngineTests {
    @Test func commandDecisionsPreserveBrowserIdempotenceAndConsentPause() {
      #expect(
        RoomCommandDecider.decide(kind: .startDay, phase: .recording)
          == .acknowledgeCurrentState)
      #expect(
        RoomCommandDecider.decide(kind: .startDay, phase: .paused)
          == .refuse("room_paused"))
      #expect(
        RoomCommandDecider.decide(kind: .startDay, phase: .paused, overridePause: true)
          == .resume)
      #expect(RoomCommandDecider.decide(kind: .pauseDay, phase: .recording) == .pause)
      #expect(
        RoomCommandDecider.decide(kind: .pauseDay, phase: .paused)
          == .acknowledgeCurrentState)
      #expect(RoomCommandDecider.decide(kind: .resumeDay, phase: .paused) == .resume)
      #expect(
        RoomCommandDecider.decide(kind: .resumeDay, phase: .recording)
          == .acknowledgeCurrentState)
      #expect(
        RoomCommandDecider.decide(kind: .pauseDay, phase: .ready)
          == .refuse("not_recording"))
      #expect(
        RoomCommandDecider.decide(kind: .resumeDay, phase: .ready)
          == .refuse("not_paused"))
      #expect(RoomCommandDecider.decide(kind: .endDay, phase: .paused) == .end)
      #expect(RoomCommandDecider.decide(kind: .endDay, phase: .failed) == .end)
      #expect(
        RoomCommandDecider.decide(kind: .endDay, phase: .ready)
          == .refuse("no_active_session"))
      #expect(
        RoomCommandDecider.decide(kind: .startDay, phase: .superseded)
          == .refuse("superseded"))
    }

    @Test func manifestBytesConvertExactlyToPrimaryBenchPiece() throws {
      let manifest = try RoomPieceManifest(
        sessionID: "bs_manifest",
        index: 12,
        segmentID: "seg_a",
        sampleStart: 4_800_000,
        sampleEnd: 9_600_000,
        startedAt: Date(timeIntervalSince1970: 1_800_000_000.125),
        endedAt: Date(timeIntervalSince1970: 1_800_000_300.125),
        durationMS: 300_000,
        gapBeforeMS: 275,
        sizeBytes: 1_234,
        filename: "bs_manifest_chunk_00012.webm"
      )
      let bytes = try manifest.encodedJSON()
      let raw = try #require(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
      let piece = try RoomManifestBenchAdapter.piece(manifestBytes: bytes)

      #expect(piece.sessionID == manifest.sessionID)
      #expect(piece.index == manifest.index)
      #expect(piece.startedAt == raw["started_at"] as? String)
      #expect(piece.endedAt == raw["ended_at"] as? String)
      #expect(piece.durationMS == 300_000)
      #expect(piece.gapBeforeMS == 275)
      #expect(piece.sizeBytes == 1_234)
      #expect(piece.contentType == "audio/webm")
      #expect(piece.source == .primary)
    }

    @Test func malformedManifestCannotBecomeUploadMetadata() {
      #expect(throws: (any Error).self) {
        try RoomManifestBenchAdapter.piece(manifestBytes: Data(#"{"session_id":"bs_x"}"#.utf8))
      }
    }

    @Test func pieceClockSurvivesPauseButNotANewSession() {
      let endedAt = Date(timeIntervalSince1970: 1_800_000_300)

      #expect(
        RoomSessionBoundary.retainedPieceEnd(
          currentSessionID: "bs_a", nextSessionID: "bs_a", pieceEndedAt: endedAt) == endedAt)
      #expect(
        RoomSessionBoundary.retainedPieceEnd(
          currentSessionID: "bs_a", nextSessionID: "bs_b", pieceEndedAt: endedAt) == nil)
      #expect(
        RoomSessionBoundary.retainedPieceEnd(
          currentSessionID: "bs_a", nextSessionID: nil, pieceEndedAt: endedAt) == nil)
    }

    @Test func processWaiterHandlesAChildThatAlreadyExited() throws {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/true")
      try process.run()
      Thread.sleep(forTimeInterval: 0.05)

      FoundationProcessWaiter.waitUntilExit(process, pollInterval: 0.001)

      #expect(!process.isRunning)
      #expect(process.terminationStatus == 0)
    }
  }
#endif
