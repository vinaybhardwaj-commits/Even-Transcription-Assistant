import FleetCore
import Foundation
import HelperCore
import Security

/// The app's side of the fleet client (TS-H3 #40 / TS-H4 #41): where the key lives, how requests
/// leave the Mac, where state is kept, and how a verified command reaches the engine.

/// The device key, in the login keychain under its own service name. The seed is never logged and
/// never leaves this type except into `FleetSigningKey`.
public struct KeychainFleetKeyStore: FleetKeyStore, @unchecked Sendable {
  public static let service = "com.evenscribe.room-recorder.fleet-device"
  public static let account = "ed25519-seed"

  let service: String
  let account: String
  /// Nil: the default (login) keychain, which is what the resident app uses in the user's session.
  /// A test passes a throwaway keychain, because a session outside the GUI login cannot use the login one.
  let keychain: SecKeychain?

  public init(
    service: String = KeychainFleetKeyStore.service, account: String = KeychainFleetKeyStore.account,
    keychain: SecKeychain? = nil
  ) {
    self.service = service
    self.account = account
    self.keychain = keychain
  }

  public func loadOrCreate() throws -> FleetSigningKey {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: account, kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    if let keychain { query[kSecMatchSearchList as String] = [keychain] }
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecSuccess, let data = item as? Data { return try FleetSigningKey(seed: data) }
    guard status == errSecItemNotFound else { throw FleetKeychainError.read(status) }
    let key = FleetSigningKey.generate()
    var add: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: account, kSecValueData as String: key.seed,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      kSecAttrSynchronizable as String: false,
    ]
    if let keychain { add[kSecUseKeychain as String] = keychain }
    let added = SecItemAdd(add as CFDictionary, nil)
    guard added == errSecSuccess else { throw FleetKeychainError.write(added) }
    return key
  }
}

extension KeychainFleetKeyStore {
  /// 0.1.39.1. The ONE keychain read the file store may make, and only when its file is absent. It cannot raise a prompt:
  /// `kSecUseAuthenticationUIFail` for data-protection items and `SecKeychainSetUserInteractionAllowed(false)` for the
  /// legacy partition prompt this item raises (the same pair `RoomKeychain.load` uses, B1.5 K1). It never writes,
  /// updates or deletes the item. A mismatch returns `errSecInteractionNotAllowed` in microseconds.
  public static func readSeedNonInteractive(
    service: String = KeychainFleetKeyStore.service, account: String = KeychainFleetKeyStore.account
  ) throws -> Data {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: account, kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne, kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
    ]
    var item: CFTypeRef?
    let status = withoutUserInteraction { SecItemCopyMatching(query as CFDictionary, &item) }
    guard status == errSecSuccess else { throw FleetKeychainError.read(status) }
    guard let data = item as? Data else { throw FleetKeychainError.read(errSecDecode) }
    return data
  }

  @available(macOS, deprecated: 10.10, message: "the only switch for the legacy partition prompt (B1.5 K1)")
  private static func withoutUserInteraction<T>(_ body: () -> T) -> T {
    var previous: DarwinBoolean = true
    let read = SecKeychainGetUserInteractionAllowed(&previous)
    SecKeychainSetUserInteractionAllowed(false)
    defer { if read == errSecSuccess { SecKeychainSetUserInteractionAllowed(previous.boolValue) } }
    return body()
  }
}

/// 0.1.39.1. The fleet device key, in `<room root>/fleet-key.json` (0600, owned by the room user, written atomically).
///
/// WHY: the keychain item was written by one build and its partition list holds that build's cdhash (the signing
/// identity has no Team ID), so the next build's `SecItemCopyMatching` put up a prompt nobody could click and blocked
/// for ever inside the FleetClient actor (OPD 6, 13 Oct). Same failure, same cure as `RoomSessionStore` (B1.5).
///
/// THE KEYCHAIN IS READ AT MOST ONCE, only when the file is absent, never interactively, on its own thread, with a hard
/// deadline. What it answers decides the key:
/// - the seed: written to the file, never read from the keychain again;
/// - not found: a new key, as on a fresh install;
/// - unreadable without a person (-25308, -25293, -25315) or no answer in time: a new key, and `rotated`, so the client
///   drops the device id and registers a new device. The old id is never reused with a new key (KEY_CONFLICT);
/// - anything else: an error, no key made. The client retries every 300 s.
/// The old keychain item is never changed or deleted.
public final class FileFleetKeyStore: FleetKeyStore, @unchecked Sendable {
  public static let fileName = "fleet-key.json"
  /// The statuses that mean "the item is there and only a person could open it".
  static let needsPerson: Set<OSStatus> = [errSecInteractionNotAllowed, errSecAuthFailed, errSecInteractionRequired]

