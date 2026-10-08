/**
 * Arch #17 C1 on REAL postgres: ackCommand's late-failure amendment. A start_day acked {ok:true, deferred:true} can become failed (once), nothing else can.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));
const HAVE = dockerAvailable();
const pg = pgContainer("eta-arch17-ack");

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  pg.exec(`
    CREATE TABLE bench_command (id text PRIMARY KEY, room_id text NOT NULL, kind text NOT NULL, args jsonb, status text NOT NULL DEFAULT 'pending',
      source text, result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), acked_at timestamptz);
    INSERT INTO bench_command (id, room_id, kind) VALUES
      ('c_start', 'room_a', 'start_day'), ('c_plain', 'room_a', 'start_day'), ('c_upd', 'room_a', 'check_update_now'), ('c_other', 'room_b', 'start_day');
  `);
  H.sql = pg.sql as never;
}, 120_000);
afterAll(() => { if (HAVE) pg.stop(); });

const row = async (id: string) => (await pg.sql`SELECT status, error, result FROM bench_command WHERE id = ${id}`)[0] as { status: string; error: string | null; result: Record<string, unknown> };

describe("REQUIRED PROOF ran, or was skipped deliberately", () => {
  it("needs Docker", () => {
    if (HAVE || process.env.ETA_ALLOW_SKIP_E2E === "1") return;
    throw new Error("REQUIRED PROOF NOT RUN: needs Docker for postgres:16, or set ETA_ALLOW_SKIP_E2E=1.");
  });
});

describe.runIf(HAVE)("ackCommand — a deferred start's late failure", () => {
  it("a start acked as deferred is acked with result.deferred=true and no session; a late failed ack turns it into failed with the app's reason, exactly once", async () => {
    const { ackCommand } = await import("@/lib/bench-commands");
    expect(await ackCommand({ roomId: "room_a", commandId: "c_start", ok: true, sessionId: null, error: null, applied: { deferred: true } })).toBe("acked");
    expect(await row("c_start")).toMatchObject({ status: "acked", result: { ok: true, deferred: true } });
    expect((await row("c_start")).result.session_id).toBeUndefined();
    expect(await ackCommand({ roomId: "room_a", commandId: "c_start", ok: false, sessionId: null, error: "input_device_not_ready" })).toBe("failed");
    expect(await row("c_start")).toMatchObject({ status: "failed", error: "input_device_not_ready" });
    // already failed: a retry of the late ack is a no-op, not a rewrite
    expect(await ackCommand({ roomId: "room_a", commandId: "c_start", ok: false, sessionId: null, error: "something else" })).toBeNull();
    expect((await row("c_start")).error).toBe("input_device_not_ready");
  });
  it("a plainly acked start (no deferral) can NOT be amended into a failure", async () => {
    const { ackCommand } = await import("@/lib/bench-commands");
    expect(await ackCommand({ roomId: "room_a", commandId: "c_plain", ok: true, sessionId: "bs_x", error: null })).toBe("acked");
    expect(await ackCommand({ roomId: "room_a", commandId: "c_plain", ok: false, sessionId: null, error: "x" })).toBeNull();
    expect((await row("c_plain")).status).toBe("acked");
  });
  it("only start_day: a deferred check_update_now (different meaning of the flag) is untouchable", async () => {
    const { ackCommand } = await import("@/lib/bench-commands");
    expect(await ackCommand({ roomId: "room_a", commandId: "c_upd", ok: true, sessionId: null, error: null, applied: { deferred: true } })).toBe("acked");
    expect(await ackCommand({ roomId: "room_a", commandId: "c_upd", ok: false, sessionId: null, error: "x" })).toBeNull();
    expect((await row("c_upd")).status).toBe("acked");
  });
  it("only the command's own room", async () => {
    const { ackCommand } = await import("@/lib/bench-commands");
    expect(await ackCommand({ roomId: "room_b", commandId: "c_other", ok: true, sessionId: null, error: null, applied: { deferred: true } })).toBe("acked");
    expect(await ackCommand({ roomId: "room_a", commandId: "c_other", ok: false, sessionId: null, error: "x" })).toBeNull();
    expect((await row("c_other")).status).toBe("acked");
  });
  it("a late SUCCESS ack never rewrites anything (only a failure amends)", async () => {
    const { ackCommand } = await import("@/lib/bench-commands");
    expect(await ackCommand({ roomId: "room_b", commandId: "c_other", ok: true, sessionId: "bs_y", error: null })).toBeNull();
  });
});
