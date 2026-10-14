# Refuter re-check: herdr-ctl.sh and eta-bus-mcp, fix round

Date: 2026-09-23, Mac Mini. Refuter changed no reviewed code.
Inputs: `VERDICT.md` (both FAIL), `orders/HERDR-KIT-FIX.md` (rulings 1–11),
`scratch/herdr-kit-FIX-REPORT.md`. Evidence scripts: `scratch/refute-bus/r2/`.

| Tool | Verdict |
|---|---|
| herdr-ctl.sh | **PASS-WITH-FIXES.** Safe to use. One availability defect (O1) makes `restart` impossible for some agents. |
| eta-bus-mcp | **PASS-WITH-FIXES.** Safe to re-add to user scope. One cap overshoot (O2). |

Overall: **PASS-WITH-FIXES.** Every Critical and High from the first verdict is
closed, and I proved the three that mattered most (B1, H1, H2) myself rather than
taking the Builder's word. Nothing I found makes either tool unsafe to run.

## What I ran myself

- `zsh -n herdr-ctl.sh` → `SYNTAX_OK`.
- `node test/unit.mjs` → **27 passed, 0 failed**. Matches the Builder's claim.
- My own probes, none of which reuse the Builder's test hooks as evidence of
  themselves: secrets corpus (`r2/p1.mjs`), inbox wire-size (`r2/p2.mjs`,
  `r2/p2b.mjs`), cross-process duplicate-read (`r2/reader.mjs`+`writer.mjs`),
  `bus_thread` access (`r2/l4.mjs`), a sandboxed fake-herdr harness for the
  registry/concurrency findings, and a live throwaway herdr session.

### Config hashes — unchanged where it matters

| File | Before | After |
|---|---|---|
| `~/.claude/settings.json` | `43fc4e1b73b8…56b8d82` | `43fc4e1b73b8…56b8d82` — **unchanged** |
| `~/.claude.json` | `7650f6184170…f8889f6` | `282c636ba61d…3c4845a4` — changed |

`settings.json` `model` is still `opus[1m]`. I never typed `/model` anywhere.

The `.claude.json` delta is **not** a build defect and not mine. Three distinct
hashes exist across three windows with no editor in any of them (Builder's
`deedd0…` → my before `7650f6…` → my after `282c63…`), and the file carries
`numStartups`, `changelogLastFetched`, `tipsHistory`, `cachedGrowthBookFeaturesAt`
and other fetch-stamped caches. The Builder's explanation is **corroborated**.

## Rulings 1–11

