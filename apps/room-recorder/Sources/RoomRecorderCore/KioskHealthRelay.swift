import FleetCore
import Foundation
import HelperCore

/// #47 (0.1.36): the root helper runs the kiosk-health collectors and spools their events, but holds no server
/// credential. This is the app's half: ask the helper for the next batch, post it to `/api/kiosk-health` as the enrolled
/// device (the same device JWT the fleet client uses), and tell the helper what the sink answered. The helper applies the
/// answer with the standalone daemon's own rules (ack, halve on 413, quarantine on 400, pause on 401, back off).
/// Nothing is deleted from the helper's spool until the sink has said 2xx with its own reply.

/// The helper, as the relay sees it.
protocol KioskHelperLink: Sendable {
  /// nil: the helper did not answer, or does not know the verb (an older helper). `(id, body, count)`; count 0 = nothing to send.
  func batch() -> (id: String, body: Data, count: Int)?
  @discardableResult func report(batchID: String, status: Int, reason: String, body: String) -> Bool
}

/// The sink, as the relay sees it: one device-authenticated POST.
protocol KioskSinkPoster: Sendable {
  func post(_ body: Data) async -> (status: Int, body: Data)?
}

struct HelperKioskLink: KioskHelperLink {
  var helper: @Sendable () -> HelperClient = { HelperClient() }

  func batch() -> (id: String, body: Data, count: Int)? {
    guard let reply = helper().kioskBatch(), reply.ok, let count = reply.detail["count"].flatMap(Int.init) else { return nil }
    guard count > 0, let id = reply.detail["batch_id"], let body = reply.detail["body"] else { return (id: "", body: Data(), count: 0) }
    return (id, Data(body.utf8), count)
  }

  func report(batchID: String, status: Int, reason: String, body: String) -> Bool {
    helper().kioskReport(batchID: batchID, status: status, reason: reason, body: body)?.ok == true
  }
}

extension FleetClient: KioskSinkPoster {
  func post(_ body: Data) async -> (status: Int, body: Data)? {
    await postKioskHealth(body).map { ($0.status, $0.body) }
  }
}

struct KioskHealthRelay: Sendable {
  let sink: KioskSinkPoster
  let link: KioskHelperLink
  var sleep: @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }
  var log: @Sendable (String) -> Void = { _ in }
  /// Batches taken in one pass, so a long backlog cannot hold the loop for ever.
  static let batchesPerPass = 8
  static let interval: TimeInterval = 10
  /// An older helper that does not know the verb is asked again only this often.
  static let unsupportedInterval: TimeInterval = 300

  enum Pass: Equatable {
    case idle
    case sent(batches: Int)
    case stopped(String)
    case helperUnavailable
  }

  func run() async {
    while !Task.isCancelled {
      let pass = await passOnce()
      await sleep(pass == .helperUnavailable ? Self.unsupportedInterval : Self.interval)
    }
  }

  @discardableResult
  func passOnce() async -> Pass {
    var sent = 0
    for _ in 0..<Self.batchesPerPass {
      guard let batch = link.batch() else { return sent > 0 ? .sent(batches: sent) : .helperUnavailable }
      guard batch.count > 0 else { return sent > 0 ? .sent(batches: sent) : .idle }
      guard let answer = await sink.post(batch.body) else {
        // No HTTP answer at all: the helper backs off; this pass ends.
        link.report(batchID: batch.id, status: 0, reason: "offline", body: "")
        return .stopped("offline")
      }
      link.report(batchID: batch.id, status: answer.status, reason: "http \(answer.status)", body: Self.compactReply(answer.body))
      if !(200..<300).contains(answer.status), answer.status != 413, answer.status != 400 {
        log("kiosk-health sink answered \(answer.status); the helper will retry")
        return .stopped("http_\(answer.status)")
      }
      sent += 1
    }
    return .sent(batches: sent)
  }

  /// The sink's reply reduced to the fields the helper reads, at most a few hundred bytes. Empty when the body is not the
  /// sink's reply (a proxy page): the helper then treats a 2xx as a failure and keeps the events.
  static func compactReply(_ body: Data) -> String {
    guard let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any], let accepted = object["accepted"] as? NSNumber
    else { return "" }
    var reply: [String: Any] = ["accepted": accepted.intValue]
    reply["duplicates"] = (object["duplicates"] as? NSNumber)?.intValue ?? 0
    reply["rejected"] = (object["rejected"] as? NSNumber)?.intValue ?? 0
    if let reasons = object["rejected_reasons"] as? [Any] {
      reply["rejected_reasons"] = reasons.prefix(3).map { item -> String in
        let text = (item as? String) ?? ((try? JSONSerialization.data(withJSONObject: item)).map { String(decoding: $0, as: UTF8.self) } ?? "")
        return String(text.prefix(160))
      }
    }
    guard let data = try? JSONSerialization.data(withJSONObject: reply), data.count <= 3_000 else { return "" }
    return String(decoding: data, as: UTF8.self)
  }
}
