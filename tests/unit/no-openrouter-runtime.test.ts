/**
 * tests/unit/no-openrouter-runtime.test.ts — V's order of 23 Oct: no ETA TypeScript runtime path calls OpenRouter,
 * so OPENROUTER_API_KEY can be removed from Vercel. Pins that nothing under lib/ or app/ imports the
 * (now unused) client or names an OPENROUTER_* variable.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== "node_modules" && n !== ".next") walk(p, out); }
    else if (/\.(ts|tsx|mjs|js)$/.test(n)) out.push(p);
  }
  return out;
}

describe("no OpenRouter in the TypeScript runtime", () => {
  it("nothing in lib/ or app/ imports lib/openrouter or reads an OPENROUTER_* variable", () => {
    const offenders = [...walk("lib"), ...walk("app")]
      .filter((f) => f !== join("lib", "openrouter.ts"))
      .filter((f) => /from\s+["'](?:@\/lib|\.{1,2}(?:\/\.\.)*(?:\/lib)?)\/openrouter["']|OPENROUTER_[A-Z_]+|openrouter\.ai/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