| # | Ruling | Status | Evidence |
|---|---|---|---|
| 1 | No `/model` path; `model NAME MODEL` = restart with `--model` | **CLOSED** | Only a comment mentions it (`herdr-ctl.sh:457`). `cmd_model`→`do_restart` with override (`:461-468`). No `/model` string in eta-bus at all. |
| 2 | restart reads model + permission mode, always relaunches with both, verifies, non-zero on mismatch | **CLOSED** (see O1) | Live dry-run: sonnet transcript→`model=sonnet permission=auto`; opus→`opus`; no assistant turn→`refuse … never silently defaulting`, rc=1. Relaunch line `:588` passes `--model` and `--permission-mode`. Verify block `:604-625` exits 1 on mismatch. I checked `claude --help`: `auto` and `manual` **are** real `--permission-mode` values, so the flag is correct. |
| 3 | Per-agent lock on every mutating subcommand and `send`; re-check inside the lock | **CLOSED** | Held lock → `send` refused rc=3 without typing. Stale lock (>120s) reclaimed in 1s, no deadlock. `send`/`compact`/`clear`/`do_restart` all `acquire_lock`+`guard_before_typing`; `tag`/`spawn` lock but never type; `status`/`transcript` are read-only. |
| 4 | Refuse if the input box is not empty | **CLOSED on fixtures, UNPROVEN live** | ghost-suggestion=0, typed `/clear` draft=1, empty=0, mixed dim+bright=1, the `\x1b[201~\r/clear\r` string=1. My live attempt to deposit a draft via `send-keys` never landed text in the box, so I could not reproduce it live. The dim/bright logic is right; I could not exercise it against a real pane. |
| 5 | BUSY = **footer line only**, every wording; `/exit` dialog → Esc, fail, stop | **PARTIAL** (O3) | All four missed wordings now caught (`Waiting for 1 background agent to finish`, `2 agents`, `3 tasks`, `1 local agent` → 1). Dialog path coded at `:540-546` and `:566-572`, Esc then exit 1. **But** it reads 8 lines, not the footer line, and matches bare `running\|shell\|monitor` anywhere in them. |
| 6 | Registry lock + temp + atomic rename; `status` never writes it; mktemp per run | **CLOSED** | Old code: 12-agent registry → `1 agent, 0 model, 0 task` + 6 tracebacks. New code, same 4-concurrent-`status` repro: **12 agents, 12 with model, 12 with task, 0 tracebacks**, 4 distinct `STATUS_JSON` paths. 12-way concurrent writes to different agents and to the same agent both keep every field. |
| 7 | Fixed nudge string; reject control chars/newlines in subject | **CLOSED** | `NUDGE_TEXT` (`constants.mjs:33`) is the only thing sent (`tools.mjs:162`); no sender, subject or count reaches it. `CONTROL_CHAR_RE` rejects at post time (`tools.mjs:60,76-78`). |
| 8 | `fable` only when `ETA_BUS_AS=fable` **and** `HERDR_PANE_ID` unset; refuse a pane named `fable`; never cache unknown; 10s TTL keyed by pane | **CLOSED** | `identity.mjs:29-67`. The live `agent rename rt-a fable` spoof from round 1 now resolves `unknown`. Residual acknowledged below. |
| 9 | inbox ≤ 24 KB; mark only what is returned; claim-then-return in one transaction; post in one transaction | **PARTIAL** (O2) | Loss is fixed and the claim is atomic — see B3/B6. The **array** cap is exact (24 575 ≤ 24 576). The **reply** is 49 668 bytes. |
| 10 | Named secret patterns on subject and body; drop the generic rule | **CLOSED per ruling** | All 10 confirmed false positives now pass; 7 named patterns present and firing; generic hex/base64 rules gone. Ruling gap noted below. |
| 11 | `herdr_transcript` orchestrator-only | **CLOSED** | `requireFable` at `tools.mjs:325`. `tail` is also clamped to 1..200 (`herdr-ctl.sh:673-678`), which the ruling did not require. Residuals below. |

## First-verdict findings

