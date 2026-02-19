'use strict';

const fs = require('fs');
const path = require('path');

const adapters = new Map();

// Auto-load all .js files in this directory (except index.js)
const dir = __dirname;
for (const file of fs.readdirSync(dir)) {
  if (file === 'index.js' || !file.endsWith('.js')) continue;
  const adapter = require(path.join(dir, file));
  adapters.set(adapter.name, adapter);
}

/**
 * Check if a tmux session name matches any adapter's prefix.
 */
function matchesAnyPrefix(tmuxName) {
  for (const adapter of adapters.values()) {
    if (tmuxName.startsWith(adapter.sessionPrefix + '-')) return true;
  }
  return false;
}

/**
 * Get the adapter whose prefix matches a tmux session name.
 */
function getAdapterByPrefix(tmuxName) {
  for (const adapter of adapters.values()) {
    if (tmuxName.startsWith(adapter.sessionPrefix + '-')) return adapter;
  }
  return null;
}

module.exports = { adapters, matchesAnyPrefix, getAdapterByPrefix };
