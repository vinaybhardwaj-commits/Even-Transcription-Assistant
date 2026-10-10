import CryptoKit
import Foundation

/// RFC 8032 Ed25519 signing with the deterministic nonce.
///
/// ─── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────
/// CryptoKit's `Curve25519.Signing` adds randomness to the nonce: two signatures over the same
/// message differ. Both verify, but PROTOCOL.md §7 requires the Swift signer to reproduce the
/// server's vector tokens byte for byte, and Node's signer is deterministic. So signing is done
/// here, from the RFC; CryptoKit supplies the public key (a pure function of the seed) and the
/// tests verify every signature with it. The server vectors are the proof this code is right.
///
/// Not constant-time, and not meant to be: it signs a few small tokens a minute on a Mac that
/// holds the key for this one purpose. Speed is not a concern either; a signature takes a few
/// milliseconds in a release build.
enum DeterministicEd25519 {
  static func sign(message: Data, seed: Data, publicKey: Data) -> Data {
    let h = Array(SHA512.hash(data: seed))
    var a = Array(h[0..<32])
    a[0] &= 248
    a[31] &= 127
    a[31] |= 64
    let prefix = Data(h[32..<64])

    let r = Big(bytesLE: Array(SHA512.hash(data: prefix + message))).mod(Curve.L)
    let encodedR = Curve.encode(Curve.scalarMultBase(r))
    let k = Big(bytesLE: Array(SHA512.hash(data: Data(encodedR) + publicKey + message))).mod(Curve.L)
    let s = (r + k * Big(bytesLE: a)).mod(Curve.L)
    return Data(encodedR) + Data(s.bytesLE(count: 32))
  }

  // MARK: - Big unsigned integers (little-endian 32-bit limbs)

  struct Big: Equatable, Comparable {
    var w: [UInt32]

    init(_ value: UInt64) {
      w = [UInt32(truncatingIfNeeded: value), UInt32(truncatingIfNeeded: value >> 32)]
      trim()
    }
    init(bytesLE bytes: [UInt8]) {
      w = []
      var i = 0
      while i < bytes.count {
        var limb: UInt32 = 0
        for j in 0..<4 where i + j < bytes.count { limb |= UInt32(bytes[i + j]) << (8 * UInt32(j)) }
        w.append(limb)
        i += 4
      }
      trim()
    }
    init(limbs: [UInt32]) { w = limbs; trim() }

    mutating func trim() { while let last = w.last, last == 0 { w.removeLast() } }
    var isZero: Bool { w.isEmpty }
    var bitLength: Int { w.isEmpty ? 0 : (w.count - 1) * 32 + (32 - w.last!.leadingZeroBitCount) }
    func bit(_ i: Int) -> Bool { i / 32 < w.count && (w[i / 32] >> UInt32(i % 32)) & 1 == 1 }
    var isOdd: Bool { bit(0) }

    func bytesLE(count: Int) -> [UInt8] {
      var out = [UInt8](repeating: 0, count: count)
      for i in 0..<count where i / 4 < w.count { out[i] = UInt8(truncatingIfNeeded: w[i / 4] >> (8 * UInt32(i % 4))) }
      return out
    }

    static func < (a: Big, b: Big) -> Bool {
      if a.w.count != b.w.count { return a.w.count < b.w.count }
      for i in stride(from: a.w.count - 1, through: 0, by: -1) where a.w[i] != b.w[i] { return a.w[i] < b.w[i] }
      return false
    }

    static func + (a: Big, b: Big) -> Big {
      var out: [UInt32] = []
      var carry: UInt64 = 0
      for i in 0..<max(a.w.count, b.w.count) {
        let sum = UInt64(i < a.w.count ? a.w[i] : 0) + UInt64(i < b.w.count ? b.w[i] : 0) + carry
        out.append(UInt32(truncatingIfNeeded: sum))
        carry = sum >> 32
      }
      if carry > 0 { out.append(UInt32(carry)) }
      return Big(limbs: out)
    }

    /// Requires a >= b.
    static func - (a: Big, b: Big) -> Big {
      var out: [UInt32] = []
      var borrow: Int64 = 0
      for i in 0..<a.w.count {
        var diff = Int64(a.w[i]) - Int64(i < b.w.count ? b.w[i] : 0) - borrow
        if diff < 0 { diff += 1 << 32; borrow = 1 } else { borrow = 0 }
        out.append(UInt32(diff))
      }
      return Big(limbs: out)
    }

    static func * (a: Big, b: Big) -> Big {
      guard !a.isZero, !b.isZero else { return Big(0) }
      var out = [UInt32](repeating: 0, count: a.w.count + b.w.count)
      for i in 0..<a.w.count {
        var carry: UInt64 = 0
        for j in 0..<b.w.count {
          let cur = UInt64(out[i + j]) + UInt64(a.w[i]) * UInt64(b.w[j]) + carry
          out[i + j] = UInt32(truncatingIfNeeded: cur)
          carry = cur >> 32
        }
        out[i + b.w.count] = UInt32(truncatingIfNeeded: UInt64(out[i + b.w.count]) + carry)
      }
      return Big(limbs: out)
    }

