(() => {
  try {
    const args = window.__POLARIS_STORAGE_ARGS__ || {};
    const action = args.action;
    const type = args.type || 'localStorage';
    const key = args.key || null;
    const value = args.value == null ? '' : String(args.value);
    if (action === 'set' && (type !== 'cookie' && (key == null || key === ''))) {
      return JSON.stringify({ ok: false, error: 'set 需要 key' });
    }
    if (type === 'cookie') {
      const opts = args.cookieOpts || {};
      const path = opts.path || '/';
      const expires = opts.expires ? `; expires=${opts.expires}` : '';
      if (action === 'set') {
        document.cookie = `${key}=${encodeURIComponent(value)}; path=${path}${expires}`;
      } else if (action === 'clear') {
        document.cookie = `${key}=; path=${path}; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
      }
    } else if (type === 'sessionStorage' || type === 'localStorage') {
      const store = type === 'sessionStorage' ? sessionStorage : localStorage;
      if (action === 'set') {
        store.setItem(key, value);
      } else if (action === 'clear') {
        if (key != null && key !== '') store.removeItem(key);
        else store.clear();
      }
    } else {
      return JSON.stringify({ ok: false, error: 'unknown type: ' + type });
    }
    delete window.__POLARIS_STORAGE_ARGS__;
    return JSON.stringify({ origin: location.origin, ok: true, action, type, key: key || null });
  } catch (e) {
    return JSON.stringify({ ok: false, error: 'unavailable: ' + (e && e.message) });
  }
})()
