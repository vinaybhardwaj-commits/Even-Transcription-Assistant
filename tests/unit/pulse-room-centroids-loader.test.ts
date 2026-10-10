/**
 * The pulse_room pack loader (tools/pulse-room-centroids/load.py). Pure python, standard library only, synthetic
 * fixtures only: it runs here, in the repo gate. No database, no real embedding.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "tools", "pulse-room-centroids");

describe("pulse-room-centroids loader", () => {
  it("passes its own unit tests", () => {
    const r = spawnSync("python3", ["-W", "error", "-m", "unittest", "test_load"], { cwd: DIR, encoding: "utf8" });
    expect(r.stderr + r.stdout).toMatch(/OK/);
    expect(r.status).toBe(0);
  });
  it("imports nothing but the standard library and has no DB driver or network word", () => {
    const src = readFileSync(path.join(DIR, "load.py"), "utf8");
    const imports = [...src.matchAll(/^(?:from|import)\s+([\w.]+)/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["hashlib", "json", "math", "os", "re", "sys"]);
    expect(src).not.toMatch(/psycopg|sqlalchemy|socket|urllib|requests|DATABASE_URL|postgres:\/\//i);
  });
});
