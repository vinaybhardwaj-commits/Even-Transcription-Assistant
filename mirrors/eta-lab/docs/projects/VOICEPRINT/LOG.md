# LOG — VOICEPRINT (doctor identity by voice)

Build and event log, newest first. Owner panes: vj-data, vj-arms, vj-link (builders); vj-refuter (truth custodian).

28 Sep ~19:5x-20:4x -- CENTROID-MINT design started; write-scope gap confirmed to block end_day too
Session: vj-refuter, minibot.
New design thread generalising W51/W52's voice-matching into a repeatable centroid-minting process for other doctors: same-room/same-time staff guards (e.g. OPD7 has different doctors AM vs PM), a minimum-sessions gate, schedule used as a prior only. Still in design, no centroid minted. Separately: minibot confirms the MCP write-scope gap (previously scoped to self_test, see RECORDER) also blocks end_day -- broader operational impact than first understood.
Refs: #5576-5591, #5591.

## 28 Sep ~13:2x-15:2x -- W52 first cut FROZEN + VERIFIED; privacy catch resolved
Session: reb, vj-refuter, lx, linker, eta-refuter-3, diar-lab.
See projects/MANOJ-PACKAGE/LOG.md for full detail. Headline: D1-D3 correctness fixes (stale WEAK tier, tape-gap rule relaxed for routine rotation gaps); eta-refuter-3 caught a real scope problem (NOT-IN-OPD4-7 clips likely contain other patients' real consults) -- 11 confident-absent clips pulled from the package, 33 thin-audio held as NOT-SCANNED; cut1 frozen (381 files, e8ffafb7...) and vj-refuter-verified 26/26. Ready for Fable to pull.
Refs: #5323-5331, #5358-5420.

## 28 Sep -- W51/W52 (Dr Manoj Kumar S) now the project's live work
Session: lx, vj-refuter, linker, reb, hf-fleet.
See dedicated logs: projects/MANOJ-PACKAGE/LOG.md (W52, urgent, V priority) and projects/MANOJ-VOICE-STUDY/LOG.md (W51, formal study, paused). Arm 4 (Gemini/Vertex) status not mentioned in today's bus range -- carried forward UNVERIFIED.
Refs: see MANOJ-PACKAGE and MANOJ-VOICE-STUDY logs.

## 26 Sep ~17:2x IST — 4th seal blob ruled IN; mirror 19:30; v3 verify tomorrow
Session: vj-refuter (PONG, fresh session 459.4), lab-mover (mirror).
vj-refuter ruled INCLUDE the 4th sealed file (wis-labels-V-20260926.json.gpg, a48c00b2…) in tonight's mirror — same rules as the original 3 (sealed blob only, key never travels). Self-confirmed v3 from git: commit 2593ffec still on origin/herdr-kit/vj-seal-decrypt-v3 (NOT origin/main — install is V's one-liner off the installer); installer sha 724e474b, wrapper sha 211a0552, 2-line delta vs v2. Verifies tomorrow after V --apply (sha/mode/owner/bash -n + behaviour), and re-checks all three vj-* configs at relaunch (448). Bus identity resolves again (was unknown_agent at #3731).
Refs: #3756, #3757, #3760, #3764.

## 26 Sep ~16:2x IST — 19:30 seal mirror: 3 or 4 blobs?
Session: lab-mover (pre-flight).
Mirror pre-flight OK (mini-legacy read-only, Air Drive 1.6 Ti free, sealed shas confirmed). But `~/eta-data/vj-truth-sealed` now holds a 4th blob (wis-labels-V-20260926.json.gpg, Fable-r422 artifact, ingested 05:08 today) + empty incoming/. vj-refuter's YES covered the original 3 only. Include the 4th (sealed blob, key never travels) or strictly 3? lab-mover mirrors whichever list vj-refuter/Fable confirms.
Refs: #3730, #3731.

## 26 Sep ~18:00 IST — vj-seal-decrypt v3 PASS; V may install
Session: eta-refuter-2 (checker); herdr-kit (owner).
v3 (commit 2593ffec; installer sha 724e474b, wrapper sha 211a0552) PASS — the v2 name-check defect fixed with a 2-line delta and verified behaviorally (foo.gpg/a.gpg accepted, traversal names refused). Installer scoped to kit/vj-seal-decrypt-apply.sh only.
Refs: #3697.

## 26 Sep ~17:40 IST — vj-seal-decrypt v2 FAIL (dead-on-arrival)
Session: eta-refuter-2 (checker); herdr-kit (owner).
The VJ seal-decrypt wrapper v2 (sha 181de4cd) fails the name check on EVERY input (a regex that refuses all non-empty names) — fail-closed, no security exposure, but it can never decrypt. One-line fix owed by herdr-kit; refuter-2 re-reviews the delta. Key handling + outdir confinement + vj-* builder refusal all verified good.
Refs: #3692.

## 26 Sep ~16:00 IST — seal-decrypt wrapper option (a) adopted
Session: Fable (r448).
VJ final scoring/ingest waits for the ~/bin/vj-seal-decrypt wrapper (reads the key itself, refuses outdir outside the seal, never prints the key); eta-refuter-2 reviews it. Supersedes the Claude-Code option (no Claude work til Tue 29 Sep).
Refs: FABLE 448, #3642.

## 26 Sep 09:08 IST — J-005 / J-006 cards done
Session: vj-data (J-005 top-ups) + vj-arms (J-006 arms 2+3).
20 top-up cards passed by vj-refuter; arms 2 and 3 Jev-scored with 20+20 rows append-only.
Refs: #3360, #3364.

## 26 Sep 05:10 IST — truth sealed
Session: vj-data + vj-refuter.
V's human "who is speaking" truth ingested + encrypted into sealed vault `~/eta-data/vj-truth-sealed` (r422). Only vj-refuter may see it.
Refs: #3260, r422.

## 26 Sep — arm 4 blocked on Vertex credential
Session: vj-arms.
Arm 4 (Gemini audio on Vertex AI) waits on V deploying the gcloud shim be2b6682 + temporary credentials (r425.5). vj-arms requested voluntary close to save Zen.
Refs: #3340, #3359, #3444.

## 24 Sep — blinding + centroid controls
Session: vj-data + vj-refuter.
Blinding architecture (unix user `vjscore`, mode-700 vault) r168. Centroid positive control 0.74-0.86, negative <0.40 (r182/186). 90-item "Who is speaking" page + 20 top-ups (r206/231/241/251).
Refs: r168, r182, r186, r206.

## Open
Final scoring venue (item 137); Phase L doctor-centroid minting waits on V rating Batches 1b + 2.

- 29 Sep 2026 (rev 25): auto-minting PASS for Manoj 0.844, Salanki 0.9266, Animesh 0.8316 (each reproduced by two checkers); Ankit and Poornima running; 65 doctors indexed, 569 consults with room audio; W51 v3.1 re-review pending.
- 29 Sep ~19:27 IST (rev 26): 47 proposal jobs on HF L4 due ~21:30-22:00; old DVC retired (#7010); A4 v10 7d8bd212; ROLE v4 waits on V.
