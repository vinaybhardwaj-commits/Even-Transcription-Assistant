export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
L=/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/live
C() { /bin/zsh $L/ctl.sh --session refute-test "$@"; }
C spawn rt-a /tmp haiku --skip-permissions 2>&1 | tail -3
C spawn rt-b /tmp haiku --skip-permissions 2>&1 | tail -3
C status
