'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { App } = require('@slack/bolt');
const http = require('http');
const { execFileSync, execFile, spawn } = require('child_process');
const util = require('util');
const fs = require('fs');
const os = require('os');
const { adapters, matchesAnyPrefix, getAdapterByPrefix } = require('./adapters');

const execFileAsync = util.promisify(execFile);

// ─── Config ─────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.BRIDGE_PORT || '7890', 10);
const CHANNEL = process.env.SLACK_CHANNEL_ID;
const STATE_FILE = path.join(__dirname, 'state.json');
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_FILE = path.join(os.homedir(), '.agent-pager', 'pager.log');
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || '';
const ALLOWED_USERS = (process.env.ALLOWED_SLACK_USERS || '').split(',').filter(Boolean);
const DEBOUNCE_MS = 30_000;
const DEFAULT_AGENT = process.env.PAGER_DEFAULT_AGENT || 'claude';

for (const key of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

// At least one of SLACK_CHANNEL_ID or SLACK_USER_ID required
if (!process.env.SLACK_CHANNEL_ID && !process.env.SLACK_USER_ID) {
  console.error('Missing required env var: SLACK_CHANNEL_ID or SLACK_USER_ID');
  process.exit(1);
}

// ─── Logging ────────────────────────────────────────────────────────────────────

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

function rotateLog() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stat = fs.statSync(LOG_FILE);
    if (stat.size < MAX_LOG_SIZE) return;

    const log2 = LOG_FILE + '.2';
    const log1 = LOG_FILE + '.1';
    try { fs.unlinkSync(log2); } catch {}
    try { fs.renameSync(log1, log2); } catch {}
    fs.renameSync(LOG_FILE, log1);
  } catch {}
}

function log(level, ...args) {
  if ((LEVELS[level] ?? 1) >= (LEVELS[LOG_LEVEL] ?? 1)) {
    const ts = new Date().toISOString().slice(11, 19);
    const line = `[${ts}] ${level.toUpperCase().padEnd(5)} ${args.join(' ')}\n`;
    process.stdout.write(line);
    try {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fs.appendFileSync(LOG_FILE, line);
    } catch {}
  }
}

// ─── Prevent Sleep ──────────────────────────────────────────────────────────────
// caffeinate -s keeps Mac awake even with lid closed (on AC power)
// caffeinate -i prevents idle sleep (on battery too)

let caffeinateProc = null;

function preventSleep() {
  if (process.platform !== 'darwin') {
    log('debug', 'Sleep prevention skipped (not macOS)');
    return;
  }
  try {
    caffeinateProc = spawn('caffeinate', ['-s', '-i'], {
      stdio: 'ignore',
    });
    caffeinateProc.on('error', () => {});
    log('info', 'Sleep prevention active (caffeinate -s -i)');
  } catch {
    log('warn', 'Could not start caffeinate — Mac may sleep when lid is closed');
  }
}

// ─── State ──────────────────────────────────────────────────────────────────────
// Maps session_id → { thread_ts, tmux_session, cwd, agent }

let state = { sessions: {} };

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

      // Migrate: existing sessions without agent field get 'claude'
      let migrated = 0;
      for (const s of Object.values(state.sessions)) {
        if (!s.agent) { s.agent = 'claude'; migrated++; }
      }
      if (migrated > 0) {
        log('info', `Migrated ${migrated} sessions (added agent field)`);
        saveState();
      }

      log('info', `Loaded state: ${Object.keys(state.sessions).length} sessions`);
    }
  } catch (e) {
    log('warn', 'Could not load state:', e.message);
  }
}

function saveState() {
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    log('error', 'Could not save state:', e.message);
  }
}

function cleanState() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
  let cleaned = 0;
  for (const [sid, s] of Object.entries(state.sessions)) {
    if (new Date(s.last_activity).getTime() < cutoff) {
      delete state.sessions[sid];
      cleaned++;
    }
  }
  if (cleaned > 0) {
    log('info', `Cleaned ${cleaned} stale sessions (>7 days)`);
    saveState();
  }
}

// ─── Slack ──────────────────────────────────────────────────────────────────────

let slack = null;
let slackHealthy = false;

async function initSlack() {
  slack = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LOG_LEVEL === 'debug' ? 'DEBUG' : 'ERROR',
  });

  registerSlackHandlers();
  await slack.start();
  slackHealthy = true;
  log('info', 'Slack connected via Socket Mode');
}

// ─── Slack Health Monitoring ────────────────────────────────────────────────────

