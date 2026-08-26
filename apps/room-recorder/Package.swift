// swift-tools-version: 6.2

import Foundation
import PackageDescription

let includeDurabilityFaultProbe =
  ProcessInfo.processInfo.environment["ETA_INCLUDE_DURABILITY_FAULT_PROBE"] == "1"

var targets: [Target] = [
  .target(name: "TapeCore"),
  .target(
    name: "TapeCapture",
    dependencies: ["TapeCore"],
    path: "Sources/tapewriter",
    swiftSettings: includeDurabilityFaultProbe
      ? [.define("ETA_DURABILITY_FAULT_PROBE")]
      : []
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
  .testTarget(name: "TapeCoreTests", dependencies: ["TapeCore", "TapeCapture"]),
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

let package = Package(
  name: "ETARoomRecorder",
  platforms: [.macOS(.v15)],
  products: [
    .library(name: "TapeCore", targets: ["TapeCore"]),
    .executable(name: "tapewriter", targets: ["tapewriter"]),
  ],
  targets: targets,
  swiftLanguageModes: [.v5]
)
