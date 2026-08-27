import CryptoKit
import Darwin
import Foundation
import TapeCore

private enum ProbeFailure: Error {
  case usage
  case invalidArgument
  case expectedRejection
}

private struct ProbeArguments {
  let command: String
  let values: [String: String]
  let json: Bool

  init(_ arguments: [String]) throws {
    guard let command = arguments.first else { throw ProbeFailure.usage }
    let commands = [
      "provision-wrap", "reopen-unwrap", "fixture-append", "fixture-reopen",
      "inspect-keywrap", "tamper-matrix", "cleanup-test-key",
    ]
    guard commands.contains(command) else { throw ProbeFailure.usage }
    self.command = command
    var parsed: [String: String] = [:]
    var json = false
    var index = 1
    while index < arguments.count {
      let argument = arguments[index]
      if argument == "--json" {
        guard !json else { throw ProbeFailure.invalidArgument }
        json = true
        index += 1
        continue
      }
      guard argument.hasPrefix("--"), index + 1 < arguments.count else {
        throw ProbeFailure.invalidArgument
      }
      let key = String(argument.dropFirst(2))
      guard !key.isEmpty, parsed[key] == nil else { throw ProbeFailure.invalidArgument }
      parsed[key] = arguments[index + 1]
      index += 2
    }
    let archiveKeys = ["test-tag", "keywrap", "stream", "room", "date", "lane", "device"]
    let laneKeys = archiveKeys + ["tape", "index"]
    let allowed =
      command == "inspect-keywrap"
      ? ["keywrap", "test-tag"]
      : command == "cleanup-test-key"
        ? ["test-tag"]
        : command == "reopen-unwrap"
          ? archiveKeys
          : command == "tamper-matrix"
            ? laneKeys + ["scratch"] : laneKeys
    guard Set(parsed.keys).isSubset(of: Set(allowed)), Set(allowed).isSubset(of: Set(parsed.keys))
    else {
      throw ProbeFailure.invalidArgument
    }
    values = parsed
    self.json = json
  }
}

private struct ProbeContext {
  let keywrapURL: URL
  let testTag: String
  let tapeURL: URL
  let indexURL: URL
  let archive: ArchiveContext

  init(_ arguments: ProbeArguments) throws {
    func required(_ key: String, allowEmpty: Bool = false) throws -> String {
      guard let value = arguments.values[key], allowEmpty || !value.isEmpty else {
        throw ProbeFailure.invalidArgument
      }
      return value
    }
    let stream = try decodeHex(required("stream"), expectedBytes: 16)
    testTag = try required("test-tag")
    guard
      let keywrap = ArchiveKeywrapProbePathParser.fileURL(try required("keywrap")),
      let tape = ArchiveKeywrapProbePathParser.fileURL(try required("tape")),
      let index = ArchiveKeywrapProbePathParser.fileURL(try required("index"))
    else { throw ProbeFailure.invalidArgument }
    keywrapURL = keywrap
    tapeURL = tape
    indexURL = index
    archive = ArchiveContext(
      streamUUID: stream,
      roomID: try required("room"),
      istDate: try required("date"),
      laneID: try required("lane"),
      stableDeviceUID: try required("device", allowEmpty: true))
    _ = try archive.encodedBytes()
  }
}

