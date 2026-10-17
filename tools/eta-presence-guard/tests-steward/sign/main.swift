import Foundation
import CryptoKit

// Test-only. steward-sign pem <pub_b64> -> SPKI PEM;  steward-sign sigonly <seed_b64> < obj -> signature b64
//            steward-sign gen            -> "<seed_b64> <pub_b64>"
//            steward-sign sign <seed_b64> < ticket.json  -> envelope {"ticket":...,"signature":...} (canonical bytes signed)
//            steward-sign canon < ticket.json -> canonical bytes
let a = CommandLine.arguments
if a.count == 2, a[1] == "gen" {
    let k = Curve25519.Signing.PrivateKey()
    print(k.rawRepresentation.base64EncodedString(), k.publicKey.rawRepresentation.base64EncodedString())
} else if a.count == 3, a[1] == "sign", let seed = Data(base64Encoded: a[2]), let k = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed),
          let t = Canon.parse(FileHandle.standardInput.readDataToEndOfFile()), let msg = Canon.bytes(t), let sig = try? k.signature(for: msg) {
    let env: [String: Any] = ["ticket": t, "signature": sig.base64EncodedString()]
    print(String(data: try! JSONSerialization.data(withJSONObject: env, options: [.sortedKeys]), encoding: .utf8)!)
} else if a.count == 3, a[1] == "pem", let raw = Data(base64Encoded: a[2]), raw.count == 32 {
    let der = Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]) + raw
    print("-----BEGIN PUBLIC KEY-----\n\(der.base64EncodedString())\n-----END PUBLIC KEY-----")
} else if a.count == 3, a[1] == "sigonly", let seed = Data(base64Encoded: a[2]), let k = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed),
          let t = Canon.parse(FileHandle.standardInput.readDataToEndOfFile()), let msg = Canon.bytes(t), let sig = try? k.signature(for: msg) {
    print(sig.base64EncodedString())
} else if a.count == 2, a[1] == "canon", let t = Canon.parse(FileHandle.standardInput.readDataToEndOfFile()), let s = Canon.encode(t) {
    print(s, terminator: "")
} else { FileHandle.standardError.write(Data("usage\n".utf8)); exit(2) }
