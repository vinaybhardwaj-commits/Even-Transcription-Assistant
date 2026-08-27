import Foundation

public enum ArchiveControlCommandKind: String, CaseIterable, Equatable, Sendable {
  case startDay = "start_day"
  case pauseDay = "pause_day"
  case resumeDay = "resume_day"
  case endDay = "end_day"
  case maintenanceHandoff = "maintenance_handoff"
  case maintenanceReclaim = "maintenance_reclaim"
  case rollover
}

public enum ArchiveControlState: String, CaseIterable, Equatable, Hashable, Sendable {
  case startIntent = "start_intent"
  case sessionOpened = "session_opened"
  case captureDurable = "capture_durable"
  case startAckReady = "start_ack_ready"
  case startAckObserved = "start_ack_observed"
  case startFailed = "start_failed"
  case startFailureAckReady = "start_failure_ack_ready"
  case startFailureAckObserved = "start_failure_ack_observed"
  case startCompensationIntent = "start_compensation_intent"
  case captureStopped = "capture_stopped"
  case sessionEndPatched = "session_end_patched"
  case sessionOpenOutcomeUnobservable = "session_open_outcome_unobservable"
  case startAckOutcomeUnobservable = "start_ack_outcome_unobservable"
  case startFailureAckOutcomeUnobservable = "start_failure_ack_outcome_unobservable"

  case pauseIntent = "pause_intent"
  case laneBoundariesDurable = "lane_boundaries_durable"
  case pausePatched = "pause_patched"
  case pauseAckReady = "pause_ack_ready"
  case pauseAckObserved = "pause_ack_observed"
  case pauseFailed = "pause_failed"
  case pauseFailureAckReady = "pause_failure_ack_ready"
  case pauseFailureAckObserved = "pause_failure_ack_observed"
  case pauseAckOutcomeUnobservable = "pause_ack_outcome_unobservable"
  case pauseFailureAckOutcomeUnobservable = "pause_failure_ack_outcome_unobservable"

  case resumeIntent = "resume_intent"
  case cleanSegmentOpened = "clean_segment_opened"
  case resumePatched = "resume_patched"
  case resumeAckReady = "resume_ack_ready"
  case resumeAckObserved = "resume_ack_observed"
  case resumeCompensationIntent = "resume_compensation_intent"
  case resumeFailed = "resume_failed"
  case resumeFailureAckReady = "resume_failure_ack_ready"
  case resumeFailureAckObserved = "resume_failure_ack_observed"
  case resumeAckOutcomeUnobservable = "resume_ack_outcome_unobservable"
  case resumeFailureAckOutcomeUnobservable = "resume_failure_ack_outcome_unobservable"

  case endIntent = "end_intent"
  case finalRangesReserved = "final_ranges_reserved"
  case finalRangesVerified = "final_ranges_verified"
  case endAckReady = "end_ack_ready"
  case endAckObserved = "end_ack_observed"
  case endFailed = "end_failed"
  case endFailureAckReady = "end_failure_ack_ready"
  case endFailureAckObserved = "end_failure_ack_observed"
  case endAckOutcomeUnobservable = "end_ack_outcome_unobservable"
  case endFailureAckOutcomeUnobservable = "end_failure_ack_outcome_unobservable"

  case maintenanceHandoffIntent = "maintenance_handoff_intent"
  case browserOwnerReady = "browser_owner_ready"
  case maintenanceHandoffFailed = "maintenance_handoff_failed"
  case maintenanceHandoffFailureAckReady = "maintenance_handoff_failure_ack_ready"
  case maintenanceHandoffFailureAckObserved = "maintenance_handoff_failure_ack_observed"
  case maintenanceHandoffFailureAckOutcomeUnobservable =
    "maintenance_handoff_failure_ack_outcome_unobservable"