function startSlackHealthCheck() {
  setInterval(async () => {
    try {
      await slack.client.auth.test();
      if (!slackHealthy) log('info', 'Slack reconnected');
      slackHealthy = true;
    } catch (e) {
      if (slackHealthy) log('error', 'Slack connection lost:', e.message);
      slackHealthy = false;
    }
  }, 60_000);
}

// ─── DM Channel ─────────────────────────────────────────────────────────────────

let dmChannelId = null;

async function getTargetChannel() {
  if (!process.env.SLACK_USER_ID) return CHANNEL;
  if (dmChannelId) return dmChannelId;

  try {
    const result = await slack.client.conversations.open({
      users: process.env.SLACK_USER_ID,
    });
    dmChannelId = result.channel.id;
    log('info', `DM channel opened: ${dmChannelId}`);
    return dmChannelId;
  } catch (e) {
    log('warn', 'Could not open DM, falling back to channel:', e.message);
    return CHANNEL;
  }
}

// ─── Auth ───────────────────────────────────────────────────────────────────────

function isAllowedUser(userId) {
  return ALLOWED_USERS.length === 0 || ALLOWED_USERS.includes(userId);
}

function validateToken(req) {
  if (!BRIDGE_SECRET) return true; // not configured = open (backward compat)
  return req.headers['x-bridge-token'] === BRIDGE_SECRET;
}

// ─── Adapter Helpers ────────────────────────────────────────────────────────────

function resolveAdapter(name) {
  return adapters.get(name) || adapters.get(DEFAULT_AGENT);
}

function getAdapterForSession(sessionId) {
  const agentName = state.sessions[sessionId]?.agent;
  return agentName ? adapters.get(agentName) : null;
}

function detectAgentFromPayload(data) {
  // If _agent was injected by hook, use that
  if (data._agent && adapters.has(data._agent)) return data._agent;
  // Heuristic: Claude uses session_id, Codex uses thread-id
  if (data['thread-id']) return 'codex';
  return DEFAULT_AGENT;
}

// ─── Session Threads ────────────────────────────────────────────────────────────

async function ensureThread(sessionId, data = {}) {
  if (state.sessions[sessionId]?.thread_ts) {
    const s = state.sessions[sessionId];
    if (data.tmux_session && !s.tmux_session) s.tmux_session = data.tmux_session;
    s.last_activity = new Date().toISOString();
    saveState();
    return s.thread_ts;
  }

  const channel = await getTargetChannel();
  const shortId = sessionId.slice(0, 8);
  const dirName = data.cwd ? path.basename(data.cwd) : 'unknown';
  const adapter = resolveAdapter(data.agent);
  const displayName = adapter ? adapter.displayName : 'Agent';

  const result = await slack.client.chat.postMessage({
    channel,
    text: `${displayName} — ${shortId} in ${dirName}/`,
  });

  state.sessions[sessionId] = {
    thread_ts: result.ts,
    channel: result.channel,
    tmux_session: data.tmux_session || null,
    cwd: data.cwd || '',
    agent: data.agent || DEFAULT_AGENT,
    created_at: new Date().toISOString(),
    last_activity: new Date().toISOString(),
  };
  saveState();
  return result.ts;
}

function findSessionByThread(threadTs) {
  for (const [sid, data] of Object.entries(state.sessions)) {
    if (data.thread_ts === threadTs) return sid;
  }
  return null;
}

function getSessionChannel(sessionId) {
  return state.sessions[sessionId]?.channel || CHANNEL;
}

// ─── tmux ───────────────────────────────────────────────────────────────────────

function getTmuxSessions() {
  try {
    const result = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8', timeout: 5000,
    });
    return result.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function getManagedTmuxSessions() {
  return getTmuxSessions().filter(s => matchesAnyPrefix(s));
}

function resolveTmux(sessionId) {
  const stored = state.sessions[sessionId]?.tmux_session;
  if (stored && getTmuxSessions().includes(stored)) return stored;
  return null;
}

function sendToTmux(sessionId, text) {
  const tmux = resolveTmux(sessionId);
  if (!tmux) {
    log('warn', `No tmux session for ${sessionId.slice(0, 8)}`);
    return false;
  }
  try {
    if (text) {
      execFileSync('tmux', ['send-keys', '-t', tmux, '-l', text], { timeout: 5000 });
    }
    execFileSync('tmux', ['send-keys', '-t', tmux, 'Enter'], { timeout: 5000 });
    log('info', `tmux → ${tmux}: "${text || '<Enter>'}"`);
    return true;
  } catch (e) {
    log('error', `tmux send failed:`, e.message);
    return false;
  }
}

