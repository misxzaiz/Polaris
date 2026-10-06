/**
 * 插件加载器 — 自动扫描 plugins/ 目录
 *
 * 约定:
 * - 每个插件目录含 manifest.json + 可选 index.ts/js
 * - manifest: { id, name, version, caps: ["cap.xxx"] }
 * - index.ts 默认导出函数: (router) => void | Promise<void>
 *   插件在函数内 router.register(myCap) 注册自己的能力
 *
 * 内置 cap(echo/kv/bash/ai/config/history) 由 main.ts 显式注册,
 * 外部插件(进程隔离)走 cap.plugin 的协议——预览版先用同进程 tsx import.
 */

import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Router } from './router.ts';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  caps?: string[];
}

export async function loadPlugins(router: Router, dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  let count = 0;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    const manifestPath = join(full, 'manifest.json');
    const indexPath = resolveIndex(full);
    if (!existsSync(manifestPath) || !indexPath) continue;

    const manifest = JSON.parse(
      await import('node:fs').then(fs => fs.readFileSync(manifestPath, 'utf8')),
    ) as PluginManifest;

    try {
      const mod = await import(pathToFileURL(indexPath).href);
      const setup = mod.default as ((r: Router) => unknown) | undefined;
      if (typeof setup === 'function') {
        await setup(router);
        console.log(`[plugin] +${manifest.id} (${manifest.name} v${manifest.version})`);
        count++;
      } else {
        console.warn(`[plugin] ${manifest.id}: no default export function, skip`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[plugin] ${manifest.id} load failed: ${msg}`);
    }
  }
  return count;
}

function resolveIndex(dir: string): string | null {
  for (const f of ['index.ts', 'index.js', 'index.mjs']) {
    const p = join(dir, f);
    if (existsSync(p)) return p;
  }
  return null;
}