| Finding | Status | Note |
|---|---|---|
| **B1** nudge = prompt injection (Critical) | **CLOSED** | Fixed string only; control chars refused at post. |
| **H1** restart silently downgrades model/permission (Critical) | **CLOSED** | Proven live end-to-end through the real dry-run path, not the Builder's `_test_model_from_file` hook. Refuses rather than defaulting. |
| **H2** no recheck, `/exit` kills a working turn (Critical) | **CLOSED** | Live on a throwaway agent: `restart` fired at a **working** agent → `rc=3`, `refuse: rf2a is 'working'`, in 0 s. Turn untouched, session id unchanged. Old code killed the turn and printed `restart OK`. The post-`/exit` abort-without-ctrl+c path is coded (`:551-558`) but I did not hit that narrow window. |
| **H3** concurrent `status` wipes the registry (Critical) | **CLOSED** | See ruling 6. |
| **H4** control chars / leftover draft corrupt input | **CLOSED (fixtures)** | See ruling 4. |
| **H5** BUSY wording gaps | **PARTIAL** | See O3. `/tasks to see subagents` still returns 0. |
| **H6** shared `agent_list.json` → spurious refusals | **CLOSED** | Old code: 20/20 `--dry-run restart a03` under a concurrent `status` failed `unknown agent`. New code: **20/20 succeeded, 0 occurrences** of `unknown agent`. |
| **H7** `/model` global side effect | **CLOSED** | No `/model` path exists; `settings.json` hash unchanged across my whole run. |
| **B2a/b/c** identity spoofing | **CLOSED** | Residual below. |
| **B3** inbox marks read what it cannot deliver | **PARTIAL** | 643 932 B → 33 092 B for the same 20×16 KB scenario, and **nothing is lost**: a second call returns the next batch, draining all 20. Only the 24 KB ruling is missed (O2). |
| **B4** transcript open to every pane | **CLOSED, residuals** | Orchestrator-only and `tail` clamped. Extracts are still mode `0644` and never deleted (3 on disk now); the session id is still interpolated unquoted into `zsh -c` (`:637`, `:686`). Neither was in ruling 11. |
| **B5** secrets false pos/neg | **CLOSED per ruling** | All 10 false positives cleared. Two of the verdict's named misses survive — Google `AIza…` and bare `password=` — because **ruling 10 omitted them**. Builder built to the ruling; the ruling narrowed the verdict. Your call. |
| **B6** non-atomic writes, duplicate reads | **CLOSED** | Two **separate OS processes** on one identity, 6 s against 2 401 concurrently-written messages: **0 delivered to both, 0 duplicates within either, 0 errors**. Round 1 measured 846 to both. Residual: `claimInbox` still orders `ts DESC`, so a backlog is read newest-first — out of order, not lost. |
| **L1** restart timeout < worst case | **CLOSED** | `herdrctl.mjs:73` default 200 000 ms. |
| **L2** `AG_CWD` / empty session id | **CLOSED** | `do_restart` refuses on empty `sess` or `cwd`. |
| **L3** agent list once per recipient | **CLOSED** | One `herdrAgentList` per `bus_post` (`tools.mjs:102`). |
| **L4** `bus_thread` open to any caller | **OPEN — I rule: fix it** | Below. |
| **L5** `-n NAME` lower-cases the display name | **OPEN — I rule: accept** | Below. |

## Rulings on L4 and L5

**L4 — `bus_thread` returns any thread to any caller. CONFIRMED, and I rule it
should be fixed.** Live probe (`r2/l4.mjs`): a message from `fable` to
`eta-assistant` only, thread `thr-1`. Caller `rt-x` — not the sender, not a
recipient, own inbox empty — received the **full body** and the **recipient
list**. `busThread` (`tools.mjs:243-262`) checks `requireIdentified` and nothing
else. This is a read-around of the access model that rulings 9 and 11 just
tightened everywhere else: `bus_inbox` is per-recipient and `herdr_transcript` is
orchestrator-only, but any pane that knows or guesses a caller-chosen
`thread_id` reads the whole thread. Cheap fix: return only messages where the
caller is the sender or appears in `recipients_json`. I rule it Low severity
(a guessable-but-unguessed id is the only barrier) and worth the one-line fix.

**L5 — `-n NAME` renames the Claude display name on restart. CONFIRMED, and I
rule: accept, no fix.** `herdr-ctl.sh:588` and `:782` pass `-n "$name"`, and
herdr names are lowercase, so `ETA-Refuter` comes back as `eta-refuter`. It is
cosmetic, it affects no behaviour, and the alternative — carrying a separate
display name through the registry — adds state for a label. Not worth it.

## H2's live race — re-tested

Re-tested on `rf2-test`, a session I created and deleted, with one haiku agent
`rf2a` started with an explicit `--model haiku`. I put it into a genuine
`working` turn with a pure text-generation prompt (no tool call, so it could not
sit `blocked`), confirmed the state was `working`, then fired the real
`herdr-ctl.sh restart`:

```
state when restart fires: working
--- restart rc=3  (took 0s) ---
refuse: rf2a is 'working' (must be idle or done; not blocked/working/unknown)
--- state right after: state: working  sess: a2d089c8-…  (unchanged)
```

The first verdict's version of this killed the turn mid-output and still printed
`restart OK`. **H2's primary regression is closed, live.**

The narrow remainder — state flipping to `working` between the guard and the
`/exit` — I did not reproduce. The window is now one herdr call wide instead of
the five calls (~1–1.5 s) the first verdict measured, the whole path is under the
per-agent lock, and there is an explicit post-`/exit` abort that skips ctrl+c if
the state flipped (`:551-558`). I read that path and believe it; I did not
trigger it. Stated as read, not as proven.

