/**
 * 读取 __POLARIS_BROWSER_CONSOLE__ 捕获的控制台消息。
 * 通过 window.__POLARIS_CONSOLE_ARGS__ 传参：{ limit?: number, clear?: boolean }
 */
(() => {
  const args = window.__POLARIS_CONSOLE_ARGS__ || {};
  delete window.__POLARIS_CONSOLE_ARGS__;
  const buffer = window.__POLARIS_BROWSER_CONSOLE__ || [];
  const limit = Math.max(1, Math.min(500, Number(args.limit) || 100));
  const items = buffer.slice(-limit).map((m, i) => ({
    index: buffer.length - Math.min(buffer.length, limit) + i,
    level: m.level,
    message: m.message,
    url: m.url,
    timestamp: m.timestamp,
  }));
  const result = {
    count: buffer.length,
    returned: items.length,
    items,
  };
  if (args.clear === true) {
    buffer.length = 0;
  }
  return JSON.stringify(result);
})()
