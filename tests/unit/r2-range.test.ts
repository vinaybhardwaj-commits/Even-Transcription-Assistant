/**
 * CATALOG-7 — lib/r2 getObjectRange: the Range header is exactly bytes=start-endInclusive, the total comes from Content-Range, 404 is null and 416 is out of range. The S3 client is a stub.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({ inputs: [] as Array<Record<string, unknown>>, reply: null as unknown }));
vi.mock("@aws-sdk/client-s3", () => {
  class Cmd { constructor(public input: Record<string, unknown>) {} }
  return {
    S3Client: class { async send(c: Cmd) { H.inputs.push(c.input); if (H.reply instanceof Error) throw H.reply; return H.reply; } },
    GetObjectCommand: Cmd, PutObjectCommand: Cmd, HeadObjectCommand: Cmd, DeleteObjectCommand: Cmd,
  };
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: async () => "x" }));

beforeEach(() => {
  H.inputs = [];
  process.env.R2_ENDPOINT = "https://r2.example.test";
  process.env.R2_ACCESS_KEY_ID = "k";
  process.env.R2_SECRET_ACCESS_KEY = "s";
  process.env.R2_BUCKET = "bucket-under-test";
});

const body = (b: number[]) => ({ transformToByteArray: async () => Uint8Array.from(b) });

describe("getObjectRange", () => {
  it("sends Range: bytes=start-endInclusive against R2_BUCKET and reads the total from Content-Range", async () => {
    const { getObjectRange } = await import("@/lib/r2");
    H.reply = { Body: body([1, 2, 3]), ContentRange: "bytes 10-12/500" };
    const out = await getObjectRange("some/key", 10, 12);
    expect(H.inputs).toEqual([{ Bucket: "bucket-under-test", Key: "some/key", Range: "bytes=10-12" }]);
    expect(out).toEqual({ bytes: Uint8Array.from([1, 2, 3]), totalBytes: 500 });
  });
  it("no Content-Range header: totalBytes null; a missing object is null; 416 is out of range; other errors throw", async () => {
    const { getObjectRange } = await import("@/lib/r2");
    H.reply = { Body: body([9]) };
    expect(await getObjectRange("k", 0, 0)).toEqual({ bytes: Uint8Array.from([9]), totalBytes: null });
    H.reply = Object.assign(new Error("x"), { name: "NoSuchKey" });
    expect(await getObjectRange("k", 0, 0)).toBeNull();
    H.reply = Object.assign(new Error("x"), { $metadata: { httpStatusCode: 416 } });
    expect(await getObjectRange("k", 99, 100)).toEqual({ outOfRange: true });
    H.reply = Object.assign(new Error("x"), { $metadata: { httpStatusCode: 500 } });
    await expect(getObjectRange("k", 0, 0)).rejects.toThrow();
  });
});
