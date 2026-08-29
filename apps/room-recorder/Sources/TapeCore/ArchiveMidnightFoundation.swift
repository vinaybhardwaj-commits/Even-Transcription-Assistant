import CryptoKit
import Foundation

public enum ArchiveISTDayError: Error, Equatable, Sendable {
  case invalidDate(String)
  case calendarFailure
}

public struct ArchiveISTDay: Equatable, Hashable, Sendable, CustomStringConvertible {
  public static let timeZoneIdentifier = "Asia/Kolkata"
  public static let utcOffsetSeconds = 19_800

  public let year: Int
  public let month: Int
  public let day: Int

  public init(_ value: String) throws {
    let bytes = Array(value.utf8)
    guard bytes.count == 10, bytes[4] == 0x2D, bytes[7] == 0x2D,
      bytes.enumerated().allSatisfy({ index, byte in
        index == 4 || index == 7 || (0x30...0x39).contains(byte)
      })
    else {
      throw ArchiveISTDayError.invalidDate(value)
    }
    let year = Self.decimal(bytes[0..<4])
    let month = Self.decimal(bytes[5..<7])
    let day = Self.decimal(bytes[8..<10])
    try self.init(year: year, month: month, day: day, original: value)
  }

  public init(containing date: Date) throws {
    let components = Self.calendar.dateComponents([.year, .month, .day], from: date)
    guard let year = components.year, let month = components.month, let day = components.day else {
      throw ArchiveISTDayError.calendarFailure
    }
    try self.init(
      year: year,
      month: month,
      day: day,
      original: String(format: "%04d-%02d-%02d", year, month, day))
  }

  public static func current(now: @Sendable () -> Date) throws -> ArchiveISTDay {
    try ArchiveISTDay(containing: now())
  }

  public var description: String {
    String(format: "%04d-%02d-%02d", year, month, day)
  }

  public var start: Date {
    get throws {
      guard let value = Self.calendar.date(from: components) else {
        throw ArchiveISTDayError.calendarFailure
      }
      return value
    }
  }

  public var next: ArchiveISTDay {
    get throws { try adding(days: 1) }
  }

  public var previous: ArchiveISTDay {
    get throws { try adding(days: -1) }
  }

  public var nextMidnight: Date {
    get throws { try next.start }
  }

  public static func nextMidnight(now: @Sendable () -> Date) throws -> Date {
    try current(now: now).nextMidnight
  }

  private init(year: Int, month: Int, day: Int, original: String) throws {
    self.year = year
    self.month = month
    self.day = day
    guard let date = Self.calendar.date(from: components) else {
      throw ArchiveISTDayError.invalidDate(original)
    }
    let roundTrip = Self.calendar.dateComponents([.year, .month, .day], from: date)
    guard roundTrip.year == year, roundTrip.month == month, roundTrip.day == day else {
      throw ArchiveISTDayError.invalidDate(original)
    }
  }

  private var components: DateComponents {
    var value = DateComponents()
    value.calendar = Self.calendar
    value.timeZone = Self.timeZone
    value.year = year
    value.month = month
    value.day = day
    value.hour = 0
    value.minute = 0
    value.second = 0
    value.nanosecond = 0
    return value
  }

  private func adding(days: Int) throws -> ArchiveISTDay {
    guard let date = Self.calendar.date(byAdding: .day, value: days, to: try start) else {
      throw ArchiveISTDayError.calendarFailure
    }
    return try ArchiveISTDay(containing: date)
  }

  private static var timeZone: TimeZone {
    guard let value = TimeZone(identifier: timeZoneIdentifier) else {
      preconditionFailure("Foundation is missing Asia/Kolkata")
    }
    return value
  }

  private static var calendar: Calendar {
    var value = Calendar(identifier: .gregorian)
    value.locale = Locale(identifier: "en_US_POSIX")
    value.timeZone = timeZone
    value.firstWeekday = 2
    value.minimumDaysInFirstWeek = 4
    return value
  }

  private static func decimal(_ bytes: ArraySlice<UInt8>) -> Int {
    bytes.reduce(0) { $0 * 10 + Int($1 - 0x30) }
  }
}

