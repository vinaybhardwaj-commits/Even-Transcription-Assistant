import ConformanceKit
import Foundation
import TapeConvert

let usage = """
usage:
  conformance run [--fixtures DIR] [--required FILE] [--grounding FILE] [--case C1,C2,…] [--verbose]
      Runs the suite. Exit 0 only if every good fixture passes its cases, every negative
      control fails its case, and C9 is PASS or SKIPPED. Default DIR: ./fixtures
  conformance generate --out DIR [--force]
      Writes the synthetic fixtures and negative controls. Refuses to overwrite without --force.
      Run it with the fleet's encoder: C10's reference is measured with whatever ffmpeg is on PATH.
  conformance adopt-tape --tape TAPEDIR --fixtures ROOT --name NAME [--simulate-torn-tail BYTES] [--recorder-summary FILE]
      Wraps a recorded tape as ROOT/good/NAME (outside the repository: it holds real audio). A tape with day_rollover
      records needs room-recorder's JSON summary: C8's pins come from its capture-side split log.
  conformance explain-flush --frames N
      Diagnostic only: feeds N input frames through the production converter, then resets it (what a discontinuity does),
      then feeds N more, and reports how many output samples each step produced — i.e. what the converter emits, if
      anything, for an incomplete group of 3 frames held at a boundary.
  conformance explain-c7 --fixture DIR --exempt N
      Diagnostic only: C7's zero-run probe at the fixture's C7 boundary with an exemption of N samples.
  conformance attest-encoder --fixture DIR
      Measures C10 with the running ffmpeg/libopus and records the pair in encoder.also_verified,
      only if it is within the fixture's unchanged tolerance.
"""

