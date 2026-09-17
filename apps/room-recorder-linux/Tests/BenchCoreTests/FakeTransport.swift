import Foundation
@testable import BenchCore

/// Records every request and answers from a script, in order, keyed by "METHOD path".
final class FakeTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _requests: [HTTPRequest] = []
    private var responders: [(String, (HTTPRequest) throws -> HTTPResponse)] = []

    var requests: [HTTPRequest] { lock.withLock { _requests } }

    /// `route` is "METHOD /path" (query ignored) or "METHOD *" for any path.
    func on(_ route: String, _ respond: @escaping (HTTPRequest) throws -> HTTPResponse) {
        lock.withLock { responders.append((route, respond)) }
    }

    func onJSON(_ route: String, status: Int = 200, _ json: String) {
        on(route) { _ in HTTPResponse(status: status, body: Data(json.utf8)) }
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let responder: ((HTTPRequest) throws -> HTTPResponse)? = lock.withLock {
            _requests.append(request)
            let key = "\(request.method) \(request.url.path)"
            // Last registered wins, so a test can override a default.
            return responders.last(where: { $0.0 == key || $0.0 == "\(request.method) *" })?.1
        }
        guard let responder else { return HTTPResponse(status: 599, body: Data("no route \(request.method) \(request.url.path)".utf8)) }
        return try responder(request)
    }
}

func jsonObject(_ data: Data?) -> [String: Any] {
    guard let data, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return object
}

func queryItems(_ url: URL) -> [URLQueryItem] {
    URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
}
