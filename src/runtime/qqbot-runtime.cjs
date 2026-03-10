const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const WebSocket = require('ws');
const { getPrivateAvatarUrl, getGroupAvatarUrl } = require('../core/avatar-utils.cjs');
const { clipText, toBrief } = require('../core/message-utils.cjs');
const { ChatOrchestrator } = require('../chat/chat-orchestrator.cjs');
const { CHAT_CACHE_STORE_KEY, HIDDEN_TARGETS_STORE_KEY, LOG_DIR_NAME, commandId, getConfigValue } = require('../core/qq-connector.cjs');
const { persistCacheNow, restoreCachedSessions } = require('./cache-store.cjs');
const { normalizeOutgoingRequest } = require('./outgoing-message.cjs');

const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const API_BASE = 'https://api.sgroup.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];
const QQBOT_INTENTS = (1 << 30) | (1 << 25) | (1 << 12);

const tokenCache = new Map();
const tokenInflight = new Map();

function clipForLog(value, max = 240) {
  return clipText(String(value || '').replace(/\s+/g, ' ').trim(), max);
}

function normalizeApprovalDecision(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) {
    return '';
  }
  if (['y', 'yes', 'ok', '确认', '同意', '继续', '允许'].includes(text)) {
    return 'approve';
  }
  if (['n', 'no', 'cancel', '取消', '拒绝', '停止', '不'].includes(text)) {
    return 'deny';
  }
  return '';
}

function parseIdText(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const token of raw.split(/[\s,;|/\\]+/g)) {
    const item = String(token || '').trim();
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    out.push(item);
  }
  return out;
}

function looksLikeQqOpenId(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return false;
  }
  return /^[0-9A-F]{32}$/i.test(raw) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw);
}

function maskSecret(secret) {
  const raw = String(secret || '').trim();
  if (!raw) {
    return '';
  }
  if (raw.length <= 8) {
    return '*'.repeat(raw.length);
  }
  return `${raw.slice(0, 4)}****${raw.slice(-4)}`;
}

function decodeDataUrlPayload(dataUrl) {
  const raw = String(dataUrl || '').trim();
  const match = raw.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) {
    return null;
  }
  return {
    mime: String(match[1] || '').toLowerCase().trim(),
    base64: String(match[2] || '').trim(),
  };
}

function normalizeTextSegments(text) {
  const value = String(text || '');
  if (!value) {
    return [];
  }
  return [{ type: 'text', text: value }];
}

function attachmentToSegments(attachments) {
  const out = [];
  const list = Array.isArray(attachments) ? attachments : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const mime = String(item.content_type || '').toLowerCase();
    const url = String(item.url || '').trim();
    const filename = String(item.filename || '').trim();
    if (!url) {
      continue;
    }
    if (mime.startsWith('image/')) {
      out.push({
        type: 'image',
        url: url.startsWith('//') ? `https:${url}` : url,
        label: filename || 'image',
      });
      continue;
    }
    if (mime.startsWith('video/')) {
      out.push({
        type: 'video',
        url: url.startsWith('//') ? `https:${url}` : url,
        label: filename || 'video',
      });
      continue;
    }
    out.push({
      type: 'text',
      text: `[附件] ${filename || mime || 'file'}`,
    });
  }
  return out;
}

function buildSegmentsFromOfficialMessage(content, attachments) {
  const segments = [];
  segments.push(...normalizeTextSegments(content));
  segments.push(...attachmentToSegments(attachments));
  if (segments.length === 0) {
    segments.push({ type: 'text', text: '[空消息]' });
  }
  return segments;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Failed to parse response: ${clipText(raw || '(empty)', 120)}`);
  }
  if (!response.ok) {
    throw new Error(data?.message || `HTTP ${response.status}`);
  }
  return data;
}

async function getAccessToken(appId, clientSecret) {
  const cacheKey = `${appId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
    return cached.token;
  }
  if (tokenInflight.has(cacheKey)) {
    return tokenInflight.get(cacheKey);
  }
  const promise = (async () => {
    try {
      const data = await fetchJson(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret }),
      });
      const token = String(data.access_token || '').trim();
      if (!token) {
        throw new Error('access_token missing in response');
      }
      const expiresIn = Number(data.expires_in || 7200);
      tokenCache.set(cacheKey, {
        token,
        expiresAt: Date.now() + expiresIn * 1000,
      });
      return token;
    } finally {
      tokenInflight.delete(cacheKey);
    }
  })();
  tokenInflight.set(cacheKey, promise);
  return promise;
}

