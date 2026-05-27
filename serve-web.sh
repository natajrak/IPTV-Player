#!/usr/bin/env bash
# Start the BKL Play local dev server.
# Equivalent of serve-web.bat for macOS / Linux.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${PORT:-4000}"
URL="http://localhost:${PORT}/web/"

echo "Starting BKL Play dev server on ${URL}"
echo "Press Ctrl+C to stop."
echo

# Open browser in background (macOS: open, Linux: xdg-open)
if command -v open >/dev/null 2>&1; then
  (sleep 1 && open "$URL") &
elif command -v xdg-open >/dev/null 2>&1; then
  (sleep 1 && xdg-open "$URL") &
fi

PORT="$PORT" exec node server.js
