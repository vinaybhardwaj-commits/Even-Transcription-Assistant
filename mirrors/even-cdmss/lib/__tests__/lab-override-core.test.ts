// F11 provider-override gate (addendum A12, decision 15). Pure-core tests: no server, no DB.
//
// This gate decides whether a Lab caller may change the model answering on FIVE PRODUCTION
// CLINICIAN-FACING ROUTES. Every test here is a safety test. The single most important property is
// the FIRST one: with no model requested, the decision is "no override", which is what makes the
// five routes byte-identical to today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideOverride, overrideAuditLine, shouldLogRefusal,
  OVERRIDE_ENV_FLAG, LAB_ORIGIN_HEADER, LAB_ORIGIN_VALUE,
  type OverrideFacts,
} from '../lab-override-core';
import { resolveProvider } from '../lab-provider-core';

const MINI = 'qwen2.5:14b';
const resolved = (m: string) => {
  const r = resolveProvider(m, MINI);
  return r.ok ? { ok: true as const, provider: r.provider, model: r.model, paid: r.paid } : { ok: false as const };
};
/** Everything passing — each test then breaks exactly ONE condition. */
const PASS: OverrideFacts = {
  requestedModel: 'openrouter:google/gemini-2.5-flash',
  envFlag: '1',
  labOriginHeader: LAB_ORIGIN_VALUE,
  isAdmin: true,
  isClinicianSession: false,
  resolved: resolved('openrouter:google/gemini-2.5-flash'),
  reachable: true,
  caller: 'lab-mcp',
};

test('THE INVARIANT: no model requested ⇒ no override — this is what keeps the five routes byte-identical', () => {
  for (const m of [undefined, null, '', '   ']) {
    const d = decideOverride({ ...PASS, requestedModel: m });
    assert.equal(d.override, false, JSON.stringify(m));
    assert.equal((d as { refusal: string }).refusal, 'no_model_requested');
  }
  // and it short-circuits BEFORE any other condition, so a route with no override never depends on
  // env, headers, auth or reachability at all
  const bare = decideOverride({ requestedModel: '', isAdmin: false, isClinicianSession: true });
  assert.equal(bare.override, false);
  assert.equal((bare as { refusal: string }).refusal, 'no_model_requested');
});

test('the full pass path honours the override and reports the RESOLVED model', () => {
  const d = decideOverride(PASS);
  assert.equal(d.override, true);
  if (!d.override) return;
  assert.equal(d.provider, 'openrouter');
  assert.equal(d.model, 'google/gemini-2.5-flash', 'the RESOLVED model, not the prefixed request string');
  assert.equal(d.paid, true);
  assert.equal(d.caller, 'lab-mcp');
});

// ── the six conditions, each broken in isolation ───────────────────────────────
test('1 — env flag: absent, unset or anything but "1" ⇒ OFF (the kill switch)', () => {
  for (const v of [undefined, null, '', '0', 'true', 'yes', 'TRUE']) {
    const d = decideOverride({ ...PASS, envFlag: v });
    assert.equal(d.override, false, String(v));
    assert.equal((d as { refusal: string }).refusal, 'flag_off', String(v));
  }
  assert.equal(OVERRIDE_ENV_FLAG, 'LAB_PROVIDER_OVERRIDE_ENABLED');
});

test('2 — lab-origin marker: a header, and only the exact value passes', () => {
  for (const v of [undefined, null, '', 'browser', 'LAB-MCP', 'lab-mcp ']) {
    const d = decideOverride({ ...PASS, labOriginHeader: v });
    assert.equal(d.override, false, String(v));
    assert.equal((d as { refusal: string }).refusal, 'no_lab_marker', String(v));
  }
  assert.equal(LAB_ORIGIN_HEADER, 'x-cdmss-lab-origin');
  assert.equal(LAB_ORIGIN_VALUE, 'lab-mcp');
});

test('3 — admin auth must pass on the same request', () => {
  const d = decideOverride({ ...PASS, isAdmin: false });
  assert.equal(d.override, false);
  assert.equal((d as { refusal: string }).refusal, 'not_admin');
});

