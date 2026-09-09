/**
 * Build R3 §13.4 — GET /api/room-recorder/release, the one thing self-update needed from the server.
 *
 * ─── THE PROPERTIES HERE ARE MOSTLY NEGATIVE, AND THAT IS THE POINT ──────────────────────────
 * This route decides whether a clinic Mac replaces the software it is recording with. So what it
 * must NOT do matters more than what it returns:
 *
 *   · a channel with nothing published answers 404 NO_RELEASE, never a 200 with a stale row
 *   · a withdrawn newest release falls through to the one before it — that IS the rollback
 *   · a channel this server does not know is refused, not rounded down to `stable`
 *   · an admin cookie alone opens nothing; the room's own session is the credential
 *   · the 200 carries no signer — R3-5 pins the certificate in the app, at compile time
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const calls: Array<{ text: string; values: unknown[] }> = [];
let responses: unknown[] = [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
    const next = responses.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});

// The room cookie is the credential. `roomClaims = null` is "no room cookie", which is exactly the
// state a browser holding only an ADMIN cookie is in — see the auth test below.
let roomClaims: { room_id: string } | null = { room_id: "room_1" };
vi.mock("@/lib/room-auth", () => ({ readRoomClaims: async () => roomClaims }));

const { GET } = await import("@/app/api/room-recorder/release/route");

const release = (over: Record<string, unknown> = {}) => ({
  id: "rel_1",
  version: "0.1.8",
  build_sha: "abc1234",
  sha256: "a".repeat(64),
  size_bytes: 94_371_840,
  blob_url: "https://x.public.blob.vercel-storage.com/EvenScribe-0.1.8.zip",
  channel: "stable",
  published_at: "2026-09-09T10:20:00.000Z",
  published_by: "vinay",
  withdrawn_at: null,
  notes: null,
  min_macos: "15.0",
  ...over,
});

const get = async (query = "") => {
  const req = {
    nextUrl: new URL(`https://www.evenscribe.app/api/room-recorder/release${query}`),
  } as unknown as Parameters<typeof GET>[0];
  const res = await GET(req);
  return { status: res.status, json: (await res.json()) as Record<string, never> };
};

beforeEach(() => {
  calls.length = 0;
  responses = [];
  roomClaims = { room_id: "room_1" };
});

describe("the release route (§13.4)", () => {
  it("answers 404 NO_RELEASE when nothing is published, NOT a 200", async () => {
    // `latestRelease` returning no row is a REAL situation and not only a broken one: it is what
    // withdrawing the last release on a channel produces. R3-9 makes the app do nothing with it.
    responses = [[]];
    const { status, json } = await get("?channel=stable");
    expect(status).toBe(404);
    expect((json as { error: { code: string } }).error.code).toBe("NO_RELEASE");
  });

  it("falls through to the previous non-withdrawn release — this is the rollback", async () => {
    // The route does not filter; `latestRelease` does, in SQL. The property under test is that the
    // route returns whatever that query answered, including a LOWER version than the app is on.
    responses = [[release({ version: "0.1.7" })]];
    const { status, json } = await get("?channel=stable");
    expect(status).toBe(200);
    expect(json).toMatchObject({ version: "0.1.7" });
    // The withdraw is expressed in the query, so the query is what is pinned.
    expect(calls[0].text).toContain("withdrawn_at IS NULL");
    expect(calls[0].text).toContain("ORDER BY published_at DESC");
    expect(calls[0].values).toContain("stable");
  });

  it("accepts only stable and test, and rounds nothing down", async () => {
    // `STABLE` is in this list on purpose. Case is NOT folded: the column holds lower-case
    // channels and a case-insensitive match here would let a Mac ask for a channel whose name it
    // has subtly wrong and be served the other one's builds.
    for (const bad of ["beta", "STABLE", "'; drop", "stable,test"]) {
      responses = [[release()]];
      const { status, json } = await get(`?channel=${encodeURIComponent(bad)}`);
      expect(status).toBe(400);
      expect((json as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
      // NOTHING WAS ASKED OF THE DATABASE. A rejected channel must not reach a query.
      expect(calls).toHaveLength(0);
      calls.length = 0;
    }
  });

  it("trims surrounding whitespace before matching, and only that", async () => {
    // Deliberate and narrow. A stray space around a query value is a client quirk, not a different
    // channel; anything else about the string still has to be exactly right.
    responses = [[release()]];
    const padded = await get("?channel=%20stable%20");
    expect(padded.status).toBe(200);
    expect(calls[0].values).toContain("stable");
  });

  it("takes stable when no channel is given at all", async () => {
    responses = [[release()]];
    const { status } = await get();
    expect(status).toBe(200);
    expect(calls[0].values).toContain("stable");
  });

  it("serves the test channel to a Mac that asks for it (R3-8)", async () => {
    responses = [[release({ channel: "test", version: "0.1.9-test" })]];
    const { status, json } = await get("?channel=test");
    expect(status).toBe(200);
    expect(json).toMatchObject({ version: "0.1.9-test" });
    expect(calls[0].values).toContain("test");
  });

  it("an admin cookie alone does not authorize; the room cookie does", async () => {
    // `readRoomClaims` reads the ROOM cookie and nothing else, so a browser session holding only
    // an admin cookie presents as null here. The self-update door is not an admin door.
    roomClaims = null;
    const denied = await get("?channel=stable");
    expect(denied.status).toBe(401);
    expect(calls).toHaveLength(0);

    roomClaims = { room_id: "room_1" };
    responses = [[release()]];
    const allowed = await get("?channel=stable");
    expect(allowed.status).toBe(200);
  });

  it("returns the four contract fields and NO signer (R3-5)", async () => {
    responses = [[release()]];
    const { json } = await get("?channel=stable");
    expect(Object.keys(json).sort()).toEqual(["blob_url", "sha256", "size_bytes", "version"]);
    // The app pins the certificate at compile time. If the server could name a signer, a wrong or
    // compromised publish could point a clinic Mac at a different one.
    expect(JSON.stringify(json)).not.toMatch(/187dd424|identity|certificate|signer/i);
  });

  it("a database fault is a named error, never a 500", async () => {
    responses = [Object.assign(new Error("relation \"app_release\" does not exist"), { code: "42P01" })];
    const { status, json } = await get("?channel=stable");
    expect(status).toBe(503);
    expect((json as { error: { code: string } }).error.code).toBe("STORE_UNAVAILABLE");
  });

  it("is nodejs, dynamic, and never cached", async () => {
    // A cached answer would be a room asking a six-hourly question and being told last time's
    // answer — including after a withdraw, which is precisely when it changed.
    const src = readFileSync("app/api/room-recorder/release/route.ts", "utf8");
    expect(src).toContain('export const runtime = "nodejs"');
    expect(src).toContain('export const dynamic = "force-dynamic"');
    expect(src).toContain("no-store");
  });
});
