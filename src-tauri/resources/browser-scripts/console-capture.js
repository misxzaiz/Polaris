(() => {
const now = () => Date.now();
if (!window.__POLARIS_BROWSER_CONSOLE__) {
  const buffer = [];
  const push = (level, args) => {
    try {
      buffer.push({
        level,
        message: Array.from(args || []).map((item) => {
          if (typeof item === 'string') return item;
          try { return JSON.stringify(item); } catch { return String(item); }
        }).join(' ').slice(0, 2000),
        url: String(location.href),
        timestamp: now()
      });
      if (buffer.length > 120) buffer.splice(0, buffer.length - 120);
    } catch {}
  };
  const original = {};
  ['debug', 'log', 'info', 'warn', 'error'].forEach((level) => {
    original[level] = console[level];
    console[level] = function(...args) {
      push(level, args);
      return original[level]?.apply(this, args);
    };
  });
  window.addEventListener('error', (event) => {
    push('error', [event.message || 'Script error', event.filename || '', event.lineno || '']);
  });
  window.addEventListener('unhandledrejection', (event) => {
    push('error', ['Unhandled promise rejection', event.reason || '']);
  });
  Object.defineProperty(window, '__POLARIS_BROWSER_CONSOLE__', {
    value: buffer,
    configurable: true
  });
}
})()