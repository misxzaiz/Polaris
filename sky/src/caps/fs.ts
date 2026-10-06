/**
 * cap.fs — 文件系统能力(限 DataRoot 内, 防止越权访问)
 *
 * 动作: read/write/append/list/stat/mkdir/delete/rename
 * 路径: 相对 DataRoot, 拒绝 .. 越界
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, existsSync, unlinkSync, renameSync, rmSync } from 'node:fs';
import { join, normalize, isAbsolute, relative } from 'node:path';
import type { Capability, Value } from '../contracts.ts';
import { dataRoot } from '../storage.ts';

/**
 * 安全解析路径: 相对 DataRoot, 禁止越界.
 *
 * 额外拦截 plugins/ 前缀: 插件代码必须由 cap.capability scaffold/write 落到
 * pluginsRoot (加载器扫描的项目 plugins/), 这里若放行会把文件写进 dataRoot
 * 的沙箱同名目录 — 加载器看不到, AI 还会以为插件装失败了. 实测会让 AI 空转
 * 十几轮 (scaffold 生成到项目, cap.fs 又写到 dataRoot, manifest 对不上).
 */
const RESERVED_PREFIX = 'plugins';

function safePath(p: string): string {
  if (!p || isAbsolute(p)) throw new Error(`path must be relative to dataRoot: ${p}`);
  const first = String(p).replace(/\\/g, '/').split('/')[0];
  if (first === RESERVED_PREFIX) {
    throw new Error(
      `path "${p}" is reserved: plugin files must not be written via cap.fs. ` +
      `Use cap.capability { action: "scaffold" | "write", name: "<dir>", file: "index.ts", content: "..." } ` +
      `then cap.plugin { action: "install", path: "./<dir>" } — that routes to the loader's plugins root.`,
    );
  }
  const full = normalize(join(dataRoot, p));
  const rel = relative(dataRoot, full);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes dataRoot: ${p}`);
  }
  return full;
}

export const fsCap: Capability = {
  id: 'cap.fs',
  description: 'File system (sandboxed to data root). Actions: read/write/append/list/stat/mkdir/delete/rename.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'write', 'append', 'list', 'stat', 'mkdir', 'delete', 'rename'] },
      path: { type: 'string', description: 'Relative path within data root' },
      content: { type: 'string', description: 'Content for write/append' },
      newPath: { type: 'string', description: 'New path for rename' },
      encoding: { type: 'string', description: 'text(default)|base64, for write' },
    },
    required: ['action', 'path'],
  },
  async invoke(params: Value) {
    const p = params as {
      action: 'read' | 'write' | 'append' | 'list' | 'stat' | 'mkdir' | 'delete' | 'rename';
      path: string;
      content?: string;
      newPath?: string;
      encoding?: 'text' | 'base64';
    };
    const full = safePath(p.path);
    switch (p.action) {
      case 'read': {
        if (!existsSync(full)) return { ok: false, notFound: true };
        const buf = readFileSync(full);
        return { ok: true, content: buf.toString('utf8'), size: buf.length };
      }
      case 'write': {
        mkdirSync(join(full, '..'), { recursive: true });
        const data = p.encoding === 'base64' ? Buffer.from(p.content ?? '', 'base64') : p.content ?? '';
        writeFileSync(full, data);
        return { ok: true, path: p.path, size: typeof data === 'string' ? data.length : data.length };
      }
      case 'append': {
        const data = p.content ?? '';
        appendFileSync(full, data, 'utf8');
        return { ok: true, appended: data.length };
      }
      case 'list': {
        if (!existsSync(full)) return { ok: false, notFound: true };
        const entries = readdirSync(full, { withFileTypes: true });
        return {
          ok: true,
          entries: entries.map(e => ({
            name: e.name,
            type: e.isDirectory() ? 'dir' : 'file',
          })),
        };
      }
      case 'stat': {
        if (!existsSync(full)) return { ok: false, notFound: true };
        const s = statSync(full);
        return {
          ok: true,
          size: s.size,
          isDir: s.isDirectory(),
          isFile: s.isFile(),
          mtime: s.mtimeMs,
          ctime: s.ctimeMs,
        };
      }
      case 'mkdir': {
        mkdirSync(full, { recursive: true });
        return { ok: true, path: p.path };
      }
      case 'delete': {
        if (!existsSync(full)) return { ok: false, notFound: true };
        rmSync(full, { recursive: true, force: true });
        return { ok: true };
      }
      case 'rename': {
        if (!p.newPath) throw new Error('newPath required for rename');
        const newFull = safePath(p.newPath);
        if (!existsSync(full)) return { ok: false, notFound: true };
        renameSync(full, newFull);
        return { ok: true, from: p.path, to: p.newPath };
      }
      default:
        throw new Error(`unknown action: ${(p as { action: string }).action}`);
    }
  },
};