  case maintenanceReclaimIntent = "maintenance_reclaim_intent"
  case serverIndicesReconciled = "server_indices_reconciled"
  case nativeOwnerReady = "native_owner_ready"
  case maintenanceReclaimFailed = "maintenance_reclaim_failed"
  case maintenanceReclaimFailureAckReady = "maintenance_reclaim_failure_ack_ready"
  case maintenanceReclaimFailureAckObserved = "maintenance_reclaim_failure_ack_observed"
  case maintenanceReclaimFailureAckOutcomeUnobservable =
    "maintenance_reclaim_failure_ack_outcome_unobservable"

  case rolloverIntent = "rollover_intent"
  case oldDayFinalReserved = "old_day_final_reserved"
  case oldDayFilesClosed = "old_day_files_closed"
  case newDayFilesDurable = "new_day_files_durable"
  case rolloverComplete = "rollover_complete"
  case rolloverFailed = "rollover_failed"
}

public enum ArchiveControlFailure: String, CaseIterable, Equatable, Sendable {
  case sessionOpenFailed = "session_open_failed"
  case noDurableGrowth = "no_durable_growth"
  case sessionPatchFailed = "session_patch_failed"
  case finalVerificationFailed = "final_verification_failed"
  case authenticationFailed = "authentication_failed"
  case commandExpired = "command_expired"
  case maintenanceFailed = "maintenance_failed"
  case internalIOFailed = "internal_io_failed"
  case sessionOpenOutcomeUnobservable = "session_open_outcome_unobservable"
  case ackOutcomeUnobservable = "ack_outcome_unobservable"
}

public enum ArchiveControlPayloadError: Error, Equatable, Sendable {
  case invalidID(String)
  case unknownCommandKind(String)
  case unknownState(String)
  case unknownError(String)
  case invalidTransition(
    commandKind: ArchiveControlCommandKind,
    priorState: ArchiveControlState?,
    newState: ArchiveControlState
  )
  case invalidError(
    commandKind: ArchiveControlCommandKind,
    state: ArchiveControlState,
    error: ArchiveControlFailure?
  )
  case replayStateMismatch(
    commandID: String,
    expected: ArchiveControlState?,
    actual: ArchiveControlState?
  )
  case replayCommandKindMismatch(commandID: String)
  case replaySessionMismatch(commandID: String)
  case replayActiveSessionMismatch(commandID: String, expected: String?, actual: String?)
  case replaySessionAlreadyActive(commandID: String, activeSessionID: String)
  case replayTimestampRegression(commandID: String)
  case integerOverflow(field: String)
  case invalidSyntax(offset: Int)
  case invalidEnvelope
  case payloadTooLarge(Int)
}

public struct ArchiveControlPayload: Equatable, Sendable {
  public let commandID: String
  public let commandKind: ArchiveControlCommandKind
  public let sessionID: String?
  public let priorState: ArchiveControlState?
  public let newState: ArchiveControlState
  public let atMonoNS: UInt64
  public let atWallNS: UInt64
  public let error: ArchiveControlFailure?

  public init(
    commandID: String,
    commandKind: ArchiveControlCommandKind,
    sessionID: String?,
    priorState: ArchiveControlState?,
    newState: ArchiveControlState,
    atMonoNS: UInt64,
    atWallNS: UInt64,
    error: ArchiveControlFailure?
  ) throws {
    guard Self.validID(commandID) else {
      throw ArchiveControlPayloadError.invalidID("command_id")
    }
    if let sessionID, !Self.validID(sessionID) {
      throw ArchiveControlPayloadError.invalidID("session_id")
    }
    if priorState == nil {
      if commandKind == .startDay {
        guard sessionID == nil else {
          throw ArchiveControlPayloadError.replaySessionMismatch(commandID: commandID)
        }
      } else {
        guard sessionID != nil else {
          throw ArchiveControlPayloadError.replaySessionMismatch(commandID: commandID)
        }
      }
    }
    if newState == .sessionOpened, sessionID == nil {
      throw ArchiveControlPayloadError.replaySessionMismatch(commandID: commandID)
    }
    try ArchiveControlTransition.validate(
      commandKind: commandKind,
      priorState: priorState,
      newState: newState,
      error: error
    )

    self.commandID = commandID
    self.commandKind = commandKind
    self.sessionID = sessionID
    self.priorState = priorState
    self.newState = newState
    self.atMonoNS = atMonoNS
    self.atWallNS = atWallNS
    self.error = error
    try ArchiveControlPayloadCodec.validateEncodedSize(self)
  }

