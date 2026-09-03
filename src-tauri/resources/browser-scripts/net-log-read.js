(() => {
  const log = window.__POLARIS_NET_LOG__ || [];
  const limit = Math.max(1, Math.min(200, Number(window.__POLARIS_NET_LOG_LIMIT__) || 50));
  const items = log.slice(-limit).map((e) => ({
    id: e.id,
    type: e.type,
    url: e.url,
    method: e.method,
    status: e.status,
    duration: e.duration,
    error: e.error,
    reqHeaders: e.reqHeaders,
    reqBody: e.reqBody,
    respHeaders: e.respHeaders,
    respBody: e.respBody,
    t: e.t,
  }));
  return JSON.stringify({
    count: log.length,
    returned: items.length,
    items,
  });
})()
