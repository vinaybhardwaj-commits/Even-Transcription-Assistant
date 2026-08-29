import Foundation

public enum ArchiveControlCommandKind: String, CaseIterable, Equatable, Sendable {
  case startDay = "start_day"
  case pauseDay = "pause_day"
  case resumeDay = "resume_day"
  case endDay = "end_day"
  case maintenanceHandoff = "maintenance_handoff"
  case maintenanceReclaim = "maintenance_reclaim"
  case captureSessionBinding = "capture_session_binding"
  case serverEndedFinalization = "server_ended_finalization"
  case rolloverPreparation = "rollover_preparation"
  case rollover
}

public enum ArchiveControlState: String, CaseIterable, Equatable, Hashable, Sendable {
  case commandNoop = "command_noop"
  case commandRefused = "command_refused"

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

  case captureSessionBound = "capture_session_bound"
  case serverEndedFinalized = "server_ended_finalized"

  case rolloverPreparation = "rollover_preparation"
  case rolloverIntent = "rollover_intent"
  case oldDayFinalReserved = "old_day_final_reserved"
  case oldDayFilesClosed = "old_day_files_closed"
  case newDayFilesDurable = "new_day_files_durable"
  case rolloverComplete = "rollover_complete"
  case rolloverFailed = "rollover_failed"
}

public enum ArchiveControlFailure: String, CaseIterable, Equatable, Sendable {
  case commandRefused = "command_refused"
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
  case invalidRolloverPreparation(commandID: String)
  case missingRolloverPreparation(commandID: String)
  case invalidRolloverPlan(commandID: String)
  case missingRolloverPlan(commandID: String)
  case invalidCaptureSessionBinding(commandID: String)
  case missingCaptureSessionBinding(commandID: String)
  case replayCaptureSessionBindingConflict(sessionID: String, istDate: String)
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
  public let captureSessionBinding: ArchiveCaptureSessionBinding?
  public let rolloverPlan: ArchiveRolloverPlan?
  public let rolloverPreparation: ArchiveRolloverPreparation?

