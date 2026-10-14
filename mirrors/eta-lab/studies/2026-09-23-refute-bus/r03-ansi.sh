export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
for n in fleet lx minibot-2; do
echo "===== $n"
herdr agent read "$n" --source visible --lines 5 --format ansi 2>&1 | tail -5 | cat -v
done
echo "===== process-info fleet (read-only)"
herdr pane process-info --pane w3:p1 2>&1 | python3 -c '
import json,sys
d=json.load(sys.stdin); pi=d["result"]["process_info"]
print("fg", pi.get("foreground_process_group_id"))
for p in pi.get("foreground_processes",[]): print(p.get("pid"), p.get("argv0"), (p.get("cmdline") or "")[:300])
print("keys", list(pi.keys()))
'
echo "===== process-info all live claude cmdlines"
for p in w2:p1 w3:p1 w4:p1 w5:p1 w6:p1 w7:p1 w8:p1 w9:p1 wA:p1 wB:p1 wC:p1 wD:p2; do
 printf "%s: " $p
 herdr pane process-info --pane $p 2>&1 | python3 -c '
import json,sys
d=json.load(sys.stdin); pi=d["result"]["process_info"]
print(" | ".join((p.get("cmdline") or p.get("argv0") or "")[:200] for p in pi.get("foreground_processes",[])))
'
done
echo "===== claude help -n"
claude --help 2>&1 | grep -n -E "^\s+-n|--name|--resume|--model|--dangerously|--permission-mode" | head
