'use strict';

module.exports = {
  name: 'codex',
  displayName: 'Codex CLI',
  binary: 'codex',
  sessionPrefix: 'cx',
  mapPayload(raw) {
    return {
      sessionId: raw['thread-id'],
      cwd: raw.cwd || '',
      notificationType: raw.type || 'agent-turn-complete',
    };
  },
};
