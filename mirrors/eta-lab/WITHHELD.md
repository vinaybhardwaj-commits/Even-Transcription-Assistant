# Withheld from mirrors/eta-lab (branch consult/tools)

Files left out whole. Path and rule only.

- `consult/alert-relay/.gitignore`: policy-nested-gitignore
- `consult/clip-index/.gitignore`: policy-nested-gitignore
- `consult/clip-index/REPORT.md`: host-deny, ts-cgnat-ip
- `consult/clip-index/serve.py`: host-deny, ts-cgnat-ip
- `consult/clip-index/tests/test_gen_index.py`: guard:identity-dr-title, guard:identity-identity-field
- `consult/clip-index/tests/test_length_flags.py`: guard:identity-identity-field
- `consult/clip-index/tests/test_review_fixes.py`: guard:identity-identity-field
- `consult/clip-index/units/consult-index.service`: host-deny, ts-cgnat-ip
- `consult/cutter/.gitignore`: policy-nested-gitignore
- `consult/cutter/tests/test_gating.py`: guard:identity-doctor-slug
- `consult/cutter/tests/test_replay.py`: guard:identity-identity-field
- `consult/cutter/tests/test_run.py`: guard:identity-identity-field
- `consult/presence-poller/HOSTS.md`: host-deny, ts-cgnat-ip
- `consult/presence-poller/hosts.json`: host-deny, ts-cgnat-ip
- `consult/presence-poller/poller/__pycache__/__init__.cpython-313.pyc`: policy-data-dir
- `consult/presence-poller/poller/__pycache__/events.cpython-313.pyc`: policy-data-dir
- `consult/presence-poller/poller/__pycache__/main.cpython-313.pyc`: policy-data-dir
- `consult/presence-poller/poller/__pycache__/probe.cpython-313.pyc`: policy-data-dir
- `consult/presence-poller/poller/__pycache__/transport.cpython-313.pyc`: policy-data-dir
- `consult/presence-poller/poller/main.py`: env-secret-assign
- `consult/presence-poller/tests/__pycache__/test_poller.cpython-313.pyc`: policy-data-dir
- `consult/presence-poller/tests/test_deliver.py`: env-secret-assign
- `consult/presence-poller/tests/test_poller.py`: public-ipv4
