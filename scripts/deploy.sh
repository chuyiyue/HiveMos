#!/bin/sh
# Deploy HiveMos — always through the guard.
# scripts/check.mjs validates stylesheet structure and script syntax
# first; a failure stops the deploy before anything ships.
set -e
cd "$(dirname "$0")/.."
node scripts/check.mjs
exec npx wrangler deploy --var "BUILD_ID:$(git rev-parse --short HEAD)" "$@"

# Admin alignment (admin-init design): when both secrets are present in
# the environment, align the administrator row after deploying. Skipped
# when they are absent.
if [ -n "${ADMIN_USERNAME:-}" ] && [ -n "${ADMIN_PASSWORD:-}" ]; then
  echo "== sync-admin =="
  node scripts/sync-admin.mjs || { echo "sync-admin FAILED" >&2; exit 1; }
fi
