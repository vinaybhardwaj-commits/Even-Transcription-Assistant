export PATH=/opt/homebrew/bin:/usr/bin:/bin
D=/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/ctlcopy
cd $D || exit 1
head -3 scratch/st1.err; echo ...
sed -i '' 's/"idle" if sess == "default" else "working"/"idle"/' fakeherdr.py
declare -A seen
for k in $(seq 1 20); do
  /bin/zsh ctl.sh --session other status >/dev/null 2>&1 &
  o=$(/bin/zsh ctl.sh --dry-run restart a03 2>&1); wait
  echo "$o" | head -1
done | sort | uniq -c
