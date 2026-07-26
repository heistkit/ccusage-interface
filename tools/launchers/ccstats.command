#!/bin/sh
# Two jobs in one file:
#   double-clicked (no arguments) -> start the live dashboard (macOS opens .command in Terminal)
#   called with arguments         -> behave like a normal CLI and forward them
#
# Resolves its own directory but deliberately does NOT cd there: --out and --root are relative
# to wherever you invoked it from, and cd-ing would silently write files into the install folder.
SELF=$(cd "$(dirname "$0")" && pwd) || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required."
  echo "Get it from https://nodejs.org  then try again."
  exit 1
fi

if [ "$#" -eq 0 ]; then
  exec node "$SELF/ccstats.mjs" --serve --open
fi
exec node "$SELF/ccstats.mjs" "$@"
