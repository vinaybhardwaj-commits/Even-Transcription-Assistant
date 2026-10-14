# HANDOVER conductor (Claude Code pane -> OpenCode, Fable 432) — written 26 Sep 2026 ~11:15 box clock

## (a) Role
Bookkeeping plan tracker on the box pane. I NEVER order, make engineering calls or give verdicts. Spec: orders/CONDUCTOR.md (+ orders/STATE-OF-PLAY-24-SEP.md). I ran it as `/loop 15m` (a session cron that dies with this session: the successor must re-arm it). Each cycle: read bus_inbox; update board/BOARD.md + board/DIGEST.md from evidence; push only board commits from a temp worktree off origin/main; relay Fable-relevant items to the Mini's bus/for-fable.jsonl; ack only after push+relay succeed; deliver Fable's rulings verbatim to owners (bus_post, wake:true, subject <=120 chars; ./hsend.sh where needed); hourly NIGHT board to ["all"] + a digest block (newest on top); keep the numbered FOR FABLE list (items 1-164 now); flag long-waiting items. Fable's clock runs ~30 min ahead of the box clock; my times are box clock.

## (b) Open items (bus ids; all Fable/V/owner decisions, I only track)
- OWED BY ME: (1) board Fable 432 (Claude Max nearly exhausted; all 12 Claude panes move to OpenCode by 12:15) and each HANDOVER post; (2) NIGHT 12:00 board + 11:00-12:00 digest block (draft points below); (3) re-arm the 15-minute cycle after the switch.
- 150 further c3 candidates; 151 room auto-start (V's decision); 153 hf-2 secret waits on the per-Space start.sh fingerprint fix; 154 DIAG-RIG spec questions (Kanglish etc.) + ElevenLabs key 401 (V re-checks); 155 VJ arm-4 shim credential + Vertex version id; 157 V re-runs the 337b command; 158 cap dir mode (linker already set 0710; ruling stands) + c3 read-only mount persistence; 159 V runs the three identity apply scripts (dry-run first, hash pinned; eta-refuter live checks after); 160 fleet's FREE MODEL SEEN alert (awaits Fable; #3477); 161 ceiling audio route (OpenRouter balance vs a Vertex wrapper); 162 CAP-1: bundle v2 posted (#3519/#3522: 27 of 183 linked, false-link 4.2%), needs refuter-2's review, cap HELD, report due 20:00 at risk; 164 hsend 5c59eef PASSED for the Mini (#3518), merge + box herdr machine add are Fable's; 137 VJ scoring venue.
- CLOSED this stretch (do not reopen): 92 (Zen +$200), 135, 146, 148, 149, 156, 163 (free-model window: LOW, no rotation, #3515/#3517).
- Room alerts open (fleet owns): OPD 4 DEVICE_MISSING 11:01, PIECES_STALLED + NOT_DELIVERING 11:11; ORB3 KIOSK_OFFLINE 11:06.
- label200 (427L): lab-viewer no step-0 yet; 2 h target ~11:50 at risk. PARITY-389: fleet's GO ~21:15-21:30 carries the six hashes; hard stop 27 Sep 07:25-07:30, cap $10, nothing has ever run on the Mini.
- Box memory ~87%: idle-pane list posted to Fable (430(3)); nothing is stopped before his word (Fable 432 now shrinks the Claude panes anyway).

## (c) Paths, shas, state
- Board trio: board/BOARD.md, board/DIGEST.md, board/OPENCODE-INVENTORY.md (I own all three; the shared checkout holds them modified, that is expected). Last board push: babd0ff on main (all handled bus ids acked through #3522).
- Scratchpad (session-scoped, may be gone): board scripts bNNNNN.py, esc_NNNNN.jsonl relay lines, night*.txt. Recreate as needed.
- Push loop: `git fetch origin main` -> `git worktree prune` -> temp worktree (detached, off origin/main) -> copy the board trio in -> commit -> `git push origin HEAD:main`, retry up to 3 times on a fast-forward race. NEVER push HEAD from the shared checkout. The shared checkout /home/eta/dev/eta-lab is FROZEN until 27 Sep 07:30 (no pull, stash, checkout or reset by anyone; my decision, on the board).
- Relay: `cat esc.jsonl | ssh mini 'cat >> ~/dev/eta-lab/bus/for-fable.jsonl'`; one JSON line {"ts","agent":"conductor","state":"needs-fable","summary"} per item, summary <=262 chars (assert it BEFORE any write); only after the push succeeded. Ack in a separate call afterwards.
- No PIDs, no daemons, nothing of mine running except that session cron.

## (d) Never-do list
- Never restart, kill or spawn panes. Never edit other panes' or Fable's files. Never edit the ledger. Never contact V. Never run kit/fable-inbox.sh (advances Fable's read cursor; use tail on for-fable.jsonl). No `pkill -f` / `pgrep -f` in the same Bash call (kills the harness shell).
- Nothing goes to production without Fable (FABLE AWAY ORDER); the safer or undoable option wins. Do not adopt a gate/definition/scope change while a ruling is pending: recommend, wait, then record.
- Gate/verify code needs a refuter PASS before it runs on real data; new bytes = new review.
- Keep OFF the board and pane traffic: patient/transcript text, secrets, V's email, tailnet/GCP/Mini/box IPs, hostnames and herdr machine ids, billing/account ids, the HF account handle, presigned links, full token hashes (prefixes only), doctor first names, key file names/paths (delivered text redacts them and says so).
- Standing rule (Fable 428b/430b): before any agent on a non-box machine touches PHI, its first check is that the TUI model line names the intended paid model; a free-model fallback means stop.
- OpenCode has no permission classifier: obey kit SECURITY-RULES (no writes to authorized_keys, ssh config, known_hosts, cron/launchd/systemd units or secrets; no key copying).

## (e) Tools
mcp eta-bus (bus_inbox, bus_ack, bus_post, bus_thread, bus_roster); `ssh mini`; ./hsend.sh (from the box it cannot reach Mini agents; c3 panes only via `ssh mini "herdr --machine <id> agent prompt ..."`, a disclosed hand-typed use at 10:45); git worktrees; python board scripts.

## (f) Last 10 decisions
1 Withdrew my note that HF Spaces are not herdr machines (#3487). 2 Withdrew the '2 golden records' line. 3 Corrected NIGHT 11:00 (81207f53 PASS had landed, #3496). 4 Moved mb-rx out of the idle list after his correction. 5 Froze the shared checkout to 27 Sep 07:30. 6 Verified main = runner 9d5e4210 after the PARITY-389 revert (item 156 closed). 7 Boarded item 163 closed on fleet's count-only screens, then refuter-2's LOW verdict (#3517). 8 Relayed hsend 5c59eef PASS + the box machine-add ask (item 164). 9 Boarded bundle v2 as a repost-aware single bundle (#3519/#3522). 10 Kept ids, paths, hashes and hostnames off the board.

## (g) Checks I owe others
- Fable: relay every Fable-relevant item as it arrives; NIGHT board hourly. Owners: verbatim delivery of new rulings. Deliver Fable 432's model map to nobody (he runs the switch).

## (h) First thing when you wake on OpenCode
1. bus_inbox (unread), read orders/CONDUCTOR.md + this file. 2. Confirm `ssh mini` works. 3. Board Fable 432 + the HANDOVER posts; post NIGHT 12:00 (points: identity scripts / V runs, bundle v2 review, label200 ~11:50 miss?, box memory + the Claude-to-OpenCode switch, PARITY-389 GO readiness, rulings received) and the 11:00-12:00 digest block. 4. Re-arm the 15-minute cycle. 5. Correct any wrong line on the board at once and say so.