  private static func validID(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 256
  }
}

public struct ArchiveControlReplayCommand: Equatable, Sendable {
  public let commandKind: ArchiveControlCommandKind
  public let sessionID: String?
  public let state: ArchiveControlState
  public let atMonoNS: UInt64
  public let atWallNS: UInt64
}

public enum ArchiveControlReplay {
  public static func validate(_ payloads: [ArchiveControlPayload]) throws
    -> [String: ArchiveControlReplayCommand]
  {
    var commands: [String: ArchiveControlReplayCommand] = [:]
    var activeSessionID: String?
    var carriedSessionEstablished = false
    var sawStartHistory = false
    var terminallyEndedCommands: Set<String> = []
    for payload in payloads {
      let previous = commands[payload.commandID]
      if let previous {
        guard previous.commandKind == payload.commandKind else {
          throw ArchiveControlPayloadError.replayCommandKindMismatch(commandID: payload.commandID)
        }
        guard payload.priorState == previous.state else {
          throw ArchiveControlPayloadError.replayStateMismatch(
            commandID: payload.commandID,
            expected: previous.state,
            actual: payload.priorState
          )
        }
        guard payload.atMonoNS >= previous.atMonoNS, payload.atWallNS >= previous.atWallNS else {
          throw ArchiveControlPayloadError.replayTimestampRegression(commandID: payload.commandID)
        }
        if let previousSessionID = previous.sessionID {
          guard payload.sessionID == previousSessionID else {
            throw ArchiveControlPayloadError.replaySessionMismatch(commandID: payload.commandID)
          }
        } else if payload.newState == .sessionOpened {
          guard payload.sessionID != nil else {
            throw ArchiveControlPayloadError.replaySessionMismatch(commandID: payload.commandID)
          }
        } else if payload.sessionID != nil {
          throw ArchiveControlPayloadError.replaySessionMismatch(commandID: payload.commandID)
        }
      } else {
        guard payload.priorState == nil else {
          throw ArchiveControlPayloadError.replayStateMismatch(
            commandID: payload.commandID,
            expected: nil,
            actual: payload.priorState
          )
        }
      }

      if payload.commandKind == .startDay { sawStartHistory = true }
      let commandAlreadyEnded = terminallyEndedCommands.contains(payload.commandID)
      if payload.commandKind == .startDay {
        if payload.newState == .sessionOpened {
          guard let sessionID = payload.sessionID else {
            throw ArchiveControlPayloadError.replaySessionMismatch(commandID: payload.commandID)
          }
          guard activeSessionID == nil else {
            throw ArchiveControlPayloadError.replaySessionAlreadyActive(
              commandID: payload.commandID,
              activeSessionID: activeSessionID!
            )
          }
          activeSessionID = sessionID
        } else if !commandAlreadyEnded, let sessionID = payload.sessionID {
          guard activeSessionID == sessionID else {
            throw ArchiveControlPayloadError.replayActiveSessionMismatch(
              commandID: payload.commandID,
              expected: activeSessionID,
              actual: sessionID
            )
          }
        }
      } else {
        if previous == nil, activeSessionID == nil {
          guard !sawStartHistory, !carriedSessionEstablished else {
            throw ArchiveControlPayloadError.replayActiveSessionMismatch(
              commandID: payload.commandID,
              expected: nil,
              actual: payload.sessionID
            )
          }
          activeSessionID = payload.sessionID
          carriedSessionEstablished = true
        }
        if !commandAlreadyEnded {
          guard let activeSessionID, payload.sessionID == activeSessionID else {
            throw ArchiveControlPayloadError.replayActiveSessionMismatch(
              commandID: payload.commandID,
              expected: activeSessionID,
              actual: payload.sessionID
            )
          }
        }
      }

      if payload.newState == .sessionEndPatched,
        payload.commandKind == .startDay || payload.commandKind == .endDay
      {
        guard payload.sessionID == activeSessionID else {
          throw ArchiveControlPayloadError.replayActiveSessionMismatch(
            commandID: payload.commandID,
            expected: activeSessionID,
            actual: payload.sessionID
          )
        }
        activeSessionID = nil
        terminallyEndedCommands.insert(payload.commandID)
      }

      commands[payload.commandID] = ArchiveControlReplayCommand(
        commandKind: payload.commandKind,
        sessionID: previous?.sessionID ?? payload.sessionID,
        state: payload.newState,
        atMonoNS: payload.atMonoNS,
        atWallNS: payload.atWallNS
      )
    }
    return commands
  }
}

