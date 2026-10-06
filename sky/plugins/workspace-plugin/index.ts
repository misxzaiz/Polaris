/**
 * workspace-plugin.ts
 *
 * 一个 `cap.workspace` 插件，包装 `cap.kv`(元数据持久化) 和
 * `cap.fs`(文件树递归) 提供统一的多工作区管理面。
 *
 * 动作 (经 dispatch 调用):
 *   - set     -> 创建/更新工作区 + 设为当前 (root 必填, dataRoot 相对路径)
 *   - get     -> 返回当前工作区 + 文件树 (深度<=2, 排除 node_modules/.git)
 *   - list    -> 列出所有工作区 + 当前 id
 *   - switch  -> 切换当前工作区 (id 必填)
 *   - delete  -> 删除工作区 (当前需 force=true)
 *
 * 存储布局 (全部在 cap.kv domain="workspace"):
 *   - key: "__workspaces__" -> Record<id, WorkspaceRecord>
 *   - key: "__current__"    -> workspace id (string)
 *
 * 路径约定: root 是 dataRoot 相对路径 (如 "." / "projects/my-project"),
 *   因为 cap.fs 仅允许 dataRoot 内访问。"." 表示 dataRoot 根目录.
 *
 * 文件树: 委派 cap.fs.list 递归获取 (深度<=2, 排除 node_modules/.git)
 */

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
    'Multi-workspace management: set/get/list/switch/delete. Persists in cap.kv domain=workspace; file trees via cap.fs.list (depth<=2, excludes node_modules/.git).',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['set', 'get', 'list', 'switch', 'delete'],
      },
      root: { type: 'string', description: 'Workspace root path (for set)' },
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
  if (depth > MAX_DEPTH) return [];
  const r = await call('cap.fs', { action: 'list', path: root });
  if (!r) return [];

  // cap.fs.list 返回 data 形态: { entries: [...] } | { items: [...] } | 数组
  const data = r as {
    entries?: unknown[];
    items?: unknown[];
    files?: unknown[];
  };
  const entries: unknown[] =
    data.entries ?? data.items ?? data.files ?? (Array.isArray(r) ? r : []);

  const result: TreeNode[] = [];
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const it = item as {
      name?: string;
      path?: string;
      type?: string;
      isDir?: boolean;
      size?: number;
    };
    const name = it.name;
    if (!name) continue;
    const isDir = it.type === 'directory' || it.isDir === true;
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

async function setWorkspace(p: WorkspaceCapParams, call: Caller) {
  if (!p.root) return { error: 'root required for set' };

  // 验证 root 可访问且是目录
  const stat = await call('cap.fs', { action: 'stat', path: p.root });
  if (!stat) return { error: `workspace root not accessible: ${p.root}` };
  const st = stat as { isDirectory?: boolean; type?: string };
  if (st.isDirectory === false || (st.type && st.type !== 'directory')) {
    return { error: `workspace root is not a directory: ${p.root}` };
  }

  const id = p.id ?? newId();
  const name = p.name ?? basename(p.root) ?? id;
  const now = nowMs();
  const map = await readWorkspaces(call);
  const existing = map[id];
  map[id] = {
    id,
    name,
    root: p.root,
    createdAt: existing?.createdAt ?? now,
    lastUsed: now,
  };
  await writeWorkspaces(map, call);

  if (p.setActive !== false) {
    await setCurrent(id, call);
  }
  return { ok: true, id, name, root: p.root, active: p.setActive !== false };
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

  const stat = await call('cap.fs', { action: 'stat', path: record.root });
  if (!stat) {
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
