export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
L=/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/live
mkdir -p $L/scratch
# herdr-ctl.sh with ONLY scratch + registry redirected (real herdr binary)
sed -e "s#^SCRATCH=.*#SCRATCH=\"$L/scratch\"#" -e "s#^REG=.*#REG=\"$L/reg.json\"#" \
  /Users/vinaybhardwaj/dev/_fable/herdr-ctl.sh > $L/ctl.sh
diff /Users/vinaybhardwaj/dev/_fable/herdr-ctl.sh $L/ctl.sh
# bus copy -> use ctl.sh above
sed -i '' "s#^export const HERDR_CTL_PATH = .*#export const HERDR_CTL_PATH = '$L/ctl.sh';#" /Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/copy/lib/constants.mjs
grep HERDR_CTL_PATH /Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/copy/lib/constants.mjs
herdr session list --json
nohup herdr --session refute-test server > $L/server.log 2>&1 &
sleep 3
herdr session list --json
herdr --session refute-test agent list
