/**
 * lib/__tests__/reconciler-route-artifact.test.ts — the reconciler route, hashed in a process that
 * has never loaded it.
 *
 * ⚠️ THIS FILE EXISTS SEPARATELY FOR ONE REASON, AND MERGING IT BACK WOULD UNDO ALL OF IT.
 * `reconciler-races.test.ts` imports the route at module scope, which EXECUTES it, and the previous
 * version of this pin then read the file from that same process. The package has no
 * `"type": "module"`, so tsx emits CommonJS and `node:fs` exports are a live object: the artifact
 * being measured ran first and owned the ruler. Five attacks survived at 25 of 25 — a shim that
 * rebuilt the reviewed bytes by truncating its own source at a marker and replaced `readFileSync`
 * for its own path, three variants riding on it (the auth gate removed, the grace turned into a
 * query parameter, every verdict relabelled `reconciled`), and one that replaced `node:test`'s
 * `test` before the cases registered.
 *
 * ⚠️ SO THIS FILE IMPORTS FOUR NODE BUILTINS AND NOTHING ELSE. Nothing from `app/`, nothing from
 * `lib/`, nothing that transitively reaches the route. `node --test` gives every file its own
 * process, so in THIS process the route is never loaded, never executed, and has nothing to patch —
 * no `fs`, no `crypto`, no `test`, no module cache. A reader who tidies this back into
 * `reconciler-races.test.ts` restores all five survivors, and the self-check below is what makes
 * that failure loud rather than silent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ROUTE_FILE = 'app/api/admin/retrieval-telemetry-reconcile/route.ts';
const ROUTE_DIR = 'app/api/admin/retrieval-telemetry-reconcile/';

/**
 * Recorded at `2eeeaac` and unchanged at `ee92c26`. Stored HERE, in the file doing the hashing and
 * not in the file being hashed, and never derived from the tree at run time — a hash computed from
 * the thing it checks is a tautology.
 *
 * ── RE-BASELINE PROCEDURE (addendum v1 item 1b, 13 Aug 2026) ────────────────────────────────────
 * Any legitimate change to the route fails the case below until these baselines are updated. That
 * is the pin working, not a fault in it, and this is the whole procedure:
 *
 *   1. Confirm the route change is intended and reviewed.
 *   2. `sha256sum app/api/admin/retrieval-telemetry-reconcile/route.ts`
 *   3. `git hash-object app/api/admin/retrieval-telemetry-reconcile/route.ts`
 *   4. Replace `ROUTE_SHA256` and `ROUTE_GIT_BLOB` in this file.
 *   5. State in the build report what changed in the route and why.
 */
const ROUTE_SHA256 = '6ecd5b38d276802632294a192b0acb618ee1b05d815fe747890a37a900d4fd56';
const ROUTE_GIT_BLOB = 'ffd77c61ef5489bfa622db07911890de55d304c4';

/**
 * The loaded-module list, READ rather than inferred.
 *
 * tsx compiles this file to CommonJS (the package declares no `"type": "module"`), so `require.cache`
 * is the process's actual record of every module it has evaluated, keyed by absolute path. Asking
 * for it is the only honest way to answer "has the route run in here?" — anything else would be a
 * claim about what the imports at the top of this file are believed to reach.
 */
function loadedModulePaths(): string[] {
  const cache = (require as unknown as { cache?: Record<string, unknown> }).cache;
  assert.ok(cache && typeof cache === 'object', 'require.cache is unavailable — the isolation claim cannot be checked');
  return Object.keys(cache);
}

test('artifact — THE ROUTE HAS NOT RUN IN THIS PROCESS', () => {
  // The property everything below rests on. If a future edit adds an import that reaches the route,
  // directly or transitively, this fails here rather than quietly returning to the old flaw — where
  // the measured file got to run before the ruler was picked up.
  const loaded = loadedModulePaths();
  const offenders = loaded.filter((p) => p.includes(ROUTE_DIR));
  assert.deepEqual(
    offenders, [],
    'the reconciler route is loaded in this process. Whatever imported it can patch node:fs, '
    + 'node:crypto, node:test and the module cache before the assertions below run, and every one of '
    + 'them would then be measuring bytes it was handed rather than bytes on disk.',
  );
  // Not vacuous: the cache is populated, and it does name this file.
  assert.ok(loaded.length > 0, 'require.cache is empty, so the check above proved nothing');
  assert.ok(
    loaded.some((p) => p.endsWith('reconciler-route-artifact.test.ts')),
    'require.cache does not name this file, so it is not the list it claims to be',
  );
});

test('artifact — the reconciler route is byte-for-byte the reviewed file', () => {
  // ⚠️ BEFORE A BYTE IS READ. A symlink to identical content, or a second hard link, hashes the same
  // and is not the same file. `lstat`, not `stat`, so the symlink is seen rather than followed. A
  // deleted or unreadable route throws HERE, in a named case, which is the other thing the split
  // buys.
  //
  // ⚠️ AND NO MODE ASSERTION, DELIBERATELY (addendum v1 item 1, 13 Aug 2026). Git records exactly
  // one permission bit — the executable bit — so a tree entry for a regular file is `100644` or
  // `100755` and the group and other bits are never stored at all. A permission change that leaves
  // the executable bit alone (`chmod 640`, `chmod 664`) therefore changes neither the blob nor the
  // tree entry, and is not a change to the committed object. A change that DOES flip that bit is
  // reported by `git status` on its own, without a test. What used to stand here asserted mode 644,
  // which protected nothing about the artifact and failed on any checkout whose umask differed from
  // the author's.
  const st = lstatSync(ROUTE_FILE);
  assert.equal(st.isSymbolicLink(), false, `${ROUTE_FILE} is a symlink`);
  assert.equal(st.isFile(), true, `${ROUTE_FILE} is not a regular file`);
  assert.equal(st.nlink, 1, `${ROUTE_FILE} has ${st.nlink} hard links`);

  const raw = readFileSync(ROUTE_FILE);
  assert.ok(raw.length > 0, `${ROUTE_FILE} is empty`);
  assert.equal(
    createHash('sha256').update(raw).digest('hex'), ROUTE_SHA256,
    `${ROUTE_FILE} changed. If that was deliberate, update the baselines in this file and say why in `
    + 'the build report; if it was not, this is the assertion that just caught it.',
  );
  // The same bytes under git's own object identity, computed here rather than by shelling out — so
  // the recorded digest and the recorded blob id have to agree with each other and with the file.
  const header = Buffer.from(`blob ${raw.length}\0`, 'utf8');
  assert.equal(
    createHash('sha1').update(Buffer.concat([header, raw])).digest('hex'), ROUTE_GIT_BLOB,
    `${ROUTE_FILE}'s git blob id does not match the recorded one`,
  );
});

test('artifact — what this pin does NOT cover', () => {
  // Stated rather than left to be assumed, as the cron-file pin states it: mtime, uid, gid, ACLs and
  // extended attributes are outside the contract, because git preserves none of them and a test
  // asserting them would fail on a fresh clone. And a hash says the file has not changed — it says
  // nothing about what the file DOES. That is `reconciler-races.test.ts`'s job, and those cases are
  // load-bearing: one route change defeated the hash outright and still failed nine of them.
  const raw = readFileSync(ROUTE_FILE, 'utf8');
  assert.ok(raw.includes('AND row_revision = $2'), 'the compare-and-set predicate is in the reviewed bytes');
  assert.ok(raw.includes('RECONCILER_STALE_AFTER_SECONDS'), 'and the preregistered grace is read, not inlined');
});
