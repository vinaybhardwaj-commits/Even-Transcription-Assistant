#!/bin/zsh
# Detailed scout for qwen loading activity

echo "=== OLLAMA MODELS CURRENTLY LOADED ===" >&2
curl -s http://localhost:11434/api/ps 2>/dev/null | grep -o '"name":"[^"]*"' | cut -d'"' -f4

echo "=== RUNNING NODE PROCESSES ===" >&2
ps aux | grep -i 'node\|npm\|mjs' | grep -v grep | awk '{print $11, $12, $13, $14}' | head -10

echo "=== OVERNIGHT-TRANSLATE STATUS ===" >&2
ps aux | grep overnight-translate | grep -v grep

echo "=== LAUNCHD LOADED SERVICES ===" >&2
launchctl list | grep -i eta | head -10

echo "=== RECENT OLLAMA LOG ===" >&2
tail -20 /opt/homebrew/var/log/ollama.log 2>/dev/null | grep -i qwen