## New findings

### O1 — High. `restart` is impossible for any agent whose transcript has no assistant turn. CONFIRMED live.

`do_restart` gets the model **only** from `transcript_last_model`
(`herdr-ctl.sh:497`), which returns empty if the session jsonl has no assistant
turn — and then refuses (`:500-503`). Two real cases, both live today:

1. **`yoga-drain`**, one of the 14 live agents. Its transcript exists (27 406
   bytes, 9 records: `user`, `system`, `attachment`, `mode`, …) and contains
   **zero assistant turns**. I checked all 14 agents read-only: 12 resolve a
   model cleanly, 1 has no session id, and `yoga-drain` resolves to empty.
   **`herdr-ctl restart yoga-drain` would refuse right now.**
2. **Every agent spawned by `cmd_spawn` from inside a Claude Code pane.** My
   `rf2a` pane showed `⚠ Transcript saving is off — inherited
   CLAUDE_CODE_CHILD_SESSION marker`, and no jsonl was ever written. `cmd_spawn`
   does not clear `CLAUDE_CODE_CHILD_SESSION` (it is `=1` in my own env), so an
   agent the orchestrator spawns can **never** be restarted. `restart rf2a`
   refused for exactly this reason.

This is fail-safe — it refuses rather than downgrading to Haiku, which is what
H1 demanded — so it is not a safety defect. It is an availability defect that
makes `restart` partly non-functional, and the fix is already half-written:
`do_restart` **writes** `registry_set "$name" model "$model"` at `:150` of the
function but never reads it back. `rf2a` had `model=haiku` sitting in the
registry while the restart refused.

**Fix:** fall back to `registry_get "$name" model` when the transcript yields
nothing, and refuse only when both are unknown. Separately, have `cmd_spawn`
clear `CLAUDE_CODE_CHILD_SESSION` so spawned agents keep a transcript at all.

### O2 — Medium. Ruling 9's 24 KB cap is missed by 2.02×; `server.mjs` was never touched.

`server.mjs:67-70` still sends every tool result twice — once as
`content[].text` and again as `structuredContent`. The first verdict named this
explicitly ("The payload appears twice… **Send the payload once**"). `server.mjs`
is **byte-identical** to the round-1 copy; the Builder's report does not mention
the file.

Measured: the messages array caps exactly at 24 575 bytes, but the JSON-RPC
reply on the wire is **49 668 bytes, 2.02× the ruled cap**. With 16 KB bodies it
is 33 092 bytes for a single message.

This is far better than the 643 932 bytes of round 1 and **no messages are
lost** — the cap and mark-only-returned both work, and a second `bus_inbox`
returns the next batch. But ruling 9 says "whole reply ≤ 24 KB" and the whole
reply is not. **Fix:** drop `structuredContent`, or halve
`INBOX_REPLY_CAP_BYTES`.

### O3 — Medium (availability). BUSY is not "footer line only" and over-matches.

Ruling 5 says the footer line. `pane_flags` reads 8 lines via `read_footer_plain`
(`:150-152`), and `busy_wording_hit` (`:154-165`) has a second grep on bare
`background agent|waiting for|shells|shell|monitor|running`. Ordinary output in
those 8 lines therefore reads as BUSY:

```
"I am running the tests now"  -> 1
"the monitor showed 3 errors" -> 1
"Bash(npm test) running"      -> 1
```

Real idle footers correctly return 0, so this only ever refuses — it never kills
a turn. It is the same complaint H5 made about 50 lines of scrollback, narrowed
to 8 rather than to the footer line, and it will block legitimate restarts and
nudges whenever the last screenful happens to contain those words. Also
`/tasks to see subagents`, which the first verdict listed, still returns 0.
**Fix:** anchor to the line under the last `❯` box and drop the bare-word grep.

### O4 — Low. Residuals the rulings did not carry over

The Builder built to the rulings, and the rulings dropped some of the first
verdict's fix bullets. Listing them so you decide, not him:

