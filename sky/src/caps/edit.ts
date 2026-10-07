/**
 * cap.edit — 工作区文件编辑能力 (AI 编辑代码的核心工具)
 *
 * 设计:
 * - 路径相对当前工作区 root (cap.workspace get 解析), 拒绝 .. 越界
 * - AI 友好原语: read 带行号 (可分段), replace 要求精确匹配且默认必须唯一,
 *   insert/deleteLines 行级操作, undo 撤销最近一次修改
 * - search: 工作区内容搜索 (纯 JS, 排除 node_modules/.git, 结果封顶)
 * - 每次修改前快照, undo 单文件 5 层
 * - 二进制/大文件保护: 含 \0 拒编辑, >2MB 拒读
 *
 * 工作流: search 找位置 → read 看上下文 → replace/insert 修改 → read 验证.
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, isAbsolute, relative, dirname, join, sep } from 'node:path';
import type { Capability, CallContext, Value } from '../contracts.ts';
import { workspaceRootOf } from './edit-root.ts';

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_FILES = 5000;
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'target', '.idea', '.vs']);
const UNDO_STACK_MAX = 5;

/** undo 快照: 绝对路径 → 内容栈 */
const undoStacks = new Map<string, string[]>();

function pushUndo(full: string, content: string): void {
  let stack = undoStacks.get(full);
  if (!stack) { stack = []; undoStacks.set(full, stack); }
  stack.push(content);
  if (stack.length > UNDO_STACK_MAX) stack.shift();
}

