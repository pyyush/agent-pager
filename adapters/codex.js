'use strict';

module.exports = {
  name: 'codex',
  displayName: 'Codex CLI',
  binary: 'codex',
  launchArgs: ['--full-auto'],  // run autonomously so notifications fire without manual approval
  sessionPrefix: 'cx',
  mapPayload(raw) {
    return {
      sessionId: raw['thread-id'],
      cwd: raw.cwd || '',
      notificationType: raw.type || 'agent-turn-complete',
      lastMessage: raw['last-assistant-message'] || '',
    };
  },
};