- `herdr_transcript` extracts are still written `0644` and never deleted
  (3 on disk). Verdict B4 asked for `0600` + delete after read; ruling 11 did not.
- The session id is still interpolated unquoted into `zsh -c` at `:637` and
  `:686`. Not exploitable — herdr validates session names — but B4 said
  "quote it anyway".
- `cmd_clear` prints `cleared $name` without confirming a new session id
  (`:451-452`). Verdict H4 asked for per-command result verification; only
  `restart` got it.
- `claimInbox` reads newest-first, so a backlog is delivered out of order.
- The lock-timeout message says "~30s"; the real wait is ~53 s (150 × 0.2 s plus
  subprocess overhead). Cosmetic.
- Secrets: `AIza…` and bare `password=` still pass (ruling 10 omitted them).
- Identity: a pane can still run `env -u HERDR_PANE_ID ETA_BUS_AS=fable run.sh`.
  Ruling 8 keyed the gate on `HERDR_PANE_ID` alone; the first verdict already
  conceded this gate "only prevents accidents", and all panes share one UID.
  Adding `HERDR_ENV` to the check would close the accidental case too.

## Jev

Ran `jev_review` on the security-core diff (identity/secrets/db) per the standing
rule. Scores 6.4–7.5, every issue `low` and generic, no location cited, no defect
I had not already found. **Leads only — it contributed nothing to this verdict.**

## Live-session safety

- No input of any kind was sent to any agent in the `default` session. Against
  `default` I made read-only calls only: `agent list`, `pane read`, and JSONL
  reads. No transcript text, note text or patient label was printed — record
  type counts and model strings only.
- All mutating tests ran either against a sandboxed fake herdr under `/tmp`
  (a copy of the script with its paths redirected) or in `rf2-test`, a herdr
  session I created and deleted. Its one agent `rf2a` was started with an
  explicit `--model haiku`.
- `rf2-test` is stopped and deleted. `herdr session list` shows `default`
  (running) and the Builder's stopped `ctl-test`. `default` still has all 14
  agents. I removed the `rf2-test` entry my spawn wrote to `herdr-registry.json`
  and deleted my two fixture dirs under `~/.claude/projects/`.
- I never typed `/model`. I did not edit `~/.claude/settings.json` or
  `~/.claude.json`; hashes above.

## What V should do

1. **O1 first** — `restart` is silently unavailable for `yoga-drain` and for
   every spawned agent. One-line registry fallback.
2. **O2** — drop `structuredContent` from `server.mjs`.
3. **O3** — anchor BUSY to the footer line.
4. **L4** — restrict `bus_thread` to participants.
5. Decide on the ruling-10 gap (`AIza`, `password=`) and the O4 residuals.
6. eta-bus can go back into user scope; nothing I found makes it unsafe.

---

# Round 3 re-check (narrow: O1, O2, O3, O4, L4, ruling-10 gap)

Date: 2026-09-23, Mac Mini. Refuter changed no reviewed code.
Scope: only the six items above, per the order. Everything else in this
document stands as written in Round 2 and was not re-examined.

**Verdict: PASS-WITH-FIXES.** Five of the six are CLOSED and I proved each
myself. O1 is **PARTIAL**: its main half works, its spawn half is dead code,
and it introduced one new narrow failure (N1 below).

## Suites rerun by me

- `zsh -n herdr-ctl.sh` → `SYNTAX_OK`.
- `node test/unit.mjs` → **31 passed, 0 failed** (was 27). Matches the report.

## Config hashes

| File | Before | After |
|---|---|---|
| `~/.claude/settings.json` | `43fc4e1b73b8…56b8d82` | `43fc4e1b73b8…56b8d82` — **unchanged** |
| `~/.claude.json` | `0e65cdba9fb5…284c986a6` | `bdebee2470cb…a9a5eb5dd87` — changed |

`model` is still `opus[1m]`. I never typed `/model`. The `.claude.json` delta is
the same session bookkeeping established in Round 2 — note it moved during *my*
round though the Builder's round happened not to trigger a write, so his
"unchanged" is true of his run and not a property of the file.

