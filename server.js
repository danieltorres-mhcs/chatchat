const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
// In production, point DATA_DIR at a persistent volume/disk — otherwise
// these files live on the container's ephemeral filesystem and every
// redeploy or restart wipes every account, channel, and silence.
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* already exists, or unwritable — surfaces on first read/write below */ }
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');
const SILENCES_FILE = path.join(DATA_DIR, 'silences.json');

const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{2,15}$/; // 3-16 chars, starts with a letter
const CHANNEL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{1,20}$/; // 2-21 chars, starts with a letter

const MAX_CHANNELS_PER_IP = 5;
const INVITE_COOLDOWN_MS = 110 * 1000; // 1 minute 50 seconds
const PING_COOLDOWN_MS = 60 * 1000; // 1 minute
const MAX_PING_TARGETS = 2;

// Ordinary chat messages are paced: after sending one, the next allowed send
// time is pushed out by an amount that scales with how long the message was
// (1s for a short message, up to 6s for a very long one).
const MESSAGE_COOLDOWN_TIERS = [
  { maxLen: 20, ms: 1000 },
  { maxLen: 60, ms: 2000 },
  { maxLen: 120, ms: 3000 },
  { maxLen: 200, ms: 4000 },
  { maxLen: 320, ms: 5000 },
  { maxLen: Infinity, ms: 6000 },
];
function cooldownForMessage(text) {
  const len = text.length;
  const tier = MESSAGE_COOLDOWN_TIERS.find((t) => len <= t.maxLen);
  return tier.ms;
}

// ---------------------------------------------------------------------------
// Tiny JSON-file "databases". Good enough for a small self-hosted chat; swap
// these for a real DB if you outgrow them.
// ---------------------------------------------------------------------------
function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Could not parse ${file}, starting fresh.`, e);
    return fallback;
  }
}
function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
function saveChannels() { fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2)); }
function saveSilences() { fs.writeFileSync(SILENCES_FILE, JSON.stringify(silences, null, 2)); }

// username (lowercased) -> { username, hash, createdAt, nickHistory, blockedInviterIPs, isMod }
let users = loadJson(USERS_FILE, {});
for (const key of Object.keys(users)) {
  if (!Array.isArray(users[key].nickHistory)) users[key].nickHistory = [users[key].username];
  if (!Array.isArray(users[key].blockedInviterIPs)) users[key].blockedInviterIPs = [];
  if (typeof users[key].isMod !== 'boolean') users[key].isMod = false;
}
saveUsers();

// "daniel" is always a moderator (and more — see the /create and /delete
// chnl special cases below, which stay exclusive to daniel and are NOT
// granted by isMod). Regular mods get real /silence, /unsilence,
// /modaccept, and /moddecline.
function isModerator(accountKey) {
  return accountKey === 'daniel' || !!(users[accountKey] && users[accountKey].isMod);
}

// channel key (lowercased, no '#') -> { name, type, creatorKey, creatorIP, createdAt, members[] }
// members[] (account keys) is only meaningful for private channels.
let channels = loadJson(CHANNELS_FILE, {});
if (!channels['main']) {
  channels['main'] = { name: 'main', type: 'public', creatorKey: 'system', creatorIP: null, createdAt: Date.now(), members: [] };
}
saveChannels();

// account key -> { until (ms epoch, or null if permanent), permanent, reason,
// appeals: [{text, ts}], appealsUsed }. Real, server-enforced silences: only
// "Daniel" can create these. Expired timed entries are lazily cleaned up by
// getActiveSilence() — permanent ones never expire on their own, only via
// /unsilence or /modaccept.
let silences = loadJson(SILENCES_FILE, {});

function getActiveSilence(accountKey) {
  const rec = silences[accountKey];
  if (!rec) return null;
  if (rec.permanent) return rec;
  if (rec.until <= Date.now()) {
    delete silences[accountKey];
    saveSilences();
    return null;
  }
  return rec;
}

// Appeal limits scale up for a permanent silence — 3 tries instead of 2,
// and a longer 400-character cap instead of 300.
function appealLimitsFor(rec) {
  return rec.permanent ? { max: 3, charLimit: 400 } : { max: 2, charLimit: 300 };
}

function formatRemaining(rec) {
  return rec.permanent ? 'permanently' : `for ${Math.ceil((rec.until - Date.now()) / 1000)}s more`;
}

function silenceBlockMessage(rec) {
  const { max, charLimit } = appealLimitsFor(rec);
  const reasonPart = rec.reason ? ` Reason: "${rec.reason}".` : '';
  return `You're silenced ${formatRemaining(rec)} and can't send messages.${reasonPart} Use /appeal <text> (up to ${max}, ${charLimit} chars max) if you'd like to contest it.`;
}

function recordNick(accountKey, nick) {
  const record = users[accountKey];
  if (!record) return;
  if (!Array.isArray(record.nickHistory)) record.nickHistory = [record.username];
  if (!record.nickHistory.some((n) => n.toLowerCase() === nick.toLowerCase())) {
    record.nickHistory.push(nick);
    saveUsers();
  }
}
function findAccountByAnyName(name) {
  const lower = name.toLowerCase();
  if (users[lower]) return users[lower];
  return Object.values(users).find(
    (u) => Array.isArray(u.nickHistory) && u.nickHistory.some((n) => n.toLowerCase() === lower)
  );
}
function displayName(accountKey) {
  return users[accountKey] ? users[accountKey].username : accountKey;
}
// Resolves a typed name to { accountKey, ws } — checks currently-online
// nicknames first, then falls back to any known (offline) account.
function resolveAccount(name) {
  if (!name) return { accountKey: null, ws: null };
  const ws = nickIndex.get(name.toLowerCase()) || null;
  const accountKey = ws ? accountKeys.get(ws) : (users[name.toLowerCase()] ? name.toLowerCase() : null);
  return { accountKey, ws };
}
function avatarFor(accountKey) {
  return (users[accountKey] && users[accountKey].avatar) || null;
}
const AVATAR_URL_RE = /^https?:\/\/\S+$/i;
function normalizeChannelName(raw) {
  return (raw || '').replace(/^#/, '').trim();
}

// ---------------------------------------------------------------------------
// Sessions: random token -> account username. Kept in memory; logging back in
// issues a fresh token, and tokens die when the server restarts.
// ---------------------------------------------------------------------------
const sessions = new Map();
function makeToken() { return crypto.randomBytes(24).toString('hex'); }

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const uname = username.trim();
  if (!USERNAME_RE.test(uname)) {
    return res.status(400).json({
      error: 'Username must be 3-16 characters, start with a letter, and use only letters, numbers, _ or -.',
    });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  const key = uname.toLowerCase();
  if (users[key]) {
    return res.status(409).json({ error: `The name "${uname}" is already taken.` });
  }
  const hash = bcrypt.hashSync(password, 10);
  users[key] = { username: uname, hash, createdAt: Date.now(), nickHistory: [uname], blockedInviterIPs: [], isMod: false };
  saveUsers();
  const token = makeToken();
  sessions.set(token, uname);
  res.json({ token, username: uname });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const key = username.trim().toLowerCase();
  const record = users[key];
  if (!record || !bcrypt.compareSync(password, record.hash)) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  const silence = getActiveSilence(key);
  if (silence) {
    const when = silence.permanent ? "and can't log in — permanently silenced" : `and can't log in for another ${Math.ceil((silence.until - Date.now()) / 1000)}s`;
    return res.status(403).json({ error: `You are silenced ${when}. If you're still connected in another tab, you can /appeal there.` });
  }
  const token = makeToken();
  sessions.set(token, record.username);
  res.json({ token, username: record.username });
});

