#!/bin/zsh
cd /Users/vinaybhardwaj/dev/_fable/wt-merge || exit 1
echo "=== run-migrations auth shape ==="
sed -n '100,135p' app/api/run-migrations/route.ts
echo
echo "=== prod app url ==="
grep '^APP_URL=' /Users/vinaybhardwaj/dev/_fable/secrets/prod.env 2>/dev/null | head -1
echo "MIGRATION_SECRET real? $(grep '^MIGRATION_SECRET=' /Users/vinaybhardwaj/dev/_fable/secrets/prod.env | grep -c SENSITIVE) (1 = placeholder, 0 = real)"
