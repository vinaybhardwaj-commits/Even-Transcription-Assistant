#!/usr/bin/env node
// Unit tests for eta-bus-mcp, against a temp SQLite DB and mocked herdr
// calls (no real herdr session required). Run: node test/unit.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../lib/db.mjs';
import { resolveIdentity, _resetIdentityCacheForTests } from '../lib/identity.mjs';
import {
  _setAgentListOverrideForTests,
  _setRunHerdrCtlOverrideForTests,
} from '../lib/herdrctl.mjs';
import {
  busPost,
  busInbox,
  busAck,
  busThread,
  herdrSendTool,
  herdrRestartTool,
} from '../lib/tools.mjs';

let pass = 0;
let fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eta-bus-test-'));
  return path.join(dir, 'bus.db');
}

function fakeAgents({ withBlocked = false, withWorking = false } = {}) {
  const agents = [
    { name: 'bt-a', pane_id: 'w1:p1', agent_status: 'idle' },
    { name: 'bt-b', pane_id: 'w2:p1', agent_status: 'idle' },
    { name: 'fable', pane_id: 'w3:p1', agent_status: 'idle' },
  ];
  if (withBlocked) agents.find((a) => a.name === 'bt-b').agent_status = 'blocked';
  if (withWorking) agents.find((a) => a.name === 'bt-b').agent_status = 'working';
  return agents;
}