public enum ArchiveControlPayloadCodec {
  public static func encode(_ payload: ArchiveControlPayload) throws -> Data {
    var result = Data()
    result.append(contentsOf: "{\"at_mono_ns\":".utf8)
    ArchiveCanonicalJSON.appendInteger(payload.atMonoNS, to: &result)
    result.append(contentsOf: ",\"at_wall_ns\":".utf8)
    ArchiveCanonicalJSON.appendInteger(payload.atWallNS, to: &result)
    result.append(contentsOf: ",\"command_id\":".utf8)
    ArchiveCanonicalJSON.appendString(payload.commandID, to: &result)
    result.append(contentsOf: ",\"command_kind\":".utf8)
    ArchiveCanonicalJSON.appendString(payload.commandKind.rawValue, to: &result)
    result.append(contentsOf: ",\"error\":".utf8)
    ArchiveCanonicalJSON.appendOptionalString(payload.error?.rawValue, to: &result)
    result.append(contentsOf: ",\"new_state\":".utf8)
    ArchiveCanonicalJSON.appendString(payload.newState.rawValue, to: &result)
    result.append(contentsOf: ",\"prior_state\":".utf8)
    ArchiveCanonicalJSON.appendOptionalString(payload.priorState?.rawValue, to: &result)
    result.append(contentsOf: ",\"session_id\":".utf8)
    ArchiveCanonicalJSON.appendOptionalString(payload.sessionID, to: &result)
    result.append(0x7D)
    guard result.count <= Int(ArchiveRecordPurpose.control.maximumPlaintextByteCount) else {
      throw ArchiveControlPayloadError.payloadTooLarge(result.count)
    }
    return result
  }

  public static func decode(_ data: Data) throws -> ArchiveControlPayload {
    guard data.count <= Int(ArchiveRecordPurpose.control.maximumPlaintextByteCount) else {
      throw ArchiveControlPayloadError.payloadTooLarge(data.count)
    }
    var parser = ArchiveCanonicalJSONParser(data)
    do {
      try parser.expect("{\"at_mono_ns\":")
      let atMonoNS = try parser.integer(field: "at_mono_ns")
      try parser.expect(",\"at_wall_ns\":")
      let atWallNS = try parser.integer(field: "at_wall_ns")
      try parser.expect(",\"command_id\":")
      let commandID = try parser.string()
      try parser.expect(",\"command_kind\":")
      let commandKindRaw = try parser.string()
      guard let commandKind = ArchiveControlCommandKind(rawValue: commandKindRaw) else {
        throw ArchiveControlPayloadError.unknownCommandKind(commandKindRaw)
      }
      try parser.expect(",\"error\":")
      let errorRaw = try parser.optionalString()
      let error: ArchiveControlFailure?
      if let errorRaw {
        guard let value = ArchiveControlFailure(rawValue: errorRaw) else {
          throw ArchiveControlPayloadError.unknownError(errorRaw)
        }
        error = value
      } else {
        error = nil
      }
      try parser.expect(",\"new_state\":")
      let newStateRaw = try parser.string()
      guard let newState = ArchiveControlState(rawValue: newStateRaw) else {
        throw ArchiveControlPayloadError.unknownState(newStateRaw)
      }
      try parser.expect(",\"prior_state\":")
      let priorStateRaw = try parser.optionalString()
      let priorState: ArchiveControlState?
      if let priorStateRaw {
        guard let value = ArchiveControlState(rawValue: priorStateRaw) else {
          throw ArchiveControlPayloadError.unknownState(priorStateRaw)
        }
        priorState = value
      } else {
        priorState = nil
      }
      try parser.expect(",\"session_id\":")
      let sessionID = try parser.optionalString()
      try parser.expect("}")
      try parser.expectEnd()
      let payload = try ArchiveControlPayload(
        commandID: commandID,
        commandKind: commandKind,
        sessionID: sessionID,
        priorState: priorState,
        newState: newState,
        atMonoNS: atMonoNS,
        atWallNS: atWallNS,
        error: error
      )
      guard try encode(payload) == data else {
        throw ArchiveControlPayloadError.invalidSyntax(offset: 0)
      }
      return payload
    } catch ArchiveCanonicalJSONError.invalidSyntax(let offset) {
      throw ArchiveControlPayloadError.invalidSyntax(offset: offset)
    } catch ArchiveCanonicalJSONError.integerOverflow(let field) {
      throw ArchiveControlPayloadError.integerOverflow(field: field)
    }
  }