## Item by item

| Item | Status | Evidence |
|---|---|---|
| **O2** — 24 KB cap missed 2.02× | **CLOSED** | `server.mjs:66-72` drops `structuredContent`. My own measurement, worst case (200×1 KB): **49 668 B → 24 993 B, 2.02× → 1.02×**. 20×16 KB case: 16 579 B, inside the cap. Both drain 200/200 and 20/20 — nothing lost, nothing duplicated. I also checked the protocol risk the report did not mention: **no tool declares `outputSchema`**, so `structuredContent` is optional and dropping it is spec-safe. Residual nit: the cap is applied to the messages array, so the envelope plus JSON-string escaping puts the worst case 417 B (1.7 %) over 24 576. Immaterial — the concern was client truncation at ~25k tokens. |
| **O3** — BUSY not footer-anchored | **CLOSED** | `footer_suffix_only` anchors to the last `❯` before `busy_wording_hit` runs; bare-word grep gone. Fixture with all three Round-2 false positives *above* the marker → **0** (Round 2: 1 for each). Real footers `3 shells`, `1 shell, 1 monitor`, `Waiting for 1 background agent to finish` → **1**. Idle footer → 0. No regression: all eight original H5 wordings still correct through `_test_busy`. **Live:** a throwaway agent made to emit `I am running the tests now and the monitor showed 3 shells` into its own pane — `--dry-run send` returned **rc=0**, not a false BUSY refusal. |
| **L4** — `bus_thread` open to any caller | **CLOSED, exactly as I ruled** | My probe, 3-message thread: `rt-x` (sender of one) sees **1/3**; `eta-assistant` 2/3; `fable` 3/3; an unrelated pane **0/3**. In Round 2 `rt-x` read the full private body — it no longer can. No carve-out for `fable`, which is right. |
| **ruling-10 gap** — `AIza`, `password=` | **CLOSED** | Both now caught (`AIzaSyD-…`, `password=…`, `PASSWORD = …`). Critically, I re-ran the **whole Round-2 false-positive corpus against the new patterns: all 10 still pass** — no B5 regression. Two nits: `password: <value>` (colon form) is still missed, and `password=<redacted>` flags as a secret. Both trivial. |
| **O4** — residuals | **CLOSED in code** | `chmod 600` on the extract (`cmd_transcript`), `fs.unlinkSync` after read (`tools.mjs:366`), and `cmd_clear` now captures the session id, polls 10 s and reports `clear UNCONFIRMED … rc=1` instead of `cleared`. I read all three call sites; the last two are not live-proven — neither is cheap to exercise safely, and I accept them as read. |
| **O1** — restart unavailable without an assistant turn | **PARTIAL** | Split below. |

## O1 in detail

**The registry fallback works — proven live.** `do_restart` now tries
`transcript_last_model`, falls back to `registry_get "$name" model`, and refuses
only when both are empty; it reports which source won (`src=…`). On a throwaway
agent with **no transcript at all** and `model=haiku` in the registry,
`--dry-run restart` returned **rc=0, `model=haiku`** where Round 2 returned
rc=1 `refuse`. Transcript still wins over registry when both exist. Good fix.

**But in production the fallback is currently empty.** The registry has **11
default-session agents and a model for none of them** — they were started by
hand, not through `herdr-ctl spawn`. So the fallback rescues nothing today; it
only begins to help as agents pass through `spawn`/`restart`, which write the
model. Worth knowing before relying on it.

**The Round-2 symptom has also resolved itself.** `yoga-drain` now has **95
assistant turns** (it was mid-first-turn when I sampled it). I re-swept all live
agents: **13 of 13 named agents resolve a model from their transcript.** Nothing
in production currently needs the fallback.

**The spawn half is dead code. CONFIRMED live.** `cmd_spawn` runs
`unset CLAUDE_CODE_CHILD_SESSION` in *its own shell*, but `hcli agent start` is
a socket call — the **herdr server** launches the process, so it inherits the
server's environment, not herdr-ctl's. I started a throwaway server with the
marker deliberately set and spawned through the fixed script: the pane still
showed `⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION
marker` and **no jsonl was written**. The unset has no effect.

