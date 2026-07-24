# premiere/ — Premiere Pro MCP integration

- `setup.sh` — one-time install (MCP server + CEP bridge + debug flags)
- `send-jsx.sh` — fire ExtendScript at Premiere through the bridge file-IPC (no MCP client needed)
- `import-cut.jsx` — imports editor pipeline output (`output/timeline.xml`) as a Premiere sequence

MCP client route (Claude Code): `claude mcp add premiere -- node ~/.local/lib/node_modules/premiere-pro-mcp/dist/index.js` → 269 tools.
Bridge must show "Running" in Window > Extensions > MCP Bridge.
