#!/bin/sh
# Double-click launcher (macOS opens .command in Terminal; on Linux run it from a shell or
# mark it executable in your file manager). Keep this next to ccstats.mjs.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required."
  echo "Get it from https://nodejs.org  then run this again."
  exit 1
fi
exec node ./ccstats.mjs --serve --open
