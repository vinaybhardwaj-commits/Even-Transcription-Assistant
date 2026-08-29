import Foundation
import Testing

@testable import TapeCore

@Suite struct ArchiveControlPayloadTests {
  @Test func goldenBytesRoundTripExactly() throws {
    let payload = try transition(
      commandID: "cmd_1",
      kind: .startDay,
      sessionID: nil,
      prior: nil,
      new: .startIntent,
      mono: 10,
      wall: 20
    )
    let expected = Data(
      (#"{"at_mono_ns":10,"at_wall_ns":20,"command_id":"cmd_1","command_kind":"start_day","error":null,"new_state":"start_intent","prior_state":null,"session_id":null}"#)
        .utf8
    )

    let encoded = try ArchiveControlPayloadCodec.encode(payload)
    #expect(encoded == expected)
    #expect(try ArchiveControlPayloadCodec.decode(encoded) == payload)
  }

  @Test func everyRatifiedSuccessChainReplays() throws {
    let chains: [(ArchiveControlCommandKind, [ArchiveControlState])] = [
      (
        .startDay,
        [.startIntent, .sessionOpened, .captureDurable, .startAckReady, .startAckObserved]
      ),
      (
        .pauseDay,
        [
          .pauseIntent, .laneBoundariesDurable, .pausePatched, .pauseAckReady,
          .pauseAckObserved,
        ]
      ),
      (
        .resumeDay,
        [
          .resumeIntent, .cleanSegmentOpened, .captureDurable, .resumePatched,
          .resumeAckReady, .resumeAckObserved,
        ]
      ),
      (
        .endDay,
        [
          .endIntent, .finalRangesReserved, .finalRangesVerified, .sessionEndPatched,
          .endAckReady, .endAckObserved,
        ]
      ),
      (
        .maintenanceHandoff,
        [.maintenanceHandoffIntent, .laneBoundariesDurable, .browserOwnerReady]
      ),
      (
        .maintenanceReclaim,
        [
          .maintenanceReclaimIntent, .serverIndicesReconciled, .cleanSegmentOpened,
          .captureDurable, .nativeOwnerReady,
        ]
      ),
    ]

    for (index, chain) in chains.enumerated() {
      let records = try self.chain(
        commandID: "cmd_\(index)",
        kind: chain.0,
        states: chain.1.map { ($0, nil) }
      )
      let replay = try ArchiveControlReplay.validate(records)
      #expect(replay["cmd_\(index)"]?.state == chain.1.last)
    }
  }

  @Test func compensationFailureAndAmbiguityChainsReplayExactly() throws {
    let startStates: [(ArchiveControlState, ArchiveControlFailure?)] = [
      (.startIntent, nil),
      (.sessionOpened, nil),
      (.startCompensationIntent, .noDurableGrowth),
      (.captureStopped, nil),
      (.sessionEndPatched, nil),
      (.startFailed, .noDurableGrowth),
      (.startFailureAckReady, nil),
      (.startFailureAckObserved, nil),
    ]
    let resumeStates: [(ArchiveControlState, ArchiveControlFailure?)] = [
      (.resumeIntent, nil),
      (.cleanSegmentOpened, nil),
      (.captureDurable, nil),
      (.resumeCompensationIntent, .sessionPatchFailed),
      (.captureStopped, nil),
      (.resumeFailed, .sessionPatchFailed),
      (.resumeFailureAckReady, nil),
      (.resumeFailureAckObserved, nil),
    ]
    let ambiguousStates: [(ArchiveControlState, ArchiveControlFailure?)] = [
      (.startIntent, nil),
      (.sessionOpenOutcomeUnobservable, .sessionOpenOutcomeUnobservable),
      (.startFailureAckReady, nil),
      (.startFailureAckOutcomeUnobservable, .ackOutcomeUnobservable),
    ]

    let start = try chain(commandID: "cmd_start", kind: .startDay, states: startStates)
    let resume = try chain(commandID: "cmd_resume", kind: .resumeDay, states: resumeStates)
    let ambiguous = try chain(
      commandID: "cmd_ambiguous",
      kind: .startDay,
      states: ambiguousStates
    )
    #expect(
      try ArchiveControlReplay.validate(start)["cmd_start"]?.state == .startFailureAckObserved)
    #expect(
      try ArchiveControlReplay.validate(resume)["cmd_resume"]?.state == .resumeFailureAckObserved)
    #expect(
      try ArchiveControlReplay.validate(ambiguous)["cmd_ambiguous"]?.state
        == .startFailureAckOutcomeUnobservable
    )
  }

  @Test func everyNamedFailureFamilyAndErrorValueIsFrozen() throws {
    #expect(
      Set(ArchiveControlCommandKind.allCases.map(\.rawValue)) == [
        "start_day", "pause_day", "resume_day", "end_day", "maintenance_handoff",
        "maintenance_reclaim", "capture_session_binding", "server_ended_finalization",
        "rollover_preparation", "rollover",
      ])
    #expect(
      Set(ArchiveControlFailure.allCases.map(\.rawValue)) == [
        "command_refused", "session_open_failed", "no_durable_growth", "session_patch_failed",
        "final_verification_failed", "authentication_failed", "command_expired",
        "maintenance_failed", "internal_io_failed", "session_open_outcome_unobservable",
        "ack_outcome_unobservable",
      ])

    let chains:
      [(
        String, ArchiveControlCommandKind, [(ArchiveControlState, ArchiveControlFailure?)]
      )] = [
        (
          "start",
          .startDay,
          [
            (.startIntent, nil), (.startFailed, .sessionOpenFailed),
            (.startFailureAckReady, nil), (.startFailureAckObserved, nil),
          ]
        ),
        (
          "pause",
          .pauseDay,
          [
            (.pauseIntent, nil), (.laneBoundariesDurable, nil),
            (.pauseFailed, .sessionPatchFailed), (.pauseFailureAckReady, nil),
            (.pauseFailureAckOutcomeUnobservable, .ackOutcomeUnobservable),
          ]
        ),
        (
          "resume",
          .resumeDay,
          [
            (.resumeIntent, nil), (.resumeFailed, .authenticationFailed),
            (.resumeFailureAckReady, nil), (.resumeFailureAckObserved, nil),
          ]
        ),
        (
          "end",
          .endDay,
          [
            (.endIntent, nil), (.finalRangesReserved, nil),
            (.endFailed, .finalVerificationFailed), (.endFailureAckReady, nil),
            (.endFailureAckOutcomeUnobservable, .ackOutcomeUnobservable),
          ]
        ),
        (
          "handoff",
          .maintenanceHandoff,
          [
            (.maintenanceHandoffIntent, nil),
            (.maintenanceHandoffFailed, .maintenanceFailed),
            (.maintenanceHandoffFailureAckReady, nil),
            (.maintenanceHandoffFailureAckObserved, nil),
          ]
        ),
        (
          "reclaim",
          .maintenanceReclaim,
          [
            (.maintenanceReclaimIntent, nil), (.serverIndicesReconciled, nil),
            (.maintenanceReclaimFailed, .commandExpired),
            (.maintenanceReclaimFailureAckReady, nil),
            (
              .maintenanceReclaimFailureAckOutcomeUnobservable,
              .ackOutcomeUnobservable
            ),
          ]
        ),
        (
          "rollover",
          .rollover,
          [
            (.rolloverIntent, nil), (.oldDayFinalReserved, nil),
            (.rolloverFailed, .internalIOFailed),
          ]
        ),
      ]
    for value in chains {
      let payloads = try chain(commandID: "cmd_\(value.0)", kind: value.1, states: value.2)
      #expect(try ArchiveControlReplay.validate(payloads).count == 1)
    }
  }

  @Test func activeSessionIsTrackedAcrossCommandsAndClearedOnlyByEndPatch() throws {
    let start = try chain(
      commandID: "cmd_start",
      kind: .startDay,
      states: [
        (.startIntent, nil), (.sessionOpened, nil), (.captureDurable, nil),
        (.startAckReady, nil), (.startAckObserved, nil),
      ]
    )
    let pause = try chain(
      commandID: "cmd_pause",
      kind: .pauseDay,
      states: [(.pauseIntent, nil), (.laneBoundariesDurable, nil), (.pausePatched, nil)]
    )
    let end = try chain(
      commandID: "cmd_end",
      kind: .endDay,
      states: [
        (.endIntent, nil), (.finalRangesReserved, nil), (.finalRangesVerified, nil),
        (.sessionEndPatched, nil), (.endAckReady, nil), (.endAckObserved, nil),
      ]
    )
    let nextStart = try chain(
      commandID: "cmd_next",
      kind: .startDay,
      states: [(.startIntent, nil), (.sessionOpened, nil)],
      sessionID: "bs_2"
    )
    let replay = try ArchiveControlReplay.validate(start + pause + end + nextStart)
    #expect(replay["cmd_next"]?.sessionID == "bs_2")

    let secondOpen = try chain(
      commandID: "cmd_second",
      kind: .startDay,
      states: [(.startIntent, nil), (.sessionOpened, nil)],
      sessionID: "bs_2"
    )
    #expect(throws: ArchiveControlPayloadError.self) {
      try ArchiveControlReplay.validate(start + secondOpen)
    }
  }

  @Test func serverEndedFinalizationConvergesAnExactActiveOrHistoricalSession() throws {
    let start = try chain(
      commandID: "cmd_start",
      kind: .startDay,
      states: [(.startIntent, nil), (.sessionOpened, nil), (.captureDurable, nil)])
    let finalized = try chain(
      commandID: "local_server_ended",
      kind: .serverEndedFinalization,
      states: [(.serverEndedFinalized, nil)])
    let nextStart = try chain(
      commandID: "cmd_next",
      kind: .startDay,
      states: [(.startIntent, nil), (.sessionOpened, nil)],
      sessionID: "bs_2")

    #expect(try ArchiveControlReplay.validate(start + finalized + nextStart).count == 3)
    #expect(try ArchiveControlReplay.validate(finalized).count == 1)
    let other = try chain(
      commandID: "local_server_ended_other",
      kind: .serverEndedFinalization,
      states: [(.serverEndedFinalized, nil)],
      sessionID: "bs_other")
    #expect(throws: ArchiveControlPayloadError.self) {
      try ArchiveControlReplay.validate(start + other)
    }
  }

  @Test func freshDayCarriesOneExistingSessionAndRejectsCrossCommandDivergence() throws {
    let carriedPause = try chain(
      commandID: "cmd_pause",
      kind: .pauseDay,
      states: [(.pauseIntent, nil), (.laneBoundariesDurable, nil)]
    )
    let sameSessionResume = try chain(
      commandID: "cmd_resume",
      kind: .resumeDay,
      states: [(.resumeIntent, nil), (.cleanSegmentOpened, nil)]
    )
    let replay = try ArchiveControlReplay.validate(carriedPause + sameSessionResume)
    #expect(replay.count == 2)

    let divergentRollover = try chain(
      commandID: "cmd_rollover",
      kind: .rollover,
      states: [(.rolloverIntent, nil)],
      sessionID: "bs_other"
    )
    #expect(throws: ArchiveControlPayloadError.self) {
      try ArchiveControlReplay.validate(carriedPause + divergentRollover)
    }
  }

  @Test func illegalTransitionsErrorsAndReplayHistoryAreRejected() throws {
    #expect(throws: ArchiveControlPayloadError.self) {
      try transition(kind: .startDay, prior: .startIntent, new: .pausePatched)
    }
    #expect(throws: ArchiveControlPayloadError.self) {
      try transition(
        kind: .startDay,
        prior: .startIntent,
        new: .sessionOpenOutcomeUnobservable,
        error: .authenticationFailed
      )
    }
    #expect(throws: ArchiveControlPayloadError.self) {
      try transition(
        kind: .rollover,
        prior: .rolloverIntent,
        new: .rolloverFailed,
        error: .maintenanceFailed
      )
    }

    let intent = try transition(
      kind: .startDay, sessionID: nil, prior: nil, new: .startIntent)
    let skipped = try transition(
      kind: .startDay,
      prior: .sessionOpened,
      new: .captureDurable
    )
    #expect(throws: ArchiveControlPayloadError.self) {
      try ArchiveControlReplay.validate([intent, skipped])
    }

    let changedKind = try transition(
      commandID: intent.commandID,
      kind: .pauseDay,
      prior: nil,
      new: .pauseIntent
    )
    #expect(throws: ArchiveControlPayloadError.self) {
      try ArchiveControlReplay.validate([intent, changedKind])
    }

    #expect(throws: ArchiveControlPayloadError.self) {
      try transition(
        kind: .startDay,
        sessionID: nil,
        prior: .startIntent,
        new: .startFailed,
        error: .noDurableGrowth
      )
    }
    #expect(throws: ArchiveControlPayloadError.self) {
      try transition(kind: .pauseDay, sessionID: nil, prior: nil, new: .pauseIntent)
    }

    let opened = try chain(
      commandID: "cmd_session",
      kind: .startDay,
      states: [(.startIntent, nil), (.sessionOpened, nil)]
    )
    let nullAfterKnown = try transition(
      commandID: "cmd_session",
      kind: .startDay,
      sessionID: nil,
      prior: .sessionOpened,
      new: .captureDurable,
      mono: 3,
      wall: 3
    )
    #expect(throws: ArchiveControlPayloadError.self) {
      try ArchiveControlReplay.validate(opened + [nullAfterKnown])
    }
    let changedSession = try transition(
      commandID: "cmd_session",
      kind: .startDay,
      sessionID: "bs_other",
      prior: .sessionOpened,
      new: .captureDurable,
      mono: 3,
      wall: 3
    )
    #expect(throws: ArchiveControlPayloadError.self) {
      try ArchiveControlReplay.validate(opened + [changedSession])
    }
    let regressed = try transition(
      commandID: "cmd_session",
      kind: .startDay,
      sessionID: "bs_1",
      prior: .sessionOpened,
      new: .captureDurable,
      mono: 1,
      wall: 3
    )
    #expect(throws: ArchiveControlPayloadError.self) {
      try ArchiveControlReplay.validate(opened + [regressed])
    }
  }

  @Test func malformedAndNoncanonicalPayloadsAreRejected() throws {
    let encoded = try ArchiveControlPayloadCodec.encode(
      transition(kind: .startDay, sessionID: nil, prior: nil, new: .startIntent)
    )
    for malformed in [
      replacing(encoded, "\"command_id\"", with: "\"unknown\""),
      replacing(encoded, "\"start_day\"", with: "\"stop_day\""),
      replacing(encoded, "\"start_intent\"", with: "\"starting\""),
      replacing(encoded, "\"at_mono_ns\":1", with: "\"at_mono_ns\":01"),
      replacing(encoded, ",\"error\":null", with: ""),
      replacing(encoded, "}", with: ",\"extra\":null}"),
      replacing(
        encoded,
        "{\"at_mono_ns\":1,\"at_wall_ns\":2",
        with: "{\"at_wall_ns\":2,\"at_mono_ns\":1"
      ),
      replacing(encoded, "\"at_mono_ns\":1", with: "\"at_mono_ns\":18446744073709551616"),
      encoded + Data([0x0A]),
    ] {
      #expect(throws: ArchiveControlPayloadError.self) {
        try ArchiveControlPayloadCodec.decode(malformed)
      }
    }
  }

  @Test func captureSessionBindingCodecAndReplayFreezeExactDailyAuthority() throws {
    let identity = try ArchiveDailyLaneIdentity(
      context: ArchiveContext(
        streamUUID: Data([
          0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x46, 0x77,
          0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF,
        ]),
        roomID: "room_1",
        istDate: "2026-08-28",
        laneID: "primary",
        stableDeviceUID: "device_1"),
      expectedInitialSessionSample: 4_000,
      keywrapDigestHex: String(repeating: "a", count: 64))
    let binding = try ArchiveCaptureSessionBinding(
      sessionID: "bs_1",
      primaryIdentity: identity,
      sessionSampleStart: 1_000,
      segmentSampleStart: 4_000)
    let encoded = try ArchiveCaptureSessionBindingCodec.encode(binding)
    #expect(try ArchiveCaptureSessionBindingCodec.decode(encoded) == binding)
    let payload = try ArchiveControlPayload(
      commandID: binding.commandID,
      commandKind: .captureSessionBinding,
      sessionID: binding.sessionID,
      priorState: nil,
      newState: .captureSessionBound,
      atMonoNS: 10,
      atWallNS: 20,
      error: nil,
      captureSessionBinding: binding)
    let controlBytes = try ArchiveControlPayloadCodec.encode(payload)
    #expect(try ArchiveControlPayloadCodec.decode(controlBytes) == payload)
    #expect(
      try ArchiveControlReplay.validate([payload])[binding.commandID]?.captureSessionBinding
        == binding)

    var tampered = encoded
    tampered[tampered.index(before: tampered.endIndex)] ^= 1
    #expect(throws: ArchiveCaptureSessionBindingError.self) {
      try ArchiveCaptureSessionBindingCodec.decode(tampered)
    }
  }

  @Test func exactEnvelopeValidatorRejectsWrongPurposeRangeAndOrdinal() throws {
    let plaintext = try ArchiveControlPayloadCodec.encode(
      transition(kind: .rollover, prior: nil, new: .rolloverIntent)
    )
    let valid = record(
      purpose: .control,
      sequence: 1,
      firstLogicalUnit: 0,
      logicalUnitCount: 1,
      plaintext: plaintext
    )
    try ArchiveControlPayloadCodec.validateRecord(valid)

    for invalid in [
      record(
        purpose: .journal,
        sequence: 1,
        firstLogicalUnit: 0,
        logicalUnitCount: 1,
        plaintext: plaintext
      ),
      record(
        purpose: .control,
        sequence: 1,
        firstLogicalUnit: 0,
        logicalUnitCount: 2,
        plaintext: plaintext
      ),
      record(
        purpose: .control,
        sequence: 3,
        firstLogicalUnit: 1,
        logicalUnitCount: 1,
        plaintext: plaintext
      ),
    ] {
      #expect(throws: ArchiveControlPayloadError.invalidEnvelope) {
        try ArchiveControlPayloadCodec.validateRecord(invalid)
      }
    }
  }

  private func chain(
    commandID: String,
    kind: ArchiveControlCommandKind,
    states: [(ArchiveControlState, ArchiveControlFailure?)],
    sessionID: String = "bs_1"
  ) throws -> [ArchiveControlPayload] {
    var sessionKnown = kind != .startDay
    return try states.enumerated().map { index, value in
      if value.0 == .sessionOpened { sessionKnown = true }
      return try transition(
        commandID: commandID,
        kind: kind,
        sessionID: sessionKnown ? sessionID : nil,
        prior: index == 0 ? nil : states[index - 1].0,
        new: value.0,
        mono: UInt64(index + 1),
        wall: UInt64(index + 1),
        error: value.1
      )
    }
  }

  private func transition(
    commandID: String = "cmd_1",
    kind: ArchiveControlCommandKind,
    sessionID: String? = "bs_1",
    prior: ArchiveControlState?,
    new: ArchiveControlState,
    mono: UInt64 = 1,
    wall: UInt64 = 2,
    error: ArchiveControlFailure? = nil
  ) throws -> ArchiveControlPayload {
    try ArchiveControlPayload(
      commandID: commandID,
      commandKind: kind,
      sessionID: sessionID,
      priorState: prior,
      newState: new,
      atMonoNS: mono,
      atWallNS: wall,
      error: error
    )
  }

  private func replacing(_ data: Data, _ target: String, with replacement: String) -> Data {
    Data(
      String(decoding: data, as: UTF8.self).replacingOccurrences(of: target, with: replacement).utf8
    )
  }

  private func record(
    purpose: ArchiveRecordPurpose,
    sequence: UInt64,
    firstLogicalUnit: UInt64,
    logicalUnitCount: UInt32,
    plaintext: Data
  ) -> ArchiveDerivedRecord {
    ArchiveDerivedRecord(
      header: ArchiveEnvelopeHeader(
        purpose: purpose,
        streamUUID: Data(repeating: 0, count: 16),
        recordSequence: sequence,
        firstLogicalUnit: firstLogicalUnit,
        logicalUnitCount: logicalUnitCount,
        plaintextByteCount: UInt32(plaintext.count),
        nonce: Data(repeating: 0, count: 12),
        previousCommittedTag: Data(repeating: 0, count: 16),
        contextHash: Data(repeating: 0, count: 32)
      ),
      plaintext: plaintext,
      authenticationTag: Data(repeating: 0, count: 16),
      encryptedStartOffset: 0,
      encryptedEndOffset: 0
    )
  }
}
