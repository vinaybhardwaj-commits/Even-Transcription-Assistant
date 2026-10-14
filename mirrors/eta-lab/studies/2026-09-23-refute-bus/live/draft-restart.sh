export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
L=/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/live
H() { herdr --session refute-test "$@"; }
/bin/zsh $L/ctl.sh --session refute-test restart rt-c > $L/scratch/draft-restart.out 2>&1; echo "restart rc=$?"
grep -v '^{' $L/scratch/draft-restart.out | head -8
H agent read rt-c --source recent-unwrapped --lines 60 | grep -v "^\s*$" | tail -25 | cut -c1-150
