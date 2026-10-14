#!/bin/zsh
# Read-only scout script for qwen2.5:14b callers

echo "=== PROCESS CHECK ===" >&2
ps aux | grep -i ollama | grep -v grep

echo "=== LAUNCHD JOBS ===" >&2
launchctl list | grep -i ollama || echo "No ollama in launchctl"

echo "=== CLOUDFLARED CONFIG ===" >&2
ps aux | grep cloudflared | grep -v grep | head -1

if [ -f ~/.cloudflared/config.yml ]; then
  grep -A 2 -B 2 "11434" ~/.cloudflared/config.yml 2>/dev/null || echo "No 11434 in ~/.cloudflared/config.yml"
fi

if [ -d /opt/homebrew/etc/cloudflared ]; then
  grep -r "11434" /opt/homebrew/etc/cloudflared 2>/dev/null || echo "No 11434 in /opt/homebrew"
fi

echo "=== CRONTAB ===" >&2
crontab -l 2>/dev/null | grep -i ollama || echo "No ollama in crontab"

echo "=== LAUNCHAGENTS OLLAMA ===" >&2
grep -l "OLLAMA\|qwen" ~/Library/LaunchAgents/*.plist 2>/dev/null | head -5
