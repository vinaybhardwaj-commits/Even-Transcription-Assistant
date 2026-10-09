# eta-consult-clip-index
Builds a static HTML index of cut consult clips (`gen_index.py`), a patient-name cache (`build_patients.py`) and serves both with Range support (`serve.py`).
`serve.py` binds only to the private address in env `CONSULT_INDEX_BIND` (required) and refuses wildcard addresses. Set that address in `units/consult-index.service` for your host.
Tests: `python3 -m unittest discover -s tests`
Snapshot of a private repo (no history). Clip data, patient names and the index are never in this repo.
