// swift-tools-version:6.0
// U0-A: the conformance runner for the room-recorder tape format.
// Build (binding since U1 step 3): docker build -t eta-u1-build -f tools/build.Dockerfile tools
//   docker run --rm -v "$PWD":/w -w /w eta-u1-build swift build -c release --static-swift-stdlib
import PackageDescription

let package = Package(
    name: "room-recorder-linux",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "ConformanceKit", targets: ["ConformanceKit"]),
        .library(name: "TapeConvert", targets: ["TapeConvert"]),
        .executable(name: "conformance", targets: ["conformance"]),
        .executable(name: "capture-probe", targets: ["capture-probe"]),
        .executable(name: "room-recorder", targets: ["room-recorder"]),
    ],
    targets: [
        // Platform-neutral conversion core: no Foundation, no ALSA.
        .target(name: "TapeConvert"),
        .target(name: "ConformanceKit", dependencies: ["TapeConvert", "TapeCore", "CaptureCore", "RecorderCore"]),
        .executableTarget(name: "conformance", dependencies: ["ConformanceKit", "TapeConvert"]),
        // U1 step 2. CaptureCore: the counted ring, no ALSA. ALSACapture: alsa-lib through dlopen.
        .target(name: "CaptureCore"),
        // alsa-lib, linked dynamically against its headers (libasound2-dev in the build image).
        .systemLibrary(name: "CALSA", path: "Sources/CALSA", providers: [.apt(["libasound2-dev"])]),
        .target(name: "ALSACapture", dependencies: ["CALSA"]),
        .executableTarget(name: "capture-probe", dependencies: ["CaptureCore", "ALSACapture"]),
        // U1 step 3. TapeCore: the tape writer, no ALSA import.
        .target(name: "TapeCore"),
        // U1 step 5. RecorderCore: the writer loop (ring → decimator → tape), shared with the fixture generator. No ALSA.
        .target(name: "RecorderCore", dependencies: ["CaptureCore", "TapeConvert", "TapeCore"]),
        .executableTarget(name: "room-recorder", dependencies: ["ALSACapture", "CaptureCore", "RecorderCore", "TapeCore"]),
    ]
)
