(function () {
  'use strict';

  const MSG_SOURCE = 'deepseek-stream-capture';
  const STORAGE_KEY = 'dsc_last_capture';
  const ARCHIVE_KEY = 'dsc_message_archive';
  const REFUSAL_SNIPPET = 'beyond my current scope';
  const MAX_MESSAGES_PER_CHAT = 40;

  let lastCapture = null;
  let panelOpen = false;
  let dockPhase = 'starting'; // starting | ready | live | filtered
  let toastTimer = null;
  let inlineCopyScheduled = false;
  let chatCapturesByKey = {};
  let archiveApplyTimer = null;
  let archiveReapplyInterval = null;
  let lastPathname = location.pathname;
  ensureRoot();
  ensureDock();

  function ensureRoot() {
    if (document.getElementById('dsc-root')) return;
    const root = document.createElement('div');
    root.id = 'dsc-root';
    document.documentElement.appendChild(root);
  }

  function getRoot() {
    return document.getElementById('dsc-root');
  }

  function copyText(text) {
    if (!text) return;
    navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    });
  }

  function formatAll(capture) {
    const parts = [];
    if (capture.think) parts.push('=== Thinking ===\n' + capture.think);
    if (capture.response) parts.push('=== Response (streamed) ===\n' + capture.response);
    return parts.join('\n\n');
  }

  function formatCount(n) {
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
    return String(n);
  }

  function getChatId() {
    const m = location.pathname.match(/\/a\/chat\/s\/([^/?#]+)/);
    return m ? m[1] : location.pathname;
  }

  function resolveMessageKey(capture) {
    if (!capture) return null;
    if (capture.messageKey) return capture.messageKey;
    if (capture.messageId) return String(capture.messageId);
    if (capture.requestId) return 'req:' + capture.requestId;
    return null;
  }

  function captureForStorage(capture) {
    const chatId = getChatId();
    const messageKey = resolveMessageKey(capture) || 'stream:' + (capture.at || Date.now());
    return {
      think: capture.think || '',
      response: capture.response || '',
      filtered: !!capture.filtered,
      at: capture.at || Date.now(),
      chatId,
      chatPath: location.pathname,
      messageKey,
      messageId: capture.messageId || null,
      requestId: capture.requestId || null,
      savedAt: Date.now(),
    };
  }

  function pruneChatBucket(bucket) {
    const keys = Object.keys(bucket);
    if (keys.length <= MAX_MESSAGES_PER_CHAT) return bucket;
    keys.sort((a, b) => (bucket[a].savedAt || 0) - (bucket[b].savedAt || 0));
    const next = {};
    keys.slice(-MAX_MESSAGES_PER_CHAT).forEach((k) => {
      next[k] = bucket[k];
    });
    return next;
  }

  function saveToMessageArchive(capture) {
    if (capture.live || capture.preview) return;
    const entry = captureForStorage(capture);
    chrome.storage.local.get(ARCHIVE_KEY, (result) => {
      const archive = result[ARCHIVE_KEY] || {};
      const chatId = entry.chatId;
      if (!archive[chatId]) archive[chatId] = {};
      archive[chatId][entry.messageKey] = entry;
      archive[chatId] = pruneChatBucket(archive[chatId]);
      chrome.storage.local.set({ [ARCHIVE_KEY]: archive }, () => {
        chatCapturesByKey = archive[chatId] || {};
        scheduleApplyArchiveInlines();
      });
    });
  }

  function loadMessageArchiveForCurrentChat(callback) {
    const chatId = getChatId();
    chrome.storage.local.get([ARCHIVE_KEY, STORAGE_KEY], (result) => {
      const archive = result[ARCHIVE_KEY] || {};
      chatCapturesByKey = archive[chatId] || {};
      const last = result[STORAGE_KEY];
      if (last && last.chatPath === location.pathname && (last.think || last.response)) {
        const entry = captureForStorage(last);
        if (!chatCapturesByKey[entry.messageKey]) {
          if (!archive[chatId]) archive[chatId] = {};
          archive[chatId][entry.messageKey] = entry;
          archive[chatId] = pruneChatBucket(archive[chatId]);
          chatCapturesByKey = archive[chatId];
          chrome.storage.local.set({ [ARCHIVE_KEY]: archive }, () => {
            if (callback) callback();
          });
          return;
        }
      }
      if (callback) callback();
    });
  }

  function findMessageIdNear(el) {
    let node = el;
    for (let depth = 0; depth < 10 && node; depth++) {
      if (node.getAttribute) {
        for (const attr of ['data-message-id', 'data-msg-id', 'data-messageid', 'data-id']) {
          const v = node.getAttribute(attr);
          if (v && /^[\w-]{8,64}$/.test(v)) return v;
        }
        const id = node.id || '';
        if (/message/i.test(id) && id.length >= 8 && id.length <= 80) return id;
      }
      node = node.parentElement;
    }
    return null;
  }

  function findRefusalMessageElements() {
    const out = [];
    const seen = new Set();
    const nodes = document.querySelectorAll('div, p, span, article');
    for (const el of nodes) {
      if (el.closest('#dsc-root') || el.closest('.dsc-inline-wrap')) continue;
      if (el.children.length > 12) continue;
      const text = (el.textContent || '').trim();
      if (!text.includes(REFUSAL_SNIPPET)) continue;
      if (text.length > 400) continue;
      const root = el.closest('[class*="message"]') || el;
      if (seen.has(root)) continue;
      seen.add(root);
      out.push(root);
    }
    return out;
  }

  function getCaptureForElement(el, refusalIndex, filteredList) {
    const id = findMessageIdNear(el);
    if (id && chatCapturesByKey[id]) return chatCapturesByKey[id];
    for (const key of Object.keys(chatCapturesByKey)) {
      const c = chatCapturesByKey[key];
      if (c.messageId && id && c.messageId === id) return c;
    }
    if (filteredList[refusalIndex]) return filteredList[refusalIndex];
    return null;
  }

  function bindLatestCaptureToDom(capture) {
    setTimeout(() => {
      const refusals = findRefusalMessageElements();
      if (!refusals.length) return;
      const el = refusals[refusals.length - 1];
      const domId = findMessageIdNear(el);
      if (!domId) return;
      if (capture.messageId === domId) return;
      const updated = Object.assign({}, capture, { messageId: domId, messageKey: domId });
      saveToMessageArchive(updated);
      if (lastCapture && lastCapture.at === capture.at) {
        lastCapture = updated;
      }
    }, 900);
  }

  function injectInlineForCapture(el, capture) {
    if (!capture) return;
    const key = capture.messageKey || resolveMessageKey(capture) || '';
    if (key) {
      const esc = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      if (document.querySelector('.dsc-inline-wrap[data-dsc-key="' + esc + '"]')) return;
    }
    if (el.nextElementSibling?.classList?.contains('dsc-inline-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'dsc-inline-wrap';
    wrap.setAttribute('data-dsc-key', key || '');
    wrap.innerHTML =
      '<p class="dsc-inline-notice">Recovered stream saved for this message (persists in this browser).</p>' +
      '<button type="button" class="dsc-inline-copy">Copy recovered text</button>' +
      '<button type="button" class="dsc-inline-view">Open panel</button>';
    wrap.querySelector('.dsc-inline-copy').addEventListener('click', (e) => {
      e.stopPropagation();
      copyText(formatAll(capture));
      showToast('Copied recovered text', 'success');
    });
    wrap.querySelector('.dsc-inline-view').addEventListener('click', (e) => {
      e.stopPropagation();
      lastCapture = capture;
      openPanel(capture);
    });
    el.insertAdjacentElement('afterend', wrap);
  }

  function applyArchiveInlines() {
    const keys = Object.keys(chatCapturesByKey);
    if (!keys.length) return;

    const filteredList = keys
      .map((k) => chatCapturesByKey[k])
      .filter((c) => c.filtered && (c.think || c.response))
      .sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));

    const refusals = findRefusalMessageElements();
    refusals.forEach((el, index) => {
      const cap = getCaptureForElement(el, index, filteredList);
      if (cap) injectInlineForCapture(el, cap);
    });
  }

  function scheduleApplyArchiveInlines() {
    clearTimeout(archiveApplyTimer);
    archiveApplyTimer = setTimeout(applyArchiveInlines, 800);
    ensureArchiveReapplyLoop();
  }

  /** DeepSeek re-renders messages and drops our inline nodes; re-attach gently on a timer. */
  function ensureArchiveReapplyLoop() {
    if (archiveReapplyInterval) return;
    archiveReapplyInterval = setInterval(() => {
      const hasFiltered = Object.keys(chatCapturesByKey).some(
        (k) => chatCapturesByKey[k].filtered && (chatCapturesByKey[k].think || chatCapturesByKey[k].response)
      );
      if (hasFiltered && location.pathname.includes('/a/chat/s/')) applyArchiveInlines();
    }, 6000);
  }

  function onChatRouteChange() {
    loadMessageArchiveForCurrentChat(() => {
      scheduleApplyArchiveInlines();
      restoreLastCaptureForChat();
    });
  }

  function restoreLastCaptureForChat() {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      const c = result[STORAGE_KEY];
      if (!c) {
        updateDockLabels('Capture ready', 'Expand for View / Copy');
        setDockMode('ready');
        return;
      }
      if (c.chatPath && c.chatPath !== location.pathname) {
        const n = Object.keys(chatCapturesByKey).length;
        if (n > 0) {
          updateDockLabels('Saved in this chat', n + ' capture(s) - scroll to refusal messages');
          setDockMode('ready');
        } else {
          updateDockLabels('Capture ready', 'Expand for View / Copy');
          setDockMode('ready');
        }
        return;
      }
      lastCapture = c;
      setDockMode(c.filtered ? 'filtered' : 'ready');
      updateDockLabels(
        c.filtered ? 'Last recovery (this chat)' : 'Last capture',
        formatCount((c.think || '').length) + ' think / ' + formatCount((c.response || '').length) + ' response'
      );
    });
  }

  function showToast(message, kind) {
    let toast = document.getElementById('dsc-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'dsc-toast';
      document.body.appendChild(toast);
    }
    toast.className = 'dsc-toast dsc-toast-' + (kind || 'info');
    toast.textContent = message;
    requestAnimationFrame(() => toast.classList.add('dsc-toast-visible'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('dsc-toast-visible');
    }, kind === 'success' ? 2600 : 2000);
  }

  function bindDockActionButtons(container) {
    container.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.getAttribute('data-action');
        if (action === 'panel') openPanel(lastCapture || buildLiveCapture());
        if (action === 'copy' && lastCapture) {
          copyText(formatAll(lastCapture));
          showToast('Copied to clipboard', 'success');
        }
      });
    });
  }

  function refreshDockActions() {
    const el = document.getElementById('dsc-dock-actions');
    const dock = document.getElementById('dsc-dock');
    if (!el || !dock) return;

    if (panelOpen || !dock.classList.contains('dsc-dock-expanded')) {
      el.innerHTML = '';
      el.hidden = true;
      return;
    }

    const canView = lastCapture || dockPhase === 'live';
    if (!canView && dockPhase !== 'filtered') {
      el.innerHTML = '';
      el.hidden = true;
      return;
    }

    el.hidden = false;
    let html = '';
    if (canView) {
      html +=
        '<button type="button" class="dsc-dock-btn dsc-dock-btn-primary" data-action="panel" title="Show thinking and response captured from the network stream">View</button>';
    }
    if (lastCapture && (lastCapture.think || lastCapture.response)) {
      html +=
        '<button type="button" class="dsc-dock-btn" data-action="copy" title="Copy thinking and response to the clipboard">Copy</button>';
    }
    if (dockPhase === 'ready' && lastCapture) {
      html +=
        '<p class="dsc-dock-hint">Double-click the subtitle line for a filter recovery demo.</p>';
    }
    el.innerHTML = html;
    bindDockActionButtons(el);
  }

  function ensureDock() {
    if (document.getElementById('dsc-dock')) return;
    const root = getRoot();
    const dock = document.createElement('div');
    dock.id = 'dsc-dock';
    dock.className = 'dsc-dock dsc-dock-starting';
    dock.innerHTML = `
      <button type="button" class="dsc-dock-head" id="dsc-dock-head" aria-expanded="false" title="Expand for progress and actions">
        <span class="dsc-dock-dot" aria-hidden="true"></span>
        <span class="dsc-dock-text">
          <span class="dsc-dock-title" id="dsc-dock-title">Starting...</span>
          <span class="dsc-dock-sub" id="dsc-dock-sub"></span>
        </span>
        <span class="dsc-dock-chevron" aria-hidden="true"></span>
      </button>
      <div class="dsc-dock-progress" id="dsc-dock-progress" hidden>
        <div class="dsc-dock-progress-track">
          <span class="dsc-dock-progress-think" id="dsc-progress-think"></span>
          <span class="dsc-dock-progress-resp" id="dsc-progress-resp"></span>
        </div>
      </div>
      <div class="dsc-dock-actions" id="dsc-dock-actions" hidden></div>
    `;
    root.appendChild(dock);

    dock.querySelector('#dsc-dock-head').addEventListener('click', () => {
      const expanded = dock.classList.toggle('dsc-dock-expanded');
      dock.querySelector('#dsc-dock-head').setAttribute('aria-expanded', expanded ? 'true' : 'false');
      refreshDockActions();
    });

    const subEl = dock.querySelector('#dsc-dock-sub');
    subEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      previewFilterUi();
    });
  }

  function setDockMode(mode) {
    dockPhase = mode;
    const dock = document.getElementById('dsc-dock');
    if (!dock) return;
    const expanded = dock.classList.contains('dsc-dock-expanded');
    dock.className = 'dsc-dock dsc-dock-' + mode + (expanded ? ' dsc-dock-expanded' : '');
    refreshDockActions();
  }

  function updateDockLabels(title, sub) {
    const t = document.getElementById('dsc-dock-title');
    const s = document.getElementById('dsc-dock-sub');
    if (t) t.textContent = title;
    if (s) s.textContent = sub || '';
  }

  function setDockExpanded(expanded) {
    const dock = document.getElementById('dsc-dock');
    const head = document.getElementById('dsc-dock-head');
    if (!dock || !head) return;
    dock.classList.toggle('dsc-dock-expanded', expanded);
    head.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    refreshDockActions();
  }

  function updateProgressBar(thinkLen, respLen) {
    const wrap = document.getElementById('dsc-dock-progress');
    const thinkBar = document.getElementById('dsc-progress-think');
    const respBar = document.getElementById('dsc-progress-resp');
    if (!wrap || !thinkBar || !respBar) return;
    const total = thinkLen + respLen || 1;
    wrap.hidden = false;
    thinkBar.style.width = Math.round((thinkLen / total) * 100) + '%';
    respBar.style.width = Math.round((respLen / total) * 100) + '%';
  }

  function buildLiveCapture(partial) {
    return {
      think: partial?.think || '',
      response: partial?.response || '',
      filtered: false,
      live: dockPhase === 'live',
    };
  }

  function setPanelOpenState(open) {
    panelOpen = open;
    const root = getRoot();
    if (root) root.classList.toggle('dsc-panel-open', open);
    if (open) setDockExpanded(false);
    refreshDockActions();
  }

  function openPanel(capture) {
    if (!capture && dockPhase !== 'live') return;
    const cap = capture || buildLiveCapture(lastCapture);
    setPanelOpenState(true);
    renderPanel(cap);
    const panel = document.getElementById('dsc-panel');
    if (panel) panel.classList.add('dsc-panel-visible');
  }

  function closePanel() {
    setPanelOpenState(false);
    const panel = document.getElementById('dsc-panel');
    if (panel) panel.classList.remove('dsc-panel-visible');
  }

  function renderPanel(capture, opts) {
    const silent = opts && opts.silent;
    if (!capture.live) {
      const toStore = captureForStorage(capture);
      lastCapture = toStore;
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
      chrome.storage.local.set({ [STORAGE_KEY]: toStore });
      saveToMessageArchive(toStore);
      if (toStore.filtered) bindLatestCaptureToDom(toStore);
    }

    const hasContent = !!(capture.think || capture.response);
    if (!hasContent && !capture.live) {
      showToast('Stream ended but nothing was parsed', 'warn');
      return;
    }

    const root = getRoot();
    let panel = document.getElementById('dsc-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'dsc-panel';
      root.appendChild(panel);
    }

    const filtered = !!capture.filtered;
    panel.className =
      'dsc-panel' +
      (filtered ? ' dsc-panel-filtered' : '') +
      (capture.live ? ' dsc-panel-live' : '') +
      (panelOpen ? ' dsc-panel-visible' : '');

    const badge = filtered
      ? '<span class="dsc-badge">UI hidden this</span>'
      : capture.live
        ? '<span class="dsc-badge dsc-badge-live"><span class="dsc-live-dot" aria-hidden="true"></span>Live</span>'
        : '';

    const statusLine = filtered
      ? 'Recovered from the network stream after the safety message replaced the reply.'
      : capture.live
        ? 'Updates while the model is still writing.'
        : 'Text captured from the completion stream.';

    panel.innerHTML = `
      <div class="dsc-panel-inner">
        <p class="dsc-status">${statusLine}</p>
        <div class="dsc-header">
          <span class="dsc-title">${filtered ? 'Recovered reply' : 'Captured stream'}</span>
          ${badge}
          <div class="dsc-header-actions">
            <button type="button" data-copy="all" title="Copy thinking and response">Copy all</button>
            <button type="button" data-copy="close" class="dsc-close" aria-label="Close" title="Close panel">X</button>
          </div>
        </div>
        <details open>
          <summary>
            <span>Thinking (<span id="dsc-think-len">${(capture.think || '').length}</span>)</span>
            <button type="button" class="dsc-copy-part" data-copy="think" title="Copy thinking only">Copy</button>
          </summary>
          <pre class="dsc-pre" id="dsc-think"></pre>
        </details>
        <details open>
          <summary>
            <span>Response (<span id="dsc-resp-len">${(capture.response || '').length}</span>)</span>
            <button type="button" class="dsc-copy-part" data-copy="response" title="Copy response only">Copy</button>
          </summary>
          <pre class="dsc-pre" id="dsc-response"></pre>
        </details>
      </div>
    `;

    panel.querySelector('#dsc-think').textContent =
      capture.think || (capture.live ? 'Waiting for stream...' : '(empty)');
    panel.querySelector('#dsc-response').textContent = capture.response || (capture.live ? '...' : '(empty)');

    panel.querySelector('[data-copy="think"]').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyText(capture.think);
      showToast('Copied thinking', 'success');
    });
    panel.querySelector('[data-copy="response"]').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyText(capture.response);
      showToast('Copied response', 'success');
    });
    panel.querySelector('[data-copy="all"]').addEventListener('click', () => {
      copyText(formatAll(capture));
      showToast('Copied to clipboard', 'success');
    });
    panel.querySelector('[data-copy="close"]').addEventListener('click', () => closePanel());

    if (!silent && filtered) {
      showToast('Recovered hidden reply', 'success');
      scheduleInlineCopyOnce();
    }
  }

  function updatePanelLive(partial) {
    if (!panelOpen) return;
    const thinkLenEl = document.getElementById('dsc-think-len');
    const respLenEl = document.getElementById('dsc-resp-len');
    const thinkPre = document.getElementById('dsc-think');
    const respPre = document.getElementById('dsc-response');
    const tl = partial.thinkLen ?? 0;
    const rl = partial.responseLen ?? 0;
    if (thinkLenEl) thinkLenEl.textContent = String(tl);
    if (respLenEl) respLenEl.textContent = String(rl);
    const panel = document.getElementById('dsc-panel');
    if (panel && panel.classList.contains('dsc-panel-live')) {
      if (thinkPre) thinkPre.textContent = tl ? 'Streaming (' + formatCount(tl) + ' chars captured so far)...' : 'Waiting for thinking stream...';
      if (respPre) respPre.textContent = rl ? 'Streaming (' + formatCount(rl) + ' chars captured so far)...' : 'Waiting for response stream...';
    }
  }

  function onCaptureComplete(capture) {
    const thinkLen = (capture.think || '').length;
    const respLen = (capture.response || '').length;

    if (capture.filtered) {
      setDockMode('filtered');
      updateDockLabels('Recovered hidden reply', formatCount(thinkLen) + ' think / ' + formatCount(respLen) + ' response');
      openPanel(capture);
    } else {
      setDockMode('ready');
      updateDockLabels('Stream saved', formatCount(thinkLen) + ' think / ' + formatCount(respLen) + ' response');
      renderPanel(capture, { silent: !panelOpen });
    }
    updateProgressBar(thinkLen, respLen);
    refreshDockActions();
  }

  function previewFilterUi() {
    const base = lastCapture || {
      think: 'Sample thinking block for layout preview.',
      response: 'Sample response text that would have appeared before the filter.',
    };
    const preview = {
      think: base.think,
      response: base.response,
      filtered: true,
      at: Date.now(),
      preview: true,
    };
    setDockMode('filtered');
    updateDockLabels('Preview (demo)', 'Not a real filter event');
    openPanel(preview);
    showToast('Filter recovery preview', 'info');
  }

  function scheduleInlineCopyOnce() {
    if (inlineCopyScheduled || !lastCapture?.filtered) return;
    inlineCopyScheduled = true;
    setTimeout(() => scheduleApplyArchiveInlines(), 600);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== MSG_SOURCE) return;

    if (event.data.type === 'inject-ready') {
      setDockMode('ready');
      updateDockLabels('Capture ready', 'Expand for View / Copy');
    }

    if (event.data.type === 'stream-start') {
      inlineCopyScheduled = false;
      setDockMode('live');
      updateDockLabels('Receiving stream', 'Thinking and response counts below');
      updateProgressBar(0, 0);
    }

    if (event.data.type === 'stream-progress') {
      const p = event.data.payload;
      setDockMode('live');
      updateDockLabels(
        'Receiving stream',
        formatCount(p.thinkLen) + ' think / ' + formatCount(p.responseLen) + ' response'
      );
      updateProgressBar(p.thinkLen, p.responseLen);
      updatePanelLive(p);
    }

    if (event.data.type === 'capture') {
      onCaptureComplete(event.data.payload);
    }
  });

  loadMessageArchiveForCurrentChat(() => {
    restoreLastCaptureForChat();
    scheduleApplyArchiveInlines();
  });

  setInterval(() => {
    if (location.pathname !== lastPathname) {
      lastPathname = location.pathname;
      onChatRouteChange();
    }
  }, 1200);
})();
