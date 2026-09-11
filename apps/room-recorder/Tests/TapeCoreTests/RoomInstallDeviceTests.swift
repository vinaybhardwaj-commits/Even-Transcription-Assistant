import Foundation
import TapeCapture
import Testing

@testable import RoomRecorderCore

/// The eighth poll field and the device the room records from (Install and Fleet PRD §4.3, §5.3,
/// §5.5; V's ruling of 8 September 2026).
///
/// These tests exist because of a live failure. `residentDefault` put `hw.uuid` — a MACHINE
/// identifier, read from a sysctl that no longer exists on macOS 26/27 — into `deviceUID`, which
/// RoomEngine passes straight to `tapewriter record --device` and seals into the archive index.
/// Enrol died with `RoomConfigurationError error 6` after the server had already spent the token,
/// and Home Office was left with no poller. Nothing in the suite covered any of it.
@Suite struct RoomInstallDeviceTests {

  // -------------------------------------------------------------------------
  // The eighth field on the wire
  // -------------------------------------------------------------------------

  @Test func queryCarriesTheDeviceNameWhenItWasMeasured() {
    let fields = InstallPollFields(
      installID: "install_1",
      tapeAdvancing: true,
      inputDeviceName: "TONOR TM20 Audio Device"
    )
    let query = Dictionary(
      uniqueKeysWithValues: fields.queryItems().map { ($0.name, $0.value ?? "") })
    #expect(query["input_device_name"] == "TONOR TM20 Audio Device")
    #expect(query["install_id"] == "install_1")
  }

  /// §5.5's invariant, on the new field: absence is sent as absence.
  ///
  /// The server COALESCEs this column, so an omitted field leaves the last true name in place.
  /// Sending an empty string, or the UID as a stand-in, would overwrite a good reading with a
  /// worse one — which is exactly the class of mistake §5.5 was written after.
  @Test func queryOmitsTheDeviceNameRatherThanSendingAGuess() {
    for absent in [nil, ""] as [String?] {
      let fields = InstallPollFields(
        installID: "install_1", tapeAdvancing: false, inputDeviceName: absent)
      let names = fields.queryItems().map(\.name)
      #expect(!names.contains("input_device_name"))
    }
  }

  // -------------------------------------------------------------------------
  // Release B2 — peak, exact-zero ratio (D7) and the input-device list (D10)
  // -------------------------------------------------------------------------

  static func query(_ fields: InstallPollFields) -> [String: String] {
    Dictionary(uniqueKeysWithValues: fields.queryItems().map { ($0.name, $0.value ?? "") })
  }

  @Test func peakAndZeroRatioRideThePollUnderExactlyThoseNames() {
    let measured = Self.query(
      InstallPollFields(
        installID: "install_1", tapeAdvancing: true, peak: 0.8123, zeroRatio: 0.4576))
    #expect(measured["peak"] == "0.8123")
    #expect(measured["zero_ratio"] == "0.4576")
    // The bench-listener level pair keeps its own names; these are not those.
    #expect(measured["mic_peak"] == nil)

    // Not measured, or not a 0–1 number: ABSENT, so the server's COALESCE keeps the last reading.
    // A clamped 1.0 would be indistinguishable from a real full-scale peak.
    for bad in [nil, -0.01, 1.01, .nan, .infinity] as [Double?] {
      let items = Self.query(
        InstallPollFields(installID: "install_1", tapeAdvancing: true, peak: bad, zeroRatio: bad))
      #expect(items["peak"] == nil, "peak \(String(describing: bad))")
      #expect(items["zero_ratio"] == nil, "zero_ratio \(String(describing: bad))")
    }
  }

  /// What the server stores, decoded back out of the query string.
  struct SentDevice: Decodable, Equatable {
    let name: String
    let uid: String
    let is_default: Bool
  }

  static func sentDevices(_ fields: InstallPollFields) throws -> [SentDevice]? {
    guard let json = query(fields)["input_devices"] else { return nil }
    return try JSONDecoder().decode([SentDevice].self, from: Data(json.utf8))
  }

