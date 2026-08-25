(() => {
  try {
    const perf = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource');
    const totalResources = resources.length;
    const totalSize = resources.reduce((sum, r) => sum + (r.transferSize || 0), 0);
    const failedResources = resources.filter(r => r.transferSize === 0).length;
    return JSON.stringify({
      loadTime: perf ? Math.round(perf.duration) : 0,
      domContentLoaded: perf ? Math.round(perf.domContentLoadedEventEnd) : 0,
      resourceCount: totalResources,
      totalSizeKB: Math.round(totalSize / 1024),
      failedResources,
      readyState: document.readyState,
    });
  } catch {
    return JSON.stringify({ loadTime: 0, resourceCount: 0, totalSizeKB: 0, failedResources: 0, readyState: 'unknown' });
  }
})()