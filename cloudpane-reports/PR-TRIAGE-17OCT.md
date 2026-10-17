# PR triage, 17 Oct 2026 (cloud-pr-triage)

Base `origin/main` @ `40df6eda`. Read-only review; no PR was merged, closed, commented on or pushed to.
Merge check: `git merge-tree --write-tree origin/main pr-<n>`. Scrub: `scripts/steward/scrub.sh origin/main..pr-<n>` from a main worktree with gitleaks 8.30.1 (the CI pin); rule ids and paths only.
Data check: own counter for public/tailnet/LAN IPv4, `.ts.net`/`.local` hosts, emails, Indian phone shapes and PHI-keyed JSON values, then a shape classifier on each hit (values never printed).

| PR | Title (short) | Needed? | Clean? | Scrub rc | Tests | Rec | Reason |
|---|---|---|---|---|---|---|---|
| #2 | RCA 15 Sep fleet start_day FD leak | No | No (unrelated histories) | 1 (n1) | n/a (doc) | CLOSE | Fix landed as `0803d519`, `c4a02896`; branch has no merge base with main |
| #8 | fix CI: lockfile + committed vitest | No | No (unrelated histories) | 1 (n1) | n/a | CLOSE | Superseded by CI gate `836069a5` (ephemeral vitest@2); no merge base |
| #14 | Flag digital capture silence | No | No: 3 files | 0 | 4 files, 106/106 pass | CLOSE | Same commit subject merged as `246faa41` via PR #15 (`521b5488`) |
| #25 | fold even-jev-mcp + herdr-fleet | Yes | No: `tsconfig.json` | 1 (n2) | jev validate 42/42 pass; herdr smoke env-bound (no ssh) | MERGE-AFTER-FIX | Resolve tsconfig exclude; drop or allow `dist/server.js`; allowlist test PEM header |
| #80 | scrub: env-secret-assign ignores regex ctors | Yes | Yes | 0 | scrub fixtures 54/54 pass (main 53/53) | MERGE | `re.compile(`/`RegExp(` not in main's `.gitleaks.toml` |
| #85 | pulse-presence: redact host/IP in install.sh | Yes | Yes | 0 | n/a (comment) | MERGE | Main's `install.sh` usage comment still carries an IPv4 |
| #101 | pulse-watch: TRACKER signed out HH:MM | Yes | No: `tools/pulse-watch/watch.mjs` | 1 (n3) | pulse-watch 27/27 pass; bus unit 74/76 (n4) | MERGE-AFTER-FIX | Resolve watch.mjs; replace public IP (n5); allowlist 4 false positives |
| #107 | orbox-lab O19 mcrec + O20 .work cleanup | Yes | Yes | 0 | pytest 15/15 + 5/5 pass | MERGE | `orb3-multichan/` absent on main; 4 unique patches (`git cherry`) |
| #110 | import services/eta-router | Yes | Yes | 0 | pytest 123 pass, 2 skip | MERGE | New dir; tests need fastapi, python-multipart (not declared, n6) |
| #111 | import services/eta-indic | Yes | Yes | 0 | py_compile ok (no tests) | MERGE | New dir, data scan clean |
| #112 | import services/eta-stt-relay | Yes | Yes | 0 | `node --check` ok, package.json parses | MERGE | New dir, data scan clean |
| #113 | import services/eta-emotion | Yes | Yes | 0 | py_compile ok (no tests) | MERGE | New dir, data scan clean |
| #114 | import tools/eta-consult-steward | Yes | Yes | 0 | pytest 78/78 pass (boto3 installed) | MERGE | Email/phone hits are synthetic PHI-detector test inputs |
| #115 | import tools/eta-consult-room-audio-state | Yes | Yes | 0 | pytest 160 pass, 12 skip | MERGE | `kh_real_*` fixtures hold room and USB device names only (n7) |
| #116 | import tools/eta-fleet-tools | Yes | Yes | 0 | sh: 120 pass / 73 fail, kh-rollout needs binary | MERGE | Failures are macOS-only tooling on Linux (UNPROVEN, n8); hosts are `.invalid` |
| #117 | import tools/router-fix | Yes | Yes | 0 | pytest 393 pass; 5 files env-bound (n9) | MERGE | New dir, data scan clean |
| #118 | import tools/eta-presence-guard | Yes | Yes | 0 | test.sh timeout, test-steward needs swiftc | NEEDS-OWNER (consult lead) | Unproven on Linux; confirm the one `.local` host in `test-steward.sh` is a placeholder |
| #122 | docs(graph): code graph @2a757a9 | Yes, stale | Yes | 0 | index.html parses | MERGE | Newer than main's `@a4338ed`; already 128 commits behind, regenerate next pass |
| #138 | board mic guard, stacked on #101 | Yes | No: `tools/pulse-watch/watch.mjs` | 1 (n3) | pulse-watch 39/39 pass incl. micguard 12/12; bus unit 74/76 (n4) | MERGE-AFTER-FIX | Land after #101 with the same fixes; MIC-cell mic_guard not in main's watch.mjs (PR #137 covered rooms-live only) |