let sentPrompts = [];
function installHerdrMocks(agents) {
  _setAgentListOverrideForTests(async () => agents);
  sentPrompts = [];
  _setRunHerdrCtlOverrideForTests(async (subArgs) => {
    sentPrompts.push(subArgs);
    if (subArgs[0] === 'send') return { code: 0, stdout: '{"type":"ok"}', stderr: '' };
    if (subArgs[0] === 'restart') return { code: 0, stdout: 'restart OK', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
}

// ---------- identity resolution ----------

await test('identity: ETA_BUS_AS wins', async () => {
  _resetIdentityCacheForTests();
  delete process.env.HERDR_PANE_ID;
  process.env.ETA_BUS_AS = 'fable';
  const id = await resolveIdentity();
  assert.equal(id, 'fable');
  delete process.env.ETA_BUS_AS;
});

await test('identity: HERDR_PANE_ID resolves via agent list', async () => {
  _resetIdentityCacheForTests();
  installHerdrMocks(fakeAgents());
  process.env.HERDR_PANE_ID = 'w2:p1';
  const id = await resolveIdentity();
  assert.equal(id, 'bt-b');
  delete process.env.HERDR_PANE_ID;
});

await test('identity: no env at all -> unknown', async () => {
  _resetIdentityCacheForTests();
  delete process.env.ETA_BUS_AS;
  delete process.env.HERDR_PANE_ID;
  const id = await resolveIdentity();
  assert.equal(id, 'unknown');
});

await test('identity: unmatched pane id -> unknown', async () => {
  _resetIdentityCacheForTests();
  installHerdrMocks(fakeAgents());
  process.env.HERDR_PANE_ID = 'w9:p9';
  const id = await resolveIdentity();
  assert.equal(id, 'unknown');
  delete process.env.HERDR_PANE_ID;
});

// ---------- bus post / inbox / ack / thread ----------

await test('bus_post + bus_inbox: basic delivery and read marking', async () => {
  const db = openDb(tempDbPath());
  installHerdrMocks(fakeAgents());
  const ctxA = { identity: 'bt-a', db };
  const ctxB = { identity: 'bt-b', db };

  const posted = await busPost(
    { to: ['bt-b'], subject: 'hello', body: 'world', wake: false },
    ctxA
  );
  assert.equal(posted.per_recipient['bt-b'], 'stored');

  const inbox1 = await busInbox({ unread_only: true }, ctxB);
  assert.equal(inbox1.messages.length, 1);
  assert.equal(inbox1.messages[0].subject, 'hello');

  const inbox2 = await busInbox({ unread_only: true }, ctxB);
  assert.equal(inbox2.messages.length, 0, 'second read should see no unread left');
});

await test('bus_ack: acks known ids, reports unknown ones', async () => {
  const db = openDb(tempDbPath());
  installHerdrMocks(fakeAgents());
  const ctxA = { identity: 'bt-a', db };
  const ctxB = { identity: 'bt-b', db };
  const posted = await busPost({ to: ['bt-b'], subject: 's', body: 'b', wake: false }, ctxA);
  const res = await busAck({ ids: [posted.id, 999999] }, ctxB);
  assert.deepEqual(res.acked, [posted.id]);
  assert.deepEqual(res.not_found, [999999]);
});

await test('bus_thread: returns full thread oldest-first', async () => {
  const db = openDb(tempDbPath());
  installHerdrMocks(fakeAgents());
  const ctxA = { identity: 'bt-a', db };
  const m1 = await busPost(
    { to: ['bt-b'], subject: 'first', body: 'one', thread_id: 't1', wake: false },
    ctxA
  );
  await new Promise((r) => setTimeout(r, 2));
  await busPost(
    { to: ['bt-a'], subject: 'reply', body: 'two', thread_id: 't1', reply_to: m1.id, wake: false },
    { identity: 'bt-b', db }
  );
  const thread = await busThread({ thread_id: 't1' }, ctxA);
  assert.equal(thread.messages.length, 2);
  assert.equal(thread.messages[0].subject, 'first');
  assert.equal(thread.messages[1].subject, 'reply');
});

await test('bus_post: "all" expands to every live agent except sender', async () => {
  const db = openDb(tempDbPath());
  installHerdrMocks(fakeAgents());
  const ctxA = { identity: 'bt-a', db };
  const res = await busPost({ to: ['all'], subject: 's', body: 'b', wake: false }, ctxA);
  const names = Object.keys(res.per_recipient).sort();
  assert.deepEqual(names, ['bt-b', 'fable']);
});

await test('bus_post: refuses body that looks like a secret', async () => {
  const db = openDb(tempDbPath());
  installHerdrMocks(fakeAgents());
  const ctxA = { identity: 'bt-a', db };
  await assert.rejects(
    () => busPost({ to: ['bt-b'], subject: 's', body: 'key=sk-EXAMPLE-NOT-REAL-TOKEN-0000', wake: false }, ctxA),
    /secret/
  );
  await assert.rejects(
    () =>
      busPost(
        { to: ['bt-b'], subject: 's', body: 'Authorization: Bearer EXAMPLE-NOT-REAL-TOKEN', wake: false },
        ctxA
      ),
    /secret/
  );
  await assert.rejects(
    () => busPost({ to: ['bt-b'], subject: 's', body: '-----BEGIN RSA PRIVATE KEY (EXAMPLE)-----', wake: false }, ctxA),
    /secret/
  );
});

await test('bus_post: unidentified caller is refused', async () => {
  const db = openDb(tempDbPath());
  installHerdrMocks(fakeAgents());
  await assert.rejects(
    () => busPost({ to: ['bt-b'], subject: 's', body: 'b' }, { identity: 'unknown', db }),
    /identity/
  );
});

await test('bus_post: nudges an idle recipient and sends via herdr-ctl send', async () => {
  const db = openDb(tempDbPath());
  installHerdrMocks(fakeAgents());
  const ctxA = { identity: 'bt-a', db };
  const res = await busPost({ to: ['bt-b'], subject: 's', body: 'b' }, ctxA);
  assert.equal(res.per_recipient['bt-b'], 'nudged');
  assert.equal(sentPrompts.length, 1);
  assert.equal(sentPrompts[0][0], 'send');
  assert.equal(sentPrompts[0][1], 'bt-b');
  assert.match(sentPrompts[0][2], /\[bus\] You have \d+ unread message/);
});

await test('bus_post: does not nudge a blocked recipient', async () => {
  const db = openDb(tempDbPath());
  installHerdrMocks(fakeAgents({ withBlocked: true }));
  const ctxA = { identity: 'bt-a', db };
  const res = await busPost({ to: ['bt-b'], subject: 's', body: 'b' }, ctxA);
  assert.equal(res.per_recipient['bt-b'], 'not_nudged_blocked');
  assert.equal(sentPrompts.length, 0);
});

await test('bus_post: does not nudge a working recipient', async () => {
  const db = openDb(tempDbPath());
  installHerdrMocks(fakeAgents({ withWorking: true }));
  const ctxA = { identity: 'bt-a', db };
  const res = await busPost({ to: ['bt-b'], subject: 's', body: 'b' }, ctxA);
  assert.equal(res.per_recipient['bt-b'], 'not_nudged_working');
  assert.equal(sentPrompts.length, 0);
});

await test('bus_post: unknown recipient name is reported, not nudged', async () => {
  const db = openDb(tempDbPath());
  installHerdrMocks(fakeAgents());
  const ctxA = { identity: 'bt-a', db };
  const res = await busPost({ to: ['ghost'], subject: 's', body: 'b' }, ctxA);
  assert.equal(res.per_recipient['ghost'], 'unknown_agent');
  assert.equal(sentPrompts.length, 0);
});

await test('bus_post: nudge rate-limited to one per 120s per recipient', async () => {
  const db = openDb(tempDbPath());
  installHerdrMocks(fakeAgents());
  const ctxA = { identity: 'bt-a', db };
  const r1 = await busPost({ to: ['bt-b'], subject: 's1', body: 'b1' }, ctxA);
  assert.equal(r1.per_recipient['bt-b'], 'nudged');
  const r2 = await busPost({ to: ['bt-b'], subject: 's2', body: 'b2' }, ctxA);
  assert.equal(r2.per_recipient['bt-b'], 'stored', 'second nudge within 120s should be suppressed');
  assert.equal(sentPrompts.length, 1, 'herdr-ctl send should only have been called once');
});

// ---------- orchestrator-only refusal ----------

await test('herdr_send: refuses a non-fable caller', async () => {
  installHerdrMocks(fakeAgents());
  await assert.rejects(
    () => herdrSendTool({ name: 'bt-b', message: 'hi' }, { identity: 'bt-a' }),
    /orchestrator-only/
  );
  assert.equal(sentPrompts.length, 0);
});

await test('herdr_restart: refuses a non-fable caller but allows fable', async () => {
  installHerdrMocks(fakeAgents());
  await assert.rejects(
    () => herdrRestartTool({ name: 'bt-b' }, { identity: 'bt-a' }),
    /orchestrator-only/
  );
  const ok = await herdrRestartTool({ name: 'bt-b', session: 'ctl-test' }, { identity: 'fable' });
  assert.equal(ok.code, 0);
});

// ---------- summary ----------

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
