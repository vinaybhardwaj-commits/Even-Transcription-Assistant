/**
 * tests/unit/qwen-out-guard.test.ts — qwen is out of ETA entirely (V's ruling, 22 Sep 2026).
 *
 * qwen2.5:14b is retired on the Mini. Anything ETA used it for now goes through `routedChat`
 * (Gemini when flagged+configured, OpenRouter otherwise — lib/llm/gemini.ts) or, for the STT
 * lab's judge infrastructure, the same routedChat path. Embeddings (nomic-embed-text, via
 * Ollama) are a separate concern and are explicitly allow-listed below — they never go
 * through `qwenJson`/`QWEN_MODEL` and never call qwen2.5.
 *
 * This test scans SOURCE, not behaviour, on purpose: the defect it guards against is a
 * literal reintroduced by copy-paste or a merge, which no runtime test would ever exercise
 * (nothing calls it in CI). A mutation that puts a qwen2.5 literal — or a `lib/qwen` import —
 * back into any file under lib/ or app/ must fail here.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SCAN_ROOTS = ["lib", "app"];
const SCAN_EXT = [".ts", ".tsx"];

/** Files that legitimately reach the embeddings endpoint (nomic-embed-text) via Ollama.
 *  None of these ever import `lib/qwen` or reference qwen2.5 — the allow-list exists so a
 *  future reviewer knows embeddings were considered and deliberately excluded, not missed. */
const EMBEDDINGS_ALLOWLIST = new Set(["lib/llm.ts", "lib/kb-embed.ts"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (SCAN_EXT.some((ext) => name.endsWith(ext))) out.push(p);
  }
  return out;
}

function allProductionFiles(): string[] {
  return SCAN_ROOTS.flatMap((r) => walk(r));
}

describe("qwen is out of ETA entirely — no production file may reintroduce it", () => {
  it("no file under lib/ or app/ contains the literal \"qwen2.5\"", () => {
    const hits: string[] = [];
    for (const f of allProductionFiles()) {
      const src = readFileSync(f, "utf8");
      if (src.includes("qwen2.5")) hits.push(f);
    }
    expect(hits, `qwen2.5 literal found in: ${hits.join(", ")}`).toEqual([]);
  });

  it("no file under lib/ or app/ imports lib/qwen (deleted 22 Sep — reintroducing the module or the import is the same failure)", () => {
    const hits: string[] = [];
    const pattern = /from\s+["'](?:@\/lib\/qwen|\.{1,2}\/(?:.*\/)?qwen)["']/;
    for (const f of allProductionFiles()) {
      const src = readFileSync(f, "utf8");
      if (pattern.test(src)) hits.push(f);
    }
    expect(hits, `import of lib/qwen found in: ${hits.join(", ")}`).toEqual([]);
  });

  it("no file under lib/ or app/ references qwenJson, QWEN_MODEL or QwenError — the qwen client's own identifiers", () => {
    const hits: string[] = [];
    for (const f of allProductionFiles()) {
      const src = readFileSync(f, "utf8");
      if (/\bqwenJson\b/.test(src) || /\bQWEN_MODEL\b/.test(src) || /\bQwenError\b/.test(src)) hits.push(f);
    }
    expect(hits, `qwen client identifier found in: ${hits.join(", ")}`).toEqual([]);
  });

  it("lib/qwen.ts itself is gone, not just unreferenced", () => {
    expect(() => readFileSync("lib/qwen.ts", "utf8")).toThrow();
  });

  it("the embeddings allow-list names real files that still exist and still use Ollama for embeddings only", () => {
    for (const rel of EMBEDDINGS_ALLOWLIST) {
      const src = readFileSync(rel, "utf8");
      expect(src, `${rel} was expected to reference OLLAMA_BASE_URL for embeddings`).toMatch(/OLLAMA_BASE_URL|EMBED_MODEL/);
      expect(src, `${rel} unexpectedly references qwen2.5`).not.toContain("qwen2.5");
    }
  });

  it("lib/llm/gemini.ts's routedChat fallback has no Ollama branch left", () => {
    const src = readFileSync("lib/llm/gemini.ts", "utf8");
    expect(src).not.toMatch(/OLLAMA_BASE_URL/);
    expect(src).toContain("openrouterChat");
    expect(src).toContain("openrouter:");
  });
});
