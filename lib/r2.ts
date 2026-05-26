/**
 * Cloudflare R2 client + presigner helpers.
 *
 * R2 is S3-compatible, so we reuse @aws-sdk/client-s3 with the R2
 * endpoint and credentials. `region="auto"` is the R2 convention.
 *
 * Presigned PUT URLs let the browser upload audio directly to R2,
 * bypassing the Vercel function payload cap (~4.5MB) and saving the
 * lambda bandwidth + execution time.
 */
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
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

export function bucket(): string {
  const b = process.env.R2_BUCKET;
  if (!b) throw new Error("R2_BUCKET not set");
  return b;
}

export function audioObjectKey(encounterId: string, ext: string = "webm"): string {
  // single-file-per-encounter naming; safe characters only
  return `encounters/${encounterId}.${ext}`;
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

export async function headObject(key: string): Promise<{
  size: number | null;
  content_type: string | null;
}> {
  try {
    const res = await client().send(
      new HeadObjectCommand({ Bucket: bucket(), Key: key }),
    );
    return {
      size: typeof res.ContentLength === "number" ? res.ContentLength : null,
      content_type: res.ContentType ?? null,
    };
  } catch {
    return { size: null, content_type: null };
  }
}
