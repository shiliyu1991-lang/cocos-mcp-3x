# cocos-mcp-3x

把 LLM（Claude Desktop / Cursor 等 MCP 客户端）接入 **Cocos Creator 3.8.x** 编辑器的插件，
让大模型能够检视并驱动你的游戏工程：读写节点、操作资源与场景、查看控制台、执行脚本。

插件**自包含**：Python MCP 服务器就打包在插件目录内的 `./server`，扩展本身**无任何 npm 依赖、无构建步骤**。

## 工作原理

```
MCP 客户端 (Claude / Cursor)
        │  stdio / http
        ▼
Python FastMCP 服务器  ── server/src/main.py
        │  WebSocket 桥  127.0.0.1:6020/cocosmcp
        ▼
Cocos Creator 扩展     ── main.js（作为 WS 客户端连入）
        │  Editor.Message.request(...)
        ▼
   Cocos 编辑器（asset-db / scene API）
```

- Python 端是 WebSocket **服务端**，Cocos 扩展是**客户端**，由面板上的 *Connect* 按钮主动连入。
- 每个工具调用都通过桥发一个 JSON 信封到扩展，扩展按命令名分发给对应处理器，执行编辑器操作后回传 `{id, success, data|error}`。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `get_project_info` | 工程路径、assets 根、编辑器版本、场景列表、可用桥命令 |
| `manage_scene` | 列出 / 打开 / 保存场景（Cocos 3.x `.scene`） |
| `manage_node` | 检视或修改当前场景中的节点（多数操作按 `uuid`） |
| `manage_asset` | 通过 asset-db 检视和操作 `assets/` 下的资源 |
| `read_console` | 读取 / 清空编辑器控制台（500 条环形缓冲） |
| `execute_script` | 在编辑器主上下文或场景上下文执行任意 JS（强力逃生舱） |

## 安装到项目

把整个 `cocos-mcp-3x` 文件夹放到 Cocos 项目的 `extensions/` 目录下：

```
<你的项目>/extensions/cocos-mcp-3x/
```

> 开发时也可以用目录链接（junction）指向插件源码，改动即时生效：
> `mklink /J "<项目>\extensions\cocos-mcp-3x" "<插件源码路径>"`

重启编辑器（或重新加载扩展）后，菜单里会出现 **Cocos MCP → Open Panel**。

## 首次使用：创建 Python 环境

需要本机安装 **Python 3.10+**。在插件的 `server` 目录里创建虚拟环境并安装依赖：

```bat
cd cocos-mcp-3x\server
python -m venv .venv
.venv\Scripts\python -m pip install -e .
```

> `.venv` **不随仓库分发**（`pyvenv.cfg` 写死了本机 Python 路径，且体积大）。
> 拿到插件后各自按此步骤创建即可。面板在检测不到 `python.exe` 时也会直接给出这条命令。

依赖：`fastmcp>=2.0.0`、`websockets>=12.0`（装 `.[dev]` 额外带 `pytest`、`pytest-asyncio`）。

## 在面板里使用

1. 打开面板：菜单 **Cocos MCP → Open Panel**。
2. **Server dir** 留空 = 使用插件自带的 `./server`（推荐）。只有服务器在别处时才填绝对路径覆盖。
3. 点 **Start Server**，提示行显示 `python: found` 即就绪。
4. 点 **Connect**，绿点亮起表示 WebSocket 桥已连通。

## 配置 MCP 客户端

服务器入口为 `server/src/main.py`，支持 `stdio`（客户端默认）与 `http`（手动测试）两种传输：

```bash
cd cocos-mcp-3x/server/src
python -m main --transport stdio                    # Claude Desktop / Cursor
python -m main --transport http --http-port 8765    # 手动测试
```

环境变量（优先级 CLI 参数 > 环境变量 > 默认值）：

| 变量 | 默认值 |
| --- | --- |
| `COCOS_MCP_BRIDGE_HOST` | `127.0.0.1` |
| `COCOS_MCP_BRIDGE_PORT` | `6020` |
| `COCOS_MCP_BRIDGE_PATH` | `/cocosmcp` |
| `COCOS_MCP_REQUEST_TIMEOUT` | `30`（秒） |
| `COCOS_MCP_CONNECT_TIMEOUT` | `5`（秒） |

## 目录结构

```
cocos-mcp-3x/
├── main.js            扩展主进程（WebSocket 客户端 + 命令处理）
├── panel/index.js     面板 UI（启动服务器 / 连接）
├── scene.js           场景上下文脚本（evalInScene）
├── package.json
├── SETUP.md           安装与分发详细说明
└── server/            内置的 Python MCP 服务器
    ├── src/           入口 main.py、core/transport/services/utils
    ├── pyproject.toml
    └── .venv/         Python 虚拟环境（本机生成，不入库）
```

## 扩展：新增一个工具

1. 在 `server/src/services/tools/` 新建 `<name>.py`，用 `@cocos_mcp_tool(description=...)` 装饰一个
   async 函数，`return await call_bridge("<name>", params)`（参考 `get_project_info.py`）。无需手动注册，
   启动时自动发现。
2. 在 `main.js` 加一个同名命令处理器。两端的命令名与参数结构需一致。

## 环境要求

- Cocos Creator 3.8.0+
- Python 3.10+

## License

MIT