// ─── Screenshots (async) ────────────────────────────────────────────────────────

async function captureScreenshot(tmuxSession) {
  try {
    const { stdout: widthStr } = await execFileAsync('tmux', [
      'display', '-t', tmuxSession, '-p', '#{pane_width}',
    ], { encoding: 'utf8', timeout: 5000 });

    const paneWidth = parseInt(widthStr.trim(), 10) || 120;

    const { stdout: ansi } = await execFileAsync('tmux', [
      'capture-pane', '-e', '-p', '-t', tmuxSession, '-S', '-',
    ], { encoding: 'utf8', timeout: 5000 });

    if (!ansi.trim()) return null;

    const tmpFile = path.join(os.tmpdir(), `agent-pager-${Date.now()}.png`);
    const pixelWidth = Math.max(800, paneWidth * 10);

    // freeze needs stdin input — use spawn + promise
    await new Promise((resolve, reject) => {
      const proc = spawn('freeze', [
        '--language', 'ansi',
        '--output', tmpFile,
        '--window',
        '--width', String(pixelWidth),
        '--padding', '20,40',
        '--font.size', '14',
      ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 });

      proc.stdin.write(ansi);
      proc.stdin.end();

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`freeze exited with code ${code}`));
      });
      proc.on('error', reject);
    });

    if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 0) return tmpFile;
    return null;
  } catch (e) {
    log('warn', `Screenshot failed: ${e.message}`);
    return null;
  }
}

async function captureRawText(tmuxSession) {
  try {
    const { stdout: text } = await execFileAsync('tmux', [
      'capture-pane', '-p', '-t', tmuxSession, '-S', '-',
    ], { encoding: 'utf8', timeout: 5000 });

    const trimmed = text.trim();
    if (!trimmed) return null;

    // Take last 80 lines to keep Slack message reasonable
    const lines = trimmed.split('\n');
    const last80 = lines.slice(-80).join('\n');
    return last80;
  } catch {
    return null;
  }
}

async function uploadScreenshot(filePath, channel, threadTs, title) {
  try {
    await slack.client.files.uploadV2({
      channel_id: channel,
      thread_ts: threadTs,
      file: fs.readFileSync(filePath),
      filename: 'terminal.png',
      title: title || 'Terminal',
    });
  } catch (e) {
    log('warn', `Upload failed: ${e.message}`);
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

// ─── Notification Handler ───────────────────────────────────────────────────────

const lastNotification = new Map(); // "sessionId:type" → timestamp

async function handleNotification(normalized) {
  const sessionId = normalized.sessionId || 'unknown';
  const shortId = sessionId.slice(0, 8);
  const notificationType = normalized.notificationType || 'unknown';
  const agentName = normalized.agent || DEFAULT_AGENT;
  const adapter = resolveAdapter(agentName);
  const displayName = adapter ? adapter.displayName : 'Agent';

  // Debounce: skip if same session+type within DEBOUNCE_MS
  const debounceKey = `${sessionId}:${notificationType}`;
  const lastTime = lastNotification.get(debounceKey);
  if (lastTime && Date.now() - lastTime < DEBOUNCE_MS) {
    log('debug', `Debounced ${debounceKey}`);
    return;
  }
  lastNotification.set(debounceKey, Date.now());

  const threadTs = await ensureThread(sessionId, {
    tmux_session: normalized.tmux_session,
    cwd: normalized.cwd,
    agent: agentName,
  });
  const channel = getSessionChannel(sessionId);
  const tmux = normalized.tmux_session || state.sessions[sessionId]?.tmux_session;

  if (!tmux) {
    const lastMsg = normalized.lastMessage;
    const body = lastMsg
      ? `${displayName} needs attention (${notificationType})\n\`\`\`\n${lastMsg.slice(0, 3000)}\n\`\`\``
      : `${displayName} needs attention (${notificationType})`;
    await slack.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: body,
    });
    log('info', `Plain text fallback for ${shortId} (no tmux)`);
    return;
  }

  // Fallback 1: screenshot via freeze
  const screenshot = await captureScreenshot(tmux);
  if (screenshot) {
    await uploadScreenshot(screenshot, channel, threadTs, `Terminal — ${shortId}`);
    log('info', `Screenshot for ${shortId} [${notificationType}]`);
    return;
  }

  // Fallback 2: raw tmux text as code block
  const rawText = await captureRawText(tmux);
  if (rawText) {
    await slack.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `Terminal — ${shortId} (${notificationType})\n\`\`\`\n${rawText}\n\`\`\``,
    });
    log('info', `Text capture fallback for ${shortId}`);
    return;
  }

  // Fallback 3: plain text
  await slack.client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `${displayName} needs attention (${notificationType})`,
  });
  log('info', `Text fallback for ${shortId}`);
}

