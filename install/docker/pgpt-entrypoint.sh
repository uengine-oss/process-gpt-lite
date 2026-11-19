#!/bin/sh
# pgpt-lite server/office-mcp entrypoint.
# LOOPBACK_FORWARD="18080=web:80": the public URL is http://localhost:18080, which inside this
# container would be the container itself. Forward that loopback port to the web gateway so the
# same URL works for the browser and for server-side calls (storage links, Supabase API).
set -e
# Kubernetes mounts an empty PVC over /data, hiding the folders the image made there. A named
# Compose volume copies them in, so this only ever shows up in production.
data_root="${PGPT_DATA_ROOT:-/data}"
mkdir -p "$data_root/folders" "$data_root/craft" "$data_root/browser-profiles"
if [ -n "$LOOPBACK_FORWARD" ]; then
  port="${LOOPBACK_FORWARD%%=*}"; target="${LOOPBACK_FORWARD#*=}"
  socat "TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr" "TCP:${target}" &
fi
exec "$@"
