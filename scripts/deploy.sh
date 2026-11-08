#!/bin/sh
# Deploy HiveMos — always through the guard.
# scripts/check.mjs validates stylesheet structure and script syntax
# first; a failure stops the deploy before anything ships.
set -e
cd "$(dirname "$0")/.."
node scripts/check.mjs
exec npx wrangler deploy "$@"
