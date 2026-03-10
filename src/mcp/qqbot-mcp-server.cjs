const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const API_BASE = 'https://api.sgroup.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

let tokenCache = null;

function normalizeChatType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (type === 'private' || type === 'group') {
    return type;
  }
  return '';
}

function looksLikeQqOpenId(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return false;
  }
  return /^[0-9A-F]{32}$/i.test(raw) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw);
}

function envText(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function clipText(text, max = 300) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
}

function getLogFilePath() {
  const configured = envText('QQBOT_MCP_LOG_FILE');
  if (configured) {
    return configured;
  }
  return path.join(os.tmpdir(), 'qqbot-mcp.log');
}

function getStateFilePath() {
  const configured = envText('QQBOT_MCP_STATE_FILE');
  if (configured) {
    return configured;
  }
  return path.join(os.tmpdir(), 'qqbot-mcp-state.json');
}

function getCacheFilePath() {
  const configured = envText('QQBOT_MCP_CACHE_FILE');
  if (configured) {
    return configured;
  }
  return path.join(os.tmpdir(), 'qqbot-mcp-cache.json');
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function getPrimaryChatConfig() {
  const stored = readJsonFile(getStateFilePath(), {});
  const stateType = normalizeChatType(stored?.primaryChatType);
  const stateId = String(stored?.primaryChatId || '').trim();
  const defaultType = normalizeChatType(envText('QQBOT_MCP_DEFAULT_CHAT_TYPE'));
  const defaultId = envText('QQBOT_MCP_DEFAULT_CHAT_ID');
  return {
    primaryChatType: stateType || defaultType,
    primaryChatId: stateId || defaultId,
    updatedAt: Number(stored?.updatedAt || 0),
  };
}

function savePrimaryChatConfig(input) {
  const primaryChatType = normalizeChatType(input?.chatType);
  const primaryChatId = String(input?.targetId || '').trim();
  if (!primaryChatType) {
    throw new Error('chatType must be private or group');
  }
  if (!primaryChatId) {
    throw new Error('targetId is required');
  }
  const nextState = {
    primaryChatType,
    primaryChatId,
    updatedAt: Date.now(),
  };
  writeJsonFile(getStateFilePath(), nextState);
  return nextState;
}

function extractPlainText(segments) {
  const list = Array.isArray(segments) ? segments : [];
  const parts = [];
  for (const segment of list) {
    if (!segment || typeof segment !== 'object') {
      continue;
    }
    if (segment.type === 'text' && segment.text) {
      parts.push(String(segment.text));
      continue;
    }
    if (segment.type === 'image') {
      parts.push('[图片]');
      continue;
    }
    if (segment.type === 'video') {
      parts.push('[视频]');
      continue;
    }
    if (segment.label) {
      parts.push(`[${String(segment.label)}]`);
    }
  }
  return parts.join(' ').trim();
}

function getMessageSnapshot() {
  const payload = readJsonFile(getCacheFilePath(), {});
  const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
  return {
    savedAt: Number(payload?.savedAt || 0),
    selfUserId: String(payload?.selfUserId || ''),
    selfNickname: String(payload?.selfNickname || ''),
    sessions,
  };
}

function getPrivateLabelIndex(targetId, sessions) {
  const orderedIds = Array.from(new Set((Array.isArray(sessions) ? sessions : [])
    .filter((session) => normalizeChatType(session?.type) === 'private')
    .map((session) => String(session?.targetId || '').trim())
    .filter(Boolean))).sort((left, right) => left.localeCompare(right));
  return Math.max(0, orderedIds.indexOf(String(targetId || '').trim())) + 1;
}

function getContactDisplayInfo(session, sessions) {
  const type = normalizeChatType(session?.type);
  const targetId = String(session?.targetId || '').trim();
  const rawTitle = String(session?.title || '').trim();
  if (type === 'private' && (!rawTitle || rawTitle === targetId || looksLikeQqOpenId(rawTitle) || rawTitle.includes('...'))) {
    return {
      displayName: `用户${getPrivateLabelIndex(targetId, sessions) || 1}`,
      subtitle: targetId,
    };
  }
  return {
    displayName: rawTitle || (type === 'group' ? `群聊 ${targetId}` : targetId || '用户'),
    subtitle: targetId && rawTitle !== targetId ? targetId : '',
  };
}

function listContacts(input) {
  const snapshot = getMessageSnapshot();
  const sessions = Array.isArray(snapshot.sessions) ? [...snapshot.sessions] : [];
  const chatType = normalizeChatType(input?.chatType);
  const targetId = String(input?.targetId || '').trim();
  const limit = Math.max(1, Math.min(200, Number(input?.limit || 100)));
  let filtered = sessions;
  if (chatType) {
    filtered = filtered.filter((session) => normalizeChatType(session?.type) === chatType);
  }
  if (targetId) {
    filtered = filtered.filter((session) => String(session?.targetId || '').trim() === targetId);
  }
  filtered.sort((left, right) => Number(right?.lastTs || 0) - Number(left?.lastTs || 0));
  filtered = filtered.slice(0, limit);
  return {
    savedAt: snapshot.savedAt,
    total: filtered.length,
    contacts: filtered.map((session) => {
      const display = getContactDisplayInfo(session, snapshot.sessions);
      return {
        chatId: String(session?.id || ''),
        type: normalizeChatType(session?.type),
        targetId: String(session?.targetId || ''),
        displayName: display.displayName,
        subtitle: display.subtitle,
        rawTitle: String(session?.title || ''),
        preview: String(session?.preview || ''),
        lastTs: Number(session?.lastTs || 0),
        unread: Number(session?.unread || 0),
        messageCount: Array.isArray(session?.messages) ? session.messages.length : 0,
      };
    }),
  };
}

function listMessages(input) {
  const snapshot = getMessageSnapshot();
  const explicitChatId = String(input?.chatId || '').trim();
  const explicitTargetId = String(input?.targetId || '').trim();
  const explicitChatType = normalizeChatType(input?.chatType);
  const limitChats = Math.max(1, Math.min(200, Number(input?.limitChats || 100)));
  const limitPerChat = Math.max(1, Math.min(200, Number(input?.limitPerChat || 50)));

  let sessions = Array.isArray(snapshot.sessions) ? [...snapshot.sessions] : [];
  if (explicitChatId) {
    sessions = sessions.filter((session) => String(session?.id || '') === explicitChatId);
  } else if (explicitTargetId || explicitChatType) {
    sessions = sessions.filter((session) => {
      const sessionType = normalizeChatType(session?.type);
      const sessionTargetId = String(session?.targetId || '').trim();
      if (explicitChatType && sessionType !== explicitChatType) {
        return false;
      }
      if (explicitTargetId && sessionTargetId !== explicitTargetId) {
        return false;
      }
      return true;
    });
  }

  sessions.sort((left, right) => Number(right?.lastTs || 0) - Number(left?.lastTs || 0));
  sessions = sessions.slice(0, limitChats);

  return {
    savedAt: snapshot.savedAt,
    selfUserId: snapshot.selfUserId,
    selfNickname: snapshot.selfNickname,
    chatCount: sessions.length,
    chats: sessions.map((session) => {
      const messages = Array.isArray(session?.messages) ? session.messages.slice(-limitPerChat) : [];
      return {
        chatId: String(session?.id || ''),
        type: normalizeChatType(session?.type),
        targetId: String(session?.targetId || ''),
        title: String(session?.title || ''),
        unread: Number(session?.unread || 0),
        preview: String(session?.preview || ''),
        lastTs: Number(session?.lastTs || 0),
        messageCount: Array.isArray(session?.messages) ? session.messages.length : 0,
        messages: messages.map((message) => ({
          id: String(message?.id || ''),
          rawMessageId: String(message?.rawMessageId || ''),
          direction: String(message?.direction || ''),
          senderId: String(message?.senderId || ''),
          senderName: String(message?.senderName || ''),
          timestamp: Number(message?.timestamp || 0),
          text: extractPlainText(message?.segments),
          segments: Array.isArray(message?.segments) ? message.segments : [],
        })),
      };
    }),
  };
}

function resolveTargetId(input, expectedChatType) {
  const targetId = String(input?.targetId || '').trim();
  if (targetId) {
    return targetId;
  }
  const primaryChat = getPrimaryChatConfig();
  if (!primaryChat.primaryChatId) {
    throw new Error('targetId is required, and no primary conversation is configured');
  }
  if (primaryChat.primaryChatType && primaryChat.primaryChatType !== expectedChatType) {
    throw new Error(`primary conversation is configured as ${primaryChat.primaryChatType}, not ${expectedChatType}`);
  }
  return primaryChat.primaryChatId;
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${String(message || '')}`;
  try {
    fs.appendFileSync(getLogFilePath(), `${line}\n`, 'utf8');
  } catch {
  }
  try {
    process.stderr.write(`${line}\n`);
  } catch {
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Failed to parse response: ${clipText(raw || '(empty)')}`);
  }
  if (!response.ok) {
    throw new Error(data?.message || `HTTP ${response.status}`);
  }
  return data;
}

