import Darwin
import Foundation
import Security

// Encounter Buddy, L1 (0.1.41) — the recorder's tap.
//
// ─── WHAT THIS IS ──────────────────────────────────────────────────────────────────────────────
// A read-only window onto the audio the recorder has ALREADY made durable. The tap lives inside the app (not the
// root helper): the app owns `tape.pcm`, the helper runs as root and must never serve audio, and a second
// process would need its own way to find the current capture.
//
// ─── WHAT IT MAY NOT DO (Fable A1-C5, A2-C17, C2) ───────────────────────────────────────────────
//  * Bind anywhere but 127.0.0.1. There is no configuration for the address.
//  * Serve a byte without the per-boot token. The token is 256 random bits, held in memory and in a 0600 file in the
//    room root for the local Buddy process to read; it is never logged, never in status.json, never in kiosk-health.
//  * Write audio. The only file it writes is the token file, and it deletes that when the consult ends.
//  * Open CoreAudio, start a second capture, or change what the cloud path reads. It opens `tape.pcm` O_RDONLY.
//  * Call a model or Sarvam. L1 has none.

/// 256 bits from the system CSPRNG as 64 lowercase hex characters. Nil when the CSPRNG fails: the tap then refuses to
/// start rather than fall back to something guessable.
enum BuddyToken {
  static func make() -> String? {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
    return bytes.map { String(format: "%02x", $0) }.joined()
  }

  /// Compares in time independent of where the first difference is.
  static func matches(_ presented: String, _ expected: String) -> Bool {
    let a = Array(presented.utf8), b = Array(expected.utf8)
    var difference = UInt8(a.count == b.count ? 0 : 1)
    for index in 0..<max(a.count, b.count) {
      difference |= (index < a.count ? a[index] : 0) ^ (index < b.count ? b[index] : 0)
    }
    return difference == 0
  }
}

/// What the page and the tap are allowed to know. Written by the engine on its own loop, read by the server threads.
public final class BuddyStateBox: @unchecked Sendable {
  public struct Snapshot: Equatable, Sendable {
    /// True only while a session is open and recording. Never inferred from anything else.
    public var recording: Bool
    /// `authorized`, `denied` or `input_device_not_ready`, kept SEPARATE from `recording` (Fable A2-C4).
    public var micState: String
    /// The current capture's `tape.pcm`, or nil when no plain capture is running.
    public var pcmURL: URL?
    public var segmentID: String?

    public init(recording: Bool = false, micState: String = "unknown", pcmURL: URL? = nil, segmentID: String? = nil) {
      self.recording = recording
      self.micState = micState
      self.pcmURL = pcmURL
      self.segmentID = segmentID
    }
  }

  private let lock = NSLock()
  private var value = Snapshot()
  public init() {}
  public var snapshot: Snapshot { lock.withLock { value } }
  public func set(_ snapshot: Snapshot) { lock.withLock { value = snapshot } }
}

/// The server. One instance per consult; a new port each time.
public final class BuddyTapServer: @unchecked Sendable {
  public static let maxChunkBytes = 256 * 1024
  /// An opaque id is what newcat mints for one consult. The shape is INFERRED (the server relay is not built yet):
  /// letters, digits, `_` and `-`, 1 to 64 characters. Nothing else is ever written into the page or the log.
  public static func isValidOpaqueID(_ value: String) -> Bool {
    guard (1...64).contains(value.utf8.count) else { return false }
    return value.utf8.allSatisfy {
      ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || $0 == 0x5F || $0 == 0x2D
    }
  }

  private let token: String
  private let opaqueID: String
  private let state: BuddyStateBox
  private let lock = NSLock()
  private var listenFD: Int32 = -1
  private var stopped = false
  private var serving = true
  private let work = DispatchQueue(label: "buddy.tap.connections", attributes: .concurrent)

  public private(set) var port: UInt16 = 0

  init(token: String, opaqueID: String, state: BuddyStateBox) {
    self.token = token
    self.opaqueID = opaqueID
    self.state = state
  }

  deinit { stop() }

