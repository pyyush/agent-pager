'use strict';

module.exports = {
  name: 'claude',
  displayName: 'Claude Code',
  binary: 'claude',
  sessionPrefix: 'cc',
  mapPayload(raw) {
    return {
      sessionId: raw.session_id,
      cwd: raw.cwd || '',
      notificationType: raw.notification_type || 'unknown',
    };
  },
};