public enum ArchiveDailyLaneIdentityError: Error, Equatable, Sendable {
  case invalidStreamUUID
  case invalidKeywrapDigest
  case keywrapContextMismatch
  case nonAdjacentDays
  case contextSubstitution
  case invalidBoundary
  case reusedKeywrap
  case reusedStreamUUID
}

public struct ArchiveDailyLaneIdentity: Equatable, Sendable {
  public let context: ArchiveContext
  public let expectedInitialSessionSample: UInt64
  public let keywrapDigestHex: String

  public init(
    context: ArchiveContext,
    expectedInitialSessionSample: UInt64,
    keywrap: ArchiveKeywrapInspection
  ) throws {
    guard keywrap.authenticated, keywrap.streamUUIDHex == Self.hex(context.streamUUID),
      keywrap.contextHashHex == Self.hex(try context.sha256())
    else {
      throw ArchiveDailyLaneIdentityError.keywrapContextMismatch
    }
    try self.init(
      context: context,
      expectedInitialSessionSample: expectedInitialSessionSample,
      keywrapDigestHex: keywrap.keywrapDigestHex)
  }

  init(
    context: ArchiveContext,
    expectedInitialSessionSample: UInt64,
    keywrapDigestHex: String
  ) throws {
    _ = try context.encodedBytes()
    _ = try ArchiveISTDay(context.istDate)
    guard context.streamUUID[6] >> 4 == 4, context.streamUUID[8] >> 6 == 2 else {
      throw ArchiveDailyLaneIdentityError.invalidStreamUUID
    }
    guard Self.isLowercaseDigest(keywrapDigestHex) else {
      throw ArchiveDailyLaneIdentityError.invalidKeywrapDigest
    }
    self.context = context
    self.expectedInitialSessionSample = expectedInitialSessionSample
    self.keywrapDigestHex = keywrapDigestHex
  }

  public var istDay: ArchiveISTDay { get throws { try ArchiveISTDay(context.istDate) } }
  public var roomID: String { context.roomID }
  public var laneID: String { context.laneID }
  public var stableDeviceUID: String { context.stableDeviceUID }
  public var streamUUID: Data { context.streamUUID }

  public static func validateRollover(
    from oldDay: ArchiveDailyLaneIdentity,
    to newDay: ArchiveDailyLaneIdentity,
    boundarySample: UInt64
  ) throws {
    guard try oldDay.istDay.next == newDay.istDay else {
      throw ArchiveDailyLaneIdentityError.nonAdjacentDays
    }
    guard oldDay.roomID == newDay.roomID, oldDay.laneID == newDay.laneID,
      oldDay.stableDeviceUID == newDay.stableDeviceUID
    else {
      throw ArchiveDailyLaneIdentityError.contextSubstitution
    }
    guard oldDay.expectedInitialSessionSample <= boundarySample,
      newDay.expectedInitialSessionSample == boundarySample
    else {
      throw ArchiveDailyLaneIdentityError.invalidBoundary
    }
    guard oldDay.keywrapDigestHex != newDay.keywrapDigestHex else {
      throw ArchiveDailyLaneIdentityError.reusedKeywrap
    }
    guard oldDay.streamUUID != newDay.streamUUID else {
      throw ArchiveDailyLaneIdentityError.reusedStreamUUID
    }
  }

  fileprivate static func isLowercaseDigest(_ value: String) -> Bool {
    value.utf8.count == 64
      && value.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
  }

  fileprivate static func hex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
  }
}

public enum ArchiveDailyControlIdentityError: Error, Equatable, Sendable {
  case invalidContext
  case invalidStreamUUID
  case invalidKeywrapDigest
  case keywrapContextMismatch
  case nonAdjacentDays
  case contextSubstitution
  case reusedKeywrap
  case reusedStreamUUID
}

public struct ArchiveDailyControlIdentity: Equatable, Sendable {
  public let context: ArchiveContext
  public let keywrapDigestHex: String

