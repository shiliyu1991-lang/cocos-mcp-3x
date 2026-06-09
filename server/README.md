# server (Python FastMCP)

Python (FastMCP) MCP server. See top-level [README](../README.md) and
[USAGE.md](../USAGE.md) for the full picture; this file just covers the
server piece.

## Layout

```
src/
├── main.py                       Entry point. `python -m main`
├── core/config.py                Mutable Config (host, port, timeouts)
├── transport/ws_client.py        WS *server* the Cocos extension dials into
├── services/
│   ├── registry.py               @cocos_mcp_tool decorator
│   └── tools/
│       ├── __init__.py           register_all_tools (auto-discovery)
│       ├── _common.py            call_bridge() envelope wrapper
│       ├── get_project_info.py
│       ├── read_console.py
│       ├── manage_asset.py
│       ├── manage_scene.py
│       ├── manage_node.py
│       └── execute_script.py
└── utils/module_discovery.py
```

## Run

```bash
cd src
python -m main --transport stdio                    # for Claude Desktop / Cursor
python -m main --transport http --http-port 8765    # for manual testing
```

The Python process opens a WebSocket server on `127.0.0.1:6020/cocosmcp`
and waits for the Cocos extension to dial in (via the panel's Connect
button). The WS server runs on a daemon thread with its own asyncio loop;
`bridge.call(...)` from FastMCP's loop dispatches over via
`asyncio.run_coroutine_threadsafe`.

## Env vars (override CLI / defaults)

| var                          | default            |
| ---------------------------- | ------------------ |
| `COCOS_MCP_BRIDGE_HOST`      | `127.0.0.1`        |
| `COCOS_MCP_BRIDGE_PORT`      | `6020`             |
| `COCOS_MCP_BRIDGE_PATH`      | `/cocosmcp`        |
| `COCOS_MCP_REQUEST_TIMEOUT`  | `30` (seconds)     |
| `COCOS_MCP_CONNECT_TIMEOUT`  | `5` (seconds)      |

## Developing

Sanity-check syntax without running:

```bash
python -m py_compile src/main.py src/transport/ws_client.py \
    src/services/registry.py src/services/tools/*.py
```

Add a new tool: see [`CLAUDE.md`](../CLAUDE.md) "Adding a tool".