// ---------------------------------------------------------------------------
// WebSocket chat layer
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const clients = new Map();      // ws -> current display nick
const accountKeys = new Map();  // ws -> account key (lowercased login username)
const wsChannel = new Map();    // ws -> current channel key
const nickIndex = new Map();    // nick (lowercased) -> ws, for whispers/invites/pings
const ips = new Map();          // ws -> remote IP

const pendingInvites = new Map();  // account key -> [{ channelKey, channelName, inviter, creator, ts }]
const inviteCooldowns = new Map(); // "inviterKey:inviteeKey" -> last invite ts
const pingCooldowns = new Map();   // account key -> last ping ts
const messageCooldowns = new Map(); // account key -> timestamp when they may send their next message

function checkMessageCooldown(ws, accountKey, text) {
  const nextAllowed = messageCooldowns.get(accountKey) || 0;
  const remaining = nextAllowed - now();
  if (remaining > 0) {
    sendTo(ws, { type: 'system', ts: now(), text: `Slow down — wait ${Math.ceil(remaining / 1000)}s before sending another message.` });
    return false;
  }
  messageCooldowns.set(accountKey, now() + cooldownForMessage(text));
  return true;
}

const MENTION_RE = /@([a-zA-Z][a-zA-Z0-9_-]{2,15})/g;

// Pull up to MAX_PING_TARGETS valid "@name" mentions out of a message —
// only names of people currently online in the same channel count.
function extractPingTargets(text, channelKey) {
  const targets = [];
  const seen = new Set();
  let match;
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(text)) && targets.length < MAX_PING_TARGETS) {
    const lower = match[1].toLowerCase();
    if (seen.has(lower)) continue;
    const w = nickIndex.get(lower);
    if (w && wsChannel.get(w) === channelKey) {
      targets.push(clients.get(w));
      seen.add(lower);
    }
  }
  return targets;
}

const now = () => Date.now();

function sendTo(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function channelWsList(channelKey) {
  const out = [];
  for (const [w, k] of wsChannel.entries()) if (k === channelKey) out.push(w);
  return out;
}

// Everyone who should receive a channel's actual content, regardless of
// whether they're currently looking at it: for a public channel that's
// every connected client (public = visible to all); for a private channel
// it's every currently-connected member, wherever they're looking right
// now. Distinct from channelWsList(), which is only current viewers (used
// for presence/the user list).
function channelMemberWsList(channelKey, exceptWs) {
  const channel = channels[channelKey];
  if (!channel) return [];
  if (channel.type === 'public') {
    return Array.from(clients.keys()).filter((w) => w !== exceptWs && w.readyState === WebSocket.OPEN);
  }
  const out = [];
  for (const [w, k] of accountKeys.entries()) {
    if (channel.members.includes(k) && w !== exceptWs && w.readyState === WebSocket.OPEN) out.push(w);
  }
  return out;
}

function broadcastToChannelMembers(channelKey, obj, exceptWs) {
  const channel = channels[channelKey];
  const payload = { ...obj, channel: channel ? channel.name : undefined };
  const data = JSON.stringify(payload);
  channelMemberWsList(channelKey, exceptWs).forEach((w) => w.send(data));
}

function sendChannelUserList(channelKey) {
  const wsList = channelWsList(channelKey);
  const list = wsList
    .map((w) => ({ nick: clients.get(w), avatar: avatarFor(accountKeys.get(w)) }))
    .sort((a, b) => a.nick.localeCompare(b.nick));
  const data = JSON.stringify({ type: 'userlist', users: list });
  wsList.forEach((w) => { if (w.readyState === WebSocket.OPEN) w.send(data); });
}

function sendChannelListTo(ws) {
  const accountKey = accountKeys.get(ws);
  const publicList = Object.keys(channels)
    .filter((k) => channels[k].type === 'public')
    .map((k) => ({ name: channels[k].name, count: channelWsList(k).length }));
  const privateList = Object.keys(channels)
    .filter((k) => channels[k].type === 'private' && accountKey && channels[k].members.includes(accountKey))
    .map((k) => ({ name: channels[k].name, creator: displayName(channels[k].creatorKey), count: channelWsList(k).length }));
  sendTo(ws, {
    type: 'channellist',
    public: publicList.sort((a, b) => a.name.localeCompare(b.name)),
    private: privateList.sort((a, b) => a.name.localeCompare(b.name)),
    current: wsChannel.get(ws),
    totalOnline: clients.size,
  });
}

function broadcastChannelListToAll() {
  wss.clients.forEach((w) => sendChannelListTo(w));
}

// Every connected nick, server-wide — used by the client to suggest
// usernames while typing a command (e.g. /msg, /whowas, /report), which
// aren't limited to whoever's in your current channel.
function broadcastOnlineUsers() {
  const list = Array.from(clients.values()).sort((a, b) => a.localeCompare(b));
  const data = JSON.stringify({ type: 'onlineusers', users: list });
  wss.clients.forEach((w) => { if (w.readyState === WebSocket.OPEN) w.send(data); });
}

function sendInvitesTo(ws) {
  const accountKey = accountKeys.get(ws);
  const invites = (pendingInvites.get(accountKey) || []).map((inv) => ({
    channel: inv.channelName,
    inviter: inv.inviter,
    creator: inv.creator,
    ts: inv.ts,
  }));
  sendTo(ws, { type: 'invites', invites });
}

function wsForAccount(accountKey) {
  for (const [w, k] of accountKeys.entries()) if (k === accountKey) return w;
  return null;
}

function connectedModeratorWs() {
  const out = [];
  for (const [w, k] of accountKeys.entries()) if (isModerator(k)) out.push(w);
  return out;
}

// Pushes the current list of silenced accounts with pending appeals to
// every connected moderator (Daniel plus any mods). No-op for everyone else.
function pushModAppealsToModerators() {
  const targets = connectedModeratorWs();
  if (!targets.length) return;
  const pending = Object.entries(silences)
    .filter(([, rec]) => Array.isArray(rec.appeals) && rec.appeals.length > 0 && (rec.permanent || rec.until > Date.now()))
    .map(([key, rec]) => ({
      target: displayName(key),
      permanent: !!rec.permanent,
      remainingSeconds: rec.permanent ? null : Math.ceil((rec.until - Date.now()) / 1000),
      reason: rec.reason || null,
      appeals: rec.appeals,
      appealsUsed: rec.appealsUsed || 0,
      appealsMax: appealLimitsFor(rec).max,
    }));
  targets.forEach((w) => sendTo(w, { type: 'modappeals', appeals: pending }));
}

// Requests from mods asking Daniel to add or remove another mod. In-memory
// only (like pendingInvites) — lost on restart, easy to re-submit.
// { type: 'add'|'remove', targetKey, requestedBy (display name), ts }
let modRequests = [];

function pushModRequestsToDaniel() {
  const danielWs = wsForAccount('daniel');
  if (!danielWs) return;
  const list = modRequests.map((r) => ({
    type: r.type,
    target: displayName(r.targetKey),
    requestedBy: r.requestedBy,
    ts: r.ts,
  }));
  sendTo(danielWs, { type: 'modrequests', requests: list });
}

// User-filed reports against other accounts. In-memory only, like invites
// and mod requests. reportCounts tracks "reporterKey:targetKey" -> count so
// the same person can't be reported by the same reporter more than twice.
let reports = [];
const reportCounts = new Map();

function pushReportsToModerators() {
  const targets = connectedModeratorWs();
  if (!targets.length) return;
  const list = reports.map((r) => ({
    id: r.id,
    reporter: r.reporter,
    targets: r.targets,
    reason: r.reason,
    messages: r.messages,
    ts: r.ts,
  }));
  targets.forEach((w) => sendTo(w, { type: 'reports', reports: list }));
}

const MAX_REPORT_TARGETS = 3;
const MAX_REPORTS_PER_TARGET = 2;
const MAX_REPORT_MESSAGES = 5;

// Files a report against 1-3 people at once, with up to 5 selected messages
// as evidence. reportCounts caps how many times the same reporter can name
// the same target across all their reports, at 2 — targets already at that
// cap are silently dropped from this filing rather than blocking the whole
// report, so reporting 3 people together doesn't fail just because one of
// them was already reported twice before.
function handleReportSubmission(ws, accountKey, nick, payload) {
  const rawTargets = Array.isArray(payload.targets) ? payload.targets : (payload.target ? [payload.target] : []);
  const reason = typeof payload.reason === 'string' ? payload.reason.trim().slice(0, 300) : '';
  const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];

  if (!rawTargets.length || !reason) {
    sendTo(ws, { type: 'system', ts: now(), text: 'Usage: /report <user1[,user2,user3]> <reason> — up to 3 people, and up to 5 selected messages as evidence.' });
    return;
  }

  const resolvedKeys = [];
  const seen = new Set();
  for (const name of rawTargets.slice(0, MAX_REPORT_TARGETS)) {
    const { accountKey: targetKey } = resolveAccount(typeof name === 'string' ? name.trim() : '');
    if (!targetKey || targetKey === accountKey || seen.has(targetKey)) continue;
    seen.add(targetKey);
    resolvedKeys.push(targetKey);
  }
  if (!resolvedKeys.length) {
    sendTo(ws, { type: 'system', ts: now(), text: 'No valid users to report there.' });
    return;
  }

  const eligible = resolvedKeys.filter((targetKey) => {
    const count = reportCounts.get(`${accountKey}:${targetKey}`) || 0;
    return count < MAX_REPORTS_PER_TARGET;
  });
  const maxedOut = resolvedKeys.filter((k) => !eligible.includes(k)).map(displayName);

  if (!eligible.length) {
    sendTo(ws, { type: 'system', ts: now(), text: `You've already reported ${maxedOut.join(', ')} the maximum of ${MAX_REPORTS_PER_TARGET} times.` });
    return;
  }

  eligible.forEach((targetKey) => {
    reportCounts.set(`${accountKey}:${targetKey}`, (reportCounts.get(`${accountKey}:${targetKey}`) || 0) + 1);
  });

  const messages = rawMessages
    .filter((m) => m && typeof m.text === 'string' && typeof m.from === 'string')
    .slice(0, MAX_REPORT_MESSAGES)
    .map((m) => ({ from: m.from.slice(0, 32), text: m.text.slice(0, 1000), ts: Number(m.ts) || now() }));

  reports.push({
    id: crypto.randomBytes(6).toString('hex'),
    reporter: nick,
    targets: eligible.map(displayName),
    reason,
    messages,
    ts: now(),
  });

  let confirmText = `Reported ${eligible.map(displayName).join(', ')}. Thanks — a moderator will take a look.`;
  if (maxedOut.length) confirmText += ` (Skipped ${maxedOut.join(', ')} — already reported the max ${MAX_REPORTS_PER_TARGET} times.)`;
  sendTo(ws, { type: 'system', ts: now(), text: confirmText });
  pushReportsToModerators();
}

