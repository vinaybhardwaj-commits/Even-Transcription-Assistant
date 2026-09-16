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
public struct URLSessionTransport: HTTPTransport {
    let session: URLSession
    let timeout: TimeInterval

    public init(timeout: TimeInterval = 60) {
        let configuration = URLSessionConfiguration.ephemeral
        // No cookie jar and no cache: the session cookie is set explicitly on every request (RoomEngine.swift:637) and
        // a cached poll answer would be a room acting on commands it was already given.
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: configuration)
        self.timeout = timeout
    }

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
