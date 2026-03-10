const { exec } = require('node:child_process');
const { promisify } = require('node:util');
const vscode = require('vscode');

const execAsync = promisify(exec);

function clipText(value, max = 400) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}...`;
}

function textFromUnknown(value, depth = 0) {
  if (depth > 4 || value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => textFromUnknown(item, depth + 1))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof value !== 'object') {
    return String(value).trim();
  }

  const directKeys = ['text', 'value', 'markdown', 'message', 'prompt', 'content', 'body'];
  for (const key of directKeys) {
    if (key in value) {
      const text = textFromUnknown(value[key], depth + 1);
      if (text) {
        return text;
      }
    }
  }

  const nestedKeys = ['metadata', 'result', 'response', 'turns', 'parts', 'items'];
  for (const key of nestedKeys) {
    if (key in value) {
      const text = textFromUnknown(value[key], depth + 1);
      if (text) {
        return text;
      }
    }
  }

  return '';
}

function markdownishToText(value) {
  const text = textFromUnknown(value);
  return text || String(value || '').trim();
}

class ChatOrchestrator {
  constructor(options = {}) {
    this.logFn = typeof options.log === 'function' ? options.log : () => {};
    this.getAgentConfigFn = typeof options.getAgentConfig === 'function' ? options.getAgentConfig : () => ({
      useTools: true,
      modelVendor: 'copilot',
      modelFamily: '',
      systemPrompt: '你是在 VS Code 中运行的 QQ 助手。回答要直接、简洁、准确。必要时可以调用可用工具。',
      maxToolRounds: 4,
    });
    this.remoteSessions = new Map();
    this.remoteRouteSelections = new Map();
    this.windowRouter = options.windowRouter;
  }

  log(message) {
    this.logFn(`[chat-orchestrator] ${message}`);
  }

  getAgentConfig() {
    return this.getAgentConfigFn();
  }

  setWindowRouter(windowRouter) {
    this.windowRouter = windowRouter;
  }

  getWorkspaceSummary() {
    const folders = Array.isArray(vscode.workspace.workspaceFolders) ? vscode.workspace.workspaceFolders : [];
    if (folders.length === 0) {
      return '当前未打开任何工作区文件夹。';
    }
    return folders
      .map((folder, index) => `${index + 1}. ${folder.name}: ${folder.uri?.fsPath || folder.uri?.path || ''}`)
      .join('\n');
  }

  getPrimaryWorkspacePath() {
    const folders = Array.isArray(vscode.workspace.workspaceFolders) ? vscode.workspace.workspaceFolders : [];
    if (folders.length === 0) {
      return '';
    }
    return String(folders[0]?.uri?.fsPath || folders[0]?.uri?.path || '').trim();
  }

  allowRemoteNativeUiTools() {
    const config = vscode.workspace.getConfiguration();
    return config.get('ncat.qqbotRemoteAllowNativeUiTools', false) === true;
  }

  getToolName(tool) {
    return String(tool?.name || tool?.id || '').trim();
  }

  isRemoteLocalActionToolName(name) {
    return [
      /^run_in_terminal$/i,
      /^run_vscode_command$/i,
      /^open_browser_page$/i,
    ].some((pattern) => pattern.test(name));
  }

  isBlockedRemoteToolName(name) {
    return [
      /^manage_todo_list$/i,
      /^vscode_askQuestions$/i,
      /^vscode_get_confirmation$/i,
      /^vscode_get_terminal_confirmation$/i,
      /^mcp_qqbot_mcp_qqbot_send_/i,
      /^mcp_pylance_/i,
      /^install_/i,
      /^container-tools_/i,
    ].some((pattern) => pattern.test(name));
  }

  selectAvailableTools(options = {}) {
    const agent = this.getAgentConfig();
    if (!agent.useTools) {
      return [];
    }

    const tools = Array.from(vscode.lm.tools || []);
    if (options.allowAllTools === true || options.toolInvocationToken) {
      return tools.filter((tool) => !/^mcp_qqbot_mcp_qqbot_send_/i.test(this.getToolName(tool)));
    }

    return tools.filter((tool) => {
      const name = this.getToolName(tool);
      if (!name) {
        return false;
      }
      if (this.allowRemoteNativeUiTools() && (/^vscode_get_confirmation$/i.test(name) || /^vscode_get_terminal_confirmation$/i.test(name))) {
        return true;
      }
      return !this.isBlockedRemoteToolName(name);
    });
  }

  getToolByName(name) {
    const target = String(name || '').trim();
    if (!target) {
      return undefined;
    }
    return Array.from(vscode.lm.tools || []).find((tool) => this.getToolName(tool) === target);
  }

  getRemoteRouteSelection(sessionKey) {
    const key = String(sessionKey || '').trim() || 'default';
    return String(this.remoteRouteSelections.get(key) || '').trim();
  }

  setRemoteRouteSelection(sessionKey, windowId) {
    const key = String(sessionKey || '').trim() || 'default';
    const value = String(windowId || '').trim();
    if (!value) {
      this.remoteRouteSelections.delete(key);
      return;
    }
    this.remoteRouteSelections.set(key, value);
  }

  async listAvailableModels() {
    const selected = await this.getLanguageModel();
    let models = [];
    try {
      models = await vscode.lm.selectChatModels();
    } catch {
      models = [];
    }
    const normalized = [];
    const seen = new Set();
    const pushModel = (model, isCurrent = false) => {
      if (!model) {
        return;
      }
      const id = String(model.id || model.name || '').trim();
      const key = `${id}|${String(model.vendor || '').trim()}|${String(model.family || '').trim()}`;
      if (!id || seen.has(key)) {
        return;
      }
      seen.add(key);
      normalized.push({
        id,
        name: String(model.name || model.id || '').trim() || id,
        vendor: String(model.vendor || '').trim(),
        family: String(model.family || '').trim(),
        version: String(model.version || '').trim(),
        isCurrent,
      });
    };
    pushModel(selected, true);
    for (const model of Array.isArray(models) ? models : []) {
      pushModel(model, false);
    }
    return normalized;
  }

  parseRemoteSystemCommand(text) {
    const raw = String(text || '').trim();
    const match = raw.match(/^@(path|list|model)(?:\s+([\s\S]+))?$/i);
    if (!match) {
      return null;
    }
    return {
      name: String(match[1] || '').trim().toLowerCase(),
      argText: String(match[2] || '').trim(),
    };
  }

  formatWindowRecord(record, index, sessionKey) {
    const targetWindowId = this.getRemoteRouteSelection(sessionKey);
    const parts = [`${index}. ${record.primaryPath || '(no workspace folder)'}`];
    const tags = [];
    if (this.windowRouter?.isCurrentWindow?.(record.windowId)) {
      tags.push('current');
    }
    if (targetWindowId && record.windowId === targetWindowId) {
      tags.push('selected');
    }
    if (tags.length > 0) {
      parts[0] += ` [${tags.join(', ')}]`;
    }
    if (Array.isArray(record.workspacePaths) && record.workspacePaths.length > 1) {
      parts.push(`   workspaces: ${record.workspacePaths.join(' | ')}`);
    }
    if (record.pid) {
      parts.push(`   pid: ${record.pid}`);
    }
    return parts.join('\n');
  }

  async handleRemoteSystemCommand(request) {
    const command = this.parseRemoteSystemCommand(request?.message);
    if (!command) {
      return null;
    }

    const sessionKey = String(request?.sessionKey || '').trim() || 'default';
    const currentWindowId = String(this.windowRouter?.windowId || '').trim();

    if (command.name === 'list') {
      const windows = this.windowRouter?.listWindows?.() || [{
        windowId: currentWindowId || 'current',
        primaryPath: this.getPrimaryWorkspacePath(),
        workspacePaths: [this.getPrimaryWorkspacePath()].filter(Boolean),
        pid: process.pid,
      }];
      const lines = ['可用窗口列表:'];
      for (let index = 0; index < windows.length; index += 1) {
        lines.push(this.formatWindowRecord(windows[index], index + 1, sessionKey));
      }
      lines.push('使用 @path <序号> 或 @path <工作区路径> 切换当前会话的接收窗口。');
      return {
        ok: true,
        status: 'completed',
        modelName: 'system',
        text: lines.join('\n'),
      };
    }

    if (command.name === 'path') {
      if (!this.windowRouter) {
        return {
          ok: true,
          status: 'completed',
          modelName: 'system',
          text: `当前窗口路径: ${this.getPrimaryWorkspacePath() || '(no workspace folder)'}`,
        };
      }
      if (!command.argText) {
        const selectedWindowId = this.getRemoteRouteSelection(sessionKey) || currentWindowId;
        const windows = this.windowRouter.listWindows();
        const currentWindow = windows.find((item) => item.windowId === selectedWindowId);
        return {
          ok: true,
          status: 'completed',
          modelName: 'system',
          text: currentWindow
            ? `当前会话接收窗口: ${currentWindow.primaryPath || '(no workspace folder)'}${currentWindow.windowId === currentWindowId ? ' [current]' : ''}`
            : '当前会话尚未指定接收窗口，默认使用当前窗口。',
        };
      }
      const targetWindow = this.windowRouter.findWindow(command.argText);
      if (!targetWindow) {
        return {
          ok: true,
          status: 'completed',
          modelName: 'system',
          text: `未找到匹配窗口: ${command.argText}\n先发送 @list 查看可用窗口。`,
        };
      }
      this.setRemoteRouteSelection(sessionKey, targetWindow.windowId);
      return {
        ok: true,
        status: 'completed',
        modelName: 'system',
        text: `当前会话已切换到窗口 ${targetWindow.primaryPath || '(no workspace folder)'}。后续消息将由该窗口处理。`,
      };
    }

    if (command.name === 'model') {
      const targetWindowId = this.getRemoteRouteSelection(sessionKey) || currentWindowId;
      let models = [];
      if (this.windowRouter && targetWindowId && !this.windowRouter.isCurrentWindow(targetWindowId)) {
        const response = await this.windowRouter.listModels(targetWindowId);
        models = Array.isArray(response?.models) ? response.models : [];
      } else {
        models = await this.listAvailableModels();
      }
      if (!Array.isArray(models) || models.length === 0) {
        return {
          ok: true,
          status: 'completed',
          modelName: 'system',
          text: '当前窗口没有可用模型。',
        };
      }
      const lines = ['模型列表:'];
      for (let index = 0; index < models.length; index += 1) {
        const model = models[index];
        const flags = [];
        if (index === 0 || model.isCurrent) {
          flags.push('current');
        }
        const suffix = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
        const detail = [model.vendor, model.family, model.version].filter(Boolean).join(' / ');
        lines.push(`${index + 1}. ${model.name || model.id}${suffix}${detail ? ` - ${detail}` : ''}`);
      }
      return {
        ok: true,
        status: 'completed',
        modelName: 'system',
        text: lines.join('\n'),
      };
    }

    return null;
  }

  async prepareToolInvocation(name, input, options = {}) {
    const tool = this.getToolByName(name);
    if (!tool || typeof tool.prepareInvocation !== 'function') {
      return null;
    }

    try {
      return await tool.prepareInvocation({
        input: input || {},
        toolInvocationToken: options.toolInvocationToken,
      }, vscode.CancellationToken.None);
    } catch (error) {
      this.log(`tool prepare failed: name=${name}, reason=${error?.message || String(error)}`);
      return null;
    }
  }

  shouldRequireRemoteApproval(name, prepared, input) {
    if (this.isRemoteLocalActionToolName(name)) {
      return true;
    }
    if (prepared?.confirmationMessages) {
      return true;
    }

    const serializedInput = JSON.stringify(input || {});
    return [
      /^run_in_terminal$/i,
      /^create_and_run_task$/i,
      /^kill_terminal$/i,
      /^install_/i,
      /^run_vscode_command$/i,
      /^container-tools_/i,
      /^mcp_microsoft_pla_browser_/i,
      /^apply_patch$/i,
      /^create_file$/i,
      /^create_directory$/i,
      /^delete/i,
    ].some((pattern) => pattern.test(name)) || /isBackground"\s*:\s*true/i.test(serializedInput);
  }

  buildRemoteApproval(prepared, call) {
    const title = markdownishToText(prepared?.confirmationMessages?.title) || `确认执行工具 ${call.name}`;
    const body = markdownishToText(prepared?.confirmationMessages?.message)
      || `工具 ${call.name} 请求执行，参数如下:\n${JSON.stringify(call.input || {}, null, 2)}`;
    const invocationMessage = markdownishToText(prepared?.invocationMessage) || '';
    return {
      toolName: call.name,
      title,
      message: body,
      invocationMessage,
      input: call.input || {},
    };
  }

  async invokeToolCall(call, options = {}) {
    const result = await vscode.lm.invokeTool(call.name, {
      input: call.input || {},
      toolInvocationToken: options.toolInvocationToken,
    });
    return new vscode.LanguageModelToolResultPart(call.callId, result.content || []);
  }

  createToolFailurePart(call, message) {
    return new vscode.LanguageModelToolResultPart(call.callId, [
      new vscode.LanguageModelTextPart(String(message || 'Tool execution failed.')),
    ]);
  }

  createRemoteUnsupportedToolPart(call) {
    return this.createToolFailurePart(
      call,
      `Tool ${call.name} is not available from the QQ remote session. Use @qq in VS Code Chat for tools that need terminal access, native confirmation UI, or a local chat invocation context.`
    );
  }

  createTextToolResultPart(call, text) {
    return new vscode.LanguageModelToolResultPart(call.callId, [
      new vscode.LanguageModelTextPart(String(text || '').trim()),
    ]);
  }

  getDefaultExecutionCwd() {
    const folders = Array.isArray(vscode.workspace.workspaceFolders) ? vscode.workspace.workspaceFolders : [];
    if (folders.length > 0) {
      return folders[0].uri?.fsPath || process.cwd();
    }
    return process.cwd();
  }

  toBoolean(value, fallback = false) {
    if (typeof value === 'boolean') {
      return value;
    }
    if (value === undefined || value === null || value === '') {
      return fallback;
    }
    const text = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(text)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(text)) {
      return false;
    }
    return fallback;
  }

  async executeRemoteLocalAction(call) {
    const name = String(call?.name || '').trim();
    if (/^run_in_terminal$/i.test(name)) {
      return this.executeRemoteTerminalAction(call);
    }
    if (/^run_vscode_command$/i.test(name)) {
      return this.executeRemoteVsCodeCommandAction(call);
    }
    if (/^open_browser_page$/i.test(name)) {
      return this.executeRemoteOpenBrowserAction(call);
    }
    throw new Error(`Unsupported remote local action tool: ${name}`);
  }

  async executeRemoteTerminalAction(call) {
    const input = call?.input || {};
    const command = String(input.command || '').trim();
    if (!command) {
      throw new Error('Terminal command is empty.');
    }

    const explanation = String(input.explanation || '').trim();
    const goal = String(input.goal || '').trim();
    const isBackground = this.toBoolean(input.isBackground, false);
    const timeout = Math.max(0, Number(input.timeout || 0));

    if (isBackground) {
      const terminal = vscode.window.createTerminal({
        name: 'QQ Assistant',
        cwd: this.getDefaultExecutionCwd(),
      });
      terminal.show(true);
      terminal.sendText(command, true);
      return this.createTextToolResultPart(
        call,
        [
          'Background terminal command started in VS Code.',
          goal ? `Goal: ${goal}` : '',
          explanation ? `Explanation: ${explanation}` : '',
          `Command: ${command}`,
        ].filter(Boolean).join('\n')
      );
    }

    try {
      const result = await execAsync(command, {
        cwd: this.getDefaultExecutionCwd(),
        shell: true,
        timeout: timeout > 0 ? timeout : undefined,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      const stdout = String(result?.stdout || '').trim();
      const stderr = String(result?.stderr || '').trim();
      return this.createTextToolResultPart(
        call,
        [
          'Terminal command completed successfully.',
          goal ? `Goal: ${goal}` : '',
          explanation ? `Explanation: ${explanation}` : '',
          stdout ? `stdout:\n${stdout}` : '',
          stderr ? `stderr:\n${stderr}` : '',
        ].filter(Boolean).join('\n\n')
      );
    } catch (error) {
      const stdout = String(error?.stdout || '').trim();
      const stderr = String(error?.stderr || '').trim();
      throw new Error([
        error?.message || String(error),
        stdout ? `stdout: ${stdout}` : '',
        stderr ? `stderr: ${stderr}` : '',
      ].filter(Boolean).join('\n'));
    }
  }

  async executeRemoteVsCodeCommandAction(call) {
    const input = call?.input || {};
    const commandId = String(input.commandId || '').trim();
    if (!commandId) {
      throw new Error('commandId is required.');
    }

    const args = Array.isArray(input.args) ? input.args : [];
    const result = await vscode.commands.executeCommand(commandId, ...args);
    const summary = markdownishToText(result);
    return this.createTextToolResultPart(
      call,
      [
        `VS Code command executed: ${commandId}`,
        summary ? `Result: ${summary}` : '',
      ].filter(Boolean).join('\n')
    );
  }

  async executeRemoteOpenBrowserAction(call) {
    const input = call?.input || {};
    const url = String(input.url || '').trim();
    if (!url) {
      throw new Error('url is required.');
    }

    const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
    if (!opened) {
      throw new Error(`Failed to open URL: ${url}`);
    }
    return this.createTextToolResultPart(call, `Opened URL in local browser: ${url}`);
  }

  async resolveToolCalls(toolCalls, state, options = {}) {
    const resultParts = Array.isArray(state.resultParts) ? [...state.resultParts] : [];
    const startIndex = Number.isInteger(state.startIndex) ? state.startIndex : 0;

    for (let index = startIndex; index < toolCalls.length; index += 1) {
      const call = toolCalls[index];
      this.log(`tool requested: name=${call.name}, input=${clipText(JSON.stringify(call.input || {}), 400)}`);
      if (options.remoteApproval === true && !this.isRemoteLocalActionToolName(call.name) && (/^create_and_run_task$/i.test(call.name) || /^kill_terminal$/i.test(call.name))) {
        resultParts.push(this.createRemoteUnsupportedToolPart(call));
        this.log(`tool rejected in remote session: name=${call.name}, reason=requires-local-chat-context`);
        continue;
      }
      const prepared = await this.prepareToolInvocation(call.name, call.input || {}, options);

      if (options.remoteApproval === true && this.shouldRequireRemoteApproval(call.name, prepared, call.input || {})) {
        return {
          status: 'awaiting-approval',
          approval: this.buildRemoteApproval(prepared, call),
          state: {
            kind: 'remote-tool-approval',
            model: state.model,
            maxRounds: state.maxRounds,
            round: state.round,
            finalText: state.finalText,
            workingMessages: [...state.workingMessages],
            toolCalls,
            resultParts,
            startIndex: index,
            remoteApproval: true,
          },
        };
      }

      try {
        if (prepared?.invocationMessage && typeof options.onProgress === 'function') {
          options.onProgress(markdownishToText(prepared.invocationMessage));
        }
        const part = await this.invokeToolCall(call, options);
        resultParts.push(part);
        this.log(`tool finished: name=${call.name}, parts=${Array.isArray(part.value) ? part.value.length : 0}`);
      } catch (error) {
        const failureText = `Tool ${call.name} failed: ${error?.message || String(error)}`;
        resultParts.push(this.createToolFailurePart(call, failureText));
        this.log(`tool failed: name=${call.name}, reason=${error?.message || String(error)}`);
      }
    }

    return {
      status: 'completed',
      resultParts,
    };
  }

  async runModelLoop(state, options = {}) {
    let finalText = String(state.finalText || '');
    const workingMessages = Array.isArray(state.workingMessages) ? [...state.workingMessages] : [];
    const model = state.model || await this.getLanguageModel(options.model);
    const availableTools = Array.isArray(state.availableTools) ? state.availableTools : this.selectAvailableTools(options);

    for (let round = Number(state.round || 0); round < state.maxRounds; round += 1) {
      const response = await model.sendRequest(workingMessages, {
        tools: availableTools,
        toolMode: vscode.LanguageModelChatToolMode.Auto,
      }, options.token);

      const toolCalls = [];
      let roundText = '';
      const streamSource = response?.stream || response?.text;
      for await (const chunk of streamSource) {
        if (chunk instanceof vscode.LanguageModelTextPart) {
          const value = String(chunk.value || '');
          roundText += value;
          if (typeof options.onTextChunk === 'function' && value) {
            options.onTextChunk(value);
          }
          continue;
        }
        if (chunk instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(chunk);
          continue;
        }
        const value = String(chunk || '');
        roundText += value;
        if (typeof options.onTextChunk === 'function' && value) {
          options.onTextChunk(value);
        }
      }

      if (toolCalls.length === 0) {
        finalText += roundText;
        return {
          status: 'completed',
          text: String(finalText || '').trim(),
          modelName: model.name || model.id || 'unknown',
        };
      }

      if (roundText) {
        finalText += roundText;
      }

      const toolResolution = await this.resolveToolCalls(toolCalls, {
        model,
        maxRounds: state.maxRounds,
        round,
        finalText,
        workingMessages,
      }, options);

      if (toolResolution.status === 'awaiting-approval') {
        return {
          status: 'awaiting-approval',
          text: String(finalText || '').trim(),
          modelName: model.name || model.id || 'unknown',
          approval: toolResolution.approval,
          state: toolResolution.state,
        };
      }

      workingMessages.push(vscode.LanguageModelChatMessage.Assistant(toolCalls));
      workingMessages.push(vscode.LanguageModelChatMessage.User(toolResolution.resultParts));
    }

    return {
      status: 'completed',
      text: String(finalText || '').trim(),
      modelName: model.name || model.id || 'unknown',
    };
  }

  async getLanguageModel(preferredModel) {
    if (preferredModel && typeof preferredModel.sendRequest === 'function') {
      return preferredModel;
    }

    const agent = this.getAgentConfig();
    const selector = {};
    if (agent.modelVendor) {
      selector.vendor = agent.modelVendor;
    }
    if (agent.modelFamily) {
      selector.family = agent.modelFamily;
    }

    let models = [];
    models = await vscode.lm.selectChatModels(Object.keys(selector).length > 0 ? selector : undefined);
    if (!Array.isArray(models) || models.length === 0) {
      models = await vscode.lm.selectChatModels();
    }
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error('No language model is available in VS Code.');
    }
    return models[0];
  }

  async prepareLanguageModelAccess() {
    try {
      const model = await this.getLanguageModel();
      const response = await model.sendRequest([
        vscode.LanguageModelChatMessage.User('Reply with OK only.'),
      ]);
      let text = '';
      const source = response?.text || response?.stream;
      for await (const chunk of source) {
        if (chunk instanceof vscode.LanguageModelTextPart) {
          text += String(chunk.value || '');
          continue;
        }
        text += String(chunk || '');
      }
      this.log(`AI access prepared with model=${model.name || model.id || 'unknown'}, probe=${clipText(text, 40)}`);
      return {
        ok: true,
        modelName: model.name || model.id || 'unknown',
      };
    } catch (error) {
      const reason = error?.message || String(error);
      this.log(`AI access prepare failed: ${reason}`);
      return {
        ok: false,
        reason,
      };
    }
  }

  async runModelWithTools(messages, options = {}) {
    const maxRounds = Math.max(1, Math.min(8, Number(this.getAgentConfig().maxToolRounds || 4)));
    return this.runModelLoop({
      model: options.model,
      maxRounds,
      round: 0,
      finalText: '',
      workingMessages: Array.isArray(messages) ? [...messages] : [],
    }, options);
  }

  buildParticipantHistory(context) {
    const turns = Array.isArray(context?.history) ? context.history.slice(-10) : [];
    return turns
      .map((turn) => {
        const prompt = textFromUnknown(turn?.prompt);
        const response = textFromUnknown(turn?.result?.metadata?.assistantResponse || turn?.response || turn?.result);
        const lines = [];
        if (prompt) {
          lines.push(`用户: ${prompt}`);
        }
        if (response) {
          lines.push(`助手: ${response}`);
        }
        return lines.join('\n');
      })
      .filter(Boolean)
      .join('\n');
  }

  buildParticipantMessages(request, context) {
    const agent = this.getAgentConfig();
    const historyText = this.buildParticipantHistory(context);
    const location = String(request?.location || '').trim() || 'panel';
    const workspaceSummary = this.getWorkspaceSummary();
    const prompt = [
      agent.systemPrompt,
      '',
      `当前入口: VS Code Chat (${location})`,
      `工作区:\n${workspaceSummary}`,
      historyText ? `最近上下文:\n${historyText}` : '最近上下文: (none)',
      '',
      `用户最新消息:\n${String(request?.prompt || '').trim()}`,
      '',
      '请直接回复用户，必要时调用可用工具。',
    ].join('\n');
    return [vscode.LanguageModelChatMessage.User(prompt)];
  }

  async handleParticipantRequest(request, context, stream, token) {
    const messages = this.buildParticipantMessages(request, context);
    const result = await this.runModelWithTools(messages, {
      model: request?.model,
      token,
      toolInvocationToken: request?.toolInvocationToken,
      onTextChunk: (chunk) => {
        if (stream && typeof stream.markdown === 'function' && chunk) {
          stream.markdown(chunk);
        }
      },
    });

    if (!result.text && stream && typeof stream.markdown === 'function') {
      stream.markdown('没有生成可返回的文本。');
    }

    return {
      metadata: {
        modelName: result.modelName,
        assistantResponse: result.text,
      },
    };
  }

  getRemoteSession(sessionKey) {
    const key = String(sessionKey || '').trim() || 'default';
    if (!this.remoteSessions.has(key)) {
      this.remoteSessions.set(key, []);
    }
    return this.remoteSessions.get(key);
  }

  appendRemoteTurn(sessionKey, role, text) {
    const turns = this.getRemoteSession(sessionKey);
    turns.push({
      role,
      text: String(text || '').trim(),
      timestamp: Date.now(),
    });
    if (turns.length > 20) {
      turns.splice(0, turns.length - 20);
    }
  }

  buildRemoteTranscript(sessionKey) {
    return this.getRemoteSession(sessionKey)
      .map((turn) => `${turn.role === 'assistant' ? '助手' : '用户'}: ${turn.text}`)
      .filter(Boolean)
      .join('\n');
  }

  buildRemoteMessages(request) {
    const agent = this.getAgentConfig();
    const transcript = this.buildRemoteTranscript(request.sessionKey);
    const attachmentText = Array.isArray(request.attachments) && request.attachments.length > 0
      ? JSON.stringify(request.attachments)
      : '';
    const workspaceSummary = this.getWorkspaceSummary();
    const prompt = [
      agent.systemPrompt,
      '',
      `当前入口: 远程桥接 (${request.source})`,
      `会话键: ${request.sessionKey}`,
      `工作区:\n${workspaceSummary}`,
      transcript ? `最近上下文:\n${transcript}` : '最近上下文: (none)',
      attachmentText ? `附件元数据: ${attachmentText}` : '',
      '',
      `用户最新消息:\n${request.message}`,
      '',
      '请直接输出最终回复文本。只在确实必要时调用非交互式、安全的工具；不要调用发送 QQ 消息之类会再次触发外部副作用的工具。',
    ].filter(Boolean).join('\n');
    return [vscode.LanguageModelChatMessage.User(prompt)];
  }

  async handleRemoteRequest(request) {
    const systemResponse = await this.handleRemoteSystemCommand(request);
    if (systemResponse) {
      return systemResponse;
    }

    const targetWindowId = this.getRemoteRouteSelection(request.sessionKey);
    if (targetWindowId && this.windowRouter && !this.windowRouter.isCurrentWindow(targetWindowId)) {
      return this.windowRouter.forwardRemoteRequest(targetWindowId, request);
    }

    this.appendRemoteTurn(request.sessionKey, 'user', request.message);
    const result = await this.runModelWithTools(this.buildRemoteMessages(request), {
      remoteApproval: true,
    });
    if (result.status === 'completed' && result.text) {
      this.appendRemoteTurn(request.sessionKey, 'assistant', result.text);
    }
    return {
      ok: true,
      status: result.status || 'completed',
      modelName: result.modelName,
      text: result.text,
      approval: result.approval,
      state: result.state,
    };
  }

  async continueRemoteApproval(pendingState, approved) {
    if (pendingState?.kind === 'forwarded-remote-approval') {
      if (!this.windowRouter) {
        throw new Error('window router is not available');
      }
      return this.windowRouter.continueRemoteApproval(
        pendingState.targetWindowId,
        pendingState.approvalToken,
        approved
      );
    }

    if (!pendingState || pendingState.kind !== 'remote-tool-approval') {
      throw new Error('Invalid remote approval state.');
    }

    const toolCalls = Array.isArray(pendingState.toolCalls) ? pendingState.toolCalls : [];
    const call = toolCalls[pendingState.startIndex];
    if (!call) {
      throw new Error('Pending tool call is missing.');
    }

    const resultParts = Array.isArray(pendingState.resultParts) ? [...pendingState.resultParts] : [];
    if (approved) {
      try {
        const part = this.isRemoteLocalActionToolName(call.name)
          ? await this.executeRemoteLocalAction(call)
          : await this.invokeToolCall(call, { toolInvocationToken: undefined });
        resultParts.push(part);
        this.log(`tool finished after remote approval: name=${call.name}`);
      } catch (error) {
        const failureText = `Tool ${call.name} failed: ${error?.message || String(error)}`;
        resultParts.push(this.createToolFailurePart(call, failureText));
        this.log(`tool failed after remote approval: name=${call.name}, reason=${error?.message || String(error)}`);
      }
    } else {
      resultParts.push(this.createToolFailurePart(call, `Tool ${call.name} was cancelled by the user.`));
      this.log(`tool cancelled by remote user: name=${call.name}`);
    }

    const remaining = await this.resolveToolCalls(toolCalls, {
      model: pendingState.model,
      maxRounds: pendingState.maxRounds,
      round: pendingState.round,
      finalText: pendingState.finalText,
      workingMessages: Array.isArray(pendingState.workingMessages) ? [...pendingState.workingMessages] : [],
      resultParts,
      startIndex: pendingState.startIndex + 1,
    }, {
      remoteApproval: true,
    });

    if (remaining.status === 'awaiting-approval') {
      return {
        ok: true,
        status: 'awaiting-approval',
        modelName: pendingState.model?.name || pendingState.model?.id || 'unknown',
        text: String(pendingState.finalText || '').trim(),
        approval: remaining.approval,
        state: remaining.state,
      };
    }

    const workingMessages = Array.isArray(pendingState.workingMessages) ? [...pendingState.workingMessages] : [];
    workingMessages.push(vscode.LanguageModelChatMessage.Assistant(toolCalls));
    workingMessages.push(vscode.LanguageModelChatMessage.User(remaining.resultParts));

    return this.runModelLoop({
      model: pendingState.model,
      maxRounds: pendingState.maxRounds,
      round: Number(pendingState.round || 0) + 1,
      finalText: pendingState.finalText,
      workingMessages,
    }, {
      remoteApproval: true,
    });
  }
}

module.exports = {
  ChatOrchestrator,
};