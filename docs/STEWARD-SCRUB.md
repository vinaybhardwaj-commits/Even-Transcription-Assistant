# Steward scrub gate

This repo is public. Nothing below may ever be committed. The gate blocks it in CI and, if you install the hook, on push.

## What is blocked
- Secrets: the gitleaks default rules plus `private-key-header`, `env-secret-assign` (a secret-named variable set to a literal of 8+ characters).
- Hosts and accounts: `ts-cgnat-ip` (the Tailscale CGNAT address range), `ts-hostname` (`*.ts.net`), `aws-account-id` (ARN, account-id field, ECR host).
- Paths: `.env*` (except `.env.example` with empty values), `*.pem *.p12 *.key`, audio and video files, `*.sqlite *.db *.parquet`, Chrome profile files, any file over 1 MB.
- PHI fields: in `*.json *.jsonl *.ndjson *.csv *.tsv *.yaml *.yml`, and in `*.txt *.md` under `data/`, `fixtures/`, `samples/` or `exports/`, a known PHI field (patient_name, uhid, mrn, member_id, transcript, and so on; see `PHI_FIELDS` in `scripts/steward/scrub_rules.py`) with a non-empty value. Code that only names a field does not hit. Synthetic fixtures pass only under `**/fixtures/synthetic/**`.
- Hosts you list privately: names in `$STEWARD_HOSTS_FILE` (default `~/oc/git-steward/scrub/HOSTS.local`, never committed). Skipped when the file is absent, as in CI.

Output is rule id, `path:line` and commit. The matched value is never printed.

An inline `gitleaks:allow` comment does NOT silence these rules: the gate ignores it. Use `steward/scrub-allow.txt`.
`.env.example` may carry non-empty defaults for non-secret keys; a secret-named key (SECRET, TOKEN, PASSWORD, API_KEY, DATABASE_URL ...) must be empty there.

## Run it locally
    scripts/steward/scrub.sh origin/main..HEAD     # a commit range
    scripts/steward/scrub.sh --staged              # what is staged
    scripts/steward/scrub.sh --tree some/dir       # a directory or file
    tests/steward-scrub/run.sh                     # fixture tests (each rule fires, negatives stay clean)

Needs `gitleaks` on PATH (or `GITLEAKS=/path`), `python3` and bash. Exit 0 clean, 1 hit, 2 tool error.
To install the pre-push hook in your clone: `scripts/steward/install-hook.sh`.

## Add an allowlist entry
Add one line to `steward/scrub-allow.txt`: `<gitleaks fingerprint> # <one-line reason>`. The merge owner must review that PR. Only `tests/steward-scrub/fixtures/**` is allowlisted by path. Never allowlist a real secret: rotate it instead.

## Known limits
Gitleaks decodes nested encodings (depth 5). The PHI rule reads field names, so a value stored under an unlisted key is not caught. Add the key to `PHI_FIELDS`.
