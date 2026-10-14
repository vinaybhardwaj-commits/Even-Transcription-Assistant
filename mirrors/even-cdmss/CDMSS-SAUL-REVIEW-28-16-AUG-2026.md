**NO-GO Confirmed**
No files were changed. The requirements are feasible within the four-file test-only scope after the governing documents are corrected.

**Revision Plan**
1. Revise addendum v15 before signature.
   - Scope "exactly four files" to commit 1 implementation paths only.
   - Explicitly authorize the five governance/evidence paths in commit 2.
   - Make ignored-document checks phase-specific: exactly v15 and review 27 may remain ignored at commit 1; none may remain ignored after commit 2.
   - Fully define recorder overflow, sequencing, in-flight, reset, snapshot, and defensive-copy behavior.
   - Require every command 6 line to exit zero.
   - Remove generic authorization for mutating `git restore` and arbitrary `node -e`.
   - Replace absolute "no fifth file" language throughout.

2. Revise the pass-2 kickoff.
   - Correct v11's proof range from 1–60 to 1–73.
   - Preserve the exact proof 2, 16, 17, 18, and 70 definitions.
   - Run a baseline `npm test` before implementation and another before commit 1 so the commit message has observed counts.
   - After staging, validate the implementation with:
     ```bash
     git status --porcelain --untracked-files=all
     git diff --cached --stat 72960baa
     git diff --cached --name-only 72960baa
     git diff --exit-code
     ```
   - After commit 1, validate exactly four paths with:
     ```bash
     git diff --name-only 72960baa..HEAD
     ```
   - Remove the unnecessary architecture-map `git restore --staged`.
   - Replace the final ignored-document check with:
     ```bash
     ! git status --porcelain --ignored | grep -q '^!! CDMSS-'
     ```
   - Correct the `.env.local` boolean check to detect an actual key assignment.
   - Require all recorder terms to have executable guards.
   - Replace open-ended mutation instructions with a finite mutation table and full temporary repository sandbox.

3. Pin the selected proof rulings.
   - J3: prove zero Cohere outbound requests through `retrieve`; use J2's injected counters for the separate call-level proof.
   - J1 generic failure: call the real loopback judge and then throw, ensuring both arms produce nonempty byte-identical wire observations before entering the outer failure path.
   - Proof 70: assert runtime health-check-to-judge order and preserve the base-to-commit production byte comparison.
   - Treat `persisted_complete` as validation plus real settlement-state mapping, not a physical database write.

4. Define the test implementation.
   - `judge-server-stub.ts`: opt-in recorder, 1 MiB boundary, acceptance sequencing, busy snapshot/reset refusal, copied snapshots, multiplicity, responder-independent reset, unchanged parsed API.
   - `explicit-judge-equivalence.test.ts`: recorder contract and J1 success, parse-failure, and call-then-throw equivalence.
   - `rerank-pass-2.test.ts`: proofs 2/16/17/18/70 and J2.
   - `explicit-judge-retrieve.test.ts`: J3 and J4 with real loopback judge behavior.
   - Serialize mutable fixtures and restore environment variables, fetch hooks, health state, socket guards, and server state in `finally`.
   - Install a connection guard before dynamic imports that permits only `127.0.0.1` and rejects all TLS/external connections.

5. Revalidate governance before execution.
   - Compare the revised kickoff against revised v15 line by line.
   - Confirm clean synchronized HEAD `72960baa8ba88d618b4eee1c43dc56ecfec58113`.
   - Record revised document hashes.
   - V signs the final revised v15 bytes.
   - Only then may pass 2 implementation begin.
