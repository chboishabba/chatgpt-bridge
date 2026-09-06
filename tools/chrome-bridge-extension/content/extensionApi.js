(() => {
  'use strict';

  const STORAGE_PREFIX = 'chatgptBridge:';
  // BRIDGE_TOKEN must not be persisted in chatgpt.com localStorage.  Keep only
  // an opaque marker in page storage so the synchronous content-runtime config
  // can tell that a token has been configured; the secret itself lives in the
  // extension's chrome.storage.local namespace.
  const BRIDGE_TOKEN_KEY = 'bridge.token';
  const BRIDGE_TOKEN_MARKER = '__chatgpt_bridge_secret_in_extension_storage_v1__';
  const BRIDGE_TOKEN_STORAGE_KEY = 'chatgptBridge:secret:bridge.token';

  function pageStorageKey(key) {
    return STORAGE_PREFIX + key;
  }

  function persistBridgeToken(secret) {
    try {
      if (!chrome?.storage?.local) return;
      if (secret) void chrome.storage.local.set({ [BRIDGE_TOKEN_STORAGE_KEY]: String(secret) });
      else void chrome.storage.local.remove(BRIDGE_TOKEN_STORAGE_KEY);
    } catch {}
  }

  function getValue(key, fallback) {
    try {
      const raw = localStorage.getItem(pageStorageKey(key));
      const value = raw == null ? fallback : JSON.parse(raw);
      if (key !== BRIDGE_TOKEN_KEY) return value;

      if (value === BRIDGE_TOKEN_MARKER) return BRIDGE_TOKEN_MARKER;

      // One-time migration from pre-hardening versions.  Return the legacy
      // value for this in-memory session so the current connection can succeed,
      // but immediately remove the plaintext from the ChatGPT origin.
      const legacySecret = typeof value === 'string' ? value : '';
      if (legacySecret) {
        persistBridgeToken(legacySecret);
        localStorage.setItem(pageStorageKey(key), JSON.stringify(BRIDGE_TOKEN_MARKER));
        return legacySecret;
      }
      return fallback;
    } catch {
      return fallback;
    }
  }

  function setValue(key, value) {
    try {
      if (key === BRIDGE_TOKEN_KEY) {
        const secret = String(value || '');
        if (secret && secret !== BRIDGE_TOKEN_MARKER) persistBridgeToken(secret);
        else if (!secret) persistBridgeToken('');
        localStorage.setItem(
          pageStorageKey(key),
          JSON.stringify(secret ? BRIDGE_TOKEN_MARKER : ''),
        );
        return true;
      }
      localStorage.setItem(pageStorageKey(key), JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function httpRequest(details = {}) {
    const requestId = `http-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let aborted = false;
    let timer = null;

    const finish = (callback, value) => {
      if (aborted) return;
      if (timer) clearTimeout(timer);
      try {
        callback?.(value);
      } catch (err) {
        console.error('[chatgpt-bridge-extension] HTTP callback failed', err);
      }
    };

    if (details.timeout) {
      timer = setTimeout(() => {
        aborted = true;
        try { details.ontimeout?.(); } catch {}
      }, Number(details.timeout) || 0);
    }

    chrome.runtime.sendMessage({
      type: 'bridge.http',
      requestId,
      request: {
        method: details.method || 'GET',
        url: details.url,
        headers: details.headers || {},
        data: details.data,
        responseType: details.responseType || 'text',
      },
    }, (response) => {
      if (aborted) return;
      if (chrome.runtime.lastError) {
        finish(details.onerror, { error: chrome.runtime.lastError.message });
        return;
      }
      if (!response || response.error) {
        finish(details.onerror, { error: response?.error || 'Extension HTTP request failed' });
        return;
      }

      const result = response.result || {};
      let body = result.data;
      if (result.responseType === 'arraybuffer' && Array.isArray(body)) body = new Uint8Array(body).buffer;
      const responseText = typeof body === 'string' ? body : body == null ? '' : JSON.stringify(body);
      finish(details.onload, {
        status: result.status || 0,
        response: body,
        responseText,
        responseHeaders: result.contentType ? `content-type: ${result.contentType}` : '',
      });
    });

    return {
      abort() {
        aborted = true;
        if (timer) clearTimeout(timer);
        try { details.onabort?.(); } catch {}
      },
    };
  }

  globalThis.ChatGptExtensionApi = Object.freeze({
    getValue,
    setValue,
    httpRequest,
    BRIDGE_TOKEN_MARKER,
  });
})();
