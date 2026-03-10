const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { LOG_DIR_NAME } = require('../core/qq-connector.cjs');

const WINDOW_STALE_MS = 45 * 1000;
const HEARTBEAT_MS = 15 * 1000;
const POLL_MS = 800;

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeUnlink(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
  }
}

function readJsonFile(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFileAtomic(filePath, payload) {
  ensureDir(path.dirname(filePath));
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tempFile, filePath);
}

function normalizeFsPath(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  const normalized = path.normalize(raw);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

class WindowRouter {
  constructor(context, orchestratorAccessor, options = {}) {
    this.context = context;
    this.getOrchestrator = typeof orchestratorAccessor === 'function' ? orchestratorAccessor : () => undefined;
    this.logFn = typeof options.log === 'function' ? options.log : () => {};
    this.windowId = createId('window');
    this.startedAt = Date.now();
    this.pendingApprovals = new Map();
    this.heartbeatTimer = null;
    this.pollTimer = null;
    this.disposed = false;

    const baseDir = context?.globalStorageUri?.fsPath
      || context?.logUri?.fsPath
      || path.join(context?.extensionPath || process.cwd(), LOG_DIR_NAME);
    this.routerDir = path.join(baseDir, 'window-router');
    this.windowsDir = path.join(this.routerDir, 'windows');
    this.requestsDir = path.join(this.routerDir, 'requests');
    this.responsesDir = path.join(this.routerDir, 'responses');
    this.windowFilePath = path.join(this.windowsDir, `${this.windowId}.json`);
    this.windowRequestDir = path.join(this.requestsDir, this.windowId);
  }

  log(message) {
    this.logFn(`[window-router] ${message}`);
  }

  ensureDirs() {
    ensureDir(this.windowsDir);
    ensureDir(this.requestsDir);
    ensureDir(this.responsesDir);
    ensureDir(this.windowRequestDir);
  }

  getWorkspacePaths() {
    return (Array.isArray(vscode.workspace.workspaceFolders) ? vscode.workspace.workspaceFolders : [])
      .map((folder) => String(folder?.uri?.fsPath || folder?.uri?.path || '').trim())
      .filter(Boolean);
  }

  getWorkspaceNames() {
    return (Array.isArray(vscode.workspace.workspaceFolders) ? vscode.workspace.workspaceFolders : [])
      .map((folder) => String(folder?.name || '').trim())
      .filter(Boolean);
  }

  getCurrentWindowRecord() {
    const workspacePaths = this.getWorkspacePaths();
    const workspaceNames = this.getWorkspaceNames();
    return {
      windowId: this.windowId,
      pid: process.pid,
      startedAt: this.startedAt,
      lastSeenAt: Date.now(),
      primaryPath: workspacePaths[0] || '',
      workspacePaths,
      workspaceNames,
    };
  }

  start() {
    this.ensureDirs();
    this.writeHeartbeat();
    this.pollRequests().catch((error) => {
      this.log(`initial poll failed: ${error?.message || String(error)}`);
    });
    this.heartbeatTimer = setInterval(() => {
      this.writeHeartbeat();
    }, HEARTBEAT_MS);
    this.pollTimer = setInterval(() => {
      this.pollRequests().catch((error) => {
        this.log(`poll failed: ${error?.message || String(error)}`);
      });
    }, POLL_MS);
  }

  dispose() {
    this.disposed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    safeUnlink(this.windowFilePath);
  }

  writeHeartbeat() {
    if (this.disposed) {
      return;
    }
    this.ensureDirs();
    writeJsonFileAtomic(this.windowFilePath, this.getCurrentWindowRecord());
    this.cleanupStaleWindows();
  }

  cleanupStaleWindows() {
    try {
      const entries = fs.readdirSync(this.windowsDir, { withFileTypes: true });
      const now = Date.now();
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
          continue;
        }
        const filePath = path.join(this.windowsDir, entry.name);
        const data = readJsonFile(filePath, null);
        const lastSeenAt = Number(data?.lastSeenAt || 0);
        if (!lastSeenAt || now - lastSeenAt > WINDOW_STALE_MS) {
          safeUnlink(filePath);
        }
      }
    } catch {
    }
  }

  listWindows() {
    this.ensureDirs();
    this.writeHeartbeat();
    const now = Date.now();
    const out = [];
    try {
      const entries = fs.readdirSync(this.windowsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
          continue;
        }
        const filePath = path.join(this.windowsDir, entry.name);
        const data = readJsonFile(filePath, null);
        if (!data) {
          continue;
        }
        const lastSeenAt = Number(data.lastSeenAt || 0);
        if (!lastSeenAt || now - lastSeenAt > WINDOW_STALE_MS) {
          safeUnlink(filePath);
          continue;
        }
        out.push({
          windowId: String(data.windowId || '').trim(),
          pid: Number(data.pid || 0),
          startedAt: Number(data.startedAt || 0),
          lastSeenAt,
          primaryPath: String(data.primaryPath || '').trim(),
          workspacePaths: Array.isArray(data.workspacePaths) ? data.workspacePaths.map((item) => String(item || '').trim()).filter(Boolean) : [],
          workspaceNames: Array.isArray(data.workspaceNames) ? data.workspaceNames.map((item) => String(item || '').trim()).filter(Boolean) : [],
        });
      }
    } catch (error) {
      this.log(`listWindows failed: ${error?.message || String(error)}`);
    }

    out.sort((left, right) => {
      const leftKey = normalizeFsPath(left.primaryPath || left.workspacePaths[0] || left.windowId);
      const rightKey = normalizeFsPath(right.primaryPath || right.workspacePaths[0] || right.windowId);
      return leftKey.localeCompare(rightKey) || String(left.windowId).localeCompare(String(right.windowId));
    });
    return out;
  }

  isCurrentWindow(windowId) {
    return String(windowId || '').trim() === this.windowId;
  }

  findWindow(selector) {
    const text = String(selector || '').trim();
    const windows = this.listWindows();
    if (!text) {
      return null;
    }

    if (/^\d+$/.test(text)) {
      const index = Number(text);
      if (index >= 1 && index <= windows.length) {
        return windows[index - 1];
      }
    }

    const normalizedSelector = normalizeFsPath(text);
    return windows.find((item) => {
      if (normalizeFsPath(item.primaryPath) === normalizedSelector) {
        return true;
      }
      return item.workspacePaths.some((workspacePath) => normalizeFsPath(workspacePath) === normalizedSelector);
    }) || null;
  }

  async forwardRemoteRequest(targetWindowId, request, timeout = 5 * 60 * 1000) {
    return this.sendRequest(targetWindowId, 'remote-request', { request }, timeout);
  }

  async continueRemoteApproval(targetWindowId, approvalToken, approved, timeout = 5 * 60 * 1000) {
    return this.sendRequest(targetWindowId, 'continue-approval', { approvalToken, approved }, timeout);
  }

  async listModels(targetWindowId, timeout = 30 * 1000) {
    return this.sendRequest(targetWindowId, 'list-models', {}, timeout);
  }

  async sendRequest(targetWindowId, action, payload, timeout) {
    const targetId = String(targetWindowId || '').trim();
    if (!targetId) {
      throw new Error('target window is required');
    }
    this.ensureDirs();
    const requestId = createId('request');
    const requestDir = path.join(this.requestsDir, targetId);
    const requestFile = path.join(requestDir, `${requestId}.json`);
    const responseFile = path.join(this.responsesDir, `${requestId}.json`);
    ensureDir(requestDir);
    writeJsonFileAtomic(requestFile, {
      requestId,
      action,
      payload,
      senderWindowId: this.windowId,
      createdAt: Date.now(),
    });
    return this.waitForResponse(responseFile, timeout);
  }

  async waitForResponse(responseFile, timeout) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      const response = readJsonFile(responseFile, null);
      if (response) {
        safeUnlink(responseFile);
        if (response.ok === false) {
          throw new Error(String(response.error || 'request failed'));
        }
        return response;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('window request timed out');
  }

  async pollRequests() {
    if (this.disposed) {
      return;
    }
    this.ensureDirs();
    let entries = [];
    try {
      entries = fs.readdirSync(this.windowRequestDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      const requestFile = path.join(this.windowRequestDir, entry.name);
      const request = readJsonFile(requestFile, null);
      if (!request) {
        safeUnlink(requestFile);
        continue;
      }
      const responseFile = path.join(this.responsesDir, `${String(request.requestId || '').trim()}.json`);
      try {
        const result = await this.handleInboundRequest(request);
        writeJsonFileAtomic(responseFile, {
          ok: true,
          ...result,
        });
      } catch (error) {
        writeJsonFileAtomic(responseFile, {
          ok: false,
          error: error?.message || String(error),
        });
      } finally {
        safeUnlink(requestFile);
      }
    }
  }

  serializeApprovalResult(result) {
    const output = {
      ok: result?.ok !== false,
      status: String(result?.status || 'completed'),
      modelName: String(result?.modelName || '').trim(),
      text: String(result?.text || '').trim(),
      approval: result?.approval || null,
    };
    if (output.status === 'awaiting-approval' && result?.state) {
      const approvalToken = createId('approval');
      this.pendingApprovals.set(approvalToken, result.state);
      output.state = {
        kind: 'forwarded-remote-approval',
        targetWindowId: this.windowId,
        approvalToken,
      };
    }
    return output;
  }

  async handleInboundRequest(request) {
    const orchestrator = this.getOrchestrator();
    if (!orchestrator) {
      throw new Error('chat orchestrator is not available');
    }
    const action = String(request?.action || '').trim();
    if (action === 'remote-request') {
      const result = await orchestrator.handleRemoteRequest(request?.payload?.request || {});
      return this.serializeApprovalResult(result);
    }
    if (action === 'continue-approval') {
      const approvalToken = String(request?.payload?.approvalToken || '').trim();
      const state = this.pendingApprovals.get(approvalToken);
      if (!state) {
        throw new Error('forwarded approval state not found');
      }
      const approved = request?.payload?.approved === true;
      const result = await orchestrator.continueRemoteApproval(state, approved);
      if (result?.status === 'awaiting-approval' && result?.state) {
        this.pendingApprovals.set(approvalToken, result.state);
        return {
          ok: true,
          status: 'awaiting-approval',
          modelName: String(result?.modelName || '').trim(),
          text: String(result?.text || '').trim(),
          approval: result?.approval || null,
          state: {
            kind: 'forwarded-remote-approval',
            targetWindowId: this.windowId,
            approvalToken,
          },
        };
      }
      this.pendingApprovals.delete(approvalToken);
      return {
        ok: true,
        status: String(result?.status || 'completed'),
        modelName: String(result?.modelName || '').trim(),
        text: String(result?.text || '').trim(),
        approval: result?.approval || null,
      };
    }
    if (action === 'list-models') {
      const models = await orchestrator.listAvailableModels();
      return {
        ok: true,
        models,
      };
    }
    throw new Error(`unsupported window-router action: ${action}`);
  }
}

module.exports = {
  WindowRouter,
};