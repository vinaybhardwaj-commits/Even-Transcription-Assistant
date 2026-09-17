/**
 * Migration 0102 and the platform filter: a Mac is only ever offered a Mac release.
 *
 * THE HAZARD THIS FILE GUARDS. One query — `latestRelease` — answers the Mac self-update route, the install
 * mint and the bootstrap script. Unfiltered, a Linux row would be "the latest stable" for every Mac. So:
 *   · the query names the platform in SQL, and every Mac-facing caller passes 'macos';
 *   · this change gives nothing a way to WRITE a Linux row (createRelease inserts the literal 'macos');
 *   · a Linux fleet row is measured against a Linux shelf, and a Mac row reads exactly what it did;
 *   · the migration writes no Linux row and says, in its own header, why the order is load-bearing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFakeOperator } from "../support/fake-identity";

const FAKE_OPERATOR = makeFakeOperator(1);

const calls: Array<{ text: string; values: unknown[] }> = [];
let responses: unknown[] = [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
    const next = responses.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
  };
  (sql as unknown as { transaction: unknown }).transaction = async (qs: unknown[]) => qs.map(() => []);
  return { sql, db: {} };
});
vi.mock("@/lib/cookie", () => ({ readAdminCookie: async () => null }));
vi.mock("@/lib/auth", () => ({ verifyAdminJwt: async () => null }));

const M = await import("@/lib/room-install");
const V = await import("@/lib/room-install-view");

beforeEach(() => {
  calls.length = 0;
  responses = [];
});

const releaseRow = (over: Record<string, unknown> = {}) => ({
  id: "rel_mac",
  version: "0.1.21",
  build_sha: "abc1234",
  sha256: "c".repeat(64),
  size_bytes: 1024,
  blob_url: "https://x.public.blob.vercel-storage.com/rr-0.1.21.zip",
  channel: "stable",
  published_at: "2026-09-10T00:00:00.000Z",
  published_by: FAKE_OPERATOR.name,
  withdrawn_at: null,
  notes: null,
  min_macos: "15.0",
  platform: "macos",
  ...over,
});

describe("latestRelease filters by platform in SQL", () => {
  it("names the platform in the WHERE clause and passes it as a value", async () => {
    await M.latestRelease("stable", "macos");
    const q = calls.find((c) => c.text.includes("FROM app_release"))!;
    expect(q.text).toMatch(/WHERE channel = \? AND platform = \? AND withdrawn_at IS NULL/);
    expect(q.values).toEqual(["stable", "macos"]);
  });

  it("the install mint asks for the macos stable release", async () => {
    responses = [[{ id: "room_1", slug: "opd-5", name: "OPD 5" }], []];
    await expect(M.mintBootstrapToken({ roomId: "room_1", createdBy: "adm_1" })).rejects.toMatchObject({ code: "NO_RELEASE" });
    const q = calls.find((c) => c.text.includes("FROM app_release"))!;
    expect(q.values).toEqual(["stable", "macos"]);
  });

  it("the bootstrap script builds its Mac body from the macos stable release", async () => {
    responses = [[{ token: "ab".repeat(16), room_name: "OPD 5" }], [releaseRow()]];
    const script = await M.bootstrapScriptFor("ab".repeat(16));
    const q = calls.find((c) => c.text.includes("FROM app_release"))!;
    expect(q.values).toEqual(["stable", "macos"]);
    expect(script).toContain('BLOB_URL="https://x.public.blob.vercel-storage.com/rr-0.1.21.zip"');
  });

  it("the Mac self-update route asks for macos, whatever channel it is given", () => {
    const src = readFileSync(join(process.cwd(), "app/api/room-recorder/release/route.ts"), "utf8");
    expect(src).toMatch(/latestRelease\(raw, "macos"\)/);
  });

  it("no caller anywhere asks for a release without naming a platform", () => {
    for (const f of ["lib/room-install.ts", "app/api/room-recorder/release/route.ts"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      for (const m of src.matchAll(/await latestRelease\(([^)]*)\)/g)) {
        expect(m[1], `${f}: latestRelease(${m[1]})`).toMatch(/,\s*("macos"|"linux")\s*$/);
      }
    }
  });
});

describe("nothing in this change can write a Linux row", () => {
  it("createRelease inserts the literal 'macos'", async () => {
    const body = new TextEncoder().encode("bundle");
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(body).digest("hex");
    responses = [[releaseRow({ sha256: sha, size_bytes: body.byteLength })]];
    await M.createRelease({
      blobUrl: "https://x.public.blob.vercel-storage.com/rr-0.1.22.zip",
      channel: "stable",
      manifest: { version: "0.1.22", build_sha: "abc1234", sha256: sha, size_bytes: body.byteLength },
      publishedBy: FAKE_OPERATOR.name,
      fetchImpl: (async () => new Response(body)) as unknown as typeof fetch,
    });
    const insert = calls.find((c) => /INSERT INTO app_release/.test(c.text))!;
    expect(insert.text).toContain("min_macos, platform");
    expect(insert.text).toMatch(/'macos' \) RETURNING/);
    expect(insert.values).not.toContain("linux");
  });
});

describe("a fleet row is measured against its own platform's shelf", () => {
  const mac = { stable: releaseRow() as unknown as import("@/lib/room-install-view").ReleaseView, test: null };
  const linux = {
    stable: releaseRow({ id: "rel_linux", version: "0.2.0", platform: "linux" }) as unknown as import("@/lib/room-install-view").ReleaseView,
    test: null,
  };
  const row = (os_version: string | null) =>
    ({ room_id: "room_1", room_slug: "opd-5", room_name: "OPD 5", disabled: false, pending: null, last_retired: null,
       install: { os_version, update_channel: "stable" } }) as unknown as import("@/lib/room-install-view").FleetRow;

  it("a Mac row reads the Mac shelf, with or without a Linux shelf present", () => {
    expect(V.releaseForRow(row("macOS 15.7"), mac)).toBe(mac.stable);
    expect(V.releaseForRow(row("macOS 15.7"), mac, linux)).toBe(mac.stable);
    expect(V.releaseForRow(row(null), mac, linux)).toBe(mac.stable);
  });

  it("a Linux row reads the Linux shelf, and nothing when no Linux shelf exists — never the Mac release", () => {
    expect(V.releaseForRow(row("Ubuntu 26.04 LTS"), mac, linux)).toBe(linux.stable);
    expect(V.releaseForRow(row("Ubuntu 26.04 LTS"), mac)).toBeNull();
    expect(V.releaseForRow(row("Ubuntu 26.04 LTS"), mac, { stable: null, test: null })).toBeNull();
  });
});

describe("migration 0102", () => {
  const body = readFileSync(join(process.cwd(), "db", "migrations", "0102_app_release_platform.sql"), "utf8");
  const sqlOnly = body.replace(/--[^\n]*/g, "");

  it("adds platform NOT NULL DEFAULT 'macos', checked to macos|linux", () => {
    expect(sqlOnly).toContain("ALTER TABLE app_release ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'macos';");
    expect(sqlOnly).toContain("CHECK (platform IN ('macos', 'linux'))");
  });

  it("creates the (platform, version, channel) unique index BEFORE dropping the old one", () => {
    const create = sqlOnly.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS uq_app_release_platform_version_channel ON app_release (platform, version, channel)");
    const drop = sqlOnly.indexOf("DROP INDEX IF EXISTS uq_app_release_version_channel");
    expect(create).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(create);
  });

  it("writes no release row of any kind", () => {
    expect(sqlOnly).not.toMatch(/INSERT\s+INTO\s+app_release/i);
    expect(sqlOnly).not.toMatch(/UPDATE\s+app_release/i);
    expect(sqlOnly).not.toMatch(/'linux'\s*\)?\s*(,|;)/);
  });

  it("says in its own header why the order is load-bearing", () => {
    expect(body).toMatch(/THE ORDER IS LOAD-BEARING/);
    expect(body).toMatch(/ONLY THEN may a row with platform = 'linux' exist/);
  });
});
