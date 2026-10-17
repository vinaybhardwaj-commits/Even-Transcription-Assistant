# OUTBOX cloud-scribe-oauth-r2 (append-only)
- start: branch cloudpane/cloud-scribe-oauth-r2/r2 from origin/cloudpane/cloud-scribe-oauth-c4/0171 48d5df7a
- F1 F2 F3 F4 F5 F6 B1 built in 088c38a0; probes carried over (11/11 pass)
- pg PG16: o2-pg 10/10, o3-pg 14/14, 0171 9/9; old o3-pg fails 1/13 audit_append_only (B1 reproduced, fixed)
- gate: tsc 0, typecheck:tests 0, build 0, check:silent 9 (baseline), vitest 453 files / 9467 passed / 0 failed (3 worker-RPC timeouts in untouched s7-rubric-pg; alone 52/52)
- scrub origin/scribe/oauth-person..HEAD rc 0
- report: cloudpane-reports/SCRIBE-OAUTH-R2-BUILD.md; verdict READY-FOR-REFUTE
- r3: branch cloudpane/cloud-scribe-oauth-r2/r3 from r2 7ad33769; code 41b55843 (referrer same-origin, single-use consent via 0172, r2 refute probes carried, P1 and FINDING 2 flipped)
- r3 gate: tsc 0, typecheck:tests 0, build 0, check:silent 9, vitest 9488 passed / 0 failed (6 worker-RPC timeouts in 3 untouched files; alone 85/85), pg o2 11/11 o3 14/14 0171 9/9, scrub rc 0
- r3 report: cloudpane-reports/SCRIBE-OAUTH-R3-BUILD.md; verdict READY-FOR-REFUTE
