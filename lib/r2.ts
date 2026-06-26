/**
 * Cloudflare R2 client + presigner helpers.
 *
 * R2 is S3-compatible, so we reuse @aws-sdk/client-s3 with the R2
 * endpoint and credentials. `region="auto"` is the R2 convention.
 *
 * Presigned PUT URLs let the browser upload audio directly to R2,
 * bypassing the Vercel function payload cap (~4.5MB) and saving the
 * lambda bandwidth + execution time.
 *
 * B7 adds server-side GET/PUT/DELETE helpers used by the whisper-chunk
 * route to maintain a per-encounter rolling buffer at
 * `whisper-buffer/{encounter_id}.webm`.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let _client: S3Client | null = null;

function client(): S3Client {
  if (_client) return _client;
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("r2_credentials_missing");
  }
  _client = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
  return _client;
}

// Hard bound on a single R2 request. The S3 client has no default request/connection
// timeout, so a stalled connection can hang getObjectBytes/headObject indefinitely —
// which freezes the background translate/diarize step's after() until it is reclaimed
// (silently, no error). AbortSignal.timeout() fails the request fast so the step's
// soft-fallbacks take over and the pipeline progresses. (Node 18+/24 has AbortSignal.timeout.)
const R2_OP_TIMEOUT_MS = 45_000;

export function bucket(): string {
  const b = process.env.R2_BUCKET;
  if (!b) throw new Error("R2_BUCKET not set");
  return b;
}

export function audioObjectKey(encounterId: string, ext: string = "webm"): string {
  // single-file-per-encounter naming; safe characters only
  return `encounters/${encounterId}.${ext}`;
}

/**
 * Key for the rolling Whisper buffer that accumulates raw MediaRecorder
 * output between rolling passes. Cleaned up by /finalize-upload after
 * the encounter is submitted (or by an orphan sweep later).
 */
export function whisperBufferKey(encounterId: string): string {
  return `whisper-buffer/${encounterId}.webm`;
}

export async function signPutUrl(opts: {
  key: string;
  contentType: string;
  expiresInSeconds?: number;
}): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: bucket(),
    Key: opts.key,
    ContentType: opts.contentType,
  });
  return getSignedUrl(client(), cmd, {
    expiresIn: opts.expiresInSeconds ?? 600, // 10 min
  });
}

/**
 * Presigned GET URL for reading an object back (admin audio playback/download).
 * When `downloadFilename` is set, R2 returns Content-Disposition: attachment so
 * the browser downloads instead of navigating; otherwise it streams (seekable,
 * R2 honours Range) for an inline <audio> player.
 */
export async function signGetUrl(opts: {
  key: string;
  expiresInSeconds?: number;
  downloadFilename?: string;
  contentType?: string;
}): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: bucket(),
    Key: opts.key,
    ...(opts.downloadFilename
      ? { ResponseContentDisposition: `attachment; filename="${opts.downloadFilename}"` }
      : {}),
    ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
  });
  return getSignedUrl(client(), cmd, {
    expiresIn: opts.expiresInSeconds ?? 3600, // 1 h — long enough to play a full consult
  });
}

export async function headObject(key: string): Promise<{
  size: number | null;
  content_type: string | null;
}> {
  try {
    const res = await client().send(
      new HeadObjectCommand({ Bucket: bucket(), Key: key }),
      { abortSignal: AbortSignal.timeout(R2_OP_TIMEOUT_MS) },
    );
    return {
      size: typeof res.ContentLength === "number" ? res.ContentLength : null,
      content_type: res.ContentType ?? null,
    };
  } catch {
    return { size: null, content_type: null };
  }
}

/**
 * Fetch an object's bytes. Returns null if the object doesn't exist
 * (NoSuchKey / 404) so callers can distinguish "no buffer yet" from
 * a real error.
 */
export async function getObjectBytes(key: string): Promise<Uint8Array | null> {
  try {
    const res = await client().send(
      new GetObjectCommand({ Bucket: bucket(), Key: key }),
      { abortSignal: AbortSignal.timeout(R2_OP_TIMEOUT_MS) },
    );
    if (!res.Body) return null;
    // SDK v3 Body is a Smithy stream that exposes transformToByteArray()
    // in Node + browser runtimes; fall back to async-iterable for older
    // SDK versions.
    type ByteStream = { transformToByteArray: () => Promise<Uint8Array> };
    const stream = res.Body as unknown as ByteStream;
    if (typeof stream.transformToByteArray === "function") {
      // Bound the BODY-stream read too: the send() abortSignal covers getting the response,
      // but a stalled body stream (R2 sends headers then hangs) can still block transformToByteArray
      // indefinitely and freeze the translate step. Race it against a hard timeout.
      return await Promise.race([
        stream.transformToByteArray(),
        new Promise<Uint8Array>((_, rej) => setTimeout(() => rej(new Error("r2_body_read_timeout")), R2_OP_TIMEOUT_MS)),
      ]);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as unknown as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    return new Uint8Array(Buffer.concat(chunks));
  } catch (e) {
    const meta = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    if (meta?.name === "NoSuchKey" || meta?.Code === "NoSuchKey" || meta?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw e;
  }
}

export async function putObjectBytes(
  key: string,
  bytes: Uint8Array,
  contentType: string = "application/octet-stream",
): Promise<void> {
  await client().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: bytes,
      ContentType: contentType,
    }),
  );
}

export async function deleteObject(key: string): Promise<void> {
  try {
    await client().send(
      new DeleteObjectCommand({ Bucket: bucket(), Key: key }),
    );
  } catch {
    // Best-effort delete; missing buffer is fine.
  }
}
