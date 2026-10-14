# Withheld from mirrors/newcat

Files left out whole (never redacted). Path and rule only.

## Policy exclusions (counts)

- policy-env-example-ignored-by-eta-root: 1
- policy-nested-gitignore: 1

## Scrub hits (path, rule)

- `docs/AWS-SETUP.md`: aws-account-id
- `docs/BATCH-EMBED.md`: env-secret-assign
- `docs/DEPLOY.md`: env-secret-assign
- `test/aws-probe.test.ts`: aws-account-id
- `test/deploy.test.ts`: aws-account-id, private-key-header
- `test/evidence.test.ts`: aws-account-id
- `test/gcp-federation.test.ts`: aws-account-id, private-key-header
- `test/platform/bedrock/bedrock.test.ts`: aws-account-id
- `test/platform/bedrock/f71-selfcheck.test.ts`: aws-account-id
- `test/platform/bedrock/followups.test.ts`: aws-account-id
- `test/platform/bedrock/toolchoice.test.ts`: aws-account-id
- `test/platform/cdmss/db13.test.ts`: host-deny
- `test/platform/clef/clef.test.ts`: presigned-url
- `test/platform/judge/gemini.test.ts`: aws-account-id, private-key-header
