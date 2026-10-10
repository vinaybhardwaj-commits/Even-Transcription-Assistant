/** TS-H3 (#40): the cross-language test vectors in ts-h3/PROTOCOL.md. If this test changes, the Swift client's vectors change with it. Pure; no database. */
import { describe, it, expect } from "vitest";
import { parseJws, verifyJws, sha256b64url, decodePublicKey } from "@/lib/fleet/jws";
import { checkClaims, FLEET_AUD, FLEET_REGISTER_AUD } from "@/lib/fleet/device-auth";

const V = {
  "seed_hex": "0707070707070707070707070707070707070707070707070707070707070707",
  "public_key_b64": "6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=",
  "pk_sha256_b64url": "_oEsEvOrTOasXbaaw1L5BssbEe9D-zPiUu9_9VImOIk",
  "poll": "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImRldl8wMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDEifQ.eyJpc3MiOiJkZXZfMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAxIiwiYXVkIjoiZXZlbnNjcmliZS1mbGVldCIsImlhdCI6MTc2MDAwMDAwMCwiZXhwIjoxNzYwMDAwMzAwLCJqdGkiOiIxMTExMTExMS0yMjIyLTMzMzMtNDQ0NC01NTU1NTU1NTU1NTUiLCJodG0iOiJHRVQiLCJodHUiOiIvYXBpL2ZsZWV0L3BvbGwifQ.bpX6Ax3k7g7b7CjgcaBwnnjrmmkthWaHgQ8PKLqtEweE_HCmu3osPnU-51G1mEk4Jhv-GUJ7y_WOFpPa8_FJDg",
  "results": "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImRldl8wMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDEifQ.eyJpc3MiOiJkZXZfMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAxIiwiYXVkIjoiZXZlbnNjcmliZS1mbGVldCIsImlhdCI6MTc2MDAwMDAwMCwiZXhwIjoxNzYwMDAwMzAwLCJqdGkiOiI2NjY2NjY2Ni03Nzc3LTg4ODgtOTk5OS0wMDAwMDAwMDAwMDAiLCJodG0iOiJQT1NUIiwiaHR1IjoiL2FwaS9mbGVldC9yZXN1bHRzIiwiYnNoYSI6Im9uOEZTblgwQ2FZbzdTc05TbEZ5eGFxeXROampTa0F4elN5REVHZ2haN28ifQ.c5whGcpxVcxPbQlHzztPTdLyhgJmbZAh2TtspneA9XlAzJQAadN5nsvojkhrO0UuJPDRW_haJYCSSD_ttbYDAg",
  "body": "{\"cmd_id\":\"cmd_x\",\"device_id\":\"dev_000000000000000000000001\",\"outcome\":\"ok\"}",
  "bsha": "on8FSnX0CaYo7SsNSlFyxaqytNjjSkAxzSyDEGghZ7o",
  "proof": "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6Imluc3RhbGw6aW5zdF9leGFtcGxlIn0.eyJpc3MiOiJpbnN0X2V4YW1wbGUiLCJhdWQiOiJldmVuc2NyaWJlLWZsZWV0LXJlZ2lzdGVyIiwiaWF0IjoxNzYwMDAwMDAwLCJleHAiOjE3NjAwMDAzMDAsImp0aSI6ImFhYWFhYWFhLWJiYmItY2NjYy1kZGRkLWVlZWVlZWVlZWVlZSIsImh0bSI6IlBPU1QiLCJodHUiOiIvYXBpL2ZsZWV0L3JlZ2lzdGVyIiwicGsiOiJfb0VzRXZPclRPYXNYYmFhdzFMNUJzc2JFZTlELXpQaVV1OV85VkltT0lrIn0.sP7YyCK-0N0FO0JK5oT72gGn7-4v2VaGlND8T8w9-PyBKvcXqd6GQzgL1Ko5hGOQ-a0c6zHrlp_3yWzfT1e7CQ"
} as const;
const NOW = 1760000100_000;

describe("fleet JWS vectors", () => {
  it("the public key decodes to 32 bytes and hashes to the pk claim", () => {
    expect(decodePublicKey(V.public_key_b64)?.length).toBe(32);
    expect(sha256b64url(decodePublicKey(V.public_key_b64)!)).toBe(V.pk_sha256_b64url);
  });
  it("poll token: signature verifies and the claims pass for GET /api/fleet/poll", () => {
    const j = parseJws(V.poll)!;
    expect(verifyJws(j, V.public_key_b64)).toBe(true);
    expect(checkClaims(j.payload, { aud: FLEET_AUD, nowMs: NOW, method: "GET", path: "/api/fleet/poll" })).toBeNull();
    expect(checkClaims(j.payload, { aud: FLEET_AUD, nowMs: NOW, method: "GET", path: "/api/fleet/results" })).toBe("request_mismatch");
  });
  it("results token: bsha is the SHA-256 of the exact body bytes", () => {
    const j = parseJws(V.results)!;
    expect(verifyJws(j, V.public_key_b64)).toBe(true);
    expect(sha256b64url(V.body)).toBe(V.bsha);
    expect(checkClaims(j.payload, { aud: FLEET_AUD, nowMs: NOW, method: "POST", path: "/api/fleet/results", bodyText: V.body })).toBeNull();
    expect(checkClaims(j.payload, { aud: FLEET_AUD, nowMs: NOW, method: "POST", path: "/api/fleet/results", bodyText: V.body + " " })).toBe("request_mismatch");
  });
  it("registration proof: aud, pk, no bsha", () => {
    const j = parseJws(V.proof)!;
    expect(verifyJws(j, V.public_key_b64)).toBe(true);
    expect(checkClaims(j.payload, { aud: FLEET_REGISTER_AUD, nowMs: NOW, method: "POST", path: "/api/fleet/register", bodyBound: false })).toBeNull();
    expect(j.payload.pk).toBe(V.pk_sha256_b64url);
  });
  it("a one-bit change to any token breaks it", () => {
    const flipped = V.poll.slice(0, -2) + (V.poll.endsWith("DA") ? "DB" : "DA");
    const j = parseJws(flipped);
    expect(j === null || !verifyJws(j, V.public_key_b64)).toBe(true);
  });
});
