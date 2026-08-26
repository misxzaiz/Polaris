(() => {
  try {
    const args = window.__POLARIS_STORAGE_ARGS__ || {};
    const type = args.type || 'localStorage';
    const onlyKey = args.key || null;
    const out = { origin: location.origin, type, keys: {} };
    if (type === 'cookie') {
      const pairs = document.cookie.split(';').map(s => s.trim()).filter(Boolean);
      for (const p of pairs) {
        const i = p.indexOf('=');
        const k = i === -1 ? p : p.slice(0, i);
        if (!onlyKey || k === onlyKey) out.keys[k] = i === -1 ? '' : p.slice(i + 1);
      }
    } else if (type === 'sessionStorage' || type === 'localStorage') {
      const store = type === 'sessionStorage' ? sessionStorage : localStorage;
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (!onlyKey || k === onlyKey) out.keys[k] = store.getItem(k);
      }
    } else {
      out.error = 'unknown type: ' + type;
    }
    delete window.__POLARIS_STORAGE_ARGS__;
    return JSON.stringify(out);
  } catch (e) {
    return JSON.stringify({ origin: location.origin, type: 'localStorage', keys: {}, error: 'unavailable: ' + (e && e.message) });
  }
})()
