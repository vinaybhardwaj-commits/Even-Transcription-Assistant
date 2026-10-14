/**
 * lib/__tests__/triage-queue-read.test.ts
 *
 *   node --test --import tsx lib/__tests__/triage-queue-read.test.ts
 *
 * The admin door and the UI Action queue share lib/triage/queue-read.ts. Informational drop is
 * still buildQueue — this file pins the shared seam, query parse, and admin gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildQueue, type TriageFinding } from '../opd-triage-core.ts';
import {
  flattenActionQueueItems,
  parseActionQueueQuery,
} from '../triage/queue-read.ts';
import { actionQueueItemRef } from '../triage/shadow-schema.ts';

const UI_ROUTE = readFileSync('app/api/opd-triage/queue/route.ts', 'utf8');
const ADMIN_ROUTE = readFileSync('app/api/admin/triage/queue/route.ts', 'utf8');
const QUEUE_READ = readFileSync('lib/triage/queue-read.ts', 'utf8');

test('UI and admin queue routes are thin delegates of the same reader', () => {
  assert.match(UI_ROUTE, /from '@\/lib\/triage\/queue-read'/);
  assert.match(ADMIN_ROUTE, /from '@\/lib\/triage\/queue-read'/);
  assert.match(UI_ROUTE, /readActionQueue\(parseActionQueueQuery/);
  assert.match(ADMIN_ROUTE, /readActionQueue\(query\)/);
  assert.ok(!/buildQueue\(/.test(UI_ROUTE), 'UI route must not rebuild the queue locally');
  assert.ok(!/buildQueue\(/.test(ADMIN_ROUTE), 'admin route must not rebuild the queue locally');
});

test('queue-read is the UI Action queue: canonical audits + informational drop via buildQueue', () => {
  assert.match(QUEUE_READ, /excluded_reason IS NULL/);
  assert.match(QUEUE_READ, /buildQueue\(findings, decisions/);
  assert.match(QUEUE_READ, /canonicalDistinctOnSql/);
  assert.match(QUEUE_READ, /stampFindingIdentity/);
  assert.ok(!/insertDecision|mintOrUpdateSignal|opd_gov_signal/.test(QUEUE_READ));
});

test('admin queue is admin-gated (session OR ADMIN_TOKEN), not the care cookie', () => {
  assert.match(ADMIN_ROUTE, /requireAdmin\(req\)/);
  assert.match(ADMIN_ROUTE, /isAdminUnlocked\(\)/);
  assert.ok(!/isCareUnlocked/.test(ADMIN_ROUTE));
  assert.match(ADMIN_ROUTE, /export async function GET/);
  assert.match(ADMIN_ROUTE, /export async function POST/);
});

test('parseActionQueueQuery: UI defaults (untriaged, 1 day, quieted off) and clamps', () => {
  assert.deepEqual(parseActionQueueQuery({}), {
    day: '', days: 1, doctor_uid: '', status: 'untriaged', includeQuieted: false,
  });
  const sp = new URLSearchParams('status=all&days=99&doctor_uid=docA&quieted=1&day=2026-09-15');
  assert.deepEqual(parseActionQueueQuery(sp), {
    day: '2026-09-15', days: 7, doctor_uid: 'docA', status: 'all', includeQuieted: true,
  });
  assert.equal(parseActionQueueQuery({ quieted: true, status: 'all' }).includeQuieted, true);
  assert.equal(parseActionQueueQuery({ days: 0 }).days, 1);
});

test('flattenActionQueueItems uses the CM card key after informational drop', () => {
  const findings: TriageFinding[] = [
    {
      audit_id: 'a1', doctor_uid: 'docA', note_date: '2026-09-15',
      subject: 'Interaction (major): A + B', rationale: 'r', verdict: 'low-value',
      domain: 'prescribing_safety', signal_type: 'drug_interaction', finding_ref: 'r1',
    },
    {
      audit_id: 'a2', doctor_uid: 'docA', note_date: '2026-09-15',
      subject: 'High-alert medication: Insulin', rationale: 'r', verdict: 'low-value',
      domain: 'prescribing_safety', signal_type: 'high_alert_medication', finding_ref: 'r2',
      informational: true,
    },
  ];
  const { doctors } = buildQueue(findings, []);
  const items = flattenActionQueueItems(doctors);
  assert.equal(items.length, 1);
  assert.equal(items[0].queue_item_ref, actionQueueItemRef('docA', 'drug_interaction'));
  assert.equal(items[0].signal_type, 'drug_interaction');
  assert.ok(!items.some((i) => i.signal_type === 'high_alert_medication'));
});