private func run(_ arguments: ProbeArguments) throws -> [String: Any] {
  if arguments.command == "inspect-keywrap" {
    let path = try required("keywrap", arguments: arguments)
    guard let keywrapURL = ArchiveKeywrapProbePathParser.fileURL(path) else {
      throw ProbeFailure.invalidArgument
    }
    let testTag = try required("test-tag", arguments: arguments)
    _ = try ArchiveKeyLifecycle.probeLifecycle(candidateApplicationTag: testTag)
    return inspectionEvidence(
      try ArchiveKeyLifecycle.inspectKeywrap(at: keywrapURL),
      operation: arguments.command,
      testTag: testTag)
  }
  if arguments.command == "cleanup-test-key" {
    let testTag = try required("test-tag", arguments: arguments)
    let lifecycle = try ArchiveKeyLifecycle.probeLifecycle(candidateApplicationTag: testTag)
    try lifecycle.deleteProbeKey()
    return [
      "ok": true, "operation": arguments.command, "test_application_tag": testTag,
      "uses_canonical_tag": false,
    ]
  }
  if arguments.command == "reopen-unwrap" {
    let keywrapPath = try required("keywrap", arguments: arguments)
    guard let keywrapURL = ArchiveKeywrapProbePathParser.fileURL(keywrapPath) else {
      throw ProbeFailure.invalidArgument
    }
    let testTag = try required("test-tag", arguments: arguments)
    let lifecycle = try ArchiveKeyLifecycle.probeLifecycle(candidateApplicationTag: testTag)
    let archive = try probeArchiveContext(arguments)
    return inspectionEvidence(
      try lifecycle.inspectExistingKeywrap(
        keywrapURL: keywrapURL, context: archive),
      operation: arguments.command,
      testTag: testTag)
  }

  let context = try ProbeContext(arguments)
  let lifecycle = try ArchiveKeyLifecycle.probeLifecycle(candidateApplicationTag: context.testTag)
  switch arguments.command {
  case "provision-wrap":
    let existed = FileManager.default.fileExists(atPath: context.keywrapURL.path)
    let store = try lifecycle.openLaneStoreForProbe(
      mode: .provision,
      keywrapURL: context.keywrapURL,
      tapeURL: context.tapeURL,
      indexURL: context.indexURL,
      context: context.archive)
    store.close()
    var evidence = inspectionEvidence(
      try ArchiveKeyLifecycle.inspectKeywrap(at: context.keywrapURL),
      operation: arguments.command,
      testTag: context.testTag)
    evidence["keywrap_created"] = !existed
    evidence["lane_opened"] = true
    return evidence
  case "fixture-append":
    let store = try lifecycle.openLaneStoreForProbe(
      mode: .appendFixture,
      keywrapURL: context.keywrapURL,
      tapeURL: context.tapeURL,
      indexURL: context.indexURL,
      context: context.archive)
    defer { store.close() }
    var pcm = Data()
    pcm.reserveCapacity(32_000)
    for sample in 0..<16_000 {
      let value = Int16((sample % 257) - 128)
      pcm.append(UInt8(truncatingIfNeeded: value))
      pcm.append(UInt8(truncatingIfNeeded: value >> 8))
    }
    let result = try store.appendPCM(
      pcm,
      observation: ArchiveIndexObservation(
        monoNS: 1,
        wallNS: 1,
        rmsQ15: 1,
        nativeFrames: 16_000,
        inputRateNumerator: 16_000,
        inputRateDenominator: 1))
    return [
      "ok": true,
      "operation": arguments.command,
      "fixture": "synthetic-nonclinical-v1",
      "record_sequence": result.tape.header.recordSequence,
      "sample_count": result.tape.header.logicalUnitCount,
      "encrypted_end": result.tape.encryptedEndOffset,
      "test_application_tag": context.testTag,
      "uses_canonical_tag": false,
    ]
  case "fixture-reopen":
    let store = try lifecycle.openLaneStoreForProbe(
      mode: .reopenFixture,
      keywrapURL: context.keywrapURL,
      tapeURL: context.tapeURL,
      indexURL: context.indexURL,
      context: context.archive)
    defer { store.close() }
    return [
      "ok": true,
      "operation": arguments.command,
      "tape_records": store.scanResult.tape.records.count,
      "index_records": store.scanResult.index.records.count,
      "adopted_records": store.adoptedRecordCount,
      "test_application_tag": context.testTag,
      "uses_canonical_tag": false,
    ]
  case "tamper-matrix":
    return try runTamperMatrix(arguments: arguments, source: context, lifecycle: lifecycle)
  default:
    throw ProbeFailure.usage
  }
}

