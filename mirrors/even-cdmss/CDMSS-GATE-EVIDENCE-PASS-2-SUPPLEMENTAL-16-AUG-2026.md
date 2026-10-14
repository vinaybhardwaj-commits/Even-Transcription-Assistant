# CDMSS gate evidence — pass 2 SUPPLEMENTAL, 16 August 2026

Authority: Saul review 29. Addendum v18, signed by V.
Corrective implementation commit (commit 5): fe59b07657d50553f9d535e989b42b92032cf604
Gate run: 2026-08-17T03:27:33Z to 2026-08-17T03:29:09Z UTC, from commit 5.
Mutation table run BEFORE the gate (addendum v18 §4.3), 30 rows, completed
before commit 5 was created; the gate then ran once, from commit 5.

Raw capture directory: $HOME/cdmss-pass2-gate-supplemental-16-aug-2026
(a NEW directory; no existing capture directory was overwritten).
In every command transcript below, stdout and stderr are MERGED (2>&1).

The three .env.local guard facts (these three lines and nothing else from that
file — no value and no other name is printed):

```text
VERCEL=1: true
VERCEL_ENV=production: true
HMAC assignment: false
```

## Part 1 — the mutation table, run BEFORE the gate (addendum v18 §4.3, §5)

Thirty rows: the twenty-two existing rows of kickoff v3 §9.2 (row 5 re-run, which addendum
v17 §4 omitted), plus the eight new rows of addendum v18 §5. Sandbox built per kickoff v3
§9.1 (cp -a, .next/node_modules/.git removed, node_modules symlinked), shape verified
(dotfiles and lib/ present, .git absent), and deleted after the table completed.

Every run: cwd is the WORKTREE and the test file path is the SANDBOX copy, so module imports
resolve to the mutated sandbox code while source-text reads (JUDGE_BATCH, the 70.4 parity
read, and `git show`) stay on the unmutated worktree — no git command runs inside the
sandbox. Each row records the exact unified diff of the mutation, the exact command, the
exit status, and the failing tests BY NAME. No row timed out; every row exited 1 with named
`not ok` lines. stdout and stderr were merged in each capture.

### Row 1 — judge-server-stub.ts: limit constant 1048576 → 1048577. Must fail: the 1048577 rejection test (5.5b).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/__tests__/judge-server-stub.ts	2026-08-17 08:45:50
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/judge-server-stub.ts	2026-08-17 08:55:07
@@ -93,7 +93,7 @@
 }
 
 /** The exact recorder limit (addendum v15 §5.5). 1048576 is accepted; 1048577 is rejected with 413. */
-export const RECORDER_BODY_LIMIT_BYTES = 1048576;
+export const RECORDER_BODY_LIMIT_BYTES = 1048577;
 
 export interface JudgeServer {
   readonly port: number;
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-equivalence.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 5 - 5.5a — the boundary: 1048576 bytes is ACCEPTED and recorded in full
not ok 6 - 5.5b — the boundary: 1048577 bytes is REJECTED with 413, an empty JSON body, an overflowed observation, and the SAME undestroyed socket carries the next request
```

Run summary:

```text
# tests 17
# pass 15
# fail 2
# cancelled 0
```

### Row 2 — judge-server-stub.ts: limit constant 1048576 → 1048575. Must fail: the 1048576 acceptance test (5.5a).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/__tests__/judge-server-stub.ts	2026-08-17 08:45:50
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/judge-server-stub.ts	2026-08-17 08:55:08
@@ -93,7 +93,7 @@
 }
 
 /** The exact recorder limit (addendum v15 §5.5). 1048576 is accepted; 1048577 is rejected with 413. */
-export const RECORDER_BODY_LIMIT_BYTES = 1048576;
+export const RECORDER_BODY_LIMIT_BYTES = 1048575;
 
 export interface JudgeServer {
   readonly port: number;
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-equivalence.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 5 - 5.5a — the boundary: 1048576 bytes is ACCEPTED and recorded in full
```

Run summary:

```text
# tests 17
# pass 16
# fail 1
# cancelled 0
```

### Row 3 — judge-server-stub.ts: snapshot returns the internal array. Must fail: the defensive-snapshot test (5.7).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/__tests__/judge-server-stub.ts	2026-08-17 08:45:50
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/judge-server-stub.ts	2026-08-17 08:55:08
@@ -474,7 +474,7 @@
       // §5.6: refuse while in flight. Do not return partial data; do not wait. Name the count.
       if (inFlight > 0) throw new Error(`snapshot refused: ${inFlight} request(s) in flight`);
       // §5.7: a new array of new objects, each with a COPIED Buffer.
-      return observations.map((o) => ({ ...o, body: Buffer.from(o.body) }));
+      return observations;
     },
     resetObservations() {
       if (inFlight > 0) throw new Error(`resetObservations refused: ${inFlight} request(s) in flight`);
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-equivalence.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 9 - 5.7 — snapshot is DEFENSIVE: mutating the array, an object, or a Buffer leaves recorder state unchanged
not ok 15 - J1.1 — SUCCESS: explicit judge and env-default judge are byte-identical on the wire, in results, and in payload
not ok 16 - J1.2 — REAL BATCH PARSE FAILURE: both arms receive the same malformed completion and record it identically
not ok 17 - J1.3 — GENERIC OUTER JUDGE FAILURE, produced by CALL-THEN-THROW: nonempty and byte-identical wire observations on both arms
```

Run summary:

```text
# tests 17
# pass 13
# fail 4
# cancelled 0
```

### Row 4 — judge-server-stub.ts: snapshot returns the same Buffer, not a copy. Must fail: the buffer-copy test (5.7).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/__tests__/judge-server-stub.ts	2026-08-17 08:45:50
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/judge-server-stub.ts	2026-08-17 08:55:08
@@ -474,7 +474,7 @@
       // §5.6: refuse while in flight. Do not return partial data; do not wait. Name the count.
       if (inFlight > 0) throw new Error(`snapshot refused: ${inFlight} request(s) in flight`);
       // §5.7: a new array of new objects, each with a COPIED Buffer.
-      return observations.map((o) => ({ ...o, body: Buffer.from(o.body) }));
+      return observations.map((o) => ({ ...o }));
     },
     resetObservations() {
       if (inFlight > 0) throw new Error(`resetObservations refused: ${inFlight} request(s) in flight`);
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-equivalence.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 9 - 5.7 — snapshot is DEFENSIVE: mutating the array, an object, or a Buffer leaves recorder state unchanged
```

Run summary:

```text
# tests 17
# pass 16
# fail 1
# cancelled 0
```

### Row 5 — judge-server-stub.ts: assign seq at response end, not at acceptance. Must fail: the acceptance-sequencing test (5.4). RE-RUN per addendum v18 §5 — v17 §4 omitted it after 5.4 changed in 9344cdb.

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/__tests__/judge-server-stub.ts	2026-08-17 08:45:50
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/judge-server-stub.ts	2026-08-17 08:55:09
@@ -330,7 +330,7 @@
     // ── ACCEPTANCE (v15 §5.4, §5.6). The sequence number and the in-flight increment happen HERE,
     // before a single body byte has arrived. A request that arrives first is numbered first even if
     // it finishes last. Neither advances while recording is off (§5.2).
-    const seq = recording ? nextSeq++ : -1;
+    const seq = -1;
     // The socket identity is assigned at ACCEPTANCE, beside `seq` (v18 §4.2). `req.socket` is live
     // at this hook point; the WeakMap hands the same identity back for every request the same
     // undestroyed socket carries.
@@ -364,7 +364,7 @@
       const raw = Buffer.concat(chunks);
       if (recording) {
         observations.push({
-          seq, socketId, method: String(req.method ?? ''), path: String(req.url ?? ''),
+          seq: recording ? nextSeq++ : -1, socketId, method: String(req.method ?? ''), path: String(req.url ?? ''),
           body: overflowed ? Buffer.alloc(0) : raw, overflowed,
         });
       }
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-equivalence.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 4 - 5.4 — sequence numbers are assigned at ACCEPTANCE, monotonic from 0, and never reused
```

Run summary:

```text
# tests 17
# pass 16
# fail 1
# cancelled 0
```

### Row 6 — judge-server-stub.ts: snapshot returns partial data instead of throwing while in flight. Must fail: the in-flight snapshot test (5.6).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/__tests__/judge-server-stub.ts	2026-08-17 08:45:50
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/judge-server-stub.ts	2026-08-17 08:55:09
@@ -472,7 +472,6 @@
     setRecording(on) { recording = on; },
     snapshot() {
       // §5.6: refuse while in flight. Do not return partial data; do not wait. Name the count.
-      if (inFlight > 0) throw new Error(`snapshot refused: ${inFlight} request(s) in flight`);
       // §5.7: a new array of new objects, each with a COPIED Buffer.
       return observations.map((o) => ({ ...o, body: Buffer.from(o.body) }));
     },
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-equivalence.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 7 - 5.6 — while a request is in flight, BOTH snapshot and resetObservations throw, naming the count
```

Run summary:

```text
# tests 17
# pass 16
# fail 1
# cancelled 0
```

### Row 7 — judge-server-stub.ts: resetObservations succeeds instead of throwing while in flight. Must fail: the in-flight reset test (5.6).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/__tests__/judge-server-stub.ts	2026-08-17 08:45:50
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/judge-server-stub.ts	2026-08-17 08:55:09
@@ -477,7 +477,6 @@
       return observations.map((o) => ({ ...o, body: Buffer.from(o.body) }));
     },
     resetObservations() {
-      if (inFlight > 0) throw new Error(`resetObservations refused: ${inFlight} request(s) in flight`);
       // §5.4, §5.10: observations and the counter, and NOTHING else. Scores, raw content, usage
       // inclusion, expansion text, embedding override and chat discrimination are not touched.
       observations.length = 0;
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-equivalence.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 7 - 5.6 — while a request is in flight, BOTH snapshot and resetObservations throw, naming the count
```

Run summary:

```text
# tests 17
# pass 16
# fail 1
# cancelled 0
```

### Row 8 — judge-server-stub.ts: resetObservations also clears the scores map. Must fail: the reset-independence test (5.10).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/__tests__/judge-server-stub.ts	2026-08-17 08:45:50
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/judge-server-stub.ts	2026-08-17 08:55:10
@@ -480,7 +480,7 @@
       if (inFlight > 0) throw new Error(`resetObservations refused: ${inFlight} request(s) in flight`);
       // §5.4, §5.10: observations and the counter, and NOTHING else. Scores, raw content, usage
       // inclusion, expansion text, embedding override and chat discrimination are not touched.
-      observations.length = 0;
+      observations.length = 0; scores = {};
       nextSeq = 0;
     },
     inFlight() { return inFlight; },
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-equivalence.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 13 - 5.10 — resetObservations clears observations and the counter and NOTHING in responder configuration
not ok 15 - J1.1 — SUCCESS: explicit judge and env-default judge are byte-identical on the wire, in results, and in payload
```

Run summary:

```text
# tests 17
# pass 15
# fail 2
# cancelled 0
```

### Row 9 — judge-server-stub.ts: deduplicate identical observations. Must fail: the multiplicity test (5.8).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/__tests__/judge-server-stub.ts	2026-08-17 08:45:50
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/judge-server-stub.ts	2026-08-17 08:55:10
@@ -363,7 +363,7 @@
       // themselves; `snapshot` copies them on the way out (§5.7).
       const raw = Buffer.concat(chunks);
       if (recording) {
-        observations.push({
+        if (!observations.some((x) => x.path === String(req.url ?? '') && x.method === String(req.method ?? '') && x.body.equals(overflowed ? Buffer.alloc(0) : raw))) observations.push({
           seq, socketId, method: String(req.method ?? ''), path: String(req.url ?? ''),
           body: overflowed ? Buffer.alloc(0) : raw, overflowed,
         });
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-equivalence.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 10 - 5.8 — two identical requests produce two observations; the recorder never deduplicates
```

Run summary:

```text
# tests 17
# pass 16
# fail 1
# cancelled 0
```

### Row 10 — judge-server-stub.ts: respond 200 instead of 413 on overflow. Must fail: the overflow status test (5.5b).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/__tests__/judge-server-stub.ts	2026-08-17 08:45:50
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/judge-server-stub.ts	2026-08-17 08:55:11
@@ -371,7 +371,7 @@
       // ── OVERFLOW (v15 §5.5): HTTP 413, an empty JSON object, response ended normally, socket
       // NOT destroyed. The parsed path below never runs for an overflowing request.
       if (overflowed) {
-        res.writeHead(413, { 'content-type': 'application/json' });
+        res.writeHead(200, { 'content-type': 'application/json' });
         res.end('{}');
         return;
       }
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-equivalence.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 6 - 5.5b — the boundary: 1048577 bytes is REJECTED with 413, an empty JSON body, an overflowed observation, and the SAME undestroyed socket carries the next request
```

Run summary:

```text
# tests 17
# pass 16
# fail 1
# cancelled 0
```

### Row 11 — judge-server-stub.ts: record an observation while recording is off. Must fail: the opt-in test (5.2).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/__tests__/judge-server-stub.ts	2026-08-17 08:45:50
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/judge-server-stub.ts	2026-08-17 08:55:11
@@ -362,7 +362,7 @@
       // method, path and body come from one place. The Buffer stored is the concatenated bytes
       // themselves; `snapshot` copies them on the way out (§5.7).
       const raw = Buffer.concat(chunks);
-      if (recording) {
+      if (true) {
         observations.push({
           seq, socketId, method: String(req.method ?? ''), path: String(req.url ?? ''),
           body: overflowed ? Buffer.alloc(0) : raw, overflowed,
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-equivalence.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 2 - 5.2 — recording is OFF by default: no observation is stored and the counter does not advance
```

Run summary:

```text
# tests 17
# pass 16
# fail 1
# cancelled 0
```

### Row 12 — judge-server-stub.ts: store a header value on the observation. Must fail: the no-headers test (5.3).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/__tests__/judge-server-stub.ts	2026-08-17 08:45:50
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/judge-server-stub.ts	2026-08-17 08:55:11
@@ -364,7 +364,7 @@
       const raw = Buffer.concat(chunks);
       if (recording) {
         observations.push({
-          seq, socketId, method: String(req.method ?? ''), path: String(req.url ?? ''),
+          seq, socketId, authHeader: String(req.headers.authorization ?? ''), method: String(req.method ?? ''), path: String(req.url ?? ''),
           body: overflowed ? Buffer.alloc(0) : raw, overflowed,
         });
       }
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-equivalence.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 3 - 5.3 — one observation holds seq, socketId, method, path, and the exact body bytes; nothing else
```

Run summary:

```text
# tests 17
# pass 16
# fail 1
# cancelled 0
```

### Row 13 — judge-server-stub.ts: compare batches by arrival order, not marker set. Must fail: the marker-identity test (5.9).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/__tests__/judge-server-stub.ts	2026-08-17 08:45:50
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/judge-server-stub.ts	2026-08-17 08:55:12
@@ -206,7 +206,7 @@
     const out = new Map<string, Buffer[]>();
     for (const o of xs) {
       const text = o.body.toString('utf8');
-      const key = markers.filter((mk) => text.includes(mk)).sort().join('|');
+      const key = String(o.seq);
       const tuple = Buffer.concat([Buffer.from(o.method, 'utf8'), Buffer.from(o.path, 'utf8'), Buffer.from([0]), o.body]);
       const list = out.get(key) ?? [];
       list.push(tuple);
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-equivalence.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 11 - 5.9 — comparison groups by marker SET, not arrival order
not ok 12 - 5.9b — the comparator keeps method, path and body as ONE tuple: a swap between marker groups is a difference
```

Run summary:

```text
# tests 17
# pass 15
# fail 2
# cancelled 0
```

### Row 14 — judge-server-stub.ts: push a recorder field onto JudgeRequest and populate it. Must fail: the parsed-API test (5.11).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/__tests__/judge-server-stub.ts	2026-08-17 08:45:50
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/judge-server-stub.ts	2026-08-17 08:55:12
@@ -417,7 +417,7 @@
         .map((s) => known.find((k) => s.text.includes(k)) ?? '');
 
       requests.push({
-        kind: isExpansion ? 'expansion' : 'judge',
+        kind: isExpansion ? 'expansion' : 'judge', seq: nextSeq,
         url, model: String(body.model ?? ''), system, user,
         temperature: Number(body.temperature), maxTokens: Number(body.max_tokens), markers,
       });
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-equivalence.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 14 - 5.11 — the parsed `requests` API is unchanged: same fields, same push sites, same arrival order, and JudgeRequest gains no field
```

Run summary:

```text
# tests 17
# pass 16
# fail 1
# cancelled 0
```

### Row 15 — rerank.ts (sandbox): hoist checkHealthy above the chosen === cohere branch. Must fail: J2 (J2.1, J2.2).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/rerank.ts	2026-08-15 20:58:10
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/rerank.ts	2026-08-17 08:55:12
@@ -444,6 +444,7 @@
 
   // D2 — ENV-DEFAULT cohere: resilient cohere → judge → input-order. Typed backend errors are CAUGHT
   // (never thrown); each downgrade is logged. Applies ONLY when the backend was not passed explicitly.
+  await checkHealthy('cohere');
   if (chosen === 'cohere' && !explicit) {
     try {
       await checkHealthy('cohere');                       // memoized probe (D6); throws typed on unhealth
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/rerank-pass-2.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 4 - 17.1 — a per-batch throw inside rerankJudge warns, continues, and leaves rerank_soft_failed FALSE
not ok 5 - 18.1 — JUDGE served: expected_batch_count == ceil(pool / JUDGE_BATCH), JUDGE_BATCH read from source text
not ok 7 - 18.3 — DERIVED FROM served_backend, NEVER intended_backend: intended Cohere, judge serves, expected is the JUDGE count
not ok 8 - 70.1 — RUNTIME ORDER, observed AT INVOCATION: checkHealthy throws RerankBackendError FIRST, the judge is invoked SECOND
not ok 9 - 70.2 — MANIFEST FACTS: intended_backend cohere, served_backend judge, rerank_backend_downgraded true, expected_batch_count matches the judge
not ok 10 - 70.3 — the row is persisted_complete by the REAL chain, and a broken payload is persisted_partial
not ok 12 - J2.1 — under a JUDGE default: explicit judge, on success and on failure, calls neither checkHealthy nor cohereFn
not ok 13 - J2.2 — under a HOSTILE COHERE default: explicit judge, on success and on failure, still calls neither — and each failure arm PROVES its failure happened
```

Run summary:

```text
# tests 13
# pass 5
# fail 8
# cancelled 0
```

### Row 16 — rerank.ts (sandbox): explicit judge arm calls cohereFn instead of judgeFn. Must fail: J2 (J2.1, J2.2).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/rerank.ts	2026-08-15 20:58:10
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/rerank.ts	2026-08-17 08:55:13
@@ -480,7 +480,7 @@
       await checkHealthy('cohere');                       // explicit cohere is STRICT — probe first
       return await cohereFn(query, candidates, capture);
     }
-    return await judgeFn(query, candidates, capture);
+    return await cohereFn(query, candidates, capture);
   } catch (e) {
     if (e instanceof RerankBackendError) throw e;   // explicit cohere typed error → propagate (never fall back)
     console.warn('[rerank] backend failed, returning input order', (e as Error).message);
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/rerank-pass-2.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 4 - 17.1 — a per-batch throw inside rerankJudge warns, continues, and leaves rerank_soft_failed FALSE
not ok 5 - 18.1 — JUDGE served: expected_batch_count == ceil(pool / JUDGE_BATCH), JUDGE_BATCH read from source text
not ok 12 - J2.1 — under a JUDGE default: explicit judge, on success and on failure, calls neither checkHealthy nor cohereFn
not ok 13 - J2.2 — under a HOSTILE COHERE default: explicit judge, on success and on failure, still calls neither — and each failure arm PROVES its failure happened
```

Run summary:

```text
# tests 13
# pass 9
# fail 4
# cancelled 0
```

### Row 17 — rerank.ts (sandbox): in the env-default arm, call the judge before checkHealthy. Must fail: proof 70 order (70.1, where the order assertion now lives — this row also covers the new at-invocation order log, per v18 §5 note 2).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/rerank.ts	2026-08-15 20:58:10
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/rerank.ts	2026-08-17 08:55:13
@@ -446,6 +446,7 @@
   // (never thrown); each downgrade is logged. Applies ONLY when the backend was not passed explicitly.
   if (chosen === 'cohere' && !explicit) {
     try {
+      await judgeFn(query, candidates, capture);
       await checkHealthy('cohere');                       // memoized probe (D6); throws typed on unhealth
       return await cohereFn(query, candidates, capture);
     } catch (e) {
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/rerank-pass-2.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 8 - 70.1 — RUNTIME ORDER, observed AT INVOCATION: checkHealthy throws RerankBackendError FIRST, the judge is invoked SECOND
not ok 9 - 70.2 — MANIFEST FACTS: intended_backend cohere, served_backend judge, rerank_backend_downgraded true, expected_batch_count matches the judge
not ok 10 - 70.3 — the row is persisted_complete by the REAL chain, and a broken payload is persisted_partial
```

Run summary:

```text
# tests 13
# pass 10
# fail 3
# cancelled 0
```

### Row 18 — rerank.ts (sandbox): rerankJudge stamps expectedBatchCount from intendedBackend. Must fail: proof 18 (18.3).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/rerank.ts	2026-08-15 20:58:10
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/rerank.ts	2026-08-17 08:55:13
@@ -565,7 +565,7 @@
     // fall-through this overwrites the intended count of 1 with the judge's real N, which is the
     // whole point: otherwise every downgraded row is partial by construction.
     capture.servedBackend = 'judge';
-    capture.expectedBatchCount = batches.length;
+    capture.expectedBatchCount = capture.intendedBackend === 'cohere' ? 1 : batches.length;
   }
 
   await Promise.all(batches.map(async ({ start, end }, batchIndex) => {
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/rerank-pass-2.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 7 - 18.3 — DERIVED FROM served_backend, NEVER intended_backend: intended Cohere, judge serves, expected is the JUDGE count
not ok 9 - 70.2 — MANIFEST FACTS: intended_backend cohere, served_backend judge, rerank_backend_downgraded true, expected_batch_count matches the judge
not ok 10 - 70.3 — the row is persisted_complete by the REAL chain, and a broken payload is persisted_partial
```

Run summary:

```text
# tests 13
# pass 10
# fail 3
# cancelled 0
```

### Row 19 — rerank.ts (sandbox): the per-batch containment inside rerankJudge is removed — the catch rethrows instead of containing, functionally equivalent to deleting the try/catch. Must fail: proof 17 (17.1).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/rerank.ts	2026-08-15 20:58:10
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/rerank.ts	2026-08-17 08:55:14
@@ -641,7 +641,7 @@
     } catch (e) {
       // Batch failed — leave those scores at 0 (will sort to bottom).
       // Soft fail is OK because we still have the input order as tiebreaker downstream.
-      console.warn('[rerank judge] batch failed', start, '-', end, (e as Error).message);
+      throw e;
       if (!evidence) evidence = evidenceFromError(e);
       missing = slice.length - finite;
       outcome = parseFailed ? 'parse_failure' : terminalOutcomeFor(evidence);
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/rerank-pass-2.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 4 - 17.1 — a per-batch throw inside rerankJudge warns, continues, and leaves rerank_soft_failed FALSE
not ok 13 - J2.2 — under a HOSTILE COHERE default: explicit judge, on success and on failure, still calls neither — and each failure arm PROVES its failure happened
```

Run summary:

```text
# tests 13
# pass 11
# fail 2
# cancelled 0
```

### Row 20 — retrieve.ts (sandbox): pass undefined instead of opts.rerankBackend to rerank. Must fail: J3 explicit arm (J3.2).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/retrieve.ts	2026-08-12 05:44:28
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/retrieve.ts	2026-08-17 08:55:14
@@ -586,7 +586,7 @@
       id: h.id,
       text: h.text,
       __orig: h,
-    })), opts.rerankBackend, undefined, capture);
+    })), undefined, undefined, capture);
     hits = reranked.map((r) => {
       const orig = (r as unknown as { __orig: ChunkHitWithMeta }).__orig;
       return {
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-retrieve.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 3 - J3.2 — EXPLICIT-JUDGE ARM: zero Cohere outbound requests, judge intent, judge service, no downgrade, nonzero batches, actual reordering
```

Run summary:

```text
# tests 5
# pass 4
# fail 1
# cancelled 0
```

### Row 21 — multi-query.ts (sandbox): set useReranker: true on the retrieval arms. Must fail: J4 arms (J4.1).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/multi-query.ts	2026-08-12 13:42:36
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/multi-query.ts	2026-08-17 08:55:14
@@ -271,7 +271,7 @@
     // rank) — provenance ONLY, it changes nothing retrieved or ranked. Fusion reads it below so a
     // chunk that arrived via a LATER variant's BM25 leg keeps its attribution.
     allQueries.map((q, vi) =>
-      retrieveFn(q, { ...opts, topK: perVariantK, skipExpand: true, useReranker: false, useSourceWeights: false, withDiagnostics: true }, armCaptures?.[vi])
+      retrieveFn(q, { ...opts, topK: perVariantK, skipExpand: true, useReranker: true, useSourceWeights: false, withDiagnostics: true }, armCaptures?.[vi])
         .then((r) => {
           // One of the four sites that swallow a retrieval exception into an empty hit list. The
           // three outcomes are DISCRIMINATED here (§4.3): a variant that found nothing and a
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-retrieve.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 4 - J4.1 — every retrieval arm is called with useReranker OFF; exactly ONE fusion-level rerank; its third argument is the value passed as opts.rerankBackend
not ok 5 - J4.2 — the fusion rerank happens ONCE even when the arms return overlapping pools; no arm-level rerank stamps a batch
```

Run summary:

```text
# tests 5
# pass 3
# fail 2
# cancelled 0
```

### Row 22 — multi-query.ts (sandbox): add a second fusion-level rerank call. Must fail: J4 exactly-one (J4.1, J4.2).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/multi-query.ts	2026-08-12 13:42:36
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/multi-query.ts	2026-08-17 08:55:15
@@ -360,6 +360,7 @@
   if (useReranker && fused.length > 1) {
     // D4: `deps` is the fourth parameter of rerank(), so the capture needs its placeholder.
     const reranked = await rerankFn(question, fused.map((h) => ({ id: h.id, text: h.text, __orig: h })), opts.rerankBackend, undefined, capture);
+    await rerankFn(question, fused.map((h) => ({ id: h.id, text: h.text, __orig: h })), opts.rerankBackend, undefined, capture);
     fused = reranked.map((r) => {
       const orig = (r as unknown as { __orig: FusionHit }).__orig;
       return { ...orig, rerank_score: r.rerank_score, rerank_backend: r.rerank_backend };
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-retrieve.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 4 - J4.1 — every retrieval arm is called with useReranker OFF; exactly ONE fusion-level rerank; its third argument is the value passed as opts.rerankBackend
not ok 5 - J4.2 — the fusion rerank happens ONCE even when the arms return overlapping pools; no arm-level rerank stamps a batch
```

Run summary:

```text
# tests 5
# pass 3
# fail 2
# cancelled 0
```

### Row 23 — retrieval-telemetry-core.ts (sandbox): validateManifest returns [] unconditionally. Must fail: the DIRTY arm of proofs 16 and 70 (16.1, 70.3). The clean arms cannot see this mutation by design — v18 §5 note 1.

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/retrieval-telemetry-core.ts	2026-08-16 06:53:06
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/retrieval-telemetry-core.ts	2026-08-17 08:55:15
@@ -656,6 +656,7 @@
  * meant to prove is a validator that proves nothing.
  */
 export function validateManifest(input: unknown): string[] {
+  return [];
   const v: string[] = [];
   if (!input || typeof input !== 'object') return ['manifest_absent'];
   const m = input as Record<string, unknown>;
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/rerank-pass-2.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 3 - 16.1 — Cohere selected, an UNTYPED throw: inputOrder returned, one synthesised terminal_failure batch, expected == recorded, soft_failed true, row not partial — by the REAL validation chain, both arms
not ok 10 - 70.3 — the row is persisted_complete by the REAL chain, and a broken payload is persisted_partial
```

Run summary:

```text
# tests 13
# pass 11
# fail 2
# cancelled 0
```

### Row 24 — judge-server-stub.ts: sameWireObservations drops path from the tuple. Must fail: the new J1 path-swap test (5.9b).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/__tests__/judge-server-stub.ts	2026-08-17 08:45:50
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/judge-server-stub.ts	2026-08-17 08:55:15
@@ -207,7 +207,7 @@
     for (const o of xs) {
       const text = o.body.toString('utf8');
       const key = markers.filter((mk) => text.includes(mk)).sort().join('|');
-      const tuple = Buffer.concat([Buffer.from(o.method, 'utf8'), Buffer.from(o.path, 'utf8'), Buffer.from([0]), o.body]);
+      const tuple = Buffer.concat([Buffer.from(o.method, 'utf8'), Buffer.from([0]), o.body]);
       const list = out.get(key) ?? [];
       list.push(tuple);
       out.set(key, list);
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-equivalence.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 12 - 5.9b — the comparator keeps method, path and body as ONE tuple: a swap between marker groups is a difference
```

Run summary:

```text
# tests 17
# pass 16
# fail 1
# cancelled 0
```

### Row 25 — rerank.ts (sandbox): rerankCohere stamps expectedBatchCount = 2. Must fail: proof 18 Cohere arm (18.2).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/rerank.ts	2026-08-15 20:58:10
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/rerank.ts	2026-08-17 08:55:16
@@ -252,7 +252,7 @@
     // chatWithFallback, so there is no transport attribution to read: a returned score array IS
     // the evidence that it served, and the class is recorded from that rather than guessed.
     capture.servedBackend = 'cohere';
-    capture.expectedBatchCount = 1;
+    capture.expectedBatchCount = 2;
     // Cohere is a deterministic cross-encoder: it takes neither a temperature nor a seed, and the
     // request body carries neither. Null and `not_applicable` are the accurate values, not zeros.
     capture.rerankTemperature = null;
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/rerank-pass-2.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 1 - 2.1 — rerankCohere with an injected fetchImpl serves, stamps the capture, and opens no real socket
not ok 6 - 18.2 — COHERE served: expected_batch_count == 1, whatever the pool — stamped by the REAL rerankCohere
```

Run summary:

```text
# tests 13
# pass 11
# fail 2
# cancelled 0
```

### Row 26 — rerank.ts (sandbox): the default adapter passes the capture as fetchImpl. Must fail: proof 2.2.

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/rerank.ts	2026-08-15 20:58:10
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/rerank.ts	2026-08-17 08:55:16
@@ -358,7 +358,7 @@
   const chosen = resolveRerankBackend(backend, deps.envBackend ?? BACKEND);
   const cohereFn = deps.cohereFn ?? (<U extends RerankCandidate>(
     q: string, c: U[], cap?: TelemetryCapture,
-  ) => rerankCohere(q, c, undefined, undefined, cap));
+  ) => rerankCohere(q, c, cap, undefined, undefined));
   const judgeFn = deps.judgeFn ?? rerankJudge;
   const checkHealthy = deps.checkHealthy ?? assertRerankBackendHealthy;
 
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/rerank-pass-2.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 2 - 2.2 — the DEFAULT cohereFn adapter inside rerank passes the capture in the CAPTURE position, not the fetch position
```

Run summary:

```text
# tests 13
# pass 12
# fail 1
# cancelled 0
```

### Row 27 — rerank.ts (sandbox): the parse-failure path records success. Must fail: J2 parse-failure arm (J2.2).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/rerank.ts	2026-08-15 20:58:10
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/rerank.ts	2026-08-17 08:55:16
@@ -644,7 +644,7 @@
       console.warn('[rerank judge] batch failed', start, '-', end, (e as Error).message);
       if (!evidence) evidence = evidenceFromError(e);
       missing = slice.length - finite;
-      outcome = parseFailed ? 'parse_failure' : terminalOutcomeFor(evidence);
+      outcome = parseFailed ? 'success' : terminalOutcomeFor(evidence);
     }
 
     if (capture) {
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/rerank-pass-2.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 4 - 17.1 — a per-batch throw inside rerankJudge warns, continues, and leaves rerank_soft_failed FALSE
not ok 13 - J2.2 — under a HOSTILE COHERE default: explicit judge, on success and on failure, still calls neither — and each failure arm PROVES its failure happened
```

Run summary:

```text
# tests 13
# pass 11
# fail 2
# cancelled 0
```

### Row 28 — judge-server-stub.ts: each request is given a fresh socket identity. Must fail: the socket-reuse test (5.5b).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/__tests__/judge-server-stub.ts	2026-08-17 08:45:50
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/judge-server-stub.ts	2026-08-17 08:55:17
@@ -334,7 +334,7 @@
     // The socket identity is assigned at ACCEPTANCE, beside `seq` (v18 §4.2). `req.socket` is live
     // at this hook point; the WeakMap hands the same identity back for every request the same
     // undestroyed socket carries.
-    const socketId = recording ? socketIdentityOf(req.socket) : -1;
+    const socketId = recording ? nextSocketId++ : -1;
     if (recording) inFlight += 1;
     let received = 0;
     let overflowed = false;
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-equivalence.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 6 - 5.5b — the boundary: 1048577 bytes is REJECTED with 413, an empty JSON body, an overflowed observation, and the SAME undestroyed socket carries the next request
```

Run summary:

```text
# tests 17
# pass 16
# fail 1
# cancelled 0
```

### Row 29 — judge-server-stub.ts: a symbol-keyed field whose description matches the header regex, Symbol(x-authorization-header). Must fail: the no-headers check (5.3).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/__tests__/judge-server-stub.ts	2026-08-17 08:45:50
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/judge-server-stub.ts	2026-08-17 08:55:17
@@ -364,7 +364,7 @@
       const raw = Buffer.concat(chunks);
       if (recording) {
         observations.push({
-          seq, socketId, method: String(req.method ?? ''), path: String(req.url ?? ''),
+          seq, socketId, [Symbol('x-authorization-header')]: 'leaked', method: String(req.method ?? ''), path: String(req.url ?? ''),
           body: overflowed ? Buffer.alloc(0) : raw, overflowed,
         });
       }
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-equivalence.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 3 - 5.3 — one observation holds seq, socketId, method, path, and the exact body bytes; nothing else
```

Run summary:

```text
# tests 17
# pass 16
# fail 1
# cancelled 0
```

### Row 30 — multi-query.ts (sandbox): allQueries drops one variant. Must fail: J4 arm count (J4.2).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/multi-query.ts	2026-08-12 13:42:36
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/multi-query.ts	2026-08-17 08:55:18
@@ -246,7 +246,7 @@
     };
   }
   // index 0 = the ORIGINAL arm, retrieving on the EXPANDED text; 1..N = variants on raw variant text.
-  const allQueries = [expandedQuery, ...variants];
+  const allQueries = [expandedQuery, ...variants.slice(1)];
 
   const variantOutcomes: Array<{ index: number; outcome: VariantOutcome; candidateCount: number }> = [];
   /**
```

Command and exit status:

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-retrieve.test.ts
exit=1
```

Failing tests, by name:

```text
not ok 4 - J4.1 — every retrieval arm is called with useReranker OFF; exactly ONE fusion-level rerank; its third argument is the value passed as opts.rerankBackend
not ok 5 - J4.2 — the fusion rerank happens ONCE even when the arms return overlapping pools; no arm-level rerank stamps a batch
```

Run summary:

```text
# tests 5
# pass 3
# fail 2
# cancelled 0
```

Every row discriminated: each failed its named test by name, and no row was accepted on a
file-level timeout. Full raw per-row outputs are preserved in the capture directory
`$HOME/cdmss-pass2-gate-supplemental-16-aug-2026/mutation/` (row-NN-output.txt).

---

## Part 2 — the gate, nine numbered commands and the build pair

Commands ran STRICTLY in order; no command started until the previous one had
exited (a single sequential shell script enforced this; the per-command
STARTED/ENDED timestamps in each transcript show it). Command 6 follows
addendum v18 §4.1: `git add` is REMOVED; the five-line replacement proves
determinism (`cmp` of generation two against generation one) and currency
(`git diff --exit-code` of the committed map) with no git write.

### git status before the gate

```text
COMMAND: git status --porcelain
EXIT: 0
COMMAND: git status --porcelain --ignored
!! .env.local
!! .next/
!! .vercel/
!! CDMSS-RERANK-TELEMETRY-ADDENDUM-v18-16-AUG-2026.md
!! CDMSS-SAUL-REVIEW-29-16-AUG-2026.md
!! next-env.d.ts
!! node_modules/
!! tsconfig.tsbuildinfo
EXIT: 0
```

### Command 1 — npm test

```text
COMMAND: npm test
STARTED: 2026-08-17T03:27:33Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 test
> node --test --import tsx "lib/**/__tests__/*.test.ts"

TAP version 13
# Subtest: verdict normalization maps each store vocab into the right family; needs_action & faithful-as-TP are refused
ok 1 - verdict normalization maps each store vocab into the right family; needs_action & faithful-as-TP are refused
  ---
  duration_ms: 0.723625
  type: 'test'
  ...
# Subtest: precision = (TP+ValidExtra)/(TP+ValidExtra+False); Nitpick/Contested excluded from the denominator
ok 2 - precision = (TP+ValidExtra)/(TP+ValidExtra+False); Nitpick/Contested excluded from the denominator
  ---
  duration_ms: 0.318625
  type: 'test'
  ...
# Subtest: precision groups by SURFACE (headline); engine version is the drill-in — same convention
ok 3 - precision groups by SURFACE (headline); engine version is the drill-in — same convention
  ---
  duration_ms: 14.591125
  type: 'test'
  ...
# Subtest: two-page split at the DATA layer: selectFinding drops fidelity; selectFidelity drops finding
ok 4 - two-page split at the DATA layer: selectFinding drops fidelity; selectFidelity drops finding
  ---
  duration_ms: 0.495083
  type: 'test'
  ...
# Subtest: fidelity is NEVER folded into precision — separate rollup, own family
ok 5 - fidelity is NEVER folded into precision — separate rollup, own family
  ---
  duration_ms: 0.798958
  type: 'test'
  ...
# Subtest: GUARDRAIL: no machine/judge verdict store is in the federation set
ok 6 - GUARDRAIL: no machine/judge verdict store is in the federation set
  ---
  duration_ms: 0.881875
  type: 'test'
  ...
# Subtest: ADVISORY: no rollup keys by reviewer — two reviewers on the same (surface,engine) collapse
ok 7 - ADVISORY: no rollup keys by reviewer — two reviewers on the same (surface,engine) collapse
  ---
  duration_ms: 1.127375
  type: 'test'
  ...
# Subtest: ADVISORY: neither the core nor the surface aggregates a per-reviewer accuracy scorecard
ok 8 - ADVISORY: neither the core nor the surface aggregates a per-reviewer accuracy scorecard
  ---
  duration_ms: 1.687708
  type: 'test'
  ...
# Subtest: the two-page split is enforced in the SOURCE — ledger renders no fidelity, fidelity renders no precision
ok 9 - the two-page split is enforced in the SOURCE — ledger renders no fidelity, fidelity renders no precision
  ---
  duration_ms: 0.419666
  type: 'test'
  ...
# Subtest: a name is required and must survive a trim at >= 2 characters
ok 10 - a name is required and must survive a trim at >= 2 characters
  ---
  duration_ms: 0.949833
  type: 'test'
  ...
# Subtest: PERSISTED VERBATIM — trimmed and capped, never title-cased or matched to a roster
ok 11 - PERSISTED VERBATIM — trimmed and capped, never title-cased or matched to a roster
  ---
  duration_ms: 0.095125
  type: 'test'
  ...
# Subtest: THE RULE: no browser storage API is referenced from ANY of the three surfaces
ok 12 - THE RULE: no browser storage API is referenced from ANY of the three surfaces
  ---
  duration_ms: 0.453167
  type: 'test'
  ...
# Subtest: the storage helpers and the key are GONE from the shared module
ok 13 - the storage helpers and the key are GONE from the shared module
  ---
  duration_ms: 0.12175
  type: 'test'
  ...
# Subtest: EACH FIELD RENDERS EMPTY ON MOUNT — no default, no "last used" hint
ok 14 - EACH FIELD RENDERS EMPTY ON MOUNT — no default, no "last used" hint
  ---
  duration_ms: 1.213875
  type: 'test'
  ...
# Subtest: the name is still typed fresh and still sent by all three surfaces
ok 15 - the name is still typed fresh and still sent by all three surfaces
  ---
  duration_ms: 0.078209
  type: 'test'
  ...
# Subtest: THE SAFETY PROPERTY: every route rejects a missing name, not just the UI
ok 16 - THE SAFETY PROPERTY: every route rejects a missing name, not just the UI
  ---
  duration_ms: 0.064125
  type: 'test'
  ...
# Subtest: the routes persist the CLEANED value, not the raw body field
ok 17 - the routes persist the CLEANED value, not the raw body field
  ---
  duration_ms: 0.057125
  type: 'test'
  ...
# Subtest: the UI disables the action until BOTH rationale and name are filled
ok 18 - the UI disables the action until BOTH rationale and name are filled
  ---
  duration_ms: 0.432791
  type: 'test'
  ...
# Subtest: the name is actually SENT by all three surfaces
ok 19 - the name is actually SENT by all three surfaces
  ---
  duration_ms: 0.526959
  type: 'test'
  ...
# Subtest: the round-trip guarantee is NOT weakened — a zero-diff re-upload still demands nothing
ok 20 - the round-trip guarantee is NOT weakened — a zero-diff re-upload still demands nothing
  ---
  duration_ms: 0.07075
  type: 'test'
  ...
# Subtest: THE LABEL IS HONEST: "Your name", and the helper text says it is self-declared
ok 21 - THE LABEL IS HONEST: "Your name", and the helper text says it is self-declared
  ---
  duration_ms: 0.060333
  type: 'test'
  ...
# Subtest: nothing anywhere implies authentication
ok 22 - nothing anywhere implies authentication
  ---
  duration_ms: 0.412417
  type: 'test'
  ...
# Subtest: NO MIGRATION WAS CREATED for Phase D
ok 23 - NO MIGRATION WAS CREATED for Phase D
  ---
  duration_ms: 0.693125
  type: 'test'
  ...
# Subtest: NO BACKFILL — existing Unknown/null rows are never rewritten or substituted on read
ok 24 - NO BACKFILL — existing Unknown/null rows are never rewritten or substituted on read
  ---
  duration_ms: 0.373583
  type: 'test'
  ...
# Subtest: D-3 KEPT: a name-only edit is savable, so an old review can gain an author
ok 25 - D-3 KEPT: a name-only edit is savable, so an old review can gain an author
  ---
  duration_ms: 0.046708
  type: 'test'
  ...
# Subtest: the shared error message is the one users actually see, and names no roster
ok 26 - the shared error message is the one users actually see, and names no roster
  ---
  duration_ms: 0.278583
  type: 'test'
  ...
# Subtest: semantics \#4: a DOWNGRADE adjudication preserves every original evidence field
ok 27 - semantics \#4: a DOWNGRADE adjudication preserves every original evidence field
  ---
  duration_ms: 0.977583
  type: 'test'
  ...
# Subtest: semantics \#4: a DROP adjudication still records the original finding_ref in the ledger (auditability)
ok 28 - semantics \#4: a DROP adjudication still records the original finding_ref in the ledger (auditability)
  ---
  duration_ms: 0.183583
  type: 'test'
  ...
# Subtest: semantics \#4: adjudication never MUTATES the original finding object
ok 29 - semantics \#4: adjudication never MUTATES the original finding object
  ---
  duration_ms: 0.182333
  type: 'test'
  ...
# Subtest: semantics \#5a: the advisory CONTEXT_STYLE palette is disjoint from the scored-band palette
ok 30 - semantics \#5a: the advisory CONTEXT_STYLE palette is disjoint from the scored-band palette
  ---
  duration_ms: 0.964333
  type: 'test'
  ...
# Subtest: semantics \#5b: no advisory render line reaches for bandColor/scoreColor (source assertion)
ok 31 - semantics \#5b: no advisory render line reaches for bandColor/scoreColor (source assertion)
  ---
  duration_ms: 0.139542
  type: 'test'
  ...
# Subtest: semantics \#5c: the scored-band palette itself is intact (guards against gaming 5a by editing the bands)
ok 32 - semantics \#5c: the scored-band palette itself is intact (guards against gaming 5a by editing the bands)
  ---
  duration_ms: 0.134958
  type: 'test'
  ...
# Subtest: semantics \#3: a finding-shaped object mints NO MedicationAssertion
ok 33 - semantics \#3: a finding-shaped object mints NO MedicationAssertion
  ---
  duration_ms: 0.443708
  type: 'test'
  ...
# Subtest: semantics \#3: a finding-shaped row through assemble→build mints no problem/medication/investigation
ok 34 - semantics \#3: a finding-shaped row through assemble→build mints no problem/medication/investigation
  ---
  duration_ms: 0.779583
  type: 'test'
  ...
# Subtest: semantics: inquiry output never carries scored-band language
ok 35 - semantics: inquiry output never carries scored-band language
  ---
  duration_ms: 2.351125
  type: 'test'
  ...
# Subtest: semantics: scored cores do not import lib/inquiry (rule 5 reverse direction, source-pinned)
ok 36 - semantics: scored cores do not import lib/inquiry (rule 5 reverse direction, source-pinned)
  ---
  duration_ms: 3.643792
  type: 'test'
  ...
# Subtest: map generation is deterministic and the committed map is current
ok 37 - map generation is deterministic and the committed map is current
  ---
  duration_ms: 562.236625
  type: 'test'
  ...
# Subtest: coverage is a true partition and matches the UNREGISTERED allowlist
ok 38 - coverage is a true partition and matches the UNREGISTERED allowlist
  ---
  duration_ms: 0.481208
  type: 'test'
  ...
# Subtest: the governed modules appear on the map with their INVENTORY planes
ok 39 - the governed modules appear on the map with their INVENTORY planes
  ---
  duration_ms: 0.155833
  type: 'test'
  ...
# Subtest: version registry: declared *_VERSION constants only, live value round-trips
ok 40 - version registry: declared *_VERSION constants only, live value round-trips
  ---
  duration_ms: 0.245625
  type: 'test'
  ...
# Subtest: edges: no self-loops, and the map shows the Slice-1 boundaries clean
ok 41 - edges: no self-loops, and the map shows the Slice-1 boundaries clean
  ---
  duration_ms: 0.316584
  type: 'test'
  ...
# Subtest: ChangeEntry is a true superset: the audit changelog conforms with no data change
ok 42 - ChangeEntry is a true superset: the audit changelog conforms with no data change
  ---
  duration_ms: 0.066584
  type: 'test'
  ...
# Subtest: semantics \#1: silence in a later encounter NEVER resolves a problem (→ uncertain, not resolved)
ok 43 - semantics \#1: silence in a later encounter NEVER resolves a problem (→ uncertain, not resolved)
  ---
  duration_ms: 2.328791
  type: 'test'
  ...
# Subtest: semantics \#1: only an EXPLICIT documented-resolved occurrence flips the status
ok 44 - semantics \#1: only an EXPLICIT documented-resolved occurrence flips the status
  ---
  duration_ms: 2.48875
  type: 'test'
  ...
# Subtest: semantics \#1: a problem documented ON the as-of day stays active — never inferred beyond the evidence
ok 45 - semantics \#1: a problem documented ON the as-of day stays active — never inferred beyond the evidence
  ---
  duration_ms: 0.304875
  type: 'test'
  ...
# Subtest: semantics \#2: a med line maps to status "prescribed" — never a taking/adherence status
ok 46 - semantics \#2: a med line maps to status "prescribed" — never a taking/adherence status
  ---
  duration_ms: 0.548417
  type: 'test'
  ...
# Subtest: semantics \#2: EVERY line of a prescription maps to "prescribed" (bulk path)
ok 47 - semantics \#2: EVERY line of a prescription maps to "prescribed" (bulk path)
  ---
  duration_ms: 0.17075
  type: 'test'
  ...
# Subtest: D2 cut: strict prior-day — same-day and future excluded, prior included
ok 48 - D2 cut: strict prior-day — same-day and future excluded, prior included
  ---
  duration_ms: 0.818916
  type: 'test'
  ...
# Subtest: D2 cut: the audited encounterRef is always dropped even if prior-dated
ok 49 - D2 cut: the audited encounterRef is always dropped even if prior-dated
  ---
  duration_ms: 0.112292
  type: 'test'
  ...
# Subtest: D2 cut: applies identically to care_call / PROM-fold kinds
ok 50 - D2 cut: applies identically to care_call / PROM-fold kinds
  ---
  duration_ms: 0.064917
  type: 'test'
  ...
# Subtest: D2 cut: empty when nothing survives (no-prior-history honesty)
ok 51 - D2 cut: empty when nothing survives (no-prior-history honesty)
  ---
  duration_ms: 0.217542
  type: 'test'
  ...
# Subtest: D2 cut: ISO timestamps are compared at day precision
ok 52 - D2 cut: ISO timestamps are compared at day precision
  ---
  duration_ms: 0.139208
  type: 'test'
  ...
# Subtest: D2 cut: does not mutate the input array
ok 53 - D2 cut: does not mutate the input array
  ---
  duration_ms: 0.112792
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: aspirinMaxDailyMg: scheduled regimens sum to perUnitMg × units × doses/day
ok 54 - aspirinMaxDailyMg: scheduled regimens sum to perUnitMg × units × doses/day
  ---
  duration_ms: 4.582417
  type: 'test'
  ...
# Subtest: aspirinMaxDailyMg: D-2 — any unparseable contributing line makes the whole total null
ok 55 - aspirinMaxDailyMg: D-2 — any unparseable contributing line makes the whole total null
  ---
  duration_ms: 0.478333
  type: 'test'
  ...
# Subtest: acetylsalicylic acid is the same molecule as aspirin
ok 56 - acetylsalicylic acid is the same molecule as aspirin
  ---
  duration_ms: 2.28375
  type: 'test'
  ...
# Subtest: §2.3 row 1 — aspirin 75 mg OD + telmisartan: NOTHING fires (was Interaction (moderate))
ok 57 - §2.3 row 1 — aspirin 75 mg OD + telmisartan: NOTHING fires (was Interaction (moderate))
  ---
  duration_ms: 0.361792
  type: 'test'
  ...
# Subtest: §2.3 row 2 — aspirin 75 mg OD + clopidogrel: DAPT (moderate) still fires, unchanged
ok 58 - §2.3 row 2 — aspirin 75 mg OD + clopidogrel: DAPT (moderate) still fires, unchanged
  ---
  duration_ms: 0.646959
  type: 'test'
  ...
# Subtest: §2.3 row 3 — aspirin 75 mg OD + enoxaparin: major still fires, unchanged
ok 59 - §2.3 row 3 — aspirin 75 mg OD + enoxaparin: major still fires, unchanged
  ---
  duration_ms: 0.297208
  type: 'test'
  ...
# Subtest: §2.3 row 4 — aspirin 75 mg OD + diclofenac: Antiplatelet + NSAID (moderate) fires instead of Two NSAIDs
ok 60 - §2.3 row 4 — aspirin 75 mg OD + diclofenac: Antiplatelet + NSAID (moderate) fires instead of Two NSAIDs
  ---
  duration_ms: 0.593458
  type: 'test'
  ...
# Subtest: §2.3 row 5 — aspirin 650 mg TDS + telmisartan: unchanged, 1950 mg/day > 100
ok 61 - §2.3 row 5 — aspirin 650 mg TDS + telmisartan: unchanged, 1950 mg/day > 100
  ---
  duration_ms: 0.197625
  type: 'test'
  ...
# Subtest: §2.3 row 6 — aspirin with an unreadable strength + telmisartan: NOTHING fires (D-2)
ok 62 - §2.3 row 6 — aspirin with an unreadable strength + telmisartan: NOTHING fires (D-2)
  ---
  duration_ms: 0.372334
  type: 'test'
  ...
# Subtest: §2.3 row 7 — aspirin 150 mg OD + telmisartan: unchanged, 150 > 100 (D-1 accepted consequence)
ok 63 - §2.3 row 7 — aspirin 150 mg OD + telmisartan: unchanged, 150 > 100 (D-1 accepted consequence)
  ---
  duration_ms: 0.373375
  type: 'test'
  ...
# Subtest: the threshold is INCLUSIVE at 100 mg/day and exclusive above it
ok 64 - the threshold is INCLUSIVE at 100 mg/day and exclusive above it
  ---
  duration_ms: 0.216208
  type: 'test'
  ...
# Subtest: med-order invariance: the aspirin class does not depend on meds[] order (G-1 stays green)
ok 65 - med-order invariance: the aspirin class does not depend on meds[] order (G-1 stays green)
  ---
  duration_ms: 0.503167
  type: 'test'
  ...
# Subtest: scope guard: a non-aspirin NSAID pair is byte-identical to before the change
ok 66 - scope guard: a non-aspirin NSAID pair is byte-identical to before the change
  ---
  duration_ms: 0.208875
  type: 'test'
  ...
# Subtest: a combination line carrying a NON-aspirin NSAID is never de-classed by the aspirin rule
ok 67 - a combination line carrying a NON-aspirin NSAID is never de-classed by the aspirin rule
  ---
  duration_ms: 0.098166
  type: 'test'
  ...
# Subtest: tagInteractions: suppressNsaid drops only the nsaid tag; antiplatelet survives
ok 68 - tagInteractions: suppressNsaid drops only the nsaid tag; antiplatelet survives
  ---
  duration_ms: 0.117625
  type: 'test'
  ...
# Subtest: 11.1 — the six outcomes are the runtime authority, in the committed order
ok 69 - 11.1 — the six outcomes are the runtime authority, in the committed order
  ---
  duration_ms: 2.4995
  type: 'test'
  ...
# Subtest: 11.2 — `classifyAttemptOutcome` produces five of the six and NEVER `success`
ok 70 - 11.2 — `classifyAttemptOutcome` produces five of the six and NEVER `success`
  ---
  duration_ms: 1.536084
  type: 'test'
  ...
# Subtest: 11.3 — all four success sites record `success`, two of them through localAttemptSuccess()
ok 71 - 11.3 — all four success sites record `success`, two of them through localAttemptSuccess()
  ---
  duration_ms: 23.048958
  type: 'test'
  ...
# Subtest: 11.4 — detector one: a declared timeout kind classifies `timeout`, not `transport_error`
ok 72 - 11.4 — detector one: a declared timeout kind classifies `timeout`, not `transport_error`
  ---
  duration_ms: 0.088042
  type: 'test'
  ...
# Subtest: 11.5 — detector two: a REAL SDK timeout classifies `timeout`
ok 73 - 11.5 — detector two: a REAL SDK timeout classifies `timeout`
  ---
  duration_ms: 0.30175
  type: 'test'
  ...
# Subtest: 11.5b — REQUIREMENT 3: neither read may throw, on any hostile input
ok 74 - 11.5b — REQUIREMENT 3: neither read may throw, on any hostile input
  ---
  duration_ms: 10.046208
  type: 'test'
  ...
# Subtest: 11.6 — an outcome OUTSIDE the six is a manifest defect, in all three locations
ok 75 - 11.6 — an outcome OUTSIDE the six is a manifest defect, in all three locations
  ---
  duration_ms: 2.494959
  type: 'test'
  ...
# Subtest: 11.7 — an outcome INSIDE the six is not a defect, in all three locations
ok 76 - 11.7 — an outcome INSIDE the six is not a defect, in all three locations
  ---
  duration_ms: 1.160084
  type: 'test'
  ...
# Subtest: 11.8 — an ABSENT outcome, a wrong-shaped attempts value, and a mixed array are all defects
ok 77 - 11.8 — an ABSENT outcome, a wrong-shaped attempts value, and a mixed array are all defects
  ---
  duration_ms: 0.656667
  type: 'test'
  ...
# Subtest: 11.9 — `attempts: null` is LEGAL at all three locations and must NOT be flagged
ok 78 - 11.9 — `attempts: null` is LEGAL at all three locations and must NOT be flagged
  ---
  duration_ms: 0.546625
  type: 'test'
  ...
# Subtest: 11.10 — the defect name is the SAME stable string at all three locations
ok 79 - 11.10 — the defect name is the SAME stable string at all three locations
  ---
  duration_ms: 0.132917
  type: 'test'
  ...
# Subtest: SQL twin and canonicalByUid select the SAME row — all traps
ok 80 - SQL twin and canonicalByUid select the SAME row — all traps
  ---
  duration_ms: 2.891917
  type: 'test'
  ...
# Subtest: the ordering is the one THE RULE states — reverting it fails this test
ok 81 - the ordering is the one THE RULE states — reverting it fails this test
  ---
  duration_ms: 0.326417
  type: 'test'
  ...
# Subtest: §6 — SCAN lib/ and app/: nobody hand-writes a note-identity dedup on opd_note_audits
ok 82 - §6 — SCAN lib/ and app/: nobody hand-writes a note-identity dedup on opd_note_audits
  ---
  duration_ms: 116.632417
  type: 'test'
  ...
# Subtest: no doctor-facing surface writes its own NOTE-IDENTITY dedup
ok 83 - no doctor-facing surface writes its own NOTE-IDENTITY dedup
  ---
  duration_ms: 0.251416
  type: 'test'
  ...
# Subtest: ONE RULE across every surface — governance and stewardship included (addendum D)
ok 84 - ONE RULE across every surface — governance and stewardship included (addendum D)
  ---
  duration_ms: 0.304583
  type: 'test'
  ...
# Subtest: a non-numeric tail that is NOT -mini cannot reach the cast — shape, not suffix (learning.ts)
ok 85 - a non-numeric tail that is NOT -mini cannot reach the cast — shape, not suffix (learning.ts)
  ---
  duration_ms: 0.692542
  type: 'test'
  ...
# Subtest: canonicalDistinctOnSql composes the identity, the columns and the rank tail
ok 86 - canonicalDistinctOnSql composes the identity, the columns and the rank tail
  ---
  duration_ms: 0.073834
  type: 'test'
  ...
# Subtest: the migration adds provider to BOTH audit tables
ok 87 - the migration adds provider to BOTH audit tables
  ---
  duration_ms: 0.513666
  type: 'test'
  ...
# Subtest: IT IS IDEMPOTENT — running it twice is a no-op
ok 88 - IT IS IDEMPOTENT — running it twice is a no-op
  ---
  duration_ms: 0.203791
  type: 'test'
  ...
# Subtest: NO index, NO default, NO backfill — a null provider must stay distinguishable
ok 89 - NO index, NO default, NO backfill — a null provider must stay distinguishable
  ---
  duration_ms: 0.123958
  type: 'test'
  ...
# Subtest: the migration records WHY the column exists
ok 90 - the migration records WHY the column exists
  ---
  duration_ms: 0.065042
  type: 'test'
  ...
# Subtest: a saved OPD row carries BOTH provider and model
ok 91 - a saved OPD row carries BOTH provider and model
  ---
  duration_ms: 0.099875
  type: 'test'
  ...
# Subtest: OPD: a re-audit RE-ATTRIBUTES — provider is in the conflict SET, like model
ok 92 - OPD: a re-audit RE-ATTRIBUTES — provider is in the conflict SET, like model
  ---
  duration_ms: 0.043541
  type: 'test'
  ...
# Subtest: OPD: the column is PROBED, so the deploy is safe before the migration runs
ok 93 - OPD: the column is PROBED, so the deploy is safe before the migration runs
  ---
  duration_ms: 0.096791
  type: 'test'
  ...
# Subtest: a saved IPD row carries BOTH provider and model
ok 94 - a saved IPD row carries BOTH provider and model
  ---
  duration_ms: 0.049333
  type: 'test'
  ...
# Subtest: IPD: the column is PROBED too, against its OWN table
ok 95 - IPD: the column is PROBED too, against its OWN table
  ---
  duration_ms: 0.222792
  type: 'test'
  ...
# Subtest: both workers read model AND provider from ONE row of ONE query
ok 96 - both workers read model AND provider from ONE row of ONE query
  ---
  duration_ms: 1.457125
  type: 'test'
  ...
# Subtest: THE MINI PATH RECORDS ollama
ok 97 - THE MINI PATH RECORDS ollama
  ---
  duration_ms: 0.171208
  type: 'test'
  ...
# Subtest: NEVER FROM A CONSTANT — the D-D defect that bit twice
ok 98 - NEVER FROM A CONSTANT — the D-D defect that bit twice
  ---
  duration_ms: 0.252292
  type: 'test'
  ...
# Subtest: a NULL provider is accepted and stored as null, not the string "null"
ok 99 - a NULL provider is accepted and stored as null, not the string "null"
  ---
  duration_ms: 0.17425
  type: 'test'
  ...
# Subtest: lib/audit-canonical.ts is UNTOUCHED — the grader tier is Unit C
ok 100 - lib/audit-canonical.ts is UNTOUCHED — the grader tier is Unit C
  ---
  duration_ms: 0.501667
  type: 'test'
  ...
# Subtest: applyDemotes: match → informational + quieted_by; stored fields untouched; non-match untouched
ok 101 - applyDemotes: match → informational + quieted_by; stored fields untouched; non-match untouched
  ---
  duration_ms: 3.541708
  type: 'test'
  ...
# Subtest: applyDemotes: lvc_category is exact + case-insensitive; subject_contains reuses the matcher
ok 102 - applyDemotes: lvc_category is exact + case-insensitive; subject_contains reuses the matcher
  ---
  duration_ms: 0.424125
  type: 'test'
  ...
# Subtest: applyDemotes: proposed / retired / inactive rules quiet NOTHING (a proposal scores nothing)
ok 103 - applyDemotes: proposed / retired / inactive rules quiet NOTHING (a proposal scores nothing)
  ---
  duration_ms: 0.091083
  type: 'test'
  ...
# Subtest: applyDemotes: already-informational findings are left alone (never re-badged as quieted)
ok 104 - applyDemotes: already-informational findings are left alone (never re-badged as quieted)
  ---
  duration_ms: 0.062625
  type: 'test'
  ...
# Subtest: severity floor, store half: a rule on ANY deterministic safety signal type is refused, for EVERY action
ok 105 - severity floor, store half: a rule on ANY deterministic safety signal type is refused, for EVERY action
  ---
  duration_ms: 0.390458
  type: 'test'
  ...
# Subtest: severity floor, engine half (drop/downgrade): a drop rule can NEVER remove a banned_fdc finding
ok 106 - severity floor, engine half (drop/downgrade): a drop rule can NEVER remove a banned_fdc finding
  ---
  duration_ms: 0.791333
  type: 'test'
  ...
# Subtest: severity floor, engine half (drop/downgrade): a downgrade rule can NEVER informational-ise a high-alert finding
ok 107 - severity floor, engine half (drop/downgrade): a downgrade rule can NEVER informational-ise a high-alert finding
  ---
  duration_ms: 0.218541
  type: 'test'
  ...
# Subtest: severity floor does not over-reach: a drop rule on a NON-safety type still drops (regression guard)
ok 108 - severity floor does not over-reach: a drop rule on a NON-safety type still drops (regression guard)
  ---
  duration_ms: 0.068042
  type: 'test'
  ...
# Subtest: zero-delta: applySuppressions with no rules returns the input findings unchanged
ok 109 - zero-delta: applySuppressions with no rules returns the input findings unchanged
  ---
  duration_ms: 0.3275
  type: 'test'
  ...
# Subtest: severity floor, engine half: safety findings are skipped even when a rule somehow matches them
ok 110 - severity floor, engine half: safety findings are skipped even when a rule somehow matches them
  ---
  duration_ms: 0.481209
  type: 'test'
  ...
# Subtest: demote rules never flow through applySuppressions semantics (quieting is its own seam)
ok 111 - demote rules never flow through applySuppressions semantics (quieting is its own seam)
  ---
  duration_ms: 0.205833
  type: 'test'
  ...
# Subtest: §8.1 paired scoring: same note, rule active vs not — demoted finding contributes exactly zero
ok 112 - §8.1 paired scoring: same note, rule active vs not — demoted finding contributes exactly zero
  ---
  duration_ms: 1.820584
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: store half: a drop/downgrade/demote rule on ANY safety signal type is refused before the INSERT
ok 113 - store half: a drop/downgrade/demote rule on ANY safety signal type is refused before the INSERT
  ---
  duration_ms: 3.010709
  type: 'test'
  ...
# Subtest: store half: the floor does not over-reach — a non-safety type gets past validation
ok 114 - store half: the floor does not over-reach — a non-safety type gets past validation
  ---
  duration_ms: 0.346833
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: a run names bedrock or vertex — qwen is retired from backfill, and the refusal says so
ok 115 - a run names bedrock or vertex — qwen is retired from backfill, and the refusal says so
  ---
  duration_ms: 3.8435
  type: 'test'
  ...
# Subtest: the cursor STARTS at day_to and the range is validated
ok 116 - the cursor STARTS at day_to and the range is validated
  ---
  duration_ms: 0.545375
  type: 'test'
  ...
# Subtest: n_per_tick clamps to 1..8 and junk becomes the default, never 0
ok 117 - n_per_tick clamps to 1..8 and junk becomes the default, never 0
  ---
  duration_ms: 0.146208
  type: 'test'
  ...
# Subtest: §4.3.1 — one active run per worker, and it is a typed refusal not a queue
ok 118 - §4.3.1 — one active run per worker, and it is a typed refusal not a queue
  ---
  duration_ms: 0.240125
  type: 'test'
  ...
# Subtest: no active run ⇒ IDLE, which is a normal state and not an error
ok 119 - no active run ⇒ IDLE, which is a normal state and not an error
  ---
  duration_ms: 0.17575
  type: 'test'
  ...
# Subtest: a non-active run is skipped, and a spent cursor reads as done
ok 120 - a non-active run is skipped, and a spent cursor reads as done
  ---
  duration_ms: 0.220959
  type: 'test'
  ...
# Subtest: a run whose cursor was lost resumes at day_to instead of stalling
ok 121 - a run whose cursor was lost resumes at day_to instead of stalling
  ---
  duration_ms: 0.109875
  type: 'test'
  ...
# Subtest: ⚠️ THE CURSOR ONLY MOVES ON A COMPLETE DAY
ok 122 - ⚠️ THE CURSOR ONLY MOVES ON A COMPLETE DAY
  ---
  duration_ms: 0.317708
  type: 'test'
  ...
# Subtest: the run is DONE when the cursor passes below day_from — inclusive at both ends
ok 123 - the run is DONE when the cursor passes below day_from — inclusive at both ends
  ---
  duration_ms: 0.493292
  type: 'test'
  ...
# Subtest: prevDay is UTC date arithmetic — no timezone drift across a month or year boundary
ok 124 - prevDay is UTC date arithmetic — no timezone drift across a month or year boundary
  ---
  duration_ms: 0.622709
  type: 'test'
  ...
# Subtest: a failed NOTE is counted and the run continues; a failed TICK errors the run
ok 125 - a failed NOTE is counted and the run continues; a failed TICK errors the run
  ---
  duration_ms: 0.236
  type: 'test'
  ...
# Subtest: accounting never poisons a total with NaN, and never runs backwards
ok 126 - accounting never poisons a total with NaN, and never runs backwards
  ---
  duration_ms: 0.230875
  type: 'test'
  ...
# Subtest: an errored run is RESUMABLE — the whole point of erroring rather than stopping
ok 127 - an errored run is RESUMABLE — the whole point of erroring rather than stopping
  ---
  duration_ms: 0.285417
  type: 'test'
  ...
# Subtest: the DDL is the PRD’s, idempotent, with a partial unique index behind the one-run rule
ok 128 - the DDL is the PRD’s, idempotent, with a partial unique index behind the one-run rule
  ---
  duration_ms: 0.892125
  type: 'test'
  ...
# Subtest: run accounting is an in-SQL increment, so overlapping ticks cannot lose counts
ok 129 - run accounting is an in-SQL increment, so overlapping ticks cannot lose counts
  ---
  duration_ms: 0.725375
  type: 'test'
  ...
# Subtest: ⚠️ FILL-ONLY: the skip rule is unchanged, and it is what makes a prod-line label safe
ok 130 - ⚠️ FILL-ONLY: the skip rule is unchanged, and it is what makes a prod-line label safe
  ---
  duration_ms: 0.567292
  type: 'test'
  ...
# Subtest: the row is PROD-LINE and stamped with WHAT SERVED, never MINI_MODEL
ok 131 - the row is PROD-LINE and stamped with WHAT SERVED, never MINI_MODEL
  ---
  duration_ms: 0.876875
  type: 'test'
  ...
# Subtest: scheduling: the night window and the lab-batch yield are gone, the soft lock stays
ok 132 - scheduling: the night window and the lab-batch yield are gone, the soft lock stays
  ---
  duration_ms: 0.209875
  type: 'test'
  ...
# Subtest: reachability is re-checked EVERY tick, for the RUN’S provider, so unsetting a var is a clean rollback
ok 133 - reachability is re-checked EVERY tick, for the RUN’S provider, so unsetting a var is a clean rollback
  ---
  duration_ms: 0.118083
  type: 'test'
  ...
# Subtest: the control endpoint speaks the five actions, on this route
ok 134 - the control endpoint speaks the five actions, on this route
  ---
  duration_ms: 0.106208
  type: 'test'
  ...
# Subtest: a bedrock row is a CLOUD grader and a CANDIDATE model — for EVERY id the transport accepts
ok 135 - a bedrock row is a CLOUD grader and a CANDIDATE model — for EVERY id the transport accepts
  ---
  duration_ms: 0.157625
  type: 'test'
  ...
# Subtest: a bedrock row beats a qwen row, and loses to Gemini at the same version
ok 136 - a bedrock row beats a qwen row, and loses to Gemini at the same version
  ---
  duration_ms: 0.1915
  type: 'test'
  ...
# Subtest: cost_usd is real dollars, and costInr composes from it
ok 137 - cost_usd is real dollars, and costInr composes from it
  ---
  duration_ms: 0.113042
  type: 'test'
  ...
# Subtest: C2: a vertex run is refused unless it names the Gemini this deployment will actually use
ok 138 - C2: a vertex run is refused unless it names the Gemini this deployment will actually use
  ---
  duration_ms: 0.082625
  type: 'test'
  ...
# Subtest: C2: cost accrues on a vertex run through the SAME pricing path as a bedrock one
ok 139 - C2: cost accrues on a vertex run through the SAME pricing path as a bedrock one
  ---
  duration_ms: 0.049041
  type: 'test'
  ...
# Subtest: C4: a STOP issued mid-tick survives the tick’s completion write
ok 140 - C4: a STOP issued mid-tick survives the tick’s completion write
  ---
  duration_ms: 0.311292
  type: 'test'
  ...
# Subtest: C3: pace is weighted by notes, and only this run’s productive ticks count
ok 141 - C3: pace is weighted by notes, and only this run’s productive ticks count
  ---
  duration_ms: 0.100459
  type: 'test'
  ...
# Subtest: C3: the ETA says what it is BASED on, and stays null rather than guessing
ok 142 - C3: the ETA says what it is BASED on, and stays null rather than guessing
  ---
  duration_ms: 0.897208
  type: 'test'
  ...
# Subtest: C3: a stall is 300s of silence on an ACTIVE worker — never on a paused or idle one
ok 143 - C3: a stall is 300s of silence on an ACTIVE worker — never on a paused or idle one
  ---
  duration_ms: 0.28325
  type: 'test'
  ...
# Subtest: C3: the monitor exposes ETA + stall for BOTH arms of the bake-off
ok 144 - C3: the monitor exposes ETA + stall for BOTH arms of the bake-off
  ---
  duration_ms: 0.54
  type: 'test'
  ...
# Subtest: C1: the batch accepts bedrock, refuses every other provider, and no model ⇒ the mini path
ok 145 - C1: the batch accepts bedrock, refuses every other provider, and no model ⇒ the mini path
  ---
  duration_ms: 0.244
  type: 'test'
  ...
# Subtest: C1: a bedrock batch is TRACED and verified against that trace — a paid claim must be provable
ok 146 - C1: a bedrock batch is TRACED and verified against that trace — a paid claim must be provable
  ---
  duration_ms: 0.114
  type: 'test'
  ...
# Subtest: C1: the row carries who SERVED, and that is what makes the paid ceiling count it
ok 147 - C1: the row carries who SERVED, and that is what makes the paid ceiling count it
  ---
  duration_ms: 0.206083
  type: 'test'
  ...
# Subtest: C1: the bedrock arm does not yield to the Mac-mini it never touches
ok 148 - C1: the bedrock arm does not yield to the Mac-mini it never touches
  ---
  duration_ms: 0.093
  type: 'test'
  ...
# Subtest: C1: the poison-note budget covers the PAID arm, or a bad note retries for ever at a price
ok 149 - C1: the poison-note budget covers the PAID arm, or a bad note retries for ever at a price
  ---
  duration_ms: 0.122125
  type: 'test'
  ...
# Subtest: C1: lab_batch_start writes the model key on EVERY start, so a paid arm cannot leak forward
ok 150 - C1: lab_batch_start writes the model key on EVERY start, so a paid arm cannot leak forward
  ---
  duration_ms: 0.365666
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: the five membership cases from the kickoff, exactly
ok 151 - the five membership cases from the kickoff, exactly
  ---
  duration_ms: 1.129792
  type: 'test'
  ...
# Subtest: a future version does not sneak in via its tag either
ok 152 - a future version does not sneak in via its tag either
  ---
  duration_ms: 0.177708
  type: 'test'
  ...
# Subtest: the engine NAME keeps its own hyphens — a naive split on "-" would be wrong
ok 153 - the engine NAME keeps its own hyphens — a naive split on "-" would be wrong
  ---
  duration_ms: 0.238291
  type: 'test'
  ...
# Subtest: stripping takes the FIRST hyphen after the version, however many follow
ok 154 - stripping takes the FIRST hyphen after the version, however many follow
  ---
  duration_ms: 0.117834
  type: 'test'
  ...
# Subtest: an untagged string is returned unchanged, and the helper is total
ok 155 - an untagged string is returned unchanged, and the helper is total
  ---
  duration_ms: 0.247167
  type: 'test'
  ...
# Subtest: EVERY member of the family list is in its own line, tagged or not
ok 156 - EVERY member of the family list is in its own line, tagged or not
  ---
  duration_ms: 0.195166
  type: 'test'
  ...
# Subtest: auditedUidsForDay is UNCHANGED — still the exact-version, unfiltered read (DEC-3)
ok 157 - auditedUidsForDay is UNCHANGED — still the exact-version, unfiltered read (DEC-3)
  ---
  duration_ms: 0.294125
  type: 'test'
  ...
# Subtest: the day filter on the new read is byte-identical to auditedUidsForDay
ok 158 - the day filter on the new read is byte-identical to auditedUidsForDay
  ---
  duration_ms: 0.139666
  type: 'test'
  ...
# Subtest: the new read does NOT swallow its own errors — an empty skip list would re-audit everything
ok 159 - the new read does NOT swallow its own errors — an empty skip list would re-audit everything
  ---
  duration_ms: 0.483125
  type: 'test'
  ...
# Subtest: the four mini-backfill call sites use the line rule; the Gemini worker is untouched
ok 160 - the four mini-backfill call sites use the line rule; the Gemini worker is untouched
  ---
  duration_ms: 1.567708
  type: 'test'
  ...
# Subtest: the work selection and the day-complete decision use the SAME rule
ok 161 - the work selection and the day-complete decision use the SAME rule
  ---
  duration_ms: 0.301542
  type: 'test'
  ...
# Subtest: superset fires: the banned pair plus one extra molecule
ok 162 - superset fires: the banned pair plus one extra molecule
  ---
  duration_ms: 1.688083
  type: 'test'
  ...
# Subtest: subset-missing-one fires: two of a banned three
ok 163 - subset-missing-one fires: two of a banned three
  ---
  duration_ms: 0.25225
  type: 'test'
  ...
# Subtest: an exact match does NOT also near-miss — and neither does the entry it matched
ok 164 - an exact match does NOT also near-miss — and neither does the entry it matched
  ---
  duration_ms: 1.502167
  type: 'test'
  ...
# Subtest: missing TWO molecules is silent (|E| − |S| = 1 only)
ok 165 - missing TWO molecules is silent (|E| − |S| = 1 only)
  ---
  duration_ms: 0.184
  type: 'test'
  ...
# Subtest: a single-molecule product is silent — |S| ≥ 2, inherited from the exact-match check
ok 166 - a single-molecule product is silent — |S| ≥ 2, inherited from the exact-match check
  ---
  duration_ms: 0.246958
  type: 'test'
  ...
# Subtest: overlap without containment is silent (neither superset nor subset)
ok 167 - overlap without containment is silent (neither superset nor subset)
  ---
  duration_ms: 0.084666
  type: 'test'
  ...
# Subtest: cap: at most 3 near-miss findings per note, in ENTRY order
ok 168 - cap: at most 3 near-miss findings per note, in ENTRY order
  ---
  duration_ms: 0.2275
  type: 'test'
  ...
# Subtest: one finding per ENTRY even when several products near-miss it
ok 169 - one finding per ENTRY even when several products near-miss it
  ---
  duration_ms: 0.074209
  type: 'test'
  ...
# Subtest: malformed / empty tables and meds are silent — never throw (§7 posture, inherited)
ok 170 - malformed / empty tables and meds are silent — never throw (§7 posture, inherited)
  ---
  duration_ms: 0.23475
  type: 'test'
  ...
# Subtest: the finding is non-scoring by construction: informational + confidence 0 + uncertain
ok 171 - the finding is non-scoring by construction: informational + confidence 0 + uncertain
  ---
  duration_ms: 0.3075
  type: 'test'
  ...
# Subtest: signal_type resolves to banned_fdc_near_miss (and does not collide with banned_fdc)
ok 172 - signal_type resolves to banned_fdc_near_miss (and does not collide with banned_fdc)
  ---
  duration_ms: 1.12375
  type: 'test'
  ...
# Subtest: tier resolves to 3 — log only, never an action row (D-3)
ok 173 - tier resolves to 3 — log only, never an action row (D-3)
  ---
  duration_ms: 0.422167
  type: 'test'
  ...
# Subtest: 12.0 — the precedence list is a VOCABULARY, not an implementation
ok 174 - 12.0 — the precedence list is a VOCABULARY, not an implementation
  ---
  duration_ms: 16.818583
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [rerank judge] batch failed 0 - 2 Unexpected token 'h', "this is not"... is not valid JSON
# Subtest: 12.3 — ROW 3: a malformed completion is `parse_failure`
ok 175 - 12.3 — ROW 3: a malformed completion is `parse_failure`
  ---
  duration_ms: 66.016125
  type: 'test'
  ...
# Subtest: 12.4 — ROW 4: missing AND nonnumeric keys give `missing_score_key`, and BOTH counts survive
ok 176 - 12.4 — ROW 4: missing AND nonnumeric keys give `missing_score_key`, and BOTH counts survive
  ---
  duration_ms: 2.240958
  type: 'test'
  ...
# Subtest: 12.5 — ROW 5: finite AND nonnumeric keys give `nonnumeric_score`
ok 177 - 12.5 — ROW 5: finite AND nonnumeric keys give `nonnumeric_score`
  ---
  duration_ms: 1.251667
  type: 'test'
  ...
# [rerank judge] batch failed 0 - 2 Request timed out.
# [rerank judge] batch failed 0 - 2 socket hang up
# [rerank judge] batch failed 0 - 2 timed out
# [rerank judge] batch failed 0 - 2 socket hang up
# Subtest: 12.6 — ROW 6: all finite keys give `success`
ok 178 - 12.6 — ROW 6: all finite keys give `success`
  ---
  duration_ms: 1.5165
  type: 'test'
  ...
# Subtest: 12.1 — ROW 1: a REAL SDK TIMEOUT is `timeout`, not terminal_failure
ok 179 - 12.1 — ROW 1: a REAL SDK TIMEOUT is `timeout`, not terminal_failure
  ---
  duration_ms: 1.518833
  type: 'test'
  ...
# Subtest: 12.2 — ROW 2: a generic exhausted transport is `terminal_failure`
ok 180 - 12.2 — ROW 2: a generic exhausted transport is `terminal_failure`
  ---
  duration_ms: 0.639125
  type: 'test'
  ...
# [rerank judge] batch failed 0 - 2 Unexpected token 'h', "this is not"... is not valid JSON
# Subtest: 12.7 — the outcomes the six rows ACTUALLY produced are six distinct committed values
ok 181 - 12.7 — the outcomes the six rows ACTUALLY produced are six distinct committed values
  ---
  duration_ms: 9.000625
  type: 'test'
  ...
# Subtest: ⚠️ THE MINT IS THE IAM CREDENTIALS API, NOT THE JWT-BEARER TOKEN ENDPOINT
ok 182 - ⚠️ THE MINT IS THE IAM CREDENTIALS API, NOT THE JWT-BEARER TOKEN ENDPOINT
  ---
  duration_ms: 0.653209
  type: 'test'
  ...
# Subtest: step 1 is the EXISTING access-token flow, reused rather than duplicated
ok 183 - step 1 is the EXISTING access-token flow, reused rather than duplicated
  ---
  duration_ms: 0.077625
  type: 'test'
  ...
# Subtest: step 2 is :generateIdToken with {audience, includeEmail}, and reads `token`
ok 184 - step 2 is :generateIdToken with {audience, includeEmail}, and reads `token`
  ---
  duration_ms: 0.157625
  type: 'test'
  ...
# Subtest: the failure carries the BODY and both identities — a 403 here is ambiguous without them
ok 185 - the failure carries the BODY and both identities — a 403 here is ambiguous without them
  ---
  duration_ms: 0.04925
  type: 'test'
  ...
# Subtest: cached per audience, 55 minutes of usable life, exp never decoded
ok 186 - cached per audience, 55 minutes of usable life, exp never decoded
  ---
  duration_ms: 0.085041
  type: 'test'
  ...
# Subtest: no log line in the auth chain can print a token, key or credential
ok 187 - no log line in the auth chain can print a token, key or credential
  ---
  duration_ms: 0.202375
  type: 'test'
  ...
# Subtest: the refresh decision: fresh reuses, inside-the-skew re-mints, expired re-mints
ok 188 - the refresh decision: fresh reuses, inside-the-skew re-mints, expired re-mints
  ---
  duration_ms: 0.093834
  type: 'test'
  ...
# Subtest: VERIFICATION 8, without a warm instance: two calls 61 minutes apart cannot share credentials
ok 189 - VERIFICATION 8, without a warm instance: two calls 61 minutes apart cannot share credentials
  ---
  duration_ms: 0.0985
  type: 'test'
  ...
# Subtest: an undatable credential is UNUSABLE — never reused on the benefit of the doubt
ok 190 - an undatable credential is UNUSABLE — never reused on the benefit of the doubt
  ---
  duration_ms: 0.21475
  type: 'test'
  ...
# Subtest: the STS call is the reference’s call: role, session name, 60 minutes, unsigned client
ok 191 - the STS call is the reference’s call: role, session name, 60 minutes, unsigned client
  ---
  duration_ms: 0.479334
  type: 'test'
  ...
# Subtest: bedrockConfigured needs all four vars — and never gates on AWS_REGION
ok 192 - bedrockConfigured needs all four vars — and never gates on AWS_REGION
  ---
  duration_ms: 1.367333
  type: 'test'
  ...
# Subtest: exactly three model ids, and an unlisted one is REFUSED rather than sent
ok 193 - exactly three model ids, and an unlisted one is REFUSED rather than sent
  ---
  duration_ms: 0.759041
  type: 'test'
  ...
# Subtest: OpenAI chat params → Converse: system split out, roles mapped, inferenceConfig built
ok 194 - OpenAI chat params → Converse: system split out, roles mapped, inferenceConfig built
  ---
  duration_ms: 0.307167
  type: 'test'
  ...
# Subtest: consecutive same-role turns MERGE — Converse rejects them and dropping one would edit the prompt
ok 195 - consecutive same-role turns MERGE — Converse rejects them and dropping one would edit the prompt
  ---
  duration_ms: 0.141666
  type: 'test'
  ...
# Subtest: mapping degrades safely on shapes the repo does not send today
ok 196 - mapping degrades safely on shapes the repo does not send today
  ---
  duration_ms: 0.167209
  type: 'test'
  ...
# Subtest: Converse response → the OpenAI shape every consumer in this repo already reads
ok 197 - Converse response → the OpenAI shape every consumer in this repo already reads
  ---
  duration_ms: 0.220875
  type: 'test'
  ...
# Subtest: ⚠️ stopReason → finish_reason is load-bearing: end_turn MUST become stop
ok 198 - ⚠️ stopReason → finish_reason is load-bearing: end_turn MUST become stop
  ---
  duration_ms: 0.049458
  type: 'test'
  ...
# Subtest: usage degrades safely: a missing total is derived, a missing usage is zero (never null cost)
ok 199 - usage degrades safely: a missing total is derived, a missing usage is zero (never null cost)
  ---
  duration_ms: 0.060667
  type: 'test'
  ...
# Subtest: the stream shim satisfies a `for await` caller and carries the usage chunk
ok 200 - the stream shim satisfies a `for await` caller and carries the usage chunk
  ---
  duration_ms: 0.108583
  type: 'test'
  ...
# Subtest: an explicit bedrock target OUTRANKS both cloud tiers and has no ladder behind it
ok 201 - an explicit bedrock target OUTRANKS both cloud tiers and has no ladder behind it
  ---
  duration_ms: 0.230167
  type: 'test'
  ...
# Subtest: ⚠️ the bedrock target reaches BOTH governedChat arms — the traceless one cannot drop it
ok 202 - ⚠️ the bedrock target reaches BOTH governedChat arms — the traceless one cannot drop it
  ---
  duration_ms: 0.080167
  type: 'test'
  ...
# Subtest: the budget reaches the transport, and its default is READ FROM THE TABLE
ok 203 - the budget reaches the transport, and its default is READ FROM THE TABLE
  ---
  duration_ms: 0.148542
  type: 'test'
  ...
# Subtest: the provider_error record names BOTH identities in the chain
ok 204 - the provider_error record names BOTH identities in the chain
  ---
  duration_ms: 0.12025
  type: 'test'
  ...
# Subtest: the override gate and the routing map carry bedrock end to end
ok 205 - the override gate and the routing map carry bedrock end to end
  ---
  duration_ms: 0.084417
  type: 'test'
  ...
# Subtest: each model prices at its published global-endpoint rate, and never at a Gemini rate
ok 206 - each model prices at its published global-endpoint rate, and never at a Gemini rate
  ---
  duration_ms: 0.196292
  type: 'test'
  ...
# Subtest: ⚠️ the cost tracker actually SELECTS Bedrock rows — rates alone would have shown ₹0
ok 207 - ⚠️ the cost tracker actually SELECTS Bedrock rows — rates alone would have shown ₹0
  ---
  duration_ms: 0.031583
  type: 'test'
  ...
# Subtest: with no bedrock target the dispatch is the pre-existing one, line for line
ok 208 - with no bedrock target the dispatch is the pre-existing one, line for line
  ---
  duration_ms: 1.3015
  type: 'test'
  ...
# Subtest: labRoutingOpts is still {} with no override — the spread stays byte-identical
ok 209 - labRoutingOpts is still {} with no override — the spread stays byte-identical
  ---
  duration_ms: 0.132041
  type: 'test'
  ...
# Subtest: mini_analyze refuses a provider its seam cannot serve, instead of stamping the row anyway
ok 210 - mini_analyze refuses a provider its seam cannot serve, instead of stamping the row anyway
  ---
  duration_ms: 0.497208
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: default BM25 SQL is byte-identical to the shipped plainto-AND leg
ok 211 - default BM25 SQL is byte-identical to the shipped plainto-AND leg
  ---
  duration_ms: 0.712583
  type: 'test'
  ...
# Subtest: discriminating selection drops common terms (DF > dfMax) and OR-joins the rare ones
ok 212 - discriminating selection drops common terms (DF > dfMax) and OR-joins the rare ones
  ---
  duration_ms: 0.510042
  type: 'test'
  ...
# Subtest: parseTsqueryLexemes extracts bare lexemes from a plainto ::text
ok 213 - parseTsqueryLexemes extracts bare lexemes from a plainto ::text
  ---
  duration_ms: 0.206709
  type: 'test'
  ...
# Subtest: discriminating BM25 SQL always caps the candidate set before ranking
ok 214 - discriminating BM25 SQL always caps the candidate set before ranking
  ---
  duration_ms: 0.131958
  type: 'test'
  ...
# Subtest: only-common-terms yields no discriminating lexemes ⇒ empty tsquery ⇒ BM25 leg is skipped
ok 215 - only-common-terms yields no discriminating lexemes ⇒ empty tsquery ⇒ BM25 leg is skipped
  ---
  duration_ms: 0.11575
  type: 'test'
  ...
# Subtest: the DF-estimate SQL is the bounded planner EXPLAIN, never a COUNT over the corpus
ok 216 - the DF-estimate SQL is the bounded planner EXPLAIN, never a COUNT over the corpus
  ---
  duration_ms: 0.092792
  type: 'test'
  ...
# Subtest: buildAskSet: high-alert med first
ok 217 - buildAskSet: high-alert med first
  ---
  duration_ms: 1.848167
  type: 'test'
  ...
# Subtest: buildAskSet: med cap 3 (4th med → overflow)
ok 218 - buildAskSet: med cap 3 (4th med → overflow)
  ---
  duration_ms: 0.412208
  type: 'test'
  ...
# Subtest: buildAskSet: overall cap 5, rest overflow
ok 219 - buildAskSet: overall cap 5, rest overflow
  ---
  duration_ms: 0.45475
  type: 'test'
  ...
# Subtest: buildAskSet: follow-up keyword extraction (advice "repeat")
ok 220 - buildAskSet: follow-up keyword extraction (advice "repeat")
  ---
  duration_ms: 0.425042
  type: 'test'
  ...
# Subtest: buildAskSet: no follow-up when no keyword and no followUpType
ok 221 - buildAskSet: no follow-up when no keyword and no followUpType
  ---
  duration_ms: 0.267708
  type: 'test'
  ...
# Subtest: buildAskSet: followUpType real + no date → follow-up ask
ok 222 - buildAskSet: followUpType real + no date → follow-up ask
  ---
  duration_ms: 0.19925
  type: 'test'
  ...
# Subtest: buildAskSet: complaint cap 2
ok 223 - buildAskSet: complaint cap 2
  ---
  duration_ms: 0.25925
  type: 'test'
  ...
# Subtest: buildAskSet: allergy only when the note field is blank
ok 224 - buildAskSet: allergy only when the note field is blank
  ---
  duration_ms: 0.337
  type: 'test'
  ...
# Subtest: buildAskSet: outside-records is generated last if room
ok 225 - buildAskSet: outside-records is generated last if room
  ---
  duration_ms: 0.42775
  type: 'test'
  ...
# Subtest: buildAskSet: empty-ish case → just the outside-records ask
ok 226 - buildAskSet: empty-ish case → just the outside-records ask
  ---
  duration_ms: 0.652542
  type: 'test'
  ...
# Subtest: buildAskSet: deterministic ask ids + deep-equal on re-run
ok 227 - buildAskSet: deterministic ask ids + deep-equal on re-run
  ---
  duration_ms: 1.071833
  type: 'test'
  ...
# Subtest: deriveAssertions: med chips → statuses; stopped carries reason; parse generic/brand
ok 228 - deriveAssertions: med chips → statuses; stopped carries reason; parse generic/brand
  ---
  duration_ms: 0.379042
  type: 'test'
  ...
# Subtest: deriveAssertions: skip produces NO assertion
ok 229 - deriveAssertions: skip produces NO assertion
  ---
  duration_ms: 0.055458
  type: 'test'
  ...
# Subtest: deriveAssertions: complaint + follow-up + allergy chips
ok 230 - deriveAssertions: complaint + follow-up + allergy chips
  ---
  duration_ms: 0.131542
  type: 'test'
  ...
# Subtest: deriveAssertions: reported_allergy carries the free-text substance
ok 231 - deriveAssertions: reported_allergy carries the free-text substance
  ---
  duration_ms: 0.673083
  type: 'test'
  ...
# Subtest: deriveAssertions: every derived assertion carries valid clinical-state/1.2 patient-reported Provenance
ok 232 - deriveAssertions: every derived assertion carries valid clinical-state/1.2 patient-reported Provenance
  ---
  duration_ms: 0.212917
  type: 'test'
  ...
# Subtest: deriveAssertions: deterministic (twice → deep-equal)
ok 233 - deriveAssertions: deterministic (twice → deep-equal)
  ---
  duration_ms: 1.228333
  type: 'test'
  ...
# Subtest: escalationFlag: complaint worse → symptom_worse
ok 234 - escalationFlag: complaint worse → symptom_worse
  ---
  duration_ms: 0.216625
  type: 'test'
  ...
# Subtest: escalationFlag: high-alert med stopped → high_alert_med_stopped
ok 235 - escalationFlag: high-alert med stopped → high_alert_med_stopped
  ---
  duration_ms: 0.107167
  type: 'test'
  ...
# Subtest: escalationFlag: non-high-alert stopped → null
ok 236 - escalationFlag: non-high-alert stopped → null
  ---
  duration_ms: 0.083667
  type: 'test'
  ...
# Subtest: escalationFlag: not_taking high-alert → escalation
ok 237 - escalationFlag: not_taking high-alert → escalation
  ---
  duration_ms: 0.094708
  type: 'test'
  ...
# Subtest: validateOutcome: illegal disposition · foreign askId · legal partial
ok 238 - validateOutcome: illegal disposition · foreign askId · legal partial
  ---
  duration_ms: 0.207625
  type: 'test'
  ...
# Subtest: validateOutcome: illegal enum answer rejected
ok 239 - validateOutcome: illegal enum answer rejected
  ---
  duration_ms: 0.087375
  type: 'test'
  ...
# Subtest: version constants
ok 240 - version constants
  ---
  duration_ms: 0.080083
  type: 'test'
  ...
# Subtest: trackFromReasonType maps reasons + type precedence
ok 241 - trackFromReasonType maps reasons + type precedence
  ---
  duration_ms: 0.54175
  type: 'test'
  ...
# Subtest: healthFormsSql is injection-safe and targets the right table/key
ok 242 - healthFormsSql is injection-safe and targets the right table/key
  ---
  duration_ms: 0.286417
  type: 'test'
  ...
# Subtest: parseStrArray handles JS arrays, JSON text, and Postgres {a,b} text
ok 243 - parseStrArray handles JS arrays, JSON text, and Postgres {a,b} text
  ---
  duration_ms: 0.4205
  type: 'test'
  ...
# Subtest: parseFollowups normalizes booked/completed from real jsonb shape
ok 244 - parseFollowups normalizes booked/completed from real jsonb shape
  ---
  duration_ms: 0.230542
  type: 'test'
  ...
# Subtest: parseFollowups dedupes repeated orders (best status wins)
ok 245 - parseFollowups dedupes repeated orders (best status wins)
  ---
  duration_ms: 0.119792
  type: 'test'
  ...
# Subtest: parseNextFollowup handles date object, reason object, and bare string
ok 246 - parseNextFollowup handles date object, reason object, and bare string
  ---
  duration_ms: 0.125375
  type: 'test'
  ...
# Subtest: posthosp: "not required" reason → next-followup met, not garbage
ok 247 - posthosp: "not required" reason → next-followup met, not garbage
  ---
  duration_ms: 0.282333
  type: 'test'
  ...
# Subtest: autoTrack reads the most recent form (rows DESC)
ok 248 - autoTrack reads the most recent form (rows DESC)
  ---
  duration_ms: 0.091959
  type: 'test'
  ...
# Subtest: fever: context + expectations (day ≥5, danger sign, disposition gap)
ok 249 - fever: context + expectations (day ≥5, danger sign, disposition gap)
  ---
  duration_ms: 0.371334
  type: 'test'
  ...
# Subtest: fever recovered → mostly met
ok 250 - fever recovered → mostly met
  ---
  duration_ms: 0.362083
  type: 'test'
  ...
# Subtest: posthosp: unbooked items → gap; next follow-up met
ok 251 - posthosp: unbooked items → gap; next follow-up met
  ---
  duration_ms: 0.11425
  type: 'test'
  ...
# Subtest: aihs: HbA1c recency drives the marker expectation
ok 252 - aihs: HbA1c recency drives the marker expectation
  ---
  duration_ms: 0.168208
  type: 'test'
  ...
# Subtest: registry has the three deep tracks
ok 253 - registry has the three deep tracks
  ---
  duration_ms: 0.040334
  type: 'test'
  ...
# Subtest: extractJson strips code fences and parses
ok 254 - extractJson strips code fences and parses
  ---
  duration_ms: 0.873125
  type: 'test'
  ...
# Subtest: normalizeFinding ENFORCES cite-or-label: corpus_cited without citations is downgraded
ok 255 - normalizeFinding ENFORCES cite-or-label: corpus_cited without citations is downgraded
  ---
  duration_ms: 0.146875
  type: 'test'
  ...
# Subtest: parseClinical clamps citation ids to [1..max] and de-dupes finding ids
ok 256 - parseClinical clamps citation ids to [1..max] and de-dupes finding ids
  ---
  duration_ms: 0.102875
  type: 'test'
  ...
# Subtest: pitchGate opens ONLY on a specific, cited, high-confidence surgical_indication
ok 257 - pitchGate opens ONLY on a specific, cited, high-confidence surgical_indication
  ---
  duration_ms: 0.891875
  type: 'test'
  ...
# Subtest: pitchGate stays SHUT for an uncited surgical indication
ok 258 - pitchGate stays SHUT for an uncited surgical indication
  ---
  duration_ms: 0.104375
  type: 'test'
  ...
# Subtest: pitchGate stays SHUT for a cited NON-surgical finding
ok 259 - pitchGate stays SHUT for a cited NON-surgical finding
  ---
  duration_ms: 0.092459
  type: 'test'
  ...
# Subtest: pitchGate stays SHUT with no findings
ok 260 - pitchGate stays SHUT with no findings
  ---
  duration_ms: 0.041333
  type: 'test'
  ...
# Subtest: pitchGate stays SHUT on generic/conditional textbook "indications" (the ~80% false positives)
ok 261 - pitchGate stays SHUT on generic/conditional textbook "indications" (the ~80% false positives)
  ---
  duration_ms: 0.626
  type: 'test'
  ...
# Subtest: isSpecificSurgicalIndication accepts an assertive member-specific indication
ok 262 - isSpecificSurgicalIndication accepts an assertive member-specific indication
  ---
  duration_ms: 0.33
  type: 'test'
  ...
# Subtest: the tightened patterns catch the residual generics seen in the backtest
ok 263 - the tightened patterns catch the residual generics seen in the backtest
  ---
  duration_ms: 0.276166
  type: 'test'
  ...
# Subtest: pitchGate enforces the confidence floor
ok 264 - pitchGate enforces the confidence floor
  ---
  duration_ms: 0.060709
  type: 'test'
  ...
# Subtest: pitchGate opts reproduce the OLD (pre-calibration) gate for the backtest
ok 265 - pitchGate opts reproduce the OLD (pre-calibration) gate for the backtest
  ---
  duration_ms: 0.736042
  type: 'test'
  ...
# Subtest: buildCommercial: walled-off when not allowed; default priority follows referral
ok 266 - buildCommercial: walled-off when not allowed; default priority follows referral
  ---
  duration_ms: 0.117083
  type: 'test'
  ...
# Subtest: groundingSummary counts by grounding and distinct cited sources
ok 267 - groundingSummary counts by grounding and distinct cited sources
  ---
  duration_ms: 0.082125
  type: 'test'
  ...
# Subtest: parseCommercial defaults priority to med and coerces script
ok 268 - parseCommercial defaults priority to med and coerces script
  ---
  duration_ms: 0.054875
  type: 'test'
  ...
# Subtest: parseExtractedReport keeps clinical content only
ok 269 - parseExtractedReport keeps clinical content only
  ---
  duration_ms: 0.170459
  type: 'test'
  ...
# Subtest: composeEpisodeText is de-identified and notes order-only coverage
ok 270 - composeEpisodeText is de-identified and notes order-only coverage
  ---
  duration_ms: 0.170083
  type: 'test'
  ...
# Subtest: retrievalQuery surfaces the clinical content
ok 271 - retrievalQuery surfaces the clinical content
  ---
  duration_ms: 0.077958
  type: 'test'
  ...
# Subtest: assembleEnvelope carries member_ref for join-back + the disclaimer
ok 272 - assembleEnvelope carries member_ref for join-back + the disclaimer
  ---
  duration_ms: 1.762709
  type: 'test'
  ...
# Subtest: isSnapshotFresh: just inside the TTL is fresh
ok 273 - isSnapshotFresh: just inside the TTL is fresh
  ---
  duration_ms: 0.563042
  type: 'test'
  ...
# Subtest: isSnapshotFresh: exactly at the TTL is NOT fresh (strict <)
ok 274 - isSnapshotFresh: exactly at the TTL is NOT fresh (strict <)
  ---
  duration_ms: 0.064292
  type: 'test'
  ...
# Subtest: isSnapshotFresh: just outside the TTL is stale
ok 275 - isSnapshotFresh: just outside the TTL is stale
  ---
  duration_ms: 0.044375
  type: 'test'
  ...
# Subtest: isSnapshotFresh: zero age is fresh
ok 276 - isSnapshotFresh: zero age is fresh
  ---
  duration_ms: 0.042708
  type: 'test'
  ...
# Subtest: isSnapshotFresh: negative age (clock skew, refreshed in the future) is fresh
ok 277 - isSnapshotFresh: negative age (clock skew, refreshed in the future) is fresh
  ---
  duration_ms: 0.0395
  type: 'test'
  ...
# Subtest: isSnapshotFresh: a non-positive TTL means never fresh, not unbounded
ok 278 - isSnapshotFresh: a non-positive TTL means never fresh, not unbounded
  ---
  duration_ms: 0.036541
  type: 'test'
  ...
# Subtest: isSnapshotFresh: non-finite inputs are never fresh
ok 279 - isSnapshotFresh: non-finite inputs are never fresh
  ---
  duration_ms: 0.096292
  type: 'test'
  ...
# Subtest: isSnapshotFresh: a sub-hour TTL still works
ok 280 - isSnapshotFresh: a sub-hour TTL still works
  ---
  duration_ms: 0.040667
  type: 'test'
  ...
# Subtest: snapshotTtlHours: parses a valid value
ok 281 - snapshotTtlHours: parses a valid value
  ---
  duration_ms: 0.152583
  type: 'test'
  ...
# Subtest: snapshotTtlHours: unset / junk / non-positive fall back to the default
ok 282 - snapshotTtlHours: unset / junk / non-positive fall back to the default
  ---
  duration_ms: 0.301833
  type: 'test'
  ...
# Subtest: snapshotTtlHours default is 24
ok 283 - snapshotTtlHours default is 24
  ---
  duration_ms: 0.046208
  type: 'test'
  ...
# Subtest: toEpochMs accepts Date, ISO string, and epoch number
ok 284 - toEpochMs accepts Date, ISO string, and epoch number
  ---
  duration_ms: 0.907834
  type: 'test'
  ...
# Subtest: toEpochMs rejects everything else
ok 285 - toEpochMs rejects everything else
  ---
  duration_ms: 0.05625
  type: 'test'
  ...
# Subtest: mapSnapshotRow maps a jsonb object row
ok 286 - mapSnapshotRow maps a jsonb object row
  ---
  duration_ms: 0.192916
  type: 'test'
  ...
# Subtest: mapSnapshotRow maps a row whose snapshot arrived as a JSON string
ok 287 - mapSnapshotRow maps a row whose snapshot arrived as a JSON string
  ---
  duration_ms: 0.22175
  type: 'test'
  ...
# Subtest: mapSnapshotRow returns null for a missing row (cache miss)
ok 288 - mapSnapshotRow returns null for a missing row (cache miss)
  ---
  duration_ms: 0.074542
  type: 'test'
  ...
# Subtest: mapSnapshotRow returns null for an unparseable or non-object snapshot
ok 289 - mapSnapshotRow returns null for an unparseable or non-object snapshot
  ---
  duration_ms: 0.069084
  type: 'test'
  ...
# Subtest: mapSnapshotRow returns null when refreshed_at is unreadable
ok 290 - mapSnapshotRow returns null when refreshed_at is unreadable
  ---
  duration_ms: 0.039542
  type: 'test'
  ...
# Subtest: mapSnapshotRow never throws on hostile input
ok 291 - mapSnapshotRow never throws on hostile input
  ---
  duration_ms: 0.074208
  type: 'test'
  ...
# Subtest: SNAPSHOT_SCHEMA_VERSION is 2 (v1 = P1 rows, unstamped)
ok 292 - SNAPSHOT_SCHEMA_VERSION is 2 (v1 = P1 rows, unstamped)
  ---
  duration_ms: 0.027917
  type: 'test'
  ...
# Subtest: a P1 bundle (no _schemaVersion) is a MISS, so the enriched timeline appears without waiting out the TTL
ok 293 - a P1 bundle (no _schemaVersion) is a MISS, so the enriched timeline appears without waiting out the TTL
  ---
  duration_ms: 0.037167
  type: 'test'
  ...
# Subtest: a bundle stamped with any other version is a MISS (older or newer)
ok 294 - a bundle stamped with any other version is a MISS (older or newer)
  ---
  duration_ms: 0.051875
  type: 'test'
  ...
# Subtest: a correctly stamped bundle is servable, and the stamp rides along harmlessly
ok 295 - a correctly stamped bundle is servable, and the stamp rides along harmlessly
  ---
  duration_ms: 0.035583
  type: 'test'
  ...
# Subtest: the version guard also applies to a snapshot that arrived as a JSON string
ok 296 - the version guard also applies to a snapshot that arrived as a JSON string
  ---
  duration_ms: 0.702375
  type: 'test'
  ...
# Subtest: docSha is deterministic
ok 297 - docSha is deterministic
  ---
  duration_ms: 0.206167
  type: 'test'
  ...
# Subtest: docSha diverges for different URLs
ok 298 - docSha diverges for different URLs
  ---
  duration_ms: 0.130792
  type: 'test'
  ...
# Subtest: docSha is 64 lowercase hex chars
ok 299 - docSha is 64 lowercase hex chars
  ---
  duration_ms: 0.194375
  type: 'test'
  ...
# Subtest: docSha matches the known SHA-256 of a fixed string
ok 300 - docSha matches the known SHA-256 of a fixed string
  ---
  duration_ms: 0.207208
  type: 'test'
  ...
# Subtest: docSha does NOT normalise — a byte of difference is a different document
ok 301 - docSha does NOT normalise — a byte of difference is a different document
  ---
  duration_ms: 0.146209
  type: 'test'
  ...
# Subtest: docSha handles the empty string and unicode without throwing
ok 302 - docSha handles the empty string and unicode without throwing
  ---
  duration_ms: 0.134792
  type: 'test'
  ...
# Subtest: builders target the right tables and validate ids
ok 303 - builders target the right tables and validate ids
  ---
  duration_ms: 1.707666
  type: 'test'
  ...
# Subtest: builders reject junk ids (injection guard)
ok 304 - builders reject junk ids (injection guard)
  ---
  duration_ms: 0.374833
  type: 'test'
  ...
# Subtest: parseSpeciality pulls the trailing parens; prettyPrescriptionType humanizes
ok 305 - parseSpeciality pulls the trailing parens; prettyPrescriptionType humanizes
  ---
  duration_ms: 0.341875
  type: 'test'
  ...
# Subtest: mapEpisodeRow validates + coerces
ok 306 - mapEpisodeRow validates + coerces
  ---
  duration_ms: 0.183333
  type: 'test'
  ...
# Subtest: parseDiagnosisNames extracts readable names from the dpipe JSON array
ok 307 - parseDiagnosisNames extracts readable names from the dpipe JSON array
  ---
  duration_ms: 0.965833
  type: 'test'
  ...
# Subtest: cleanComplaint collapses whitespace and truncates
ok 308 - cleanComplaint collapses whitespace and truncates
  ---
  duration_ms: 0.211541
  type: 'test'
  ...
# Subtest: opdTimeline folds clean complaint + parsed dx names into the subtitle (no raw JSON leak)
ok 309 - opdTimeline folds clean complaint + parsed dx names into the subtitle (no raw JSON leak)
  ---
  duration_ms: 0.428042
  type: 'test'
  ...
# Subtest: reportTimeline falls back to a generic label and appends vendor
ok 310 - reportTimeline falls back to a generic label and appends vendor
  ---
  duration_ms: 0.218375
  type: 'test'
  ...
# Subtest: ipdTimeline computes LOS and labels discharge vs admission
ok 311 - ipdTimeline computes LOS and labels discharge vs admission
  ---
  duration_ms: 0.638375
  type: 'test'
  ...
# Subtest: mergeTimeline sorts newest-first and sinks undated rows
ok 312 - mergeTimeline sorts newest-first and sinks undated rows
  ---
  duration_ms: 14.566458
  type: 'test'
  ...
# Subtest: computeSnapshot counts + lastContact + medsLastVisit
ok 313 - computeSnapshot counts + lastContact + medsLastVisit
  ---
  duration_ms: 0.240583
  type: 'test'
  ...
# Subtest: buildMember shapes identity + age + allergies
ok 314 - buildMember shapes identity + age + allergies
  ---
  duration_ms: 0.426166
  type: 'test'
  ...
# Subtest: prescription comes first and is labelled "Encounter note"
ok 315 - prescription comes first and is labelled "Encounter note"
  ---
  duration_ms: 0.575333
  type: 'test'
  ...
# Subtest: reports keep bundle order after the prescription
ok 316 - reports keep bundle order after the prescription
  ---
  duration_ms: 0.370417
  type: 'test'
  ...
# Subtest: labels derive from kind + IST day
ok 317 - labels derive from kind + IST day
  ---
  duration_ms: 0.108833
  type: 'test'
  ...
# Subtest: an unknown report kind falls back to a generic label, never blank
ok 318 - an unknown report kind falls back to a generic label, never blank
  ---
  duration_ms: 0.0745
  type: 'test'
  ...
# Subtest: an unparseable date yields no date suffix rather than a broken label
ok 319 - an unparseable date yields no date suffix rather than a broken label
  ---
  duration_ms: 0.098959
  type: 'test'
  ...
# Subtest: documents with no url are dropped — there is nothing to frame
ok 320 - documents with no url are dropped — there is nothing to frame
  ---
  duration_ms: 0.059583
  type: 'test'
  ...
# Subtest: an order-only episode (no prescription pdf, no reports) yields an empty list
ok 321 - an order-only episode (no prescription pdf, no reports) yields an empty list
  ---
  duration_ms: 0.091041
  type: 'test'
  ...
# Subtest: duplicate urls collapse to the first occurrence
ok 322 - duplicate urls collapse to the first occurrence
  ---
  duration_ms: 0.062416
  type: 'test'
  ...
# Subtest: processedUrl is present in the shape and null today (ReportDoc carries no such column)
ok 323 - processedUrl is present in the shape and null today (ReportDoc carries no such column)
  ---
  duration_ms: 0.185709
  type: 'test'
  ...
# Subtest: a null / undefined / malformed bundle yields [] and never throws
ok 324 - a null / undefined / malformed bundle yields [] and never throws
  ---
  duration_ms: 0.389416
  type: 'test'
  ...
# Subtest: validators accept real ids/days and reject junk
ok 325 - validators accept real ids/days and reject junk
  ---
  duration_ms: 1.370833
  type: 'test'
  ...
# Subtest: dayOf truncates a timestamp to the IST calendar day; bad input throws
ok 326 - dayOf truncates a timestamp to the IST calendar day; bad input throws
  ---
  duration_ms: 0.429541
  type: 'test'
  ...
# Subtest: bundleWindow is asymmetric (reports land after the visit) and crosses month boundaries
ok 327 - bundleWindow is asymmetric (reports land after the visit) and crosses month boundaries
  ---
  duration_ms: 2.740709
  type: 'test'
  ...
# Subtest: SQL builders target the right tables/keys and embed only validated values
ok 328 - SQL builders target the right tables/keys and embed only validated values
  ---
  duration_ms: 0.637208
  type: 'test'
  ...
# Subtest: SQL builders refuse injection (throw, never interpolate)
ok 329 - SQL builders refuse injection (throw, never interpolate)
  ---
  duration_ms: 0.205875
  type: 'test'
  ...
# Subtest: specialityFromLabel parses the trailing-parens speciality
ok 330 - specialityFromLabel parses the trailing-parens speciality
  ---
  duration_ms: 0.222083
  type: 'test'
  ...
# Subtest: mapPrescription extracts keys + coerces array/json fields
ok 331 - mapPrescription extracts keys + coerces array/json fields
  ---
  duration_ms: 0.513875
  type: 'test'
  ...
# Subtest: mapPrescription prefers the clean CleanCase content when supplied
ok 332 - mapPrescription prefers the clean CleanCase content when supplied
  ---
  duration_ms: 0.156167
  type: 'test'
  ...
# Subtest: mapReports filters null urls; episodeCoverage flips on PDF presence
ok 333 - mapReports filters null urls; episodeCoverage flips on PDF presence
  ---
  duration_ms: 0.282708
  type: 'test'
  ...
# Subtest: buildBundle assembles + sets coverage
ok 334 - buildBundle assembles + sets coverage
  ---
  duration_ms: 0.360916
  type: 'test'
  ...
# Subtest: member ID (12 digits) routes to member-id + phone probes, not name
ok 335 - member ID (12 digits) routes to member-id + phone probes, not name
  ---
  duration_ms: 0.665292
  type: 'test'
  ...
# Subtest: individual UID (Firestore doc id) routes to a uid probe, not name/phone
ok 336 - individual UID (Firestore doc id) routes to a uid probe, not name/phone
  ---
  duration_ms: 0.15375
  type: 'test'
  ...
# Subtest: 10-digit phone and +91/spaced variants all normalize to +91XXXXXXXXXX
ok 337 - 10-digit phone and +91/spaced variants all normalize to +91XXXXXXXXXX
  ---
  duration_ms: 0.128334
  type: 'test'
  ...
# Subtest: UHID routes to a uhid probe
ok 338 - UHID routes to a uhid probe
  ---
  duration_ms: 0.045583
  type: 'test'
  ...
# Subtest: a name phrase routes to name tokens (and not to a uid probe)
ok 339 - a name phrase routes to name tokens (and not to a uid probe)
  ---
  duration_ms: 0.38875
  type: 'test'
  ...
# Subtest: a single plain word is a name, not an id
ok 340 - a single plain word is a name, not an id
  ---
  duration_ms: 0.055417
  type: 'test'
  ...
# Subtest: too-short / empty queries yield no probe
ok 341 - too-short / empty queries yield no probe
  ---
  duration_ms: 0.097917
  type: 'test'
  ...
# Subtest: name builder can not break out of its string literal (quotes balanced, no statement break)
ok 342 - name builder can not break out of its string literal (quotes balanced, no statement break)
  ---
  duration_ms: 0.124542
  type: 'test'
  ...
# Subtest: sanitizeNameToken removes metacharacters but keeps real names
ok 343 - sanitizeNameToken removes metacharacters but keeps real names
  ---
  duration_ms: 0.18175
  type: 'test'
  ...
# Subtest: id/phone builders reject junk and embed only validated values
ok 344 - id/phone builders reject junk and embed only validated values
  ---
  duration_ms: 0.454875
  type: 'test'
  ...
# Subtest: individualsByUidsSql batches identity by uid and validates
ok 345 - individualsByUidsSql batches identity by uid and validates
  ---
  duration_ms: 0.08275
  type: 'test'
  ...
# Subtest: episodes builder targets prescriptions with validated uids + types
ok 346 - episodes builder targets prescriptions with validated uids + types
  ---
  duration_ms: 0.133959
  type: 'test'
  ...
# Subtest: computeAge / fullName behave
ok 347 - computeAge / fullName behave
  ---
  duration_ms: 0.117292
  type: 'test'
  ...
# Subtest: buildHits groups episodes, ranks has-episodes first, and picks the latest
ok 348 - buildHits groups episodes, ranks has-episodes first, and picks the latest
  ---
  duration_ms: 0.168417
  type: 'test'
  ...
# Subtest: mapIndividualRow validates the uid and coerces arrays
ok 349 - mapIndividualRow validates the uid and coerces arrays
  ---
  duration_ms: 0.071541
  type: 'test'
  ...
# Subtest: every builder rejects a junk individual_uid
ok 350 - every builder rejects a junk individual_uid
  ---
  duration_ms: 0.834625
  type: 'test'
  ...
# Subtest: the kx order builder rejects a junk uhid
ok 351 - the kx order builder rejects a junk uhid
  ---
  duration_ms: 0.159708
  type: 'test'
  ...
# Subtest: no builder ever emits a quote from a rejected id (nothing interpolates before validation)
ok 352 - no builder ever emits a quote from a rejected id (nothing interpolates before validation)
  ---
  duration_ms: 0.10225
  type: 'test'
  ...
# Subtest: kx order builders key on uhid — NOT individual_uid — and hit the right table
ok 353 - kx order builders key on uhid — NOT individual_uid — and hit the right table
  ---
  duration_ms: 0.098
  type: 'test'
  ...
# Subtest: the radiology order builder selects body_part + laterality; the lab one does not
ok 354 - the radiology order builder selects body_part + laterality; the lab one does not
  ---
  duration_ms: 0.102625
  type: 'test'
  ...
# Subtest: surgery keys on individual_uid; hcu keys on _parent_id; ip_events keys on individual_uid
ok 355 - surgery keys on individual_uid; hcu keys on _parent_id; ip_events keys on individual_uid
  ---
  duration_ms: 0.045667
  type: 'test'
  ...
# Subtest: hyphenated table names are double-quoted
ok 356 - hyphenated table names are double-quoted
  ---
  duration_ms: 0.093209
  type: 'test'
  ...
# Subtest: every builder renders its date to the IST calendar day
ok 357 - every builder renders its date to the IST calendar day
  ---
  duration_ms: 0.053791
  type: 'test'
  ...
# Subtest: _create_time is cast to timestamptz before the timezone shift (column may be text)
ok 358 - _create_time is cast to timestamptz before the timezone shift (column may be text)
  ---
  duration_ms: 0.18275
  type: 'test'
  ...
# Subtest: every builder caps its result set, and the cap is clamped
ok 359 - every builder caps its result set, and the cap is clamped
  ---
  duration_ms: 0.281958
  type: 'test'
  ...
# Subtest: hcu selects all three url columns so the mapper can coalesce them
ok 360 - hcu selects all three url columns so the mapper can coalesce them
  ---
  duration_ms: 0.050459
  type: 'test'
  ...
# Subtest: ip_events selects only the verified column (no guessed label column)
ok 361 - ip_events selects only the verified column (no guessed label column)
  ---
  duration_ms: 0.042958
  type: 'test'
  ...
# Subtest: kxOrderTimeline shapes a lab order
ok 362 - kxOrderTimeline shapes a lab order
  ---
  duration_ms: 0.111542
  type: 'test'
  ...
# Subtest: kxOrderTimeline folds body_part + laterality into a radiology order
ok 363 - kxOrderTimeline folds body_part + laterality into a radiology order
  ---
  duration_ms: 0.04225
  type: 'test'
  ...
# Subtest: kxOrderTimeline tolerates every field being null
ok 364 - kxOrderTimeline tolerates every field being null
  ---
  duration_ms: 0.038
  type: 'test'
  ...
# Subtest: furthestSurgeryStage prefers ot > clinical > status
ok 365 - furthestSurgeryStage prefers ot > clinical > status
  ---
  duration_ms: 0.092
  type: 'test'
  ...
# Subtest: surgeryTimeline titles from procedure_name and subtitles the furthest stage
ok 366 - surgeryTimeline titles from procedure_name and subtitles the furthest stage
  ---
  duration_ms: 0.068416
  type: 'test'
  ...
# Subtest: surgeryTimeline falls back to a generic title when procedure_name is missing
ok 367 - surgeryTimeline falls back to a generic title when procedure_name is missing
  ---
  duration_ms: 0.036167
  type: 'test'
  ...
# Subtest: hcuDocUrl coalesces processed → consolidated → report
ok 368 - hcuDocUrl coalesces processed → consolidated → report
  ---
  duration_ms: 0.045375
  type: 'test'
  ...
# Subtest: hcuTimeline attaches docUrl when a report exists, and OMITS the key when it does not
ok 369 - hcuTimeline attaches docUrl when a report exists, and OMITS the key when it does not
  ---
  duration_ms: 0.06775
  type: 'test'
  ...
# Subtest: ipEventTimeline titles generically when no label column was selected
ok 370 - ipEventTimeline titles generically when no label column was selected
  ---
  duration_ms: 0.628583
  type: 'test'
  ...
# Subtest: ipEventTimeline uses a label opportunistically if one ever appears in the row
ok 371 - ipEventTimeline uses a label opportunistically if one ever appears in the row
  ---
  duration_ms: 0.040292
  type: 'test'
  ...
# Subtest: every mapper returns [] for empty input and never throws
ok 372 - every mapper returns [] for empty input and never throws
  ---
  duration_ms: 0.328208
  type: 'test'
  ...
# Subtest: flaggedListSql keeps every normative fragment of the page query
ok 373 - flaggedListSql keeps every normative fragment of the page query
  ---
  duration_ms: 0.539833
  type: 'test'
  ...
# Subtest: flaggedListSql preserves both ORDER BY clauses exactly
ok 374 - flaggedListSql preserves both ORDER BY clauses exactly
  ---
  duration_ms: 0.063375
  type: 'test'
  ...
# Subtest: flaggedListSql mirrors the jsonb_typeof guards on both coalesce branches
ok 375 - flaggedListSql mirrors the jsonb_typeof guards on both coalesce branches
  ---
  duration_ms: 0.111959
  type: 'test'
  ...
# Subtest: flaggedListSql takes the engine version as $1 and never interpolates it
ok 376 - flaggedListSql takes the engine version as $1 and never interpolates it
  ---
  duration_ms: 0.048041
  type: 'test'
  ...
# Subtest: flaggedListSql is a constant — no argument can change the text
ok 377 - flaggedListSql is a constant — no argument can change the text
  ---
  duration_ms: 0.040958
  type: 'test'
  ...
# Subtest: pickSignal: a gated_on claim beats the surgical_indication fallback
ok 378 - pickSignal: a gated_on claim beats the surgical_indication fallback
  ---
  duration_ms: 0.083666
  type: 'test'
  ...
# Subtest: pickSignal: falls back to surgical_indication when nothing is gated
ok 379 - pickSignal: falls back to surgical_indication when nothing is gated
  ---
  duration_ms: 0.101458
  type: 'test'
  ...
# Subtest: pickSignal: falls back to speciality when no surgical_indication exists
ok 380 - pickSignal: falls back to speciality when no surgical_indication exists
  ---
  duration_ms: 0.042167
  type: 'test'
  ...
# Subtest: pickSignal: gated_on picks the FIRST matching finding in array order
ok 381 - pickSignal: gated_on picks the FIRST matching finding in array order
  ---
  duration_ms: 0.176166
  type: 'test'
  ...
# Subtest: pickSignal: a gated hit with a null claim coalesces to branch 2, not to the next gated hit
ok 382 - pickSignal: a gated hit with a null claim coalesces to branch 2, not to the next gated hit
  ---
  duration_ms: 0.272333
  type: 'test'
  ...
# Subtest: pickSignal: no qualifying finding returns null
ok 383 - pickSignal: no qualifying finding returns null
  ---
  duration_ms: 0.04775
  type: 'test'
  ...
# Subtest: pickSignal: malformed and non-array envelope shapes degrade to null, never throw
ok 384 - pickSignal: malformed and non-array envelope shapes degrade to null, never throw
  ---
  duration_ms: 0.181667
  type: 'test'
  ...
# Subtest: pickSignal: non-string gated_on entries are ignored, not coerced
ok 385 - pickSignal: non-string gated_on entries are ignored, not coerced
  ---
  duration_ms: 0.036083
  type: 'test'
  ...
# Subtest: boundedRace returns the fallback when the inner promise never resolves
ok 386 - boundedRace returns the fallback when the inner promise never resolves
  ---
  duration_ms: 32.105958
  type: 'test'
  ...
# Subtest: boundedRace passes a fast result straight through
ok 387 - boundedRace passes a fast result straight through
  ---
  duration_ms: 0.326708
  type: 'test'
  ...
# Subtest: boundedRace resolves the fallback when the inner promise rejects — never rejects
ok 388 - boundedRace resolves the fallback when the inner promise rejects — never rejects
  ---
  duration_ms: 0.33975
  type: 'test'
  ...
# Subtest: boundedRace resolves the fallback on a synchronous throw inside the promise
ok 389 - boundedRace resolves the fallback on a synchronous throw inside the promise
  ---
  duration_ms: 0.173792
  type: 'test'
  ...
# Subtest: boundedRace does not hold the event loop open after a fast win
ok 390 - boundedRace does not hold the event loop open after a fast win
  ---
  duration_ms: 0.147542
  type: 'test'
  ...
# Subtest: boundedRace preserves falsy results rather than substituting the fallback
ok 391 - boundedRace preserves falsy results rather than substituting the fallback
  ---
  duration_ms: 0.340625
  type: 'test'
  ...
# Subtest: identity failure ⇒ the page still renders, with {} identities (uhid-only labels)
ok 392 - identity failure ⇒ the page still renders, with {} identities (uhid-only labels)
  ---
  duration_ms: 31.636625
  type: 'test'
  ...
# Subtest: a healthy identity lookup still labels the row
ok 393 - a healthy identity lookup still labels the row
  ---
  duration_ms: 0.238584
  type: 'test'
  ...
# Subtest: exact two-molecule match fires: confidence 1.0, det shape, gazette ref + date in rationale
ok 394 - exact two-molecule match fires: confidence 1.0, det shape, gazette ref + date in rationale
  ---
  duration_ms: 0.968041
  type: 'test'
  ...
# Subtest: C5 boundary: superset does NOT fire (banned core + one extra molecule)
ok 395 - C5 boundary: superset does NOT fire (banned core + one extra molecule)
  ---
  duration_ms: 0.139959
  type: 'test'
  ...
# Subtest: C5 boundary: subset does NOT fire (single molecule of a banned pair; 2 of a banned 3)
ok 396 - C5 boundary: subset does NOT fire (single molecule of a banned pair; 2 of a banned 3)
  ---
  duration_ms: 0.120875
  type: 'test'
  ...
# Subtest: order-independence + separator variants + case: ["b","a"] matches an entry stored ["a","b"]
ok 397 - order-independence + separator variants + case: ["b","a"] matches an entry stored ["a","b"]
  ---
  duration_ms: 0.141125
  type: 'test'
  ...
# Subtest: unresolved brand (no resolvedGeneric, no generic) → no finding, no throw — the accepted miss
ok 398 - unresolved brand (no resolvedGeneric, no generic) → no finding, no throw — the accepted miss
  ---
  duration_ms: 0.10625
  type: 'test'
  ...
# Subtest: empty / malformed table → empty array, never a throw (§7 fail-safe)
ok 399 - empty / malformed table → empty array, never a throw (§7 fail-safe)
  ---
  duration_ms: 0.063042
  type: 'test'
  ...
# Subtest: same banned combination in two products → ONE finding (per-entry dedupe)
ok 400 - same banned combination in two products → ONE finding (per-entry dedupe)
  ---
  duration_ms: 0.098458
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 15 (v2.0): loaded seed is v2.0 with 308 firing entries; withheld/rescinded/not_representable never fire
ok 401 - 0.81.14 Ruling 15 (v2.0): loaded seed is v2.0 with 308 firing entries; withheld/rescinded/not_representable never fire
  ---
  duration_ms: 40.430333
  type: 'test'
  ...
# Subtest: stampFindingIdentity: banned-FDC keeps banned_fdc (C4 protection holds under the 0.81.10 generalisation)
ok 402 - stampFindingIdentity: banned-FDC keeps banned_fdc (C4 protection holds under the 0.81.10 generalisation)
  ---
  duration_ms: 1.44075
  type: 'test'
  ...
# Subtest: severity floor: banned_fdc is protected — store half refuses, engine half skips a hostile rule
ok 403 - severity floor: banned_fdc is protected — store half refuses, engine half skips a hostile rule
  ---
  duration_ms: 0.425042
  type: 'test'
  ...
# Subtest: tierForCareSetting maps free-text care settings to a tariff tier
ok 404 - tierForCareSetting maps free-text care settings to a tariff tier
  ---
  duration_ms: 0.621625
  type: 'test'
  ...
# Subtest: priceAtTier reads the right column and falls back when a tier is absent
ok 405 - priceAtTier reads the right column and falls back when a tier is absent
  ---
  duration_ms: 0.144792
  type: 'test'
  ...
# Subtest: roomCategoryInflation = extra cost vs general ward; 0 at general/opd
ok 406 - roomCategoryInflation = extra cost vs general ward; 0 at general/opd
  ---
  duration_ms: 0.095042
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: §6.8 BUG 9a: the citation is stripped and evidence moves to estimates
ok 407 - §6.8 BUG 9a: the citation is stripped and evidence moves to estimates
  ---
  duration_ms: 2.01
  type: 'test'
  ...
# Subtest: §6.7 THE 700-CHAR REASON: support beyond character 600 still counts
ok 408 - §6.7 THE 700-CHAR REASON: support beyond character 600 still counts
  ---
  duration_ms: 0.263458
  type: 'test'
  ...
# Subtest: a supporting excerpt naming the molecule keeps the citation
ok 409 - a supporting excerpt naming the molecule keeps the citation
  ---
  duration_ms: 0.062125
  type: 'test'
  ...
# Subtest: CONSERVATIVE: an undeterminable molecule ⇒ do nothing
ok 410 - CONSERVATIVE: an undeterminable molecule ⇒ do nothing
  ---
  duration_ms: 0.171958
  type: 'test'
  ...
# Subtest: CONSERVATIVE: a cited excerpt with no text available ⇒ do nothing
ok 411 - CONSERVATIVE: a cited excerpt with no text available ⇒ do nothing
  ---
  duration_ms: 0.143625
  type: 'test'
  ...
# Subtest: deterministic findings and uncited findings are untouched
ok 412 - deterministic findings and uncited findings are untouched
  ---
  duration_ms: 0.072208
  type: 'test'
  ...
# Subtest: §6.9: the check does NOT run on the reuse path — empty hits, untouched findings
ok 413 - §6.9: the check does NOT run on the reuse path — empty hits, untouched findings
  ---
  duration_ms: 0.099167
  type: 'test'
  ...
# Subtest: the guard is structural in the engine: latestHits is set ONLY on the generation path
ok 414 - the guard is structural in the engine: latestHits is set ONLY on the generation path
  ---
  duration_ms: 0.7165
  type: 'test'
  ...
# Subtest: §6.10: stripping a citation does NOT change the index
ok 415 - §6.10: stripping a citation does NOT change the index
  ---
  duration_ms: 1.44125
  type: 'test'
  ...
# Subtest: §6.11: groundingKind, SEVERITY, PENALTY_BASE and findingPenalty are BYTE-IDENTICAL
ok 416 - §6.11: groundingKind, SEVERITY, PENALTY_BASE and findingPenalty are BYTE-IDENTICAL
  ---
  duration_ms: 1.073334
  type: 'test'
  ...
# Subtest: a stripped finding really does render as no_source
ok 417 - a stripped finding really does render as no_source
  ---
  duration_ms: 6.790083
  type: 'test'
  ...
# Subtest: the 600 and 700 constants are byte-identical — the gap this design exists for
ok 418 - the 600 and 700 constants are byte-identical — the gap this design exists for
  ---
  duration_ms: 0.240625
  type: 'test'
  ...
# Subtest: sourceUrl links journal PMIDs but not textbook item numbers
ok 419 - sourceUrl links journal PMIDs but not textbook item numbers
  ---
  duration_ms: 0.547834
  type: 'test'
  ...
# Subtest: hitsToSources numbers, previews, derives url, rounds similarity
ok 420 - hitsToSources numbers, previews, derives url, rounds similarity
  ---
  duration_ms: 0.160958
  type: 'test'
  ...
# Subtest: sourceLabel shows PMID for journals, item id for textbooks
ok 421 - sourceLabel shows PMID for journals, item id for textbooks
  ---
  duration_ms: 0.114416
  type: 'test'
  ...
# Subtest: buildCitedContext emits [n] provenance + full text
ok 422 - buildCitedContext emits [n] provenance + full text
  ---
  duration_ms: 0.080583
  type: 'test'
  ...
# Subtest: validateCitationIds clamps to [1..max], dedupes, drops junk
ok 423 - validateCitationIds clamps to [1..max], dedupes, drops junk
  ---
  duration_ms: 0.348541
  type: 'test'
  ...
# Subtest: usedSources filters to cited n only
ok 424 - usedSources filters to cited n only
  ---
  duration_ms: 0.070167
  type: 'test'
  ...
# Subtest: sourceUrl derives a live NBK link for Bookshelf, not PubMed
ok 425 - sourceUrl derives a live NBK link for Bookshelf, not PubMed
  ---
  duration_ms: 0.119042
  type: 'test'
  ...
# Subtest: a Bookshelf citation renders with a working NBK link + NBK label (not PMID)
ok 426 - a Bookshelf citation renders with a working NBK link + NBK label (not PMID)
  ---
  duration_ms: 0.062917
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: BUG 8: 17 and 18 ng/mL land in the SAME band — the acceptance test for this batch
ok 427 - BUG 8: 17 and 18 ng/mL land in the SAME band — the acceptance test for this batch
  ---
  duration_ms: 0.603375
  type: 'test'
  ...
# Subtest: §6.1: the full band table, boundaries exact and CONTIGUOUS
ok 428 - §6.1: the full band table, boundaries exact and CONTIGUOUS
  ---
  duration_ms: 0.171875
  type: 'test'
  ...
# Subtest: the boundary constants and the standard are named, verbatim
ok 429 - the boundary constants and the standard are named, verbatim
  ---
  duration_ms: 0.181541
  type: 'test'
  ...
# Subtest: an unusable level yields NO band — never a guess
ok 430 - an unusable level yields NO band — never a guess
  ---
  duration_ms: 0.059791
  type: 'test'
  ...
# Subtest: the level is read only when BOTH a vitamin-D token and ng/mL are present
ok 431 - the level is read only when BOTH a vitamin-D token and ng/mL are present
  ---
  duration_ms: 0.271375
  type: 'test'
  ...
# Subtest: FAIL-SAFE: a bare number, a different unit, or no vitamin-D token reads as NOTHING
ok 432 - FAIL-SAFE: a bare number, a different unit, or no vitamin-D token reads as NOTHING
  ---
  duration_ms: 0.056375
  type: 'test'
  ...
# Subtest: §6.2/§6.3: the matrix holds EXACTLY the two ratified rows
ok 433 - §6.2/§6.3: the matrix holds EXACTLY the two ratified rows
  ---
  duration_ms: 0.489083
  type: 'test'
  ...
# Subtest: row 1: deficient + 60,000 IU weekly × 8 weeks is concordant
ok 434 - row 1: deficient + 60,000 IU weekly × 8 weeks is concordant
  ---
  duration_ms: 0.139542
  type: 'test'
  ...
# Subtest: row 2: insufficient + the same regimen is concordant (Dr Zaki, Indian context)
ok 435 - row 2: insufficient + the same regimen is concordant (Dr Zaki, Indian context)
  ---
  duration_ms: 0.208125
  type: 'test'
  ...
# Subtest: §6.4: EVERY unratified pair yields null — and null means EMIT NOTHING, never discordance
ok 436 - §6.4: EVERY unratified pair yields null — and null means EMIT NOTHING, never discordance
  ---
  duration_ms: 0.739042
  type: 'test'
  ...
# Subtest: §6.5: the retest prompt fires for INSUFFICIENT as well as deficient, still informational
ok 437 - §6.5: the retest prompt fires for INSUFFICIENT as well as deficient, still informational
  ---
  duration_ms: 0.601666
  type: 'test'
  ...
# Subtest: the prompt keeps signal_type vitamin_d_repletion_duration through stampFindingIdentity
ok 438 - the prompt keeps signal_type vitamin_d_repletion_duration through stampFindingIdentity
  ---
  duration_ms: 14.5305
  type: 'test'
  ...
# Subtest: a SUFFICIENT level with the same regimen emits nothing — silence is the default
ok 439 - a SUFFICIENT level with the same regimen emits nothing — silence is the default
  ---
  duration_ms: 0.264
  type: 'test'
  ...
# Subtest: NO BAND (unreadable level) emits nothing for an 8-week course — never band on a guess
ok 440 - NO BAND (unreadable level) emits nothing for an 8-week course — never band on a guess
  ---
  duration_ms: 0.29625
  type: 'test'
  ...
# Subtest: the >8-week Ruling 13 prompt is UNCHANGED and still band-independent
ok 441 - the >8-week Ruling 13 prompt is UNCHANGED and still band-independent
  ---
  duration_ms: 0.188125
  type: 'test'
  ...
# Subtest: FAIL-SAFE doctrine intact: an unparseable duration emits NOTHING in either mode
ok 442 - FAIL-SAFE doctrine intact: an unparseable duration emits NOTHING in either mode
  ---
  duration_ms: 0.296833
  type: 'test'
  ...
# Subtest: the system prompt names vitamin D dose adequacy beside muscle relaxants
ok 443 - the system prompt names vitamin D dose adequacy beside muscle relaxants
  ---
  duration_ms: 0.35475
  type: 'test'
  ...
# Subtest: the engine version is current and the read family keeps the older versions
ok 444 - the engine version is current and the read family keeps the older versions
  ---
  duration_ms: 2.757375
  type: 'test'
  ...
# Subtest: auditShadowReport: full + minimal findings round-trip byte-lossless
ok 445 - auditShadowReport: full + minimal findings round-trip byte-lossless
  ---
  duration_ms: 0.995083
  type: 'test'
  ...
# Subtest: auditShadowReport: empty findings → vacuously ok, zero counts
ok 446 - auditShadowReport: empty findings → vacuously ok, zero counts
  ---
  duration_ms: 0.070625
  type: 'test'
  ...
# Subtest: flag-OFF byte-identical: the shadow never mutates the persisted findings array
ok 447 - flag-OFF byte-identical: the shadow never mutates the persisted findings array
  ---
  duration_ms: 0.283041
  type: 'test'
  ...
# Subtest: auditShadowReport: flags a lossy finding (missing verdict/domain gain empty-string keys)
ok 448 - auditShadowReport: flags a lossy finding (missing verdict/domain gain empty-string keys)
  ---
  duration_ms: 0.086042
  type: 'test'
  ...
# Subtest: lossyKeys: detects dropped, added, and value-changed keys; empty on identity
ok 449 - lossyKeys: detects dropped, added, and value-changed keys; empty on identity
  ---
  duration_ms: 0.07425
  type: 'test'
  ...
# Subtest: demographics: structured input wins; band derived
ok 450 - demographics: structured input wins; band derived
  ---
  duration_ms: 4.093167
  type: 'test'
  ...
# Subtest: "No fever" → absent; "fever not mentioned" → unknown (the two are DIFFERENT)
ok 451 - "No fever" → absent; "fever not mentioned" → unknown (the two are DIFFERENT)
  ---
  duration_ms: 0.993041
  type: 'test'
  ...
# Subtest: "Denies vomiting" is a negation too; complaint carries its duration
ok 452 - "Denies vomiting" is a negation too; complaint carries its duration
  ---
  duration_ms: 0.125625
  type: 'test'
  ...
# Subtest: accepted complaint field names are pinned — a rename at a call site is a silent positives:0
ok 453 - accepted complaint field names are pinned — a rename at a call site is a silent positives:0
  ---
  duration_ms: 0.22525
  type: 'test'
  ...
# Subtest: vitals: parsed reads + instability from adult thresholds
ok 454 - vitals: parsed reads + instability from adult thresholds
  ---
  duration_ms: 0.213833
  type: 'test'
  ...
# Subtest: instability three-state: no vitals → not_assessable, all 5 channels missing
ok 455 - instability three-state: no vitals → not_assessable, all 5 channels missing
  ---
  duration_ms: 0.07625
  type: 'test'
  ...
# Subtest: instability three-state: full normal vitals → no_instability_detected, all 5 assessed
ok 456 - instability three-state: full normal vitals → no_instability_detected, all 5 assessed
  ---
  duration_ms: 0.146833
  type: 'test'
  ...
# Subtest: instability three-state: partial vitals (temperature only) → assessed [T], rest missing
ok 457 - instability three-state: partial vitals (temperature only) → assessed [T], rest missing
  ---
  duration_ms: 0.421875
  type: 'test'
  ...
# Subtest: instability three-state: breach → unstable, reasons byte-identical to unchanged logic
ok 458 - instability three-state: breach → unstable, reasons byte-identical to unchanged logic
  ---
  duration_ms: 0.837625
  type: 'test'
  ...
# Subtest: instability invariant: unstable === (assessment === "unstable"); emptyClinicalState passes updated zod
ok 459 - instability invariant: unstable === (assessment === "unstable"); emptyClinicalState passes updated zod
  ---
  duration_ms: 0.945541
  type: 'test'
  ...
# Subtest: normalizeWithLlm: verified spans accepted with offsets; unverifiable spans REJECTED
ok 460 - normalizeWithLlm: verified spans accepted with offsets; unverifiable spans REJECTED
  ---
  duration_ms: 0.258291
  type: 'test'
  ...
# Subtest: mergeLlmFindings: resolves checklist unknowns, dedupes, sorts absent into negatives
ok 461 - mergeLlmFindings: resolves checklist unknowns, dedupes, sorts absent into negatives
  ---
  duration_ms: 0.436875
  type: 'test'
  ...
# Subtest: polarity MARKER: a negation-headed span labelled present is MARKED and KEPT — the live case
ok 462 - polarity MARKER: a negation-headed span labelled present is MARKED and KEPT — the live case
  ---
  duration_ms: 0.376417
  type: 'test'
  ...
# Subtest: polarity MARKER: the bank cases that killed the FILTER are kept, and merely annotated
ok 463 - polarity MARKER: the bank cases that killed the FILTER are kept, and merely annotated
  ---
  duration_ms: 0.223083
  type: 'test'
  ...
# Subtest: polarity MARKER: cue immediately LEFT of the span marks too
ok 464 - polarity MARKER: cue immediately LEFT of the span marks too
  ---
  duration_ms: 0.138
  type: 'test'
  ...
# Subtest: polarity MARKER: head-governed ONLY — a mid-span cue is a modifier, and absent/historical are untouched
ok 465 - polarity MARKER: head-governed ONLY — a mid-span cue is a modifier, and absent/historical are untouched
  ---
  duration_ms: 0.084125
  type: 'test'
  ...
# Subtest: polarity MARKER: a marked finding still validates against the .strict() schema
ok 466 - polarity MARKER: a marked finding still validates against the .strict() schema
  ---
  duration_ms: 0.294125
  type: 'test'
  ...
# Subtest: applyParsedInvestigations: rows land verbatim; only abnormals become positive findings
ok 467 - applyParsedInvestigations: rows land verbatim; only abnormals become positive findings
  ---
  duration_ms: 0.352917
  type: 'test'
  ...
# Subtest: buildDdxClinicalState composes stage 1 + investigations; floor + priors wire through
ok 468 - buildDdxClinicalState composes stage 1 + investigations; floor + priors wire through
  ---
  duration_ms: 0.452166
  type: 'test'
  ...
# Subtest: runGuards: clean deterministic state — every asserted rawText verbatim, sentinel exempt
ok 469 - runGuards: clean deterministic state — every asserted rawText verbatim, sentinel exempt
  ---
  duration_ms: 0.750625
  type: 'test'
  ...
# Subtest: runGuards: a finding whose rawText is NOT in its field is caught as fabricated
ok 470 - runGuards: a finding whose rawText is NOT in its field is caught as fabricated
  ---
  duration_ms: 0.191125
  type: 'test'
  ...
# Subtest: runGuards: sentinel unknown is never a fabrication even though "(not mentioned)" is not in the text
ok 471 - runGuards: sentinel unknown is never a fabrication even though "(not mentioned)" is not in the text
  ---
  duration_ms: 0.072458
  type: 'test'
  ...
# Subtest: runGuards: offset validation flags a wrong span; correct offsets pass
ok 472 - runGuards: offset validation flags a wrong span; correct offsets pass
  ---
  duration_ms: 0.077875
  type: 'test'
  ...
# Subtest: parseJudgeResponse: fenced JSON, clamps out-of-range, defaults bad verdict, keeps missed[]
ok 473 - parseJudgeResponse: fenced JSON, clamps out-of-range, defaults bad verdict, keeps missed[]
  ---
  duration_ms: 0.437708
  type: 'test'
  ...
# Subtest: summarizePath: guard means aggregate; judge is ALWAYS calibrated:false
ok 474 - summarizePath: guard means aggregate; judge is ALWAYS calibrated:false
  ---
  duration_ms: 0.205
  type: 'test'
  ...
# Subtest: headToHead: llm − det deltas; judge deltas null when a path lacks judge
ok 475 - headToHead: llm − det deltas; judge deltas null when a path lacks judge
  ---
  duration_ms: 0.264292
  type: 'test'
  ...
# Subtest: proposePromotionThreshold: never armed; floor = det baseline + noise margin
ok 476 - proposePromotionThreshold: never armed; floor = det baseline + noise margin
  ---
  duration_ms: 0.215667
  type: 'test'
  ...
# Subtest: scoreExtractorVsGold: recall/status matched; word-boundary match avoids ces⊂abscess
ok 477 - scoreExtractorVsGold: recall/status matched; word-boundary match avoids ces⊂abscess
  ---
  duration_ms: 11.251791
  type: 'test'
  ...
# Subtest: scoreExtractorVsGold: vitals granularity fold — HR/BP names+split match gold abbrev+value
ok 478 - scoreExtractorVsGold: vitals granularity fold — HR/BP names+split match gold abbrev+value
  ---
  duration_ms: 0.651333
  type: 'test'
  ...
# Subtest: calibrateJudge: low MAE ⇒ trustworthy; high MAE ⇒ retune
ok 479 - calibrateJudge: low MAE ⇒ trustworthy; high MAE ⇒ retune
  ---
  duration_ms: 0.151708
  type: 'test'
  ...
# Subtest: buildJudgeUser / judgeStateView: present the state without ids or offsets
ok 480 - buildJudgeUser / judgeStateView: present the state without ids or offsets
  ---
  duration_ms: 0.153417
  type: 'test'
  ...
# Subtest: adaptGoldSeed: flattens present/absent/unknown lanes; excludes riskFactors/investigations
ok 481 - adaptGoldSeed: flattens present/absent/unknown lanes; excludes riskFactors/investigations
  ---
  duration_ms: 0.149542
  type: 'test'
  ...
# Subtest: EXTRACTION_BANK is pinned to the frozen bank
ok 482 - EXTRACTION_BANK is pinned to the frozen bank
  ---
  duration_ms: 0.033916
  type: 'test'
  ...
# Subtest: medicationLineToAssertion: real db13 line → prescribed assertion with mapped fields + provenance
ok 483 - medicationLineToAssertion: real db13 line → prescribed assertion with mapped fields + provenance
  ---
  duration_ms: 0.618708
  type: 'test'
  ...
# Subtest: medicationLineToAssertion: DFO + Optiqmega → brand/generic mapped; generic optional
ok 484 - medicationLineToAssertion: DFO + Optiqmega → brand/generic mapped; generic optional
  ---
  duration_ms: 0.086416
  type: 'test'
  ...
# Subtest: medicationLineToAssertion: both brand + generic empty → null (skip the line)
ok 485 - medicationLineToAssertion: both brand + generic empty → null (skip the line)
  ---
  duration_ms: 0.0945
  type: 'test'
  ...
# Subtest: allergyTextToAssertions: NKA notations → one denied; empty → []; substantive → reported_allergy
ok 486 - allergyTextToAssertions: NKA notations → one denied; empty → []; substantive → reported_allergy
  ---
  duration_ms: 0.417167
  type: 'test'
  ...
# Subtest: allergyTextToAssertions: "NK" (not-known) → denied; substantive text containing nk is NOT swept
ok 487 - allergyTextToAssertions: "NK" (not-known) → denied; substantive text containing nk is NOT swept
  ---
  duration_ms: 0.067209
  type: 'test'
  ...
# Subtest: allergyTextToAssertions: substantive text → one reported_allergy, raw preserved, reaction null
ok 488 - allergyTextToAssertions: substantive text → one reported_allergy, raw preserved, reaction null
  ---
  duration_ms: 0.079792
  type: 'test'
  ...
# Subtest: prescriptionToAssertions: full 2-line array + "No" allergy → 2 med + 1 denied
ok 489 - prescriptionToAssertions: full 2-line array + "No" allergy → 2 med + 1 denied
  ---
  duration_ms: 0.151042
  type: 'test'
  ...
# Subtest: prescriptionToAssertions: accepts a JSON string array; skips empty lines
ok 490 - prescriptionToAssertions: accepts a JSON string array; skips empty lines
  ---
  duration_ms: 0.071375
  type: 'test'
  ...
# Subtest: prescriptionToAssertions: malformed / non-array input → empty, never throws
ok 491 - prescriptionToAssertions: malformed / non-array input → empty, never throws
  ---
  duration_ms: 0.344792
  type: 'test'
  ...
# Subtest: id determinism: same input → same id across calls (both assertion kinds)
ok 492 - id determinism: same input → same id across calls (both assertion kinds)
  ---
  duration_ms: 0.313791
  type: 'test'
  ...
# Subtest: schema: emptyClinicalState is 1.1 with empty assertion arrays and passes the updated zod
ok 493 - schema: emptyClinicalState is 1.1 with empty assertion arrays and passes the updated zod
  ---
  duration_ms: 1.506666
  type: 'test'
  ...
# Subtest: Provenance trust axis (1.2): optional reporter/trust validate; absent still validates
ok 494 - Provenance trust axis (1.2): optional reporter/trust validate; absent still validates
  ---
  duration_ms: 2.196792
  type: 'test'
  ...
# Subtest: MedicationAssertion.stopReason enum validates through the state
ok 495 - MedicationAssertion.stopReason enum validates through the state
  ---
  duration_ms: 0.319709
  type: 'test'
  ...
# Subtest: zComplaintStatusAssertion validates ComplaintStatus, rejects bogus
ok 496 - zComplaintStatusAssertion validates ComplaintStatus, rejects bogus
  ---
  duration_ms: 0.184167
  type: 'test'
  ...
# Subtest: zFollowUpAssertion validates FollowUpAction (+ optional targetDate), rejects bogus
ok 497 - zFollowUpAssertion validates FollowUpAction (+ optional targetDate), rejects bogus
  ---
  duration_ms: 0.219584
  type: 'test'
  ...
# Subtest: emptyClinicalState validates and carries the version literal
ok 498 - emptyClinicalState validates and carries the version literal
  ---
  duration_ms: 1.557417
  type: 'test'
  ...
# Subtest: a populated state validates: findings, audit ext, timeline, adminFacts
ok 499 - a populated state validates: findings, audit ext, timeline, adminFacts
  ---
  duration_ms: 0.93675
  type: 'test'
  ...
# Subtest: validation rejects a bad finding status, a missing provenance, an unknown ext kind
ok 500 - validation rejects a bad finding status, a missing provenance, an unknown ext kind
  ---
  duration_ms: 0.47
  type: 'test'
  ...
# Subtest: mkFindingId is deterministic and status-sensitive
ok 501 - mkFindingId is deterministic and status-sensitive
  ---
  duration_ms: 0.138333
  type: 'test'
  ...
# Subtest: stateCounts mirrors the arrays
ok 502 - stateCounts mirrors the arrays
  ---
  duration_ms: 0.069541
  type: 'test'
  ...
# Subtest: formatClinicalState renders every populated section, skips empty ones
ok 503 - formatClinicalState renders every populated section, skips empty ones
  ---
  duration_ms: 0.228583
  type: 'test'
  ...
# Subtest: clinicalStateResultField: flag OFF returns {} — result payload byte-identical
ok 504 - clinicalStateResultField: flag OFF returns {} — result payload byte-identical
  ---
  duration_ms: 1.707041
  type: 'test'
  ...
# Subtest: clinicalStateResultField: null/undefined state returns {} even when enabled
ok 505 - clinicalStateResultField: null/undefined state returns {} even when enabled
  ---
  duration_ms: 0.190625
  type: 'test'
  ...
# Subtest: clinicalStateResultField: flag ON attaches the trimmed view
ok 506 - clinicalStateResultField: flag ON attaches the trimmed view
  ---
  duration_ms: 0.433709
  type: 'test'
  ...
# Subtest: toClinicalStateUiView: counts mirror stateCounts; provenance preserved for hover
ok 507 - toClinicalStateUiView: counts mirror stateCounts; provenance preserved for hover
  ---
  duration_ms: 0.160625
  type: 'test'
  ...
# Subtest: the production exhibit shape: "Diagnosis documented without a code" → coding_completeness
ok 508 - the production exhibit shape: "Diagnosis documented without a code" → coding_completeness
  ---
  duration_ms: 0.720291
  type: 'test'
  ...
# Subtest: the regex catches the documented phrasings
ok 509 - the regex catches the documented phrasings
  ---
  duration_ms: 0.348292
  type: 'test'
  ...
# Subtest: a CLINICAL diagnosis-missing finding is NOT a coding gap and passes through
ok 510 - a CLINICAL diagnosis-missing finding is NOT a coding gap and passes through
  ---
  duration_ms: 0.213334
  type: 'test'
  ...
# Subtest: deterministic findings pass through the metadata neutralizer untouched
ok 511 - deterministic findings pass through the metadata neutralizer untouched
  ---
  duration_ms: 0.047459
  type: 'test'
  ...
# Subtest: CODING_GAP_RE is byte-identical — the batch changed nothing
ok 512 - CODING_GAP_RE is byte-identical — the batch changed nothing
  ---
  duration_ms: 0.931167
  type: 'test'
  ...
# Subtest: branchForVerdict maps verdicts to branches
ok 513 - branchForVerdict maps verdicts to branches
  ---
  duration_ms: 1.778833
  type: 'test'
  ...
# Subtest: floorFor detects in-scope analytes and dedups
ok 514 - floorFor detects in-scope analytes and dedups
  ---
  duration_ms: 0.201084
  type: 'test'
  ...
# Subtest: prompt injects the cannot-miss floor for the analyte
ok 515 - prompt injects the cannot-miss floor for the analyte
  ---
  duration_ms: 0.608209
  type: 'test'
  ...
# Subtest: parser extracts a single committed verdict
ok 516 - parser extracts a single committed verdict
  ---
  duration_ms: 0.433625
  type: 'test'
  ...
# Subtest: parser flags multiple verdicts (the A1 mini failure mode)
ok 517 - parser flags multiple verdicts (the A1 mini failure mode)
  ---
  duration_ms: 0.23375
  type: 'test'
  ...
# Subtest: scoreCase: correct branch-A verdict + gap hit + cannot-miss covered
ok 518 - scoreCase: correct branch-A verdict + gap hit + cannot-miss covered
  ---
  duration_ms: 0.117792
  type: 'test'
  ...
# Subtest: scoreCase: control marked discordant is over-flagged
ok 519 - scoreCase: control marked discordant is over-flagged
  ---
  duration_ms: 0.109125
  type: 'test'
  ...
# Subtest: inferUnit picks the unit by magnitude and flags the ambiguous zone
ok 520 - inferUnit picks the unit by magnitude and flags the ambiguous zone
  ---
  duration_ms: 0.083042
  type: 'test'
  ...
# Subtest: resultHasUnit / unitAnnotations only annotate when no unit is typed
ok 521 - resultHasUnit / unitAnnotations only annotate when no unit is typed
  ---
  duration_ms: 0.25375
  type: 'test'
  ...
# Subtest: unitContext flags ambiguity for a clarifying question, assumes otherwise
ok 522 - unitContext flags ambiguity for a clarifying question, assumes otherwise
  ---
  duration_ms: 0.32475
  type: 'test'
  ...
# Subtest: populationLines flags an extreme value against real base rates
ok 523 - populationLines flags an extreme value against real base rates
  ---
  duration_ms: 0.175417
  type: 'test'
  ...
# Subtest: populationLines handles comma numbers and returns nothing off-scope
ok 524 - populationLines handles comma numbers and returns nothing off-scope
  ---
  duration_ms: 0.056875
  type: 'test'
  ...
# Subtest: POPULATION_PRIORS covers the tight analyte set
ok 525 - POPULATION_PRIORS covers the tight analyte set
  ---
  duration_ms: 0.094459
  type: 'test'
  ...
# Subtest: normalizeBelief sums to 1 and topBelief picks the leader
ok 526 - normalizeBelief sums to 1 and topBelief picks the leader
  ---
  duration_ms: 0.09725
  type: 'test'
  ...
# Subtest: isUnknownAnswer recognises "I don't have this" variants
ok 527 - isUnknownAnswer recognises "I don't have this" variants
  ---
  duration_ms: 0.273666
  type: 'test'
  ...
# Subtest: shouldStop fires on cap, confidence, unknown-streak, and belief threshold
ok 528 - shouldStop fires on cap, confidence, unknown-streak, and belief threshold
  ---
  duration_ms: 0.092667
  type: 'test'
  ...
# Subtest: recordTurn tracks unknown streak (resets on an answer) and lifts leadConfidence
ok 529 - recordTurn tracks unknown streak (resets on an answer) and lifts leadConfidence
  ---
  duration_ms: 0.096167
  type: 'test'
  ...
# Subtest: recordTurn logs an open gap on "I don't have this" and increments count
ok 530 - recordTurn logs an open gap on "I don't have this" and increments count
  ---
  duration_ms: 0.052208
  type: 'test'
  ...
# Subtest: toVerdictContext folds transcript + open gaps into the context
ok 531 - toVerdictContext folds transcript + open gaps into the context
  ---
  duration_ms: 0.108875
  type: 'test'
  ...
# Subtest: parseSeed reads branch|weight|cause lines and normalises
ok 532 - parseSeed reads branch|weight|cause lines and normalises
  ---
  duration_ms: 0.160875
  type: 'test'
  ...
# Subtest: parseSeed tolerates a stray leading label (BRANCH|B|0.4|cause)
ok 533 - parseSeed tolerates a stray leading label (BRANCH|B|0.4|cause)
  ---
  duration_ms: 0.052292
  type: 'test'
  ...
# Subtest: parseNextQuestion parses a question and detects STOP
ok 534 - parseNextQuestion parses a question and detects STOP
  ---
  duration_ms: 0.227291
  type: 'test'
  ...
# Subtest: extractDemographics reads compact and worded forms, else null
ok 535 - extractDemographics reads compact and worded forms, else null
  ---
  duration_ms: 0.368833
  type: 'test'
  ...
# Subtest: coarseBand maps age to the mined bands
ok 536 - coarseBand maps age to the mined bands
  ---
  duration_ms: 0.038459
  type: 'test'
  ...
# Subtest: effectivePrior uses the sex cell (Hb F<M) and falls back when a cell is sparse/missing
ok 537 - effectivePrior uses the sex cell (Hb F<M) and falls back when a cell is sparse/missing
  ---
  duration_ms: 0.132916
  type: 'test'
  ...
# Subtest: populationLines is sex-stratified when the context gives age/sex
ok 538 - populationLines is sex-stratified when the context gives age/sex
  ---
  duration_ms: 0.088291
  type: 'test'
  ...
# Subtest: buildRunRecord is de-identified: analytes + verdict + counts, no raw text
ok 539 - buildRunRecord is de-identified: analytes + verdict + counts, no raw text
  ---
  duration_ms: 0.163291
  type: 'test'
  ...
# Subtest: summarize aggregates the bank
ok 540 - summarize aggregates the bank
  ---
  duration_ms: 0.117042
  type: 'test'
  ...
# Subtest: (1) SEPARATION: the consensus store is ipd_gold_adjudication, never ipd_audit_feedback
ok 541 - (1) SEPARATION: the consensus store is ipd_gold_adjudication, never ipd_audit_feedback
  ---
  duration_ms: 0.568042
  type: 'test'
  ...
# Subtest: (2) VOCABULARY: exactly tp | valid_extra | false | nitpick | contested
ok 542 - (2) VOCABULARY: exactly tp | valid_extra | false | nitpick | contested
  ---
  duration_ms: 0.463792
  type: 'test'
  ...
# Subtest: (3a) DE-IDENTIFICATION: the harness gates finding text against URLs and PHI
ok 543 - (3a) DE-IDENTIFICATION: the harness gates finding text against URLs and PHI
  ---
  duration_ms: 0.392209
  type: 'test'
  ...
# Subtest: (3b) DE-IDENTIFICATION: the store schema carries no name/UHID column
ok 544 - (3b) DE-IDENTIFICATION: the store schema carries no name/UHID column
  ---
  duration_ms: 0.430584
  type: 'test'
  ...
# Subtest: (4) ONE MATCHER: rescore + harness share the matcher, neither keeps a copy
ok 545 - (4) ONE MATCHER: rescore + harness share the matcher, neither keeps a copy
  ---
  duration_ms: 0.693292
  type: 'test'
  ...
# Subtest: TarReader emits regular files with exact bytes, ignores dirs, across arbitrary chunk splits
ok 546 - TarReader emits regular files with exact bytes, ignores dirs, across arbitrary chunk splits
  ---
  duration_ms: 6.204708
  type: 'test'
  ...
# Subtest: TarReader honours an early stop (onFile → false) and drops the rest
ok 547 - TarReader honours an early stop (onFile → false) and drops the rest
  ---
  duration_ms: 0.456167
  type: 'test'
  ...
# Subtest: parseCsv handles quoted fields with embedded commas
ok 548 - parseCsv handles quoted fields with embedded commas
  ---
  duration_ms: 0.091916
  type: 'test'
  ...
# Subtest: parseOaManifest reads File/Title/Publisher/Accession by header position
ok 549 - parseOaManifest reads File/Title/Publisher/Accession by header position
  ---
  duration_ms: 0.155125
  type: 'test'
  ...
# Subtest: selectSeedBooks resolves the allowlist, excludes StatPearls, surfaces missing ids
ok 550 - selectSeedBooks resolves the allowlist, excludes StatPearls, surfaces missing ids
  ---
  duration_ms: 0.193917
  type: 'test'
  ...
# Subtest: sanitizeBookChunk strips NCBI cross-link label runs but keeps prose
ok 551 - sanitizeBookChunk strips NCBI cross-link label runs but keeps prose
  ---
  duration_ms: 2.40875
  type: 'test'
  ...
# Subtest: parseVerdict is fail-safe: valid → verdict; junk/empty/invalid → not_assessable, never a guess
ok 552 - parseVerdict is fail-safe: valid → verdict; junk/empty/invalid → not_assessable, never a guess
  ---
  duration_ms: 0.660792
  type: 'test'
  ...
# Subtest: support rate = directly / assessable; not_assessable excluded from the denominator
ok 553 - support rate = directly / assessable; not_assessable excluded from the denominator
  ---
  duration_ms: 0.166542
  type: 'test'
  ...
# Subtest: Wilson CI: sane bounds, tightens with n, all-supports stays < 1
ok 554 - Wilson CI: sane bounds, tightens with n, all-supports stays < 1
  ---
  duration_ms: 0.400208
  type: 'test'
  ...
# Subtest: cite-or-label fraction
ok 555 - cite-or-label fraction
  ---
  duration_ms: 0.08225
  type: 'test'
  ...
# Subtest: coverage-deficit histogram: deciles + median/p90, clamped
ok 556 - coverage-deficit histogram: deciles + median/p90, clamped
  ---
  duration_ms: 0.163542
  type: 'test'
  ...
# Subtest: the verifier prompt is registry-named + judges from excerpts alone (no patient record)
ok 557 - the verifier prompt is registry-named + judges from excerpts alone (no patient record)
  ---
  duration_ms: 0.261375
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: (a) priced output is total − prompt (reasoning-inclusive), never completion alone
ok 558 - (a) priced output is total − prompt (reasoning-inclusive), never completion alone
  ---
  duration_ms: 0.864791
  type: 'test'
  ...
# Subtest: (a) the rule degrades safely: no total ⇒ completion; never negative; missing usage ⇒ 0
ok 559 - (a) the rule degrades safely: no total ⇒ completion; never negative; missing usage ⇒ 0
  ---
  duration_ms: 0.217625
  type: 'test'
  ...
# Subtest: (b) a multimodal event’s envelope carries the model and reasoning-inclusive tokens_out
ok 560 - (b) a multimodal event’s envelope carries the model and reasoning-inclusive tokens_out
  ---
  duration_ms: 0.226958
  type: 'test'
  ...
# Subtest: (b) the multimodal transport passes an envelope with the reasoning-inclusive rule
ok 561 - (b) the multimodal transport passes an envelope with the reasoning-inclusive rule
  ---
  duration_ms: 1.686625
  type: 'test'
  ...
# Subtest: (c) the multimodal read is logged exactly once — no double count
ok 562 - (c) the multimodal read is logged exactly once — no double count
  ---
  duration_ms: 0.467084
  type: 'test'
  ...
# Subtest: (3) the IPD extract call passes traceId — without it the read self-logs nothing at all
ok 563 - (3) the IPD extract call passes traceId — without it the read self-logs nothing at all
  ---
  duration_ms: 0.2575
  type: 'test'
  ...
# Subtest: the historic backfill touches ONLY the four cost columns, and never re-derives the rule
ok 564 - the historic backfill touches ONLY the four cost columns, and never re-derives the rule
  ---
  duration_ms: 0.395916
  type: 'test'
  ...
# Subtest: the column path and the payload path state the SAME rule (they must never drift)
ok 565 - the column path and the payload path state the SAME rule (they must never drift)
  ---
  duration_ms: 0.3415
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: orderPair: canonical order on the normalised lowercase name; original names preserved; same norm as pairKey
ok 566 - orderPair: canonical order on the normalised lowercase name; original names preserved; same norm as pairKey
  ---
  duration_ms: 1.268459
  type: 'test'
  ...
# Subtest: all three construction sites emit the canonical order regardless of input order
ok 567 - all three construction sites emit the canonical order regardless of input order
  ---
  duration_ms: 0.847292
  type: 'test'
  ...
# Subtest: ddiFindings: the same two drugs in either meds[] order produce an identical finding_ref and stable_ref
ok 568 - ddiFindings: the same two drugs in either meds[] order produce an identical finding_ref and stable_ref
  ---
  duration_ms: 4.246458
  type: 'test'
  ...
# Subtest: ddiFindings: a three-drug script is ref-stable under full reversal (multiple pairs at once)
ok 569 - ddiFindings: a three-drug script is ref-stable under full reversal (multiple pairs at once)
  ---
  duration_ms: 2.595375
  type: 'test'
  ...
# Subtest: involvesTopical (ddiToFinding): topical de-escalation identical in either order
ok 570 - involvesTopical (ddiToFinding): topical de-escalation identical in either order
  ---
  duration_ms: 0.281416
  type: 'test'
  ...
# Subtest: bothNsaid (Ruling 1 suppression): topical NSAID–NSAID suppressed entirely in either order
ok 571 - bothNsaid (Ruling 1 suppression): topical NSAID–NSAID suppressed entirely in either order
  ---
  duration_ms: 0.144084
  type: 'test'
  ...
# Subtest: scope guard: canonicalisation changed no firing decision — pair count and content match a reversed run everywhere
ok 572 - scope guard: canonicalisation changed no firing decision — pair count and content match a reversed run everywhere
  ---
  duration_ms: 10.078583
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: THE PREMISE: resolveMedRoute returns null for the real gel — its name has no form word
ok 573 - THE PREMISE: resolveMedRoute returns null for the real gel — its name has no form word
  ---
  duration_ms: 8.208583
  type: 'test'
  ...
# Subtest: a med with dosageForm topical and a NULL resolveMedRoute now enters the topical set
ok 574 - a med with dosageForm topical and a NULL resolveMedRoute now enters the topical set
  ---
  duration_ms: 3.972
  type: 'test'
  ...
# Subtest: THE REAL CASE: oral NSAID + the gel with dosageForm topical produces NO drug_interaction
ok 575 - THE REAL CASE: oral NSAID + the gel with dosageForm topical produces NO drug_interaction
  ---
  duration_ms: 1.666458
  type: 'test'
  ...
# Subtest: THE CONTROL: the same pair with dosageForm UNSET still leaks — so the test measures the new path
ok 576 - THE CONTROL: the same pair with dosageForm UNSET still leaks — so the test measures the new path
  ---
  duration_ms: 0.626542
  type: 'test'
  ...
# Subtest: two ORAL NSAIDs still produce the finding, unchanged
ok 577 - two ORAL NSAIDs still produce the finding, unchanged
  ---
  duration_ms: 4.177
  type: 'test'
  ...
# Subtest: drops, inhaler and injection do NOT enter the topical set (DEC-4 keeps this narrow)
ok 578 - drops, inhaler and injection do NOT enter the topical set (DEC-4 keeps this narrow)
  ---
  duration_ms: 3.218416
  type: 'test'
  ...
# Subtest: resolveMedRoute === topical still qualifies on its own — the original path is intact
ok 579 - resolveMedRoute === topical still qualifies on its own — the original path is intact
  ---
  duration_ms: 0.628333
  type: 'test'
  ...
# Subtest: the NSAID–NSAID restriction holds: a topical NSAID + a NON-NSAID still fires
ok 580 - the NSAID–NSAID restriction holds: a topical NSAID + a NON-NSAID still fires
  ---
  duration_ms: 0.278667
  type: 'test'
  ...
# Subtest: a non-NSAID pair is unaffected — the QT rule still fires
ok 581 - a non-NSAID pair is unaffected — the QT rule still fires
  ---
  duration_ms: 0.926833
  type: 'test'
  ...
# Subtest: fewer than two eligible meds still returns nothing
ok 582 - fewer than two eligible meds still returns nothing
  ---
  duration_ms: 0.753625
  type: 'test'
  ...
# Subtest: the topical set reads BOTH sources, and Ruling 1 is byte-identical
ok 583 - the topical set reads BOTH sources, and Ruling 1 is byte-identical
  ---
  duration_ms: 21.047125
  type: 'test'
  ...
# Subtest: matchDx: normalized substring match, tolerant of qualifiers and punctuation
ok 584 - matchDx: normalized substring match, tolerant of qualifiers and punctuation
  ---
  duration_ms: 1.134166
  type: 'test'
  ...
# Subtest: matchDx: synonyms match when the literal expected string does not
ok 585 - matchDx: synonyms match when the literal expected string does not
  ---
  duration_ms: 0.155334
  type: 'test'
  ...
# Subtest: matchDx: negatives — unrelated diagnoses and short-token false hits rejected
ok 586 - matchDx: negatives — unrelated diagnoses and short-token false hits rejected
  ---
  duration_ms: 0.121083
  type: 'test'
  ...
# Subtest: matchDx v3: INTERIOR mid-word hit rejected, but boundary-anchored matches preserved
ok 587 - matchDx v3: INTERIOR mid-word hit rejected, but boundary-anchored matches preserved
  ---
  duration_ms: 0.071833
  type: 'test'
  ...
# Subtest: rankedDifferential is most_likely order; allEntries spans the three axes
ok 588 - rankedDifferential is most_likely order; allEntries spans the three axes
  ---
  duration_ms: 0.356083
  type: 'test'
  ...
# Subtest: fabricated-finding heuristic: flags asserted-but-unstated findings only
ok 589 - fabricated-finding heuristic: flags asserted-but-unstated findings only
  ---
  duration_ms: 0.171292
  type: 'test'
  ...
# Subtest: scoreDdxCase: clean fixture — top-1 hit, cannot-miss covered, nothing flagged
ok 590 - scoreDdxCase: clean fixture — top-1 hit, cannot-miss covered, nothing flagged
  ---
  duration_ms: 0.663208
  type: 'test'
  ...
# Subtest: scoreDdxCase: dirty fixture — every failure mode fires
ok 591 - scoreDdxCase: dirty fixture — every failure mode fires
  ---
  duration_ms: 0.187958
  type: 'test'
  ...
# Subtest: scoreDdxCase: synonym match covers cannot-miss ("AAA rupture" counts as ruptured AAA)
ok 592 - scoreDdxCase: synonym match covers cannot-miss ("AAA rupture" counts as ruptured AAA)
  ---
  duration_ms: 0.2165
  type: 'test'
  ...
# Subtest: scoreDdxCase: empty result — misses everything, never throws
ok 593 - scoreDdxCase: empty result — misses everything, never throws
  ---
  duration_ms: 0.305792
  type: 'test'
  ...
# Subtest: summarizeDdx: rates over the right denominators, incl. the null cannot-miss path
ok 594 - summarizeDdx: rates over the right denominators, incl. the null cannot-miss path
  ---
  duration_ms: 0.192958
  type: 'test'
  ...
# Subtest: summarizeDdx: no case specifies cannot-miss → recall defaults to 1; empty bank never divides by 0
ok 595 - summarizeDdx: no case specifies cannot-miss → recall defaults to 1; empty bank never divides by 0
  ---
  duration_ms: 0.052167
  type: 'test'
  ...
# Subtest: A1 matcher v2: British↔American spelling variants now match
ok 596 - A1 matcher v2: British↔American spelling variants now match
  ---
  duration_ms: 0.081625
  type: 'test'
  ...
# Subtest: A1 matcher v2: does NOT over-match unrelated diagnoses (containment unchanged)
ok 597 - A1 matcher v2: does NOT over-match unrelated diagnoses (containment unchanged)
  ---
  duration_ms: 0.044458
  type: 'test'
  ...
# Subtest: A2 lane coverage: covered iff ≥1 lane dx matches any engine axis
ok 598 - A2 lane coverage: covered iff ≥1 lane dx matches any engine axis
  ---
  duration_ms: 0.144166
  type: 'test'
  ...
# Subtest: A2 lane coverage: null (skipped) when a case defines no expectedLanes
ok 599 - A2 lane coverage: null (skipped) when a case defines no expectedLanes
  ---
  duration_ms: 0.077417
  type: 'test'
  ...
# Subtest: A2 laneCoverageRate: mean per-case rate over labelled cases only; null when none labelled
ok 600 - A2 laneCoverageRate: mean per-case rate over labelled cases only; null when none labelled
  ---
  duration_ms: 0.106417
  type: 'test'
  ...
# Subtest: A3 negative misuse: fires when a considered dx asserts a documented-negative finding
ok 601 - A3 negative misuse: fires when a considered dx asserts a documented-negative finding
  ---
  duration_ms: 0.262834
  type: 'test'
  ...
# Subtest: A3 cannot-miss over-flag: fires when an unsupported cannot-miss dx is surfaced
ok 602 - A3 cannot-miss over-flag: fires when an unsupported cannot-miss dx is surfaced
  ---
  duration_ms: 0.130334
  type: 'test'
  ...
# Subtest: A3 summary rates: denominated over labelled cases; null when none labelled
ok 603 - A3 summary rates: denominated over labelled cases; null when none labelled
  ---
  duration_ms: 0.061875
  type: 'test'
  ...
# Subtest: A4 latency: nearest-rank P50/P90 from supplied ms; null when none
ok 604 - A4 latency: nearest-rank P50/P90 from supplied ms; null when none
  ---
  duration_ms: 0.106417
  type: 'test'
  ...
# Subtest: A6 version stamping: summary carries matcher + bank versions
ok 605 - A6 version stamping: summary carries matcher + bank versions
  ---
  duration_ms: 0.047792
  type: 'test'
  ...
# Subtest: A6 freeze guard: dormant passes; active passes on match, fails on mismatch
ok 606 - A6 freeze guard: dormant passes; active passes on match, fails on mismatch
  ---
  duration_ms: 0.069708
  type: 'test'
  ...
# Subtest: A5 scoreFromResultsJson: re-scores a saved results file with no network
ok 607 - A5 scoreFromResultsJson: re-scores a saved results file with no network
  ---
  duration_ms: 0.570917
  type: 'test'
  ...
# Subtest: FREEZE: pinned pair is ddx-eval/3 + ddx-case-bank/1.0 and matches the committed bank
ok 608 - FREEZE: pinned pair is ddx-eval/3 + ddx-case-bank/1.0 and matches the committed bank
  ---
  duration_ms: 1.077459
  type: 'test'
  ...
# Subtest: F3 collision guard: no two cannot-miss dx in any case collapse under matcher + synonyms
ok 609 - F3 collision guard: no two cannot-miss dx in any case collapse under matcher + synonyms
  ---
  duration_ms: 2.435292
  type: 'test'
  ...
# Subtest: existing 7 summary metrics are byte-identical on an unchanged score set
ok 610 - existing 7 summary metrics are byte-identical on an unchanged score set
  ---
  duration_ms: 0.211
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: r1 — the callback type carries the map, and it is TRAILING and OPTIONAL
ok 611 - r1 — the callback type carries the map, and it is TRAILING and OPTIONAL
  ---
  duration_ms: 2.625833
  type: 'test'
  ...
# Subtest: r2 — the two DECLARATION publications pass no map
ok 612 - r2 — the two DECLARATION publications pass no map
  ---
  duration_ms: 2.429125
  type: 'test'
  ...
# Subtest: r3 — BOTH terminal publications pass a SHALLOW SNAPSHOT, never the live object
ok 613 - r3 — BOTH terminal publications pass a SHALLOW SNAPSHOT, never the live object
  ---
  duration_ms: 1.040709
  type: 'test'
  ...
# Subtest: r3b — a shallow snapshot really is immune to the mutation that follows it
ok 614 - r3b — a shallow snapshot really is immune to the mutation that follows it
  ---
  duration_ms: 0.859041
  type: 'test'
  ...
# Subtest: r5 — NO owner reads `?? {}` any more, anywhere in the repository
ok 615 - r5 — NO owner reads `?? {}` any more, anywhere in the repository
  ---
  duration_ms: 2.713333
  type: 'test'
  ...
# Subtest: r4 — every owner prefers the ATTACHED map, then the CALLBACK map, then undefined
ok 616 - r4 — every owner prefers the ATTACHED map, then the CALLBACK map, then undefined
  ---
  duration_ms: 1.60175
  type: 'test'
  ...
# Subtest: r4b — the selection order, exercised against the REAL attach and read
ok 617 - r4b — the selection order, exercised against the REAL attach and read
  ---
  duration_ms: 0.143709
  type: 'test'
  ...
# Subtest: r4c — the two callback sites that read NO map were not changed
ok 618 - r4c — the two callback sites that read NO map were not changed
  ---
  duration_ms: 0.599291
  type: 'test'
  ...
# Subtest: r11 — line 1723 is not wrapped, not rewritten, and still the only unattached return
ok 619 - r11 — line 1723 is not wrapped, not rewritten, and still the only unattached return
  ---
  duration_ms: 0.973
  type: 'test'
  ...
# Subtest: §4.1 CHECK 1: the prefix alone does NOT set direction when class-absence objects
ok 620 - §4.1 CHECK 1: the prefix alone does NOT set direction when class-absence objects
  ---
  duration_ms: 1.798542
  type: 'test'
  ...
# Subtest: with no objection, the prefix sets direction — both values
ok 621 - with no objection, the prefix sets direction — both values
  ---
  duration_ms: 0.375333
  type: 'test'
  ...
# Subtest: an absent/blank/foreign concept_id yields NO direction — undetermined is the honest default
ok 622 - an absent/blank/foreign concept_id yields NO direction — undetermined is the honest default
  ---
  duration_ms: 0.152292
  type: 'test'
  ...
# Subtest: deterministic findings are never stamped
ok 623 - deterministic findings are never stamped
  ---
  duration_ms: 0.118541
  type: 'test'
  ...
# Subtest: the class-absence predicate has ONE implementation
ok 624 - the class-absence predicate has ONE implementation
  ---
  duration_ms: 0.621458
  type: 'test'
  ...
# Subtest: §4.3: an underuse finding scores IDENTICALLY to a note with no finding at all
ok 625 - §4.3: an underuse finding scores IDENTICALLY to a note with no finding at all
  ---
  duration_ms: 0.422208
  type: 'test'
  ...
# Subtest: …while the SAME finding marked overuse (or unmarked) still penalises — the control
ok 626 - …while the SAME finding marked overuse (or unmarked) still penalises — the control
  ---
  duration_ms: 0.173792
  type: 'test'
  ...
# Subtest: §4.4: SEVERITY and PENALTY_BASE are BYTE-IDENTICAL — no new member, no re-weighting
ok 627 - §4.4: SEVERITY and PENALTY_BASE are BYTE-IDENTICAL — no new member, no re-weighting
  ---
  duration_ms: 0.915834
  type: 'test'
  ...
# Subtest: NetValue is untouched — no member meaning underuse was added
ok 628 - NetValue is untouched — no member meaning underuse was added
  ---
  duration_ms: 0.855584
  type: 'test'
  ...
# Subtest: §4.5: an underuse finding receives NO lvc_category
ok 629 - §4.5: an underuse finding receives NO lvc_category
  ---
  duration_ms: 1.656125
  type: 'test'
  ...
# Subtest: §4.5: an underuse finding does not keep signal_type low_value_care
ok 630 - §4.5: an underuse finding does not keep signal_type low_value_care
  ---
  duration_ms: 0.575583
  type: 'test'
  ...
# Subtest: §4.6 THE REGRESSION THAT MATTERS: an OVERUSE finding is stamped exactly as before
ok 631 - §4.6 THE REGRESSION THAT MATTERS: an OVERUSE finding is stamped exactly as before
  ---
  duration_ms: 0.762459
  type: 'test'
  ...
# Subtest: finding ORDER is preserved by the gate — the report numbers findings by position
ok 632 - finding ORDER is preserved by the gate — the report numbers findings by position
  ---
  duration_ms: 0.469292
  type: 'test'
  ...
# Subtest: direction is stamped BEFORE stampLvcMetadata
ok 633 - direction is stamped BEFORE stampLvcMetadata
  ---
  duration_ms: 0.947958
  type: 'test'
  ...
# Subtest: the contradicted-by-structure neutraliser is GONE (0.81.19) and CODING_GAP_RE is byte-identical
ok 634 - the contradicted-by-structure neutraliser is GONE (0.81.19) and CODING_GAP_RE is byte-identical
  ---
  duration_ms: 1.172667
  type: 'test'
  ...
# Subtest: (1) ADAPTER: dischargeToEncounter → admission encounter, provenance preserved, no fabrication
ok 635 - (1) ADAPTER: dischargeToEncounter → admission encounter, provenance preserved, no fabrication
  ---
  duration_ms: 0.804042
  type: 'test'
  ...
# Subtest: (2) COMPOSITION: flag ON appends the admission at the tail
ok 636 - (2) COMPOSITION: flag ON appends the admission at the tail
  ---
  duration_ms: 0.449
  type: 'test'
  ...
# Subtest: (3) BYTE-IDENTICAL: the OPD+labs encounters are EXACTLY the frozen output; admission is additive
ok 637 - (3) BYTE-IDENTICAL: the OPD+labs encounters are EXACTLY the frozen output; admission is additive
  ---
  duration_ms: 0.331416
  type: 'test'
  ...
# Subtest: (3) DEFAULT-OFF: flag off (or no episode) ⇒ deep-equal to the frozen assembleEvidence
ok 638 - (3) DEFAULT-OFF: flag off (or no episode) ⇒ deep-equal to the frozen assembleEvidence
  ---
  duration_ms: 0.327708
  type: 'test'
  ...
# Subtest: the adapter reads the spine by TYPE only + composes, never edits (structural)
ok 639 - the adapter reads the spine by TYPE only + composes, never edits (structural)
  ---
  duration_ms: 0.210583
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: a write degrades to "skipped" and a read to null — never a throw
ok 640 - a write degrades to "skipped" and a read to null — never a throw
  ---
  duration_ms: 0.5625
  type: 'test'
  ...
# Subtest: absent and unreachable are the same answer to the reader: extract it yourself
ok 641 - absent and unreachable are the same answer to the reader: extract it yourself
  ---
  duration_ms: 0.073792
  type: 'test'
  ...
# Subtest: rowToStoredCase round-trips a stored row
ok 642 - rowToStoredCase round-trips a stored row
  ---
  duration_ms: 0.405917
  type: 'test'
  ...
# Subtest: a jsonb column handed back as TEXT is tolerated; unusable payloads are refused, not guessed
ok 643 - a jsonb column handed back as TEXT is tolerated; unusable payloads are refused, not guessed
  ---
  duration_ms: 0.1445
  type: 'test'
  ...
# Subtest: the extraction version is a shared constant both readers move on together
ok 644 - the extraction version is a shared constant both readers move on together
  ---
  duration_ms: 0.054166
  type: 'test'
  ...
# [doc-audit-core] normNetValue: unparseable verdict "nonsense" → 'uncertain' (parse fallback, not a clinical judgment)
# Subtest: normDocType maps synonyms + defaults to discharge_summary
ok 645 - normDocType maps synonyms + defaults to discharge_summary
  ---
  duration_ms: 1.362417
  type: 'test'
  ...
# Subtest: normFieldStatus + normNetValue map + default
ok 646 - normFieldStatus + normNetValue map + default
  ---
  duration_ms: 0.504834
  type: 'test'
  ...
# Subtest: parseExtraction reads a fenced extraction, honours docTypeHint, de-id age/sex only, + completeness/adminFacts
ok 647 - parseExtraction reads a fenced extraction, honours docTypeHint, de-id age/sex only, + completeness/adminFacts
  ---
  duration_ms: 0.356583
  type: 'test'
  ...
# Subtest: parseExtraction docTypeHint overrides detected
ok 648 - parseExtraction docTypeHint overrides detected
  ---
  duration_ms: 0.252958
  type: 'test'
  ...
# Subtest: parseExtraction returns null when nothing was read
ok 649 - parseExtraction returns null when nothing was read
  ---
  duration_ms: 0.152958
  type: 'test'
  ...
# Subtest: parseAnalysis parses findings/diff/suggestions (no completeness); maps diff kinds; sorts suggestions
ok 650 - parseAnalysis parses findings/diff/suggestions (no completeness); maps diff kinds; sorts suggestions
  ---
  duration_ms: 1.129458
  type: 'test'
  ...
# Subtest: parseAnalysis returns null on empty/garbage; survives on idealised-only
ok 651 - parseAnalysis returns null on empty/garbage; survives on idealised-only
  ---
  duration_ms: 0.16775
  type: 'test'
  ...
# Subtest: parseStatusList + normAdminFacts: status-only, day-count not dates
ok 652 - parseStatusList + normAdminFacts: status-only, day-count not dates
  ---
  duration_ms: 0.2065
  type: 'test'
  ...
# Subtest: assembleCompleteness scores present/partial/na/missing over non-conditional mandatory fields
ok 653 - assembleCompleteness scores present/partial/na/missing over non-conditional mandatory fields
  ---
  duration_ms: 0.820625
  type: 'test'
  ...
# Subtest: assembleCompleteness counts partial as 0.5 and includes an applicable conditional field
ok 654 - assembleCompleteness counts partial as 0.5 and includes an applicable conditional field
  ---
  duration_ms: 0.704833
  type: 'test'
  ...
# Subtest: PX-R3: OLD-shape extraction (no risk_factors/aftercare) parses with every pre-existing field unchanged + safe defaults for the new keys
ok 655 - PX-R3: OLD-shape extraction (no risk_factors/aftercare) parses with every pre-existing field unchanged + safe defaults for the new keys
  ---
  duration_ms: 0.298875
  type: 'test'
  ...
# Subtest: PX-G2 pin: buildAnalyzeUser includes stated risk factors so safety findings (e.g. allergy breaches) stay visible to the analyze pass
ok 656 - PX-G2 pin: buildAnalyzeUser includes stated risk factors so safety findings (e.g. allergy breaches) stay visible to the analyze pass
  ---
  duration_ms: 0.403959
  type: 'test'
  ...
# Subtest: PX-R3: NEW-shape extraction parses risk_factors + aftercare; empty aftercare collapses to undefined
ok 657 - PX-R3: NEW-shape extraction parses risk_factors + aftercare; empty aftercare collapses to undefined
  ---
  duration_ms: 0.333833
  type: 'test'
  ...
# Subtest: enrichQueryForFinding joins subject + evidence + rationale, trims blanks, length-bounds
ok 658 - enrichQueryForFinding joins subject + evidence + rationale, trims blanks, length-bounds
  ---
  duration_ms: 0.187083
  type: 'test'
  ...
# Subtest: unionEnrichedHits keeps base as an identity prefix, dedupes by id, appends net-new, respects cap
ok 659 - unionEnrichedHits keeps base as an identity prefix, dedupes by id, appends net-new, respects cap
  ---
  duration_ms: 0.479291
  type: 'test'
  ...
# Subtest: unionEnrichedHits keys by String(id) — DB returns bigint chunk ids as STRINGS (regression)
ok 660 - unionEnrichedHits keys by String(id) — DB returns bigint chunk ids as STRINGS (regression)
  ---
  duration_ms: 0.277625
  type: 'test'
  ...
# Subtest: SL2: AUDIT_REVISE_SYSTEM carries the empty-citation→estimates discipline for the enriched pool
ok 661 - SL2: AUDIT_REVISE_SYSTEM carries the empty-citation→estimates discipline for the enriched pool
  ---
  duration_ms: 0.160959
  type: 'test'
  ...
# Subtest: applyCitationGate: partial drop keeps evidence + surviving citations
ok 662 - applyCitationGate: partial drop keeps evidence + surviving citations
  ---
  duration_ms: 0.257
  type: 'test'
  ...
# Subtest: applyCitationGate: dropping ALL citations relabels evidence→estimates (cite-or-label)
ok 663 - applyCitationGate: dropping ALL citations relabels evidence→estimates (cite-or-label)
  ---
  duration_ms: 0.133416
  type: 'test'
  ...
# Subtest: applyCitationGate: no drops → untouched; multi-finding indices are respected
ok 664 - applyCitationGate: no drops → untouched; multi-finding indices are respected
  ---
  duration_ms: 0.129125
  type: 'test'
  ...
# Subtest: applyCitationGate: emptying a finding with NO evidence drops cites without relabel
ok 665 - applyCitationGate: emptying a finding with NO evidence drops cites without relabel
  ---
  duration_ms: 0.211375
  type: 'test'
  ...
# Subtest: §2.3: magic numbers identify the document
ok 666 - §2.3: magic numbers identify the document
  ---
  duration_ms: 0.537958
  type: 'test'
  ...
# Subtest: §2.3: an unsupported body returns NULL — the old code guessed application/pdf
ok 667 - §2.3: an unsupported body returns NULL — the old code guessed application/pdf
  ---
  duration_ms: 0.115417
  type: 'test'
  ...
# Subtest: §2.3: the URL-extension guess is GONE from ccb-brief; the bytes decide and null ⇒ unreadable
ok 668 - §2.3: the URL-extension guess is GONE from ccb-brief; the bytes decide and null ⇒ unreadable
  ---
  duration_ms: 0.080208
  type: 'test'
  ...
# Subtest: §2.3: the Record-audit upload sniffs too — the client mime is only a hint
ok 669 - §2.3: the Record-audit upload sniffs too — the client mime is only a hint
  ---
  duration_ms: 0.04775
  type: 'test'
  ...
# Subtest: §2.1: EXTRACT_SYSTEM demands an explicit marker and FORBIDS empty-fields-as-signal
ok 670 - §2.1: EXTRACT_SYSTEM demands an explicit marker and FORBIDS empty-fields-as-signal
  ---
  duration_ms: 0.059042
  type: 'test'
  ...
# Subtest: §2.1: the marker is honoured, in either shape
ok 671 - §2.1: the marker is honoured, in either shape
  ---
  duration_ms: 0.142541
  type: 'test'
  ...
# Subtest: §2.1 THE MEASURED FAILURE: a well-formed all-empty extract is a FAILED READ, not a report
ok 672 - §2.1 THE MEASURED FAILURE: a well-formed all-empty extract is a FAILED READ, not a report
  ---
  duration_ms: 0.138084
  type: 'test'
  ...
# Subtest: §2.1 control: ANY real clinical content survives — one field is enough
ok 673 - §2.1 control: ANY real clinical content survives — one field is enough
  ---
  duration_ms: 0.265541
  type: 'test'
  ...
# Subtest: §2.2: putExtract REFUSES an empty extract, at the write, before the immutable insert
ok 674 - §2.2: putExtract REFUSES an empty extract, at the write, before the immutable insert
  ---
  duration_ms: 0.476416
  type: 'test'
  ...
# Subtest: §1: the PDF engine is native, pinned explicitly — never the default that falls to mistral-ocr
ok 675 - §1: the PDF engine is native, pinned explicitly — never the default that falls to mistral-ocr
  ---
  duration_ms: 1.403375
  type: 'test'
  ...
# Subtest: §4: mistral-ocr appears NOWHERE in the shipped transport
ok 676 - §4: mistral-ocr appears NOWHERE in the shipped transport
  ---
  duration_ms: 0.472542
  type: 'test'
  ...
# Subtest: §3: the Google-only provider pin rides EVERY document call
ok 677 - §3: the Google-only provider pin rides EVERY document call
  ---
  duration_ms: 0.086334
  type: 'test'
  ...
# Subtest: §3: PDFs ride type:file; images ride type:image_url (built, but UNEXERCISED by production traffic)
ok 678 - §3: PDFs ride type:file; images ride type:image_url (built, but UNEXERCISED by production traffic)
  ---
  duration_ms: 0.114
  type: 'test'
  ...
# Subtest: §3: token headroom — Pro spends output budget on reasoning first
ok 679 - §3: token headroom — Pro spends output budget on reasoning first
  ---
  duration_ms: 0.04025
  type: 'test'
  ...
# Subtest: §3: a TIMEOUT bounds the read — its absence is why Record audit HUNG instead of failing
ok 680 - §3: a TIMEOUT bounds the read — its absence is why Record audit HUNG instead of failing
  ---
  duration_ms: 0.046458
  type: 'test'
  ...
# Subtest: §3: failures surface as provider_error AND as unreadable (null), never as an empty extract
ok 681 - §3: failures surface as provider_error AND as unreadable (null), never as an empty extract
  ---
  duration_ms: 1.667417
  type: 'test'
  ...
# Subtest: §4: the Vertex path is untouched and is what runs with the flag unset
ok 682 - §4: the Vertex path is untouched and is what runs with the flag unset
  ---
  duration_ms: 0.176542
  type: 'test'
  ...
# Subtest: normalizeDoctorName: order-independent, Dr/punct stripped
ok 683 - normalizeDoctorName: order-independent, Dr/punct stripped
  ---
  duration_ms: 0.774625
  type: 'test'
  ...
# Subtest: mobileLast4
ok 684 - mobileLast4
  ---
  duration_ms: 0.114542
  type: 'test'
  ...
# Subtest: isGenericDoctorRow: system/placeholder rows dropped
ok 685 - isGenericDoctorRow: system/placeholder rows dropped
  ---
  duration_ms: 0.170542
  type: 'test'
  ...
# Subtest: buildRoster: drops generics, dedupes same-person by mobile, folds activity
ok 686 - buildRoster: drops generics, dedupes same-person by mobile, folds activity
  ---
  duration_ms: 10.457542
  type: 'test'
  ...
# Subtest: buildRoster: no-mobile rows are never merged with each other
ok 687 - buildRoster: no-mobile rows are never merged with each other
  ---
  duration_ms: 0.241958
  type: 'test'
  ...
# Subtest: parseFrequency: dosing grid sums slots
ok 688 - parseFrequency: dosing grid sums slots
  ---
  duration_ms: 0.884
  type: 'test'
  ...
# Subtest: parseFrequency: spoken/abbreviated frequencies
ok 689 - parseFrequency: spoken/abbreviated frequencies
  ---
  duration_ms: 0.664959
  type: 'test'
  ...
# Subtest: parseFrequency: SOS is a ceiling, not a fixed dose
ok 690 - parseFrequency: SOS is a ceiling, not a fixed dose
  ---
  duration_ms: 0.134541
  type: 'test'
  ...
# Subtest: parseFrequency: empty/garbage → unknown
ok 691 - parseFrequency: empty/garbage → unknown
  ---
  duration_ms: 0.099666
  type: 'test'
  ...
# Subtest: unitsPerDose
ok 692 - unitsPerDose
  ---
  duration_ms: 0.211459
  type: 'test'
  ...
# Subtest: strengthTokenToMg: unit conversion
ok 693 - strengthTokenToMg: unit conversion
  ---
  duration_ms: 0.128125
  type: 'test'
  ...
# Subtest: canonicalMolecule maps synonyms + ignores non-ceiling co-molecules
ok 694 - canonicalMolecule maps synonyms + ignores non-ceiling co-molecules
  ---
  duration_ms: 0.451916
  type: 'test'
  ...
# Subtest: moleculesOf zips + aligns per-molecule strengths in a combo
ok 695 - moleculesOf zips + aligns per-molecule strengths in a combo
  ---
  duration_ms: 0.231167
  type: 'test'
  ...
# Subtest: moleculesOf: parenthetical strength list in the generic name does not misalign (real EMR shape)
ok 696 - moleculesOf: parenthetical strength list in the generic name does not misalign (real EMR shape)
  ---
  duration_ms: 0.210833
  type: 'test'
  ...
# Subtest: CASE A — paracetamol stacking across products flags an exceedance
ok 697 - CASE A — paracetamol stacking across products flags an exceedance
  ---
  duration_ms: 2.13525
  type: 'test'
  ...
# Subtest: CASE B — a single correctly-dosed NSAID + a different-indication drug does NOT flag
ok 698 - CASE B — a single correctly-dosed NSAID + a different-indication drug does NOT flag
  ---
  duration_ms: 0.344625
  type: 'test'
  ...
# Subtest: single product over its own ceiling still flags (no stacking required)
ok 699 - single product over its own ceiling still flags (no stacking required)
  ---
  duration_ms: 0.400166
  type: 'test'
  ...
# Subtest: SOS-only exceedance is a softer, lower-confidence advisory
ok 700 - SOS-only exceedance is a softer, lower-confidence advisory
  ---
  duration_ms: 0.227375
  type: 'test'
  ...
# Subtest: paediatric liquid/suspension (concentration strength, ml dose) is excluded — no false flag
ok 701 - paediatric liquid/suspension (concentration strength, ml dose) is excluded — no false flag
  ---
  duration_ms: 0.159875
  type: 'test'
  ...
# Subtest: same molecule in two products but within ceiling → informational only
ok 702 - same molecule in two products but within ceiling → informational only
  ---
  duration_ms: 0.173417
  type: 'test'
  ...
# Subtest: BUG-0.8-13: a syrup dosed "10ml (2 tsp)" is volumetric and its volume is never a tablet count
ok 703 - BUG-0.8-13: a syrup dosed "10ml (2 tsp)" is volumetric and its volume is never a tablet count
  ---
  duration_ms: 0.111708
  type: 'test'
  ...
# Subtest: §3.1 parseDurationDays (moved to the pure core) parses days/weeks/months, null for chronic/unparseable
ok 704 - §3.1 parseDurationDays (moved to the pure core) parses days/weeks/months, null for chronic/unparseable
  ---
  duration_ms: 0.516417
  type: 'test'
  ...
# Subtest: Decision 5 — naproxen: 1250 mg over a 1-day course does NOT fire; over 5 days it fires
ok 705 - Decision 5 — naproxen: 1250 mg over a 1-day course does NOT fire; over 5 days it fires
  ---
  duration_ms: 0.557042
  type: 'test'
  ...
# Subtest: Decision 6 — etoricoxib: 120 with gout → no finding; 120 without → fires; 90 without → no finding
ok 706 - Decision 6 — etoricoxib: 120 with gout → no finding; 120 without → fires; 90 without → no finding
  ---
  duration_ms: 0.381583
  type: 'test'
  ...
# Subtest: §4 fail-safe — omitting ctx is identical to passing it for molecules without conditional fields
ok 707 - §4 fail-safe — omitting ctx is identical to passing it for molecules without conditional fields
  ---
  duration_ms: 1.461583
  type: 'test'
  ...
# Subtest: Decision 7/8 — metformin: 500+500 within ceiling → informational (conf 0); 1500+2000 → scoring exceedance (clinician-signed)
ok 708 - Decision 7/8 — metformin: 500+500 within ceiling → informational (conf 0); 1500+2000 → scoring exceedance (clinician-signed)
  ---
  duration_ms: 0.696459
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: the 1-Aug regression shape: L-3 with no base praise is VACUOUS, not HOLDS
ok 709 - the 1-Aug regression shape: L-3 with no base praise is VACUOUS, not HOLDS
  ---
  duration_ms: 7.396125
  type: 'test'
  ...
# Subtest: every Part C relation is VACUOUS in the state that makes IT untestable
ok 710 - every Part C relation is VACUOUS in the state that makes IT untestable
  ---
  duration_ms: 0.474209
  type: 'test'
  ...
# Subtest: L-1/L-2 precondition is base fires; L-3 precondition is base praise, not base fires
ok 711 - L-1/L-2 precondition is base fires; L-3 precondition is base praise, not base fires
  ---
  duration_ms: 0.390167
  type: 'test'
  ...
# Subtest: with the precondition met, the verdicts are the relation's own — HOLDS and FAILS both reachable
ok 712 - with the precondition met, the verdicts are the relation's own — HOLDS and FAILS both reachable
  ---
  duration_ms: 0.501917
  type: 'test'
  ...
# Subtest: RATIFIED_AT_ENGINE is pinned to the version the map was measured at — now 0.81.21
ok 713 - RATIFIED_AT_ENGINE is pinned to the version the map was measured at — now 0.81.21
  ---
  duration_ms: 0.243625
  type: 'test'
  ...
# Subtest: the drift warning is null at the deployed engine, and exact when a version differs
ok 714 - the drift warning is null at the deployed engine, and exact when a version differs
  ---
  duration_ms: 0.429833
  type: 'test'
  ...
# Subtest: the panel renders the constant, not a hard-coded version string
ok 715 - the panel renders the constant, not a hard-coded version string
  ---
  duration_ms: 0.514459
  type: 'test'
  ...
# Subtest: RATIFIED_RELATION_STATUS: D-5 stays a pinned failure; D-7 was FIXED and re-ratified
ok 716 - RATIFIED_RELATION_STATUS: D-5 stays a pinned failure; D-7 was FIXED and re-ratified
  ---
  duration_ms: 0.076292
  type: 'test'
  ...
# Subtest: §4.7: opts.engineVersion threads through on the PRODUCTION path, verbatim per the kickoff
ok 717 - §4.7: opts.engineVersion threads through on the PRODUCTION path, verbatim per the kickoff
  ---
  duration_ms: 0.639625
  type: 'test'
  ...
# Subtest: §4.8: absent opts.engineVersion, the production path still yields OPD_ENGINE_VERSION
ok 718 - §4.8: absent opts.engineVersion, the production path still yields OPD_ENGINE_VERSION
  ---
  duration_ms: 0.134625
  type: 'test'
  ...
# Subtest: the MINI path is untouched by the override — and always writes -<tag> (D1, 2 Aug 2026)
ok 719 - the MINI path is untouched by the override — and always writes -<tag> (D1, 2 Aug 2026)
  ---
  duration_ms: 3.080833
  type: 'test'
  ...
# Subtest: AuditOpdOpts declares engineVersion as an optional string
ok 720 - AuditOpdOpts declares engineVersion as an optional string
  ---
  duration_ms: 0.191292
  type: 'test'
  ...
# Subtest: §4.10 THE INVARIANT: updateOpdAudit keys engine_version in WHERE and never SETs it
ok 721 - §4.10 THE INVARIANT: updateOpdAudit keys engine_version in WHERE and never SETs it
  ---
  duration_ms: 0.230292
  type: 'test'
  ...
# Subtest: the re-score path is an UPDATE, never an INSERT — no second row, no double counting
ok 722 - the re-score path is an UPDATE, never an INSERT — no second row, no double counting
  ---
  duration_ms: 0.142584
  type: 'test'
  ...
# Subtest: the doctor read really has no per-uid dedup — which is WHY the invariant matters
ok 723 - the doctor read really has no per-uid dedup — which is WHY the invariant matters
  ---
  duration_ms: 0.36825
  type: 'test'
  ...
# Subtest: §4.9: ?engine= defaults to OPD_ENGINE_VERSION when absent
ok 724 - §4.9: ?engine= defaults to OPD_ENGINE_VERSION when absent
  ---
  duration_ms: 0.171292
  type: 'test'
  ...
# Subtest: the SELECT targets the SOURCE version as a BOUND parameter — unknown ⇒ zero rows, never a throw
ok 725 - the SELECT targets the SOURCE version as a BOUND parameter — unknown ⇒ zero rows, never a throw
  ---
  duration_ms: 0.347417
  type: 'test'
  ...
# Subtest: the same version threads into the audit call, so the UPDATE finds its row
ok 726 - the same version threads into the audit call, so the UPDATE finds its row
  ---
  duration_ms: 0.299375
  type: 'test'
  ...
# Subtest: ?apply=1 remains the ONLY write switch — read-only without it
ok 727 - ?apply=1 remains the ONLY write switch — read-only without it
  ---
  duration_ms: 0.062167
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: toKxEnvelope drops ALL PHI — no sentinel value survives anywhere in the output
ok 728 - toKxEnvelope drops ALL PHI — no sentinel value survives anywhere in the output
  ---
  duration_ms: 0.461333
  type: 'test'
  ...
# Subtest: toKxEnvelope is a WHITELIST — output keys are exactly the non-PHI set
ok 729 - toKxEnvelope is a WHITELIST — output keys are exactly the non-PHI set
  ---
  duration_ms: 0.359458
  type: 'test'
  ...
# Subtest: toKxEnvelope keys on any available link-back id, and returns null when there is none
ok 730 - toKxEnvelope keys on any available link-back id, and returns null when there is none
  ---
  duration_ms: 0.103042
  type: 'test'
  ...
# Subtest: the mapper never spreads the header (a structural guard against future PHI fields)
ok 731 - the mapper never spreads the header (a structural guard against future PHI fields)
  ---
  duration_ms: 0.219
  type: 'test'
  ...
# Subtest: persist is BEST-EFFORT: never throws, and runs AFTER the audit is saved
ok 732 - persist is BEST-EFFORT: never throws, and runs AFTER the audit is saved
  ---
  duration_ms: 0.253084
  type: 'test'
  ...
# Subtest: the store is idempotent + de-identified (UPSERT on document_id+version, no PHI columns)
ok 733 - the store is idempotent + de-identified (UPSERT on document_id+version, no PHI columns)
  ---
  duration_ms: 0.360542
  type: 'test'
  ...
# Subtest: EpisodeState stays STANDALONE — the namespace never imports ipd-audit
ok 734 - EpisodeState stays STANDALONE — the namespace never imports ipd-audit
  ---
  duration_ms: 1.400584
  type: 'test'
  ...
# Subtest: (timeline reuse) admission events become TimelineItem[] ordered by mergeTimeline (discharge first)
ok 735 - (timeline reuse) admission events become TimelineItem[] ordered by mergeTimeline (discharge first)
  ---
  duration_ms: 8.397917
  type: 'test'
  ...
# Subtest: (timeline reuse) no admission dates ⇒ no timeline rows (undated facts are not forced onto it)
ok 736 - (timeline reuse) no admission dates ⇒ no timeline rows (undated facts are not forced onto it)
  ---
  duration_ms: 0.312833
  type: 'test'
  ...
# Subtest: (facts-only) the render introduces no band/CVI/scored/predicted field or palette
ok 737 - (facts-only) the render introduces no band/CVI/scored/predicted field or palette
  ---
  duration_ms: 0.236416
  type: 'test'
  ...
# Subtest: (read-only) the store read is a SELECT; the page renders it best-effort
ok 738 - (read-only) the store read is a SELECT; the page renders it best-effort
  ---
  duration_ms: 0.198125
  type: 'test'
  ...
# Subtest: projectOpdLinkage is a WHITELIST — no PHI value survives; only ICD/drug/date reach the facts
ok 739 - projectOpdLinkage is a WHITELIST — no PHI value survives; only ICD/drug/date reach the facts
  ---
  duration_ms: 1.096417
  type: 'test'
  ...
# Subtest: the projector never reads a PHI field name (structural guard against a future column)
ok 740 - the projector never reads a PHI field name (structural guard against a future column)
  ---
  duration_ms: 0.69225
  type: 'test'
  ...
# Subtest: the builder fills pre/post from the OPD linkage — reported facts, no fabrication
ok 741 - the builder fills pre/post from the OPD linkage — reported facts, no fabrication
  ---
  duration_ms: 7.963125
  type: 'test'
  ...
# Subtest: the unlinked tail is graceful — null/empty OPD linkage ⇒ empty pre/post, never an error
ok 742 - the unlinked tail is graceful — null/empty OPD linkage ⇒ empty pre/post, never an error
  ---
  duration_ms: 0.893167
  type: 'test'
  ...
# Subtest: the committed recon gold is frozen, ratified, and hash-pinned
ok 743 - the committed recon gold is frozen, ratified, and hash-pinned
  ---
  duration_ms: 0.72
  type: 'test'
  ...
# Subtest: the gold carries V's genuine verdicts: all 70 faithful, NO negative examples (CC test posts excluded)
ok 744 - the gold carries V's genuine verdicts: all 70 faithful, NO negative examples (CC test posts excluded)
  ---
  duration_ms: 0.521959
  type: 'test'
  ...
# Subtest: the gold spans strata (speciality + linked/intra-only)
ok 745 - the gold spans strata (speciality + linked/intra-only)
  ---
  duration_ms: 0.116
  type: 'test'
  ...
# Subtest: the recon gold is de-identified: no UHID / phone / honorific-name / URL anywhere
ok 746 - the recon gold is de-identified: no UHID / phone / honorific-name / URL anywhere
  ---
  duration_ms: 0.340875
  type: 'test'
  ...
# Subtest: loadEpisodeReconGold rejects drift: edited verdict, wrong version/status/validator, dup id, bad verdict/phase
ok 747 - loadEpisodeReconGold rejects drift: edited verdict, wrong version/status/validator, dup id, bad verdict/phase
  ---
  duration_ms: 0.431917
  type: 'test'
  ...
# Subtest: (1) SEPARATION: ratings go to episode_recon_ratings, never the other adjudication stores
ok 748 - (1) SEPARATION: ratings go to episode_recon_ratings, never the other adjudication stores
  ---
  duration_ms: 0.580333
  type: 'test'
  ...
# Subtest: (2) VOCABULARY: exactly the four fidelity verdicts and three phases
ok 749 - (2) VOCABULARY: exactly the four fidelity verdicts and three phases
  ---
  duration_ms: 0.503875
  type: 'test'
  ...
# Subtest: (3) READ-ONLY: the queue reads the persisted episode, never re-builds/re-extracts
ok 750 - (3) READ-ONLY: the queue reads the persisted episode, never re-builds/re-extracts
  ---
  duration_ms: 0.181792
  type: 'test'
  ...
# Subtest: (4) DE-IDENTIFIED: the store has no PHI/URL column; the PDF is read-time only
ok 751 - (4) DE-IDENTIFIED: the store has no PHI/URL column; the PDF is read-time only
  ---
  duration_ms: 0.392834
  type: 'test'
  ...
# Subtest: (1) SCHEMA: the built object validates as the current version; pre/post empty without OPD
ok 752 - (1) SCHEMA: the built object validates as the current version; pre/post empty without OPD
  ---
  duration_ms: 4.043125
  type: 'test'
  ...
# Subtest: (2) NO FABRICATION: every emitted fact traces to a verbatim substring of its source
ok 753 - (2) NO FABRICATION: every emitted fact traces to a verbatim substring of its source
  ---
  duration_ms: 0.271958
  type: 'test'
  ...
# Subtest: (2b) NO FABRICATION: a fact whose rawText is NOT in its source is DROPPED, never invented
ok 754 - (2b) NO FABRICATION: a fact whose rawText is NOT in its source is DROPPED, never invented
  ---
  duration_ms: 0.210167
  type: 'test'
  ...
# Subtest: (3) DETERMINISM: identical inputs give byte-identical output
ok 755 - (3) DETERMINISM: identical inputs give byte-identical output
  ---
  duration_ms: 0.118333
  type: 'test'
  ...
# Subtest: (4) FACTS-ONLY + DE-IDENTIFIED: no score/prediction field, no PHI, no URL anywhere
ok 756 - (4) FACTS-ONLY + DE-IDENTIFIED: no score/prediction field, no PHI, no URL anywhere
  ---
  duration_ms: 0.154833
  type: 'test'
  ...
# Subtest: the schema source itself carries no score/prediction vocabulary (facts-only by construction)
ok 757 - the schema source itself carries no score/prediction vocabulary (facts-only by construction)
  ---
  duration_ms: 0.374292
  type: 'test'
  ...
# Subtest: counts helper reflects the populated intra + empty pre/post
ok 758 - counts helper reflects the populated intra + empty pre/post
  ---
  duration_ms: 0.106459
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: error_type reads the response body error taxonomy — type beats code beats metadata
ok 759 - error_type reads the response body error taxonomy — type beats code beats metadata
  ---
  duration_ms: 0.632625
  type: 'test'
  ...
# Subtest: error_type is null when absent, and envelope capture is still TOTAL on junk
ok 760 - error_type is null when absent, and envelope capture is still TOTAL on junk
  ---
  duration_ms: 0.182625
  type: 'test'
  ...
# Subtest: withEnvelope attaches both envelope and error_type; null-safe
ok 761 - withEnvelope attaches both envelope and error_type; null-safe
  ---
  duration_ms: 0.080166
  type: 'test'
  ...
# Subtest: 3× EMPTY CONTENT: the final throw carries the last real envelope, not a truncated string
ok 762 - 3× EMPTY CONTENT: the final throw carries the last real envelope, not a truncated string
  ---
  duration_ms: 12.236458
  type: 'test'
  ...
# Subtest: non-retryable HTTP: the envelope is read FROM THE ERROR BODY, taxonomy included
ok 763 - non-retryable HTTP: the envelope is read FROM THE ERROR BODY, taxonomy included
  ---
  duration_ms: 0.908292
  type: 'test'
  ...
# Subtest: 3× transport failure: envelope attached (empty is honest — nothing came off the wire)
ok 764 - 3× transport failure: envelope attached (empty is honest — nothing came off the wire)
  ---
  duration_ms: 1.8325
  type: 'test'
  ...
# Subtest: deadline throws carry the envelope too — the tombstone must never lose the R2 evidence
ok 765 - deadline throws carry the envelope too — the tombstone must never lose the R2 evidence
  ---
  duration_ms: 6.174375
  type: 'test'
  ...
# Subtest: the success path is untouched — no envelope property on a returned string
ok 766 - the success path is untouched — no envelope property on a returned string
  ---
  duration_ms: 0.606292
  type: 'test'
  ...
# Subtest: the guard messages are EXACTLY the §4 normative strings
ok 767 - the guard messages are EXACTLY the §4 normative strings
  ---
  duration_ms: 0.2345
  type: 'test'
  ...
# Subtest: the guards sit at the CALL SITE, gated on opts.evalModel, in the §4 order
ok 768 - the guards sit at the CALL SITE, gated on opts.evalModel, in the §4 order
  ---
  duration_ms: 0.401208
  type: 'test'
  ...
# Subtest: PRODUCTION IS BYTE-IDENTICAL: evalModel absent keeps the lenient parse exactly
ok 769 - PRODUCTION IS BYTE-IDENTICAL: evalModel absent keeps the lenient parse exactly
  ---
  duration_ms: 0.190209
  type: 'test'
  ...
# Subtest: parseAttemptsState: absent, malformed, or another experiment ⇒ EMPTY, never an error
ok 770 - parseAttemptsState: absent, malformed, or another experiment ⇒ EMPTY, never an error
  ---
  duration_ms: 0.541083
  type: 'test'
  ...
# Subtest: parseAttemptsState round-trips a real map and sanitises junk counters
ok 771 - parseAttemptsState round-trips a real map and sanitises junk counters
  ---
  duration_ms: 0.139958
  type: 'test'
  ...
# Subtest: THE D4 RULE: a deadline abandonment increments deadline_abandons and NEVER failures
ok 772 - THE D4 RULE: a deadline abandonment increments deadline_abandons and NEVER failures
  ---
  duration_ms: 0.134958
  type: 'test'
  ...
# Subtest: terminal failures budget to the tombstone at exactly 3, evidence carried
ok 773 - terminal failures budget to the tombstone at exactly 3, evidence carried
  ---
  duration_ms: 0.07375
  type: 'test'
  ...
# Subtest: mixed history: abandons interleaved with failures — only the failures count
ok 774 - mixed history: abandons interleaved with failures — only the failures count
  ---
  duration_ms: 0.10825
  type: 'test'
  ...
# Subtest: the budget is PAID-BRANCH ONLY and its read degrades to empty, never throws
ok 775 - the budget is PAID-BRANCH ONLY and its read degrades to empty, never throws
  ---
  duration_ms: 0.074333
  type: 'test'
  ...
# Subtest: doneUids has NO kind filter — a tombstone row makes the uid done, so the batch can finish
ok 776 - doneUids has NO kind filter — a tombstone row makes the uid done, so the batch can finish
  ---
  duration_ms: 0.037208
  type: 'test'
  ...
# Subtest: the tombstone is written INSTEAD of attempting, with the D5 payload, kind eval_failed
ok 777 - the tombstone is written INSTEAD of attempting, with the D5 payload, kind eval_failed
  ---
  duration_ms: 0.059667
  type: 'test'
  ...
# Subtest: the summary gains tombstoned + failed_uids, inside the eval-only spread
ok 778 - the summary gains tombstoned + failed_uids, inside the eval-only spread
  ---
  duration_ms: 0.043333
  type: 'test'
  ...
# Subtest: lab-batch-core is untouched: constants, drainPlan, locks all stand
ok 779 - lab-batch-core is untouched: constants, drainPlan, locks all stand
  ---
  duration_ms: 0.054
  type: 'test'
  ...
# Subtest: the attempts key is the documented name and OPENROUTER_TIMEOUT_MS did not move
ok 780 - the attempts key is the documented name and OPENROUTER_TIMEOUT_MS did not move
  ---
  duration_ms: 0.119292
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: remainingBudgetMs is pure, floors at 0, and never returns a negative
ok 781 - remainingBudgetMs is pure, floors at 0, and never returns a negative
  ---
  duration_ms: 0.567375
  type: 'test'
  ...
# Subtest: EVAL_TICK_DEADLINE_MS defaults to 240s and is env-overridable
ok 782 - EVAL_TICK_DEADLINE_MS defaults to 240s and is env-overridable
  ---
  duration_ms: 0.103375
  type: 'test'
  ...
# Subtest: the two tuned numbers are consistent: a note can spend its whole retry budget inside a tick
ok 783 - the two tuned numbers are consistent: a note can spend its whole retry budget inside a tick
  ---
  duration_ms: 0.070667
  type: 'test'
  ...
# Subtest: THE FIX: an already-blown deadline throws BEFORE attempt 1 — no fetch, no sleep
ok 784 - THE FIX: an already-blown deadline throws BEFORE attempt 1 — no fetch, no sleep
  ---
  duration_ms: 0.711041
  type: 'test'
  ...
# Subtest: the deadline is checked before EVERY attempt, not just the first
ok 785 - the deadline is checked before EVERY attempt, not just the first
  ---
  duration_ms: 74.502292
  type: 'test'
  ...
# Subtest: a note that FINISHES inside its budget is completely unaffected
ok 786 - a note that FINISHES inside its budget is completely unaffected
  ---
  duration_ms: 0.34425
  type: 'test'
  ...
# Subtest: a backoff that would cross the deadline throws NOW rather than sleeping through it
ok 787 - a backoff that would cross the deadline throws NOW rather than sleeping through it
  ---
  duration_ms: 4.909667
  type: 'test'
  ...
# Subtest: the deadline error carries the LAST envelope — it is the only surviving record
ok 788 - the deadline error carries the LAST envelope — it is the only surviving record
  ---
  duration_ms: 0.380292
  type: 'test'
  ...
# Subtest: with no envelope yet, every field reads null rather than the message failing to build
ok 789 - with no envelope yet, every field reads null rather than the message failing to build
  ---
  duration_ms: 0.178917
  type: 'test'
  ...
# Subtest: the deadline message is EXACTLY the three normative lines
ok 790 - the deadline message is EXACTLY the three normative lines
  ---
  duration_ms: 0.30725
  type: 'test'
  ...
# Subtest: the prefix the tick counts on is defined once, beside the builder
ok 791 - the prefix the tick counts on is defined once, beside the builder
  ---
  duration_ms: 0.070792
  type: 'test'
  ...
# Subtest: a deadline hit is NOT confused with the empty-content failure — they are different faults
ok 792 - a deadline hit is NOT confused with the empty-content failure — they are different faults
  ---
  duration_ms: 0.65025
  type: 'test'
  ...
# Subtest: the AbortController timeout is clamped to the remaining budget when a deadline is present
ok 793 - the AbortController timeout is clamped to the remaining budget when a deadline is present
  ---
  duration_ms: 0.158459
  type: 'test'
  ...
# Subtest: the clamped timeout is REPORTED in the timeout message, so the log is truthful
ok 794 - the clamped timeout is REPORTED in the timeout message, so the log is truthful
  ---
  duration_ms: 52.520833
  type: 'test'
  ...
# Subtest: THE SAFETY PROPERTY: with deadlineAt absent, nothing about the retry loop changes
ok 795 - THE SAFETY PROPERTY: with deadlineAt absent, nothing about the retry loop changes
  ---
  duration_ms: 1.514792
  type: 'test'
  ...
# Subtest: deadlineAt is APPENDED — every existing positional call site still binds correctly
ok 796 - deadlineAt is APPENDED — every existing positional call site still binds correctly
  ---
  duration_ms: 0.644334
  type: 'test'
  ...
# Subtest: auditOpdNote threads opts.deadlineAt and nothing else changed on the call
ok 797 - auditOpdNote threads opts.deadlineAt and nothing else changed on the call
  ---
  duration_ms: 0.198333
  type: 'test'
  ...
# Subtest: batchTick computes the deadline ONCE, from tickStart, and only in eval mode
ok 798 - batchTick computes the deadline ONCE, from tickStart, and only in eval mode
  ---
  duration_ms: 0.180375
  type: 'test'
  ...
# Subtest: THE MINI BRANCH IS BYTE-IDENTICAL — it never receives a deadline
ok 799 - THE MINI BRANCH IS BYTE-IDENTICAL — it never receives a deadline
  ---
  duration_ms: 0.072667
  type: 'test'
  ...
# Subtest: D3: the bounded pool is AWAITED, never raced — racing recreates the bed1449 duplicate rows
ok 800 - D3: the bounded pool is AWAITED, never raced — racing recreates the bed1449 duplicate rows
  ---
  duration_ms: 0.064709
  type: 'test'
  ...
# Subtest: deadline_hits counts deadline errors and nothing else
ok 801 - deadline_hits counts deadline errors and nothing else
  ---
  duration_ms: 0.065083
  type: 'test'
  ...
# Subtest: drainPlan, labLockHeld, ttlBreach and LB_LOCK_TTL_MS are untouched
ok 802 - drainPlan, labLockHeld, ttlBreach and LB_LOCK_TTL_MS are untouched
  ---
  duration_ms: 0.083458
  type: 'test'
  ...
# Subtest: the eval deadline never reaches a production audit path
ok 803 - the eval deadline never reaches a production audit path
  ---
  duration_ms: 0.605334
  type: 'test'
  ...
# Subtest: normalizeConceptSubject is byte-identical to the house normalizeSubject
ok 804 - normalizeConceptSubject is byte-identical to the house normalizeSubject
  ---
  duration_ms: 0.682375
  type: 'test'
  ...
# Subtest: normalizeSlot strips inner colons so a slot can never inject an extra id segment
ok 805 - normalizeSlot strips inner colons so a slot can never inject an extra id segment
  ---
  duration_ms: 0.109834
  type: 'test'
  ...
# Subtest: composeConceptId builds direction:action:target and refuses a bad direction or blank action
ok 806 - composeConceptId builds direction:action:target and refuses a bad direction or blank action
  ---
  duration_ms: 0.091042
  type: 'test'
  ...
# Subtest: §3.1 sentinel: an empty target composes to :regimen with a valid direction + action
ok 807 - §3.1 sentinel: an empty target composes to :regimen with a valid direction + action
  ---
  duration_ms: 0.081167
  type: 'test'
  ...
# Subtest: §3.1 the named case: overuse:polypharmacy: ⇒ overuse:polypharmacy:regimen
ok 808 - §3.1 the named case: overuse:polypharmacy: ⇒ overuse:polypharmacy:regimen
  ---
  duration_ms: 0.046584
  type: 'test'
  ...
# Subtest: §3.1 the sentinel is NOT a catch-all: exclude_test_note is still rejected, never routed to it
ok 809 - §3.1 the sentinel is NOT a catch-all: exclude_test_note is still rejected, never routed to it
  ---
  duration_ms: 0.160209
  type: 'test'
  ...
# Subtest: §3.1 the sentinel is NOT a catch-all: an out-of-vocabulary direction is still rejected
ok 810 - §3.1 the sentinel is NOT a catch-all: an out-of-vocabulary direction is still rejected
  ---
  duration_ms: 0.10925
  type: 'test'
  ...
# Subtest: §3.1 the sentinel recovers ONLY an empty target — a blank ACTION is still a reject
ok 811 - §3.1 the sentinel recovers ONLY an empty target — a blank ACTION is still a reject
  ---
  duration_ms: 0.047875
  type: 'test'
  ...
# Subtest: §3.1 an extraction with an empty target validates to the sentinel, slots and id agreeing
ok 812 - §3.1 an extraction with an empty target validates to the sentinel, slots and id agreeing
  ---
  duration_ms: 0.213375
  type: 'test'
  ...
# Subtest: §3.1 review_lane computes normally for a sentinel concept
ok 813 - §3.1 review_lane computes normally for a sentinel concept
  ---
  duration_ms: 0.276083
  type: 'test'
  ...
# Subtest: baseConceptId folds a context-qualified id onto its base
ok 814 - baseConceptId folds a context-qualified id onto its base
  ---
  duration_ms: 0.047541
  type: 'test'
  ...
# Subtest: the direction vocabulary is closed to exactly the four structural values
ok 815 - the direction vocabulary is closed to exactly the four structural values
  ---
  duration_ms: 0.325291
  type: 'test'
  ...
# Subtest: §7 formulary guard: a "cbc" brand-TOKEN match does not resolve to pralidoxime
ok 816 - §7 formulary guard: a "cbc" brand-TOKEN match does not resolve to pralidoxime
  ---
  duration_ms: 0.151542
  type: 'test'
  ...
# Subtest: §7 stage order: the collapse rule runs AFTER formulary resolution
ok 817 - §7 stage order: the collapse rule runs AFTER formulary resolution
  ---
  duration_ms: 0.050958
  type: 'test'
  ...
# Subtest: a resolver that throws never loses the literal target
ok 818 - a resolver that throws never loses the literal target
  ---
  duration_ms: 0.045916
  type: 'test'
  ...
# Subtest: §9 known-answer: every montelukast-bearing string resolves to overuse:rx:montelukast_containing
ok 819 - §9 known-answer: every montelukast-bearing string resolves to overuse:rx:montelukast_containing
  ---
  duration_ms: 0.120708
  type: 'test'
  ...
# Subtest: §9 review_lane: clean for montelukast (0 contexts), context for antibiotic (163 contexts)
ok 820 - §9 review_lane: clean for montelukast (0 contexts), context for antibiotic (163 contexts)
  ---
  duration_ms: 0.037292
  type: 'test'
  ...
# Subtest: review_lane is a deterministic threshold on the context-free VOLUME share
ok 821 - review_lane is a deterministic threshold on the context-free VOLUME share
  ---
  duration_ms: 0.03725
  type: 'test'
  ...
# Subtest: §9: a valid extraction composes; context is optional and normalised
ok 822 - §9: a valid extraction composes; context is optional and normalised
  ---
  duration_ms: 0.052125
  type: 'test'
  ...
# Subtest: §9: unparseable extraction ⇒ reject, no stamp
ok 823 - §9: unparseable extraction ⇒ reject, no stamp
  ---
  duration_ms: 0.073833
  type: 'test'
  ...
# Subtest: §9: a direction outside the closed vocabulary is rejected, never coerced
ok 824 - §9: a direction outside the closed vocabulary is rejected, never coerced
  ---
  duration_ms: 0.035041
  type: 'test'
  ...
# Subtest: a missing ACTION is a reject, not a partial stamp; a missing TARGET takes the §3.1 sentinel
ok 825 - a missing ACTION is a reject, not a partial stamp; a missing TARGET takes the §3.1 sentinel
  ---
  duration_ms: 0.039916
  type: 'test'
  ...
# Subtest: a ```json fence is tolerated; nothing else is repaired
ok 826 - a ```json fence is tolerated; nothing else is repaired
  ---
  duration_ms: 0.040791
  type: 'test'
  ...
# Subtest: §9 exact-lookup hit stamps the seeded concept with ZERO model calls
ok 827 - §9 exact-lookup hit stamps the seeded concept with ZERO model calls
  ---
  duration_ms: 0.09825
  type: 'test'
  ...
# Subtest: a lookup miss leaves the finding byte-identical (PRD §7 fail-safe)
ok 828 - a lookup miss leaves the finding byte-identical (PRD §7 fail-safe)
  ---
  duration_ms: 0.0395
  type: 'test'
  ...
# Subtest: an already-coded finding is never re-stamped (a string is extracted once, ever)
ok 829 - an already-coded finding is never re-stamped (a string is extracted once, ever)
  ---
  duration_ms: 0.034708
  type: 'test'
  ...
# Subtest: only low-value, non-informational findings are codable
ok 830 - only low-value, non-informational findings are codable
  ---
  duration_ms: 0.1025
  type: 'test'
  ...
# Subtest: a throwing lookup never throws out of stampConcepts
ok 831 - a throwing lookup never throws out of stampConcepts
  ---
  duration_ms: 0.045208
  type: 'test'
  ...
# Subtest: pendingSubjects dedupes, skips coded/uncodable, and honours the known-set
ok 832 - pendingSubjects dedupes, skips coded/uncodable, and honours the known-set
  ---
  duration_ms: 0.083875
  type: 'test'
  ...
# Subtest: §9 cache miss → extract once → cached; a repeated string makes NO second call
ok 833 - §9 cache miss → extract once → cached; a repeated string makes NO second call
  ---
  duration_ms: 0.216167
  type: 'test'
  ...
# Subtest: CONCEPT_CRON_MIN matches the schedule in vercel.json (the panel renders this number)
ok 834 - CONCEPT_CRON_MIN matches the schedule in vercel.json (the panel renders this number)
  ---
  duration_ms: 0.362875
  type: 'test'
  ...
# Subtest: deriveConceptState: disabled outranks paused outranks pending work
ok 835 - deriveConceptState: disabled outranks paused outranks pending work
  ---
  duration_ms: 0.050875
  type: 'test'
  ...
# Subtest: codedPct is a clamped percentage, null when the denominator is unknown or zero
ok 836 - codedPct is a clamped percentage, null when the denominator is unknown or zero
  ---
  duration_ms: 0.047
  type: 'test'
  ...
# Subtest: cacheHitPct is the share of stamps needing no model call; null before anything is stamped
ok 837 - cacheHitPct is the share of stamps needing no model call; null before anything is stamped
  ---
  duration_ms: 0.078541
  type: 'test'
  ...
# Subtest: rejectedRecent sums across ticks and is 0 (never null) so the tile always renders a number
ok 838 - rejectedRecent sums across ticks and is 0 (never null) so the tile always renders a number
  ---
  duration_ms: 0.047791
  type: 'test'
  ...
# Subtest: buildConceptStatus shapes the payload and carries all four per-tick counts through
ok 839 - buildConceptStatus shapes the payload and carries all four per-tick counts through
  ---
  duration_ms: 0.090791
  type: 'test'
  ...
# Subtest: ZERO-STATE renders honestly: seed loaded, no ticks, nothing stamped
ok 840 - ZERO-STATE renders honestly: seed loaded, no ticks, nothing stamped
  ---
  duration_ms: 0.056
  type: 'test'
  ...
# Subtest: a fully-degraded payload (every aggregate null) still shapes without throwing
ok 841 - a fully-degraded payload (every aggregate null) still shapes without throwing
  ---
  duration_ms: 0.562083
  type: 'test'
  ...
# Subtest: the disabled state is reachable and keeps its counts (the panel explains itself)
ok 842 - the disabled state is reachable and keeps its counts (the panel explains itself)
  ---
  duration_ms: 0.0635
  type: 'test'
  ...
# Subtest: §9 score-invariance: stamping 240 audits changes no headline, band, domain score or confidence
ok 843 - §9 score-invariance: stamping 240 audits changes no headline, band, domain score or confidence
  ---
  duration_ms: 5.358625
  type: 'test'
  ...
# Subtest: §3 score-invariance, structurally: stamping adds exactly two keys and mutates nothing else
ok 844 - §3 score-invariance, structurally: stamping adds exactly two keys and mutates nothing else
  ---
  duration_ms: 0.180125
  type: 'test'
  ...
# Subtest: findingKey is deterministic + stable across normalized subject variants; distinct on real change
ok 845 - findingKey is deterministic + stable across normalized subject variants; distinct on real change
  ---
  duration_ms: 0.7565
  type: 'test'
  ...
# Subtest: subjectHash is subject-sensitive (cache miss on a re-worded finding)
ok 846 - subjectHash is subject-sensitive (cache miss on a re-worded finding)
  ---
  duration_ms: 0.131208
  type: 'test'
  ...
# Subtest: isNoteStale: no watermark OR watermark < epoch ⇒ stale
ok 847 - isNoteStale: no watermark OR watermark < epoch ⇒ stale
  ---
  duration_ms: 0.515542
  type: 'test'
  ...
# Subtest: stripRetiredEvenCitations drops retired even-lvc citations, renumbers refs, keeps CW/guideline/other intact
ok 848 - stripRetiredEvenCitations drops retired even-lvc citations, renumbers refs, keeps CW/guideline/other intact
  ---
  duration_ms: 0.487875
  type: 'test'
  ...
# Subtest: stripRetiredEvenCitations is a byte-identical no-op when nothing is retired / no retired source present
ok 849 - stripRetiredEvenCitations is a byte-identical no-op when nothing is retired / no retired source present
  ---
  duration_ms: 0.064334
  type: 'test'
  ...
# Subtest: stripRetiredEvenCitations never touches non-even citations even if their id collides numerically
ok 850 - stripRetiredEvenCitations never touches non-even citations even if their id collides numerically
  ---
  duration_ms: 0.099375
  type: 'test'
  ...
# Subtest: deriveGroundState precedence: disabled > paused > draining > idle
ok 851 - deriveGroundState precedence: disabled > paused > draining > idle
  ---
  duration_ms: 0.063416
  type: 'test'
  ...
# Subtest: drainPct + drainEtaMinutes
ok 852 - drainPct + drainEtaMinutes
  ---
  duration_ms: 0.066458
  type: 'test'
  ...
# Subtest: buildGroundStatus shapes the payload + derives state/drain_pct
ok 853 - buildGroundStatus shapes the payload + derives state/drain_pct
  ---
  duration_ms: 0.184417
  type: 'test'
  ...
# Subtest: formatAgo: seconds / minutes / hours / days; UTC-assumed; malformed ⇒ —
ok 854 - formatAgo: seconds / minutes / hours / days; UTC-assumed; malformed ⇒ —
  ---
  duration_ms: 0.366292
  type: 'test'
  ...
# Subtest: nextTickInSec: (0, everyMin*60]; wraps at the boundary
ok 855 - nextTickInSec: (0, everyMin*60]; wraps at the boundary
  ---
  duration_ms: 0.1065
  type: 'test'
  ...
# Subtest: score-invariance: stripRetiredEvenCitations preserves every non-citation finding field
ok 856 - score-invariance: stripRetiredEvenCitations preserves every non-citation finding field
  ---
  duration_ms: 0.077334
  type: 'test'
  ...
# Subtest: buildDigest qualifies at the CATEGORY grain (≥ CAT_MIN total), drops singletons, emits ONLY {subject,count} + total
ok 857 - buildDigest qualifies at the CATEGORY grain (≥ CAT_MIN total), drops singletons, emits ONLY {subject,count} + total
  ---
  duration_ms: 1.010959
  type: 'test'
  ...
# Subtest: buildDigest: a FRAGMENTED category qualifies on TOTAL even when no single subject hits the old ≥20 floor (§1.1 core fix)
ok 858 - buildDigest: a FRAGMENTED category qualifies on TOTAL even when no single subject hits the old ≥20 floor (§1.1 core fix)
  ---
  duration_ms: 10.223625
  type: 'test'
  ...
# Subtest: buildDigest: topK truncates to the highest-count exemplars
ok 859 - buildDigest: topK truncates to the highest-count exemplars
  ---
  duration_ms: 0.117167
  type: 'test'
  ...
# Subtest: normalizeSubject collapses casing/whitespace/trailing period
ok 860 - normalizeSubject collapses casing/whitespace/trailing period
  ---
  duration_ms: 0.115541
  type: 'test'
  ...
# Subtest: isDuplicateCandidate drops same-category text-eq / cosine≥0.90, incl. against rejected; keeps cross-category
ok 861 - isDuplicateCandidate drops same-category text-eq / cosine≥0.90, incl. against rejected; keeps cross-category
  ---
  duration_ms: 0.231792
  type: 'test'
  ...
# Subtest: dedupeCandidates removes intra-batch dupes and caps
ok 862 - dedupeCandidates removes intra-batch dupes and caps
  ---
  duration_ms: 0.270416
  type: 'test'
  ...
# Subtest: rollupContests counts per assertion and flips ONLY active→contested at ≥ flag; never auto-retires
ok 863 - rollupContests counts per assertion and flips ONLY active→contested at ≥ flag; never auto-retires
  ---
  duration_ms: 0.253666
  type: 'test'
  ...
# Subtest: computeOwnCases true only when ratifier name is among the supporting doctor_uids
ok 864 - computeOwnCases true only when ratifier name is among the supporting doctor_uids
  ---
  duration_ms: 0.113
  type: 'test'
  ...
# Subtest: id-ordinal: elv-<category>-<padded>, per-category, monotone; batch ids do not collide
ok 865 - id-ordinal: elv-<category>-<padded>, per-category, monotone; batch ids do not collide
  ---
  duration_ms: 0.54575
  type: 'test'
  ...
# Subtest: parseCandidatesJson: tolerant of fences/prose/object-wrap; drops malformed + hallucinated categories
ok 866 - parseCandidatesJson: tolerant of fences/prose/object-wrap; drops malformed + hallucinated categories
  ---
  duration_ms: 0.826583
  type: 'test'
  ...
# Subtest: evenGenUserMessage only references shown categories/subjects + surfaces the category total (§1.1)
ok 867 - evenGenUserMessage only references shown categories/subjects + surfaces the category total (§1.1)
  ---
  duration_ms: 0.173958
  type: 'test'
  ...
# Subtest: isRunStale: a fresh run is not stale; a >10-min run is; a malformed timestamp is safe-false (§1.2)
ok 868 - isRunStale: a fresh run is not stale; a >10-min run is; a malformed timestamp is safe-false (§1.2)
  ---
  duration_ms: 0.091167
  type: 'test'
  ...
# Subtest: evenChunkSection / normalizeAssertionText helpers
ok 869 - evenChunkSection / normalizeAssertionText helpers
  ---
  duration_ms: 0.056625
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: guard.1 — the connection guard refuses a non-loopback host, synchronously, naming the host
ok 870 - guard.1 — the connection guard refuses a non-loopback host, synchronously, naming the host
  ---
  duration_ms: 169.826875
  type: 'test'
  ...
# Subtest: 5.2 — recording is OFF by default: no observation is stored and the counter does not advance
ok 871 - 5.2 — recording is OFF by default: no observation is stored and the counter does not advance
  ---
  duration_ms: 2.083584
  type: 'test'
  ...
# Subtest: 5.3 — one observation holds seq, socketId, method, path, and the exact body bytes; nothing else
ok 872 - 5.3 — one observation holds seq, socketId, method, path, and the exact body bytes; nothing else
  ---
  duration_ms: 1.06725
  type: 'test'
  ...
# Subtest: 5.4 — sequence numbers are assigned at ACCEPTANCE, monotonic from 0, and never reused
ok 873 - 5.4 — sequence numbers are assigned at ACCEPTANCE, monotonic from 0, and never reused
  ---
  duration_ms: 7.136334
  type: 'test'
  ...
# Subtest: 5.5a — the boundary: 1048576 bytes is ACCEPTED and recorded in full
ok 874 - 5.5a — the boundary: 1048576 bytes is ACCEPTED and recorded in full
  ---
  duration_ms: 10.428125
  type: 'test'
  ...
# Subtest: 5.5b — the boundary: 1048577 bytes is REJECTED with 413, an empty JSON body, an overflowed observation, and the SAME undestroyed socket carries the next request
ok 875 - 5.5b — the boundary: 1048577 bytes is REJECTED with 413, an empty JSON body, an overflowed observation, and the SAME undestroyed socket carries the next request
  ---
  duration_ms: 13.3445
  type: 'test'
  ...
# Subtest: 5.6 — while a request is in flight, BOTH snapshot and resetObservations throw, naming the count
ok 876 - 5.6 — while a request is in flight, BOTH snapshot and resetObservations throw, naming the count
  ---
  duration_ms: 34.564125
  type: 'test'
  ...
# Subtest: 5.6b — the in-flight counter decrements on a 413 response too
ok 877 - 5.6b — the in-flight counter decrements on a 413 response too
  ---
  duration_ms: 3.574208
  type: 'test'
  ...
# Subtest: 5.7 — snapshot is DEFENSIVE: mutating the array, an object, or a Buffer leaves recorder state unchanged
ok 878 - 5.7 — snapshot is DEFENSIVE: mutating the array, an object, or a Buffer leaves recorder state unchanged
  ---
  duration_ms: 1.624458
  type: 'test'
  ...
# Subtest: 5.8 — two identical requests produce two observations; the recorder never deduplicates
ok 879 - 5.8 — two identical requests produce two observations; the recorder never deduplicates
  ---
  duration_ms: 2.723334
  type: 'test'
  ...
# Subtest: 5.9 — comparison groups by marker SET, not arrival order
ok 880 - 5.9 — comparison groups by marker SET, not arrival order
  ---
  duration_ms: 0.612833
  type: 'test'
  ...
# Subtest: 5.9b — the comparator keeps method, path and body as ONE tuple: a swap between marker groups is a difference
ok 881 - 5.9b — the comparator keeps method, path and body as ONE tuple: a swap between marker groups is a difference
  ---
  duration_ms: 0.541042
  type: 'test'
  ...
# Subtest: 5.10 — resetObservations clears observations and the counter and NOTHING in responder configuration
ok 882 - 5.10 — resetObservations clears observations and the counter and NOTHING in responder configuration
  ---
  duration_ms: 7.230959
  type: 'test'
  ...
# Subtest: 5.11 — the parsed `requests` API is unchanged: same fields, same push sites, same arrival order, and JudgeRequest gains no field
ok 883 - 5.11 — the parsed `requests` API is unchanged: same fields, same push sites, same arrival order, and JudgeRequest gains no field
  ---
  duration_ms: 3.17075
  type: 'test'
  ...
# Subtest: J1.1 — SUCCESS: explicit judge and env-default judge are byte-identical on the wire, in results, and in payload
ok 884 - J1.1 — SUCCESS: explicit judge and env-default judge are byte-identical on the wire, in results, and in payload
  ---
  duration_ms: 13.887291
  type: 'test'
  ...
# [rerank judge] batch failed 0 - 5 Unexpected token 'h', "this is not"... is not valid JSON
# [rerank judge] batch failed 5 - 6 Unexpected token 'h', "this is not"... is not valid JSON
# [rerank judge] batch failed 0 - 5 Unexpected token 'h', "this is not"... is not valid JSON
# [rerank judge] batch failed 5 - 6 Unexpected token 'h', "this is not"... is not valid JSON
# Subtest: J1.2 — REAL BATCH PARSE FAILURE: both arms receive the same malformed completion and record it identically
ok 885 - J1.2 — REAL BATCH PARSE FAILURE: both arms receive the same malformed completion and record it identically
  ---
  duration_ms: 8.410458
  type: 'test'
  ...
# [rerank] backend failed, returning input order generic outer judge failure, after the call
# [rerank] backend failed, returning input order generic outer judge failure, after the call
# Subtest: J1.3 — GENERIC OUTER JUDGE FAILURE, produced by CALL-THEN-THROW: nonempty and byte-identical wire observations on both arms
ok 886 - J1.3 — GENERIC OUTER JUDGE FAILURE, produced by CALL-THEN-THROW: nonempty and byte-identical wire observations on both arms
  ---
  duration_ms: 7.117917
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [rerank] env-default cohere unavailable → falling back to judge: rerank backend 'cohere' unreachable (cohere/rerank-v3.5): OPENROUTER_API_KEY not set
# Subtest: J3.0 — the fixture is live: retrieve with the reranker OFF returns the fused order and dials no judge
ok 887 - J3.0 — the fixture is live: retrieve with the reranker OFF returns the fused order and dials no judge
  ---
  duration_ms: 115.435417
  type: 'test'
  ...
# Subtest: J3.1 — OMITTED-BACKEND CONTROL: the resilient arm runs; under a Cohere env default it shows Cohere intent AND downgrade
ok 888 - J3.1 — OMITTED-BACKEND CONTROL: the resilient arm runs; under a Cohere env default it shows Cohere intent AND downgrade
  ---
  duration_ms: 43.341417
  type: 'test'
  ...
# Subtest: J3.2 — EXPLICIT-JUDGE ARM: zero Cohere outbound requests, judge intent, judge service, no downgrade, nonzero batches, actual reordering
ok 889 - J3.2 — EXPLICIT-JUDGE ARM: zero Cohere outbound requests, judge intent, judge service, no downgrade, nonzero batches, actual reordering
  ---
  duration_ms: 3.500208
  type: 'test'
  ...
# Subtest: J4.1 — every retrieval arm is called with useReranker OFF; exactly ONE fusion-level rerank; its third argument is the value passed as opts.rerankBackend
ok 890 - J4.1 — every retrieval arm is called with useReranker OFF; exactly ONE fusion-level rerank; its third argument is the value passed as opts.rerankBackend
  ---
  duration_ms: 4.308042
  type: 'test'
  ...
# Subtest: J4.2 — the fusion rerank happens ONCE even when the arms return overlapping pools; no arm-level rerank stamps a batch
ok 891 - J4.2 — the fusion rerank happens ONCE even when the arms return overlapping pools; no arm-level rerank stamps a batch
  ---
  duration_ms: 8.495417
  type: 'test'
  ...
# Subtest: §4.2 every read of opd_audit_feedback is study-filtered — three D12-allowlisted, commented
ok 892 - §4.2 every read of opd_audit_feedback is study-filtered — three D12-allowlisted, commented
  ---
  duration_ms: 151.990041
  type: 'test'
  ...
# Subtest: §4.2 the write paths: main INSERT names study; assertion_contest and doctor-response never set it
ok 893 - §4.2 the write paths: main INSERT names study; assertion_contest and doctor-response never set it
  ---
  duration_ms: 0.246958
  type: 'test'
  ...
# Subtest: 8.3 the predicate is parameterised IS NOT DISTINCT FROM — never = or a hardcoded IS NULL
ok 894 - 8.3 the predicate is parameterised IS NOT DISTINCT FROM — never = or a hardcoded IS NULL
  ---
  duration_ms: 0.501666
  type: 'test'
  ...
# Subtest: buildFindingAuthorCurrentSql: DISTINCT ON (audit_id, finding_ref, author), order leads with the same three
ok 895 - buildFindingAuthorCurrentSql: DISTINCT ON (audit_id, finding_ref, author), order leads with the same three
  ---
  duration_ms: 0.190083
  type: 'test'
  ...
# Subtest: §8.5 rollup finding builder: study absent ⇒ SAME SQL text, param NULL — NULL matches NULL
ok 896 - §8.5 rollup finding builder: study absent ⇒ SAME SQL text, param NULL — NULL matches NULL
  ---
  duration_ms: 0.412542
  type: 'test'
  ...
# Subtest: §8.5 parseFeedbackBody: study absent ⇒ behaviour identical, study null; D8 author rule enforced
ok 897 - §8.5 parseFeedbackBody: study absent ⇒ behaviour identical, study null; D8 author rule enforced
  ---
  duration_ms: 0.260833
  type: 'test'
  ...
# Subtest: jaccard basics + empty-set guard
ok 898 - jaccard basics + empty-set guard
  ---
  duration_ms: 0.489542
  type: 'test'
  ...
# Subtest: exact finding_ref match when both stamped — regardless of subject
ok 899 - exact finding_ref match when both stamped — regardless of subject
  ---
  duration_ms: 0.160375
  type: 'test'
  ...
# Subtest: fuzzy match needs signal_type equality AND Jaccard ≥ threshold
ok 900 - fuzzy match needs signal_type equality AND Jaccard ≥ threshold
  ---
  duration_ms: 0.184334
  type: 'test'
  ...
# Subtest: tie-break prefers the domain-equal student at equal Jaccard
ok 901 - tie-break prefers the domain-equal student at equal Jaccard
  ---
  duration_ms: 0.073958
  type: 'test'
  ...
# Subtest: disagreementsOf classifies tier-differs / teacher-only / student-only with reasons
ok 902 - disagreementsOf classifies tier-differs / teacher-only / student-only with reasons
  ---
  duration_ms: 0.394583
  type: 'test'
  ...
# Subtest: agreeing matched pairs are NOT disagreements
ok 903 - agreeing matched pairs are NOT disagreements
  ---
  duration_ms: 0.053
  type: 'test'
  ...
# Subtest: every measured target resolves to a class containing Antibiotic, with the [0] invariant
ok 904 - every measured target resolves to a class containing Antibiotic, with the [0] invariant
  ---
  duration_ms: 2.153042
  type: 'test'
  ...
# Subtest: the cefpodoxime line: ester + salt variants both resolve — one entry per resolving fragment
ok 905 - the cefpodoxime line: ester + salt variants both resolve — one entry per resolving fragment
  ---
  duration_ms: 0.435
  type: 'test'
  ...
# Subtest: the three-molecule kit resolves per fragment: Antifungal + Antibiotic (Secnidazole absent from the formulary)
ok 906 - the three-molecule kit resolves per fragment: Antifungal + Antibiotic (Secnidazole absent from the formulary)
  ---
  duration_ms: 0.152209
  type: 'test'
  ...
# Subtest: a bracketed strength group can never split the line
ok 907 - a bracketed strength group can never split the line
  ---
  duration_ms: 0.058
  type: 'test'
  ...
# Subtest: the four regression lines keep resolving exactly as today
ok 908 - the four regression lines keep resolving exactly as today
  ---
  duration_ms: 0.163958
  type: 'test'
  ...
# Subtest: a line resolving to no class anywhere carries neither field
ok 909 - a line resolving to no class anywhere carries neither field
  ---
  duration_ms: 0.064083
  type: 'test'
  ...
# Subtest: noAntibioticClassOnNote (its own logic UNCHANGED) now sees the cefpodoxime antibiotic
ok 910 - noAntibioticClassOnNote (its own logic UNCHANGED) now sees the cefpodoxime antibiotic
  ---
  duration_ms: 0.270708
  type: 'test'
  ...
# Subtest: this build's bump (0.81.20) stays in the read family, and the engine is current
ok 911 - this build's bump (0.81.20) stays in the read family, and the engine is current
  ---
  duration_ms: 0.059208
  type: 'test'
  ...
# Subtest: normalizeDosageForm: parses raw formulary form (strength/junk stripped) to the coarse vocabulary
ok 912 - normalizeDosageForm: parses raw formulary form (strength/junk stripped) to the coarse vocabulary
  ---
  duration_ms: 1.400791
  type: 'test'
  ...
# Subtest: normalizeDrugName strips dose, form and marketing tail; keeps product-distinguishing suffix
ok 913 - normalizeDrugName strips dose, form and marketing tail; keeps product-distinguishing suffix
  ---
  duration_ms: 0.096208
  type: 'test'
  ...
# Subtest: brand-exact resolves the molecule + class + schedule (confident)
ok 914 - brand-exact resolves the molecule + class + schedule (confident)
  ---
  duration_ms: 0.470917
  type: 'test'
  ...
# Subtest: brand-token resolves an unambiguous brand family with no exact row (Wysolone → Prednisolone)
ok 915 - brand-token resolves an unambiguous brand family with no exact row (Wysolone → Prednisolone)
  ---
  duration_ms: 0.153
  type: 'test'
  ...
# Subtest: embedded-generic recovers a molecule named verbatim — and NOT a combination canon
ok 916 - embedded-generic recovers a molecule named verbatim — and NOT a combination canon
  ---
  duration_ms: 0.070083
  type: 'test'
  ...
# Subtest: brand-prefix is an APPROX match (not confident) — combo suffix may drop a molecule
ok 917 - brand-prefix is an APPROX match (not confident) — combo suffix may drop a molecule
  ---
  duration_ms: 0.125458
  type: 'test'
  ...
# Subtest: an ambiguous brand family (different canons) does NOT brand-token; exact still wins
ok 918 - an ambiguous brand family (different canons) does NOT brand-token; exact still wins
  ---
  duration_ms: 0.04925
  type: 'test'
  ...
# Subtest: source-generic is trusted as-is (confident)
ok 919 - source-generic is trusted as-is (confident)
  ---
  duration_ms: 0.048416
  type: 'test'
  ...
# Subtest: high-alert + schedule X carried through
ok 920 - high-alert + schedule X carried through
  ---
  duration_ms: 0.268208
  type: 'test'
  ...
# Subtest: unmatched returns null and classifies nutraceutical/cosmetic vs off-formulary
ok 921 - unmatched returns null and classifies nutraceutical/cosmetic vs off-formulary
  ---
  duration_ms: 0.722458
  type: 'test'
  ...
# Subtest: BUG-0.8-15: a single molecule wins its class over a combination that contains it (any array order)
ok 922 - BUG-0.8-15: a single molecule wins its class over a combination that contains it (any array order)
  ---
  duration_ms: 0.148459
  type: 'test'
  ...
# Subtest: flag unset ⇒ undefined, ALWAYS — the bridge does not exist without GEMINI_VIA_OPENROUTER=1
ok 923 - flag unset ⇒ undefined, ALWAYS — the bridge does not exist without GEMINI_VIA_OPENROUTER=1
  ---
  duration_ms: 0.563667
  type: 'test'
  ...
# Subtest: flag=1 ⇒ the OpenRouter slug, google/-prefixed exactly once; no model ⇒ undefined
ok 924 - flag=1 ⇒ the OpenRouter slug, google/-prefixed exactly once; no model ⇒ undefined
  ---
  duration_ms: 0.130417
  type: 'test'
  ...
# Subtest: trap 1: a Gemini slug NEVER receives reasoning:{enabled:false} — the A-12 400 destroyed a diagnosis for 36h
ok 925 - trap 1: a Gemini slug NEVER receives reasoning:{enabled:false} — the A-12 400 destroyed a diagnosis for 36h
  ---
  duration_ms: 0.159084
  type: 'test'
  ...
# Subtest: trap 1 control: a NON-Gemini slug reproduces the pre-bridge behaviour byte-for-byte
ok 926 - trap 1 control: a NON-Gemini slug reproduces the pre-bridge behaviour byte-for-byte
  ---
  duration_ms: 0.367166
  type: 'test'
  ...
# Subtest: trap 2: a Gemini slug gets baseMax + 8192 — Pro spends output budget on reasoning FIRST
ok 927 - trap 2: a Gemini slug gets baseMax + 8192 — Pro spends output budget on reasoning FIRST
  ---
  duration_ms: 0.056791
  type: 'test'
  ...
# Subtest: trap 3: the Vertex thinking budget is TRANSLATED to reasoning.max_tokens, and `google` never travels
ok 928 - trap 3: the Vertex thinking budget is TRANSLATED to reasoning.max_tokens, and `google` never travels
  ---
  duration_ms: 0.051666
  type: 'test'
  ...
# Subtest: trap 3: NO DEFAULT IS INVENTED — no budget in, no reasoning out (byte-identical to before)
ok 929 - trap 3: NO DEFAULT IS INVENTED — no budget in, no reasoning out (byte-identical to before)
  ---
  duration_ms: 0.176333
  type: 'test'
  ...
# Subtest: trap 3: the reader is pure and total — any shape yields a budget or undefined
ok 930 - trap 3: the reader is pure and total — any shape yields a budget or undefined
  ---
  duration_ms: 0.049125
  type: 'test'
  ...
# Subtest: trap 3: an explicit OpenRouter reasoning block WINS — translation never overwrites it
ok 931 - trap 3: an explicit OpenRouter reasoning block WINS — translation never overwrites it
  ---
  duration_ms: 0.193333
  type: 'test'
  ...
# Subtest: trap 3: the VERTEX path is untouched — it still sends the google form and no reasoning block
ok 932 - trap 3: the VERTEX path is untouched — it still sends the google form and no reasoning block
  ---
  duration_ms: 0.32675
  type: 'test'
  ...
# Subtest: the pin: Google-operated providers only, no fallbacks — slugs read off the endpoints listing 30 Jul 2026
ok 933 - the pin: Google-operated providers only, no fallbacks — slugs read off the endpoints listing 30 Jul 2026
  ---
  duration_ms: 0.064959
  type: 'test'
  ...
# Subtest: both transports derive the slug centrally; a caller-supplied openrouter slug takes precedence
ok 934 - both transports derive the slug centrally; a caller-supplied openrouter slug takes precedence
  ---
  duration_ms: 0.065708
  type: 'test'
  ...
# Subtest: the Ollama last-leg fallback is untouched in both transports
ok 935 - the Ollama last-leg fallback is untouched in both transports
  ---
  duration_ms: 0.087125
  type: 'test'
  ...
# Subtest: T-5: the hardcoded 'gemini-2.5-pro' literal is GONE from the worker — it hid this incident for four days
ok 936 - T-5: the hardcoded 'gemini-2.5-pro' literal is GONE from the worker — it hid this incident for four days
  ---
  duration_ms: 0.049416
  type: 'test'
  ...
# Subtest: T-5: servedCallFor reads the POST-fallback model from the audit trace, null when unknown
ok 937 - T-5: servedCallFor reads the POST-fallback model from the audit trace, null when unknown
  ---
  duration_ms: 0.046542
  type: 'test'
  ...
# Subtest: changelog: the bridge entry exists, scoring:false, and names the step change as a provider restoration
ok 938 - changelog: the bridge entry exists, scoring:false, and names the step change as a provider restoration
  ---
  duration_ms: 0.133708
  type: 'test'
  ...
# Subtest: GATE: a cloud row at 0.81.17 beats a qwen row at 0.81.20 — the exact live shape
ok 939 - GATE: a cloud row at 0.81.17 beats a qwen row at 0.81.20 — the exact live shape
  ---
  duration_ms: 0.499583
  type: 'test'
  ...
# Subtest: GATE: two cloud rows at different versions ⇒ the HIGHER version still wins
ok 940 - GATE: two cloud rows at different versions ⇒ the HIGHER version still wins
  ---
  duration_ms: 0.137167
  type: 'test'
  ...
# Subtest: isLocalGrader catches BOTH signals: the qwen model and the -mini suffix
ok 941 - isLocalGrader catches BOTH signals: the qwen model and the -mini suffix
  ---
  duration_ms: 0.061208
  type: 'test'
  ...
# Subtest: the grader tier is a SEPARATE question from REFERENCE_MODELS — neither list is overloaded
ok 942 - the grader tier is a SEPARATE question from REFERENCE_MODELS — neither list is overloaded
  ---
  duration_ms: 0.18225
  type: 'test'
  ...
# Subtest: CANONICAL_RANK_SQL leads with the grader tier, then version, then reference, then audited_at
ok 943 - CANONICAL_RANK_SQL leads with the grader tier, then version, then reference, then audited_at
  ---
  duration_ms: 0.058917
  type: 'test'
  ...
# Subtest: D1: prodTag and the mini_backfill_prod settings keys are DELETED repo-wide
ok 944 - D1: prodTag and the mini_backfill_prod settings keys are DELETED repo-wide
  ---
  duration_ms: 0.486083
  type: 'test'
  ...
# Subtest: the trap comment no longer claims a guard is unnecessary
ok 945 - the trap comment no longer claims a guard is unnecessary
  ---
  duration_ms: 0.146042
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: stripEvenNonProse removes base64 blobs and image refs, keeps prose
ok 946 - stripEvenNonProse removes base64 blobs and image refs, keeps prose
  ---
  duration_ms: 0.691
  type: 'test'
  ...
# Subtest: parseEvenProtocols splits on H1/H2/H3 with group-prefixed section paths + slug anchors
ok 947 - parseEvenProtocols splits on H1/H2/H3 with group-prefixed section paths + slug anchors
  ---
  duration_ms: 0.302
  type: 'test'
  ...
# Subtest: chunkSections drops < 120-char chunks, stamps guideline type + section anchor
ok 948 - chunkSections drops < 120-char chunks, stamps guideline type + section anchor
  ---
  duration_ms: 0.243583
  type: 'test'
  ...
# Subtest: each built row re-chunks to exactly one piece (per-row insert stays 1:1)
ok 949 - each built row re-chunks to exactly one piece (per-row insert stays 1:1)
  ---
  duration_ms: 0.340542
  type: 'test'
  ...
# Subtest: parseIcmr yields page-anchored sections with detected chapter headings
ok 950 - parseIcmr yields page-anchored sections with detected chapter headings
  ---
  duration_ms: 0.264208
  type: 'test'
  ...
# Subtest: detectIcmrHeading: title/upper headings yes, sentences no
ok 951 - detectIcmrHeading: title/upper headings yes, sentences no
  ---
  duration_ms: 0.0585
  type: 'test'
  ...
# Subtest: slugify → stable kebab anchor fragment
ok 952 - slugify → stable kebab anchor fragment
  ---
  duration_ms: 0.0995
  type: 'test'
  ...
# Subtest: CORPUS_QUARANTINE_INSERT_SQL — item_number is still column $5; F13 provenance appended ONLY
ok 953 - CORPUS_QUARANTINE_INSERT_SQL — item_number is still column $5; F13 provenance appended ONLY
  ---
  duration_ms: 0.099417
  type: 'test'
  ...
# Subtest: the artifact is the full master: version, size, key shape
ok 954 - the artifact is the full master: version, size, key shape
  ---
  duration_ms: 72.992042
  type: 'test'
  ...
# Subtest: PRD spot-checks resolve to real master labels
ok 955 - PRD spot-checks resolve to real master labels
  ---
  duration_ms: 0.354417
  type: 'test'
  ...
# Subtest: override precedence: a code in both layers renders the curated phrasing
ok 956 - override precedence: a code in both layers renders the curated phrasing
  ---
  duration_ms: 0.145875
  type: 'test'
  ...
# Subtest: category fallback is EXACT-KEY only; junk still gets the neutral fallback
ok 957 - category fallback is EXACT-KEY only; junk still gets the neutral fallback
  ---
  duration_ms: 62.157834
  type: 'test'
  ...
# Subtest: Decision-D order unchanged: source display text still wins over every bundled layer
ok 958 - Decision-D order unchanged: source display text still wins over every bundled layer
  ---
  duration_ms: 0.136416
  type: 'test'
  ...
# Subtest: slice-2 payload: META carries duration + high-risk in the ratified shape (not consumed yet)
ok 959 - slice-2 payload: META carries duration + high-risk in the ratified shape (not consumed yet)
  ---
  duration_ms: 138.960542
  type: 'test'
  ...
# Subtest: a formulary-resolved combination missing ONLY strength → NO finding
ok 960 - a formulary-resolved combination missing ONLY strength → NO finding
  ---
  duration_ms: 0.878208
  type: 'test'
  ...
# Subtest: a formulary-resolved combination missing strength AND frequency → finding, gaps list frequency ONLY
ok 961 - a formulary-resolved combination missing strength AND frequency → finding, gaps list frequency ONLY
  ---
  duration_ms: 0.599458
  type: 'test'
  ...
# Subtest: a combination with nonFormulary set → finding, strength gap STILL present (DEC-2)
ok 962 - a combination with nonFormulary set → finding, strength gap STILL present (DEC-2)
  ---
  duration_ms: 0.416708
  type: 'test'
  ...
# Subtest: a single-molecule drug missing strength → finding, unchanged
ok 963 - a single-molecule drug missing strength → finding, unchanged
  ---
  duration_ms: 0.202792
  type: 'test'
  ...
# Subtest: the combination exemption needs BOTH conditions — a "+" alone is not enough
ok 964 - the combination exemption needs BOTH conditions — a "+" alone is not enough
  ---
  duration_ms: 0.064083
  type: 'test'
  ...
# Subtest: dosageForm 'topical' missing strength AND route → NO finding
ok 965 - dosageForm 'topical' missing strength AND route → NO finding
  ---
  duration_ms: 0.159042
  type: 'test'
  ...
# Subtest: dosageForm 'topical' missing duration → finding, duration ONLY
ok 966 - dosageForm 'topical' missing duration → finding, duration ONLY
  ---
  duration_ms: 0.061667
  type: 'test'
  ...
# Subtest: dosageForm 'drops' behaves exactly like topical
ok 967 - dosageForm 'drops' behaves exactly like topical
  ---
  duration_ms: 0.062542
  type: 'test'
  ...
# Subtest: dosageForm 'inhaler' and 'injection' are UNCHANGED — strength and route still gap
ok 968 - dosageForm 'inhaler' and 'injection' are UNCHANGED — strength and route still gap
  ---
  duration_ms: 1.080708
  type: 'test'
  ...
# Subtest: the other four DosageForm members are untouched: tablet, capsule, syrup, other
ok 969 - the other four DosageForm members are untouched: tablet, capsule, syrup, other
  ---
  duration_ms: 0.337541
  type: 'test'
  ...
# Subtest: a complete line emits nothing, before and after
ok 970 - a complete line emits nothing, before and after
  ---
  duration_ms: 0.064542
  type: 'test'
  ...
# Subtest: the existing isDoseExempt cases behave exactly as before — wholesale suppression intact
ok 971 - the existing isDoseExempt cases behave exactly as before — wholesale suppression intact
  ---
  duration_ms: 0.116333
  type: 'test'
  ...
# Subtest: the rationale wording is byte-identical — only the gap list inside it changes
ok 972 - the rationale wording is byte-identical — only the gap list inside it changes
  ---
  duration_ms: 0.041166
  type: 'test'
  ...
# Subtest: the emitted rationale still parses for severity-tier-core (the tier keys on this string)
ok 973 - the emitted rationale still parses for severity-tier-core (the tier keys on this string)
  ---
  duration_ms: 0.089958
  type: 'test'
  ...
# Subtest: the four contested subjects produce NO strength gap
ok 974 - the four contested subjects produce NO strength gap
  ---
  duration_ms: 0.067625
  type: 'test'
  ...
# Subtest: …but each of the four still fires when a REAL gap is present (DEC-1)
ok 975 - …but each of the four still fires when a REAL gap is present (DEC-1)
  ---
  duration_ms: 0.098625
  type: 'test'
  ...
# Subtest: a topical combination gets BOTH exemptions and still fires on frequency
ok 976 - a topical combination gets BOTH exemptions and still fires on frequency
  ---
  duration_ms: 0.040541
  type: 'test'
  ...
# Subtest: version constants match the PRD exactly
ok 977 - version constants match the PRD exactly
  ---
  duration_ms: 1.37075
  type: 'test'
  ...
# Subtest: candidate mapping per kind (PRD §5 table) — family and skeleton per kind
ok 978 - candidate mapping per kind (PRD §5 table) — family and skeleton per kind
  ---
  duration_ms: 1.393875
  type: 'test'
  ...
# Subtest: baseline buildAskSet asks are also candidates (why baseline, unknownIds [])
ok 979 - baseline buildAskSet asks are also candidates (why baseline, unknownIds [])
  ---
  duration_ms: 0.590375
  type: 'test'
  ...
# Subtest: instability_input / unmappable unknowns produce no candidate and land in dropped
ok 980 - instability_input / unmappable unknowns produce no candidate and land in dropped
  ---
  duration_ms: 0.175833
  type: 'test'
  ...
# Subtest: same-id candidates merge (allergy unknown merges into the baseline allergy ask)
ok 981 - same-id candidates merge (allergy unknown merges into the baseline allergy ask)
  ---
  duration_ms: 0.369292
  type: 'test'
  ...
# Subtest: validateSelection (B6 numbers, B7 phrase-all): out-of-range / non-integer n rejected; duplicate rejected; NO pick cap
ok 982 - validateSelection (B6 numbers, B7 phrase-all): out-of-range / non-integer n rejected; duplicate rejected; NO pick cap
  ---
  duration_ms: 0.726458
  type: 'test'
  ...
# Subtest: validateSelection: rewritten family/subject never survive — candidate fields win
ok 983 - validateSelection: rewritten family/subject never survive — candidate fields win
  ---
  duration_ms: 0.290542
  type: 'test'
  ...
# Subtest: validateSelection: over-length and empty questions are rejected
ok 984 - validateSelection: over-length and empty questions are rejected
  ---
  duration_ms: 0.15475
  type: 'test'
  ...
# Subtest: validateSelection: a generic question (no subject token) is replaced by the candidate skeleton
ok 985 - validateSelection: a generic question (no subject token) is replaced by the candidate skeleton
  ---
  duration_ms: 0.55025
  type: 'test'
  ...
# Subtest: assembly: every high-alert MED_STATUS ask is ALWAYS first (ladder rank 0), regardless of picks
ok 986 - assembly: every high-alert MED_STATUS ask is ALWAYS first (ladder rank 0), regardless of picks
  ---
  duration_ms: 1.388
  type: 'test'
  ...
# Subtest: K2 ladder (B5 ranks): rungs serve in order 0<1<3<4<5<6<7<8 regardless of the pick order fed in
ok 987 - K2 ladder (B5 ranks): rungs serve in order 0<1<3<4<5<6<7<8 regardless of the pick order fed in
  ---
  duration_ms: 0.98275
  type: 'test'
  ...
# Subtest: B5 new-med rung: a med absent from a NON-EMPTY snapshot ranks 2 and leads over a care-gap; empty/absent snapshot stays routine 5
ok 988 - B5 new-med rung: a med absent from a NON-EMPTY snapshot ranks 2 and leads over a care-gap; empty/absent snapshot stays routine 5
  ---
  duration_ms: 19.548542
  type: 'test'
  ...
# Subtest: assembly: total cap stays 5 and the overflow list is preserved
ok 989 - assembly: total cap stays 5 and the overflow list is preserved
  ---
  duration_ms: 0.2255
  type: 'test'
  ...
# Subtest: K2: zero-valid-picks (parsed) is NOT a fallback — ladder assembles with skeleton phrasing, source inquiry
ok 990 - K2: zero-valid-picks (parsed) is NOT a fallback — ladder assembles with skeleton phrasing, source inquiry
  ---
  duration_ms: 0.607083
  type: 'test'
  ...
# Subtest: K2: transport failure retries ONCE, then falls back byte-identical to buildAskSet
ok 991 - K2: transport failure retries ONCE, then falls back byte-identical to buildAskSet
  ---
  duration_ms: 29.583167
  type: 'test'
  ...
# Subtest: runInquirySelection happy path: validated picks served as ask-set/0.2 with askMeta derivation
ok 992 - runInquirySelection happy path: validated picks served as ask-set/0.2 with askMeta derivation
  ---
  duration_ms: 0.755417
  type: 'test'
  ...
# Subtest: B7 phrase-all: with a phrasing for EVERY candidate, all 5 ladder-served asks carry Gemini phrasing (no skeleton)
ok 993 - B7 phrase-all: with a phrasing for EVERY candidate, all 5 ladder-served asks carry Gemini phrasing (no skeleton)
  ---
  duration_ms: 1.233208
  type: 'test'
  ...
# Subtest: parseSelection tolerates prose around the JSON and rejects malformed shapes
ok 994 - parseSelection tolerates prose around the JSON and rejects malformed shapes
  ---
  duration_ms: 0.11675
  type: 'test'
  ...
# Subtest: B6: parseSelection strips markdown code fences (the live-prod fallback root cause)
ok 995 - B6: parseSelection strips markdown code fences (the live-prod fallback root cause)
  ---
  duration_ms: 0.074417
  type: 'test'
  ...
# Subtest: B6 end-to-end: a fenced, number-based Gemini response serves source inquiry with Gemini phrasing
ok 996 - B6 end-to-end: a fenced, number-based Gemini response serves source inquiry with Gemini phrasing
  ---
  duration_ms: 0.266584
  type: 'test'
  ...
# Subtest: fallbackAskSet is buildAskSet verbatim (deep-equal asks + overflow)
ok 997 - fallbackAskSet is buildAskSet verbatim (deep-equal asks + overflow)
  ---
  duration_ms: 0.095125
  type: 'test'
  ...
# Subtest: scorer is deterministic and the metric arithmetic is exact
ok 998 - scorer is deterministic and the metric arithmetic is exact
  ---
  duration_ms: 1.473292
  type: 'test'
  ...
# Subtest: A1 split: family-legality is vocabulary-only; legalSlots23 lands in slotAppropriate, not the gate
ok 999 - A1 split: family-legality is vocabulary-only; legalSlots23 lands in slotAppropriate, not the gate
  ---
  duration_ms: 0.141209
  type: 'test'
  ...
# Subtest: baseline harness runs on the shipped RATIFIED bank (deterministic arm, no LLM)
ok 1000 - baseline harness runs on the shipped RATIFIED bank (deterministic arm, no LLM)
  ---
  duration_ms: 21.227542
  type: 'test'
  ...
# Subtest: askset route: INQUIRY_ENABLED unset ⇒ byte-identical deterministic path
ok 1001 - askset route: INQUIRY_ENABLED unset ⇒ byte-identical deterministic path
  ---
  duration_ms: 0.488708
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: insert is idempotent on id (ON CONFLICT (id) DO NOTHING) and repeat saves succeed
ok 1002 - insert is idempotent on id (ON CONFLICT (id) DO NOTHING) and repeat saves succeed
  ---
  duration_ms: 1.5215
  type: 'test'
  ...
# Subtest: reads soft-fail to empty when the table is missing / DB is down
ok 1003 - reads soft-fail to empty when the table is missing / DB is down
  ---
  duration_ms: 0.248625
  type: 'test'
  ...
# Subtest: K1.1: recomputeOutcomes preserves each row's served ask_set_version (ask-set/0.2 survives)
ok 1004 - K1.1: recomputeOutcomes preserves each row's served ask_set_version (ask-set/0.2 survives)
  ---
  duration_ms: 13.35875
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [rerank] backend failed, returning input order generic
# Subtest: 1a — retrieve: no capture, and two uninstrumented runs are identical statement for statement
ok 1005 - 1a — retrieve: no capture, and two uninstrumented runs are identical statement for statement
  ---
  duration_ms: 150.683875
  type: 'test'
  ...
# Subtest: 1a' — and adding a capture to ONE side only leaves the returned value identical
ok 1006 - 1a' — and adding a capture to ONE side only leaves the returned value identical
  ---
  duration_ms: 0.722375
  type: 'test'
  ...
# Subtest: 2 — rerank: undefined reaches judgeFn and cohereFn as the third argument, and soft failure returns early
ok 1007 - 2 — rerank: undefined reaches judgeFn and cohereFn as the third argument, and soft failure returns early
  ---
  duration_ms: 0.463083
  type: 'test'
  ...
# Subtest: 3 — rerankJudge: identical array and identical request bodies, with and without a capture
ok 1008 - 3 — rerankJudge: identical array and identical request bodies, with and without a capture
  ---
  duration_ms: 21.926125
  type: 'test'
  ...
# Subtest: 4 — rerankCohere: the CapturedBatch literal at :162-174 is never constructed
ok 1009 - 4 — rerankCohere: the CapturedBatch literal at :162-174 is never constructed
  ---
  duration_ms: 0.433583
  type: 'test'
  ...
# Subtest: 5 — expandQuery: capture.expansion is never set, and here evidenceFromCompletion is INSIDE the guard
ok 1010 - 5 — expandQuery: capture.expansion is never set, and here evidenceFromCompletion is INSIDE the guard
  ---
  duration_ms: 3.92225
  type: 'test'
  ...
# Subtest: 6 — retrieveMultiQuery: armCaptures undefined, arms called with undefined, children never set
ok 1011 - 6 — retrieveMultiQuery: armCaptures undefined, arms called with undefined, children never set
  ---
  duration_ms: 0.475417
  type: 'test'
  ...
# Subtest: 7 — the MatchInput seam: no telemetry field means no capture, no declaration and no write
ok 1012 - 7 — the MatchInput seam: no telemetry field means no capture, no declaration and no write
  ---
  duration_ms: 6.014125
  type: 'test'
  ...
# Subtest: v7 §5 — Vertex is the first target when Gemini is on and the bridge flag is off
ok 1013 - v7 §5 — Vertex is the first target when Gemini is on and the bridge flag is off
  ---
  duration_ms: 289.174417
  type: 'test'
  ...
# Subtest: v7 §5 — OpenRouter is the first target when the bridge flag produces a slug
ok 1014 - v7 §5 — OpenRouter is the first target when the bridge flag produces a slug
  ---
  duration_ms: 354.7515
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: v7 §5 — Ollama with JUDGE_MODEL when no cloud tier is available, and that pair IS sanctioned
ok 1015 - v7 §5 — Ollama with JUDGE_MODEL when no cloud tier is available, and that pair IS sanctioned
  ---
  duration_ms: 130.028292
  type: 'test'
  ...
# Subtest: v7 §5 — LLM_PIPELINE=mini forces local, whatever the Gemini flags say
ok 1016 - v7 §5 — LLM_PIPELINE=mini forces local, whatever the Gemini flags say
  ---
  duration_ms: 1.094042
  type: 'test'
  ...
# Subtest: v7 §5 — Gemini flags with NO provider configuration still resolve local, not Vertex
ok 1017 - v7 §5 — Gemini flags with NO provider configuration still resolve local, not Vertex
  ---
  duration_ms: 8.427416
  type: 'test'
  ...
# Subtest: v7 §5 — Cohere resolves to OpenRouter with the effective Cohere model
ok 1018 - v7 §5 — Cohere resolves to OpenRouter with the effective Cohere model
  ---
  duration_ms: 3.991333
  type: 'test'
  ...
# Subtest: v7 §5 — the guard rejects the exact pair that reached the manifest, and accepts all four sanctioned ones
ok 1019 - v7 §5 — the guard rejects the exact pair that reached the manifest, and accepts all four sanctioned ones
  ---
  duration_ms: 4.964208
  type: 'test'
  ...
# Subtest: v7 §5 — EVERY target the resolver can produce is a sanctioned pairing, across the matrix
ok 1020 - v7 §5 — EVERY target the resolver can produce is a sanctioned pairing, across the matrix
  ---
  duration_ms: 3.864166
  type: 'test'
  ...
# Subtest: v7 §5 — no site hardcodes the impossible pair any more, and the correct Cohere site is pinned
ok 1021 - v7 §5 — no site hardcodes the impossible pair any more, and the correct Cohere site is pinned
  ---
  duration_ms: 0.308875
  type: 'test'
  ...
# [rerank] backend failed, returning input order generic, untyped
# Subtest: v7 §6 — a generic Cohere failure records unattributed, because the proof rule governs
ok 1022 - v7 §6 — a generic Cohere failure records unattributed, because the proof rule governs
  ---
  duration_ms: 3.603959
  type: 'test'
  ...
# [rerank] backend failed, returning input order generic
# Subtest: v7 §6 — the resolved intended pairing survives on the soft-failure record too
ok 1023 - v7 §6 — the resolved intended pairing survives on the soft-failure record too
  ---
  duration_ms: 6.708708
  type: 'test'
  ...
# Subtest: v7 §10 — a fresh capture carries the no-rerank values, not zeros
ok 1024 - v7 §10 — a fresh capture carries the no-rerank values, not zeros
  ---
  duration_ms: 1.329334
  type: 'test'
  ...
# Subtest: v7 §10 — Cohere records neither a temperature nor a seed, because it takes neither
ok 1025 - v7 §10 — Cohere records neither a temperature nor a seed, because it takes neither
  ---
  duration_ms: 2.58275
  type: 'test'
  ...
# Subtest: v7 §10 — the judge records its real temperature and `unseeded`, and the call uses the same constant
ok 1026 - v7 §10 — the judge records its real temperature and `unseeded`, and the call uses the same constant
  ---
  duration_ms: 0.243208
  type: 'test'
  ...
# Subtest: v7 §10 — the seed status vocabulary distinguishes a stripped seed from an applied one
ok 1027 - v7 §10 — the seed status vocabulary distinguishes a stripped seed from an applied one
  ---
  duration_ms: 3.621083
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: PHI: the billing reader never names a PHI column from kx_billing_records
ok 1028 - PHI: the billing reader never names a PHI column from kx_billing_records
  ---
  duration_ms: 0.96475
  type: 'test'
  ...
# Subtest: semantics: the ₹ panel never touches the scored-band palette
ok 1029 - semantics: the ₹ panel never touches the scored-band palette
  ---
  duration_ms: 0.221208
  type: 'test'
  ...
# Subtest: recon: a billed clinical category whose NABH field is missing is a gap
ok 1030 - recon: a billed clinical category whose NABH field is missing is a gap
  ---
  duration_ms: 0.269291
  type: 'test'
  ...
# Subtest: recon: present/partial/na/absent are NOT gaps — only an explicit missing is
ok 1031 - recon: present/partial/na/absent are NOT gaps — only an explicit missing is
  ---
  duration_ms: 0.228916
  type: 'test'
  ...
# Subtest: recon: documented-but-not-billed is the other direction, at the same coarseness
ok 1032 - recon: documented-but-not-billed is the other direction, at the same coarseness
  ---
  duration_ms: 0.386583
  type: 'test'
  ...
# Subtest: recon: a PACKAGE-billed admission suppresses documented-but-not-billed (bundling artefact)
ok 1033 - recon: a PACKAGE-billed admission suppresses documented-but-not-billed (bundling artefact)
  ---
  duration_ms: 0.152833
  type: 'test'
  ...
# Subtest: recon: a documented kind of care that IS billed raises nothing in either direction
ok 1034 - recon: a documented kind of care that IS billed raises nothing in either direction
  ---
  duration_ms: 0.116791
  type: 'test'
  ...
# Subtest: bill match: only POSITIVE matches are asserted — by molecule or by drug class
ok 1035 - bill match: only POSITIVE matches are asserted — by molecule or by drug class
  ---
  duration_ms: 0.193625
  type: 'test'
  ...
# Subtest: bill match: the panel never asserts the negative (the measured false-"script?" trap)
ok 1036 - bill match: the panel never asserts the negative (the measured false-"script?" trap)
  ---
  duration_ms: 0.272334
  type: 'test'
  ...
# Subtest: moleculeOf: db13 pharmacy item names are MOLECULE-FORM-STRENGTH-BRAND-PACK
ok 1037 - moleculeOf: db13 pharmacy item names are MOLECULE-FORM-STRENGTH-BRAND-PACK
  ---
  duration_ms: 0.27875
  type: 'test'
  ...
# Subtest: categories: the clinical/facility split is the reconciliation boundary
ok 1038 - categories: the clinical/facility split is the reconciliation boundary
  ---
  duration_ms: 0.05825
  type: 'test'
  ...
# Subtest: billed_total: the row assembler carries the ₹ scalar and it is still not PHI
ok 1039 - billed_total: the row assembler carries the ₹ scalar and it is still not PHI
  ---
  duration_ms: 0.19675
  type: 'test'
  ...
# Subtest: the committed gold artifact is frozen, ratified, and hash-pinned
ok 1040 - the committed gold artifact is frozen, ratified, and hash-pinned
  ---
  duration_ms: 1.203125
  type: 'test'
  ...
# Subtest: K=5 distribution block (carried from 1.1): every case has the modal band + ranges; S4 drift cases ratified
ok 1041 - K=5 distribution block (carried from 1.1): every case has the modal band + ranges; S4 drift cases ratified
  ---
  duration_ms: 0.545666
  type: 'test'
  ...
# Subtest: 2.0 theme upgrade: material themes expanded via V-ratified extras; nitpick sits in a separate minor tier
ok 1042 - 2.0 theme upgrade: material themes expanded via V-ratified extras; nitpick sits in a separate minor tier
  ---
  duration_ms: 0.598791
  type: 'test'
  ...
# Subtest: the gold is de-identified: no UHID / phone / honorific-name patterns anywhere
ok 1043 - the gold is de-identified: no UHID / phone / honorific-name patterns anywhere
  ---
  duration_ms: 1.676542
  type: 'test'
  ...
# Subtest: loadIpdAuditGold rejects drift: edited case, wrong version/status, dup id, bad verdict
ok 1044 - loadIpdAuditGold rejects drift: edited case, wrong version/status, dup id, bad verdict
  ---
  duration_ms: 4.218208
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: semantics: the adjudication component never touches the scored-band palette
ok 1045 - semantics: the adjudication component never touches the scored-band palette
  ---
  duration_ms: 0.688125
  type: 'test'
  ...
# Subtest: semantics: the LVC summary strip renders without band language; the finding list exists once
ok 1046 - semantics: the LVC summary strip renders without band language; the finding list exists once
  ---
  duration_ms: 0.530167
  type: 'test'
  ...
# Subtest: CaseAuditReport: the findingActions slot is optional — absent means unchanged for other callers
ok 1047 - CaseAuditReport: the findingActions slot is optional — absent means unchanged for other callers
  ---
  duration_ms: 0.441708
  type: 'test'
  ...
# Subtest: PHI posture: the row assembler cannot place a name/UHID on the audit row
ok 1048 - PHI posture: the row assembler cannot place a name/UHID on the audit row
  ---
  duration_ms: 0.593625
  type: 'test'
  ...
# Subtest: PHI posture: neither the table nor the store INSERT carries a name/UHID column
ok 1049 - PHI posture: neither the table nor the store INSERT carries a name/UHID column
  ---
  duration_ms: 0.716166
  type: 'test'
  ...
# Subtest: PHI posture: db13 PHI fields are read-time only — never passed to the row assembler
ok 1050 - PHI posture: db13 PHI fields are read-time only — never passed to the row assembler
  ---
  duration_ms: 0.153375
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: IPNO-229: the Internal Medicine audit resolves to Dr Darshana R, NOT Dr Vinod Kumar
ok 1051 - IPNO-229: the Internal Medicine audit resolves to Dr Darshana R, NOT Dr Vinod Kumar
  ---
  duration_ms: 0.962583
  type: 'test'
  ...
# Subtest: IPNO-229: the Orthopedics audit resolves to Dr Vinod Kumar
ok 1052 - IPNO-229: the Orthopedics audit resolves to Dr Vinod Kumar
  ---
  duration_ms: 0.12325
  type: 'test'
  ...
# Subtest: NEVER take the first row — order of the input must not change the answer
ok 1053 - NEVER take the first row — order of the input must not change the answer
  ---
  duration_ms: 0.383167
  type: 'test'
  ...
# Subtest: step 2 — still ambiguous after the speciality match ⇒ most recent discharge_date_time wins
ok 1054 - step 2 — still ambiguous after the speciality match ⇒ most recent discharge_date_time wins
  ---
  duration_ms: 0.285042
  type: 'test'
  ...
# Subtest: step 3 — a null audit speciality (4 of 345) takes the most recent and marks it unconfirmed
ok 1055 - step 3 — a null audit speciality (4 of 345) takes the most recent and marks it unconfirmed
  ---
  duration_ms: 0.435167
  type: 'test'
  ...
# Subtest: a speciality that matches NOTHING falls back to recency and is marked unconfirmed
ok 1056 - a speciality that matches NOTHING falls back to recency and is marked unconfirmed
  ---
  duration_ms: 2.474833
  type: 'test'
  ...
# Subtest: step 4 — a null treating doctor falls back to admitting
ok 1057 - step 4 — a null treating doctor falls back to admitting
  ---
  duration_ms: 0.147125
  type: 'test'
  ...
# Subtest: step 5 — nothing usable ⇒ Unattributed, never a guess and never a throw
ok 1058 - step 5 — nothing usable ⇒ Unattributed, never a guess and never a throw
  ---
  duration_ms: 0.274041
  type: 'test'
  ...
# Subtest: speciality matching tolerates case and whitespace but nothing more
ok 1059 - speciality matching tolerates case and whitespace but nothing more
  ---
  duration_ms: 0.245125
  type: 'test'
  ...
# Subtest: rows with no timestamp sort last and never win over a dated row
ok 1060 - rows with no timestamp sort last and never win over a dated row
  ---
  duration_ms: 0.324208
  type: 'test'
  ...
# Subtest: groupByDoctor aggregates count, mean completeness and band distribution
ok 1061 - groupByDoctor aggregates count, mean completeness and band distribution
  ---
  duration_ms: 0.411834
  type: 'test'
  ...
# Subtest: groupByDoctor: unknown ip_uids become Unattributed, and it always sorts LAST
ok 1062 - groupByDoctor: unknown ip_uids become Unattributed, and it always sorts LAST
  ---
  duration_ms: 0.077292
  type: 'test'
  ...
# Subtest: groupByDoctor: a null completeness does not poison the mean
ok 1063 - groupByDoctor: a null completeness does not poison the mean
  ---
  duration_ms: 0.063292
  type: 'test'
  ...
# Subtest: a group is only "speciality unconfirmed" if EVERY member is
ok 1064 - a group is only "speciality unconfirmed" if EVERY member is
  ---
  duration_ms: 0.043167
  type: 'test'
  ...
# Subtest: groupByDoctor never throws on rubbish input
ok 1065 - groupByDoctor never throws on rubbish input
  ---
  duration_ms: 0.041166
  type: 'test'
  ...
# Subtest: the DEFAULT is Last 3 months (§6.2)
ok 1066 - the DEFAULT is Last 3 months (§6.2)
  ---
  duration_ms: 0.184125
  type: 'test'
  ...
# Subtest: This month / Last month
ok 1067 - This month / Last month
  ---
  duration_ms: 0.090917
  type: 'test'
  ...
# Subtest: Last month across a year boundary, and February leap-year length
ok 1068 - Last month across a year boundary, and February leap-year length
  ---
  duration_ms: 0.095541
  type: 'test'
  ...
# Subtest: Last 3 months across a year boundary
ok 1069 - Last 3 months across a year boundary
  ---
  duration_ms: 0.04075
  type: 'test'
  ...
# Subtest: custom: both bounds, one bound, or neither
ok 1070 - custom: both bounds, one bound, or neither
  ---
  duration_ms: 0.112875
  type: 'test'
  ...
# Subtest: the IST boundary is respected — 23:00 UTC is already tomorrow in Kolkata
ok 1071 - the IST boundary is respected — 23:00 UTC is already tomorrow in Kolkata
  ---
  duration_ms: 0.038917
  type: 'test'
  ...
# Subtest: THE DEFECT, reproduced: counting rows gives 27 orthopaedic, counting documents gives 22
ok 1072 - THE DEFECT, reproduced: counting rows gives 27 orthopaedic, counting documents gives 22
  ---
  duration_ms: 0.384125
  type: 'test'
  ...
# Subtest: ACCEPTANCE: the speciality chip and the list total are EQUAL for every speciality
ok 1073 - ACCEPTANCE: the speciality chip and the list total are EQUAL for every speciality
  ---
  duration_ms: 9.818041
  type: 'test'
  ...
# Subtest: ACCEPTANCE holds for every range × speciality combination
ok 1074 - ACCEPTANCE holds for every range × speciality combination
  ---
  duration_ms: 0.2325
  type: 'test'
  ...
# Subtest: the winner is the HIGHEST engine version, ties broken by latest audited_at
ok 1075 - the winner is the HIGHEST engine version, ties broken by latest audited_at
  ---
  duration_ms: 0.116083
  type: 'test'
  ...
# Subtest: input order never changes the winner
ok 1076 - input order never changes the winner
  ---
  duration_ms: 0.091208
  type: 'test'
  ...
# Subtest: version comparison is NUMERIC, so 0.10 beats 0.2 (a plain DESC sort gets this wrong)
ok 1077 - version comparison is NUMERIC, so 0.10 beats 0.2 (a plain DESC sort gets this wrong)
  ---
  duration_ms: 0.062209
  type: 'test'
  ...
# Subtest: mini/Qwen backfill rows never win a document
ok 1078 - mini/Qwen backfill rows never win a document
  ---
  duration_ms: 0.050208
  type: 'test'
  ...
# Subtest: canonicalByDocument is a READ FILTER — it never mutates the rows it is given
ok 1079 - canonicalByDocument is a READ FILTER — it never mutates the rows it is given
  ---
  duration_ms: 0.080208
  type: 'test'
  ...
# Subtest: rows with no document_id are PASSED THROUGH, never silently dropped
ok 1080 - rows with no document_id are PASSED THROUGH, never silently dropped
  ---
  duration_ms: 0.045166
  type: 'test'
  ...
# Subtest: canonicalByDocument preserves the SQL ordering of the survivors
ok 1081 - canonicalByDocument preserves the SQL ordering of the survivors
  ---
  duration_ms: 0.071041
  type: 'test'
  ...
# Subtest: canonicalByDocument never throws on rubbish
ok 1082 - canonicalByDocument never throws on rubbish
  ---
  duration_ms: 0.042083
  type: 'test'
  ...
# Subtest: specialityCounts buckets blank/null speciality as Unassigned and sorts by count desc
ok 1083 - specialityCounts buckets blank/null speciality as Unassigned and sorts by count desc
  ---
  duration_ms: 0.063583
  type: 'test'
  ...
# Subtest: every read surface goes through the ONE rule — no surface writes its own DISTINCT ON
ok 1084 - every read surface goes through the ONE rule — no surface writes its own DISTINCT ON
  ---
  duration_ms: 0.484166
  type: 'test'
  ...
# Subtest: NOTHING IS WRITTEN OR DELETED — this is a read filter only
ok 1085 - NOTHING IS WRITTEN OR DELETED — this is a read filter only
  ---
  duration_ms: 0.338958
  type: 'test'
  ...
# Subtest: the migration runner applies 0028 too, idempotently (§1.2 B-3)
ok 1086 - the migration runner applies 0028 too, idempotently (§1.2 B-3)
  ---
  duration_ms: 0.626
  type: 'test'
  ...
# Subtest: the runner and 0028_review_notes.sql agree on every object
ok 1087 - the runner and 0028_review_notes.sql agree on every object
  ---
  duration_ms: 0.663917
  type: 'test'
  ...
# Subtest: the doctor lookup uses the VALIDATED table and join key, and none of the three rejected ones
ok 1088 - the doctor lookup uses the VALIDATED table and join key, and none of the three rejected ones
  ---
  duration_ms: 0.203916
  type: 'test'
  ...
# Subtest: the doctor lookup is BATCHED — one call per page, never one per row
ok 1089 - the doctor lookup is BATCHED — one call per page, never one per row
  ---
  duration_ms: 0.117458
  type: 'test'
  ...
# Subtest: the doctor lookup FAILS SOFT — the catch returns Unattributed, never throws
ok 1090 - the doctor lookup FAILS SOFT — the catch returns Unattributed, never throws
  ---
  duration_ms: 0.1175
  type: 'test'
  ...
# Subtest: inputs are validated and escaped before interpolation (no bound params in a native query)
ok 1091 - inputs are validated and escaped before interpolation (no bound params in a native query)
  ---
  duration_ms: 0.086083
  type: 'test'
  ...
# Subtest: migration 0028 is additive and idempotent; existing rows keep reading
ok 1092 - migration 0028 is additive and idempotent; existing rows keep reading
  ---
  duration_ms: 0.172792
  type: 'test'
  ...
# Subtest: the review route writes kind=review with a null finding_ref, and overwrites in place
ok 1093 - the review route writes kind=review with a null finding_ref, and overwrites in place
  ---
  duration_ms: 0.116708
  type: 'test'
  ...
# Subtest: the list query degrades when 0028 has not run — it never 500s
ok 1094 - the list query degrades when 0028 has not run — it never 500s
  ---
  duration_ms: 0.131833
  type: 'test'
  ...
# Subtest: the speciality filter renders RAW values and offers Unassigned for the nulls (§6.1)
ok 1095 - the speciality filter renders RAW values and offers Unassigned for the nulls (§6.1)
  ---
  duration_ms: 0.189667
  type: 'test'
  ...
# Subtest: the shared report renderer stays byte-identical for callers that pass no Phase B props
ok 1096 - the shared report renderer stays byte-identical for callers that pass no Phase B props
  ---
  duration_ms: 0.13025
  type: 'test'
  ...
# Subtest: vercel.json HAS an /api/ipd-audit/worker cron again
ok 1097 - vercel.json HAS an /api/ipd-audit/worker cron again
  ---
  duration_ms: 0.521458
  type: 'test'
  ...
# Subtest: THE COUPLING: the cron interval EXCEEDS the route maxDuration, so runs cannot overlap
ok 1098 - THE COUPLING: the cron interval EXCEEDS the route maxDuration, so runs cannot overlap
  ---
  duration_ms: 0.151416
  type: 'test'
  ...
# Subtest: restoring the cron did not disturb any other schedule
ok 1099 - restoring the cron did not disturb any other schedule
  ---
  duration_ms: 0.135792
  type: 'test'
  ...
# Subtest: the route records the correction, not the withdrawn claim
ok 1100 - the route records the correction, not the withdrawn claim
  ---
  duration_ms: 0.080667
  type: 'test'
  ...
# Subtest: the defaults are max 3 and conc 3 — ONE wave, not three
ok 1101 - the defaults are max 3 and conc 3 — ONE wave, not three
  ---
  duration_ms: 0.067958
  type: 'test'
  ...
# Subtest: THE ARITHMETIC the defaults rest on: one wave fits 800 s, three do not
ok 1102 - THE ARITHMETIC the defaults rest on: one wave fits 800 s, three do not
  ---
  duration_ms: 0.075125
  type: 'test'
  ...
# Subtest: the ?max= and ?conc= overrides and their caps still work
ok 1103 - the ?max= and ?conc= overrides and their caps still work
  ---
  duration_ms: 0.133625
  type: 'test'
  ...
# Subtest: servedCallFor queries stage doc_audit_analyze — NOT opd_audit_analyze
ok 1104 - servedCallFor queries stage doc_audit_analyze — NOT opd_audit_analyze
  ---
  duration_ms: 0.283084
  type: 'test'
  ...
# Subtest: the model column is no longer a constant on the cloud path
ok 1105 - the model column is no longer a constant on the cloud path
  ---
  duration_ms: 0.166333
  type: 'test'
  ...
# Subtest: THE MINI PATH IS UNCHANGED — it still records MINI_MODEL
ok 1106 - THE MINI PATH IS UNCHANGED — it still records MINI_MODEL
  ---
  duration_ms: 0.28975
  type: 'test'
  ...
# Subtest: servedCallFor soft-fails: null on a missing traceId, null on a query failure, never throws
ok 1107 - servedCallFor soft-fails: null on a missing traceId, null on a query failure, never throws
  ---
  duration_ms: 0.182041
  type: 'test'
  ...
# [lab-override] route=app/api/ask provider=bedrock model=global.anthropic.claude-haiku-4-5-20251001-v1:0 paid=true caller=lab-mcp
# [lab-override] route=app/api/ask REFUSED reason=not_admin
# [lab-override] route=app/api/ask REFUSED reason=not_admin
# [lab-override] route=app/api/ask REFUSED reason=clinician_session
# Subtest: AN MCP-ORIGIN OVERRIDE NOW PASSES THE GATE — the 7 Aug run, with the credential
ok 1108 - AN MCP-ORIGIN OVERRIDE NOW PASSES THE GATE — the 7 Aug run, with the credential
  ---
  duration_ms: 1.168709
  type: 'test'
  ...
# Subtest: THE SAME REQUEST WITHOUT THE CREDENTIAL STILL REFUSES — nothing was widened
ok 1109 - THE SAME REQUEST WITHOUT THE CREDENTIAL STILL REFUSES — nothing was widened
  ---
  duration_ms: 0.519917
  type: 'test'
  ...
# Subtest: a WRONG credential is refused, and a right one is compared timing-safely
ok 1110 - a WRONG credential is refused, and a right one is compared timing-safely
  ---
  duration_ms: 0.242667
  type: 'test'
  ...
# Subtest: ADMIN_TOKEN UNSET ⇒ refusal stays the default, on BOTH sides independently
ok 1111 - ADMIN_TOKEN UNSET ⇒ refusal stays the default, on BOTH sides independently
  ---
  duration_ms: 0.402792
  type: 'test'
  ...
# Subtest: the credential never logs, never echoes into a row, never reaches a trace
ok 1112 - the credential never logs, never echoes into a row, never reaches a trace
  ---
  duration_ms: 0.536042
  type: 'test'
  ...
# Subtest: the header unlocks the F11 gate ONLY — isAdminUnlocked gains no new caller
ok 1113 - the header unlocks the F11 gate ONLY — isAdminUnlocked gains no new caller
  ---
  duration_ms: 0.118458
  type: 'test'
  ...
# Subtest: the credential rides TLS or loopback only — never plain http to a foreign host
ok 1114 - the credential rides TLS or loopback only — never plain http to a foreign host
  ---
  duration_ms: 0.320125
  type: 'test'
  ...
# Subtest: only the two WIRED probes send it, and only when an override is requested
ok 1115 - only the two WIRED probes send it, and only when an override is requested
  ---
  duration_ms: 0.274708
  type: 'test'
  ...
# Subtest: decideOverride is untouched — the gate still DEMANDS isAdmin, it is only satisfiable now
ok 1116 - decideOverride is untouched — the gate still DEMANDS isAdmin, it is only satisfiable now
  ---
  duration_ms: 0.251958
  type: 'test'
  ...
# Subtest: a real clinician session refuses the MCP credential too (end to end)
ok 1117 - a real clinician session refuses the MCP credential too (end to end)
  ---
  duration_ms: 0.39075
  type: 'test'
  ...
# Subtest: the deps seam defaults to the real guards — production passes nothing
ok 1118 - the deps seam defaults to the real guards — production passes nothing
  ---
  duration_ms: 0.2365
  type: 'test'
  ...
# Subtest: ⚠️ THE 7 AUG RUN: a bedrock-target ask whose legs resolved to ollama is REFUSED, not stored
ok 1119 - ⚠️ THE 7 AUG RUN: a bedrock-target ask whose legs resolved to ollama is REFUSED, not stored
  ---
  duration_ms: 0.667
  type: 'test'
  ...
# Subtest: the refused row stops asserting the model, and keeps the evidence
ok 1120 - the refused row stops asserting the model, and keeps the evidence
  ---
  duration_ms: 0.375208
  type: 'test'
  ...
# Subtest: a genuinely-served run verifies, and is stored as what SERVED
ok 1121 - a genuinely-served run verifies, and is stored as what SERVED
  ---
  duration_ms: 0.108041
  type: 'test'
  ...
# Subtest: vertex ≡ gemini across the seam — the two vocabularies are one provider
ok 1122 - vertex ≡ gemini across the seam — the two vocabularies are one provider
  ---
  duration_ms: 0.05975
  type: 'test'
  ...
# Subtest: a legitimate V-a2 ladder hop is not an error — but the row records who ANSWERED
ok 1123 - a legitimate V-a2 ladder hop is not an error — but the row records who ANSWERED
  ---
  duration_ms: 0.119709
  type: 'test'
  ...
# Subtest: utility legs are out of scope — only the legs an override steers are judged
ok 1124 - utility legs are out of scope — only the legs an override steers are judged
  ---
  duration_ms: 0.066208
  type: 'test'
  ...
# Subtest: THE LIST MUST NOT FALL BEHIND THE ROUTES: every `...LAB` traced leg is judged
ok 1125 - THE LIST MUST NOT FALL BEHIND THE ROUTES: every `...LAB` traced leg is judged
  ---
  duration_ms: 0.2845
  type: 'test'
  ...
# Subtest: a PAID claim with no recorded call is refused; a free one stores unverified
ok 1126 - a PAID claim with no recorded call is refused; a free one stores unverified
  ---
  duration_ms: 0.068791
  type: 'test'
  ...
# Subtest: empty/garbage legs are treated as no evidence, never as agreement
ok 1127 - empty/garbage legs are treated as no evidence, never as agreement
  ---
  duration_ms: 0.187708
  type: 'test'
  ...
# Subtest: both F11-wired probes carry the attribution config, and the unwired ones do not
ok 1128 - both F11-wired probes carry the attribution config, and the unwired ones do not
  ---
  duration_ms: 0.426833
  type: 'test'
  ...
# Subtest: the refusal happens BEFORE the row is stored as done, or it is not a refusal
ok 1129 - the refusal happens BEFORE the row is stored as done, or it is not a refusal
  ---
  duration_ms: 0.157375
  type: 'test'
  ...
# Subtest: the probe no longer echoes the REQUESTED model into the stored output or summary
ok 1130 - the probe no longer echoes the REQUESTED model into the stored output or summary
  ---
  duration_ms: 0.128917
  type: 'test'
  ...
# Subtest: the trace id reaches the probe: routes emit it, the reducers keep it
ok 1131 - the trace id reaches the probe: routes emit it, the reducers keep it
  ---
  duration_ms: 0.146291
  type: 'test'
  ...
# Subtest: clampN clamps to 1..LB_MAX_N and floors garbage to 1
ok 1132 - clampN clamps to 1..LB_MAX_N and floors garbage to 1
  ---
  duration_ms: 0.62025
  type: 'test'
  ...
# Subtest: sanitizeUids: id-safe, de-duped, capped
ok 1133 - sanitizeUids: id-safe, de-duped, capped
  ---
  duration_ms: 1.754334
  type: 'test'
  ...
# Subtest: remainingUids removes the done-set, order preserved
ok 1134 - remainingUids removes the done-set, order preserved
  ---
  duration_ms: 0.278458
  type: 'test'
  ...
# Subtest: parseBatchState parses settings map
ok 1135 - parseBatchState parses settings map
  ---
  duration_ms: 0.4895
  type: 'test'
  ...
# Subtest: parseBatchState defaults
ok 1136 - parseBatchState defaults
  ---
  duration_ms: 0.156291
  type: 'test'
  ...
# Subtest: evalRerankBackend (Addendum C): exact match only — judge/cohere parse, everything else is null
ok 1137 - evalRerankBackend (Addendum C): exact match only — judge/cohere parse, everything else is null
  ---
  duration_ms: 0.194458
  type: 'test'
  ...
# Subtest: evalRerankBackend threads batch state → evalCfg → runMiniOpdToLab (source-pinned)
ok 1138 - evalRerankBackend threads batch state → evalCfg → runMiniOpdToLab (source-pinned)
  ---
  duration_ms: 1.15925
  type: 'test'
  ...
# Subtest: batchGate precedence
ok 1139 - batchGate precedence
  ---
  duration_ms: 0.273167
  type: 'test'
  ...
# Subtest: LB_LOCK_TTL_MS is 900s and is NOT the prod worker's TTL (D1)
ok 1140 - LB_LOCK_TTL_MS is 900s and is NOT the prod worker's TTL (D1)
  ---
  duration_ms: 0.213292
  type: 'test'
  ...
# Subtest: labLockHeld mirrors mini-backfill.lockHeld exactly, differing ONLY in the TTL
ok 1141 - labLockHeld mirrors mini-backfill.lockHeld exactly, differing ONLY in the TTL
  ---
  duration_ms: 1.646375
  type: 'test'
  ...
# Subtest: THE DEFECT, reproduced: the average note outlived the old TTL
ok 1142 - THE DEFECT, reproduced: the average note outlived the old TTL
  ---
  duration_ms: 0.06875
  type: 'test'
  ...
# Subtest: ttlBreach reports the max observed ms and whether it reached the TTL
ok 1143 - ttlBreach reports the max observed ms and whether it reached the TTL
  ---
  duration_ms: 0.436417
  type: 'test'
  ...
# Subtest: ttlBreach is pure observation: never throws, ignores non-numeric ms, empty ⇒ 0
ok 1144 - ttlBreach is pure observation: never throws, ignores non-numeric ms, empty ⇒ 0
  ---
  duration_ms: 0.124291
  type: 'test'
  ...
# Subtest: the breach message is verbatim per PRD §5, with both numbers interpolated
ok 1145 - the breach message is verbatim per PRD §5, with both numbers interpolated
  ---
  duration_ms: 0.045958
  type: 'test'
  ...
# Subtest: batchGate ordering is UNCHANGED by this build
ok 1146 - batchGate ordering is UNCHANGED by this build
  ---
  duration_ms: 0.06525
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: mini path (no evalModel): n≤2, serial (concurrency 1), mini-yield honoured
ok 1147 - mini path (no evalModel): n≤2, serial (concurrency 1), mini-yield honoured
  ---
  duration_ms: 0.975833
  type: 'test'
  ...
# Subtest: eval path (evalModel set): drains exactly ONE WAVE and skips the mini-yield
ok 1148 - eval path (evalModel set): drains exactly ONE WAVE and skips the mini-yield
  ---
  duration_ms: 0.116292
  type: 'test'
  ...
# Subtest: eval sliceSize == concurrency across the whole clamped range (1..EVAL_CONCURRENCY_MAX)
ok 1149 - eval sliceSize == concurrency across the whole clamped range (1..EVAL_CONCURRENCY_MAX)
  ---
  duration_ms: 0.255708
  type: 'test'
  ...
# Subtest: THE DEFECT: the old slice was ~890s of work in one invocation; the new one is one audit
ok 1150 - THE DEFECT: the old slice was ~890s of work in one invocation; the new one is one audit
  ---
  duration_ms: 0.063625
  type: 'test'
  ...
# Subtest: EVAL_TICK_MAX remains a hard ceiling on the slice (D2)
ok 1151 - EVAL_TICK_MAX remains a hard ceiling on the slice (D2)
  ---
  duration_ms: 0.100208
  type: 'test'
  ...
# Subtest: the mini branch of drainPlan is UNTOUCHED by the one-wave change
ok 1152 - the mini branch of drainPlan is UNTOUCHED by the one-wave change
  ---
  duration_ms: 0.176083
  type: 'test'
  ...
# Subtest: clampEvalConcurrency: default 10, clamp 1..25
ok 1153 - clampEvalConcurrency: default 10, clamp 1..25
  ---
  duration_ms: 0.047042
  type: 'test'
  ...
# Subtest: boundedPool never exceeds its concurrency limit and preserves result order
ok 1154 - boundedPool never exceeds its concurrency limit and preserves result order
  ---
  duration_ms: 23.878541
  type: 'test'
  ...
# Subtest: boundedPool handles limit > items and empty input
ok 1155 - boundedPool handles limit > items and empty input
  ---
  duration_ms: 1.537209
  type: 'test'
  ...
# Subtest: openRouterGenerate retries 429 then succeeds; sleeps between attempts
ok 1156 - openRouterGenerate retries 429 then succeeds; sleeps between attempts
  ---
  duration_ms: 17.189792
  type: 'test'
  ...
# Subtest: openRouterGenerate throws after OPENROUTER_MAX_TRIES persistent 5xx — no silent fallback
ok 1157 - openRouterGenerate throws after OPENROUTER_MAX_TRIES persistent 5xx — no silent fallback
  ---
  duration_ms: 0.829875
  type: 'test'
  ...
# Subtest: non-transient status (400) throws immediately — no retry
ok 1158 - non-transient status (400) throws immediately — no retry
  ---
  duration_ms: 0.218625
  type: 'test'
  ...
# Subtest: retryable statuses are exactly 429 + 5xx; backoff is jittered-exponential and positive
ok 1159 - retryable statuses are exactly 429 + 5xx; backoff is jittered-exponential and positive
  ---
  duration_ms: 0.063708
  type: 'test'
  ...
# Subtest: the eval drain still writes lab_analyses only — never opd_note_audits
ok 1160 - the eval drain still writes lab_analyses only — never opd_note_audits
  ---
  duration_ms: 0.299167
  type: 'test'
  ...
# Subtest: the tick summary carries tick_ms / slice_planned / slice_drained (D3)
ok 1161 - the tick summary carries tick_ms / slice_planned / slice_drained (D3)
  ---
  duration_ms: 0.223458
  type: 'test'
  ...
# Subtest: the D3 fields are OBSERVATION ONLY — never branched on, never thrown from
ok 1162 - the D3 fields are OBSERVATION ONLY — never branched on, never thrown from
  ---
  duration_ms: 0.479875
  type: 'test'
  ...
# Subtest: LB_LOCK_TTL_MS / labLockHeld / ttlBreach survive this build unchanged
ok 1163 - LB_LOCK_TTL_MS / labLockHeld / ttlBreach survive this build unchanged
  ---
  duration_ms: 0.210333
  type: 'test'
  ...
# Subtest: parseBatchState reads evalConcurrency; absent ⇒ default 10
ok 1164 - parseBatchState reads evalConcurrency; absent ⇒ default 10
  ---
  duration_ms: 0.126917
  type: 'test'
  ...
# Subtest: parseNdjson tolerates blank + garbled lines
ok 1165 - parseNdjson tolerates blank + garbled lines
  ---
  duration_ms: 0.5135
  type: 'test'
  ...
# Subtest: reduceDdxEvents folds a full stream
ok 1166 - reduceDdxEvents folds a full stream
  ---
  duration_ms: 0.444792
  type: 'test'
  ...
# Subtest: reduceDdxEvents surfaces an error stream as not-ok
ok 1167 - reduceDdxEvents surfaces an error stream as not-ok
  ---
  duration_ms: 0.142542
  type: 'test'
  ...
# Subtest: extractCitationIds pulls distinct sorted numeric ids
ok 1168 - extractCitationIds pulls distinct sorted numeric ids
  ---
  duration_ms: 0.11575
  type: 'test'
  ...
# Subtest: reduceAskEvents keeps the revised answer, flags uncited
ok 1169 - reduceAskEvents keeps the revised answer, flags uncited
  ---
  duration_ms: 0.131
  type: 'test'
  ...
# Subtest: reduceAskEvents flags a long uncited answer (cite-or-label canary)
ok 1170 - reduceAskEvents flags a long uncited answer (cite-or-label canary)
  ---
  duration_ms: 0.064417
  type: 'test'
  ...
# Subtest: reduceAppropriatenessEvents captures fired CW statements (over-flag surface)
ok 1171 - reduceAppropriatenessEvents captures fired CW statements (over-flag surface)
  ---
  duration_ms: 0.130709
  type: 'test'
  ...
# Subtest: reduceAppropriatenessEvents handles the empty (nothing-fired) case
ok 1172 - reduceAppropriatenessEvents handles the empty (nothing-fired) case
  ---
  duration_ms: 0.05875
  type: 'test'
  ...
# Subtest: reduceDocAuditEvents pulls the scorecard headline/band
ok 1173 - reduceDocAuditEvents pulls the scorecard headline/band
  ---
  duration_ms: 0.252458
  type: 'test'
  ...
# Subtest: reduceDocAuditEvents surfaces a stream error
ok 1174 - reduceDocAuditEvents surfaces a stream error
  ---
  duration_ms: 1.752167
  type: 'test'
  ...
# Subtest: labSelfBaseUrl prefers explicit, then VERCEL_URL, then localhost
ok 1175 - labSelfBaseUrl prefers explicit, then VERCEL_URL, then localhost
  ---
  duration_ms: 0.318625
  type: 'test'
  ...
# Subtest: labLabel sanitises to a safe slug
ok 1176 - labLabel sanitises to a safe slug
  ---
  duration_ms: 0.830333
  type: 'test'
  ...
# Subtest: chunkText splits on paragraphs, drops tiny fragments, respects the window
ok 1177 - chunkText splits on paragraphs, drops tiny fragments, respects the window
  ---
  duration_ms: 0.457583
  type: 'test'
  ...
# Subtest: chunkText hard-splits a single monster paragraph
ok 1178 - chunkText hard-splits a single monster paragraph
  ---
  duration_ms: 0.216167
  type: 'test'
  ...
# Subtest: chunkText returns empty for whitespace-only input
ok 1179 - chunkText returns empty for whitespace-only input
  ---
  duration_ms: 0.616792
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: quarantine INSERT carries visible in the columns and false in the values
ok 1180 - quarantine INSERT carries visible in the columns and false in the values
  ---
  duration_ms: 0.535708
  type: 'test'
  ...
# Subtest: activation UPDATE sets both source and visible = true
ok 1181 - activation UPDATE sets both source and visible = true
  ---
  duration_ms: 0.062708
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: G2/A10.3: the two SCOPES constants differ and are NOT unified
ok 1182 - G2/A10.3: the two SCOPES constants differ and are NOT unified
  ---
  duration_ms: 1.062125
  type: 'test'
  ...
# Subtest: F6: parseFeedbackBody REFUSES scope=missed without a category
ok 1183 - F6: parseFeedbackBody REFUSES scope=missed without a category
  ---
  duration_ms: 0.199209
  type: 'test'
  ...
# Subtest: F6: accepts every whitelisted category, rejects an unknown one
ok 1184 - F6: accepts every whitelisted category, rejects an unknown one
  ---
  duration_ms: 0.168792
  type: 'test'
  ...
# Subtest: F6: the required-category change touches ONLY scope=missed
ok 1185 - F6: the required-category change touches ONLY scope=missed
  ---
  duration_ms: 0.147459
  type: 'test'
  ...
# Subtest: F6: rollup groups missed by CATEGORY and reports recall_proxy as a lower bound
ok 1186 - F6: rollup groups missed by CATEGORY and reports recall_proxy as a lower bound
  ---
  duration_ms: 0.470791
  type: 'test'
  ...
# Subtest: F6: recall_proxy is null on a zero denominator, never NaN
ok 1187 - F6: recall_proxy is null on a zero denominator, never NaN
  ---
  duration_ms: 0.078334
  type: 'test'
  ...
# Subtest: F6: the category→signal map is deliberately partial
ok 1188 - F6: the category→signal map is deliberately partial
  ---
  duration_ms: 0.102291
  type: 'test'
  ...
# Subtest: F17: impact fold reports both tags and coverage_of_tp
ok 1189 - F17: impact fold reports both tags and coverage_of_tp
  ---
  duration_ms: 0.1095
  type: 'test'
  ...
# Subtest: F17: absent impact rows degrade to zeroes and a null coverage, never a throw
ok 1190 - F17: absent impact rows degrade to zeroes and a null coverage, never a throw
  ---
  duration_ms: 0.1835
  type: 'test'
  ...
# Subtest: F11: resolver maps all three prefixes and marks paid correctly
ok 1191 - F11: resolver maps all three prefixes and marks paid correctly
  ---
  duration_ms: 0.340875
  type: 'test'
  ...
# Subtest: F11: omitted model = the local mini, behaviour unchanged
ok 1192 - F11: omitted model = the local mini, behaviour unchanged
  ---
  duration_ms: 0.047917
  type: 'test'
  ...
# Subtest: F11: an unknown provider ERRORS LOUD and never falls back to the mini
ok 1193 - F11: an unknown provider ERRORS LOUD and never falls back to the mini
  ---
  duration_ms: 0.057625
  type: 'test'
  ...
# Subtest: F11: paid ceiling defaults to 250, stops at N and reports
ok 1194 - F11: paid ceiling defaults to 250, stops at N and reports
  ---
  duration_ms: 0.075209
  type: 'test'
  ...
# Subtest: F12b: allowlisted source files are readable
ok 1195 - F12b: allowlisted source files are readable
  ---
  duration_ms: 0.341
  type: 'test'
  ...
# Subtest: F12b: ../ traversal cannot escape, even disguised behind an allowed prefix
ok 1196 - F12b: ../ traversal cannot escape, even disguised behind an allowed prefix
  ---
  duration_ms: 0.109959
  type: 'test'
  ...
# Subtest: F12b: denylisted names are refused wherever they sit, including under lib/
ok 1197 - F12b: denylisted names are refused wherever they sit, including under lib/
  ---
  duration_ms: 0.153416
  type: 'test'
  ...
# Subtest: F12b: absolute paths, non-source files and anything outside the seam are refused
ok 1198 - F12b: absolute paths, non-source files and anything outside the seam are refused
  ---
  duration_ms: 0.056917
  type: 'test'
  ...
# Subtest: F13: corpus_add refuses a chunk with no citation
ok 1199 - F13: corpus_add refuses a chunk with no citation
  ---
  duration_ms: 0.116333
  type: 'test'
  ...
# Subtest: F13: accepts any ONE of url/doi/pmid with year + licence
ok 1200 - F13: accepts any ONE of url/doi/pmid with year + licence
  ---
  duration_ms: 0.068542
  type: 'test'
  ...
# Subtest: F13: the internal-protocol escape bypasses the gate entirely
ok 1201 - F13: the internal-protocol escape bypasses the gate entirely
  ---
  duration_ms: 0.041375
  type: 'test'
  ...
# Subtest: F13: year and licence are validated, not merely present
ok 1202 - F13: year and licence are validated, not merely present
  ---
  duration_ms: 0.051708
  type: 'test'
  ...
# Subtest: F14: lvc_propose refuses an uncited proposal
ok 1203 - F14: lvc_propose refuses an uncited proposal
  ---
  duration_ms: 0.144125
  type: 'test'
  ...
# Subtest: F14 (A10.4): lvc_propose REFUSES a near-duplicate unless supersedes_id is supplied
ok 1204 - F14 (A10.4): lvc_propose REFUSES a near-duplicate unless supersedes_id is supplied
  ---
  duration_ms: 0.307166
  type: 'test'
  ...
# Subtest: F14: a genuinely distinct cited statement is accepted
ok 1205 - F14: a genuinely distinct cited statement is accepted
  ---
  duration_ms: 0.122625
  type: 'test'
  ...
# Subtest: F14: the duplicate detector recognises the measured rulebook variants
ok 1206 - F14: the duplicate detector recognises the measured rulebook variants
  ---
  duration_ms: 0.0645
  type: 'test'
  ...
# Subtest: F14: lvc_ratify refuses without confirm, with the default author, or without a rationale
ok 1207 - F14: lvc_ratify refuses without confirm, with the default author, or without a rationale
  ---
  duration_ms: 0.0935
  type: 'test'
  ...
# Subtest: F14: lvc_ratify is PROMOTE-ONLY — it cannot create de novo
ok 1208 - F14: lvc_ratify is PROMOTE-ONLY — it cannot create de novo
  ---
  duration_ms: 0.035042
  type: 'test'
  ...
# Subtest: F14: only a proposed row is promotable; rejection is first-class, never a delete
ok 1209 - F14: only a proposed row is promotable; rejection is first-class, never a delete
  ---
  duration_ms: 0.06075
  type: 'test'
  ...
# Subtest: F14: lvc_gaps calls a never-fired rule a RETIREMENT candidate, not a citation candidate
ok 1210 - F14: lvc_gaps calls a never-fired rule a RETIREMENT candidate, not a citation candidate
  ---
  duration_ms: 0.113458
  type: 'test'
  ...
# Subtest: F14: gaps rank by fires within class
ok 1211 - F14: gaps rank by fires within class
  ---
  duration_ms: 0.036833
  type: 'test'
  ...
# Subtest: F16: lab:/labq: weights are clamped at 0.855 until promoted
ok 1212 - F16: lab:/labq: weights are clamped at 0.855 until promoted
  ---
  duration_ms: 0.0635
  type: 'test'
  ...
# Subtest: F17: feedback_detail ADMITS scope=impact (it was write-only) and validates its tags
ok 1213 - F17: feedback_detail ADMITS scope=impact (it was write-only) and validates its tags
  ---
  duration_ms: 0.360584
  type: 'test'
  ...
# Subtest: F6 UI: SavedEvent carries category; applySaved dedupe semantics are unchanged
ok 1214 - F6 UI: SavedEvent carries category; applySaved dedupe semantics are unchanged
  ---
  duration_ms: 0.090916
  type: 'test'
  ...
# Subtest: F6 UI: every category the controls offer is one the write path accepts
ok 1215 - F6 UI: every category the controls offer is one the write path accepts
  ---
  duration_ms: 0.057666
  type: 'test'
  ...
# Subtest: wiring: the four new tools are registered with their required args
ok 1216 - wiring: the four new tools are registered with their required args
  ---
  duration_ms: 0.125917
  type: 'test'
  ...
# Subtest: wiring: corpus_add exposes all six F13 provenance fields
ok 1217 - wiring: corpus_add exposes all six F13 provenance fields
  ---
  duration_ms: 0.037708
  type: 'test'
  ...
# Subtest: wiring: F13 provenance reaches the INSERT, and quarantine stays invisible
ok 1218 - wiring: F13 provenance reaches the INSERT, and quarantine stays invisible
  ---
  duration_ms: 0.048292
  type: 'test'
  ...
# Subtest: wiring: every new tool description states its WRITE-CLASS (F3 discipline held)
ok 1219 - wiring: every new tool description states its WRITE-CLASS (F3 discipline held)
  ---
  duration_ms: 0.041
  type: 'test'
  ...
# Subtest: wiring: lvc_propose never claims to write the rulebook; lvc_ratify is promote-only
ok 1220 - wiring: lvc_propose never claims to write the rulebook; lvc_ratify is promote-only
  ---
  duration_ms: 0.054625
  type: 'test'
  ...
# Subtest: F14 faults 1a + 7: ALL THREE lvc_recommendations query sites use `society`, never `source`
ok 1221 - F14 faults 1a + 7: ALL THREE lvc_recommendations query sites use `society`, never `source`
  ---
  duration_ms: 0.31925
  type: 'test'
  ...
# Subtest: F14 fault 6: region is supplied — the NOT NULL set is exactly id, region, society, statement
ok 1222 - F14 fault 6: region is supplied — the NOT NULL set is exactly id, region, society, statement
  ---
  duration_ms: 0.078833
  type: 'test'
  ...
# Subtest: F14 fault 1b: the promoted row is society=EHRC, UPPERCASE
ok 1223 - F14 fault 1b: the promoted row is society=EHRC, UPPERCASE
  ---
  duration_ms: 0.141792
  type: 'test'
  ...
# Subtest: F14 faults 2-4: the promotion INSERT names the three audit columns 0024 adds
ok 1224 - F14 faults 2-4: the promotion INSERT names the three audit columns 0024 adds
  ---
  duration_ms: 0.11975
  type: 'test'
  ...
# Subtest: F14 fault 5: `id` is supplied explicitly, matching the ehrc-<uuid> convention
ok 1225 - F14 fault 5: `id` is supplied explicitly, matching the ehrc-<uuid> convention
  ---
  duration_ms: 0.119917
  type: 'test'
  ...
# Subtest: F14: migration 0024 is additive, idempotent, and targets ONE table
ok 1226 - F14: migration 0024 is additive, idempotent, and targets ONE table
  ---
  duration_ms: 0.43
  type: 'test'
  ...
# Subtest: migration 0023 targets mksap_chunks and never a table called `corpus`
ok 1227 - migration 0023 targets mksap_chunks and never a table called `corpus`
  ---
  duration_ms: 0.3415
  type: 'test'
  ...
# Subtest: 0023 and the runtime DDL agree on lvc_ratifications.promoted_id
ok 1228 - 0023 and the runtime DDL agree on lvc_ratifications.promoted_id
  ---
  duration_ms: 0.498833
  type: 'test'
  ...
# Subtest: 0023 remains a NO-OP on re-run: every statement is guarded, nothing destructive
ok 1229 - 0023 remains a NO-OP on re-run: every statement is guarded, nothing destructive
  ---
  duration_ms: 0.296291
  type: 'test'
  ...
# Subtest: F11: exactly the three honourable probe tools expose `model` and `ceiling`
ok 1230 - F11: exactly the three honourable probe tools expose `model` and `ceiling`
  ---
  duration_ms: 0.056083
  type: 'test'
  ...
# Subtest: F11: the three unwired-route probes have NO model param and SAY why (A4)
ok 1231 - F11: the three unwired-route probes have NO model param and SAY why (A4)
  ---
  duration_ms: 0.05875
  type: 'test'
  ...
# Subtest: F11: the model param resolves all three prefixes and errors loud on unknown
ok 1232 - F11: the model param resolves all three prefixes and errors loud on unknown
  ---
  duration_ms: 0.067208
  type: 'test'
  ...
# Subtest: F11: omitted model ⇒ the local mini, byte-identical, and NOT paid
ok 1233 - F11: omitted model ⇒ the local mini, byte-identical, and NOT paid
  ---
  duration_ms: 0.26225
  type: 'test'
  ...
# Subtest: F11: the paid ceiling stops at N and reports; free runs never count
ok 1234 - F11: the paid ceiling stops at N and reports; free runs never count
  ---
  duration_ms: 0.045209
  type: 'test'
  ...
# Subtest: F11: provider is recorded on lab_analyses alongside the RESOLVED model
ok 1235 - F11: provider is recorded on lab_analyses alongside the RESOLVED model
  ---
  duration_ms: 0.297042
  type: 'test'
  ...
# Subtest: F11: NO route file was touched in this build
ok 1236 - F11: NO route file was touched in this build
  ---
  duration_ms: 0.298917
  type: 'test'
  ...
# Subtest: F11: the engine label is DERIVED from the resolved provider, not hardcoded
ok 1237 - F11: the engine label is DERIVED from the resolved provider, not hardcoded
  ---
  duration_ms: 0.362792
  type: 'test'
  ...
# Subtest: F11: ollama maps back to "mini" so every historical label is preserved exactly
ok 1238 - F11: ollama maps back to "mini" so every historical label is preserved exactly
  ---
  duration_ms: 0.193125
  type: 'test'
  ...
# Subtest: F11: mini_analyze TEXT mode refuses a model rather than accepting and ignoring it
ok 1239 - F11: mini_analyze TEXT mode refuses a model rather than accepting and ignoring it
  ---
  duration_ms: 0.206333
  type: 'test'
  ...
# Subtest: BYTE-IDENTITY (a): with no labModel the gate short-circuits to "no override"
ok 1240 - BYTE-IDENTITY (a): with no labModel the gate short-circuits to "no override"
  ---
  duration_ms: 0.545125
  type: 'test'
  ...
# Subtest: BYTE-IDENTITY (b): labRoutingOpts(null) is {} and the spread changes nothing
ok 1241 - BYTE-IDENTITY (b): labRoutingOpts(null) is {} and the spread changes nothing
  ---
  duration_ms: 0.419166
  type: 'test'
  ...
# Subtest: BYTE-IDENTITY (c): EVERY routing site in EVERY wired route threads ...LAB — none left behind
ok 1242 - BYTE-IDENTITY (c): EVERY routing site in EVERY wired route threads ...LAB — none left behind
  ---
  duration_ms: 1.418167
  type: 'test'
  ...
# Subtest: BYTE-IDENTITY per route: each wired route calls the gate and takes labModel additively
ok 1243 - BYTE-IDENTITY per route: each wired route calls the gate and takes labModel additively
  ---
  duration_ms: 0.237459
  type: 'test'
  ...
# Subtest: the wiring is ADDITIVE: labModel is the only new body field, providerOverride unchanged
ok 1244 - the wiring is ADDITIVE: labModel is the only new body field, providerOverride unchanged
  ---
  duration_ms: 0.074375
  type: 'test'
  ...
# Subtest: every wired route records the RESOLVED model on the trace, never the requested string
ok 1245 - every wired route records the RESOLVED model on the trace, never the requested string
  ---
  duration_ms: 0.074
  type: 'test'
  ...
# Subtest: CONTAINMENT: exactly the two model-string routes are wired; the three forceOllama routes are NOT
ok 1246 - CONTAINMENT: exactly the two model-string routes are wired; the three forceOllama routes are NOT
  ---
  duration_ms: 0.37875
  type: 'test'
  ...
# Subtest: CONTAINMENT: no SIXTH route imports the gate
ok 1247 - CONTAINMENT: no SIXTH route imports the gate
  ---
  duration_ms: 21.244666
  type: 'test'
  ...
# Subtest: selfPostNdjson can now carry the lab-origin header (gate condition 2)
ok 1248 - selfPostNdjson can now carry the lab-origin header (gate condition 2)
  ---
  duration_ms: 0.268083
  type: 'test'
  ...
# Subtest: routing map: vertex→gemini, openrouter clears gemini, ollama forces the mini
ok 1249 - routing map: vertex→gemini, openrouter clears gemini, ollama forces the mini
  ---
  duration_ms: 0.304458
  type: 'test'
  ...
# Subtest: condition 6 probe is deterministic and refuses an unknown provider
ok 1250 - condition 6 probe is deterministic and refuses an unknown provider
  ---
  duration_ms: 0.095667
  type: 'test'
  ...
# Subtest: THE INVARIANT: no model requested ⇒ no override — this is what keeps the five routes byte-identical
ok 1251 - THE INVARIANT: no model requested ⇒ no override — this is what keeps the five routes byte-identical
  ---
  duration_ms: 0.545041
  type: 'test'
  ...
# Subtest: the full pass path honours the override and reports the RESOLVED model
ok 1252 - the full pass path honours the override and reports the RESOLVED model
  ---
  duration_ms: 0.07025
  type: 'test'
  ...
# Subtest: 1 — env flag: absent, unset or anything but "1" ⇒ OFF (the kill switch)
ok 1253 - 1 — env flag: absent, unset or anything but "1" ⇒ OFF (the kill switch)
  ---
  duration_ms: 0.067625
  type: 'test'
  ...
# Subtest: 2 — lab-origin marker: a header, and only the exact value passes
ok 1254 - 2 — lab-origin marker: a header, and only the exact value passes
  ---
  duration_ms: 0.059875
  type: 'test'
  ...
# Subtest: 3 — admin auth must pass on the same request
ok 1255 - 3 — admin auth must pass on the same request
  ---
  duration_ms: 0.046708
  type: 'test'
  ...
# Subtest: 4 — a clinician session REFUSES the override even when 1-3 all pass
ok 1256 - 4 — a clinician session REFUSES the override even when 1-3 all pass
  ---
  duration_ms: 0.101125
  type: 'test'
  ...
# Subtest: 5 — an unknown provider prefix falls through to the production default
ok 1257 - 5 — an unknown provider prefix falls through to the production default
  ---
  duration_ms: 0.0505
  type: 'test'
  ...
# Subtest: 6 — an unreachable model falls through to default, and UNPROBED counts as unreachable
ok 1258 - 6 — an unreachable model falls through to default, and UNPROBED counts as unreachable
  ---
  duration_ms: 0.03925
  type: 'test'
  ...
# Subtest: the gate NEVER throws and NEVER returns an error, whatever it is handed
ok 1259 - the gate NEVER throws and NEVER returns an error, whatever it is handed
  ---
  duration_ms: 0.221416
  type: 'test'
  ...
# Subtest: condition ORDER is the safety property — the kill switch is evaluated first
ok 1260 - condition ORDER is the safety property — the kill switch is evaluated first
  ---
  duration_ms: 0.282291
  type: 'test'
  ...
# Subtest: an honoured override logs route · provider · resolved model · caller (A12)
ok 1261 - an honoured override logs route · provider · resolved model · caller (A12)
  ---
  duration_ms: 0.106542
  type: 'test'
  ...
# Subtest: refusals are logged except the normal no-override path
ok 1262 - refusals are logged except the normal no-override path
  ---
  duration_ms: 0.04925
  type: 'test'
  ...
# Subtest: ollama and vertex both pass the gate when everything else does
ok 1263 - ollama and vertex both pass the gate when everything else does
  ---
  duration_ms: 0.047125
  type: 'test'
  ...
# Subtest: ROUND TRIP: serialise → parse returns a deeply equal package set
ok 1264 - ROUND TRIP: serialise → parse returns a deeply equal package set
  ---
  duration_ms: 1.24275
  type: 'test'
  ...
# Subtest: ROUND TRIP: re-importing an unmodified export yields a ZERO-ROW DIFF
ok 1265 - ROUND TRIP: re-importing an unmodified export yields a ZERO-ROW DIFF
  ---
  duration_ms: 0.327667
  type: 'test'
  ...
# Subtest: ROUND TRIP: the import route refuses to create a version when the diff is empty
ok 1266 - ROUND TRIP: the import route refuses to create a version when the diff is empty
  ---
  duration_ms: 0.114416
  type: 'test'
  ...
# Subtest: ROUND TRIP survives the awkward characters — quotes, commas, semicolons, unicode
ok 1267 - ROUND TRIP survives the awkward characters — quotes, commas, semicolons, unicode
  ---
  duration_ms: 0.150167
  type: 'test'
  ...
# Subtest: ROUND TRIP is stable across CRLF and a BOM (what Excel actually writes)
ok 1268 - ROUND TRIP is stable across CRLF and a BOM (what Excel actually writes)
  ---
  duration_ms: 0.19325
  type: 'test'
  ...
# Subtest: an empty package set round-trips to a header-only file and back
ok 1269 - an empty package set round-trips to a header-only file and back
  ---
  duration_ms: 0.142458
  type: 'test'
  ...
# Subtest: CSV validation rejects each invalid case named in §7.3, and applies nothing
ok 1270 - CSV validation rejects each invalid case named in §7.3, and applies nothing
  ---
  duration_ms: 0.174459
  type: 'test'
  ...
# Subtest: CSV validation rejects an oversize row count and a non-.csv extension
ok 1271 - CSV validation rejects an oversize row count and a non-.csv extension
  ---
  duration_ms: 1.782917
  type: 'test'
  ...
# Subtest: constituents and aliases are trimmed and de-duplicated case-insensitively on ingest
ok 1272 - constituents and aliases are trimmed and de-duplicated case-insensitively on ingest
  ---
  duration_ms: 0.270125
  type: 'test'
  ...
# Subtest: the low-level CSV splitters handle quotes, doubled quotes and embedded newlines
ok 1273 - the low-level CSV splitters handle quotes, doubled quotes and embedded newlines
  ---
  duration_ms: 0.382125
  type: 'test'
  ...
# Subtest: the diff lists REMOVALS explicitly — they can never be inferred from a count alone
ok 1274 - the diff lists REMOVALS explicitly — they can never be inferred from a count alone
  ---
  duration_ms: 0.230541
  type: 'test'
  ...
# Subtest: the diff reports constituent and alias movement per package
ok 1275 - the diff reports constituent and alias movement per package
  ---
  duration_ms: 8.06725
  type: 'test'
  ...
# Subtest: EQUIVALENCE: an empty or malformed package set leaves the judge prompt BYTE-IDENTICAL
ok 1276 - EQUIVALENCE: an empty or malformed package set leaves the judge prompt BYTE-IDENTICAL
  ---
  duration_ms: 0.182667
  type: 'test'
  ...
# Subtest: EQUIVALENCE holds with the other optional context blocks present too
ok 1277 - EQUIVALENCE holds with the other optional context blocks present too
  ---
  duration_ms: 0.138083
  type: 'test'
  ...
# Subtest: a REAL package set adds a factual block and changes nothing else
ok 1278 - a REAL package set adds a factual block and changes nothing else
  ---
  duration_ms: 0.3355
  type: 'test'
  ...
# Subtest: the LVC judge call fails OPEN — a package-context error cannot cost a judgement
ok 1279 - the LVC judge call fails OPEN — a package-context error cannot cost a judgement
  ---
  duration_ms: 0.181791
  type: 'test'
  ...
# Subtest: the applicability rubric itself is UNTOUCHED — this build adds context, not policy
ok 1280 - the applicability rubric itself is UNTOUCHED — this build adds context, not policy
  ---
  duration_ms: 0.137083
  type: 'test'
  ...
# Subtest: parseStoredLabPackages is the ARRAY branch of the divergent weights shape (§12.3)
ok 1281 - parseStoredLabPackages is the ARRAY branch of the divergent weights shape (§12.3)
  ---
  duration_ms: 0.126583
  type: 'test'
  ...
# Subtest: the publish path branches on shape so an array is not hashed against field keys
ok 1282 - the publish path branches on shape so an array is not hashed against field keys
  ---
  duration_ms: 0.261125
  type: 'test'
  ...
# Subtest: the generator de-duplicates the doubled source strings and drops self-references
ok 1283 - the generator de-duplicates the doubled source strings and drops self-references
  ---
  duration_ms: 0.072792
  type: 'test'
  ...
# Subtest: data/lab-packages.json is valid JSON and safe whatever state it is in
ok 1284 - data/lab-packages.json is valid JSON and safe whatever state it is in
  ---
  duration_ms: 0.706583
  type: 'test'
  ...
# Subtest: NULL means UNKNOWN, never zero — the single most important rule here
ok 1285 - NULL means UNKNOWN, never zero — the single most important rule here
  ---
  duration_ms: 0.086375
  type: 'test'
  ...
# Subtest: "None ordered" matches = 0 EXPLICITLY; unknown survives neither filtered view
ok 1286 - "None ordered" matches = 0 EXPLICITLY; unknown survives neither filtered view
  ---
  duration_ms: 0.051958
  type: 'test'
  ...
# Subtest: the lookup merges duplicate prescription rows so ORDERED never loses to a sibling 0
ok 1287 - the lookup merges duplicate prescription rows so ORDERED never loses to a sibling 0
  ---
  duration_ms: 0.106
  type: 'test'
  ...
# Subtest: FAIL-SOFT: an unavailable lookup makes the filter INERT, not empty
ok 1288 - FAIL-SOFT: an unavailable lookup makes the filter INERT, not empty
  ---
  duration_ms: 0.203875
  type: 'test'
  ...
# Subtest: the investigations query uses the VALIDATED, DOUBLE-QUOTED hyphenated table
ok 1289 - the investigations query uses the VALIDATED, DOUBLE-QUOTED hyphenated table
  ---
  duration_ms: 0.212583
  type: 'test'
  ...
# Subtest: the OPD filter control disables itself rather than disappearing when db13 is down
ok 1290 - the OPD filter control disables itself rather than disappearing when db13 is down
  ---
  duration_ms: 0.099084
  type: 'test'
  ...
# Subtest: FIX 0 ACCEPTANCE: 2026-07-25 collapses 532 audit rows to 429 notes
ok 1291 - FIX 0 ACCEPTANCE: 2026-07-25 collapses 532 audit rows to 429 notes
  ---
  duration_ms: 0.694959
  type: 'test'
  ...
# Subtest: FIX 0: numeric version comparison — 0.81.14 beats 0.81.9 (lexicographic gets this wrong)
ok 1292 - FIX 0: numeric version comparison — 0.81.14 beats 0.81.9 (lexicographic gets this wrong)
  ---
  duration_ms: 0.047375
  type: 'test'
  ...
# Subtest: FIX 0: ONE implementation — canonicalByUid and canonicalByDocument are the same function
ok 1293 - FIX 0: ONE implementation — canonicalByUid and canonicalByDocument are the same function
  ---
  duration_ms: 0.153666
  type: 'test'
  ...
# Subtest: FIX 0: the OPD aggregates filter on the canonical set, and now FAIL CLOSED
ok 1294 - FIX 0: the OPD aggregates filter on the canonical set, and now FAIL CLOSED
  ---
  duration_ms: 0.489458
  type: 'test'
  ...
# Subtest: subjectSignature clusters near-verbatim subjects, ignores dose/case/parentheticals
ok 1295 - subjectSignature clusters near-verbatim subjects, ignores dose/case/parentheticals
  ---
  duration_ms: 1.369833
  type: 'test'
  ...
# Subtest: mineRuleCandidates: passes the volume + evidence gates, excludes the rest
ok 1296 - mineRuleCandidates: passes the volume + evidence gates, excludes the rest
  ---
  duration_ms: 0.777625
  type: 'test'
  ...
# Subtest: parseCanonicalMap maps indices → labels, ignores out-of-range
ok 1297 - parseCanonicalMap maps indices → labels, ignores out-of-range
  ---
  duration_ms: 0.118375
  type: 'test'
  ...
# Subtest: canonical label MERGES paraphrases that the deterministic signature would fragment
ok 1298 - canonical label MERGES paraphrases that the deterministic signature would fragment
  ---
  duration_ms: 0.244125
  type: 'test'
  ...
# Subtest: mineHarvestGaps: predominantly-UNCITED practices become harvest topics; well-cited/sparse do not
ok 1299 - mineHarvestGaps: predominantly-UNCITED practices become harvest topics; well-cited/sparse do not
  ---
  duration_ms: 0.564959
  type: 'test'
  ...
# Subtest: mineRuleCandidates: context-dependent → limit; prescribing domain → pharmacy_ams
ok 1300 - mineRuleCandidates: context-dependent → limit; prescribing domain → pharmacy_ams
  ---
  duration_ms: 0.11775
  type: 'test'
  ...
# Subtest: truncateCard: caps + ellipsis at the 140 boundary, collapses whitespace
ok 1301 - truncateCard: caps + ellipsis at the 140 boundary, collapses whitespace
  ---
  duration_ms: 0.063375
  type: 'test'
  ...
# Subtest: mineMissedFlags: same-signature flags cluster; a singleton is its own cluster (≥1 harvests)
ok 1302 - mineMissedFlags: same-signature flags cluster; a singleton is its own cluster (≥1 harvests)
  ---
  duration_ms: 1.234875
  type: 'test'
  ...
# Subtest: mineMissedFlags: citable cluster → deterministic missed_rule draft
ok 1303 - mineMissedFlags: citable cluster → deterministic missed_rule draft
  ---
  duration_ms: 0.704875
  type: 'test'
  ...
# Subtest: mineMissedFlags: uncitable → harvest_topic (evidence over frequency)
ok 1304 - mineMissedFlags: uncitable → harvest_topic (evidence over frequency)
  ---
  duration_ms: 0.327209
  type: 'test'
  ...
# Subtest: mineFalseClusters: ≥3 false/nitpick across ≥2 reviewers AND precision <0.5 → suppression
ok 1305 - mineFalseClusters: ≥3 false/nitpick across ≥2 reviewers AND precision <0.5 → suppression
  ---
  duration_ms: 0.218542
  type: 'test'
  ...
# Subtest: mineFalseClusters: precision ≥0.5 blocks the candidate even at volume
ok 1306 - mineFalseClusters: precision ≥0.5 blocks the candidate even at volume
  ---
  duration_ms: 0.070667
  type: 'test'
  ...
# Subtest: mineFalseClusters: single-reviewer cluster blocked (needs ≥2)
ok 1307 - mineFalseClusters: single-reviewer cluster blocked (needs ≥2)
  ---
  duration_ms: 0.04975
  type: 'test'
  ...
# Subtest: gate constants pinned to normative values (§2.3 + HARVEST-DEMAND-RANK §2.3)
ok 1308 - gate constants pinned to normative values (§2.3 + HARVEST-DEMAND-RANK §2.3)
  ---
  duration_ms: 0.044291
  type: 'test'
  ...
# Subtest: demandRankScore: zero → 0, full saturation → 100
ok 1309 - demandRankScore: zero → 0, full saturation → 100
  ---
  duration_ms: 0.062375
  type: 'test'
  ...
# Subtest: demandRankScore: deficit outweighs volume outweighs breadth at equal magnitude
ok 1310 - demandRankScore: deficit outweighs volume outweighs breadth at equal magnitude
  ---
  duration_ms: 0.081083
  type: 'test'
  ...
# Subtest: demandRankScore: monotone non-decreasing in each term; clamps junk input
ok 1311 - demandRankScore: monotone non-decreasing in each term; clamps junk input
  ---
  duration_ms: 0.067
  type: 'test'
  ...
# Subtest: coverageDeficitOf: 1 − topSim, clamped
ok 1312 - coverageDeficitOf: 1 − topSim, clamped
  ---
  duration_ms: 0.040917
  type: 'test'
  ...
# Subtest: mineHarvestGaps: back-compat — no probe injected → ranks by uncited volume, no demandRank
ok 1313 - mineHarvestGaps: back-compat — no probe injected → ranks by uncited volume, no demandRank
  ---
  duration_ms: 0.215083
  type: 'test'
  ...
# Subtest: mineHarvestGaps: live probe DROPS a covered topic even though citedFrac passed it
ok 1314 - mineHarvestGaps: live probe DROPS a covered topic even though citedFrac passed it
  ---
  duration_ms: 0.823792
  type: 'test'
  ...
# Subtest: mineHarvestGaps: a low-volume/high-deficit cluster outranks a high-volume/partly-covered one
ok 1315 - mineHarvestGaps: a low-volume/high-deficit cluster outranks a high-volume/partly-covered one
  ---
  duration_ms: 0.153333
  type: 'test'
  ...
# Subtest: mineHarvestGaps: unprobed (deferred) clusters survive, unranked — never dropped
ok 1316 - mineHarvestGaps: unprobed (deferred) clusters survive, unranked — never dropped
  ---
  duration_ms: 0.157084
  type: 'test'
  ...
# Subtest: missed rail: ONE uncovered flag yields a demand-ranked harvest candidate
ok 1317 - missed rail: ONE uncovered flag yields a demand-ranked harvest candidate
  ---
  duration_ms: 0.219209
  type: 'test'
  ...
# Subtest: missed rail: ONE flag NEVER yields a rule, however well the corpus covers it
ok 1318 - missed rail: ONE flag NEVER yields a rule, however well the corpus covers it
  ---
  duration_ms: 0.09725
  type: 'test'
  ...
# Subtest: missed rail: ≥2 flags + covered corpus → missed_rule (unchanged bar)
ok 1319 - missed rail: ≥2 flags + covered corpus → missed_rule (unchanged bar)
  ---
  duration_ms: 0.056209
  type: 'test'
  ...
# Subtest: routeAdjudication: suppress → vouch, fix → surfaced-only, accept/defer/monitor → no-op
ok 1320 - routeAdjudication: suppress → vouch, fix → surfaced-only, accept/defer/monitor → no-op
  ---
  duration_ms: 0.048542
  type: 'test'
  ...
# Subtest: adjudicationSignalType: parses the coarse <signal_type>@<engine_version> key
ok 1321 - adjudicationSignalType: parses the coarse <signal_type>@<engine_version> key
  ---
  duration_ms: 0.044458
  type: 'test'
  ...
# Subtest: routeAdjudications: the 6 ratified decisions → 1 vouch, 5 surfaced fixes, 0 harvest
ok 1322 - routeAdjudications: the 6 ratified decisions → 1 vouch, 5 surfaced fixes, 0 harvest
  ---
  duration_ms: 0.129125
  type: 'test'
  ...
# Subtest: routeAdjudications: accept/defer/monitor vouch nothing and surface nothing
ok 1323 - routeAdjudications: accept/defer/monitor vouch nothing and surface nothing
  ---
  duration_ms: 0.041791
  type: 'test'
  ...
# Subtest: suppression vouch: an adjudicated suppress lets a ONE-reviewer cluster propose
ok 1324 - suppression vouch: an adjudicated suppress lets a ONE-reviewer cluster propose
  ---
  duration_ms: 0.198208
  type: 'test'
  ...
# Subtest: suppression vouch: relaxes ONLY the reviewer gate — volume + precision still bind
ok 1325 - suppression vouch: relaxes ONLY the reviewer gate — volume + precision still bind
  ---
  duration_ms: 0.075542
  type: 'test'
  ...
# Subtest: ratio: null on zero denominator, value otherwise
ok 1326 - ratio: null on zero denominator, value otherwise
  ---
  duration_ms: 0.420542
  type: 'test'
  ...
# Subtest: pct: "—" for null, whole-percent otherwise
ok 1327 - pct: "—" for null, whole-percent otherwise
  ---
  duration_ms: 0.083417
  type: 'test'
  ...
# Subtest: buildFlywheel: perDay rounds audits over elapsed days; ≥1 divisor
ok 1328 - buildFlywheel: perDay rounds audits over elapsed days; ≥1 divisor
  ---
  duration_ms: 0.160875
  type: 'test'
  ...
# Subtest: buildFlywheel: attribution + grounded ratios (the two first-ever headline numbers)
ok 1329 - buildFlywheel: attribution + grounded ratios (the two first-ever headline numbers)
  ---
  duration_ms: 0.05275
  type: 'test'
  ...
# Subtest: buildFlywheel: zero corpus denominators → null → "—", never a fake 0%
ok 1330 - buildFlywheel: zero corpus denominators → null → "—", never a fake 0%
  ---
  duration_ms: 0.055416
  type: 'test'
  ...
# Subtest: buildFlywheel: approved list drops zero-count types
ok 1331 - buildFlywheel: approved list drops zero-count types
  ---
  duration_ms: 0.319458
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: T1: defaults are 90000 / 0 / 600000
ok 1332 - T1: defaults are 90000 / 0 / 600000
  ---
  duration_ms: 0.4335
  type: 'test'
  ...
# Subtest: T2: resolvers honour numeric overrides and fall back on garbage
ok 1333 - T2: resolvers honour numeric overrides and fall back on garbage
  ---
  duration_ms: 0.139208
  type: 'test'
  ...
# Subtest: T3: every new OpenAI(...) in lib/llm.ts carries timeout + maxRetries
ok 1334 - T3: every new OpenAI(...) in lib/llm.ts carries timeout + maxRetries
  ---
  duration_ms: 0.21125
  type: 'test'
  ...
# Subtest: T4: the audit call site passes an audit-class ceiling that clears measured latency
ok 1335 - T4: the audit call site passes an audit-class ceiling that clears measured latency
  ---
  duration_ms: 0.727416
  type: 'test'
  ...
# Subtest: T5: timeout fires as a catchable Error after exactly one wire call (maxRetries 0)
ok 1336 - T5: timeout fires as a catchable Error after exactly one wire call (maxRetries 0)
  ---
  duration_ms: 312.383084
  type: 'test'
  ...
# Subtest: priceFor matches flash before pro, and falls back
ok 1337 - priceFor matches flash before pro, and falls back
  ---
  duration_ms: 1.291542
  type: 'test'
  ...
# Subtest: perCallInr computes ₹ from tokens (Pro base tier)
ok 1338 - perCallInr computes ₹ from tokens (Pro base tier)
  ---
  duration_ms: 0.36975
  type: 'test'
  ...
# Subtest: perCallInr applies the >200k Pro high tier
ok 1339 - perCallInr applies the >200k Pro high tier
  ---
  duration_ms: 0.163084
  type: 'test'
  ...
# Subtest: costInr with explicit tier (aggregate path) matches base rate for summed tokens
ok 1340 - costInr with explicit tier (aggregate path) matches base rate for summed tokens
  ---
  duration_ms: 0.116709
  type: 'test'
  ...
# Subtest: fmtInr rounds with Indian grouping; paise for tiny amounts
ok 1341 - fmtInr rounds with Indian grouping; paise for tiny amounts
  ---
  duration_ms: 15.209541
  type: 'test'
  ...
# Subtest: keywordRecall: substring match on normalized haystack; <3-char keywords ignored
ok 1342 - keywordRecall: substring match on normalized haystack; <3-char keywords ignored
  ---
  duration_ms: 0.741083
  type: 'test'
  ...
# Subtest: passesFloor: only "applies" above the surface floor fires (two-tier)
ok 1343 - passesFloor: only "applies" above the surface floor fires (two-tier)
  ---
  duration_ms: 0.106542
  type: 'test'
  ...
# Subtest: assembleFlags: gates, sorts by confidence desc, maps citation
ok 1344 - assembleFlags: gates, sorts by confidence desc, maps citation
  ---
  duration_ms: 0.153958
  type: 'test'
  ...
# Subtest: dedupeById keeps first occurrence across lists
ok 1345 - dedupeById keeps first occurrence across lists
  ---
  duration_ms: 0.082042
  type: 'test'
  ...
# Subtest: identical runs: full agreement, no flips, zero confidence drift
ok 1346 - identical runs: full agreement, no flips, zero confidence drift
  ---
  duration_ms: 0.938792
  type: 'test'
  ...
# Subtest: pairing is by rec id, never by position — reordering is not a flip
ok 1347 - pairing is by rec id, never by position — reordering is not a flip
  ---
  duration_ms: 0.104583
  type: 'test'
  ...
# Subtest: a flip is recorded in the matrix with its direction, and the delta is signed
ok 1348 - a flip is recorded in the matrix with its direction, and the delta is signed
  ---
  duration_ms: 0.151917
  type: 'test'
  ...
# Subtest: a rec present in only one run is unmatched, never silently dropped or counted as a flip
ok 1349 - a rec present in only one run is unmatched, never silently dropped or counted as a flip
  ---
  duration_ms: 0.086916
  type: 'test'
  ...
# Subtest: an empty comparable set is NOT agreement — it is nothing measured
ok 1350 - an empty comparable set is NOT agreement — it is nothing measured
  ---
  duration_ms: 0.127916
  type: 'test'
  ...
# Subtest: summary: percentages are over what actually compared, and the matrix sums across cases
ok 1351 - summary: percentages are over what actually compared, and the matrix sums across cases
  ---
  duration_ms: 0.196375
  type: 'test'
  ...
# Subtest: degenerate input never throws: nulls, missing recs, duplicate ids, non-numeric confidence
ok 1352 - degenerate input never throws: nulls, missing recs, duplicate ids, non-numeric confidence
  ---
  duration_ms: 0.191084
  type: 'test'
  ...
# Subtest: the verdict vocabulary is the judge's own three
ok 1353 - the verdict vocabulary is the judge's own three
  ---
  duration_ms: 0.110084
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [lvc] judge attempt 1/2 attribution UNKNOWN (no model reported by transport or body) — verdict accepted per D-6, not retried
# [lvc] judge attempt 1/2 body_names_other_model: transport 'none', body 'qwen2.5:14b' vs intended 'gemini-2.5-pro'
# [lvc] judge attempt 2/2 body_names_other_model: transport 'none', body 'qwen2.5:14b' vs intended 'gemini-2.5-pro'
# [lvc] judge REFUSED (body_names_other_model): served 'qwen2.5:14b' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 transport_names_other_model: transport 'llama3.1:8b', body 'none' vs intended 'gemini-2.5-pro'
# [lvc] judge attempt 2/2 transport_names_other_model: transport 'llama3.1:8b', body 'none' vs intended 'gemini-2.5-pro'
# [lvc] judge REFUSED (transport_names_other_model): served 'llama3.1:8b' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 transport_body_conflict: transport 'gemini-2.5-pro', body 'llama3.1:8b' vs intended 'gemini-2.5-pro'
# [lvc] judge attempt 2/2 transport_body_conflict: transport 'gemini-2.5-pro', body 'llama3.1:8b' vs intended 'gemini-2.5-pro'
# [lvc] judge REFUSED (transport_body_conflict): served 'gemini-2.5-pro' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 transport_body_conflict: transport 'llama3.1:8b', body 'gemini-2.5-pro' vs intended 'gemini-2.5-pro'
# [lvc] judge attempt 2/2 transport_body_conflict: transport 'llama3.1:8b', body 'gemini-2.5-pro' vs intended 'gemini-2.5-pro'
# [lvc] judge REFUSED (transport_body_conflict): served 'llama3.1:8b' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 failed vertex 403
# [lvc] judge attempt 2/2 failed vertex 403
# [lvc] judge REFUSED (call_failed): served 'none' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 failed transient 429
# [lvc] judge attempt 1/2 transport_body_conflict: transport 'gemini-2.5-pro', body 'llama3.1:8b' vs intended 'gemini-2.5-pro'
# Subtest: 1: empty body model + no transport evidence + valid content → verdict served, ONE call, unknown
ok 1354 - 1: empty body model + no transport evidence + valid content → verdict served, ONE call, unknown
  ---
  duration_ms: 1.89275
  type: 'test'
  ...
# Subtest: 2: transport names the intended Gemini model → ONE call, verified
ok 1355 - 2: transport names the intended Gemini model → ONE call, verified
  ---
  duration_ms: 1.133875
  type: 'test'
  ...
# Subtest: 3: body names a DIFFERENT model → two calls, refusal, every rec insufficient_info, wrong_model
ok 1356 - 3: body names a DIFFERENT model → two calls, refusal, every rec insufficient_info, wrong_model
  ---
  duration_ms: 1.539625
  type: 'test'
  ...
# Subtest: 4: transport names the LOCAL model → wrong_model, the verdict is never accepted
ok 1357 - 4: transport names the LOCAL model → wrong_model, the verdict is never accepted
  ---
  duration_ms: 0.853708
  type: 'test'
  ...
# Subtest: 5: a CONFLICT between the two sources is wrong_model — in BOTH directions
ok 1358 - 5: a CONFLICT between the two sources is wrong_model — in BOTH directions
  ---
  duration_ms: 1.821292
  type: 'test'
  ...
# Subtest: 6: body-only verified — no transport evidence, body names the intended Gemini → verified, ONE call
ok 1359 - 6: body-only verified — no transport evidence, body names the intended Gemini → verified, ONE call
  ---
  duration_ms: 1.044583
  type: 'test'
  ...
# Subtest: 7: a provider THROW retries once then refuses — and stays distinct from unknown
ok 1360 - 7: a provider THROW retries once then refuses — and stays distinct from unknown
  ---
  duration_ms: 0.911417
  type: 'test'
  ...
# Subtest: 7b: a first-attempt throw followed by a verified answer is served — the retry still recovers
ok 1361 - 7b: a first-attempt throw followed by a verified answer is served — the retry still recovers
  ---
  duration_ms: 0.602333
  type: 'test'
  ...
# Subtest: 8: the REAL judge call passes noLocalFallback: true — mechanically, through llmCall
ok 1362 - 8: the REAL judge call passes noLocalFallback: true — mechanically, through llmCall
  ---
  duration_ms: 0.784833
  type: 'test'
  ...
# Subtest: 8b: candidate extraction does NOT pass noLocalFallback — its options object is byte-identical
ok 1363 - 8b: candidate extraction does NOT pass noLocalFallback — its options object is byte-identical
  ---
  duration_ms: 4.725458
  type: 'test'
  ...
# Subtest: 9: attempt + invocation payloads — absent stays null, both sources stay separately visible
ok 1364 - 9: attempt + invocation payloads — absent stays null, both sources stay separately visible
  ---
  duration_ms: 0.779958
  type: 'test'
  ...
# Subtest: 9b: the pure builders — nothing absent is invented, retry_count is 0 on a single attempt
ok 1365 - 9b: the pure builders — nothing absent is invented, retry_count is 0 on a single attempt
  ---
  duration_ms: 0.2625
  type: 'test'
  ...
# Subtest: 9c: a throwing recorder can never cost a verdict
ok 1366 - 9c: a throwing recorder can never cost a verdict
  ---
  duration_ms: 0.428625
  type: 'test'
  ...
# Subtest: 10: resolveJudgeAttribution — every row of the table, exhaustively
ok 1367 - 10: resolveJudgeAttribution — every row of the table, exhaustively
  ---
  duration_ms: 0.617958
  type: 'test'
  ...
# Subtest: transport attribution is a NON-ENUMERABLE property — no existing consumer can see it
ok 1368 - transport attribution is a NON-ENUMERABLE property — no existing consumer can see it
  ---
  duration_ms: 0.236
  type: 'test'
  ...
# Subtest: attaching to a frozen or non-object result never throws — evidence must not cost a call
ok 1369 - attaching to a frozen or non-object result never throws — evidence must not cost a call
  ---
  duration_ms: 0.348291
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [lvc] judge attempt 1/2 body_names_other_model: transport 'none', body 'qwen2.5:14b' vs intended 'gemini-2.5-pro'
# [lvc] judge attempt 2/2 body_names_other_model: transport 'none', body 'qwen2.5:14b' vs intended 'gemini-2.5-pro'
# [lvc] judge REFUSED (body_names_other_model): served 'qwen2.5:14b' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 attribution UNKNOWN (no model reported by transport or body) — verdict accepted per D-6, not retried
# [lvc] judge attempt 1/2 failed vertex 403
# [lvc] judge attempt 2/2 failed vertex 403
# [lvc] judge REFUSED (call_failed): served 'none' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 failed transient 429
# [lvc] judge REFUSED (force_ollama_requested): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# Subtest: D-1: the judge call body carries temperature 0, the fixed seed and top_p 1
ok 1370 - D-1: the judge call body carries temperature 0, the fixed seed and top_p 1
  ---
  duration_ms: 1.815833
  type: 'test'
  ...
# Subtest: D-1: the autoflag surface is pinned identically — one judge, one configuration
ok 1371 - D-1: the autoflag surface is pinned identically — one judge, one configuration
  ---
  duration_ms: 0.229667
  type: 'test'
  ...
# Subtest: D-2: a non-Gemini served model is retried ONCE, then the whole batch refuses
ok 1372 - D-2: a non-Gemini served model is retried ONCE, then the whole batch refuses
  ---
  duration_ms: 0.63575
  type: 'test'
  ...
# Subtest: D-2 → D-6: an EMPTY served model is UNKNOWN attribution, not a failure (see lvc-judge-attribution.test.ts)
ok 1373 - D-2 → D-6: an EMPTY served model is UNKNOWN attribution, not a failure (see lvc-judge-attribution.test.ts)
  ---
  duration_ms: 0.271167
  type: 'test'
  ...
# Subtest: D-2: a throw is retried once and then refuses — no soft-fail to a local answer
ok 1374 - D-2: a throw is retried once and then refuses — no soft-fail to a local answer
  ---
  duration_ms: 0.296375
  type: 'test'
  ...
# Subtest: D-2: a FIRST-attempt failure followed by an agreeing Gemini answer is served normally
ok 1375 - D-2: a FIRST-attempt failure followed by an agreeing Gemini answer is served normally
  ---
  duration_ms: 0.526875
  type: 'test'
  ...
# Subtest: D-2: the publisher prefix is not a disagreement — google/<slug> still serves
ok 1376 - D-2: the publisher prefix is not a disagreement — google/<slug> still serves
  ---
  duration_ms: 0.188875
  type: 'test'
  ...
# Subtest: D-2: forceOllama refuses BEFORE any call — no ollama call may serve a judge verdict
ok 1377 - D-2: forceOllama refuses BEFORE any call — no ollama call may serve a judge verdict
  ---
  duration_ms: 0.174375
  type: 'test'
  ...
# Subtest: D-2: with no Gemini available there is no slug to retry against — immediate refusal
ok 1378 - D-2: with no Gemini available there is no slug to retry against — immediate refusal
  ---
  duration_ms: 0.30775
  type: 'test'
  ...
# Subtest: D-2: the refusal event kind is the one the PRD names
ok 1379 - D-2: the refusal event kind is the one the PRD names
  ---
  duration_ms: 0.266041
  type: 'test'
  ...
# Subtest: §4: valid round tags resolve to themselves
ok 1380 - §4: valid round tags resolve to themselves
  ---
  duration_ms: 0.103666
  type: 'test'
  ...
# Subtest: §4: junk falls back to the r1 default — the route can never write an unfindable tag
ok 1381 - §4: junk falls back to the r1 default — the route can never write an unfindable tag
  ---
  duration_ms: 0.060709
  type: 'test'
  ...
# Subtest: §4: surrounding whitespace is trimmed, not rejected
ok 1382 - §4: surrounding whitespace is trimmed, not rejected
  ---
  duration_ms: 0.033333
  type: 'test'
  ...
# [lvc-wording] CDMSS-LVC-JUDGE-PINNING-PRD-v1.0-10-AUG-2026.md absent (root *.md is gitignored) — the .sql round trip is the anchor here
# Subtest: §3: seven preconditions, two retirements, nine distinct rows
ok 1383 - §3: seven preconditions, two retirements, nine distinct rows
  ---
  duration_ms: 0.846833
  type: 'test'
  ...
# Subtest: §3: the ids are exactly the ones the PRD names
ok 1384 - §3: the ids are exactly the ones the PRD names
  ---
  duration_ms: 0.134041
  type: 'test'
  ...
# Subtest: every shipped precondition round-trips byte-for-byte through the .sql record
ok 1385 - every shipped precondition round-trips byte-for-byte through the .sql record
  ---
  duration_ms: 0.931166
  type: 'test'
  ...
# Subtest: §3.2 round-trips byte-for-byte — the MERGED safety-netting record (D-5a)
ok 1386 - §3.2 round-trips byte-for-byte — the MERGED safety-netting record (D-5a)
  ---
  duration_ms: 0.152375
  type: 'test'
  ...
# Subtest: §3.8 round-trips byte-for-byte — the vitamin-D carve-out (D-5c)
ok 1387 - §3.8 round-trips byte-for-byte — the vitamin-D carve-out (D-5c)
  ---
  duration_ms: 0.979917
  type: 'test'
  ...
# Subtest: when the ratified PRD is present, every text still matches it byte-for-byte
ok 1388 - when the ratified PRD is present, every text still matches it byte-for-byte
  ---
  duration_ms: 0.977167
  type: 'test'
  ...
# Subtest: the .sql record and the shipped constants cannot drift
ok 1389 - the .sql record and the shipped constants cannot drift
  ---
  duration_ms: 0.68525
  type: 'test'
  ...
# Subtest: every shipped precondition encodes the ratified drafting convention
ok 1390 - every shipped precondition encodes the ratified drafting convention
  ---
  duration_ms: 0.399542
  type: 'test'
  ...
# Subtest: first run updates all nine rows and verifies them
ok 1391 - first run updates all nine rows and verifies them
  ---
  duration_ms: 1.563375
  type: 'test'
  ...
# Subtest: IDEMPOTENCE: the second run changes zero rows
ok 1392 - IDEMPOTENCE: the second run changes zero rows
  ---
  duration_ms: 1.439
  type: 'test'
  ...
# Subtest: the readback runs FIRST, so a broken schema writes nothing at all
ok 1393 - the readback runs FIRST, so a broken schema writes nothing at all
  ---
  duration_ms: 0.244208
  type: 'test'
  ...
# Subtest: a dry run reads and plans without writing
ok 1394 - a dry run reads and plans without writing
  ---
  duration_ms: 0.269
  type: 'test'
  ...
# Subtest: a missing id is reported, never silently skipped
ok 1395 - a missing id is reported, never silently skipped
  ---
  duration_ms: 0.221208
  type: 'test'
  ...
# Subtest: a row already carrying the ratified value is left alone even on the first run
ok 1396 - a row already carrying the ratified value is left alone even on the first run
  ---
  duration_ms: 0.230375
  type: 'test'
  ...
# Subtest: sameInstant compares instants, not strings — a Postgres timestamptz still verifies
ok 1397 - sameInstant compares instants, not strings — a Postgres timestamptz still verifies
  ---
  duration_ms: 0.0985
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: §2/§7: LVC params (reasoning present) ⇒ no injected reasoning:{enabled:false}; the caller value survives
ok 1398 - §2/§7: LVC params (reasoning present) ⇒ no injected reasoning:{enabled:false}; the caller value survives
  ---
  duration_ms: 0.659917
  type: 'test'
  ...
# Subtest: §2/§7: a caller with NO reasoning (citation critic / Qwen3) still receives reasoning:{enabled:false}
ok 1399 - §2/§7: a caller with NO reasoning (citation critic / Qwen3) still receives reasoning:{enabled:false}
  ---
  duration_ms: 0.0645
  type: 'test'
  ...
# Subtest: §3/§7: the both-failed error contains BOTH the provider and the Ollama fallback messages
ok 1400 - §3/§7: the both-failed error contains BOTH the provider and the Ollama fallback messages
  ---
  duration_ms: 0.210416
  type: 'test'
  ...
# Subtest: §3/§7: runOllamaFallback returns the fallback result unchanged on success; throws both-failed on error
ok 1401 - §3/§7: runOllamaFallback returns the fallback result unchanged on success; throws both-failed on error
  ---
  duration_ms: 0.293333
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall 9c982be2-535f-4e24-8479-fee8e4b78867
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall 27fcd4ab-1550-4965-941f-dc705b14b4be
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall aa706359-27bc-40de-8e08-6fc669a099a5
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall 1fc0b2ff-5fcf-4803-aaaa-9776c1e4c258
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall 85a83f29-1cbf-45ad-912c-f5974ef15a4d
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall 1c6e5607-23d3-4cbb-adad-e3b19ee53b02
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall c944c06b-8a1c-455b-ab33-765882203d46
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall 3cf4fce3-15aa-4d58-879b-988a8f51bc05
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall 1e29ec26-d83f-4f82-893d-39cced3efa00
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall 8097a799-f6ae-451e-b35a-8bc0f84201d9
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# Subtest: 42 A1 — A/A pass 0 uses DEFAULT recall and declares with role lvc_recall on route lvc_judge_aa
ok 1402 - 42 A1 — A/A pass 0 uses DEFAULT recall and declares with role lvc_recall on route lvc_judge_aa
  ---
  duration_ms: 37.120166
  type: 'test'
  ...
# Subtest: 42 A2 — the PINNED passes declare nothing: one declaration per case, not three
ok 1403 - 42 A2 — the PINNED passes declare nothing: one declaration per case, not three
  ---
  duration_ms: 3.782458
  type: 'test'
  ...
# Subtest: 42 A3 — exactly ONE lvc_recall row per pass-0 recall, not two and not zero
ok 1404 - 42 A3 — exactly ONE lvc_recall row per pass-0 recall, not two and not zero
  ---
  duration_ms: 4.267583
  type: 'test'
  ...
# Subtest: 42 A4 — ONE CONTEXT PER REQUEST: one id across a request, and a different id for the next
ok 1405 - 42 A4 — ONE CONTEXT PER REQUEST: one id across a request, and a different id for the next
  ---
  duration_ms: 18.516875
  type: 'test'
  ...
# Subtest: 42 B5 — the appropriateness route passes unknown_route (SOURCE: its POST cannot be driven here)
ok 1406 - 42 B5 — the appropriateness route passes unknown_route (SOURCE: its POST cannot be driven here)
  ---
  duration_ms: 0.321375
  type: 'test'
  ...
# Subtest: 42 B6 — both right-care probe scripts write nothing (SOURCE: neither can be driven from a test)
ok 1407 - 42 B6 — both right-care probe scripts write nothing (SOURCE: neither can be driven from a test)
  ---
  duration_ms: 0.674458
  type: 'test'
  ...
# Subtest: 42 B7 — the A/A route's existing surface is unchanged (SOURCE: read from the diff, not a request)
ok 1408 - 42 B7 — the A/A route's existing surface is unchanged (SOURCE: read from the diff, not a request)
  ---
  duration_ms: 0.196667
  type: 'test'
  ...
# Subtest: 42 B7b — the context is minted ONCE, in GET, and threaded (SOURCE, alongside A4)
ok 1409 - 42 B7b — the context is minted ONCE, in GET, and threaded (SOURCE, alongside A4)
  ---
  duration_ms: 0.089583
  type: 'test'
  ...
# Subtest: lvc-value defaultRetrieveHits does NOT set useNormativeLeg (no normative frame in the judge prompt)
ok 1410 - lvc-value defaultRetrieveHits does NOT set useNormativeLeg (no normative frame in the judge prompt)
  ---
  duration_ms: 0.461
  type: 'test'
  ...
# Subtest: linked: continued / newly-started / gap classified, provenance on the sides that exist
ok 1411 - linked: continued / newly-started / gap classified, provenance on the sides that exist
  ---
  duration_ms: 11.547792
  type: 'test'
  ...
# Subtest: unlinked: admission-list-only, no reconciliation rows (missing baseline stays visible)
ok 1412 - unlinked: admission-list-only, no reconciliation rows (missing baseline stays visible)
  ---
  duration_ms: 0.535709
  type: 'test'
  ...
# Subtest: linked but no pre-admission OPD meds: still admission-only (no baseline to compare)
ok 1413 - linked but no pre-admission OPD meds: still admission-only (no baseline to compare)
  ---
  duration_ms: 0.427667
  type: 'test'
  ...
# Subtest: flag off: the composition never fires — no admission occurrence is reconciled
ok 1414 - flag off: the composition never fires — no admission occurrence is reconciled
  ---
  duration_ms: 0.376041
  type: 'test'
  ...
# Subtest: med-rec ONLY: the view exposes no problem / allergy continuity field (Gate D scope)
ok 1415 - med-rec ONLY: the view exposes no problem / allergy continuity field (Gate D scope)
  ---
  duration_ms: 0.400334
  type: 'test'
  ...
# Subtest: version
ok 1416 - version
  ---
  duration_ms: 0.548792
  type: 'test'
  ...
# Subtest: resolveProblemLabel: map hit, source-text preference, unknown → neutral
ok 1417 - resolveProblemLabel: map hit, source-text preference, unknown → neutral
  ---
  duration_ms: 0.567417
  type: 'test'
  ...
# Subtest: classifyProblemTier: active/background/historical (recency, recurrence, incidental)
ok 1418 - classifyProblemTier: active/background/historical (recency, recurrence, incidental)
  ---
  duration_ms: 0.323208
  type: 'test'
  ...
# Subtest: flagAbnormalLabs: banding, unit-mismatch = no flag, sex-specific, trend
ok 1419 - flagAbnormalLabs: banding, unit-mismatch = no flag, sex-specific, trend
  ---
  duration_ms: 0.5815
  type: 'test'
  ...
# Subtest: computeCareGaps: abnormal-not-rechecked > 6mo; recent excluded; normal excluded
ok 1420 - computeCareGaps: abnormal-not-rechecked > 6mo; recent excluded; normal excluded
  ---
  duration_ms: 0.295333
  type: 'test'
  ...
# Subtest: computePictureConfidence: Ravali-like → THIN; in-person recent → GOOD
ok 1421 - computePictureConfidence: Ravali-like → THIN; in-person recent → GOOD
  ---
  duration_ms: 0.285792
  type: 'test'
  ...
# Subtest: buildVitalsView: numbers + EWS surfaced when present; honest absence otherwise
ok 1422 - buildVitalsView: numbers + EWS surfaced when present; honest absence otherwise
  ---
  duration_ms: 0.306
  type: 'test'
  ...
# Subtest: buildAttentionFlags: medication conflict + critical lab surface as flags
ok 1423 - buildAttentionFlags: medication conflict + critical lab surface as flags
  ---
  duration_ms: 0.245291
  type: 'test'
  ...
# Subtest: patch/1: canonicalAnalyte tolerant match — real Vit D db name → severe band
ok 1424 - patch/1: canonicalAnalyte tolerant match — real Vit D db name → severe band
  ---
  duration_ms: 0.209
  type: 'test'
  ...
# Subtest: patch/1: real Vit D (8.01 ng/mL) surfaces in labs, gaps AND attention
ok 1425 - patch/1: real Vit D (8.01 ng/mL) surfaces in labs, gaps AND attention
  ---
  duration_ms: 0.402
  type: 'test'
  ...
# Subtest: patch/2: safety-net item is SURFACED (labs) but NOT PROMOTED (no gap, no attention flag)
ok 1426 - patch/2: safety-net item is SURFACED (labs) but NOT PROMOTED (no gap, no attention flag)
  ---
  duration_ms: 0.080375
  type: 'test'
  ...
# Subtest: patch/2: latest source-NORMAL + no range → NOT surfaced (nothing over-flagged)
ok 1427 - patch/2: latest source-NORMAL + no range → NOT surfaced (nothing over-flagged)
  ---
  duration_ms: 0.064334
  type: 'test'
  ...
# Subtest: patch/3: trend de-clutter — stable repeats collapse, differing values surface
ok 1428 - patch/3: trend de-clutter — stable repeats collapse, differing values surface
  ---
  duration_ms: 0.072459
  type: 'test'
  ...
# Subtest: determinism: fns twice → deep-equal
ok 1429 - determinism: fns twice → deep-equal
  ---
  duration_ms: 0.15375
  type: 'test'
  ...
# Subtest: inv1 / stratum4: problem omitted at a later encounter → uncertain_current_status, never resolved
ok 1430 - inv1 / stratum4: problem omitted at a later encounter → uncertain_current_status, never resolved
  ---
  duration_ms: 2.6025
  type: 'test'
  ...
# Subtest: inv1 / stratum3: explicit later resolved → documented_resolved
ok 1431 - inv1 / stratum3: explicit later resolved → documented_resolved
  ---
  duration_ms: 0.166833
  type: 'test'
  ...
# Subtest: inv2: empty memberRef is a hard error (single-member invariant)
ok 1432 - inv2: empty memberRef is a hard error (single-member invariant)
  ---
  duration_ms: 0.117416
  type: 'test'
  ...
# Subtest: inv3: two distinct raws with no dictionary hit stay separate (no fuzzy merge)
ok 1433 - inv3: two distinct raws with no dictionary hit stay separate (no fuzzy merge)
  ---
  duration_ms: 0.240625
  type: 'test'
  ...
# Subtest: inv4 + inv5: every occurrence carries provenance and the derived status keeps its occurrences
ok 1434 - inv4 + inv5: every occurrence carries provenance and the derived status keeps its occurrences
  ---
  duration_ms: 0.176625
  type: 'test'
  ...
# Subtest: inv6 / stratum5: contradictory allergy → reported_allergy AND a safety_critical status_conflict
ok 1435 - inv6 / stratum5: contradictory allergy → reported_allergy AND a safety_critical status_conflict
  ---
  duration_ms: 0.411333
  type: 'test'
  ...
# Subtest: inv7: buildMemberState is reproducible — same evidence + versions → deep-equal
ok 1436 - inv7: buildMemberState is reproducible — same evidence + versions → deep-equal
  ---
  duration_ms: 0.634584
  type: 'test'
  ...
# Subtest: inv7 / stratum13: buildMemberState does not mutate input; corrected evidence → corrected snapshot
ok 1437 - inv7 / stratum13: buildMemberState does not mutate input; corrected evidence → corrected snapshot
  ---
  duration_ms: 0.197834
  type: 'test'
  ...
# Subtest: inv9: version + as-of metadata is mandatory and stamped
ok 1438 - inv9: version + as-of metadata is mandatory and stamped
  ---
  duration_ms: 0.212458
  type: 'test'
  ...
# Subtest: inv10: unresolved concept flows through as data (null id, relation unresolved)
ok 1439 - inv10: unresolved concept flows through as data (null id, relation unresolved)
  ---
  duration_ms: 0.315834
  type: 'test'
  ...
# Subtest: stratum1: persistent chronic (multi-touch, span>1yr, no long gap) → persistent + active
ok 1440 - stratum1: persistent chronic (multi-touch, span>1yr, no long gap) → persistent + active
  ---
  duration_ms: 0.077083
  type: 'test'
  ...
# Subtest: stratum2: recurrent (present → long gap → present) → recurrent [EPISODIC concept]
ok 1441 - stratum2: recurrent (present → long gap → present) → recurrent [EPISODIC concept]
  ---
  duration_ms: 0.066
  type: 'test'
  ...
# Subtest: R1: a chronic concept re-documented ≥2× is persistent regardless of gap length
ok 1442 - R1: a chronic concept re-documented ≥2× is persistent regardless of gap length
  ---
  duration_ms: 0.068333
  type: 'test'
  ...
# Subtest: R1 guard: an episodic concept with dense touches within a year is NOT forced persistent
ok 1443 - R1 guard: an episodic concept with dense touches within a year is NOT forced persistent
  ---
  duration_ms: 0.047708
  type: 'test'
  ...
# Subtest: R2: patient-reported stop then a LATER prescription → status stopped + one medication/temporal_conflict/review (both provenances)
ok 1444 - R2: patient-reported stop then a LATER prescription → status stopped + one medication/temporal_conflict/review (both provenances)
  ---
  duration_ms: 0.152666
  type: 'test'
  ...
# Subtest: R2 guard: prescribe THEN patient-reported stop (no re-script) stays a status_conflict, not temporal
ok 1445 - R2 guard: prescribe THEN patient-reported stop (no re-script) stays a status_conflict, not temporal
  ---
  duration_ms: 0.078042
  type: 'test'
  ...
# Subtest: stratum6: medication prescribed → status prescribed, currentness never inferred to taking
ok 1446 - stratum6: medication prescribed → status prescribed, currentness never inferred to taking
  ---
  duration_ms: 0.0455
  type: 'test'
  ...
# Subtest: stratum7: medication explicitly stopped → status stopped + a medication status_conflict
ok 1447 - stratum7: medication explicitly stopped → status stopped + a medication status_conflict
  ---
  duration_ms: 0.058708
  type: 'test'
  ...
# Subtest: stratum8: broader/narrower wording NOT merged (diabetes vs type-2-diabetes → 2 problems)
ok 1448 - stratum8: broader/narrower wording NOT merged (diabetes vs type-2-diabetes → 2 problems)
  ---
  duration_ms: 0.042667
  type: 'test'
  ...
# Subtest: stratum9: same analyte, different units → one series, unit null, value_conflict Discrepancy
ok 1449 - stratum9: same analyte, different units → one series, unit null, value_conflict Discrepancy
  ---
  duration_ms: 0.074958
  type: 'test'
  ...
# Subtest: stratum10: abnormal→normal investigation series is date-ordered, unit preserved
ok 1450 - stratum10: abnormal→normal investigation series is date-ordered, unit preserved
  ---
  duration_ms: 0.0585
  type: 'test'
  ...
# Subtest: stratum12: two simultaneous conditions → two parallel problems
ok 1451 - stratum12: two simultaneous conditions → two parallel problems
  ---
  duration_ms: 0.085459
  type: 'test'
  ...
# Subtest: stratum14: "rule out PE" is never merged with confirmed PE
ok 1452 - stratum14: "rule out PE" is never merged with confirmed PE
  ---
  duration_ms: 0.056
  type: 'test'
  ...
# Subtest: demographic identity_conflict: sex flip across encounters → review Discrepancy
ok 1453 - demographic identity_conflict: sex flip across encounters → review Discrepancy
  ---
  duration_ms: 0.115542
  type: 'test'
  ...
# Subtest: single occurrence → single_episode course
ok 1454 - single occurrence → single_episode course
  ---
  duration_ms: 0.038875
  type: 'test'
  ...
# Subtest: normal aging does NOT raise an identity_conflict (consistent birth year)
ok 1455 - normal aging does NOT raise an identity_conflict (consistent birth year)
  ---
  duration_ms: 0.038916
  type: 'test'
  ...
# Subtest: assembleEvidence: prescription row → opd EncounterEvidence (meds, denied allergy, icd problem, demographics)
ok 1456 - assembleEvidence: prescription row → opd EncounterEvidence (meds, denied allergy, icd problem, demographics)
  ---
  duration_ms: 1.136583
  type: 'test'
  ...
# Subtest: assembleEvidence: lab rows → lab encounters grouped by booking, investigation points
ok 1457 - assembleEvidence: lab rows → lab encounters grouped by booking, investigation points
  ---
  duration_ms: 0.119959
  type: 'test'
  ...
# Subtest: assembleEvidence → buildMemberState: creatinine series spans both bookings, unit consistent
ok 1458 - assembleEvidence → buildMemberState: creatinine series spans both bookings, unit consistent
  ---
  duration_ms: 1.193167
  type: 'test'
  ...
# Subtest: assembleEvidence: identifier-free — no name/mobile/dob leaks into evidence
ok 1459 - assembleEvidence: identifier-free — no name/mobile/dob leaks into evidence
  ---
  duration_ms: 0.188792
  type: 'test'
  ...
# Subtest: assembleEvidence: diagnosis_icd_codes bare-string arrays — empty elements/arrays skipped
ok 1460 - assembleEvidence: diagnosis_icd_codes bare-string arrays — empty elements/arrays skipped
  ---
  duration_ms: 1.527209
  type: 'test'
  ...
# Subtest: assembleEvidence: malformed / missing rows degrade to empty, never throw
ok 1461 - assembleEvidence: malformed / missing rows degrade to empty, never throw
  ---
  duration_ms: 0.36925
  type: 'test'
  ...
# Subtest: careCallOutcomeToEncounter: stopped+reason → care_call encounter, identifier-free, deterministic
ok 1462 - careCallOutcomeToEncounter: stopped+reason → care_call encounter, identifier-free, deterministic
  ---
  duration_ms: 1.205125
  type: 'test'
  ...
# Subtest: careCallOutcomeToEncounter: complaint resolved → complaintStatuses; empty derived → empty arrays
ok 1463 - careCallOutcomeToEncounter: complaint resolved → complaintStatuses; empty derived → empty arrays
  ---
  duration_ms: 0.236041
  type: 'test'
  ...
# Subtest: Patch B: care-call encounter dated at called_at (fresh observation), not the episode note_date
ok 1464 - Patch B: care-call encounter dated at called_at (fresh observation), not the episode note_date
  ---
  duration_ms: 0.087666
  type: 'test'
  ...
# Subtest: loop closure: opd prescribes X + care_call reports X stopped → frozen buildMemberState currentness = stopped
ok 1465 - loop closure: opd prescribes X + care_call reports X stopped → frozen buildMemberState currentness = stopped
  ---
  duration_ms: 2.030875
  type: 'test'
  ...
# Subtest: loop closure R2: a LATER re-prescription after the patient-reported stop → medication/temporal_conflict/review
ok 1466 - loop closure R2: a LATER re-prescription after the patient-reported stop → medication/temporal_conflict/review
  ---
  duration_ms: 0.472083
  type: 'test'
  ...
# Subtest: gold seed is FROZEN: 20 strata, every case ratified:true, member-bank/1.0
ok 1467 - gold seed is FROZEN: 20 strata, every case ratified:true, member-bank/1.0
  ---
  duration_ms: 0.57075
  type: 'test'
  ...
# Subtest: frozen baseline member-state-baseline/1.0: the seed clears every floor (no breaches)
ok 1468 - frozen baseline member-state-baseline/1.0: the seed clears every floor (no breaches)
  ---
  duration_ms: 3.316583
  type: 'test'
  ...
# Subtest: HARD gates hold for EVERY case: retention/provenance/trust 100%, incorrect-resolution 0
ok 1469 - HARD gates hold for EVERY case: retention/provenance/trust 100%, incorrect-resolution 0
  ---
  duration_ms: 0.558916
  type: 'test'
  ...
# Subtest: EVERY invariant-class case scores zero invariantViolations against the frozen core
ok 1470 - EVERY invariant-class case scores zero invariantViolations against the frozen core
  ---
  duration_ms: 0.433084
  type: 'test'
  ...
# Subtest: S3: explicit resolution → documented_resolved
ok 1471 - S3: explicit resolution → documented_resolved
  ---
  duration_ms: 0.08775
  type: 'test'
  ...
# Subtest: S4: omitted later → uncertain, never resolved
ok 1472 - S4: omitted later → uncertain, never resolved
  ---
  duration_ms: 0.121583
  type: 'test'
  ...
# Subtest: S5: allergy reported dominates denied + safety_critical conflict
ok 1473 - S5: allergy reported dominates denied + safety_critical conflict
  ---
  duration_ms: 0.119084
  type: 'test'
  ...
# Subtest: S6: prescribed, currentness never inferred to taking
ok 1474 - S6: prescribed, currentness never inferred to taking
  ---
  duration_ms: 0.050792
  type: 'test'
  ...
# Subtest: S8: broader/narrower not merged → 2 distinct problems
ok 1475 - S8: broader/narrower not merged → 2 distinct problems
  ---
  duration_ms: 0.218333
  type: 'test'
  ...
# Subtest: S9: mixed units → unit:null + value_conflict
ok 1476 - S9: mixed units → unit:null + value_conflict
  ---
  duration_ms: 0.58025
  type: 'test'
  ...
# Subtest: S12: two simultaneous → 2 parallel problems
ok 1477 - S12: two simultaneous → 2 parallel problems
  ---
  duration_ms: 0.107625
  type: 'test'
  ...
# Subtest: S14: "rule out PE" not merged with confirmed PE
ok 1478 - S14: "rule out PE" not merged with confirmed PE
  ---
  duration_ms: 0.12275
  type: 'test'
  ...
# Subtest: S15: patient complaint resolved → documented_resolved occurrence (explicit, not silence)
ok 1479 - S15: patient complaint resolved → documented_resolved occurrence (explicit, not silence)
  ---
  duration_ms: 0.071166
  type: 'test'
  ...
# Subtest: S16: patient-reported stopped overrides prescription
ok 1480 - S16: patient-reported stopped overrides prescription
  ---
  duration_ms: 0.069709
  type: 'test'
  ...
# Subtest: S17: allergy trust-conflict records BOTH trusts in the Discrepancy detail
ok 1481 - S17: allergy trust-conflict records BOTH trusts in the Discrepancy detail
  ---
  duration_ms: 0.123833
  type: 'test'
  ...
# Subtest: S18: followUps carried, deduped by id, no overlay
ok 1482 - S18: followUps carried, deduped by id, no overlay
  ---
  duration_ms: 0.140333
  type: 'test'
  ...
# Subtest: S20: neutrality — zero patient-reported → empty followUps + 1.0 statuses
ok 1483 - S20: neutrality — zero patient-reported → empty followUps + 1.0 statuses
  ---
  duration_ms: 0.099959
  type: 'test'
  ...
# Subtest: S1: chronic re-documented across years → persistent (R1 chronicity fix)
ok 1484 - S1: chronic re-documented across years → persistent (R1 chronicity fix)
  ---
  duration_ms: 0.07275
  type: 'test'
  ...
# Subtest: S2: episodic present-gap-present → recurrent (unchanged by R1)
ok 1485 - S2: episodic present-gap-present → recurrent (unchanged by R1)
  ---
  duration_ms: 0.056958
  type: 'test'
  ...
# Subtest: S7: explicit stopped reflected in status
ok 1486 - S7: explicit stopped reflected in status
  ---
  duration_ms: 0.055292
  type: 'test'
  ...
# Subtest: S19: keeps stopped after a re-prescription + one medication/temporal_conflict/review (both trusts)
ok 1487 - S19: keeps stopped after a re-prescription + one medication/temporal_conflict/review (both trusts)
  ---
  duration_ms: 0.072041
  type: 'test'
  ...
# Subtest: S13: evidence is not mutated; a corrected copy recomputes to a different snapshot
ok 1488 - S13: evidence is not mutated; a corrected copy recomputes to a different snapshot
  ---
  duration_ms: 0.131917
  type: 'test'
  ...
# Subtest: aggregate over the full seed: retention 1.0, zero invariant violations, zero incorrect resolutions
ok 1489 - aggregate over the full seed: retention 1.0, zero invariant violations, zero incorrect resolutions
  ---
  duration_ms: 2.453417
  type: 'test'
  ...
# Subtest: normalizeConcept: exact hit → relation exact + canonical id
ok 1490 - normalizeConcept: exact hit → relation exact + canonical id
  ---
  duration_ms: 0.92125
  type: 'test'
  ...
# Subtest: normalizeConcept: synonym hit → relation synonym, same canonical id
ok 1491 - normalizeConcept: synonym hit → relation synonym, same canonical id
  ---
  duration_ms: 0.241125
  type: 'test'
  ...
# Subtest: normalizeConcept: no dictionary hit → unresolved (null id), never a guess
ok 1492 - normalizeConcept: no dictionary hit → unresolved (null id), never a guess
  ---
  duration_ms: 0.08
  type: 'test'
  ...
# Subtest: normalizeConcept: broader/narrower are NEVER merged (diabetes ≠ type-2-diabetes)
ok 1493 - normalizeConcept: broader/narrower are NEVER merged (diabetes ≠ type-2-diabetes)
  ---
  duration_ms: 0.128834
  type: 'test'
  ...
# Subtest: normalizeConcept: domain-scoped dictionaries (creatinine only resolves as investigation)
ok 1494 - normalizeConcept: domain-scoped dictionaries (creatinine only resolves as investigation)
  ---
  duration_ms: 0.1855
  type: 'test'
  ...
# Subtest: normalizeConcept: deterministic — same input → identical result
ok 1495 - normalizeConcept: deterministic — same input → identical result
  ---
  duration_ms: 0.386625
  type: 'test'
  ...
# Subtest: groupingKey: resolved → canonical id; two unresolved merge only on identical normalized raw
ok 1496 - groupingKey: resolved → canonical id; two unresolved merge only on identical normalized raw
  ---
  duration_ms: 0.203958
  type: 'test'
  ...
# Subtest: normalizeRaw: lowercases, strips punctuation, collapses whitespace
ok 1497 - normalizeRaw: lowercases, strips punctuation, collapses whitespace
  ---
  duration_ms: 0.049416
  type: 'test'
  ...
# Subtest: complaint resolved → problem documented_resolved (explicit signal)
ok 1498 - complaint resolved → problem documented_resolved (explicit signal)
  ---
  duration_ms: 1.692542
  type: 'test'
  ...
# Subtest: complaint worse → active (never resolved)
ok 1499 - complaint worse → active (never resolved)
  ---
  duration_ms: 0.195291
  type: 'test'
  ...
# Subtest: resolved-then-silent stays resolved (a later unrelated encounter does not re-open it)
ok 1500 - resolved-then-silent stays resolved (a later unrelated encounter does not re-open it)
  ---
  duration_ms: 0.423125
  type: 'test'
  ...
# Subtest: a complaint whose concept matches no documented problem still forms its own problem
ok 1501 - a complaint whose concept matches no documented problem still forms its own problem
  ---
  duration_ms: 0.12175
  type: 'test'
  ...
# Subtest: patient-reported stopped overrides a prescription prescribed
ok 1502 - patient-reported stopped overrides a prescription prescribed
  ---
  duration_ms: 0.476084
  type: 'test'
  ...
# Subtest: patient-reported reported_taking sets taking; currentness not synthesized otherwise
ok 1503 - patient-reported reported_taking sets taking; currentness not synthesized otherwise
  ---
  duration_ms: 0.100042
  type: 'test'
  ...
# Subtest: most-recent patient-reported wins over an older patient-reported
ok 1504 - most-recent patient-reported wins over an older patient-reported
  ---
  duration_ms: 0.122042
  type: 'test'
  ...
# Subtest: stopReason is carried on the occurrence
ok 1505 - stopReason is carried on the occurrence
  ---
  duration_ms: 0.135291
  type: 'test'
  ...
# Subtest: patient_reported denied + structured_db reported_allergy → reported_allergy + safety_critical conflict recording both trusts
ok 1506 - patient_reported denied + structured_db reported_allergy → reported_allergy + safety_critical conflict recording both trusts
  ---
  duration_ms: 0.362417
  type: 'test'
  ...
# Subtest: followUps carried onto the snapshot, deduped by id, date-sorted
ok 1507 - followUps carried onto the snapshot, deduped by id, date-sorted
  ---
  duration_ms: 2.313292
  type: 'test'
  ...
# Subtest: neutrality: no patient-reported evidence → 1.0 behaviour + empty followUps
ok 1508 - neutrality: no patient-reported evidence → 1.0 behaviour + empty followUps
  ---
  duration_ms: 0.26375
  type: 'test'
  ...
# Subtest: version + provenance passthrough
ok 1509 - version + provenance passthrough
  ---
  duration_ms: 0.575792
  type: 'test'
  ...
# Subtest: course: chronic re-documented → Persistent (warn)
ok 1510 - course: chronic re-documented → Persistent (warn)
  ---
  duration_ms: 0.369041
  type: 'test'
  ...
# Subtest: status: an omitted/silent problem renders Uncertain, NEVER Active
ok 1511 - status: an omitted/silent problem renders Uncertain, NEVER Active
  ---
  duration_ms: 0.12175
  type: 'test'
  ...
# Subtest: medication currentness: prescribed carries "not confirmed taken"; stopped → Stopped
ok 1512 - medication currentness: prescribed carries "not confirmed taken"; stopped → Stopped
  ---
  duration_ms: 0.063375
  type: 'test'
  ...
# Subtest: allergy: reported_allergy + matching allergy Discrepancy → conflicted:true, critical
ok 1513 - allergy: reported_allergy + matching allergy Discrepancy → conflicted:true, critical
  ---
  duration_ms: 0.049916
  type: 'test'
  ...
# Subtest: series: two-point HbA1c → direction down; mixed-unit creatinine → mixedUnits true
ok 1514 - series: two-point HbA1c → direction down; mixed-unit creatinine → mixedUnits true
  ---
  duration_ms: 0.050209
  type: 'test'
  ...
# Subtest: conflicts sorted safety_critical → review → informational; counts.safetyCritical
ok 1515 - conflicts sorted safety_critical → review → informational; counts.safetyCritical
  ---
  duration_ms: 0.125541
  type: 'test'
  ...
# Subtest: counts reflect the view arrays
ok 1516 - counts reflect the view arrays
  ---
  duration_ms: 0.039125
  type: 'test'
  ...
# Subtest: Patch A: view dates render as YYYY-MM-DD (dayOnly, idempotent on already-day strings)
ok 1517 - Patch A: view dates render as YYYY-MM-DD (dayOnly, idempotent on already-day strings)
  ---
  duration_ms: 0.629958
  type: 'test'
  ...
# Subtest: presentMemberState is deterministic (twice → deep-equal)
ok 1518 - presentMemberState is deterministic (twice → deep-equal)
  ---
  duration_ms: 1.183375
  type: 'test'
  ...
# Subtest: version constants are the Stage-0 pinned triple
ok 1519 - version constants are the Stage-0 pinned triple
  ---
  duration_ms: 0.362042
  type: 'test'
  ...
# Subtest: emptyMemberStateSnapshot: passed-in computedAt/asOf, empty arrays, passes zod
ok 1520 - emptyMemberStateSnapshot: passed-in computedAt/asOf, empty arrays, passes zod
  ---
  duration_ms: 3.264334
  type: 'test'
  ...
# Subtest: a built snapshot validates against the zod schema
ok 1521 - a built snapshot validates against the zod schema
  ---
  duration_ms: 4.148083
  type: 'test'
  ...
# Subtest: version constant
ok 1522 - version constant
  ---
  duration_ms: 0.662
  type: 'test'
  ...
# Subtest: retention/provenance/trust-provenance = 1.0 on well-formed input
ok 1523 - retention/provenance/trust-provenance = 1.0 on well-formed input
  ---
  duration_ms: 1.738417
  type: 'test'
  ...
# Subtest: falseMerges=1 when two distinct expected concepts collapse (synonyms merge)
ok 1524 - falseMerges=1 when two distinct expected concepts collapse (synonyms merge)
  ---
  duration_ms: 0.128167
  type: 'test'
  ...
# Subtest: falseSplits=1 when one expected concept becomes two entities
ok 1525 - falseSplits=1 when one expected concept becomes two entities
  ---
  duration_ms: 0.180666
  type: 'test'
  ...
# Subtest: conflictRecall [1,1] on a seeded allergy conflict
ok 1526 - conflictRecall [1,1] on a seeded allergy conflict
  ---
  duration_ms: 0.589667
  type: 'test'
  ...
# Subtest: problemCourseAgree [1,1] on a correctly-scored course
ok 1527 - problemCourseAgree [1,1] on a correctly-scored course
  ---
  duration_ms: 0.25775
  type: 'test'
  ...
# Subtest: incorrectResolutions=1 for a documented_resolved occurrence with no explicit basis
ok 1528 - incorrectResolutions=1 for a documented_resolved occurrence with no explicit basis
  ---
  duration_ms: 0.713834
  type: 'test'
  ...
# Subtest: scoreCase is deterministic (twice → deep-equal)
ok 1529 - scoreCase is deterministic (twice → deep-equal)
  ---
  duration_ms: 0.445416
  type: 'test'
  ...
# Subtest: aggregate rolls up the Part-C metric set
ok 1530 - aggregate rolls up the Part-C metric set
  ---
  duration_ms: 0.869
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: prescriptionsSql is byte-identical to shadow.mjs (drift fails CI)
ok 1531 - prescriptionsSql is byte-identical to shadow.mjs (drift fails CI)
  ---
  duration_ms: 1.105083
  type: 'test'
  ...
# Subtest: labsSql is byte-identical to shadow.mjs (drift fails CI)
ok 1532 - labsSql is byte-identical to shadow.mjs (drift fails CI)
  ---
  duration_ms: 0.237875
  type: 'test'
  ...
# Subtest: individualForPrescSql: pinned shape + injection guard (bad uid throws)
ok 1533 - individualForPrescSql: pinned shape + injection guard (bad uid throws)
  ---
  duration_ms: 0.486542
  type: 'test'
  ...
# Subtest: individualUidForPresc: a bad uid returns null WITHOUT touching the DB
ok 1534 - individualUidForPresc: a bad uid returns null WITHOUT touching the DB
  ---
  duration_ms: 0.106833
  type: 'test'
  ...
# Subtest: vitalsEver true → GREEN with the unchanged label, whatever the modality
ok 1535 - vitalsEver true → GREEN with the unchanged label, whatever the modality
  ---
  duration_ms: 1.0375
  type: 'test'
  ...
# Subtest: vitalsEver false + majority unknown → AMBER, with the new label
ok 1536 - vitalsEver false + majority unknown → AMBER, with the new label
  ---
  duration_ms: 0.128083
  type: 'test'
  ...
# Subtest: vitalsEver false + majority remote + inPerson 0 → RED, label BYTE-IDENTICAL to today
ok 1537 - vitalsEver false + majority remote + inPerson 0 → RED, label BYTE-IDENTICAL to today
  ---
  duration_ms: 0.1185
  type: 'test'
  ...
# Subtest: vitalsEver false + inPerson > 0 → AMBER, label BYTE-IDENTICAL to today
ok 1538 - vitalsEver false + inPerson > 0 → AMBER, label BYTE-IDENTICAL to today
  ---
  duration_ms: 0.05775
  type: 'test'
  ...
# Subtest: the no-visits variant of the old label is preserved (opd 0 ⇒ no count suffix)
ok 1539 - the no-visits variant of the old label is preserved (opd 0 ⇒ no count suffix)
  ---
  duration_ms: 0.055708
  type: 'test'
  ...
# Subtest: the vitals factor stays counted: true in every case
ok 1540 - the vitals factor stays counted: true in every case
  ---
  duration_ms: 0.2385
  type: 'test'
  ...
# Subtest: the MODALITY factor is unaffected in all four cases — this build did not touch it
ok 1541 - the MODALITY factor is unaffected in all four cases — this build did not touch it
  ---
  duration_ms: 0.100917
  type: 'test'
  ...
# Subtest: the contact and labs factors are unaffected
ok 1542 - the contact and labs factors are unaffected
  ---
  duration_ms: 0.721791
  type: 'test'
  ...
# Subtest: the unknown case is reachable through the OR, and remote is not
ok 1543 - the unknown case is reachable through the OR, and remote is not
  ---
  duration_ms: 7.008208
  type: 'test'
  ...
# Subtest: D-B case 1 — ALL rows documented: the ladder is unchanged
ok 1544 - D-B case 1 — ALL rows documented: the ladder is unchanged
  ---
  duration_ms: 0.641792
  type: 'test'
  ...
# Subtest: D-B case 2 — NO rows documented with total > 0 ⇒ majority unknown
ok 1545 - D-B case 2 — NO rows documented with total > 0 ⇒ majority unknown
  ---
  duration_ms: 0.089875
  type: 'test'
  ...
# Subtest: D-B case 3 — total === 0 still returns unknown, as it always did
ok 1546 - D-B case 3 — total === 0 still returns unknown, as it always did
  ---
  duration_ms: 0.108167
  type: 'test'
  ...
# Subtest: picture confidence: unknown is AMBER, still counted, with the exact label
ok 1547 - picture confidence: unknown is AMBER, still counted, with the exact label
  ---
  duration_ms: 0.344791
  type: 'test'
  ...
# Subtest: picture confidence: in_person, mixed and remote branches are byte-identical
ok 1548 - picture confidence: in_person, mixed and remote branches are byte-identical
  ---
  duration_ms: 0.180375
  type: 'test'
  ...
# Subtest: buildVitalsView: unknown gets the exact note; the other branch is unchanged
ok 1549 - buildVitalsView: unknown gets the exact note; the other branch is unchanged
  ---
  duration_ms: 0.120292
  type: 'test'
  ...
# Subtest: the call-context sentence no longer claims remote care when the modality is unknown
ok 1550 - the call-context sentence no longer claims remote care when the modality is unknown
  ---
  duration_ms: 0.273
  type: 'test'
  ...
# Subtest: THE JOIN KEY: consult_uid is matched FIRST, prescription_uid is the fallback
ok 1551 - THE JOIN KEY: consult_uid is matched FIRST, prescription_uid is the fallback
  ---
  duration_ms: 0.057292
  type: 'test'
  ...
# Subtest: the vitals SELECT now carries consult_uid, and fetchRows exposes it
ok 1552 - the vitals SELECT now carries consult_uid, and fetchRows exposes it
  ---
  duration_ms: 0.194792
  type: 'test'
  ...
# Subtest: the resolver copies individualUidForPresc: isUid guard, LIMIT 1, soft-fail
ok 1553 - the resolver copies individualUidForPresc: isUid guard, LIMIT 1, soft-fail
  ---
  duration_ms: 0.5025
  type: 'test'
  ...
# Subtest: readEncounterVitals still never throws, and readMemberVitals is untouched
ok 1554 - readEncounterVitals still never throws, and readMemberVitals is untouched
  ---
  duration_ms: 0.100708
  type: 'test'
  ...
# Subtest: Gate D · no regression: every ratified gold case is byte-identical flag-on vs flag-off
ok 1555 - Gate D · no regression: every ratified gold case is byte-identical flag-on vs flag-off
  ---
  duration_ms: 2.818917
  type: 'test'
  ...
# Subtest: Gate D · additive-only: composing an admission preserves every baseline occurrence, all deltas admission-anchored
ok 1556 - Gate D · additive-only: composing an admission preserves every baseline occurrence, all deltas admission-anchored
  ---
  duration_ms: 1.187292
  type: 'test'
  ...
# Subtest: Gate D · flag-off: the fixture is byte-identical to the frozen spine (composition does not fire)
ok 1557 - Gate D · flag-off: the fixture is byte-identical to the frozen spine (composition does not fire)
  ---
  duration_ms: 0.149459
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: every relation has a ratified status, and every ratified status has a relation
ok 1558 - every relation has a ratified status, and every ratified status has a relation
  ---
  duration_ms: 0.841917
  type: 'test'
  ...
# Subtest: no relation THREW — a crash is never a legitimate relation outcome
ok 1559 - no relation THREW — a crash is never a legitimate relation outcome
  ---
  duration_ms: 0.143958
  type: 'test'
  ...
# Subtest: D-1 Dose context is read — holds
ok 1560 - D-1 Dose context is read — holds
  ---
  duration_ms: 0.051375
  type: 'test'
  ...
# Subtest: D-2 Dose context, inverse — holds
ok 1561 - D-2 Dose context, inverse — holds
  ---
  duration_ms: 0.030375
  type: 'test'
  ...
# Subtest: D-3 SOS cap is applied — holds
ok 1562 - D-3 SOS cap is applied — holds
  ---
  duration_ms: 0.035292
  type: 'test'
  ...
# Subtest: D-4 Dose completeness — holds
ok 1563 - D-4 Dose completeness — holds
  ---
  duration_ms: 0.029416
  type: 'test'
  ...
# Subtest: D-5 Formulation is read — reproduces the observed defect (pinned)
ok 1564 - D-5 Formulation is read — reproduces the observed defect (pinned)
  ---
  duration_ms: 0.027583
  type: 'test'
  ...
# Subtest: D-6 Interaction needs both members — holds
ok 1565 - D-6 Interaction needs both members — holds
  ---
  duration_ms: 0.121792
  type: 'test'
  ...
# Subtest: D-7 Interaction ignores non-analgesic dose — holds
ok 1566 - D-7 Interaction ignores non-analgesic dose — holds
  ---
  duration_ms: 0.199333
  type: 'test'
  ...
# Subtest: G-1 Order independence — holds
ok 1567 - G-1 Order independence — holds
  ---
  duration_ms: 0.258833
  type: 'test'
  ...
# Subtest: G-2 Unrelated addition — holds
ok 1568 - G-2 Unrelated addition — holds
  ---
  duration_ms: 0.037916
  type: 'test'
  ...
# Subtest: G-3 Empty-field safety — holds
ok 1569 - G-3 Empty-field safety — holds
  ---
  duration_ms: 0.027041
  type: 'test'
  ...
# Subtest: G-4 Unit invariance — holds
ok 1570 - G-4 Unit invariance — holds
  ---
  duration_ms: 0.023083
  type: 'test'
  ...
# Subtest: G-5 Duplicate line — holds
ok 1571 - G-5 Duplicate line — holds
  ---
  duration_ms: 0.022042
  type: 'test'
  ...
# Subtest: G-6 Teleconsult context — holds
ok 1572 - G-6 Teleconsult context — holds
  ---
  duration_ms: 0.023958
  type: 'test'
  ...
# Subtest: G-7 Referral handoff — holds
ok 1573 - G-7 Referral handoff — holds
  ---
  duration_ms: 0.060125
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: removes: base HAS the state, transformed does NOT → HOLDS
ok 1574 - removes: base HAS the state, transformed does NOT → HOLDS
  ---
  duration_ms: 0.648917
  type: 'test'
  ...
# Subtest: removes: base HAS the state, transformed STILL has it → FAILS
ok 1575 - removes: base HAS the state, transformed STILL has it → FAILS
  ---
  duration_ms: 0.075875
  type: 'test'
  ...
# Subtest: removes: base LACKS the state → VACUOUS, with today's exact reason string
ok 1576 - removes: base LACKS the state → VACUOUS, with today's exact reason string
  ---
  duration_ms: 0.067125
  type: 'test'
  ...
# Subtest: adds: base LACKS the state, transformed HAS it → HOLDS
ok 1577 - adds: base LACKS the state, transformed HAS it → HOLDS
  ---
  duration_ms: 0.054041
  type: 'test'
  ...
# Subtest: adds: base LACKS the state, transformed ALSO lacks it → FAILS
ok 1578 - adds: base LACKS the state, transformed ALSO lacks it → FAILS
  ---
  duration_ms: 0.047709
  type: 'test'
  ...
# Subtest: adds: base ALREADY fires → VACUOUS with the new reason, and NEVER HOLDS
ok 1579 - adds: base ALREADY fires → VACUOUS with the new reason, and NEVER HOLDS
  ---
  duration_ms: 0.064042
  type: 'test'
  ...
# Subtest: L-1 fires on a finding naming the antibiotic
ok 1580 - L-1 fires on a finding naming the antibiotic
  ---
  duration_ms: 0.219667
  type: 'test'
  ...
# Subtest: L-1 does NOT fire on a finding whose only match is the word cellulitis — the original defect
ok 1581 - L-1 does NOT fire on a finding whose only match is the word cellulitis — the original defect
  ---
  duration_ms: 0.09675
  type: 'test'
  ...
# Subtest: L-1 ignores informational findings and praise
ok 1582 - L-1 ignores informational findings and praise
  ---
  duration_ms: 0.199625
  type: 'test'
  ...
# Subtest: L-1: ONLY the symptom line and the diagnosis text change between the arms
ok 1583 - L-1: ONLY the symptom line and the diagnosis text change between the arms
  ---
  duration_ms: 3.594917
  type: 'test'
  ...
# Subtest: L-2: the DRUGS stay and the REASON goes
ok 1584 - L-2: the DRUGS stay and the REASON goes
  ---
  duration_ms: 0.322208
  type: 'test'
  ...
# Subtest: L-2: the referral the old fixture rested on is GONE from both arms
ok 1585 - L-2: the referral the old fixture rested on is GONE from both arms
  ---
  duration_ms: 0.327291
  type: 'test'
  ...
# Subtest: L-3: the base earns praise through a named drug, and the transformation is untouched
ok 1586 - L-3: the base earns praise through a named drug, and the transformation is untouched
  ---
  duration_ms: 0.126791
  type: 'test'
  ...
# Subtest: every relation carries an active flag, and it is a boolean
ok 1587 - every relation carries an active flag, and it is a boolean
  ---
  duration_ms: 0.040667
  type: 'test'
  ...
# Subtest: EXACTLY ONE relation is active — L-1; L-2 and L-3 are retired
ok 1588 - EXACTLY ONE relation is active — L-1; L-2 and L-3 are retired
  ---
  duration_ms: 0.039958
  type: 'test'
  ...
# Subtest: RETIRED IS NOT DELETED — both objects stay complete and usable as fixtures
ok 1589 - RETIRED IS NOT DELETED — both objects stay complete and usable as fixtures
  ---
  duration_ms: 0.1945
  type: 'test'
  ...
# Subtest: the runner and the panel both filter on active — retired relations are skipped, not shown
ok 1590 - the runner and the panel both filter on active — retired relations are skipped, not shown
  ---
  duration_ms: 0.401458
  type: 'test'
  ...
# Subtest: the panel states the leg's scope and the retirement, without overclaiming
ok 1591 - the panel states the leg's scope and the retirement, without overclaiming
  ---
  duration_ms: 0.286875
  type: 'test'
  ...
# Subtest: every relation in PART_C_RELATIONS carries a direction, and it is one of the two
ok 1592 - every relation in PART_C_RELATIONS carries a direction, and it is one of the two
  ---
  duration_ms: 0.073666
  type: 'test'
  ...
# Subtest: ids, experiment names and titles are preserved — the lab history must stay joinable
ok 1593 - ids, experiment names and titles are preserved — the lab history must stay joinable
  ---
  duration_ms: 0.139416
  type: 'test'
  ...
# Subtest: the generalising tests still cover ALL THREE relations, active or retired
ok 1594 - the generalising tests still cover ALL THREE relations, active or retired
  ---
  duration_ms: 0.047917
  type: 'test'
  ...
# Subtest: every fixture is synthetic — no db13 uid may reach the lab runner (§9.3)
ok 1595 - every fixture is synthetic — no db13 uid may reach the lab runner (§9.3)
  ---
  duration_ms: 0.081333
  type: 'test'
  ...
# Subtest: no relation throws on its own transform, and both arms stay well-formed rows
ok 1596 - no relation throws on its own transform, and both arms stay well-formed rows
  ---
  duration_ms: 0.226625
  type: 'test'
  ...
# Subtest: every statement the route runs is in the .sql, and every statement in the .sql is run
ok 1597 - every statement the route runs is in the .sql, and every statement in the .sql is run
  ---
  duration_ms: 3.914292
  type: 'test'
  ...
# Subtest: the parity comparison cannot pass vacuously
ok 1598 - the parity comparison cannot pass vacuously
  ---
  duration_ms: 2.249834
  type: 'test'
  ...
# Subtest: every CHECK value in the route is in the .sql, and the reverse
ok 1599 - every CHECK value in the route is in the .sql, and the reverse
  ---
  duration_ms: 2.475125
  type: 'test'
  ...
# Subtest: the value lists are GENERATED, never hand-typed into the route
ok 1600 - the value lists are GENERATED, never hand-typed into the route
  ---
  duration_ms: 0.183791
  type: 'test'
  ...
# Subtest: the retrieval_role CHECK is generated from RETRIEVAL_ROLES and rejects an unknown role
ok 1601 - the retrieval_role CHECK is generated from RETRIEVAL_ROLES and rejects an unknown role
  ---
  duration_ms: 0.20625
  type: 'test'
  ...
# Subtest: the conditional NOT NULL is the ONE allowed difference, and the .sql states the rule
ok 1602 - the conditional NOT NULL is the ONE allowed difference, and the .sql states the rule
  ---
  duration_ms: 0.475667
  type: 'test'
  ...
# Subtest: every statement is idempotent, and each ADD CONSTRAINT is preceded by its own DROP
ok 1603 - every statement is idempotent, and each ADD CONSTRAINT is preceded by its own DROP
  ---
  duration_ms: 0.415208
  type: 'test'
  ...
# Subtest: the index count in the .sql is the real total
ok 1604 - the index count in the .sql is the real total
  ---
  duration_ms: 0.567958
  type: 'test'
  ...
# Subtest: each table comment is written for its own table, not pasted three times
ok 1605 - each table comment is written for its own table, not pasted three times
  ---
  duration_ms: 0.370458
  type: 'test'
  ...
# Subtest: the route halts, changes nothing and reports counts when the table exists with rows
ok 1606 - the route halts, changes nothing and reports counts when the table exists with rows
  ---
  duration_ms: 0.369708
  type: 'test'
  ...
# Subtest: the outcome CHECK partitions the states, and the .sql says so where it cannot branch
ok 1607 - the outcome CHECK partitions the states, and the .sql says so where it cannot branch
  ---
  duration_ms: 0.148625
  type: 'test'
  ...
# Subtest: the mirror names the route, and the route names the mirror
ok 1608 - the mirror names the route, and the route names the mirror
  ---
  duration_ms: 0.208708
  type: 'test'
  ...
# Subtest: D1 FIRST: the rendered prompt contains NO human label, reviewer name, or triage field
ok 1609 - D1 FIRST: the rendered prompt contains NO human label, reviewer name, or triage field
  ---
  duration_ms: 0.667625
  type: 'test'
  ...
# Subtest: D1 structural: the renderer accepts ONLY the finding + note context — no third argument
ok 1610 - D1 structural: the renderer accepts ONLY the finding + note context — no third argument
  ---
  duration_ms: 0.204833
  type: 'test'
  ...
# Subtest: D2: the model sees what a reviewer sees — all six finding fields plus the note context
ok 1611 - D2: the model sees what a reviewer sees — all six finding fields plus the note context
  ---
  duration_ms: 0.071584
  type: 'test'
  ...
# Subtest: the rubric uses the reviewer surface's own definitions, verbatim
ok 1612 - the rubric uses the reviewer surface's own definitions, verbatim
  ---
  duration_ms: 0.043292
  type: 'test'
  ...
# Subtest: the parser accepts exactly the three classes
ok 1613 - the parser accepts exactly the three classes
  ---
  duration_ms: 0.392334
  type: 'test'
  ...
# Subtest: anything outside the three classes is `unparseable` and COUNTED — never coerced
ok 1614 - anything outside the three classes is `unparseable` and COUNTED — never coerced
  ---
  duration_ms: 0.132958
  type: 'test'
  ...
# Subtest: cohenKappa: perfect agreement 1, computed example exact, degenerate cases total
ok 1615 - cohenKappa: perfect agreement 1, computed example exact, degenerate cases total
  ---
  duration_ms: 0.20725
  type: 'test'
  ...
# Subtest: D5: contested rows are EXCLUDED from κ and every rate, but present and described
ok 1616 - D5: contested rows are EXCLUDED from κ and every rate, but present and described
  ---
  duration_ms: 1.9755
  type: 'test'
  ...
# Subtest: unparseable is a COUNTED outcome: disagreement, never dropped, never coerced
ok 1617 - unparseable is a COUNTED outcome: disagreement, never dropped, never coerced
  ---
  duration_ms: 0.350375
  type: 'test'
  ...
# Subtest: κ by engine version partitions the scored set
ok 1618 - κ by engine version partitions the scored set
  ---
  duration_ms: 0.447083
  type: 'test'
  ...
# Subtest: self-agreement is its own readout, and the kill-condition comparison is computed
ok 1619 - self-agreement is its own readout, and the kill-condition comparison is computed
  ---
  duration_ms: 0.103791
  type: 'test'
  ...
# Subtest: per-class precision/recall come from the pooled confusion matrix
ok 1620 - per-class precision/recall come from the pooled confusion matrix
  ---
  duration_ms: 0.138792
  type: 'test'
  ...
# Subtest: planTrial: 778 scored + 39 contested ⇒ 1,634 planned calls, under the cap
ok 1621 - planTrial: 778 scored + 39 contested ⇒ 1,634 planned calls, under the cap
  ---
  duration_ms: 0.055333
  type: 'test'
  ...
# Subtest: planTrial REFUSES over the cap — before the first call, not after
ok 1622 - planTrial REFUSES over the cap — before the first call, not after
  ---
  duration_ms: 0.117417
  type: 'test'
  ...
# Subtest: prompt version is pinned and single-sourced
ok 1623 - prompt version is pinned and single-sourced
  ---
  duration_ms: 0.058584
  type: 'test'
  ...
# Subtest: no write path to opd_audit_feedback exists anywhere in the trial code
ok 1624 - no write path to opd_audit_feedback exists anywhere in the trial code
  ---
  duration_ms: 0.69975
  type: 'test'
  ...
# Subtest: label_source shape is the ruling's, and the id comes from the RESPONSE
ok 1625 - label_source shape is the ruling's, and the id comes from the RESPONSE
  ---
  duration_ms: 0.161625
  type: 'test'
  ...
# Subtest: C1: dedup is one-row-per-key, LATEST artefact wins — a re-run supersedes its failures
ok 1626 - C1: dedup is one-row-per-key, LATEST artefact wins — a re-run supersedes its failures
  ---
  duration_ms: 18.381292
  type: 'test'
  ...
# Subtest: §4: cross-invocation agreement is its own figure and ignores unresolved invocations
ok 1627 - §4: cross-invocation agreement is its own figure and ignores unresolved invocations
  ---
  duration_ms: 2.330708
  type: 'test'
  ...
# Subtest: C3: the route accepts a keyed top-up that bypasses the offset plan gate but not the auth
ok 1628 - C3: the route accepts a keyed top-up that bypasses the offset plan gate but not the auth
  ---
  duration_ms: 0.521708
  type: 'test'
  ...
# Subtest: C2: the summary reports distinct keys vs the set WITH the missing-key list and the dedup rule
ok 1629 - C2: the summary reports distinct keys vs the set WITH the missing-key list and the dedup rule
  ---
  duration_ms: 0.178042
  type: 'test'
  ...
# Subtest: applyCohort: frozen labels win, extras separated, missing listed, revisions counted
ok 1630 - applyCohort: frozen labels win, extras separated, missing listed, revisions counted
  ---
  duration_ms: 1.900916
  type: 'test'
  ...
# Subtest: the cohort is immutable and the summary carries cohortId beside the metrics
ok 1631 - the cohort is immutable and the summary carries cohortId beside the metrics
  ---
  duration_ms: 0.194625
  type: 'test'
  ...
# Subtest: pre-freeze (version absent): four model-side meters armed, value null, armed label
ok 1632 - pre-freeze (version absent): four model-side meters armed, value null, armed label
  ---
  duration_ms: 0.481375
  type: 'test'
  ...
# Subtest: pre-freeze: reviewer cadence ALWAYS live (never armed, never faked)
ok 1633 - pre-freeze: reviewer cadence ALWAYS live (never armed, never faked)
  ---
  duration_ms: 0.117292
  type: 'test'
  ...
# Subtest: post-freeze: model-side meters unarm and carry real values + fill
ok 1634 - post-freeze: model-side meters unarm and carry real values + fill
  ---
  duration_ms: 0.068792
  type: 'test'
  ...
# Subtest: meters returned in mockup order
ok 1635 - meters returned in mockup order
  ---
  duration_ms: 0.311042
  type: 'test'
  ...
# Subtest: fill clamps to [0,1] even when value exceeds target
ok 1636 - fill clamps to [0,1] even when value exceeds target
  ---
  duration_ms: 0.058042
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: bm25_rank surviving from a later variant is preserved (the exact bug being fixed)
ok 1637 - bm25_rank surviving from a later variant is preserved (the exact bug being fixed)
  ---
  duration_ms: 0.931083
  type: 'test'
  ...
# Subtest: bm25_variant_ranks aligns to variants and is null where the chunk did not arrive via that BM25 leg
ok 1638 - bm25_variant_ranks aligns to variants and is null where the chunk did not arrive via that BM25 leg
  ---
  duration_ms: 0.467541
  type: 'test'
  ...
# Subtest: scalar bm25_rank is the best (min) non-null across variants
ok 1639 - scalar bm25_rank is the best (min) non-null across variants
  ---
  duration_ms: 0.127
  type: 'test'
  ...
# Subtest: a chunk that never arrived via any BM25 leg has bm25_rank null
ok 1640 - a chunk that never arrived via any BM25 leg has bm25_rank null
  ---
  duration_ms: 0.12625
  type: 'test'
  ...
# Subtest: variant_ranks and rrf_score are unchanged by the provenance addition
ok 1641 - variant_ranks and rrf_score are unchanged by the provenance addition
  ---
  duration_ms: 0.295917
  type: 'test'
  ...
# Subtest: each per-variant retrieve() is called with withDiagnostics true (so bm25_rank is populated)
ok 1642 - each per-variant retrieve() is called with withDiagnostics true (so bm25_rank is populated)
  ---
  duration_ms: 0.132208
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: expandQuery runs exactly once, on the original question
ok 1643 - expandQuery runs exactly once, on the original question
  ---
  duration_ms: 0.938417
  type: 'test'
  ...
# Subtest: the original arm retrieves on expanded text; variant arms retrieve on variant text
ok 1644 - the original arm retrieves on expanded text; variant arms retrieve on variant text
  ---
  duration_ms: 0.51025
  type: 'test'
  ...
# Subtest: variant generation runs on the original question, never the expanded paragraph
ok 1645 - variant generation runs on the original question, never the expanded paragraph
  ---
  duration_ms: 0.121166
  type: 'test'
  ...
# Subtest: skipExpand:true from the caller turns expansion OFF — expandQuery is not called
ok 1646 - skipExpand:true from the caller turns expansion OFF — expandQuery is not called
  ---
  duration_ms: 0.116375
  type: 'test'
  ...
# Subtest: expansion fail-open (returns the original question) leaves the original arm on the raw question
ok 1647 - expansion fail-open (returns the original question) leaves the original arm on the raw question
  ---
  duration_ms: 0.323042
  type: 'test'
  ...
# Subtest: per-variant retrieve() keeps reranker/weights OFF after expansion is restored
ok 1648 - per-variant retrieve() keeps reranker/weights OFF after expansion is restored
  ---
  duration_ms: 0.215083
  type: 'test'
  ...
# Subtest: expandedQuery is returned on MultiRetrieveResult
ok 1649 - expandedQuery is returned on MultiRetrieveResult
  ---
  duration_ms: 0.1295
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: RRF fusion: a chunk ranked \#1 by two variants beats a chunk ranked \#1 by one variant with higher cosine
ok 1650 - RRF fusion: a chunk ranked \#1 by two variants beats a chunk ranked \#1 by one variant with higher cosine
  ---
  duration_ms: 1.16725
  type: 'test'
  ...
# Subtest: rerank runs once over the fused pool against the original question — never a variant
ok 1651 - rerank runs once over the fused pool against the original question — never a variant
  ---
  duration_ms: 0.220333
  type: 'test'
  ...
# Subtest: source weighting: a guidelines (0.95) chunk outranks an unknown-journal (0.80) chunk at equal rerank score
ok 1652 - source weighting: a guidelines (0.95) chunk outranks an unknown-journal (0.80) chunk at equal rerank score
  ---
  duration_ms: 0.287
  type: 'test'
  ...
# Subtest: per-variant retrieve() runs with useReranker/useSourceWeights false; fusion reranks once
ok 1653 - per-variant retrieve() runs with useReranker/useSourceWeights false; fusion reranks once
  ---
  duration_ms: 0.184667
  type: 'test'
  ...
# Subtest: variant generation returning nothing falls back to the original query alone, no throw
ok 1654 - variant generation returning nothing falls back to the original query alone, no throw
  ---
  duration_ms: 0.42825
  type: 'test'
  ...
# Subtest: multi-query hits always carry rrf_score + variant_ranks — no includeQuarantined needed
ok 1655 - multi-query hits always carry rrf_score + variant_ranks — no includeQuarantined needed
  ---
  duration_ms: 0.120792
  type: 'test'
  ...
# Subtest: R-6 guard: assertEmbeddingV2Available throws a named error when v2 is on but the column is absent
ok 1656 - R-6 guard: assertEmbeddingV2Available throws a named error when v2 is on but the column is absent
  ---
  duration_ms: 0.226542
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: every arm now RECEIVES a capture, and the fusion lifts index_version from the first that has one
ok 1657 - every arm now RECEIVES a capture, and the fusion lifts index_version from the first that has one
  ---
  duration_ms: 1.1165
  type: 'test'
  ...
# Subtest: the manifest that results carries a non-null index_version, and validates clean on that field
ok 1658 - the manifest that results carries a non-null index_version, and validates clean on that field
  ---
  duration_ms: 0.676417
  type: 'test'
  ...
# Subtest: an arm that stamps nothing leaves a null, and the null is recorded rather than invented
ok 1659 - an arm that stamps nothing leaves a null, and the null is recorded rather than invented
  ---
  duration_ms: 0.17275
  type: 'test'
  ...
# Subtest: INSTRUMENTATION OFF: no arm capture is made, and the arms are called with an undefined third argument
ok 1660 - INSTRUMENTATION OFF: no arm capture is made, and the arms are called with an undefined third argument
  ---
  duration_ms: 0.244834
  type: 'test'
  ...
# Subtest: 63 — the fail-open early exit still has its literal form, and this file does not quote it in a comment
ok 1661 - 63 — the fail-open early exit still has its literal form, and this file does not quote it in a comment
  ---
  duration_ms: 0.091041
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: DEFAULT_NORMATIVE_SOURCES = choosing-wisely + the two activated guideline keys, in order
ok 1662 - DEFAULT_NORMATIVE_SOURCES = choosing-wisely + the two activated guideline keys, in order
  ---
  duration_ms: 0.765333
  type: 'test'
  ...
# Subtest: the added keys target ACTIVATED sources (lab:), never quarantined (labq:) — inert until activation
ok 1663 - the added keys target ACTIVATED sources (lab:), never quarantined (labq:) — inert until activation
  ---
  duration_ms: 0.270459
  type: 'test'
  ...
# Subtest: sourceLabel renders "Even Guidelines" / "ICMR Guidelines" for the activated sources
ok 1664 - sourceLabel renders "Even Guidelines" / "ICMR Guidelines" for the activated sources
  ---
  duration_ms: 0.113
  type: 'test'
  ...
# Subtest: labels are INERT while quarantined: a labq: chunk falls back to book (unchanged today)
ok 1665 - labels are INERT while quarantined: a labq: chunk falls back to book (unchanged today)
  ---
  duration_ms: 0.048333
  type: 'test'
  ...
# Subtest: choosing-wisely and every other source are byte-identical (book-driven, no override)
ok 1666 - choosing-wisely and every other source are byte-identical (book-driven, no override)
  ---
  duration_ms: 0.061208
  type: 'test'
  ...
# Subtest: the guideline anchors resolve to NO url (category/internal authority, not deterministic)
ok 1667 - the guideline anchors resolve to NO url (category/internal authority, not deterministic)
  ---
  duration_ms: 0.088084
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [normative-grounding] CW leg failed db down
# [normative-grounding] guideline leg failed db down
# Subtest: CW gate: accept the top candidate only when its statement category == finding.lvc_category AND cosine ≥ τ
ok 1668 - CW gate: accept the top candidate only when its statement category == finding.lvc_category AND cosine ≥ τ
  ---
  duration_ms: 0.577167
  type: 'test'
  ...
# Subtest: guideline gate: accept iff cosine ≥ τ (no category constraint)
ok 1669 - guideline gate: accept iff cosine ≥ τ (no category constraint)
  ---
  duration_ms: 0.133666
  type: 'test'
  ...
# Subtest: mergeNormativeCitations attaches both accepted legs and dedupes against existing
ok 1670 - mergeNormativeCitations attaches both accepted legs and dedupes against existing
  ---
  duration_ms: 0.547375
  type: 'test'
  ...
# Subtest: hitToSource: guideline anchor resolves to NO url (no fake identifier), CW keeps its source/item
ok 1671 - hitToSource: guideline anchor resolves to NO url (no fake identifier), CW keeps its source/item
  ---
  duration_ms: 0.056792
  type: 'test'
  ...
# Subtest: SCORE-INVARIANCE: attaching citations leaves verdict/score/band/lvc_category byte-identical
ok 1672 - SCORE-INVARIANCE: attaching citations leaves verdict/score/band/lvc_category byte-identical
  ---
  duration_ms: 0.586083
  type: 'test'
  ...
# Subtest: attachNormativeCitations is IDEMPOTENT — a re-run adds nothing
ok 1673 - attachNormativeCitations is IDEMPOTENT — a re-run adds nothing
  ---
  duration_ms: 0.079125
  type: 'test'
  ...
# Subtest: groundFinding attaches CW+guideline when both legs return accepted hits
ok 1674 - groundFinding attaches CW+guideline when both legs return accepted hits
  ---
  duration_ms: 0.28025
  type: 'test'
  ...
# Subtest: groundFinding grounds nothing on cross-category CW / below-τ guideline, and SOFT-FAILS on throw
ok 1675 - groundFinding grounds nothing on cross-category CW / below-τ guideline, and SOFT-FAILS on throw
  ---
  duration_ms: 0.244834
  type: 'test'
  ...
# Subtest: even gate: accept iff cosine ≥ τ AND the dynamic lookup category == finding.lvc_category
ok 1676 - even gate: accept iff cosine ≥ τ AND the dynamic lookup category == finding.lvc_category
  ---
  duration_ms: 0.226
  type: 'test'
  ...
# Subtest: citation ordering: external legs first, even-lvc LAST; dedup by (source,item_number)
ok 1677 - citation ordering: external legs first, even-lvc LAST; dedup by (source,item_number)
  ---
  duration_ms: 0.353125
  type: 'test'
  ...
# Subtest: groundFinding runs the even leg ONLY with a lookup; attaches it last, inert without a lookup
ok 1678 - groundFinding runs the even leg ONLY with a lookup; attaches it last, inert without a lookup
  ---
  duration_ms: 0.147458
  type: 'test'
  ...
# Subtest: --legs cw runs ONLY the CW leg (guideline omitted, guideline retrieve not even called)
ok 1679 - --legs cw runs ONLY the CW leg (guideline omitted, guideline retrieve not even called)
  ---
  duration_ms: 0.076375
  type: 'test'
  ...
# Subtest: --legs guideline runs ONLY the guideline leg (CW omitted)
ok 1680 - --legs guideline runs ONLY the guideline leg (CW omitted)
  ---
  duration_ms: 0.054208
  type: 'test'
  ...
# Subtest: --categories filters eligibility: a finding whose lvc_category is not listed grounds nothing
ok 1681 - --categories filters eligibility: a finding whose lvc_category is not listed grounds nothing
  ---
  duration_ms: 0.140625
  type: 'test'
  ...
# Subtest: --tau raises/lowers acceptance (same match math, different threshold)
ok 1682 - --tau raises/lowers acceptance (same match math, different threshold)
  ---
  duration_ms: 0.08875
  type: 'test'
  ...
# Subtest: DEFAULT options reproduce today's behaviour byte-identically (regression guard)
ok 1683 - DEFAULT options reproduce today's behaviour byte-identically (regression guard)
  ---
  duration_ms: 0.115792
  type: 'test'
  ...
# Subtest: CW category map: every id maps to a known lvc_category; the strong categories are covered
ok 1684 - CW category map: every id maps to a known lvc_category; the strong categories are covered
  ---
  duration_ms: 0.0665
  type: 'test'
  ...
# Subtest: isGroundableFinding: only non-informational low-value findings
ok 1685 - isGroundableFinding: only non-informational low-value findings
  ---
  duration_ms: 0.042041
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: resolveNormativeSources defaults to choosing-wisely + the two activated guideline keys; never labq:% by default
ok 1686 - resolveNormativeSources defaults to choosing-wisely + the two activated guideline keys; never labq:% by default
  ---
  duration_ms: 1.680958
  type: 'test'
  ...
# Subtest: normativeLegK reads env NORMATIVE_LEG_K, defaults 5
ok 1687 - normativeLegK reads env NORMATIVE_LEG_K, defaults 5
  ---
  duration_ms: 0.111167
  type: 'test'
  ...
# Subtest: the normative leg is the vector SQL filtered to source = ANY, capped at N_norm
ok 1688 - the normative leg is the vector SQL filtered to source = ANY, capped at N_norm
  ---
  duration_ms: 0.227792
  type: 'test'
  ...
# Subtest: the normative leg leaves the default filter clauses byte-identical
ok 1689 - the normative leg leaves the default filter clauses byte-identical
  ---
  duration_ms: 0.159583
  type: 'test'
  ...
# Subtest: useNormativeLeg + normativeSources thread through retrieveMultiQuery to each per-variant retrieve
ok 1690 - useNormativeLeg + normativeSources thread through retrieveMultiQuery to each per-variant retrieve
  ---
  duration_ms: 0.367916
  type: 'test'
  ...
# Subtest: engine bumped to 0.81.19 (neutraliser removal) and the read family includes 0.81.8…0.81.17
ok 1691 - engine bumped to 0.81.19 (neutraliser removal) and the read family includes 0.81.8…0.81.17
  ---
  duration_ms: 0.538875
  type: 'test'
  ...
# Subtest: bug 9: an unresolved brand is surfaced but informational (never scores)
ok 1692 - bug 9: an unresolved brand is surfaced but informational (never scores)
  ---
  duration_ms: 1.353833
  type: 'test'
  ...
# Subtest: bug 6: an unresolved line never ALSO stacks incomplete dosing (consolidated)
ok 1693 - bug 6: an unresolved line never ALSO stacks incomplete dosing (consolidated)
  ---
  duration_ms: 0.295708
  type: 'test'
  ...
# Subtest: bug 7: an off-formulary cosmetic (by name) is exempt from incomplete dosing
ok 1694 - bug 7: an off-formulary cosmetic (by name) is exempt from incomplete dosing
  ---
  duration_ms: 0.237708
  type: 'test'
  ...
# Subtest: a RESOLVED real drug missing its dose STILL scores incomplete dosing
ok 1695 - a RESOLVED real drug missing its dose STILL scores incomplete dosing
  ---
  duration_ms: 0.214291
  type: 'test'
  ...
# Subtest: bug 2: a health-check package encounter is recognised and neutralises screening critiques
ok 1696 - bug 2: a health-check package encounter is recognised and neutralises screening critiques
  ---
  duration_ms: 0.437542
  type: 'test'
  ...
# Subtest: bug 10: a biotin-before-thyroid over-flag is neutralised to informational
ok 1697 - bug 10: a biotin-before-thyroid over-flag is neutralised to informational
  ---
  duration_ms: 0.772833
  type: 'test'
  ...
# Subtest: bug 5: the Antispasmodic/anticholinergic reclass does NOT change DDI tags
ok 1698 - bug 5: the Antispasmodic/anticholinergic reclass does NOT change DDI tags
  ---
  duration_ms: 0.510667
  type: 'test'
  ...
# Subtest: Part B: the 3 base categories are unchanged
ok 1699 - Part B: the 3 base categories are unchanged
  ---
  duration_ms: 0.727375
  type: 'test'
  ...
# Subtest: Part B: residual other splits into overuse sub-tags by priority
ok 1700 - Part B: residual other splits into overuse sub-tags by priority
  ---
  duration_ms: 2.096292
  type: 'test'
  ...
# Subtest: Part B: the omission guard keeps missing-safety-net / mismatch findings in other
ok 1701 - Part B: the omission guard keeps missing-safety-net / mismatch findings in other
  ---
  duration_ms: 0.38125
  type: 'test'
  ...
# Subtest: Part B: priority order — therapeutic_duplication wins over a steroid mention
ok 1702 - Part B: priority order — therapeutic_duplication wins over a steroid mention
  ---
  duration_ms: 0.041667
  type: 'test'
  ...
# Subtest: Part B: every category has a shared human label (no raw slug can render)
ok 1703 - Part B: every category has a shared human label (no raw slug can render)
  ---
  duration_ms: 0.049334
  type: 'test'
  ...
# Subtest: Part C: frequentFlierCmp orders per Decision 12
ok 1704 - Part C: frequentFlierCmp orders per Decision 12
  ---
  duration_ms: 0.116125
  type: 'test'
  ...
# Subtest: Part C: default (index) order is untouched by the comparator module
ok 1705 - Part C: default (index) order is untouched by the comparator module
  ---
  duration_ms: 0.033917
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: 0.81.10 S1: the muscle-relaxant finding is emitted informational (surfaced, out of the score)
ok 1706 - 0.81.10 S1: the muscle-relaxant finding is emitted informational (surfaced, out of the score)
  ---
  duration_ms: 1.295417
  type: 'test'
  ...
# Subtest: bug 1: xanthine for an acute URTI fires (context-guarded)
ok 1707 - bug 1: xanthine for an acute URTI fires (context-guarded)
  ---
  duration_ms: 1.043291
  type: 'test'
  ...
# Subtest: bug 1: the SAME xanthine is NOT flagged for a chronic-airways patient (J40–J47 guard)
ok 1708 - bug 1: the SAME xanthine is NOT flagged for a chronic-airways patient (J40–J47 guard)
  ---
  duration_ms: 0.59375
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 12: acebrophylline + acetylcysteine in an acute URTI → NO finding (rule dormant for it)
ok 1709 - 0.81.14 Ruling 12: acebrophylline + acetylcysteine in an acute URTI → NO finding (rule dormant for it)
  ---
  duration_ms: 0.201209
  type: 'test'
  ...
# Subtest: 0.81.13 Decision 11: antihistamine + montelukast emits NO finding at any duration
ok 1710 - 0.81.13 Decision 11: antihistamine + montelukast emits NO finding at any duration
  ---
  duration_ms: 0.458458
  type: 'test'
  ...
# Subtest: 0.81.13 Decision 11: a xanthine AND antihistamine+montelukast → exactly ONE finding (the xanthine)
ok 1711 - 0.81.13 Decision 11: a xanthine AND antihistamine+montelukast → exactly ONE finding (the xanthine)
  ---
  duration_ms: 0.30725
  type: 'test'
  ...
# Subtest: 0.81.13 Decision 3: xanthine subject/rationale carry no "mucolytic"; guard + confidence unchanged
ok 1712 - 0.81.13 Decision 3: xanthine subject/rationale carry no "mucolytic"; guard + confidence unchanged
  ---
  duration_ms: 0.418209
  type: 'test'
  ...
# Subtest: bug 1: no acute-URTI context → nothing fires
ok 1713 - bug 1: no acute-URTI context → nothing fires
  ---
  duration_ms: 0.123
  type: 'test'
  ...
# Subtest: 0.81.13 Decision 4: 5 → none; 7 → none; 8 and 15 → 0.7; 16 and 1 month → 0.85; unparseable → none
ok 1714 - 0.81.13 Decision 4: 5 → none; 7 → none; 8 and 15 → 0.7; 16 and 1 month → 0.85; unparseable → none
  ---
  duration_ms: 0.991875
  type: 'test'
  ...
# Subtest: 0.81.13: parseDurationDays (exported) parses days/weeks/months and returns null for chronic/unparseable
ok 1715 - 0.81.13: parseDurationDays (exported) parses days/weeks/months and returns null for chronic/unparseable
  ---
  duration_ms: 0.813542
  type: 'test'
  ...
# Subtest: bug 8: BPO wash-off + leave-on is NOT a duplicate (finding dropped)
ok 1716 - bug 8: BPO wash-off + leave-on is NOT a duplicate (finding dropped)
  ---
  duration_ms: 8.441917
  type: 'test'
  ...
# Subtest: bug 8: topical + systemic sharing a molecule is not a duplicate
ok 1717 - bug 8: topical + systemic sharing a molecule is not a duplicate
  ---
  duration_ms: 0.723583
  type: 'test'
  ...
# Subtest: bug 8: a genuine same-route duplicate is KEPT
ok 1718 - bug 8: a genuine same-route duplicate is KEPT
  ---
  duration_ms: 0.318041
  type: 'test'
  ...
# Subtest: bug 8: an LLM finding (non-deterministic) is never touched by the route filter
ok 1719 - bug 8: an LLM finding (non-deterministic) is never touched by the route filter
  ---
  duration_ms: 0.116875
  type: 'test'
  ...
# Subtest: bug 4: opdCaseText surfaces the consult date exactly once with a historical guard
ok 1720 - bug 4: opdCaseText surfaces the consult date exactly once with a historical guard
  ---
  duration_ms: 0.410708
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 1: an oral + topical NSAID pair emits NO interaction finding
ok 1721 - 0.81.14 Ruling 1: an oral + topical NSAID pair emits NO interaction finding
  ---
  duration_ms: 2.107792
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 1: two ORAL NSAIDs still produce an interaction finding (unchanged)
ok 1722 - 0.81.14 Ruling 1: two ORAL NSAIDs still produce an interaction finding (unchanged)
  ---
  duration_ms: 0.909625
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 4: muscle relaxant with MSK context → none; without → fires; ctx omitted → today
ok 1723 - 0.81.14 Ruling 4: muscle relaxant with MSK context → none; without → fires; ctx omitted → today
  ---
  duration_ms: 0.141792
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 4: mskContextDocumented — "low back pain" true, ICD M54.5 true, "fever, cough" false
ok 1724 - 0.81.14 Ruling 4: mskContextDocumented — "low back pain" true, ICD M54.5 true, "fever, cough" false
  ---
  duration_ms: 0.641667
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 13: 60,000 IU weekly for >8 weeks fires informational; 8 weeks / daily / low-strength / unparseable → none
ok 1725 - 0.81.14 Ruling 13: 60,000 IU weekly for >8 weeks fires informational; 8 weeks / daily / low-strength / unparseable → none
  ---
  duration_ms: 0.8485
  type: 'test'
  ...
# Subtest: 0.81.14 Rulings 5–8: pregnancy advisory fires only in the 36–90d window with a trigger drug, always informational
ok 1726 - 0.81.14 Rulings 5–8: pregnancy advisory fires only in the 36–90d window with a trigger drug, always informational
  ---
  duration_ms: 4.712625
  type: 'test'
  ...
# Subtest: 0.81.14: lmpIntervalDays parses ISO dates + fail-safe on missing/garbage
ok 1727 - 0.81.14: lmpIntervalDays parses ISO dates + fail-safe on missing/garbage
  ---
  duration_ms: 0.14525
  type: 'test'
  ...
# Subtest: wrapText: short text stays on one line
ok 1728 - wrapText: short text stays on one line
  ---
  duration_ms: 0.804042
  type: 'test'
  ...
# Subtest: wrapText: wraps on word boundaries when a line would overflow
ok 1729 - wrapText: wraps on word boundaries when a line would overflow
  ---
  duration_ms: 0.112708
  type: 'test'
  ...
# Subtest: wrapText: hard-breaks a single word longer than maxWidth
ok 1730 - wrapText: hard-breaks a single word longer than maxWidth
  ---
  duration_ms: 0.117458
  type: 'test'
  ...
# Subtest: wrapText: mixes a long word with normal words, never exceeding maxWidth
ok 1731 - wrapText: mixes a long word with normal words, never exceeding maxWidth
  ---
  duration_ms: 0.0575
  type: 'test'
  ...
# Subtest: wrapText: collapses whitespace and handles empty input
ok 1732 - wrapText: collapses whitespace and handles empty input
  ---
  duration_ms: 0.101334
  type: 'test'
  ...
# Subtest: paginate: packs items greedily within capacity
ok 1733 - paginate: packs items greedily within capacity
  ---
  duration_ms: 0.123917
  type: 'test'
  ...
# Subtest: paginate: an item taller than capacity gets its own page, never dropped
ok 1734 - paginate: an item taller than capacity gets its own page, never dropped
  ---
  duration_ms: 0.054583
  type: 'test'
  ...
# Subtest: paginate: empty input → no pages
ok 1735 - paginate: empty input → no pages
  ---
  duration_ms: 0.075833
  type: 'test'
  ...
# Subtest: paginate: everything fits on one page when capacity is large
ok 1736 - paginate: everything fits on one page when capacity is large
  ---
  duration_ms: 0.196375
  type: 'test'
  ...
# Subtest: migration 0025 is exactly one additive, idempotent statement
ok 1737 - migration 0025 is exactly one additive, idempotent statement
  ---
  duration_ms: 0.646583
  type: 'test'
  ...
# Subtest: ALL THREE write paths carry the scorecard — a row written without one is a bug
ok 1738 - ALL THREE write paths carry the scorecard — a row written without one is a bug
  ---
  duration_ms: 0.123583
  type: 'test'
  ...
# Subtest: the A.1 column is APPENDED — no established placeholder index moved
ok 1739 - the A.1 column is APPENDED — no established placeholder index moved
  ---
  duration_ms: 0.112375
  type: 'test'
  ...
# Subtest: INSERT: columns and arguments align in ALL SIXTEEN branches
ok 1740 - INSERT: columns and arguments align in ALL SIXTEEN branches
  ---
  duration_ms: 2.006333
  type: 'test'
  ...
# Subtest: INSERT: every jsonb column is cast, including the A.1 one
ok 1741 - INSERT: every jsonb column is cast, including the A.1 one
  ---
  duration_ms: 0.0855
  type: 'test'
  ...
# Subtest: UPDATE placeholders align in all four branches; scorecard $20, excluded_reason $21, quieting_gen $22
ok 1742 - UPDATE placeholders align in all four branches; scorecard $20, excluded_reason $21, quieting_gen $22
  ---
  duration_ms: 0.0685
  type: 'test'
  ...
# Subtest: serialisation is FAIL-SAFE: a scorecard fault must never cost an audit
ok 1743 - serialisation is FAIL-SAFE: a scorecard fault must never cost an audit
  ---
  duration_ms: 0.113667
  type: 'test'
  ...
# Subtest: the scorecard is stored AS COMPUTED — not pruned, reshaped or renamed
ok 1744 - the scorecard is stored AS COMPUTED — not pruned, reshaped or renamed
  ---
  duration_ms: 0.098709
  type: 'test'
  ...
# Subtest: THE POINT: an unassessed note carries note_quality with weight 0 and a stating basis
ok 1745 - THE POINT: an unassessed note carries note_quality with weight 0 and a stating basis
  ---
  duration_ms: 0.46675
  type: 'test'
  ...
# Subtest: an ASSESSED note keeps a non-zero note_quality weight — the control
ok 1746 - an ASSESSED note keeps a non-zero note_quality weight — the control
  ---
  duration_ms: 0.347333
  type: 'test'
  ...
# Subtest: matches a low-value investigation to its line
ok 1747 - matches a low-value investigation to its line
  ---
  duration_ms: 1.615708
  type: 'test'
  ...
# Subtest: matches a dosing finding to the specific medication line
ok 1748 - matches a dosing finding to the specific medication line
  ---
  duration_ms: 0.319375
  type: 'test'
  ...
# Subtest: prescribing finding prefers the med line on a tie
ok 1749 - prescribing finding prefers the med line on a tie
  ---
  duration_ms: 0.1625
  type: 'test'
  ...
# Subtest: documentation finding falls back to keyword section
ok 1750 - documentation finding falls back to keyword section
  ---
  duration_ms: 0.151583
  type: 'test'
  ...
# Subtest: follow-up keyword routes to followup section
ok 1751 - follow-up keyword routes to followup section
  ---
  duration_ms: 0.115708
  type: 'test'
  ...
# Subtest: unmatched appropriateness finding falls back to investigations section
ok 1752 - unmatched appropriateness finding falls back to investigations section
  ---
  duration_ms: 0.161333
  type: 'test'
  ...
# Subtest: appropriateness fallback goes to diagnosis when no investigations exist
ok 1753 - appropriateness fallback goes to diagnosis when no investigations exist
  ---
  duration_ms: 0.180167
  type: 'test'
  ...
# Subtest: note_quality findings anchor to the whole note
ok 1754 - note_quality findings anchor to the whole note
  ---
  duration_ms: 0.0565
  type: 'test'
  ...
# Subtest: numbers follow findings order and grouping keys are stable
ok 1755 - numbers follow findings order and grouping keys are stable
  ---
  duration_ms: 0.552709
  type: 'test'
  ...
# Subtest: stopwords alone never force a spurious med match
ok 1756 - stopwords alone never force a spurious med match
  ---
  duration_ms: 0.315417
  type: 'test'
  ...
# Subtest: chronicPoints tiers: 0 | 1–2 | 3+ → 0 | 1 | 2
ok 1757 - chronicPoints tiers: 0 | 1–2 | 3+ → 0 | 1 | 2
  ---
  duration_ms: 0.472208
  type: 'test'
  ...
# Subtest: lab/util points fire at their thresholds (3 abnormal / 4 encounters)
ok 1758 - lab/util points fire at their thresholds (3 abnormal / 4 encounters)
  ---
  duration_ms: 0.089708
  type: 'test'
  ...
# Subtest: bandFor: full point table (LOW/MODERATE/HIGH boundaries)
ok 1759 - bandFor: full point table (LOW/MODERATE/HIGH boundaries)
  ---
  duration_ms: 0.090791
  type: 'test'
  ...
# Subtest: NEW_TO_US precedence: zero encounters in prior 24m overrides the point band
ok 1760 - NEW_TO_US precedence: zero encounters in prior 24m overrides the point band
  ---
  duration_ms: 0.046833
  type: 'test'
  ...
# Subtest: complexityPoints sums the three legs
ok 1761 - complexityPoints sums the three legs
  ---
  duration_ms: 0.046917
  type: 'test'
  ...
# Subtest: buildComplexity returns band + echoes inputs
ok 1762 - buildComplexity returns band + echoes inputs
  ---
  duration_ms: 0.049375
  type: 'test'
  ...
# Subtest: windowStart: 12m / 24m before the index date (UTC month math)
ok 1763 - windowStart: 12m / 24m before the index date (UTC month math)
  ---
  duration_ms: 1.333208
  type: 'test'
  ...
# Subtest: db13-row parsers: distinct chronic ICDs, abnormal count, scalar count; NULL-safe
ok 1764 - db13-row parsers: distinct chronic ICDs, abnormal count, scalar count; NULL-safe
  ---
  duration_ms: 0.276625
  type: 'test'
  ...
# Subtest: index-encounter exclusion is an as-of property: with only the index in-window, prior counts are 0 → NEW_TO_US
ok 1765 - index-encounter exclusion is an as-of property: with only the index in-window, prior counts are 0 → NEW_TO_US
  ---
  duration_ms: 0.429
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: no eval config ⇒ opdRetrieveOpts byte-identical to today
ok 1766 - no eval config ⇒ opdRetrieveOpts byte-identical to today
  ---
  duration_ms: 0.857833
  type: 'test'
  ...
# Subtest: evalNormativeLeg:true ⇒ useNormativeLeg true regardless of mini / env
ok 1767 - evalNormativeLeg:true ⇒ useNormativeLeg true regardless of mini / env
  ---
  duration_ms: 0.093
  type: 'test'
  ...
# Subtest: buildOpenRouterBody carries the eval determinism config: temp0 + top_p1 + seed + reasoning-pin + provider-pin
ok 1768 - buildOpenRouterBody carries the eval determinism config: temp0 + top_p1 + seed + reasoning-pin + provider-pin
  ---
  duration_ms: 0.174542
  type: 'test'
  ...
# Subtest: production defaultGenerate: Vertex-Gemini path gets temp0 + seed + top_p + fixed thinking, GATED on onGemini; mini/Ollama unchanged
ok 1769 - production defaultGenerate: Vertex-Gemini path gets temp0 + seed + top_p + fixed thinking, GATED on onGemini; mini/Ollama unchanged
  ---
  duration_ms: 0.388667
  type: 'test'
  ...
# Subtest: LVC/Kimi adjudication params: temp0 + seed + top_p + OpenRouter provider-pin
ok 1770 - LVC/Kimi adjudication params: temp0 + seed + top_p + OpenRouter provider-pin
  ---
  duration_ms: 0.153875
  type: 'test'
  ...
# Subtest: openRouterGenerate posts to the OpenRouter endpoint at temp 0 and returns the completion
ok 1771 - openRouterGenerate posts to the OpenRouter endpoint at temp 0 and returns the completion
  ---
  duration_ms: 26.584625
  type: 'test'
  ...
# Subtest: openRouterGenerate throws (does not silently fall back) when the key is missing
ok 1772 - openRouterGenerate throws (does not silently fall back) when the key is missing
  ---
  duration_ms: 0.258417
  type: 'test'
  ...
# Subtest: the lab-batch eval path never writes opd_note_audits (structural guard)
ok 1773 - the lab-batch eval path never writes opd_note_audits (structural guard)
  ---
  duration_ms: 0.273625
  type: 'test'
  ...
# Subtest: parseBatchState reads the eval config; absent ⇒ off / null
ok 1774 - parseBatchState reads the eval config; absent ⇒ off / null
  ---
  duration_ms: 0.316708
  type: 'test'
  ...
# Subtest: verdict sets are wired by scope
ok 1775 - verdict sets are wired by scope
  ---
  duration_ms: 0.95875
  type: 'test'
  ...
# Subtest: impact scope: TP-only second tap — valid tag + finding_ref required, category always null
ok 1776 - impact scope: TP-only second tap — valid tag + finding_ref required, category always null
  ---
  duration_ms: 0.686209
  type: 'test'
  ...
# Subtest: missed scope: category is REQUIRED (F6/A10.1) and whitelisted; unknown category rejected
ok 1777 - missed scope: category is REQUIRED (F6/A10.1) and whitelisted; unknown category rejected
  ---
  duration_ms: 0.248458
  type: 'test'
  ...
# Subtest: non-missed/impact scopes carry category=null
ok 1778 - non-missed/impact scopes carry category=null
  ---
  duration_ms: 0.072375
  type: 'test'
  ...
# Subtest: bad auditId is rejected before anything else
ok 1779 - bad auditId is rejected before anything else
  ---
  duration_ms: 0.053708
  type: 'test'
  ...
# Subtest: unknown scope is rejected
ok 1780 - unknown scope is rejected
  ---
  duration_ms: 0.045417
  type: 'test'
  ...
# Subtest: legacy audit scope: bare comment allowed, defaults to audit, verdict optional
ok 1781 - legacy audit scope: bare comment allowed, defaults to audit, verdict optional
  ---
  duration_ms: 0.105541
  type: 'test'
  ...
# Subtest: audit scope: valid verdict kept, invalid verdict dropped to null
ok 1782 - audit scope: valid verdict kept, invalid verdict dropped to null
  ---
  duration_ms: 0.0625
  type: 'test'
  ...
# Subtest: audit scope: empty body (no verdict, no comment) rejected
ok 1783 - audit scope: empty body (no verdict, no comment) rejected
  ---
  duration_ms: 0.205791
  type: 'test'
  ...
# Subtest: finding scope: requires a finding verdict
ok 1784 - finding scope: requires a finding verdict
  ---
  duration_ms: 0.288542
  type: 'test'
  ...
# Subtest: finding scope: requires finding_ref
ok 1785 - finding scope: requires finding_ref
  ---
  duration_ms: 0.050333
  type: 'test'
  ...
# Subtest: finding scope: all four verdicts accepted, carries ref + signal_type + optional comment
ok 1786 - finding scope: all four verdicts accepted, carries ref + signal_type + optional comment
  ---
  duration_ms: 0.060208
  type: 'test'
  ...
# Subtest: missed scope: verdict forced to missed, comment required
ok 1787 - missed scope: verdict forced to missed, comment required
  ---
  duration_ms: 0.049375
  type: 'test'
  ...
# Subtest: fields are trimmed, empties collapse to null, oversized values are capped
ok 1788 - fields are trimmed, empties collapse to null, oversized values are capped
  ---
  duration_ms: 0.05175
  type: 'test'
  ...
# Subtest: dedup expression selects latest per (audit_id, finding_ref), tie-break highest id
ok 1789 - dedup expression selects latest per (audit_id, finding_ref), tie-break highest id
  ---
  duration_ms: 0.831125
  type: 'test'
  ...
# Subtest: precision_strict excludes contested; zero denominator → null
ok 1790 - precision_strict excludes contested; zero denominator → null
  ---
  duration_ms: 1.411375
  type: 'test'
  ...
# Subtest: coverage_pct = triaged/fired as a one-decimal percentage
ok 1791 - coverage_pct = triaged/fired as a one-decimal percentage
  ---
  duration_ms: 0.411459
  type: 'test'
  ...
# Subtest: parseAdjudicateArgs: valid log accepted; bad decision/action/missing rationale rejected
ok 1792 - parseAdjudicateArgs: valid log accepted; bad decision/action/missing rationale rejected
  ---
  duration_ms: 0.294209
  type: 'test'
  ...
# Subtest: parseAdjudicateArgs: monitor and all five decisions accepted; list defaults + clamp
ok 1793 - parseAdjudicateArgs: monitor and all five decisions accepted; list defaults + clamp
  ---
  duration_ms: 0.375209
  type: 'test'
  ...
# Subtest: missed rows: grouped by category; null category labelled (unclassified); unjoined engine preserved
ok 1794 - missed rows: grouped by category; null category labelled (unclassified); unjoined engine preserved
  ---
  duration_ms: 0.32
  type: 'test'
  ...
# Subtest: buildDetailSql: whitelist rejects bad scope/verdict; param slots line up
ok 1795 - buildDetailSql: whitelist rejects bad scope/verdict; param slots line up
  ---
  duration_ms: 0.656042
  type: 'test'
  ...
# Subtest: rollup SQL builders parameterize every arg (no interpolation) and count slots
ok 1796 - rollup SQL builders parameterize every arg (no interpolation) and count slots
  ---
  duration_ms: 0.806167
  type: 'test'
  ...
# Subtest: isEscalationComment + rollup n_escalations count only the marker prefix
ok 1797 - isEscalationComment + rollup n_escalations count only the marker prefix
  ---
  duration_ms: 2.904583
  type: 'test'
  ...
# Subtest: ratio/pct guard zero denominators to null and round
ok 1798 - ratio/pct guard zero denominators to null and round
  ---
  duration_ms: 0.74975
  type: 'test'
  ...
# Subtest: open_adjudications: ≥3 false+nitpick opens; defer/absent open; fix|monitor close
ok 1799 - open_adjudications: ≥3 false+nitpick opens; defer/absent open; fix|monitor close
  ---
  duration_ms: 3.223458
  type: 'test'
  ...
# Subtest: reduceLedgerList marks the newest row per cluster_key as current
ok 1800 - reduceLedgerList marks the newest row per cluster_key as current
  ---
  duration_ms: 0.138125
  type: 'test'
  ...
# Subtest: shapeDetailRow resolves the finding from finding_raw; ref_resolved + history flags
ok 1801 - shapeDetailRow resolves the finding from finding_raw; ref_resolved + history flags
  ---
  duration_ms: 0.18275
  type: 'test'
  ...
# Subtest: adjudication insert/list builders parameterize; clusterKey convention
ok 1802 - adjudication insert/list builders parameterize; clusterKey convention
  ---
  duration_ms: 0.100125
  type: 'test'
  ...
# Subtest: planTap: same-pill tap is a no-op (toggle-off removed)
ok 1803 - planTap: same-pill tap is a no-op (toggle-off removed)
  ---
  duration_ms: 0.710625
  type: 'test'
  ...
# Subtest: revertOnFail restores the previous verdict from the attempt
ok 1804 - revertOnFail restores the previous verdict from the attempt
  ---
  duration_ms: 0.094208
  type: 'test'
  ...
# Subtest: makeAttempt preserves the exact retry payload (verdict + comment)
ok 1805 - makeAttempt preserves the exact retry payload (verdict + comment)
  ---
  duration_ms: 0.057292
  type: 'test'
  ...
# Subtest: savedLabel formats "Saved HH:MM · name" in 24h IST; anon fallback
ok 1806 - savedLabel formats "Saved HH:MM · name" in 24h IST; anon fallback
  ---
  duration_ms: 0.0925
  type: 'test'
  ...
# Subtest: Feature B: saved dedupes by findingRef; caps at total
ok 1807 - Feature B: saved dedupes by findingRef; caps at total
  ---
  duration_ms: 0.098459
  type: 'test'
  ...
# Subtest: Feature B: missed increments its own counter, not triaged
ok 1808 - Feature B: missed increments its own counter, not triaged
  ---
  duration_ms: 0.047958
  type: 'test'
  ...
# Subtest: Feature B: initProgress clamps seed triaged to total and de-dupes/ignores empty refs
ok 1809 - Feature B: initProgress clamps seed triaged to total and de-dupes/ignores empty refs
  ---
  duration_ms: 0.092083
  type: 'test'
  ...
# Subtest: the zero-import SHA-1 matches the standard test vector (addendum A3)
ok 1810 - the zero-import SHA-1 matches the standard test vector (addendum A3)
  ---
  duration_ms: 0.722583
  type: 'test'
  ...
# Subtest: normStableText: NFKC, lowercase, whitespace collapse, trailing punctuation/quotes stripped
ok 1811 - normStableText: NFKC, lowercase, whitespace collapse, trailing punctuation/quotes stripped
  ---
  duration_ms: 0.243333
  type: 'test'
  ...
# Subtest: stable_ref is deterministic and full 40-char lowercase hex
ok 1812 - stable_ref is deterministic and full 40-char lowercase hex
  ---
  duration_ms: 0.146458
  type: 'test'
  ...
# Subtest: A1: the SAME (signal_type, subject) on two DIFFERENT notes produces the SAME ref — by design
ok 1813 - A1: the SAME (signal_type, subject) on two DIFFERENT notes produces the SAME ref — by design
  ---
  duration_ms: 0.0715
  type: 'test'
  ...
# Subtest: stable_ref survives an engine bump: same note re-audited under two engine versions ⇒ same ref
ok 1814 - stable_ref survives an engine bump: same note re-audited under two engine versions ⇒ same ref
  ---
  duration_ms: 0.458334
  type: 'test'
  ...
# Subtest: stable_ref differs when signal_type differs, even for an identical subject
ok 1815 - stable_ref differs when signal_type differs, even for an identical subject
  ---
  duration_ms: 0.074792
  type: 'test'
  ...
# Subtest: THE ONE-FUNCTION INVARIANT: engine stamp and backfill produce byte-identical refs
ok 1816 - THE ONE-FUNCTION INVARIANT: engine stamp and backfill produce byte-identical refs
  ---
  duration_ms: 0.214417
  type: 'test'
  ...
# Subtest: null — never a hash of "" — on an empty subject or signal_type
ok 1817 - null — never a hash of "" — on an empty subject or signal_type
  ---
  duration_ms: 0.075667
  type: 'test'
  ...
# Subtest: U+0001 delimiter: a subject containing "|" cannot collide across fields
ok 1818 - U+0001 delimiter: a subject containing "|" cannot collide across fields
  ---
  duration_ms: 0.227708
  type: 'test'
  ...
# Subtest: stampFindingIdentity keeps its ORIGINAL signature and always stamps (addenda A1/A4)
ok 1819 - stampFindingIdentity keeps its ORIGINAL signature and always stamps (addenda A1/A4)
  ---
  duration_ms: 0.321167
  type: 'test'
  ...
# Subtest: finding_ref behaviour is untouched: same hash, same within-note \#2 suffixing
ok 1820 - finding_ref behaviour is untouched: same hash, same within-note \#2 suffixing
  ---
  duration_ms: 0.138125
  type: 'test'
  ...
# Subtest: resolveLabel matches by stable_ref first
ok 1821 - resolveLabel matches by stable_ref first
  ---
  duration_ms: 0.08575
  type: 'test'
  ...
# Subtest: resolveLabel falls back to finding_ref when the stable_ref is absent or dead
ok 1822 - resolveLabel falls back to finding_ref when the stable_ref is absent or dead
  ---
  duration_ms: 0.714041
  type: 'test'
  ...
# Subtest: collision ⇒ null + ambiguous:true; never a guess
ok 1823 - collision ⇒ null + ambiguous:true; never a guess
  ---
  duration_ms: 0.053958
  type: 'test'
  ...
# Subtest: A1: uid scoping picks the right finding when two notes share a stable_ref
ok 1824 - A1: uid scoping picks the right finding when two notes share a stable_ref
  ---
  duration_ms: 0.04125
  type: 'test'
  ...
# Subtest: a blank uid resolves to nothing — never an unscoped lookup (A1)
ok 1825 - a blank uid resolves to nothing — never an unscoped lookup (A1)
  ---
  duration_ms: 0.032167
  type: 'test'
  ...
# Subtest: normalizeClusterKey strips "@version" and leaves a bare key unchanged
ok 1826 - normalizeClusterKey strips "@version" and leaves a bare key unchanged
  ---
  duration_ms: 0.04725
  type: 'test'
  ...
# Subtest: F2 min_triaged excludes zero-triaged buckets while every total still reconciles
ok 1827 - F2 min_triaged excludes zero-triaged buckets while every total still reconciles
  ---
  duration_ms: 0.560459
  type: 'test'
  ...
# Subtest: F2 mode=summary respects the 20k budget and sets truncated + n_buckets_omitted
ok 1828 - F2 mode=summary respects the 20k budget and sets truncated + n_buckets_omitted
  ---
  duration_ms: 31.179834
  type: 'test'
  ...
# Subtest: F2 summary keeps the top-20 by fired AND every bucket with triaged >= 5
ok 1829 - F2 summary keeps the top-20 by fired AND every bucket with triaged >= 5
  ---
  duration_ms: 0.195917
  type: 'test'
  ...
# Subtest: F4 reviewers_current sums to totals.triaged; reviewers_all_rows keeps its own basis
ok 1830 - F4 reviewers_current sums to totals.triaged; reviewers_all_rows keeps its own basis
  ---
  duration_ms: 0.128125
  type: 'test'
  ...
# Subtest: F4 reviewers_current degrades to [] when its query fails, without breaking the rollup
ok 1831 - F4 reviewers_current degrades to [] when its query fails, without breaking the rollup
  ---
  duration_ms: 0.480042
  type: 'test'
  ...
# Subtest: open_adjudications uses the BARE signal_type and honours a normalised historical ledger key
ok 1832 - open_adjudications uses the BARE signal_type and honours a normalised historical ledger key
  ---
  duration_ms: 0.218334
  type: 'test'
  ...
# Subtest: ledger folding is newest-first-wins when several versioned keys normalise onto one
ok 1833 - ledger folding is newest-first-wins when several versioned keys normalise onto one
  ---
  duration_ms: 0.05225
  type: 'test'
  ...
# Subtest: reduceLedgerList decides currency on the NORMALISED key (normative detail 5)
ok 1834 - reduceLedgerList decides currency on the NORMALISED key (normative detail 5)
  ---
  duration_ms: 0.077708
  type: 'test'
  ...
# Subtest: ageBandOf boundaries
ok 1835 - ageBandOf boundaries
  ---
  duration_ms: 0.53425
  type: 'test'
  ...
# Subtest: stratum fallback hierarchy: band×age (n≥30) → band marginal (n≥30) → global
ok 1836 - stratum fallback hierarchy: band×age (n≥30) → band marginal (n≥30) → global
  ---
  duration_ms: 0.282458
  type: 'test'
  ...
# Subtest: age unavailable (null) collapses band×age → band marginal (reproduces the gate)
ok 1837 - age unavailable (null) collapses band×age → band marginal (reproduces the gate)
  ---
  duration_ms: 0.077791
  type: 'test'
  ...
# Subtest: O/E arithmetic: expected = Σ n·stratumMean; raw = O/n; oe = O/E
ok 1838 - O/E arithmetic: expected = Σ n·stratumMean; raw = O/n; oe = O/E
  ---
  duration_ms: 0.165125
  type: 'test'
  ...
# Subtest: zero denominator → oe null; unbanded cells excluded
ok 1839 - zero denominator → oe null; unbanded cells excluded
  ---
  duration_ms: 0.076041
  type: 'test'
  ...
# Subtest: exclusion-set filtering: excluded doctor drops from output AND from stratum means
ok 1840 - exclusion-set filtering: excluded doctor drops from output AND from stratum means
  ---
  duration_ms: 0.075167
  type: 'test'
  ...
# Subtest: funnel limits vs hand-computed
ok 1841 - funnel limits vs hand-computed
  ---
  duration_ms: 0.378458
  type: 'test'
  ...
# Subtest: funnelCurve dedupes+sorts n; funnelPosition classifies vs limits + building
ok 1842 - funnelCurve dedupes+sorts n; funnelPosition classifies vs limits + building
  ---
  duration_ms: 0.134583
  type: 'test'
  ...
# Subtest: reference format + parse round-trips and validates
ok 1843 - reference format + parse round-trips and validates
  ---
  duration_ms: 0.799125
  type: 'test'
  ...
# Subtest: SLA only when a timely response is owed; privilege-review escalates on mint
ok 1844 - SLA only when a timely response is owed; privilege-review escalates on mint
  ---
  duration_ms: 1.3
  type: 'test'
  ...
# Subtest: isOverdue: only a routed, past-SLA, response-owed signal is overdue
ok 1845 - isOverdue: only a routed, past-SLA, response-owed signal is overdue
  ---
  duration_ms: 0.223042
  type: 'test'
  ...
# Subtest: status machine: response + action transitions
ok 1846 - status machine: response + action transitions
  ---
  duration_ms: 0.166459
  type: 'test'
  ...
# Subtest: validateDoctorResponse: type must match; explanation needs comment+verdict; guards
ok 1847 - validateDoctorResponse: type must match; explanation needs comment+verdict; guards
  ---
  duration_ms: 0.354708
  type: 'test'
  ...
# Subtest: validateSignalAction: enum guard + normalize
ok 1848 - validateSignalAction: enum guard + normalize
  ---
  duration_ms: 0.174417
  type: 'test'
  ...
# Subtest: signalObject: shape + overdue + label; no patient fields
ok 1849 - signalObject: shape + overdue + label; no patient fields
  ---
  duration_ms: 0.392208
  type: 'test'
  ...
# Subtest: healthy attribute produces no signal
ok 1850 - healthy attribute produces no signal
  ---
  duration_ms: 0.584167
  type: 'test'
  ...
# Subtest: act_now severity below 2.5, watch below 3.5
ok 1851 - act_now severity below 2.5, watch below 3.5
  ---
  duration_ms: 0.205541
  type: 'test'
  ...
# Subtest: trend computed vs prior window with ±0.3 threshold
ok 1852 - trend computed vs prior window with ±0.3 threshold
  ---
  duration_ms: 0.083709
  type: 'test'
  ...
# Subtest: no baseline ⇒ no_baseline trend
ok 1853 - no baseline ⇒ no_baseline trend
  ---
  duration_ms: 0.053292
  type: 'test'
  ...
# Subtest: systemic scope when most eligible doctors are affected — hospital-level action
ok 1854 - systemic scope when most eligible doctors are affected — hospital-level action
  ---
  duration_ms: 0.179333
  type: 'test'
  ...
# Subtest: concentrated scope names the affected doctors, worst first
ok 1855 - concentrated scope names the affected doctors, worst first
  ---
  duration_ms: 0.101959
  type: 'test'
  ...
# Subtest: mixed scope appends the lowest-scoring doctors to the systemic action
ok 1856 - mixed scope appends the lowest-scoring doctors to the systemic action
  ---
  duration_ms: 0.152666
  type: 'test'
  ...
# Subtest: insufficient eligible doctors falls back to systemic wording
ok 1857 - insufficient eligible doctors falls back to systemic wording
  ---
  duration_ms: 0.056125
  type: 'test'
  ...
# Subtest: doctors below doctorMinNotes are not eligible
ok 1858 - doctors below doctorMinNotes are not eligible
  ---
  duration_ms: 0.199541
  type: 'test'
  ...
# Subtest: ranking: act_now before watch, then mean ascending; healthy sorted best-first
ok 1859 - ranking: act_now before watch, then mean ascending; healthy sorted best-first
  ---
  duration_ms: 0.603875
  type: 'test'
  ...
# Subtest: thresholds are overridable
ok 1860 - thresholds are overridable
  ---
  duration_ms: 0.073042
  type: 'test'
  ...
# Subtest: lower_worse severity: completeness 74 act_now, 88 watch, 96 healthy
ok 1861 - lower_worse severity: completeness 74 act_now, 88 watch, 96 healthy
  ---
  duration_ms: 0.752459
  type: 'test'
  ...
# Subtest: higher_worse severity: interactions 25/100 act_now, 12 watch, 8 healthy
ok 1862 - higher_worse severity: interactions 25/100 act_now, 12 watch, 8 healthy
  ---
  duration_ms: 0.09625
  type: 'test'
  ...
# Subtest: direction-aware trend: rising interactions = worsening, rising completeness = improving
ok 1863 - direction-aware trend: rising interactions = worsening, rising completeness = improving
  ---
  duration_ms: 0.509166
  type: 'test'
  ...
# Subtest: scope: systemic when most doctors low; concentrated names them worst-first (higher_worse)
ok 1864 - scope: systemic when most doctors low; concentrated names them worst-first (higher_worse)
  ---
  duration_ms: 0.195166
  type: 'test'
  ...
# Subtest: placeholders substituted; fallbacks when absent
ok 1865 - placeholders substituted; fallbacks when absent
  ---
  duration_ms: 0.21175
  type: 'test'
  ...
# Subtest: low_value_rate is HELD by default; included with includeHeld + confidence estimate
ok 1866 - low_value_rate is HELD by default; included with includeHeld + confidence estimate
  ---
  duration_ms: 0.070459
  type: 'test'
  ...
# Subtest: kind discriminator and unit present on every domain signal
ok 1867 - kind discriminator and unit present on every domain signal
  ---
  duration_ms: 0.104375
  type: 'test'
  ...
# Subtest: mixed scope appends most-affected list to systemic action
ok 1868 - mixed scope appends most-affected list to systemic action
  ---
  duration_ms: 0.083167
  type: 'test'
  ...
# Subtest: bandFor and its thresholds are BYTE-IDENTICAL — hysteresis wraps, never replaces
ok 1869 - bandFor and its thresholds are BYTE-IDENTICAL — hysteresis wraps, never replaces
  ---
  duration_ms: 0.530833
  type: 'test'
  ...
# Subtest: NULL prior (first score at this version) ⇒ bandFor(index) — the anchor is set normally
ok 1870 - NULL prior (first score at this version) ⇒ bandFor(index) — the anchor is set normally
  ---
  duration_ms: 0.139667
  type: 'test'
  ...
# Subtest: THE TABLE (g = 3.87): each held band leaves exactly at its ± g edges
ok 1871 - THE TABLE (g = 3.87): each held band leaves exactly at its ± g edges
  ---
  duration_ms: 0.072375
  type: 'test'
  ...
# Subtest: a decisive crossing lands on bandFor(index), even across MULTIPLE bands
ok 1872 - a decisive crossing lands on bandFor(index), even across MULTIPLE bands
  ---
  duration_ms: 0.039458
  type: 'test'
  ...
# Subtest: THE POINT: a threshold-proximity wobble no longer flips the displayed band
ok 1873 - THE POINT: a threshold-proximity wobble no longer flips the displayed band
  ---
  duration_ms: 0.058417
  type: 'test'
  ...
# Subtest: the SQL CASE mirrors the pure function EXACTLY, built from the same HYSTERESIS_G
ok 1874 - the SQL CASE mirrors the pure function EXACTLY, built from the same HYSTERESIS_G
  ---
  duration_ms: 0.13725
  type: 'test'
  ...
# Subtest: all three write paths set displayed_band: insert anchor, conflict CASE, update CASE
ok 1875 - all three write paths set displayed_band: insert anchor, conflict CASE, update CASE
  ---
  duration_ms: 0.102541
  type: 'test'
  ...
# Subtest: deploy-before-migrate tolerance on BOTH writers and readers — 0029 not yet run ⇒ raw band, never a blank page
ok 1876 - deploy-before-migrate tolerance on BOTH writers and readers — 0029 not yet run ⇒ raw band, never a blank page
  ---
  duration_ms: 0.357166
  type: 'test'
  ...
# Subtest: every per-note band display renders displayed_band with the raw-band fallback
ok 1877 - every per-note band display renders displayed_band with the raw-band fallback
  ---
  duration_ms: 0.437542
  type: 'test'
  ...
# Subtest: migration 0029 is exactly one additive, idempotent statement
ok 1878 - migration 0029 is exactly one additive, idempotent statement
  ---
  duration_ms: 0.405333
  type: 'test'
  ...
# Subtest: engine version is current AND the read family includes it (the classic error, not repeated)
ok 1879 - engine version is current AND the read family includes it (the classic error, not repeated)
  ---
  duration_ms: 0.05725
  type: 'test'
  ...
# Subtest: S0 behaviour and worker dedup are UNTOUCHED by S1
ok 1880 - S0 behaviour and worker dedup are UNTOUCHED by S1
  ---
  duration_ms: 0.25875
  type: 'test'
  ...
# Subtest: the lab eval path knows nothing of hysteresis or displayed_band
ok 1881 - the lab eval path knows nothing of hysteresis or displayed_band
  ---
  duration_ms: 0.254167
  type: 'test'
  ...
# Subtest: precedence: explicit consult_type regex wins over everything
ok 1882 - precedence: explicit consult_type regex wins over everything
  ---
  duration_ms: 0.816084
  type: 'test'
  ...
# Subtest: consult_types markers: VISITING_HOSPITAL / EMERGENCY → in-person, and WIN over CHAT
ok 1883 - consult_types markers: VISITING_HOSPITAL / EMERGENCY → in-person, and WIN over CHAT
  ---
  duration_ms: 0.108208
  type: 'test'
  ...
# Subtest: consult_types markers: CHAT → tele (when no in-person marker); HOSPITAL_* + CHAT = tele
ok 1884 - consult_types markers: CHAT → tele (when no in-person marker); HOSPITAL_* + CHAT = tele
  ---
  duration_ms: 0.11075
  type: 'test'
  ...
# Subtest: fallback: form-type default when no markers (GENERAL_PRACTITIONER → tele; HOSPITAL_* → in-person)
ok 1885 - fallback: form-type default when no markers (GENERAL_PRACTITIONER → tele; HOSPITAL_* → in-person)
  ---
  duration_ms: 0.129417
  type: 'test'
  ...
# Subtest: hands-on-exam downgrade still applies AFTER classification (unchanged)
ok 1886 - hands-on-exam downgrade still applies AFTER classification (unchanged)
  ---
  duration_ms: 0.363166
  type: 'test'
  ...
# Subtest: formatEncounterChip: channel first, form second
ok 1887 - formatEncounterChip: channel first, form second
  ---
  duration_ms: 0.073917
  type: 'test'
  ...
# Subtest: parseConsultTypes: JS array / JSON string / PG array literal / empty → clean string[]
ok 1888 - parseConsultTypes: JS array / JSON string / PG array literal / empty → clean string[]
  ---
  duration_ms: 0.74025
  type: 'test'
  ...
# Subtest: currentVisitNote: prefers show_in_prescription; falls back to latest non-carried date_of_visit
ok 1889 - currentVisitNote: prefers show_in_prescription; falls back to latest non-carried date_of_visit
  ---
  duration_ms: 10.84425
  type: 'test'
  ...
# Subtest: parseTrimester: numeric / worded / derived-from-GA-weeks; null when unparseable
ok 1890 - parseTrimester: numeric / worded / derived-from-GA-weeks; null when unparseable
  ---
  duration_ms: 0.624584
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: llmLegFailedAfterParse: failed when the parse produced nothing PDQI-9-usable
ok 1891 - llmLegFailedAfterParse: failed when the parse produced nothing PDQI-9-usable
  ---
  duration_ms: 0.673125
  type: 'test'
  ...
# Subtest: the predicate is DELIBERATELY weaker than the lab guard — partial PDQI-9 passes in production
ok 1892 - the predicate is DELIBERATELY weaker than the lab guard — partial PDQI-9 passes in production
  ---
  duration_ms: 0.082041
  type: 'test'
  ...
# Subtest: exactly ONE bounded retry, gated on !opts.evalModel, whether the leg THREW or parsed to nothing
ok 1893 - exactly ONE bounded retry, gated on !opts.evalModel, whether the leg THREW or parsed to nothing
  ---
  duration_ms: 0.199542
  type: 'test'
  ...
# Subtest: a worse retry never replaces a partial first attempt
ok 1894 - a worse retry never replaces a partial first attempt
  ---
  duration_ms: 0.0595
  type: 'test'
  ...
# Subtest: the signal can NEVER be set on the eval path — lab rows must not carry production marks
ok 1895 - the signal can NEVER be set on the eval path — lab rows must not carry production marks
  ---
  duration_ms: 0.058791
  type: 'test'
  ...
# Subtest: the det-only fallback is marked UNCONDITIONALLY — every fallback row is a failed measurement
ok 1896 - the det-only fallback is marked UNCONDITIONALLY — every fallback row is a failed measurement
  ---
  duration_ms: 0.0825
  type: 'test'
  ...
# Subtest: the eval-path parse guards are UNCHANGED — d08bba7 is not the pattern here, but it still stands
ok 1897 - the eval-path parse guards are UNCHANGED — d08bba7 is not the pattern here, but it still stands
  ---
  duration_ms: 0.126291
  type: 'test'
  ...
# Subtest: saveOpdAudit writes the mark only when signal AND stored pdqi9 are both empty
ok 1898 - saveOpdAudit writes the mark only when signal AND stored pdqi9 are both empty
  ---
  duration_ms: 0.051875
  type: 'test'
  ...
# Subtest: a successful re-audit CLEARS a stale mark; house_account is preserved verbatim — both paths
ok 1899 - a successful re-audit CLEARS a stale mark; house_account is preserved verbatim — both paths
  ---
  duration_ms: 0.16825
  type: 'test'
  ...
# Subtest: D6 — the trap survives in its NARROWED form: only an incident makes a note re-auditable
ok 1900 - D6 — the trap survives in its NARROWED form: only an incident makes a note re-auditable
  ---
  duration_ms: 0.457708
  type: 'test'
  ...
# Subtest: addendum F v2 task 2 — a failed row never blocks a retry, a successful row is never overwritten
ok 1901 - addendum F v2 task 2 — a failed row never blocks a retry, a successful row is never overwritten
  ---
  duration_ms: 0.139708
  type: 'test'
  ...
# Subtest: the canonical id set still excludes marked rows — the mark IS the aggregate exclusion
ok 1902 - the canonical id set still excludes marked rows — the mark IS the aggregate exclusion
  ---
  duration_ms: 0.042125
  type: 'test'
  ...
# Subtest: EVERY enumerated aggregate/display reader excludes marked rows
ok 1903 - EVERY enumerated aggregate/display reader excludes marked rows
  ---
  duration_ms: 9.75825
  type: 'test'
  ...
# Subtest: the detail page suppresses the score and says exactly "Not assessed at this engine version"
ok 1904 - the detail page suppresses the score and says exactly "Not assessed at this engine version"
  ---
  duration_ms: 0.307333
  type: 'test'
  ...
# Subtest: the escalation package never hands a failed measurement to an external reviewer
ok 1905 - the escalation package never hands a failed measurement to an external reviewer
  ---
  duration_ms: 0.111417
  type: 'test'
  ...
# Subtest: the backfill predicate is the §5 / S0-gate predicate VERBATIM
ok 1906 - the backfill predicate is the §5 / S0-gate predicate VERBATIM
  ---
  duration_ms: 0.078834
  type: 'test'
  ...
# Subtest: DRY-RUN BY DEFAULT: the write happens only under ?apply=1, and the delta is always reported
ok 1907 - DRY-RUN BY DEFAULT: the write happens only under ?apply=1, and the delta is always reported
  ---
  duration_ms: 0.248
  type: 'test'
  ...
# Subtest: opd-note-score-core.ts knows nothing of any of this — no scoring change, no engine bump
ok 1908 - opd-note-score-core.ts knows nothing of any of this — no scoring change, no engine bump
  ---
  duration_ms: 0.207333
  type: 'test'
  ...
# Subtest: parseOpdAnalysis is untouched — the guard sits at the call site, production keeps the leniency
ok 1909 - parseOpdAnalysis is untouched — the guard sits at the call site, production keeps the leniency
  ---
  duration_ms: 0.15025
  type: 'test'
  ...
# Subtest: the lab batch path knows nothing of llmLegFailed
ok 1910 - the lab batch path knows nothing of llmLegFailed
  ---
  duration_ms: 0.502083
  type: 'test'
  ...
# Subtest: L1: TSH re-ordered within 42-day interval → one repeat_test finding citing the prior value
ok 1911 - L1: TSH re-ordered within 42-day interval → one repeat_test finding citing the prior value
  ---
  duration_ms: 4.652542
  type: 'test'
  ...
# Subtest: L1: HbA1c prior is OUTSIDE its 90-day interval → no finding
ok 1912 - L1: HbA1c prior is OUTSIDE its 90-day interval → no finding
  ---
  duration_ms: 0.162917
  type: 'test'
  ...
# Subtest: L1: an unmatched analyte (CBC — no canonical id) yields NO finding
ok 1913 - L1: an unmatched analyte (CBC — no canonical id) yields NO finding
  ---
  duration_ms: 0.235042
  type: 'test'
  ...
# Subtest: L1: analyte normalization matches note ↔ state (Vitamin D synonym within 90d)
ok 1914 - L1: analyte normalization matches note ↔ state (Vitamin D synonym within 90d)
  ---
  duration_ms: 0.097167
  type: 'test'
  ...
# Subtest: L1: the retest table keys on canonical analyte ids (house defaults)
ok 1915 - L1: the retest table keys on canonical analyte ids (house defaults)
  ---
  duration_ms: 0.05775
  type: 'test'
  ...
# Subtest: L2: re-prescription of a patient-reported-stopped drug → med_reconciliation citing the stop
ok 1916 - L2: re-prescription of a patient-reported-stopped drug → med_reconciliation citing the stop
  ---
  duration_ms: 0.244875
  type: 'test'
  ...
# Subtest: L2: continuation of an active prior prescription → med_reconciliation (duplicate continuation)
ok 1917 - L2: continuation of an active prior prescription → med_reconciliation (duplicate continuation)
  ---
  duration_ms: 0.078959
  type: 'test'
  ...
# Subtest: L2: no false match — a drug not in the prior state produces nothing
ok 1918 - L2: no false match — a drug not in the prior state produces nothing
  ---
  duration_ms: 0.106208
  type: 'test'
  ...
# Subtest: L2: both cases fire together for a mixed note
ok 1919 - L2: both cases fire together for a mixed note
  ---
  duration_ms: 0.245459
  type: 'test'
  ...
# Subtest: L3-det: a severe open care gap not re-ordered / not mentioned → missed_followup
ok 1920 - L3-det: a severe open care gap not re-ordered / not mentioned → missed_followup
  ---
  duration_ms: 1.687625
  type: 'test'
  ...
# Subtest: L3-det: ORDERING the analyte in the note suppresses the finding (addressed)
ok 1921 - L3-det: ORDERING the analyte in the note suppresses the finding (addressed)
  ---
  duration_ms: 0.413209
  type: 'test'
  ...
# Subtest: L3-det: MENTIONING the analyte in the impression suppresses the finding
ok 1922 - L3-det: MENTIONING the analyte in the impression suppresses the finding
  ---
  duration_ms: 0.615208
  type: 'test'
  ...
# Subtest: battery: the full deterministic pass yields L1 + L2×2 + L3 on the fixture
ok 1923 - battery: the full deterministic pass yields L1 + L2×2 + L3 on the fixture
  ---
  duration_ms: 0.99
  type: 'test'
  ...
# Subtest: serializer: emits the priority-ordered sections and stays under the char budget
ok 1924 - serializer: emits the priority-ordered sections and stays under the char budget
  ---
  duration_ms: 1.876708
  type: 'test'
  ...
# Subtest: serializer: validMonths grounds only real encounter months
ok 1925 - serializer: validMonths grounds only real encounter months
  ---
  duration_ms: 1.993167
  type: 'test'
  ...
# Subtest: serializer: truncates tail-first when over budget (header survives, last section dropped)
ok 1926 - serializer: truncates tail-first when over budget (header survives, last section dropped)
  ---
  duration_ms: 0.88725
  type: 'test'
  ...
# Subtest: serializer: de-identified — no uid / member identifier can leak (serializer takes none)
ok 1927 - serializer: de-identified — no uid / member identifier can leak (serializer takes none)
  ---
  duration_ms: 0.47825
  type: 'test'
  ...
# Subtest: buildLongitudinalUser: notes the teleconsult fairness guard in the payload
ok 1928 - buildLongitudinalUser: notes the teleconsult fairness guard in the payload
  ---
  duration_ms: 0.443375
  type: 'test'
  ...
# Subtest: LLM parse: a grounded finding is kept and mapped to the right signal type
ok 1929 - LLM parse: a grounded finding is kept and mapped to the right signal type
  ---
  duration_ms: 0.526417
  type: 'test'
  ...
# Subtest: LLM parse: an UNGROUNDED finding (cited date not in context) is dropped (no hindsight)
ok 1930 - LLM parse: an UNGROUNDED finding (cited date not in context) is dropped (no hindsight)
  ---
  duration_ms: 0.224667
  type: 'test'
  ...
# Subtest: LLM parse: continuity is the default type; malformed JSON → []
ok 1931 - LLM parse: continuity is the default type; malformed JSON → []
  ---
  duration_ms: 0.527459
  type: 'test'
  ...
# Subtest: stampLongitudinal: assigns a finding_ref but PRESERVES the explicit longitudinal signal_type
ok 1932 - stampLongitudinal: assigns a finding_ref but PRESERVES the explicit longitudinal signal_type
  ---
  duration_ms: 3.143083
  type: 'test'
  ...
# Subtest: suppression pass-through: an active suppression drops a longitudinal type like any finding
ok 1933 - suppression pass-through: an active suppression drops a longitudinal type like any finding
  ---
  duration_ms: 0.972375
  type: 'test'
  ...
# Subtest: confidenceFor: 0 → none, 1-2 → thin, ≥3 → established
ok 1934 - confidenceFor: 0 → none, 1-2 → thin, ≥3 → established
  ---
  duration_ms: 0.047375
  type: 'test'
  ...
# Subtest: emptyLongitudinalBlock: carries the honest excluded_reason and zero findings
ok 1935 - emptyLongitudinalBlock: carries the honest excluded_reason and zero findings
  ---
  duration_ms: 0.054958
  type: 'test'
  ...
# Subtest: buildLongitudinalInput: null without uid/date; a clean projection that never mutates the case
ok 1936 - buildLongitudinalInput: null without uid/date; a clean projection that never mutates the case
  ---
  duration_ms: 0.140791
  type: 'test'
  ...
# Subtest: zero-drift: the battery + serializer + stamp never mutate the snapshot or note input
ok 1937 - zero-drift: the battery + serializer + stamp never mutate the snapshot or note input
  ---
  duration_ms: 0.669208
  type: 'test'
  ...
# Subtest: buildLongitudinalGates seeds all 5 longitudinal types at 0/0
ok 1938 - buildLongitudinalGates seeds all 5 longitudinal types at 0/0
  ---
  duration_ms: 1.473791
  type: 'test'
  ...
# Subtest: overlays signal-health decided → labelled and fp_rate → fpRate for longitudinal types
ok 1939 - overlays signal-health decided → labelled and fp_rate → fpRate for longitudinal types
  ---
  duration_ms: 0.349
  type: 'test'
  ...
# Subtest: ignores non-longitudinal (routable) signal types from signal-health
ok 1940 - ignores non-longitudinal (routable) signal types from signal-health
  ---
  duration_ms: 0.257333
  type: 'test'
  ...
# Subtest: clamps out-of-range / non-finite fp_rate and negative decided
ok 1941 - clamps out-of-range / non-finite fp_rate and negative decided
  ---
  duration_ms: 0.250042
  type: 'test'
  ...
# Subtest: gates feed buildLabelLane → promotion status matches promotionGate directly
ok 1942 - gates feed buildLabelLane → promotion status matches promotionGate directly
  ---
  duration_ms: 0.406834
  type: 'test'
  ...
# Subtest: lane only contains non-routable longitudinal types (routable dropped)
ok 1943 - lane only contains non-routable longitudinal types (routable dropped)
  ---
  duration_ms: 0.097958
  type: 'test'
  ...
# Subtest: classifyLvcCategory: antibiotic | imaging | supplement | other
ok 1944 - classifyLvcCategory: antibiotic | imaging | supplement | other
  ---
  duration_ms: 3.170791
  type: 'test'
  ...
# Subtest: stampLvcMetadata: low-value findings get rule_ref:null + lvc_category; others untouched; score fields preserved
ok 1945 - stampLvcMetadata: low-value findings get rule_ref:null + lvc_category; others untouched; score fields preserved
  ---
  duration_ms: 0.177583
  type: 'test'
  ...
# Subtest: stampLvcMetadata preserves an existing rule_ref
ok 1946 - stampLvcMetadata preserves an existing rule_ref
  ---
  duration_ms: 0.105875
  type: 'test'
  ...
# Subtest: classifyLvcFinding: verdict tier authoritative; non-low-value / informational are not LVC
ok 1947 - classifyLvcFinding: verdict tier authoritative; non-low-value / informational are not LVC
  ---
  duration_ms: 0.107208
  type: 'test'
  ...
# Subtest: classifyLvcFinding: stamped row passes its metadata through
ok 1948 - classifyLvcFinding: stamped row passes its metadata through
  ---
  duration_ms: 0.366
  type: 'test'
  ...
# Subtest: classifyLvcFinding: fallback text-match to a rule (older engine, no stamp)
ok 1949 - classifyLvcFinding: fallback text-match to a rule (older engine, no stamp)
  ---
  duration_ms: 0.365708
  type: 'test'
  ...
# Subtest: precision gate: suppress via ledger decision on lvc:<rule_ref>; default keeps all
ok 1950 - precision gate: suppress via ledger decision on lvc:<rule_ref>; default keeps all
  ---
  duration_ms: 0.0995
  type: 'test'
  ...
# Subtest: LVC_CATEGORIES vocabulary — 3 base + 8 overuse sub-tags + other (0.81.8 Part B)
ok 1951 - LVC_CATEGORIES vocabulary — 3 base + 8 overuse sub-tags + other (0.81.8 Part B)
  ---
  duration_ms: 0.096375
  type: 'test'
  ...
# Subtest: matcher v3: OR across keywords — alternative trigger phrases (the CW-rule fix)
ok 1952 - matcher v3: OR across keywords — alternative trigger phrases (the CW-rule fix)
  ---
  duration_ms: 0.286708
  type: 'test'
  ...
# Subtest: matcher v3: AND within a keyword — every token must be a whole word
ok 1953 - matcher v3: AND within a keyword — every token must be a whole word
  ---
  duration_ms: 0.335417
  type: 'test'
  ...
# Subtest: matcher v3.1: longest matched phrase wins when it wins alone; any top-specificity tie → null
ok 1954 - matcher v3.1: longest matched phrase wins when it wins alone; any top-specificity tie → null
  ---
  duration_ms: 0.278
  type: 'test'
  ...
# Subtest: matcher v3: bare 1-token keyword over-matches under OR (why CBP is re-authored in data, 26a)
ok 1955 - matcher v3: bare 1-token keyword over-matches under OR (why CBP is re-authored in data, 26a)
  ---
  duration_ms: 0.120833
  type: 'test'
  ...
# Subtest: matcher v3: zero-keyword / empty-token rules never match; category from matched rule
ok 1956 - matcher v3: zero-keyword / empty-token rules never match; category from matched rule
  ---
  duration_ms: 0.063042
  type: 'test'
  ...
# Subtest: stampLvcMetadata: no rules → rule_ref null; non-low-value + informational skipped; scores untouched
ok 1957 - stampLvcMetadata: no rules → rule_ref null; non-low-value + informational skipped; scores untouched
  ---
  duration_ms: 1.695709
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: no normative hits ⇒ assembleAuditContext is byte-identical to today's assembly
ok 1958 - no normative hits ⇒ assembleAuditContext is byte-identical to today's assembly
  ---
  duration_ms: 1.208959
  type: 'test'
  ...
# Subtest: channel mode: the literature retrieve opts are unchanged — useNormativeLeg is NOT set
ok 1959 - channel mode: the literature retrieve opts are unchanged — useNormativeLeg is NOT set
  ---
  duration_ms: 0.212583
  type: 'test'
  ...
# Subtest: normativeChannelOpts: standalone CW-only search — restrictSources, topK 4, leg NOT set
ok 1960 - normativeChannelOpts: standalone CW-only search — restrictSources, topK 4, leg NOT set
  ---
  duration_ms: 0.159959
  type: 'test'
  ...
# Subtest: channel context: literature [1-8] then the labelled normative block [9+]
ok 1961 - channel context: literature [1-8] then the labelled normative block [9+]
  ---
  duration_ms: 0.121292
  type: 'test'
  ...
# Subtest: numbering adapts when fewer than 8 literature excerpts return
ok 1962 - numbering adapts when fewer than 8 literature excerpts return
  ---
  duration_ms: 0.11775
  type: 'test'
  ...
# Subtest: buildNormativeBlock: empty hits ⇒ empty string (audit proceeds on literature alone)
ok 1963 - buildNormativeBlock: empty hits ⇒ empty string (audit proceeds on literature alone)
  ---
  duration_ms: 0.040042
  type: 'test'
  ...
# Subtest: evalNormativeChannel is independent of evalNormativeLeg — no union, no eviction
ok 1964 - evalNormativeChannel is independent of evalNormativeLeg — no union, no eviction
  ---
  duration_ms: 0.151333
  type: 'test'
  ...
# Subtest: the eval path still writes lab_analyses only — never opd_note_audits
ok 1965 - the eval path still writes lab_analyses only — never opd_note_audits
  ---
  duration_ms: 0.238
  type: 'test'
  ...
# Subtest: OPD_AUDIT_SYSTEM is untouched — the channel header is not injected into the system prompt
ok 1966 - OPD_AUDIT_SYSTEM is untouched — the channel header is not injected into the system prompt
  ---
  duration_ms: 0.332292
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: flag off ⇒ opts byte-identical to today (no useNormativeLeg key)
ok 1967 - flag off ⇒ opts byte-identical to today (no useNormativeLeg key)
  ---
  duration_ms: 1.850458
  type: 'test'
  ...
# Subtest: flag on + non-mini ⇒ useNormativeLeg: true
ok 1968 - flag on + non-mini ⇒ useNormativeLeg: true
  ---
  duration_ms: 0.215292
  type: 'test'
  ...
# Subtest: flag on + mini ⇒ no useNormativeLeg key (mini path can never enable the leg)
ok 1969 - flag on + mini ⇒ no useNormativeLeg key (mini path can never enable the leg)
  ---
  duration_ms: 0.120083
  type: 'test'
  ...
# Subtest: only OPD_NORMATIVE_LEG_ENABLED === "1" enables the leg
ok 1970 - only OPD_NORMATIVE_LEG_ENABLED === "1" enables the leg
  ---
  duration_ms: 0.560542
  type: 'test'
  ...
# Subtest: rowToOpdCase parses stringified JSONB + separates de-identified case from keys
ok 1971 - rowToOpdCase parses stringified JSONB + separates de-identified case from keys
  ---
  duration_ms: 3.505625
  type: 'test'
  ...
# Subtest: rowToOpdCase reads the NESTED GP fields (the extraction fix)
ok 1972 - rowToOpdCase reads the NESTED GP fields (the extraction fix)
  ---
  duration_ms: 1.383208
  type: 'test'
  ...
# Subtest: rowToOpdCase prefers the dpipe pipeline content over the nested source fields
ok 1973 - rowToOpdCase prefers the dpipe pipeline content over the nested source fields
  ---
  duration_ms: 0.431917
  type: 'test'
  ...
# Subtest: 0.6: referral handoff — leaflet excluded, referral + teleconsult surfaced
ok 1974 - 0.6: referral handoff — leaflet excluded, referral + teleconsult surfaced
  ---
  duration_ms: 0.777084
  type: 'test'
  ...
# Subtest: 0.6: teleconsult completeness — examination is not scored (N/A), referral counts as the plan
ok 1975 - 0.6: teleconsult completeness — examination is not scored (N/A), referral counts as the plan
  ---
  duration_ms: 1.066416
  type: 'test'
  ...
# Subtest: opdCompleteness flags the real gaps; allergy + history items removed
ok 1976 - opdCompleteness flags the real gaps; allergy + history items removed
  ---
  duration_ms: 0.723458
  type: 'test'
  ...
# Subtest: route inference: documented → used; blank → inferred from form; no form → null (real gap)
ok 1977 - route inference: documented → used; blank → inferred from form; no form → null (real gap)
  ---
  duration_ms: 0.457083
  type: 'test'
  ...
# Subtest: dose documented from the field, the strength field, or the strength embedded in the drug name
ok 1978 - dose documented from the field, the strength field, or the strength embedded in the drug name
  ---
  duration_ms: 0.515625
  type: 'test'
  ...
# Subtest: prescribingChecks: dosing gap only when route is truly ambiguous / amount is absent (0.5)
ok 1979 - prescribingChecks: dosing gap only when route is truly ambiguous / amount is absent (0.5)
  ---
  duration_ms: 1.52925
  type: 'test'
  ...
# Subtest: prescribingChecks: unverified brand, duplicate by RESOLVED generic, high-alert info (v0.4)
ok 1980 - prescribingChecks: unverified brand, duplicate by RESOLVED generic, high-alert info (v0.4)
  ---
  duration_ms: 1.289375
  type: 'test'
  ...
# Subtest: parseOpdAnalysis extracts findings + PDQI-9 + suggestions and clamps citations
ok 1981 - parseOpdAnalysis extracts findings + PDQI-9 + suggestions and clamps citations
  ---
  duration_ms: 0.720541
  type: 'test'
  ...
# Subtest: C1: parseOpdAnalysis strips a reasoning <think> block (DeepSeek-R1) before parsing
ok 1982 - C1: parseOpdAnalysis strips a reasoning <think> block (DeepSeek-R1) before parsing
  ---
  duration_ms: 0.243375
  type: 'test'
  ...
# Subtest: opdSignalType maps every deterministic subject shape to the controlled vocab
ok 1983 - opdSignalType maps every deterministic subject shape to the controlled vocab
  ---
  duration_ms: 1.670375
  type: 'test'
  ...
# Subtest: opdSignalType: LLM subjects — antibiotic rule, coarse domain×verdict buckets, general fallback
ok 1984 - opdSignalType: LLM subjects — antibiotic rule, coarse domain×verdict buckets, general fallback
  ---
  duration_ms: 1.014333
  type: 'test'
  ...
# Subtest: stampFindingIdentity: stable refs, severity-change stable, distinct details distinct
ok 1985 - stampFindingIdentity: stable refs, severity-change stable, distinct details distinct
  ---
  duration_ms: 2.396791
  type: 'test'
  ...
# Subtest: 0.81.11: form/dosageForm are inert — prescribingChecks output is byte-identical with them present vs absent
ok 1986 - 0.81.11: form/dosageForm are inert — prescribingChecks output is byte-identical with them present vs absent
  ---
  duration_ms: 0.523125
  type: 'test'
  ...
# Subtest: 0.81.12 CANARY: guideline-recommended vaccine co-administration produces NO finding (LASA deleted)
ok 1987 - 0.81.12 CANARY: guideline-recommended vaccine co-administration produces NO finding (LASA deleted)
  ---
  duration_ms: 0.128
  type: 'test'
  ...
# Subtest: 0.81.12 (Stage 2a): the SCORING molecule-subset dedup is NOT present — a mono+FDC produces no new penalty
ok 1988 - 0.81.12 (Stage 2a): the SCORING molecule-subset dedup is NOT present — a mono+FDC produces no new penalty
  ---
  duration_ms: 0.102583
  type: 'test'
  ...
# Subtest: 0.81.10: a low-value deterministic finding RETAINS its specific signal_type (no collapse to low_value_care)
ok 1989 - 0.81.10: a low-value deterministic finding RETAINS its specific signal_type (no collapse to low_value_care)
  ---
  duration_ms: 0.335708
  type: 'test'
  ...
# Subtest: 0.81.10: the muscle-relaxant documentation subject maps to signal_type muscle_relaxant_indication
ok 1990 - 0.81.10: the muscle-relaxant documentation subject maps to signal_type muscle_relaxant_indication
  ---
  duration_ms: 0.044833
  type: 'test'
  ...
# Subtest: stampFindingIdentity: within-note collision suffixes \#2, \#3 deterministically
ok 1991 - stampFindingIdentity: within-note collision suffixes \#2, \#3 deterministically
  ---
  duration_ms: 0.147667
  type: 'test'
  ...
# Subtest: stampFindingIdentity: every finding stamped non-empty (acceptance, spec §2)
ok 1992 - stampFindingIdentity: every finding stamped non-empty (acceptance, spec §2)
  ---
  duration_ms: 0.160083
  type: 'test'
  ...
# Subtest: opdCaseText includes the treating specialty line when provided (B4)
ok 1993 - opdCaseText includes the treating specialty line when provided (B4)
  ---
  duration_ms: 0.408583
  type: 'test'
  ...
# Subtest: followUpDocumented + completeness: UNKNOWN/blank excluded, real dispositions count (B2)
ok 1994 - followUpDocumented + completeness: UNKNOWN/blank excluded, real dispositions count (B2)
  ---
  duration_ms: 0.368583
  type: 'test'
  ...
# Subtest: completeness coverage excludes continuity fields — scored once (0.8)
ok 1995 - completeness coverage excludes continuity fields — scored once (0.8)
  ---
  duration_ms: 0.192667
  type: 'test'
  ...
# Subtest: opdCaseText marks a zero-medication note explicitly (B1)
ok 1996 - opdCaseText marks a zero-medication note explicitly (B1)
  ---
  duration_ms: 0.075875
  type: 'test'
  ...
# Subtest: v0.81 BUG-0.8-04: HOSPITAL_* prescription types are IN-PERSON, not teleconsult
ok 1997 - v0.81 BUG-0.8-04: HOSPITAL_* prescription types are IN-PERSON, not teleconsult
  ---
  duration_ms: 0.043709
  type: 'test'
  ...
# Subtest: v0.81 FIX I: a documented hands-on exam downgrades a teleconsult classification
ok 1998 - v0.81 FIX I: a documented hands-on exam downgrades a teleconsult classification
  ---
  duration_ms: 0.186041
  type: 'test'
  ...
# Subtest: v0.81 BUG-0.8-04: HOSPITAL_GP in-person note IS scored on examination
ok 1999 - v0.81 BUG-0.8-04: HOSPITAL_GP in-person note IS scored on examination
  ---
  duration_ms: 0.126542
  type: 'test'
  ...
# Subtest: v0.81 BUG-0.8-05/07: stacked findings degrade gracefully, never a flat 0; single finding unchanged
ok 2000 - v0.81 BUG-0.8-05/07: stacked findings degrade gracefully, never a flat 0; single finding unchanged
  ---
  duration_ms: 0.575083
  type: 'test'
  ...
# Subtest: v0.81 BUG-0.8-03: a formal referral counts as documented follow-up
ok 2001 - v0.81 BUG-0.8-03: a formal referral counts as documented follow-up
  ---
  duration_ms: 0.1115
  type: 'test'
  ...
# Subtest: v0.81 BUG-0.8-01: injectable concentration is not a dose; oral strength still counts
ok 2002 - v0.81 BUG-0.8-01: injectable concentration is not a dose; oral strength still counts
  ---
  duration_ms: 0.108667
  type: 'test'
  ...
# Subtest: v0.81.1 P1: reasoning rubric judges by presentation, not sparseness
ok 2003 - v0.81.1 P1: reasoning rubric judges by presentation, not sparseness
  ---
  duration_ms: 0.139291
  type: 'test'
  ...
# Subtest: v0.81.1 P/O/F/N: prompt-hardening guards are present
ok 2004 - v0.81.1 P/O/F/N: prompt-hardening guards are present
  ---
  duration_ms: 0.047
  type: 'test'
  ...
# Subtest: v0.81.1 O-render: an impression without an ICD code is not shown as "(none documented)"
ok 2005 - v0.81.1 O-render: an impression without an ICD code is not shown as "(none documented)"
  ---
  duration_ms: 0.103792
  type: 'test'
  ...
# Subtest: v0.81.1 D (BUG-0.8-02): a nested diagnosis is not dropped when dpipe captured only one
ok 2006 - v0.81.1 D (BUG-0.8-02): a nested diagnosis is not dropped when dpipe captured only one
  ---
  duration_ms: 0.139834
  type: 'test'
  ...
# Subtest: v0.81.1 K: in-person febrile note with no vitals gets a documentation gap; controls do not
ok 2007 - v0.81.1 K: in-person febrile note with no vitals gets a documentation gap; controls do not
  ---
  duration_ms: 0.382208
  type: 'test'
  ...
# Subtest: BUG-0.8-12: consolidateDecisions merges the deterministic NSAID interaction + LLM duplication
ok 2008 - BUG-0.8-12: consolidateDecisions merges the deterministic NSAID interaction + LLM duplication
  ---
  duration_ms: 0.272167
  type: 'test'
  ...
# Subtest: BUG-0.8-12: consolidateDecisions is a no-op when there is no deterministic NSAID interaction
ok 2009 - BUG-0.8-12: consolidateDecisions is a no-op when there is no deterministic NSAID interaction
  ---
  duration_ms: 0.05075
  type: 'test'
  ...
# Subtest: BUG-0.8-16: an "inaccurate drug class" finding is neutralised (non-scoring) not a clinician penalty
ok 2010 - BUG-0.8-16: an "inaccurate drug class" finding is neutralised (non-scoring) not a clinician penalty
  ---
  duration_ms: 1.327375
  type: 'test'
  ...
# Subtest: Q (0.8-10): an NSAID ingredient is detected inside a combination whose primary is a non-NSAID
ok 2011 - Q (0.8-10): an NSAID ingredient is detected inside a combination whose primary is a non-NSAID
  ---
  duration_ms: 1.04825
  type: 'test'
  ...
# Subtest: R (0.8-11): a muscle relaxant is detected + consolidateDecisions drops the LLM version when a deterministic one exists
ok 2012 - R (0.8-11): a muscle relaxant is detected + consolidateDecisions drops the LLM version when a deterministic one exists
  ---
  duration_ms: 0.281625
  type: 'test'
  ...
# Subtest: Part 1: an ICD/coding-completeness gap finding is neutralised to non-scoring
ok 2013 - Part 1: an ICD/coding-completeness gap finding is neutralised to non-scoring
  ---
  duration_ms: 0.470125
  type: 'test'
  ...
# Subtest: obstetric adapter (flag ON): populates canonical fields from the obstetric template + current-visit selection
ok 2014 - obstetric adapter (flag ON): populates canonical fields from the obstetric template + current-visit selection
  ---
  duration_ms: 1.433
  type: 'test'
  ...
# Subtest: obstetric adapter (flag OFF): the obstetric note audits via the GP path, byte-identical (no isObstetric)
ok 2015 - obstetric adapter (flag OFF): the obstetric note audits via the GP path, byte-identical (no isObstetric)
  ---
  duration_ms: 0.251541
  type: 'test'
  ...
# Subtest: obstetric mandatory set: SFH/FHR/presentation required only in the 2nd/3rd trimester
ok 2016 - obstetric mandatory set: SFH/FHR/presentation required only in the 2nd/3rd trimester
  ---
  duration_ms: 0.603708
  type: 'test'
  ...
# Subtest: obstetric vitals: BP never mandatory (credited if present); weight is the required vital
ok 2017 - obstetric vitals: BP never mandatory (credited if present); weight is the required vital
  ---
  duration_ms: 0.2775
  type: 'test'
  ...
# Subtest: obstetric mandatory set: rich note near-complete; follow-up scored in Continuity not Documentation
ok 2018 - obstetric mandatory set: rich note near-complete; follow-up scored in Continuity not Documentation
  ---
  duration_ms: 0.198625
  type: 'test'
  ...
# Subtest: obstetricDosingComplete: a 1-0-1 schedule counts even with a blank frequency field
ok 2019 - obstetricDosingComplete: a 1-0-1 schedule counts even with a blank frequency field
  ---
  duration_ms: 0.135959
  type: 'test'
  ...
# Subtest: bpDocumented reads BP from the obstetric narrative (no structured BP column in db13, §9)
ok 2020 - bpDocumented reads BP from the obstetric narrative (no structured BP column in db13, §9)
  ---
  duration_ms: 0.142083
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 2: high-alert name-collision artifacts excluded at molecule level; real high-alerts + injectable MgSO4 still fire
ok 2021 - 0.81.14 Ruling 2: high-alert name-collision artifacts excluded at molecule level; real high-alerts + injectable MgSO4 still fire
  ---
  duration_ms: 0.67625
  type: 'test'
  ...
# Subtest: A-9: a non-obstetric note with an LMP gains NO mandatory LMP field; the obstetric path keeps it mandatory
ok 2022 - A-9: a non-obstetric note with an LMP gains NO mandatory LMP field; the obstetric path keeps it mandatory
  ---
  duration_ms: 0.313167
  type: 'test'
  ...
# Subtest: a complete, high-quality note scores in band A
ok 2023 - a complete, high-quality note scores in band A
  ---
  duration_ms: 0.713
  type: 'test'
  ...
# Subtest: CANARY: three co-prescribed major interactions score prescribing safety 26/100, never 100
ok 2024 - CANARY: three co-prescribed major interactions score prescribing safety 26/100, never 100
  ---
  duration_ms: 0.183375
  type: 'test'
  ...
# Subtest: 0.81.10: an informational finding (the retired muscle-relaxant prompt) does NOT enter the score
ok 2025 - 0.81.10: an informational finding (the retired muscle-relaxant prompt) does NOT enter the score
  ---
  duration_ms: 0.0925
  type: 'test'
  ...
# Subtest: a poor note (gaps + low-value order + prescribing issue + weak PDQI) scores low
ok 2026 - a poor note (gaps + low-value order + prescribing issue + weak PDQI) scores low
  ---
  duration_ms: 0.112459
  type: 'test'
  ...
# Subtest: PDQI-9 not assessed → note_quality weight collapses to 0 (does not drag the index)
ok 2027 - PDQI-9 not assessed → note_quality weight collapses to 0 (does not drag the index)
  ---
  duration_ms: 0.118292
  type: 'test'
  ...
# Subtest: PDQI-9 partial ratings average only the provided attributes
ok 2028 - PDQI-9 partial ratings average only the provided attributes
  ---
  duration_ms: 0.062875
  type: 'test'
  ...
# Subtest: weights are sane
ok 2029 - weights are sane
  ---
  duration_ms: 0.106916
  type: 'test'
  ...
# Subtest: documentationAdequacyFlag fires only when fields (near-)complete AND thoroughness/synthesis low
ok 2030 - documentationAdequacyFlag fires only when fields (near-)complete AND thoroughness/synthesis low
  ---
  duration_ms: 0.064459
  type: 'test'
  ...
# Subtest: computeOpdScore surfaces the thin-documentation flag without changing scores
ok 2031 - computeOpdScore surfaces the thin-documentation flag without changing scores
  ---
  duration_ms: 0.208458
  type: 'test'
  ...
# Subtest: §4.1: concept_id "underuse:…" + source llm ⇒ direction underuse
ok 2032 - §4.1: concept_id "underuse:…" + source llm ⇒ direction underuse
  ---
  duration_ms: 0.779333
  type: 'test'
  ...
# Subtest: §4.1: an underuse finding contributes ZERO penalty
ok 2033 - §4.1: an underuse finding contributes ZERO penalty
  ---
  duration_ms: 0.427041
  type: 'test'
  ...
# Subtest: §4.1 pinned DELIBERATELY: the same finding with NO concept_id emerges with NO direction — the fresh-path behaviour, so a future change to it is visible
ok 2034 - §4.1 pinned DELIBERATELY: the same finding with NO concept_id emerges with NO direction — the fresh-path behaviour, so a future change to it is visible
  ---
  duration_ms: 0.057667
  type: 'test'
  ...
# Subtest: overuse: prefix stamps overuse (the four measured 0.81.17 exhibits — non-antibiotic subjects)
ok 2035 - overuse: prefix stamps overuse (the four measured 0.81.17 exhibits — non-antibiotic subjects)
  ---
  duration_ms: 0.124875
  type: 'test'
  ...
# Subtest: §4.2 (D-6): documentation: and process: prefixes set no direction — absent stays the honest default
ok 2036 - §4.2 (D-6): documentation: and process: prefixes set no direction — absent stays the honest default
  ---
  duration_ms: 0.055958
  type: 'test'
  ...
# Subtest: §4.3 (D-3): the value written as based_on_coded_at IS the value read — identity, not recency
ok 2037 - §4.3 (D-3): the value written as based_on_coded_at IS the value read — identity, not recency
  ---
  duration_ms: 0.369209
  type: 'test'
  ...
# Subtest: the watermark SQL binds based_on_coded_at as $3 and reserves now() for rescored_at only
ok 2038 - the watermark SQL binds based_on_coded_at as $3 and reserves now() for rescored_at only
  ---
  duration_ms: 0.1485
  type: 'test'
  ...
# Subtest: the route passes the coded_at from the CANDIDATE SELECT and never re-reads it after the update
ok 2039 - the route passes the coded_at from the CANDIDATE SELECT and never re-reads it after the update
  ---
  duration_ms: 0.100208
  type: 'test'
  ...
# Subtest: candidate SQL: engine versions are a BOUND array param — unknown version ⇒ zero rows, never a throw
ok 2040 - candidate SQL: engine versions are a BOUND array param — unknown version ⇒ zero rows, never a throw
  ---
  duration_ms: 0.2195
  type: 'test'
  ...
# Subtest: candidate SQL: candidacy = the coder touched the note more recently than the last re-score observed
ok 2041 - candidate SQL: candidacy = the coder touched the note more recently than the last re-score observed
  ---
  duration_ms: 0.287542
  type: 'test'
  ...
# Subtest: candidate SQL tolerates migration 0029 not having run (displayed_band variant)
ok 2042 - candidate SQL tolerates migration 0029 not having run (displayed_band variant)
  ---
  duration_ms: 0.049083
  type: 'test'
  ...
# Subtest: ?limit= — default 800, clamped 1..3000, junk lands on the default
ok 2043 - ?limit= — default 800, clamped 1..3000, junk lands on the default
  ---
  duration_ms: 0.058709
  type: 'test'
  ...
# Subtest: A-1 §1: resolveEngineFilter(null) returns the whole family
ok 2044 - A-1 §1: resolveEngineFilter(null) returns the whole family
  ---
  duration_ms: 0.105042
  type: 'test'
  ...
# Subtest: A-1 §2: an exact family member narrows to exactly that one version
ok 2045 - A-1 §2: an exact family member narrows to exactly that one version
  ---
  duration_ms: 0.037333
  type: 'test'
  ...
# Subtest: A-1 §3: an unknown version yields [] — the fail-safe, never a widened scope
ok 2046 - A-1 §3: an unknown version yields [] — the fail-safe, never a widened scope
  ---
  duration_ms: 0.264542
  type: 'test'
  ...
# Subtest: A-1 §4: an injection-shaped value yields [] and never reaches the query as a live term
ok 2047 - A-1 §4: an injection-shaped value yields [] and never reaches the query as a live term
  ---
  duration_ms: 0.432333
  type: 'test'
  ...
# Subtest: A-1 §5: the report's engine_versions reflects the FILTERED list, not the family
ok 2048 - A-1 §5: the report's engine_versions reflects the FILTERED list, not the family
  ---
  duration_ms: 0.095959
  type: 'test'
  ...
# Subtest: a candidate-query error degrades to an EMPTY report — never a 500
ok 2049 - a candidate-query error degrades to an EMPTY report — never a 500
  ---
  duration_ms: 0.260542
  type: 'test'
  ...
# Subtest: finalize() runs stampDirection on the reuse path — the moment that already works
ok 2050 - finalize() runs stampDirection on the reuse path — the moment that already works
  ---
  duration_ms: 0.086459
  type: 'test'
  ...
# Subtest: the route threads each row's OWN engine_version into auditOpdNote, so the UPDATE is in place
ok 2051 - the route threads each row's OWN engine_version into auditOpdNote, so the UPDATE is in place
  ---
  duration_ms: 0.035709
  type: 'test'
  ...
# Subtest: ?apply=1 is the ONLY write switch — read-only without it
ok 2052 - ?apply=1 is the ONLY write switch — read-only without it
  ---
  duration_ms: 0.049125
  type: 'test'
  ...
# Subtest: §2.7: no cron, no ?auto=1, no scheduler — cadence is V's decision, later
ok 2053 - §2.7: no cron, no ?auto=1, no scheduler — cadence is V's decision, later
  ---
  duration_ms: 0.181875
  type: 'test'
  ...
# Subtest: hysteresis is NOT this build's code — the band rides updateOpdAudit (D-4), the report only mirrors it
ok 2054 - hysteresis is NOT this build's code — the band rides updateOpdAudit (D-4), the report only mirrors it
  ---
  duration_ms: 0.043667
  type: 'test'
  ...
# Subtest: reduceRescoreReport counts direction/index/band movement directly and samples ≤ 20 movers
ok 2055 - reduceRescoreReport counts direction/index/band movement directly and samples ≤ 20 movers
  ---
  duration_ms: 0.08775
  type: 'test'
  ...
# Subtest: A-2 §1: one skipped + one error outcome count into apply_skipped 1 / apply_error 1
ok 2056 - A-2 §1: one skipped + one error outcome count into apply_skipped 1 / apply_error 1
  ---
  duration_ms: 0.056708
  type: 'test'
  ...
# Subtest: A-2 §2: first_apply_error is the FIRST non-empty error message, null when none occurred
ok 2057 - A-2 §2: first_apply_error is the FIRST non-empty error message, null when none occurred
  ---
  duration_ms: 0.107125
  type: 'test'
  ...
# Subtest: A-2 §3: an applyError longer than 300 characters is truncated to 300
ok 2058 - A-2 §3: an applyError longer than 300 characters is truncated to 300
  ---
  duration_ms: 0.044208
  type: 'test'
  ...
# Subtest: A-2 §4: missing_audit_uid counts apply-path outcomes whose auditUid is null or empty
ok 2059 - A-2 §4: missing_audit_uid counts apply-path outcomes whose auditUid is null or empty
  ---
  duration_ms: 0.047041
  type: 'test'
  ...
# Subtest: A-2: the route records updateOpdAudit's outcome and never console-logs the driver message
ok 2060 - A-2: the route records updateOpdAudit's outcome and never console-logs the driver message
  ---
  duration_ms: 0.054667
  type: 'test'
  ...
# Subtest: directionGained counts findings that GAINED a direction; underuseCount feeds the sample
ok 2061 - directionGained counts findings that GAINED a direction; underuseCount feeds the sample
  ---
  duration_ms: 0.091583
  type: 'test'
  ...
# Subtest: pdqi9 stored rows-array reconstructs to the computeOpdScore object form
ok 2062 - pdqi9 stored rows-array reconstructs to the computeOpdScore object form
  ---
  duration_ms: 0.0755
  type: 'test'
  ...
# Subtest: A-3 §1: hysteresisCaseSql('displayed_band','$3','$2::int') emits $2::int in every comparison, $3 as every result
ok 2063 - A-3 §1: hysteresisCaseSql('displayed_band','$3','$2::int') emits $2::int in every comparison, $3 as every result
  ---
  duration_ms: 0.197667
  type: 'test'
  ...
# Subtest: A-3 §2: the UPDATE statement deduces $2 from the SET clause and casts it in the CASE
ok 2064 - A-3 §2: the UPDATE statement deduces $2 from the SET clause and casts it in the CASE
  ---
  duration_ms: 0.049375
  type: 'test'
  ...
# Subtest: A-3 §3: saveOpdAudit's conflict clause still reads EXCLUDED.note_quality_index — the two call sites must never be "unified" back into this bug
ok 2065 - A-3 §3: saveOpdAudit's conflict clause still reads EXCLUDED.note_quality_index — the two call sites must never be "unified" back into this bug
  ---
  duration_ms: 0.030291
  type: 'test'
  ...
# Subtest: A-3 §4: the pure twin hysteresisBand is untouched — same thresholds, same g
ok 2066 - A-3 §4: the pure twin hysteresisBand is untouched — same thresholds, same g
  ---
  duration_ms: 0.053708
  type: 'test'
  ...
# Subtest: A-4 §1 (defect 1): the candidate comparison truncates the DB side to the watermark's precision
ok 2067 - A-4 §1 (defect 1): the candidate comparison truncates the DB side to the watermark's precision
  ---
  duration_ms: 0.037292
  type: 'test'
  ...
# Subtest: A-4 §2 (defect 2): an underuse finding carrying lvc_category on input emerges WITHOUT it — every other key survives
ok 2068 - A-4 §2 (defect 2): an underuse finding carrying lvc_category on input emerges WITHOUT it — every other key survives
  ---
  duration_ms: 0.186791
  type: 'test'
  ...
# Subtest: A-4 §3 (defect 2): a non-underuse finding is unchanged — it still receives stamped[i] with its lvc_category
ok 2069 - A-4 §3 (defect 2): a non-underuse finding is unchanged — it still receives stamped[i] with its lvc_category
  ---
  duration_ms: 0.091125
  type: 'test'
  ...
# Subtest: A-4 §4 (defect 2): underuse + signal_type low_value_care — specific type restored AND lvc_category dropped, both on one finding
ok 2070 - A-4 §4 (defect 2): underuse + signal_type low_value_care — specific type restored AND lvc_category dropped, both on one finding
  ---
  duration_ms: 0.609042
  type: 'test'
  ...
# Subtest: A-4 §5 (defect 3): the pass lock — lab_batch semantics, TTL pinned, held ⇒ empty report, never a 500
ok 2071 - A-4 §5 (defect 3): the pass lock — lab_batch semantics, TTL pinned, held ⇒ empty report, never a 500
  ---
  duration_ms: 1.275542
  type: 'test'
  ...
# Subtest: migration 0030: CREATE TABLE IF NOT EXISTS opd_rescore_state, keyed (uid, engine_version)
ok 2072 - migration 0030: CREATE TABLE IF NOT EXISTS opd_rescore_state, keyed (uid, engine_version)
  ---
  duration_ms: 0.219167
  type: 'test'
  ...
# Subtest: severityOf + importanceHint: known types weighted, unknown → med
ok 2073 - severityOf + importanceHint: known types weighted, unknown → med
  ---
  duration_ms: 0.533666
  type: 'test'
  ...
# Subtest: buildQueue groups by doctor→signal_type, counts, and drops informational
ok 2074 - buildQueue groups by doctor→signal_type, counts, and drops informational
  ---
  duration_ms: 0.418708
  type: 'test'
  ...
# Subtest: buildQueue ranks types by severity×frequency; noisiest marked; doctors by attention
ok 2075 - buildQueue ranks types by severity×frequency; noisiest marked; doctors by attention
  ---
  duration_ms: 0.139875
  type: 'test'
  ...
# Subtest: buildQueue overlays the latest type decision; status filter hides triaged
ok 2076 - buildQueue overlays the latest type decision; status filter hides triaged
  ---
  duration_ms: 0.366
  type: 'test'
  ...
# Subtest: buildQueue concentrated flag: doctor holding the whole window share of a type
ok 2077 - buildQueue concentrated flag: doctor holding the whole window share of a type
  ---
  duration_ms: 0.080541
  type: 'test'
  ...
# Subtest: validateDecision: valid batch route decision normalizes
ok 2078 - validateDecision: valid batch route decision normalizes
  ---
  duration_ms: 0.119958
  type: 'test'
  ...
# Subtest: validateDecision: audit_bug forces routed=false and requires bug_type
ok 2079 - validateDecision: audit_bug forces routed=false and requires bug_type
  ---
  duration_ms: 0.117958
  type: 'test'
  ...
# Subtest: validateDecision: valid_signal requires importance; routed requires response_required
ok 2080 - validateDecision: valid_signal requires importance; routed requires response_required
  ---
  duration_ms: 0.056375
  type: 'test'
  ...
# Subtest: validateDecision: instance scope requires audit_id + finding_ref; bad enums rejected
ok 2081 - validateDecision: instance scope requires audit_id + finding_ref; bad enums rejected
  ---
  duration_ms: 0.170333
  type: 'test'
  ...
# Subtest: classifyTransition: audit_bug & not-routed → dismiss; routed → resolution
ok 2082 - classifyTransition: audit_bug & not-routed → dismiss; routed → resolution
  ---
  duration_ms: 0.598875
  type: 'test'
  ...
# Subtest: requireChip: dismiss/resolution require an in-vocabulary chip
ok 2083 - requireChip: dismiss/resolution require an in-vocabulary chip
  ---
  duration_ms: 0.107459
  type: 'test'
  ...
# Subtest: buildTriageEvent: enforces chip, free text optional, telemetry columns normalized
ok 2084 - buildTriageEvent: enforces chip, free text optional, telemetry columns normalized
  ---
  duration_ms: 0.093209
  type: 'test'
  ...
# Subtest: buildQueue: representative carries complexity_band/inputs + lvc_category (passthrough)
ok 2085 - buildQueue: representative carries complexity_band/inputs + lvc_category (passthrough)
  ---
  duration_ms: 0.605333
  type: 'test'
  ...
# Subtest: buildQueue: missing complexity → representative fields null (no placeholder)
ok 2086 - buildQueue: missing complexity → representative fields null (no placeholder)
  ---
  duration_ms: 0.0505
  type: 'test'
  ...
# Subtest: maxTries: 1 makes exactly ONE attempt — no retry at all
ok 2087 - maxTries: 1 makes exactly ONE attempt — no retry at all
  ---
  duration_ms: 1.074625
  type: 'test'
  ...
# Subtest: maxTries: 2 makes exactly TWO attempts
ok 2088 - maxTries: 2 makes exactly TWO attempts
  ---
  duration_ms: 0.215875
  type: 'test'
  ...
# Subtest: a shortened ladder still SUCCEEDS on a later attempt within it
ok 2089 - a shortened ladder still SUCCEEDS on a later attempt within it
  ---
  duration_ms: 0.320125
  type: 'test'
  ...
# Subtest: the empty-200 class respects the shortened budget too
ok 2090 - the empty-200 class respects the shortened budget too
  ---
  duration_ms: 0.150667
  type: 'test'
  ...
# Subtest: the terminal timeout message reports the ladder ACTUALLY used, not the constant
ok 2091 - the terminal timeout message reports the ladder ACTUALLY used, not the constant
  ---
  duration_ms: 6.041125
  type: 'test'
  ...
# Subtest: maxTries absent ⇒ 3 attempts, unchanged from today
ok 2092 - maxTries absent ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.903
  type: 'test'
  ...
# Subtest: maxTries zero ⇒ 3 attempts, unchanged from today
ok 2093 - maxTries zero ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.407042
  type: 'test'
  ...
# Subtest: maxTries negative ⇒ 3 attempts, unchanged from today
ok 2094 - maxTries negative ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.33975
  type: 'test'
  ...
# Subtest: maxTries NaN ⇒ 3 attempts, unchanged from today
ok 2095 - maxTries NaN ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.531291
  type: 'test'
  ...
# Subtest: maxTries Infinity ⇒ 3 attempts, unchanged from today
ok 2096 - maxTries Infinity ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.76825
  type: 'test'
  ...
# Subtest: maxTries a fraction below one ⇒ 3 attempts, unchanged from today
ok 2097 - maxTries a fraction below one ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.315083
  type: 'test'
  ...
# Subtest: maxTries a string ⇒ 3 attempts, unchanged from today
ok 2098 - maxTries a string ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.365625
  type: 'test'
  ...
# Subtest: a fractional maxTries above one TRUNCATES rather than rounding up
ok 2099 - a fractional maxTries above one TRUNCATES rather than rounding up
  ---
  duration_ms: 0.716666
  type: 'test'
  ...
# Subtest: OPENROUTER_MAX_TRIES still exports 3 and stays the default
ok 2100 - OPENROUTER_MAX_TRIES still exports 3 and stays the default
  ---
  duration_ms: 0.454667
  type: 'test'
  ...
# Subtest: the loop body reads the LOCAL maxTries, never the constant
ok 2101 - the loop body reads the LOCAL maxTries, never the constant
  ---
  duration_ms: 0.273333
  type: 'test'
  ...
# Subtest: chatWithFallback takes maxTries fifth and uses it only where a retry loop exists
ok 2102 - chatWithFallback takes maxTries fifth and uses it only where a retry loop exists
  ---
  duration_ms: 0.493625
  type: 'test'
  ...
# Subtest: governedChat threads maxTries down BOTH arms
ok 2103 - governedChat threads maxTries down BOTH arms
  ---
  duration_ms: 0.32925
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: the lab path and the production wrapper share ONE policy — identical bindings, not copies
ok 2104 - the lab path and the production wrapper share ONE policy — identical bindings, not copies
  ---
  duration_ms: 0.580791
  type: 'test'
  ...
# Subtest: policy values are unchanged by the move: 3 tries, 429/5xx retryable, 110s deadline, jittered backoff
ok 2105 - policy values are unchanged by the move: 3 tries, 429/5xx retryable, 110s deadline, jittered backoff
  ---
  duration_ms: 0.12575
  type: 'test'
  ...
# Subtest: a clean completion returns on attempt 1 — one call, no sleep, no failure report
ok 2106 - a clean completion returns on attempt 1 — one call, no sleep, no failure report
  ---
  duration_ms: 0.482916
  type: 'test'
  ...
# Subtest: every attempt carries OUR deadline and the SDK retries OFF — the budget must not multiply
ok 2107 - every attempt carries OUR deadline and the SDK retries OFF — the budget must not multiply
  ---
  duration_ms: 0.10525
  type: 'test'
  ...
# Subtest: a transport error (no HTTP status) is retryable; success on attempt 2 returns normally
ok 2108 - a transport error (no HTTP status) is retryable; success on attempt 2 returns normally
  ---
  duration_ms: 0.14625
  type: 'test'
  ...
# Subtest: 429/5xx retry on the bounded budget; the FINAL attempt rethrows the provider error
ok 2109 - 429/5xx retry on the bounded budget; the FINAL attempt rethrows the provider error
  ---
  duration_ms: 0.438166
  type: 'test'
  ...
# Subtest: a non-transient status (4xx) throws IMMEDIATELY — the call site fallback path is unchanged for it
ok 2110 - a non-transient status (4xx) throws IMMEDIATELY — the call site fallback path is unchanged for it
  ---
  duration_ms: 0.200875
  type: 'test'
  ...
# Subtest: an EMPTY 200 is a retryable failure, not a terminal one — d6efe39 made it visible, this makes it survivable
ok 2111 - an EMPTY 200 is a retryable failure, not a terminal one — d6efe39 made it visible, this makes it survivable
  ---
  duration_ms: 0.308833
  type: 'test'
  ...
# Subtest: an empty 200 on the FINAL attempt throws the MARKED error so call sites refuse the Ollama fallback (§2.3)
ok 2112 - an empty 200 on the FINAL attempt throws the MARKED error so call sites refuse the Ollama fallback (§2.3)
  ---
  duration_ms: 0.725666
  type: 'test'
  ...
# Subtest: an abort error is retryable — an abort that was not retryable would make the deadline strictly worse than no deadline
ok 2113 - an abort error is retryable — an abort that was not retryable would make the deadline strictly worse than no deadline
  ---
  duration_ms: 0.42975
  type: 'test'
  ...
# Subtest: the onAttemptFailure hook can never be the thing that fails the call
ok 2114 - the onAttemptFailure hook can never be the thing that fails the call
  ---
  duration_ms: 0.195417
  type: 'test'
  ...
# Subtest: streams are the CALLER's exclusion, not the wrapper's — the governed call sites keep the bare create() for stream:true
ok 2115 - streams are the CALLER's exclusion, not the wrapper's — the governed call sites keep the bare create() for stream:true
  ---
  duration_ms: 0.586541
  type: 'test'
  ...
# Subtest: NO timeoutMs → OPENROUTER_TIMEOUT_MS, byte-identical to before
ok 2116 - NO timeoutMs → OPENROUTER_TIMEOUT_MS, byte-identical to before
  ---
  duration_ms: 0.882375
  type: 'test'
  ...
# Subtest: timeoutMs: 600_000 → the doAttempt timeout is 600 000, not 110 000
ok 2117 - timeoutMs: 600_000 → the doAttempt timeout is 600 000, not 110 000
  ---
  duration_ms: 0.129
  type: 'test'
  ...
# Subtest: timeoutMs: 600_000 → the ABORTCONTROLLER deadline is 600 000 too, not just the SDK belt
ok 2118 - timeoutMs: 600_000 → the ABORTCONTROLLER deadline is 600 000 too, not just the SDK belt
  ---
  duration_ms: 0.129834
  type: 'test'
  ...
# Subtest: a junk timeoutMs degrades to the default — a deadline may never be switched off
ok 2119 - a junk timeoutMs degrades to the default — a deadline may never be switched off
  ---
  duration_ms: 0.187584
  type: 'test'
  ...
# Subtest: the terminal error message reports the APPLIED timeout, not the constant
ok 2120 - the terminal error message reports the APPLIED timeout, not the constant
  ---
  duration_ms: 28.6905
  type: 'test'
  ...
# Subtest: OPENROUTER_MAX_TRIES is still 3 and OPENROUTER_TIMEOUT_MS still defaults to 110 000
ok 2121 - OPENROUTER_MAX_TRIES is still 3 and OPENROUTER_TIMEOUT_MS still defaults to 110 000
  ---
  duration_ms: 0.583958
  type: 'test'
  ...
# Subtest: retry CLASSIFICATION is unchanged: 429 and 5xx retry, 4xx does not
ok 2122 - retry CLASSIFICATION is unchanged: 429 and 5xx retry, 4xx does not
  ---
  duration_ms: 0.228958
  type: 'test'
  ...
# Subtest: a 4xx throws immediately — one attempt, no retry
ok 2123 - a 4xx throws immediately — one attempt, no retry
  ---
  duration_ms: 0.45
  type: 'test'
  ...
# Subtest: a 429 retries the full budget
ok 2124 - a 429 retries the full budget
  ---
  duration_ms: 1.034875
  type: 'test'
  ...
# Subtest: an ABORT retries — a deadline that ended the call must not end the budget
ok 2125 - an ABORT retries — a deadline that ended the call must not end the budget
  ---
  duration_ms: 18.237166
  type: 'test'
  ...
# Subtest: the backoff curve is untouched
ok 2126 - the backoff curve is untouched
  ---
  duration_ms: 0.127792
  type: 'test'
  ...
# Subtest: EVERY openrouterCreateWithRetry call site forwards the caller timeout AND maxTries
ok 2127 - EVERY openrouterCreateWithRetry call site forwards the caller timeout AND maxTries
  ---
  duration_ms: 0.375
  type: 'test'
  ...
# Subtest: there are exactly FOUR provider call sites — a fifth must be enumerated
ok 2128 - there are exactly FOUR provider call sites — a fifth must be enumerated
  ---
  duration_ms: 2.020834
  type: 'test'
  ...
# Subtest: chatWithFallback's OpenRouter branch passes the caller's timeout through
ok 2129 - chatWithFallback's OpenRouter branch passes the caller's timeout through
  ---
  duration_ms: 0.310375
  type: 'test'
  ...
# Subtest: tracedChat's OpenRouter branch — THE PRODUCTION PATH — passes both through
ok 2130 - tracedChat's OpenRouter branch — THE PRODUCTION PATH — passes both through
  ---
  duration_ms: 0.146916
  type: 'test'
  ...
# Subtest: the IPD worker box is 800 s, matching the OPD worker
ok 2131 - the IPD worker box is 800 s, matching the OPD worker
  ---
  duration_ms: 0.140459
  type: 'test'
  ...
# Subtest: this build did not disturb the OPD cron window
ok 2132 - this build did not disturb the OPD cron window
  ---
  duration_ms: 0.079458
  type: 'test'
  ...
# Subtest: §2.1 — the DDL re-applies BOTH failure-table constraints, in one keyed statement
ok 2133 - §2.1 — the DDL re-applies BOTH failure-table constraints, in one keyed statement
  ---
  duration_ms: 1.547875
  type: 'test'
  ...
# Subtest: §2.1 — the re-applied CHECKs carry the widened phase list
ok 2134 - §2.1 — the re-applied CHECKs carry the widened phase list
  ---
  duration_ms: 0.429333
  type: 'test'
  ...
# Subtest: §2.1 — the statement is idempotent: DROP tolerates absence, ADD names a now-free constraint
ok 2135 - §2.1 — the statement is idempotent: DROP tolerates absence, ADD names a now-free constraint
  ---
  duration_ms: 0.36
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: §2.1 — a FRESH table run issues create, then the one ALTER, in order
ok 2136 - §2.1 — a FRESH table run issues create, then the one ALTER, in order
  ---
  duration_ms: 37.64125
  type: 'test'
  ...
# Subtest: §2.1 — a PRE-EXISTING table carrying the OLD constraints still ends with the widened form
ok 2137 - §2.1 — a PRE-EXISTING table carrying the OLD constraints still ends with the widened form
  ---
  duration_ms: 1.772209
  type: 'test'
  ...
# Subtest: §2.1 — migrations/0035 is in parity with the re-applied constraints
ok 2138 - §2.1 — migrations/0035 is in parity with the re-applied constraints
  ---
  duration_ms: 0.155625
  type: 'test'
  ...
# Subtest: §2.2 — the version is 3, and a payload built today claims 3
ok 2139 - §2.2 — the version is 3, and a payload built today claims 3
  ---
  duration_ms: 0.499833
  type: 'test'
  ...
# Subtest: §2.2 — a VERSION-2 manifest is unrecognized, which is the point of the bump
ok 2140 - §2.2 — a VERSION-2 manifest is unrecognized, which is the point of the bump
  ---
  duration_ms: 0.395917
  type: 'test'
  ...
# Subtest: §2.2 — ABSENT and explicit NULL stay distinguishable, which is why `has` is used
ok 2141 - §2.2 — ABSENT and explicit NULL stay distinguishable, which is why `has` is used
  ---
  duration_ms: 0.5255
  type: 'test'
  ...
# Subtest: §2.2 — both fields are TYPE-checked, not merely present
ok 2142 - §2.2 — both fields are TYPE-checked, not merely present
  ---
  duration_ms: 0.81075
  type: 'test'
  ...
# Subtest: §2.2 — the seed vocabulary is ONE object, not two that agree
ok 2143 - §2.2 — the seed vocabulary is ONE object, not two that agree
  ---
  duration_ms: 0.508541
  type: 'test'
  ...
# [rerank] backend failed, returning input order generic, untyped
# Subtest: §2.3 — the JUDGE arm no longer claims an unproven not_served
ok 2144 - §2.3 — the JUDGE arm no longer claims an unproven not_served
  ---
  duration_ms: 71.05475
  type: 'test'
  ...
# [rerank] backend failed, returning input order generic, untyped
# Subtest: §2.3 — the COHERE arm is unchanged from pass 0
ok 2145 - §2.3 — the COHERE arm is unchanged from pass 0
  ---
  duration_ms: 6.099292
  type: 'test'
  ...
# [rerank] backend failed, returning input order generic, untyped
# [rerank] backend failed, returning input order generic, untyped
# Subtest: §2.3 — THE REGRESSION GUARD: no synthesised boundary on EITHER arm may assert proof
ok 2146 - §2.3 — THE REGRESSION GUARD: no synthesised boundary on EITHER arm may assert proof
  ---
  duration_ms: 6.205167
  type: 'test'
  ...
# Subtest: §2.3 — where transport proof EXISTS, the served class still stands
ok 2147 - §2.3 — where transport proof EXISTS, the served class still stands
  ---
  duration_ms: 0.092167
  type: 'test'
  ...
# Subtest: parseSkeleton forces DDx hand-off on a low-certainty / anchored diagnosis
ok 2148 - parseSkeleton forces DDx hand-off on a low-certainty / anchored diagnosis
  ---
  duration_ms: 0.772292
  type: 'test'
  ...
# Subtest: normStageKind maps synonyms + defaults to assessment
ok 2149 - normStageKind maps synonyms + defaults to assessment
  ---
  duration_ms: 0.108667
  type: 'test'
  ...
# Subtest: normStageFlag maps synonyms + defaults to routine
ok 2150 - normStageFlag maps synonyms + defaults to routine
  ---
  duration_ms: 0.059333
  type: 'test'
  ...
# Subtest: orderAndIdStages enforces canonical order, stable within kind, sequential ids
ok 2151 - orderAndIdStages enforces canonical order, stable within kind, sequential ids
  ---
  duration_ms: 0.366916
  type: 'test'
  ...
# Subtest: orderAndIdStages caps the spine
ok 2152 - orderAndIdStages caps the spine
  ---
  duration_ms: 0.078375
  type: 'test'
  ...
# Subtest: STAGE_ORDER is strictly increasing along the canonical path
ok 2153 - STAGE_ORDER is strictly increasing along the canonical path
  ---
  duration_ms: 0.050792
  type: 'test'
  ...
# Subtest: parseSkeleton parses a fenced JSON skeleton
ok 2154 - parseSkeleton parses a fenced JSON skeleton
  ---
  duration_ms: 0.161291
  type: 'test'
  ...
# Subtest: parseSkeleton forces needsDdx for undifferentiated low-certainty presentation
ok 2155 - parseSkeleton forces needsDdx for undifferentiated low-certainty presentation
  ---
  duration_ms: 0.057916
  type: 'test'
  ...
# Subtest: parseSkeleton returns null on garbage / empty stages
ok 2156 - parseSkeleton returns null on garbage / empty stages
  ---
  duration_ms: 0.188916
  type: 'test'
  ...
# Subtest: parseEnrichment parses, filters unknown ids, dedups, separates evidence/estimates
ok 2157 - parseEnrichment parses, filters unknown ids, dedups, separates evidence/estimates
  ---
  duration_ms: 0.46975
  type: 'test'
  ...
# Subtest: parseEnrichment returns null on garbage
ok 2158 - parseEnrichment returns null on garbage
  ---
  duration_ms: 0.054583
  type: 'test'
  ...
# Subtest: mergeStages overlays enrichment by id and marks enriched
ok 2159 - mergeStages overlays enrichment by id and marks enriched
  ---
  duration_ms: 0.1165
  type: 'test'
  ...
# Subtest: §2.7.1 fact vs inference survives: provenance/extractionMethod/confidence pass through verbatim
ok 2160 - §2.7.1 fact vs inference survives: provenance/extractionMethod/confidence pass through verbatim
  ---
  duration_ms: 0.805791
  type: 'test'
  ...
# Subtest: §2.7.2 negatives ≠ unknowns, and assessedInputs ≠ missingInputs — never merged, never dropped when empty
ok 2161 - §2.7.2 negatives ≠ unknowns, and assessedInputs ≠ missingInputs — never merged, never dropped when empty
  ---
  duration_ms: 2.368667
  type: 'test'
  ...
# Subtest: §2.7.3 conflicts surface and are NEVER resolved, filtered or collapsed — including safety_critical
ok 2162 - §2.7.3 conflicts surface and are NEVER resolved, filtered or collapsed — including safety_critical
  ---
  duration_ms: 1.122458
  type: 'test'
  ...
# Subtest: §2.7.4 as_of comes from the snapshot's own field — never recomputed, only re-FORMATTED
ok 2163 - §2.7.4 as_of comes from the snapshot's own field — never recomputed, only re-FORMATTED
  ---
  duration_ms: 0.611125
  type: 'test'
  ...
# Subtest: §2.4 the LAST served observation wins, and a clean frontier run is not degraded
ok 2164 - §2.4 the LAST served observation wins, and a clean frontier run is not degraded
  ---
  duration_ms: 0.285125
  type: 'test'
  ...
# Subtest: §2.4 THE T-5 SCENARIO: a fallback leg ⇒ degraded, whatever the intent said
ok 2165 - §2.4 THE T-5 SCENARIO: a fallback leg ⇒ degraded, whatever the intent said
  ---
  duration_ms: 0.282084
  type: 'test'
  ...
# Subtest: §2.4 "we do not know" is DEGRADED — never the happy path
ok 2166 - §2.4 "we do not know" is DEGRADED — never the happy path
  ---
  duration_ms: 0.262083
  type: 'test'
  ...
# Subtest: §2.4 a partial assembly (a state leg failed) is degraded even when the model was clean
ok 2167 - §2.4 a partial assembly (a state leg failed) is degraded even when the model was clean
  ---
  duration_ms: 1.777458
  type: 'test'
  ...
# Subtest: §2.4 the wired reader takes provider/model from llm_response — NEVER llm_request (that is intent)
ok 2168 - §2.4 the wired reader takes provider/model from llm_response — NEVER llm_request (that is intent)
  ---
  duration_ms: 0.504209
  type: 'test'
  ...
# Subtest: §2.5 commercial is a SIBLING of clinical, never nested inside it, and carries its own definition
ok 2169 - §2.5 commercial is a SIBLING of clinical, never nested inside it, and carries its own definition
  ---
  duration_ms: 0.754209
  type: 'test'
  ...
# Subtest: §2.5 the commercial layer SHIPS — it is not omitted
ok 2170 - §2.5 the commercial layer SHIPS — it is not omitted
  ---
  duration_ms: 0.159
  type: 'test'
  ...
# Subtest: §2.6 the disclaimer is rewritten for a physician pre-encounter and EMITTED in the JSON
ok 2171 - §2.6 the disclaimer is rewritten for a physician pre-encounter and EMITTED in the JSON
  ---
  duration_ms: 0.1615
  type: 'test'
  ...
# Subtest: §2.3 every namespace is present and the envelope carries its required fields
ok 2172 - §2.3 every namespace is present and the envelope carries its required fields
  ---
  duration_ms: 0.346
  type: 'test'
  ...
# Subtest: §2.3 actions.follow_ups carries the snapshot's own followUps — never re-derived
ok 2173 - §2.3 actions.follow_ups carries the snapshot's own followUps — never re-derived
  ---
  duration_ms: 0.160167
  type: 'test'
  ...
# Subtest: §2.1 POST answers 202 with a job id and a poll url; the poll route returns 202/200/404
ok 2174 - §2.1 POST answers 202 with a job id and a poll url; the poll route returns 202/200/404
  ---
  duration_ms: 0.101375
  type: 'test'
  ...
# Subtest: §2.1 the 202 shape is documented as load-bearing — V2 precompute must not change the contract
ok 2175 - §2.1 the 202 shape is documented as load-bearing — V2 precompute must not change the contract
  ---
  duration_ms: 0.201375
  type: 'test'
  ...
# Subtest: §2.2 auth reuses CRON_SECRET and RECORDS that it is pilot-scoped and must be split
ok 2176 - §2.2 auth reuses CRON_SECRET and RECORDS that it is pilot-scoped and must be split
  ---
  duration_ms: 0.190833
  type: 'test'
  ...
# Subtest: the poll route tells Pulse it is REQUIRED to render a degraded package differently
ok 2177 - the poll route tells Pulse it is REQUIRED to render a degraded package differently
  ---
  duration_ms: 0.07575
  type: 'test'
  ...
# Subtest: job ids are well-formed and validated
ok 2178 - job ids are well-formed and validated
  ---
  duration_ms: 3.726666
  type: 'test'
  ...
# Subtest: §1.1 the CCB card and its live PHI count query are gone; OPD Audit Triage is untouched
ok 2179 - §1.1 the CCB card and its live PHI count query are gone; OPD Audit Triage is untouched
  ---
  duration_ms: 0.197709
  type: 'test'
  ...
# Subtest: §1.1 /care/briefs stays REACHABLE — no gate was added (V overruled 404-ing it)
ok 2180 - §1.1 /care/briefs stays REACHABLE — no gate was added (V overruled 404-ing it)
  ---
  duration_ms: 0.39725
  type: 'test'
  ...
# Subtest: §1.3 every preserved-mechanics file carries the RETIRED header WITH the CCB_ENABLED hazard
ok 2181 - §1.3 every preserved-mechanics file carries the RETIRED header WITH the CCB_ENABLED hazard
  ---
  duration_ms: 1.183333
  type: 'test'
  ...
# Subtest: §2.3 the ExtractedReport[] sink is ADDITIVE — the envelope and every existing caller are untouched
ok 2182 - §2.3 the ExtractedReport[] sink is ADDITIVE — the envelope and every existing caller are untouched
  ---
  duration_ms: 0.120583
  type: 'test'
  ...
# Subtest: ungrounded: citation_coverage_pct === 0 flips envelope.ungrounded — a zero-grounded package must not pass as well-grounded
ok 2183 - ungrounded: citation_coverage_pct === 0 flips envelope.ungrounded — a zero-grounded package must not pass as well-grounded
  ---
  duration_ms: 0.072584
  type: 'test'
  ...
# Subtest: state_llm: rejected[] is surfaced in the envelope — the hallucination meter is not discarded
ok 2184 - state_llm: rejected[] is surfaced in the envelope — the hallucination meter is not discarded
  ---
  duration_ms: 0.067166
  type: 'test'
  ...
# Subtest: state_conflicts: a concept in BOTH positives and negatives is surfaced, normalised, never resolved
ok 2185 - state_conflicts: a concept in BOTH positives and negatives is surfaced, normalised, never resolved
  ---
  duration_ms: 0.16825
  type: 'test'
  ...
# Subtest: a flag-on stage-2 failure is DEGRADED — the state shipped thinner than the default contract
ok 2186 - a flag-on stage-2 failure is DEGRADED — the state shipped thinner than the default contract
  ---
  duration_ms: 0.045458
  type: 'test'
  ...
# Subtest: the wired stage 2 is flag-gated DEFAULT ON, governed, and rides the brief trace
ok 2187 - the wired stage 2 is flag-gated DEFAULT ON, governed, and rides the brief trace
  ---
  duration_ms: 0.045542
  type: 'test'
  ...
# Subtest: stage 2 caps its thinking — the Vertex form, gated on a resolved Gemini model, never zero
ok 2188 - stage 2 caps its thinking — the Vertex form, gated on a resolved Gemini model, never zero
  ---
  duration_ms: 0.075958
  type: 'test'
  ...
# Subtest: the audit budget is NOT changed by the stage-2 cap — separate constants, separate files
ok 2189 - the audit budget is NOT changed by the stage-2 cap — separate constants, separate files
  ---
  duration_ms: 0.220875
  type: 'test'
  ...
# Subtest: T-13 §5.1: the captured failure now reports degraded, naming the dead leg
ok 2190 - T-13 §5.1: the captured failure now reports degraded, naming the dead leg
  ---
  duration_ms: 0.057833
  type: 'test'
  ...
# Subtest: T-13 §5.2: a HEALTHY package still reports degraded:false — the check must not mark everything
ok 2191 - T-13 §5.2: a HEALTHY package still reports degraded:false — the check must not mark everything
  ---
  duration_ms: 0.0375
  type: 'test'
  ...
# Subtest: T-13 §5.4: each check fires ALONE, with the other disabled
ok 2192 - T-13 §5.4: each check fires ALONE, with the other disabled
  ---
  duration_ms: 0.122792
  type: 'test'
  ...
# Subtest: T-13: the content check needs BOTH conditions — a grounded package with 0 findings, or an ungrounded one with findings, is not "empty"
ok 2193 - T-13: the content check needs BOTH conditions — a grounded package with 0 findings, or an ungrounded one with findings, is not "empty"
  ---
  duration_ms: 0.057083
  type: 'test'
  ...
# Subtest: T-13: failed legs are deduped and named in sorted order, and junk never crashes the reason
ok 2194 - T-13: failed legs are deduped and named in sorted order, and junk never crashes the reason
  ---
  duration_ms: 0.04625
  type: 'test'
  ...
# Subtest: T-13: the reasons compose — every independent cause is stated, none replaces another
ok 2195 - T-13: the reasons compose — every independent cause is stated, none replaces another
  ---
  duration_ms: 0.048584
  type: 'test'
  ...
# Subtest: T-13 §4: as_of is normalised to full ISO 8601 — a bare date keeps its calendar day
ok 2196 - T-13 §4: as_of is normalised to full ISO 8601 — a bare date keeps its calendar day
  ---
  duration_ms: 0.840333
  type: 'test'
  ...
# Subtest: T-13 §4: the snapshot itself is NOT recomputed — only the envelope is formatted
ok 2197 - T-13 §4: the snapshot itself is NOT recomputed — only the envelope is formatted
  ---
  duration_ms: 0.162333
  type: 'test'
  ...
# Subtest: T-13 §2: the envelope reads the failure signal that already existed on the trace
ok 2198 - T-13 §2: the envelope reads the failure signal that already existed on the trace
  ---
  duration_ms: 0.047541
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: THE DEFECT: a 200 with empty content THROWS instead of returning an empty string
ok 2199 - THE DEFECT: a 200 with empty content THROWS instead of returning an empty string
  ---
  duration_ms: 13.521167
  type: 'test'
  ...
# Subtest: empty content is RETRYABLE on the EXISTING budget — only the final attempt throws
ok 2200 - empty content is RETRYABLE on the EXISTING budget — only the final attempt throws
  ---
  duration_ms: 0.303458
  type: 'test'
  ...
# Subtest: the try budget is NOT raised — still exactly 3
ok 2201 - the try budget is NOT raised — still exactly 3
  ---
  duration_ms: 0.043083
  type: 'test'
  ...
# Subtest: persistent empty content exhausts the budget and throws — no silent fallback
ok 2202 - persistent empty content exhausts the budget and throws — no silent fallback
  ---
  duration_ms: 0.237334
  type: 'test'
  ...
# Subtest: a NON-empty response still returns normally — the happy path is untouched
ok 2203 - a NON-empty response still returns normally — the happy path is untouched
  ---
  duration_ms: 0.171459
  type: 'test'
  ...
# Subtest: THE ERROR MESSAGE is verbatim per PRD §4 and carries the whole envelope
ok 2204 - THE ERROR MESSAGE is verbatim per PRD §4 and carries the whole envelope
  ---
  duration_ms: 0.052791
  type: 'test'
  ...
# Subtest: the message renders missing envelope fields as null rather than undefined or blank
ok 2205 - the message renders missing envelope fields as null rather than undefined or blank
  ---
  duration_ms: 0.047959
  type: 'test'
  ...
# Subtest: the thrown message actually reaches the caller with the envelope in it
ok 2206 - the thrown message actually reaches the caller with the envelope in it
  ---
  duration_ms: 0.365959
  type: 'test'
  ...
# Subtest: onEnvelope fires on EVERY attempt — success, empty content and HTTP failure alike
ok 2207 - onEnvelope fires on EVERY attempt — success, empty content and HTTP failure alike
  ---
  duration_ms: 0.711959
  type: 'test'
  ...
# Subtest: ENVELOPE CAPTURE NEVER THROWS — a broken callback cannot cost a real result
ok 2208 - ENVELOPE CAPTURE NEVER THROWS — a broken callback cannot cost a real result
  ---
  duration_ms: 0.672333
  type: 'test'
  ...
# Subtest: readLlmEnvelope is total — any shape yields a defined envelope, never a throw
ok 2209 - readLlmEnvelope is total — any shape yields a defined envelope, never a throw
  ---
  duration_ms: 0.156458
  type: 'test'
  ...
# Subtest: OPENROUTER_TIMEOUT_MS defaults to 110s and is env-overridable
ok 2210 - OPENROUTER_TIMEOUT_MS defaults to 110s and is env-overridable
  ---
  duration_ms: 0.152333
  type: 'test'
  ...
# Subtest: an AbortSignal is passed to the fetch, and the timer is always cleared
ok 2211 - an AbortSignal is passed to the fetch, and the timer is always cleared
  ---
  duration_ms: 0.146041
  type: 'test'
  ...
# Subtest: a timeout is a NORMAL RETRYABLE failure on the same bounded budget
ok 2212 - a timeout is a NORMAL RETRYABLE failure on the same bounded budget
  ---
  duration_ms: 0.182042
  type: 'test'
  ...
# Subtest: a persistent transport failure exhausts the budget and throws a named error
ok 2213 - a persistent transport failure exhausts the budget and throws a named error
  ---
  duration_ms: 0.216875
  type: 'test'
  ...
# Subtest: the transport catch still emits an envelope, so a hung attempt is visible
ok 2214 - the transport catch still emits an envelope, so a hung attempt is visible
  ---
  duration_ms: 0.192375
  type: 'test'
  ...
# Subtest: THE CATCH BLOCK rethrows ONLY for eval; the non-eval return is byte-identical
ok 2215 - THE CATCH BLOCK rethrows ONLY for eval; the non-eval return is byte-identical
  ---
  duration_ms: 0.0815
  type: 'test'
  ...
# Subtest: the production defaultGenerate params are byte-identical — no eval change leaked in
ok 2216 - the production defaultGenerate params are byte-identical — no eval change leaked in
  ---
  duration_ms: 0.115625
  type: 'test'
  ...
# Subtest: buildOpenRouterBody is BYTE-IDENTICAL — no max_tokens, no response_format (D3)
ok 2217 - buildOpenRouterBody is BYTE-IDENTICAL — no max_tokens, no response_format (D3)
  ---
  duration_ms: 0.214833
  type: 'test'
  ...
# Subtest: no engine version bump, and the retry predicate is unchanged
ok 2218 - no engine version bump, and the retry predicate is unchanged
  ---
  duration_ms: 0.264917
  type: 'test'
  ...
# Subtest: runMiniOpdToLab writes the envelope on success and cannot write one on failure
ok 2219 - runMiniOpdToLab writes the envelope on success and cannot write one on failure
  ---
  duration_ms: 0.197708
  type: 'test'
  ...
# Subtest: the lab-batch core is untouched — drainPlan and the locks still stand
ok 2220 - the lab-batch core is untouched — drainPlan and the locks still stand
  ---
  duration_ms: 0.097667
  type: 'test'
  ...
# Subtest: parses a full draft: caps, ranking, counts, version, disclaimer
ok 2221 - parses a full draft: caps, ranking, counts, version, disclaimer
  ---
  duration_ms: 0.822375
  type: 'test'
  ...
# Subtest: citation ids bounded by the SHARED source count
ok 2222 - citation ids bounded by the SHARED source count
  ---
  duration_ms: 0.605875
  type: 'test'
  ...
# Subtest: unknown enums fall to safe defaults
ok 2223 - unknown enums fall to safe defaults
  ---
  duration_ms: 0.077833
  type: 'test'
  ...
# Subtest: caps: complications 8, safety-net 10
ok 2224 - caps: complications 8, safety-net 10
  ---
  duration_ms: 0.150292
  type: 'test'
  ...
# Subtest: malformed / empty inputs return null
ok 2225 - malformed / empty inputs return null
  ---
  duration_ms: 0.100209
  type: 'test'
  ...
# Subtest: summary fallback built when model omits it
ok 2226 - summary fallback built when model omits it
  ---
  duration_ms: 0.099083
  type: 'test'
  ...
# Subtest: buildPxUser: lens per doc type + documented plan block + empty-plan fallback
ok 2227 - buildPxUser: lens per doc type + documented plan block + empty-plan fallback
  ---
  duration_ms: 0.210042
  type: 'test'
  ...
# Subtest: parsePxCritique reads PX-specific keys; needs_revision inferred from non-empty arrays
ok 2228 - parsePxCritique reads PX-specific keys; needs_revision inferred from non-empty arrays
  ---
  duration_ms: 0.107458
  type: 'test'
  ...
# Subtest: R5: offsetPrognosisCitations shifts every citation id by the analyze-source count
ok 2229 - R5: offsetPrognosisCitations shifts every citation id by the analyze-source count
  ---
  duration_ms: 0.252875
  type: 'test'
  ...
# Subtest: modifiers parsed with direction defaulting to raises; capped at 6
ok 2230 - modifiers parsed with direction defaulting to raises; capped at 6
  ---
  duration_ms: 0.296208
  type: 'test'
  ...
# Subtest: §7.1 hash stability: spacing and casing variants produce the SAME hash
ok 2231 - §7.1 hash stability: spacing and casing variants produce the SAME hash
  ---
  duration_ms: 1.829084
  type: 'test'
  ...
# Subtest: the hash is EXACTLY sha256(normalized) hex first 16 — the stored contract, pinned
ok 2232 - the hash is EXACTLY sha256(normalized) hex first 16 — the stored contract, pinned
  ---
  duration_ms: 0.399458
  type: 'test'
  ...
# Subtest: ADDENDUM A §1.2 — the ten cross-engine vectors, pinned with their literal hashes
ok 2233 - ADDENDUM A §1.2 — the ten cross-engine vectors, pinned with their literal hashes
  ---
  duration_ms: 0.439333
  type: 'test'
  ...
# Subtest: normalization is trim + lower-case + collapse internal whitespace, nothing more
ok 2234 - normalization is trim + lower-case + collapse internal whitespace, nothing more
  ---
  duration_ms: 0.125375
  type: 'test'
  ...
# Subtest: §7.2 re-audit resilience: the array reorders, the hash still finds the right complication
ok 2235 - §7.2 re-audit resilience: the array reorders, the hash still finds the right complication
  ---
  duration_ms: 0.880834
  type: 'test'
  ...
# Subtest: §7.3 engine bump: an outcome linked at engine A resolves against engine B when the name survived
ok 2236 - §7.3 engine bump: an outcome linked at engine A resolves against engine B when the name survived
  ---
  duration_ms: 0.162375
  type: 'test'
  ...
# Subtest: §7.3 engine bump: a renamed complication renders UNRESOLVED — never re-pointed by index
ok 2237 - §7.3 engine bump: a renamed complication renders UNRESOLVED — never re-pointed by index
  ---
  duration_ms: 0.286209
  type: 'test'
  ...
# Subtest: a NULL hash reads as unpredicted, and junk shapes never throw
ok 2238 - a NULL hash reads as unpredicted, and junk shapes never throw
  ---
  duration_ms: 0.246167
  type: 'test'
  ...
# Subtest: §7.5 each classification is produced by the correct form state
ok 2239 - §7.5 each classification is produced by the correct form state
  ---
  duration_ms: 0.648167
  type: 'test'
  ...
# Subtest: §7.5 no_adverse_outcome FORCES a null complication hash, whatever the form held
ok 2240 - §7.5 no_adverse_outcome FORCES a null complication hash, whatever the form held
  ---
  duration_ms: 0.626167
  type: 'test'
  ...
# Subtest: the vocabularies are exactly the PRD’s
ok 2241 - the vocabularies are exactly the PRD’s
  ---
  duration_ms: 0.213666
  type: 'test'
  ...
# Subtest: §7.4 currentRows: the default view shows only non-superseded rows; history shows all
ok 2242 - §7.4 currentRows: the default view shows only non-superseded rows; history shows all
  ---
  duration_ms: 0.163167
  type: 'test'
  ...
# Subtest: §7.6 a document with no rows is not_followed_up and OUTSIDE the over-warning denominator
ok 2243 - §7.6 a document with no rows is not_followed_up and OUTSIDE the over-warning denominator
  ---
  duration_ms: 0.12425
  type: 'test'
  ...
# Subtest: §7.6 an event row alone follows the document up but does NOT admit it to the over-warning denominator
ok 2244 - §7.6 an event row alone follows the document up but does NOT admit it to the over-warning denominator
  ---
  duration_ms: 0.93675
  type: 'test'
  ...
# Subtest: §7.6 a no_adverse_outcome row admits the document; a superseded one does not
ok 2245 - §7.6 a no_adverse_outcome row admits the document; a superseded one does not
  ---
  duration_ms: 0.067625
  type: 'test'
  ...
# Subtest: §7.6 no_adverse alongside an event row: followed up, in the denominator, both persist
ok 2246 - §7.6 no_adverse alongside an event row: followed up, in the denominator, both persist
  ---
  duration_ms: 0.044875
  type: 'test'
  ...
# Subtest: §7.7 idempotent migration: every statement is IF NOT EXISTS — running it twice is a no-op
ok 2247 - §7.7 idempotent migration: every statement is IF NOT EXISTS — running it twice is a no-op
  ---
  duration_ms: 0.236125
  type: 'test'
  ...
# Subtest: P-7 in the store: supersede is ONE atomic statement — flag-flip CTE + insert, no content UPDATE, no DELETE
ok 2248 - P-7 in the store: supersede is ONE atomic statement — flag-flip CTE + insert, no content UPDATE, no DELETE
  ---
  duration_ms: 0.136708
  type: 'test'
  ...
# Subtest: §7.6 the view emits the not_followed_up bucket, and the over-warning columns go NULL outside it
ok 2249 - §7.6 the view emits the not_followed_up bucket, and the over-warning columns go NULL outside it
  ---
  duration_ms: 0.046542
  type: 'test'
  ...
# Subtest: the view reads only non-superseded rows and resolves by the SAME hash as the core
ok 2250 - the view reads only non-superseded rows and resolves by the SAME hash as the core
  ---
  duration_ms: 0.057333
  type: 'test'
  ...
# Subtest: the migrate route creates the table BEFORE the view, mirroring migrations/0033 exactly
ok 2251 - the migrate route creates the table BEFORE the view, mirroring migrations/0033 exactly
  ---
  duration_ms: 0.048958
  type: 'test'
  ...
# Subtest: P-8: the table and the view pass the SQL guard, and lib/sql-guard-core.ts is untouched
ok 2252 - P-8: the table and the view pass the SQL guard, and lib/sql-guard-core.ts is untouched
  ---
  duration_ms: 0.662875
  type: 'test'
  ...
# Subtest: A-2: horizon_days is DERIVED in SQL against the canonical discharged_at — never typed, never audited_at
ok 2253 - A-2: horizon_days is DERIVED in SQL against the canonical discharged_at — never typed, never audited_at
  ---
  duration_ms: 0.059667
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: SQL honesty: reads degrade to unavailable and writes to a refusal — never a throw (no DB in this sandbox)
ok 2254 - SQL honesty: reads degrade to unavailable and writes to a refusal — never a throw (no DB in this sandbox)
  ---
  duration_ms: 32.729334
  type: 'test'
  ...
# Subtest: promotion threshold is 5
ok 2255 - promotion threshold is 5
  ---
  duration_ms: 1.130209
  type: 'test'
  ...
# Subtest: a selection recurring ≥ threshold → promotion candidate
ok 2256 - a selection recurring ≥ threshold → promotion candidate
  ---
  duration_ms: 1.171916
  type: 'test'
  ...
# Subtest: below threshold → collecting
ok 2257 - below threshold → collecting
  ---
  duration_ms: 0.166875
  type: 'test'
  ...
# Subtest: threshold override is honoured
ok 2258 - threshold override is honoured
  ---
  duration_ms: 0.141875
  type: 'test'
  ...
# Subtest: dominant selection wins over a minority variant; edited count tracks divergence from generated
ok 2259 - dominant selection wins over a minority variant; edited count tracks divergence from generated
  ---
  duration_ms: 0.4625
  type: 'test'
  ...
# Subtest: selection order and duplicates do not split a recurring set
ok 2260 - selection order and duplicates do not split a recurring set
  ---
  duration_ms: 0.169875
  type: 'test'
  ...
# Subtest: records with no procedure context are skipped
ok 2261 - records with no procedure context are skipped
  ---
  duration_ms: 0.233875
  type: 'test'
  ...
# Subtest: procedure grouping is case/whitespace-insensitive
ok 2262 - procedure grouping is case/whitespace-insensitive
  ---
  duration_ms: 0.138042
  type: 'test'
  ...
# Subtest: candidates sort before collecting; ties by recurrence desc
ok 2263 - candidates sort before collecting; ties by recurrence desc
  ---
  duration_ms: 0.505584
  type: 'test'
  ...
# Subtest: grouping is deterministic (twice → deep-equal)
ok 2264 - grouping is deterministic (twice → deep-equal)
  ---
  duration_ms: 0.899458
  type: 'test'
  ...
# Subtest: empty input → empty queue
ok 2265 - empty input → empty queue
  ---
  duration_ms: 0.079292
  type: 'test'
  ...
# Subtest: suggestSetName maps a procedure to hs-<word>
ok 2266 - suggestSetName maps a procedure to hs-<word>
  ---
  duration_ms: 0.102125
  type: 'test'
  ...
# Subtest: a dominant selection of real bank ids survives validateAdhocSelection
ok 2267 - a dominant selection of real bank ids survives validateAdhocSelection
  ---
  duration_ms: 0.289708
  type: 'test'
  ...
# Subtest: promResponsesToEncounter: scored instruments → one dated care_call encounter with investigation points
ok 2268 - promResponsesToEncounter: scored instruments → one dated care_call encounter with investigation points
  ---
  duration_ms: 0.509292
  type: 'test'
  ...
# Subtest: promResponsesToEncounter: unscored (null) instruments are dropped from the fold
ok 2269 - promResponsesToEncounter: unscored (null) instruments are dropped from the fold
  ---
  duration_ms: 0.077709
  type: 'test'
  ...
# Subtest: promResponsesToEncounter: empty / all-null → empty investigations, no date (fold filters it)
ok 2270 - promResponsesToEncounter: empty / all-null → empty investigations, no date (fold filters it)
  ---
  duration_ms: 0.054
  type: 'test'
  ...
# Subtest: promResponsesToEncounter: deterministic (twice → deep-equal)
ok 2271 - promResponsesToEncounter: deterministic (twice → deep-equal)
  ---
  duration_ms: 0.439083
  type: 'test'
  ...
# Subtest: versions
ok 2272 - versions
  ---
  duration_ms: 0.572583
  type: 'test'
  ...
# Subtest: classifyFamily: each regex family (order = first-match-wins)
ok 2273 - classifyFamily: each regex family (order = first-match-wins)
  ---
  duration_ms: 1.237958
  type: 'test'
  ...
# Subtest: classifyFamily: no regex match → unknown (core+PREM); NULLIF empties handled
ok 2274 - classifyFamily: no regex match → unknown (core+PREM); NULLIF empties handled
  ---
  duration_ms: 0.0895
  type: 'test'
  ...
# Subtest: classifyFamily v1.1: main surgical families reach their existing packs
ok 2275 - classifyFamily v1.1: main surgical families reach their existing packs
  ---
  duration_ms: 0.089833
  type: 'test'
  ...
# Subtest: classifyFamily v1.1: existing coarse families unregressed
ok 2276 - classifyFamily v1.1: existing coarse families unregressed
  ---
  duration_ms: 0.050375
  type: 'test'
  ...
# Subtest: classifyFamily v1.1: proctology routes to its house pack end-to-end
ok 2277 - classifyFamily v1.1: proctology routes to its house pack end-to-end
  ---
  duration_ms: 2.401959
  type: 'test'
  ...
# Subtest: classifyFamily: the universal_core catch-all is never returned as a family
ok 2278 - classifyFamily: the universal_core catch-all is never returned as a family
  ---
  duration_ms: 0.354334
  type: 'test'
  ...
# Subtest: UID_FAMILY_MAP: sample uid→family for the 5 ratified representatives
ok 2279 - UID_FAMILY_MAP: sample uid→family for the 5 ratified representatives
  ---
  duration_ms: 0.138625
  type: 'test'
  ...
# Subtest: UID_FAMILY_MAP: uid-map beats the procedure_name regex (precedence)
ok 2280 - UID_FAMILY_MAP: uid-map beats the procedure_name regex (precedence)
  ---
  duration_ms: 0.458209
  type: 'test'
  ...
# Subtest: UID_FAMILY_MAP: facial_ent resolves to STANDARD + CORE+PREM only (null primary/fallback, no crash)
ok 2281 - UID_FAMILY_MAP: facial_ent resolves to STANDARD + CORE+PREM only (null primary/fallback, no crash)
  ---
  duration_ms: 1.513584
  type: 'test'
  ...
# Subtest: UID_FAMILY_MAP: every mapped value except "excluded" is a real FAMILY_PACKS family
ok 2282 - UID_FAMILY_MAP: every mapped value except "excluded" is a real FAMILY_PACKS family
  ---
  duration_ms: 0.188791
  type: 'test'
  ...
# Subtest: archetypeFor: direct pack, coarse-regex bridge, unknown→STANDARD
ok 2283 - archetypeFor: direct pack, coarse-regex bridge, unknown→STANDARD
  ---
  duration_ms: 0.118417
  type: 'test'
  ...
# Subtest: instrumentsDue: cancelled → empty
ok 2284 - instrumentsDue: cancelled → empty
  ---
  duration_ms: 0.100917
  type: 'test'
  ...
# Subtest: instrumentsDue: no discharge → pre-op (baseline) only
ok 2285 - instrumentsDue: no discharge → pre-op (baseline) only
  ---
  duration_ms: 0.17575
  type: 'test'
  ...
# Subtest: instrumentsDue: d72h window — out_of_window before, in_window at +3d, missed after close
ok 2286 - instrumentsDue: d72h window — out_of_window before, in_window at +3d, missed after close
  ---
  duration_ms: 0.277542
  type: 'test'
  ...
# Subtest: instrumentsDue: baseline — in_window before surgery, missed after
ok 2287 - instrumentsDue: baseline — in_window before surgery, missed after
  ---
  duration_ms: 0.336208
  type: 'test'
  ...
# Subtest: instrumentsDue: CORE + pack add-on + PREM scheduled (STANDARD)
ok 2288 - instrumentsDue: CORE + pack add-on + PREM scheduled (STANDARD)
  ---
  duration_ms: 0.175667
  type: 'test'
  ...
# Subtest: instrumentsDue: a Pv pack with an unconfirmed sweep uses its house fallback
ok 2289 - instrumentsDue: a Pv pack with an unconfirmed sweep uses its house fallback
  ---
  duration_ms: 0.1555
  type: 'test'
  ...
# Subtest: scoreInstrument: house simple sum; complete set scored
ok 2290 - scoreInstrument: house simple sum; complete set scored
  ---
  duration_ms: 0.450209
  type: 'test'
  ...
# Subtest: scoreInstrument: partial set → honest null
ok 2291 - scoreInstrument: partial set → honest null
  ---
  duration_ms: 0.095916
  type: 'test'
  ...
# Subtest: scoreInstrument: ⚠ items emit the escalation code
ok 2292 - scoreInstrument: ⚠ items emit the escalation code
  ---
  duration_ms: 0.552084
  type: 'test'
  ...
# Subtest: scoreInstrument: still-unfilled validated instrument → honest null (rule not encoded yet)
ok 2293 - scoreInstrument: still-unfilled validated instrument → honest null (rule not encoded yet)
  ---
  duration_ms: 0.095125
  type: 'test'
  ...
# Subtest: scoreInstrument: WHODAS-12 simple sum — full 12-item set on WHODAS5 → 0–48
ok 2294 - scoreInstrument: WHODAS-12 simple sum — full 12-item set on WHODAS5 → 0–48
  ---
  duration_ms: 0.261041
  type: 'test'
  ...
# Subtest: scoreInstrument: WHODAS-12 — incomplete (<12 mapped) → honest null
ok 2295 - scoreInstrument: WHODAS-12 — incomplete (<12 mapped) → honest null
  ---
  duration_ms: 0.10775
  type: 'test'
  ...
# Subtest: catalog: whodas12 has exactly 12 items, each on WHODAS5
ok 2296 - catalog: whodas12 has exactly 12 items, each on WHODAS5
  ---
  duration_ms: 0.096875
  type: 'test'
  ...
# Subtest: scoreInstrument: PREM experience sum of items 1–7 (EXP4 0–3); item 8 excluded; 0–21
ok 2297 - scoreInstrument: PREM experience sum of items 1–7 (EXP4 0–3); item 8 excluded; 0–21
  ---
  duration_ms: 0.476209
  type: 'test'
  ...
# Subtest: scoreInstrument: PREM partial (an EXP4 item missing) → honest null
ok 2298 - scoreInstrument: PREM partial (an EXP4 item missing) → honest null
  ---
  duration_ms: 0.10925
  type: 'test'
  ...
# Subtest: catalog: PREM_MODULE has 8 items (prem1..prem7 EXP4, prem8 NRS-11); service flag present
ok 2299 - catalog: PREM_MODULE has 8 items (prem1..prem7 EXP4, prem8 NRS-11); service flag present
  ---
  duration_ms: 0.156084
  type: 'test'
  ...
# Subtest: catalog: WHODAS5 + EXP4 registered in SHARED_SCALES; every WHODAS/PREM item scale resolves
ok 2300 - catalog: WHODAS5 + EXP4 registered in SHARED_SCALES; every WHODAS/PREM item scale resolves
  ---
  duration_ms: 0.203834
  type: 'test'
  ...
# Subtest: integrity: every FamilyPack primary/fallback resolves to a known instrument
ok 2301 - integrity: every FamilyPack primary/fallback resolves to a known instrument
  ---
  duration_ms: 0.150875
  type: 'test'
  ...
# Subtest: integrity: every HOUSE item uses a SHARED_SCALES scale
ok 2302 - integrity: every HOUSE item uses a SHARED_SCALES scale
  ---
  duration_ms: 1.550375
  type: 'test'
  ...
# Subtest: integrity: ARCHETYPE_WINDOWS + PREM_POINTS complete for all 5 archetypes
ok 2303 - integrity: ARCHETYPE_WINDOWS + PREM_POINTS complete for all 5 archetypes
  ---
  duration_ms: 0.16775
  type: 'test'
  ...
# Subtest: integrity: every house item scale has response options; whodas12 now carries its 12 items
ok 2304 - integrity: every house item scale has response options; whodas12 now carries its 12 items
  ---
  duration_ms: 0.124417
  type: 'test'
  ...
# Subtest: 2b scoring: koos_jr / hoos_jr interval-table lookup (higher = better)
ok 2305 - 2b scoring: koos_jr / hoos_jr interval-table lookup (higher = better)
  ---
  duration_ms: 0.267541
  type: 'test'
  ...
# Subtest: 2b scoring: spadi total %, ndi sum, nose ×5, ipss qol-excluded, nyha class, rmdq count
ok 2306 - 2b scoring: spadi total %, ndi sum, nose ×5, ipss qol-excluded, nyha class, rmdq count
  ---
  duration_ms: 0.337792
  type: 'test'
  ...
# Subtest: 2b scoring: partial responses → null (koos_jr/hoos_jr/spadi/ndi/ipss/nose/nyha)
ok 2307 - 2b scoring: partial responses → null (koos_jr/hoos_jr/spadi/ndi/ipss/nose/nyha)
  ---
  duration_ms: 0.2585
  type: 'test'
  ...
# Subtest: 2b catalog integrity: scales present, item counts, scales resolve, 2 lic corrections
ok 2308 - 2b catalog integrity: scales present, item counts, scales resolve, 2 lic corrections
  ---
  duration_ms: 0.387666
  type: 'test'
  ...
# Subtest: 2a selection: each Pv family selects its hs-set fallback (not the unconfirmed primary)
ok 2309 - 2a selection: each Pv family selects its hs-set fallback (not the unconfirmed primary)
  ---
  duration_ms: 0.457875
  type: 'test'
  ...
# Subtest: 2a scoring: complete house set → numeric sum (scale house); partial → honest null
ok 2310 - 2a scoring: complete house set → numeric sum (scale house); partial → honest null
  ---
  duration_ms: 0.255833
  type: 'test'
  ...
# Subtest: 2a escalation: red-flag responses fire the expected code
ok 2311 - 2a escalation: red-flag responses fire the expected code
  ---
  duration_ms: 0.126833
  type: 'test'
  ...
# Subtest: 2a integrity: 3 new scales verbatim; every hs-set option value resolves in SHARED_SCALES
ok 2312 - 2a integrity: 3 new scales verbatim; every hs-set option value resolves in SHARED_SCALES
  ---
  duration_ms: 0.407875
  type: 'test'
  ...
# Subtest: determinism: classify / instrumentsDue / score twice → deep-equal
ok 2313 - determinism: classify / instrumentsDue / score twice → deep-equal
  ---
  duration_ms: 0.29875
  type: 'test'
  ...
# Subtest: tier3 versions + max are stamped
ok 2314 - tier3 versions + max are stamped
  ---
  duration_ms: 0.518459
  type: 'test'
  ...
# Subtest: compileItemBank is deterministic (twice → deep-equal)
ok 2315 - compileItemBank is deterministic (twice → deep-equal)
  ---
  duration_ms: 0.679875
  type: 'test'
  ...
# Subtest: bank is house-only: no validated-instrument id leaks in
ok 2316 - bank is house-only: no validated-instrument id leaks in
  ---
  duration_ms: 0.084708
  type: 'test'
  ...
# Subtest: bank is house-only: no PREM id leaks in
ok 2317 - bank is house-only: no PREM id leaks in
  ---
  duration_ms: 0.121708
  type: 'test'
  ...
# Subtest: every bank item is sourced from an hs-set (never a validated set or PREM)
ok 2318 - every bank item is sourced from an hs-set (never a validated set or PREM)
  ---
  duration_ms: 0.087583
  type: 'test'
  ...
# Subtest: bank ids are unique (dedupe holds)
ok 2319 - bank ids are unique (dedupe holds)
  ---
  duration_ms: 0.060542
  type: 'test'
  ...
# Subtest: bank covers all 21 hs-sets (item count = Σ set items, deduped)
ok 2320 - bank covers all 21 hs-sets (item count = Σ set items, deduped)
  ---
  duration_ms: 0.15925
  type: 'test'
  ...
# Subtest: bankById is first-wins and complete
ok 2321 - bankById is first-wins and complete
  ---
  duration_ms: 0.120541
  type: 'test'
  ...
# Subtest: every bank item scale exists in SHARED_SCALES
ok 2322 - every bank item scale exists in SHARED_SCALES
  ---
  duration_ms: 0.2205
  type: 'test'
  ...
# Subtest: validate drops unknown ids
ok 2323 - validate drops unknown ids
  ---
  duration_ms: 0.362584
  type: 'test'
  ...
# Subtest: validate dedupes repeated ids
ok 2324 - validate dedupes repeated ids
  ---
  duration_ms: 0.0845
  type: 'test'
  ...
# Subtest: validate caps at ADHOC_MAX_ITEMS, preserving order
ok 2325 - validate caps at ADHOC_MAX_ITEMS, preserving order
  ---
  duration_ms: 0.076125
  type: 'test'
  ...
# Subtest: validate: zero valid ids → empty set
ok 2326 - validate: zero valid ids → empty set
  ---
  duration_ms: 0.06575
  type: 'test'
  ...
# Subtest: validate preserves selection order
ok 2327 - validate preserves selection order
  ---
  duration_ms: 0.060209
  type: 'test'
  ...
# Subtest: validate is deterministic (twice → deep-equal)
ok 2328 - validate is deterministic (twice → deep-equal)
  ---
  duration_ms: 0.070875
  type: 'test'
  ...
# Subtest: scoreAdhocSet: house-sum correct on a fixture
ok 2329 - scoreAdhocSet: house-sum correct on a fixture
  ---
  duration_ms: 0.197958
  type: 'test'
  ...
# Subtest: scoreAdhocSet: any item unanswered → null (complete-gate)
ok 2330 - scoreAdhocSet: any item unanswered → null (complete-gate)
  ---
  duration_ms: 0.081875
  type: 'test'
  ...
# Subtest: scoreAdhocSet: a ⚠ item surfaces its escalation code
ok 2331 - scoreAdhocSet: a ⚠ item surfaces its escalation code
  ---
  duration_ms: 0.118458
  type: 'test'
  ...
# Subtest: ADHOC_GEN_PROMPT is present, selection-only, never-invent
ok 2332 - ADHOC_GEN_PROMPT is present, selection-only, never-invent
  ---
  duration_ms: 0.113042
  type: 'test'
  ...
# Subtest: regression: 21 sets — all-index-0 → score 0, escalations match the oracle
ok 2333 - regression: 21 sets — all-index-0 → score 0, escalations match the oracle
  ---
  duration_ms: 1.538625
  type: 'test'
  ...
# Subtest: regression: 21 sets — complete-midpoint (all index 1) → score = item count
ok 2334 - regression: 21 sets — complete-midpoint (all index 1) → score = item count
  ---
  duration_ms: 0.240041
  type: 'test'
  ...
# Subtest: regression: 21 sets — any item unanswered → null
ok 2335 - regression: 21 sets — any item unanswered → null
  ---
  duration_ms: 0.199
  type: 'test'
  ...
# Subtest: regression: 21 sets — red-flag escalations match the oracle AND kernel/adhoc agree with scoreInstrument
ok 2336 - regression: 21 sets — red-flag escalations match the oracle AND kernel/adhoc agree with scoreInstrument
  ---
  duration_ms: 1.179
  type: 'test'
  ...
# Subtest: the citation-derived labels carry the caveat, VERBATIM per the kickoff
ok 2337 - the citation-derived labels carry the caveat, VERBATIM per the kickoff
  ---
  duration_ms: 1.355459
  type: 'test'
  ...
# Subtest: deterministic_rule and no_source labels are BYTE-IDENTICAL to before
ok 2338 - deterministic_rule and no_source labels are BYTE-IDENTICAL to before
  ---
  duration_ms: 0.063167
  type: 'test'
  ...
# Subtest: all four `elevated` values are unchanged — this is wording, not ranking
ok 2339 - all four `elevated` values are unchanged — this is wording, not ranking
  ---
  duration_ms: 0.048917
  type: 'test'
  ...
# Subtest: groundingKind returns the same kind for the same input as before — all four kinds
ok 2340 - groundingKind returns the same kind for the same input as before — all four kinds
  ---
  duration_ms: 0.069625
  type: 'test'
  ...
# Subtest: PROVENANCE_TIER_LABELS is byte-identical — the ledger map was not touched
ok 2341 - PROVENANCE_TIER_LABELS is byte-identical — the ledger map was not touched
  ---
  duration_ms: 0.332916
  type: 'test'
  ...
# Subtest: classifyProvenanceTier is untouched: never reads citation_ids, same verdicts on a fixture
ok 2342 - classifyProvenanceTier is untouched: never reads citation_ids, same verdicts on a fixture
  ---
  duration_ms: 0.185708
  type: 'test'
  ...
# Subtest: the page-level caveat renders ONCE per page, verbatim, in the findings area
ok 2343 - the page-level caveat renders ONCE per page, verbatim, in the findings area
  ---
  duration_ms: 0.229375
  type: 'test'
  ...
# Subtest: GREP TEST: no surface renders the bare pre-caveat strings, and the map has ONE home
ok 2344 - GREP TEST: no surface renders the bare pre-caveat strings, and the map has ONE home
  ---
  duration_ms: 93.683125
  type: 'test'
  ...
# Subtest: the label correction itself rode no bump — the version only moves for scoring changes
ok 2345 - the label correction itself rode no bump — the version only moves for scoring changes
  ---
  duration_ms: 0.321125
  type: 'test'
  ...
# Subtest: the provenance ledger page still reads ONLY the ledger map
ok 2346 - the provenance ledger page still reads ONLY the ledger map
  ---
  duration_ms: 0.326083
  type: 'test'
  ...
# Subtest: clinician-signed: derivation "clinician" → clinician_signed, NEVER internal_consensus / uncited_deterministic
ok 2347 - clinician-signed: derivation "clinician" → clinician_signed, NEVER internal_consensus / uncited_deterministic
  ---
  duration_ms: 0.599667
  type: 'test'
  ...
# Subtest: clinician-signed: existing external + llm derivations route exactly as before
ok 2348 - clinician-signed: existing external + llm derivations route exactly as before
  ---
  duration_ms: 0.091792
  type: 'test'
  ...
# Subtest: MANDATORY PIN: the 44 society rules' generic choosingwisely URL does NOT resolve
ok 2349 - MANDATORY PIN: the 44 society rules' generic choosingwisely URL does NOT resolve
  ---
  duration_ms: 0.176625
  type: 'test'
  ...
# Subtest: resolving citations: DOI, PMID, instance-specific URLs
ok 2350 - resolving citations: DOI, PMID, instance-specific URLs
  ---
  duration_ms: 0.060625
  type: 'test'
  ...
# Subtest: non-resolving: null/empty, bare domains, bare resolver roots — never a mere null-check
ok 2351 - non-resolving: null/empty, bare domains, bare resolver roots — never a mere null-check
  ---
  duration_ms: 0.061666
  type: 'test'
  ...
# Subtest: rule 1: rule_ref + resolving citation → deterministic; generic/none/missing row → internal_consensus
ok 2352 - rule 1: rule_ref + resolving citation → deterministic; generic/none/missing row → internal_consensus
  ---
  duration_ms: 0.05
  type: 'test'
  ...
# Subtest: rule 2: deterministic source without rule_ref → uncited_deterministic (even at low-value)
ok 2353 - rule 2: deterministic source without rule_ref → uncited_deterministic (even at low-value)
  ---
  duration_ms: 0.043291
  type: 'test'
  ...
# Subtest: rule 3: low-value without rule_ref → unattributed_sourceable
ok 2354 - rule 3: low-value without rule_ref → unattributed_sourceable
  ---
  duration_ms: 0.038958
  type: 'test'
  ...
# Subtest: rule 4: judgement family → inherent_judgment
ok 2355 - rule 4: judgement family → inherent_judgment
  ---
  duration_ms: 0.2255
  type: 'test'
  ...
# Subtest: rule 5 direction: unknowns default to SOURCEABLE, never to inherent (the bias runs against us)
ok 2356 - rule 5 direction: unknowns default to SOURCEABLE, never to inherent (the bias runs against us)
  ---
  duration_ms: 0.30475
  type: 'test'
  ...
# Subtest: grounding: precedence + R-7 labels verbatim; internal corpus is never elevated
ok 2357 - grounding: precedence + R-7 labels verbatim; internal corpus is never elevated
  ---
  duration_ms: 0.346667
  type: 'test'
  ...
# Subtest: corpusCitationResolves: OpenFDA null-page label resolves (§4); StatPearls/UpToDate/PubMed resolve
ok 2358 - corpusCitationResolves: OpenFDA null-page label resolves (§4); StatPearls/UpToDate/PubMed resolve
  ---
  duration_ms: 0.055458
  type: 'test'
  ...
# Subtest: corpusCitationResolves: self-reference / empty / no-locator does NOT resolve
ok 2359 - corpusCitationResolves: self-reference / empty / no-locator does NOT resolve
  ---
  duration_ms: 0.044375
  type: 'test'
  ...
# Subtest: deterministic finding with a resolving corpus citation → deterministic
ok 2360 - deterministic finding with a resolving corpus citation → deterministic
  ---
  duration_ms: 0.041625
  type: 'test'
  ...
# Subtest: deterministic finding marked llm → internal_consensus
ok 2361 - deterministic finding marked llm → internal_consensus
  ---
  duration_ms: 0.034208
  type: 'test'
  ...
# Subtest: S1 (0.81.10): muscle_relaxant_indication → deterministic_completeness (documentation prompt, same class as incomplete_dosing)
ok 2362 - S1 (0.81.10): muscle_relaxant_indication → deterministic_completeness (documentation prompt, same class as incomplete_dosing)
  ---
  duration_ms: 0.073
  type: 'test'
  ...
# Subtest: 0.81.14: vitamin_d_repletion_duration + pregnancy_risk_verify → deterministic_completeness (documentation prompts)
ok 2363 - 0.81.14: vitamin_d_repletion_duration + pregnancy_risk_verify → deterministic_completeness (documentation prompts)
  ---
  duration_ms: 0.033667
  type: 'test'
  ...
# Subtest: V1/V2: incomplete_dosing → deterministic_completeness; duplicate_* → deterministic_logical
ok 2364 - V1/V2: incomplete_dosing → deterministic_completeness; duplicate_* → deterministic_logical
  ---
  duration_ms: 0.032375
  type: 'test'
  ...
# Subtest: §3.3 unreachability: an in-scope deterministic signal type that carries provenance is NEVER uncited_deterministic
ok 2365 - §3.3 unreachability: an in-scope deterministic signal type that carries provenance is NEVER uncited_deterministic
  ---
  duration_ms: 0.057416
  type: 'test'
  ...
# Subtest: bedrock is in LAB_PROVIDERS, and the other three are untouched
ok 2366 - bedrock is in LAB_PROVIDERS, and the other three are untouched
  ---
  duration_ms: 0.794
  type: 'test'
  ...
# Subtest: EVERY provider has an entry for EVERY call class
ok 2367 - EVERY provider has an entry for EVERY call class
  ---
  duration_ms: 0.201083
  type: 'test'
  ...
# Subtest: the measured table, verbatim
ok 2368 - the measured table, verbatim
  ---
  duration_ms: 0.201333
  type: 'test'
  ...
# Subtest: OLLAMA AUDIT IS SINGLE-TRY — a local box that missed the budget will not answer on a re-ask
ok 2369 - OLLAMA AUDIT IS SINGLE-TRY — a local box that missed the budget will not answer on a re-ask
  ---
  duration_ms: 0.079458
  type: 'test'
  ...
# Subtest: BOTH AUDIT CLASSES ARE SINGLE-TRY on every provider (DEC-B4, reversing Unit A)
ok 2370 - BOTH AUDIT CLASSES ARE SINGLE-TRY on every provider (DEC-B4, reversing Unit A)
  ---
  duration_ms: 0.058958
  type: 'test'
  ...
# Subtest: ollama does not serve doc_read at all — null, not a number
ok 2371 - ollama does not serve doc_read at all — null, not a number
  ---
  duration_ms: 0.049542
  type: 'test'
  ...
# Subtest: the backoff allowance is the exact upper bound of the shipped curve
ok 2372 - the backoff allowance is the exact upper bound of the shipped curve
  ---
  duration_ms: 0.1175
  type: 'test'
  ...
# Subtest: totalBudgetMs = perAttemptMs × maxTries + the backoff allowance
ok 2373 - totalBudgetMs = perAttemptMs × maxTries + the backoff allowance
  ---
  duration_ms: 0.063292
  type: 'test'
  ...
# Subtest: the allowance is never optimistic — the total is at least the naive product
ok 2374 - the allowance is never optimistic — the total is at least the naive product
  ---
  duration_ms: 0.19625
  type: 'test'
  ...
# Subtest: bedrock:anthropic.claude-x RESOLVES, and is marked paid
ok 2375 - bedrock:anthropic.claude-x RESOLVES, and is marked paid
  ---
  duration_ms: 0.325291
  type: 'test'
  ...
# Subtest: …and it PROBES REACHABLE only when the WHOLE OIDC chain is configured
ok 2376 - …and it PROBES REACHABLE only when the WHOLE OIDC chain is configured
  ---
  duration_ms: 0.172958
  type: 'test'
  ...
# Subtest: an unknown prefix STILL errors and never falls back
ok 2377 - an unknown prefix STILL errors and never falls back
  ---
  duration_ms: 0.06025
  type: 'test'
  ...
# Subtest: EXISTING resolution semantics are untouched
ok 2378 - EXISTING resolution semantics are untouched
  ---
  duration_ms: 0.081625
  type: 'test'
  ...
# Subtest: the paid ceiling is untouched
ok 2379 - the paid ceiling is untouched
  ---
  duration_ms: 0.073709
  type: 'test'
  ...
# Subtest: RESOLVED BY UNIT D: one audit leg now fits the worker box it runs in
ok 2380 - RESOLVED BY UNIT D: one audit leg now fits the worker box it runs in
  ---
  duration_ms: 0.0405
  type: 'test'
  ...
# Subtest: §4.1: a Vertex 403 body survives whole — status, message, details all captured
ok 2381 - §4.1: a Vertex 403 body survives whole — status, message, details all captured
  ---
  duration_ms: 0.578791
  type: 'test'
  ...
# Subtest: §4.1: the cap is 4000, not 200 — a diagnostic longer than 200 chars survives
ok 2382 - §4.1: the cap is 4000, not 200 — a diagnostic longer than 200 chars survives
  ---
  duration_ms: 0.077209
  type: 'test'
  ...
# Subtest: §4.1: nested {error:{error:{…}}} unwraps; plain Error and junk degrade safely, never throw
ok 2383 - §4.1: nested {error:{error:{…}}} unwraps; plain Error and junk degrade safely, never throw
  ---
  duration_ms: 0.113083
  type: 'test'
  ...
# Subtest: §4.2: begin/end account per provider; snapshot totals; end floors at 0
ok 2384 - §4.2: begin/end account per provider; snapshot totals; end floors at 0
  ---
  duration_ms: 0.389334
  type: 'test'
  ...
# Subtest: §4.2: providerErrorPayload carries inFlightAtError + provider/label/fellBackTo + the serialised error
ok 2385 - §4.2: providerErrorPayload carries inFlightAtError + provider/label/fellBackTo + the serialised error
  ---
  duration_ms: 0.09575
  type: 'test'
  ...
# Subtest: §4.1: the 200-char truncation is GONE from every provider-error path
ok 2386 - §4.1: the 200-char truncation is GONE from every provider-error path
  ---
  duration_ms: 0.094625
  type: 'test'
  ...
# Subtest: §4.3: the fallback is LOUD — console.error with the stable [provider-fallback] prefix, console.warn gone
ok 2387 - §4.3: the fallback is LOUD — console.error with the stable [provider-fallback] prefix, console.warn gone
  ---
  duration_ms: 0.822291
  type: 'test'
  ...
# Subtest: §4.2: both tracedChat catches emit a provider_error event through the existing logEvent path
ok 2388 - §4.2: both tracedChat catches emit a provider_error event through the existing logEvent path
  ---
  duration_ms: 0.09225
  type: 'test'
  ...
# Subtest: §4.2: the in-flight snapshot is taken BEFORE the decrement — the failing call counts itself
ok 2389 - §4.2: the in-flight snapshot is taken BEFORE the decrement — the failing call counts itself
  ---
  duration_ms: 0.194458
  type: 'test'
  ...
# Subtest: the payload names model, region and SA identity — and the SA getter exposes client_email ONLY
ok 2390 - the payload names model, region and SA identity — and the SA getter exposes client_email ONLY
  ---
  duration_ms: 0.297417
  type: 'test'
  ...
# Subtest: §5 superseded for OpenRouter ONLY by addendum F v2: retry exists, but ONLY via the shared policy module
ok 2391 - §5 superseded for OpenRouter ONLY by addendum F v2: retry exists, but ONLY via the shared policy module
  ---
  duration_ms: 0.158667
  type: 'test'
  ...
# Subtest: §5.2: a good response is NOT reclassified — including a one-character answer
ok 2392 - §5.2: a good response is NOT reclassified — including a one-character answer
  ---
  duration_ms: 0.134625
  type: 'test'
  ...
# Subtest: §2.1: the three failure rules — no choices, empty content, unusable finish_reason
ok 2393 - §2.1: the three failure rules — no choices, empty content, unusable finish_reason
  ---
  duration_ms: 0.082333
  type: 'test'
  ...
# Subtest: §2.1: a STREAM is never judged — it has no choices yet and would fail every rule
ok 2394 - §2.1: a STREAM is never judged — it has no choices yet and would fail every rule
  ---
  duration_ms: 0.041875
  type: 'test'
  ...
# Subtest: §2.2: the event carries the FULL body, both finish reasons, the served endpoint and the error object
ok 2395 - §2.2: the event carries the FULL body, both finish reasons, the served endpoint and the error object
  ---
  duration_ms: 0.194042
  type: 'test'
  ...
# Subtest: §5.1: the caller sees a FAILURE, not an empty string — and the error is marked, not laundered
ok 2396 - §5.1: the caller sees a FAILURE, not an empty string — and the error is marked, not laundered
  ---
  duration_ms: 0.093208
  type: 'test'
  ...
# Subtest: §2.2/§2.3: the response is validated per attempt, the event is emitted, and the bad-200 path DOES NOT fall back
ok 2397 - §2.2/§2.3: the response is validated per attempt, the event is emitted, and the bad-200 path DOES NOT fall back
  ---
  duration_ms: 0.176083
  type: 'test'
  ...
# Subtest: §2.1: the check runs only when the provider actually served — never after a fallback
ok 2398 - §2.1: the check runs only when the provider actually served — never after a fallback
  ---
  duration_ms: 0.047666
  type: 'test'
  ...
# Subtest: §6 out of scope: no retry, no backoff, and the Google provider pin is untouched
ok 2399 - §6 out of scope: no retry, no backoff, and the Google provider pin is untouched
  ---
  duration_ms: 0.094292
  type: 'test'
  ...
# Subtest: modelsAgree: served matches intended across provider prefixes (verdict KEPT)
ok 2400 - modelsAgree: served matches intended across provider prefixes (verdict KEPT)
  ---
  duration_ms: 0.46925
  type: 'test'
  ...
# Subtest: modelsAgree: a silent drop to the local Ollama model is a MISMATCH (verdict EXCLUDED)
ok 2401 - modelsAgree: a silent drop to the local Ollama model is a MISMATCH (verdict EXCLUDED)
  ---
  duration_ms: 0.111167
  type: 'test'
  ...
# Subtest: guard both directions: Qwen kept, Ollama fallback flagged — the SL2 regression
ok 2402 - guard both directions: Qwen kept, Ollama fallback flagged — the SL2 regression
  ---
  duration_ms: 0.056458
  type: 'test'
  ...
# Subtest: every provider has a budget for every call class, and the classes are the four
ok 2403 - every provider has a budget for every call class, and the classes are the four
  ---
  duration_ms: 1.672875
  type: 'test'
  ...
# Subtest: audit_ipd exists on every provider and ollama serves it
ok 2404 - audit_ipd exists on every provider and ollama serves it
  ---
  duration_ms: 0.135
  type: 'test'
  ...
# Subtest: the published totals are exactly what the arithmetic in the PRD says
ok 2405 - the published totals are exactly what the arithmetic in the PRD says
  ---
  duration_ms: 0.09725
  type: 'test'
  ...
# Subtest: BOTH audit classes are one try on every provider — the ladder is multiplicative
ok 2406 - BOTH audit classes are one try on every provider — the ladder is multiplicative
  ---
  duration_ms: 0.057834
  type: 'test'
  ...
# Subtest: analyzeCase accepts a budget and passes it down BOTH arms of the generate closure
ok 2407 - analyzeCase accepts a budget and passes it down BOTH arms of the generate closure
  ---
  duration_ms: 1.68475
  type: 'test'
  ...
# Subtest: the IPD callers read the budget from the TABLE, never as literals in their own file
ok 2408 - the IPD callers read the budget from the TABLE, never as literals in their own file
  ---
  duration_ms: 0.152708
  type: 'test'
  ...
# Subtest: a null budget throws rather than substituting a default
ok 2409 - a null budget throws rather than substituting a default
  ---
  duration_ms: 0.133375
  type: 'test'
  ...
# Subtest: the OPD audit call site sends a maxTries taken from the budget
ok 2410 - the OPD audit call site sends a maxTries taken from the budget
  ---
  duration_ms: 0.092041
  type: 'test'
  ...
# Subtest: ipd-audit-now records what SERVED — the constant model is gone
ok 2411 - ipd-audit-now records what SERVED — the constant model is gone
  ---
  duration_ms: 0.215083
  type: 'test'
  ...
# Subtest: ipd-audit-now got the box its work actually needs (DEC-B5)
ok 2412 - ipd-audit-now got the box its work actually needs (DEC-B5)
  ---
  duration_ms: 0.296125
  type: 'test'
  ...
# Subtest: PROVIDER_SWITCH_ENABLED defaults OFF and is read at call time
ok 2413 - PROVIDER_SWITCH_ENABLED defaults OFF and is read at call time
  ---
  duration_ms: 0.078958
  type: 'test'
  ...
# Subtest: both workers gate ?provider= AND errors-loud behind the flag
ok 2414 - both workers gate ?provider= AND errors-loud behind the flag
  ---
  duration_ms: 0.360334
  type: 'test'
  ...
# Subtest: DEC-2 writes NO ROW rather than a laundered one, and never fires on a mini run
ok 2415 - DEC-2 writes NO ROW rather than a laundered one, and never fires on a mini run
  ---
  duration_ms: 0.146375
  type: 'test'
  ...
# Subtest: a provider that cannot serve a class is REFUSED, not defaulted
ok 2416 - a provider that cannot serve a class is REFUSED, not defaulted
  ---
  duration_ms: 0.099708
  type: 'test'
  ...
# Subtest: resolveWorkerProvider errors loud and never falls back
ok 2417 - resolveWorkerProvider errors loud and never falls back
  ---
  duration_ms: 0.21775
  type: 'test'
  ...
# Subtest: the view is created idempotently beside the other two
ok 2418 - the view is created idempotently beside the other two
  ---
  duration_ms: 0.043959
  type: 'test'
  ...
# Subtest: ⚠️ payload IS EXCLUDED — it is the only PHI-bearing column on the table
ok 2419 - ⚠️ payload IS EXCLUDED — it is the only PHI-bearing column on the table
  ---
  duration_ms: 0.080916
  type: 'test'
  ...
# Subtest: tokens_out is present — it is the determinism observable, not a bonus column
ok 2420 - tokens_out is present — it is the determinism observable, not a bonus column
  ---
  duration_ms: 0.316417
  type: 'test'
  ...
# Subtest: call_model / call_provider are read as REAL COLUMNS, not out of payload
ok 2421 - call_model / call_provider are read as REAL COLUMNS, not out of payload
  ---
  duration_ms: 0.069709
  type: 'test'
  ...
# Subtest: THE NAME PASSES THE SQL GUARD WITHOUT lib/sql-guard-core.ts CHANGING
ok 2422 - THE NAME PASSES THE SQL GUARD WITHOUT lib/sql-guard-core.ts CHANGING
  ---
  duration_ms: 0.609208
  type: 'test'
  ...
# Subtest: lib/sql-guard-core.ts was NOT edited by this build
ok 2423 - lib/sql-guard-core.ts was NOT edited by this build
  ---
  duration_ms: 0.081333
  type: 'test'
  ...
# Subtest: exactly one cron entry moved, and it is the OPD worker path
ok 2424 - exactly one cron entry moved, and it is the OPD worker path
  ---
  duration_ms: 0.22725
  type: 'test'
  ...
# Subtest: quantizeConfidence is DELETED — the function, its export, and every call
ok 2425 - quantizeConfidence is DELETED — the function, its export, and every call
  ---
  duration_ms: 0.477166
  type: 'test'
  ...
# Subtest: findingPenalty is the target text VERBATIM — raw clamped float, no level cliff
ok 2426 - findingPenalty is the target text VERBATIM — raw clamped float, no level cliff
  ---
  duration_ms: 0.073
  type: 'test'
  ...
# Subtest: the penalty is CONTINUOUS in confidence again — the 0.80 cliff is gone
ok 2427 - the penalty is CONTINUOUS in confidence again — the 0.80 cliff is gone
  ---
  duration_ms: 0.486875
  type: 'test'
  ...
# Subtest: THE KEPT BEHAVIOUR: junk confidence lands on the scale, not outside it
ok 2428 - THE KEPT BEHAVIOUR: junk confidence lands on the scale, not outside it
  ---
  duration_ms: 0.183958
  type: 'test'
  ...
# Subtest: the pre-S1 arithmetic is restored exactly: the triple-QT canary computes 26 again
ok 2429 - the pre-S1 arithmetic is restored exactly: the triple-QT canary computes 26 again
  ---
  duration_ms: 0.0855
  type: 'test'
  ...
# Subtest: PENALTY_BASE, SEVERITY and bandFor are byte-identical
ok 2430 - PENALTY_BASE, SEVERITY and bandFor are byte-identical
  ---
  duration_ms: 0.325541
  type: 'test'
  ...
# Subtest: hysteresis is ENDORSED and untouched: g, the rule, and the store CASE all stand
ok 2431 - hysteresis is ENDORSED and untouched: g, the rule, and the store CASE all stand
  ---
  duration_ms: 0.232625
  type: 'test'
  ...
# Subtest: engine is current and the family includes it (decision 21 — no orphaned corpus)
ok 2432 - engine is current and the family includes it (decision 21 — no orphaned corpus)
  ---
  duration_ms: 0.053583
  type: 'test'
  ...
# Subtest: pairs A→B→C into (A,B) and (B,C)
ok 2433 - pairs A→B→C into (A,B) and (B,C)
  ---
  duration_ms: 0.99825
  type: 'test'
  ...
# Subtest: no pair beyond 90 days; exactly 90 days is IN the window
ok 2434 - no pair beyond 90 days; exactly 90 days is IN the window
  ---
  duration_ms: 0.089708
  type: 'test'
  ...
# Subtest: same-day / overlapping admissions never pair; ER encounters never pair
ok 2435 - same-day / overlapping admissions never pair; ER encounters never pair
  ---
  duration_ms: 0.147
  type: 'test'
  ...
# Subtest: tight_7d / within_30d boundaries
ok 2436 - tight_7d / within_30d boundaries
  ---
  duration_ms: 1.328292
  type: 'test'
  ...
# Subtest: structural_bounce = same department OR same doctor
ok 2437 - structural_bounce = same department OR same doctor
  ---
  duration_ms: 0.242875
  type: 'test'
  ...
# Subtest: er_route via admission_type Emergency and via an ER encounter within 48h
ok 2438 - er_route via admission_type Emergency and via an ER encounter within 48h
  ---
  duration_ms: 0.238291
  type: 'test'
  ...
# Subtest: excluded_category fires on EITHER side, exact live strings
ok 2439 - excluded_category fires on EITHER side, exact live strings
  ---
  duration_ms: 0.512083
  type: 'test'
  ...
# Subtest: lane precedence: excluded → er_routed → tight_bounce → structural_30d → other
ok 2440 - lane precedence: excluded → er_routed → tight_bounce → structural_30d → other
  ---
  duration_ms: 0.207417
  type: 'test'
  ...
# Subtest: dedup keys: stable for the same pair, distinct for different pairs and classes
ok 2441 - dedup keys: stable for the same pair, distinct for different pairs and classes
  ---
  duration_ms: 0.532875
  type: 'test'
  ...
# Subtest: duplicate-MRN reconcile fires only on name AND dob — never on a shared identifier alone
ok 2442 - duplicate-MRN reconcile fires only on name AND dob — never on a shared identifier alone
  ---
  duration_ms: 0.449958
  type: 'test'
  ...
# Subtest: form within ±5d of a KX readmit dedupes into the pair and attaches the CM note
ok 2443 - form within ±5d of a KX readmit dedupes into the pair and attaches the CM note
  ---
  duration_ms: 0.277458
  type: 'test'
  ...
# Subtest: form with an Even index stay but NO matching KX readmit is out-of-network, index-side
ok 2444 - form with an Even index stay but NO matching KX readmit is out-of-network, index-side
  ---
  duration_ms: 0.106166
  type: 'test'
  ...
# Subtest: form patients with no Even IP stay are OUT of scope; blank readmission_date is counted, not audited
ok 2445 - form patients with no Even IP stay are OUT of scope; blank readmission_date is counted, not audited
  ---
  duration_ms: 0.057208
  type: 'test'
  ...
# Subtest: ADT mapping priority: the live-validated column wins each candidate list
ok 2446 - ADT mapping priority: the live-validated column wins each candidate list
  ---
  duration_ms: 0.12475
  type: 'test'
  ...
# Subtest: detectReadmissions lane counts + within-30 subset
ok 2447 - detectReadmissions lane counts + within-30 subset
  ---
  duration_ms: 0.06625
  type: 'test'
  ...
# Subtest: planned counts only when foreshadowed in the INDEX summary
ok 2448 - planned counts only when foreshadowed in the INDEX summary
  ---
  duration_ms: 1.808958
  type: 'test'
  ...
# Subtest: planned asserted ONLY in the readmit summary does NOT make it planned
ok 2449 - planned asserted ONLY in the readmit summary does NOT make it planned
  ---
  duration_ms: 0.231959
  type: 'test'
  ...
# Subtest: near-discharge abnormal → high-confidence omission
ok 2450 - near-discharge abnormal → high-confidence omission
  ---
  duration_ms: 0.135583
  type: 'test'
  ...
# Subtest: admission-only labs → lower-confidence, clearly-labelled — never a hard "discharged unstable"
ok 2451 - admission-only labs → lower-confidence, clearly-labelled — never a hard "discharged unstable"
  ---
  duration_ms: 0.1255
  type: 'test'
  ...
# Subtest: missing labs → prose-only track; "no contradicting lab" is NEVER "confirmed stable"
ok 2452 - missing labs → prose-only track; "no contradicting lab" is NEVER "confirmed stable"
  ---
  duration_ms: 0.182375
  type: 'test'
  ...
# Subtest: labTimingProfile: short_stay / has_late_labs / admission_only / no_labs
ok 2453 - labTimingProfile: short_stay / has_late_labs / admission_only / no_labs
  ---
  duration_ms: 0.075917
  type: 'test'
  ...
# Subtest: an uncorroborated exculpatory claim does NOT clear a flagged case
ok 2454 - an uncorroborated exculpatory claim does NOT clear a flagged case
  ---
  duration_ms: 0.177083
  type: 'test'
  ...
# Subtest: a disinterested corroborator makes the exculpatory claim count
ok 2455 - a disinterested corroborator makes the exculpatory claim count
  ---
  duration_ms: 0.093458
  type: 'test'
  ...
# Subtest: same-condition decided on the analyte bundle even when the model followed the renamed diagnosis string
ok 2456 - same-condition decided on the analyte bundle even when the model followed the renamed diagnosis string
  ---
  duration_ms: 0.579459
  type: 'test'
  ...
# Subtest: analyte helpers: canonicalisation, ranges, bundles
ok 2457 - analyte helpers: canonicalisation, ranges, bundles
  ---
  duration_ms: 0.911333
  type: 'test'
  ...
# Subtest: two-pass: same verdict + overlapping evidence ids → avoidable emitted
ok 2458 - two-pass: same verdict + overlapping evidence ids → avoidable emitted
  ---
  duration_ms: 0.075458
  type: 'test'
  ...
# Subtest: two-pass: same verdict + DISJOINT evidence → needs_adjudication
ok 2459 - two-pass: same verdict + DISJOINT evidence → needs_adjudication
  ---
  duration_ms: 0.05625
  type: 'test'
  ...
# Subtest: two-pass: disagreeing verdicts → needs_adjudication; avoidable on interested evidence alone → needs_adjudication
ok 2460 - two-pass: disagreeing verdicts → needs_adjudication; avoidable on interested evidence alone → needs_adjudication
  ---
  duration_ms: 0.061167
  type: 'test'
  ...
# Subtest: hallucinated evidence ids are dropped before the overlap test
ok 2461 - hallucinated evidence ids are dropped before the overlap test
  ---
  duration_ms: 0.042125
  type: 'test'
  ...
# Subtest: a verdict resting only on treating-team prose auto-routes to human review
ok 2462 - a verdict resting only on treating-team prose auto-routes to human review
  ---
  duration_ms: 0.119208
  type: 'test'
  ...
# Subtest: lane-D condition pass: SAME condition sets promoteToFull; different does not
ok 2463 - lane-D condition pass: SAME condition sets promoteToFull; different does not
  ---
  duration_ms: 0.126417
  type: 'test'
  ...
# Subtest: out-of-network: index-side only, NO avoidable verdict, identity always resolved, patient-reported stated
ok 2464 - out-of-network: index-side only, NO avoidable verdict, identity always resolved, patient-reported stated
  ---
  duration_ms: 0.132833
  type: 'test'
  ...
# Subtest: out-of-network planned may come from the CM form flag
ok 2465 - out-of-network planned may come from the CM form flag
  ---
  duration_ms: 0.041208
  type: 'test'
  ...
# Subtest: parsePassClaims: fenced JSON with prose around it parses; junk returns null (fail-safe)
ok 2466 - parsePassClaims: fenced JSON with prose around it parses; junk returns null (fail-safe)
  ---
  duration_ms: 0.190833
  type: 'test'
  ...
# Subtest: extractJsonObject survives nested braces and invalid verdict values are dropped, not guessed
ok 2467 - extractJsonObject survives nested braces and invalid verdict values are dropped, not guessed
  ---
  duration_ms: 0.090375
  type: 'test'
  ...
# Subtest: tier routing: structured labs in window → tier1; none → tier2; no index case → tier3
ok 2468 - tier routing: structured labs in window → tier1; none → tier2; no index case → tier3
  ---
  duration_ms: 2.126917
  type: 'test'
  ...
# Subtest: inferLabTier reads a catalog for pre-1.5 callers: structured lab → tier1, narrative only → tier2, nothing → tier3
ok 2469 - inferLabTier reads a catalog for pre-1.5 callers: structured lab → tier1, narrative only → tier2, nothing → tier3
  ---
  duration_ms: 2.157875
  type: 'test'
  ...
# Subtest: tier-1 numeric omission: index "stable" contradicted by an abnormal value near discharge → high-confidence finding
ok 2470 - tier-1 numeric omission: index "stable" contradicted by an abnormal value near discharge → high-confidence finding
  ---
  duration_ms: 2.435583
  type: 'test'
  ...
# Subtest: the SAME value dated only at admission lowers the confidence and says why (§8c.3)
ok 2471 - the SAME value dated only at admission lowers the confidence and says why (§8c.3)
  ---
  duration_ms: 0.728833
  type: 'test'
  ...
# Subtest: no stability claim in the index narrative → no derived omission (there is nothing to contradict)
ok 2472 - no stability claim in the index narrative → no derived omission (there is nothing to contradict)
  ---
  duration_ms: 0.241417
  type: 'test'
  ...
# Subtest: only the LATEST value at/before discharge is audited — a corrected analyte is not flagged
ok 2473 - only the LATEST value at/before discharge is audited — a corrected analyte is not flagged
  ---
  duration_ms: 0.299833
  type: 'test'
  ...
# Subtest: a value drawn AFTER discharge cannot be an omission — the discharge decision could not have known it
ok 2474 - a value drawn AFTER discharge cannot be an omission — the discharge decision could not have known it
  ---
  duration_ms: 0.13
  type: 'test'
  ...
# Subtest: the derived audit runs ONLY on an explicitly stated tier 1, never on an inferred one
ok 2475 - the derived audit runs ONLY on an explicitly stated tier 1, never on an inferred one
  ---
  duration_ms: 0.178083
  type: 'test'
  ...
# Subtest: stability claims are the discharge-condition kind, not any use of the word
ok 2476 - stability claims are the discharge-condition kind, not any use of the word
  ---
  duration_ms: 0.374875
  type: 'test'
  ...
# Subtest: tier 2 caps an omission at moderate — a summary-vs-summary contradiction is never high-confidence
ok 2477 - tier 2 caps an omission at moderate — a summary-vs-summary contradiction is never high-confidence
  ---
  duration_ms: 0.794709
  type: 'test'
  ...
# Subtest: tier 3 emits no omissions at all and records the refusal
ok 2478 - tier 3 emits no omissions at all and records the refusal
  ---
  duration_ms: 0.357083
  type: 'test'
  ...
# Subtest: only a STRUCTURED value can corroborate a stability claim
ok 2479 - only a STRUCTURED value can corroborate a stability claim
  ---
  duration_ms: 0.332292
  type: 'test'
  ...
# Subtest: the range is a JSON OBJECT: bounds come from .l/.h numerically
ok 2480 - the range is a JSON OBJECT: bounds come from .l/.h numerically
  ---
  duration_ms: 0.679833
  type: 'test'
  ...
# Subtest: an UNPARSEABLE range yields no numeric flag — never a guessed one
ok 2481 - an UNPARSEABLE range yields no numeric flag — never a guessed one
  ---
  duration_ms: 0.424667
  type: 'test'
  ...
# Subtest: an abnormal value against the live object range flags; an in-range one does not
ok 2482 - an abnormal value against the live object range flags; an in-range one does not
  ---
  duration_ms: 0.142834
  type: 'test'
  ...
# Subtest: a value whose range will not parse produces NO derived omission, even under an explicit tier 1
ok 2483 - a value whose range will not parse produces NO derived omission, even under an explicit tier 1
  ---
  duration_ms: 0.212833
  type: 'test'
  ...
# Subtest: refRangeDisplay prefers the lab's own wording over our reconstruction
ok 2484 - refRangeDisplay prefers the lab's own wording over our reconstruction
  ---
  duration_ms: 0.164666
  type: 'test'
  ...
# Subtest: the analyte-name matcher handles the real db13 names (LOINC is absent, so this is the primary path)
ok 2485 - the analyte-name matcher handles the real db13 names (LOINC is absent, so this is the primary path)
  ---
  duration_ms: 1.360792
  type: 'test'
  ...
# Subtest: with loinc_id absent the NAME decides; the code is only the fallback
ok 2486 - with loinc_id absent the NAME decides; the code is only the fallback
  ---
  duration_ms: 0.191291
  type: 'test'
  ...
# Subtest: the LOINC table still resolves where a code exists — kept as the fallback, not the primary path
ok 2487 - the LOINC table still resolves where a code exists — kept as the fallback, not the primary path
  ---
  duration_ms: 0.160416
  type: 'test'
  ...
# Subtest: a renamed diagnosis cannot move the organ bundle: same failing organ both sides → SAME condition
ok 2488 - a renamed diagnosis cannot move the organ bundle: same failing organ both sides → SAME condition
  ---
  duration_ms: 0.26125
  type: 'test'
  ...
# Subtest: a derived omission and the model's version of the same one collapse to one row, derived winning
ok 2489 - a derived omission and the model's version of the same one collapse to one row, derived winning
  ---
  duration_ms: 0.217083
  type: 'test'
  ...
# Subtest: the tier and its provenance ride the finding for the reviewer
ok 2490 - the tier and its provenance ride the finding for the reviewer
  ---
  duration_ms: 0.158125
  type: 'test'
  ...
# Subtest: lanes render clearest-first, and an UNKNOWN lane never hides in the collapsed block
ok 2491 - lanes render clearest-first, and an UNKNOWN lane never hides in the collapsed block
  ---
  duration_ms: 0.958792
  type: 'test'
  ...
# Subtest: within a lane, needs_human_review comes first and then the most recent readmission
ok 2492 - within a lane, needs_human_review comes first and then the most recent readmission
  ---
  duration_ms: 0.220042
  type: 'test'
  ...
# Subtest: the review count is audited AND (avoidable | needs_adjudication) — nothing else
ok 2493 - the review count is audited AND (avoidable | needs_adjudication) — nothing else
  ---
  duration_ms: 0.092
  type: 'test'
  ...
# Subtest: out-of-network never shows an avoidable verdict, and not_auditable says why
ok 2494 - out-of-network never shows an avoidable verdict, and not_auditable says why
  ---
  duration_ms: 0.072625
  type: 'test'
  ...
# Subtest: an excluded row says "Held out", never lane-D’s "No verdict"
ok 2495 - an excluded row says "Held out", never lane-D’s "No verdict"
  ---
  duration_ms: 0.133916
  type: 'test'
  ...
# Subtest: the held-out sample groups last and collapsed, with the audited lanes untouched
ok 2496 - the held-out sample groups last and collapsed, with the audited lanes untouched
  ---
  duration_ms: 0.138959
  type: 'test'
  ...
# Subtest: tiles are blind to excluded rows — the route filters, and the filter is the contract
ok 2497 - tiles are blind to excluded rows — the route filters, and the filter is the contract
  ---
  duration_ms: 0.137334
  type: 'test'
  ...
# Subtest: a badge is omitted rather than guessed — unknown planned, ambiguous department, absent tier
ok 2498 - a badge is omitted rather than guessed — unknown planned, ambiguous department, absent tier
  ---
  duration_ms: 0.475083
  type: 'test'
  ...
# Subtest: the verdict chip never borrows another verdict’s confidence
ok 2499 - the verdict chip never borrows another verdict’s confidence
  ---
  duration_ms: 0.24425
  type: 'test'
  ...
# Subtest: the 30-day rate is null without a real denominator — never a rate over a guess
ok 2500 - the 30-day rate is null without a real denominator — never a rate over a guess
  ---
  duration_ms: 0.304542
  type: 'test'
  ...
# Subtest: a failed name join degrades to the UHID, never a blank card
ok 2501 - a failed name join degrades to the UHID, never a blank card
  ---
  duration_ms: 1.058125
  type: 'test'
  ...
# Subtest: every promptRef tag across all tagged files resolves to a real registry id
ok 2502 - every promptRef tag across all tagged files resolves to a real registry id
  ---
  duration_ms: 2.087459
  type: 'test'
  ...
# Subtest: governedChat is exact delegation (transport-equivalence pin)
ok 2503 - governedChat is exact delegation (transport-equivalence pin)
  ---
  duration_ms: 1.262417
  type: 'test'
  ...
# Subtest: governance config sanity: four call patterns, three governed files, fold declared
ok 2504 - governance config sanity: four call patterns, three governed files, fold declared
  ---
  duration_ms: 10.945542
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: promptFingerprint resolves from the committed registry; unknown id → null, never a throw
ok 2505 - promptFingerprint resolves from the committed registry; unknown id → null, never a throw
  ---
  duration_ms: 0.96125
  type: 'test'
  ...
# Subtest: buildEnvelope: promptRef set → fingerprint columns; unset → call facts only
ok 2506 - buildEnvelope: promptRef set → fingerprint columns; unset → call facts only
  ---
  duration_ms: 0.129458
  type: 'test'
  ...
# Subtest: ENVELOPE_UPDATE_SQL writes exactly the ten normative columns
ok 2507 - ENVELOPE_UPDATE_SQL writes exactly the ten normative columns
  ---
  duration_ms: 0.075
  type: 'test'
  ...
# Subtest: withTrace finalizes exactly once — on success AND on throw
ok 2508 - withTrace finalizes exactly once — on success AND on throw
  ---
  duration_ms: 0.391667
  type: 'test'
  ...
# Subtest: migration 0012 is additive + idempotent and covers every normative column
ok 2509 - migration 0012 is additive + idempotent and covers every normative column
  ---
  duration_ms: 0.415542
  type: 'test'
  ...
# Subtest: governance gate (Stage 4): the repo scan is CLEAN; synthetic direct calls are flagged
ok 2510 - governance gate (Stage 4): the repo scan is CLEAN; synthetic direct calls are flagged
  ---
  duration_ms: 218.934209
  type: 'test'
  ...
# Subtest: every Right Care promptRef tag resolves to a REAL registry id
ok 2511 - every Right Care promptRef tag resolves to a REAL registry id
  ---
  duration_ms: 1.039042
  type: 'test'
  ...
# Subtest: countNonEnumVerdicts (A04) counts exactly the out-of-enum verdicts
ok 2512 - countNonEnumVerdicts (A04) counts exactly the out-of-enum verdicts
  ---
  duration_ms: 0.533542
  type: 'test'
  ...
# Subtest: outcomeForPrompt maps the committed scorecard to the right prompt version/hash
ok 2513 - outcomeForPrompt maps the committed scorecard to the right prompt version/hash
  ---
  duration_ms: 0.599042
  type: 'test'
  ...
# Subtest: RECOMPUTE: arm stats re-derive from the raw runs via the harness scorer — no drift
ok 2514 - RECOMPUTE: arm stats re-derive from the raw runs via the harness scorer — no drift
  ---
  duration_ms: 0.6805
  type: 'test'
  ...
# Subtest: maturity gate: mature requires a cleared gold; the LIVE manifests pass (CI assertion)
ok 2515 - maturity gate: mature requires a cleared gold; the LIVE manifests pass (CI assertion)
  ---
  duration_ms: 0.565166
  type: 'test'
  ...
# Subtest: provenance rider: cwus-ahaacchrs-001 labels as guideline-derived
ok 2516 - provenance rider: cwus-ahaacchrs-001 labels as guideline-derived
  ---
  duration_ms: 0.213875
  type: 'test'
  ...
# Subtest: determinism + evidence currency
ok 2517 - determinism + evidence currency
  ---
  duration_ms: 0.296083
  type: 'test'
  ...
# Subtest: registry generation is deterministic and the committed artifact is current
ok 2518 - registry generation is deterministic and the committed artifact is current
  ---
  duration_ms: 239.556458
  type: 'test'
  ...
# Subtest: every extracted prompt has non-empty text and a valid sha256 of exactly that text
ok 2519 - every extracted prompt has non-empty text and a valid sha256 of exactly that text
  ---
  duration_ms: 0.841667
  type: 'test'
  ...
# Subtest: the research export contains prompt/rubric/metadata keys ONLY — no clinical/patient/trace content
ok 2520 - the research export contains prompt/rubric/metadata keys ONLY — no clinical/patient/trace content
  ---
  duration_ms: 1.397208
  type: 'test'
  ...
# Subtest: manifest merge: registered id gets its metadata; unknown id → unregistered, never a throw
ok 2521 - manifest merge: registered id gets its metadata; unknown id → unregistered, never a throw
  ---
  duration_ms: 0.523666
  type: 'test'
  ...
# Subtest: rubric inclusion: nabh/6e external-json + the five embedded-in-prompt rubrics
ok 2522 - rubric inclusion: nabh/6e external-json + the five embedded-in-prompt rubrics
  ---
  duration_ms: 0.096333
  type: 'test'
  ...
# Subtest: count invariant: counts match the committed artifact contents (30 prompts / 7 rubrics / 32 builders)
ok 2523 - count invariant: counts match the committed artifact contents (30 prompts / 7 rubrics / 32 builders)
  ---
  duration_ms: 0.057791
  type: 'test'
  ...
# Subtest: registryTabRows maps generated + manifest correctly
ok 2524 - registryTabRows maps generated + manifest correctly
  ---
  duration_ms: 2.234417
  type: 'test'
  ...
# Subtest: groupPromptVersionCost sums the 4th breakdown correctly
ok 2525 - groupPromptVersionCost sums the 4th breakdown correctly
  ---
  duration_ms: 0.410292
  type: 'test'
  ...
# Subtest: fingerprint + rollup tolerate NULL columns (pre-Stage-1 rows) without throwing
ok 2526 - fingerprint + rollup tolerate NULL columns (pre-Stage-1 rows) without throwing
  ---
  duration_ms: 21.156334
  type: 'test'
  ...
# Subtest: PHI-safety: new views surface registry/envelope fields only
ok 2527 - PHI-safety: new views surface registry/envelope fields only
  ---
  duration_ms: 4.25475
  type: 'test'
  ...
# Subtest: shortVersion / shortPromptRef formatters
ok 2528 - shortVersion / shortPromptRef formatters
  ---
  duration_ms: 0.103291
  type: 'test'
  ...
# Subtest: promptVersionChanges detects a rollout inside the watch window
ok 2529 - promptVersionChanges detects a rollout inside the watch window
  ---
  duration_ms: 0.305917
  type: 'test'
  ...
# Subtest: GOVERNANCE_SNAPSHOT matches the live scan — the coverage panel cannot rot
ok 2530 - GOVERNANCE_SNAPSHOT matches the live scan — the coverage panel cannot rot
  ---
  duration_ms: 240.427417
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: 55 — every failure-phase to reconciler-state mapping, all four rows of D13's table
ok 2531 - 55 — every failure-phase to reconciler-state mapping, all four rows of D13's table
  ---
  duration_ms: 1.650083
  type: 'test'
  ...
# Subtest: 55 — the selection is bounded, non-terminal only, and oldest first
ok 2532 - 55 — the selection is bounded, non-terminal only, and oldest first
  ---
  duration_ms: 0.366083
  type: 'test'
  ...
# Subtest: 55 — the update is a compare-and-set on the expected revision, and cannot move a terminal row
ok 2533 - 55 — the update is a compare-and-set on the expected revision, and cannot move a terminal row
  ---
  duration_ms: 0.359375
  type: 'test'
  ...
# Subtest: 55 — a revision mismatch causes ONE reread and reclassification, never a blind retry
ok 2534 - 55 — a revision mismatch causes ONE reread and reclassification, never a blind retry
  ---
  duration_ms: 1.091958
  type: 'test'
  ...
# Subtest: 55 — every state the reconciler can assign is a legal transition from where it assigns it
ok 2535 - 55 — every state the reconciler can assign is a legal transition from where it assigns it
  ---
  duration_ms: 0.271667
  type: 'test'
  ...
# Subtest: 55 — the reconciler owns an invocation of its own kind, and closes it
ok 2536 - 55 — the reconciler owns an invocation of its own kind, and closes it
  ---
  duration_ms: 0.488083
  type: 'test'
  ...
# Subtest: 55 runtime — an ordinary one-row pass: one pinned write, no reread
ok 2537 - 55 runtime — an ordinary one-row pass: one pinned write, no reread
  ---
  duration_ms: 10.547208
  type: 'test'
  ...
# Subtest: 55 runtime — the statement the route ACTUALLY SENT is the pinned one, complete
ok 2538 - 55 runtime — the statement the route ACTUALLY SENT is the pinned one, complete
  ---
  duration_ms: 0.920125
  type: 'test'
  ...
# Subtest: 55 runtime — each row's write binds ITS OWN revision
ok 2539 - 55 runtime — each row's write binds ITS OWN revision
  ---
  duration_ms: 0.897875
  type: 'test'
  ...
# Subtest: 55 runtime — THE STALE DECISION DOES NOT LAND: reread, reclassify, write the FRESH state
ok 2540 - 55 runtime — THE STALE DECISION DOES NOT LAND: reread, reclassify, write the FRESH state
  ---
  duration_ms: 0.860084
  type: 'test'
  ...
# Subtest: 55 runtime — a TERMINAL row wins, and no second write is issued
ok 2541 - 55 runtime — a TERMINAL row wins, and no second write is issued
  ---
  duration_ms: 0.795333
  type: 'test'
  ...
# Subtest: 55 runtime — the CUTOFF is the request time minus the preregistered grace
ok 2542 - 55 runtime — the CUTOFF is the request time minus the preregistered grace
  ---
  duration_ms: 0.585083
  type: 'test'
  ...
# Subtest: 55 runtime — a FORBIDDEN transition is refused, and nothing is written
ok 2543 - 55 runtime — a FORBIDDEN transition is refused, and nothing is written
  ---
  duration_ms: 0.351333
  type: 'test'
  ...
# Subtest: the stub fails CLOSED on every body it does not model
ok 2544 - the stub fails CLOSED on every body it does not model
  ---
  duration_ms: 0.317917
  type: 'test'
  ...
# Subtest: 55 behaviour — the SELECT sent at run time is the complete pinned selection
ok 2545 - 55 behaviour — the SELECT sent at run time is the complete pinned selection
  ---
  duration_ms: 0.532209
  type: 'test'
  ...
# Subtest: 55 behaviour — the first write binds the revision the SELECTION returned
ok 2546 - 55 behaviour — the first write binds the revision the SELECTION returned
  ---
  duration_ms: 1.262166
  type: 'test'
  ...
# Subtest: 55 behaviour — a transport error on the write is a 500, never a fabricated verdict
ok 2547 - 55 behaviour — a transport error on the write is a 500, never a fabricated verdict
  ---
  duration_ms: 0.553167
  type: 'test'
  ...
# Subtest: 55 behaviour — a SECOND conflict on the reread path stops after two writes and one reread
ok 2548 - 55 behaviour — a SECOND conflict on the reread path stops after two writes and one reread
  ---
  duration_ms: 4.728959
  type: 'test'
  ...
# Subtest: 55 summary — a slice of TERMINAL rows tallies no reconciliations at all
ok 2549 - 55 summary — a slice of TERMINAL rows tallies no reconciliations at all
  ---
  duration_ms: 0.371458
  type: 'test'
  ...
# Subtest: 55 summary — more_may_remain is TRUE on a full slice and FALSE on a short one
ok 2550 - 55 summary — more_may_remain is TRUE on a full slice and FALSE on a short one
  ---
  duration_ms: 0.575958
  type: 'test'
  ...
# Subtest: 55 behaviour — an unauthenticated request is 401 and touches the database not at all
ok 2551 - 55 behaviour — an unauthenticated request is 401 and touches the database not at all
  ---
  duration_ms: 0.171666
  type: 'test'
  ...
# Subtest: 58 — WORKER_MAX_DURATION_SECONDS equals the worker route's own maxDuration literal
ok 2552 - 58 — WORKER_MAX_DURATION_SECONDS equals the worker route's own maxDuration literal
  ---
  duration_ms: 0.160875
  type: 'test'
  ...
# Subtest: 59 — the reconciler fires at 10:01 UTC, outside every hour the OPD worker runs
ok 2553 - 59 — the reconciler fires at 10:01 UTC, outside every hour the OPD worker runs
  ---
  duration_ms: 0.180209
  type: 'test'
  ...
# Subtest: 64 — both files assert 17, and neither still asserts 16
ok 2554 - 64 — both files assert 17, and neither still asserts 16
  ---
  duration_ms: 0.247666
  type: 'test'
  ...
# Subtest: 64 — undo the one authorised line and each file hashes to exactly what it did at 177adc9
ok 2555 - 64 — undo the one authorised line and each file hashes to exactly what it did at 177adc9
  ---
  duration_ms: 0.315333
  type: 'test'
  ...
# Subtest: 64 — provider-switch-unit-d's sql-guard assertion is untouched, and is nowhere near line 270
ok 2556 - 64 — provider-switch-unit-d's sql-guard assertion is untouched, and is nowhere near line 270
  ---
  duration_ms: 0.130166
  type: 'test'
  ...
# Subtest: artifact — THE ROUTE HAS NOT RUN IN THIS PROCESS
ok 2557 - artifact — THE ROUTE HAS NOT RUN IN THIS PROCESS
  ---
  duration_ms: 0.685042
  type: 'test'
  ...
# Subtest: artifact — the reconciler route is byte-for-byte the reviewed file
ok 2558 - artifact — the reconciler route is byte-for-byte the reviewed file
  ---
  duration_ms: 0.21925
  type: 'test'
  ...
# Subtest: artifact — what this pin does NOT cover
ok 2559 - artifact — what this pin does NOT cover
  ---
  duration_ms: 0.098291
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row state started
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row already terminal (persisted_complete), preserved
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row state started
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row already terminal (persisted_complete), preserved
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row state started
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row state unknown
# Subtest: v7 §8 — a rejected terminal write now leaves DURABLE evidence, not just a console.warn
ok 2560 - v7 §8 — a rejected terminal write now leaves DURABLE evidence, not just a console.warn
  ---
  duration_ms: 2.5115
  type: 'test'
  ...
# Subtest: v7 §8 — the reread distinguishes an already-terminal row from a moved revision
ok 2561 - v7 §8 — the reread distinguishes an already-terminal row from a moved revision
  ---
  duration_ms: 2.3925
  type: 'test'
  ...
# Subtest: v7 §8 — an existing terminal row is NEVER downgraded, and that is structural
ok 2562 - v7 §8 — an existing terminal row is NEVER downgraded, and that is structural
  ---
  duration_ms: 1.042917
  type: 'test'
  ...
# Subtest: v7 §8 — the handle is returned unadvanced, and nothing is retried
ok 2563 - v7 §8 — the handle is returned unadvanced, and nothing is retried
  ---
  duration_ms: 1.072041
  type: 'test'
  ...
# Subtest: v7 §8 — a failed reread still records the evidence, because the reread is diagnostic
ok 2564 - v7 §8 — a failed reread still records the evidence, because the reread is diagnostic
  ---
  duration_ms: 1.233625
  type: 'test'
  ...
# Subtest: v7 §8 — the new phase is run-scoped and in the vocabulary, and the reconciler deliberately ignores it
ok 2565 - v7 §8 — the new phase is run-scoped and in the vocabulary, and the reconciler deliberately ignores it
  ---
  duration_ms: 0.152833
  type: 'test'
  ...
# Subtest: v7 §8 — the generated CHECK and the mirrored .sql agree on the new phase
ok 2566 - v7 §8 — the generated CHECK and the mirrored .sql agree on the new phase
  ---
  duration_ms: 0.320541
  type: 'test'
  ...
# Subtest: v7 §7 — the field is present-and-null when there is no active run, and that validates clean
ok 2567 - v7 §7 — the field is present-and-null when there is no active run, and that validates clean
  ---
  duration_ms: 0.391166
  type: 'test'
  ...
# Subtest: v7 §7 — an ABSENT field is a defect, which is what makes the null a claim rather than a gap
ok 2568 - v7 §7 — an ABSENT field is a defect, which is what makes the null a claim rather than a gap
  ---
  duration_ms: 0.2895
  type: 'test'
  ...
# Subtest: v7 §7 — the definition is recorded, and BackfillRun still has no `target` field
ok 2569 - v7 §7 — the definition is recorded, and BackfillRun still has no `target` field
  ---
  duration_ms: 1.258583
  type: 'test'
  ...
# Subtest: v7 §7 — the writer maps no-active-run to null on all three fields
ok 2570 - v7 §7 — the writer maps no-active-run to null on all three fields
  ---
  duration_ms: 0.719417
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [rerank] backend failed, returning input order transient 503
# [rerank] env-default cohere unavailable → falling back to judge: rerank backend 'cohere' unreachable (m): simulated 403
# [rerank] env-default cohere unavailable → falling back to judge: rerank backend 'cohere' failed the discrimination probe (m): no discrimination
# [rerank] env-default cohere unavailable → falling back to judge: rerank backend 'cohere' missing (m): 404
# [rerank] judge fallback failed → input order: judge is down too
# Subtest: resolveRerankBackend: explicit override wins, else env default; only judge|cohere
ok 2571 - resolveRerankBackend: explicit override wins, else env default; only judge|cohere
  ---
  duration_ms: 7.708
  type: 'test'
  ...
# Subtest: no backend arg routes to the env default (judge in the test env), not cohere
ok 2572 - no backend arg routes to the env default (judge in the test env), not cohere
  ---
  duration_ms: 0.253083
  type: 'test'
  ...
# Subtest: assertRerankBackendHealthy passes when rel=0.8, irr=0.02
ok 2573 - assertRerankBackendHealthy passes when rel=0.8, irr=0.02
  ---
  duration_ms: 3.2915
  type: 'test'
  ...
# Subtest: probe fails RerankBackendUnhealthy when the margin < MIN_MARGIN (rel=0.5, irr=0.45)
ok 2574 - probe fails RerankBackendUnhealthy when the margin < MIN_MARGIN (rel=0.5, irr=0.45)
  ---
  duration_ms: 1.256833
  type: 'test'
  ...
# Subtest: probe fails Unhealthy when the backend returns CONSTANT scores (no discrimination)
ok 2575 - probe fails Unhealthy when the backend returns CONSTANT scores (no discrimination)
  ---
  duration_ms: 0.284916
  type: 'test'
  ...
# Subtest: probe fails RerankBackendUnreachable on fetch throw, non-200, or missing key
ok 2576 - probe fails RerankBackendUnreachable on fetch throw, non-200, or missing key
  ---
  duration_ms: 4.92925
  type: 'test'
  ...
# Subtest: probe is memoized within the TTL — two calls ⇒ one fetch
ok 2577 - probe is memoized within the TTL — two calls ⇒ one fetch
  ---
  duration_ms: 1.118291
  type: 'test'
  ...
# Subtest: rerankCohere maps index→candidate, uses relevance_score directly (no sigmoid), tags cohere
ok 2578 - rerankCohere maps index→candidate, uses relevance_score directly (no sigmoid), tags cohere
  ---
  duration_ms: 0.907125
  type: 'test'
  ...
# Subtest: explicit cohere runs the health probe BEFORE scoring, and a probe failure propagates (not swallowed)
ok 2579 - explicit cohere runs the health probe BEFORE scoring, and a probe failure propagates (not swallowed)
  ---
  duration_ms: 1.288542
  type: 'test'
  ...
# Subtest: a TRANSIENT (generic, non-typed) failure still soft-falls to input order
ok 2580 - a TRANSIENT (generic, non-typed) failure still soft-falls to input order
  ---
  duration_ms: 1.077666
  type: 'test'
  ...
# Subtest: D2.1 env-default cohere: a typed cohere failure ⇒ falls back to JUDGE (tier 1), never throws
ok 2581 - D2.1 env-default cohere: a typed cohere failure ⇒ falls back to JUDGE (tier 1), never throws
  ---
  duration_ms: 0.7745
  type: 'test'
  ...
# Subtest: D2.2 env-default cohere: cohere AND judge both throw ⇒ INPUT ORDER (none), never throws
ok 2582 - D2.2 env-default cohere: cohere AND judge both throw ⇒ INPUT ORDER (none), never throws
  ---
  duration_ms: 2.392125
  type: 'test'
  ...
# Subtest: D2.3 EXPLICIT cohere: a typed cohere failure PROPAGATES (strict — NO fallback to judge)
ok 2583 - D2.3 EXPLICIT cohere: a typed cohere failure PROPAGATES (strict — NO fallback to judge)
  ---
  duration_ms: 0.130917
  type: 'test'
  ...
# Subtest: D2.4 env-default cohere HEALTHY ⇒ cohere scores; probe invoked once (memoization proven in §5.5)
ok 2584 - D2.4 env-default cohere HEALTHY ⇒ cohere scores; probe invoked once (memoization proven in §5.5)
  ---
  duration_ms: 0.07975
  type: 'test'
  ...
# Subtest: D3 a successful cohere rerank records ONE cost entry carrying the response usage.cost
ok 2585 - D3 a successful cohere rerank records ONE cost entry carrying the response usage.cost
  ---
  duration_ms: 0.57925
  type: 'test'
  ...
# Subtest: the rerank module no longer contains any bge symbol
ok 2586 - the rerank module no longer contains any bge symbol
  ---
  duration_ms: 0.335167
  type: 'test'
  ...
# Subtest: discrimination thresholds default to 0.40 / 0.15
ok 2587 - discrimination thresholds default to 0.40 / 0.15
  ---
  duration_ms: 0.041792
  type: 'test'
  ...
# Subtest: §5.1 the LIVE production case: RERANK_BACKEND=Cohere resolves to judge AND warns
ok 2588 - §5.1 the LIVE production case: RERANK_BACKEND=Cohere resolves to judge AND warns
  ---
  duration_ms: 0.043458
  type: 'test'
  ...
# Subtest: §5.1b …and the warning actually FIRES at real module load (cold-start proof, subprocess)
ok 2589 - §5.1b …and the warning actually FIRES at real module load (cold-start proof, subprocess)
  ---
  duration_ms: 304.138167
  type: 'test'
  ...
# Subtest: §5.2 exact lowercase cohere (whitespace-trimmed) selects cohere silently; COHERE warns to judge
ok 2590 - §5.2 exact lowercase cohere (whitespace-trimmed) selects cohere silently; COHERE warns to judge
  ---
  duration_ms: 0.088416
  type: 'test'
  ...
# Subtest: §5.3 judge, trimmed judge and unset are silent; any other value warns to judge
ok 2591 - §5.3 judge, trimmed judge and unset are silent; any other value warns to judge
  ---
  duration_ms: 0.224375
  type: 'test'
  ...
# Subtest: §5.4 miniPipeline normalizes: Mini and " mini " both select the mini pipeline
ok 2592 - §5.4 miniPipeline normalizes: Mini and " mini " both select the mini pipeline
  ---
  duration_ms: 0.0925
  type: 'test'
  ...
# Subtest: §5.5 INVARIANCE: no rerankBackend ⇒ retrieve options deep-equal to today, no extra key
ok 2593 - §5.5 INVARIANCE: no rerankBackend ⇒ retrieve options deep-equal to today, no extra key
  ---
  duration_ms: 0.161834
  type: 'test'
  ...
# Subtest: §5.6 rerankBackend:cohere reaches retrieve() — carried in the opts and threaded at the call sites
ok 2594 - §5.6 rerankBackend:cohere reaches retrieve() — carried in the opts and threaded at the call sites
  ---
  duration_ms: 0.535417
  type: 'test'
  ...
# Subtest: §5.7 explicit cohere via the threaded path stays STRICT — typed errors propagate, no fallback
ok 2595 - §5.7 explicit cohere via the threaded path stays STRICT — typed errors propagate, no fallback
  ---
  duration_ms: 0.165792
  type: 'test'
  ...
# Subtest: pickScoreFields drops text/section, keeps ids + scores
ok 2596 - pickScoreFields drops text/section, keeps ids + scores
  ---
  duration_ms: 0.095708
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [rerank] backend failed, returning input order untyped cohere failure
# Subtest: 2.1 — rerankCohere with an injected fetchImpl serves, stamps the capture, and opens no real socket
ok 2597 - 2.1 — rerankCohere with an injected fetchImpl serves, stamps the capture, and opens no real socket
  ---
  duration_ms: 151.283667
  type: 'test'
  ...
# Subtest: 2.2 — the DEFAULT cohereFn adapter inside rerank passes the capture in the CAPTURE position, not the fetch position
ok 2598 - 2.2 — the DEFAULT cohereFn adapter inside rerank passes the capture in the CAPTURE position, not the fetch position
  ---
  duration_ms: 24.727375
  type: 'test'
  ...
# Subtest: 16.1 — Cohere selected, an UNTYPED throw: inputOrder returned, one synthesised terminal_failure batch, expected == recorded, soft_failed true, row not partial — by the REAL validation chain, both arms
ok 2599 - 16.1 — Cohere selected, an UNTYPED throw: inputOrder returned, one synthesised terminal_failure batch, expected == recorded, soft_failed true, row not partial — by the REAL validation chain, both arms
  ---
  duration_ms: 2.187291
  type: 'test'
  ...
# Subtest: 17.1 — a per-batch throw inside rerankJudge warns, continues, and leaves rerank_soft_failed FALSE
ok 2600 - 17.1 — a per-batch throw inside rerankJudge warns, continues, and leaves rerank_soft_failed FALSE
  ---
  duration_ms: 57.267791
  type: 'test'
  ...
# [rerank] env-default cohere unavailable → falling back to judge: rerank backend 'cohere' unreachable (m): probe refused
# Subtest: 18.1 — JUDGE served: expected_batch_count == ceil(pool / JUDGE_BATCH), JUDGE_BATCH read from source text
ok 2601 - 18.1 — JUDGE served: expected_batch_count == ceil(pool / JUDGE_BATCH), JUDGE_BATCH read from source text
  ---
  duration_ms: 14.93775
  type: 'test'
  ...
# Subtest: 18.2 — COHERE served: expected_batch_count == 1, whatever the pool — stamped by the REAL rerankCohere
ok 2602 - 18.2 — COHERE served: expected_batch_count == 1, whatever the pool — stamped by the REAL rerankCohere
  ---
  duration_ms: 1.436875
  type: 'test'
  ...
# [rerank] env-default cohere unavailable → falling back to judge: rerank backend 'cohere' unreachable (rerank-v3.5): probe refused by design
# Subtest: 18.3 — DERIVED FROM served_backend, NEVER intended_backend: intended Cohere, judge serves, expected is the JUDGE count
ok 2603 - 18.3 — DERIVED FROM served_backend, NEVER intended_backend: intended Cohere, judge serves, expected is the JUDGE count
  ---
  duration_ms: 2.168958
  type: 'test'
  ...
# [rerank] env-default cohere unavailable → falling back to judge: rerank backend 'cohere' unreachable (rerank-v3.5): probe refused by design
# Subtest: 70.1 — RUNTIME ORDER, observed AT INVOCATION: checkHealthy throws RerankBackendError FIRST, the judge is invoked SECOND
ok 2604 - 70.1 — RUNTIME ORDER, observed AT INVOCATION: checkHealthy throws RerankBackendError FIRST, the judge is invoked SECOND
  ---
  duration_ms: 1.380875
  type: 'test'
  ...
# [rerank] env-default cohere unavailable → falling back to judge: rerank backend 'cohere' unreachable (rerank-v3.5): probe refused by design
# Subtest: 70.2 — MANIFEST FACTS: intended_backend cohere, served_backend judge, rerank_backend_downgraded true, expected_batch_count matches the judge
ok 2605 - 70.2 — MANIFEST FACTS: intended_backend cohere, served_backend judge, rerank_backend_downgraded true, expected_batch_count matches the judge
  ---
  duration_ms: 1.456958
  type: 'test'
  ...
# Subtest: 70.3 — the row is persisted_complete by the REAL chain, and a broken payload is persisted_partial
ok 2606 - 70.3 — the row is persisted_complete by the REAL chain, and a broken payload is persisted_partial
  ---
  duration_ms: 1.5105
  type: 'test'
  ...
# Subtest: 70.4 — SOURCE PARITY: provider selection and fallback order in lib/rerank.ts are byte-identical to 72960baa
ok 2607 - 70.4 — SOURCE PARITY: provider selection and fallback order in lib/rerank.ts are byte-identical to 72960baa
  ---
  duration_ms: 42.936959
  type: 'test'
  ...
# [rerank judge] batch failed 0 - 5 Unexpected token 'o', "not json" is not valid JSON
# [rerank judge] batch failed 5 - 6 Unexpected token 'o', "not json" is not valid JSON
# [rerank] backend failed, returning input order generic judge failure
# Subtest: J2.1 — under a JUDGE default: explicit judge, on success and on failure, calls neither checkHealthy nor cohereFn
ok 2608 - J2.1 — under a JUDGE default: explicit judge, on success and on failure, calls neither checkHealthy nor cohereFn
  ---
  duration_ms: 8.405
  type: 'test'
  ...
# [rerank judge] batch failed 0 - 5 Unexpected token 'o', "not json" is not valid JSON
# [rerank judge] batch failed 5 - 6 Unexpected token 'o', "not json" is not valid JSON
# [rerank] backend failed, returning input order generic judge failure
# Subtest: J2.2 — under a HOSTILE COHERE default: explicit judge, on success and on failure, still calls neither — and each failure arm PROVES its failure happened
ok 2609 - J2.2 — under a HOSTILE COHERE default: explicit judge, on success and on failure, still calls neither — and each failure arm PROVES its failure happened
  ---
  duration_ms: 3.933209
  type: 'test'
  ...
# Subtest: THE EXHIBIT: "Atarax Cream…" resolves to NOTHING — not Hydroxyzine, not approximate
ok 2610 - THE EXHIBIT: "Atarax Cream…" resolves to NOTHING — not Hydroxyzine, not approximate
  ---
  duration_ms: 0.935291
  type: 'test'
  ...
# Subtest: the gate fires on the TEXT alone too — no route needed
ok 2611 - the gate fires on the TEXT alone too — no route needed
  ---
  duration_ms: 0.1435
  type: 'test'
  ...
# Subtest: the ORAL Atarax lines still resolve, confident — the gate is surgical
ok 2612 - the ORAL Atarax lines still resolve, confident — the gate is surgical
  ---
  duration_ms: 0.818083
  type: 'test'
  ...
# Subtest: a topical line matching a family that HAS a topical row still resolves
ok 2613 - a topical line matching a family that HAS a topical row still resolves
  ---
  duration_ms: 0.088542
  type: 'test'
  ...
# Subtest: route vocabulary: Topical, "topical " (trailing space) and local ALL count as topical
ok 2614 - route vocabulary: Topical, "topical " (trailing space) and local ALL count as topical
  ---
  duration_ms: 0.14025
  type: 'test'
  ...
# Subtest: phase 1.1 route PHRASES: application/apply-locally/intranasal variants all count as topical
ok 2615 - phase 1.1 route PHRASES: application/apply-locally/intranasal variants all count as topical
  ---
  duration_ms: 0.047
  type: 'test'
  ...
# Subtest: the topical-form regex is the normative one, and word boundaries hold
ok 2616 - the topical-form regex is the normative one, and word boundaries hold
  ---
  duration_ms: 0.111875
  type: 'test'
  ...
# Subtest: tier 5 (brand-prefix, APPROX): a topical line never takes an oral approximate match
ok 2617 - tier 5 (brand-prefix, APPROX): a topical line never takes an oral approximate match
  ---
  duration_ms: 0.049
  type: 'test'
  ...
# Subtest: TIERS 1–3 UNCHANGED: source generic, exact brand and embedded molecule ignore the gate
ok 2618 - TIERS 1–3 UNCHANGED: source generic, exact brand and embedded molecule ignore the gate
  ---
  duration_ms: 0.435417
  type: 'test'
  ...
# Subtest: CONFIDENT_MATCH and classifyUnmatched/NUTRA are untouched
ok 2619 - CONFIDENT_MATCH and classifyUnmatched/NUTRA are untouched
  ---
  duration_ms: 2.654708
  type: 'test'
  ...
# Subtest: the category gate: the three enums, case-sensitive, trimmed — matcher skipped entirely
ok 2620 - the category gate: the three enums, case-sensitive, trimmed — matcher skipped entirely
  ---
  duration_ms: 29.034584
  type: 'test'
  ...
# Subtest: the category gate is CASE-SENSITIVE and enum-exact — near-misses fall through to the matcher
ok 2621 - the category gate is CASE-SENSITIVE and enum-exact — near-misses fall through to the matcher
  ---
  duration_ms: 1.585541
  type: 'test'
  ...
# Subtest: rowToOpdCase carries default_opd_service_category verbatim, fail-safe on absence
ok 2622 - rowToOpdCase carries default_opd_service_category verbatim, fail-safe on absence
  ---
  duration_ms: 0.188667
  type: 'test'
  ...
# Subtest: §5.1: the gate still fires for a category-gated TOPICAL line — the Atarax exhibit
ok 2623 - §5.1: the gate still fires for a category-gated TOPICAL line — the Atarax exhibit
  ---
  duration_ms: 1.131208
  type: 'test'
  ...
# Subtest: §5.2: a category-gated ORAL line runs the matcher — Crocin resolves to Paracetamol
ok 2624 - §5.2: a category-gated ORAL line runs the matcher — Crocin resolves to Paracetamol
  ---
  duration_ms: 1.799625
  type: 'test'
  ...
# Subtest: §5.3 THE PHASE-3 UNBLOCKER: Depura 60000 IU Vitamin D3 Oral Solution resolves to Vitamin D3
ok 2625 - §5.3 THE PHASE-3 UNBLOCKER: Depura 60000 IU Vitamin D3 Oral Solution resolves to Vitamin D3
  ---
  duration_ms: 0.737209
  type: 'test'
  ...
# Subtest: §5.4: category + BLANK route + form word in the brand ⇒ still gated (text is evidence)
ok 2626 - §5.4: category + BLANK route + form word in the brand ⇒ still gated (text is evidence)
  ---
  duration_ms: 0.481375
  type: 'test'
  ...
# Subtest: §5.5: category + blank route + NO form word ⇒ matcher runs — Zincovit Tablet
ok 2627 - §5.5: category + blank route + NO form word ⇒ matcher runs — Zincovit Tablet
  ---
  duration_ms: 0.472375
  type: 'test'
  ...
# Subtest: §5.7: the tier-4/5 form gate from phase 1 is unchanged for non-category topical lines
ok 2628 - §5.7: the tier-4/5 form gate from phase 1 is unchanged for non-category topical lines
  ---
  duration_ms: 0.074083
  type: 'test'
  ...
# Subtest: phase 1.1 direction check: the widened regex can only WITHHOLD matches, never create one
ok 2629 - phase 1.1 direction check: the widened regex can only WITHHOLD matches, never create one
  ---
  duration_ms: 0.215708
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: 28 — ONE multi-row insert, app_source bound explicitly, no stamper involved
ok 2630 - 28 — ONE multi-row insert, app_source bound explicitly, no stamper involved
  ---
  duration_ms: 4.463208
  type: 'test'
  ...
# Subtest: 62 — app_source binds APP_SOURCE when set, and 'standalone' when absent, never null
ok 2631 - 62 — app_source binds APP_SOURCE when set, and 'standalone' when absent, never null
  ---
  duration_ms: 0.721208
  type: 'test'
  ...
# Subtest: the three A/A experiment columns are BOUND, so opd_art_experiment_idx is populable
ok 2632 - the three A/A experiment columns are BOUND, so opd_art_experiment_idx is populable
  ---
  duration_ms: 1.560209
  type: 'test'
  ...
# Subtest: declared_retrievals counts the rows that LANDED, not the rows that were asked for
ok 2633 - declared_retrievals counts the rows that LANDED, not the rows that were asked for
  ---
  duration_ms: 0.763459
  type: 'test'
  ...
# Subtest: a declaration that lands nothing bumps nothing at all
ok 2634 - a declaration that lands nothing bumps nothing at all
  ---
  duration_ms: 0.238166
  type: 'test'
  ...
# Subtest: an empty run list writes nothing and returns an empty handle
ok 2635 - an empty run list writes nothing and returns an empty handle
  ---
  duration_ms: 0.129458
  type: 'test'
  ...
# Subtest: 29 — a failed batch declaration writes ONE work_declaration failure row per generated run
ok 2636 - 29 — a failed batch declaration writes ONE work_declaration failure row per generated run
  ---
  duration_ms: 1.2505
  type: 'test'
  ...
# [retrieval-telemetry] failure row for a run-scoped phase has no run id or role work_declaration
# [retrieval-telemetry] failure store write failed: Error connecting to database: AlsoDown (stub)
# [retrieval-telemetry] telemetry_write_failures increment failed: Error connecting to database: NeonDbError (stub)
# Subtest: 29 — a run-scoped failure phase with no run id is refused before it reaches the CHECK
ok 2637 - 29 — a run-scoped failure phase with no run id is refused before it reaches the CHECK
  ---
  duration_ms: 12.724875
  type: 'test'
  ...
# Subtest: 29 — when the failure store ITSELF fails, the invocation counter is the last evidence
ok 2638 - 29 — when the failure store ITSELF fails, the invocation counter is the last evidence
  ---
  duration_ms: 1.143666
  type: 'test'
  ...
# Subtest: 30 — an invocation insert failure is fail-open, and leaves evidence
ok 2639 - 30 — an invocation insert failure is fail-open, and leaves evidence
  ---
  duration_ms: 2.795875
  type: 'test'
  ...
# Subtest: 30 — the invocation row is inserted once, with its kind and route class
ok 2640 - 30 — the invocation row is inserted once, with its kind and route class
  ---
  duration_ms: 0.145833
  type: 'test'
  ...
# Subtest: closeInvocation is fail-open too, and records a closure failure
ok 2641 - closeInvocation is fail-open too, and records a closure failure
  ---
  duration_ms: 0.325083
  type: 'test'
  ...
# Subtest: the write-failure counter never throws, even when its own UPDATE fails
ok 2642 - the write-failure counter never throws, even when its own UPDATE fails
  ---
  duration_ms: 0.1715
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: RETRIEVAL_LLM_SEED is the fixed shared seed (42), defined once in expand.ts
ok 2643 - RETRIEVAL_LLM_SEED is the fixed shared seed (42), defined once in expand.ts
  ---
  duration_ms: 0.472958
  type: 'test'
  ...
# Subtest: expand.ts: temperature 0 + seed, num_ctx preserved, prompt + fail-open untouched
ok 2644 - expand.ts: temperature 0 + seed, num_ctx preserved, prompt + fail-open untouched
  ---
  duration_ms: 0.145666
  type: 'test'
  ...
# Subtest: multi-query generateQueryVariants: temperature 0 + seed, num_ctx preserved, prompt + fail-open untouched
ok 2645 - multi-query generateQueryVariants: temperature 0 + seed, num_ctx preserved, prompt + fail-open untouched
  ---
  duration_ms: 0.076958
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: 60 A — useReranker false: instrumentation on and off return byte-identical results
ok 2646 - 60 A — useReranker false: instrumentation on and off return byte-identical results
  ---
  duration_ms: 708.007
  type: 'test'
  ...
# Subtest: 60 B — useReranker true: identical results, batch boundaries and prompts across on and off
ok 2647 - 60 B — useReranker true: identical results, batch boundaries and prompts across on and off
  ---
  duration_ms: 32.383167
  type: 'test'
  ...
# Subtest: 60 C — the production opts: identical results with source weighting, expansion and embedding all live
ok 2648 - 60 C — the production opts: identical results with source weighting, expansion and embedding all live
  ---
  duration_ms: 53.263041
  type: 'test'
  ...
# Subtest: 60 — THE CALL-FORM PIN: one side omits the capture argument, per case
ok 2649 - 60 — THE CALL-FORM PIN: one side omits the capture argument, per case
  ---
  duration_ms: 1.143708
  type: 'test'
  ...
# Subtest: 60 — the seven routing fragments are pairwise non-overlapping on the statements that ran
ok 2650 - 60 — the seven routing fragments are pairwise non-overlapping on the statements that ran
  ---
  duration_ms: 0.166167
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [retrieval-telemetry] settlement rejected: no_row primary r1
# [retrieval-telemetry] settlement rejected: stale_revision primary expected 1, found 4
# [retrieval-telemetry] settlement rejected: already_terminal primary persisted_complete
# [retrieval-telemetry] settlement rejected: disallowed_transition primary started -> persisted_complete
# [retrieval-telemetry] settlement rejected: lost_update primary r1
# Subtest: 51 — every settlement outcome has a state, and the mapping is D9's table exactly
ok 2651 - 51 — every settlement outcome has a state, and the mapping is D9's table exactly
  ---
  duration_ms: 2.078958
  type: 'test'
  ...
# Subtest: 51 — saveOpdAudit's four return values each map to their D9 outcome, including skipped
ok 2652 - 51 — saveOpdAudit's four return values each map to their D9 outcome, including skipped
  ---
  duration_ms: 0.161875
  type: 'test'
  ...
# Subtest: 51 — settlement writes ONCE per run, and the write carries the mapped state and the audit id
ok 2653 - 51 — settlement writes ONCE per run, and the write carries the mapped state and the audit id
  ---
  duration_ms: 1.45425
  type: 'test'
  ...
# Subtest: 15 — a retrieval_failure with a persisted audit settles persisted_complete, not partial
ok 2654 - 15 — a retrieval_failure with a persisted audit settles persisted_complete, not partial
  ---
  duration_ms: 0.164
  type: 'test'
  ...
# Subtest: 33 — primary settles, normative fails: one settled, one failed, one failure row, nothing thrown
ok 2655 - 33 — primary settles, normative fails: one settled, one failed, one failure row, nothing thrown
  ---
  duration_ms: 0.709834
  type: 'test'
  ...
# Subtest: 33 — a role still at revision 0 is NOT linked: audit id null, and the state is not the outcome's
ok 2656 - 33 — a role still at revision 0 is NOT linked: audit id null, and the state is not the outcome's
  ---
  duration_ms: 1.372167
  type: 'test'
  ...
# Subtest: revision 0 with retrieval_terminal evidence settles telemetry_persistence_failed
ok 2657 - revision 0 with retrieval_terminal evidence settles telemetry_persistence_failed
  ---
  duration_ms: 0.753709
  type: 'test'
  ...
# Subtest: revision 0 with NO evidence settles aborted
ok 2658 - revision 0 with NO evidence settles aborted
  ---
  duration_ms: 0.374209
  type: 'test'
  ...
# Subtest: revision 0 KEEPS an outcome a never-retrieved run can honestly carry
ok 2659 - revision 0 KEEPS an outcome a never-retrieved run can honestly carry
  ---
  duration_ms: 0.857042
  type: 'test'
  ...
# Subtest: a REJECTED write is reported as rejected, never as settled, and leaves durable evidence
ok 2660 - a REJECTED write is reported as rejected, never as settled, and leaves durable evidence
  ---
  duration_ms: 2.138917
  type: 'test'
  ...
# Subtest: an identical-content retry stays SETTLED and burns no revision
ok 2661 - an identical-content retry stays SETTLED and burns no revision
  ---
  duration_ms: 0.352
  type: 'test'
  ...
# Subtest: v9 §4.2 — settlement REFUSES a duplicate role and reports it, rather than settling it twice
ok 2662 - v9 §4.2 — settlement REFUSES a duplicate role and reports it, rather than settling it twice
  ---
  duration_ms: 0.316584
  type: 'test'
  ...
# Subtest: v9 §4.2 — `status` stays at D12's three values; the new class rides in `rejection`
ok 2663 - v9 §4.2 — `status` stays at D12's three values; the new class rides in `rejection`
  ---
  duration_ms: 0.240417
  type: 'test'
  ...
# Subtest: v9 §4.2 — the vocabulary has SIX classes, and the sixth needs no migration
ok 2664 - v9 §4.2 — the vocabulary has SIX classes, and the sixth needs no migration
  ---
  duration_ms: 0.954042
  type: 'test'
  ...
# Subtest: v9 §4.2 — a duplicate role at the TERMINAL WRITE throws, as an undeclared role already does
ok 2665 - v9 §4.2 — a duplicate role at the TERMINAL WRITE throws, as an undeclared role already does
  ---
  duration_ms: 1.310667
  type: 'test'
  ...
# Subtest: v9 §4.2 — a handle with one run per role is untouched by the guard
ok 2666 - v9 §4.2 — a handle with one run per role is untouched by the guard
  ---
  duration_ms: 0.383083
  type: 'test'
  ...
# Subtest: v9 §4.1 — the base outcome type excludes persisted_dirty, and the mappers cannot produce it
ok 2667 - v9 §4.1 — the base outcome type excludes persisted_dirty, and the mappers cannot produce it
  ---
  duration_ms: 0.173125
  type: 'test'
  ...
# Subtest: the runtime states and the state CHECK are the same list, in the same order
ok 2668 - the runtime states and the state CHECK are the same list, in the same order
  ---
  duration_ms: 2.383875
  type: 'test'
  ...
# Subtest: the outcome CHECK pins its two state lists the same way, and neither slice is empty
ok 2669 - the outcome CHECK pins its two state lists the same way, and neither slice is empty
  ---
  duration_ms: 0.332125
  type: 'test'
  ...
# Subtest: the three outcome-CHECK sets PARTITION all fourteen states — no overlap, none omitted
ok 2670 - the three outcome-CHECK sets PARTITION all fourteen states — no overlap, none omitted
  ---
  duration_ms: 0.095666
  type: 'test'
  ...
# Subtest: two states are non-terminal, and a window cannot close on either
ok 2671 - two states are non-terminal, and a window cannot close on either
  ---
  duration_ms: 0.081041
  type: 'test'
  ...
# Subtest: the migration still declares its retention, access and deletion controls (§4.2)
ok 2672 - the migration still declares its retention, access and deletion controls (§4.2)
  ---
  duration_ms: 0.193167
  type: 'test'
  ...
# Subtest: the HMAC is keyed, versioned, and unreproducible with an unkeyed hash
ok 2673 - the HMAC is keyed, versioned, and unreproducible with an unkeyed hash
  ---
  duration_ms: 2.968
  type: 'test'
  ...
# Subtest: key version travels with the value, so a rotation is visible rather than inferred
ok 2674 - key version travels with the value, so a rotation is visible rather than inferred
  ---
  duration_ms: 0.168834
  type: 'test'
  ...
# Subtest: a missing secret THROWS, and a whitespace-only key counts as missing (D8, test 71)
ok 2675 - a missing secret THROWS, and a whitespace-only key counts as missing (D8, test 71)
  ---
  duration_ms: 0.208167
  type: 'test'
  ...
# Subtest: every served class increments its OWN counter, and a null increments none
ok 2676 - every served class increments its OWN counter, and a null increments none
  ---
  duration_ms: 0.365166
  type: 'test'
  ...
# Subtest: counters derive from the manifest, so row and payload cannot disagree
ok 2677 - counters derive from the manifest, so row and payload cannot disagree
  ---
  duration_ms: 0.358709
  type: 'test'
  ...
# Subtest: rerank_429_attempts is the count of http_429 attempts, wherever they happened (test 13)
ok 2678 - rerank_429_attempts is the count of http_429 attempts, wherever they happened (test 13)
  ---
  duration_ms: 0.069792
  type: 'test'
  ...
# Subtest: batch order is a property of candidate boundaries, never of completion order (constraint 7)
ok 2679 - batch order is a property of candidate boundaries, never of completion order (constraint 7)
  ---
  duration_ms: 0.34725
  type: 'test'
  ...
# Subtest: neither field-bearing manifest declaration has a field that could carry clinical text
ok 2680 - neither field-bearing manifest declaration has a field that could carry clinical text
  ---
  duration_ms: 0.510125
  type: 'test'
  ...
# Subtest: the ban loop really bans — it fails when a banned field is added
ok 2681 - the ban loop really bans — it fails when a banned field is added
  ---
  duration_ms: 0.118667
  type: 'test'
  ...
# Subtest: TelemetryCapture is not declared in the core — the raw bytes live elsewhere (D5)
ok 2682 - TelemetryCapture is not declared in the core — the raw bytes live elsewhere (D5)
  ---
  duration_ms: 0.299584
  type: 'test'
  ...
# Subtest: StampedRetrievalManifest is EXACTLY the intersection, so nothing can be smuggled through it
ok 2683 - StampedRetrievalManifest is EXACTLY the intersection, so nothing can be smuggled through it
  ---
  duration_ms: 2.203
  type: 'test'
  ...
# Subtest: every route maps to a class, and an unknown caller is never assigned to the nearest match
ok 2684 - every route maps to a class, and an unknown caller is never assigned to the nearest match
  ---
  duration_ms: 0.193917
  type: 'test'
  ...
# Subtest: the reconciler is an INVOCATION route and never a retrieval route (D17)
ok 2685 - the reconciler is an INVOCATION route and never a retrieval route (D17)
  ---
  duration_ms: 0.08175
  type: 'test'
  ...
# Subtest: the five roles are closed, and the appropriateness exclusion is by ROUTE not by role
ok 2686 - the five roles are closed, and the appropriateness exclusion is by ROUTE not by role
  ---
  duration_ms: 0.049958
  type: 'test'
  ...
# Subtest: usage aggregates by served provider/model, not by intended
ok 2687 - usage aggregates by served provider/model, not by intended
  ---
  duration_ms: 17.036792
  type: 'test'
  ...
# Subtest: a bucket with no usage reports null tokens and counts the unknowns — never zero (§4.6)
ok 2688 - a bucket with no usage reports null tokens and counts the unknowns — never zero (§4.6)
  ---
  duration_ms: 0.213916
  type: 'test'
  ...
# Subtest: partial usage is summed without inventing the missing half
ok 2689 - partial usage is summed without inventing the missing half
  ---
  duration_ms: 0.157792
  type: 'test'
  ...
# Subtest: local, not-served and skipped stages are UNPRICED; unattributed and parse failures are not
ok 2690 - local, not-served and skipped stages are UNPRICED; unattributed and parse failures are not
  ---
  duration_ms: 0.369584
  type: 'test'
  ...
# Subtest: this module prices nothing — money has ONE source of truth
ok 2691 - this module prices nothing — money has ONE source of truth
  ---
  duration_ms: 1.101
  type: 'test'
  ...
# Subtest: the row contract and the manifest contract version independently (§4.3)
ok 2692 - the row contract and the manifest contract version independently (§4.3)
  ---
  duration_ms: 0.602042
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [retrieval-telemetry] settlement rejected: stale_revision primary expected 0, found 1
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row state unknown
# [retrieval-telemetry] failure store write failed: Error connecting to database: AlsoDown (stub)
# [retrieval-telemetry] failure store write failed: Error connecting to database: AlsoDown (stub)
# [retrieval-telemetry] telemetry_write_failures increment failed: Error connecting to database: DownToo (stub)
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row state unknown
# Subtest: 19 — the predeclared run id is the one every later write targets, and no second row is inserted
ok 2693 - 19 — the predeclared run id is the one every later write targets, and no second row is inserted
  ---
  duration_ms: 2.258042
  type: 'test'
  ...
# Subtest: 20 — declare returns 0, the terminal write returns 1, and a stale handle is REJECTED
ok 2694 - 20 — declare returns 0, the terminal write returns 1, and a stale handle is REJECTED
  ---
  duration_ms: 0.6565
  type: 'test'
  ...
# Subtest: 20 — revisions advance PER ROLE: a normative write cannot invalidate the primary's handle
ok 2695 - 20 — revisions advance PER ROLE: a normative write cannot invalidate the primary's handle
  ---
  duration_ms: 0.876834
  type: 'test'
  ...
# Subtest: 20 — a terminal write that matches nothing is NOT retried, and does not advance the handle
ok 2696 - 20 — a terminal write that matches nothing is NOT retried, and does not advance the handle
  ---
  duration_ms: 0.245334
  type: 'test'
  ...
# Subtest: 31 — the reuse guard returns BEFORE any telemetry statement exists
ok 2697 - 31 — the reuse guard returns BEFORE any telemetry statement exists
  ---
  duration_ms: 0.313875
  type: 'test'
  ...
# Subtest: 32 — the attached handle is absent from JSON.stringify, from the keys, and from a spread
ok 2698 - 32 — the attached handle is absent from JSON.stringify, from the keys, and from a spread
  ---
  duration_ms: 0.102125
  type: 'test'
  ...
# Subtest: 34 — terminal write fails, failure row fails: the invocation counter is the only evidence left
ok 2699 - 34 — terminal write fails, failure row fails: the invocation counter is the only evidence left
  ---
  duration_ms: 0.978041
  type: 'test'
  ...
# Subtest: 34 — and when the counter ALSO fails: a log line, nothing else, still no propagation
ok 2700 - 34 — and when the counter ALSO fails: a log line, nothing else, still no propagation
  ---
  duration_ms: 0.302041
  type: 'test'
  ...
# Subtest: 34 — NO MODULE-LEVEL COUNTER EXISTS ANYWHERE, asserted by source search
ok 2701 - 34 — NO MODULE-LEVEL COUNTER EXISTS ANYWHERE, asserted by source search
  ---
  duration_ms: 0.5785
  type: 'test'
  ...
# Subtest: 52 — every owner in the D9 matrix settles, including both scripts and both MCP paths
ok 2702 - 52 — every owner in the D9 matrix settles, including both scripts and both MCP paths
  ---
  duration_ms: 0.936125
  type: 'test'
  ...
# Subtest: 53 — the callback carries the audit id, and its failure never changes the save result
ok 2703 - 53 — the callback carries the audit id, and its failure never changes the save result
  ---
  duration_ms: 0.213375
  type: 'test'
  ...
# [retrieval-telemetry] terminal write rejected (revision or state moved) normative_channel — row state unknown
# Subtest: CANARY-GATE HAZARD — primary rejected, normative lands: the audit persisted and the Stage 0b primary-link gate fails
ok 2704 - CANARY-GATE HAZARD — primary rejected, normative lands: the audit persisted and the Stage 0b primary-link gate fails
  ---
  duration_ms: 10.546667
  type: 'test'
  ...
# Subtest: CANARY-GATE HAZARD — the mirror: primary lands, normative rejected
ok 2705 - CANARY-GATE HAZARD — the mirror: primary lands, normative rejected
  ---
  duration_ms: 3.817709
  type: 'test'
  ...
# Subtest: 54 — fourteen states, two of them non-terminal, and the two sets partition the whole
ok 2706 - 54 — fourteen states, two of them non-terminal, and the two sets partition the whole
  ---
  duration_ms: 1.147625
  type: 'test'
  ...
# Subtest: 54 — the implemented table IS D12's table, in both directions
ok 2707 - 54 — the implemented table IS D12's table, in both directions
  ---
  duration_ms: 0.792208
  type: 'test'
  ...
# Subtest: 54 — every one of the 196 ordered pairs answers the way D12 says
ok 2708 - 54 — every one of the 196 ordered pairs answers the way D12 says
  ---
  duration_ms: 0.407291
  type: 'test'
  ...
# Subtest: 54 — TERMINAL STATES NEVER TRANSITION, to anything, including themselves
ok 2709 - 54 — TERMINAL STATES NEVER TRANSITION, to anything, including themselves
  ---
  duration_ms: 0.466208
  type: 'test'
  ...
# Subtest: 54 — the two deliberate asymmetries are both present, and are not accidents
ok 2710 - 54 — the two deliberate asymmetries are both present, and are not accidents
  ---
  duration_ms: 0.227041
  type: 'test'
  ...
# Subtest: 54 — every settlement outcome lands on a state, and the settlement table names none of the three reconciler-mapped states
ok 2711 - 54 — every settlement outcome lands on a state, and the settlement table names none of the three reconciler-mapped states
  ---
  duration_ms: 0.203875
  type: 'test'
  ...
# Subtest: 54 — every reconciler-assigned state is a LEGAL transition from the state it is assigned from
ok 2712 - 54 — every reconciler-assigned state is a LEGAL transition from the state it is assigned from
  ---
  duration_ms: 0.24225
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: default path: filter clause array is byte-identical to production, no params
ok 2713 - default path: filter clause array is byte-identical to production, no params
  ---
  duration_ms: 0.811125
  type: 'test'
  ...
# Subtest: default path with structural filters keeps the base guards and remaps $FP offsets per leg
ok 2714 - default path with structural filters keeps the base guards and remaps $FP offsets per leg
  ---
  duration_ms: 0.097542
  type: 'test'
  ...
# Subtest: relaxed path: both quarantine guards gain a bound OR arm on both legs
ok 2715 - relaxed path: both quarantine guards gain a bound OR arm on both legs
  ---
  duration_ms: 0.195416
  type: 'test'
  ...
# Subtest: relaxed path ordering: the quarantine label takes $FP_0, structural filters follow
ok 2716 - relaxed path ordering: the quarantine label takes $FP_0, structural filters follow
  ---
  duration_ms: 0.088625
  type: 'test'
  ...
# Subtest: hostile labels are slugged by labLabel and cannot widen the filter
ok 2717 - hostile labels are slugged by labLabel and cannot widen the filter
  ---
  duration_ms: 0.214292
  type: 'test'
  ...
# Subtest: empty/whitespace includeQuarantined is treated as omitted (byte-identical default path)
ok 2718 - empty/whitespace includeQuarantined is treated as omitted (byte-identical default path)
  ---
  duration_ms: 0.101625
  type: 'test'
  ...
# Subtest: clampLabRetrieveTopK clamps to [1,20], default 8
ok 2719 - clampLabRetrieveTopK clamps to [1,20], default 8
  ---
  duration_ms: 0.067292
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: restrictSources omitted ⇒ default clauses + no params (byte-identical)
ok 2720 - restrictSources omitted ⇒ default clauses + no params (byte-identical)
  ---
  duration_ms: 1.584833
  type: 'test'
  ...
# Subtest: restrictSources: [choosing-wisely] ⇒ both legs source = ANY, bound array param
ok 2721 - restrictSources: [choosing-wisely] ⇒ both legs source = ANY, bound array param
  ---
  duration_ms: 0.314917
  type: 'test'
  ...
# Subtest: a named labq: source is admitted through the quarantine guard; un-named stays excluded
ok 2722 - a named labq: source is admitted through the quarantine guard; un-named stays excluded
  ---
  duration_ms: 0.256542
  type: 'test'
  ...
# Subtest: empty or all-blank restrictSources falls back to the default filter (no restriction)
ok 2723 - empty or all-blank restrictSources falls back to the default filter (no restriction)
  ---
  duration_ms: 0.298583
  type: 'test'
  ...
# Subtest: restrictSources stacks with book/chunk filters and supersedes the single-source filter
ok 2724 - restrictSources stacks with book/chunk filters and supersedes the single-source filter
  ---
  duration_ms: 0.138875
  type: 'test'
  ...
# Subtest: group key exactness: same (subject, signal_type) groups; different signal splits
ok 2725 - group key exactness: same (subject, signal_type) groups; different signal splits
  ---
  duration_ms: 0.795042
  type: 'test'
  ...
# Subtest: '' signal folds like stewardship (empty signal groups together)
ok 2726 - '' signal folds like stewardship (empty signal groups together)
  ---
  duration_ms: 0.264208
  type: 'test'
  ...
# Subtest: ≥2 threshold: a pair groups, a singleton does not
ok 2727 - ≥2 threshold: a pair groups, a singleton does not
  ---
  duration_ms: 0.801834
  type: 'test'
  ...
# Subtest: section order + group sort (size desc, newest tie-break) + singles in queue order
ok 2728 - section order + group sort (size desc, newest tie-break) + singles in queue order
  ---
  duration_ms: 0.675958
  type: 'test'
  ...
# Subtest: disagreement pinning: disagreements section leads the order, groups/singles below
ok 2729 - disagreement pinning: disagreements section leads the order, groups/singles below
  ---
  duration_ms: 0.322459
  type: 'test'
  ...
# Subtest: traversal: within-group → next group → singles; wrap; exhausted → null
ok 2730 - traversal: within-group → next group → singles; wrap; exhausted → null
  ---
  duration_ms: 0.253291
  type: 'test'
  ...
# Subtest: skip sinks within its section and traversal passes it over
ok 2731 - skip sinks within its section and traversal passes it over
  ---
  duration_ms: 0.326208
  type: 'test'
  ...
# Subtest: labeled stays in place (not sunk) with its status; k/n progress counts labeled+skipped
ok 2732 - labeled stays in place (not sunk) with its status; k/n progress counts labeled+skipped
  ---
  duration_ms: 0.163792
  type: 'test'
  ...
# Subtest: determinism: same input → identical output
ok 2733 - determinism: same input → identical output
  ---
  duration_ms: 0.462417
  type: 'test'
  ...
# Subtest: hashBucket is deterministic and in 0..99
ok 2734 - hashBucket is deterministic and in 0..99
  ---
  duration_ms: 0.9525
  type: 'test'
  ...
# Subtest: overlap is ~20% and buckets < 20
ok 2735 - overlap is ~20% and buckets < 20
  ---
  duration_ms: 0.295916
  type: 'test'
  ...
# Subtest: overlap findings are served to EVERY reviewer; partitioned to exactly one
ok 2736 - overlap findings are served to EVERY reviewer; partitioned to exactly one
  ---
  duration_ms: 0.484292
  type: 'test'
  ...
# Subtest: a reviewer not on the roster still gets the overlap set (only)
ok 2737 - a reviewer not on the roster still gets the overlap set (only)
  ---
  duration_ms: 0.128208
  type: 'test'
  ...
# Subtest: partition is roughly even across the roster
ok 2738 - partition is roughly even across the roster
  ---
  duration_ms: 0.162834
  type: 'test'
  ...
# Subtest: balanceBySignalType interleaves types and is newest-first within a type
ok 2739 - balanceBySignalType interleaves types and is newest-first within a type
  ---
  duration_ms: 0.435208
  type: 'test'
  ...
# Subtest: disagreement items come first, then fresh; limit respected
ok 2740 - disagreement items come first, then fresh; limit respected
  ---
  duration_ms: 0.302042
  type: 'test'
  ...
# Subtest: passthrough: optional uid + prescription_url survive buildReviewQueue onto emitted items
ok 2741 - passthrough: optional uid + prescription_url survive buildReviewQueue onto emitted items
  ---
  duration_ms: 2.191125
  type: 'test'
  ...
# Subtest: excludes labeled-by-this-reviewer, informational, unassigned, and filtered-out findings
ok 2742 - excludes labeled-by-this-reviewer, informational, unassigned, and filtered-out findings
  ---
  duration_ms: 0.992666
  type: 'test'
  ...
# Subtest: parseGoal: valid / missing / garbage → exact defaults; personal ceil
ok 2743 - parseGoal: valid / missing / garbage → exact defaults; personal ceil
  ---
  duration_ms: 1.608167
  type: 'test'
  ...
# Subtest: prevDay + istWeekStart (Monday-start)
ok 2744 - prevDay + istWeekStart (Monday-start)
  ---
  duration_ms: 1.686959
  type: 'test'
  ...
# Subtest: countedLabels: impact excluded, missed included, roster filter, finding current-state (later wins)
ok 2745 - countedLabels: impact excluded, missed included, roster filter, finding current-state (later wins)
  ---
  duration_ms: 0.201667
  type: 'test'
  ...
# Subtest: streak: threshold exactly 15, consecutive, yesterday-grace, today-only, gap → 0
ok 2746 - streak: threshold exactly 15, consecutive, yesterday-grace, today-only, gap → 0
  ---
  duration_ms: 0.294583
  type: 'test'
  ...
# Subtest: agreement: pair construction (2 & 3 reviewers), tier match/mismatch, overlap-only
ok 2747 - agreement: pair construction (2 & 3 reviewers), tier match/mismatch, overlap-only
  ---
  duration_ms: 0.255125
  type: 'test'
  ...
# Subtest: agreement: current-state dedup feeds pairs (later verdict wins), then match recomputed
ok 2748 - agreement: current-state dedup feeds pairs (later verdict wins), then match recomputed
  ---
  duration_ms: 0.123333
  type: 'test'
  ...
# Subtest: computeReviewStats: ≥20-pair display boundary, week total, badges shape
ok 2749 - computeReviewStats: ≥20-pair display boundary, week total, badges shape
  ---
  duration_ms: 0.473459
  type: 'test'
  ...
# Subtest: the committed gold artifact is frozen, ratified, and catalog-consistent
ok 2750 - the committed gold artifact is frozen, ratified, and catalog-consistent
  ---
  duration_ms: 3.593584
  type: 'test'
  ...
# Subtest: loadCheckGold rejects drift: wrong version, unratified, polarity/target mismatch
ok 2751 - loadCheckGold rejects drift: wrong version, unratified, polarity/target mismatch
  ---
  duration_ms: 8.228541
  type: 'test'
  ...
# Subtest: the committed 2.0 artifact is frozen, ratified, family-split, and catalog-consistent
ok 2752 - the committed 2.0 artifact is frozen, ratified, family-split, and catalog-consistent
  ---
  duration_ms: 1.709667
  type: 'test'
  ...
# Subtest: loadCheckGold2: accepts the delivered shape — empty targets legal, L carries annex/memberHistory
ok 2753 - loadCheckGold2: accepts the delivered shape — empty targets legal, L carries annex/memberHistory
  ---
  duration_ms: 0.463208
  type: 'test'
  ...
# Subtest: loadCheckGold2 rejects drift: version, status, dup ids, missing verdict fields, annex misuse
ok 2754 - loadCheckGold2 rejects drift: version, status, dup ids, missing verdict fields, annex misuse
  ---
  duration_ms: 1.262167
  type: 'test'
  ...
# Subtest: splitCheckGold2: P/N/C form the scored floor, L is the annex — never folded together
ok 2755 - splitCheckGold2: P/N/C form the scored floor, L is the annex — never folded together
  ---
  duration_ms: 0.890125
  type: 'test'
  ...
# Subtest: checkGold2CatalogGaps: unbound polarity-side targets are flagged, bound ones are not
ok 2756 - checkGold2CatalogGaps: unbound polarity-side targets are flagged, bound ones are not
  ---
  duration_ms: 0.456583
  type: 'test'
  ...
# Subtest: scoreCheckAgainstGold: per-target-rec, deterministic, ignores non-target firings
ok 2757 - scoreCheckAgainstGold: per-target-rec, deterministic, ignores non-target firings
  ---
  duration_ms: 1.005333
  type: 'test'
  ...
# Subtest: aggregateCheckGold: hand-computed recall / specificity / precision / F1
ok 2758 - aggregateCheckGold: hand-computed recall / specificity / precision / F1
  ---
  duration_ms: 0.352
  type: 'test'
  ...
# Subtest: Fix A: ANALYZE_SYSTEM carries the verdict discipline (uncertain = equipoise only)
ok 2759 - Fix A: ANALYZE_SYSTEM carries the verdict discipline (uncertain = equipoise only)
  ---
  duration_ms: 0.969167
  type: 'test'
  ...
# Subtest: Fix A: normNetValue contract unchanged, but the parse fallback is now visible
ok 2760 - Fix A: normNetValue contract unchanged, but the parse fallback is now visible
  ---
  duration_ms: 0.208792
  type: 'test'
  ...
# Subtest: Fix B: the two syncope recs are in the seed, verified, unique, well-formed
ok 2761 - Fix B: the two syncope recs are in the seed, verified, unique, well-formed
  ---
  duration_ms: 0.129833
  type: 'test'
  ...
# Subtest: Fix B gold: deterministic recall hits C04 with BOTH new recs, and no other check case
ok 2762 - Fix B gold: deterministic recall hits C04 with BOTH new recs, and no other check case
  ---
  duration_ms: 0.9835
  type: 'test'
  ...
# Subtest: flag-off byte-identical: every grounded builder without the param equals Slice 1 exactly
ok 2763 - flag-off byte-identical: every grounded builder without the param equals Slice 1 exactly
  ---
  duration_ms: 0.815792
  type: 'test'
  ...
# Subtest: grounded: the picture lands between the input and the downstream sections, verbatim
ok 2764 - grounded: the picture lands between the input and the downstream sections, verbatim
  ---
  duration_ms: 0.14425
  type: 'test'
  ...
# Subtest: patientPictureBlock: formatClinicalState content + the two prompt rules
ok 2765 - patientPictureBlock: formatClinicalState content + the two prompt rules
  ---
  duration_ms: 1.337417
  type: 'test'
  ...
# Subtest: grounding flag is double-gated on the master flag
ok 2766 - grounding flag is double-gated on the master flag
  ---
  duration_ms: 0.102416
  type: 'test'
  ...
# Subtest: frozen bank right-care-eval/1.0: pinned, unique ids, per-mode shape
ok 2767 - frozen bank right-care-eval/1.0: pinned, unique ids, per-mode shape
  ---
  duration_ms: 0.766958
  type: 'test'
  ...
# Subtest: pair-judge parser: defensive on directions, safety classes, fences
ok 2768 - pair-judge parser: defensive on directions, safety classes, fences
  ---
  duration_ms: 0.966166
  type: 'test'
  ...
# Subtest: deterministic check diff: added / removed / kept by rec id
ok 2769 - deterministic check diff: added / removed / kept by rec id
  ---
  duration_ms: 0.607917
  type: 'test'
  ...
# Subtest: scorecard gates: FAIL_SAFETY dominates; PASS needs net improvement clearing noise
ok 2770 - scorecard gates: FAIL_SAFETY dominates; PASS needs net improvement clearing noise
  ---
  duration_ms: 0.550791
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: Order check constructs a ClinicalState from the provided input with counts > 0
ok 2771 - Order check constructs a ClinicalState from the provided input with counts > 0
  ---
  duration_ms: 3.413959
  type: 'test'
  ...
# Subtest: Care pathway constructs from the presentation field with counts > 0
ok 2772 - Care pathway constructs from the presentation field with counts > 0
  ---
  duration_ms: 0.580458
  type: 'test'
  ...
# Subtest: Record audit adapts the existing ExtractedCase and round-trips on the shared fields
ok 2773 - Record audit adapts the existing ExtractedCase and round-trips on the shared fields
  ---
  duration_ms: 0.8885
  type: 'test'
  ...
# Subtest: fail-open: a throwing LLM stage keeps the deterministic state; junk input never throws
ok 2774 - fail-open: a throwing LLM stage keeps the deterministic state; junk input never throws
  ---
  duration_ms: 0.371625
  type: 'test'
  ...
# Subtest: flag-off neutrality: no gate flag → feature inert; UI field off → {}
ok 2775 - flag-off neutrality: no gate flag → feature inert; UI field off → {}
  ---
  duration_ms: 0.509667
  type: 'test'
  ...
# Subtest: save-run reconstruction: same pure builders, schema-valid, per mode
ok 2776 - save-run reconstruction: same pure builders, schema-valid, per mode
  ---
  duration_ms: 0.770875
  type: 'test'
  ...
# Subtest: member link: strict validation, and identity stays OUT of the state
ok 2777 - member link: strict validation, and identity stays OUT of the state
  ---
  duration_ms: 0.240583
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: 1 — a PRIMARY defect leaves the NORMATIVE run clean
ok 2778 - 1 — a PRIMARY defect leaves the NORMATIVE run clean
  ---
  duration_ms: 1.95025
  type: 'test'
  ...
# Subtest: 2 — a NORMATIVE defect leaves the PRIMARY run clean
ok 2779 - 2 — a NORMATIVE defect leaves the PRIMARY run clean
  ---
  duration_ms: 0.376708
  type: 'test'
  ...
# Subtest: 3 — both roles dirty: both settle dirty
ok 2780 - 3 — both roles dirty: both settle dirty
  ---
  duration_ms: 0.525792
  type: 'test'
  ...
# Subtest: 4 — neither dirty: both settle clean
ok 2781 - 4 — neither dirty: both settle clean
  ---
  duration_ms: 0.222209
  type: 'test'
  ...
# Subtest: 4b — an EMPTY array is clean; an ABSENT key on a linkable run is NOT
ok 2782 - 4b — an EMPTY array is clean; an ABSENT key on a linkable run is NOT
  ---
  duration_ms: 1.08275
  type: 'test'
  ...
# Subtest: 5 — no map at all: a single-role save behaves exactly as before
ok 2783 - 5 — no map at all: a single-role save behaves exactly as before
  ---
  duration_ms: 1.23325
  type: 'test'
  ...
# Subtest: 5b — only the CLEAN branch is upgraded; a losing race or a skip is never made partial
ok 2784 - 5b — only the CLEAN branch is upgraded; a losing race or a skip is never made partial
  ---
  duration_ms: 0.090167
  type: 'test'
  ...
# Subtest: 5c — a revision-0 role is still not linked, and the per-run upgrade did not disturb that
ok 2785 - 5c — a revision-0 role is still not linked, and the per-run upgrade did not disturb that
  ---
  duration_ms: 0.349917
  type: 'test'
  ...
# Subtest: 6 — every persistence owner passes the role map, and none passes an empty one where it holds defects
ok 2786 - 6 — every persistence owner passes the role map, and none passes an empty one where it holds defects
  ---
  duration_ms: 1.290292
  type: 'test'
  ...
# Subtest: 6b — the upgrade is applied in settlement, not by the owners
ok 2787 - 6b — the upgrade is applied in settlement, not by the owners
  ---
  duration_ms: 0.97775
  type: 'test'
  ...
# Subtest: 6c — settleOwned still takes ONE base outcome and makes ONE settlement call
ok 2788 - 6c — settleOwned still takes ONE base outcome and makes ONE settlement call
  ---
  duration_ms: 0.187834
  type: 'test'
  ...
# Subtest: 6d — settlement is fail-safe: a role map on a handle with no runs settles nothing and throws nothing
ok 2789 - 6d — settlement is fail-safe: a role map on a handle with no runs settles nothing and throws nothing
  ---
  duration_ms: 0.055708
  type: 'test'
  ...
# Subtest: 7 — the three cases of `verdictForRun`, stated directly
ok 2790 - 7 — the three cases of `verdictForRun`, stated directly
  ---
  duration_ms: 0.43225
  type: 'test'
  ...
# Subtest: 7b — requirement 10: an INHERITED key is not a verdict
ok 2791 - 7b — requirement 10: an INHERITED key is not a verdict
  ---
  duration_ms: 0.201
  type: 'test'
  ...
# Subtest: 7c — an inherited key does not rescue a run from partial, through settlement
ok 2792 - 7c — an inherited key does not rescue a run from partial, through settlement
  ---
  duration_ms: 0.159
  type: 'test'
  ...
# Subtest: 7d — THE PLACEMENT TEST: the rule reaches a linkable run and stops at a revision-zero one
ok 2793 - 7d — THE PLACEMENT TEST: the rule reaches a linkable run and stops at a revision-zero one
  ---
  duration_ms: 0.233416
  type: 'test'
  ...
# Subtest: 7e — requirement 3 in the only place it is observable: settlement never mutates the map
ok 2794 - 7e — requirement 3 in the only place it is observable: settlement never mutates the map
  ---
  duration_ms: 0.128875
  type: 'test'
  ...
# Subtest: 7f — the base outcome still decides: only a CLEAN run is made partial by a missing key
ok 2795 - 7f — the base outcome still decides: only a CLEAN run is made partial by a missing key
  ---
  duration_ms: 0.045375
  type: 'test'
  ...
# Subtest: 7g — no new settlement outcome value was added, and nothing writes the synthetic code
ok 2796 - 7g — no new settlement outcome value was added, and nothing writes the synthetic code
  ---
  duration_ms: 0.716791
  type: 'test'
  ...
# Subtest: matchRoomCategory prefers the longest alias and falls back
ok 2797 - matchRoomCategory prefers the longest alias and falls back
  ---
  duration_ms: 1.276917
  type: 'test'
  ...
# Subtest: excessBedDays = LOS − benchmark, floored at 0
ok 2798 - excessBedDays = LOS − benchmark, floored at 0
  ---
  duration_ms: 0.195875
  type: 'test'
  ...
# Subtest: computeBedDayCost: 8-day single room over-stay = 7 × 6500 = 45,500 (est.)
ok 2799 - computeBedDayCost: 8-day single room over-stay = 7 × 6500 = 45,500 (est.)
  ---
  duration_ms: 15.961667
  type: 'test'
  ...
# Subtest: computeBedDayCost returns 0 when not flagged, day-care, or single-day
ok 2800 - computeBedDayCost returns 0 when not flagged, day-care, or single-day
  ---
  duration_ms: 0.092167
  type: 'test'
  ...
# Subtest: tariff-status table drops the (est.) label
ok 2801 - tariff-status table drops the (est.) label
  ---
  duration_ms: 0.162709
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: the routes still declare the numbers this guard reads
ok 2802 - the routes still declare the numbers this guard reads
  ---
  duration_ms: 1.242292
  type: 'test'
  ...
# Subtest: the body extractor is not vacuous — it finds real code, not an empty default param
ok 2803 - the body extractor is not vacuous — it finds real code, not an empty default param
  ---
  duration_ms: 1.311458
  type: 'test'
  ...
# Subtest: IPD_ANALYZE_LEGS equals the analyze call sites in lib/doc-audit.ts — a FOURTH leg fails here
ok 2804 - IPD_ANALYZE_LEGS equals the analyze call sites in lib/doc-audit.ts — a FOURTH leg fails here
  ---
  duration_ms: 0.509792
  type: 'test'
  ...
# Subtest: OPD_AUDIT_LEGS equals the EXECUTABLE legs in auditOpdNote — a third fails here
ok 2805 - OPD_AUDIT_LEGS equals the EXECUTABLE legs in auditOpdNote — a third fails here
  ---
  duration_ms: 0.830542
  type: 'test'
  ...
# Subtest: THE IPD WORKER FITS ITS BOX, for every provider that can serve it
ok 2806 - THE IPD WORKER FITS ITS BOX, for every provider that can serve it
  ---
  duration_ms: 0.35925
  type: 'test'
  ...
# Subtest: ipd-audit-now fits the same box on the same basis (DEC-B5)
ok 2807 - ipd-audit-now fits the same box on the same basis (DEC-B5)
  ---
  duration_ms: 0.103625
  type: 'test'
  ...
# Subtest: THE OPD WORKER FITS ITS BOX, for every provider that can serve it
ok 2808 - THE OPD WORKER FITS ITS BOX, for every provider that can serve it
  ---
  duration_ms: 0.339041
  type: 'test'
  ...
# Subtest: the OPD call site sends a per-attempt ceiling that matches its budget (DEC-B9)
ok 2809 - the OPD call site sends a per-attempt ceiling that matches its budget (DEC-B9)
  ---
  duration_ms: 0.585292
  type: 'test'
  ...
# Subtest: raising max, lowering the box, or adding a retry FAILS the guard
ok 2810 - raising max, lowering the box, or adding a retry FAILS the guard
  ---
  duration_ms: 0.267292
  type: 'test'
  ...
# Subtest: a null budget means REFUSE, never substitute a default
ok 2811 - a null budget means REFUSE, never substitute a default
  ---
  duration_ms: 0.552375
  type: 'test'
  ...
# Subtest: the IPD cron interval clears the IPD box — and this is NOT extended to OPD
ok 2812 - the IPD cron interval clears the IPD box — and this is NOT extended to OPD
  ---
  duration_ms: 0.194291
  type: 'test'
  ...
# Subtest: OPENROUTER_TIMEOUT_MS and OPENROUTER_MAX_TRIES still read 110,000 and 3
ok 2813 - OPENROUTER_TIMEOUT_MS and OPENROUTER_MAX_TRIES still read 110,000 and 3
  ---
  duration_ms: 0.043042
  type: 'test'
  ...
# Subtest: check mode → Runs + Interventions + CW_Flags + Citations, normalized by run_id
ok 2814 - check mode → Runs + Interventions + CW_Flags + Citations, normalized by run_id
  ---
  duration_ms: 1.185625
  type: 'test'
  ...
# Subtest: pathway mode → PathwayStages merges skeleton+enrichment by id, ordered
ok 2815 - pathway mode → PathwayStages merges skeleton+enrichment by id, ordered
  ---
  duration_ms: 0.159125
  type: 'test'
  ...
# Subtest: audit mode → findings/completeness/diff/suggestions/idealised/extracted/citations
ok 2816 - audit mode → findings/completeness/diff/suggestions/idealised/extracted/citations
  ---
  duration_ms: 0.224125
  type: 'test'
  ...
# Subtest: mergeRunSheets stacks rows across runs by sheet name
ok 2817 - mergeRunSheets stacks rows across runs by sheet name
  ---
  duration_ms: 0.1475
  type: 'test'
  ...
# Subtest: THE INVARIANT: all-Standard weighting reproduces legacy completeness EXACTLY
ok 2818 - THE INVARIANT: all-Standard weighting reproduces legacy completeness EXACTLY
  ---
  duration_ms: 1.271292
  type: 'test'
  ...
# Subtest: THE INVARIANT holds for the null vector too (PRD §8.1 fallback = legacy behaviour)
ok 2819 - THE INVARIANT holds for the null vector too (PRD §8.1 fallback = legacy behaviour)
  ---
  duration_ms: 0.151292
  type: 'test'
  ...
# Subtest: THE INVARIANT holds at all-Minor as well (PRD §8.4: mathematically identical to all-Standard)
ok 2820 - THE INVARIANT holds at all-Minor as well (PRD §8.4: mathematically identical to all-Standard)
  ---
  duration_ms: 0.198084
  type: 'test'
  ...
# Subtest: the fixture set actually exercises the hard cases (guards against a vacuous invariant)
ok 2821 - the fixture set actually exercises the hard cases (guards against a vacuous invariant)
  ---
  duration_ms: 0.134209
  type: 'test'
  ...
# Subtest: the na-policy divergence is REAL and this build takes the legacy branch (flagged deviation)
ok 2822 - the na-policy divergence is REAL and this build takes the legacy branch (flagged deviation)
  ---
  duration_ms: 0.12025
  type: 'test'
  ...
# Subtest: a CONDITIONAL na leaves both sides under BOTH policies (mandatoryTotal 20 vs 21, PRD §2.9)
ok 2823 - a CONDITIONAL na leaves both sides under BOTH policies (mandatoryTotal 20 vs 21, PRD §2.9)
  ---
  duration_ms: 0.081917
  type: 'test'
  ...
# Subtest: tier points are exactly Critical 8 · Important 4 · Standard 2 · Minor 1, and none is zero
ok 2824 - tier points are exactly Critical 8 · Important 4 · Standard 2 · Minor 1, and none is zero
  ---
  duration_ms: 0.097625
  type: 'test'
  ...
# Subtest: normalised weights sum to 100.0 ± 0.05 for every combination (PRD §10)
ok 2825 - normalised weights sum to 100.0 ± 0.05 for every combination (PRD §10)
  ---
  duration_ms: 1.234708
  type: 'test'
  ...
# Subtest: weighting actually MOVES the score when tiers differ (the change is not a no-op)
ok 2826 - weighting actually MOVES the score when tiers differ (the change is not a no-op)
  ---
  duration_ms: 0.246792
  type: 'test'
  ...
# Subtest: partial is exactly 0.5, and na is not partial
ok 2827 - partial is exactly 0.5, and na is not partial
  ---
  duration_ms: 0.311041
  type: 'test'
  ...
# Subtest: all-na document returns 100 without dividing by zero (PRD §8.5)
ok 2828 - all-na document returns 100 without dividing by zero (PRD §8.5)
  ---
  duration_ms: 0.05925
  type: 'test'
  ...
# Subtest: unknown key defaults to Standard; empty/garbage vector falls back to equal weights (PRD §8.2)
ok 2829 - unknown key defaults to Standard; empty/garbage vector falls back to equal weights (PRD §8.2)
  ---
  duration_ms: 0.062625
  type: 'test'
  ...
# Subtest: malformed input never throws and never produces a wrong-looking score
ok 2830 - malformed input never throws and never produces a wrong-looking score
  ---
  duration_ms: 0.113667
  type: 'test'
  ...
# Subtest: rounding is half-up, applied via legacy's DOUBLE round
ok 2831 - rounding is half-up, applied via legacy's DOUBLE round
  ---
  duration_ms: 0.063209
  type: 'test'
  ...
# Subtest: missingMandatory lists applicable missing fields by label (the unweighted gap count)
ok 2832 - missingMandatory lists applicable missing fields by label (the unweighted gap count)
  ---
  duration_ms: 0.040375
  type: 'test'
  ...
# Subtest: legacyCompleteness (the independent path) agrees with the null-vector weighted path
ok 2833 - legacyCompleteness (the independent path) agrees with the null-vector weighted path
  ---
  duration_ms: 0.238375
  type: 'test'
  ...
# Subtest: the re-stated domain weights match the closed cores VERBATIM (drift guard)
ok 2834 - the re-stated domain weights match the closed cores VERBATIM (drift guard)
  ---
  duration_ms: 0.19075
  type: 'test'
  ...
# Subtest: OPD index reproduces the core formula on a worked case
ok 2835 - OPD index reproduces the core formula on a worked case
  ---
  duration_ms: 0.086958
  type: 'test'
  ...
# Subtest: PDQI-9 absent ⇒ note_quality drops and the divisor is 0.75 (PRD §2.6)
ok 2836 - PDQI-9 absent ⇒ note_quality drops and the divisor is 0.75 (PRD §2.6)
  ---
  duration_ms: 0.047333
  type: 'test'
  ...
# Subtest: Care-Value Index reproduces the six-domain formula
ok 2837 - Care-Value Index reproduces the six-domain formula
  ---
  duration_ms: 0.051875
  type: 'test'
  ...
# Subtest: substituting a new documentation score moves the index and can re-band
ok 2838 - substituting a new documentation score moves the index and can re-band
  ---
  duration_ms: 0.050708
  type: 'test'
  ...
# Subtest: band boundaries at 39/40, 54/55, 69/70, 84/85
ok 2839 - band boundaries at 39/40, 54/55, 69/70, 84/85
  ---
  duration_ms: 0.045458
  type: 'test'
  ...
# Subtest: no domain scores at all ⇒ index 0, not NaN
ok 2840 - no domain scores at all ⇒ index 0, not NaN
  ---
  duration_ms: 0.03575
  type: 'test'
  ...
# Subtest: the weights-version label is exact (PRD §2.8, §8.3)
ok 2841 - the weights-version label is exact (PRD §2.8, §8.3)
  ---
  duration_ms: 0.046083
  type: 'test'
  ...
# Subtest: preview: an unchanged candidate moves nothing
ok 2842 - preview: an unchanged candidate moves nothing
  ---
  duration_ms: 0.398125
  type: 'test'
  ...
# Subtest: preview: making a widely-missing field Critical moves the mean and reports movers
ok 2843 - preview: making a widely-missing field Critical moves the mean and reports movers
  ---
  duration_ms: 11.215667
  type: 'test'
  ...
# Subtest: preview: empty cohort yields zeroed stats, no throw (the OPD empty state)
ok 2844 - preview: empty cohort yields zeroed stats, no throw (the OPD empty state)
  ---
  duration_ms: 0.579541
  type: 'test'
  ...
# Subtest: preview: SD is population SD and a single row has SD 0
ok 2845 - preview: SD is population SD and a single row has SD 0
  ---
  duration_ms: 0.471708
  type: 'test'
  ...
# Subtest: missingPrevalence excludes `na` from the base, and reports a percentage
ok 2846 - missingPrevalence excludes `na` from the base, and reports a percentage
  ---
  duration_ms: 0.53125
  type: 'test'
  ...
# Subtest: systemic-defect warning fires only above 50% missing AND only at Critical; it never blocks
ok 2847 - systemic-defect warning fires only above 50% missing AND only at Critical; it never blocks
  ---
  duration_ms: 0.301917
  type: 'test'
  ...
# Subtest: the systemic-defect copy is verbatim per PRD §5.3
ok 2848 - the systemic-defect copy is verbatim per PRD §5.3
  ---
  duration_ms: 0.607625
  type: 'test'
  ...
# Subtest: scoreRow routes IPD and OPD to different index formulas
ok 2849 - scoreRow routes IPD and OPD to different index formulas
  ---
  duration_ms: 2.409416
  type: 'test'
  ...
# Subtest: the 21 discharge_summary fields match data/nabh-rubric.json EXACTLY (key, label, section)
ok 2850 - the 21 discharge_summary fields match data/nabh-rubric.json EXACTLY (key, label, section)
  ---
  duration_ms: 0.533
  type: 'test'
  ...
# Subtest: cause_of_death is the ONE conditional key, read from the rubric
ok 2851 - cause_of_death is the ONE conditional key, read from the rubric
  ---
  duration_ms: 0.295167
  type: 'test'
  ...
# Subtest: the OPD label→key mapping covers every live-observed label (companion spec §4.7)
ok 2852 - the OPD label→key mapping covers every live-observed label (companion spec §4.7)
  ---
  duration_ms: 4.317042
  type: 'test'
  ...
# Subtest: the OPD engine's ACTUAL emitted keys are all in the catalogue (no orphan can appear)
ok 2853 - the OPD engine's ACTUAL emitted keys are all in the catalogue (no orphan can appear)
  ---
  duration_ms: 0.354208
  type: 'test'
  ...
# Subtest: the OPD structured emission is ADDITIVE: status/section added, present/mandatory preserved
ok 2854 - the OPD structured emission is ADDITIVE: status/section added, present/mandatory preserved
  ---
  duration_ms: 21.796916
  type: 'test'
  ...
# Subtest: the OPD engine emits the structured shape from BOTH completeness paths (GP and obstetric)
ok 2855 - the OPD engine emits the structured shape from BOTH completeness paths (GP and obstetric)
  ---
  duration_ms: 1.414833
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: A.1 THE FALLBACK RULE: a NULL completeness_items row keeps its stored scores, untouched
ok 2856 - A.1 THE FALLBACK RULE: a NULL completeness_items row keeps its stored scores, untouched
  ---
  duration_ms: 619.189334
  type: 'test'
  ...
# Subtest: A.1 a missing array is never read as 100 NOR as 0 — both directions
ok 2857 - A.1 a missing array is never read as 100 NOR as 0 — both directions
  ---
  duration_ms: 33.482
  type: 'test'
  ...
# Subtest: A.1 a row WITH items is weighted, and weights_not_applicable flips to false
ok 2858 - A.1 a row WITH items is weighted, and weights_not_applicable flips to false
  ---
  duration_ms: 3.880458
  type: 'test'
  ...
# Subtest: A.1 continuity items are EXCLUDED from the OPD denominator (reproduces the engine's coverage)
ok 2859 - A.1 continuity items are EXCLUDED from the OPD denominator (reproduces the engine's coverage)
  ---
  duration_ms: 7.090292
  type: 'test'
  ...
# Subtest: A.1 applyOpdScoringPolicy never throws and handles an empty batch
ok 2860 - A.1 applyOpdScoringPolicy never throws and handles an empty batch
  ---
  duration_ms: 5.911709
  type: 'test'
  ...
# Subtest: A.1 parseOpdCompletenessItems drops malformed entries rather than throwing
ok 2861 - A.1 parseOpdCompletenessItems drops malformed entries rather than throwing
  ---
  duration_ms: 3.138541
  type: 'test'
  ...
# Subtest: A.1 the OPD write path persists the array, guarded by a column probe
ok 2862 - A.1 the OPD write path persists the array, guarded by a column probe
  ---
  duration_ms: 0.223916
  type: 'test'
  ...
# Subtest: A.1 the migration runner exists, is admin-guarded, and every statement is idempotent
ok 2863 - A.1 the migration runner exists, is admin-guarded, and every statement is idempotent
  ---
  duration_ms: 0.219833
  type: 'test'
  ...
# Subtest: A.1 the runner's inlined DDL matches the two .sql files it stands in for
ok 2864 - A.1 the runner's inlined DDL matches the two .sql files it stands in for
  ---
  duration_ms: 1.154625
  type: 'test'
  ...
# Subtest: A.1 no backfill: nothing in the build writes completeness_items to historical rows
ok 2865 - A.1 no backfill: nothing in the build writes completeness_items to historical rows
  ---
  duration_ms: 0.184583
  type: 'test'
  ...
# Subtest: the three continuity fields are EXCLUDED from the OPD weight vector (kickoff normative list)
ok 2866 - the three continuity fields are EXCLUDED from the OPD weight vector (kickoff normative list)
  ---
  duration_ms: 0.06625
  type: 'test'
  ...
# Subtest: the near-duplicate pairs are kept SEPARATE and flagged, not merged
ok 2867 - the near-duplicate pairs are kept SEPARATE and flagged, not merged
  ---
  duration_ms: 0.07175
  type: 'test'
  ...
# Subtest: labelToOpdKey: dynamic obstetric labels match by prefix; unknown returns null (never guesses)
ok 2868 - labelToOpdKey: dynamic obstetric labels match by prefix; unknown returns null (never guesses)
  ---
  duration_ms: 0.224875
  type: 'test'
  ...
# Subtest: every catalogued OPD label round-trips through the mapping
ok 2869 - every catalogued OPD label round-trips through the mapping
  ---
  duration_ms: 0.0575
  type: 'test'
  ...
# Subtest: fieldsFor / weightedKeysFor route by note type and never return an empty key space
ok 2870 - fieldsFor / weightedKeysFor route by note type and never return an empty key space
  ---
  duration_ms: 0.035625
  type: 'test'
  ...
# Subtest: diffVectors reports only real changes, with old → new tiers
ok 2871 - diffVectors reports only real changes, with old → new tiers
  ---
  duration_ms: 0.178834
  type: 'test'
  ...
# Subtest: vectorsEqual treats absent as Standard (so a seeded v1 equals an empty draft)
ok 2872 - vectorsEqual treats absent as Standard (so a seeded v1 equals an empty draft)
  ---
  duration_ms: 0.049666
  type: 'test'
  ...
# Subtest: validateVector rejects non-objects but coerces unknown tiers rather than failing
ok 2873 - validateVector rejects non-objects but coerces unknown tiers rather than failing
  ---
  duration_ms: 0.106083
  type: 'test'
  ...
# Subtest: canonicalVectorJson is stable regardless of key insertion order
ok 2874 - canonicalVectorJson is stable regardless of key insertion order
  ---
  duration_ms: 0.050834
  type: 'test'
  ...
# Subtest: bySection groups and preserves first-seen order
ok 2875 - bySection groups and preserves first-seen order
  ---
  duration_ms: 0.084666
  type: 'test'
  ...
# Subtest: computeSignalHealth: FP rate, latest-per-doctor, top reasons, healable
ok 2876 - computeSignalHealth: FP rate, latest-per-doctor, top reasons, healable
  ---
  duration_ms: 0.589083
  type: 'test'
  ...
# Subtest: computeSignalHealth: ranks noisiest (audit_bug × rate) first
ok 2877 - computeSignalHealth: ranks noisiest (audit_bug × rate) first
  ---
  duration_ms: 0.134459
  type: 'test'
  ...
# Subtest: findingMatchesSuppression: type/scope/discriminator/active gates
ok 2878 - findingMatchesSuppression: type/scope/discriminator/active gates
  ---
  duration_ms: 0.107
  type: 'test'
  ...
# Subtest: applySuppressions: drop removes, downgrade sets informational, no active = no-op
ok 2879 - applySuppressions: drop removes, downgrade sets informational, no active = no-op
  ---
  duration_ms: 0.177208
  type: 'test'
  ...
# Subtest: previewCollateral: dual-label invariant — refuses to remove a validated signal
ok 2880 - previewCollateral: dual-label invariant — refuses to remove a validated signal
  ---
  duration_ms: 0.100833
  type: 'test'
  ...
# Subtest: every ratified tier-2 kind maps to tier 2, not unlisted
ok 2881 - every ratified tier-2 kind maps to tier 2, not unlisted
  ---
  duration_ms: 1.246291
  type: 'test'
  ...
# Subtest: every ratified tier-3 kind maps to tier 3 — log only
ok 2882 - every ratified tier-3 kind maps to tier 3 — log only
  ---
  duration_ms: 0.149333
  type: 'test'
  ...
# Subtest: banned_fdc is ratified TIER 2 (not higher) and pregnancy_risk_verify is ratified TIER 3
ok 2883 - banned_fdc is ratified TIER 2 (not higher) and pregnancy_risk_verify is ratified TIER 3
  ---
  duration_ms: 0.058833
  type: 'test'
  ...
# Subtest: O1c: a model-invented kind lands in tier 2 and is flagged unlisted
ok 2884 - O1c: a model-invented kind lands in tier 2 and is flagged unlisted
  ---
  duration_ms: 0.059291
  type: 'test'
  ...
# Subtest: praise: *_high_value kinds and any high-value verdict (antibiotic_stewardship praise) are excluded and counted
ok 2885 - praise: *_high_value kinds and any high-value verdict (antibiotic_stewardship praise) are excluded and counted
  ---
  duration_ms: 0.093458
  type: 'test'
  ...
# Subtest: antibiotic_stewardship VIOLATION (low-value — antibiotic for a viral URTI) is tier 2
ok 2886 - antibiotic_stewardship VIOLATION (low-value — antibiotic for a viral URTI) is tier 2
  ---
  duration_ms: 0.095125
  type: 'test'
  ...
# Subtest: incomplete_dosing: missing strength / duration alone → tier 3 (ratified rows: findings 20, 24, 37, 41 + chronic continuation)
ok 2887 - incomplete_dosing: missing strength / duration alone → tier 3 (ratified rows: findings 20, 24, 37, 41 + chronic continuation)
  ---
  duration_ms: 0.578958
  type: 'test'
  ...
# Subtest: incomplete_dosing: a missing frequency or route changes what the patient does → tier 2; unparseable → tier 2
ok 2888 - incomplete_dosing: a missing frequency or route changes what the patient does → tier 2; unparseable → tier 2
  ---
  duration_ms: 0.075125
  type: 'test'
  ...
# Subtest: E-1 (finding 36): a time-critical cardiac pattern in the finding text promotes to tier 1 — from any kind
ok 2889 - E-1 (finding 36): a time-critical cardiac pattern in the finding text promotes to tier 1 — from any kind
  ---
  duration_ms: 0.20475
  type: 'test'
  ...
# Subtest: E-2 (finding 49): persistent swelling ≥ 4 weeks with no follow-through promotes; with follow-through it does not
ok 2890 - E-2 (finding 49): persistent swelling ≥ 4 weeks with no follow-through promotes; with follow-through it does not
  ---
  duration_ms: 3.7205
  type: 'test'
  ...
# Subtest: praise never escalates: a high-value finding praising an appropriate ACS referral stays praise
ok 2891 - praise never escalates: a high-value finding praising an appropriate ACS referral stays praise
  ---
  duration_ms: 0.071208
  type: 'test'
  ...
# Subtest: bucketByTier: buckets are disjoint, complete, and count unlisted kinds
ok 2892 - bucketByTier: buckets are disjoint, complete, and count unlisted kinds
  ---
  duration_ms: 0.243333
  type: 'test'
  ...
# Subtest: dedupeTwins: same (finding_ref, doctor_uid, day) collapses with an occurrence count; different notes same day still collapse; different days do not
ok 2893 - dedupeTwins: same (finding_ref, doctor_uid, day) collapses with an occurrence count; different notes same day still collapse; different days do not
  ---
  duration_ms: 0.929208
  type: 'test'
  ...
# Subtest: dedupeTwins: unkeyable rows (no ref / no doctor / no date) never merge
ok 2894 - dedupeTwins: unkeyable rows (no ref / no doctor / no date) never merge
  ---
  duration_ms: 0.115667
  type: 'test'
  ...
# Subtest: allows SELECT / WITH and auto-adds LIMIT
ok 2895 - allows SELECT / WITH and auto-adds LIMIT
  ---
  duration_ms: 1.014208
  type: 'test'
  ...
# Subtest: rejects writes, DDL, multiple statements, non-SELECT, over-cap LIMIT, system fns
ok 2896 - rejects writes, DDL, multiple statements, non-SELECT, over-cap LIMIT, system fns
  ---
  duration_ms: 0.101333
  type: 'test'
  ...
# Subtest: blocks PHI-bearing relations anywhere in the query
ok 2897 - blocks PHI-bearing relations anywhere in the query
  ---
  duration_ms: 0.113333
  type: 'test'
  ...
# Subtest: honors a smaller caller cap
ok 2898 - honors a smaller caller cap
  ---
  duration_ms: 0.062459
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: coverage floor (PRD §4): ≥5 dose-ceiling, ≥3 SOS, ≥3 banned-FDC, ≥4 interaction, ≥4 incomplete-dosing positives; exactly 6 negatives
ok 2899 - coverage floor (PRD §4): ≥5 dose-ceiling, ≥3 SOS, ≥3 banned-FDC, ≥4 interaction, ≥4 incomplete-dosing positives; exactly 6 negatives
  ---
  duration_ms: 5.185416
  type: 'test'
  ...
# Subtest: fixtures carry no PHI, no db13 uid, and banned-FDC fixtures use placeholder molecules only
ok 2900 - fixtures carry no PHI, no db13 uid, and banned-FDC fixtures use placeholder molecules only
  ---
  duration_ms: 0.292334
  type: 'test'
  ...
# Subtest: positive POS-DOSE-1 fires dose_ceiling_exceeded — paracetamol stacked across two products: 650 QID + 500 TDS = 4100 mg/day > 4000
ok 2901 - positive POS-DOSE-1 fires dose_ceiling_exceeded — paracetamol stacked across two products: 650 QID + 500 TDS = 4100 mg/day > 4000
  ---
  duration_ms: 0.928
  type: 'test'
  ...
# Subtest: positive POS-DOSE-2 fires dose_ceiling_exceeded — ibuprofen 800 QID = 3200 mg/day > 2400 (single product)
ok 2902 - positive POS-DOSE-2 fires dose_ceiling_exceeded — ibuprofen 800 QID = 3200 mg/day > 2400 (single product)
  ---
  duration_ms: 0.116291
  type: 'test'
  ...
# Subtest: positive POS-DOSE-3 fires dose_ceiling_exceeded — diclofenac 75 TDS = 225 mg/day > 150
ok 2903 - positive POS-DOSE-3 fires dose_ceiling_exceeded — diclofenac 75 TDS = 225 mg/day > 150
  ---
  duration_ms: 0.104833
  type: 'test'
  ...
# Subtest: positive POS-DOSE-4 fires dose_ceiling_exceeded — etoricoxib 120 OD with NO documented gout > the 90 mg/day default ceiling (Decision 6)
ok 2904 - positive POS-DOSE-4 fires dose_ceiling_exceeded — etoricoxib 120 OD with NO documented gout > the 90 mg/day default ceiling (Decision 6)
  ---
  duration_ms: 0.075292
  type: 'test'
  ...
# Subtest: positive POS-DOSE-5 fires dose_ceiling_exceeded — mefenamic acid 500 QID = 2000 mg/day > 1500
ok 2905 - positive POS-DOSE-5 fires dose_ceiling_exceeded — mefenamic acid 500 QID = 2000 mg/day > 1500
  ---
  duration_ms: 0.201667
  type: 'test'
  ...
# Subtest: positive POS-SOS-1 fires dose_ceiling_sos — paracetamol 1000 TDS scheduled + 650 SOS uncapped (default cap 3) → 4950 potential > 4000
ok 2906 - positive POS-SOS-1 fires dose_ceiling_sos — paracetamol 1000 TDS scheduled + 650 SOS uncapped (default cap 3) → 4950 potential > 4000
  ---
  duration_ms: 0.075792
  type: 'test'
  ...
# Subtest: positive POS-SOS-2 fires dose_ceiling_sos — etoricoxib 90 SOS with an EXPLICIT max 2/day → 180 potential > 90
ok 2907 - positive POS-SOS-2 fires dose_ceiling_sos — etoricoxib 90 SOS with an EXPLICIT max 2/day → 180 potential > 90
  ---
  duration_ms: 0.383291
  type: 'test'
  ...
# Subtest: positive POS-SOS-3 fires dose_ceiling_sos — ibuprofen 600 grid 1-0-1 + 600 SOS uncapped → 3000 potential > 2400
ok 2908 - positive POS-SOS-3 fires dose_ceiling_sos — ibuprofen 600 grid 1-0-1 + 600 SOS uncapped → 3000 potential > 2400
  ---
  duration_ms: 0.647833
  type: 'test'
  ...
# Subtest: positive POS-FDC-1 fires banned_fdc — exact two-molecule banned set (placeholders mol-a + mol-b)
ok 2909 - positive POS-FDC-1 fires banned_fdc — exact two-molecule banned set (placeholders mol-a + mol-b)
  ---
  duration_ms: 0.09025
  type: 'test'
  ...
# Subtest: positive POS-FDC-2 fires banned_fdc — exact three-molecule banned set (placeholders mol-c/mol-d/mol-e)
ok 2910 - positive POS-FDC-2 fires banned_fdc — exact three-molecule banned set (placeholders mol-c/mol-d/mol-e)
  ---
  duration_ms: 0.073917
  type: 'test'
  ...
# Subtest: positive POS-FDC-3 fires banned_fdc — order-swapped banned pair (mol-b + mol-a) still matches the stored set
ok 2911 - positive POS-FDC-3 fires banned_fdc — order-swapped banned pair (mol-b + mol-a) still matches the stored set
  ---
  duration_ms: 0.056875
  type: 'test'
  ...
# Subtest: positive POS-DDI-1 fires drug_interaction — warfarin + ibuprofen — anticoagulant + NSAID (major)
ok 2912 - positive POS-DDI-1 fires drug_interaction — warfarin + ibuprofen — anticoagulant + NSAID (major)
  ---
  duration_ms: 0.052833
  type: 'test'
  ...
# Subtest: positive POS-DDI-2 fires drug_interaction — atorvastatin + clarithromycin — statin + macrolide (major)
ok 2913 - positive POS-DDI-2 fires drug_interaction — atorvastatin + clarithromycin — statin + macrolide (major)
  ---
  duration_ms: 0.053834
  type: 'test'
  ...
# Subtest: positive POS-DDI-3 fires drug_interaction — sertraline + tramadol — two serotonergic drugs (major)
ok 2914 - positive POS-DDI-3 fires drug_interaction — sertraline + tramadol — two serotonergic drugs (major)
  ---
  duration_ms: 0.055125
  type: 'test'
  ...
# Subtest: positive POS-DDI-4 fires drug_interaction — telmisartan + spironolactone — ACE-I/ARB + potassium-sparing diuretic (major)
ok 2915 - positive POS-DDI-4 fires drug_interaction — telmisartan + spironolactone — ACE-I/ARB + potassium-sparing diuretic (major)
  ---
  duration_ms: 0.055916
  type: 'test'
  ...
# Subtest: positive POS-DOSING-1 fires incomplete_dosing — dose/strength blanked (no dose field, no strength, none in the name)
ok 2916 - positive POS-DOSING-1 fires incomplete_dosing — dose/strength blanked (no dose field, no strength, none in the name)
  ---
  duration_ms: 0.06325
  type: 'test'
  ...
# Subtest: positive POS-DOSING-2 fires incomplete_dosing — frequency blanked
ok 2917 - positive POS-DOSING-2 fires incomplete_dosing — frequency blanked
  ---
  duration_ms: 0.053917
  type: 'test'
  ...
# Subtest: positive POS-DOSING-3 fires incomplete_dosing — duration blanked
ok 2918 - positive POS-DOSING-3 fires incomplete_dosing — duration blanked
  ---
  duration_ms: 0.0535
  type: 'test'
  ...
# Subtest: positive POS-DOSING-4 fires incomplete_dosing — route blanked and not inferable (no dosage-form word anywhere on the line)
ok 2919 - positive POS-DOSING-4 fires incomplete_dosing — route blanked and not inferable (no dosage-form word anywhere on the line)
  ---
  duration_ms: 0.054875
  type: 'test'
  ...
# Subtest: negative NEG-1 stays silent — ibuprofen 800 TDS = exactly 2400 mg/day — AT the ceiling, not over it
ok 2920 - negative NEG-1 stays silent — ibuprofen 800 TDS = exactly 2400 mg/day — AT the ceiling, not over it
  ---
  duration_ms: 0.097584
  type: 'test'
  ...
# Subtest: negative NEG-2 stays silent — etoricoxib 120 OD WITH a documented gout diagnosis — the conditional 120 ceiling applies
ok 2921 - negative NEG-2 stays silent — etoricoxib 120 OD WITH a documented gout diagnosis — the conditional 120 ceiling applies
  ---
  duration_ms: 0.051833
  type: 'test'
  ...
# Subtest: negative NEG-3 stays silent — amoxicillin + paracetamol — just OUTSIDE every interaction pair (no shared mechanism tag)
ok 2922 - negative NEG-3 stays silent — amoxicillin + paracetamol — just OUTSIDE every interaction pair (no shared mechanism tag)
  ---
  duration_ms: 0.055333
  type: 'test'
  ...
# Subtest: negative NEG-4 stays silent — a COMPLETE prescription — dose, frequency, duration and route all present
ok 2923 - negative NEG-4 stays silent — a COMPLETE prescription — dose, frequency, duration and route all present
  ---
  duration_ms: 0.055042
  type: 'test'
  ...
# Subtest: negative NEG-5 stays silent — banned core + one extra molecule (mol-a + mol-b + mol-z) — the C5 superset boundary
ok 2924 - negative NEG-5 stays silent — banned core + one extra molecule (mol-a + mol-b + mol-z) — the C5 superset boundary
  ---
  duration_ms: 0.111375
  type: 'test'
  ...
# Subtest: negative NEG-6 stays silent — paracetamol 500 SOS max 3/day = 1500 mg potential — well inside the 4000 ceiling
ok 2925 - negative NEG-6 stays silent — paracetamol 500 SOS max 3/day = 1500 mg potential — well inside the 4000 ceiling
  ---
  duration_ms: 0.101291
  type: 'test'
  ...
# Subtest: recall_det = fired / planted, over the deterministic leg only (no LLM recall claim — PRD §6)
ok 2926 - recall_det = fired / planted, over the deterministic leg only (no LLM recall claim — PRD §6)
  ---
  duration_ms: 0.098916
  type: 'test'
  ...
# Subtest: 57 case 1 — production Vercel build with no key at all: MISSING
ok 2927 - 57 case 1 — production Vercel build with no key at all: MISSING
  ---
  duration_ms: 0.553917
  type: 'test'
  ...
# Subtest: 57 case 2 — production Vercel build with an unusable key (empty or whitespace): MISSING
ok 2928 - 57 case 2 — production Vercel build with an unusable key (empty or whitespace): MISSING
  ---
  duration_ms: 0.068625
  type: 'test'
  ...
# Subtest: 57 case 3 — production Vercel build with a usable key: NOT missing
ok 2929 - 57 case 3 — production Vercel build with a usable key: NOT missing
  ---
  duration_ms: 0.048583
  type: 'test'
  ...
# Subtest: 57 case 4 — a Vercel build that is not production: NOT missing, at any key value
ok 2930 - 57 case 4 — a Vercel build that is not production: NOT missing, at any key value
  ---
  duration_ms: 0.12275
  type: 'test'
  ...
# Subtest: 57 case 5 — not a Vercel build, even when the environment says production: NOT missing
ok 2931 - 57 case 5 — not a Vercel build, even when the environment says production: NOT missing
  ---
  duration_ms: 0.058541
  type: 'test'
  ...
# Subtest: 57 EXECUTED — importing the config in production with no key throws, and names the variable
ok 2932 - 57 EXECUTED — importing the config in production with no key throws, and names the variable
  ---
  duration_ms: 43.07175
  type: 'test'
  ...
# Subtest: 57 EXECUTED — a production import WITH a key succeeds
ok 2933 - 57 EXECUTED — a production import WITH a key succeeds
  ---
  duration_ms: 40.083167
  type: 'test'
  ...
# Subtest: 57 EXECUTED — a non-production import with no key succeeds
ok 2934 - 57 EXECUTED — a non-production import with no key succeeds
  ---
  duration_ms: 57.556709
  type: 'test'
  ...
# Subtest: 57 whole file — it parses, and holds EXACTLY three top-level statements in order
ok 2935 - 57 whole file — it parses, and holds EXACTLY three top-level statements in order
  ---
  duration_ms: 8.865417
  type: 'test'
  ...
# Subtest: 57 whole file — the declaration and the export are exactly what they must be
ok 2936 - 57 whole file — the declaration and the export are exactly what they must be
  ---
  duration_ms: 2.697208
  type: 'test'
  ...
# Subtest: 57 whole file — nothing executable outside the guard
ok 2937 - 57 whole file — nothing executable outside the guard
  ---
  duration_ms: 0.152459
  type: 'test'
  ...
# Subtest: 57 pin — each copy is exactly D8's three clauses, and there is no fourth of any kind
ok 2938 - 57 pin — each copy is exactly D8's three clauses, and there is no fourth of any kind
  ---
  duration_ms: 0.395417
  type: 'test'
  ...
# Subtest: 57 pin — next.config.mjs and telemetry-key-guard.ts express the SAME condition
ok 2939 - 57 pin — next.config.mjs and telemetry-key-guard.ts express the SAME condition
  ---
  duration_ms: 0.180458
  type: 'test'
  ...
# Subtest: 57 pin — the guard THROWS one Error, and the message a reader sees names the variable
ok 2940 - 57 pin — the guard THROWS one Error, and the message a reader sees names the variable
  ---
  duration_ms: 0.131125
  type: 'test'
  ...
# Subtest: no surface outside the allow-list SELECTs from the telemetry tables
ok 2941 - no surface outside the allow-list SELECTs from the telemetry tables
  ---
  duration_ms: 163.535584
  type: 'test'
  ...
# Subtest: the scan can actually fail — it is not passing because the matcher never matches
ok 2942 - the scan can actually fail — it is not passing because the matcher never matches
  ---
  duration_ms: 0.115917
  type: 'test'
  ...
# Subtest: the allow-list is by EXACT path, and every entry is one this build owns
ok 2943 - the allow-list is by EXACT path, and every entry is one this build owns
  ---
  duration_ms: 0.165333
  type: 'test'
  ...
# Subtest: no clinician-facing or patient-facing route names a telemetry table at all
ok 2944 - no clinician-facing or patient-facing route names a telemetry table at all
  ---
  duration_ms: 30.445625
  type: 'test'
  ...
# Subtest: GUARD 1 — admin: a set ADMIN_TOKEN with nothing presented is refused, and isAdminUnlocked is NOT consulted
ok 2945 - GUARD 1 — admin: a set ADMIN_TOKEN with nothing presented is refused, and isAdminUnlocked is NOT consulted
  ---
  duration_ms: 287.287125
  type: 'test'
  ...
# Subtest: GUARD 3 — preview: VERCEL_ENV=production is refused even with everything else correct
ok 2946 - GUARD 3 — preview: VERCEL_ENV=production is refused even with everything else correct
  ---
  duration_ms: 254.689875
  type: 'test'
  ...
# Subtest: GUARD 3 — preview: VERCEL_ENV=preview on a DIFFERENT branch is refused
ok 2947 - GUARD 3 — preview: VERCEL_ENV=preview on a DIFFERENT branch is refused
  ---
  duration_ms: 272.318125
  type: 'test'
  ...
# Subtest: GUARD 4 — arming: an unset CDMSS_OVERHEAD_MEASURE is refused
ok 2948 - GUARD 4 — arming: an unset CDMSS_OVERHEAD_MEASURE is refused
  ---
  duration_ms: 257.467458
  type: 'test'
  ...
# Subtest: GUARD 5 — THE ONE THAT MATTERS: a production endpoint id is refused
ok 2949 - GUARD 5 — THE ONE THAT MATTERS: a production endpoint id is refused
  ---
  duration_ms: 191.684417
  type: 'test'
  ...
# Subtest: GUARD 5 — an UNSET expectation refuses, it does not pass
ok 2950 - GUARD 5 — an UNSET expectation refuses, it does not pass
  ---
  duration_ms: 153.0785
  type: 'test'
  ...
# Subtest: GUARD 5 — an unparseable DATABASE_URL refuses
ok 2951 - GUARD 5 — an unparseable DATABASE_URL refuses
  ---
  duration_ms: 146.547167
  type: 'test'
  ...
# Subtest: GUARD 5 — a password containing @ cannot shift the parsed host
ok 2952 - GUARD 5 — a password containing @ cannot shift the parsed host
  ---
  duration_ms: 147.43525
  type: 'test'
  ...
# Subtest: GUARD 2 — expiry: past the hard UTC date every request is 410
ok 2953 - GUARD 2 — expiry: past the hard UTC date every request is 410
  ---
  duration_ms: 149.601875
  type: 'test'
  ...
# Subtest: GUARD 2 — before the expiry the route still runs
ok 2954 - GUARD 2 — before the expiry the route still runs
  ---
  duration_ms: 153.48725
  type: 'test'
  ...
# Subtest: ALL FIVE PASS — the route runs, writes route=script, and reports the first sample separately
ok 2955 - ALL FIVE PASS — the route runs, writes route=script, and reports the first sample separately
  ---
  duration_ms: 157.530959
  type: 'test'
  ...
# Subtest: FIX 2 + FIX 1 — a REAL 500, driven by an unparseable URL that still satisfies guard 5
ok 2956 - FIX 2 + FIX 1 — a REAL 500, driven by an unparseable URL that still satisfies guard 5
  ---
  duration_ms: 150.164584
  type: 'test'
  ...
# Subtest: v5 FIX 1 — two of the three leaking shapes are refused BEFORE the driver ever sees them
ok 2957 - v5 FIX 1 — two of the three leaking shapes are refused BEFORE the driver ever sees them
  ---
  duration_ms: 294.080125
  type: 'test'
  ...
# Subtest: FIX 3 — a query parameter cannot move the parsed host away from the one the driver uses
ok 2958 - FIX 3 — a query parameter cannot move the parsed host away from the one the driver uses
  ---
  duration_ms: 139.9685
  type: 'test'
  ...
# Subtest: FIX 4 — the denylist refuses production even when the expected value also names it
ok 2959 - FIX 4 — the denylist refuses production even when the expected value also names it
  ---
  duration_ms: 140.850791
  type: 'test'
  ...
# Subtest: FIX 4 — an ABSENT denylist refuses: a denylist that is not there is not a denylist
ok 2960 - FIX 4 — an ABSENT denylist refuses: a denylist that is not there is not a denylist
  ---
  duration_ms: 146.354166
  type: 'test'
  ...
# Subtest: FIX 5 — p95 and p99 are withheld below their floors, never a maximum in disguise
ok 2961 - FIX 5 — p95 and p99 are withheld below their floors, never a maximum in disguise
  ---
  duration_ms: 309.327834
  type: 'test'
  ...
# Subtest: FIX 5 — and p95 IS emitted once its floor is met, so the floor is not a blanket refusal
ok 2962 - FIX 5 — and p95 IS emitted once its floor is met, so the floor is not a blanket refusal
  ---
  duration_ms: 153.659708
  type: 'test'
  ...
# Subtest: FIX 6 — the invocation insert has its own cell
ok 2963 - FIX 6 — the invocation insert has its own cell
  ---
  duration_ms: 287.555
  type: 'test'
  ...
# Subtest: FIX 7 — the shape is true per cell, and conc is gone
ok 2964 - FIX 7 — the shape is true per cell, and conc is gone
  ---
  duration_ms: 291.141583
  type: 'test'
  ...
# Subtest: FIX 8 — the real-audit arm refuses rather than silently becoming the null arm
ok 2965 - FIX 8 — the real-audit arm refuses rather than silently becoming the null arm
  ---
  duration_ms: 458.572
  type: 'test'
  ...
# Subtest: v6 FIX 1 — the branch POOLED host passes against the bare expected id
ok 2966 - v6 FIX 1 — the branch POOLED host passes against the bare expected id
  ---
  duration_ms: 145.025709
  type: 'test'
  ...
# Subtest: v6 FIX 1 — the branch DIRECT host passes against the bare expected id
ok 2967 - v6 FIX 1 — the branch DIRECT host passes against the bare expected id
  ---
  duration_ms: 143.131542
  type: 'test'
  ...
# Subtest: v6 FIX 1 — the branch POOLED host passes against a POOLED expected id
ok 2968 - v6 FIX 1 — the branch POOLED host passes against a POOLED expected id
  ---
  duration_ms: 141.45975
  type: 'test'
  ...
# Subtest: v6 FIX 2 — production on its POOLED host refuses forbidden_endpoint, NOT endpoint_mismatch
ok 2969 - v6 FIX 2 — production on its POOLED host refuses forbidden_endpoint, NOT endpoint_mismatch
  ---
  duration_ms: 140.903875
  type: 'test'
  ...
# Subtest: v6 FIX 2 — production on its DIRECT host also refuses forbidden_endpoint
ok 2970 - v6 FIX 2 — production on its DIRECT host also refuses forbidden_endpoint
  ---
  duration_ms: 151.111458
  type: 'test'
  ...
# Subtest: v6 — `pooler` in the MIDDLE of a label is part of the id and is never truncated
ok 2971 - v6 — `pooler` in the MIDDLE of a label is part of the id and is never truncated
  ---
  duration_ms: 297.429583
  type: 'test'
  ...
# Subtest: v6 — a doubled `-pooler-pooler` strips exactly ONE, and that is the stated rule
ok 2972 - v6 — a doubled `-pooler-pooler` strips exactly ONE, and that is the stated rule
  ---
  duration_ms: 435.156542
  type: 'test'
  ...
# Subtest: v6 — normalisation cannot make two DIFFERENT endpoints compare equal
ok 2973 - v6 — normalisation cannot make two DIFFERENT endpoints compare equal
  ---
  duration_ms: 588.697083
  type: 'test'
  ...
# Subtest: NO OUTPUT ANYWHERE CARRIES A DATABASE_URL SUBSTRING — every response shape, stdout and stderr
ok 2974 - NO OUTPUT ANYWHERE CARRIES A DATABASE_URL SUBSTRING — every response shape, stdout and stderr
  ---
  duration_ms: 1604.268584
  type: 'test'
  ...
# Subtest: the route is POST-only, and carries its own expiry and deletion notice in source
ok 2975 - the route is POST-only, and carries its own expiry and deletion notice in source
  ---
  duration_ms: 0.450375
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: DEFAULT-OFF: unset ⇒ no cap (the shipped path is uncapped and must stay so)
ok 2976 - DEFAULT-OFF: unset ⇒ no cap (the shipped path is uncapped and must stay so)
  ---
  duration_ms: 0.436333
  type: 'test'
  ...
# Subtest: DEFAULT-OFF: 0, negative, junk and empty all mean "no cap", never a cap of 0
ok 2977 - DEFAULT-OFF: 0, negative, junk and empty all mean "no cap", never a cap of 0
  ---
  duration_ms: 0.092583
  type: 'test'
  ...
# Subtest: a set budget is honored, floored to an integer (the arms: 1647 / 823 / 128)
ok 2978 - a set budget is honored, floored to an integer (the arms: 1647 / 823 / 128)
  ---
  duration_ms: 0.11525
  type: 'test'
  ...
# Subtest: the cap rides the SL0-verified wire format (top-level google.thinking_config)
ok 2979 - the cap rides the SL0-verified wire format (top-level google.thinking_config)
  ---
  duration_ms: 0.453208
  type: 'test'
  ...
# Subtest: the cap is Gemini-only and cannot leak onto the Ollama fallback path
ok 2980 - the cap is Gemini-only and cannot leak onto the Ollama fallback path
  ---
  duration_ms: 0.204791
  type: 'test'
  ...
# Subtest: gen_params records the budget ONLY when capped — an uncapped trace is unchanged
ok 2981 - gen_params records the budget ONLY when capped — an uncapped trace is unchanged
  ---
  duration_ms: 0.143375
  type: 'test'
  ...
# Subtest: note-audit row → ClinicalFinding: verbatim vocab in the audit ext, valid core
ok 2982 - note-audit row → ClinicalFinding: verbatim vocab in the audit ext, valid core
  ---
  duration_ms: 3.063166
  type: 'test'
  ...
# Subtest: LOSSLESS: note-audit row round-trips byte-for-byte, incl. unmapped engine fields
ok 2983 - LOSSLESS: note-audit row round-trips byte-for-byte, incl. unmapped engine fields
  ---
  duration_ms: 1.360667
  type: 'test'
  ...
# Subtest: note-audit round-trip preserves absence: a minimal row gains no keys
ok 2984 - note-audit round-trip preserves absence: a minimal row gains no keys
  ---
  duration_ms: 0.346417
  type: 'test'
  ...
# Subtest: deterministic-source row maps to extractionMethod deterministic
ok 2985 - deterministic-source row maps to extractionMethod deterministic
  ---
  duration_ms: 0.122375
  type: 'test'
  ...
# Subtest: doc-audit AuditFinding → ClinicalFinding: verdict rides in ext.netValue (verbatim, separate slot)
ok 2986 - doc-audit AuditFinding → ClinicalFinding: verdict rides in ext.netValue (verbatim, separate slot)
  ---
  duration_ms: 2.081292
  type: 'test'
  ...
# Subtest: LOSSLESS: doc-audit AuditFinding round-trips byte-for-byte
ok 2987 - LOSSLESS: doc-audit AuditFinding round-trips byte-for-byte
  ---
  duration_ms: 0.96325
  type: 'test'
  ...
# Subtest: ExtractedCase → ClinicalState: clinical content in the core, metadata in surfaceExtras
ok 2988 - ExtractedCase → ClinicalState: clinical content in the core, metadata in surfaceExtras
  ---
  duration_ms: 0.694792
  type: 'test'
  ...
# Subtest: LOSSLESS: ExtractedCase round-trips byte-for-byte (full PX discharge shape)
ok 2989 - LOSSLESS: ExtractedCase round-trips byte-for-byte (full PX discharge shape)
  ---
  duration_ms: 0.151375
  type: 'test'
  ...
# Subtest: LOSSLESS: a sparse pre-PX ExtractedCase (no riskFactors/aftercare/completeness) round-trips
ok 2990 - LOSSLESS: a sparse pre-PX ExtractedCase (no riskFactors/aftercare/completeness) round-trips
  ---
  duration_ms: 0.263417
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: the traceless route stays traceless — no trace id reaches the rerank transport
ok 2991 - the traceless route stays traceless — no trace id reaches the rerank transport
  ---
  duration_ms: 3.707291
  type: 'test'
  ...
# Subtest: nothing in the change touches the outbound request object
ok 2992 - nothing in the change touches the outbound request object
  ---
  duration_ms: 0.340583
  type: 'test'
  ...
# Subtest: attachment is non-enumerable, so a serialized request or response is byte-identical
ok 2993 - attachment is non-enumerable, so a serialized request or response is byte-identical
  ---
  duration_ms: 0.44
  type: 'test'
  ...
# Subtest: attachment returns the SAME object — it allocates nothing the caller could miss
ok 2994 - attachment returns the SAME object — it allocates nothing the caller could miss
  ---
  duration_ms: 0.05425
  type: 'test'
  ...
# Subtest: the ladder, its order and its terminal dispositions are untouched
ok 2995 - the ladder, its order and its terminal dispositions are untouched
  ---
  duration_ms: 0.22425
  type: 'test'
  ...
# Subtest: retry policy is unchanged — capture rides the existing callback and adds no try budget
ok 2996 - retry policy is unchanged — capture rides the existing callback and adds no try budget
  ---
  duration_ms: 0.382375
  type: 'test'
  ...
# Subtest: every one of the four return sites carries evidence — no silent unattributed path
ok 2997 - every one of the four return sites carries evidence — no silent unattributed path
  ---
  duration_ms: 0.275666
  type: 'test'
  ...
# Subtest: the local substitution reports the LOCAL model, never the requested cloud model (§6.2)
ok 2998 - the local substitution reports the LOCAL model, never the requested cloud model (§6.2)
  ---
  duration_ms: 0.226167
  type: 'test'
  ...
# Subtest: every name still resolves at its original path, so no existing importer moves
ok 2999 - every name still resolves at its original path, so no existing importer moves
  ---
  duration_ms: 0.367042
  type: 'test'
  ...
# Subtest: the attempts field is OPTIONAL, so tracedChat attributions stay valid unchanged
ok 3000 - the attempts field is OPTIONAL, so tracedChat attributions stay valid unchanged
  ---
  duration_ms: 0.48475
  type: 'test'
  ...
# Subtest: a hostile completion cannot break the transport
ok 3001 - a hostile completion cannot break the transport
  ---
  duration_ms: 0.120708
  type: 'test'
  ...
# Subtest: a 429 is distinguishable from every other failure class
ok 3002 - a 429 is distinguishable from every other failure class
  ---
  duration_ms: 0.050667
  type: 'test'
  ...
# Subtest: both tiers classify through the same function — a 429 cannot be tier-dependent
ok 3003 - both tiers classify through the same function — a 429 cannot be tier-dependent
  ---
  duration_ms: 0.184667
  type: 'test'
  ...
# Subtest: the attempt sequence is invocation-scoped, never module state (§4.1)
ok 3004 - the attempt sequence is invocation-scoped, never module state (§4.1)
  ---
  duration_ms: 0.2375
  type: 'test'
  ...
# Subtest: the evidence carries identifiers and enums only — no prompt, passage or query text
ok 3005 - the evidence carries identifiers and enums only — no prompt, passage or query text
  ---
  duration_ms: 0.255958
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: a total transport failure records no served provider, and says so explicitly
ok 3006 - a total transport failure records no served provider, and says so explicitly
  ---
  duration_ms: 3.188292
  type: 'test'
  ...
# Subtest: a null attempt list means NOT COLLECTED, and is distinguishable from an empty one
ok 3007 - a null attempt list means NOT COLLECTED, and is distinguishable from an empty one
  ---
  duration_ms: 0.877167
  type: 'test'
  ...
# Subtest: every terminal phase is a stable NAME — never a message, never an interpolated value
ok 3008 - every terminal phase is a stable NAME — never a message, never an interpolated value
  ---
  duration_ms: 1.557166
  type: 'test'
  ...
# Subtest: the intended-local path records ONE attempt rather than an empty list
ok 3009 - the intended-local path records ONE attempt rather than an empty list
  ---
  duration_ms: 0.337459
  type: 'test'
  ...
# Subtest: both local arms record their attempt — the by-design one and the substitution
ok 3010 - both local arms record their attempt — the by-design one and the substitution
  ---
  duration_ms: 0.708042
  type: 'test'
  ...
# Subtest: the local success attempt is well-formed, and is at most one per invocation
ok 3011 - the local success attempt is well-formed, and is at most one per invocation
  ---
  duration_ms: 0.576917
  type: 'test'
  ...
# Subtest: classifyLocalAttempt reads what the SDK declared, and guesses nothing
ok 3012 - classifyLocalAttempt reads what the SDK declared, and guesses nothing
  ---
  duration_ms: 0.386167
  type: 'test'
  ...
# Subtest: the 429 rule has exactly one home — classifyLocalAttempt delegates, never duplicates
ok 3013 - the 429 rule has exactly one home — classifyLocalAttempt delegates, never duplicates
  ---
  duration_ms: 1.232958
  type: 'test'
  ...
# Subtest: the two terminal throws are BYTE-IDENTICAL to before this build
ok 3014 - the two terminal throws are BYTE-IDENTICAL to before this build
  ---
  duration_ms: 0.734
  type: 'test'
  ...
# Subtest: the phase selector cannot drift from the throws it describes
ok 3015 - the phase selector cannot drift from the throws it describes
  ---
  duration_ms: 2.092583
  type: 'test'
  ...
# Subtest: the failure attach is a statement, not a control-flow change
ok 3016 - the failure attach is a statement, not a control-flow change
  ---
  duration_ms: 1.031458
  type: 'test'
  ...
# Subtest: nothing in the failure path touches the outbound request object
ok 3017 - nothing in the failure path touches the outbound request object
  ---
  duration_ms: 0.600542
  type: 'test'
  ...
# Subtest: the local calls are wrapped, and the SDK call expression itself is unchanged
ok 3018 - the local calls are wrapped, and the SDK call expression itself is unchanged
  ---
  duration_ms: 0.53925
  type: 'test'
  ...
# Subtest: failure evidence is a SEPARATE property, invisible to every success-attribution reader
ok 3019 - failure evidence is a SEPARATE property, invisible to every success-attribution reader
  ---
  duration_ms: 0.236292
  type: 'test'
  ...
# Subtest: the low-value-care judge reader is untouched — it reads two fields of the success shape
ok 3020 - the low-value-care judge reader is untouched — it reads two fields of the success shape
  ---
  duration_ms: 0.475209
  type: 'test'
  ...
# Subtest: tracedChat is not touched — D14 is scoped to the traceless arm
ok 3021 - tracedChat is not touched — D14 is scoped to the traceless arm
  ---
  duration_ms: 0.717458
  type: 'test'
  ...
# Subtest: every new name also resolves through lib/trace.ts, so no importer has to know the core path
ok 3022 - every new name also resolves through lib/trace.ts, so no importer has to know the core path
  ---
  duration_ms: 0.13475
  type: 'test'
  ...
# Subtest: failure evidence is IMMUTABLE — a later frame cannot rewrite what failed
ok 3023 - failure evidence is IMMUTABLE — a later frame cannot rewrite what failed
  ---
  duration_ms: 0.213084
  type: 'test'
  ...
# Subtest: a hostile or exotic error cannot break the transport
ok 3024 - a hostile or exotic error cannot break the transport
  ---
  duration_ms: 0.265417
  type: 'test'
  ...
# Subtest: failure evidence carries enums and counts only — no message, no body, no identifier
ok 3025 - failure evidence carries enums and counts only — no message, no body, no identifier
  ---
  duration_ms: 0.198833
  type: 'test'
  ...
# Subtest: the attempt shape admits the local provider, and nothing else new
ok 3026 - the attempt shape admits the local provider, and nothing else new
  ---
  duration_ms: 0.513917
  type: 'test'
  ...
# Subtest: a finish_reason defect is NOT retryable; an empty 200 still is
ok 3027 - a finish_reason defect is NOT retryable; an empty 200 still is
  ---
  duration_ms: 1.362375
  type: 'test'
  ...
# Subtest: THE 54 SECONDS: a truncating call is attempted ONCE, not three times
ok 3028 - THE 54 SECONDS: a truncating call is attempted ONCE, not three times
  ---
  duration_ms: 6.286125
  type: 'test'
  ...
# Subtest: …and the empty-200 retry budget is spent in full, exactly as before
ok 3029 - …and the empty-200 retry budget is spent in full, exactly as before
  ---
  duration_ms: 0.405292
  type: 'test'
  ...
# Subtest: the terminal error still names the truncation, so the sizing bug is readable
ok 3030 - the terminal error still names the truncation, so the sizing bug is readable
  ---
  duration_ms: 0.133542
  type: 'test'
  ...
# Subtest: transport failures are untouched by this rule — only BODY verdicts changed
ok 3031 - transport failures are untouched by this rule — only BODY verdicts changed
  ---
  duration_ms: 0.4075
  type: 'test'
  ...
# Subtest: the mini-sized cap is raised to a FLOOR on the bedrock path
ok 3032 - the mini-sized cap is raised to a FLOOR on the bedrock path
  ---
  duration_ms: 0.1665
  type: 'test'
  ...
# Subtest: ⚠️ BYTE-IDENTITY: the floor is the BEDROCK transport’s, and reaches no other provider
ok 3033 - ⚠️ BYTE-IDENTITY: the floor is the BEDROCK transport’s, and reaches no other provider
  ---
  duration_ms: 1.335208
  type: 'test'
  ...
# Subtest: a critique that never completed is recorded as UNAUDITED, not as clean
ok 3034 - a critique that never completed is recorded as UNAUDITED, not as clean
  ---
  duration_ms: 0.961166
  type: 'test'
  ...
# Subtest: the probe reducers carry critic_ran, so a lab row can tell the two apart
ok 3035 - the probe reducers carry critic_ran, so a lab row can tell the two apart
  ---
  duration_ms: 2.513084
  type: 'test'
  ...
# Subtest: unknown_finding + missing_critical + instability_input derive from a ClinicalState
ok 3036 - unknown_finding + missing_critical + instability_input derive from a ClinicalState
  ---
  duration_ms: 13.593833
  type: 'test'
  ...
# Subtest: med_contradiction derives from an open medication conflict (member stateRef)
ok 3037 - med_contradiction derives from an open medication conflict (member stateRef)
  ---
  duration_ms: 0.325333
  type: 'test'
  ...
# Subtest: med_contradiction: conflict on an episode HIGH-ALERT med is safety-critical
ok 3038 - med_contradiction: conflict on an episode HIGH-ALERT med is safety-critical
  ---
  duration_ms: 0.62175
  type: 'test'
  ...
# Subtest: med_contradiction also derives from reconciled status stopped/not_taking/unknown without a conflict row
ok 3039 - med_contradiction also derives from reconciled status stopped/not_taking/unknown without a conflict row
  ---
  duration_ms: 0.829667
  type: 'test'
  ...
# Subtest: new_medication (B5): derives ONLY for meds absent from a NON-EMPTY snapshot med list
ok 3040 - new_medication (B5): derives ONLY for meds absent from a NON-EMPTY snapshot med list
  ---
  duration_ms: 0.714875
  type: 'test'
  ...
# Subtest: new_medication (B5): a high-alert episode med is skipped (it wins rank 0 anyway)
ok 3041 - new_medication (B5): a high-alert episode med is skipped (it wins rank 0 anyway)
  ---
  duration_ms: 0.113542
  type: 'test'
  ...
# Subtest: care_gap derives from a stale mapped-range abnormal (detail verbatim, severity mapped)
ok 3042 - care_gap derives from a stale mapped-range abnormal (detail verbatim, severity mapped)
  ---
  duration_ms: 0.413292
  type: 'test'
  ...
# Subtest: followup_open derives from advice keywords; suppressed when a committed follow-up matches
ok 3043 - followup_open derives from advice keywords; suppressed when a committed follow-up matches
  ---
  duration_ms: 0.843917
  type: 'test'
  ...
# Subtest: allergy_unconfirmed only when the note allergy field is blank
ok 3044 - allergy_unconfirmed only when the note allergy field is blank
  ---
  duration_ms: 0.523458
  type: 'test'
  ...
# Subtest: snapshot absent ⇒ member-derived kinds simply absent (episode-only degradation, D14)
ok 3045 - snapshot absent ⇒ member-derived kinds simply absent (episode-only degradation, D14)
  ---
  duration_ms: 0.704292
  type: 'test'
  ...
# Subtest: determinism: identical inputs ⇒ deep-equal output (double run)
ok 3046 - determinism: identical inputs ⇒ deep-equal output (double run)
  ---
  duration_ms: 0.22575
  type: 'test'
  ...
# Subtest: every UnknownItem carries ≥1 sourceRef and a stateRef
ok 3047 - every UnknownItem carries ≥1 sourceRef and a stateRef
  ---
  duration_ms: 0.127708
  type: 'test'
  ...
# Subtest: stable ordering: safety before review before info, then kind, then subject
ok 3048 - stable ordering: safety before review before info, then kind, then subject
  ---
  duration_ms: 0.255459
  type: 'test'
  ...
# Subtest: bandFor thresholds
ok 3049 - bandFor thresholds
  ---
  duration_ms: 2.276916
  type: 'test'
  ...
# Subtest: findingPenalty scales with verdict severity and confidence
ok 3050 - findingPenalty scales with verdict severity and confidence
  ---
  duration_ms: 0.273792
  type: 'test'
  ...
# Subtest: a clean, complete episode scores high (band A)
ok 3051 - a clean, complete episode scores high (band A)
  ---
  duration_ms: 0.497708
  type: 'test'
  ...
# Subtest: domains route by tag; cost driven by low-value tariff spend; untagged → appropriateness
ok 3052 - domains route by tag; cost driven by low-value tariff spend; untagged → appropriateness
  ---
  duration_ms: 23.757833
  type: 'test'
  ...
# Subtest: estimated bed-day cost dents the cost domain even with no tariffed spend
ok 3053 - estimated bed-day cost dents the cost domain even with no tariffed spend
  ---
  duration_ms: 0.531708
  type: 'test'
  ...
# Subtest: weights are configurable and normalised
ok 3054 - weights are configurable and normalised
  ---
  duration_ms: 0.209875
  type: 'test'
  ...
# [provider-fallback] gemini gemini-2.5-pro failed → openrouter: {"provider":"gemini","label":"chatWithFallback","feature":null,"fellBackTo":"openrouter","intended_model":"gemini-2.5-pro","fallback_model":null,"region":"asia-south1","sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"gemini":1},"http_status":null,"error_status":null,"error_code":null,"message":"GCP_SA_KEY is not valid JSON (or base64 JSON)","details":null}
# Subtest: cloudLadder: Vertex first, OpenRouter second — and GEMINI_VIA_OPENROUTER=1 inverts it
ok 3055 - cloudLadder: Vertex first, OpenRouter second — and GEMINI_VIA_OPENROUTER=1 inverts it
  ---
  duration_ms: 111.514541
  type: 'test'
  ...
# Subtest: cloudLadder: a second tier exists ONLY with a leg budget, and only when it can serve
ok 3056 - cloudLadder: a second tier exists ONLY with a leg budget, and only when it can serve
  ---
  duration_ms: 0.457625
  type: 'test'
  ...
# Subtest: the tier-2 slug derivation is the same google/ prefixing, flag or no flag
ok 3057 - the tier-2 slug derivation is the same google/ prefixing, flag or no flag
  ---
  duration_ms: 0.186208
  type: 'test'
  ...
# Subtest: the flag itself is NOT touched by this unit — one code read, no default, no write
ok 3058 - the flag itself is NOT touched by this unit — one code read, no default, no write
  ---
  duration_ms: 0.5115
  type: 'test'
  ...
# Subtest: tierCeilingMs: tier 1 gets the full budget, tier 2 the remainder, a spent leg gets 0
ok 3059 - tierCeilingMs: tier 1 gets the full budget, tier 2 the remainder, a spent leg gets 0
  ---
  duration_ms: 0.130417
  type: 'test'
  ...
# Subtest: a leg never exceeds its budget across both tiers — the naive sum would blow the box
ok 3060 - a leg never exceeds its budget across both tiers — the naive sum would blow the box
  ---
  duration_ms: 0.433833
  type: 'test'
  ...
# Subtest: ladderSkipError names the skipped tier and carries the earlier failure, capped
ok 3061 - ladderSkipError names the skipped tier and carries the earlier failure, capped
  ---
  duration_ms: 0.174417
  type: 'test'
  ...
# Subtest: both transports run the SAME ladder mechanics — no second budget idiom
ok 3062 - both transports run the SAME ladder mechanics — no second budget idiom
  ---
  duration_ms: 0.458667
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [provider-fallback] gemini gemini-2.5-pro failed → ollama: {"provider":"gemini","label":"chatWithFallback","feature":null,"fellBackTo":"ollama","intended_model":"gemini-2.5-pro","fallback_model":"qwen2.5:14b","region":"asia-south1","sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"gemini":1},"http_status":null,"error_status":null,"error_code":null,"message":"GCP_SA_KEY is not valid JSON (or base64 JSON)","details":null}
# Subtest: F1: Vertex tier fails → the OpenRouter tier serves the SAME leg (the hop is real)
ok 3063 - F1: Vertex tier fails → the OpenRouter tier serves the SAME leg (the hop is real)
  ---
  duration_ms: 59.45
  type: 'test'
  ...
# [provider-fallback] gemini gemini-2.5-pro failed → openrouter: {"provider":"gemini","label":"chatWithFallback","feature":null,"fellBackTo":"openrouter","intended_model":"gemini-2.5-pro","fallback_model":null,"region":"asia-south1","sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"gemini":1},"http_status":null,"error_status":null,"error_code":null,"message":"GCP_SA_KEY is not valid JSON (or base64 JSON)","details":null}
# Subtest: F2: with NO leg budget there is NO second tier — the utility path is byte-identical
ok 3064 - F2: with NO leg budget there is NO second tier — the utility path is byte-identical
  ---
  duration_ms: 12.483458
  type: 'test'
  ...
# [provider-retry] openrouter google/gemini-2.5-pro attempt 1/1 http 500 — giving up: 500 "boom"
# [provider-fallback] openrouter google/gemini-2.5-pro failed → none: {"provider":"openrouter","label":"chatWithFallback","feature":null,"fellBackTo":"none","intended_model":"google/gemini-2.5-pro","fallback_model":null,"region":null,"sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"openrouter":1},"http_status":500,"error_status":null,"error_code":null,"message":"500 \\"boom\\"","details":null}
# [provider-fallback] gemini gemini-2.5-pro failed → openrouter: {"provider":"gemini","label":"chatWithFallback","feature":null,"fellBackTo":"openrouter","intended_model":"gemini-2.5-pro","fallback_model":null,"region":"asia-south1","sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"gemini":1},"http_status":null,"error_status":null,"error_code":null,"message":"GCP_SA_KEY is not valid JSON (or base64 JSON)","details":null}
# Subtest: F3: noLocalFallback=true → both tiers failing THROWS; Ollama is not called
ok 3065 - F3: noLocalFallback=true → both tiers failing THROWS; Ollama is not called
  ---
  duration_ms: 10.090667
  type: 'test'
  ...
# [provider-retry] openrouter google/gemini-2.5-pro attempt 1/1 http 500 — giving up: 500 "boom"
# [provider-fallback] openrouter google/gemini-2.5-pro failed → ollama: {"provider":"openrouter","label":"chatWithFallback","feature":null,"fellBackTo":"ollama","intended_model":"google/gemini-2.5-pro","fallback_model":"qwen2.5:14b","region":null,"sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"openrouter":1},"http_status":500,"error_status":null,"error_code":null,"message":"500 \\"boom\\"","details":null}
# Subtest: F4: noLocalFallback absent → both tiers failing still falls back to Ollama (today's behaviour)
ok 3066 - F4: noLocalFallback absent → both tiers failing still falls back to Ollama (today's behaviour)
  ---
  duration_ms: 8.933458
  type: 'test'
  ...
# [provider-retry] openrouter google/gemini-2.5-pro attempt 1/3 http 500 — retrying: 500 "boom"
# [provider-retry] openrouter google/gemini-2.5-pro attempt 2/3 http 500 — retrying: 500 "boom"
# [provider-retry] openrouter google/gemini-2.5-pro attempt 3/3 http 500 — giving up: 500 "boom"
# [provider-fallback] openrouter google/gemini-2.5-pro failed → ollama: {"provider":"openrouter","label":"chatWithFallback","feature":null,"fellBackTo":"ollama","intended_model":"google/gemini-2.5-pro","fallback_model":"qwen2.5:14b","region":null,"sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"openrouter":1},"http_status":500,"error_status":null,"error_code":null,"message":"500 \\"boom\\"","details":null}
# Subtest: F5: GEMINI_VIA_OPENROUTER=1 makes OpenRouter tier 1 — the inversion is live, not just typed
ok 3067 - F5: GEMINI_VIA_OPENROUTER=1 makes OpenRouter tier 1 — the inversion is live, not just typed
  ---
  duration_ms: 1008.977167
  type: 'test'
  ...
# [provider-retry] openrouter google/gemini-2.5-pro attempt 1/1 timeout — giving up: Request was aborted.
# [provider-fallback] openrouter google/gemini-2.5-pro failed → gemini: {"provider":"openrouter","label":"chatWithFallback","feature":null,"fellBackTo":"gemini","intended_model":"google/gemini-2.5-pro","fallback_model":null,"region":null,"sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"openrouter":1},"http_status":null,"error_status":null,"error_code":null,"message":"openrouter TIMEOUT after 300ms (attempt 1/1)","details":null}
# Subtest: F6: a tier that burns the whole leg budget SKIPS the next tier by name
ok 3068 - F6: a tier that burns the whole leg budget SKIPS the next tier by name
  ---
  duration_ms: 304.272792
  type: 'test'
  ...
# Subtest: the OPD audit call site sets it — and the mini path passes FALSE
ok 3069 - the OPD audit call site sets it — and the mini path passes FALSE
  ---
  duration_ms: 0.338292
  type: 'test'
  ...
# Subtest: the IPD analyze closure sets it via analyzeNoLocalFallback — one flag, all six legs
ok 3070 - the IPD analyze closure sets it via analyzeNoLocalFallback — one flag, all six legs
  ---
  duration_ms: 0.214125
  type: 'test'
  ...
# Subtest: verifyCitation — the cite gate — does NOT get the flag, and keeps its soft-fail
ok 3071 - verifyCitation — the cite gate — does NOT get the flag, and keeps its soft-fail
  ---
  duration_ms: 0.063958
  type: 'test'
  ...
# Subtest: no third call site: the flag appears in doc-audit only on the analyze closure plumbing
ok 3072 - no third call site: the flag appears in doc-audit only on the analyze closure plumbing
  ---
  duration_ms: 0.170375
  type: 'test'
  ...
# Subtest: the throw reaches auditOpdNote's outer catch, which marks the row — nothing changed there
ok 3073 - the throw reaches auditOpdNote's outer catch, which marks the row — nothing changed there
  ---
  duration_ms: 0.259584
  type: 'test'
  ...
# Subtest: the DDL is additive + idempotent and matches the kickoff exactly
ok 3074 - the DDL is additive + idempotent and matches the kickoff exactly
  ---
  duration_ms: 0.081625
  type: 'test'
  ...
# Subtest: the writer is best-effort and truncates at 2000 — a ledger failure never fails an audit
ok 3075 - the writer is best-effort and truncates at 2000 — a ledger failure never fails an audit
  ---
  duration_ms: 5.033
  type: 'test'
  ...
# Subtest: runIpdAudit writes the ledger at every no-row outcome, and the write precedes each return
ok 3076 - runIpdAudit writes the ledger at every no-row outcome, and the write precedes each return
  ---
  duration_ms: 0.120416
  type: 'test'
  ...
# Subtest: the ledger did NOT touch the machinery the kickoff fences off
ok 3077 - the ledger did NOT touch the machinery the kickoff fences off
  ---
  duration_ms: 0.055459
  type: 'test'
  ...
# Subtest: audit_query can read the ledger WITHOUT lib/sql-guard-core.ts changing
ok 3078 - audit_query can read the ledger WITHOUT lib/sql-guard-core.ts changing
  ---
  duration_ms: 0.925
  type: 'test'
  ...
# Subtest: provider reaches the terminal error, the marked error, and every failure report
ok 3079 - provider reaches the terminal error, the marked error, and every failure report
  ---
  duration_ms: 6.99125
  type: 'test'
  ...
# Subtest: the marked empty-200 error names the provider that produced it
ok 3080 - the marked empty-200 error names the provider that produced it
  ---
  duration_ms: 0.320917
  type: 'test'
  ...
# Subtest: DEFAULT provider is openrouter — every pre-Unit-V call site is byte-identical
ok 3081 - DEFAULT provider is openrouter — every pre-Unit-V call site is byte-identical
  ---
  duration_ms: 5.590417
  type: 'test'
  ...
# Subtest: a caller classifier REPLACES the OpenAI-shaped default
ok 3082 - a caller classifier REPLACES the OpenAI-shaped default
  ---
  duration_ms: 0.30925
  type: 'test'
  ...
# Subtest: classify: () => null opts out of body judgement entirely
ok 3083 - classify: () => null opts out of body judgement entirely
  ---
  duration_ms: 0.088541
  type: 'test'
  ...
# Subtest: the default IS classifyProviderResponse — no call site loses validation by omission
ok 3084 - the default IS classifyProviderResponse — no call site loses validation by omission
  ---
  duration_ms: 0.105083
  type: 'test'
  ...
# Subtest: defaultTimeoutMs / defaultMaxTries apply when the CALLER passes nothing
ok 3085 - defaultTimeoutMs / defaultMaxTries apply when the CALLER passes nothing
  ---
  duration_ms: 0.413792
  type: 'test'
  ...
# Subtest: the CALLER still wins over the per-call default
ok 3086 - the CALLER still wins over the per-call default
  ---
  duration_ms: 0.1235
  type: 'test'
  ...
# Subtest: a junk DEFAULT degrades to the module constant — it can never disable a bound
ok 3087 - a junk DEFAULT degrades to the module constant — it can never disable a bound
  ---
  duration_ms: 0.401583
  type: 'test'
  ...
# Subtest: all four re-exported symbols still resolve at their current values
ok 3088 - all four re-exported symbols still resolve at their current values
  ---
  duration_ms: 0.553959
  type: 'test'
  ...
# Subtest: openrouterCreateWithRetry is still exported and still a pure pass-through
ok 3089 - openrouterCreateWithRetry is still exported and still a pure pass-through
  ---
  duration_ms: 0.113208
  type: 'test'
  ...
# Subtest: there are exactly FOUR provider call sites — a fifth must be enumerated here
ok 3090 - there are exactly FOUR provider call sites — a fifth must be enumerated here
  ---
  duration_ms: 0.606125
  type: 'test'
  ...
# Subtest: EVERY provider call site forwards the caller timeout AND maxTries
ok 3091 - EVERY provider call site forwards the caller timeout AND maxTries
  ---
  duration_ms: 0.959709
  type: 'test'
  ...
# Subtest: the Vertex chat branch is wrapped in BOTH files, and identifies itself as vertex
ok 3092 - the Vertex chat branch is wrapped in BOTH files, and identifies itself as vertex
  ---
  duration_ms: 0.095541
  type: 'test'
  ...
# Subtest: THE REGION AND SERVICE IDENTITY SURVIVE — they are the Vertex path's whole advantage
ok 3093 - THE REGION AND SERVICE IDENTITY SURVIVE — they are the Vertex path's whole advantage
  ---
  duration_ms: 0.05725
  type: 'test'
  ...
# Subtest: the self-heal lives INSIDE the attempt closure — healing must not spend the budget
ok 3094 - the self-heal lives INSIDE the attempt closure — healing must not spend the budget
  ---
  duration_ms: 0.056875
  type: 'test'
  ...
# Subtest: the provider-call accounting still pairs
ok 3095 - the provider-call accounting still pairs
  ---
  duration_ms: 0.06525
  type: 'test'
  ...
# Subtest: the Vertex doc_read fetch finally has a signal — its absence is why Record audit HUNG
ok 3096 - the Vertex doc_read fetch finally has a signal — its absence is why Record audit HUNG
  ---
  duration_ms: 0.058
  type: 'test'
  ...
# Subtest: doc_read failures are STRUCTURED and name region + identity, and still return null
ok 3097 - doc_read failures are STRUCTURED and name region + identity, and still return null
  ---
  duration_ms: 0.067458
  type: 'test'
  ...
# Subtest: ⚠️ doc_read has NO RETRY in this unit, and that is ARITHMETIC — not caution
ok 3098 - ⚠️ doc_read has NO RETRY in this unit, and that is ARITHMETIC — not caution
  ---
  duration_ms: 0.717042
  type: 'test'
  ...
# Subtest: the Ollama fallback is still PRESENT and still CALLED in both files
ok 3099 - the Ollama fallback is still PRESENT and still CALLED in both files
  ---
  duration_ms: 0.098625
  type: 'test'
  ...
# Subtest: no PROVIDER_BUDGETS value moved in this unit
ok 3100 - no PROVIDER_BUDGETS value moved in this unit
  ---
  duration_ms: 0.108792
  type: 'test'
  ...
# Subtest: the floor holds: a window reaching before the vitals source is CLAMPED, and says so
ok 3101 - the floor holds: a window reaching before the vitals source is CLAMPED, and says so
  ---
  duration_ms: 1.352625
  type: 'test'
  ...
# Subtest: an unclamped window is exactly WINDOW_DAYS long and is not flagged
ok 3102 - an unclamped window is exactly WINDOW_DAYS long and is not flagged
  ---
  duration_ms: 0.08
  type: 'test'
  ...
# Subtest: the boundary day itself: a window starting exactly on the source is not clamped
ok 3103 - the boundary day itself: a window starting exactly on the source is not clamped
  ---
  duration_ms: 0.107042
  type: 'test'
  ...
# Subtest: a window entirely before the source returns null — nothing honest to show
ok 3104 - a window entirely before the source returns null — nothing honest to show
  ---
  duration_ms: 0.047875
  type: 'test'
  ...
# Subtest: a malformed or absurd window returns null rather than guessing
ok 3105 - a malformed or absurd window returns null rather than guessing
  ---
  duration_ms: 0.059791
  type: 'test'
  ...
# Subtest: the SQL is the measured NOT IN form, bounded, HOSPITAL_GP only
ok 3106 - the SQL is the measured NOT IN form, bounded, HOSPITAL_GP only
  ---
  duration_ms: 0.203
  type: 'test'
  ...
# Subtest: the NOT IN filter is GUARDED so it is only asked about notes that HAVE an ID
ok 3107 - the NOT IN filter is GUARDED so it is only asked about notes that HAVE an ID
  ---
  duration_ms: 0.096333
  type: 'test'
  ...
# Subtest: THE INJECTION GUARD: a non-date bound THROWS, it is never interpolated
ok 3108 - THE INJECTION GUARD: a non-date bound THROWS, it is never interpolated
  ---
  duration_ms: 0.252667
  type: 'test'
  ...
# Subtest: isDay accepts only the exact shape — the same guard lib/metabase.ts uses
ok 3109 - isDay accepts only the exact shape — the same guard lib/metabase.ts uses
  ---
  duration_ms: 0.197041
  type: 'test'
  ...
# Subtest: addDays is UTC-stable across a month boundary and returns "" on junk
ok 3110 - addDays is UTC-stable across a month boundary and returns "" on junk
  ---
  duration_ms: 0.277875
  type: 'test'
  ...
# Subtest: istDay reads the Asia/Kolkata calendar day, not UTC
ok 3111 - istDay reads the Asia/Kolkata calendar day, not UTC
  ---
  duration_ms: 12.138709
  type: 'test'
  ...
# Subtest: a note with a NULL consult ID is no-consult-ID — neither covered nor no-vitals
ok 3112 - a note with a NULL consult ID is no-consult-ID — neither covered nor no-vitals
  ---
  duration_ms: 0.158625
  type: 'test'
  ...
# Subtest: THE HEADLINE DENOMINATOR EXCLUDES what we cannot know
ok 3113 - THE HEADLINE DENOMINATOR EXCLUDES what we cannot know
  ---
  duration_ms: 0.048291
  type: 'test'
  ...
# Subtest: empty-string and whitespace IDs are the SAME category as null (the SQL btrims them)
ok 3114 - empty-string and whitespace IDs are the SAME category as null (the SQL btrims them)
  ---
  duration_ms: 1.650791
  type: 'test'
  ...
# Subtest: a note with an ID absent from the vitals table is still no-vitals; one present is still covered
ok 3115 - a note with an ID absent from the vitals table is still no-vitals; one present is still covered
  ---
  duration_ms: 0.155792
  type: 'test'
  ...
# Subtest: the MEASURED window reproduces: 160 of 561 = 28.5%
ok 3116 - the MEASURED window reproduces: 160 of 561 = 28.5%
  ---
  duration_ms: 0.655084
  type: 'test'
  ...
# Subtest: rows outside the window are DROPPED — a boundary sliver is not a day
ok 3117 - rows outside the window are DROPPED — a boundary sliver is not a day
  ---
  duration_ms: 0.836291
  type: 'test'
  ...
# Subtest: Metabase type wobble is absorbed: string counts and ISO timestamps
ok 3118 - Metabase type wobble is absorbed: string counts and ISO timestamps
  ---
  duration_ms: 0.161792
  type: 'test'
  ...
# Subtest: junk never produces a number that looks real
ok 3119 - junk never produces a number that looks real
  ---
  duration_ms: 0.2
  type: 'test'
  ...
# Subtest: the core is PURE and dependency-free — it must not reach the engine or any score
ok 3120 - the core is PURE and dependency-free — it must not reach the engine or any score
  ---
  duration_ms: 6.995875
  type: 'test'
  ...
# Subtest: GATE 2 — flag OFF: all three fetch SQL strings are byte-identical to today's
ok 3121 - GATE 2 — flag OFF: all three fetch SQL strings are byte-identical to today's
  ---
  duration_ms: 0.78825
  type: 'test'
  ...
# Subtest: flag ON: vitals LEFT JOIN present, DISTINCT ON newest _update_time, scan bounded, quoted table
ok 3122 - flag ON: vitals LEFT JOIN present, DISTINCT ON newest _update_time, scan bounded, quoted table
  ---
  duration_ms: 0.289708
  type: 'test'
  ...
# Subtest: SWEEP-1 (D2) — the day fetch deduplicates by uid; the single/bulk uid fetches do NOT change
ok 3123 - SWEEP-1 (D2) — the day fetch deduplicates by uid; the single/bulk uid fetches do NOT change
  ---
  duration_ms: 0.097958
  type: 'test'
  ...
# Subtest: GATE 5 — no selected column ends in _tag, flag on or off (R-11: numbers, not judgments)
ok 3124 - GATE 5 — no selected column ends in _tag, flag on or off (R-11: numbers, not judgments)
  ---
  duration_ms: 0.108375
  type: 'test'
  ...
# Subtest: GATE 3 — synthetic control: a vitals row parses to the exact case shape
ok 3125 - GATE 3 — synthetic control: a vitals row parses to the exact case shape
  ---
  duration_ms: 1.477959
  type: 'test'
  ...
# Subtest: GATE 3 — no vitals row → vitalsRecorded false + vitals null (weight/height still mapped)
ok 3126 - GATE 3 — no vitals row → vitalsRecorded false + vitals null (weight/height still mapped)
  ---
  duration_ms: 0.380416
  type: 'test'
  ...
# Subtest: a record with every measurement blank is STILL vitalsRecorded true — a different finding from "no record"
ok 3127 - a record with every measurement blank is STILL vitalsRecorded true — a different finding from "no record"
  ---
  duration_ms: 0.2275
  type: 'test'
  ...
# Subtest: bp parse: null unless the string matches ^\\d+\\/\\d+$ (the raw string is kept as recorded)
ok 3128 - bp parse: null unless the string matches ^\\d+\\/\\d+$ (the raw string is kept as recorded)
  ---
  duration_ms: 0.344166
  type: 'test'
  ...
# Subtest: recordedAt: null when the note timestamp is missing (no wall clock ever leaks)
ok 3129 - recordedAt: null when the note timestamp is missing (no wall clock ever leaks)
  ---
  duration_ms: 0.29575
  type: 'test'
  ...
# Subtest: fail-safe: an error in the vitals leg resets to the safe state and leaves the rest of the case intact
ok 3130 - fail-safe: an error in the vitals leg resets to the safe state and leaves the rest of the case intact
  ---
  duration_ms: 3.13175
  type: 'test'
  ...
# Subtest: flag OFF: the A1 fields stay absent — every existing case literal and behaviour unchanged
ok 3131 - flag OFF: the A1 fields stay absent — every existing case literal and behaviour unchanged
  ---
  duration_ms: 0.281333
  type: 'test'
  ...
# Subtest: GATE 1 — opdCaseText is byte-identical with and without the vitals block (A1 is score-invariant)
ok 3132 - GATE 1 — opdCaseText is byte-identical with and without the vitals block (A1 is score-invariant)
  ---
  duration_ms: 5.299667
  type: 'test'
  ...
# Subtest: GATE 4 — OpdKeys carries no vitals field, no weight, no height
ok 3133 - GATE 4 — OpdKeys carries no vitals field, no weight, no height
  ---
  duration_ms: 0.429291
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: the declaration is ONE statement over the whole note set, with ids index-aligned to it
ok 3134 - the declaration is ONE statement over the whole note set, with ids index-aligned to it
  ---
  duration_ms: 2.099667
  type: 'test'
  ...
# Subtest: a note with no uid declares a NULL uid, never the string "undefined"
ok 3135 - a note with no uid declares a NULL uid, never the string "undefined"
  ---
  duration_ms: 0.183625
  type: 'test'
  ...
# Subtest: 25 — a failed declaration throws TelemetryDeclarationError and leaves per-run evidence
ok 3136 - 25 — a failed declaration throws TelemetryDeclarationError and leaves per-run evidence
  ---
  duration_ms: 1.653708
  type: 'test'
  ...
# Subtest: 25 — all three worker modes reach the SAME fail-closed declaration, and it answers 503
ok 3137 - 25 — all three worker modes reach the SAME fail-closed declaration, and it answers 503
  ---
  duration_ms: 0.22775
  type: 'test'
  ...
# Subtest: 26 — the sweep 503 body says earlier days persisted
ok 3138 - 26 — the sweep 503 body says earlier days persisted
  ---
  duration_ms: 0.154875
  type: 'test'
  ...
# Subtest: 27 — re-audit fetches first, declares only what resolved, and preserves count and order
ok 3139 - 27 — re-audit fetches first, declares only what resolved, and preserves count and order
  ---
  duration_ms: 0.144917
  type: 'test'
  ...
# Subtest: the run ids are never reallocated — every audit call ADOPTS the declared id
ok 3140 - the run ids are never reallocated — every audit call ADOPTS the declared id
  ---
  duration_ms: 0.17875
  type: 'test'
  ...
# Subtest: the mini-backfill declares the same way and refuses the tick the same way
ok 3141 - the mini-backfill declares the same way and refuses the tick the same way
  ---
  duration_ms: 0.109916
  type: 'test'
  ...
# Subtest: safety-regex positive: Start metformin 500 mg twice daily.
ok 3142 - safety-regex positive: Start metformin 500 mg twice daily.
  ---
  duration_ms: 1.811125
  type: 'test'
  ...
# Subtest: safety-regex positive: Give 1 mg of glucagon IM.
ok 3143 - safety-regex positive: Give 1 mg of glucagon IM.
  ---
  duration_ms: 0.088084
  type: 'test'
  ...
# Subtest: safety-regex positive: Loading dose 500 mcg.
ok 3144 - safety-regex positive: Loading dose 500 mcg.
  ---
  duration_ms: 0.050292
  type: 'test'
  ...
# Subtest: safety-regex positive: Bolus 5 units of insulin.
ok 3145 - safety-regex positive: Bolus 5 units of insulin.
  ---
  duration_ms: 0.045791
  type: 'test'
  ...
# Subtest: safety-regex positive: 0.5 g IV q6h.
ok 3146 - safety-regex positive: 0.5 g IV q6h.
  ---
  duration_ms: 0.041125
  type: 'test'
  ...
# Subtest: safety-regex positive: Infuse 1000 mL bolus over 30 min.
ok 3147 - safety-regex positive: Infuse 1000 mL bolus over 30 min.
  ---
  duration_ms: 0.100417
  type: 'test'
  ...
# Subtest: safety-regex positive: 500 cc of normal saline.
ok 3148 - safety-regex positive: 500 cc of normal saline.
  ---
  duration_ms: 0.088375
  type: 'test'
  ...
# Subtest: safety-regex positive: Run at 100 mL/hr.
ok 3149 - safety-regex positive: Run at 100 mL/hr.
  ---
  duration_ms: 0.183125
  type: 'test'
  ...
# Subtest: safety-regex positive: Maintenance 50 cc/h.
ok 3150 - safety-regex positive: Maintenance 50 cc/h.
  ---
  duration_ms: 0.232375
  type: 'test'
  ...
# Subtest: safety-regex positive: 30 drops/min via gravity.
ok 3151 - safety-regex positive: 30 drops/min via gravity.
  ---
  duration_ms: 0.327041
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit per L): Sodium 140 mEq/L is normal.
ok 3152 - safety-regex negative (preserve lab unit per L): Sodium 140 mEq/L is normal.
  ---
  duration_ms: 0.056458
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit per dL): Creatinine 1.4 mg/dL.
ok 3153 - safety-regex negative (preserve lab unit per dL): Creatinine 1.4 mg/dL.
  ---
  duration_ms: 0.029125
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit mmol/L): Lactate 4.2 mmol/L is the SSC threshold.
ok 3154 - safety-regex negative (preserve lab unit mmol/L): Lactate 4.2 mmol/L is the SSC threshold.
  ---
  duration_ms: 0.029084
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit g/dL): Albumin 3.5 g/dL.
ok 3155 - safety-regex negative (preserve lab unit g/dL): Albumin 3.5 g/dL.
  ---
  duration_ms: 0.02375
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve protocol cite mL/kg, not a dose): SSC recommends 30 mL/kg crystalloid in the first hour.
ok 3156 - safety-regex negative (preserve protocol cite mL/kg, not a dose): SSC recommends 30 mL/kg crystalloid in the first hour.
  ---
  duration_ms: 0.022959
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit): HCO3 9 mEq/L on this gas.
ok 3157 - safety-regex negative (preserve lab unit): HCO3 9 mEq/L on this gas.
  ---
  duration_ms: 0.023041
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve eGFR unit): eGFR 42 mL/min/1.73 m² is CKD G3b.
ok 3158 - safety-regex negative (preserve eGFR unit): eGFR 42 mL/min/1.73 m² is CKD G3b.
  ---
  duration_ms: 0.027
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve mmHg not in dose set): PaO2 80 mmHg.
ok 3159 - safety-regex negative (preserve mmHg not in dose set): PaO2 80 mmHg.
  ---
  duration_ms: 0.085917
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit per dL): BUN 28 mg/dL.
ok 3160 - safety-regex negative (preserve lab unit per dL): BUN 28 mg/dL.
  ---
  duration_ms: 0.078458
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit per dL): Glucose 580 mg/dL is severe hyperglycemia.
ok 3161 - safety-regex negative (preserve lab unit per dL): Glucose 580 mg/dL is severe hyperglycemia.
  ---
  duration_ms: 0.031458
  type: 'test'
  ...
# Subtest: safety-regex preserves fluid TYPE: Hypertonic saline is the indicated agent for sympt...
ok 3162 - safety-regex preserves fluid TYPE: Hypertonic saline is the indicated agent for sympt...
  ---
  duration_ms: 0.040667
  type: 'test'
  ...
# Subtest: safety-regex preserves fluid TYPE: Isotonic crystalloid is appropriate for initial re...
ok 3163 - safety-regex preserves fluid TYPE: Isotonic crystalloid is appropriate for initial re...
  ---
  duration_ms: 0.026958
  type: 'test'
  ...
# Subtest: safety-regex preserves fluid TYPE: Lactated Ringer is preferred over normal saline in...
ok 3164 - safety-regex preserves fluid TYPE: Lactated Ringer is preferred over normal saline in...
  ---
  duration_ms: 0.022375
  type: 'test'
  ...
# Subtest: safety-regex mixed: redact dose, preserve lab unit
ok 3165 - safety-regex mixed: redact dose, preserve lab unit
  ---
  duration_ms: 0.065625
  type: 'test'
  ...
# Subtest: ABG: classic high-AG metabolic acidosis (DKA-flavored)
ok 3166 - ABG: classic high-AG metabolic acidosis (DKA-flavored)
  ---
  duration_ms: 1.542917
  type: 'test'
  ...
# Subtest: ABG: respiratory alkalosis + concurrent high-AG metabolic acidosis (mixed via delta-delta)
ok 3167 - ABG: respiratory alkalosis + concurrent high-AG metabolic acidosis (mixed via delta-delta)
  ---
  duration_ms: 0.188125
  type: 'test'
  ...
# Subtest: ABG: acute respiratory acidosis (no chronic compensation evidence)
ok 3168 - ABG: acute respiratory acidosis (no chronic compensation evidence)
  ---
  duration_ms: 0.132833
  type: 'test'
  ...
# Subtest: ABG: metabolic alkalosis
ok 3169 - ABG: metabolic alkalosis
  ---
  duration_ms: 0.279375
  type: 'test'
  ...
# Subtest: ABG: normal — must not fabricate a disorder
ok 3170 - ABG: normal — must not fabricate a disorder
  ---
  duration_ms: 0.1345
  type: 'test'
  ...
# Subtest: ABG: albumin correction applied below 4.0
ok 3171 - ABG: albumin correction applied below 4.0
  ---
  duration_ms: 0.118666
  type: 'test'
  ...
# Subtest: ABG: P/F ratio Berlin ARDS bands
ok 3172 - ABG: P/F ratio Berlin ARDS bands
  ---
  duration_ms: 0.282625
  type: 'test'
  ...
# Subtest: ABG: A-a gradient computed when PaO2+FiO2+PaCO2 all present
ok 3173 - ABG: A-a gradient computed when PaO2+FiO2+PaCO2 all present
  ---
  duration_ms: 0.140917
  type: 'test'
  ...
# Subtest: ABG: anion gap returns unknown when Na/Cl missing
ok 3174 - ABG: anion gap returns unknown when Na/Cl missing
  ---
  duration_ms: 0.206083
  type: 'test'
  ...
# Subtest: ckdEpi2021: young healthy F, SCr 0.7
ok 3175 - ckdEpi2021: young healthy F, SCr 0.7
  ---
  duration_ms: 0.595875
  type: 'test'
  ...
# Subtest: ckdEpi2021: mid-life M, SCr 1.0
ok 3176 - ckdEpi2021: mid-life M, SCr 1.0
  ---
  duration_ms: 0.066375
  type: 'test'
  ...
# Subtest: ckdEpi2021: older M, SCr 1.8 (CKD3b)
ok 3177 - ckdEpi2021: older M, SCr 1.8 (CKD3b)
  ---
  duration_ms: 0.040833
  type: 'test'
  ...
# Subtest: ckdEpi2021: elderly F, SCr 4.2 (CKD5)
ok 3178 - ckdEpi2021: elderly F, SCr 4.2 (CKD5)
  ---
  duration_ms: 0.037542
  type: 'test'
  ...
# Subtest: ckdEpi2021: F SCr 1.2 (CKD3a)
ok 3179 - ckdEpi2021: F SCr 1.2 (CKD3a)
  ---
  duration_ms: 0.03675
  type: 'test'
  ...
# Subtest: cockcroftGault: young healthy F, SCr 0.7, 60 kg
ok 3180 - cockcroftGault: young healthy F, SCr 0.7, 60 kg
  ---
  duration_ms: 0.063917
  type: 'test'
  ...
# Subtest: cockcroftGault: older M, SCr 1.8, 78 kg
ok 3181 - cockcroftGault: older M, SCr 1.8, 78 kg
  ---
  duration_ms: 0.083833
  type: 'test'
  ...
# Subtest: cockcroftGault: elderly F low weight, SCr 4.2, 52
ok 3182 - cockcroftGault: elderly F low weight, SCr 4.2, 52
  ---
  duration_ms: 0.03075
  type: 'test'
  ...
# Subtest: cockcroftGault returns null without weight
ok 3183 - cockcroftGault returns null without weight
  ---
  duration_ms: 0.174375
  type: 'test'
  ...
# Subtest: computeEgfr returns conservative_for_nti as the lower of the two
ok 3184 - computeEgfr returns conservative_for_nti as the lower of the two
  ---
  duration_ms: 0.297667
  type: 'test'
  ...
# Subtest: stageFromEgfr boundaries
ok 3185 - stageFromEgfr boundaries
  ---
  duration_ms: 0.056625
  type: 'test'
  ...
# Subtest: umolLtoMgDl conversion
ok 3186 - umolLtoMgDl conversion
  ---
  duration_ms: 0.041042
  type: 'test'
  ...
# Subtest: Hyponatremia: classic SIADH (euvolemic, U-Na high, U-osm concentrated, on SSRI)
ok 3187 - Hyponatremia: classic SIADH (euvolemic, U-Na high, U-osm concentrated, on SSRI)
  ---
  duration_ms: 0.887167
  type: 'test'
  ...
# Subtest: Hyponatremia: pseudo from hyperglycemia (corrected Na > measured)
ok 3188 - Hyponatremia: pseudo from hyperglycemia (corrected Na > measured)
  ---
  duration_ms: 0.317958
  type: 'test'
  ...
# Subtest: Hyponatremia: hypovolemic from extrarenal loss
ok 3189 - Hyponatremia: hypovolemic from extrarenal loss
  ---
  duration_ms: 0.111208
  type: 'test'
  ...
# Subtest: Hyponatremia: ODS risk fires for Na < 105
ok 3190 - Hyponatremia: ODS risk fires for Na < 105
  ---
  duration_ms: 0.092875
  type: 'test'
  ...
# Subtest: Hyponatremia: ODS risk fires for K < 3
ok 3191 - Hyponatremia: ODS risk fires for K < 3
  ---
  duration_ms: 0.083875
  type: 'test'
  ...
# Subtest: Hyponatremia: free-water excess for 70kg male, Na 125
ok 3192 - Hyponatremia: free-water excess for 70kg male, Na 125
  ---
  duration_ms: 0.0605
  type: 'test'
  ...
# Subtest: Hyponatremia: free-water excess returns null without weight
ok 3193 - Hyponatremia: free-water excess returns null without weight
  ---
  duration_ms: 0.04575
  type: 'test'
  ...
# Subtest: Hyponatremia: estimated osm fires when serum_osm absent
ok 3194 - Hyponatremia: estimated osm fires when serum_osm absent
  ---
  duration_ms: 0.048083
  type: 'test'
  ...
# Subtest: NEWS2: all-normal vitals → 0 / low / no banner
ok 3195 - NEWS2: all-normal vitals → 0 / low / no banner
  ---
  duration_ms: 0.557167
  type: 'test'
  ...
# Subtest: NEWS2: PRD §11 vignette \#2 — RR 22, SpO2 95, T 38.2, BP 110, HR 105 → 5 medium amber
ok 3196 - NEWS2: PRD §11 vignette \#2 — RR 22, SpO2 95, T 38.2, BP 110, HR 105 → 5 medium amber
  ---
  duration_ms: 0.072583
  type: 'test'
  ...
# Subtest: NEWS2: PRD §11 vignette \#3 — RR 28, SpO2 90, T 39.5, BP 88, HR 130, new confusion → ≥10 high red
ok 3197 - NEWS2: PRD §11 vignette \#3 — RR 28, SpO2 90, T 39.5, BP 88, HR 130, new confusion → ≥10 high red
  ---
  duration_ms: 0.07975
  type: 'test'
  ...
# Subtest: NEWS2 Scale 2 / COPD: SpO2 88 on 2L O2 — air SpO2 target met but on O2
ok 3198 - NEWS2 Scale 2 / COPD: SpO2 88 on 2L O2 — air SpO2 target met but on O2
  ---
  duration_ms: 0.060958
  type: 'test'
  ...
# Subtest: NEWS2 Scale 2: SpO2 96 on O2 (above target window) → scale 2 SpO2 → 2
ok 3199 - NEWS2 Scale 2: SpO2 96 on O2 (above target window) → scale 2 SpO2 → 2
  ---
  duration_ms: 0.048416
  type: 'test'
  ...
# Subtest: NEWS2 Scale 2: SpO2 96 on AIR (above target window without O2) → scale 2 SpO2 → 0
ok 3200 - NEWS2 Scale 2: SpO2 96 on AIR (above target window without O2) → scale 2 SpO2 → 0
  ---
  duration_ms: 0.04275
  type: 'test'
  ...
# Subtest: NEWS2: isolated tachycardia HR 115 → 2 low-medium (not a single 3, so stays low-medium)
ok 3201 - NEWS2: isolated tachycardia HR 115 → 2 low-medium (not a single 3, so stays low-medium)
  ---
  duration_ms: 0.089666
  type: 'test'
  ...
# Subtest: NEWS2: single param scoring 3 bumps low-medium → medium
ok 3202 - NEWS2: single param scoring 3 bumps low-medium → medium
  ---
  duration_ms: 0.043041
  type: 'test'
  ...
# Subtest: NEWS2 RR boundaries
ok 3203 - NEWS2 RR boundaries
  ---
  duration_ms: 0.264
  type: 'test'
  ...
# Subtest: NEWS2 SBP boundaries
ok 3204 - NEWS2 SBP boundaries
  ---
  duration_ms: 0.282459
  type: 'test'
  ...
# Subtest: NEWS2 Temp boundaries
ok 3205 - NEWS2 Temp boundaries
  ---
  duration_ms: 0.070916
  type: 'test'
  ...
# Subtest: NEWS2 consciousness: any non-Alert → 3
ok 3206 - NEWS2 consciousness: any non-Alert → 3
  ---
  duration_ms: 0.052542
  type: 'test'
  ...
# Subtest: SepsisBundle V1: just recognized (5 min), nothing done
ok 3207 - SepsisBundle V1: just recognized (5 min), nothing done
  ---
  duration_ms: 1.226958
  type: 'test'
  ...
# Subtest: SepsisBundle V2: at 35 min, lactate + cultures done, abx + fluids missing (hypotensive)
ok 3208 - SepsisBundle V2: at 35 min, lactate + cultures done, abx + fluids missing (hypotensive)
  ---
  duration_ms: 0.1245
  type: 'test'
  ...
# Subtest: SepsisBundle V2b: at 35 min, only lactate done (25% compliance) → amber banner
ok 3209 - SepsisBundle V2b: at 35 min, only lactate done (25% compliance) → amber banner
  ---
  duration_ms: 0.099708
  type: 'test'
  ...
# Subtest: SepsisBundle V3: 55 min, vasopressors required after fluids in hypotension
ok 3210 - SepsisBundle V3: 55 min, vasopressors required after fluids in hypotension
  ---
  duration_ms: 0.059666
  type: 'test'
  ...
# Subtest: SepsisBundle V4: 75 min, abx never given → overdue + red banner
ok 3211 - SepsisBundle V4: 75 min, abx never given → overdue + red banner
  ---
  duration_ms: 0.130458
  type: 'test'
  ...
# Subtest: SepsisBundle: not-hypotensive patient does not require fluids/vasopressors
ok 3212 - SepsisBundle: not-hypotensive patient does not require fluids/vasopressors
  ---
  duration_ms: 0.119541
  type: 'test'
  ...
# Subtest: SepsisBundle: elapsed_min defaults to 0 for future recognition_time (clamps)
ok 3213 - SepsisBundle: elapsed_min defaults to 0 for future recognition_time (clamps)
  ---
  duration_ms: 0.066209
  type: 'test'
  ...
1..3213
# tests 3213
# suites 0
# pass 3213
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 19773.462917
--- end output ---
EXIT: 0
ENDED: 2026-08-17T03:27:53Z
```

### Command 2 — npm run typecheck

```text
COMMAND: npm run typecheck
STARTED: 2026-08-17T03:27:53Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 typecheck
> tsc --noEmit

--- end output ---
EXIT: 0
ENDED: 2026-08-17T03:27:56Z
```

### Command 3 — keyed production build (env VERCEL=1 VERCEL_ENV=production CDMSS_TELEMETRY_HMAC_KEY=local-gate-key-not-a-secret npm run build)

```text
COMMAND: env VERCEL=1 VERCEL_ENV=production CDMSS_TELEMETRY_HMAC_KEY=local-gate-key-not-a-secret npm run build
STARTED: 2026-08-17T03:27:56Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 build
> next build

   ▲ Next.js 15.5.18
   - Environments: .env.local

   Creating an optimized production build ...
 ✓ Compiled successfully in 8.3s
   Linting and checking validity of types ...
   Collecting page data ...
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
 ⚠ Using edge runtime on a page currently disables static generation for that page
   Generating static pages (0/127) ...
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
   Generating static pages (31/127) 
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
   Generating static pages (63/127) 
The `fetchConnectionCache` option is deprecated (now always `true`)
   Generating static pages (95/127) 
 ✓ Generating static pages (127/127)
   Finalizing page optimization ...
   Collecting build traces ...

Route (app)                                             Size  First Load JS
┌ ƒ /                                                  205 B         107 kB
├ ƒ /_not-found                                      1.01 kB         104 kB
├ ƒ /admin/appropriateness-runs                        600 B         104 kB
├ ƒ /admin/architecture                                205 B         107 kB
├ ƒ /admin/ccb-funnel                                  600 B         104 kB
├ ƒ /admin/concordance                                 205 B         107 kB
├ ƒ /admin/episode-recon-queue                        1.5 kB         108 kB
├ ƒ /admin/eval                                        600 B         104 kB
├ ƒ /admin/ipd-audit                                   178 B         107 kB
├ ƒ /admin/ipd-audit/[id]                            6.16 kB         251 kB
├ ƒ /admin/ipd-audit/calendar                          842 B         107 kB
├ ƒ /admin/ipd-audit/search                            842 B         107 kB
├ ƒ /admin/ipd-gold-queue                             1.6 kB         108 kB
├ ƒ /admin/learning                                  1.76 kB         108 kB
├ ƒ /admin/literature                                  205 B         107 kB
├ ƒ /admin/lvc-ground                                4.23 kB         243 kB
├ ƒ /admin/mini-backfill                             6.58 kB         113 kB
├ ƒ /admin/observability                              5.3 kB         112 kB
├ ƒ /admin/observability/[traceId]                     205 B         107 kB
├ ƒ /admin/observability/adjudications                 178 B         107 kB
├ ƒ /admin/observability/engine-health                 205 B         107 kB
├ ƒ /admin/observability/reconstruction-fidelity       178 B         107 kB
├ ƒ /admin/opd-audit                                 3.48 kB         115 kB
├ ƒ /admin/opd-audit/[id]                            10.9 kB         117 kB
├ ƒ /admin/opd-audit/doctor/[uid]                      180 B         112 kB
├ ƒ /admin/opd-audit/doctors                           205 B         107 kB
├ ƒ /admin/opd-audit/how-it-works                      205 B         107 kB
├ ƒ /admin/opd-audit/vitals-coverage                   205 B         107 kB
├ ƒ /admin/proms-adhoc-review                        3.26 kB         106 kB
├ ƒ /admin/provenance                                  600 B         104 kB
├ ƒ /admin/scoring-policy                              178 B         107 kB
├ ƒ /admin/scoring-policy/lab-packages               2.59 kB         115 kB
├ ƒ /admin/scoring-policy/nabh-completeness            168 B         113 kB
├ ƒ /admin/scoring-policy/nabh-completeness/history    180 B         113 kB
├ ƒ /admin/stewardship                                 205 B         107 kB
├ ƒ /admin/stewardship/dept/[dept]                     205 B         107 kB
├ ƒ /api/admin/appropriateness-runs                    600 B         104 kB
├ ƒ /api/admin/appropriateness-runs/[id]               600 B         104 kB
├ ƒ /api/admin/backfill-corpus-provenance              600 B         104 kB
├ ƒ /api/admin/backfill-stable-ref                     600 B         104 kB
├ ƒ /api/admin/bm25-diag                               600 B         104 kB
├ ƒ /api/admin/ccb-calibration                         600 B         104 kB
├ ƒ /api/admin/complexity-backfill                     600 B         104 kB
├ ƒ /api/admin/concordance/migrate                     600 B         104 kB
├ ƒ /api/admin/concordance/runs                        600 B         104 kB
├ ƒ /api/admin/corpus-eval/status                      600 B         104 kB
├ ƒ /api/admin/episode-recon-rating                    600 B         104 kB
├ ƒ /api/admin/ipd-audit-billed-backfill               600 B         104 kB
├ ƒ /api/admin/ipd-audit-export                        600 B         104 kB
├ ƒ /api/admin/ipd-audit-feedback                      600 B         104 kB
├ ƒ /api/admin/ipd-audit-mini-backfill                 600 B         104 kB
├ ƒ /api/admin/ipd-audit-now                           600 B         104 kB
├ ƒ /api/admin/ipd-gold-adjudication                   600 B         104 kB
├ ƒ /api/admin/lab-batch                               600 B         104 kB
├ ƒ /api/admin/lvc-judge-aa                            600 B         104 kB
├ ƒ /api/admin/lvc-ref-backfill                        600 B         104 kB
├ ƒ /api/admin/mark-mini-labelled-prod                 600 B         104 kB
├ ƒ /api/admin/migrate                                 600 B         104 kB
├ ƒ /api/admin/migrate-adhoc-sets                      600 B         104 kB
├ ƒ /api/admin/migrate-appropriateness-runs            600 B         104 kB
├ ƒ /api/admin/migrate-audit-suppression               600 B         104 kB
├ ƒ /api/admin/migrate-care-call                       600 B         104 kB
├ ƒ /api/admin/migrate-care-tracks                     600 B         104 kB
├ ƒ /api/admin/migrate-ccb                             600 B         104 kB
├ ƒ /api/admin/migrate-ccb-cache                       600 B         104 kB
├ ƒ /api/admin/migrate-choosing-wisely                 600 B         104 kB
├ ƒ /api/admin/migrate-concept-state-key               600 B         104 kB
├ ƒ /api/admin/migrate-doctor-metrics                  600 B         104 kB
├ ƒ /api/admin/migrate-episode-recon                   600 B         104 kB
├ ƒ /api/admin/migrate-episode-states                  600 B         104 kB
├ ƒ /api/admin/migrate-even-ground                     600 B         104 kB
├ ƒ /api/admin/migrate-even-lvc                        600 B         104 kB
├ ƒ /api/admin/migrate-extracted-cases                 600 B         104 kB
├ ƒ /api/admin/migrate-inquiry                         600 B         104 kB
├ ƒ /api/admin/migrate-ipd-audits                      600 B         104 kB
├ ƒ /api/admin/migrate-ipd-gold-union                  600 B         104 kB
├ ƒ /api/admin/migrate-lab                             600 B         104 kB
├ ƒ /api/admin/migrate-lab-views                       600 B         104 kB
├ ƒ /api/admin/migrate-learning                        600 B         104 kB
├ ƒ /api/admin/migrate-lvc-concepts                    600 B         104 kB
├ ƒ /api/admin/migrate-lvc-wording                     600 B         104 kB
├ ƒ /api/admin/migrate-medaudit                        600 B         104 kB
├ ƒ /api/admin/migrate-mini-ticks                      600 B         104 kB
├ ƒ /api/admin/migrate-opd-audits                      600 B         104 kB
├ ƒ /api/admin/migrate-opd-gov-signal                  600 B         104 kB
├ ƒ /api/admin/migrate-opd-longitudinal                600 B         104 kB
├ ƒ /api/admin/migrate-opd-triage                      600 B         104 kB
├ ƒ /api/admin/migrate-proms                           600 B         104 kB
├ ƒ /api/admin/migrate-provenance-tier                 600 B         104 kB
├ ƒ /api/admin/migrate-readmissions                    600 B         104 kB
├ ƒ /api/admin/migrate-reasoning                       600 B         104 kB
├ ƒ /api/admin/migrate-retrieval-telemetry             600 B         104 kB
├ ƒ /api/admin/migrate-scoring-policy                  600 B         104 kB
├ ƒ /api/admin/migrate-v2                              600 B         104 kB
├ ƒ /api/admin/migrate-v6                              600 B         104 kB
├ ƒ /api/admin/migrate-v7                              600 B         104 kB
├ ƒ /api/admin/migrate-v8                              600 B         104 kB
├ ƒ /api/admin/mini-backfill-monitor                   600 B         104 kB
├ ƒ /api/admin/mini-backfill-settings                  600 B         104 kB
├ ƒ /api/admin/ollama-ps                               600 B         104 kB
├ ƒ /api/admin/opd-audit-mini-backfill                 600 B         104 kB
├ ƒ /api/admin/opd-audit/longitudinal-replay           600 B         104 kB
├ ƒ /api/admin/opd-dosing-backfill                     600 B         104 kB
├ ƒ /api/admin/opd-invalid-marking-backfill            600 B         104 kB
├ ƒ /api/admin/opd-rescore-direction                   600 B         104 kB
├ ƒ /api/admin/prognosis-outcome                       600 B         104 kB
├ ƒ /api/admin/proms-adhoc-review                      600 B         104 kB
├ ƒ /api/admin/quieting-dryrun                         600 B         104 kB
├ ƒ /api/admin/reasoning-registry                      600 B         104 kB
├ ƒ /api/admin/recompute-care-call                     600 B         104 kB
├ ƒ /api/admin/refresh-doctor-metrics                  600 B         104 kB
├ ƒ /api/admin/retrieval-telemetry-reconcile           600 B         104 kB
├ ƒ /api/admin/seed-choosing-wisely                    600 B         104 kB
├ ƒ /api/admin/seed-ddi-reference                      600 B         104 kB
├ ƒ /api/admin/seed-formulary                          600 B         104 kB
├ ƒ /api/admin/seed-topics                             600 B         104 kB
├ ƒ /api/admin/seed-topics-tropical                    600 B         104 kB
├ ƒ /api/admin/statpearls-pilot                        600 B         104 kB
├ ƒ /api/admin/sync-doctor-directory                   600 B         104 kB
├ ƒ /api/admin/telemetry-overhead                      600 B         104 kB
├ ƒ /api/admin/tooltip-cache/bump                      600 B         104 kB
├ ƒ /api/admin/traces                                  600 B         104 kB
├ ƒ /api/admin/traces/[traceId]                        600 B         104 kB
├ ƒ /api/admin/unlock                                  600 B         104 kB
├ ƒ /api/appropriateness                               600 B         104 kB
├ ƒ /api/appropriateness/save-run                      600 B         104 kB
├ ƒ /api/ask                                           600 B         104 kB
├ ƒ /api/ask/example-questions                         600 B         104 kB
├ ƒ /api/ask/stage-medians                             600 B         104 kB
├ ƒ /api/audit                                         600 B         104 kB
├ ƒ /api/audit/formulary                               600 B         104 kB
├ ƒ /api/audit/interactions                            600 B         104 kB
├ ƒ /api/audit/login                                   600 B         104 kB
├ ƒ /api/calculators/abcd2                             600 B         104 kB
├ ƒ /api/calculators/abg                               600 B         104 kB
├ ƒ /api/calculators/alvarado                          600 B         104 kB
├ ƒ /api/calculators/curb65                            600 B         104 kB
├ ƒ /api/calculators/egfr                              600 B         104 kB
├ ƒ /api/calculators/heart                             600 B         104 kB
├ ƒ /api/calculators/hyponatremia                      600 B         104 kB
├ ƒ /api/calculators/news2                             600 B         104 kB
├ ƒ /api/calculators/nihss                             600 B         104 kB
├ ƒ /api/calculators/qtc                               600 B         104 kB
├ ƒ /api/calculators/sepsis-bundle                     600 B         104 kB
├ ƒ /api/calculators/sepsis-bundle/sidebar             600 B         104 kB
├ ƒ /api/calculators/sofa                              600 B         104 kB
├ ƒ /api/calculators/timi                              600 B         104 kB
├ ƒ /api/calculators/tooltip                           600 B         104 kB
├ ƒ /api/calculators/typical-latency                   600 B         104 kB
├ ƒ /api/calculators/wells_dvt                         600 B         104 kB
├ ƒ /api/calculators/wells_pe                          600 B         104 kB
├ ƒ /api/care-call/askset                              600 B         104 kB
├ ƒ /api/care-call/outcome                             600 B         104 kB
├ ƒ /api/care-call/outcomes                            600 B         104 kB
├ ƒ /api/care-call/proms/adhoc/generate                600 B         104 kB
├ ƒ /api/care-call/proms/adhoc/update                  600 B         104 kB
├ ƒ /api/care-call/proms/response                      600 B         104 kB
├ ƒ /api/care-call/proms/schedule                      600 B         104 kB
├ ƒ /api/care/assignment                               600 B         104 kB
├ ƒ /api/care/concept/code                             600 B         104 kB
├ ƒ /api/care/concept/status                           600 B         104 kB
├ ƒ /api/care/login                                    600 B         104 kB
├ ƒ /api/care/lvc/generate                             600 B         104 kB
├ ƒ /api/care/lvc/ground                               600 B         104 kB
├ ƒ /api/care/lvc/ground-status                        600 B         104 kB
├ ƒ /api/care/lvc/list                                 600 B         104 kB
├ ƒ /api/care/lvc/ratify                               600 B         104 kB
├ ƒ /api/care/lvc/reject                               600 B         104 kB
├ ƒ /api/care/lvc/retire                               600 B         104 kB
├ ƒ /api/care/member-state                             600 B         104 kB
├ ƒ /api/care/readmissions/list                        600 B         104 kB
├ ƒ /api/care/review-queue                             600 B         104 kB
├ ƒ /api/care/review-stats                             600 B         104 kB
├ ƒ /api/care/workspace                                600 B         104 kB
├ ƒ /api/ccb/brief                                     600 B         104 kB
├ ƒ /api/ccb/brief/stream                              600 B         104 kB
├ ƒ /api/ccb/dossier                                   600 B         104 kB
├ ƒ /api/ccb/episode-docs                              600 B         104 kB
├ ƒ /api/ccb/search                                    600 B         104 kB
├ ƒ /api/ccb/selftest                                  600 B         104 kB
├ ƒ /api/ccb/worker                                    600 B         104 kB
├ ƒ /api/ccb/worklist                                  600 B         104 kB
├ ƒ /api/coach/end                                     600 B         104 kB
├ ƒ /api/coach/respond                                 600 B         104 kB
├ ƒ /api/coach/start                                   600 B         104 kB
├ ƒ /api/concordance/interview                         600 B         104 kB
├ ƒ /api/concordance/single-shot                       600 B         104 kB
├ ƒ /api/cron/curator                                  600 B         104 kB
├ ƒ /api/cron/harvest                                  600 B         104 kB
├ ƒ /api/cron/harvest-epmc                             600 B         104 kB
├ ƒ /api/ddx                                           600 B         104 kB
├ ƒ /api/debug-search                                  600 B         104 kB
├ ƒ /api/debug-stats                                   600 B         104 kB
├ ƒ /api/digest/generate                               600 B         104 kB
├ ƒ /api/doc-audit/analyze                             600 B         104 kB
├ ƒ /api/doc-audit/extract                             600 B         104 kB
├ ƒ /api/drugs/interactions                            600 B         104 kB
├ ƒ /api/drugs/lookup                                  600 B         104 kB
├ ƒ /api/flashcards/due                                600 B         104 kB
├ ƒ /api/flashcards/review                             600 B         104 kB
├ ƒ /api/governance/audit-signal/[reference]           600 B         104 kB
├ ƒ /api/governance/doctor-audits                      600 B         104 kB
├ ƒ /api/governance/doctor-directory                   600 B         104 kB
├ ƒ /api/governance/doctor-response                    600 B         104 kB
├ ƒ /api/governance/opd-signals                        600 B         104 kB
├ ƒ /api/governance/roster-audits                      600 B         104 kB
├ ƒ /api/governance/signal-action                      600 B         104 kB
├ ƒ /api/health                                        600 B         104 kB
├ ƒ /api/ipd-audit/review                              600 B         104 kB
├ ƒ /api/ipd-audit/worker                              600 B         104 kB
├ ƒ /api/lab/ml-label-trial                            600 B         104 kB
├ ƒ /api/learning/mine                                 600 B         104 kB
├ ƒ /api/learning/review                               600 B         104 kB
├ ƒ /api/log/query                                     600 B         104 kB
├ ƒ /api/mcp                                           600 B         104 kB
├ ƒ /api/mcp/[key]                                     600 B         104 kB
├ ƒ /api/opd-audit/backfill                            600 B         104 kB
├ ƒ /api/opd-audit/export-pdf                          600 B         104 kB
├ ƒ /api/opd-audit/feedback                            600 B         104 kB
├ ƒ /api/opd-audit/reset                               600 B         104 kB
├ ƒ /api/opd-audit/run                                 600 B         104 kB
├ ƒ /api/opd-audit/worker                              600 B         104 kB
├ ƒ /api/opd-triage/decide                             600 B         104 kB
├ ƒ /api/opd-triage/longitudinal-lane                  600 B         104 kB
├ ƒ /api/opd-triage/queue                              600 B         104 kB
├ ƒ /api/opd-triage/signal-health                      600 B         104 kB
├ ƒ /api/opd-triage/suppressions                       600 B         104 kB
├ ƒ /api/pathway/enrich                                600 B         104 kB
├ ƒ /api/pathway/skeleton                              600 B         104 kB
├ ƒ /api/practice/next                                 600 B         104 kB
├ ƒ /api/readmission/worker                            600 B         104 kB
├ ƒ /api/scoring-policy                                600 B         104 kB
├ ƒ /api/scoring-policy/draft                          600 B         104 kB
├ ƒ /api/scoring-policy/lab-packages/export            600 B         104 kB
├ ƒ /api/scoring-policy/lab-packages/import            600 B         104 kB
├ ƒ /api/scoring-policy/preview                        600 B         104 kB
├ ƒ /api/scoring-policy/publish                        600 B         104 kB
├ ƒ /api/search                                        600 B         104 kB
├ ƒ /api/topics                                        600 B         104 kB
├ ƒ /api/v1/patient-summary                            600 B         104 kB
├ ƒ /api/v1/patient-summary/[jobId]                    600 B         104 kB
├ ƒ /appropriateness                                 17.6 kB         266 kB
├ ƒ /ask                                             6.24 kB         179 kB
├ ƒ /ask/trace/[trace_id]                            1.63 kB         108 kB
├ ƒ /audit                                           9.26 kB         112 kB
├ ƒ /audit/login                                       985 B         104 kB
├ ƒ /audit/queries                                     600 B         104 kB
├ ƒ /browse                                            205 B         107 kB
├ ƒ /calculators                                     1.57 kB         108 kB
├ ƒ /calculators/abcd2                               2.57 kB         113 kB
├ ƒ /calculators/abg                                 4.99 kB         112 kB
├ ƒ /calculators/alvarado                            2.41 kB         113 kB
├ ƒ /calculators/curb65                              2.05 kB         112 kB
├ ƒ /calculators/egfr                                2.94 kB         113 kB
├ ƒ /calculators/heart                                  3 kB         113 kB
├ ƒ /calculators/hyponatremia                        5.68 kB         112 kB
├ ƒ /calculators/news2                               3.85 kB         114 kB
├ ƒ /calculators/nihss                               4.27 kB         115 kB
├ ƒ /calculators/qtc                                  2.6 kB         113 kB
├ ƒ /calculators/sepsis-bundle                        4.9 kB         111 kB
├ ƒ /calculators/sofa                                3.55 kB         114 kB
├ ƒ /calculators/timi                                2.19 kB         112 kB
├ ƒ /calculators/wells_dvt                           2.46 kB         113 kB
├ ƒ /calculators/wells_pe                            2.39 kB         113 kB
├ ƒ /care                                              178 B         107 kB
├ ƒ /care/[uid]                                      12.5 kB         124 kB
├ ƒ /care/briefs                                     2.82 kB         109 kB
├ ƒ /care/concepts                                   4.48 kB         239 kB
├ ƒ /care/login                                        982 B         104 kB
├ ƒ /care/lvc                                           6 kB         241 kB
├ ƒ /care/m/[uid]                                    25.3 kB         137 kB
├ ƒ /care/readmissions                               5.21 kB         112 kB
├ ƒ /care/review                                     9.91 kB         113 kB
├ ƒ /care/triage                                     11.2 kB         114 kB
├ ƒ /care/triage/health                              4.65 kB         108 kB
├ ƒ /coach                                           5.91 kB         171 kB
├ ƒ /concordance                                     4.43 kB         108 kB
├ ƒ /ddx                                             9.37 kB         182 kB
├ ƒ /drugs                                           8.86 kB         119 kB
├ ƒ /knowledge                                       3.29 kB         110 kB
├ ƒ /learn                                             205 B         107 kB
├ ƒ /practice                                        3.08 kB         106 kB
├ ƒ /review                                          4.75 kB         108 kB
├ ƒ /search                                            600 B         104 kB
└ ƒ /topics                                           3.4 kB         107 kB
+ First Load JS shared by all                         103 kB
  ├ chunks/3636-b8d66f842f910767.js                    46 kB
  ├ chunks/4bd1b696-100b9d70ed4e49c1.js              54.2 kB
  └ other shared chunks (total)                      2.95 kB


ƒ Middleware                                         34.5 kB

ƒ  (Dynamic)  server-rendered on demand

--- end output ---
EXIT: 0
ENDED: 2026-08-17T03:28:31Z
```

### Command 4 — npm run architecture:check

```text
COMMAND: npm run architecture:check
STARTED: 2026-08-17T03:28:31Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 architecture:check
> node --import tsx scripts/architecture-check.mjs

rule 1 · GREEN · 26 files scanned · pure clinical cores must not reach up into the app
rule 2 · GREEN · 4 files scanned · advisory must not import score arithmetic (finding types/identity from opd-note-audit-core ARE allowed)
rule 3 · GREEN · 24 files scanned · the spine runs no audit/score logic (VALUE imports; `import type` is allowed)
rule 4 · GREEN · 24 files scanned · the spine must not couple to a prediction layer
rule 5 · GREEN · 8 files scanned · inquiry (advisory) and the scored cores never value-import each other
rule 6 · GREEN · 24 files scanned · the spine must not value-import the IPD audit module
rule 7 · GREEN · 24 files scanned · the frozen spine must not import EpisodeState
rule 8 · GREEN · 24 files scanned · the frozen spine must not import the admission adapter
coverage · GREEN · 39 subsystems · 16 registered, 23 explicitly unregistered

architecture:check — all 8 rules + coverage green.
--- end output ---
EXIT: 0
ENDED: 2026-08-17T03:28:31Z
```

### Command 5 — npm run architecture:map

```text
COMMAND: npm run architecture:map
STARTED: 2026-08-17T03:28:31Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 architecture:map
> node --import tsx scripts/architecture-map-gen.mjs

architecture:map — wrote lib/architecture/map.generated.ts (90492 bytes).
--- end output ---
EXIT: 0
ENDED: 2026-08-17T03:28:31Z
```

### Command 6 — precondition 1: git diff --exit-code -- lib/architecture/map.generated.ts

```text
COMMAND: git diff --exit-code -- lib/architecture/map.generated.ts
STARTED: 2026-08-17T03:28:31Z
--- output (stdout+stderr merged) ---
--- end output ---
EXIT: 0
ENDED: 2026-08-17T03:28:31Z
```

### Command 6 — precondition 2: git diff --cached --exit-code -- lib/architecture/map.generated.ts

```text
COMMAND: git diff --cached --exit-code -- lib/architecture/map.generated.ts
STARTED: 2026-08-17T03:28:31Z
--- output (stdout+stderr merged) ---
--- end output ---
EXIT: 0
ENDED: 2026-08-17T03:28:32Z
```

### git status immediately before the command 6 five-line block

```text
COMMAND: git status --porcelain (immediately before command 6 five-line block)
COMMAND: git status --porcelain --ignored
!! .env.local
!! .next/
!! .vercel/
!! CDMSS-RERANK-TELEMETRY-ADDENDUM-v18-16-AUG-2026.md
!! CDMSS-SAUL-REVIEW-29-16-AUG-2026.md
!! next-env.d.ts
!! node_modules/
!! tsconfig.tsbuildinfo
```

### Command 6 line 1 — npm run architecture:map (generation one)

```text
COMMAND: npm run architecture:map
STARTED: 2026-08-17T03:28:32Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 architecture:map
> node --import tsx scripts/architecture-map-gen.mjs

architecture:map — wrote lib/architecture/map.generated.ts (90492 bytes).
--- end output ---
EXIT: 0
ENDED: 2026-08-17T03:28:32Z
```

### wc -c after generation one (the generator prints UTF-16 code units labelled "bytes"; wc -c counts bytes; the two differ by design)

```text
   90494 lib/architecture/map.generated.ts
```

### Command 6 line 2 — cp lib/architecture/map.generated.ts "$CAPTURE/gen1.ts"

```text
COMMAND: cp lib/architecture/map.generated.ts /Users/vinaybhardwaj/cdmss-pass2-gate-supplemental-16-aug-2026/gen1.ts
STARTED: 2026-08-17T03:28:32Z
--- output (stdout+stderr merged) ---
--- end output ---
EXIT: 0
ENDED: 2026-08-17T03:28:32Z
```

### Command 6 line 3 — npm run architecture:map (generation two)

```text
COMMAND: npm run architecture:map
STARTED: 2026-08-17T03:28:32Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 architecture:map
> node --import tsx scripts/architecture-map-gen.mjs

architecture:map — wrote lib/architecture/map.generated.ts (90492 bytes).
--- end output ---
EXIT: 0
ENDED: 2026-08-17T03:28:33Z
```

### wc -c after generation two

```text
   90494 lib/architecture/map.generated.ts
```

### Command 6 line 4 — cmp lib/architecture/map.generated.ts "$CAPTURE/gen1.ts" (determinism: generation two equals generation one)

```text
COMMAND: cmp lib/architecture/map.generated.ts /Users/vinaybhardwaj/cdmss-pass2-gate-supplemental-16-aug-2026/gen1.ts
STARTED: 2026-08-17T03:28:33Z
--- output (stdout+stderr merged) ---
--- end output ---
EXIT: 0
ENDED: 2026-08-17T03:28:33Z
```

### Command 6 line 5 — git diff --exit-code -- lib/architecture/map.generated.ts (currency: the committed map is current; no git write occurred)

```text
COMMAND: git diff --exit-code -- lib/architecture/map.generated.ts
STARTED: 2026-08-17T03:28:33Z
--- output (stdout+stderr merged) ---
--- end output ---
EXIT: 0
ENDED: 2026-08-17T03:28:33Z
```

### git status immediately after the command 6 five-line block

```text
COMMAND: git status --porcelain (immediately after command 6 five-line block)
COMMAND: git status --porcelain --ignored
!! .env.local
!! .next/
!! .vercel/
!! CDMSS-RERANK-TELEMETRY-ADDENDUM-v18-16-AUG-2026.md
!! CDMSS-SAUL-REVIEW-29-16-AUG-2026.md
!! next-env.d.ts
!! node_modules/
!! tsconfig.tsbuildinfo
```

### Command 7 — the registry, QUOTED FORM

⚠️ How the quotes were preserved: the command line in the transcript below was
written into the capture file through a single-quoted heredoc BEFORE executing
the identical line, so the single quotes survive byte-for-byte and do not
depend on shell history or any capture mechanism that strips quoting.

### Command 7 transcript

```text
COMMAND (exactly as executed, single quotes included):
bash -c 'npm run reasoning:registry && git diff --exit-code data/reasoning-registry/prompts.generated.json'
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 reasoning:registry
> node scripts/reasoning-registry-gen.mjs

reasoning:registry — wrote data/reasoning-registry/prompts.generated.json (88737 bytes; 30 prompts · 7 rubrics · 36 builders · 19 features).
--- end output ---
EXIT: 0
```

### Auxiliary check (not a numbered gate entry) — git diff --exit-code data/reasoning-registry/prompts.generated.json

```text
COMMAND: git diff --exit-code data/reasoning-registry/prompts.generated.json
STARTED: 2026-08-17T03:28:33Z
--- output (stdout+stderr merged) ---
--- end output ---
EXIT: 0
ENDED: 2026-08-17T03:28:33Z
```

### Command 8 — npm run reasoning:governance

```text
COMMAND: npm run reasoning:governance
STARTED: 2026-08-17T03:28:33Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 reasoning:governance
> node scripts/reasoning-governance-check.mjs

reasoning governance — HARD GATE (Stage 4): no direct model calls outside the governed layer

ungoverned model calls (bypass tracedChat/governedChat): 0

parallel run stores: 15 references (INFO — folded into traces since Stage 4)
  info lib/concordance-store.ts:8 — concordance_runs
  info lib/concordance-store.ts:28 — concordance_runs
  info lib/concordance-store.ts:46 — concordance_runs
  info lib/concordance-store.ts:47 — concordance_runs
  info lib/concordance-store.ts:48 — concordance_runs
  info lib/concordance.ts:8 — concordance_runs
  info lib/concordance.ts:9 — concordance_runs
  info app/admin/concordance/page.tsx:58 — concordance_runs
  info app/api/admin/concordance/migrate/route.ts:8 — concordance_runs
  info app/api/admin/concordance/migrate/route.ts:14 — concordance_runs
  info app/api/admin/concordance/migrate/route.ts:31 — concordance_runs
  info app/api/admin/concordance/migrate/route.ts:32 — concordance_runs
  info app/api/admin/concordance/migrate/route.ts:33 — concordance_runs
  info app/api/admin/concordance/migrate/route.ts:34 — concordance_runs
  info app/api/admin/concordance/runs/route.ts:10 — concordance_runs

reasoning:governance — GREEN: 0 ungoverned model calls; parallel stores folded.
--- end output ---
EXIT: 0
ENDED: 2026-08-17T03:28:34Z
```

### Command 9 — npm run changelog:coverage

```text
COMMAND: npm run changelog:coverage
STARTED: 2026-08-17T03:28:34Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 changelog:coverage
> node scripts/changelog-coverage-check.mjs

changelog:coverage — GREEN: all 19 shipped engine versions documented (30 versioned entries).
--- end output ---
EXIT: 0
ENDED: 2026-08-17T03:28:34Z
```

### Build pair 1 — the REFUSAL build (CDMSS_TELEMETRY_HMAC_KEY empty; a NONZERO exit is the pass condition, and the error names the key)

```text
COMMAND: env VERCEL=1 VERCEL_ENV=production CDMSS_TELEMETRY_HMAC_KEY= npm run build
STARTED: 2026-08-17T03:28:34Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 build
> next build

 ⨯ Failed to load next.config.mjs, see more info here https://nextjs.org/docs/messages/next-config-error

> Build error occurred
Error: CDMSS_TELEMETRY_HMAC_KEY is required for a production build. Rerank telemetry keys every patient-derived value it records; an unkeyed digest of clinical text is not acceptable (§4.3). Set it in Vercel Production before deploying.
    at <unknown> (next.config.mjs:14:9)
--- end output ---
EXIT: 1 (nonzero EXPECTED — the refusal build)
```

### Build pair 2 — the KEYED build

```text
COMMAND: env VERCEL=1 VERCEL_ENV=production CDMSS_TELEMETRY_HMAC_KEY=local-gate-key-not-a-secret npm run build
STARTED: 2026-08-17T03:28:34Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 build
> next build

   ▲ Next.js 15.5.18
   - Environments: .env.local

   Creating an optimized production build ...
 ✓ Compiled successfully in 8.5s
   Linting and checking validity of types ...
   Collecting page data ...
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
 ⚠ Using edge runtime on a page currently disables static generation for that page
   Generating static pages (0/127) ...
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
   Generating static pages (31/127) 
The `fetchConnectionCache` option is deprecated (now always `true`)
   Generating static pages (63/127) 
The `fetchConnectionCache` option is deprecated (now always `true`)
   Generating static pages (95/127) 
 ✓ Generating static pages (127/127)
   Finalizing page optimization ...
   Collecting build traces ...

Route (app)                                             Size  First Load JS
┌ ƒ /                                                  205 B         107 kB
├ ƒ /_not-found                                      1.01 kB         104 kB
├ ƒ /admin/appropriateness-runs                        600 B         104 kB
├ ƒ /admin/architecture                                205 B         107 kB
├ ƒ /admin/ccb-funnel                                  600 B         104 kB
├ ƒ /admin/concordance                                 205 B         107 kB
├ ƒ /admin/episode-recon-queue                        1.5 kB         108 kB
├ ƒ /admin/eval                                        600 B         104 kB
├ ƒ /admin/ipd-audit                                   178 B         107 kB
├ ƒ /admin/ipd-audit/[id]                            6.16 kB         251 kB
├ ƒ /admin/ipd-audit/calendar                          842 B         107 kB
├ ƒ /admin/ipd-audit/search                            842 B         107 kB
├ ƒ /admin/ipd-gold-queue                             1.6 kB         108 kB
├ ƒ /admin/learning                                  1.76 kB         108 kB
├ ƒ /admin/literature                                  205 B         107 kB
├ ƒ /admin/lvc-ground                                4.23 kB         243 kB
├ ƒ /admin/mini-backfill                             6.58 kB         113 kB
├ ƒ /admin/observability                              5.3 kB         112 kB
├ ƒ /admin/observability/[traceId]                     205 B         107 kB
├ ƒ /admin/observability/adjudications                 178 B         107 kB
├ ƒ /admin/observability/engine-health                 205 B         107 kB
├ ƒ /admin/observability/reconstruction-fidelity       178 B         107 kB
├ ƒ /admin/opd-audit                                 3.48 kB         115 kB
├ ƒ /admin/opd-audit/[id]                            10.9 kB         117 kB
├ ƒ /admin/opd-audit/doctor/[uid]                      180 B         112 kB
├ ƒ /admin/opd-audit/doctors                           205 B         107 kB
├ ƒ /admin/opd-audit/how-it-works                      205 B         107 kB
├ ƒ /admin/opd-audit/vitals-coverage                   205 B         107 kB
├ ƒ /admin/proms-adhoc-review                        3.26 kB         106 kB
├ ƒ /admin/provenance                                  600 B         104 kB
├ ƒ /admin/scoring-policy                              178 B         107 kB
├ ƒ /admin/scoring-policy/lab-packages               2.59 kB         115 kB
├ ƒ /admin/scoring-policy/nabh-completeness            168 B         113 kB
├ ƒ /admin/scoring-policy/nabh-completeness/history    180 B         113 kB
├ ƒ /admin/stewardship                                 205 B         107 kB
├ ƒ /admin/stewardship/dept/[dept]                     205 B         107 kB
├ ƒ /api/admin/appropriateness-runs                    600 B         104 kB
├ ƒ /api/admin/appropriateness-runs/[id]               600 B         104 kB
├ ƒ /api/admin/backfill-corpus-provenance              600 B         104 kB
├ ƒ /api/admin/backfill-stable-ref                     600 B         104 kB
├ ƒ /api/admin/bm25-diag                               600 B         104 kB
├ ƒ /api/admin/ccb-calibration                         600 B         104 kB
├ ƒ /api/admin/complexity-backfill                     600 B         104 kB
├ ƒ /api/admin/concordance/migrate                     600 B         104 kB
├ ƒ /api/admin/concordance/runs                        600 B         104 kB
├ ƒ /api/admin/corpus-eval/status                      600 B         104 kB
├ ƒ /api/admin/episode-recon-rating                    600 B         104 kB
├ ƒ /api/admin/ipd-audit-billed-backfill               600 B         104 kB
├ ƒ /api/admin/ipd-audit-export                        600 B         104 kB
├ ƒ /api/admin/ipd-audit-feedback                      600 B         104 kB
├ ƒ /api/admin/ipd-audit-mini-backfill                 600 B         104 kB
├ ƒ /api/admin/ipd-audit-now                           600 B         104 kB
├ ƒ /api/admin/ipd-gold-adjudication                   600 B         104 kB
├ ƒ /api/admin/lab-batch                               600 B         104 kB
├ ƒ /api/admin/lvc-judge-aa                            600 B         104 kB
├ ƒ /api/admin/lvc-ref-backfill                        600 B         104 kB
├ ƒ /api/admin/mark-mini-labelled-prod                 600 B         104 kB
├ ƒ /api/admin/migrate                                 600 B         104 kB
├ ƒ /api/admin/migrate-adhoc-sets                      600 B         104 kB
├ ƒ /api/admin/migrate-appropriateness-runs            600 B         104 kB
├ ƒ /api/admin/migrate-audit-suppression               600 B         104 kB
├ ƒ /api/admin/migrate-care-call                       600 B         104 kB
├ ƒ /api/admin/migrate-care-tracks                     600 B         104 kB
├ ƒ /api/admin/migrate-ccb                             600 B         104 kB
├ ƒ /api/admin/migrate-ccb-cache                       600 B         104 kB
├ ƒ /api/admin/migrate-choosing-wisely                 600 B         104 kB
├ ƒ /api/admin/migrate-concept-state-key               600 B         104 kB
├ ƒ /api/admin/migrate-doctor-metrics                  600 B         104 kB
├ ƒ /api/admin/migrate-episode-recon                   600 B         104 kB
├ ƒ /api/admin/migrate-episode-states                  600 B         104 kB
├ ƒ /api/admin/migrate-even-ground                     600 B         104 kB
├ ƒ /api/admin/migrate-even-lvc                        600 B         104 kB
├ ƒ /api/admin/migrate-extracted-cases                 600 B         104 kB
├ ƒ /api/admin/migrate-inquiry                         600 B         104 kB
├ ƒ /api/admin/migrate-ipd-audits                      600 B         104 kB
├ ƒ /api/admin/migrate-ipd-gold-union                  600 B         104 kB
├ ƒ /api/admin/migrate-lab                             600 B         104 kB
├ ƒ /api/admin/migrate-lab-views                       600 B         104 kB
├ ƒ /api/admin/migrate-learning                        600 B         104 kB
├ ƒ /api/admin/migrate-lvc-concepts                    600 B         104 kB
├ ƒ /api/admin/migrate-lvc-wording                     600 B         104 kB
├ ƒ /api/admin/migrate-medaudit                        600 B         104 kB
├ ƒ /api/admin/migrate-mini-ticks                      600 B         104 kB
├ ƒ /api/admin/migrate-opd-audits                      600 B         104 kB
├ ƒ /api/admin/migrate-opd-gov-signal                  600 B         104 kB
├ ƒ /api/admin/migrate-opd-longitudinal                600 B         104 kB
├ ƒ /api/admin/migrate-opd-triage                      600 B         104 kB
├ ƒ /api/admin/migrate-proms                           600 B         104 kB
├ ƒ /api/admin/migrate-provenance-tier                 600 B         104 kB
├ ƒ /api/admin/migrate-readmissions                    600 B         104 kB
├ ƒ /api/admin/migrate-reasoning                       600 B         104 kB
├ ƒ /api/admin/migrate-retrieval-telemetry             600 B         104 kB
├ ƒ /api/admin/migrate-scoring-policy                  600 B         104 kB
├ ƒ /api/admin/migrate-v2                              600 B         104 kB
├ ƒ /api/admin/migrate-v6                              600 B         104 kB
├ ƒ /api/admin/migrate-v7                              600 B         104 kB
├ ƒ /api/admin/migrate-v8                              600 B         104 kB
├ ƒ /api/admin/mini-backfill-monitor                   600 B         104 kB
├ ƒ /api/admin/mini-backfill-settings                  600 B         104 kB
├ ƒ /api/admin/ollama-ps                               600 B         104 kB
├ ƒ /api/admin/opd-audit-mini-backfill                 600 B         104 kB
├ ƒ /api/admin/opd-audit/longitudinal-replay           600 B         104 kB
├ ƒ /api/admin/opd-dosing-backfill                     600 B         104 kB
├ ƒ /api/admin/opd-invalid-marking-backfill            600 B         104 kB
├ ƒ /api/admin/opd-rescore-direction                   600 B         104 kB
├ ƒ /api/admin/prognosis-outcome                       600 B         104 kB
├ ƒ /api/admin/proms-adhoc-review                      600 B         104 kB
├ ƒ /api/admin/quieting-dryrun                         600 B         104 kB
├ ƒ /api/admin/reasoning-registry                      600 B         104 kB
├ ƒ /api/admin/recompute-care-call                     600 B         104 kB
├ ƒ /api/admin/refresh-doctor-metrics                  600 B         104 kB
├ ƒ /api/admin/retrieval-telemetry-reconcile           600 B         104 kB
├ ƒ /api/admin/seed-choosing-wisely                    600 B         104 kB
├ ƒ /api/admin/seed-ddi-reference                      600 B         104 kB
├ ƒ /api/admin/seed-formulary                          600 B         104 kB
├ ƒ /api/admin/seed-topics                             600 B         104 kB
├ ƒ /api/admin/seed-topics-tropical                    600 B         104 kB
├ ƒ /api/admin/statpearls-pilot                        600 B         104 kB
├ ƒ /api/admin/sync-doctor-directory                   600 B         104 kB
├ ƒ /api/admin/telemetry-overhead                      600 B         104 kB
├ ƒ /api/admin/tooltip-cache/bump                      600 B         104 kB
├ ƒ /api/admin/traces                                  600 B         104 kB
├ ƒ /api/admin/traces/[traceId]                        600 B         104 kB
├ ƒ /api/admin/unlock                                  600 B         104 kB
├ ƒ /api/appropriateness                               600 B         104 kB
├ ƒ /api/appropriateness/save-run                      600 B         104 kB
├ ƒ /api/ask                                           600 B         104 kB
├ ƒ /api/ask/example-questions                         600 B         104 kB
├ ƒ /api/ask/stage-medians                             600 B         104 kB
├ ƒ /api/audit                                         600 B         104 kB
├ ƒ /api/audit/formulary                               600 B         104 kB
├ ƒ /api/audit/interactions                            600 B         104 kB
├ ƒ /api/audit/login                                   600 B         104 kB
├ ƒ /api/calculators/abcd2                             600 B         104 kB
├ ƒ /api/calculators/abg                               600 B         104 kB
├ ƒ /api/calculators/alvarado                          600 B         104 kB
├ ƒ /api/calculators/curb65                            600 B         104 kB
├ ƒ /api/calculators/egfr                              600 B         104 kB
├ ƒ /api/calculators/heart                             600 B         104 kB
├ ƒ /api/calculators/hyponatremia                      600 B         104 kB
├ ƒ /api/calculators/news2                             600 B         104 kB
├ ƒ /api/calculators/nihss                             600 B         104 kB
├ ƒ /api/calculators/qtc                               600 B         104 kB
├ ƒ /api/calculators/sepsis-bundle                     600 B         104 kB
├ ƒ /api/calculators/sepsis-bundle/sidebar             600 B         104 kB
├ ƒ /api/calculators/sofa                              600 B         104 kB
├ ƒ /api/calculators/timi                              600 B         104 kB
├ ƒ /api/calculators/tooltip                           600 B         104 kB
├ ƒ /api/calculators/typical-latency                   600 B         104 kB
├ ƒ /api/calculators/wells_dvt                         600 B         104 kB
├ ƒ /api/calculators/wells_pe                          600 B         104 kB
├ ƒ /api/care-call/askset                              600 B         104 kB
├ ƒ /api/care-call/outcome                             600 B         104 kB
├ ƒ /api/care-call/outcomes                            600 B         104 kB
├ ƒ /api/care-call/proms/adhoc/generate                600 B         104 kB
├ ƒ /api/care-call/proms/adhoc/update                  600 B         104 kB
├ ƒ /api/care-call/proms/response                      600 B         104 kB
├ ƒ /api/care-call/proms/schedule                      600 B         104 kB
├ ƒ /api/care/assignment                               600 B         104 kB
├ ƒ /api/care/concept/code                             600 B         104 kB
├ ƒ /api/care/concept/status                           600 B         104 kB
├ ƒ /api/care/login                                    600 B         104 kB
├ ƒ /api/care/lvc/generate                             600 B         104 kB
├ ƒ /api/care/lvc/ground                               600 B         104 kB
├ ƒ /api/care/lvc/ground-status                        600 B         104 kB
├ ƒ /api/care/lvc/list                                 600 B         104 kB
├ ƒ /api/care/lvc/ratify                               600 B         104 kB
├ ƒ /api/care/lvc/reject                               600 B         104 kB
├ ƒ /api/care/lvc/retire                               600 B         104 kB
├ ƒ /api/care/member-state                             600 B         104 kB
├ ƒ /api/care/readmissions/list                        600 B         104 kB
├ ƒ /api/care/review-queue                             600 B         104 kB
├ ƒ /api/care/review-stats                             600 B         104 kB
├ ƒ /api/care/workspace                                600 B         104 kB
├ ƒ /api/ccb/brief                                     600 B         104 kB
├ ƒ /api/ccb/brief/stream                              600 B         104 kB
├ ƒ /api/ccb/dossier                                   600 B         104 kB
├ ƒ /api/ccb/episode-docs                              600 B         104 kB
├ ƒ /api/ccb/search                                    600 B         104 kB
├ ƒ /api/ccb/selftest                                  600 B         104 kB
├ ƒ /api/ccb/worker                                    600 B         104 kB
├ ƒ /api/ccb/worklist                                  600 B         104 kB
├ ƒ /api/coach/end                                     600 B         104 kB
├ ƒ /api/coach/respond                                 600 B         104 kB
├ ƒ /api/coach/start                                   600 B         104 kB
├ ƒ /api/concordance/interview                         600 B         104 kB
├ ƒ /api/concordance/single-shot                       600 B         104 kB
├ ƒ /api/cron/curator                                  600 B         104 kB
├ ƒ /api/cron/harvest                                  600 B         104 kB
├ ƒ /api/cron/harvest-epmc                             600 B         104 kB
├ ƒ /api/ddx                                           600 B         104 kB
├ ƒ /api/debug-search                                  600 B         104 kB
├ ƒ /api/debug-stats                                   600 B         104 kB
├ ƒ /api/digest/generate                               600 B         104 kB
├ ƒ /api/doc-audit/analyze                             600 B         104 kB
├ ƒ /api/doc-audit/extract                             600 B         104 kB
├ ƒ /api/drugs/interactions                            600 B         104 kB
├ ƒ /api/drugs/lookup                                  600 B         104 kB
├ ƒ /api/flashcards/due                                600 B         104 kB
├ ƒ /api/flashcards/review                             600 B         104 kB
├ ƒ /api/governance/audit-signal/[reference]           600 B         104 kB
├ ƒ /api/governance/doctor-audits                      600 B         104 kB
├ ƒ /api/governance/doctor-directory                   600 B         104 kB
├ ƒ /api/governance/doctor-response                    600 B         104 kB
├ ƒ /api/governance/opd-signals                        600 B         104 kB
├ ƒ /api/governance/roster-audits                      600 B         104 kB
├ ƒ /api/governance/signal-action                      600 B         104 kB
├ ƒ /api/health                                        600 B         104 kB
├ ƒ /api/ipd-audit/review                              600 B         104 kB
├ ƒ /api/ipd-audit/worker                              600 B         104 kB
├ ƒ /api/lab/ml-label-trial                            600 B         104 kB
├ ƒ /api/learning/mine                                 600 B         104 kB
├ ƒ /api/learning/review                               600 B         104 kB
├ ƒ /api/log/query                                     600 B         104 kB
├ ƒ /api/mcp                                           600 B         104 kB
├ ƒ /api/mcp/[key]                                     600 B         104 kB
├ ƒ /api/opd-audit/backfill                            600 B         104 kB
├ ƒ /api/opd-audit/export-pdf                          600 B         104 kB
├ ƒ /api/opd-audit/feedback                            600 B         104 kB
├ ƒ /api/opd-audit/reset                               600 B         104 kB
├ ƒ /api/opd-audit/run                                 600 B         104 kB
├ ƒ /api/opd-audit/worker                              600 B         104 kB
├ ƒ /api/opd-triage/decide                             600 B         104 kB
├ ƒ /api/opd-triage/longitudinal-lane                  600 B         104 kB
├ ƒ /api/opd-triage/queue                              600 B         104 kB
├ ƒ /api/opd-triage/signal-health                      600 B         104 kB
├ ƒ /api/opd-triage/suppressions                       600 B         104 kB
├ ƒ /api/pathway/enrich                                600 B         104 kB
├ ƒ /api/pathway/skeleton                              600 B         104 kB
├ ƒ /api/practice/next                                 600 B         104 kB
├ ƒ /api/readmission/worker                            600 B         104 kB
├ ƒ /api/scoring-policy                                600 B         104 kB
├ ƒ /api/scoring-policy/draft                          600 B         104 kB
├ ƒ /api/scoring-policy/lab-packages/export            600 B         104 kB
├ ƒ /api/scoring-policy/lab-packages/import            600 B         104 kB
├ ƒ /api/scoring-policy/preview                        600 B         104 kB
├ ƒ /api/scoring-policy/publish                        600 B         104 kB
├ ƒ /api/search                                        600 B         104 kB
├ ƒ /api/topics                                        600 B         104 kB
├ ƒ /api/v1/patient-summary                            600 B         104 kB
├ ƒ /api/v1/patient-summary/[jobId]                    600 B         104 kB
├ ƒ /appropriateness                                 17.6 kB         266 kB
├ ƒ /ask                                             6.24 kB         179 kB
├ ƒ /ask/trace/[trace_id]                            1.63 kB         108 kB
├ ƒ /audit                                           9.26 kB         112 kB
├ ƒ /audit/login                                       985 B         104 kB
├ ƒ /audit/queries                                     600 B         104 kB
├ ƒ /browse                                            205 B         107 kB
├ ƒ /calculators                                     1.57 kB         108 kB
├ ƒ /calculators/abcd2                               2.57 kB         113 kB
├ ƒ /calculators/abg                                 4.99 kB         112 kB
├ ƒ /calculators/alvarado                            2.41 kB         113 kB
├ ƒ /calculators/curb65                              2.05 kB         112 kB
├ ƒ /calculators/egfr                                2.94 kB         113 kB
├ ƒ /calculators/heart                                  3 kB         113 kB
├ ƒ /calculators/hyponatremia                        5.68 kB         112 kB
├ ƒ /calculators/news2                               3.85 kB         114 kB
├ ƒ /calculators/nihss                               4.27 kB         115 kB
├ ƒ /calculators/qtc                                  2.6 kB         113 kB
├ ƒ /calculators/sepsis-bundle                        4.9 kB         111 kB
├ ƒ /calculators/sofa                                3.55 kB         114 kB
├ ƒ /calculators/timi                                2.19 kB         112 kB
├ ƒ /calculators/wells_dvt                           2.46 kB         113 kB
├ ƒ /calculators/wells_pe                            2.39 kB         113 kB
├ ƒ /care                                              178 B         107 kB
├ ƒ /care/[uid]                                      12.5 kB         124 kB
├ ƒ /care/briefs                                     2.82 kB         109 kB
├ ƒ /care/concepts                                   4.48 kB         239 kB
├ ƒ /care/login                                        982 B         104 kB
├ ƒ /care/lvc                                           6 kB         241 kB
├ ƒ /care/m/[uid]                                    25.3 kB         137 kB
├ ƒ /care/readmissions                               5.21 kB         112 kB
├ ƒ /care/review                                     9.91 kB         113 kB
├ ƒ /care/triage                                     11.2 kB         114 kB
├ ƒ /care/triage/health                              4.65 kB         108 kB
├ ƒ /coach                                           5.91 kB         171 kB
├ ƒ /concordance                                     4.43 kB         108 kB
├ ƒ /ddx                                             9.37 kB         182 kB
├ ƒ /drugs                                           8.86 kB         119 kB
├ ƒ /knowledge                                       3.29 kB         110 kB
├ ƒ /learn                                             205 B         107 kB
├ ƒ /practice                                        3.08 kB         106 kB
├ ƒ /review                                          4.75 kB         108 kB
├ ƒ /search                                            600 B         104 kB
└ ƒ /topics                                           3.4 kB         107 kB
+ First Load JS shared by all                         103 kB
  ├ chunks/3636-b8d66f842f910767.js                    46 kB
  ├ chunks/4bd1b696-100b9d70ed4e49c1.js              54.2 kB
  └ other shared chunks (total)                      2.95 kB


ƒ Middleware                                         34.5 kB

ƒ  (Dynamic)  server-rendered on demand

--- end output ---
EXIT: 0
ENDED: 2026-08-17T03:29:09Z
```

### git status after the whole gate

```text
COMMAND: git status --porcelain
COMMAND: git status --porcelain --ignored
!! .env.local
!! .next/
!! .vercel/
!! CDMSS-RERANK-TELEMETRY-ADDENDUM-v18-16-AUG-2026.md
!! CDMSS-SAUL-REVIEW-29-16-AUG-2026.md
!! next-env.d.ts
!! node_modules/
!! tsconfig.tsbuildinfo
```

### Gate command log (labels and exit statuses, in execution order)

```text
GATE START 2026-08-17T03:27:33Z at commit fe59b07657d50553f9d535e989b42b92032cf604
cmd-1-npm-test exit=0
cmd-2-typecheck exit=0
cmd-3-build-keyed exit=0
cmd-4-architecture-check exit=0
cmd-5-architecture-map exit=0
cmd-6-precondition-1 exit=0
cmd-6-precondition-2 exit=0
cmd-6-line-1-map exit=0
cmd-6-line-2-cp exit=0
cmd-6-line-3-map exit=0
cmd-6-line-4-cmp exit=0
cmd-6-line-5-gitdiff exit=0
cmd-7-registry exit=0
cmd-7-aux-gitdiff exit=0
cmd-8-reasoning-governance exit=0
cmd-9-changelog-coverage exit=0
build-pair-1-refusal exit=1 (nonzero expected)
build-pair-2-keyed exit=0
GATE END 2026-08-17T03:29:09Z
```

## Part 3 — evidence integrity

The four earlier evidence files, hashed at this pass (the first three must
match the kickoff's pinned values; the fourth is computed and recorded):

```text
f8dc6861ad8a23bd66c66eacbb18b532e744ac6096b05d23f14bf96f00de4ed5  CDMSS-GATE-EVIDENCE-15-AUG-2026.md
a90446922c1631e966771dfe2ccdd327efda4d4775390a14d494e262db94a409  CDMSS-GATE-EVIDENCE-PASS-1-CORRECTED-15-AUG-2026.md
065be6a1af1232a34de56f2b26da3aaec8a3e6e1bded0db84fb267624a0e63a3  CDMSS-GATE-EVIDENCE-V14-DETERMINISM-16-AUG-2026.md
db0df1afa205535422220d250895b0d0202d0f52ed1f28858b147abb357f9e15  CDMSS-GATE-EVIDENCE-PASS-2-16-AUG-2026.md
```

All three pinned digests match. The pass 2 evidence file and pass 2 report were
not edited in this pass.
