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