  public static func validateRecord(_ record: ArchiveDerivedRecord) throws {
    guard record.header.purpose == .control, record.header.logicalUnitCount == 1,
      UInt64(record.header.plaintextByteCount) == UInt64(record.plaintext.count),
      record.header.recordSequence > 0,
      record.header.firstLogicalUnit == record.header.recordSequence - 1
    else {
      throw ArchiveControlPayloadError.invalidEnvelope
    }
    _ = try decode(record.plaintext)
  }

  fileprivate static func validateEncodedSize(_ payload: ArchiveControlPayload) throws {
    _ = try encode(payload)
  }
}

private enum ArchiveControlTransition {
  private struct Edge: Hashable {
    let prior: ArchiveControlState?
    let new: ArchiveControlState
  }

  static func validate(
    commandKind: ArchiveControlCommandKind,
    priorState: ArchiveControlState?,
    newState: ArchiveControlState,
    error: ArchiveControlFailure?
  ) throws {
    guard edges(for: commandKind).contains(Edge(prior: priorState, new: newState)) else {
      throw ArchiveControlPayloadError.invalidTransition(
        commandKind: commandKind,
        priorState: priorState,
        newState: newState
      )
    }
    guard
      valid(
        error: error,
        priorState: priorState,
        newState: newState,
        commandKind: commandKind
      )
    else {
      throw ArchiveControlPayloadError.invalidError(
        commandKind: commandKind,
        state: newState,
        error: error
      )
    }
  }

  private static func valid(
    error: ArchiveControlFailure?,
    priorState: ArchiveControlState?,
    newState: ArchiveControlState,
    commandKind: ArchiveControlCommandKind
  ) -> Bool {
    switch newState {
    case .sessionOpenOutcomeUnobservable:
      return error == .sessionOpenOutcomeUnobservable
    case .startAckOutcomeUnobservable, .startFailureAckOutcomeUnobservable,
      .pauseAckOutcomeUnobservable, .pauseFailureAckOutcomeUnobservable,
      .resumeAckOutcomeUnobservable, .resumeFailureAckOutcomeUnobservable,
      .endAckOutcomeUnobservable, .endFailureAckOutcomeUnobservable,
      .maintenanceHandoffFailureAckOutcomeUnobservable,
      .maintenanceReclaimFailureAckOutcomeUnobservable:
      return error == .ackOutcomeUnobservable
    case .startCompensationIntent:
      return error == .noDurableGrowth
    case .resumeCompensationIntent:
      return error == .sessionPatchFailed
    case .startFailed, .pauseFailed, .resumeFailed, .endFailed,
      .maintenanceHandoffFailed, .maintenanceReclaimFailed, .rolloverFailed:
      return allowedFailure(
        error,
        commandKind: commandKind,
        priorState: priorState,
        newState: newState
      )
    default:
      return error == nil
    }
  }