  struct Stored: Codable {
    let seed: String
    let algorithm: String
    let writtenBy: String
    let writtenAt: Date
    enum CodingKeys: String, CodingKey {
      case seed, algorithm
      case writtenBy = "written_by"
      case writtenAt = "written_at"
    }
  }

  let root: URL
  let keychainReader: @Sendable () throws -> Data
  let deadline: TimeInterval
  let log: @Sendable (String) -> Void
  let uid: UInt32
  private let lock = NSLock()

  public init(
    root: URL, keychainReader: @escaping @Sendable () throws -> Data = { try KeychainFleetKeyStore.readSeedNonInteractive() },
    deadline: TimeInterval = RoomSessionStore.keychainDeadline, uid: UInt32 = getuid(),
    log: @escaping @Sendable (String) -> Void
  ) {
    self.root = root
    self.keychainReader = keychainReader
    self.deadline = deadline
    self.uid = uid
    self.log = log
  }

  public var url: URL { root.appendingPathComponent(Self.fileName, isDirectory: false) }

  public func loadOrCreate() throws -> FleetSigningKey { try loadWithOrigin().key }

  public func loadWithOrigin() throws -> FleetKeyLoad {
    lock.lock(); defer { lock.unlock() }
    var wasRefused = false
    switch readFile() {
    case .ok(let key): return FleetKeyLoad(key: key, origin: .existing)
    case .refused(let why):
      // Unusable is treated as absent, and said. The key it held (if any) is unknown, so a replacement is a new identity.
      log("ignoring fleet-key.json: \(why)")
      wasRefused = true
    case .absent: break
    }
    do {
      let seed = try readKeychainWithDeadline()
      guard let key = try? FleetSigningKey(seed: seed) else { throw FleetKeychainError.read(errSecDecode) }
      try write(key)
      log("fleet key: moved from keychain to file")
      return FleetKeyLoad(key: key, origin: .existing)
    } catch let error as FleetKeychainError {
      guard case .read(let status) = error else { throw error }
      if status == errSecItemNotFound {
        let key = FleetSigningKey.generate()
        try write(key)
        return FleetKeyLoad(key: key, origin: wasRefused ? .rotated(reason: "file unusable") : .fresh)
      }
      if Self.needsPerson.contains(status) { return try rotate(reason: String(status)) }
      throw error
    } catch let error as KeyDeadline {
      _ = error
      return try rotate(reason: "timeout")
    }
  }

  private func rotate(reason: String) throws -> FleetKeyLoad {
    let key = FleetSigningKey.generate()
    try write(key)
    return FleetKeyLoad(key: key, origin: .rotated(reason: reason))
  }

  struct KeyDeadline: Error {}

  private final class Box: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<Data, Error>?
    func set(_ r: Result<Data, Error>) { lock.lock(); result = r; lock.unlock() }
    var value: Result<Data, Error>? { lock.lock(); defer { lock.unlock() }; return result }
  }

  /// A timed-out thread is left where it is: it is parked inside securityd and cannot be killed.
  private func readKeychainWithDeadline() throws -> Data {
    let box = Box()
    let done = DispatchSemaphore(value: 0)
    let reader = keychainReader
    Thread.detachNewThread {
      box.set(Result { try reader() })
      done.signal()
    }
    guard done.wait(timeout: .now() + deadline) == .success, let result = box.value else { throw KeyDeadline() }
    return try result.get()
  }

  enum FileOutcome {
    case ok(FleetSigningKey)
    case refused(String)
    case absent
  }

  func readFile() -> FileOutcome {
    let path = url.path
    guard FileManager.default.fileExists(atPath: path) else { return .absent }
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: path) else {
      return .refused("its attributes could not be read")
    }
    guard attributes[.type] as? FileAttributeType == .typeRegular else { return .refused("it is not a regular file") }
    guard let mode = (attributes[.posixPermissions] as? NSNumber)?.uint16Value, mode == 0o600 else {
      let mode = (attributes[.posixPermissions] as? NSNumber)?.uint16Value ?? 0
      return .refused("its mode is \(String(mode, radix: 8)), not 600")
    }
    guard let owner = (attributes[.ownerAccountID] as? NSNumber)?.uint32Value, owner == uid else {
      return .refused("it is owned by another user")
    }
    guard let data = try? Data(contentsOf: url) else { return .refused("it could not be read") }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    guard let stored = try? decoder.decode(Stored.self, from: data), stored.algorithm == "ed25519",
      let seed = Data(base64Encoded: stored.seed), let key = try? FleetSigningKey(seed: seed)
    else { return .refused("it is not the JSON this app writes") }
    return .ok(key)
  }

  /// Atomic: a temporary, chmod 0600 BEFORE the rename, then renamed over the file. No reader sees it at 0644.
  func write(_ key: FleetSigningKey) throws {
    let stored = Stored(
      seed: key.seed.base64EncodedString(), algorithm: "ed25519", writtenBy: BuildInfo.appVersion ?? "unbundled",
      writtenAt: Date())
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    let data = try encoder.encode(stored)
    let temporary = root.appendingPathComponent("\(Self.fileName).\(UUID().uuidString).tmp", isDirectory: false)
    try data.write(to: temporary, options: [.atomic])
    defer { try? FileManager.default.removeItem(at: temporary) }
    try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o600)], ofItemAtPath: temporary.path)
    _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary, backupItemName: nil, options: .usingNewMetadataOnly)
    try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o600)], ofItemAtPath: url.path)
  }
}

