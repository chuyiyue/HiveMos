#!/bin/sh
# Deploy HiveMos — always through the guard.
# scripts/check.mjs validates stylesheet structure and script syntax
# first; a failure stops the deploy before anything ships.
set -e
cd "$(dirname "$0")/.."
node scripts/check.mjs
# No `exec` on the wrangler line: the shell has to survive the deploy so
# the admin alignment below can run afterwards.
npx wrangler deploy --var "BUILD_ID:$(git rev-parse --short HEAD)" "$@"

# Admin alignment (admin-init design): when both secrets are present in
# the environment, align the administrator row after deploying. Skipped
# when they are absent.
if [ -n "${ADMIN_USERNAME:-}" ] && [ -n "${ADMIN_PASSWORD:-}" ]; then
  echo "== sync-admin =="
  node scripts/sync-admin.mjs || { echo "sync-admin FAILED" >&2; exit 1; }
fi

# GitHub OAuth app credentials (repository secrets are the source of
# truth): when both are present in the environment, align them onto the
# Worker as runtime secrets. Skipped when they are absent.
if [ -n "${GITHUB_CLIENT_ID:-}" ] && [ -n "${GITHUB_CLIENT_SECRET:-}" ]; then
  echo "== sync-github-secrets =="
  printf %s "$GITHUB_CLIENT_ID" | npx wrangler secret put GITHUB_CLIENT_ID >/dev/null
  printf %s "$GITHUB_CLIENT_SECRET" | npx wrangler secret put GITHUB_CLIENT_SECRET >/dev/null
  echo "github secrets aligned"
fi
