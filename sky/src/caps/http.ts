/**
 * cap.http — HTTP 客户端能力
 *
 * 动作: get/post/put/patch/delete/head
 * AI 能发网络请求(调外部 API / 抓取数据)
 */

import type { Capability, Value } from '../contracts.ts';

export const httpCap: Capability = {
  id: 'cap.http',
  description: 'HTTP client. Actions: get/post/put/patch/delete/head. Returns {status, headers, body}.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'post', 'put', 'patch', 'delete', 'head'] },
      url: { type: 'string' },
      headers: { type: 'object', description: 'Request headers' },
      body: { description: 'Request body (string or object)' },
      timeout: { type: 'number', description: 'ms, default 30000' },
    },
    required: ['action', 'url'],
  },
  async invoke(params: Value) {
    const p = params as {
      action: 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head';
      url: string;
      headers?: Record<string, string>;
      body?: unknown;
      timeout?: number;
    };
    if (!p.url) throw new Error('url required');
    const method = p.action.toUpperCase();
    const headers: Record<string, string> = { ...(p.headers ?? {}) };
    let body: string | undefined;
    if (p.body !== undefined) {
      if (typeof p.body === 'string') {
        body = p.body;
        if (!headers['Content-Type']) headers['Content-Type'] = 'text/plain';
      } else {
        body = JSON.stringify(p.body);
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      }
    }
    const controller = new AbortController();
    const timeout = p.timeout ?? 30000;
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const resp = await fetch(p.url, { method, headers, body, signal: controller.signal });
      clearTimeout(timer);
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => { respHeaders[k] = v; });
      const text = await resp.text();
      // 尝试 JSON 解析
      let parsed: unknown = text;
      const ct = respHeaders['content-type'] ?? '';
      if (ct.includes('application/json') || text.startsWith('{') || text.startsWith('[')) {
        try { parsed = JSON.parse(text); } catch { /* 保持 text */ }
      }
      return {
        ok: true,
        status: resp.status,
        statusText: resp.statusText,
        headers: respHeaders,
        body: parsed,
        bodySize: text.length,
      };
    } catch (err) {
      clearTimeout(timer);
      const error = err instanceof Error ? err.message : String(err);
      if (error.includes('abort')) {
        return { ok: false, error: `timeout after ${timeout}ms` };
      }
      return { ok: false, error };
    }
  },
};
