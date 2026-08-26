#!/usr/bin/env bash
# Build the server and run it with the Node inspector enabled.
#
# Usage:
#   ./debug.sh            # build then run with --inspect (attach on port 9229)
#   ./debug.sh --brk      # same, but pause on the first line until a debugger attaches
#
# Pair this with the "Attach to Server (--inspect)" launch config in
# .vscode/launch.json, or open chrome://inspect in Chrome.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -f .env ]; then
  echo "server/.env not found - copy .env.example and fill it in first." >&2
  exit 1
fi

INSPECT_FLAG="--inspect"
if [ "${1:-}" = "--brk" ]; then
  INSPECT_FLAG="--inspect-brk"
fi

echo "Building..."
npm run build

echo "Starting server with $INSPECT_FLAG (attach a debugger on port 9229)..."
exec node --env-file=.env "$INSPECT_FLAG" dist/index.js