private func runTamperMatrix(
  arguments: ProbeArguments,
  source: ProbeContext,
  lifecycle: ArchiveKeyLifecycle
) throws -> [String: Any] {
  let scratchPath = try required("scratch", arguments: arguments)
  guard let scratch = ArchiveKeywrapProbePathParser.fileURL(scratchPath, isDirectory: true) else {
    throw ProbeFailure.invalidArgument
  }
  var isDirectory: ObjCBool = false
  guard FileManager.default.fileExists(atPath: scratch.path, isDirectory: &isDirectory),
    isDirectory.boolValue
  else {
    throw ProbeFailure.invalidArgument
  }
  let original = try Data(contentsOf: source.keywrapURL, options: [.mappedIfSafe])
  guard original.count > 104 else { throw ArchiveKeyLifecycleError.archiveKeyUnavailable }
  var cases: [(String, Data, ArchiveContext)] = []
  var publicHash = original
  publicHash[64] ^= 1
  cases.append(("public_hash", publicHash, source.archive))
  var ciphertext = original
  ciphertext[104] ^= 1
  cases.append(("ciphertext", ciphertext, source.archive))
  cases.append(
    ("wrong_room", original, changed(source.archive, room: source.archive.roomID + "-wrong")))
  cases.append(("wrong_day", original, changed(source.archive, date: "2099-12-31")))
  cases.append(
    ("wrong_lane", original, changed(source.archive, lane: source.archive.laneID + "-wrong")))
  cases.append(
    (
      "wrong_device", original,
      changed(source.archive, device: source.archive.stableDeviceUID + "-wrong")
    ))
  cases.append(("wrong_control", original, changed(source.archive, lane: "_control", device: "")))
  cases.append(
    (
      "wrong_stream", original,
      ArchiveContext(
        streamUUID: Data(repeating: 0xA5, count: 16),
        roomID: source.archive.roomID,
        istDate: source.archive.istDate,
        laneID: source.archive.laneID,
        stableDeviceUID: source.archive.stableDeviceUID)
    ))

  var results: [[String: Any]] = []
  for (name, bytes, archive) in cases {
    let directory = scratch.appendingPathComponent("eta-keywrap-probe-\(name)-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let wrap = directory.appendingPathComponent("keywrap.eak")
    try bytes.write(to: wrap, options: .withoutOverwriting)
    do {
      let store = try lifecycle.openLaneStoreForProbe(
        mode: .appendFixture,
        keywrapURL: wrap,
        tapeURL: directory.appendingPathComponent("fixture.tape"),
        indexURL: directory.appendingPathComponent("fixture.index"),
        context: archive)
      store.close()
      throw ProbeFailure.expectedRejection
    } catch ArchiveKeyLifecycleError.archiveKeyUnavailable {
      results.append(["case": name, "result": "archive_key_unavailable"])
    }
  }
  return [
    "ok": true, "operation": arguments.command, "cases": results,
    "test_application_tag": source.testTag, "uses_canonical_tag": false,
  ]
}

private func probeArchiveContext(_ arguments: ProbeArguments) throws -> ArchiveContext {
  let stream = try decodeHex(required("stream", arguments: arguments), expectedBytes: 16)
  let archive = ArchiveContext(
    streamUUID: stream,
    roomID: try required("room", arguments: arguments),
    istDate: try required("date", arguments: arguments),
    laneID: try required("lane", arguments: arguments),
    stableDeviceUID: try required("device", arguments: arguments, allowEmpty: true))
  _ = try archive.encodedBytes()
  return archive
}

private func changed(
  _ source: ArchiveContext,
  room: String? = nil,
  date: String? = nil,
  lane: String? = nil,
  device: String? = nil
) -> ArchiveContext {
  ArchiveContext(
    streamUUID: source.streamUUID,
    roomID: room ?? source.roomID,
    istDate: date ?? source.istDate,
    laneID: lane ?? source.laneID,
    stableDeviceUID: device ?? source.stableDeviceUID)
}

private func inspectionEvidence(
  _ inspection: ArchiveKeywrapInspection,
  operation: String,
  testTag: String
) -> [String: Any] {
  [
    "ok": true,
    "operation": operation,
    "format_version": inspection.formatVersion,
    "algorithm_id": inspection.algorithmID,
    "stream_uuid_hex": inspection.streamUUIDHex,
    "context_hash_sha256": inspection.contextHashHex,
    "public_key_sha256": inspection.publicKeyHashHex,
    "wrapped_byte_count": inspection.wrappedByteCount,
    "test_application_tag": testTag,
    "uses_canonical_tag": false,
  ]
}

private func required(
  _ key: String,
  arguments: ProbeArguments,
  allowEmpty: Bool = false
) throws -> String {
  guard let value = arguments.values[key], allowEmpty || !value.isEmpty else {
    throw ProbeFailure.invalidArgument
  }
  return value
}

private func decodeHex(_ value: String, expectedBytes: Int) throws -> Data {
  guard value.count == expectedBytes * 2 else { throw ProbeFailure.invalidArgument }
  var data = Data()
  var index = value.startIndex
  while index < value.endIndex {
    let end = value.index(index, offsetBy: 2)
    guard let byte = UInt8(value[index..<end], radix: 16) else {
      throw ProbeFailure.invalidArgument
    }
    data.append(byte)
    index = end
  }
  return data
}

private func emit(_ value: [String: Any], json: Bool) throws {
  if json {
    let bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(bytes)
    FileHandle.standardOutput.write(Data([0x0A]))
  } else {
    for key in value.keys.sorted() where key != "cases" {
      print("\(key)=\(value[key]!)")
    }
    if let cases = value["cases"] as? [[String: Any]] {
      for item in cases {
        print("case=\(item["case"]!) result=\(item["result"]!)")
      }
    }
  }
}

do {
  let arguments = try ProbeArguments(Array(CommandLine.arguments.dropFirst()))
  try emit(run(arguments), json: arguments.json)
  exit(0)
} catch let error as ArchiveKeyLifecycleError {
  fputs("\(error.rawValue)\n", stderr)
  exit(1)
} catch ProbeFailure.usage {
  fputs(
    "usage: ArchiveKeywrapProbe <provision-wrap|reopen-unwrap|fixture-append|fixture-reopen|inspect-keywrap|tamper-matrix|cleanup-test-key> [strict options] [--json]\n",
    stderr)
  exit(64)
} catch {
  fputs("archive_key_unavailable\n", stderr)
  exit(1)
}
