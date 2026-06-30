# cocos-mcp-3x

**English** · [中文](./README.zh-CN.md)

An editor extension that connects an LLM (Claude Desktop / Cursor or any MCP client) to the
**Cocos Creator 3.7–3.8.x** editor, letting the model inspect and drive your game project: read/write
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
| `read_console` | Read / clear the log buffer (500-entry ring) — **includes both editor logs and the running game's own logs from the browser preview** |
| `execute_script` | Execute arbitrary JS in the editor main or scene context (powerful escape hatch) |

> **Reading logs? Always use `read_console`.** It returns both editor logs and the running game's
> browser-preview console (`cc.log` / `console.*`); pass `sources=["runtime"]` for game-only,
> `levels=["error"]` for errors. Do **not** use a generic browser-automation tool (e.g.
> claude-in-chrome) to read a Cocos game's console — it can't reach the editor's preview tab.

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

> **Behind a slow/blocked PyPI** (e.g. in mainland China), the install often times out. Add a mirror:
>
> ```bat
> .venv\Scripts\python -m pip install -e . -i https://pypi.tuna.tsinghua.edu.cn/simple
> ```

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

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Panel shows **python: NOT FOUND** | `server\.venv` isn't created yet. Run the "first run" venv steps above; the panel re-checks every 1.5s. |
| `pip install` keeps **timing out** | PyPI unreachable. Add a mirror, e.g. `-i https://pypi.tuna.tsinghua.edu.cn/simple`. |
| Start Server says **port in use / not listening** | Change **Bridge port** (default 6020) or **HTTP port** (default 8765) to a free port, then Start. Server URL follows the Bridge port automatically. |
| Confused by the two ports | **Bridge port** is the internal WebSocket channel (extension ↔ Python server); **HTTP port** is what the MCP client connects to (`http://127.0.0.1:8765/mcp/`). |
| Connect won't turn green | Make sure Start Server is running, and Connect uses the same Bridge port you started with. |
| No **Cocos MCP** menu | Ensure the plugin is under the project's `extensions/`, then reload the extension or restart the editor. |

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

## Browser-preview runtime logs (`source: "runtime"`)

The editor process can't see the `cc.log` / `console.*` a game emits in the **browser preview**.
After you enable "浏览器预览日志捕获 / runtime log capture" in the panel, the extension:

1. Starts a lightweight HTTP receiver in the extension process (port = bridge port + 1, default `6021`);
2. Writes a project preview template that reproduces the editor's default 3.x preview page (keeping
   the `cocosToolBar` / `cocosTemplate` EJS includes so the engine still boots) plus a reporter
   script. The reporter hooks `console.*` (web-side `cc.log` routes through `console`) and forwards
   each entry via `navigator.sendBeacon` into the same ring buffer, tagged `source: "runtime"`.

Template location follows the Creator version: **3.8.3+** uses `<project>/templates/preview-template/`,
older 3.x uses `<project>/preview-template/`. Handling is in-place and non-destructive:

- If a preview template (`index.ejs` / `index.html`) already exists, the reporter block is injected
  before `</body>`, fenced with `COCOS-MCP-LOG-START / END` comments.
- If none exists, a standalone `index.ejs` is generated (default preview page + reporter block).
- On **disable**, only the fenced block is stripped (your template is preserved); a self-generated
  template is deleted.

So `read_console` returns editor + browser-runtime logs together. While play-testing use
`read_console(sources=["runtime"])` for game-only logs, and `levels=["error"]` for errors only.

Common query filters (`read_console` params):

- `sources=["runtime"]` for game logs; after editing scripts/scenes use `sources=["editor"]` for compile errors.
- `levels=["warn","error"]` for warnings/errors only.
- `contains="S2C_"` (or your app's log prefix) for one protocol/module. Heartbeat noise dominates —
  always filter with `contains` when diagnosing.
- `since=<previous nextCursor>` to pull only new entries; `count` defaults to 50, capped at 500.
- `action="clear"` empties the buffer.

Notes:

- **Enabling requires one editor restart** (Cocos caches the preview template); then preview as "Browser".
- This only affects **preview**, not production builds.

### Maintenance note: how an AI "knows" these logs exist

**An AI does not read this README.** Everything it knows about a tool comes from that tool's
`description` (the string in `@cocos_mcp_tool(description=...)` in
`server/src/services/tools/<tool>.py`) — the only "manual" an AI reads automatically. So to teach an
AI a capability, edit that tool's `description`, not the README. After editing, **Stop → Start the
server** (descriptions register at server start) and have the MCP client **reconnect / refresh
tools** (clients cache the tool list).

## Requirements

- Cocos Creator 3.7.0 – 3.8.x
- Python 3.10+

## License

MIT
