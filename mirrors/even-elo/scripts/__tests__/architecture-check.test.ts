import { describe, expect, it } from "vitest";
import { checkFiles } from "../architecture-check.mjs";

type F = { path: string; text: string };
type P = { rule: string; file: string; line: number; message: string };
const run = (files: F[], opts: Record<string, unknown> = {}): P[] => checkFiles(files, opts);

describe("architecture:check portal wall", () => {
  it("passes when portal code imports only shared modules", () => {
    const f = { path: "src/app/api/portal/me/route.ts", text: 'import { sql } from "@/lib/db";\nimport { x } from "@/lib/physician-auth";' };
    expect(run([f])).toEqual([]);
  });
  it("fails with file:line for a staff-only import (alias, relative, dir)", () => {
    const f = {
      path: "src/app/portal/page.tsx",
      text: 'import a from "react";\nimport { g } from "@/lib/staff-guard";\nimport b from "@/components/admin/Foo";\nimport c from "../../lib/auth";',
    };
    const r = run([f]);
    expect(r.map((x) => [x.rule, x.line])).toEqual([["portal-wall", 2], ["portal-wall", 3], ["portal-wall", 4]]);
    expect(r[0].file).toBe("src/app/portal/page.tsx");
  });
  it("does not flag staff code importing staff modules", () => {
    expect(run([{ path: "src/app/admin/page.tsx", text: 'import { g } from "@/lib/staff-guard";' }])).toEqual([]);
  });
  it("honours KNOWN_EXCEPTIONS", () => {
    const f = { path: "src/app/portal/page.tsx", text: 'import { g } from "@/lib/staff-guard";' };
    expect(run([f], { portalExceptions: { "src/app/portal/page.tsx": ["src/lib/staff-guard.ts"] } })).toEqual([]);
  });
});

describe("architecture:check upstream DB", () => {
  it("passes for DATABASE_URL", () => {
    expect(run([{ path: "src/lib/x.ts", text: "const u = process.env.DATABASE_URL;" }])).toEqual([]);
  });
  it("fails for upstream env names, other PG env, and URL literals", () => {
    const f = { path: "src/lib/x.ts", text: "a(process.env.CDMSS_DATABASE_URL);\nb(process.env.METABASE_URL);\nc(process.env.POSTGRES_URL);\nd('postgres://u@h/db');\ne(process.env.NEWCAT_PG_URL)" };
    const r = run([f], { upstreamExceptions: {}, neonExceptions: {} });
    expect(r.map((x) => x.line).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(r.every((x) => x.rule === "upstream-db")).toBe(true);
  });
  it("ignores comments and honours exceptions", () => {
    expect(run([{ path: "src/lib/x.ts", text: "// process.env.CDMSS_DATABASE_URL" }])).toEqual([]);
    expect(run([{ path: "src/lib/x.ts", text: "process.env.POSTGRES_URL" }], { upstreamExceptions: { "src/lib/x.ts": 1 } })).toEqual([]);
  });
});

describe("architecture:check one DB client", () => {
  it("passes for neon( in src/lib/db.ts", () => {
    expect(run([{ path: "src/lib/db.ts", text: "cached = neon(url);" }])).toEqual([]);
  });
  it("fails for a new call site", () => {
    const r = run([{ path: "src/lib/new.ts", text: "const sql = neon(url);" }], { neonExceptions: {} });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ rule: "one-db-client", file: "src/lib/new.ts", line: 1 });
  });
  it("allows listed legacy sites only", () => {
    const text = "const sql = neon(url);";
    const files = [{ path: "src/lib/old.ts", text }, { path: "src/lib/new.ts", text }];
    const r = run(files, { neonExceptions: { "src/lib/old.ts": 1 } });
    expect(r.map((x) => x.file)).toEqual(["src/lib/new.ts"]);
  });
});

