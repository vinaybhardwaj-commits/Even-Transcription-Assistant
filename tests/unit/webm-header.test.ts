import { describe, it, expect } from "vitest";
import { bytesHaveEbml } from "@/lib/webm-header";

describe("bytesHaveEbml", () => {
  it("accepts a valid EBML/WebM header", () => {
    expect(bytesHaveEbml(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f]))).toBe(true);
  });
  it("rejects the headerless enc_hndp7k6d4u signature (starts 0x01 0xa3)", () => {
    expect(bytesHaveEbml(new Uint8Array([0x01, 0xa3, 0xae, 0x81]))).toBe(false);
  });
  it("rejects too-short input", () => {
    expect(bytesHaveEbml(new Uint8Array([0x1a, 0x45]))).toBe(false);
  });
});
