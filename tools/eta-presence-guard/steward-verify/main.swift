import Foundation
import CryptoKit

// steward-verify <public.pem> <machine> <now_ms> < poll-response.json
//
// Implements the Room Steward ticket contract v1 (ETA-STEWARD-TICKET-CONTRACT-06-OCT-2026) for one poll response.
// First line of output:   ENV <key_id>                 the envelope is {"ok":true,"key_id":"6275a79b","tickets":[...]}
//                         ENVBAD <reason>              envelope_not_json | envelope_shape | key_id_mismatch (no ticket is processed)
// Then one TAB-separated line per ticket (first 10):
//   OK  ticket_id nonce action profile_b64|- expires_ms machine
//   BAD reason ticket_id|- nonce|- machine|-          reason, in the contract's check order, first failure wins:
//                                                      malformed, bad_signature, expired, action_not_allowed, bad_params, machine_mismatch
// The caller has already pinned the PEM by sha256. No network, no files other than the PEM, no secrets.
// Exit 0 when a response was understood; 2 for usage / unusable PEM.

func fail(_ code: Int32, _ msg: String) -> Never { FileHandle.standardError.write(Data((msg + "\n").utf8)); exit(code) }

let expectedKeyID = "6275a79b"
let keyRegex = try! NSRegularExpression(pattern: "\\A[a-z_][a-z0-9_]*\\z")
let tsRegex = try! NSRegularExpression(pattern: "\\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z\\z")
let nonceRegex = try! NSRegularExpression(pattern: "\\A[A-Za-z0-9_-]{22}\\z")
let sigRegex = try! NSRegularExpression(pattern: "\\A[A-Za-z0-9+/]{86}==\\z")
let safeRegex = try! NSRegularExpression(pattern: "\\A[A-Za-z0-9._:@+=-]{1,128}\\z")
let ticketKeys: Set<String> = ["v", "ticket_id", "machine", "action", "params", "issued_at", "expires_at", "nonce"]
let profileActions: Set<String> = ["open_pulse", "relaunch_chrome", "policy_cycle"]
let emptyActions: Set<String> = ["wake", "restart_recorder_app", "restart_kiosk_health"]

func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
    re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
}
func safe(_ v: Any?) -> String? { (v as? String).flatMap { matches(safeRegex, $0) ? $0 : nil } }

/// Every object key at any depth must match ^[a-z_][a-z0-9_]*$.
func keysOK(_ v: Any) -> Bool {
    if let d = v as? [String: Any] { return d.allSatisfy { matches(keyRegex, $0.key) && keysOK($0.value) } }
    if let a = v as? [Any] { return a.allSatisfy(keysOK) }
    return true
}

func isBool(_ n: NSNumber) -> Bool { CFGetTypeID(n) == CFBooleanGetTypeID() }

func epochMs(_ s: String) -> Int64? {
    guard matches(tsRegex, s) else { return nil }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let d = f.date(from: s) else { return nil }
    return Int64((d.timeIntervalSince1970 * 1000).rounded())
}

/// Strict standard base64, 88 chars (86 + "=="), alphabet A-Za-z0-9+/, 64 bytes, canonical (re-encodes to the input).
func strictSig(_ s: String) -> Data? {
    guard s.utf8.count == 88, matches(sigRegex, s), let d = Data(base64Encoded: s), d.count == 64,
          d.base64EncodedString() == s else { return nil }
    return d
}

func pemKey(_ path: String) -> Curve25519.Signing.PublicKey? {
    guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
    let body = text.split(separator: "\n").filter { !$0.hasPrefix("-----") }.joined()
    guard let der = Data(base64Encoded: body), der.count == 44,
          der.prefix(12) == Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]) else { return nil }
    return try? Curve25519.Signing.PublicKey(rawRepresentation: der.suffix(32))
}

guard CommandLine.arguments.count == 4, let nowMs = Int64(CommandLine.arguments[3]) else { fail(2, "usage: steward-verify <public.pem> <machine> <now_ms>") }
guard let pub = pemKey(CommandLine.arguments[1]) else { fail(2, "unusable public key PEM") }
let myMachine = CommandLine.arguments[2]

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let parsed = Canon.parse(input), let dups = DupScanner.scan(input) else { print("ENVBAD\tenvelope_not_json"); exit(0) }
guard let root = parsed as? [String: Any], (root["ok"] as? NSNumber).map({ isBool($0) && $0.boolValue }) == true,
      let keyID = root["key_id"] as? String, let list = root["tickets"] as? [Any], !dups.rootDup,
      dups.ticketDup.count == list.count else { print("ENVBAD\tenvelope_shape"); exit(0) }
guard keyID == expectedKeyID else { print("ENVBAD\tkey_id_mismatch"); exit(0) }
print("ENV\t\(keyID)")

func bad(_ reason: String, _ t: [String: Any]?) {
    let id = safe(t?["ticket_id"]) ?? "-", nonce = (t?["nonce"] as? String).flatMap { matches(nonceRegex, $0) ? $0 : nil } ?? "-"
    print(["BAD", reason, id, nonce, safe(t?["machine"]) ?? "-"].joined(separator: "\t"))
}

for (idx, item) in list.prefix(10).enumerated() {
    // 1a. malformed: a duplicate JSON key anywhere in the ticket document (JSONSerialization would keep the last value)
    if dups.ticketDup[idx] { bad("malformed", ((item as? [String: Any])?["ticket"]) as? [String: Any]); continue }
    guard let env = item as? [String: Any], let t = env["ticket"] as? [String: Any] else { bad("malformed", nil); continue }

    // 1. malformed: shape, v, key regex, field formats, ttl (duplicate keys were refused above)
    guard keysOK(t), Set(t.keys) == ticketKeys,
          let v = t["v"] as? NSNumber, !isBool(v), v.doubleValue == 1,
          let tid = safe(t["ticket_id"]), let machine = (t["machine"] as? String).flatMap({ $0.isEmpty || $0.utf8.count > 128 ? nil : $0 }),
          let action = t["action"] as? String, let params = t["params"] as? [String: Any],
          let iss = (t["issued_at"] as? String).flatMap(epochMs), let exp = (t["expires_at"] as? String).flatMap(epochMs),
          let nonce = t["nonce"] as? String, matches(nonceRegex, nonce),
          exp > iss, exp - iss <= 900_000 else { bad("malformed", t); continue }

    // 2. bad_signature
    guard let sigText = env["signature"] as? String, let sig = strictSig(sigText), let msg = Canon.bytes(t),
          pub.isValidSignature(sig, for: msg) else { bad("bad_signature", t); continue }

    // 3. expired (no skew grace)
    if exp <= nowMs { bad("expired", t); continue }

    // 4. action_not_allowed
    guard profileActions.contains(action) || emptyActions.contains(action) else { bad("action_not_allowed", t); continue }

    // 5. bad_params (strict schema, no extra keys)
    var profileB64 = "-"
    if profileActions.contains(action) {
        guard params.count == 1, let p = params["profile"] as? String, (1...64).contains(p.utf16.count) else { bad("bad_params", t); continue }
        profileB64 = Data(p.utf8).base64EncodedString()
    } else if !params.isEmpty { bad("bad_params", t); continue }

    // 6. machine_mismatch
    if machine != myMachine { bad("machine_mismatch", t); continue }

    print(["OK", tid, nonce, action, profileB64, String(exp), machine].joined(separator: "\t"))
}
