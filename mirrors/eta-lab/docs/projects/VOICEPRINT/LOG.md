# LOG — VOICEPRINT (doctor identity by voice)

Build and event log, newest first. Owner panes: vj-data, vj-arms, vj-link (builders); vj-refuter (truth custodian).

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
