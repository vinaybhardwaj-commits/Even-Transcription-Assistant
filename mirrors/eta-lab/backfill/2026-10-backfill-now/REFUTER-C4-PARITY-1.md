# C4-PARITY-1 report (eta-refuter-2, 7 Oct 2026 ~18:45 IST; herdr-lead #9303; router-fix report C4-STACK-1 sha16 700bede0)
VERDICT: C4-PASS for the engine stack (byte-identical to c3, same outputs). Two hand-over items are NOT done yet, and backfill cannot use c4 until they are: H1 + H2 below.

## 1. Versions and shas (my own reads, c3 vs c4, same paths)
- router_server 400710ee, eta_number_words ccb1cc13, whisper-shim c24fd097: identical. ffmpeg e7e7fb30: identical (a real file on c4, a symlink on c3).
- Tree of 9 code/model/json files under ~eta/services (indic, sravaani, whisper, shim, router; venvs excluded): sha 9a77cefd on both. eta-router-s1 unit Environment/ExecStart: sha 1ea756b9 on both.
- c4 whisper: model 1fc70f774d38eb16, whisper-server dc5fe7d849522bcc, shim .c3-900s c2210237966f33b7 = the leaves of stack_versions.c3.json.
- stack_versions.c4.DRAFT.json (6d7fdf13) vs c3's: 65 leaves each; they differ only in collected_at, host, ports.whisper_shim (8081, correct) and revision_note.

## 2. ffmpeg / whisper backend (c4, from each running process's environment)
- All 6 user units are active: indic s0/s1, sravaani s0/s1, router s0/s1. Every one has PATH with /home/eta/services/bin/ffmpeg.
- Both routers have ETA_WHISPER_URL = 127.0.0.1:8081. whisper-shim-twin (.c3-900s) -> whisper-twin 127.0.0.1:8080 (-t 8, --no-speech-thold 0.7 --suppress-nst).
- Nothing listens on :8091 (connect refused). /healthz :8083 urls 8081/8082/8085; :8088 urls 8081/8087/8089.

## 3. Synthetic /route (my own run, translate=false; invented clips digital1/dlg_kn_2, dlg_en_2)
- c4 :8083 and :8088: kn 1 seg sravaani/kn, 191 chars, text sha 6d05121c; en 1 seg whisper/en, 281 chars, sha fa7342ff.
- c3 :8083, same clips: identical shas.

## 4. Real windows (3 windows c3 did AFTER the 15:47 repair; harness run_window unmodified, ssh routed via the Mini; outputs in my scratchpad only; no state/claims/runs writes)
| window | c3 record | c4s0 | c4s1 |
|---|---|---|---|
| bh6jtq4t 12:45 (c3s0) | 12 segs (wh 9 + sr + in), 2,143 ch | IDENTICAL (text sha + seg sha 4d85e08c) | IDENTICAL |
| yh3etjpf 13:00 (c3s1) | 30 segs, wh 15, kn, 8,560 ch | 30 / 15 / kn, 8,592 ch | 30 / 15 / kn, 8,562 ch |
| qyzghzaf 13:00 (c3s1) | 23 segs, 356 ch | 30 segs, 483 ch | 30 segs, 512 ch |
- yh3etjpf: same structure; char deltas below 0.4%. c4s0 vs c4s1 differ by as much as either differs from c3: the known CPU temperature-fallback noise (C3-PASS #9195).
- qyzghzaf: the c3 RECORD lacks 9 segments both c4 stacks have: a contiguous run 360-505 s (6 segs) and the last 3 (836-894 s). The other 21 spans line up. That record was c3's FIRST window after the repair (state 15:52:46, run T1547).
- The pattern (contiguous drops, c4s0 == c4s1 in structure) points to c3-side engine failures right after the restart, swallowed by the router's silent except, NOT to c4.
- Advice to backfill-lead: re-check c3 windows done ~15:47-16:00 for missing spans.

## 5. Access / exposure (c4)
- sshd: passwordauthentication no, kbdinteractive no, pubkey yes, permitrootlogin yes (key only; prohibit-password would be tighter). root authorized_keys 1 line; eta has none.
- ufw active: 22 allowed. Engine ports 8082/8085/8087/8089 bind 0.0.0.0 but have no allow rule. Pre-existing provider rules allow 80/443/10050/1167 from anywhere: 10050 = zabbix_agentd, 1167 = cdp-2-6 backup agent, nothing on 80/443. Recommend restricting 10050/1167 to the provider ranges if E2E allows.

## Hand-over items (H1/H2 block BACKFILL use; for herdr-lead/router-fix, not me)
- H1: the box has no ssh key or alias for c4. run_window pushes each window from the box with `ssh <node>`, so the runner cannot reach c4 (I went via the Mini for this check only).
- H2: c4 has no ~eta/histwork/node_route.py (c3's is cf4bc5ca). Install it for user eta. My copy in /root/r2-c4check (node_route + 2 synthetic wavs, no patient audio) can be removed.
- H3: NODES in runner.py has no ':c4s0'/':c4s1' entry; that needs runner.py (pinned 978d9969) to change, or a router spec. Also tailscale is not done (router-fix).
- Load note: both c4 stacks share one CPU whisper (-t 8), as on c3.
