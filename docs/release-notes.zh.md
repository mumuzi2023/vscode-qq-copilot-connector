# QQ Copilot Connector 0.0.1

这是项目的首个对外可安装发布版本，当前能力如下：

## 核心能力

- 在 VS Code 侧边栏提供 QQ 会话列表和聊天详情页。
- 默认接入 QQ 官方 Bot API，完成私聊/群聊消息收发。
- 支持文本、图片、QQBot Markdown 文本发送。
- 提供本地聊天缓存、搜索、会话隐藏、缓存清理。

## VS Code Chat 能力

- 注册 `@qq` Chat Participant，可在 VS Code Chat 内直接使用。
- 本地 VS Code Chat 与 QQ 远程消息共用同一套编排器、模型选择和工具调用流程。
- 支持在 VS Code Chat 中继续对话、整理步骤等 follow-up 场景。

## MCP 能力

- 自动注册 QQBot MCP 服务，供 Copilot 调用。
- 当前 MCP 工具包括：
  - `qqbot_send_private_message`
  - `qqbot_send_group_message`
  - `qqbot_configure_primary_conversation`
  - `qqbot_list_messages`
  - `qqbot_list_contacts`
  - `qqbot_list_people`
  - `qqbot_get_status`

## QQ 远程智能处理

- QQ 来消息后可自动触发模型处理并回发结果。
- 可调用 VS Code / MCP 工具完成代码、文件、终端、浏览器等任务。
- 对高风险动作支持 QQ 侧 `y/n` 二次确认。
- 对终端命令、VS Code 命令、打开浏览器等本地动作支持确认后直接执行。

## 多窗口与模型命令

- `@list`：列出当前所有已注册的 VS Code 窗口与工作区路径。
- `@path`：把当前 QQ 会话后续请求路由到指定窗口，可用序号或路径指定。
- `@model`：查看当前目标窗口可用模型列表，第一个为当前实际使用模型。

## 界面与体验

- Webview UI 跟随 VS Code 主题。
- 适配浅色 / 深色模式。
- 支持图片大图悬停预览、视频悬停播放（静音）。
- 支持回复引用、合并转发预览、JSON 消息发送、表情包面板。
- 对 QQ openid 私聊做匿名化显示，避免侧边栏直接暴露原始 openid。

## 当前发布边界

- 默认以 QQBot 官方 API 模式工作。
- 设置界面已收敛，只保留 QQBot 连接与安全相关配置。
- 本地兼容后端代码仍保留在仓库中，但不再作为默认使用路径。