test('4 — a clinician session REFUSES the override even when 1-3 all pass', () => {
  // the whole point of condition 4: admin + lab marker + flag on is NOT enough if a clinician is
  // on the request. Fail closed toward production behaviour.
  const d = decideOverride({ ...PASS, isClinicianSession: true });
  assert.equal(d.override, false);
  assert.equal((d as { refusal: string }).refusal, 'clinician_session');
  // …and it is checked AFTER admin, so holding both cookies is still refused
  const both = decideOverride({ ...PASS, isAdmin: true, isClinicianSession: true });
  assert.equal((both as { refusal: string }).refusal, 'clinician_session');
});

test('5 — an unknown provider prefix falls through to the production default', () => {
  const d = decideOverride({ ...PASS, requestedModel: 'gpt5:turbo', resolved: resolved('gpt5:turbo') });
  assert.equal(d.override, false);
  assert.equal((d as { refusal: string }).refusal, 'unknown_provider');
  // a null/absent resolution is treated the same way
  assert.equal((decideOverride({ ...PASS, resolved: null }) as { refusal: string }).refusal, 'unknown_provider');
  assert.equal((decideOverride({ ...PASS, resolved: undefined }) as { refusal: string }).refusal, 'unknown_provider');
});

test('6 — an unreachable model falls through to default, and UNPROBED counts as unreachable', () => {
  assert.equal((decideOverride({ ...PASS, reachable: false }) as { refusal: string }).refusal, 'model_unreachable');
  // never probed ⇒ must not reach a clinical route
  assert.equal((decideOverride({ ...PASS, reachable: undefined }) as { refusal: string }).refusal, 'model_unreachable');
});

test('the gate NEVER throws and NEVER returns an error, whatever it is handed', () => {
  const junk = [
    {}, { requestedModel: 'x' }, { requestedModel: 'openrouter:m', isAdmin: true, isClinicianSession: false },
    { requestedModel: 123 as unknown as string, isAdmin: 'yes' as unknown as boolean, isClinicianSession: 0 as unknown as boolean },
  ];
  for (const j of junk) {
    const d = decideOverride(j as OverrideFacts);
    assert.ok(d && typeof d.override === 'boolean');
    assert.ok(d.override === true || typeof (d as { refusal: string }).refusal === 'string');
  }
  assert.doesNotThrow(() => decideOverride(null as unknown as OverrideFacts));
});

test('condition ORDER is the safety property — the kill switch is evaluated first', () => {
  // flag off + everything else also broken ⇒ still reports flag_off, proving evaluation order
  const d = decideOverride({
    requestedModel: 'gpt5:turbo', envFlag: '0', labOriginHeader: 'browser',
    isAdmin: false, isClinicianSession: true, resolved: null, reachable: false,
  });
  assert.equal((d as { refusal: string }).refusal, 'flag_off');
  // marker missing + everything after it broken ⇒ no_lab_marker
  const d2 = decideOverride({
    requestedModel: 'gpt5:turbo', envFlag: '1', labOriginHeader: null,
    isAdmin: false, isClinicianSession: true, resolved: null, reachable: false,
  });
  assert.equal((d2 as { refusal: string }).refusal, 'no_lab_marker');
});

test('an honoured override logs route · provider · resolved model · caller (A12)', () => {
  const d = decideOverride(PASS);
  assert.equal(d.override, true);
  if (!d.override) return;
  const line = overrideAuditLine('app/api/ask', d);
  assert.match(line, /route=app\/api\/ask/);
  assert.match(line, /provider=openrouter/);
  assert.match(line, /model=google\/gemini-2\.5-flash/);
  assert.match(line, /caller=lab-mcp/);
  // the REQUESTED string never appears — only the resolved one
  assert.doesNotMatch(line, /openrouter:google/);
});

test('refusals are logged except the normal no-override path', () => {
  assert.equal(shouldLogRefusal('no_model_requested'), false, 'every real clinical request takes this path');
  for (const r of ['flag_off', 'no_lab_marker', 'not_admin', 'clinician_session', 'unknown_provider', 'model_unreachable'] as const) {
    assert.equal(shouldLogRefusal(r), true, r);
  }
});

test('ollama and vertex both pass the gate when everything else does', () => {
  const o = decideOverride({ ...PASS, requestedModel: 'ollama:qwen2.5:14b', resolved: resolved('ollama:qwen2.5:14b') });
  assert.equal(o.override, true);
  assert.equal(o.override && o.paid, false);
  const v = decideOverride({ ...PASS, requestedModel: 'vertex:gemini-2.5-pro', resolved: resolved('vertex:gemini-2.5-pro') });
  assert.equal(v.override, true);
  assert.equal(v.override && v.provider, 'vertex');
});
