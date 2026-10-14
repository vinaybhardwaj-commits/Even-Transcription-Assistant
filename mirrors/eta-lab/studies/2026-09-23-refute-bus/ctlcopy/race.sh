export PATH=/opt/homebrew/bin:/usr/bin:/bin
D=/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/ctlcopy
cd $D || exit 1
rm -rf scratch reg.json; mkdir -p scratch
# copy herdr-ctl.sh, redirect ONLY its paths + herdr binary to the sandbox
sed -e "s#^HERDR=herdr#HERDR='/usr/bin/python3 $D/fakeherdr.py'#" \
    -e "s#^SCRATCH=.*#SCRATCH=\"$D/scratch\"#" \
    -e "s#^REG=.*#REG=\"$D/reg.json\"#" \
    -e 's#^hcli() { $HERDR #hcli() { ${=HERDR} #' \
    /Users/vinaybhardwaj/dev/_fable/herdr-ctl.sh > ctl.sh
diff /Users/vinaybhardwaj/dev/_fable/herdr-ctl.sh ctl.sh
# seed registry: every agent has a recorded model (what restart relies on)
python3 - <<'EOF'
import json
d={"default":{("a%02d"%i):{"model":"opus","task":"t%d"%i} for i in range(12)}}
json.dump(d,open("/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/ctlcopy/reg.json","w"),indent=2)
EOF
echo "== test A: 4 concurrent 'status' (what 4 panes calling herdr_status/bus_roster at once do)"
for i in 1 2 3 4; do /bin/zsh ctl.sh status > scratch/st$i.out 2> scratch/st$i.err & done; wait
python3 - <<'EOF'
import json
p="/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/ctlcopy/"
try:
    d=json.load(open(p+"reg.json"))
    ag=d.get("default",{})
    print("agents in registry:",len(ag),"with model:",sum(1 for v in ag.values() if v.get("model")),"with task:",sum(1 for v in ag.values() if v.get("task")))
except Exception as e: print("REGISTRY UNREADABLE:",e)
EOF
grep -h -c "Traceback\|Error" scratch/st*.err | paste -sd+ - | bc | sed 's/^/python errors in status runs: /'
echo "== test B: default-session dry-run restart while another session's status runs"
bad=0; unk=0
for k in $(seq 1 15); do
  /bin/zsh ctl.sh --session other status >/dev/null 2>&1 &
  o=$(/bin/zsh ctl.sh --dry-run restart a03 2>&1); wait
  case "$o" in *OTHER*) bad=$((bad+1));; esac
  case "$o" in *"unknown agent"*|*refuse*) unk=$((unk+1));; esac
done
echo "dry-run restart used OTHER session's pane: $bad/15 ; refused/unknown (wrong-session state or truncated read): $unk/15"
