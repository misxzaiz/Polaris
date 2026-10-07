/**
 * Sky 预览版入口
 *
 * 启动顺序:
 * 1. 存储(构造时初始化)
 * 2. EventBus + Router (链调度版, 无硬编码关卡)
 * 3. 注册拦截器: permission + audit (退化为插件)
 * 4. 注册内置 cap: 业务 cap + 元 cap (interceptor/capability/plugin/transport/shell)
 * 5. 加载外部插件(plugins/)
 * 6. 读 config 拿 port/token, 启动 HTTP+WS server
 *
 * 一切能力通过 cap 注册——包括 AI 自己. AI 通过工具调用操作所有 cap,
 * 包括元 cap (cap.interceptor/capability/plugin) 可自我演化架构.
 */

import { db, closeStorage, dataRoot } from './storage.ts';
import { EventBus } from './server/eventbus.ts';
import { Router } from './server/router.ts';
import { startServer } from './server/http.ts';
import { loadPlugins } from './server/plugin-loader.ts';
import { readConfigRaw } from './caps/config.ts';

// 拦截器
import { permissionInterceptor, setPermissionConfig, getPermissionConfig } from './interceptors/permission.ts';
import { auditInterceptor } from './interceptors/audit.ts';
import { setAuditEmitter } from './caps/audit.ts';

// 业务 cap
import { echoCap } from './caps/echo.ts';
import { kvCap } from './caps/kv.ts';
import { bashCap } from './caps/bash.ts';
import { configCap } from './caps/config.ts';
import { historyCap } from './caps/history.ts';
import { auditCap } from './caps/audit.ts';
import { fsCap } from './caps/fs.ts';
import { httpCap } from './caps/http.ts';
import { taskCap } from './caps/task.ts';
import { timeCap } from './caps/time.ts';
import { createAiChatCap } from './caps/ai.ts';

// 元 cap
import { createInterceptorCap } from './caps/interceptor.ts';
import { createCapabilityCap } from './caps/capability.ts';
import { createPluginCap } from './caps/plugin.ts';
import { createTransportCap } from './caps/transport.ts';
import { createShellCap } from './caps/shell.ts';
import { createEngineCap } from './caps/engine.ts';
import { createStorageCap } from './caps/storage.ts';
import { createBusCap } from './caps/bus.ts';
import { createAuthCap } from './caps/auth.ts';
import { createEditCap } from './caps/edit.ts';
import { setAuthState } from './server/auth.ts';

// UI cap (前端样式自动演进)
import { initUiState } from './caps/ui/state.ts';
import { uiStyleCap } from './caps/ui/style.ts';
import { uiThemeCap } from './caps/ui/theme.ts';
import { uiLayoutCap } from './caps/ui/layout.ts';
import { uiComponentCap } from './caps/ui/component.ts';
import { uiSnapshotCap } from './caps/ui/snapshot.ts';
import { uiChatCap } from './caps/ui/chat.ts';
import { createUiObserveCap } from './caps/ui/observe.ts';
import { createUiWindowCap } from './caps/ui/window.ts';
import { shellRegistry } from './caps/ui/shell-registry.ts';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('[sky] booting...');
  console.log(`[sky] dataRoot: ${dataRoot}`);

  // 1. EventBus + Router (链调度版)
  const bus = new EventBus();
  const router = new Router(bus);

  // 注入 audit 事件推送
  setAuditEmitter((e) => bus.emit({ ...e, type: e.type }));

  // 2. 注册拦截器 (permission + audit)
  router.registerInterceptor(permissionInterceptor);
  router.registerInterceptor(auditInterceptor);

  // 3. 注册业务 cap
  router.register(echoCap);
  router.register(kvCap);
  router.register(bashCap);
  router.register(configCap);
  router.register(historyCap);
  router.register(auditCap);
  router.register(fsCap);
  router.register(httpCap);
  router.register(taskCap);
  router.register(timeCap);
  router.register(createEditCap());
  router.register(createAiChatCap(router));

  // 4. 注册元 cap (AI 可管理架构)
  router.register(createInterceptorCap(router));
  const pluginsDir = join(__dirname, '..', 'plugins');
  // scaffold 需要写 pluginsDir, 故与 plugin cap 共用同一路径
  router.register(createCapabilityCap(router, { pluginsRoot: pluginsDir }));
  router.register(createPluginCap(router, pluginsDir));
  router.register(createTransportCap());
  router.register(createShellCap());
  router.register(createEngineCap());
  router.register(createStorageCap());
  router.register(createBusCap(bus));
  router.register(createAuthCap({ devMode: () => {
    // 与传输层同一判定: 未配 master token 且未开启强制认证 = 本地开发宽松
    const cfg = readConfigRaw() as { server?: { token?: string; authRequired?: boolean } };
    return !cfg.server?.token && !cfg.server?.authRequired;
  } }));

  // 4.5 UI cap (前端样式自动演进, AI 可操作前端)
  initUiState();
  router.register(uiStyleCap);
  router.register(uiThemeCap);
  router.register(uiLayoutCap);
  router.register(uiComponentCap);
  router.register(uiSnapshotCap);
  router.register(uiChatCap);
  router.register(createUiObserveCap(shellRegistry));
  router.register(createUiWindowCap(bus));

  // 5. 加载外部插件 (启动时静态加载)
  const n = await loadPlugins(router, pluginsDir);
  console.log(`[sky] loaded ${n} external plugin(s) at startup`);

  // 6. 读 config 决定 port/token + 同步权限白名单
  const cfgReply = await router.dispatch('cap.config', { action: 'get' }, { kind: 'bootstrap' });
  if (!cfgReply.result.ok) throw new Error(cfgReply.result.error);
  const cfg = cfgReply.result.data as {
    server?: { port?: number; token?: string; authRequired?: boolean };
    permissions?: { remoteAllow?: string[] };
  };
  const port = cfg.server?.port ?? 9825;
  const token = cfg.server?.token || undefined;
  const authRequired = cfg.server?.authRequired === true;

  // 认证状态: master token + 强制认证开关 (传输层 401 与权限拦截器共用)
  setAuthState(token, authRequired);

  // 同步权限白名单 (默认全放行已注册 cap, 本地开发宽松)
  const configuredAllow = cfg.permissions?.remoteAllow;
  setPermissionConfig({
    remoteAllow: configuredAllow ?? null, // null = 放行全部
    remoteDeny: [],
  });

  // 7. 启动 server
  startServer(router, bus, { port, token, authRequired });

  // 8. 优雅退出
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
