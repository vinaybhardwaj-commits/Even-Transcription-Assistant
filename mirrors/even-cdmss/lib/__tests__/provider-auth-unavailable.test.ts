/**
 * AWS auth denials are not transport errors.
 *
 * Since 16 Sep every Bedrock call fails at STS with "Not authorized to perform
 * sts:AssumeRoleWithWebIdentity". The AWS SDK puts the HTTP status on
 * `$metadata.httpStatusCode`, not `status`, so the shared retry loop treated the
 * 403 as a status-less transport failure and spent the whole budget on it. The
 * IPD episode worker then recorded `diff_failed`, which counts against the
 * 14-day retry window.
 *
 *   node --test --import tsx lib/__tests__/provider-auth-unavailable.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createWithRetry, isProviderAuthFailure, providerHttpStatus } from '../openrouter-retry';
import { ProviderAuthUnavailable, isProviderAuthUnavailable, providerAuthUnavailableFrom } from '../bedrock';
import { computeEpisodeAudit, type EpisodeComputeDependencies } from '../ipd-episode/compute';
import { runEpisodeBatch } from '../ipd-episode/run';
import type { AssembledEpisode } from '../ipd-episode/assemble';

const noSleep = async () => {};
const GOOD = { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] };

function awsError(name: string, message: string, httpStatusCode?: number): Error {
  const err = new Error(message);
  err.name = name;
  if (httpStatusCode != null) Object.assign(err, { $metadata: { httpStatusCode, requestId: 'req-1' } });
  return err;
}

const STS_DENIED = awsError(
  'AccessDeniedException',
  'User: arn:aws:sts::000:assumed-role/web is not authorized to perform: sts:AssumeRoleWithWebIdentity on resource: arn:aws:iam::000:role/bedrock',
  403,
);

test('an AWS SDK error exposes its status on $metadata.httpStatusCode, not status', () => {
  assert.equal(providerHttpStatus(STS_DENIED), 403);
  assert.equal(providerHttpStatus(Object.assign(new Error('nope'), { status: 401 })), 401);
  assert.equal(providerHttpStatus(new Error('socket hang up')), null);
  assert.equal(isProviderAuthFailure(STS_DENIED), true);
  assert.equal(isProviderAuthFailure(awsError('AccessDenied', 'Access Denied')), true);
  assert.equal(isProviderAuthFailure(awsError('ExpiredToken', 'The security token included in the request is expired')), true);
  assert.equal(isProviderAuthFailure(awsError('InvalidIdentityToken', 'Invalid identity token')), true);
  assert.equal(isProviderAuthFailure(awsError('ExpiredTokenException', 'expired')), true);
  assert.equal(isProviderAuthFailure(new Error('Not authorized to perform sts:AssumeRoleWithWebIdentity')), true);
  assert.equal(isProviderAuthFailure(Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 401 } })), true);
  assert.equal(isProviderAuthFailure(new Error('socket hang up')), false);
  assert.equal(isProviderAuthFailure(Object.assign(new Error('overloaded'), { $metadata: { httpStatusCode: 503 } })), false);
  // The SDK sometimes wraps the denial. The cause is the thing that must not be retried.
  const wrapped = new Error('Could not load credentials');
  (wrapped as { cause?: unknown }).cause = STS_DENIED;
  assert.equal(isProviderAuthFailure(wrapped), true);
});

test('the AWS-shaped AccessDenied is not retried — one attempt, then the same error', async () => {
  let calls = 0;
  const failures: Array<{ kind: string; status: number | null; willRetry: boolean }> = [];
  await assert.rejects(
    () => createWithRetry(async () => { calls++; throw STS_DENIED; }, {
      provider: 'bedrock', maxTries: 3, sleepFn: noSleep,
      onAttemptFailure: (f) => failures.push({ kind: f.kind, status: f.status, willRetry: f.willRetry }),
    }),
    (e: unknown) => e === STS_DENIED,
  );
  assert.equal(calls, 1, 'a 403 assumption denial must not spend the rest of the budget');
  assert.deepEqual(failures, [{ kind: 'http', status: 403, willRetry: false }]);
});

test('a named auth error with no HTTP status, and a typed ProviderAuthUnavailable, are both one attempt', async () => {
  for (const err of [
    awsError('InvalidIdentityToken', 'token rejected'),
    new ProviderAuthUnavailable('bedrock: provider auth unavailable', 403),
    new Error('Not authorized to perform: sts:AssumeRoleWithWebIdentity'),
  ]) {
    let calls = 0;
    await assert.rejects(
      () => createWithRetry(async () => { calls++; throw err; }, { provider: 'bedrock', maxTries: 3, sleepFn: noSleep }),
      (e: unknown) => e === err,
    );
    assert.equal(calls, 1, (err as Error).name || (err as Error).message);
  }
});

test('a 503 on $metadata is still retried, and a status-less transport error is still retried', async () => {
  let calls = 0;
  const overloaded = Object.assign(new Error('slow down'), { $metadata: { httpStatusCode: 503 } });
  await assert.rejects(
    () => createWithRetry(async () => { calls++; throw overloaded; }, { provider: 'bedrock', maxTries: 3, sleepFn: noSleep }),
  );
  assert.equal(calls, 3);

  calls = 0;
  const res = await createWithRetry(async () => {
    calls++;
    if (calls === 1) throw new Error('socket hang up');
    return GOOD;
  }, { provider: 'bedrock', sleepFn: noSleep });
  assert.equal(calls, 2);
  assert.deepEqual(res, GOOD);
});

test('bedrock turns the AWS shape into ProviderAuthUnavailable and does not wrap it twice', () => {
  const typed = providerAuthUnavailableFrom(STS_DENIED);
  assert.ok(typed instanceof ProviderAuthUnavailable);
  assert.equal(isProviderAuthUnavailable(typed), true);
  assert.equal(typed?.httpStatus, 403);
  assert.match(typed?.message ?? '', /not authorized to perform: sts:AssumeRoleWithWebIdentity/);
  assert.equal(providerAuthUnavailableFrom(typed), typed);
  assert.equal(providerAuthUnavailableFrom(new Error('socket hang up')), null);

  const src = readFileSync('lib/bedrock.ts', 'utf8');
  const sts = src.slice(src.indexOf('export async function bedrockCredentials'), src.indexOf('export function __resetBedrockCredentialCache'));
  const converse = src.slice(src.indexOf('export async function bedrockConverse'), src.indexOf('export function bedrockErrorPayload'));
  const generate = src.slice(src.indexOf('export async function bedrockGenerate'));
  for (const [name, body] of [['credentials', sts], ['converse', converse], ['generate', generate]] as const) {
    assert.ok(body.includes('providerAuthUnavailableFrom('), `${name} classifies the AWS failure`);
  }
});

function episodeFixture(): AssembledEpisode {
  return {
    envelope: {
      encounterId: 'EP-1', memberId: null, facilityName: null, speciality: null,
      admittedAt: '2026-09-01T00:00:00.000Z', dischargedAt: '2026-09-03T00:00:00.000Z',
      losDays: 2, dischargeType: null, treatingDepartmentName: null, admissionType: null,
      admitSource: null, remarks: null, responsibleClinicianId: null,
    },
    events: [],
    sourcesPresent: [],
    notes: [],
  };
}

function deps(checkpoint: EpisodeComputeDependencies['checkpoint'], rows: Map<string, { reason: string; attempts: number }>): EpisodeComputeDependencies {
  return {
    fetchDischargeSummary: async () => ({ discharge_date_time: '2026-09-03T00:00:00.000Z' }),
    fetchProgressNotes: async () => [{ _doc_id: 'n1' }],
    fetchExtractionByIpUid: async () => ({ extractionVersion: 'doc-extract/2', extractedJson: {}, memberId: null, extractedAt: null }),
    assembleEpisode: async () => episodeFixture(),
    recordSkip: async (a) => {
      const prev = rows.get(a.encounterId);
      rows.set(a.encounterId, { reason: a.reason, attempts: (prev?.attempts ?? 0) + 1 });
      return 'recorded';
    },
    clearSkip: async (id) => { rows.delete(id); },
    saveEpisodeAudit: async () => { throw new Error('auth failure must not write an audit row'); },
    checkpoint,
  };
}

test('an auth failure leaves no skip row — the in_progress marker is cleared and diff_failed is not written', async () => {
  const rows = new Map<string, { reason: string; attempts: number }>();
  const result = await computeEpisodeAudit(
    deps(async () => { throw new ProviderAuthUnavailable('bedrock: provider auth unavailable (HTTP 403): not authorized', 403); }, rows),
    { encounterId: 'EP-1', dischargedAtHint: '2026-09-03T00:00:00.000Z' },
  );
  assert.equal(result.authUnavailable, true);
  assert.equal(result.skip, undefined, 'no skip reason is returned');
  assert.equal(rows.size, 0, 'the in_progress row is cleared, so the 14-day window is not consumed');

  // A genuine fault still keeps the marker. That is how a dead invocation stays visible.
  const kept = new Map<string, { reason: string; attempts: number }>();
  const fault = await computeEpisodeAudit(
    deps(async () => { throw new Error('metabase unreachable'); }, kept),
    { encounterId: 'EP-1' },
  );
  assert.equal(fault.authUnavailable, undefined);
  assert.equal(kept.get('EP-1')?.reason, 'in_progress');
});

test('the batch stops on auth and does not examine the rest of the queue', async () => {
  const seen: string[] = [];
  const { results, tally } = await runEpisodeBatch(
    ['e1', 'e2', 'e3'].map((encounterId) => ({ encounterId, dischargedAt: '2026-09-01T00:00:00.000Z' })),
    5,
    async (input) => {
      seen.push(input.encounterId);
      if (input.encounterId === 'e1') {
        return { encounterId: 'e1', authUnavailable: true, error: 'provider auth unavailable', latencyMs: 1 };
      }
      return { encounterId: input.encounterId, status: 'inserted' as const, latencyMs: 1 };
    },
  );
  assert.deepEqual(seen, ['e1']);
  assert.equal(results.length, 1);
  assert.equal(tally.authUnavailable, true);
  assert.equal(tally.skipped, 0, 'an auth stop is not a skip');
  assert.equal(tally.audited, 0);
  assert.equal(tally.exhausted, false, 'the queue is not caught up');
});

test('the worker writes one auth trace event and resets the gate; the model call rethrows', () => {
  const worker = readFileSync('app/api/ipd-episode/worker/route.ts', 'utf8');
  const model = readFileSync('lib/ipd-episode/model-call.ts', 'utf8');
  const compute = readFileSync('lib/ipd-episode/compute.ts', 'utf8');
  assert.match(worker, /resetEpisodeAuthGate\(\)/);
  assert.equal(
    (worker.match(/logEvent\(tid, 'provider_auth_unavailable'/g) ?? []).length,
    1,
    'one trace event for the tick, not one per checkpoint',
  );
  assert.match(model, /if \(isProviderAuthUnavailable\(e\)\) \{[\s\S]*?throw e;/);
  const tail = compute.slice(compute.lastIndexOf('} catch (e) {'));
  assert.match(tail, /if \(authDown\) await clearSkip\(encounterId, engineVersion\)/);
  assert.ok(!tail.includes("reason: 'diff_failed'"), 'the auth catch must not record diff_failed');
});
