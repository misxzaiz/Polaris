/**
 * Sky 预览版入口
 *
 * 启动顺序:
 * 1. 契约 + 存储(构造时初始化)
 * 2. EventBus + Router
 * 3. 注册内置 cap: echo / kv / bash / config / history / ai.chat
 * 4. 加载外部插件(plugins/)
 * 5. 读 config 拿 port/token,启动 HTTP+WS server
 *
 * 一切能力通过 cap 注册——包括 AI 自己. AI 通过工具调用操作所有 cap.
 */

import { db, closeStorage } from './storage.ts';
import { EventBus } from './server/eventbus.ts';
import { Router } from './server/router.ts';
import { DefaultPermission } from './contracts.ts';
import { startServer } from './server/http.ts';
import { loadPlugins } from './server/plugin-loader.ts';

import { echoCap } from './caps/echo.ts';
import { kvCap } from './caps/kv.ts';
import { bashCap } from './caps/bash.ts';
import { configCap } from './caps/config.ts';
import { historyCap } from './caps/history.ts';
import { createAiChatCap } from './caps/ai.ts';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('[sky] booting...');

  // 1. EventBus + Router
  const bus = new EventBus();
  const policy = new DefaultPermission([
    // Remote 默认允许的能力(本地开发宽松)
    'cap.echo', 'cap.kv', 'cap.bash', 'cap.config', 'cap.history', 'cap.ai.chat',
  ]);
  const router = new Router(policy, bus);

  // 2. 注册内置 cap
  router.register(echoCap);
  router.register(kvCap);
  router.register(bashCap);
  router.register(configCap);
  router.register(historyCap);
  router.register(createAiChatCap(router));

  // 3. 加载外部插件
  const pluginsDir = join(__dirname, '..', 'plugins');
  const n = await loadPlugins(router, pluginsDir);
  console.log(`[sky] loaded ${n} external plugin(s)`);

  // 4. 读 config 决定 port/token
  const cfgReply = await router.dispatch('cap.config', { action: 'get' }, { kind: 'bootstrap' });
  if (!cfgReply.result.ok) throw new Error(cfgReply.result.error);
  const cfg = cfgReply.result.data as {
    server?: { port?: number; token?: string };
  };
  const port = cfg.server?.port ?? 9825;
  const token = cfg.server?.token || undefined;

  // 5. 启动 server
  startServer(router, bus, {
    port,
    token,
    remoteAllow: ['cap.echo', 'cap.kv', 'cap.bash', 'cap.config', 'cap.history', 'cap.ai.chat'],
  });

  // 6. 优雅退出
  const shutdown = (sig: string) => {
    console.log(`\n[sky] ${sig} received, shutting down...`);
    closeStorage();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[sky] fatal:', err);
  process.exit(1);
});
