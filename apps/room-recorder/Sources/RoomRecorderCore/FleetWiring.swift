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

/// Runs a verified command: app verbs through the engine, `helper_status` over XPC to the helper,
/// `collect_diag` not at all yet (the server's upload slice does not exist).
struct EngineFleetExecutor: FleetExecutor {
  let engine: RoomEngine

  func execute(_ verb: FleetVerb, params: FleetParams, commandID: String) async -> FleetExecResult {
    switch verb {
    case .helperStatus:
      let reply = await Task.detached { HelperClient().hello() }.value
      var detail: [String: FleetJSON] = [
        "registration": .string(HelperStatusCache.shared.snapshot?.registration ?? "unknown")
      ]
      guard let reply, reply.ok else {
        return FleetExecResult(outcome: .failed, reason: "helper_unreachable", detail: detail)
      }
      detail["helper_version"] = .string(reply.detail["helper_version"] ?? "")
      detail["safe_mode"] = .bool(reply.detail["safe_mode"] == "true")
      return FleetExecResult(outcome: .ok, detail: detail)
    case .collectDiag:
      // Validated (scope, log_lines) and then declined: there is no upload route to send a bundle to,
      // and a bundle that stays on the Mac helps nobody. The server sees why.
      return FleetExecResult(
        outcome: .unsupported, reason: "upload_not_available",
        detail: ["scope": params.raw["scope"] ?? .null])
    case .reportDiag, .selectAudioInput, .selfTest, .restartRecorder:
      return await engine.runFleetAppVerb(verb, params: params, commandID: commandID)
    }
  }
}

public enum FleetBootstrap {
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
      store: FileFleetStateStore(root: root), executor: EngineFleetExecutor(engine: engine),
      roomSession: { session }, gates: { FleetGateState(sessionOpen: await engine.fleetSessionOpen) }, log: log)
    log("fleet client: on")
    Task.detached { await client.run() }
  }
}
