import CaptureCore
import Foundation
import RecorderCore
import TapeConvert
import TapeCore

// U1 step 5: day rollover fixtures. Every tape here is WRITTEN BY THE PRODUCTION CODE — CaptureSide (the split and the
// re-arm), TapeSession (the writer loop) and TapeWriter — fed synthetic 48 kHz stereo buffers on an ideal clock. The
// expected answers are NOT read back from those tapes: they are computed below by hand arithmetic from the buffer
// layout, and C8 then holds the tape to them. A negative control is written by the same writer behind a deliberately
// wrong split rule (never present in the recorder), or by editing one record.

extension FixtureGenerator {
    enum SplitRule: Equatable {
        case production
        /// frameOffset rounded DOWN: the input frame straddling midnight goes to the new day.
        case roundedDown
        /// Re-armed from the suffix's first wall time + 24 h instead of the target + 24 h.
        case rearmFromSuffix
        /// Never re-armed after the first boundary.
        case noRearm
    }

    struct SyntheticBuffer {
        var frames: Int
        var wallStartNS: Int64
        var monoStartNS: Int64
        /// A capture-side marker recorded before this buffer (capture_discontinuity; device_lost with its detection clocks).
        var markBefore: String? = nil
        var markMonoNS: Int64? = nil
        var markWallNS: Int64? = nil
        /// The device was reopened before this buffer: a new capture session, which queries the zone at this wall time.
        var newSessionAtWallNS: Int64? = nil
        /// false: the writer is not run after this buffer (a starved writer, so the ring can overflow).
        var drainAfter = true
    }

    static let inputRate: Int64 = 48_000
    static let bufferFrames = 1_200          // 25 ms, exactly 25 000 000 ns
    static let bufferNS: Int64 = 25_000_000

    /// `count` contiguous 25 ms buffers from (wall, mono).
    static func buffers(_ count: Int, wall: Int64, mono: Int64) -> [SyntheticBuffer] {
        (0..<count).map { SyntheticBuffer(frames: bufferFrames, wallStartNS: wall + Int64($0) * bufferNS, monoStartNS: mono + Int64($0) * bufferNS) }
    }

    /// Two-tone programme: L 1000 Hz at 0.5, R 440 Hz at 0.25, by absolute capture frame.
    static func toneSignal(_ n: Int64) -> (Int16, Int16) {
        (StereoSignal.tone(hz: 1000, amplitude: 0.5).sample(Int(n)), StereoSignal.tone(hz: 440, amplitude: 0.25).sample(Int(n)))
    }

