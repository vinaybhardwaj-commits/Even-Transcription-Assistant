import Foundation
import TapeCapture
import Testing

@testable import RoomRecorderCore

/// Arch #22 — the selected-input mark, the level-sample sequence on the wire, and the alert-only selection rule.
/// NOT COMPILED ON THE BOX THAT WROTE THEM (no Swift toolchain). herdr-lead builds and runs them on a Mac.
@Suite struct RoomInputSelectionTests {
  private let tonor = AudioInputDeviceEntry(name: "TONOR TM20", uid: "uid-tonor", isDefault: false)
  private let c270 = AudioInputDeviceEntry(name: "C270 HD", uid: "uid-c270", isDefault: true)

  private func query(_ fields: InstallPollFields) -> [String: String] {
    Dictionary(uniqueKeysWithValues: fields.queryItems().map { ($0.name, $0.value ?? "") })
  }

  // MARK: input_devices carries which entry is selected

  @Test func theSelectedEntryIsMarkedAndOnlyThatOne() throws {
    let json = try #require(InstallPollFields.inputDevicesJSON([tonor, c270], selectedUID: "uid-tonor"))
    #expect(json.contains("\"is_selected\":true"))
    #expect(json.components(separatedBy: "is_selected").count == 2)  // exactly one mention
    let decoded = try #require(
      try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: Any]])
    #expect(decoded.first { $0["uid"] as? String == "uid-tonor" }?["is_selected"] as? Bool == true)
    #expect(decoded.first { $0["uid"] as? String == "uid-c270" }?["is_selected"] == nil)
  }

  @Test func noSelectedUIDMeansNoMarkAndTheOldBytes() throws {
    let json = try #require(InstallPollFields.inputDevicesJSON([tonor, c270]))
    #expect(!json.contains("is_selected"))
  }

  @Test func aSelectedUIDThatIsNotAttachedMarksNothing() throws {
    let json = try #require(InstallPollFields.inputDevicesJSON([c270], selectedUID: "uid-gone"))
    #expect(!json.contains("is_selected"))
  }

  // MARK: the level-sample sequence

  @Test func queryCarriesTheSequenceAndItsInstant() {
    let q = query(
      InstallPollFields(
        installID: "install_1", tapeAdvancing: true, levelSeq: 42, levelAt: "2026-10-08T10:00:00.000Z"))
    #expect(q["level_seq"] == "42")
    #expect(q["level_at"] == "2026-10-08T10:00:00.000Z")
  }

  @Test func queryOmitsTheSequenceWhenNothingWasRead() {
    let names = InstallPollFields(installID: "install_1", tapeAdvancing: true).queryItems().map(\.name)
    #expect(!names.contains("level_seq"))
    #expect(!names.contains("level_at"))
  }

  @Test func queryDropsANegativeSequenceAndItsInstant() {
    let names = InstallPollFields(
      installID: "install_1", tapeAdvancing: true, levelSeq: -1, levelAt: "2026-10-08T10:00:00.000Z"
    ).queryItems().map(\.name)
    #expect(!names.contains("level_seq"))
    #expect(!names.contains("level_at"))
  }

  // MARK: the selection rule — alert-only

  @Test func configuredAttachedIsTheConfiguredRule() {
    let d = InputSelectionPolicy.decide(configuredUID: "uid-tonor", attached: [tonor, c270])
    #expect(d.rule == .configured)
    #expect(d.selectedUID == "uid-tonor")
    #expect(d.candidateUID == "uid-c270")
  }

  @Test func configuredMissingStillRecordsFromTheConfiguredUIDAndNamesACandidate() {
    let d = InputSelectionPolicy.decide(configuredUID: "uid-gone", attached: [tonor, c270])
    #expect(d.rule == .configuredMissing)
    #expect(d.selectedUID == "uid-gone")  // never switched
    #expect(d.candidateUID == "uid-c270")  // the OS default wins over list order
  }

  @Test func anUnreadableDeviceListIsUnverifiedNotMissing() {
    let d = InputSelectionPolicy.decide(configuredUID: "uid-tonor", attached: nil)
    #expect(d.rule == .configuredUnverified)
    #expect(d.candidateUID == nil)
  }

  @Test func theLogLineSaysAutoSwitchIsOffAndCarriesNoNames() {
    let line = InputSelectionPolicy.decide(configuredUID: "uid-tonor", attached: [tonor, c270]).logLine
    #expect(line.contains("auto_switch=false"))
    #expect(line.contains("rule=configured"))
    #expect(!line.contains("TONOR"))
  }
}
