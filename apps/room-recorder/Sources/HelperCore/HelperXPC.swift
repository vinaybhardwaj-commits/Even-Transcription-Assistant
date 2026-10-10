import Foundation
import Security
import ServiceManagement

/// One method, Data in and Data out. The closed protocol lives in `HelperCodec`, so the XPC
/// surface cannot grow a verb without passing through the allow-list.
@objc public protocol HelperXPCProtocol {
  func send(_ request: Data, reply: @escaping (Data) -> Void)
}

final class HelperXPCEndpoint: NSObject, HelperXPCProtocol {
  let service: HelperService
  init(service: HelperService) { self.service = service }
  func send(_ request: Data, reply: @escaping (Data) -> Void) { reply(service.handle(request)) }
}

/// Helper side. Every connection gets the peer requirement BEFORE it is resumed; a peer that does
/// not satisfy it has its messages dropped and the connection invalidated by the system.
public final class HelperListenerDelegate: NSObject, NSXPCListenerDelegate {
  private let endpoint: HelperXPCEndpoint
  private let requirement: String

  public init(service: HelperService, requirement: String = HelperIdentity.requirementForApp) {
    self.endpoint = HelperXPCEndpoint(service: service)
    self.requirement = requirement
  }

  public func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection)
    -> Bool
  {
    connection.setCodeSigningRequirement(requirement)
    connection.exportedInterface = NSXPCInterface(with: HelperXPCProtocol.self)
    connection.exportedObject = endpoint
    connection.resume()
    return true
  }
}

/// Static code-signing check on a file. Used by tests, and by anything that wants the same
/// question answered without a live connection.
public enum PeerRequirement {
  public static func isValid(_ requirement: String) -> Bool {
    var req: SecRequirement?
    return SecRequirementCreateWithString(requirement as CFString, [], &req) == errSecSuccess
  }

  /// True only when the code at `url` is validly signed AND satisfies `requirement`.
  public static func satisfies(codeAt url: URL, requirement: String) -> Bool {
    var req: SecRequirement?
    guard SecRequirementCreateWithString(requirement as CFString, [], &req) == errSecSuccess,
      let req
    else { return false }
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code else {
      return false
    }
    return SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: 0), req) == errSecSuccess
  }
}

/// App-side view of the helper, as the bench poll reports it.
public struct HelperSnapshot: Equatable, Sendable {
  public var registration: String
  public var helperVersion: String?
  public var xpcOK: Bool?
  /// `launchd` (a system LaunchDaemon the pkg installed), `smappservice` (the bundle's own daemon plist,
  /// registered by the app) or `none` (neither is there). Nil until the app has looked.
  public var mode: String?

  public init(registration: String, helperVersion: String?, xpcOK: Bool?, mode: String? = nil) {
    self.registration = registration
    self.helperVersion = helperVersion
    self.xpcOK = xpcOK
    self.mode = mode
  }
}

/// `SMAppService` status → the four strings #39 names.
public enum HelperRegistration {
  public static func name(_ status: SMAppService.Status) -> String {
    switch status {
    case .notRegistered: return "notRegistered"
    case .requiresApproval: return "requiresApproval"
    case .enabled: return "enabled"
    case .notFound: return "notFound"
    @unknown default: return "notFound"
    }
  }

  public static var service: SMAppService { SMAppService.daemon(plistName: HelperIdentity.daemonPlistName) }
}

/// App → helper client. The helper's identity is checked on the app's side of the connection.
public final class HelperClient: @unchecked Sendable {
  private let makeConnection: () -> NSXPCConnection
  private let requirement: String

  public init(
    machService: String = HelperIdentity.machServiceName,
    requirement: String = HelperIdentity.requirementForHelper
  ) {
    self.makeConnection = { NSXPCConnection(machServiceName: machService, options: .privileged) }
    self.requirement = requirement
  }

  /// For tests: connect to an in-process listener instead of the helper's mach service.
  init(endpoint: NSXPCListenerEndpoint, requirement: String) {
    self.makeConnection = { NSXPCConnection(listenerEndpoint: endpoint) }
    self.requirement = requirement
  }

  /// One hello. Nil on timeout, refusal or a peer that fails the requirement.
  public func hello(timeout: TimeInterval = 3) -> HelperResponse? {
    let connection = makeConnection()
    connection.remoteObjectInterface = NSXPCInterface(with: HelperXPCProtocol.self)
    connection.setCodeSigningRequirement(requirement)
    connection.resume()
    defer { connection.invalidate() }
    guard let request = try? HelperCodec.encode(.hello(clientVersion: nil)) else { return nil }
    let done = DispatchSemaphore(value: 0)
    let box = ResponseBox()
    let proxy = connection.remoteObjectProxyWithErrorHandler { _ in done.signal() }
    guard let remote = proxy as? HelperXPCProtocol else { return nil }
    remote.send(request) { data in
      box.value = HelperResponse.decode(data)
      done.signal()
    }
    _ = done.wait(timeout: .now() + timeout)
    return box.value
  }

  private final class ResponseBox: @unchecked Sendable { var value: HelperResponse? }
}
