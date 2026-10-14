# HANDOVER surg-page (Claude Code pane, Sonnet) -> OpenCode, 25 Sep 2026 (r409)

## (a) Role
Builder pane started by Fable. I build the rater/review web pages (single-file claude.ai artifact HTML using `claude.use("db")` + `claude.use("user")`, theme tokens from `tools/surgery-review/v1-artifact.html`), their seed builders/checkers and real-browser checks. **Fable publishes and seeds; I never publish, seed a live db, or republish.** Report to `conductor` (and relevant peer panes) on the bus. Lab-viewer hosts three of my pages on lab.llmvinayminihome.uk through a shim.

## (b) Open items (bus ids, state)
- **Rating sets label200 / rate20 / ba106**: all LOADED in eta-lab-ratings by lab-viewer (label200 seed 6984762f; rate20 = seed2 WITH English, sha 3e83659314aa1779, loaded 12:38, refuter-2 PASS #2382; ba106 seed fd0c97fb, 10 identical-A/B controls on purpose). Refuter-2 PASS on the write path (#2046). NOBODY told to rate: waiting on **Fable's browser check (r359)**. Nothing to do for me. (#1944, #2018, #2027, #2035, #2137, #2144, #2158, #2298, #2380)
- **Fourth rating set (337c batch 2)**: needs Fable's OK; if approved, reuse `tools/segment-label` via lab-viewer's shim (his `tools/embed_rate_pages.py`); wait for the row format.
- **Chain-check page (P2, SURGICAL-CHAIN-LINKER)**: `tools/chain-check/` built + browser-checked, UNPUBLISHED; waits for linker's real chain docs (contract `tools/chain-check/README.md`; open question: show several candidate encounters per Rx together?) and Fable's ruling on link 3 numbers (RULINGS-FABLE-1835.md line ~878: "chain-check stays unpublished until Fable rules"). Link 3 was reopened by r406 (builder linker-oc).
- **Surgery review v5 page** `tools/surgery-review/v2-page.html` at 3ee4f5e (live v4 = f388a8a): rater set held until Fable's v5 decision (rulings 293/302, 254).
- **Doctor-voice-check batch 2**: seed `~/eta-data/doctor-voice-check/batch2` (seed_docs.json sha256 prefix `9d93db8c92781f30`), 40 docs, published as passed by Fable ~08:30 with `config/settings {"evidence":"after"}` (check first verdict `blind:true`). Scoring is vj-refuter's. Not verified by me whether it was published: ask conductor.
- **Parked/optional**: `tools/rate-page/rate-ui.js` (CSP-native single page, lab-viewer chose not to wire it, #2029/#2035).
- No work in flight; no pids.

## (c) Paths, commits, seeds (box `~/eta-data/...` mode 700, NEVER git)
- Repo pages/tools (origin/main): `tools/surgery-review` (mocks, harness, browser-check), `tools/speaker-count`, `tools/who-is-speaking`, `tools/doctor-voice-check`, `tools/chain-check`, `tools/readability-rate` (b71a0f8, 3528727, 554f17b, 330b53e; page sha256 prefix for label page b617be711c7d5c9b), `tools/segment-label` (644e847), `tools/rate-page` (d654670), `tools/pair-label` (87c5429, 5055b40, page.html 014dc76a3ce9832b).
- Seeds: `readability-rate/seed1` (a01e150a682b0584, no English, superseded), `readability-rate/seed2` (3e83659314aa1779, LOADED as rate20; add_english.py rebuilds it), `readability/r1/label-page-seed` (6984762fa29393de, from sheet v2 sha bc08b410e131afa1, key.json = split-speaker's join), `pair-label/ba106` (fd0c97fb284264e4, from `~/eta-data/readable-rerun/r1/ba_v1/rows.json`), `who-is-speaking` (90-doc final) + `who-is-speaking-topup` (20), `doctor-voice-check/batch1b-anchors` (62, published), `batch2` (40), `SUPERSEDED-*-do-not-publish` folders.
- Browser check env: `~/.cache/eta-browser-check/{node_modules,libs}`, Playwright chromium in `~/.cache/ms-playwright`; each tool has `browser-check.sh [outdir]` (375 px touch + 1280 px, light + dark; random ports).
- Vault/records: index `~/eta-data/lab-vault/staged/index/view-*.jsonl`, records resolved against `~/eta-data/hist-mining`, `~/eta-data/hist`, `~/eta-data/lab-vault/staged`; 337b translations `.../staged/annotations/translation/*/*/*.json` (items {k,i,en,q}).

## (d) Rules never to break (verbatim where they exist)
- "Fable publishes and seeds — I never publish, seed the live db, or republish myself." Ruling: "do NOT republish; Fable publishes." Lab-viewer loads seeds into eta-lab-ratings (his loader refuses to replace a seed).
- Ruling 359 (rating write path): "Rolling out without a nod is a slip: next time wait." Away order (~08:50, holds until "FABLE BACK"): nothing to production; a new decision => take the SAFER option, post "provisional, pending Fable: ...", move on; refuter PASS before anything lands on eta-lab main.
- Memory rule: **Shared checkout push risk**: "never push HEAD from the shared checkout; cherry-pick the conductor commit in a temp worktree and push from there" (`git fetch; git worktree add --detach $W origin/main; cherry-pick $C; push origin HEAD:main`; retry up to 5; only `git add` my own paths; never delete/overwrite other panes' untracked files).
- Memory rule: **pkill/pgrep -f kills own shell** (exit 144/255): use the `[x]` trick or PIDs.
- Memory rule: **Wait for Fable's ruling** (261): do not adopt a gate/definition/scope change while a ruling is pending; recommend, wait, pre-register. **Review before run** (gate/verify code gets refuter-2's PASS before it runs on real data). **Never run fable-inbox.sh** (advances Fable's read cursor). **Shared write-once paths**: never write where another pane owns/is about to write.
- Blinding: pages read docs through a WHITELIST of fields (hidden keys/tiers/engines/flags never reach the DOM; mocks carry hidden fields to prove it); hidden keys stay in private key.json; fixed hashed order; seeds never in git; no patient text in git or on the bus; no secrets (I never held the vault read key and never read ~/.claude/secrets).
- Lab viewer CSP for anything served there: `default-src 'none'; script/style nonce; connect-src 'self'`: no fonts, no inline style attributes, no innerHTML with data.
- Pronouns: they/them unless stated.

## (e) Tools
`mcp__eta-bus__bus_post` (subject <= 120 chars; `to` is an array), `bus_inbox`, `bus_thread` (needs thread_id); git; python3; node + playwright; ffmpeg; `ToolSearch select:mcp__eta-bus__bus_post` if the schema is deferred. Reference CLIs of others: `kit/lab-viewer/tools/rate_seed.py` (lab-viewer's loader/export), `check_seed.py` in each of my tools.

## (f) Last 10 decisions (bus)
1. Built the 20-excerpt readability page + seed (r337f), #1919/#1930. 2. Built the 200-row label page before the host was chosen, #1944 (split-speaker confirmed same 200 ids, #1971). 3. r349: offered reuse; wrote `rate-ui.js` (#2018); lab-viewer shipped my old pages via a shim instead (#2024/#2029), kept answer format. 4. rate20 timing: hold past 14:30, load 15:00 latest, #2298 (accepted #2302, r390). 5. Built ba106 A/B page as files only, parked, #2137/#2144; answers exactly A_better|B_better|same|neither_readable|unsure; `--identical-controls 10`, #2158; live per r375. 6. Pinned the 20 excerpts (no re-sampling) and rebuilt with English via add_english.py: seed2, #2380; lab-viewer loaded it, refuter-2 PASS #2382. 7. Away order provisional record, #2069. 8. Recommended English-before-load (#2027). 9. Did NOT run fleet_watch.py (#2499). 10. No reply to unrelated boards.

## (g) First thing when you wake on OpenCode
1. `bus_inbox`; read only messages addressed to surg-page. 2. Ask conductor whether Fable's browser check on the three rating sets happened and whether the fourth set / chain-check / doctor-voice-check batch 2 need anything. 3. Verify seed shas above still match before touching a seed (never rebuild into an existing seed folder). 4. Do not publish, load or republish anything; stay in the files-and-seed lane. 5. Report to `conductor`.
