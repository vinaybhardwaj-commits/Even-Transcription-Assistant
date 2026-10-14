# HANDOVER: lab-viewer (Builder, was Claude Code Sonnet) — written 25 Sep ~15:55 IST (box clock), r409 wave 2

No patient text in this file. Bus ids are `#NNNN`. Times are box clock.

## (a) Role
I build and run three things for the eta-lab results vault (ruling 184, later 208/328/337a/341/349/359/373/375/379):
1. **eta-lab-ingest** (Cloudflare Worker, `kit/lab-vault/worker/`): the write-once ingest for R2 bucket `eta-lab-results`. Key kinds: `runs/`, `manifests/` (+ `.start`, `.addendum`), `index/`, `annotations/<kind>/` with kind in translation | readability | retranscription | correction | selftest | speaker, and `tapes/` (audio). Uploader + timers + index builder live in `kit/vault-push.py`, `kit/lab-vault/*`.
2. **eta-lab-viewer** (Worker, `kit/lab-viewer/`, behind Cloudflare Access at lab.llmvinayminihome.uk): Days, window page, Consult view per room per IST day (English under Indic lines from translation annotations), Runs, Search, and the three rating pages `/rate/label200`, `/rate/rate20`, `/rate/ba106` (writes only to bucket `eta-lab-ratings`).
3. Refuter for my work is **eta-refuter-2**: branch -> PASS -> main -> deploy.

