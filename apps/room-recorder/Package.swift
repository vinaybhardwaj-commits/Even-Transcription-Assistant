// swift-tools-version: 6.2

import PackageDescription

let package = Package(
  name: "ETARoomRecorder",
  platforms: [.macOS(.v15)],
  products: [
    .library(name: "TapeCore", targets: ["TapeCore"]),
    .executable(name: "tapewriter", targets: ["tapewriter"]),
  ],
  targets: [
    .target(name: "TapeCore"),
    .target(
      name: "TapeCapture",
      dependencies: ["TapeCore"],
      path: "Sources/tapewriter"
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
  ],
  swiftLanguageModes: [.v5]
)