// ─── Slack Handlers ─────────────────────────────────────────────────────────────

function registerSlackHandlers() {
  // Thread replies → tmux
  slack.event('message', async ({ event }) => {
    if (event.bot_id || event.subtype || !event.thread_ts) return;

    // User allowlist check
    if (!isAllowedUser(event.user)) {
      log('warn', `Unauthorized user ${event.user} tried to reply`);
      return;
    }

    const sessionId = findSessionByThread(event.thread_ts);
    if (!sessionId) return;

    const text = event.text || '';
    log('info', `Reply for ${sessionId.slice(0, 8)}: "${text}"`);

    const ok = sendToTmux(sessionId, text);
    if (ok) {
      // Clear debounce for this session — user responded, next notification is fresh
      for (const [key] of lastNotification) {
        if (key.startsWith(sessionId)) lastNotification.delete(key);
      }
    } else {
      const channel = getSessionChannel(sessionId);
      await slack.client.chat.postMessage({
        channel,
        thread_ts: event.thread_ts,
        text: 'Could not send — no active tmux session.',
      });
    }
  });

  // /pager — unified command
  slack.command('/pager', async ({ command, ack, respond }) => {
    await ack();

    if (!isAllowedUser(command.user_id)) {
      await respond('Unauthorized.');
      return;
    }

    const rawArgs = (command.text || '').trim();

    // /pager list
    if (rawArgs === 'list' || rawArgs === 'l') {
      const sessions = getManagedTmuxSessions();
      if (!sessions.length) {
        await respond('No active sessions. Use `/pager <task>` to start one.');
        return;
      }
      const lines = sessions.map(s => {
        const adapter = getAdapterByPrefix(s);
        const label = adapter ? adapter.displayName : 'unknown';
        return `• \`${s}\` (${label})`;
      });
      await respond(`*Active sessions:*\n${lines.join('\n')}\n\n\`/pager screen\` for screenshots • \`/pager health\` for diagnostics`);
      return;
    }

    // /pager health
    if (rawArgs === 'health' || rawArgs === 'h') {
      let freezeStatus;
      try { execFileSync('which', ['freeze'], { stdio: 'pipe' }); freezeStatus = 'installed'; } catch { freezeStatus = 'MISSING'; }

      const managed = getManagedTmuxSessions();
      const byAgent = {};
      for (const s of managed) {
        const adapter = getAdapterByPrefix(s);
        const name = adapter ? adapter.name : 'unknown';
        byAgent[name] = (byAgent[name] || 0) + 1;
      }
      const tmuxSummary = managed.length > 0
        ? `running (${managed.length} sessions: ${Object.entries(byAgent).map(([k, v]) => `${v} ${k}`).join(', ')})`
        : 'no sessions';

      const agentList = [...adapters.values()].map(a => a.displayName).join(', ');

      const checks = {
        slack: slackHealthy ? 'connected' : 'DISCONNECTED',
        agents: agentList,
        tmux: tmuxSummary,
        freeze: freezeStatus,
        mode: process.env.SLACK_USER_ID ? 'DM' : 'channel',
        sessions: Object.keys(state.sessions).length,
        uptime: Math.floor(process.uptime()) + 's',
      };
      const text = Object.entries(checks).map(([k, v]) => `• *${k}:* ${v}`).join('\n');
      await respond(`*Agent Pager Health*\n${text}`);
      return;
    }

    // /pager screen
    if (rawArgs === 'screen' || rawArgs === 's') {
      const sessions = getManagedTmuxSessions();
      if (!sessions.length) { await respond('No active sessions.'); return; }

      for (const name of sessions) {
        const screenshot = await captureScreenshot(name);
        const sid = Object.entries(state.sessions).find(([, s]) => s.tmux_session === name)?.[0];
        const channel = sid ? getSessionChannel(sid) : await getTargetChannel();
        const threadTs = sid ? state.sessions[sid].thread_ts : undefined;

        if (screenshot) {
          await uploadScreenshot(screenshot, channel, threadTs, `Screen — ${name}`);
          await respond(`\`${name}\` — screenshot uploaded`);
        } else {
          await respond(`\`${name}\` — could not capture`);
        }
      }
      return;
    }

    // /pager [agent] <task> — start new session
    let agentName = DEFAULT_AGENT;
    let task = rawArgs;

    // Check if first word is an agent name
    const firstWord = rawArgs.split(/\s+/)[0].toLowerCase();
    if (adapters.has(firstWord)) {
      agentName = firstWord;
      task = rawArgs.slice(firstWord.length).trim();
    }

    if (!task) {
      const agentNames = [...adapters.keys()].join('|');
      await respond(`Usage: \`/pager [${agentNames}] <task>\``);
      return;
    }

    const adapter = adapters.get(agentName);
    const sessionName = `${adapter.sessionPrefix}-${Date.now().toString(36)}`;
    try {
      const tmuxArgs = ['new-session', '-d', '-s', sessionName, '--', adapter.binary, ...(adapter.launchArgs || []), task];
      execFileSync('tmux', tmuxArgs, { timeout: 5000 });
      await respond(`Started \`${sessionName}\` (${adapter.displayName}): ${task}`);
      log('info', `New session: ${sessionName} [${agentName}]`);
    } catch (e) {
      await respond(`Failed: ${e.message}`);
    }
  });
}

