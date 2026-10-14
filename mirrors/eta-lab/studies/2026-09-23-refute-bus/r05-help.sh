export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
herdr agent 2>&1 | head -60
echo "-----"
herdr session 2>&1 | head -30
echo "-----"
herdr server 2>&1 | head -5 || true
