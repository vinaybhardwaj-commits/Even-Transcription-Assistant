// Architecture gates (M0-A). Plain Node, no deps. Run: npm run architecture:check
//
// Rules (each failure prints file:line):
//   portal-wall      portal code must not import staff-only modules
//   upstream-db      no upstream DB env names / non-DATABASE_URL Postgres URLs
//   one-db-client    neon may be referenced only in src/lib/db.ts
//
// Exceptions are per OCCURRENCE: each excepted file records the exact number of
// offending references it has today, and the gate fails if that number rises.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---- Rule a: portal wall -------------------------------------------------
export const PORTAL_GLOBS = ["src/app/portal/", "src/app/api/portal/"];
// Staff session / staff role modules. Matched by resolved path (exact file or directory prefix).
export const STAFF_ONLY = [
  "src/lib/auth.ts",
  "src/lib/staff-guard.ts",
  "src/lib/staff-live.ts",
  "src/lib/ops-auth.ts",
  "src/lib/roles.ts", // staff role labels
  "src/lib/cron-auth.ts", // staff/ops cron credentials
  "src/lib/mcp-oauth.ts", // staff MCP session tokens
  "src/lib/hospital-filter.ts", // staff hospital scoping from staff session
  "src/lib/capture/staff.ts", // requireCaptureStaff
  "src/lib/physician-summary/access.ts", // requireSummaryViewer
  "src/components/admin/",
  "src/app/admin/",
];
// Portal -> staff-only imports that exist today: { "portal/file.ts": ["src/lib/x.ts"] }.
export const PORTAL_KNOWN_EXCEPTIONS = {
  // (none found at 685d5df: portal code imports physician-auth, portal-flags, db and shared libs only)
};

// ---- Rule b: no direct upstream DB --------------------------------------
// Upstream names: zero tolerance everywhere, excepted files included.
export const UPSTREAM_ENV_RE = /NEWCAT\w*(DATABASE|DB|PG)|CDMSS\w*(DATABASE|DB|PG)|METABASE|NEON\w*(URL|DATABASE|DB|PG)/;
// Any other Postgres connection name besides DATABASE_URL. Matched as a bare token so that
// process.env.X, process.env["X"] and `const { X } = process.env` are all caught.
export const OTHER_PG_RE = /\b(?:POSTGRES\w*|PG(?:HOST|URL|DATABASE|USER|PASSWORD|PORT|CONNECT)\w*|\w+_DATABASE_URL)\b/g;
export const PG_URL_LITERAL_RE = /postgres(?:ql)?:\/\//g;
// { file: exact number of other-PG references allowed today } (debt).
export const UPSTREAM_KNOWN_EXCEPTIONS = {
  "src/app/api/service/observations/route.ts": 1, // falls back to process.env.POSTGRES_URL when DATABASE_URL is unset
};

