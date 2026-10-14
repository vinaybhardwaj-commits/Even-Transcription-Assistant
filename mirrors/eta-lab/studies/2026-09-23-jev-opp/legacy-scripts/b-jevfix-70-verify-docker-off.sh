#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
docker info > /dev/null 2>&1
echo "docker_info_exit=$?"
pgrep -fl "Docker.app" | head -5
