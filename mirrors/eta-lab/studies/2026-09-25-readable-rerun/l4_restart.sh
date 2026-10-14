#!/bin/bash
# restart the 337c arms on eta-lab-l4: shuffled manifests (any prefix of results is a random sample), greedy whisper, 4 IC workers
cd ~/eta-lab-night/indic-mt || exit 1
umask 077
for pat in "[r]un_whisper.sh" "[r]un_ic.sh" "[r]erun_whisper.py r1/s" "[r]erun_indicconformer.py r1/s" "flock .*gpu.lock bash -c for k"; do
  for p in $(pgrep -f "$pat"); do [ "$p" != "$$" ] && kill "$p" 2>/dev/null; done
done
sleep 8
echo "left: $(pgrep -f '[r]erun_' | wc -l)"
python3 - <<'P'
import random,os
for k in range(4):
    p=f"r1/s{k}/manifest.jsonl"; L=open(p).read().splitlines(); random.Random(20260925+k).shuffle(L)
    open(p,"w").write("\n".join(L)+"\n"); os.chmod(p,0o600)
print("manifests shuffled")
P
cat > r1/run_ic.sh <<'X'
#!/bin/bash
cd ~/eta-lab-night/indic-mt
OMP_NUM_THREADS=2 ORT_NUM_THREADS=2 nice -n 5 venv/bin/python rerun_indicconformer.py r1/s$1 > r1/ic_s$1.log 2>&1
X
cat > r1/run_whisper.sh <<'X'
#!/bin/bash
cd ~/eta-lab-night/indic-mt
exec flock ~/gpu.lock bash -c 'for k in 0 1 2 3; do (venv/bin/python rerun_whisper.py r1/s$k --beam 1 > r1/whisper_s$k.log 2>&1 &); done; sleep 10; while pgrep -f "[r]erun_whisper.py r1/s" >/dev/null; do sleep 15; done'
X
chmod +x r1/run_ic.sh r1/run_whisper.sh
setsid nohup r1/run_whisper.sh > r1/flock_whisper.log 2>&1 < /dev/null &
for k in 0 1 2 3; do setsid nohup r1/run_ic.sh $k > /dev/null 2>&1 < /dev/null & done
sleep 20
echo "running: $(pgrep -f '[r]erun_' | wc -l)"
