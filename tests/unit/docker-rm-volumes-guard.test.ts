/**
 * GUARD — no `docker rm` under tests/ may omit `-v`.
 *
 * WHY. `docker rm -f <name>` removes the container and ABANDONS its anonymous volumes. postgres:16
 * declares VOLUME /var/lib/postgresql/data, so every harness start and stop orphaned a data
 * directory: 1,198 orphaned volumes on 19 Sep alone, and the disk filled. Changing the four call
 * sites to `-fv` fixes it once; this file is what stops it coming back the day someone copies an
 * old harness or writes a new one.
 *
 * WHAT IT SCANS. Every .ts/.tsx/.js/.mjs/.cjs/.sh file under tests/, in two forms:
 *   - the ARGUMENT-ARRAY form the harnesses really use: `docker(["rm", "-f", name])`, checked only in
 *     files that mention docker (so an unrelated `rm -f` of a temp file is not a finding);
 *   - the STRING form: `docker rm -f x`, `docker container rm x`, in scripts and template strings.
 * A `docker rm` is safe only if it carries a volumes flag: -v, -fv, -vf, any bundled short flags with
 * v, or --volumes. This is stricter than the letter of "rm -f without -v": a plain `docker rm` leaks
 * the same volumes, so it is a finding too.
 *
 * The scanner is exercised against fixtures below FIRST, so the guard cannot rot into an empty sweep.
 * This file is the one file excluded from the scan (its fixtures are deliberately bad).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "tests");
const SELF = path.join("tests", "unit", "docker-rm-volumes-guard.test.ts");
const EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".sh"]);

type Site = { line: number; text: string; volumes: boolean };

const unquote = (t: string) => t.trim().replace(/^["'`]|["'`]$/g, "");
/** -v, -fv, -vf, -fvx … or --volumes. */
const hasVolumesFlag = (tokens: string[]) =>
  tokens.some((t) => t === "--volumes" || /^-[A-Za-z]*v[A-Za-z]*$/.test(t));

/**
 * Comments describe the old behaviour ("runs `docker rm -f <name>` then …") and are not calls. Whole-line
 * comments are blanked and trailing `// …` comments cut, keeping every line number. A real call with a
 * trailing comment is still a call and still scanned.
 */
const stripComments = (src: string) =>
  src.split("\n").map((l) => (/^\s*(\*|\/\/|\/\*|#)/.test(l) ? "" : l.replace(/\s\/\/.*$/, ""))).join("\n");

/** Every `docker rm` in `src`, with whether it carries a volumes flag. PURE. */
function findDockerRm(source: string): Site[] {
  const src = stripComments(source);
  const sites: Site[] = [];
  const lineOf = (i: number) => src.slice(0, i).split("\n").length;
  const mentionsDocker = /docker/i.test(src);

  if (mentionsDocker) {
    // ARGUMENT-ARRAY form: ["rm", "-f", name]
    for (const m of src.matchAll(/\[\s*(["'`])rm\1\s*,([^\]]*)\]/g)) {
      const tokens = m[2]!.split(",").map(unquote).filter((t) => t.startsWith("-"));
      sites.push({ line: lineOf(m.index!), text: m[0], volumes: hasVolumesFlag(tokens) });
    }
  }
  // STRING form: docker rm -f x / docker container rm x
  for (const m of src.matchAll(/\bdocker\s+(?:container\s+)?rm\b([^\n;|&`'"]*)/g)) {
    const tokens = m[1]!.split(/\s+/).filter((t) => t.startsWith("-"));
    sites.push({ line: lineOf(m.index!), text: m[0].trim(), volumes: hasVolumesFlag(tokens) });
  }
  return sites;
}

describe("the scanner itself (fixtures)", () => {
  const bad = [
    'docker(["rm", "-f", name]);',
    'sh(["rm","-f",PG_NAME])',
    'docker(["rm", "--force", name])',
    'docker(["rm", name])',
    "execSync(`docker rm -f ${name}`)",
    "docker rm -f x",
    "docker container rm -f x",
    "docker rm x",
    'docker(["rm", "-f", name]) // a comment saying -v does not make it safe',
  ];
  const good = [
    'docker(["rm", "-fv", name]);',
    'docker(["rm", "-vf", name]);',
    'docker(["rm", "-f", "-v", name]);',
    'docker(["rm", "--force", "--volumes", name]);',
    "execSync(`docker rm -fv ${name}`)",
    "docker rm --force --volumes x",
    "docker rm -v x",
    "docker container rm -fv x",
  ];

  it.each(bad)("FLAGS %s", (line) => {
    const s = findDockerRm(`const bin = "docker";\n${line}`);
    expect(s.length, "the scanner must find the site").toBeGreaterThan(0);
    expect(s.every((x) => !x.volumes), JSON.stringify(s)).toBe(true);
  });

  it.each(good)("ACCEPTS %s", (line) => {
    const s = findDockerRm(`const bin = "docker";\n${line}`);
    expect(s.length, "the scanner must still SEE the site").toBeGreaterThan(0);
    expect(s.every((x) => x.volumes), JSON.stringify(s)).toBe(true);
  });

  it("ignores prose in comments, but not a real call that has a comment after it", () => {
    expect(findDockerRm("// harness: runs `docker rm -f <name>` then `docker run`\n/**\n * `docker rm -f x` abandons the volume\n */\n# docker rm -f y")).toEqual([]);
    expect(findDockerRm('docker(["rm", "-f", name]); // docker rm -fv is what we want')).toHaveLength(1);
  });

  it("does not flag an `rm -f` that is not docker's", () => {
    expect(findDockerRm('spawn(["rm", "-f", tmpfile]);')).toEqual([]); // no docker anywhere in the file
    expect(findDockerRm("shred: 'if [ \"$1\" = -u ]; then rm -f \"$2\"; fi'")).toEqual([]);
  });

  it("reports the line of each site", () => {
    expect(findDockerRm('a\nb\ndocker(["rm", "-f", n]);\n// docker')[0]!.line).toBe(3);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

describe("tests/ — every docker rm carries -v", () => {
  const files = walk(ROOT).filter((f) => path.relative(process.cwd(), f) !== SELF);
  const found = files.flatMap((f) => findDockerRm(fs.readFileSync(f, "utf8")).map((s) => ({ file: path.relative(process.cwd(), f), ...s })));

  it("the sweep is not empty: it sees the four known harness sites and this guard's own file exists", () => {
    expect(fs.existsSync(path.join(process.cwd(), SELF))).toBe(true);
    expect(files.length).toBeGreaterThan(100);
    for (const f of ["tests/support/pg-harness.ts", "tests/support/s1-pg.ts"]) {
      expect(found.filter((s) => s.file === f).length, `${f} has two docker rm sites`).toBe(2);
    }
  });

  it("no docker rm under tests/ lacks a volumes flag", () => {
    const bare = found.filter((s) => !s.volumes);
    expect(
      bare,
      "`docker rm` without -v abandons the container's anonymous volumes — use `rm -fv`:\n" +
        bare.map((s) => `  ${s.file}:${s.line}  ${s.text}`).join("\n"),
    ).toEqual([]);
  });
});