This does not bite production: the default session's server (pid 25210, started
22 Sep from a plain terminal) is **clean of the marker**, and a live agent
(`herdr-kit`) has a 602-record transcript. My Round-2 report attributed this to
`cmd_spawn`; the real determinant is how the **server** was started, and I was
the one who contaminated my own test server. I correct that here. The line
should be removed or moved to wherever the herdr server is launched.

### N1 — New, Low. The fallback turns a clean refusal into a 122 s failure that loses the agent.

With the transcript file **absent** (not merely empty of assistant turns), the
fallback lets `restart` proceed — and `do_restart` then runs
`claude --resume "$sess"` against a session id that has no transcript to resume.
Live: the real restart ran 122 s, herdr returned
`{"error":{"code":"timeout","message":"timed out waiting for agent startup"}}`,
and the agent was left **`__NOTFOUND__`** — gone from the roster.

It reported failure honestly (`restart FAILED/UNCONFIRMED`, rc=1, no false
"OK"), so the H1 discipline holds and this is not a safety defect. But the
outcome is worse than Round 2's instant refusal, which cost 0 s and left the
agent running.

**Fix (one line):** in `do_restart`, refuse when the transcript *file* does not
exist, regardless of the registry — `--resume` cannot work without it. Keep the
registry fallback for the case it was built for: a transcript that exists but
has no assistant turn yet.

## Live-session safety

- No input of any kind was sent to any named agent in the `default` session.
  Against `default`: `agent list`, one `pane read`, JSONL record-type counts and
  `ps` env checks only. No transcript text, note text or patient label printed.
- All mutating tests ran in `rf3-test`, a session I created and deleted, with two
  throwaway agents (`rf3a`, `rf3b`) started with an explicit `--model haiku`.
- `rf3-test` stopped and deleted; `herdr session list` shows `default` (running)
  and the Builder's stopped `ctl-test`. `default` still has all 14 agents. I
  removed the `rf3-test` registry entry and both fixture dirs under
  `~/.claude/projects/`. No stale locks.
- Not re-proven this round, unchanged from Round 2: ruling 4's draft refusal is
  fixture-proven only. I again failed to deposit an unsent draft via
  `pane send-keys --text`, so the live path stays untested. A limitation of my
  method, not a finding against the Builder.

## What V should do

1. **N1** — guard `--resume` on a missing transcript file (one line).
2. **O1 spawn half** — delete the ineffective `unset`, or clear the marker where
   the herdr server is launched. Cosmetic today; production is clean.
3. Note that the registry fallback covers no existing agent until each has been
   restarted once through `herdr-ctl`.
4. Optional nits: `password:` colon form, `password=<redacted>` false positive,
   the 417 B envelope overshoot.
5. Still open from Round 2's O4, untouched by design: unquoted session id in
   `zsh -c`, `claimInbox` newest-first ordering, the "~30s" lock message, and the
   `HERDR_ENV` identity gate.

---

## Provenance note (23 Sep 12:56) — settings.json hash superseded by V, not by a tool

`~/.claude/settings.json` has changed since this verdict certified it:
`43fc4e1b73b834b0…` → `e950528acf4286c9…`. **V made this edit**, adding a
standing rule that every herdr pane may read and write the whole home folder and
the Air Drive SSD:

```
permissions.additionalDirectories: ['/Users/vinaybhardwaj', '/Volumes/Air Drive']
```

Recorded so a later reader who re-hashes the file does not mistake it for a tool
writing to settings.json. I verified the only material key is untouched:
**`model` is still `opus[1m]`** — the global default that this entire fix round
exists to protect. Neither `herdr-ctl.sh` nor `eta-bus-mcp` wrote this file; the
Round 1–3 findings are unaffected.

Access is not ownership: the ownership rules stand (whisper-shim is MiniBot's,
stt-drain is the Designer's, one drainer at a time).
