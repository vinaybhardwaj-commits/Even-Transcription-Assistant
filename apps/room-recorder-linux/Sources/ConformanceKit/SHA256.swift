// FIPS 180-4 SHA-256. Local so the package has no dependencies to fetch.

public struct SHA256 {
    private var h: (UInt32, UInt32, UInt32, UInt32, UInt32, UInt32, UInt32, UInt32) =
        (0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19)
    private var pending: [UInt8] = []
    private var length: UInt64 = 0

    private static let k: [UInt32] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]

    public init() {}

    public mutating func update(_ bytes: some Collection<UInt8>) {
        length &+= UInt64(bytes.count)
        var input = Array(bytes)
        if !pending.isEmpty {
            let need = 64 - pending.count
            let take = min(need, input.count)
            pending.append(contentsOf: input[0..<take])
            input.removeFirst(take)
            if pending.count == 64 {
                let block = pending
                pending.removeAll(keepingCapacity: true)
                block.withUnsafeBufferPointer { compress($0.baseAddress!) }
            }
        }
        let full = input.count / 64 * 64
        input.withUnsafeBufferPointer { p in
            var o = 0
            while o < full { compress(p.baseAddress! + o); o += 64 }
        }
        if full < input.count { pending.append(contentsOf: input[full...]) }
    }

    public mutating func finalize() -> [UInt8] {
        let bitLength = length &* 8
        var tail = pending
        tail.append(0x80)
        while tail.count % 64 != 56 { tail.append(0) }
        for i in (0..<8).reversed() { tail.append(UInt8(truncatingIfNeeded: bitLength >> (UInt64(i) * 8))) }
        tail.withUnsafeBufferPointer { p in
            var o = 0
            while o < tail.count { compress(p.baseAddress! + o); o += 64 }
        }
        pending.removeAll()
        var out: [UInt8] = []
        for v in [h.0, h.1, h.2, h.3, h.4, h.5, h.6, h.7] {
            out += [UInt8(v >> 24), UInt8((v >> 16) & 0xff), UInt8((v >> 8) & 0xff), UInt8(v & 0xff)]
        }
        return out
    }

    public static func hex(_ bytes: some Collection<UInt8>) -> String {
        var s = SHA256()
        s.update(bytes)
        return hexString(s.finalize())
    }

    public static func hexString(_ digest: [UInt8]) -> String {
        let digits = Array("0123456789abcdef")
        return String(digest.flatMap { [digits[Int($0 >> 4)], digits[Int($0 & 0x0f)]] })
    }

    @inline(__always)
    private static func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 { (x >> n) | (x << (32 - n)) }

    private mutating func compress(_ p: UnsafePointer<UInt8>) {
        withUnsafeTemporaryAllocation(of: UInt32.self, capacity: 64) { w in
            for t in 0..<16 {
                w[t] = UInt32(p[t * 4]) << 24 | UInt32(p[t * 4 + 1]) << 16 | UInt32(p[t * 4 + 2]) << 8 | UInt32(p[t * 4 + 3])
            }
            for t in 16..<64 {
                let s0 = SHA256.rotr(w[t - 15], 7) ^ SHA256.rotr(w[t - 15], 18) ^ (w[t - 15] >> 3)
                let s1 = SHA256.rotr(w[t - 2], 17) ^ SHA256.rotr(w[t - 2], 19) ^ (w[t - 2] >> 10)
                w[t] = w[t - 16] &+ s0 &+ w[t - 7] &+ s1
            }
            var (a, b, c, d, e, f, g, hh) = h
            for t in 0..<64 {
                let s1 = SHA256.rotr(e, 6) ^ SHA256.rotr(e, 11) ^ SHA256.rotr(e, 25)
                let ch = (e & f) ^ (~e & g)
                let t1 = hh &+ s1 &+ ch &+ SHA256.k[t] &+ w[t]
                let s0 = SHA256.rotr(a, 2) ^ SHA256.rotr(a, 13) ^ SHA256.rotr(a, 22)
                let maj = (a & b) ^ (a & c) ^ (b & c)
                let t2 = s0 &+ maj
                hh = g; g = f; f = e; e = d &+ t1; d = c; c = b; b = a; a = t1 &+ t2
            }
            h = (h.0 &+ a, h.1 &+ b, h.2 &+ c, h.3 &+ d, h.4 &+ e, h.5 &+ f, h.6 &+ g, h.7 &+ hh)
        }
    }
}
