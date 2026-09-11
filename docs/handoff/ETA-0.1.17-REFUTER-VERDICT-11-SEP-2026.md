# ETA 0.1.17 REFUTER VERDICT — 11 Sep 2026

**ACCEPT `5a36727`.** All four changes hold. Test (a) and the push are flagged.

**Gates (mine).** `swift test`: 543 tests / 44 suites, exit 0 (535 / 43 at `5dff406`). `npm test`: 1572 passed. `typecheck`, `build`: exit 0. Eight files, all under `apps/room-recorder/`.

**Four tests.** At `5dff406`: (b) fails `RoomStaleIdentityTests.swift:121`, (c) fails `:178`, (d) fails `RoomSelfUpdateTests.swift:1735`. All pass at HEAD. **(a) does not fail at `5dff406`.** With `main.swift:108-134` ported verbatim, it passes; the 0.1.13 line already wrote the file. The report's "(a) fails" is not reproduced.

**Loop (unsigned, /tmp/rr-scratch).** 0.1.13: `this install has been retired (409 RETIRED)`. 0.1.17: `…k54jsz5r4cyz disagrees with config install_539avu7gqzz5; config wins, session file rewritten`. Same token, file at 0600, `status.json` ready, `last_error` null for 30 s, no RETIRED. Home Office stayed listening; live files unchanged.

**Adversarial reads.** Change 3: latch set at `RoomEngine.swift:866`, never cleared. Guard `:863` requires `.sessionFile`; `:875` sets `.configuration`. After the discard the file is only stat'ed (`:891`). Change 1: `exchange` (`main.swift:97`) runs before `persist` (`:111`). A throwaway test (401, transport error, 200 without a token) left both files byte-identical. Change 4: comment at `RoomConfiguration.swift:176-182` updated; only `:542` sets the channel.

**Artifact.** Verify passes. DR matches 0.1.13: `identifier "com.evenscribe.room-recorder" and certificate leaf = H"187dd424fb866204111113d60c6f88a21d098edb"`. CDHash `4170fd228c650cd3fdbcee1766d09a6a96137dcf`. Version 0.1.17; `config wins` embedded.

**Dirty tree.** `CLAUDE.md` and `docs/handoff/` only. Nothing under `apps/`.

**Flags.** origin already has `5a36727` (pushed 08:56 IST). If enrol saves the session file but not config, stale config now wins.
