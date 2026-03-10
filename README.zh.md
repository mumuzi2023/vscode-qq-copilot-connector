# VS Code QQ Copilot Connector

[English](./README.md)

这个仓库应当只保留 VS Code 插件本身的源码，用于提交到新的仓库 `mumuzi2023/vscode-qq-copilot-connector`，不再夹带父级工作区代码、上游参考仓库内容或本地开发产物。

![插件预览](images/preview.png)

## 项目说明

VS Code QQ Copilot Connector 把 QQ 会话放进 VS Code 侧边栏，并在此基础上增加了适合 Copilot 调用的集成能力。当前代码同时支持两种后端模式：

- `ncat`：基于 NapCat / OneBot 的本地 QQ 接入
- `qqbot`：基于 QQ 官方 Bot API 的接入，并提供 MCP 工具给 Copilot 调用

当前插件已经包含：

- 侧边栏会话列表和聊天详情页
- 文本与图片发送
- QQBot MCP 服务注册
- MCP 可读取的联系人列表和消息缓存
- 跟随 VS Code 主题的 webview UI
- QQBot 模式下的本地头像与显示名定制

## 仓库边界

这个新仓库里建议只提交插件源码和相关资源：

- `src/`：扩展逻辑
- `images/`、`media/`：界面资源
- `scripts/`：扩展开发辅助脚本
- `package.json`、`package-lock.json`、`.vscodeignore`、`.gitignore`、`LICENSE`、README 等文档

不应提交以下本地产物：

- `node_modules/`
- `.vscode/`
- 本插件目录之外的父级工作区内容
- 运行缓存、日志、临时文件

## 开发与运行

### 环境要求

- Node.js 18+
- VS Code 1.85+
- 如果要测试 NCat 模式，建议在 Windows 上进行

### 安装依赖

```bash
npm install
```

### 调试方式

直接用 VS Code 打开当前插件目录，并启动 Extension Development Host。

### 后端模式

配置项 `ncat.backendMode` 支持：

- `ncat`：NapCat / OneBot 模式
- `qqbot`：QQ 官方 Bot API + MCP 模式

## 说明

- `qqbot` 模式需要有效的 AppID 和 ClientSecret。
- `ncat` 模式需要本地 NapCat / OneBot 环境。
- 本项目是第三方集成实现，与腾讯、NapCat 及下述参考项目没有官方隶属关系。

## Thanks To / 致谢

本项目在设计或实现上参考了以下仓库：

- `tudou0133/ncat-vscode-qq`：提供了扩展整体结构、侧边栏交互流程和早期 QQ 聊天 UI 实现参考
- `sliverp/qqbot`：提供了 QQ 官方 Bot API 通道集成思路以及相关后端行为参考
- `NapNeko/NapCatQQ`：为 `ncat` 模式提供了 NapCat 运行时与 OneBot 生态参考

感谢这些项目维护者公开他们的工作成果。