describe("architecture:check per-occurrence exceptions and evasions", () => {
  const NONE = { upstreamExceptions: {}, neonExceptions: {} };
  it("upstream names stay forbidden inside an excepted file", () => {
    const f = { path: "src/a.ts", text: "x(process.env.POSTGRES_URL);\ny(process.env.CDMSS_DATABASE_URL);" };
    const r = run([f], { ...NONE, upstreamExceptions: { "src/a.ts": 1 } });
    expect(r.map((x) => x.line)).toEqual([2]);
  });
  it("fails when an excepted file's Postgres reference count rises", () => {
    const one = { path: "src/a.ts", text: "x(process.env.POSTGRES_URL);" };
    const two = { path: "src/a.ts", text: "x(process.env.POSTGRES_URL);\ny(process.env.POSTGRES_URL);" };
    const ex = { ...NONE, upstreamExceptions: { "src/a.ts": 1 } };
    expect(run([one], ex)).toEqual([]);
    expect(run([two], ex)).toHaveLength(1);
  });
  it("fails when an excepted file gains a second neon( call", () => {
    const ex = { ...NONE, neonExceptions: { "src/a.ts": 1 } };
    expect(run([{ path: "src/a.ts", text: "const a = neon(u);" }], ex)).toEqual([]);
    const r = run([{ path: "src/a.ts", text: "const a = neon(u);\nconst b = neon(v);" }], ex);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ rule: "one-db-client", line: 2 });
  });
  it("catches bracket access, destructuring and NEON_URL", () => {
    const f = { path: "src/a.ts", text: 'a(process.env["POSTGRES_URL"]);\nconst { POSTGRES_URL } = process.env;\nb(process.env.NEON_URL);\nc(process.env[\'PGHOST\']);' };
    expect(run([f], NONE).map((x) => x.line).sort()).toEqual([1, 2, 3, 4]);
  });
  it("catches aliased neon imports and assignments", () => {
    const aliased = { path: "src/a.ts", text: 'import { neon as mk } from "@neondatabase/serverless";\nconst sql = mk(url);' };
    expect(run([aliased], NONE)).toHaveLength(1);
    const assigned = { path: "src/b.ts", text: 'import { neon } from "@neondatabase/serverless";\nconst mk = neon;\nconst sql = mk(url);' };
    expect(run([assigned], NONE).length).toBeGreaterThan(0);
    const ns = { path: "src/c.ts", text: 'import * as n from "@neondatabase/serverless";\nconst sql = n.neon(url);' };
    expect(run([ns], NONE)).toHaveLength(1);
  });
  it("a plain neon import line alone is not a violation", () => {
    expect(run([{ path: "src/a.ts", text: 'import type { NeonQueryFunction } from "@neondatabase/serverless";' }], NONE)).toEqual([]);
  });
});

describe("architecture:check portal wall evasions", () => {
  const p = (text: string) => run([{ path: "src/app/api/portal/me/route.ts", text }]);
  it("catches .js-suffixed imports", () => {
    expect(p('import { a } from "@/lib/auth.js";')).toHaveLength(1);
    expect(p('import { a } from "../../../../lib/staff-guard.ts";')).toHaveLength(1);
  });
  it("catches multi-line dynamic imports and reports the module line", () => {
    const r = p('const m = await import(\n  "@/lib/auth"\n);');
    expect(r).toHaveLength(1);
    expect(r[0].line).toBe(1);
  });
  it("catches multi-line static imports, re-exports, side-effect imports and require", () => {
    expect(p('import {\n  a,\n} from\n  "@/lib/ops-auth";')).toHaveLength(1);
    expect(p('export { a } from "@/lib/staff-live";')).toHaveLength(1);
    expect(p('import "@/lib/roles";')).toHaveLength(1);
    expect(p('const x = require("@/lib/cron-auth");')).toHaveLength(1);
  });
  it("covers the capture and physician-summary staff guards", () => {
    expect(p('import { requireCaptureStaff } from "@/lib/capture/staff";')).toHaveLength(1);
    expect(p('import { requireSummaryViewer } from "@/lib/physician-summary/access";')).toHaveLength(1);
    expect(p('import { ok } from "@/lib/capture/present";')).toHaveLength(0);
  });
});