  @Test func theInputDeviceListIsSentWithTheDefaultMarked() throws {
    // OPD 7 has both a TONOR and a C270 attached, and until 0.1.20 nobody could see which was
    // live without SSH.
    let tonor = "AppleUSBAudioEngine:TONOR:TONOR TM20 Audio Device:20200918:1"
    let fields = InstallPollFields(
      installID: "install_1", tapeAdvancing: true,
      inputDevices: [
        AudioInputDeviceEntry(name: "TONOR TM20 Audio Device", uid: tonor, isDefault: true),
        AudioInputDeviceEntry(
          name: "C270 HD WEBCAM", uid: "AppleUSBAudioEngine:Unknown:C270:1", isDefault: false),
      ])
    let sent = try #require(try Self.sentDevices(fields))
    #expect(
      sent == [
        SentDevice(name: "TONOR TM20 Audio Device", uid: tonor, is_default: true),
        SentDevice(name: "C270 HD WEBCAM", uid: "AppleUSBAudioEngine:Unknown:C270:1", is_default: false),
      ])
    // Beside the existing field, not instead of it.
    #expect(
      Self.query(
        InstallPollFields(
          installID: "install_1", tapeAdvancing: true, inputDeviceName: "TONOR TM20 Audio Device",
          inputDevices: fields.inputDevices))["input_device_name"] == "TONOR TM20 Audio Device")

    // Could not ask CoreAudio: absent. No devices at all: an honest empty list.
    #expect(try Self.sentDevices(InstallPollFields(installID: "install_1", tapeAdvancing: true)) == nil)
    #expect(
      try Self.sentDevices(
        InstallPollFields(installID: "install_1", tapeAdvancing: true, inputDevices: [])) == [])
  }

  @Test func theInputDeviceListDropsWhatTheServerWouldRejectAndCapsAtSixteen() throws {
    // `cleanInputDevices` (lib/room-install.ts) throws the WHOLE list away for one bad entry, and
    // measures in UTF-16 units after trimming. The app drops the bad entry instead, by the same
    // measure, so one odd aggregate device cannot blank a room's list.
    func device(_ name: String, _ uid: String, _ isDefault: Bool = false) -> AudioInputDeviceEntry {
      AudioInputDeviceEntry(name: name, uid: uid, isDefault: isDefault)
    }
    let emoji64 = String(repeating: "🎙", count: 64)  // 64 characters, 128 UTF-16 units
    let emoji65 = String(repeating: "🎙", count: 65)  // 65 characters, 130 UTF-16 units
    let fields = InstallPollFields(
      installID: "install_1", tapeAdvancing: true,
      inputDevices: [
        device("Good", "uid-good", true),
        device("  ", "uid-blank-name"),
        device("No uid", " "),
        device(emoji64, "uid-emoji-64"),
        device(emoji65, "uid-emoji-65"),
        device("Long uid", String(repeating: "u", count: 257)),
        device("Longest uid", String(repeating: "u", count: 256)),
        device("A second default", "uid-second-default", true),
        device("  Padded  ", "  uid-padded  "),
      ])
    let sent = try #require(try Self.sentDevices(fields))
    #expect(
      sent.map(\.uid) == [
        "uid-good", "uid-emoji-64", String(repeating: "u", count: 256), "uid-padded",
      ])
    #expect(sent.map(\.name).contains(emoji64))
    #expect(sent.filter(\.is_default).count == 1)
    #expect(sent.first { $0.uid == "uid-padded" }?.name == "Padded")

    // Never more than sixteen.
    let many = InstallPollFields(
      installID: "install_1", tapeAdvancing: true,
      inputDevices: (0..<20).map { device("Mic \($0)", "uid-\($0)", $0 == 0) })
    let capped = try #require(try Self.sentDevices(many))
    #expect(capped.count == 16)
    #expect(capped.map(\.uid) == (0..<16).map { "uid-\($0)" })

    // Devices were reported and every one was unusable: absent, NOT an empty list — "no input
    // devices" would be a claim the machine never made.
    let allBad = InstallPollFields(
      installID: "install_1", tapeAdvancing: true, inputDevices: [device(" ", "uid")])
    #expect(try Self.sentDevices(allBad) == nil)
  }

  @Test func factsCarryTheDeviceListIntoThePoll() {
    let list = [AudioInputDeviceEntry(name: "MacBook Air Microphone", uid: "BuiltIn", isDefault: true)]
    let facts = MachineFacts(
      micState: "authorized", neverSleep: true, launchedBy: "launchd", launchAgentLoaded: true,
      hostname: "mini", hardwareModel: "Mac mini", osVersion: "macOS 15.0",
      inputDeviceName: "MacBook Air Microphone", inputDevices: list)
    let fields = InstallPollFields(installID: "install_1", facts: facts, tapeAdvancing: true)
    #expect(fields.inputDevices == list)
  }

  @Test func factsCarryTheDeviceNameIntoThePoll() {
    let facts = MachineFacts(
      micState: "authorized",
      neverSleep: true,
      launchedBy: "launchd",
      launchAgentLoaded: true,
      hostname: "Vinays-Mac-mini-3",
      hardwareModel: "Mac mini",
      osVersion: "macOS 15.0",
      inputDeviceName: "TONOR TM20 Audio Device"
    )
    let fields = InstallPollFields(installID: "install_1", facts: facts, tapeAdvancing: true)
    #expect(fields.inputDeviceName == "TONOR TM20 Audio Device")
    #expect(fields.tabID == "app_install_1")
  }

  // -------------------------------------------------------------------------
  // Release R4 (D4) — input volume and whether it can be set
  // -------------------------------------------------------------------------

  @Test func inputVolumeAndItsSettabilityRideThePollBesideTheDeviceName() {
    let measured = Self.query(
      InstallPollFields(
        installID: "install_1", tapeAdvancing: true, inputDeviceName: "C270 HD WEBCAM",
        inputVolume: 0.73456, inputVolumeSettable: true))
    #expect(measured["input_volume"] == "0.7346")
    #expect(measured["input_volume_settable"] == "true")
    #expect(measured["input_device_name"] == "C270 HD WEBCAM")

    // A device with no volume control macOS can reach: no volume, and a MEASURED "not settable".
    let knobOnly = Self.query(
      InstallPollFields(
        installID: "install_1", tapeAdvancing: true, inputVolume: nil, inputVolumeSettable: false))
    #expect(knobOnly["input_volume"] == nil)
    #expect(knobOnly["input_volume_settable"] == "false")

    // Device absent: both ABSENT, so the server's COALESCE keeps the last reading. A value outside
    // 0–1 is dropped, never clamped.
    for bad in [nil, -0.01, 1.01, .nan] as [Double?] {
      let items = Self.query(
        InstallPollFields(installID: "install_1", tapeAdvancing: true, inputVolume: bad))
      #expect(items["input_volume"] == nil, "input_volume \(String(describing: bad))")
      #expect(items["input_volume_settable"] == nil)
    }
  }

  @Test func factsCarryTheInputVolumeIntoThePoll() {
    let facts = MachineFacts(
      micState: "authorized", neverSleep: true, launchedBy: "launchd", launchAgentLoaded: true,
      hostname: "mini", hardwareModel: "Mac mini", osVersion: "macOS 15.0",
      inputDeviceName: "C270 HD WEBCAM", inputVolume: 0.5, inputVolumeSettable: true)
    let fields = InstallPollFields(installID: "install_1", facts: facts, tapeAdvancing: true)
    #expect(fields.inputVolume == 0.5)
    #expect(fields.inputVolumeSettable == true)
    // No configured device, or one not attached: nothing is read, nothing is claimed.
    #expect(MachineFactsReader.inputVolume(forUID: nil) == nil)
    #expect(MachineFactsReader.inputVolume(forUID: "") == nil)
    #expect(MachineFactsReader.inputVolume(forUID: "no-such-device-uid-8f2a") == nil)
  }

  // -------------------------------------------------------------------------
  // The name is MEASURED, never invented
  // -------------------------------------------------------------------------

  @Test func anUnknownOrEmptyDeviceReportsNoNameAtAll() {
    #expect(MachineFactsReader.inputDeviceName(forUID: nil) == nil)
    #expect(MachineFactsReader.inputDeviceName(forUID: "") == nil)
    // A UID no device on this Mac carries. Nil, not the UID echoed back.
    #expect(MachineFactsReader.inputDeviceName(forUID: "no-such-device-uid-8f2a") == nil)
  }

  /// A real reading off this machine: whatever CoreAudio calls the current default input, the
  /// lookup by its own UID must return the same name. This is the mechanism V ruled on — enrol
  /// stores the UID, the poll reports the name — exercised end to end without a fixture.
  @Test func theSystemDefaultInputResolvesToItsOwnName() throws {
    guard let device = AudioInputDevices.systemDefault() else {
      // A Mac with no input at all is a legitimate machine; there is nothing to assert on it.
      return
    }
    #expect(!device.uid.isEmpty)
    #expect(!device.name.isEmpty)
    #expect(AudioInputDevices.name(forUID: device.uid) == device.name)
    #expect(MachineFactsReader.inputDeviceName(forUID: device.uid) == device.name)
  }

  // -------------------------------------------------------------------------
  // The migration rule: a re-enrol keeps the room's device
  // -------------------------------------------------------------------------

  @Test func reEnrolKeepsTheDeviceTheRoomIsAlreadyUsing() throws {
    var configuration = try RoomConfiguration(
      origin: try #require(URL(string: "https://www.evenscribe.app")),
      roomSlug: "home-office-w8fb",
      deviceUID: "AppleUSBAudioEngine:FuZhou Kingwayinfo CO.,LTD:TONOR TM20 Audio Device:20200918:1",
      tapewriterPath: "/old/tapewriter",
      ffmpegPath: "/opt/homebrew/bin/ffmpeg"
    )
    configuration.etaRoomSession = "a-token-that-must-not-survive"

    configuration.applyEnrolment(
      origin: try #require(URL(string: "https://www.evenscribe.app")),
      roomSlug: "home-office-w8fb",
      installID: "install_64gbytqcch9s",
      tapewriterPath: "/Applications/EvenScribe Room Recorder.app/Contents/Helpers/tapewriter",
      ffmpegPath: "/Applications/EvenScribe Room Recorder.app/Contents/Helpers/ffmpeg"
    )

    // THE RULE: the mic the room is already recording with is untouched.
    #expect(
      configuration.deviceUID
        == "AppleUSBAudioEngine:FuZhou Kingwayinfo CO.,LTD:TONOR TM20 Audio Device:20200918:1")
    // And everything the enrol IS meant to re-point did move.
    #expect(configuration.installID == "install_64gbytqcch9s")
    #expect(configuration.tabID == "app_install_64gbytqcch9s")
    #expect(configuration.ffmpegPath.hasSuffix("Contents/Helpers/ffmpeg"))
    #expect(configuration.tapewriterPath.hasSuffix("Contents/Helpers/tapewriter"))
    // §5.4: no token is left on disk.
    #expect(configuration.etaRoomSession == nil)
  }

  /// Not running from a bundle means the helpers cannot be resolved. That must leave the
  /// configured paths alone rather than blanking them.
  @Test func enrolmentOutsideABundleKeepsTheConfiguredHelperPaths() throws {
    var configuration = try RoomConfiguration(
      origin: try #require(URL(string: "https://www.evenscribe.app")),
      roomSlug: "home-office-w8fb",
      deviceUID: "AppleUSBAudioEngine:test",
      tapewriterPath: "/configured/tapewriter",
      ffmpegPath: "/configured/ffmpeg"
    )
    configuration.applyEnrolment(
      origin: try #require(URL(string: "https://www.evenscribe.app")),
      roomSlug: "home-office-w8fb",
      installID: "install_2",
      tapewriterPath: nil,
      ffmpegPath: nil
    )
    #expect(configuration.tapewriterPath == "/configured/tapewriter")
    #expect(configuration.ffmpegPath == "/configured/ffmpeg")
    #expect(configuration.deviceUID == "AppleUSBAudioEngine:test")
  }

  // -------------------------------------------------------------------------
  // The error code that cost an hour
  // -------------------------------------------------------------------------

  /// `RoomConfigurationError` bridges to NSError by case ORDINAL, and Swift puts the cases with
  /// associated values first. Reading `error 6` off the declaration order gives `unsafeRoot`; the
  /// real answer is `invalidDeviceUID`. This test pins the mapping so that adding or reordering a
  /// case fails here rather than in a diagnosis at 3am.
  @Test func errorCodesAreNotDeclarationOrder() {
    #expect((RoomConfigurationError.invalidExecutablePath("x") as NSError).code == 0)
    #expect((RoomConfigurationError.invalidIdentifier("x") as NSError).code == 1)
    #expect((RoomConfigurationError.invalidArchivePreflightReceipt("x") as NSError).code == 2)
    #expect(
      (RoomConfigurationError.permissionsNotEnforced(path: "p", expected: 0o700, actual: nil)
        as NSError).code == 3)
    #expect((RoomConfigurationError.invalidOrigin as NSError).code == 4)
    #expect((RoomConfigurationError.invalidRoomSlug as NSError).code == 5)
    #expect((RoomConfigurationError.invalidDeviceUID as NSError).code == 6)
    #expect((RoomConfigurationError.unsafeRoot as NSError).code == 7)
    #expect((RoomConfigurationError.rootIsNotDirectory as NSError).code == 8)
  }
}
