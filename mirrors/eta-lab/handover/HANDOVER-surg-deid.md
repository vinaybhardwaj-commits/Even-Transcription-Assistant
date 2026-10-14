# HANDOVER surg-deid (Claude Code pane -> OpenCode, r432) — written 26 Sep 2026 ~11:20 IST

## (a) Role
Builder on the box. Owner of the local de-identification redactor for the surgery-review-v2 / link-3 paths: `studies/2026-09-24-surgery-review-v2/deid.py` (+ deid_gpu.py, deid_eval.py, tests, dob_count.py, addendum). The redactor is FROZEN on main; my job now is only: (1) fix it if a name-leak gate fails, (2) regenerate de-id sets when Fable orders, (3) answer de-id questions. No patient text anywhere in git or on the bus. Ids only.
My bus tools have been DISCONNECTED since ~16:13 25 Sep (Mini power loss / box OOM); I read boards only as pasted mirrors and posted nothing after #2609. herdr-kit reconnects (/mcp -> eta-bus -> Reconnect). Do not restart the pane yourself (r412.1).

## (b) Open items (bus ids, state)
1. FROZEN SUCCESSOR (done, verified by refuter-2 #1978/#1989): redactor 707a113 (one commit, 3 files), gate 9b20caf (fleet), addendum 7590807 (docs, ids only). deid.py git blob b8b793507a566fc116fd3058e95a7c5dbbc115a0, sha256 bc375f78d4f0e1bef4965fee4570e50f506003e1605a1ebbd338f8ac44678f02; test_deid_dob_partial.py blob 48d2793468572ad253e99e010fcd84b4eb51312e; deid_eval.py blob 72deb477d9a19f6fe59a6a8a0489bbb11fd57655. Predecessor (cap rule, a53717d lineage): blob 5527f92082bc4403dad20949b69e82774a8b28b2, sha256 f092bf43…; now REFUSED by the gate. r332 handling slip recorded (real-text-derived probe string was in private branches/bus; not a disclosure outside Even).
2. 84 cap-rule-only surgery files (final-v5fresh 56, v5delta 15, v5rater 13) are REFUSED by the gate until regenerated with the successor. Regeneration is FABLE'S order only (r307/r316). If ordered: deid_gpu.py --cap-rule with deid.py b8b79350 from the box export (see c); post the hash + counts BEFORE anyone reads (as for every earlier regeneration); fleet's gate then passes them.
3. dob_count.py (counts-only sizing tool): branch surg-deid/dob-partial, commits 28fc110, c019148, 221062b, 9bf900d (blob e28ef352…, test blob 1686c0c0…), refuter-2 PASS #1698. NOT on main. Its one real-text run needs the conductor's daylight go AND the frozen successor blob beside it; report COUNTS only; compare turns_in_scope with 9,404 / 2,421 / 1,724. Landing it is a separate step (must not ride with the redactor commit). Parked on Fable's list.
4. c015|l3-c015-r2|10 and 20 sent v5 surgery turns with a day-month shape are UNCLASSIFIED (r306; V/Sandhya classify from box-only sheets). If they classify a miss: the reader tells me ONLY the form, the cue-word class and the character distance; a widening of the rules is a fresh review, new blob, new gate constant.
5. LINK-3 T9 name-leak read (linker-oc / refuter-2): the T9 de-id was proven by refuter-2's independent re-run (#2652: same output sha c2841b20a2c5eb6c, 463 turns, 95 redactions). refuter-2's blind read of the 277-turn draw was LOCKED with a salted pin (conductor 16:00). Second reader = linker, waits on Fable's DIGEST item 76. I do not know the result. IF THE GATE FAILS: fix the redactor (new review, new blob, new gate constant), regenerate deid.json, then a NEW full read into a new out dir (link3_nameleak.py docstring). Nothing of mine is pending until that.
6. Optional, not landed: branch surg-deid/recall-sampler @ 2aa9b24 (deid_recall.py + test; refuter PASS). Procedure-word whitelist waits on fleet's lexicon (open since the cap-rule work).
7. Real-text recall on turns that contain identifiers is only measured on small samples (11/11 names on 119 LINK3 r2 turns; deid_eval on invented text: 48 planted, 3 known Indic-script misses). Say so whenever a recall claim is made.

## (c) Paths, shas, pids
- Nothing of mine is running: no daemons, no cron, no background jobs, no pids owned.
- Successor export (read-only, verified): ~/eta-data/deid/successor-b8b79350/ (git archive of the study dir from origin/main; deid.py blob b8b79350, sha256 bc375f78…). Do NOT use ~/dev/eta-lab's shared checkout for deid.py: its HEAD is behind origin/main (old deid.py without cap_rule).
- Driver (box only, NOT in git): ~/eta-data/deid/drivers/deid_b3_driver.py, sha256 2828186e106532ff19cbb89b70d27321eab675fd11f8b5d12678b2ad03289d07 (per-record CLI logic, roster OFF, cap_rule=True, nonlatin omit). Usage: driver.py <in.json> <out.json> off. Reads `en`, writes `en_deid`, O_EXCL 0600, prints counts only.
- REFUTER-ACCEPTED RUN LINE (#2609, accepted #2612), from inside the export dir: OMP_NUM_THREADS=4 HF_HUB_OFFLINE=1 nice -n 15 ~/eta-data/deid/venv/bin/python -B -c "import sys,hashlib,runpy; sys.path.insert(0,'/home/eta/eta-data/deid/successor-b8b79350'); import deid; h=hashlib.sha256(open(deid.__file__,'rb').read()).hexdigest(); print('loaded',deid.__file__,h[:16]); assert h=='bc375f78d4f0e1bef4965fee4570e50f506003e1605a1ebbd338f8ac44678f02'; sys.argv=['deid_b3_driver.py','<IN>','<OUT>','off']; runpy.run_path('/home/eta/eta-data/deid/drivers/deid_b3_driver.py',run_name='__main__')"
  Post: the 'loaded ... bc375f78' line, the counts line, the output sha256. No text.
- Venvs: ~/eta-data/deid/venv (CPU), venv-gpu; model urchade/gliner_multi_pii-v1 @1fcf13e8, HF offline. Roster/variants files (doctors.json, epi-roster-names.txt, doctor-variants.txt) live in ~/eta-data/deid/ and NEVER go to git.
- Box data (never git): ~/eta-data/surgical-chain/p1/mt*/{translated,deid}.json (batches 1-3, mt-337b for T9); ~/eta-data/surgery-review-v3/surgery_sent_turn_keys.json (fleet's sent keys, needed by dob_count SENT mode).
- Branches (private, kept): surg-deid/dob-partial (old blob 0e55dc0f and the dob_count commits; contains the real-text-derived probe string: NEVER merge to main), surg-deid/dob-partial-b (d1e957b, the landed content), surg-deid/successor-addendum (draft commits hold a quoted example: NEVER merge; the clean addendum is on main as 7590807), surg-deid/recall-sampler.
- Scratch worktrees are under my session scratchpad in /tmp/claude-1000/...; they may vanish. Nothing uncommitted of mine is in the shared checkout (its many modified files belong to other panes).

## (d) Rules I must never break
- No patient text in git, on the bus, in logs or in example strings. Every test/eval/comment string must be INVENTED by me, never copied from a peer's "invented" probe (that was the r332 slip; memory: probe-string-provenance).
- r297(a): review first, then run: no script version touches real text before its refuter PASS is on the bus. r297b: pins before reads.
- Frozen blobs: do not edit deid.py, tests or the gate constant without a new review, a new blob AND a new gate constant (fleet) posted first.
- r135: never push from the shared checkout; temp worktree off origin/main, `git log origin/main..HEAD` = only my commits, verify blobs, then push; if rejected re-fetch, re-pick, re-verify.
- No deletes without Fable naming them. Old branches kept (r332).
- Roster whitelist stays OFF on link-3 paths (ruling 299 / R2 definition: any readable name of a person, whatever the role); own-doctor bare-surname keep exists only when a turn's `doctor` field is set.
- Never run fable-inbox.sh (advances Fable's read cursor). Bus subjects <= 120 chars; no patient text in bus bodies.
- Nothing to production; nothing on real text without a named go (dob_count run needs the conductor's daylight go).
- Report what I did not verify; correct wrong claims on the bus at once (I retracted five in this session).

## (e) Tools
mcp__eta-bus (bus_post, bus_inbox, bus_thread); git in temp worktrees; the box venvs above; deid_eval.py (invented text; model on) with test_deid_dob_partial, test_deid_cap_rule, test_deid_cli (run with nice 15). OpenCode successor: use the same run line; keep OMP_NUM_THREADS=4 and nice 15 (r225).

## (f) Last 10 decisions (bus ids)
1 #1786/#1792/#1797 the "invented probe string" claim was WRONG (linker #1788, refuter-2 #1789): corrected in the addendum and disclosed. 2 #1795/#1800 built option B candidate d1e957b (code AST-identical, strings replaced); eval equal to the frozen numbers. 3 ruling 332 option B; #1817/#1827 landed as ONE squashed commit so the old string stays out of main history. 4 #1967 landed 707a113 08:30:07 IST 25 Sep; refuter-2 #1978 confirmed. 5 #1982 addendum 7590807 as one clean commit (drafts kept off main). 6 fleet 9b20caf gate REPLACE, refuter-2 #1989: freeze complete. 7 #2590 gave linker-oc the driver invocation + nameleak pin usage; no reader role for me. 8 #2609 corrected the run line (script dir, not cwd, is on sys.path; venv python; sha-asserting wrapper), tested on invented text; refuter-2 accepted #2612. 9 Stayed off real text and off the second-reader role throughout T9. 10 After the bus dropped (r412.1) I did nothing but read boards; verified the driver and export hashes intact after the outage.

## (g) First thing when you wake on OpenCode
1. Reconnect check: call bus_inbox. If the bus errors, hsend herdr-kit; do not restart.
2. Verify main is unchanged: `git rev-parse origin/main:studies/2026-09-24-surgery-review-v2/deid.py` must print b8b793507a566fc116fd3058e95a7c5dbbc115a0; `sha256sum ~/eta-data/deid/successor-b8b79350/deid.py` starts bc375f78d4f0e1be; the driver sha256 starts 2828186e.
3. Read the rulings after 416 for anything about de-id, the T9 name-leak result (linker/refuter-2, item 76) and the 84-file regeneration. Do nothing else until one of those or a routed question needs you.
4. Post one line on the bus that surg-deid is back on OpenCode with the blobs above, so the conductor's board stays complete.