## (b) Open items
- **Speaker letters in the consult**: design posted #2216 (chips only in windows with >= 2 labelled speakers, "—letters are local to this window—" divider, `?` no chip, mixed shows seq joined, no cross-window joins). NOT built. Waits for Fable saying "build speaker display" (conductor board "WAITING ON FABLE"). 3 speaker batches are already in the vault (diar-lab, refuter-2 PASS #2202/#2460/#2608).
- **Self-test filter (r369 item 4)**: grammar `annotations/selftest/` live (#2181). Viewer/builder do NOT read it. When wired: drop segments overlapping an interval +/- margin (radar-kit's FILTER_MARGIN_S = 5 s) or fuzzy-matching the canary, show one line "mic self-test", fail CLOSED (no times + possible room = dropped; match on vault room ids `room_xxxxxxxx`), filter upstream of every consumer (eta-refuter #2118). Needs radar-kit's interval log first.
- **Rating sets** label200 (200 rows), rate20 (seed2, 20 excerpts, English on 40 lines, sha prefix 3e83659314aa1779) and ba106 (106 A/B rows, 10 identical controls) are LOADED, refuter-2 PASS (#2046, #2184, #2382, #2082). Nobody has been told to label: **Fable's browser check first (r359)**. A fourth set (337c batch 2) waits for Fable's OK. Export of answers: `python3 kit/lab-viewer/tools/rate_seed.py export --set <set> --out <dir> --rater vinay=vinay.bhardwaj@even.in --rater sandhya=sandhya.cherukuri@even.in` (needs CLOUDFLARE_* env; labels go to split-speaker / indic-mt / surg-page, keys stay with them).
- **First-login watch of the 3 new viewers (r353)**: parked (#2187/#2190): option A = Audit Logs Read on V's Cloudflare token (tunnel-ops recommends), option B = a Worker log line with a fixed label per allowed address (I offered to build it; needs refuter-2 review + a test that the full address is never logged). Waits for Fable.
- **tapes/**: kind live (#2181, lab-mover uploads hourly at :25, refuter-2 PASS #2197). NO bucket lock rule and NOT in the 3-copy checker: Fable's policy calls (on his list).
- **HOLD-annotations**: no hold file exists now (released 11:46, r379). The uploader also supports `HOLD-annotations-<kind>` (per kind, merged) and `HOLD` (everything). Release rule: only on Fable's/conductor-relayed word.
- 3-copy checker `kit/lab-vault/check-copies.py` (07:30 timer) does not cover tapes/ or rate/ (ratings are in a different bucket).
- diar-lab pushes speaker docs from its own root; hist-bulk writes correction/retranscription files and addenda (`provenance_complete_override`, `unverified_leaves`); linker's 337b translation files (1,504+, all PASS #2538). Nothing pending on me for these.

## (c) Paths, branches, pinned shas, pids
- Repo: eta-lab (origin/main). Last viewer/ingest code commit on main at handover: `9a7a951` (unverified-leaf). Deployed: **viewer version c3911185**, **ingest version 57019710**, inventory Worker 67f546fe (read-only lists; prefixes runs/ manifests/ index/ annotations/). Earlier: ratings bucket move `96c5b76`, per-kind hold merged.
- Deploy: from `kit/lab-viewer` or `kit/lab-vault` (own wrangler.jsonc each): `CLOUDFLARE_API_TOKEN="$(cat ~/.claude/secrets/cloudflare_api_token)"` and `CLOUDFLARE_ACCOUNT_ID` in the environment (the id is NOT in the repo; `npx wrangler whoami` with the token shows it), then `npx wrangler deploy`. Secrets only via stdin: `printf %s "$VALUE" | npx wrangler secret put NAME` (never argv, never printed). Viewer secrets: ACCESS_AUD, ACCESS_TEAM_DOMAIN, ALLOWED_EMAILS (5 addresses, sha256 of the exact comma-joined string 41dff5bb28105b5d02ffafa3743b7a13147a62aec64577ecb9cc228bbcd2f4f3), RATERS (V + Sandhya). Ingest secret: INGEST_TOKEN (box file `~/.claude/secrets/lab_ingest`; inventory token `~/.claude/secrets/lab_inventory`).
- Bindings: viewer RESULTS=eta-lab-results (read only), AUDIO=eta-audio (read only), RATINGS=eta-lab-ratings (the only writes; keys `rate/<set>/<sha256(email)[:16]>.json`, `rate-history/...`, seeds `rate-seed/<set>.json`).
- Land code: temp worktree off origin/main in your own scratchpad, work on a branch `lab-viewer/<topic>`, push the branch, get eta-refuter-2's PASS on the bus, then `git cherry-pick` onto a detached origin/main worktree and `git fetch && git rebase origin/main && git push origin HEAD:main` in a retry loop; deploy after PASS. NEVER push HEAD from the shared checkout (memory rule). Do not push to main before a PASS (away order; I slipped on this several times today, recorded).
- Box state: `~/.local/state/lab-vault/{ledger.db, tapes-ledger.db, accepted-exceptions.json}`, staged files `~/eta-data/lab-vault/staged/{index,annotations,manifests,runs}`, installed scripts `~/.local/share/lab-vault/` (copy from repo after a merged change: `vault-push.py`, `build-index.py`, `check-copies.py`).
- **Background processes I own: none (no pids).** systemd USER timers (linger on): `lab-vault-push.timer` (15 min, uploader scan), `lab-vault-view.timer` (hourly :12, view index), `lab-vault-index.timer` (00:05, nightly windows-<date> index + push), `lab-vault-check.timer` (07:30, 3-copy check). Watch: `systemctl --user list-timers 'lab-vault-*'`; logs `journalctl --user -u lab-vault-push.service -n 30`; uploader state `python3 kit/vault-push.py --status`. Stop safely: `systemctl --user stop lab-vault-push.timer` (or create `~/.local/state/lab-vault/HOLD` to stop all pushes without stopping timers). Trigger a view build now: `systemctl --user start lab-vault-view.service`.
- Tests: `node --test kit/lab-viewer/test/viewer.test.js` (25), `node --test kit/lab-vault/test/ingest.test.js` (22), `python3 kit/lab-vault/test/test_build_index.py` (10), `test_vault_push.py` (9), `test_check_copies.py`, `test_make_annotation.py`, `python3 kit/lab-viewer/test/test_embed.py`.
- Real-browser checks: `kit/lab-viewer/tools/browser_smoke.mjs` (consult/window/days, real records + audio) and `rate_smoke.mjs` (rating pages); needs playwright-core + extracted libs, previously in the session scratchpad `browser/` dir (`PW_DIR=<dir>`, `LD_LIBRARY_PATH=<dir>/libs/usr/lib/x86_64-linux-gnu:...`, `SMOKE_INDEX_DIR=<dir>/idx` built by build-index.py `--view-only`); rebuild if that dir is gone (`npm i playwright-core`, `npx playwright-core install chromium` or extract chromium libs).
- Format docs: `kit/lab-vault/SCHEMA.md` (keys, annotation kinds, tapes). Rating page sources: surg-page's `tools/segment-label`, `tools/readability-rate`, `tools/pair-label`; embed with `python3 kit/lab-viewer/tools/embed_rate_pages.py` (generates `worker/rate_pages.js`; `--check` in tests).

## (d) Rules I must never break
- Secrets only in files or via `wrangler secret put` from stdin; never argv, never printed (r233).
- No production DB writes; do not touch the eta-audio bucket (read only) or the production audio-join Worker; nothing in the public ETA repo.
- Never push HEAD from the shared checkout; never run `kit/fable-inbox.sh` (advances Fable's cursor).
- No patient text on the bus or in git: counts, ids, hashes only. Bus subject <= 120 chars. Use eta-bus, not SendMessage. Avoid `pkill -f` in the same Bash call as the harness shell.
- Vault is WRITE-ONCE: same bytes = 200, different bytes = 409; a change is a new file. Annotation files must carry `sources` {k: sha256 of runs/<k>.json} (Worker checks); never weaken the checks; the annotation kind list is pinned by a test to exactly six (adding one needs a Fable ruling).
- Do not adopt scope/definition changes while a ruling is pending; wait for Fable (memory: "wait for Fable's ruling"). Rolling out without a nod is a slip (r359). Gate/verify code goes to refuter-2 and gets his PASS BEFORE it runs on real data or lands on main.
- The viewer has no route to tapes/ or rating seeds; keep it that way. RATERS = V + Sandhya only (r359/r375); ALLOWED_EMAILS list changes only by Fable ruling (a mistyped address is fixed only on a new ruling).
- Releasing an annotation hold: only on Fable's named word (r379 was one). Away order (Fable AWAY since ~08:50): nothing to production; provisional choices are posted to the conductor as "provisional, pending Fable".
- Speaker letters are WINDOW-LOCAL: never join a letter across windows (diar-lab, refuter-2).

## (e) Tools (names only)
eta-bus MCP: bus_inbox, bus_ack, bus_post, bus_thread (needs thread id), bus_roster. CLIs: git, gh, node (node --test), python3, npx wrangler (deploy, secret put, r2 object get/put/delete --remote, r2 bucket list), curl (unauthenticated checks only), systemctl --user, journalctl --user, sqlite3 via python, ssh to the box is local.

## (f) Last 10 decisions
1. Annotation kinds six + sha-bound grammar live: #2007 (ingest 3fd98452), #2181 (speaker strict shape, tapes/ kind, ingest 57019710).
2. Rating write path on the viewer: #2024, disclosed slip #2041, moved to own bucket eta-lab-ratings #2080 (PASS #2082).
3. ba106 third set live: #2173 (PASS #2184); rate20 seed2 loaded 12:38: #2381 (PASS #2382).
4. Annotation hold: released 09:00 (my miss), re-armed 11:34 #2257, released 11:46 on r379 #2274; per-kind hold branch merged #2261.
5. Consult overlap fix (one window per stretch, partial windows) #1990, PASS #2006.
6. Consult English fix: linker's q "ok" no flag + friendly reasons #2243 (PASS #2244), empty-English case #2247 (PASS #2258).
7. Provenance override reader (12 records) #2320, deployed #2348.
8. Unverified-leaf line #2394, deployed #2401 (PASS #2398).
9. Speaker-letters design parked until Fable says so: #2216. First-login watch parked: #2187 / #2190.
10. Standing plan on selftest wiring: #2119.

## (g) First thing on wake (OpenCode)
1. `bus_inbox`; ignore stale bus mirrors (many pasted copies of already-handled messages were injected today); ack what is handled.
2. `git fetch origin && git log --oneline origin/main -- kit/lab-viewer kit/lab-vault | head`; run the five test suites above; check `systemctl --user list-timers 'lab-vault-*'` and `python3 kit/vault-push.py --status` (pending 1 and rejected 1 predate today; investigate anything new).
3. Health of the live site: `curl -s -o /dev/null -w "%{http_code}" https://lab.llmvinayminihome.uk/rate/label200` must be 302 (Access), workers.dev host must be 404. Ingest health: `https://eta-lab-ingest.vinay-bhardwaj.workers.dev/v1/health`.
4. Check the conductor board / DIGEST "WAITING ON FABLE" for: "build speaker display", the rating-set browser check, the first-login watch, the fourth rating set, tapes/ lock. Do not act on those until a named Fable word arrives.
5. If asked to change the Workers: branch, tests + real-browser smoke, refuter-2 PASS, then main + deploy, then post version ids and shas on the bus.
