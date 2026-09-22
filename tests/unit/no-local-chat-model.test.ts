/**
 * tests/unit/no-local-chat-model.test.ts — qwen is out of ETA, and this keeps it out (V, 22 Sep).
 *
 * Fails if any production file under lib/ or app/:
 *   • references qwen2.5 in CODE, or
 *   • posts to an Ollama chat endpoint — /api/generate, /api/chat, or /chat/completions on an
 *     OLLAMA_BASE_URL / LLM_BASE_URL base — or calls chat on the Ollama OpenAI client.
 *
 * ALLOWED: embeddings on Ollama (nomic; the KB corpus is nomic-768). That is the only Ollama use left.
 *
 * TWO DESIGN CHOICES, both about not letting the guard lie:
 *   1. It WALKS THE FILESYSTEM, not `git ls-files`. A census built on git sees tracked files only,
 *      so a new untracked file would pass the gate and fail after the commit — it happened on 21 Sep.
 *   2. It strips comments WITH A TOKENISER that respects string literals. A naive `//` strip would cut
 *      `fetch("http://localhost:11434/api/generate")` at the `//` in the URL and hide exactly the call
 *      this test exists to catch. Comments may explain history ("qwen was retired"); code may not use it.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Remove // and /* *\/ comments, leaving string and template literals intact. */
export function stripComments(src: string): string {
  let out = "";
  let state: null | "line" | "block" | '"' | "'" | "`" = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const two = src.slice(i, i + 2);
    if (state === null) {
      if (two === "//") { state = "line"; i++; continue; }
      if (two === "/*") { state = "block"; i++; continue; }
      if (c === '"' || c === "'" || c === "`") state = c;
      out += c;
    } else if (state === "line") {
      if (c === "\n") { state = null; out += c; }
    } else if (state === "block") {
      if (two === "*/") { state = null; i++; continue; }
      if (c === "\n") out += c;
    } else {
      out += c;
      if (c === "\\") { out += src[i + 1] ?? ""; i++; continue; }
      if (c === state) state = null;
    }
  }
  return out;
}

/** Historical DISPLAY labels only: this map renders stored trace rows, and old rows do say
 *  qwen2.5:14b. Removing the key would show users the raw id it exists to hide. It calls nothing. */
const QWEN_LABEL_ALLOWED = new Set(["lib/llm-trace/model-labels.ts"]);

/** The rules, on one file's source. Returns the reasons it fails; empty means clean. */
export function violations(path: string, src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  if (/qwen2\.5/i.test(code) && !QWEN_LABEL_ALLOWED.has(path)) out.push("references qwen2.5");
  if (/\/api\/(generate|chat)\b/.test(code)) out.push("posts to an Ollama native chat endpoint");
  if (/\b(OLLAMA_BASE_URL|LLM_BASE_URL)\b/.test(code) && /chat\/completions|chat\.completions/.test(code)) {
    out.push("chat completions on an Ollama base (only embeddings are allowed there)");
  }
  if (/\bllm\.chat\.completions\b/.test(code)) out.push("chat on the Ollama OpenAI client");
  return out;
}

function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(p); }
      else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
    }
  };
  walk("lib");
  walk("app");
  return out;
}

describe("the rules catch what they are for (so a guard that matches nothing cannot pass)", () => {
  it("catches a qwen2.5 model id in code", () => {
    expect(violations("lib/x.ts", `const M = "qwen2.5:14b";`)).toContain("references qwen2.5");
  });
  it("catches an Ollama native endpoint, even behind a URL containing //", () => {
    expect(violations("lib/x.ts", `fetch("http://localhost:11434/api/generate", {})`))
      .toContain("posts to an Ollama native chat endpoint");
    expect(violations("lib/x.ts", `const u = "http://h/api/chat";`)).toContain("posts to an Ollama native chat endpoint");
  });
  it("catches chat completions on an Ollama base", () => {
    const src = "const base = process.env.OLLAMA_BASE_URL;\nawait fetch(`${base}/chat/completions`, {});";
    expect(violations("lib/x.ts", src)).toContain("chat completions on an Ollama base (only embeddings are allowed there)");
  });
  it("catches chat on the Ollama OpenAI client", () => {
    expect(violations("lib/x.ts", `await llm.chat.completions.create(params);`)).toContain("chat on the Ollama OpenAI client");
  });
  it("ALLOWS embeddings on Ollama — the one use that stays", () => {
    const src = "const base = process.env.OLLAMA_BASE_URL;\nawait fetch(`${base}/embeddings`, {});";
    expect(violations("lib/x.ts", src)).toEqual([]);
  });
  it("ignores a comment that explains history", () => {
    expect(violations("lib/x.ts", "// qwen2.5:14b was retired on 22 Sep\n/* it used /api/generate */\nconst ok = 1;")).toEqual([]);
  });
  it("the comment stripper keeps strings and drops comments", () => {
    expect(stripComments(`a("http://x/y") // gone\nb`)).toBe(`a("http://x/y") \nb`);
    expect(stripComments("x /* gone */ y")).toBe("x  y");
    expect(stripComments("s = `// not a comment`;")).toBe("s = `// not a comment`;");
  });
  it("the allow-list is display labels only, and names a file that exists", () => {
    for (const f of QWEN_LABEL_ALLOWED) expect(() => statSync(f)).not.toThrow();
    expect(violations("lib/llm-trace/model-labels.ts", `const M = { "qwen2.5:14b": "reasoning model" };`)).toEqual([]);
  });
});

describe("THE TREE: no qwen and no Ollama chat anywhere in lib/ or app/", () => {
  it("every production file is clean", () => {
    const files = productionFiles();
    expect(files.length).toBeGreaterThan(100);   // it really walked the tree
    const bad = files.map((f) => ({ f, v: violations(f, readFileSync(f, "utf8")) })).filter((x) => x.v.length);
    expect(bad.map((b) => `${b.f}: ${b.v.join("; ")}`)).toEqual([]);
  });

  it("the Ollama that remains is embeddings — and it still exists", () => {
    const users = productionFiles().filter((f) => /\bOLLAMA_BASE_URL\b/.test(stripComments(readFileSync(f, "utf8"))));
    expect(users).toContain("lib/kb-embed.ts");
  });
});
