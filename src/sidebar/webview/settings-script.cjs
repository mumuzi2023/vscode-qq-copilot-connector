function renderSettingsScript() {
  return String.raw`
    function collectBackendSettingsFromInputs() {
      return {
        backendMode: String(document.getElementById('settingBackendMode')?.value || 'ncat').trim() || 'ncat',
        rootDir: String(document.getElementById('settingRootDir')?.value || '').trim(),
        tokenFile: String(document.getElementById('settingTokenFile')?.value || '').trim(),
        quickLoginUin: String(document.getElementById('settingQuickLoginUin')?.value || '').trim(),
        qqbotAppId: String(document.getElementById('settingQqbotAppId')?.value || '').trim(),
        qqbotClientSecret: String(document.getElementById('settingQqbotClientSecret')?.value || '').trim(),
        qqbotBotName: String(document.getElementById('settingQqbotBotName')?.value || '').trim(),
        qqbotMarkdownSupport: !!document.getElementById('settingQqbotMarkdownSupport')?.checked,
      };
    }

    function collectHiddenSettingsFromInputs() {
      return {
        privateIds: String(document.getElementById('settingHiddenPrivateIds')?.value || '').trim(),
        groupIds: String(document.getElementById('settingHiddenGroupIds')?.value || '').trim(),
      };
    }

    function scheduleBackendSettingsSave(immediate = false) {
      if (backendSaveTimer) {
        clearTimeout(backendSaveTimer);
        backendSaveTimer = null;
      }
      const run = () => {
        const payload = collectBackendSettingsFromInputs();
        vscode.postMessage({
          type: 'saveBackendSettings',
          ...payload,
        });
      };
      if (immediate) {
        run();
        return;
      }
      backendSaveTimer = setTimeout(() => {
        backendSaveTimer = null;
        run();
      }, 320);
    }

    function scheduleHiddenSettingsSave(immediate = false) {
      if (hiddenSaveTimer) {
        clearTimeout(hiddenSaveTimer);
        hiddenSaveTimer = null;
      }
      const run = () => {
        const payload = collectHiddenSettingsFromInputs();
        vscode.postMessage({
          type: 'saveHiddenSettings',
          ...payload,
        });
      };
      if (immediate) {
        run();
        return;
      }
      hiddenSaveTimer = setTimeout(() => {
        hiddenSaveTimer = null;
        run();
      }, 320);
    }

    function renderSettingsPanel() {
      const overlay = document.getElementById('settingsOverlay');
      const imageToggle = document.getElementById('settingPreviewImages');
      const videoToggle = document.getElementById('settingPreviewVideos');
      const enterToggle = document.getElementById('settingEnterToSend');
      const rootDirInput = document.getElementById('settingRootDir');
      const tokenFileInput = document.getElementById('settingTokenFile');
      const quickLoginUinInput = document.getElementById('settingQuickLoginUin');
      const backendModeInput = document.getElementById('settingBackendMode');
      const qqbotAppIdInput = document.getElementById('settingQqbotAppId');
      const qqbotClientSecretInput = document.getElementById('settingQqbotClientSecret');
      const qqbotBotNameInput = document.getElementById('settingQqbotBotName');
      const qqbotMarkdownToggle = document.getElementById('settingQqbotMarkdownSupport');
      const ncatSection = document.getElementById('settingsNcatSection');
      const qqbotSection = document.getElementById('settingsQqbotSection');
      const napcatReleaseBtn = document.getElementById('settingOpenNapcatReleases');
      const backendWebBtn = document.getElementById('settingOpenBackendWeb');
      const hiddenPrivateInput = document.getElementById('settingHiddenPrivateIds');
      const hiddenGroupInput = document.getElementById('settingHiddenGroupIds');
      const backendHint = document.getElementById('settingBackendHint');
      const backendToggleBtn = document.getElementById('settingBackendToggle');
      const backendMode = String(state?.backend?.mode || 'ncat');
      const usingQqbot = backendMode === 'qqbot';
      if (overlay) {
        overlay.classList.toggle('open', !!settingsOpen);
        overlay.setAttribute('aria-hidden', settingsOpen ? 'false' : 'true');
      }
      if (imageToggle) {
        imageToggle.checked = !!uiPrefs.previewImages;
      }
      if (videoToggle) {
        videoToggle.checked = !!uiPrefs.previewVideos;
      }
      if (enterToggle) {
        enterToggle.checked = !!uiPrefs.enterToSend;
      }
      if (backendModeInput && document.activeElement !== backendModeInput) {
        backendModeInput.value = backendMode;
      }
      if (rootDirInput && document.activeElement !== rootDirInput) {
        rootDirInput.value = String(state?.backend?.rootDir || '');
      }
      if (tokenFileInput && document.activeElement !== tokenFileInput) {
        tokenFileInput.value = String(state?.backend?.tokenFile || '');
      }
      if (quickLoginUinInput && document.activeElement !== quickLoginUinInput) {
        quickLoginUinInput.value = String(state?.backend?.quickLoginUin || '');
      }
      if (qqbotAppIdInput && document.activeElement !== qqbotAppIdInput) {
        qqbotAppIdInput.value = String(state?.backend?.qqbotAppId || '');
      }
      if (qqbotClientSecretInput && document.activeElement !== qqbotClientSecretInput) {
        qqbotClientSecretInput.value = String(state?.backend?.qqbotClientSecret || '');
      }
      if (qqbotBotNameInput && document.activeElement !== qqbotBotNameInput) {
        qqbotBotNameInput.value = String(state?.backend?.qqbotBotName || '');
      }
      if (qqbotMarkdownToggle) {
        qqbotMarkdownToggle.checked = !!state?.backend?.qqbotMarkdownSupport;
      }
      if (ncatSection) {
        ncatSection.hidden = usingQqbot;
      }
      if (qqbotSection) {
        qqbotSection.hidden = !usingQqbot;
      }
      if (napcatReleaseBtn) {
        napcatReleaseBtn.hidden = usingQqbot;
      }
      if (backendWebBtn) {
        backendWebBtn.hidden = usingQqbot;
      }
      if (hiddenPrivateInput && document.activeElement !== hiddenPrivateInput) {
        hiddenPrivateInput.value = String(state?.hidden?.privateText || '');
      }
      if (hiddenGroupInput && document.activeElement !== hiddenGroupInput) {
        hiddenGroupInput.value = String(state?.hidden?.groupText || '');
      }
      if (backendHint) {
        const runtimeLabel = state?.runtimeActive ? '运行中' : '未运行';
        const blockedByOther = !!state?.runtimeBlockedByOther;
        const blockedOwnerPid = Number(state?.runtimeBlockedOwnerPid || 0);
        const runningLabel = usingQqbot
          ? (state?.connectionState === 'online' ? '已连接官方网关' : (state?.connectionState === 'connecting' ? '连接中' : '未连接'))
          : (state?.backend?.backendManagedActive ? '已启动' : (state?.backend?.backendProcessRunning ? '运行中' : '未启动'));
        const modeLabel = usingQqbot
          ? 'QQBot 官方 API'
          : (state?.backend?.backendManualMode ? '手动模式（已停止自动重连）' : '自动托管模式');
        const launchScript = String(state?.backend?.backendLastLaunchFile || '').trim();
        const quickLoginUin = String(state?.backend?.quickLoginUin || '').trim();
        const quickLoginNote = usingQqbot
          ? ('AppID: ' + (String(state?.backend?.qqbotAppId || '').trim() || '未配置'))
          : (quickLoginUin ? ('快速登录: 已配置 QQ ' + quickLoginUin) : '快速登录: 未配置（将走二维码登录）');
        const base = usingQqbot
          ? ('后端状态: ' + runningLabel + '，模式: ' + modeLabel)
          : (launchScript ? ('后端状态: ' + runningLabel + '，模式: ' + modeLabel + '，最近启动脚本: ' + launchScript) : ('后端状态: ' + runningLabel + '，模式: ' + modeLabel));
        const runtimeNote = blockedByOther
          ? (blockedOwnerPid > 0
              ? ('插件状态: 未运行（另一个窗口占用，PID ' + blockedOwnerPid + '）')
              : '插件状态: 未运行（另一个窗口占用）')
          : ('插件状态: ' + runtimeLabel);
        backendHint.textContent = runtimeNote + '，' + base + '，' + quickLoginNote;
      }
      if (backendToggleBtn) {
        const backendRunning = usingQqbot
          ? state?.connectionState === 'online' || state?.connectionState === 'connecting'
          : (!!state?.backend?.backendManagedActive || !!state?.backend?.backendProcessRunning);
        backendToggleBtn.textContent = usingQqbot
          ? (backendRunning ? '断开 QQBot' : '连接 QQBot')
          : (backendRunning ? '停止后端' : '启动后端');
      }
    }

    function openSettingsPanel() {
      settingsOpen = true;
      closeAvatarMenu();
      if (typeof closeChatTitleMenu === 'function') {
        closeChatTitleMenu();
      }
      closeBubbleMenu();
      closeMentionMenu();
      renderSettingsPanel();
    }

    function closeSettingsPanel() {
      settingsOpen = false;
      renderSettingsPanel();
    }

    function applyUiPref(key, value) {
      if (!(key in uiPrefs)) {
        return;
      }
      uiPrefs[key] = !!value;
      if (key === 'previewImages' || key === 'previewVideos') {
        renderMessages();
      }
      renderSettingsPanel();
    }

    function setupSettingsUi() {
      document.getElementById('btnSettings').addEventListener('click', () => {
        openSettingsPanel();
      });

      document.getElementById('btnSettings2').addEventListener('click', () => {
        openSettingsPanel();
      });

      document.getElementById('btnCloseSettings').addEventListener('click', () => {
        closeSettingsPanel();
      });

      document.getElementById('settingsOverlay').addEventListener('click', (event) => {
        if (event.target === event.currentTarget) {
          closeSettingsPanel();
        }
      });

      document.getElementById('settingOpenLogs').addEventListener('click', () => {
        vscode.postMessage({
          type: 'settingsAction',
          action: 'openLogs',
        });
      });

      document.getElementById('settingOpenExt').addEventListener('click', () => {
        vscode.postMessage({
          type: 'settingsAction',
          action: 'openExtensionSettings',
        });
      });

      document.getElementById('settingOpenNapcatReleases').addEventListener('click', () => {
        vscode.postMessage({
          type: 'settingsAction',
          action: 'openNapcatReleases',
        });
      });

      document.getElementById('settingBackendToggle').addEventListener('click', () => {
        const usingQqbot = String(state?.backend?.mode || 'ncat') === 'qqbot';
        const backendRunning = usingQqbot
          ? (state?.connectionState === 'online' || state?.connectionState === 'connecting')
          : (!!state?.backend?.backendManagedActive || !!state?.backend?.backendProcessRunning);
        if (backendRunning) {
          vscode.postMessage({
            type: 'settingsAction',
            action: usingQqbot ? 'disconnect' : 'stopBackend',
          });
          return;
        }
        vscode.postMessage({
          type: 'settingsAction',
          action: usingQqbot ? 'connect' : 'startBackend',
        });
      });

      document.getElementById('settingOpenBackendWeb').addEventListener('click', () => {
        scheduleBackendSettingsSave(true);
        vscode.postMessage({
          type: 'settingsAction',
          action: 'openBackendWeb',
        });
      });

      document.getElementById('settingBackendMode').addEventListener('change', () => {
        scheduleBackendSettingsSave(true);
      });
      document.getElementById('settingRootDir').addEventListener('input', () => {
        scheduleBackendSettingsSave(false);
      });
      document.getElementById('settingTokenFile').addEventListener('input', () => {
        scheduleBackendSettingsSave(false);
      });
      document.getElementById('settingQuickLoginUin').addEventListener('input', () => {
        scheduleBackendSettingsSave(false);
      });
      document.getElementById('settingQqbotAppId').addEventListener('input', () => {
        scheduleBackendSettingsSave(false);
      });
      document.getElementById('settingQqbotClientSecret').addEventListener('input', () => {
        scheduleBackendSettingsSave(false);
      });
      document.getElementById('settingQqbotBotName').addEventListener('input', () => {
        scheduleBackendSettingsSave(false);
      });
      document.getElementById('settingQqbotMarkdownSupport').addEventListener('change', () => {
        scheduleBackendSettingsSave(false);
      });
      document.getElementById('settingHiddenPrivateIds').addEventListener('input', () => {
        scheduleHiddenSettingsSave(false);
      });
      document.getElementById('settingHiddenGroupIds').addEventListener('input', () => {
        scheduleHiddenSettingsSave(false);
      });

      document.getElementById('settingPreviewImages').addEventListener('change', (event) => {
        applyUiPref('previewImages', !!event.target.checked);
      });

      document.getElementById('settingPreviewVideos').addEventListener('change', (event) => {
        applyUiPref('previewVideos', !!event.target.checked);
      });

      document.getElementById('settingEnterToSend').addEventListener('change', (event) => {
        applyUiPref('enterToSend', !!event.target.checked);
      });

      document.getElementById('settingClearCache').addEventListener('click', () => {
        logWeb('info', 'clear cache clicked');
        vscode.postMessage({
          type: 'settingsAction',
          action: 'clearCache',
        });
      });
    }
  `;
}

module.exports = {
  renderSettingsScript,
};
