#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
echo "--- docker info:"
docker info --format '{{.ServerVersion}} containers={{.Containers}} running={{.ContainersRunning}}' 2>&1 | head -3
echo "--- eta- test containers (count):"
docker ps -a --filter "name=eta-" --format '{{.Names}} {{.Status}}' 2>&1 | wc -l
echo "--- removing stopped eta- test containers:"
docker ps -a --filter "name=eta-" --filter "status=exited" -q 2>/dev/null | head -400 | xargs -r docker rm -f 2>&1 | tail -3
docker ps -a --filter "name=eta-" --filter "status=created" -q 2>/dev/null | head -400 | xargs -r docker rm -f 2>&1 | tail -3
echo "--- after:"
docker ps -a --filter "name=eta-" --format '{{.Names}}' 2>&1 | wc -l
docker info --format 'containers={{.Containers}} running={{.ContainersRunning}}' 2>&1 | head -2
echo "--- disk:"
df -h / | tail -1
