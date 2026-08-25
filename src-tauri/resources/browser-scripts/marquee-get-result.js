(() => {
  try {
    const raw = window.__POLARIS_MARQUEE_RESULT__;
    if (!raw) return JSON.stringify({ rects: [], done: false });
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return JSON.stringify({ rects: [], done: false });
  }
})()