  public init(context: ArchiveContext, keywrap: ArchiveKeywrapInspection) throws {
    guard keywrap.authenticated,
      keywrap.streamUUIDHex == ArchiveDailyLaneIdentity.hex(context.streamUUID),
      keywrap.contextHashHex == ArchiveDailyLaneIdentity.hex(try context.sha256())
    else {
      throw ArchiveDailyControlIdentityError.keywrapContextMismatch
    }
    try self.init(context: context, keywrapDigestHex: keywrap.keywrapDigestHex)
  }

  init(context: ArchiveContext, keywrapDigestHex: String) throws {
    _ = try context.encodedBytes()
    _ = try ArchiveISTDay(context.istDate)
    guard context.laneID == "_control", context.stableDeviceUID.isEmpty else {
      throw ArchiveDailyControlIdentityError.invalidContext
    }
    guard context.streamUUID[6] >> 4 == 4, context.streamUUID[8] >> 6 == 2 else {
      throw ArchiveDailyControlIdentityError.invalidStreamUUID
    }
    guard ArchiveDailyLaneIdentity.isLowercaseDigest(keywrapDigestHex) else {
      throw ArchiveDailyControlIdentityError.invalidKeywrapDigest
    }
    self.context = context
    self.keywrapDigestHex = keywrapDigestHex
  }

  public var istDay: ArchiveISTDay { get throws { try ArchiveISTDay(context.istDate) } }
  public var roomID: String { context.roomID }
  public var laneID: String { context.laneID }
  public var streamUUID: Data { context.streamUUID }

  public static func validateRollover(
    from oldDay: ArchiveDailyControlIdentity,
    to newDay: ArchiveDailyControlIdentity
  ) throws {
    guard try oldDay.istDay.next == newDay.istDay else {
      throw ArchiveDailyControlIdentityError.nonAdjacentDays
    }
    guard oldDay.roomID == newDay.roomID else {
      throw ArchiveDailyControlIdentityError.contextSubstitution
    }
    guard oldDay.keywrapDigestHex != newDay.keywrapDigestHex else {
      throw ArchiveDailyControlIdentityError.reusedKeywrap
    }
    guard oldDay.streamUUID != newDay.streamUUID else {
      throw ArchiveDailyControlIdentityError.reusedStreamUUID
    }
  }
}

public enum ArchiveRolloverError: Error, Equatable, Sendable {
  case invalidID(String)
  case invalidChunkIndex(UInt64)
  case invalidLaneConfiguration
  case preparationMismatch
  case authenticatedContextMismatch(laneID: String)
  case authenticatedBoundaryMismatch(laneID: String, expected: UInt64, actual: UInt64)
  case planHistoryMismatch
  case invalidEffectReceipt
  case effectFailed(ArchiveControlFailure)
  case failedControlState
}

public struct ArchiveRolloverAudioLane: Equatable, Sendable {
  public let oldDay: ArchiveDailyLaneIdentity
  public let newDay: ArchiveDailyLaneIdentity
  public let boundarySample: UInt64
  public let nextChunkIndex: UInt32
  public let oldAuthenticatedFacts: ArchiveAuthenticatedLaneFacts
  public let newAuthenticatedFacts: ArchiveAuthenticatedLaneFacts

