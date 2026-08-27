import Foundation
import TapeCapture
import TapeCore

private let usage = """
  Usage:
    tapewriter record --out <dir> [--device <uid>]
      [--unsigned-development-archive --archive-stream <UUID> --archive-room <id>
       --archive-date YYYY-MM-DD --archive-lane <id>]
    tapewriter inspect-unsigned-development-archive --dir <dir> --device <uid>
      --archive-stream <UUID> --archive-room <id> --archive-date YYYY-MM-DD --archive-lane <id>
    tapewriter derive-unsigned-development-archive --dir <dir> --device <uid> --session <id>
      --archive-stream <UUID> --archive-room <id> --archive-date YYYY-MM-DD --archive-lane <id>
      [--final]
    tapewriter verify --dir <dir>
    tapewriter export --dir <dir> --wav <file>
  """

private func option(_ name: String, in arguments: [String]) throws -> String? {
  guard let index = arguments.firstIndex(of: name) else { return nil }
  guard index + 1 < arguments.count else { throw RecorderError("missing value for \(name)") }
  return arguments[index + 1]
}

private func require(_ name: String, in arguments: [String]) throws -> String {
  guard let value = try option(name, in: arguments) else {
    throw RecorderError("required option: \(name)")
  }
  return value
}

do {
  let arguments = Array(CommandLine.arguments.dropFirst())
  guard let command = arguments.first else { throw RecorderError(usage) }
  switch command {
  case "record":
    let options = try RecordCommandOptions.parse(Array(arguments.dropFirst()))
    try Recorder.run(
      outputDirectory: options.outputDirectory,
      requestedDeviceUID: options.requestedDeviceUID,
      unsignedDevelopmentArchive: options.unsignedDevelopmentArchive
    )
  case "verify":
    let directory = try require("--dir", in: arguments)
    let report = try TapeVerifier.verify(
      directory: URL(fileURLWithPath: directory).standardizedFileURL)
    print(report.rendered())
    if !report.passed { exit(2) }
  case "inspect-unsigned-development-archive":
    let options = try UnsignedDevelopmentArchiveInspectionCommandOptions.parse(
      Array(arguments.dropFirst()))
    let result = try UnsignedDevelopmentArchiveInspection.inspect(
      directory: options.directory,
      options: options.archive,
      stableDeviceUID: options.stableDeviceUID
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    print(String(decoding: try encoder.encode(result), as: UTF8.self))
    if !result.ok { exit(2) }
  case "derive-unsigned-development-archive":
    let options = try UnsignedDevelopmentDerivationCommandOptions.parse(
      Array(arguments.dropFirst()))
    let result = try UnsignedDevelopmentDerivationReport.derive(options: options)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    print(String(decoding: try encoder.encode(result), as: UTF8.self))
    if !result.ok { exit(2) }
  case "export":
    let directory = URL(fileURLWithPath: try require("--dir", in: arguments)).standardizedFileURL
    let output = URL(fileURLWithPath: try require("--wav", in: arguments)).standardizedFileURL
    try WAVExporter.export(pcmURL: directory.appendingPathComponent("tape.pcm"), wavURL: output)
    print("Exported \(output.path)")
  case "help", "--help", "-h":
    print(usage)
  default:
    throw RecorderError("unknown command: \(command)\n\(usage)")
  }
} catch {
  fputs("tapewriter: \(error.localizedDescription)\n", stderr)
  exit(1)
}
