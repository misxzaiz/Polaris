/**
 * workspace-plugin.ts
 *
 * 一个 `cap.workspace` 插件，包装 `cap.kv`(元数据持久化) 和文件树递归
 * 提供统一的多工作区管理面。
 *
 * 动作 (经 dispatch 调用):
 *   - set     -> 创建/更新工作区 + 设为当前 (root 必填)
 *   - get     -> 返回当前工作区 + 文件树 (深度<=2, 排除 node_modules/.git)
 *   - list    -> 列出所有工作区 + 当前 id
 *   - switch  -> 切换当前工作区 (id 必填)
 *   - delete  -> 删除工作区 (当前需 force=true)
 *
 * 存储布局 (全部在 cap.kv domain="workspace"):
 *   - key: "__workspaces__" -> Record<id, WorkspaceRecord>
 *   - key: "__current__"    -> workspace id (string)
 *
 * 路径约定 (两种):
 *   1. 绝对路径 (D:\proj\foo / /home/user/proj) — 用 node:fs 直读, 不经 cap.fs.
 *      工作区的本质是"指向任意一个真实项目目录", 不应被 dataRoot 沙箱限死.
 *      只读 + 深度限制 + 排除项, 不写入, 无越权风险.
 *   2. dataRoot 相对路径 (如 "." / "projects/my-project") — 仍走 cap.fs,
 *      保持向后兼容. "." 表示 dataRoot 根目录.
 *
 * 文件树: 深度<=2, 排除 node_modules/.git. 绝对路径走 node:fs, 相对走 cap.fs.
 */

import { existsSync, statSync, readdirSync } from 'node:fs';
import { resolve as pathResolve, isAbsolute, sep } from 'node:path';
import type { Capability, CallContext, CapabilityId, Value } from '../../src/contracts.ts';
import type { Router } from '../../src/server/router.ts';

const KV_DOMAIN = 'workspace';
const CURRENT_KEY = '__current__';
const WORKSPACES_KEY = '__workspaces__';

const MAX_DEPTH = 2;
const EXCLUDED_DIRS = new Set(['node_modules', '.git']);

type WorkspaceRecord = {
  id: string;
  name: string;
  root: string;
  createdAt: number;
  lastUsed: number;
};

type TreeNode = {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: TreeNode[];
};

type WorkspaceCapParams = {
  action: 'set' | 'get' | 'list' | 'switch' | 'delete';
  root?: string;
  name?: string;
  id?: string;
  setActive?: boolean;
  includeTree?: boolean;
  force?: boolean;
};

// -------- tiny helpers --------------------------------------------------------

function nowMs(): number {
  return Date.now();
}

function newId(): string {
  const t = nowMs().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `ws_${t}${r}`;
}

function basename(root: string): string {
  const parts = root.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : root;
}

function unwrapReply(reply: unknown): Value | null {
  if (!reply || typeof reply !== 'object') return null;
  const r = reply as { result?: { ok?: boolean; data?: Value } };
  if (!r.result || r.result.ok !== true) return null;
  return r.result.data ?? null;
}

// -------- main capability -----------------------------------------------------

const workspaceCap: Capability = {
  id: 'cap.workspace',
  description:
    'Multi-workspace management: set/get/list/switch/delete. root 支持任意绝对路径 (node:fs 直读, 不限 dataRoot) 或 dataRoot 相对路径 (走 cap.fs). 文件树深度<=2, 排除 node_modules/.git.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['set', 'get', 'list', 'switch', 'delete'],
      },
      root: {
        type: 'string',
        description: 'Workspace root path. 绝对路径 (如 D:\\proj\\foo / /home/u/proj) 直读 node:fs; 相对路径 (如 "." / "projects/foo") 走 cap.fs 沙箱.',
      },
      name: {
        type: 'string',
        description: 'Human-readable name (for set; defaults to basename of root)',
      },
      id: {
        type: 'string',
        description: 'Workspace id (for set/switch/delete; auto-generated if omitted on set)',
      },
      setActive: {
        type: 'boolean',
        description: 'Mark as current (for set; default true)',
      },
      includeTree: {
        type: 'boolean',
        description: 'Include file tree (for get; default true)',
      },
      force: {
        type: 'boolean',
        description: 'Allow deleting current workspace (for delete; default false)',
      },
    },
    required: ['action'],
  },
  async invoke(params: Value, ctx: CallContext) {
    const p = (params ?? {}) as WorkspaceCapParams;

    const call = async (capId: CapabilityId, payload: Value): Promise<Value | null> => {
      const reply = await ctx.dispatch(capId, payload);
      return unwrapReply(reply);
    };

    try {
      switch (p.action) {
        case 'set':
          return await setWorkspace(p, call);
        case 'get':
          return await getWorkspace(p, call);
        case 'list':
          return await listWorkspaces(call);
        case 'switch':
          return await switchWorkspace(p, call);
        case 'delete':
          return await deleteWorkspace(p, call);
        default:
          return { error: `unsupported action: ${p.action}` };
      }
    } catch (err) {
      return { error: `internal error: ${(err as Error)?.message ?? String(err)}` };
    }
  },
};

