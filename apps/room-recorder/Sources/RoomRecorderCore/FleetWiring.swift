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

public enum FleetKeychainError: Error, Equatable {
  case read(OSStatus)
  case write(OSStatus)
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
    let client = FleetClient(
      config: FleetClientConfig(
        enabled: true, installID: installID, machine: machine, hwModel: MachineFactsReader.hardwareModel(),
        helperVersion: HelperStatusCache.shared.snapshot?.helperVersion),
      transport: URLSessionFleetTransport(origin: configuration.origin), keys: KeychainFleetKeyStore(),
      store: FileFleetStateStore(root: root),
      executor: EngineFleetExecutor(engine: engine),
      roomSession: { session }, gates: gateProvider(engine), log: log)
    log("fleet client: on")
    Task.detached { await client.run() }
  }
}
