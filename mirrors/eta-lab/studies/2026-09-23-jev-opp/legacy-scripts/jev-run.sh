#!/bin/zsh
chmod +x /Users/vinaybhardwaj/dev/_fable/*.sh
R=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow
LOG=/Users/vinaybhardwaj/dev/_fable/jev-run.log
rm -f "$LOG" /Users/vinaybhardwaj/dev/_fable/jev-run.done
nohup zsh -c "cd $R && npx tsc --noEmit -p tsconfig.tests.json > $LOG 2>&1; echo TSC_RC=\$? >> $LOG; npx vitest run tests/unit/fuse-arms.test.ts tests/unit/fuse-report.test.ts tests/unit/fuse-scratch-write.test.ts tests/unit/jev-arm.test.ts >> $LOG 2>&1; echo \$? > /Users/vinaybhardwaj/dev/_fable/jev-run.done" > /dev/null 2>&1 &
echo "started pid $!"
