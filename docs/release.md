# Release Guide

This repository already supports automated VSIX packaging, GitHub Release creation, and optional VS Code Marketplace publishing through GitHub Actions.

## Overview

Current workflow behavior:

1. `workflow_dispatch`: manually build the VSIX and upload it as a GitHub Actions artifact.
2. `push` of tags matching `v*`: build the VSIX, create a GitHub Release, and attach the VSIX file.
3. If `VSCE_PAT` is configured in repository secrets: publish the same VSIX to the VS Code Marketplace after the GitHub Release job succeeds.

Workflow file:

- `.github/workflows/package-extension.yml`

## Versioning Rules

Before creating a release tag:

1. Update `package.json` `version`.
2. Update `CHANGELOG.md` if needed.
3. Commit the version change.
4. Create a tag in the format `v<package.json version>`.

Example:

- `package.json` version is `0.0.1`
- then the tag must be `v0.0.1`

The workflow validates that the tag version matches `package.json`. If they do not match, the release job fails.

## Local Packaging

Useful local commands:

```bash
npm install
npm run check
npm run bundle
npm run package:vsix
```

Outputs:

- Bundled extension entry: `dist/extension.cjs`
- Bundled MCP entry: `dist/mcp/qqbot-mcp-server.cjs`
- VSIX package: `qq-copilot-connector.vsix`

`npm run package:vsix` automatically runs `vscode:prepublish`, which triggers the bundle step first.

## GitHub Actions Release Flow

### Manual package build

Use this when you only want a downloadable VSIX artifact without creating a GitHub Release.

1. Open GitHub Actions.
2. Run the `package-extension` workflow manually.
3. Download the `qq-copilot-connector-vsix` artifact from the workflow run.

### Tag-based release

Use this for an official release.

1. Confirm `package.json` version is correct.
2. Commit all intended changes.
3. Create and push the tag.

Example:

```bash
git tag v0.0.1
git push origin v0.0.1
```

After the tag is pushed, GitHub Actions will:

1. Install dependencies with `npm ci`.
2. Run `npm run check`.
3. Package the extension into a VSIX.
4. Upload the VSIX as an artifact.
5. Create a GitHub Release for the tag.
6. Attach `qq-copilot-connector.vsix` to the Release.

## VS Code Marketplace Publishing

Marketplace publishing is optional.

Required secret:

- `VSCE_PAT`: a Personal Access Token for `vsce publish`

If `VSCE_PAT` is not configured:

- GitHub Release still works.
- Marketplace publishing is skipped.

If `VSCE_PAT` is configured:

1. The tag workflow creates the GitHub Release.
2. The workflow downloads the VSIX artifact.
3. The workflow publishes that VSIX to the VS Code Marketplace.

## Repository Settings Checklist

Recommended repository configuration:

1. Ensure Actions are enabled.
2. Add the `VSCE_PAT` secret if Marketplace publishing is required.
3. Use protected tags or a release branch policy if you want stricter release control.
4. Make sure the `publisher` field in `package.json` matches the Marketplace publisher account.

## Troubleshooting

Common failure causes:

1. Tag does not match `package.json` version.
2. `VSCE_PAT` is missing or invalid.
3. Marketplace publisher does not match the `publisher` field in `package.json`.
4. Required files are missing from the package because `.vscodeignore` excludes too much.

Quick checks:

```bash
npm run check
npm run bundle
npm run package:vsix
```

If local packaging succeeds, CI failures are usually caused by tag naming, secrets, or Marketplace permissions.