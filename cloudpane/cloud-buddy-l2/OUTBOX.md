# OUTBOX cloud-buddy-l2 (append-only)
- 2026-10-16 preflight origin/consult/buddy-shadow-reach=9cd8a055 OK
- typecheck rc=0; tsconfig.tests rc=0; buddy-relay+no-identity 71/71 pass
- buddy-relay-pg RUN on docker postgres:16: 8/8 pass
- npm test: files 442 pass/1 skip/446, tests 9191 pass/6 skip/9255, 7 worker-rpc timeout errors; 3 unreported files re-run 97/97 pass
- check:silent 9 findings (accepted baseline), 0 in relay.ts
- mutations M1 M2a M2b M3 M5 all killed; refuter pg probe (active-install) 3/3 pass
- verdict PASS, 0 MUST, 4 SHOULD; report REFUTE-PART-X.md on cloudpane/cloud-buddy-l2/refute
