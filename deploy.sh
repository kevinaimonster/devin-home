#!/bin/bash
# Devin Agent — one-command deploy to production server
#
# Usage: ./deploy.sh
#
# Prerequisites:
#   - SSH access to the server (root@43.173.120.86)
#   - Server has Node.js, gh CLI installed
#
# What it does:
#   1. Push local changes to GitHub
#   2. SSH into server
#   3. Pull latest code
#   4. Restart the systemd service

set -e

SERVER="root@43.173.120.86"
REMOTE_DIR="/opt/devin-home"

echo "[deploy] Pushing to GitHub..."
git push origin main 2>/dev/null || true

echo "[deploy] Deploying to server..."
ssh $SERVER bash -s << 'REMOTE'
set -e
export PATH="/root/.local/share/fnm/aliases/default/bin:$PATH"

cd /opt/devin-home
git fetch origin
git reset --hard origin/main

# Install any new dependencies
npm install --omit=dev 2>&1 | tail -1

# Restart via systemd if available, otherwise fallback to direct
if systemctl is-active devin >/dev/null 2>&1; then
  systemctl restart devin
  sleep 2
  systemctl status devin --no-pager | head -10
else
  # Fallback: kill and restart directly
  pgrep -f "tsx src/agent" | xargs kill 2>/dev/null || true
  sleep 1
  source /root/.bashrc 2>/dev/null || true
  export LLM_API_KEY="${LLM_API_KEY:-$(grep LLM_API_KEY /etc/devin.env 2>/dev/null | cut -d= -f2)}"
  > /var/log/devin.log
  nohup npx tsx src/agent/server.ts >> /var/log/devin.log 2>&1 &
  sleep 2
  cat /var/log/devin.log
fi

echo "[deploy] Done."
REMOTE

echo "[deploy] Verifying health..."
sleep 3
curl -s http://43.173.120.86:3001/health
echo ""
echo "[deploy] Complete."
