# VS Code QQ Copilot Connector

[中文说明](./README.zh.md)

QQ Copilot Connector brings QQ conversations into VS Code and connects them with VS Code Chat, language models, and MCP tools.

![Extension preview](images/preview.png)

## Overview

This extension is designed for users who want to handle QQ conversations and VS Code AI workflows in one place. It uses the QQ official Bot API as the default connection mode and provides both a sidebar chat experience and a VS Code Chat participant.

## Features

- QQ conversation list and chat detail view inside the VS Code sidebar
- QQ private and group text messaging through the QQ official Bot API
- Image sending and QQBot markdown text mode
- VS Code Chat participant `@qq`
- QQBot MCP tools for Copilot integration
- QQ remote auto-reply with model and tool support
- `y/n` confirmation flow for sensitive remote tool execution
- Multi-window routing commands: `@list`, `@path`, `@model`
- Theme-aware chat UI with image and video preview
- Reply quoting, merged-forward preview, sticker panel, and JSON message sending
- Anonymized private-chat labels for openid-based QQ conversations

## What You Can Do

- Read and reply to QQ messages without leaving VS Code
- Use `@qq` in VS Code Chat and share the same assistant flow with QQ-side requests
- Let Copilot call QQBot MCP tools to send messages or inspect cached contacts and chat history
- Route remote requests to different VS Code windows when working with multiple workspaces
- Review and approve higher-risk actions from QQ by replying `y` or `n`

## Included MCP Tools

- `qqbot_send_private_message`
- `qqbot_send_group_message`
- `qqbot_configure_primary_conversation`
- `qqbot_list_messages`
- `qqbot_list_contacts`
- `qqbot_list_people`
- `qqbot_get_status`

## Quick Start

1. Install the extension.
2. Open the extension settings and fill in your QQBot AppID and ClientSecret.
3. Connect QQBot.
4. Use the sidebar for QQ conversations, or open VS Code Chat and talk to `@qq`.

## Remote System Commands

- `@list`: list currently registered VS Code windows and workspace paths
- `@path`: route the current remote session to a specific window by index or path
- `@model`: show available models for the current target window, with the active model first

## Screenshots

The current preview image is shown above. More screenshots can be updated later as the UI evolves.

## Notes

- QQBot credentials are required for the official API workflow.
- Some advanced actions can require confirmation before execution.
- The extension focuses on QQBot as the primary workflow.

## License

MIT
