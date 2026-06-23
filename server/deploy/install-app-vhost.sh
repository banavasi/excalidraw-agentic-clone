#!/usr/bin/env bash
# Install/refresh the Excaliboard editor static vhost + reload nginx. Run ON cosmos
# (piped via `ssh ... 'bash -s' < this`). Expects the deploy job to have already
# rsynced the vhost to /tmp/excaliboard-app.conf and the build to /var/www/excaliboard-app.
set -euo pipefail

sudo install -m644 /tmp/excaliboard-app.conf /etc/nginx/sites-available/excaliboard-app.conf
sudo ln -sf /etc/nginx/sites-available/excaliboard-app.conf /etc/nginx/sites-enabled/excaliboard-app.conf
sudo nginx -t
sudo systemctl reload nginx
echo "excaliboard-app vhost installed + nginx reloaded; serving /var/www/excaliboard-app"
