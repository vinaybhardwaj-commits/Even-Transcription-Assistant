import FleetCore
import Foundation

/// The seam #40 plugs the outbound long-poll into. The helper starts it after the XPC listener is
/// up and stops it on shutdown. This slice ships the null implementation: the helper opens no
/// outbound connection.
public protocol HelperControlChannel: AnyObject {
  func start()
  func stop()
}

public final class NullControlChannel: HelperControlChannel {
  public init() {}
  public func start() {}
  public func stop() {}
}

/// Turns a request into a response. Pure: no I/O, no clock, so a test can drive it with bytes.
///
/// In this slice only `hello` and `helperStatus` do anything. The other three verbs are decoded,
/// allow-listed and then answered `not_implemented`; "no root work beyond hello" (#39).
public final class HelperService: @unchecked Sendable {
  public let safeMode: Bool
  private let runner: HelperCommandRunner?
  private let statusDetail: (@Sendable () -> [String: String])?

  public init(
    safeMode: Bool, runner: HelperCommandRunner? = nil, statusDetail: (@Sendable () -> [String: String])? = nil
  ) {
    self.safeMode = safeMode
    self.runner = runner
    self.statusDetail = statusDetail
  }

  public func handle(_ request: Data) -> Data {
    do {
      return respond(to: try HelperCodec.decode(request)).encoded()
    } catch let refusal as HelperRefusal {
      return HelperResponse(ok: false, code: refusal.rawValue).encoded()
    } catch {
      return HelperResponse(ok: false, code: HelperRefusal.malformed.rawValue).encoded()
    }
  }

  func respond(to command: HelperCommand) -> HelperResponse {
    var base = [
      "helper_version": HelperIdentity.helperVersion,
      "safe_mode": safeMode ? "true" : "false",
    ]
    switch command {
    case .hello:
      return HelperResponse(ok: true, code: "ok", detail: base)
    case .helperStatus:
      for (key, value) in statusDetail?() ?? [:] { base[key] = value }
      return HelperResponse(ok: true, code: "ok", detail: base)
    case .runSignedCommand(let envelope, let deviceID, let machine):
      guard let runner else { return HelperResponse(ok: false, code: "not_implemented", detail: base) }
      let outcome = runner.run(envelopeJSON: envelope, deviceID: deviceID, machine: machine)
      var detail = base
      detail["outcome"] = outcome.kind.rawValue
      detail["reason"] = outcome.reason ?? ""
      detail["detail_json"] = FleetJSON.object(outcome.detail).canonical
      return HelperResponse(ok: outcome.kind == .ok, code: outcome.reason ?? outcome.kind.rawValue, detail: detail)
    case .appStatus, .runAppVerb, .requestBundleUpdate:
      return HelperResponse(ok: false, code: "not_implemented", detail: base)
    }
  }
}

/// Crash-loop bookkeeping (#39: safe mode after 3 crash loops). A launch that is not followed by
/// a stable minute or a clean exit counts against the helper; the third unstable launch in a row
/// starts it in safe mode.
public struct LaunchLedger: Codable, Equatable, Sendable {
  public var unstableLaunches: Int = 0
  public static let safeModeThreshold = 3

  public init(unstableLaunches: Int = 0) { self.unstableLaunches = unstableLaunches }

  /// Called at start. Returns whether THIS launch is a safe-mode launch, and records it.
  public mutating func recordLaunch() -> Bool {
    let safe = unstableLaunches >= Self.safeModeThreshold
    unstableLaunches += 1
    return safe
  }

  public mutating func recordStable() { unstableLaunches = 0 }

  public static func load(from url: URL) -> LaunchLedger {
    guard let data = try? Data(contentsOf: url),
      let ledger = try? JSONDecoder().decode(LaunchLedger.self, from: data)
    else { return LaunchLedger() }
    return ledger
  }

  public func save(to url: URL) {
    guard let data = try? JSONEncoder().encode(self) else { return }
    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? data.write(to: url, options: .atomic)
  }
}
