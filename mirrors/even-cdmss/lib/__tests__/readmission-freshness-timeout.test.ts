/**
 *   node --test --import tsx lib/__tests__/readmission-freshness-timeout.test.ts
 * READMIT-OBSERVABILITY — the board's health read is bounded; a hang or fault leaves health absent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout, FRESHNESS_HEALTH_TIMEOUT_MS } from '../readmission/freshness';

test('constant is 4 s', () => assert.equal(FRESHNESS_HEALTH_TIMEOUT_MS, 4000));
test('value passes through', async () => assert.equal(await withTimeout(Promise.resolve(7), 50), 7));
test('hang resolves null at the timer', async () => assert.equal(await withTimeout(new Promise<number>(() => {}), 20), null));
test('rejection resolves null', async () => assert.equal(await withTimeout(Promise.reject(new Error('x')), 50), null));
