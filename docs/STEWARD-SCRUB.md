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
- A secret first added inside a merge commit (not present in either parent) is not seen by the gitleaks history pass. Compensating control: before every steward push or mirror, also run `scripts/steward/scrub.sh --tree <checkout of the target HEAD>` and block on any hit. A merge-introduced secret that is still in the tree is caught there; history-only ones are accepted because the public mirror is tree-based.
- YAML flow values that span several lines (`uhid: [` ... `]`) and a nested `patient:` then `name:` are not caught (fixture `xfail-phi-field-yamlmultiline.yaml`).
- Unparsable JSON with a flow list under a PHI key, and schema-shaped values carrying data under `example`, `default`, `title`, `description` or `enum`, are not caught.
- The tree-scan control above is a manual step, not a CI step: a tree scan of main today has hits that predate the gate, so it is compared against the files a push changes.
- Hits from the python rules (path, PHI, host) have no per-line allowlist; move synthetic data under `fixtures/synthetic/`.
Gitleaks decodes nested encodings (depth 5). The PHI rule reads field names, so a value stored under an unlisted key is not caught. Add the key to `PHI_FIELDS`.