Totals: 19 PRs. MERGE 12, MERGE-AFTER-FIX 3 (#25, #101, #138), CLOSE 3 (#2, #8, #14), NEEDS-OWNER 1 (#118). Scrub rc 0 on 14, rc 1 on 5.

Notes
1. #2 and #8 share no history with main, so the scrub ran over each branch's whole history: env-secret-assign x3 (`brain/README-DEPLOY.md`, `docs/ETA-V2.1-MAC-MINI-PYANNOTE-SETUP.md`), generic-api-key x5 (`app/api/admin/admins/seed-team/route.ts`, `fixtures/warehouse/synthetic-19-aug.json`, `lib/doctor-slug.ts`). Not triaged further because both should close. #2's RCA doc `docs/handoff/ETA-RCA-SCRIBE-FLEET-START-15-SEP-2026.md` (195 lines) is not on main; the owner can re-land it alone on a fresh branch if the record is wanted.
2. #25 hits: deny-large-file `tools/even-jev-mcp/dist/server.js` (1.4 MB esbuild bundle; `npm run build` reproduces it byte-identical, so it can be built at install instead of committed), private-key-header `tools/even-jev-mcp/test/guard.test.ts:29` (a truncated PEM header used as a detector test input). The only conflict is the `exclude` list in `tsconfig.json`.
3. #101 and #138 hits: env-secret-assign `tools/fleet-kiosk/kh-rollout.sh:41` and `tools/fleet-kiosk/stage-r10b/kh-rollout.sh:41` (the variable holds a file path, not a secret; false positive), private-key-header `tools/eta-bus-mcp/test/unit.mjs:314,626` (detector test inputs). Add fingerprints to `steward/scrub-allow.txt`; the scrub runs with `--ignore-gitleaks-allow`, so inline comments will not clear these.
4. `tools/eta-bus-mcp/test/unit.mjs`: 2 failures, including `bus_post: "all" expands to every live agent except sender`. The likely cause is that the test reads the live agent list from the host, not checked further. Rerun on the Mini before merge.
5. `tools/fleet-kiosk/consult/export-windows.sh` (added in `bc48c2b7`, in both #101 and #138) holds a public IPv4 twice as a `user@host` SSH target. That IP appears nowhere on main. Replace it with a placeholder or an env var before merge. `tools/fleet-kiosk/hosts-opd.example` holds one documentation-range IP and one `user@` RFC1918 address, which is acceptable.
6. #110 and #117 tests import fastapi, requests and python-multipart, and #117 also imports `reb` from `mirrors/eta-lab/kit` (on main). Suggest a `requirements-test.txt` as a follow-up; this does not block a snapshot import.
7. #115 fixture key scan: `names` maps room ids to short room labels and `name`/`code_name` are USB audio device names. No patient, doctor, transcript or note fields.
8. #116 `test-flip-profile.sh` drives macOS tooling (14 references to plutil/defaults/osascript/launchctl and similar), and `test-kh-rollout.sh` needs a built `kiosk-health` binary. Both are UNPROVEN here, not failed. Run them on the Mini.
9. #117 env-bound files: `fuser/test_fuser_v0.py` and `fuserv2e` (need `REB_LIB_PATH` pointing to a git checkout under /tmp on the Mini), and `eval/*` (need the `heldout` module and `wordfreq`). All other dirs pass.
10. Unproven everywhere: repo gate (`npm run typecheck`, full `npm test`, `npm run build`, `swift build/test`) was not run per PR. Only #14 touches app code, and it is recommended for CLOSE.