function channelHeaderInfo(channelKey) {
  const c = channels[channelKey];
  return { name: c.name, channelType: c.type, creator: displayName(c.creatorKey) };
}

function announceChannel(ws) {
  sendTo(ws, { type: 'channel', ...channelHeaderInfo(wsChannel.get(ws)) });
}

// Moves a connection from its current channel into newKey, broadcasting join/leave
// system messages and refreshing user lists + the sidebar channel list for everyone.
function switchChannel(ws, newKey, opts = {}) {
  const nick = clients.get(ws);
  const oldKey = wsChannel.get(ws);
  if (oldKey === newKey) return;

  if (oldKey) {
    wsChannel.delete(ws);
    if (opts.announceLeave) {
      broadcastToChannelMembers(oldKey, { type: 'system', ts: now(), text: `${nick} left #${channels[oldKey].name}.` });
    }
    sendChannelUserList(oldKey);
  }
  wsChannel.set(ws, newKey);
  if (opts.announceJoin) {
    broadcastToChannelMembers(newKey, { type: 'system', ts: now(), text: `${nick} joined #${channels[newKey].name}.` }, ws);
  }
  sendChannelUserList(newKey);
  announceChannel(ws);
  broadcastChannelListToAll();
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const username = sessions.get(token);

  if (!username) {
    sendTo(ws, { type: 'error', text: 'Session expired or invalid. Please log in again.' });
    ws.close();
    return;
  }
  if (nickIndex.has(username.toLowerCase())) {
    sendTo(ws, { type: 'error', text: 'That account is already connected elsewhere.' });
    ws.close();
    return;
  }
  const activeSilence = getActiveSilence(username.toLowerCase());
  if (activeSilence) {
    const when = activeSilence.permanent ? "connect — you're permanently silenced" : `connect for another ${Math.ceil((activeSilence.until - Date.now()) / 1000)}s`;
    sendTo(ws, { type: 'error', text: `You are silenced and can't ${when}.` });
    ws.close();
    return;
  }

  const accountKey = username.toLowerCase();
  clients.set(ws, username);
  accountKeys.set(ws, accountKey);
  nickIndex.set(accountKey, ws);
  ips.set(ws, req.socket.remoteAddress);

  sendTo(ws, {
    type: 'welcome',
    text: `Connected as ${username}. Type /help to see available commands.`,
    ts: now(),
    nick: username,
    isModerator: isModerator(accountKey),
  });

  wsChannel.set(ws, 'main');
  broadcastToChannelMembers('main', { type: 'system', text: `${username} has joined.`, ts: now() }, ws);
  sendChannelUserList('main');
  announceChannel(ws);
  sendChannelListTo(ws);
  sendInvitesTo(ws);
  broadcastChannelListToAll();
  broadcastOnlineUsers();
  if (isModerator(accountKey)) pushModAppealsToModerators();
  if (isModerator(accountKey)) pushReportsToModerators();
  if (accountKey === 'daniel') pushModRequestsToDaniel();

  ws.on('message', (raw) => {
    let text;
    try { text = raw.toString(); } catch { return; }
    if (!text || !text.trim()) return;
    const nick = clients.get(ws);
    const channelKey = wsChannel.get(ws);
    const accountKey = accountKeys.get(ws);

    if (text.trim().startsWith('{')) {
      let payload = null;
      try { payload = JSON.parse(text.slice(0, 8000)); } catch { payload = null; }
      if (payload && payload.type === 'report') {
        handleReportSubmission(ws, accountKey, nick, payload);
        return;
      }
      // Not a recognized structured message (or just a chat line that happens
      // to start with "{") — fall through to normal handling below.
    }

    text = text.slice(0, 2000);

    if (text.startsWith('/')) {
      handleCommand(ws, nick, channelKey, text);
    } else {
      const silence = getActiveSilence(accountKey);
      if (silence) {
        sendTo(ws, { type: 'system', ts: now(), text: silenceBlockMessage(silence) });
        return;
      }
      if (!checkMessageCooldown(ws, accountKey, text)) return;

      const mentioned = extractPingTargets(text, channelKey);
      let pingTargets;
      if (mentioned.length) {
        const last = pingCooldowns.get(accountKey) || 0;
        const wait = PING_COOLDOWN_MS - (now() - last);
        if (wait > 0) {
          sendTo(ws, { type: 'system', ts: now(), text: `You can ping again in ${Math.ceil(wait / 1000)}s — sent without a highlight this time.` });
        } else {
          pingCooldowns.set(accountKey, now());
          pingTargets = mentioned;
        }
      }
      broadcastToChannelMembers(channelKey, { type: 'chat', from: nick, text, ts: now(), pingTargets, avatar: avatarFor(accountKey) });
    }
  });

  ws.on('close', () => {
    const nick = clients.get(ws);
    const channelKey = wsChannel.get(ws);
    const acctKey = accountKeys.get(ws);

    clients.delete(ws);
    accountKeys.delete(ws);
    wsChannel.delete(ws);
    ips.delete(ws);
    if (acctKey) nickIndex.delete(acctKey);
    if (nick && nickIndex.get(nick.toLowerCase()) === ws) nickIndex.delete(nick.toLowerCase());

    if (nick && channelKey) {
      broadcastToChannelMembers(channelKey, { type: 'system', text: `${nick} has left.`, ts: now() });
      sendChannelUserList(channelKey);
      broadcastChannelListToAll();
    }
    broadcastOnlineUsers();
  });
});

