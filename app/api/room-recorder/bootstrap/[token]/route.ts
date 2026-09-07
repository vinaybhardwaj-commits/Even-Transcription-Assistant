/**
 * GET /api/room-recorder/bootstrap/{token} — the script the paste runs (PRD §4.2, §4.4, D9).
 *
 * UNAUTHENTICATED, AND THE TOKEN IS THE CREDENTIAL. There is nothing else on a clinic Mac to
 * authenticate with: the operator pastes one line into a Terminal on a machine that has never
 * heard of this system, and the whole install proceeds from what comes back.
 *
 * IT DOES NOT CONSUME THE TOKEN. The script needs the same token a few seconds later, for the
 * `enrol` verb it runs at line 30, so `used_at` stays NULL here. Only the enrol exchange spends
 * it. That also makes the fetch safely repeatable: a dropped connection is re-run by pasting
 * again, not by minting a second token.
 *
 * `text/x-shellscript`, with `X-Content-Type-Options: nosniff` and no caching. This body is piped
 * straight into bash on a machine in a consulting room; there is no version of it that should
 * come from a cache, and the release it names is read at FETCH time so a withdraw between the
 * copy and the paste is honoured.
 *
 * UNKNOWN, EXPIRED AND USED TOKENS ARE ONE ANSWER: TOKEN_INVALID. The three are not distinguished
 * because an unauthenticated endpoint that could confirm a token had existed would be telling a
 * caller something no honest client needs to know.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  BOOTSTRAP_RATE_LIMIT,
  bootstrapScriptFor,
  clientKey,
  installError,
  installErrorFrom,
  rateLimited,
} from "@/lib/room-install";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  if (rateLimited(`bootstrap:${clientKey(req)}`, BOOTSTRAP_RATE_LIMIT)) {
    return installError("BOOTSTRAP_RATE_LIMITED", "too many bootstrap requests, try again shortly");
  }

  const { token } = await ctx.params;
  // Shape check before the query: the token alphabet is the server's own (hex), so anything else
  // is not a token this system ever minted and does not need a database round trip to refuse.
  if (!/^[0-9a-f]{16,128}$/.test(token ?? "")) {
    return installError("TOKEN_INVALID", "token is unknown, expired or already used", 404);
  }

  try {
    const script = await bootstrapScriptFor(token);
    if (!script) {
      return installError("TOKEN_INVALID", "token is unknown, expired or already used", 404);
    }
    return new NextResponse(script, {
      status: 200,
      headers: {
        "content-type": "text/x-shellscript; charset=utf-8",
        "cache-control": "no-store, max-age=0",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    return installErrorFrom(e);
  }
}
