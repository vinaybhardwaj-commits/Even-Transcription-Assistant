/**
 * tests/unit/join-clip-seam.test.ts — the REAL joinClipForWindow.
 *
 * `join-only.test.ts` mocks `@/lib/stt/room-drain` and supplies its own `joinClipForWindow`, so the
 * function this branch extracted — the one that now carries production's phase 1, with the UPDATE,
 * the try/catch and the R2 compensation — was never executed by any test. Three mutations lived
 * there: returning ok:true after a failed UPDATE, dropping the compensation delete, and the
 * listing's ORDER BY.
 *
 * Nothing here is mocked except the three collaborators the function talks to. Ids only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({
  statements: [] as string[],
  updateThrows: false,
  deletes: [] as string[],
  deleteThrows: false,
  joinResult: { ok: true, key: "clips/sess_1/w1.webm", bytes: 10, duration_ms: 900_000 } as
    | { ok: true; key: string; bytes: number; duration_ms: number }
    | { ok: false; error: string; hop?: string },
  joinRequests: [] as unknown[],
}));

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    H.statements.push(text);
    if (/UPDATE bench_window/i.test(text) && H.updateThrows) {
      return Promise.reject(new Error("neon: write failed"));
    }
    return Promise.resolve([]);
  },
}));
vi.mock("@/lib/r2", () => ({
  deleteObject: async (key: string) => {
    if (H.deleteThrows) throw new Error("r2 delete failed");
    H.deletes.push(key);
  },
  getObjectBytes: async () => new Uint8Array([1]),
}));
vi.mock("@/lib/bench-join", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    joinServiceConfigured: () => true,
    callJoinService: async (req: unknown) => { H.joinRequests.push(req); return H.joinResult; },
  };
});

const COVERING = [{ chunk: { idx: 1, r2_key: "chunks/1.webm" }, offset_in_chunk_s: 0, duration_s: 900 }];
const args = () => ({
  windowId: "w1", sessionId: "sess_1", covering: COVERING,
  startMs: 0, endMs: 900_000, source: "primary" as const,
});

async function join() {
  const { joinClipForWindow } = await import("@/lib/stt/room-drain");
  return joinClipForWindow(args() as Parameters<typeof joinClipForWindow>[0]);
}

beforeEach(() => {
  H.statements.length = 0; H.deletes.length = 0; H.joinRequests.length = 0;
  H.updateThrows = false; H.deleteThrows = false;
  H.joinResult = { ok: true, key: "clips/sess_1/w1.webm", bytes: 10, duration_ms: 900_000 };
  vi.resetModules();
});

describe("the happy path writes the key it was given", () => {
  it("calls the service once and records the key on the window", async () => {
    const r = await join();
    expect(r).toEqual({ ok: true, key: "clips/sess_1/w1.webm" });
    expect(H.joinRequests.length).toBe(1);
    expect(H.statements.some((s) => /UPDATE bench_window SET clip_r2_key/i.test(s))).toBe(true);
    expect(H.deletes).toEqual([]);   // nothing to compensate
  });

  it("a service refusal writes nothing and carries the hop", async () => {
    H.joinResult = { ok: false, error: "join_unreachable", hop: "worker_to_do" };
    const r = await join();
    expect(r).toMatchObject({ ok: false, error: "join_unreachable", hop: "worker_to_do" });
    expect(H.statements.some((s) => /UPDATE bench_window/i.test(s))).toBe(false);
    expect(H.deletes).toEqual([]);   // the service produced no object to orphan
  });
});

describe("A FAILED UPDATE IS NOT A SUCCESS, and it does not leave bytes behind", () => {
  it("returns NOT ok when the clip-key write fails", async () => {
    H.updateThrows = true;
    const r = await join();
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/clip_key_write_failed/);
  });

  it("DELETES the object the service just made — the row that would reference it does not exist", async () => {
    H.updateThrows = true;
    await join();
    expect(H.deletes).toEqual(["clips/sess_1/w1.webm"]);
  });

  it("still returns not-ok when the compensating delete ALSO fails", async () => {
    H.updateThrows = true;
    H.deleteThrows = true;
    const r = await join();
    expect(r.ok).toBe(false);   // a failed cleanup must not turn a failed write into a success
    expect((r as { error: string }).error).toMatch(/clip_key_write_failed/);
  });
});

describe("the listing's order is part of its contract", () => {
  it("is OLDEST FIRST — an operator asking for a handful gets the backlog, not the newest", async () => {
    const { listCliplessWindows } = await import("@/lib/stt/join-only");
    await listCliplessWindows({ limit: 5 });
    const q = H.statements.find((s) => /FROM bench_window/i.test(s) && /clip_r2_key IS NULL/i.test(s))!;
    expect(q).toMatch(/ORDER BY\s+w\.start_ms\s+ASC/i);
    expect(q).not.toMatch(/ORDER BY\s+w\.start_ms\s+DESC/i);
  });
});