function handleCommand(ws, nick, channelKey, raw) {
  const trimmed = raw.trim();
  const [cmdRaw, ...rest] = trimmed.split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const argLine = trimmed.slice(cmdRaw.length).trim();
  const accountKey = accountKeys.get(ws);

  switch (cmd) {
    case '/help': {
      sendTo(ws, {
        type: 'system',
        ts: now(),
        text: [
          'Commands:',
          '/nick <name> — change your nickname',
          '/me <action> — send an action message',
          '/msg <user> <text> (or /w) — whisper someone',
          '@name in a message — ping up to 2 people, once per minute',
          '/list — who\'s in your current channel',
          '/channels — list public channels + your private ones',
          '/create <name> — create a channel',
          '/join <name> — switch channels',
          '/invite <user> [channel] — invite to a private channel',
          '/invites — your pending invites',
          '/accept <channel> / /decline <channel>',
          '/leave — leave your current private channel',
          '/pfp <image url> (or /pfp none) — set/clear your profile picture',
          '/blockinvites <user> / /unblockinvites <user> — stop someone inviting you',
          '/mute <user> / /unmute <user> / /mlist — hide someone, just for you',
          '/ff — toggle the local profanity filter',
          '/silence <user> / /unsilence <user> — alias for mute/unmute',
          '/appeal <text> — contest a silence (2 tries/300 chars normally, 3 tries/400 chars if it\'s permanent)',
          '/whowas <name> — nickname history',
          '/report <user> <reason> — report someone to the mods (select up to 5 of their messages first if you want, in the log; up to 3 people per report, twice max per person)',
          '/mods — see who moderates this server',
          '/delete acc <password> <password again> — permanently delete your account',
          '/delete chnl <name> — delete a channel (only your own private ones, #main excluded)',
          '/quit — disconnect',
          '/logout — disconnect and forget your saved login on this browser',
          '',
          'Messages are paced 1-6s depending on length.',
        ].join('\n'),
      });
      break;
    }

    case '/modhelp': {
      if (!isModerator(accountKey)) {
        sendTo(ws, { type: 'system', ts: now(), text: `Unknown command: ${cmd}. Type /help for a list.` });
        return;
      }
      sendTo(ws, {
        type: 'system',
        ts: now(),
        text: [
          'Moderator commands (you + any other mods):',
          '/silence <user> <seconds|perm> [c|nc] [reason] — default nc; c mutes on your own screen only (with a timer, or indefinitely for perm) and never touches the server; nc is real: blocks their chat and login until it\'s lifted. "perm" instead of a number makes it permanent — they then get 3 appeals at 400 chars each instead of the normal 2/300. A trailing reason is optional and shown to them + to you in the Appeals panel',
          '/unsilence <user> — lifts a real nc silence (timed or permanent) early',
          '/modaccept <user> / /moddecline <user> — resolve a pending appeal; accept lifts the silence, decline clears the appeal but the silence stays',
          'Reports people file show up automatically in your Reports panel — no need to ask for them. /reportclear <id> dismisses one once you\'ve dealt with it.',
          '',
          "Everyone else's /silence and /unsilence are just aliases for /mute and /unmute.",
          '',
          accountKey === 'daniel'
            ? [
                'Daniel-only, on top of the above:',
                '/create <name> [pbl|prv] — only you can make a public channel; default is prv, everyone else (mods included) always gets private no matter what they type',
                '/delete chnl <name> — you can delete any channel, public or private, made by anyone (still never #main). Mods can only delete their own private channels, same as regular users',
                '/addmod <user> / /removemod <user> — grant or revoke mod status directly',
                '/modreqaccept <user> / /modreqdecline <user> — approve or reject a mod\'s request to add/remove another mod',
              ].join('\n')
            : "You can't add or remove mods yourself — use /requestmod <user> or /requestunmod <user> to ask Daniel to.",
        ].join('\n'),
      });
      break;
    }

    case '/list': {
      const nicks = channelWsList(channelKey).map((w) => clients.get(w));
      sendTo(ws, { type: 'system', ts: now(), text: `In #${channels[channelKey].name} (${nicks.length}): ${nicks.join(', ')}` });
      break;
    }

    case '/channels': {
      const pub = Object.values(channels).filter((c) => c.type === 'public');
      const mine = Object.values(channels).filter((c) => c.type === 'private' && c.members.includes(accountKey));
      let text = `Public channels: ${pub.map((c) => '#' + c.name).join(', ') || '(none)'}.`;
      if (mine.length) text += ` Your private channels: ${mine.map((c) => '#' + c.name).join(', ')}.`;
      sendTo(ws, { type: 'system', ts: now(), text });
      break;
    }

    case '/create': {
      const name = normalizeChannelName(rest[0]);
      if (!CHANNEL_NAME_RE.test(name)) {
        sendTo(ws, { type: 'system', ts: now(), text: 'Usage: /create <2-21 char name>' });
        return;
      }
      const key = name.toLowerCase();
      if (channels[key]) {
        sendTo(ws, { type: 'system', ts: now(), text: `#${name} already exists.` });
        return;
      }
      const ip = ips.get(ws);
      const countForIP = Object.values(channels).filter((c) => c.creatorIP && c.creatorIP === ip).length;
      if (countForIP >= MAX_CHANNELS_PER_IP) {
        sendTo(ws, { type: 'system', ts: now(), text: `Limit reached: your network can only create ${MAX_CHANNELS_PER_IP} channels.` });
        return;
      }

      // Only the "Daniel" account can ever produce a public channel, via a
      // trailing "pbl" (public) or "prv" (private, the default) argument.
      // Everyone else's channels are always private, whatever they type here.
      let isPrivate = true;
      if (accountKey === 'daniel') {
        const param = (rest[1] || '').toLowerCase();
        isPrivate = param !== 'pbl';
      }

      channels[key] = {
        name,
        type: isPrivate ? 'private' : 'public',
        creatorKey: accountKey,
        creatorIP: ip,
        createdAt: now(),
        members: isPrivate ? [accountKey] : [],
      };
      saveChannels();
      sendTo(ws, { type: 'system', ts: now(), text: `Created ${isPrivate ? 'private' : 'public'} channel #${name}.` });
      switchChannel(ws, key);
      break;
    }

    case '/join': {
      const name = normalizeChannelName(rest[0]);
      const key = name.toLowerCase();
      const channel = channels[key];
      if (!channel) {
        sendTo(ws, { type: 'system', ts: now(), text: `No such channel: #${name}. Use /create to make it.` });
        return;
      }
      if (channel.type === 'private' && !channel.members.includes(accountKey)) {
        sendTo(ws, { type: 'system', ts: now(), text: `#${channel.name} is private. You need an invite.` });
        return;
      }
      if (key === channelKey) {
        sendTo(ws, { type: 'system', ts: now(), text: `You're already in #${channel.name}.` });
        return;
      }
      switchChannel(ws, key);
      break;
    }

    case '/invite': {
      const targetName = rest[0];
      const explicitChannel = rest[1] ? normalizeChannelName(rest[1]).toLowerCase() : channelKey;
      const channel = channels[explicitChannel];
      if (!targetName) {
        sendTo(ws, { type: 'system', ts: now(), text: 'Usage: /invite <user> [channel]' });
        return;
      }
      if (!channel || channel.type !== 'private') {
        sendTo(ws, { type: 'system', ts: now(), text: 'You can only invite people to a private channel you belong to.' });
        return;
      }
      if (!channel.members.includes(accountKey)) {
        sendTo(ws, { type: 'system', ts: now(), text: `You're not a member of #${channel.name}.` });
        return;
      }
      const targetWs = nickIndex.get(targetName.toLowerCase());
      if (!targetWs) {
        sendTo(ws, { type: 'system', ts: now(), text: `No such user online: ${targetName}` });
        return;
      }
      const targetKey = accountKeys.get(targetWs);
      if (channel.members.includes(targetKey)) {
        sendTo(ws, { type: 'system', ts: now(), text: `${clients.get(targetWs)} is already in #${channel.name}.` });
        return;
      }
      const cdKey = `${accountKey}:${targetKey}`;
      const last = inviteCooldowns.get(cdKey) || 0;
      const wait = INVITE_COOLDOWN_MS - (now() - last);
      if (wait > 0) {
        sendTo(ws, { type: 'system', ts: now(), text: `You can invite ${clients.get(targetWs)} again in ${Math.ceil(wait / 1000)}s.` });
        return;
      }
      inviteCooldowns.set(cdKey, now());

      const inviterIP = ips.get(ws);
      const targetRecord = users[targetKey];
      const isBlocked = !!(inviterIP && targetRecord && targetRecord.blockedInviterIPs.includes(inviterIP));

      if (!isBlocked) {
        const list = pendingInvites.get(targetKey) || [];
        const already = list.find((inv) => inv.channelKey === explicitChannel);
        const inviteObj = {
          channelKey: explicitChannel,
          channelName: channel.name,
          inviter: nick,
          creator: displayName(channel.creatorKey),
          ts: now(),
        };
        if (already) {
          already.inviter = nick;
          already.ts = now();
        } else {
          list.push(inviteObj);
        }
        pendingInvites.set(targetKey, list);

        sendTo(targetWs, {
          type: 'invite',
          ts: now(),
          text: `${nick} invited you to #${channel.name} (created by ${inviteObj.creator}). Use /accept ${channel.name} or /decline ${channel.name}.`,
          channel: channel.name,
          inviter: nick,
        });
        sendInvitesTo(targetWs);
      }

      // Whether or not it was actually delivered (silently dropped if
      // blocked), the inviter sees the same success message either way.
      sendTo(ws, { type: 'system', ts: now(), text: `Invited ${clients.get(targetWs)} to #${channel.name}.` });
      break;
    }

    case '/invites': {
      const list = pendingInvites.get(accountKey) || [];
      if (!list.length) {
        sendTo(ws, { type: 'system', ts: now(), text: 'No pending invites.' });
        return;
      }
      const text = list
        .map((inv) => `#${inv.channelName} (invited by ${inv.inviter}, created by ${inv.creator})`)
        .join('; ');
      sendTo(ws, { type: 'system', ts: now(), text: `Pending invites: ${text}` });
      break;
    }

    case '/accept': {
      const name = normalizeChannelName(rest[0]);
      const key = name.toLowerCase();
      const list = pendingInvites.get(accountKey) || [];
      const idx = list.findIndex((inv) => inv.channelKey === key);
      if (idx === -1) {
        sendTo(ws, { type: 'system', ts: now(), text: `No pending invite for #${name}.` });
        return;
      }
      const channel = channels[key];
      if (!channel) {
        list.splice(idx, 1);
        pendingInvites.set(accountKey, list);
        sendTo(ws, { type: 'system', ts: now(), text: `That channel no longer exists.` });
        return;
      }
      if (!channel.members.includes(accountKey)) {
        channel.members.push(accountKey);
        saveChannels();
      }
      list.splice(idx, 1);
      pendingInvites.set(accountKey, list);
      sendInvitesTo(ws);
      sendTo(ws, { type: 'system', ts: now(), text: `Joined #${channel.name}.` });
      switchChannel(ws, key, { announceJoin: true });
      break;
    }

    case '/decline': {
      const name = normalizeChannelName(rest[0]);
      const key = name.toLowerCase();
      const list = pendingInvites.get(accountKey) || [];
      const idx = list.findIndex((inv) => inv.channelKey === key);
      if (idx === -1) {
        sendTo(ws, { type: 'system', ts: now(), text: `No pending invite for #${name}.` });
        return;
      }
      list.splice(idx, 1);
      pendingInvites.set(accountKey, list);
      sendInvitesTo(ws);
      sendTo(ws, { type: 'system', ts: now(), text: `Declined the invite to #${name}.` });
      break;
    }

    case '/leave': {
      const channel = channels[channelKey];
      if (channel.type !== 'private') {
        sendTo(ws, { type: 'system', ts: now(), text: 'You can only /leave private channels. Public channels stay open — just /join another one.' });
        return;
      }
      channel.members = channel.members.filter((m) => m !== accountKey);
      saveChannels();
      sendTo(ws, { type: 'system', ts: now(), text: `Left #${channel.name}.` });
      switchChannel(ws, 'main', { announceLeave: true });
      break;
    }

    case '/nick': {
      const newNick = rest[0];
      if (!newNick || !USERNAME_RE.test(newNick)) {
        sendTo(ws, { type: 'system', ts: now(), text: 'Usage: /nick <3-16 chars, letters/numbers/_/->' });
        return;
      }
      if (nickIndex.has(newNick.toLowerCase())) {
        sendTo(ws, { type: 'system', ts: now(), text: `"${newNick}" is already in use right now.` });
        return;
      }
      const old = clients.get(ws);
      nickIndex.delete(old.toLowerCase());
      clients.set(ws, newNick);
      nickIndex.set(newNick.toLowerCase(), ws);
      recordNick(accountKey, newNick);
      broadcastToChannelMembers(channelKey, { type: 'system', ts: now(), text: `${old} is now known as ${newNick}.` });
      sendTo(ws, { type: 'nickchange', nick: newNick });
      sendChannelUserList(channelKey);
      broadcastOnlineUsers();
      break;
    }

    case '/me': {
      if (!argLine) {
        sendTo(ws, { type: 'system', ts: now(), text: 'Usage: /me <action>' });
        return;
      }
      const silence = getActiveSilence(accountKey);
      if (silence) {
        sendTo(ws, { type: 'system', ts: now(), text: silenceBlockMessage(silence) });
        return;
      }
      if (!checkMessageCooldown(ws, accountKey, argLine)) return;
      broadcastToChannelMembers(channelKey, { type: 'action', from: nick, text: argLine, ts: now(), avatar: avatarFor(accountKey) });
      break;
    }

    case '/msg':
    case '/w': {
      const target = rest[0];
      const msg = rest.slice(1).join(' ');
      if (!target || !msg) {
        sendTo(ws, { type: 'system', ts: now(), text: 'Usage: /msg <user> <message>' });
        return;
      }
      const targetWs = nickIndex.get(target.toLowerCase());
      if (targetWs) {
        sendTo(targetWs, { type: 'whisper', from: nick, to: clients.get(targetWs), text: msg, ts: now(), avatar: avatarFor(accountKey) });
        sendTo(ws, { type: 'whisper', from: nick, to: clients.get(targetWs), text: msg, ts: now(), self: true, avatar: avatarFor(accountKey) });
      } else {
        sendTo(ws, { type: 'system', ts: now(), text: `No such user online: ${target}` });
      }
      break;
    }

    case '/blockinvites': {
      const target = rest[0];
      if (!target) {
        sendTo(ws, { type: 'system', ts: now(), text: 'Usage: /blockinvites <user> — they must be online right now.' });
        return;
      }
      const targetWs = nickIndex.get(target.toLowerCase());
      if (!targetWs) {
        sendTo(ws, { type: 'system', ts: now(), text: `No such user online: ${target}` });
        return;
      }
      const targetIP = ips.get(targetWs);
      const me = users[accountKey];
      if (targetIP && me && !me.blockedInviterIPs.includes(targetIP)) {
        me.blockedInviterIPs.push(targetIP);
        saveUsers();
      }
      sendTo(ws, { type: 'system', ts: now(), text: `${clients.get(targetWs)} can no longer invite you to any channel — including from any new account made on the same connection.` });
      break;
    }

    case '/unblockinvites': {
      const target = rest[0];
      if (!target) {
        sendTo(ws, { type: 'system', ts: now(), text: 'Usage: /unblockinvites <user> — they must be online right now.' });
        return;
      }
      const targetWs = nickIndex.get(target.toLowerCase());
      if (!targetWs) {
        sendTo(ws, { type: 'system', ts: now(), text: `No such user online: ${target}` });
        return;
      }
      const targetIP = ips.get(targetWs);
      const me = users[accountKey];
      if (targetIP && me) {
        me.blockedInviterIPs = me.blockedInviterIPs.filter((ip) => ip !== targetIP);
        saveUsers();
      }
      sendTo(ws, { type: 'system', ts: now(), text: `${clients.get(targetWs)} can invite you again.` });
      break;
    }

    case '/whowas': {
      const target = rest[0];
      if (!target) {
        sendTo(ws, { type: 'system', ts: now(), text: 'Usage: /whowas <name>' });
        return;
      }
      const account = findAccountByAnyName(target);
      if (!account) {
        sendTo(ws, { type: 'system', ts: now(), text: `No record of anyone named "${target}".` });
        return;
      }
      const names = account.nickHistory && account.nickHistory.length ? account.nickHistory.join(', ') : account.username;
      sendTo(ws, { type: 'system', ts: now(), text: `${account.username} has also been known as: ${names}` });
      break;
    }

    case '/pfp':
    case '/avatar': {
      const arg = rest[0];
      if (!arg) {
        sendTo(ws, { type: 'system', ts: now(), text: 'Usage: /pfp <direct image URL>, or /pfp none to remove it.' });
        return;
      }
      if (arg.toLowerCase() === 'none' || arg.toLowerCase() === 'clear') {
        delete users[accountKey].avatar;
        saveUsers();
        sendTo(ws, { type: 'system', ts: now(), text: 'Profile picture removed.' });
        sendChannelUserList(channelKey);
        return;
      }
      if (arg.length > 500 || !AVATAR_URL_RE.test(arg)) {
        sendTo(ws, { type: 'system', ts: now(), text: 'That doesn\'t look like a direct http(s) link to an image.' });
        return;
      }
      users[accountKey].avatar = arg;
      saveUsers();
      sendTo(ws, { type: 'system', ts: now(), text: 'Profile picture updated.' });
      sendChannelUserList(channelKey);
      break;
    }

    case '/silence': {
      const target = rest[0];
      const durationRaw = (rest[1] || '').toLowerCase();

      if (!isModerator(accountKey)) {
        sendTo(ws, { type: 'system', ts: now(), text: 'Real /silence enforcement is limited to a moderator account. Try /mute instead.' });
        return;
      }
      if (!target || !durationRaw) {
        sendTo(ws, { type: 'system', ts: now(), text: 'Usage: /silence <user> <seconds|perm> [c|nc] [reason]' });
        return;
      }

      const permanent = durationRaw === 'perm';
      const seconds = permanent ? null : parseInt(durationRaw, 10);
      if (!permanent && (!Number.isFinite(seconds) || seconds <= 0)) {
        sendTo(ws, { type: 'system', ts: now(), text: 'Duration must be a positive whole number of seconds, or "perm" for permanent.' });
        return;
      }

      // Mode is optional and defaults to nc — only treat rest[2] as the mode
      // if it's actually "c" or "nc"; otherwise it's the start of the reason.
      let modeArg = 'nc';
      let reasonStart = 2;
      if (/^(c|nc)$/i.test(rest[2] || '')) {
        modeArg = rest[2].toLowerCase();
        reasonStart = 3;
      }
      const reason = rest.slice(reasonStart).join(' ').trim().slice(0, 300) || null;

      const targetWs = nickIndex.get(target.toLowerCase());
      const targetKey = targetWs ? accountKeys.get(targetWs) : (users[target.toLowerCase()] ? target.toLowerCase() : null);
      if (!targetKey) {
        sendTo(ws, { type: 'system', ts: now(), text: `No such user: ${target}` });
        return;
      }
      if (targetKey === accountKey) {
        sendTo(ws, { type: 'system', ts: now(), text: "You can't silence yourself." });
        return;
      }

      if (modeArg === 'c') {
        // Client-only: tell Daniel's own client to mute this nickname locally,
        // with a timer (or indefinitely, for perm). No server enforcement, no
        // appeals, nothing persisted.
        const span = permanent ? 'indefinitely' : `for ${seconds}s`;
        sendTo(ws, { type: 'system', ts: now(), text: `(client) Muted ${displayName(targetKey)} on your own screen ${span}.` });
        return;
      }

      // nc: a real, server-enforced silence.
      const rec = {
        until: permanent ? null : now() + seconds * 1000,
        permanent,
        reason,
        appeals: [],
        appealsUsed: 0,
      };
      silences[targetKey] = rec;
      saveSilences();
      const { max, charLimit } = appealLimitsFor(rec);
      const reasonSuffix = reason ? ` Reason: "${reason}".` : '';
      sendTo(ws, {
        type: 'system',
        ts: now(),
        text: `Silenced ${displayName(targetKey)} ${permanent ? 'permanently' : `for ${seconds}s`}. They can't chat or log in until it's lifted.${reasonSuffix}`,
      });
      if (targetWs) {
        sendTo(targetWs, {
          type: 'system',
          ts: now(),
          text: `You have been silenced ${permanent ? 'permanently' : `for ${seconds}s`}.${reasonSuffix} You can't send messages until it's lifted. Use /appeal <text> (up to ${max} times, ${charLimit} characters max) if you'd like to contest it.`,
        });
      }
      break;
    }

    case '/unsilence': {
      if (!isModerator(accountKey)) {
        sendTo(ws, { type: 'system', ts: now(), text: 'Try /unmute instead.' });
        return;
      }
      const target = rest[0];
      if (!target) {
        sendTo(ws, { type: 'system', ts: now(), text: 'Usage: /unsilence <user>' });
        return;
      }
      const targetWs = nickIndex.get(target.toLowerCase());
      const targetKey = targetWs ? accountKeys.get(targetWs) : (users[target.toLowerCase()] ? target.toLowerCase() : null);
      if (!targetKey || !silences[targetKey]) {
        sendTo(ws, { type: 'system', ts: now(), text: `${target} isn't currently silenced.` });
        return;
      }
      delete silences[targetKey];
      saveSilences();
      sendTo(ws, { type: 'system', ts: now(), text: `Lifted ${displayName(targetKey)}'s silence.` });
      if (targetWs) sendTo(targetWs, { type: 'system', ts: now(), text: 'Your silence has been lifted early.' });
      pushModAppealsToModerators();
      break;
    }

    case '/appeal': {
      const record = getActiveSilence(accountKey);
      if (!record) {
        sendTo(ws, { type: 'system', ts: now(), text: "You're not currently silenced." });
        return;
      }
      const { max, charLimit } = appealLimitsFor(record);
      if (!argLine) {
        sendTo(ws, { type: 'system', ts: now(), text: `Usage: /appeal <message, ${charLimit} characters max>` });
        return;
      }
      if (argLine.length > charLimit) {
        sendTo(ws, { type: 'system', ts: now(), text: `Appeals are limited to ${charLimit} characters.` });
        return;
      }
      record.appealsUsed = record.appealsUsed || 0;
      if (record.appealsUsed >= max) {
        sendTo(ws, { type: 'system', ts: now(), text: `You've already sent the maximum of ${max} appeals for this silence.` });
        return;
      }
      record.appealsUsed += 1;
      record.appeals.push({ text: argLine, ts: now() });
      saveSilences();
      sendTo(ws, { type: 'system', ts: now(), text: `Appeal sent (${record.appealsUsed}/${max}). Hang tight.` });
      pushModAppealsToModerators();
      break;
    }

    case '/modaccept': {
      if (!isModerator(accountKey)) {
        sendTo(ws, { type: 'system', ts: now(), text: 'Unknown command: /modaccept. Type /help for a list.' });
        return;
      }
      const target = rest[0];
      const targetWs = nickIndex.get((target || '').toLowerCase());
      const targetKey = targetWs ? accountKeys.get(targetWs) : (target && users[target.toLowerCase()] ? target.toLowerCase() : null);
      if (!targetKey || !silences[targetKey]) {
        sendTo(ws, { type: 'system', ts: now(), text: `${target || '(none)'} has no active silence to lift.` });
        return;
      }
      delete silences[targetKey];
      saveSilences();
      sendTo(ws, { type: 'system', ts: now(), text: `Accepted ${displayName(targetKey)}'s appeal — silence lifted.` });
      if (targetWs) sendTo(targetWs, { type: 'system', ts: now(), text: 'Your appeal was accepted — silence lifted.' });
      pushModAppealsToModerators();
      break;
    }

    case '/moddecline': {
      if (!isModerator(accountKey)) {
        sendTo(ws, { type: 'system', ts: now(), text: 'Unknown command: /moddecline. Type /help for a list.' });
        return;
      }
      const target = rest[0];
      const targetWs = nickIndex.get((target || '').toLowerCase());
      const targetKey = targetWs ? accountKeys.get(targetWs) : (target && users[target.toLowerCase()] ? target.toLowerCase() : null);
      const record = targetKey ? silences[targetKey] : null;
      if (!record) {
        sendTo(ws, { type: 'system', ts: now(), text: `${target || '(none)'} has no active silence.` });
        return;
      }
      record.appeals = [];
      saveSilences();
      sendTo(ws, { type: 'system', ts: now(), text: `Declined ${displayName(targetKey)}'s appeal — silence remains ${formatRemaining(record)}.` });
      if (targetWs) sendTo(targetWs, { type: 'system', ts: now(), text: 'Your appeal was declined. The silence stays in effect.' });
      pushModAppealsToModerators();
      break;
    }

    case '/addmod': {
      if (accountKey !== 'daniel') {
        sendTo(ws, { type: 'system', ts: now(), text: `Unknown command: ${cmd}. Type /help for a list.` });
        return;
      }
      const { accountKey: targetKey, ws: targetWs } = resolveAccount(rest[0]);
      if (!targetKey) {
        sendTo(ws, { type: 'system', ts: now(), text: `No such user: ${rest[0] || '(none)'}` });
        return;
      }
      if (targetKey === 'daniel') {
        sendTo(ws, { type: 'system', ts: now(), text: "You're already the top-level moderator." });
        return;
      }
      if (users[targetKey].isMod) {
        sendTo(ws, { type: 'system', ts: now(), text: `${displayName(targetKey)} is already a mod.` });
        return;
      }
      users[targetKey].isMod = true;
      saveUsers();
      sendTo(ws, { type: 'system', ts: now(), text: `${displayName(targetKey)} is now a mod.` });
      if (targetWs) {
        sendTo(targetWs, { type: 'system', ts: now(), text: "You've been made a mod. Type /modhelp to see what that gives you." });
        sendTo(targetWs, { type: 'modstatus', isModerator: true });
        pushModAppealsToModerators();
      }
      break;
    }

    case '/removemod': {
      if (accountKey !== 'daniel') {
        sendTo(ws, { type: 'system', ts: now(), text: `Unknown command: ${cmd}. Type /help for a list.` });
        return;
      }
      const { accountKey: targetKey, ws: targetWs } = resolveAccount(rest[0]);
      if (!targetKey) {
        sendTo(ws, { type: 'system', ts: now(), text: `No such user: ${rest[0] || '(none)'}` });
        return;
      }
      if (targetKey === 'daniel') {
        sendTo(ws, { type: 'system', ts: now(), text: "Daniel can't be de-modded." });
        return;
      }
      if (!users[targetKey].isMod) {
        sendTo(ws, { type: 'system', ts: now(), text: `${displayName(targetKey)} isn't a mod.` });
        return;
      }
      users[targetKey].isMod = false;
      saveUsers();
      sendTo(ws, { type: 'system', ts: now(), text: `${displayName(targetKey)} is no longer a mod.` });
      if (targetWs) {
        sendTo(targetWs, { type: 'system', ts: now(), text: 'Your mod status has been removed.' });
        sendTo(targetWs, { type: 'modstatus', isModerator: false });
      }
      break;
    }

    case '/mods': {
      const mods = Object.keys(users).filter((k) => users[k].isMod).map((k) => users[k].username);
      const text = mods.length ? `Mods: Daniel, ${mods.join(', ')}` : 'Mods: Daniel (no other mods right now)';
      sendTo(ws, { type: 'system', ts: now(), text });
      break;
    }

    case '/requestmod':
    case '/requestunmod': {
      if (!isModerator(accountKey) || accountKey === 'daniel') {
        sendTo(ws, { type: 'system', ts: now(), text: `Unknown command: ${cmd}. Type /help for a list.` });
        return;
      }
      const { accountKey: targetKey } = resolveAccount(rest[0]);
      if (!targetKey) {
        sendTo(ws, { type: 'system', ts: now(), text: `No such user: ${rest[0] || '(none)'}` });
        return;
      }
      if (targetKey === 'daniel') {
        sendTo(ws, { type: 'system', ts: now(), text: "That's Daniel — nothing to request there." });
        return;
      }
      const type = cmd === '/requestmod' ? 'add' : 'remove';
      if (type === 'add' && users[targetKey].isMod) {
        sendTo(ws, { type: 'system', ts: now(), text: `${displayName(targetKey)} is already a mod.` });
        return;
      }
      if (type === 'remove' && !users[targetKey].isMod) {
        sendTo(ws, { type: 'system', ts: now(), text: `${displayName(targetKey)} isn't a mod.` });
        return;
      }
      modRequests = modRequests.filter((r) => r.targetKey !== targetKey);
      modRequests.push({ type, targetKey, requestedBy: nick, ts: now() });
      sendTo(ws, { type: 'system', ts: now(), text: `Sent Daniel a request to ${type === 'add' ? 'add' : 'remove'} ${displayName(targetKey)} as a mod.` });
      pushModRequestsToDaniel();
      break;
    }

    case '/modreqaccept':
    case '/modreqdecline': {
      if (accountKey !== 'daniel') {
        sendTo(ws, { type: 'system', ts: now(), text: `Unknown command: ${cmd}. Type /help for a list.` });
        return;
      }
      const { accountKey: targetKey, ws: targetWs } = resolveAccount(rest[0]);
      const reqIdx = targetKey ? modRequests.findIndex((r) => r.targetKey === targetKey) : -1;
      if (reqIdx === -1) {
        sendTo(ws, { type: 'system', ts: now(), text: `No pending mod request for ${rest[0] || '(none)'}` });
        return;
      }
      const req = modRequests[reqIdx];
      modRequests.splice(reqIdx, 1);

      if (cmd === '/modreqdecline') {
        sendTo(ws, { type: 'system', ts: now(), text: `Declined the request to ${req.type} ${displayName(targetKey)}.` });
        pushModRequestsToDaniel();
        break;
      }

      const nowMod = req.type === 'add';
      users[targetKey].isMod = nowMod;
      saveUsers();
      sendTo(ws, { type: 'system', ts: now(), text: `Approved — ${displayName(targetKey)} is ${nowMod ? 'now' : 'no longer'} a mod.` });
      if (targetWs) {
        sendTo(targetWs, { type: 'system', ts: now(), text: nowMod ? "You've been made a mod. Type /modhelp to see what that gives you." : 'Your mod status has been removed.' });
        sendTo(targetWs, { type: 'modstatus', isModerator: isModerator(targetKey) });
      }
      pushModRequestsToDaniel();
      if (nowMod) pushModAppealsToModerators();
      break;
    }

    case '/reportclear': {
      if (!isModerator(accountKey)) {
        sendTo(ws, { type: 'system', ts: now(), text: `Unknown command: ${cmd}. Type /help for a list.` });
        return;
      }
      const id = rest[0];
      const idx = id ? reports.findIndex((r) => r.id === id) : -1;
      if (idx === -1) {
        sendTo(ws, { type: 'system', ts: now(), text: `No pending report with id ${id || '(none)'}` });
        return;
      }
      reports.splice(idx, 1);
      sendTo(ws, { type: 'system', ts: now(), text: 'Report cleared.' });
      pushReportsToModerators();
      break;
    }

    case '/delete': {
      const sub = (rest[0] || '').toLowerCase();

      if (sub === 'chnl') {
        const name = normalizeChannelName(rest[1]);
        const key = name.toLowerCase();
        if (key === 'main') {
          sendTo(ws, { type: 'system', ts: now(), text: "#main can't ever be deleted." });
          return;
        }
        const channel = channels[key];
        if (!channel) {
          sendTo(ws, { type: 'system', ts: now(), text: `No such channel: #${name}` });
          return;
        }
        const isDanielOverride = accountKey === 'daniel';
        const isOwnPrivate = channel.type === 'private' && channel.creatorKey === accountKey;
        if (!isDanielOverride && !isOwnPrivate) {
          sendTo(ws, {
            type: 'system',
            ts: now(),
            text: channel.type === 'public'
              ? 'Only a moderator can delete a public channel.'
              : "You can only delete a private channel you created.",
          });
          return;
        }

        delete channels[key];
        saveChannels();

        // Move anyone currently in it back to #main and let them know why.
        for (const [w, k] of Array.from(wsChannel.entries())) {
          if (k === key) {
            sendTo(w, { type: 'system', ts: now(), text: `#${name} was deleted.` });
            switchChannel(w, 'main');
          }
        }

        // Drop any invites still pointing at the now-gone channel.
        for (const [acctKey, list] of pendingInvites.entries()) {
          const filtered = list.filter((inv) => inv.channelKey !== key);
          if (filtered.length !== list.length) pendingInvites.set(acctKey, filtered);
        }

        sendTo(ws, { type: 'system', ts: now(), text: `Deleted #${name}.` });
        broadcastChannelListToAll();
        return;
      }

      if (sub !== 'acc') {
        sendTo(ws, { type: 'system', ts: now(), text: 'Usage: /delete acc <password> <password again>  or  /delete chnl <channel name>' });
        return;
      }

      const pass = rest[1];
      const confirm = rest[2];
      if (!pass || !confirm) {
        sendTo(ws, { type: 'system', ts: now(), text: 'Usage: /delete acc <password> <password again> — this permanently deletes your account.' });
        return;
      }
      if (pass !== confirm) {
        sendTo(ws, { type: 'system', ts: now(), text: "Those two passwords don't match. Account not deleted." });
        return;
      }
      const account = users[accountKey];
      if (!account || !bcrypt.compareSync(pass, account.hash)) {
        sendTo(ws, { type: 'system', ts: now(), text: 'Incorrect password. Account not deleted.' });
        return;
      }

      // Remove the account itself.
      delete users[accountKey];
      saveUsers();

      // Strip them out of every private channel's membership.
      let channelsChanged = false;
      for (const c of Object.values(channels)) {
        if (Array.isArray(c.members) && c.members.includes(accountKey)) {
          c.members = c.members.filter((m) => m !== accountKey);
          channelsChanged = true;
        }
      }
      if (channelsChanged) saveChannels();

      // Drop any pending invites addressed to them.
      pendingInvites.delete(accountKey);

      // Invalidate every session token tied to this account.
      for (const [tok, uname] of sessions.entries()) {
        if (uname.toLowerCase() === accountKey) sessions.delete(tok);
      }

      // Clear their rate-limit bookkeeping.
      messageCooldowns.delete(accountKey);
      pingCooldowns.delete(accountKey);
      for (const cdKey of inviteCooldowns.keys()) {
        if (cdKey.startsWith(`${accountKey}:`) || cdKey.endsWith(`:${accountKey}`)) inviteCooldowns.delete(cdKey);
      }

      // Drop any silence record tied to this account and let Daniel know if it
      // had a pending appeal.
      if (silences[accountKey]) {
        delete silences[accountKey];
        saveSilences();
        pushModAppealsToModerators();
      }

      sendTo(ws, { type: 'accountdeleted', ts: now(), text: 'Your account has been permanently deleted. Goodbye.' });
      ws.close();
      break;
    }

    case '/quit': {
      sendTo(ws, { type: 'system', ts: now(), text: 'Goodbye.' });
      ws.close();
      break;
    }

    default:
      sendTo(ws, { type: 'system', ts: now(), text: `Unknown command: ${cmd}. Type /help for a list.` });
  }
}

server.listen(PORT, () => {
  console.log(`ChatChat server running at http://localhost:${PORT}`);
});
