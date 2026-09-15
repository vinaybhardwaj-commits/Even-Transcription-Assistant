import ConformanceKit
import Foundation

let usage = """
usage:
  conformance run [--fixtures DIR] [--case C1,C2,…] [--verbose]
      Runs the suite. Exit 0 only if every good fixture passes its cases, every negative
      control fails its case, and C9 is PASS or SKIPPED. Default DIR: ./fixtures
  conformance generate --out DIR [--force]
      Writes the synthetic fixtures and negative controls. Refuses to overwrite without --force.
      Run it with the fleet's encoder: C10's reference is measured with whatever ffmpeg is on PATH.
  conformance adopt-tape --tape TAPEDIR --fixtures ROOT --name NAME [--simulate-torn-tail BYTES]
      Wraps a recorded tape as ROOT/good/NAME (outside the repository: it holds real audio).
  conformance attest-encoder --fixture DIR
      Measures C10 with the running ffmpeg/libopus and records the pair in encoder.also_verified,
      only if it is within the fixture's unchanged tolerance.
"""

func die(_ message: String, _ code: Int32 = 2) -> Never {
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
    let root = url(option("--fixtures") ?? "fixtures")
    var only: Set<CaseID>? = nil
    if let list = option("--case") {
        only = Set(list.split(separator: ",").map { s -> CaseID in
            guard let id = CaseID(rawValue: String(s)) else { die("unknown case \(s)") }
            return id
        })
    }
    let report = Suite.run(root: root, only: only)
    print("conformance: fixtures \(root.path)")
    print(report.render(verbose: args.contains("--verbose")))
    if let env = C10Measurement.environment { print("C10 encoder: \(env)") }
    if let m = C10Measurement.last { print("C10 measurement: \(m)") }
    exit(report.holds ? 0 : 1)

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
                                    simulateTornTailBytes: option("--simulate-torn-tail").flatMap(Int.init)))
    } catch { die("adopt-tape: \(error)", 1) }

case "explain-c7":
    // Diagnostic only: C7's zero-fill probe on a fixture with a chosen exemption. The suite always uses 40 (§11.5).
    guard let dir = option("--fixture"), let exempt = option("--exempt").flatMap(Int.init) else { die(usage) }
    do {
        let d = url(dir)
        let f = try FixtureLoader.load(d, root: d.deletingLastPathComponent().deletingLastPathComponent())
        guard let e = f.expected.c7, let s = try? IndexLog.scan(f.idx), let line = s.lines.first(where: { $0.number == e.line }),
              let offset = line.int(IndexKey.byteOffset) else { die("fixture has no C7 answer") }
        let r = C7ZeroProbe.run(pcm: f.pcm, byteOffset: offset, gapNS: e.gapNS, exemptSamples: exempt)
        print("fixture \(f.id): discontinuity at byte \(offset); exempt \(exempt) samples; probe \(r.length) samples; zero run \(r.zeroRun); zero fill reported: \(r.zeroFill)")
    } catch { die("explain-c7: \(error)", 1) }

case "attest-encoder":
    guard let dir = option("--fixture") else { die(usage) }
    do { print(try FixtureGenerator.attestEncoder(fixture: url(dir))) } catch { die("attest-encoder: \(error)", 1) }

default:
    die(usage)
}