  public init(
    oldDay: ArchiveDailyLaneIdentity,
    newDay: ArchiveDailyLaneIdentity,
    nextChunkIndex: UInt64,
    boundarySample: UInt64,
    oldAuthenticatedFacts: ArchiveAuthenticatedLaneFacts,
    newAuthenticatedFacts: ArchiveAuthenticatedLaneFacts
  ) throws {
    guard nextChunkIndex <= UInt64(UInt32.max) else {
      throw ArchiveRolloverError.invalidChunkIndex(nextChunkIndex)
    }
    try ArchiveDailyLaneIdentity.validateRollover(
      from: oldDay, to: newDay, boundarySample: boundarySample)
    guard oldAuthenticatedFacts.context == oldDay.context else {
      throw ArchiveRolloverError.authenticatedContextMismatch(laneID: oldDay.laneID)
    }
    guard newAuthenticatedFacts.context == newDay.context else {
      throw ArchiveRolloverError.authenticatedContextMismatch(laneID: newDay.laneID)
    }
    guard oldAuthenticatedFacts.initialSamplePosition == oldDay.expectedInitialSessionSample else {
      throw ArchiveRolloverError.authenticatedBoundaryMismatch(
        laneID: oldDay.laneID,
        expected: oldDay.expectedInitialSessionSample,
        actual: oldAuthenticatedFacts.initialSamplePosition)
    }
    guard oldAuthenticatedFacts.authenticatedSampleEnd == boundarySample else {
      throw ArchiveRolloverError.authenticatedBoundaryMismatch(
        laneID: oldDay.laneID,
        expected: boundarySample,
        actual: oldAuthenticatedFacts.authenticatedSampleEnd)
    }
    guard newAuthenticatedFacts.initialSamplePosition == boundarySample else {
      throw ArchiveRolloverError.authenticatedBoundaryMismatch(
        laneID: newDay.laneID,
        expected: boundarySample,
        actual: newAuthenticatedFacts.initialSamplePosition)
    }
    guard newAuthenticatedFacts.authenticatedSampleEnd == boundarySample else {
      throw ArchiveRolloverError.authenticatedBoundaryMismatch(
        laneID: newDay.laneID,
        expected: boundarySample,
        actual: newAuthenticatedFacts.authenticatedSampleEnd)
    }
    guard newAuthenticatedFacts.recordCount == 0 else {
      throw ArchiveRolloverError.authenticatedBoundaryMismatch(
        laneID: newDay.laneID,
        expected: 0,
        actual: UInt64(newAuthenticatedFacts.recordCount))
    }
    self.oldDay = oldDay
    self.newDay = newDay
    self.boundarySample = boundarySample
    self.nextChunkIndex = UInt32(nextChunkIndex)
    self.oldAuthenticatedFacts = oldAuthenticatedFacts
    self.newAuthenticatedFacts = newAuthenticatedFacts
  }
}

public struct ArchiveRolloverPlan: Equatable, Sendable {
  public let commandID: String
  public let sessionID: String
  public let sessionSampleStart: UInt64
  public let preparationID: String
  public let primary: ArchiveRolloverAudioLane
  public let backup: ArchiveRolloverAudioLane?
  public let oldControl: ArchiveDailyControlIdentity
  public let newControl: ArchiveDailyControlIdentity