function resolveInWorkspace(root: string, p: string): string {
  if (!p) throw new Error('path required');
  const full = isAbsolute(p) ? p : resolve(root, p);
  const rel = relative(root, full);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes workspace root: ${p}`);
  }
  return full;
}

function readText(full: string): string {
  const size = statSync(full).size;
  if (size > MAX_READ_BYTES) throw new Error(`file too large to edit: ${size} bytes (max ${MAX_READ_BYTES})`);
  const buf = readFileSync(full);
  if (buf.includes(0)) throw new Error('refusing to edit binary file (contains NUL bytes)');
  return buf.toString('utf8');
}

function writeText(full: string, content: string): void {
  writeFileSync(full, content, 'utf8');
}

function lineWindow(text: string, centerStart: number, centerEnd: number, ctx = 2): string {
  const lines = text.split('\n');
  const from = Math.max(0, centerStart - ctx);
  const to = Math.min(lines.length, centerEnd + ctx);
  const out: string[] = [];
  for (let i = from; i < to; i++) out.push(`${i + 1}| ${lines[i]}`);
  return out.join('\n');
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = text.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

function walkFiles(dir: string, depth: number, out: string[]): void {
  if (depth > 8 || out.length >= MAX_SEARCH_FILES) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= MAX_SEARCH_FILES) return;
    if (e.isDirectory()) {
      if (EXCLUDED_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walkFiles(join(dir, e.name), depth + 1, out);
    } else if (e.isFile()) {
      out.push(join(dir, e.name));
    }
  }
}

export function createEditCap(): Capability {
  return {
    id: 'cap.edit',
    description: 'Workspace file editor for AI code editing. Actions: ' +
      'read (line-numbered, offset/limit), replace (exact-match, must be unique unless all=true), ' +
      'insert (after line N, 0=prepend), deleteLines (line+count), undo (revert last change), ' +
      'search (workspace content search, regex or plain). ' +
      'Paths are relative to the current workspace root (cap.workspace). ' +
      'Workflow: search → read → replace → read to verify. undo reverts the last mutation per file.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'replace', 'insert', 'deleteLines', 'undo', 'search'] },
        path: { type: 'string', description: 'Path relative to workspace root' },
        offsetLine: { type: 'number', description: 'read: 1-based start line, default 1' },
        limitLines: { type: 'number', description: 'read: max lines returned, default 2000' },
        old: { type: 'string', description: 'replace: exact text to find' },
        new: { type: 'string', description: 'replace: replacement text' },
        all: { type: 'boolean', description: 'replace: replace every occurrence' },
        line: { type: 'number', description: 'insert: insert after this 1-based line (0=prepend); deleteLines: 1-based start line' },
        count: { type: 'number', description: 'deleteLines: how many lines, default 1' },
        content: { type: 'string', description: 'insert: text to insert' },
        query: { type: 'string', description: 'search: text or regex' },
        regex: { type: 'boolean', description: 'search: treat query as regex' },
        glob: { type: 'string', description: 'search: filename suffix filter, e.g. ".ts"' },
      },
      required: ['action'],
    },
    async invoke(params: Value, ctx: CallContext) {
      const p = params as Record<string, string | number | boolean | undefined>;
      const action = p.action as string;
      const root = await workspaceRootOf(ctx);

      switch (action) {
        case 'read': {
          const full = resolveInWorkspace(root, String(p.path));
          if (!existsSync(full) || !statSync(full).isFile()) return { ok: false, notFound: true, path: p.path };
          const text = readText(full);
          const lines = text.split('\n');
          const offset = Math.max(1, Number(p.offsetLine) || 1);
          const limit = Math.min(2000, Math.max(1, Number(p.limitLines) || 2000));
          const slice = lines.slice(offset - 1, offset - 1 + limit);
          return {
            ok: true,
            path: p.path,
            total: lines.length,
            offset,
            returned: slice.length,
            lines: slice.map((t, i) => ({ n: offset + i, text: t })),
          };
        }

        case 'replace': {
          const oldText = p.old as string;
          const newText = String(p.new ?? '');
          if (typeof oldText !== 'string' || !oldText) throw new Error('old (exact text to replace) required');
          const full = resolveInWorkspace(root, String(p.path));
          if (!existsSync(full) || !statSync(full).isFile()) return { ok: false, notFound: true, path: p.path };
          const text = readText(full);
          const occurrences = countOccurrences(text, oldText);
          if (occurrences === 0) return { ok: false, error: 'old text not found in file', occurrences: 0 };
          const wantAll = p.all === true;
          if (!wantAll && occurrences > 1) {
            return { ok: false, error: `old text matches ${occurrences} locations; provide more surrounding context to make it unique, or pass all=true`, occurrences };
          }
          pushUndo(full, text);
          const next = wantAll ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
          writeText(full, next);
          // 定位修改点 (供 AI 免二次 read)
          const firstLine = next.split('\n');
          let anchor = -1;
          const probe = (newText.split('\n')[0] || '');
          for (let i = 0; i < firstLine.length; i++) {
            if (firstLine[i].includes(probe) && probe) { anchor = i; break; }
          }
          return {
            ok: true,
            path: p.path,
            replaced: wantAll ? occurrences : 1,
            totalLines: firstLine.length,
            snippet: anchor >= 0 ? lineWindow(next, anchor + 1, anchor + 1) : undefined,
          };
        }

        case 'insert': {
          const content = p.content as string;
          if (typeof content !== 'string') throw new Error('content required for insert');
          const full = resolveInWorkspace(root, String(p.path));
          if (!existsSync(full) || !statSync(full).isFile()) {
            return { ok: false, notFound: true, path: p.path, hint: 'create the file first via cap.fs write (dataRoot) or cap.edit insert is for existing workspace files' };
          }
          const text = readText(full);
          const lines = text.split('\n');
          const lineNo = Math.max(0, Number(p.line) || 0);
          // 先校验后快照: 失败的操作不得污染 undo 栈
          if (lineNo > lines.length) throw new Error(`line ${lineNo} beyond end of file (${lines.length} lines)`);
          pushUndo(full, text);
          const insertLines = content.split('\n');
          lines.splice(lineNo, 0, ...insertLines);
          const next = lines.join('\n');
          writeText(full, next);
          return {
            ok: true,
            path: p.path,
            insertedAt: lineNo + 1,
            insertedLines: insertLines.length,
            totalLines: lines.length,
            snippet: lineWindow(next, lineNo + 1, lineNo + insertLines.length),
          };
        }

        case 'deleteLines': {
          const full = resolveInWorkspace(root, String(p.path));
          if (!existsSync(full) || !statSync(full).isFile()) return { ok: false, notFound: true, path: p.path };
          const text = readText(full);
          const lines = text.split('\n');
          const lineNo = Math.max(1, Number(p.line) || 1);
          const count = Math.max(1, Number(p.count) || 1);
          // 先校验后快照: 失败的操作不得污染 undo 栈
          if (lineNo > lines.length) throw new Error(`line ${lineNo} beyond end of file (${lines.length} lines)`);
          pushUndo(full, text);
          const removed = lines.splice(lineNo - 1, count);
          const next = lines.join('\n');
          writeText(full, next);
          return {
            ok: true,
            path: p.path,
            removedLines: removed.length,
            totalLines: lines.length,
            snippet: lineWindow(next, lineNo, lineNo),
          };
        }

        case 'undo': {
          const full = resolveInWorkspace(root, String(p.path));
          const stack = undoStacks.get(full);
          if (!stack || !stack.length) return { ok: false, error: 'no undo snapshot for this file (in this process lifetime)' };
          const prev = stack.pop()!;
          writeText(full, prev);
          return { ok: true, path: p.path, restoredBytes: prev.length, remainingUndos: stack.length };
        }

        case 'search': {
          const query = String(p.query ?? '');
          if (!query) throw new Error('query required for search');
          const useRegex = p.regex === true;
          let re: RegExp;
          try {
            re = useRegex ? new RegExp(query, 'g') : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
          } catch (e) {
            throw new Error(`invalid regex: ${(e as Error).message}`);
          }
          const suffix = p.glob ? String(p.glob) : null;
          const files: string[] = [];
          walkFiles(root, 0, files);
          const results: Array<{ path: string; line: number; text: string }> = [];
          let truncated = false;
          for (const f of files) {
            if (suffix && !f.endsWith(suffix)) continue;
            let text: string;
            try {
              if (statSync(f).size > MAX_READ_BYTES) continue;
              const buf = readFileSync(f);
              if (buf.includes(0)) continue;
              text = buf.toString('utf8');
            } catch { continue; }
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
              re.lastIndex = 0;
              if (re.test(lines[i])) {
                if (results.length >= MAX_SEARCH_RESULTS) { truncated = true; break; }
                results.push({
                  path: relative(root, f).split(sep).join('/'),
                  line: i + 1,
                  text: lines[i].slice(0, 300),
                });
              }
            }
            if (truncated) break;
          }
          return {
            ok: true,
            searched: files.length,
            matches: results.length,
            truncated,
            results,
          };
        }

        default:
          throw new Error(`unknown action: ${action}`);
      }
    },
  };
}
