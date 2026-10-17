2026-10-17 start: branched cloudpane/cloud-guardian-r16e-w/r16e from 41b88298
2026-10-17 code: SHOULD-1 kill/mode first, SHOULD-2 gap speech, version c1-0.4.8-r16e, tests/t_r16e.sh 9 fns 52 pass 0 fail (Linux shim)
2026-10-17 mutants executed: M1 kill-after-consult red (kill/am 2 FAIL), M2 2s window red (gap start/middle/remembered); scrub rc 0
2026-10-17 shellcheck -x (0.11.0) on tracked tools/room-guardian *.sh rc 0 after quoting fix; mini suite 40 tests OK (7 skipped)
2026-10-17 rework: kill/mode first via act_step keeps would_do (existing tests unchanged); gap globals; shellcheck rc 0; canary subset rerun pending
2026-10-17 DONE: full kiosk run HEAD 340 fns 1769 pass 525 fail, failing set identical to base (110 fns, macOS-only); mutants M1 M2 red; report cloudpane-reports/GUARDIAN-R16E-BUILD.md