    /// Runs the recorder's capture side and writer over `buffers` into a temporary tape and returns its bytes. The
    /// writer drains after every buffer, as the live writer keeps up; `now` is the end of the latest buffer.
    static func record(_ buffers: [SyntheticBuffer], firstTarget: Int64?, rule: SplitRule = .production,
                       ringCapacityFrames: Int = 1 << 20,
                       signal: (Int64) -> (Int16, Int16) = toneSignal) throws -> (pcm: [UInt8], idx: [UInt8]) {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("conformance-rollover-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: dir) }
        final class Now { var mono: Int64 = 0; var wall: Int64 = 0 }
        let now = Now()
        now.mono = buffers[0].monoStartNS
        now.wall = buffers[0].wallStartNS
        let writer = try TapeWriter(directory: dir, device: dmic, inputSampleRate: Double(inputRate), monoNow: { now.mono }, wallNow: { now.wall })
        let ring = FrameRing(capacityFrames: ringCapacityFrames, bytesPerFrame: 4)
        let arrival = ArrivalClock(rate: inputRate)
        let session = TapeSession(writer: writer, ring: ring, arrival: arrival, monoNow: { now.mono }, wallNow: { now.wall })
        let side = CaptureSide(ring: ring, arrival: arrival)
        side.beginSession(nextRolloverWallNS: firstTarget)
        var variantNext = firstTarget
        var captured: Int64 = 0
        for b in buffers {
            if let cause = b.markBefore { ring.markDiscontinuity(cause: cause, monoNS: b.markMonoNS, wallNS: b.markWallNS) }
            if let at = b.newSessionAtWallNS {
                let target = try ISTDay.nextMidnight(nowWallNS: at)
                side.beginSession(nextRolloverWallNS: target)
                variantNext = target
            }
            var bytes: [UInt8] = []
            bytes.reserveCapacity(b.frames * 4)
            for i in 0..<b.frames {
                let (l, r) = signal(captured + Int64(i))
                let ul = UInt16(bitPattern: l), ur = UInt16(bitPattern: r)
                bytes += [UInt8(ul & 0xff), UInt8(ul >> 8), UInt8(ur & 0xff), UInt8(ur >> 8)]
            }
            let duration = FrameTime.duration(frames: Int64(b.frames), rate: inputRate)
            now.mono = b.monoStartNS + duration
            now.wall = b.wallStartNS + duration
            bytes.withUnsafeBytes { raw in
                if rule == .production {
                    side.deliver(raw, monoStartNS: b.monoStartNS, wallStartNS: b.wallStartNS)
                } else {
                    deliverWrong(raw, b, firstFrame: captured, next: &variantNext, rule: rule, ring: ring, arrival: arrival)
                }
            }
            captured += Int64(b.frames)
            if b.drainAfter { while try session.step() == .progressed {} }
        }
        now.mono += 1_000_000
        now.wall += 1_000_000
        while try session.step() == .progressed {}
        try session.finish()
        return ([UInt8](try Data(contentsOf: dir.appendingPathComponent("tape.pcm"))),
                [UInt8](try Data(contentsOf: dir.appendingPathComponent("tape.idx"))))
    }

    /// CaptureSide.deliver with one rule changed. Negative controls only; the recorder has no such code.
    static func deliverWrong(_ bytes: UnsafeRawBufferPointer, _ b: SyntheticBuffer, firstFrame: Int64, next: inout Int64?,
                             rule: SplitRule, ring: FrameRing, arrival: ArrivalClock) {
        let n = b.frames
        guard let target = next, target <= FrameTime.segmentEnd(start: b.wallStartNS, frames: Int64(n), rate: inputRate) else {
            arrival.stamp(firstFrame: firstFrame, frames: Int64(n), monoStartNS: b.monoStartNS, wallStartNS: b.wallStartNS)
            ring.push(bytes)
            return
        }
        let elapsed = target - b.wallStartNS
        let x = Double(elapsed) * Double(inputRate) / 1e9
        let p = target <= b.wallStartNS ? 0 : min(n, Int(rule == .roundedDown ? x.rounded(.down) : x.rounded(.up)))
        let sw = FrameTime.segmentEnd(start: b.wallStartNS, frames: Int64(p), rate: inputRate)
        let sm = FrameTime.segmentEnd(start: b.monoStartNS, frames: Int64(p), rate: inputRate)
        if p > 0 { arrival.stamp(firstFrame: firstFrame, frames: Int64(p), monoStartNS: b.monoStartNS, wallStartNS: b.wallStartNS) }
        if p < n { arrival.stamp(firstFrame: firstFrame + Int64(p), frames: Int64(n - p), monoStartNS: sm, wallStartNS: sw) }
        if p > 0 { ring.push(UnsafeRawBufferPointer(rebasing: bytes[0..<(p * 4)])) }
        ring.markDiscontinuity(cause: "day_rollover", monoNS: target <= b.wallStartNS ? b.monoStartNS : b.monoStartNS + elapsed, wallNS: target)
        if p < n { ring.push(UnsafeRawBufferPointer(rebasing: bytes[(p * 4)...])) }
        switch rule {
        case .production, .roundedDown: next = target + RolloverTimeline.istDayNS
        case .rearmFromSuffix: next = sw + RolloverTimeline.istDayNS
        case .noRearm: next = nil
        }
    }

    static func rollover(line: Int, wall: Int64, mono: Int64, sample: Int64, inputFrames: Int64?, prefixEnd: Int64?, suffix: Int64?) -> C8Rollover {
        C8Rollover(line: line, boundaryWallNS: wall, markerMonoNS: mono, rolloverSample: sample, inputFrames: inputFrames,
                   prefixEndWallNS: prefixEnd, suffixWallNS: suffix,
                   straddling: prefixEnd != nil && prefixEnd == suffix && (suffix ?? wall) > wall)
    }

    static func rolloverManifest(_ name: String, _ description: String, _ cases: [CaseID]) -> FixtureManifest {
        var m = manifest(name, description, cases, [])
        m.synthesis = nil
        m.provenance = "synthetic (48 kHz stereo input written by the production CaptureSide + TapeSession + TapeWriter)"
        return m
    }

    // MARK: good/ist-midnight — one boundary, midnight strictly inside an input frame

    /// First buffer starts 2 000 052 083 ns before M = 2026-09-14 00:00 IST. Buffers are contiguous 25 ms (1200 frames).
    /// Midnight: x = 2 000 052 083 × 48000 / 1e9 = 96 002.499984 frames after the start, inside frame 96 002 of buffer 80
    /// (which starts at +2.000 000 000 s, 52 083 ns before M: frameOffset = ceil(2.499984) = 3).
    ///   old day = frames 0 … 96 002 (96 003 frames) → floor(96 003 / 3) = 32 001 samples; tape sample 32 000 (frames
    ///   96 000–96 002) holds midnight and stays in the old day.
    ///   prefix end = suffix start = buffer-80 start + UInt64(3.0 / 48000 × 1e9) = start + 2 000 062 500 = M + 10 417 ns
    ///   (AudioRing.swift:323-325, truncating; exact here).
    ///   marker wall_ns = M; marker mono_ns = buffer-80 mono start + 52 083 = mono0 + 2 000 052 083.
    /// Records (cadence floor 1.25 s from the capture anchor written at the end of buffer 0): 1 capture anchor @0,
    /// 2 periodic @20 400 (end of buffer 50), 3 forced checkpoint @32 001, 4 day_rollover @32 001, 5 capture anchor
    /// @32 001, 6 periodic @52 400 (end of buffer 130: 32 001 + floor(61 197 / 3)), 7 final @64 000, 8 stopped.
    static let midnightStartNS: Int64 = istMidnightNS - 2_000_052_083

    static func istMidnight(rule: SplitRule = .production) throws -> Draft {
        let t = try record(buffers(160, wall: midnightStartNS, mono: Int64(monoStart)), firstTarget: istMidnightNS, rule: rule)
        let w0 = midnightStartNS, m0 = Int64(monoStart)
        var e = ExpectedAnswers()
        e.c4 = ClockExpected(points: [
            ClockPoint(name: "capture anchor", at: "sample:0", wallNS: w0),
            ClockPoint(name: "periodic checkpoint (end of buffer 50)", at: "record:2", wallNS: w0 + 1_275_000_000),
            ClockPoint(name: "straddling sample, last of the old day (holds midnight)", at: "sample:32000", wallNS: w0 + 2_000_000_000),
            ClockPoint(name: "first sample of the new day (the capture anchor after the marker, 10 417 ns after midnight)", at: "sample:32001", wallNS: w0 + 2_000_062_500),
            ClockPoint(name: "last sample of the tape", at: "sample:63999", wallNS: w0 + 4_000_000_000 - 62_500),
        ])
        e.c8 = C8Expected(rollovers: [rollover(line: 4, wall: istMidnightNS, mono: m0 + 2_000_052_083, sample: 32_001, inputFrames: 96_003,
                                               prefixEnd: w0 + 2_000_062_500, suffix: w0 + 2_000_062_500)])
        let m = rolloverManifest("ist-midnight",
                                 "4 s of 48 kHz stereo tone (L 1 kHz, R 440 Hz) starting 2.000052083 s before 2026-09-14 00:00 IST, recorded by the production capture side and writer in 25 ms buffers. Midnight falls 0.499984 of the way through input frame 96002, so the split is at 96003 frames: the old day holds 32001 samples, tape sample 32000 holds midnight and stays in the old day. The day_rollover record's wall_ns is midnight exactly; the new day's first wall_ns (capture anchor) is 10417 ns later: two different numbers.",
                                 [.C1, .C2, .C4, .C8])
        return Draft(manifest: m, pcm: t.pcm, idx: t.idx, expected: e)
    }

    // MARK: good/ist-midnight-two-rollovers — one capture session across two midnights

    /// Session A: 80 buffers from M1 − 1 000 052 083 ns (M1 = 2026-09-14 00:00 IST). Midnight in buffer 40, frameOffset 3,
    /// split at 48 003 frames → 16 001 samples; prefix end = suffix start = A + 1 000 062 500 = M1 + 10 417.
    /// Then a capture_discontinuity: session B resumes (same capture session, no re-query) at M2 − 1 000 062 500 with
    /// M2 = M1 + 86 400 000 000 000, the re-armed target. Its buffer 40 starts 62 500 ns before M2: x = 3.0 exactly,
    /// frameOffset 3, split at 48 003 frames of the region → 16 001 samples; prefix end = suffix start = M2 exactly
    /// (edge-aligned: marker wall_ns and the suffix's first wall_ns coincide here, and differ at M1).
    /// Mono runs with wall, so the capture_discontinuity's gap_ns = (M2 − 1 000 062 500) − (A + 2 s) = 86 397 999 989 583.
    /// Records: 1 anchor @0, 2 forced @16 001 (A + 1 000 062 500), 3 day_rollover M1, 4 anchor @16 001, 5 forced @32 000
    /// (A + 2 s), 6 capture_discontinuity @32 000, 7 anchor @32 000, 8 forced @48 001 (M2), 9 day_rollover M2, 10 anchor
    /// @48 001 (M2), 11 final @64 000 (B + 2 s), 12 stopped. No periodic checkpoint: each 1.25 s floor is pre-empted.
    static let twoStartNS: Int64 = istMidnightNS - 1_000_052_083
    static var secondMidnightNS: Int64 { istMidnightNS + RolloverTimeline.istDayNS }
    static var twoResumeNS: Int64 { secondMidnightNS - 1_000_062_500 }

    static func twoRolloverBuffers() -> [SyntheticBuffer] {
        let m0 = Int64(monoStart)
        var b = buffers(80, wall: twoStartNS, mono: m0)
        var resumed = buffers(80, wall: twoResumeNS, mono: m0 + (twoResumeNS - twoStartNS))
        resumed[0].markBefore = DiscontinuityCause.captureDiscontinuity
        b += resumed
        return b
    }

    static func twoRollovers(rule: SplitRule = .production) throws -> (Draft, ExpectedAnswers) {
        let t = try record(twoRolloverBuffers(), firstTarget: istMidnightNS, rule: rule)
        let a = twoStartNS, m0 = Int64(monoStart), b = twoResumeNS, m2 = secondMidnightNS
        let gap: Int64 = b - (a + 2_000_000_000)
        var e = ExpectedAnswers()
        e.c3 = C3Expected(outcome: "clean", records: 12)
        e.c4 = ClockExpected(points: [
            ClockPoint(name: "capture anchor", at: "sample:0", wallNS: a),
            ClockPoint(name: "last sample of day 1 (holds M1)", at: "sample:16000", wallNS: a + 1_000_000_000),
            ClockPoint(name: "first sample of day 2", at: "sample:16001", wallNS: a + 1_000_062_500),
            ClockPoint(name: "first sample after the capture_discontinuity", at: "sample:32000", wallNS: b),
            ClockPoint(name: "last sample of day 2 before M2 (ends exactly at M2)", at: "sample:48000", wallNS: m2 - 62_500),
            ClockPoint(name: "first sample of day 3 (exactly M2)", at: "sample:48001", wallNS: m2),
            ClockPoint(name: "last sample of the tape", at: "sample:63999", wallNS: m2 + 999_875_000),
        ])
        e.pieces = [PieceRange(sampleStart: 0, sampleEnd: 16_001), PieceRange(sampleStart: 16_001, sampleEnd: 32_000),
                    PieceRange(sampleStart: 32_000, sampleEnd: 48_001, gapBeforeMS: DiscontinuityCause.gapMilliseconds(cause: DiscontinuityCause.captureDiscontinuity, gapNS: gap)),
                    PieceRange(sampleStart: 48_001, sampleEnd: 64_000)]
        e.c8 = C8Expected(rollovers: [
            rollover(line: 3, wall: istMidnightNS, mono: m0 + (istMidnightNS - a), sample: 16_001, inputFrames: 48_003,
                     prefixEnd: a + 1_000_062_500, suffix: a + 1_000_062_500),
            rollover(line: 9, wall: m2, mono: m0 + (m2 - a), sample: 48_001, inputFrames: 96_000 + 48_003, prefixEnd: m2, suffix: m2),
        ])
        let m = rolloverManifest("ist-midnight-two-rollovers",
                                 "One capture session across two IST midnights (the Mac has no test of this path). 2 s of tone around 2026-09-14 00:00 IST (midnight inside an input frame: marker wall_ns M1, new day starts M1 + 10417 ns), a capture_discontinuity of 86397.999989583 s, then 2 s around 2026-09-15 00:00 IST. The second boundary is the first target + 86400000000000 ns exactly, with no calendar re-query; there midnight falls on an input-frame edge, so marker wall_ns and the new day's first wall_ns are both M2.",
                                 [.C1, .C2, .C3, .C4, .C5, .C8])
        return (Draft(manifest: m, pcm: t.pcm, idx: t.idx, expected: e), e)
    }

    // MARK: good/ist-midnight-before-first-audio — the marker precedes every audio buffer of the tape

    /// A new tape whose capture session was opened before M (target M) but whose first buffer starts 6 250 000 ns after M:
    /// target <= wall start, so frameOffset = 0 and mono_ns = the buffer's mono start (CaptureTimeline.swift:141-150): the
    /// day_rollover record is the tape's first line, at sample 0, with NO input_frames (no input rate yet in this run,
    /// TapeWriter.swift:153, :285); mono_ns = mono0. Then the capture anchor @0 (wall M + 6.25 ms),
    /// 40 buffers, final @16 000, stopped.
    static let beforeAudioStartNS: Int64 = istMidnightNS + 6_250_000

    static func beforeFirstAudio() throws -> Draft {
        let t = try record(buffers(40, wall: beforeAudioStartNS, mono: Int64(monoStart)), firstTarget: istMidnightNS)
        let w0 = beforeAudioStartNS, m0 = Int64(monoStart)
        var e = ExpectedAnswers()
        e.c4 = ClockExpected(points: [
            ClockPoint(name: "capture anchor (replaces the marker's midnight as the region anchor)", at: "sample:0", wallNS: w0),
            ClockPoint(name: "last sample of the tape", at: "sample:15999", wallNS: w0 + 1_000_000_000 - 62_500),
        ])
        e.c8 = C8Expected(rollovers: [rollover(line: 1, wall: istMidnightNS, mono: m0, sample: 0, inputFrames: nil, prefixEnd: nil, suffix: w0)])
        let m = rolloverManifest("ist-midnight-before-first-audio",
                                 "A new tape whose capture session was opened before 2026-09-14 00:00 IST and whose first buffer starts 6.25 ms after it. The day_rollover record is line 1, at sample 0, stamped with midnight, and carries no input_frames or input_sample_rate: no audio, so no input rate, preceded it. 1 s of tone follows.",
                                 [.C1, .C2, .C4, .C8])
        return Draft(manifest: m, pcm: t.pcm, idx: t.idx, expected: e)
    }

    // MARK: good/c7-quiet-room-midnight — §11.5 at a day_rollover

    /// U1 spec §11.5 at a day_rollover: a quiet room at midnight. 250 Hz sine at RMS 0.005 on both channels (by absolute
    /// frame), 2 s from M − 1 000 052 083 ns; the split and reset are those of good/ist-midnight-two-rollovers' first
    /// boundary: 16 001 samples of old day, 15 999 of new day. Records: 1 anchor, 2 forced @16 001, 3 day_rollover,
    /// 4 anchor @16 001, 5 final @32 000, 6 stopped. Generation refuses unless C7's probe reports zero fill at the
    /// boundary with no exemption and none with the 40-sample exemption.
    static func quietRoomMidnight() throws -> Draft {
        let amplitude = 0.005 * 2.0.squareRoot() * 32767.0
        let quiet: (Int64) -> (Int16, Int16) = { n in
            let v = Int16((amplitude * sin(2.0 * Double.pi * 250.0 * Double(n) / 48000.0)).rounded())
            return (v, v)
        }
        let t = try record(buffers(80, wall: twoStartNS, mono: Int64(monoStart)), firstTarget: istMidnightNS, signal: quiet)
        let without = C7ZeroProbe.run(pcm: t.pcm, byteOffset: 32_002, length: C7ZeroProbe.threshold, exemptSamples: 0)
        let with = C7ZeroProbe.run(pcm: t.pcm, byteOffset: 32_002, length: C7ZeroProbe.threshold, exemptSamples: C7ZeroProbe.exemptSamples)
        guard without.zeroFill, !with.zeroFill else {
            throw FixtureLoadError(fixture: "good/c7-quiet-room-midnight",
                                   reason: "does not exercise §11.5: zero run \(without.zeroRun) with no exemption, \(with.zeroRun) with 40")
        }
        let a = twoStartNS, m0 = Int64(monoStart)
        var e = ExpectedAnswers()
        e.c7 = C7Expected(line: 3, cause: DiscontinuityCause.dayRollover, gapNS: nil, droppedInputFrames: nil, preGapSamples: 16_001, postGapSamples: 15_999)
        e.c8 = C8Expected(rollovers: [rollover(line: 3, wall: istMidnightNS, mono: m0 + (istMidnightNS - a), sample: 16_001, inputFrames: 48_003,
                                               prefixEnd: a + 1_000_062_500, suffix: a + 1_000_062_500)])
        let m = rolloverManifest("c7-quiet-room-midnight",
                                 "U1 spec 11.5 at a day_rollover. A quiet room at midnight: 250 Hz sine at RMS 0.005 (48 kHz stereo, both channels), 2 s around 2026-09-14 00:00 IST, recorded by the production capture side and writer. The rollover resets the converter, and the first \(without.zeroRun) samples of the new day are the filter ramp rounding to zero: C7's zero-run probe reports zero fill with no exemption and passes with the 40-sample exemption (checked at generation).",
                                 [.C1, .C2, .C7, .C8])
        return Draft(manifest: m, pcm: t.pcm, idx: t.idx, expected: e)
    }

    // MARK: good/ist-midnight-device-lost-at-midnight — adjacent markers, the deferred capture anchor

    /// 40 buffers from M − 1 s: buffer 39 ends exactly at M, so it is split after all 1200 frames (elapsed 25 000 000 ns,
    /// ceil(1200.0) = 1200): no suffix. Then the device is lost (detected at M + 5 ms), reopened at M + 2.005 s (a new
    /// capture session: the zone gives M + 24 h), and 40 buffers resume at M + 2.010 s. mono runs with wall.
    /// Records: 1 anchor @0 (M − 1 s), 2 forced checkpoint @16 000 (end of buffer 39 = M), 3 day_rollover (M, mono0 + 1 s,
    /// input 48 000), 4 device_lost (M + 5 ms), 5 resumed (M + 2.010 s, gap_ns 2 005 000 000), 6 capture anchor @16 000
    /// (M + 2.010 s) — the ONLY anchor after the three adjacent markers — 7 final @32 000, 8 stopped.
    static let lostStartNS: Int64 = istMidnightNS - 1_000_000_000
    static let lostResumeNS: Int64 = istMidnightNS + 2_010_000_000

    static func deviceLostAtMidnight() throws -> Draft {
        let m0 = Int64(monoStart)
        var b = buffers(40, wall: lostStartNS, mono: m0)
        var resumed = buffers(40, wall: lostResumeNS, mono: m0 + (lostResumeNS - lostStartNS))
        resumed[0].markBefore = DiscontinuityCause.deviceLost
        resumed[0].markWallNS = istMidnightNS + 5_000_000
        resumed[0].markMonoNS = m0 + 1_005_000_000
        resumed[0].newSessionAtWallNS = lostResumeNS - 5_000_000
        b += resumed
        let t = try record(b, firstTarget: istMidnightNS)
        let w0 = lostStartNS, wr = lostResumeNS
        var e = ExpectedAnswers()
        e.c3 = C3Expected(outcome: "clean", records: 8)
        e.c4 = ClockExpected(points: [
            ClockPoint(name: "capture anchor", at: "sample:0", wallNS: w0),
            ClockPoint(name: "last sample of the old day (ends exactly at midnight)", at: "sample:15999", wallNS: istMidnightNS - 62_500),
            ClockPoint(name: "first sample after the outage (capture anchor after device_lost + resumed)", at: "sample:16000", wallNS: wr),
            ClockPoint(name: "last sample of the tape", at: "sample:31999", wallNS: wr + 1_000_000_000 - 62_500),
        ])
        e.pieces = [PieceRange(sampleStart: 0, sampleEnd: 16_000), PieceRange(sampleStart: 16_000, sampleEnd: 32_000, gapBeforeMS: 2_005)]
        e.c8 = C8Expected(rollovers: [rollover(line: 3, wall: istMidnightNS, mono: m0 + 1_000_000_000, sample: 16_000, inputFrames: 48_000,
                                               prefixEnd: istMidnightNS, suffix: nil)])
        let m = rolloverManifest("ist-midnight-device-lost-at-midnight",
                                 "1 s of tone ending exactly at 2026-09-14 00:00 IST (the last buffer is split after all its frames: no new-day audio), the device lost 5 ms after midnight and reopened 2 s later (new capture session). day_rollover, device_lost and resumed are adjacent records at sample 16000 with no capture anchor between them; the one anchor follows resumed, before the first audio (TapeWriter.swift:323-326, :339-341). 1 s of tone after.",
                                 [.C1, .C2, .C3, .C4, .C5, .C8])
        return Draft(manifest: m, pcm: t.pcm, idx: t.idx, expected: e)
    }

    // MARK: good/discontinuity-mid-group — a boundary with a non-empty converter buffer

    /// Buffers of 1 200 frames except the first, which holds 1 201, so the frame count at each boundary is not a multiple of
    /// three and the converter is holding an incomplete group when the boundary arrives. Measured with
    /// `conformance explain-flush`: our converter emits NOTHING at a reset (U1 spec §11.4), so the boundary's byte_offset is
    /// 2 × floor(frames / 3) and the held frames are dropped.
    ///   ring capacity 2 400 frames (wider than any buffer, so nothing is lost to the ring except at the starve); the writer
    ///   is starved over buffers 40 and 41, which fill it, so every frame of buffer 42 is dropped: ring_overflow, 1 200
    ///   dropped input frames, gap_ns 25 000 000.
    ///   at that boundary 50 401 frames have been consumed (1 short of a group): 16 800 samples, byte_offset 33 600.
    ///   region 2 then consumes 1 202 + 1 200 + 1 200 = 3 602 frames (2 short of a group) before a capture_discontinuity
    ///   40 ms later: 1 200 samples, byte_offset 36 000. Then 3 600 frames and a clean stop: 19 200 samples in all.
    static func discontinuityMidGroup() throws -> Draft {
        let w0 = cleanAnchorNS, m0 = Int64(monoStart)
        var bs: [SyntheticBuffer] = []
        var wall = w0, mono = m0
        func add(_ frames: Int, drain: Bool = true, mark: String? = nil, extraWaitNS: Int64 = 0) {
            wall += extraWaitNS
            mono += extraWaitNS
            bs.append(SyntheticBuffer(frames: frames, wallStartNS: wall, monoStartNS: mono, markBefore: mark, drainAfter: drain))
            let d = FrameTime.duration(frames: Int64(frames), rate: inputRate)
            wall += d
            mono += d
        }
        add(1_201)                                   // buffer 0: 1 201 frames, so no boundary lands on a group edge
        for _ in 1..<40 { add(bufferFrames) }        // buffers 1…39
        add(bufferFrames, drain: false)              // buffers 40 and 41 fill the 2 400-frame ring
        add(bufferFrames, drain: false)
        add(bufferFrames)                            // buffer 42 is dropped whole, then the writer catches up
        add(1_202)                                   // buffer 43: the new side
        add(bufferFrames)
        add(bufferFrames)
        add(bufferFrames, mark: DiscontinuityCause.captureDiscontinuity, extraWaitNS: 40_000_000)
        for _ in 0..<2 { add(bufferFrames) }
        let t = try record(bs, firstTarget: try ISTDay.nextMidnight(nowWallNS: w0), ringCapacityFrames: 2 * bufferFrames)
        let lines = idxLines(t.idx).filter { !$0.isEmpty }
        let overflow = lines.firstIndex { $0.contains("\"discontinuity\":\"ring_overflow\"") }.map { $0 + 1 }
        guard let overflowLine = overflow else {
            throw FixtureLoadError(fixture: "good/discontinuity-mid-group", reason: "the starved writer produced no ring_overflow: \(lines.count) records")
        }
        var e = ExpectedAnswers()
        e.c3 = C3Expected(outcome: "clean", records: lines.count)
        e.c7 = C7Expected(line: overflowLine, cause: DiscontinuityCause.ringOverflow, gapNS: 25_000_000, droppedInputFrames: 1_200,
                          preGapSamples: 16_800, postGapSamples: 19_200 - 16_800)
        let m = rolloverManifest("discontinuity-mid-group",
                                 "Boundaries that fall inside a group of three input frames. 25 ms buffers except the first (1201 frames) and buffer 43 (1202), a ring of 2400 frames and a writer starved over two buffers: ring_overflow with 1200 dropped frames after 50401 consumed frames (1 short of a group) at byte_offset 33600, then a capture_discontinuity after 3602 frames of the new region (2 short) at byte_offset 36000. Our converter emits nothing at a reset (measured: conformance explain-flush), so each boundary's byte_offset is 2 x floor(frames / 3) and the held frames are dropped. If the Mac's resampler flush emits a final partial sample instead, these offsets differ by one sample.",
                                 [.C1, .C2, .C3, .C7])
        return Draft(manifest: m, pcm: t.pcm, idx: t.idx, expected: e)
    }

    // MARK: good/coincident-gaps-max — two discontinuities at one sample

    /// PiecePipeline.swift:277-307: a discontinuity at the region's own start appends no region; the region's gap becomes the
    /// MAXIMUM of the coincident gaps while its anchor is overwritten by the LAST record. The first discontinuity here carries
    /// the larger gap, so the two rules give different answers: gap_before_ms 750 (max, not the last record's 10) and the
    /// anchor is the second record's wall_ns (not the first's).
    static func coincidentGaps() -> Draft {
        let syn: [SynthSegment] = [.tone(1000, 0.5, 16_000), SynthSegment(kind: "gap", gapNS: 750_000_000), .tone(440, 0.25, 16_000)]
        var b = TapeBuilder(device: dmic, wall: cleanAnchorNS, mono: monoStart, inputRate: ("48000", 3, 1))
        b.checkpoint(0, window: false)
        b.checkpoints(every: 8_000, after: 0, through: 16_000)
        b.discontinuity(16_000, cause: DiscontinuityCause.ringOverflow, gapNS: 750_000_000, dropped: 36_000)
        b.discontinuity(16_000, cause: DiscontinuityCause.captureDiscontinuity, gapNS: 10_000_000)
        b.checkpoints(every: 8_000, after: 16_000, through: 32_000)
        var clock = TapeBuilder(device: dmic, wall: cleanAnchorNS, mono: 0, inputRate: nil)
        let before = point("last sample before the two discontinuities", "sample:15999", clock, 15_999)
        clock.anchorWall = clock.wall(16_000) + 750_000_000 + 10_000_000
        clock.anchorSample = 16_000
        let after = point("first sample after them (anchored on the LAST of the two records)", "sample:16000", clock, 16_000)
        let end = point("last sample of the tape", "sample:31999", clock, 31_999)
        var e = ExpectedAnswers()
        e.c4 = ClockExpected(points: [before, after, end])
        e.pieces = [PieceRange(sampleStart: 0, sampleEnd: 16_000),
                    PieceRange(sampleStart: 16_000, sampleEnd: 32_000, gapBeforeMS: 750)]
        return Draft(manifest: manifest("coincident-gaps-max",
                                        "Two discontinuities at sample 16000, the FIRST carrying the larger gap: ring_overflow (gap_ns 750000000, 36000 dropped frames) then capture_discontinuity (gap_ns 10000000) 10 ms later. The piece after them carries gap_before_ms 750 — the maximum of the two, not the last one's 10 — and the region's clock anchor is the second record's wall_ns.",
                                        [.C1, .C2, .C4, .C5], syn),
                     pcm: Synth.render(syn), idx: b.idx, expected: e)
    }

    // MARK: Negative controls

    static func idxLines(_ idx: [UInt8]) -> [String] { String(decoding: idx, as: UTF8.self).components(separatedBy: "\n") }

    static func rolloverNegatives(midnight: Draft, two: Draft, before: Draft, quiet: Draft, lost: Draft, coincident: Draft) throws -> [Draft] {
        var out: [Draft] = []

        // The old wording: the LAST discontinuity at the sample governs the gap. It gives 10 ms where the rule gives 750.
        out.append(negative(coincident, name: "c5-coincident-gap-from-last", target: .C5,
                            corruption: "The piece after the two coincident discontinuities carries gap_before_ms 10, the LAST record's gap, instead of 750, the maximum of the two (PiecePipeline.swift:277-307).") { d in
            d.expected.pieces![1].gapBeforeMS = 10
            d.expected.c4 = nil
        })

        // The other half of PiecePipeline.swift:277-307: the anchor is the LAST record's wall_ns, not the first's.
        out.append(negative(coincident, name: "c4-anchor-from-first-coincident", target: .C4,
                            corruption: "The clock for sample 16000 is anchored on the FIRST of the two coincident records (10 ms earlier), not the last.") { d in
            d.expected.pieces = nil
            d.expected.c4!.points[1].wallNS -= 10_000_000
            d.expected.c4!.points[2].wallNS -= 10_000_000
        })

        // Bytes written after the clean stop: tape.pcm is 800 bytes longer than the final stopped record's byte_offset.
        out.append(negative(midnight, name: "c1-bytes-after-stopped", target: .C1,
                            corruption: "800 bytes of audio are appended to tape.pcm after the final stopped record (byte_offset 128000): the tape is 128800 bytes. Every record still lies within tape.pcm.") { d in
            d.pcm += Array(d.pcm.suffix(800))
            d.expected = ExpectedAnswers()
        })

        // A capture anchor between two adjacent markers, where the writer has consumed no audio.
        out.append(negative(lost, name: "c8-anchor-between-adjacent-markers", target: .C8,
                            corruption: "An empty-window checkpoint at sample 16000 (input_frames 48000, the device_lost record's clocks) is inserted between device_lost (line 4) and resumed: an anchor written for a marker, not for audio.") { d in
            var lines = idxLines(d.idx)
            let anchor = lines[3].replacingOccurrences(of: "\"discontinuity\":\"device_lost\",", with: "")
                .replacingOccurrences(of: "\"mono_ns\":", with: "\"input_frames\":48000,\"input_sample_rate\":48000,\"mono_ns\":")
                .replacingOccurrences(of: "\"samples\":", with: "\"rms\":0,\"samples\":")
            lines.insert(anchor, at: 4)
            d.idx = Array(lines.joined(separator: "\n").utf8)
            d.expected.c3 = nil; d.expected.c4 = nil; d.expected.pieces = nil
        })

        // No capture anchor at all after the markers: the first audio's records follow resumed directly.
        out.append(negative(lost, name: "c8-no-anchor-after-markers", target: .C8,
                            corruption: "The capture anchor after resumed (line 6) is removed: the final checkpoint, with levels, follows the markers directly.") { d in
            var lines = idxLines(d.idx)
            lines.remove(at: 5)
            d.idx = Array(lines.joined(separator: "\n").utf8)
            d.expected.c3 = nil; d.expected.c4 = nil; d.expected.pieces = nil
        })

        // The straddling frame in the NEW day, written by the writer behind a rounded-down split. Expected answers are
        // those of that tape (self-consistent), so only C8's straddle law can fail it: prefix end = suffix start =
        // buffer-80 start + UInt64(2.0 / 48000 × 1e9) = + 41 666 (floor) = M − 10 417; 32 000 old-day samples; 96 002 input frames.
        let down = try istMidnight(rule: .roundedDown)
        out.append(negative(midnight, name: "c8-straddle-moved-to-new-day", target: .C8,
                            corruption: "Written by the production writer behind a split rounded DOWN: the input frame holding midnight (frame 96002) goes to the new day. The old day ends and the new day begins at M - 10417 ns, before midnight; the day_rollover record sits at sample 32000 with input_frames 96002. expected.json describes this tape, so only the straddle law can fail it.") { d in
            d.pcm = down.pcm
            d.idx = down.idx
            d.expected.c4 = nil
            d.expected.c8 = C8Expected(rollovers: [rollover(line: 4, wall: istMidnightNS, mono: Int64(monoStart) + 2_000_052_083, sample: 32_000, inputFrames: 96_002,
                                                            prefixEnd: istMidnightNS - 10_417, suffix: istMidnightNS - 10_417)])
        })

        // A port that has one boundary time: the marker stamped with the new day's first wall time. Self-consistent.
        let suffixWall = midnightStartNS + 2_000_062_500
        out.append(negative(midnight, name: "c8-marker-stamped-with-suffix-wall", target: .C8,
                            corruption: "The day_rollover record (line 4) carries the new day's first wall time, M + 10417 ns, instead of the target midnight. expected.json claims that value.") { d in
            var lines = idxLines(d.idx)
            lines[3] = lines[3].replacingOccurrences(of: "\"wall_ns\":\(istMidnightNS)", with: "\"wall_ns\":\(suffixWall)")
            d.idx = Array(lines.joined(separator: "\n").utf8)
            d.expected.c4 = nil
            d.expected.c8!.rollovers[0].boundaryWallNS = suffixWall
            d.expected.c8!.rollovers[0].straddling = false
        })

        // The other half of one boundary time: the new day's capture anchor stamped with midnight. The tape alone cannot
        // tell this from a split across two buffers, so the pinned suffix wall (unchanged in expected.json) catches it.
        out.append(negative(midnight, name: "c8-suffix-stamped-at-midnight", target: .C8,
                            corruption: "The capture anchor after the day_rollover (line 5) is stamped with midnight instead of the new day's first wall time M + 10417 ns. expected.json still pins the true value.") { d in
            var lines = idxLines(d.idx)
            lines[4] = lines[4].replacingOccurrences(of: "\"wall_ns\":\(suffixWall)", with: "\"wall_ns\":\(istMidnightNS)")
            d.idx = Array(lines.joined(separator: "\n").utf8)
            d.expected.c4 = nil
        })

        // Re-armed from the suffix's wall time: the second target is M2 + 10 417. Session B's buffer 40 starts M2 − 62 500:
        // elapsed 72 917 → ceil(3.500016) = 4 frames; prefix end = suffix start = M2 − 62 500 + 83 333 = M2 + 20 833;
        // 16 001 samples; marker mono = mono0 + (M2 − A) + 10 417. Self-consistent.
        let rearm = try twoRollovers(rule: .rearmFromSuffix).0
        let m2 = secondMidnightNS
        out.append(negative(two, name: "c8-rearmed-from-suffix-wall", target: .C8,
                            corruption: "Written by the production writer behind a re-arm from the first new day's wall time (M1 + 10417 ns) + 24 h instead of the target + 24 h: the second day_rollover is stamped M2 + 10417 ns and splits after 4 frames of its buffer. expected.json describes this tape.") { d in
            d.pcm = rearm.pcm
            d.idx = rearm.idx
            d.expected.c3 = nil; d.expected.c4 = nil; d.expected.pieces = nil
            d.expected.c8!.rollovers[1] = rollover(line: 9, wall: m2 + 10_417, mono: Int64(monoStart) + (m2 - twoStartNS) + 10_417, sample: 48_001,
                                                   inputFrames: 96_000 + 48_004, prefixEnd: m2 + 20_833, suffix: m2 + 20_833)
        })

        // Never re-armed: the second midnight passes with no marker. Self-consistent (one rollover expected).
        let unarmed = try twoRollovers(rule: .noRearm).0
        out.append(negative(two, name: "c8-second-midnight-not-armed", target: .C8,
                            corruption: "Written by the production writer behind a timeline that never re-arms: the tape runs 1 s past 2026-09-15 00:00 IST with no second day_rollover. expected.json describes this tape (one rollover).") { d in
            d.pcm = unarmed.pcm
            d.idx = unarmed.idx
            d.expected.c3 = nil; d.expected.c4 = nil; d.expected.pieces = nil
            d.expected.c8!.rollovers.removeLast()
        })

        // input_frames on a marker that no audio preceded. Self-consistent.
        out.append(negative(before, name: "c8-input-frames-before-first-audio", target: .C8,
                            corruption: "The day_rollover record on line 1, which no audio preceded, carries input_frames 0 and input_sample_rate 48000. expected.json claims input_frames 0.") { d in
            var lines = idxLines(d.idx)
            lines[0] = lines[0].replacingOccurrences(of: "\"mono_ns\":", with: "\"input_frames\":0,\"input_sample_rate\":48000,\"mono_ns\":")
            d.idx = Array(lines.joined(separator: "\n").utf8)
            d.expected.c4 = nil
            d.expected.c8!.rollovers[0].inputFrames = 0
        })

        // Zero fill at the rollover: 400 zero samples (25 ms) inserted right after the marker; later records move.
        out.append(negative(quiet, name: "c7-zero-filled-rollover", target: .C7,
                            corruption: "400 zero samples (25 ms) are inserted into tape.pcm at the day_rollover (byte 32002); the final checkpoint and stopped record move by 800 bytes.") { d in
            d.pcm.insert(contentsOf: repeatElement(UInt8(0), count: 800), at: 32_002)
            var lines = idxLines(d.idx)
            for i in 4..<lines.count where !lines[i].isEmpty {
                lines[i] = lines[i].replacingOccurrences(of: "\"byte_offset\":64000,", with: "\"byte_offset\":64800,")
                    .replacingOccurrences(of: "\"samples\":32000,", with: "\"samples\":32400,")
            }
            d.idx = Array(lines.joined(separator: "\n").utf8)
            d.expected.c8 = nil
        })
        return out
    }
}