func die(_ message: String, _ code: Int32 = 2) -> Never {
    // stdout is block-buffered when piped; without this flush the error reaches the terminal before the output it
    // refers to ("see STALE above" printing above the STALE block).
    fflush(nil)  // nil = all streams; `stdout` is a global var and Swift 6 rejects it as shared mutable state
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

let argv = Array(CommandLine.arguments.dropFirst())
guard let command = argv.first else { die(usage) }
let args = Array(argv.dropFirst())

func option(_ name: String, in args: [String] = args) -> String? {
    guard let i = args.firstIndex(of: name) else { return nil }
    guard i + 1 < args.count else { die("\(name) needs a value") }
    return args[i + 1]
}

func url(_ path: String) -> URL {
    URL(fileURLWithPath: path, relativeTo: URL(fileURLWithPath: FileManager.default.currentDirectoryPath)).standardizedFileURL
}

switch command {
case "run":
    // V's ruling, 16 Sep: the clean-build rule is mechanical, not remembered. Provenance is printed on every run and
    // a stale binary refuses to print a count at all. Checked before the suite: a stale count is not worth computing.
    let provenance = BuildProvenance.detect()
    print(provenance.render())
    if provenance.refusesToPrintCount {
        die("HARD ERROR: refusing to print a count from a stale binary (see STALE above).", 2)
    }

    let root = url(option("--fixtures") ?? "fixtures")
    var only: Set<CaseID>? = nil
    if let list = option("--case") {
        only = Set(list.split(separator: ",").map { s -> CaseID in
            guard let id = CaseID(rawValue: String(s)) else { die("unknown case \(s)") }
            return id
        })
    }
    let requiredURL = url(option("--required") ?? "spec/required-fixtures.json")
    let required: RequiredFixtures
    do { required = try RequiredFixtures.load(requiredURL) } catch { die("HARD ERROR: \(error)", 2) }
    let groundingURL = url(option("--grounding") ?? "spec/check-grounding.json")
    let grounding: CheckGrounding
    do { grounding = try CheckGrounding.load(groundingURL) } catch { die("HARD ERROR: \(error)", 2) }
    let report = Suite.run(root: root, required: required, grounding: grounding, only: only)
    print("conformance: fixtures \(root.path); required fixtures \(requiredURL.path) (\(required.fixtures.count)); check grounding \(groundingURL.path) (\(grounding.checks.count))")
    print(report.render(verbose: args.contains("--verbose")))
    if let env = C10Measurement.environment { print("C10 encoder: \(env)") }
    if let m = C10Measurement.last { print("C10 measurement: \(m)") }
    // 0: holds on a complete root. 3: holds on a REDUCED root. 1: does not hold.
    exit(!report.holds ? 1 : (report.complete ? 0 : 3))

case "generate":
    guard let out = option("--out") else { die(usage) }
    do {
        for line in try FixtureGenerator.generate(into: url(out), force: args.contains("--force")) { print(line) }
    } catch {
        die("generate: \(error)", 1)
    }

case "adopt-tape":
    guard let tape = option("--tape"), let root = option("--fixtures"), let name = option("--name") else { die(usage) }
    do {
        print(try TapeAdopter.adopt(tape: url(tape), fixturesRoot: url(root), name: name,
                                    simulateTornTailBytes: option("--simulate-torn-tail").flatMap(Int.init),
                                    recorderSummary: option("--recorder-summary").map(url)))
    } catch { die("adopt-tape: \(error)", 1) }

case "explain-c7":
    // Diagnostic only: C7's zero-fill probe on a fixture with a chosen exemption. The suite always uses 40 (§11.5).
    guard let dir = option("--fixture"), let exempt = option("--exempt").flatMap(Int.init) else { die(usage) }
    do {
        let d = url(dir)
        let f = try FixtureLoader.load(d, root: d.deletingLastPathComponent().deletingLastPathComponent())
        guard let e = f.expected.c7, let s = try? IndexLog.scan(f.idx), let line = s.lines.first(where: { $0.number == e.line }),
              let offset = line.int(IndexKey.byteOffset) else { die("fixture has no C7 answer") }
        let r = C7ZeroProbe.run(pcm: f.pcm, byteOffset: offset, length: e.gapNS.map(C7ZeroProbe.length(gapNS:)) ?? C7ZeroProbe.threshold, exemptSamples: exempt)
        print("fixture \(f.id): \(e.cause) at byte \(offset); exempt \(exempt) samples; probe \(r.length) samples; zero run \(r.zeroRun); zero fill reported: \(r.zeroFill)")
    } catch { die("explain-c7: \(error)", 1) }

case "explain-flush":
    guard let frames = option("--frames").flatMap(Int.init), frames > 0 else { die(usage) }
    var decimator = Decimator()
    var out: [Int16] = []
    // A 1 kHz tone, so a flushed partial sample would be non-zero and visible.
    var input: [UInt8] = []
    for n in 0..<frames {
        let phase: Double = 2.0 * Double.pi * 1000.0 * Double(n) / 48000.0
        let amplitude: Double = 0.5 * 32767.0
        let v = Int16((amplitude * Foundation.cos(phase)).rounded())
        let u = UInt16(bitPattern: v)
        input += [UInt8(u & 0xff), UInt8(u >> 8), UInt8(u & 0xff), UInt8(u >> 8)]
    }
    decimator.process(interleaved: input, into: &out)
    let before = out.count
    decimator.reset()
    let afterReset = out.count - before
    decimator.process(interleaved: input, into: &out)
    let second = out.count - before - afterReset
    let rule = DecimationRule.production
    print("explain-flush: \(frames) input frames (\(frames % rule.factor) frame(s) short of a whole group of \(rule.factor))")
    print("  before the boundary: \(before) output samples (outputCount(frames:) = \(rule.outputCount(frames: frames)))")
    print("  emitted BY the reset itself: \(afterReset) output samples")
    print("  after the boundary, \(frames) more frames: \(second) output samples")
    print("  so the incomplete group of \(frames % rule.factor) frame(s) held at the boundary is \(afterReset == 0 ? "DROPPED" : "FLUSHED as \(afterReset) sample(s)") (U1 spec 11.4)")

case "attest-encoder":
    guard let dir = option("--fixture") else { die(usage) }
    do { print(try FixtureGenerator.attestEncoder(fixture: url(dir))) } catch { die("attest-encoder: \(error)", 1) }

default:
    die(usage)
}
