#!/usr/bin/env bash
# deploy-cosmos.sh — idempotent excaliboard deploy on cosmos.
#
# Invoked by CI after rsync'ing the server subtree to /opt/excaliboard:
#   ssh ubuntu@cosmos-pub 'bash -s' < server/deploy/deploy-cosmos.sh
# Also safe to run by hand on the box. Builds the API image, brings the stack up,
# verifies /sync/healthz, rolls the API image back on failure, and (only once healthy)
# installs the nginx vhost. Postgres data + .env are preserved across deploys.
#
# Prereqs on the box (one-time, see deploy/README.md): docker + compose v2, the ubuntu
# user in the docker group, passwordless sudo (nginx), and /opt/excaliboard/.env seeded
# from 1Password Mithra.
set -euo pipefail

SVC_DIR=/opt/excaliboard
IMAGE=excaliboard-api:0.1.0
log() { echo "[deploy $(date +%H:%M:%S)] $*"; }

cd "$SVC_DIR"
[ -f .env ] || {
  echo "FATAL: $SVC_DIR/.env missing — seed it from 1Password first (see deploy/README.md)"
  exit 1
}

# Keep the current image so we can roll back if the new build is unhealthy.
HAVE_PREV=0
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker tag "$IMAGE" excaliboard-api:previous
  HAVE_PREV=1
fi

log "building + starting (docker compose up -d --build)"
docker compose up -d --build

log "waiting for /sync/healthz"
ok=0
code=none
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8789/sync/healthz || true)
  if [ "$code" = "200" ]; then ok=1; break; fi
  sleep 2
done

if [ "$ok" != "1" ]; then
  log "HEALTHCHECK FAILED (last code: $code)"
  if [ "$HAVE_PREV" = "1" ]; then
    log "ROLLBACK — restoring the previous API image"
    docker tag excaliboard-api:previous "$IMAGE"
    docker compose up -d --no-build
  fi
  exit 1
fi
log "health OK"

# Expose only after the service is healthy. The cloudflared wildcard tunnel already
# routes *.shashankshandilya.me -> nginx:80; the DNS route is a one-time bootstrap step.
sudo install -m644 "$SVC_DIR/deploy/nginx/excaliboard.conf" /etc/nginx/sites-available/excaliboard.conf
sudo ln -sf /etc/nginx/sites-available/excaliboard.conf /etc/nginx/sites-enabled/excaliboard.conf
sudo nginx -t && sudo systemctl reload nginx
log "nginx vhost installed + reloaded"

docker image prune -f >/dev/null 2>&1 || true
log "DEPLOY OK — excaliboard live on :8789 (excaliboard.shashankshandilya.me)"
