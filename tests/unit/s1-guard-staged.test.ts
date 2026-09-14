/**
 * S1 FIX3b C11 — the repo-content guards scan the STAGED tree (tests/support/repo-files.ts).
 *
 * THE ESCAPE THIS CLOSES. The guard exempts untracked files under docs/handoff/. A bus document written
 * and gated while untracked, then staged and committed after the gate, was never scanned — and one
 * carried a token of the banned clinician-id shape into a commit. Two things now hold, proven here in a
 * throwaway git repository so nothing in this checkout is touched:
 *   1. a STAGED docs/handoff file is scanned (the untracked one still is not — the exemption is kept);
 *   2. a file's STAGED copy is scanned even when its working copy no longer carries the token — what the
 *      commit would record, not only what is on disk.
 *
 * The banned shape is assembled at run time, never written in this file, so the guard over this repo does
 * not trip on its own test.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoFiles, textOf } from "../support/repo-files";

// The same shape no-real-clinician-ids.test.ts bans. Copied, not imported: importing a test file would run
// its suites here too. This file proves the guard's SCOPE (which copies of which files it reads), not its regex.
const SHAPE = /(?<![A-Za-z0-9_])doc_[a-z0-9]{8}(?![A-Za-z0-9_])/g;
const unlistedIds = (text: string) => [...text.matchAll(SHAPE)].map((m) => m[0]);
const idShaped = ["doc", "q7mz9kx4"].join("_");
let dir = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
const write = (f: string, text: string) => { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), text); };
/** What the guard reports for this repo: file and count, never the token. */
const offenders = () => repoFiles(dir).map((f) => [f, unlistedIds(textOf(f, dir) ?? "").length] as const).filter(([, n]) => n > 0).map(([f, n]) => `${f} (${n})`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "s1-guard-"));
  git("init", "-q");
  write("README.md", "clean\n");
  git("add", "README.md");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("the guard scans the staged tree", () => {
  it("an UNTRACKED bus document is exempt; the SAME document, once staged, is scanned and caught", () => {
    const doc = "docs/handoff/NOTE.md";
    write(doc, `a note naming ${idShaped}\n`);
    expect(repoFiles(dir), "the bus exemption is kept for working papers").not.toContain(doc);
    expect(offenders()).toEqual([]);

    git("add", doc);
    expect(repoFiles(dir)).toContain(doc);
    expect(offenders()).toEqual([`${doc} (1)`]);
  });

  it("a STAGED copy carrying the token is caught even after the working copy is cleaned — the commit would carry it", () => {
    const doc = "docs/handoff/REPORT.md";
    write(doc, `placeholder ${idShaped}\n`);
    git("add", doc);
    write(doc, "placeholder doc_<id>\n");
    expect(offenders(), "the working copy is clean, the staged copy is not").toEqual([`${doc} (1)`]);

    git("add", doc);
    expect(offenders(), "the control: once the clean copy is staged, nothing is reported").toEqual([]);
  });

  it("the reverse: a clean staged copy with a dirty working copy is caught as well — either copy counts", () => {
    const f = "src/a.ts";
    write(f, "export const a = 1;\n");
    git("add", f);
    write(f, `export const a = "${idShaped}";\n`);
    expect(offenders()).toEqual([`${f} (1)`]);
  });

  it("a staged file deleted from the working tree is still scanned", () => {
    const f = "src/b.ts";
    write(f, `export const b = "${idShaped}";\n`);
    git("add", f);
    rmSync(join(dir, f));
    expect(offenders()).toEqual([`${f} (1)`]);
  });
});