public enum FleetKeychainError: Error, Equatable, CustomNSError {
  case read(OSStatus)
  case write(OSStatus)

  public static var errorDomain: String { "FleetKeychain" }
  /// The Security status itself, so a log line says `-25308` and not a case number.
  public var errorCode: Int {
    switch self {
    case .read(let status), .write(let status): return Int(status)
    }
  }
}

/// `fleet-state.json` in the app root, private to the user. Holds the device id, the last 1,000
/// nonces and recent result bodies: nothing secret, no PHI.
public struct FileFleetStateStore: FleetStateStore {
  let url: URL
  public init(root: URL) { url = root.appendingPathComponent("fleet-state.json", isDirectory: false) }

  public func load() -> FleetState {
    guard let data = try? Data(contentsOf: url), let state = try? JSONDecoder().decode(FleetState.self, from: data)
    else { return FleetState() }
    return state
  }

  public func save(_ state: FleetState) {
    guard let data = try? JSONEncoder().encode(state) else { return }
    try? data.write(to: url, options: .atomic)
    try? FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o600)], ofItemAtPath: url.path)
  }
}

/// HTTPS to the app's origin, outbound only; the system proxy applies.
public struct URLSessionFleetTransport: FleetTransport {
  let origin: URL
  let session: URLSession

  public init(origin: URL) {
    self.origin = origin
    let configuration = URLSessionConfiguration.ephemeral
    configuration.waitsForConnectivity = false
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    session = URLSession(configuration: configuration)
  }

  public func send(_ request: FleetRequest) async throws -> FleetResponse {
    guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { throw URLError(.badURL) }
    components.path = request.path
    components.queryItems = request.query.isEmpty ? nil : request.query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
    guard let url = components.url, url.scheme == "https" || url.host == "localhost" else { throw URLError(.badURL) }
    var urlRequest = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: request.timeout)
    urlRequest.httpMethod = request.method
    urlRequest.httpBody = request.body
    for (name, value) in request.headers { urlRequest.setValue(value, forHTTPHeaderField: name) }
    let (data, response) = try await session.data(for: urlRequest)
    return FleetResponse(status: (response as? HTTPURLResponse)?.statusCode ?? 0, body: data)
  }
}

/// Runs a verified command. App verbs go through the engine. Helper verbs go to the root helper over XPC as the
/// SIGNED ENVELOPE, which the helper verifies again for itself; the app's word is not what the helper trusts.
/// What the executor needs of the engine, so a test can stand in for it.
protocol FleetAppVerbRunning: Sendable {
  var fleetSessionOpen: Bool { get async }
  func runFleetAppVerb(_ verb: FleetVerb, params: FleetParams, commandID: String) async -> FleetExecResult
}

extension RoomEngine: FleetAppVerbRunning {}

struct EngineFleetExecutor: FleetExecutor {
  let engine: any FleetAppVerbRunning
  var helper: @Sendable () -> HelperClient = { HelperClient() }
  /// How long to wait for the helper's answer; a coreaudiod reset or a power change can take a few seconds.
  var helperTimeout: TimeInterval = 40

