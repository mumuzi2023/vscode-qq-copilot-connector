const vscode = require('vscode');

const CHAT_PARTICIPANT_ID = 'mumuzi2023.vscode-qq-copilot-connector.qq';

function registerChatParticipant(context, orchestrator) {
  if (!vscode.chat || typeof vscode.chat.createChatParticipant !== 'function') {
    return undefined;
  }

  const participant = vscode.chat.createChatParticipant(CHAT_PARTICIPANT_ID, async (request, chatContext, stream, token) => {
    return orchestrator.handleParticipantRequest(request, chatContext, stream, token);
  });

  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'images', 'icon.png');

  participant.followupProvider = {
    provideFollowups(result) {
      const modelName = String(result?.metadata?.modelName || '').trim();
      return [
        {
          prompt: '继续这个问题，并在需要时调用工具。',
          label: modelName ? `继续，沿用 ${modelName}` : '继续对话',
          command: undefined,
        },
        {
          prompt: '把刚才的回答整理成可执行的步骤。',
          label: '整理为步骤',
          command: undefined,
        },
      ];
    },
  };

  return participant;
}

module.exports = {
  CHAT_PARTICIPANT_ID,
  registerChatParticipant,
};