const vscode = require('vscode');

async function ensureConnectedWithPrompt(runtimeInstance) {
  if (runtimeInstance.isConnected()) {
    return true;
  }

  const answer = await vscode.window.showWarningMessage('QQ Connector is offline. Connect now?', 'Connect');
  if (answer !== 'Connect') {
    return false;
  }

  const connected = await runtimeInstance.ensureConnected();
  if (!connected) {
    runtimeInstance.log('send command aborted: ensureConnected failed.');
    vscode.window.showErrorMessage('QQ Connector connection did not become ready.');
    return false;
  }

  return true;
}

async function askForDigits(prompt, placeHolder) {
  return vscode.window.showInputBox({
    prompt,
    placeHolder,
    ignoreFocusOut: true,
    validateInput: (value) => (/^\d+$/.test(value) ? null : 'Value must be digits only.'),
  });
}

async function askForTarget(prompt, placeHolder, options = {}) {
  const digitsOnly = options?.digitsOnly === true;
  return vscode.window.showInputBox({
    prompt,
    placeHolder,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const text = String(value || '').trim();
      if (!text) {
        return 'Value cannot be empty.';
      }
      if (digitsOnly && !/^\d+$/.test(text)) {
        return 'Value must be digits only.';
      }
      return null;
    },
  });
}

async function askForMessage() {
  return vscode.window.showInputBox({
    prompt: 'Message to send',
    placeHolder: 'Type your message',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? null : 'Message cannot be empty.'),
  });
}

module.exports = {
  askForDigits,
  askForTarget,
  askForMessage,
  ensureConnectedWithPrompt,
};
