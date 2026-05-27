#!/bin/bash
set -e

chown -R openclaw:openclaw /data
chmod 700 /data

if [ ! -d /data/.linuxbrew ]; then
  cp -a /home/linuxbrew/.linuxbrew /data/.linuxbrew
fi

rm -rf /home/linuxbrew/.linuxbrew
ln -sfn /data/.linuxbrew /home/linuxbrew/.linuxbrew

# Kill any stale gateway from a previous container lifecycle
# (the /data volume persists across redeploys, so old processes can linger)
pkill -f openclaw-gateway 2>/dev/null || true
sleep 1

exec tini -- gosu openclaw node src/server.js
