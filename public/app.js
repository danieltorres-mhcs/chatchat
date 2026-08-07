(() => {
  'use strict';

  const authScreen = document.getElementById('auth-screen');
  const chatScreen = document.getElementById('chat-screen');
  const bootLog = document.getElementById('boot-log');
  const authForms = document.getElementById('auth-forms');
  const authError = document.getElementById('auth-error');

  const tabs = document.querySelectorAll('.tab');
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');

  const log = document.getElementById('log');
  const sendForm = document.getElementById('send-form');
  const msgInput = document.getElementById('msg-input');
  const autocompleteList = document.getElementById('autocomplete-list');
  const promptNick = document.getElementById('prompt-nick');
  const userList = document.getElementById('user-list');
  const userCount = document.getElementById('user-count');
  const menuToggle = document.getElementById('menu-toggle');
  const sidebarEl = document.getElementById('sidebar');
  const sidebarDragHandle = document.getElementById('sidebar-drag-handle');
  const sidebarCloseBtn = document.getElementById('sidebar-close');
  const publicChannelList = document.getElementById('public-channel-list');
  const privateChannelList = document.getElementById('private-channel-list');
  const privateChannelWrap = document.getElementById('private-channel-wrap');
  const totalOnlineEl = document.querySelector('#total-online strong');
  const inviteList = document.getElementById('invite-list');
  const inviteCount = document.getElementById('invite-count');
  const modAppealsBlock = document.getElementById('mod-appeals-block');
  const modHelpCmd = document.getElementById('modhelp-cmd');
  const reportsBlock = document.getElementById('reports-block');
  const reportsList = document.getElementById('reports-list');
  const modRequestsBlock = document.getElementById('mod-requests-block');
  const modRequestsList = document.getElementById('mod-requests-list');
  const modAppealsList = document.getElementById('mod-appeals-list');

  let ws = null;
  let myNick = null;
  let myAccountName = null;
  let myIsModerator = false;
  let onlineUsers = [];
  let knownChannels = [];
  let history = [];
  let historyIdx = -1;

  function isDaniel() {
    return !!myAccountName && myAccountName.toLowerCase() === 'daniel';
  }

  function applyModeratorUI() {
    const modOn = myIsModerator;
    if (modAppealsBlock) modAppealsBlock.classList.toggle('hidden', !modOn);
    if (modHelpCmd) modHelpCmd.classList.toggle('hidden', !modOn);
    if (reportsBlock) reportsBlock.classList.toggle('hidden', !modOn);
    if (modRequestsBlock) modRequestsBlock.classList.toggle('hidden', !isDaniel());
  }

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------------
  // Boot sequence
  // ---------------------------------------------------------------------
  const bootLines = [
    'connecting to server...',
    'checking your session...',
  ];

  function typeLine(text, cls) {
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'line' + (cls ? ' ' + cls : '');
      bootLog.appendChild(el);
      if (reduceMotion) {
        el.textContent = text;
        resolve();
        return;
      }
      let i = 0;
      const speed = 12;
      const tick = () => {
        el.textContent = text.slice(0, i);
        i++;
        if (i <= text.length) {
          setTimeout(tick, speed);
        } else {
          resolve();
        }
      };
      tick();
    });
  }

  async function runBoot() {
    for (const line of bootLines) {
      await typeLine(line);
    }
    const existingToken = localStorage.getItem('chatchat_token');
    const existingUser = localStorage.getItem('chatchat_username');
    if (existingToken && existingUser) {
      await typeLine(`found saved session for ${existingUser}...`, 'ok');
      connectWebSocket(existingToken, existingUser, /*silentFail*/ true);
    }
    authForms.classList.remove('hidden');
  }

  runBoot();

  // ---------------------------------------------------------------------
  // Auth screen: tabs + forms
  // ---------------------------------------------------------------------
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      authError.textContent = '';
      if (tab.dataset.tab === 'login') {
        loginForm.classList.remove('hidden');
        registerForm.classList.add('hidden');
      } else {
        registerForm.classList.remove('hidden');
        loginForm.classList.add('hidden');
      }
    });
  });

  async function submitAuth(endpoint, username, password) {
    authError.textContent = '';
    try {
      const res = await fetch(`/api/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        authError.textContent = data.error || 'Something went wrong.';
        return;
      }
      localStorage.setItem('chatchat_token', data.token);
      localStorage.setItem('chatchat_username', data.username);
      connectWebSocket(data.token, data.username, false);
    } catch (err) {
      authError.textContent = 'Could not reach the server. Is it running?';
    }
  }

  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    submitAuth('login', username, password);
  });

  registerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('register-username').value.trim();
    const password = document.getElementById('register-password').value;
    submitAuth('register', username, password);
  });

  // ---------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------
  function connectWebSocket(token, username, silentFail) {
    myAccountName = username;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);

    ws.addEventListener('open', () => {
      setConnStatus(true);
    });

    ws.addEventListener('message', (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }
      handleServerMessage(data, username);
    });

    ws.addEventListener('close', () => {
      setConnStatus(false);
      if (authScreen.classList.contains('hidden') === false && silentFail) {
        // saved session was invalid; clear it quietly and stay on auth screen
        localStorage.removeItem('chatchat_token');
        localStorage.removeItem('chatchat_username');
      }
    });

    ws.addEventListener('error', () => {
      if (silentFail) {
        localStorage.removeItem('chatchat_token');
        localStorage.removeItem('chatchat_username');
      }
    });
  }

  function handleServerMessage(data, fallbackNick) {
    switch (data.type) {
      case 'welcome':
        myNick = data.nick || fallbackNick;
        myIsModerator = !!data.isModerator;
        enterChat();
        appendSystem(data.text, data.ts);
        applyModeratorUI();
        break;
      case 'modstatus':
        myIsModerator = !!data.isModerator;
        applyModeratorUI();
        break;
      case 'error':
        if (chatScreen.classList.contains('hidden')) {
          authError.textContent = data.text;
        } else {
          appendMsg('error', null, data.text, data.ts);
        }
        break;
      case 'system':
        appendSystem(data.text, data.ts, data.channel);
        break;
      case 'chat':
        appendChat(data.from, data.text, data.ts, data.pingTargets, data.avatar, data.channel);
        break;
      case 'action':
        appendAction(data.from, data.text, data.ts, data.avatar, data.channel);
        break;
      case 'whisper':
        appendWhisper(data);
        break;
      case 'nickchange':
        myNick = data.nick;
        promptNick.textContent = `${myNick}>`;
        break;
      case 'userlist':
        renderUserList(data.users);
        break;
      case 'onlineusers':
        onlineUsers = Array.isArray(data.users) ? data.users : [];
        break;
      case 'channel':
        highlightActiveChannel(data.name);
        break;
      case 'channellist':
        renderChannelLists(data);
        break;
      case 'invite':
        appendMsg('invite', null, data.text, data.ts);
        break;
      case 'invites':
        renderInvites(data.invites);
        break;
      case 'modappeals':
        renderModAppeals(data.appeals);
        break;
      case 'reports':
        renderReports(data.reports);
        break;
      case 'modrequests':
        renderModRequests(data.requests);
        break;
      case 'accountdeleted':
        appendSystem(data.text, data.ts);
        localStorage.removeItem('chatchat_token');
        localStorage.removeItem('chatchat_username');
        setTimeout(() => location.reload(), 1500);
        break;
    }
  }

  let currentChannelName = 'main';

  function highlightActiveChannel(name) {
    currentChannelName = name;
    document.querySelectorAll('.channel-list li').forEach((li) => {
      li.classList.toggle('active', li.dataset.name === name);
    });
    log.querySelectorAll('.msg').forEach((el) => {
      const ch = el.dataset.channel;
      el.style.display = (!ch || ch === name) ? '' : 'none';
    });
    scrollToBottom();
  }

  function enterChat() {
    authScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');
    promptNick.textContent = `${myNick}>`;
    msgInput.focus();
  }

  function setConnStatus(online) {
    if (!online && !chatScreen.classList.contains('hidden')) {
      appendSystem('Connection lost.', Date.now());
    }
  }

  function doLogout() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send('/quit');
      ws.close();
    }
    localStorage.removeItem('chatchat_token');
    localStorage.removeItem('chatchat_username');
    location.reload();
  }

  // ---------------------------------------------------------------------
  // Mobile/portrait sidebar popup: the sidebar is hidden by default on
  // narrow screens, opened via the floating menu button, and can be
  // dragged around by its handle bar once open. The menu button itself is
  // also a free-floating, draggable FAB rather than living in a header bar.
  // ---------------------------------------------------------------------
  function openSidebar() {
    sidebarEl.classList.add('open');
  }
  function closeSidebar() {
    sidebarEl.classList.remove('open');
  }
  if (sidebarCloseBtn) {
    sidebarCloseBtn.addEventListener('click', closeSidebar);
  }

  const FAB_POS_KEY = 'chatchat_fab_pos';
  const DRAG_THRESHOLD = 6; // px of movement before a press counts as a drag, not a tap

  function clampFabPosition(left, top) {
    const maxLeft = window.innerWidth - menuToggle.offsetWidth - 8;
    const maxTop = window.innerHeight - menuToggle.offsetHeight - 8;
    return {
      left: Math.min(Math.max(left, 8), Math.max(maxLeft, 8)),
      top: Math.min(Math.max(top, 8), Math.max(maxTop, 8)),
    };
  }

  function placeFab(left, top) {
    const clamped = clampFabPosition(left, top);
    menuToggle.style.left = `${clamped.left}px`;
    menuToggle.style.top = `${clamped.top}px`;
    menuToggle.style.right = 'auto';
    menuToggle.style.bottom = 'auto';
  }

  if (menuToggle) {
    // Restore a remembered position, if any and it's still on-screen-ish.
    try {
      const saved = JSON.parse(localStorage.getItem(FAB_POS_KEY) || 'null');
      if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
        placeFab(saved.left, saved.top);
      }
    } catch { /* ignore a corrupt saved position */ }

    let fabDragging = false;
    let fabMoved = false;
    let fabStartX = 0;
    let fabStartY = 0;
    let fabStartLeft = 0;
    let fabStartTop = 0;

    menuToggle.addEventListener('pointerdown', (e) => {
      fabDragging = true;
      fabMoved = false;
      menuToggle.setPointerCapture(e.pointerId);
      const rect = menuToggle.getBoundingClientRect();
      fabStartX = e.clientX;
      fabStartY = e.clientY;
      fabStartLeft = rect.left;
      fabStartTop = rect.top;
    });

    menuToggle.addEventListener('pointermove', (e) => {
      if (!fabDragging) return;
      const dx = e.clientX - fabStartX;
      const dy = e.clientY - fabStartY;
      if (!fabMoved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        fabMoved = true;
        menuToggle.classList.add('dragging');
      }
      if (fabMoved) {
        placeFab(fabStartLeft + dx, fabStartTop + dy);
      }
    });

    function endFabDrag(e) {
      if (!fabDragging) return;
      fabDragging = false;
      menuToggle.classList.remove('dragging');
      try { menuToggle.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
      if (fabMoved) {
        const rect = menuToggle.getBoundingClientRect();
        localStorage.setItem(FAB_POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
      } else {
        // A tap, not a drag — toggle the sidebar.
        sidebarEl.classList.contains('open') ? closeSidebar() : openSidebar();
      }
    }
    menuToggle.addEventListener('pointerup', endFabDrag);
    menuToggle.addEventListener('pointercancel', endFabDrag);

    window.addEventListener('resize', () => {
      const rect = menuToggle.getBoundingClientRect();
      if (rect.left || rect.top) placeFab(rect.left, rect.top);
    });
  }

  if (sidebarDragHandle && sidebarEl) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    sidebarDragHandle.addEventListener('pointerdown', (e) => {
      if (!sidebarEl.classList.contains('open')) return;
      dragging = true;
      sidebarDragHandle.setPointerCapture(e.pointerId);
      const rect = sidebarEl.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      // Switch from centered/default popup position to an explicit one so
      // dragging can freely move it from wherever it currently sits.
      sidebarEl.style.left = `${startLeft}px`;
      sidebarEl.style.top = `${startTop}px`;
      sidebarEl.style.right = 'auto';
      sidebarEl.style.transform = 'none';
    });

    sidebarDragHandle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const maxLeft = window.innerWidth - sidebarEl.offsetWidth - 8;
      const maxTop = window.innerHeight - sidebarEl.offsetHeight - 8;
      const newLeft = Math.min(Math.max(startLeft + dx, 8), Math.max(maxLeft, 8));
      const newTop = Math.min(Math.max(startTop + dy, 8), Math.max(maxTop, 8));
      sidebarEl.style.left = `${newLeft}px`;
      sidebarEl.style.top = `${newTop}px`;
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      try { sidebarDragHandle.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
    }
    sidebarDragHandle.addEventListener('pointerup', endDrag);
    sidebarDragHandle.addEventListener('pointercancel', endDrag);
  }

  // ---------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // Client-side muting. These never touch the server — they only affect
  // what you see on your own screen, keyed by nickname.
  // ---------------------------------------------------------------------
  let mutedUsers = new Set();
  try {
    mutedUsers = new Set(JSON.parse(localStorage.getItem('chatchat_muted') || '[]'));
  } catch { mutedUsers = new Set(); }

  function saveMuted() {
    localStorage.setItem('chatchat_muted', JSON.stringify([...mutedUsers]));
  }

  function isMuted(nick) {
    return !!nick && mutedUsers.has(nick.toLowerCase());
  }

  // ---------------------------------------------------------------------
  // Report message selection: click the flag on up to 5 messages, then
  // /report <user> <reason> attaches whichever of them were from that user.
  // Cleared after a report is filed. Not persisted — it's just a scratch
  // selection for the current session.
  // ---------------------------------------------------------------------
  const MAX_REPORT_SELECTION = 5;
  let reportSelection = []; // [{ from, text, ts, row }]

  const reportSelectionBar = document.getElementById('report-selection-bar');
  const reportSelectionCount = document.getElementById('report-selection-count');
  const reportSelectionClear = document.getElementById('report-selection-clear');

  function updateReportSelectionBar() {
    if (!reportSelectionBar) return;
    reportSelectionBar.classList.toggle('hidden', reportSelection.length === 0);
    if (reportSelectionCount) reportSelectionCount.textContent = String(reportSelection.length);
  }

  function clearReportSelection() {
    reportSelection.forEach((entry) => entry.row && entry.row.classList.remove('selected-for-report'));
    reportSelection = [];
    updateReportSelectionBar();
  }

  if (reportSelectionClear) {
    reportSelectionClear.addEventListener('click', clearReportSelection);
  }

  function toggleReportSelection(row, from, text, ts) {
    const idx = reportSelection.findIndex((e) => e.row === row);
    if (idx !== -1) {
      reportSelection.splice(idx, 1);
      row.classList.remove('selected-for-report');
      updateReportSelectionBar();
      return;
    }
    if (reportSelection.length >= MAX_REPORT_SELECTION) {
      appendSystem(`You can only select up to ${MAX_REPORT_SELECTION} messages at once.`, Date.now());
      return;
    }
    reportSelection.push({ from, text, ts, row });
    row.classList.add('selected-for-report');
    updateReportSelectionBar();
  }

  function reportFlagButton(from, text, ts) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'report-select-btn';
    btn.title = 'Select for report';
    btn.textContent = '⚑';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = btn.closest('.msg');
      if (row) toggleReportSelection(row, from, text, ts);
    });
    return btn;
  }

  // ---------------------------------------------------------------------
  // Client-side profanity filter ("/ff"). Also never touches the chat
  // server directly — it calls a small Cloudflare Worker proxy in front of
  // vector.profanity.dev, and only affects what renders on your own screen.
  // ---------------------------------------------------------------------
  const PROFANITY_WORKER_URL = 'https://chatchatprofanity.daniel-torres-a95.workers.dev/';
  const FF_STORAGE_KEY = 'chatchat_ff';
  let profanityFilterOn = localStorage.getItem(FF_STORAGE_KEY) === '1';

  async function checkProfanity(text) {
    try {
      const res = await fetch(PROFANITY_WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) return false; // fail open — don't block chat if the checker is down
      const data = await res.json();
      // vector.profanity.dev returns { isProfanity: bool, score, flaggedFor }.
      // Checked defensively in case a future version renames the field.
      return !!(data.isProfanity ?? data.has_profanity);
    } catch {
      return false; // fail open
    }
  }

  // Fills `el` with either the message right away (filter off), or a
  // "checking..." placeholder that resolves into either the real message or
  // a click-to-reveal "hidden" placeholder once the profanity check returns.
  function applyFilterableText(el, rawText, safeHtml) {
    if (!el) return;
    if (!profanityFilterOn) {
      el.innerHTML = safeHtml;
      return;
    }
    el.innerHTML = '';
    const pending = document.createElement('span');
    pending.className = 'ff-pending';
    pending.textContent = 'checking…';
    el.appendChild(pending);

    checkProfanity(rawText).then((flagged) => {
      if (!pending.isConnected) return;
      if (flagged) {
        const hidden = document.createElement('span');
        hidden.className = 'ff-hidden';
        hidden.tabIndex = 0;
        hidden.textContent = 'Message hidden by the profanity filter — click to unhide';
        hidden.addEventListener('click', () => { hidden.outerHTML = safeHtml; }, { once: true });
        hidden.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hidden.click(); }
        });
        pending.replaceWith(hidden);
      } else {
        pending.outerHTML = safeHtml;
      }
    });
  }

  // Returns true if the command was a local mute command and has been fully handled.
  function handleLocalCommand(rawText) {
    const parts = rawText.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === '/logout') {
      doLogout();
      return true;
    }
    if (cmd === '/mute') {
      const target = parts[1];
      if (!target) {
        appendSystem('Usage: /mute <user>', Date.now());
      } else {
        mutedUsers.add(target.toLowerCase());
        saveMuted();
        appendSystem(`Muted ${target}. Their messages are hidden on your screen only.`, Date.now());
      }
      return true;
    }
    if (cmd === '/unmute') {
      const target = parts[1];
      if (!target) {
        appendSystem('Usage: /unmute <user>', Date.now());
      } else if (mutedUsers.delete(target.toLowerCase())) {
        saveMuted();
        appendSystem(`Unmuted ${target}.`, Date.now());
      } else {
        appendSystem(`${target} wasn't muted.`, Date.now());
      }
      return true;
    }
    if (cmd === '/mlist') {
      if (!mutedUsers.size) {
        appendSystem("You haven't muted anyone.", Date.now());
      } else {
        appendSystem(`Muted (visible only to you): ${[...mutedUsers].join(', ')}`, Date.now());
      }
      return true;
    }
    if (cmd === '/ff') {
      profanityFilterOn = !profanityFilterOn;
      localStorage.setItem(FF_STORAGE_KEY, profanityFilterOn ? '1' : '0');
      appendSystem(
        profanityFilterOn
          ? 'Profanity filter on — new messages are checked and hidden behind a click-to-reveal if flagged. Run /ff again to turn it off.'
          : 'Profanity filter off. Messages already hidden stay hidden until you click them.',
        Date.now()
      );
      return true;
    }
    if (cmd === '/silence') {
      const target = parts[1];
      const durationArg = (parts[2] || '').toLowerCase();
      // Mode is optional — only treat parts[3] as it if it's actually c/nc,
      // matching the server's own flexible parsing (a reason may follow
      // instead, or right after the duration if mode was skipped).
      const modeArg = /^(c|nc)$/i.test(parts[3] || '') ? parts[3].toLowerCase() : '';
      if (!target) {
        appendSystem('Usage: /silence <user> [seconds|perm] [c|nc] [reason]', Date.now());
        return true;
      }

      if (myIsModerator && modeArg === 'c') {
        const permanent = durationArg === 'perm';
        const seconds = permanent ? null : parseInt(durationArg, 10);
        mutedUsers.add(target.toLowerCase());
        saveMuted();
        const span = permanent ? ' indefinitely' : (seconds > 0 ? ` for ${seconds}s` : '');
        appendSystem(`(client) Muted ${target} on your screen only${span}.`, Date.now());
        if (!permanent && seconds > 0) {
          setTimeout(() => {
            if (mutedUsers.delete(target.toLowerCase())) {
              saveMuted();
              appendSystem(`${target} is unmuted on your screen (timer expired).`, Date.now());
            }
          }, seconds * 1000);
        }
        return true;
      }
      if (myIsModerator) {
        // nc (or unspecified, which defaults to nc server-side) — a real
        // silence, which only the server can verify and enforce.
        return false;
      }
      // Not a moderator: /silence is just an alias for a personal mute.
      mutedUsers.add(target.toLowerCase());
      saveMuted();
      appendSystem(`Muted ${target}. Their messages are hidden on your screen only.`, Date.now());
      return true;
    }
    if (cmd === '/unsilence') {
      const target = parts[1];
      if (!target) {
        appendSystem('Usage: /unsilence <user>', Date.now());
        return true;
      }
      const wasMuted = mutedUsers.delete(target.toLowerCase());
      if (wasMuted) {
        saveMuted();
        appendSystem(`Unmuted ${target} on your screen.`, Date.now());
      }
      if (myIsModerator) {
        // Also forward to the server in case a real silence needs lifting.
        return false;
      }
      if (!wasMuted) appendSystem(`${target} wasn't muted.`, Date.now());
      return true;
    }
    if (cmd === '/report') {
      const targetsRaw = parts[1];
      const reason = rawText.trim().split(/\s+/).slice(2).join(' ').trim();
      if (!targetsRaw || !reason) {
        appendSystem('Usage: /report <user1[,user2,user3]> <reason> — select up to 5 of their messages in the log first if you want.', Date.now());
        return true;
      }
      const targets = targetsRaw.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 3);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        appendSystem('Not connected.', Date.now());
        return true;
      }
      const lowerTargets = targets.map((t) => t.toLowerCase());
      const messages = reportSelection
        .filter((m) => lowerTargets.includes(m.from.toLowerCase()))
        .slice(0, MAX_REPORT_SELECTION)
        .map((m) => ({ from: m.from, text: m.text, ts: m.ts }));
      ws.send(JSON.stringify({ type: 'report', targets, reason, messages }));
      clearReportSelection();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // Command-argument autocomplete: while typing a command, suggest
  // usernames (closest match to what's typed, from everyone currently
  // online), channel names, or a fixed set of options for params that have
  // one (like /silence's c|nc, or /delete's acc|chnl).
  // ---------------------------------------------------------------------
  const CMD_ARG_SPECS = {
    '/nick': [{ t: 'text' }],
    '/me': [{ t: 'text', rest: true }],
    '/msg': [{ t: 'user' }, { t: 'text', rest: true }],
    '/w': [{ t: 'user' }, { t: 'text', rest: true }],
    '/create': [{ t: 'text' }],
    '/join': [{ t: 'channel' }],
    '/invite': [{ t: 'user' }, { t: 'channel' }],
    '/accept': [{ t: 'channel' }],
    '/decline': [{ t: 'channel' }],
    '/pfp': [{ t: 'enum', options: ['none'] }],
    '/avatar': [{ t: 'enum', options: ['none'] }],
    '/blockinvites': [{ t: 'user' }],
    '/unblockinvites': [{ t: 'user' }],
    '/mute': [{ t: 'user' }],
    '/unmute': [{ t: 'user' }],
    '/silence': [{ t: 'user' }, { t: 'enum', options: ['perm'] }, { t: 'enum', options: ['c', 'nc'] }, { t: 'text', rest: true }],
    '/unsilence': [{ t: 'user' }],
    '/appeal': [{ t: 'text', rest: true }],
    '/report': [{ t: 'userlist' }, { t: 'text', rest: true }],
    '/reportclear': [{ t: 'text' }],
    '/addmod': [{ t: 'user' }],
    '/removemod': [{ t: 'user' }],
    '/requestmod': [{ t: 'user' }],
    '/requestunmod': [{ t: 'user' }],
    '/modreqaccept': [{ t: 'user' }],
    '/modreqdecline': [{ t: 'user' }],
    '/modaccept': [{ t: 'user' }],
    '/moddecline': [{ t: 'user' }],
    '/whowas': [{ t: 'user' }],
    '/delete': [{ t: 'enum', options: ['acc', 'chnl'] }, { t: 'text' }],
  };
  const MAX_AC_SUGGESTIONS = 8;

  let acItems = [];
  let acSelected = -1;
  let acRange = { start: 0, end: 0 };

  function closeAutocomplete() {
    acItems = [];
    acSelected = -1;
    if (autocompleteList) {
      autocompleteList.classList.add('hidden');
      autocompleteList.innerHTML = '';
    }
  }

  function rankMatches(candidates, query) {
    if (!query) return candidates.slice(0, MAX_AC_SUGGESTIONS);
    const q = query.toLowerCase();
    const starts = candidates.filter((c) => c.toLowerCase().startsWith(q));
    const contains = candidates.filter((c) => !c.toLowerCase().startsWith(q) && c.toLowerCase().includes(q));
    return [...starts, ...contains].slice(0, MAX_AC_SUGGESTIONS);
  }

  // Figures out, from the text and cursor position, which command argument
  // (if any) is currently being typed, and what to suggest for it.
  // Suggests online users while typing "@" in a plain chat message (not a
  // slash command) — same ranked-match behavior as command arguments, just
  // triggered by "@" instead of an argument position, and the "@" stays
  // part of both the query and the inserted suggestion.
  function getMentionAutocompleteContext(beforeCursor) {
    const tokens = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(beforeCursor))) tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    if (!tokens.length) return null;
    const lastTok = tokens[tokens.length - 1];
    if (beforeCursor.length !== lastTok.end) return null; // cursor isn't at the end of the last token
    if (!lastTok.text.startsWith('@') || lastTok.text.length < 1) return null;

    const partial = lastTok.text.slice(1);
    const items = rankMatches(onlineUsers, partial).map((u) => `@${u}`);
    if (!items.length) return null;
    return { items, replaceStart: lastTok.start, replaceEnd: lastTok.end };
  }

  function getAutocompleteContext() {
    const text = msgInput.value;
    const cursor = msgInput.selectionStart;
    const beforeCursor = text.slice(0, cursor);

    if (!text.startsWith('/')) return getMentionAutocompleteContext(beforeCursor);

    const tokens = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(beforeCursor))) tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    if (!tokens.length) return null;

    const spec = CMD_ARG_SPECS[tokens[0].text.toLowerCase()];
    if (!spec) return null;

    const trailingSpace = /\s$/.test(beforeCursor);
    const lastTok = tokens[tokens.length - 1];
    let argIndex, partial, replaceStart, replaceEnd;

    if (trailingSpace) {
      argIndex = tokens.length - 1;
      partial = '';
      replaceStart = cursor;
      replaceEnd = cursor;
    } else if (tokens.length >= 2 && cursor === lastTok.end) {
      argIndex = tokens.length - 2;
      partial = lastTok.text;
      replaceStart = lastTok.start;
      replaceEnd = lastTok.end;
    } else {
      return null; // still typing the command name, or cursor is mid-token earlier in the line
    }

    const argSpec = spec[argIndex];
    if (!argSpec || argSpec.t === 'text') return null;

    // For a comma-separated user list (only /report today), only complete
    // the sub-token after the last comma.
    let subPartial = partial;
    let subReplaceStart = replaceStart;
    if (argSpec.t === 'userlist') {
      const lastComma = partial.lastIndexOf(',');
      if (lastComma !== -1) {
        subPartial = partial.slice(lastComma + 1);
        subReplaceStart = replaceStart + lastComma + 1;
      }
    }

    let candidates = [];
    if (argSpec.t === 'user' || argSpec.t === 'userlist') candidates = onlineUsers;
    else if (argSpec.t === 'channel') candidates = knownChannels;
    else if (argSpec.t === 'enum') candidates = argSpec.options;

    const items = rankMatches(candidates, subPartial);
    if (!items.length) return null;
    return { items, replaceStart: subReplaceStart, replaceEnd };
  }

  function renderAutocomplete() {
    if (!autocompleteList) return;
    autocompleteList.innerHTML = '';
    acItems.forEach((item, i) => {
      const div = document.createElement('div');
      div.className = 'autocomplete-item' + (i === acSelected ? ' selected' : '');
      div.textContent = item;
      div.addEventListener('mousedown', (e) => {
        e.preventDefault(); // don't let the input lose focus before we apply it
        applyAutocomplete(i);
      });
      autocompleteList.appendChild(div);
    });
    autocompleteList.classList.toggle('hidden', acItems.length === 0);
  }

  function applyAutocomplete(index) {
    const item = acItems[index];
    if (!item) return;
    const val = msgInput.value;
    const before = val.slice(0, acRange.start);
    const after = val.slice(acRange.end).replace(/^\s+/, '');
    const newVal = `${before}${item} ${after}`;
    msgInput.value = newVal;
    const newCursor = (before + item + ' ').length;
    msgInput.focus();
    msgInput.setSelectionRange(newCursor, newCursor);
    closeAutocomplete();
    updateAutocomplete();
  }

  function updateAutocomplete() {
    const ctx = getAutocompleteContext();
    if (!ctx) {
      closeAutocomplete();
      return;
    }
    acItems = ctx.items;
    acRange = { start: ctx.replaceStart, end: ctx.replaceEnd };
    acSelected = 0;
    renderAutocomplete();
  }

  msgInput.addEventListener('input', updateAutocomplete);
  msgInput.addEventListener('click', updateAutocomplete);
  msgInput.addEventListener('blur', closeAutocomplete);

  sendForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = msgInput.value;
    if (!text.trim()) return;
    closeAutocomplete();
    if (!handleLocalCommand(text)) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(text);
      }
    }
    history.push(text);
    historyIdx = history.length;
    msgInput.value = '';
  });

  msgInput.addEventListener('keydown', (e) => {
    if (acItems.length) {
      if (e.key === 'ArrowDown') {
        acSelected = (acSelected + 1) % acItems.length;
        renderAutocomplete();
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowUp') {
        acSelected = (acSelected - 1 + acItems.length) % acItems.length;
        renderAutocomplete();
        e.preventDefault();
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        if (acSelected >= 0) {
          e.preventDefault();
          applyAutocomplete(acSelected);
          return;
        }
      }
      if (e.key === 'Escape') {
        closeAutocomplete();
        e.preventDefault();
        return;
      }
    }

    if (e.key === 'ArrowUp') {
      if (historyIdx > 0) {
        historyIdx--;
        msgInput.value = history[historyIdx] || '';
        requestAnimationFrame(() => msgInput.setSelectionRange(msgInput.value.length, msgInput.value.length));
      }
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      if (historyIdx < history.length) {
        historyIdx++;
        msgInput.value = history[historyIdx] || '';
      }
      e.preventDefault();
    }
  });

  // ---------------------------------------------------------------------
  // Rendering helpers
  // ---------------------------------------------------------------------
  const NICK_COLOR_CLASSES = ['nick-c0', 'nick-c1', 'nick-c2', 'nick-c3', 'nick-c4', 'nick-c5'];

  function colorFor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return NICK_COLOR_CLASSES[h % NICK_COLOR_CLASSES.length];
  }

  function timeStr(ts) {
    const d = ts ? new Date(ts) : new Date();
    return d.toTimeString().slice(0, 5);
  }

  function scrollToBottom() {
    log.scrollTop = log.scrollHeight;
  }

  function appendRow(row, channelName) {
    if (channelName) row.dataset.channel = channelName;
    log.appendChild(row);
    scrollToBottom();
  }

  function avatarTag(url, size) {
    if (!url) return '';
    const frameCls = size === 'sm' ? 'avatar-frame avatar-frame-sm' : 'avatar-frame';
    return `<span class="${frameCls}"><img class="avatar-img" src="${escapeHtml(url)}" alt="" onerror="this.parentElement.remove()"></span>`;
  }

  // Runs on already-HTML-escaped text, so this only ever adds tags around
  // content — it can't reopen any HTML the escaping just closed off. Code
  // spans are processed first so markdown characters inside them are left
  // alone; links are restricted to http(s) to keep href values inert.
  function renderMarkdown(escapedText) {
    let out = escapedText;
    out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    out = out.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    out = out.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');
    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return out;
  }

  function highlightMentions(escapedText, targets) {
    if (!Array.isArray(targets) || !targets.length) return escapedText;
    let out = escapedText;
    targets.forEach((t) => {
      const esc = String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`@${esc}\\b`, 'gi');
      out = out.replace(re, `<span class="mention">@${escapeHtml(t)}</span>`);
    });
    return out;
  }

  function appendSystem(text, ts, channel) {
    appendMsg('system', null, text, ts, channel);
  }

  function appendChat(from, text, ts, pingTargets, avatar, channel) {
    if (isMuted(from)) return;
    const hasPing = Array.isArray(pingTargets) && pingTargets.length > 0;
    const mineTargeted = hasPing && myNick && pingTargets.some((t) => t.toLowerCase() === myNick.toLowerCase());
    const row = document.createElement('div');
    row.className = 'msg' + (hasPing ? ' ping' : '') + (mineTargeted ? ' mine' : '');
    const color = colorFor(from);
    let body = renderMarkdown(escapeHtml(text));
    if (hasPing) body = highlightMentions(body, pingTargets);
    row.innerHTML =
      `<span class="t">${timeStr(ts)}</span>` +
      `<span class="body">${avatarTag(avatar, 'sm')}<span class="nick ${color}">${escapeHtml(from)}</span> <span class="msg-text"></span></span>`;
    applyFilterableText(row.querySelector('.msg-text'), text, body);
    if (from !== myNick) row.querySelector('.body').appendChild(reportFlagButton(from, text, ts));
    appendRow(row, channel);
  }

  function appendAction(from, text, ts, avatar, channel) {
    if (isMuted(from)) return;
    const row = document.createElement('div');
    row.className = 'msg action';
    const color = colorFor(from);
    row.innerHTML =
      `<span class="t">${timeStr(ts)}</span>` +
      `<span class="body">${avatarTag(avatar, 'sm')}* <span class="nick ${color}">${escapeHtml(from)}</span> <span class="msg-text"></span></span>`;
    applyFilterableText(row.querySelector('.msg-text'), text, renderMarkdown(escapeHtml(text)));
    if (from !== myNick) row.querySelector('.body').appendChild(reportFlagButton(from, text, ts));
    appendRow(row, channel);
  }

  function appendWhisper(data) {
    if (!data.self && isMuted(data.from)) return;
    const row = document.createElement('div');
    row.className = 'msg whisper';
    const otherParty = data.self ? data.to : data.from;
    const tag = data.self ? `to ${otherParty}` : `from ${otherParty}`;
    row.innerHTML =
      `<span class="t">${timeStr(data.ts)}</span>` +
      `<span class="body">${avatarTag(data.avatar, 'sm')}<span class="tag">[whisper ${escapeHtml(tag)}]</span><span class="msg-text"></span></span>`;
    applyFilterableText(row.querySelector('.msg-text'), data.text, renderMarkdown(escapeHtml(data.text)));
    appendRow(row);
  }

  function renderInvites(invites) {
    inviteList.innerHTML = '';
    inviteCount.textContent = invites.length ? `(${invites.length})` : '';
    if (!invites.length) {
      const empty = document.createElement('li');
      empty.className = 'invite-empty';
      empty.textContent = 'No pending invites.';
      inviteList.appendChild(empty);
      return;
    }
    invites.forEach((inv) => {
      const li = document.createElement('li');
      const meta = document.createElement('div');
      meta.className = 'invite-meta';
      meta.innerHTML = `<span class="ch">#${escapeHtml(inv.channel)}</span> — invited by ${escapeHtml(inv.inviter)}` +
        (inv.creator !== inv.inviter ? ` (made by ${escapeHtml(inv.creator)})` : '');
      const actions = document.createElement('div');
      actions.className = 'invite-actions';
      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'accept-btn';
      acceptBtn.textContent = 'accept';
      acceptBtn.addEventListener('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(`/accept ${inv.channel}`);
      });
      const declineBtn = document.createElement('button');
      declineBtn.className = 'decline-btn';
      declineBtn.textContent = 'decline';
      declineBtn.addEventListener('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(`/decline ${inv.channel}`);
      });
      actions.appendChild(acceptBtn);
      actions.appendChild(declineBtn);
      li.appendChild(meta);
      li.appendChild(actions);
      inviteList.appendChild(li);
    });
  }

  function renderModAppeals(appeals) {
    if (!modAppealsList) return;
    modAppealsList.innerHTML = '';
    if (!appeals || !appeals.length) {
      const empty = document.createElement('li');
      empty.className = 'invite-empty';
      empty.textContent = 'No pending appeals.';
      modAppealsList.appendChild(empty);
      return;
    }
    appeals.forEach((a) => {
      const li = document.createElement('li');
      const meta = document.createElement('div');
      meta.className = 'invite-meta';
      const texts = a.appeals.map((one) => `“${escapeHtml(one.text)}”`).join(' / ');
      const when = a.permanent ? 'permanent' : `${Math.max(a.remainingSeconds, 0)}s left`;
      const reasonPart = a.reason ? ` — reason: "${escapeHtml(a.reason)}"` : '';
      meta.innerHTML = `<span class="ch">${escapeHtml(a.target)}</span> — ${when}${reasonPart}, ` +
        `appeal ${a.appealsUsed}/${a.appealsMax}: ${texts}`;
      const actions = document.createElement('div');
      actions.className = 'invite-actions';
      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'accept-btn';
      acceptBtn.textContent = 'accept';
      acceptBtn.addEventListener('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(`/modaccept ${a.target}`);
      });
      const declineBtn = document.createElement('button');
      declineBtn.className = 'decline-btn';
      declineBtn.textContent = 'decline';
      declineBtn.addEventListener('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(`/moddecline ${a.target}`);
      });
      actions.appendChild(acceptBtn);
      actions.appendChild(declineBtn);
      li.appendChild(meta);
      li.appendChild(actions);
      modAppealsList.appendChild(li);
    });
  }

  function renderReports(reportsData) {
    if (!reportsList) return;
    reportsList.innerHTML = '';
    if (!reportsData || !reportsData.length) {
      const empty = document.createElement('li');
      empty.className = 'invite-empty';
      empty.textContent = 'No reports.';
      reportsList.appendChild(empty);
      return;
    }
    reportsData.forEach((r) => {
      const li = document.createElement('li');
      const meta = document.createElement('div');
      meta.className = 'invite-meta';
      const targets = r.targets.map((t) => escapeHtml(t)).join(', ');
      let html = `<span class="ch">${targets}</span> — reported by ${escapeHtml(r.reporter)}: "${escapeHtml(r.reason)}"`;
      if (r.messages && r.messages.length) {
        html += '<div class="report-evidence">' + r.messages.map((m) =>
          `<div>${escapeHtml(m.from)}: ${escapeHtml(m.text)}</div>`
        ).join('') + '</div>';
      }
      meta.innerHTML = html;
      const actions = document.createElement('div');
      actions.className = 'invite-actions';
      const clearBtn = document.createElement('button');
      clearBtn.className = 'decline-btn';
      clearBtn.textContent = 'clear';
      clearBtn.addEventListener('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(`/reportclear ${r.id}`);
      });
      actions.appendChild(clearBtn);
      li.appendChild(meta);
      li.appendChild(actions);
      reportsList.appendChild(li);
    });
  }

  function renderModRequests(requests) {
    if (!modRequestsList) return;
    modRequestsList.innerHTML = '';
    if (!requests || !requests.length) {
      const empty = document.createElement('li');
      empty.className = 'invite-empty';
      empty.textContent = 'No pending mod requests.';
      modRequestsList.appendChild(empty);
      return;
    }
    requests.forEach((r) => {
      const li = document.createElement('li');
      const meta = document.createElement('div');
      meta.className = 'invite-meta';
      meta.innerHTML = `<span class="ch">${escapeHtml(r.target)}</span> — ${r.type === 'add' ? 'add as mod' : 'remove as mod'}, requested by ${escapeHtml(r.requestedBy)}`;
      const actions = document.createElement('div');
      actions.className = 'invite-actions';
      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'accept-btn';
      acceptBtn.textContent = 'approve';
      acceptBtn.addEventListener('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(`/modreqaccept ${r.target}`);
      });
      const declineBtn = document.createElement('button');
      declineBtn.className = 'decline-btn';
      declineBtn.textContent = 'reject';
      declineBtn.addEventListener('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(`/modreqdecline ${r.target}`);
      });
      actions.appendChild(acceptBtn);
      actions.appendChild(declineBtn);
      li.appendChild(meta);
      li.appendChild(actions);
      modRequestsList.appendChild(li);
    });
  }

  function renderChannelLists(data) {
    if (totalOnlineEl) totalOnlineEl.textContent = data.totalOnline ?? 0;
    knownChannels = [...data.public.map((c) => c.name), ...data.private.map((c) => c.name)];

    publicChannelList.innerHTML = '';
    data.public.forEach((c) => {
      const li = document.createElement('li');
      li.dataset.name = c.name;
      li.innerHTML = `<span>#${escapeHtml(c.name)}</span><span class="count">${c.count}</span>`;
      li.addEventListener('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(`/join ${c.name}`);
        closeSidebar();
      });
      if (c.name === data.current) li.classList.add('active');
      publicChannelList.appendChild(li);
    });

    privateChannelList.innerHTML = '';
    if (data.private.length) {
      privateChannelWrap.classList.remove('hidden');
      data.private.forEach((c) => {
        const li = document.createElement('li');
        li.className = 'private-item';
        li.dataset.name = c.name;
        li.innerHTML = `<span>#${escapeHtml(c.name)}</span><span class="count">${c.count}</span>`;
        li.title = `created by ${c.creator}`;
        li.addEventListener('click', () => {
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(`/join ${c.name}`);
          closeSidebar();
        });
        if (c.name === data.current) li.classList.add('active');
        privateChannelList.appendChild(li);
      });
    } else {
      privateChannelWrap.classList.add('hidden');
    }
  }

  function appendMsg(kind, nick, text, ts, channel) {
    const row = document.createElement('div');
    row.className = `msg ${kind}`;
    row.innerHTML =
      `<span class="t">${timeStr(ts)}</span>` +
      `<span class="body">${escapeHtml(text)}</span>`;
    appendRow(row, channel);
  }

  function renderUserList(users) {
    userList.innerHTML = '';
    userCount.textContent = `(${users.length})`;
    users.forEach((u) => {
      const li = document.createElement('li');
      li.innerHTML = `${avatarTag(u.avatar, 'sm')}<span class="${colorFor(u.nick)}">${escapeHtml(u.nick)}</span>`;
      userList.appendChild(li);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();
