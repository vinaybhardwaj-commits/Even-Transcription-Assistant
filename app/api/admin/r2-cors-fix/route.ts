/**
 * POST /api/admin/r2-cors-fix
 *
 * One-shot helper that updates the R2 bucket's CORS policy from
 * application code. Built when V's Cloudflare dashboard hung mid-fix
 * after the domain swap to evenscribe.app — needed a way to allow the
 * new origin without waiting for the dashboard.
 *
 * Allowed origins (covers current + legacy hosts):
 *   - https://evenscribe.app
 *   - https://www.evenscribe.app
 *   - https://eta.llmvinayminihome.uk
 *
 * Methods: GET PUT POST DELETE HEAD
 * Headers: * (echo all)
 * Expose: ETag (so JS can read the upload-success hash)
 * MaxAge: 3600s
 *
 * Admin-cookie gated. Idempotent — safe to call multiple times.
 * Logs the action to audit_log.
 *
 * Delete this route after launch unless we expect to re-tweak CORS often.
 */
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from "@aws-sdk/client-s3";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ORIGINS = [
  "https://evenscribe.app",
  "https://www.evenscribe.app",
  "https://eta.llmvinayminihome.uk",
];

export async function POST() {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let adminId = "";
  try {
    const claims = await verifyAdminJwt(cookie);
    adminId = String(claims.admin_id ?? "");
  } catch {
    return respondError("AUTH_EXPIRED", "Session invalid");
  }

  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET ?? "eta-audio";
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    return respondError("UPSTREAM_UNAVAILABLE", "r2_credentials_missing");
  }

  const client = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  // 1) Read current CORS (for audit trail).
  let before: unknown = null;
  try {
    const cur = await client.send(new GetBucketCorsCommand({ Bucket: bucketName }));
    before = cur.CORSRules ?? null;
  } catch (e) {
    // It's normal for an unconfigured bucket to throw NoSuchCORSConfiguration here.
    before = { error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }

  // 2) Apply the new CORS configuration.
  const corsConfig = {
    Bucket: bucketName,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: ALLOWED_ORIGINS,
          AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
          AllowedHeaders: ["*"],
          ExposeHeaders: ["ETag"],
          MaxAgeSeconds: 3600,
        },
      ],
    },
  };

  try {
    await client.send(new PutBucketCorsCommand(corsConfig));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", `put_cors_failed: ${msg.slice(0, 200)}`);
  }

  // 3) Verify the new CORS state for the audit trail.
  let after: unknown = null;
  try {
    const cur = await client.send(new GetBucketCorsCommand({ Bucket: bucketName }));
    after = cur.CORSRules ?? null;
  } catch (e) {
    after = { error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }

  // 4) Audit log
  await sql`
    INSERT INTO audit_log
      (actor_type, actor_id, action, target_type, target_id, metadata_json)
    VALUES
      ('admin', ${adminId}, 'r2.cors_update', 'r2_bucket', ${bucketName},
       ${JSON.stringify({ allowed_origins: ALLOWED_ORIGINS, before, after })}::jsonb)
  `.catch(() => {});

  return respondOk({
    ok: true,
    bucket: bucketName,
    allowed_origins: ALLOWED_ORIGINS,
    before,
    after,
  });
}
