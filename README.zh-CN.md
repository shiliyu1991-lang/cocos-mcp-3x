# cocos-mcp-3x

[English](./README.md) · **中文**

把 LLM（Claude Desktop / Cursor 等 MCP 客户端）接入 **Cocos Creator 3.7–3.8.x** 编辑器的插件，
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
| `read_console` | 读取 / 清空日志缓冲（500 条环形）——**同时含编辑器日志和浏览器预览里游戏自己的运行时日志** |
| `execute_script` | 在编辑器主上下文或场景上下文执行任意 JS（强力逃生舱） |

> **读日志一律用 `read_console`。** 它同时返回编辑器日志和运行中游戏在浏览器预览里的控制台
> （`cc.log` / `console.*`）；只看游戏日志传 `sources=["runtime"]`，只看报错加 `levels=["error"]`。
> **不要**用通用浏览器自动化工具（如 claude-in-chrome）去读 Cocos 游戏的控制台——它够不到编辑器的预览标签页。

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

> **国内网络注意**：直连 `pypi.org` 装依赖经常超时。请加国内镜像：
>
> ```bat
> .venv\Scripts\python -m pip install -e . -i https://pypi.tuna.tsinghua.edu.cn/simple
> ```
>
> （清华源，也可换阿里 `https://mirrors.aliyun.com/pypi/simple`。）

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

## 常见问题

| 现象 | 原因 / 解决 |
| --- | --- |
| 面板里 **python: NOT FOUND** | `server\.venv` 还没建。按上面「首次使用」创建虚拟环境即可；面板每 1.5 秒自动重新检测。 |
| `pip install` 一直 **超时 / Read timed out** | 直连 pypi.org 不通。加国内镜像 `-i https://pypi.tuna.tsinghua.edu.cn/simple`（见上）。 |
| 点 Start Server 后报 **端口被占用 / 没监听** | 改 **Bridge port**（默认 6020）或 **HTTP port**（默认 8765）换一个空闲端口，再 Start。Server URL 会自动跟随 Bridge port。 |
| 分不清两个端口 | **Bridge port** 是扩展↔Python 服务器的内部 WebSocket 通道；**HTTP port** 才是 MCP 客户端要连的地址（`http://127.0.0.1:8765/mcp/`）。 |
| Connect 点了不亮绿点 | 先确认 Start Server 已 running；再确认 Connect 用的 Bridge port 和 Start 时一致。 |
| 菜单里找不到 **Cocos MCP** | 确认插件放在项目的 `extensions/` 下，并重新加载扩展或重启编辑器。 |

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

## 浏览器预览运行时日志（`source: "runtime"`）

编辑器进程看不到游戏在**浏览器预览**里跑出来的 `cc.log` / `console.*`。面板「浏览器预览日志捕获」
开启后会：

1. 在扩展进程内起一个轻量 HTTP 接收器（端口 = bridge 端口 + 1，默认 `6021`）；
2. 写入一份项目预览模板：复刻 3.x 默认预览页（保留 `cocosToolBar` / `cocosTemplate` 两个 EJS
   include，引擎照常启动），再加一段上报脚本。脚本 hook `console.*`（web 端 `cc.log` 走 `console`）
   并通过 `navigator.sendBeacon` 把每条日志回传，落进同一个环形缓冲、标记 `source: "runtime"`。

模板位置随 Creator 版本：**3.8.3+** 用 `<project>/templates/preview-template/`，更早的 3.x 用
`<project>/preview-template/`。处理是**就地注入、不破坏你的模板**：

- 若已存在预览模板（`index.ejs` / `index.html`），把上报块注入到 `</body>` 前，用
  `COCOS-MCP-LOG-START / END` 注释围栏标记。
- 若不存在，才生成一份独立的 `index.ejs`（默认预览页 + 上报块）。
- **关闭**时只剥离围栏内的块（你的模板原样保留）；自己生成的那份则删除。

于是 `read_console` 能同时读到编辑器与浏览器运行时日志；play-test 时用 `read_console(sources=["runtime"])`
只看游戏日志，用 `levels=["error"]` 只看报错。

常用查询过滤（`read_console` 参数）：

- `sources=["runtime"]` 看游戏日志；改完脚本/场景后用 `sources=["editor"]` 查编译报错。
- `levels=["warn","error"]` 只看告警/报错。
- `contains="S2C_"`（或你 App 的日志前缀）只看某协议/模块。心跳噪音很多，排查时务必配合 `contains` 过滤。
- `since=<上次返回的 nextCursor>` 只拉新增条目；`count` 默认 50、上限 500。
- `action="clear"` 清空缓冲。

注意：

- **开启后需重启一次 Cocos Creator**（编辑器会缓存预览模板），之后预览时选「Browser」运行。
- 仅作用于**预览**，不影响正式构建。

### 维护备注：AI 怎么「知道」有这些日志

**AI 不读本 README**——它对每个工具的全部认知，来自该工具的 `description`（即
`server/src/services/tools/<工具>.py` 里 `@cocos_mcp_tool(description=...)` 那段文本），这是 AI 唯一会
自动读到的「说明书」。所以要让 AI 学会某能力，改的是工具 `description`，不是 README。改完后需
**Stop → Start 服务**（描述在 server 启动时注册）并让 MCP 客户端**重连 / 刷新工具**（客户端会缓存工具列表）。

## 环境要求

- Cocos Creator 3.7.0 ~ 3.8.x
- Python 3.10+

## License

MIT