// ─── HTTP Server ────────────────────────────────────────────────────────────────

function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    const remote = req.socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      res.writeHead(403); res.end(); return;
    }

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        slack: slackHealthy,
        mode: process.env.SLACK_USER_ID ? 'dm' : 'channel',
        agents: [...adapters.keys()],
        sessions: getManagedTmuxSessions(),
        uptime: Math.floor(process.uptime()),
      }));
      return;
    }

    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

    // Token validation
    if (!validateToken(req)) {
      log('warn', `Rejected unauthenticated request to ${req.url}`);
      res.writeHead(401); res.end('Unauthorized'); return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);

        if (req.url === '/notification') {
          // Normalize: detect agent, map payload through adapter
          const agentName = detectAgentFromPayload(data);
          const adapter = adapters.get(agentName);
          const normalized = adapter ? adapter.mapPayload(data) : {
            sessionId: data.session_id || 'unknown',
            cwd: data.cwd || '',
            notificationType: data.notification_type || 'unknown',
          };
          normalized.tmux_session = data.tmux_session;
          normalized.agent = agentName;
          await handleNotification(normalized);
        } else if (req.url === '/stop') {
          const agentName = detectAgentFromPayload(data);
          const adapter = adapters.get(agentName);
          const sid = adapter ? adapter.mapPayload(data).sessionId : data.session_id;
          if (state.sessions[sid]) {
            state.sessions[sid].status = 'stopped';
            saveState();
          }
          log('info', `Stop for ${sid?.slice(0, 8)} [${agentName}]`);
        } else {
          res.writeHead(404); res.end(); return;
        }

        res.writeHead(200); res.end('ok');
      } catch (e) {
        log('error', `Error: ${e.message}`);
        res.writeHead(500); res.end(e.message);
      }
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('error', `Port ${PORT} in use — kill it: lsof -ti:${PORT} | xargs kill`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(PORT, '127.0.0.1', () => log('info', `HTTP :${PORT} ready`));
}

// ─── Dependency Check ───────────────────────────────────────────────────────────

function checkDependencies() {
  const missing = [];
  try { execFileSync('which', ['tmux'], { stdio: 'pipe' }); } catch { missing.push('tmux'); }
  try { execFileSync('which', ['freeze'], { stdio: 'pipe' }); } catch { missing.push('freeze (brew install charmbracelet/tap/freeze)'); }
  if (missing.length) {
    log('warn', `Missing optional deps: ${missing.join(', ')}`);
  }

  // Log loaded adapters
  const loaded = [...adapters.values()].map(a => `${a.name} (${a.displayName})`).join(', ');
  log('info', `Loaded adapters: ${loaded}`);
}

// ─── Startup Self-Check ─────────────────────────────────────────────────────────

async function startupCheck() {
  checkDependencies();
  try {
    await slack.client.auth.test();
    log('info', 'Slack auth verified');
  } catch (e) {
    log('error', 'Slack auth FAILED:', e.message);
  }
}

// ─── Shutdown ───────────────────────────────────────────────────────────────────

function shutdown() {
  log('info', 'Shutting down...');
  if (caffeinateProc) caffeinateProc.kill();
  saveState();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  log('info', 'Agent Pager starting...');
  rotateLog();
  loadState();
  cleanState();
  preventSleep();
  await initSlack();
  await startupCheck();
  startSlackHealthCheck();
  startHttpServer();
  log('info', 'Agent Pager ready');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