// ---- Rule c: one DB client ----------------------------------------------
export const DB_CLIENT_FILE = "src/lib/db.ts";
// { file: exact number of `neon` references (calls, aliases) allowed today } (debt). A rise fails.
export const NEON_KNOWN_EXCEPTIONS = {
  "src/app/admin/page.tsx": 1,
  "src/app/api/admin/bulk-import-physicians/route.ts": 1,
  "src/app/api/admin/census/members/route.ts": 1,
  "src/app/api/admin/census/route.ts": 1,
  "src/app/api/admin/clinical-metrics/upload/route.ts": 1,
  "src/app/api/admin/db-fresh/route.ts": 1,
  "src/app/api/admin/db-snapshot/route.ts": 1,
  "src/app/api/admin/dedupe-physicians/route.ts": 1,
  "src/app/api/admin/email-test/route.ts": 1,
  "src/app/api/admin/expiry-alerts/route.ts": 1,
  "src/app/api/admin/migrate/route.ts": 1,
  "src/app/api/admin/oppe-kickstart/route.ts": 1,
  "src/app/api/admin/oppe-scheduler/route.ts": 2,
  "src/app/api/admin/portal-welcome/route.ts": 1,
  "src/app/api/admin/profiles/[id]/reset-pin/route.ts": 1,
  "src/app/api/admin/profiles/[id]/roles/route.ts": 2,
  "src/app/api/admin/profiles/[id]/route.ts": 3,
  "src/app/api/admin/profiles/route.ts": 1,
  "src/app/api/admin/qualifications/pending/route.ts": 1,
  "src/app/api/admin/resignations/[id]/process/route.ts": 1,
  "src/app/api/admin/resignations/route.ts": 1,
  "src/app/api/admin/seed-epi-base/route.ts": 1,
  "src/app/api/admin/seed-profile/route.ts": 1,
  "src/app/api/admin/users/route.ts": 1,
  "src/app/api/admin/vertex/health/route.ts": 1,
  "src/app/api/admin/wipe-smoke-residue/route.ts": 1,
  "src/app/api/auth/change-pin/route.ts": 1,
  "src/app/api/auth/login/route.ts": 1,
  "src/app/api/auth/signup/route.ts": 1,
  "src/app/api/hospitals-public/route.ts": 1,
  "src/app/api/hospitals/route.ts": 1,
  "src/app/api/incidents/[id]/replies/route.ts": 1,
  "src/app/api/incidents/[id]/route.ts": 3,
  "src/app/api/incidents/[id]/view/route.ts": 1,
  "src/app/api/incidents/home/route.ts": 1,
  "src/app/api/incidents/physician/[id]/route.ts": 1,
  "src/app/api/incidents/physician/[id]/summary/route.ts": 2,
  "src/app/api/incidents/route.ts": 2,
  "src/app/api/mcp/route.ts": 1,
  "src/app/api/oppe/[id]/decision/route.ts": 1,
  "src/app/api/oppe/[id]/route.ts": 1,
  "src/app/api/physicians/[id]/audit/route.ts": 1,
  "src/app/api/physicians/[id]/carry-candidates/route.ts": 1,
  "src/app/api/physicians/[id]/clinical-metrics/route.ts": 1,
  "src/app/api/physicians/[id]/engagements/[eid]/route.ts": 2,
  "src/app/api/physicians/[id]/engagements/route.ts": 1,
  "src/app/api/physicians/[id]/fppe/route.ts": 1,
  "src/app/api/physicians/[id]/oppe/route.ts": 1,
  "src/app/api/physicians/[id]/portal-access/route.ts": 1,
  "src/app/api/physicians/[id]/privilege-requests/route.ts": 2,
  "src/app/api/physicians/[id]/privileges/[prid]/route.ts": 2,
  "src/app/api/physicians/[id]/privileges/route.ts": 2,
  "src/app/api/physicians/[id]/qualifications/[qid]/file/route.ts": 1,
  "src/app/api/physicians/[id]/qualifications/[qid]/route.ts": 2,
  "src/app/api/physicians/[id]/qualifications/route.ts": 2,
  "src/app/api/physicians/[id]/route.ts": 3,
  "src/app/api/physicians/route.ts": 2,
  "src/app/api/portal/about-me/route.ts": 1,
  "src/app/api/portal/auth/login/route.ts": 1,
  "src/app/api/portal/auth/request-pin/route.ts": 1,
  "src/app/api/portal/auth/set-pin/route.ts": 1,
  "src/app/api/portal/feedback/route.ts": 1,
  "src/app/api/portal/incidents/[id]/reply/route.ts": 1,
  "src/app/api/portal/me/route.ts": 1,
  "src/app/api/portal/performance/route.ts": 1,
  "src/app/api/portal/physicians/route.ts": 1,
  "src/app/api/portal/privileges/route.ts": 1,
  "src/app/api/portal/qualifications/[qid]/route.ts": 1,
  "src/app/api/portal/qualifications/route.ts": 2,
  "src/app/api/portal/resignation/route.ts": 2,
  "src/app/api/privilege-requests/[id]/decision/route.ts": 1,
  "src/app/api/public/incidents/route.ts": 1,
  "src/app/api/public/physicians/route.ts": 1,
  "src/app/api/service/observations/route.ts": 2,
  "src/app/api/vc-onboarding/prescreens/[id]/decision/route.ts": 1,
  "src/app/api/vc-onboarding/prescreens/[id]/observations/route.ts": 2,
  "src/app/api/vc-onboarding/prescreens/[id]/route.ts": 1,
  "src/app/api/vc-onboarding/prescreens/route.ts": 2,
  "src/app/home/page.tsx": 1,
  "src/lib/hospital-filter.ts": 1,
};

const norm = (p) => p.split(path.sep).join("/");
const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);
const stripExt = (p) => p.replace(/\.(?:[cm]?[jt]sx?)$/, "");
const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;

function resolveImport(fromFile, spec) {
  if (spec.startsWith("@/")) return "src/" + spec.slice(2);
  if (spec.startsWith(".")) return norm(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec)));
  return null;
}
function isStaffOnly(resolved) {
  const r = stripExt(resolved).replace(/\/index$/, "");
  return STAFF_ONLY.some((s) => (s.endsWith("/") ? r.startsWith(s) || r + "/" === s : r === stripExt(s)));
}

