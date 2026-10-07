#!/bin/sh
set -eu
cd -- "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if command -v node >/dev/null 2>&1; then
  exec node server.mjs
elif command -v python3 >/dev/null 2>&1; then
  exec python3 server.py
else
  printf '%s\n' 'Please install Node.js 18+ or Python 3, then run this script again.' >&2
  exit 1
fi
