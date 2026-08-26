(() => {
  try {
    const limit = (typeof window.__POLARIS_NETWORK_LIMIT__ === 'number' && window.__POLARIS_NETWORK_LIMIT__ > 0)
      ? window.__POLARIS_NETWORK_LIMIT__
      : 100;
    const entries = performance.getEntriesByType('resource');
    const items = entries.slice(-limit).map(r => ({
      url: r.name,
      initiatorType: r.initiatorType || 'other',
      transferSize: r.transferSize || 0,
      duration: Math.round(r.duration),
      startTime: Math.round(r.startTime),
      name: r.name,
    }));
    return JSON.stringify({
      origin: location.origin,
      count: entries.length,
      returned: items.length,
      items,
    });
  } catch {
    return JSON.stringify({ origin: location.origin, count: 0, returned: 0, items: [] });
  }
})()
