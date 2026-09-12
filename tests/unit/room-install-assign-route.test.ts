/**
 * B2-D5 — POST /api/admin/installs/{installId}/assign-channel, the fleet card's "Move to stable".
 *
 * ─── THE PROPERTIES ARE NEGATIVE, LIKE THE RELEASE ROUTE'S ────────────────────────────────────
 * This route lets a desk change which builds a clinic Mac takes. So what it refuses matters most:
 *   · no admin cookie and no migration secret → 401, and the database is never touched
 *   · an empty body, a malformed body → 400 BAD_CHANNEL, and the database is never touched
 *   · an unknown or retired install → 404, as the retire route answers
 *   · the only values it can ever write are `stable` and — since Tier 1 §3 (D1 amended) — `test`;
 *     the test-channel cases are in room-install-assign-test-channel.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
// No admin cookie in any test here: the migration secret is the only way in, and its absence is 401.
vi.mock("@/lib/cookie", () => ({ readAdminCookie: async () => null }));

process.env.MIGRATION_SECRET = "test-secret";
const { POST } = await import("@/app/api/admin/installs/[installId]/assign-channel/route");

const post = async (body: unknown, opts: { auth?: boolean; id?: string; raw?: string } = {}) => {
  const req = new Request("https://www.evenscribe.app/api/admin/installs/x/assign-channel", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.auth === false ? {} : { authorization: "Bearer test-secret" }),
    },
    body: opts.raw ?? JSON.stringify(body),
  });
  const res = await POST(req as never, { params: Promise.resolve({ installId: opts.id ?? "install_d3sy3ufas8jv" }) });
  return { status: res.status, json: (await res.json()) as Record<string, never> };
};

beforeEach(() => {
  calls.length = 0;
  responses = [];
});

describe("assign-channel (B2-D5)", () => {
  it("writes stable on a live install and answers with it", async () => {
    // Tier 2 §2.1/§2.2: a pre-read (floor + audit `from`), then the UPDATE, then the audit row.
    responses = [[{ install_id: "install_d3sy3ufas8jv", room_id: "room_1", app_version: "0.1.22", assigned_channel: null }], [{ install_id: "install_d3sy3ufas8jv", assigned_channel: "stable" }], []];
    const { status, json } = await post({ channel: "stable" });
    expect(status).toBe(200);
    expect(json).toEqual({ install_id: "install_d3sy3ufas8jv", assigned_channel: "stable" });
    const up = calls.find((c) => /UPDATE room_install SET assigned_channel/.test(c.text))!;
    expect(up.text).toMatch(/UPDATE room_install SET assigned_channel = \? WHERE install_id = \? AND retired_at IS NULL/);
    expect(up.values).toEqual(["stable", "install_d3sy3ufas8jv"]);
  });

  it("Tier 1 §3: accepts test as well — B2's refusal of test is superseded by D1 (amended)", async () => {
    responses = [[{ install_id: "install_d3sy3ufas8jv", room_id: "room_1", app_version: "0.1.22", assigned_channel: null }], [{ install_id: "install_d3sy3ufas8jv", assigned_channel: "test" }], []];
    const { status, json } = await post({ channel: "test" });
    expect(status).toBe(200);
    expect(json).toEqual({ install_id: "install_d3sy3ufas8jv", assigned_channel: "test" });
    const up = calls.find((c) => /UPDATE room_install SET assigned_channel/.test(c.text))!;
    expect(up.values).toEqual(["test", "install_d3sy3ufas8jv"]);
  });

  it("refuses every other body with 400, without touching the database", async () => {
    for (const body of [{}, { channel: "STABLE" }, { channel: "" }, { channel: null }, { channel: ["stable"] }, "stable"]) {
      const { status } = await post(body);
      expect(status).toBe(400);
    }
    expect((await post(null, { raw: "{not json" })).status).toBe(400);
    expect((await post(null, { raw: "" })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("answers 404 for an unknown or retired install, as the retire route does", async () => {
    responses = [[]];
    const { status, json } = await post({ channel: "stable" }, { id: "install_retired00001" });
    expect(status).toBe(404);
    expect((json as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    // The retired case is the WHERE clause: `retired_at IS NULL` matches nothing, so no row returns.
    expect(calls[0]!.text).toContain("AND retired_at IS NULL");
  });

  it("answers 401 without the admin guard, and never reaches the database", async () => {
    const { status } = await post({ channel: "stable" }, { auth: false });
    expect(status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("answers a store fault as STORE_UNAVAILABLE, never a 500", async () => {
    responses = [new Error("connect ECONNREFUSED")];
    const { status } = await post({ channel: "stable" });
    expect(status).toBe(503);
  });
});
