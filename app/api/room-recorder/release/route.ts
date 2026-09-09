/**
 * GET /api/room-recorder/release — what version should this Mac be running? (PRD §13.4, R3.)
 *
 * ─── THE ONE MISSING PIECE ───────────────────────────────────────────────────────────────
 * Everything else self-update needs was already live before Build R3: `app_release`, the publish
 * route with its server-side sha256 recompute, the withdraw route, `latestRelease()`, the fleet
 * card's release header, and every room reporting `app_version` and `build_sha` on every poll.
 * What no room could do was ASK. This route is that question, and it is the whole of R3's server
 * side — R3 is deliberately a route the app fetches and NOT a fifth command-bus kind, because
 * `BenchCommandKind` is decoded as `[BenchCommand].self` and an unknown `kind` throws for the
 * entire poll response, which would break every 0.1.7 room's polling rather than being ignored.
 *
 * ─── ROOM COOKIE, NOT ADMIN, AND NOT NOTHING ─────────────────────────────────────────────
 * The caller is the resident app on a clinic Mac, holding the 365-day room session JWT that
 * `enrol` put in its keychain. So this route authenticates exactly like the command poll it sits
 * beside — `readRoomClaims`, 401 on absence — and not like `bootstrap`/`enrol`, which are
 * unauthenticated because they run on a machine that has never seen this system. An admin cookie
 * alone does not open this door; `readRoomClaims` reads the room cookie and nothing else.
 *
 * ─── 404 NO_RELEASE, AND WHY IT IS A 404 HERE AND A 409 ON BOOTSTRAP ─────────────────────
 * `NO_RELEASE` already lives in the `InstallError` taxonomy with a default status of 409, which is
 * right for the bootstrap mint: "you asked me to build an install command and there is nothing to
 * install" is a conflict with the state of the world. Here it is a GET of a resource that is not
 * there, which is a 404 — the same split `TOKEN_INVALID` already carries (404 on the bootstrap
 * fetch, 400 on the enrol exchange) and the reason `installError` takes a status override at all.
 * §13.4 names 404 explicitly.
 *
 * WHAT THE APP DOES WITH ANYTHING BUT 200 IS NOTHING (R3-9). A 404, a 401, a timeout and a network
 * failure all mean "log it, change nothing on disk, check again next tick". `latestRelease` returns
 * null whenever every release on a channel is withdrawn, so this route answers 404 in a REAL
 * situation and not only a broken one — a withdraw with nothing behind it. A missing release is
 * never a reason to remove software from a room.
 *
 * THE CHANNEL IS VALIDATED HERE, NOT COERCED. `latestRelease` types its parameter as
 * `"stable" | "test"`, and TypeScript stops at the compiler. An unknown channel is rejected rather
 * than silently defaulted to stable, because a Mac asking for a channel this server does not know
 * is a Mac whose config this server should not answer for.
 */
import { NextRequest, NextResponse } from "next/server";
import { readRoomClaims } from "@/lib/room-auth";
import { installError, installErrorFrom, latestRelease } from "@/lib/room-install";
import { respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "cache-control": "no-store" } };

const CHANNELS = ["stable", "test"] as const;
type Channel = (typeof CHANNELS)[number];

const isChannel = (v: string): v is Channel => (CHANNELS as readonly string[]).includes(v);

export async function GET(req: NextRequest) {
  const claims = await readRoomClaims();
  if (!claims) return respondError("AUTH_REQUIRED", "Room sign-in required");

  // Absent means stable, which is the default in `config.json` and the channel every install
  // predating R3 is on. Present-but-unknown is refused, not rounded down.
  const raw = (req.nextUrl.searchParams.get("channel") ?? "stable").trim();
  if (!isChannel(raw)) {
    // VALIDATION_FAILED, from the app-wide taxonomy, not one of this module's install codes: a
    // malformed query string is the same fault here as it is on every other route, and the
    // `InstallError` codes describe states of the install world rather than bad input.
    return respondError("VALIDATION_FAILED", "channel must be stable or test");
  }

  try {
    const release = await latestRelease(raw);
    if (!release) {
      return installError("NO_RELEASE", "no release published on this channel", 404);
    }
    // FOUR FIELDS, and the omissions are the point. `blob_url` is what to fetch, `sha256` and
    // `size_bytes` are what it must weigh and hash, `version` is what it will become. The app
    // pins its expected SIGNER as a compile-time constant (R3-5) and never takes it from here,
    // so a wrong or compromised publish cannot point a Mac at a different certificate.
    return NextResponse.json(
      {
        version: release.version,
        sha256: release.sha256,
        size_bytes: release.size_bytes,
        blob_url: release.blob_url,
      },
      NO_STORE,
    );
  } catch (e) {
    return installErrorFrom(e);
  }
}