  /// Binds 127.0.0.1 on an ephemeral port and starts accepting. Throws when the socket cannot be made.
  func start() throws -> UInt16 {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { throw RoomEngineError.io("buddy tap: socket failed (errno \(errno))") }
    var yes: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size))
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = 0
    address.sin_addr = in_addr(s_addr: UInt32(INADDR_LOOPBACK).bigEndian)  // 127.0.0.1, and never INADDR_ANY
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard bound == 0, listen(fd, 8) == 0 else {
      let code = errno
      close(fd)
      throw RoomEngineError.io("buddy tap: bind failed (errno \(code))")
    }
    var actual = sockaddr_in()
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &actual) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
    }
    port = UInt16(bigEndian: actual.sin_port)
    lock.withLock { listenFD = fd }
    let thread = Thread { [weak self] in self?.acceptLoop(fd) }
    thread.name = "buddy.tap.accept"
    thread.start()
    return port
  }

  func stop() {
    let fd: Int32 = lock.withLock {
      stopped = true
      let current = listenFD
      listenFD = -1
      return current
    }
    if fd >= 0 { close(fd) }
  }

  /// The kill switch and the consult end both land here: from now on every tap request is refused.
  func stopServing() { lock.withLock { serving = false } }
  var isServing: Bool { lock.withLock { serving && !stopped } }

  private func acceptLoop(_ fd: Int32) {
    while !lock.withLock({ stopped }) {
      var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
      let ready = poll(&descriptor, 1, 200)
      if ready <= 0 { continue }
      let client = accept(fd, nil, nil)
      if client < 0 { continue }
      work.async { [self] in
        handle(client)
        close(client)
      }
    }
  }

  // MARK: - One request

  private struct Request {
    var method = ""
    var path = ""
    var query: [String: String] = [:]
    var headers: [String: String] = [:]
  }

  private func handle(_ client: Int32) {
    var timeout = timeval(tv_sec: 2, tv_usec: 0)
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    guard let request = readRequest(client) else {
      respond(client, status: 400, body: Data("{\"error\":\"bad_request\"}".utf8), type: "application/json")
      return
    }
    // DNS rebinding: a page on the open web must not reach this port under its own name.
    let host = (request.headers["host"] ?? "").lowercased()
    guard host == "127.0.0.1:\(port)" || host == "localhost:\(port)" else {
      respond(client, status: 403, body: Data("{\"error\":\"host\"}".utf8), type: "application/json")
      return
    }
    guard request.method == "GET" else {
      respond(client, status: 405, body: Data("{\"error\":\"method\"}".utf8), type: "application/json")
      return
    }
    if request.path == "/encounter/\(opaqueID)" {
      respondPage(client)
    } else if request.path == "/encounter/\(opaqueID)/state" {
      respondState(client)
    } else if request.path == "/tap/pcm" {
      respondTap(client, request)
    } else {
      respond(client, status: 404, body: Data("{\"error\":\"not_found\"}".utf8), type: "application/json")
    }
  }

  private func readRequest(_ client: Int32) -> Request? {
    var buffer = [UInt8]()
    var chunk = [UInt8](repeating: 0, count: 2048)
    while buffer.count < 8192 {
      let count = recv(client, &chunk, chunk.count, 0)
      if count <= 0 { return nil }
      buffer.append(contentsOf: chunk[0..<count])
      if String(decoding: buffer, as: UTF8.self).contains("\r\n\r\n") { break }
    }
    let text = String(decoding: buffer, as: UTF8.self)
    guard let head = text.components(separatedBy: "\r\n\r\n").first else { return nil }
    var lines = head.components(separatedBy: "\r\n")
    guard !lines.isEmpty else { return nil }
    let parts = lines.removeFirst().split(separator: " ")
    guard parts.count == 3 else { return nil }
    var request = Request()
    request.method = String(parts[0])
    let target = String(parts[1])
    if let mark = target.firstIndex(of: "?") {
      request.path = String(target[..<mark])
      for pair in target[target.index(after: mark)...].split(separator: "&") {
        let kv = pair.split(separator: "=", maxSplits: 1)
        if kv.count == 2 { request.query[String(kv[0])] = String(kv[1]) }
      }
    } else {
      request.path = target
    }
    for line in lines {
      guard let colon = line.firstIndex(of: ":") else { continue }
      request.headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
    }
    return request
  }

  private func respond(_ client: Int32, status: Int, body: Data, type: String, extra: [String: String] = [:]) {
    let reason: [Int: String] = [200: "OK", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 416: "Range Not Satisfiable"]
    var head = "HTTP/1.1 \(status) \(reason[status] ?? "Error")\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n"
    for (key, value) in extra { head += "\(key): \(value)\r\n" }
    head += "\r\n"
    var payload = Data(head.utf8)
    payload.append(body)
    payload.withUnsafeBytes { raw in
      var sent = 0
      while sent < raw.count {
        let n = send(client, raw.baseAddress!.advanced(by: sent), raw.count - sent, 0)
        if n <= 0 { return }
        sent += n
      }
    }
  }

  // MARK: - Routes

  private func respondState(_ client: Int32) {
    let snapshot = state.snapshot
    let live = isServing
    let body =
      "{\"opaque_id\":\"\(opaqueID)\",\"recording\":\(live && snapshot.recording ? "true" : "false"),\"mic_state\":\"\(snapshot.micState)\"}"
    respond(client, status: 200, body: Data(body.utf8), type: "application/json")
  }

  private func respondPage(_ client: Int32) {
    respond(
      client, status: 200, body: Data(BuddyPage.html(opaqueID: opaqueID).utf8), type: "text/html; charset=utf-8",
      extra: ["Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'"])
  }

  /// `GET /tap/pcm?from=<byte>&max=<bytes>` with `Authorization: Bearer <token>`.
  /// The token is checked FIRST, so a stranger learns nothing, not even whether a consult is live.
  private func respondTap(_ client: Int32, _ request: Request) {
    let presented = (request.headers["authorization"] ?? "").replacingOccurrences(of: "Bearer ", with: "")
    guard request.headers["authorization"]?.hasPrefix("Bearer ") == true, BuddyToken.matches(presented, token) else {
      respond(client, status: 401, body: Data("{\"error\":\"unauthorized\"}".utf8), type: "application/json")
      return
    }
    guard isServing else {
      respond(client, status: 403, body: Data("{\"error\":\"buddy_off\"}".utf8), type: "application/json")
      return
    }
    let snapshot = state.snapshot
    guard let url = snapshot.pcmURL else {
      respond(client, status: 404, body: Data("{\"error\":\"no_capture\"}".utf8), type: "application/json")
      return
    }
    let from = Int64(request.query["from"] ?? "0") ?? -1
    let max = Int(request.query["max"] ?? "") ?? Self.maxChunkBytes
    guard from >= 0, max > 0 else {
      respond(client, status: 400, body: Data("{\"error\":\"bad_range\"}".utf8), type: "application/json")
      return
    }
    // O_RDONLY, and nothing else, ever.
    let fd = open(url.path, O_RDONLY)
    guard fd >= 0 else {
      respond(client, status: 404, body: Data("{\"error\":\"no_capture\"}".utf8), type: "application/json")
      return
    }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0 else {
      respond(client, status: 404, body: Data("{\"error\":\"no_capture\"}".utf8), type: "application/json")
      return
    }
    let size = Int64(info.st_size) & ~Int64(1)  // whole samples only
    guard from <= size else {
      respond(client, status: 416, body: Data("{\"error\":\"past_end\"}".utf8), type: "application/json", extra: ["X-Tape-Size": "\(size)"])
      return
    }
    let count = Int(Swift.min(Int64(Swift.min(max, Self.maxChunkBytes)) & ~Int64(1), size - from))
    var bytes = [UInt8](repeating: 0, count: count)
    var read = 0
    while read < count {
      let n = bytes.withUnsafeMutableBytes { pread(fd, $0.baseAddress!.advanced(by: read), count - read, off_t(from) + off_t(read)) }
      if n <= 0 { break }
      read += n
    }
    respond(
      client, status: 200, body: Data(bytes[0..<read]), type: "application/octet-stream",
      extra: ["X-Tape-Segment": snapshot.segmentID ?? "", "X-Tape-Offset": "\(from)", "X-Tape-Size": "\(size)"])
  }
}

