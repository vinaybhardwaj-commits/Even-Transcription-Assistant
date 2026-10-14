/**
 * The paired-audit fence must refuse every production writer before SQL, including after
 * exitLabExecution — that is the door the repair adapter uses to call saveOpdAudit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enterOpdLabWriteFence, OpdLabWriteForbidden } from '../opd-lab-write-guard';
import { exitLabExecution } from '../lab-execution-context';
import { alignOpdAuditNoteDate, deleteOpdAuditsForUid, saveOpdAudit, updateOpdAudit } from '../opd-audit-store';
import { persistLongitudinal, replayLongitudinal, runLongitudinalPass } from '../opd-longitudinal';
import { ensureOpdTriageTable, insertDecision, insertQueueDisposition } from '../opd-triage-store';
import { ensureSuppressionTable } from '../audit-suppression-store';
import { isProductionReadSql, setSqlSpy, sql } from '../db';
import {
  applyDoctorResponse, applySignalAction, claimDoctorResponseRequest, completeDoctorResponseRequest,
  ensureDoctorResponseRequestsTable, ensureGovSignalTables, mintOrUpdateSignal, releaseDoctorResponseRequest,
  withdrawSignal,
} from '../opd-gov-signal-store';
import { ensureDoctorMetricsTables, upsertOperationalMetrics, upsertRoster } from '../doctor-metrics-store';
import { refreshDoctorMetrics } from '../doctor-metrics-refresh';
import { saveMemberLink } from '../record-audit-link-store';

async function forbidden(fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (e: Error) => {
    assert.ok(e instanceof OpdLabWriteForbidden, `expected OpdLabWriteForbidden, got ${e?.name}: ${e?.message}`);
    assert.equal((e as OpdLabWriteForbidden).code, 'OPD_LAB_WRITE_FORBIDDEN');
    return true;
  });
}

test('override/lab mode throws before any production audit writer runs', async () => {
  await enterOpdLabWriteFence(async () => {
    await forbidden(() => saveOpdAudit(undefined as never));
    await forbidden(() => updateOpdAudit(undefined as never));
    await forbidden(() => alignOpdAuditNoteDate('noteUid1', '2026-10-07T12:00:00+05:30'));
    await forbidden(() => persistLongitudinal('uid', 'engine', undefined as never));
    await forbidden(() => runLongitudinalPass(undefined as never));
    await forbidden(() => replayLongitudinal(undefined as never));
    await forbidden(() => insertDecision(undefined as never));
    await forbidden(() => insertQueueDisposition(undefined as never));
    await forbidden(() => mintOrUpdateSignal(undefined as never));
    await forbidden(() => withdrawSignal('d', 's', null, null, null));
    await forbidden(() => applyDoctorResponse(undefined as never, undefined as never));
    await forbidden(() => applySignalAction(undefined as never, undefined as never));
    await forbidden(() => claimDoctorResponseRequest(undefined as never, undefined as never));
    await forbidden(() => completeDoctorResponseRequest(undefined as never, undefined as never, undefined as never));
    await forbidden(() => releaseDoctorResponseRequest(undefined as never, undefined as never));
    await forbidden(() => ensureGovSignalTables());
    await forbidden(() => ensureDoctorResponseRequestsTable());
    await forbidden(() => ensureDoctorMetricsTables());
    await forbidden(() => upsertOperationalMetrics([]));
    await forbidden(() => upsertRoster([]));
    await forbidden(() => refreshDoctorMetrics());
    await forbidden(() => saveMemberLink('run', { uhid: 'x' }));
  });
});

test('leaving the lab IO fence does not open the production writers', async () => {
  await enterOpdLabWriteFence(async () => {
    await exitLabExecution(() => forbidden(() => saveOpdAudit(undefined as never)));
  });
});

test('outside the fence a bad call is an ordinary failure, not the lab refusal', async () => {
  await assert.rejects(
    () => saveOpdAudit(undefined as never),
    (e: Error) => !(e instanceof OpdLabWriteForbidden),
  );
});

test('a read statement is a read, and a write is not', () => {
  assert.equal(isProductionReadSql('SELECT id FROM audit_suppression WHERE active = true'), true);
  assert.equal(isProductionReadSql('WITH c AS (SELECT 1) SELECT * FROM c'), true);
  assert.equal(isProductionReadSql("SELECT id FROM t FOR UPDATE"), true);
  assert.equal(isProductionReadSql('DELETE FROM opd_note_audits WHERE uid = $1'), false);
  assert.equal(isProductionReadSql('WITH picked AS (SELECT id FROM t) UPDATE t SET a = 1'), false);
  assert.equal(isProductionReadSql('INSERT INTO triage_stamp_events (id) VALUES ($1)'), false);
  assert.equal(isProductionReadSql('CREATE TABLE IF NOT EXISTS opd_audit_triage (id uuid)'), false);
});

test('production sql refuses a write while the fence is active and does not execute it', async () => {
  const seen: { sql: string; executed: boolean }[] = [];
  setSqlSpy((statement, executed) => { seen.push({ sql: statement, executed }); });
  try {
    await enterOpdLabWriteFence(async () => {
      await forbidden(async () => { await sql('DELETE FROM opd_note_audits WHERE uid = $1', ['uid123']); });
      await forbidden(() => deleteOpdAuditsForUid('uid123'));
      await forbidden(() => ensureOpdTriageTable());
      await forbidden(() => ensureSuppressionTable());
    });
    assert.equal(seen.some((row) => row.executed), false);
    assert.ok(seen.some((row) => /delete/i.test(row.sql) && row.executed === false));
    assert.ok(seen.some((row) => /create/i.test(row.sql) && row.executed === false));
  } finally {
    setSqlSpy(null);
  }
});
