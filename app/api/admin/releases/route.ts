/**
 * /api/admin/releases — register and list Room Recorder builds (Install and Fleet PRD §4.2, D7).
 *
 * POST registers a bundle the publisher has ALREADY uploaded to Vercel Blob. The body carries the
 * `blob_url` and the packaging script's `release.json`; nothing else. There is no multipart upload
 * here and no presign route, because @vercel/blob already puts the bytes in the store and this
 * project needs no door of its own for that (the P2 ruling).
 *
 * ─── NO FIELD ON THIS ROUTE IS BELIEVED ──────────────────────────────────────────────────
 * `version` and `build_sha` come from the manifest, which the packaging script derived from the
 * bundle's Info.plist. `sha256` and `size_bytes` are RECOMPUTED HERE, by streaming the Blob
 * object, and any difference from the manifest is refused with SHA_MISMATCH. So the row that
 * reaches the table is the server's own answer about bytes the server has read — and the same
 * answer is handed to `shasum -a 256` on the clinic Mac by the bootstrap script.
 *
 * That is what "labels derived, never typed" means in practice: there is no request shape that
 * puts a checksum in this table without the bytes behind it agreeing.
 *
 * GET lists, newest first, optionally filtered by channel. Both are admin-gated and both also
 * accept Bearer MIGRATION_SECRET, the stt admin route pattern, so V can drive publication with
 * curl.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  createRelease,
  installAdminGuard,
  installError,
  installErrorFrom,
  isBlobUrl,
  listReleases,
  parseManifest,
} from "@/lib/room-install";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Hashing a tens-of-megabytes bundle over the network is the slow part, and it is bounded. */
export const maxDuration = 300;

const NO_STORE = { headers: { "cache-control": "no-store" } };

export async function GET(req: NextRequest) {
  const guard = await installAdminGuard(req);
  if (!guard.ok) {
    return NextResponse.json(
      { error: { code: "AUTH_REQUIRED", message: "admin or migration secret required" } },
      { status: 401, ...NO_STORE },
    );
  }
  try {
    return NextResponse.json({ releases: await listReleases(req.nextUrl.searchParams.get("channel")) }, NO_STORE);
  } catch (e) {
    return installErrorFrom(e);
  }
}

export async function POST(req: NextRequest) {
  const guard = await installAdminGuard(req);
  if (!guard.ok) {
    return NextResponse.json(
      { error: { code: "AUTH_REQUIRED", message: "admin or migration secret required" } },
      { status: 401, ...NO_STORE },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return installError("BAD_BUNDLE", "body must be JSON");
  }
  const b = (body ?? {}) as Record<string, unknown>;

  // The blob URL is not merely a database field: the bootstrap script hands it to `curl` on a
  // clinic Mac. It must be an address in the Blob store, and this says so before anything is
  // fetched from it.
  if (!isBlobUrl(b.blob_url)) {
    return installError("BAD_BUNDLE", "blob_url must be an https Vercel Blob address");
  }
  const channel = b.channel === "test" ? "test" : b.channel === "stable" ? "stable" : null;
  if (!channel) return installError("BAD_BUNDLE", "channel must be 'stable' or 'test'");

  // MIGRATION 0102. Absent is 'macos', so the Mac publisher's POST is unchanged. Present-but-unknown is
  // refused, not rounded to macos: a Linux tarball registered as a Mac release is the one mistake this
  // column exists to make impossible.
  //
  // A 'linux' row is the LAST step of 0102's order: only after the platform filter is deployed and the Mac
  // rooms have been verified on production to still resolve to their stable release.
  const platform = b.platform === undefined ? "macos" : b.platform === "macos" || b.platform === "linux" ? b.platform : null;
  if (!platform) return installError("BAD_BUNDLE", "platform must be 'macos' or 'linux'");

  const manifest = parseManifest(b.manifest);
  if (!manifest) {
    return installError(
      "BAD_BUNDLE",
      "manifest must be the packaging script's release.json: { version, build_sha, sha256, size_bytes }",
    );
  }

  try {
    const release = await createRelease({
      blobUrl: b.blob_url,
      channel,
      platform,
      manifest,
      publishedBy: guard.adminId,
    });
    return NextResponse.json({ release }, { status: 201, ...NO_STORE });
  } catch (e) {
    return installErrorFrom(e);
  }
}
