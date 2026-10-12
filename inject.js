(function () {
  'use strict';

  const MSG_SOURCE = 'deepseek-stream-capture';

  function post(type, payload) {
    window.postMessage({ source: MSG_SOURCE, type, payload }, '*');
  }

  function createStreamState() {
    return {
      think: '',
      response: '',
      currentFragmentType: null,
      filtered: false,
      notified: false,
      sseBuffer: '',
      xhrLastLen: 0,
      requestId: null,
      messageId: null,
      sseEvent: null,
    };
  }

  function absorbMetadata(state, obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.request_id != null) state.requestId = String(obj.request_id);
    if (obj.message_id != null) state.messageId = String(obj.message_id);
    if (obj.msg_id != null) state.messageId = String(obj.msg_id);
    if (obj.response_message_id != null) state.messageId = String(obj.response_message_id);
  }

  function notifyCapture(state, force) {
    if (!state.think && !state.response) return;
    if (state.notified && !force) return;
    state.notified = true;
    post('capture', {
      think: state.think,
      response: state.response,
      filtered: state.filtered,
      at: Date.now(),
      requestId: state.requestId || null,
      messageId: state.messageId || null,
    });
  }

  function applyStringDelta(state, text) {
    if (!text) return;
    const type = state.currentFragmentType;
    if (type === 'THINK') state.think += text;
    else if (type === 'RESPONSE') state.response += text;
    else {
      state.currentFragmentType = 'THINK';
      state.think += text;
    }
  }

  function applyFragment(state, fragment) {
    if (!fragment || !fragment.type) return;
    if (fragment.type === 'TEMPLATE_RESPONSE' || fragment.type === 'TIP') return;
    state.currentFragmentType = fragment.type;
    const content = fragment.content || '';
    if (fragment.type === 'THINK') state.think += content;
    else if (fragment.type === 'RESPONSE') state.response += content;
  }

  function processPatchItem(state, patch) {
    if (!patch || patch.p == null) return;
    const p = String(patch.p);

    if (/message_id|msg_id|response_id/i.test(p) && patch.v != null && typeof patch.v !== 'object') {
      state.messageId = String(patch.v);
    }

    if (p === 'status' && patch.v === 'CONTENT_FILTER') {
      state.filtered = true;
      notifyCapture(state, true);
    }
    if (p === 'quasi_status' && patch.v === 'CONTENT_FILTER') {
      state.filtered = true;
      notifyCapture(state, true);
    }

    if (p === 'fragments' || p === 'response/fragments') {
      const frags = patch.v;
      if (Array.isArray(frags)) {
        for (const f of frags) {
          if (f && f.type === 'TEMPLATE_RESPONSE') state.filtered = true;
          applyFragment(state, f);
        }
      }
    }
  }

  function processPatchArray(state, patches) {
    if (!Array.isArray(patches)) return;
    for (const patch of patches) {
      processPatchItem(state, patch);
    }
  }

  function handleJsonPayload(state, data) {
    if (data == null) return;
    absorbMetadata(state, data);

    if (typeof data.v === 'string') {
      applyStringDelta(state, data.v);
      return;
    }

    if (typeof data.v === 'number' || typeof data.v === 'boolean') return;

    // {"p":"response/fragments/-1/content","o":"APPEND","v":"We"}
    // {"p":"response/fragments/-1/content","v":" \""}  (no "o" field)
    if (data.p && typeof data.p === 'string' && data.p.includes('fragments') && data.p.includes('content')) {
      if (typeof data.v === 'string') {
        applyStringDelta(state, data.v);
        return;
      }
    }

    if (
      (data.p === 'response/fragments' || data.p === 'fragments') &&
      data.o === 'APPEND' &&
      Array.isArray(data.v)
    ) {
      for (const f of data.v) applyFragment(state, f);
      return;
    }

    const nested = data.v;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      absorbMetadata(state, nested);
      const resp = nested.response ?? nested;
      absorbMetadata(state, resp);
      if (resp.fragments && Array.isArray(resp.fragments)) {
        for (const f of resp.fragments) applyFragment(state, f);
      }
      if (resp.status === 'CONTENT_FILTER') {
        state.filtered = true;
        notifyCapture(state, true);
      }
      if (resp.quasi_status === 'CONTENT_FILTER') {
        state.filtered = true;
        notifyCapture(state, true);
      }
    }

    if (Array.isArray(data.v)) {
      processPatchArray(state, data.v);
      for (const item of data.v) {
        if (item && typeof item === 'object' && item.p != null) {
          processPatchItem(state, item);
        }
      }
    }

    if (data.o === 'BATCH' && Array.isArray(data.v)) {
      processPatchArray(state, data.v);
      for (const item of data.v) {
        if (item && typeof item === 'object') processPatchItem(state, item);
      }
    }

    if (data.p === 'response/status' && data.v === 'FINISHED') {
      notifyCapture(state, true);
    }
    if (data.p === 'quasi_status' && data.v === 'FINISHED') {
      notifyCapture(state, false);
    }
  }

  function feedSseText(state, chunkText) {
    state.sseBuffer += chunkText;
    const parts = state.sseBuffer.split('\n');
    state.sseBuffer = parts.pop() || '';

    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('event:')) {
        state.sseEvent = trimmed.slice(6).trim();
        continue;
      }
      if (!trimmed.startsWith('data:')) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const parsed = JSON.parse(raw);
        if (state.sseEvent === 'ready') absorbMetadata(state, parsed);
        handleJsonPayload(state, parsed);
      } catch {
        /* ignore non-JSON lines */
      }
      state.sseEvent = null;
    }
  }

  function flushSseBuffer(state) {
    if (state.sseBuffer.trim()) {
      feedSseText(state, '\n');
    }
  }

  let lastProgressPost = 0;

  function maybePostProgress(state) {
    const now = Date.now();
    if (now - lastProgressPost > 800) {
      lastProgressPost = now;
      post('stream-progress', {
        thinkLen: state.think.length,
        responseLen: state.response.length,
      });
    }
  }

  function requestUrl(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return '';
  }

  function isStreamUrl(url) {
    if (!url) return false;
    const u = String(url);
    return (
      /(?:^|[/?])(query|completion)(?:[/?]|$|\?)/i.test(u) ||
      /\/api\/v\d+\/chat(?:\/|$|\?)/i.test(u) ||
      /chat\/completion/i.test(u)
    );
  }

  function shouldInterceptResponse(response, input) {
    const u = requestUrl(input);
    if (isStreamUrl(u)) return true;
    const ct = (response.headers && response.headers.get('content-type')) || '';
    return ct.indexOf('text/event-stream') !== -1;
  }

  async function interceptReadableStream(response, state) {
    if (!response.body) return response;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              flushSseBuffer(state);
              notifyCapture(state, true);
              controller.close();
              break;
            }
            const text = decoder.decode(value, { stream: true });
            feedSseText(state, text);
            maybePostProgress(state);
            controller.enqueue(value);
          }
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  function attachXhrStreamCapture(xhr, url) {
    const state = createStreamState();
    let streamStarted = false;

    xhr.addEventListener('readystatechange', function () {
      if (xhr.readyState >= 2 && !xhr.__dscSseChecked) {
        xhr.__dscSseChecked = true;
        const ct = (xhr.getResponseHeader && xhr.getResponseHeader('content-type')) || '';
        xhr.__dscIsSse = /text\/event-stream/i.test(ct);
      }
      if (!xhr.__dscIsSse) return;

      if (!streamStarted) {
        streamStarted = true;
        post('stream-start', { url: String(url), via: 'xhr', at: Date.now() });
      }

      if (xhr.readyState < 3) return;
      const full = xhr.responseText || '';
      if (full.length <= state.xhrLastLen) return;
      const chunk = full.slice(state.xhrLastLen);
      state.xhrLastLen = full.length;
      feedSseText(state, chunk);
      maybePostProgress(state);
    });

    xhr.addEventListener('load', function () {
      if (!xhr.__dscIsSse) return;
      flushSseBuffer(state);
      notifyCapture(state, true);
    });
    xhr.addEventListener('error', function () {
      if (!xhr.__dscIsSse) return;
      flushSseBuffer(state);
      notifyCapture(state, true);
    });
  }

  function installHooks() {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async function deepseekPatchedFetch(input, init) {
      const response = await originalFetch(input, init);
      if (!shouldInterceptResponse(response, input)) return response;

      const state = createStreamState();
      post('stream-start', { url: requestUrl(input), via: 'fetch', at: Date.now() });

      try {
        return await interceptReadableStream(response, state);
      } catch {
        return response;
      }
    };

    const xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__dscUrl = url;
      return xhrOpen.apply(this, arguments);
    };

    const xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      const url = this.__dscUrl || '';
      if (isStreamUrl(url)) {
        attachXhrStreamCapture(this, url);
      }
      return xhrSend.apply(this, arguments);
    };
  }

  if (window.__deepseekStreamCaptureInstalled) {
    post('inject-ready', { already: true });
  } else {
    window.__deepseekStreamCaptureInstalled = true;
    installHooks();
    post('inject-ready', { fetch: true, xhr: true });
  }
})();