  func execute(_ verb: FleetVerb, params: FleetParams, envelope: FleetEnvelope) async -> FleetExecResult {
    if !verb.runsOnHelper || verb == .restartRecorder {
      // restart_recorder is the app's own `restart_engine` (exits after the result is posted); see the engine.
      return await engine.runFleetAppVerb(verb, params: params, commandID: envelope.cmdID)
    }
    let timeout = helperTimeout
    if verb == .reloadLaunchagent {
      // The helper boots this very app out, so the answer is posted FIRST and the helper is asked afterwards.
      let forward = { @Sendable in
        _ = await Task.detached { helper().runSignedCommand(envelope: envelope.forwardJSON, deviceID: envelope.deviceID, machine: envelope.machine, timeout: timeout) }.value
      }
      return FleetExecResult(outcome: .ok, detail: ["reloading": .bool(true)], afterResultPosted: forward)
    }
    let reply = await Task.detached {
      helper().runSignedCommand(envelope: envelope.forwardJSON, deviceID: envelope.deviceID, machine: envelope.machine, timeout: timeout)
    }.value
    return Self.result(from: reply)
  }

  /// The helper's `outcome`, `reason` and `detail_json`, back into a result. No answer is `helper_unreachable`.
  static func result(from reply: HelperResponse?) -> FleetExecResult {
    guard let reply else { return FleetExecResult(outcome: .failed, reason: "helper_unreachable") }
    let reason = reply.detail["reason"].flatMap { $0.isEmpty ? nil : $0 }
    let detail =
      reply.detail["detail_json"].flatMap { try? FleetJSON.parse(Data($0.utf8)).objectValue } ?? [:]
    switch reply.detail["outcome"] {
    case "ok": return FleetExecResult(outcome: .ok, reason: reason, detail: detail)
    case "unsupported": return FleetExecResult(outcome: .unsupported, reason: reason, detail: detail)
    case "refused": return FleetExecResult(outcome: .failed, reason: "helper_refused_" + (reason ?? "unknown"), detail: detail)
    default: return FleetExecResult(outcome: .failed, reason: reason ?? "helper_failed", detail: detail)
    }
  }
}

public enum FleetBootstrap {
  /// The app's local gate state, read FRESH at each command: an open session is what stops a reset or a restart.
  static func gateProvider(_ app: any FleetAppVerbRunning) -> @Sendable () async -> FleetGateState {
    { FleetGateState(sessionOpen: await app.fleetSessionOpen) }
  }

  /// Starts the client when, and only when, `fleet_client_enabled` is true in config.json.
  public static func start(
    configuration: RoomConfiguration, root: URL, engine: RoomEngine,
    log: @escaping @Sendable (String) -> Void
  ) {
    guard configuration.fleetClientEnabled else {
      log("fleet client: off (fleet_client_enabled is not set)")
      return
    }
    guard let installID = configuration.installID, let machine = MachineFactsReader.hostname() else {
      log("fleet client: not started, install id or machine name is missing")
      return
    }
    let session = configuration.etaRoomSession
    let client = makeClient(
      config: FleetClientConfig(
        enabled: true, installID: installID, machine: machine, hwModel: MachineFactsReader.hardwareModel(),
        helperVersion: HelperStatusCache.shared.snapshot?.helperVersion),
      app: engine, transport: URLSessionFleetTransport(origin: configuration.origin), keys: FileFleetKeyStore(root: root, log: log),
      store: FileFleetStateStore(root: root), roomSession: { session }, log: log)
    log("fleet client: on")
    Task.detached { await client.run() }
    // #47: the kiosk-health events the helper spools go to the sink with this device's credential.
    let relay = KioskHealthRelay(sink: client, link: HelperKioskLink(), log: log)
    Task.detached { await relay.run() }
    // #49: the steward's repair tickets, fetched here (the app holds the credential) and verified and run by the helper.
    let stewards = StewardTicketRelay(
      source: client, link: HelperStewardLink(), deviceID: { FileFleetStateStore(root: root).load().deviceID }, log: log)
    Task.detached { await stewards.run() }
  }

  /// The one place the client is assembled, and the only one `start` uses. The gates and the executor are built
  /// HERE from `app`, so a caller cannot hand the client a gate that ignores the engine (0.1.35 R3 passed a
  /// constant `false` once, and nothing noticed). Everything else a test wants to replace is a parameter.
  static func makeClient(
    config: FleetClientConfig, app: any FleetAppVerbRunning, transport: FleetTransport, keys: FleetKeyStore,
    store: FleetStateStore, serverKeys: [String: Data] = FleetServerKeys.resolve(),
    roomSession: @escaping @Sendable () -> String?, clock: @escaping @Sendable () -> Date = { Date() },
    sleep: @escaping @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) },
    makeJTI: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() },
    log: @escaping @Sendable (String) -> Void
  ) -> FleetClient {
    FleetClient(
      config: config, transport: transport, keys: keys, store: store, executor: EngineFleetExecutor(engine: app),
      serverKeys: serverKeys, roomSession: roomSession, gates: gateProvider(app), clock: clock, sleep: sleep,
      makeJTI: makeJTI, log: log)
  }
}