  public init(
    sessionID: String,
    sessionSampleStart: UInt64? = nil,
    preparationID: String? = nil,
    primary: ArchiveRolloverAudioLane,
    backup: ArchiveRolloverAudioLane?,
    oldControl: ArchiveDailyControlIdentity,
    newControl: ArchiveDailyControlIdentity
  ) throws {
    guard !sessionID.isEmpty, sessionID.utf8.count <= 256 else {
      throw ArchiveRolloverError.invalidID("session_id")
    }
    let resolvedSessionSampleStart =
      sessionSampleStart ?? primary.oldDay.expectedInitialSessionSample
    let preparation = try ArchiveRolloverPreparation(
      sessionID: sessionID,
      sessionSampleStart: resolvedSessionSampleStart,
      oldDay: primary.oldDay,
      boundarySample: primary.boundarySample,
      nextChunkIndex: primary.nextChunkIndex,
      oldAuthenticatedFacts: primary.oldAuthenticatedFacts,
      targetISTDay: primary.newDay.istDay)
    guard preparationID == nil || preparationID == preparation.commandID else {
      throw ArchiveRolloverError.preparationMismatch
    }
    guard primary.oldDay.laneID == "primary", primary.newDay.laneID == "primary",
      oldControl.laneID == "_control", newControl.laneID == "_control",
      backup?.oldDay.laneID != "primary", backup?.oldDay.laneID != "_control",
      backup?.newDay.laneID == backup?.oldDay.laneID
    else {
      throw ArchiveRolloverError.invalidLaneConfiguration
    }
    if let backup {
      guard backup.oldDay.laneID == "backup" else {
        throw ArchiveRolloverError.invalidLaneConfiguration
      }
    }
    try ArchiveDailyControlIdentity.validateRollover(from: oldControl, to: newControl)
    let allStreamUUIDs = [
      primary.oldDay.streamUUID,
      backup?.oldDay.streamUUID,
      oldControl.streamUUID,
      primary.newDay.streamUUID,
      backup?.newDay.streamUUID,
      newControl.streamUUID,
    ].compactMap { $0 }
    let allKeywrapDigests = [
      primary.oldDay.keywrapDigestHex,
      backup?.oldDay.keywrapDigestHex,
      oldControl.keywrapDigestHex,
      primary.newDay.keywrapDigestHex,
      backup?.newDay.keywrapDigestHex,
      newControl.keywrapDigestHex,
    ].compactMap { $0 }
    let oldISTDay = try primary.oldDay.istDay
    let newISTDay = try primary.newDay.istDay
    let oldRoomIDs = [primary.oldDay.roomID, backup?.oldDay.roomID, oldControl.roomID].compactMap {
      $0
    }
    let newRoomIDs = [primary.newDay.roomID, backup?.newDay.roomID, newControl.roomID].compactMap {
      $0
    }
    let oldDays = [try primary.oldDay.istDay, try backup?.oldDay.istDay, try oldControl.istDay]
      .compactMap { $0 }
    let newDays = [try primary.newDay.istDay, try backup?.newDay.istDay, try newControl.istDay]
      .compactMap { $0 }
    guard oldRoomIDs.allSatisfy({ $0 == primary.oldDay.roomID }),
      newRoomIDs.allSatisfy({ $0 == primary.oldDay.roomID }),
      oldDays.allSatisfy({ $0 == oldISTDay }),
      newDays.allSatisfy({ $0 == newISTDay }),
      Set(allStreamUUIDs).count == allStreamUUIDs.count,
      Set(allKeywrapDigests).count == allKeywrapDigests.count
    else {
      throw ArchiveRolloverError.invalidLaneConfiguration
    }
    self.sessionID = sessionID
    self.sessionSampleStart = resolvedSessionSampleStart
    self.preparationID = preparation.commandID
    self.primary = primary
    self.backup = backup
    self.oldControl = oldControl
    self.newControl = newControl
    commandID = Self.makeCommandID(
      sessionID: sessionID,
      sessionSampleStart: resolvedSessionSampleStart,
      preparationID: preparation.commandID,
      primary: primary,
      backup: backup,
      oldControl: oldControl,
      newControl: newControl)
  }

  private static func makeCommandID(
    sessionID: String,
    sessionSampleStart: UInt64,
    preparationID: String,
    primary: ArchiveRolloverAudioLane,
    backup: ArchiveRolloverAudioLane?,
    oldControl: ArchiveDailyControlIdentity,
    newControl: ArchiveDailyControlIdentity
  ) -> String {
    var bytes = Data("eta.room-recorder/rollover-plan/v3".utf8)
    append(sessionID, to: &bytes)
    append(sessionSampleStart, to: &bytes)
    append(preparationID, to: &bytes)
    append(primary, to: &bytes)
    if let backup {
      bytes.append(1)
      append(backup, to: &bytes)
    } else {
      bytes.append(0)
    }
    append(oldControl, to: &bytes)
    append(newControl, to: &bytes)
    return ArchiveDailyLaneIdentity.hex(Data(SHA256.hash(data: bytes)))
  }

  private static func append(_ lane: ArchiveRolloverAudioLane, to data: inout Data) {
    append(lane.oldDay, to: &data)
    append(lane.newDay, to: &data)
    append(lane.boundarySample, to: &data)
    append(lane.nextChunkIndex, to: &data)
    append(lane.oldAuthenticatedFacts, to: &data)
    append(lane.newAuthenticatedFacts, to: &data)
  }

  private static func append(_ facts: ArchiveAuthenticatedLaneFacts, to data: inout Data) {
    append(facts.initialSamplePosition, to: &data)
    append(facts.authenticatedSampleEnd, to: &data)
    append(UInt64(facts.recordCount), to: &data)
  }

