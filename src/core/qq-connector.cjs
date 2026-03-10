const CONFIG_NAMESPACE = 'qqConnector';
const COMMAND_NAMESPACE = 'qqConnector';
const VIEW_CONTAINER_ID = 'qqConnector';
const SIDEBAR_VIEW_ID = 'qqConnector.sidebarView';
const SETTINGS_SEARCH_QUERY = 'qqConnector';
const LOG_DIR_NAME = '.qq-connector-logs';
const WORKSPACE_STICKER_DIR_NAME = '.qq-connector-sticker-pack';
const HOME_STICKER_DIR_SEGMENTS = ['QQConnector', 'sticker-pack'];
const CHAT_CACHE_STORE_KEY = `${CONFIG_NAMESPACE}.chatCache.v1`;
const HIDDEN_TARGETS_STORE_KEY = `${CONFIG_NAMESPACE}.hiddenTargets.v1`;

function configKey(suffix) {
  return `${CONFIG_NAMESPACE}.${suffix}`;
}

function commandId(name) {
  return `${COMMAND_NAMESPACE}.${name}`;
}

function getConfigValue(config, suffix, defaultValue) {
  return config.get(configKey(suffix), defaultValue);
}

async function updateConfigValue(config, suffix, value, target) {
  return config.update(configKey(suffix), value, target);
}

function affectsConfiguration(event, suffixes) {
  const list = Array.isArray(suffixes) ? suffixes : [suffixes];
  return list.some((suffix) => event.affectsConfiguration(configKey(suffix)));
}

module.exports = {
  CHAT_CACHE_STORE_KEY,
  COMMAND_NAMESPACE,
  CONFIG_NAMESPACE,
  HIDDEN_TARGETS_STORE_KEY,
  HOME_STICKER_DIR_SEGMENTS,
  LOG_DIR_NAME,
  SETTINGS_SEARCH_QUERY,
  SIDEBAR_VIEW_ID,
  VIEW_CONTAINER_ID,
  WORKSPACE_STICKER_DIR_NAME,
  affectsConfiguration,
  commandId,
  configKey,
  getConfigValue,
  updateConfigValue,
};