    func shiftedLeft(_ n: Int) -> Big {
      guard !isZero, n > 0 else { return self }
      let limbs = n / 32, bits = UInt32(n % 32)
      var out = [UInt32](repeating: 0, count: limbs) + w
      if bits > 0 {
        var carry: UInt32 = 0
        for i in limbs..<out.count {
          let next = out[i] >> (32 - bits)
          out[i] = (out[i] << bits) | carry
          carry = next
        }
        if carry > 0 { out.append(carry) }
      }
      return Big(limbs: out)
    }

    func shiftedRight(_ n: Int) -> Big {
      let limbs = n / 32, bits = UInt32(n % 32)
      guard limbs < w.count else { return Big(0) }
      var out = Array(w[limbs...])
      if bits > 0 {
        for i in 0..<out.count {
          let high: UInt32 = i + 1 < out.count ? out[i + 1] << (32 - bits) : 0
          out[i] = (out[i] >> bits) | high
        }
      }
      return Big(limbs: out)
    }

    /// Shift-and-subtract. Used only for the group order, twice per signature.
    func mod(_ m: Big) -> Big {
      var x = self
      var shift = x.bitLength - m.bitLength
      while shift >= 0 {
        let shifted = m.shiftedLeft(shift)
        if !(x < shifted) { x = x - shifted }
        shift -= 1
      }
      return x
    }
  }

  // MARK: - The curve (edwards25519)

  enum Curve {
    static let p = Big(1).shiftedLeft(255) - Big(19)
    static let L = Big(1).shiftedLeft(252) + Big(bytesLE: [
      0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
    ])
    private static let mask255 = Big(1).shiftedLeft(255) - Big(1)

    // Field arithmetic mod p = 2^255 - 19. Reduction folds the high part back in: 2^255 ≡ 19.
    static func reduce(_ value: Big) -> Big {
      var x = value
      while x.bitLength > 255 {
        let hi = x.shiftedRight(255)
        var lo = x
        lo.w = Array(lo.w.prefix(8))
        if lo.w.count == 8 { lo.w[7] &= 0x7FFF_FFFF }
        lo.trim()
        x = lo + hi * Big(19)
      }
      if !(x < p) { x = x - p }
      return x
    }
    static func add(_ a: Big, _ b: Big) -> Big { reduce(a + b) }
    static func sub(_ a: Big, _ b: Big) -> Big { reduce(a + p - b) }
    static func mul(_ a: Big, _ b: Big) -> Big { reduce(a * b) }
    static func pow(_ base: Big, _ exponent: Big) -> Big {
      var result = Big(1)
      var square = base
      for i in 0..<exponent.bitLength {
        if exponent.bit(i) { result = mul(result, square) }
        square = mul(square, square)
      }
      return result
    }
    static func inv(_ a: Big) -> Big { pow(a, p - Big(2)) }

    static let d: Big = sub(Big(0), mul(Big(121665), inv(Big(121666))))
    static let d2: Big = add(d, d)

    struct Point { var x: Big; var y: Big; var z: Big; var t: Big }

    static let identity = Point(x: Big(0), y: Big(1), z: Big(1), t: Big(0))

    /// Unified addition for a = -1 (add-2008-hwcd-3); it also doubles.
    static func add(_ p1: Point, _ p2: Point) -> Point {
      let a = mul(sub(p1.y, p1.x), sub(p2.y, p2.x))
      let b = mul(add(p1.y, p1.x), add(p2.y, p2.x))
      let c = mul(mul(p1.t, d2), p2.t)
      let dd = mul(add(p1.z, p1.z), p2.z)
      let e = sub(b, a), f = sub(dd, c), g = add(dd, c), h = add(b, a)
      return Point(x: mul(e, f), y: mul(g, h), z: mul(f, g), t: mul(e, h))
    }

    static let base: Point = {
      let y = mul(Big(4), inv(Big(5)))
      let y2 = mul(y, y)
      let x2 = mul(sub(y2, Big(1)), inv(add(mul(d, y2), Big(1))))
      var x = pow(x2, (p + Big(3)).shiftedRight(3))
      if mul(x, x) != x2 {
        x = mul(x, pow(Big(2), (p - Big(1)).shiftedRight(2)))  // × sqrt(-1)
      }
      if x.isOdd { x = p - x }
      return Point(x: x, y: y, z: Big(1), t: mul(x, y))
    }()

    static func scalarMultBase(_ scalar: Big) -> Point {
      var result = identity
      var addend = base
      for i in 0..<max(scalar.bitLength, 1) {
        if scalar.bit(i) { result = add(result, addend) }
        addend = add(addend, addend)
      }
      return result
    }

    static func encode(_ point: Point) -> [UInt8] {
      let zi = inv(point.z)
      let x = mul(point.x, zi), y = mul(point.y, zi)
      var out = y.bytesLE(count: 32)
      if x.isOdd { out[31] |= 0x80 }
      return out
    }
  }
}
