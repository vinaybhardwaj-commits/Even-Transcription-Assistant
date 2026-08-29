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
]

var targets: [Target] = [
  .target(
    name: "TapeCore",
    swiftSettings: includeKeywrapProbe ? [.define("ETA_KEYWRAP_PROBE")] : []),
  .target(
    name: "TapeCapture",
    dependencies: ["TapeCore"],
    path: "Sources/tapewriter",
    swiftSettings: includeDurabilityFaultProbe
      ? [.define("ETA_DURABILITY_FAULT_PROBE")]
      : []
  ),
  .target(
    name: "RoomRecorderCore",
    dependencies: ["TapeCore", "TapeCapture"]
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
  .testTarget(
    name: "TapeCoreTests",
    dependencies: ["TapeCore", "TapeCapture", "RoomRecorderCore"],
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
