# OUTBOX cloud-guardian-r16e (append-only)
- branch cloudpane/cloud-guardian-r16e/r16e from 41b88298
- code: SHOULD-1 kill/mode first in canary_play_gate (canary.sh:301-302), SHOULD-2 whole-gap speech scan (canary.sh:261,277,315), version c1-0.4.8-r16e
- tests: tests/t_r16e.sh 11 fns 62 assertions ok
- kiosk run.sh on Linux via BSD shim: R16e 342 fns/523 failed vs base 331 fns/523 failed; 0 new failures; the macOS suite is UNPROVEN here
- mutants M1 (kill-first removed) and M2 (2 s window) EXECUTED: both red (6 and 18 failed)
- mini tests 40 OK (7 skipped); shellcheck rc 0
- blocked: none. Pending, not run here: macOS suite, swift build/test
- scrub origin/guardian/fr1-c1-r16..HEAD rc 0 (gitleaks 8.21.2); code commit 2282ad3b
