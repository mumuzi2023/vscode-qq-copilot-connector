const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { NCatSidebarProvider } = require('./sidebar/sidebar-provider.cjs');
const { NCatRuntime } = require('./runtime/ncat-runtime.cjs');
const { QQBotRuntime } = require('./runtime/qqbot-runtime.cjs');
const { askForTarget, askForMessage, ensureConnectedWithPrompt } = require('./commands/prompt-utils.cjs');

const QQBOT_MCP_PROVIDER_ID = 'tudou0133.ncat-vscode-qq.qqbot-mcp';

/** @type {NCatRuntime | undefined} */
let runtime;

/** @type {NCatSidebarProvider | undefined} */
let sidebarProvider;

function createRuntime(context) {
  const config = vscode.workspace.getConfiguration();
  const mode = String(config.get('ncat.backendMode', 'ncat') || 'ncat').trim().toLowerCase();
  if (mode === 'qqbot') {
    return new QQBotRuntime(context);
  }
  return new NCatRuntime(context);
}

function registerQQBotMcpProvider(context) {
  if (!vscode.lm || typeof vscode.lm.registerMcpServerDefinitionProvider !== 'function') {
    return undefined;
  }

  const provider = {
    provideMcpServerDefinitions() {
      const config = vscode.workspace.getConfiguration();
      const appId = String(config.get('ncat.qqbotAppId', '') || '').trim();
      const clientSecret = String(config.get('ncat.qqbotClientSecret', '') || '').trim();
      if (!appId || !clientSecret) {
        return [];
      }

      const botName = String(config.get('ncat.qqbotBotName', 'QQBot') || 'QQBot').trim() || 'QQBot';
      const markdownSupport = Boolean(config.get('ncat.qqbotMarkdownSupport', false));
      const primaryChatType = String(config.get('ncat.qqbotPrimaryChatType', '') || '').trim().toLowerCase();
      const primaryChatId = String(config.get('ncat.qqbotPrimaryChatId', '') || '').trim();
      const mcpScript = path.join(context.extensionPath, 'src', 'mcp', 'qqbot-mcp-server.cjs');
      const logDir = context.globalStorageUri?.fsPath || context.logUri?.fsPath || path.join(context.extensionPath, '.ncat-logs');
      try {
        fs.mkdirSync(logDir, { recursive: true });
      } catch {
      }
      const logFile = path.join(logDir, 'qqbot-mcp.log');
      const cacheFile = path.join(logDir, 'qqbot-mcp-cache.json');
      const stateFile = path.join(logDir, 'qqbot-mcp-state.json');

      return [
        new vscode.McpStdioServerDefinition(
          `${botName} MCP`,
          process.execPath,
          [mcpScript],
          {
            ...process.env,
            QQBOT_MCP_APP_ID: appId,
            QQBOT_MCP_CLIENT_SECRET: clientSecret,
            QQBOT_MCP_BOT_NAME: botName,
            QQBOT_MCP_MARKDOWN_SUPPORT: markdownSupport ? 'true' : 'false',
            QQBOT_MCP_LOG_FILE: logFile,
            QQBOT_MCP_CACHE_FILE: cacheFile,
            QQBOT_MCP_STATE_FILE: stateFile,
            QQBOT_MCP_DEFAULT_CHAT_TYPE: primaryChatType,
            QQBOT_MCP_DEFAULT_CHAT_ID: primaryChatId,
          },
          '0.1.0'
        ),
      ];
    },
  };

  return vscode.lm.registerMcpServerDefinitionProvider(QQBOT_MCP_PROVIDER_ID, provider);
}