async function getAccessToken() {
  const appId = envText('QQBOT_MCP_APP_ID');
  const clientSecret = envText('QQBOT_MCP_CLIENT_SECRET');
  if (!appId || !clientSecret) {
    throw new Error('QQBot MCP is not configured: missing AppID or ClientSecret');
  }
  if (tokenCache && Date.now() < tokenCache.expiresAt - 5 * 60 * 1000) {
    return tokenCache.token;
  }
  const data = await fetchJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret }),
  });
  const token = String(data.access_token || '').trim();
  if (!token) {
    throw new Error('QQBot access token response did not contain access_token');
  }
  tokenCache = {
    token,
    expiresAt: Date.now() + Number(data.expires_in || 7200) * 1000,
  };
  return token;
}

async function apiRequest(method, pathName, body) {
  const token = await getAccessToken();
  return fetchJson(`${API_BASE}${pathName}`, {
    method,
    headers: {
      Authorization: `QQBot ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function buildTextMessageBody(text, replyToMessageId = '') {
  const markdownSupport = boolEnv('QQBOT_MCP_MARKDOWN_SUPPORT', false);
  const body = markdownSupport
    ? { markdown: { content: text }, msg_type: 2, msg_seq: 1 }
    : { content: text, msg_type: 0, msg_seq: 1 };
  if (replyToMessageId) {
    body.msg_id = replyToMessageId;
  }
  return body;
}

async function sendPrivateMessage(input) {
  const targetId = resolveTargetId(input, 'private');
  const text = String(input?.text || '').trim();
  const replyToMessageId = String(input?.replyToMessageId || '').trim();
  if (!text) {
    throw new Error('text is required');
  }
  log(`tool send_private_message: target=${targetId}, text=${clipText(text, 200)}`);
  return apiRequest('POST', `/v2/users/${targetId}/messages`, buildTextMessageBody(text, replyToMessageId));
}

async function sendGroupMessage(input) {
  const targetId = resolveTargetId(input, 'group');
  const text = String(input?.text || '').trim();
  const replyToMessageId = String(input?.replyToMessageId || '').trim();
  if (!text) {
    throw new Error('text is required');
  }
  log(`tool send_group_message: target=${targetId}, text=${clipText(text, 200)}`);
  return apiRequest('POST', `/v2/groups/${targetId}/messages`, buildTextMessageBody(text, replyToMessageId));
}

function getStatus() {
  const appId = envText('QQBOT_MCP_APP_ID');
  const botName = envText('QQBOT_MCP_BOT_NAME', 'QQBot');
  const primaryChat = getPrimaryChatConfig();
  const snapshot = getMessageSnapshot();
  return {
    configured: Boolean(appId && envText('QQBOT_MCP_CLIENT_SECRET')),
    appId,
    botName,
    markdownSupport: boolEnv('QQBOT_MCP_MARKDOWN_SUPPORT', false),
    logFile: getLogFilePath(),
    stateFile: getStateFilePath(),
    cacheFile: getCacheFilePath(),
    primaryChatType: primaryChat.primaryChatType,
    primaryChatId: primaryChat.primaryChatId,
    cachedChats: Array.isArray(snapshot.sessions) ? snapshot.sessions.length : 0,
    snapshotSavedAt: Number(snapshot.savedAt || 0),
    tokenCached: Boolean(tokenCache && Date.now() < tokenCache.expiresAt),
  };
}

const tools = [
  {
    name: 'qqbot_send_private_message',
    description: 'Send a text message to a QQBot private chat target using a user openid.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'QQBot private target user_openid. Optional when a private primary conversation is configured.' },
        text: { type: 'string', description: 'The message text to send' },
        replyToMessageId: { type: 'string', description: 'Optional QQBot msg_id to reply to' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'qqbot_send_group_message',
    description: 'Send a text message to a QQBot group chat target using group_openid.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'QQBot group_openid. Optional when a group primary conversation is configured.' },
        text: { type: 'string', description: 'The message text to send' },
        replyToMessageId: { type: 'string', description: 'Optional QQBot msg_id to reply to' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'qqbot_configure_primary_conversation',
    description: 'Configure the primary QQBot conversation. When set, send tools can omit targetId and will send to this default target.',
    inputSchema: {
      type: 'object',
      properties: {
        chatType: { type: 'string', enum: ['private', 'group'], description: 'Primary conversation type' },
        targetId: { type: 'string', description: 'Primary conversation targetId' },
      },
      required: ['chatType', 'targetId'],
      additionalProperties: false,
    },
  },
  {
    name: 'qqbot_list_messages',
    description: 'List cached QQBot messages from current chats. Use this when you already know the chatId, targetId, or want message history after selecting a person.',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: 'Optional exact chatId, for example private:user_openid or group:group_openid' },
        chatType: { type: 'string', enum: ['private', 'group'], description: 'Optional chat type filter' },
        targetId: { type: 'string', description: 'Optional targetId filter' },
        limitChats: { type: 'number', description: 'Maximum chats to return, default 100' },
        limitPerChat: { type: 'number', description: 'Maximum messages to return per chat, default 50' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'qqbot_list_contacts',
    description: 'List cached QQBot contacts/chats from the local snapshot. This is the current cached friend/session list used by the extension UI.',
    inputSchema: {
      type: 'object',
      properties: {
        chatType: { type: 'string', enum: ['private', 'group'], description: 'Optional chat type filter' },
        targetId: { type: 'string', description: 'Optional targetId filter' },
        limit: { type: 'number', description: 'Maximum contacts to return, default 100' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'qqbot_list_people',
    description: 'Get the current cached QQ friends/people/contact list that can be chatted with. Prefer this tool when you need to find a user before sending a message.',
    inputSchema: {
      type: 'object',
      properties: {
        chatType: { type: 'string', enum: ['private', 'group'], description: 'Optional chat type filter' },
        targetId: { type: 'string', description: 'Optional targetId filter' },
        limit: { type: 'number', description: 'Maximum people to return, default 100' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'qqbot_get_status',
    description: 'Get the current QQBot MCP configuration and runtime status.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

const server = new Server(
  { name: 'qqbot-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = String(request?.params?.name || '').trim();
  const input = request?.params?.arguments || {};
  try {
    if (name === 'qqbot_send_private_message') {
      const result = await sendPrivateMessage(input);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: name, messageId: result?.id || '', timestamp: result?.timestamp || '' }) }],
      };
    }
    if (name === 'qqbot_send_group_message') {
      const result = await sendGroupMessage(input);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: name, messageId: result?.id || '', timestamp: result?.timestamp || '' }) }],
      };
    }
    if (name === 'qqbot_configure_primary_conversation') {
      const result = savePrimaryChatConfig(input);
      log(`tool configure_primary_conversation: type=${result.primaryChatType}, target=${result.primaryChatId}`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: name, ...result }) }],
      };
    }
    if (name === 'qqbot_list_messages') {
      const result = listMessages(input);
      log(`tool list_messages: chats=${result.chatCount}, savedAt=${result.savedAt || 0}`);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }
    if (name === 'qqbot_list_contacts') {
      const result = listContacts(input);
      log(`tool list_contacts: total=${result.total}, savedAt=${result.savedAt || 0}`);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }
    if (name === 'qqbot_list_people') {
      const result = listContacts(input);
      log(`tool list_people: total=${result.total}, savedAt=${result.savedAt || 0}`);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }
    if (name === 'qqbot_get_status') {
      return {
        content: [{ type: 'text', text: JSON.stringify(getStatus()) }],
      };
    }
    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    log(`tool error: name=${name}, reason=${error?.message || String(error)}`);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, tool: name, error: error?.message || String(error) }) }],
      isError: true,
    };
  }
});

async function main() {
  log('QQBot MCP server starting');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('QQBot MCP server connected');
}

main().catch((error) => {
  log(`QQBot MCP server fatal error: ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});