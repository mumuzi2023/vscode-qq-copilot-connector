const http = require('node:http');
const crypto = require('node:crypto');
const vscode = require('vscode');
const { affectsConfiguration, getConfigValue } = require('../core/qq-connector.cjs');

function createRequestId() {
  return `req_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function clipText(value, max = 400) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}...`;
}

function normalizeMode(value, fallback = 'panel') {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'inline') {
    return 'inline';
  }
  if (mode === 'panel') {
    return 'panel';
  }
  return fallback;
}

function toBoolean(value, fallback = true) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const text = String(value).trim().toLowerCase();
  if (text === 'false' || text === '0' || text === 'off' || text === 'no') {
    return false;
  }
  if (text === 'true' || text === '1' || text === 'on' || text === 'yes') {
    return true;
  }
  return fallback;
}

class ChatBridge {
  constructor(context, runtimeAccessor, orchestratorAccessor) {
    this.context = context;
    this.getRuntime = typeof runtimeAccessor === 'function' ? runtimeAccessor : () => undefined;
    this.getOrchestrator = typeof orchestratorAccessor === 'function' ? orchestratorAccessor : () => undefined;
    this.server = null;
    this.listenPort = 0;
    this.listenHost = '127.0.0.1';
    this.sessionChains = new Map();
  }

  log(message) {
    const runtime = this.getRuntime();
    if (runtime && typeof runtime.log === 'function') {
      runtime.log(`[chat-bridge] ${message}`);
    }
  }

  getBridgeConfig() {
    const config = vscode.workspace.getConfiguration();
    return {
      enabled: getConfigValue(config, 'chatBridgeEnabled', false) === true,
      port: Math.max(1, Math.min(65535, Number(getConfigValue(config, 'chatBridgePort', 27124) || 27124))),
      token: String(getConfigValue(config, 'chatBridgeToken', '') || '').trim(),
      defaultMode: normalizeMode(getConfigValue(config, 'chatBridgeDefaultMode', 'panel'), 'panel'),
      defaultAutoSend: getConfigValue(config, 'chatBridgeAutoSend', true) !== false,
      mirrorOutput: getConfigValue(config, 'chatBridgeMirrorOutput', true) !== false,
    };
  }

  affectsConfiguration(event) {
    return affectsConfiguration(event, [
      'chatBridgeEnabled',
      'chatBridgePort',
      'chatBridgeToken',
      'chatBridgeDefaultMode',
      'chatBridgeAutoSend',
      'chatBridgeMirrorOutput',
    ]);
  }

  getStatus() {
    const config = this.getBridgeConfig();
    return {
      enabled: config.enabled,
      listening: Boolean(this.server),
      host: this.listenHost,
      port: this.listenPort || config.port,
      defaultMode: config.defaultMode,
      defaultAutoSend: config.defaultAutoSend,
      mirrorOutput: config.mirrorOutput,
    };
  }

  async syncServer() {
    const config = this.getBridgeConfig();
    if (!config.enabled) {
      await this.stopServer();
      return;
    }
    if (this.server && this.listenPort === config.port) {
      return;
    }
    await this.stopServer();
    await this.startServer(config);
  }

  async startServer(config) {
    await new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => {
        this.handleHttpRequest(request, response).catch((error) => {
          this.log(`HTTP handler failed: ${error?.message || String(error)}`);
          if (!response.headersSent) {
            response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          }
          response.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
        });
      });
      server.on('error', (error) => reject(error));
      server.listen(config.port, this.listenHost, () => {
        this.server = server;
        this.listenPort = config.port;
        this.log(`Chat bridge listening on http://${this.listenHost}:${config.port}`);
        resolve();
      });
    });
  }

  async stopServer() {
    if (!this.server) {
      this.listenPort = 0;
      return;
    }
    const server = this.server;
    this.server = null;
    this.listenPort = 0;
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
    this.log('Chat bridge stopped.');
  }

  dispose() {
    this.stopServer().catch(() => {});
    this.sessionChains.clear();
  }

  async handleHttpRequest(request, response) {
    const url = new URL(request.url || '/', `http://${this.listenHost}`);
    if (request.method === 'GET' && url.pathname === '/chat/bridge/status') {
      this.writeJson(response, 200, { ok: true, status: this.getStatus() });
      return;
    }
    if (request.method !== 'POST' || url.pathname !== '/chat/redirect') {
      this.writeJson(response, 404, { ok: false, error: 'Not found' });
      return;
    }

    const config = this.getBridgeConfig();
    if (config.token) {
      const authHeader = String(request.headers.authorization || '').trim();
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const headerToken = String(request.headers['x-qq-bridge-token'] || '').trim();
      const supplied = bearer || headerToken;
      if (!supplied || supplied !== config.token) {
        this.writeJson(response, 401, { ok: false, error: 'Unauthorized' });
        return;
      }
    }

    const body = await this.readJsonBody(request);
    const result = await this.submitRemoteRequest(body, {
      source: 'http',
    });
    this.writeJson(response, 200, result);
  }

  writeJson(response, statusCode, payload) {
    response.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(payload));
  }

  async readJsonBody(request) {
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
      total += chunk.length;
      if (total > 1024 * 1024) {
        throw new Error('Request body is too large.');
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {
      return {};
    }
    return JSON.parse(raw);
  }

  normalizeRemoteRequest(payload, options = {}) {
    const config = this.getBridgeConfig();
    const source = String(options.source || payload?.source || 'manual').trim() || 'manual';
    const requestId = String(payload?.requestId || createRequestId()).trim() || createRequestId();
    const sessionKey = String(payload?.sessionKey || `${source}:${requestId}`).trim() || `${source}:${requestId}`;
    const message = String(payload?.message || '').trim();
    if (!message) {
      throw new Error('message is required');
    }
    const mode = normalizeMode(payload?.mode, config.defaultMode);
    const autoSend = toBoolean(payload?.autoSend, config.defaultAutoSend);
    const attachments = Array.isArray(payload?.attachments)
      ? payload.attachments
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({ kind: String(item.kind || '').trim(), value: String(item.value || '').trim() }))
          .filter((item) => item.kind && item.value)
      : [];
    return {
      requestId,
      source,
      sessionKey,
      message,
      mode,
      autoSend,
      attachments,
    };
  }

  async submitRemoteRequest(payload, options = {}) {
    const request = this.normalizeRemoteRequest(payload, options);
    const key = request.sessionKey;
    const previous = this.sessionChains.get(key) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.processRemoteRequest(request));
    this.sessionChains.set(key, next.finally(() => {
      if (this.sessionChains.get(key) === next) {
        this.sessionChains.delete(key);
      }
    }));
    return next;
  }

  async processRemoteRequest(request) {
    this.log(`redirect request: source=${request.source}, session=${request.sessionKey}, text=${clipText(request.message)}`);
    const injected = {
      attempted: false,
      verified: false,
      note: 'Remote requests are handled by the local QQ assistant participant pipeline. No built-in Copilot chat injection is performed.',
    };
    let mirrored = null;
    if (this.getBridgeConfig().mirrorOutput) {
      const orchestrator = this.getOrchestrator();
      if (!orchestrator || typeof orchestrator.handleRemoteRequest !== 'function') {
        throw new Error('Chat orchestrator is unavailable.');
      }
      mirrored = await orchestrator.handleRemoteRequest(request);
    }
    return {
      ok: true,
      requestId: request.requestId,
      sessionKey: request.sessionKey,
      injected,
      mirrored,
    };
  }

}

module.exports = {
  ChatBridge,
};