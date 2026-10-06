/**
 * cap.plugin — 插件管理(元 cap, AI 可安装/卸载插件, 热生效)
 *
 * 动作: list/install/uninstall/info/reload
 *
 * install: 从本地目录或 npm-style 路径动态 import 插件, 调 setup(router) 注册 cap
 *          注册完立即生效, 不重启 Core
 * uninstall: 调插件 teardown(若提供) + router.unregister 其 cap
 *
 * 插件约定:
 * - 目录含 manifest.json {id,name,version,caps:[]}
 * - index.ts default export: (router) => void | Promise<void>
 * - 可选 export teardown: (router) => void | Promise<void>
 */

import { existsSync, statSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pathToFileURL as pathToFileUrl } from 'node:url';
import * as dynamicImport from 'node:module';
import type { Capability, CallContext, Value } from '../contracts.ts';
import type { Router } from '../server/router.ts';

interface PluginRecord {
  id: string;
  name: string;
  version: string;
  path: string;
  caps: string[];
  loadedAt: number;
  teardown?: (router: Router) => void | Promise<void>;
}

// 已加载插件注册表 (内存)
const loaded = new Map<string, PluginRecord>();

export function createPluginCap(router: Router, pluginsRoot: string): Capability {
  return {
    id: 'cap.plugin',
    description: 'Plugin manager. Actions: list/install/uninstall/info/reload. AI can install plugins with hot effect.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'install', 'uninstall', 'info', 'reload', 'available'] },
        path: { type: 'string', description: 'Plugin directory path (install/reload)' },
        id: { type: 'string', description: 'Plugin id (uninstall/info)' },
      },
      required: ['action'],
    },
    async invoke(params: Value, _ctx: CallContext) {
      const p = params as {
        action: 'list' | 'install' | 'uninstall' | 'info' | 'reload' | 'available';
        path?: string;
        id?: string;
      };

      switch (p.action) {
        case 'list':
          return {
            ok: true,
            plugins: [...loaded.values()].map(r => ({
              id: r.id, name: r.name, version: r.version,
              caps: r.caps, path: r.path, loadedAt: r.loadedAt,
            })),
          };

        case 'available': {
          // 扫描 pluginsRoot 下所有子目录, 列出未加载的
          if (!existsSync(pluginsRoot)) return { ok: true, available: [] };
          const entries = readdirSync(pluginsRoot).filter(f => {
            const full = join(pluginsRoot, f);
            return statSync(full).isDirectory();
          });
          const available = entries.map(id => {
            const manifestPath = join(pluginsRoot, id, 'manifest.json');
            if (!existsSync(manifestPath)) return null;
            try {
              const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
              return { id: m.id, name: m.name, version: m.version, loaded: loaded.has(m.id) };
            } catch {
              return null;
            }
          }).filter(Boolean);
          return { ok: true, available };
        }

        case 'install': {
          if (!p.path) throw new Error('path required for install');
          const result = await installPlugin(router, p.path, pluginsRoot);
          return result;
        }

        case 'uninstall': {
          if (!p.id) throw new Error('id required for uninstall');
          return await uninstallPlugin(router, p.id);
        }

        case 'info': {
          if (!p.id) throw new Error('id required for info');
          const r = loaded.get(p.id);
          if (!r) return { ok: false, notFound: true };
          return {
            ok: true,
            plugin: {
              id: r.id, name: r.name, version: r.version,
              caps: r.caps, path: r.path, loadedAt: r.loadedAt,
            },
          };
        }

        case 'reload': {
          if (!p.id && !p.path) throw new Error('id or path required for reload');
          const target = p.id ? loaded.get(p.id)?.path : p.path;
          if (!target) return { ok: false, error: 'plugin not found' };
          // 先卸载
          if (p.id) await uninstallPlugin(router, p.id);
          // 再装
          return await installPlugin(router, target, pluginsRoot);
        }

        default:
          throw new Error(`unknown action: ${(p as { action: string }).action}`);
      }
    },
  };
}

// ============================================================================
// 安装/卸载实现
// ============================================================================

async function installPlugin(
  router: Router, pluginPath: string, pluginsRoot: string,
): Promise<{ ok: true; plugin: { id: string; name: string; version: string; caps: string[] } } | { ok: false; error: string }> {
  try {
    // 解析路径 (相对 pluginsRoot 或绝对)
    const full = isAbsolute(pluginPath)
      ? pluginPath
      : resolve(pluginsRoot, pluginPath);
    if (!existsSync(full)) return { ok: false, error: `path not found: ${full}` };
    if (!statSync(full).isDirectory()) return { ok: false, error: 'path must be a directory' };

    const manifestPath = join(full, 'manifest.json');
    if (!existsSync(manifestPath)) return { ok: false, error: 'manifest.json not found' };
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      id: string; name: string; version: string; caps?: string[];
    };

    if (loaded.has(manifest.id)) {
      return { ok: false, error: `plugin already loaded: ${manifest.id}` };
    }

    // 找 index 文件
    const indexCandidates = ['index.ts', 'index.js', 'index.mjs'];
    let indexPath: string | null = null;
    for (const f of indexCandidates) {
      const p = join(full, f);
      if (existsSync(p)) { indexPath = p; break; }
    }
    if (!indexPath) return { ok: false, error: 'index.ts/js/mjs not found' };

    // 动态 import (tsx 支持运行时 import .ts)
    const url = pathToFileUrl(indexPath).href;
    const mod = await import(url);
    const setup = mod.default as ((r: Router) => void | Promise<void>) | undefined;
    const teardown = mod.teardown as ((r: Router) => void | Promise<void>) | undefined;

    if (typeof setup !== 'function') {
      return { ok: false, error: 'plugin default export must be a setup function' };
    }

    // 记录已注册的 cap (对比注册前后)
    const beforeCaps = new Set(router.list().map(c => c.id));
    await setup(router);
    const afterCaps = router.list().map(c => c.id);
    const newCaps = afterCaps.filter(id => !beforeCaps.has(id));

    loaded.set(manifest.id, {
      ...manifest,
      caps: manifest.caps ?? newCaps,
      path: full,
      loadedAt: Date.now(),
      teardown,
    });

    console.log(`[plugin] installed ${manifest.id} (${manifest.name} v${manifest.version}) → caps: ${newCaps.join(', ') || '(none)'}`);
    return { ok: true, plugin: { id: manifest.id, name: manifest.name, version: manifest.version, caps: newCaps } };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error };
  }
}

async function uninstallPlugin(router: Router, id: string): Promise<{ ok: true; uninstalled: string } | { ok: false; error: string }> {
  const rec = loaded.get(id);
  if (!rec) return { ok: false, error: `plugin not loaded: ${id}` };
  try {
    if (rec.teardown) await rec.teardown(router);
    // 注销 cap (插件声明的)
    for (const capId of rec.caps) {
      router.unregister(capId);
    }
    loaded.delete(id);
    console.log(`[plugin] uninstalled ${id}`);
    return { ok: true, uninstalled: id };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error };
  }
}
