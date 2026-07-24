#!/usr/bin/env bash
# jptr — Premiere Pro MCP setup (one-time per machine)
# Installs leancoderkavy/premiere-pro-mcp + CEP bridge panel.
set -euo pipefail

echo "1/3 installing premiere-pro-mcp..."
npm install -g premiere-pro-mcp

echo "2/3 installing CEP bridge panel..."
premiere-pro-mcp --install-cep

echo "3/3 enabling unsigned CEP panels (PlayerDebugMode)..."
for v in 9 10 11 12 13; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1 2>/dev/null || true; done

cat << 'EOF'

Done. Now:
  1. FULLY QUIT Premiere (Cmd+Q) and relaunch — it scans extensions at launch
  2. Window > Extensions > MCP Bridge > Start Bridge  ("Running")
  3. Optional MCP client registration (Claude Code):
       claude mcp add premiere -- node ~/.local/lib/node_modules/premiere-pro-mcp/dist/index.js
  4. Or drive it directly with ./send-jsx.sh (no MCP client needed)
EOF