  private static func allowedFailure(
    _ error: ArchiveControlFailure?,
    commandKind: ArchiveControlCommandKind,
    priorState: ArchiveControlState?,
    newState: ArchiveControlState
  ) -> Bool {
    guard let error else { return false }
    let authenticationOrIO: Set<ArchiveControlFailure> = [
      .authenticationFailed, .commandExpired, .internalIOFailed,
    ]
    switch (commandKind, priorState, newState) {
    case (.startDay, .startIntent, .startFailed):
      return authenticationOrIO.contains(error) || error == .sessionOpenFailed
    case (.startDay, .sessionEndPatched, .startFailed):
      return error == .noDurableGrowth
    case (.pauseDay, .pauseIntent, .pauseFailed):
      return authenticationOrIO.contains(error)
    case (.pauseDay, .laneBoundariesDurable, .pauseFailed):
      return authenticationOrIO.contains(error) || error == .sessionPatchFailed
    case (.resumeDay, .resumeIntent, .resumeFailed):
      return authenticationOrIO.contains(error)
    case (.resumeDay, .cleanSegmentOpened, .resumeFailed):
      return error == .noDurableGrowth || error == .internalIOFailed
    case (.resumeDay, .captureStopped, .resumeFailed):
      return error == .sessionPatchFailed
    case (.endDay, .endIntent, .endFailed):
      return authenticationOrIO.contains(error)
    case (.endDay, .finalRangesReserved, .endFailed):
      return authenticationOrIO.contains(error) || error == .finalVerificationFailed
    case (.endDay, .finalRangesVerified, .endFailed):
      return error == .sessionPatchFailed || error == .authenticationFailed
        || error == .internalIOFailed
    case (.maintenanceHandoff, _, .maintenanceHandoffFailed),
      (.maintenanceReclaim, _, .maintenanceReclaimFailed):
      return authenticationOrIO.contains(error) || error == .maintenanceFailed
    case (.rollover, _, .rolloverFailed):
      return error == .internalIOFailed || error == .authenticationFailed
    default:
      return false
    }
  }