// -------- internal implementations -------------------------------------------

type Caller = (capId: CapabilityId, payload: Value) => Promise<Value | null>;

async function readWorkspaces(call: Caller): Promise<Record<string, WorkspaceRecord>> {
  const r = await call('cap.kv', {
    action: 'get',
    domain: KV_DOMAIN,
    key: WORKSPACES_KEY,
  });
  if (!r) return {};
  const v = (r as { value?: unknown }).value;
  if (!v || typeof v !== 'object') return {};
  return v as Record<string, WorkspaceRecord>;
}

async function writeWorkspaces(
  map: Record<string, WorkspaceRecord>,
  call: Caller,
): Promise<void> {
  await call('cap.kv', {
    action: 'set',
    domain: KV_DOMAIN,
    key: WORKSPACES_KEY,
    value: map,
  });
}

async function currentId(call: Caller): Promise<string | null> {
  const r = await call('cap.kv', {
    action: 'get',
    domain: KV_DOMAIN,
    key: CURRENT_KEY,
  });
  if (!r) return null;
  const v = (r as { value?: unknown }).value;
  return typeof v === 'string' ? v : null;
}

async function setCurrent(id: string, call: Caller): Promise<void> {
  await call('cap.kv', {
    action: 'set',
    domain: KV_DOMAIN,
    key: CURRENT_KEY,
    value: id,
  });
}

async function buildTree(
  root: string,
  depth: number,
  call: Caller,
): Promise<TreeNode[]> {
  // 深度语义: depth 从 0 起, MAX_DEPTH=2 表示根(0)+一层(1)+二层(2)可见,
  // 第三层(3)不再递归 children. 用 >= 在递归前判断, 避免进入 depth=2 的子目录.
  if (depth >= MAX_DEPTH) return [];

  // 绝对路径: 直接 node:fs 读, 绕开 cap.fs 沙箱 (workspace 本就该指向任意真实项目)
  if (isAbsolute(root)) {
    return readTreeNative(root, depth);
  }

  // 相对路径: 仍走 cap.fs (dataRoot 内, 向后兼容)
  const r = await call('cap.fs', { action: 'list', path: root });
  if (!r) return [];
  const data = r as { entries?: unknown[]; items?: unknown[]; files?: unknown[] };
  const entries: unknown[] =
    data.entries ?? data.items ?? data.files ?? (Array.isArray(r) ? r : []);

  const result: TreeNode[] = [];
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const it = item as { name?: string; path?: string; type?: string; isDir?: boolean; size?: number };
    const name = it.name;
    if (!name) continue;
    const isDir = it.type === 'directory' || it.type === 'dir' || it.isDir === true;
    if (isDir && EXCLUDED_DIRS.has(name)) continue;
    const path = it.path ?? `${root.replace(/[/\\]$/, '')}/${name}`;
    const node: TreeNode = { name, path, type: isDir ? 'dir' : 'file' };
    if (typeof it.size === 'number') node.size = it.size;
    if (isDir) node.children = await buildTree(path, depth + 1, call);
    result.push(node);
  }
  result.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1),
  );
  return result;
}

// 绝对路径直读 (node:fs). 只读 + 深度限制 + 排除项, 无写入, 无越权风险.
// 路径不再做沙箱校验: 工作区 root 由用户/AI 显式指定, 任意目录都可读.
function readTreeNative(root: string, depth: number): TreeNode[] {
  if (depth >= MAX_DEPTH) return [];
  if (!existsSync(root)) return [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // 权限不足/不是目录等
  }
  const result: TreeNode[] = [];
  for (const e of entries) {
    const name = e.name;
    if (!name) continue;
    const isDir = e.isDirectory();
    if (isDir && EXCLUDED_DIRS.has(name)) continue;
    // 子路径用 OS 分隔符拼接, 保持与 cap.fs 形状一致 (path 字段)
    const childPath = root.endsWith(sep) ? root + name : root + sep + name;
    const node: TreeNode = { name, path: childPath, type: isDir ? 'dir' : 'file' };
    if (isDir) node.children = readTreeNative(childPath, depth + 1);
    result.push(node);
  }
  result.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1),
  );
  return result;
}

// root 校验: 返回归一化后的 root, 或拒绝原因. 绝对路径归一化但不做沙箱限制.
function resolveRoot(root: string): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = String(root || '').trim();
  if (!trimmed) return { ok: false, error: 'root required' };
  if (!existsSync(trimmed)) return { ok: false, error: `root not found: ${trimmed}` };
  const resolved = pathResolve(trimmed);
  const st = statSync(resolved);
  if (!st.isDirectory()) return { ok: false, error: `root is not a directory: ${resolved}` };
  return { ok: true, path: resolved };
}

