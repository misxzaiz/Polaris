/**
 * cap.edit 的工作区 root 解析 — 经 cap.workspace get 取当前 root
 *
 * 编辑操作以用户显式设置的工作区为信任边界; 无工作区时明确报错,
 * 避免静默落进 dataRoot (双根陷阱, 见 sky-plugin-tooling 记忆).
 */

import { isAbsolute } from 'node:path';
import type { CallContext } from '../contracts.ts';

export async function workspaceRootOf(ctx: CallContext): Promise<string> {
  const r = await ctx.dispatch('cap.workspace', { action: 'get', includeTree: false });
  if (!r.result.ok) throw new Error(`cannot resolve workspace: ${r.result.error}`);
  const data = r.result.data as { ok?: boolean; root?: string; absolute?: boolean } | null;
  if (!data || data.ok === false || !data.root) {
    throw new Error('no active workspace — set one first: cap.workspace { action: "set", root: "<dir>" }');
  }
  if (!isAbsolute(data.root)) {
    throw new Error(`workspace root is relative (${data.root}); cap.edit requires an absolute-path workspace`);
  }
  return data.root;
}