async function getGatewayUrl(accessToken) {
  const data = await fetchJson(`${API_BASE}/gateway`, {
    method: 'GET',
    headers: {
      Authorization: `QQBot ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  return String(data.url || '').trim();
}

async function apiRequest(accessToken, method, path, body) {
  return fetchJson(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `QQBot ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

class QQBotRuntime {
  constructor(context) {
    this.context = context;
    this.sharedStateDir = this.resolveSharedStateDir();
    this.mcpCacheFilePath = path.join(this.sharedStateDir, 'qqbot-mcp-cache.json');
    this.ws = null;
    this.seq = 0;
    this.connectionState = 'offline';
    this.manualDisconnect = false;
    this.disposed = false;
    this.runtimeActive = true;
    this.runtimeBlockedByOther = false;
    this.runtimeBlockedOwnerPid = 0;
    this.selfUserId = '';
    this.selfNickname = 'QQBot';
    this.chatSessions = new Map();
    this.uiListeners = new Set();
    this.persistTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.heartbeatTimer = null;
    this.sessionId = '';
    this.lastSeq = null;
    this.hiddenPrivateTargets = new Set();
    this.hiddenGroupTargets = new Set();
    this.contactDirectory = new Map();
    this.contactDirectoryLoaded = true;
    this.contactDirectoryLoading = null;
    this.groupMembersByGroupId = new Map();
    this.groupMembersLoading = new Map();
    this.pendingRequests = new Map();
    this.autoReplyChains = new Map();
    this.officialMessageSeqByChat = new Map();
    this.chatOrchestrator = new ChatOrchestrator({
      getAgentConfig: () => this.getAgentConfig(),
      log: (message) => this.log(message),
    });

    this.output = vscode.window.createOutputChannel('QQ Copilot Connector');
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = commandId('connect');
    this.statusBar.text = '$(plug) QQBot: Offline';
    this.statusBar.tooltip = 'Click to connect QQBot';
    this.statusBar.show();

    this.restoreHiddenTargets();
    restoreCachedSessions(this, CHAT_CACHE_STORE_KEY);
    this.ensureSharedStateDir();
    this.log('QQBot runtime initialized.');
  }

  onUiState(listener) {
    this.uiListeners.add(listener);
    return new vscode.Disposable(() => {
      this.uiListeners.delete(listener);
    });
  }

  emitUiUpdate() {
    for (const listener of this.uiListeners) {
      try {
        listener();
      } catch (error) {
        this.log(`UI listener error: ${error?.message || String(error)}`);
      }
    }
  }

  getBackendMode() {
    return 'qqbot';
  }

  getHistoryCutoff() {
    return Date.now() - HISTORY_RETENTION_MS;
  }

  getMaxMessagesPerChat() {
    const config = vscode.workspace.getConfiguration();
    const value = Number(getConfigValue(config, 'maxMessagesPerChat', 500));
    if (Number.isNaN(value)) {
      return 500;
    }
    return Math.max(50, Math.min(2000, Math.floor(value)));
  }

  getQQBotConfig() {
    const config = vscode.workspace.getConfiguration();
    return {
      appId: String(getConfigValue(config, 'qqbotAppId', '') || '').trim(),
      clientSecret: String(getConfigValue(config, 'qqbotClientSecret', '') || '').trim(),
      botName: String(getConfigValue(config, 'qqbotBotName', 'QQBot') || 'QQBot').trim() || 'QQBot',
      markdownSupport: getConfigValue(config, 'qqbotMarkdownSupport', false) === true,
    };
  }

  getAgentConfig() {
    const config = vscode.workspace.getConfiguration();
    return {
      autoReply: getConfigValue(config, 'qqbotAutoReply', true) !== false,
      useTools: getConfigValue(config, 'qqbotUseTools', true) !== false,
      modelVendor: String(getConfigValue(config, 'qqbotModelVendor', 'copilot') || '').trim(),
      modelFamily: String(getConfigValue(config, 'qqbotModelFamily', '') || '').trim(),
      systemPrompt: String(
        getConfigValue(
          config,
          'qqbotSystemPrompt',
          '你是在 VS Code 中运行的 QQBot 助手。回答要直接、简洁、准确。必要时可以调用可用工具。'
        ) || ''
      ).trim(),
      maxToolRounds: Math.max(1, Math.min(8, Number(getConfigValue(config, 'qqbotMaxToolRounds', 4) || 4))),
    };
  }

  setChatOrchestrator(orchestrator) {
    if (orchestrator && typeof orchestrator.runModelWithTools === 'function') {
      this.chatOrchestrator = orchestrator;
    }
  }

  getAnonymizedTargetLabel(type, targetId) {
    const normalizedType = String(type || '').trim();
    const normalizedTargetId = String(targetId || '').trim();
    if (!normalizedTargetId) {
      return normalizedType === 'group' ? '群聊' : '用户';
    }
    const sourceIds = new Set();
    for (const session of this.chatSessions.values()) {
      if (String(session?.type || '') === normalizedType && session?.targetId) {
        sourceIds.add(String(session.targetId));
      }
    }
    for (const contact of this.contactDirectory.values()) {
      if (String(contact?.type || '') === normalizedType && contact?.targetId) {
        sourceIds.add(String(contact.targetId));
      }
    }
    const orderedIds = Array.from(sourceIds.values()).sort((left, right) => left.localeCompare(right));
    const index = Math.max(0, orderedIds.indexOf(normalizedTargetId)) + 1;
    if (normalizedType === 'group') {
      return `群聊${index || 1}`;
    }
    return `用户${index || 1}`;
  }

  getChatDisplayInfo(type, targetId, title = '') {
    const normalizedType = String(type || '').trim();
    const normalizedTargetId = String(targetId || '').trim();
    const rawTitle = String(title || '').trim();
    const shouldAnonymizePrivate = normalizedType === 'private'
      && (!rawTitle || rawTitle === normalizedTargetId || looksLikeQqOpenId(rawTitle) || rawTitle.includes('...'));
    if (shouldAnonymizePrivate) {
      return {
        displayTitle: this.getAnonymizedTargetLabel('private', normalizedTargetId),
        displaySubtitle: normalizedTargetId,
      };
    }
    const fallbackTitle = rawTitle || (normalizedType === 'group' ? `群聊 ${normalizedTargetId}` : normalizedTargetId || '用户');
    return {
      displayTitle: fallbackTitle,
      displaySubtitle: normalizedTargetId && fallbackTitle !== normalizedTargetId ? normalizedTargetId : '',
    };
  }

  getMessageSenderDisplayInfo(message, selectedSession) {
    const senderId = String(message?.senderId || '').trim();
    const senderName = String(message?.senderName || '').trim();
    if (message?.direction === 'out') {
      return {
        displaySenderName: senderName || this.selfNickname || '我',
        displaySenderSubtitle: '',
      };
    }
    const sessionType = String(selectedSession?.type || '').trim();
    if (sessionType === 'private' && senderId) {
      const chatDisplay = this.getChatDisplayInfo('private', senderId, senderName);
      return {
        displaySenderName: chatDisplay.displayTitle,
        displaySenderSubtitle: chatDisplay.displaySubtitle,
      };
    }
    return {
      displaySenderName: senderName || senderId || 'unknown',
      displaySenderSubtitle: senderId && senderId !== senderName ? senderId : '',
    };
  }

  resolveSharedStateDir() {
    const baseDir = this.context?.globalStorageUri?.fsPath
      || this.context?.logUri?.fsPath
      || path.join(this.context?.extensionPath || process.cwd(), LOG_DIR_NAME);
    return baseDir;
  }

  ensureSharedStateDir() {
    try {
      fs.mkdirSync(this.sharedStateDir, { recursive: true });
    } catch (error) {
      this.log(`ensureSharedStateDir failed: ${error?.message || String(error)}`);
    }
  }

  writeSharedSessionSnapshot(payload) {
    try {
      this.ensureSharedStateDir();
      fs.writeFileSync(this.mcpCacheFilePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
      this.log(`writeSharedSessionSnapshot failed: ${error?.message || String(error)}`);
    }
  }

  pruneSessionMessages(session) {
    const cutoff = this.getHistoryCutoff();
    const max = this.getMaxMessagesPerChat();
    session.messages = session.messages
      .filter((item) => Number(item.timestamp || 0) >= cutoff)
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
    if (session.messages.length > max) {
      session.messages.splice(0, session.messages.length - max);
    }
    session.seenKeys = new Set(session.messages.map((item) => String(item.messageKey || item.id)));
    session.messageIdIndex = new Map();
    for (const item of session.messages) {
      const rawId = String(item.rawMessageId || '').trim();
      if (rawId) {
        session.messageIdIndex.set(rawId, item);
      }
    }
    if (session.messages.length > 0) {
      const last = session.messages[session.messages.length - 1];
      session.lastTs = Number(last.timestamp || Date.now());
      session.preview = toBrief(Array.isArray(last.segments) ? last.segments : []);
    } else {
      session.lastTs = 0;
      session.preview = '';
      session.unread = 0;
    }
  }

  pruneAllSessions() {
    for (const [chatId, session] of this.chatSessions.entries()) {
      this.pruneSessionMessages(session);
      if (session.messages.length === 0) {
        this.chatSessions.delete(chatId);
      }
    }
  }

  schedulePersistCache() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      persistCacheNow(this, CHAT_CACHE_STORE_KEY);
    }, 800);
  }

  persistCacheNow() {
    persistCacheNow(this, CHAT_CACHE_STORE_KEY);
  }

  clearChatCache() {
    const count = this.chatSessions.size;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.chatSessions.clear();
    this.contactDirectory.clear();
    this.persistCacheNow();
    this.emitUiUpdate();
    this.log(`Local chat cache cleared: removed_sessions=${count}`);
  }

  restoreHiddenTargets() {
    const stored = this.context?.workspaceState?.get(HIDDEN_TARGETS_STORE_KEY);
    const privateIds = parseIdText(stored?.privateIds || '');
    const groupIds = parseIdText(stored?.groupIds || '');
    this.hiddenPrivateTargets = new Set(privateIds);
    this.hiddenGroupTargets = new Set(groupIds);
  }

  persistHiddenTargets() {
    const payload = {
      privateIds: Array.from(this.hiddenPrivateTargets.values()),
      groupIds: Array.from(this.hiddenGroupTargets.values()),
      updatedAt: Date.now(),
    };
    this.context?.workspaceState?.update(HIDDEN_TARGETS_STORE_KEY, payload).catch((error) => {
      this.log(`persistHiddenTargets failed: ${error?.message || String(error)}`);
    });
  }

  getHiddenTargetsSnapshot() {
    const privateIds = Array.from(this.hiddenPrivateTargets.values()).sort();
    const groupIds = Array.from(this.hiddenGroupTargets.values()).sort();
    return {
      privateIds,
      groupIds,
      privateText: privateIds.join(','),
      groupText: groupIds.join(','),
    };
  }

  setHiddenTargetsFromText(privateText = '', groupText = '', source = 'settings') {
    this.hiddenPrivateTargets = new Set(parseIdText(privateText));
    this.hiddenGroupTargets = new Set(parseIdText(groupText));
    this.persistHiddenTargets();
    this.schedulePersistCache();
    this.emitUiUpdate();
    this.log(`Hidden targets updated: source=${source}, private=${this.hiddenPrivateTargets.size}, group=${this.hiddenGroupTargets.size}`);
  }

  hideChatById(chatId, source = 'menu') {
    const full = String(chatId || '').trim();
    const splitAt = full.indexOf(':');
    if (splitAt <= 0 || splitAt >= full.length - 1) {
      return { ok: false, reason: 'invalid chat id' };
    }
    const type = full.slice(0, splitAt);
    const targetId = full.slice(splitAt + 1).trim();
    if (!targetId) {
      return { ok: false, reason: 'invalid target id' };
    }
    if (type === 'private') {
      this.hiddenPrivateTargets.add(targetId);
    } else if (type === 'group') {
      this.hiddenGroupTargets.add(targetId);
    } else {
      return { ok: false, reason: `unsupported chat type: ${type}` };
    }
    this.persistHiddenTargets();
    this.schedulePersistCache();
    this.emitUiUpdate();
    this.log(`Chat hidden: source=${source}, chatId=${chatId}`);
    return { ok: true, type, targetId };
  }

  isChatHidden(type, targetId) {
    const chatType = String(type || '').trim();
    const id = String(targetId || '').trim();
    if (chatType === 'private') {
      return this.hiddenPrivateTargets.has(id);
    }
    if (chatType === 'group') {
      return this.hiddenGroupTargets.has(id);
    }
    return false;
  }

  upsertSession({ chatId, type, targetId, title, avatarUrl = '' }) {
    let session = this.chatSessions.get(chatId);
    if (!session) {
      session = {
        id: chatId,
        type,
        targetId,
        title,
        avatarUrl,
        preview: '',
        lastTs: 0,
        unread: 0,
        messages: [],
        seenKeys: new Set(),
        messageIdIndex: new Map(),
        historyCount: 80,
        loadingOlder: false,
      };
      this.chatSessions.set(chatId, session);
    } else if (title && (!session.title || session.title === session.targetId)) {
      session.title = title;
    }
    if (avatarUrl) {
      session.avatarUrl = avatarUrl;
    }
    if (!session.seenKeys) {
      session.seenKeys = new Set();
    }
    if (!session.messageIdIndex) {
      session.messageIdIndex = new Map();
    }
    return session;
  }

  markChatRead(chatId) {
    const session = this.chatSessions.get(chatId);
    if (!session) {
      return;
    }
    if (session.unread > 0) {
      session.unread = 0;
      this.schedulePersistCache();
      this.emitUiUpdate();
    }
  }

  rememberContact(type, targetId, title, avatarUrl = '') {
    const chatId = `${type}:${targetId}`;
    const display = this.getChatDisplayInfo(type, targetId, title);
    this.contactDirectory.set(chatId, {
      id: chatId,
      source: 'directory',
      type,
      targetId,
      title,
      displayTitle: display.displayTitle,
      displaySubtitle: display.displaySubtitle,
      avatarUrl,
      preview: type === 'group' ? `群聊 · ${targetId}` : `私聊 · ${targetId}`,
      searchText: [title, display.displayTitle, display.displaySubtitle, targetId].filter(Boolean).join('\n'),
    });
  }

  searchDirectory(queryText, limit = 30) {
    const q = String(queryText || '').trim().toLowerCase();
    if (!q) {
      return [];
    }
    return Array.from(this.contactDirectory.values())
      .filter((item) => {
        if (this.isChatHidden(item.type, item.targetId)) {
          return false;
        }
        return String(item.searchText || '').toLowerCase().includes(q);
      })
      .slice(0, Math.max(1, Math.min(100, Number(limit || 30))));
  }

  async refreshContactDirectory() {
    this.emitUiUpdate();
  }

  async ensureChatSession(contact) {
    const type = String(contact?.type || '');
    const targetId = String(contact?.targetId || '');
    if ((type !== 'private' && type !== 'group') || !targetId) {
      throw new Error('Invalid chat target.');
    }
    const title = String(contact?.title || (type === 'group' ? `群 ${targetId}` : targetId));
    const avatarUrl = String(contact?.avatarUrl || (type === 'group' ? getGroupAvatarUrl(targetId) : getPrivateAvatarUrl(targetId)));
    this.rememberContact(type, targetId, title, avatarUrl);
    const session = this.upsertSession({ chatId: `${type}:${targetId}`, type, targetId, title, avatarUrl });
    this.emitUiUpdate();
    this.schedulePersistCache();
    return session;
  }

  getGroupMembers() {
    return [];
  }

  async ensureGroupMembers() {
    return [];
  }

  getBackendUiConfig() {
    const qqbot = this.getQQBotConfig();
    const agent = this.getAgentConfig();
    return {
      mode: 'qqbot',
      supportsLocalBackend: false,
      rootDir: '',
      tokenFile: '',
      quickLoginUin: '',
      backendManagedActive: false,
      backendProcessRunning: false,
      backendManualMode: false,
      backendLastLaunchFile: '',
      qqbotAppId: qqbot.appId,
      qqbotClientSecret: qqbot.clientSecret,
      qqbotClientSecretMasked: maskSecret(qqbot.clientSecret),
      qqbotBotName: qqbot.botName,
      qqbotMarkdownSupport: qqbot.markdownSupport,
      qqbotAutoReply: agent.autoReply,
      qqbotUseTools: agent.useTools,
      qqbotModelVendor: agent.modelVendor,
      qqbotModelFamily: agent.modelFamily,
    };
  }

  extractPlainTextFromSegments(segments) {
    const list = Array.isArray(segments) ? segments : [];
    const parts = [];
    for (const seg of list) {
      if (!seg || typeof seg !== 'object') {
        continue;
      }
      if (seg.type === 'text' && seg.text) {
        parts.push(String(seg.text));
        continue;
      }
      if (seg.type === 'image') {
        parts.push('[图片]');
        continue;
      }
      if (seg.type === 'video') {
        parts.push('[视频]');
        continue;
      }
      if (seg.label) {
        parts.push(`[${String(seg.label)}]`);
      }
    }
    return parts.join(' ').trim();
  }

  buildTranscriptForChat(chatId, currentMessageId = '') {
    const session = this.chatSessions.get(chatId);
    if (!session) {
      return '';
    }
    const rows = Array.isArray(session.messages) ? session.messages.slice(-12) : [];
    return rows
      .filter((item) => String(item.rawMessageId || '') !== String(currentMessageId || ''))
      .map((item) => {
        const role = item.direction === 'out' ? '助手' : (item.senderName || item.senderId || '用户');
        const text = this.extractPlainTextFromSegments(item.segments);
        return text ? `${role}: ${text}` : '';
      })
      .filter(Boolean)
      .join('\n');
  }

  async getLanguageModel() {
    try {
      return await this.chatOrchestrator.getLanguageModel();
    } catch (error) {
      this.log(`selectChatModels failed: ${error?.message || String(error)}`);
      throw error;
    }
  }

  async prepareLanguageModelAccess() {
    return this.chatOrchestrator.prepareLanguageModelAccess();
  }

  async runModelWithTools(messages) {
    return this.chatOrchestrator.runModelWithTools(messages);
  }

  queueAutoReply(chatId, task) {
    const previous = this.autoReplyChains.get(chatId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(task)
      .catch((error) => {
        this.log(`Auto-reply chain error: chatId=${chatId}, reason=${error?.message || String(error)}`);
      });
    this.autoReplyChains.set(chatId, next.finally(() => {
      if (this.autoReplyChains.get(chatId) === next) {
        this.autoReplyChains.delete(chatId);
      }
    }));
  }

  async sendTextReplyByType(type, targetId, text, replyToMessageId = '') {
    if (type === 'group') {
      return this.sendGroupMessage(targetId, {
        text,
        replyToMessageId,
        images: [],
      });
    }
    return this.sendPrivateMessage(targetId, {
      text,
      replyToMessageId,
      images: [],
    });
  }

  nextOfficialMessageSeq(chatType, targetId) {
    const key = `${String(chatType || '').trim()}:${String(targetId || '').trim()}`;
    const current = Number(this.officialMessageSeqByChat.get(key) || 0);
    const next = current >= 1000000 ? 1 : current + 1;
    this.officialMessageSeqByChat.set(key, next);
    return next;
  }

  buildApprovalPrompt(approval) {
    const title = String(approval?.title || '').trim();
    const message = String(approval?.message || '').trim();
    const invocation = String(approval?.invocationMessage || '').trim();
    return [
      title || `工具 ${approval?.toolName || ''} 请求执行`,
      message,
      invocation ? `执行说明: ${invocation}` : '',
      '回复 y 确认执行，回复 n 取消执行。',
    ].filter(Boolean).join('\n\n');
  }

  async handlePendingApprovalResponse(params) {
    const pending = this.pendingRequests.get(params.chatId);
    if (!pending) {
      return false;
    }

    if (pending.senderId && params.senderId && pending.senderId !== params.senderId) {
      return false;
    }

    const plainText = this.extractPlainTextFromSegments(params.segments);
    const decision = normalizeApprovalDecision(plainText);
    if (!decision) {
      await this.sendTextReplyByType(
        params.type,
        params.targetId,
        `当前有待确认操作: ${pending.approval?.toolName || 'unknown'}。请回复 y 或 n。`,
        params.rawMessageId
      );
      return true;
    }

    this.pendingRequests.delete(params.chatId);
    this.queueAutoReply(params.chatId, async () => {
      try {
        const approved = decision === 'approve';
        await this.sendTextReplyByType(
          params.type,
          params.targetId,
          approved
            ? `已确认，开始执行 ${pending.approval?.toolName || 'tool'}。`
            : `已取消 ${pending.approval?.toolName || 'tool'}。`,
          params.rawMessageId
        );

        const result = await this.chatOrchestrator.continueRemoteApproval(pending.state, approved);
        if (result.status === 'awaiting-approval') {
          this.pendingRequests.set(params.chatId, {
            chatId: params.chatId,
            senderId: pending.senderId,
            approval: result.approval,
            state: result.state,
            targetId: params.targetId,
            type: params.type,
          });
          await this.sendTextReplyByType(
            params.type,
            params.targetId,
            this.buildApprovalPrompt(result.approval),
            params.rawMessageId
          );
          return;
        }

        const replyText = String(result.text || '').trim();
        if (replyText) {
          await this.sendTextReplyByType(params.type, params.targetId, replyText, params.rawMessageId);
          this.log(`Auto-reply sent after approval: chatId=${params.chatId}, target=${params.targetId}`);
        }
      } catch (error) {
        this.log(`Pending approval resolution failed: chatId=${params.chatId}, reason=${error?.message || String(error)}`);
        await this.sendTextReplyByType(
          params.type,
          params.targetId,
          `执行失败: ${error?.message || String(error)}`,
          params.rawMessageId
        );
      }
    });

    return true;
  }

  scheduleAutoReply(params) {
    const agent = this.getAgentConfig();
    if (!agent.autoReply) {
      return;
    }
    const chatId = String(params.chatId || '').trim();
    if (!chatId) {
      return;
    }
    this.queueAutoReply(chatId, async () => {
      await this.generateAutoReply(params);
    });
  }

  async generateAutoReply({ chatId, type, targetId, title, rawMessageId, senderId, senderName, segments }) {
    const plainText = this.extractPlainTextFromSegments(segments);
    this.log(
      `Incoming request: chatId=${chatId}, type=${type}, from=${senderName || senderId || 'unknown'}, messageId=${rawMessageId || '(none)'}, body=${clipForLog(plainText || '[empty]', 400)}`
    );

    if (!plainText) {
      this.log(`Auto-reply skipped: chatId=${chatId}, reason=empty-message`);
      return;
    }

    try {
      const result = await this.chatOrchestrator.handleRemoteRequest({
        source: 'qqbot',
        sessionKey: chatId,
        message: plainText,
        attachments: [],
      });
      const replyText = String(result.text || '').trim();
      this.log(`Model reply generated: model=${result.modelName}, chatId=${chatId}, status=${result.status || 'completed'}, text=${clipForLog(replyText, 400)}`);

      if (result.status === 'awaiting-approval' && result.approval && result.state) {
        this.pendingRequests.set(chatId, {
          chatId,
          senderId,
          approval: result.approval,
          state: result.state,
          targetId,
          type,
        });
        await this.sendTextReplyByType(type, targetId, this.buildApprovalPrompt(result.approval), rawMessageId);
        this.log(`Auto-reply waiting for approval: chatId=${chatId}, tool=${result.approval.toolName}`);
        return;
      }

      if (!replyText) {
        this.log(`Auto-reply skipped: chatId=${chatId}, reason=empty-model-output`);
        return;
      }

      await this.sendTextReplyByType(type, targetId, replyText, rawMessageId);
      this.log(`Auto-reply sent: chatId=${chatId}, target=${targetId}`);
    } catch (error) {
      this.log(`Auto-reply failed: chatId=${chatId}, reason=${error?.message || String(error)}`);
    }
  }

  getUiState(preferredChatId = '', searchQuery = '') {
    const runtimeActive = Boolean(this.runtimeActive);
    const chats = Array.from(this.chatSessions.values()).sort((a, b) => b.lastTs - a.lastTs);
    const visibleChats = runtimeActive ? chats.filter((item) => !this.isChatHidden(item.type, item.targetId)) : [];
    let selectedChatId = '';
    if (runtimeActive && preferredChatId && this.chatSessions.has(preferredChatId)) {
      const preferred = this.chatSessions.get(preferredChatId);
      if (preferred && !this.isChatHidden(preferred.type, preferred.targetId)) {
        selectedChatId = preferredChatId;
      }
    }
    const selectedSession = selectedChatId ? this.chatSessions.get(selectedChatId) : null;
    const q = String(searchQuery || '').trim();
    const sessionMatches = q
      ? visibleChats.filter((item) => [item.title, item.targetId, item.id].filter(Boolean).join('\n').toLowerCase().includes(q.toLowerCase()))
      : visibleChats;
    const directoryResults = q && sessionMatches.length === 0 ? this.searchDirectory(q, 30) : [];
    return {
      connectionState: runtimeActive ? this.connectionState : 'offline',
      runtimeActive,
      runtimeBlockedByOther: false,
      runtimeBlockedOwnerPid: 0,
      selfUserId: String(this.selfUserId || ''),
      selfNickname: String(this.selfNickname || 'QQBot'),
      selfAvatarUrl: this.selfUserId ? getPrivateAvatarUrl(this.selfUserId) : '',
      chats: visibleChats.map((item) => {
        const display = this.getChatDisplayInfo(item.type, item.targetId, item.title);
        const list = Array.isArray(item.messages) ? item.messages : [];
        const last = list.length > 0 ? list[list.length - 1] : null;
        const senderId = String(last?.senderId || '').trim();
        const senderName = String(last?.senderName || '').trim();
        const isSystem = String(last?.displayStyle || '') === 'system';
        let previewSender = '';
        if (!isSystem && (senderName || senderId)) {
          previewSender = senderName || senderId;
          if (senderId && this.selfUserId && senderId === String(this.selfUserId)) {
            previewSender = '我';
          }
        }
        return {
          id: item.id,
          type: item.type,
          targetId: item.targetId,
          title: item.title,
          displayTitle: display.displayTitle,
          displaySubtitle: display.displaySubtitle,
          avatarUrl: item.avatarUrl || '',
          preview: item.preview,
          previewSender,
          unread: item.unread,
          lastTs: item.lastTs,
        };
      }),
      directoryResults: directoryResults.map((item) => {
        const display = this.getChatDisplayInfo(item.type, item.targetId, item.title);
        return {
          ...item,
          displayTitle: display.displayTitle,
          displaySubtitle: display.displaySubtitle,
        };
      }),
      directorySearchPending: false,
      selectedChatId,
      selectedChatType: selectedSession ? selectedSession.type : '',
      selectedTargetId: selectedSession ? String(selectedSession.targetId || '') : '',
      selectedMembers: [],
      selectedMessages: selectedSession
        ? selectedSession.messages.map((msg) => {
            const senderDisplay = this.getMessageSenderDisplayInfo(msg, selectedSession);
            return {
              id: msg.id,
              rawMessageId: msg.rawMessageId || '',
              direction: msg.direction,
              displayStyle: msg.displayStyle || 'bubble',
              senderId: msg.senderId,
              senderName: msg.senderName,
              displaySenderName: senderDisplay.displaySenderName,
              displaySenderSubtitle: senderDisplay.displaySenderSubtitle,
              avatarUrl: msg.senderAvatarUrl || '',
              timestamp: msg.timestamp,
              segments: msg.segments,
            };
          })
        : [],
      isLoadingOlder: false,
      hidden: this.getHiddenTargetsSnapshot(),
      backend: this.getBackendUiConfig(),
    };
  }

  appendMessageToSession({
    chatId,
    type,
    targetId,
    title,
    avatarUrl = '',
    direction,
    senderId,
    senderName,
    senderAvatarUrl = '',
    segments,
    timestamp,
    messageId = '',
    rawMessageId = '',
    displayStyle = 'bubble',
    countUnread = direction === 'in',
  }) {
    const session = this.upsertSession({ chatId, type, targetId, title, avatarUrl });
    const ts = timestamp || Date.now();
    const preview = toBrief(segments);
    const keyRaw = messageId || rawMessageId || `${ts}|${direction}|${senderId}|${preview}`;
    const messageKey = `mid:${keyRaw}`;
    if (session.seenKeys.has(messageKey)) {
      return false;
    }
    session.seenKeys.add(messageKey);
    const message = {
      id: `${ts}-${Math.random().toString(36).slice(2, 8)}`,
      messageKey,
      rawMessageId: String(rawMessageId || messageId || ''),
      direction,
      senderId: String(senderId || ''),
      senderName: String(senderName || ''),
      senderAvatarUrl: String(senderAvatarUrl || ''),
      timestamp: ts,
      displayStyle,
      segments: Array.isArray(segments) ? segments : [{ type: 'text', text: '[空消息]' }],
    };
    session.messages.push(message);
    session.lastTs = ts;
    session.preview = preview;
    if (countUnread) {
      session.unread += 1;
    }
    if (message.rawMessageId) {
      session.messageIdIndex.set(message.rawMessageId, message);
    }
    this.pruneSessionMessages(session);
    this.schedulePersistCache();
    this.emitUiUpdate();
    return true;
  }

  appendSystemMessage(chatId, text) {
    const splitAt = chatId.indexOf(':');
    if (splitAt <= 0) {
      return;
    }
    const type = chatId.slice(0, splitAt);
    const targetId = chatId.slice(splitAt + 1);
    const title = type === 'group' ? `群 ${targetId}` : targetId;
    this.appendMessageToSession({
      chatId,
      type,
      targetId,
      title,
      avatarUrl: type === 'group' ? getGroupAvatarUrl(targetId) : getPrivateAvatarUrl(targetId),
      direction: 'in',
      senderId: '',
      senderName: '',
      segments: [{ type: 'text', text }],
      timestamp: Date.now(),
      displayStyle: 'system',
      countUnread: false,
    });
  }

  isConnected() {
    return this.connectionState === 'online' && !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  async ensureConnected(timeoutMs = 7000) {
    if (this.isConnected()) {
      return true;
    }
    const alreadyConnecting = !!this.ws && this.ws.readyState === WebSocket.CONNECTING;
    if (!alreadyConnecting) {
      await this.connect({ silent: true, reason: 'ensureConnected' });
    }
    if (this.isConnected()) {
      return true;
    }
    const socket = this.ws;
    if (!socket) {
      return false;
    }
    return new Promise((resolve) => {
      const finish = (result) => {
        clearTimeout(timer);
        socket.off('open', onOpen);
        socket.off('close', onClose);
        socket.off('error', onError);
        resolve(result);
      };
      const onOpen = () => {
        const waitReady = setInterval(() => {
          if (this.isConnected()) {
            clearInterval(waitReady);
            finish(true);
          }
        }, 100);
        setTimeout(() => {
          clearInterval(waitReady);
          finish(this.isConnected());
        }, timeoutMs);
      };
      const onClose = () => finish(false);
      const onError = () => finish(false);
      const timer = setTimeout(() => finish(this.isConnected()), timeoutMs);
      socket.once('open', onOpen);
      socket.once('close', onClose);
      socket.once('error', onError);
    });
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  cleanupSocketOnly() {
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
      }
      this.ws = null;
    }
  }

  scheduleReconnect(reason = 'unknown') {
    const config = vscode.workspace.getConfiguration();
    if (this.manualDisconnect || this.disposed || getConfigValue(config, 'autoReconnect', true) !== true) {
      return;
    }
    this.clearReconnectTimer();
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempts, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempts += 1;
    this.log(`Scheduling reconnect in ${delay}ms: ${reason}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect({ silent: true, reason: `reconnect-${reason}` }).catch((error) => {
        this.log(`Reconnect failed: ${error?.message || String(error)}`);
      });
    }, delay);
  }

  async startPluginRuntime(options = {}) {
    this.runtimeActive = true;
    this.manualDisconnect = false;
    await this.connect({
      silent: options.silent === true,
      reason: String(options.reason || 'runtime-start'),
    });
    return { ok: true, reason: 'started' };
  }

  async stopPluginRuntime(options = {}) {
    this.runtimeActive = false;
    this.manualDisconnect = true;
    this.clearReconnectTimer();
    this.disconnect();
    this.connectionState = 'offline';
    this.statusBar.text = '$(circle-large-outline) QQBot: Stopped';
    this.statusBar.tooltip = 'Plugin not running in current window';
    this.emitUiUpdate();
    return { ok: true, reason: String(options.trigger || 'runtime-stop') };
  }

  async startBackend() {
    return { ok: true, skipped: true, reason: 'qqbot-mode-no-backend' };
  }

  async stopBackend(options = {}) {
    if (options.disconnectSocket === true) {
      this.disconnect();
    }
    return { ok: true, skipped: true, reason: 'qqbot-mode-no-backend' };
  }

  resolveBackendWebAccess() {
    return {
      resolvedUrl: '',
      webToken: '',
    };
  }

  disconnect() {
    this.manualDisconnect = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
      }
      this.ws = null;
    }
    this.connectionState = 'offline';
    this.statusBar.text = '$(plug) QQBot: Offline';
    this.statusBar.tooltip = 'QQBot offline';
    this.emitUiUpdate();
  }

  async connect(options = {}) {
    const silent = options.silent === true;
    const reason = String(options.reason || 'manual');
    if (this.disposed) {
      return;
    }
    if (!this.runtimeActive) {
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      return;
    }

    const qqbot = this.getQQBotConfig();
    if (!qqbot.appId || !qqbot.clientSecret) {
      const message = 'QQBot 配置不完整，请先设置 AppID 和 ClientSecret。';
      this.log(message);
      this.connectionState = 'offline';
      this.emitUiUpdate();
      if (!silent) {
        vscode.window.showErrorMessage(message);
      }
      return;
    }

    this.manualDisconnect = false;
    this.cleanupSocketOnly();
    this.connectionState = 'connecting';
    this.selfUserId = qqbot.appId;
    this.selfNickname = qqbot.botName;
    this.statusBar.text = '$(sync~spin) QQBot: Connecting';
    this.statusBar.tooltip = `AppID ${qqbot.appId}`;
    this.emitUiUpdate();
    this.log(`Connecting to QQ official gateway: appId=${qqbot.appId}, botName=${qqbot.botName}`);

    let accessToken;
    let gatewayUrl;
    try {
      accessToken = await getAccessToken(qqbot.appId, qqbot.clientSecret);
      gatewayUrl = await getGatewayUrl(accessToken);
    } catch (error) {
      this.connectionState = 'offline';
      this.statusBar.text = '$(error) QQBot: Error';
      this.statusBar.tooltip = error?.message || String(error);
      this.emitUiUpdate();
      this.log(`Gateway bootstrap failed: ${error?.message || String(error)}`);
      if (!silent) {
        vscode.window.showErrorMessage(`QQBot 连接失败: ${error?.message || String(error)}`);
      }
      return;
    }

    const ws = new WebSocket(gatewayUrl);
    this.ws = ws;

    ws.on('open', () => {
      this.log(`Gateway socket opened: reason=${reason}`);
    });

    ws.on('message', (raw) => {
      this.handleGatewayFrame(raw, accessToken, qqbot);
    });

    ws.on('close', (code, reasonText) => {
      if (this.ws === ws) {
        this.ws = null;
      }
      this.stopHeartbeat();
      this.connectionState = 'offline';
      this.statusBar.text = '$(plug) QQBot: Offline';
      this.statusBar.tooltip = `Disconnected (${code}${reasonText ? `, ${String(reasonText)}` : ''})`;
      this.emitUiUpdate();
      this.log(`Gateway closed: code=${code}, reason=${String(reasonText || '')}`);
      if (!this.manualDisconnect && !this.disposed) {
        this.scheduleReconnect(`close-${code}`);
      }
    });

    ws.on('error', (error) => {
      this.connectionState = 'offline';
      this.statusBar.text = '$(error) QQBot: Error';
      this.statusBar.tooltip = error?.message || String(error);
      this.emitUiUpdate();
      this.log(`Gateway error: ${error?.message || String(error)}`);
      if (!silent) {
        vscode.window.showErrorMessage(`QQBot 连接失败: ${error?.message || String(error)}`);
      }
    });
  }

  handleGatewayFrame(raw, accessToken, qqbot) {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (typeof payload.s === 'number') {
      this.lastSeq = payload.s;
    }
    if (payload.op === 10) {
      const interval = Number(payload?.d?.heartbeat_interval || 30000);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          op: 2,
          d: {
            token: `QQBot ${accessToken}`,
            intents: QQBOT_INTENTS,
            shard: [0, 1],
          },
        }));
      }
      this.stopHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ op: 1, d: this.lastSeq }));
        }
      }, interval);
      return;
    }
    if (payload.op === 11) {
      return;
    }
    if (payload.op === 7) {
      this.log('Gateway requested reconnect.');
      this.disconnect();
      this.manualDisconnect = false;
      this.scheduleReconnect('server-request');
      return;
    }
    if (payload.op === 9) {
      this.log('Gateway invalid session, reconnecting.');
      tokenCache.delete(qqbot.appId);
      this.disconnect();
      this.manualDisconnect = false;
      this.scheduleReconnect('invalid-session');
      return;
    }
    if (payload.op !== 0) {
      return;
    }
    const eventType = String(payload.t || '').trim();
    if (eventType === 'READY') {
      const ready = payload.d || {};
      this.sessionId = String(ready.session_id || '');
      this.connectionState = 'online';
      this.reconnectAttempts = 0;
      this.statusBar.text = `$(radio-tower) QQBot: ${qqbot.botName}`;
      this.statusBar.tooltip = `QQBot connected: ${qqbot.appId}`;
      this.emitUiUpdate();
      this.log(`Gateway ready: session=${this.sessionId || '(none)'}`);
      return;
    }
    if (eventType === 'RESUMED') {
      this.connectionState = 'online';
      this.emitUiUpdate();
      this.log('Gateway resumed.');
      return;
    }
    if (eventType === 'C2C_MESSAGE_CREATE') {
      this.ingestOfficialEvent('private', payload.d, { title: '', chatType: 'c2c' });
      return;
    }
    if (eventType === 'GROUP_AT_MESSAGE_CREATE') {
      this.ingestOfficialEvent('group', payload.d, { title: '', chatType: 'group' });
      return;
    }
    if (eventType === 'AT_MESSAGE_CREATE' || eventType === 'DIRECT_MESSAGE_CREATE') {
      this.ingestUnsupportedOfficialEvent(payload.d, eventType);
    }
  }

  ingestUnsupportedOfficialEvent(event, eventType) {
    const authorId = String(event?.author?.id || '').trim();
    const content = String(event?.content || '').trim() || `[${eventType}] 当前前端仅展示 C2C 与群 AT 消息`;
    if (!authorId) {
      return;
    }
    const chatId = `private:${authorId}`;
    const title = String(event?.author?.username || authorId).trim() || authorId;
    const avatarUrl = getPrivateAvatarUrl(authorId);
    this.rememberContact('private', authorId, title, avatarUrl);
    const inserted = this.appendMessageToSession({
      chatId,
      type: 'private',
      targetId: authorId,
      title,
      avatarUrl,
      direction: 'in',
      senderId: authorId,
      senderName: title,
      senderAvatarUrl: avatarUrl,
      segments: buildSegmentsFromOfficialMessage(content, event?.attachments),
      timestamp: Date.now(),
      rawMessageId: String(event?.id || ''),
    });
    if (inserted) {
      this.log(`Incoming request: chatId=${chatId}, type=private, event=${eventType}, from=${title}, messageId=${String(event?.id || '')}, body=${clipForLog(content, 400)}`);
    }
  }

  async ingestOfficialEvent(type, event) {
    if (!event || typeof event !== 'object') {
      return;
    }
    if (type === 'private') {
      const targetId = String(event?.author?.user_openid || '').trim();
      if (!targetId) {
        return;
      }
      const title = clipText(targetId, 18);
      const avatarUrl = getPrivateAvatarUrl(targetId);
      this.rememberContact('private', targetId, title, avatarUrl);
      const segments = buildSegmentsFromOfficialMessage(event.content, event.attachments);
      const inserted = this.appendMessageToSession({
        chatId: `private:${targetId}`,
        type: 'private',
        targetId,
        title,
        avatarUrl,
        direction: 'in',
        senderId: targetId,
        senderName: title,
        senderAvatarUrl: avatarUrl,
        segments,
        timestamp: Date.parse(String(event.timestamp || '')) || Date.now(),
        rawMessageId: String(event.id || ''),
      });
      if (inserted) {
        const approvalHandled = await this.handlePendingApprovalResponse({
          chatId: `private:${targetId}`,
          type: 'private',
          targetId,
          rawMessageId: String(event.id || ''),
          senderId: targetId,
          segments,
        });
        if (approvalHandled) {
          return;
        }
        this.scheduleAutoReply({
          chatId: `private:${targetId}`,
          type: 'private',
          targetId,
          title,
          rawMessageId: String(event.id || ''),
          senderId: targetId,
          senderName: title,
          segments,
        });
      }
      return;
    }
    const targetId = String(event?.group_openid || '').trim();
    const senderId = String(event?.author?.member_openid || '').trim();
    if (!targetId) {
      return;
    }
    const title = `群 ${clipText(targetId, 18)}`;
    const avatarUrl = getGroupAvatarUrl(targetId);
    const senderName = senderId ? clipText(senderId, 18) : title;
    this.rememberContact('group', targetId, title, avatarUrl);
    const segments = buildSegmentsFromOfficialMessage(event.content, event.attachments);
    const inserted = this.appendMessageToSession({
      chatId: `group:${targetId}`,
      type: 'group',
      targetId,
      title,
      avatarUrl,
      direction: 'in',
      senderId,
      senderName,
      senderAvatarUrl: getPrivateAvatarUrl(senderId),
      segments,
      timestamp: Date.parse(String(event.timestamp || '')) || Date.now(),
      rawMessageId: String(event.id || ''),
    });
    if (inserted) {
      const approvalHandled = await this.handlePendingApprovalResponse({
        chatId: `group:${targetId}`,
        type: 'group',
        targetId,
        rawMessageId: String(event.id || ''),
        senderId,
        segments,
      });
      if (approvalHandled) {
        return;
      }
      this.scheduleAutoReply({
        chatId: `group:${targetId}`,
        type: 'group',
        targetId,
        title,
        rawMessageId: String(event.id || ''),
        senderId,
        senderName,
        segments,
      });
    }
  }

  async sendOfficialText(chatType, targetId, text, replyToMessageId = '') {
    const qqbot = this.getQQBotConfig();
    const token = await getAccessToken(qqbot.appId, qqbot.clientSecret);
    const msgSeq = this.nextOfficialMessageSeq(chatType, targetId);
    const body = qqbot.markdownSupport
      ? { markdown: { content: text }, msg_type: 2, msg_seq: msgSeq }
      : { content: text, msg_type: 0, msg_seq: msgSeq };
    if (replyToMessageId) {
      body.msg_id = replyToMessageId;
    }
    const path = chatType === 'group'
      ? `/v2/groups/${targetId}/messages`
      : `/v2/users/${targetId}/messages`;
    return apiRequest(token, 'POST', path, body);
  }

  async uploadOfficialImage(chatType, targetId, image) {
    const qqbot = this.getQQBotConfig();
    const token = await getAccessToken(qqbot.appId, qqbot.clientSecret);
    const payload = decodeDataUrlPayload(image.dataUrl);
    if (!payload) {
      throw new Error('Invalid image payload.');
    }
    const uploadPath = chatType === 'group'
      ? `/v2/groups/${targetId}/files`
      : `/v2/users/${targetId}/files`;
    const uploadResp = await apiRequest(token, 'POST', uploadPath, {
      file_type: 1,
      file_data: payload.base64,
      srv_send_msg: false,
    });
    const msgSeq = this.nextOfficialMessageSeq(chatType, targetId);
    const sendPath = chatType === 'group'
      ? `/v2/groups/${targetId}/messages`
      : `/v2/users/${targetId}/messages`;
    return apiRequest(token, 'POST', sendPath, {
      msg_type: 7,
      media: { file_info: uploadResp.file_info },
      msg_seq: msgSeq,
    });
  }

  buildOutgoingSegments(composed) {
    const normalized = normalizeOutgoingRequest(composed);
    const segments = [];
    if (normalized.text) {
      segments.push({ type: 'text', text: normalized.text });
    }
    for (const image of normalized.images) {
      segments.push({ type: 'image', url: image.dataUrl, label: image.name || 'image' });
    }
    if (segments.length === 0) {
      segments.push({ type: 'text', text: '[空消息]' });
    }
    return segments;
  }

  async sendPrivateMessage(userId, message) {
    const ok = await this.ensureConnected();
    if (!ok) {
      throw new Error('QQBot is not connected.');
    }
    const targetId = String(userId || '').trim();
    const composed = normalizeOutgoingRequest(message);
    if (!targetId) {
      throw new Error('Target ID is empty.');
    }
    if (!composed.text.trim() && composed.images.length === 0) {
      throw new Error('Message is empty.');
    }
    let lastResponse = null;
    if (composed.text.trim()) {
      lastResponse = await this.sendOfficialText('private', targetId, composed.text.trim(), composed.replyToMessageId);
    }
    for (const image of composed.images) {
      lastResponse = await this.uploadOfficialImage('private', targetId, image);
    }
    const title = clipText(targetId, 18);
    const avatarUrl = getPrivateAvatarUrl(targetId);
    this.rememberContact('private', targetId, title, avatarUrl);
    this.appendMessageToSession({
      chatId: `private:${targetId}`,
      type: 'private',
      targetId,
      title,
      avatarUrl,
      direction: 'out',
      senderId: this.selfUserId || this.getQQBotConfig().appId,
      senderName: this.selfNickname || '我',
      senderAvatarUrl: this.selfUserId ? getPrivateAvatarUrl(this.selfUserId) : '',
      segments: this.buildOutgoingSegments(composed),
      timestamp: Date.now(),
      rawMessageId: String(lastResponse?.id || ''),
      countUnread: false,
    });
    return { status: 'ok', data: { message_id: lastResponse?.id || '' } };
  }

  async sendGroupMessage(groupId, message) {
    const ok = await this.ensureConnected();
    if (!ok) {
      throw new Error('QQBot is not connected.');
    }
    const targetId = String(groupId || '').trim();
    const composed = normalizeOutgoingRequest(message);
    if (!targetId) {
      throw new Error('Group target ID is empty.');
    }
    if (!composed.text.trim() && composed.images.length === 0) {
      throw new Error('Message is empty.');
    }
    let lastResponse = null;
    if (composed.text.trim()) {
      lastResponse = await this.sendOfficialText('group', targetId, composed.text.trim(), composed.replyToMessageId);
    }
    for (const image of composed.images) {
      lastResponse = await this.uploadOfficialImage('group', targetId, image);
    }
    const title = `群 ${clipText(targetId, 18)}`;
    const avatarUrl = getGroupAvatarUrl(targetId);
    this.rememberContact('group', targetId, title, avatarUrl);
    this.appendMessageToSession({
      chatId: `group:${targetId}`,
      type: 'group',
      targetId,
      title,
      avatarUrl,
      direction: 'out',
      senderId: this.selfUserId || this.getQQBotConfig().appId,
      senderName: this.selfNickname || '我',
      senderAvatarUrl: this.selfUserId ? getPrivateAvatarUrl(this.selfUserId) : '',
      segments: this.buildOutgoingSegments(composed),
      timestamp: Date.now(),
      rawMessageId: String(lastResponse?.id || ''),
      countUnread: false,
    });
    return { status: 'ok', data: { message_id: lastResponse?.id || '' } };
  }

  async sendMessageToChat(chatId, message) {
    const full = String(chatId || '').trim();
    const splitAt = full.indexOf(':');
    if (splitAt <= 0 || splitAt >= full.length - 1) {
      throw new Error(`Unsupported chat id: ${chatId}`);
    }
    const type = full.slice(0, splitAt);
    const targetId = full.slice(splitAt + 1);
    if (type === 'private') {
      return this.sendPrivateMessage(targetId, message);
    }
    if (type === 'group') {
      return this.sendGroupMessage(targetId, message);
    }
    throw new Error(`Unsupported chat type: ${type}`);
  }

  async sendJsonMessageToChat() {
    throw new Error('QQBot mode does not support OneBot JSON card messages.');
  }

  async recallMessageFromChat() {
    throw new Error('QQBot official API recall is not implemented in this frontend.');
  }

  async sendPokeToChat() {
    throw new Error('QQBot official API does not support the local backend poke action in this frontend.');
  }

  async loadOlderMessagesForChat() {
    return 0;
  }

  async getForwardPreview() {
    throw new Error('QQBot mode does not support merged-forward preview.');
  }

  async resolveImageUrlToDataUrl(rawUrl) {
    const url = String(rawUrl || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('invalid image url');
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = String(response.headers.get('content-type') || 'image/png').split(';')[0].trim();
    const buffer = Buffer.from(await response.arrayBuffer());
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  }

  async refreshMessageMediaForChat() {
    return { ok: false, reason: 'unsupported' };
  }

  callApi() {
    return Promise.reject(new Error('QQBot mode does not expose OneBot-style callApi.'));
  }

  async shutdownForDeactivate() {
    this.disconnect();
    this.dispose();
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.manualDisconnect = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistCacheNow();
    this.clearReconnectTimer();
    this.cleanupSocketOnly();
    this.statusBar.dispose();
    this.output.dispose();
    this.uiListeners.clear();
  }

  showLogs() {
    this.output.show(true);
  }

  log(message) {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}

module.exports = {
  QQBotRuntime,
};