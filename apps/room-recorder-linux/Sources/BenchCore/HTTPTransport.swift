import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// One HTTP exchange, stripped to what the Bench protocol uses. A seam so every request the client builds can be
/// asserted byte for byte without a network, and so the whole path can run against a local stub.
public struct HTTPRequest: Equatable, Sendable {
    public var method: String
    public var url: URL
    public var headers: [String: String]
    public var body: Data?

    public init(method: String, url: URL, headers: [String: String] = [:], body: Data? = nil) {
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body
    }
}

public struct HTTPResponse: Equatable, Sendable {
    public var status: Int
    /// Header names lower-cased: HTTP header names are case-insensitive and curl and a stub disagree on case.
    public var headers: [String: String]
    public var body: Data

    public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status
        self.headers = Dictionary(headers.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { a, _ in a })
        self.body = body
    }

    public var contentLength: Int64? { headers["content-length"].flatMap { Int64($0) } }
}

public protocol HTTPTransport: Sendable {
    /// Throws only for a TRANSPORT failure (no answer). Every HTTP status, 2xx or not, is a returned response.
    func send(_ request: HTTPRequest) async throws -> HTTPResponse
}

/// The production transport: FoundationNetworking's URLSession (libcurl underneath on Linux).
///
/// ─── ONE SESSION FOR THE WHOLE PROCESS, NEVER RELEASED ──────────────────────────────────────
/// swift-corelibs-foundation 6.3.3 aborts when a URLSession is deallocated while libcurl still monitors a cached
/// connection — which an HTTPS/HTTP-2 exchange with the Bench leaves behind. `_MultiHandle.deinit` calls
/// `curl_multi_cleanup` (FoundationNetworking/URLSession/libcurl/MultiHandle.swift:61); libcurl answers with a
/// socket-remove callback that reaches `_SocketSources.tearDown` (:130, :551), which queues
/// `cancelHandlerGroup.notify { handle.endOperation(...) }` (:571-573) holding a STRONG reference to the handle being
/// destroyed. That closure runs on another thread after deinit, and the runtime aborts with "_MultiHandle deallocated
/// with non-zero retain count 2". Measured 16 Sep 2026: a URLSession released after one HTTPS request to an HTTP/2 host
/// aborted 10 times in 10; one kept for the process aborted 0 in 10; plain HTTP/1.1 to 127.0.0.1 never aborts, which is
/// why the stub dry run did not see it. It aborted the first live `room-bench enrol` between the server's success and
/// the first write.
///
/// The cycle is inside corelibs and cannot be broken from here. What this code controls is whether that teardown ever
/// runs: every `URLSessionTransport` shares `processSession`, a static that is never released (process exit does not
/// deinitialise statics). The Mac uses `URLSession.shared` the same way. If corelibs is fixed, this can become per-instance
/// again; until then a second session must not be created and released anywhere in this binary.
public struct URLSessionTransport: HTTPTransport {
    static let processSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        // No cookie jar and no cache: the session cookie is set explicitly on every request (RoomEngine.swift:637) and
        // a cached poll answer would be a room acting on commands it was already given.
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    let timeout: TimeInterval

    public init(timeout: TimeInterval = 60) {
        self.timeout = timeout
    }

    var session: URLSession { Self.processSession }

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        var urlRequest = URLRequest(url: request.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        urlRequest.httpMethod = request.method
        for (name, value) in request.headers { urlRequest.setValue(value, forHTTPHeaderField: name) }
        urlRequest.httpBody = request.body
        let (data, response) = try await session.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            if let key = key as? String, let value = value as? String { headers[key.lowercased()] = value }
        }
        return HTTPResponse(status: http.statusCode, headers: headers, body: data)
    }
}