function activate(context) {
  runtime = createRuntime(context);
  sidebarProvider = new NCatSidebarProvider(runtime);
  const qqbotMcpProvider = registerQQBotMcpProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('ncat.sidebarView', sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const connect = vscode.commands.registerCommand('ncat.connect', async () => {
    await runtime.startPluginRuntime({
      silent: false,
      reason: 'command-connect',
    });
  });

  const disconnect = vscode.commands.registerCommand('ncat.disconnect', async () => {
    await runtime.stopPluginRuntime({
      trigger: 'command-disconnect',
    });
  });

  const bossKey = vscode.commands.registerCommand('ncat.bossKey', async () => {
    await vscode.commands.executeCommand('workbench.view.explorer');
  });

  const startBackend = vscode.commands.registerCommand('ncat.startBackend', async () => {
    const result = await runtime.startBackend({
      force: true,
      trigger: 'command-start-backend',
    });
    if (!result?.ok) {
      vscode.window.showWarningMessage(`Local backend start failed: ${result?.reason || 'unknown error'}`);
      return;
    }
    vscode.window.setStatusBarMessage('Local backend launch requested', 2500);
  });

  const sendPrivateMessage = vscode.commands.registerCommand('ncat.sendPrivateMessage', async () => {
    const ready = await ensureConnectedWithPrompt(runtime);
    if (!ready) {
      return;
    }

    const mode = String(vscode.workspace.getConfiguration().get('ncat.backendMode', 'ncat') || 'ncat').trim().toLowerCase();
    const digitsOnly = mode !== 'qqbot';
    const userId = await askForTarget(
      mode === 'qqbot' ? 'Target QQBot user openid' : 'Target QQ number',
      mode === 'qqbot' ? 'Example: user_openid' : 'Example: 2580453344',
      { digitsOnly }
    );
    if (!userId) {
      return;
    }

    const message = await askForMessage();
    if (!message) {
      return;
    }

    try {
      const result = await runtime.sendPrivateMessage(userId, message);
      const messageId = result?.data?.message_id;
      runtime.log(messageId ? `send_private_msg success. message_id=${messageId}` : 'send_private_msg success.');
      vscode.window.showInformationMessage(
        messageId ? `Message sent successfully (id=${messageId}).` : 'Message sent successfully.'
      );
    } catch (error) {
      runtime.log(`send_private_msg failed: ${error?.message || String(error)}`);
      vscode.window.showErrorMessage(`Failed to send private message: ${error?.message || String(error)}`);
    }
  });

  const sendGroupMessage = vscode.commands.registerCommand('ncat.sendGroupMessage', async () => {
    const ready = await ensureConnectedWithPrompt(runtime);
    if (!ready) {
      return;
    }

    const mode = String(vscode.workspace.getConfiguration().get('ncat.backendMode', 'ncat') || 'ncat').trim().toLowerCase();
    const digitsOnly = mode !== 'qqbot';
    const groupId = await askForTarget(
      mode === 'qqbot' ? 'Target QQBot group_openid' : 'Target Group number',
      mode === 'qqbot' ? 'Example: group_openid' : 'Example: 123456789',
      { digitsOnly }
    );
    if (!groupId) {
      return;
    }

    const message = await askForMessage();
    if (!message) {
      return;
    }

    try {
      const result = await runtime.sendGroupMessage(groupId, message);
      const messageId = result?.data?.message_id;
      runtime.log(messageId ? `send_group_msg success. message_id=${messageId}` : 'send_group_msg success.');
      vscode.window.showInformationMessage(
        messageId ? `Group message sent (id=${messageId}).` : 'Group message sent successfully.'
      );
    } catch (error) {
      runtime.log(`send_group_msg failed: ${error?.message || String(error)}`);
      vscode.window.showErrorMessage(`Failed to send group message: ${error?.message || String(error)}`);
    }
  });

  const showLogs = vscode.commands.registerCommand('ncat.showLogs', () => {
    runtime.showLogs();
  });

  const authorizeAI = vscode.commands.registerCommand('ncat.authorizeAI', async () => {
    if (typeof runtime.prepareLanguageModelAccess !== 'function') {
      vscode.window.showInformationMessage('Current backend mode does not use QQBot AI auto-reply.');
      return;
    }
    try {
      const result = await runtime.prepareLanguageModelAccess();
      if (result?.ok) {
        vscode.window.showInformationMessage(`AI access is ready: ${result.modelName || 'model selected'}`);
      } else {
        vscode.window.showWarningMessage(result?.reason || 'AI access could not be prepared.');
      }
    } catch (error) {
      vscode.window.showErrorMessage(`AI authorization failed: ${error?.message || String(error)}`);
    }
  });

  context.subscriptions.push(
    connect,
    disconnect,
    bossKey,
    startBackend,
    sendPrivateMessage,
    sendGroupMessage,
    authorizeAI,
    showLogs,
    qqbotMcpProvider,
    runtime,
    sidebarProvider
  );

  const config = vscode.workspace.getConfiguration();
  if (config.get('ncat.autoConnect', true)) {
    runtime.startPluginRuntime({
      silent: true,
      reason: 'auto-connect',
    });
  }
}

async function deactivate() {
  if (sidebarProvider) {
    sidebarProvider.dispose();
    sidebarProvider = undefined;
  }

  if (runtime) {
    await runtime.shutdownForDeactivate();
    runtime = undefined;
  }

}

module.exports = {
  activate,
  deactivate,
};
