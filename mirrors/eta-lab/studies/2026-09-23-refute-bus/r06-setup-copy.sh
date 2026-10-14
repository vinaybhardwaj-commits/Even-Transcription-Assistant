export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
R=/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus
cd /Users/vinaybhardwaj/dev/eta-bus-mcp || exit 1
echo "== builder unit tests (original tree)"
node test/unit.mjs 2>&1 | tail -4
rm -rf $R/copy && mkdir -p $R/copy && cp -R server.mjs run.sh lib test $R/copy/
# isolate audit log + db in the copy only
sed -i '' -e "s#^export const AUDIT_LOG_PATH = .*#export const AUDIT_LOG_PATH = '$R/copy/audit.log';#" \
          -e "s#^export const DB_DIR = .*#export const DB_DIR = '$R/copy/bus';#" \
          -e "s#^export const HERDR_STATUS_JSON = .*#export const HERDR_STATUS_JSON = '$R/copy/herdr-status.json';#" $R/copy/lib/constants.mjs
grep -n "AUDIT_LOG_PATH\|DB_DIR\|HERDR_STATUS_JSON" $R/copy/lib/constants.mjs
diff -r /Users/vinaybhardwaj/dev/eta-bus-mcp/lib $R/copy/lib
node --version
