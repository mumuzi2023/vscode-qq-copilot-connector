# VS Code QQ Copilot Connector

[中文说明](./README.zh.md)

This repository is the standalone source tree for the VS Code extension only. It is intended for submission to the new repository at `mumuzi2023/vscode-qq-copilot-connector`, without bundling parent workspace code, upstream repositories, or local development artifacts.

![Extension preview](images/preview.png)

## Overview

VS Code QQ Copilot Connector embeds QQ conversations into the VS Code sidebar and adds Copilot-friendly integration on top of them. The current codebase supports two backend modes:

- NCat / OneBot mode for local NapCat-based QQ access
- QQBot official API mode with MCP tools for Copilot

The extension currently includes:

- Sidebar conversation list and chat detail view
- Text and image sending
- QQBot MCP server registration for Copilot tool calling
- Cached contact and message listing for MCP use
- Theme-aware webview UI
- Local avatar and chat display customization for QQBot mode

## Repository Scope

This repository should contain only the extension source and related assets:

- `src/` for extension logic
- `images/` and `media/` for UI assets
- `scripts/` for extension development helpers
- `package.json`, `package-lock.json`, `.vscodeignore`, `.gitignore`, `LICENSE`, and documentation files

It should not include local-only artifacts such as:

- `node_modules/`
- `.vscode/`
- parent workspace folders outside this extension
- nested runtime caches, logs, or temporary files

## Development

### Requirements

- Node.js 18+
- VS Code 1.85+
- Windows is recommended if you need to test the NCat backend flow

### Install

```bash
npm install
```

### Run

Open this folder in VS Code and start an Extension Development Host.

### Backends

`ncat.backendMode` supports:

- `ncat`: NapCat / OneBot integration
- `qqbot`: official QQ Bot API integration with MCP support

## Notes

- The QQBot mode depends on a valid AppID and ClientSecret.
- The NCat mode depends on a local NapCat / OneBot environment.
- This project is a third-party integration and is not affiliated with Tencent, NapCat, or the upstream projects referenced below.

## Thanks To

This project references ideas, structure, or implementation details from the following repositories:

- `tudou0133/ncat-vscode-qq`: base extension structure, sidebar workflow, and earlier QQ chat UI implementation
- `sliverp/qqbot`: QQ official Bot API channel integration patterns and related backend behavior
- `NapNeko/NapCatQQ`: NapCat runtime and OneBot-compatible ecosystem reference for the NCat mode

Thanks to the maintainers of those projects for publishing their work.
