// HIST harness piece 3: run the PINNED production collapseAssembled (lib/stt/assembled-collapse.ts) UNMODIFIED.
// stdin: {"texts": [string|null, ...]}  stdout: {"pinned_sha", "file_sha256", "numwords_sha", "results": [{text, units_collapsed, lines_dropped, changed}]}
// Refuses to run unless the worktree is at the pinned commit and clean. Text goes stdin->stdout only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const WT = process.env.HIST_PROD_WT ?? `${process.env.HOME}/dev/eta-wt-hist-prod`;
const PIN = process.env.HIST_PROD_SHA ?? "5970852";
const head = execFileSync("git", ["-C", WT, "rev-parse", "--short=7", "HEAD"]).toString().trim();
const dirty = execFileSync("git", ["-C", WT, "status", "--porcelain", "--", "lib/stt"]).toString().trim();
if (head !== PIN || dirty) { console.error(`refused: worktree at ${head}${dirty ? " (dirty)" : ""}, pinned ${PIN}`); process.exit(2); }
const mod = await import(`${WT}/lib/stt/assembled-collapse.ts`);
const input = JSON.parse(readFileSync(0, "utf8")) as { texts: (string | null)[] };
const out = input.texts.map((t) => mod.collapseAssembled(t));
const sha = createHash("sha256").update(readFileSync(`${WT}/lib/stt/assembled-collapse.ts`)).digest("hex");
console.log(JSON.stringify({ pinned_sha: head, file_sha256: sha.slice(0, 16), numwords_sha: String(mod.NUMBER_WORDS_SHA).slice(0, 12), results: out }));
