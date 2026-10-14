#!/usr/bin/env zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
set -e
cd /Users/vinaybhardwaj/eta-router
git worktree list
git worktree add -b vinay/translate-pools /Users/vinaybhardwaj/eta-router-pools vinay/translate-hardening
