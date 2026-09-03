/**
 * Polaris 内置浏览器网络请求拦截脚本
 *
 * 通过 WebviewBuilder.initialization_script() 在页面加载前注入。
 * 劫持 window.fetch 和 XMLHttpRequest，将请求/响应元数据记录到
 * window.__POLARIS_NET_LOG__（环形缓冲区，上限 200 条）。
 *
 * 数据格式:
 * {
 *   id: number,           // 自增 ID
 *   type: 'fetch'|'xhr',
 *   url: string,
 *   method: string,
 *   status: number|null,
 *   reqHeaders: object,
 *   reqBody: string|null,   // 截断到 8KB
 *   respHeaders: object,
 *   respBody: string|null,  // 截断到 32KB
 *   error: string|null,
 *   t: number,              // 时间戳
 *   duration: number|null,  // 毫秒
 * }
 */
(() => {
  if (window.__POLARIS_NET_HOOKED__) return;
  window.__POLARIS_NET_HOOKED__ = true;
  window.__POLARIS_NET_LOG__ = [];
  window.__POLARIS_NET_SEQ__ = 0;

  const MAX_ENTRIES = 200;
  const MAX_REQ_BODY = 8192;    // 8KB
  const MAX_RESP_BODY = 32768;  // 32KB

  const push = (entry) => {
    entry.id = ++window.__POLARIS_NET_SEQ__;
    window.__POLARIS_NET_LOG__.push(entry);
    if (window.__POLARIS_NET_LOG__.length > MAX_ENTRIES) {
      window.__POLARIS_NET_LOG__.shift();
    }
  };

  const truncate = (str, max) => {
    if (str == null) return null;
    const s = String(str);
    return s.length > max ? s.slice(0, max) + '...[truncated]' : s;
  };

  const headersToObj = (headers) => {
    if (!headers) return {};
    if (headers instanceof Headers) return Object.fromEntries(headers.entries());
    if (typeof headers === 'object') return { ...headers };
    return {};
  };

  // ── 劫持 fetch ──────────────────────────────────────────
  const _origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url || String(input));
    const method = (init?.method || 'GET').toUpperCase();
    const t = Date.now();

    const entry = {
      type: 'fetch',
      url,
      method,
      status: null,
      reqHeaders: headersToObj(init?.headers),
      reqBody: truncate(init?.body, MAX_REQ_BODY),
      respHeaders: {},
      respBody: null,
      error: null,
      t,
      duration: null,
    };

    return _origFetch.apply(this, arguments).then((resp) => {
      entry.status = resp.status;
      entry.respHeaders = Object.fromEntries(resp.headers.entries());
      entry.duration = Date.now() - t;

      // 异步读取响应体，不阻塞原始 Promise
      resp.clone().text().then((text) => {
        entry.respBody = truncate(text, MAX_RESP_BODY);
        push(entry);
      }).catch(() => {
        entry.respBody = '[unreadable]';
        push(entry);
      });

      return resp;
    }).catch((err) => {
      entry.error = String(err);
      entry.duration = Date.now() - t;
      push(entry);
      throw err;
    });
  };

  // ── 劫持 XMLHttpRequest ────────────────────────────────
  const _origOpen = XMLHttpRequest.prototype.open;
  const _origSend = XMLHttpRequest.prototype.send;
  const _origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__polaris_entry = {
      type: 'xhr',
      url: String(url),
      method: String(method || 'GET').toUpperCase(),
      status: null,
      reqHeaders: {},
      reqBody: null,
      respHeaders: {},
      respBody: null,
      error: null,
      t: Date.now(),
      duration: null,
    };
    return _origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__polaris_entry) {
      this.__polaris_entry.reqHeaders[name] = value;
    }
    return _origSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const entry = this.__polaris_entry;
    if (!entry) return _origSend.apply(this, arguments);

    entry.reqBody = truncate(body, MAX_REQ_BODY);
    const t = entry.t;

    this.addEventListener('load', () => {
      entry.status = this.status;
      entry.duration = Date.now() - t;
      try {
        const raw = this.getAllResponseHeaders();
        raw.trim().split(/[\r\n]+/).forEach((line) => {
          const parts = line.split(': ');
          if (parts.length === 2) entry.respHeaders[parts[0]] = parts[1];
        });
      } catch {}
      try {
        entry.respBody = truncate(this.responseText, MAX_RESP_BODY);
      } catch {
        entry.respBody = '[unreadable]';
      }
      push(entry);
    });

    this.addEventListener('error', () => {
      entry.error = 'XHR error';
      entry.duration = Date.now() - t;
      push(entry);
    });

    this.addEventListener('abort', () => {
      entry.error = 'XHR aborted';
      entry.duration = Date.now() - t;
      push(entry);
    });

    return _origSend.apply(this, arguments);
  };
})();
