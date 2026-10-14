#!/usr/bin/env bash
# Install the uploader, backfill, nightly index, daily check and their user timers on the box.
# Producers call the installed copy:  python3 ~/.local/share/lab-vault/vault-push.py --path <file-or-dir>
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
share=~/.local/share/lab-vault
mkdir -p "$share" ~/.config/systemd/user ~/.local/state/lab-vault ~/eta-data/lab-vault/staged ~/eta-data/lab-vault/reports
install -m 0755 "$here/../vault-push.py" "$here/backfill.py" "$here/build-index.py" "$here/check-copies.py" "$share/"
[ -x "$share/venv/bin/python" ] || { python3 -m venv "$share/venv" && "$share/venv/bin/pip" install -q pyarrow; }
install -m 0644 "$here"/systemd/lab-vault-*.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now lab-vault-push.timer lab-vault-index.timer lab-vault-check.timer lab-vault-view.timer
loginctl enable-linger "$USER" 2>/dev/null || echo "WARN: could not enable linger; timers only run while a login session exists" >&2
systemctl --user list-timers 'lab-vault-*' --no-pager
