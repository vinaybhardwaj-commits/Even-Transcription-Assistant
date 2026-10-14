/**
 * Auth fail-closed.
 *
 *   node --test --import tsx lib/__tests__/auth-fail-closed.test.ts
 *
 * The medication-audit surface used to render on every host except medaudit.
 * Cron routes used to accept a caller-supplied x-vercel-cron header.
 * requireAdmin used to allow every request when ADMIN_TOKEN was unset.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { auditGateResponse, auditPrincipalFromCookies, PHARMACIST_COOKIE, ADMIN_SESSION_COOKIE } from '../audit-gate.ts';
import { cronAuthorized } from '../cron-auth.ts';
import { requireAdmin } from '../admin-gate.ts';
import { PUBLIC_ROUTES, isPublicPath } from '../public-routes.ts';
import { PHARM_COOKIE } from '../pharmacist-cookie.ts';
import { ADMIN_COOKIE } from '../admin-cookie.ts';
import { middleware } from '../../middleware.ts';

const PHARM = 'pharmacist-token-fixture';
const ADMIN = 'admin-token-fixture';
const CRON = 'cron-secret-fixture';

const saved = {
  PHARMACIST_TOKEN: process.env.PHARMACIST_TOKEN,
  ADMIN_TOKEN: process.env.ADMIN_TOKEN,
  CRON_SECRET: process.env.CRON_SECRET,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function request(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, { headers });
}

test('cookie names used by the edge gate match the session modules', () => {
  assert.equal(PHARMACIST_COOKIE, PHARM_COOKIE);
  assert.equal(ADMIN_SESSION_COOKIE, ADMIN_COOKIE);
});

test('public allowlist names a reason for every entry and does not open /audit', () => {
  assert.ok(PUBLIC_ROUTES.length > 0);
  for (const route of PUBLIC_ROUTES) {
    assert.ok(route.path.startsWith('/'), route.path);
    assert.ok(route.reason.trim().length >= 12, `${route.path} needs a reason`);
  }
  assert.equal(isPublicPath('/audit/login'), true);
  assert.equal(isPublicPath('/api/audit/login'), true);
  assert.equal(isPublicPath('/audit'), false);
  assert.equal(isPublicPath('/audit/queries'), false);
  assert.equal(isPublicPath('/api/audit'), false);
  assert.equal(isPublicPath('/api/opd-audit/worker'), false);
});

test('unauthenticated /audit is denied on cat.evenos.app and medaudit.evenos.app', () => {
  delete process.env.PHARMACIST_TOKEN;
  delete process.env.ADMIN_TOKEN;
  try {
    for (const host of ['cat.evenos.app', 'medaudit.evenos.app']) {
      const page = middleware(request(`https://${host}/audit`, { host }));
      assert.equal(page.status, 307, host);
      assert.equal(new URL(page.headers.get('location') || '', `https://${host}`).pathname, '/audit/login');

      const queries = middleware(request(`https://${host}/audit/queries`, { host }));
      assert.equal(queries.status, 307, host);

      const api = middleware(request(`https://${host}/api/audit`, { host }));
      assert.equal(api.status, 401, host);

      const formulary = auditGateResponse(request(`https://${host}/api/audit/formulary`, { host }));
      assert.equal(formulary?.status, 401);
    }
  } finally { restoreEnv(); }
});

test('login stays reachable on every host, and a principal opens /audit on every host', () => {
  process.env.PHARMACIST_TOKEN = PHARM;
  process.env.ADMIN_TOKEN = ADMIN;
  try {
    for (const host of ['cat.evenos.app', 'medaudit.evenos.app']) {
      const login = middleware(request(`https://${host}/audit/login`, { host }));
      assert.equal(login.headers.get('location'), null, `${host} login stays put`);
      assert.notEqual(login.status, 401, `${host} login`);

      const pharmacist = middleware(request(`https://${host}/audit`, {
        host, cookie: `${PHARMACIST_COOKIE}=${PHARM}`,
      }));
      assert.notEqual(pharmacist.status, 307, `${host} pharmacist`);
      assert.equal(pharmacist.headers.get('location'), null);

      const admin = middleware(request(`https://${host}/audit/queries`, {
        host, cookie: `${ADMIN_SESSION_COOKIE}=${ADMIN}`,
      }));
      assert.equal(admin.headers.get('location'), null, `${host} admin cookie`);

      const api = auditGateResponse(request(`https://${host}/api/audit`, {
        host, cookie: `${PHARMACIST_COOKIE}=${PHARM}`,
      }));
      assert.equal(api, null);
    }
    assert.equal(auditPrincipalFromCookies(PHARM, '', { PHARMACIST_TOKEN: PHARM, ADMIN_TOKEN: ADMIN }), true);
    assert.equal(auditPrincipalFromCookies('', ADMIN, { PHARMACIST_TOKEN: PHARM, ADMIN_TOKEN: ADMIN }), true);
    assert.equal(auditPrincipalFromCookies('nope', 'nope', { PHARMACIST_TOKEN: PHARM, ADMIN_TOKEN: ADMIN }), false);
    assert.equal(auditPrincipalFromCookies(PHARM, ADMIN, {}), false, 'unset secrets do not match a presented cookie');
  } finally { restoreEnv(); }
});

test('the page gate ignores x-surface and still requires a principal', async () => {
  process.env.PHARMACIST_TOKEN = PHARM;
  process.env.ADMIN_TOKEN = ADMIN;
  let surface: string | null = 'medaudit';
  let jar: Record<string, string> = {};
  const require_ = createRequire(`${process.cwd()}/x.js`);
  const headersMod = require_('next/headers') as {
    cookies: () => Promise<{ get: (name: string) => { value: string } | undefined }>;
    headers: () => Promise<{ get: (name: string) => string | null }>;
  };
  const previousCookies = headersMod.cookies;
  const previousHeaders = headersMod.headers;
  headersMod.cookies = async () => ({ get: (name) => jar[name] ? { value: jar[name] } : undefined });
  headersMod.headers = async () => ({ get: (name) => (name === 'x-surface' ? surface : null) });
  try {
    const { auditAccessAllowed } = await import('../pharmacist-cookie.ts');
    jar = {};
    surface = null;
    assert.equal(await auditAccessAllowed(), false, 'cat host, no cookie');
    surface = 'medaudit';
    assert.equal(await auditAccessAllowed(), false, 'medaudit tag, no cookie');
    jar = { [PHARM_COOKIE]: PHARM };
    surface = null;
    assert.equal(await auditAccessAllowed(), true, 'pharmacist cookie on cat');
    surface = 'medaudit';
    assert.equal(await auditAccessAllowed(), true, 'pharmacist cookie on medaudit');
    jar = { [ADMIN_COOKIE]: ADMIN };
    surface = null;
    assert.equal(await auditAccessAllowed(), true, 'admin cookie on cat');
  } finally {
    headersMod.cookies = previousCookies;
    headersMod.headers = previousHeaders;
    restoreEnv();
  }
});

test('a spoofed x-vercel-cron header does not authorize the OPD worker', async () => {
  process.env.CRON_SECRET = CRON;
  try {
    const { GET } = await import('../../app/api/opd-audit/worker/route.ts');
    const spoofed = await GET(request('https://cat.evenos.app/api/opd-audit/worker', { 'x-vercel-cron': '1' }));
    assert.equal(spoofed.status, 401);
    const query = await GET(request('https://cat.evenos.app/api/opd-audit/worker?secret=' + CRON));
    assert.equal(query.status, 401, 'query-string secret is not a cron credential');
    assert.equal(cronAuthorized(request('https://cat.evenos.app/api/opd-audit/worker', {
      authorization: `Bearer ${CRON}`,
      'x-vercel-cron': '1',
    })), true);
  } finally { restoreEnv(); }
});

test('CRON_SECRET unset denies, including a bearer of the empty string', () => {
  delete process.env.CRON_SECRET;
  try {
    assert.equal(cronAuthorized(request('https://cat.evenos.app/api/cron/harvest', { 'x-vercel-cron': '1' })), false);
    assert.equal(cronAuthorized(request('https://cat.evenos.app/api/cron/harvest', { authorization: 'Bearer ' })), false);
    assert.equal(cronAuthorized(request('https://cat.evenos.app/api/cron/harvest', { authorization: `Bearer ${CRON}` })), false);
  } finally { restoreEnv(); }
});

test('ADMIN_TOKEN unset denies, and a matching bearer or query token passes', async () => {
  delete process.env.ADMIN_TOKEN;
  try {
    const missing = requireAdmin(request('https://cat.evenos.app/api/debug-stats'));
    assert.equal(missing?.status, 401);
    const body = await missing?.json() as { error?: string };
    assert.match(body.error || '', /not configured/);
  } finally { restoreEnv(); }

  process.env.ADMIN_TOKEN = ADMIN;
  try {
    const wrong = requireAdmin(request('https://cat.evenos.app/api/debug-stats', { authorization: 'Bearer nope' }));
    assert.equal(wrong?.status, 401);
    assert.equal(requireAdmin(request('https://cat.evenos.app/api/debug-stats', { authorization: `Bearer ${ADMIN}` })), null);
    assert.equal(requireAdmin(request(`https://cat.evenos.app/api/debug-stats?token=${ADMIN}`)), null);
  } finally { restoreEnv(); }
});

test('sensitive routes name a principal, and none of them trust x-vercel-cron', () => {
  const roots = [
    'app/audit', 'app/api/audit', 'app/admin', 'app/api/admin', 'app/api/opd-audit',
    'app/api/ipd-audit', 'app/api/ipd-episode', 'app/api/ot-audit', 'app/api/governance',
    'app/api/cron', 'app/api/v1', 'app/api/ccb', 'app/api/care', 'app/api/care-call',
    'app/api/readmission', 'app/api/preop', 'app/api/learning', 'app/care',
  ];
  const markers = [
    'cronAuthorized(', 'requireAdmin(', 'isAdminUnlocked(', 'isCareUnlocked(',
    'auditAccessAllowed(', 'govKeyValid(', 'ccbApiKeyValid(', 'labKeyMatches(',
    'adminTokenMatches(', 'pilotSharedSecretAuthorized(', 'pharmacistTokenMatches(',
    'isPharmacistUnlocked(', 'preopAuthed(',
  ];
  const allow = new Set([
    'app/audit/login/page.tsx',
    'app/api/audit/login/route.ts',
    'app/care/login/page.tsx',
    'app/api/care/login/route.ts',
    'app/api/admin/unlock/route.ts',
    'app/admin/appropriateness-runs/page.tsx',
    'app/admin/proms-adhoc-review/page.tsx',
    'app/admin/observability/review/page.tsx',
    'app/care/lvc/page.tsx',
  ]);
  const walk = (dir: string, out: string[] = []): string[] => {
    if (!statSafe(dir)) return out;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (name === 'route.ts' || name === 'page.tsx') out.push(p);
    }
    return out;
  };
  const missing: string[] = [];
  const headerTrust: string[] = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8');
      if (src.includes("headers.get('x-vercel-cron')") || src.includes('headers.get("x-vercel-cron")')) headerTrust.push(file);
      if (allow.has(file)) continue;
      if (!markers.some((marker) => src.includes(marker))) missing.push(file);
    }
  }
  assert.deepEqual(headerTrust, []);
  assert.deepEqual(missing, []);
});

function statSafe(dir: string): boolean {
  try { return statSync(dir).isDirectory(); } catch { return false; }
}
