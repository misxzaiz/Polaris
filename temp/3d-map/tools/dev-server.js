#!/usr/bin/env node
/**
 * dev-server.js — 3D World 本地开发服务器
 *
 * 职责:
 *   - 零配置静态文件 HTTP 服务器（index.html 双击有 CORS 问题，此服务器解决）
 *   - 内置 CDN 资源代理：将 unpkg three.js 请求代理，绕过跨域/网络不稳定问题
 *   - 自动端口降级（8080 → 8081 → ...）
 *   - 优雅关闭（SIGINT / SIGTERM）
 *   - 零外部依赖（仅 Node 内置模块）
 *
 * 启动:
 *   node tools/dev-server.js              # 默认 8080, root=.
 *   node tools/dev-server.js --port 3000  # 指定端口
 *   node tools/dev-server.js --no-proxy   # 禁用 CDN 代理（信任本地网络）
 *
 * DevOps 原则: 自动化、零配置、自愈（端口冲突自动降级）
 *
 * 版本: v1.0 · 2026-07-19
 */

import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname, parse } from 'node:path';
import { URL } from 'node:url';
import http from 'node:http';

// ---- 配置 ----
const DEFAULT_PORT = 8080;
const PORT_RANGE = 20; // 最多尝试 20 个端口
const CACHE_TTL_HTML = 0;           // HTML 不缓存
const CACHE_TTL_ASSET = 86400;      // 静态资源缓存 1 天
const CACHE_TTL_PROXY = 3600;       // 代理内容缓存 1 小时

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// ---- CLI 参数解析 ----
function parseArgs() {
  const args = process.argv.slice(2);
  const cfg = { port: DEFAULT_PORT, noProxy: false, dir: '.' };
  let i = 0;
  while (i < args.length) {
    if (args[i] === '--port' && args[i + 1]) {
      cfg.port = parseInt(args[++i], 10);
    } else if (args[i] === '--no-proxy') {
      cfg.noProxy = true;
    } else if (args[i] === '--dir' && args[i + 1]) {
      cfg.dir = args[++i];
    } else if (args[i] === '--help') {
      console.log(`用法: node dev-server.js [--port PORT] [--no-proxy] [--dir DIR]
  --port PORT   监听端口 (默认 ${DEFAULT_PORT})
  --no-proxy    禁用 CDN 资源代理
  --dir DIR     根目录 (默认 .)`);
      process.exit(0);
    }
    i++;
  }
  return cfg;
}

// ---- 端口自动发现（自愈） ----
async function findPort(desired) {
  const server = createServer();
  for (let offset = 0; offset < PORT_RANGE; offset++) {
    const port = desired + offset;
    try {
      await new Promise((resolve, reject) => {
        server.listen(port, '0.0.0.0', () => resolve());
        server.once('error', reject);
      });
      server.close();
      return port;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error(`无法找到可用端口，已尝试 ${desired} - ${desired + PORT_RANGE - 1}`);
}

// ---- 代理缓存（内存，进程生命周期内） ----
const proxyCache = new Map(); // key: url, value: { body, headers, ts }

async function proxyToCDN(urlStr) {
  const cached = proxyCache.get(urlStr);
  if (cached && Date.now() - cached.ts < CACHE_TTL_PROXY * 1000) {
    return { body: cached.body, headers: cached.headers };
  }
  const url = new URL(urlStr);
  const response = await new Promise((resolve, reject) => {
    const req = http.get(urlStr, { timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ body: Buffer.concat(chunks), headers: res.headers, status: res.statusCode });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('代理超时 15s')); });
  });
  if (response.status !== 200) {
    throw new Error(`代理返回 ${response.status}`);
  }
  proxyCache.set(urlStr, { body: response.body, headers: response.headers, ts: Date.now() });
  return { body: response.body, headers: response.headers };
}

// ---- 静态文件服务 ----
function serveFile(res, filePath) {
  const ext = extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const content = readFileSync(filePath);
  const isHtml = ext === '.html';
  const maxAge = isHtml ? CACHE_TTL_HTML : CACHE_TTL_ASSET;

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': content.length,
    'Cache-Control': maxAge === 0 ? 'no-store' : `public, max-age=${maxAge}`,
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(content);
}

// ---- 主服务 ----
async function main() {
  const cfg = parseArgs();
  const port = await findPort(cfg.port);
  const root = join(process.cwd(), cfg.dir);

  if (!existsSync(root)) {
    console.error(`错误: 目录不存在 ${root}`);
    process.exit(1);
  }

  const server = createServer((req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(parsed.pathname);

    // CORS 代理: /_proxy/unpkg.com/... → 代理到 unpkg
    if (pathname.startsWith('/_proxy/')) {
      const target = pathname.slice('/_proxy/'.length);
      if (!cfg.noProxy) {
        // 允许代理 unpkg 域名
        if (target.startsWith('unpkg.com/')) {
          proxyToCDN(`https://${target}${parsed.search || ''}`)
            .then((r) => {
              const ext = extname(parse(target).name + (parse(target).ext)) || '.js';
              res.writeHead(200, {
                'Content-Type': 'application/javascript; charset=utf-8',
                'Cache-Control': `public, max-age=${CACHE_TTL_PROXY}`,
                'Access-Control-Allow-Origin': '*',
              });
              res.end(r.body);
            })
            .catch((e) => {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: '代理失败', detail: String(e) }));
              console.error(`[proxy] ${e.message}`);
            });
        } else {
          res.writeHead(403);
          res.end('仅代理 unpkg.com');
        }
      } else {
        res.writeHead(501);
        res.end('代理已禁用');
      }
      return;
    }

    // 静态文件
    let filePath = join(root, pathname === '/' ? 'index.html' : pathname);
    // 防止目录穿越
    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '文件未找到', path: pathname }));
      return;
    }
    try {
      serveFile(res, filePath);
    } catch (e) {
      res.writeHead(500);
      res.end('Internal Server Error');
      console.error(`[serve] ${e.message}`);
    }
  });

  server.listen(port, '0.0.0.0', () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  🚀 3D World 开发服务器已启动`);
    console.log(`     地址: ${url}`);
    console.log(`     根目录: ${root}`);
    console.log(`     CDN 代理: ${cfg.noProxy ? '禁用' : '已启用 (unpkg.com)'}`);
    console.log(`     按 Ctrl+C 停止\n`);
  });

  // 优雅关闭
  process.on('SIGINT', () => { closeGracefully(); });
  process.on('SIGTERM', () => { closeGracefully(); });
  function closeGracefully() {
    console.log('\n  ⏹ 服务器正在关闭...');
    server.close(() => {
      console.log('     已关闭\n');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000);
  }
}

main().catch((e) => {
  console.error('启动失败:', e.message);
  process.exit(1);
});
