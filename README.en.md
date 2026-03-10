# VS Code QQ Copilot Connector

[中文说明](./README.md)

QQ Copilot Connector brings QQ conversations, VS Code Chat, language models, and MCP tools into a single workflow.

![Extension preview](images/preview.png)

## Overview

This extension uses the QQ official Bot API as its default connection mode, embeds QQ conversations into the VS Code sidebar, and provides an `@qq` assistant entry inside VS Code Chat.

## Features

- QQ conversation list and chat detail view inside the VS Code sidebar
- QQ private and group text messaging through the QQ official Bot API
- Image sending and QQBot markdown text mode
- VS Code Chat participant `@qq`
- QQBot MCP tools for Copilot integration
- QQ remote auto-reply with model and tool support
- `y/n` confirmation flow for sensitive remote tool execution
- Multi-window system commands: `@list`, `@path`, `@model`
- Theme-aware chat UI with image and video preview
- Reply quoting, merged-forward preview, sticker panel, and JSON message sending
- Anonymized private-chat labels for openid-based QQ conversations

## What You Can Do

- Read and reply to QQ messages without leaving VS Code
- Use `@qq` in VS Code Chat and share the same assistant flow with QQ-side requests
- Let Copilot call QQBot MCP tools to send messages, inspect contacts, and read cached chat history
- Route remote requests to different VS Code windows when working with multiple workspaces
- Review and approve higher-risk actions from QQ by replying `y` or `n`

## Built-in MCP Tools

- `qqbot_send_private_message`
- `qqbot_send_group_message`
- `qqbot_configure_primary_conversation`
- `qqbot_list_messages`
- `qqbot_list_contacts`
- `qqbot_list_people`
- `qqbot_get_status`

## Quick Start

![Quick start](images/step.png)

1. Register a QQ bot at [QQ Bot Open Platform](https://q.qq.com/qqbot/openclaw/index.html).
2. Install the extension.
3. Open the extension settings and fill in your QQBot AppID and ClientSecret.
4. Connect QQBot.
5. Use the sidebar for QQ conversations, or open VS Code Chat and talk to `@qq`.

## Remote System Commands

- `@list`: list currently registered VS Code windows and workspace paths
- `@path`: route the current remote session to a specific window by index or path
- `@model`: show available models for the current target window, with the active model first

## Related Projects

- [sliverp/qqbot](https://github.com/sliverp/qqbot)
- [NapNeko/NapCatQQ](https://github.com/NapNeko/NapCatQQ)

## Notes

- QQBot credentials are required for the official API workflow.
- Some advanced actions require confirmation before execution.
- The extension is primarily designed around the QQBot workflow.

## License

MIT