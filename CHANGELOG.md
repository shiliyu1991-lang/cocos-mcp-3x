# 更新日志

本项目的所有重要变更都记录在此文件。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-06-27

### 新增

- **浏览器预览运行时日志捕获**（移植自 cocos-mcp-2x，适配 3.x）：面板新增「浏览器预览日志捕获」开关。开启后扩展会
  - 在扩展进程内起一个轻量 HTTP 接收器（端口 = bridge 端口 + 1，默认 `6021`）；
  - 写入项目预览模板，复刻 3.x 默认预览页（保留 `cocosToolBar` / `cocosTemplate` 两个 EJS include，引擎照常启动），并注入一段上报脚本，hook `console.*`（web 端 `cc.log` 走 `console`）经 `navigator.sendBeacon` 回传日志；
  - 日志落进同一个 500 条环形缓冲、标记 `source: "runtime"`，`read_console` 可同时读到编辑器与浏览器运行时日志。
  - 模板位置随 Creator 版本自适应：**3.8.3+** 用 `<project>/templates/preview-template/`，更早的 3.x 用 `<project>/preview-template/`。
  - 用 `cocos-mcp-3x runtime log reporter` 哨兵注释围栏标记，关闭时仅剥离注入块（不破坏用户自定义模板）；仅影响**预览**，不影响正式构建。

### 变更

- **强化 `read_console` 工具描述**：前置说明本工具同时捕获编辑器日志与运行中游戏的网页/预览日志，并明确指引「读 Cocos 游戏日志请用本工具，不要用 claude-in-chrome 等通用浏览器工具」。新增 `sources`（`editor` / `runtime`）过滤参数，补充 `levels` / `contains` / `since` 用法与兜底提示。
- README（中英双版）增补运行时日志说明、`read_console` 查询过滤技巧，以及「AI 怎么知道有这些日志」的维护备注。

## [0.3.0]

- cocos-mcp-3x 插件早期版本：端口对齐 server 默认值（bridge 6020 / http 8765），支持 Cocos 3.7；`manage_asset refresh` 改为 fire-and-forget；README 中英双版重构。
