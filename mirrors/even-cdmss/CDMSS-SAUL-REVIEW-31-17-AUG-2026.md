**Ruling**
Technical proofs remain closed at **7/20 hard and 4/4 judge**. Do not administratively close pass 2, push, or begin pass 3 yet.

**Two Remaining Test Gaps**
1. Test 5.2c can hang before asserting an in-flight leak.
   - `explicit-judge-equivalence.test.ts:322-334` awaits unbounded `judge.settled()`.
   - A close-accounting regression would hang rather than fail by name.

2. The acceptance snapshot is not guarded through the data handler.
   - Both toggle tests send small bodies.
   - Replacing `recordThisRequest` with live `recording` only at `judge-server-stub.ts:367` leaves them green.
   - An accepted-on request toggled off could bypass the 1 MiB limit.

Also fix 5.2b cleanup so a failed `waitForContinue` still waits for or terminates its unrecorded request before the shared server proceeds.

**Governance**
- V19 was not prospectively authorized. Preserve it unchanged as historical evidence.
- Keep commits `614da54` and `df78215`; no rebuild or rerun is required solely because of the signature defect.
- A new v20 should truthfully record the chronology, retrospectively ratify commits 7/8, and prospectively authorize the final narrow test repair.
- We can use your explicit verbal approval in this thread once v20's exact bytes/digest are ready. No need to design a cryptographic process now.

**Minimal Final Pass**
1. Add a bounded zero-in-flight wait for 5.2c and its cleanup.
2. Add an oversized mid-flight toggle test proving the acceptance snapshot controls the data-handler limit.
3. Add two mutations:
   - Data handler rereads live `recording`.
   - Close decrement rereads live `recording`.
4. Rerun recorder mutation rows 1–14 and 31–34, then typecheck, tests, and the full gate.
5. Commit the repair, then a final governance/evidence commit under valid v20 authorization.
6. Saul administratively closes pass 2, then separately releases pass 3 and push.

Everything else in commits 7/8 checks out: authorized paths, descriptor-faithful snapshots, proof quotations, comments, 32 mutation records, and the green gate.

---

*Uploaded twice, identically, as "Saul Rep 31" and "Saul Rep 32". Tracked once, as review 31.*
