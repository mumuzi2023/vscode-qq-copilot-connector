# VS Code QQ Copilot Connector

[English](./README.md)

这个仓库应当只保留 VS Code 插件本身的源码，用于提交到新的仓库 `mumuzi2023/vscode-qq-copilot-connector`，不再夹带父级工作区代码、上游参考仓库内容或本地开发产物。

![插件预览](images/preview.png)

## 项目说明

VS Code QQ Copilot Connector 把 QQ 会话放进 VS Code 侧边栏，并聚焦于 QQ 官方 Bot API 与可供 Copilot 直接调用的 MCP 能力。

当前插件已经包含：

- 侧边栏会话列表和聊天详情页
- 文本与图片发送
- QQBot MCP 服务注册
- MCP 可读取的联系人列表和消息缓存
- 跟随 VS Code 主题的 webview UI
- QQBot 模式下的本地头像与显示名定制

与 NCat 相关的旧说明已经归档到 [docs/archive-ncat.zh.md](./docs/archive-ncat.zh.md)。

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
- QQ 官方 Bot 所需的 AppID 和 ClientSecret

### 安装依赖

```bash
npm install
```

### 调试方式

直接用 VS Code 打开当前插件目录，并启动 Extension Development Host。

## 说明

- `qqbot` 模式需要有效的 AppID 和 ClientSecret。
- 配置好 QQBot 后，扩展会暴露可供 Copilot 调用的 MCP 工具。
- 本项目是第三方集成实现，与腾讯及下述参考项目没有官方隶属关系。

## Thanks To / 致谢

本项目在设计或实现上参考了以下仓库：

- `sliverp/qqbot`：提供了 QQ 官方 Bot API 通道集成思路以及相关后端行为参考

感谢这些项目维护者公开他们的工作成果。