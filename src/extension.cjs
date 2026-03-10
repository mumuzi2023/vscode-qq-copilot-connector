const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vscode = require('vscode');
const { QQSidebarProvider } = require('./sidebar/sidebar-provider.cjs');
const { LocalBackendRuntime } = require('./runtime/local-backend-runtime.cjs');
const { QQBotRuntime } = require('./runtime/qqbot-runtime.cjs');
const { ChatBridge } = require('./chat/chat-bridge.cjs');
const { ChatOrchestrator } = require('./chat/chat-orchestrator.cjs');
const { CHAT_PARTICIPANT_ID, registerChatParticipant } = require('./chat/chat-participant.cjs');
const { WindowRouter } = require('./chat/window-router.cjs');
const { askForTarget, askForMessage, ensureConnectedWithPrompt } = require('./commands/prompt-utils.cjs');
const { LOG_DIR_NAME, SIDEBAR_VIEW_ID, commandId, getConfigValue } = require('./core/qq-connector.cjs');

const QQBOT_MCP_PROVIDER_ID = 'mumuzi2023.vscode-qq-copilot-connector.qqbot-mcp';
const QQBOT_MCP_SCRIPT_PATH = ['dist', 'mcp', 'qqbot-mcp-server.cjs'];
const QQ_ASSISTANT_HANDLE = '@qq';