  private static func append(_ identity: ArchiveDailyControlIdentity, to data: inout Data) {
    append(identity.context.istDate, to: &data)
    append(identity.context.roomID, to: &data)
    append(identity.context.laneID, to: &data)
    append(identity.context.streamUUID, to: &data)
    append(identity.keywrapDigestHex, to: &data)
  }

  private static func append(_ identity: ArchiveDailyLaneIdentity, to data: inout Data) {
    append(identity.context.istDate, to: &data)
    append(identity.context.roomID, to: &data)
    append(identity.context.laneID, to: &data)
    append(identity.context.stableDeviceUID, to: &data)
    append(identity.context.streamUUID, to: &data)
    append(identity.keywrapDigestHex, to: &data)
    append(identity.expectedInitialSessionSample, to: &data)
  }

  private static func append(_ value: String, to data: inout Data) {
    append(Data(value.utf8), to: &data)
  }

  private static func append(_ value: Data, to data: inout Data) {
    append(UInt64(value.count), to: &data)
    data.append(value)
  }

  private static func append<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
    for index in 0..<MemoryLayout<T>.size {
      data.append(UInt8(truncatingIfNeeded: value >> T(index * 8)))
    }
  }
}

public enum ArchiveRolloverEffectKind: String, Equatable, Sendable {
  case reserveOldDayFinal
  case closeOldDayFiles
  case makeNewDayFilesDurable
}

public struct ArchiveRolloverEffectReceipt: Equatable, Sendable {
  public let kind: ArchiveRolloverEffectKind
  public let commandID: String
  public let expectedDurableDigestHex: String
  public let observedDurableDigestHex: String
  public let performedDurableMutation: Bool

  public init(
    kind: ArchiveRolloverEffectKind,
    commandID: String,
    expectedDurableDigestHex: String,
    observedDurableDigestHex: String,
    performedDurableMutation: Bool
  ) {
    self.kind = kind
    self.commandID = commandID
    self.expectedDurableDigestHex = expectedDurableDigestHex
    self.observedDurableDigestHex = observedDurableDigestHex
    self.performedDurableMutation = performedDurableMutation
  }
}

public enum ArchiveRolloverEffectFailure: Error, Equatable, Sendable {
  case authenticationFailed
  case internalIOFailed
}

public protocol ArchiveRolloverProcessCrashSignal: Error {}

public struct ArchiveRolloverEffects: Sendable {
  public let reserveOldDayFinal:
    @Sendable (ArchiveRolloverPlan) throws -> ArchiveRolloverEffectReceipt
  public let closeOldDayFiles:
    @Sendable (ArchiveRolloverPlan) throws -> ArchiveRolloverEffectReceipt
  public let makeNewDayFilesDurable:
    @Sendable (ArchiveRolloverPlan) throws -> ArchiveRolloverEffectReceipt

  public init(
    reserveOldDayFinal:
      @escaping @Sendable (ArchiveRolloverPlan) throws
      -> ArchiveRolloverEffectReceipt,
    closeOldDayFiles:
      @escaping @Sendable (ArchiveRolloverPlan) throws
      -> ArchiveRolloverEffectReceipt,
    makeNewDayFilesDurable:
      @escaping @Sendable (ArchiveRolloverPlan) throws
      -> ArchiveRolloverEffectReceipt
  ) {
    self.reserveOldDayFinal = reserveOldDayFinal
    self.closeOldDayFiles = closeOldDayFiles
    self.makeNewDayFilesDurable = makeNewDayFilesDurable
  }
}

public struct ArchiveRolloverClock: Sendable {
  public let now: @Sendable () -> (monotonicNS: UInt64, wallNS: UInt64)

  public init(now: @escaping @Sendable () -> (monotonicNS: UInt64, wallNS: UInt64)) {
    self.now = now
  }
}