  private static func edges(for commandKind: ArchiveControlCommandKind) -> Set<Edge> {
    switch commandKind {
    case .startDay:
      return edges([
        (nil, .startIntent),
        (.startIntent, .sessionOpened),
        (.startIntent, .startFailed),
        (.startIntent, .sessionOpenOutcomeUnobservable),
        (.sessionOpenOutcomeUnobservable, .startFailureAckReady),
        (.sessionOpened, .captureDurable),
        (.sessionOpened, .startCompensationIntent),
        (.captureDurable, .startAckReady),
        (.startAckReady, .startAckObserved),
        (.startAckReady, .startAckOutcomeUnobservable),
        (.startCompensationIntent, .captureStopped),
        (.captureStopped, .sessionEndPatched),
        (.sessionEndPatched, .startFailed),
        (.startFailed, .startFailureAckReady),
        (.startFailureAckReady, .startFailureAckObserved),
        (.startFailureAckReady, .startFailureAckOutcomeUnobservable),
      ])
    case .pauseDay:
      return edges([
        (nil, .pauseIntent),
        (.pauseIntent, .laneBoundariesDurable),
        (.pauseIntent, .pauseFailed),
        (.laneBoundariesDurable, .pausePatched),
        (.laneBoundariesDurable, .pauseFailed),
        (.pausePatched, .pauseAckReady),
        (.pauseAckReady, .pauseAckObserved),
        (.pauseAckReady, .pauseAckOutcomeUnobservable),
        (.pauseFailed, .pauseFailureAckReady),
        (.pauseFailureAckReady, .pauseFailureAckObserved),
        (.pauseFailureAckReady, .pauseFailureAckOutcomeUnobservable),
      ])
    case .resumeDay:
      return edges([
        (nil, .resumeIntent),
        (.resumeIntent, .cleanSegmentOpened),
        (.resumeIntent, .resumeFailed),
        (.cleanSegmentOpened, .captureDurable),
        (.cleanSegmentOpened, .resumeFailed),
        (.captureDurable, .resumePatched),
        (.captureDurable, .resumeCompensationIntent),
        (.resumePatched, .resumeAckReady),
        (.resumeAckReady, .resumeAckObserved),
        (.resumeAckReady, .resumeAckOutcomeUnobservable),
        (.resumeCompensationIntent, .captureStopped),
        (.captureStopped, .resumeFailed),
        (.resumeFailed, .resumeFailureAckReady),
        (.resumeFailureAckReady, .resumeFailureAckObserved),
        (.resumeFailureAckReady, .resumeFailureAckOutcomeUnobservable),
      ])
    case .endDay:
      return edges([
        (nil, .endIntent),
        (.endIntent, .finalRangesReserved),
        (.endIntent, .endFailed),
        (.finalRangesReserved, .finalRangesVerified),
        (.finalRangesReserved, .endFailed),
        (.finalRangesVerified, .sessionEndPatched),
        (.finalRangesVerified, .endFailed),
        (.sessionEndPatched, .endAckReady),
        (.endAckReady, .endAckObserved),
        (.endAckReady, .endAckOutcomeUnobservable),
        (.endFailed, .endFailureAckReady),
        (.endFailureAckReady, .endFailureAckObserved),
        (.endFailureAckReady, .endFailureAckOutcomeUnobservable),
      ])
    case .maintenanceHandoff:
      return edges([
        (nil, .maintenanceHandoffIntent),
        (.maintenanceHandoffIntent, .laneBoundariesDurable),
        (.maintenanceHandoffIntent, .maintenanceHandoffFailed),
        (.laneBoundariesDurable, .browserOwnerReady),
        (.laneBoundariesDurable, .maintenanceHandoffFailed),
        (.maintenanceHandoffFailed, .maintenanceHandoffFailureAckReady),
        (.maintenanceHandoffFailureAckReady, .maintenanceHandoffFailureAckObserved),
        (
          .maintenanceHandoffFailureAckReady,
          .maintenanceHandoffFailureAckOutcomeUnobservable
        ),
      ])
    case .maintenanceReclaim:
      return edges([
        (nil, .maintenanceReclaimIntent),
        (.maintenanceReclaimIntent, .serverIndicesReconciled),
        (.maintenanceReclaimIntent, .maintenanceReclaimFailed),
        (.serverIndicesReconciled, .cleanSegmentOpened),
        (.serverIndicesReconciled, .maintenanceReclaimFailed),
        (.cleanSegmentOpened, .captureDurable),
        (.cleanSegmentOpened, .maintenanceReclaimFailed),
        (.captureDurable, .nativeOwnerReady),
        (.captureDurable, .maintenanceReclaimFailed),
        (.maintenanceReclaimFailed, .maintenanceReclaimFailureAckReady),
        (.maintenanceReclaimFailureAckReady, .maintenanceReclaimFailureAckObserved),
        (
          .maintenanceReclaimFailureAckReady,
          .maintenanceReclaimFailureAckOutcomeUnobservable
        ),
      ])
    case .rollover:
      return edges([
        (nil, .rolloverIntent),
        (.rolloverIntent, .oldDayFinalReserved),
        (.rolloverIntent, .rolloverFailed),
        (.oldDayFinalReserved, .oldDayFilesClosed),
        (.oldDayFinalReserved, .rolloverFailed),
        (.oldDayFilesClosed, .newDayFilesDurable),
        (.oldDayFilesClosed, .rolloverFailed),
        (.newDayFilesDurable, .rolloverComplete),
        (.newDayFilesDurable, .rolloverFailed),
      ])
    }
  }

  private static func edges(
    _ values: [(ArchiveControlState?, ArchiveControlState)]
  ) -> Set<Edge> {
    Set(values.map { Edge(prior: $0.0, new: $0.1) })
  }
}