// Every module specifier in the file, wherever it sits (multi-line safe): static, re-export, side-effect, dynamic, require.
const SPEC_RES = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];
function specifiers(text) {
  const out = [];
  for (const re of SPEC_RES) for (const m of text.matchAll(re)) out.push({ spec: m[1], index: m.index });
  return out.sort((a, b) => a.index - b.index);
}

/** Names `neon` is bound to in this file (neon itself, `neon as X`, `import * as ns` is handled via .neon). */
function neonNames(text) {
  const names = new Set(["neon"]);
  for (const m of text.matchAll(/\bneon\s+as\s+(\w+)/g)) names.add(m[1]);
  for (const m of text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*neon\b(?!\s*\()/g)) names.add(m[1]);
  return names;
}

/** files: [{ path: "src/...", text }]. Returns [{ rule, file, line, message }]. */
export function checkFiles(files, opts = {}) {
  const portalEx = opts.portalExceptions ?? PORTAL_KNOWN_EXCEPTIONS;
  const upEx = opts.upstreamExceptions ?? UPSTREAM_KNOWN_EXCEPTIONS;
  const neonEx = opts.neonExceptions ?? NEON_KNOWN_EXCEPTIONS;
  const out = [];
  for (const { path: file, text } of files) {
    const lines = text.split("\n");

    if (PORTAL_GLOBS.some((g) => file.startsWith(g))) {
      for (const { spec, index } of specifiers(text)) {
        const r = resolveImport(file, spec);
        if (!r || !isStaffOnly(r)) continue;
        const allowed = (portalEx[file] ?? []).some((e) => stripExt(e) === stripExt(r));
        if (!allowed) out.push({ rule: "portal-wall", file, line: lineOf(text, index), message: `portal code imports staff-only module "${spec}"` });
      }
    }

    if (file.startsWith("src/")) {
      // upstream-db: per occurrence
      const otherHits = [];
      lines.forEach((line, i) => {
        if (isComment(line)) return;
        if (UPSTREAM_ENV_RE.test(line)) out.push({ rule: "upstream-db", file, line: i + 1, message: "references an upstream DB env name (NEWCAT/CDMSS/METABASE/NEON_*)" });
        else for (const _ of line.matchAll(OTHER_PG_RE)) otherHits.push(i + 1);
        for (const _ of line.matchAll(PG_URL_LITERAL_RE)) otherHits.push(i + 1);
      });
      const allowedOther = upEx[file] ?? 0;
      otherHits.slice(allowedOther).forEach((line) =>
        out.push({ rule: "upstream-db", file, line, message: `Postgres URL reference other than process.env.DATABASE_URL (${otherHits.length} in file, allowed ${allowedOther})` }));

      // one-db-client: every reference to neon (or an alias of it), outside import lines
      if (file !== DB_CLIENT_FILE) {
        const names = [...neonNames(text)].join("|");
        const re = new RegExp(`(?<![\\w$])(?:${names})(?![\\w$])`);
        const hits = [];
        lines.forEach((line, i) => {
          if (isComment(line) || /^\s*import\b/.test(line) || /\bfrom\s*["']/.test(line)) return;
          const g = new RegExp(re.source, "g");
          for (const _ of line.matchAll(g)) hits.push(i + 1);
        });
        const allowed = neonEx[file] ?? 0;
        hits.slice(allowed).forEach((line) =>
          out.push({ rule: "one-db-client", file, line, message: `neon reference outside src/lib/db.ts (${hits.length} in file, allowed ${allowed}); use \`sql\` from @/lib/db, new call sites are not allowed` }));
      }
    }
  }
  return out;
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "__tests__") walk(p, acc); }
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) acc.push(p);
  }
  return acc;
}

export function main(root = process.cwd()) {
  const files = walk(path.join(root, "src")).map((p) => ({ path: norm(path.relative(root, p)), text: fs.readFileSync(p, "utf8") }));
  const problems = checkFiles(files);
  if (problems.length) {
    for (const p of problems) console.error(`architecture:check FAIL [${p.rule}] ${p.file}:${p.line} ${p.message}`);
    console.error(`architecture:check: ${problems.length} violation(s)`);
    return 1;
  }
  console.log(`architecture:check OK (${files.length} files; neon exceptions ${Object.keys(NEON_KNOWN_EXCEPTIONS).length}; portal exceptions ${Object.keys(PORTAL_KNOWN_EXCEPTIONS).length})`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exit(main());