  public init(
    commandID: String,
    commandKind: ArchiveControlCommandKind,
    sessionID: String?,
    priorState: ArchiveControlState?,
    newState: ArchiveControlState,
    atMonoNS: UInt64,
    atWallNS: UInt64,
    error: ArchiveControlFailure?,
    captureSessionBinding: ArchiveCaptureSessionBinding? = nil,
    rolloverPlan: ArchiveRolloverPlan? = nil,
    rolloverPreparation: ArchiveRolloverPreparation? = nil
  ) throws {
    guard Self.validID(commandID) else {
      throw ArchiveControlPayloadError.invalidID("command_id")
    }
    if let sessionID, !Self.validID(sessionID) {
      throw ArchiveControlPayloadError.invalidID("session_id")
    }
    let sessionlessDecision = newState == .commandNoop || newState == .commandRefused
    if priorState == nil, !sessionlessDecision {
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
    if let rolloverPlan {
      guard commandKind == .rollover, newState == .rolloverIntent,
        rolloverPlan.commandID == commandID, rolloverPlan.sessionID == sessionID
      else {
        throw ArchiveControlPayloadError.invalidRolloverPlan(commandID: commandID)
      }
    }
    if let captureSessionBinding {
      guard commandKind == .captureSessionBinding, newState == .captureSessionBound,
        captureSessionBinding.commandID == commandID,
        captureSessionBinding.sessionID == sessionID
      else {
        throw ArchiveControlPayloadError.invalidCaptureSessionBinding(commandID: commandID)
      }
    }
    if let rolloverPreparation {
      guard commandKind == .rolloverPreparation, newState == .rolloverPreparation,
        rolloverPreparation.commandID == commandID,
        rolloverPreparation.sessionID == sessionID
      else {
        throw ArchiveControlPayloadError.invalidRolloverPreparation(commandID: commandID)
      }
    }

    self.commandID = commandID
    self.commandKind = commandKind
    self.sessionID = sessionID
    self.priorState = priorState
    self.newState = newState
    self.atMonoNS = atMonoNS
    self.atWallNS = atWallNS
    self.error = error
    self.captureSessionBinding = captureSessionBinding
    self.rolloverPlan = rolloverPlan
    self.rolloverPreparation = rolloverPreparation
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
  public let captureSessionBinding: ArchiveCaptureSessionBinding?
  public let rolloverPlan: ArchiveRolloverPlan?
  public let rolloverPreparation: ArchiveRolloverPreparation?
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
    var sessionlessDecisionCommands: Set<String> = []
    var bindings: [String: ArchiveCaptureSessionBinding] = [:]
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
      } else if payload.commandKind == .serverEndedFinalization {
        if let activeSessionID, payload.sessionID != activeSessionID {
          throw ArchiveControlPayloadError.replayActiveSessionMismatch(
            commandID: payload.commandID,
            expected: activeSessionID,
            actual: payload.sessionID
          )
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
      if payload.commandKind == .rollover, previous != nil, payload.rolloverPlan != nil {
        throw ArchiveControlPayloadError.invalidRolloverPlan(commandID: payload.commandID)
      }
      if payload.commandKind == .captureSessionBinding {
        guard let binding = payload.captureSessionBinding else {
          throw ArchiveControlPayloadError.missingCaptureSessionBinding(
            commandID: payload.commandID)
        }
        let key = "\(binding.sessionID)\u{0}\(binding.primaryIdentity.context.istDate)"
        if let existing = bindings[key], existing != binding {
          throw ArchiveControlPayloadError.replayCaptureSessionBindingConflict(
            sessionID: binding.sessionID,
            istDate: binding.primaryIdentity.context.istDate)
        }
        bindings[key] = binding
      }

      if (payload.newState == .commandNoop || payload.newState == .commandRefused)
        && payload.sessionID == nil
      {
        sessionlessDecisionCommands.insert(payload.commandID)
      }
      if payload.commandKind == .startDay,
        !sessionlessDecisionCommands.contains(payload.commandID)
      {
        sawStartHistory = true
      }
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
        if !sessionlessDecisionCommands.contains(payload.commandID), previous == nil,
          activeSessionID == nil
        {
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
        if !sessionlessDecisionCommands.contains(payload.commandID), !commandAlreadyEnded {
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
      if payload.newState == .serverEndedFinalized,
        payload.commandKind == .serverEndedFinalization
      {
        activeSessionID = nil
        terminallyEndedCommands.insert(payload.commandID)
      }

      commands[payload.commandID] = ArchiveControlReplayCommand(
        commandKind: payload.commandKind,
        sessionID: previous?.sessionID ?? payload.sessionID,
        state: payload.newState,
        atMonoNS: payload.atMonoNS,
        atWallNS: payload.atWallNS,
        captureSessionBinding: previous?.captureSessionBinding ?? payload.captureSessionBinding,
        rolloverPlan: previous?.rolloverPlan ?? payload.rolloverPlan,
        rolloverPreparation: previous?.rolloverPreparation ?? payload.rolloverPreparation
      )
    }
    for (commandID, command) in commands where command.commandKind == .rollover {
      if command.state != .rolloverComplete, command.state != .rolloverFailed,
        command.rolloverPlan == nil
      {
        throw ArchiveControlPayloadError.missingRolloverPlan(commandID: commandID)
      }
    }
    for (commandID, command) in commands where command.commandKind == .rolloverPreparation {
      guard command.rolloverPreparation != nil else {
        throw ArchiveControlPayloadError.missingRolloverPreparation(commandID: commandID)
      }
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
    if let captureSessionBinding = payload.captureSessionBinding {
      result.append(contentsOf: ",\"capture_session_binding\":".utf8)
      ArchiveCanonicalJSON.appendString(
        try ArchiveCaptureSessionBindingCodec.encode(captureSessionBinding).base64EncodedString(),
        to: &result)
    }
    result.append(contentsOf: ",\"error\":".utf8)
    ArchiveCanonicalJSON.appendOptionalString(payload.error?.rawValue, to: &result)
    result.append(contentsOf: ",\"new_state\":".utf8)
    ArchiveCanonicalJSON.appendString(payload.newState.rawValue, to: &result)
    result.append(contentsOf: ",\"prior_state\":".utf8)
    ArchiveCanonicalJSON.appendOptionalString(payload.priorState?.rawValue, to: &result)
    if let rolloverPlan = payload.rolloverPlan {
      result.append(contentsOf: ",\"rollover_plan\":".utf8)
      let encodedPlan = try ArchiveRolloverPlanCodec.encode(rolloverPlan).base64EncodedString()
      ArchiveCanonicalJSON.appendString(encodedPlan, to: &result)
    }
    if let rolloverPreparation = payload.rolloverPreparation {
      result.append(contentsOf: ",\"rollover_preparation\":".utf8)
      let encodedPreparation = try ArchiveRolloverPreparationCodec.encode(rolloverPreparation)
        .base64EncodedString()
      ArchiveCanonicalJSON.appendString(encodedPreparation, to: &result)
    }
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
      let captureSessionBinding: ArchiveCaptureSessionBinding?
      if parser.consume(",\"capture_session_binding\":") {
        let raw = try parser.string()
        guard let bytes = Data(base64Encoded: raw), bytes.base64EncodedString() == raw else {
          throw ArchiveControlPayloadError.invalidCaptureSessionBinding(commandID: commandID)
        }
        do {
          captureSessionBinding = try ArchiveCaptureSessionBindingCodec.decode(bytes)
        } catch {
          throw ArchiveControlPayloadError.invalidCaptureSessionBinding(commandID: commandID)
        }
      } else {
        captureSessionBinding = nil
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
      let rolloverPlanRaw: String?
      if parser.consume(",\"rollover_plan\":") {
        rolloverPlanRaw = try parser.string()
      } else {
        rolloverPlanRaw = nil
      }
      let rolloverPlan: ArchiveRolloverPlan?
      if let rolloverPlanRaw {
        guard let bytes = Data(base64Encoded: rolloverPlanRaw),
          bytes.base64EncodedString() == rolloverPlanRaw
        else {
          throw ArchiveControlPayloadError.invalidRolloverPlan(commandID: commandID)
        }
        do {
          rolloverPlan = try ArchiveRolloverPlanCodec.decode(bytes)
        } catch {
          throw ArchiveControlPayloadError.invalidRolloverPlan(commandID: commandID)
        }
      } else {
        rolloverPlan = nil
      }
      let rolloverPreparationRaw: String?
      if parser.consume(",\"rollover_preparation\":") {
        rolloverPreparationRaw = try parser.string()
      } else {
        rolloverPreparationRaw = nil
      }
      let rolloverPreparation: ArchiveRolloverPreparation?
      if let rolloverPreparationRaw {
        guard let bytes = Data(base64Encoded: rolloverPreparationRaw),
          bytes.base64EncodedString() == rolloverPreparationRaw
        else {
          throw ArchiveControlPayloadError.invalidRolloverPreparation(commandID: commandID)
        }
        do {
          rolloverPreparation = try ArchiveRolloverPreparationCodec.decode(bytes)
        } catch {
          throw ArchiveControlPayloadError.invalidRolloverPreparation(commandID: commandID)
        }
      } else {
        rolloverPreparation = nil
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
        error: error,
        captureSessionBinding: captureSessionBinding,
        rolloverPlan: rolloverPlan,
        rolloverPreparation: rolloverPreparation
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
    case .commandRefused:
      return error == .commandRefused
    case .commandNoop:
      return error == nil
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
        (nil, .commandNoop),
        (.commandNoop, .startAckReady),
        (nil, .commandRefused),
        (.commandRefused, .startFailureAckReady),
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
        (nil, .commandNoop),
        (.commandNoop, .pauseAckReady),
        (nil, .commandRefused),
        (.commandRefused, .pauseFailureAckReady),
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
        (nil, .commandNoop),
        (.commandNoop, .resumeAckReady),
        (nil, .commandRefused),
        (.commandRefused, .resumeFailureAckReady),
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
        (nil, .commandNoop),
        (.commandNoop, .endAckReady),
        (nil, .commandRefused),
        (.commandRefused, .endFailureAckReady),
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
    case .captureSessionBinding:
      return edges([
        (nil, .captureSessionBound)
      ])
    case .serverEndedFinalization:
      return edges([
        (nil, .serverEndedFinalized)
      ])
    case .rolloverPreparation:
      return edges([
        (nil, .rolloverPreparation)
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