public enum ArchiveRolloverCoordinator {
  @discardableResult
  public static func persistIntent(
    plan: ArchiveRolloverPlan,
    controlStore: ArchiveDerivedStore,
    clock: ArchiveRolloverClock
  ) throws -> ArchiveControlState {
    let payloads = try controlStore.scanResult.records.map {
      try ArchiveControlPayloadCodec.decode($0.plaintext)
    }
    let replay = try ArchiveControlReplay.validate(payloads)
    guard plan.commandID == plan.recomputedCommandID else {
      throw ArchiveRolloverError.planHistoryMismatch
    }
    let conflicting = replay.contains { commandID, command in
      commandID != plan.commandID && command.commandKind == .rollover
    }
    guard !conflicting else { throw ArchiveRolloverError.planHistoryMismatch }
    if let command = replay[plan.commandID] {
      guard command.commandKind == .rollover, command.sessionID == plan.sessionID,
        command.rolloverPlan == plan
      else {
        throw ArchiveRolloverError.planHistoryMismatch
      }
      return command.state
    }
    return try append(
      state: .rolloverIntent,
      prior: nil,
      plan: plan,
      controlStore: controlStore,
      clock: clock,
      persistedPlan: plan)
  }

  public static func recoverPendingPlan(controlStore: ArchiveDerivedStore) throws
    -> ArchiveRolloverPlan?
  {
    let payloads = try controlStore.scanResult.records.map {
      try ArchiveControlPayloadCodec.decode($0.plaintext)
    }
    let replay = try ArchiveControlReplay.validate(payloads)
    let pending = replay.values.filter {
      $0.commandKind == .rollover && $0.state != .rolloverComplete
        && $0.state != .rolloverFailed
    }
    guard pending.count <= 1 else { throw ArchiveRolloverError.planHistoryMismatch }
    guard let command = pending.first, let plan = command.rolloverPlan else { return nil }
    guard plan.commandID == plan.recomputedCommandID, command.sessionID == plan.sessionID else {
      throw ArchiveRolloverError.planHistoryMismatch
    }
    return plan
  }

  @discardableResult
  public static func resumePersisted(
    controlStore: ArchiveDerivedStore,
    effects: ArchiveRolloverEffects,
    clock: ArchiveRolloverClock
  ) throws -> ArchiveControlState? {
    guard let plan = try recoverPendingPlan(controlStore: controlStore) else { return nil }
    return try resume(plan: plan, controlStore: controlStore, effects: effects, clock: clock)
  }

  @discardableResult
  public static func resume(
    plan: ArchiveRolloverPlan,
    controlStore: ArchiveDerivedStore,
    effects: ArchiveRolloverEffects,
    clock: ArchiveRolloverClock
  ) throws -> ArchiveControlState {
    let payloads = try controlStore.scanResult.records.map {
      try ArchiveControlPayloadCodec.decode($0.plaintext)
    }
    let replay = try ArchiveControlReplay.validate(payloads)
    guard plan.commandID == plan.recomputedCommandID else {
      throw ArchiveRolloverError.planHistoryMismatch
    }
    let conflicting = replay.contains { commandID, command in
      commandID != plan.commandID && command.commandKind == .rollover
    }
    guard !conflicting else { throw ArchiveRolloverError.planHistoryMismatch }
    if let command = replay[plan.commandID] {
      guard command.commandKind == .rollover, command.sessionID == plan.sessionID,
        command.rolloverPlan == plan
      else {
        throw ArchiveRolloverError.planHistoryMismatch
      }
    }

    var state = replay[plan.commandID]?.state
    while true {
      switch state {
      case nil:
        state = try persistIntent(plan: plan, controlStore: controlStore, clock: clock)
      case .rolloverIntent:
        try perform(
          kind: .reserveOldDayFinal,
          state: .rolloverIntent,
          operation: effects.reserveOldDayFinal,
          plan: plan,
          controlStore: controlStore,
          clock: clock)
        state = try append(
          state: .oldDayFinalReserved, prior: state, plan: plan,
          controlStore: controlStore, clock: clock)
      case .oldDayFinalReserved:
        try perform(
          kind: .closeOldDayFiles,
          state: .oldDayFinalReserved,
          operation: effects.closeOldDayFiles,
          plan: plan,
          controlStore: controlStore,
          clock: clock)
        state = try append(
          state: .oldDayFilesClosed, prior: state, plan: plan,
          controlStore: controlStore, clock: clock)
      case .oldDayFilesClosed:
        try perform(
          kind: .makeNewDayFilesDurable,
          state: .oldDayFilesClosed,
          operation: effects.makeNewDayFilesDurable,
          plan: plan,
          controlStore: controlStore,
          clock: clock)
        state = try append(
          state: .newDayFilesDurable, prior: state, plan: plan,
          controlStore: controlStore, clock: clock)
      case .newDayFilesDurable:
        state = try append(
          state: .rolloverComplete, prior: state, plan: plan,
          controlStore: controlStore, clock: clock)
      case .rolloverComplete:
        return .rolloverComplete
      case .rolloverFailed:
        throw ArchiveRolloverError.failedControlState
      default:
        throw ArchiveRolloverError.planHistoryMismatch
      }
    }
  }

