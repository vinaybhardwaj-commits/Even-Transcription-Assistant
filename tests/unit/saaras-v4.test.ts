import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { REB_STT_ENGINE_PREFERENCE, SARVAM_TRACK_ENGINES } from "@/lib/room-access/readers/reb-consult";
import { SARVAM_STT_ENGINES_READ, SARVAM_STT_ENGINE_LABEL, SARVAM_STT_MODEL, SARVAM_STT_VERSION_LABEL, resolveSarvamSttModel } from "@/lib/sarvam-model";
import { SARVAM_GW_STT_MODEL } from "@/lib/sarvam-gw";

describe("saaras:v4 writers", () => {
  it("names v4 and the v4 labels", () => {
    expect(SARVAM_STT_MODEL).toBe("saaras:v4");
    expect(SARVAM_GW_STT_MODEL).toBe("saaras:v4");
    expect(SARVAM_STT_ENGINE_LABEL).toBe("sarvam-saaras-v4");
    expect(SARVAM_STT_VERSION_LABEL).toBe("saaras-v4");
  });

  it("refuses a v3 env override: treated as unset, one count-only log line", () => {
    for (const v of ["saaras:v3", "SAARAS:V3", " saaras:v3 ", "saaras-v3", "saaras_v3"]) {
      const log = vi.fn();
      expect(resolveSarvamSttModel(v, log)).toBe("saaras:v4");
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]![0])).toMatch(/count=1/);
      expect(String(log.mock.calls[0]![0])).not.toContain(v.trim());
    }
    const log = vi.fn();
    expect(resolveSarvamSttModel(undefined, log)).toBe("saaras:v4");
    expect(resolveSarvamSttModel("", log)).toBe("saaras:v4");
    expect(resolveSarvamSttModel("saaras:v4", log)).toBe("saaras:v4");
    expect(log).not.toHaveBeenCalled();
  });
});

describe("lib/sarvam.ts reads the override at load", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.restoreAllMocks(); });
  it("SARVAM_STT_MODEL=saaras:v3 sends saaras:v4", async () => {
    vi.stubEnv("SARVAM_STT_MODEL", "saaras:v3");
    vi.stubEnv("SARVAM_API_KEY", "k");
    vi.resetModules();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bodies: FormData[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init: { body: FormData }) => { bodies.push(init.body); return new Response(JSON.stringify({ transcript: "x", language_code: "en-IN" }), { status: 200 }); }));
    const { sarvamTranscribe } = await import("@/lib/sarvam");
    await sarvamTranscribe(Buffer.from("a"), "audio/webm");
    vi.unstubAllGlobals();
    expect(bodies.length).toBe(1);
    expect(bodies[0]!.get("model")).toBe("saaras:v4");
  });
});

describe("readers keep matching v3", () => {
  it("preference is v4 first, then v3, for the consult reader and the reuse check", () => {
    expect(SARVAM_STT_ENGINES_READ).toEqual(["sarvam-saaras-v4", "sarvam-saaras-v3"]);
    expect([...REB_STT_ENGINE_PREFERENCE]).toEqual(["sarvam-saaras-v4", "sarvam-saaras-v3"]);
    expect([...SARVAM_TRACK_ENGINES]).toEqual(["sarvam-saaras-v4", "sarvam-saaras-v3"]);
  });
});

describe("no code path can produce a saaras:v3 request", () => {
  const files = execFileSync("git", ["ls-files", "lib", "app", "services"], { encoding: "utf8" }).split("\n").filter((f) => /\.(ts|tsx|mjs|js)$/.test(f));
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  it("lib/, app/, services/ hold no v3 model literal in code (comments excluded); the reader engine name and the refusal pattern live in lib/sarvam-model.ts", () => {
    const bad: string[] = [];
    for (const f of files) {
      if (f === "lib/sarvam-model.ts") continue;
      const m = stripComments(readFileSync(f, "utf8")).match(/saaras[:_-]?v3/gi);
      if (m) bad.push(`${f} x${m.length}`);
    }
    expect(bad).toEqual([]);
  });
  it("lib/sarvam-model.ts keeps v3 only as the reader engine name and the refusal regex", () => {
    const src = stripComments(readFileSync("lib/sarvam-model.ts", "utf8"));
    expect(src).toMatch(/"sarvam-saaras-v3"/);
    expect(src).not.toMatch(/["']saaras:v3["']/);
  });
});
