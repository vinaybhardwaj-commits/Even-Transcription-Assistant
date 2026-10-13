/**
 * ADMIN-5 guard (Fable SHIP WITH CONDITIONS, 13 Oct 2026): skipAudit drops a lib audit row, so only
 * scribe_admin may pass it — that tool writes its own strict admin.<action> row first. Any other
 * caller setting skipAudit would bring back an unaudited disable or retire (the OPD 4 lost day).
 *
 * Static: every file under app/ and lib/ that mentions skipAudit must be the tool or one of the two
 * libs that only pass it through; the libs never set it themselves; the Bench PATCH route, the
 * /admin retire route and the PIN lockout call their lib function without it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const TOOL = "lib/mcp/tools/admin.ts";
const PASS_THROUGH = ["lib/room-enable.ts", "lib/room-install.ts"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

const rel = (p: string) => relative(ROOT, p).split(sep).join("/");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "lib"))].map(rel);

describe("ADMIN-5 guard: skipAudit only from scribe_admin", () => {
  it("no file in app/ or lib/ mentions skipAudit except the tool and the two pass-through libs", () => {
    const hits = files.filter((f) => src(f).includes("skipAudit"));
    expect(hits.sort()).toEqual([TOOL, ...PASS_THROUGH].sort());
  });

  it("the pass-through libs never set skipAudit to true themselves", () => {
    for (const f of PASS_THROUGH) expect(src(f)).not.toMatch(/skipAudit\s*:\s*true/);
  });

  it("the tool is the one caller that sets it", () => {
    expect(src(TOOL)).toMatch(/skipAudit\s*:\s*true/);
  });

  it("Bench PATCH, /admin retire and the PIN lockout call their lib function without skipAudit", () => {
    const calls: Array<[string, RegExp]> = [
      ["app/api/bench/rooms/route.ts", /setRoomEnabled\([^)]*\)/g],
      ["app/api/admin/installs/[installId]/retire/route.ts", /retireInstall\([^)]*\)/g],
      ["lib/room-auth.ts", /recordRoomToggle\(\{[^}]*\}\)/g],
    ];
    for (const [f, re] of calls) {
      const found = src(f).match(re) ?? [];
      expect(found.length, `${f} still calls its lib function`).toBeGreaterThan(0);
      for (const c of found) expect(c).not.toContain("skipAudit");
    }
  });
});
