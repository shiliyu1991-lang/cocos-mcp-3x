# cocos-mcp-3x

[中文](./README.md) · **English**

An editor extension that connects an LLM (Claude Desktop / Cursor or any MCP client) to the
**Cocos Creator 3.8.x** editor, letting the model inspect and drive your game project: read/write
nodes, operate on assets and scenes, read the console, and execute scripts.

The plugin is **self-contained**: the Python MCP server is bundled inside the plugin at `./server`,
and the extension itself has **no npm dependencies and no build step**.

## How it works

```
MCP client (Claude / Cursor)
        │  stdio / http
        ▼
Python FastMCP server  ── server/src/main.py
        │  WebSocket bridge  127.0.0.1:6020/cocosmcp
        ▼
Cocos Creator extension ── main.js (connects in as the WS client)
        │  Editor.Message.request(...)
        ▼
   Cocos editor (asset-db / scene API)
```

- The Python side is the WebSocket **server**; the Cocos extension is the **client** and dials in
  via the *Connect* button on the panel.
- Each tool call sends a JSON envelope over the bridge to the extension, which dispatches by command
  name to the matching handler, runs the editor operation, and replies `{id, success, data|error}`.

## Tools provided

| Tool | Purpose |
| --- | --- |
| `get_project_info` | Project path, assets root, editor version, scene list, available bridge commands |
| `manage_scene` | List / open / save scenes (Cocos 3.x `.scene`) |
| `manage_node` | Inspect or modify nodes in the current scene (mostly addressed by `uuid`) |
| `manage_asset` | Inspect and manipulate assets under `assets/` via the asset-db |
| `read_console` | Read / clear the editor console (500-entry ring buffer) |
| `execute_script` | Execute arbitrary JS in the editor main or scene context (powerful escape hatch) |

## Install into a project

Drop the whole `cocos-mcp-3x` folder into your Cocos project's `extensions/` directory:

```
<your-project>/extensions/cocos-mcp-3x/
```

> During development you can use a directory junction pointing at the plugin source so edits take
> effect immediately:
> `mklink /J "<project>\extensions\cocos-mcp-3x" "<plugin-source-path>"`

After restarting the editor (or reloading the extension), **Cocos MCP → Open Panel** appears in the menu.

## First run: create the Python environment

Requires **Python 3.10+** on your machine. Create a virtual environment inside the plugin's `server`
directory and install the dependencies:

```bat
cd cocos-mcp-3x\server
python -m venv .venv
.venv\Scripts\python -m pip install -e .
```

> `.venv` is **not distributed with the repo** (its `pyvenv.cfg` hardcodes the local Python path and
> it is large). Recreate it locally with the step above — the panel also surfaces this exact command
> when it can't find `python.exe`.

Dependencies: `fastmcp>=2.0.0`, `websockets>=12.0` (install `.[dev]` to also get `pytest`,
`pytest-asyncio`).

## Using the panel

1. Open the panel: menu **Cocos MCP → Open Panel**.
2. **Server dir** empty = use the plugin's bundled `./server` (recommended). Only fill in an absolute
   path to override when the server lives elsewhere.
3. Click **Start Server**; the hint line showing `python: found` means it's ready.
4. Click **Connect**; a green dot means the WebSocket bridge is connected.

## Configure the MCP client

The server entry point is `server/src/main.py` and supports two transports — `stdio` (client default)
and `http` (manual testing):

```bash
cd cocos-mcp-3x/server/src
python -m main --transport stdio                    # Claude Desktop / Cursor
python -m main --transport http --http-port 8765    # manual testing
```

Environment variables (precedence: CLI args > env vars > defaults):

| Variable | Default |
| --- | --- |
| `COCOS_MCP_BRIDGE_HOST` | `127.0.0.1` |
| `COCOS_MCP_BRIDGE_PORT` | `6020` |
| `COCOS_MCP_BRIDGE_PATH` | `/cocosmcp` |
| `COCOS_MCP_REQUEST_TIMEOUT` | `30` (seconds) |
| `COCOS_MCP_CONNECT_TIMEOUT` | `5` (seconds) |

## Directory layout

```
cocos-mcp-3x/
├── main.js            Extension main process (WebSocket client + command handlers)
├── panel/index.js     Panel UI (start server / connect)
├── scene.js           Scene-context script (evalInScene)
├── package.json
├── SETUP.md           Detailed install & distribution notes
└── server/            Bundled Python MCP server
    ├── src/           Entry main.py; core/transport/services/utils
    ├── pyproject.toml
    └── .venv/         Python virtual environment (generated locally, not committed)
```

## Extending: add a tool

1. Create `server/src/services/tools/<name>.py`, decorate an async function with
   `@cocos_mcp_tool(description=...)`, and `return await call_bridge("<name>", params)`
   (see `get_project_info.py`). No manual registration — tools are auto-discovered on startup.
2. Add a matching command handler in `main.js`. Both ends must agree on the command name and param shape.

## Requirements

- Cocos Creator 3.8.0+
- Python 3.10+

## License

MIT
