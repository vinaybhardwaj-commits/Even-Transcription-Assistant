import Foundation

/// The server's cross-language vectors (docs/fleet/PROTOCOL.md §7, tests/unit/fleet-jws-vector.test.ts on
/// origin/gating/ts-h3). A FIXED-SEED THROWAWAY KEY (0x07 x 32), not a credential. If the server test's
/// vectors change, these change with them.
enum FleetVectors {
  static let seedHex = "0707070707070707070707070707070707070707070707070707070707070707"
  static let publicKeyB64 = "6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw="
  static let pkSHA256B64URL = "_oEsEvOrTOasXbaaw1L5BssbEe9D-zPiUu9_9VImOIk"
  static let deviceID = "dev_000000000000000000000001"
  static let installID = "inst_example"
  static let iat = 1_760_000_000
  static let body = #"{"cmd_id":"cmd_x","device_id":"dev_000000000000000000000001","outcome":"ok"}"#
  static let bsha = "on8FSnX0CaYo7SsNSlFyxaqytNjjSkAxzSyDEGghZ7o"
  static let poll = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImRldl8wMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDEifQ.eyJpc3MiOiJkZXZfMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAxIiwiYXVkIjoiZXZlbnNjcmliZS1mbGVldCIsImlhdCI6MTc2MDAwMDAwMCwiZXhwIjoxNzYwMDAwMzAwLCJqdGkiOiIxMTExMTExMS0yMjIyLTMzMzMtNDQ0NC01NTU1NTU1NTU1NTUiLCJodG0iOiJHRVQiLCJodHUiOiIvYXBpL2ZsZWV0L3BvbGwifQ.bpX6Ax3k7g7b7CjgcaBwnnjrmmkthWaHgQ8PKLqtEweE_HCmu3osPnU-51G1mEk4Jhv-GUJ7y_WOFpPa8_FJDg"  // gitleaks:allow
  static let results = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImRldl8wMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDEifQ.eyJpc3MiOiJkZXZfMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAxIiwiYXVkIjoiZXZlbnNjcmliZS1mbGVldCIsImlhdCI6MTc2MDAwMDAwMCwiZXhwIjoxNzYwMDAwMzAwLCJqdGkiOiI2NjY2NjY2Ni03Nzc3LTg4ODgtOTk5OS0wMDAwMDAwMDAwMDAiLCJodG0iOiJQT1NUIiwiaHR1IjoiL2FwaS9mbGVldC9yZXN1bHRzIiwiYnNoYSI6Im9uOEZTblgwQ2FZbzdTc05TbEZ5eGFxeXROampTa0F4elN5REVHZ2haN28ifQ.c5whGcpxVcxPbQlHzztPTdLyhgJmbZAh2TtspneA9XlAzJQAadN5nsvojkhrO0UuJPDRW_haJYCSSD_ttbYDAg"  // gitleaks:allow
  static let proof = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6Imluc3RhbGw6aW5zdF9leGFtcGxlIn0.eyJpc3MiOiJpbnN0X2V4YW1wbGUiLCJhdWQiOiJldmVuc2NyaWJlLWZsZWV0LXJlZ2lzdGVyIiwiaWF0IjoxNzYwMDAwMDAwLCJleHAiOjE3NjAwMDAzMDAsImp0aSI6ImFhYWFhYWFhLWJiYmItY2NjYy1kZGRkLWVlZWVlZWVlZWVlZSIsImh0bSI6IlBPU1QiLCJodHUiOiIvYXBpL2ZsZWV0L3JlZ2lzdGVyIiwicGsiOiJfb0VzRXZPclRPYXNYYmFhdzFMNUJzc2JFZTlELXpQaVV1OV85VkltT0lrIn0.sP7YyCK-0N0FO0JK5oT72gGn7-4v2VaGlND8T8w9-PyBKvcXqd6GQzgL1Ko5hGOQ-a0c6zHrlp_3yWzfT1e7CQ"  // gitleaks:allow
}
