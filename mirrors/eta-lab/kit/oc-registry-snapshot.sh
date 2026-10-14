#!/bin/bash
# oc-registry-snapshot.sh (herdr-kit, W25 / Fable r409): keep ~/oc/REGISTRY.tsv current with each live OpenCode pane's
# herdr pane id and its OpenCode SESSION ID, so oc-restore.sh can resume the right session after a herdr/box restart.
#
# WHY: `opencode -c` resumes the last session of the PROJECT DIRECTORY, and about ten panes share /home/eta/dev/eta-lab, so
# -c would resume another pane's session. herdr already knows the right id: `herdr agent get <name>` -> agent_session.value
# (reported by the herdr OpenCode integration plugin, herdr-tui-session.js). That id is lost when herdr stops, so it is
# written down here while the pane is alive. Run it after every switch and every few minutes (cron/systemd timer).
#
# usage: oc-registry-snapshot.sh [--dry-run]     REGISTRY: ${OC_REGISTRY:-$HOME/oc/REGISTRY.tsv}
# File format (tab separated, header first):  name  pane  model  cwd  sid       (sid column is added on first run)
# Only rows whose agent is LIVE in herdr are updated; a row for a dead pane keeps its last known sid (never blanked).
# Writes are atomic (temp file + rename), no key or config content is read; ids and pane ids only.
set -u
export PATH=$HOME/.local/bin:$PATH
REG="${OC_REGISTRY:-$HOME/oc/REGISTRY.tsv}"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
[ -f "$REG" ] || { echo "oc-registry-snapshot: no $REG"; exit 2; }
AGENTS=$(herdr agent list 2>/dev/null) || { echo "oc-registry-snapshot: herdr agent list failed"; exit 3; }
python3 - "$REG" "$DRY" <<'PY' "$AGENTS"
import csv, json, os, sys, tempfile
reg, dry, agents_json = sys.argv[1], sys.argv[2] == "1", sys.argv[3]
live = {}
for a in json.loads(agents_json)["result"]["agents"]:
    if a.get("agent") == "opencode" and a.get("name"):
        s = a.get("agent_session") or {}
        live[a["name"]] = (a.get("pane_id", ""), s.get("value", "") if s.get("kind") == "id" else "")
rows = list(csv.reader(open(reg), delimiter="\t"))
hdr, body = rows[0], rows[1:]
if "sid" not in hdr:
    hdr = hdr + ["sid"]
out, changed, missing = [hdr], 0, []
for r in body:
    r = r + [""] * (len(hdr) - len(r))
    name = r[0]
    if name in live:
        pane, sid = live[name]
        new = list(r)
        if pane: new[1] = pane
        if sid: new[4] = sid
        if new != r: changed += 1
        r = new
    else:
        missing.append(name)
    out.append(r)
print("snapshot: %d rows, %d changed, %d live, %d not live%s" % (len(body), changed, len(live), len(missing), (" (" + ",".join(missing) + ")") if missing else ""))
print("rows with a session id: %d of %d" % (sum(1 for r in out[1:] if r[4]), len(out) - 1))
if not dry and changed:
    fd, tmp = tempfile.mkstemp(prefix=".reg.", dir=os.path.dirname(reg))
    with os.fdopen(fd, "w") as f:
        csv.writer(f, delimiter="\t", lineterminator="\n").writerows(out)
    os.chmod(tmp, os.stat(reg).st_mode & 0o777)
    os.replace(tmp, reg)
    print("written")
PY
