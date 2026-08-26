import Darwin
import Foundation
import TapeCapture

do {
  try runDurabilityFaultProbe(arguments: Array(CommandLine.arguments.dropFirst()))
} catch {
  fputs("DurabilityFaultProbe: \(error.localizedDescription)\n", stderr)
  _exit(64)
}
_exit(65)