async function setWorkspace(p: WorkspaceCapParams, call: Caller) {
  if (!p.root) return { error: 'root required for set' };

  // 统一校验: 绝对路径归一化, 相对路径透传给 cap.fs stat
  const isAbs = isAbsolute(p.root);
  const resolved = isAbs ? resolveRoot(p.root) : null;
  if (isAbs) {
    if (!resolved!.ok) return { error: resolved!.error };
  } else {
    // 相对路径: 走 cap.fs stat 验证可访问 (沙箱内)
    const stat = await call('cap.fs', { action: 'stat', path: p.root });
    if (!stat) return { error: `workspace root not accessible: ${p.root}` };
    const st = stat as { isDir?: boolean; isDirectory?: boolean; type?: string };
    if (st.isDir === false && st.isDirectory === false && st.type && st.type !== 'directory') {
      return { error: `workspace root is not a directory: ${p.root}` };
    }
  }

  const id = p.id ?? newId();
  const name = p.name ?? basename(p.root) ?? id;
  const now = nowMs();
  const map = await readWorkspaces(call);
  const existing = map[id];
  const rootToStore = isAbs && resolved!.ok ? resolved!.path : p.root;
  map[id] = {
    id,
    name,
    root: rootToStore,
    createdAt: existing?.createdAt ?? now,
    lastUsed: now,
  };
  await writeWorkspaces(map, call);

  if (p.setActive !== false) {
    await setCurrent(id, call);
  }
  return { ok: true, id, name, root: rootToStore, absolute: isAbs, active: p.setActive !== false };
}

async function getWorkspace(p: WorkspaceCapParams, call: Caller) {
  const id = await currentId(call);
  if (!id) return { error: 'no workspace is currently selected' };
  const map = await readWorkspaces(call);
  const record = map[id];
  if (!record) return { error: `current workspace "${id}" not found` };

  record.lastUsed = nowMs();
  map[id] = record;
  await writeWorkspaces(map, call);

  const includeTree = p.includeTree !== false;
  return {
    ok: true,
    id,
    name: record.name,
    root: record.root,
    absolute: isAbsolute(record.root),
    createdAt: record.createdAt,
    lastUsed: record.lastUsed,
    tree: includeTree ? await buildTree(record.root, 0, call) : null,
  };
}

async function listWorkspaces(call: Caller) {
  const cid = await currentId(call);
  const map = await readWorkspaces(call);
  const workspaces = Object.values(map).sort((a, b) => b.lastUsed - a.lastUsed);
  return {
    ok: true,
    currentId: cid,
    count: workspaces.length,
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      root: w.root,
      createdAt: w.createdAt,
      lastUsed: w.lastUsed,
      active: w.id === cid,
    })),
  };
}

async function switchWorkspace(p: WorkspaceCapParams, call: Caller) {
  if (!p.id) return { error: 'id required for switch' };
  const map = await readWorkspaces(call);
  const record = map[p.id];
  if (!record) return { error: `workspace not found: ${p.id}` };

  // 绝对路径用 node:fs 校验, 相对路径走 cap.fs (与 setWorkspace 对齐)
  const isAbs = isAbsolute(record.root);
  let accessible = true;
  if (isAbs) {
    accessible = existsSync(record.root) && statSync(record.root).isDirectory();
  } else {
    const stat = await call('cap.fs', { action: 'stat', path: record.root });
    accessible = !!stat;
  }
  if (!accessible) {
    return { error: `workspace root no longer accessible: ${record.root}` };
  }

  const prev = await currentId(call);
  record.lastUsed = nowMs();
  map[p.id] = record;
  await writeWorkspaces(map, call);
  await setCurrent(p.id, call);

  return {
    ok: true,
    previous: prev,
    current: p.id,
    name: record.name,
    root: record.root,
    absolute: isAbs,
  };
}

async function deleteWorkspace(p: WorkspaceCapParams, call: Caller) {
  if (!p.id) return { error: 'id required for delete' };
  const cid = await currentId(call);
  if (cid === p.id && !p.force) {
    return { error: 'cannot delete current workspace; pass force=true to override' };
  }

  const map = await readWorkspaces(call);
  if (!map[p.id]) return { error: `workspace not found: ${p.id}` };
  delete map[p.id];
  await writeWorkspaces(map, call);

  let switchedTo: string | null = null;
  if (cid === p.id) {
    const next = Object.keys(map)[0] ?? null;
    if (next) {
      await setCurrent(next, call);
      switchedTo = next;
    } else {
      await call('cap.kv', { action: 'delete', domain: KV_DOMAIN, key: CURRENT_KEY });
    }
  }
  return { ok: true, deleted: p.id, previousCurrent: cid, switchedTo };
}

// -------- plugin lifecycle ----------------------------------------------------

export default function setup(router: Router) {
  router.register(workspaceCap);
}

export async function teardown(router: Router) {
  router.unregister('cap.workspace');
}
