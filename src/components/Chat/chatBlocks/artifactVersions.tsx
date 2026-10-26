/**
 * Artifact 版本分组（plans/prd-preview-card-ui-overhaul.md §版本 pills）
 *
 * 用户诉求：同一需求（requirementId）迭代出的多版原型不再"每版一张大卡"并排
 * 堆叠占满消息流，而是最新版渲染完整卡片 + header 版本 pills 切换历史版本，
 * 旧版折叠为一行摘要。
 *
 * 数据通路（只读，不改 store/JSONL 写路径）：
 * - SessionMessagesView 在渲染层用 useMemo 从 displayMessages 归集同会话的
 *   artifact 类块（artifact_preview 直出块 + prd-preview 形态的 plugin_card），
 *   经 Provider 下发 —— 会话级作用域天然隔离，多窗口各格互不可见。
 * - 两条渲染路径（直出块 / PluginCardHost→PrdPreviewCard）都汇入
 *   ArtifactPreviewRenderer；pills 由渲染器内本地 state 切换显示，不回写存储。
 * - Provider 缺席（搜索结果、预览弹窗等旁路渲染）时一切退化为原行为。
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { History } from 'lucide-react';
import type { ArtifactPreviewBlock, ChatMessage, ContentBlock, PluginCardBlock } from '@/types';

/** plugin_card 的 prd-preview 形态数据（与 PrdPreviewCard 的 PreviewArtifactData 对齐） */
interface PreviewArtifactData {
  artifactType?: string
  previewId?: string
  title?: string
  contentType?: string
  sourcePath?: string
  html?: string
  createdAt?: string
  version?: number
  versionLabel?: string
  requirementId?: string
  description?: string
}

function isPreviewArtifactData(data: unknown): data is PreviewArtifactData {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as PreviewArtifactData).html === 'string' &&
    typeof (data as PreviewArtifactData).previewId === 'string'
  )
}

/**
 * MCP prd-preview data（PreviewArtifact 对象）→ 渲染用 ArtifactPreviewBlock。
 * 单一实现：PrdPreviewCard 与本模块的 plugin_card 归一化共用，避免两处映射漂移。
 */
export function buildArtifactBlockFromData(data: unknown): ArtifactPreviewBlock | null {
  if (!isPreviewArtifactData(data)) return null;
  const previewId = data.previewId;
  const html = data.html;
  if (!previewId || !html) return null;
  return {
    type: 'artifact_preview',
    previewId,
    title: data.title?.trim() ? data.title : 'PRD Prototype',
    contentType: 'html',
    html,
    sourcePath: data.sourcePath,
    createdAt: data.createdAt,
    version: typeof data.version === 'number' ? data.version : undefined,
    versionLabel: data.versionLabel,
    requirementId: data.requirementId,
    description: data.description,
  };
}

/**
 * 归一化入口：任意 ContentBlock → 可分组渲染的 ArtifactPreviewBlock。
 * plugin_card 路径把 MCP data 映射为 artifact 形态（与 PrdPreviewCard 共用
 * buildArtifactBlockFromData）；其余块返回 null。
 */
export function normalizeArtifactLikeBlock(block: ContentBlock): ArtifactPreviewBlock | null {
  if (block.type === 'artifact_preview') return block;
  if (block.type === 'plugin_card') {
    return buildArtifactBlockFromData((block as PluginCardBlock).data);
  }
  return null;
}

/**
 * 从会话消息归集 artifact 版本组：requirementId → 按版本升序的块列表。
 * 缺 requirementId 的块（HTML 卡检测路径、AI 未传参）不参与分组，行为不变。
 */
export function buildArtifactVersionsMap(messages: ChatMessage[]): Map<string, ArtifactPreviewBlock[]> {
  const map = new Map<string, ArtifactPreviewBlock[]>();
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    for (const block of message.blocks) {
      const artifact = normalizeArtifactLikeBlock(block);
      if (!artifact?.requirementId) continue;
      const list = map.get(artifact.requirementId);
      if (list) list.push(artifact);
      else map.set(artifact.requirementId, [artifact]);
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.version ?? 0) - (b.version ?? 0) || a.previewId.localeCompare(b.previewId));
  }
  return map;
}

const ArtifactVersionsContext = createContext<Map<string, ArtifactPreviewBlock[]> | null>(null);

export function ArtifactVersionsProvider({ value, children }: { value: Map<string, ArtifactPreviewBlock[]>; children: ReactNode }) {
  return <ArtifactVersionsContext.Provider value={value}>{children}</ArtifactVersionsContext.Provider>;
}

/**
 * 取当前会话中同 requirementId 的全部版本（升序）。少于 2 版返回 null
 * （无 pills、无折叠）。Provider 缺席时返回 null —— 旁路渲染退化为原行为。
 */
export function useArtifactVersions(requirementId?: string): ArtifactPreviewBlock[] | null {
  const map = useContext(ArtifactVersionsContext);
  return useMemo(() => {
    if (!map || !requirementId) return null;
    const list = map.get(requirementId);
    return list && list.length > 1 ? list : null;
  }, [map, requirementId]);
}

/**
 * 折叠判定：本块是同需求的历史版本（存在严格更新的版本）→ 渲染折叠行。
 * 仅在双方都有显式 version 时比较（无版本的块无法定序，保守不折叠）。
 */
export function useIsSupersededArtifactVersion(block: ArtifactPreviewBlock | null): boolean {
  const versions = useArtifactVersions(block?.requirementId);
  return useMemo(() => {
    const version = block?.version;
    if (!versions || version == null) return false;
    return versions.some((v) => (v.version ?? 0) > version);
  }, [versions, block]);
}

/** 历史版本折叠行：一行摘要替代整张大卡，消除多版本并排堆叠的空间浪费 */
function SupersededArtifactRow({ block }: { block: ArtifactPreviewBlock }) {
  const versions = useArtifactVersions(block.requirementId);
  const latest = versions?.[versions.length - 1];
  const label = block.versionLabel || (block.version != null ? `v${block.version}` : '早期版本');
  const latestLabel = latest?.versionLabel || (latest?.version != null ? `v${latest.version}` : undefined);
  const created = block.createdAt
    ? new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(block.createdAt))
    : null;
  return (
    <div
      className="my-2 flex min-w-0 items-center gap-2 rounded-md border border-border-subtle bg-background-surface px-3 py-1.5 text-xs text-text-muted"
      title={block.description || block.title}
    >
      <History className="h-3.5 w-3.5 shrink-0" />
      <span className="shrink-0 font-medium text-text-secondary">{label}</span>
      <span className="h-1 w-1 shrink-0 rounded-full bg-text-muted" />
      <span className="truncate">{block.title}</span>
      {created && <span className="shrink-0">{created}</span>}
      {latestLabel && <span className="ml-auto shrink-0">已并入 {latestLabel}</span>}
    </div>
  );
}

/**
 * 版本折叠闸门：包住 artifact 类块的正常渲染分支。命中历史版本时以折叠行
 * 替代 children（整张卡/宿主不再挂载），否则原样透传。
 */
export function ArtifactVersionGate({ block, children }: { block: ContentBlock; children: ReactNode }) {
  const artifact = useMemo(() => normalizeArtifactLikeBlock(block), [block]);
  const superseded = useIsSupersededArtifactVersion(artifact);
  if (superseded && artifact) {
    return <SupersededArtifactRow block={artifact} />;
  }
  return <>{children}</>;
}
