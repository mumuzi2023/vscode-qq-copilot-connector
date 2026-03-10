# 发布说明

这个仓库已经支持通过 GitHub Actions 自动完成 VSIX 打包、GitHub Release 创建，以及可选的 VS Code Marketplace 发布。

## 流程概览

当前工作流的行为是：

1. `workflow_dispatch`：手动触发时，只打包 VSIX，并上传为 GitHub Actions artifact。
2. 推送匹配 `v*` 的 tag：自动打包 VSIX、创建 GitHub Release，并把 VSIX 作为 Release 附件上传。
3. 如果仓库配置了 `VSCE_PAT`：在 GitHub Release 成功后，继续把同一个 VSIX 发布到 VS Code Marketplace。

对应工作流文件：

- `.github/workflows/package-extension.yml`

## 版本号规则

正式发布前，建议按下面顺序操作：

1. 修改 `package.json` 里的 `version`。
2. 需要的话同步更新 `CHANGELOG.md`。
3. 提交版本变更。
4. 创建与版本号一致的 tag，格式必须是 `v<package.json version>`。

示例：

- `package.json` 中版本是 `0.0.1`
- 那么 tag 应该是 `v0.0.1`

工作流里已经做了版本校验。如果 tag 和 `package.json` 版本不一致，发布会直接失败。

## 本地打包命令

本地常用命令如下：

```bash
npm install
npm run check
npm run bundle
npm run package:vsix
```

产物说明：

- 扩展 bundle 入口：`dist/extension.cjs`
- MCP bundle 入口：`dist/mcp/qqbot-mcp-server.cjs`
- 最终安装包：`qq-copilot-connector.vsix`

其中 `npm run package:vsix` 会自动触发 `vscode:prepublish`，也就是先执行 bundle，再生成 VSIX。

## GitHub Actions 发布流程

### 方式一：只生成安装包

如果你只是想自动生成 VSIX，不想创建 GitHub Release，可以直接手动触发工作流：

1. 打开 GitHub Actions。
2. 手动运行 `package-extension`。
3. 在该次运行结果里下载 `qq-copilot-connector-vsix` artifact。

### 方式二：正式发布 Release

如果你要做正式发版，建议走 tag 流程：

1. 确认 `package.json` 版本号已经改好。
2. 提交准备发布的改动。
3. 创建并推送 tag。

示例：

```bash
git tag v0.0.1
git push origin v0.0.1
```

推送 tag 后，GitHub Actions 会自动执行：

1. `npm ci` 安装依赖。
2. 运行 `npm run check`。
3. 打包生成 VSIX。
4. 上传 VSIX 作为 artifact。
5. 创建对应 tag 的 GitHub Release。
6. 把 `qq-copilot-connector.vsix` 挂到 Release 附件里。

## 发布到 VS Code Marketplace

Marketplace 发布是可选项，不是强制步骤。

### 先确认你的发布者身份

你当前应使用的发布者身份是 `mumu2023`。

确认方式：

1. 打开 Visual Studio Marketplace 管理页：`https://marketplace.visualstudio.com/manage`
2. 左侧发布者列表中看到的发布者 ID 就是你的 publisher 身份。
3. 这个值必须与 `package.json` 里的 `publisher` 字段完全一致。

当前仓库已经改成：

- `publisher = mumu2023`

如果管理页左侧显示的是 `mumu2023`，那说明这个身份已经拿到了，不需要再额外创建别的名字。

### 如何创建 VSCE_PAT

GitHub Actions 自动发布到 Marketplace 需要一个 PAT，仓库 Secret 名称固定为：

- `VSCE_PAT`

创建方式：

1. 打开 Azure DevOps PAT 页面：`https://dev.azure.com/<你的组织>/_usersSettings/tokens`
2. 选择新建 Token。
3. 作用域至少包含与 Marketplace / Extension publishing 相关的发布权限。
4. 创建后复制这个 Token，后面只会显示一次。

然后到 GitHub 仓库页面：

1. `Settings`
2. `Secrets and variables`
3. `Actions`
4. 新建 Repository secret：`VSCE_PAT`
5. 把刚才的 PAT 粘进去保存。

需要的仓库 Secret：

- `VSCE_PAT`

如果没有配置 `VSCE_PAT`：

- GitHub Release 仍然会正常创建。
- Marketplace 发布步骤会被跳过。

如果已经配置 `VSCE_PAT`：

1. tag 工作流先创建 GitHub Release。
2. 再下载前面产出的 VSIX artifact。
3. 最后把该 VSIX 发布到 VS Code Marketplace。

当前工作流行为已经配置为：

1. 有 `VSCE_PAT` 时自动发布到 Marketplace。
2. 没有 `VSCE_PAT` 时自动跳过 Marketplace 发布，但 GitHub Release 仍会正常执行。

## 仓库配置检查清单

建议你至少确认下面几项：

1. 仓库已启用 GitHub Actions。
2. 如果需要 Marketplace 自动发布，仓库 Secrets 中已配置 `VSCE_PAT`。
3. `package.json` 里的 `publisher` 与 Marketplace 实际发布者账号一致。
4. 如果你希望发版更稳，可以对 tag 或 release 分支加保护策略。

## 常见问题

常见失败原因：

1. tag 和 `package.json` 版本不一致。
2. `VSCE_PAT` 没配或已失效。
3. Marketplace 发布者与 `package.json` 里的 `publisher` 不一致。
4. `.vscodeignore` 排除了不该排除的文件，导致打包缺内容。
5. 推送的是旧 tag，但没有把 tag 重新指向包含最新工作流的提交。

建议先本地做这三个检查：

```bash
npm run check
npm run bundle
npm run package:vsix
```

如果本地打包没问题，而 CI 失败，通常优先检查 tag 命名、仓库 Secret 和 Marketplace 权限。