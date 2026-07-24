#!/usr/bin/env bash
# jptr — send ExtendScript to Premiere via the MCP Bridge's file IPC.
# Bridge panel must show "Running". No MCP client required.
#
# Usage:
#   ./send-jsx.sh path/to/script.jsx     # send a script file
#   echo 'app.project.name' | ./send-jsx.sh -   # send from stdin
#
# Protocol (from MCPBridgeCEP/main.js): bridge polls $TMPDIR/premiere-mcp-bridge
# for cmd_*.jsx files, evals them in Premiere, writes res_<id>.json, deletes cmd.
set -euo pipefail

BRIDGE_DIR="${TMPDIR:-/tmp}/premiere-mcp-bridge"
ID="$(date +%s)_$$"
CMD_FILE="$BRIDGE_DIR/cmd_${ID}.jsx"
RES_FILE="$BRIDGE_DIR/res_${ID}.json"

mkdir -p "$BRIDGE_DIR"

if [ "${1:-}" = "-" ]; then
  SCRIPT="$(cat)"
else
  SCRIPT="$(cat "$1")"
fi

# Bridge expects the script pre-wrapped in an IIFE returning a string.
printf '(function(){ try { %s } catch(e) { return "ERROR: " + e.toString(); } })()' "$SCRIPT" > "$CMD_FILE"

echo "sent $(basename "$CMD_FILE") — waiting for response..."
for _ in $(seq 1 30); do
  if [ -f "$RES_FILE" ]; then
    cat "$RES_FILE"
    echo
    exit 0
  fi
  sleep 0.5
done
echo "no response after 15s — is the MCP Bridge panel Running?" >&2
exit 1