/// The page (Fable A2-C4 / A2-C18): recording, mic_state, the opaque id. Nothing else, and nothing from the room.
enum BuddyPage {
  static func html(opaqueID: String) -> String {
    // `opaqueID` is validated by `BuddyTapServer.isValidOpaqueID` before a server exists, so it carries no markup.
    """
    <!doctype html><html lang="en"><head><meta charset="utf-8"><title>Encounter Buddy</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
    body{font:15px -apple-system,system-ui,sans-serif;margin:0;padding:14px;color:#1d1d1f;background:#f5f5f7}
    h1{font-size:15px;margin:0 0 10px}
    .row{display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid #d2d2d7}
    .k{color:#6e6e73}.on{color:#1a7f37;font-weight:600}.off{color:#b3261e;font-weight:600}
    .id{font:12px ui-monospace,Menlo,monospace;color:#6e6e73;margin-top:10px;word-break:break-all}
    @media (prefers-color-scheme: dark){body{background:#1c1c1e;color:#f5f5f7}.row{border-color:#3a3a3c}.k,.id{color:#98989d}}
    </style></head><body>
    <h1>Encounter Buddy</h1>
    <div class="row"><span class="k">Recording</span><span id="rec" class="off">not recording</span></div>
    <div class="row"><span class="k">Microphone</span><span id="mic">&hellip;</span></div>
    <div class="id">\(opaqueID)</div>
    <script>
    async function tick(){
      try{
        const r=await fetch("/encounter/\(opaqueID)/state",{cache:"no-store"});
        const s=await r.json();
        const rec=document.getElementById("rec");
        rec.textContent=s.recording?"recording":"not recording";
        rec.className=s.recording?"on":"off";
        document.getElementById("mic").textContent=s.mic_state;
      }catch(e){}
    }
    tick();setInterval(tick,2000);
    </script></body></html>
    """
  }
}
