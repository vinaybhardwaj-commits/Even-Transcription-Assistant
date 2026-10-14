import { looksLikeSecret } from '/Users/vinaybhardwaj/dev/eta-bus-mcp/lib/secrets.mjs';
console.log('--- VERDICT B5 false positives (must ALL be false now) ---');
const fps = {
  'git sha': 'deadbeefcafebabe1234567890abcdef12345678',
  'sha256 digest': 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  'risk-stratification': 'please review the risk-stratification module',
  'task-breakdown-v2': 'see task-breakdown-v2 for the plan',
  'disk-usage-report': 'attached the disk-usage-report',
  'file path': '/Users/vinaybhardwaj/dev/eta/transcripts/encounter4821/out.json',
  'camelCase 49ch': 'theVeryLongCamelCaseIdentifierForThingsHereOkay',
  'x repeat 200': 'x'.repeat(200),
  'uuid': '550e8400-e29b-41d4-a716-446655440000',
  'embedding': Array.from({length:40},(_,i)=>(i/40).toFixed(6)).join(','),
};
for (const [k,v] of Object.entries(fps)) console.log((looksLikeSecret(v)?'FLAGGED(BAD)':'pass        ')+'  '+k);
console.log('\n--- VERDICT B5 false negatives (should now be TRUE) ---');
const fns = {
  'postgres url w/ pw': 'postgres://EXAMPLE_USER:EXAMPLE_PASS@example.invalid/neondb',
  'ghp_ token': 'ghp_EXAMPLE_NOT_REAL_TOKEN_00000000000',
  'google AIza key': 'AIzaEXAMPLE_NOT_REAL_KEY_0000000000001',
  'slack xoxb': 'xoxb-EXAMPLE-NOT-REAL-TOKEN-000000000000',
  'password=': 'password=EXAMPLE_NOT_REAL_00',
  'jwt': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc',
  'sk-ant key': 'sk-ant-api03-'+'A'.repeat(40),
  'Bearer': 'Authorization: Bearer EXAMPLE-NOT-REAL-TOKEN',
  'PEM': '-----BEGIN RSA PRIVATE KEY (EXAMPLE)-----',
};
for (const [k,v] of Object.entries(fns)) console.log((looksLikeSecret(v)?'caught      ':'MISSED(GAP) ')+'  '+k);