function quoteCommandArg(value) {
  const text = String(value || '');
  if (!text) {
    return '""';
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function readProductMetadata() {
  try {
    const productFile = path.join(vscode.env.appRoot, 'product.json');
    if (!fs.existsSync(productFile)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(productFile, 'utf8')) || {};
  } catch {
    return {};
  }
}

function resolveVsCodeLauncher() {
  const appRoot = String(vscode.env.appRoot || '').trim();
  const product = readProductMetadata();
  const installRoot = appRoot ? path.resolve(appRoot, '..', '..') : '';
  const applicationName = String(product.applicationName || 'code').trim() || 'code';
  const nameShort = String(product.nameShort || 'Code').trim() || 'Code';

  if (process.platform === 'win32') {
    const exeCandidates = [
      path.join(installRoot, `${nameShort}.exe`),
      path.join(installRoot, 'Code.exe'),
      path.join(installRoot, 'Code - Insiders.exe'),
    ];
    for (const candidate of exeCandidates) {
      if (candidate && fs.existsSync(candidate)) {
        return {
          command: candidate,
          useShell: false,
        };
      }
    }

    const cliCandidate = path.join(installRoot, 'bin', `${applicationName}.cmd`);
    if (cliCandidate && fs.existsSync(cliCandidate)) {
      return {
        command: cliCandidate,
        useShell: true,
      };
    }
  }

  return {
    command: process.execPath,
    useShell: false,
  };
}

/** @type {QQBotRuntime | LocalBackendRuntime | undefined} */
let runtime;

/** @type {QQSidebarProvider | undefined} */
let sidebarProvider;

/** @type {ChatBridge | undefined} */
let chatBridge;

/** @type {ChatOrchestrator | undefined} */
let chatOrchestrator;

/** @type {WindowRouter | undefined} */
let windowRouter;

async function pickFolderForNewWindow() {
  const folders = Array.isArray(vscode.workspace.workspaceFolders) ? vscode.workspace.workspaceFolders : [];
  if (folders.length === 0) {
    const entered = await vscode.window.showInputBox({
      prompt: 'Folder path to open in a new debug window',
      placeHolder: 'D:\\code\\qqbot\\some-workspace',
      ignoreFocusOut: true,
    });
    const fsPath = String(entered || '').trim();
    return fsPath ? vscode.Uri.file(fsPath) : undefined;
  }

  const picks = folders.map((folder, index) => ({
    label: `${index + 1}. ${folder.name}`,
    description: folder.uri.fsPath,
    uri: folder.uri,
  }));
  picks.push({
    label: 'Custom path',
    description: 'Enter another folder path',
    uri: null,
  });

  const choice = await vscode.window.showQuickPick(picks, {
    title: 'Open another debug window',
    placeHolder: 'Choose the folder to open in a new window',
    ignoreFocusOut: true,
  });
  if (!choice) {
    return undefined;
  }
  if (choice.uri) {
    return choice.uri;
  }

  const entered = await vscode.window.showInputBox({
    prompt: 'Folder path to open in a new debug window',
    placeHolder: 'D:\\code\\qqbot\\some-workspace',
    ignoreFocusOut: true,
  });
  const fsPath = String(entered || '').trim();
  return fsPath ? vscode.Uri.file(fsPath) : undefined;
}

async function openAnotherExtensionDevelopmentHost(context, targetUri) {
  const launcher = resolveVsCodeLauncher();
  const args = [
    '--new-window',
    targetUri.fsPath,
    `--extensionDevelopmentPath=${context.extensionPath}`,
  ];

  try {
    const child = launcher.useShell
      ? spawn('cmd.exe', ['/d', '/s', '/c', `${quoteCommandArg(launcher.command)} ${args.map(quoteCommandArg).join(' ')}`], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        })
      : spawn(launcher.command, args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
    child.unref();
    runtime?.log?.(`additional extension development host launch requested: launcher=${launcher.command}, target=${targetUri.fsPath}`);
    return true;
  } catch (error) {
    runtime?.log?.(`failed to open additional extension development host: ${error?.message || String(error)}`);
    return false;
  }
}

function createRuntime(context) {
  const config = vscode.workspace.getConfiguration();
  const mode = String(getConfigValue(config, 'backendMode', 'qqbot') || 'qqbot').trim().toLowerCase();
  if (mode === 'qqbot') {
    return new QQBotRuntime(context);
  }
  return new LocalBackendRuntime(context);
}

function registerQQBotMcpProvider(context) {
  if (!vscode.lm || typeof vscode.lm.registerMcpServerDefinitionProvider !== 'function') {
    return undefined;
  }

  const provider = {
    provideMcpServerDefinitions() {
      const config = vscode.workspace.getConfiguration();
      const appId = String(getConfigValue(config, 'qqbotAppId', '') || '').trim();
      const clientSecret = String(getConfigValue(config, 'qqbotClientSecret', '') || '').trim();
      if (!appId || !clientSecret) {
        return [];
      }

      const botName = String(getConfigValue(config, 'qqbotBotName', 'QQBot') || 'QQBot').trim() || 'QQBot';
      const markdownSupport = Boolean(getConfigValue(config, 'qqbotMarkdownSupport', false));
      const primaryChatType = String(getConfigValue(config, 'qqbotPrimaryChatType', '') || '').trim().toLowerCase();
      const primaryChatId = String(getConfigValue(config, 'qqbotPrimaryChatId', '') || '').trim();
      const mcpScript = path.join(context.extensionPath, ...QQBOT_MCP_SCRIPT_PATH);
      const logDir = context.globalStorageUri?.fsPath || context.logUri?.fsPath || path.join(context.extensionPath, LOG_DIR_NAME);
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
  chatOrchestrator = new ChatOrchestrator({
    getAgentConfig: () => (typeof runtime?.getAgentConfig === 'function'
      ? runtime.getAgentConfig()
      : {
          useTools: true,
          modelVendor: 'copilot',
          modelFamily: '',
          systemPrompt: '你是在 VS Code 中运行的 QQ 助手。回答要直接、简洁、准确。必要时可以调用可用工具。',
          maxToolRounds: 4,
        }),
    log: (message) => runtime?.log?.(message),
  });
  windowRouter = new WindowRouter(context, () => chatOrchestrator, {
    log: (message) => runtime?.log?.(message),
  });
  chatOrchestrator.setWindowRouter(windowRouter);
  windowRouter.start();
  sidebarProvider = new QQSidebarProvider(runtime);
  chatBridge = new ChatBridge(context, () => runtime, () => chatOrchestrator);
  const qqbotMcpProvider = registerQQBotMcpProvider(context);
  const chatParticipant = registerChatParticipant(context, chatOrchestrator);

  if (runtime && typeof runtime.setChatOrchestrator === 'function') {
    runtime.setChatOrchestrator(chatOrchestrator);
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const connect = vscode.commands.registerCommand(commandId('connect'), async () => {
    await runtime.startPluginRuntime({
      silent: false,
      reason: 'command-connect',
    });
  });

  const disconnect = vscode.commands.registerCommand(commandId('disconnect'), async () => {
    await runtime.stopPluginRuntime({
      trigger: 'command-disconnect',
    });
  });

  const bossKey = vscode.commands.registerCommand(commandId('bossKey'), async () => {
    await vscode.commands.executeCommand('workbench.view.explorer');
  });

  const startBackend = vscode.commands.registerCommand(commandId('startBackend'), async () => {
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

  const sendPrivateMessage = vscode.commands.registerCommand(commandId('sendPrivateMessage'), async () => {
    const ready = await ensureConnectedWithPrompt(runtime);
    if (!ready) {
      return;
    }

    const mode = String(getConfigValue(vscode.workspace.getConfiguration(), 'backendMode', 'qqbot') || 'qqbot').trim().toLowerCase();
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

  const sendGroupMessage = vscode.commands.registerCommand(commandId('sendGroupMessage'), async () => {
    const ready = await ensureConnectedWithPrompt(runtime);
    if (!ready) {
      return;
    }

    const mode = String(getConfigValue(vscode.workspace.getConfiguration(), 'backendMode', 'qqbot') || 'qqbot').trim().toLowerCase();
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

  const showLogs = vscode.commands.registerCommand(commandId('showLogs'), () => {
    runtime.showLogs();
  });

  const redirectToVsCodeChat = vscode.commands.registerCommand(commandId('redirectToVsCodeChat'), async () => {
    const message = await askForMessage();
    if (!message) {
      return;
    }
    try {
      const result = await chatBridge.submitRemoteRequest({
        source: 'manual',
        sessionKey: `manual:${Date.now()}`,
        message,
        mode: 'panel',
        autoSend: true,
      }, {
        source: 'manual',
      });
      if (result?.mirrored?.ok && result.mirrored.text) {
        runtime.log(`chat redirect mirror result: ${result.mirrored.text}`);
      }
      vscode.window.showInformationMessage('Message handled by the QQ assistant bridge.');
    } catch (error) {
      runtime.log(`chat redirect failed: ${error?.message || String(error)}`);
      vscode.window.showErrorMessage(`Failed to redirect to VS Code Chat: ${error?.message || String(error)}`);
    }
  });

  const openQQAssistantChat = vscode.commands.registerCommand(commandId('openQQAssistantChat'), async () => {
    const prompt = await vscode.window.showInputBox({
      prompt: 'Optional prompt for QQ Assistant',
      placeHolder: 'Leave empty to just open the chat with @qq selected',
      ignoreFocusOut: true,
    });
    if (prompt === undefined) {
      return;
    }

    const query = prompt.trim() ? `${QQ_ASSISTANT_HANDLE} ${prompt.trim()}` : `${QQ_ASSISTANT_HANDLE} `;
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query });
    } catch {
      await vscode.commands.executeCommand('workbench.action.chat.open', { message: query, autoSend: false });
    }
  });

  const openAnotherDebugWindow = vscode.commands.registerCommand(commandId('openAnotherDebugWindow'), async () => {
    const targetUri = await pickFolderForNewWindow();
    if (!targetUri) {
      return;
    }
    const started = await openAnotherExtensionDevelopmentHost(context, targetUri);
    if (!started) {
      vscode.window.showWarningMessage('Failed to start another Extension Development Host window.');
      return;
    }
    vscode.window.showInformationMessage(`Launching another Extension Development Host for ${targetUri.fsPath}`);
  });

  const authorizeAI = vscode.commands.registerCommand(commandId('authorizeAI'), async () => {
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
    redirectToVsCodeChat,
    openQQAssistantChat,
    openAnotherDebugWindow,
    authorizeAI,
    showLogs,
    qqbotMcpProvider,
    chatParticipant,
    windowRouter,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (chatBridge && chatBridge.affectsConfiguration(event)) {
        chatBridge.syncServer().catch((error) => {
          runtime?.log(`chat bridge sync failed: ${error?.message || String(error)}`);
        });
      }
    }),
    chatBridge,
    runtime,
    sidebarProvider
  );

  const config = vscode.workspace.getConfiguration();
  if (getConfigValue(config, 'autoConnect', true)) {
    runtime.startPluginRuntime({
      silent: true,
      reason: 'auto-connect',
    });
  }
  chatBridge.syncServer().catch((error) => {
    runtime?.log(`chat bridge start failed: ${error?.message || String(error)}`);
  });
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

  if (chatBridge) {
    chatBridge.dispose();
    chatBridge = undefined;
  }

  if (windowRouter) {
    windowRouter.dispose();
    windowRouter = undefined;
  }

  chatOrchestrator = undefined;

}

module.exports = {
  activate,
  deactivate,
};
