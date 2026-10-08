#if canImport(RoomRecorderCore)
  import Foundation
  import RoomRecorderCore
  import Testing

  /// Arch #21. Swift was NOT compiled where this was written (no toolchain on the build box).
  @Suite struct SessionReapedNoticeTests {
    private func decode(_ json: String) throws -> CommandPollResponse {
      try JSONDecoder().decode(CommandPollResponse.self, from: Data(json.utf8))
    }

    @Test func pollDecodesSessionReapedNotice() throws {
      let r = try decode(
        #"{"ok":true,"room_id":"room_1","superseded":false,"commands":[],"session_reaped":{"session_id":"bs_x","ended_at":"2026-10-07T06:56:31.000Z"}}"#)
      #expect(r.sessionReaped == SessionReapedNotice(sessionID: "bs_x", endedAt: "2026-10-07T06:56:31.000Z"))
    }

    @Test func absentOrMalformedNoticeCostsOnlyTheNotice() throws {
      #expect(try decode(#"{"ok":true,"commands":[]}"#).sessionReaped == nil)
      let bad = try decode(#"{"ok":true,"commands":[],"session_reaped":"nope"}"#)
      #expect(bad.sessionReaped == nil)
      #expect(bad.ok)
    }

    @Test func onlyANoticeForTheActiveOpenSessionStops() {
      let n = SessionReapedNotice(sessionID: "bs_x", endedAt: nil)
      #expect(RoomEngine.shouldStopForReap(notice: n, activeSessionID: "bs_x", phase: .recording))
      #expect(RoomEngine.shouldStopForReap(notice: n, activeSessionID: "bs_x", phase: .paused))
      #expect(!RoomEngine.shouldStopForReap(notice: n, activeSessionID: "bs_y", phase: .recording))
      #expect(!RoomEngine.shouldStopForReap(notice: n, activeSessionID: nil, phase: .recording))
      #expect(!RoomEngine.shouldStopForReap(notice: n, activeSessionID: "bs_x", phase: .ready))
      #expect(!RoomEngine.shouldStopForReap(notice: nil, activeSessionID: "bs_x", phase: .recording))
    }
  }
#endif

#if canImport(RoomRecorderCore)
  import TapeCore

  /// Arch #21 refute rulings F1 and F2. Swift was NOT compiled where this was written.
  @Suite struct ReapedPieceHandlingTests {
    @Test func reapedSessionRegistrationStatesAreTerminalNotRetried() {
      #expect(ArchiveDeliveryCoordinator.isTerminalRegistration("verified"))
      #expect(ArchiveDeliveryCoordinator.isTerminalRegistration("rehomed_after_reap"))
      #expect(ArchiveDeliveryCoordinator.isTerminalRegistration("refused_session_reaped"))
      #expect(!ArchiveDeliveryCoordinator.isTerminalRegistration("pending"))
      #expect(!ArchiveDeliveryCoordinator.isTerminalRegistration(""))
    }

    @Test func aChunkReplyStopsOnlyTheSessionItIsAbout() {
      let flag: String? = "ended_disagrees"
      #expect(RoomEngine.shouldStopForChunkReply(pieceSessionID: "bs_a", activeSessionID: "bs_a", endedDisagrees: flag))
      // an older session's leftover piece while a new one records: never stops the live session
      #expect(!RoomEngine.shouldStopForChunkReply(pieceSessionID: "bs_old", activeSessionID: "bs_new", endedDisagrees: flag))
      #expect(!RoomEngine.shouldStopForChunkReply(pieceSessionID: "bs_a", activeSessionID: nil, endedDisagrees: flag))
      #expect(!RoomEngine.shouldStopForChunkReply(pieceSessionID: "bs_a", activeSessionID: "bs_a", endedDisagrees: nil))
    }
  }
#endif
