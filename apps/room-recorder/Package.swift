// swift-tools-version: 6.2

import Foundation
import PackageDescription

let includeDurabilityFaultProbe =
  ProcessInfo.processInfo.environment["ETA_INCLUDE_DURABILITY_FAULT_PROBE"] == "1"
let includeKeywrapProbe =
  ProcessInfo.processInfo.environment["ETA_INCLUDE_KEYWRAP_PROBE"] == "1"

var products: [Product] = [
  .library(name: "TapeCore", targets: ["TapeCore"]),
  .executable(name: "tapewriter", targets: ["tapewriter"]),
  .executable(name: "room-recorder", targets: ["RoomRecorderCLI"]),
  .executable(name: "room-recorder-helper", targets: ["room-recorder-helper"]),
]

var targets: [Target] = [
  .target(name: "MicModeShim", path: "Sources/MicModeShim"),
  .target(
    name: "TapeCore",
    swiftSettings: includeKeywrapProbe ? [.define("ETA_KEYWRAP_PROBE")] : []),
  .target(
    name: "TapeCapture",
    dependencies: ["TapeCore", "MicModeShim"],
    path: "Sources/tapewriter",
    swiftSettings: includeDurabilityFaultProbe
      ? [.define("ETA_DURABILITY_FAULT_PROBE")]
      : []
  ),
  .target(name: "HelperCore", dependencies: ["FleetCore", "KioskHealthCore"]),
  // The kiosk-health collectors (0.1.36, #47). IOKit and CoreFoundation only: CoreAudio and CoreGraphics are
  // deliberately NOT linked, because touching them makes macOS run TCC checks for a headless root daemon.
  .target(
    name: "KioskHealthCore",
    linkerSettings: [.linkedFramework("IOKit"), .linkedFramework("CoreFoundation")]),
  .target(name: "FleetCore"),
  .target(
    name: "RoomRecorderCore",
    dependencies: ["TapeCore", "TapeCapture", "HelperCore", "FleetCore"]
  ),
  .executableTarget(
    name: "room-recorder-helper",
    dependencies: ["HelperCore", "KioskHealthCore"],
    exclude: ["Info.plist"],
    linkerSettings: [
      .unsafeFlags([
        "-Xlinker", "-sectcreate",
        "-Xlinker", "__TEXT",
        "-Xlinker", "__info_plist",
        "-Xlinker", "Sources/room-recorder-helper/Info.plist",
      ])
    ]
  ),
  .executableTarget(
    name: "tapewriter",
    dependencies: ["TapeCore", "TapeCapture"],
    path: "Sources/TapewriterCLI",
    exclude: ["Info.plist"],
    linkerSettings: [
      .unsafeFlags([
        "-Xlinker", "-sectcreate",
        "-Xlinker", "__TEXT",
        "-Xlinker", "__info_plist",
        "-Xlinker", "Sources/TapewriterCLI/Info.plist",
      ])
    ]
  ),
  .executableTarget(
    name: "RoomRecorderCLI",
    dependencies: ["RoomRecorderCore"]
  ),
  .testTarget(name: "HelperCoreTests", dependencies: ["HelperCore", "FleetCore", "RoomRecorderCore", "KioskHealthCore"]),
  .testTarget(
    name: "KioskHealthCoreTests", dependencies: ["KioskHealthCore"], exclude: ["Fixtures"]),
  .testTarget(
    name: "TapeCoreTests",
    dependencies: ["TapeCore", "TapeCapture", "RoomRecorderCore", "HelperCore"],
    swiftSettings: includeKeywrapProbe ? [.define("ETA_KEYWRAP_PROBE")] : []),
]

if includeDurabilityFaultProbe {
  targets.append(
    .executableTarget(
      name: "DurabilityFaultProbe",
      dependencies: ["TapeCapture"],
      path: "Tests/DurabilityFaultProbe"
    )
  )
}

if includeKeywrapProbe {
  products.append(.executable(name: "ArchiveKeywrapProbe", targets: ["ArchiveKeywrapProbe"]))
  targets.append(
    .executableTarget(
      name: "ArchiveKeywrapProbe",
      dependencies: ["TapeCore"],
      path: "Tests/ArchiveKeywrapProbe"
    )
  )
}

let package = Package(
  name: "ETARoomRecorder",
  platforms: [.macOS(.v15)],
  products: products,
  targets: targets,
  swiftLanguageModes: [.v5]
)