  private static func perform(
    kind: ArchiveRolloverEffectKind,
    state: ArchiveControlState,
    operation: @Sendable (ArchiveRolloverPlan) throws -> ArchiveRolloverEffectReceipt,
    plan: ArchiveRolloverPlan,
    controlStore: ArchiveDerivedStore,
    clock: ArchiveRolloverClock
  ) throws {
    do {
      let receipt = try operation(plan)
      guard receipt.kind == kind, receipt.commandID == plan.commandID,
        ArchiveDailyLaneIdentity.isLowercaseDigest(receipt.expectedDurableDigestHex),
        receipt.observedDurableDigestHex == receipt.expectedDurableDigestHex
      else {
        throw ArchiveRolloverEffectFailure.authenticationFailed
      }
    } catch let crash as any ArchiveRolloverProcessCrashSignal {
      throw crash
    } catch {
      let failure = controlFailure(for: error)
      _ = try append(
        state: .rolloverFailed,
        prior: state,
        plan: plan,
        controlStore: controlStore,
        clock: clock,
        error: failure)
      throw ArchiveRolloverError.effectFailed(failure)
    }
  }

  private static func controlFailure(for error: Error) -> ArchiveControlFailure {
    if let failure = error as? ArchiveRolloverEffectFailure,
      failure == .authenticationFailed
    {
      return .authenticationFailed
    }
    if let failure = error as? ArchiveCryptoError, failure == .authenticationFailed {
      return .authenticationFailed
    }
    if let failure = error as? ArchiveKeyLifecycleError,
      failure == .archiveKeyUnavailable
    {
      return .authenticationFailed
    }
    return .internalIOFailed
  }

  private static func append(
    state: ArchiveControlState,
    prior: ArchiveControlState?,
    plan: ArchiveRolloverPlan,
    controlStore: ArchiveDerivedStore,
    clock: ArchiveRolloverClock,
    error: ArchiveControlFailure? = nil,
    persistedPlan: ArchiveRolloverPlan? = nil
  ) throws -> ArchiveControlState {
    let timestamp = clock.now()
    let payload = try ArchiveControlPayload(
      commandID: plan.commandID,
      commandKind: .rollover,
      sessionID: plan.sessionID,
      priorState: prior,
      newState: state,
      atMonoNS: timestamp.monotonicNS,
      atWallNS: timestamp.wallNS,
      error: error,
      rolloverPlan: persistedPlan
    )
    let position = controlStore.scanResult.records.count
    _ = try controlStore.append(
      plaintext: ArchiveControlPayloadCodec.encode(payload),
      firstLogicalUnit: UInt64(position),
      logicalUnitCount: 1
    )
    return state
  }
}

extension ArchiveRolloverPlan {
  fileprivate var recomputedCommandID: String {
    Self.makeCommandID(
      sessionID: sessionID,
      sessionSampleStart: sessionSampleStart,
      preparationID: preparationID,
      primary: primary,
      backup: backup,
      oldControl: oldControl,
      newControl: newControl)
  }
}
