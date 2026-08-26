import Foundation

enum CaptureReadinessOutcome: String, Equatable {
  case ready
  case cancelled
  case physicalFallbackRequired = "physical_fallback_required"
}

struct CaptureReadinessResult<Session> {
  let outcome: CaptureReadinessOutcome
  let attempts: Int
  let session: Session?
}

struct CaptureReadinessPolicy {
  static let coldBoot = CaptureReadinessPolicy(
    maximumAttempts: 3,
    attemptWindowNS: 5_000_000_000,
    pollIntervalNS: 100_000_000
  )

  let maximumAttempts: Int
  let attemptWindowNS: UInt64
  let pollIntervalNS: UInt64
}

enum CaptureReadinessCoordinator {
  static func acquire<Session>(
    policy: CaptureReadinessPolicy = .coldBoot,
    isCancelled: () -> Bool,
    nowNS: () -> UInt64,
    sleepNS: (UInt64) -> Void,
    hasDurableGrowth: (Int, UInt64) -> Bool,
    checkWriter: () throws -> Void,
    startAttempt: (Int) throws -> Session,
    stopAttempt: (Session) -> Void,
    attemptDidNotGrow: (Int, Error?) -> Void = { _, _ in }
  ) throws -> CaptureReadinessResult<Session> {
    precondition(policy.maximumAttempts > 0)
    precondition(policy.attemptWindowNS > 0)
    precondition(policy.pollIntervalNS > 0)

    let acquisitionStartedAtNS = nowNS()
    var attemptsStarted = 0
    for attempt in 1...policy.maximumAttempts {
      if isCancelled() {
        return CaptureReadinessResult(outcome: .cancelled, attempts: attemptsStarted, session: nil)
      }

      let windowNS = policy.attemptWindowNS.multipliedReportingOverflow(by: UInt64(attempt))
      let deadlineNS = acquisitionStartedAtNS.addingReportingOverflow(
        windowNS.overflow ? UInt64.max : windowNS.partialValue)
      let deadline = deadlineNS.overflow ? UInt64.max : deadlineNS.partialValue
      if nowNS() >= deadline { continue }
      attemptsStarted += 1
      let session: Session?
      do {
        session = try startAttempt(attempt)
      } catch {
        session = nil
        attemptDidNotGrow(attempt, error)
      }

      while true {
        if isCancelled() {
          if let session { stopAttempt(session) }
          return CaptureReadinessResult(
            outcome: .cancelled,
            attempts: attemptsStarted,
            session: nil
          )
        }
        do {
          try checkWriter()
        } catch {
          if let session { stopAttempt(session) }
          throw error
        }
        if session != nil, hasDurableGrowth(attempt, deadline) {
          if isCancelled() {
            if let session { stopAttempt(session) }
            return CaptureReadinessResult(
              outcome: .cancelled,
              attempts: attemptsStarted,
              session: nil
            )
          }
          do {
            try checkWriter()
          } catch {
            if let session { stopAttempt(session) }
            throw error
          }
          return CaptureReadinessResult(
            outcome: .ready,
            attempts: attemptsStarted,
            session: session
          )
        }
        let now = nowNS()
        if now >= deadline { break }
        sleepNS(min(policy.pollIntervalNS, deadline - now))
      }

      if let session {
        stopAttempt(session)
        attemptDidNotGrow(attempt, nil)
      }
      if isCancelled() {
        return CaptureReadinessResult(
          outcome: .cancelled,
          attempts: attemptsStarted,
          session: nil
        )
      }
    }

    if isCancelled() {
      return CaptureReadinessResult(
        outcome: .cancelled,
        attempts: attemptsStarted,
        session: nil
      )
    }
    try checkWriter()

    return CaptureReadinessResult(
      outcome: .physicalFallbackRequired,
      attempts: attemptsStarted,
      session: nil
    )
  }
}
