import Foundation

public struct ArchiveFFmpegCommand: Equatable, Sendable {
  public static let contentType = "audio/webm"

  public let executableURL: URL

  public init(executableURL: URL) {
    self.executableURL = executableURL
  }

  public var arguments: [String] {
    [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-nostats",
      "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "pipe:0",
      "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1",
      "-c:a", "libopus", "-application", "voip", "-b:a", "32k", "-vbr", "on",
      "-frame_duration", "20", "-packet_loss", "0", "-fec", "0", "-dtx", "0",
      "-ar", "16000", "-ac", "1", "-write_crc32", "1", "-cluster_time_limit", "5000",
      "-live", "1", "-f", "webm", "pipe:1",
    ]
  }
}
