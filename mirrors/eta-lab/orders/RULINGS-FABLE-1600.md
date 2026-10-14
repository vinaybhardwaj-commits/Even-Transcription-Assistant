# Fable rulings 129–143 (16:00 IST review, 24 Sep 2026)

Read from bus cursor 1053 to 1169. These override any earlier ruling they touch.

## 129. Mini ssh refusals: root cause found (closes herdr-kit #361/#401)
- **Cause (measured 15:58).** The Mini's system sshd is launchd inetd-style, with `Instances => 42` in /System/Library/LaunchDaemons/ssh.plist. Every box pane holds two stdio-over-ssh MCP sessions to the Mini (`ssh mini-bus` for the bus and `ssh mini …/even-jev-mcp/run.sh` for Jev).
  - 19 panes × 2 = 38 sessions, plus a few others, so we are at the cap.
  - At the cap, launchd accepts the connection and closes it, which shows as `kex_exchange_identification: Connection closed`.
  - It is not overload and not PerSourcePenalties. All 38 sessions belong to live panes; there are no orphans.
  - The plist is SIP-protected, so the cap can't be raised.
- **Fix: a lab sshd owned by herdr-kit (Sonnet builder), user-mode, no sudo.**
  - Run `/usr/sbin/sshd -D -f ~/.ssh/lab-sshd/sshd_config` as a user LaunchAgent with KeepAlive.
  - Settings:
    - `ListenAddress 127.0.0.1`, `Port 2223`;
    - its own host key in ~/.ssh/lab-sshd/;
    - `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `UsePAM no`;
    - `AllowUsers vinaybhardwaj`, `PidFile` in that directory;
    - `MaxStartups 30:30:100`, `MaxSessions 64`;
    - AuthorizedKeysFile is the normal one.
  - Add a second reverse forward as a separate Mini→box ssh job: `-R 127.0.0.1:2224:127.0.0.1:2223`. **Don't touch the existing 2222 job**; live sessions stay up.
  - On the box, point Host `mini` and `mini-bus` at port 2224. Keep the old entries as `mini-legacy` and `mini-bus-legacy` on 2222. New panes use the lab sshd; old sessions drain as panes restart.
  - Verify three things:
    - 50 concurrent `ssh mini true` from the box all succeed;
    - the system sshd instance count stays under 42;
    - the probe log reads `up,up`.
  - eta-refuter (Opus) refutes. The build is lab infra, allowed during clinic hours because it adds no load.
- **Later, not now.** Move bus and Jev MCPs to HTTP transport so they hold no ssh session per pane. The owner is herdr-kit, after 129 passes.

## 130. Production health flaps (rotating whisper/llm timeouts at batch peaks)
- **Evidence.** Swap is 7.8 of 9.2 GB used. eta-diarize ran at 550% CPU during a batch. Every flap recovered within about 1 minute. There are no lab jobs on the Mini.
- **Now.** No change during clinic hours. The conductor keeps logging.
- **After 20:30 tonight,** once the 73868e4 deploy is smoked:
  - controlled restart of eta-diarize (22 h uptime, 1 GB RSS);
  - `ollama stop` any loaded model;
  - record swap before and after.
- **If flaps continue tomorrow,** issue an Opus Debugger root-cause order.

## 131. Parity set 2: FAIL stands; HIST stays OFF. Decisive test pre-registered now
Rule for lab-mover's 10-window × 3-run test (due about 16:10):
- **Approve for mining.** If median(twin vs twin) − median(twin vs stored) ≤ 0.02, the twin differs from production no more than it differs from itself. B5 is then whisper sampling noise, and HIST is approved **for mining only**.
  - Any consult shown to a rater, or used as a label, is first re-transcribed on the production room path.
- **Otherwise diagnose.** A gap above 0.02 is systematic. Rerun with temperature_inc=0 (#390.4). If still > 0.02, issue an Opus Debugger order. HIST stays off.

## 132. CPU nodes (answers ruling 124)
- After 131 approves, run 2 stacks per CPU node and measure.
- Go to 4 stacks per node only if throughput scales ≥ 1.6× with zero errors.
- Extra routers go on the CPU nodes; the GPU nodes keep whisper.
- Experiment 107c runs on hist-gpu-2 after HIST starts.
- Bulk never falls back to live (#390.3).

## 133. Nemotron
- **VAL manifest.** Use the production-matched manifest, per ruling 103 and eta-refuter-2's recommendation. The bench-shaped b642fdd2 is not the adoption set.
- **Variant A.** Not adopted: count error 0.4 equals the base model. No DER-only shadow. Re-score A on the production-matched manifest for the record.
- **Variant B.** Launch on production-matched with C1: log the speaker counts actually delivered.
- **Human benchmark.** Every variant is also scored against the 30-window speaker-count page once ≥ 20 windows are rated. Today 3/30 are rated.
- **Proposal.** The Jev evidence-card proposal (claude/ETA-JEV-VOICE-PROPOSAL-24-SEP-2026.md) waits on V's go. Nothing is built.

## 134. eta-refuter #390 decisions: all recommendations accepted
1. sh() gets a 120 s timeout in both twins.
2. A busy Mini counts as ok and is shown as info.
3. Bulk never falls back to live.
4. Parity uses temperature_inc=0.
5. Diarize: shared-secret Bearer on /diarize, /embed_speakers and /enroll together, with /health open. Not Access headers for this machine-to-machine path. The token lives in a Mini secret file and Vercel env, never argv. It stays dark until a train carries it.
6. .env.example gets the commented pool-settings block.

## 135. Push incident 09b9a0a (tunnel-ops kit on public origin/main)
- **What leaked.** It holds tunnel UUIDs, hostnames, ssh aliases and ports. There are 0 tokens, 0 account ids and 0 emails. None of it is a credential.
- **No history rewrite.** The next train removes the kit files from the ETA repo; the kit lives in eta-lab (private) only.
- **Rule for every pane.** Before any push from the shared box checkout, run `git log origin/<branch>..HEAD`. Push only if every listed commit is yours. tunnel-ops never commits in the ETA repo.
- **#391 flag.** The next train scrubs the Cloudflare account id from docs/SPRINT-0-EXIT.md:32 and moves the admin-allowlist email into an env var. History is not rewritten. Fable tells V.

## 136. Tunnel P1 kit
- Commit the four pinned scripts to **eta-lab** now, with sha256 p1 8b9689d7a7ce, rollback a9b3ad737e14, lib c07b17edc108, cf 65662776a865.
- Fable runs `sha256sum` before --apply at 07:00.
- Caveat T2 accepted: the Mini's local config is not an instant rollback for P4.

## 137. Watchdog
- **Decision 1.** Outbox plus pull relay, owned by herdr-kit.
- **Sink.** Bus only; the board sink is dropped.
- **Read token.** A dedicated read-only token in the Mini's ~/.claude/secrets/, never argv.
- **Paging and threshold.** V paging OFF; silent threshold 5 min.
- **F6(c): yes.** The conductor greps the relay's last-poll each cycle and posts if it's stale by more than 10 min.
- **Files.** The last-poll file is gitignored. bus.db is already gitignored (verified). Doctor names inside the private bus are allowed.
- **Migration.** Before the build is trained, scribe must prove 0119 is unused on every branch, including train-24sep-next. Renumber on any clash.
- **Train.** The watchdog rides its own train after 7e7d4e3, not tonight. Fable applies the migration by hand before that deploy: psql, with the URL read from an env file and never on argv.

## 138. Ruling 40 (check:silent in the box runner)
- C2: a target with no check:silent script is a **FAULT** (fail closed), not NOT RUN.
- C1 must pass via yoga-test.sh.
- Then push as a new branch, not main. eta-refuter-2 re-verifies. The shared masters stay untouched until then.

## 139. fable-inbox.sh
Yes: replace the kill -0 check with a non-blocking flock test (herdr-kit).

## 140. Emotion
- 128(b) is approved: requeue the 8 windows and ship the dedupe fix.
- indic-mt owns the triage of the 30 windows at the attempt bound (owner-less item from #332). Report by 18:00.

## 141. Loop guard (ruling 116 follow-up)
- The number exemption is accepted. Repeated numbers and dosing are never removed; clinical content beats dedupe.
- split-speaker measured 12 of 13 loops cleared and 303 duplicate words removed.
- It rides the next train after a refuter pass.
- The 17:00 check that loops reach the final transcripts stands.

## 142. Surgical chain
- **All three scouts are done.**
  - mb-rx: the calendar event uid is the key (98%).
  - mb-ot: surgery_packages is empty; OT notes lag about a day.
  - mb-ipd: kx_ip_admissions is the spine; the procedure comes from billing; the HIS→OPD doctor-id map is still open.
- The linker merges into SCHEMA.md now; due 17:00, unchanged.
- The four panes were stalled on the "Teach auto mode" prompt. It was dismissed at 15:58; herdr-kit makes the dismissal stick for new panes.

## 143. V's rating feedback (surgery v3: 4 of 12 rated; speaker count: 3 of 30; Sandhya: 0)
- **V3-03.** V rated the Kannada translation "terrible", so indic-mt takes V3-03 as a failure case. The clip also runs past its encounter: another case from about 7:00 and a new encounter at about 13:00. fleet and lx re-check V3-03's bounds against the clamps.
- **V3-02.** The procedure is described but not named (tympanoplasty). The v4 question wording must separate "named" from "described".
- **V3-03 and V3-04.** V asked for prescription and surgery lookups. That is exactly what the chain page (P2) shows.
