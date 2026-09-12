/**
 * C2 Part A — the async transport lives behind SttAdapter, and nothing reaches past it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const R = vi.hoisted(() => ({ on: true, sub: {} as Record<string, unknown>, poll: {} as Record<string, unknown>, urls: [] as string[] }));
vi.mock("@/lib/stt/eta-router", () => ({
  ROUTER_JOB_ON: () => R.on,
  submitRouteJob: async (u: string) => { R.urls.push(u); return R.sub; },
  pollRouteJob: async () => R.poll,
  routeTranscribe: async () => ({ ok: true }),
}));

beforeEach(() => { R.on = true; R.urls = []; R.sub = { ok: true, job_id: "rj_1" }; R.poll = { ok: true, state: "running" }; });

describe("the interface, not the client", () => {
  it("an adapter that declares async implements submit/poll — both or neither", async () => {
    const { ADAPTERS } = await import("@/lib/stt/registry");
    // NO EXCEPTION LIST. ekascribe used to be one: it declared async:true and implemented neither,
    // which made this invariant unenforceable by the only means that matters — being true. Its
    // DECLARATION was corrected (it is a synchronous shim), so the rule now stands unqualified.
    const violations: string[] = [];
    for (const [key, a] of Object.entries(ADAPTERS)) {
      const declares = a.capabilities.async === true;
      const implementsBoth = typeof a.submit === "function" && typeof a.poll === "function";
      if (declares && !implementsBoth) violations.push(key);
      if (!declares) expect(typeof a.submit, `${key} must not implement submit without declaring async`).toBe("undefined");
    }
    expect(violations, "an engine that says it is async must be able to be").toEqual([]);
    expect(ADAPTERS.route!.capabilities.async).toBe(true);
    expect(typeof ADAPTERS.route!.submit).toBe("function");
    expect(ADAPTERS.ekascribe!.capabilities.async, "corrected in C2 D2").toBe(false);
  });

  it("a declared-but-unimplemented async engine is REFUSED, never silently run synchronously", async () => {
    // A 900 s window on the synchronous path is the timeout this whole seam exists to avoid.
    const drain = readFileSync("lib/stt/room-drain.ts", "utf8");
    expect(drain).toContain("async_engine_missing_submit_poll");
    expect(drain).toMatch(/typeof adapter\.submit !== "function" \|\| typeof adapter\.poll !== "function"/);
  });

  it("submit takes a URL — the router fetches its own audio, it is never uploaded twice", async () => {
    const { routeAdapter } = await import("@/lib/stt/adapters/route");
    const out = await routeAdapter.submit!({ audioUrl: "https://r2.example/clip.webm", durationMs: 900_000 });
    expect(out).toEqual({ ok: true, jobRef: "rj_1" });
    expect(R.urls).toEqual(["https://r2.example/clip.webm"]);
    const noUrl = await routeAdapter.submit!({ durationMs: 1000 });
    expect(noUrl.ok, "bytes are not a substitute for a URL on this transport").toBe(false);
  });

  it("the kill-switch is honoured through the interface", async () => {
    const { routeAdapter } = await import("@/lib/stt/adapters/route");
    R.on = false;
    const out = await routeAdapter.submit!({ audioUrl: "https://r2.example/c.webm" });
    expect(out).toEqual({ ok: false, error: "router_job_disabled" });
    expect(R.urls, "disabled means no call at all").toHaveLength(0);
  });

  it("poll maps the provider's vocabulary onto OURS, and says what is terminal", async () => {
    const { routeAdapter } = await import("@/lib/stt/adapters/route");
    R.poll = { ok: true, state: "queued", progress: { done: 0, total: 3 } };
    expect(await routeAdapter.poll!("rj_1")).toMatchObject({ ok: true, state: "queued", progress: { done: 0, total: 3 } });

    R.poll = { ok: false, error: "unknown job_id" };
    expect(await routeAdapter.poll!("gone"), "an expired ref can never start working").toMatchObject({ ok: false, terminal: true });

    R.poll = { ok: false, error: "fetch failed" };
    expect(await routeAdapter.poll!("rj_1"), "a transport blip is worth another claim").toMatchObject({ ok: false, terminal: false });

    R.poll = { ok: true, state: "done", transcript_native: "words", dominant_language: "kn",
               language_timeline: [{ start_s: 0, end_s: 5, lang: "kn", engine: "indicconformer", chars: 5 }], sec: 40 };
    const done = await routeAdapter.poll!("rj_1");
    expect(done).toMatchObject({ ok: true, state: "done" });
    // It comes back as an SttTranscribeResult, so a caller needs no router vocabulary at all.
    const r = (done as { result: { original: string | null; languageTimeline: unknown[] | null } }).result;
    expect(r.original).toBe("words");
    expect(r.languageTimeline).toHaveLength(1);
  });
});

describe("D8 — the kill switch stays legible on the row", () => {
  it("a disabled router records router_job_disabled, not a generic submit failure", () => {
    const drain = readFileSync("lib/stt/room-drain.ts", "utf8");
    // "we turned it off" and "it broke" must not share a code: one is a decision, the other a fault.
    expect(drain).toMatch(/sub\.error === "router_job_disabled" \? "router_job_disabled" : "async_submit_failed"/);
  });
});

describe("STRUCTURAL PROOF — no job kind reaches past the registry", () => {
  const srcOf = (f: string) => readFileSync(f, "utf8");

  it("no file under lib/jobs/ imports the router client", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) { walk(full); continue; }
        if (!e.name.endsWith(".ts")) continue;
        if (/submitRouteJob|pollRouteJob|from "@\/lib\/stt\/eta-router"/.test(srcOf(full))) offenders.push(full);
      }
    };
    walk("lib/jobs");
    expect(offenders, "a job kind that knows which service it wants is one the registry cannot govern").toEqual([]);
  });

  it("the drain's phases do not either — they go through adapterFor", () => {
    const drain = srcOf("lib/stt/room-drain.ts");
    expect(drain).not.toMatch(/submitRouteJob|pollRouteJob/);
    expect(drain, "submit is reached through the adapter the registry returned").toContain("adapter.submit(");
    expect(drain).toContain("adapter.poll(");
  });

  it("the ONLY places that may speak to the router client are the client and the adapter", () => {
    // The legacy encounter path is excluded deliberately and named: it predates the registry and
    // is C3's problem, not this slice's.
    const allowed = new Set(["lib/stt/eta-router.ts", "lib/stt/adapters/route.ts", "app/[slug]/api/encounters/[id]/process/route.ts"]);
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        if (/submitRouteJob|pollRouteJob/.test(srcOf(full))) found.push(full);
      }
    };
    walk("lib"); walk("app");
    expect(found.filter((f) => !allowed.has(f))).toEqual([]);
  });
});
