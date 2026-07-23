#!/bin/bash

# Prevent duplicate instances
PID_FILE="/home/tmax/meMeCoiNEd_v2/bot.pid"

if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Bot already running (PID $OLD_PID). Aborting."
    exit 1
  fi
fi

cd /home/tmax/meMeCoiNEd_v2

# Activate Python venv if it exists
if [ -d "venv" ]; then
  source venv/bin/activate
fi

# Start bot
node src/index.js &

NEW_PID=$!
echo $NEW_PID > "$PID_FILE"

echo "Bot started (PID $NEW_PID)"

# Clean up PID file on exit
trap 'rm -f "$PID_FILE"' EXIT