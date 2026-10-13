import Foundation
@testable import KioskHealthCore

// The standalone daemon's HTTP poster, kept as TEST SUPPORT only: R4/R5 drive Transport over real sockets with it. The helper
// binary carries no HTTP client of its own (it holds no server credential; the app posts).

/// Real poster. Only ever constructed when config.post == true; tests inject a fake instead.
final class URLSessionPoster: HTTPPoster {
    func post(url: URL, token: String?, body: Data) -> PostResult {
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let t = token, !t.isEmpty { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        req.httpBody = body
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 20
        cfg.timeoutIntervalForResource = 30
        let session = URLSession(configuration: cfg)
        let sem = DispatchSemaphore(value: 0)
        var result: PostResult = .failed(status: nil, reason: "no response")
        session.dataTask(with: req) { data, resp, err in
            if let e = err {
                result = .failed(status: nil, reason: e.localizedDescription)
            } else if let h = resp as? HTTPURLResponse {
                result = (200..<300).contains(h.statusCode) ? .ok(status: h.statusCode, body: data ?? Data())
                    : .failed(status: h.statusCode, reason: "http \(h.statusCode)")
            }
            sem.signal()
        }.resume()
        if sem.wait(timeout: .now() + 35) == .timedOut { result = .failed(status: nil, reason: "timeout") }
        session.invalidateAndCancel()
        return result
    }
}
